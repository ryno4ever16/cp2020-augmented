/**
 * KEEPER: cover Unit 4 — segment auto-detect (coverBetween) + the opt-in dialog seed.
 *  - coverBetween returns the rows the attacker->target segment actually crosses:
 *    a zone the segment passes through, a cover-flagged wall the segment crosses
 *  - off-segment rows (flanking zone, wall parallel to the segment) are NOT returned
 *  - a destroyed row sitting on the segment is NOT returned
 *  - origin trim: a row within half a grid of the ATTACKER'S centre is excluded, while the
 *    SAME row moved next to the TARGET is returned
 *  - NO world toggle stands in front of the seed any more (the key is not registered and the
 *    module exposes no reader for it): placing cover is the opt-in
 *  - the DamageDialog seeds Cover SP from the crossed row on the first build, offers no
 *    cover-object selector at all, keeps the seeded value across a re-render, and never re-seeds
 *    over a value typed afterwards (one-shot latch)
 *  - with nothing on the segment the window opens at Cover SP 0
 *  - the expandable math line names the cover object it seeded and its SP
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";

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

/* ═════════════ phase 1: the pure segment test (crossed / not crossed / destroyed / trim) ═════════════ */
const res = await page.evaluate(async (SCOPE) => {
  const out = { checks: [], ids: {}, diag: {} };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });

  // The segment test is a statement about what lies between two points, so it can only be asserted
  // on a surface whose whole contents this spec placed. A shared scene carrying standing review
  // fixtures put cover on the line and made every "exactly these crossings" reading wrong — so the
  // spec builds and activates its OWN scene and hands the previous one back at the end.
  out.ids.prevActiveId = game.scenes.active?.id ?? null;
  for (const s of [...game.scenes]) if (s.name?.startsWith("__PWX__")) await s.delete();
  const [scene] = await Scene.create([{
    name: "__PWX__CoverRay", width: 4000, height: 3000, padding: 0,
    grid: { size: 100, type: CONST.GRID_TYPES.SQUARE },
  }]);
  await scene.activate();
  for (let i = 0; i < 150 && !(canvas?.ready && canvas.scene?.id === scene.id); i++) await new Promise(r => setTimeout(r, 200));
  out.ids.sceneId = scene.id;

  for (const a of [...game.actors]) if (a.name?.startsWith("__PWX__")) await a.delete();

  const cov = await import(`/modules/${SCOPE}/module/combat/cover.js`);
  const G = scene.grid?.size ?? 100;
  out.diag.grid = G;

  // A purpose-built scene starts with nothing on it — assert that rather than trusting it, so a
  // future contamination is a failing check instead of a silently wrong crossing count.
  const preExisting = cov.coverChoicesFor(null).length;
  out.diag.preExistingRows = preExisting;
  ok("the spec's own scene starts with no cover on it", preExisting === 0, String(preExisting));

  const mkWall = async (c, flags = {}) => {
    const [w] = await scene.createEmbeddedDocuments("Wall", [{ c, flags: { [SCOPE]: { __pwx: true, ...flags } } }]);
    return w;
  };

  /* actors + tokens: attacker at 5G,10G (centre 5.5G,10.5G) — target at 15G,10G (centre 15.5G,10.5G).
     The segment is the horizontal line y = 10.5G from x = 5.5G to x = 15.5G. */
  const shooter = await Actor.create({ name: "__PWX__Shooter", type: "character" });
  const victim = await Actor.create({ name: "__PWX__Victim", type: "npc" });
  const [aTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PWX__ShooterTok", actorId: shooter.id, actorLink: true, x: 5 * G, y: 10 * G, width: 1, height: 1 }]);
  const [tTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PWX__VictimTok", actorId: victim.id, actorLink: true, x: 15 * G, y: 10 * G, width: 1, height: 1 }]);

  const uuidsOf = (rows) => rows.map(r => r.uuid);
  const behUuid = (region) => region.behaviors.find(b => b.type === `${SCOPE}.coverZone`)?.uuid;

  /* a. a zone straddling the segment is returned; a flanking zone off the segment is not */
  const onZone = await cov.placeCoverZone({ scene, label: "__PWX__OnLineZone", sp: 10 });
  await onZone.update({ shapes: [{ type: "rectangle", x: 10 * G, y: 10 * G, width: G, height: G, rotation: 0 }] });
  const offZone = await cov.placeCoverZone({ scene, label: "__PWX__FlankZone", sp: 5 });
  await offZone.update({ shapes: [{ type: "rectangle", x: 10 * G, y: 6 * G, width: G, height: G, rotation: 0 }] });
  const onZoneUuid = behUuid(onZone), offZoneUuid = behUuid(offZone);

  // Evidence for a zone-detection failure, both call shapes of the platform containment test:
  // v14's RegionDocument#testPoint takes ONE ElevatedPoint ({x,y,elevation}); the older
  // (point, elevation) form leaves point.elevation undefined and always answers false.
  out.diag.testPointArity = onZone.testPoint?.length;
  const probe = (fn) => { try { return fn(); } catch (e) { return `throw: ${e.message}`; } };
  out.diag.testPoint_pointElevationArgs = probe(() => onZone.testPoint({ x: 10.5 * G, y: 10.5 * G }, 0));
  out.diag.testPoint_elevatedPointArg = probe(() => onZone.testPoint({ x: 10.5 * G, y: 10.5 * G, elevation: 0 }));

  let crossed = uuidsOf(cov.coverBetween(aTok, tTok));
  ok("segment-crossed zone returned", crossed.includes(onZoneUuid), crossed.length ? crossed.join(",") : "(none)");
  ok("off-segment flanking zone excluded", !crossed.includes(offZoneUuid));

  /* b. a cover-flagged wall crossing the segment is returned; one parallel to it is not */
  const wCross = await mkWall([12 * G, 9 * G, 12 * G, 12 * G], { coverSp: 20, coverMaterial: "__PWX__CrossWall" });
  const wParallel = await mkWall([6 * G, 7 * G, 15 * G, 7 * G], { coverSp: 10, coverMaterial: "__PWX__ParallelWall" });
  crossed = uuidsOf(cov.coverBetween(aTok, tTok));
  ok("segment-crossed wall returned", crossed.includes(wCross.uuid), crossed.join(","));
  ok("wall parallel to the segment excluded", !crossed.includes(wParallel.uuid));

  /* c. a destroyed row sitting on the segment is never returned */
  const wDead = await mkWall([12.5 * G, 9 * G, 12.5 * G, 12 * G], { coverSp: 10, coverPool: 0, coverPoolMax: 30, coverMaterial: "__PWX__DeadWall" });
  const deadRow = cov.coverWallsOn(scene).find(r => r.uuid === wDead.uuid);
  ok("dead row reads as destroyed at structure 0", deadRow?.destroyed === true && deadRow?.pool === 0, `${deadRow?.pool} destroyed=${deadRow?.destroyed}`);
  ok("dead row is offered by the picker but excluded by the segment test", cov.coverChoicesFor(tTok).some(r => r.uuid === wDead.uuid));
  crossed = uuidsOf(cov.coverBetween(aTok, tTok));
  ok("destroyed row on the segment excluded", !crossed.includes(wDead.uuid), crossed.join(","));

  /* d. origin trim — the same wall at the shooter's elbow vs at the target's */
  const wTrim = await mkWall([5.75 * G, 9 * G, 5.75 * G, 12 * G], { coverSp: 10, coverMaterial: "__PWX__TrimWall" });
  crossed = uuidsOf(cov.coverBetween(aTok, tTok));
  ok("origin-trim excludes a row inside the shooter's half-grid", !crossed.includes(wTrim.uuid), crossed.join(","));
  await wTrim.update({ c: [15.25 * G, 9 * G, 15.25 * G, 12 * G] });
  crossed = uuidsOf(cov.coverBetween(aTok, tTok));
  ok("the same row adjacent to the target IS returned", crossed.includes(wTrim.uuid), crossed.join(","));

  /* the returned set is exactly the three live crossings (the zone + two walls), nearest first */
  const live = cov.coverBetween(aTok, tTok);
  ok("crossed set is exactly the three live crossings (zone + two walls)", live.length === 3 && new Set(uuidsOf(live)).size === 3,
    live.map(r => r.label).join(","));
  ok("crossed rows keep the nearest-to-target-first order", live[0]?.uuid === wTrim.uuid, live.map(r => r.label).join(","));

  /* negative guards on the arguments themselves */
  ok("no attacker token returns no rows", cov.coverBetween(null, tTok).length === 0);
  ok("no target token returns no rows", cov.coverBetween(aTok, null).length === 0);
  ok("attacker standing on the target returns no rows (zero-length segment)", cov.coverBetween(tTok, tTok).length === 0);

  /* the world toggle that used to gate the seed is gone in both directions */
  ok("the retired world toggle is not registered", game.settings.settings.has(`${SCOPE}.autoCoverDetection`) === false);
  ok("the module exposes no reader for it", cov.coverAutoDetectEnabled === undefined, typeof cov.coverAutoDetectEnabled);

  /* Trim the fixture down for the dialog phase: one crossing row (the SP-20 wall, nearest to the
     target of everything on the segment) plus the off-segment zone that must never be seeded. */
  await scene.deleteEmbeddedDocuments("Wall", [wParallel.id, wDead.id, wTrim.id]);
  const seedRow = cov.coverBetween(aTok, tTok);
  ok("the crossing wall is the nearest live crossing (the natural seed)", seedRow[0]?.uuid === wCross.uuid, seedRow.map(r => r.label).join(","));

  out.ids = {
    ...out.ids,
    shooterId: shooter.id, victimId: victim.id,
    aTokId: aTok.id, tTokId: tTok.id,
    onZoneId: onZone.id, offZoneId: offZone.id,
    onZoneUuid, offZoneUuid,
    wCrossId: wCross.id, wCrossUuid: wCross.uuid,
  };
  return out;
}, SCOPE);

