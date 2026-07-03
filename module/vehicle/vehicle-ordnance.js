/**
 * vehicle-ordnance.js — Phase 5g-2: warhead burst resolution (the stateful wrapper over the pure
 * 5g-1 math). Given a landing point and a warhead, it places the burst, applies the right effect to
 * everything inside, and reuses the existing personnel systems:
 *   HE / HEAT / cluster → Penetration burst through the unified 5c dispatcher (Pen vs Armor / p.8)
 *   White Phosphorus     → no Penetration; sets everything in the burst alight (fire DOT / onFire)
 *   Chemical / smoke      → no Penetration; leaves a lingering gas cloud (the per-turn gas handler)
 *
 * The geometry, deviation and warhead transforms are PURE in vehicle-indirect.js; this file only
 * places documents and calls the proven fire-DOT / gas-cloud machinery.
 */

import { warheadProfile, shellTravelTurns, indirectToHitNumber, indirectToHitBonus, indirectLanding,
         bombDirectPen, diveBombAimBonus, bombFallTurns, bombLanding } from "./vehicle-indirect.js";
import { resolveAreaShot } from "./vehicle-area.js";
import { openSingletonDialog, localize, localizeParam } from "../utils.js";
import { pxPerMeter, metersToUnits, metersPerUnit } from "./vehicle-grid.js";
import { gridDistanceBetween } from "../combat/rangefinding.js";
import { renderChatCard, postSavePromptCard } from "../compat.js";

const SCOPE = "cp2020-augmented";

const _enabled = (key, dflt = true) => { try { return game.settings.get(SCOPE, key); } catch { return dflt; } };

/** Set a single token alight: personnel via the fire DOT, vehicles via the onFire flag. */
async function _ignite(actor, dot = {}) {
  if (!actor) return;
  if (actor.type === "cp2020-augmented.vehicle") {
    try { await actor.update({ "system.onFire": true }); } catch { /* non-fatal */ }
    return;
  }
  if (!_enabled("fireDotEnabled")) return;
  const { applyFireDotState } = await import("../combat/save-rolls.js");
  await applyFireDotState(actor, "Torso", Number(dot.turns) || 10, String(dot.formula || "3d6"));
}

/** Leave a lingering gas/smoke cloud that the existing per-turn gas handler will run saves for. */
async function _placeGasCloud(scene, origin, radiusM, weaponName) {
  if (!_enabled("gasGrenadeCloudEnabled")) return null;
  const td = {
    t: "circle", x: origin.x, y: origin.y, direction: 0, distance: Math.max(0.5, metersToUnits(scene, radiusM)),
    fillColor: "#88ff44", borderColor: "#44aa22",
    flags: { [SCOPE]: {
      isGasCloud: true, turnsLeft: 3, stunSaveMod: 0,
      createdRound: game.combat?.round ?? 0, weaponName: weaponName || "Chemical Shell", vehicleArea: true,
    } },
  };
  try { const [doc] = await scene.createEmbeddedDocuments("MeasuredTemplate", [td]); return doc; }
  catch (err) { console.warn("Cyberpunk2020 | gas cloud placement failed", err); return null; }
}

/**
 * Resolve a warhead landing at `origin` (pixel point on the active scene). Reuses the 5e burst for the
 * Penetration warheads, then applies White-Phosphorus ignition / chemical cloud as needed.
 * @param {object}   p
 * @param {Token}    [p.firerToken]  excluded from its own burst
 * @param {{x,y}}    p.origin        landing point (already deviated by the caller)
 * @param {string}   p.warhead       "heat" | "wp" | "cluster" | "chemical" | "" (plain HE)
 * @param {number}   p.pen           base Penetration
 * @param {number}   p.burstM        base burst radius (metres)
 * @param {object}   [p.payload]     extra dispatch fields (range, goodShotSteps, ap, weaponName, …)
 * @returns {Promise<{struck:Actor[], tokens:number, profile:object}>}
 */
