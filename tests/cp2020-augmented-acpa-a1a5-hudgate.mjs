/** ACPA damage-resolver rewrite (A1-A5) + the no-HUD/VR indirect-fire gate.
 *  Proves, on the vanilla+module ship rig (:30004), the NEW routing of _resolveAcpaSopDamage:
 *    A1 — hit-location BEFORE penetration; the external-system d10 is rolled ONLY when the struck
 *         area holds a live external system (no phantom external roll on a bare area).
 *    A2 — an external system resolves against its OWN SP (no suit shell, no frame Toughness).
 *    A4 — a System-Hit table result with no matching mounted system routes to the PILOT, not the frame.
 *    A3 — a destroyed ammo-bearing weapon rolls a cook-off detonation (best-effort chat-card proof).
 *  Plus the pure interfaceHasHud predicate and the openVehicleFireDialog HUD/VR indirect-fire gate.
 *
 *  Deterministic dice: CONFIG.Dice.randomUniform is queue-driven (a die of N faces returns
 *  Math.ceil(u*N)); the original is restored in a finally. NOTE: this suit's Toughness Mod is DERIVED
 *  from chassis STR (str:30 → Toughness −8 → abs 8), so incoming damage is chosen to leave the intended
 *  suit-penetration figure (23) rather than the task's assumed toughness 2 (see report banner below).
 *
 *  Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-acpa-a1a5-hudgate.mjs */
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
  const out = { checks: {}, notes: {}, nums: {} };
  const ok = (k, v) => { out.checks[k] = !!v; };
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  // ── cleanup prior fixtures ───────────────────────────────────────────
  for (const a of game.actors.filter(a => a.name?.startsWith("__PW__"))) await a.delete().catch(() => {});
  try { await game.settings.set("cp2020-augmented", "vehicleDamageEnabled", true); } catch {}

  const acpa = await import("/modules/cp2020-augmented/module/vehicle/vehicle-acpa.js");
  const dmg  = await import("/modules/cp2020-augmented/module/vehicle/vehicle-damage.js");
  const wep  = await import("/modules/cp2020-augmented/module/vehicle/vehicle-weapons.js");

  // ── deterministic dice queue (restored in finally) ───────────────────
  const origRU = CONFIG.Dice.randomUniform;
  const origMR = Math.random;
  let Q = [];
  let ruCalls = 0;
  const install = () => { CONFIG.Dice.randomUniform = () => { ruCalls++; return Q.length ? Q.shift() : 0.05; }; };
  // Foundry v14 maps a face as Math.ceil((1 − u) · faces) (mapRandomFace) — INVERTED from the task's
  // assumed Math.ceil(u · N). So to force a die of N faces to k: u = 1 − (k − 0.5)/N.
  const D  = (k) => 1 - (k - 0.5) / 10;    // force a d10 = k
  const H  = (k) => 1 - (k - 0.5) / 100;   // force a d100 = k
  const S6 = (k) => 1 - (k - 0.5) / 6;     // force a d6 = k
  install();

  const created = [];   // actor cleanup at the end
  try {
    // ── SELF-CHECK: the dice override actually drives Roll ──────────────
    Q = [D(8)]; ruCalls = 0;
    const scRoll = await new Roll("1d10").evaluate();
    ok("selfcheck_d10_override", scRoll.total === 8);
    out.nums.selfcheck_total = scRoll.total;
    if (scRoll.total !== 8) {
      // fall back to also stubbing Math.random and re-verify
      Math.random = () => { ruCalls++; return Q.length ? Q.shift() : 0.05; };
      Q = [D(8)];
      const scRoll2 = await new Roll("1d10").evaluate();
      ok("selfcheck_d10_override", scRoll2.total === 8);
      out.notes.selfcheck = "CONFIG.Dice.randomUniform alone did NOT take; Math.random also stubbed.";
      out.nums.selfcheck_total = scRoll2.total;
    }

    // ── ROLL-COUNT PROBE: applyVehicleDamageMM rolls NO dice before the resolver ─
    // (isACPA + rawDamage supplied → mmEffectivePenetration is pure, reactive/composite skip for ACPA).
    // Scenario 2 below consumes exactly 2 dice (loc d10 + external d10); we assert the count there.

    // helper: build an ACPA suit actor. Force the DETAILED pole (MM p.54-56, _resolveAcpaSopDamage):
    // acpaResolveMode defaults an UNpiloted suit to Quick Kill, but A1-A5 live in the detailed resolver.
    const makeSuit = async (name, sys, items = []) => {
      const a = await Actor.create({ name, type: "cp2020-augmented.vehicle",
        system: Object.assign({ isACPA: true, str: 30, acpaCombatModel: "detailed" }, sys) });
      created.push(a);
      if (items.length) await a.createEmbeddedDocuments("Item", items);
      return game.actors.get(a.id);
    };

    // ══════════════════════════════════════════════════════════════════
    // 1) interfaceHasHud (pure) — Aperture = no HUD; HUD/VR = yes; unknown = default-yes.
    // ══════════════════════════════════════════════════════════════════
    const HUDf = acpa.interfaceHasHud;
    ok("hud_aperture_false",
      HUDf("APERTURE_BASED") === false && HUDf("ENHANCED_APERTURE") === false && HUDf("WIDEBAND_APERTURE") === false);
    ok("hud_wideband_true",
      HUDf("FULL_HUD_WIDEBAND") === true && HUDf("ECI_WIDEBAND_HUD") === true
      && HUDf("RUSSIAN_ARMS_VRI") === true && HUDf("MILITECH_VRI") === true);
    ok("hud_unknown_defaults_true", HUDf("NONSENSE_KEY") === true);

    // ══════════════════════════════════════════════════════════════════
    // 2) A2 — an external system resolves against its OWN SP (no suit shell / Toughness).
    //    Suit sp.front 20, str30→Toughness 8. One external acpaSystem (sp 2, sdp 5) in torso.
    //    rawDamage 15. Q: loc d10=8 (Torso) → external d10=3 (≤5 → hit). extPen 15−2=13 ≥ sdp5 → DESTROYED.
    //    OLD code: 15 − 20 SP − 8 Toughness < 0 → "no penetration", system untouched.
    // ══════════════════════════════════════════════════════════════════
    {
      const suit = await makeSuit("__PW__A2 ExternalSP",
        { sp: { front: 20, side: 20, rear: 20, top: 20, bottom: 20 } },
        [{ name: "__PW__ExtSensor", type: "cp2020-augmented.acpaSystem",
           system: { mount: "external", area: "torso", sp: 2, sdp: 5, category: "sensor" } }]);
      const ext = suit.items.find(i => i.name === "__PW__ExtSensor");
      const b0 = new Set(game.messages.map(m => m.id));
      Q = [D(8), D(3)]; ruCalls = 0;
      await dmg.applyVehicleDamageMM(suit, { basePen: 2, facing: "front", rawDamage: 15 });
      await sleep(120);
      out.notes.a2_qleft = Q.length;
      out.notes.a2_card = (game.messages.find(m => !b0.has(m.id))?.content || "").replace(/<[^>]+>/g, "").slice(0, 300);
      const extFresh = game.actors.get(suit.id).items.find(i => i.name === "__PW__ExtSensor");
      out.nums.a2_ext_destroyed = extFresh?.system?.destroyed;
      out.nums.a2_ext_sdpDamage = extFresh?.system?.sdpDamage;
      out.nums.a2_rollcount = ruCalls;
      ok("a2_external_destroyed", extFresh?.system?.destroyed === true);
      // roll-count proof: exactly loc-d10 + external-d10 = 2 dice consumed before/at the external branch,
      // no phantom pre-resolver dice (a destroyed no-shots system rolls no integrity/cook-off die).
      ok("a2_no_predice_two_rolls", ruCalls === 2);
    }

    // ══════════════════════════════════════════════════════════════════
    // 3) A1 + no-external routing — a bare area rolls NO external d10; System-Hit routes to the enclosed system.
    //    Suit sp.front 5. NO external. One ENCLOSED acpaSystem (internal, torso, sdp 50).
    //    incoming − 5 − 8(Toughness) must equal 23 → rawDamage 36. Q: loc=8, systemHit=5 (enclosed),
    //    integrity d100=50 (>25% → passes). Enclosed ends sdpDamage 23.
    //    OLD code: the always-rolled external d10 would eat the 0.45 as a ≤5 "external hit" (none mounted) → frame.
    // ══════════════════════════════════════════════════════════════════
    {
      const suit = await makeSuit("__PW__A1 Enclosed",
        { sp: { front: 5, side: 5, rear: 5, top: 5, bottom: 5 } },
        [{ name: "__PW__Enclosed", type: "cp2020-augmented.acpaSystem",
           system: { mount: "internal", area: "torso", sdp: 50, category: "utility" } }]);
      const torsoBefore = { ...(game.actors.get(suit.id).system.frameSDP ?? {}) };
      const b0 = new Set(game.messages.map(m => m.id));
      Q = [D(8), D(5), H(50)]; ruCalls = 0;
      await dmg.applyVehicleDamageMM(suit, { basePen: 4, facing: "front", rawDamage: 36 });
      await sleep(120);
      out.notes.a1_qleft = Q.length;
      out.notes.a1_card = (game.messages.find(m => !b0.has(m.id))?.content || "").replace(/<[^>]+>/g, "").slice(0, 300);
      const enc = game.actors.get(suit.id).items.find(i => i.name === "__PW__Enclosed");
      out.nums.a1_enclosed_sdpDamage = enc?.system?.sdpDamage;
      out.nums.a1_enclosed_destroyed = enc?.system?.destroyed;
      out.nums.a1_rollcount = ruCalls;
      out.nums.a1_torso_before = torsoBefore.torso ?? 0;
      out.nums.a1_torso_after = game.actors.get(suit.id).system.frameSDP?.torso;
      // enclosed absorbed the suit-penetration 23 (proves System-Hit table, NOT frame-direct)
      ok("a1_enclosed_took_23", enc?.system?.sdpDamage === 23 && enc?.system?.destroyed === false);
      // 3 dice only: loc + systemHit + integrity — NO external d10 was rolled on the bare area
      ok("a1_no_external_die_3_rolls", ruCalls === 3);
    }

    // ══════════════════════════════════════════════════════════════════
    // 4) A4 — a System-Hit with no matching system routes to the PILOT, frame untouched.
    //    Suit sp.front 5, str30. NO systems/weapons. Linked flesh pilot (moderate BODY).
    //    rawDamage 36 → suit-penetration 23. Q: loc=8, systemHit=5 (enclosed, none mounted).
    //    Pilot takes damage; frameSDP.torso unchanged. OLD code routed to the frame; pilot took nothing.
    // ══════════════════════════════════════════════════════════════════
    {
      const pilot = await Actor.create({ name: "__PW__A4 Pilot", type: "character" });
      created.push(pilot);
      await pilot.update({ "system.stats.bt.base": 8, "system.stats.ref.base": 6 });
      const suit = await makeSuit("__PW__A4 NoSystem",
        { sp: { front: 5, side: 5, rear: 5, top: 5, bottom: 5 }, pilotId: pilot.id });
      const torsoBefore = Number(game.actors.get(suit.id).system.frameSDP?.torso) || 0;
      const pilotDmgBefore = Number(game.actors.get(pilot.id).system.damage) || 0;
      Q = [D(8), D(5)]; ruCalls = 0;
      await dmg.applyVehicleDamageMM(suit, { basePen: 4, facing: "front", rawDamage: 36 });
      await sleep(250);
      const pilotDmgAfter = Number(game.actors.get(pilot.id).system.damage) || 0;
      const torsoAfter = Number(game.actors.get(suit.id).system.frameSDP?.torso) || 0;
      out.nums.a4_pilot_dmg_before = pilotDmgBefore;
      out.nums.a4_pilot_dmg_after = pilotDmgAfter;
      out.nums.a4_torso_before = torsoBefore;
      out.nums.a4_torso_after = torsoAfter;
      ok("a4_pilot_took_damage", pilotDmgAfter > pilotDmgBefore);
      ok("a4_frame_untouched", torsoAfter === torsoBefore);
    }

    // ══════════════════════════════════════════════════════════════════
    // 5) A3 — a destroyed ammo-bearing weapon rolls a cook-off detonation (best-effort card proof).
    //    Suit sp.front 5. One vehicleWeapon (torso, sdp 5, shots 6, damage 2d6). rawDamage 36 → penetration 23.
    //    Q: loc=8, systemHit=8 (weapons), cookoff d100=10 (≤20% for floor(23/10)=2 increments → detonates),
    //       d6=6 (mult round(6/3)=2), 2d6 → 4,4 (base 8). Card must contain "COOK-OFF".
    // ══════════════════════════════════════════════════════════════════
    {
      const suit = await makeSuit("__PW__A3 AmmoWeapon",
        { sp: { front: 5, side: 5, rear: 5, top: 5, bottom: 5 } },
        [{ name: "__PW__AmmoGun", type: "cp2020-augmented.vehicleWeapon",
           system: { area: "torso", sdp: 5, shots: 6, damage: "2d6", penetration: 4, weaponClass: "directFire" } }]);
      const before = new Set(game.messages.map(m => m.id));
      Q = [D(8), D(8), H(10), S6(6), S6(4), S6(4)]; ruCalls = 0;
      let threw = false, res = null;
      try { res = await dmg.applyVehicleDamageMM(suit, { basePen: 4, facing: "front", rawDamage: 36 }); }
      catch (e) { threw = true; out.notes.a3_error = String(e?.message || e); }
      await sleep(300);
      const card = game.messages.find(m => !before.has(m.id) && /__PW__A3 AmmoWeapon|COOK-OFF|System Hit/i.test(m.content || ""));
      const content = card?.content || "";
      out.nums.a3_rollcount = ruCalls;
      out.nums.a3_cardHasCookoff = /COOK-OFF/i.test(content);
      out.nums.a3_cardHasDestroyed = /DESTROYED/i.test(content);
      const gun = game.actors.get(suit.id).items.find(i => i.name === "__PW__AmmoGun");
      out.nums.a3_gun_destroyed = gun?.system?.destroyed;
      ok("a3_weapon_destroyed", gun?.system?.destroyed === true);
      ok("a3_cookoff_card", !threw && /COOK-OFF/i.test(content));
    }

    // ══════════════════════════════════════════════════════════════════
    // 6) HUD gate (integration) — openVehicleFireDialog blocks a missile on an Aperture suit,
    //    permits it on a Full-HUD suit.
    // ══════════════════════════════════════════════════════════════════
    {
      const warns = [];
      const origWarn = ui.notifications?.warn?.bind(ui.notifications);
      if (ui.notifications) ui.notifications.warn = (m, ...a) => { warns.push(String(m)); return origWarn ? origWarn(m, ...a) : undefined; };

      const mkMissileSuit = async (name, iface) => makeSuit(name,
        { realityInterface: iface, sp: { front: 30, side: 30, rear: 30, top: 30, bottom: 30 } },
        [{ name: "__PW__Missile", type: "cp2020-augmented.vehicleWeapon",
           system: { area: "torso", weaponClass: "missile", penetration: 20, range: 2000, guidance: "active" } }]);

      // Aperture — must be BLOCKED (warn + no dialog).
      const apSuit = await mkMissileSuit("__PW__HUD Aperture", "APERTURE_BASED");
      const apMissile = apSuit.items.find(i => i.name === "__PW__Missile");
      warns.length = 0;
      let apRet, apThrew = false;
      try { apRet = await wep.openVehicleFireDialog(apSuit, { itemId: apMissile.id }); }
      catch (e) { apThrew = true; out.notes.hud_ap_error = String(e?.message || e); }
      await sleep(150);
      const apWarned = warns.some(w => /HUD|VR|guided|indirect/i.test(w));
      const apDialog = [...foundry.applications.instances.values()].find(ap => /Missile/i.test(ap?.options?.window?.title || "") || /fire/i.test(ap?.options?.window?.title || ""));
      out.nums.hud_ap_returned = apRet === undefined || apRet === null;
      out.nums.hud_ap_warned = apWarned;
      out.nums.hud_ap_gate_pure = apSuit.system.isACPA && !HUDf(apSuit.system.realityInterface);
      ok("hud_aperture_blocked", (apRet === undefined || apRet === null) && apWarned && !apDialog);

      // Full-HUD — must be PERMITTED (no HUD warn; a dialog opens or the gate simply passes).
      const hudSuit = await mkMissileSuit("__PW__HUD Full", "FULL_HUD_WIDEBAND");
      const hudMissile = hudSuit.items.find(i => i.name === "__PW__Missile");
      warns.length = 0;
      let hudRet, hudThrew = false;
      try { hudRet = await wep.openVehicleFireDialog(hudSuit, { itemId: hudMissile.id }); }
      catch (e) { hudThrew = true; out.notes.hud_full_error = String(e?.message || e); }
      await sleep(200);
      const hudWarned = warns.some(w => /HUD|VR|guided or indirect/i.test(w));
      const hudDialog = [...foundry.applications.instances.values()].find(ap => /Missile|fire/i.test(ap?.options?.window?.title || ""));
      out.nums.hud_full_warned_gate = hudWarned;
      out.nums.hud_full_dialog_opened = !!hudDialog;
      out.nums.hud_full_threw = hudThrew;
      out.nums.hud_full_gate_pure = hudSuit.system.isACPA && !HUDf(hudSuit.system.realityInterface);
      // Gate PASSED for the HUD suit: no "no HUD/VR" warn was raised (dialog may open or fail on headless
      // canvas downstream — either way the indirect-fire gate did not block it).
      ok("hud_full_permitted", !hudWarned && (hudSuit.system.isACPA && HUDf(hudSuit.system.realityInterface)));
      out.notes.hud_path = hudDialog ? "real dialog opened for HUD suit" : (hudThrew ? "HUD dialog build threw downstream (gate still passed)" : "gate passed, no dialog handle found");
      if (hudDialog) await hudDialog.close?.().catch(() => {});

      if (ui.notifications && origWarn) ui.notifications.warn = origWarn;
    }
  } finally {
    CONFIG.Dice.randomUniform = origRU;
    Math.random = origMR;
    for (const a of created) await a.delete().catch(() => {});
  }
  return out;
});

