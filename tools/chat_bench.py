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
    python3 tools/chat_bench.py --verbosity 1

`SCRIPT` below is the conversation: a still, a clip made from that still, a
change to it, a next shot on the strip with a cast member in it, and a
question that is only an answer. The member is `PIECE`'s — the room's cast is
the node's, brought in with its `@` menu, and the model only passes the name
through. **Editing it is the point
of this file** — the system prompt at `creator/prompts/chat/system.txt` is tuned
per small model here rather than in the room, because BFCL's format sensitivity
is real and a wording change has to be judged over a whole conversation rather
than one lucky turn. The verbosity dial's blocks (`detail-N.txt` beside it) are
tuned the same way: `--verbosity` is the rail's slider, and what to read is
whether the prompt grew without the intent moving. `--dump` prints the system prompt and the user message
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
    "next shot: @ferris trots off between the trees",
    "what does the seed actually change?",
]

# The chat's own piece, as far as the model is concerned: somebody cast on
# it, built from a picture on its pool. What `routes/chat._with_piece` reads
# off the piece the room sends, invented here.
PIECE = {"family": "h3",
         "subjects": [{"handle": "ferris", "takes": "object", "from": ["ref-1"],
                       "description": "a red fox with a white chest"}],
         "assets": [{"handle": "ref-1", "kind": "image", "role": "reference",
                     "filename": "fox.png"}],
         "segments": [{"prompt": ""}]}

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


def _machine(pkg, still_family, video_family, edit_family=None):
    """The machine card, for a machine that has every file it needs.

    Built off the real manifests — the durations, the grid and the aspect table
    the model is told about are this install's — and off an invented weights
    block, because which files are on the disk of whoever runs this bench says
    nothing about whether the prompting works. `edit_family` is the one a cited
    picture is changed on when the still family cannot read one, as the room's
    rail would carry it; complete here like the other two.
    """
    families = [pkg.manifest.describe(name)
                for name in dict.fromkeys([still_family, video_family, edit_family]) if name]
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
                                 {"by_folder": by_folder}, picked,
                                 edit_family=edit_family)


def _catalog(pkg):
    """Every still family's manifest, for the questions the rail has to answer.

    `manifest.catalog()` would do it and reaches for the neural backend and the
    upscalers on the way, neither of which this bench has anything to ask.
    """
    return {"families": [pkg.manifest.describe(name)
                         for name in pkg.registry.still_families()]}


def _dry_run(pkg, action, ledger, rail, strip, cast):
    """The blob this action patches, compiled. -> `(the prompt or the refusal,
    the blob)`. On a strip only the new card — the last — is compiled; the
    kept ones are footage."""
    chat, compiler = pkg.chat, getattr(pkg, "compile")
    size = lambda filename: SIZE  # noqa: E731 — nothing here opens a file

    _node, _field, blob = chat.piece_of(action, ledger, rail, PIECE, strip, cast)
    try:
        if action["kind"] == chat.KIND_STILL:
            family = pkg.registry.still(blob["arch"])
            payload = family.compile_still(blob, size)
            return f"{payload.width}x{payload.height}\n{payload.prompt}", blob
        payload = compiler.timeline_payloads(compiler.rendered_piece(blob), size)[-1]
        return compiler.compile_segment(payload, size).prompt, blob
    except compiler.CompileError as refusal:
        return f"REFUSED: {refusal}", blob


