// The shipped starters: a library that opens empty teaches nothing.
//
// A JS module rather than files on disk, which is the whole of their storage
// story: nothing to read at boot, nothing to half-write, no route to serve them
// and no id that can collide with a user's. They carry their sections inline, so
// `loadBody` hands them straight back without touching userdata.
//
// **None of them names a file.** A starter that pointed at a checkpoint, a LoRA
// or a reference would be broken on every machine but the one it was written on,
// and a library whose shipped half is red is worse than one that ships nothing.
// So these carry rows, canvases and seams — the settings that mean the same thing
// everywhere — and leave the weights to the node.
//
// They cannot be overwritten or starred: a starter is the same for everybody, and
// "Save current setup" is how you get one of your own.
//
// **A starter's picture is shipped, not stored.** A saved preset's cover is a
// render in the output folder, served by the still route; a starter has no
// render behind it on any machine, so the pre-stage ones carry a webp of what
// they draw (rendered on the lab, off the starter's own prompt where it has
// one) under `presets/covers/`, addressed off
// `import.meta.url` the way the Style tab's atlas stills are — the same
// exception to the library's "nothing here stores an image" rule, for the
// same reason. `cover` names the file by stem; the row gets it as `picture`,
// a plain URL rather than a `{path, kind}` asset row, since no route resolves it.

import { describe } from "../presets.js";
import * as S from "../state.js";

/** Build the index row a card draws from, so a starter is described by exactly
 *  the function a saved preset is described by. */
function builtin({ id, name, scope, note, data, cover = null }) {
  return {
    picture: cover ? new URL(`./covers/${cover}.webp`, import.meta.url).href : null,
    id: `builtin.${id}`,
    name,
    scope,
    note,
    folder: "",
    starred: false,
    builtin: true,
    created: 0,
    updated: 0,
    sections: Object.keys(data),
    cover: null,
    data,
    ...describe(data, scope),
  };
}

/** The character-sheet starters' prompt. The first line is the character and
 *  is meant to be overwritten — it differs by family, since on Qwen Image 2.1
 *  an attached picture can *be* the character and on Krea 2 it is a look; the
 *  rest is the board. Sentences rather than a list, and the heads as a
 *  turntable in degrees: named "left" and "right" the model draws the left
 *  side twice and skips the right. No clothing word anywhere — not "costume",
 *  not "outfit", not a list of fabric and fastenings for the close-ups, and
 *  no "if the character wears nothing" either: Qwen paints whatever is named,
 *  negated or not, and dressed a bare fox in a buttoned jacket to fill the
 *  slots. The close-ups are enlargements of what the full-body views show, so
 *  a coat yields seams and buttons and a fox yields fur. */
export function characterSheet(firstLine) {
  return [
    firstLine,
    "",
    "Character reference sheet of that character, on a plain white background, laid out "
    + "like a character designer's turnaround board with even spacing between panels.",
    "",
    "Left half: three full-body views of the same character standing in a relaxed neutral "
    + "pose, all at the same height, side by side — front view, left profile, back view.",
    "",
    "Right half, top: six head-and-shoulders studies in two rows of three, a turntable "
    + "sequence in which the head rotates from one panel to the next so that no two panels "
    + "show the same angle: panel 1 faces the camera straight on, panel 2 is turned 45 "
    + "degrees showing the left cheek, panel 3 is the exact left profile, panel 4 is the "
    + "back of the head, panel 5 is the exact right profile, panel 6 is turned 45 degrees "
    + "the other way showing the right cheek.",
    "",
    "Right half, bottom: a row of eight square close-up studies at the same scale, each "
    + "one an enlargement of a detail that is visible in the full-body views above: the "
    + "eyes at close range, a hand, the feet, the surface texture of the body, and four "
    + "more of whatever the full-body views show most distinctively on this character.",
    "",
    "The same character with the same appearance and consistent lighting in every panel; "
    + "soft, even studio light; sharp detail.",
  ].join("\n");
}

export const CHARACTER_SHEET = characterSheet(
  "Character: (describe the character here, or attach a picture of them and name it with @)");

/** The storyboard starters: one per shot count, because the count is the one
 *  thing the model will not take from the list. Told "one panel for every shot
 *  listed below" it draws the listed shots first and then pads the sheet out to
 *  twelve, whatever the list's length (four beats came back as twelve panels,
 *  six as twelve); told "exactly N panels in R rows and C columns" it draws N,
 *  in order, at every count tried. Only a preset carries a canvas and a prompt
 *  together, so a card per count is the interface, and the user never edits
 *  the grid sentence. Four and six only: two and three rendered fine stacked
 *  on a portrait sheet but were cut to keep the library short, five split its
 *  second row into panels of different sizes, and six is the ceiling by design.
 *
 *  No panel numbers. Asked for them the model printed 2-2-5 on three panels
 *  and 1-2-5-4-5-6 on six; the grid fixes the reading order without them, and
 *  a wrong number is the one defect on an otherwise usable sheet. The last
 *  line is the look, and rewriting it ("loose graphite pencil sketch with grey
 *  marker tone on white paper") turns the same board into a drawn one. */
