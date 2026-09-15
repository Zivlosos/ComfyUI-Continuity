# Continuity — The chat surface

Spec for the first iteration. High level: architecture and decisions, not
code. Written 2026-09-15 against `main` at `2b561ab`, after the research in
§2 and §3.

## 1. Summary

A room reached from the tools dashboard where you talk to the refiner model
the way you talk to ChatGPT, and it makes pictures and clips: "a fox in a
snowy wood at dusk" → a still; "now a clip of it, she looks up" → a shot;
"bluer" → another still. The refiner is whatever the user already pointed
the pack at — a Qwen3-VL 4B in-process, or LM Studio, Ollama, a hosted
endpoint — so it has to work with small models.

**First iteration, deliberately small:**

- Stills, and video of **one shot**. No timeline, no seams, no cast.
- **The model's prompt is the render's prompt.** The chat model writes what
  a user would type into the prompt box, and that goes to the compiler as
  typed. The Refine pass is a switch in the rail, **off by default**.
- The server is stateless. The conversation and its media ledger live in the
  browser for the life of the room; the server builds one turn at a time.
- No token streaming, no vision captions, no saved conversations. Each is a
  later step (§6) and none is needed to have the conversation.

## 2. How ChatGPT does it

ChatGPT's image generation is a **tool call**, and the tool is small. The
leaked contract is one function, `text2im`, with five fields: `prompt`,
`size`, `n`, `transparent_background`, `referenced_image_ids`. The rules
around it are shorter than this paragraph: use it whenever the user asks for
a picture or a change to one; do not ask for confirmation; after the call,
say nothing. Edits are a fresh call with a rewritten full prompt plus the
**id** of the earlier image, never the pixels again. The public Responses
API formalises the same thing with an `action: auto | generate | edit`
switch and `previous_response_id` for multi-turn.

Gemini is the other architecture: the chat model *is* the image model, so
images come back as parts of the reply with no tool at all. We cannot be
that — the refiner is a text (or vision-text) model and the renderers are
six separate families — so we are in ChatGPT's shape.

