#!/usr/bin/env python3
"""Run the chat surface headless, against any OpenAI-compatible server.

The room is a conversation, a queue and a browser. Almost none of that is what
decides whether this works: what decides it is whether a 4B model, handed the
machine card, the ledger and four turns of history, picks the right action and
writes a prompt the compiler will take. This runs exactly that — `creator/chat.py`
and the real compiler, with no ComfyUI, no queue and no browser — over a
scripted conversation, and prints what the model said at every step.

    python3 tools/chat_bench.py --model qwen3-vl:4b
    python3 tools/chat_bench.py --url http://localhost:1234/v1 --dump

`SCRIPT` below is the conversation: a still, a clip made from that still, a
change to it, and a question that is only an answer. **Editing it is the point
of this file** — the system prompt at `creator/prompts/chat/system.txt` is tuned
per small model here rather than in the room, because BFCL's format sensitivity
is real and a wording change has to be judged over a whole conversation rather
than one lucky turn. `--dump` prints the system prompt and the user message
before each reply, which is what to read when a turn goes wrong.

Nothing is rendered and nothing is queued. A render action is taken at its word:
a ledger line is invented for it so the next turn has something to cite, and the
blob it patches is put through the real compile so the prompt printed is the
prompt the sampler would have read. What that will not catch is a missing weight
— this machine is told it is fully set up, since what is under test is the
prompting and not the readiness sentence.

Needs the ComfyUI venv for the compiler's own imports: no torch, no model on
this side of the wire, and nothing is read from the node's credential file.
"""

import argparse
import importlib.util
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))

import layout  # noqa: E402 — tests' loader, which knows where the family modules live


# The conversation, in order. Each line is one user turn; everything else —
# handles, history, the machine card — is built from what the model answered to
# the turn before it, which is the whole thing being measured.
SCRIPT = [
    "a fox in a snowy wood at dusk",
    "now a clip of it, she looks up",
    "bluer",
    "what does the seed actually change?",
]

# Every picture and clip this pretends to have made is this size. The canvas
# follows a keyframe's aspect, so the number has to be a real one; nothing here
# opens a file.
SIZE = (1024, 576)


def _load(url):
    """The pure half of the pack, plus the remote client, with no server."""
    pkg = layout.load("canvas", "contextir", "compile", "compile_image",
                      "prompting", "manifest", "registry", "chat", package="mmc")

    spec = importlib.util.spec_from_file_location(
        "mmc.refine_remote", os.path.join(ROOT, "creator", "refine_remote.py"))
    remote = importlib.util.module_from_spec(spec)
    sys.modules["mmc.refine_remote"] = remote
    spec.loader.exec_module(remote)
    # The URL given here and no key: the node's own credential file is not read,
    # so a bench run never picks up a hosted endpoint by accident.
    remote._read = lambda: {"url": url, "key": ""}
    return pkg, remote


def _machine(pkg, still_family, video_family):
    """The machine card, for a machine that has every file it needs.

    Built off the real manifests — the durations, the grid and the aspect table
    the model is told about are this install's — and off an invented weights
    block, because which files are on the disk of whoever runs this bench says
    nothing about whether the prompting works.
    """
    families = [pkg.manifest.describe(name)
                for name in dict.fromkeys([still_family, video_family])]
    picked, by_folder = {}, {}
    for family in families:
        block = {}
        for slot in family["weights"]:
            name = f"{slot['id']}.safetensors"
            block[slot["id"]] = name
            by_folder.setdefault(slot["folder"], []).append(name)
        picked[family["id"]] = block
    return pkg.chat.machine_card(still_family, video_family,
                                 {"families": families},
                                 {"by_folder": by_folder}, picked)


def _catalog(pkg):
    """Every still family's manifest, for the questions the rail has to answer.

    `manifest.catalog()` would do it and reaches for the neural backend and the
    upscalers on the way, neither of which this bench has anything to ask.
    """
    return {"families": [pkg.manifest.describe(name)
                         for name in pkg.registry.still_families()]}


def _dry_run(pkg, action, ledger, rail):
    """The blob this action patches, compiled. -> the prompt, or the refusal."""
    chat, compiler = pkg.chat, getattr(pkg, "compile")
    size = lambda filename: SIZE  # noqa: E731 — nothing here opens a file

    _node, _field, blob = chat.piece_of(action, ledger, rail)
    try:
        if action["kind"] == chat.KIND_STILL:
            family = pkg.registry.still(blob["arch"])
            payload = family.compile_still(blob, size)
            return f"{payload.width}x{payload.height}\n{payload.prompt}"
        payload = compiler.timeline_payloads(blob, size)[0]
        return compiler.compile_segment(payload, size).prompt
    except compiler.CompileError as refusal:
        return f"REFUSED: {refusal}"


