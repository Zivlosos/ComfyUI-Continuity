// The room's first run: three questions, asked in the transcript.
//
// A person who opens the chat before any node has been on the canvas has
// picked nothing — no text encoder to think with, no files for any family, no
// shape — and the room would answer their first message with "MiniMax H3 is
// not ready". This is the conversation that comes before that one. It is not
// a wizard over the room: the room's own first three messages are the setup,
// each answered by pressing a chip, and the answers are bubbles like any
// other, so the transcript is the record of what was decided.
//
// **The machine is looked at first.** `GET /continuity/chat/setup` walks the
// model folders and knocks on the two loopback ports, and every question is
// asked with the answer already found where there is one: "Ollama, which is
// running", "everything Flux 2 Klein needs is here". The found answer is one
// press; "Let me choose…" opens the full list under the same bubble.
//
// **What it writes is what the node reads.** The refiner's choice goes to
// `settings.refiner` (`refine.saveSettings`), the files per family to
// `settings.weights` — the same block `models.adoptWeights` and the pre-stage
// fill an empty row from — the families onto the nodes under the room
// (`chatnode.Sides`), and the shape to the rail. Nothing here has a store of
// its own: leave the room, drop a node, and it opens set up.
//
// The room owns the state and the paint; this module owns the questions. It
// is handed a `host` with the few doors it needs rather than importing
// `chat.js` back, which is what keeps the two from being one file.

import { el, spinner } from "./dom.js";
import { openChoicePopover, aspectGrid } from "./pills.js";
import { rulesFor } from "./canvas.js";
import { saveSettings as saveRefiner, saveRemote, listRemoteModels, chosenModel,
         settings as refinerSettings, PROVIDERS } from "./refine.js";
import { rememberedWeights, adoptWeights } from "./models.js";
import { STILL_ARCHES } from "./manifest.js";
import { patchSettings } from "./api.js";
import { t } from "./i18n.js";
import { api } from "../../../scripts/api.js";

/** The three, in the order a render needs them: who thinks, what draws, how
 *  it comes out. */
export const QUESTIONS = ["refiner", "families", "shape"];

/** The providers with a key: the ones `refine.PROVIDERS` reaches over HTTPS. */
const HOSTED = PROVIDERS.filter(([, url]) => url.startsWith("https://"));

/** The shapes offered as chips. Every family shipped here lists all three. */
const QUICK_SHAPES = [["16:9", "Wide, 16:9"], ["1:1", "Square, 1:1"], ["9:16", "Tall, 9:16"]];

/** A fresh run. `scan` lands when the route answers; `answers` is what was
 *  said back, by question; `detail` is which question has its long form
 *  open; `draft` holds what is being chosen in it. */
export function freshSetup() {
  return { scan: null, scanError: null, error: null, answers: {}, detail: null, opened: null, draft: {} };
}

/** The scan, as one request. Its failure is a line in the transcript, not a
 *  dead room: the questions are still asked, with nothing found. */
export async function scanMachine() {
  const response = await api.fetchApi("/continuity/chat/setup");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || t("the machine could not be looked at ({status})", { status: response.status }));
  return body;
}

// ---- pieces -------------------------------------------------------------------

function row(label, control, title) {
  return el("div", { class: "mmc-ch-row", title }, [
    el("span", { class: "mmc-ch-label", text: label }),
    control,
  ]);
}

/** A pill that opens the pack's own list. `bad` marks a required slot with
 *  nothing in it, the way the weights popover marks an empty row. */
function choice(text, spec, bad = false) {
  return el("button", {
    class: `mmc-pill mmc-ch-value${bad ? " mmc-ch-empty-pick" : ""}`, text,
    onclick: (event) => openChoicePopover(event.currentTarget, spec),
  });
}

/** A family's weight slots as rows, each a pick off its folder's listing.
 *  `entry` is the scan's family, `picks` the block being edited in place. */
