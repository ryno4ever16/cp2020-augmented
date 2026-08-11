/** P4 vision upgrades (Q1c/Q5): the mode-table fidelity split (thermograph = basic + heat sense,
 *  IR = heat sense only, no terrain — a twin of thermograph), the heat-sense detection mode's living gate, the UV illuminator
 *  dependency chain (corrections → requiresItem → gating), the Q5 governor picker (auto / natural /
 *  device), and the token detection-mode apply/restore round-trip. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

/**
 * Session health gate: some headless sessions come up with a WEDGED canvas draw pipeline — new
 * token placeables never draw, and every token-document update then hangs in that client's
 * refresh chain (diagnosed 2026-07-06: socket fine, server fine, fresh sessions fine). Such a
 * session can't evaluate token behavior at all, so it is detected up front with a canary token
 * and retried in a fresh browser (bounded); the assertions themselves are never relaxed.
 */
let b, p;
const errors = [];
const warns = [];
for (let attempt = 1; attempt <= 3; attempt++) {
  b = await chromium.launch({ headless: true });
  p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  errors.length = 0; warns.length = 0;
  p.on("pageerror", e => errors.push("pageerror: " + e.message));
  p.on("console", m => {
    if (m.type() === "error") errors.push("console: " + m.text());
    if (m.type() === "warning" && /cp2020-augmented\s*\|/.test(m.text())) warns.push(m.text());
  });
  await joinGM(p);
  // Token work needs the CANVAS, not just game.ready.
  await p.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 60000 });
  const healthy = await p.evaluate(async () => {
    const sleep = (ms) => new Promise(res => setTimeout(res, ms));
    const scene = game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
    const actor = await Actor.create({ name: "__PW__Canary", type: "character" });
    const [tok] = await scene.createEmbeddedDocuments("Token", [{ name: "canary", actorId: actor.id, actorLink: true, x: 200, y: 200 }]);
    let drawn = false;
    for (let i = 0; i < 20 && !drawn; i++) { drawn = !!canvas.tokens.get(tok.id); await sleep(250); }
    await scene.deleteEmbeddedDocuments("Token", [tok.id]).catch(() => {});
    await actor.delete().catch(() => {});
    return drawn;
  });
  if (healthy) break;
  console.log(`  (session ${attempt}: canvas draw pipeline wedged — retrying in a fresh browser)`);
  await b.close();
  if (attempt === 3) { console.log("FAIL  session health: canvas never drew a canary token in 3 sessions"); process.exit(1); }
}

