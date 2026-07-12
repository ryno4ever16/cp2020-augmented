/**
 * R3b — Radiation GM TOOLS: the hands-on controls that make the Deep Space dose subsystem playable.
 *
 * The dose engine (radiation.js) and zones (radiation-zones.js) already own all the mechanics; this file
 * is purely the GM-facing entry points around them:
 *   • openApplyDoseDialog(actors) — a DialogV2 form (rads / source / honor-RSP) that feeds
 *     radiation.js#applyRadiationDose. Opened per-actor from the sheet radiation panel, or against the
 *     selected tokens from the scene-control tool.
 *   • openPlaceZoneDialog()       — a DialogV2 form (radius / rads-formula / source / duration) that
 *     drops a radiation-zones.js#placeRadZone at a selected token, else the centre of the current view.
 *   • openEnvironmentalDialog(actors) — the out-of-combat time tool: cosmic (1D6 millirad/hr) or a solar
 *     flare (Strength × D6 rads/hr) over N hours (Deep Space p.21/23), applied raw (no per-turn RSP —
 *     RSP is the reactor per-turn value; environmental exposure is the Referee's hourly bookkeeping).
 *   • registerRadiationTools()    — adds the three GM tools to the token scene-control group (mirrors the
 *     df-active-lights getSceneControlButtons idiom: augment an existing group's `tools`, don't invent a
 *     canvas layer). Shown to any GM (no feature toggle — the tools are the opt-in). Wired from cp2020-augmented.js.
 *
 * All dialog markup lives in templates/dialog/radiation-*.hbs; every string is a CYBERPUNK.Rad* i18n key;
 * the DialogV2.wait + read-fields-in-the-confirm-callback shape mirrors module/dialog/ip-neglect.js. No
 * HTML/CSS is built in JS. The tools are NOT feature-gated at the action layer (an explicit dose/zone is a
 * deliberate act, like applyRadiationDose/placeRadZone themselves) — only their VISIBILITY follows the
 * toggle, and the passive zone/overlay automation stays gated inside radiation.js/radiation-zones.js.
 */

import { localize } from "../utils.js";
import { applyRadiationDose } from "./radiation.js";
import { placeRadZone } from "./radiation-zones.js";

const SCOPE = "cp2020-augmented";

/** v13/v14-safe template renderer (the module-wide shim). */
function renderTpl(path, data) {
  const render = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  return render(path, data);
}

/** The live world actors behind the currently selected tokens (deduped; prefers the world document over a
 *  token's synthetic copy so the dose lands on and re-prepares the real actor). Empty when nothing selected. */
export function selectedActors() {
  const out = new Map();
  for (const tok of canvas?.tokens?.controlled ?? []) {
    const a = tok.actor ? (game.actors.get(tok.actor.id) ?? tok.actor) : null;
    if (a) out.set(a.id, a);
  }
  return [...out.values()];
}

/* ══════════════════════════════════ Apply dose ══════════════════════════════════ */

/**
 * The GM apply-dose control: prompt for rads + a source label + whether to honor the targets' RSP (a
 * per-turn reactor dose), then apply to every target actor via radiation.js#applyRadiationDose (which owns
 * the RSP subtraction, the effects table, and its own cards). `actors` is resolved by the caller — [the
 * sheet's actor] from the panel, or the selected tokens from the scene tool.
 */
export async function openApplyDoseDialog(actors) {
  const targets = (actors ?? []).filter(Boolean);
  if (!targets.length) { ui.notifications?.warn(localize("RadNoTargets")); return; }

  const content = await renderTpl("modules/cp2020-augmented/templates/dialog/radiation-apply-dose.hbs", {
    names: targets.map((a) => a.name).join(", "),
    multiple: targets.length > 1,
  });

  await foundry.applications.api.DialogV2.wait({
    window: { title: localize("RadApplyDoseTitle"), icon: "fa-solid fa-radiation" },
    content,
    rejectClose: false,
    buttons: [
      {
        action: "apply", default: true, icon: "fa-solid fa-radiation", label: localize("RadApplyDoseBtn"),
        callback: async (ev, btn, dialog) => {
          const root = dialog?.element;
          const rads     = Number(root?.querySelector?.(".cp-rad-rads")?.value) || 0;
          const source   = String(root?.querySelector?.(".cp-rad-source")?.value ?? "").trim();
          const perTurn  = !!root?.querySelector?.(".cp-rad-perturn")?.checked;
          if (rads <= 0) { ui.notifications?.warn(localize("RadDoseNonPositive")); return; }
          for (const actor of targets) {
            await applyRadiationDose(actor, rads, { perTurn, sourceLabel: source, announce: true });
          }
        },
      },
      { action: "cancel", icon: "fa-solid fa-xmark", label: localize("Cancel") },
    ],
  });
}

