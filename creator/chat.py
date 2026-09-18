"""The chat surface's thinking half: one action, and the blob it becomes.

The room off the dashboard lets somebody talk to the refiner model the way they
talk to ChatGPT, and get pictures and clips out of it. Everything in that
sentence that is not a room is here: what the model is told, what it is allowed
to answer, how a malformed answer is put right, and what an answer turns into
before it reaches the compiler. `routes/chat.py` is the door, and it does the
joining — disk, settings, the queue; this module is ordinary data and is tested
as such, the same bargain `families/refine.py` and `compile.py` keep.

**One action with nine flat fields, and at most one per turn.** Not because
nine is elegant but because the refiner is whatever the user already pointed
the pack at, and on a 4B model tool selection falls apart as the catalogue
grows and multi-turn tool use falls apart outright (the spec's §3 collects the
numbers). So every turn is a fresh single decision: the harness carries the
whole of the state — what exists, what was said, what each render was of — and
the model chooses once, between saying something and rendering something.

**The reply is one line of plan, then the JSON in a fence.** A short plan in
front of a structured answer measurably helps a small model pick the right
action and a long one hurts, so the contract asks for exactly one line. The
parse is tolerant and the validation is strict, which is the same split
`families/refine.json_object` already makes: transport noise — a leaked
`<think>` block, a fence, a sentence in front of the object — is absorbed,
and what the object *holds* is judged by name. A failure is a sentence, because
that sentence is quoted straight back to the model on the one re-ask and then
shown to a person if the second attempt fails too.

**The model writes the prompt; the compiler renders it.** `prompt` is what a
user would type into the prompt box, in the pack's own language, and it goes
into the segment as typed. There is no second model call and no graph JSON
anywhere: the blob is the template, and everything the action can say is a
field of a blob the compiler already understands.

No ComfyUI, no aiohttp, no torch, no disk beyond the one system prompt file
beside this one.
"""

import json
import os
import re

from . import canvas
from .compile import TAKES
from .families import refine, registry
from .families.h3 import subjects


# ---- the system prompt ------------------------------------------------------

_SYSTEM_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "prompts", "chat", "system.txt")

_SYSTEM = None


def system_prompt(extra=""):
    """The room's standing instruction, with the user's own text appended.

    One file, read once and held: it is stable wording on purpose — a reply
    contract a small model reads is sensitive to how it is phrased, so tuning
    happens on `tools/chat_bench.py` against a real model and lands here as an
    edit, never as a string built at runtime out of the conversation.

    `extra` is a skill the user asked to *add* to the prompting, the same `add`
    mode the refine panel offers. It goes after the contract rather than before
    it for the same reason `families/refine.EXTRA_RULE` places it late: it is
    about how to write, and the shape of the reply is not its to move. That
    rule is the one the route quotes when it refuses a `replace` skill here.
    """
    global _SYSTEM
    if _SYSTEM is None:
        with open(_SYSTEM_PATH, "r", encoding="utf-8") as handle:
            _SYSTEM = handle.read().strip()
    if not (extra or "").strip():
        return _SYSTEM
    return _SYSTEM + "\n\n" + refine.EXTRA_RULE.format(extra=extra.strip())


# ---- the action -------------------------------------------------------------

ACT_SAY, ACT_RENDER = "say", "render"
KIND_STILL, KIND_VIDEO = "still", "video"

# Every field the schema has. Written down so the contract, the validator and
# the system prompt's worked examples can be held against one list.
FIELDS = ("act", "kind", "prompt", "from", "seconds", "aspect", "say",
          "after", "replaces")

# What of a cited file the reference is, written after the handle as
# `img-2:style`. One token and no nesting, because a nested object is where a
# small model's JSON goes wrong; the vocabulary is the compiler's own `TAKES`
# per kind of file, minus `full`, which is what no suffix means.
SCOPE_RE = re.compile(r"^@?([A-Za-z]+-\d+)(?::([a-z]+))?$")

# Anything written after an `@` in a prompt: a file's handle or a member's name,
# told apart by the hyphen — `subjects.HANDLE_RE` forbids a member the hyphen
# every file handle has. `compile.HANDLE_RE` matches only the first shape and
# `subjects.citation_re` only the declared names, so the check that every `@`
# means something is this module's — it runs before either of them. The cast
# is the piece's: somebody the person brought in with the node's own `@` menu,
# never somebody the model invents.
CITE_RE = re.compile(r"@([A-Za-z][A-Za-z0-9_-]*)")

# What kind of file a ledger entry describes, by the word the room writes in
# its `kind` — the room's three, and the prefix as the fallback for an entry
# written before the word was read.
LEDGER_KINDS = {"still": "image", "clip": "video", "sound": "audio",
                "image": "image", "video": "video", "audio": "audio"}

# How much of a `say` the bubble is given. A model that answers a question with
# an essay is not wrong, but the bubble is one line beside a render card and the
# whole reply is already kept as `raw`.
MAX_SAY = 600


class ActionError(ValueError):
    """An answer this harness will not run, said as a sentence.

    The sentence is the whole point of the class: it is quoted back to the model
    verbatim on the one re-ask, and shown to a person if the re-ask fails as
    well. So it names the field, says what the field must hold, and says what
    arrived instead — everything a reader needs to fix it without seeing this
    file.
    """


def _shown(value):
    """What arrived, as something safe to put in a sentence."""
    if value is None:
        return "nothing"
    try:
        text = json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        text = repr(value)
    return text if len(text) <= 60 else text[:57] + "…"


def plan_of(reply):
    """The one line of plan in front of the object, or "".

    The plan is not part of the action and nothing downstream depends on it —
    it is asked for because a short reasoning preamble lifts a small model's
    choice of action, and it is read back here so the bench can show what the
    model was thinking when it chose wrong. Everything from the first fence or
    the first brace onwards is the object's.
    """
    text = refine.THINK_RE.sub("", reply or "").strip()
    marks = [at for at in (text.find("```"), text.find("{")) if at >= 0]
    head = text[:min(marks)] if marks else text
    for line in head.splitlines():
        if line.strip():
            return line.strip()
    return ""


def spoken(reply):
    """The model's prose with the machinery taken off — the second-failure line.

    Twice now the model has been asked for an object and twice it has not
    produced one, so whatever it *did* write is the best thing left to show. The
    `<think>` block and any fenced block come off, because neither is addressed
    to the reader; if nothing survives that, the raw reply is shown rather than
    an empty bubble.
    """
    text = refine.THINK_RE.sub("", reply or "").strip()
    stripped = re.sub(r"```.*?```", "", text, flags=re.DOTALL).strip()
    return (stripped or text)[:MAX_SAY]


def parse(reply):
    """The raw reply -> `(plan, the object the model meant to return)`.

    Tolerance lives here and nowhere else. `json_object` already absorbs a
    leaked `<think>` block, a fence and a sentence in front of the object, which
    covers every transport failure seen on the small models this has to work
    with; what it cannot find, nothing can, and that is a re-ask.
    """
    try:
        raw = refine.json_object(reply)
    except refine.RefineError:
        raise ActionError(
            "your reply had no JSON object in it. Write one line of plan, then "
            "the action as a JSON object in a ``` fence, and nothing after it."
        ) from None
    return plan_of(reply), raw


