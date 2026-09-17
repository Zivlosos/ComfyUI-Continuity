// The chat room: ask for a picture or a shot, then ask for changes.
//
// The other tools in this pack are benches — a subject on the glass and dials
// around it. This one is a conversation, because what it replaces is not a
// dial: it is the whole business of opening the right node, filling the right
// rows and knowing which family reads which file before you can find out
// whether the idea was any good. Here the refiner model does that part, and
// what you do is talk.
//
// **The server does the thinking and this draws it.** `creator/chat.py` owns
// the action the model may answer with, the machine card, the ledger line and
// the two blob patches; `routes/chat.py` joins them to the disk and the queue.
// So this module has exactly three jobs: keep the conversation, show what came
// back, and hold the few choices that are the room's own — the shape and the
// two sizes, in the composer's foot and behind the gear. Everything else a
// render is made with is the nodes' under the room (`chatnode.js`): the
// family, the files, the stack, the turbo switch, the sampler row, the seed.
// A chat render is those nodes asked for this prompt in this shape, and the
// gear draws their own rows over their own blobs. This module has no opinion
// about families, weights or durations, and it must not grow one.
//
// **The state is the page's, not the room's — and the conversation is a
// file.** Leaving the room keeps the conversation; so does reloading, since
// every change is written to the shelf (`chatstore.js`) and the sidebar is
// the way back to it and to every one before it. The live state lives in
// `state` below rather than on the class, and a render in flight is watched
// by a module-level listener that outlives the overlay — a shot queued behind
// somebody else's render must still land in the ledger if you stepped out to
// the editor while it sampled, and in the *right* ledger if you opened another
// chat meanwhile: a card remembers the conversation it was queued from.
//
// **The turn and the render are two different waits.** A turn is one of this
// pack's own jobs and goes through `queue.run`, which resolves with the object
// whichever backend produced it. A render is an ordinary render — its
// `executed` is a save node's, not a `ContinuityJob`'s — so the card listens to
// the queue itself, exactly as `stage.js` does for the node on the canvas, and
// shows the real progress and the real preview frames rather than a spinner.

import { el, icon, mark, spinner, dragsFiles, mountOverlay, keepScroll, placeNear, dismissable } from "./dom.js";
import { openChoicePopover, openAspectPopover, edgeSlider, aspectGlyph } from "./pills.js";
import { seedPill } from "./sampling.js";
import { rulesFor, resolveCanvas } from "./canvas.js";
import { resolvedPreStage, PRESTAGE_CANVAS_MULTIPLE, PRESTAGE_MIN_EDGE, PRESTAGE_MAX_EDGE,
         PRESTAGE_DEFAULT_EDGE } from "./state.js";
import { openPicker } from "./picker.js";
import { outputUrl, upload, uiSetting, patchSettings, primeSettings,
         viewUrl } from "./api.js";
import { settings as refinerSettings, chosenModel, openSettings, listSkills, refineRequest } from "./refine.js";
import { FAMILIES } from "./manifest.js";
import { run, watch as watchQueue } from "./queue.js";
import { FirstRun, freshSetup, scanMachine } from "./chatsetup.js";
import { Sides } from "./chatnode.js";
import { castIntoPiece } from "./presets.js";
import { openPresetLibrary, styleCastMember } from "./presetlib.js";
import { PromptBox } from "./prompt.js";
import { listChats, loadChat, saveChat, renameChat, deleteChat, newId, pack, groupByDay,
         coverOf } from "./chatstore.js";
import { t } from "./i18n.js";
import { api } from "../../../scripts/api.js";

/** Where a pasted or dropped file lands. Its own shelf under the input folder,
 *  so a picture brought into a conversation is findable afterwards as one. */
const UPLOADS = "continuity/chat";

/** The rail's choices, per machine: the shape, the two sizes, the Refine
 *  switch and a skill. Properties of this install rather than of any piece,
 *  so they go where the pack's other per-machine answers go. */
const SETTING = "chat";

/** How many exchanges ride with a turn. `chat.MAX_EXCHANGES` trims again on the
 *  server; this keeps the request from carrying an hour of conversation to be
 *  thrown away at the far end. */
const EXCHANGES = 5;

/** The queue events a render card listens to. `stage.js`'s list, minus the ones
 *  that are about a node on the canvas: this card knows its prompt id, so it
 *  needs no `execution_start` to claim a run and no `mmc_segment` to say which
 *  card of a strip is encoding.
 *
 *  `mmc_refused` is not here, and deliberately: `queue.js` dispatches it for
 *  prompts *this tab* sent through `api.queuePrompt`, and a chat render is put
 *  on the queue by the server (`jobs.enqueue`). A refusal on the way there
 *  comes back as the route's own `{error}` or `{problem}` and is already a
 *  bubble by the time a card exists. */
const CARD_EVENTS = ["progress_state", "b_preview_with_metadata", "b_preview",
                     "kj_preview_override", "executed", "execution_error",
                     "execution_interrupted"];

/** The one node a chat prompt has — `routes/chat._build` builds `{"1": ...}` —
 *  so a preview from inside its expansion names `1.<something>`. */
const CHAT_NODE = "1";

/** Whether the sidebar is open, per browser. A choice about the window
 *  rather than the machine, so it is not in the settings file. */
const SIDE_KEY = "continuity-chat-side";

/** How long after the last change the conversation is written. The queue
 *  repaints on every step of a render; the file only changes when the
 *  transcript does, and `pack` drops the steps, so a save that compares
 *  before writing costs a `stringify` per tick and a write per turn. */
const SAVE_AFTER = 600;

/**
 * The conversation, for the life of the page.
 *
 * `messages` is both halves at once: it is what the screen draws *and* what
 * `chat.context` reads on the server, which is why an assistant turn carries
 * its action rather than a description of it. The card hanging off one is the
 * screen's alone and is stripped on the way out — see `forServer`.
 */
const state = {
  messages: [],
  ledger: [],
  // The clips joined so far: the piece's segments as the last strip render
  // built them, each held on its take and wearing its ledger handle under
  // `chat_handle`. A clip rendered without "after" starts a new strip.
  strip: [],
  // Next handle per kind. Handles are never reused: `pic-2` means one picture
  // for the life of the page even after it scrolls out of the ledger block.
  counts: { pic: 0, clip: 0, snd: 0 },
  turn: 0,
  rail: null,
  railTouched: false,
  busy: false,
  // How far into its reply a queued turn is, as the refine button's token
  // counter. On the state rather than on the room for the same reason
  // everything else here is: the turn outlives the overlay.
  tokens: null,
  error: null,
  // The first run, while it is being answered — see `chatsetup.js`. Null once
  // the card is in the transcript; the scan it was answered against is kept
  // apart so a "change" on the card re-asks one question without a second
  // walk of the model folders.
  setup: null,
  scan: null,
  // The conversation on the shelf this one is: `{id, title, created}`, or null
  // until the first message gives it a reason to exist. The title is the
  // index's; the room shows it in the bar and the sidebar edits it.
  chat: null,
  // Every saved conversation, as the index lists them, newest first — and
  // whether that list has been read yet, so an empty sidebar can say "nothing
  // saved" rather than "loading" forever.
  index: [],
  indexRead: false,
  side: null,
  // Which row is being renamed or asked about deleting, if any.
  editing: null,
  confirming: null,
};

/** The conversation as one object — what a card in flight keeps hold of, so
 *  a render that lands after you opened another chat is filed under the chat
 *  that asked for it. The arrays are the live ones, not copies: `newChat` and
 *  `openSaved` replace them on `state` rather than emptying them, so a home
 *  taken here stays whole. */
const home = () => ({ messages: state.messages, ledger: state.ledger, strip: state.strip,
                      counts: state.counts, chat: state.chat });

/** Whether the sidebar starts open: what was chosen last, else the width. */
function sideOpen() {
  if (state.side !== null) return state.side;
  try {
    const stored = localStorage.getItem(SIDE_KEY);
    if (stored !== null) return (state.side = stored === "1");
  } catch { /* denied */ }
  return (state.side = window.innerWidth >= 1100);
}

function setSide(on) {
  state.side = Boolean(on);
  try { localStorage.setItem(SIDE_KEY, on ? "1" : "0"); } catch { /* denied */ }
  open?.paintSide();
  open?.sheet.classList.toggle("mmc-ch-sideopen", state.side);
}

/** The room, or null. One at a time: it is the room. */
let open = null;

/**
 * Repaint whatever is on screen, if anything is.
 *
 * Everything that changes the conversation goes through this rather than
 * through the instance that started it, because the two need not be the same:
 * the render watchers outlive the overlay — a card that finished while you were
 * in the editor has to be there when you come back, and its ledger entry has to
 * be in the ledger — and a turn asked for in one room can land in the next.
 */
const notify = () => { open?.paint(); scheduleSave(); };

// ---- the shelf --------------------------------------------------------------

let saveTimer = null;
let lastWritten = "";

/** Write the conversation soon, if it changed. See `SAVE_AFTER`. */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveNow().catch(report); }, SAVE_AFTER);
}

/** The conversation onto the shelf, now. A chat with nothing said in it is
 *  not a chat and writes nothing; the first message makes it one. */
async function saveNow(where = home()) {
  const said = where.messages.some((message) => !message.local && message.role === "user");
  if (!said) return;
  const current = where.messages === state.messages;
  const body = JSON.stringify(pack(where));
  if (current && body === lastWritten) return;
  if (!where.chat) {
    where.chat = { id: newId(), title: "", created: Date.now() };
    if (where.messages === state.messages) state.chat = where.chat;
  }
  const line = await saveChat(where.chat, where);
  where.chat.title = line.title;
  if (current) lastWritten = body;
  state.index = [line, ...state.index.filter((entry) => entry.id !== line.id)];
  open?.paintSide();
  open?.paintBar();
}

function report(error) {
  state.error = String(error?.message || error);
  open?.paint();
}

/** The index, read once per page and again after anything that changes it. */
async function readIndex() {
  try {
    state.index = await listChats();
  } catch (error) {
    report(error);
  }
  state.indexRead = true;
  open?.paintSide();
}

