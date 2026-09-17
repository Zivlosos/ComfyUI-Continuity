// The nodes under the room: what a chat render is made with.
//
// A chat render is the node on the canvas, asked for this prompt in this
// shape. The room is opened from a piece's shell, so there is always a Creator
// or Timeline node under it, and there is a pre-stage beside it or one is
// spawned the first time a picture is asked for. Everything about *how* a
// render samples — the family, the weights, the LoRA stack, the turbo switch,
// the sampler row, the passes — is those two nodes' and is read off them on
// every render. What this buys is one truth: throw turbo in the room and the
// node has it thrown, dial steps on the node and the room samples on them,
// and "Open in the editor" is a render of the setup already on the node.
//
// **Unless a side is pinned.** A pin takes a copy of that node's blob and the
// room renders with the copy from then on: the gear edits the copy, the node
// keeps whatever it is set to, and the two can differ — a strip tuned for a
// long render on the canvas and a fast draft setup in the room. The copy is
// the machine's (`settings.chat`), like the rest of the rail, so it is there
// on the next page and for every chat. Unpinning drops it and the room follows
// the node again.
//
// **The gear is the node's row, drawn again.** `samplingBar`, `turboPills`,
// the weights pill and the family pill are the same functions the node's face
// mounts, called here with the same `widgetIO` over the same blob — or over
// the copy, through the same `blobIO` the node uses. The bodies say when they
// have redrawn (`onRender`, on the body and on its editor), and the room
// follows. The seed is not among them: it is the room's own, on the rail.
//
// This module owns the two sides and the doors onto them; `chat.js` owns the
// conversation and never reaches a node except through here.

import { el, icon } from "./dom.js";
import { openChoicePopover } from "./pills.js";
import { samplingBar, blobIO, SAMPLING_WIDGETS, WIDGET_ONLY } from "./sampling.js";
import { turboPills, sync as syncTurbo } from "./turbo.js";
import { weightsPill, familyPill } from "./models.js";
import { PreStageRow } from "./prestage.js";
import * as S from "./state.js";
import { DEFAULT_STILL_ARCH, STILL_ARCHES } from "./manifest.js";
import { t } from "./i18n.js";

/** The image arches the room can draw a picture with. H3's still branch is a
 *  video generation under its own blob, which the server's still route does
 *  not build — see `routes/chat._rail`. */
const PICTURE_ARCHES = S.PRESTAGE_IMAGE_ARCHES;

/** The rail field a side's pinned copy is kept in. */
const PIN = { still: "pinned_still", video: "pinned_video" };

/** The sampler widgets minus the seed's: the room's seed is its own, so the
 *  rows drawn here never show the node's. */
function rowWidgets(widgets) {
  return Object.fromEntries(Object.entries(widgets ?? {})
    .filter(([name]) => !WIDGET_ONLY.includes(name)));
}

/**
 * The two nodes, as the room reads and writes them.
 *
 * @param {object} doors
 *   `node()` the piece's node (Creator or Timeline);
 *   `preStage()` the pre-stage node paired with it, or null;
 *   `spawnPreStage()` -> Promise<node> — put one beside it and wait for its body;
 *   `rail()` / `setRail(patch)` the room's rail, where a pinned copy lives.
 */
export class Sides {
  constructor({ node, preStage, spawnPreStage, rail, setRail }) {
    this.node = node;
    this.preStage = preStage;
    this.spawnPreStage = spawnPreStage;
    this.rail = rail;
    this.setRail = setRail;
    this.followers = new Set();
    // The pinned copies, parsed once off the rail and mutated in place; the
    // rail holds them serialized, as the node's widget would.
    this.copies = { still: null, video: null };
  }

  // ---- the nodes ------------------------------------------------------------------

  /** The piece's body (`TimelineBody`) and its piece. */
  clip() {
    const body = this.node()?.mmcBody ?? null;
    return { body, piece: body?.timeline ?? null };
  }

  /** The pre-stage's body (`PreStageBody`) and its state, or nulls. */
  picture() {
    const body = this.preStage()?.mmcBody ?? null;
    return { body, state: body?.state ?? null };
  }

  /** The pre-stage's body, spawning the node when there is none. */
  async pictureBody() {
    if (!this.preStage()) await this.spawnPreStage();
    // The spawn remounts the shell, which re-lays the bodies' render slots.
    this.chainAll();
    return this.picture().body;
  }

