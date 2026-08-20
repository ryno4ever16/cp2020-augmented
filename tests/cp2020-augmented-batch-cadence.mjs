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
  const KEYS = ["limbLossEnabled", "limbModel", "damageArmorMode", "damageAblation",
                "rerollGoneLimbLocation", "combatFxEnabled", "headHitDoubling", "shotgunSpreadEnabled",
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
    await set("damageAblation", false);
    await set("rerollGoneLimbLocation", false);
    await set("headHitDoubling", true);
    await set("combatAutomationEnabled", true);
    await set("shotgunSpreadEnabled", true);
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
    const p1 = await fire({ Torso: rounds(7, 6 + btm) });
    ok("§1 the seam claimed the resolution (so the counts below are this flow's)",
       p1.handled === SCOPE, `handled=${p1.handled}`);
    ok("§1 seven damage events wrote the wound track once each", Number(target.system.damage) === 42,
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
    ok("§2 total cards for the whole application is 2, not the old flood",
       [...game.messages].filter(m => !from.has(m.id)).length === 2,
       String([...game.messages].filter(m => !from.has(m.id)).length));
    await wipeSince(from);

    /* ── §3  the persistent same-zone guard ───────────────────────────────────────────────────── */
    const dmgBefore3 = Number(target.system.damage) || 0;
    from = since();
    await fire({ rArm: rounds(1, 20 + btm) });
    ok("§3 a further event into an already-recorded zone announces nothing",
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
      heard.length = 0;
      from = since();
      await DA.applyLocationDamage({ target: solo, location: "Torso", netDamage: 4, structuralDamage: 4, penetrates: true, token: soloTok.object ?? null });
      await sleep(400);
      const handPlays = heard.splice(0).length;
      ok("§5 a hand-applied hit still sounds at the apply (positive control)",
         handPlays === 1, `${handPlays} play(s)`);
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
      const VKEYS = ["mmEnabled", "vehicleRuleSystem", "vehicleDamageEnabled"];
      const vWas = {};
      for (const k of VKEYS) { try { vWas[k] = game.settings.get(SCOPE, k); } catch { vWas[k] = null; } }
      let rig = null;
      try {
        await set("mmEnabled", true);
        await set("vehicleRuleSystem", "MaximumMetal");
        await set("vehicleDamageEnabled", true);

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
