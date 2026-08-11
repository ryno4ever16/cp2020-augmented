/**
 * 2-CLIENT ACPA frame-breach → PILOT OVERFLOW cross-actor write verification (:30004, official + module).
 *
 * CONCERN: when a PLAYER triggers Maximum-Metal damage to an ACPA (powered-armor) suit, a frame breach
 * overflows to the suit's LINKED PILOT through the personnel damage pipeline (applyLocationDamage →
 * pilot.update("system.damage")). That is a CROSS-ACTOR write. Single-GM testing masks it because the GM
 * applies locally and owns everything. The write is only safe if applyVehicleDamageMM runs on a client
 * that owns the pilot. This keeper drives BOTH player-side routes to that resolver and checks the pilot.
 *
 * Two parallel scenarios, one player-owned attacker firing a normal weapon (areaDamages) at two ACPA suits:
 *
 *   RELAY  (suit is GM-owned, player only OBSERVES it):
 *     dispatchAttack → _canModifyTarget(suit)=false → _relayVehicleAttack emits a `vehicleDamage` socket →
 *     the active GM re-runs dispatchAttack → applyVehicleDamageMM runs GM-SIDE → the pilot write lands
 *     (the GM owns the pilot).  EXPECTED: pilot overflow LANDS  (the comment's "already runs GM-side" claim
 *     holds for THIS path).
 *
 *   OWNER  (player OWNS the suit, pilot stays GM-owned — the cross-ownership case):
 *     dispatchAttack → _canModifyTarget(suit)=true → applyVehicleDamageMM runs on the PLAYER'S client →
 *     the pilot-overflow block (vehicle-damage.js ~648) calls applyLocationDamage → pilot.update() on a
 *     GM-owned pilot the player cannot write, with NO relay.  QUESTION: does the overflow land, or is it
 *     silently lost?  This is the hazard the concern names.
 *
 * Run from tests/:
 *   FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-acpa-2client-overflow.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const HIT = 30; // areaDamages total; sdp = HIT − armorSP(1) − toughness(8) = 21 → overflow guaranteed

async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 30_000 });
  const users = await sel.locator("option").evaluateAll((o) =>
    o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
  const u = users.find((x) => match.test(x.l));
  if (!u) throw new Error("no user matching " + match);
  for (const pw of passwords) {
    await sel.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([
      page.waitForNavigation({ url: /\/game/, timeout: 15_000 }).catch(() => {}),
      page.locator('button[name="join"]').click(),
    ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 15_000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

const browser = await chromium.launch({ headless: true });
const results = {};
const log = [];
try {
  // ---- GM: source check + world setup ----
  const gm = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await joinAs(gm, /gamemaster/i, [GM_PW]);
  await gm.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});

  // Served-source: confirm the pilot-overflow block calls applyLocationDamage directly (no local relay
  // guard) and carries the "already runs GM-side" assumption we are testing.
  const src = await gm.evaluate(async () => {
    const vd = await (await fetch("/modules/cp2020-augmented/module/vehicle/vehicle-damage.js", { cache: "no-store" })).text();
    const da = await (await fetch("/modules/cp2020-augmented/module/combat/DamageApplicator.js", { cache: "no-store" })).text();
    return {
      pilotBlockDirect: /r\.pilotDamage\s*>\s*0[\s\S]{0,600}applyLocationDamage\(\{\s*target:\s*pilot/.test(vd),
      claimsGmSide: /already runs GM-side/.test(vd),
      // applyLocationDamage writes the wound track with a bare target.update — no isGM/relay branch.
      applyLocationRawWrite: /system\.damage["']\s*:\s*current \+ netDamage/.test(da),
      applyLocationHasRelay: /applyLocationDamage[\s\S]{0,900}game\.socket\.emit/.test(da),
    };
  });
  log.push(`served: pilotBlockCallsApplyLocationDirectly=${src.pilotBlockDirect} claims"runs GM-side"=${src.claimsGmSide} applyLocationRawUpdate=${src.applyLocationRawWrite} applyLocationHasOwnRelay=${src.applyLocationHasRelay}`);

  const S = await gm.evaluate(async (HIT) => {
    const O = CONST.DOCUMENT_OWNERSHIP_LEVELS;
    const cap = {};
    const setS = async (k, v) => { try { cap[k] = game.settings.get("cp2020-augmented", k); } catch {} try { await game.settings.set("cp2020-augmented", k, v); } catch (e) {} };
    await setS("vehicleDamageEnabled", true);
    await setS("mmEnabled", true);
    await setS("vehicleRuleSystem", "MaximumMetal");

    // cleanup prior fixtures
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__"))) await a.delete().catch(() => {});
    const scene = game.scenes.active ?? canvas.scene;
    for (const t of scene.tokens.filter(t => t.name?.startsWith("__PW__"))) await t.delete().catch(() => {});

    const player = game.users.find(u => /Test User 1/i.test(u.name)) ?? game.users.find(u => u.role === 1);
    if (!player) throw new Error("no non-GM player user found");

    const mkSuit = async (name) => Actor.create({
      name, type: "cp2020-augmented.vehicle",
      system: { isACPA: true, str: 30, sp: { front: 1, side: 1, rear: 1, top: 1, bottom: 1 } },
    });
    const mkPilot = async (name) => Actor.create({
      name, type: "character", system: { damage: 0, stats: { bt: { modifier: 2 } } },
    });

    // RELAY scenario: GM-owned suit (player OBSERVES so they can target it), GM-owned pilot.
    const suitB = await mkSuit("__PW__SuitB_relay");
    const pilotB = await mkPilot("__PW__PilotB_relay");
    await suitB.update({ "system.pilotId": pilotB.id, "system.frameSDP": { head: 1, rArm: 1, lArm: 1, rLeg: 1, lLeg: 1, torso: 1 } });
    await suitB.update({ [`ownership.${player.id}`]: O.OBSERVER });   // can see + target, cannot write → relay

    // OWNER scenario: player OWNS the suit; pilot stays GM-owned (player only OBSERVES it so the
    // player-side resolver's game.actors.get(pilotId) resolves and actually ATTEMPTS the write).
    const suitA = await mkSuit("__PW__SuitA_owned");
    const pilotA = await mkPilot("__PW__PilotA_owned");
    await suitA.update({ "system.pilotId": pilotA.id, "system.frameSDP": { head: 1, rArm: 1, lArm: 1, rLeg: 1, lLeg: 1, torso: 1 } });
    await suitA.update({ [`ownership.${player.id}`]: O.OWNER });      // player writes the suit directly (no relay)
    await pilotA.update({ [`ownership.${player.id}`]: O.OBSERVER });  // observable, NOT ownable

    // Attacker owned by the player.
    const pc = await Actor.create({ name: "__PW__PC", type: "character" });
    await pc.update({ [`ownership.${player.id}`]: O.OWNER });

    const mk = (a, x) => ({ name: a.name, actorId: a.id, x, y: 1000, width: 1, height: 1, disposition: 0, actorLink: true });
    const [pcTok]    = await scene.createEmbeddedDocuments("Token", [mk(pc, 900)]);
    const [suitBTok] = await scene.createEmbeddedDocuments("Token", [mk(suitB, 1300)]);
    const [suitATok] = await scene.createEmbeddedDocuments("Token", [mk(suitA, 1600)]);

    const frame = (id) => foundry.utils.deepClone(game.actors.get(id).system.frameSDP ?? {});
    return {
      playerName: player.name, playerId: player.id, activeGM: game.users.activeGM?.id,
      pcId: pc.id, pcTokenId: pcTok.id,
      suitAId: suitA.id, pilotAId: pilotA.id, suitATokenId: suitATok.id,
      suitBId: suitB.id, pilotBId: pilotB.id, suitBTokenId: suitBTok.id,
      resolveModeA: game.actors.get(suitA.id).system.pilotId ? "detailed" : "quickkill",
      toughnessA: Number(game.actors.get(suitA.id).system.toughness) || 0,
      spFrontA: Number(game.actors.get(suitA.id).system.sp?.front) || 0,
      pilotBtmA: Number(pilotA.system?.stats?.bt?.modifier) || 0,
      pilotBtmB: Number(pilotB.system?.stats?.bt?.modifier) || 0,
      pilotA0: Number(pilotA.system.damage) || 0,
      pilotB0: Number(pilotB.system.damage) || 0,
      frameA0: frame(suitA.id), frameB0: frame(suitB.id),
      cap,
    };
  }, HIT);
  log.push(`setup: player=${S.playerName} activeGM=${S.activeGM}`);
  log.push(`  ids: suitA=${S.suitAId} pilotA=${S.pilotAId} | suitB=${S.suitBId} pilotB=${S.pilotBId}`);
  log.push(`  suitA(owned by player) toughness=${S.toughnessA} spFront=${S.spFrontA} mode=${S.resolveModeA} frameA0=${JSON.stringify(S.frameA0)} pilotA(GM,BTM ${S.pilotBtmA}) dmg0=${S.pilotA0}`);
  log.push(`  suitB(GM, player observes) frameB0=${JSON.stringify(S.frameB0)} pilotB(GM,BTM ${S.pilotBtmB}) dmg0=${S.pilotB0}`);

  // ---- Player joins ----
  const pl = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await joinAs(pl, /Test User 1/i, ["", GM_PW]);
  await pl.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});

  // In-page error capture on the player client (permission-denied writes surface here).
  await pl.evaluate(() => {
    window.__PW_ERRORS = [];
    window.addEventListener("unhandledrejection", (e) => window.__PW_ERRORS.push("UNHANDLEDREJECTION: " + (e.reason?.message ?? String(e.reason))));
    const oe = console.error.bind(console);
    console.error = (...a) => { try { window.__PW_ERRORS.push("CONSOLE.ERROR: " + a.map(x => x?.message ?? String(x)).join(" ")); } catch {} return oe(...a); };
    const ow = console.warn.bind(console);
    console.warn = (...a) => { try { const s = a.map(x => x?.message ?? String(x)).join(" "); if (/permission|lack|update/i.test(s)) window.__PW_ERRORS.push("CONSOLE.WARN: " + s); } catch {} return ow(...a); };
  });

  const who = await pl.evaluate((d) => ({
    isGM: game.user.isGM,
    ownsPC: game.actors.get(d.pcId)?.isOwner ?? false,
    ownsSuitA: game.actors.get(d.suitAId)?.isOwner ?? false,
    seesPilotA: !!game.actors.get(d.pilotAId), ownsPilotA: game.actors.get(d.pilotAId)?.isOwner ?? false,
    seesSuitB: !!game.actors.get(d.suitBId), ownsSuitB: game.actors.get(d.suitBId)?.isOwner ?? false,
  }), S);
  log.push(`player perms: isGM=${who.isGM} ownsPC=${who.ownsPC} | ownsSuitA=${who.ownsSuitA} seesPilotA=${who.seesPilotA} ownsPilotA=${who.ownsPilotA} | seesSuitB=${who.seesSuitB} ownsSuitB=${who.ownsSuitB}`);
  if (who.isGM || !who.ownsPC) throw new Error("player context wrong (isGM or does not own the attacker PC)");
  if (!who.ownsSuitA || who.ownsPilotA) log.push("⚠ OWNER-scenario ownership not as intended (need ownsSuitA=true, ownsPilotA=false)");
  if (who.ownsSuitB) log.push("⚠ RELAY-scenario ownership not as intended (player must NOT own suitB)");

  const fire = (targetActorId, targetTokenId) => pl.evaluate(({ pcId, targetActorId, targetTokenId, HIT }) => {
    Hooks.callAll("cyberpunk2020.weaponFired", {
      attackerId: pcId, targetActorId, targetTokenId,
      areaDamages: { Torso: [{ damage: HIT }] }, weaponName: "__PW__AVGun",
    });
  }, { pcId: S.pcId, targetActorId, targetTokenId, HIT });

  // GM-authoritative poll: pilot damage change (up to ~6s).
  const pollPilot = (pilotId, from) => gm.evaluate(async ({ pilotId, from }) => {
    for (let i = 0; i < 30; i++) {
      const v = Number(game.actors.get(pilotId)?.system?.damage) || 0;
      if (v !== from) return { v, ms: i * 200 };
      await new Promise(r => setTimeout(r, 200));
    }
    return { v: Number(game.actors.get(pilotId)?.system?.damage) || 0, ms: 6000 };
  }, { pilotId, from });
  const gmFrame = (suitId) => gm.evaluate((id) => foundry.utils.deepClone(game.actors.get(id).system.frameSDP ?? {}), suitId);
  // Poll up to ~3s for the suit frame to differ from its baseline (the frame write on line 749 lands
  // AFTER the pilot write on 658, so a single read right after the pilot-change poll can miss it).
  const pollFrameChange = (suitId, base) => gm.evaluate(async ({ suitId, base }) => {
    const read = () => foundry.utils.deepClone(game.actors.get(suitId).system.frameSDP ?? {});
    for (let i = 0; i < 15; i++) {
      const f = read();
      if (JSON.stringify(f) !== JSON.stringify(base)) return { frame: f, changed: true, ms: i * 200 };
      await new Promise(r => setTimeout(r, 200));
    }
    return { frame: read(), changed: false, ms: 3000 };
  }, { suitId, base });
  const cardCount = (suitId) => gm.evaluate((id) => game.messages.filter(m => m.speaker?.actor === id).length, suitId);

  // ===== SCENARIO 2 (RELAY): player fires at the GM-owned suit =====
  const cardsB0 = await cardCount(S.suitBId);
  await fire(S.suitBId, S.suitBTokenId);
  const relay = await pollPilot(S.pilotBId, S.pilotB0);
  const frameB = await pollFrameChange(S.suitBId, S.frameB0);
  const cardsBAfter = await cardCount(S.suitBId);
  const relayFrameChanged = frameB.changed;
  log.push(`RELAY: pilotB ${S.pilotB0}→${relay.v} in ${relay.ms}ms; suitB frame ${JSON.stringify(S.frameB0)}→${JSON.stringify(frameB.frame)} (changed=${relayFrameChanged} @${frameB.ms}ms); suitB cards ${cardsB0}→${cardsBAfter}`);
  results.relay_pilot_overflow = {
    pass: relay.v > S.pilotB0,
    detail: `player→GM vehicleDamage relay: applyVehicleDamageMM runs GM-side, pilot overflow ${relay.v > S.pilotB0 ? `LANDED (${S.pilotB0}→${relay.v})` : `DID NOT land (stayed ${relay.v})`}`,
  };

  // ===== SCENARIO 1 (OWNER): player fires at the suit they OWN; pilot is GM-owned =====
  const cardsA0 = await cardCount(S.suitAId);
  await fire(S.suitAId, S.suitATokenId);
  const owner = await pollPilot(S.pilotAId, S.pilotA0);
  const frameA = await pollFrameChange(S.suitAId, S.frameA0);
  const frameAAfter = frameA.frame;
  const cardsAAfter = await cardCount(S.suitAId);
  const ownerFrameChanged = frameA.changed;
  const plView = await pl.evaluate((d) => ({
    pilotA: Number(game.actors.get(d.pilotAId)?.system?.damage) || 0,
    suitAFrame: foundry.utils.deepClone(game.actors.get(d.suitAId)?.system?.frameSDP ?? {}),
    errors: (window.__PW_ERRORS || []).slice(0, 12),
  }), S);
  log.push(`OWNER: pilotA ${S.pilotA0}→${owner.v} in ${owner.ms}ms; suitA frame ${JSON.stringify(S.frameA0)}→${JSON.stringify(frameAAfter)} (changed=${ownerFrameChanged}); suitA cards ${cardsA0}→${cardsAAfter}`);
  log.push(`OWNER player-client view: pilotA.damage=${plView.pilotA} suitA.frame=${JSON.stringify(plView.suitAFrame)}`);
  if (plView.errors.length) plView.errors.forEach(e => log.push(`  player-err: ${e}`));
  else log.push(`  player-err: (none captured)`);

  // Proof the player-side resolver RAN and attempted the cross-actor pilot write: a captured
  // permission error naming pilotA. (The unhandled throw aborts applyVehicleDamageMM BEFORE the suit
  // frame update on line 749 and the card on 760 — so "no frame change / no card" is itself a symptom,
  // not evidence the resolver was skipped.) Fall back to frame/card change as a secondary proof.
  const permErrOnPilotA = plView.errors.some(e => e.includes(S.pilotAId) && /permission|lack/i.test(e));
  const resolverRanOwner = permErrOnPilotA || ownerFrameChanged || cardsAAfter > cardsA0;
  results.owner_pilot_overflow = {
    pass: owner.v > S.pilotA0,
    detail: owner.v > S.pilotA0
      ? `player OWNS suit: pilot overflow LANDED (${S.pilotA0}→${owner.v}) — cross-actor write succeeded from the player client`
      : (resolverRanOwner
          ? `SILENT FAILURE — the player-side resolver reached the pilot-overflow write${permErrOnPilotA ? " (captured: 'lacks permission to update Actor [" + S.pilotAId + "]')" : ""} and it was REJECTED; the GM-owned pilot's overflow was LOST (stayed ${owner.v}). The unhandled throw also aborted the suit-frame write + damage card (frame ${ownerFrameChanged ? "changed" : "UNCHANGED"}, cards +${cardsAAfter - cardsA0}). No player→GM relay guards this cross-actor write.`
          : `INCONCLUSIVE — no proof the resolver ran (no permission error, no suit change, no card); pilot stayed ${owner.v}`),
    finding: owner.v <= S.pilotA0 && resolverRanOwner,
    inconclusive: owner.v <= S.pilotA0 && !resolverRanOwner,
  };

  // ---- cleanup ----
  await gm.evaluate(async (d) => {
    const scene = game.scenes.active ?? canvas.scene;
    for (const t of scene.tokens.filter(t => t.name?.startsWith("__PW__"))) await t.delete().catch(() => {});
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__"))) await a.delete().catch(() => {});
    for (const [k, v] of Object.entries(d.cap)) { try { await game.settings.set("cp2020-augmented", k, v); } catch {} }
  }, S).catch(() => {});
} catch (e) {
  log.push("ERROR: " + e.message + (e.stack ? "\n" + e.stack.split("\n").slice(1, 3).join("\n") : ""));
} finally {
  await browser.close();
}

console.log("\n===== ACPA 2-CLIENT PILOT-OVERFLOW (:30004, official + module) =====");
log.forEach(l => console.log("  • " + l));
console.log("");
let allPass = Object.keys(results).length > 0;
for (const [k, v] of Object.entries(results)) {
  const tag = v.pass ? "PASS ✅" : (v.finding ? "FINDING ❗" : (v.inconclusive ? "INCONCL ⚠" : "FAIL ❌"));
  console.log(`  ${tag}  ${k.padEnd(22)} — ${v.detail}`);
  if (!v.pass) allPass = false;
}
console.log("\n  OVERALL: " + (allPass ? "ALL PASS ✅" : "SEE FINDINGS ABOVE"));
process.exit(allPass ? 0 : 1);
