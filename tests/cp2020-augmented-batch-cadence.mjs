/**
 * KEEPER: the per-application severity cadence ("batch cadence").
 *
 * MECHANISM UNDER TEST. One application — a multi-hit resolution against one target, a corridor of
 * shells against everyone standing in it — is ONE moment of the fight. Before this unit the severity
 * check ran once per damage event and each run was free to post its own card and its own forced mortal
 * prompt, so a multi-hit application produced a run of cards for one trigger pull (measured: five
 * events into one zone → eleven cards). The ruled cadence:
 *
 *   §1 ONE consolidated progression card per body per application, carrying the severity ladder
 *   §2 ONE mortal prompt per body per application, at the tier the application FINISHED on
 *   §3 a persistent same-zone guard: a zone already recorded at the same-or-worse grade is not
 *      re-recorded and not re-announced — the damage still applies
 *   §4 single-event compatibility: an application of ONE event replays that event's own card verbatim
 *   §5 the corridor's apply-time impact audio stands down when the presentation rail already sounded
 *      those figures at arrival (the rail's own predicate pair), with a positive control next to it
 *
 * Counts are asserted BY VALUE — the number of cards a reader has to work through is the thing the
 * ruling is about, so every leg counts cards rather than checking that something was posted.
 *
 * ⛔ Every fixture is named __PWK__BATCH and is removed on the way out; every world setting this spec
 * pins is restored in a finally block (world-state debris has reddened unrelated suites before).
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW  = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";

let pass = 0, fail = 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(m.text())) errors.push(m.text()); });
page.on("pageerror", e => errors.push(e.message));

await page.goto(`${URL}/join`);
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const sel = document.querySelector('select[name="userid"]');
  sel.value = [...sel.options].find(o => /gamemaster/i.test(o.textContent)).value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 60000 });

const res = await page.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  const out = { checks: [] };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  if (!game.scenes.active) await game.scenes.contents[0]?.activate();
  const scene = game.scenes.active ?? game.scenes.contents[0];

  const hooks = await import(`/modules/${SCOPE}/module/combat/damage-hooks.js`);
  const DA    = await import(`/modules/${SCOPE}/module/combat/DamageApplicator.js`);
  const FX    = await import(`/modules/${SCOPE}/module/fx/effects.js`);

  // ── card counting, by the marker class each template carries ──────────────────────────────────
  const CARD = {
    progression: "severity-progression",
    zoneCard:    "limb-wound",
    headCard:    "head-wound-death",
    mortalPrompt: "death-save-prompt",
    stunPrompt:  "stun-save-prompt",
  };
  const since = () => new Set(game.messages.map(m => m.id));
  const newCards = (mark) => (from) =>
    [...game.messages].filter(m => !from.has(m.id) && (m.content ?? "").includes(mark));
  const count = (mark, from) => newCards(mark)(from).length;
  const wipeSince = async (from) => {
    for (const m of [...game.messages].filter(m => !from.has(m.id))) await m.delete().catch(() => {});
  };

  // ── settings pinned for determinism, restored in the finally ──────────────────────────────────
  const KEYS = ["limbLossEnabled", "limbModel", "damageArmorMode",
                "combatFxEnabled", "headHitDoubling",
                "combatAutomationEnabled"];
  const was = {};
  for (const k of KEYS) { try { was[k] = game.settings.get(SCOPE, k); } catch { was[k] = null; } }
  const set = async (k, v) => { try { await game.settings.set(SCOPE, k, v); } catch (e) {} };
  const lockedWas = game.audio.locked;
  const startedAt = since();

  let target = null, shooter = null, targetTok = null, shooterTok = null, solo = null, soloTok = null;

  try {
    await set("limbLossEnabled", true);
    await set("limbModel", "core");
    await set("damageArmorMode", "none");
    // ⏪ the wear-on-penetration boolean, the absent-limb re-roll switch and the pattern switch all
    //    retired 2026-08-29 (settings-trim). "none" already excludes armor entirely, the re-roll runs
    //    unconditionally, and the pattern lane is always available.
    await set("headHitDoubling", true);
    await set("combatAutomationEnabled", true);
    await set("combatFxEnabled", false);   // §5 turns it back on for the audio legs only

    // stale fixtures first — tokens before actors (deleting an actor leaves an unlinked token standing)
    for (const t of [...(scene.tokens ?? [])].filter(t => t.name?.startsWith("__PWK__BATCH"))) {
      await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
    }
    for (const a of [...game.actors].filter(a => a.name?.startsWith("__PWK__BATCH"))) await a.delete().catch(() => {});
    await sleep(250);

    shooter = await Actor.create({ name: "__PWK__BATCH Shooter", type: "character" });
    target  = await Actor.create({ name: "__PWK__BATCH Target",  type: "character" });
    solo    = await Actor.create({ name: "__PWK__BATCH Solo",    type: "character" });
    // actorLink: true — an unlinked token's engine reads a different document than the spec does.
    // ⚠ RESOLVED BY NAME, never by return position: createEmbeddedDocuments does not promise the input
    // order back, and a positional read here silently pointed every leg at the wrong body.
    const made = await scene.createEmbeddedDocuments("Token", [
      { name: "__PWK__BATCH Target",  actorId: target.id,  actorLink: true, x: 700, y: 200, width: 1, height: 1 },
      { name: "__PWK__BATCH Shooter", actorId: shooter.id, actorLink: true, x: 300, y: 200, width: 1, height: 1, rotation: 0 },
      { name: "__PWK__BATCH Solo",    actorId: solo.id,    actorLink: true, x: 700, y: 600, width: 1, height: 1 },
    ]);
    const byName = (n) => made.find(t => t.name === n) ?? [...scene.tokens].find(t => t.name === n);
    targetTok  = byName("__PWK__BATCH Target");
    shooterTok = byName("__PWK__BATCH Shooter");
    soloTok    = byName("__PWK__BATCH Solo");
    await sleep(300);

    const btm = Number(target.system.stats?.bt?.modifier) || 0;
    ok("fixture: linked target token resolves to the fixture actor",
       targetTok.actor === target && soloTok.actor === solo, `btm=${btm}`);

    // The fired-event seam, driven with a fixed set of landed rounds so the counts under test are not
    // at the mercy of a to-hit roll. This is PATH A of the module's own weaponFired listener.
    //
    // ⭐ THE APPLICATION IS THE CONFIRMATION WINDOW'S OWN APPLY. There is no unattended route any more
    // (the world-wide auto-apply toggle and the route it selected were retired 2026-08-14), so PATH A
    // ends in one window per application and the button in it is what writes the damage these legs
    // count cards for. Driving the real control rather than an internal keeps the batch under test the
    // window's own ledger, which is the one a table now always gets.
    const damageWindows = () =>
      [...foundry.applications.instances.values()].filter(a => /DamageDialog/.test(a?.constructor?.name ?? ""));
    const fire = async (areaDamages, actorTok = targetTok) => {
      const payload = {
        attackerId: shooter.id, weaponName: "__PWK__BATCH Rounds",
        areaDamages, shotsFired: 1, shotsHit: 1,
        targetTokenId: actorTok.id, fxTargetTokenId: actorTok.id, firedByUserId: game.user.id,
        caliber: "5.56", modifier: "standard", spreadMode: "single",
      };
      for (const w of damageWindows()) { try { await w.close(); } catch (e) { /* already closed */ } }
      Hooks.callAll("cyberpunk2020.weaponFired", payload);
      // The window opens once the shot has finished being presented, so it is waited FOR rather than
      // slept past — a fixed sleep would race the rail's own settle signal.
      for (let i = 0; i < 80 && damageWindows().length === 0; i++) await sleep(100);
      const win = damageWindows()[0] ?? null;
      const applyCtl = win?.element?.querySelector('[data-action="applyDamage"]') ?? null;
      payload.__windowOpened = !!applyCtl;
      applyCtl?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 80 && damageWindows().length > 0; i++) await sleep(100);
      await sleep(1200);   // the ledger closes (cards + prompts) after the window has gone
      return payload;
    };
    const rounds = (n, dmg) => Array.from({ length: n }, () => ({ damage: dmg }));

    /* ── §1  the consolidated progression card ────────────────────────────────────────────────── */
    await target.update({ "system.damage": 0 });
    let from = since();
    // ⚠ FIVE, NOT SIX, PER EVENT (2026-08-27). The wound track now stops at its last box (forty — see
    // §8), and seven events of six ran 42 past it, so the "seven events wrote seven times" reading was
    // being answered by the clamp rather than by the cadence. Five keeps the whole application inside
    // the track, which is what lets this leg go on saying what it was written to say.
    const p1 = await fire({ Torso: rounds(7, 5 + btm) });
    ok("§1 the seam claimed the resolution (so the counts below are this flow's)",
       p1.handled === SCOPE, `handled=${p1.handled}`);
    ok("§1 seven damage events wrote the wound track once each", Number(target.system.damage) === 35,
       `damage=${target.system.damage}`);
    ok("§1 a seven-event application posts exactly ONE progression card",
       count(CARD.progression, from) === 1, `progression=${count(CARD.progression, from)}`);
    ok("§1 and exactly ONE mortal prompt for the whole application",
       count(CARD.mortalPrompt, from) === 1, `mortal=${count(CARD.mortalPrompt, from)}`);
    const card1 = newCards(CARD.progression)(from)[0]?.content ?? "";
    ok("§1 the card names the event count by value", /\b7 hits\b/.test(card1), card1.slice(0, 160).replace(/\s+/g, " "));
    ok("§1 the card carries a multi-step ladder, not a single label",
       (card1.match(/→/g) ?? []).length >= 2, `arrows=${(card1.match(/→/g) ?? []).length}`);
    const finalLabel = (() => {
      const ws = target.woundState?.() ?? 0;
      return ws >= 4 ? `Mortal ${Math.min(ws, 10) - 4}` : ["Uninjured", "Light", "Serious", "Critical"][ws];
    })();
    ok("§1 the ladder ENDS on the tier the application finished at, by value",
       card1.includes(finalLabel), `${finalLabel} :: ${card1.slice(0, 200).replace(/\s+/g, " ")}`);
    ok("§1 a torso-only application announces no zone outcome (negative)",
       count(CARD.zoneCard, from) === 0 && count(CARD.headCard, from) === 0,
       `zone=${count(CARD.zoneCard, from)} head=${count(CARD.headCard, from)}`);
    await wipeSince(from);

    /* ── §2  the flood leg: five events into ONE zone ─────────────────────────────────────────── */
    await target.update({ "system.damage": 0 });
    await target.unsetFlag(SCOPE, "fleshLimbStatus").catch(() => {});
    from = since();
    await fire({ rArm: rounds(5, 20 + btm) });
    const totals2 = {
      progression: count(CARD.progression, from),
      zone:        count(CARD.zoneCard, from),
      mortal:      count(CARD.mortalPrompt, from),
      stun:        count(CARD.stunPrompt, from),
    };
    ok("§2 five events into one zone post exactly ONE progression card",
       totals2.progression === 1, JSON.stringify(totals2));
    ok("§2 and exactly ONE mortal prompt (not one per event)",
       totals2.mortal === 1, JSON.stringify(totals2));
    ok("§2 the per-event zone cards are gone — the batch card carries the outcome instead",
       totals2.zone === 0, JSON.stringify(totals2));
    const card2 = newCards(CARD.progression)(from)[0]?.content ?? "";
    ok("§2 the batch card names that zone exactly once, however many events reached it",
       (card2.match(/Right Arm/g) ?? []).length === 1, card2.replace(/\s+/g, " ").slice(0, 240));
    ok("§2 the zone record was written by value", (target.getFlag(SCOPE, "fleshLimbStatus") ?? {}).rArm === "severed",
       JSON.stringify(target.getFlag(SCOPE, "fleshLimbStatus") ?? {}));
    // ⭐ THREE, NOT TWO, SINCE 2026-08-27 — and the third is a card this application was always owed.
    // The apply window's own tail posted the death save alone at Mortal while BOTH sibling rails posted
    // the death+stun PAIR (save-rolls.js `postSavePrompts`, damage-hooks.js `_postWoundSavePrompts`),
    // so a figure dropped to Mortal through this window was never asked whether it was still conscious.
    // The composition is named rather than counted blind, so a future flood cannot hide inside the
    // total: ONE progression card + ONE death prompt + ONE consciousness check, and nothing else.
    ok("§2 total cards for the whole application is 3 — the progression card and the Mortal PAIR",
       [...game.messages].filter(m => !from.has(m.id)).length === 3
       && totals2.progression === 1 && totals2.mortal === 1 && totals2.stun === 1,
       `${[...game.messages].filter(m => !from.has(m.id)).length} · ${JSON.stringify(totals2)}`);
    await wipeSince(from);

    /* ── §3  the persistent same-zone guard ───────────────────────────────────────────────────── */
    // ⚠ HEADROOM RESTORED FIRST (2026-08-27). §2 left this figure ON the track's last box, and "its
    // damage still lands" cannot be read off a full track — the clamp would answer it, not the guard.
    // The zone RECORD (`fleshLimbStatus`) is untouched, which is the state this section is actually about.
    // ⏪ ADAPTED 2026-08-29 (settings-trim). This section used to pin the absent-limb re-roll OFF so a
    //    second application could be aimed straight back AT the recorded zone. That switch is retired and
    //    the re-roll runs unconditionally, so a hit named for a severed limb is MOVED before the
    //    applicator ever sees it — the old premise is unreachable through the fire path. The section
    //    keeps its subject (the recorded zone is neither re-announced nor re-graded, and the damage
    //    still lands) and pins the die the re-roll rolls, so where the hit goes is a fixture rather than
    //    a coin toss. Face 3 is Torso on the Core map, which carries no limb card and no head doubling
    //    — the two things that would otherwise move the numbers this section reads.
    //    v14 maps a die face as ceil((1 − u) × faces), so u = 1 − (3 − 0.5)/10 = 0.75 forces a 3.
    await target.update({ "system.damage": 10 });
    const dmgBefore3 = Number(target.system.damage) || 0;
    const uniformWas3 = CONFIG.Dice.randomUniform;
    from = since();
    try {
      CONFIG.Dice.randomUniform = () => 0.75;
      await fire({ rArm: rounds(1, 20 + btm) });
    } finally { CONFIG.Dice.randomUniform = uniformWas3; }
    const cards3 = [...game.messages].filter(m => !from.has(m.id)).map(m => m.content ?? "").join(" ");
    ok("§3 the already-recorded zone is not re-announced by any card of this application",
       !/Right Arm/.test(cards3),
       cards3.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 200) || "(no cards)");
    ok("§3 and no limb card or progression card was posted at all for the moved hit",
       count(CARD.zoneCard, from) === 0 && count(CARD.progression, from) === 0,
       `zone=${count(CARD.zoneCard, from)} progression=${count(CARD.progression, from)}`);
    ok("§3 and its damage still lands, by value",
       Number(target.system.damage) === dmgBefore3 + 20, `${dmgBefore3} -> ${target.system.damage}`);
    ok("§3 the recorded grade is unchanged (no re-write to a lesser or equal grade)",
       (target.getFlag(SCOPE, "fleshLimbStatus") ?? {}).rArm === "severed",
       JSON.stringify(target.getFlag(SCOPE, "fleshLimbStatus") ?? {}));
    await wipeSince(from);

    /* ── §4  single-event compatibility: one event = the event's own card, unchanged ───────────── */
    await solo.update({ "system.damage": 0 });
    await solo.unsetFlag(SCOPE, "fleshLimbStatus").catch(() => {});
    const soloBtm = Number(solo.system.stats?.bt?.modifier) || 0;
    from = since();
    await fire({ lArm: rounds(1, 12 + soloBtm) }, soloTok);   // net 12: over the zone threshold, below Mortal
    const totals4 = {
      progression: count(CARD.progression, from),
      zone:        count(CARD.zoneCard, from),
      mortal:      count(CARD.mortalPrompt, from),
      stun:        count(CARD.stunPrompt, from),
    };
    ok("§4 a one-event application posts the event's OWN card, not a progression card",
       totals4.zone === 1 && totals4.progression === 0, JSON.stringify(totals4));
    ok("§4 and the one mortal prompt the zone outcome forces",
       totals4.mortal === 1, JSON.stringify(totals4));
    ok("§4 with the stun prompt its wound track owes, per damage event (unchanged)",
       totals4.stun === 1, JSON.stringify({ ...totals4, ws: solo.woundState?.() }));
    ok("§4 the single card is the un-batched one, verbatim",
       (newCards(CARD.zoneCard)(from)[0]?.content ?? "").includes("Limb Loss"),
       (newCards(CARD.zoneCard)(from)[0]?.content ?? "").replace(/\s+/g, " ").slice(0, 160));
    await wipeSince(from);

    /* ── §5  the corridor's apply-time impact audio ───────────────────────────────────────────── */
    // The rail sounds the figures a corridor caught at their ARRIVAL; the apply that follows the GM's
    // confirm must not sound them again. Captured through the rail's own sink, so the leg makes no
    // noise and counts plays by value rather than by ear.
    const heard = [];
    await set("combatFxEnabled", true);
    game.audio.locked = false;
    FX._setHitSoundSink((e) => heard.push(e));
    const myZones = () => [...(scene?.regions ?? [])].filter(r => r?.flags?.[SCOPE]?.isSpreadZone === true);
    const wipeZones = async () => {
      await sleep(150);
      for (const r of myZones()) { if (scene?.regions?.get?.(r.id)) await r.delete().catch(() => {}); }
    };
    try {
      await wipeZones();
      await target.update({ "system.damage": 0 });
      await target.unsetFlag(SCOPE, "fleshLimbStatus").catch(() => {});
      from = since();
      heard.length = 0;
      await hooks._placeSpreadZone({
        attackerId: shooter.id, weaponName: "__PWK__BATCH Shell Gun",
        areaDamages: { Torso: [{ damage: 7 }] }, shotsFired: 3, shotsHit: 1,
        targetTokenId: targetTok.id, fxTargetTokenId: targetTok.id, firedByUserId: game.user.id,
        caliber: "00", modifier: "standard", spreadMode: "single",
        spreadDamageShort: "5", spreadDamageMedium: "5", spreadDamageLong: "5",
      });
      await sleep(700);
      const placed = myZones();
      ok("§5 the corridor was planted (the leg below has something to confirm)",
         placed.length === 1, `zones=${placed.length}`);
      ok("§5 the corridor records which flow owns it, so the confirm can ask the rail's question",
         placed[0]?.flags?.[SCOPE]?.spreadMode === "buck", String(placed[0]?.flags?.[SCOPE]?.spreadMode));
      if (placed.length === 1) {
        await hooks._confirmSpreadZone(placed[0].id);
        await sleep(3500);
        const applyPlays = heard.splice(0).length;
        ok("§5 the corridor's apply sounds nothing — the rail already sounded those figures on arrival",
           applyPlays === 0, `${applyPlays} play(s)`);
        ok("§5 and the corridor's own cadence holds: one progression card, one mortal prompt",
           count(CARD.progression, from) === 1 && count(CARD.mortalPrompt, from) <= 1,
           `progression=${count(CARD.progression, from)} mortal=${count(CARD.mortalPrompt, from)}`);
      } else {
        ok("§5 the corridor's apply sounds nothing", false, "no corridor planted");
        ok("§5 and the corridor's own cadence holds", false, "no corridor planted");
      }
      await wipeZones();
      await wipeSince(from);

      // POSITIVE CONTROL, same sink, same switch: a hand-applied hit has no arrival clock to be late
      // for, so it still sounds. Without this the silence above could be a dead sink.
      // ⛔ REPOINTED TO THE STRUCTURE KIND 2026-08-29. The plain-character clip is WITHDRAWN
      //    (module/fx/effects.js `HIT_SOUND.flesh: { base: null }`, commit 7328447), so `hitSoundSrc`
      //    answers null for that kind and the sweep filters every plain figure before it can be counted
      //    — which reads as "no plan" and takes the MECHANISM under test down with it. The structure
      //    kind still rings, so the figure is flagged structural for this section only and handed back
      //    immediately after. The withdrawal is TEMPORARY by its own record (effects.js keeps the revert
      //    line; docs/FX-RAIL.md §6 carries the ruling), so ↪ RE-POINT THIS BACK to a plain figure when
      //    the clip returns.
      //    The flag is the shipped structural predicate's own explicit door (`isFullBorg`,
      //    mech/borg.js:121 → `bearsStructuralSdp`, effects.js:6014).
      await solo.setFlag(SCOPE, "fullBorg", true);
      await sleep(250);
      heard.length = 0;
      from = since();
      await DA.applyLocationDamage({ target: solo, location: "Torso", netDamage: 4, structuralDamage: 4, penetrates: true, token: soloTok.object ?? null });
      await sleep(400);
      const handPlays = heard.splice(0).length;
      await solo.unsetFlag(SCOPE, "fullBorg").catch(() => {});
      await sleep(200);
      ok("§5 a hand-applied hit still sounds at the apply (positive control — the sink is alive)",
         handPlays === 1, `${handPlays} play(s)`);
      ok("§5 and the control handed the figure back — the structural flag is off again",
         solo.getFlag(SCOPE, "fullBorg") === undefined, String(solo.getFlag(SCOPE, "fullBorg")));
      await wipeSince(from);
    } finally {
      FX._setHitSoundSink(null);
      game.audio.locked = lockedWas;
      await set("combatFxEnabled", false);
      await wipeZones();
    }

    /* ────────────────────────────────────────────────────────────────────────────────────────────
       §6 ONE DICE SOUND PER APPLY.

       Reported from the table 2026-08-19: *"hitting apply on a large shotgun volley — 20 ROF tested
       — plays 20 dice sounds crushed together"*. The mechanism is the same one-application/many-events
       shape the rest of this spec is about, one level further out. A volley against a vehicle is
       resolved ROUND BY ROUND against the armour (pooling the rounds would over-penetrate), each round
       posts its own resolution card, that card carries its rolls so dice modules can read them — and
       the core stamps a dice sound onto any message that carries rolls without naming a sound of its
       own. Twenty rounds, twenty stamped sounds, one click.

       Counted BY VALUE off the created documents rather than by listening: `message.sound` IS what the
       chat log plays, so the field is the honest reading and it is deterministic. The card count is
       asserted beside it — the fix must silence sounds and change nothing else. */
    {
      const VW = await import(`/modules/${SCOPE}/module/vehicle/vehicle-weapons.js`);
      const VKEYS = ["mmEnabled", "vehicleRuleSystem"];
      const vWas = {};
      for (const k of VKEYS) { try { vWas[k] = game.settings.get(SCOPE, k); } catch { vWas[k] = null; } }
      let rig = null;
      try {
        await set("mmEnabled", true);
        await set("vehicleRuleSystem", "MaximumMetal");

        rig = await Actor.create({
          name: "__PWK__BATCH Rig", type: `${SCOPE}.vehicle`,
          system: { vehicleType: "car", sdp: { value: 400, max: 400 } },
        });
        await sleep(400);

        const rounds = (n) => ({ Torso: Array.from({ length: n }, () => ({ damage: 12 })) });
        const readCards = (from) => [...game.messages].filter(m => !from.has(m.id));

        // the volley: one apply gesture, twenty rounds
        let from = since();
        const sdpBefore = Number(rig.system.sdp?.value) || 0;
        await VW.routeWeaponFiredToVehicle({ areaDamages: rounds(20), ap: false }, rig);
        await sleep(2500);
        const volley = readCards(from);
        out.dice = {
          volleyCards: volley.length,
          volleySounded: volley.filter(m => !!m.sound).length,
          volleySilenced: volley.filter(m => m.sound === null).length,
          volleyAllCarryRolls: volley.length > 0 && volley.every(m => (m.rolls?.length ?? 0) > 0),
          soundValue: volley.find(m => !!m.sound)?.sound ?? null,
          // The resolution really RAN for every round: each card is the vehicle damage result card,
          // naming this vehicle. (Maximum Metal resolves by severity and crit effects, so an ordinary
          // round moves no SDP at all — the card is the outcome, not the pool.)
          volleyAllResolved: volley.length > 0
            && volley.every(m => (m.content ?? "").includes("vehicle-damage-result")
                              && (m.content ?? "").includes("__PWK__BATCH Rig")),
          sdpBefore,
        };
        await wipeSince(from);

        // the single round, after the budget's window has gone quiet — the case that must be
        // untouched: one card, and it still sounds exactly as it always did
        await sleep(1200);
        from = since();
        await VW.routeWeaponFiredToVehicle({ areaDamages: rounds(1), ap: false }, rig);
        await sleep(1200);
        const single = readCards(from);
        out.dice.singleCards = single.length;
        out.dice.singleSounded = single.filter(m => !!m.sound).length;
        await wipeSince(from);
      } catch (e) {
        out.dice = { error: String(e?.message ?? e) };
      } finally {
        if (rig) await rig.delete().catch(() => {});
        for (const k of VKEYS) if (vWas[k] !== null) await set(k, vWas[k]);
      }
    }

    /* ────────────────────────────────────────────────────────────────────────────────────────────
       §7 ONE STUN SAVE PER APPLICATION, AT THE STATE IT FINISHED ON (user ruling 2026-08-27).

       Reported from the table: a corridor of shells produced a run of stun prompts for one trigger
       pull. The mechanism is the same one-application/many-events shape §1 and §2 close for the
       progression card and the mortal prompt — the stun half was simply left on the per-event cadence
       (Core p.104's "every time a character takes damage", which the code comment still preserves as
       the alternative reading). The ruling: one attack, one stun save, priced at the wound state the
       whole application FINISHED on — not at the state the first shell happened to reach.

       Driven through the corridor's own confirm, which is the real multi-event application a table
       meets, and counted BY VALUE: the number of prompts a reader has to resolve is the thing the
       ruling is about. */
    {
      const myZones7 = () => [...(scene?.regions ?? [])].filter(r => r?.flags?.[SCOPE]?.isSpreadZone === true);
      const wipeZones7 = async () => {
        await sleep(150);
        for (const r of myZones7()) { if (scene?.regions?.get?.(r.id)) await r.delete().catch(() => {}); }
      };
      const corridor = async (shells) => {
        await hooks._placeSpreadZone({
          attackerId: shooter.id, weaponName: "__PWK__BATCH Stun Gun",
          areaDamages: { Torso: [{ damage: 8 }] }, shotsFired: shells, shotsHit: 1,
          targetTokenId: targetTok.id, fxTargetTokenId: targetTok.id, firedByUserId: game.user.id,
          caliber: "00", modifier: "standard", spreadMode: "single",
          spreadDamageShort: "8", spreadDamageMedium: "8", spreadDamageLong: "8",
        });
        await sleep(700);
        const placed = myZones7();
        if (placed.length !== 1) return { planted: false };
        await hooks._confirmSpreadZone(placed[0].id);
        await sleep(3500);
        return { planted: true };
      };
      try {
        await wipeZones7();
        await target.update({ "system.damage": 0 });
        await target.unsetFlag(SCOPE, "fleshLimbStatus").catch(() => {});
        from = since();
        const four = await corridor(4);
        const dmg7 = Number(target.system.damage) || 0;
        const stun7 = count(CARD.stunPrompt, from);
        ok("§7 the four-shell corridor was planted and confirmed (the counts below are its own)",
           four.planted === true && dmg7 > 0, `planted=${four.planted} damage=${dmg7}`);
        ok("§7 a four-event application asks for exactly ONE stun save, not one per event",
           stun7 === 1, `stun prompts=${stun7} for ${dmg7} damage`);
        // The state the application FINISHED on, read off the figure and matched against what the one
        // prompt actually printed — "once" at the wrong tier would be a different defect passing as a fix.
        const ws7 = target.woundState?.() ?? 0;
        const label7 = ws7 >= 4 ? `Mortal ${Math.min(ws7, 10) - 4}`
                                : ["Uninjured", "Light", "Serious", "Critical"][ws7];
        const stunCard7 = newCards(CARD.stunPrompt)(from)[0]?.content ?? "";
        ok("§7 and it is priced at the state the application FINISHED on, by value",
           stunCard7.includes(label7), `${label7} :: ${stunCard7.replace(/\s+/g, " ").slice(0, 200)}`);
        ok("§7 the mortal half is unchanged — still exactly one for the application",
           count(CARD.mortalPrompt, from) <= 1, `mortal=${count(CARD.mortalPrompt, from)}`);
        await wipeZones7();
        await wipeSince(from);

        // COMPATIBILITY CONTROL: a ONE-event application asked for one stun save before this ruling and
        // must still ask for exactly one. Without it, "1" above could be a prompt that stopped firing.
        await target.update({ "system.damage": 0 });
        await target.unsetFlag(SCOPE, "fleshLimbStatus").catch(() => {});
        from = since();
        const one = await corridor(1);
        const stunOne = count(CARD.stunPrompt, from);
        ok("§7 CONTROL: a one-event application still asks for exactly one stun save",
           one.planted === true && stunOne === 1, `planted=${one.planted} stun=${stunOne}`);
        await wipeZones7();
        await wipeSince(from);
      } finally {
        await wipeZones7();
      }
    }

    /* ────────────────────────────────────────────────────────────────────────────────────────────
       §8 THE WOUND TRACK'S CEILING (user report 2026-08-27: a stun card printed "penalty 94").

       The track is forty boxes — ten wound states of four (the base's own `woundtracker.hbs`), and
       `woundState()` is `ceil(damage / 4)`. Nothing stopped a writer appending past the last box, so a
       range dummy shot at all afternoon banked ~380, `woundState()` answered 95 and the penalty line
       (`woundState − 1`) printed 94 beside a wound LABEL that was already capped at Mortal 6. Two
       halves are asserted here because two halves were fixed: what may be WRITTEN, and what is READ
       back off an actor that banked damage before the clamp existed. */
    {
      const U = await import(`/modules/${SCOPE}/module/utils.js`);
      const saves = await import(`/modules/${SCOPE}/module/combat/save-rolls.js`);
      // (a) THE WRITE. One ordinary apply, driven through the seam every personnel hit passes.
      await solo.update({ "system.damage": 38 });
      from = since();
      await DA.applyLocationDamage({ target: solo, location: "Torso", netDamage: 20, structuralDamage: 20,
                                     penetrates: true, token: soloTok.object ?? null, fxSilent: true });
      await sleep(600);
      ok("§8 an apply that would overrun the track stops at the last box, by value",
         Number(solo.system.damage) === 40, `damage=${solo.system.damage} (was 38, applied 20)`);
      ok("§8 and the state it produces is the last row the table prints",
         (solo.woundState?.() ?? 0) === 10, `woundState=${solo.woundState?.()}`);
      await wipeSince(from);

      // (b) THE READ, on a figure that banked damage BEFORE the clamp — no migration touches anybody's
      //     sheet, so the print path has to hold the line on its own.
      await solo.update({ "system.damage": 380 });
      from = since();
      await saves.postStunSavePrompt(solo, soloTok.object ?? null);
      await sleep(500);
      const legacyCard = newCards(CARD.stunPrompt)(from)[0]?.content ?? "";
      ok("§8 a legacy over-damaged figure prints the LAST wound row, not an invented one",
         /Mortal 6/.test(legacyCard) && !/Mortal (?:[7-9]|\d\d)/.test(legacyCard),
         legacyCard.replace(/\s+/g, " ").slice(0, 220));
      ok("§8 and its wound penalty is the table's own maximum, by value",
         /−\s*9\s*\(wound penalty\)|- ?9 \(wound penalty\)/.test(legacyCard) && !/\b9[0-9]\b/.test(legacyCard),
         legacyCard.replace(/\s+/g, " ").slice(0, 220));
      await wipeSince(from);

      // (c) NEGATIVE CONTROL: below the ceiling nothing changes. A cap that also moved ordinary numbers
      //     would pass (a) and (b) and still be wrong.
      await solo.update({ "system.damage": 12 });
      from = since();
      await saves.postStunSavePrompt(solo, soloTok.object ?? null);
      await sleep(500);
      const normalCard = newCards(CARD.stunPrompt)(from)[0]?.content ?? "";
      ok("§8 NEGATIVE: an ordinary wound track prints its own row and its own penalty, untouched",
         /Critical/.test(normalCard) && /2\s*\(wound penalty\)/.test(normalCard),
         normalCard.replace(/\s+/g, " ").slice(0, 220));
      ok("§8 NEGATIVE: the write clamp leaves an ordinary apply alone", U.cappedWoundDamage(30) === 30,
         String(U.cappedWoundDamage(30)));
      await wipeSince(from);

      // (d) THE WIRING, as a CLOSED enumeration over the module's own sources. Every accumulating write
      //     to the wound track must go through the clamp — a fourth writer added later reddens here
      //     rather than reopening the defect quietly. Read off the served files, not restated.
      const WRITERS = ["module/combat/DamageApplicator.js", "module/combat/damage-hooks.js",
                       "module/cyberware/install.js"];
      const wiring = [];
      for (const f of WRITERS) {
        const src = await (await fetch(`/modules/${SCOPE}/${f}`)).text();
        // every line that writes the wound track, and whether it goes through the clamp
        const lines = src.split(/\r?\n/).filter(l => /"system\.damage"\s*:/.test(l));
        wiring.push({ f, writes: lines.length, clamped: lines.filter(l => /cappedWoundDamage/.test(l)).length });
      }
      out.trackWiring = wiring;
      ok("§8 WIRING: every wound-track writer in the module goes through the clamp (closed set)",
         wiring.length === 3 && wiring.every(w => w.writes > 0 && w.writes === w.clamped),
         JSON.stringify(wiring));
      ok("§8 WIRING: the ceiling is the base system's own — ten wound states of four boxes",
         U.WOUND_TRACK_MAX === 40, String(U.WOUND_TRACK_MAX));
      await solo.update({ "system.damage": 0 });
    }

  } catch (err) {
    ok("spec ran to completion", false, String(err?.message ?? err));
  } finally {
    // any confirmation window still standing (an aborted leg) — before the fixtures it points at go
    for (const a of [...foundry.applications.instances.values()].filter(a => /DamageDialog/.test(a?.constructor?.name ?? ""))) {
      try { await a.close(); } catch (e) { /* already closed */ }
    }
    // fixtures: tokens first, then actors; then every card this spec produced; then the settings
    for (const t of [...(scene.tokens ?? [])].filter(t => t.name?.startsWith("__PWK__BATCH"))) {
      await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
    }
    for (const a of [...game.actors].filter(a => a.name?.startsWith("__PWK__BATCH"))) await a.delete().catch(() => {});
    for (const r of [...(scene?.regions ?? [])].filter(r => r?.flags?.[SCOPE]?.isSpreadZone === true)) await r.delete().catch(() => {});
    await wipeSince(startedAt);
    game.audio.locked = lockedWas;
    for (const k of KEYS) if (was[k] !== null) await set(k, was[k]);
    out.cleanup = {
      fixtures: [...game.actors].filter(a => a.name?.startsWith("__PWK__BATCH")).length,
      strayCards: [...game.messages].filter(m => !startedAt.has(m.id)).length,
    };
  }
  return out;
});

