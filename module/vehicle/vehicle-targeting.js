/**
 * vehicle-targeting.js — Phase 5c: the unified targeting spine.
 *
 * One dispatcher keyed on (source scale × target type) routes every attack to the right resolver:
 *   personnel-dmg → character  : the existing personnel DamageDialog pipeline (handled upstream)
 *   personnel-dmg → vehicle     : Penetration-Factor conversion → vehicle resolver (MM p.4)
 *   Penetration   → vehicle     : Penetration vs Armor Value → vehicle resolver (MM p.6)
 *   Penetration   → character   : Maximum Metal p.8 "Personnel vs Anti-Vehicle Weapons" (NEW)
 *
 * Facing is diegetic: derived from the tokens' geometry + elevation (MM flank rules, p.6), with a
 * manual dropdown override. The math is split into PURE, unit-testable functions; thin wrappers
 * read the tokens / roll the dice / apply to actors.
 */

import { applyAreaDamages, ablateLocationByAmount, personnelArmorValue, ARMOR_MODES } from "../combat/DamageApplicator.js";
import { rollLocation, localize, localizeParam } from "../utils.js";
import { onGlobalClick } from "../popout-compat.js";
import { effectiveVehicleRuleSystem } from "../settings.js";
import { renderChatCard } from "../compat.js";

const SCOPE = "cp2020-augmented";

/* ----------------------------- Diegetic facing (MM p.6) ----------------------------- */

const DEG = 180 / Math.PI;

/**
 * Which facing of the target is struck, from the geometry of the shot. PURE.
 *   dx,dy = vector from the TARGET to the ATTACKER (screen coords; +y is down, as on the canvas).
 *   dz    = attacker elevation − target elevation.
 *   rotationDeg = the target token's rotation (Foundry convention: 0° faces "up"/north, clockwise).
 *
 * Elevation is checked first: a steep shot (|dz| greater than the horizontal distance, i.e. coming
 * from more than 45° above/below) hits the top or bottom. Otherwise the horizontal arc decides:
 * Front within ±45° of the target's facing, Rear beyond ±135°, Side in between.
 * @returns {"front"|"side"|"rear"|"top"|"bottom"}
 */
export function computeFacing({ dx = 0, dy = 0, dz = 0, rotationDeg = 0 } = {}) {
  const horiz = Math.hypot(dx, dy);
  if (Math.abs(dz) > horiz && Math.abs(dz) > 0) return dz > 0 ? "top" : "bottom";
  if (horiz === 0) return "front";
  // Target's facing unit vector (rotation 0 = up = (0,-1), clockwise).
  const r = rotationDeg / DEG;
  const fx = Math.sin(r), fy = -Math.cos(r);
  // Angle between the facing vector and the direction to the attacker.
  const dot = (fx * dx + fy * dy) / horiz;             // |facing| = 1
  const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * DEG;
  // The ±45°/±135° boundaries are front/rear-inclusive per the rule above. Nudge by a tiny
  // epsilon so IEEE-754 rounding (e.g. acos(√½)·180/π = 45.000000000000014) can't push an
  // exact-45° (or exact-135°) bearing into the wrong band.
  const EPS = 1e-9;
  if (angle <= 45 + EPS) return "front";
  if (angle >= 135 - EPS) return "rear";
  return "side";
}

/** Read two tokens and return the struck facing of the target. Falls back to "front". */
export function detectFacingFromTokens(attackerToken, targetToken) {
  if (!attackerToken || !targetToken) return "front";
  const ac = attackerToken.center ?? { x: attackerToken.x, y: attackerToken.y };
  const tc = targetToken.center ?? { x: targetToken.x, y: targetToken.y };
  const aElev = Number(attackerToken.document?.elevation ?? attackerToken.elevation) || 0;
  const tElev = Number(targetToken.document?.elevation ?? targetToken.elevation) || 0;
  return computeFacing({
    dx: ac.x - tc.x, dy: ac.y - tc.y, dz: aElev - tElev,
    rotationDeg: Number(targetToken.document?.rotation ?? targetToken.rotation) || 0
  });
}