def _handles(raw, known):
    """The `from` list, as handles that are in the ledger.

    Two spellings are read rather than refused, and both are read here rather
    than in `parse` because they are about this one field. A lone string where a
    list was asked for is the slip these models make most often and its meaning
    is not in doubt; a leading `@` is the form the handle takes everywhere else
    in this pack, so a model that has just read a ledger full of them writing
    one back is not making a mistake. Anything else about the field is refused
    by name — a handle that is not in the ledger above all, since it is the one
    error that would otherwise reach the compiler as a missing file.
    """
    value = raw.get("from")
    if value is None or value == "":
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        raise ActionError(
            f'"from" must be a list of handles from the ledger, like ["img-1"]; '
            f"yours was {_shown(value)}.")

    known = known if isinstance(known, dict) else {h: None for h in known}
    out, seen = [], set()
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ActionError(
                f'"from" must hold handles from the ledger, like "img-1"; it '
                f"holds {_shown(item)}.")
        match = SCOPE_RE.match(item.strip())
        if not match:
            raise ActionError(
                f'"from" must hold handles from the ledger, like "img-1" or '
                f'"img-1:style"; it holds {_shown(item)}.')
        handle, scope = match.group(1), match.group(2)
        if handle not in known:
            where = ", ".join(known) if known else "nothing has been made yet"
            raise ActionError(
                f'"from" names @{handle}, which is not in the ledger. The '
                f"handles you may cite are: {where}.")
        if scope:
            media = known.get(handle) or _media_kind(handle)
            allowed = scopes_for(media)
            if scope not in allowed:
                raise ActionError(
                    f'@{handle}:{scope} — what a {media} can be '
                    f"cited as is {', '.join(allowed)}.")
        if handle in seen:
            continue
        seen.add(handle)
        out.append(f"{handle}:{scope}" if scope else handle)
    return out


# What a handle may be cited *as*, beside what it may be cited *for*. A role
# says where a picture goes in a clip — its start frame, its end frame, or a
# plain reference — and is the same suffix a scope is, so a person types
# `@pic-2:start` the way they type `@pic-2:style` and the model writes it
# into "from" the same way. `ref` is for a still that would otherwise open
# the shot by being cited first.
ROLE_START, ROLE_END, ROLE_REF = "start", "end", "ref"
ROLES = {"image": (ROLE_START, ROLE_END, ROLE_REF), "video": (ROLE_REF,), "audio": ()}


def scopes_for(media):
    """Every suffix a handle of this media may carry: the compiler's scopes
    bar `full`, then the roles."""
    return [t for t in TAKES.get(media, ()) if t != "full"] + list(ROLES.get(media, ()))


def split_handle(item):
    """`"img-2:style"` -> `("img-2", "style")`; a bare handle -> `(handle, None)`."""
    handle, _, scope = str(item).partition(":")
    return handle, (scope or None)


def _on_strip(raw, key, strip):
    """`after` or `replaces` -> a handle on the strip, or None."""
    value = raw.get(key)
    if value in (None, "", False):
        return None
    if not isinstance(value, str):
        raise ActionError(f'"{key}" must be the handle of a shot on the strip; '
                          f"yours was {_shown(value)}.")
    handle = value.strip().lstrip("@")
    if handle not in strip:
        where = " → ".join(strip) if strip else "there is no strip yet"
        raise ActionError(
            f'"{key}" names @{handle}, which is not a shot on the strip. The '
            f"strip is: {where}.")
    return handle


def _seconds(raw):
    """The optional duration, as a number. Absent means the family's own.

    A numeric string counts, because a model that has just written `"seconds":
    "5"` means five seconds; `true` does not, even though Python would make a
    number of it.
    """
    value = raw.get("seconds")
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ActionError(
            f'"seconds" must be a number of seconds, like 6; yours was '
            f"{_shown(value)}.")
    try:
        seconds = float(value)
    except ValueError:
        raise ActionError(
            f'"seconds" must be a number of seconds, like 6; yours was '
            f"{_shown(value)}.") from None
    if seconds <= 0:
        raise ActionError(f'"seconds" must be more than zero; yours was {seconds:g}.')
    return seconds


def validate(raw, ledger, strip=(), cast=()):
    """The object -> the action, or an `ActionError` naming the field.

    Strict, field by field, and in the order a reader would check them: what
    kind of turn this is, then what it is a turn *about*. The normalised dict
    that comes back always carries every field, so nothing downstream has to ask
    whether a key is there — only whether it is set.

    `strip` is the handles of the shots joined so far, in order, and `cast` the
    names on the piece's cast: the two things an action may point at beyond
    the ledger, and both are the room's to send.
    """
    if not isinstance(raw, dict):
        raise ActionError('the action must be a JSON object with an "act" field.')

    act = raw.get("act")
    if act not in (ACT_SAY, ACT_RENDER):
        raise ActionError(
            f'"act" must be "say" or "render"; yours was {_shown(act)}.')

    say = raw.get("say")
    if say is not None and not isinstance(say, str):
        raise ActionError(
            f'"say" must be a short line of text for the person you are talking '
            f"to; yours was {_shown(say)}.")
    say = (say or "").strip()[:MAX_SAY]

    known = known_handles(ledger)
    names = [str(n).lower() for n in cast or ()]

    if act == ACT_SAY:
        # On a `say` the field is the whole reply, so an empty one is a turn
        # with nothing in it — the one case where a missing `say` is fatal.
        if not say:
            raise ActionError('"say" must hold your reply — on a "say" it is the '
                              "whole of what the person reads.")
        return {"act": ACT_SAY, "kind": None, "prompt": "", "from": [],
                "seconds": None, "aspect": None, "say": say,
                "after": None, "replaces": None}

    kind = raw.get("kind")
    if kind not in (KIND_STILL, KIND_VIDEO):
        raise ActionError(
            f'"kind" must be "still" or "video" on a render; yours was '
            f"{_shown(kind)}.")

    prompt = raw.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ActionError(
            '"prompt" must say what to render — it is the text that goes into '
            "the prompt box, so write the description itself, not a note about it.")

    aspect = raw.get("aspect")
    if aspect is not None and aspect != "" and not isinstance(aspect, str):
        raise ActionError(
            f'"aspect" must be one of the aspect names, like "16:9"; yours was '
            f"{_shown(aspect)}.")

    cited = _handles(raw, known)
    # A scope belongs in "from"; written after a handle in the prose it
    # would reach the model as text. Read as the citation it is.
    prompt = re.sub(r"@([A-Za-z]+-\d+):[a-z]+", r"@\1", prompt.strip())
    # Every `@` in the prompt has to mean something before the compiler reads
    # it. A file's handle written in the prose and left out of "from" is the
    # commonest slip and its meaning is not in doubt, so it is added; a name
    # nobody has cast is a `<Subject N>` standing for nothing, and is refused
    # with the names that would have worked.
    listed_handles = {split_handle(item)[0] for item in cited}
    for word in CITE_RE.findall(prompt):
        if "-" in word:
            if word in known and word not in listed_handles:
                cited.append(word)
                listed_handles.add(word)
            elif word not in known:
                raise ActionError(
                    f"the prompt cites @{word}, which is not in the ledger.")
        elif word.lower() not in names:
            where = ", ".join("@" + n for n in names) if names else "nobody is cast yet"
            raise ActionError(
                f"the prompt cites @{word}, who is not in the cast. The cast is: "
                f"{where}. Write only names the cast block lists, or write the "
                f"person out in words.")

    after = _on_strip(raw, "after", strip)
    replaces = _on_strip(raw, "replaces", strip)
    if after and replaces:
        raise ActionError('"after" and "replaces" cannot both be set — a shot '
                          "either follows one or stands in for one.")
    if (after or replaces) and kind != KIND_VIDEO:
        raise ActionError('"after" and "replaces" put a clip on the strip; a '
                          "still is never on it.")
    return {"act": ACT_RENDER, "kind": kind, "prompt": prompt,
            "from": cited, "seconds": _seconds(raw),
            "aspect": (aspect or None), "say": say,
            "after": after, "replaces": replaces}


USER_CITE_RE = re.compile(r"@([A-Za-z]+-\d+)(?::([a-z]+))?")


