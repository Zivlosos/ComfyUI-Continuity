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

import { describe } from "../presets.js";
import * as S from "../state.js";

/** Build the index row a card draws from, so a starter is described by exactly
 *  the function a saved preset is described by. */
function builtin({ id, name, scope, note, data }) {
  return {
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

/** The character-sheet starter's prompt. The first line is the character and
 *  is meant to be overwritten; the rest is the board. Sentences rather than a
 *  list, and the heads as a turntable in degrees: named "left" and "right"
 *  the model draws the left side twice and skips the right. */
export const CHARACTER_SHEET = [
  "Character: (describe the character here, or attach a picture of them and name it with @)",
  "",
  "Character reference sheet of that character, on a plain white background, laid out "
  + "like a costume designer's turnaround board with even spacing between panels.",
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
  "Right half, bottom: a row of eight square close-up studies at the same scale — the "
  + "main fabric or surface texture, a garment seam or fold, a fastening (buttons, laces, "
  + "buckle or strap), a decorative detail or accessory, the skin texture of the "
  + "character's body, the eyes at close range, a hand, and the footwear on its own.",
  "",
  "Consistent character, consistent outfit, consistent lighting across every panel; "
  + "soft, even studio light; sharp detail.",
].join("\n");

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

  builtin({
    id: "character-sheet",
    name: "Character sheet — Krea 2",
    scope: "prestage",
    note: "Krea 2 RAW at its own row, portrait 9:16 — the shape a reference sheet "
        + "wants before it becomes a shot's @reference.",
    data: {
      look: { aspect: "9:16", short_edge: S.PRESTAGE_DEFAULT_EDGE },
      weights: { arch: "krea2", models: {} },
      speed: { turbo: null, row: { ...S.PRESTAGE_BASE_ROW.krea2 } },
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

  builtin({
    id: "same-person-next-shot",
    name: "Same person, next shot — Qwen Image Edit",
    scope: "prestage",
    note: "The continuity errand: attach the frame you already have, write what "
        + "changes, and the render starts from that picture rather than from noise. "
        + "16:9 and the model's own row; the canvas follows the picture you attach.",
    data: {
      look: { aspect: "16:9", short_edge: S.PRESTAGE_DEFAULT_EDGE },
      weights: { arch: "qwenedit", models: {} },
      speed: { turbo: null, row: { ...S.PRESTAGE_BASE_ROW.qwenedit } },
    },
  }),
];
