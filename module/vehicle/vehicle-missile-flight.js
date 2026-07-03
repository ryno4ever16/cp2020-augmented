/**
 * vehicle-missile-flight.js — Phase 5f-2: stateful multi-turn missile flight.
 *
 * A guided missile is a hidden, scalable Token (a reusable "Missile" proxy actor) carrying its
 * flight state in flags. Each combat round it advances toward its target (auto-advance); on the
 * impact round it rolls its guidance to-hit and, on a hit, resolves through the unified dispatcher.
 * A "Missiles in Flight" list is injected into the Combat Tracker. Detection-gated reveal and the
 * Incoming-Missile reaction card (countermeasures / evade / intercept) arrive in 5f-3.
 */

import { mmEnabled } from "../settings.js";
import { missileSpeed, turnsToImpact, resolveMissileToHit, resolvePaintHit, countermeasureModifier, interceptResult, electronicDetect, visualDetectDV } from "./vehicle-missiles.js";
import { onGlobalClick } from "../popout-compat.js";
import { pixelsToMeters } from "./vehicle-grid.js";
import { localize, localizeParam } from "../utils.js";
import { renderChatCard, postSavePromptCard } from "../compat.js";

const SCOPE = "cp2020-augmented";
const MISSILE_IMG = "modules/cp2020-augmented/img/missile.webp";
// ⚠ PLACEHOLDER ART: missile.webp points diagonally on a solid background. This offset rotates the
// sprite so the nose roughly faces its heading; tune it in-engine. MUST be replaced before release
// with a north-pointing, transparent sprite (then set this to 0). See vehicle-combat-design memory.
const MISSILE_ART_OFFSET = 135;

/** Reusable hidden proxy actor that hosts all missile tokens (avoids per-missile actor clutter). */
async function _ensureMissileActor() {
  let a = game.actors?.find(x => x.getFlag?.(SCOPE, "missileProxy"));
  if (!a) a = await Actor.create({ name: "Missile", type: "npc", img: MISSILE_IMG, flags: { [SCOPE]: { missileProxy: true } } });
  return a;
}

const _gridSize = (scene) => Number(scene?.grid?.size) || 100;
/** Centre of a TokenDocument in pixels (document fields only — no reliance on a rendered placeable). */
function _docCenter(doc, gs) { return { x: doc.x + (doc.width * gs) / 2, y: doc.y + (doc.height * gs) / 2 }; }
const _headingDeg = (from, to) => Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI;

/**
 * Launch a guided missile toward a target token. Spawns a hidden missile token at the shooter,
 * stores the flight + to-hit state, and computes turns-to-impact from distance ÷ missile speed.
 * @returns {Promise<TokenDocument|null>}
 */