export async function resolveWarheadBurst({ firerToken = null, origin, warhead = "", pen = 0, burstM = 0, payload = {}, scene: sceneArg = null } = {}) {
  const scene = sceneArg ?? canvas?.scene;
  if (!scene || !origin) return { struck: [], tokens: 0, profile: null };
  const profile = warheadProfile(warhead, { pen, burstM });
  const shape = { type: "circle", radiusM: profile.burstM };

  // Penetration warheads (HE / HEAT / cluster): blast everyone through the dispatcher.
  if (profile.pen > 0) {
    const res = await resolveAreaShot({
      firerToken, origin, shape, scene,
      payload: { ...payload, scale: "penetration", penetration: profile.pen, heat: !!profile.heat || !!payload.heat },
    });
    return { ...res, profile };
  }

  // White Phosphorus: find everyone in the burst (no Pen) and set them alight.
  if (profile.dot) {
    const res = await resolveAreaShot({ firerToken, origin, shape, payload, skipDispatch: true, scene });
    for (const tok of res.inside ?? []) await _ignite(tok.actor, profile.dot);
    await postSavePromptCard({
      title: localize("Vehicle.WhitePhosphorusTitle"),
      body: localizeParam("Vehicle.WhitePhosphorusBody", { count: (res.inside ?? []).length, formula: profile.dot.formula }),
    });
    return { struck: (res.inside ?? []).map(t => t.actor), tokens: (res.inside ?? []).length, profile };
  }

  // Chemical / smoke: drop a lingering cloud at the landing point.
  if (profile.gas) {
    await _placeGasCloud(scene, origin, profile.burstM, payload.weaponName);
    await postSavePromptCard({
      title: localize("Vehicle.ChemicalBurstTitle"),
      body: localizeParam("Vehicle.ChemicalBurstBody", { radius: profile.burstM }),
    });
    return { struck: [], tokens: 0, profile };
  }

  // Plain HE with no Pen left (degenerate) — just place the visual.
  const res = await resolveAreaShot({ firerToken, origin, shape, payload, skipDispatch: true, scene });
  return { ...res, profile };
}

/* ------------------------------ Fire dialogs (5g-3 / 5g-4) ------------------------------ */

const _ppm = pxPerMeter;   // unit-aware pixels-per-metre (see vehicle-grid.js)
const _center = (t) => t?.center ?? { x: t?.x, y: t?.y };
const _num = (root, id) => Number(root.querySelector(id)?.value) || 0;
const _chk = (root, id) => !!root.querySelector(id)?.checked;

/** The firing token: the selected token of this vehicle, else any of its tokens. */
function _firerTokenOf(actor) {
  return (canvas?.tokens?.controlled ?? []).find(t => t.actor?.id === actor.id)
      ?? canvas?.tokens?.placeables?.find(t => t.actor?.id === actor.id) ?? null;
}

/** Shell/warhead choices for a weapon: the base HE round plus any authored shellVariants. */
function _shellOptions(w, wName) {
  const base = { name: `${wName} (HE)`, pen: Number(w.penetration) || 0, burst: Number(w.burst) || 0, warhead: w.warhead || (w.heat ? "heat" : ""), ap: !!w.ap };
  const variants = (Array.isArray(w.shellVariants) ? w.shellVariants : []).map(v => ({
    name: v.name || "shell", pen: Number(v.pen) || 0, burst: Number(v.burst) || 0,
    warhead: v.warhead || (v.heat ? "heat" : ""), ap: !!v.ap,
  }));
  return [base, ...variants];
}

/** Shell <select> options as a {value,label} list (label localized; the template builds the <option>s). */
const _shellChoices = (shells) => shells.map((s, i) => ({
  value: i,
  label: localizeParam("Vehicle.ShellOption", {
    name: s.name, pen: s.pen,
    burst: s.burst ? localizeParam("Vehicle.ShellBurstClause", { burst: s.burst }) : "",
    warhead: s.warhead ? localizeParam("Vehicle.ShellWarheadClause", { warhead: s.warhead }) : "",
  }),
}));

