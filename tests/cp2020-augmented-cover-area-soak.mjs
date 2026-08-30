/**
 * KEEPER: the area↔cover SPLIT — valued objects soak and are debited, unvalued walls still exempt.
 *
 * Covers the 2026-08-25 rulings (memory reference-cover-rules-raw / task-cover-system):
 *  §1 areaCoverVerdict, by value — a VALUED wall on the line answers "soaked" with that wall's SP even
 *     when the same wall also blocks movement (the valued-before-naked ordering), a wall carrying no
 *     values answers "exempt", a valued wall that does NOT block movement still answers "soaked", a
 *     clear line answers "in", and the world switch off collapses all three to "in"
 *  §2 the fold is the EXISTING one — resolveHitMath's coverSP through combineArmorSP, asserted against
 *     the table's own value, not a subtraction written twice
 *  §3 resolveAreaCoverChew — one ledger per object per application, per-round SP carried forward, the
 *     exact debit, the round the structure runs out, and dedupe by uuid
 *  §4 the live corridor, three applies on one figure: clear line / valued wall / unvalued wall give
 *     three DIFFERENT deltas, and the valued wall's structure is debited exactly once
 *  §5 the resolution card's three row states and its crossed-object line
 *  §6 an EMPTY corridor whose axis crosses a valued wall still debits it (the miss half of the ruling)
 *  §7 presentation parity — the corridor's impact sweep silences the exempt figure and NOT the soaked
 *     one, plus the wiring legs that pin both readers to the one predicate
 *  §8 the detonation path takes the same split: full-radius blast, three distinct deltas, wall debited
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

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
await page.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 60000 }).catch(() => {});

const res = await page.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  const out = { checks: [] };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const cov   = await import(`/modules/${SCOPE}/module/combat/cover.js`);
  const hooks = await import(`/modules/${SCOPE}/module/combat/damage-hooks.js`);
  const app   = await import(`/modules/${SCOPE}/module/combat/DamageApplicator.js`);
  const utils = await import(`/modules/${SCOPE}/module/utils.js`);
  const areas = await import(`/modules/${SCOPE}/module/combat/area-shapes.js`);
  const fx    = await import(`/modules/${SCOPE}/module/fx/effects.js`);
  const grid  = await import(`/modules/${SCOPE}/module/vehicle/vehicle-grid.js`);

  // ⛔ PIN THE SCENE, don't inherit it. Every lane below is a fixed rectangle in scene pixels, so the
  // suite is only meaningful on the scene those numbers were measured against — and the rig's active
  // scene is world state any earlier suite can move (it was found on "Review · Dark Range" once, and
  // seven legs reported zero damage because the figures were off-canvas). Restored in the finally.
  const HOME_SCENE = "Foundry Virtual Tabletop";
  const priorSceneId = game.scenes.active?.id ?? null;
  const home = game.scenes.getName(HOME_SCENE) ?? game.scenes.contents[0];
  if (home && game.scenes.active?.id !== home.id) {
    await home.activate();
    for (let i = 0; i < 150 && canvas?.scene?.id !== home.id; i++) await sleep(200);
  }
  const scene = game.scenes.active;
  out.checks.push({ n: "§0 fixture: the suite is on the scene its lanes were measured against",
                    p: scene?.name === HOME_SCENE, d: String(scene?.name) });
  const gs = scene.grid?.size ?? 100;
  const ppm = grid.metersToPixels(scene, 1) || 1;

  /* ─────────────────────────── fixtures + world state, saved for the finally ─────────────────── */
  const prev = {};
  const saveSet = async (key, value) => {
    try { prev[key] = game.settings.get(SCOPE, key); await game.settings.set(SCOPE, key, value); } catch (e) { /* absent */ }
  };

  const mkWall = async (c, flags = {}, extra = {}) => {
    const [w] = await scene.createEmbeddedDocuments("Wall", [{ c, ...extra, flags: { [SCOPE]: { __pwsoak: true, ...flags } } }]);
    return w;
  };
  const wallRow = (uuid) => cov.coverWallsOn(scene).find(r => r.uuid === uuid);
  const mkFigure = async (name, x, y, rotation = 0) => {
    const actor = await Actor.create({ name, type: "character" });
    const [t] = await scene.createEmbeddedDocuments("Token",
      [{ name, actorId: actor.id, actorLink: true, x, y, width: 1, height: 1, rotation }]);
    return { actor, tokenDoc: t, get tok() { return canvas.tokens.placeables.find(p => p.id === t.id) ?? t; } };
  };
  const wipeFixtures = async () => {
    for (const t of [...(scene.tokens ?? [])].filter(t => t.name?.startsWith("__PWSOAK__"))) await t.delete().catch(() => {});
    for (const a of [...game.actors].filter(a => a.name?.startsWith("__PWSOAK__"))) await a.delete().catch(() => {});
    const ws = [...scene.walls].filter(w => w.flags?.[SCOPE]?.__pwsoak === true).map(w => w.id);
    if (ws.length) await scene.deleteEmbeddedDocuments("Wall", ws).catch(() => {});
    for (const r of [...scene.regions]) {
      const f = r.flags?.[SCOPE] ?? {};
      if (r.name?.startsWith("__PWSOAK__") || f.isSpreadZone || f.isExplosion) await r.delete().catch(() => {});
    }
    for (const t of [...(scene.templates ?? [])]) {
      const f = t.flags?.[SCOPE] ?? {};
      if (f.isSpreadZone || f.isExplosion) await t.delete().catch(() => {});
    }
  };
  await wipeFixtures();
  await sleep(300);

  try {
    // ⏪ the occlusion + blast enablement keys retired 2026-08-29 (settings-trim): both lanes are
    //    unconditional now, so neither is pinned here any more.
    await saveSet("headHitDoubling", false);
    await saveSet("limbModel", "core");
    await saveSet("explosivesDetailed", false);
    await saveSet("damageArmorMode", "full");

    /* ═══════════════ §1 the split predicate, by value ═══════════════ */
    // One straight line east, INSIDE the scene rectangle. Off-rect coordinates are not a neutral
    // choice: the platform's movement-collision backend bounds its rays by the canvas rectangle, so a
    // probe placed outside it answers the naked-wall question wrongly in both directions (cost a red
    // pass 2026-08-25). Every lane below is picked inside `sceneRect` and clear of the rig's standing
    // fixtures.
    const ORX = 2600, ORY = 1700;
    const probe = await mkFigure("__PWSOAK__Probe1", ORX + 4 * gs, ORY, 0);
    await sleep(250);
    const px = probe.tokenDoc.x + gs / 2, py = probe.tokenDoc.y + gs / 2;
    const across = (x) => [x, ORY - 2 * gs, x, ORY + 2 * gs];

    ok("§1 fixture: nothing between the origin and the probe to start with",
      cov.areaCoverVerdict(ORX, ORY, probe.tok, scene).state === cov.AREA_COVER_IN,
      cov.areaCoverVerdict(ORX, ORY, probe.tok, scene).state);

    // (a) a wall carrying NO cover values, blocking movement (core default) → exempt, unchanged
    const wNaked = await mkWall(across(ORX + 2 * gs));
    await sleep(250);
    let v = cov.areaCoverVerdict(ORX, ORY, probe.tok, scene);
    ok("§1 unvalued move-blocking wall → exempt", v.state === cov.AREA_COVER_EXEMPT, `${v.state} sp=${v.sp}`);
    ok("§1 an exempt verdict carries no SP to fold", v.sp === 0 && v.row === null, `sp=${v.sp} row=${v.row?.label ?? null}`);

    // (b) put cover values on that SAME wall → valued wins over the move block
    await wNaked.update({ [`flags.${SCOPE}.coverSp`]: 10, [`flags.${SCOPE}.coverMaterial`]: "__PWSOAK__Barrier" });
    await sleep(250);
    v = cov.areaCoverVerdict(ORX, ORY, probe.tok, scene);
    ok("§1 the SAME wall, now valued, → soaked (valued is asked before naked)",
      v.state === cov.AREA_COVER_SOAKED, `${v.state} sp=${v.sp}`);
    ok("§1 the soaked verdict carries that wall's own SP", v.sp === 10, String(v.sp));
    ok("§1 the soaked verdict names the row it will debit",
      v.row?.label === "__PWSOAK__Barrier" && /\.Wall\./.test(String(v.row?.uuid)), `${v.row?.label} ${v.row?.uuid}`);

    // (c) a valued wall that does NOT block movement — the case the old test could never answer "soaked"
    await wNaked.update({ move: 0 });
    await sleep(250);
    v = cov.areaCoverVerdict(ORX, ORY, probe.tok, scene);
    ok("§1 a valued wall that does not block movement still soaks", v.state === cov.AREA_COVER_SOAKED && v.sp === 10,
      `${v.state} sp=${v.sp}`);
    ok("§1 …and the bare occlusion test alone would have called it clear",
      areas.areaOcclusionTest(ORX, ORY, probe.tok) === false, String(areas.areaOcclusionTest(ORX, ORY, probe.tok)));

    // (d) a DESTROYED valued wall contributes nothing
    await wNaked.update({ [`flags.${SCOPE}.coverPool`]: 0, [`flags.${SCOPE}.coverPoolMax`]: 30, move: 0 });
    await sleep(250);
    v = cov.areaCoverVerdict(ORX, ORY, probe.tok, scene);
    ok("§1 a valued wall at zero structure is not a soak row", v.state === cov.AREA_COVER_IN, `${v.state} sp=${v.sp}`);
    await wNaked.update({ [`flags.${SCOPE}.coverPool`]: 30, move: 20 });
    await sleep(250);

    // ⏪ off-state leg retired 2026-08-29 with its switch (settings-trim) - the "master off means
    //    everything is plainly in" pair went with the occlusion key. The soak verdict is re-read here
    //    instead, so the section still closes on the value the rows above produced.
    ok("§1 the soak verdict stands for the crossed row",
      cov.areaCoverVerdict(ORX, ORY, probe.tok, scene).state === cov.AREA_COVER_SOAKED,
      cov.areaCoverVerdict(ORX, ORY, probe.tok, scene).state);

    // (f) the point-to-point row finder, and the origin trim
    const rowsAlong = cov.valuedCoverAlong(scene, { x: ORX, y: ORY }, { x: px, y: py });
    ok("§1 valuedCoverAlong returns the one crossed row", rowsAlong.length === 1 && rowsAlong[0].sp === 10,
      `n=${rowsAlong.length} [${rowsAlong.map(r => `${r.label}:${r.sp}`).join(",")}] from=(${ORX},${ORY}) to=(${px},${py})`);
    const rowsBackwards = cov.valuedCoverAlong(scene, { x: ORX, y: ORY }, { x: ORX - 4 * gs, y: ORY });
    ok("§1 a line pointing the other way crosses nothing", rowsBackwards.length === 0, String(rowsBackwards.length));

    await scene.deleteEmbeddedDocuments("Wall", [wNaked.id]);
    await sleep(200);

    /* ═══════════════ §2 the fold is the existing one ═══════════════ */
    const clear  = app.resolveHitMath({ currentSP: 8, rawDamage: 24, ap: false, armorMode: "full", coverSP: 0 });
    const soaked = app.resolveHitMath({ currentSP: 8, rawDamage: 24, ap: false, armorMode: "full", coverSP: 10 });
    ok("§2 no cover: 24 raw less 8 SP = 16", clear.damageAfterSP === 16 && clear.spUsed === 8,
      `after=${clear.damageAfterSP} spUsed=${clear.spUsed}`);
    ok("§2 cover 10 folded outermost: effective SP 15, 24 less 15 = 9",
      soaked.spFull === 15 && soaked.damageAfterSP === 9, `spFull=${soaked.spFull} after=${soaked.damageAfterSP}`);
    ok("§2 the effective SP is the proportional table's own value, not a sum",
      soaked.spFull === utils.combineArmorSP(8, 10) && soaked.spFull !== 18,
      `${soaked.spFull} vs combineArmorSP(8,10)=${utils.combineArmorSP(8, 10)}`);
    ok("§2 armour mode NONE ignores the cover layer too",
      app.resolveHitMath({ currentSP: 8, rawDamage: 24, ap: false, armorMode: "none", coverSP: 10 }).spUsed === 0);

    /* ═══════════════ §3 the chew ledger: cardinality and arithmetic ═══════════════ */
    const ledgerRow = { uuid: "Fake.Row.A", label: "__PWSOAK__Ledger", sp: 10, pool: 30, poolMax: 30, destroyed: false };
    const plan4 = await cov.resolveAreaCoverChew([ledgerRow], 4, () => 14);
    const e4 = plan4.get("Fake.Row.A");
    ok("§3 one ledger entry per object", plan4.size === 1 && !!e4, String(plan4.size));
    ok("§3 the debit is capped by what is left: 14 + 14 + 2 = 30", e4.summary?.absorbed === 30, String(e4.summary?.absorbed));
    ok("§3 structure ends at zero and reports it", e4.summary?.pool === 0 && e4.summary?.destroyed === true,
      `pool=${e4.summary?.pool} destroyed=${e4.summary?.destroyed}`);
    ok("§3 the round the structure ran out is named", e4.summary?.destroyedAtRound === 3, String(e4.summary?.destroyedAtRound));
    ok("§3 SP is carried forward per round and drops to 0 after it gave out",
      JSON.stringify(e4.spByRound) === JSON.stringify([10, 10, 10, 0]), JSON.stringify(e4.spByRound));
    ok("§3 the per-round SP reader agrees with the plan",
      cov.areaCoverSpForRound(plan4, ledgerRow, 2) === 10 && cov.areaCoverSpForRound(plan4, ledgerRow, 3) === 0,
      `${cov.areaCoverSpForRound(plan4, ledgerRow, 2)}/${cov.areaCoverSpForRound(plan4, ledgerRow, 3)}`);
    ok("§3 the round receipts are per round, not one lump",
      (e4.summary?.rounds ?? []).length === 3
      && e4.summary.rounds[0].absorbed === 14 && e4.summary.rounds[2].absorbed === 2,
      JSON.stringify(e4.summary?.rounds));

    // ⭐ THE CARDINALITY LEG: the same object handed in twice is ONE ledger, not two.
    const dupRow = { ...ledgerRow, pool: 30 };
    const planDup = await cov.resolveAreaCoverChew([ledgerRow, dupRow], 1, () => 12);
    ok("§3 the same uuid twice books ONE debit of 12, not two",
      planDup.size === 1 && planDup.get("Fake.Row.A").summary?.absorbed === 12,
      `size=${planDup.size} absorbed=${planDup.get("Fake.Row.A").summary?.absorbed}`);
    const planNone = await cov.resolveAreaCoverChew([], 3, () => 9);
    ok("§3 no crossed object → nothing planned", planNone.size === 0, String(planNone.size));

    /* ═══════════════ §4 the live corridor: three applies, three deltas ═══════════════ */
    // A corridor aimed east from the shooter, with the figure four squares along it. Damage is a
    // CONSTANT so the arithmetic is exact; the location roll cannot move it because the figure wears
    // no armour and both doubling rules are pinned off above.
    const SX = 2500, SY = 1450;
    const shooter = await mkFigure("__PWSOAK__Gunner", SX, SY, 0);
    const mark    = await mkFigure("__PWSOAK__Mark", SX + 4 * gs, SY, 0);
    await sleep(400);
    const reachM = (4 * gs) / ppm;
    const basePayload = (over = {}) => ({
      attackerId: shooter.actor.id, weaponName: "__PWSOAK__Shell Gun",
      areaDamages: { Torso: [{ damage: 5 }] }, shotsFired: 1, shotsHit: 1,
      targetTokenId: mark.tokenDoc.id, firedByUserId: game.user.id,
      caliber: "00", modifier: "standard", spreadMode: "single",
      spreadDamageShort: "5", spreadDamageMedium: "5", spreadDamageLong: "5",
      spreadWidthShort: 3, spreadWidthMedium: 3, spreadWidthLong: 3, spreadRangeM: 50,
      spreadAim: { angleDeg: 0, reachM, lengthM: reachM + 1, widthM: 3, band: "Medium" },
      ...over,
    });
    const myZones = () => [...(scene.regions ?? []), ...(scene.templates ?? [])]
      .filter(r => r.flags?.[SCOPE]?.isSpreadZone === true);
    const damageOf = () => Number(game.actors.get(mark.actor.id)?.system?.damage) || 0;
    const btm = Number(mark.actor.system.stats?.bt?.modifier) || 0;

    // ⚠ ONE WAITER, AND IT NEVER DEREFERENCES A ZONE IT DID NOT FIND. A plant is several awaits deep
    // (the rail's settle signal among them), so on a busy world it can land after a short wait — and an
    // unguarded `myZones()[0].id` then throws and takes the REST of the suite with it, reporting one
    // opaque "suite threw" instead of the leg that was actually slow (2026-08-26).
    const plantZone = async (payload) => {
      // Clear first: `myZones()[0]` is only unambiguous when the scene held no corridor to begin with,
      // and a resolved corridor's own delete is one await deeper than the assertion that follows it.
      for (const r of myZones()) await r.delete?.().catch(() => {});
      for (let i = 0; i < 20 && myZones().length; i++) await sleep(100);
      await hooks._placeSpreadZone(payload);
      for (let i = 0; i < 90 && !myZones().length; i++) await sleep(200);
      return myZones()[0] ?? null;
    };
    const fireAndApply = async (payload) => {
      const zone = await plantZone(payload);
      if (!zone) return null;
      const card = game.messages.get(String(zone.flags?.[SCOPE]?.cardMessageId ?? "")) ?? null;
      const content = card?.content ?? "";
      await hooks._confirmSpreadZone(zone.id);
      await sleep(1800);
      return { content };
    };

    // (a) clear line — 5 raw, no SP anywhere
    const d0 = damageOf();
    const shotA = await fireAndApply(basePayload());
    const dA = damageOf();
    ok("§4 fixture: the corridor was placed and applied", !!shotA, String(!!shotA));
    ok("§4 clear line: the whole 5 lands (less BTM, floor 1)", dA - d0 === Math.max(1, 5 - btm),
      `delta=${dA - d0} expected=${Math.max(1, 5 - btm)}`);
    ok("§4 clear line: the card row reads in-pattern with no barrier named",
      /__PWSOAK__Mark/.test(shotA.content) && !/behind/.test(shotA.content), shotA.content.slice(0, 0));

    // (b) a VALUED wall across the line — SP 3, structure 9
    const wSoak = await mkWall([SX + 2 * gs, SY - 3 * gs, SX + 2 * gs, SY + 3 * gs],
      { coverSp: 3, coverPool: 9, coverPoolMax: 9, coverMaterial: "__PWSOAK__SoakWall" });
    await sleep(400);
    const cardIdsBefore = new Set(game.messages.map(m => m.id));
    const d1 = damageOf();
    const shotB = await fireAndApply(basePayload());
    const dB = damageOf();
    ok("§4 valued wall: 5 raw less its SP 3 = 2 (less BTM, floor 1)", dB - d1 === Math.max(1, 2 - btm),
      `delta=${dB - d1} expected=${Math.max(1, 2 - btm)}`);
    ok("§4 valued wall: the figure is still damaged — the soak is not an exemption", dB > d1, `${d1} → ${dB}`);
    const soakRow = wallRow(wSoak.uuid);
    ok("§4 valued wall: structure debited by the corridor's own 5 (9 → 4)",
      soakRow?.pool === 4 && soakRow?.poolMax === 9, `${soakRow?.pool}/${soakRow?.poolMax}`);
    const chewCards = [...game.messages].filter(m => !cardIdsBefore.has(m.id) && /cp-cover-chew/.test(m.content ?? ""));
    ok("§4 valued wall: exactly ONE structure card for the whole application", chewCards.length === 1, String(chewCards.length));
    ok("§4 valued wall: the structure card names the object and the amount",
      /__PWSOAK__SoakWall/.test(chewCards[0]?.content ?? "") && /5/.test(chewCards[0]?.content ?? ""));

    // (c) an UNVALUED wall across the line — exempt, and nothing is debited anywhere
    await scene.deleteEmbeddedDocuments("Wall", [wSoak.id]);
    const wPlain = await mkWall([SX + 2 * gs, SY - 3 * gs, SX + 2 * gs, SY + 3 * gs]);
    await sleep(400);
    const chewIdsBefore = new Set(game.messages.map(m => m.id));
    const d2 = damageOf();
    const shotC = await fireAndApply(basePayload());
    const dC = damageOf();
    ok("§4 unvalued wall: nothing lands (the exemption is preserved)", dC - d2 === 0, `delta=${dC - d2}`);
    ok("§4 unvalued wall: no structure card either",
      [...game.messages].filter(m => !chewIdsBefore.has(m.id) && /cp-cover-chew/.test(m.content ?? "")).length === 0);
    ok("§4 unvalued wall: the card row says exempt", /exempt/i.test(shotC?.content ?? ""), "");
    ok("§4 the three lines are three DIFFERENT outcomes",
      (dA - d0) !== (dB - d1) && (dB - d1) !== (dC - d2) && (dA - d0) !== (dC - d2),
      `${dA - d0} / ${dB - d1} / ${dC - d2}`);
    await scene.deleteEmbeddedDocuments("Wall", [wPlain.id]);
    await sleep(200);

    /* ═══════════════ §4d ONE ROLL, TWO JOBS — the barrier is charged the figure's own shells ═══════
     * User ruling 2026-08-26: "a bullet doesn't get two different damage resolutions". The constant
     * formula above cannot see this (5 is 5 whoever rolled it), so this section uses a WIDE formula and
     * asserts the barrier's debit is the very number the figure's row reports. Under the retired model
     * the two were independent rolls and would agree only by coincidence.
     */
    const rollsOf = (html, name) => {
      const rx = new RegExp(`<b>${name}</b> — rolled ([0-9,\\s]+) \\(total (\\d+)\\)`);
      const m = rx.exec(html ?? "");
      return m ? { rolls: m[1].split(",").map(v => Number(v.trim())), total: Number(m[2]) } : null;
    };
    const absorbedOn = (html) => {
      const m = /absorbed (\d+) damage/.exec(html ?? "");
      return m ? Number(m[1]) : null;
    };
    // ⚠ THE WIDE CORRIDOR REACHES PAST BOTH FIGURES AND BOTH SIT ON ITS AXIS. §4e's second figure used
    // to stand one square off-centre, which left it 50 px inside a 150 px half-width — inside, but by a
    // margin thin enough that it dropped out of the pattern on one run in several (2026-08-26). A
    // fixture that is only just true is a flake generator; both figures are now dead centre.
    const wideReachM = (7 * gs) / ppm;
    const widePayload = (over = {}) => basePayload({
      spreadDamageShort: "3d6", spreadDamageMedium: "3d6", spreadDamageLong: "3d6",
      shotsFired: 3,
      spreadAim: { angleDeg: 0, reachM: wideReachM, lengthM: wideReachM + 1, widthM: 3, band: "Medium" },
      ...over,
    });

    const wShare = await mkWall([SX + 2 * gs, SY - 3 * gs, SX + 2 * gs, SY + 3 * gs],
      { coverSp: 3, coverPool: 400, coverPoolMax: 400, coverMaterial: "__PWSOAK__ShareWall" });
    await sleep(400);
    let idsBefore = new Set(game.messages.map(m => m.id));
    let wideZone = await plantZone(widePayload());
    ok("§4d fixture: the corridor was planted", !!wideZone, String(!!wideZone));
    await hooks._confirmSpreadZone(wideZone.id);
    await sleep(2000);
    const newMsgs = () => [...game.messages].filter(m => !idsBefore.has(m.id));
    const resultHtml = newMsgs().find(m => /cp-spread-result-list/.test(m.content ?? ""))?.content ?? "";
    let chewMsgs = newMsgs().filter(m => /cp-cover-chew/.test(m.content ?? ""));
    const markRolls = rollsOf(resultHtml, "__PWSOAK__Mark");
    ok("§4d fixture: three shells were rolled and reported for the figure",
      !!markRolls && markRolls.rolls.length === 3, JSON.stringify(markRolls));
    ok("§4d fixture: the rolls really do vary (a constant would prove nothing here)",
      !!markRolls && new Set(markRolls.rolls).size > 1, JSON.stringify(markRolls?.rolls));
    ok("§4d the barrier is debited the figure's OWN rolls, exactly",
      chewMsgs.length === 1 && absorbedOn(chewMsgs[0].content) === markRolls?.total,
      `absorbed=${absorbedOn(chewMsgs[0]?.content)} vs figure total=${markRolls?.total}`);
    const shareRow = wallRow(wShare.uuid);
    ok("§4d the structure fell by that same number",
      shareRow?.pool === 400 - (markRolls?.total ?? -1), `${shareRow?.pool} (400 - ${markRolls?.total})`);

    /* ═══ §4e TWO figures behind ONE barrier — still one debit, and it is the FIRST figure's ═══ */
    const mark2 = await mkFigure("__PWSOAK__Mark2", SX + 6 * gs, SY, 0);
    await sleep(400);
    idsBefore = new Set(game.messages.map(m => m.id));
    wideZone = await plantZone(widePayload());
    ok("§4e fixture: the corridor was planted", !!wideZone, String(!!wideZone));
    await hooks._confirmSpreadZone(wideZone.id);
    await sleep(2400);
    const html2 = newMsgs().find(m => /cp-spread-result-list/.test(m.content ?? ""))?.content ?? "";
    chewMsgs = newMsgs().filter(m => /cp-cover-chew/.test(m.content ?? ""));
    const r1 = rollsOf(html2, "__PWSOAK__Mark");
    const r2 = rollsOf(html2, "__PWSOAK__Mark2");
    ok("§4e fixture: both figures were caught and both reported rolls", !!r1 && !!r2,
      `Mark=${r1 ? "caught" : "MISSING"} Mark2=${r2 ? "caught" : "MISSING"} · card=${html2.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 200)}`);
    ok("§4e a crowd does not multiply the wear — exactly ONE structure card", chewMsgs.length === 1,
      String(chewMsgs.length));
    const paid = absorbedOn(chewMsgs[0]?.content);
    ok("§4e the debit equals ONE figure's roll total, not the sum of both",
      paid === r1?.total || paid === r2?.total,
      `absorbed=${paid} vs ${r1?.total} / ${r2?.total} (sum would be ${(r1?.total ?? 0) + (r2?.total ?? 0)})`);
    ok("§4e the other figure still rolled its own shells (they are its own bullets)",
      !!r1 && !!r2 && r1.rolls.length === 3 && r2.rolls.length === 3,
      JSON.stringify({ a: r1?.rolls, b: r2?.rolls }));
    await scene.deleteEmbeddedDocuments("Wall", [wShare.id]);
    for (const t of [...(scene.tokens ?? [])].filter(t => t.name === "__PWSOAK__Mark2")) await t.delete().catch(() => {});
    for (const a of [...game.actors].filter(a => a.name === "__PWSOAK__Mark2")) await a.delete().catch(() => {});
    await sleep(300);

    /* ═══════════════ §5 the card's three row states ═══════════════ */
    const wCard = await mkWall([SX + 2 * gs, SY - 3 * gs, SX + 2 * gs, SY + 3 * gs],
      { coverSp: 3, coverPool: 9, coverPoolMax: 9, coverMaterial: "__PWSOAK__CardWall" });
    await sleep(400);
    const cardZone = await plantZone(basePayload());
    ok("§5 fixture: the corridor was planted and can be read back", !!cardZone, String(!!cardZone));
    const cardMsg = game.messages.get(String(cardZone?.flags?.[SCOPE]?.cardMessageId ?? ""));
    const cardHtml = cardMsg?.content ?? "";
    ok("§5 the row names the barrier and the SP the apply will fold",
      /__PWSOAK__Mark/.test(cardHtml) && /__PWSOAK__CardWall/.test(cardHtml) && /SP 3/.test(cardHtml),
      cardHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 240));
    ok("§5 the row is NOT worded as an exemption", !/exempt/i.test(cardHtml));
    ok("§5 the card also names the object the apply is going to debit, with its structure",
      /The path crosses/.test(cardHtml) && /9 \/ 9/.test(cardHtml),
      cardHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 240));
    ok("§5 no raw i18n key text leaked into the card", !/CYBERPUNK\.|SpreadRowSoaked|SpreadCoverCrossedLine|SpreadRowSoakedCore/.test(cardHtml));
    if (cardZone) await hooks._clearSpreadZone(cardZone.id);
    await sleep(600);
    await scene.deleteEmbeddedDocuments("Wall", [wCard.id]);
    await sleep(200);

    /* ═══════ §5b ⓪ SOAK-WITHOUT-A-LEDGER — THE FOURTH ROW STATE (ruled 2026-08-26) ═══════
       ⭐ CORE-mode cover (an SP the GM typed with NO structure) soaks exactly like a rated barrier and
       is PERMANENT: nothing is charged, and ⛔ no structure card ever posts for it. The card has to say
       so in the row's own words — otherwise the reader is left waiting for a wear line that never comes
       and reads "no structure line" as the module having forgotten. Three legs: the row says it, the
       crossings line does NOT promise a debit, and the apply posts no chew card. */
    const wCore = await mkWall([SX + 2 * gs, SY - 3 * gs, SX + 2 * gs, SY + 3 * gs],
      { coverSp: 4, coverMaterial: "__PWSOAK__CoreWall" });
    await sleep(400);
    const coreZone = await plantZone(basePayload());
    ok("§5b fixture: the corridor was planted over the core-mode barrier", !!coreZone, String(!!coreZone));
    const coreMsg = game.messages.get(String(coreZone?.flags?.[SCOPE]?.cardMessageId ?? ""));
    const coreHtml = coreMsg?.content ?? "";
    ok("§5b the row still reports the SOAK, naming the barrier and its SP",
      /__PWSOAK__CoreWall/.test(coreHtml) && /SP 4/.test(coreHtml) && /soaks first/i.test(coreHtml),
      coreHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 240));
    ok("§5b the row DISTINGUISHES it from a structure barrier — it says there is nothing to wear down",
      /no structure to wear down/i.test(coreHtml),
      coreHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 240));
    ok("§5b it is not worded as an exemption either (the figure IS in the pattern)",
      !/exempt/i.test(coreHtml));
    ok("⛔ §5b the crossings line does NOT promise a debit the apply will never make",
      !/The path crosses[^<]*__PWSOAK__CoreWall/.test(coreHtml),
      (coreHtml.match(/The path crosses[^<]*/g) ?? ["(no crossings line)"]).join(" | "));
    const beforeChew = new Set(game.messages.map(m => m.id));
    if (coreZone) await hooks._confirmSpreadZone(coreZone.id);
    await sleep(900);
    ok("⛔ §5b the apply posts NO structure card for core-mode cover",
      game.messages.filter(m => !beforeChew.has(m.id) && m.content.includes("cp-cover-chew")).length === 0,
      String(game.messages.filter(m => !beforeChew.has(m.id) && m.content.includes("cp-cover-chew")).length));
    ok("§5b and the barrier is untouched — no pool was written onto it",
      wCore.flags?.[SCOPE]?.coverPool === undefined && wCore.flags?.[SCOPE]?.coverBreach === undefined,
      JSON.stringify(wCore.flags?.[SCOPE]));
    for (const m of game.messages.filter(m => !beforeChew.has(m.id))) await m.delete().catch(() => {});
    await scene.deleteEmbeddedDocuments("Wall", [wCore.id]);
    await sleep(200);

    /* ═══════════════ §6 the empty corridor still costs the barrier ═══════════════ */
    // Aimed away from every figure on the scene: due WEST from the shooter, with the barrier on that
    // axis. Nothing is standing there, so the only thing the apply can charge is the barrier itself.
    const wMiss = await mkWall([SX - 2 * gs, SY - 3 * gs, SX - 2 * gs, SY + 3 * gs],
      { coverSp: 5, coverPool: 20, coverPoolMax: 20, coverMaterial: "__PWSOAK__MissWall" });
    await sleep(400);
    const missReachM = (4 * gs) / ppm;
    const missPayload = basePayload({
      targetTokenId: null,
      spreadAim: { angleDeg: 180, reachM: missReachM, lengthM: missReachM, widthM: 3, band: "Medium" },
    });
    const missBefore = new Set(game.messages.map(m => m.id));
    const missZone = await plantZone(missPayload);
    ok("§6 fixture: the corridor was planted", !!missZone, String(!!missZone));
    const missCard = game.messages.get(String(missZone?.flags?.[SCOPE]?.cardMessageId ?? ""))?.content ?? "";
    const missHandle = areas.areaById(scene, missZone.id);
    const occupants = areas.tokensInArea(missHandle, [...scene.tokens]).filter(t => (t.actor ?? t.document?.actor));
    ok("§6 fixture: the corridor really is empty", occupants.length === 0,
      occupants.map(t => t.name).join(",") || "0");
    ok("§6 the card names the barrier the empty corridor crosses",
      /__PWSOAK__MissWall/.test(missCard) && /20 \/ 20/.test(missCard),
      missCard.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 240));
    await hooks._confirmSpreadZone(missZone.id);
    await sleep(1800);
    const missRow = wallRow(wMiss.uuid);
    ok("§6 the empty corridor still debits the barrier by its own 5 (20 → 15)",
      missRow?.pool === 15 && missRow?.poolMax === 20, `${missRow?.pool}/${missRow?.poolMax}`);
    const missChew = [...game.messages].filter(m => !missBefore.has(m.id) && /cp-cover-chew/.test(m.content ?? ""));
    ok("§6 one structure card for the empty corridor", missChew.length === 1, String(missChew.length));
    ok("§6 …and no figure-result card, because nothing was standing there",
      [...game.messages].filter(m => !missBefore.has(m.id) && /cp-spread-result-list/.test(m.content ?? "")).length === 0);
    await scene.deleteEmbeddedDocuments("Wall", [wMiss.id]);
    await sleep(200);

    /* ═══════════════ §7 presentation parity ═══════════════ */
    await saveSet("combatFxEnabled", true);
    // ⛔ REPOINTED TO THE STRUCTURE KIND 2026-08-29. The plain-character clip is WITHDRAWN
    //    (module/fx/effects.js `HIT_SOUND.flesh: { base: null }`, commit 7328447), so `hitSoundSrc`
    //    answers null for that kind and the sweep filters every plain figure before it can be counted
    //    — which reads as "no plan" and takes the MECHANISM under test down with it. The structure
    //    kind still rings, so the figure is flagged structural for this section only and handed back
    //    immediately after. The withdrawal is TEMPORARY by its own record (effects.js keeps the revert
    //    line; docs/FX-RAIL.md §6 carries the ruling), so ↪ RE-POINT THIS BACK to a plain figure when
    //    the clip returns.
    //    The flag is the shipped structural predicate's own explicit door (`isFullBorg`, mech/borg.js:121
    //    → `bearsStructuralSdp`, effects.js:6014), so this states the kind rather than simulating it.
    await mark.actor.setFlag(SCOPE, "fullBorg", true);
    await sleep(250);
    const audioPayload = basePayload();
    const wFxSoak = await mkWall([SX + 2 * gs, SY - 3 * gs, SX + 2 * gs, SY + 3 * gs],
      { coverSp: 3, coverPool: 9, coverPoolMax: 9, coverMaterial: "__PWSOAK__FxWall" });
    await sleep(400);
    const planSoak = fx.patternAudioPlanFor(audioPayload, shooter.tok);
    ok("§7 fixture: the corridor sweep produced a plan at all", !!planSoak, String(!!planSoak));
    ok("§7 a figure behind a VALUED barrier is still presented (the resolution damages it)",
      !!planSoak?.victims?.some(vv => vv.tokenId === mark.tokenDoc.id),
      JSON.stringify(planSoak?.victims?.map(vv => vv.tokenId) ?? []));
    await wFxSoak.update({ [`flags.${SCOPE}.coverSp`]: 0, [`flags.${SCOPE}.coverPool`]: null, [`flags.${SCOPE}.coverPoolMax`]: null });
    await sleep(400);
    const planNaked = fx.patternAudioPlanFor(audioPayload, shooter.tok);
    ok("§7 the same figure behind an UNVALUED wall is presented as untouched",
      !(planNaked?.victims ?? []).some(vv => vv.tokenId === mark.tokenDoc.id),
      JSON.stringify(planNaked?.victims?.map(vv => vv.tokenId) ?? []));
    // Hand the figure back before §8: a structural flag changes where damage is booked, and the
    // sections below read the wound track.
    await mark.actor.unsetFlag(SCOPE, "fullBorg").catch(() => {});
    await sleep(250);
    ok("§7 the section handed the figure back — the structural flag is off before the damage legs",
      mark.actor.getFlag(SCOPE, "fullBorg") === undefined,
      String(mark.actor.getFlag(SCOPE, "fullBorg")));
    await scene.deleteEmbeddedDocuments("Wall", [wFxSoak.id]);
    await sleep(200);

    // The wiring: both readers reach the ONE predicate, and neither keeps a private copy of the old one.
    const fxSrc = await (await fetch(`/modules/${SCOPE}/module/fx/effects.js`, { cache: "no-store" })).text();
    const dhSrc = await (await fetch(`/modules/${SCOPE}/module/combat/damage-hooks.js`, { cache: "no-store" })).text();
    ok("§7 wiring: the presentation sweep calls the split predicate",
      /areaCoverVerdict\(origin\.x, origin\.y, tok\)\.state === AREA_COVER_EXEMPT/.test(fxSrc));
    ok("§7 wiring: the presentation sweep no longer calls the bare occlusion test",
      !/^\s*if \(areaOcclusionTest\(/m.test(fxSrc));
    ok("§7 wiring: both area damage paths call the split predicate",
      (dhSrc.match(/areaCoverVerdict\(originX, originY, tok, scene\)/g) ?? []).length === 2,
      String((dhSrc.match(/areaCoverVerdict\(originX, originY, tok, scene\)/g) ?? []).length));
    ok("§7 wiring: the retired local occlusion alias is gone from the damage paths",
      !/const _isOccluded\s*=/.test(dhSrc));
    ok("§7 wiring: the per-figure pipeline is handed SP but no row, so it books no second debit",
      /coverSP:\s*Math\.max\(0, Number\(coverSP\) \|\| 0\)/.test(dhSrc) && !/cover:\s*entry\.row/.test(dhSrc));

    /* ═══════════════ §8 the detonation path takes the same split ═══════════════ */
    // A FLAT blast (full damage out to 50 m inside a 6 m radius) so every figure and the barrier all
    // receive the same 18 — three deltas that differ only by what is in the way.
    const BX = 3000, BY = 700;
    const centre = await mkFigure("__PWSOAK__BlastCentre", BX, BY, 0);
    const behindValued = await mkFigure("__PWSOAK__BehindValued", BX + 4 * gs, BY, 0);
    const behindNaked  = await mkFigure("__PWSOAK__BehindNaked", BX - 4 * gs, BY, 0);
    const wBlastValued = await mkWall([BX + 3 * gs, BY - 3 * gs, BX + 3 * gs, BY + 3 * gs],
      { coverSp: 3, coverPool: 40, coverPoolMax: 40, coverMaterial: "__PWSOAK__BlastWall" });
    const wBlastNaked = await mkWall([BX - 3 * gs, BY - 3 * gs, BX - 3 * gs, BY + 3 * gs]);
    await sleep(500);
    const radiusM = (5 * gs) / ppm;   // exactly five squares: the two flanking figures sit four out
    const b0 = {
      centre: Number(centre.actor.system.damage) || 0,
      valued: Number(behindValued.actor.system.damage) || 0,
      naked: Number(behindNaked.actor.system.damage) || 0,
    };
    const btmC = Number(centre.actor.system.stats?.bt?.modifier) || 0;
    Hooks.callAll("cyberpunk2020.weaponFired", {
      attackerId: shooter.actor.id, targetTokenId: centre.tokenDoc.id, effectTypes: ["Explosive"],
      areaDamages: { Torso: [{ damage: 18 }] }, blastRadius: radiusM, blastFullDamageWithin: 500,
      weaponName: "__PWSOAK__Charge",
    });
    let blastId = null;
    for (let i = 0; i < 40 && !blastId; i++) { blastId = areas.areasByFlag(scene, "isExplosion").pop()?.doc?.id ?? null; await sleep(200); }
    let blastBtn = null;
    for (let i = 0; i < 40 && !blastBtn; i++) { blastBtn = document.querySelector(`.cp-confirm-explosion[data-template-id="${blastId}"]`); await sleep(200); }
    ok("§8 fixture: the area was placed and its confirm control rendered", !!blastId && !!blastBtn, `${blastId} ${!!blastBtn}`);
    blastBtn?.click();
    await sleep(3000);
    const b1 = {
      centre: Number(game.actors.get(centre.actor.id)?.system?.damage) || 0,
      valued: Number(game.actors.get(behindValued.actor.id)?.system?.damage) || 0,
      naked: Number(game.actors.get(behindNaked.actor.id)?.system?.damage) || 0,
    };
    ok("§8 at the centre, nothing in the way: the whole 18 lands",
      b1.centre - b0.centre === Math.max(1, 18 - btmC), `delta=${b1.centre - b0.centre}`);
    ok("§8 behind a VALUED barrier: 18 less its SP 3 = 15",
      b1.valued - b0.valued === Math.max(1, 15 - (Number(behindValued.actor.system.stats?.bt?.modifier) || 0)),
      `delta=${b1.valued - b0.valued}`);
    ok("§8 behind an UNVALUED wall: nothing lands", b1.naked - b0.naked === 0, `delta=${b1.naked - b0.naked}`);
    ok("§8 the three blast outcomes are three different numbers",
      (b1.centre - b0.centre) !== (b1.valued - b0.valued) && (b1.valued - b0.valued) !== (b1.naked - b0.naked));
    const blastRow = wallRow(wBlastValued.uuid);
    ok("§8 the barrier in the radius is debited by the blast it received (40 → 22)",
      blastRow?.pool === 22 && blastRow?.poolMax === 40, `${blastRow?.pool}/${blastRow?.poolMax}`);
    await scene.deleteEmbeddedDocuments("Wall", [wBlastValued.id, wBlastNaked.id]).catch(() => {});

    /* ═══════ §9 the cover-only control: charge the object, write nothing to the target ═══════
     * User ruling 2026-08-26. The referee's way of saying "this went into that object" — the book
     * prints no aimed-miss landing model, so nothing is guessed: the press IS the statement.
     */
    const dlgMod = await import(`/modules/${SCOPE}/module/combat/DamageDialog.js`);
    const openWindow = async (payload) => {
      const dlg = new dlgMod.DamageDialog(payload, game.actors.get(mark.actor.id));
      await dlg.render(true);
      for (let i = 0; i < 40 && !dlg.element?.querySelector?.("input[name='coverSP']"); i++) await sleep(150);
      return dlg;
    };
    const winPayload = (dmg) => ({
      areaDamages: { Torso: [{ damage: dmg }] },
      attackerTokenId: shooter.tokenDoc.id, targetTokenId: mark.tokenDoc.id,
      weaponName: "__PWSOAK__Charge",
    });

    // (a) an ordinary valued wall — exact debit, target untouched, one card, and the control latches.
    const wBtn = await mkWall([SX + 2 * gs, SY - 3 * gs, SX + 2 * gs, SY + 3 * gs],
      { coverSp: 5, coverPool: 40, coverPoolMax: 40, coverMaterial: "__PWSOAK__BtnWall" });
    await sleep(400);
    const hpBefore = Number(game.actors.get(mark.actor.id)?.system?.damage) || 0;
    const btnIdsBefore = new Set(game.messages.map(m => m.id));
    const dlgA = await openWindow(winPayload(12));
    const btnA = dlgA.element?.querySelector('button[data-action="chewCoverOnly"]');
    ok("§9 the control is offered when a cover OBJECT was detected", !!btnA,
      String(dlgA.element?.querySelector("input[name='coverSP']")?.value));
    btnA?.click();
    await sleep(1600);
    let btnRow = wallRow(wBtn.uuid);
    ok("§9 the object is debited the window's RAW damage, exactly (40 → 28)",
      btnRow?.pool === 28 && btnRow?.poolMax === 40, `${btnRow?.pool}/${btnRow?.poolMax}`);
    ok("§9 ⛔ nothing was written to the target",
      (Number(game.actors.get(mark.actor.id)?.system?.damage) || 0) === hpBefore,
      `${hpBefore} → ${Number(game.actors.get(mark.actor.id)?.system?.damage) || 0}`);
    const btnCards = [...game.messages].filter(m => !btnIdsBefore.has(m.id) && /cp-cover-chew/.test(m.content ?? ""));
    ok("§9 one structure card, naming the object and the amount",
      btnCards.length === 1 && /__PWSOAK__BtnWall/.test(btnCards[0]?.content ?? "")
      && /absorbed 12 damage/.test(btnCards[0]?.content ?? ""), String(btnCards.length));
    // THE SECOND-ACT RULE: a second press must not take a second debit for the same damage number.
    await sleep(400);
    const btnAgain = dlgA.element?.querySelector('button[data-action="chewCoverOnly"]');
    ok("§9 the control is spent after one press (no second debit is offered)", !btnAgain,
      String(!!btnAgain));
    ok("§9 the spent state is shown rather than the row silently vanishing",
      !!dlgA.element?.querySelector("button.cp-chew-cover-only[disabled]"));
    btnAgain?.click();
    await sleep(1200);
    btnRow = wallRow(wBtn.uuid);
    ok("§9 structure is unchanged by the second press (28, not 16)", btnRow?.pool === 28, String(btnRow?.pool));
    await dlgA.close().catch(() => {});
    await scene.deleteEmbeddedDocuments("Wall", [wBtn.id]);
    await sleep(300);

    // (b) a DOOR ground to zero swings open — through the SAME write path, with no door code of its own.
    const wDoor = await mkWall([SX + 2 * gs, SY - 3 * gs, SX + 2 * gs, SY + 3 * gs],
      { coverSp: 4, coverPool: 12, coverPoolMax: 12, coverMaterial: "__PWSOAK__BtnDoor" },
      { door: 1, ds: 0 });
    await sleep(400);
    const doorIdsBefore = new Set(game.messages.map(m => m.id));
    const dlgB = await openWindow(winPayload(12));
    const btnB = dlgB.element?.querySelector('button[data-action="chewCoverOnly"]');
    ok("§9 fixture: the door was detected as the cover object", !!btnB, String(!!btnB));
    btnB?.click();
    await sleep(1800);
    const doorRow = wallRow(wDoor.uuid);
    const OPEN = CONST?.WALL_DOOR_STATES?.OPEN ?? 1;
    ok("§9 the door's structure reaches zero", doorRow?.pool === 0 && doorRow?.destroyed === true,
      `${doorRow?.pool} destroyed=${doorRow?.destroyed}`);
    ok("§9 …and it swings OPEN on the same write", (wDoor.ds ?? wDoor._source?.ds) === OPEN,
      String(wDoor.ds ?? wDoor._source?.ds));
    ok("§9 the door's card says it was opened",
      [...game.messages].some(m => !doorIdsBefore.has(m.id) && /cp-cover-chew/.test(m.content ?? "")
        && /open/i.test(m.content ?? "")));
    await dlgB.close().catch(() => {});
    await scene.deleteEmbeddedDocuments("Wall", [wDoor.id]);
    await sleep(300);

    // (c) the negative: no object on the line means no control at all (a typed SP names no document).
    const dlgC = await openWindow(winPayload(9));
    ok("§9 with nothing detected the control is not offered at all",
      !dlgC.element?.querySelector('button[data-action="chewCoverOnly"]'));
    await dlgC.close().catch(() => {});

    /* ═══════════════ §10 THE PRESSED BUTTON — the corridor's own card, through the real DOM ═══════
     * Field report 2026-08-26: a shot pattern was fired at a figure standing behind a VALUED DOOR
     * (SP 20, structure 20/20), the resolution card's Apply was PRESSED, and the door's structure still
     * read 20/20 afterwards — no debit had ever been written.
     *
     * Every leg above this one reaches the resolution by CALLING `_confirmSpreadZone` directly. That is
     * the right shape for asserting the arithmetic, and it is exactly the shape that cannot see a defect
     * between the rendered button and that function — the card's own markup, the delegated click
     * handler, the data-template-id the handler reads. So this section drives the press the way a person
     * does: it finds the posted card IN THE CHAT LOG, dispatches a real click on the rendered button, and
     * reads the door's flags afterwards. Fixture numbers are the reported ones deliberately, so a red
     * here is the user's own case and not an analogue of it.
     */
    const doorWall = await mkWall([SX + 2 * gs, SY - 3 * gs, SX + 2 * gs, SY + 3 * gs],
      { coverSp: 20, coverPool: 20, coverPoolMax: 20, coverMaterial: "__PWSOAK__FieldDoor" },
      { door: 1, ds: 0 });
    await sleep(400);
    ok("§10 fixture: the door stands valued and whole before the shot (SP 20, 20/20)",
      wallRow(doorWall.uuid)?.sp === 20 && wallRow(doorWall.uuid)?.pool === 20
      && wallRow(doorWall.uuid)?.poolMax === 20,
      JSON.stringify(wallRow(doorWall.uuid)));

    const uiIdsBefore = new Set(game.messages.map(m => m.id));
    const uiZone = await plantZone(basePayload());
    ok("§10 fixture: the corridor was planted across the door", !!uiZone, String(!!uiZone));
    // ⚠ THE CARD ID IS STAMPED ONTO THE ZONE ONE AWAIT AFTER THE ZONE APPEARS, so it is polled rather
    // than read the instant the plant returns — an unstamped read here would red every leg below it
    // with "no card" and say nothing about the mechanism under test.
    let uiCard = null;
    for (let i = 0; i < 40 && !uiCard; i++) {
      uiCard = game.messages.get(String(scene.regions.get(uiZone?.id)?.flags?.[SCOPE]?.cardMessageId
        ?? uiZone?.flags?.[SCOPE]?.cardMessageId ?? "")) ?? null;
      if (!uiCard) await sleep(200);
    }
    const uiHtml = uiCard?.content ?? "";
    ok("§10 fixture: the corridor's resolution card was posted and recorded on the pattern",
      !!uiCard, String(uiCard?.id));
    // ⭐ THE ONE-GLANCE DISCRIMINATOR, asserted by its exact wording so it can be handed to a reader.
    // A CURRENT client's card names the barrier twice: once as the figure's own status ("in pattern —
    // behind <door> (SP 20 soaks first)") and once as the crossing the button is going to charge ("The
    // path crosses <door> — SP 20, structure 20 / 20"). A client running EXEMPT-ERA code says neither —
    // it lists the figure as "behind an unrated wall — exempt" and prints no crossing line at all, and
    // its Apply then has nothing to debit. The two cards are told apart at a glance by that line.
    ok("§10 the card names the crossing the button is going to charge, with the door's own numbers",
      /path crosses/i.test(uiHtml) && /__PWSOAK__FieldDoor/.test(uiHtml) && /20\s*\/\s*20/.test(uiHtml),
      uiHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300));
    ok("§10 …and the figure's own row reads SOAKED, not exempt (the stale-client discriminator)",
      /behind/i.test(uiHtml) && /soaks first/i.test(uiHtml) && !/exempt/i.test(uiHtml),
      uiHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300));

    // THE PRESS ITSELF — the rendered button in the chat log, not the exported function.
    const uiSel = `[data-message-id="${uiCard?.id}"] .cp-confirm-spread-zone`;
    let uiBtn = document.querySelector(uiSel);
    for (let i = 0; i < 40 && !uiBtn; i++) { await sleep(150); uiBtn = document.querySelector(uiSel); }
    ok("§10 the card RENDERS its Apply control where a reader can press it",
      !!uiBtn && uiBtn.disabled === false, `found=${!!uiBtn} disabled=${uiBtn?.disabled}`);
    ok("§10 …and the control carries the pattern id the handler resolves by (wiring, non-empty)",
      !!uiBtn?.dataset?.templateId && uiBtn.dataset.templateId === uiZone?.id,
      `data-template-id=${uiBtn?.dataset?.templateId} zone=${uiZone?.id}`);
    uiBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(2200);

    const doorAfter = wallRow(doorWall.uuid);
    ok("§10 ⭐ THE PRESSED BUTTON DEBITS THE DOOR — 20 → 15, the corridor's own 5",
      doorAfter?.pool === 15 && doorAfter?.poolMax === 20,
      `${doorAfter?.pool}/${doorAfter?.poolMax}`);
    const uiChew = [...game.messages].filter(m => !uiIdsBefore.has(m.id) && /cp-cover-chew/.test(m.content ?? ""));
    ok("§10 …and posts exactly one structure card naming the door", uiChew.length === 1
      && /__PWSOAK__FieldDoor/.test(uiChew[0]?.content ?? ""), String(uiChew.length));
    // THE SECOND-ACT RULE: the card is spent, and a second press takes no second debit.
    const uiBtnAgain = document.querySelector(uiSel);
    uiBtnAgain?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(1400);
    ok("§10 a second press writes nothing further (structure still 15)",
      wallRow(doorWall.uuid)?.pool === 15, String(wallRow(doorWall.uuid)?.pool));

    /* §10b — THE FUMBLE INTERACTION. A shell the base ruled a FUMBLE plants no corridor at all
     * (damage-hooks `_placeSpreadZone` returns on `fumbleRuled`, matching the presentation rail, which
     * has skipped the whole fan-out on that field since it shipped). So there is no card to press and no
     * door to charge — which is the honest answer for a shot the base itself damaged nobody with, and it
     * rules the fumble OUT as an explanation for a missing debit on a corridor that DID post a card. */
    for (const r of myZones()) await r.delete?.().catch(() => {});
    await sleep(300);
    const fumbleIdsBefore = new Set(game.messages.map(m => m.id));
    await hooks._placeSpreadZone(basePayload({ attackTotal: 31, toHitDC: 15, baseHit: false, fumbleRuled: true }));
    await sleep(1500);
    ok("§10b a ruled FUMBLE plants no corridor and posts no resolution card",
      myZones().length === 0
      && [...game.messages].filter(m => !fumbleIdsBefore.has(m.id) && /cp-spread-resolve-list/.test(m.content ?? "")).length === 0,
      `zones=${myZones().length}`);
    ok("§10b …so the door is untouched by it (still 15, no second debit from a fumbled shell)",
      wallRow(doorWall.uuid)?.pool === 15, String(wallRow(doorWall.uuid)?.pool));
    // …and the same payload WITHOUT the ruling still plants, so the leg above is not vacuous.
    const notFumble = await plantZone(basePayload({ attackTotal: 31, toHitDC: 15, baseHit: true }));
    ok("§10b the identical shot minus the fumble ruling DOES plant (negative control)",
      !!notFumble, String(!!notFumble));
    for (const r of myZones()) await r.delete?.().catch(() => {});
    await scene.deleteEmbeddedDocuments("Wall", [doorWall.id]).catch(() => {});
    await sleep(300);
  } catch (err) {
    out.checks.push({ n: "suite threw", p: false, d: String(err?.stack ?? err) });
  } finally {
    await wipeFixtures();
    for (const [k, v] of Object.entries(prev)) { try { await game.settings.set(SCOPE, k, v); } catch (e) { /* absent */ } }
    // Hand the rig back on the scene it was found on.
    if (priorSceneId && game.scenes.active?.id !== priorSceneId) {
      await game.scenes.get(priorSceneId)?.activate?.().catch(() => {});
    }
    for (const m of [...game.messages].filter(m => /__PWSOAK__/.test(m.content ?? ""))) await m.delete().catch(() => {});
    // ⚠ SETTLE BEFORE THE PROCESS EXITS. The next suite in a battery joins seconds later, and a teardown
    // whose writes are still in flight leaves the world mid-change for it (2026-08-26).
    await sleep(1200);
  }
  return out;
});

console.log("\ncover area soak-and-chew");
for (const c of res.checks) check(c.n, c.p, c.d);
check("0 console errors", errors.length === 0, errors.slice(0, 4).join(" | "));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