export const STORYBOARD_GRIDS = {
  4: { layout: "in a grid of 2 rows and 2 columns", aspect: "16:9" },
  6: { layout: "in a grid of 2 rows and 3 columns", aspect: "16:9" },
};

/** The sample beats, one story cut to each length so every card renders a
 *  sensible sheet before a word is changed. Each line opens with the shot
 *  type, which is the vocabulary the starter teaches; "the character" rather
 *  than a pronoun so the beats fit whoever the first line names. */
const STORYBOARD_BEATS = {
  pier: "wide establishing shot: the character walks down a harbour pier at dawn, fog on the water",
  rope: "medium shot: the character unties a mooring rope, hands working the knot",
  face: "close-up: the character's face, looking out at the horizon, breath fogging in the cold",
  away: "wide shot from the pier: the character's small boat pulling away into the fog",
  back: "over-the-shoulder shot from the stern: the character looks back at the coast shrinking behind",
  bow: "low-angle shot: the character stands at the bow, the first sunlight breaking through the fog",
};
const STORYBOARD_CUTS = {
  4: ["pier", "rope", "away", "bow"],
  6: ["pier", "rope", "face", "away", "back", "bow"],
};

export function storyboard(firstLine, count) {
  const { layout } = STORYBOARD_GRIDS[count];
  return [
    firstLine,
    "",
    `Film storyboard of that character: exactly ${count} panels ${layout}, every panel the same `
    + "size with a 16:9 frame, thin black panel borders, even white gutters between panels, and "
    + "no text anywhere.",
    "",
    ...STORYBOARD_CUTS[count].map((key, i) => `Panel ${i + 1}, ${STORYBOARD_BEATS[key]}.`),
    "",
    "Same character, same outfit in every panel; cinematic, photographic; consistent lighting "
    + "and colour grade across all panels.",
  ].join("\n");
}

const STORYBOARD_CHARACTER =
  "Character: (describe the character here, or attach a picture of them and name it with @)";

