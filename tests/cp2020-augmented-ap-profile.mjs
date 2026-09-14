/** AP profile keeper — the weapon-level AP flag and the AP ammo modifier resolve to ONE armor-piercing
 *  round, applied once (user ruling 2026-09-14). Before this unit the two stacked (SP quartered) and the
 *  flag alone halved SP without the penetrating-damage halving.
 *  - Pure: resolveApProfile — flag + standard load → 0.5/0.5/0.5; flag + non-standard load → the round's
 *    own profile, flag ignored; no flag → identity.
 *  - Live (sync resolver + async dryRun parity): SP 20 soft vest, raw 40 —
 *      plain hit            → spUsed 20, after 20
 *      flag, standard load  → spUsed 10, after 15 (penetrating ×0.5), breakdown apHalved true
 *      flag + AP ammo       → spUsed 10 (NOT 5), after 15   ← the double-dip guard
 *      AP ammo, no flag     → spUsed 10, after 15, apHalved false (unchanged behaviour)
 *      flag + hollow-point  → the round wins: SP ×2 = 40, so raw 60 → after floor(20×1.5)=30
 *  - Hard armor: flag halves it too (armorMultHard 0.5), spUsed 10.
 *  Runs on :30004 (official 1.1.1 + module). */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = {};
  const A = await import("/modules/cp2020-augmented/module/combat/DamageApplicator.js");
  const cov = (sp) => Object.fromEntries(["Head","Torso","lArm","rArm","lLeg","rLeg"]
    .map(k => [k, { stoppingPower: String(k === "Torso" ? sp : 0), ablation: 0 }]));

  // ── (0) PURE profile resolution ──────────────────────────────────────────
  // Tolerant of a resolver that predates the export (the red-first run serves HEAD): the pure legs then
  // read null and fail on their own, while the live legs still run and show the double dip.
  const P = typeof A.resolveApProfile === "function" ? A.resolveApProfile : (() => null);
  out.pure = {
    flagStandard: P({ ap: true }),                                                          // 0.5/0.5/0.5, fromWeapon
    flagApAmmo:   P({ ap: true, armorMultSoft: 0.5, armorMultHard: 0.5, penDamageMult: 0.5 }), // unchanged, NOT fromWeapon
    flagHollow:   P({ ap: true, armorMultSoft: 2, armorMultHard: 2, penDamageMult: 1.5 }),     // the round wins
    flagRubber:   P({ ap: true, penDamageMult: 0.5 }),                                       // any non-1 = non-standard
    noFlag:       P({ ap: false, armorMultSoft: 0.5, armorMultHard: 0.5, penDamageMult: 0.5 }),
    noFlagPlain:  P({ ap: false }),
  };

  for (const a of game.actors.filter(a => a.name?.startsWith("__PW__ ap"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__ ap target", type: "character" });
  const hard  = await Actor.create({ name: "__PW__ ap hard target", type: "character" });
  try {
    await actor.createEmbeddedDocuments("Item", [{ name: "__PW__ soft vest", type: "armor",
      system: { equipped: true, armorType: "soft", coverage: cov(20) } }]);
    await hard.createEmbeddedDocuments("Item", [{ name: "__PW__ hard plate", type: "armor",
      system: { equipped: true, armorType: "hard", coverage: cov(20) } }]);
    const hit = (dmg) => ({ Torso: [{ damage: dmg }] });
    const sync = (o, dmg = 40, target = actor) => A.resolveAreaDamagesSync({ target, areaDamages: hit(dmg), armorMode: "full", ...o })[0];
    const AP_AMMO = { armorMultSoft: 0.5, armorMultHard: 0.5, penDamageMult: 0.5 };
    const HOLLOW  = { armorMultSoft: 2,   armorMultHard: 2,   penDamageMult: 1.5 };

    const plain     = sync({});
    const flagOnly  = sync({ ap: true });
    const both      = sync({ ap: true, ...AP_AMMO });
    const ammoOnly  = sync({ ...AP_AMMO });
    const flagHollow= sync({ ap: true, ...HOLLOW }, 60);
    const hardFlag  = sync({ ap: true }, 40, hard);
    out.live = {
      plainSP: plain.spUsed, plainAfter: plain.damageAfterSP,
      flagSP: flagOnly.spUsed, flagAfter: flagOnly.damageAfterSP, flagApHalved: flagOnly.breakdown?.apHalved === true, flagPenMult: flagOnly.breakdown?.penMult,
      bothSP: both.spUsed, bothAfter: both.damageAfterSP,
      ammoSP: ammoOnly.spUsed, ammoAfter: ammoOnly.damageAfterSP, ammoApHalved: ammoOnly.breakdown?.apHalved === true,
      hollowSP: flagHollow.spUsed, hollowAfter: flagHollow.damageAfterSP,
      hardSP: hardFlag.spUsed,
    };

    // ── async resolver (dryRun) must agree on the double-dip case ────────────
    const asyncBoth = (await A.resolveAreaDamages({ target: actor, areaDamages: hit(40), armorMode: "full", ap: true, ...AP_AMMO }))[0];
    const asyncFlag = (await A.resolveAreaDamages({ target: actor, areaDamages: hit(40), armorMode: "full", ap: true }))[0];
    out.async = { bothSP: asyncBoth?.spUsed, bothAfter: asyncBoth?.damageAfterSP, flagSP: asyncFlag?.spUsed, flagAfter: asyncFlag?.damageAfterSP };
  } finally {
    await actor.delete().catch(() => {}); await hard.delete().catch(() => {});
  }
  return out;
});

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;
const checks = {
  pureFlagStandardProfile: near(r.pure?.flagStandard?.armorMultSoft, 0.5) && near(r.pure?.flagStandard?.armorMultHard, 0.5) && near(r.pure?.flagStandard?.penDamageMult, 0.5) && r.pure?.flagStandard?.apFromWeapon === true,
  pureFlagApAmmoOnce:      near(r.pure?.flagApAmmo?.armorMultSoft, 0.5) && near(r.pure?.flagApAmmo?.penDamageMult, 0.5) && r.pure?.flagApAmmo?.apFromWeapon === false,
  pureFlagHollowRoundWins: near(r.pure?.flagHollow?.armorMultSoft, 2) && near(r.pure?.flagHollow?.penDamageMult, 1.5) && r.pure?.flagHollow?.apFromWeapon === false,
  pureFlagRubberRoundWins: near(r.pure?.flagRubber?.armorMultSoft, 1) && near(r.pure?.flagRubber?.penDamageMult, 0.5) && r.pure?.flagRubber?.apFromWeapon === false,
  pureNoFlagIdentity:      near(r.pure?.noFlag?.armorMultSoft, 0.5) && r.pure?.noFlag?.apFromWeapon === false && near(r.pure?.noFlagPlain?.armorMultSoft, 1),

  livePlainSP:        r.live?.plainSP === 20,
  livePlainAfter:     r.live?.plainAfter === 20,
  liveFlagHalvesSP:   r.live?.flagSP === 10,
  liveFlagHalvesPen:  r.live?.flagAfter === 15,           // (40-10) × 0.5
  liveFlagBreakdown:  r.live?.flagApHalved === true && near(r.live?.flagPenMult, 0.5),
  liveNoDoubleDipSP:  r.live?.bothSP === 10,              // was 5 before the fix
  liveNoDoubleDipAft: r.live?.bothAfter === 15,
  liveAmmoOnlySP:     r.live?.ammoSP === 10,
  liveAmmoOnlyAfter:  r.live?.ammoAfter === 15,
  liveAmmoOnlyNoFlag: r.live?.ammoApHalved === false,
  liveHollowRoundWins:r.live?.hollowSP === 40 && r.live?.hollowAfter === 30,   // raw 60: (60-40) × 1.5
  liveHardHalved:     r.live?.hardSP === 10,

  asyncAgreesBoth:    r.async?.bothSP === 10 && r.async?.bothAfter === 15,
  asyncAgreesFlag:    r.async?.flagSP === 10 && r.async?.flagAfter === 15,

  noConsoleErrors: errors.length === 0,
};
console.log(JSON.stringify({ r, checks, errors }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? "AP-PROFILE KEEPER PASS" : "AP-PROFILE KEEPER FAIL");
await b.close();
process.exit(pass ? 0 : 1);