export function slotList(entry, picks, onPick) {
  return el("div", { class: "mmc-ch-slotlist" }, entry.slots.flatMap((slot) => [
    el("span", { class: "mmc-ch-slotname", text: slot.required ? t(slot.title) : t("{slot} (optional)", { slot: t(slot.title) }) }),
    choice(picks[slot.id] || t("none"), {
      title: t(slot.title), find: true,
      options: ["", ...slot.options], value: picks[slot.id] || "",
      label: (name) => name || t("none"),
      onPick: (name) => { picks[slot.id] = name; onPick(slot.id, name); },
    }, !picks[slot.id] && slot.required),
  ]));
}

/** Write one family's picks as this machine's — the block `models.adoptWeights`
 *  and the pre-stage fill an empty row from. Over the family's remembered
 *  block, because a video family's carries more than files (the route, the
 *  precision, pinned devices) and a pick of files must not lose them; and
 *  only this family, since the server merges the map per family and the
 *  cache here may be older than what a node just wrote for another. */
export function rememberPicks(familyId, picks) {
  patchSettings({ weights: { [familyId]: { ...(rememberedWeights()[familyId] ?? {}), ...picks } } });
}

// ---- reading the scan --------------------------------------------------------

const families = (scan, kind) =>
  (scan?.families ?? []).filter((entry) => kind === "video"
    ? entry.produces.includes("video")
    : entry.produces.length === 1 && entry.produces[0] === "still");

const ready = (entry) => entry && entry.missing.length === 0;

/** The family the scan would propose for a kind: a complete one first, then
 *  the one with the fewest files still to pick. */
function proposed(scan, kind) {
  const list = families(scan, kind);
  return [...list].sort((a, b) => a.missing.length - b.missing.length)[0] ?? null;
}

/** The server model a chip picks: the one that can look at a picture, since
 *  the room's turns cite them; otherwise the first. */
const serverModel = (server) =>
  [...server.models].sort((a, b) => a.length - b.length).find((name) => /vl|vision/i.test(name)) ?? server.models[0] ?? "";

/** The refiner as the card and the bubbles name it. */
export function refinerName() {
  const current = refinerSettings();
  const model = chosenModel(current);
  if (!model) return t("no model chosen");
  return current.backend === "remote" ? model : t("{model}, inside ComfyUI", { model });
}

// ---- the questions ------------------------------------------------------------

/**
 * One run of the questions, drawn into the room's transcript.
 *
 * @param {object} host  the room's doors:
 *   `setup()` the run's state; `rail()` / `setRail(patch)` the room's rail;
 *   `sides` the room's families and sampling (`chatnode.Sync`); `said(key, ask,
 *   answer)` records a question and its answer as two bubbles; `finish()`
 *   closes the run; `repaint()` redraws; `openEdge(anchor, kind, onChange)`
 *   the room's own size slider; `familyLabel(id)` a name off the served catalog.
 */
export class FirstRun {
  constructor(host) {
    this.host = host;
  }

  get state() { return this.host.setup(); }

  /** The next question with no answer, or null once all three have one. */
  pending() {
    return QUESTIONS.find((key) => !(key in this.state.answers)) ?? null;
  }

  /** The bubble for whatever is being asked right now, or the wait for the scan. */
  render() {
    const setup = this.state;
    if (!setup.scan && !setup.scanError) {
      return this.bubble(t("One moment — looking at what this machine has."), spinner());
    }
    const key = this.pending();
    if (!key) return null;
    const question = this[key]();
    const chips = el("div", { class: "mmc-ch-asks" }, question.chips.map((chip, at) => el("button", {
      class: `mmc-ch-ask${setup.detail === key && setup.opened === at ? " open" : ""}`,
      title: chip.title,
      onclick: () => chip.opens ? this.open(key, at, chip.opens) : this.answer(key, question, chip),
    }, [
      el("span", { text: chip.label }),
      chip.found ? el("span", { class: "mmc-ch-found" }) : null,
    ])));
    const body = [];
    // The scan's failure, once, over the first question: the questions are
    // still asked, with nothing found, and the person should know why.
    if (setup.scanError && key === QUESTIONS[0]) {
      body.push(el("div", { class: "mmc-ch-note mmc-ch-bad", text: setup.scanError }));
    }
    body.push(chips);
    if (setup.detail === key) body.push(question.detail());
    else if (setup.error) body.push(el("div", { class: "mmc-ch-note mmc-ch-bad", text: setup.error }));
    return this.bubble(question.ask, el("div", { class: "mmc-ch-askbody" }, body));
  }