const r = await p.evaluate(async () => {
  const out = {};
  const V = await import("/modules/cp2020-augmented/module/mech/vision.js");
  const SCOPE = "cp2020-augmented";
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  // ── (0) PURE: mode table, living gate, illuminator gate, governor picker ──
  out.table = {
    thermo: V.MODE_TABLE.thermograph,
    ir: V.MODE_TABLE.infrared,
    low: V.MODE_TABLE.lowlight,
    uv: V.MODE_TABLE.uv,
    thermoResolved: V.resolveVisionMode("thermograph"),
    irResolved: V.resolveVisionMode("infrared")
  };
  out.living = {
    character: V.isLivingActor({ type: "character", flags: {} }),
    npc: V.isLivingActor({ type: "npc", flags: {} }),
    vehicle: V.isLivingActor({ type: "cp2020-augmented.vehicle", flags: {} }),
    flagOff: V.isLivingActor({ type: "character", flags: { [SCOPE]: { living: false } } }),
    flagOn: V.isLivingActor({ type: "cp2020-augmented.vehicle", flags: { [SCOPE]: { living: true } } })
  };
  const mkIllum = (over = {}, sys = {}) => ({ id: "i1", type: "misc", name: "IR Flash",
    system: { equipped: true, ...sys }, ...over });
  out.illum = {
    empty: V.illuminatorSatisfied("", []),
    met: V.illuminatorSatisfied("IR/UV Flashlight|IR Flash", [mkIllum()]),
    unequipped: V.illuminatorSatisfied("IR Flash", [mkIllum({}, { equipped: false })]),
    emitterDark: V.illuminatorSatisfied("IR Flash", [mkIllum({}, { mechLight: { enabled: true, on: false } })]),
    emitterLit: V.illuminatorSatisfied("IR Flash", [mkIllum({}, { mechLight: { enabled: true, on: true } })]),
    cyberOff: V.illuminatorSatisfied("IR Flash", [{ id: "c", type: "cyberware", name: "IR Flash",
      system: { equipped: true, EffectMode: "Activatable", EffectActive: false } }])
  };
  const dev = (id, mode, range, extra = {}) => ({ id, type: "misc", name: "Dev " + id,
    system: { equipped: true, mechVision: { enabled: true, on: true, mode, range, requiresItem: "", ...extra } } });
  const uvDev = dev("u1", "uv", 20, { requiresItem: "IR Flash" });
  out.uvGate = {
    unmet: V.isViewing(uvDev, [uvDev]),
    met: V.isViewing(uvDev, [uvDev, mkIllum()])
  };
  const set = [dev("a", "infrared", 30), dev("b", "lowlight", 40)];
  out.pick = {
    auto: V.desiredVisionFor(set, "").itemId,
    natural: V.desiredVisionFor(set, "natural"),
    chosen: V.desiredVisionFor(set, "a").itemId,
    staleFallsBack: V.desiredVisionFor(set, "zzz").itemId
  };

  // ── (1) Detection mode registration + living gate on real tokens ──────────
  const mode = CONFIG.Canvas.detectionModes[V.HEAT_SENSE_ID];
  const DM = foundry?.canvas?.perception?.DetectionMode ?? globalThis.DetectionMode;
  out.dm = { exists: !!mode, walls: mode?.walls, typeSight: mode?.type === DM?.DETECTION_TYPES?.SIGHT };

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Vis"))) await a.delete().catch(() => {});
  const punk = await Actor.create({ name: "__PW__VisSeer", type: "character" });
  const prey = await Actor.create({ name: "__PW__VisPrey", type: "npc" });
  const bot = await Actor.create({ name: "__PW__VisBot", type: "npc" });
  await bot.setFlag(SCOPE, "living", false);
  const scene = game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
  // ⚠ createEmbeddedDocuments return order is NOT input order (the documented multi-create
  // lesson) — create singly so each variable is its own token for certain.
  const [seerTokDoc] = await scene.createEmbeddedDocuments("Token", [{ name: "seer", actorId: punk.id, actorLink: true, x: 500, y: 500 }]);
  const [preyTok] = await scene.createEmbeddedDocuments("Token", [{ name: "prey", actorId: prey.id, actorLink: true, x: 700, y: 500 }]);
  const [botTok] = await scene.createEmbeddedDocuments("Token", [{ name: "bot", actorId: bot.id, actorLink: true, x: 900, y: 500 }]);
  const toks = [seerTokDoc, preyTok, botTok];
  // The layer draw of new placeables is async and can lag behind document creation in headless
  // runs. Prefer the properly-drawn placeable (poll); force-instantiate via TokenDocument#object
  // only as a last resort — the living-gate check needs the instance, not a finished draw.
  let objOf = (td) => canvas.tokens.get(td.id);
  for (let i = 0; i < 20 && !(objOf(preyTok) && objOf(botTok)); i++) await sleep(250);
  if (!(objOf(preyTok) && objOf(botTok))) objOf = (td) => canvas.tokens.get(td.id) ?? td.object;
  out.canDetect = {
    placeablesDrawn: !!(objOf(preyTok) && objOf(botTok)),
    living: mode?._canDetect({}, objOf(preyTok)) === true,
    machineFlag: mode?._canDetect({}, objOf(botTok)) === false,
    nonToken: mode?._canDetect({}, {}) === false
  };

  // ── (2) Token apply/restore: thermograph + IR detection entries ───────────
  const seerTok = toks[0];
  const baseSight = foundry.utils.deepClone(seerTok._source.sight);
  const [thermo] = await punk.createEmbeddedDocuments("Item", [{ name: "__PW__ThermoVisor", type: "misc",
    system: { equipped: true, mechVision: { enabled: true, on: false, mode: "thermograph", range: 25, requiresItem: "" } } }]);
  const L = await import("/modules/cp2020-augmented/module/mech/light.js");
  // Poll for the applied write instead of a fixed sleep (the applier runs async through the
  // per-actor queue); capture the gate states for diagnosis if it never lands.
  const waitApplied = async (test, ms = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (test()) return Date.now() - t0; await sleep(250); }
    return -1;
  };
  // detectionModes is a keyed map on v14 (TypedObjectField) and an array on v13 — read both.
  const det = () => {
    const src = seerTok._source.detectionModes;
    if (Array.isArray(src)) return src.find(d => d?.id === V.HEAT_SENSE_ID) ?? null;
    return src?.[V.HEAT_SENSE_ID] ?? null;
  };
  await thermo.update({ "system.mechVision.on": true });
  // Thermograph is heat-only (terrainSight false) → sight.range stays 0; poll the parts the apply
  // DOES write: our heat-sense detection entry + the stored base-sight flag.
  const tApply = await waitApplied(() => !!det() && seerTok.getFlag(SCOPE, "mechBaseSight") !== undefined);
  out.applyDiag = { tApply, tokensOf: L.tokensOf(punk).length,
    gmMatch: game.users.activeGM?.id === game.user.id,
    socket: game.socket?.connected ?? null,
    desired: V.desiredVisionFor(punk.items.contents, "")?.mode ?? null };
  await sleep(300);
  out.thermoApply = {
    visionMode: seerTok._source.sight.visionMode,
    range: seerTok._source.sight.range,
    heatEntry: det()
  };
  await thermo.update({ "system.mechVision.mode": "infrared" }); await sleep(1500);
  out.irApply = { visionMode: seerTok._source.sight.visionMode, heatEntry: det() };
  await thermo.update({ "system.mechVision.on": false }); await sleep(1500);
  out.restore = {
    sightBack: JSON.stringify(seerTok._source.sight) === JSON.stringify(baseSight),
    heatGone: det() === null,
    flagsGone: seerTok.getFlag(SCOPE, "mechBaseSight") === undefined
  };

  // ── (3) UV illuminator chain through the corrections layer ────────────────
  const uvSrc = await game.packs.get("cyberpunk2020.cyberoptic").getDocument("XG6ffmsWnkUWNkcW");
  const [uv] = await punk.createEmbeddedDocuments("Item", [game.items.fromCompendium(uvSrc)]);
  await uv.update({ "system.equipped": true, "system.mechVision.on": true }); await sleep(1500);
  out.uvChain = {
    requiresItem: uv.system.mechVision?.requiresItem ?? "",
    blockedWithoutIlluminator: seerTok._source.sight.visionMode === baseSight.visionMode
  };
  const illumSrc = await game.packs.get("cyberpunk2020.cyberware-old").getDocument("atR26dOPGVwYD9nv");
  const [illum] = await punk.createEmbeddedDocuments("Item", [game.items.fromCompendium(illumSrc)]);
  await illum.update({ "system.equipped": true }); await sleep(1500);
  out.uvLit = { visionMode: seerTok._source.sight.visionMode, illumName: illum.name };

  // ── (4) Q5 picker: auto → device pick → natural → auto ────────────────────
  await thermo.update({ "system.mechVision.on": true, "system.mechVision.mode": "thermograph", "system.mechVision.range": 25 });
  await sleep(1500);
  // Two devices on: UV (range 20, darkvision) + thermograph (25, basic+heat). Auto = longest (25).
  out.pickAuto = { visionMode: seerTok._source.sight.visionMode, range: seerTok._source.sight.range, heat: !!det() };
  await punk.setFlag(SCOPE, "visionPick", uv.id); await sleep(1500);
  out.pickDevice = { visionMode: seerTok._source.sight.visionMode, range: seerTok._source.sight.range, heat: !!det() };
  await punk.setFlag(SCOPE, "visionPick", "natural"); await sleep(1500);
  out.pickNatural = {
    sightBack: JSON.stringify(seerTok._source.sight) === JSON.stringify(baseSight),
    heatGone: det() === null
  };
  await punk.unsetFlag(SCOPE, "visionPick"); await sleep(1500);
  // auto re-picks the thermograph (longest device): sight radius 0 but the heat entry is back —
  // the heat entry is what distinguishes "auto → thermograph" from "no override".
  out.pickBackToAuto = { range: seerTok._source.sight.range, heat: !!det(), overridden: seerTok.getFlag(SCOPE, "mechBaseSight") !== undefined };

  // ── (5) Sheet surfaces: picker select + living checkbox ───────────────────
  await punk.sheet.render(true); await sleep(900);
  const root = punk.sheet.element;
  const sel = root?.querySelector("select.cp-vision-pick");
  out.sheet = {
    pickerPresent: !!sel,
    pickerOptions: sel ? sel.options.length : 0,
    livingBox: !!root?.querySelector('input[name="flags.cp2020-augmented.living"]'),
    livingChecked: !!root?.querySelector('input[name="flags.cp2020-augmented.living"]')?.checked
  };
  await punk.sheet.close().catch(() => {});

  await scene.deleteEmbeddedDocuments("Token", toks.map(t => t.id)).catch(() => {});
  for (const a of [punk, prey, bot]) await a.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["pure: thermograph = basic vision + heat sense", r.table.thermo.heat === true && r.table.thermoResolved === "basic"],
  ["pure: infrared = heat sense only, no terrain sight", r.table.ir.heat === true && r.table.ir.terrainSight === false && r.table.irResolved === "basic"],
  ["pure: lowlight/uv carry no heat sense", r.table.low.heat === false && r.table.uv.heat === false],
  ["pure: living defaults by actor type", r.living.character === true && r.living.npc === true && r.living.vehicle === false],
  ["pure: living flag overrides the type default", r.living.flagOff === false && r.living.flagOn === true],
  ["pure: illuminator gate — empty dependency is satisfied", r.illum.empty === true],
  ["pure: illuminator gate — pipe list matches by exact name", r.illum.met === true],
  ["pure: illuminator gate — unequipped/dark/switched-off excluded", r.illum.unequipped === false && r.illum.emitterDark === false && r.illum.cyberOff === false],
  ["pure: illuminator gate — lit emitter satisfies", r.illum.emitterLit === true],
  ["pure: uv device inactive without its illuminator, active with it", r.uvGate.unmet === false && r.uvGate.met === true],
  ["pure: governor pick — auto longest / natural null / id chosen / stale falls back", r.pick.auto === "b" && r.pick.natural === null && r.pick.chosen === "a" && r.pick.staleFallsBack === "b"],
  ["detection mode registered (wall-blocked, sight-type)", r.dm.exists === true && r.dm.walls === true && r.dm.typeSight === true],
  ["detection gate on real tokens: living yes, flagged machine no, non-token no", r.canDetect.placeablesDrawn === true && r.canDetect.living === true && r.canDetect.machineFlag === true && r.canDetect.nonToken === true],
  ["apply: thermograph → basic vision, NO darkness-sight radius, heat entry at device range", r.thermoApply.visionMode === "basic" && r.thermoApply.range === 0 && r.thermoApply.heatEntry?.range === 25 && r.thermoApply.heatEntry?.enabled === true],
  ["apply: infrared → basic vision (heat-only) + heat entry", r.irApply.visionMode === "basic" && !!r.irApply.heatEntry],
  ["restore: sight + detection modes + flags all back to base", r.restore.sightBack === true && r.restore.heatGone === true && r.restore.flagsGone === true],
  ["corrections: UV optic carries the illuminator dependency", /IR\/UV Flashlight\|IR Flash/.test(r.uvChain.requiresItem)],
  ["uv device alone does not override sight", r.uvChain.blockedWithoutIlluminator === true],
  ["equipping an illuminator activates the uv device (darkvision)", r.uvLit.visionMode === "darkvision"],
  ["picker: auto governs by longest range (heat device wins, no sight radius)", r.pickAuto.range === 0 && r.pickAuto.visionMode === "basic" && r.pickAuto.heat === true],
  ["picker: explicit device pick governs (uv, no heat)", r.pickDevice.range === 20 && r.pickDevice.visionMode === "darkvision" && r.pickDevice.heat === false],
  ["picker: natural suspends overrides while devices stay on", r.pickNatural.sightBack === true && r.pickNatural.heatGone === true],
  ["picker: unset returns to auto (thermograph governs: heat back, overridden, no sight radius)", r.pickBackToAuto.range === 0 && r.pickBackToAuto.heat === true && r.pickBackToAuto.overridden === true],
  ["sheet: picker select present with auto/natural + devices", r.sheet.pickerPresent === true && r.sheet.pickerOptions >= 4],
  ["sheet: living checkbox present and defaulted on for a character", r.sheet.livingBox === true && r.sheet.livingChecked === true],
  ["0 console errors", errors.length === 0]
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
if (warns.length) console.log("module warns:", warns.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