/* ══════════════════════════════════ Place zone ══════════════════════════════════ */

/** Placement origin in PIXELS: the centre of the single selected token, else the centre of the current
 *  canvas view (stage pivot). Null when there is no canvas. */
function zoneOrigin() {
  if (!canvas?.ready) return null;
  const controlled = canvas.tokens?.controlled ?? [];
  if (controlled.length === 1 && controlled[0]?.center) {
    return { x: controlled[0].center.x, y: controlled[0].center.y };
  }
  const pivot = canvas.stage?.pivot;
  if (pivot) return { x: pivot.x, y: pivot.y };
  return null;
}

/**
 * The GM place-zone control: prompt for radius / per-turn rads formula / source / duration, then drop a
 * radiation zone (radiation-zones.js#placeRadZone) at the selected token or the view centre. A finite
 * duration self-removes; 0 = persistent (a reactor breach / standing field).
 */
export async function openPlaceZoneDialog() {
  const origin = zoneOrigin();
  if (!origin) { ui.notifications?.warn(localize("RadNoCanvas")); return; }

  const content = await renderTpl("modules/cp2020-augmented/templates/dialog/radiation-place-zone.hbs", {
    atToken: (canvas.tokens?.controlled ?? []).length === 1,
  });

  await foundry.applications.api.DialogV2.wait({
    window: { title: localize("RadPlaceZoneTitle"), icon: "fa-solid fa-radiation" },
    content,
    rejectClose: false,
    buttons: [
      {
        action: "place", default: true, icon: "fa-solid fa-radiation", label: localize("RadPlaceZoneBtn"),
        callback: async (ev, btn, dialog) => {
          const root = dialog?.element;
          const radiusM     = Number(root?.querySelector?.(".cp-rad-radius")?.value) || 3;
          const radsFormula = String(root?.querySelector?.(".cp-rad-formula")?.value ?? "").trim() || "1d10";
          const sourceLabel = String(root?.querySelector?.(".cp-rad-source")?.value ?? "").trim();
          const turnsLeft   = Number(root?.querySelector?.(".cp-rad-turns")?.value) || 0;
          await placeRadZone({ x: origin.x, y: origin.y, radiusM, radsFormula, sourceLabel, turnsLeft });
        },
      },
      { action: "cancel", icon: "fa-solid fa-xmark", label: localize("Cancel") },
    ],
  });
}

/* ══════════════════════════════════ Environmental (cosmic / flare) ══════════════════════════════════ */

/** Cosmic-ray rads over `hours` (Deep Space p.21: 1D6 millirads/hr, per character). Up to 100 hours are
 *  rolled directly; a longer span scales the sampled rate (a GM bookkeeping estimate, not a thousand-dice
 *  roll). Impure (dice). Returns rads (millirads ÷ 1000). */
async function rollCosmicRads(hours) {
  const h = Math.max(0, Math.floor(Number(hours) || 0));
  if (!h) return 0;
  const nDice = Math.min(h, 100);
  const roll = await new Roll(`${nDice}d6`).evaluate();
  const sampled = Number(roll.total) || 0;                     // millirads over nDice hours
  const millirads = h <= 100 ? sampled : sampled * (h / nDice);
  return millirads / 1000;
}

/** Solar-flare rads over `hours` at a given Strength (Deep Space p.23: Strength × D6 rads/hr, per
 *  character). Same up-to-100-dice sample-and-scale as cosmic. Impure (dice). */
async function rollFlareRads(hours, strength) {
  const h = Math.max(0, Math.floor(Number(hours) || 0));
  const s = Math.max(1, Math.floor(Number(strength) || 1));
  if (!h) return 0;
  const totalDice = h * s;
  const nDice = Math.min(totalDice, 100);
  const roll = await new Roll(`${nDice}d6`).evaluate();
  const sampled = Number(roll.total) || 0;                     // rads over nDice die-hours
  return totalDice <= 100 ? sampled : sampled * (totalDice / nDice);
}

/**
 * Apply an out-of-combat environmental dose to each target actor: cosmic rays or a solar flare over N
 * hours. Rolled PER actor (the book has each character roll their own exposure). Applied RAW (perTurn
 * false) — RSP is the reactor per-turn value, not the hourly environmental model; a suit's shielding is
 * the Referee's call via the entered Strength/hours. Exported for a one-line macro / the keeper.
 */