def bind(action, user_text, known):
    """The person's own citations, written into the action's "from".

    A handle the person typed is a decision, not a suggestion to the model:
    it goes into "from" whether or not the model repeated it, and a suffix the
    person gave it wins over whatever the model wrote for the same handle. A
    handle the ledger does not know is left alone — it is prose to the
    compiler, and the prompt's own check says so.
    """
    if action.get("act") != ACT_RENDER:
        return action
    known = known if isinstance(known, dict) else {h: None for h in known}
    wanted = []
    for handle, scope in USER_CITE_RE.findall(user_text or ""):
        if handle not in known or any(h == handle for h, _ in wanted):
            continue
        if scope and scope not in scopes_for(known.get(handle) or _media_kind(handle)):
            # A suffix the file cannot wear is dropped; the citation stands.
            scope = None
        wanted.append((handle, scope or None))
    if not wanted:
        return action
    out = []
    seen = set()
    for item in action.get("from") or []:
        handle, scope = split_handle(item)
        theirs = next((s for h, s in wanted if h == handle), False)
        if theirs is not False and theirs:
            scope = theirs
        seen.add(handle)
        out.append(f"{handle}:{scope}" if scope else handle)
    for handle, scope in wanted:
        if handle in seen:
            continue
        out.append(f"{handle}:{scope}" if scope else handle)
    return {**action, "from": out}


def known_handles(ledger):
    """The ledger -> `{handle: media kind}`, the two things a citation needs."""
    out = {}
    for entry in ledger or []:
        if isinstance(entry, dict) and entry.get("handle"):
            out[str(entry["handle"])] = _entry_kind(entry)
    return out


def read(reply, ledger, strip=(), cast=()):
    """`(plan, action)` off a raw reply, or an `ActionError`."""
    plan, raw = parse(reply)
    return plan, validate(raw, ledger, strip, cast)


# ---- the one re-ask ---------------------------------------------------------

# What, in a user's message, plainly asks for something to be made. Deliberately
# short and literal: this list only ever *adds* a model call, so a word that
# fires on ordinary conversation costs a generation and hands the person a
# correction demanding a render they never asked for. Two words were dropped
# for exactly that. "still" is an adverb far more often than it is a noun —
# "why is it still dark?" is a question, not a request for a picture — and
# "shot" is as much praise for one as a request ("that shot was lovely"), while
# somebody who wants one nearly always says "picture" or "image" instead. A
# miss here costs nothing: the model chose the action already, and this only
# ever asks it to think again.
RENDER_WORDS = ("picture", "image", "clip", "video", "render", "draw",
                "make me", "show me")

NUDGE = ("that message asked for a picture or a clip, so answer with an "
         '"act": "render" action rather than a "say".')


def asks_for_render(text):
    """Whether the user plainly asked for something to be made.

    Whole words and their plurals, so "clip" and "clips" fire and "paperclip"
    does not. This is a hint for the one nudge above and never a decision on its
    own — the model still chooses the action, and a turn this reads wrong is one
    extra generation, not a render nobody asked for.
    """
    lowered = (text or "").lower()
    for word in RENDER_WORDS:
        if re.search(rf"(?<![a-z]){re.escape(word)}s?(?![a-z])", lowered):
            return True
    return False


def judge(reply, ledger, user_text, second=False, strip=(), cast=()):
    """One model reply -> what the room does with it.

    The whole protocol, as a function of the reply alone, so the route next door
    is a call site rather than a second copy of the rules:

    - `{"act": "render", "action": {...}, "say": ...}` — queue it.
    - `{"act": "say", "say": ...}` — show it and stop.
    - `{"act": "reask", "sentence": ...}` — ask the same model again, in the
      same job, with this sentence quoted. Never returned when `second` is set.

    Two things earn a re-ask. A reply that will not validate earns one because
    the error is mechanical and a model told exactly which field it got wrong
    usually gets it right the second time. And a `say` in answer to a message
    that plainly asked for a picture earns one, because ChatGPT's contract —
    do not ask for confirmation, just render — is the behaviour people expect
    and a small model asking "would you like me to generate that?" is the most
    common way this surface disappoints.

    On the second failure the model's own prose becomes the reply. It has now
    been asked twice; showing a person the sentence the model actually wrote is
    more use than a third round trip or an error where a bubble should be.
    """
    try:
        plan, action = read(reply, ledger, strip, cast)
    except ActionError as problem:
        if second:
            return {"act": ACT_SAY, "say": spoken(reply)}
        return {"act": "reask", "sentence": str(problem)}
    action = bind(action, user_text, known_handles(ledger))

    if action["act"] == ACT_SAY:
        if not second and asks_for_render(user_text):
            return {"act": "reask", "sentence": NUDGE}
        return {"act": ACT_SAY, "say": action["say"]}

    # A render with nothing said falls back to the plan line, which is prose the
    # model wrote about this very turn — a better bubble than silence, and one
    # that costs no extra tokens because it was generated either way.
    return {"act": ACT_RENDER, "action": action,
            "say": action["say"] or plan or ""}


# ---- what the model is told: the machine ------------------------------------

# The weight slot every family's turbo pill loads from. Required exactly when
# that pill is thrown, which is why `required_slots` is asked rather than told:
# `state.missingPreStageModels` requires whichever DiT the pill actually
# selects, `compile_prestage` resolves the same field, and a card that left the
# Turbo checkpoint out while the pre-stage's switch was on would pass the dry run and
# then be refused by `render_image.check` on the queue — the one thing the card
# and the dry run exist between them to prevent.
TURBO_SLOT = "turbo_model"


def required_slots(family, turbo=False):
    """Which of a family's weight slots must hold a file before it can render.

    The reading both weights popovers take, said once. A slot counts when the
    graph loads a file from it (`loads`) and the family does not declare it
    optional (`required`, absent meaning required, which is what every manifest
    written before that key existed needs) — that is `state.alwaysRequired`.

    `turbo` is whether the pre-stage's turbo switch loads the checkpoint, and it
    moves exactly one slot: the turbo checkpoint is what the render will load
    instead of the ordinary one, so with the switch thrown it is required and
    with it off it is a file nobody needs. A family whose turbo pill is a LoRA
    rather than a checkpoint declares no such slot and nothing changes.

    The routed checkpoints stay out either way, because they are a choice rather
    than a component: one of them on disk is already enough to render something,
    so they come back separately and refusing a machine that has Ref2VA but not
    FL2VA would be refusing a machine that works.
    """
    always, routed = [], []
    for slot in family.get("weights") or []:
        if not slot.get("loads") or slot.get("required") is False:
            continue
        if slot.get("routed"):
            routed.append(slot)
        elif slot.get("id") != TURBO_SLOT or turbo:
            always.append(slot)
    return always, routed


def missing_weights(family, picked, available, turbo=False):
    """Which of `family`'s required slots have no file, as their popover titles.

    `picked` is this family's block of `settings["weights"]` and `available` is
    `models.available()`. Both are asked, not just the first: a pick is a
    filename somebody chose once, and a file deleted since is a render that
    fails at the loader with the node's own message instead of here, where the
    model could have said so before spending the turn. `turbo` is the
    pre-stage's switch — see `required_slots`.
    """
    listings = (available or {}).get("by_folder") or {}

    def filled(slot):
        name = (picked or {}).get(slot.get("id"))
        if not isinstance(name, str) or not name.strip():
            return False
        files = listings.get(slot.get("folder"))
        # An unknown folder is not evidence of absence — a family whose folder
        # this install does not register would otherwise read as never ready.
        return name.strip() in files if files is not None else True

    always, routed = required_slots(family, turbo)
    missing = [slot["title"] for slot in always if not filled(slot)]
    if routed and not any(filled(slot) for slot in routed):
        missing += [slot["title"] for slot in routed]
    return missing


def guess_weights(family, available):
    """A file for each of `family`'s slots that exactly one name on disk fits.

    The frontend's own guess (`state.guessModels`, `guessPreStageModels`) said
    once more, here, because the room's first run asks the question before any
    node exists to ask it: which families could render right now with what is
    in the model folders? A slot is filled when exactly one file in its folder
    carries one of the manifest's `hints` and none of its `avoid` patterns —
    two candidates is a question for the person, not a coin toss — and a slot
    with no hints is never guessed.
    """
    listings = (available or {}).get("by_folder") or {}
    picks = {}
    for slot in family.get("weights") or []:
        hints = [needle.lower() for needle in slot.get("hints") or []]
        if not hints:
            continue
        avoid = [re.compile(pattern, re.IGNORECASE) for pattern in slot.get("avoid") or []]
        matched = [name for name in listings.get(slot.get("folder")) or []
                   if any(needle in name.lower() for needle in hints)
                   and not any(pattern.search(name) for pattern in avoid)]
        if len(matched) == 1:
            picks[slot["id"]] = matched[0]
    return picks


