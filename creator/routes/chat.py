"""`/continuity/chat/*`: the two doors the chat room knocks on.

The room is a conversation and a queue, and those are the two things the server
has to hold up. `chat/turn` asks the refiner model what to do about one user
message and answers `{say, action?, raw}`. `chat/render` takes the action it
answered with, turns it into a blob, compiles that blob as a dry run, and puts a
one-node prompt on ComfyUI's queue. Everything between them lives in the
browser: the conversation, the ledger of what has been made, the rail. This
module is stateless on purpose — the spec's §5.5 — so a reload starts fresh and
nothing here has a session to lose.

**The thinking is next door.** `creator/chat.py` owns the action schema, the
parse, the re-ask protocol, the machine card and the two blob patches, and it is
pure. What is here is the joining that cannot be: which files are on this disk,
what this machine last picked, what the compiler says about the result, and the
queue. That is the same line `refine_routes.py` draws against
`families/refine.py`, and it is why the whole protocol can be tested without a
server and tuned on `tools/chat_bench.py` without a browser.

**Two backends, one shape.** The remote refiner is answered inside the request,
exactly as the refine button's is and for the same reason: it spends somebody
else's GPU, so there is nothing for it to queue behind. The in-process one is a
4B model on the card the render wants, so it rides the queue as a `chat` job and
the reply arrives on `executed` under `ui.continuity` — the same object, so the
room reads one shape whichever backend it is pointed at.

**The re-ask is a second call inside the same job**, never a round trip to the
browser. The room asked one question and is owed one answer; a correction the
person watches happen reads as a failure, and on the queued path it would be a
second wait behind whatever is running.

No native tool calls yet. Where a runtime reports tool support the same schema
is the one tool, but the fenced form is the fallback and the default, and it is
what both backends get here — the seam is `_ask` below, which is the one place
a reply is produced.
"""

import asyncio
import json

from aiohttp import web

from server import PromptServer

from .. import chat, jobs, media, models as core_models, refine_routes, refine_skill
from .. import server_routes, settings
from ..families import manifest, refine, registry


# ---- the machine card -------------------------------------------------------
#
# Cached because it is a join of three payloads — every family's manifest, a walk
# of the model directories, and the settings file — and the room asks for it on
# every turn of a conversation that may run for an hour.

_CARDS = {}
_CARDS_KEEP = 4


def machine_card(still_family, video_family, weights):
    """What this machine can make, as the model reads it. See `chat.machine_card`.

    Keyed on its own inputs rather than invalidated from `settings.save`. A hook
    there would catch the settings page and miss everything else that moves this
    answer — the weights popover patches the same file from the node, and the
    rail will patch it again from the room — whereas the key is exactly the
    three facts the card is made of, so anything that changes one of them
    changes the key. The listing is not in the key: a walk of the model folders
    on every turn is the cost this cache exists to avoid, and `settings.weights`
    moving is what a *picked* file changing looks like from here.
    """
    key = json.dumps([still_family, video_family, weights], sort_keys=True, default=str)
    card = _CARDS.get(key)
    if card is None:
        card = chat.machine_card(still_family, video_family, manifest.catalog(),
                                 core_models.available(), weights)
        while len(_CARDS) >= _CARDS_KEEP:
            _CARDS.pop(next(iter(_CARDS)))
        _CARDS[key] = card
    return card


# ---- the rail ---------------------------------------------------------------


def _arch_of(family):
    """The pre-stage pill's name for a family, or None where it makes no stills.

    "minimax" is H3's and is frozen in every saved blob, which is why the pill's
    vocabulary and the registry's ids are not the same words — see
    `registry.STILL_ARCHES`. The rail arrives naming families, because that is
    what the machine card and the settings block are keyed by, so the mapping
    happens once, here, and the pure half is handed the arch.
    """
    for arch, owner in registry.STILL_ARCHES.items():
        if owner == family:
            return arch
    return None


def _rail(raw):
    """The room's rail, filled in and with the still family's arch stamped on.

    Absent families fall back to the registry's own defaults, which is what a
    room that has not been set up yet is holding, and the same answer the node
    gives a freshly dropped blob.

    The still side is the *image* families and not every family that makes a
    still. H3's still branch is a video generation with one latent frame decoded
    as a picture, and its pre-stage blob is the Creator's own request under a
    `minimax` block rather than the shared image shape — a second blob for this
    room to patch, for a picture the video family can already be asked for
    directly. So the rail offers the families that draw a picture outright, and
    the room's own pill will offer the same set.
    """
    rail = dict(raw or {})
    still = rail.get("still_family")
    if still not in registry.IMAGE_FAMILIES:
        still = registry.STILL_ARCHES[registry.DEFAULT_STILL_ARCH]
    video = rail.get("video_family")
    if video not in registry.video_families():
        video = registry.DEFAULT_VIDEO
    rail["still_family"] = still
    rail["video_family"] = video
    rail["still_arch"] = _arch_of(still)
    return rail


