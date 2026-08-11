/** Boot-cost hardening (PERF-LOAD-STATIC-AUDIT S7 / R9 / S3 / chip-grant):
 *   S7  the flesh-limb flag migration stamps completion BEFORE it sweeps, reports a stopped run
 *       loudly, and is re-runnable from the module api.
 *   R9  the legacy rad-zone upgrade has a completion stamp at all, with the same shape.
 *   S3  the canvasReady light/vision sweeps leave a non-applier client before they read a token.
 *   MAP the chip-grant skill-index map is built once and shared, and the grant/prune pass still
 *       produces the same values on a two-actor fixture.
 *  The two migrations are left COMPLETE on this world, which is their correct post-migration state. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
const announced = [];   // the deliberate "stopped part-way" reports this spec provokes
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (/api\.migrations\./.test(t)) announced.push(t);
  else errors.push("console: " + t);
});
await joinGM(p);

const r = await p.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  const out = {};
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const until = async (fn, tries = 40) => { for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await sleep(150); } return fn(); };
  const api = () => game.modules.get(SCOPE)?.api;

  // Leftovers from an interrupted run.
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Perf"))) await a.delete().catch(() => {});
  for (const s of game.scenes.filter(s => s.name.startsWith("__PW__Perf"))) await s.delete().catch(() => {});

  // ── The api re-run surface ────────────────────────────────────────────────────────────────────
  out.apiShape = {
    flesh: typeof api()?.migrations?.fleshLimbStatus,
    rad: typeof api()?.migrations?.legacyRadZones,
    sameOnGlobal: api()?.migrations === game.cpAugmented?.migrations,
  };

  // ══ S7 — flesh-limb status migration ═════════════════════════════════════════════════════════
  // A world actor carrying a pre-split entry on a zone with NO structural pool: the migration must
  // move it to the flesh key.
  const fleshActor = await Actor.create({
    name: "__PW__PerfFleshActor", type: "character",
    flags: { [SCOPE]: { limbStatus: { rArm: "crippled" } } },
  });
  out.fleshBefore = {
    limbStatus: foundry.utils.deepClone(fleshActor.flags?.[SCOPE]?.limbStatus ?? null),
    structuralPool: Number(fleshActor.system?.sdp?.sum?.rArm) || 0,
  };

  // A scene with ONE unlinked token, whose `actor` read is counted (and can be made to fail). The
  // migration's second leg reads exactly this property once per unlinked token, so the counter says
  // whether the sweep ran at all, and the failure mode is a real throw from inside the sweep.
  const fleshScene = await Scene.create({ name: "__PW__PerfFleshScene", width: 1000, height: 1000 });
  const [fleshTok] = await fleshScene.createEmbeddedDocuments("Token", [{
    name: "__PW__PerfFleshTok", actorId: fleshActor.id, actorLink: false, x: 100, y: 100,
  }]);
  const findDesc = (obj, key) => { let o = obj; while (o) { const d = Object.getOwnPropertyDescriptor(o, key); if (d) return d; o = Object.getPrototypeOf(o); } return null; };
  const fleshDesc = findDesc(fleshTok, "actor");
  const probe = { reads: 0, fail: false };
  Object.defineProperty(fleshTok, "actor", {
    configurable: true,
    get() {
      probe.reads++;
      if (probe.fail) throw new Error("__PW__ probe: token actor unavailable");
      return fleshDesc?.get?.call(this) ?? null;
    },
  });

  const fleshFlag = () => game.settings.get(SCOPE, "fleshLimbStatusMigrated");
  const setFleshFlag = (v) => game.settings.set(SCOPE, "fleshLimbStatusMigrated", v);

  // (S7-a) A run that STOPS PART-WAY still leaves the completion stamp set.
  await setFleshFlag(false);
  probe.fail = true;
  const readsBeforeFail = probe.reads;
  await api().migrations.fleshLimbStatus();
  out.s7Failed = { flagAfter: fleshFlag(), swept: probe.reads > readsBeforeFail };

  // (S7-b) The boot path then does NOT sweep again — the stamp is what stops it.
  const readsBeforeGated = probe.reads;
  await api().migrations.fleshLimbStatus({ force: false });
  out.s7Gated = { flagAfter: fleshFlag(), reads: probe.reads - readsBeforeGated };

  // (S7-c) Clean run: stamp cleared → the sweep runs and moves the value → stamp set.
  await setFleshFlag(false);
  probe.fail = false;
  const readsBeforeClean = probe.reads;
  await api().migrations.fleshLimbStatus({ force: false });
  const fresh = game.actors.get(fleshActor.id);
  out.s7Clean = {
    flagAfter: fleshFlag(),
    reads: probe.reads - readsBeforeClean,
    limbStatus: foundry.utils.deepClone(fresh.flags?.[SCOPE]?.limbStatus ?? {}),
    fleshLimbStatus: foundry.utils.deepClone(fresh.flags?.[SCOPE]?.fleshLimbStatus ?? {}),
  };

  delete fleshTok.actor;
  await fleshScene.delete().catch(() => {});
  await fleshActor.delete().catch(() => {});

  // ══ R9 — legacy rad-zone upgrade ═════════════════════════════════════════════════════════════
  const RZ = await import("/modules/cp2020-augmented/module/radiation/radiation-zone-behavior.js");
  const BEHAVIOR = RZ.RAD_ZONE_BEHAVIOR;
  const radFlag = () => game.settings.get(SCOPE, "radZonesMigrated");
  const setRadFlag = (v) => game.settings.set(SCOPE, "radZonesMigrated", v);
  const radScene = await Scene.create({ name: "__PW__PerfRadScene", width: 1000, height: 1000 });
  const legacyRegion = async (name, formula) => {
    const [reg] = await radScene.createEmbeddedDocuments("Region", [{
      name, shapes: [{ type: "rectangle", x: 0, y: 0, width: 200, height: 200 }],
      flags: { [SCOPE]: { isRadZone: true, radsFormula: formula, sourceLabel: "__PW__ reactor" } },
    }]);
    return reg;
  };
  const regionState = (id) => {
    const reg = radScene.regions.get(id);
    const beh = reg?.behaviors?.find(x => x.type === BEHAVIOR);
    return {
      hasBehavior: !!beh,
      formula: beh?.system?.radsFormula ?? null,
      source: beh?.system?.sourceLabel ?? null,
      legacyTag: reg?.flags?.[SCOPE]?.isRadZone ?? null,
    };
  };
  out.behaviorRegistered = !!RZ.radiationZoneBehaviorClass();

  // (R9-a) Clean run: stamp cleared → the tagged region gains the behavior and loses the tag.
  const regA = await legacyRegion("__PW__PerfRadA", "2d6");
  await setRadFlag(false);
  out.r9Before = regionState(regA.id);
  await api().migrations.legacyRadZones({ force: false });
  out.r9Clean = { flagAfter: radFlag(), region: regionState(regA.id) };

  // (R9-b) A tagged region that arrives AFTER the stamp is not swept by the boot path — and the
  // manual re-run is what picks it up. (Its dosing is unaffected either way: the tick's legacy path
  // still reads the tag.)
  const regB = await legacyRegion("__PW__PerfRadB", "1d10");
  await api().migrations.legacyRadZones({ force: false });
  out.r9Gated = regionState(regB.id);
  await api().migrations.legacyRadZones();
  out.r9Rerun = regionState(regB.id);

  // (R9-c) A run that stops part-way still leaves the stamp set. The per-region inner catch already
  // contains a failed upgrade, so the probe fails the step OUTSIDE it: the behaviors read the sweep
  // makes on every tagged region before deciding to upgrade it.
  const regC = await legacyRegion("__PW__PerfRadC", "3d6");
  regC.behaviors.some = () => { throw new Error("__PW__ probe: region behaviors unavailable"); };
  await setRadFlag(false);
  await api().migrations.legacyRadZones();
  out.r9Failed = { flagAfter: radFlag(), stillTagged: regionState(regC.id).legacyTag === true };
  delete regC.behaviors.some;
  out.r9RestoredCollection = typeof regC.behaviors.some === "function" && regC.behaviors.some(() => false) === false;
  await radScene.delete().catch(() => {});

  // ══ S3 — the canvasReady sweeps early-out on a non-applier client ═════════════════════════════
  const L = await import("/modules/cp2020-augmented/module/mech/light.js");
  const scene = game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
  const lightActor = await Actor.create({ name: "__PW__PerfLightActor", type: "character" });
  await lightActor.createEmbeddedDocuments("Item", [{
    name: "__PW__PerfLamp", type: "misc",
    system: { equipped: true, mechLight: { enabled: true, on: true, shape: "circle", bright: 8, dim: 16, angle: 360, color: "" } },
  }]);
  const [lightTok] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PW__PerfLightTok", actorId: lightActor.id, actorLink: true, x: 1500, y: 1500,
    light: { bright: 0, dim: 0, angle: 360 },
  }]);

  await sleep(2500);   // let the fresh token finish drawing, so the counter below sees only the sweeps

  // Count the token writes the sweeps issue (they route through the owning scene) and the token→actor
  // resolutions they perform (one per token, at the top of each sweep's loop).
  const sceneProto = Object.getPrototypeOf(scene);
  const origUpdateEmbedded = sceneProto.updateEmbeddedDocuments;
  const writes = { tokens: 0 };
  sceneProto.updateEmbeddedDocuments = function (name, data, op) {
    if (name === "Token") writes.tokens += (data?.length ?? 0);
    return origUpdateEmbedded.call(this, name, data, op);
  };
  const lightDesc = findDesc(lightTok, "actor");
  const resolves = { count: 0 };
  Object.defineProperty(lightTok, "actor", {
    configurable: true,
    get() { resolves.count++; return lightDesc?.get?.call(this) ?? null; },
  });

  // Stand in as a second user so this client is NOT the designated applier. activeGM is a computed
  // getter on the Users collection; shadow it for the length of the sweep only.
  let other = game.users.find(u => u.id !== game.user.id);
  let madeUser = false;
  if (!other) { other = await User.create({ name: "__PW__PerfUser2", role: 4 }); madeUser = true; }
  const usersDesc = findDesc(game.users, "activeGM");
  Object.defineProperty(game.users, "activeGM", { configurable: true, get() { return other; } });
  out.applierCheck = { someoneElse: L.someoneElseIsTheApplier(), forActor: L.iAmTheApplier(lightActor) };

  // Control: an idle window of the same length with no canvasReady, so the counters below are
  // attributable to the sweeps and not to anything else that touches this token.
  const idle = { writes: writes.tokens, resolves: resolves.count };
  await sleep(1200);
  out.s3Idle = { writes: writes.tokens - idle.writes, resolves: resolves.count - idle.resolves };

  const before = { writes: writes.tokens, resolves: resolves.count };
  Hooks.callAll("canvasReady", canvas);
  await sleep(1200);
  out.s3NonApplier = { writes: writes.tokens - before.writes, resolves: resolves.count - before.resolves };

  // Applier: the same call on this client's own turn must still reconcile the fixture token.
  delete game.users.activeGM;
  out.applierRestored = { someoneElse: L.someoneElseIsTheApplier(), activeGmIsMe: game.users.activeGM?.id === game.user.id };
  // Put the fixture token back to unlit and drop our stored base first, so the applier sweep has real
  // work to do (the createToken path already lit it when the fixture was placed).
  await scene.updateEmbeddedDocuments("Token", [{
    _id: lightTok.id, light: { bright: 0, dim: 0, angle: 360 }, [`flags.${SCOPE}.-=mechBaseLight`]: null,
  }]);
  await sleep(400);
  const before2 = { writes: writes.tokens, resolves: resolves.count };
  Hooks.callAll("canvasReady", canvas);
  await until(() => (scene.tokens.get(lightTok.id)?.light?.bright ?? 0) === 8 && writes.tokens > before2.writes);
  out.s3Applier = {
    writes: writes.tokens - before2.writes,
    resolves: resolves.count - before2.resolves,
    bright: scene.tokens.get(lightTok.id)?.light?.bright ?? null,
    dim: scene.tokens.get(lightTok.id)?.light?.dim ?? null,
  };

  sceneProto.updateEmbeddedDocuments = origUpdateEmbedded;
  delete lightTok.actor;
  out.s3ProbesRestored = {
    updateRestored: sceneProto.updateEmbeddedDocuments === origUpdateEmbedded,
    activeGmRestored: !!usersDesc && game.users.activeGM?.id === game.user.id,
  };
  await scene.deleteEmbeddedDocuments("Token", [lightTok.id]).catch(() => {});
  await lightActor.delete().catch(() => {});
  if (madeUser) await other.delete().catch(() => {});

  // ══ Chip grant — the skill-index map is built once, and the pass still prunes/grants the same ══
  const CG = await import("/modules/cp2020-augmented/module/mech/chip-grant.js");
  const mapA = await CG.skillIndexNamesById();
  const mapB = await CG.skillIndexNamesById();
  out.indexMap = { same: mapA === mapB, size: mapA.size, isMap: mapA instanceof Map };

  const mkChipActor = async (n) => {
    const a = await Actor.create({ name: `__PW__PerfChip${n}`, type: "character" });
    await a.createEmbeddedDocuments("Item", [{
      name: `__PW__PerfChip${n} Chip`, type: "cyberware",
      system: {
        equipped: true, EffectMode: "Permanent", EffectActive: true,
        CyberWorkType: { Types: ["Chip"], ChipActive: true, ChipSkills: { "__PW__PerfGranted": 4 }, Stat: {}, Skill: {} },
      },
    }]);
    // An orphan the pass must prune (flagged, untrained) and one it must keep but unflag (trained).
    await a.createEmbeddedDocuments("Item", [{
      name: "__PW__PerfOrphan", type: "skill", system: { level: 0 },
      flags: { [SCOPE]: { chipGranted: true } },
    }]);
    await a.createEmbeddedDocuments("Item", [{
      name: "__PW__PerfTrained", type: "skill", system: { level: 3 },
      flags: { [SCOPE]: { chipGranted: true } },
    }]);
    return a;
  };
  const chipActors = [await mkChipActor(1), await mkChipActor(2)];
  for (const a of chipActors) await CG.applyChipGrants(a);
  out.chipPass = chipActors.map(a => {
    const live = game.actors.get(a.id);
    const byName = (n) => live.items.find(i => i.name === n);
    const granted = byName("__PW__PerfGranted");
    const trained = byName("__PW__PerfTrained");
    return {
      grantedExists: !!granted,
      grantedLevel: Number(granted?.system?.level ?? -1),
      grantedFlag: granted?.getFlag(SCOPE, "chipGranted") === true,
      orphanPruned: !byName("__PW__PerfOrphan"),
      trainedKept: !!trained,
      trainedUnflagged: trained ? !trained.getFlag(SCOPE, "chipGranted") : false,
    };
  });
  // The shared map is still the same instance after a pass that used it per actor.
  out.indexMapAfter = (await CG.skillIndexNamesById()) === mapA;
  for (const a of chipActors) await a.delete().catch(() => {});

  // Both migrations belong COMPLETE on this world.
  await setFleshFlag(true);
  await setRadFlag(true);
  out.finalFlags = { flesh: game.settings.get(SCOPE, "fleshLimbStatusMigrated"), rad: game.settings.get(SCOPE, "radZonesMigrated") };
  out.leftovers = {
    actors: game.actors.filter(a => a.name.startsWith("__PW__Perf")).length,
    scenes: game.scenes.filter(s => s.name.startsWith("__PW__Perf")).length,
    tokens: scene.tokens.filter(t => t.name.startsWith("__PW__Perf")).length,
  };
  return out;
});

console.log(JSON.stringify(r, null, 1));
console.log("announced:", announced.length, announced.slice(0, 2));

const reRunNamed = (rx) => announced.some(t => rx.test(t) && /game\.modules\.get\("cp2020-augmented"\)\.api\.migrations\./.test(t));
const checks = [
  ["api: both migrations exposed as functions", r.apiShape.flesh === "function" && r.apiShape.rad === "function"],
  ["api: module.api and game.cpAugmented are the same surface", r.apiShape.sameOnGlobal === true],

  ["S7 fixture: the zone carries no structural pool (so the entry must move)", r.fleshBefore.structuralPool === 0 && r.fleshBefore.limbStatus?.rArm === "crippled"],
  ["S7 stopped run: the sweep ran and the completion stamp is set anyway", r.s7Failed.swept === true && r.s7Failed.flagAfter === true],
  ["S7 stopped run: reported loudly, naming the re-run entry point", reRunNamed(/flesh-limb-status/)],
  ["S7 boot path after the stamp: no token read at all", r.s7Gated.reads === 0 && r.s7Gated.flagAfter === true],
  ["S7 clean run: sweeps, moves rArm to the flesh key, stamps done", r.s7Clean.reads > 0 && r.s7Clean.flagAfter === true && r.s7Clean.fleshLimbStatus?.rArm === "crippled" && r.s7Clean.limbStatus?.rArm === undefined],

  ["R9 behavior type is registered on this core", r.behaviorRegistered === true],
  ["R9 fixture: region starts tagged, with no behavior", r.r9Before.hasBehavior === false && r.r9Before.legacyTag === true],
  ["R9 clean run: behavior added with the tagged values, tag dropped, stamp set", r.r9Clean.flagAfter === true && r.r9Clean.region.hasBehavior === true && r.r9Clean.region.formula === "2d6" && r.r9Clean.region.source === "__PW__ reactor" && !r.r9Clean.region.legacyTag],
  ["R9 stamp gates the sweep: a later-tagged region is left alone", r.r9Gated.hasBehavior === false && r.r9Gated.legacyTag === true],
  ["R9 manual re-run picks that region up (1d10 carried over)", r.r9Rerun.hasBehavior === true && r.r9Rerun.formula === "1d10"],
  ["R9 stopped run: the completion stamp is set anyway, region left as it was", r.r9Failed.flagAfter === true && r.r9Failed.stillTagged === true],
  ["R9 probe removed from the fixture collection", r.r9RestoredCollection === true],
  ["R9 stopped run: reported loudly, naming the re-run entry point", reRunNamed(/rad-zone/)],

  ["S3 stand-in applier resolves without consulting the actor", r.applierCheck.someoneElse === true && r.applierCheck.forActor === false],
  ["S3 control: an idle window of the same length touches the token 0 times", r.s3Idle.resolves === 0 && r.s3Idle.writes === 0],
  ["S3 non-applier: 0 token reads and 0 token writes on canvasReady", r.s3NonApplier.resolves === 0 && r.s3NonApplier.writes === 0],
  ["S3 applier check restored for this client", r.applierRestored.someoneElse === false && r.applierRestored.activeGmIsMe === true],
  ["S3 applier: the same call still reads tokens and writes the emitter light 8/16", r.s3Applier.resolves > 0 && r.s3Applier.writes > 0 && r.s3Applier.bright === 8 && r.s3Applier.dim === 16],
  ["S3 probes removed (write path + activeGM back to the real ones)", r.s3ProbesRestored.updateRestored === true && r.s3ProbesRestored.activeGmRestored === true],

  ["index map: one shared Map across calls, populated", r.indexMap.same === true && r.indexMap.isMap === true && r.indexMap.size > 0],
  ["index map: still the same instance after the per-actor passes", r.indexMapAfter === true],
  ["chip pass actor 1: creates the named skill at level 0 + flagged, prunes the untrained orphan, keeps+unflags the trained one",
    r.chipPass[0].grantedExists === true && r.chipPass[0].grantedLevel === 0 && r.chipPass[0].grantedFlag === true
    && r.chipPass[0].orphanPruned === true && r.chipPass[0].trainedKept === true && r.chipPass[0].trainedUnflagged === true],
  ["chip pass actor 2: identical values from the shared map",
    r.chipPass[1].grantedExists === true && r.chipPass[1].grantedLevel === 0 && r.chipPass[1].grantedFlag === true
    && r.chipPass[1].orphanPruned === true && r.chipPass[1].trainedKept === true && r.chipPass[1].trainedUnflagged === true],

  ["both migration stamps left complete on this world", r.finalFlags.flesh === true && r.finalFlags.rad === true],
  ["fixtures cleaned up", r.leftovers.actors === 0 && r.leftovers.scenes === 0 && r.leftovers.tokens === 0],
  ["exactly the two provoked reports, no others", announced.length === 2],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
console.log(`${checks.length - fail}/${checks.length}`);
await b.close();
process.exit(fail ? 1 : 0);
