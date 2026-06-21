/**
 * Pinned subwindows — keep a spawned child window (a confirm dialog, the Attack Modifiers window)
 * floating ABOVE the ordinary window it was opened from, so clicking or force-rendering the parent
 * never buries the child behind it. Vendored from the base system (module/pin-window.js); same logic.
 *
 * ApplicationV2 assigns window stacking order through `bringToFront()`: clicking a window and a forced
 * render both call it. We wrap it ONCE so that whenever an ORDINARY (non-pinned) window is raised, every
 * open pinned window is re-raised above it. Among themselves, pinned windows keep normal click order;
 * the wrap only intervenes when a non-pinned window would otherwise cover them.
 *
 * A window counts as "pinned" if it is a DialogV2 — covering every DialogV2.confirm/prompt/wait the
 * module spawns (the IP level-up/neglect and shop buy/install/request confirms) with no per-call wiring
 * — or if its class opts in with `static CP_PIN_ON_TOP = true` (e.g. the system's Attack Modifiers
 * window when the module runs alongside the base system).
 */

/** @param {ApplicationV2} app */
function isPinnedWindow(app) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2 && app instanceof DialogV2) return true;
  return app?.constructor?.CP_PIN_ON_TOP === true;
}

/** Install the "pinned subwindows float above ordinary windows" behaviour (call once, at init). */
export function registerPinnedSubwindows() {
  const proto = foundry.applications?.api?.ApplicationV2?.prototype;
  if (!proto?.bringToFront || proto.bringToFront.__cpPinWrapped) return;
  const orig = proto.bringToFront;
  function wrapped(...args) {
    const result = orig.apply(this, args);
    // When an ordinary window is brought forward, re-float every open pinned window above it. Call the
    // ORIGINAL bringToFront on each child (never the wrapper) so this never re-enters itself, and guard
    // the whole sweep so z-order bookkeeping can never break a window interaction.
    if (!isPinnedWindow(this)) {
      try {
        for (const app of foundry.applications.instances.values()) {
          if (app !== this && app.rendered && isPinnedWindow(app)) orig.apply(app, []);
        }
      } catch (_) { /* non-fatal */ }
    }
    return result;
  }
  wrapped.__cpPinWrapped = true;
  proto.bringToFront = wrapped;
}