# ---- the weights ------------------------------------------------------------


def _picked(family, stored):
    """This machine's remembered picks for `family`, as `{slot: filename}`.

    Filtered to the slots the family actually declares. `settings.clean_weights`
    stores a block as written — a slot id it has never heard of is kept, because
    what a slot *means* is the family's — so a block left behind by another
    family, or by a version of this one with a slot since renamed, would
    otherwise ride into the blob and read as nothing to every reader downstream.
    """
    block = (stored or {}).get(family["id"]) or {}
    ids = {slot["id"] for slot in family.get("weights") or []}
    return {name: value for name, value in block.items()
            if name in ids and isinstance(value, str) and value.strip()}


def _not_ready(family, picked, available):
    """The sentence a family with a required file missing gets, or None.

    The same reading the machine card takes, so what the model was told and what
    the render refuses cannot disagree — the card says a family is not ready and
    this is the refusal if the model asks for it anyway.
    """
    gone = chat.missing_weights(family, picked, available)
    if not gone:
        return None
    return (f"{family['label']} cannot render yet: no file is picked for "
            f"{chat.listed(gone)}. Choose them in the weights control and "
            f"ask again.")


# ---- building the render ----------------------------------------------------


def _node_widgets(node, family, seed):
    """Every widget a node's schema declares, at this family's defaults.

    A prompt built by hand carries the whole input list: ComfyUI validates a
    prompt against the schema, and a widget left off is a render that will not
    queue. The values are the schema's own defaults read off the schema — the
    node is the only honest source for what it declares — with the family's
    manifest laid over them, because a static schema can only wear one family's
    numbers and the manifest is where a family says what row it samples on.
    `sampling.py` argues that split at length; this is the headless end of it.

    The seed is set last and is always a widget. `control_after_generate` is the
    frontend's own linked control and there is nothing in a blob for it to be,
    which is why the seed is the one number on this row that never moved.
    """
    values = {}
    for spec in node.define_schema().inputs:
        name = getattr(spec, "id", None) or getattr(spec, "name", None)
        default = getattr(spec, "default", None)
        if name and default is not None:
            values[name] = default
    for widget in family.get("widgets") or []:
        if widget.get("id") in values and widget.get("default") is not None:
            values[widget["id"]] = widget["default"]
    values["seed"] = seed
    return values


def _nodes():
    """The two node classes a chat render is built around.

    Imported here rather than at module scope: both pull in ComfyUI, and route
    modules are imported while the server is still registering its routes.
    """
    from .. import creator_node, prestage

    return {"MiniMaxH3PreStage": prestage.MiniMaxH3PreStage,
            "MiniMaxH3Creator": creator_node.MiniMaxH3Creator}


def _build(action, ledger, rail, stored):
    """The blocking half of a render: patch, fill, dry run, build the prompt.

    -> `{"piece": blob, "prompt": one-node prompt}`, or `{"problem": sentence}`.
    A problem is the assistant's next line, verbatim, and is not an error: a
    duration off the frame grid and a checkpoint nobody picked are both ordinary
    things for a model to have asked for, and relaying the compiler's own
    sentence is what lets it say so and try again.

    The patched blob goes back with the prompt id so the browser can hold it
    without patching a second copy of its own. Two implementations of the same
    patch is exactly the drift this pack keeps writing about, and the server has
    to build the blob anyway to queue it.
    """
    still = action["kind"] == chat.KIND_STILL
    node_id, field, piece = chat.piece_of(action, ledger, rail)
    family = manifest.describe(rail["still_family"] if still else rail["video_family"])
    picked = _picked(family, stored)

    problem = _not_ready(family, picked, core_models.available())
    if problem:
        return {"problem": problem}

    if still:
        # Per-arch sub-blocks with one shared precision, which is the shape
        # `render_image.ImageWeights.from_blob` reads and the shape the pre-stage
        # writes: flipping the model pill must not forget the other side's files.
        piece["models"] = {piece["arch"]: picked,
                           "dtype": ((stored or {}).get(family["id"]) or {}).get("dtype")
                                    or "default"}
    else:
        # Flat, and the whole remembered block rather than the filenames alone:
        # `models.Weights.from_blob` reads the precision, the route and the
        # pinned devices out of the same dict, and a piece that dropped them
        # would render on other settings than the node would have.
        piece["models"] = dict((stored or {}).get(family["id"]) or {})

    try:
        if still:
            registry.still(piece["arch"]).compile_still(piece, media.image_size)
        else:
            server_routes.compiled_passes(piece)
    except server_routes.COMPILE_FAILURES as refusal:
        return {"problem": str(refusal)}

    node = _nodes()[node_id]
    widgets = _node_widgets(node, family, chat.render_seed(rail))
    # The blob last: the schema's own default for that widget is in `widgets`
    # too — every input is, which is the point — and it is the one the render is
    # replacing.
    return {"piece": piece,
            "prompt": {"1": {"class_type": node_id,
                             "inputs": {**widgets,
                                        field: json.dumps(piece, indent=2)}}}}


