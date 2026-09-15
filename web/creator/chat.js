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
// back, and hold the few standing choices a turn is made against — in the
// composer's foot and behind the gear, with the node's own pills. It
// has no opinion about families, weights or durations, and it must not grow
// one — everything it knows about a family it reads off the served catalog.
//
// **The state is the page's, not the room's.** Leaving the room keeps the
// conversation; reloading starts fresh (§5.6). So it lives in `state` below
// rather than on the class, and a render in flight is watched by a module-level
// listener that outlives the overlay — a shot queued behind somebody else's
// render must still land in the ledger if you stepped out to the editor while
// it sampled.
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
import { outputUrl, upload, uiSetting, patchSettings, primeSettings, viewUrl } from "./api.js";
import { settings as refinerSettings, chosenModel, openSettings, listSkills, refineRequest } from "./refine.js";
import { FAMILIES, VIDEO_FAMILIES, DEFAULT_VIDEO_FAMILY, STILL_ARCHES,
         DEFAULT_STILL_ARCH, family as familyOf } from "./manifest.js";
import { run, watch as watchQueue } from "./queue.js";
import { t } from "./i18n.js";
import { api } from "../../../scripts/api.js";

/** Where a pasted or dropped file lands. Its own shelf under the input folder,
 *  so a picture brought into a conversation is findable afterwards as one. */
const UPLOADS = "continuity/chat";

/** The rail's choices, per machine. Everything on the rail is a property of
 *  this install rather than of any piece — which family, which shape, which
 *  policy — so it goes where the pack's other per-machine answers go. */
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
                     "executed", "execution_error", "execution_interrupted"];

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
  // Next handle per kind. Handles are never reused: `img-2` means one picture
  // for the life of the page even after it scrolls out of the ledger block.
  counts: { img: 0, vid: 0, aud: 0 },
  turn: 0,
  rail: null,
  railTouched: false,
  busy: false,
  // How far into its reply a queued turn is, as the refine button's token
  // counter. On the state rather than on the room for the same reason
  // everything else here is: the turn outlives the overlay.
  tokens: null,
  error: null,
};

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
const notify = () => open?.paint();

// ---- the rail ---------------------------------------------------------------

/** Every family that makes nothing but stills, which is the set the room can
 *  draw a picture with. A video family's still branch is a video generation
 *  under a blob of its own, and `routes/chat.py` offers the same set for the
 *  same reason. */
const stillFamilies = () =>
  FAMILIES.filter((entry) => (entry.produces ?? []).length === 1
                          && (entry.produces ?? [])[0] === "still");

const videoFamilies = () => VIDEO_FAMILIES.map(familyOf);

/** Whether a family can be handed the pictures cited in an action, and why not.
 *  The manifest's two keys, read exactly as `chat.takes_refs` reads them — the
 *  machine card already tells the model, and this is what tells the person. */
function takesPictures(entry) {
  if ((entry.capabilities?.refs ?? {}).needs_lora) return false;
  return Number(entry.prompt?.max_refs ?? 0) > 0;
}

/** The families this machine has picked weights for. What the rail opens on,
 *  because a family with files on the disk is the one that can actually
 *  render — the same seed `settings.weights` gives a freshly dropped node. */
const picked = () => Object.keys(uiSetting("weights", {}) ?? {});