def setup_report(catalog, available, weights):
    """Every family as the room's first run reads it: `[{id, label, produces,
    picks, missing, turbo, slots}]`.

    `picks` is what the family would render with — this machine's remembered
    files where it has any, the guess above filling whatever those leave empty —
    and `missing` is what would still refuse a render, by popover title, so the
    room can say "everything Flux 2 Klein needs is here" or "2 of 4" without a
    second reading of the same table. `turbo` is whether the turbo checkpoint
    is among the picks, which is what decides whether the switch can be offered.
    `slots` carries each slot's folder listing, so choosing by hand needs no
    second request.
    """
    listings = (available or {}).get("by_folder") or {}
    report = []
    for family in (catalog or {}).get("families") or []:
        remembered = {name: value for name, value in ((weights or {}).get(family["id"]) or {}).items()
                      if isinstance(value, str) and value.strip()}
        picks = {**guess_weights(family, available), **remembered}
        always, routed = required_slots(family)
        required = {slot["id"] for slot in always + routed}
        report.append({
            "id": family["id"],
            "label": family.get("label", family["id"]),
            "produces": list(family.get("produces") or []),
            "picks": picks,
            "missing": missing_weights(family, picks, available),
            "turbo": bool(picks.get(TURBO_SLOT)),
            "slots": [{
                "id": slot["id"],
                "title": slot.get("title") or slot.get("label") or slot["id"],
                "required": slot["id"] in required,
                "options": list(listings.get(slot.get("folder")) or []),
            } for slot in family.get("weights") or [] if slot.get("loads")],
        })
    return report


def ref_limit(family):
    """How many pictures may be cited for this family, or None where it is silent.

    Two spellings, because a manifest answers this question in whichever half of
    itself owns it. A video family declares a whole reference block — what each
    kind of file may be taken for, and how many of each — and the picture cap is
    `reference.max.image`, the grammar's own number and the one
    `compile.plan_references` refuses against. A still family has no such block:
    its pictures go into the encoder's slots, so the cap belongs beside the
    prompt as `prompt.max_refs`. Read in one place rather than served twice,
    which would put one number in two keys of one payload.

    None and 0 are different answers: 0 is a family saying its weights read no
    attached picture (Ideogram 4), and None is a family that says nothing.
    """
    limit = ((family.get("reference") or {}).get("max") or {}).get("image")
    if limit is None:
        limit = (family.get("prompt") or {}).get("max_refs")
    return limit if isinstance(limit, int) and not isinstance(limit, bool) else None


def needs_adapter(family):
    """Whether this family reads references only through a LoRA in its stack.

    `capabilities.refs.needs_lora` — Krea 2's arrangement, and the one thing in
    the pre-stage blob this room cannot fill: the adapter is an entry in the
    LoRA stack, and the chat has no stack and no way to offer one.
    """
    return bool(((family.get("capabilities") or {}).get("refs") or {}).get("needs_lora"))


def takes_refs(family):
    """Whether a picture cited in `from` can be handed to this family at all.

    Two manifest keys, never a family id. Both ways of answering no end the same
    way — `compile_prestage` refuses the render, with `REFS_REFUSAL` for weights
    that read nothing and with `check_refs` for weights whose adapter is
    missing — so the room has to know before it cites rather than after.
    """
    return bool(ref_limit(family)) and not needs_adapter(family)


def refs_refusal(family, instead=()):
    """Why this family cannot be given a picture, and what to do instead.

    The room's own sentence rather than the compiler's. Krea 2's is true — "add
    a reference LoRA to the stack" — and it is about a control that exists on
    the node and not in this room, so relaying it would be telling somebody to
    press something they cannot see. `instead` is the labels of the still
    families that do read pictures, which is what they can actually change.
    """
    label = family.get("label") or "this family"
    if needs_adapter(family):
        why = ("reads an attached picture only through an adapter in the "
               "pre-stage's LoRA stack, and this room has no stack to put one in")
    else:
        why = "reads no attached picture at all"
    where = (f" {listed(list(instead))} do read pictures — switch the still "
             f"family to one of those." if instead else "")
    return f"{label} draws from words alone: it {why}.{where}"


def refs_families(catalog):
    """The labels of the still families that read pictures outright, in order.

    The families that make *nothing but* stills, which is the set the room's
    still pill offers — a video family's still branch is a video generation
    under a blob of its own and the room does not drive it, so naming one here
    would be pointing at a setting that is not on offer.
    """
    return [family["label"] for family in (catalog or {}).get("families") or []
            if list(family.get("produces") or ()) == ["still"] and takes_refs(family)]


def still_pictures(family, catalog):
    """What the rail tells the blob patch about this still family's pictures.

    The whole of the catalog's answer, reduced to the two things `still_piece`
    needs: whether a citation may be honoured, and the sentence if it may not.
    Here rather than in the route so the bench reaches the same answer the room
    does — a bench that refused on different words would be tuning the prompt
    against a machine nobody has. See `DEFAULT_STILL_PICTURES`.
    """
    if takes_refs(family):
        return {"takes": True, "refusal": ""}
    return {"takes": False, "refusal": refs_refusal(family, refs_families(catalog))}


def _find(catalog, family_id):
    """One family's manifest out of the families route's payload, or None."""
    for family in (catalog or {}).get("families") or []:
        if family.get("id") == family_id:
            return family
    return None


def _aspects(family):
    return list(((family.get("canvas") or {}).get("aspects") or {}))


def _durations(family):
    """The duration sentence for a video family, off its canvas declaration.

    Three numbers matter to somebody writing `seconds`: what the compiler will
    accept, what the checkpoint was trained on, and the grid the answer is
    snapped to. The grid is frames per step over the frame rate, because the
    frame counts a family packs to are its real constraint and seconds are the
    unit the action speaks in.
    """
    canvas = family.get("canvas") or {}
    frames = canvas.get("frames") or {}
    fps = float((canvas.get("fps") or {}).get("value") or 24)
    step = float(frames.get("step") or 1) / fps
    low, high = frames.get("min_seconds"), frames.get("max_seconds")
    trained = (float(frames.get("trained_min") or 0) / fps,
               float(frames.get("trained_max") or 0) / fps)
    said = f"{low:g} to {high:g} seconds"
    if trained[1]:
        said += f", trained on {trained[0]:.0f} to {trained[1]:.0f}"
    return f"{said}, snapped to a {step:.2f}s grid"


