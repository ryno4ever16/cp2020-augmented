/** Loadout materialization (Parts 1+2 of the borg batch): the pure manifest/item-data helpers, and
 *  the install→materialize→prune→re-install→delete lifecycle on a real actor. A body carrying a
 *  `loadout` manifest auto-creates its options as real cyberware (equipped, zoned, parented via Q6
 *  Module.ParentId) on install, and removes exactly them on uninstall/delete. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = {};
  const L = await import("/modules/cp2020-augmented/module/mech/loadout.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  // ── (0) PURE ──────────────────────────────────────────────────────────────
  const withM = { flags: { "cp2020-augmented": { loadout: [{ name: "x", mountZone: "Head" }] } } };
  out.pure = {
    hasWith: L.hasLoadout(withM),
    hasWithout: L.hasLoadout({ flags: {} }),
    hasEmpty: L.hasLoadout({ flags: { "cp2020-augmented": { loadout: [] } } }),
    manifestLen: L.loadoutManifestOf(withM).length,
    eqOn: L.equippedChange({ system: { equipped: true } }),
    eqOff: L.equippedChange({ system: { equipped: false } }),
    eqNull: L.equippedChange({ system: { foo: 1 } }),
  };
  const data = L.loadoutItemData({ name: "Opt", mountZone: "Arm", side: "Right", cyberwareType: "CyberArm", humanityCost: "2", description: "d" }, "BODY123");
  const dataMech = L.loadoutItemData({ name: "OptV", mountZone: "Head", mech: { mechVision: { enabled: true, on: false, mode: "lowlight", range: 20, requiresItem: "" } } }, "BODY123");
  out.pure.mechRide = dataMech.system?.mechVision?.enabled === true && dataMech.system?.mechVision?.mode === "lowlight";
  out.pureData = {
    type: data.type, equipped: data.system.equipped === true, zone: data.system.MountZone,
    bodyType: data.system.CyberBodyType.Type, side: data.system.CyberBodyType.Location,
    parent: data.system.Module.ParentId, hloss: Number(data.system.humanityLoss) || 0,
    cost: Number(data.system.cost) || 0, src: data.flags["cp2020-augmented"].loadoutSource,
  };

  // ── (1) Lifecycle on a real actor ───────────────────────────────────────────
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Loadout"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__LoadoutPunk", type: "character" });
  const MANIFEST = [
    { name: "__PW__Optic", mountZone: "Head", cyberwareType: "CyberOptic", humanityCost: "3", description: "test optic" },
    { name: "__PW__ArmMount", mountZone: "Arm", side: "Right", cyberwareType: "CyberArm", humanityCost: "2" },
    { name: "__PW__LegMount", mountZone: "Leg", side: "Left", cyberwareType: "CyberLeg", humanityCost: "2" },
    { name: "__PW__Neural", mountZone: "Nervous", humanityCost: "1" },
  ];
  const [body] = await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__Body", type: "cyberware",
    system: { equipped: false, EffectMode: "Permanent", EffectActive: false, CyberWorkType: {}, CyberBodyType: {}, Module: {} },
    flags: { "cp2020-augmented": { loadout: MANIFEST } },
  }]);
  const opts = (bid) => actor.items.filter(i => i.getFlag("cp2020-augmented", "loadoutSource") === bid);

  out.beforeInstall = { count: opts(body.id).length };   // 0 — created equipped:false, nothing materialized

  await body.update({ "system.equipped": true }); await sleep(1400);
  const optic = opts(body.id).find(i => i.name === "__PW__Optic");
  const arm = opts(body.id).find(i => i.name === "__PW__ArmMount");
  const leg = opts(body.id).find(i => i.name === "__PW__LegMount");
  out.installed = {
    count: opts(body.id).length,
    installedFlag: body.getFlag("cp2020-augmented", "loadoutInstalled") === true,
    opticZone: optic?.system?.MountZone,
    opticEquipped: optic?.system?.equipped === true,
    opticParent: optic?.system?.Module?.ParentId === body.id,
    opticHLoss: Number(optic?.system?.humanityLoss) || 0,     // never re-charged
    opticType: optic?.system?.cyberwareType,
    armZone: arm?.system?.MountZone, armSide: arm?.system?.CyberBodyType?.Location,
    legZone: leg?.system?.MountZone, legSide: leg?.system?.CyberBodyType?.Location,
  };

  // Idempotent: an explicit second materialize (or a re-render) must not duplicate (loadoutInstalled guard).
  await L.materializeLoadout(body); await sleep(400);
  out.idempotent = { count: opts(body.id).length };

  // Uninstall PRESERVES the options (non-destructive): they are KEPT but UNEQUIPPED (→ carried), and
  // the guard is KEPT so a re-install doesn't re-materialize duplicates.
  await body.update({ "system.equipped": false }); await sleep(1400);
  const unopts = opts(body.id);
  out.uninstalled = {
    count: unopts.length,                                              // 4 — kept, not deleted
    allUnequipped: unopts.every(i => i.system?.equipped !== true),
    flagKept: body.getFlag("cp2020-augmented", "loadoutInstalled") === true,
  };

  // Re-install → guard held ⇒ no re-materialize; the carried options remain, no duplicates.
  await body.update({ "system.equipped": true }); await sleep(1400);
  out.reinstalled = { count: opts(body.id).length };                   // still 4 (no dupes)

  // Delete the body → the ATTACHED (equipped) options go with the destroyed chassis, but options the
  // player shelved to Carried SURVIVE (never destroy carried chrome). Re-equip 2 of the 4 carried
  // options, leave 2 carried, then delete: expect the 2 attached gone and the 2 carried kept.
  const bid = body.id;
  const carriedNow = actor.items.filter(i => i.getFlag("cp2020-augmented", "loadoutSource") === bid);
  await actor.updateEmbeddedDocuments("Item", carriedNow.slice(0, 2).map(i => ({ _id: i.id, "system.equipped": true })));
  await sleep(400);
  await body.delete(); await sleep(1400);
  const survivors = actor.items.filter(i => i.getFlag("cp2020-augmented", "loadoutSource") === bid);
  out.deleted = { count: survivors.length, allCarried: survivors.every(i => i.system?.equipped !== true) };

  // ── (1b) NESTED manifest: a container option (a Front Optic Mount) whose child options parent to the
  //         MOUNT, not the body (the borg optic-mount → optics structure). Same shape as the Dragoon. ──
  const nestActor = await Actor.create({ name: "__PW__LoadoutNest", type: "character" });
  const NESTED = [
    { key: "mount", name: "__PW__Mount", mountZone: "Head", cyberwareType: "CyberOptic", types: ["Implant"], optionsAvailable: 3 },
    { parentKey: "mount", name: "__PW__OpticA", mountZone: "Head", cyberwareType: "CyberOptic", isModule: true, allowedParent: "CyberOptic" },
    { parentKey: "mount", name: "__PW__OpticB", mountZone: "Head", cyberwareType: "CyberOptic", isModule: true, allowedParent: "CyberOptic" },
  ];
  const [nbody] = await nestActor.createEmbeddedDocuments("Item", [{
    name: "__PW__NestBody", type: "cyberware",
    system: { equipped: false, EffectMode: "Permanent", EffectActive: false, CyberWorkType: {}, CyberBodyType: {}, Module: {} },
    flags: { "cp2020-augmented": { loadout: NESTED } },
  }]);
  await nbody.update({ "system.equipped": true }); await sleep(1400);
  const nopts = nestActor.items.filter(i => i.getFlag("cp2020-augmented", "loadoutSource") === nbody.id);
  const mount = nopts.find(i => i.name === "__PW__Mount");
  const oA = nopts.find(i => i.name === "__PW__OpticA");
  out.nested = {
    count: nopts.length,                                                    // 3 (mount + 2 optics)
    mountIsContainer: Number(mount?.system?.CyberWorkType?.OptionsAvailable) === 3,
    mountNotModule: !mount?.system?.Module?.IsModule,
    mountParentBody: mount?.system?.Module?.ParentId === nbody.id,          // mount → body
    opticParentMount: oA?.system?.Module?.ParentId === mount?.id,           // optic → the MOUNT, not the body
    opticIsModule: oA?.system?.Module?.IsModule === true,
    opticSourceBody: oA?.getFlag("cp2020-augmented", "loadoutSource") === nbody.id,  // membership still the body
  };
  await nestActor.delete().catch(() => {});

  // ── (1c) MIXED boom manifest: a container with acceptsTypes holds a typed optic AND a typed audio
  //         child, and the children INHERIT the boom's zone/side (a Torso shoulder boom's contents live
  //         in the Torso zone with it — the Spyder shoulder-boom structure). ──
  const boomActor = await Actor.create({ name: "__PW__LoadoutBoom", type: "character" });
  const BOOMED = [
    { key: "boom", name: "__PW__Boom", mountZone: "Torso", types: ["Implant"], optionsAvailable: 3, acceptsTypes: ["CyberOptic", "CyberAudio"] },
    { parentKey: "boom", name: "__PW__BoomOptic", mountZone: "Head", cyberwareType: "CyberOptic", isModule: true, allowedParent: "CyberOptic" },
    { parentKey: "boom", name: "__PW__BoomAudio", mountZone: "Head", cyberwareType: "CyberAudio", isModule: true, allowedParent: "CyberAudio" },
  ];
  const [bbody] = await boomActor.createEmbeddedDocuments("Item", [{
    name: "__PW__BoomBody", type: "cyberware",
    system: { equipped: false, EffectMode: "Permanent", EffectActive: false, CyberWorkType: {}, CyberBodyType: {}, Module: {} },
    flags: { "cp2020-augmented": { loadout: BOOMED } },
  }]);
  await bbody.update({ "system.equipped": true }); await sleep(1400);
  const bopts = boomActor.items.filter(i => i.getFlag("cp2020-augmented", "loadoutSource") === bbody.id);
  const boomIt = bopts.find(i => i.name === "__PW__Boom");
  const bOpt = bopts.find(i => i.name === "__PW__BoomOptic");
  const bAud = bopts.find(i => i.name === "__PW__BoomAudio");
  out.boom = {
    count: bopts.length,                                                      // 3 (boom + optic + audio)
    acceptsOnItem: JSON.stringify(boomIt?.system?.CyberWorkType?.AcceptsTypes) === '["CyberOptic","CyberAudio"]',
    opticParentBoom: bOpt?.system?.Module?.ParentId === boomIt?.id,
    audioParentBoom: bAud?.system?.Module?.ParentId === boomIt?.id,
    opticZoneFollowsBoom: bOpt?.system?.MountZone === "Torso",                // spec said Head; the boom's zone wins
    audioZoneFollowsBoom: bAud?.system?.MountZone === "Torso",
    opticKeepsFamily: bOpt?.system?.Module?.AllowedParentCyberwareType === "CyberOptic",  // truthful typing survives
  };
  await boomActor.delete().catch(() => {});

  // ── (2) Negative: a body with NO manifest materializes nothing ──────────────
  const [plain] = await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__Plain", type: "cyberware",
    system: { equipped: false, EffectMode: "Permanent", EffectActive: false, CyberWorkType: {}, CyberBodyType: {}, Module: {} },
  }]);
  await plain.update({ "system.equipped": true }); await sleep(800);
  out.negative = { count: actor.items.filter(i => i.getFlag("cp2020-augmented", "loadoutSource") === plain.id).length };

  await actor.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["pure: hasLoadout true w/ manifest, false w/o, false when empty", r.pure.hasWith === true && r.pure.hasWithout === false && r.pure.hasEmpty === false],
  ["pure: manifest length read", r.pure.manifestLen === 1],
  ["pure: equippedChange on/off/null", r.pure.eqOn === "on" && r.pure.eqOff === "off" && r.pure.eqNull === null],
  ["pure: loadoutItemData shape (equipped, zone, side, parent, HL0, cost0, source)",
    r.pureData.type === "cyberware" && r.pureData.equipped === true && r.pureData.zone === "Arm"
    && r.pureData.bodyType === "Arm" && r.pureData.side === "Right" && r.pureData.parent === "BODY123"
    && r.pureData.hloss === 0 && r.pureData.cost === 0 && r.pureData.src === "BODY123"],
  ["pure: a spec's mech payload rides onto the created item verbatim", r.pure.mechRide === true],
  ["e2e: nothing materialized before install", r.beforeInstall.count === 0],
  ["e2e: install materializes all 4 options + sets the guard", r.installed.count === 4 && r.installed.installedFlag === true],
  ["e2e: option lands in its zone, equipped, parented, Humanity not re-charged",
    r.installed.opticZone === "Head" && r.installed.opticEquipped === true && r.installed.opticParent === true
    && r.installed.opticHLoss === 0 && r.installed.opticType === "CyberOptic"],
  ["e2e: sided limb options carry zone + Left/Right (cyberZones buckets by these)",
    r.installed.armZone === "Arm" && r.installed.armSide === "Right" && r.installed.legZone === "Leg" && r.installed.legSide === "Left"],
  ["e2e: second materialize does not duplicate (idempotent)", r.idempotent.count === 4],
  ["e2e: uninstall PRESERVES the options (kept, unequipped) + keeps the guard", r.uninstalled.count === 4 && r.uninstalled.allUnequipped === true && r.uninstalled.flagKept === true],
  ["e2e: re-install does not duplicate the carried options (guard held)", r.reinstalled.count === 4],
  ["e2e: deleting the body removes ATTACHED options but keeps CARRIED ones (2 shelved survive)", r.deleted.count === 2 && r.deleted.allCarried === true],
  ["e2e: NESTED manifest — a mount container holds its optics (optics parent to the MOUNT; membership stays the body)", r.nested.count === 3 && r.nested.mountIsContainer === true && r.nested.mountNotModule === true && r.nested.mountParentBody === true && r.nested.opticParentMount === true && r.nested.opticIsModule === true && r.nested.opticSourceBody === true],
  ["e2e: MIXED boom manifest — acceptsTypes lands on the container, both families nest under it, children inherit the boom's zone, typing stays truthful", r.boom.count === 3 && r.boom.acceptsOnItem === true && r.boom.opticParentBoom === true && r.boom.audioParentBoom === true && r.boom.opticZoneFollowsBoom === true && r.boom.audioZoneFollowsBoom === true && r.boom.opticKeepsFamily === true],
  ["e2e: a body with no manifest materializes nothing", r.negative.count === 0],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