export async function launchMissile({ scene: sceneArg, shooterToken, targetToken, missile = {} } = {}) {
  if (!mmEnabled()) { ui.notifications?.warn?.(localize("Vehicle.MMDisabledMissile")); return null; }
  const scene = sceneArg ?? canvas?.scene;
  if (!scene || !shooterToken || !targetToken) { ui.notifications?.warn?.(localize("Vehicle.MissileNeedsTokens")); return null; }
  const sDoc = shooterToken.document ?? shooterToken;
  const tDoc = targetToken.document ?? targetToken;

  // Creating the proxy actor + the missile token requires the GM. If we're not the active GM (a
  // player, or a non-active GM), relay the launch by ids; the active GM spawns the missile. Mirrors
  // the vehicle-damage relay (_relayVehicleAttack). Without this a player's guided missile spawned
  // nothing. The GM-side handler is in registerMissileFlightHooks.
  if (game.users?.activeGM?.id !== game.user.id) {
    if (!game.users?.activeGM) { ui.notifications?.warn?.(localize("Vehicle.NoGMForMissile")); return null; }
    game.socket.emit("module.cp2020-augmented", {
      type: "missileLaunch", sceneId: scene.id,
      shooterTokenId: sDoc.id, targetTokenId: tDoc.id, missile,
    });
    ui.notifications?.info?.(localize("Vehicle.MissileLaunchSentToGM"));
    return null;
  }

  const gs = _gridSize(scene);
  const proxy = await _ensureMissileActor();

  const sc = _docCenter(sDoc, gs), tc = _docCenter(tDoc, gs);
  const distM = pixelsToMeters(scene, Math.hypot(tc.x - sc.x, tc.y - sc.y));
  const speed = missileSpeed(missile.guidance, missile.speed);
  const tti = turnsToImpact(distM, speed);

  const flight = {
    shooterTokenId: sDoc.id, shooterActorId: sDoc.actorId ?? null,
    targetTokenId: tDoc.id, targetActorId: tDoc.actorId ?? null,
    guidance: missile.guidance ?? "semiActive", homingMethod: missile.homingMethod ?? "radar",
    penetration: Number(missile.penetration) || 0, ap: !!missile.ap, heat: !!missile.heat, hefPenetrator: !!missile.hefPenetrator,
    weaponName: missile.weaponName ?? "missile",
    operatorBonus: Number(missile.operatorBonus) || 0, missileSkill: Number(missile.missileSkill) || 0,
    targetNumber: Number(missile.targetNumber) || 0,
    speed, turnsToImpact: tti, totalTurns: tti, detected: false,
    difficultyMods: 0, intercepted: null, reactions: [], launchRound: game.combat?.round ?? 0,
    // Was it launched during an active encounter? If not, the first combat round ADOPTS it (re-baselines
    // its flight) instead of resolving it on the spot — so an out-of-combat missile carries into combat.
    combatAdopted: !!game.combat?.started,
  };

  const [tok] = await scene.createEmbeddedDocuments("Token", [{
    name: flight.weaponName, actorId: proxy.id, actorLink: false,
    x: sc.x - gs * 0.25, y: sc.y - gs * 0.25, width: 0.5, height: 0.5,
    texture: { src: MISSILE_IMG }, rotation: _headingDeg(sc, tc) + MISSILE_ART_OFFSET,
    hidden: true, disposition: -1,
    flags: { [SCOPE]: { missile: flight } },
  }]);

  // A missile only flies on combat-round changes; out of combat it needs the manual ▶ control.
  const inCombat = !!game.combat?.started;
  const content = await renderChatCard("vehicle/missile-launched.hbs", {
    weapon: flight.weaponName,
    firer: sDoc.name ?? localize("Vehicle.Firer"),
    target: tDoc.name ?? localize("Vehicle.Target"),
    turns: tti, guidance: flight.guidance, inCombat,
  });
  await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: shooterToken.actor ?? undefined }), content });
  if (!inCombat) ui.notifications?.info?.(localize("Vehicle.MissileLaunchedNotice"));
  await _tryDetect(tok, scene);   // can the target spot it now? (sensors auto / Notice-Awareness)
  ui.combat?.render();
  return tok;
}

/** Advance ONE in-flight missile a single step: move toward its target, or resolve on impact.
 *  When `round` is a combat round number, a not-yet-adopted (out-of-combat) missile is ADOPTED into
 *  the encounter — re-baselined to this round and held for one round — rather than advanced/resolved. */
async function _stepMissile(mt, scene, gs, round = null) {
  const f = mt?.flags?.[SCOPE]?.missile;
  if (!f) return;
  if (round !== null && f.combatAdopted === false) {
    await mt.update({ [`flags.${SCOPE}.missile.combatAdopted`]: true, [`flags.${SCOPE}.missile.launchRound`]: round });
    return;   // give it its full remaining flight inside the encounter; don't consume a turn now
  }
  const targetDoc = scene.tokens.get(f.targetTokenId);
  if (!targetDoc) { await mt.delete().catch(() => {}); return; }   // target gone → missile lost
  if (!f.detected) await _tryDetect(mt, scene);    // retry detection while inbound
  const tti = Number(f.turnsToImpact) || 1;
  const tc = _docCenter(targetDoc, gs);
  if (tti <= 1) {
    await _resolveMissileImpact(f, targetDoc, scene, gs);
    await mt.delete().catch(() => {});
  } else {
    const cur = { x: mt.x + (mt.width * gs) / 2, y: mt.y + (mt.height * gs) / 2 };
    const nx = mt.x + (tc.x - cur.x) / tti, ny = mt.y + (tc.y - cur.y) / tti;
    await mt.update({ x: nx, y: ny, rotation: _headingDeg(cur, tc) + MISSILE_ART_OFFSET, [`flags.${SCOPE}.missile.turnsToImpact`]: tti - 1 });
  }
}

/** Advance every in-flight missile one combat round; resolve those reaching impact. (Active GM.)
 *  Pass the current combat `round` so missiles launched outside combat are adopted, not resolved. */
export async function advanceMissiles(scene = canvas?.scene, round = null) {
  if (!scene) return;
  const gs = _gridSize(scene);
  const missiles = scene.tokens.filter(t => t.flags?.[SCOPE]?.missile);
  for (const mt of missiles) await _stepMissile(mt, scene, gs, round);
  ui.combat?.render();
}