export async function applyEnvironmentalRadiation(actors, { mode = "cosmic", hours = 1, flareStrength = 1 } = {}) {
  const targets = (actors ?? []).filter(Boolean);
  for (const actor of targets) {
    const rads = mode === "flare"
      ? await rollFlareRads(hours, flareStrength)
      : await rollCosmicRads(hours);
    if (rads <= 0) continue;
    const sourceLabel = localize(mode === "flare" ? "RadSourceFlare" : "RadSourceCosmic");
    await applyRadiationDose(actor, rads, { perTurn: false, sourceLabel, announce: true });
  }
}

/**
 * The GM environmental-radiation control: choose cosmic vs flare, the hours elapsed, and (for a flare) its
 * Strength, then apply to the selected tokens. Time-based, not the combat tick.
 */
export async function openEnvironmentalDialog(actors) {
  const targets = (actors ?? []).filter(Boolean);
  if (!targets.length) { ui.notifications?.warn(localize("RadNoTargets")); return; }

  const content = await renderTpl("modules/cp2020-augmented/templates/dialog/radiation-environmental.hbs", {
    names: targets.map((a) => a.name).join(", "),
    multiple: targets.length > 1,
  });

  await foundry.applications.api.DialogV2.wait({
    window: { title: localize("RadEnvTitle"), icon: "fa-solid fa-sun" },
    content,
    rejectClose: false,
    buttons: [
      {
        action: "apply", default: true, icon: "fa-solid fa-sun", label: localize("RadEnvBtn"),
        callback: async (ev, btn, dialog) => {
          const root = dialog?.element;
          const mode          = String(root?.querySelector?.(".cp-rad-mode")?.value ?? "cosmic");
          const hours         = Number(root?.querySelector?.(".cp-rad-hours")?.value) || 0;
          const flareStrength = Number(root?.querySelector?.(".cp-rad-strength")?.value) || 1;
          if (hours <= 0) { ui.notifications?.warn(localize("RadHoursNonPositive")); return; }
          await applyEnvironmentalRadiation(targets, { mode, hours, flareStrength });
        },
      },
      { action: "cancel", icon: "fa-solid fa-xmark", label: localize("Cancel") },
    ],
  });
}

/* ══════════════════════════════════ Scene-control tools ══════════════════════════════════ */

/**
 * Add the three radiation GM tools to the token scene-control group (pure of the hook — exported for the
 * keeper). Mirrors the df-active-lights idiom: augment an EXISTING group's `tools` (v13 `controls` is a
 * Record<string, SceneControl>; each tool is a momentary `button` firing `onChange`) rather than
 * registering a bespoke canvas layer. Added for any GM (the tools ARE the opt-in; radiation stays inert
 * until one is used). Returns true when the tools were added (for the keeper's negative case).
 */
export function addRadiationTools(controls) {
  if (!game.user?.isGM) return false;
  const tokens = controls?.tokens;
  if (!tokens?.tools) return false;
  const order = Object.keys(tokens.tools).length;

  tokens.tools["cp-rad-zone"] = {
    name: "cp-rad-zone", title: "CYBERPUNK.RadToolPlaceZone", icon: "fa-solid fa-radiation",
    button: true, order: order + 1,
    onChange: () => openPlaceZoneDialog(),
  };
  tokens.tools["cp-rad-dose"] = {
    name: "cp-rad-dose", title: "CYBERPUNK.RadToolApplyDose", icon: "fa-solid fa-person-rays",
    button: true, order: order + 2,
    onChange: () => openApplyDoseDialog(selectedActors()),
  };
  tokens.tools["cp-rad-env"] = {
    name: "cp-rad-env", title: "CYBERPUNK.RadToolEnvironmental", icon: "fa-solid fa-sun",
    button: true, order: order + 3,
    onChange: () => openEnvironmentalDialog(selectedActors()),
  };
  return true;
}

/**
 * Install the radiation GM scene-control tools (the getSceneControlButtons hook). Wrapped defensively so a
 * control-API shift never breaks the scene controls. Wired once from cp2020-augmented.js.
 */
export function registerRadiationTools() {
  Hooks.on("getSceneControlButtons", (controls) => {
    try { addRadiationTools(controls); } catch (e) { console.warn(`${SCOPE} | radiation scene tools failed`, e); }
  });
}