/** Resolve a facing for a payload: explicit override wins, else detect from the attacker's token. */
export function resolveFacing(payload, targetActor) {
  if (payload?.facing) return payload.facing;
  const attackerTok = payload?.attackerTokenId ? canvas?.tokens?.get(payload.attackerTokenId) : null;
  const targetTok = payload?.targetTokenId
    ? canvas?.tokens?.get(payload.targetTokenId)
    : (targetActor ? canvas?.tokens?.placeables?.find(t => t.actor?.id === targetActor.id) : null);
  if (attackerTok && targetTok) return detectFacingFromTokens(attackerTok, targetTok);
  return "front";
}

/**
 * Range band for Penetration falloff (MM p.6: −25% at Long, −50% at Extreme; HE/HEAT immune). PURE.
 * Normal ≤ ½ the weapon's range, Long ≤ full range, Extreme beyond.
 */
export function rangeBand(distanceM, weaponRangeM) {
  const r = Number(weaponRangeM) || 0;
  const d = Number(distanceM) || 0;
  if (r <= 0) return "normal";
  if (d <= r * 0.5) return "normal";
  if (d <= r) return "long";
  return "extreme";
}

/**
 * Whether a weapon's mount can bear on a target, given where the target sits relative to the
 * FIRER's facing (front/side/rear/top/bottom from computeFacing on the firer→target vector). PURE.
 * Turret = 360°; fixed/pod = front only; articulated/side = front or side; rear = rear. Top/bottom
 * need high-angle traverse (not modeled) → out of arc. (MM p.11/p.15; warn-but-allow.)
 */
export function mountArcBears(bearing, arc = "turret") {
  if (arc === "turret") return true;
  if (bearing === "top" || bearing === "bottom") return false;
  switch (arc) {
    case "front": return bearing === "front";
    case "rear":  return bearing === "rear";
    case "side":  return bearing === "front" || bearing === "side";
    default:      return true;
  }
}

/** Where the target sits relative to the FIRER's facing (for arc checks). Reads the two tokens. */
export function bearingFromFirer(firerToken, targetToken) {
  // computeFacing on the firer's rotation + the vector from firer to target.
  if (!firerToken || !targetToken) return "front";
  const fc = firerToken.center ?? { x: firerToken.x, y: firerToken.y };
  const tc = targetToken.center ?? { x: targetToken.x, y: targetToken.y };
  const fElev = Number(firerToken.document?.elevation ?? firerToken.elevation) || 0;
  const tElev = Number(targetToken.document?.elevation ?? targetToken.elevation) || 0;
  return computeFacing({
    dx: tc.x - fc.x, dy: tc.y - fc.y, dz: tElev - fElev,
    rotationDeg: Number(firerToken.document?.rotation ?? firerToken.rotation) || 0
  });
}

/* --------------------- MM p.8: Penetration weapon vs a PERSON --------------------- */

/**
 * Resolve a Penetration-rated hit against a personnel target (MM p.8). PURE — pass the rolled
 * LUCK total and the victim's Armor Value.
 *   1. LUCK save 1d10+LUCK ≥ 15  → "grazed": 5D6 to a random location, armor at HALF SP.
 *   2. Fail → Pen − AV:  ≤0 → "stopped": 2D6 impact + strip 10×Pen SP of armor;
 *                        ≥1 → "penetrated": (Pen−AV)×10 damage, armor destroyed.
 */
export function resolvePenVsPerson({ pen = 0, av = 0, luckTotal = 0, luckDC = 15 } = {}) {
  const P = Math.max(0, Number(pen) || 0);
  if ((Number(luckTotal) || 0) >= luckDC) {
    return { outcome: "grazed", damageFormula: "5d6", armorMult: 0.5 };
  }
  const diff = P - (Number(av) || 0);
  if (diff <= 0) {
    return { outcome: "stopped", diff, damageFormula: "2d6", spStripped: 10 * P };
  }
  return { outcome: "penetrated", diff, damage: diff * 10, armorDestroyed: true };
}

/** Post the LUCK-save prompt for a Penetration weapon striking a person (MM p.8 step 2). */
export async function postLuckSavePrompt(targetActor, payload = {}) {
  if (!targetActor) return;
  const pen = Number(payload.penetration ?? payload.pen) || 0;
  const luck = Number(targetActor.system?.stats?.luck?.total) || 0;
  const tok = payload.targetTokenId ? canvas?.tokens?.get(payload.targetTokenId) : null;
  const weaponName = payload.weaponName || localize("Vehicle.AntiVehicleWeapon");

  const content = await renderChatCard("vehicle/luck-save-prompt.hbs", {
    targetName: targetActor.name, weaponName, pen, luck,
    actorId: targetActor.id, tokenId: tok?.id ?? payload.targetTokenId ?? "",
  });
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor: targetActor }) });
}

