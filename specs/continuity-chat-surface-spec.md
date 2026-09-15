# Continuity — The chat surface

Brainstorm and research notes, then a proposed design. High level:
architecture and decisions, not code. Written 2026-09-15 against `main` at
`2b561ab`.

## 1. The ask

A room reached from the tools dashboard where you talk to the refiner model
the way you talk to ChatGPT, and it makes pictures and clips: "a fox in a
snowy wood at dusk" → a still; "make it a clip, she looks up" → a shot;
"bluer, and closer on the face" → an edit. It has to work with small models,
because the refiner is whatever the user pointed the pack at: a 4B Qwen3-VL
loaded in-process, or an LM Studio / Ollama / hosted endpoint.

Two questions decide everything: how does the model get at what it needs to
know, and how does it run a render.

## 2. How ChatGPT does it (what to copy, what not to)

ChatGPT's image generation is a **tool call**, and the tool is small. The
leaked contract is one function, `text2im`, with five fields: `prompt`,
`size`, `n`, `transparent_background`, `referenced_image_ids`. The rules
around it are shorter than this paragraph: use it whenever the user asks for
a picture or a change to one; do not ask for confirmation; after the call,
say nothing. Edits are a fresh call with a rewritten full prompt plus the
**id** of the earlier image, never the pixels again. The public Responses API
formalises the same thing with an `action: auto | generate | edit` switch and
`previous_response_id` for multi-turn.

Gemini is the other architecture: the chat model *is* the image model, so
images come back as parts of the reply with no tool at all. We cannot be
that — the refiner is a text (or vision-text) model and the renderers are six
separate families — so we are in ChatGPT's shape, not Gemini's.

The pieces that transfer:

- **One tool, a flat schema, the model rewrites the prompt.** Small models
  choose well among ~5 fields and badly among 50 tools (BFCL-derived: tool
  selection collapses as the catalogue grows; arXiv 2605.24660).
- **Prior media by id.** Every upload and every render gets a short handle;
  edits name it. This pack already has that: `@img-3`.
- **A generate/edit switch the harness can force**, because "edit" in this
  pack is a different family (Qwen Image Edit, Flux 2 Klein, or `edit`/
  `continue` scope on a clip), not a flag on the same one.
- **Don't ask, just render.** With one exception we already have: a refusal
  from the compiler (a missing weight, an H3 duration off the grid) is a
  sentence, and the assistant relays it.

## 3. What the pack already has

The refiner subsystem is single-shot by construction but every part of it
is reusable. From the map (see `creator/refine_routes.py`,
`creator/refine_remote.py`, `creator/refine_local.py`):

- **Two backends behind one `chat(model, system, message, images, …)`
  signature.** Local is a Qwen3-VL 4B/8B loaded through `comfy.sd.load_clip`
  and driven by `CLIP.generate`; remote is one OpenAI-compatible
  `/chat/completions` client with provider quirks table-driven
  (`NEGOTIABLE`, `UNLOADS`). Both **see images** already (`_picture`,
  `to_data_url`). Neither streams, neither knows tool calling, and there is
  no message-list plumbing above them — every call is system + one user turn.
- **`_plan()` compiles the blob first**, so the refiner already knows the
  family, the mode, every reference and its ordinal label, the cast, the
  timeline, the language and the duration. That is exactly the "what does
  the node know" payload a chat turn needs, and it exists.
- **Rendering without the node on the canvas works.** The whole piece is one
  JSON blob in one widget, and `creator/sampling.py:29` says a headless
  queue that never opens the node is supported on purpose. `jobs.submit`
  builds a one-node API-format prompt and puts it on ComfyUI's queue;
  `neuraltwin` re-queues a finished render from its embedded blob. A
  `MiniMaxH3Creator` node with `creator_data` set is an output node that
  expands its own graph and saves its own file.
- **A dry run exists.** `POST /continuity/compiled_prompt` compiles a blob to
  the prompt each pass will read, or returns `{problem}` — the refusal as a
  sentence, before any GPU time.
- **The machine describes itself.** `GET /continuity/families` is the
  validated catalogue (what each family makes, its canvas rules, durations,
  reference limits, which weight slots it needs); `GET /continuity/models` is
  what is on disk per slot; `settings["weights"]` is the machine's last pick
  per family. Nothing today joins them into "which families are usable right
  now", but it is a join, not a discovery.