  bubble(say, extra) {
    return el("div", { class: "mmc-ch-msg mmc-ch-bot mmc-ch-setup" }, [
      el("div", { class: "mmc-ch-said", text: say }),
      extra ?? null,
    ].filter(Boolean));
  }

  open(key, at, draft) {
    const setup = this.state;
    setup.detail = key;
    setup.opened = at;
    setup.error = null;
    setup.draft = draft();
    this.host.repaint();
  }

  /** Apply a chip and record the exchange. A chip's `apply` may be async (a
   *  server to save, a key to send) and may refuse; a refusal is a line under
   *  the chips rather than an answer. */
  async answer(key, question, chip) {
    const setup = this.state;
    setup.error = null;
    try {
      await chip.apply();
    } catch (error) {
      setup.error = String(error.message || error);
      return this.host.repaint();
    }
    setup.detail = null;
    setup.draft = {};
    setup.answers[key] = typeof chip.answer === "function" ? chip.answer() : chip.answer;
    this.host.said(key, question.ask, setup.answers[key]);
    if (!this.pending()) this.host.finish();
    else this.host.repaint();
  }

  /** The one-press answer to everything: what was found, as it was found.
   *  The other two questions are answered here rather than asked, so the
   *  press that chose this is the run's last bubble and the card follows it. */
  async acceptAll() {
    const scan = this.state.scan;
    saveRefiner({ backend: "local", model: scan.refiner.local.model });
    await this.pickFamilies(proposed(scan, "still"), proposed(scan, "video"));
    this.state.answers.families = this.familiesSaid();
    this.state.answers.shape = this.shapeSaid();
  }

  // ---- who thinks --------------------------------------------------------------

  /** Every place the model can run is a chip, and every chip opens the same
   *  form with that place's model list in it: the text encoders on this
   *  disk, what a running server offers, what a provider lists once its key
   *  has been sent. Nothing is typed that can be picked. */
  refiner() {
    const scan = this.state.scan ?? {};
    const local = scan.refiner?.local ?? { models: [], model: "" };
    const servers = scan.refiner?.servers ?? [];
    const chips = [{
      label: t("Inside ComfyUI"), found: Boolean(local.model),
      title: local.model
        ? t("{model} — the text encoder already on this disk. Nothing to install, and nothing leaves this machine.", { model: local.model })
        : local.models.length
          ? t("A text encoder on this disk. None was recognised as a Qwen3-VL, so pick one.")
          : t("The text encoder ComfyUI would think with. The text_encoders folder is bare — nothing here to pick yet."),
      opens: () => ({ kind: "local", models: local.models, model: local.model || "" }),
    }];
    for (const server of servers) {
      chips.push({
        label: server.name ? t("{name}, which is running", { name: server.name }) : t("The server I set up"),
        found: true,
        title: server.models.length
          ? t("{model} — frees ComfyUI's memory for the render.", { model: serverModel(server) })
          : t("Running, with no model loaded yet. Load one there and the room will use it."),
        opens: () => ({ kind: "server", name: server.name, url: server.url,
                        models: server.models, model: serverModel(server) }),
      });
    }
    chips.push({
      label: t("A hosted API…"),
      title: t("Anthropic, OpenAI, OpenRouter or Gemini. The key stays on the server, never in a workflow."),
      opens: () => ({ kind: "hosted", provider: HOSTED[0][0], url: HOSTED[0][1], key: "",
                      models: null, model: "" }),
    });
    if (local.model && ready(proposed(scan, "still")) && ready(proposed(scan, "video"))) {
      chips.push({
        label: t("Just use what you found"),
        title: t("Think inside ComfyUI, draw with the families this disk is complete for, start at 16:9."),
        answer: t("Just use what you found"),
        apply: () => this.acceptAll(),
      });
    }
    const ask = (local.model || servers.length)
      ? t("Before the first picture, three quick things — I looked at this machine already.\n\nWho should do the thinking? I turn what you say into a render, and I can run in a few places.")
      : t("Before the first picture, three quick things.\n\nWho should do the thinking? I turn what you say into a render. Nothing on this machine can do that yet — no Qwen3-VL text encoder in the models folder, no LM Studio or Ollama running — so it will have to be a hosted API, or come back after installing one.");
    return { ask, chips, detail: () => this.refinerDetail() };
  }

