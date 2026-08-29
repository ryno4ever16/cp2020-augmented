/**
 * KEEPER: area-delivery weapons — the entry wiring, the unrollable-damage guard, and the two
 * delivery pictures (:30004, official 1.1.1 + module).
 *
 *  §1 the pure derivation (combat/area-delivery.js): rollable-formula classification, the delivery
 *     kind per attack type, the p.99 radius rows and the referee's own number winning over them, and
 *     the ONE detonation predicate both halves of the damage rail read.
 *  §2 the presentation resolution (fx/effects.js): class per weapon by VALUE (thrown vs launched vs
 *     the unchanged bullet classes), the plan's four gates, the decoded arrival ladders, the tail,
 *     the two audio sources and the three database keys.
 *  §3 the live fan-out: one object per throw, the boom on the arrival clock read off a capture sink,
 *     no blood, the miss that still arrives, fxMute at the door, determinism, and the bullet negative.
 *  §4 the entry wiring, driven through the REAL fire path: a thrown grenade routes into the p.108
 *     blast flow, the area carries the book radius, the confirm applies damage by value, and the
 *     single-target window is not opened for it.
 *  §5 the unrollable-damage guard: the refusal + its notification, the loaded round supplying the
 *     formula, the accessor restored afterwards, and the ordinary weapon passing through untouched.
 *  §6 rider R-A: the apply window posts the death+stun PAIR at Mortal.
 *  §7 rider R-B: a breach with the wall sheet OPEN grows the Repair control without a reopen.
 *  §8 the authored launcher ROUNDS: they survive the write, the pack launcher offers them, firing
 *     with one produces a rollable warhead, and the blast enters by the ammo effectTypes door.
 *  §9 the STANDARD-ROUND ladder for an EMPTY tube (user ruling 2026-08-27): the scope predicate, the
 *     derived pack key, each of the four rungs by value, the loaded round still winning, the second
 *     act, the gas-grenade scope negative, and a live empty-tube shot decoded off its confirm card.
 * §10 the attack-modifiers ROW GATING: the item-side detonation predicate (attack type OR the loaded
 *     round's effect types), the called-shot row absent from the returned rows for a thrown delivery /
 *     a launcher / a missile tube and PRESENT for a rifle, nothing else removed with it, and the
 *     RENDERED window driven by a real click on the sheet's own fire control (plus a second act).
 * §11 the point-blank ROLL-MAXIMIZE predicate: shadowed false during a detonating weapon's gesture on
 *     BOTH guard paths, restored afterwards, the value consequence (point-blank 7d6 totals not pinned
 *     at 42) with a rifle negative still pinned at 30, and the blast base-damage continuity regression.
 * §12 the over-time tick's FLAT-BURN marker: the shipped round states it and discloses the printed
 *     figure, it survives the DataModel write and the seam copy, it reaches the state through the
 *     routing helper, and — driven by real round advances — a flat marker ticks 1/1/1 while a marker
 *     without it still halves 1/½/¼ on the same body in the same combat.
 * §13 the BLAST's rider carry: the placed area records all seven per-hit rider fields by value beside
 *     the armour statements it always recorded, the confirm hands them to the apply (over-time state
 *     seeded FLAT, shock flag written), the seeded burn ticks 1/1/1 on real round advances, a payload
 *     without the fields seeds nothing, an area written before the fields existed still applies plain
 *     damage cleanly, the batched save cadence is one prompt per body, and the shrapnel secondary of
 *     the detailed branch deliberately carries no riders of its own.
 * §15 the MISS auto-resolves: a thrown warhead that missed rolls its own landing at PLACEMENT, the
 *     blast is created there, the card NARRATES the outcome and carries ONE control (the Scatter button
 *     and its handler are retired); an area from the old flow still confirms exactly as before.
 * §14 the DETAILED branch's warhead routing: with the optional mode ON, a fire-typed warhead takes the
 *     CORE application (burn seeded flat, shock rider honored, NOT one p.105 concussion card), an
 *     explosive one still takes concussion (its card once, the ½-permanent arithmetic by value, riders
 *     dropped), the fork is fire-TYPED rather than rider-typed (an acid load still concusses), and the
 *     mode OFF answers exactly as it always did.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-grenade-delivery.mjs
 */
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";

// ⛔ §8's FIXTURES ARE THE SHIPPING PACK SOURCE ITSELF, read off disk here and handed to the page —
// NOT a hand-built copy of it. The seed only ever CREATES, so the compiled pack on this rig predates
// these two files until the release re-seed runs; reading the source is therefore the only way to test
// what will actually ship, and it is also the stronger test: a field the DataModel would strip on write
// gets stripped here too, which is precisely the vanilla-host failure this module exists to close.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "packs", "supplement-heavy");
const ROUND_SOURCES = [
  "Fragmentation_Grenade_Round_2smdtLN5J0FvhvoS.json",
  "Incendiary_Grenade_Round_8CKKcZdPEnHu9cWA.json",
].map((f) => JSON.parse(readFileSync(join(SRC, f), "utf8")));

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
// ⛔ ONE DOCUMENTED CORE EXCLUSION, carried on the same footing as the compatibility/viewport ones and
// already excluded by name in two sibling suites (cp2020-augmented-area-relay-crossclient.mjs:43,
// cp2020-augmented-automation-notice.mjs:112): Foundry's own combat tracker raises
// `Cannot use 'in' operator to search for 'turn' in undefined` on a round advance. It is CORE's, not
// this module's — §12 is the first section here to advance a round, which is why it appears now — and
// the mechanism is named rather than the class of error suppressed, so a real module error of any
// other shape still reds this suite.
const CORE_TURN_BUG = /Cannot use 'in' operator to search for 'turn' in undefined/;
page.on("console", m => { const t = m.text(); if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(t) && !CORE_TURN_BUG.test(t)) errors.push(t); });
page.on("pageerror", e => { if (!CORE_TURN_BUG.test(e.message)) errors.push(e.message); });

await page.goto(`${URL}/join`);
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const sel = document.querySelector('select[name="userid"]');
  sel.value = [...sel.options].find(o => /gamemaster/i.test(o.textContent)).value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 90000 });
await page.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 60000 }).catch(() => {});