- **Every render carries its blob** in the file's metadata, and takes are
  filed with card and seed. Provenance is free.
- **The dashboard has a registration pattern**: a card in
  `fullscreen.destinations()` with a `go` that opens an `mmc-bn-over` room
  and a `back` that returns to the dash. Four tools use it today.

What does not exist: a conversation, a per-conversation asset ledger, token
streaming (the pack has no SSE path at all; long work rides the queue and the
browser waits for `executed`), and any tool-call or JSON-schema plumbing.

## 4. The design

### 4.1 Two models' worth of work, in one model

The trap is asking the chat model to write H3's Context-IR or LTX's shot
list. A 4B model cannot, and a 70B one gets it wrong often enough that the
Refine button exists. So the chat model **never writes the family prompt**.
It writes what a user types into the prompt box: a short brief in the
pack's own language — `@handles` for references, quotes for spoken lines,
`{a|b}` if it wants — plus three or four knobs. Then the pipeline the node
already runs takes over:

```
user turn ──► chat model ──► action JSON (brief + knobs)
                                   │
                                   ▼
                         blob patch (the chat's piece)
                                   │
                    compiled_prompt dry run → refusal? relay it
                                   │
                      Refine (the same backend, the family's
                      own prompting) → structured prompt
                                   │
                          one-node prompt on the queue
                                   │
                    executed → file → ledger entry (+ caption)
```

The chat model is the director; the refiner is the writer; the compiler is
the crew. This is the same division ChatGPT makes between the assistant and
the image model, and it is what lets a small model drive the whole thing: it
only ever has to produce a sentence and a handful of fields.

Cost: two model calls per render (brief, then refine). The refine call can be
skipped for families whose manifest has no `refine` capability, and a
setting can skip it when the user trusts the chat model to write prose
directly (a large hosted model with the H3 skill loaded is fine at it).

### 4.2 The one action

One tool, one schema, never more than one call per turn. Draft:

```json
{
  "act":     "say" | "render",
  "kind":    "still" | "video",
  "prompt":  "the brief, in the prompt box's language",
  "from":    ["img-3"],          // handles from the ledger; first is the
                                 // picture being edited, or the clip
                                 // being continued
  "seconds": 6,                  // video only; omitted = family default
  "aspect":  "16:9",
  "say":     "one line to show the user"
}
```

Everything else — family, checkpoint, resolution, sampler row, turbo — is
the harness's choice from the machine card and the conversation's settings
rail, the way ChatGPT picks the model. `kind` + whether `from` is set
resolves the family: still with nothing → the default still family; still
from a picture → an edit family; video from a clip → H3 with `continue`
scope; video from a still → a start frame. A `family` field can be added for
users who want to name one in chat, but it is not in the small-model schema.

Why this shape and not native tool calling with several tools:

- Constrained decoding guarantees shape, not meaning: on sub-3B models hard
  schema decoding took validity to 100% and accuracy *down* (arXiv
  2605.26128); "reason free, constrain late". A plan sentence before the
  JSON helps a small model pick the right action (arXiv 2604.02155: ~32
  tokens of reasoning lifted a 1.5B model 44% → 64%; 256 tokens made it
  worse).
- Multi-turn tool use is where small models collapse (Qwen3-4B: ~82%
  single-turn, ~35% multi-turn on BFCL). So the **harness carries the
  state** — the ledger, the piece, the last render's settings — and each turn
  is a fresh single decision.