  /** The form under the chips: where, then which model off that place's list. */
  refinerDetail() {
    const draft = this.state.draft;
    const rows = [];
    const modelRow = (label, empty) => this.row(label, this.choice(draft.model || empty, {
      title: label, options: draft.models, value: draft.model, find: true,
      onPick: (name) => { draft.model = name; this.host.repaint(); },
    }, !draft.model));
    if (draft.kind === "local") {
      rows.push(draft.models.length
        ? modelRow(t("Text encoder"), t("none"))
        : el("div", { class: "mmc-ch-note", text: t("No text encoder in the models folder. Put a Qwen3-VL there and set up again, or pick a server.") }));
      rows.push(this.useThis(t("Use this"), !draft.model, {
        answer: () => refinerName(),
        apply: () => saveRefiner({ backend: "local", model: draft.model }),
      }));
    } else if (draft.kind === "server") {
      rows.push(draft.models.length
        ? modelRow(t("Model"), t("none"))
        : el("div", { class: "mmc-ch-note", text: t("Running, with no model loaded yet. Load one there and the room will use it.") }));
      rows.push(this.useThis(t("Use this"), !draft.model, {
        answer: () => draft.name ? t("{model} on {server}", { model: draft.model, server: draft.name }) : draft.model,
        apply: async () => {
          await saveRemote(draft.url);
          saveRefiner({ backend: "remote", remoteModel: draft.model });
        },
      }));
    } else {
      rows.push(this.row(t("Provider"), el("div", { class: "mmc-ch-askrow" }, HOSTED.map(([name, url]) =>
        el("button", {
          class: `mmc-ch-ask${draft.provider === name ? " on" : ""}`, text: name, title: url,
          onclick: () => { Object.assign(draft, { provider: name, url, models: null, model: "" }); this.host.repaint(); },
        })))));
      rows.push(this.row(t("Key"), el("div", { class: "mmc-ch-askrow mmc-ch-keyrow" }, [
        el("input", {
          class: "mmc-ch-askinput", type: "password", value: draft.key,
          placeholder: t("kept on the server"),
          oninput: (event) => { draft.key = event.target.value; },
          onkeydown: (event) => { if (event.key === "Enter") this.connectHosted(); },
        }),
        el("button", { class: "mmc-ch-ask", text: draft.connecting ? t("Connecting…") : t("Connect"),
                       disabled: draft.connecting || null, onclick: () => this.connectHosted() }),
      ])));
      // The list arrives with the connection: a key that works is a key that
      // lists, and a model typed by hand is a model spelled wrong.
      if (draft.models) rows.push(modelRow(t("Model"), t("choose a model")));
      rows.push(this.useThis(t("Use this"), !draft.model, {
        answer: () => t("{model} on {server}", { model: draft.model, server: draft.provider }),
        apply: () => saveRefiner({ backend: "remote", remoteModel: draft.model }),
      }));
    }
    return el("div", { class: "mmc-ch-inline" }, rows);
  }

  /** Send the key, then ask the provider what it offers — the same two steps
   *  the refiner's own popover takes, in one press. */
  async connectHosted() {
    const setup = this.state;
    const draft = setup.draft;
    if (!draft.key.trim()) {
      setup.error = t("paste the provider's key first");
      return this.host.repaint();
    }
    draft.connecting = true;
    setup.error = null;
    this.host.repaint();
    try {
      await saveRemote(draft.url, draft.key.trim());
      const listed = await listRemoteModels({ force: true });
      if (listed.error) throw new Error(listed.error);
      draft.models = listed.names;
      draft.model = listed.names.find((name) => /vl|vision|claude|gpt|gemini/i.test(name)) ?? listed.names[0] ?? "";
    } catch (error) {
      setup.error = String(error.message || error);
    }
    draft.connecting = false;
    this.host.repaint();
  }

  // ---- what draws ----------------------------------------------------------------

  /** A family's name as the manifest gives it — off the scan, or off the
   *  served catalog when there was no scan to read. */
  familyLabel(id) {
    const scanned = this.state?.scan?.families?.find((entry) => entry.id === id);
    return t(scanned?.label ?? this.host.familyLabel(id));
  }