/** Advance a SINGLE missile one step by token id — the manual control for out-of-combat play. */
export async function advanceOneMissile(scene, tokenId) {
  const sc = scene ?? canvas?.scene;
  const mt = sc?.tokens?.get(tokenId);
  if (!sc || !mt) return;
  await _stepMissile(mt, sc, _gridSize(sc));
  ui.combat?.render();
}

async function _resolveMissileImpact(f, targetDoc, scene, gs) {
  const target = targetDoc.actor;
  const d10 = (await new Roll("1d10").evaluate()).total;
  const dm = Number(f.difficultyMods) || 0;   // accumulated countermeasure / evade +Difficulty
  const hit = f.guidance === "paint"
    ? resolvePaintHit(d10)
    : resolveMissileToHit({ guidance: f.guidance, d10, operatorBonus: f.operatorBonus, missileSkill: f.missileSkill, targetNumber: f.targetNumber, difficultyMods: dm }).hit;

  if (!hit || !target) {
    await postSavePromptCard({
      title: localizeParam("Vehicle.MissileMissTitle", { weapon: f.weaponName }),
      body: localizeParam("Vehicle.MissileMissBody", {
        target: targetDoc.name ?? localize("Vehicle.Target"),
        cm: dm ? localizeParam("Vehicle.MissileCmClause", { mod: dm }) : "",
      }),
    });
    return;
  }
  // An AGAMS/AEAMS that detonated the missile in its burst range halves damage & Penetration.
  const burst = f.intercepted === "burst";
  const pen = burst ? Math.ceil((Number(f.penetration) || 0) / 2) : (Number(f.penetration) || 0);
  const { dispatchAttack, detectFacingFromTokens } = await import("./vehicle-targeting.js");
  const shooterDoc = scene.tokens.get(f.shooterTokenId);
  const facing = (shooterDoc?.object && targetDoc.object) ? detectFacingFromTokens(shooterDoc.object, targetDoc.object) : "front";
  await dispatchAttack({
    scale: "penetration", penetration: pen, ap: f.ap, heat: f.heat, hefPenetrator: f.hefPenetrator,
    weaponName: f.weaponName + (burst ? " (intercepted, ½)" : ""), facing, targetTokenId: targetDoc.id,
  }, target);
}

/**
 * Attempt to detect an inbound missile for its target (MM p.10). Sensors auto-detect (90%); else a
 * Notice/Awareness test (Awareness + Combat Sense + 1d10 vs DV 20). On success reveal the token and
 * post the reaction card. Detection is PERCEPTION (auto); the reactions on the card are deliberate.
 */
async function _tryDetect(mt, scene) {
  const f = mt.flags?.[SCOPE]?.missile;
  if (!f || f.detected) return false;
  const targetDoc = scene.tokens.get(f.targetTokenId);
  const target = targetDoc?.actor;
  if (!target) return false;
  let detected = false, how = "";
  if (target.system?.sensors) {
    detected = electronicDetect((await new Roll("1d10").evaluate()).total);
    how = detected ? localize("Vehicle.DetectedSensors") : "";
  } else {
    const aware = Number(target.getSkillVal?.("Awareness") ?? 0) || 0;
    const cs = Number(target.getSkillVal?.("Combat Sense") ?? target.getSkillVal?.("CombatSense") ?? 0) || 0;
    const roll = (await new Roll("1d10").evaluate()).total;
    detected = (roll + aware + cs) >= visualDetectDV("inFlight");
    how = detected ? localizeParam("Vehicle.DetectedVisual", { aware, cs, roll }) : "";
  }
  if (!detected) return false;
  await mt.update({ hidden: false, [`flags.${SCOPE}.missile.detected`]: true });
  await _postIncomingCard(mt, f, targetDoc, how);
  return true;
}

/** The best +Difficulty an available countermeasure imposes on the missile's homing method. */
function _bestCountermeasure(cms = [], method = "radar") {
  let cm = null, mod = 0;
  for (const c of (cms ?? [])) { const m = countermeasureModifier([c], method); if (m > mod) { mod = m; cm = c; } }
  return { cm, mod };
}