/** Start over: the current conversation is on the shelf already (or was
 *  nothing), and the room opens on the question. */
function newChat() {
  if (state.busy) return;
  clearTimeout(saveTimer);
  saveNow().catch(report);
  reset();
  open?.paint();
  open?.box.root.focus();
}

/** The room on the question again, writing nothing. */
function reset() {
  clearTimeout(saveTimer);
  state.messages = [];
  state.ledger = [];
  state.strip = [];
  state.counts = { pic: 0, clip: 0, snd: 0 };
  state.turn = 0;
  state.chat = null;
  state.error = null;
  state.editing = null;
  state.confirming = null;
  lastWritten = "";
}

/**
 * Open a conversation from the shelf.
 *
 * The one now open is written first, so nothing said in it is lost to the
 * switch. A card that was mid-render when the chat was last left is settled
 * against the queue's history: finished, it lands as it would have; still
 * running, it is watched again; gone, it says so.
 */
async function openSaved(id) {
  if (state.busy || state.chat?.id === id) return;
  clearTimeout(saveTimer);
  await saveNow().catch(report);
  let body;
  try {
    body = await loadChat(id);
  } catch (error) {
    return report(error);
  }
  const line = state.index.find((entry) => entry.id === id);
  if (!body) {
    state.error = t("That chat is no longer on the shelf.");
    state.index = state.index.filter((entry) => entry.id !== id);
    return open?.paint();
  }
  state.messages = body.messages;
  state.ledger = body.ledger;
  state.strip = body.strip;
  state.counts = body.counts;
  state.turn = body.turn;
  state.chat = { id, title: line?.title ?? "", created: line?.created ?? Date.now() };
  state.error = null;
  state.editing = null;
  state.confirming = null;
  lastWritten = JSON.stringify(pack(home()));
  for (const message of state.messages) {
    if (message.card?.state === "left") settle(message.card, home());
  }
  if (open) {
    open.paint();
    open.log.scrollTop = open.log.scrollHeight;
    open.box.root.focus();
  }
}

/** A card that was left mid-render, against what the queue remembers. */
async function settle(card, where) {
  card.home = where;
  card.state = "queued";
  card.progress = 0;
  if (!card.promptId) return fail(card, t("The render was lost when the room was closed."));
  let record = null;
  try {
    const response = await api.fetchApi(`/history/${card.promptId}`);
    record = response.ok ? (await response.json())?.[card.promptId] ?? null : null;
  } catch { record = null; }
  if (!record) {
    // Not in the history: still on the queue, or a server that has been
    // restarted since. The queue says which — if it is there it will report,
    // and if nothing ever arrives the card stays queued, which is honest.
    return watchRender(card);
  }
  const status = record.status?.status_str;
  const output = Object.values(record.outputs ?? {}).find((node) => node.mmc_video || node.mmc_image);
  if (output) {
    card.takes = Object.values(record.outputs ?? {}).flatMap((node) => node.mmc_takes ?? []);
    card.isClip = Boolean(output.mmc_video);
    card.saved = (output.mmc_video ?? output.mmc_image)[0];
    card.state = "done";
    card.progress = 1;
    if (!card.entry) land(card);
    return notify();
  }
  const why = record.status?.messages?.find((m) => m[0] === "execution_error")?.[1]?.exception_message;
  return fail(card, status === "error" ? (why || t("the render failed")) : t("cancelled"));
}

function fail(card, message) {
  card.state = "failed";
  card.error = message;
  notify();
}

// ---- the rail ---------------------------------------------------------------

/** What the room keeps of its own. Everything a render is otherwise made with
 *  is the nodes' — see `chatnode.js` — unless a side is pinned, in which case
 *  the copy is here too. */
function defaultRail() {
  return {
    aspect: "",
    // The seed is the room's, not the node's: a conversation rolls or keeps
    // its own number, drawn as the simple view's die-and-mark pill. `fixed`
    // keeps it so "again, bluer" is the same noise with a different prompt;
    // `random` rolls a new one after every render.
    seed: Math.floor(Math.random() * 0xffffffff),
    seed_policy: "fixed",
    // A side's pinned copy, serialized as the node's widget holds it — empty
    // while the side follows the node. See `chatnode.Sides.pin`.
    pinned_still: "",
    pinned_video: "",
    // One short edge per kind, because they are not one number: a still is
    // drawn past 1024 on every family that draws one, and a clip at the video
    // family's trained edge. Each is the family's own default until touched.
    still_edge: PRESTAGE_DEFAULT_EDGE,
    video_edge: 0,
    // The spec's §5.1: the chat's prompt goes through the family's own
    // prompting before queueing. The route answers a sentence while it is on,
    // and the switch is here so that sentence is reachable rather than hidden.
    refine: false,
    // A file under the node's skills/ folder, appended to the room's own
    // prompting. Only ever appended — the room's reply contract is what turns
    // an answer into a render, so replacing it would leave nothing to queue.
    skill: "",
  };
}

/** The rail, loaded once from the settings and held for the page. */
function rail() {
  if (!state.rail) {
    const saved = uiSetting(SETTING, {}) ?? {};
    state.rail = { ...defaultRail(), ...saved };
    // A rail saved before the edge was split carried one number for both
    // kinds. It was the clip's — the still's default is its family's own.
    if (saved.short_edge && !saved.video_edge) state.rail.video_edge = saved.short_edge;
  }
  return state.rail;
}

function setRail(patch) {
  state.rail = { ...rail(), ...patch };
  state.railTouched = true;
  patchSettings({ [SETTING]: state.rail });
  notify();
}

/** The clip's short edge: the rail's, or the node's family's trained edge
 *  while nobody has moved it — which is the node's own default too. */
const clipEdge = (sides) => Number(rail().video_edge) || rulesFor(sides.videoFamily()).nativeShortEdge;

/** The rail as a render reads it, the clip's edge resolved. */
const railFor = (sides) => ({ ...rail(), video_edge: clipEdge(sides) });

// ---- the ledger -------------------------------------------------------------

/** What a file's handle looks like, by what kind of file it is. The prefixes
 *  are `chat._media_kind`'s and the server reads them back the same way.
 *  Not the node's `img`/`vid`/`aud`: a one-shot piece keeps its references
 *  on the shot's row under those, cast members' pictures included
 *  (`state.collapsePool`), and the row and the room's ledger meet in the
 *  model's context — so the room's handles are a namespace of their own. */
const PREFIX = { image: "pic", video: "clip", audio: "snd" };

function nextHandle(media, where = home()) {
  const prefix = PREFIX[media] ?? PREFIX.image;
  where.counts[prefix] = (where.counts[prefix] ?? 0) + 1;
  return `${prefix}-${where.counts[prefix]}`;
}

/**
 * Add one made or uploaded thing to the ledger. -> its entry.
 *
 * The shape is `chat.ledger_line`'s: a handle, what kind of thing it is, its
 * shape, which turn it happened on, the file behind it and the words that
 * describe it. Nothing else travels — pixels never enter the model's context,
 * which is what makes the handle the load-bearing part.
 */
function remember({ media, kind, aspect, filename, text, turn = state.turn }, where = home()) {
  const entry = { handle: nextHandle(media, where), kind, aspect: aspect || "",
                  turn, filename, text: text || "" };
  where.ledger.push(entry);
  return entry;
}

// ---- talking to the server --------------------------------------------------

/** A user turn as the model reads it: the words, and the handles of whatever
 *  went with them. The thumbnail is the screen's; the model only ever has the
 *  ledger line, and without this it would not know that "this coat" and the
 *  `img-2` that appeared on the same turn are one thing. */
function withAttached(message) {
  const handles = (message.attached ?? []).map((entry) => `@${entry.handle}`);
  if (!handles.length) return message.text;
  return `${message.text}\n(attached: ${handles.join(", ")})`;
}

/** The conversation as the server reads it: the last few exchanges, and nothing
 *  the screen hung onto them. */
function forServer() {
  const trimmed = [];
  let exchanges = 0;
  for (let at = state.messages.length - 1; at >= 0; at -= 1) {
    const message = state.messages[at];
    // The first run's bubbles are the room's own and say nothing the model
    // should read — the machine card already tells it what is set up.
    if (message.local) continue;
    if (message.role === "user") {
      exchanges += 1;
      if (exchanges > EXCHANGES) break;
    }
    trimmed.unshift(message.role === "user"
      ? { role: "user", text: withAttached(message) }
      : { role: "assistant", say: message.say ?? "", ...(message.action ? { action: message.action } : {}) });
  }
  return trimmed;
}

/** The block `chat/turn` takes as `settings`: the refiner's half of the request,
 *  assembled the way `refine.refine` assembles it, plus what the nodes under
 *  the room say. One object, because the server reads the families off the
 *  same block it reads the backend off — see `routes/chat._rail`. */
function requestBlock(sides) {
  const current = refinerSettings();
  const bar = rail();
  return {
    backend: current.backend === "remote" ? "remote" : "local",
    model: chosenModel(current),
    temperature: current.temperature,
    seed: current.seed,
    max_tokens: current.maxTokens,
    eject: current.backend === "remote" && current.eject === true,
    skill: bar.skill || "",
    // Always appended. The room offers no replace, so it says so rather than
    // letting a package's own declared mode decide and be refused.
    skill_mode: bar.skill ? "add" : "",
    ...sides.families(),
  };
}

/** An aspect label as CSS: "4:3" -> "4 / 3", and the room's default where the
 *  label is not one. */
function aspectOf(label) {
  const match = /^(\d+(?:\.\d+)?)\s*[:x\/]\s*(\d+(?:\.\d+)?)$/.exec(String(label ?? ""));
  return match ? `${match[1]} / ${match[2]}` : "16 / 9";
}

// ---- watching one render ----------------------------------------------------

/**
 * Follow one queued render until it lands, updating `card` in place.
 *
 * Module-level rather than on the room, because the render outlives the
 * overlay: leaving for the editor while a six-second shot samples must not cost
 * the ledger entry. The listeners come off the moment the card settles, so a
 * conversation of twenty renders is not twenty live handlers.
 */
