'use strict';
/**
 * LAWBOR desktop — win.cjs  (window geometry, PURE — no Electron, so it is testable offline)
 * ===========================================================================================
 * The floating terminal has two states:
 *   EXPANDED  W×H   — the messaging app (two views + composer)
 *   COLLAPSED MINI  — the "organic floating object" living on the desktop; click → back to the app
 *
 * Both transitions re-anchor on the pod's BOTTOM-RIGHT corner so the thing feels pinned in place
 * instead of jumping. Everything then goes through fitOnScreen().
 *
 * Why fitOnScreen exists (learned the hard way on Toshi): the only drag handle is the header. A
 * collapse near the top edge computed a negative Y on expand → header off-screen → window stranded,
 * un-draggable, un-closable. Clamping every computed bound into the work area makes that impossible.
 */

/** Clamp a bounds rect so the whole window stays inside the work area. */
function fitOnScreen(bx, workArea) {
  const wa = workArea || { x: 0, y: 0, width: bx.width, height: bx.height };
  return {
    width: bx.width,
    height: bx.height,
    x: Math.max(wa.x, Math.min(bx.x, wa.x + wa.width - bx.width)),
    y: Math.max(wa.y, Math.min(bx.y, wa.y + wa.height - bx.height)),
  };
}

/** EXPANDED → COLLAPSED, keeping the bottom-right corner where it was. */
function collapsed(b, mini, workArea) {
  return fitOnScreen({ x: b.x + b.width - mini, y: b.y + b.height - mini, width: mini, height: mini }, workArea);
}

/** COLLAPSED → EXPANDED, same corner anchor. */
function expanded(b, w, h, workArea) {
  return fitOnScreen({ x: b.x + b.width - w, y: b.y + b.height - h, width: w, height: h }, workArea);
}

/** First position: bottom-right of the work area, with a gap. */
function firstPosition(w, h, workArea, gap = 20) {
  return fitOnScreen({ x: workArea.x + workArea.width - w - gap, y: workArea.y + workArea.height - h - gap, width: w, height: h }, workArea);
}

module.exports = { fitOnScreen, collapsed, expanded, firstPosition };