def machine_card(still_family, video_family, catalog, available, weights,
                 turbo=False):
    """What this machine can make, in about a hundred and fifty tokens.

    The join nothing in the pack did before: the families route says what each
    family is and what its canvas allows, `models.available()` says what is on
    this disk, and `settings["weights"]` says which of those files this machine
    picked. Three payloads that each answer a third of "can I render this right
    now", and the model needs the whole answer in one short block.

    Pure, and given everything it reads, so a suite can feed it a machine with
    no weights on it and read the sentence a user would actually be told. The
    route does the joining and holds the result until the picks change. `turbo`
    is the pre-stage's switch, read off its blob (`still_turbo_checkpoint`),
    and reaches the still family alone: a video family's turbo is a LoRA in
    the stack, never a file the card has to count.

    The aspect table is printed once where both families agree on it, which on
    this pack's families they always do — eleven names twice is a fifth of the
    card's whole budget spent saying the same thing.
    """
    still = _find(catalog, still_family)
    video = _find(catalog, video_family)
    lines = ["WHAT THIS MACHINE MAKES"]

    if still:
        lines.append(_sentences(f'"still" is {still["label"]}: one picture.',
                                _attaches(still)))
    if video:
        sound = " with its own sound" if (video.get("capabilities") or {}).get("audio") else ""
        lines.append(_sentences(
            f'"video" is {video["label"]}: one shot{sound}, {_durations(video)}.',
            'A still in "from" is the clip\'s first frame; anything else is a '
            "reference.",
            _attaches(video)))

    shapes = [_aspects(family) for family in (still, video) if family]
    if shapes and all(shape == shapes[0] for shape in shapes):
        lines.append("Aspects, either kind: " + ", ".join(shapes[0]) + ".")
    else:
        for name, family in (("still", still), ("video", video)):
            if family:
                lines.append(f"Aspects for {name}: " + ", ".join(_aspects(family)) + ".")

    for name, family in (("still", still), ("video", video)):
        if not family:
            lines.append(f"There is no {name} family set up, so nothing can be "
                         f"made of that kind — say so.")
            continue
        # Memory over the folder's own guess — the join `setup_report` and
        # the render route both take, so the three cannot disagree.
        picked = {**guess_weights(family, available),
                  **((weights or {}).get(family["id"]) or {})}
        gone = missing_weights(family, picked, available,
                               turbo=turbo and name == "still")
        if gone:
            # The slots are named by their popover titles, which are what the
            # person would have to go and click — "Video VAE", not "vae". They
            # are proper names of controls, so they keep their capitals inside
            # the sentence rather than being lowercased into prose.
            lines.append(
                f"{family['label']} is not ready: no file is picked for "
                f"{listed(gone)}. Say so instead of asking for a {name}.")
    return "\n".join(lines)


def _sentences(*parts):
    """One line out of the sentences that had something to say."""
    return " ".join(part for part in parts if part)


def _attaches(family):
    """What this family does with the handles cited in `from`, in one sentence.

    A count where it reads pictures, a plain refusal where it cannot be given
    one at all, and nothing where the family has not declared a limit. The model
    has to know this before it cites something: afterwards the only thing left
    is a refusal in the bubble where a picture should be, and on the default
    still family that would be every "make it bluer" in the room.
    """
    limit = ref_limit(family)
    if limit is None:
        return ""
    if not takes_refs(family):
        return ('It cannot be given the pictures in "from" — cite nothing '
                "there, and say so if you are asked to change a picture.")
    said = f'Up to {limit} picture{"s" if limit != 1 else ""} may be cited in "from".'
    if ((family.get("capabilities") or {}).get("refs") or {}).get("edits_first"):
        # `compile_prestage` starts the render from the first reference on these
        # families, so citing the thing being changed first is the difference
        # between an edit of it and a new picture beside it — eight words, and
        # they are what "make her coat white" depends on.
        said += " The first is the picture being changed."
    return said


def listed(items):
    """`a`, `a and b`, `a, b and c` — a sentence's worth of a list."""
    items = list(items)
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


# ---- what the model is told: the ledger -------------------------------------

# How much of a description one ledger line carries. Long enough that "the fox
# one" is findable, short enough that twenty renders do not crowd out the
# conversation they came from.
LEDGER_TEXT = 110


def ledger_line(entry):
    """One made thing, as `img-3 · still · 16:9 · turn 4 · "a fox at dusk"`.

    This is the whole of what the model knows about a render: an id, what kind
    of thing it is, its shape, when it happened and what it was of. Pixels never
    enter the text context — an edit is a fresh prompt plus the id of the thing
    being edited, which is the arrangement ChatGPT's `referenced_image_ids`
    settled on and the reason the id has to be short and stable.

    Fields with nothing to say are left out rather than printed empty, so an
    uploaded file with no words reads as a line about a file rather than a line
    about a render that lost its prompt.
    """
    entry = entry or {}
    parts = [str(entry.get("handle") or "?")]
    for key in ("kind", "aspect"):
        if entry.get(key):
            parts.append(str(entry[key]))
    turn = entry.get("turn")
    if isinstance(turn, (int, float)) and not isinstance(turn, bool):
        parts.append(f"turn {int(turn)}")
    text = " ".join(str(entry.get("text") or "").split())
    if text:
        if len(text) > LEDGER_TEXT:
            text = text[:LEDGER_TEXT].rsplit(" ", 1)[0] + "…"
        parts.append(f'"{text}"')
    return " · ".join(parts)


def ledger_block(ledger):
    """Every made thing, one per line, oldest first, the latest of each kind
    marked.

    The room's own ledger and nothing else: what the conversation made and
    what was attached to it. There is no node in this list — a chat renders
    from its own piece, and a picture that is not in the ledger is not a
    picture the model can reach.

    The last still and the last clip wear a mark, because "it" and "that"
    nearly always mean the newest thing, and a model reading twelve lines
    otherwise has to work that out from the turn numbers.
    """
    entries = [entry for entry in ledger or []
               if isinstance(entry, dict) and entry.get("handle")]
    if not entries:
        return "WHAT HAS BEEN MADE\nNothing yet."
    latest = {}
    for entry in entries:
        latest[entry.get("kind")] = entry["handle"]
    marks = {"still": "the latest picture", "clip": "the latest clip"}
    lines = []
    for entry in entries:
        line = ledger_line(entry)
        kind = entry.get("kind")
        if kind in marks and latest.get(kind) == entry["handle"]:
            line += f" — {marks[kind]}"
        lines.append(line)
    return "\n".join(['WHAT HAS BEEN MADE — cite these by handle in "from"'] + lines)


def strip_block(strip):
    """The clips joined so far, as one line: `vid-1 (5 s) → vid-2 (4 s)`.

    `strip` is `[{handle, seconds}]` in strip order — the room's reading of
    the piece it has been building, sent with every turn. Nothing when there
    is no strip: the rule for a first clip is already in the system prompt,
    and a block that says "nothing" is a block that costs tokens to say it.
    """
    shots = [entry for entry in strip or []
             if isinstance(entry, dict) and entry.get("handle")]
    if not shots:
        return ""
    said = " → ".join(
        f"{entry['handle']} ({float(entry['seconds']):g} s)" if entry.get("seconds")
        else str(entry["handle"]) for entry in shots)
    return ('THE STRIP — these clips are joined, in this order. A next shot '
            f'goes "after" the last one; a redo "replaces" one.\n{said}')


def cast_line(member):
    """One member: `@anna · person · from img-1, img-3 · "woman, thirties"`."""
    parts = [f"@{member.get('name')}", str(member.get("takes") or "person")]
    sources = [str(h) for h in member.get("from") or []]
    if sources:
        parts.append("from " + ", ".join(sources))
    text = " ".join(str(member.get("description") or "").split())
    if text:
        if len(text) > LEDGER_TEXT:
            text = text[:LEDGER_TEXT].rsplit(" ", 1)[0] + "…"
        parts.append(f'"{text}"')
    return " · ".join(parts)


def cast_block(cast):
    """Who is on the piece's cast, one per line.

    The members are the piece's — brought in with the node's own `@` menu —
    and are cited by name in the prompt and never described again: the
    definition is theirs, and the compiler writes it. So the block says what
    each is built from and what they look like, which is what the model needs
    to know to write around them rather than about them.
    """
    members = [m for m in cast or [] if isinstance(m, dict) and m.get("name")]
    if not members:
        return ""
    lines = ['THE CAST — cite them by name in "prompt" (@anna), exactly as the '
             'person does. Never describe them again and never put their own '
             'pictures in "from".']
    return "\n".join(lines + [cast_line(m) for m in members])


# ---- what the model is told: the conversation -------------------------------

# How much of the conversation rides along. Five exchanges is what "same but at
# night" needs to be a delta on a known prompt, and the character budget is the
# backstop for five exchanges that happen to be enormous — a pasted paragraph
# and a long rewrite are both legitimate and both blow a token budget a count
# alone cannot see.
MAX_EXCHANGES = 5
MAX_HISTORY_CHARS = 4000


