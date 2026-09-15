// The chat room.
//
// The shell is the benches' — the overlay, the sheet, the bar with the wordmark
// in it — because a room off the same dashboard should not be a second thing
// to learn. Under the bar it is nothing like a bench: one column, the width of
// a paragraph, with the conversation above and the composer below, the shape
// every chat surface anybody uses has settled on. There is no rail. The three
// choices a message is made against are pills in the composer's foot; the
// model's name is in the bar; everything set once per machine is behind the
// gear beside it.
//
// **The composer is the one built thing on the surface.** A single rounded
// sheet that holds the attachments, the text and the foot, lifted a shade off
// the ground, with the send arrow as the only accent on the page until a render
// arrives. Everything else is type on the ground.
//
// **The transcript is a column, not a chat client.** No avatars, no timestamps,
// no tails on the bubbles. What is said is short and what matters is the render
// under it, so the assistant's line is set flush and quiet and the user's is
// the one that carries a background — the reverse of the convention, and right
// here, because the user's line is the shortest thing on the surface and the
// only one that has to be findable while scrolling back.

export const css = `
/* --- the column ------------------------------------------------------------ */
.mmc-ch-room { flex-direction: column; }
.mmc-ch-talk {
  flex: 1; min-width: 0; min-height: 0;
  display: flex; flex-direction: column;
  /* The column the transcript and the composer share. Capped and centred rather
     than run to the window's width: a line of prose past about seventy
     characters stops being read and starts being scanned, and this room is
     mostly prose. On the pair rather than on either, so they line up. */
  --mmc-ch-column: min(720px, 100%);
}

/* --- the bar's right end ----------------------------------------------------- */
.mmc-ch-model { display: flex; }
.mmc-ch-modelpill {
  display: inline-flex; align-items: center; gap: 6px; max-width: 34vw;
  height: 30px; padding: 0 8px 0 11px; border-radius: 15px;
  background: none; border: 1px solid transparent; cursor: pointer; font-family: inherit;
  font-size: calc(12.5px * var(--mmc-type)); color: var(--mmc-dim);
}
.mmc-ch-modelpill:hover { background: var(--mmc-surface); color: var(--mmc-text); }
.mmc-ch-modelpill svg { flex: none; stroke: currentColor; fill: none; stroke-width: 1.8; }
.mmc-ch-modelname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mmc-ch-gear {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; border-radius: 50%; cursor: pointer;
  background: none; border: 0; color: var(--mmc-dim);
}
.mmc-ch-gear:hover { background: var(--mmc-surface); color: var(--mmc-text); }
.mmc-ch-gear svg { stroke: currentColor; fill: none; stroke-width: 1.7; }
.mmc-ch-over .mmc-close { margin-left: 0; }

/* --- the transcript -------------------------------------------------------- */
.mmc-ch-log {
  flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain;
  padding: 28px 22px 12px;
  display: flex; flex-direction: column; gap: 18px;
}
.mmc-ch-msg { width: var(--mmc-ch-column); margin: 0 auto; display: flex; }
.mmc-ch-user { justify-content: flex-end; }
.mmc-ch-turn { max-width: 78%; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.mmc-ch-user .mmc-ch-said {
  padding: 10px 15px; border-radius: 18px 18px 6px 18px;
  background: var(--mmc-surface-2);
}
.mmc-ch-bot .mmc-ch-said { max-width: 100%; color: var(--mmc-text); }
.mmc-ch-said {
  font-size: calc(14px * var(--mmc-type)); line-height: 1.55;
  white-space: pre-wrap; word-break: break-word;
}
.mmc-ch-bad .mmc-ch-said, .mmc-ch-note.mmc-ch-bad { color: var(--mmc-bad); }
.mmc-ch-thinking { display: flex; align-items: center; gap: 8px; color: var(--mmc-faint); }

/* What went with a message: the pictures, each wearing the handle the model
   knows it by. A button, because the handle is the thing you type next. */
.mmc-ch-thumbs { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.mmc-ch-thumb {
  position: relative; width: 96px; height: 96px; padding: 0; border-radius: 12px;
  overflow: hidden; cursor: pointer; line-height: 0;
  background: var(--mmc-media-bg); border: 1px solid var(--mmc-line);
}
.mmc-ch-thumb:hover { border-color: var(--mmc-accent); }
.mmc-ch-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mmc-ch-tag {
  position: absolute; left: 6px; bottom: 6px; padding: 2px 6px; border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: calc(10px * var(--mmc-type)); line-height: 1.4;
  color: #fff; background: var(--mmc-scrim-2);
}
.mmc-ch-sound {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  color: var(--mmc-faint);
}
.mmc-ch-sound svg { stroke: currentColor; fill: none; stroke-width: 1.6; }

/* What an empty room says. A question set large, one line under it, and the
   three lines a first conversation is made of — each a button, so the first
   message can be a press. Centred vertically: the composer is at the foot
   and the eye has to be brought up to it once before it knows where it is. */
.mmc-ch-empty {
  width: var(--mmc-ch-column); margin: auto; padding-bottom: 8vh;
  display: flex; flex-direction: column; align-items: center; text-align: center;
}
.mmc-ch-empty h2 {
  margin: 0 0 8px; font-size: calc(26px * var(--mmc-type)); font-weight: 500;
  letter-spacing: -.015em; color: var(--mmc-strong);
}
.mmc-ch-empty p { margin: 0 0 26px; font-size: calc(14px * var(--mmc-type)); color: var(--mmc-faint); }
.mmc-ch-tries { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.mmc-ch-try {
  padding: 8px 14px; border-radius: 16px; cursor: pointer; font-family: inherit;
  font-size: calc(13px * var(--mmc-type)); color: var(--mmc-dim);
  background: none; border: 1px solid var(--mmc-line-3);
}
.mmc-ch-try:hover { background: var(--mmc-surface); color: var(--mmc-text); }

/* --- a render, from queued to landed --------------------------------------- */
.mmc-ch-card {
  width: 100%; max-width: 520px;
  border: 1px solid var(--mmc-line); border-radius: 16px;
  background: var(--mmc-surface); overflow: hidden;
  display: flex; flex-direction: column;
}
.mmc-ch-shot {
  display: block; width: 100%; height: auto; max-height: 52vh;
  object-fit: contain; background: var(--mmc-media-bg);
}
/* Before there is anything to show. A box of the right shape rather than a
   collapsing card: the picture arrives into the space it was always going to
   take, instead of pushing the conversation down when it lands. */
.mmc-ch-blank {
  aspect-ratio: 16 / 9; display: flex; align-items: center; justify-content: center;
}
.mmc-ch-note {
  padding: 8px 12px; font-size: calc(11.5px * var(--mmc-type)); color: var(--mmc-faint);
}
/* The real bar, off the queue's own progress. Two pixels and no label: the
   number is in the readout above it and a second copy of it here would be the
   card talking about itself. */
.mmc-ch-bar { height: 2px; background: var(--mmc-line); }
.mmc-ch-fill {
  display: block; height: 100%; background: var(--mmc-accent);
  transition: width 140ms linear;
}
.mmc-ch-doors {
  display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px;
  border-top: 1px solid var(--mmc-line);
}
.mmc-ch-handle {
  padding: 0; background: none; border: 0; cursor: pointer;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: calc(11px * var(--mmc-type)); color: var(--mmc-dim);
}
.mmc-ch-handle:hover { color: var(--mmc-accent); }
.mmc-ch-door {
  padding: 5px 11px; border-radius: 13px; cursor: pointer; font-family: inherit;
  font-size: calc(11.5px * var(--mmc-type));
  background: none; color: var(--mmc-text);
  border: 1px solid var(--mmc-line-3);
}
.mmc-ch-door:hover:not(:disabled) { background: var(--mmc-lift); }
.mmc-ch-door:disabled { opacity: .45; cursor: default; }

/* --- the composer ---------------------------------------------------------- */
/* The dock is full width so the sheet can be centred in it; the sheet is the
   column's width. A fade above it rather than a rule: the transcript scrolls
   up into it, the way it does everywhere else. */
.mmc-ch-dock {
  flex: none; padding: 6px 22px 20px; position: relative;
}
.mmc-ch-dock::before {
  content: ""; position: absolute; left: 0; right: 0; top: -28px; height: 28px;
  background: linear-gradient(to bottom, transparent, var(--mmc-bg));
  pointer-events: none;
}
.mmc-ch-compose {
  width: var(--mmc-ch-column); margin: 0 auto;
  display: flex; flex-direction: column; gap: 4px;
  padding: 12px 12px 10px; border-radius: 24px;
  background: var(--mmc-surface); border: 1px solid var(--mmc-line-3);
  box-shadow: 0 6px 24px var(--mmc-shadow-soft);
}
.mmc-ch-compose:focus-within { border-color: var(--mmc-line-2); }
.mmc-ch-box {
  width: 100%; min-width: 0; resize: none; font-family: inherit;
  font-size: calc(14px * var(--mmc-type)); line-height: 1.5;
  padding: 4px 6px; max-height: 200px;
  background: none; color: var(--mmc-text); border: 0; outline: none;
}
.mmc-ch-box::placeholder { color: var(--mmc-faint); }
.mmc-ch-box:disabled { opacity: .55; }
.mmc-ch-foot { display: flex; align-items: center; gap: 6px; }
.mmc-ch-tool, .mmc-ch-send {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 50%; cursor: pointer; border: 0;
}
.mmc-ch-tool { background: none; color: var(--mmc-dim); }
.mmc-ch-tool:hover { background: var(--mmc-surface-2); color: var(--mmc-text); }
.mmc-ch-tool svg { stroke: currentColor; fill: none; stroke-width: 2; }
.mmc-ch-send { background: var(--mmc-accent); color: var(--mmc-on-accent); }
.mmc-ch-send svg { stroke: currentColor; fill: none; stroke-width: 2.2; }
.mmc-ch-send:disabled { background: var(--mmc-surface-2); color: var(--mmc-off); cursor: default; }
.mmc-ch-tool:focus-visible, .mmc-ch-send:focus-visible, .mmc-ch-pill:focus-visible,
.mmc-ch-try:focus-visible, .mmc-ch-thumb:focus-visible, .mmc-ch-gear:focus-visible,
.mmc-ch-modelpill:focus-visible {
  outline: 2px solid var(--mmc-accent); outline-offset: 2px;
}

/* What a message is made against: text with a glyph, no box, so the three
   read as the composer's own foot and not as a row of controls lifted off a
   node. The shape opens the simple view's own aspect grid. */
.mmc-ch-pills { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; min-width: 0; }
.mmc-ch-pill {
  display: inline-flex; align-items: center; gap: 6px; max-width: 22ch;
  height: 30px; padding: 0 10px; border-radius: 15px; cursor: pointer;
  background: none; border: 0; font-family: inherit;
  font-size: calc(12.5px * var(--mmc-type)); color: var(--mmc-dim);
}
.mmc-ch-pill:hover { background: var(--mmc-surface-2); color: var(--mmc-text); }
.mmc-ch-pill svg { flex: none; stroke: currentColor; fill: none; stroke-width: 1.7; }
.mmc-ch-pill span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Files waiting to go. Square, small, with an × in the corner; they get their
   handle when they are sent, not before. */
.mmc-ch-chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 2px 6px 8px; }
.mmc-ch-chips[hidden] { display: none; }
.mmc-ch-chip {
  position: relative; width: 64px; height: 64px; border-radius: 12px; overflow: visible;
  background: var(--mmc-media-bg); border: 1px solid var(--mmc-line); line-height: 0;
}
.mmc-ch-chip img { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: 11px; }
.mmc-ch-unchip {
  position: absolute; top: -6px; right: -6px; width: 20px; height: 20px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  background: var(--mmc-strong); color: var(--mmc-ground); border: 2px solid var(--mmc-surface);
  padding: 0;
}
.mmc-ch-unchip svg { stroke: currentColor; fill: none; stroke-width: 2.4; }

/* --- the gear's popover -------------------------------------------------------- */
.mmc-ch-more { width: 320px; max-width: calc(100vw - 24px); padding: 10px 12px 12px; }
.mmc-ch-more .mmc-pop-title { padding: 2px 0 10px; }
.mmc-ch-row { display: flex; align-items: center; gap: 8px; min-height: var(--mmc-pill-h); padding: 2px 0; }
.mmc-ch-label { flex: 1; min-width: 0; font-size: calc(12.5px * var(--mmc-type)); }
.mmc-ch-value { max-width: 62%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mmc-ch-rule { height: 1px; margin: 8px 0; background: var(--mmc-line); }
/* The simple view's seed pill, in a row of the gear. Its stylesheet folds it
   away everywhere the full seed group is a line below; nothing is below this. */
.mmc-ch-seed { display: flex; gap: 6px; }
.mmc-ch-seed .mmc-seed-pill { display: flex; padding: 0; }

/* --- narrow --------------------------------------------------------------- */
@media (max-width: 720px) {
  .mmc-ch-log { padding-left: 14px; padding-right: 14px; }
  .mmc-ch-dock { padding-left: 10px; padding-right: 10px; }
  .mmc-ch-turn { max-width: 90%; }
  .mmc-ch-modelname { max-width: 18ch; }
}
@media (prefers-reduced-motion: reduce) {
  .mmc-ch-fill { transition: none; }
}
`;
