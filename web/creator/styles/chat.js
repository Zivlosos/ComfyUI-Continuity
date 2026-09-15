// The chat room.
//
// The shell is the benches' — the overlay, the sheet, the bar with the wordmark
// in it, the split under it — because a room off the same dashboard should not
// be a second thing to learn. What is here is everything the benches have no
// shape for: a column of speech, a card that is a render happening, a rail that
// holds standing choices rather than dials, and a composer at the foot.
//
// **The rail is on the right, and that is the one place this room disagrees
// with a bench.** On a bench the subject is the glass and the dials are a
// margin beside it; here the subject is what was said, and it is read from the
// left. So the split runs the other way and the rail's border is on its left
// edge instead of its right.
//
// **The transcript is a column, not a chat client.** No avatars, no timestamps,
// no tails on the bubbles. What is said is short and what matters is the render
// under it, so the assistant's line is set flush and quiet and the user's is
// the one that carries a background — the reverse of the convention, and right
// here, because the user's line is the shortest thing on the surface and the
// only one that has to be findable while scrolling back.

export const css = `
/* --- the split ------------------------------------------------------------ */
/* The bench's room, mirrored: the conversation first, the rail after it. */
.mmc-ch-room { flex-direction: row; }
.mmc-ch-talk {
  flex: 1; min-width: 0; min-height: 0;
  display: flex; flex-direction: column;
  /* The column the transcript and the composer share. Capped and centred rather
     than run to the window's width: a line of prose past about seventy
     characters stops being read and starts being scanned, and this room is
     mostly prose. On the pair rather than on either, so they line up. */
  --mmc-ch-column: min(760px, 100%);
}
.mmc-ch-rail {
  flex: none; width: min(calc(300px * var(--mmc-type)), 34vw); min-width: 0;
  border-left: 1px solid var(--mmc-line);
  overflow: auto; overscroll-behavior: contain;
  padding: 18px 16px 20px; display: flex; flex-direction: column; gap: 18px;
}

/* --- the transcript -------------------------------------------------------- */
.mmc-ch-log {
  flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain;
  padding: 24px 22px 8px;
  display: flex; flex-direction: column; gap: 14px;
}
.mmc-ch-msg { width: var(--mmc-ch-column); margin: 0 auto; display: flex; }
.mmc-ch-user { justify-content: flex-end; }
.mmc-ch-user .mmc-ch-said {
  max-width: 80%; padding: 9px 14px; border-radius: 16px;
  background: var(--mmc-surface-2); border: 1px solid var(--mmc-line);
}
.mmc-ch-bot .mmc-ch-said { max-width: 100%; color: var(--mmc-text); }
.mmc-ch-said {
  font-size: calc(13px * var(--mmc-type)); line-height: 1.5;
  white-space: pre-wrap; word-break: break-word;
}
.mmc-ch-bad .mmc-ch-said, .mmc-ch-note.mmc-ch-bad { color: var(--mmc-bad); }
.mmc-ch-thinking { display: flex; align-items: center; gap: 8px; color: var(--mmc-faint); }

/* What an empty room says. The three examples are the shape of a conversation,
   which is more use on the first day than an explanation of one. */
.mmc-ch-empty {
  width: var(--mmc-ch-column); margin: auto; text-align: center;
  color: var(--mmc-faint); font-size: calc(13px * var(--mmc-type));
}
.mmc-ch-empty p { margin: 6px 0; }

/* --- a render, from queued to landed --------------------------------------- */
.mmc-ch-card {
  width: 100%; max-width: 520px;
  border: 1px solid var(--mmc-line); border-radius: 12px;
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
  display: flex; align-items: center; gap: 8px; padding: 9px 12px;
  border-top: 1px solid var(--mmc-line);
}
.mmc-ch-handle {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: calc(11px * var(--mmc-type)); color: var(--mmc-dim);
}
.mmc-ch-door {
  padding: 5px 11px; border-radius: 13px; cursor: pointer; font-family: inherit;
  font-size: calc(11.5px * var(--mmc-type));
  background: var(--mmc-float); color: var(--mmc-text);
  border: 1px solid var(--mmc-line-3);
}
.mmc-ch-door:hover:not(:disabled) { background: var(--mmc-lift); }
.mmc-ch-door:disabled { opacity: .45; cursor: default; }

/* --- the composer ---------------------------------------------------------- */
.mmc-ch-compose {
  flex: none; display: flex; align-items: flex-end; gap: 8px;
  width: var(--mmc-ch-column); margin: 0 auto;
  padding: 10px 22px 18px;
}
.mmc-ch-box {
  flex: 1; min-width: 0; resize: none; font-family: inherit;
  font-size: calc(13px * var(--mmc-type)); line-height: 1.45;
  padding: 10px 12px; border-radius: 12px; max-height: 160px;
  background: var(--mmc-surface-2); color: var(--mmc-text);
  border: 1px solid var(--mmc-line-3); outline: none;
}
.mmc-ch-box:focus { border-color: var(--mmc-accent); }
.mmc-ch-box:disabled { opacity: .55; }
.mmc-ch-clip, .mmc-ch-send {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; border-radius: 17px; cursor: pointer;
  background: var(--mmc-float); color: var(--mmc-text);
  border: 1px solid var(--mmc-line-3);
}
.mmc-ch-send { background: var(--mmc-accent); color: var(--mmc-on-accent); border-color: transparent; }
.mmc-ch-clip:hover { background: var(--mmc-lift); }
.mmc-ch-send:disabled { opacity: .45; cursor: default; }

/* --- the rail's rows -------------------------------------------------------- */
.mmc-ch-group { display: flex; flex-direction: column; gap: 8px; }
.mmc-ch-head {
  font-size: calc(10.5px * var(--mmc-type)); letter-spacing: .06em;
  text-transform: uppercase; color: var(--mmc-faint);
}
.mmc-ch-row { display: flex; align-items: center; gap: 8px; min-height: var(--mmc-pill-h); }
.mmc-ch-label { flex: 1; min-width: 0; font-size: calc(12px * var(--mmc-type)); }
/* The value is the control. Right-aligned and allowed to shrink, because the
   names in it are a family's and some of them are long. */
.mmc-ch-value { max-width: 62%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mmc-ch-hint {
  margin: 0; font-size: calc(10.5px * var(--mmc-type));
  color: var(--mmc-faint); line-height: 1.45;
}

/* --- the ledger, as tiles ---------------------------------------------------- */
.mmc-ch-tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.mmc-ch-tile {
  position: relative; padding: 0; border-radius: 8px; overflow: hidden; cursor: pointer;
  background: var(--mmc-media-bg); border: 1px solid var(--mmc-line); line-height: 0;
  aspect-ratio: 1 / 1;
}
.mmc-ch-tile:hover { border-color: var(--mmc-accent); }
.mmc-ch-tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mmc-ch-sound {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  color: var(--mmc-faint);
}
/* The handle, over the corner of its own picture. It is the thing that gets
   typed, so it has to be readable on whatever the picture happens to be. */
.mmc-ch-tile span {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 3px 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: calc(9.5px * var(--mmc-type)); line-height: 1.3; text-align: left;
  color: #fff; background: var(--mmc-scrim-2);
}

/* --- narrow --------------------------------------------------------------- */
/* The rail goes under the conversation rather than beside it, as the benches'
   does, and the tiles spread out into the width that frees up. */
@media (max-width: 900px) {
  .mmc-ch-room { flex-direction: column; }
  .mmc-ch-rail {
    width: auto; border-left: none; border-top: 1px solid var(--mmc-line);
    max-height: 44vh;
  }
  .mmc-ch-log, .mmc-ch-compose { padding-left: 14px; padding-right: 14px; }
  .mmc-ch-tiles { grid-template-columns: repeat(6, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .mmc-ch-fill { transition: none; }
}
`;