const res = await page.evaluate(async ({ SCOPE, ROUND_SOURCES }) => {
  const out = { checks: [], notes: [] };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const F = (d) => d.flags?.[SCOPE] ?? {};
  // ⛔ A SECTION THAT THROWS REPORTS AS ONE FAILED LEG, never as a lost run. This keeper drives real
  // documents, real windows and real sheets, and a build missing a symbol it asks for must still let
  // every OTHER section report — which is also what makes a red-first pass against the pre-change
  // serve copy readable rather than a single stack trace.
  // ⭐ AND A SECTION THAT LOGS A CONSOLE ERROR NAMES ITSELF. The final "0 console errors" leg reports
  // a message with no context, which has cost real time before (a stray EmbeddedCollection complaint
  // reads identically whichever section produced it). `SECT` is stamped by the wrapper below, so every
  // console error carries the section that was running when it fired.
  let SECT = "(setup)";
  const realConsoleError = console.error.bind(console);
  console.error = (...a) => {
    const stack = a.map(x => x?.stack).filter(Boolean).join(" ")
      || (new Error("cp2020 keeper trace")).stack;
    out.notes.push(`⚠ console.error during ${SECT}: ${a.map(x => (x?.message ?? String(x))).join(" ").slice(0, 200)} :: ${String(stack).split("\n").slice(0, 6).join(" ⟵ ").slice(0, 700)}`);
    return realConsoleError(...a);
  };
  const sect = async (name, fn) => {
    SECT = name;
    try { await fn(); } catch (e) { ok(`${name} — section threw`, false, e?.message ?? String(e)); }
    finally { SECT = `${name}→next`; }
  };

  const AD = await import(`/modules/${SCOPE}/module/combat/area-delivery.js`);
  const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
  const base = await import("/systems/cyberpunk2020/module/lookups.js");

  /* ══════════════════ §1 the pure derivation ══════════════════ */
  const rollable = (s) => AD.damageFormulaIsRollable(s);
  ok("§1 formula classifier accepts the catalogue's dice strings",
    rollable("7d6") && rollable("4d6") && rollable("7d10") && rollable("2d6+1") && rollable("(2d6+1)*2") && rollable("@strengthBonus"),
    "7d6/4d6/7d10/2d6+1/(2d6+1)*2/@strengthBonus");
  ok("§1 formula classifier refuses the catalogue's words (the crash class)",
    !rollable("Varies") && !rollable("Gas") && !rollable("Stun") && !rollable("Deaf") && !rollable("Blind"),
    "Varies/Gas/Stun/Deaf/Blind");
  ok("§1 the empty string is refused, and is not the guard's business",
    !rollable("") && !rollable("   "), "empty");
  ok("§1 delivery kind per attack type",
    AD.areaDeliveryKind("Grenade") === "grenade" && AD.areaDeliveryKind("Missile") === "missile"
    && AD.areaDeliveryKind("RPG") === "rpg" && AD.areaDeliveryKind("Auto") === null,
    `Grenade=${AD.areaDeliveryKind("Grenade")} Missile=${AD.areaDeliveryKind("Missile")} Auto=${AD.areaDeliveryKind("Auto")}`);
  ok("§1 the p.99 rows, by value",
    AD.AREA_DELIVERY_RADIUS_M.grenade === 5 && AD.AREA_DELIVERY_RADIUS_M.missile === 6 && AD.AREA_DELIVERY_RADIUS_M.rpg === 4,
    `grenade=${AD.AREA_DELIVERY_RADIUS_M.grenade} missile=${AD.AREA_DELIVERY_RADIUS_M.missile} rpg=${AD.AREA_DELIVERY_RADIUS_M.rpg}`);
  ok("§1 a stated radius beats the book row",
    AD.areaDeliveryOf({ attackType: "Grenade" })?.radiusM === 5
    && AD.areaDeliveryOf({ attackType: "Grenade", blastRadius: 3 })?.radiusM === 3
    && AD.areaDeliveryOf({ attackType: "Missile" })?.radiusM === 6,
    `book=5 stated=${AD.areaDeliveryOf({ attackType: "Grenade", blastRadius: 3 })?.radiusM}`);
  ok("§1 a bullet payload has no delivery", AD.areaDeliveryOf({ attackType: "Auto" }) === null);
  ok("§1 the one detonation predicate: explosive round OR delivery weapon, and nothing else",
    AD.payloadDetonates({ effectTypes: ["Explosive"] }) === true
    && AD.payloadDetonates({ attackType: "Grenade" }) === true
    && AD.payloadDetonates({ attackType: "Missile" }) === true
    && AD.payloadDetonates({ attackType: "Auto" }) === false
    && AD.payloadDetonates({}) === false);
  ok("§1 a bare 'Non-Explosive' string is not read as a substring match",
    AD.payloadDetonates({ effectTypes: "Non-Explosive" }) === false);

  /* ══════════════════ fixtures ══════════════════ */
  const scene = game.scenes.active ?? canvas.scene;
  // stale sweep from any interrupted run, tokens BEFORE actors
  for (const t of [...scene.tokens].filter(t => t.name?.startsWith("__PW__"))) await t.delete().catch(() => {});
  for (const coll of [scene.templates, scene.regions]) if (coll) for (const d of [...coll]) if (F(d).isExplosion) await d.delete().catch(() => {});
  for (const a of [...game.actors].filter(a => a.name?.startsWith("__PW__"))) await a.delete().catch(() => {});
  for (const w of [...scene.walls].filter(w => F(w).__pwGrenade === true)) await w.delete().catch(() => {});

  const shooter = await Actor.create({ name: "__PW__Thrower", type: "character" });
  const victim = await Actor.create({ name: "__PW__Victim", type: "character" });
  const gridPx = scene.grid?.size ?? 100;
  const [shTok] = await scene.createEmbeddedDocuments("Token", [{ name: shooter.name, actorId: shooter.id, actorLink: true, x: 800, y: 1000, width: 1, height: 1 }]);
  const [vicTok] = await scene.createEmbeddedDocuments("Token", [{ name: victim.name, actorId: victim.id, actorLink: true, x: 800 + 3 * gridPx, y: 1000, width: 1, height: 1 }]);
  await sleep(600);

  const mkWeapon = async (name, system) => (await shooter.createEmbeddedDocuments("Item", [{ name, type: "weapon", system }]))[0];
  const HEAVY = { weaponType: "Heavy", attackSkill: "Heavy Weapons", accuracy: 0, shots: "1", shotsLeft: "1", rof: "1", reliability: "VeryReliable" };

  const frag = await mkWeapon("__PW__Frag", { ...HEAVY, attackType: "Grenade", ammoType: "Grenade", damage: "7d6", range: "50" });
  const launcher = await mkWeapon("__PW__Launcher", { ...HEAVY, attackType: "Grenade", ammoType: "Grenade", damage: "Varies", range: "225" });
  const missile = await mkWeapon("__PW__Missile", { ...HEAVY, attackType: "Missile", ammoType: "Missile", damage: "7d10", range: "1000" });
  // The scope counter-example the standard-round ladder must NOT cover: grenade-chambered like the
  // launcher, unrollable like the launcher, but its warhead is its own (CP2020 p.64, "Gas").
  const gasGrenade = await mkWeapon("__PW__Gas", { ...HEAVY, attackType: "Grenade", ammoType: "Grenade", damage: "Gas", range: "50" });
  const pistol = await mkWeapon("__PW__Pistol", { weaponType: "Pistol", attackType: "Single", ammoType: "9mm", damage: "2d6+1", range: "50", shots: "10", shotsLeft: "10", rof: "2", accuracy: 0, attackSkill: "Handgun" });
  const [round] = await shooter.createEmbeddedDocuments("Item", [{
    name: "__PW__40mm HE", type: "ammo",
    system: { caliber: "Grenade", ammoType: "Grenade", quantity: 10, bonusDamageFormula: "7d6", blastRadius: 5 },
  }]);

  /* ══════════════════ §2 presentation resolution ══════════════════ */
  await sect("§2", async () => {
    ok("§2 a thrown grenade is NOT a bullet class", fx.weaponFxClass(frag) === "thrown", `got ${fx.weaponFxClass(frag)}`);
    ok("§2 an EMPTY launcher (no round in the tube) still reads as thrown",
      fx.weaponFxClass(launcher) === "thrown", `got ${fx.weaponFxClass(launcher)}`);
    await launcher.update({ "system.ammoItemId": round.id });
    ok("§2 a LOADED launcher reads as launched", fx.weaponFxClass(launcher) === "rocket", `got ${fx.weaponFxClass(launcher)}`);
    ok("§2 a missile launcher reads as launched by its own attack type",
      fx.weaponFxClass(missile) === "rocket", `got ${fx.weaponFxClass(missile)}`);
    ok("§2 NEGATIVE — the bullet classes are untouched",
      fx.weaponFxClass(pistol) === "pistol", `got ${fx.weaponFxClass(pistol)}`);

    const planT = fx.deliveryPlanFor("thrown");
    const planR = fx.deliveryPlanFor("rocket");
    // ⏪ RE-VALUED 2026-08-28: the plan's `bleeds` gate went with the hit-spray element it gated (the
    // rail's tombstone carries the ruling). Its ABSENCE is now the assertion — a gate that is always
    // false is a mechanism a later reader has to disprove, so the field is gone rather than pinned.
    ok("§2 the thrown plan: no muzzle flash, the object arrives, boom named — and no retired gate",
      planT && planT.flash === false && planT.bleeds === undefined && planT.arrives === true
      && planT.detonation === "explosion-big",
      JSON.stringify(planT));
    ok("§2 the launched plan: a tube DOES flash", planR && planR.flash === true && planR.detonation === "explosion-big", JSON.stringify(planR));
    ok("§2 NEGATIVE — a bullet class has no delivery plan", fx.deliveryPlanFor("pistol") === null && fx.deliveryPlanFor("shotgun") === null);

    // the decoded ladders, by value, through the shared resolver
    const aT = fx.arrivalSpecFor("thrown", null, 10);
    const aR = fx.arrivalSpecFor("rocket", null, 3);
    ok("§2 the thrown arrival is the decoded 60ft band", aT.source === "stretch" && aT.band === "60ft" && aT.ms === 2867, JSON.stringify(aT));
    // ⚠ RE-VALUED 2026-08-27 to the CANNON BALL. These two legs carried the bolt trial's ladder and
    // were written to go red on revert — the revert then happened (the user rejected the bolt: "very
    // small and kind of still looks like a bullet"), so they are re-valued to the shipped picture. The
    // point they pin is unchanged: the ladder is a property of the picture, so a swap MUST move it.
    ok("§2 the launched arrival is the decoded 15ft band", aR.source === "stretch" && aR.band === "15ft" && aR.ms === 600, JSON.stringify(aR));
    ok("§2 an arrival is measured, never the 400ms unmapped fallback",
      fx.arrivalSpecFor("thrown", null, 1).ms === 1300 && fx.arrivalSpecFor("rocket", null, 20).ms === 2233,
      `05ft=${fx.arrivalSpecFor("thrown", null, 1).ms} 90ft=${fx.arrivalSpecFor("rocket", null, 20).ms}`);
    // the tail must OVER-state: arrival + the promoted mark's own trim
    const tailT = fx.presentationTailMs("thrown", null, null, aT.ms);
    ok("§2 the tail covers the arrival PLUS the detonation mark's trim (over-stated, never under)",
      tailT >= aT.ms + 700, `tail=${tailT} arrival=${aT.ms}`);
    const tailR = fx.presentationTailMs("rocket", null, null, aR.ms);
    ok("§2 the launched tail likewise", tailR >= aR.ms + 1067, `tail=${tailR} arrival=${aR.ms}`);

    ok("§2 the fire report is the pin / the launch, not a gun",
      /grenade-pin\./.test(fx.shotSoundSrc("thrown") ?? "") && /rocket-launch\./.test(fx.shotSoundSrc("rocket") ?? ""),
      `${fx.shotSoundSrc("thrown")} | ${fx.shotSoundSrc("rocket")}`);
    ok("§2 both detonations resolve to the shipped explosion asset",
      /explosion-big\./.test(fx.detonationSoundSrc("thrown") ?? "") && /explosion-big\./.test(fx.detonationSoundSrc("rocket") ?? ""),
      `${fx.detonationSoundSrc("thrown")}`);
    ok("§2 NEGATIVE — a bullet class names no detonation", fx.detonationSoundSrc("pistol") === null);

    const keys = ["jb2a.throwable.throw.bomb.01.black", "jb2a.throwable.launch.cannon_ball.01.black",
                  "jb2a.explosion.shrapnel.bomb.01.black", "jb2a.explosion.01.orange"];
    const missingKeys = keys.filter(k => !fx.fxDbEntryExists(k));
    ok("§2 every adopted database key resolves on the installed tier", missingKeys.length === 0, missingKeys.join(", "));

    /* ── the launched picture, and the rejected alternative it is still measured against ─────────
     * ⭐ RE-VALUED 2026-08-27 after the user's verdict on the bolt trial (rejected: "very small and
     * kind of still looks like a bullet"). The cannon ball is the SHIPPED picture again; the bolt row
     * is kept whole so a future look ask lands on a measured ladder rather than the 400 ms fallback.
     * Three legs, each pinning a different thing a look-swap can silently get wrong: what is DRAWN,
     * that the alternative still resolves, and that BOTH keep a measured arrival. */
    ok("§2 the launched row draws the cannon ball, warmed by the rocket matrix",
      fx.FX_CLASSES.rocket.tracer === fx.ROCKET_PROJECTILE.key
      && fx.ROCKET_PROJECTILE.key === "jb2a.throwable.launch.cannon_ball.01.black"
      && fx.FX_CLASSES.rocket.tracerColor === fx.TRACER_COLOR_ROCKET,
      `tracer=${fx.FX_CLASSES.rocket.tracer} color=${JSON.stringify(fx.FX_CLASSES.rocket.tracerColor)}`);
    ok("§2 the REJECTED bolt is still carried whole and still resolves, in its own colour",
      fx.fxDbEntryExists(fx.ROCKET_PROJECTILE_BOLT.key)
      && fx.ROCKET_PROJECTILE_BOLT.key === "jb2a.bolt.physical.orange"
      && fx.ROCKET_PROJECTILE_BOLT.tracerColor === null,
      JSON.stringify(fx.ROCKET_PROJECTILE_BOLT));
    ok("§2 BOTH pictures keep a measured five-band ladder, so neither can fall to the fallback",
      (() => {
        const bands = ["05ft", "15ft", "30ft", "60ft", "90ft"];
        const b = fx.TRACER_ARRIVAL_MS[fx.ROCKET_PROJECTILE_BALL.key];
        const t = fx.TRACER_ARRIVAL_MS[fx.ROCKET_PROJECTILE_BOLT.key];
        return !!t && !!b && bands.every(k => Number(t[k]) > 0 && Number(b[k]) > 0)
          && b["60ft"] === 1833 && t["60ft"] === 1300;
      })(),
      `shipped=${JSON.stringify(fx.TRACER_ARRIVAL_MS[fx.ROCKET_PROJECTILE.key])}`);
    ok("§2 the settle floor followed the picture back to the ball",
      fx.presentationTailMs("rocket", null, null, fx.arrivalSpecFor("rocket", null, 12).ms) === 1833 + 1067,
      `tail=${fx.presentationTailMs("rocket", null, null, fx.arrivalSpecFor("rocket", null, 12).ms)}`);
    ok("§2 the rejected missile key is NOT wired anywhere",
      fx.FX_CLASSES.thrown.tracer !== "jb2a.throwable.launch.missile.01.blue" && fx.FX_CLASSES.rocket.tracer !== "jb2a.throwable.launch.missile.01.blue");
    ok("§2 the manifest preloads the delivery pictures and the boom",
      (() => { const m = fx.fxPreloadManifest();
        return keys.every(k => m.keys.includes(k)) && m.sounds.some(s => /explosion-big\./.test(s))
          && m.sounds.some(s => /grenade-pin\./.test(s)) && m.sounds.some(s => /rocket-launch\./.test(s)); })());
  });

  /* ══════════════════ §3 the live fan-out ══════════════════ */
  await sect("§3", async () => {
    const detonations = [];
    const impacts = [];
    fx._setDetonationSink((e) => detonations.push(e));
    fx._setHitSoundSink((e) => impacts.push(e));
    try {
      const payloadFor = (weapon, over = {}) => ({
        attackerId: shooter.id, attackerTokenId: shTok.id, weaponId: weapon.id, weaponName: weapon.name,
        attackType: weapon.system.attackType, fxTargetTokenId: vicTok.id,
        shotsFired: 1, shotsHit: 1, baseHit: true,
        areaDamages: { Torso: [{ damage: 21 }] }, ...over,
      });

      detonations.length = 0; impacts.length = 0;
      const rThrow = await fx.fxWeaponFired(payloadFor(frag), { remote: true });
      // ⏱ THE SINKS ARE READ AFTER THE ARRIVAL, never in the same tick. The boom is issued on a timer
      // at `arriveIn` (that IS the element under test), so a sink read immediately would be reading
      // the clock rather than the wiring. Waited out by the payload's OWN reported arrival, not a
      // guessed sleep, so the leg stays honest if the ladder is ever re-decoded.
      await sleep(rThrow.arrival.ms + 500);
      out.notes.push(`§3 throw: class=${rThrow.weaponClass} arrival=${rThrow.arrival?.ms}ms band=${rThrow.arrival?.band} tail=${rThrow.settleTailMs}ms`);
        ok("§3 the throw resolves as a delivery payload, one object",
        rThrow.weaponClass === "thrown" && rThrow.delivery?.kind === "thrown" && rThrow.shots === 1 && rThrow.dropped === 0,
        `class=${rThrow.weaponClass} shots=${rThrow.shots}`);
      // ⏪ RE-VALUED 2026-08-28: this asserted the withdrawn hit spray was declined for a delivery
      // payload. The element is gone, so the report carries no field for it at all — which is the
      // stronger statement and the one the removal owes.
      ok("§3 the throw's report carries no hit-spray field at all (the element is withdrawn)",
        rThrow.blood === undefined, JSON.stringify(rThrow.blood));
      ok("§3 the throw sounds ONE detonation and no body impact",
        rThrow.detonationAudio?.queued === 1 && rThrow.hitAudio === null,
        `det=${JSON.stringify(rThrow.detonationAudio)} hit=${JSON.stringify(rThrow.hitAudio)}`);
      ok("§3 the boom is on the arrival clock, at the class level, from the shipped file",
        detonations.length === 1 && detonations[0].delayMs === rThrow.arrival.ms
        && /explosion-big\./.test(detonations[0].src) && detonations[0].volume === 0.85,
        JSON.stringify(detonations));
      ok("§3 no body-impact clip was played for a delivered warhead", impacts.length === 0, JSON.stringify(impacts));

      // the MISS: the object still arrives (p.108 sends its centre to the grenade table, not to nowhere)
      detonations.length = 0;
      const rMiss = await fx.fxWeaponFired(payloadFor(frag, { shotsHit: 0, baseHit: false, areaDamages: {} }), { remote: true });
      await sleep(rMiss.arrival.ms + 500);
      ok("§3 a MISSED throw still arrives and still detonates",
        rMiss.hits === 0 && rMiss.detonationAudio?.queued === 1 && detonations.length === 1,
        `hits=${rMiss.hits} det=${JSON.stringify(rMiss.detonationAudio)}`);

      // the launched picture
      detonations.length = 0;
      const rRocket = await fx.fxWeaponFired(payloadFor(missile), { remote: true });
      await sleep(rRocket.arrival.ms + 500);
      ok("§3 the launched shot resolves as a rocket and sounds its own level",
        rRocket.delivery?.kind === "rocket" && detonations.length === 1 && detonations[0].volume === 0.9,
        `${rRocket.delivery?.kind} vol=${detonations[0]?.volume}`);

      // fxMute at the door
      detonations.length = 0;
      const rMute = await fx.fxWeaponFired(payloadFor(frag, { fxMute: true }), { remote: true });
      await sleep(900);
      ok("§3 fxMute is answered at the door — nothing resolved, nothing sounded",
        rMute.skipped === "muted" && rMute.delivery === null && detonations.length === 0, JSON.stringify(rMute.skipped));

      // determinism: two separate trigger pulls of the same shot agree on the clock
      detonations.length = 0;
      const d1 = await fx.fxWeaponFired(payloadFor(frag), { remote: true });
      const d2 = await fx.fxWeaponFired(payloadFor(frag), { remote: true });
      ok("§3 two trigger pulls agree on the arrival and the tail",
        d1.arrival.ms === d2.arrival.ms && d1.settleTailMs === d2.settleTailMs,
        `${d1.arrival.ms}/${d2.arrival.ms} tail ${d1.settleTailMs}/${d2.settleTailMs}`);

      // NEGATIVE: a bullet is unchanged — no delivery treatment, no boom. ⏪ RE-VALUED 2026-08-28
      // (release gate): this leg used to demand the bullet SOUND its body impact, and the flesh clip
      // is now WITHDRAWN by ruling (effects.js HIT_SOUND — no flesh impact ships until a better clip
      // is found post-release). Against this section's flesh target the honest expectations are a
      // null hit plan and zero plays — and the mute is asserted as the RULING, by kind: flesh
      // delivers nothing while structure still rings.
      detonations.length = 0; impacts.length = 0;
      const rBullet = await fx.fxWeaponFired(payloadFor(pistol, { attackType: "Single" }), { remote: true });
      await sleep(rBullet.arrival.ms + 500);
      ok("§3 NEGATIVE — a bullet payload takes no delivery treatment, and the flesh clip stays withdrawn",
        rBullet.delivery === null && rBullet.detonationAudio === null && detonations.length === 0
        && rBullet.hitAudio === null && impacts.length === 0
        && fx.hitSoundSrc("flesh") === null && fx.hitSoundSrc("structure") !== null,
        `delivery=${rBullet.delivery} det=${detonations.length} impacts=${impacts.length} flesh=${fx.hitSoundSrc("flesh")} structure=${!!fx.hitSoundSrc("structure")}`);
    } finally {
      fx._setDetonationSink(null);
      fx._setHitSoundSink(null);
    }
  });

  /* ══════════════════ §4 the entry wiring, through the REAL fire path ══════════════════ */
  await sect("§4", async () => {
    // Pin the settings the delta assertion depends on, exactly as the sibling detonation keeper does.
    const prev = {};
    const setSetting = async (k, v) => { try { prev[k] = game.settings.get(SCOPE, k); await game.settings.set(SCOPE, k, v); } catch (_e) {} };
    await setSetting("headHitDoubling", false);
    await setSetting("limbModel", "core");
    await setSetting("explosivesDetailed", false);
    await setSetting("combatFxEnabled", false);   // §4 is about the DAMAGE rail; the picture has its own section
    try {
      // give the thrower the skill so the base's own to-hit can land, and aim at the victim
      await shooter.createEmbeddedDocuments("Item", [{ name: "Heavy Weapons", type: "skill", system: { level: 10, stat: "ref" } }]);
      const before = Number(victim.system.damage) || 0;
      const areasBefore = new Set((scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])]).filter(d => F(d).isExplosion).map(d => d.id));

      const msgsBefore = new Set(game.messages.map(m => m.id));
      // The SEAM's own output, captured off the real fire — the field the damage rail routes on has to
      // be on the payload or nothing downstream can work, and a failure here says so by name instead of
      // as a missing area three assertions later.
      const seen = [];
      const spy = (pl) => seen.push(pl);
      Hooks.on("cyberpunk2020.weaponFired", spy);
      try {
        await frag.__weaponRoll({ fireMode: base.fireModes.semiAuto, range: "RangeClose", targetActor: victim }, [{ id: vicTok.id, name: vicTok.name }]);
        for (let i = 0; i < 30 && seen.length === 0; i++) await sleep(150);
      } finally { Hooks.off("cyberpunk2020.weaponFired", spy); }
      ok("§4 the seam stamps the weapon's attack type onto the fired payload",
        seen[0]?.attackType === "Grenade", `payload=${seen.length} attackType=${seen[0]?.attackType}`);
      const landedRounds = Object.values(seen[0]?.areaDamages ?? {}).flat().length;
      out.notes.push(`§4 real fire: baseHit=${seen[0]?.baseHit} rolled rows=${landedRounds}`);

      // The area is placed on the visual-impact clock, so poll generously.
      let area = null;
      for (let i = 0; i < 60; i++) {
        const all = (scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])]);
        area = all.find(d => F(d).isExplosion && !areasBefore.has(d.id)) ?? null;
        if (area) break;
        await sleep(300);
      }
      ok("§4 a thrown grenade routes into the p.108 blast flow (an area was placed)", !!area);
      if (area) {
        const f = F(area);
        ok("§4 the area carries the book radius for a weapon that states none", Number(f.blastRadius) === 5, `radius=${f.blastRadius}`);
        ok("§4 the area's base damage is the weapon's OWN rolled 7d6, not a stand-in",
          Number(f.baseDamage) >= 7 && Number(f.baseDamage) <= 42, `baseDamage=${f.baseDamage}`);
        out.notes.push(`§4 blast baseDamage rolled off 7d6 = ${f.baseDamage}`);

        let btn = null;
        for (let i = 0; i < 40; i++) {
          btn = document.querySelector(`.cp-confirm-explosion[data-template-id="${area.id}"]`);
          if (btn) break;
          await sleep(250);
        }
        ok("§4 the confirm card was posted for this area", !!btn);
        if (btn) {
          btn.click();
          let after = before;
          for (let i = 0; i < 40; i++) { after = Number(victim.system.damage) || 0; if (after > before) break; await sleep(250); }
          // ⏪ RE-VALUED 2026-08-28. This asserted the aimed-at figure ALWAYS took the blast, which was
          // true only because a missed throw used to be centred on it regardless. A miss now lands where
          // the grenade table puts it (§15), so the honest statement is the geometric one: the blast
          // reaches whoever is inside it and nobody else. This fixture's real fire misses often — the
          // note records which branch ran — so the expectation is DERIVED from the placed circle rather
          // than assumed, and the leg is deterministic either way.
          const f4 = F(area);
          const vCen = canvas.tokens.get(vicTok.id).center;
          const ppm4 = gridPx / (Number(scene.grid?.distance) || 1);
          const figureM = Math.hypot(vCen.x - Number(f4.originX), vCen.y - Number(f4.originY)) / ppm4;
          const caught = figureM <= Number(f4.blastRadius);
          // ⚠ THE RIM IS INDETERMINATE, deliberately (2026-08-28): a scatter can land the circle's
          // edge exactly on the fixture's spacing (observed: figure 5.0m, radius 5m), and there the
          // leg's centre-distance arithmetic and the apply's own containment test are two different
          // measures answering a floating-point tie — both answers are honest. Within a tenth of a
          // metre of the rim the leg records the case instead of ruling it.
          const rim = Math.abs(figureM - Number(f4.blastRadius)) < 0.1;
          ok("§4 confirming the blast reaches whoever is inside it, and nobody outside it",
            rim ? true : (caught ? after > before : after === before),
            `${f4.scattered ? `scattered ${f4.scatterDriftM}m ${f4.scatterDirName}` : "on target"}; figure ${figureM.toFixed(1)}m from the centre, radius ${f4.blastRadius}m; damage ${before} → ${after}${rim ? " (rim case — recorded, not ruled)" : ""}`);
          out.notes.push(`§4 blast ${f4.scattered ? "scattered" : "on target"}: figure ${figureM.toFixed(1)}m from the centre (radius ${f4.blastRadius}m), applied ${after - before} (base ${f4.baseDamage})`);
        }
      }
      const newMsgs = game.messages.filter(m => !msgsBefore.has(m.id));
      out.notes.push(`§4 the real fire posted ${newMsgs.length} card(s)`);

      // ⛔ THE EITHER/OR, DRIVEN AT ITS OWN SEAM AND WITH ITS CONTROL. A payload naming a target token
      // is what puts the single-target apply window on screen (PATH A). A detonating payload must
      // never reach it, or the figure at the centre is damaged twice — once by the window and once by
      // the blast. Asserted against a CONTROL payload that differs in exactly one field, so the leg
      // cannot pass because nothing opened a window for unrelated reasons.
      const damageWindows = () =>
        [...foundry.applications.instances.values()].filter(a => /DamageDialog/.test(a?.constructor?.name ?? ""));
      const drive = async (extra) => {
        for (const w of damageWindows()) { try { await w.close(); } catch (_e) {} }
        await sleep(200);
        Hooks.callAll("cyberpunk2020.weaponFired", {
          attackerId: shooter.id, attackerTokenId: shTok.id, weaponName: "__PW__Seam Probe",
          areaDamages: { Torso: [{ damage: 12 }] }, shotsFired: 1, shotsHit: 1,
          targetTokenId: vicTok.id, fxTargetTokenId: vicTok.id, firedByUserId: game.user.id, ...extra,
        });
        for (let i = 0; i < 40 && damageWindows().length === 0; i++) await sleep(150);
        const n = damageWindows().length;
        for (const w of damageWindows()) { try { await w.close(); } catch (_e) {} }
        return n;
      };
      const opensControl = await drive({});
      const opensGrenade = await drive({ attackType: "Grenade" });
      ok("§4 CONTROL — an ordinary payload DOES open the single-target apply window", opensControl === 1, `windows=${opensControl}`);
      ok("§4 NEGATIVE — a detonating payload never opens it (no double application)",
        opensGrenade === 0, `windows=${opensGrenade}`);
    } finally {
      for (const [k, v] of Object.entries(prev)) { try { await game.settings.set(SCOPE, k, v); } catch (_e) {} }
    }
  });

  /* ══════════════════ §5 the unrollable-damage guard ══════════════════ */
  await sect("§5", async () => {
    {
      // ⭐ THE DEFECT, PINNED AT ITS SOURCE: the base builds a Roll from the printed string, and the
      // string the catalogue prints on a launcher is a WORD. This is the throw the guard exists to stop.
      let threw = false;
      try { await new Roll("Varies").evaluate(); } catch (_e) { threw = true; }
      ok("§5 RED — evaluating the printed damage word throws (the reported crash)", threw);

      // The actor's OWN sheet instance — the object the gesture runs on at a real table. Nothing is
      // rendered: the guard is a method on it and takes the item plus a thunk.
      const sheet = shooter.sheet;

      const warns = [];
      const realWarn = ui.notifications.warn.bind(ui.notifications);
      ui.notifications.warn = (m, ...r) => { warns.push(String(m)); return realWarn(m, ...r); };
      try {
        // (a) a weapon that IS its own warhead and prints a word: refused, named, nothing rolled.
        // ⭐ RE-VALUED 2026-08-27 (the standard-round ruling): the EMPTY LAUNCHER no longer belongs here
        // — it now resolves a standard round (§9).
        // ⭐⭐ RE-VALUED AGAIN 2026-08-28 (the word-warhead family), and the subject moved a second time.
        // This leg used to fire a GAS grenade and require the refusal; gas became a word warhead with a
        // modelled consequence that same day, and the other four printed words followed, so every word
        // in the shipped catalogue is now SERVED rather than refused. Requiring a refusal for one of
        // them pins behaviour the module deliberately no longer has.
        // ⛔ WHAT THE REFUSAL STILL COVERS, and what this leg is now about: a word NOTHING models. The
        // admitted set (area-delivery.js `WORD_WARHEADS`) is closed, so a GM-authored word outside it
        // reaches the guard with no consequence behind it — and a shot admitted with nothing behind it
        // is a silent nothing, which is exactly what the message exists to prevent.
        await launcher.update({ "system.ammoItemId": "" });
        const [unmodelled] = await shooter.createEmbeddedDocuments("Item", [{
          name: "__PW__Flash", type: "weapon",
          system: { ...HEAVY, attackType: "Grenade", ammoType: "Grenade", damage: "Flash", range: "50" },
        }]);
        let called = 0;
        const refused = await sheet._cpFireThroughDamageGuard(unmodelled, async () => { called++; return "fired"; });
        ok("§5 a weapon printing a word NOTHING models is refused, not crashed", refused === null && called === 0, `called=${called}`);
        ok("§5 the refusal names the weapon and the fix, localized (no raw key)",
          warns.some(w => w.includes(unmodelled.name) && w.includes("Flash") && !/^CYBERPUNK\./.test(w)),
          warns.join(" | "));
        // …and the counterpart: an ADMITTED word is served instead of refused, on the substituted zero.
        let calledGas = 0;
        const servedGas = await sheet._cpFireThroughDamageGuard(gasGrenade, async () => { calledGas++; return "fired"; });
        ok("§5 a weapon printing an ADMITTED word is served, not refused (the substituted zero)",
          servedGas === "fired" && calledGas === 1, `out=${servedGas} called=${calledGas}`);

        // (b) with a round loaded, the ROUND supplies the formula for the duration of the roll
        await launcher.update({ "system.ammoItemId": round.id });
        let seen = null;
        const outv = await sheet._cpFireThroughDamageGuard(launcher, async () => { seen = launcher._getWeaponSystem().damage; return "fired"; });
        ok("§5 the loaded round's damage stands in during the roll", seen === "7d6" && outv === "fired", `seen=${seen}`);
        ok("§5 the accessor is restored afterwards and the document is untouched",
          launcher._getWeaponSystem().damage === "Varies" && launcher.system.damage === "Varies"
          && !Object.prototype.hasOwnProperty.call(launcher, "_getWeaponSystem"),
          `after=${launcher._getWeaponSystem().damage}`);
        ok("§5 the round's own blast radius reaches the payload fields",
          (await import(`/modules/${SCOPE}/module/seam-shim.js`)).ammoEffectFields(launcher).blastRadius === 5);

        // (c) NEGATIVE: an ordinary weapon passes straight through
        const warnsBefore = warns.length;
        let ranPlain = 0;
        const plain = await sheet._cpFireThroughDamageGuard(frag, async () => { ranPlain++; return "ok"; });
        ok("§5 NEGATIVE — a weapon with a real formula is untouched by the guard",
          plain === "ok" && ranPlain === 1 && warns.length === warnsBefore);
      } finally {
        ui.notifications.warn = realWarn;
      }
    }
  });

  /* ══════════════════ §6 rider R-A — the pair at Mortal ══════════════════ */
  await sect("§6", async () => {
    {
      // Driven through the REAL chain the table uses: the fired-event seam opens the apply window, and
      // the window's own control is what writes the damage and posts the tail. Nothing internal is
      // called — the defect was in what that tail posts.
      const CARD = { death: "death-save-prompt", stun: "stun-save-prompt" };
      const damageWindows = () =>
        [...foundry.applications.instances.values()].filter(a => /DamageDialog/.test(a?.constructor?.name ?? ""));
      const patient = await Actor.create({ name: "__PW__Mortal", type: "character" });
      const [pTok] = await scene.createEmbeddedDocuments("Token", [{ name: patient.name, actorId: patient.id, actorLink: true, x: 800, y: 1400, width: 1, height: 1 }]);
      await sleep(600);
      const prev6 = {};
      const set6 = async (k, v) => { try { prev6[k] = game.settings.get(SCOPE, k); await game.settings.set(SCOPE, k, v); } catch (_e) {} };
      await set6("headHitDoubling", false);
      await set6("limbModel", "core");
      await set6("limbLossEnabled", false);
      await set6("combatFxEnabled", false);
      try {
        await patient.update({ "system.damage": 0 });
        const from = new Set(game.messages.map(m => m.id));
        for (const w of damageWindows()) { try { await w.close(); } catch (_e) {} }
        Hooks.callAll("cyberpunk2020.weaponFired", {
          attackerId: shooter.id, weaponName: "__PW__Mortal Blow",
          areaDamages: { Torso: [{ damage: 40 }] }, shotsFired: 1, shotsHit: 1,
          targetTokenId: pTok.id, fxTargetTokenId: pTok.id, firedByUserId: game.user.id,
        });
        for (let i = 0; i < 100 && damageWindows().length === 0; i++) await sleep(100);
        const win = damageWindows()[0] ?? null;
        const applyCtl = win?.element?.querySelector('[data-action="applyDamage"]') ?? null;
        ok("§6 the apply window opened and carries its own control", !!applyCtl);
        if (applyCtl) {
          applyCtl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          for (let i = 0; i < 100 && damageWindows().length > 0; i++) await sleep(100);
          await sleep(1500);   // the ledger closes (cards + prompts) after the window has gone
          const fresh = [...game.messages].filter(m => !from.has(m.id)).map(m => String(m.content ?? ""));
          const death = fresh.filter(c => c.includes(CARD.death)).length;
          const stun = fresh.filter(c => c.includes(CARD.stun)).length;
          const ws = patient.woundState?.() ?? 0;
          ok("§6 the fixture actually reached Mortal", ws >= 4, `woundState=${ws} damage=${patient.system.damage}`);
          ok("§6 a Mortal apply posts BOTH prompts — the death save AND the consciousness check",
            death === 1 && stun === 1, `death=${death} stun=${stun}`);
        }
        // NEGATIVE / the other side of the same rule: below Mortal, the stun prompt alone.
        await patient.update({ "system.damage": 0 });
        const from2 = new Set(game.messages.map(m => m.id));
        Hooks.callAll("cyberpunk2020.weaponFired", {
          attackerId: shooter.id, weaponName: "__PW__Light Blow",
          areaDamages: { Torso: [{ damage: 5 }] }, shotsFired: 1, shotsHit: 1,
          targetTokenId: pTok.id, fxTargetTokenId: pTok.id, firedByUserId: game.user.id,
        });
        for (let i = 0; i < 100 && damageWindows().length === 0; i++) await sleep(100);
        const win2 = damageWindows()[0] ?? null;
        const ctl2 = win2?.element?.querySelector('[data-action="applyDamage"]') ?? null;
        ctl2?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        for (let i = 0; i < 100 && damageWindows().length > 0; i++) await sleep(100);
        await sleep(1500);
        const fresh2 = [...game.messages].filter(m => !from2.has(m.id)).map(m => String(m.content ?? ""));
        ok("§6 NEGATIVE — below Mortal the window posts the consciousness check and no death save",
          fresh2.filter(c => c.includes(CARD.stun)).length === 1 && fresh2.filter(c => c.includes(CARD.death)).length === 0,
          `stun=${fresh2.filter(c => c.includes(CARD.stun)).length} death=${fresh2.filter(c => c.includes(CARD.death)).length}`);
      } finally {
        for (const w of damageWindows()) { try { await w.close(); } catch (_e) {} }
        for (const [k, v] of Object.entries(prev6)) { try { await game.settings.set(SCOPE, k, v); } catch (_e) {} }
        await pTok.delete().catch(() => {});
        await patient.delete().catch(() => {});
      }
    }
  });

  /* ══════════════════ §7 rider R-B — the breached wall's Repair control ══════════════════ */
  await sect("§7", async () => {
    {
      const cov = await import(`/modules/${SCOPE}/module/combat/cover.js`);
      const [wall] = await scene.createEmbeddedDocuments("Wall", [{
        c: [900, 1600, 1100, 1600], move: 20, sight: 20,
        flags: { [SCOPE]: { __pwGrenade: true, coverSp: 20, coverPool: 60, coverPoolMax: 60 } },
      }]);
      await wall.sheet.render(true);
      for (let i = 0; i < 40 && !wall.sheet?.element?.querySelector(".cp-cover-wall-fields"); i++) await sleep(200);
      const root = () => wall.sheet?.element ?? null;
      ok("§7 the cover fieldset is injected into the native wall sheet", !!root()?.querySelector(".cp-cover-wall-fields"));
      ok("§7 an unbreached wall shows no Repair control", !root()?.querySelector(".cp-cover-wall-repair"));
      ok("§7 RED-GUARD — exactly one fieldset, never two", (root()?.querySelectorAll(".cp-cover-wall-fields").length ?? 0) === 1);

      // breach it WHILE THE SHEET IS OPEN
      await wall.setFlag(SCOPE, "coverBreach", { door: 0, ds: 0, at: Date.now() });
      let repair = null;
      for (let i = 0; i < 40; i++) { repair = root()?.querySelector(".cp-cover-wall-repair"); if (repair) break; await sleep(200); }
      ok("§7 a breach with the sheet OPEN grows the Repair control, with no close-and-reopen", !!repair);
      ok("§7 and still exactly one fieldset after the rebuild", (root()?.querySelectorAll(".cp-cover-wall-fields").length ?? 0) === 1);

      // an unrelated re-render must NOT rebuild (the double-injection guard still holds)
      const stamped = root()?.querySelector(".cp-cover-wall-fields")?.dataset?.cpCoverState;
      await wall.sheet.render(false);
      await sleep(700);
      ok("§7 an unchanged re-render keeps the same fieldset",
        root()?.querySelector(".cp-cover-wall-fields")?.dataset?.cpCoverState === stamped
        && (root()?.querySelectorAll(".cp-cover-wall-fields").length ?? 0) === 1, `stamp=${stamped}`);
      try { await wall.sheet.close(); } catch (_e) {}
      await wall.delete().catch(() => {});
      void cov;
    }
  });

  /* ══════════════════ §8 the launcher's ROUNDS — the authored pack ammo ══════════════════
   * ⛔ WHAT THIS SECTION EXISTS FOR. The launcher shipped guard-refusing out of the box: the guard
   * worked (a message, not a crash) but there was NO LOADABLE GRENADE AMMO ANYWHERE — every grenade in
   * every pack is a WEAPON, and a weapon cannot be put in a tube. Two `ammo` items now answer that, and
   * the four things that have to be true of them are the four things below: they survive the DataModel,
   * the base reload picker OFFERS them for the pack launcher, firing with one produces a rollable
   * warhead instead of the refusal, and the detonation reaches the p.108 flow by the ORIGINAL
   * ammo-triggered door (`effectTypes` including "Explosive") rather than only by the weapon's type.
   */
  await sect("§8", async () => {
    const gunner = await Actor.create({ name: "__PW__Gunner", type: "character" });
    // ⚠ THE GUNNER NEEDS A FIGURE ON THE MAP, and the reason is the flow under test rather than tidiness:
    // the base fire path leaves `targetTokenId` null on this call shape, so `_placeExplosion` centres the
    // blast on the SHOOTER's figure — and an actor with no token gives it no point to centre on, so it
    // returns and no area is ever placed. Diagnosed on a probe: identical fire, token present, area 5 m.
    const [gTok] = await scene.createEmbeddedDocuments("Token", [{
      name: gunner.name, actorId: gunner.id, actorLink: true, x: 800, y: 1800, width: 1, height: 1,
    }]);
    await sleep(600);
    try {
      ok("§8 harness guard — the gunner's figure is on the canvas this section measures from",
        canvas.scene?.id === scene.id && !!canvas.tokens.get(gTok.id), `scene=${canvas.scene?.id}`);
      await gunner.createEmbeddedDocuments("Item", [{ name: "Heavy Weapons", type: "skill", system: { level: 10, stat: "ref" } }]);

      // ── the rounds, created from the shipping SOURCE data ──────────────────────────────────────
      const madeRounds = await gunner.createEmbeddedDocuments("Item",
        ROUND_SOURCES.map((d) => ({ name: d.name, type: d.type, img: d.img, system: d.system })));
      const byName = (n) => gunner.items.find(i => i.name === n) ?? null;
      const fragRound = byName("Fragmentation Grenade Round");
      const incRound = byName("Incendiary Grenade Round");
      ok("§8 both authored rounds are created as ammo documents",
        madeRounds.length === 2 && fragRound?.type === "ammo" && incRound?.type === "ammo",
        `created=${madeRounds.length} types=${fragRound?.type}/${incRound?.type}`);

      // ⭐ THE VANILLA-STRIP GUARD. `caliber` is the module's own net-new field and the base 1.1.1 ammo
      // model drops it on write; `bonusDamageFormula` is 1.1.1's ONLY damage-bearing ammo field and is
      // what makes the round's warhead reachable without a schema change. If either is stripped, the
      // round is inert and every leg below would fail for a reason that has nothing to do with them.
      ok("§8 the round's cartridge and warhead survive the write on this host",
        fragRound?.system?.caliber === "Grenade" && fragRound?.system?.ammoType === "Grenade"
        && fragRound?.system?.bonusDamageFormula === "7d6",
        `caliber=${fragRound?.system?.caliber} ammoType=${fragRound?.system?.ammoType} dmg=${fragRound?.system?.bonusDamageFormula}`);
      ok("§8 the frag round declares the explosive effect type, by value",
        Array.isArray(fragRound?.system?.effectTypes) && fragRound.system.effectTypes.includes("Explosive"),
        JSON.stringify(fragRound?.system?.effectTypes));
      ok("§8 the incendiary round carries the printed 4d6 and the fire burn the DoT flow reads",
        incRound?.system?.bonusDamageFormula === "4d6" && incRound?.system?.dotEnabled === true
        && incRound?.system?.dotType === "fire" && Number(incRound?.system?.dotTurns) === 2
        && incRound?.system?.dotDamageFormula === "4d6"
        && incRound.system.effectTypes.includes("Explosive") && incRound.system.effectTypes.includes("DoT"),
        `dmg=${incRound?.system?.bonusDamageFormula} dot=${incRound?.system?.dotEnabled}/${incRound?.system?.dotType}/${incRound?.system?.dotTurns}/${incRound?.system?.dotDamageFormula}`);
      // ⛔ THE FREE-GRENADE HOLE, closed on the item rather than in the registry. "Grenade" is not a
      // registered CALIBER, and an unregistered caliber falls to the "none" cost class — box 1 at price
      // 0 — so the ammo sheet's own restock control would hand out a warhead for nothing. Stating the
      // mirrored 30 eb on the item is what the restock reads FIRST, so no registry entry (and no
      // invented cost class) is needed to make the control honest.
      const lk = await import(`/modules/${SCOPE}/module/lookups.js`);
      ok("§8 the rounds price their own restock, since an unregistered caliber prices at zero",
        Number(fragRound?.system?.boxSize) === 1 && Number(fragRound?.system?.boxCost) === 30
        && Number(incRound?.system?.boxCost) === 30
        && lk.getAmmoBoxPrice("Grenade", "standard") === 0,
        `item=${fragRound?.system?.boxCost}eb registry=${lk.getAmmoBoxPrice("Grenade", "standard")}eb`);
      ok("§8 neither round states a radius, so the book's own grenade row still answers for it",
        Number(fragRound?.system?.blastRadius) === 0 && Number(incRound?.system?.blastRadius) === 0,
        `frag=${fragRound?.system?.blastRadius} inc=${incRound?.system?.blastRadius}`);

      // ── the PACK launcher (the real document, through the corrections chain) ────────────────────
      const packLauncher = await fromUuid("Compendium.cyberpunk2020.heavy.Item.u9R4ZnzKOlIFva0o");
      ok("§8 the pack Grenade Launcher was found in the base compendium", !!packLauncher, packLauncher?.name);
      const [gl] = await gunner.createEmbeddedDocuments("Item", [packLauncher.toObject()]);
      ok("§8 the pack launcher chambers 'Grenade' and prints an unrollable warhead of its own",
        gl.system.ammoType === "Grenade" && gl.system.damage === "Varies",
        `ammoType=${gl.system.ammoType} damage=${gl.system.damage}`);

      // a NON-matching cartridge, so the picker leg cannot pass by listing everything
      const [nineMil] = await gunner.createEmbeddedDocuments("Item", [{
        name: "__PW__9mm Ball", type: "ammo", system: { caliber: "9mm", ammoType: "9mm", quantity: 30 },
      }]);

      // ⭐ OUTCOME, NOT PRESENCE: the RENDERED select is read, not the helper. The picker is what a GM
      // actually uses to load the tube, and its `data-*`/option values are the wiring that has silently
      // broken before elsewhere in this module.
      await gl.sheet.render(true);
      let sel = null;
      for (let i = 0; i < 40; i++) {
        sel = gl.sheet?.element?.querySelector('select[name="system.ammoItemId"]');
        if (sel) break;
        await sleep(200);
      }
      ok("§8 the launcher's own sheet renders a reload control", !!sel);
      const optionIds = sel ? [...sel.options].map(o => o.value) : [];
      ok("§8 the reload control OFFERS both grenade rounds — the caliber matched",
        optionIds.includes(fragRound.id) && optionIds.includes(incRound.id),
        `options=${optionIds.length}`);
      ok("§8 NEGATIVE — a 9mm cartridge is not offered for a grenade tube",
        !optionIds.includes(nineMil.id), `options=${optionIds.join(",")}`);
      try { await gl.sheet.close(); } catch (_e) {}

      // ── firing with the round in: a rollable warhead, and no refusal ────────────────────────────
      const sheet = gunner.sheet;
      const warns = [];
      const realWarn = ui.notifications.warn.bind(ui.notifications);
      ui.notifications.warn = (m, ...r) => { warns.push(String(m)); return realWarn(m, ...r); };
      try {
        // ⭐ RE-VALUED 2026-08-27 (the standard-round ruling). This gunner OWNS the frag round, so an
        // empty tube is no longer the reported red state — it takes the shot with the standard round's
        // printed 7d6 and says nothing. §9 exercises the ladder's other rungs.
        await gl.update({ "system.ammoItemId": "" });
        let ranEmpty = 0, seenEmpty = null;
        const firedEmpty = await sheet._cpFireThroughDamageGuard(gl, async () => {
          ranEmpty++; seenEmpty = gl._getWeaponSystem().damage; return "fired";
        });
        ok("§8 an unloaded pack launcher fires the OWNED standard round, with no refusal",
          firedEmpty === "fired" && ranEmpty === 1 && seenEmpty === "7d6" && warns.length === 0,
          `called=${ranEmpty} damage=${seenEmpty} warns=${warns.length}`);

        await gl.update({ "system.ammoItemId": fragRound.id });
        const warnsBefore = warns.length;
        let seenFrag = null, ranFrag = 0;
        const firedFrag = await sheet._cpFireThroughDamageGuard(gl, async () => {
          ranFrag++; seenFrag = gl._getWeaponSystem().damage; return "fired";
        });
        ok("§8 with the frag round loaded the shot is taken, with the round's 7d6 as the warhead",
          firedFrag === "fired" && ranFrag === 1 && seenFrag === "7d6" && warns.length === warnsBefore,
          `damage=${seenFrag} warns=${warns.length - warnsBefore}`);
        ok("§8 and the roll the base would build off it actually evaluates",
          (await new Roll(seenFrag).evaluate()).total >= 7, `formula=${seenFrag}`);

        await gl.update({ "system.ammoItemId": incRound.id });
        let seenInc = null;
        await sheet._cpFireThroughDamageGuard(gl, async () => { seenInc = gl._getWeaponSystem().damage; return "fired"; });
        ok("§8 swapping the round swaps the warhead — the incendiary supplies its own 4d6",
          seenInc === "4d6", `damage=${seenInc}`);
        ok("§8 the accessor is restored and the launcher document is untouched by either shot",
          gl.system.damage === "Varies" && gl._getWeaponSystem().damage === "Varies"
          && !Object.prototype.hasOwnProperty.call(gl, "_getWeaponSystem"));
      } finally {
        ui.notifications.warn = realWarn;
      }

      // ── the ORIGINAL ammo-triggered door, and the fields that walk through it ───────────────────
      const seam = await import(`/modules/${SCOPE}/module/seam-shim.js`);
      await gl.update({ "system.ammoItemId": fragRound.id });
      const fieldsFrag = seam.ammoEffectFields(gl);
      ok("§8 the loaded round's effect types reach the fired payload's fields",
        Array.isArray(fieldsFrag.effectTypes) && fieldsFrag.effectTypes.includes("Explosive")
        && fieldsFrag.caliber === "Grenade",
        JSON.stringify(fieldsFrag.effectTypes));
      // ⛔ THE DOOR UNDER TEST IS THE OLD ONE. `attackType` is deliberately absent, so if this passes it
      // passed through `effectTypes` — the route that has always existed — and not through the 2026-08-27
      // widening that lets a grenade WEAPON detonate on its own.
      ok("§8 a payload carrying only the round's effect types detonates (the ammo door, not the type door)",
        AD.payloadDetonates({ effectTypes: fieldsFrag.effectTypes }) === true
        && AD.payloadDetonates({ effectTypes: ["None"] }) === false,
        JSON.stringify(fieldsFrag.effectTypes));
      await gl.update({ "system.ammoItemId": incRound.id });
      const fieldsInc = seam.ammoEffectFields(gl);
      ok("§8 the incendiary's burn fields reach the payload too, by value",
        fieldsInc.dotEnabled === true && fieldsInc.dotType === "fire"
        && Number(fieldsInc.dotTurns) === 2 && fieldsInc.dotDamageFormula === "4d6",
        `${fieldsInc.dotEnabled}/${fieldsInc.dotType}/${fieldsInc.dotTurns}/${fieldsInc.dotDamageFormula}`);

      // ── live: fire the pack launcher for real and read the round's damage off the confirm card ──
      const prev8 = {};
      const set8 = async (k, v) => { try { prev8[k] = game.settings.get(SCOPE, k); await game.settings.set(SCOPE, k, v); } catch (_e) {} };
      await set8("combatFxEnabled", false);
      await set8("explosivesDetailed", false);
      try {
        await gl.update({ "system.ammoItemId": fragRound.id, "system.shotsLeft": "1" });
        const areasBefore = new Set((scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])]).filter(d => F(d).isExplosion).map(d => d.id));
        const seen8 = [];
        const spy8 = (pl) => seen8.push(pl);
        Hooks.on("cyberpunk2020.weaponFired", spy8);
        try {
          await sheet._cpFireThroughDamageGuard(gl, async () =>
            gl.__weaponRoll({ fireMode: base.fireModes.semiAuto, range: "RangeClose", targetActor: victim }, [{ id: vicTok.id, name: vicTok.name }]));
          for (let i = 0; i < 30 && seen8.length === 0; i++) await sleep(150);
        } finally { Hooks.off("cyberpunk2020.weaponFired", spy8); }
        ok("§8 the real launcher fire raises a payload carrying the round's explosive type",
          !!seen8[0] && (seen8[0].effectTypes ?? []).includes("Explosive"),
          `payloads=${seen8.length} types=${JSON.stringify(seen8[0]?.effectTypes)}`);

        let area8 = null;
        for (let i = 0; i < 60; i++) {
          const all = (scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])]);
          area8 = all.find(d => F(d).isExplosion && !areasBefore.has(d.id)) ?? null;
          if (area8) break;
          await sleep(300);
        }
        ok("§8 the launched round places a blast area (the p.108 flow was entered)", !!area8);
        if (area8) {
          const f8 = F(area8);
          // ⭐ THE DECODE: 7d6 is 7..42, and 4d6 could not reach 43 — so a base damage inside that
          // window with the frag round loaded says the ROUND's warhead was the thing that was rolled.
          ok("§8 the blast's base damage decodes as the ROUND's 7d6, not the tube's word",
            Number(f8.baseDamage) >= 7 && Number(f8.baseDamage) <= 42, `baseDamage=${f8.baseDamage}`);
          ok("§8 and the area took the book's grenade radius, since the round states none",
            Number(f8.blastRadius) === 5, `radius=${f8.blastRadius}`);
          out.notes.push(`§8 launched frag: baseDamage=${f8.baseDamage} radius=${f8.blastRadius}m`);
          let btn8 = null;
          for (let i = 0; i < 40; i++) { btn8 = document.querySelector(`.cp-confirm-explosion[data-template-id="${area8.id}"]`); if (btn8) break; await sleep(250); }
          ok("§8 a confirm card was posted for the launched round's blast", !!btn8);
          await area8.delete().catch(() => {});
        }
      } finally {
        for (const [k, v] of Object.entries(prev8)) { try { await game.settings.set(SCOPE, k, v); } catch (_e) {} }
      }
    } finally {
      await gTok.delete().catch(() => {});   // tokens BEFORE actors
      await gunner.delete().catch(() => {});
    }
  });

  /* ══════════════════ §9 the STANDARD-ROUND ladder for an empty tube ══════════════════ */
  await sect("§9", async () => {
    // ⛔ THE RULING BEING CERTIFIED (user, 2026-08-27): an empty grenade tube must fire a standard
    // round rather than post a refusal. The four rungs are loaded round → owned standard round → the
    // module pack's own Fragmentation Grenade Round → the message. Every rung is asserted by VALUE,
    // and the scope counter-example (a gas grenade) is asserted beside them.
    const PACK = "supplement-heavy";
    const FRAG_ID = "2smdtLN5J0FvhvoS";
    const fragSrc = ROUND_SOURCES.find(d => d._id === FRAG_ID);
    const packRef = game.packs.find(p => p?.metadata?.packageName === SCOPE && p?.metadata?.name === PACK) ?? null;

    // ── (a) the scope predicate, by value on real documents ────────────────────────────────────
    ok("§9 the tube defers its damage to a round; the weapons that carry their own do not",
      AD.defersDamageToGrenadeRound(launcher) === true
      && AD.defersDamageToGrenadeRound(gasGrenade) === false
      && AD.defersDamageToGrenadeRound(frag) === false
      && AD.defersDamageToGrenadeRound(missile) === false
      && AD.defersDamageToGrenadeRound(pistol) === false,
      `launcher=${AD.defersDamageToGrenadeRound(launcher)} gas=${AD.defersDamageToGrenadeRound(gasGrenade)} frag=${AD.defersDamageToGrenadeRound(frag)}`);
    ok("§9 the compendium key is DERIVED from the module's own pack registration, not written out",
      AD.standardGrenadeRoundUuid() === `Compendium.${SCOPE}.${PACK}.Item.${FRAG_ID}`,
      AD.standardGrenadeRoundUuid() || "(pack not registered)");

    const empty = await Actor.create({ name: "__PW__Empty Tube", type: "character" });
    const stocked = await Actor.create({ name: "__PW__Stocked Tube", type: "character" });
    let createdInPack = false, wasLocked = null, sTok = null;
    try {
      const packLauncher = await fromUuid("Compendium.cyberpunk2020.heavy.Item.u9R4ZnzKOlIFva0o");
      const [glE] = await empty.createEmbeddedDocuments("Item", [packLauncher.toObject()]);
      const [glS] = await stocked.createEmbeddedDocuments("Item", [packLauncher.toObject()]);
      await glE.update({ "system.ammoItemId": "" });
      await glS.update({ "system.ammoItemId": "" });

        SECT="§9(b) rung4";
    // ── (b) RUNG 4 — nothing owned, and whatever this world's pack actually holds ────────────
      const packHas = packRef ? !!(await packRef.getDocument(FRAG_ID).catch(() => null)) : false;
      out.notes.push(`§9 pack registered=${!!packRef} already holds the standard round=${packHas}`);
      const bare = await AD.warheadDamageFor(glE);
      ok("§9 with nothing owned the ladder answers exactly what the pack holds — never an invented number",
        bare === (packHas ? "7d6" : ""), `warhead=${JSON.stringify(bare)} packHas=${packHas}`);

      const sheetE = empty.sheet;
      const warnsE = [];
      const realWarnE = ui.notifications.warn.bind(ui.notifications);
      ui.notifications.warn = (m, ...r) => { warnsE.push(String(m)); return realWarnE(m, ...r); };
      try {
        let ranBare = 0;
        const outBare = await sheetE._cpFireThroughDamageGuard(glE, async () => { ranBare++; return "fired"; });
        ok("§9 the message is what is LEFT when no round exists anywhere, and only then",
          packHas ? (outBare === "fired" && ranBare === 1 && warnsE.length === 0)
                  : (outBare === null && ranBare === 0 && warnsE.length === 1),
          `out=${outBare} called=${ranBare} warns=${warnsE.length}`);

          SECT="§9(c) rung3";
        // ── (c) RUNG 3 — the module pack's own entry, read (not created into inventory) ─────────
        if (packRef && !packHas) {
          wasLocked = packRef.locked;
          if (wasLocked) await packRef.configure({ locked: false });
          const seed = foundry.utils.deepClone(fragSrc);
          delete seed._key;
          await Item.create(seed, { pack: packRef.collection, keepId: true });
          createdInPack = true;
        }
        const packDoc = packRef ? await packRef.getDocument(FRAG_ID).catch(() => null) : null;
        ok("§9 HARNESS GUARD — the standard round is readable in the module pack before rung 3 is measured",
          !!packDoc && packDoc.system?.bonusDamageFormula === "7d6",
          `doc=${packDoc?.name} dmg=${packDoc?.system?.bonusDamageFormula}`);

        const itemsBefore = empty.items.size;
        const fromPack = await AD.warheadDamageFor(glE);
        ok("§9 RUNG 3 — an empty tube on an actor owning nothing fires the PACK's standard round, 7d6",
          fromPack === "7d6", `warhead=${JSON.stringify(fromPack)}`);
        ok("§9 rung 3 adds NOTHING to the inventory and writes nothing to the tube",
          empty.items.size === itemsBefore && glE.system.damage === "Varies"
          && !Object.prototype.hasOwnProperty.call(glE, "_getWeaponSystem"),
          `items ${itemsBefore}→${empty.items.size} damage=${glE.system.damage}`);

        const warnsBeforePack = warnsE.length;
        let seenPack = null, ranPack = 0;
        const firedPack = await sheetE._cpFireThroughDamageGuard(glE, async () => {
          ranPack++; seenPack = glE._getWeaponSystem().damage; return "fired";
        });
        ok("§9 and the gesture takes the shot with it, silently — no refusal reaches the referee",
          firedPack === "fired" && ranPack === 1 && seenPack === "7d6" && warnsE.length === warnsBeforePack,
          `damage=${seenPack} warns=${warnsE.length - warnsBeforePack}`);
      } finally {
        ui.notifications.warn = realWarnE;
      }

      SECT="§9(d) rung2";
      // ── (d) RUNG 2 — an owned round wins over the pack, and STANDARD wins over the rest ───────
      // Created worst-first on purpose: a resolver that took "the first ammo item" would answer 1d6.
      const [oddRound] = await stocked.createEmbeddedDocuments("Item", [{
        name: "__PW__Practice Round", type: "ammo",
        system: { caliber: "Grenade", ammoType: "Grenade", quantity: 3, bonusDamageFormula: "1d6" },
      }]);
      const [wrongCal] = await stocked.createEmbeddedDocuments("Item", [{
        name: "__PW__9mm Ball", type: "ammo",
        system: { caliber: "9mm", ammoType: "9mm", quantity: 30, bonusDamageFormula: "9d6" },
      }]);
      ok("§9 RUNG 2 — with only a non-standard grenade round owned, THAT round answers (not the pack)",
        (await AD.warheadDamageFor(glS)) === "1d6", `warhead=${await AD.warheadDamageFor(glS)}`);
      ok("§9 NEGATIVE — a 9mm cartridge is never a grenade tube's default",
        (await AD.warheadDamageFor(glS)) !== "9d6");

      const namedSrc = foundry.utils.deepClone(fragSrc);
      delete namedSrc._key; delete namedSrc._id; delete namedSrc._stats;
      namedSrc.system.bonusDamageFormula = "5d6";     // a name match, deliberately mis-valued
      const [byName] = await stocked.createEmbeddedDocuments("Item", [namedSrc]);
      ok("§9 the FRAGMENTATION round is preferred over the other grenade rounds owned (standard-first)",
        (await AD.warheadDamageFor(glS)) === "5d6", `warhead=${await AD.warheadDamageFor(glS)}`);

      const sourcedSrc = foundry.utils.deepClone(fragSrc);
      delete sourcedSrc._key; delete sourcedSrc._id;
      sourcedSrc.name = "__PW__Renamed Frag";
      sourcedSrc._stats = { compendiumSource: AD.standardGrenadeRoundUuid() };
      const [bySource] = await stocked.createEmbeddedDocuments("Item", [sourcedSrc]);
      ok("§9 HARNESS GUARD — the source pointer survived the write, so the rung below is real",
        bySource._stats?.compendiumSource === AD.standardGrenadeRoundUuid(),
        `source=${bySource._stats?.compendiumSource}`);
      ok("§9 the SOURCE POINTER outranks the name — a renamed copy of the standard round still answers",
        (await AD.warheadDamageFor(glS)) === "7d6", `warhead=${await AD.warheadDamageFor(glS)}`);

      SECT="§9(e) loaded-wins";
      // ── (e) REGRESSION — an explicitly loaded round still beats every default ─────────────────
      const [sabot] = await stocked.createEmbeddedDocuments("Item", [{
        name: "__PW__Loaded Sabot", type: "ammo",
        system: { caliber: "Grenade", ammoType: "Grenade", quantity: 2, bonusDamageFormula: "3d6" },
      }]);
      await glS.update({ "system.ammoItemId": sabot.id });
      ok("§9 REGRESSION — the round actually in the tube wins over every default rung",
        (await AD.warheadDamageFor(glS)) === "3d6", `warhead=${await AD.warheadDamageFor(glS)}`);
      const sheetS = stocked.sheet;
      let seenLoaded = null;
      await sheetS._cpFireThroughDamageGuard(glS, async () => { seenLoaded = glS._getWeaponSystem().damage; return "fired"; });
      ok("§9 and the gesture shadows the LOADED round's formula, not the standard one",
        seenLoaded === "3d6", `damage=${seenLoaded}`);
      await glS.update({ "system.ammoItemId": "" });

      SECT="§9(f) second-act";
      // ── (f) SECOND ACT — the same gesture twice agrees, and leaves nothing behind ─────────────
      const twice = [];
      for (let i = 0; i < 2; i++) {
        await sheetS._cpFireThroughDamageGuard(glS, async () => { twice.push(glS._getWeaponSystem().damage); return "fired"; });
      }
      ok("§9 two trigger pulls on the empty tube resolve the same standard round",
        twice.length === 2 && twice[0] === "7d6" && twice[1] === "7d6", JSON.stringify(twice));
      ok("§9 the accessor is restored after the defaulted shots and the document is untouched",
        glS.system.damage === "Varies" && glS._getWeaponSystem().damage === "Varies"
        && !Object.prototype.hasOwnProperty.call(glS, "_getWeaponSystem"));

      SECT="§9(g) scope";
      // ── (g) the SCOPE counter-example, through the same gesture ───────────────────────────────
      const [gasG] = await stocked.createEmbeddedDocuments("Item", [{
        name: "__PW__Pack Gas", type: "weapon",
        system: { ...HEAVY, attackType: "Grenade", ammoType: "Grenade", damage: "Gas", range: "50" },
      }]);
      ok("§9 SCOPE — a gas grenade is NOT given a frag warhead by the ladder",
        (await AD.warheadDamageFor(gasG)) === "", `warhead=${JSON.stringify(await AD.warheadDamageFor(gasG))}`);
      const warnsG = [];
      const realWarnG = ui.notifications.warn.bind(ui.notifications);
      ui.notifications.warn = (m, ...r) => { warnsG.push(String(m)); return realWarnG(m, ...r); };
      let ranG = 0;
      try {
        // ⭐ RE-VALUED 2026-08-28 (the word-warhead family). This used to require the guard MESSAGE for
        // a gas grenade. The ladder's scope is unchanged and still the point of the leg above — a gas
        // tube is never handed a frag warhead — but the SHOT is no longer refused: gas is an admitted
        // word warhead, so the guard substitutes a rollable zero and the shot completes to raise its
        // cloud. Refusing it was the defect the gas unit fixed, so the assertion is inverted to match
        // the shipped contract: no warning at all, and the thunk reached.
        const outG = await sheetS._cpFireThroughDamageGuard(gasG, async () => { ranG++; return "fired"; });
        ok("§9 SCOPE — and the shot is SERVED on a substituted zero, with no guard message",
          outG === "fired" && ranG === 1 && warnsG.length === 0,
          `out=${outG} called=${ranG} warns=${JSON.stringify(warnsG)}`);
      } finally { ui.notifications.warn = realWarnG; }

      SECT="§9(h) live";
      // ── (h) LIVE: the empty tube fired for real places a blast priced off the standard round ──
      const prev9 = {};
      const set9 = async (k, v) => { try { prev9[k] = game.settings.get(SCOPE, k); await game.settings.set(SCOPE, k, v); } catch (_e) {} };
      await set9("combatFxEnabled", false);
      await set9("explosivesDetailed", false);
      [sTok] = await scene.createEmbeddedDocuments("Token", [{ name: stocked.name, actorId: stocked.id, actorLink: true, x: 800, y: 1600, width: 1, height: 1 }]);
      await sleep(600);
      try {
        // HARNESS GUARD: a fan-out that cannot see the shooter's figure aims from its facing instead.
        ok("§9 HARNESS GUARD — the canvas can see the shooter before the live shot is measured",
          canvas.scene?.id === scene.id && !!canvas.tokens?.get(sTok.id));
        // Only the standard-round rungs are in play: the tube is empty and the ODD rounds are gone.
        for (const it of [oddRound, byName, sabot, wrongCal]) await it.delete().catch(() => {});
        await glS.update({ "system.ammoItemId": "", "system.shotsLeft": "1" });
        ok("§9 the empty tube's warhead is the standard round's 7d6 at the moment of the live shot",
          (await AD.warheadDamageFor(glS)) === "7d6");
        const areasBefore = new Set((scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])]).filter(d => F(d).isExplosion).map(d => d.id));
        await sheetS._cpFireThroughDamageGuard(glS, async () =>
          glS.__weaponRoll({ fireMode: base.fireModes.semiAuto, range: "RangeClose", targetActor: victim }, [{ id: vicTok.id, name: vicTok.name }]));
        let area9 = null;
        for (let i = 0; i < 60; i++) {
          const all = (scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])]);
          area9 = all.find(d => F(d).isExplosion && !areasBefore.has(d.id)) ?? null;
          if (area9) break;
          await sleep(300);
        }
        ok("§9 firing the EMPTY tube enters the p.108 blast flow (the shot happened at all)", !!area9);
        if (area9) {
          const f9 = F(area9);
          // ⭐ THE DECODE: 7d6 is 7..42. A 1d6 practice round could not reach 7 as a floor and the
          // tube itself has no number at all, so a base damage in that window says the STANDARD round
          // was what got rolled.
          ok("§9 the blast's base damage decodes as the standard round's 7d6",
            Number(f9.baseDamage) >= 7 && Number(f9.baseDamage) <= 42, `baseDamage=${f9.baseDamage}`);
          ok("§9 and the area still takes the book's grenade radius", Number(f9.blastRadius) === 5, `radius=${f9.blastRadius}`);
          out.notes.push(`§9 empty-tube default: baseDamage=${f9.baseDamage} radius=${f9.blastRadius}m`);
          await area9.delete().catch(() => {});
        }
      } finally {
        // ⚠ THE SHOOTER'S FIGURE IS **NOT** DELETED HERE (root-caused 2026-08-28). Deleting it the
        // instant the area was read left a floating consumer of the fired-shot chain holding the token
        // id, and Foundry's own handler reported it as `id [<sTok>] does not exist in the
        // EmbeddedCollection` — a HARNESS fault that reads exactly like a product red. It goes in the
        // outer finally, after a settle, tokens before actors.
        for (const [k, v] of Object.entries(prev9)) { try { await game.settings.set(SCOPE, k, v); } catch (_e) {} }
      }
    } finally {
      SECT="§9(z) teardown";
      await sleep(1500);                       // let the fired-shot chain finish with the figure
      if (sTok) await sTok.delete().catch(() => {});   // tokens BEFORE actors
      if (createdInPack && packRef) {
        const d = await packRef.getDocument(FRAG_ID).catch(() => null);
        if (d) await d.delete().catch(() => {});
        const gone = !(await packRef.getDocument(FRAG_ID).catch(() => null));
        ok("§9 CLEANUP — the pack fixture was removed and the compendium is back as it was", gone);
        if (wasLocked) await packRef.configure({ locked: true }).catch(() => {});
      }
      await empty.delete().catch(() => {});
      await stocked.delete().catch(() => {});
    }
  });

  /* ══════════════════ §10 the attack-modifiers ROW GATING ══════════════════
   * MECHANISM: `rangedModifiers` (module/lookups.js) builds the rows the attack window renders and
   * submits. The called-shot row costs −4 to hit and buys a declared damage location; a weapon whose
   * damage the blast flow takes over has no such location to steer, so the row is REMOVED from the
   * returned arrays — not hidden, because a hidden row is still a field that can still be submitted
   * and still be charged for. Asserted on the returned rows AND on the rendered window's own DOM. */
  let rifle = null;
  await sect("§10", async () => {
    const lk = await import(`/modules/${SCOPE}/module/lookups.js`);
    const paths = (w) => lk.rangedModifiers(w, [], {}).flat().map(r => r.dataPath);

    rifle = await mkWeapon("__PW__Rifle", {
      weaponType: base.weaponTypes.rifle, attackType: "Single", ammoType: "5.56mm",
      damage: "5d6", range: "400", shots: "20", shotsLeft: "20", rof: "1", accuracy: 0, attackSkill: "Rifle",
    });
    // §11 counts LANDED shots, so the shooter needs the rifle's own skill for its to-hit to clear the
    // point-blank DC as reliably as the delivery weapon's does (§4 gave it Heavy Weapons).
    await shooter.createEmbeddedDocuments("Item", [{ name: "Rifle", type: "skill", system: { level: 10, stat: "ref" } }]);

    /* ── (a) the item-side predicate itself, by value ─────────────────────────────────────────── */
    ok("§10 the weapon-side detonation predicate answers on the attack type",
      AD.weaponDetonates(frag) === true && AD.weaponDetonates(launcher) === true && AD.weaponDetonates(missile) === true,
      `frag=${AD.weaponDetonates(frag)} launcher=${AD.weaponDetonates(launcher)} missile=${AD.weaponDetonates(missile)}`);
    ok("§10 NEGATIVE — an ordinary firearm does not detonate",
      AD.weaponDetonates(rifle) === false && AD.weaponDetonates(pistol) === false,
      `rifle=${AD.weaponDetonates(rifle)} pistol=${AD.weaponDetonates(pistol)}`);
    ok("§10 NEGATIVE — a null/undefined item answers false rather than throwing",
      AD.weaponDetonates(null) === false && AD.weaponDetonates(undefined) === false && AD.weaponDetonates({}) === false);

    // the SECOND half of the predicate: an ordinary tube with an EXPLOSIVE round in it
    const [heRound] = await shooter.createEmbeddedDocuments("Item", [{
      name: "__PW__HE Cartridge", type: "ammo",
      system: { caliber: "9mm", ammoType: "9mm", quantity: 5, bonusDamageFormula: "2d6", effectTypes: ["Explosive"] },
    }]);
    const [inertRound] = await shooter.createEmbeddedDocuments("Item", [{
      name: "__PW__Ball Cartridge", type: "ammo",
      system: { caliber: "9mm", ammoType: "9mm", quantity: 5, effectTypes: ["Non-Explosive"] },
    }]);
    try {
      await pistol.update({ "system.ammoItemId": heRound.id });
      ok("§10 an ordinary tube loaded with an EXPLOSIVE round detonates by its round",
        AD.weaponDetonates(pistol) === true);
      ok("§10 and its called-shot row goes with it", !paths(pistol).includes("targetArea"), paths(pistol).join(","));
      await pistol.update({ "system.ammoItemId": inertRound.id });
      ok("§10 NEGATIVE — a bare 'Non-Explosive' string is not read as a substring match",
        AD.weaponDetonates(pistol) === false && paths(pistol).includes("targetArea"));
    } finally {
      await pistol.update({ "system.ammoItemId": "" });
      await heRound.delete().catch(() => {});
      await inertRound.delete().catch(() => {});
    }

    /* ── (b) the returned ROWS, by value, for all four subjects ───────────────────────────────── */
    await launcher.update({ "system.ammoItemId": "" });
    const rFrag = paths(frag), rLaunch = paths(launcher), rMiss = paths(missile), rRifle = paths(rifle);
    ok("§10 the called-shot row is REMOVED for a thrown delivery (rollable printed damage)",
      !rFrag.includes("targetArea"), rFrag.join(","));
    ok("§10 …and for the launcher, whose printed damage is the deferral word",
      !rLaunch.includes("targetArea") && String(launcher.system.damage) === "Varies", rLaunch.join(","));
    ok("§10 …and for a Missile-type tube", !rMiss.includes("targetArea"), rMiss.join(","));
    ok("§10 NEGATIVE — an ordinary rifle keeps the row, with its blank default",
      rRifle.includes("targetArea")
      && lk.rangedModifiers(rifle, [], {}).flat().find(r => r.dataPath === "targetArea")?.defaultValue === "",
      rRifle.join(","));
    ok("§10 the row is the ONLY thing removed — every other row survives, in order",
      rFrag.length === rRifle.length - 1
      && rRifle.filter(p => p !== "targetArea").join(",") === rFrag.join(","),
      `rifle=${rRifle.length} frag=${rFrag.length}`);
    ok("§10 the MELEE and MARTIAL called-shot rows are untouched by this",
      lk.meleeBonkOptions({}).flat().some(r => r.dataPath === "targetArea")
      && lk.martialOptions(shooter, {}).flat().some(r => r.dataPath === "targetArea"));

    /* ── (c) the RENDERED window, driven by the real click on the sheet's own fire control ────── */
    const modWindows = () =>
      [...foundry.applications.instances.values()].filter(a => /Modifiers/.test(a?.constructor?.name ?? ""));
    // ⭐ AN AREA DELIVERY IS AIMED BEFORE ITS WINDOW OPENS (2026-08-28 ruling — see §16). So this helper
    // now drives the WHOLE gesture the table performs: click the fire control, and if the aim gesture
    // armed, designate a point with a real canvas pointerdown. A rifle arms nothing and reaches the
    // window on the click alone, which is what keeps the negative legs below honest.
    const aim = await import(`/modules/${SCOPE}/module/combat/aim-placement.js`);
    const designate = async () => {
      const view = canvas.app?.view ?? document.getElementById("board");
      view?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0,
        clientX: 400, clientY: 400 }));
      await sleep(250);
    };
    const openVia = async (item) => {
      for (const w of modWindows()) { try { await w.close(); } catch (_e) {} }
      await sleep(200);
      const root = shooter.sheet.element;
      const ctl = root?.querySelector(`.fire-weapon[data-item-id="${item.id}"]`);
      if (!ctl) return { ctl: null, el: null, win: null, aimed: false };
      ctl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await sleep(300);
      const aimed = aim.aimPointPlacementActive();
      if (aimed) await designate();
      for (let i = 0; i < 40 && modWindows().length === 0; i++) await sleep(150);
      await sleep(400);
      const win = modWindows()[0] ?? null;
      return { ctl, el: win?.element ?? null, win, aimed };
    };
    await shooter.sheet.render(true);
    await sleep(1200);
    try {
      const g = await openVia(frag);
      // WIRING leg: the handler's selector matches the rendered node AND the data field it reads is
      // non-empty — a presence-only check here would pass on an empty data-item-id.
      ok("§10 HARNESS/WIRING — the fire control is on the rendered sheet and carries a non-empty item id",
        !!g.ctl && g.ctl.dataset.itemId === frag.id && g.ctl.dataset.itemId !== "");
      ok("§10 the RENDERED window opened from the real click carries no called-shot control",
        !!g.el && g.el.querySelector('select[name="targetArea"]') === null
        && g.el.querySelector('select[name="range"]') !== null,
        `targetArea=${!!g.el?.querySelector('select[name="targetArea"]')} range=${!!g.el?.querySelector('select[name="range"]')}`);
      if (g.win) { try { await g.win.close(); } catch (_e) {} }

      const r = await openVia(rifle);
      ok("§10 NEGATIVE — the rifle's window DOES carry it, with a blank first option",
        !!r.el && r.el.querySelector('select[name="targetArea"]') !== null
        && r.el.querySelector('select[name="targetArea"]')?.value === "",
        `present=${!!r.el?.querySelector('select[name="targetArea"]')} value=${r.el?.querySelector('select[name="targetArea"]')?.value}`);
      if (r.win) { try { await r.win.close(); } catch (_e) {} }

      // SECOND ACT: reopening the delivery weapon's window after the rifle's must not restore the row
      // (saved options are re-read on every open).
      const g2 = await openVia(frag);
      ok("§10 SECOND ACT — reopening after another weapon's window still offers no called-shot control",
        !!g2.el && g2.el.querySelector('select[name="targetArea"]') === null);
      if (g2.win) { try { await g2.win.close(); } catch (_e) {} }
    } finally {
      for (const w of modWindows()) { try { await w.close(); } catch (_e) {} }
      try { await shooter.sheet.close(); } catch (_e) {}
      await sleep(300);
    }
  });

  /* ══════════════════ §11 the point-blank ROLL-MAXIMIZE predicate ══════════════════
   * MECHANISM: the base's `_shouldMaximizePointBlankDamage` is `isRanged() && _isFirearm() && range ===
   * pointBlank`, and `_isFirearm()` includes the HVY weaponType every delivery weapon in the catalogue
   * carries — so the maximize reached warheads. The gesture guard shadows the predicate on the INSTANCE
   * for detonating weapons only, before its own rollable-damage early return, and restores it after. */
  await sect("§11", async () => {
    const sheet = shooter.sheet;
    const PB = { range: base.ranges.pointBlank };
    const prev11 = {};
    const set11 = async (scope, k, v) => {
      try { prev11[`${scope}|${k}`] = game.settings.get(scope, k); await game.settings.set(scope, k, v); } catch (_e) {}
    };
    await set11(SCOPE, "combatFxEnabled", false);
    await set11(SCOPE, "explosivesDetailed", false);
    // A fumble legitimately forces a miss (~10%), and a miss carries no damage row — so the counting
    // legs below stand the table down and restore it (the documented ranged-fumble collapse).
    await set11("cyberpunk2020", "fumbleTableEnabled", false);
    // ⚠ THE SAMPLES ARE LANDED SHOTS, AND THE TO-HIT IS NOT WHAT THIS SECTION MEASURES. A fixture
    // actor rolls REF 5 + 1d10 against the point-blank DC of 10, so roughly two shots in five carry no
    // damage row at all (measured: 4 of 7 deliveries, 1 of 5 rifle shots) — a thin sample that reads as
    // a product red. The NEIGHBOURING mechanism is therefore pinned for the counting legs, exactly as
    // the harness pins the fumble collapse when it is counting rounds: `attackRoll` is shadowed on the
    // INSTANCE to a certain hit and restored right after, so every shot lands and the numbers being
    // compared are damage rolls and nothing else. The damage roll itself is never touched.
    const pinHit = (weapon) => {
      const d = Object.getOwnPropertyDescriptor(weapon, "attackRoll");
      weapon.attackRoll = async () => await new Roll("40").evaluate();
      return () => { if (d) Object.defineProperty(weapon, "attackRoll", d); else delete weapon.attackRoll; };
    };
    try {
      /* ── (a) the MECHANISM, read during the gesture, on BOTH guard paths ───────────────────── */
      let duringThrown = null, duringLaunched = null, duringRifle = null;
      await sheet._cpFireThroughDamageGuard(frag, async () => {
        duringThrown = frag._shouldMaximizePointBlankDamage(PB); return "fired";
      });
      ok("§11 the maximize predicate answers FALSE during a THROWN delivery's gesture (past the rollable-damage early return)",
        duringThrown === false, `during=${duringThrown}`);
      await launcher.update({ "system.ammoItemId": round.id });
      await sheet._cpFireThroughDamageGuard(launcher, async () => {
        duringLaunched = launcher._shouldMaximizePointBlankDamage(PB); return "fired";
      });
      ok("§11 …and FALSE during a LAUNCHER's gesture (the warhead-substitution path)",
        duringLaunched === false, `during=${duringLaunched}`);
      await launcher.update({ "system.ammoItemId": "" });
      await sheet._cpFireThroughDamageGuard(rifle, async () => {
        duringRifle = rifle._shouldMaximizePointBlankDamage(PB); return "fired";
      });
      ok("§11 NEGATIVE — an ordinary rifle's gesture leaves the predicate answering TRUE at point blank",
        duringRifle === true, `during=${duringRifle}`);

      /* ── (b) GUARD RESTORE — no own property is left on any of the three ───────────────────── */
      const owns = (it) => Object.prototype.hasOwnProperty.call(it, "_shouldMaximizePointBlankDamage");
      ok("§11 guard restore — the instance no longer shadows the predicate after the gesture",
        !owns(frag) && !owns(launcher) && !owns(rifle)
        && frag._shouldMaximizePointBlankDamage(PB) === true,
        `frag=${owns(frag)} launcher=${owns(launcher)} rifle=${owns(rifle)} answersAgain=${frag._shouldMaximizePointBlankDamage(PB)}`);
      ok("§11 guard restore — the damage accessor is restored with it",
        !Object.prototype.hasOwnProperty.call(launcher, "_getWeaponSystem")
        && launcher._getWeaponSystem().damage === "Varies");

      /* ── (c) THE VALUE CONSEQUENCE, off the real fire path ─────────────────────────────────── */
      // 7d6 maximized is a pinned 42. Fire point blank repeatedly and read the damage rows the base
      // actually put on the payload; unmaximized they must vary and must fall below the ceiling.
      const fireAt = async (weapon, rangeKey, shots) => {
        const totals = [];
        const seen = [];
        const spy = (pl) => seen.push(pl);
        Hooks.on("cyberpunk2020.weaponFired", spy);
        const unpin = pinHit(weapon);
        try {
          for (let i = 0; i < shots; i++) {
            seen.length = 0;
            await weapon.update({ "system.shotsLeft": "5" });
            await sheet._cpFireThroughDamageGuard(weapon, async () => weapon.__weaponRoll(
              { fireMode: base.fireModes.semiAuto, range: rangeKey, targetActor: victim },
              [{ id: vicTok.id, name: vicTok.name }]));
            for (let w = 0; w < 60 && seen.length === 0; w++) await sleep(100);
            const rows = Object.values(seen[0]?.areaDamages ?? {}).flat();
            if (rows.length) totals.push(rows.reduce((s, h) => s + (Number(h.damage ?? h.dmg) || 0), 0));
            // A NON-detonating hit opens the single-target apply window; five of them would pile up and
            // follow this section into the next. Closed, not applied — the damage is not the subject.
            await sleep(250);
            for (const w of [...foundry.applications.instances.values()].filter(a => /DamageDialog/.test(a?.constructor?.name ?? ""))) {
              try { await w.close(); } catch (_e) {}
            }
          }
        } finally { unpin(); Hooks.off("cyberpunk2020.weaponFired", spy); }
        return totals;
      };
      const gTotals = await fireAt(frag, base.ranges.pointBlank, 7);
      out.notes.push(`§11 point-blank 7d6 delivery totals: ${JSON.stringify(gTotals)}`);
      ok("§11 HARNESS GUARD — enough point-blank deliveries landed to measure", gTotals.length >= 3, `landed=${gTotals.length}`);
      ok("§11 a point-blank delivery's damage is NOT pinned at the maximized 42",
        gTotals.length >= 3 && !gTotals.every(t => t === 42) && gTotals.some(t => t < 42),
        JSON.stringify(gTotals));
      ok("§11 every one of them is still a legal 7d6 result (7…42)",
        gTotals.length >= 3 && gTotals.every(t => t >= 7 && t <= 42), JSON.stringify(gTotals));

      const rTotals = await fireAt(rifle, base.ranges.pointBlank, 5);
      out.notes.push(`§11 point-blank 5d6 rifle totals: ${JSON.stringify(rTotals)}`);
      ok("§11 HARNESS GUARD — enough point-blank rifle shots landed to measure", rTotals.length >= 3, `landed=${rTotals.length}`);
      ok("§11 NEGATIVE — a rifle at point blank still maximizes, every shot pinned at 5d6's 30",
        rTotals.length >= 3 && rTotals.every(t => t === 30), JSON.stringify(rTotals));

      /* ── (d) BLAST BASE-DAMAGE CONTINUITY — regression, unchanged behaviour ─────────────────── */
      // On a HIT the area is priced off the card's own carried roll (damage-hooks sums
      // payload.areaDamages); the warhead is re-rolled only on a miss. That must still be true.
      const areasBefore = new Set((scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])]).filter(d => F(d).isExplosion).map(d => d.id));
      const seen11 = [];
      const spy11 = (pl) => seen11.push(pl);
      Hooks.on("cyberpunk2020.weaponFired", spy11);
      let carried = null;
      const unpin11 = pinHit(frag);
      try {
        await frag.update({ "system.shotsLeft": "5" });
        await sheet._cpFireThroughDamageGuard(frag, async () => frag.__weaponRoll(
          { fireMode: base.fireModes.semiAuto, range: base.ranges.close, targetActor: victim },
          [{ id: vicTok.id, name: vicTok.name }]));
        for (let w = 0; w < 30 && seen11.length === 0; w++) await sleep(100);
        const rows = Object.values(seen11[0]?.areaDamages ?? {}).flat();
        carried = rows.length ? rows.reduce((s, h) => s + (Number(h.damage ?? h.dmg) || 0), 0) : null;
      } finally { unpin11(); Hooks.off("cyberpunk2020.weaponFired", spy11); }
      let area11 = null;
      for (let i = 0; i < 60 && carried !== null; i++) {
        const all = (scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])]);
        area11 = all.find(d => F(d).isExplosion && !areasBefore.has(d.id)) ?? null;
        if (area11) break;
        await sleep(300);
      }
      ok("§11 REGRESSION — on a hit the blast's base damage still equals the card's own carried roll",
        !!area11 && carried !== null && Number(F(area11).baseDamage) === carried,
        `carried=${carried} area=${area11 ? F(area11).baseDamage : "none"}`);
      if (area11) await area11.delete().catch(() => {});
    } finally {
      ok("§11 HARNESS RESTORE — the pinned to-hit is off every fixture the section touched",
        !Object.prototype.hasOwnProperty.call(frag, "attackRoll")
        && !Object.prototype.hasOwnProperty.call(rifle, "attackRoll"));
      for (const [key, v] of Object.entries(prev11)) {
        const [scope, k] = key.split("|");
        try { await game.settings.set(scope, k, v); } catch (_e) {}
      }
    }
  });

  /* ══════════════════ §12 the over-time tick's FLAT-BURN marker ══════════════════
   * MECHANISM: the fire tick (damage-hooks) multiplies each turn's roll by the marker's `mult` and
   * HALVES it for the next turn — an uncited generalization of the p.110 flamethrower ladder, and the
   * default for every load. A marker carrying `flat` holds its multiplier at 1 instead, which is what
   * p.64's printed "Incendiary (4D6 for 3 turns)" states. Both ladders are driven on ONE actor in ONE
   * combat, at two locations, so the positive and its negative cannot be measuring different runs. */
  await sect("§12", async () => {
    const saves = await import(`/modules/${SCOPE}/module/combat/save-rolls.js`);
    const seam = await import(`/modules/${SCOPE}/module/seam-shim.js`);

    /* ── (a) the SHIPPED round states the marker, and its disclosure was rewritten ─────────────── */
    const inc = ROUND_SOURCES.find(s => /Incendiary/i.test(s.name ?? ""));
    const fragSrc = ROUND_SOURCES.find(s => /Fragmentation/i.test(s.name ?? ""));
    ok("§12 the shipped incendiary round states the flat-burn marker beside its other over-time fields",
      inc?.system?.dotFlat === true && inc?.system?.dotEnabled === true
      && String(inc?.system?.dotDamageFormula) === "4d6" && Number(inc?.system?.dotTurns) === 2
      && String(inc?.system?.dotType) === "fire",
      `dotFlat=${inc?.system?.dotFlat} turns=${inc?.system?.dotTurns} formula=${inc?.system?.dotDamageFormula}`);
    ok("§12 its notes disclose the printed FLAT figure and no longer disclose a halved third turn",
      /dotFlat/.test(inc?.system?.notes ?? "") && /4D6, 4D6, 4D6/.test(inc?.system?.notes ?? "")
      && !/half of 4D6 on the third/.test(inc?.system?.notes ?? ""));
    ok("§12 NEGATIVE — the fragmentation round carries no over-time tick at all and is untouched",
      fragSrc?.system?.dotEnabled === false && fragSrc?.system?.dotFlat === undefined,
      `dotEnabled=${fragSrc?.system?.dotEnabled} dotFlat=${fragSrc?.system?.dotFlat}`);

    /* ── (b) the marker SURVIVES THE WRITE on this host, and rides the seam onto a payload ─────── */
    const [liveInc] = await shooter.createEmbeddedDocuments("Item", [{
      name: "__PW__Incendiary Round", type: "ammo", system: { ...inc.system },
    }]);
    try {
      ok("§12 the marker survives the DataModel write on this host (not stripped like a schema-less field)",
        liveInc.system.dotFlat === true, `read back ${liveInc.system.dotFlat}`);
      await launcher.update({ "system.ammoItemId": liveInc.id });
      const f = seam.ammoEffectFields(shooter.items.get(launcher.id));
      ok("§12 the seam copies the marker onto the fired payload beside the other four over-time fields",
        f.dotFlat === true && f.dotEnabled === true && Number(f.dotTurns) === 2
        && String(f.dotDamageFormula) === "4d6" && String(f.dotType) === "fire",
        JSON.stringify({ dotFlat: f.dotFlat, dotTurns: f.dotTurns, dotType: f.dotType }));
      const fBare = seam.ammoEffectFields(shooter.items.get(frag.id));
      ok("§12 NEGATIVE — a weapon with no round in it carries no marker, so the tick keeps its default",
        fBare.dotFlat === undefined, `dotFlat=${fBare.dotFlat}`);
    } finally {
      await launcher.update({ "system.ammoItemId": "" });
    }

    /* ── (c) the marker reaches the STATE through the routing helper ───────────────────────────── */
    await victim.unsetFlag(SCOPE, "fireDotState").catch(() => {});
    await saves.applyDotFromPayload(victim, "Torso", { ...liveInc.system, dotTurns: 3 }, true);
    const seeded = victim.getFlag(SCOPE, "fireDotState") ?? [];
    ok("§12 a payload built from the shipped round seeds a FLAT marker at the hit location",
      seeded.length === 1 && seeded[0].flat === true && seeded[0].mult === 1
      && seeded[0].formula === "4d6" && seeded[0].turnsLeft === 3,
      JSON.stringify(seeded));
    await victim.unsetFlag(SCOPE, "fireDotState").catch(() => {});
    await saves.applyDotFromPayload(victim, "Torso",
      { dotEnabled: true, dotTurns: 3, dotType: "fire", dotDamageFormula: "1d6" }, true);
    const seededOld = victim.getFlag(SCOPE, "fireDotState") ?? [];
    ok("§12 NEGATIVE — a payload from before the field existed seeds a NON-flat marker (the runtime floor)",
      seededOld.length === 1 && seededOld[0].flat === false, JSON.stringify(seededOld));
    await victim.unsetFlag(SCOPE, "fireDotState").catch(() => {});
    await liveInc.delete().catch(() => {});

    /* ── (d) THE TICK ITSELF, driven by real round advances, both ladders on one body ──────────── */
    const prev12 = {};
    const set12 = async (k, v) => { try { prev12[k] = game.settings.get(SCOPE, k); await game.settings.set(SCOPE, k, v); } catch (_e) {} };
    await set12("fireDotEnabled", true);
    await set12("mechRoundTickAutomation", true);
    await set12("damageAblation", false);
    await set12("combatFxEnabled", false);
    let combat = null;
    try {
      await victim.update({ "system.damage": 0 });
      // The tick refuses to burn a figure marked dead; earlier sections put real damage on this body.
      try { if (victim.statuses?.has?.("dead")) await victim.toggleStatusEffect("dead", { active: false }); } catch (_e) {}
      // Torso burns on the printed flat ladder; the arm burns on the module's default halving one.
      await saves.applyFireDotState(victim, "Torso", 3, "4d6", true);
      await saves.applyFireDotState(victim, "lArm", 3, "1d6", false);
      const multOf = (loc) => {
        const st = victim.getFlag(SCOPE, "fireDotState") ?? [];
        const e = st.find(s => s.location === loc);
        return e ? Number(e.mult) : null;
      };
      const flatSeq = [multOf("Torso")], halveSeq = [multOf("lArm")];

      combat = await Combat.create({ scene: scene.id });
      await combat.createEmbeddedDocuments("Combatant", [{ tokenId: vicTok.id, sceneId: scene.id, actorId: victim.id, initiative: 10 }]);
      await combat.startCombat();
      await sleep(800);
      ok("§12 HARNESS GUARD — the burning figure is the combatant the tick will run for",
        combat.combatant?.actor?.id === victim.id, `combatant=${combat.combatant?.actor?.name}`);
      // Two advances: turn 2 and turn 3 of a three-turn burn. The multiplier READ BEFORE each advance
      // is the one that turn's roll was multiplied by.
      for (const r of [2, 3]) {
        await combat.update({ round: r, turn: 0 });
        for (let i = 0; i < 40; i++) {
          await sleep(300);
          const st = victim.getFlag(SCOPE, "fireDotState") ?? [];
          const t = st.find(s => s.location === "Torso");
          if (!t || t.turnsLeft === 4 - r) break;
        }
        flatSeq.push(multOf("Torso"));
        halveSeq.push(multOf("lArm"));
      }
      out.notes.push(`§12 per-turn multipliers — flat marker ${JSON.stringify(flatSeq)} · default marker ${JSON.stringify(halveSeq)}`);
      ok("§12 the FLAT marker's multiplier is 1 on every one of its three turns",
        flatSeq.length === 3 && flatSeq[0] === 1 && flatSeq[1] === 1 && flatSeq[2] === 1,
        JSON.stringify(flatSeq));
      ok("§12 NEGATIVE — a marker without it still halves: 1, ½, ¼",
        halveSeq.length === 3 && halveSeq[0] === 1 && halveSeq[1] === 0.5 && halveSeq[2] === 0.25,
        JSON.stringify(halveSeq));
      ok("§12 the flat marker keeps its own flag across the ticks that rewrote it",
        (victim.getFlag(SCOPE, "fireDotState") ?? []).find(s => s.location === "Torso")?.flat === true);
      ok("§12 the burn actually landed damage while it ticked (the tick ran, it was not a silent no-op)",
        Number(victim.system.damage) > 0, `damage=${victim.system.damage}`);
    } finally {
      if (combat) await combat.delete().catch(() => {});
      await victim.unsetFlag(SCOPE, "fireDotState").catch(() => {});
      try { if (victim.statuses?.has?.("burning")) await victim.toggleStatusEffect("burning", { active: false }); } catch (_e) {}
      for (const [k, v] of Object.entries(prev12)) { try { await game.settings.set(SCOPE, k, v); } catch (_e) {} }
    }
  });

  /* ══════════════════ §13 the BLAST's rider carry ══════════════════
   * MECHANISM: a blast area OUTLIVES the payload that placed it — the GM confirms it seconds later,
   * by which point the only record of what the load does is the area's own flags. The flag block wrote
   * the ARMOUR half of that record (ap/edged/mono/the two multipliers/the penetration multiplier) and
   * not the PER-HIT half (the shock a stun round delivers, the burn an incendiary one starts), so the
   * confirm's `{...f}` handed the apply nothing and the two rider calls in `_applyAreaHitToToken` were
   * no-ops for every detonation. The pattern flow got this pass on 2026-08-10; the blast never did.
   *
   * One body takes all four detonations in turn — a figure with PRIOR state each time after the first,
   * which is the shape the rider bugs of this batch actually had. */
  await sect("§13", async () => {
    const shapes = await import(`/modules/${SCOPE}/module/combat/area-shapes.js`);
    const renderCard = (path, data) =>
      (foundry?.applications?.handlebars?.renderTemplate ?? renderTemplate)(path, data);

    const prev13 = {};
    const set13 = async (k, v) => { try { prev13[k] = game.settings.get(SCOPE, k); await game.settings.set(SCOPE, k, v); } catch (_e) {} };
    await set13("explosivesEnabled", true);
    await set13("explosivesDetailed", false);
    await set13("combatFxEnabled", false);       // §13 is about the DAMAGE rail
    await set13("fireDotEnabled", true);
    await set13("taserCumPenaltyEnabled", true);
    await set13("mechRoundTickAutomation", true);
    await set13("damageAblation", false);
    await set13("headHitDoubling", false);
    await set13("limbModel", "core");

    let catcher = null, catchTok = null, combat13 = null;
    try {
      /* ── fixtures: a body of this section's own, far enough out that the blast catches only it ──── */
      catcher = await Actor.create({ name: "__PW__Blast Catcher", type: "character" });
      [catchTok] = await scene.createEmbeddedDocuments("Token", [{
        name: catcher.name, actorId: catcher.id, actorLink: true,
        x: 800, y: 1000 + 8 * gridPx, width: 1, height: 1,
      }]);
      await sleep(600);
      ok("§13 HARNESS GUARD — the catching figure is on the canvas this section will measure",
        canvas.scene?.id === scene.id && !!canvas.tokens.get(catchTok.id),
        `scene=${canvas.scene?.id === scene.id} token=${!!canvas.tokens.get(catchTok.id)}`);

      const allAreas = () => (scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])]);
      // Every rider a load can state, with values that are distinguishable from every default — a leg
      // that reads back the defaults would pass against a flag block that wrote nothing.
      const RIDERS = { stunSaveOnHit: true, stunSaveMod: -3, dotEnabled: true, dotTurns: 3,
                       dotType: "fire", dotDamageFormula: "4d6", dotFlat: true };
      // The armour half, at values no default supplies either — this is the regression guard: the fields
      // the block ALREADY wrote must still arrive unchanged once the rider fields join them.
      const ARMOUR = { ap: true, edged: true, mono: true, armorMultSoft: 2, armorMultHard: 0.5,
                       penDamageMult: 3, blastShrapnel: true };

      const placeBlast = async (extra) => {
        const before = new Set(allAreas().filter(d => F(d).isExplosion).map(d => d.id));
        Hooks.callAll("cyberpunk2020.weaponFired", {
          attackerId: shooter.id, attackerTokenId: shTok.id, weaponName: "__PW__Blast Probe",
          attackType: "Grenade", areaDamages: { Torso: [{ damage: 10 }] }, shotsFired: 1, shotsHit: 1,
          targetTokenId: catchTok.id, fxTargetTokenId: catchTok.id, firedByUserId: game.user.id,
          // 3 m keeps the circle off the fixtures the earlier sections left standing eight squares away,
          // so the counts below are this figure's and nobody else's.
          blastRadius: 3, ...extra,
        });
        for (let i = 0; i < 60; i++) {
          const a = allAreas().find(d => F(d).isExplosion && !before.has(d.id));
          if (a) return a;
          await sleep(300);
        }
        return null;
      };
      const confirmArea = async (areaId) => {
        let btn = null;
        for (let i = 0; i < 40; i++) {
          btn = document.querySelector(`.cp-confirm-explosion[data-template-id="${areaId}"]`);
          if (btn) break;
          await sleep(250);
        }
        if (!btn) return false;
        btn.click();
        await sleep(2500);
        return true;
      };
      const dotOf = () => catcher.getFlag(SCOPE, "fireDotState") ?? [];
      const resetCatcher = async () => {
        await catcher.unsetFlag(SCOPE, "fireDotState").catch(() => {});
        await catcher.unsetFlag(SCOPE, "taserState").catch(() => {});
        await catcher.update({ "system.damage": 0 });
        for (const s of ["dead", "burning"]) {
          try { if (catcher.statuses?.has?.(s)) await catcher.toggleStatusEffect(s, { active: false }); } catch (_e) {}
        }
      };
      const dropArea = async (area) => { try { await area.delete(); } catch (_e) {} };

      /* ── (a) THE RECORD: every rider field on the area, beside the armour statements ────────────── */
      const recArea = await placeBlast({ ...RIDERS, ...ARMOUR });
      ok("§13 a detonating payload places an area to read the record off", !!recArea);
      if (recArea) {
        const f = F(recArea);
        ok("§13 the area records all seven per-hit rider fields by value",
          f.stunSaveOnHit === true && Number(f.stunSaveMod) === -3 && f.dotEnabled === true
          && Number(f.dotTurns) === 3 && String(f.dotType) === "fire"
          && String(f.dotDamageFormula) === "4d6" && f.dotFlat === true,
          JSON.stringify({ stunSaveOnHit: f.stunSaveOnHit, stunSaveMod: f.stunSaveMod, dotEnabled: f.dotEnabled,
                           dotTurns: f.dotTurns, dotType: f.dotType, dotDamageFormula: f.dotDamageFormula, dotFlat: f.dotFlat }));
        ok("§13 REGRESSION — the armour statements the area always recorded are unchanged beside them",
          f.ap === true && f.edged === true && f.mono === true && Number(f.armorMultSoft) === 2
          && Number(f.armorMultHard) === 0.5 && Number(f.penDamageMult) === 3 && f.blastShrapnel === true
          && Number(f.baseDamage) === 10 && Number(f.blastRadius) === 3,
          JSON.stringify({ ap: f.ap, edged: f.edged, mono: f.mono, soft: f.armorMultSoft, hard: f.armorMultHard,
                           pen: f.penDamageMult, shrapnel: f.blastShrapnel, base: f.baseDamage, radius: f.blastRadius }));
        await dropArea(recArea);
      }

      /* ── (b) HONORED: the confirm hands the riders to the apply ────────────────────────────────── */
      await resetCatcher();
      const from = new Set(game.messages.map(m => m.id));
      const hotArea = await placeBlast({ ...RIDERS });
      ok("§13 an incendiary-shaped payload places its blast", !!hotArea);
      if (hotArea) {
        ok("§13 the confirm card was posted for it", await confirmArea(hotArea.id));
        for (let i = 0; i < 30 && dotOf().length === 0; i++) await sleep(300);
        const st = dotOf();
        ok("§13 the caught figure took the blast's damage",
          Number(catcher.system.damage) > 0, `damage=${catcher.system.damage}`);
        ok("§13 confirming the blast seeds the over-time state on the caught figure, FLAT",
          st.length === 1 && st[0].flat === true && Number(st[0].mult) === 1
          && String(st[0].formula) === "4d6" && Number(st[0].turnsLeft) === 3,
          JSON.stringify(st));
        const taser = catcher.getFlag(SCOPE, "taserState") ?? null;
        ok("§13 the shock rider is honored on the same application, at the payload's own figure",
          !!taser && Number(taser.count) === 1 && Number(taser.mod) === -3, JSON.stringify(taser));
        // The ledger owns the stun half and posts it once, off the state the application FINISHED on.
        const mine = (mark) => [...game.messages]
          .filter(m => !from.has(m.id) && (m.content ?? "").includes(mark) && (m.content ?? "").includes(`data-actor-id="${catcher.id}"`)).length;
        ok("§13 REGRESSION — the batched save cadence holds: ONE stun prompt for this body, no mortal prompt",
          mine("stun-save-prompt") === 1 && mine("death-save-prompt") === 0,
          `stun=${mine("stun-save-prompt")} mortal=${mine("death-save-prompt")}`);
        await dropArea(hotArea);
      }

      /* ── (c) THE TICK, driven by real round advances off the state the BLAST seeded ────────────── */
      if (dotOf().length === 1) {
        // The burn is the blast's own; only the wound track is reset, so three 4d6 turns have room to
        // land without the tick refusing a body it reads as dead.
        await catcher.update({ "system.damage": 0 });
        try { if (catcher.statuses?.has?.("dead")) await catcher.toggleStatusEffect("dead", { active: false }); } catch (_e) {}
        const multNow = () => { const e = dotOf()[0]; return e ? Number(e.mult) : null; };
        const seq = [multNow()];
        combat13 = await Combat.create({ scene: scene.id });
        await combat13.createEmbeddedDocuments("Combatant", [{ tokenId: catchTok.id, sceneId: scene.id, actorId: catcher.id, initiative: 10 }]);
        await combat13.startCombat();
        await sleep(800);
        ok("§13 HARNESS GUARD — the burning figure is the combatant the tick will run for",
          combat13.combatant?.actor?.id === catcher.id, `combatant=${combat13.combatant?.actor?.name}`);
        for (const r of [2, 3]) {
          await combat13.update({ round: r, turn: 0 });
          for (let i = 0; i < 40; i++) {
            await sleep(300);
            const e = dotOf()[0];
            if (!e || Number(e.turnsLeft) === 4 - r) break;
          }
          seq.push(multNow());
        }
        out.notes.push(`§13 blast-seeded burn multipliers per turn: ${JSON.stringify(seq)}`);
        ok("§13 the blast-seeded burn ticks on the FLAT ladder: 1, 1, 1",
          seq.length === 3 && seq[0] === 1 && seq[1] === 1 && seq[2] === 1, JSON.stringify(seq));
        ok("§13 the burn landed damage while it ticked (the tick ran, not a silent no-op)",
          Number(catcher.system.damage) > 0, `damage=${catcher.system.damage}`);
      } else {
        ok("§13 the blast-seeded burn ticks on the FLAT ladder: 1, 1, 1", false, "no blast-seeded burn to tick");
      }
      if (combat13) { await combat13.delete().catch(() => {}); combat13 = null; }

      /* ── (d) NEGATIVE: a fragmentation-shaped payload states no riders and seeds none ───────────── */
      await resetCatcher();
      const coldArea = await placeBlast({});
      ok("§13 a fragmentation-shaped payload places its blast", !!coldArea);
      if (coldArea) {
        const f = F(coldArea);
        ok("§13 NEGATIVE — its area records the 'does nothing' value for every rider, not undefined",
          f.stunSaveOnHit === false && Number(f.stunSaveMod) === 0 && f.dotEnabled === false
          && Number(f.dotTurns) === 0 && f.dotFlat === false,
          JSON.stringify({ stun: f.stunSaveOnHit, mod: f.stunSaveMod, dot: f.dotEnabled, turns: f.dotTurns, flat: f.dotFlat }));
        await confirmArea(coldArea.id);
        await sleep(1200);
        ok("§13 NEGATIVE — its blast damages the figure and starts no burn at all",
          Number(catcher.system.damage) > 0 && dotOf().length === 0
          && !catcher.getFlag(SCOPE, "taserState"),
          `damage=${catcher.system.damage} dot=${JSON.stringify(dotOf())} taser=${JSON.stringify(catcher.getFlag(SCOPE, "taserState") ?? null)}`);
        await dropArea(coldArea);
      }

      /* ── (e) AN AREA WRITTEN BEFORE THE FIELDS EXISTED still applies plain damage ──────────────── */
      await resetCatcher();
      {
        const cc = canvas.tokens.get(catchTok.id);
        const ox = cc?.center?.x ?? 800, oy = cc?.center?.y ?? (1000 + 8 * gridPx);
        // The flag set VERBATIM as the block wrote it before this unit — no rider keys at all, which is
        // what every area already standing on a live table carries. Backward compatibility here is the
        // ABSENCE of the fields, not a version gate, so this is the whole of the compatibility test.
        const legacy = await shapes.createArea(scene, {
          kind: "circle", x: ox, y: oy, radiusM: 3, color: "#ff8800", borderColor: "#cc4400",
          flags: {
            isExplosion: true, baseDamage: 10, blastRadius: 3, blastFullDamageWithin: 2,
            blastMultipliers: [0.5, 0.25, 0.125, 0.0625], attackerId: shooter.id,
            ap: false, edged: false, mono: false, armorMultSoft: 1, armorMultHard: 1,
            penDamageMult: 1, blastShrapnel: false, weaponName: "__PW__Legacy Blast",
            createdRound: 0, originX: ox, originY: oy,
          },
        });
        ok("§13 a pre-change area (no rider keys written at all) can be stood up", !!legacy?.doc);
        if (legacy?.doc) {
          const card = await renderCard(`modules/${SCOPE}/templates/chat/explosion-confirm.hbs`,
            { weaponName: "__PW__Legacy Blast", radius: 3, baseDamage: 10, fullWithin: 2, templateId: legacy.doc.id });
          await ChatMessage.create({ content: card });
          ok("§13 its confirm card renders and resolves", await confirmArea(legacy.doc.id));
          await sleep(1200);
          ok("§13 COMPATIBILITY — a pre-change area still applies plain damage and starts nothing",
            Number(catcher.system.damage) > 0 && dotOf().length === 0 && !catcher.getFlag(SCOPE, "taserState"),
            `damage=${catcher.system.damage} dot=${dotOf().length}`);
          try { await legacy.doc.delete(); } catch (_e) {}
        }
      }

      /* ── (f) THE SHRAPNEL SECONDARY carries no riders of its own (the ruling, pinned) ──────────── */
      // ⚠ THE PAYLOAD HERE IS DELIBERATELY NOT FIRE-TYPED (realigned 2026-08-28 with §14). The ruling
      // this leg pins is about the CONCUSSION branch's fragment secondary, so the payload has to reach
      // that branch: a fire-typed warhead now routes to the core application instead (§14) and would
      // never touch the shrapnel call at all. An etching load states the same two riders and is
      // explosive-typed, so it lands where this leg needs it.
      await resetCatcher();
      await game.settings.set(SCOPE, "explosivesDetailed", true);
      const detArea = await placeBlast({ ...RIDERS, dotType: "acid", blastShrapnel: true });
      ok("§13 the detailed branch places its blast", !!detArea);
      if (detArea) {
        const detFrom = new Set(game.messages.map(m => m.id));
        await confirmArea(detArea.id);
        await sleep(1500);
        // ⚠ The blast's own RESOLUTION card is excluded by name — see the note at §14's
        // `concussionCardsSince`, which this counter is the sibling of. Same mechanism, same exclusion.
        const concussionCards = [...game.messages].filter(m => !detFrom.has(m.id)
          && /concussion/i.test(m.content ?? "") && (m.content ?? "").includes(catcher.name)
          && !(m.content ?? "").includes("cp-spread-result-list")).length;
        ok("§13 WIRING — an explosive-typed warhead did take the concussion branch (its card was posted)",
          concussionCards === 1, `concussion cards=${concussionCards}`);
        ok("§13 RULING — the shrapnel secondary asks no second save and starts no second burn",
          dotOf().length === 0 && !catcher.getFlag(SCOPE, "taserState"),
          `dot=${JSON.stringify(dotOf())} taser=${JSON.stringify(catcher.getFlag(SCOPE, "taserState") ?? null)}`);
        out.notes.push(`§13 detailed branch: concussion+shrapnel applied, over-time entries=${dotOf().length} — the riders ride the CORE blast application only`);
        await dropArea(detArea);
      }
      await game.settings.set(SCOPE, "explosivesDetailed", false);
    } finally {
      if (combat13) await combat13.delete().catch(() => {});
      for (const d of (scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])])) {
        if (F(d).isExplosion) await d.delete().catch(() => {});
      }
      if (catchTok) await catchTok.delete().catch(() => {});
      if (catcher) await catcher.delete().catch(() => {});
      for (const [k, v] of Object.entries(prev13)) { try { await game.settings.set(SCOPE, k, v); } catch (_e) {} }
    }
  });

  /* ══════════════════ §14 the DETAILED branch's warhead routing ══════════════════
   * MECHANISM: with `explosivesDetailed` on, EVERY figure a blast caught took the Listen Up p.105 HEP
   * application — concussion (SP ignored, half permanent + half stun, soft armour −2) plus an optional
   * fragment secondary — whatever the warhead was, and that application takes only a weapon name. A
   * fire-typed load therefore damaged and ignited nobody the moment the optional mode was switched on.
   * The routing now asks the area's own rider record what KIND of warhead it is: a fire-typed one takes
   * the CORE application (the same call the default branch makes, riders and cover fold included), and
   * the concussion/fragment split stays with explosive warheads.
   *
   * The setting is pinned ON for the whole section and restored in the finally. Every leg below is
   * asked of the SAME body in turn — a figure carrying PRIOR state on every act after the first, which
   * is the shape this batch's rider defects actually had. */
  await sect("§14", async () => {
    const prev14 = {};
    const set14 = async (k, v) => { try { prev14[k] = game.settings.get(SCOPE, k); await game.settings.set(SCOPE, k, v); } catch (_e) {} };
    await set14("explosivesEnabled", true);
    await set14("explosivesDetailed", true);       // ⭐ the whole section is the OPTIONAL mode
    await set14("combatFxEnabled", false);         // §14 is about the DAMAGE rail
    await set14("fireDotEnabled", true);
    await set14("taserCumPenaltyEnabled", true);
    await set14("damageAblation", false);
    await set14("headHitDoubling", false);
    await set14("limbModel", "core");

    let body = null, bodyTok = null;
    try {
      body = await Actor.create({ name: "__PW__Detail Catcher", type: "character" });
      [bodyTok] = await scene.createEmbeddedDocuments("Token", [{
        name: body.name, actorId: body.id, actorLink: true,
        x: 800, y: 1000 + 8 * gridPx, width: 1, height: 1,
      }]);
      await sleep(600);
      ok("§14 HARNESS GUARD — the catching figure is on the canvas this section will measure",
        canvas.scene?.id === scene.id && !!canvas.tokens.get(bodyTok.id),
        `scene=${canvas.scene?.id === scene.id} token=${!!canvas.tokens.get(bodyTok.id)}`);

      const allAreas = () => (scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])]);
      const FIRE = { stunSaveOnHit: true, stunSaveMod: -3, dotEnabled: true, dotTurns: 3,
                     dotType: "fire", dotDamageFormula: "4d6", dotFlat: true };
      const ETCH = { ...FIRE, dotType: "acid" };
      const BASE_DMG = 10;

      const placeBlast = async (extra) => {
        const before = new Set(allAreas().filter(d => F(d).isExplosion).map(d => d.id));
        Hooks.callAll("cyberpunk2020.weaponFired", {
          attackerId: shooter.id, attackerTokenId: shTok.id, weaponName: "__PW__Detail Probe",
          attackType: "Grenade", areaDamages: { Torso: [{ damage: BASE_DMG }] }, shotsFired: 1, shotsHit: 1,
          targetTokenId: bodyTok.id, fxTargetTokenId: bodyTok.id, firedByUserId: game.user.id,
          blastRadius: 3, ...extra,
        });
        for (let i = 0; i < 60; i++) {
          const a = allAreas().find(d => F(d).isExplosion && !before.has(d.id));
          if (a) return a;
          await sleep(300);
        }
        return null;
      };
      const confirmArea = async (areaId) => {
        let btn = null;
        for (let i = 0; i < 40; i++) {
          btn = document.querySelector(`.cp-confirm-explosion[data-template-id="${areaId}"]`);
          if (btn) break;
          await sleep(250);
        }
        if (!btn) return false;
        btn.click();
        await sleep(2500);
        return true;
      };
      const dotOf = () => body.getFlag(SCOPE, "fireDotState") ?? [];
      const resetBody = async () => {
        await body.unsetFlag(SCOPE, "fireDotState").catch(() => {});
        await body.unsetFlag(SCOPE, "taserState").catch(() => {});
        await body.update({ "system.damage": 0 });
        for (const s of ["dead", "burning"]) {
          try { if (body.statuses?.has?.(s)) await body.toggleStatusEffect(s, { active: false }); } catch (_e) {}
        }
      };
      const dropArea = async (area) => { try { await area.delete(); } catch (_e) {} };
      // The concussion application's own receipt, scoped to THIS body: the p.105 card names the figure
      // and says "concussion". Its presence is the branch the routing chose, stated by the code itself.
      // ⚠ THE BLAST'S OWN RESOLUTION CARD IS EXCLUDED BY NAME (2026-08-28). Since the detonation grew a
      // resolution card, the detailed branch's row on it carries a clause saying there is no armour math
      // to disclose *because the application was concussion* — a second, legitimate card carrying both
      // the word and the figure's name. This counter is about the p.105 APPLICATION receipt, so it is
      // discriminated by the resolution card's own list class rather than by the word alone.
      const concussionCardsSince = (from) => [...game.messages].filter(m => !from.has(m.id)
        && /concussion/i.test(m.content ?? "") && (m.content ?? "").includes(body.name)
        && !(m.content ?? "").includes("cp-spread-result-list")).length;

      /* ── (a) A FIRE-TYPED WARHEAD takes the CORE application on the detailed branch ─────────────── */
      await resetBody();
      const fireFrom = new Set(game.messages.map(m => m.id));
      const fireArea = await placeBlast({ ...FIRE });
      ok("§14 an incendiary warhead places its blast with the optional mode ON", !!fireArea);
      if (fireArea) {
        ok("§14 the confirm card was posted for it", await confirmArea(fireArea.id));
        for (let i = 0; i < 30 && dotOf().length === 0; i++) await sleep(300);
        const st = dotOf();
        ok("§14 the caught figure took the blast's damage", Number(body.system.damage) > 0,
          `damage=${body.system.damage}`);
        ok("§14 ⭐ the fire warhead routed to the CORE application: the over-time state is seeded, FLAT",
          st.length === 1 && st[0].flat === true && Number(st[0].mult) === 1
          && String(st[0].formula) === "4d6" && Number(st[0].turnsLeft) === 3,
          JSON.stringify(st));
        const taser = body.getFlag(SCOPE, "taserState") ?? null;
        ok("§14 the load's other rider is honored on the same application (the core call carries both)",
          !!taser && Number(taser.count) === 1 && Number(taser.mod) === -3, JSON.stringify(taser));
        ok("§14 ⭐ NEGATIVE — NO concussion application for a fire warhead: not one p.105 card for this body",
          concussionCardsSince(fireFrom) === 0, `concussion cards=${concussionCardsSince(fireFrom)}`);
        const stun = [...game.messages].filter(m => !fireFrom.has(m.id)
          && (m.content ?? "").includes("stun-save-prompt") && (m.content ?? "").includes(`data-actor-id="${body.id}"`)).length;
        const mortal = [...game.messages].filter(m => !fireFrom.has(m.id)
          && (m.content ?? "").includes("death-save-prompt") && (m.content ?? "").includes(`data-actor-id="${body.id}"`)).length;
        ok("§14 REGRESSION — the batched save cadence holds: ONE stun prompt for this body, no mortal prompt",
          stun === 1 && mortal === 0, `stun=${stun} mortal=${mortal}`);
        await dropArea(fireArea);
      }

      /* ── (b) AN EXPLOSIVE WARHEAD on the SAME setting still takes concussion (regression) ───────── */
      await resetBody();
      const heFrom = new Set(game.messages.map(m => m.id));
      const before = Number(body.system.damage) || 0;
      const btm = Number(body.system.stats?.bt?.modifier) || 0;
      // p.105 arithmetic, computed here from the same three numbers the application reads: SP is ignored,
      // BTM comes off, half of what is left is permanent (floored, never below 1), and it lands on Torso.
      const expectPermanent = Math.max(1, Math.floor(Math.max(1, BASE_DMG - btm) / 2));
      const heArea = await placeBlast({});
      ok("§14 a fragmentation warhead places its blast on the same setting", !!heArea);
      if (heArea) {
        await confirmArea(heArea.id);
        await sleep(1500);
        ok("§14 REGRESSION — the explosive warhead still takes concussion: its p.105 card is posted once",
          concussionCardsSince(heFrom) === 1, `concussion cards=${concussionCardsSince(heFrom)}`);
        ok("§14 REGRESSION — the ½-permanent arithmetic by value",
          Number(body.system.damage) - before === expectPermanent,
          `delta=${Number(body.system.damage) - before} expected=${expectPermanent} btm=${btm}`);
        ok("§14 NEGATIVE — the concussion application carries no riders: no burn, no shock",
          dotOf().length === 0 && !body.getFlag(SCOPE, "taserState"),
          `dot=${JSON.stringify(dotOf())} taser=${JSON.stringify(body.getFlag(SCOPE, "taserState") ?? null)}`);
        await dropArea(heArea);
      }

      /* ── (c) THE FORK READS THE WARHEAD'S TYPE, not merely "has a rider" ────────────────────────── */
      await resetBody();
      const etchFrom = new Set(game.messages.map(m => m.id));
      const etchArea = await placeBlast({ ...ETCH });
      ok("§14 an etching (acid) warhead places its blast", !!etchArea);
      if (etchArea) {
        await confirmArea(etchArea.id);
        await sleep(1500);
        ok("§14 ⭐ the fork is FIRE-typed, not rider-typed: an acid load still takes concussion",
          concussionCardsSince(etchFrom) === 1, `concussion cards=${concussionCardsSince(etchFrom)}`);
        ok("§14 NEGATIVE — and it starts no burn either (its rider is dropped with the branch)",
          dotOf().length === 0, JSON.stringify(dotOf()));
        await dropArea(etchArea);
      }

      /* ── (d) THE SETTING OFF IS UNCHANGED — the same load, the same core answer ─────────────────── */
      await resetBody();
      await game.settings.set(SCOPE, "explosivesDetailed", false);
      const offFrom = new Set(game.messages.map(m => m.id));
      const offArea = await placeBlast({ ...FIRE });
      ok("§14 the same incendiary warhead places its blast with the mode OFF", !!offArea);
      if (offArea) {
        await confirmArea(offArea.id);
        for (let i = 0; i < 30 && dotOf().length === 0; i++) await sleep(300);
        const st = dotOf();
        ok("§14 REGRESSION — with the mode OFF the answer is the one that always shipped: flat 4d6 × 3",
          st.length === 1 && st[0].flat === true && Number(st[0].mult) === 1
          && String(st[0].formula) === "4d6" && Number(st[0].turnsLeft) === 3, JSON.stringify(st));
        ok("§14 REGRESSION — and no concussion card off the branch that never posts one",
          concussionCardsSince(offFrom) === 0, `concussion cards=${concussionCardsSince(offFrom)}`);
        await dropArea(offArea);
      }
    } finally {
      for (const d of (scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])])) {
        if (F(d).isExplosion) await d.delete().catch(() => {});
      }
      if (bodyTok) await bodyTok.delete().catch(() => {});
      if (body) await body.delete().catch(() => {});
      for (const [k, v] of Object.entries(prev14)) { try { await game.settings.set(SCOPE, k, v); } catch (_e) {} }
    }
  });


  /* ══════════════════ §15 the MISS resolves itself, and the card narrates ══════════════════
   * MECHANISM: the card that reaches _placeExplosion already answers hit-or-miss — a HIT carries the
   * rolled damage in `areaDamages`, a MISS carries none. Until 2026-08-28 the flow knew that and asked
   * anyway: the confirm card carried TWO buttons and a hint beginning "if the throw missed", which is a
   * question the table has no way to answer. The landing is a TABLE (p.108), so it is rolled once at
   * placement — the discipline the pattern and suppressive flows already keep — the blast is created at
   * the landed point, and the card states the outcome instead of asking about it.
   *
   * Every leg reads the PLACED GEOMETRY and the POSTED CARD, never the internals: the area's own centre
   * against its own recorded aim point, and the card's own sentence against both. */
  await sect("§15", async () => {
    const prev15 = {};
    const set15 = async (k, v) => { try { prev15[k] = game.settings.get(SCOPE, k); await game.settings.set(SCOPE, k, v); } catch (_e) {} };
    await set15("explosivesEnabled", true);
    await set15("explosivesDetailed", false);
    await set15("combatFxEnabled", false);       // §15 is about the placement, not the picture
    await set15("headHitDoubling", false);
    await set15("damageAblation", false);
    await set15("limbModel", "core");

    let probe = null, probeTok = null;
    try {
      const allAreas = () => (scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])]);
      const gridDistM = Number(scene.grid?.distance) || 1;
      const ppm = gridPx / gridDistM;
      // The aim point every leg measures against: the victim's own centre, which is where the blast
      // would be placed if nothing scattered it.
      const aimPoint = () => {
        const t = canvas.tokens.get(vicTok.id);
        return { x: t?.center?.x ?? t?.x, y: t?.center?.y ?? t?.y };
      };
      ok("§15 HARNESS GUARD — the aimed-at figure is on the canvas this section measures against",
        canvas.scene?.id === scene.id && !!canvas.tokens.get(vicTok.id),
        `scene=${canvas.scene?.id === scene.id} token=${!!canvas.tokens.get(vicTok.id)}`);

      // A throw, driven at the seam the real fire path raises. `weaponId` is load-bearing for the MISS
      // case: the warhead's own damage is rolled off the weapon the payload names.
      const throwBlast = async ({ hit, radius = 25 }) => {
        const before = new Set(allAreas().filter(d => F(d).isExplosion).map(d => d.id));
        Hooks.callAll("cyberpunk2020.weaponFired", {
          attackerId: shooter.id, attackerTokenId: shTok.id, weaponId: frag.id,
          weaponName: "__PW__Frag", attackType: "Grenade",
          // ⛔ THE ONE FIELD THAT DECIDES IT. Rows present = the base rolled damage = the throw landed;
          // rows absent = the base rolled nothing = the throw missed. Nothing else differs between the
          // two calls, so a leg that passes for the wrong reason has nowhere to hide.
          areaDamages: hit ? { Torso: [{ damage: 12 }] } : {},
          shotsFired: 1, shotsHit: hit ? 1 : 0,
          targetTokenId: vicTok.id, fxTargetTokenId: vicTok.id, firedByUserId: game.user.id,
          blastRadius: radius,
        });
        for (let i = 0; i < 60; i++) {
          const a = allAreas().find(d => F(d).isExplosion && !before.has(d.id));
          if (a) return a;
          await sleep(300);
        }
        return null;
      };
      const cardFor = (areaId) => [...game.messages].reverse()
        .find(m => (m.content ?? "").includes(`data-template-id="${areaId}"`)) ?? null;
      const dropArea15 = async (a) => { try { await a.delete(); } catch (_e) { /* gone */ } };

      /* ── a. a MISS resolves its own landing, and the blast is created THERE ─────────────────── */
      const aimAtMiss = aimPoint();
      const missArea = await throwBlast({ hit: false });
      ok("§15 a missed throw still detonates — an area is placed", !!missArea);
      if (missArea) {
        const f = F(missArea);
        ok("§15 the area records that the table placed it, by value",
          f.scattered === true, JSON.stringify({ scattered: f.scattered }));
        ok("§15 the direction face it rolled is a real face of the rose, by value",
          Number.isFinite(Number(f.scatterDirFace)) && Number(f.scatterDirFace) >= 1 && Number(f.scatterDirFace) <= 10,
          `face=${f.scatterDirFace}`);
        ok("§15 the drift is inside the table's own band — 1d10 metres, never more",
          Number(f.scatterDriftM) >= 0 && Number(f.scatterDriftM) <= 10, `${f.scatterDriftM}m`);
        ok("§15 the aim point is recorded beside the landing, so the drift can be checked and not trusted",
          Math.abs(Number(f.aimedX) - aimAtMiss.x) < 1 && Math.abs(Number(f.aimedY) - aimAtMiss.y) < 1,
          JSON.stringify({ aimed: [f.aimedX, f.aimedY], want: [aimAtMiss.x, aimAtMiss.y] }));

        // ⭐ THE GEOMETRY, MEASURED: the placed centre is the aim point plus exactly the recorded drift.
        const placed = { x: Number(f.originX), y: Number(f.originY) };
        const measuredM = Math.hypot(placed.x - Number(f.aimedX), placed.y - Number(f.aimedY)) / ppm;
        out.notes.push(`§15 miss landed ${Number(f.scatterDriftM)}m ${f.scatterDirName} (measured ${measuredM.toFixed(2)}m)`);
        ok("§15 ⭐ DETERMINISM — the distance the area RECORDS is the distance it actually moved",
          Math.abs(measuredM - Number(f.scatterDriftM)) < 0.05,
          `recorded ${f.scatterDriftM}m vs measured ${measuredM.toFixed(3)}m`);
        if (Number(f.scatterDriftM) > 0) {
          ok("§15 a drifted blast is NOT centred on the aim point (negative)",
            !(Math.abs(placed.x - Number(f.aimedX)) < 0.5 && Math.abs(placed.y - Number(f.aimedY)) < 0.5),
            JSON.stringify({ placed, aimed: [f.aimedX, f.aimedY] }));
        } else {
          ok("§15 a no-drift face lands the blast on the aim point exactly (the rose's own 5 and 10)",
            Math.abs(placed.x - Number(f.aimedX)) < 0.5 && Math.abs(placed.y - Number(f.aimedY)) < 0.5,
            JSON.stringify({ placed, aimed: [f.aimedX, f.aimedY], face: f.scatterDirFace }));
        }

        /* ── b. the card NARRATES, and carries one control ────────────────────────────────────── */
        let missCard = null;
        for (let i = 0; i < 40 && !missCard; i++) { missCard = cardFor(missArea.id); if (!missCard) await sleep(250); }
        ok("§15 the confirm card was posted for the missed throw", !!missCard);
        if (missCard) {
          const text = missCard.content ?? "";
          const driftM = Number(f.scatterDriftM);
          const expected = driftM > 0
            ? game.i18n.format("CYBERPUNK.ExplosionScatterLine", {
                dir: (game.i18n.has(`CYBERPUNK.${f.scatterDirName}`) ? game.i18n.localize(`CYBERPUNK.${f.scatterDirName}`) : f.scatterDirName),
                dist: driftM })
            : game.i18n.localize("CYBERPUNK.ExplosionScatterNoDrift");
          ok("§15 ⭐ the card STATES the outcome, in the words the placement recorded",
            text.includes(expected), `expected "${expected}" in the card`);
          ok("§15 and it never asks the table to work out whether the throw missed (negative)",
            !/if the throw missed/i.test(text), text.slice(0, 160));
          ok("§15 the card carries exactly ONE control, and it is the confirm",
            (text.match(/<button/g) ?? []).length === 1 && text.includes("cp-confirm-explosion"),
            `${(text.match(/<button/g) ?? []).length} button(s)`);
          ok("§15 the Scatter button is gone from the rendered card (DOM negative)",
            document.querySelector(`.cp-confirm-explosion-scatter[data-template-id="${missArea.id}"]`) === null
            && document.querySelector(".cp-confirm-explosion-scatter") === null);
        }

        /* ── c. the one Confirm applies AT THE LANDED POSITION, through the normal pipeline ───── */
        // A body put on the landed centre takes the blast's full damage; nothing about the apply path
        // changed, so this is the ordinary falloff pipeline measured at distance zero.
        probe = await Actor.create({ name: "__PW__Landing Probe", type: "character" });
        [probeTok] = await scene.createEmbeddedDocuments("Token", [{
          name: probe.name, actorId: probe.id, actorLink: true,
          x: placed.x - gridPx / 2, y: placed.y - gridPx / 2, width: 1, height: 1,
        }]);
        await sleep(700);
        ok("§15 HARNESS GUARD — the probe stands at the landed centre",
          !!canvas.tokens.get(probeTok.id), String(!!canvas.tokens.get(probeTok.id)));
        const dmgBefore = Number(probe.system.damage) || 0;
        let btn = null;
        for (let i = 0; i < 40 && !btn; i++) {
          btn = document.querySelector(`.cp-confirm-explosion[data-template-id="${missArea.id}"]`);
          if (!btn) await sleep(250);
        }
        ok("§15 the single Confirm control is on screen for the missed throw", !!btn);
        if (btn) {
          btn.click();
          let after = dmgBefore;
          for (let i = 0; i < 40; i++) { after = Number(probe.system.damage) || 0; if (after > dmgBefore) break; await sleep(250); }
          ok("§15 ⭐ ONE press applies the blast at the LANDED position, through the ordinary pipeline",
            after > dmgBefore, `damage ${dmgBefore} → ${after} (baseDamage ${F(missArea).baseDamage})`);
          out.notes.push(`§15 the landed blast applied ${after - dmgBefore} at its own centre`);
        }
        await dropArea15(missArea);
      }

      /* ── d. the HIT control: nothing scatters, and the card says on target ───────────────────── */
      const aimAtHit = aimPoint();
      const hitArea = await throwBlast({ hit: true, radius: 3 });
      ok("§15 a landing throw places its blast too", !!hitArea);
      if (hitArea) {
        const f = F(hitArea);
        ok("§15 CONTROL — a hit records no scatter at all (negative)",
          f.scattered === false && Number(f.scatterDriftM) === 0 && Number(f.scatterDirFace) === 0,
          JSON.stringify({ scattered: f.scattered, drift: f.scatterDriftM, face: f.scatterDirFace }));
        ok("§15 CONTROL — and its blast is centred exactly where it was aimed, by value",
          Math.abs(Number(f.originX) - aimAtHit.x) < 0.5 && Math.abs(Number(f.originY) - aimAtHit.y) < 0.5,
          JSON.stringify({ placed: [f.originX, f.originY], aimed: [aimAtHit.x, aimAtHit.y] }));
        let hitCard = null;
        for (let i = 0; i < 40 && !hitCard; i++) { hitCard = cardFor(hitArea.id); if (!hitCard) await sleep(250); }
        ok("§15 CONTROL — the hit's card says on target",
          !!hitCard && (hitCard.content ?? "").includes(game.i18n.localize("CYBERPUNK.ExplosionOnTarget")),
          (hitCard?.content ?? "").slice(0, 160));
        await dropArea15(hitArea);
      }

      /* ── e. an area from the OLD flow confirms exactly as before (backward compatibility) ───── */
      // Hand-built with the pre-2026-08-28 flag set: no scatter record of any kind. It must confirm
      // through the same one control and apply the same way.
      const shapes15 = await import(`/modules/${SCOPE}/module/combat/area-shapes.js`);
      const legacyCentre = { x: Number(canvas.tokens.get(vicTok.id).center.x), y: Number(canvas.tokens.get(vicTok.id).center.y) };
      const legacy = await shapes15.createArea(scene, {
        kind: "circle", x: legacyCentre.x, y: legacyCentre.y, radiusM: 10,
        color: "#ff8800", borderColor: "#cc4400",
        flags: { isExplosion: true, baseDamage: 20, blastRadius: 10, blastFullDamageWithin: 2,
                 blastMultipliers: [0.5, 0.25, 0.125, 0.0625], attackerId: shooter.id,
                 weaponName: "__PW__Legacy Blast", createdRound: 0,
                 originX: legacyCentre.x, originY: legacyCentre.y },
      });
      ok("§15 COMPAT — an area carrying no scatter record can still be built and read",
        !!legacy?.doc && F(legacy.doc).scattered === undefined,
        JSON.stringify({ scattered: F(legacy?.doc ?? {}).scattered }));
      if (legacy?.doc) {
        // ⛔ THE TRACK IS CLEARED FIRST, AND THAT IS A HARNESS REPAIR WITH A NAMED MECHANISM (2026-08-28).
        // This leg asserts `after > before`, and the fixture victim has been shot by §4, §11, §13 and
        // §15's own three throws by the time it runs. Since the wound-track CEILING shipped (utils
        // `cappedWoundDamage`, WOUND_TRACK_MAX = 40, user ruling 2026-08-27) a body that has reached 40
        // cannot rise, so on a run whose dice pushed it there the leg reported a product failure that
        // was really the fixture's own accumulated damage — observed once here, 40 → 40, and green on
        // the run before it. Zeroing the track makes the leg measure the APPLY, which is what it is
        // about, instead of measuring how much the earlier sections happened to roll.
        await victim.update({ "system.damage": 0 });
        const vicBefore = Number(victim.system.damage) || 0;
        const legacyCard = await (foundry?.applications?.handlebars?.renderTemplate ?? renderTemplate)(
          `modules/${SCOPE}/templates/chat/explosion-confirm.hbs`,
          { weaponName: "__PW__Legacy Blast", radius: 10, baseDamage: 20, fullWithin: 2, templateId: legacy.doc.id });
        await ChatMessage.create({ content: legacyCard });
        let lbtn = null;
        for (let i = 0; i < 40 && !lbtn; i++) {
          lbtn = document.querySelector(`.cp-confirm-explosion[data-template-id="${legacy.doc.id}"]`);
          if (!lbtn) await sleep(250);
        }
        ok("§15 COMPAT — a card with no outcome line still renders its one confirm control", !!lbtn);
        if (lbtn) {
          lbtn.click();
          let vicAfter = vicBefore;
          for (let i = 0; i < 40; i++) { vicAfter = Number(victim.system.damage) || 0; if (vicAfter > vicBefore) break; await sleep(250); }
          ok("§15 COMPAT — and it applies exactly as it always did",
            vicAfter > vicBefore, `damage ${vicBefore} → ${vicAfter}`);
        }
        await dropArea15(legacy.doc);
      }

      /* ── f. the source negatives ─────────────────────────────────────────────────────────────── */
      const hooksSrc = await (await fetch(`/modules/${SCOPE}/module/combat/damage-hooks.js`, { cache: "no-store" })).text();
      const liveHooks = hooksSrc.split("\n").filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
      ok("§15 SOURCE — the manual scatter handler is gone from live code (negative)",
        !/_scatterExplosion\s*\(/.test(liveHooks), "_scatterExplosion in live code");
      ok("§15 SOURCE — and nothing listens for the retired button any more (negative)",
        !/cp-confirm-explosion-scatter/.test(liveHooks), "scatter selector in live code");
      const tplSrc = await (await fetch(`/modules/${SCOPE}/templates/chat/explosion-confirm.hbs`, { cache: "no-store" })).text();
      ok("§15 SOURCE — the template declares exactly one button, and it is the confirm",
        (tplSrc.match(/<button/g) ?? []).length === 1 && !/cp-confirm-explosion-scatter/.test(tplSrc),
        `${(tplSrc.match(/<button/g) ?? []).length} button(s) in the template`);
      ok("§15 SOURCE — the retired button's string is gone from the language pack (negative)",
        game.i18n.localize("CYBERPUNK.ExplosionScatterBtn") === "CYBERPUNK.ExplosionScatterBtn",
        game.i18n.localize("CYBERPUNK.ExplosionScatterBtn"));
      ok("§15 SOURCE — and the three sentences the card prints instead all resolve to real text",
        ["ExplosionOnTarget", "ExplosionScatterLine", "ExplosionScatterNoDrift"]
          .every(k => game.i18n.localize(`CYBERPUNK.${k}`) !== `CYBERPUNK.${k}`),
        ["ExplosionOnTarget", "ExplosionScatterLine", "ExplosionScatterNoDrift"].map(k => game.i18n.localize(`CYBERPUNK.${k}`)).join(" | "));
    } finally {
      for (const d of (scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])])) {
        if (F(d).isExplosion) await d.delete().catch(() => {});
      }
      if (probeTok) await probeTok.delete().catch(() => {});
      if (probe) await probe.delete().catch(() => {});
      for (const [k, v] of Object.entries(prev15)) { try { await game.settings.set(SCOPE, k, v); } catch (_e) {} }
    }
  });

  /* ══════════════════ §16 THE THROW GESTURE — every area delivery aims on the map ══════════════════
   * MECHANISM (user ruling 2026-08-28: *"I want the throw gesture"*, for throws in general): firing an
   * area-delivery weapon opens a point-designation gesture BEFORE the fire dialog. The clicked point
   * rides the payload as two plain coordinates, the dialog's range band pre-fills from the measured
   * shooter→point distance, and the blast is CENTRED on the point when the throw lands and SCATTERS
   * FROM it when it misses. CP2020 p.108 designates a SPOT; a token was only ever a way to name one.
   *
   * Every leg reads the OUTCOME by value — the placed geometry, the rendered window's own select, the
   * DOM state of the live gesture — never an internal intention. */
  await sect("§16", async () => {
    // ⛔⛔ EVERY WORLD WRITE THIS SECTION MAKES IS INSIDE THE TRY, AND THAT IS A REPAIR WITH A COST
    // ALREADY PAID (2026-08-28). The first version set the three settings and then dynamic-imported the
    // module under test ABOVE the `try` — so on the red-first run, where that import legitimately 404'd,
    // the `finally` never ran and `combatFxEnabled` was left OFF **in the world**. The next run's §3 then
    // reported `Cannot read properties of null (reading 'ms')`: the fan-out declined to draw, the report
    // carried no arrival, and it read exactly like a product failure in a section this unit never
    // touched. It is the documented world-state-debris class (rig-keeper skill), re-earned. Nothing is
    // changed until the try owns the restore.
    const prev16 = {};
    const set16 = async (k, v) => { try { prev16[k] = game.settings.get(SCOPE, k); await game.settings.set(SCOPE, k, v); } catch (_e) {} };
    let aim = null;
    const allAreas16 = () => (scene.templates ? [...scene.templates] : []).concat([...(scene.regions ?? [])]);
    const modWindows16 = () =>
      [...foundry.applications.instances.values()].filter(a => /Modifiers/.test(a?.constructor?.name ?? ""));
    const gridDistM16 = Number(scene.grid?.distance) || 1;
    const ppm16 = gridPx / gridDistM16;
    const shCenter = () => {
      const t = canvas.tokens.get(shTok.id);
      return { x: t?.center?.x ?? t?.x, y: t?.center?.y ?? t?.y };
    };

    try {
      await set16("explosivesEnabled", true);
      await set16("explosivesDetailed", false);
      await set16("combatFxEnabled", false);      // §16 is about the aim, not the picture
      aim = await import(`/modules/${SCOPE}/module/combat/aim-placement.js`);
      ok("§16 HARNESS GUARD — the thrower and the target are both on the canvas this section measures on",
        canvas.scene?.id === scene.id && !!canvas.tokens.get(shTok.id) && !!canvas.tokens.get(vicTok.id),
        `scene=${canvas.scene?.id === scene.id} shooter=${!!canvas.tokens.get(shTok.id)} target=${!!canvas.tokens.get(vicTok.id)}`);

      /* ── a. the PURE derivations the gesture and the dialog share ────────────────────────────── */
      ok("§16 the ghost's area is the weapon's OWN radius when it states one, by value",
        aim.aimPreviewRadiusM({ system: { attackType: "Grenade", blastRadius: 9 } }) === 9,
        String(aim.aimPreviewRadiusM({ system: { attackType: "Grenade", blastRadius: 9 } })));
      ok("§16 …and the book's p.99 row for its kind when it states none, by value (grenade 5m, missile 6m, rpg 4m)",
        aim.aimPreviewRadiusM({ system: { attackType: "Grenade" } }) === 5
        && aim.aimPreviewRadiusM({ system: { attackType: "Missile" } }) === 6
        && aim.aimPreviewRadiusM({ system: { attackType: "RPG" } }) === 4,
        `${aim.aimPreviewRadiusM({ system: { attackType: "Grenade" } })}/${aim.aimPreviewRadiusM({ system: { attackType: "Missile" } })}/${aim.aimPreviewRadiusM({ system: { attackType: "RPG" } })}`);
      ok("§16 NEGATIVE — an ordinary rifle is not an area delivery and gets no ghost at all",
        aim.aimPreviewRadiusM({ system: { attackType: "Single Shot" } }) === 0,
        String(aim.aimPreviewRadiusM({ system: { attackType: "Single Shot" } })));

      // The band prefill's own derivation, at a NEAR point and a FAR one out of the same 50 m weapon:
      // p.99 puts Close at ¼ (12.5 m) and Long at the full range, so 5 m and 40 m are two different
      // bands and the pair is what proves the measurement is of the POINT rather than of a token.
      const o16 = shCenter();
      const near = aim.aimPointRangeBand(o16, { x: o16.x + 5 * ppm16, y: o16.y }, 50);
      const far  = aim.aimPointRangeBand(o16, { x: o16.x + 40 * ppm16, y: o16.y }, 50);
      ok("§16 the band a designated point sits in is measured from the THROWER, by value — near",
        near.category === "close" && Math.abs(near.distanceM - 5) <= 1.2, JSON.stringify(near));
      ok("§16 …and a far point out of the SAME weapon reads a different band, by value",
        far.category === "long" && Math.abs(far.distanceM - 40) <= 1.5, JSON.stringify(far));

      /* ── b. the gesture ARMS on fire, and ESC cancels the whole shot ─────────────────────────── */
      await shooter.sheet.render(true);
      await sleep(1200);
      const view = () => canvas.app?.view ?? document.getElementById("board");
      const clickFire = (item) => {
        const ctl = shooter.sheet.element?.querySelector(`.fire-weapon[data-item-id="${item.id}"]`);
        ctl?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return ctl;
      };
      const moveTo = async (px, py) => {
        const t = canvas.stage.worldTransform.apply(new PIXI.Point(px, py));
        window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: t.x, clientY: t.y }));
        await sleep(120);
      };
      const clickCanvas = async () => {
        view()?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
        await sleep(250);
      };

      for (const w of modWindows16()) { try { await w.close(); } catch (_e) {} }
      await sleep(200);
      const msgsBefore = new Set(game.messages.map(m => m.id));
      const areasBefore = new Set(allAreas16().map(d => d.id));
      const fireCtl = clickFire(frag);
      await sleep(400);
      ok("§16 ⭐ the gesture ARMS on the real fire click — and the fire dialog is NOT open yet",
        !!fireCtl && aim.aimPointPlacementActive() === true && modWindows16().length === 0,
        `ctl=${!!fireCtl} armed=${aim.aimPointPlacementActive()} windows=${modWindows16().length}`);

      // ESC — the whole shot is cancelled: no dialog, no roll, no card, no area.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(600);
      ok("§16 ⭐ ESC cancels the shot outright — nothing armed, nothing rolled, nothing placed",
        aim.aimPointPlacementActive() === false && modWindows16().length === 0
        && [...game.messages].every(m => msgsBefore.has(m.id))
        && allAreas16().every(d => areasBefore.has(d.id)),
        `armed=${aim.aimPointPlacementActive()} windows=${modWindows16().length} newCards=${[...game.messages].filter(m => !msgsBefore.has(m.id)).length} newAreas=${allAreas16().filter(d => !areasBefore.has(d.id)).length}`);

      /* ── c. a TARGETED figure seeds the opening aim, and the band pre-fills from the point ───── */
      // The seed is read the way the dialog reads its target list, so target the victim for this leg.
      const tgtBefore = new Set([...game.user.targets].map(t => t.id));
      canvas.tokens.get(vicTok.id)?.setTarget(true, { releaseOthers: true, groupSelection: false });
      await sleep(250);

      clickFire(frag);
      await sleep(400);
      // The gesture opens ON the targeted figure's centre — read by clicking with no pointer move at
      // all, so the point that lands in the payload is the SEED and nothing else.
      const seededAreasBefore = new Set(allAreas16().map(d => d.id));
      await clickCanvas();
      for (let i = 0; i < 40 && modWindows16().length === 0; i++) await sleep(150);
      const seedWin = modWindows16()[0] ?? null;
      const vc = (() => { const t = canvas.tokens.get(vicTok.id); return { x: t?.center?.x, y: t?.center?.y }; })();
      const seedBand = aim.aimPointRangeBand(shCenter(), vc, 50);
      const seedSel = seedWin?.element?.querySelector('select[name="range"]') ?? null;
      const CATKEY = { pointBlank: "RangePointBlank", close: "RangeClose", medium: "RangeMedium", long: "RangeLong", extreme: "RangeExtreme", outOfRange: "RangeExtreme" };
      ok("§16 ⭐ a targeted figure SEEDS the opening aim — clicking without moving designates its centre, and the window opens",
        !!seedWin && !!seedSel, `window=${!!seedWin} rangeRow=${!!seedSel}`);
      ok("§16 ⭐ the dialog's RANGE BAND pre-fills from the measured shooter→point distance, by value",
        !!seedSel && seedSel.value === CATKEY[seedBand.category],
        `select=${seedSel?.value} measured=${JSON.stringify(seedBand)} expected=${CATKEY[seedBand.category]}`);
      if (seedWin) { try { await seedWin.close(); } catch (_e) {} }
      await sleep(300);

      // …and a FAR point out of the same weapon opens the same window on a DIFFERENT band. This is the
      // pair that proves the pre-fill follows the POINT and not the targeted token.
      clickFire(frag);
      await sleep(400);
      const farPt = { x: o16.x + 40 * ppm16, y: o16.y };
      await moveTo(farPt.x, farPt.y);
      await clickCanvas();
      for (let i = 0; i < 40 && modWindows16().length === 0; i++) await sleep(150);
      const farWin = modWindows16()[0] ?? null;
      const farSel = farWin?.element?.querySelector('select[name="range"]') ?? null;
      ok("§16 ⭐ …and a FAR designated point pre-fills a DIFFERENT band out of the same weapon, by value",
        !!farSel && farSel.value === CATKEY[far.category] && farSel.value !== CATKEY[seedBand.category],
        `far=${farSel?.value} near=${CATKEY[seedBand.category]} expected=${CATKEY[far.category]}`);
      if (farWin) { try { await farWin.close(); } catch (_e) {} }
      for (const t of [...game.user.targets]) if (!tgtBefore.has(t.id)) t.setTarget(false, { releaseOthers: false });
      await sleep(300);
      try { await shooter.sheet.close(); } catch (_e) {}
      await sleep(300);
      ok("§16 the gesture left nothing armed and no readout node behind it (teardown)",
        aim.aimPointPlacementActive() === false
        && document.querySelectorAll(".cp-spread-preview-readout").length === 0,
        `armed=${aim.aimPointPlacementActive()} readouts=${document.querySelectorAll(".cp-spread-preview-readout").length}`);

      /* ── d. the POINT is the blast centre on a hit, and what a MISS scatters FROM ────────────── */
      const throwAt = async ({ hit, point }) => {
        const before = new Set(allAreas16().filter(d => F(d).isExplosion).map(d => d.id));
        Hooks.callAll("cyberpunk2020.weaponFired", {
          attackerId: shooter.id, attackerTokenId: shTok.id, weaponId: frag.id,
          weaponName: "__PW__Frag", attackType: "Grenade",
          areaDamages: hit ? { Torso: [{ damage: 12 }] } : {},
          shotsFired: 1, shotsHit: hit ? 1 : 0,
          // ⛔ THE TARGET TOKEN IS CARRIED TOO, deliberately: the point must win over it, and a leg
          // that omitted the token could pass because there was nothing else to centre on.
          targetTokenId: vicTok.id, fxTargetTokenId: vicTok.id, firedByUserId: game.user.id,
          blastRadius: 25,
          ...(point ? { aimPoint: point } : {}),
        });
        for (let i = 0; i < 60; i++) {
          const a = allAreas16().find(d => F(d).isExplosion && !before.has(d.id));
          if (a) return a;
          await sleep(300);
        }
        return null;
      };
      const drop16 = async (a) => { try { await a.delete(); } catch (_e) {} };

      // A point deliberately AWAY from the target token, so "centred on the point" and "centred on the
      // token" cannot both be true.
      const declared = { x: o16.x + 12 * ppm16, y: o16.y + 7 * ppm16 };
      const tokCenter = (() => { const t = canvas.tokens.get(vicTok.id); return { x: t?.center?.x, y: t?.center?.y }; })();
      const hitArea16 = await throwAt({ hit: true, point: declared });
      ok("§16 a throw carrying a designated point still places its blast", !!hitArea16);
      if (hitArea16) {
        const f = F(hitArea16);
        ok("§16 ⭐ THE PLACED POINT IS THE BLAST CENTRE ON A HIT, by value",
          Math.round(Number(f.originX)) === Math.round(declared.x)
          && Math.round(Number(f.originY)) === Math.round(declared.y),
          `centre=(${f.originX},${f.originY}) declared=(${Math.round(declared.x)},${Math.round(declared.y)})`);
        ok("§16 ⭐ NEGATIVE — and it is NOT the targeted token's centre, which the same payload named",
          Math.hypot(Number(f.originX) - tokCenter.x, Number(f.originY) - tokCenter.y) > gridPx,
          `centre=(${f.originX},${f.originY}) token=(${tokCenter.x},${tokCenter.y})`);
        ok("§16 a landed throw records no scatter (negative)", f.scattered === false, `scattered=${f.scattered}`);
        await drop16(hitArea16);
      }

      const missArea16 = await throwAt({ hit: false, point: declared });
      ok("§16 a missed throw carrying a designated point still detonates", !!missArea16);
      if (missArea16) {
        const f = F(missArea16);
        const driftPx = Math.hypot(Number(f.originX) - declared.x, Number(f.originY) - declared.y);
        ok("§16 ⭐ THE MISS SCATTERS FROM THE POINT — the aim it records is the designated point, not a token",
          Math.round(Number(f.aimedX)) === Math.round(declared.x)
          && Math.round(Number(f.aimedY)) === Math.round(declared.y)
          && Math.hypot(Number(f.aimedX) - tokCenter.x, Number(f.aimedY) - tokCenter.y) > gridPx,
          `aimed=(${f.aimedX},${f.aimedY}) declared=(${Math.round(declared.x)},${Math.round(declared.y)}) token=(${tokCenter.x},${tokCenter.y})`);
        ok("§16 ⭐ …and the landing is inside the grenade table's own band OF THAT POINT — 1d10 metres, never more",
          f.scattered === true && driftPx / ppm16 <= 10.5 + 0.01,
          `${(driftPx / ppm16).toFixed(2)}m from the designated point (recorded ${f.scatterDriftM}m ${f.scatterDirName})`);
        await drop16(missArea16);
      }

      /* ── e. THE FALLBACK — a payload with no point still centres on the target token ─────────── */
      const noPointArea = await throwAt({ hit: true, point: null });
      ok("§16 COMPAT — a payload carrying NO designated point still places a blast", !!noPointArea);
      if (noPointArea) {
        const f = F(noPointArea);
        ok("§16 ⭐ COMPAT — and it is centred on the TARGET TOKEN exactly as it was before the gesture existed",
          Math.round(Number(f.originX)) === Math.round(tokCenter.x)
          && Math.round(Number(f.originY)) === Math.round(tokCenter.y),
          `centre=(${f.originX},${f.originY}) token=(${Math.round(tokCenter.x)},${Math.round(tokCenter.y)})`);
        await drop16(noPointArea);
      }

      /* ── f. the payload contract + the strings ──────────────────────────────────────────────── */
      const shimSrc = await (await fetch(`/modules/${SCOPE}/module/seam-shim.js`, { cache: "no-store" })).text();
      ok("§16 SOURCE — the seam emits the field on the payload, from the attack modifiers it rode in on",
        /aimPoint:\s*_fireCtx\.aimPoint/.test(shimSrc) && /aimPoint:\s*attackMods\?\.cpAimPoint/.test(shimSrc),
        "seam-shim carries cpAimPoint → aimPoint");
      ok("§16 the gesture's own strings all resolve to real text",
        ["AimPointArmed", "AimPointArmedFor", "AimPointReadout", "AimPointRangeNote", "AimPointNoToken"]
          .every(k => game.i18n.localize(`CYBERPUNK.${k}`) !== `CYBERPUNK.${k}`),
        ["AimPointArmed", "AimPointReadout", "AimPointRangeNote"].map(k => game.i18n.localize(`CYBERPUNK.${k}`)).join(" | "));
    } finally {
      try { aim?.cancelAimPointPlacement(); } catch (_e) { /* not armed */ }
      for (const w of modWindows16()) { try { await w.close(); } catch (_e) {} }
      try { await shooter.sheet.close(); } catch (_e) {}
      for (const d of allAreas16()) if (F(d).isExplosion) await d.delete().catch(() => {});
      for (const [k, v] of Object.entries(prev16)) { try { await game.settings.set(SCOPE, k, v); } catch (_e) {} }
    }
  });

  /* ══════════════════ cleanup — tokens BEFORE actors ══════════════════ */
  SECT = "(cleanup)";
  for (const t of [...scene.tokens].filter(t => t.name?.startsWith("__PW__"))) await t.delete().catch(() => {});
  for (const coll of [scene.templates, scene.regions]) if (coll) for (const d of [...coll]) if (F(d).isExplosion) await d.delete().catch(() => {});
  for (const a of [...game.actors].filter(a => a.name?.startsWith("__PW__"))) await a.delete().catch(() => {});
  for (const w of [...scene.walls].filter(w => F(w).__pwGrenade === true)) await w.delete().catch(() => {});
  // ⚠ THE SWEEP READS THREE PLACES, NOT ONE (2026-08-28). It matched `content` only, and §12's tick
  // posts roll cards whose fixture name is in the FLAVOR ("🔥 Fire DOT — __PW__Victim burns at …") and
  // save prompts whose only fixture reference is the SPEAKER's alias. Those survived the sweep, and a
  // later suite re-rendering a prompt card whose actor no longer exists logged one unattributable
  // `Cannot set properties of null (setting 'hidden')` — observed once in the spread-zone suite run
  // immediately after this one, gone on a clean re-run. Debris this suite made, cleared by this suite.
  const pwCard = (m) => /__PW__/.test(m.content ?? "") || /__PW__/.test(m.flavor ?? "")
    || /__PW__/.test(m.speaker?.alias ?? "") || /__PW__/.test(m.rolls?.[0]?.options?.flavor ?? "");
  for (const m of [...game.messages].filter(pwCard)) await m.delete().catch(() => {});

  console.error = realConsoleError;
  return out;
}, { SCOPE, ROUND_SOURCES });

for (const c of res.checks) check(c.n, c.p, c.d);
for (const n of res.notes ?? []) console.log(`  note: ${n}`);
check("0 console errors", errors.length === 0, errors.slice(0, 4).join(" | "));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