  familiesSaid() {
    const sides = this.host.sides;
    return t("{still} for pictures, {video} for clips",
             { still: this.familyLabel(sides.stillFamily() ?? STILL_ARCHES[sides.stillArch()]),
               video: this.familyLabel(sides.videoFamily()) });
  }

  /** Write two families' picks as this machine's, and make the families the
   *  room's own: what draws a picture and what makes a clip are the rail's
   *  two fields, and nothing on the canvas is moved for it. */
  async pickFamilies(still, video, picks = null) {
    const weights = {};
    for (const family of [still, video]) {
      if (!family) continue;
      weights[family.id] = { ...(rememberedWeights()[family.id] ?? {}), ...(picks?.[family.id] ?? family.picks) };
    }
    patchSettings({ weights });
    const patch = {};
    if (video) patch.video_family = video.id;
    if (still) {
      const arch = Object.keys(STILL_ARCHES).find((key) => STILL_ARCHES[key] === still.id);
      if (arch) patch.still_arch = arch;
    }
    if (Object.keys(patch).length) this.host.setRail(patch);
  }

  families() {
    const scan = this.state.scan;
    const still = proposed(scan, "still");
    const video = proposed(scan, "video");
    const both = ready(still) && ready(video);
    let ask;
    const chips = [];
    if (both) {
      ask = t("Good. For the drawing itself, your models folder has everything {still} needs for pictures and everything {video} needs for clips. Go with those?", { still: still.label, video: video.label });
      chips.push({ label: t("{still} and {video}", { still: still.label, video: video.label }), found: true,
                   answer: () => this.familiesSaid(), apply: () => this.pickFamilies(still, video) });
    } else if (ready(still) || ready(video)) {
      const have = ready(still) ? still : video;
      const kind = ready(still) ? t("pictures") : t("clips");
      const other = ready(still) ? t("clips") : t("pictures");
      ask = t("For the drawing itself: your models folder has everything {family} needs for {kind}, but nothing on this disk is complete for {other} yet. Go with {family}, and pick the other files later from the node?", { family: have.label, kind, other });
      chips.push({ label: t("{family} for {kind}", { family: have.label, kind }), found: true,
                   answer: () => this.familiesSaid(), apply: () => this.pickFamilies(still, video) });
    } else {
      ask = t("For the drawing itself: nothing in your models folder is complete for pictures or for clips yet. Choose the files by hand, or go on and pick them later from the node — the room will say what is missing if it is asked.");
      chips.push({ label: t("Go on for now"), answer: () => this.familiesSaid(),
                   apply: () => this.pickFamilies(still, video) });
    }
    chips.push({ label: t("Let me choose…"), opens: () => ({
      still: still?.id ?? "", video: video?.id ?? "",
      picks: Object.fromEntries((scan?.families ?? []).map((entry) => [entry.id, { ...entry.picks }])),
    }) });
    return { ask, chips, detail: () => this.familiesDetail() };
  }

  familiesDetail() {
    const setup = this.state;
    const draft = setup.draft;
    const list = (kind) => el("div", { class: "mmc-ch-choices", role: "radiogroup" },
      families(setup.scan, kind).map((entry) => this.familyChoice(entry, kind)));
    const chosen = draft.still && draft.video;
    return el("div", { class: "mmc-ch-inline mmc-ch-wide" }, [
      el("div", { class: "mmc-ch-askhead", text: t("Pictures") }),
      list("still"),
      el("div", { class: "mmc-ch-askhead", text: t("Clips") }),
      list("video"),
      this.useThis(t("Use these"), !chosen, {
        answer: () => this.familiesSaid(),
        apply: () => this.pickFamilies(
          setup.scan.families.find((entry) => entry.id === draft.still),
          setup.scan.families.find((entry) => entry.id === draft.video),
          draft.picks),
      }),
    ]);
  }