@PromptServer.instance.routes.post("/continuity/chat/render")
async def chat_render(request):
    """Render what the model asked for. -> `{prompt_id, piece}` or `{problem}`.

    An ordinary queue item: Cancel reaches it, the progress bar is the real one,
    a render queued from the canvas ahead of it goes first, and what comes out
    is a file in the output folder with its blob in its metadata — citable from
    the picker like anything else this pack makes.
    """
    try:
        body = await request.json()
    except ValueError:
        return web.json_response({"error": "the request body was not JSON"}, status=400)

    ledger = body.get("ledger") or []
    rail = _rail(body.get("rail"))
    if rail.get("refine"):
        # The Refine switch is the spec's third step: the chat's prompt goes
        # through the family's own `Prompting` on the same backend before
        # queueing, exactly as the button does. Refused rather than ignored
        # while it is not built, because a switch that silently does nothing is
        # worse than one that says it is not here yet.
        return web.json_response({"problem":
            "Refine is not wired into this room yet — turn the switch off and "
            "the prompt goes to the compiler as the model wrote it."})

    try:
        action = chat.validate(body.get("action"), ledger)
    except chat.ActionError as problem:
        return web.json_response({"error": str(problem)}, status=400)
    if action["act"] != chat.ACT_RENDER:
        return web.json_response(
            {"error": "that action says nothing to render"}, status=400)

    # Everything below this line touches disk — the settings file, the model
    # folders, the compiler's size lookups — and this loop is also the prompt
    # queue and the websocket.
    loop = asyncio.get_running_loop()
    try:
        built = await loop.run_in_executor(
            None, lambda: _build(action, ledger, rail,
                                 settings.load().get("weights") or {}))
    except chat.ActionError as problem:
        return web.json_response({"error": str(problem)}, status=400)
    except Exception as problem:  # noqa: BLE001
        return web.json_response({"error": f"{type(problem).__name__}: {problem}"},
                                 status=500)
    if "problem" in built:
        return web.json_response(built)

    try:
        prompt_id = await jobs.enqueue(built["prompt"], body.get("client_id"))
    except jobs.JobError as problem:
        return web.json_response({"error": str(problem)}, status=500)
    return web.json_response({"prompt_id": prompt_id, "piece": built["piece"]})


# ---- the turn ---------------------------------------------------------------


def _skill(block):
    """The user's own instructions for this room, or "". Raises `RefineError`.

    Only the `add` mode. A `.skill` set to *replace* the built-in prompting
    takes the whole system prompt over, and this room's system prompt is the
    contract that turns an answer into a render — replaced, there would be
    nothing to parse and nothing to queue. So it is refused by name rather than
    quietly downgraded to `add`, which would be running a different thing than
    the switch says.
    """
    name = str(block.get("skill") or "").strip()
    if not name:
        return ""
    skill = refine_skill.load(name)
    if (block.get("skill_mode") or skill["mode"]) != refine_skill.ADD:
        raise refine.RefineError(
            f"'{name}' is set to replace the built-in prompting, and the chat "
            f"cannot run it that way — its reply contract is what turns an "
            f"answer into a render. Set it to add to the built-in prompting, "
            f"or pick no skill here."
        )
    return refine_skill.instructions(skill)