function watchRender(card) {
  const handle = (type, detail) => {
    if (!detail) return;
    switch (type) {
      case "progress_state": {
        if (detail.prompt_id !== card.promptId) return;
        let best = null;
        for (const entry of Object.values(detail.nodes ?? {})) {
          if (entry.state !== "running") continue;
          if (!best || (entry.max ?? 0) > (best.max ?? 0)) best = entry;
        }
        if (!best?.max) return;
        card.state = "running";
        card.progress = Math.max(0, Math.min(1, (best.value ?? 0) / best.max));
        return notify();
      }
      case "b_preview_with_metadata":
        // Core's own previewer. No prompt id on it, so it is trusted on the
        // same terms `stage.js` trusts the bare frame: the queue runs one thing
        // at a time, and while this card is the one sampling every frame on the
        // wire is this card's.
        if (card.state !== "running") return;
        card.metaFrameAt = Date.now();
        return frame(card, detail.blob);
      case "b_preview": {
        if (card.state !== "running") return;
        // Stands down while the variant that carries a node id is flowing —
        // the same picture, named.
        if (card.metaFrameAt && Date.now() - card.metaFrameAt < 2000) return;
        return frame(card, detail instanceof Blob ? detail : detail.blob);
      }
      case "kj_preview_override": {
        // The pack's own previewer — `models.graph_preview` patches it onto
        // every render of ours and suppresses core's, so on a stock install
        // (previews off) this is the only frame that ever arrives. It names
        // the emitting node, which is ours plus a GraphBuilder prefix, the
        // way stage.js reads it; the queue runs one thing at a time, so the
        // running card is the one it belongs to.
        if (card.state !== "running") return;
        const id = String(detail.node_id ?? "");
        if (id !== CHAT_NODE && !id.startsWith(`${CHAT_NODE}.`)) return;
        if (Number.isFinite(detail.total) && detail.total > 0) {
          card.progress = Math.max(0, Math.min(1, (detail.step ?? 0) / detail.total));
        }
        if (!detail.image) return notify();
        release(card);
        card.frameUrl = `data:${detail.mime || "image/jpeg"};base64,${detail.image}`;
        // With NVENC the pack encodes the step clip as video/mp4, which an
        // <img> renders as a black box.
        card.frameIsClip = (detail.mime || "").startsWith("video/");
        return notify();
      }
      case "executed": {
        if (detail.prompt_id !== card.promptId) return;
        // The takes land before the reel does — each pass is written the
        // moment it exists (`ContinuityTake`) — and the strip's line for
        // this shot is its take, not the joined piece.
        if (detail.output?.mmc_takes) card.takes = [...(card.takes ?? []), ...detail.output.mmc_takes];
        const saved = detail.output?.mmc_video?.[0] ?? detail.output?.mmc_image?.[0];
        if (!saved) return;
        card.isClip = Boolean(detail.output?.mmc_video);
        card.saved = saved;
        card.state = "done";
        card.progress = 1;
        release(card);
        land(card);
        return stop();
      }
      case "execution_error":
        if (detail.prompt_id !== card.promptId) return;
        return fail(detail.exception_message || t("the render failed"));
      case "execution_interrupted":
        if (detail.prompt_id !== card.promptId) return;
        return fail(t("cancelled"));
      default:
    }
  };

  const fail = (message) => {
    card.state = "failed";
    card.error = message;
    release(card);
    stop();
    notify();
  };

  const listeners = CARD_EVENTS.map((name) => {
    const on = (event) => handle(name, event.detail);
    api.addEventListener(name, on);
    return () => api.removeEventListener(name, on);
  });
  const stop = () => { for (const off of listeners) off(); };
  card.stop = stop;
}

/** The last sampled frame, as something an `<img>` can show. The object URL of
 *  the frame before it is revoked here — one per step of a render otherwise
 *  leaks a blob per step for the life of the page. */
function frame(card, blob) {
  if (!blob) return;
  release(card);
  card.frameUrl = URL.createObjectURL(blob);
  notify();
}

function release(card) {
  if (card.frameUrl?.startsWith("blob:")) URL.revokeObjectURL(card.frameUrl);
  card.frameUrl = null;
  card.frameIsClip = false;
}

/**
 * A finished render becomes a line in the ledger.
 *
 * The filename is the gallery's annotated form — `"sub/name.png [output]"` —
 * which is what `media.resolve` reads on the way back in, so the next turn can
 * cite this render as a reference and the compiler finds the file.
 */
function land(card) {
  const saved = card.saved;
  const path = saved.subfolder ? `${saved.subfolder}/${saved.filename}` : saved.filename;
  // Into the conversation that asked for it, which is not always the one
  // open: see `home`. The turn is the card's own, kept on it when it was
  // queued, so a chat reopened later still numbers the render on the turn
  // that made it.
  const where = card.home ?? home();
  // A clip is a shot on the strip. The piece the server built has the kept
  // shots in front and this one last; its take is the file the ledger cites
  // and the next shot continues from, and the joined piece is what the card
  // plays. A shot with no take reported keeps the joined file, and the next
  // "after" it is refused by name rather than continued from the wrong tail.
  const segments = card.isClip ? (card.piece?.segments ?? []) : [];
  const last = segments.length - 1;
  const take = card.isClip
    ? (card.takes ?? []).find((report) => Number(report.segment) === last + 1) : null;
  const shot = take ? `${[take.subfolder, take.filename].filter(Boolean).join("/")} [output]` : null;
  card.entry = remember({
    media: card.isClip ? "video" : "image",
    kind: card.isClip ? "clip" : "still",
    aspect: card.action.aspect || card.piece?.aspect || rail().aspect,
    filename: shot ?? `${path} [${saved.type ?? "output"}]`,
    text: card.action.prompt,
    turn: card.turn ?? state.turn,
  }, where);
  if (card.isClip && last >= 0) {
    where.strip.length = 0;
    where.strip.push(...segments.map((segment, index) => index !== last ? segment : {
      ...segment, chat_handle: card.entry.handle,
      ...(take ? { hold: true, take: {
        filename: shot, duration_s: Number(take.duration_s) || 0,
        ...(take.width && take.height ? { width: Number(take.width), height: Number(take.height) } : {}),
        has_audio: take.has_audio !== false,
      } } : {}),
    }));
  }
  if (where.messages !== state.messages) saveNow(where).catch(report);
  notify();
}

/** The ledger as the box's "attached" list: what `@` offers first. */
function ledgerAssets() {
  const media = { still: "image", clip: "video", sound: "audio" };
  return state.ledger.map((entry) => ({
    handle: entry.handle, filename: entry.filename, kind: media[entry.kind] ?? "image",
  }));
}

/** The piece's shelf, a one-shot piece's own row included — mirrors
 *  `chat._shelf`, which is what the render puts on the shelf. */
function shelfOf(piece) {
  if (!piece) return [];
  const pool = [...(piece.assets ?? [])];
  const held = new Set(pool.map((asset) => asset.handle));
  if ((piece.segments ?? []).length === 1) {
    for (const asset of piece.segments[0].assets ?? []) {
      if (asset?.handle && !held.has(asset.handle)) pool.push(asset);
    }
  }
  return pool;
}

/** The strip as the model is told it: each shot's handle and length. */
function stripSummary() {
  return state.strip.filter((segment) => segment.chat_handle).map((segment) => ({
    handle: segment.chat_handle, seconds: Number(segment.take?.duration_s ?? segment.duration_s) || 0,
  }));
}

// ---- the room ---------------------------------------------------------------

/**
 * Open the room.
 *
 * @param {object} [options]
 * @param {Function} [options.back]  where the wordmark goes, as every bench's
 *   does: called after the room closes. Absent means the wordmark is not a door.
 * @param {Function} [options.openRender]  `async ({path, kind}) => void` — put a
 *   finished render's own setup onto the piece's node and go to it. Absent
 *   disables that door rather than half-wiring it.
 * @param {Function} options.node  the piece's node under the room;
 *   `options.preStage` the pre-stage beside it or null, `options.spawnPreStage`
 *   puts one there — see `chatnode.Sides`.
 * @returns {Promise<void>}  resolves when the room is closed
 */
export function openChat(options = {}) {
  open?.close();
  return new Promise((resolve) => {
    open = new Room(options, resolve);
    open.mount();
  });
}

class Room {
  constructor(options, resolve) {
    this.resolve = resolve;
    this.back = options.back ?? null;
    this.openRender = options.openRender ?? null;
    this.sides = new Sides({ ...options, rail, setRail });
    this.queue = { remaining: 0, running: false };
    this.skills = [];
    // Files picked or pasted but not yet sent. They ride the next message the
    // way an attachment does on any chat surface: shown in the composer, gone
    // from it on Enter, and in the transcript under the words they went with.
    this.pending = [];
    this.firstRun = new FirstRun({
      setup: () => state.setup,
      rail, setRail, sides: this.sides,
      said: (key, ask, answer) => this.setupSaid(ask, answer),
      finish: () => this.finishSetup(),
      repaint: () => this.paint(),
      openEdge: (anchor, kind, onChange) => this.openEdge(anchor, kind, onChange),
      familyLabel: (id) => FAMILIES.find((entry) => entry.id === id)?.label ?? id,
    });
  }

