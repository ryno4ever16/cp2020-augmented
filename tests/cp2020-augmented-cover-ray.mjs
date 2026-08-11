/**
 * KEEPER: cover Unit 4 — segment auto-detect (coverBetween) + the opt-in dialog seed.
 *  - coverBetween returns the rows the attacker->target segment actually crosses:
 *    a zone the segment passes through, a cover-flagged wall the segment crosses
 *  - off-segment rows (flanking zone, wall parallel to the segment) are NOT returned
 *  - a destroyed row sitting on the segment is NOT returned
 *  - origin trim: a row within half a grid of the ATTACKER'S centre is excluded, while the
 *    SAME row moved next to the TARGET is returned
 *  - the autoCoverDetection setting gates the DamageDialog seed: off (default) the picker opens
 *    unselected at Cover SP 0; on, a fresh dialog preselects the crossed row and its SP; the
 *    selection survives a re-render; a manual re-selection is never re-seeded (one-shot latch)
 *  - with the setting on and nothing on the segment, the dialog still opens unselected
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

  if (!game.scenes.active) await (game.scenes.getName("Foundry Virtual Tabletop") ?? game.scenes.contents[0])?.activate();
  const scene = game.scenes.active;
  for (let i = 0; i < 100 && !(canvas?.ready && canvas.scene?.id === scene.id); i++) await new Promise(r => setTimeout(r, 200));
  out.ids.sceneId = scene.id;

  // stale sweep from any interrupted run
  const stale = [...scene.walls].filter(w => w.flags?.[SCOPE]?.__pwx === true).map(w => w.id);
  if (stale.length) await scene.deleteEmbeddedDocuments("Wall", stale);
  for (const r of [...scene.regions]) if (r.name?.startsWith("__PWX__")) await r.delete();
  for (const a of [...game.actors]) if (a.name?.startsWith("__PWX__")) await a.delete();
  const staleTok = [...scene.tokens].filter(t => t.name?.startsWith("__PWX__")).map(t => t.id);
  if (staleTok.length) await scene.deleteEmbeddedDocuments("Token", staleTok);

  const cov = await import(`/modules/${SCOPE}/module/combat/cover.js`);
  const G = scene.grid?.size ?? 100;
  out.diag.grid = G;

  // Any cover row already on the scene would contaminate the dialog phase's "nothing selected"
  // expectations — record the count so a contaminated run is visible rather than silently wrong.
  const preExisting = cov.coverChoicesFor(null).length;
  out.diag.preExistingRows = preExisting;

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

  /* the setting reader defaults OFF */
  ok("auto-detect setting reads off by default", cov.coverAutoDetectEnabled() === false, String(cov.coverAutoDetectEnabled()));

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

/* ═════════════════════ phase 2: the dialog seed, gated by the world setting ═════════════════════ */

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
  await page.waitForSelector('form.damage-dialog select[name="coverZone"]', { timeout: 15000 });
};