def _ask(block, system, message):
    """One generation on whichever backend the room is pointed at.

    The one place a reply is produced, which is where a native tool call will
    land when the runtime reports it: the same schema as the one tool, with
    `parallel_tool_calls` off, and this fenced form as the fallback. Until then
    both backends get the fence.

    `prefill=""` rather than the harness's opening brace. The refiner's replies
    are a bare JSON object and beginning the assistant's turn inside it is what
    stops a small model answering the request instead of expanding it; here the
    reply is a line of plan *and then* an object, so a prefilled `{` would cut
    the plan off before it was written. `json_object` finds the brace either way.
    """
    ask, _look = refine_routes._backend(block)
    return ask(
        block.get("model") or "",
        system, message, [],
        # Choosing an action is a decision, not ideation: the default leans cold
        # so that "another one, bluer" stays a render rather than becoming a
        # conversation about one. The dial is still the user's.
        temperature=block.get("temperature", 0.3),
        seed=block.get("seed", -1),
        max_tokens=block.get("max_tokens"),
        prefill="",
    )


def _last_user(messages):
    """The message this turn is answering — the newest user turn, or ""."""
    for message in reversed(messages or []):
        if isinstance(message, dict) and message.get("role") == "user":
            return str(message.get("text") or "")
    return ""


def _run(body):
    """The blocking half of a turn: build the context, ask, judge, maybe re-ask.

    -> `{say, action?, raw, reask?}`. `raw` is the reply the answer came out of
    and `reask` is the sentence that was quoted when there were two, so the room
    can show what happened rather than only what survived.
    """
    block = body.get("settings") or {}
    ledger = body.get("ledger") or []
    messages = body.get("messages") or []
    rail = _rail(block)

    card = machine_card(rail["still_family"], rail["video_family"],
                        settings.load().get("weights") or {})
    system = chat.system_prompt(_skill(block))
    message = chat.context(messages, ledger, card)
    asked = _last_user(messages)

    raw = _ask(block, system, message)
    verdict = chat.judge(raw, ledger, asked)
    quoted = None
    if verdict["act"] == "reask":
        quoted = verdict["sentence"]
        raw = _ask(block, system, chat.reask(message, raw, quoted))
        verdict = chat.judge(raw, ledger, asked, second=True)

    out = {"say": verdict.get("say") or "", "raw": raw}
    if quoted:
        out["reask"] = quoted
    if verdict["act"] == chat.ACT_RENDER:
        out["action"] = verdict["action"]
    return out


def _run_job(body):
    """One turn, on the queue. See `creator/jobs.py`.

    The pack's own three become a message about the request, the way the refine
    job's do: the room puts the sentence in the conversation either way, and
    anything else is a bug reported as one.
    """
    try:
        return _run(body)
    except (refine.RefineError, chat.ActionError) as problem:
        raise jobs.JobError(str(problem)) from problem


jobs.register("chat", _run_job)


@PromptServer.instance.routes.post("/continuity/chat/turn")
async def chat_turn(request):
    """Ask the model what to do about one message. -> the turn, or a `prompt_id`.

    Stateless: the browser sends the trimmed history, the ledger and the rail
    every time, and this builds one turn out of them. The remote backend answers
    inside the request; the in-process one is GPU work and rides the queue, so a
    local chat waits behind a running render. That is the cost of one GPU and
    the room shows the queue position rather than pretending otherwise.
    """
    try:
        body = await request.json()
    except ValueError:
        return web.json_response({"error": "the request body was not JSON"}, status=400)

    block = body.get("settings") or {}
    remote = block.get("backend") == "remote"
    if not (block.get("model") or "").strip():
        if remote:
            return web.json_response({"error":
                "No model chosen. Pick one of the server's models in the "
                "refiner's settings."
            }, status=400)
        return web.json_response({"error":
            "No text encoder chosen. Put a Qwen3-VL 4B or 8B text encoder in "
            "models/text_encoders and pick it in the refiner's settings."
        }, status=400)

    if remote:
        # Off the event loop even so: the call to the server blocks, and this
        # loop is also the prompt queue and the websocket.
        loop = asyncio.get_running_loop()
        try:
            return web.json_response(await loop.run_in_executor(None, _run, body))
        except (refine.RefineError, chat.ActionError) as problem:
            return web.json_response({"error": str(problem)}, status=400)
        except Exception as problem:  # noqa: BLE001
            return web.json_response({"error": f"{type(problem).__name__}: {problem}"},
                                     status=500)

    try:
        prompt_id = await jobs.submit("chat", body, body.get("client_id"))
    except jobs.JobError as problem:
        return web.json_response({"error": str(problem)}, status=500)
    return web.json_response({"prompt_id": prompt_id})