for (const c of res.checks) check(c.n, c.p, c.d);
console.log(`  (diag: ${JSON.stringify(res.diag)})`);

/* ═══════════════ phase 2: the dialog seed — no world toggle, no selector control ═══════════════ */

const openDialog = async () => {
  await page.evaluate(async ({ victimId, tTokId, aTokId }) => {
    for (const app of [...foundry.applications.instances.values()]) {
      if (app.constructor?.name === "DamageDialog") await app.close().catch(() => {});
    }
    const { DamageDialog } = await import("/modules/cp2020-augmented/module/combat/DamageDialog.js");
    const target = game.actors.get(victimId);
    window.__pwDlg = new DamageDialog(
      { areaDamages: { Torso: [{ damage: 12 }] }, targetTokenId: tTokId, attackerTokenId: aTokId },
      target,
    );
    await window.__pwDlg.render(true);
  }, res.ids);
  await page.waitForSelector('form.damage-dialog input[name="coverSP"]', { timeout: 15000 });
};

const readDialog = () => page.evaluate(() => {
  const root = document.querySelector("form.damage-dialog");
  const sp = root?.querySelector('input[name="coverSP"]');
  const bdRows = [...root.querySelectorAll(".cp-damage-breakdown-row")].map(r => ({
    label: r.querySelector(".cp-bd-label")?.textContent?.trim() ?? "",
    value: r.querySelector(".cp-bd-value")?.textContent?.trim() ?? "",
  }));
  return {
    sp: sp?.value ?? null,
    selectors: root.querySelectorAll('select[name="coverZone"]').length,
    bdRows,
  };
});