  mount() {
    this.log = keepScroll(el("div", { class: "mmc-ch-log" }));
    // The node's own prompt box, over the room's things: `@` cites what the
    // conversation has made or attached and what the piece holds on its
    // shelf and in its cast, `/` brings in a look, somebody from the cast
    // library or a file. A member cast here lands on the piece — the node's,
    // or the room's pinned copy — exactly as one cast in the node's box does,
    // and the model reads the name back as the citation it is.
    this.box = new PromptBox({
      placeholder: t("Ask for a picture or a shot…"),
      getState: () => ({ assets: ledgerAssets() }),
      onInput: () => this.paintSend(),
      onSubmit: () => this.send(),
      // A file out of the input folder, named in the `@` menu: staged as the
      // paperclip stages one, with its handle minted now so the chip resolves.
      onAttach: (row) => this.stage(row)?.entry?.handle ?? null,
      attachBlocked: () => null,
      getPool: () => shelfOf(this.sides.piece()),
      getCast: () => this.sides.piece()?.subjects ?? [],
      castFromLibrary: (member) => this.castOntoPiece(member),
      castStyle: (row) => this.castOntoPiece(styleCastMember(row, 0)),
      castVoice: (member) => this.castOntoPiece(member),
      openLibrary: (scope) => {
        const target = this.sides.presetTarget();
        if (!target) return;
        openPresetLibrary({ target, scope }).then(() => this.paintComposer());
      },
      onBrowse: () => this.browse(),
    });
    this.box.root.classList.add("mmc-ch-box");
    this.box.root.addEventListener("paste", (event) => this.pasted(event), true);
    this.attachButton = el("button", {
      class: "mmc-ch-tool", title: t("Add a picture, a clip or a sound"),
      onclick: () => this.browse(),
    }, [icon("plus", 18)]);
    this.sendButton = el("button", {
      class: "mmc-ch-send", title: t("Send"),
      onclick: () => this.send(),
    }, [icon("arrowUp", 18)]);
    this.chips = el("div", { class: "mmc-ch-chips" });
    this.pills = el("div", { class: "mmc-ch-pills" });
    // Built once and never rebuilt. A repaint that replaced the box would take
    // the caret out of it, and the queue's `status` arrives on every step of
    // every render — which is to say, in the middle of every sentence anybody
    // types while something is sampling. The pills and chips inside it are
    // hosts that repaint on their own.
    this.composer = el("div", { class: "mmc-ch-compose" }, [
      this.chips,
      this.box.root,
      el("div", { class: "mmc-ch-foot" }, [
        this.attachButton, this.pills, el("span", { class: "mmc-bn-gap" }), this.sendButton,
      ]),
    ]);
    this.talk = el("div", { class: "mmc-ch-talk" }, [
      this.log,
      el("div", { class: "mmc-ch-dock" }, [this.composer]),
    ]);
    this.modelHost = el("span", { class: "mmc-ch-model" });
    this.titleHost = el("span", { class: "mmc-ch-title" });
    // The shelf: every conversation, and the way to a new one. Painted on its
    // own — the list changes when a chat is saved, renamed or deleted, not on
    // every step of a render.
    this.sideList = keepScroll(el("div", { class: "mmc-ch-sidelist" }));
    this.side = el("aside", { class: "mmc-ch-side" }, [
      el("div", { class: "mmc-ch-sidehead" }, [
        el("button", {
          class: "mmc-ch-new", title: t("Start a new chat"),
          onclick: () => { newChat(); if (this.narrow()) setSide(false); },
        }, [icon("plus", 16), el("span", { text: t("New chat") })]),
      ]),
      this.sideList,
    ]);
    // Under the drawer on a narrow window, so a press outside it closes it.
    this.scrim = el("div", { class: "mmc-ch-scrim", onclick: () => setSide(false) });

    this.sheet = el("div", { class: `mmc-bn${sideOpen() ? " mmc-ch-sideopen" : ""}` }, [
      el("div", { class: "mmc-bn-bar" }, [
        // The wordmark is the door, exactly as it is on every bench: the same
        // mark in the same corner, and somewhere that reads as the way out has
        // to be the way out.
        this.back
          ? el("button", {
              class: "mmc-bn-home", title: t("Back to the tools"),
              onclick: () => { this.close(); this.back(); },
            }, [
              el("span", { class: "mmc-bn-logo" }, [mark(20)]),
              el("span", { text: "Continuity" }),
              el("span", { class: "mmc-bn-caret" }, [icon("chevron", 12)]),
            ])
          : el("span", { class: "mmc-bn-mark" }, [
              el("span", { class: "mmc-bn-logo" }, [mark(20)]),
              el("span", { class: "mmc-bn-word", text: "Continuity" }),
            ]),
        el("span", { class: "mmc-bn-slash", text: "/" }),
        el("span", { class: "mmc-bn-here", text: t("Chat") }),
        this.titleHost,
        el("button", {
          class: "mmc-ch-sidetoggle", title: t("Your chats"),
          "aria-pressed": sideOpen(),
          onclick: (event) => {
            setSide(!state.side);
            event.currentTarget.setAttribute("aria-pressed", state.side);
          },
        }, [icon("panel", 17)]),
        el("span", { class: "mmc-bn-gap" }),
        // Which model is talking, where ChatGPT puts it: in the bar, one quiet
        // name. Everything that is set once per machine and then left alone is
        // behind the gear beside it, so the composer holds only what changes
        // from one message to the next.
        this.modelHost,
        el("button", {
          class: "mmc-ch-gear", title: t("How this room renders"),
          onclick: (event) => this.openMore(event.currentTarget),
        }, [icon("gear", 17)]),
        el("button", {
          class: "mmc-close", text: "✕", title: t("Close the room"),
          onclick: () => this.close(),
        }),
      ]),
      el("div", { class: "mmc-bn-room mmc-ch-room" }, [this.side, this.scrim, this.talk]),
    ]);

    this.overlay = el("div", {
      class: "mmc-overlay mmc-bn-over mmc-ch-over",
      // A file dropped anywhere in the room joins the next message — the
      // gesture is "here, look at this", and asking somebody to aim it at a
      // well in the corner is asking them to find the target first.
      ondragover: (event) => {
        if (!dragsFiles(event)) return;
        event.preventDefault();
        this.overlay.classList.add("dropping");
      },
      ondragleave: (event) => {
        if (event.target === this.overlay) this.overlay.classList.remove("dropping");
      },
      ondrop: (event) => {
        if (!dragsFiles(event)) return;
        event.preventDefault();
        this.overlay.classList.remove("dropping");
        for (const file of event.dataTransfer?.files ?? []) this.attach(file);
      },
    }, [this.sheet]);

    this.unmount = mountOverlay(this.overlay, () => this.close());
    // What else has the GPU. A local chat waits behind a render and a render
    // waits behind whatever the canvas queued first; the room says so rather
    // than spinning (§8).
    this.unwatchQueue = watchQueue((queue) => {
      const moved = queue.remaining !== this.queue.remaining
                 || queue.running !== this.queue.running;
      this.queue = queue;
      // Only the transcript, and only when the answer changed. `status` fires on
      // every step of every render; a composer rebuilt that often would close a
      // popover under the pointer once a second.
      if (moved && this.overlay.isConnected) this.paintLog();
    });
    // The rail's choices and the remembered weights both come off the settings
    // file, and the room can be opened before anything else on the page has
    // asked for it. So the rail is re-read once the file lands — unless
    // something on it has been changed since, because a choice made in the
    // first second of a room is still a choice.
    primeSettings(() => {
      if (!this.overlay.isConnected) return;
      if (!state.railTouched) state.rail = null;
      // A machine nobody has answered the three questions on gets them now,
      // as the room's own first messages — unless a conversation is already
      // under way, which a room reopened mid-page is.
      if (!rail().setup && !state.setup && !state.messages.length) this.startSetup();
      this.paint();
    });
    listSkills().then((entries) => {
      this.skills = entries;
      if (this.overlay.isConnected) this.paint();
    });
    if (!state.indexRead) readIndex();
    // The composer's family pills read the nodes, and a family moved under the
    // gear — or on the canvas, in another tab of the shell — has to show.
    this.unfollow = this.sides.follow(() => { if (this.overlay.isConnected) this.paintPills(); });

    this.paint();
    this.box.root.focus();
  }

  /** Whether the sidebar is a drawer over the transcript rather than beside
   *  it — the stylesheet's own breakpoint, read back. */
  narrow() {
    return window.innerWidth < 960;
  }

  close() {
    if (open === this) open = null;
    this.unfollow?.();
    this.unwatchQueue?.();
    this.unmount?.();
    this.resolve?.();
  }

  // ---- painting --------------------------------------------------------------

  paint() {
    this.paintLog();
    this.paintComposer();
    this.paintBar();
    this.paintSide();
  }

  // ---- the shelf ---------------------------------------------------------------

  /** The sidebar: a new chat, then every saved one under its day. */
  paintSide() {
    const rows = [];
    if (!state.index.length) {
      rows.push(el("p", { class: "mmc-ch-sidenote",
        text: state.indexRead ? t("Nothing saved yet. Your first message starts a chat.") : "" }));
    }
    for (const [heading, entries] of groupByDay(state.index)) {
      rows.push(el("div", { class: "mmc-ch-day", text: t(heading) }));
      for (const entry of entries) rows.push(this.sideRow(entry));
    }
    this.sideList.replaceChildren(...rows);
  }

  /** One conversation: its title, and the last thing it made. Hovering shows
   *  the two things you can do to it; the row itself opens it. */
  sideRow(entry) {
    const current = state.chat?.id === entry.id;
    if (state.editing === entry.id) return this.renameRow(entry);
    if (state.confirming === entry.id) return this.confirmRow(entry);
    const cover = entry.cover
      ? el("span", { class: "mmc-ch-cover" }, [
          el("img", { src: viewUrl(entry.cover, { preview: true }), alt: "",
                      loading: "lazy", draggable: false }),
          entry.coverKind === "clip" ? el("span", { class: "mmc-ch-coverclip" }, [icon("play", 10)]) : null,
        ].filter(Boolean))
      : el("span", { class: "mmc-ch-cover mmc-ch-nocover" });
    const busy = state.busy && !current;
    return el("div", { class: `mmc-ch-siderow${current ? " on" : ""}`, "data-id": entry.id }, [
      el("button", {
        class: "mmc-ch-sideopenbtn", disabled: busy || undefined,
        title: busy ? t("Wait for the reply before switching chats.")
             : entry.renders ? t("{count} renders", { count: entry.renders }) : entry.title,
        onclick: () => { openSaved(entry.id); if (this.narrow()) setSide(false); },
      }, [
        el("span", { class: "mmc-ch-sidetitle", text: entry.title || t("New chat") }),
        cover,
      ]),
      el("span", { class: "mmc-ch-sideacts" }, [
        el("button", {
          class: "mmc-ch-sideact", title: t("Rename"),
          onclick: (event) => { event.stopPropagation(); state.confirming = null;
                                state.editing = entry.id; this.paintSide(); },
        }, [icon("pen", 14)]),
        el("button", {
          class: "mmc-ch-sideact", title: t("Delete"),
          onclick: (event) => { event.stopPropagation(); state.editing = null;
                                state.confirming = entry.id; this.paintSide(); },
        }, [icon("trash", 14)]),
      ]),
    ]);
  }

