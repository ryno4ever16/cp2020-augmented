/** ACPA FNFF build (Units B pt.2 / C / D) — pilot-driven initiative + movement, the Quick Kill pole,
 *  and the per-suit combat-model toggle. Deterministic core: pure-fn tables + cap, getRollData wiring,
 *  derived run/jump, acpaResolveMode pole selection, a quick-kill end-to-end (chat card), and the D sheet.
 *  Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-acpa-fnff.mjs */
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
  // cleanup prior run
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__ACPA"))) await a.delete().catch(() => {});
  try { await game.settings.set("cp2020-augmented", "vehicleDamageEnabled", true); } catch {}

  const acpa = await import("/modules/cp2020-augmented/module/vehicle/vehicle-acpa.js");
  const dmg = await import("/modules/cp2020-augmented/module/vehicle/vehicle-damage.js");

  // ── Pure-fn tables + cap (deterministic) ─────────────────────────────
  // acpaInitiativeRollData cap: SIB + PACS ≤ 20.
  const capHi = acpa.acpaInitiativeRollData({ sib: 18, pilotPACS: 5, effectiveRef: 7, commandComputer: true });
  ok("cap_clamped", capHi.CombatSenseMod === 2 && capHi.initiativeMod === 18 && capHi.stats.ref.total === 7 && capHi.initiativeImplantMod === 1);
  const capLo = acpa.acpaInitiativeRollData({ sib: 2, pilotPACS: 5, effectiveRef: 8, commandComputer: false });
  ok("cap_uncapped", capLo.CombatSenseMod === 5 && capLo.initiativeMod === 2 && capLo.initiativeImplantMod === 0);
  const capNeg = acpa.acpaInitiativeRollData({ sib: -3, pilotPACS: 0, effectiveRef: 5 });
  ok("cap_zero_pacs", capNeg.CombatSenseMod === 0 && capNeg.initiativeMod === -3);

  // acpaRunM / acpaJumpM (MM p.57).
  ok("runM_formula", acpa.acpaRunM({ sib: 2, ma: 6 }) === 24 && acpa.acpaRunM({ sib: 0, ma: 0 }) === 0);
  ok("jump_formula", acpa.acpaJumpM(24, {}) === 4 && acpa.acpaJumpM(24, { running: true }) === 6);

  // acpaHitLocation (MM p.5-6 table): ≤0 Power Cell / 1-3 Legs / 4-6 Arms / 7+ Torso/Head.
  ok("hitloc_table", dmg.acpaHitLocation(-1) === "Power Cell" && dmg.acpaHitLocation(0) === "Power Cell"
    && dmg.acpaHitLocation(2) === "Legs" && dmg.acpaHitLocation(5) === "Arms" && dmg.acpaHitLocation(9) === "Torso/Head");
  // A1 fix: the ACPA table spans −1..12 via the vehicle facing shift (+2 top / −1 side / −2 rear/bottom),
  // so a rear/bottom/side hit can reach the Power Cell (roll ≤0) and a top hit skews toward Torso/Head.
  ok("hitloc_facing", dmg.acpaHitLocation(1, "rear") === "Power Cell" && dmg.acpaHitLocation(2, "bottom") === "Power Cell"
    && dmg.acpaHitLocation(8, "top") === "Torso/Head" && dmg.acpaHitLocation(3, "side") === "Legs"
    && dmg.acpaHitLocation(3, "front") === "Legs");

  // acpaResolveMode pole selection (Units C/D).
  const M = dmg.acpaResolveMode;
  ok("mode_nopilot_quickkill", M({ acpaCombatModel: "", pilotId: "" }) === "quickkill");
  ok("mode_pilot_detailed",    M({ acpaCombatModel: "", pilotId: "abc" }) === "detailed");
  ok("mode_force_quickkill",   M({ acpaCombatModel: "quickkill", pilotId: "abc" }) === "quickkill");
  ok("mode_force_detailed",    M({ acpaCombatModel: "detailed", pilotId: "" }) === "detailed");

  // mmDamageSeverity with BodyValue = STR/20 (quick-kill reuses the vehicle severity table).
  const sev = dmg.mmDamageSeverity({ pen: 20, effectiveArmorValue: 5, bodyValue: 1, d10: 5 });
  ok("severity_penetrates", sev.penetrated === true && typeof sev.severity === "string");

  // ── Live actor: pilot + linked ACPA (B2 getRollData + B4 movement) ───
  const pilot = await Actor.create({ name: "__PW__ACPA Pilot", type: "character" });
  await pilot.update({ "system.stats.ref.base": 8, "system.stats.ma.base": 6 });
  await pilot.createEmbeddedDocuments("Item", [{ _id: "PACombatSense001", name: "PA Combat Sense", type: "skill", system: { level: 3, stat: "ref" } }], { keepId: true });
  const pilotFresh = game.actors.get(pilot.id);
  out.pilot = { ref: pilotFresh.system?.stats?.ref?.total, ma: pilotFresh.system?.stats?.ma?.total,
    pacsItem: !!pilotFresh.items.find(i => i._id === "PACombatSense001") };

  const suit = await Actor.create({ name: "__PW__ACPA Suit", type: "cp2020-augmented.vehicle",
    system: { isACPA: true, str: 30, sp: { front: 20, side: 20, rear: 20, top: 20, bottom: 20 } } });
  await suit.update({ "system.pilotId": pilot.id });
  suit.reset();
  const ss = game.actors.get(suit.id).system;
  const sib = Number(ss.sib) || 0, effRef = Number(ss.effectiveRef) || 0, pacs = 3;
  out.derived = { sib, effRef, pilotPACS: ss.pilotPACS, runM: ss.runM, jumpStanding: ss.jumpStanding, jumpRunning: ss.jumpRunning };

  // B2 — getRollData maps the derived init terms into the system initiative formula for an ACPA.
  const rd = game.actors.get(suit.id).getRollData();
  const expectPacs = Math.max(0, Math.min(pacs, 20 - sib));
  ok("b2_pilotPACS_read", ss.pilotPACS === pacs);
  ok("b2_rolldata_ref", rd?.stats?.ref?.total === effRef);
  ok("b2_rolldata_sib", rd?.initiativeMod === sib);
  ok("b2_rolldata_pacs", rd?.CombatSenseMod === expectPacs);
  ok("b2_rolldata_implant", rd?.initiativeImplantMod === (ss.commandComputer ? 1 : 0));

  // B4 — run/jump derived from (SIB + pilot MA) × 3.
  ok("b4_runM", ss.runM === (sib + 6) * 3);
  ok("b4_jumpStanding", ss.jumpStanding === acpa.acpaJumpM(ss.runM, {}));
  ok("b4_jumpRunning", ss.jumpRunning === acpa.acpaJumpM(ss.runM, { running: true }));

  // Non-ACPA + character actors are untouched by the getRollData wrap: the pilot's rolldata must
  // carry their OWN ref total and no suit initiative terms (the fixture pilot has Combat Sense 0,
  // so a leaked suit SIB/PACS would surface as a non-zero CombatSenseMod). (Run-4: the previous
  // form of this assertion was a tautology that could never fail.)
  const rdPilot = pilotFresh.getRollData();
  ok("b2_pilot_rolldata_untouched",
    rdPilot?.stats?.ref?.total === pilotFresh.system.stats.ref.total
    && (Number(rdPilot?.CombatSenseMod) || 0) === 0);

  // ── C — quick-kill end-to-end on an unpiloted suit (chat card says Quick Kill) ──
  await suit.update({ "system.pilotId": "", "system.acpaCombatModel": "quickkill" });
  const before = new Set(game.messages.map(m => m.id));
  let qkResult = null, qkThrew = false;
  try { qkResult = await dmg.applyVehicleDamageMM(game.actors.get(suit.id), { basePen: 45, facing: "front" }); }
  catch (e) { qkThrew = true; out.qkError = String(e?.message || e); }
  await new Promise(res => setTimeout(res, 400));
  const newMsg = game.messages.find(m => !before.has(m.id) && /__PW__ACPA Suit|Quick Kill|SDP|Pen/i.test(m.content || ""));
  ok("c_quickkill_ran", qkThrew === false && qkResult != null && qkResult.isACPA === true);
  ok("c_quickkill_card", !!newMsg && /Quick Kill/i.test(newMsg?.content || ""));
  out.qkResult = qkResult ? { isACPA: qkResult.isACPA, pen: qkResult.pen } : null;

  // ── D — schema field round-trips + sheet renders the GM select + effective-model field ──
  await suit.update({ "system.acpaCombatModel": "detailed" });
  ok("d_field_roundtrip", game.actors.get(suit.id).system.acpaCombatModel === "detailed");
  const suitDoc = game.actors.get(suit.id);
  await suitDoc.sheet.render(true);
  await new Promise(res => setTimeout(res, 800));
  const root = suitDoc.sheet.element instanceof HTMLElement ? suitDoc.sheet.element : suitDoc.sheet.element?.[0];
  const sel = root?.querySelector('select[name="system.acpaCombatModel"]');
  ok("d_sheet_select", !!sel);
  ok("d_sheet_select_options", (sel?.querySelectorAll("option").length ?? 0) === 3);
  ok("d_sheet_effective_field", /Active model|Detailed|Quick Kill/i.test(root?.textContent || ""));
  ok("d_sheet_no_rawkey", !/CYBERPUNK\.Vehicle\.Acpa/.test(root?.textContent || ""));
  await suitDoc.sheet.close().catch(() => {});

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // E/F/G — Detailed-resolver PILOT ROUTING for a DESTROYED enclosed system / internal weapon
  //   (MM p.55: "any damage not absorbed by the system's SOP passes on to the PILOT" — NOT the frame),
  //   plus the pilot's OWN worn armor + BTM reducing that overflow (external designer clarification).
  //   Deterministic via a queue-driven CONFIG.Dice.randomUniform (a1a5 harness); v14 maps a die face as
  //   Math.ceil((1−u)·faces), so force a d10=k with u = 1 − (k−0.5)/10. Suit str30 → Toughness −8 (abs 8).
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const origRU = CONFIG.Dice.randomUniform;
  const origMR = Math.random;
  const D = (k) => 1 - (k - 0.5) / 10;     // force a d10 = k
  let Q = [];
  const capSettings = {};
  const setS = async (k, v) => { try { capSettings[k] = game.settings.get("cp2020-augmented", k); } catch {} try { await game.settings.set("cp2020-augmented", k, v); } catch {} };
  const efgCreated = [];
  try {
    CONFIG.Dice.randomUniform = () => (Q.length ? Q.shift() : 0.05);
    // self-check the override drives Roll; fall back to also stubbing Math.random.
    Q = [D(8)];
    let sc = await new Roll("1d10").evaluate();
    if (sc.total !== 8) { Math.random = () => (Q.length ? Q.shift() : 0.05); Q = [D(8)]; sc = await new Roll("1d10").evaluate(); }
    ok("efg_dice_override", sc.total === 8);

    // Ablation ON + FULL armor mode so the pilot-armor ablation step (which mirrors the personnel gate)
    // is observable in leg E; restored in finally.
    await setS("damageAblation", true);
    await setS("damageArmorMode", "full");
    await setS("vehicleDamageEnabled", true);

    const LOCS = ["Head", "Torso", "rArm", "lArm", "rLeg", "lLeg"];
    const armorItem = (name, torsoSP) => ({ name, type: "armor",
      system: { equipped: true, armorType: "Soft",
        coverage: Object.fromEntries(LOCS.map(k => [k, { stoppingPower: String(k === "Torso" ? torsoSP : 0), ablation: 0 }])) } });
    const mkPilot = async (name, torsoSP) => {
      const a = await Actor.create({ name, type: "character" }); efgCreated.push(a);
      await a.update({ "system.stats.bt.base": 5 });   // BODY 5 → BTM 2 (btmFromBT)
      if (torsoSP > 0) await a.createEmbeddedDocuments("Item", [armorItem(name + " Armor", torsoSP)]);
      return game.actors.get(a.id);
    };
    const mkSuit = async (name, pilotId, items = []) => {
      const a = await Actor.create({ name, type: "cp2020-augmented.vehicle",
        system: { isACPA: true, str: 30, acpaCombatModel: "detailed", pilotId,
          sp: { front: 5, side: 5, rear: 5, top: 5, bottom: 5 },
          // Seed frameSDP to full (str30: acpaAreaSDP) so the frame is a LIVE sink — an all-zero/absent
          // frame reads as already-destroyed and spills to the pilot, masking the routing change. With a
          // live torso 23, OLD code consumes it (frame changes) while NEW code leaves it untouched.
          frameSDP: { head: 8, rArm: 8, lArm: 8, rLeg: 15, lLeg: 15, torso: 23 } } });
      efgCreated.push(a);
      if (items.length) await a.createEmbeddedDocuments("Item", items);
      return game.actors.get(a.id);
    };
    const torsoFrame = (id) => Number(game.actors.get(id).system.frameSDP?.torso);
    const torsoSP = (a) => Number(a.items.find(i => i.type === "armor")?.system?.coverage?.Torso?.stoppingPower);

    // ── E — DESTROYED ENCLOSED SYSTEM → pilot; pilot wound = overflow − pilotSP − BTM, floor 1; armor ablated.
    //   sdp = 36 − 5 − 8 = 23 penetrates. Enclosed (torso, sdp 5) DESTROYED → overflow 23 − 5 = 18 to the
    //   pilot. Pilot torso armor SP 6 → afterSP 18 − 6 = 12, − BTM 2 → net 10. Frame torso UNCHANGED (the
    //   overflow no longer bites the frame). Armor ablated 6 → 5 (penetrating hit, ablation ON).
    {
      const pE = await mkPilot("__PW__ACPA E Pilot", 6);
      const btmE = Number(pE.system?.stats?.bt?.modifier) || 0;
      const sE = await mkSuit("__PW__ACPA E Suit", pE.id,
        [{ name: "__PW__ACPA E Sys", type: "cp2020-augmented.acpaSystem",
           system: { mount: "internal", area: "torso", sdp: 5, category: "utility" } }]);
      const frameBefore = torsoFrame(sE.id), spBefore = torsoSP(game.actors.get(pE.id)), dmgBefore = Number(pE.system.damage) || 0;
      Q = [D(8), D(5)];   // loc=8 Torso · systemHit=5 enclosed
      await dmg.applyVehicleDamageMM(sE, { basePen: 4, facing: "front", rawDamage: 36 });
      await new Promise(res => setTimeout(res, 250));
      const pAfter = game.actors.get(pE.id);
      const dmgAfter = Number(pAfter.system.damage) || 0, frameAfter = torsoFrame(sE.id), spAfter = torsoSP(pAfter);
      out.efgE = { btm: btmE, dmgBefore, dmgAfter, delta: dmgAfter - dmgBefore, frameBefore, frameAfter, spBefore, spAfter };
      ok("e_enclosed_pilot_wound_10", (dmgAfter - dmgBefore) === 10);   // 18 − 6 SP − 2 BTM = 10
      ok("e_enclosed_frame_untouched", frameAfter === frameBefore);
      ok("e_enclosed_pilot_btm_2", btmE === 2);
      ok("e_enclosed_armor_ablated_6to5", spBefore === 6 && spAfter === 5);
    }

    // ── F — DESTROYED INTERNAL WEAPON → pilot (unarmored). Weapon (torso, sdp 5, NO shots) destroyed,
    //   overflow 18 → pilot with no armor: afterSP 18, − BTM 2 → net 16. Frame torso UNCHANGED.
    {
      const pF = await mkPilot("__PW__ACPA F Pilot", 0);
      const btmF = Number(pF.system?.stats?.bt?.modifier) || 0;
      const sF = await mkSuit("__PW__ACPA F Suit", pF.id,
        [{ name: "__PW__ACPA F Gun", type: "cp2020-augmented.vehicleWeapon",
           system: { area: "torso", sdp: 5, penetration: 4, weaponClass: "directFire" } }]);
      const frameBefore = torsoFrame(sF.id), dmgBefore = Number(pF.system.damage) || 0;
      Q = [D(8), D(8)];   // loc=8 Torso · systemHit=8 weapons
      await dmg.applyVehicleDamageMM(sF, { basePen: 4, facing: "front", rawDamage: 36 });
      await new Promise(res => setTimeout(res, 250));
      const pAfter = game.actors.get(pF.id);
      const dmgAfter = Number(pAfter.system.damage) || 0, frameAfter = torsoFrame(sF.id);
      out.efgF = { btm: btmF, dmgBefore, dmgAfter, delta: dmgAfter - dmgBefore, frameBefore, frameAfter };
      ok("f_weapon_pilot_wound_16", (dmgAfter - dmgBefore) === 16);   // 18 − 0 SP − 2 BTM = 16
      ok("f_weapon_frame_untouched", frameAfter === frameBefore);
    }

    // ── G — PILOT ARMOR ABSORBS the overflow (SP ≥ overflow → NO wound, armor NOT ablated: a stopped hit
    //   does not ablate, per the personnel gate). Uses the no-system-in-area route (System Hit → enclosed,
    //   none mounted → the whole 23 passes to the pilot), so pilot armor SP 25 ≥ 23 → afterSP 0 → no wound.
    {
      const pG = await mkPilot("__PW__ACPA G Pilot", 25);
      const sG = await mkSuit("__PW__ACPA G Suit", pG.id, []);   // NO systems/weapons in the area
      const dmgBefore = Number(pG.system.damage) || 0, spBefore = torsoSP(game.actors.get(pG.id));
      Q = [D(8), D(5)];   // loc=8 Torso · systemHit=5 enclosed (none mounted → to pilot)
      await dmg.applyVehicleDamageMM(sG, { basePen: 4, facing: "front", rawDamage: 36 });
      await new Promise(res => setTimeout(res, 250));
      const pAfter = game.actors.get(pG.id);
      const dmgAfter = Number(pAfter.system.damage) || 0, spAfter = torsoSP(pAfter);
      out.efgG = { dmgBefore, dmgAfter, delta: dmgAfter - dmgBefore, spBefore, spAfter };
      ok("g_pilot_armor_absorbs_no_wound", (dmgAfter - dmgBefore) === 0);   // 23 − 25 SP ≤ 0 → no wound
      ok("g_absorb_armor_unablated_25", spBefore === 25 && spAfter === 25);
    }
  } finally {
    CONFIG.Dice.randomUniform = origRU;
    Math.random = origMR;
    for (const [k, v] of Object.entries(capSettings)) { try { await game.settings.set("cp2020-augmented", k, v); } catch {} }
    for (const a of efgCreated) await a.delete().catch(() => {});
  }

  // cleanup
  await suit.delete().catch(() => {});
  await pilot.delete().catch(() => {});
  return out;
});

console.log("\n===== ACPA FNFF build (Units B pt.2 / C / D) =====");
console.log("  pilot:", JSON.stringify(r.pilot));
console.log("  derived:", JSON.stringify(r.derived));
console.log("  quick-kill result:", JSON.stringify(r.qkResult), r.qkError ? ("ERR: " + r.qkError) : "");
if (r.efgE) console.log("  E (enclosed→pilot):", JSON.stringify(r.efgE));
if (r.efgF) console.log("  F (weapon→pilot):  ", JSON.stringify(r.efgF));
if (r.efgG) console.log("  G (armor absorbs): ", JSON.stringify(r.efgG));
for (const [k, v] of Object.entries(r.checks)) console.log(`  ${v ? "✅" : "❌"} ${k}`);
console.log("  page errors:", errors.length ? errors.slice(0, 5) : "none");

const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
const ok = failed.length === 0 && errors.length === 0;
console.log("\n  RESULT: " + (ok ? `PASS ✅ — ${Object.keys(r.checks).length}/${Object.keys(r.checks).length} checks`
  : `FAIL ❌ — failed: ${failed.join(", ") || "(none)"}${errors.length ? " · page errors: " + errors.length : ""}`));
await b.close();
process.exit(ok ? 0 : 1);
