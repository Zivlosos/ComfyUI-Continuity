// What the room takes from the canvas, and nothing else.
//
// A chat renders from its own piece. Its family, its shape, its seed, its
// cast, the files it made and attached, and the family's pinned LoRAs are all
// the conversation's, assembled by `chat.js` at render time; nothing on the
// canvas is read into a chat render and nothing a chat renders is written
// onto the canvas. The one exception is how a render *samples* — the sampler
// row and the turbo switch — and that only while the room follows the node:
// a chat is usually opened over a piece somebody has already tuned, and the
// steps, the guidance and the schedule they settled on are the ones a draft
// beside it should sample on too.
//
// **A pin takes a copy of that row for the room alone.** From then on the
// gear edits the copy, the node is free to be set differently, and the copy
// is the machine's (`settings.chat`) so it is there on the next page and for
// every chat. Unpinning drops it and the room follows again.
//
// **A node on another family has nothing to follow.** A row is a family's —
// H3's steps are not LTX's, and H3's turbo LoRA is not a file LTX can wear —
// so a room whose clips are on one family while the piece is on another
// samples on its own family's defaults, and the gear says so. Pinning writes
// a row of the room's own from those defaults.
//
// The gear is the node's row, drawn again. `samplingBar`, `turboPills` and
// `PreStageRow` are the same functions the faces mount, called here with the
// same `widgetIO` over the node's own blob while following, or with `blobIO`
// over the copy while pinned. The bodies say when they have redrawn
// (`onRender`), and the room follows.
import { el, icon } from "./dom.js";
import { samplingBar, blobIO, SAMPLING_WIDGETS, WIDGET_ONLY } from "./sampling.js";
import { turboPills, sync as syncTurbo } from "./turbo.js";
import { PreStageRow } from "./prestage.js";
import * as S from "./state.js";
import { DEFAULT_STILL_ARCH, STILL_ARCHES, DEFAULT_VIDEO_FAMILY, stillFamily } from "./manifest.js";
import { t } from "./i18n.js";

/** The image arches the room can draw a picture with. H3's still branch is a
 *  video generation under its own blob, which the server's still route does
 *  not build — see `routes/chat._rail`. */
export const PICTURE_ARCHES = S.PRESTAGE_IMAGE_ARCHES;

/** The image arches a cited picture can be *changed* on: the families whose
 *  manifest says the first picture cited is the one being edited. Read off
 *  the manifest, never off a family id — `chat.edits_pictures` reads the
 *  same flag. What the room's *Edits* pill offers. */
export const EDIT_ARCHES = PICTURE_ARCHES.filter(
  (arch) => Boolean(stillFamily(arch).capabilities?.refs?.edits_first));

/** The rail field a side's pinned row is kept in. */
const PIN = { still: "pinned_still", video: "pinned_video" };

/** The sampler widgets minus the seed's: the room's seed is its own, so the
 *  rows drawn here never show the node's. */
function rowWidgets(widgets) {
  return Object.fromEntries(Object.entries(widgets ?? {})
    .filter(([name]) => !WIDGET_ONLY.includes(name)));
}

/** The row's values off an io, by name — what a pin copies. */
function rowOf(io) {
  const row = {};
  if (!io) return row;
  for (const name of SAMPLING_WIDGETS) {
    if (WIDGET_ONLY.includes(name)) continue;
    const value = io.value(name, undefined);
    if (value !== undefined) row[name] = value;
  }
  return row;
}

/**
 * The sampler row a chat render samples on, and where it comes from.
 *
 * @param {object} doors
 *   `node()` the piece's node under the room, or null;
 *   `preStage()` the pre-stage beside it, or null;
 *   `rail()` / `setRail(patch)` the room's rail, where the families and a
 *   pinned row live.
 */
export class Sync {
  constructor({ node, preStage, rail, setRail }) {
    this.node = node ?? (() => null);
    this.preStage = preStage ?? (() => null);
    this.rail = rail;
    this.setRail = setRail;
    this.copies = { still: null, video: null };
    this.followers = new Set();
  }

  // ---- the room's own families -----------------------------------------------

  videoFamily() {
    return this.rail().video_family || DEFAULT_VIDEO_FAMILY;
  }

  stillArch() {
    const arch = this.rail().still_arch;
    return PICTURE_ARCHES.includes(arch) ? arch : DEFAULT_STILL_ARCH;
  }

  /** The still family the server is told, by name — the arch as the registry
   *  names its family. */
  stillFamily() {
    return STILL_ARCHES[this.stillArch()] ?? null;
  }

  /** The arch a cited picture is changed on when the image model cannot read
   *  one — the room's *Edits* choice — or "" for whichever is ready, which
   *  the server decides (`routes/chat.machine`). */
  editArch() {
    const arch = this.rail().edit_arch;
    return EDIT_ARCHES.includes(arch) ? arch : "";
  }

  /** What the turn's settings block says about the sides: which families,
   *  and whether the still's turbo switch loads the Turbo checkpoint. */
  families() {
    const turbo = this.row("still").turbo;
    return {
      still_family: this.stillFamily() ?? "",
      video_family: this.videoFamily(),
      edit_family: STILL_ARCHES[this.editArch()] ?? "",
      still_turbo_checkpoint: Boolean(turbo?.on && !turbo?.lora),
    };
  }

