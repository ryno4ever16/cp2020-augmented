/**
 * KEEPER: cover Unit 3 — native Wall documents carrying cover data.
 *  - coverWallsOn: unflagged walls excluded; SP-only wall reads the 3xSP structure default;
 *    explicit structure numbers respected; material label wins, else the localized wall/door fallback
 *  - coverChoicesFor merges wall rows with zone rows and sorts nearest-first (every row carries a uuid)
 *  - chewCoverWall: exact structure debit, chat card per debit, destroyed flip at 0,
 *    door-state flip to open at zero structure (non-door walls leave door state untouched),
 *    idempotent on an already-destroyed wall (no extra card)
 *  - chewCover dispatcher routes a Wall uuid to the wall branch and a behavior uuid to the zone branch
 *  - the native wall configuration sheet carries the four injected fields, the SP->structure
 *    pre-fill fires on a real change event, and the sheet's own submit persists the flags
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

/* ─────────────────────── phase 1: pure engine (rows, sorting, debit lifecycle) ─────────────────────── */
const res = await page.evaluate(async (SCOPE) => {
  const out = { checks: [], ids: {} };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });

  if (!game.scenes.active) await (game.scenes.getName("Foundry Virtual Tabletop") ?? game.scenes.contents[0])?.activate();
  const scene = game.scenes.active;
  out.ids.sceneId = scene.id;

  // stale cleanup from any interrupted run
  const staleWalls = [...scene.walls].filter(w => w.flags?.[SCOPE]?.__pwk === true).map(w => w.id);
  if (staleWalls.length) await scene.deleteEmbeddedDocuments("Wall", staleWalls);
  for (const r of [...scene.regions]) if (r.name?.startsWith("__PWX__")) await r.delete();
  for (const a of [...game.actors]) if (a.name?.startsWith("__PWX__")) await a.delete();

  const cov = await import(`/modules/${SCOPE}/module/combat/cover.js`);
  const mkWall = async (data) => {
    const [w] = await scene.createEmbeddedDocuments("Wall", [{
      ...data,
      flags: { [SCOPE]: { __pwk: true, ...(data.flags?.[SCOPE] ?? {}) } },
    }]);
    return w;
  };
  const rowFor = (uuid) => cov.coverWallsOn(scene).find(r => r.uuid === uuid);

  /* a. an unflagged wall is not a cover row */
  const wPlain = await mkWall({ c: [2000, 1000, 2200, 1000] });
  ok("unflagged wall absent from wall rows", !rowFor(wPlain.uuid));

  /* b. SP-only wall floats on the 3xSP structure default */
  const wDefault = await mkWall({ c: [2000, 1040, 2200, 1040], flags: { [SCOPE]: { coverSp: 10 } } });
  const rDefault = rowFor(wDefault.uuid);
  ok("SP-only wall: sp 10", rDefault?.sp === 10, String(rDefault?.sp));
  ok("SP-only wall: structure default 30/30", rDefault?.pool === 30 && rDefault?.poolMax === 30, `${rDefault?.pool}/${rDefault?.poolMax}`);
  ok("SP-only wall: not destroyed", rDefault?.destroyed === false, String(rDefault?.destroyed));
  ok("SP-only wall: localized fallback label", rDefault?.label === "Wall", String(rDefault?.label));
  ok("fallback label carries no raw key text", !/CYBERPUNK\./.test(String(rDefault?.label)));

  /* c. explicit structure numbers respected; material wins the label; door fallback label */
  const wExplicit = await mkWall({ c: [2000, 1080, 2200, 1080], flags: { [SCOPE]: { coverSp: 10, coverPool: 12, coverPoolMax: 40, coverMaterial: "__PWX__Barrier" } } });
  const rExplicit = rowFor(wExplicit.uuid);
  ok("explicit structure numbers respected 12/40", rExplicit?.pool === 12 && rExplicit?.poolMax === 40, `${rExplicit?.pool}/${rExplicit?.poolMax}`);
  ok("explicit row keeps sp 10 (structure independent of SP)", rExplicit?.sp === 10, String(rExplicit?.sp));
  ok("material string wins the label", rExplicit?.label === "__PWX__Barrier", String(rExplicit?.label));
  const wDoorLabel = await mkWall({ c: [2000, 1120, 2200, 1120], door: 1, ds: 0, flags: { [SCOPE]: { coverSp: 5 } } });
  const rDoorLabel = rowFor(wDoorLabel.uuid);
  ok("door wall flagged isDoor", rDoorLabel?.isDoor === true, String(rDoorLabel?.isDoor));
  ok("door fallback label", rDoorLabel?.label === "Door", String(rDoorLabel?.label));
  ok("door structure default 15/15", rDoorLabel?.pool === 15 && rDoorLabel?.poolMax === 15, `${rDoorLabel?.pool}/${rDoorLabel?.poolMax}`);

  /* d. picker rows merge zones + walls, nearest-first */
  const farZone = await cov.placeCoverZone({ scene, label: "__PWX__FarZone", sp: 5 });
  await farZone.update({ shapes: [{ type: "rectangle", x: 100, y: 100, width: 100, height: 100, rotation: 0 }] });
  const wNear = await mkWall({ c: [2100, 1200, 2300, 1200], flags: { [SCOPE]: { coverSp: 10, coverMaterial: "__PWX__NearWall" } } });
  const actor = await Actor.create({ name: "__PWX__Probe", type: "character" });
  const [tok] = await scene.createEmbeddedDocuments("Token", [{ name: actor.name, actorId: actor.id, x: 2100, y: 1100, width: 1, height: 1 }]);
  const mine = cov.coverChoicesFor(tok).filter(c => c.label === "__PWX__NearWall" || c.label === "__PWX__FarZone");
  ok("picker rows merge wall + zone", mine.length === 2, mine.map(c => c.label).join(","));
  ok("picker rows sorted nearest-first", mine[0]?.label === "__PWX__NearWall" && mine[1]?.label === "__PWX__FarZone", mine.map(c => c.label).join(","));
  ok("wall row carries a Wall uuid", /\.Wall\./.test(String(mine[0]?.uuid)), String(mine[0]?.uuid));
  ok("zone row carries a RegionBehavior uuid", /RegionBehavior/.test(String(mine[1]?.uuid)), String(mine[1]?.uuid));

  /* e/f. debit lifecycle on a NON-door wall */
  const msgIds = new Set(game.messages.map(m => m.id));
  const newCards = () => game.messages.filter(m => !msgIds.has(m.id) && m.content.includes("cp-cover-chew"));

  const wChew = await mkWall({ c: [2000, 1160, 2200, 1160], flags: { [SCOPE]: { coverSp: 10, coverMaterial: "__PWX__ChewWall" } } });
  const c1 = await cov.chewCoverWall({ wallUuid: wChew.uuid, damage: 14, weaponName: "__PWX__Source" });
  ok("structure debit exact: 30 -> 16", c1?.pool === 16 && c1?.destroyed === false, JSON.stringify(c1));
  ok("debit persisted to wall flags", wChew.flags?.[SCOPE]?.coverPool === 16 && wChew.flags?.[SCOPE]?.coverPoolMax === 30, JSON.stringify(wChew.flags?.[SCOPE]));
  await new Promise(r => setTimeout(r, 400));
  let cards = newCards();
  ok("one debit card posted", cards.length === 1, String(cards.length));
  ok("card names the object and the amount", (cards[0]?.content ?? "").includes("__PWX__ChewWall") && (cards[0]?.content ?? "").includes("14"));

  const c2 = await cov.chewCoverWall({ wallUuid: wChew.uuid, damage: 16 });
  ok("debit to zero flips destroyed", c2?.pool === 0 && c2?.destroyed === true, JSON.stringify(c2));
  ok("non-door wall keeps its door state", (wChew._source?.ds ?? wChew.ds) === 0, String(wChew._source?.ds ?? wChew.ds));
  ok("non-door wall stays a non-door", (wChew._source?.door ?? wChew.door) === 0, String(wChew._source?.door ?? wChew.door));
  await new Promise(r => setTimeout(r, 400));
  cards = newCards();
  ok("second card posted", cards.length === 2, String(cards.length));
  ok("destroyed card carries the destroyed line", /is destroyed/i.test(cards[1]?.content ?? ""), (cards[1]?.content ?? "").slice(0, 200));
  ok("destroyed card is NOT the door-opened line", !/broken open/i.test(cards[1]?.content ?? ""));

  const c3 = await cov.chewCoverWall({ wallUuid: wChew.uuid, damage: 10 });
  await new Promise(r => setTimeout(r, 400));
  ok("further debit on a destroyed wall is a no-op", c3?.already === true && c3?.pool === 0, JSON.stringify(c3));
  ok("no extra card for the no-op", newCards().length === 2, String(newCards().length));

  /* g. DOOR wall broken open at zero structure */
  const wDoor = await mkWall({ c: [2000, 1240, 2200, 1240], door: 1, ds: 0, flags: { [SCOPE]: { coverSp: 5, coverMaterial: "__PWX__ChewDoor" } } });
  ok("door starts closed", (wDoor._source?.ds ?? wDoor.ds) === 0, String(wDoor._source?.ds ?? wDoor.ds));
  const d1 = await cov.chewCoverWall({ wallUuid: wDoor.uuid, damage: 15 });
  ok("door structure debit to zero flips destroyed", d1?.pool === 0 && d1?.destroyed === true, JSON.stringify(d1));
  ok("door state flips to open at zero structure", (wDoor._source?.ds ?? wDoor.ds) === (CONST?.WALL_DOOR_STATES?.OPEN ?? 1), String(wDoor._source?.ds ?? wDoor.ds));
  await new Promise(r => setTimeout(r, 400));
  cards = newCards();
  ok("door card posted", cards.length === 3, String(cards.length));
  ok("door card carries the broken-open line", /broken open/i.test(cards[2]?.content ?? ""), (cards[2]?.content ?? "").slice(0, 200));

  /* partial door debit does NOT open it (negative case) */
  const wDoor2 = await mkWall({ c: [2000, 1280, 2200, 1280], door: 1, ds: 0, flags: { [SCOPE]: { coverSp: 10, coverMaterial: "__PWX__PartialDoor" } } });
  const d2 = await cov.chewCoverWall({ wallUuid: wDoor2.uuid, damage: 5 });
  ok("partial door debit: 30 -> 25, not destroyed", d2?.pool === 25 && d2?.destroyed === false, JSON.stringify(d2));
  ok("partial door stays closed", (wDoor2._source?.ds ?? wDoor2.ds) === 0, String(wDoor2._source?.ds ?? wDoor2.ds));

  /* h. dispatcher routes by resolved document type */
  const wDisp = await mkWall({ c: [2000, 1320, 2200, 1320], flags: { [SCOPE]: { coverSp: 10, coverMaterial: "__PWX__DispatchWall" } } });
  const h1 = await cov.chewCover({ uuid: wDisp.uuid, damage: 5, weaponName: "__PWX__Source" });
  ok("dispatcher debits a wall uuid: 30 -> 25", h1?.pool === 25 && h1?.destroyed === false, JSON.stringify(h1));
  ok("dispatcher wall write persisted", wDisp.flags?.[SCOPE]?.coverPool === 25, String(wDisp.flags?.[SCOPE]?.coverPool));
  const dispZone = await cov.placeCoverZone({ scene, label: "__PWX__DispatchZone", sp: 5 });
  const dispBeh = dispZone.behaviors.find(b => b.type === `${SCOPE}.coverZone`);
  ok("dispatch zone seeded 15/15", dispBeh?.system?.pool === 15 && dispBeh?.system?.poolMax === 15, `${dispBeh?.system?.pool}/${dispBeh?.system?.poolMax}`);
  const h2 = await cov.chewCover({ behaviorUuid: dispBeh.uuid, damage: 5 });
  ok("dispatcher debits a behavior uuid: 15 -> 10", h2?.pool === 10 && h2?.destroyed === false, JSON.stringify(h2));
  ok("dispatcher zone write persisted", dispBeh.system.pool === 10, String(dispBeh.system.pool));
  const h3 = await cov.chewCover({ uuid: "" });
  ok("dispatcher rejects an empty uuid", h3 === null, String(h3));
  const h4 = await cov.chewCoverWall({ wallUuid: wPlain.uuid, damage: 5 });
  ok("debit on an unflagged wall returns null", h4 === null, String(h4));

  /* the wall used by the configuration-sheet phase stays flag-free until the sheet writes it */
  const wCfg = await mkWall({ c: [2000, 1360, 2200, 1360] });

  out.ids.wallIds = [wPlain, wDefault, wExplicit, wDoorLabel, wNear, wChew, wDoor, wDoor2, wDisp, wCfg].map(w => w.id);
  out.ids.cfgWallId = wCfg.id;
  out.ids.regionIds = [farZone.id, dispZone.id];
  out.ids.actorId = actor.id;
  out.ids.tokenId = tok.id;
  out.ids.msgIdsBefore = [...msgIds];
  return out;
}, SCOPE);