def _rendered(message):
    """One stored turn as the model will read it back."""
    if message.get("role") == "user":
        return "user: " + " ".join(str(message.get("text") or "").split())
    action = message.get("action")
    if isinstance(action, dict):
        # The action rather than the sentence: what the model has to be able to
        # do is write a variation on a prompt it wrote before, and the prompt is
        # in the action. Compact, and only the fields that were set — a wall of
        # nulls is the same information at three times the length.
        kept = {key: action[key] for key in FIELDS
                if action.get(key) not in (None, "", [])}
        line = "you: " + json.dumps(kept, ensure_ascii=False)
        # The handle the render landed under, so "it" on the next line has a
        # name: the ledger says what exists, this says which of it was just
        # made. A render that failed or was cut says so instead.
        made = message.get("made")
        if made:
            line += f" → made {made}"
        elif message.get("made") is None and message.get("failed"):
            line += " → nothing was made"
        return line
    return "you: " + " ".join(str(message.get("say") or message.get("text") or "").split())


def trim(messages, exchanges=MAX_EXCHANGES, chars=MAX_HISTORY_CHARS):
    """The tail of the conversation that fits the budget, oldest dropped first.

    An exchange is a user turn and whatever followed it, so the cut always lands
    on a user turn and the model never reads an answer whose question is gone.
    The count is applied first and the character budget second, because the
    count is the rule and the budget is the backstop.
    """
    messages = [m for m in messages or [] if isinstance(m, dict)]
    starts = [at for at, message in enumerate(messages) if message.get("role") == "user"]
    if len(starts) > exchanges:
        messages = messages[starts[-exchanges]:]
        starts = starts[-exchanges:]

    while len(starts) > 1 and sum(len(_rendered(m)) + 1 for m in messages) > chars:
        cut = starts[1]
        messages = messages[cut:]
        starts = [at - cut for at in starts[1:]]
    return messages


def context(messages, ledger, card, exchanges=MAX_EXCHANGES, strip=(), cast=()):
    """The one user message: the machine, the ledger, then the conversation.

    Three blocks in a fixed order that ends with the freshest thing, which is
    the order `families/h3/refine.py` puts its own rules in and for the same
    reason: on a small model whatever was read last is what it is still holding
    when it starts writing. So the standing facts lead, what exists comes next,
    and the turn being answered is the last line before the instruction to
    answer it.

    One string rather than a message list because both refiner backends take one
    system prompt and one user turn, and because the harness is what carries the
    state — a real multi-turn transcript would be asking a 4B model to do the
    one thing the research says it cannot.
    """
    kept = trim(messages, exchanges=exchanges)
    blocks = [card, ledger_block(ledger), strip_block(strip), cast_block(cast)]
    if kept:
        blocks.append("\n".join(["THE CONVERSATION"] + [_rendered(m) for m in kept]))
    blocks.append("Answer the last line above: one line of plan, then the action "
                  "as JSON in a ``` fence, and nothing after it.")
    return "\n\n".join(block for block in blocks if block)


def reask(message, reply, sentence):
    """The same message again, with what went wrong quoted onto the end.

    A second call inside the same job rather than a round trip to the browser:
    the room asked one question and is owed one answer, and a correction the
    person has to watch happen is a correction that reads as a failure. The
    model's own reply is included because it has none of its own context — every
    turn is a fresh single decision, so without it the correction is about text
    the model cannot see.
    """
    return (f"{message}\n\nYour reply was:\n{spoken(reply)[:MAX_SAY]}\n\n"
            f"That cannot be used: {sentence}\nAnswer again, the same way: one "
            f"line of plan, then the corrected action as JSON in a ``` fence.")


# ---- the blob the action becomes --------------------------------------------

# What a clip runs for when the action does not say and the rail has no opinion.
# The Creator node's own fresh-card default, which is the number a person who
# never touched the duration pill would have rendered on.
DEFAULT_SECONDS = 6

# What the route stamps onto the rail about the still family's references, and
# what a rail that says nothing means. `takes` is `takes_refs` of that family and
# `refusal` is `refs_refusal` of it with the alternatives already named — both
# are the catalog's answers, and the catalog is the route's.
DEFAULT_STILL_PICTURES = {"takes": True, "refusal": ""}


def _entry_kind(entry):
    """What kind of file a ledger entry is: its own word, else its prefix.

    The room's own lines say `still`, `clip` or `sound`; a line for one of the
    piece's shelf references (`ref-2`) says the asset's `image`/`video`/`audio`.
    The prefix is the fallback, and the refusal for a handle nobody can read.
    """
    kind = LEDGER_KINDS.get(str(entry.get("kind") or "").lower())
    return kind or _media_kind(entry.get("handle"))


# The room's own prefixes, and the node's. The room mints `pic`, `clip` and
# `snd` — a namespace apart from the row's `img`/`vid`/`aud`, which a one-shot
# piece's cast files land under (`state.collapsePool`), since both lists meet
# in the model's ledger. The node's are read too, for a shelf line.
PREFIXES = {"pic": "image", "clip": "video", "snd": "audio",
            "img": "image", "vid": "video", "aud": "audio"}


def _media_kind(handle):
    """What kind of file a handle names — the prefix, as everywhere else here."""
    prefix = str(handle).split("-", 1)[0]
    kind = PREFIXES.get(prefix)
    if kind is None:
        raise ActionError(
            f"@{handle} is not a handle this room can attach — the ledger's "
            f"handles are pic-N, clip-N and snd-N.")
    return kind


def _cited(action, ledger, handles=None):
    """`from` resolved against the ledger -> `[(handle, kind, filename, scope)]`.

    `handles` stands in for the action's own list where the caller has a list
    of its own to resolve — a cast member's sources, say.

    Raises rather than dropping. A handle with no file behind it is a ledger the
    browser and the server disagree about, and a render that quietly went out
    without the picture it was supposed to be of is the failure this whole pack
    is built to avoid.
    """
    entries = {str(entry.get("handle")): entry for entry in ledger or []
               if isinstance(entry, dict) and entry.get("handle")}
    out = []
    items = action.get("from") or [] if handles is None else handles
    for item in items:
        handle, scope = split_handle(item)
        entry = entries.get(handle)
        if entry is None:
            raise ActionError(f"@{handle} is not in the ledger.")
        filename = str(entry.get("filename") or "").strip()
        if not filename:
            raise ActionError(
                f"@{handle} is in the ledger but has no file behind it yet, so "
                f"there is nothing to attach.")
        out.append((handle, _entry_kind(entry), filename, scope))
    return out


def _cited_members(prompt, cast):
    """The members this prompt names, in cast order. `cast` is the room's
    reading of the piece's subjects: `{name, takes, from, description}`."""
    named = {word.lower() for word in CITE_RE.findall(prompt) if "-" not in word}
    return [m for m in cast or [] if isinstance(m, dict)
            and str(m.get("name") or "").lower() in named]


def _canvas(action, rail, kind):
    """The shape and size fields, where anybody has an opinion about them.

    Left out of the blob entirely where nobody has. Both compilers read these as
    `data.get("aspect", <the family's own>)`, so an absent key is the family's
    default said by the family — and a default written here instead would be
    this module's third copy of a number two compilers already own.

    The short edge is per kind — `still_edge` for a picture, `video_edge` for a
    clip — because the two are not one number: a still is drawn at 1024 or more
    on every family that draws one, and a clip at 768 is already the trained
    size. A rail saved before the split carries one `short_edge`, read for both.
    """
    canvas = {}
    rail = rail or {}
    aspect = action.get("aspect") or rail.get("aspect")
    if aspect:
        canvas["aspect"] = aspect
    edge = rail.get(f"{kind}_edge")
    if edge is None:
        edge = rail.get("short_edge")
    if isinstance(edge, (int, float)) and not isinstance(edge, bool):
        canvas["short_edge"] = int(edge)
    return canvas