  /** The title as a box. Enter keeps it, Escape does not, leaving does. */
  renameRow(entry) {
    const box = el("input", {
      class: "mmc-ch-sidebox", type: "text", value: entry.title, spellcheck: "false",
      onkeydown: (event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        if (event.key === "Escape") { event.preventDefault(); cancel(); }
      },
      onblur: () => commit(),
    });
    let done = false;
    const cancel = () => { if (done) return; done = true; state.editing = null; this.paintSide(); };
    const commit = async () => {
      if (done) return;
      done = true;
      state.editing = null;
      const title = box.value.replace(/\s+/g, " ").trim();
      if (!title || title === entry.title) return this.paintSide();
      try {
        const line = await renameChat(entry.id, title);
        if (line) {
          entry.title = line.title;
          if (state.chat?.id === entry.id) state.chat.title = line.title;
        }
      } catch (error) {
        report(error);
      }
      this.paintSide();
      this.paintBar();
    };
    const row = el("div", { class: "mmc-ch-siderow mmc-ch-renaming" }, [box]);
    queueMicrotask(() => { box.focus(); box.select(); });
    return row;
  }

  /** The question in the row's own place, with the two answers. The renders
   *  are not touched: they are files in the output folder and this is a
   *  conversation about them. */
  confirmRow(entry) {
    const back = () => { state.confirming = null; this.paintSide(); };
    return el("div", { class: "mmc-ch-siderow mmc-ch-confirming" }, [
      el("span", { class: "mmc-ch-sidetitle", text: t("Delete this chat?"),
                   title: t("Its renders stay in the output folder.") }),
      el("span", { class: "mmc-ch-sideacts on" }, [
        el("button", {
          class: "mmc-ch-sideact mmc-ch-sidedel", text: t("Delete"),
          onclick: async () => {
            state.confirming = null;
            try {
              await deleteChat(entry.id);
            } catch (error) {
              return report(error);
            }
            state.index = state.index.filter((other) => other.id !== entry.id);
            if (state.chat?.id === entry.id) {
              // The one open: the room starts over without writing, or the
              // next autosave would put the line straight back.
              reset();
              return this.paint();
            }
            this.paintSide();
          },
        }),
        el("button", { class: "mmc-ch-sideact mmc-ch-sidekeep", text: t("Keep"), onclick: back }),
      ]),
    ]);
  }

  /** The transcript, drawn from the conversation.
   *
   *  The list is rebuilt — a render card changes as it runs, and a card patched
   *  in place while the list is also being appended to is two ways of writing
   *  the same DOM — but each message's rows are kept between paints unless
   *  what they show has changed (`rowKey`). Rebuilding every row on every
   *  step of a render meant every finished picture was a fresh <img> loading
   *  from nothing once a second: the transcript shrank, the scroll clamped,
   *  and the room jumped to the last render on each tick. The scroll is
   *  otherwise kept by `keepScroll`, and pinned to the bottom only when it
   *  was already there. */
  paintLog() {
    const bottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 60;
    const rows = [];
    if (!state.messages.length && !state.setup) rows.push(this.emptyRoom());
    this.rows ??= new Map();
    const seen = new Set();
    const flight = this.lastInFlight();
    state.messages.forEach((message, index) => {
      seen.add(message);
      const key = this.rowKey(message, index, flight);
      const kept = this.rows.get(message);
      if (kept && kept.key === key) { rows.push(...kept.nodes); return; }
      const nodes = [];
      if (message.role === "user") {
        nodes.push(el("div", { class: "mmc-ch-msg mmc-ch-user" }, [
          el("div", { class: "mmc-ch-turn" }, [
            message.attached?.length
              ? el("div", { class: "mmc-ch-thumbs" }, message.attached.map((entry) => this.thumb(entry)))
              : null,
            message.text ? el("div", { class: "mmc-ch-said", text: message.text }) : null,
          ].filter(Boolean)),
          message.local ? null : this.acts([
            ["pen", t("Edit and send again"), () => this.edit(index)],
          ], index, flight),
        ].filter(Boolean)));
      } else {
        if (message.say) {
          nodes.push(el("div", { class: `mmc-ch-msg mmc-ch-bot${message.bad ? " mmc-ch-bad" : ""}` }, [
            el("div", { class: "mmc-ch-said", text: message.say }),
            message.local ? null : this.acts([
              // A reply that refused its own render is asked to render again,
              // not to think again: the model's answer stood, the machine did not.
              ...(message.bad && message.action
                ? [["rewind", t("Try the render again"), () => this.retry(message)]] : []),
              ["turnLeft", t("Ask again from here"), () => this.again(index)],
            ], index, flight),
          ].filter(Boolean)));
        }
        if (message.card) nodes.push(this.renderCard(message.card, message));
      }
      this.rows.set(message, { key, nodes });
      rows.push(...nodes);
    });
    for (const message of this.rows.keys()) if (!seen.has(message)) this.rows.delete(message);
    if (state.setup) rows.push(this.firstRun.render());
    if (state.busy) {
      rows.push(el("div", { class: "mmc-ch-msg mmc-ch-bot" },
                   [el("div", { class: "mmc-ch-said mmc-ch-thinking" },
                       [spinner(), el("span", { text: this.thinking() })])]));
    }
    if (state.error) {
      // The turn failed before there was a reply: the last message is the
      // person's, and asking again is asking it again.
      const last = state.messages.length - 1;
      const askable = last >= 0 && state.messages[last].role === "user" && !state.messages[last].local;
      rows.push(el("div", { class: "mmc-ch-msg mmc-ch-bot mmc-ch-bad" }, [
        el("div", { class: "mmc-ch-fail" }, [
          el("div", { class: "mmc-ch-said", text: state.error }),
          askable ? el("button", {
            class: "mmc-ch-door", text: t("Ask again"),
            title: t("Send the same message again."),
            onclick: () => this.again(last + 1),
          }) : null,
        ].filter(Boolean)),
      ]));
    }
    this.log.replaceChildren(...rows);
    if (bottom) this.log.scrollTop = this.log.scrollHeight;
  }

  /** The verbs under a message, shown under the pointer. Disabled rather
   *  than hidden while the transcript cannot be cut there — a verb that
   *  comes and goes is one you cannot find. */
  acts(verbs, index, flight) {
    const can = this.cuttable(index, flight);
    return el("div", { class: "mmc-ch-acts" }, verbs.map(([glyph, title, run]) => el("button", {
      class: "mmc-ch-act", title, disabled: can ? null : true, onclick: run,
    }, [icon(glyph, 14)])));
  }

  /** Everything a message's rows show, as one string: equal means the rows
   *  standing are still right. A user turn changes only in whether it can be
   *  taken back; an assistant turn with its line and with every step of its card. */
  rowKey(message, index, flight) {
    const can = this.cuttable(index, flight);
    if (message.role === "user") return `user:${can}`;
    const card = message.card;
    return JSON.stringify([
      message.say, message.bad, message.action?.kind, can,
      card && [card.state, card.progress, card.frameUrl, card.frameIsClip, card.tokens?.value,
               card.saved, card.refined, card.error, card.entry?.handle, card.isClip,
               card.state === "queued" ? this.queue.remaining : 0, Boolean(this.openRender)],
    ]);
  }

  /** What an empty room says: a question, and three answers you can take as
   *  they are. Each is a first message on its own — a picture, a clip, a
   *  picture with a shape named — not steps of one conversation: a line like
   *  "now a clip of it" is nonsense as an opener. */
  emptyRoom() {
    return el("div", { class: "mmc-ch-empty" }, [
      el("h2", { text: t("What shall we make?") }),
      el("p", { text: t("Ask for a picture or a shot. Then ask for changes.") }),
      this.tries(),
    ]);
  }

  /** The three first messages, as buttons. */
  tries() {
    const tries = [
      t("a fox in a snowy wood at dusk"),
      t("a clip of rain on a café window at night, a tram passing behind"),
      t("a portrait of an old lighthouse keeper, film still, 4:3"),
    ];
    return el("div", { class: "mmc-ch-tries" }, tries.map((line) => el("button", {
      class: "mmc-ch-try", text: line,
      onclick: () => { this.box.setValue(line); this.box.root.focus(); },
    })));
  }

  // ---- the first run -------------------------------------------------------------

  /** Ask the three questions, from the top. `again` is the gear's "Set up
   *  again": the same run over a room that was already set up, with a fresh
   *  look at the disk. */
  startSetup(again = false) {
    if (again) setRail({ setup: false });
    state.setup = freshSetup();
    state.scan = null;
    this.lookAtMachine();
    this.paint();
  }

  /** The scan lands into whichever run is open when it arrives — the room
   *  may have been closed and reopened while the folders were walked. */
  async lookAtMachine() {
    try {
      state.scan = await scanMachine();
      if (state.setup) state.setup.scan = state.scan;
    } catch (error) {
      if (state.setup) state.setup.scanError = String(error.message || error);
    }
    notify();
  }

  /** One question and its answer, as two bubbles of the room's own. */
  setupSaid(ask, answer) {
    state.messages.push({ role: "assistant", say: ask, local: true });
    state.messages.push({ role: "user", text: answer, local: true });
  }

  /** The run is over: the rail says so, and the room opens as it always
   *  does — the question, the three tries, the composer. The exchange is not
   *  kept: it was the room's, not the conversation's, and what was decided is
   *  on the pills and behind the gear, where it can be changed. "Set up again"
   *  in the gear asks the three questions afresh. */
  finishSetup() {
    setRail({ setup: true });
    state.setup = null;
    state.messages = state.messages.filter((message) => !message.local);
    this.paint();
    this.box.root.focus();
  }


