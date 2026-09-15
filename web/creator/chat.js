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
// back, and give the rail the few standing choices a turn is made against. It
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

import { el, icon, mark, spinner, dragsFiles, mountOverlay, keepScroll } from "./dom.js";
import { openChoicePopover, stepperPill } from "./pills.js";
import { outputUrl, upload, uiSetting, patchSettings, primeSettings, viewUrl } from "./api.js";
import { settings as refinerSettings, chosenModel, openSettings, listSkills } from "./refine.js";
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
    short_edge: shape.native_short_edge ?? shape.default_short_edge ?? 768,
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
  if (!state.rail) state.rail = { ...defaultRail(), ...(uiSetting(SETTING, {}) ?? {}) };
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
      ? { role: "user", text: message.text }
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
    this.clip = el("button", {
      class: "mmc-ch-clip", title: t("Attach a picture or a clip"),
      onclick: () => this.browse(),
    }, [icon("link", 16)]);
    this.sendButton = el("button", {
      class: "mmc-ch-send", title: t("Send"),
      onclick: () => this.send(),
    }, [icon("play", 16)]);
    // Built once and never rebuilt. A repaint that replaced the box would take
    // the caret out of it, and the queue's `status` arrives on every step of
    // every render — which is to say, in the middle of every sentence anybody
    // types while something is sampling.
    this.composer = el("div", { class: "mmc-ch-compose" },
                       [this.clip, this.box, this.sendButton]);
    this.talk = el("div", { class: "mmc-ch-talk" }, [this.log, this.composer]);
    this.side = keepScroll(el("div", { class: "mmc-ch-rail" }));

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
        el("button", {
          class: "mmc-close", text: "✕", title: t("Close the room"),
          onclick: () => this.close(),
        }),
      ]),
      // The conversation leads and the rail is beside it, which is the other
      // way round from the benches: there the subject is the glass and the
      // dials are a margin, here the subject is what was said.
      el("div", { class: "mmc-bn-room mmc-ch-room" }, [this.talk, this.side]),
    ]);

    this.overlay = el("div", {
      class: "mmc-overlay mmc-bn-over mmc-ch-over",
      // A file dropped anywhere in the room joins the conversation — the
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
      // every step of every render; a rail rebuilt that often would close a
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
    this.paintRail();
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
    if (!state.messages.length) {
      rows.push(el("div", { class: "mmc-ch-empty" }, [
        el("p", { text: t("Ask for a picture or a shot, then ask for changes.") }),
        el("p", { class: "mmc-ch-hint",
                  text: t("“a fox in a snowy wood at dusk” · “now a clip of it, she looks up” · “bluer”") }),
      ]));
    }
    for (const message of state.messages) {
      if (message.role === "user") {
        rows.push(el("div", { class: "mmc-ch-msg mmc-ch-user" },
                     [el("div", { class: "mmc-ch-said", text: message.text })]));
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
      : this.queue.remaining > 1
        ? t("Queued — {count} ahead", { count: this.queue.remaining - 1 })
        : t("Queued");
    if (note) body.push(el("div", { class: `mmc-ch-note${card.state === "failed" ? " mmc-ch-bad" : ""}`,
                                    text: note }));
    if (card.state === "running" || card.state === "queued") {
      body.push(el("div", { class: "mmc-ch-bar" },
                   [el("span", { class: "mmc-ch-fill",
                                 style: { width: `${Math.round((card.progress ?? 0) * 100)}%` } })]));
    }
    if (card.entry) {
      body.push(el("div", { class: "mmc-ch-doors" }, [
        el("span", { class: "mmc-ch-handle", text: `@${card.entry.handle}`,
                     title: t("Cite this in what you say next.") }),
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

  /** The one thing about the composer that changes: whether it can be used. */
  paintComposer() {
    this.box.disabled = state.busy;
    this.sendButton.disabled = state.busy;
  }

  /** The text box grows with what is in it, to a few lines, then scrolls. */
  grow() {
    this.box.style.height = "auto";
    this.box.style.height = `${Math.min(160, this.box.scrollHeight)}px`;
  }

  // ---- the rail --------------------------------------------------------------

  paintRail() {
    const bar = rail();
    const still = this.familyOr(bar.still_family, stillFamilies());
    const video = this.familyOr(bar.video_family, videoFamilies());
    const current = refinerSettings();
    const local = current.backend !== "remote";
    const shape = video?.canvas ?? still?.canvas ?? {};

    const rows = [
      this.group(t("The model"), [
        this.row(t("Refiner"), local ? t("this ComfyUI") : t("a server"),
                 (anchor) => openSettings(anchor, () => this.paint(), bar.video_family)),
        this.row(t("Model"), chosenModel(current) || t("none chosen"),
                 (anchor) => openSettings(anchor, () => this.paint(), bar.video_family)),
        local
          ? el("p", { class: "mmc-ch-hint",
                      text: t("A model in this ComfyUI shares the card with your renders, "
                              + "so a reply waits behind whatever is sampling. A server is "
                              + "the better setting on one GPU.") })
          : null,
        this.row(t("Skill"), bar.skill || t("none"), (anchor) => openChoicePopover(anchor, {
          title: t("Append to the room's prompting"),
          options: ["", ...this.skills.map((entry) => entry.name)],
          value: bar.skill || "",
          label: (name) => name || t("none"),
          onPick: (name) => setRail({ skill: name }),
        }), t("A file from the node's skills folder, added to this room's own "
              + "prompting. It is only ever added: the room's reply contract is "
              + "what turns an answer into a render.")),
      ]),

      this.group(t("What it makes"), [
        this.pick(t("Pictures"), still, stillFamilies(),
                  (id) => setRail({ still_family: id })),
        still && !takesPictures(still)
          ? el("p", { class: "mmc-ch-hint",
                      text: t("{family} draws from words alone — it cannot be given a "
                              + "picture to change.", { family: t(still.label) }) })
          : null,
        this.pick(t("Clips"), video, videoFamilies(),
                  (id) => setRail({ video_family: id })),
        this.row(t("Shape"), bar.aspect || t("the family's own"), (anchor) => openChoicePopover(anchor, {
          title: t("Shape"),
          options: Object.keys(shape.aspects ?? {}),
          value: bar.aspect,
          onPick: (name) => setRail({ aspect: name }),
        })),
        el("div", { class: "mmc-ch-row" }, [
          el("span", { class: "mmc-ch-label", text: t("Short edge") }),
          stepperPill({
            value: Number(bar.short_edge) || 768,
            min: shape.min_short_edge ?? 256, max: shape.max_short_edge ?? 2048, step: 64,
            width: "46px", format: (value) => `${value}px`,
            onChange: (value) => setRail({ short_edge: value }),
          }),
        ]),
        this.toggle(t("Turbo"), bar.turbo, (on) => setRail({ turbo: on }),
                    t("Sample the still on the family's distilled checkpoint. It has to be "
                      + "picked in the weights, and the room says so if it is not.")),
      ]),

      this.group(t("How it renders"), [
        this.row(t("Seed"), bar.seed_policy === "random" ? t("a new one each time")
                                                        : String(bar.seed ?? 0),
                 (anchor) => openChoicePopover(anchor, {
                   title: t("Seed"),
                   options: ["fixed", "random"],
                   value: bar.seed_policy,
                   label: (name) => t(name === "random" ? "a new one each time" : "the same every time"),
                   onPick: (name) => setRail({ seed_policy: name }),
                 })),
        bar.seed_policy === "random" ? null : el("div", { class: "mmc-ch-row" }, [
          el("span", { class: "mmc-ch-label", text: t("Number") }),
          stepperPill({
            value: Number(bar.seed) || 0, min: 0, max: 0xffffffff, step: 1, width: "66px",
            onChange: (value) => setRail({ seed: value }),
          }),
        ]),
        this.toggle(t("Refine"), bar.refine, (on) => setRail({ refine: on }),
                    t("Put the model's prompt through the family's own prompting before "
                      + "queueing. Not wired into this room yet — with it on, a render "
                      + "comes back as a sentence saying so.")),
      ]),

      this.group(t("What has been made"), [
        state.ledger.length
          ? el("div", { class: "mmc-ch-tiles" }, state.ledger.map((entry) => this.tile(entry)))
          : el("p", { class: "mmc-ch-hint", text: t("Nothing yet.") }),
      ]),
    ];
    this.side.replaceChildren(...rows.filter(Boolean));
  }

  /** A family by id out of a list, or the first one. A rail remembered before a
   *  family was uninstalled must not leave the pill naming nothing. */
  familyOr(id, list) {
    return list.find((entry) => entry.id === id) ?? list[0] ?? null;
  }

  group(title, children) {
    const kept = children.filter(Boolean);
    if (!kept.length) return null;
    return el("div", { class: "mmc-ch-group" },
              [el("div", { class: "mmc-ch-head", text: title }), ...kept]);
  }

  /** One rail line: what it is, what it says, and the popover behind it. */
  row(label, value, opens, title) {
    return el("div", { class: "mmc-ch-row", title }, [
      el("span", { class: "mmc-ch-label", text: label }),
      el("button", {
        class: "mmc-pill mmc-ch-value", text: value,
        onclick: (event) => opens(event.currentTarget),
      }),
    ]);
  }

  /** A family pill. The label is the manifest's — no family id is ever drawn,
   *  and none is ever written here either. */
  pick(label, chosen, options, onPick) {
    if (!options.length) return null;
    return this.row(label, chosen ? t(chosen.label) : t("none"),
                    (anchor) => openChoicePopover(anchor, {
                      title: label,
                      options: options.map((entry) => entry.id),
                      value: chosen?.id,
                      label: (id) => t(familyOf(id).label),
                      onPick,
                    }));
  }

  toggle(label, on, onChange, title) {
    return el("div", { class: "mmc-ch-row", title }, [
      el("span", { class: "mmc-ch-label", text: label }),
      el("button", {
        class: `mmc-pill mmc-ch-value${on ? " accel-on" : ""}`,
        "aria-checked": Boolean(on),
        text: on ? t("on") : t("off"),
        onclick: () => onChange(!on),
      }),
    ]);
  }

  /** One thing in the ledger, as the model sees it and as you do. */
  tile(entry) {
    const shown = entry.handle.startsWith(PREFIX.audio) ? null : entry.filename;
    return el("button", {
      class: "mmc-ch-tile",
      title: `@${entry.handle} · ${entry.text}`,
      onclick: () => this.cite(entry),
    }, [
      shown
        ? el("img", { src: viewUrl(shown, { preview: true }), alt: "",
                      loading: "lazy", draggable: false })
        : el("span", { class: "mmc-ch-sound" }, [icon("audio", 20)]),
      el("span", { text: `@${entry.handle}` }),
    ]);
  }

  /** Put a handle in the box. Citing is how an edit is asked for, and hunting
   *  for the right one among five tiles is what the tiles are for. */
  cite(entry) {
    const text = this.box.value;
    this.box.value = `${text}${text && !text.endsWith(" ") ? " " : ""}@${entry.handle} `;
    this.box.focus();
    this.grow();
  }

  // ---- the turn ---------------------------------------------------------------

  async send() {
    const text = this.box.value.trim();
    if (!text || state.busy) return;
    this.box.value = "";
    this.grow();
    state.turn += 1;
    state.error = null;
    state.messages.push({ role: "user", text });
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
   * `{problem}` is the assistant's line verbatim — a duration off the frame
   * grid, a checkpoint nobody picked — and is a bubble rather than an error:
   * the model asked for something the machine cannot do, which is a thing to
   * say back, not a failure of the room.
   */
  async queueRender(action, message, over = {}) {
    let answer;
    try {
      const response = await api.fetchApi("/continuity/chat/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action, ledger: state.ledger, rail: { ...rail(), ...over },
          client_id: api.clientId,
        }),
      });
      answer = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(answer.error || t("that render could not be started ({status})",
                                                          { status: response.status }));
    } catch (error) {
      message.say = [message.say, String(error.message || error)].filter(Boolean).join("\n\n");
      message.bad = true;
      return;
    }
    if (answer.problem) {
      message.say = [message.say, answer.problem].filter(Boolean).join("\n\n");
      message.bad = true;
      return;
    }
    message.action = action;
    message.card = { promptId: answer.prompt_id, piece: answer.piece, action,
                     state: "queued", progress: 0 };
    watchRender(message.card);
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

  /** The paperclip. A detached input rather than a hidden child of the room:
   *  nothing on screen should be an element nobody can see, and the picker it
   *  opens is the browser's own. */
  browse() {
    const input = el("input", {
      type: "file", accept: "image/*,video/*,audio/*", multiple: true,
      onchange: () => { for (const file of input.files ?? []) this.attach(file); },
    });
    input.click();
  }

  pasted(event) {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) this.attach(file);
  }

  /**
   * An uploaded file becomes a ledger line, and says so.
   *
   * Whatever is already typed in the box is its description — "the coat here",
   * pasted with a photograph, is a better line than `image (7).png` — and the
   * filename is the fallback. Nothing is sent to the model: an upload is a
   * thing that now exists, and the next turn is where it gets talked about.
   */
  async attach(file) {
    try {
      const asset = await upload(file, UPLOADS);
      const said = this.box.value.trim();
      const entry = remember({
        media: asset.kind || "image",
        kind: asset.kind === "video" ? "clip" : asset.kind === "audio" ? "sound" : "still",
        filename: asset.path,
        text: said || asset.name,
      });
      state.messages.push({ role: "assistant",
                            say: t("Added {handle} — {what}.",
                                   { handle: `@${entry.handle}`, what: entry.text }) });
    } catch (error) {
      state.error = String(error.message || error);
    }
    notify();
  }
}