- Ollama silently drops tool calls when `tools` and `format` are both set
  (ollama#13750). Never send both.

So the protocol is: the model replies with one line of plan, then the JSON in
a fence. The harness parses tolerantly (the pack's `json_object()` already
strips `<think>` and fences), validates against the schema, and on failure
re-asks once with the error quoted. A second failure is treated as `say`.
Where the runtime reports native tool support (Ollama `/api/show`
`capabilities: ["tools"]`, LM Studio `/api/v0/models` `capabilities:
["tool_use"]`), the same single schema is offered as the one tool with
`parallel_tool_calls: false`; the fenced form stays the fallback and the
default for the in-process backend.

A cheap nudge on top, borrowed from SillyTavern: if the user's message
matches an obvious "make / show / render me a picture / clip" pattern and
the model answered `say`, re-ask once telling it a render was expected.

### 4.3 What the model gets to know

Three blocks, all assembled server-side, all short. Small models read the
end of the prompt best, so the order is fixed and recency-weighted the way
`families/h3/refine.py` already orders its rules.

1. **The machine card** (~200 tokens, cached per settings change). The join
   of `families` × `models` × `settings.weights`: for each family, whether
   it is ready (its required slots have a file), what it makes, its
   duration range and grid, its aspect table, whether it takes references
   and how many, and which is the default still and video family. A family
   with no weights is listed as "not installed" so the model can say so
   instead of trying.
2. **The ledger** — the conversation's media, one line each:
   `img-3 · still · 16:9 · from turn 4 · "a fox on a snowy ridge, dusk,
   low sun behind"`. The description is the model's own brief for renders,
   the VLM's caption for uploads (§4.5), and the user's words if they
   named it. This is the `referenced_image_ids` mechanism; the pixels are
   never in the text model's context.
3. **The last turns** — the last N exchanges with their action JSON,
   trimmed to a token budget (Home Assistant's local-LLM guidance: 3–5
   turns, under 25 entities, no thinking variant). The last render's full
   knobs ride along so "same but at night" is a delta.

The system prompt itself is short and stable (format sensitivity on BFCL is
real), with three worked exchanges as few-shot: a plain still, an edit that
names `from`, and a question that is just `say`. It ships as a file in
`creator/prompts/chat/` beside the family mode files, and the existing
skill mechanism lets a user add to or replace it.

### 4.4 Running the render

The chat owns a **piece**: a `creator_data` blob per conversation, kept
server-side, never on a canvas. Each `render` action patches it — prompt,
segment assets (the `from` handles resolved to input-folder paths, with
scope set by the edit/continue resolution above), `duration_s`, `aspect`,
`family`, and `models` filled from `settings.weights` — then:

1. `compiled_prompt` dry run. A `{problem}` is relayed as the assistant's
   line, with a fix where the sentence names one ("H3 has no 7-second shot;
   nearest is 6.8").
2. Refine through the family's `Prompting`, on the same backend, unless
   skipped. `_plan()` is reused as-is; the result is written into the
   segment's `refined` field the way the panel does.
3. `jobs`-style submit of a one-node prompt: `MiniMaxH3Creator` for shots,
   `MiniMaxH3PreStage` for stills, seed and sampler row from the piece's
   `sampling` block. The route answers `{prompt_id}`; the room listens to
   `progress_state`, `b_preview*`, `executed` and `mmc_refused` the way
   `stage.js` does, keyed on that id.
4. On `executed` the saved file becomes a ledger entry with the next handle
   and the brief as its description. The file is an ordinary render in the
   output folder — it is in the gallery, and the node's picker can cite it.

A render is one queue item like any other: Cancel reaches it, the progress
bar is the real one, and a render from the canvas ahead of it goes first.

### 4.5 Seeing what it made

"Make the dog bigger" needs to know there is a dog and where. Both backends
can already look at pictures, so after each render — and on each upload —
the harness asks for a **fixed structured caption** (subject, composition,
palette, style, anything wrong) of the first frame and stores it on the
ledger line. That is a vision call with no action schema, so it cannot
confuse the action turn. Feed the caption, not the picture, to the next
text turn. Where the backend is not a vision model (a text-only hosted
endpoint), the ledger line is the brief alone, which covers global edits
(colour, style, aspect, "make it a clip") and not spatial ones; the room says
so in the settings rail.

### 4.6 Streaming, and what to do about the local backend

Remote: the first SSE path in the pack. The turn route becomes an aiohttp
`StreamResponse` that forwards `delta.content` as tokens, and the fenced
JSON is withheld from the bubble until it parses. `refine_remote` gets a
`stream=True` variant of its one request builder.

Local: `CLIP.generate` yields nothing until it is done; it ticks a
`ProgressBar` per token, which is the counter the refine button already
shows. A local chat turn also **must** ride the queue — it is GPU work, and
`jobs.py` explains what happens when it does not. So a local turn is a
`jobs.register("chat", …)` kind, answers `{prompt_id}`, and the bubble shows
the token counter until `executed` delivers the reply. That is honest and
matches the button. It also means a local chat waits behind a five-minute
render, which is the cost of one GPU; the room shows the queue position.

### 4.7 The room

A card on the dashboard beside Presets, ControlNet, Blockout and Upscale:
**Chat** — "Ask for a picture or a shot, then ask for changes". It opens an
`mmc-bn-over` room with the wordmark as the way back, in the bench
stylesheet's vocabulary:

- **The conversation**, centre. User bubbles; assistant bubbles; render cards
  inline with the thumbnail or player, the handle, and three doors: *Open in
  the editor* (the chat's piece becomes the node's blob, on the current
  node or a new one), *Retake* (same blob, new seed), *Use as reference*
  (attaches to the node's piece). A refusal is a bubble with the sentence.
- **The rail**, right. The backend and model picker (the refine popover's,
  reused), what the model can see (tools / vision / neither, probed and
  cached per model), the machine card as the user sees it, and the
  conversation's standing settings: default still and video family,
  resolution, turbo, seed policy. Under it, the ledger as tiles.
- **The composer**, bottom. A plain box, not the `PromptBox` — no chips —
  with a paperclip that uploads into `input/continuity/chat/` and adds a
  ledger line. Pasted images do the same.
- **Conversations** persist as one JSON file each in ComfyUI's user
  directory under `continuity.chats/`, for the same reason `settings.py`
  gives: the turn runs server-side and has to read the ledger without a
  browser present. A left drawer lists them by first line.

### 4.8 Where it does not go

- Not a workflow builder. It never emits graph JSON or picks node ids; it
  patches a blob the compiler already understands. ComfyUI-Copilot and the
  Comfy MCP are that other thing, and they need frontier models.
- Not the timeline, in the first version. A conversation is a run of single
  pieces; "now add a second shot where…" becomes a *new* piece whose `from`
  continues the last clip. Growing one piece into a strip is a later door
  (*Open in the editor* is how you get there today).
- Not the cast. `@anna` in a chat brief should resolve against the cast
  library, since the compiler already knows how, but making members from
  chat is out of scope.
- No key ever reaches the browser; the remote client's rules stand.

## 5. Sequencing

1. **Backend, headless.** Conversation store; the machine card; the action
   schema and its parser; `POST /continuity/chat/turn`; render-from-piece
   through the one-node submit; the caption call. A `tools/chat_bench.py`
   like `refine_bench.py` runs a scripted conversation against any backend
   without a browser, which is also how the system prompt gets tuned per
   small model.
2. **The room.** Dashboard card, conversation, render cards wired to the
   queue events, the rail with the existing backend picker.
3. **Refine in the loop, and vision captions.**
4. **Streaming for remote; native tools where reported; the edit and
   continue resolutions on `from`.**
5. **Doors back into the editor**: open, retake, use as reference.

## 6. Risks and open questions

- **One GPU.** A local chat model and a render share it. The refiner already
  evicts like any model; the queue serialises them; but a user chatting
  during a long render gets a reply after the render. Remote backends have
  no such problem and should be the recommended setting on small cards.
- **Which small models.** Qwen3.5 4B/9B and Gemma 4 E4B/12B report tools and
  vision and do single-turn tool selection well; Gemma 3 has no tool
  template; DeepSeek distills are not tool-trained. The bench in step 1 is
  what settles the system prompt per model, and the room should say plainly
  when a model has neither tools nor vision.
- **LM Studio vision over REST** has open bug reports about data-URL image
  parts on some versions; the existing refine path already exercises this,
  so whatever it does today, the chat inherits.
- **Family choice by the harness.** Resolving family from `kind` + `from`
  is a rule table; the rule table is a product decision (Krea 2 or Ideogram
  for a plain still? H3 stills or a stills family?). Default to the
  conversation's standing settings, seeded from `settings.weights`.
- **Refine's cost** doubles the model calls per render. Measure on the bench
  before deciding the default; the alternative is asking the chat model for
  the family prompt directly when it is large enough, via the existing
  `replace`-mode skill.