# ---- the pieces --------------------------------------------------------------
#
# A chat render is the node on the canvas, asked for this prompt in this shape.
# The room sends the node's own blob as the `base` — its sampler row, its turbo
# switch and stack, its weights, its passes — and the two builders below put
# one shot on it. Nothing about *how* the piece samples is decided here: the
# room has no settings of its own beyond the shape and the two sizes, so what
# the node would render is what the room renders, and the gear in the room is
# the node's row drawn a second time over the same blob.


def still_piece(action, ledger, rail, base=None, cast=None):
    """A `render` of a still -> the `prestage_data` the PreStage node runs.

    Over `base`, the pre-stage's own blob: everything on it stands — the LoRA
    stack (the turbo LoRA included), the turbo block, the sampler row, the
    weights — and the room's turn writes the prompt, the references and the
    shape over it. Without a base (the tests' bare call), the shared image
    shape `compile_image.compile_prestage` reads, at its defaults.

    Every cited handle becomes a reference, in the order it was cited, which is
    the order the encoder labels them in — so under an edit family (Qwen Image
    Edit, Flux 2 Klein) the first one is the picture being edited and this does
    nothing special to make that true. `compile_image.compile_prestage` promotes
    a first reference to the init at denoise 1 on exactly those families, which
    is where that rule belongs and where it already is. The init the node held
    is cleared for the same reason: the room's picture is the citation, not
    whatever the node was last painting over.

    A family that cannot be handed a picture refuses one here, in the room's own
    words, before the compiler refuses it in words about the node's LoRA stack.
    The rail carries that as a flag and the labels to point at instead, because
    it is the catalog's answer and the route is the half with the catalog — see
    `takes_refs` and `refs_refusal`.

    `models` is left to the route: which files are on this disk is the
    machine's business and this module has no disk. The rail's arch is the
    pre-stage pill's name for a family — see `registry.STILL_ARCHES` — and the
    route stamps it on, because the mapping is the registry's and the rail
    arrives naming families.
    """
    rail = rail or {}
    arch = rail.get("still_arch")
    if not arch:
        raise ActionError("this room has no still model set up yet.")

    cited = _cited(action, ledger)
    pictures = {**DEFAULT_STILL_PICTURES, **(rail.get("still_pictures") or {})}

    # A member in a still. The image compilers have no cast: a picture has
    # one prompt and its references, so `@anna` becomes her first picture
    # cited where her name stood, with her description after it, or her
    # description alone where the family reads no picture — and a member with
    # neither is a name the picture could not draw.
    prompt = action["prompt"]
    for member in _cited_members(prompt, cast):
        files = _cited(None, ledger, member.get("from") or [])
        picture = next((f for f in files if f[1] == "image"), None)
        text = member.get("description") or ""
        if picture and pictures.get("takes"):
            handle = picture[0]
            if handle not in {c[0] for c in cited}:
                cited.append(picture)
            stood = f"@{handle}" + (f" ({text})" if text else "")
        elif text:
            stood = text
        else:
            raise ActionError(
                f"@{member['name']} has no picture a still can be given here "
                f"and no description — describe them, or cite one of their "
                f"pictures in words.")
        prompt = re.sub(rf"@{re.escape(member['name'])}\b", stood, prompt)

    if cited and not pictures.get("takes"):
        raise ActionError(pictures.get("refusal") or
                          "this still family cannot be given a picture.")

    refs = []
    for handle, kind, filename, scope in cited:
        if kind != "image":
            raise ActionError(
                f"@{handle} is a {kind} and a still can only be given pictures.")
        if scope in (ROLE_START, ROLE_END):
            raise ActionError(
                f"@{handle}:{scope} — a picture has no start or end frame; cite "
                f"it plain, or ask for a clip.")
        refs.append({"handle": handle, "filename": filename,
                     **({"takes": scope} if scope and scope != ROLE_REF else {})})

    piece = json.loads(json.dumps(base)) if isinstance(base, dict) else {}
    piece.update({
        "version": piece.get("version") or 1,
        "arch": arch,
        "prompt": prompt,
        "init": None,
        "refs": refs,
        "loras": piece.get("loras") or [],
        "turbo": piece.get("turbo") or {},
        "models": piece.get("models") or {},
        **_canvas(action, rail, "still"),
    })
    return piece


def default_feather(family):
    """The blend a chat seam opens with: the family's medium width, the same
    third-of-the-grid `state.continuingSegment` picks for a card added on the
    node. The number is the family's, so it is asked for rather than written."""
    rules = registry.RULES.get(family)
    if rules is None:
        return 1
    grid = canvas.feather_grid(rules)
    return grid[2] if len(grid) > 2 else grid[-1]


# The key a strip card carries its ledger handle under. The room's own, and
# kept beside `card_id` and `stamp` on the segment: the compiler reads none of
# the three, and it is what lets "after vid-2" find the card.
STRIP_KEY = "chat_handle"


def _kept(strip, action):
    """The cards of the strip that stay in front of this shot, held.

    `after` keeps the strip up to and including that shot; `replaces` keeps
    what is in front of it; neither keeps nothing, and the clip is a piece of
    one shot. What is cut is cut: a shot made after the one named was an
    answer to it, the same rule the transcript's own edit-and-resend keeps.
    Every kept card plays its take, so a card without one — a render that was
    cut, or never landed — is refused by name before the compiler refuses it
    as a held card with nothing to play.
    """
    handle = action.get("after") or action.get("replaces")
    if not handle:
        return []
    cards = [c for c in strip or [] if isinstance(c, dict)]
    at = next((i for i, c in enumerate(cards) if c.get(STRIP_KEY) == handle), None)
    if at is None:
        raise ActionError(f"@{handle} is not a shot on the strip.")
    kept = cards[:at + 1] if action.get("after") else cards[:at]
    out = []
    for card in kept:
        take = card.get("take") if isinstance(card.get("take"), dict) else {}
        if not str(take.get("filename") or "").strip():
            raise ActionError(
                f"@{card.get(STRIP_KEY)} has no finished take to play in front "
                f"of this shot — it was cut or never landed.")
        out.append({**json.loads(json.dumps(card)), "hold": True})
    return out


def _pool(piece):
    """The piece's reference pool: the files its cast is built from.

    The chat's piece has no shot row of its own — every shot is the room's
    card — so the pool is the whole shelf, and it holds nothing the model is
    told about: a member's files come into a shot through the member's name,
    which is the citation the compiler expands.
    """
    return [dict(a) for a in piece.get("assets") or []
            if isinstance(a, dict) and a.get("handle")]


def cast_entries(piece):
    """The piece's subjects as the room's cast list: `{name, takes, from,
    description}` — the four things the model is told, off the blob the
    node wrote. Every file behind them counts as theirs (`from`, motion,
    voice, the clip they stand in), which is what keeps any of them from
    being made a keyframe by the model."""
    out = []
    for subject in (piece or {}).get("subjects") or []:
        if not isinstance(subject, dict) or not subject.get("handle"):
            continue
        files = list(subject.get("from") or [])
        for key in ("motion", "replaces"):
            value = subject.get(key)
            files += [value] if isinstance(value, str) else list(value or [])
        if subject.get("voice"):
            files.append(subject["voice"])
        out.append({"name": subject["handle"], "takes": subject.get("takes") or "person",
                    "from": [str(h) for h in files if h],
                    "description": subject.get("description") or ""})
    return out