  // ---- the nodes, where they can be followed ------------------------------------

  clipNode() {
    const node = this.node();
    const body = node?.mmcBody;
    const piece = body?.timeline;
    return body && piece ? { node, body, piece } : null;
  }

  pictureNode() {
    const node = this.preStage();
    const body = node?.mmcBody;
    const state = body?.state;
    return body && state ? { node, body, state } : null;
  }

  /** Whether a side's node is one the room can follow: there, and on the
   *  room's own family. A row is a family's. `arch` is the image arch a
   *  still is being drawn on where it is not the room's own — an edit of a
   *  cited picture on the *Edits* family — and the pre-stage has to be on
   *  that one to be followed for it. */
  followable(kind, arch = this.stillArch()) {
    if (kind === "video") {
      const live = this.clipNode();
      return Boolean(live && S.pieceFamily(live.piece) === this.videoFamily());
    }
    const live = this.pictureNode();
    return Boolean(live && live.state.arch === arch);
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
   * Pin a side: a row of the room's own, copied from the node where the node
   * can be followed and from the family's defaults where it cannot.
   *
   * The copy is a blank blob of the room's family with only the row and the
   * turbo switch written onto it — nothing else of the node's comes across,
   * because nothing else of the node's is the room's. It is a whole blob
   * rather than the two fields because the pills that draw and edit a row
   * (`turboPills`, `PreStageRow`) read and write one.
   */
  pin(kind) {
    let copy;
    if (kind === "still") {
      const arch = this.stillArch();
      const live = this.followable("still") ? this.pictureNode() : null;
      const blank = { ...S.emptyPreStage(), arch, sampling: rowOf(live?.body.widgetIO()) };
      if (live?.state.turbo?.[arch]) blank.turbo = { ...blank.turbo, [arch]: { ...live.state.turbo[arch] } };
      copy = S.parsePreStage(S.serializePreStage(blank));
    } else {
      const family = this.videoFamily();
      const live = this.followable("video") ? this.clipNode() : null;
      const blank = { ...S.emptyTimeline(), family, sampling: rowOf(live?.body.widgetIO()) };
      if (live?.piece.turbo) blank.turbo = { ...live.piece.turbo };
      // The turbo file rides in the stack as well as on the switch; the
      // switch alone is a switch on nothing. Only that entry comes across.
      const worn = live?.piece.loras?.find((entry) => entry.name && entry.name === live.piece.turbo?.lora);
      if (worn) blank.loras = [{ ...worn }];
      copy = S.parseTimeline(S.serializeTimeline(blank));
    }
    this.copies[kind] = copy;
    this.save(kind);
  }

  unpin(kind) {
    this.copies[kind] = null;
    this.setRail({ [PIN[kind]]: "" });
  }

  /** The pin, for a gear head: lit while the row is the room's own. */
  pinPill(kind, onChange) {
    const on = this.pinned(kind);
    const what = kind === "still" ? t("pictures") : t("clips");
    return el("button", {
      class: `mmc-pill mmc-ch-pin${on ? " accel-on" : ""}`,
      "aria-pressed": on,
      title: on
        ? t("Pinned: the room samples {what} on a row of its own, and the node can be set differently. Press to follow the node again.", { what })
        : t("Following the node: its sampler row and turbo switch are what the room samples {what} on. Press to pin a row of the room's own.", { what }),
      onclick: () => { if (on) this.unpin(kind); else this.pin(kind); onChange(); },
    }, [icon("pin", 15)]);
  }

  // ---- what a render samples on ---------------------------------------------------

  /**
   * The row for a render of `kind` -> `{sampling, turbo, loras, widgets}`.
   *
   * Pinned: the copy's row, its switch and the turbo file in its stack.
   * Following: the node's blob-level row, its switch, that file, and the
   * node's widget values as the queue would read them (the blob wins for the
   * row, the widgets are the fallback — `sampling.resolve`). Neither: empty,
   * which is the family's defaults all the way down.
   *
   * `arch` is the image arch a still is drawn on where it is not the room's
   * own — a cited picture changed on the *Edits* family. A row is a
   * family's, so the copy's steps and guidance are read only where the copy
   * is on that arch, and the node's only where the node is; the turbo block
   * is per arch on both and is read for the one asked. Otherwise the
   * family's own defaults, which is what a node on another family gets too.
   */
  row(kind, arch = this.stillArch()) {
    const copy = this.copy(kind);
    if (copy) return this.rowFrom(kind, copy, {}, arch);
    if (!this.followable(kind, arch)) return { sampling: {}, turbo: null, loras: [], widgets: {} };
    if (kind === "still") {
      const { body, state } = this.pictureNode();
      return this.rowFrom(kind, state, rowWidgets(this.values(body.widgetIO(), body.samplingWidgets)), arch);
    }
    const { body, piece } = this.clipNode();
    return this.rowFrom(kind, piece, rowWidgets(this.values(body.widgetIO(), body.widgets)));
  }

  rowFrom(kind, blob, widgets, arch = this.stillArch()) {
    if (kind === "still") {
      // The room's own arch reads the row whatever the blob says it was
      // written for — a copy pinned before the pill moved keeps working;
      // any other arch reads it only when the blob is on that arch.
      const own = arch === this.stillArch() || blob.arch === arch;
      return { sampling: own ? { ...(blob.sampling ?? {}) } : {}, turbo: blob.turbo?.[arch] ?? null,
               loras: [], widgets: own ? widgets : {} };
    }
    const turbo = blob.turbo ?? null;
    const worn = (blob.loras ?? []).filter((entry) => entry.name && entry.name === turbo?.lora);
    return { sampling: { ...(blob.sampling ?? {}) }, turbo, loras: worn.map((entry) => ({ ...entry })), widgets };
  }

  /** The widget values an io holds, by name. */
  values(io, widgets) {
    const out = {};
    for (const name of Object.keys(widgets ?? {})) {
      const value = io.value(name, undefined);
      if (["string", "number", "boolean"].includes(typeof value)) out[name] = value;
    }
    return out;
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
    for (const body of [this.clipNode()?.body, this.pictureNode()?.body]) if (body) this.chain(body);
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

  // ---- the gear's rows ------------------------------------------------------------

  /** Why a side has no row to draw: followed nothing, and not pinned. */
  note(kind) {
    const family = kind === "still"
      ? t(S.PRESTAGE_ARCH_LABEL[this.stillArch()])
      : t(S.FAMILY_LABEL[this.videoFamily()]);
    const live = kind === "still" ? this.pictureNode() : this.clipNode();
    if (!live) {
      return t("No {what} under this room to follow. {family} samples on its defaults — pin to set a row of the room's own.",
               { what: kind === "still" ? t("pre-stage") : t("piece"), family });
    }
    const theirs = kind === "still"
      ? t(S.PRESTAGE_ARCH_LABEL[live.state.arch] ?? live.state.arch)
      : t(S.FAMILY_LABEL[S.pieceFamily(live.piece)] ?? S.pieceFamily(live.piece));
    return t("The node is on {theirs}; this room draws with {family}, which samples on its defaults — pin to set a row of the room's own.",
             { theirs, family });
  }

  /**
   * The clip side's sampler row: steps, cfg, the schedule, the accelerators,
   * the turbo switch — over the node's own blob while following, over the
   * copy while pinned. `redraw` is the room's repaint after a pill writes.
   */
  clipRow(redraw) {
    const copy = this.copy("video");
    const live = this.followable("video") ? this.clipNode() : null;
    if (!copy && !live) return el("div", { class: "mmc-ch-note", text: this.note("video") });
    let piece, widgets, io, set, commit;
    if (copy) {
      piece = copy;
      widgets = rowWidgets(this.clipNode()?.body.widgets);
      io = blobIO(() => ({}), () => copy.sampling, (block) => { copy.sampling = block; });
      set = (name, value) => { io.set(name, value); this.save("video"); redraw(); };
      commit = () => { syncTurbo(copy, io); this.save("video"); redraw(); };
    } else {
      piece = live.piece;
      widgets = rowWidgets(live.body.widgets);
      io = live.body.widgetIO();
      set = (name, value) => { live.body.set(name, value); redraw(); };
      commit = () => { live.body.commit(); redraw(); };
    }
    const family = S.pieceFamily(piece);
    return samplingBar({
      family, widgets, value: io.value, set, perSegment: false, container: piece,
      turbo: S.turboOf(family) ? turboPills({ container: piece, value: io.value, set, onCommit: commit }) : [],
    });
  }

  /** The picture side's row, the pre-stage's own turbo pill included. */
  pictureRow(redraw) {
    const copy = this.copy("still");
    const live = this.followable("still") ? this.pictureNode() : null;
    if (!copy && !live) return el("div", { class: "mmc-ch-note", text: this.note("still") });
    let host, widgets, io, set;
    if (copy) {
      io = blobIO(() => ({}), () => copy.sampling, (block) => { copy.sampling = block; });
      host = { state: copy, widgetIO: () => io, commit: () => { this.save("still"); redraw(); } };
      widgets = rowWidgets(this.pictureNode()?.body.samplingWidgets);
      set = (name, value) => { io.set(name, value); this.save("still"); redraw(); };
    } else {
      io = live.body.widgetIO();
      host = { state: live.state, widgetIO: () => io, commit: () => { live.body.commit(); redraw(); } };
      widgets = rowWidgets(live.body.samplingWidgets);
      set = (name, value) => { io.set(name, value); live.body.editor?.render(); redraw(); };
    }
    if (!Object.keys(widgets).length) {
      return el("div", { class: "mmc-ch-note", text: t("The pre-stage's sampler row is not drawn yet; open it once and come back.") });
    }
    const row = new PreStageRow(host);
    return samplingBar({
      widgets, value: io.value, set, perSegment: false,
      turbo: row.renderTurbo(),
    });
  }
}