for (const c of res.checks) check(c.n, c.p, c.d);

/* ─────────────────── phase 2: the native wall configuration sheet (real DOM) ─────────────────── */
const appId = await page.evaluate(async ({ sceneId, cfgWallId }) => {
  const wall = game.scenes.get(sceneId).walls.get(cfgWallId);
  const app = wall.sheet;
  await app.render(true);
  await new Promise(r => setTimeout(r, 800));
  return app.element?.id ?? app.id ?? null;
}, res.ids);

let fieldsetSeen = true;
try {
  await page.waitForSelector(".cp-cover-wall-fields", { timeout: 10000 });
} catch { fieldsetSeen = false; }
check("wall configuration sheet carries the injected fieldset", fieldsetSeen, String(appId));

if (fieldsetSeen) {
  const dom = await page.evaluate((SCOPE) => {
    const fs = document.querySelector(".cp-cover-wall-fields");
    const names = [...fs.querySelectorAll("input")].map(i => i.getAttribute("name"));
    return { names, text: fs.textContent, inForm: !!fs.closest("form") };
  }, SCOPE);
  const want = ["coverSp", "coverPool", "coverPoolMax", "coverMaterial"].map(k => `flags.${SCOPE}.${k}`);
  check("four flag-named inputs present", want.every(n => dom.names.includes(n)), dom.names.join(","));
  check("fieldset sits inside the sheet's own form", dom.inForm === true);
  check("no raw key text leaks into the fieldset", !/CYBERPUNK\./.test(dom.text), dom.text.slice(0, 120));

  // SP -> structure pre-fill fires on a REAL change event
  await page.evaluate((SCOPE) => {
    const sp = document.querySelector(`.cp-cover-wall-fields input[name="flags.${SCOPE}.coverSp"]`);
    sp.value = "20";
    sp.dispatchEvent(new Event("change", { bubbles: true }));
  }, SCOPE);
  await page.waitForTimeout(300);
  const filled = await page.evaluate((SCOPE) => {
    const q = k => document.querySelector(`.cp-cover-wall-fields input[name="flags.${SCOPE}.${k}"]`)?.value;
    return { pool: q("coverPool"), poolMax: q("coverPoolMax") };
  }, SCOPE);
  check("SP edit pre-fills empty structure fields with 3xSP", filled.pool === "60" && filled.poolMax === "60", JSON.stringify(filled));

  // the sheet's OWN submit persists the flags
  await page.evaluate((SCOPE) => {
    const m = document.querySelector(`.cp-cover-wall-fields input[name="flags.${SCOPE}.coverMaterial"]`);
    m.value = "__PWX__CfgWall";
    m.dispatchEvent(new Event("change", { bubbles: true }));
  }, SCOPE);

  let submitted = false;
  try {
    const btn = page.locator(`#${appId} button[type="submit"]`).first();
    await btn.click({ timeout: 5000 });
    submitted = true;
  } catch { submitted = false; }

  const persisted = await page.evaluate(async ({ sceneId, cfgWallId }) => {
    const scope = "cp2020-augmented";
    for (let i = 0; i < 30; i++) {
      const f = game.scenes.get(sceneId).walls.get(cfgWallId)?.flags?.[scope] ?? {};
      if (f.coverSp === 20) return { sp: f.coverSp, pool: f.coverPool, poolMax: f.coverPoolMax, material: f.coverMaterial };
      await new Promise(r => setTimeout(r, 200));
    }
    const f = game.scenes.get(sceneId).walls.get(cfgWallId)?.flags?.[scope] ?? {};
    return { timeout: true, sp: f.coverSp, pool: f.coverPool, poolMax: f.coverPoolMax, material: f.coverMaterial };
  }, res.ids);

  if (!submitted || persisted.timeout) {
    check("sheet submit persists the cover flags [PARKED — submit path did not land headless]", false, `submitted=${submitted} ${JSON.stringify(persisted)}`);
  } else {
    check("sheet submit persists the cover flags", persisted.sp === 20 && persisted.pool === 60 && persisted.poolMax === 60 && persisted.material === "__PWX__CfgWall", JSON.stringify(persisted));
    const row = await page.evaluate(({ sceneId, cfgWallId }) => import("/modules/cp2020-augmented/module/combat/cover.js").then(cov => {
      const scene = game.scenes.get(sceneId);
      const w = scene.walls.get(cfgWallId);
      const r = cov.coverWallsOn(scene).find(x => x.uuid === w.uuid);
      return r ? { label: r.label, sp: r.sp, pool: r.pool, poolMax: r.poolMax, destroyed: r.destroyed } : null;
    }), res.ids);
    check("sheet-authored wall becomes a cover row", row?.sp === 20 && row?.pool === 60 && row?.poolMax === 60 && row?.label === "__PWX__CfgWall" && row?.destroyed === false, JSON.stringify(row));
  }
}