/**
 * Indirect / artillery fire (MM p.8). A guided helper: roll the spotter-corrected To-Hit (25, or 10
 * once ranged in), deviate on a miss by missedBy × (range/100) m, and drop the warhead burst at the
 * landing point. Shell travel time is narrated. Aim point = the single targeted token.
 */
export async function openIndirectFireDialog(actor, mount = {}) {
  if (!actor || actor.type !== "cp2020-augmented.vehicle") return null;
  if (!_enabled("vehicleDamageEnabled")) { ui.notifications?.warn?.(localize("Vehicle.DamageDisabled")); return null; }
  const item = mount.itemId ? actor.items.get(mount.itemId) : null;
  const w = item?.system ?? {};
  const wName = item?.name ?? mount.name ?? "artillery";
  const shells = _shellOptions(w, wName);
  const kind = (w.weaponClass === "artillery") ? "artillery" : "mortar";   // 600 vs 400 m/turn

  const targets = [...(game.user?.targets ?? [])];
  const targetTok = targets.length === 1 ? targets[0] : null;
  if (!targetTok) { ui.notifications?.warn?.(localize("Vehicle.IndirectNeedsTarget")); return null; }
  const firerTok = _firerTokenOf(actor);
  const scene = targetTok.document?.parent ?? canvas?.scene;
  const rangeAuto = (firerTok && targetTok)
    ? (() => { try { return Math.round(gridDistanceBetween(firerTok.center, targetTok.center) * metersPerUnit(scene)); } catch { return Number(w.range) || 0; } })()
    : (Number(w.range) || 0);

  const content = await renderChatCard("vehicle/indirect-dialog.hbs", {
    actorName: actor.name, weaponName: wName, targetName: targetTok.name,
    rangeAuto, shells: _shellChoices(shells),
  });

  const dialog = new foundry.applications.api.DialogV2({
    window: { title: localizeParam("Vehicle.IndirectDialogTitle", { actor: actor.name }) },
    content,
    buttons: [
      {
        action: "fire",
        label: localize("Vehicle.FireForEffect"),
        default: true,
        callback: async (ev, btn, dlg) => {
          const root = dlg.element;
          const shell = shells[_num(root, "#cp-if-shell")] ?? shells[0];
          const mods = (_chk(root, "#cp-if-distract") ? -10 : 0) + (_chk(root, "#cp-if-optics") ? 10 : 0)
                     + (_chk(root, "#cp-if-link") ? 5 : 0) + (_chk(root, "#cp-if-dark") ? -3 : 0) + _num(root, "#cp-if-other");
          const bonus = indirectToHitBonus({ spotterHW: _num(root, "#cp-if-shw"), spotterINT: _num(root, "#cp-if-sint"), firerHW: _num(root, "#cp-if-fhw"), mods });
          const tn = indirectToHitNumber({ alreadyRangedIn: _chk(root, "#cp-if-ranged") });
          const rangeM = _num(root, "#cp-if-range");
          const d10 = (await new Roll("1d10").evaluate()).total;
          const dir = (await new Roll("1d10").evaluate()).total;
          const total = d10 + bonus;
          const land = indirectLanding({ aim: _center(targetTok), rangeM, toHitTotal: total, toHitNumber: tn, d10dir: dir, ppm: _ppm(scene) });
          await resolveWarheadBurst({ firerToken: firerTok, origin: land.point, warhead: shell.warhead, pen: shell.pen, burstM: shell.burst, payload: { weaponName: shell.name, ap: shell.ap, range: "normal" }, scene });
          const travel = shellTravelTurns(rangeM, kind);
          const content = await renderChatCard("vehicle/indirect-result.hbs", {
            shellName: shell.name, hit: land.hit, d10, bonus, total, tn,
            dev: Math.round(land.deviationM), missedBy: land.missedBy,
            travel, mps: kind === "artillery" ? "600" : "400",
          });
          await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            flavor: localizeParam("Vehicle.IndirectFlavor", { actor: actor.name, shell: shell.name }),
            content,
          });
        },
      },
      { action: "cancel", label: localize("Cancel") },
    ],
  });
  return openSingletonDialog(`vehicle-indirect:${actor.id}`, () => dialog);
}