What transfers: one tool, a flat schema, the model rewrites the prompt,
prior media by id, don't ask, just render. What we add: a refusal from the
compiler (a missing weight, a duration off H3's grid) is a sentence, and the
assistant relays it.

## 3. What the research says about small models

- **Constrained decoding guarantees shape, not meaning.** On sub-3B models
  hard schema decoding took JSON validity to 100% and accuracy *down*
  (arXiv 2605.26128, "reason free, constrain late"). A one-line plan before
  the JSON helps a small model pick the right action; a long one hurts
  (arXiv 2604.02155: ~32 tokens of reasoning lifted a 1.5B model from 44%
  to 64%; 256 tokens made it worse than none).
- **Multi-turn tool use is where small models collapse.** Qwen3-4B scores
  about 82% single-turn and about 35% multi-turn on BFCL. So the harness
  carries every bit of state and each turn is a fresh single decision.
- **Few, flat tools.** Tool selection degrades as the catalogue grows
  (arXiv 2605.24660). One tool with five fields.
- **Ollama drops tool calls when `tools` and `format` are both set**
  (ollama#13750). Never send both.
- **Which models.** Qwen3.5 4B/9B and Gemma 4 E4B/12B report tools and
  vision and choose well single-turn; Gemma 3 has no tool template;
  DeepSeek distills are not tool-trained. Capability is discoverable:
  Ollama `POST /api/show` → `capabilities`, LM Studio `GET /api/v0/models`
  → `capabilities` and `type: vlm`.
- **The ecosystem** (Open WebUI, SillyTavern, LibreChat, the Comfy MCP,
  ComfyUI-Copilot) either needs frontier models to drive many tools, or
  maps generic fields onto a workflow template. None understands references
  the way this pack's compiler does. The template approach is the one that
  works for small models, and here the template is the blob.

## 4. What the pack already has

- **Rendering without the node on the canvas is supported on purpose.**
  The piece is one JSON blob in one widget (`creator/sampling.py:29`).
  `jobs.submit` builds a one-node API-format prompt and puts it on ComfyUI's
  queue; `neuraltwin` re-queues a finished render from its embedded blob.
  A `MiniMaxH3Creator` (or `MiniMaxH3PreStage`) node with its blob set is an
  output node that expands its own graph and saves its own file.
- **A dry run.** `POST /continuity/compiled_prompt` compiles a blob to the
  prompt each pass will read, or returns `{problem}` — the refusal as a
  sentence, before any GPU time.
- **The machine describes itself.** `GET /continuity/families` (what each
  family makes, canvas rules, durations, reference limits, required weight
  slots), `GET /continuity/models` (what is on disk per slot),
  `settings["weights"]` (the machine's last pick per family). Nothing joins
  them into "which families are usable now" yet; it is a join.
- **Two refiner backends behind one `chat(model, system, message, images,
  …)` signature**, both able to look at pictures. No message list above
  them, no streaming, no tool plumbing. `json_object()` already strips
  `<think>` and fences from a reply.
- **The dashboard's card pattern**: an entry in `fullscreen.destinations()`
  whose `go` opens an `mmc-bn-over` room and whose `back` returns to the
  dash. Four tools use it.
- **Every render carries its blob** in the file's metadata.

## 5. The design

### 5.1 The model writes the prompt, the compiler renders it

The chat model writes what a user types into the prompt box: a description
in the pack's own language — `@handles` for references, quotes for spoken
lines or on-screen text, `{a|b}` if it likes — plus a few knobs. That text
goes into the blob's segment prompt **as typed**, and the compiler wraps it
the way it wraps any prompt: reference labels, mode, duration grid, the
family's frame. No second model call.

```
user turn ──► chat model ──► one line of plan + action JSON
                                    │
                                    ▼
                          blob (the chat's piece)
                                    │
                    compiled_prompt dry run → refusal? relay it
                                    │
                     [Refine, only if the rail switch is on]
                                    │
                         one-node prompt on the queue
                                    │
                  executed → file → ledger entry in the browser
```

Refine as an option, not a step: with the switch on, the chat's prompt goes
through the family's own `Prompting` on the same backend before queueing,
exactly as the button does, and the panel's `refined` field is written into
the segment. It doubles the model calls per render and it is what a user
with a small model and H3 will want eventually; it is off until they ask.
The family's prompting rules (H3 wants structured prose) are available to
the chat model a cheaper way: the user's chosen skill file from
`creator/skills/` can be appended to the chat's system prompt, the same
`add` mode the refiner offers.

### 5.2 The one action

One tool, one schema, at most one call per turn:

```json
{
  "act":     "say" | "render",
  "kind":    "still" | "video",
  "prompt":  "what would go in the prompt box",
  "from":    ["img-3"],
  "seconds": 6,
  "aspect":  "16:9",
  "say":     "one short line for the user"
}
```

- `kind` picks the family: the rail's standing still family or video
  family. The model does not name families in this iteration.
- `from` is zero or more handles from the ledger. They become references
  on the segment, scope `full`. Under `kind: video` a still in `from` is
  the **start frame**. Under an edit family (Qwen Image Edit, Flux 2 Klein)
  the first one is the picture being edited, which is what those families
  do with a first reference already. Nothing else is resolved: no
  `continue`, no `camera`, no cast.
- `seconds` and `aspect` are optional; the family's defaults apply, and the
  compiler's grid snaps the seconds.
- `say` is what the bubble shows on a `render`; on a `say` it is the whole
  reply.

**Protocol.** The model replies with one line of plan, then the JSON in a
fence. The harness parses tolerantly, validates, and on failure re-asks once
with the error quoted. A second failure is a `say` with the model's text.
Where the runtime reports native tool support the same schema is the one
tool, `parallel_tool_calls: false`; the fenced form is the fallback and the
default for the in-process backend. One nudge on top: if the user's message
plainly asks for a picture or a clip and the model answered `say`, re-ask
once saying a render was expected.

### 5.3 What the model gets to know

Three blocks, short, in a fixed order that ends with the freshest thing,
the way `families/h3/refine.py` orders its rules for small models.

1. **The machine card** (~150 tokens, built server-side, cached until
   settings change). The still family and the video family the rail has
   chosen, whether each is ready (required slots have a file), what each
   makes, its duration range and grid, its aspect table, how many
   references it takes. A family with missing weights says so, so the
   model can say so instead of trying.
2. **The ledger**, one line per item: `img-3 · still · 16:9 · turn 4 ·
   "a fox on a snowy ridge at dusk, low sun behind"`. The description is
   the model's own prompt for a render and the user's words (or the
   filename) for an upload. This is `referenced_image_ids`; pixels never
   enter the text context. An upload with no words and a vision-capable
   backend gets one "what is this" call for its line; a text-only backend
   gets the filename.
3. **The last turns**, trimmed to a budget of about five exchanges, each
   with its action JSON, so "same but at night" is a delta on a known
   prompt.

The system prompt is one short file, `creator/prompts/chat/system.txt`,
with three worked exchanges: a still, a video from an earlier still, and a
question that is just `say`. Stable wording matters (BFCL's format
sensitivity is real), so tuning happens on the bench (§7), not in the room.

### 5.4 Running the render

The browser holds the chat's **piece**: a `creator_data` blob (or
`prestage_data` for stills) it patches from each action and posts back. The
server route `POST /continuity/chat/render` takes the blob and:

1. Fills `models` from `settings.weights` and the sampler block from the
   rail (seed policy, turbo, resolution).
2. Runs the `compiled_prompt` dry run. A `{problem}` comes back as the
   assistant's line, verbatim.
3. Optionally refines (§5.1).
4. Submits a one-node prompt the way `jobs.submit` does — `MiniMaxH3Creator`
   for a shot, `MiniMaxH3PreStage` for a still — and answers `{prompt_id}`.

The room listens to `progress_state`, `b_preview*`, `executed` and
`mmc_refused` keyed on that id, the way `stage.js` does. On `executed` the
saved file becomes a ledger line with the next handle and the prompt as its
description. It is an ordinary render in the output folder: in the gallery,
citable from the node's picker, with its blob in its metadata.

A render is one queue item like any other. Cancel reaches it, the progress
bar is the real one, a render queued from the canvas ahead of it goes first.

### 5.5 The turn itself

`POST /continuity/chat/turn` takes `{messages, ledger, settings}` and
answers `{say, action?, raw}`. It is stateless: the browser sends the trimmed
history each time. The remote backend answers inline, as the refine route
does, since it spends someone else's GPU. The local backend is GPU work and
**rides the queue** as a `jobs.register("chat", …)` kind — the room shows
the token counter the refine button already shows, and the reply arrives on
`executed`. A local chat waits behind a running render; that is the cost of
one GPU, and the room shows the queue position rather than pretending.

### 5.6 The room

A card on the dashboard beside Presets, ControlNet, Blockout and Upscale:
**Chat** — "Ask for a picture or a shot, then ask for changes." It opens an
`mmc-bn-over` room in the bench stylesheet's vocabulary, the wordmark as
the way back.

- **The conversation**, centre. User and assistant bubbles; a render card
  inline with the thumbnail or player, its handle, and two doors: **Open in
  the editor** (the chat's piece becomes the node's blob) and **Retake**
  (same blob, new seed). A refusal is a bubble.
- **No rail.** The model's name is in the bar, the way ChatGPT places it,
  and opens the refine popover; a gear beside it holds the three switches
  that are set once per machine — turbo, the **Refine** switch (off), a skill
  to append. Everything a message is made against is in the composer's foot,
  drawn with the simple view's own pills: the still family and video family
  for `kind`, the aspect + short-edge split pill, the die-and-mark seed pill.
  The ledger has no tiles: each thing is in the transcript where it was made
  or attached, wearing its handle, and pressing it cites it.
- **The composer**, bottom. One rounded sheet: attachments waiting to go,
  the text, and a foot with **+** on the left and the send arrow on the
  right. The plus opens the pack's own picker (image, video, audio, renders);
  pasted and dropped files upload into `input/continuity/chat/` and join the
  same tray. Attachments become ledger lines when the message is sent, and
  the message the model reads names their handles. Enter sends.

Leaving the room keeps the conversation for the life of the page; reloading
starts fresh. The renders stay, in the output folder.

### 5.7 Not in this iteration

- No timeline. "A second shot" is a new one-shot piece; the strip is a
  later door.
- No cast; `@name` is an unknown handle and the compiler says so.
- No `continue`, `camera`, `edit` scopes on clips in `from`.
- No streaming, no captions of renders, no saved conversations.
- No key in the browser; the remote client's rules stand.
- No graph JSON, ever. The model patches a blob the compiler understands.

## 6. Later, in the order it earns

1. Vision captions of each render for spatial edits ("make the dog bigger").
2. Streaming for the remote backend — the pack's first SSE path.
3. `continue` on a clip in `from`, and the edit scopes.
4. Saved conversations, server-side under the user directory.
5. The cast in chat; then the timeline.

## 7. Sequencing

1. **Backend, headless.** The machine card; the action schema and its
   parser; the system prompt file; `chat/turn`; `chat/render` through the
   one-node submit. A `tools/chat_bench.py` beside `refine_bench.py` runs a
   scripted conversation against any backend with no browser, and is where
   the system prompt is tuned per small model.
2. **The room.** Dashboard card, conversation, render cards wired to the
   queue events, the rail with the existing picker.
3. **Refine switch and skill append; Open in the editor; Retake.**

## 8. Risks

- **One GPU.** A local chat model and a render share it; the queue
  serialises them and the room shows it. Remote is the better setting on a
  small card, and the rail should say so.
- **A 4B model writing prompts without Refine** will produce short prompts
  and H3 rewards long ones. That is what the Refine switch and the skill
  append are for, and the bench will show how much they buy.
- **Expectation.** It will not feel like ChatGPT on a busy local GPU. The
  room should be honest about waiting rather than spin.
- **Family defaults** for a plain "make me a picture" are a product choice;
  seed them from `settings.weights` and let the rail change them.