def video_piece(action, ledger, rail, base=None, strip=None):
    """A `render` of a clip -> the `creator_data` piece the Creator node runs.

    Over `base`, the chat's own piece: its cast and the pool their files are
    on, its LoRA stack (the family's pins), its turbo block and its sampler
    row — the room assembles that and nothing on the canvas reaches it. The
    strip is the room's: the shots it has joined so far, each held with its
    take, and this shot on the end of them (`after`) or in one's place
    (`replaces`) — or, with neither, a piece of one shot. Only the new card
    is sampled; the kept ones are spliced in as the footage they already are,
    which is what a held take is for, and the seam in front of the new card
    opens as a card added on the node would: live on both tracks, with the
    family's medium blend.

    The cast is the piece's own. `@anna` in the chat's prompt is the same
    citation it is in the node's box — `compile.cited_pool` brings her files
    off the pool into this shot, and the compiler writes her definition — so
    nothing here builds a subject. The chat's prompt is the segment's prompt
    as typed, and the Refine pass is a switch in the rail rather than a step.

    Where a cited picture goes is said on its handle or left to one rule.
    `:start` and `:end` are the shot's keyframes, one of each; `:ref` and
    every scope (`:style`, `:person`, …) make a reference; a picture cited
    plain opens the shot if nothing else does, and rides as a reference
    otherwise. A clip or a sound is a reference whatever it wears.
    """
    rail = rail or {}
    family = rail.get("video_family")
    if not family:
        raise ActionError("this room has no video model set up yet.")

    piece = json.loads(json.dumps(base)) if isinstance(base, dict) else {}
    assets, opened, closed = [], False, False
    for handle, kind, filename, scope in _cited(action, ledger):
        role, takes = "reference", None
        if scope in (ROLE_START, ROLE_END):
            if kind != "image":
                raise ActionError(f"@{handle} is a {kind}; only a picture can be a "
                                  f"{'start' if scope == ROLE_START else 'end'} frame.")
            if scope == ROLE_START:
                if opened:
                    raise ActionError("two pictures are cited as the start frame; a "
                                      "shot opens on one.")
                role, opened = "first_frame", True
            else:
                if closed:
                    raise ActionError("two pictures are cited as the end frame; a "
                                      "shot closes on one.")
                role, closed = "last_frame", True
        elif scope == ROLE_REF or scope:
            takes = None if scope == ROLE_REF else scope
        elif kind == "image" and not opened:
            # The rule a person never has to say: the first picture cited
            # plain is what the shot opens on. `:ref` is how to say otherwise.
            role, opened = "first_frame", True
        asset = {"handle": handle, "kind": kind, "role": role, "filename": filename}
        if takes:
            asset["takes"] = takes
        assets.append(asset)

    kept = _kept(strip, action)
    card = {
        "prompt": action["prompt"],
        "assets": assets,
        "loras": [],
        "duration_s": action.get("seconds") or rail.get("seconds") or DEFAULT_SECONDS,
        "checkpoint": "auto",
    }
    if kept:
        card.update({"continue": True, "continue_audio": True,
                     "feather": default_feather(family)})

    piece.update({
        "version": piece.get("version") or 2,
        # The piece's standing description is the node's and stays; a bare
        # piece has nothing to put in it, since everything written is on the card.
        "prompt": piece.get("prompt") or "",
        "family": family,
        "models": piece.get("models") or {},
        "loras": piece.get("loras") or [],
        "turbo": piece.get("turbo") or {"on": False, "lora": None},
        "subjects": [s for s in piece.get("subjects") or [] if isinstance(s, dict)],
        "assets": _pool(piece),
        **_canvas(action, rail, "video"),
        "segments": kept + [card],
    })
    return piece


def piece_of(action, ledger, rail, base=None, strip=None, cast=None):
    """The blob for whichever kind the action asked for, with its node's name.

    `(node id, the blob's widget name, the blob)` — the three things the route
    needs to build a one-node prompt, answered together so the mapping from
    `kind` to node lives in one place rather than in two branches of a route.
    """
    if action.get("kind") == KIND_STILL:
        return ("MiniMaxH3PreStage", "prestage_data",
                still_piece(action, ledger, rail, base, cast))
    return ("MiniMaxH3Creator", "creator_data",
            video_piece(action, ledger, rail, base, strip))


def still_turbo_checkpoint(piece):
    """Whether a pre-stage blob's turbo switch loads the family's Turbo
    checkpoint — thrown, with no LoRA under it — which is when `required_slots`
    has to count that slot. `piece["turbo"]` is per arch, as the pre-stage
    writes it; a block with `on` at the top is one written before that."""
    piece = piece or {}
    turbo = piece.get("turbo") or {}
    block = turbo if isinstance(turbo.get("on"), bool) else turbo.get(piece.get("arch")) or {}
    return bool(block.get("on")) and not block.get("lora")


# ---- the Refine switch --------------------------------------------------------

# What the room sends about the refiner when the rail's Refine switch is on, and
# what `refine_routes._run` reads. The same nine fields the Refine button's
# request carries, spelled once here and once in `refine.js`'s `refineRequest`,
# which `tests/test_chat_mirror.py` holds together.
REFINE_FIELDS = ("model", "backend", "temperature", "seed", "language",
                 "max_tokens", "skill", "skill_mode", "eject")


def refine_request(block, piece):
    """The refine request for the chat's piece -> the body `refine_routes._run` takes.

    The Creator's own target: a piece of one shot is one card, and `creator` is
    how the refine route has always been asked for exactly that card. The
    template is left to the route — `auto` is the derived mode, and a chat
    render has nobody pinning one — and every other field is the refiner's own
    setting, passed through by name so a setting added there is a line here
    rather than a silent drop.
    """
    block = block or {}
    request = {"kind": "creator", "data": piece, "index": 0}
    for field in REFINE_FIELDS:
        if field in block:
            request[field] = block[field]
    return request


def refined_field(result, prompt, model):
    """One refine result -> the `refined` block a segment carries.

    The shape `refine.js`'s `RefinePanel.apply` writes, so the compiler reads a
    chat render's rewrite exactly as it reads the button's: `body` with its
    `@handles` intact, `scope` where the body is the shot alone and compile joins
    the piece's prompt in front of it, `sections` on a chained reference card,
    the skill or template that wrote it, and `source` — the prompt it was written
    from — so a piece opened in the editor can say when the sentence has moved
    on underneath its rewrite. `enabled` is the toggle the panel offers; a chat
    render has no panel, so it is on.

    What is *not* here is the panel's `replaced` — the soundscape and music the
    rewrite overwrote, kept so `clear` can put them back. A chat segment has no
    such fields to put back, and a key that means "undo" on a blob with nothing
    to undo would be a lie the panel then reads.
    """
    shots = result.get("shots") or []
    shot = shots[0] if shots and isinstance(shots[0], dict) else {}
    refined = {"body": str(shot.get("body") or "")}
    if result.get("scope"):
        refined["scope"] = result["scope"]
    if result.get("sections"):
        refined["sections"] = result["sections"]
    if result.get("skill"):
        refined["skill"] = result["skill"]
        refined["kind"] = result.get("kind") or "skill"
    if result.get("template"):
        refined["template"] = result["template"]
        refined["forced"] = bool(result.get("forced"))
    refined["source"] = prompt
    refined["model"] = model or ""
    refined["enabled"] = True
    return refined


def refine_into(piece, result, model):
    """Write a refine result onto the chat's one-shot piece. -> its problems.

    The segment gets the `refined` block, and the two audio fields only where
    the reply carried them: an empty field is the model having nothing to add,
    not an instruction to blank a line — the same reading `RefinePanel.apply`
    takes, and the timeline before it. A reply with no body at all is left out
    entirely, because a `refined` block whose body is empty reads as "typed
    text" to the compiler and as "refined" to a person, and the two disagreeing
    is worse than either.

    The problems are the refine route's own sentences — a dropped quote, a
    handle the rewrite never mentions — handed back for the card to show.
    Advisory, as they are under the button: the render goes ahead.
    """
    segments = piece.get("segments") or []
    if not segments or not isinstance(segments[0], dict):
        raise ActionError("this piece has no shot to refine.")
    segment = segments[0]
    refined = refined_field(result, str(segment.get("prompt") or ""), model)
    problems = [str(p) for p in (result.get("problems") or [])]
    if not refined["body"].strip():
        return problems + ["the refiner wrote nothing, so the prompt goes as the model wrote it"]
    segment["refined"] = refined
    for field in ("soundscape", "music"):
        if result.get(field):
            segment[field] = result[field]
    return problems
