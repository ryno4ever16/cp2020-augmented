/**
 * KEEPER: the shot-pattern card LIFECYCLE.
 *
 * MECHANISM UNDER TEST. A placed shot pattern is an area document on the scene plus a chat card whose
 * button resolves it. The two were unrelated: two expiry clocks (a round advance inside an encounter,
 * a wall clock outside one) deleted the area on their own schedule, and the card's button then had
 * nothing to act on — pressed after the clock had run, it warned "template not found" and the shot was
 * simply lost. The ruled replacement is a lifecycle rather than a timer:
 *
 *   §1 the area records the id of the card that resolves it
 *   §2 no collection clock may take an area whose card exists and is unresolved — asserted against the
 *      wall clock with a positive control proving the clock's own pure rule says "expired"
 *   §3 the clocks survive as an ORPHAN NET: an area whose card is gone is collectible exactly as before
 *   §4 CLEAR voids the shot — area deleted, card swapped to the cleared line, the apply now inert
 *   §5 APPLY resolves the shot and stamps the same card, and the area goes with it
 *   §6 an area deleted BY HAND with its card still open flips that card to cleared, so the apply can
 *      never be pressed against something that is not there
 *   §7 the same skip, on the other clock: a round advance inside an encounter
 *
 * Counts and document state are asserted BY VALUE. The gestures are driven as real DOM clicks on the
 * rendered card, because the button and its delegated dispatch are the thing under test.
 *
 * ⛔ Every fixture is named __PWK__LIFE and is removed on the way out; every world setting this spec
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
  const lock  = await import(`/modules/${SCOPE}/module/card-lock.js`);

  // The skip predicate, asked without letting its absence abort the run: a build that does not export
  // it answers "MISSING", which fails the legs that assert true/false rather than skipping them.
  const cardPending = (f) => { try { return hooks._spreadZoneCardPending(f); } catch (e) { return "MISSING"; } };

  const since = () => new Set(game.messages.map(m => m.id));
  const startedAt = since();
  const wipeSince = async (from) => {
    for (const m of [...game.messages].filter(m => !from.has(m.id))) await m.delete().catch(() => {});
  };

  // The areas this spec plants, and the flags a reader of one gets back.
  const myAreas = () => [...(scene?.regions ?? []), ...(scene?.templates ?? [])]
    .filter(d => d?.flags?.[SCOPE]?.isSpreadZone === true);
  const areaFlags = (doc) => doc?.flags?.[SCOPE] ?? {};
  const wipeAreas = async () => {
    for (const d of myAreas()) await d.delete().catch(() => {});
    await sleep(150);
  };

  // A real click on a rendered card control: the delegated dispatch listens on the document, so the
  // event must bubble from the button the reader would actually press.
  const clickOnCard = async (messageId, selector) => {
    const btn = document.querySelector(`[data-message-id="${messageId}"] ${selector}`);
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  };
  const cardEl = (messageId) => document.querySelector(`[data-message-id="${messageId}"]`);
  const cardHasButton = (messageId, selector) => !!cardEl(messageId)?.querySelector(selector);
  const cardText = (messageId) => (cardEl(messageId)?.textContent ?? "").replace(/\s+/g, " ").trim();

  const KEYS = ["shotgunSpreadEnabled", "combatAutomationEnabled", "combatFxEnabled", "damageArmorMode",
                "damageAblation", "limbLossEnabled", "rerollGoneLimbLocation", "areaEffectOcclusion"];
  const was = {};
  for (const k of KEYS) { try { was[k] = game.settings.get(SCOPE, k); } catch { was[k] = null; } }
  const set = async (k, v) => { try { await game.settings.set(SCOPE, k, v); } catch (e) { /* unregistered */ } };

  let shooter = null, victim = null, shooterTok = null, victimTok = null, combat = null;

  try {
    await set("shotgunSpreadEnabled", true);
    await set("combatAutomationEnabled", true);
    await set("combatFxEnabled", false);
    await set("damageArmorMode", "none");
    await set("damageAblation", false);
    await set("limbLossEnabled", false);
    await set("rerollGoneLimbLocation", false);
    await set("areaEffectOcclusion", false);

    // stale fixtures first — tokens before actors (deleting an actor leaves an unlinked token standing)
    for (const t of [...(scene.tokens ?? [])].filter(t => t.name?.startsWith("__PWK__LIFE"))) {
      await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
    }
    for (const a of [...game.actors].filter(a => a.name?.startsWith("__PWK__LIFE"))) await a.delete().catch(() => {});
    for (const c of [...game.combats].filter(c => c.scene?.id === scene.id)) await c.delete().catch(() => {});
    await wipeAreas();
    await sleep(250);

    shooter = await Actor.create({ name: "__PWK__LIFE Shooter", type: "character" });
    victim  = await Actor.create({ name: "__PWK__LIFE Victim",  type: "character" });
    // actorLink: true — an unlinked token's engine reads a different document than the spec does.
    // ⚠ RESOLVED BY NAME, never by return position (createEmbeddedDocuments does not promise order).
    const made = await scene.createEmbeddedDocuments("Token", [
      { name: "__PWK__LIFE Shooter", actorId: shooter.id, actorLink: true, x: 300, y: 1200, width: 1, height: 1, rotation: 0 },
      { name: "__PWK__LIFE Victim",  actorId: victim.id,  actorLink: true, x: 700, y: 1200, width: 1, height: 1 },
    ]);
    const byName = (n) => made.find(t => t.name === n) ?? [...scene.tokens].find(t => t.name === n);
    shooterTok = byName("__PWK__LIFE Shooter");
    victimTok  = byName("__PWK__LIFE Victim");
    await sleep(300);
    ok("fixture: linked tokens resolve to the fixture actors",
       shooterTok?.actor === shooter && victimTok?.actor === victim, `shooter=${!!shooterTok} victim=${!!victimTok}`);

    // ONE planted pattern, through the module's own placement, returning the area + the card it posted.
    const plant = async () => {
      await wipeAreas();
      const before = since();
      await hooks._placeSpreadZone({
        attackerId: shooter.id, weaponName: "__PWK__LIFE Shell Gun",
        areaDamages: { Torso: [{ damage: 7 }] }, shotsFired: 1, shotsHit: 1,
        targetTokenId: victimTok.id, fxTargetTokenId: victimTok.id, firedByUserId: game.user.id,
        caliber: "00", modifier: "standard", spreadMode: "single",
        spreadDamageShort: "5", spreadDamageMedium: "5", spreadDamageLong: "5",
      });
      await sleep(900);
      const area = myAreas()[0] ?? null;
      const posted = [...game.messages].filter(m => !before.has(m.id));
      return { area, card: posted[posted.length - 1] ?? null, before };
    };

    /* ── §1  the area records the card that resolves it ───────────────────────────────────────── */
    let p = await plant();
    ok("§1 the placement planted exactly one pattern and posted one card",
       myAreas().length === 1 && !!p.card, `areas=${myAreas().length} card=${!!p.card}`);
    ok("§1 the pattern records its card's message id, by value",
       areaFlags(p.area).cardMessageId === p.card?.id,
       `flag=${areaFlags(p.area).cardMessageId} card=${p.card?.id}`);
    await sleep(400);
    ok("§1 the card carries BOTH controls — apply and clear",
       cardHasButton(p.card.id, ".cp-confirm-spread-zone") && cardHasButton(p.card.id, ".cp-clear-spread-zone"),
       `apply=${cardHasButton(p.card.id, ".cp-confirm-spread-zone")} clear=${cardHasButton(p.card.id, ".cp-clear-spread-zone")}`);

    /* ── §2  the wall clock SKIPS a pattern whose card is open ────────────────────────────────── */
    // The clock is advanced by backdating the pattern's own recorded timestamp rather than by waiting a
    // real minute — the same trick the pure-rule legs use, and it makes the boundary exact.
    const TTL = hooks.SPREAD_ZONE_TTL_MS;
    await p.area.setFlag(SCOPE, "createdAt", Date.now() - (TTL * 3));
    await sleep(150);
    const staleFlags = areaFlags(scene.regions?.get?.(p.area.id) ?? scene.templates?.get?.(p.area.id) ?? p.area);
    ok("§2 positive control: the wall-clock RULE itself says this pattern has expired",
       hooks.spreadZoneClockExpired(staleFlags, { encounterRunning: false, now: Date.now() }) === true,
       `age=${Date.now() - Number(staleFlags.createdAt)}ms ttl=${TTL}`);
    ok("§2 the skip predicate answers TRUE while the card is unresolved",
       cardPending(staleFlags) === true, `pending=${cardPending(staleFlags)} cardId=${staleFlags.cardMessageId}`);
    const collected2 = await hooks._sweepStaleSpreadZones();
    await sleep(300);
    ok("§2 the sweep collects nothing and the pattern is still on the scene",
       collected2 === 0 && myAreas().length === 1, `collected=${collected2} areas=${myAreas().length}`);
    ok("§2 and its card still offers the apply (the button did not go out of date)",
       cardHasButton(p.card.id, ".cp-confirm-spread-zone"), cardText(p.card.id).slice(0, 120));

    /* ── §3  the orphan net: no card to ask, so the clock owns it again ───────────────────────── */
    const orphanAreaId = p.area.id;
    await p.card.delete().catch(() => {});
    await sleep(300);
    const orphanFlags = areaFlags(scene.regions?.get?.(orphanAreaId) ?? scene.templates?.get?.(orphanAreaId));
    ok("§3 the skip predicate answers FALSE once the card is gone (negative)",
       cardPending(orphanFlags) === false, `pending=${cardPending(orphanFlags)} cardId=${orphanFlags.cardMessageId}`);
    const collected3 = await hooks._sweepStaleSpreadZones();
    await sleep(400);
    ok("§3 the sweep collects the orphaned pattern, by value",
       collected3 === 1 && myAreas().length === 0, `collected=${collected3} areas=${myAreas().length}`);
    await wipeSince(p.before);

    /* ── §4  CLEAR voids the shot ─────────────────────────────────────────────────────────────── */
    await victim.update({ "system.damage": 0 });
    p = await plant();
    const clearedAreaId = p.area.id;
    await sleep(400);
    const clicked4 = await clickOnCard(p.card.id, ".cp-clear-spread-zone");
    await sleep(1200);
    ok("§4 the clear control was present and pressed", clicked4 === true, `clicked=${clicked4}`);
    ok("§4 the pattern is gone from the scene, by value",
       !scene.regions?.get?.(clearedAreaId) && !scene.templates?.get?.(clearedAreaId) && myAreas().length === 0,
       `areas=${myAreas().length}`);
    ok("§4 the card is stamped resolved AND cleared",
       lock.isCardResolved(p.card) === true && p.card.getFlag(SCOPE, "spreadCleared") === true,
       `resolved=${lock.isCardResolved(p.card)} cleared=${p.card.getFlag(SCOPE, "spreadCleared")}`);
    ok("§4 the card's buttons are replaced by the cleared line — no apply control left (negative)",
       !cardHasButton(p.card.id, ".cp-confirm-spread-zone") && !cardHasButton(p.card.id, ".cp-clear-spread-zone")
       && !!cardEl(p.card.id)?.querySelector(".cp-spread-cleared"),
       cardText(p.card.id).slice(0, 140));
    // The apply is inert afterwards even if something still knew the id — the pattern is not there and
    // nothing is written. Damage is the value that proves it.
    await hooks._confirmSpreadZone(clearedAreaId);
    await sleep(600);
    ok("§4 a later apply against the cleared pattern writes nothing (negative)",
       Number(victim.system.damage) === 0, `damage=${victim.system.damage}`);
    await wipeSince(p.before);

    /* ── §5  APPLY resolves the shot and stamps the same card ─────────────────────────────────── */
    await victim.update({ "system.damage": 0 });
    p = await plant();
    const appliedAreaId = p.area.id;
    await sleep(400);
    const clicked5 = await clickOnCard(p.card.id, ".cp-confirm-spread-zone");
    await sleep(2500);
    ok("§5 the apply control was present and pressed", clicked5 === true, `clicked=${clicked5}`);
    ok("§5 the shot landed — the figure in the corridor took damage, by value",
       Number(victim.system.damage) > 0, `damage=${victim.system.damage}`);
    ok("§5 the pattern is gone with it",
       !scene.regions?.get?.(appliedAreaId) && !scene.templates?.get?.(appliedAreaId), `areas=${myAreas().length}`);
    ok("§5 the card is stamped resolved and is NOT marked cleared (negative — this shot happened)",
       lock.isCardResolved(p.card) === true && !p.card.getFlag(SCOPE, "spreadCleared"),
       `resolved=${lock.isCardResolved(p.card)} cleared=${p.card.getFlag(SCOPE, "spreadCleared")}`);
    ok("§5 an applied card shows no cleared line",
       !cardEl(p.card.id)?.querySelector(".cp-spread-cleared"), cardText(p.card.id).slice(0, 140));
    await wipeSince(p.before);
    await victim.update({ "system.damage": 0 });

    /* ── §6  a hand-deleted pattern flips its own card to cleared ─────────────────────────────── */
    p = await plant();
    await sleep(400);
    ok("§6 precondition: the card is unresolved before the pattern is removed",
       lock.isCardResolved(p.card) === false, `resolved=${lock.isCardResolved(p.card)}`);
    await p.area.delete();
    await sleep(1200);
    ok("§6 the orphaned card flips to cleared, so the apply can never dead-end",
       p.card.getFlag(SCOPE, "spreadCleared") === true && lock.isCardResolved(p.card) === true,
       `cleared=${p.card.getFlag(SCOPE, "spreadCleared")} resolved=${lock.isCardResolved(p.card)}`);
    ok("§6 and the rendered card has lost its controls",
       !cardHasButton(p.card.id, ".cp-confirm-spread-zone") && !!cardEl(p.card.id)?.querySelector(".cp-spread-cleared"),
       cardText(p.card.id).slice(0, 140));
    await wipeSince(p.before);

    /* ── §7  the other clock: a round advance inside an encounter ─────────────────────────────── */
    combat = await Combat.create({ scene: scene.id });
    await combat.createEmbeddedDocuments("Combatant", [{ tokenId: shooterTok.id, sceneId: scene.id, initiative: 10 }]);
    await combat.startCombat();
    // The placement asks `game.combats.active` which encounter a pattern belongs to, so the fixture
    // encounter has to actually hold that seat — creating and starting one does not claim it.
    await combat.activate?.().catch?.(() => {});
    await sleep(600);
    ok("§7 precondition: an encounter is running, so the round rule owns the pattern",
       combat.started === true && game.combats.active?.id === combat.id, `started=${combat.started}`);
    p = await plant();
    const roundAreaId = p.area.id;
    ok("§7 the pattern recorded the encounter it belongs to",
       areaFlags(p.area).combatId === combat.id, `combatId=${areaFlags(p.area).combatId}`);
    await combat.update({ round: (Number(combat.round) || 0) + 1 });
    await sleep(1200);
    const survivor = scene.regions?.get?.(roundAreaId) ?? scene.templates?.get?.(roundAreaId) ?? null;
    ok("§7 positive control: the round RULE itself says this pattern has expired",
       hooks.spreadZoneRoundExpired(areaFlags(survivor ?? p.area), combat) === true,
       `createdRound=${areaFlags(survivor ?? p.area).createdRound} round=${combat.round}`);
    ok("§7 the round advance does not collect a pattern whose card is open",
       !!survivor, `survived=${!!survivor}`);
    // Same clock, no card to ask: the orphan net still works on this side too.
    await p.card.delete().catch(() => {});
    await sleep(300);
    await combat.update({ round: (Number(combat.round) || 0) + 1 });
    await sleep(1200);
    ok("§7 with the card gone the round advance collects it again (orphan net, both clocks)",
       !scene.regions?.get?.(roundAreaId) && !scene.templates?.get?.(roundAreaId),
       `areas=${myAreas().length}`);
    await wipeSince(p.before);

  } catch (err) {
    ok("spec ran to completion", false, String(err?.message ?? err));
  } finally {
    try { if (combat) await combat.delete(); } catch (e) { /* already gone */ }
    await wipeAreas();
    for (const t of [...(scene.tokens ?? [])].filter(t => t.name?.startsWith("__PWK__LIFE"))) {
      await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
    }
    for (const a of [...game.actors].filter(a => a.name?.startsWith("__PWK__LIFE"))) await a.delete().catch(() => {});
    await wipeSince(startedAt);
    for (const k of KEYS) if (was[k] !== null) await set(k, was[k]);
    out.cleanup = {
      fixtures: [...game.actors].filter(a => a.name?.startsWith("__PWK__LIFE")).length,
      areas: myAreas().length,
      strayCards: [...game.messages].filter(m => !startedAt.has(m.id)).length,
    };
  }
  return out;
});

for (const c of res.checks) {
  console.log(`  ${c.p ? "PASS" : "FAIL"}: ${c.n}${c.d ? ` — ${c.d}` : ""}`);
  c.p ? pass++ : fail++;
}
const clean = (res.cleanup?.fixtures ?? 0) === 0 && (res.cleanup?.areas ?? 0) === 0 && (res.cleanup?.strayCards ?? 0) === 0;
console.log(`  ${clean ? "PASS" : "FAIL"}: cleanup — fixtures, patterns and cards removed (${JSON.stringify(res.cleanup)})`);
clean ? pass++ : fail++;
console.log(`\nconsole errors: ${errors.length}`);
errors.slice(0, 6).forEach(e => console.log("  ERR:", String(e).slice(0, 200)));
console.log(`RESULT: ${fail === 0 && errors.length === 0 ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