for (const c of res.checks) {
  console.log(`  ${c.p ? "PASS" : "FAIL"}: ${c.n}${c.d ? ` — ${c.d}` : ""}`);
  c.p ? pass++ : fail++;
}

// §6 — the dice-sound budget, asserted in Node off the created documents
{
  const d = res.dice ?? {};
  const line = (n, okv, detail) => {
    console.log(`  ${okv ? "PASS" : "FAIL"}: ${n}${detail ? ` — ${detail}` : ""}`);
    okv ? pass++ : fail++;
  };
  line("§6 the volley is still resolved round by round — twenty rounds, twenty resolution cards",
    d.volleyCards === 20, `${d.volleyCards} card(s)${d.error ? ` (${d.error})` : ""}`);
  line("§6 exactly ONE of them carries a sound; the other nineteen name none",
    d.volleySounded === 1 && d.volleySilenced === (d.volleyCards - 1),
    `${d.volleySounded} sounded / ${d.volleySilenced} silenced, sound="${d.soundValue}"`);
  line("§6 and the change is sound-only: every card still carries its rolls for the dice modules",
    d.volleyAllCarryRolls === true, String(d.volleyAllCarryRolls));
  line("§6 every round was really resolved — twenty vehicle damage results naming the target",
    d.volleyAllResolved === true, String(d.volleyAllResolved));
  line("§6 NEGATIVE: a single-round apply is unchanged — one card, and it sounds",
    d.singleCards === 1 && d.singleSounded === 1,
    `${d.singleCards} card(s), ${d.singleSounded} sounded`);
}
const clean = (res.cleanup?.fixtures ?? 0) === 0 && (res.cleanup?.strayCards ?? 0) === 0;
console.log(`  ${clean ? "PASS" : "FAIL"}: cleanup — fixtures and cards removed (${JSON.stringify(res.cleanup)})`);
clean ? pass++ : fail++;
console.log(`\nconsole errors: ${errors.length}`);
errors.slice(0, 6).forEach(e => console.log("  ERR:", String(e).slice(0, 200)));
console.log(`RESULT: ${fail === 0 && errors.length === 0 ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
