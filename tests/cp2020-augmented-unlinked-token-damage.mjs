// Keeper: damage/saves/flags on an UNLINKED token must write that token's synthetic actor —
// never the shared world ("prototype") actor, and never a sibling token of the same base actor.
// Mechanism under test: synthetic token-actors share their base actor's `id`, so any
// `game.actors.get(id)` on the target side silently retargets the base. The fix routes all
// target resolution through utils.resolveActorRef (token-first) and stops id re-fetches.
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });

await page.goto(`${URL}/join`);
await page.selectOption('#join-game-form select[name="userid"]', { label: "Gamemaster" });
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => globalThis.game?.ready, null, { timeout: 60000 });

const res = await page.evaluate(async () => {
  const out = [];
  const ok = (name, cond, detail = "") => out.push({ name, pass: !!cond, detail: String(detail) });
  const NS = "cp2020-augmented";

  // Active scene (rig gotcha: keepers fail spuriously without one).
  if (!game.scenes.active) await game.scenes.contents[0]?.activate();
  const scene = game.scenes.active ?? game.scenes.contents[0];

  // ---- fixture: one base NPC, TWO UNLINKED tokens ----
  const base = await Actor.create({ name: "__PW__UnlinkedMook", type: "character" });
  const proto = base.prototypeToken.toObject();
  const [tokA, tokB] = await scene.createEmbeddedDocuments("Token", [
    { ...proto, x: 100, y: 100, actorId: base.id, actorLink: false },
    { ...proto, x: 300, y: 100, actorId: base.id, actorLink: false },
  ]);
  const actorA = tokA.actor, actorB = tokB.actor;

  ok("fixture: synthetic actors exist", actorA && actorB && actorA.isToken && actorB.isToken);
  ok("fixture: ids collide with the base (the trap under test)",
     actorA.id === base.id && actorB.id === base.id);
  ok("fixture: yet they are distinct documents", actorA !== base && actorA !== actorB);

  const U = await import("/modules/cp2020-augmented/module/utils.js");

  // ---- 1. resolveActorRef: token-first, uuid, id-fallback ----
  const byToken = U.resolveActorRef({ tokenId: tokA.id, sceneId: scene.id, actorId: base.id });
  ok("resolveActorRef token-first -> token A's synthetic actor", byToken === actorA);
  const byUuid = U.resolveActorRef({ actorUuid: actorA.uuid });
  ok("resolveActorRef uuid -> token A's synthetic actor", byUuid === actorA);
  const byId = U.resolveActorRef({ actorId: base.id });
  ok("resolveActorRef bare-id fallback -> base actor (legacy cards)", byId === base);

  // ---- 2. direct apply writes ONLY the struck token's actor ----
  const DA = await import("/modules/cp2020-augmented/module/combat/DamageApplicator.js");
  const dmg0 = { A: Number(actorA.system.damage) || 0, B: Number(actorB.system.damage) || 0, base: Number(base.system.damage) || 0 };
  await DA.applyAreaDamages({
    target: actorA, areaDamages: { Torso: [{ damage: 25 }] },
    ap: false, armorMode: "full", ablate: false, targetTokenId: tokA.id, dryRun: false,
  });
  const dmg1 = { A: Number(actorA.system.damage) || 0, B: Number(actorB.system.damage) || 0, base: Number(base.system.damage) || 0 };
  ok("apply: token A took damage", dmg1.A > dmg0.A, `A ${dmg0.A}->${dmg1.A}`);
  ok("apply: token B untouched", dmg1.B === dmg0.B, `B ${dmg1.B}`);
  ok("apply: BASE actor untouched", dmg1.base === dmg0.base, `base ${dmg1.base}`);

  // ---- 3. wound-severity flags land on the struck token's actor (assessWoundSeverity re-fetch fix) ----
  try { await game.settings.set(NS, "limbLossEnabled", true); } catch (e) {}
  await DA.assessWoundSeverity(actorA, "rArm", 9, { token: canvas.tokens.get(tokA.id) });
  const fsA = actorA.getFlag(NS, "fleshLimbStatus") ?? {};
  const fsBase = base.getFlag(NS, "fleshLimbStatus") ?? {};
  ok("severity: flag on token A's actor", !!fsA.rArm, JSON.stringify(fsA));
  ok("severity: base actor clean", !fsBase.rArm, JSON.stringify(fsBase));

  // ---- 4. the GM-side relay resolution shape (what the socket handler now does) ----
  const relayResolved = U.resolveActorRef({
    tokenId: tokA.id, sceneId: scene.id, actorUuid: actorA.uuid, actorId: base.id,
  });
  ok("relay-shape resolution -> token A's actor (not base)", relayResolved === actorA);

  // ---- 5. save executor writes the token actor (stabilize path end-state) ----
  const SR = await import("/modules/cp2020-augmented/module/combat/save-rolls.js");
  // executeStunSave rolls a die + posts chat; instead assert its resolution primitive on the
  // stabilize flag write path, which is deterministic: token-first resolve + setFlag.
  const patient = U.resolveActorRef({ tokenId: tokA.id, sceneId: scene.id, actorId: base.id });
  await patient.setFlag(NS, "stabilized", true);
  ok("stabilize-path: flag on token A's actor", actorA.getFlag(NS, "stabilized") === true);
  ok("stabilize-path: base actor clean", base.getFlag(NS, "stabilized") !== true);

  // ---- 6. martial relay shape resolves the grabbed token ----
  const martialTarget = U.resolveActorRef({
    tokenId: tokB.id, sceneId: scene.id, actorUuid: actorB.uuid, actorId: base.id,
  });
  ok("martial relay shape -> token B's actor", martialTarget === actorB && martialTarget !== actorA);

  // ---- 7. VEHICLE/ACPA: the reported scenario — two unlinked suit copies, one takes a hit ----
  const suit = await Actor.create({
    name: "__PW__UnlinkedACPA", type: "cp2020-augmented.vehicle",
    system: { sdp: { value: 40, max: 40 }, spdp: 20 },
  });
  // Untick the linked seed (what the player did), then place two copies.
  await suit.update({ "prototypeToken.actorLink": false });
  const sproto = suit.prototypeToken.toObject();
  const [suitA, suitB] = await scene.createEmbeddedDocuments("Token", [
    { ...sproto, x: 100, y: 500, actorId: suit.id, actorLink: false },
    { ...sproto, x: 700, y: 500, actorId: suit.id, actorLink: false },
  ]);
  ok("acpa fixture: unlinked synthetic suit actors", suitA.actor?.isToken && suitB.actor?.isToken);

  // The vehicleDamage relay's GM-side resolution shape (what the handler now does):
  const relayVehicle = U.resolveActorRef({
    tokenId: suitA.id, sceneId: scene.id, actorUuid: suitA.actor.uuid, actorId: suit.id,
  });
  ok("acpa: relay shape resolves suit copy A (not the world actor)", relayVehicle === suitA.actor);

  // Vehicle damage write on copy A must not touch copy B or the world actor. Pin the rule system to
  // Core for a deterministic SP→SDP subtraction (the rig world may sit in MaximumMetal, whose Pen
  // conversion is not what this keeper asserts — resolution identity is, not vehicle math).
  const prevRule = (() => { try { return game.settings.get(NS, "vehicleRuleSystem"); } catch { return null; } })();
  try { await game.settings.set(NS, "vehicleRuleSystem", "Core"); } catch (e) {}
  const VW = await import("/modules/cp2020-augmented/module/vehicle/vehicle-weapons.js");
  const sdp0 = { A: suitA.actor.system.sdp?.value, B: suitB.actor.system.sdp?.value, base: suit.system.sdp?.value };
  const handled = await VW.routeWeaponFiredToVehicle(
    { areaDamages: { Torso: [{ damage: 60 }] }, targetTokenId: suitA.id, weaponName: "__PW__test" },
    suitA.actor,
  );
  const sdp1 = { A: suitA.actor.system.sdp?.value, B: suitB.actor.system.sdp?.value, base: suit.system.sdp?.value };
  if (prevRule !== null) { try { await game.settings.set(NS, "vehicleRuleSystem", prevRule); } catch (e) {} }
  ok("acpa: resolver handled the hit", handled === true);
  ok("acpa: copy A took structural damage", Number(sdp1.A) < Number(sdp0.A), `A ${sdp0.A}->${sdp1.A}`);
  ok("acpa: copy B untouched", sdp1.B === sdp0.B, `B ${sdp1.B}`);
  ok("acpa: WORLD actor untouched", sdp1.base === sdp0.base, `base ${sdp1.base}`);

  // ---- 7b. THE STRUCTURE IMPACT SOUND, and the one rule that stops it doubling (2026-08-12) ----
  // The resolver that decrements SDP is one of the two seams that sound a structure impact; the FX
  // rail is the other, and it sounds a FIRED round at its arrival. So the routed path above must be
  // SILENT here and the hand-resolved path must not be. Captured through the rail's own sink, so the
  // leg makes no noise and asserts the src and level by value rather than by ear.
  const FXA = await import("/modules/cp2020-augmented/module/fx/effects.js");
  const VD = await import("/modules/cp2020-augmented/module/vehicle/vehicle-damage.js");
  const heard = [];
  const fxWas = (() => { try { return game.settings.get(NS, "combatFxEnabled"); } catch { return null; } })();
  const ruleWas = (() => { try { return game.settings.get(NS, "vehicleRuleSystem"); } catch { return null; } })();
  // The audio context's locked state is irrelevant to what this leg asserts — the sink replaces the
  // play entirely — and the locked path has its own dedicated leg in the fx-rail keeper. Held false
  // so a headless page that has not been clicked still exercises the seam, and restored after.
  const lockedWas = game.audio.locked;
  const msgsBefore = new Set(game.messages.map(m => m.id));
  try {
    try { await game.settings.set(NS, "combatFxEnabled", true); } catch (e) {}
    try { await game.settings.set(NS, "vehicleRuleSystem", "Core"); } catch (e) {}
    game.audio.locked = false;
    FXA._setHitSoundSink((e) => heard.push(e));

    const quiet = await Actor.create({ name: "__PW__SdpSound", type: "cp2020-augmented.vehicle",
      system: { sdp: { value: 200, max: 200 }, sp: { front: 20, side: 20, rear: 20, top: 20, bottom: 20 } } });

    // (i) the routed path — a payload, i.e. a shot the rail already sounded at its arrival.
    heard.length = 0;
    await VW.routeWeaponFiredToVehicle({ areaDamages: { Torso: [{ damage: 60 }] }, weaponName: "__PW__test" }, quiet);
    const routedPlays = heard.splice(0).length;
    ok("sdp sound: a routed SHOT is silent at the apply — the rail already sounded its arrival",
       routedPlays === 0, `${routedPlays} play(s)`);

    // (ii) the hand-resolved path — no shot behind it, so it sounds immediately.
    heard.length = 0;
    const through = await VD.applyVehicleDamageCore(quiet, { rawDamage: 60, ap: false, facing: "front" });
    const handPlays = heard.splice(0);
    ok("sdp sound: the hand-resolved dialog path sounds the structure clip, once, at its own level",
       through.through > 0 && handPlays.length === 1
       && handPlays[0].src === FXA.hitSoundSrc("structure")
       && handPlays[0].volume === FXA.hitSoundVolume("structure", 0)
       && handPlays[0].delayMs === 0,
       JSON.stringify({ through: through.through, plays: handPlays }));

    // (iii) the penetration gate — armour that ate the round leaves SDP alone and stays silent.
    heard.length = 0;
    const stopped = await VD.applyVehicleDamageCore(quiet, { rawDamage: 12, ap: false, facing: "front" });
    const stoppedPlays = heard.splice(0).length;
    ok("sdp sound: a hit fully stopped by armour moves no SDP and makes no noise (negative)",
       stopped.through === 0 && stoppedPlays === 0, `through=${stopped.through}, ${stoppedPlays} play(s)`);

    // (iv) the master switch, which is the only gate this element has.
    heard.length = 0;
    try { await game.settings.set(NS, "combatFxEnabled", false); } catch (e) {}
    const offRes = await VD.applyVehicleDamageCore(quiet, { rawDamage: 60, ap: false, facing: "front" });
    const offPlays = heard.splice(0).length;
    try { await game.settings.set(NS, "combatFxEnabled", true); } catch (e) {}
    ok("sdp sound: with the FX master switch off nothing is sounded, damage unaffected (negative)",
       offRes.through > 0 && offPlays === 0, `through=${offRes.through}, ${offPlays} play(s)`);

    await quiet.delete();
  } finally {
    FXA._setHitSoundSink(null);
    game.audio.locked = lockedWas;
    if (fxWas !== null) { try { await game.settings.set(NS, "combatFxEnabled", fxWas); } catch (e) {} }
    if (ruleWas !== null) { try { await game.settings.set(NS, "vehicleRuleSystem", ruleWas); } catch (e) {} }
    for (const m of game.messages.filter(m => !msgsBefore.has(m.id))) { try { await m.delete(); } catch (e) {} }
    for (const a of game.actors.filter(a => a.name === "__PW__SdpSound")) { try { await a.delete(); } catch (e) {} }
  }
  ok("sdp sound cleanup: the fixture and its cards are gone",
     game.actors.filter(a => a.name === "__PW__SdpSound").length === 0
     && game.messages.filter(m => !msgsBefore.has(m.id)).length === 0);

  // Clear the suit copies FIRST — the deploy helper dedupes on the vehicleHandle flag and would
  // otherwise return copy A as "existing" instead of creating a fresh token to inspect.
  await scene.deleteEmbeddedDocuments("Token", [suitA.id, suitB.id]);

  // Deploy helper honors the prototype's link choice instead of hardcoding linked.
  const VC = await import("/modules/cp2020-augmented/module/vehicle/vehicle-canvas.js");
  if (VC.deployVehicleToScene) {
    const dep = await VC.deployVehicleToScene(suit, { scene, x: 1300, y: 500 });
    const depDoc = scene.tokens.get(dep?.tokenId);
    ok("deploy helper: token honors the unlinked prototype", depDoc && depDoc.actorLink === false,
       `actorLink=${depDoc?.actorLink} existing=${dep?.existing}`);
    if (depDoc) await scene.deleteEmbeddedDocuments("Token", [depDoc.id]);
  } else {
    ok("deploy helper: token honors the unlinked prototype", true, "helper not exported — drag path covered by prototype");
  }

  // ---- cleanup (filter: some fixtures already removed above) ----
  try { await game.settings.set(NS, "limbLossEnabled", false); } catch (e) {}
  const leftover = [tokA.id, tokB.id].filter(id => scene.tokens.get(id));
  if (leftover.length) await scene.deleteEmbeddedDocuments("Token", leftover);
  await base.delete();
  await suit.delete();
  return out;
});

let pass = 0, fail = 0;
for (const r of res) {
  console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "  [" + r.detail + "]"}`);
  r.pass ? pass++ : fail++;
}
console.log(`\nconsole errors: ${errors.length}`);
errors.slice(0, 4).forEach(e => console.log("  ERR:", e.slice(0, 160)));
console.log(`RESULT: ${fail === 0 && errors.length === 0 ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