  /** What the room is waiting for, said honestly. A local turn is a model on
   *  the same card the renders want, so "thinking" is a lie while it is third
   *  in a queue. */
  thinking() {
    if (state.tokens?.max) {
      return t("Writing — {value}/{max} tokens",
               { value: state.tokens.value, max: state.tokens.max });
    }
    const ahead = Math.max(0, this.queue.remaining - 1);
    if (ahead > 0) return t("Waiting — {count} ahead on the queue", { count: ahead });
    return t("Thinking…");
  }

  /** One render, from the moment it is queued to the file it becomes. */
  renderCard(card, message) {
    const body = [];
    // The box has the render's shape before there is a render: the picture
    // arrives into the space it was always going to take, and a step frame of
    // another shape does not push the conversation about.
    const shape = { aspectRatio: aspectOf(card.action?.aspect ?? rail().aspect) };
    if (card.state === "done" && card.saved) {
      const url = outputUrl(card.saved);
      body.push(card.isClip
        ? el("video", { class: "mmc-ch-shot", src: url, controls: true,
                        loop: true, playsinline: true, preload: "metadata" })
        : el("img", { class: "mmc-ch-shot", src: url, alt: "", draggable: false }));
    } else if (card.frameUrl && card.frameIsClip) {
      const clip = el("video", { class: "mmc-ch-shot", src: card.frameUrl, autoplay: true,
                                 loop: true, playsinline: true, preload: "metadata", style: shape });
      clip.muted = true;
      body.push(clip);
    } else if (card.frameUrl) {
      // One <img> for the life of the render, its src moved per step: a new
      // element per frame is a box with nothing in it until the frame decodes.
      card.frameEl ??= el("img", { class: "mmc-ch-shot", alt: "", draggable: false, style: shape });
      if (card.frameEl.src !== card.frameUrl) card.frameEl.src = card.frameUrl;
      body.push(card.frameEl);
    } else {
      body.push(el("div", { class: "mmc-ch-shot mmc-ch-blank", style: shape }, [spinner()]));
    }

    const note = card.state === "failed" ? card.error
      : card.state === "done" ? null
      : card.state === "running" ? t("Rendering…")
      : card.state === "refining"
        ? (card.tokens?.value
            ? t("Refining… {count} tokens", { count: card.tokens.value })
            : t("Refining…"))
      : card.state === "starting" ? t("Starting…")
      : this.queue.remaining > 1
        ? t("Queued — {count} ahead", { count: this.queue.remaining - 1 })
        : t("Queued");
    if (note) body.push(el("div", { class: `mmc-ch-note${card.state === "failed" ? " mmc-ch-bad" : ""}`,
                                    text: note }));
    if (card.state === "done" && card.refined) {
      // What the sampler actually read is under the hover, whole: the room has
      // no panel to edit a rewrite in, and Open in the editor is where that is.
      const wrote = card.refined.skill
        ? t("Refined by {model} with {skill}", { model: card.refined.model, skill: card.refined.skill })
        : t("Refined by {model}", { model: card.refined.model });
      body.push(el("div", { class: "mmc-ch-note", text: wrote,
                            title: card.piece?.segments?.[0]?.refined?.body || "" }));
      for (const problem of card.refined.problems ?? []) {
        body.push(el("div", { class: "mmc-ch-note mmc-ch-bad", text: problem }));
      }
    }
    if (card.state === "running" || card.state === "queued") {
      body.push(el("div", { class: "mmc-ch-bar" },
                   [el("span", { class: "mmc-ch-fill",
                                 style: { width: `${Math.round((card.progress ?? 0) * 100)}%` } })]));
    }
    if (card.state === "failed") {
      body.push(el("div", { class: "mmc-ch-doors" }, [
        el("span", { class: "mmc-bn-gap" }),
        el("button", {
          class: "mmc-ch-door", text: t("Try again"),
          title: t("The same request again, on the nodes as they are set now."),
          disabled: state.busy || null,
          onclick: () => this.retry(message),
        }),
      ]));
    }
    if (card.entry && card.isClip && (card.piece?.segments?.length ?? 0) > 1) {
      body.push(el("div", { class: "mmc-ch-note", text: t("Shot {n} of the strip — the clip plays all {n}.", {
        n: card.piece.segments.length }) }));
    }
    if (card.entry) {
      body.push(el("div", { class: "mmc-ch-doors" }, [
        el("button", {
          class: "mmc-ch-handle", text: `@${card.entry.handle}`,
          title: t("Cite this in what you say next."),
          onclick: () => this.cite(card.entry),
        }),
        el("span", { class: "mmc-bn-gap" }),
        el("button", {
          class: "mmc-ch-door",
          text: t("Open in the editor"),
          disabled: !this.openRender || undefined,
          title: this.openRender
            ? t("Put this render's own setup onto the piece and go to it.")
            : t("There is no piece open to put this on — the room was opened on its own."),
          onclick: () => this.handOver(card),
        }),
        el("button", {
          class: "mmc-ch-door", text: t("Retake"),
          title: t("The same request again, on a new seed."),
          onclick: () => this.retake(card),
        }),
      ]));
    }
    return el("div", { class: "mmc-ch-msg mmc-ch-bot" },
                 [el("div", { class: "mmc-ch-card" }, body)]);
  }

  /** One attached thing in a message: the picture, and the handle the model
   *  knows it by. Pressing it cites it — the same door the render card has. */
  thumb(entry) {
    const shown = entry.handle.startsWith(PREFIX.audio) ? null : entry.filename;
    return el("button", {
      class: "mmc-ch-thumb", title: `@${entry.handle} · ${entry.text}`,
      onclick: () => this.cite(entry),
    }, [
      shown
        ? el("img", { src: viewUrl(shown, { preview: true }), alt: "",
                      loading: "lazy", draggable: false })
        : el("span", { class: "mmc-ch-sound" }, [icon("audio", 18)]),
      el("span", { class: "mmc-ch-tag", text: `@${entry.handle}` }),
    ]);
  }


  /** The composer's changing parts: whether it can be used, what is waiting
   *  to go with the next message, and the three choices a message is made
   *  against. */
  paintComposer() {
    // Closed while the first run is being answered: a message sent before the
    // room has a model to think with is a message answered with a refusal.
    const asking = Boolean(state.setup);
    this.box.root.contentEditable = state.busy || asking ? "false" : "true";
    this.box.root.classList.toggle("mmc-ch-off", state.busy || asking);
    this.box.root.dataset.placeholder = asking ? t("Answer above first") : t("Ask for a picture or a shot…");
    this.paintSend();
    this.chips.hidden = !this.pending.length;
    this.chips.replaceChildren(...this.pending.map((asset) => this.chip(asset)));
    if (asking) {
      const answered = Object.keys(state.setup.answers).length;
      this.pills.replaceChildren(el("span", { class: "mmc-ch-setupnote",
        text: t("Setting up · {n} of {all}", { n: answered, all: 3 }) }));
      return;
    }
    this.paintPills();
  }

  /** A file waiting in the composer: its picture, the handle it already has
   *  — minted when it was staged, so the sentence can cite it — and a way to
   *  change your mind, which takes the handle back out of the ledger. */
  chip(asset) {
    const shown = asset.kind === "audio" ? null : asset.path;
    return el("div", { class: "mmc-ch-chip", title: `@${asset.entry.handle} · ${asset.name || asset.path}` }, [
      shown
        ? el("img", { src: viewUrl(shown, { preview: true }), alt: "", draggable: false })
        : el("span", { class: "mmc-ch-sound" }, [icon("audio", 18)]),
      el("button", {
        class: "mmc-ch-unchip", title: t("Remove"),
        onclick: () => this.unstage(asset),
      }, [icon("close", 11)]),
    ]);
  }

  /** Whether there is anything to send. */
  paintSend() {
    const asking = Boolean(state.setup);
    this.sendButton.disabled = state.busy || asking
      || (!this.box.getValue().trim() && !this.pending.length);
  }

  /**
   * Somebody — or a look, or a voice — cast onto the piece from the box's
   * menus. Onto the shelf rather than the shot's row, whatever shape the
   * piece is in: the room's render replaces the row with the conversation's
   * card, and the row's own handles are the ledger's to mint. The piece is
   * committed — written to the node, or saved as the room's copy — so the
   * member is there for the render and there on the node's own shelf.
   */
  castOntoPiece(member) {
    const piece = this.sides.piece();
    if (!piece) return null;
    const subject = castIntoPiece(member, piece, { pool: true });
    if (!subject) return null;
    this.sides.commitPiece();
    return subject.handle;
  }

  // ---- the choices ------------------------------------------------------------

  /** The bar's two changing things: which chat this is, and the model's name. */
  paintBar() {
    const title = state.chat?.title || "";
    this.titleHost.replaceChildren(...(title ? [
      el("span", { class: "mmc-bn-slash", text: "/" }),
      el("button", {
        class: "mmc-ch-titlebtn", text: title, title: t("Rename this chat"),
        onclick: () => { state.confirming = null; state.editing = state.chat.id;
                         if (!state.side) setSide(true); this.paintSide(); },
      }),
    ] : []));
    const current = refinerSettings();
    const local = current.backend !== "remote";
    const name = chosenModel(current) || t("Choose a model");
    this.modelHost.replaceChildren(el("button", {
      class: "mmc-ch-modelpill",
      title: local
        ? t("A model in this ComfyUI. It shares the card with your renders, so a "
            + "reply waits behind whatever is sampling — a server is the better "
            + "setting on one GPU.")
        : t("A model on a server you already run."),
      onclick: (event) => openSettings(event.currentTarget, () => this.paint(), this.sides.videoFamily()),
    }, [
      el("span", { class: "mmc-ch-modelname", text: name }),
      icon("chevron", 12),
    ]));
  }

