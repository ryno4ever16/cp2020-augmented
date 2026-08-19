/**
 * SPREAD-ZONE SHIM PATH ON THE TEMPLATES BACKEND (:30003, core v13).
 *
 * The main spread-zone suite asserts the REGIONS shape (v14) and refuses to run where the module's
 * own detect picks MeasuredTemplates. This keeper covers the promise the shim makes for that core:
 * a pattern placed on v13 is a MeasuredTemplate DOCUMENT carrying the same flags, the confirm card
 * binds to it, the orphan-net sweep honors the open card and collects once it is gone, and the
 * hand-delete listener (registered on the per-core delete hook) flips the card to CLEARED.
 *
 * Oracle note carried from the main suite's §6 realignment (2026-08-18): the module runs the same
 * net on its own 15 s interval, so the collected half asserts the ZONE's state (held while the card
 * was open, gone after), never which invocation's count did the deleting.
 *
 * Run from tests/:
 *   FVTT_URL=http://localhost:30003 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-spread-zone-v13.mjs
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30003";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 30_000 });
  const users = await sel.locator("option").evaluateAll((o) =>
    o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
  const gm = users.find((x) => /^gamemaster$/i.test(x.l));
  await sel.selectOption(gm.v);
  await page.fill('input[name="password"]', PW);
  await page.click('button[name="join"]');
  await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 60_000 });

  const res = await page.evaluate(async () => {
    const SCOPE = "cp2020-augmented";
    const out = { checks: [] };
    const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const scene = game.scenes.active;
    const hooks = await import(`/modules/${SCOPE}/module/combat/damage-hooks.js`);
    const areas = await import(`/modules/${SCOPE}/module/combat/area-shapes.js`);
    const lock = await import(`/modules/${SCOPE}/module/card-lock.js`);

    const myZones = () => areas.areasByFlag(scene, "isSpreadZone");
    const cardOf = (h) => game.messages.get(String(h?.doc?.flags?.[SCOPE]?.cardMessageId ?? "")) ?? null;
    const wipe = async () => {
      await sleep(150);
      for (const h of myZones()) await areas.deleteArea(h);
      await sleep(400);
      for (const m of [...game.messages].filter((m) => /cp-confirm-spread-zone|cp-spread-resolve-list|cp-spread-result-list/.test(m.content ?? ""))) await m.delete().catch(() => {});
    };

    // fixtures (names match the main suite's sweep prefix so either keeper cleans the other's litter)
    for (const t of [...(scene.tokens ?? [])].filter((t) => t.name?.startsWith("__PWK__SPREAD"))) await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
    for (const a of [...game.actors].filter((a) => a.name?.startsWith("__PWK__SPREAD"))) await a.delete().catch(() => {});
    await sleep(250);
    await wipe();

    ok("§0 the module's detect picks the templates backend on this core", areas.usesRegions() === false, `usesRegions=${areas.usesRegions()}`);

    const shooter = await Actor.create({ name: "__PWK__SPREAD V13 Shooter", type: "character" });
    const victim = await Actor.create({ name: "__PWK__SPREAD V13 Victim", type: "character" });
    const [tokS] = await scene.createEmbeddedDocuments("Token", [{ name: "__PWK__SPREAD V13 S", actorId: shooter.id, actorLink: true, x: 1000, y: 1000 }]);
    const [tokV] = await scene.createEmbeddedDocuments("Token", [{ name: "__PWK__SPREAD V13 V", actorId: victim.id, actorLink: true, x: 1200, y: 1000 }]);
    const [ammo] = await shooter.createEmbeddedDocuments("Item", [{
      name: "__PWK__SPREAD V13 00 Buck", type: "ammo",
      system: { caliber: "00", modifier: "standard", spreadMode: "single", spreadDamageMedium: "", spreadWidthMedium: 2 },
    }]);
    const [gun] = await shooter.createEmbeddedDocuments("Item", [{
      name: "__PWK__SPREAD V13 Shell Gun", type: "weapon",
      system: { weaponType: "Shotgun", attackType: "Autoshotgun", ammoType: "12ga", damage: "3d6", range: 50, rof: 3, shots: 8, shotsLeft: 8, ammoItemId: ammo.id },
    }]);
    const payload = {
      attackerId: shooter.id, weaponName: gun.name, weaponId: gun.id,
      areaDamages: { Torso: [{ damage: 7 }] }, shotsFired: 1, shotsHit: 1,
      targetTokenId: tokV.id, fxTargetTokenId: tokV.id, firedByUserId: game.user.id,
      caliber: "00", modifier: "standard", spreadMode: "single",
      spreadDamageShort: "", spreadDamageMedium: "", spreadDamageLong: "",
    };

    /* §1 — placement lands as a MeasuredTemplate document with the pattern's flags */
    await hooks._placeSpreadZone(payload);
    await sleep(500);
    let zones = myZones();
    ok("§1 one pattern is placed through the shim", zones.length === 1, String(zones.length));
    const z = zones[0];
    ok("§1 the pattern is a MeasuredTemplate document on this backend", z?.doc?.documentName === "MeasuredTemplate", String(z?.doc?.documentName));
    ok("§1 the pattern carries the module's flags", z?.doc?.flags?.[SCOPE]?.isSpreadZone === true && typeof z?.doc?.flags?.[SCOPE]?.createdAt === "number",
      JSON.stringify({ created: z?.doc?.flags?.[SCOPE]?.createdAt }));
    const card = cardOf(z);
    ok("§1 the confirm card exists and the pattern records it", !!card, String(z?.doc?.flags?.[SCOPE]?.cardMessageId));

    /* §2 — the orphan-net sweep on this backend */
    let swept = await hooks._sweepStaleSpreadZones();
    ok("§2 the sweep leaves a fresh pattern alone", swept === 0 && myZones().length === 1, `swept=${swept} left=${myZones().length}`);
    await z.doc.setFlag(SCOPE, "combatId", "");
    await z.doc.setFlag(SCOPE, "createdAt", Date.now() - hooks.SPREAD_ZONE_TTL_MS - 1000);
    const sweptWhileOpen = await hooks._sweepStaleSpreadZones();
    const heldWhileOpen = myZones().length === 1;
    await card?.delete()?.catch?.(() => {});
    await sleep(300);
    const sweptAfter = await hooks._sweepStaleSpreadZones();
    await sleep(400);
    ok("§2 past the TTL the net keeps a pattern whose card is open and collects it once the card is gone",
      sweptWhileOpen === 0 && heldWhileOpen && myZones().length === 0,
      `whileOpen=${sweptWhileOpen} held=${heldWhileOpen} manualSwept=${sweptAfter} left=${myZones().length}`);

    /* §3 — hand-deleting the template flips its open card to CLEARED (the per-core delete hook) */
    await hooks._placeSpreadZone(payload);
    await sleep(500);
    zones = myZones();
    const z2 = zones[0];
    const card2 = cardOf(z2);
    ok("§3 fixture: a second pattern with an open card", zones.length === 1 && !!card2 && lock.isCardResolved(card2) === false,
      `zones=${zones.length} card=${!!card2}`);
    await z2.doc.delete();
    await sleep(600);
    const card2After = game.messages.get(card2.id);
    ok("§3 hand-deleting the pattern resolves its card as cleared", !!card2After && lock.isCardResolved(card2After) === true,
      `stillThere=${!!card2After} resolved=${card2After ? lock.isCardResolved(card2After) : "n/a"}`);
    ok("§3 nothing is left on the scene", myZones().length === 0, String(myZones().length));

    /* teardown */
    await wipe();
    await scene.deleteEmbeddedDocuments("Token", [tokS.id, tokV.id]).catch(() => {});
    await shooter.delete().catch(() => {});
    await victim.delete().catch(() => {});
    return out;
  });

  for (const c of res.checks) {
    console.log(`  ${c.p ? "PASS" : "FAIL"}  ${c.n}${c.p ? "" : ` -> ${c.d}`}`);
    if (!c.p) failures++;
  }
  const realErrors = errors.filter((e) => !/deprecat|compatibility/i.test(e));
  console.log(`  ${realErrors.length === 0 ? "PASS" : "FAIL"}  0 console errors${realErrors.length ? " -> " + realErrors.slice(0, 3).join(" | ") : ""}`);
  if (realErrors.length) failures++;
} finally {
  await browser.close();
}
console.log(`RESULT: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failing)`);
process.exit(failures === 0 ? 0 : 1);