  /**
   * The piece the room writes on: the pinned copy, or the node's own timeline.
   *
   * Live, not serialized — the `@` menu casts into it and reads its cast and
   * shelf back on the next keystroke, and the two have to be the same object.
   * `commitPiece` is the other half: what a change to it has to do to be kept.
   */
  piece() {
    return this.copy("video") ?? this.clip().piece;
  }

  /** Keep a change made to `piece()`: the copy back onto the rail, or the
   *  node's blob written and its face redrawn, as its own commit does. */
  commitPiece() {
    if (this.copy("video")) return this.save("video");
    this.clip().body?.commit?.();
  }

  /** What the preset library lands on when opened from the room: the node's
   *  own target while the room follows it. A pinned copy has no node to be
   *  a target for, and the library's doors close with it. */
  presetTarget() {
    if (this.copy("video")) return null;
    return this.clip().body?.presetTarget?.() ?? null;
  }

  // ---- pinning ------------------------------------------------------------------

  pinned(kind) {
    return Boolean(this.rail()[PIN[kind]]);
  }

  /** The pinned copy of a side, parsed, or null while the side follows. */
  copy(kind) {
    const raw = this.rail()[PIN[kind]];
    if (!raw) { this.copies[kind] = null; return null; }
    if (!this.copies[kind]) {
      this.copies[kind] = kind === "still" ? S.parsePreStage(raw) : S.parseTimeline(raw);
    }
    return this.copies[kind];
  }

  /** Write a side's copy back to the rail, after a change on it. */
  save(kind) {
    const copy = this.copies[kind];
    if (!copy) return;
    this.setRail({ [PIN[kind]]: kind === "still" ? S.serializePreStage(copy) : S.serializeTimeline(copy) });
  }

  /**
   * Pin a side: the node's blob as it stands becomes the room's own. The
   * sampler row is written into the copy in full first — a blob from before
   * the row moved into it keeps the numbers on its widgets, and a copy has
   * none. The pre-stage's prompt, init and references are cleared, as the
   * piece's strip is replaced at render: what the copy keeps is the setup,
   * and the content is the conversation's.
   */
  pin(kind) {
    const live = kind === "still" ? this.picture() : this.clip();
    if (!live.body) return;
    const io = live.body.widgetIO();
    const row = {};
    for (const name of SAMPLING_WIDGETS) {
      if (WIDGET_ONLY.includes(name)) continue;
      const value = io.value(name, undefined);
      if (value !== undefined) row[name] = value;
    }
    let copy;
    if (kind === "still") {
      copy = S.parsePreStage(S.serializePreStage({ ...live.state, sampling: row }));
      S.clearPreStage(copy);
    } else {
      copy = S.parseTimeline(S.serializeTimeline({ ...live.piece, sampling: row }));
    }
    this.copies[kind] = copy;
    this.save(kind);
  }

  unpin(kind) {
    this.copies[kind] = null;
    this.setRail({ [PIN[kind]]: "" });
  }

  /** The pin, for a gear head: lit while the side is the room's own. */
  pinPill(kind, onChange) {
    const on = this.pinned(kind);
    const what = kind === "still" ? t("pictures") : t("clips");
    return el("button", {
      class: `mmc-pill mmc-ch-pin${on ? " accel-on" : ""}`,
      "aria-pressed": on,
      title: on
        ? t("Pinned: the room keeps its own setup for {what}, and the node can be set differently. Press to follow the node again.", { what })
        : t("Following the node: what it is set to is what the room renders {what} with. Press to pin a copy of its setup for the room alone.", { what }),
      onclick: () => { if (on) this.unpin(kind); else this.pin(kind); onChange(); },
    }, [icon("pin", 15)]);
  }

  // ---- the sources ----------------------------------------------------------------

  /**
   * Where a side's setup is read and written: the node, or the pinned copy.
   * -> `{blob, widgets, io, set, commit}`, or null with no node to read.
   * `widgets` are the node's, for the options a pill lists — a copy has no
   * widgets of its own and only ever writes its blob.
   */
  clipSource() {
    const { body, piece } = this.clip();
    const copy = this.copy("video");
    if (copy) {
      const io = blobIO(() => ({}), () => copy.sampling, (block) => { copy.sampling = block; });
      return {
        blob: copy, widgets: rowWidgets(body?.widgets), io,
        set: (name, value) => { io.set(name, value); this.save("video"); },
        commit: () => { syncTurbo(copy, io); this.save("video"); },
      };
    }
    if (!body) return null;
    return {
      blob: piece, widgets: rowWidgets(body.widgets), io: body.widgetIO(),
      set: (name, value) => body.set(name, value), commit: () => body.commit(),
    };
  }