  /** One family as a choice: its name, how many of its files are here, and
   *  its slots to change under it — open by itself where something is missing. */
  familyChoice(entry, kind) {
    const draft = this.state.draft;
    const on = draft[kind] === entry.id;
    const picks = draft.picks[entry.id];
    const required = entry.slots.filter((slot) => slot.required);
    const have = required.filter((slot) => picks[slot.id]).length;
    const missing = required.filter((slot) => !picks[slot.id]).map((slot) => t(slot.title));
    const state = missing.length === 0
      ? el("span", { class: "mmc-ch-state found", text: t("{n} of {n} files found", { n: required.length }) })
      : have === 0
        ? el("span", { class: "mmc-ch-state missing", text: t("nothing on this disk") })
        : el("span", { class: "mmc-ch-state missing", text: t("{have} of {all} — pick the rest", { have, all: required.length }) });
    const slots = el("details", { class: "mmc-ch-slots", open: on && missing.length > 0 }, [
      el("summary", { text: t("Change files") }),
      slotList(entry, picks, () => this.host.repaint()),
    ]);
    return el("div", {
      class: "mmc-ch-choice", role: "radio", "aria-checked": on, tabindex: "0",
      onclick: (event) => {
        if (event.target.closest("details")) return;
        draft[kind] = entry.id;
        this.host.repaint();
      },
      onkeydown: (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        draft[kind] = entry.id;
        this.host.repaint();
      },
    }, [
      el("span", { class: "mmc-ch-choicename", text: t(entry.label) }),
      state,
      slots,
    ]);
  }

  // ---- how it comes out --------------------------------------------------------

  shapeSaid() {
    const bar = this.host.rail();
    const video = bar.video_edge || rulesFor(this.host.sides.videoFamily()).nativeShortEdge;
    return t("{aspect}, pictures at {still}p, clips at {video}p",
             { aspect: bar.aspect, still: bar.still_edge, video });
  }

  shape() {
    const chips = QUICK_SHAPES.map(([aspect, label]) => ({
      label: t(label), answer: () => this.shapeSaid(),
      apply: () => this.host.setRail({ aspect }),
    }));
    chips.push({ label: t("More options…"), opens: () => ({}) });
    return {
      ask: t("Last one. What shape should things come out in? You can always ask for a different one in a message — this is just where we start."),
      chips,
      detail: () => this.shapeDetail(),
    };
  }

  /** The room's own three, under the bubble: the shape as the simple view's
   *  own grid, and the two sizes. Written to the rail as they are moved,
   *  which is what the gear does too. Everything else about a render — the
   *  turbo switch, the seed, the row — is the nodes' and is on them. */
  shapeDetail() {
    const bar = this.host.rail();
    const rules = rulesFor(this.host.sides.videoFamily());
    const sizePill = (kind) => el("button", {
      class: "mmc-pill mmc-ch-value",
      text: `${kind === "still" ? bar.still_edge : bar.video_edge || rules.nativeShortEdge}p`,
      onclick: (event) => this.host.openEdge(event.currentTarget, kind,
                                             (edge) => this.host.setRail({ [`${kind}_edge`]: edge })),
    });
    return el("div", { class: "mmc-ch-inline mmc-ch-wide" }, [
      aspectGrid(rules.aspects, bar.aspect, bar.aspect, (label) => this.host.setRail({ aspect: label })),
      this.row(t("Picture size"), sizePill("still"), t("The short edge a picture is drawn at. Bigger is slower.")),
      this.row(t("Clip size"), sizePill("video"), t("The short edge a clip is sampled at.")),
      this.useThis(t("Use these"), false, { answer: () => this.shapeSaid(), apply: () => {} }),
    ]);
  }

  // ---- pieces --------------------------------------------------------------------

  row(label, control, title) { return row(label, control, title); }

  choice(text, spec, bad = false) { return choice(text, spec, bad); }

  /** The button that closes a long form, and the refusal from the last press. */
  useThis(label, disabled, chip) {
    const key = this.pending();
    const question = this[key]();
    return el("div", { class: "mmc-ch-askfoot" }, [
      this.state.error ? el("span", { class: "mmc-ch-askerror", text: this.state.error }) : null,
      el("span", { class: "mmc-bn-gap" }),
      el("button", {
        class: "mmc-ch-ask primary", text: label, disabled: disabled || null,
        onclick: () => this.answer(key, question, chip),
      }),
    ]);
  }
}