def _remembered(action, ledger, turn):
    """The ledger line a finished render would have left behind."""
    kind = "still" if action["kind"] == "still" else "clip"
    prefix = "img" if kind == "still" else "vid"
    number = sum(1 for entry in ledger if entry["handle"].startswith(prefix)) + 1
    handle = f"{prefix}-{number}"
    return {"handle": handle, "kind": kind, "aspect": action["aspect"] or "16:9",
            "turn": turn, "filename": f"continuity/chat/{handle}.png",
            "text": action["prompt"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--model", default="qwen3-vl:4b")
    parser.add_argument("--url", default="http://localhost:11434/v1")
    parser.add_argument("--still", default="krea2", help="the rail's still family")
    parser.add_argument("--video", default="h3", help="the rail's video family")
    parser.add_argument("--temperature", type=float, default=0.3)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--max-tokens", type=int, default=None)
    parser.add_argument("--dump", action="store_true",
                        help="print the system prompt and the message before each reply")
    args = parser.parse_args()

    pkg, remote = _load(args.url)
    chat = pkg.chat
    # The room draws its pictures with the families that draw one outright; H3's
    # still branch is a video generation under a blob of its own. `routes/chat`
    # says the same thing, and a bench that could be pointed somewhere the room
    # cannot go would be tuning a prompt against a machine nobody has.
    if args.still not in pkg.registry.IMAGE_FAMILIES:
        print(f"--still must be one of: {', '.join(pkg.registry.IMAGE_FAMILIES)}")
        return 1
    system = chat.system_prompt()
    card = _machine(pkg, args.still, args.video)
    rail = {"still_family": args.still,
            "still_arch": next(arch for arch, owner in pkg.registry.STILL_ARCHES.items()
                               if owner == args.still),
            # What the room's own rail carries about this family's pictures, so
            # a citation the family cannot be given is refused here in the same
            # words the room would use — which on Krea 2, the default, is most
            # of what a conversation about changing a picture runs into.
            "still_pictures": chat.still_pictures(
                pkg.manifest.describe(args.still), _catalog(pkg)),
            "video_family": args.video, "aspect": "16:9", "short_edge": 768}

    def ask(message):
        return remote.chat(args.model, system, message, [],
                           temperature=args.temperature, seed=args.seed,
                           max_tokens=args.max_tokens, prefill="")

    if args.dump:
        print(f"===== SYSTEM =====\n{system}\n")

    messages, ledger = [], []
    for turn, said in enumerate(SCRIPT, start=1):
        messages.append({"role": "user", "text": said})
        message = chat.context(messages, ledger, card)
        if args.dump:
            print(f"===== MESSAGE {turn} =====\n{message}\n===== END =====")

        print(f"\n########## turn {turn}: {said}")
        started = time.time()
        try:
            reply = ask(message)
            verdict = chat.judge(reply, ledger, said)
            if verdict["act"] == "reask":
                print(f"PLAN:   {chat.plan_of(reply)}")
                print(f"REASK:  {verdict['sentence']}")
                reply = ask(chat.reask(message, reply, verdict["sentence"]))
                verdict = chat.judge(reply, ledger, said, second=True)
        except Exception as exc:  # noqa: BLE001 — the message is the result
            print(f"FAILED after {time.time() - started:.0f}s: "
                  f"{type(exc).__name__}: {exc}")
            return 1
        print(f"({time.time() - started:.0f}s)")
        print(f"PLAN:   {chat.plan_of(reply)}")

        if verdict["act"] != chat.ACT_RENDER:
            print(f"SAY:    {verdict['say']}")
            messages.append({"role": "assistant", "say": verdict["say"]})
            continue

        action = verdict["action"]
        print(f"ACTION: {json.dumps(action, ensure_ascii=False)}")
        print(f"SAY:    {verdict['say']}")
        try:
            print("COMPILED:\n" + _dry_run(pkg, action, ledger, rail))
        except chat.ActionError as problem:
            print(f"REFUSED: {problem}")
            continue
        messages.append({"role": "assistant", "action": action})
        ledger.append(_remembered(action, ledger, turn))

    print("\n########## the ledger this conversation left")
    for entry in ledger:
        print(" ", chat.ledger_line(entry))
    return 0


if __name__ == "__main__":
    sys.exit(main())
