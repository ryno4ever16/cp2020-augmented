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
 * The LEGACY (V1) Application framework raises via `bringToTop()` and tracks windows in `ui.windows` —
 * both stacks share one z-order pool, so the sweep covers BOTH: raised-by-either re-floats pinned
 * windows of either kind. On the ship target (vanilla + module) the base system's Attack Modifiers
 * window is a V1 FormApplication (id "weapon-modifier"), reachable through base fire paths the
 * module's sheets don't own — the V1 side is what keeps it above a clicked V2 actor sheet.
 *
 * A window counts as "pinned" if it is a DialogV2 / core V1 Dialog (covering every confirm either
 * framework spawns, with no per-call wiring), if its class opts in with `static CP_PIN_ON_TOP = true`,
 * or if it is the base system's V1 Attack Modifiers window (matched by its stable id — the module
 * never edits the base class).
 */

/** @param {ApplicationV2} app */
function isPinnedWindow(app) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2 && app instanceof DialogV2) return true;
  return app?.constructor?.CP_PIN_ON_TOP === true;
}

/** Pinned test for LEGACY (V1) Application windows (ui.windows). */
function isPinnedV1Window(app) {
  if (globalThis.Dialog && app instanceof globalThis.Dialog) return true;   // core V1 confirms
  if (app?.constructor?.CP_PIN_ON_TOP === true) return true;
  return app?.options?.id === "weapon-modifier";   // the base system's V1 Attack Modifiers window
}

/** Install the "pinned subwindows float above ordinary windows" behaviour (call once, at init). */
export function registerPinnedSubwindows() {
  const protoV2 = foundry.applications?.api?.ApplicationV2?.prototype;
  const protoV1 = globalThis.Application?.prototype;
  const origV2 = protoV2?.bringToFront;
  const origV1 = protoV1?.bringToTop;

  // Re-float every open pinned window (both frameworks) above the just-raised ordinary one. Always
  // call the ORIGINALS (never the wrappers) so the sweep can never re-enter itself, and guard the
  // whole pass so z-order bookkeeping can never break a window interaction.
  const refloatPinned = (raised) => {
    try {
      if (origV2) {
        for (const app of foundry.applications.instances.values()) {
          if (app !== raised && app.rendered && isPinnedWindow(app)) origV2.apply(app, []);
        }
      }
      if (origV1) {
        for (const app of Object.values(ui.windows ?? {})) {
          if (app !== raised && app.rendered && isPinnedV1Window(app)) origV1.apply(app, []);
        }
      }
    } catch (_) { /* non-fatal */ }
  };

  if (origV2 && !origV2.__cpPinWrapped) {
    function wrappedV2(...args) {
      const result = origV2.apply(this, args);
      if (!isPinnedWindow(this)) refloatPinned(this);
      return result;
    }
    wrappedV2.__cpPinWrapped = true;
    protoV2.bringToFront = wrappedV2;
  }

  if (origV1 && !origV1.__cpPinWrapped) {
    function wrappedV1(...args) {
      const result = origV1.apply(this, args);
      if (!isPinnedV1Window(this)) refloatPinned(this);
      return result;
    }
    wrappedV1.__cpPinWrapped = true;
    protoV1.bringToTop = wrappedV1;
  }
}