function defaultRail() {
  const ready = picked();
  const still = stillFamilies();
  const video = videoFamilies();
  const shape = (video[0] ?? still[0])?.canvas ?? {};
  return {
    still_family: (still.find((entry) => ready.includes(entry.id))
                   ?? familyOf(STILL_ARCHES[DEFAULT_STILL_ARCH]) ?? still[0])?.id ?? "",
    video_family: (video.find((entry) => ready.includes(entry.id))
                   ?? familyOf(DEFAULT_VIDEO_FAMILY))?.id ?? "",
    aspect: shape.default_aspect ?? Object.keys(shape.aspects ?? {})[0] ?? "",
    // One short edge per kind, because they are not one number: a still is
    // drawn past 1024 on every family that draws one, and a clip at the video
    // family's trained edge. Each is the family's own default until touched.
    still_edge: PRESTAGE_DEFAULT_EDGE,
    video_edge: shape.native_short_edge ?? 768,
    turbo: false,
    seed: 0,
    seed_policy: "fixed",
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

// ---- the ledger -------------------------------------------------------------

/** What a file's handle looks like, by what kind of file it is. The prefixes
 *  are `chat._media_kind`'s and the server reads them back the same way. */
const PREFIX = { image: "img", video: "vid", audio: "aud" };

function nextHandle(media) {
  const prefix = PREFIX[media] ?? PREFIX.image;
  state.counts[prefix] = (state.counts[prefix] ?? 0) + 1;
  return `${prefix}-${state.counts[prefix]}`;
}

/**
 * Add one made or uploaded thing to the ledger. -> its entry.
 *
 * The shape is `chat.ledger_line`'s: a handle, what kind of thing it is, its
 * shape, which turn it happened on, the file behind it and the words that
 * describe it. Nothing else travels — pixels never enter the model's context,
 * which is what makes the handle the load-bearing part.
 */
function remember({ media, kind, aspect, filename, text }) {
  const entry = { handle: nextHandle(media), kind, aspect: aspect || "",
                  turn: state.turn, filename, text: text || "" };
  state.ledger.push(entry);
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
 *  assembled the way `refine.refine` assembles it, plus the rail's standing
 *  choices. One object, because the server reads the families and the turbo
 *  switch off the same block it reads the backend off — see `routes/chat._rail`. */
function requestBlock() {
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
    still_family: bar.still_family,
    video_family: bar.video_family,
    turbo: bar.turbo,
  };
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
      case "executed": {
        if (detail.prompt_id !== card.promptId) return;
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
  if (card.frameUrl) URL.revokeObjectURL(card.frameUrl);
  card.frameUrl = null;
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
  card.entry = remember({
    media: card.isClip ? "video" : "image",
    kind: card.isClip ? "clip" : "still",
    aspect: card.action.aspect || rail().aspect,
    filename: `${path} [${saved.type ?? "output"}]`,
    text: card.action.prompt,
  });
  notify();
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
    this.queue = { remaining: 0, running: false };
    this.skills = [];
    // Files picked or pasted but not yet sent. They ride the next message the
    // way an attachment does on any chat surface: shown in the composer, gone
    // from it on Enter, and in the transcript under the words they went with.
    this.pending = [];
  }

  mount() {
    this.log = keepScroll(el("div", { class: "mmc-ch-log" }));
    this.box = el("textarea", {
      class: "mmc-ch-box", rows: "1",
      placeholder: t("Ask for a picture or a shot…"),
      onkeydown: (event) => {
        if (event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        this.send();
      },
      oninput: () => this.grow(),
      onpaste: (event) => this.pasted(event),
    });
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
      this.box,
      el("div", { class: "mmc-ch-foot" }, [
        this.attachButton, this.pills, el("span", { class: "mmc-bn-gap" }), this.sendButton,
      ]),
    ]);
    this.talk = el("div", { class: "mmc-ch-talk" }, [
      this.log,
      el("div", { class: "mmc-ch-dock" }, [this.composer]),
    ]);
    this.modelHost = el("span", { class: "mmc-ch-model" });

    this.sheet = el("div", { class: "mmc-bn" }, [
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
      el("div", { class: "mmc-bn-room mmc-ch-room" }, [this.talk]),
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
      this.paint();
    });
    listSkills().then((entries) => {
      this.skills = entries;
      if (this.overlay.isConnected) this.paint();
    });

    this.paint();
    this.box.focus();
  }

  close() {
    if (open === this) open = null;
    this.unwatchQueue?.();
    this.unmount?.();
    this.resolve?.();
  }

  // ---- painting --------------------------------------------------------------

  paint() {
    this.paintLog();
    this.paintComposer();
    this.paintBar();
  }

  /** The transcript, rebuilt from the conversation.
   *
   *  Rebuilt rather than appended to because a render card changes as it runs —
   *  progress, a preview frame, a handle when it lands — and a card that is
   *  patched in place while the list is also being appended to is two ways of
   *  writing the same DOM. The list is short by construction and the scroll is
   *  kept by `keepScroll`. */
  paintLog() {
    const bottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 60;
    const rows = [];
    if (!state.messages.length) rows.push(this.emptyRoom());
    for (const message of state.messages) {
      if (message.role === "user") {
        rows.push(el("div", { class: "mmc-ch-msg mmc-ch-user" }, [
          el("div", { class: "mmc-ch-turn" }, [
            message.attached?.length
              ? el("div", { class: "mmc-ch-thumbs" }, message.attached.map((entry) => this.thumb(entry)))
              : null,
            message.text ? el("div", { class: "mmc-ch-said", text: message.text }) : null,
          ].filter(Boolean)),
        ]));
        continue;
      }
      if (message.say) {
        rows.push(el("div", { class: `mmc-ch-msg mmc-ch-bot${message.bad ? " mmc-ch-bad" : ""}` },
                     [el("div", { class: "mmc-ch-said", text: message.say })]));
      }
      if (message.card) rows.push(this.renderCard(message.card));
    }
    if (state.busy) {
      rows.push(el("div", { class: "mmc-ch-msg mmc-ch-bot" },
                   [el("div", { class: "mmc-ch-said mmc-ch-thinking" },
                       [spinner(), el("span", { text: this.thinking() })])]));
    }
    if (state.error) {
      rows.push(el("div", { class: "mmc-ch-msg mmc-ch-bot mmc-ch-bad" },
                   [el("div", { class: "mmc-ch-said", text: state.error })]));
    }
    this.log.replaceChildren(...rows);
    if (bottom) this.log.scrollTop = this.log.scrollHeight;
  }

  /** What an empty room says: a question, and three answers you can take as
   *  they are. Each is a first message on its own — a picture, a clip, a
   *  picture with a shape named — not steps of one conversation: a line like
   *  "now a clip of it" is nonsense as an opener. */
  emptyRoom() {
    const tries = [
      t("a fox in a snowy wood at dusk"),
      t("a clip of rain on a café window at night, a tram passing behind"),
      t("a portrait of an old lighthouse keeper, film still, 4:3"),
    ];
    return el("div", { class: "mmc-ch-empty" }, [
      el("h2", { text: t("What shall we make?") }),
      el("p", { text: t("Ask for a picture or a shot. Then ask for changes.") }),
      el("div", { class: "mmc-ch-tries" }, tries.map((line) => el("button", {
        class: "mmc-ch-try", text: line,
        onclick: () => { this.box.value = line; this.box.focus(); this.grow(); },
      }))),
    ]);
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
  renderCard(card) {
    const body = [];
    if (card.state === "done" && card.saved) {
      const url = outputUrl(card.saved);
      body.push(card.isClip
        ? el("video", { class: "mmc-ch-shot", src: url, controls: true,
                        loop: true, playsinline: true, preload: "metadata" })
        : el("img", { class: "mmc-ch-shot", src: url, alt: "", draggable: false }));
    } else if (card.frameUrl) {
      body.push(el("img", { class: "mmc-ch-shot", src: card.frameUrl, alt: "", draggable: false }));
    } else {
      body.push(el("div", { class: "mmc-ch-shot mmc-ch-blank" }, [spinner()]));
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
    this.box.disabled = state.busy;
    this.sendButton.disabled = state.busy || (!this.box.value.trim() && !this.pending.length);
    this.chips.hidden = !this.pending.length;
    this.chips.replaceChildren(...this.pending.map((asset) => this.chip(asset)));
    this.paintPills();
  }

  /** A file waiting in the composer. Its own picture and a way to change your
   *  mind, and nothing else: it has no handle yet, because it is not in the
   *  ledger until it is sent. */
  chip(asset) {
    const shown = asset.kind === "audio" ? null : asset.path;
    return el("div", { class: "mmc-ch-chip", title: asset.name || asset.path }, [
      shown
        ? el("img", { src: viewUrl(shown, { preview: true }), alt: "", draggable: false })
        : el("span", { class: "mmc-ch-sound" }, [icon("audio", 18)]),
      el("button", {
        class: "mmc-ch-unchip", title: t("Remove"),
        onclick: () => {
          this.pending = this.pending.filter((other) => other !== asset);
          this.paintComposer();
        },
      }, [icon("close", 11)]),
    ]);
  }

  /** The text box grows with what is in it, to a few lines, then scrolls. */
  grow() {
    this.box.style.height = "auto";
    this.box.style.height = `${Math.min(200, this.box.scrollHeight)}px`;
    this.sendButton.disabled = state.busy || (!this.box.value.trim() && !this.pending.length);
  }

  // ---- the choices ------------------------------------------------------------

  /** The bar's one changing thing: the model's name. */
  paintBar() {
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
      onclick: (event) => openSettings(event.currentTarget, () => this.paint(), rail().video_family),
    }, [
      el("span", { class: "mmc-ch-modelname", text: name }),
      icon("chevron", 12),
    ]));
  }

  /** What a message is made against, in the composer's foot: which family
   *  draws a picture, which makes a clip, and the shape. The shape is the
   *  simple view's own pill and grid — a person who has set one on the card
   *  should not meet a second way of setting one here. Size and seed are
   *  behind the gear: they are set once and left. */
  paintPills() {
    const bar = rail();
    const still = this.familyOr(bar.still_family, stillFamilies());
    const video = this.familyOr(bar.video_family, videoFamilies());
    const rules = rulesFor(video?.id ?? bar.video_family);
    const label = bar.aspect || rules.aspects[0]?.[0] || "";
    const ratio = rules.aspects.find(([name]) => name === label)?.[1] ?? 16 / 9;
    const pills = [
      this.pick("image", t("Pictures"), still, stillFamilies(), (id) => setRail({ still_family: id }),
                still && !takesPictures(still)
                  ? t("{family} draws from words alone — it cannot be given a picture to change.",
                      { family: t(still.label) })
                  : t("Which family draws a picture.")),
      this.pick("video", t("Clips"), video, videoFamilies(), (id) => setRail({ video_family: id }),
                t("Which family makes a clip.")),
      el("button", {
        class: "mmc-ch-pill", title: t("Aspect Ratio"),
        onclick: (event) => {
          // The popover writes onto a piece; this is the rail's two fields
          // wearing a piece's names, read back when it commits. Every family
          // here offers the same shapes, so the video family's list serves.
          const target = { family: video?.id ?? bar.video_family, aspect: label };
          openAspectPopover(event.currentTarget, target, () => setRail({ aspect: target.aspect }));
        },
      }, [aspectGlyph(ratio, 14), el("span", { text: label })]),
    ].filter(Boolean);
    this.pills.replaceChildren(...pills);
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
    const rules = still ? null : rulesFor(bar.video_family);
    const ratio = still ? null : (rules.aspects.find(([name]) => name === label)?.[1] ?? 16 / 9);
    const mark = still ? PRESTAGE_DEFAULT_EDGE : rules.nativeShortEdge;
    const target = { short_edge: Number(bar[`${kind}_edge`]) || mark };
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

  /** A family by id out of a list, or the first one. A rail remembered before a
   *  family was uninstalled must not leave the pill naming nothing. */
  familyOr(id, list) {
    return list.find((entry) => entry.id === id) ?? list[0] ?? null;
  }

  /** A family pill. The label is the manifest's — no family id is ever drawn,
   *  and none is ever written here either. */
  pick(glyph, label, chosen, options, onPick, title) {
    if (!options.length) return null;
    return el("button", {
      class: "mmc-ch-pill", title,
      onclick: (event) => openChoicePopover(event.currentTarget, {
        title: label,
        options: options.map((entry) => entry.id),
        value: chosen?.id,
        label: (id) => t(familyOf(id).label),
        onPick,
      }),
    }, [icon(glyph, 14), el("span", { text: chosen ? t(chosen.label) : t("none") })]);
  }

  /**
   * The gear: what is set once per machine and then left alone.
   *
   * The size of a picture and the size of a clip, each with its own slider
   * because they are different canvases; the seed, as the simple view's own
   * pill; turbo, the Refine switch and a skill to append. Redrawn in place on
   * every change: a popover that closed on each switch would be a popover
   * reopened six times to set six things.
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
      }, [icon("res", 16), el("span", { text: `${bar[`${kind}_edge`]}p` })]);
      pop.replaceChildren(
        el("div", { class: "mmc-pop-title", text: t("How this room renders") }),
        this.row(t("Picture size"), sizePill("still"),
                 t("The short edge a picture is drawn at.")),
        this.row(t("Clip size"), sizePill("video"),
                 t("The short edge a clip is sampled at.")),
        this.row(t("Seed"), el("span", { class: "mmc-ch-seed" }, seedPill({
          // The simple view's pill over the rail's two fields. `widgets.seed`
          // is only asked whether it exists; nothing was queued through a
          // widget, so there is no last seed to offer and the ghost never draws.
          widgets: { seed: true },
          value: (name, fallback) => name === "seed" ? Number(bar.seed) || 0
            : name === "control_after_generate" ? (bar.seed_policy === "random" ? "randomize" : "fixed")
            : fallback,
          set: (name, value) => {
            if (name === "seed") change({ seed: value, seed_policy: "fixed" });
            else if (name === "control_after_generate") {
              change({ seed_policy: value === "fixed" ? "fixed" : "random" });
            }
          },
        }))),
        el("div", { class: "mmc-ch-rule" }),
        this.toggle(t("Turbo"), bar.turbo, (on) => change({ turbo: on }),
                    t("Sample the still on the family's distilled checkpoint. It has to be "
                      + "picked in the weights, and the room says so if it is not.")),
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
      );
    };
    draw();
    document.body.appendChild(pop);
    placeNear(pop, anchor, { above: false });
    dismissable(pop);
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
    const text = this.box.value;
    this.box.value = `${text}${text && !text.endsWith(" ") ? " " : ""}@${entry.handle} `;
    this.box.focus();
    this.grow();
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
    const text = this.box.value.trim();
    if ((!text && !this.pending.length) || state.busy) return;
    this.box.value = "";
    this.grow();
    state.turn += 1;
    state.error = null;
    const attached = this.pending.map((asset) => remember({
      media: asset.kind || "image",
      kind: asset.kind === "video" ? "clip" : asset.kind === "audio" ? "sound" : "still",
      filename: asset.path,
      text: text || asset.name || asset.path,
    }));
    this.pending = [];
    state.messages.push({ role: "user", text, attached });
    if (!text) return this.paint();
    state.busy = true;
    this.paint();

    let turn;
    try {
      turn = await run("/continuity/chat/turn", {
        messages: forServer(),
        ledger: state.ledger,
        settings: requestBlock(),
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
   * `{problem}` is the assistant's line verbatim — a duration off the frame
   * grid, a checkpoint nobody picked, a rewrite the compiler will not take —
   * and is a bubble rather than an error: the model asked for something the
   * machine cannot do, which is a thing to say back, not a failure of the room.
   */
  async queueRender(action, message, over = {}) {
    const bar = { ...rail(), ...over };
    // Only a clip is refined — the families that draw a still have no prompt
    // refiner, and the server says the same — so a still's card never says
    // "Refining…" for a rewrite that is not going to happen.
    const refining = Boolean(bar.refine) && action.kind === "video";
    message.action = action;
    const card = { action, state: refining ? "refining" : "starting", progress: 0, tokens: null };
    message.card = card;
    notify();

    const said = (line) => {
      message.card = null;
      message.say = [message.say, line].filter(Boolean).join("\n\n");
      message.bad = true;
    };
    let answer;
    try {
      answer = await run("/continuity/chat/render", {
        action, ledger: state.ledger, rail: bar,
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
    card.promptId = answer.prompt_id;
    card.piece = answer.piece;
    card.refined = answer.refined || null;
    card.tokens = null;
    card.state = "queued";
    watchRender(card);
  }

  /** The same request again, on a new seed. A turn of its own, so the model
   *  reads it as one more thing it made and "bluer" after it is a delta on the
   *  take you were looking at. */
  async retake(card) {
    const message = { role: "assistant", say: t("Another take, on a new seed.") };
    state.turn += 1;
    state.messages.push(message);
    notify();
    await this.queueRender(card.action, message, { seed_policy: "random" });
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
    this.box.focus();
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

  /** Into the composer, not the ledger: it goes with the next message. */
  stage(asset) {
    if (this.pending.some((other) => other.path === asset.path)) return;
    this.pending.push(asset);
    this.paintComposer();
  }
}