/** Execute the LUCK save + apply the p.8 result. Called by the chat-button handler. */
async function _executeLuckSave({ actorId, tokenId, pen, weaponName }) {
  const actor = game.actors.get(actorId);
  if (!actor) return;
  // Only the victim's owner or the GM may roll/apply this save — it writes the actor's damage/armor.
  // Mirrors the stun/death-save owner gate (save-rolls.js _assertCanResolveSave); without it a
  // non-owner clicking the button hits a permission error trying to write an actor they don't own.
  if (!(game.user.isGM || actor.isOwner)) {
    ui.notifications?.warn?.(localizeParam("SaveNotOwned", { name: actor.name }));
    return;
  }
  const luck = Number(actor.system?.stats?.luck?.total) || 0;
  const roll = await new Roll("1d10 + @luck", { luck }).evaluate();
  const av = personnelArmorValue(actor);
  const res = resolvePenVsPerson({ pen, av, luckTotal: roll.total });

  const loc = (await rollLocation(actor, null))?.areaHit ?? "Torso";
  let detail = "";

  if (res.outcome === "grazed") {
    const dmg = await new Roll(res.damageFormula).evaluate();
    await applyAreaDamages({
      target: actor, areaDamages: { [loc]: [{ damage: dmg.total }] },
      armorMultSoft: res.armorMult, armorMultHard: res.armorMult
    });
    detail = localizeParam("Vehicle.LuckGrazed", { dmg: dmg.total, loc });
  } else if (res.outcome === "stopped") {
    const dmg = await new Roll(res.damageFormula).evaluate();
    await applyAreaDamages({
      target: actor, areaDamages: { [loc]: [{ damage: dmg.total }] }, armorMode: ARMOR_MODES.NONE
    });
    await ablateLocationByAmount(actor, loc, res.spStripped).catch(() => {});
    detail = localizeParam("Vehicle.LuckStopped", { pen, av, dmg: dmg.total, loc, spStripped: res.spStripped });
  } else {
    await applyAreaDamages({
      target: actor, areaDamages: { [loc]: [{ damage: res.damage }] }, armorMode: ARMOR_MODES.NONE
    });
    await ablateLocationByAmount(actor, loc, 999).catch(() => {});   // armor destroyed at the location
    detail = localizeParam("Vehicle.LuckPenetrated", { pen, av, diff: res.diff, dmg: res.damage, loc });
  }

  const content = await renderChatCard("vehicle/luck-save-result.hbs", {
    actorName: actor.name, luck, d10: roll.dice[0].total, total: roll.total, av, detail,
  });
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: localizeParam("Vehicle.LuckFlavor", { weapon: weaponName }),
    content,
  });

  // An anti-vehicle hit can wound or kill — prompt the appropriate consciousness/death save, exactly
  // like the personnel damage pipeline does after applying damage (no-op if the victim is unhurt).
  try {
    const { postSavePrompts } = await import("../combat/save-rolls.js");
    const tok = tokenId ? canvas?.tokens?.get(tokenId) : null;
    await postSavePrompts(actor, tok ?? null);
  } catch (e) { /* saves are a courtesy prompt — never block damage on them */ }
}

/** Register the LUCK-save chat-button handler (all users; the owner/GM who clicks resolves it). */
export function registerVehicleTargetingHandlers() {
  onGlobalClick(async (ev) => {
    const btn = ev.target.closest?.(".cp-luck-save-roll");
    if (!btn || btn.disabled) return;
    ev.preventDefault();
    btn.disabled = true;
    await _executeLuckSave({
      actorId: btn.dataset.actorId, tokenId: btn.dataset.tokenId,
      pen: Number(btn.dataset.pen) || 0, weaponName: btn.dataset.weapon || "anti-vehicle weapon"
    });
  });

  // GM-side relay: a player firing at a GM-owned vehicle can't write it, so they emit a vehicleDamage
  // request (see _relayVehicleAttack). The socket fires on every connected GM — only the active GM
  // applies (else N GMs apply N×). The active GM re-runs dispatchAttack, which writes directly here.
  game.socket.on(`system.${SCOPE}`, async (data) => {
    if (data?.type !== "vehicleDamage") return;
    if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return;
    const target = game.actors.get(data.targetActorId);
    if (!target) return;
    await dispatchAttack(data.payload ?? {}, target);
  });
}

