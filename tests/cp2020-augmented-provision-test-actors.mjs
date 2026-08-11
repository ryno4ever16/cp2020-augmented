/**
 * Test-actor PROVISIONER runner + verifier (:30004, official 1.1.1 + module).
 *
 * Runs the standard-process provisioner in the live rig, then reads every created item back and
 * asserts the mech* fields PERSISTED on the misc/cyberware DataModels (the Batch-A assumption: misc
 * items take mechRollMods/mechStatMods/mechVision/mechLight/mechProtection/mechConsumable/mechContainer;
 * cyberware chips take CyberWorkType.ChipSkills). If a field were stripped by the model it would read
 * back undefined and fail here. Leaves the fixtures in place for hands-on testing.
 *
 * Run:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-provision-test-actors.mjs
 */
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
// SINGLE SOURCE of the fixture list: run the durable macro itself rather than a hand-copy that drifts.
const MACRO_PATH = process.env.CP2020_PROVISIONER
  || "C:/Users/randa/AppData/Local/FoundryVTT/Data/modules/cp2020-augmented/import-staging/test-fixtures/provision-test-actors.js";

async function joinAs(page, match, pws) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const s = page.locator('select[name="userid"]');
  await s.waitFor({ state: "visible", timeout: 30000 });
  const us = await s.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  const u = us.find(x => match.test(x.l));
  if (!u) throw new Error("no user matching " + match);
  for (const pw of pws) {
    await s.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([page.waitForNavigation({ url: /\/game/, timeout: 15000 }).catch(() => {}), page.locator('button[name="join"]').click()]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 15000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await s.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("join failed " + u.l);
}

const b = await chromium.launch({ headless: true });
let pass = false; const log = [];
try {
  const gm = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  gm.on("pageerror", e => log.push("PAGEERR " + e.message));
  await joinAs(gm, /gamemaster/i, [GM_PW]);
  await gm.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30000 }).catch(() => {});

  // --- run the REAL provisioner macro (single source: import-staging/test-fixtures/provision-test-actors.js)
  // so this keeper can never drift from the durable macro. It is an idempotent async IIFE using only page
  // globals, so eval-in-page runs it exactly as pasting it into a Foundry Script macro would; the
  // verification below resolves every id it needs by name, so it needs nothing back from the run. ---
  const macroSrc = readFileSync(MACRO_PATH, "utf8");
  await gm.evaluate(async (src) => { await eval(src); }, macroSrc);
  log.push("provisioner macro executed (single-sourced from " + MACRO_PATH.split(/[\\/]/).pop() + ")");

  // --- read back + assert mech* persistence (resolve fixture ids in-page — nothing carried from the run) ---
  const v = await gm.evaluate(() => {
    const pc = game.actors.find(a => a.name === "🧪 Test PC — Wired Gear");
    if (!pc) return { ok: false, why: "Test PC not found", checks: [{ label: "Test PC found", ok: false }] };
    const byTag = t => pc.items.find(i => (i.name || "").includes(t));
    const g = (i, p) => p.split(".").reduce((o, k) => o?.[k], i?.system);
    const pouchId  = byTag("Belt Pouch")?.id ?? "";
    const realArm  = byTag("Cyberarm");        // base "Standard Cyberarm"
    const store    = byTag("Storage Space");
    const realArmId = realArm?.id ?? "";
    const storeId   = store?.id ?? "";
    const checks = [];
    const chk = (label, cond, got) => checks.push({ label, ok: !!cond, got });
    chk("skills present (Diagnose Illness)", pc.items.some(i => i.type === "skill" && /diagnose illness/i.test(i.name)), pc.items.filter(i => i.type === "skill").length + " skills");
    chk("P5 skill: Medscanner Diagnose Illness +2", g(byTag("Medscanner"), "mechRollMods.skillName") === "Diagnose Illness" && g(byTag("Medscanner"), "mechRollMods.skillMod") === 2, JSON.stringify(g(byTag("Medscanner"), "mechRollMods")));
    chk("P5 atk: Scope attackMod +1", g(byTag("Targeting Scope"), "mechRollMods.attackMod") === 1, g(byTag("Targeting Scope"), "mechRollMods.attackMod"));
    chk("Q7 stat: Moddy int +2", g(byTag("Personality Moddy"), "mechStatMods.mods.0.stat") === "int" && g(byTag("Personality Moddy"), "mechStatMods.mods.0.mod") === 2, JSON.stringify(g(byTag("Personality Moddy"), "mechStatMods.mods")));
    chk("P4 vision: Goggles infrared", g(byTag("IR Goggles"), "mechVision.mode") === "infrared" && g(byTag("IR Goggles"), "mechVision.enabled") === true, JSON.stringify(g(byTag("IR Goggles"), "mechVision")));
    chk("P3 light: Flashlight cone enabled", g(byTag("Flashlight"), "mechLight.enabled") === true && g(byTag("Flashlight"), "mechLight.shape") === "cone", JSON.stringify(g(byTag("Flashlight"), "mechLight")));
    chk("P6 protect: Gas Mask gas immune", g(byTag("Gas Mask"), "mechProtection.gas.immune") === true, JSON.stringify(g(byTag("Gas Mask"), "mechProtection.gas")));
    chk("P7 consumable: Stimulant doses 3", g(byTag("Stimulant"), "mechConsumable.doses") === 3, g(byTag("Stimulant"), "mechConsumable.doses"));
    chk("chip: Botany +3 ChipSkills", g(byTag("Skill Chip"), "CyberWorkType.ChipSkills.Botany") === 3, JSON.stringify(g(byTag("Skill Chip"), "CyberWorkType.ChipSkills")));
    chk("Q6 container: pouch capacity 2", g(byTag("Belt Pouch"), "mechContainer.capacity") === 2, g(byTag("Belt Pouch"), "mechContainer.capacity"));
    chk("Q6 child: holdout installedIn the pouch", g(byTag("Holdout Pistol"), "mechContainer.installedIn") === pouchId, g(byTag("Holdout Pistol"), "mechContainer.installedIn"));
    if (realArmId && storeId) {
      chk("real chain: Storage Space installed in the cyberarm", g(store, "Module.ParentId") === realArmId, g(store, "Module.ParentId"));
      chk("real chain: corrections gave Storage Space 2 stowed-item slots", g(store, "CyberWorkType.OptionsAvailable") === 2, g(store, "CyberWorkType.OptionsAvailable"));
      chk("real chain: lockpicks stowed in the Storage Space", g(byTag("Lockpick Set"), "mechContainer.installedIn") === storeId, g(byTag("Lockpick Set"), "mechContainer.installedIn"));
    } else {
      chk("real chain: cyberlimbs pack items found", false, "Standard Cyberarm / Storage Space missing");
    }
    const eyeItem = byTag("Cybereye");
    chk("telescoping host: Cybereye has 3 option slots", g(eyeItem, "CyberWorkType.OptionsAvailable") === 3, g(eyeItem, "CyberWorkType.OptionsAvailable"));
    chk("telescoping child: Low-Lite nested (equipped) in the cybereye", g(byTag("Low-Lite"), "Module.ParentId") === eyeItem?.id && g(byTag("Low-Lite"), "equipped") === true, g(byTag("Low-Lite"), "Module.ParentId"));
    chk("carried option: Image Enhance Optic is carried (unequipped)", g(byTag("Image Enhance"), "equipped") === false, g(byTag("Image Enhance"), "equipped"));
    return { ok: checks.every(c => c.ok), checks };
  });

  for (const c of v.checks || []) log.push(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}  ${c.ok ? "" : "-> got " + c.got}`);

  // --- verify the Test Borg fixture (loadout materialized + FBC stats + chip) ---
  const vb = await gm.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const borg = game.actors.find(a => a.name.startsWith("🦾 Test Borg"));
    const checks = []; const chk = (l, c, g) => checks.push({ label: l, ok: !!c, got: g });
    chk("Test Borg created", !!borg);
    if (borg) {
      const body = borg.items.find(i => i.name === "Dragoon");
      const opts = () => borg.items.filter(x => x.getFlag("cp2020-augmented", "loadoutSource") === body?.id);
      const manifestLen = (body?.getFlag("cp2020-augmented", "loadout") ?? []).length;
      // Materialization is multi-pass — wait for the count to STABILIZE, then assert the EXACT manifest
      // length (a silently dropped spec must fail here, not slide under a floor — testing policy).
      { let last = -1, stable = 0; for (let i = 0; i < 80 && stable < 3; i++) { await sleep(200); const n = opts().length; if (n > 0 && n === last) stable++; else { stable = 0; last = n; } } }
      const zones = {}; for (const o of opts()) { const z = String(o.system?.MountZone || ""); zones[z] = (zones[z] || 0) + 1; }
      chk(`loadout materialized (exactly the ${manifestLen}-spec manifest)`, manifestLen > 0 && opts().length === manifestLen, `${opts().length}/${manifestLen}`);
      chk("options across Head/Arm/Leg/Nervous/Torso", ["Head", "Arm", "Leg", "Nervous", "Torso"].every(z => (zones[z] || 0) > 0), JSON.stringify(zones));
      for (let i = 0; i < 25 && (Number(borg.system?.stats?.ref?.total) || 0) !== 15; i++) await sleep(200);
      chk("FBC stats SET (REF 15 / MA 25 / BODY 20)", borg.system?.stats?.ref?.total === 15 && borg.system?.stats?.ma?.total === 25 && borg.system?.stats?.bt?.total === 20, `${borg.system?.stats?.ref?.total}/${borg.system?.stats?.ma?.total}/${borg.system?.stats?.bt?.total}`);
      chk("borg SDP seeded (Torso 60)", Number(borg.system?.sdp?.sum?.Torso) === 60, borg.system?.sdp?.sum?.Torso);
      const dt = borg.items.find(i => i.name === "Death Trance");
      chk("Death Trance chip typed Chip + active", dt && dt.system?.CyberWorkType?.Type === "Chip" && dt.system?.CyberWorkType?.ChipActive === true, dt ? dt.system?.CyberWorkType?.Type : "missing");
      const carried = opts().filter(o => o.system?.equipped !== true);
      chk("a few options left CARRIED (unequipped) to show the Carried Options area", carried.length >= 3, carried.length);
      chk("a spare chassis is present, uninstalled (to try the one-FBC block)", borg.items.some(i => /spare chassis/.test(i.name) && i.system?.equipped !== true));
    }
    return { ok: checks.every(c => c.ok), checks };
  });
  for (const c of vb.checks || []) log.push(`  ${c.ok ? "PASS" : "FAIL"}  [borg] ${c.label}  ${c.ok ? "" : "-> got " + c.got}`);

  // --- verify the STATUS STRIP renders on the Test PC (drug + addiction + wired-gear pills) ---
  const vs = await gm.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const pc = game.actors.find(a => a.name === "🧪 Test PC — Wired Gear");
    const checks = []; const chk = (l, c, g) => checks.push({ label: l, ok: !!c, got: g });
    if (!pc) { chk("Test PC found", false); return { ok: false, checks }; }
    await pc.sheet.render(true); await sleep(1000);
    const root = pc.sheet.element;
    const details = root?.querySelector("details.cp-status-details");
    chk("status strip is a collapsible <details> (summary shown, collapsed by default)", !!details && !details.open && !!details.querySelector(".cp-status-summary"), details ? `open=${details.open}` : "no details");
    const pills = [...(root?.querySelectorAll(".cp-status-strip .cp-status-pill") || [])];
    const kinds = pills.map(p => [...p.classList].find(c => c.startsWith("cp-kind-")));
    chk("status strip renders pills", pills.length > 0, `${pills.length} pills: ${JSON.stringify(kinds)}`);
    chk("drug pill present", kinds.includes("cp-kind-drug"), JSON.stringify(kinds));
    chk("addiction pill present", kinds.includes("cp-kind-addiction"), JSON.stringify(kinds));
    await pc.sheet.close().catch(() => {});
    return { ok: checks.every(c => c.ok), checks };
  });
  for (const c of vs.checks || []) log.push(`  ${c.ok ? "PASS" : "FAIL"}  [strip] ${c.label}  ${c.ok ? "" : "-> got " + c.got}`);
  pass = v.ok && vb.ok && vs.ok && !log.some(l => l.startsWith("PAGEERR"));
} catch (e) { log.push("ERROR " + (e?.message || e)); }
finally { await b.close(); }

console.log(log.join("\n"));
console.log(pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");
process.exit(pass ? 0 : 1);