/** Consolidated "Incoming Missile" card — the defender's deliberate reactions (whispered to owner+GM). */
async function _postIncomingCard(mt, f, targetDoc, how = "") {
  const target = targetDoc?.actor;
  const sceneId = targetDoc?.parent?.id ?? canvas?.scene?.id ?? "";
  const best = _bestCountermeasure(target?.system?.countermeasures ?? [], f.homingMethod);
  const hasAM = !!target?.system?.antiMissile;
  const whisper = target ? game.users.filter(u => u.isGM || target.testUserPermission(u, "OWNER")).map(u => u.id) : undefined;
  const content = await renderChatCard("vehicle/incoming-missile.hbs", {
    target: targetDoc?.name ?? localize("Vehicle.Target"),
    weapon: f.weaponName, guidance: f.guidance, homing: f.homingMethod, turns: f.turnsToImpact,
    how,
    cmLabel: best.cm ? localizeParam("Vehicle.MissileDeployCm", { cm: best.cm, mod: best.mod }) : "",
    hasAM, tokenId: mt.id, sceneId,
  });
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: target ?? undefined }),
    whisper,
    content,
  });
}

/** Apply a deliberate reaction to an in-flight missile. (Applied by the active GM, who owns the token.) */
async function _applyMissileReaction(tokenId, kind, sceneArg = null) {
  const scene = sceneArg ?? canvas?.scene ?? game.scenes?.find(s => s.tokens.get(tokenId));
  const mt = scene?.tokens?.get(tokenId);
  const f = mt?.flags?.[SCOPE]?.missile;
  if (!mt || !f) return;
  const target = scene.tokens.get(f.targetTokenId)?.actor;

  if (kind === "intercept") {
    const res = interceptResult((await new Roll("1d10").evaluate()).total, 0);
    if (res.outcome === "destroyed") {
      await postSavePromptCard({ title: localizeParam("Vehicle.AntiMissileDestroyedTitle", { weapon: f.weaponName }) });
      await mt.delete().catch(() => {});
    } else if (res.outcome === "burst") {
      await mt.update({ [`flags.${SCOPE}.missile.intercepted`]: "burst" });
      await postSavePromptCard({
        title: localize("Vehicle.AntiMissileBurstTitle"),
        body: localizeParam("Vehicle.AntiMissileBurstBody", { weapon: f.weaponName }),
      });
    } else {
      await postSavePromptCard({
        title: localize("Vehicle.AntiMissileMissedTitle"),
        body: localizeParam("Vehicle.AntiMissileMissedBody", { weapon: f.weaponName }),
      });
    }
    return;
  }

  let add = 0, label = "";
  if (kind === "evade") { add = 2; label = localize("Vehicle.EvasiveManeuver"); }
  else {
    const best = _bestCountermeasure(target?.system?.countermeasures ?? [], f.homingMethod);
    if (!best.cm) { ui.notifications?.warn?.(localize("Vehicle.NoCmDefeats")); return; }
    add = best.mod; label = localizeParam("Vehicle.CmLabel", { cm: best.cm, mod: best.mod });
  }
  const cur = Number(f.difficultyMods) || 0;
  await mt.update({ [`flags.${SCOPE}.missile.difficultyMods`]: cur + add });
  await postSavePromptCard({
    title: localizeParam("Vehicle.CountermeasureTitle", { label }),
    body: localizeParam("Vehicle.CountermeasureBody", { weapon: f.weaponName, mod: cur + add }),
  });
}

/**
 * A defender's missile reaction: the GM applies it directly; a player (who owns the targeted vehicle
 * and saw the whispered card) relays it to the active GM, who owns the missile token. Mirrors the
 * combat socket relay — see [[combat-data-hazards]].
 */
async function _reactOrRelay(tokenId, kind) {
  if (game.user?.isGM) { await _applyMissileReaction(tokenId, kind); return; }
  game.socket.emit("module.cp2020-augmented", { type: "missileReaction", tokenId, kind, sceneId: canvas?.scene?.id, requesterId: game.user.id });
  ui.notifications?.info?.(localize("Vehicle.ReactionSent"));
}