export const BUILTIN = [
  builtin({
    id: "native-row",
    name: "Native row — 20 steps",
    scope: "piece",
    note: "What the H3 templates sample with, and what this node declares. The way "
        + "back from a turbo row.",
    data: {
      speed: {
        turbo: null,
        row: {
          steps: S.TURBO_RESET.steps,
          cfg: 1.0,
          sampler_name: S.TURBO_RESET.sampler_name,
          scheduler: S.TURBO_RESET.scheduler,
          shift_video: S.TURBO_RESET.shift_video,
          shift_audio: S.TURBO_RESET.shift_audio,
          block_cache: "off",
          spectrum: false,
        },
      },
    },
  }),

  builtin({
    id: "draft-row",
    name: "Draft row — 4 steps",
    scope: "piece",
    note: "The row a turbo LoRA wants: euler on beta, four steps. Pick the LoRA "
        + "itself in the weights popover — a preset cannot name a file that is "
        + "only on your disk.",
    data: {
      speed: {
        turbo: null,
        row: {
          steps: S.TURBO_STEPS.draft,
          cfg: 1.0,
          sampler_name: S.TURBO_SAMPLER,
          scheduler: S.TURBO_SCHEDULER,
          block_cache: "off",
          spectrum: false,
        },
      },
    },
  }),

  builtin({
    id: "vertical",
    name: "Vertical — 9:16",
    scope: "piece",
    note: "A phone-shaped canvas at the native short edge.",
    data: {
      // No `short_edge`: the native edge is the family's, and a starter is
      // family-neutral, so a number here would be one family's edge applied to
      // whichever piece the preset lands on. Omitted, `applyToPiece` leaves the
      // piece's own — which `lookDefaults` sets to its family's native.
      look: { aspect: "9:16", upscale: "two_pass" },
    },
  }),

  builtin({
    id: "feathered-continuation",
    name: "Feathered continuation — 6 s",
    scope: "shot",
    note: "A card that runs on from the one in front of it, picture and sound, with "
        + "the medium blend across the seam instead of the classic single frame.",
    data: {
      shot: {
        duration_s: 6,
        checkpoint: "auto",
        continue: true,
        continue_audio: true,
        // The middle width of the default family's grid. A starter is
        // family-neutral and a width is not, so `applyToShot` retargets this
        // onto the grid of whatever family the card belongs to — see
        // `S.nearestFeather`. Copied verbatim it would fall off that grid and
        // read back as the classic single frame.
        feather: S.DEFAULT_FEATHER_GRID[2],
      },
    },
  }),

  builtin({
    id: "hard-cut",
    name: "Hard cut — 4 s",
    scope: "shot",
    note: "A short card that starts fresh: no continuation, no blend. What a cut is.",
    data: {
      shot: { duration_s: 4, checkpoint: "auto", continue: false, continue_audio: false },
    },
  }),

  builtin({
    id: "poster-still",
    name: "Poster — Ideogram 4",
    scope: "prestage",
    cover: "poster-still",
    note: "Ideogram 4.0 on its quality preset, landscape 3:2. Ideogram owns its own "
        + "resolution-shifted schedule, so the scheduler pill does not apply.",
    data: {
      look: { aspect: "3:2", short_edge: S.PRESTAGE_DEFAULT_EDGE },
      weights: { arch: "ideogram4", quality: "quality", models: {} },
      speed: {
        turbo: null,
        row: {
          steps: S.PRESTAGE_IDEOGRAM_STEPS.quality,
          cfg: S.PRESTAGE_IDEOGRAM_ROW.cfg,
          sampler_name: S.PRESTAGE_IDEOGRAM_ROW.sampler_name,
        },
      },
    },
  }),

  // The same board on Krea 2 RAW. Its first line offers no picture: on this
  // family an attached picture is a look the adapter carries, not the
  // character, so the character is prose here.
  builtin({
    id: "character-sheet",
    name: "Character sheet — Krea 2",
    scope: "prestage",
    cover: "character-sheet-krea2",
    note: "A costume designer's turnaround board on Krea 2 RAW: three full-body "
        + "views, six heads around a full turn, a row of close-ups. Replace the "
        + "first line with your character. Landscape 16:9 at the native edge, the "
        + "model's own row.",
    data: {
      look: { aspect: "16:9", short_edge: S.PRESTAGE_DEFAULT_EDGE },
      weights: { arch: "krea2", models: {} },
      speed: { turbo: null, row: { ...S.PRESTAGE_BASE_ROW.krea2 } },
      prompt: { prompt: characterSheet("Character: (describe the character here)") },
    },
  }),

  // The one starter that carries a prompt. Everything in it is layout — the
  // turnaround, the head turntable in degrees (the model repeats "left" if
  // asked for left and right by name), the close-up row — and the character
  // is the one line at the top, which is what the user writes or cites. Qwen
  // Image 2.1 because it holds one character across fifteen panels at native
  // 2K, from prose or from a picture, on the same checkpoint; the lab sheets
  // this was written against are in the changelog entry.
  builtin({
    id: "character-sheet-qwen21",
    name: "Character sheet — Qwen Image 2.1",
    scope: "prestage",
    cover: "character-sheet-qwen21",
    note: "A costume designer's turnaround board: three full-body views, six "
        + "heads around a full turn, a row of close-ups. Replace the first line "
        + "with your character — or attach a picture of them and name it with @. "
        + "Landscape 16:9 at 1152, the model's own row.",
    data: {
      look: { aspect: "16:9", short_edge: 1152 },
      weights: { arch: "qwen21", models: {} },
      speed: { turbo: null, row: { ...S.PRESTAGE_BASE_ROW.qwen21 } },
      prompt: { prompt: CHARACTER_SHEET },
    },
  }),

  // One card per shot count — see `storyboard` for why the count cannot be
  // left to the list, and why the canvas rides with it.
  ...[4, 6].map((count) => builtin({
    id: `storyboard-${count}-qwen21`,
    name: `Storyboard, ${count} shots — Qwen Image 2.1`,
    scope: "prestage",
    cover: `storyboard-${count}-qwen21`,
    note: `${count} shots of one character on one sheet, ${STORYBOARD_GRIDS[count].layout}. `
        + "Replace the first line with your character — or attach a picture of them and "
        + "name it with @ — and rewrite the panel lines, one shot each, keeping the count. "
        + "The last line is the look: name a pencil sketch there for a drawn board.",
    data: {
      look: { aspect: STORYBOARD_GRIDS[count].aspect, short_edge: 1152 },
      weights: { arch: "qwen21", models: {} },
      speed: { turbo: null, row: { ...S.PRESTAGE_BASE_ROW.qwen21 } },
      prompt: { prompt: storyboard(STORYBOARD_CHARACTER, count) },
    },
  })),

  builtin({
    id: "same-person-next-shot",
    name: "Same person, next shot — Qwen Image 2.1",
    scope: "prestage",
    cover: "same-person-next-shot",
    note: "The continuity errand: attach the frame you already have, name it with "
        + "@ in the first line, and write what changes in the second — the render "
        + "starts from that picture rather than from noise. 16:9 and the model's "
        + "own row; the canvas follows the picture you attach.",
    data: {
      look: { aspect: "16:9", short_edge: S.PRESTAGE_DEFAULT_EDGE },
      // Qwen Image 2.1 rather than Qwen Image Edit: it reads the attached
      // picture the same way and holds the person better across the cut.
      weights: { arch: "qwen21", models: {} },
      speed: { turbo: null, row: { ...S.PRESTAGE_BASE_ROW.qwen21 } },
      // The shape of an edit prompt: who stays the same, then what changes.
      // Same face, hair and clothing said outright, because the model keeps
      // what it is told to keep and drifts on what it is not.
      prompt: { prompt: [
        "The same person as in (attach the picture and name it with @), with the same "
        + "face, hair and clothing.",
        "",
        "Next shot: (describe what changes — the pose, the camera angle, the place, "
        + "the light). Everything about the person themselves stays exactly as in the "
        + "picture.",
      ].join("\n") },
    },
  }),
];