/** Mark a live control, fire a real change on another, and wait for the app to actually rebuild. */
const rerenderVia = async (markSelector, act) => {
  await page.evaluate(sel => { const el = document.querySelector(`form.damage-dialog ${sel}`); if (el) el.dataset.pwStale = "1"; }, markSelector);
  await act();
  await page.waitForFunction(sel => {
    const el = document.querySelector(`form.damage-dialog ${sel}`);
    return !!el && el.dataset.pwStale !== "1";
  }, markSelector, { timeout: 15000 });
};

/* e1. no world toggle is set anywhere below — the window is opened exactly as a shot opens it,
       and the crossed row's SP arrives on the first build. */
await openDialog();
let dlg = await readDialog();
check("no cover-object selector renders in the window", dlg.selectors === 0, `selects ${dlg.selectors}`);
check("Cover SP seeded from the crossed row (20), no world toggle involved", dlg.sp === "20", String(dlg.sp));

/* e2. the math line names the object that seeded it, with its SP in the ordered format */
const coverRow = dlg.bdRows.find(r => r.label === "__PWX__CrossWall");
check("the math line names the seeded cover object", !!coverRow, dlg.bdRows.map(r => `${r.label}=${r.value}`).join(" | "));
check("the math line carries its SP as [20]", coverRow?.value === "[20]", String(coverRow?.value));
check("the math line opens with the roll (12)", dlg.bdRows[0]?.label === "Roll" && dlg.bdRows[0]?.value === "12", JSON.stringify(dlg.bdRows[0]));
check("the math line closes on a named final value", dlg.bdRows.some(r => r.label === "Final"), dlg.bdRows.map(r => r.label).join(","));