  pictureSource() {
    const { body, state } = this.picture();
    const copy = this.copy("still");
    if (copy) {
      const io = blobIO(() => ({}), () => copy.sampling, (block) => { copy.sampling = block; });
      return {
        blob: copy, widgets: rowWidgets(body?.samplingWidgets), io,
        set: (name, value) => { io.set(name, value); this.save("still"); },
        commit: () => this.save("still"),
      };
    }
    if (!body) return null;
    return {
      blob: state, widgets: rowWidgets(body.samplingWidgets), io: body.widgetIO(),
      set: (name, value) => { body.widgetIO().set(name, value); body.editor?.render(); },
      commit: () => body.commit(),
    };
  }

  videoFamily() {
    const blob = this.clipSource()?.blob;
    return blob ? S.pieceFamily(blob) : S.DEFAULT_VIDEO_FAMILY;
  }

  /** The pre-stage's arch — the copy's, the node's, or the arch a spawned
   *  one would open on. */
  stillArch() {
    return this.pictureSource()?.blob.arch ?? DEFAULT_STILL_ARCH;
  }

  /** The still family the server is told, by name — the arch as the registry
   *  names its family. Null on the H3 branch, which the room cannot draw a
   *  picture through. */
  stillFamily() {
    const arch = this.stillArch();
    return PICTURE_ARCHES.includes(arch) ? STILL_ARCHES[arch] : null;
  }

  /** What the turn's settings block says about the sides: which families,
   *  and whether the still's turbo switch loads the Turbo checkpoint. */
  families() {
    const state = this.pictureSource()?.blob;
    const turbo = state?.turbo?.[state.arch];
    return {
      still_family: this.stillFamily() ?? "",
      video_family: this.videoFamily(),
      still_turbo_checkpoint: Boolean(turbo?.on && !turbo?.lora),
    };
  }

  /**
   * The base a render is built over: the side's blob and, following a node,
   * its sampler widgets as a queue from the canvas would read them — the
   * blob wins for the row (`sampling.resolve`), the widgets are the fallback.
   * A pinned copy carries its whole row and sends no widgets. The seed is
   * the room's and `chat.js` adds it.
   */
  base(kind) {
    const copy = this.copy(kind);
    if (copy) {
      const piece = kind === "still" ? S.serializePreStage(copy) : S.serializeTimeline(copy);
      return { piece: JSON.parse(piece), widgets: {} };
    }
    const node = kind === "still" ? this.preStage() : this.node();
    const body = node?.mmcBody;
    if (!body) return null;
    const piece = kind === "still" ? S.serializePreStage(body.state) : S.serializeTimeline(body.timeline);
    const widgets = {};
    for (const widget of node.widgets ?? []) {
      if (!SAMPLING_WIDGETS.includes(widget.name) || WIDGET_ONLY.includes(widget.name)) continue;
      if (["string", "number", "boolean"].includes(typeof widget.value)) widgets[widget.name] = widget.value;
    }
    return { piece: JSON.parse(piece), widgets };
  }

  // ---- following ------------------------------------------------------------------

  /**
   * Be told when either node redraws. The bodies and their editors each have
   * one `onRender` slot, and the shell holds the body's — so this chains
   * behind whatever is there rather than taking the slot. Re-laid on every
   * fire, because editors are rebuilt (an arch switch mounts a new one) and
   * the shell re-assigns the body's slot on every remount; a link is marked
   * so it is never laid twice over itself.
   */
  follow(fn) {
    this.followers.add(fn);
    this.chainAll();
    return () => this.followers.delete(fn);
  }

  chainAll() {
    for (const body of [this.clip().body, this.picture().body]) if (body) this.chain(body);
  }

  chain(body) {
    for (const host of [body, body.editor, body.faceEditor]) {
      if (!host || host.onRender?.mmcChat) continue;
      const was = host.onRender;
      host.onRender = () => {
        was?.();
        for (const fn of this.followers) fn();
        this.chainAll();
      };
      host.onRender.mmcChat = true;
    }
  }

  // ---- the pills --------------------------------------------------------------