/** Auto-advance missiles each combat round (active GM only) + inject the Missiles-in-Flight panel. */
export function registerMissileFlightHooks() {
  // Player → GM relay for deliberate missile reactions (only the active GM applies; verify the
  // requester actually owns the targeted vehicle so a stray socket can't trigger a reaction).
  game.socket.on("module.cp2020-augmented", async (data) => {
    if (data?.type !== "missileReaction") return;
    if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return;
    const scene = (data.sceneId ? game.scenes.get(data.sceneId) : null) ?? canvas?.scene ?? game.scenes?.find(s => s.tokens.get(data.tokenId));
    const f = scene?.tokens?.get(data.tokenId)?.flags?.[SCOPE]?.missile;
    const target = f ? scene.tokens.get(f.targetTokenId)?.actor : null;
    const requester = game.users?.get(data.requesterId);
    if (target && requester && !target.testUserPermission(requester, "OWNER")) return;   // not their missile
    await _applyMissileReaction(data.tokenId, data.kind, scene);
  });

  // Player → GM relay for a guided-missile launch: the active GM spawns the missile token on the
  // firer's behalf (Actor/Token.create are GM-only). Emitted by launchMissile when a non-GM fires.
  game.socket.on("module.cp2020-augmented", async (data) => {
    if (data?.type !== "missileLaunch") return;
    if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return;
    const scene = (data.sceneId ? game.scenes.get(data.sceneId) : null) ?? canvas?.scene;
    const shooterToken = scene?.tokens?.get(data.shooterTokenId);
    const targetToken  = scene?.tokens?.get(data.targetTokenId);
    if (scene && shooterToken && targetToken) await launchMissile({ scene, shooterToken, targetToken, missile: data.missile ?? {} });
  });

  // Reaction buttons on the Incoming-Missile card (+ GM reveal from the tracker panel).
  onGlobalClick(async (ev) => {
    const cm = ev.target.closest?.(".cp-missile-cm");
    const ev2 = ev.target.closest?.(".cp-missile-evade");
    const ic = ev.target.closest?.(".cp-missile-intercept");
    const rv = ev.target.closest?.(".cp-missile-reveal");
    const st = ev.target.closest?.(".cp-missile-step");
    const btn = cm || ev2 || ic || rv || st;
    if (!btn || btn.disabled) return;
    ev.preventDefault();
    btn.disabled = true;
    const tokenId = btn.dataset.tokenId;
    if (cm) await _reactOrRelay(tokenId, "countermeasure");
    else if (ev2) await _reactOrRelay(tokenId, "evade");
    else if (ic) await _reactOrRelay(tokenId, "intercept");
    else if (st) await advanceOneMissile(canvas?.scene, tokenId);
    else if (rv) {
      const mt = canvas?.scene?.tokens?.get(tokenId);
      const f = mt?.flags?.[SCOPE]?.missile;
      if (mt && f) { await mt.update({ hidden: false, [`flags.${SCOPE}.missile.detected`]: true }); await _postIncomingCard(mt, f, canvas.scene.tokens.get(f.targetTokenId), localize("Vehicle.MissileRevealedByGM")); }
    }
  });

  Hooks.on("updateCombat", async (combat, changed) => {
    if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return;
    if (changed.round === undefined) return;    // once per round
    await advanceMissiles(undefined, Number(combat.round) || 0);
  });

  Hooks.on("renderCombatTracker", async (tracker, html) => {
    const root = html instanceof jQuery ? html[0] : (Array.isArray(html) ? html[0] : html);
    if (!root?.querySelector) return;
    root.querySelector(".cp-missiles-panel")?.remove();
    const scene = canvas?.scene;
    const missiles = scene ? scene.tokens.filter(t => t.flags?.[SCOPE]?.missile) : [];
    if (!missiles.length) return;
    const isGM = !!game.user.isGM;
    const rowData = missiles.map(mt => {
      const f = mt.flags[SCOPE].missile;
      return {
        tokenId: mt.id, weapon: f.weaponName, target: scene.tokens.get(f.targetTokenId)?.name ?? "?",
        guidance: f.guidance, turns: f.turnsToImpact, detected: !!f.detected, isGM,
      };
    });
    const render = foundry?.applications?.handlebars?.renderTemplate ?? renderTemplate;
    const panel = document.createElement("div");
    panel.className = "cp-missiles-panel";
    panel.innerHTML = await render("modules/cp2020-augmented/templates/combat/missiles-panel.hbs", { missiles: rowData });
    (root.querySelector("#combat-tracker") ?? root.querySelector(".combat-tracker") ?? root).appendChild(panel);
    panel.querySelectorAll(".cp-missile-row").forEach(el => el.addEventListener("click", (ev) => {
      if (ev.target.closest("button")) return;   // row buttons (reveal/advance) handle their own clicks
      const t = canvas?.tokens?.get(el.dataset.tokenId);
      if (t) { try { t.control({ releaseOthers: true }); canvas.animatePan({ x: t.center.x, y: t.center.y }); } catch {} }
    }));
  });
}