/* e3. the seed survives a real re-render */
await rerenderVia('input[name="coverSP"]', () => page.evaluate(() => {
  const sel = document.querySelector('form.damage-dialog select[name="armorMode"]');
  sel.value = sel.value === "full" ? "simple" : "full";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}));
dlg = await readDialog();
check("the seeded Cover SP survives the re-render", dlg.sp === "20", String(dlg.sp));

/* e4. a value typed afterwards sticks — the one-shot latch never re-seeds over it */
await rerenderVia('select[name="armorMode"]', () => page.evaluate(() => {
  const el = document.querySelector('form.damage-dialog input[name="coverSP"]');
  el.value = "3";
  el.dispatchEvent(new Event("change", { bubbles: true }));
}));
dlg = await readDialog();
check("a typed Cover SP replaces the seeded one", dlg.sp === "3", String(dlg.sp));

await rerenderVia('input[name="coverSP"]', () => page.evaluate(() => {
  const sel = document.querySelector('form.damage-dialog select[name="armorMode"]');
  sel.value = sel.value === "full" ? "simple" : "full";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}));
dlg = await readDialog();
check("the typed value is never re-seeded (one-shot latch holds)", dlg.sp === "3", String(dlg.sp));

/* the attacker resolver's actor-id fallback (no attackerTokenId in the payload) */
const byActorId = await page.evaluate(async ({ victimId, tTokId, shooterId, aTokId }) => {
  const { DamageDialog } = await import("/modules/cp2020-augmented/module/combat/DamageDialog.js");
  const d = new DamageDialog({ areaDamages: { Torso: [{ damage: 1 }] }, targetTokenId: tTokId, attackerId: shooterId }, game.actors.get(victimId));
  const doc = d._attackerTokenDoc();
  return { id: doc?.id ?? null, want: aTokId };
}, res.ids);
check("attacker resolves from the actor id when no token id is carried", byActorId.id === byActorId.want, JSON.stringify(byActorId));

/* f. nothing on the segment (an off-segment row still on the scene): the window opens at 0, and
      the math line carries no cover component at all — the natural off state, no toggle needed. */
await page.evaluate(async ({ sceneId, onZoneId, wCrossId }) => {
  const scene = game.scenes.get(sceneId);
  await scene.regions.get(onZoneId)?.delete();
  if (scene.walls.get(wCrossId)) await scene.deleteEmbeddedDocuments("Wall", [wCrossId]);
}, res.ids);
await openDialog();
dlg = await readDialog();
check("nothing on the segment: Cover SP stays 0", dlg.sp === "0", String(dlg.sp));
check("nothing on the segment: the math line names no cover component",
  !dlg.bdRows.some(r => /__PWX__|^Cover$/.test(r.label)), dlg.bdRows.map(r => r.label).join(","));

/* ═══════════════════════════════ cleanup + rig hygiene ═══════════════════════════════ */
// The whole surface this spec built goes with the scene; the previously active one is handed back
// so the rig is left exactly as it was found.
await page.evaluate(async ({ sceneId, prevActiveId }) => {
  for (const app of [...foundry.applications.instances.values()]) {
    if (app.constructor?.name === "DamageDialog") await app.close().catch(() => {});
  }
  for (const a of [...game.actors]) if (a.name?.startsWith("__PWX__")) await a.delete().catch(() => {});
  for (const m of game.messages.filter(x => x.content.includes("__PWX__") || x.content.includes("cp-cover-chew"))) await m.delete().catch(() => {});
  const prev = prevActiveId ? game.scenes.get(prevActiveId) : null;
  if (prev) { await prev.activate().catch(() => {}); for (let i = 0; i < 150 && canvas?.scene?.id !== prev.id; i++) await new Promise(r => setTimeout(r, 200)); }
  await game.scenes.get(sceneId)?.delete().catch(() => {});
}, res.ids).catch(e => console.log(`  (cleanup warning: ${e.message})`));

const leftovers = await page.evaluate(({ prevActiveId }) => ({
  probeScenes: game.scenes.filter(s => s.name?.startsWith("__PWX__")).length,
  actors: game.actors.filter(a => a.name?.startsWith("__PWX__")).length,
  activeRestored: (game.scenes.active?.id ?? null) === prevActiveId ? 0 : 1,
}), res.ids);
check("fixtures swept and the previously active scene handed back", Object.values(leftovers).every(v => v === 0), JSON.stringify(leftovers));

check("0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