/**
 * Bombing (MM p.9). To-Hit 25; dive-bombing adds aim (+1/turn beyond the first, max +3) and the
 * aircraft's speed (faster fall). A direct hit multiplies Penetration ×5; a miss deviates by
 * missedBy × 10 × (height/100) m. Aim point = the single targeted token.
 */
export async function openBombDialog(actor, mount = {}) {
  if (!actor || actor.type !== "cp2020-augmented.vehicle") return null;
  if (!_enabled("vehicleDamageEnabled")) { ui.notifications?.warn?.(localize("Vehicle.DamageDisabled")); return null; }
  const item = mount.itemId ? actor.items.get(mount.itemId) : null;
  const w = item?.system ?? {};
  const wName = item?.name ?? mount.name ?? "bomb";
  const shells = _shellOptions(w, wName);

  const targets = [...(game.user?.targets ?? [])];
  const targetTok = targets.length === 1 ? targets[0] : null;
  if (!targetTok) { ui.notifications?.warn?.(localize("Vehicle.BombNeedsTarget")); return null; }
  const firerTok = _firerTokenOf(actor);
  const scene = targetTok.document?.parent ?? canvas?.scene;

  const content = await renderChatCard("vehicle/bomb-dialog.hbs", {
    actorName: actor.name, weaponName: wName, targetName: targetTok.name,
    shells: _shellChoices(shells),
  });

  const dialog = new foundry.applications.api.DialogV2({
    window: { title: localizeParam("Vehicle.BombDialogTitle", { actor: actor.name }) },
    content,
    buttons: [
      {
        action: "drop",
        label: localize("Vehicle.Drop"),
        default: true,
        callback: async (ev, btn, dlg) => {
          const root = dlg.element;
          const shell = shells[_num(root, "#cp-bm-shell")] ?? shells[0];
          const heightM = _num(root, "#cp-bm-height");
          const diveTurns = _num(root, "#cp-bm-dive");
          const diveSpeed = _num(root, "#cp-bm-speed");
          const aim = diveBombAimBonus(diveTurns);
          const mods = aim + _num(root, "#cp-bm-other");
          const tn = 25;
          const d10 = (await new Roll("1d10").evaluate()).total;
          const dir = (await new Roll("1d10").evaluate()).total;
          const total = d10 + mods;
          const land = bombLanding({ aim: _center(targetTok), heightM, toHitTotal: total, toHitNumber: tn, d10dir: dir, ppm: _ppm(scene) });
          // A direct hit multiplies the warhead's Penetration ×5 (MM p.9). The burst carries that.
          const pen = land.hit ? bombDirectPen(shell.pen) : shell.pen;
          await resolveWarheadBurst({ firerToken: firerTok, origin: land.point, warhead: shell.warhead, pen, burstM: shell.burst, payload: { weaponName: shell.name, ap: shell.ap, range: "normal" }, scene });
          const fall = bombFallTurns(heightM, { diveSpeed: diveTurns > 0 ? diveSpeed : 0 });
          const fallExtra = (diveTurns > 0 && diveSpeed > 175 ? localize("Vehicle.BombFallDive") : "")
                          + (aim ? localizeParam("Vehicle.BombFallAim", { aim }) : "");
          const content = await renderChatCard("vehicle/bomb-result.hbs", {
            shellName: shell.name, hit: land.hit, d10, mods, total, tn, pen,
            dev: Math.round(land.deviationM), missedBy: land.missedBy,
            fall, fallExtra,
          });
          await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            flavor: localizeParam("Vehicle.BombFlavor", { actor: actor.name, shell: shell.name }),
            content,
          });
        },
      },
      { action: "cancel", label: localize("Cancel") },
    ],
  });
  return openSingletonDialog(`vehicle-bomb:${actor.id}`, () => dialog);
}
