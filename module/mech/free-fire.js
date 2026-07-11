/**
 * Free Fire (the ammo-tracking opt-out) — the module side of the user's relocate-into-the-Modifiers-window
 * directive.
 *
 * Tilt's vanilla ALREADY tracks ammo (item.js decrements shotsLeft on fire and blocks fire on an
 * empty magazine); what it lacks is the opt-out. The module cannot edit the system's item.js, so
 * Free Fire works from OUTSIDE the consumption path: while it is ON for an actor, every DECREASE of a
 * weapon's shotsLeft is rewritten back to capacity in preUpdateItem — before the write lands — so
 * vanilla's consumption (and its pre-fire block-on-empty) never sees a depleted magazine, and there is
 * no empty-window race (one write, no async follow-up). Toggling Free Fire ON also tops every magazine
 * up front, so an already-empty weapon un-blocks the moment the choice is made.
 *
 * The toggle lives in the Attack Modifiers window: a NATIVE row on the module's own V2 dialog
 * (templates/dialog/modifiers.hbs, wired in dialog/modifiers.js) and an INJECTED row on the base's V1
 * window (templates/dialog/free-fire-row.hbs, injected here). Both READ via ammoTrackingOn() and WRITE
 * via setAmmoTracking() — the single source below — backed by the per-actor flag
 * `cp2020-augmented.ammoTracking` (true/absent = tracking, the vanilla default; false = Free Fire).
 */
import { localize } from "../utils.js";

const SCOPE = "cp2020-augmented";
const FLAG = "ammoTracking";   // true/absent = tracking (vanilla behavior); false = Free Fire

/** Is ammo tracking ON for this actor (the default)? Pure-ish. */
export function ammoTrackingOn(actor) {
  return (actor?.getFlag?.(SCOPE, FLAG) ?? actor?.flags?.[SCOPE]?.[FLAG]) !== false;
}

/**
 * The single writer for the toggle — both dialog rows call this. Sets the per-actor flag and, when
 * turning tracking OFF (Free Fire on), immediately tops every ranged magazine so an already-empty
 * weapon un-blocks at once.
 */
export async function setAmmoTracking(actor, on) {
  if (!actor?.setFlag) return;
  await actor.setFlag(SCOPE, FLAG, on);
  if (!on) await topUpRangedWeapons(actor);   // un-block empty magazines immediately
}

/** The shotsLeft data path for a magazine-bearing item, or null if it carries none. Mirrors the base
 *  item.js weapon/cyberware split (system.shotsLeft vs the nested CyberWorkType.Weapon block). */
function weaponShotsLeftPath(item) {
  if (item?.type === "weapon") return "system.shotsLeft";
  if (item?.type === "cyberware" && item.system?.CyberWorkType?.Weapon) return "system.CyberWorkType.Weapon.shotsLeft";
  return null;
}

/** Top every ranged magazine up to capacity (the moment Free Fire turns on). Covers plain weapons and
 *  Weapon-typed cyberware (nested shotsLeft). The write is tagged so the keep-topped hook skips it. */
export async function topUpRangedWeapons(actor) {
  if (!actor) return;
  const updates = [];
  for (const w of (actor.items ?? [])) {
    const path = weaponShotsLeftPath(w);
    if (!path) continue;
    const sys = w._getWeaponSystem?.() ?? w.system ?? {};
    const cap = Number(sys?.shots) || 0;
    const left = Number(sys?.shotsLeft) || 0;
    const ranged = typeof w.isRanged === "function" ? w.isRanged() : true;
    if (ranged && cap > 0 && left < cap) updates.push({ _id: w.id, [path]: cap });
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { cpFreeFireTopUp: true });
}

/** Hook wiring — called once from the module's init. */
export function registerFreeFire() {
  // The V1 injection: the BASE system's Attack Modifiers window carries no native row, so inject one
  // (ranged fire only — a melee swing consumes nothing). The module's OWN V2 dialog already ships a
  // native .cp-ammo-tracking control (as does the fork's dialog), so any form that already has one is
  // skipped — the native row is wired directly in dialog/modifiers.js. V1 render hooks hand a jQuery root.
  Hooks.on("renderModifiersDialog", async (app, html) => {
    try {
      const actor = app?.object;
      const weapon = app?.options?.weapon;
      if (!actor?.getFlag) return;
      // Skip weapon-less dialogs (the base V1 window also opens for skill rolls) and melee weapons —
      // neither consumes ammo.
      if (!weapon || (typeof weapon.isRanged === "function" && !weapon.isRanged())) return;
      const $ = globalThis.jQuery ?? globalThis.$;
      const $root = html?.find ? html : $(html);
      const form = $root.is("form") ? $root : $root.find("form").first();
      // Skip if we already injected here, OR the form carries a native ammo-tracking control (the V2 /
      // fork dialogs) — otherwise the shared class would give the window two contradictory toggles.
      if (!form.length || form.find(".cp-free-fire-row").length || form.find(".cp-ammo-tracking").length) return;
      const render = foundry?.applications?.handlebars?.renderTemplate ?? renderTemplate;
      const row = await render("modules/cp2020-augmented/templates/dialog/free-fire-row.hbs", {
        tracking: ammoTrackingOn(actor),
      });
      // Sit above the window's confirm controls when present, else at the form's end.
      const $row = $(row);
      const anchor = form.find('button[type="submit"], .form-footer, .dialog-buttons').first();
      if (anchor.length) $row.insertBefore(anchor); else form.append($row);
      // Bind the INJECTED row only (never the whole form), so a shared .cp-ammo-tracking class can never
      // double-bind. The setter writes the flag and tops magazines when turning OFF — single source.
      $row.find(".cp-ammo-tracking").on("change", async (ev) => {
        const on = ev.currentTarget.checked;
        await setAmmoTracking(actor, on);
        $row.find(".cp-ammo-tracking-label").text(localize(on ? "AmmoTracking" : "FreeFire"));
      });
    } catch (e) { console.warn(`${SCOPE} | free-fire row injection failed:`, e); }
  });

  // Keep magazines topped while Free Fire is ON. Any shotsLeft DECREASE (whatever fire path wrote it)
  // is rewritten to capacity in preUpdateItem — before the write lands — so vanilla's consumption and
  // its pre-fire block-on-empty never see a depleted magazine, and there's no async top-up window.
  // Increases (reloads, manual edits upward) and the tracking-ON case pass through untouched. Covers
  // plain weapons and Weapon-typed cyberware (nested shotsLeft). preUpdateItem fires only on the
  // initiating client, so no per-client gate is needed; the top-up's own write is tagged and skipped.
  Hooks.on("preUpdateItem", (item, changes, options) => {
    if (options?.cpFreeFireTopUp) return;
    if (!item?.actor) return;
    const path = weaponShotsLeftPath(item);
    if (!path) return;
    const incoming = foundry.utils.getProperty(changes ?? {}, path);
    if (incoming === undefined) return;
    if (ammoTrackingOn(item.actor)) return;   // tracking ON (vanilla default) → let the write stand
    const sys = item._getWeaponSystem?.() ?? item.system ?? {};
    const cap = Number(sys?.shots) || 0;
    const oldLeft = Number(sys?.shotsLeft) || 0;
    // Snap DECREASES below capacity back to full; increases (reloads) pass through untouched.
    if (cap > 0 && Number(incoming) < oldLeft && Number(incoming) < cap) {
      foundry.utils.setProperty(changes, path, cap);
    }
  });
}