  /** What a message is made against, in the composer's foot: which model
   *  draws a picture, which makes a clip — the nodes' own pills — and the
   *  shape, which is the room's. Size and the sampler rows are behind the
   *  gear: they are set once and left. */
  paintPills() {
    const bar = rail();
    const rules = rulesFor(this.sides.videoFamily());
    const label = bar.aspect || rules.aspects[0]?.[0] || "";
    const ratio = rules.aspects.find(([name]) => name === label)?.[1] ?? 16 / 9;
    this.pills.replaceChildren(...[
      this.sides.picturePill(),
      this.sides.clipPill(),
      el("button", {
        class: "mmc-ch-pill", title: t("Aspect Ratio"),
        onclick: (event) => {
          // The popover writes onto a piece; this is the rail's field wearing
          // a piece's names, read back when it commits. Every family here
          // offers the same shapes, so the video family's list serves.
          const target = { family: this.sides.videoFamily(), aspect: label };
          openAspectPopover(event.currentTarget, target, () => setRail({ aspect: target.aspect }));
        },
      }, [aspectGlyph(ratio, 14), el("span", { text: label })]),
      // The simple view's pill over the rail's two fields. `widgets.seed` is
      // only asked whether it exists; nothing was queued through a widget, so
      // there is no last seed to offer and the ghost never draws.
      ...seedPill({
        widgets: { seed: true },
        value: (name, fallback) => {
          if (name === "seed") return Number(bar.seed) || 0;
          if (name === "control_after_generate") return bar.seed_policy === "random" ? "randomize" : "fixed";
          return fallback;
        },
        set: (name, value) => {
          if (name === "seed") setRail({ seed: value });
          else if (name === "control_after_generate") setRail({ seed_policy: value === "fixed" ? "fixed" : "random" });
        },
      }),
    ].filter(Boolean));
  }

  /**
   * The short-edge slider for one kind — the pack's own control, alone.
   *
   * Two of these, because a picture and a clip are drawn on different canvases
   * with different ceilings: the still's is the pre-stage's (the image
   * families share one block), the clip's is the video family's. The node's
   * resolution popover carries a second section — two passes, a finishing
   * backend — that the room's blob does not send, so it is not offered here.
   */
  openEdge(anchor, kind, onChange) {
    const bar = rail();
    const label = bar.aspect || "16:9";
    const still = kind === "still";
    const rules = still ? null : rulesFor(this.sides.videoFamily());
    const ratio = still ? null : (rules.aspects.find(([name]) => name === label)?.[1] ?? 16 / 9);
    const mark = still ? PRESTAGE_DEFAULT_EDGE : rules.nativeShortEdge;
    const target = { short_edge: still ? Number(bar.still_edge) || mark : clipEdge(this.sides) };
    const size = () => {
      if (still) {
        const { width, height } = resolvedPreStage({ aspect: label, short_edge: target.short_edge });
        return [width, height];
      }
      return resolveCanvas(ratio, target.short_edge, rules);
    };
    const body = edgeSlider({
      min: still ? PRESTAGE_MIN_EDGE : rules.minShortEdge,
      max: still ? PRESTAGE_MAX_EDGE : rules.maxShortEdge,
      step: still ? PRESTAGE_CANVAS_MULTIPLE : rules.multiple,
      value: target.short_edge, mark, markLabel: still ? "default" : "native",
      apply: (edge) => { target.short_edge = edge; },
      describe: () => {
        const [width, height] = size();
        const over = !still && target.short_edge > mark;
        return {
          size: `${width} × ${height}`,
          warn: over,
          note: still
            ? (target.short_edge === mark
                ? t("The image families' default. Higher is slower and sharper.")
                : t("Short edge of the picture. Higher is slower and sharper."))
            : over
              ? t("Above the trained {edge} px short edge — off-distribution, not just slower.",
                  { edge: mark })
              : target.short_edge === mark
                ? t("Native. What the open weights were trained at.")
                : t("{ratio}× smaller short edge than native — faster, softer.",
                    { ratio: (mark / target.short_edge).toFixed(1) }),
        };
      },
      commit: () => onChange(target.short_edge),
    });
    const pop = el("div", { class: "mmc-pop mmc-slider" }, [body]);
    document.body.appendChild(pop);
    placeNear(pop, anchor);
    dismissable(pop);
  }

  /**
   * The gear: how this room renders.
   *
   * Two sections, one per node: the size a picture is drawn at and the
   * pre-stage's own sampler row; the size a clip is sampled at and the
   * piece's. The rows are the nodes' — `chatnode.Sides` calls the same
   * functions the faces mount over the same blobs — so a step count dialled
   * here is on the node and a switch thrown on the node is lit here. Under
   * them, the room's own two: the Refine switch and a skill to append.
   * Redrawn in place on every change, and whenever either node redraws.
   */
  openMore(anchor) {
    const pop = el("div", { class: "mmc-pop mmc-ch-more" });
    const draw = () => {
      const bar = rail();
      const change = (patch) => { setRail(patch); draw(); };
      const sizePill = (kind) => el("button", {
        class: "mmc-pill mmc-ch-value",
        onclick: (event) => this.openEdge(event.currentTarget, kind,
                                          (edge) => change({ [`${kind}_edge`]: edge })),
      }, [icon("res", 16), el("span", { text: `${kind === "still" ? bar.still_edge : clipEdge(this.sides)}p` })]);
      const head = (text, kind) => el("div", { class: "mmc-ch-gearhead" }, [
        el("span", { text }), el("span", { class: "mmc-bn-gap" }),
        this.sides.pinPill(kind, () => { draw(); this.paintPills(); }), sizePill(kind)]);
      const pictureRow = this.sides.pictureRow(draw);
      pop.replaceChildren(
        head(t("Pictures"), "still"),
        pictureRow ?? el("button", {
          class: "mmc-ch-ask", text: t("Add a pre-stage"),
          title: t("A picture is drawn by a pre-stage beside the piece. There is none yet; the room's first picture would add one."),
          onclick: async () => { await this.sides.pictureBody(); draw(); },
        }),
        head(t("Clips"), "video"),
        this.sides.clipRow(draw) ?? el("div", { class: "mmc-ch-note", text: t("There is no piece under this room.") }),
        el("div", { class: "mmc-ch-rule" }),
        this.toggle(t("Refine"), bar.refine, (on) => change({ refine: on }),
                    t("Put the model's prompt for a clip through the family's own prompting "
                      + "before queueing, as the Refine button does — a second model call "
                      + "per render, with the refiner's own settings. A still goes as written: "
                      + "the families that draw one have no prompt refiner.")),
        this.row(t("Skill"), el("button", {
          class: "mmc-pill mmc-ch-value", text: bar.skill || t("none"),
          onclick: (event) => openChoicePopover(event.currentTarget, {
            title: t("Append to the room's prompting"),
            options: ["", ...this.skills.map((entry) => entry.name)],
            value: bar.skill || "",
            label: (name) => name || t("none"),
            onPick: (name) => change({ skill: name }),
          }),
        }), t("A file from the node's skills folder, added to this room's own "
              + "prompting. It is only ever added: the room's reply contract is "
              + "what turns an answer into a render.")),
        el("div", { class: "mmc-ch-rule" }),
        this.row(t("First run"), el("button", {
          class: "mmc-pill mmc-ch-value", text: t("Set up again"),
          disabled: state.setup ? true : null,
          onclick: () => { pop.close(); this.startSetup(true); },
        }), t("Ask the three questions the room opened with again, with a fresh "
              + "look at what is on this disk.")),
      );
    };
    draw();
    document.body.appendChild(pop);
    placeNear(pop, anchor, { above: false });
    // A node redrawing is a row that may have moved under the pointer — a
    // switch thrown from a pill the editor owns, an arch swapped.
    const unfollow = this.sides.follow(() => { if (pop.isConnected) draw(); });
    pop.close = dismissable(pop, unfollow);
  }

  /** One line of the gear: what it is, and the control. */
  row(label, control, title) {
    return el("div", { class: "mmc-ch-row", title }, [
      el("span", { class: "mmc-ch-label", text: label }),
      control,
    ]);
  }

  toggle(label, on, onChange, title) {
    return this.row(label, el("button", {
      class: `mmc-pill mmc-ch-value${on ? " accel-on" : ""}`,
      "aria-checked": Boolean(on),
      text: on ? t("on") : t("off"),
      onclick: () => onChange(!on),
    }), title);
  }

  /** Put a handle in the box. Citing is how an edit is asked for, and the
   *  handle on a thumbnail is what there is to press. */
  cite(entry) {
    this.box.root.focus();
    this.box.insertChip(entry.handle);
  }

  // ---- the turn ---------------------------------------------------------------

  /**
   * Send what is in the composer: the words, and whatever was attached.
   *
   * The attachments become ledger lines first, on this turn, and the message
   * that goes to the server names them — the model has to know that "this
   * coat" and `img-2` are the same thing, and it cannot see the thumbnail. A
   * message of attachments alone is remembered and shown but asks nothing:
   * a file that now exists is a thing to talk about on the next turn, not a
   * turn.
   */
  async send() {
    const text = this.box.getValue().trim();
    if ((!text && !this.pending.length) || state.busy || state.setup) return;
    this.box.setValue("");
    state.turn += 1;
    state.error = null;
    // The attachments were remembered when they were staged, under the turn
    // this message was going to be; they are that turn's now, and the words
    // they went with are their description where they had none of their own.
    const attached = this.pending.map((asset) => {
      const entry = asset.entry;
      entry.turn = state.turn;
      if (!entry.text || entry.text === (asset.name || asset.path)) entry.text = text || entry.text;
      if (!state.ledger.includes(entry)) state.ledger.push(entry);
      return entry;
    });
    this.pending = [];
    state.messages.push({ role: "user", text, attached, turn: state.turn });
    if (!text) return this.paint();
    await this.ask();
  }

