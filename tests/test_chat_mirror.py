"""The two shapes the chat room and the chat server agree about in silence.

    python3 tests/test_chat_mirror.py

Everything else between the room and `creator/chat.py` fails loudly: a bad
action is a sentence naming the field, a blob the compiler will not take is a
refusal in a bubble. Two things do not.

**A handle's prefix is how the server knows what a file is.** `chat._media_kind`
reads `img-3` as a picture and `vid-1` as a clip — there is no `kind` beside it
in the action, and there cannot be, because the model writes the handle and
nothing else. So a room that minted `pic-3` would send a citation the compiler
refuses with a sentence about a handle nobody recognises, for a file that is
sitting right there.

**A ledger entry is read field by field.** `ledger_line` draws the line the
model reads and `_cited` opens the file behind it; a room that wrote `file`
where the server reads `filename` would produce a ledger that looks right on
screen, reads as a row of bare handles to the model, and refuses every citation
as a thing with no file behind it.

Both are one word each, in two languages, and neither has a test that would go
red. This is that test. It reads the source rather than running it, the way
`test_js_links.py` does: what is being held together is two spellings, and
spelling is visible in the text.
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import layout  # noqa: E402
from harness import FAILURES, check, passed  # noqa: E402

chat = layout.load("prompting", "chat").chat

with open(layout.js("chat.js"), encoding="utf-8") as handle:
    ROOM = handle.read()


# ---- the handle prefixes ------------------------------------------------------

block = re.search(r"const PREFIX = \{([^}]*)\}", ROOM)
if not block:
    FAILURES.append("chat.js no longer declares a PREFIX table")
    room_prefixes = {}
else:
    room_prefixes = dict(re.findall(r'(\w+)\s*:\s*"([^"]+)"', block.group(1)))

# The server's half is a real dict in a real function, so it is read by asking
# rather than by grepping: every prefix the room can mint has to come back as
# the media kind the room minted it for.
for media, prefix in sorted(room_prefixes.items()):
    try:
        got = chat._media_kind(f"{prefix}-1")
    except chat.ActionError as problem:
        FAILURES.append(f"the room mints {prefix}-1 and the server refuses it: {problem}")
        continue
    check(f"{prefix}-N is a {media} on both sides", got, media)

check("the room mints a handle for every kind the server accepts",
      sorted(room_prefixes.values()), ["clip", "pic", "snd"])


# ---- the ledger entry ---------------------------------------------------------

# What the room writes, off the one call that writes it. Shorthand properties
# count: `filename` and `{filename: filename}` are the same field, and the one
# this would miss is the one a room actually writes.
written = re.search(r"const entry = \{ handle:(.*?)\};", ROOM, re.DOTALL)
room_keys = (set(re.findall(r"(?:^|[,{])\s*(\w+)\s*(?=[:,}])", written.group(0)))
             if written else set())
check("the room writes the six fields a ledger line is made of",
      sorted(room_keys),
      ["aspect", "filename", "handle", "kind", "text", "turn"])

# And what the server reads, asked the only way that cannot go stale: hand it an
# entry and see whether the line comes out whole.
entry = {"handle": "img-3", "kind": "still", "aspect": "16:9", "turn": 4,
         "filename": "continuity/chat/img-3.png [output]",
         "text": "a fox on a snowy ridge at dusk"}
check("an entry the room would write reads back as the spec's line",
      chat.ledger_line(entry),
      'img-3 · still · 16:9 · turn 4 · "a fox on a snowy ridge at dusk"')
check("and the file behind it is the one the room uploaded",
      chat._cited({"from": ["img-3"]}, [entry]),
      [("img-3", "image", "continuity/chat/img-3.png [output]", None)])

# A field spelled wrong is exactly the silent failure above: the line still
# draws, and the citation still refuses.
missing = dict(entry)
missing.pop("filename")
try:
    chat._cited({"from": ["img-3"]}, [missing])
    FAILURES.append("an entry with no filename was accepted")
except chat.ActionError:
    pass


# ---- the refine request -------------------------------------------------------
#
# The Refine switch sends the refiner's own settings alongside a render, in the
# block the Refine button sends, and the server passes them to the refine route
# by name: a field the room spells one way and the server reads another is a
# dial that silently stays at its default. Read off `refine.js`, since the room
# imports the builder from there rather than spelling the block a second time.

with open(layout.js("refine.js"), encoding="utf-8") as handle:
    REFINE = handle.read()

builder = re.search(r"export function refineRequest\(.*?\n\}", REFINE, re.DOTALL)
if not builder:
    FAILURES.append("refine.js no longer exports refineRequest")
    sent = set()
else:
    body = builder.group(0)[builder.group(0).index("return {"):]
    sent = set(re.findall(r"(?:^|[,{\n])\s*(\w+)\s*(?=[:,}])", body))
check("the room sends exactly the fields the server reads through",
      sorted(sent), sorted(chat.REFINE_FIELDS))
check("and the server hands each one to the refine route by the same name",
      sorted(field for field in chat.refine_request(
          {field: field for field in chat.REFINE_FIELDS}, {"segments": []})
             if field not in ("kind", "data", "index")),
      sorted(chat.REFINE_FIELDS))
check("the room imports the builder rather than spelling a second block",
      "refineRequest" in ROOM and "refineRequest(" in ROOM, True)


# ---- the conversation ---------------------------------------------------------
#
# The room sends its own transcript, so what it calls a turn has to be what
# `chat.context` reads one as. Held here by building the message the room builds
# and reading the block back.

message = chat.context(
    [{"role": "user", "text": "a fox in a snowy wood at dusk"},
     {"role": "assistant", "say": "Making it now.",
      "action": {"act": "render", "kind": "still", "prompt": "a red fox at dusk",
                 "from": [], "seconds": None, "aspect": None, "say": "Making it now."}},
     {"role": "user", "text": "now a clip of it"}],
    [entry], "WHAT THIS MACHINE MAKES")
check("a user turn reads back as what was said",
      "user: a fox in a snowy wood at dusk" in message, True)
check("an assistant turn reads back as the action it took",
      '"prompt": "a red fox at dusk"' in message, True)
check("and the ledger the room keeps is the block the model is given",
      chat.ledger_line(entry) in message, True)

passed("the room and the server spell handles and ledger entries the same way")