/* ───────────────────────────────────── cleanup ───────────────────────────────────── */
await page.evaluate(async ({ sceneId, wallIds, regionIds, actorId, tokenId, msgIdsBefore }) => {
  const scene = game.scenes.get(sceneId);
  for (const app of [...foundry.applications.instances.values()]) {
    if (app.constructor?.name === "WallConfig") await app.close().catch(() => {});
  }
  if (scene.tokens.get(tokenId)) await scene.deleteEmbeddedDocuments("Token", [tokenId]).catch(() => {});
  await game.actors.get(actorId)?.delete().catch(() => {});
  const live = wallIds.filter(id => scene.walls.get(id));
  if (live.length) await scene.deleteEmbeddedDocuments("Wall", live).catch(() => {});
  const leftover = [...scene.walls].filter(w => w.flags?.["cp2020-augmented"]?.__pwk === true).map(w => w.id);
  if (leftover.length) await scene.deleteEmbeddedDocuments("Wall", leftover).catch(() => {});
  for (const id of regionIds) await scene.regions.get(id)?.delete().catch(() => {});
  const before = new Set(msgIdsBefore);
  for (const m of game.messages.filter(x => !before.has(x.id) && (x.content.includes("cp-cover-chew") || x.content.includes("__PWX__")))) {
    await m.delete().catch(() => {});
  }
}, res.ids).catch(e => console.log(`  (cleanup warning: ${e.message})`));

check("0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