console.log("\n===== ACPA A1-A5 resolver rewrite + no-HUD/VR indirect-fire gate =====");
console.log("  NOTE: str:30 derives Toughness Mod −8 (abs 8), so incoming was set to 36 (not the task's 30)");
console.log("        to keep suit-penetration = 23 for scenarios 3/4/5 (task assumed Toughness 2).");
console.log("  numbers:", JSON.stringify(r.nums, null, 0));
if (Object.keys(r.notes).length) console.log("  notes:", JSON.stringify(r.notes));
for (const [k, v] of Object.entries(r.checks)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
console.log("  page errors:", errors.length ? errors.slice(0, 6) : "none");

const total = Object.keys(r.checks).length;
const passed = Object.values(r.checks).filter(Boolean).length;
const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
// The known core v14 "'turn' in undefined" console error is not a real failure — filter it out.
const realErrors = errors.filter(e => !/'turn' in undefined|Cannot use 'in' operator to search for 'turn'/.test(e));
const good = failed.length === 0 && realErrors.length === 0;
console.log(`\n  RESULT: ${passed}/${total} ` + (good ? "PASS"
  : `FAIL — failed: ${failed.join(", ") || "(none)"}${realErrors.length ? " · page errors: " + realErrors.length : ""}`));
if (errors.length && !realErrors.length) console.log("  (ignored known core v14 'turn' in undefined console noise)");
await b.close();
process.exit(good ? 0 : 1);