def _remembered(action, ledger, turn):
    """The ledger line a finished render would have left behind."""
    kind = "still" if action["kind"] == "still" else "clip"
    prefix = "pic" if kind == "still" else "clip"
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
    parser.add_argument("--edit", default="auto",
                        help="the family a cited picture is changed on when the still "
                             "family cannot read one — the rail's Edits pill; 'auto' "
                             "is the first that edits, 'none' is a rail without one")
    parser.add_argument("--video", default="h3", help="the rail's video family")
    parser.add_argument("--temperature", type=float, default=0.3)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--max-tokens", type=int, default=None)
    parser.add_argument("--verbosity", type=float, default=0,
                        help="the rail's dial, 0 to 1: how much the model may add "
                             "beyond what was said (0 is the prompt as tuned)")
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
    # The family a cited picture goes to when the still family cannot read one
    # — `routes/chat.machine` resolves it the same way, off the same function,
    # with this machine's disk standing in for the bench's invented one.
    edit = None
    if args.edit != "none":
        wanted = chat.pick_edit_family(_catalog(pkg), {"by_folder": {}}, {},
                                       None if args.edit == "auto" else args.edit)
        if wanted is None or (args.edit != "auto" and wanted["id"] != args.edit):
            print("--edit must be one of: " + ", ".join(
                f["id"] for f in chat.edit_families(_catalog(pkg))) + ", auto or none")
            return 1
        edit = wanted["id"]
    arch_of = lambda family: next(  # noqa: E731
        arch for arch, owner in pkg.registry.STILL_ARCHES.items() if owner == family)
    system = chat.system_prompt(verbosity=args.verbosity)
    card = _machine(pkg, args.still, args.video, edit)
    rail = {"still_family": args.still, "still_arch": arch_of(args.still),
            # What the room's own rail carries about this family's pictures, so
            # a citation the family cannot be given is refused here in the same
            # words the room would use — or, with an edit family on the rail,
            # goes where the room would send it (`still_arch_for`).
            "still_pictures": chat.still_pictures(
                pkg.manifest.describe(args.still), _catalog(pkg)),
            "edit_family": edit, "edit_arch": arch_of(edit) if edit else None,
            "video_family": args.video, "aspect": "16:9", "short_edge": 768}

    def ask(message):
        return remote.chat(args.model, system, message, [],
                           temperature=args.temperature, seed=args.seed,
                           max_tokens=args.max_tokens, prefill="")

    if args.dump:
        print(f"===== SYSTEM =====\n{system}\n")

    messages, ledger, strip = [], [], []
    cast = chat.cast_entries(PIECE)
    names = [m["name"] for m in cast]
    for turn, said in enumerate(SCRIPT, start=1):
        messages.append({"role": "user", "text": said})
        # The strip and the piece as the room sends them: the shots joined so
        # far by handle and length, and the cast. The ledger is the room's.
        shots = [{"handle": c[chat.STRIP_KEY], "seconds": c["duration_s"]} for c in strip]
        told = ledger
        message = chat.context(messages, told, card, strip=shots, cast=cast)
        if args.dump:
            print(f"===== MESSAGE {turn} =====\n{message}\n===== END =====")

        print(f"\n########## turn {turn}: {said}")
        started = time.time()
        try:
            reply = ask(message)
            on_strip = [c[chat.STRIP_KEY] for c in strip]
            verdict = chat.judge(reply, told, said, strip=on_strip, cast=names)
            if verdict["act"] == "reask":
                print(f"PLAN:   {chat.plan_of(reply)}")
                print(f"REASK:  {verdict['sentence']}")
                reply = ask(chat.reask(message, reply, verdict["sentence"]))
                verdict = chat.judge(reply, told, said, second=True,
                                     strip=on_strip, cast=names)
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
        # A still is drawn on the arch the route would stamp on the action —
        # the rail's, or its edit arch for a picture the rail's family cannot
        # read — and the blob is patched as that family's, the way the room
        # builds its base for it.
        drawn = rail
        if action["kind"] == chat.KIND_STILL:
            arch = chat.still_arch_for(action, told, rail, cast)
            if arch != rail["still_arch"]:
                family = pkg.registry.STILL_ARCHES[arch]
                drawn = {**rail, "still_family": family, "still_arch": arch,
                         "still_pictures": chat.still_pictures(
                             pkg.manifest.describe(family), _catalog(pkg))}
                print(f"DRAWN:  on {family}, since a picture is cited")
        try:
            compiled, blob = _dry_run(pkg, action, told, drawn, strip, cast)
            print("COMPILED:\n" + compiled)
        except chat.ActionError as problem:
            print(f"REFUSED: {problem}")
            continue
        messages.append({"role": "assistant", "action": action})
        entry = _remembered(action, ledger, turn)
        ledger.append(entry)
        if action["kind"] == chat.KIND_VIDEO and not compiled.startswith("REFUSED"):
            # What the room does when the shot lands: the piece's cards become
            # the strip, the new one held on an invented take.
            strip = blob["segments"]
            strip[-1].update({chat.STRIP_KEY: entry["handle"], "hold": True,
                              "take": {"filename": entry["filename"],
                                       "duration_s": strip[-1]["duration_s"],
                                       "width": SIZE[0], "height": SIZE[1]}})
            print("STRIP:  " + " → ".join(c[chat.STRIP_KEY] for c in strip))

    print("\n########## the ledger this conversation left")
    for entry in ledger:
        print(" ", chat.ledger_line(entry))
    return 0


if __name__ == "__main__":
    sys.exit(main())
