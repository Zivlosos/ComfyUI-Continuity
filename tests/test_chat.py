"""The chat surface's contract: what the model may answer, and what it becomes.

    python tests/test_chat.py

Runs standalone — no torch, no ComfyUI, no network, no model. Everything under
test is `creator/chat.py`, which is pure for exactly this reason: the whole
protocol between a small local model and this pack's compiler is ordinary data,
and the failures it has to survive are the ones nobody can reproduce on demand.

Four things are pinned here, and each of them is a decision the spec argues for
rather than an implementation detail.

**The parse forgives transport and the validation forgives nothing.** A 4B model
leaks a `<think>` block, fences its object, writes a sentence in front of it, or
drops the fence entirely — none of those is a disagreement about the contract,
so all four have to come back as the same action. What the object *holds* is the
opposite: every refusal is a sentence naming the field, because that sentence is
quoted straight back to the model on the one re-ask and shown to a person if the
second attempt fails too.

**The protocol is two calls, never three.** A reply that will not validate earns
one re-ask; a `say` in answer to "make me a picture" earns one re-ask; a second
failure is the model's own prose in a bubble. A third round trip would be a room
that hangs on a model having a bad day.

**The card is the join nothing else makes.** Manifests, the files on disk and
this machine's picks each answer a third of "can I render this now", and a
family with a required file missing has to say so in the card so the model can
say so instead of trying.

**The blob patch is the only resolution there is.** `from` becomes references in
the order cited, a still cited by a clip is that clip's first frame, and a
handle the ledger has never heard of is refused before anything reaches the
compiler.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import layout  # noqa: E402
from harness import FAILURES, check, passed  # noqa: E402

chat = layout.load("prompting", "chat").chat


def refuses(label, call, *fragments):
    """The call raises an `ActionError` whose sentence carries every fragment."""
    try:
        call()
    except chat.ActionError as problem:
        for fragment in fragments:
            if fragment not in str(problem):
                FAILURES.append(f"{label}: said {str(problem)!r}, want {fragment!r} in it")
    except Exception as other:  # noqa: BLE001
        FAILURES.append(f"{label}: raised {other!r}, want an ActionError")
    else:
        FAILURES.append(f"{label}: did not refuse")


LEDGER = [
    {"handle": "img-1", "kind": "still", "aspect": "16:9", "turn": 1,
     "filename": "continuity/chat/fox.png",
     "text": "a red fox on a snowy ridge at dusk, low sun behind"},
    {"handle": "vid-1", "kind": "clip", "aspect": "16:9", "turn": 2,
     "filename": "continuity/chat/fox.mp4", "text": "the fox looks up"},
]

RAIL = {"still_family": "krea2", "still_arch": "krea2", "video_family": "h3",
        "aspect": "16:9", "still_edge": 1024, "video_edge": 768, "turbo": False,
        "seed": 7, "seed_policy": "fixed"}


# ---- the parse forgives transport -------------------------------------------
#
# Four shapes of the same answer. Every one of these has been seen off a small
# model, and none of them is the model disagreeing about what to do.

ACTION = '{"act": "render", "kind": "still", "prompt": "a fox in the snow"}'
SHAPES = {
    "a plan line and a fence": f"A picture, nothing to reference.\n```json\n{ACTION}\n```",
    "a leaked think block": f"<think>\nthey want a picture\n</think>\nA picture.\n```\n{ACTION}\n```",
    "a bare object": ACTION,
    "a sentence in front of it": f"Sure, here is the action: {ACTION}",
}
for label, reply in SHAPES.items():
    _, action = chat.read(reply, LEDGER)
    check(f"{label} parses to the same action",
          (action["act"], action["kind"], action["prompt"]),
          ("render", "still", "a fox in the snow"))

check("the plan line is read back off the reply",
      chat.plan_of(SHAPES["a plan line and a fence"]),
      "A picture, nothing to reference.")
check("a reply that is all object has no plan line", chat.plan_of(ACTION), "")
check("the think block is not mistaken for one",
      chat.plan_of(SHAPES["a leaked think block"]), "A picture.")

refuses("prose with no object at all is a re-ask, not a crash",
        lambda: chat.read("I could make that for you if you like!", LEDGER),
        "no JSON object", "``` fence")


# ---- the validation forgives nothing ----------------------------------------
#
# One case per field, and each sentence has to name the field it is about: it is
# read by a model that cannot see this file and then by a person who cannot
# either.

refuses("an unknown act names the field",
        lambda: chat.validate({"act": "generate"}, LEDGER), '"act"', '"say" or "render"')
refuses("a missing act says what arrived",
        lambda: chat.validate({"kind": "still"}, LEDGER), '"act"', "nothing")
refuses("a render with no kind names the field",
        lambda: chat.validate({"act": "render", "prompt": "a fox"}, LEDGER),
        '"kind"', '"still" or "video"')
refuses("a render with no prompt says what a prompt is",
        lambda: chat.validate({"act": "render", "kind": "still"}, LEDGER),
        '"prompt"', "prompt box")
refuses("a say with nothing said is a turn with nothing in it",
        lambda: chat.validate({"act": "say", "say": "  "}, LEDGER), '"say"')
refuses("a say that is not text names the field",
        lambda: chat.validate({"act": "say", "say": {"text": "hi"}}, LEDGER), '"say"')
refuses("a from that is not a list names the field",
        lambda: chat.validate({"act": "render", "kind": "still", "prompt": "a fox",
                               "from": {"handle": "img-1"}}, LEDGER),
        '"from"', "list of handles")
refuses("seconds that is not a number names the field",
        lambda: chat.validate({"act": "render", "kind": "video", "prompt": "a fox",
                               "seconds": "a while"}, LEDGER),
        '"seconds"', "number of seconds")
refuses("an aspect that is not a name names the field",
        lambda: chat.validate({"act": "render", "kind": "still", "prompt": "a fox",
                               "aspect": [16, 9]}, LEDGER),
        '"aspect"', '"16:9"')

# The one validation that is about data rather than shape: a handle the ledger
# never issued is a reference to a file that does not exist, and it is refused
# here rather than three modules later at the compiler — with the handles that
# *would* have worked, since the model is about to be asked again.
refuses("an unknown handle is refused with the ones that exist",
        lambda: chat.validate({"act": "render", "kind": "still", "prompt": "a fox",
                               "from": ["img-9"]}, LEDGER),
        "@img-9", "img-1, vid-1")
refuses("and with an empty ledger it says so instead",
        lambda: chat.validate({"act": "render", "kind": "still", "prompt": "a fox",
                               "from": ["img-1"]}, []),
        "nothing has been made yet")

# Two spellings are read rather than refused. Both are what a model that has
# just read a ledger full of `@img-1` lines does, and neither leaves any doubt
# about what was meant — the point of the strictness above is fields whose
# meaning is actually unclear.
check("a lone handle is read as a list of one",
      chat.validate({"act": "render", "kind": "still", "prompt": "a fox",
                     "from": "img-1"}, LEDGER)["from"], ["img-1"])
check("a handle written with its @ is the same handle",
      chat.validate({"act": "render", "kind": "still", "prompt": "a fox",
                     "from": ["@img-1", "img-1"]}, LEDGER)["from"], ["img-1"])

check("a valid say carries its whole reply",
      chat.validate({"act": "say", "say": "The seed picks the noise."}, LEDGER),
      {"act": "say", "kind": None, "prompt": "", "from": [], "seconds": None,
       "aspect": None, "say": "The seed picks the noise."})


# ---- the one re-ask ---------------------------------------------------------

bad = chat.judge("I would be happy to help!", LEDGER, "a fox in the snow")
check("an unusable reply is a re-ask", bad["act"], "reask")
check("and the sentence quoted back is the validator's",
      "no JSON object" in bad["sentence"], True)

good = chat.judge(SHAPES["a plan line and a fence"], LEDGER, "a fox in the snow")
check("a usable render comes back as one", good["act"], "render")
check("with the plan line standing in for an unwritten say",
      good["say"], "A picture, nothing to reference.")

# The nudge. ChatGPT's contract is "do not ask for confirmation, just render",
# and a small model offering to generate something is the commonest way this
# surface disappoints — so a `say` in answer to a plain request buys one more go.
asked = chat.judge('{"act": "say", "say": "Would you like me to make that?"}',
                   LEDGER, "make me a picture of a fox")
check("a say where a render was expected is a re-ask", asked["act"], "reask")
check("and says so rather than quoting a field", asked["sentence"], chat.NUDGE)

chatted = chat.judge('{"act": "say", "say": "It picks the starting noise."}',
                     LEDGER, "what does the seed do?")
check("a say in answer to a question is just a say", chatted["act"], "say")

check("the nudge reads a request", chat.asks_for_render("now a clip of it"), True)
check("and its plural", chat.asks_for_render("can I have two pictures"), True)
check("and two-word phrases in it", chat.asks_for_render("make me something nice"), True)
# Whole words only: the list only ever *adds* a model call, so a word that fires
# on ordinary prose costs a wasted generation and hands the person a correction
# demanding a render they never asked for.
check("but not a word that merely contains one",
      chat.asks_for_render("the videographer was late"), False)
check("and not a turn that is only conversation",
      chat.asks_for_render("that came out lovely, thank you"), False)
# Two words were dropped from the list for being commoner in conversation than
# in a request: "still" is an adverb far more often than it is a noun, and
# "shot" is as much praise for one as a request for one. Both pushed a model
# that had correctly answered a question into a re-ask demanding a render.
check("an adverb is not a request for a picture",
      chat.asks_for_render("why is it still dark?"), False)
check("and praise for a shot is not a request for another",
      chat.asks_for_render("that shot of yours was lovely"), False)
check("what the list holds is written down, so dropping from it is deliberate",
      chat.RENDER_WORDS,
      ("picture", "image", "clip", "video", "render", "draw", "make me", "show me"))

# Second time round nothing is re-asked: the model has now been told exactly
# what was wrong and answered anyway, and a person reading its prose is more
# use than a third round trip.
fell_back = chat.judge("<think>hmm</think>I think I need more detail first.",
                       LEDGER, "make me a picture", second=True)
check("a second failure is a say", fell_back["act"], "say")
check("carrying the model's own words, without its reasoning",
      fell_back["say"], "I think I need more detail first.")
check("a nudged say is taken as written the second time",
      chat.judge('{"act": "say", "say": "I cannot do that."}', LEDGER,
                 "make me a picture", second=True)["act"], "say")

quoted = chat.reask("THE CONVERSATION\nuser: a fox", "not JSON", "your reply had no JSON")
check("the re-ask carries the original message", "user: a fox" in quoted, True)
check("what the model wrote", "not JSON" in quoted, True)
check("and why it could not be used", "your reply had no JSON" in quoted, True)


# ---- the machine card -------------------------------------------------------
#
# Fixtures rather than this install's real catalog: what is under test is the
# join, and a card that says "ready" only on a machine with 40 GB of weights on
# it would be a test that passes by being unrunnable.

CATALOG = {"families": [
    {"id": "krea2", "label": "Krea 2", "produces": ["still"],
     "weights": [
         {"id": "model", "folder": "diffusion_models", "title": "the checkpoint",
          "loads": True, "routed": False},
         {"id": "turbo_model", "folder": "diffusion_models",
          "title": "the Turbo checkpoint", "loads": True, "routed": False},
         {"id": "clip", "folder": "text_encoders", "title": "the text encoder",
          "loads": True, "routed": False},
         {"id": "vae", "folder": "vae", "title": "the VAE",
          "loads": True, "routed": False},
     ],
     "canvas": {"aspects": {"16:9": 1.77, "1:1": 1.0, "9:16": 0.56}},
     # Krea 2 as it really is: it reads references, but only through an adapter
     # in the pre-stage's LoRA stack, which this room has no way to fill.
     "capabilities": {"refs": {"needs_lora": True}}, "prompt": {"max_refs": 3}},
    {"id": "qwenedit", "label": "Qwen Image Edit", "produces": ["still"],
     "weights": [
         {"id": "model", "folder": "diffusion_models", "title": "the checkpoint",
          "loads": True, "routed": False},
         {"id": "clip", "folder": "text_encoders", "title": "the text encoder",
          "loads": True, "routed": False},
         {"id": "vae", "folder": "vae", "title": "the VAE",
          "loads": True, "routed": False},
     ],
     "canvas": {"aspects": {"16:9": 1.77, "1:1": 1.0, "9:16": 0.56}},
     "capabilities": {"refs": {"needs_lora": False, "edits_first": True}},
     "prompt": {"max_refs": 3}},
    {"id": "h3", "label": "MiniMax H3", "produces": ["still", "video"],
     "weights": [
         {"id": "fl2va", "folder": "diffusion_models", "title": "the FL2VA checkpoint",
          "loads": True, "routed": True},
         {"id": "ref2va", "folder": "diffusion_models", "title": "the Ref2VA checkpoint",
          "loads": True, "routed": True},
         {"id": "clip", "folder": "text_encoders", "title": "the text encoder",
          "loads": True, "routed": False},
         {"id": "vae", "folder": "vae", "title": "the video VAE",
          "loads": True, "routed": False},
         {"id": "audio_vae", "folder": "vae", "title": "the audio VAE",
          "loads": True, "routed": False},
         {"id": "sam3", "folder": "checkpoints", "title": "the face detector",
          "loads": False, "routed": False},
         {"id": "upscaler", "folder": "upscale_models", "title": "the x2 upscaler",
          "loads": True, "routed": False, "required": False},
     ],
     "canvas": {"aspects": {"16:9": 1.77, "1:1": 1.0, "9:16": 0.56},
                "fps": {"value": 24, "fixed": True},
                "frames": {"step": 17, "offset": 5, "trained_min": 124,
                           "trained_max": 362, "min_seconds": 1, "max_seconds": 60}},
     # A video family declares its caps in a reference block of its own rather
     # than beside the prompt, which is the other spelling `ref_limit` reads.
     "reference": {"max": {"image": 9, "video": 3, "audio": 3, "files": 12}},
     "capabilities": {"audio": {"supplied": True}}, "prompt": {}},
]}

KREA2, QWENEDIT, H3 = CATALOG["families"]

ON_DISK = {"by_folder": {
    "diffusion_models": ["krea2.safetensors", "h3_fl2va.safetensors",
                         "qie.safetensors"],
    "text_encoders": ["qwen.safetensors", "minimax.safetensors"],
    "vae": ["krea2_vae.safetensors", "h3_vae.safetensors", "h3_audio.safetensors"],
    "checkpoints": [], "upscale_models": [],
}}

READY = {
    "krea2": {"model": "krea2.safetensors", "clip": "qwen.safetensors",
              "vae": "krea2_vae.safetensors"},
    "qwenedit": {"model": "qie.safetensors", "clip": "qwen.safetensors",
                 "vae": "krea2_vae.safetensors"},
    "h3": {"fl2va": "h3_fl2va.safetensors", "clip": "minimax.safetensors",
           "vae": "h3_vae.safetensors", "audio_vae": "h3_audio.safetensors"},
}

card = chat.machine_card("krea2", "h3", CATALOG, ON_DISK, READY)
check("a machine that is set up says nothing about being ready",
      "not ready" in card, False)
check("the card names what each kind is", '"still" is Krea 2' in card, True)
check("and that a clip carries its own sound", "with its own sound" in card, True)
check("the duration range is the family's canvas",
      "1 to 60 seconds" in card and "trained on 5 to 15" in card, True)
check("and so is the grid the compiler snaps to", "0.71s grid" in card, True)
check("a clip's reference limit is its grammar's, off the reference block",
      "Up to 9 pictures may be cited" in card, True)
check("a still cited by a clip is named as its first frame",
      'A still in "from" is the clip\'s first frame' in card, True)
# Both families offer the same shapes, which every family in this pack does, and
# printing eleven names twice would be a fifth of the card's whole budget.
check("one aspect table serves both where they agree",
      card.count("16:9, 1:1, 9:16"), 1)
# The point of the card being short: it rides in front of every turn.
check("the card stays inside its budget", len(card.split()) < 140, True)

# What a still family does with a cited picture, and why the card has to say it
# before the model cites one. Krea 2 is the default and reads references only
# through an adapter in the pre-stage's LoRA stack, which this room cannot
# reach — so "make it bluer" on a still would otherwise end, every time, in the
# compiler's refusal about a control the person cannot see.
check("a family whose references need an adapter says it takes none",
      'It cannot be given the pictures in "from"' in card, True)
check("and tells the model what to do instead",
      "say so if you are asked to change a picture" in card, True)
edits = chat.machine_card("qwenedit", "h3", CATALOG, ON_DISK, READY)
check("while one that reads pictures outright says how many",
      "Up to 3 pictures may be cited" in edits, True)
# On an edit family the compile starts the render from the first reference, so
# which one is cited first is the difference between changing a picture and
# drawing a new one beside it.
check("and an edit family says which one is being changed",
      "The first is the picture being changed." in edits, True)
check("which a family that only cites them does not",
      "being changed" in card, False)
check("read off the manifest, never off a family id",
      (chat.takes_refs(KREA2), chat.takes_refs(QWENEDIT), chat.takes_refs(H3)),
      (False, True, True))
check("a family that declares no limit at all has nothing said about it",
      chat.ref_limit({"prompt": {}}), None)

# The turbo checkpoint is required exactly when the pill is thrown. Left out
# either way, the dry run passes and `render_image.check` refuses on the queue —
# the one failure the card and the dry run exist between them to prevent.
check("with the pill thrown the Turbo checkpoint is required",
      chat.missing_weights(KREA2, READY["krea2"], ON_DISK, turbo=True),
      ["the Turbo checkpoint"])
check("and with it thrown the card says so where the model can read it",
      "no file is picked for the Turbo checkpoint" in
      chat.machine_card("krea2", "h3", CATALOG, ON_DISK, READY, turbo=True), True)
check("a machine that has the file is ready either way",
      chat.missing_weights(
          KREA2, {**READY["krea2"], "turbo_model": "krea2.safetensors"},
          ON_DISK, turbo=True), [])
# The switch is wired to the still side alone — see `video_piece` — so it must
# not start demanding files of the video family.
check("the switch does not reach the video family",
      "MiniMax H3 is not ready" in
      chat.machine_card("krea2", "h3", CATALOG, ON_DISK, READY, turbo=True), False)

# The turbo checkpoint is a choice — the pill is off unless somebody throws it —
# and a routed pair is a choice too: one of them on disk already renders
# something, and refusing a machine that has Ref2VA but not FL2VA would be
# refusing a machine that works.
check("an unpicked turbo checkpoint is not missing weights",
      chat.missing_weights(KREA2, READY["krea2"], ON_DISK), [])
check("nor is a second routed checkpoint",
      chat.missing_weights(H3, READY["h3"], ON_DISK), [])
check("nor a slot the family declares optional",
      "the x2 upscaler" in card, False)
check("nor one whose file some other node opens for itself",
      "the face detector" in card, False)

check("a family with no routed checkpoint at all cannot render",
      chat.missing_weights(H3,
                           {k: v for k, v in READY["h3"].items() if k != "fl2va"},
                           ON_DISK),
      ["the FL2VA checkpoint", "the Ref2VA checkpoint"])

# A pick is a filename somebody chose once, and the file can be gone since. Both
# halves are asked, because a stale pick otherwise fails at the loader minutes
# later instead of in the card, where the model could have said so.
check("a pick naming a file that is no longer there is missing",
      chat.missing_weights(KREA2,
                           {**READY["krea2"], "vae": "deleted.safetensors"}, ON_DISK),
      ["the VAE"])

bare = chat.machine_card("krea2", "h3", CATALOG, ON_DISK, {})
check("an unset machine says which family is not ready",
      "Krea 2 is not ready" in bare, True)
check("naming every one, by the name on the control that picks it",
      "no file is picked for the checkpoint, the text encoder and the VAE" in bare, True)
check("and telling the model to say so rather than try",
      "Say so instead of asking for a still" in bare, True)


# ---- the ledger -------------------------------------------------------------
#
# The whole of what the model knows about a render. Pixels never enter the text
# context: an edit is a fresh prompt plus the id of the earlier thing, which is
# what makes the id the load-bearing part of the line.

check("a render reads as its handle, kind, shape, turn and prompt",
      chat.ledger_line(LEDGER[0]),
      'img-1 · still · 16:9 · turn 1 · "a red fox on a snowy ridge at dusk, low sun behind"')
check("a line with nothing but a handle is still a line",
      chat.ledger_line({"handle": "img-4"}), "img-4")
check("an upload with a filename for a description keeps it",
      chat.ledger_line({"handle": "img-5", "kind": "still", "text": "cat.png"}),
      'img-5 · still · "cat.png"')
long_one = chat.ledger_line({"handle": "img-6", "text": "word " * 60})
check("a very long description is cut at a word", long_one.endswith('…"'), True)
check("and stays short enough that twenty of them are still a ledger",
      len(long_one) < 140, True)
check("an empty ledger says so rather than showing a heading over nothing",
      chat.ledger_block([]), "WHAT HAS BEEN MADE\nNothing yet.")
check("and a full one is one line per thing",
      chat.ledger_block(LEDGER).count("\n"), 2)


# ---- the context and its budget ---------------------------------------------

HISTORY = []
for turn in range(1, 8):
    HISTORY.append({"role": "user", "text": f"turn {turn}"})
    HISTORY.append({"role": "assistant",
                    "action": {"act": "render", "kind": "still",
                               "prompt": f"a picture for turn {turn}"}})

kept = chat.trim(HISTORY)
check("the budget keeps five exchanges",
      sum(1 for m in kept if m["role"] == "user"), 5)
check("dropping the oldest first", kept[0]["text"], "turn 3")
check("and never an answer whose question is gone", kept[0]["role"], "user")

# The count is the rule; the character budget is the backstop. Five exchanges of
# a pasted paragraph and a long rewrite are both legitimate and both blow a
# token budget that a count alone cannot see.
huge = [{"role": "user", "text": "x" * 3000},
        {"role": "assistant", "say": "y" * 3000},
        {"role": "user", "text": "the short one"}]
check("an enormous exchange is dropped even inside the count",
      [m["text"] for m in chat.trim(huge) if m["role"] == "user"], ["the short one"])
check("but the turn being answered is never dropped",
      chat.trim([{"role": "user", "text": "z" * 9000}])[0]["role"], "user")

message = chat.context(HISTORY, LEDGER, card)
check("the machine leads", message.startswith("WHAT THIS MACHINE MAKES"), True)
check("the ledger follows it",
      message.index("WHAT HAS BEEN MADE") < message.index("THE CONVERSATION"), True)
check("the conversation is last, and the freshest turn is its last line",
      message.index("user: turn 7") > message.index("user: turn 6"), True)
check("an assistant turn reads back as the action it took, not as prose",
      '"prompt": "a picture for turn 7"' in message, True)
# Fields nobody set are left out: a wall of nulls is the same information at
# three times the length, on a model that is paying for every token of it.
check("with only the fields that were set", '"say"' in message, False)
check("and the last thing read is what to do about it",
      message.rstrip().endswith("``` fence, and nothing after it."), True)


# ---- the blob the action becomes --------------------------------------------

still = chat.still_piece(
    chat.validate({"act": "render", "kind": "still", "prompt": "the fox, bluer",
                   "from": ["img-1"], "aspect": "1:1"}, LEDGER), LEDGER, RAIL)
check("a still is a pre-stage blob of the rail's architecture", still["arch"], "krea2")
check("the model's prompt goes in as typed", still["prompt"], "the fox, bluer")
check("the action's aspect wins over the rail's", still["aspect"], "1:1")
check("and the rail's is used when the action says nothing",
      chat.still_piece(chat.validate(
          {"act": "render", "kind": "still", "prompt": "a fox"}, LEDGER),
          LEDGER, RAIL)["aspect"], "16:9")
# ...and where nobody has an opinion the key is simply not written: both
# compilers read an absent one as their family's own default, and a number
# repeated here would be a third copy of one two modules already own.
bare_canvas = chat.still_piece(
    chat.validate({"act": "render", "kind": "still", "prompt": "a fox"}, LEDGER),
    LEDGER, {**RAIL, "aspect": None, "still_edge": None})
check("a shape nobody chose is left to the family",
      ("aspect" in bare_canvas, "short_edge" in bare_canvas), (False, False))
# The short edge is the kind's own: a still at the still edge, a clip at the
# clip edge, and a rail from before the split still lands its one number.
check("a still is drawn at the still edge", still["short_edge"], 1024)
check("a clip is sampled at the clip edge",
      chat.video_piece(chat.validate({"act": "render", "kind": "video", "prompt": "a fox"}, LEDGER),
                       LEDGER, RAIL)["short_edge"], 768)
check("an older rail's one short edge is read for both",
      chat.still_piece(chat.validate({"act": "render", "kind": "still", "prompt": "a fox"}, LEDGER),
                       LEDGER, {**RAIL, "still_edge": None, "short_edge": 896})["short_edge"], 896)
check("a cited handle becomes a reference carrying its file",
      still["refs"], [{"handle": "img-1", "filename": "continuity/chat/fox.png"}])
# The promotion of a first reference to the thing being edited is
# `compile_image.compile_prestage`'s, on the families that declare
# `EDITS_FIRST_REF`, and citing in order is the whole of what this side has to
# do to make it right — a second copy of that rule here could only disagree.
edit = chat.still_piece(
    chat.validate({"act": "render", "kind": "still", "prompt": "make her coat white",
                   "from": ["img-1"]}, LEDGER), LEDGER,
    {**RAIL, "still_family": "qwenedit", "still_arch": "qwenedit"})
check("an edit family gets the picture being edited as its first reference",
      edit["refs"][0]["handle"], "img-1")
check("and no init, so the compile's own promotion is what decides",
      edit["init"], None)
check("the weights are left for the route, which is the half with a disk",
      still["models"], {})
# Per-arch, the way the pre-stage's own block is: a flat one would carry one
# family's file onto another the moment the arch pill moved.
check("the turbo pill is written under the architecture it belongs to",
      still["turbo"], {"krea2": {"on": False}})

# A family whose references arrive through an adapter cannot be given one here:
# the adapter is an entry in the pre-stage's LoRA stack, and this room has no
# stack. Refused in the room's own words rather than relayed from the compiler,
# whose sentence names a control the person cannot see from the chat.
NO_PICTURES = {**RAIL, "still_pictures": chat.still_pictures(KREA2, CATALOG)}
refuses("a family that reads pictures only through an adapter refuses one",
        lambda: chat.still_piece(
            chat.validate({"act": "render", "kind": "still", "prompt": "bluer",
                           "from": ["img-1"]}, LEDGER), LEDGER, NO_PICTURES),
        "Krea 2 draws from words alone", "no stack to put one in")
check("and the refusal names the families that do read pictures",
      "Qwen Image Edit do read pictures" in NO_PICTURES["still_pictures"]["refusal"],
      True)
check("a still with nothing cited is made on that family all the same",
      chat.still_piece(chat.validate(
          {"act": "render", "kind": "still", "prompt": "a fox"}, LEDGER),
          LEDGER, NO_PICTURES)["refs"], [])
# The other way of reading no pictures: weights that take none at all.
check("a family whose weights read no picture says so differently",
      chat.refs_refusal({"label": "Ideogram 4", "prompt": {"max_refs": 0}}),
      "Ideogram 4 draws from words alone: it reads no attached picture at all.")
# A rail that says nothing means a family that takes pictures, which is what
# every still family but Krea 2 and Ideogram 4 is.
check("a rail with nothing to say about pictures lets one through",
      chat.still_piece(chat.validate(
          {"act": "render", "kind": "still", "prompt": "a fox", "from": ["img-1"]},
          LEDGER), LEDGER, RAIL)["refs"][0]["handle"], "img-1")

refuses("a still cannot be given a clip",
        lambda: chat.still_piece(
            chat.validate({"act": "render", "kind": "still", "prompt": "a fox",
                           "from": ["vid-1"]}, LEDGER), LEDGER, RAIL),
        "@vid-1", "pictures")

clip = chat.video_piece(
    chat.validate({"act": "render", "kind": "video", "prompt": "she looks up",
                   "from": ["img-1", "vid-1"], "seconds": 5}, LEDGER), LEDGER, RAIL)
check("a clip is a piece of one shot", len(clip["segments"]), 1)
check("on the rail's family", clip["family"], "h3")
check("the piece's standing description stays empty — everything is on the card",
      clip["prompt"], "")
shot = clip["segments"][0]
check("the shot carries the model's prompt", shot["prompt"], "she looks up")
check("and the duration it asked for", shot["duration_s"], 5)
check("a still cited by a clip is the shot's first frame",
      (shot["assets"][0]["handle"], shot["assets"][0]["role"],
       shot["assets"][0]["kind"]),
      ("img-1", "first_frame", "image"))
check("and everything else is a reference",
      (shot["assets"][1]["role"], shot["assets"][1]["kind"]), ("reference", "video"))
check("a clip with nothing attached is a plain one",
      chat.video_piece(chat.validate(
          {"act": "render", "kind": "video", "prompt": "a fox"}, LEDGER),
          LEDGER, RAIL)["segments"][0]["assets"], [])
check("and runs for the Creator's own default when nobody said",
      chat.video_piece(chat.validate(
          {"act": "render", "kind": "video", "prompt": "a fox"}, LEDGER),
          LEDGER, {**RAIL, "seconds": None})["segments"][0]["duration_s"], 6)

# A shot opens once, so a second still has nowhere to be a keyframe.
two = chat.video_piece(
    {"act": "render", "kind": "video", "prompt": "a fox",
     "from": ["img-1", "img-2"], "seconds": None, "aspect": None, "say": ""},
    LEDGER + [{"handle": "img-2", "filename": "b.png"}], RAIL)
check("only the first still opens the shot",
      [a["role"] for a in two["segments"][0]["assets"]],
      ["first_frame", "reference"])

# The ledger and the browser disagreeing is the one failure that would put a
# render on the queue without the picture it was supposed to be of.
refuses("a handle the ledger has never issued is refused",
        lambda: chat.video_piece(
            {"act": "render", "kind": "video", "prompt": "a fox", "from": ["img-9"]},
            LEDGER, RAIL),
        "@img-9", "not in the ledger")
refuses("and so is one whose render has not landed yet",
        lambda: chat.video_piece(
            {"act": "render", "kind": "video", "prompt": "a fox", "from": ["img-3"]},
            LEDGER + [{"handle": "img-3"}], RAIL),
        "@img-3", "no file behind it")

check("which node runs which kind is answered in one place",
      (chat.piece_of({"act": "render", "kind": "still", "prompt": "a fox",
                      "from": []}, LEDGER, RAIL)[:2],
       chat.piece_of({"act": "render", "kind": "video", "prompt": "a fox",
                      "from": []}, LEDGER, RAIL)[:2]),
      (("MiniMaxH3PreStage", "prestage_data"),
       ("MiniMaxH3Creator", "creator_data")))

# The seed is a widget on the node and never a field in the blob — see
# `sampling.py`, which says why — so the rail's policy is what decides it and
# nothing in either blob mentions it.
check("a fixed seed is the rail's number", chat.render_seed(RAIL), 7)
check("and is nowhere in the blob", "seed" in json.dumps(clip), False)
rolled = chat.render_seed({**RAIL, "seed_policy": "random"})
check("a rolled one is a seed a sampler can take", 0 <= rolled <= 0xffffffffffffffff, True)
check("junk in the rail is seed zero rather than a crash",
      chat.render_seed({"seed": "soon"}), 0)


# ---- the Refine switch --------------------------------------------------------
#
# With the rail's switch on, a clip's prompt goes through the family's own
# prompting before queueing — the button's call, on the button's settings — and
# what comes back is written onto the piece the way the panel writes it, so the
# compiler reads a chat render's rewrite exactly as it reads the button's.

CLIP = chat.video_piece(
    chat.validate({"act": "render", "kind": "video", "prompt": "the fox looks up",
                   "from": ["img-1"], "seconds": 5}, LEDGER), LEDGER, RAIL)
BLOCK = {"model": "qwen3-vl:4b", "backend": "remote", "temperature": 0.3, "seed": -1,
         "language": "English", "max_tokens": 900, "skill": "", "skill_mode": "",
         "eject": True, "not_a_field": "dropped"}

request = chat.refine_request(BLOCK, CLIP)
check("a refine asks for the Creator's own target, which is this one card",
      (request["kind"], request["index"], request["data"] is CLIP), ("creator", 0, True))
check("every refiner field rides through by name",
      {field: request[field] for field in chat.REFINE_FIELDS},
      {field: BLOCK[field] for field in chat.REFINE_FIELDS})
check("and nothing else does", "not_a_field" in request, False)
check("a field the room left out is left out, not written as None",
      "language" in chat.refine_request({"model": "m"}, CLIP), False)
check("no template travels — the route's auto is the derived mode",
      "template" in request, False)

RESULT = {"mode": "I2VA", "template": "I2VA", "derived": "I2VA", "forced": False,
          "shots": [{"index": 0, "body": "<Picture 1> is the fox. She lifts her head…"}],
          "soundscape": "wind over snow", "music": "", "sections": None,
          "piece": None, "scope": "shot", "seen": "a fox on a ridge",
          "problems": ["the rewrite never mentions @img-1 — …"]}

piece = json.loads(json.dumps(CLIP))
problems = chat.refine_into(piece, RESULT, "qwen3-vl:4b")
refined = piece["segments"][0]["refined"]
check("the rewrite lands on the shot as the panel would write it",
      {key: refined[key] for key in ("body", "scope", "template", "forced", "model", "enabled")},
      {"body": "<Picture 1> is the fox. She lifts her head…", "scope": "shot",
       "template": "I2VA", "forced": False, "model": "qwen3-vl:4b", "enabled": True})
check("what it was written from is kept, so the editor can say when the sentence moved",
      refined["source"], "the fox looks up")
check("the panel's undo bookkeeping is not invented for a blob with nothing to undo",
      "replaced" in refined, False)
check("a skill that did not write it is not named as having",
      ("skill" in refined, "kind" in refined), (False, False))
check("the soundscape the reply carried goes on the shot",
      piece["segments"][0].get("soundscape"), "wind over snow")
check("and an empty music field blanks nothing",
      "music" in piece["segments"][0], False)
check("the route's own problems come back for the card, advisory",
      problems, ["the rewrite never mentions @img-1 — …"])
check("the prompt itself is untouched — the rewrite stands beside it",
      piece["segments"][0]["prompt"], "the fox looks up")

# The replace path: a skill wrote one whole document, and the block says which.
by_skill = json.loads(json.dumps(CLIP))
chat.refine_into(by_skill, {"mode": "T2VA", "skill": "noir", "kind": "prompt",
                            "shots": [{"index": 0, "body": "A DOCUMENT"}],
                            "soundscape": "", "music": "", "sections": None,
                            "seen": "", "problems": []}, "m")
check("a skill's rewrite names the skill and what kind of file it was",
      (by_skill["segments"][0]["refined"]["skill"], by_skill["segments"][0]["refined"]["kind"]),
      ("noir", "prompt"))
check("and carries no scope, because the document absorbed the join",
      "scope" in by_skill["segments"][0]["refined"], False)

# A reply with nothing in it: the prompt goes as the model wrote it, and the
# blob is not left wearing a `refined` block that reads as typed text to the
# compiler and as a rewrite to a person.
empty = json.loads(json.dumps(CLIP))
said = chat.refine_into(empty, {"shots": [{"index": 0, "body": "  "}], "problems": []}, "m")
check("an empty rewrite is not written", "refined" in empty["segments"][0], False)
check("and says so", any("wrote nothing" in p for p in said), True)
refuses("a piece with no shot cannot be refined",
        lambda: chat.refine_into({"segments": []}, RESULT, "m"), "no shot")

# ---- the system prompt ------------------------------------------------------
#
# Read off the file rather than described in prose here: it is the one part of
# this that is tuned against a real model on the bench, and the things below are
# what the parser and the schema depend on it still saying.

SYSTEM = chat.system_prompt()
for field in chat.FIELDS:
    if f'"{field}"' not in SYSTEM:
        FAILURES.append(f"the system prompt never mentions the {field!r} field")
check("it asks for one line of plan then a fence",
      "one short line of plan" in SYSTEM and "``` fence" in SYSTEM, True)
check("it carries the three worked exchanges the spec asks for",
      SYSTEM.count("Person:"), 3)
check("and teaches the prompt box's own three marks",
      all(mark in SYSTEM for mark in ("@img-1", "{a|b}", "quoted words")), True)

with_skill = chat.system_prompt("Write everything in the present tense.")
check("a skill set to add lands after the contract, never over it",
      with_skill.startswith(SYSTEM) and "present tense" in with_skill, True)
check("and says out loud that the reply's shape is not its to move",
      "not theirs to move" in with_skill, True)

passed("the chat surface parses, refuses, re-asks and patches as specified")