  /** Ask the model about the conversation as it stands, and hang its answer
   *  — and the render it asked for — on the end of it. */
  async ask() {
    state.busy = true;
    state.error = null;
    this.paint();

    let turn;
    try {
      turn = await run("/continuity/chat/turn", {
        messages: forServer(),
        ledger: state.ledger,
        strip: stripSummary(),
        // The piece, for its cast and its shelf: the names and the handles
        // the person can write with the `@` menu, which the model has to be
        // told and the validator has to accept. The server reads both off
        // the blob (`chat.cast_entries`, `chat.shelf_entries`).
        piece: this.sides.base("video")?.piece ?? null,
        settings: requestBlock(this.sides),
      }, {
        // The token counter the refine button already shows. Only the queued
        // backend reports one — a remote call answers inside the request and
        // ticks nothing — so its absence is the honest state rather than a bar
        // that sits at zero.
        onProgress: (_fraction, value, max) => {
          state.tokens = { value, max };
          notify();
        },
      });
    } catch (error) {
      state.tokens = null;
      state.busy = false;
      state.error = String(error.message || error);
      return notify();
    }
    state.tokens = null;
    state.busy = false;

    const message = { role: "assistant", say: turn.say || "" };
    state.messages.push(message);
    notify();
    if (turn.action) await this.queueRender(turn.action, message);
    notify();
  }

  // ---- going back ----------------------------------------------------------------
  //
  // A conversation is not all or nothing. A message can be taken back and
  // said differently, a reply can be asked for again, a render that failed
  // can be tried again — each from where it happened, with what came after
  // it dropped, because what came after was an answer to what is being
  // changed. The ledger goes with it: a picture made on a turn that is no
  // longer in the conversation is not a picture the model should be offered.
  // Handles are never reused, so nothing that was cited elsewhere goes stale.

  /** Whether the transcript can be cut at `index`: not while the model is
   *  writing, and not above a render still in flight. `flight` is
   *  `lastInFlight()`, passed in by a paint that asks for every row. */
  cuttable(index, flight = this.lastInFlight()) {
    if (state.busy) return false;
    return index > flight;
  }

  /** The index of the last message whose render is still on the queue, or -1. */
  lastInFlight() {
    return state.messages.findLastIndex((message) =>
      message.card && !["done", "failed"].includes(message.card.state));
  }

  /** Cut the conversation back to before `index`. */
  truncate(index) {
    const cut = state.messages.slice(index);
    state.messages.length = index;
    const turns = cut.map((message) => message.turn ?? message.card?.turn).filter(Boolean);
    if (turns.length) {
      const first = Math.min(...turns);
      state.ledger = state.ledger.filter((entry) => entry.turn < first);
      const kept = new Set(state.ledger.map((entry) => entry.handle));
      state.strip = state.strip.filter((segment) => kept.has(segment.chat_handle));
      state.turn = first - 1;
    }
    state.error = null;
  }

  /** Take a message back into the composer, with what went with it, and
   *  drop everything from it on. Sending is what commits the change. */
  edit(index) {
    if (!this.cuttable(index)) return;
    const message = state.messages[index];
    this.truncate(index);
    // The attachments come back under the handles they had — the sentence
    // cites them by those — and into the ledger, so the chips resolve; the
    // turn is the message's again when it is sent.
    const media = Object.fromEntries(Object.entries(PREFIX).map(([kind, prefix]) => [prefix, kind]));
    this.pending = (message.attached ?? []).map((entry) => {
      if (!state.ledger.includes(entry)) state.ledger.push(entry);
      return { path: entry.filename, name: entry.filename.split("/").pop(),
               kind: media[entry.handle.split("-")[0]] ?? "image", entry };
    });
    this.box.setValue(message.text ?? "");
    this.paint();
    this.box.root.focus();
  }

  /** Ask again from the reply at `index`: it and everything after it go, and
   *  the model answers the same message afresh. */
  async again(index) {
    if (!this.cuttable(index)) return;
    this.truncate(index);
    await this.ask();
  }

  /** The same action on the same reply, after a render that failed. */
  async retry(message) {
    if (state.busy || !message.action) return;
    message.bad = false;
    if (message.said !== undefined) message.say = message.said;
    await this.queueRender(message.action, message);
    notify();
  }

  /**
   * Queue one render and hang a card off the turn that asked for it.
   *
   * Through `run`, because the answer comes one of two ways and that helper
   * already reads both: `{result}` when the render went straight onto the
   * queue, or a job's `prompt_id` when the Refine switch is on and the in-
   * process refiner has to rewrite the prompt first — GPU work, so the rewrite
   * and the render ride the queue as one job and the object arrives on
   * `executed`. The card exists from the first moment either way, so the wait
   * for a rewrite has somewhere to show: the refine button's token counter,
   * under "Refining…".
   *
   * The render is the node under the room (or the side's pinned copy), asked
   * for this: its blob and its sampler widgets go with the request as the
   * `base`, and the seed is the room's own — kept, or rolled on after the
   * render the way the frontend's control rolls a widget after a queue. A
   * picture with no pre-stage to draw it spawns one first — a picture is a
   * pre-stage's to make.
   *
   * `{problem}` is the assistant's line verbatim — a duration off the frame
   * grid, a checkpoint nobody picked, a rewrite the compiler will not take —
   * and is a bubble rather than an error: the model asked for something the
   * machine cannot do, which is a thing to say back, not a failure of the room.
   */
  async queueRender(action, message, over = {}) {
    const bar = railFor(this.sides);
    const kind = action.kind === "still" ? "still" : "video";
    // Only a clip is refined — the families that draw a still have no prompt
    // refiner, and the server says the same — so a still's card never says
    // "Refining…" for a rewrite that is not going to happen.
    const refining = Boolean(bar.refine) && action.kind === "video";
    message.action = action;
    const card = { action, state: refining ? "refining" : "starting", progress: 0, tokens: null,
                   home: home(), turn: state.turn };
    message.card = card;
    notify();

    // The refusal goes under the model's own line, which is kept apart so a
    // second try does not stack a second refusal under the first.
    const said = (line) => {
      message.card = null;
      message.said ??= message.say;
      message.say = [message.said, line].filter(Boolean).join("\n\n");
      message.bad = true;
    };
    if (kind === "still" && !(await this.sides.pictureBody())) {
      return said(t("There is no pre-stage to draw a picture with, and one could not be added."));
    }
    const base = this.sides.base(kind);
    if (!base) return said(t("There is no node under this room to render with."));
    base.widgets.seed = over.seed ?? (Number(bar.seed) || 0);
    let answer;
    try {
      answer = await run("/continuity/chat/render", {
        action, ledger: state.ledger, strip: state.strip, rail: bar, base,
        piece: this.sides.base("video")?.piece ?? null,
        ...(refining ? { refine: refineRequest() } : {}),
      }, {
        onProgress: (_fraction, value, max) => {
          card.tokens = { value, max };
          notify();
        },
      });
    } catch (error) {
      return said(String(error.message || error));
    }
    if (!answer || answer.problem) return said(answer?.problem || t("the server queued nothing"));
    if (over.seed === undefined && bar.seed_policy === "random") {
      setRail({ seed: Math.floor(Math.random() * 0xffffffff) });
    }
    card.promptId = answer.prompt_id;
    card.piece = answer.piece;
    card.refined = answer.refined || null;
    card.tokens = null;
    card.state = "queued";
    watchRender(card);
  }

  /** The same request again, on a new seed. A turn of its own, so the model
   *  reads it as one more thing it made and "bluer" after it is a delta on the
   *  take you were looking at. The rail's seed is not moved: a retake is a
   *  different roll of this request, not a change of what the room samples on. */
  async retake(card) {
    const message = { role: "assistant", say: t("Another take, on a new seed.") };
    state.turn += 1;
    state.messages.push(message);
    notify();
    await this.queueRender(card.action, message, { seed: Math.floor(Math.random() * 0xffffffff) });
    notify();
  }

  /** Put a finished render's own setup onto the piece's node and go to it. */
  async handOver(card) {
    if (!this.openRender || !card.saved) return;
    const path = card.saved.subfolder
      ? `${card.saved.subfolder}/${card.saved.filename}` : card.saved.filename;
    try {
      await this.openRender({ path, kind: card.isClip ? "video" : "image" });
      // Closed, and not back to the dashboard: the door has already moved the
      // shell to the step it wrote onto, and putting the cards up over it would
      // be taking the user somewhere they did not ask to go.
      this.close();
    } catch (error) {
      state.error = String(error.message || error);
      notify();
    }
  }

  // ---- attachments -------------------------------------------------------------

  /** The plus. The pack's own picker — the input folder by kind, the renders,
   *  its upload button — rather than the browser's file dialog: a picture that
   *  was already brought in for the node, or rendered by it, is a picture
   *  already here, and the picker is where everything else in this pack finds
   *  those. */
  async browse() {
    const chosen = await openPicker({
      kinds: ["image", "video", "audio", "renders"], kind: "image",
    });
    if (!chosen?.length) return;
    for (const asset of chosen) this.stage(asset);
    this.box.root.focus();
  }

  pasted(event) {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) this.attach(file);
  }

  /** A pasted or dropped file: uploaded to the room's own shelf, then staged
   *  like anything the picker chose. */
  async attach(file) {
    try {
      this.stage(await upload(file, UPLOADS));
    } catch (error) {
      state.error = String(error.message || error);
      notify();
    }
  }

  /**
   * Into the composer, and into the ledger under the turn the next message
   * will be — its handle is minted now so the sentence can cite it, and the
   * `@` menu lists it with everything else that is here. -> the staged
   * asset, or the one already waiting under that path.
   */
  stage(asset) {
    const waiting = this.pending.find((other) => other.path === asset.path);
    if (waiting) return waiting;
    const staged = { ...asset, entry: remember({
      media: asset.kind || "image",
      kind: asset.kind === "video" ? "clip" : asset.kind === "audio" ? "sound" : "still",
      filename: asset.path,
      text: asset.name || asset.path,
      turn: state.turn + 1,
    }) };
    this.pending.push(staged);
    this.paintComposer();
    return staged;
  }

  /** Out of the composer and out of the ledger: a handle nobody sent is a
   *  handle nobody made. The chip in the sentence, if any, is left to the
   *  person — it reads as text once the handle is gone. */
  unstage(asset) {
    this.pending = this.pending.filter((other) => other !== asset);
    state.ledger = state.ledger.filter((entry) => entry !== asset.entry);
    this.paintComposer();
    this.box.refresh?.();
  }
}
