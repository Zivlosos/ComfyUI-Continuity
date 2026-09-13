"""A LoRA on a cast member, on every surface that draws them (discussion #82).

The shelf's open card wears it as a chip on the "wears" line, the chip's menu
edits its words and its weight in place, the blob round-trips it through the
stack's own serializer, the library keeps it with the member and hands it back,
and the library's sheet draws it as a row. Driven through the real modules
against the DOM shim, the way test_cast_role_notes.py and test_cast_editor.py
are.

    python3 tests/test_cast_lora_ui.py

Skips itself if node is not installed.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

import layout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

if shutil.which("node") is None:
    print("skipped: node is not installed")
    sys.exit(0)

from domshim import DOM  # noqa: E402  (after the node check above)

STUBS = {
    "app.js": "export const app = { registerExtension() {}, extensionManager: null };",
    "api.js": """
const store = new Map();
export const api = {
  apiURL: (u) => u, addEventListener() {}, removeEventListener() {},
  async fetchApi(url) {
    if (String(url).startsWith("/continuity/families")) {
      const body = (await import("node:fs")).readFileSync(new URL("./families.json", import.meta.url), "utf8");
      return { ok: true, status: 200, json: async () => JSON.parse(body) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  },
  async getUserData(file) {
    return store.has(file)
      ? { status: 200, json: async () => JSON.parse(store.get(file)) }
      : { status: 404, json: async () => null };
  },
  async storeUserData(file, value) { store.set(file, JSON.stringify(value)); return { status: 200 }; },
  async deleteUserData(file) { store.delete(file); return { status: 204 }; },
};
""",
    "widgets.js": "export const ComfyWidgets = {};",
}

CHECK = r"""
await import("./dom.mjs");
const { CastShelf } = await import("./web/creator/cast.js");
const S = await import("./web/creator/state.js");
const P = await import("./web/creator/presets.js");
const { openPresetLibrary } = await import("./web/creator/presetlib.js");

const out = { errors: [] };
const wait = () => new Promise((r) => setTimeout(r, 0));

function all(root, cls) {
  const found = [];
  const walk = (node) => {
    if (String(node.className ?? "").split(" ").includes(cls)) found.push(node);
    (node.children ?? []).forEach(walk);
  };
  walk(root);
  return found;
}
const one = (root, cls) => all(root, cls)[0] ?? null;
const press = (node) => node?.listeners?.click?.[0]?.({
  currentTarget: node, target: node, stopPropagation() {}, preventDefault() {},
});
function type(field, value) {
  field.value = value;
  field.listeners?.input?.[0]?.({ target: field, currentTarget: field, stopPropagation() {} });
}

const img = (handle) => ({ handle, kind: "image", role: "reference", filename: `${handle}.png` });
const ANNA = { name: "people/anna_v3.safetensors", strength: 0.85, triggers: ["ohwx anna"] };

function host({ cast, assets }) {
  const state = { cast, assets, touched: 0, committed: 0 };
  state.shelf = new CastShelf({
    getCast: () => state.cast,
    setCast: (list) => { state.cast = list; },
    getAssets: () => state.assets,
    addAsset: async () => null,
    whereCited: () => ({ cited: false, text: "" }),
    cite: () => {},
    touch: () => { state.touched += 1; },
    commit: () => { state.committed += 1; },
  });
  return state;
}

try {
  // ---- the shelf: the line, the chip, the menu ---------------------------------
  {
    const ana = { handle: "ana", takes: "person", from: ["img-1"], loras: [{ ...ANNA, triggers: [...ANNA.triggers] }] };
    const bare = { handle: "ben", takes: "person", description: "a tall man" };
    const state = host({ cast: [ana, bare], assets: [img("img-1")] });
    state.shelf.render();
    // The shut line marks that Ana wears one and Ben wears nothing.
    out.shutMarks = all(state.shelf.root, "mmc-cast-row").map((row) => Boolean(one(row, "mmc-cast-line-wears")));
    state.shelf.opened = ana;
    state.shelf.render();
    const root = state.shelf.root;
    const wears = one(root, "mmc-cast-wears");
    out.wearsLine = { drawn: Boolean(wears), on: String(wears?.className).includes(" on") };
    const chip = one(wears, "mmc-cast-lora");
    out.chip = {
      name: one(chip, "mmc-cast-lora-name")?.text,
      weight: one(chip, "mmc-cast-lora-weight")?.text,
      words: one(chip, "mmc-cast-lora-words")?.text,
    };
    out.addOffered = Boolean(one(wears, "mmc-cast-wear-add"));

    // The chip's menu: words and weight at its head, written to the entry as
    // typed and dragged; a row takes it off.
    press(chip);
    await wait();
    const menu = one(globalThis.document.body, "mmc-cast-menu");
    const wordsField = one(one(menu, "mmc-cast-menu-wear"), "mmc-cast-menu-field");
    type(wordsField, "OHWX anna, film still ");
    const slider = one(menu, "mmc-cast-menu-weight");
    type(slider, "0.6");
    out.edited = { triggers: ana.loras[0].triggers, strength: ana.loras[0].strength,
                   touched: state.touched > 0, committed: state.committed };
    const mute = all(menu, "mmc-opt").find((b) => /^Mute\b/.test(b.text.replace(/\s+/g, " ").trim()));
    press(mute);
    await wait();
    out.muted = { enabled: ana.loras[0].enabled, committed: state.committed };
    // Struck on the redraw, not gone.
    out.mutedChip = String(one(state.shelf.root, "mmc-cast-lora")?.className).includes("off");
    press(one(state.shelf.root, "mmc-cast-lora"));
    await wait();
    const menu2 = all(globalThis.document.body, "mmc-cast-menu").pop();
    const off = all(menu2, "mmc-opt").find((b) => /Take it off/.test(b.text));
    press(off);
    await wait();
    out.takenOff = { loras: ana.loras ?? null, line: String(one(state.shelf.root, "mmc-cast-wears")?.className).includes(" on") };
  }

  // ---- the blob: through the stack's own serializer and back -----------------
  {
    const timeline = S.parseTimeline(JSON.stringify({
      version: 2, prompt: "", segments: [{ prompt: "@ana walks in.", duration_s: 6 }],
      subjects: [{ handle: "ana", from: ["ref-1"],
                   loras: [{ ...ANNA, enabled: true, modes: ["fl2va", "ref2va"], triggers: "ohwx anna, Blue" }] }],
    }));
    const stored = JSON.parse(S.serializeTimeline(timeline)).subjects[0].loras;
    out.roundTrip = stored;
    // The mirror of `compile.cast_loras`: her LoRA counts on the shot that
    // cites her, under the shot's own entry for the same file.
    S.syncTimeline?.(timeline);
    const shot = timeline.segments[0];
    shot.loras = [{ name: ANNA.name, strength: 0.4, enabled: true, modes: ["fl2va", "ref2va"], triggers: [] }];
    out.active = S.activeLoras(shot).map((e) => [e.name, e.strength]);
    out.activeOff = S.activeLoras({ ...shot, prompt: "an empty room.", loras: [] }).length;
  }

  // ---- the library: kept with them, handed back ------------------------------
  {
    const ana = { handle: "ana", takes: "person", from: ["img-1"],
                  loras: [{ ...ANNA, triggers: [...ANNA.triggers], enabled: false }] };
    const captured = P.captureSubject(ana, [img("img-1")]);
    out.kept = captured.data.cast.loras;
    out.facts = P.castFactsLine(P.factsOf(captured.data, "cast"));
    const landed = P.addSubjectToPiece(captured.data.cast, { assets: [], subjects: [], segments: [] });
    out.landed = landed.loras;
    // A member wearing nothing writes no key.
    out.plainKept = "loras" in P.captureSubject({ handle: "ben", from: ["img-1"] }, [img("img-1")]).data.cast;
    // ...and a LoRA with a word is enough to stand behind a name; one without is not.
    out.problem = [
      S.subjectProblem({ subjects: [], assets: [] }, { handle: "ben", loras: [{ ...ANNA }] }),
      S.subjectProblem({ subjects: [], assets: [] }, { handle: "ben", loras: [{ name: "x", triggers: [] }] }),
    ];
  }

  // ---- the sheet: a row, its menu ---------------------------------------------
  {
    openPresetLibrary({ scope: "cast" });
    await wait(); await wait();
    const modal = one(globalThis.document.body, "mmc-modal");
    const newButton = all(modal, "mmc-upload").find((b) => /New cast member/.test(b.text));
    press(newButton);
    await wait(); await wait(); await wait();
    const lib = globalThis.__lib;
    lib.body.cast.loras = [{ ...ANNA, triggers: [...ANNA.triggers] }];
    lib.renderSheet();
    const sheet = one(modal, "mmc-cast-sheet");
    const row = one(sheet, "mmc-cast-sheet-lora");
    out.sheetRow = {
      drawn: Boolean(row),
      name: one(row, "mmc-cast-sheet-filename")?.text,
      note: one(row, "mmc-cast-sheet-filenote")?.text,
      weight: one(row, "mmc-cast-sheet-enc")?.text?.replace(/\s+/g, " ").trim(),
    };
    out.sheetOffers = Boolean(all(sheet, "mmc-cast-sheet-addfile").find((b) => /Hang a LoRA/.test(b.text)));
    press(row);
    await wait();
    const menu = all(globalThis.document.body, "mmc-cast-menu").pop();
    type(one(one(menu, "mmc-cast-menu-wear"), "mmc-cast-menu-field"), "ohwx anna, portrait");
    await lib.flushSave();
    const rows = (await P.listPresets({ force: true })).filter((r) => r.scope === "cast");
    const body = await P.loadBody(rows[0]);
    out.sheetStored = body.cast.loras;
    out.sheetFacts = rows[0].facts?.loras;
  }
} catch (error) {
  out.errors.push(`cast lora: ${error.stack}`);
}

console.log(JSON.stringify(out));
"""

work = tempfile.mkdtemp(prefix="mmc-cast-lora-")
try:
    pack = os.path.join(work, "pack")
    shutil.copytree(os.path.join(ROOT, "web"), os.path.join(pack, "web"))
    os.makedirs(os.path.join(work, "scripts"), exist_ok=True)
    for name, source in STUBS.items():
        with open(os.path.join(work, "scripts", name), "w", encoding="utf-8") as handle:
            handle.write(source)
    with open(os.path.join(work, "scripts", "families.json"), "w", encoding="utf-8") as handle:
        handle.write(layout.catalog_json())
    # The library instance is otherwise private to `openPresetLibrary` — the
    # same seam test_cast_editor.py opens.
    lib_path = os.path.join(pack, "web", "creator", "presetlib.js")
    with open(lib_path, encoding="utf-8") as handle:
        source = handle.read()
    source = source.replace(
        "    this.unmount = mountOverlay(this.overlay, () => this.close());",
        "    globalThis.__lib = this;\n"
        "    this.unmount = mountOverlay(this.overlay, () => this.close());")
    with open(lib_path, "w", encoding="utf-8") as handle:
        handle.write(source)
    for name, text in (("dom.mjs", DOM), ("check.mjs", CHECK)):
        with open(os.path.join(pack, name), "w", encoding="utf-8") as handle:
            handle.write(text)
    result = subprocess.run(["node", os.path.join(pack, "check.mjs")],
                            capture_output=True, text=True, cwd=pack)
finally:
    shutil.rmtree(work, ignore_errors=True)

if result.returncode != 0:
    print("the cast shelf did not run:\n"
          + (result.stderr.strip() or result.stdout.strip()))
    sys.exit(1)

report = json.loads(result.stdout.strip().splitlines()[-1])
from harness import FAILURES, check, passed  # noqa: E402

FAILURES.extend(report["errors"])

# ---- the shelf --------------------------------------------------------------

check("the open card has a wears line, lit while they wear something",
      report.get("wearsLine"), {"drawn": True, "on": True})
check("the chip says the file, the weight and the words",
      report.get("chip"), {"name": "anna_v3", "weight": "0.85", "words": "ohwx anna"})
check("...and the way to hang another beside it", report.get("addOffered"), True)
check("the shut line marks who wears something", report.get("shutMarks"), [True, False])
check("the menu writes the words as typed and the weight as dragged, without committing",
      report.get("edited"),
      {"triggers": ["OHWX anna", "film still"], "strength": 0.6, "touched": True, "committed": 0})
check("muting is a row, and a commit", report.get("muted"), {"enabled": False, "committed": 1})
check("...and the chip is struck, not gone", report.get("mutedChip"), True)
check("taking it off drops the key and dims the line",
      report.get("takenOff"), {"loras": None, "line": False})

# ---- the blob ---------------------------------------------------------------

check("the blob writes the entry through the stack's serializer — no modes where both are claimed",
      report.get("roundTrip"),
      [{"name": "people/anna_v3.safetensors", "strength": 0.85, "triggers": ["ohwx anna", "Blue"]}])
check("the shot's active stack mirrors compile: hers under the shot's own for the same file",
      report.get("active"), [["people/anna_v3.safetensors", 0.4]])
check("...and nothing where she is not cited", report.get("activeOff"), 0)

# ---- the library ------------------------------------------------------------

check("the library keeps what they wear, muted or not",
      report.get("kept"),
      [{"name": "people/anna_v3.safetensors", "strength": 0.85, "enabled": False, "triggers": ["ohwx anna"]}])
check("...and the card says so", report.get("facts"), "person · 1 picture · 1 LoRA")
check("...and hands it back onto a piece",
      report.get("landed"),
      [{"name": "people/anna_v3.safetensors", "strength": 0.85, "enabled": False, "triggers": ["ohwx anna"]}])
check("a member wearing nothing writes no key", report.get("plainKept"), False)
check("a LoRA with a word stands behind a name; one without does not",
      report.get("problem"),
      ["", "their LoRA has no trigger word — give it one, or describe them in words"])

# ---- the sheet --------------------------------------------------------------

check("the sheet draws them as a row", report.get("sheetRow"),
      {"drawn": True, "name": "anna_v3", "note": "trigger words ohwx anna", "weight": "0.85 weight"})
check("...and offers to hang one", report.get("sheetOffers"), True)
check("the row's menu writes the words to the member on disk",
      report.get("sheetStored"),
      [{"name": "people/anna_v3.safetensors", "strength": 0.85, "triggers": ["ohwx anna", "portrait"]}])
check("...and the index counts it", report.get("sheetFacts"), 1)

passed("a cast member wears a LoRA on the card, in the blob, in the library and on the sheet")