  /** The composer's Pictures pill: the pre-stage's arch, among the arches the
   *  room can draw through. A pick on a room with no pre-stage spawns one;
   *  on a pinned copy it moves the copy alone, through the pre-stage's own
   *  arch switch. */
  picturePill() {
    const arch = this.stillArch();
    const drawable = PICTURE_ARCHES.includes(arch);
    return el("button", {
      class: `mmc-ch-pill${drawable ? "" : " mmc-ch-pill-off"}`,
      title: drawable
        ? t("Which model draws a picture — the pre-stage's own.")
        : t("The pre-stage is on {arch}, whose still the room cannot ask for. Pick an image model.",
            { arch: t(S.PRESTAGE_ARCH_LABEL[arch]) }),
      onclick: (event) => openChoicePopover(event.currentTarget, {
        title: t("Image model"),
        options: PICTURE_ARCHES,
        value: drawable ? arch : "",
        label: (which) => t(S.PRESTAGE_ARCH_LABEL[which]),
        onPick: async (which) => {
          if (this.copy("still")) {
            if (this.copy("still").arch === which) return;
            const host = this.pictureHost();
            new PreStageRow(host).setArch(which);
            host.commit();
            return;
          }
          const body = await this.pictureBody();
          body?.setArch(which);
        },
      }),
    }, [icon("image", 14), el("span", { text: t(S.PRESTAGE_ARCH_LABEL[arch]) })]);
  }

  /** The composer's Clips pill: the node's own family pill, in the composer's
   *  clothes. `familyPill` moves the family with everything a switch entails
   *  — the stash, the remembered weights, the reset turbo — which is why it
   *  is called rather than copied. */
  clipPill() {
    const source = this.clipSource();
    if (!source) return null;
    const pill = familyPill({ piece: source.blob, onChange: source.commit });
    pill.className = "mmc-ch-pill";
    pill.title = t("Which model makes a clip — the node's own.");
    pill.replaceChildren(icon("video", 14), el("span", { text: t(S.FAMILY_LABEL[S.pieceFamily(source.blob)]) }));
    return pill;
  }

  /**
   * The clip side's sampler row, as the node draws it: steps, cfg, the
   * schedule, the accelerators, the turbo switch, the weights. The same
   * functions the face mounts, over the same blob or the pinned copy.
   * `redraw` is the room's own repaint after a pill writes; the body's
   * render does the node's.
   */
  clipRow(redraw) {
    const source = this.clipSource();
    if (!source) return null;
    const { blob: piece, widgets, io } = source;
    const family = S.pieceFamily(piece);
    const set = (name, value) => { source.set(name, value); redraw(); };
    const commit = () => { source.commit(); redraw(); };
    return samplingBar({
      family, widgets, value: io.value, set, perSegment: false, container: piece,
      turbo: S.turboOf(family) ? turboPills({ container: piece, value: io.value, set, onCommit: commit }) : [],
      trailing: [weightsPill({
        piece, models: piece.models,
        // A chat render is one card routed "auto" — see `chat.video_piece`.
        checkpoints: S.checkpointsFor({ checkpoint: "auto", assets: [] }, family),
        face: Boolean(piece.face?.on),
        onChange: commit,
        turbo: { container: piece, widgetIO: io },
      })],
    });
  }

  /** What `PreStageRow` reads and writes on the picture side: the node's
   *  body, or the pinned copy behind the room's own doors. */
  pictureHost() {
    const source = this.pictureSource();
    if (!source) return null;
    if (!this.copy("still")) return this.picture().body;
    return { state: source.blob, widgetIO: () => source.io, commit: source.commit };
  }

  /** The picture side's row, or null while there is no pre-stage to read the
   *  controls off. The turbo and weights pills are the pre-stage's own
   *  (`PreStageRow`), over the node or the copy. */
  pictureRow(redraw) {
    const source = this.pictureSource();
    if (!source || S.isStill(source.blob) || !Object.keys(source.widgets).length) return null;
    const host = this.pictureHost();
    const set = (name, value) => { source.set(name, value); redraw(); };
    const row = new PreStageRow({ state: host.state, widgetIO: () => host.widgetIO(),
                                  commit: () => { host.commit(); redraw(); } });
    return samplingBar({
      widgets: source.widgets, value: source.io.value, set, perSegment: false,
      turbo: row.renderTurbo(),
      trailing: [row.renderWeightsPill()],
    });
  }
}
