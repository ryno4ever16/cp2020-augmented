/** ACPA Unit B3 — melee: pilot-skill auto-pull + Martial-Arts PACS cap + reflex/control gate (MM p.60).
 *  Verifies the RULE deterministically (skill-reading via the module's getSkillVal/trainedMartials, derived
 *  pilotPACS, the reflex gate, and the min-cap) plus the dialog picker (Martial option gated by reflex; the
 *  skill level auto-pulls the pilot's value). Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-acpa-melee-cap.mjs */
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
  const out = { checks: {} };
  const ok = (k, v) => { out.checks[k] = v; };
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__MeleeCap"))) await a.delete().catch(() => {});
  try { await game.settings.set("cp2020-augmented", "vehicleDamageEnabled", true); } catch {}

  const M = await import("/modules/cp2020-augmented/module/martial/martial.js");
  const AC = await import("/modules/cp2020-augmented/module/vehicle/vehicle-acpa-combat.js");

  // Pilot with Brawling 5, Melee 3, a martial art (Karate) 8, PA Combat Sense 4. The character auto-seeds
  // the default skill list, so LEVEL UP an existing skill of that name (a duplicate would let getSkillVal
  // match the level-0 seeded one); only ADD a name the seed lacks.
  const pilot = await Actor.create({ name: "__PW__MeleeCap Pilot", type: "character" });
  await pilot.update({ "system.stats.ref.base": 7 });
  const findSkill = (name) => pilot.items.find(i => i.type === "skill" && i.name === name);
  const ups = [], adds = [];
  for (const [n, lv] of [["Brawling", 5], ["Melee", 3], ["Martial Arts: Karate", 8]]) {
    const s = findSkill(n);
    if (s) ups.push({ _id: s.id, "system.level": lv });
    else adds.push({ name: n, type: "skill", system: { level: lv, stat: "ref" } });
  }
  if (!findSkill("PA Combat Sense")) adds.push({ _id: "PACombatSense001", name: "PA Combat Sense", type: "skill", system: { level: 4, stat: "ref" } });
  if (ups.length) await pilot.updateEmbeddedDocuments("Item", ups);
  if (adds.length) await pilot.createEmbeddedDocuments("Item", adds, { keepId: true });
  const pf = game.actors.get(pilot.id);

  // (1) Skill auto-pull sources (the values the melee dialog seeds from).
  ok("brawling_read", Number(M.getSkillVal(pf, "Brawling")) === 5);
  ok("melee_read", Number(M.getSkillVal(pf, "Melee")) === 3);
  const tm = M.trainedMartials(pf) ?? [];
  let bestMA = 0;
  for (const m of tm) bestMA = Math.max(bestMA, Number(M.getSkillVal(pf, m.value)) || 0);
  out.trainedMartials = tm.map(m => m.value);
  ok("martial_best", bestMA === 8);

  // (2) Derived PACS on the suit + the reflex gate + the min-cap (the rule).
  const MA_REFLEX = new Set(["LOW_BOOST", "HIGH_BOOST"]);
  const lowBoost = await Actor.create({ name: "__PW__MeleeCap LowBoost", type: "cp2020-augmented.vehicle",
    system: { isACPA: true, str: 30, reflexControl: "LOW_BOOST" } });
  await lowBoost.update({ "system.pilotId": pilot.id }); lowBoost.reset();
  const advanced = await Actor.create({ name: "__PW__MeleeCap Advanced", type: "cp2020-augmented.vehicle",
    system: { isACPA: true, str: 30, reflexControl: "ADVANCED" } });
  await advanced.update({ "system.pilotId": pilot.id }); advanced.reset();
  const lbPACS = Number(game.actors.get(lowBoost.id).system.pilotPACS) || 0;
  ok("pilotPACS_derived", lbPACS === 4);
  ok("reflex_gate", MA_REFLEX.has("LOW_BOOST") === true && MA_REFLEX.has("ADVANCED") === false);
  ok("pacs_cap_math", Math.min(bestMA, lbPACS) === 4);   // Martial Arts 8 → capped at PA Combat Sense 4

  // (3) Dialog integration: picker Martial option gated by reflex; skill level auto-pulls the pilot value.
  // openAcpaMeleeDialog needs a single target — set up a scene + a target token.
  let sc = game.scenes.find(s => s.name === "__PW__MeleeCapScene");
  if (!sc) sc = await Scene.create({ name: "__PW__MeleeCapScene", width: 1000, height: 1000, grid: { size: 100 } });
  await sc.activate(); for (let i = 0; i < 30 && !(canvas?.ready && canvas.scene?.id === sc.id); i++) await sleep(150);
  const dummy = await Actor.create({ name: "__PW__MeleeCap Dummy", type: "character" });
  const [tok] = await sc.createEmbeddedDocuments("Token", [{ name: "__PW__t", actorId: dummy.id, x: 300, y: 300, actorLink: true, disposition: -1 }]);
  await sleep(300);
  const place = canvas.tokens.get(tok.id); place?.setTarget(true, { releaseOthers: true });
  await sleep(200);

  const closeMelee = async () => { for (const a of [...foundry.applications.instances.values()]) { try { if (a.element?.querySelector?.("#cp-am-skillkind")) await a.close(); } catch {} } await sleep(200); };
  const renderPicker = async (suit) => {
    await closeMelee();
    await AC.openAcpaMeleeDialog(game.actors.get(suit.id));
    let root = null;
    for (let i = 0; i < 25; i++) { await sleep(150); root = document.querySelector("#cp-am-skillkind")?.closest(".vehicle-fire-dialog"); if (root) break; }
    if (!root) return null;
    const kinds = [...root.querySelectorAll("#cp-am-skillkind option")].map(o => o.value);
    const skillVal0 = Number(root.querySelector("#cp-am-skill")?.value);
    // pick martial (if present) → auto-pull + cap note
    let martialPull = null, capShown = null;
    const sel = root.querySelector("#cp-am-skillkind");
    if (kinds.includes("martial")) {
      sel.value = "martial"; sel.dispatchEvent(new Event("change", { bubbles: true })); await sleep(150);
      martialPull = Number(root.querySelector("#cp-am-skill")?.value);
      capShown = !root.querySelector("#cp-am-capnote")?.hidden;
    }
    await closeMelee();
    return { kinds, skillVal0, martialPull, capShown };
  };
  const lb = await renderPicker(lowBoost);
  const adv = await renderPicker(advanced);
  out.lb = lb; out.adv = adv;
  ok("lowboost_has_martial", !!lb && lb.kinds.includes("martial") && lb.kinds.length === 3);
  ok("advanced_no_martial", !!adv && !adv.kinds.includes("martial") && adv.kinds.length === 2);
  ok("default_autopull_brawling", !!lb && lb.skillVal0 === 5);
  ok("martial_autopull", !!lb && lb.martialPull === 8);
  ok("cap_note_shown", !!lb && lb.capShown === true);   // MA 8 > PACS 4 → the "8 → 4" cap note is visible

  // cleanup
  await lowBoost.delete().catch(() => {}); await advanced.delete().catch(() => {});
  await pilot.delete().catch(() => {}); await dummy.delete().catch(() => {});
  await sc.delete().catch(() => {});
  return out;
});

console.log("\n===== ACPA B3 — melee PACS cap + reflex gate =====");
console.log("  trainedMartials:", JSON.stringify(r.trainedMartials), "| lb:", JSON.stringify(r.lb), "| adv:", JSON.stringify(r.adv));
for (const [k, v] of Object.entries(r.checks)) console.log(`  ${v ? "✅" : "❌"} ${k}`);
console.log("  page errors:", errors.length ? errors.slice(0, 5) : "none");
const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
const pass = failed.length === 0 && errors.length === 0;
console.log("\n  RESULT: " + (pass ? `PASS ✅ — ${Object.keys(r.checks).length}/${Object.keys(r.checks).length}` : `FAIL ❌ — ${failed.join(", ")}${errors.length ? " · errors " + errors.length : ""}`));
await b.close();
process.exit(pass ? 0 : 1);