const readDialog = () => page.evaluate(() => {
  const root = document.querySelector("form.damage-dialog");
  const sel = root?.querySelector('select[name="coverZone"]');
  const sp = root?.querySelector('input[name="coverSP"]');
  return {
    sel: sel?.value ?? null,
    sp: sp?.value ?? null,
    optCount: sel ? sel.options.length : 0,
    selectedAttrs: sel ? [...sel.options].filter(o => o.selected).map(o => o.value) : [],
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

const setAuto = (on) => page.evaluate(v => game.settings.set("cp2020-augmented", "autoCoverDetection", v), on);

/* e1. setting OFF (default): picker renders, nothing preselected, Cover SP 0 */
await setAuto(false);
await openDialog();
let dlg = await readDialog();
check("setting off: picker offers the scene's cover rows", dlg.optCount === 4, `options ${dlg.optCount}`);
check("setting off: no row preselected", dlg.sel === "" && dlg.selectedAttrs.every(v => v === ""), JSON.stringify(dlg));
check("setting off: Cover SP stays 0", dlg.sp === "0", String(dlg.sp));

/* e2. setting ON: a fresh dialog seeds the CROSSED row and its SP */
await setAuto(true);
await openDialog();
dlg = await readDialog();
check("setting on: crossed row preselected in the picker", dlg.sel === res.ids.wCrossUuid, `${dlg.sel} vs ${res.ids.wCrossUuid}`);
check("setting on: the off-segment row is NOT the seeded one", dlg.sel !== res.ids.offZoneUuid);
check("setting on: Cover SP seeded from the row (20)", dlg.sp === "20", String(dlg.sp));

/* e3. the seed survives a real re-render */
await rerenderVia('select[name="coverZone"]', () => page.evaluate(() => {
  const sel = document.querySelector('form.damage-dialog select[name="armorMode"]');
  sel.value = sel.value === "full" ? "simple" : "full";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}));
dlg = await readDialog();
check("one-shot auto-pick survives re-render", dlg.sel === res.ids.wCrossUuid, JSON.stringify(dlg));
check("the seeded Cover SP survives the re-render", dlg.sp === "20", String(dlg.sp));

/* e4. choosing manual sticks — the latch never re-seeds on a later re-render */
await rerenderVia('select[name="armorMode"]', () => page.evaluate(() => {
  const sel = document.querySelector('form.damage-dialog select[name="coverZone"]');
  sel.value = "";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}));
dlg = await readDialog();
check("manual re-selection clears the seeded row", dlg.sel === "", JSON.stringify(dlg));

await rerenderVia('select[name="coverZone"]', () => page.evaluate(() => {
  const sel = document.querySelector('form.damage-dialog select[name="armorMode"]');
  sel.value = sel.value === "full" ? "simple" : "full";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}));
dlg = await readDialog();
check("manual choice is never re-seeded (one-shot latch holds)", dlg.sel === "", JSON.stringify(dlg));

/* the attacker resolver's actor-id fallback (no attackerTokenId in the payload) */
const byActorId = await page.evaluate(async ({ victimId, tTokId, shooterId, aTokId }) => {
  const { DamageDialog } = await import("/modules/cp2020-augmented/module/combat/DamageDialog.js");
  const d = new DamageDialog({ areaDamages: { Torso: [{ damage: 1 }] }, targetTokenId: tTokId, attackerId: shooterId }, game.actors.get(victimId));
  const doc = d._attackerTokenDoc();
  return { id: doc?.id ?? null, want: aTokId };
}, res.ids);
check("attacker resolves from the actor id when no token id is carried", byActorId.id === byActorId.want, JSON.stringify(byActorId));

/* f. setting ON but nothing on the segment: the dialog opens in manual mode */
await page.evaluate(async ({ sceneId, onZoneId, wCrossId }) => {
  const scene = game.scenes.get(sceneId);
  await scene.regions.get(onZoneId)?.delete();
  if (scene.walls.get(wCrossId)) await scene.deleteEmbeddedDocuments("Wall", [wCrossId]);
}, res.ids);
await openDialog();
dlg = await readDialog();
check("nothing on the segment: no row preselected", dlg.sel === "", JSON.stringify(dlg));
check("nothing on the segment: Cover SP stays 0", dlg.sp === "0", String(dlg.sp));
check("nothing on the segment: the off-segment row is still offered", dlg.optCount === 2, `options ${dlg.optCount}`);

/* ═══════════════════════════════ cleanup + rig hygiene ═══════════════════════════════ */
await setAuto(false);
const restored = await page.evaluate(() => game.settings.get("cp2020-augmented", "autoCoverDetection"));
check("auto-detect setting restored to the default", restored === false, String(restored));

await page.evaluate(async ({ sceneId, onZoneId, offZoneId, aTokId, tTokId, shooterId, victimId }) => {
  const SCOPE = "cp2020-augmented";
  for (const app of [...foundry.applications.instances.values()]) {
    if (app.constructor?.name === "DamageDialog") await app.close().catch(() => {});
  }
  const scene = game.scenes.get(sceneId);
  const toks = [aTokId, tTokId].filter(id => scene.tokens.get(id));
  if (toks.length) await scene.deleteEmbeddedDocuments("Token", toks).catch(() => {});
  for (const id of [onZoneId, offZoneId]) await scene.regions.get(id)?.delete().catch(() => {});
  for (const r of [...scene.regions]) if (r.name?.startsWith("__PWX__")) await r.delete().catch(() => {});
  const walls = [...scene.walls].filter(w => w.flags?.[SCOPE]?.__pwx === true).map(w => w.id);
  if (walls.length) await scene.deleteEmbeddedDocuments("Wall", walls).catch(() => {});
  for (const id of [shooterId, victimId]) await game.actors.get(id)?.delete().catch(() => {});
  for (const a of [...game.actors]) if (a.name?.startsWith("__PWX__")) await a.delete().catch(() => {});
  for (const m of game.messages.filter(x => x.content.includes("__PWX__") || x.content.includes("cp-cover-chew"))) await m.delete().catch(() => {});
}, res.ids).catch(e => console.log(`  (cleanup warning: ${e.message})`));

const leftovers = await page.evaluate(({ sceneId }) => {
  const SCOPE = "cp2020-augmented";
  const scene = game.scenes.get(sceneId);
  return {
    regions: [...scene.regions].filter(r => r.name?.startsWith("__PWX__")).length,
    walls: [...scene.walls].filter(w => w.flags?.[SCOPE]?.__pwx === true).length,
    tokens: [...scene.tokens].filter(t => t.name?.startsWith("__PWX__")).length,
    actors: game.actors.filter(a => a.name?.startsWith("__PWX__")).length,
  };
}, res.ids);
check("fixtures fully swept from the rig", Object.values(leftovers).every(v => v === 0), JSON.stringify(leftovers));

check("0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