/* ------------------------------- The 4-way dispatcher ------------------------------- */

/** Can this client write the target's documents (apply vehicle damage directly)? GM or owner. */
function _canModifyTarget(target) {
  return game.user?.isGM || (target?.isOwner ?? false);
}

/**
 * Relay a resolved vehicle attack to the active GM, who applies it. Mirrors the personnel damage
 * relay (damage-hooks `_autoApply` → `_hookSocketRelay`): a player firing at a GM-owned vehicle
 * cannot call `actor.update()` on it, so the attack is sent over the socket and the active GM runs
 * `dispatchAttack` with the same payload. Facing is resolved HERE (the firing client has the tokens)
 * so the GM doesn't re-derive it from a possibly-different active scene. See [[combat-data-hazards]].
 */
function _relayVehicleAttack(payload, target) {
  if (!game.users?.activeGM) { ui.notifications?.warn?.(`No GM is connected to apply damage to ${target?.name ?? "the vehicle"}.`); return; }
  const facing = resolveFacing(payload, target);
  game.socket.emit(`system.${SCOPE}`, {
    type: "vehicleDamage", targetActorId: target.id,
    payload: { ...payload, facing }, requesterId: game.user.id,
  });
  ui.notifications?.info?.(`Vehicle damage sent to the GM (${target?.name ?? "target"}).`);
}

/**
 * Route an attack to the correct resolver by (source scale × target type). Returns true if it
 * handled the attack; false means "this is a normal personnel→personnel hit — let the existing
 * DamageDialog pipeline handle it." `payload.scale` = "penetration" for vehicle/AV weapons.
 */
export async function dispatchAttack(payload, target) {
  if (!target) return false;
  const isPen = payload?.scale === "penetration";

  if (target.type === "cp2020-augmented.vehicle") {
    // Multiplayer: applying vehicle damage writes the vehicle actor. A player firing at a GM-owned
    // vehicle can't write it (permission error → damage silently lost), so relay to the active GM.
    // GMs (and owners of the vehicle) apply directly. The weaponFired hook is gated to the active GM,
    // and a fire dialog runs only on the clicking client, so exactly one client applies → no double.
    if (!_canModifyTarget(target)) { _relayVehicleAttack(payload, target); return true; }
    if (isPen) {
      const VD = await import("./vehicle-damage.js");
      const ruleSystem = effectiveVehicleRuleSystem();
      const facing = resolveFacing(payload, target);
      if (ruleSystem === "MaximumMetal") {
        await VD.applyVehicleDamageMM(target, {
          basePen: Number(payload.penetration) || 0, facing,
          goodShotSteps: Number(payload.goodShotSteps) || 0,
          extraRounds: Number(payload.extraRounds) || 0,
          range: payload.range || "normal",
          hefPenetrator: !!payload.hefPenetrator,  // HEAT/Hi-Ex → Penetration not reduced by range
          heat: !!payload.heat,                    // HEAT (shaped-charge) → halved by Composite Armor
          highDensityAP: !!payload.highDensityAP,  // kinetic, range-immune; NOT halved by Composite/Reactive (errata p.110)
          ap: !!payload.ap,                        // armor-piercing — sets the SP-erosion factor (errata p.107)
          // Real rolled weapon damage when the firer supplies it (ACPA SOP uses it; vehicles ignore it).
          rawDamage: (payload.rawDamage != null) ? Number(payload.rawDamage) : null
        });
      } else {
        await VD.applyVehicleDamageCore(target, { rawDamage: Number(payload.penetration) || 0, ap: !!payload.ap, facing });
      }
    } else {
      const VW = await import("./vehicle-weapons.js");
      await VW.routeWeaponFiredToVehicle(payload, target);
    }
    return true;
  }

  // Character / NPC target.
  if (isPen) {
    await postLuckSavePrompt(target, payload);   // MM p.8
    return true;
  }
  return false;   // personnel damage vs a person → existing pipeline
}
