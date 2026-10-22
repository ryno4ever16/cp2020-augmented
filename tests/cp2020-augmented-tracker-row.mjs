/** Combat-tracker row geometry under its worst realistic load — a long name on the ACTING row carrying the
 *  module's add-action control, an action-count badge with a penalty, both declared stances, wait and take-aim,
 *  and core's own controls — measured child by child against the row, in the DOCKED sidebar tab and in the
 *  POPPED-OUT tracker window (reported from the table 2026-10-21/22: the initiative control pushed off the row;
 *  the first fix was scoped to the docked tab's id and the popout never got it). Asserts the winning computed
 *  values (the name column's shrink floor, the strip's wrap) and the visible outcome (the initiative control
 *  inside the row) on every row of both. Red-first; wording names mechanisms. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
const errs = []; page.on("pageerror", e => errs.push(e.message)); page.on("console", m => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
const s = page.locator('select[name="userid"]');
await s.waitFor({ state: "visible", timeout: 30000 });
const us = await s.locator("option").evaluateAll((o) => o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
await s.selectOption(us.find((x) => /gamemaster/i.test(x.l)).v);
await page.locator('input[name="password"]').fill(GM_PW);
await Promise.all([page.waitForNavigation({ url: /\/game/, timeout: 20000 }).catch(() => {}), page.locator('button[name="join"]').click()]);
await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60000 });
await page.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 60000 });

const out = await page.evaluate(async () => {
  const SCOPE = "cp2020-augmented"; const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const res = { docked: null, popout: null, ids: null };
  const scene = canvas.scene;
  for (const c of game.combats.filter(c => c.combatants.some(x => /__PW__TR/.test(x.name ?? "")))) await c.delete().catch(() => {});
  for (const t of scene.tokens.filter(t => /__PW__TR/.test(t.name ?? ""))) await t.delete().catch(() => {});
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__TR"))) await a.delete().catch(() => {});
  const names = ["__PW__TR Short", "__PW__TR A Very Long Combatant Name Indeed", "__PW__TR Medium Name"];
  const actors = []; for (const n of names) actors.push(await Actor.create({ name: n, type: "npc" }));
  const toks = await scene.createEmbeddedDocuments("Token", actors.map((a, i) => ({ name: a.name, actorId: a.id, actorLink: true, x: scene.dimensions.sceneX + (4 + i) * scene.grid.size, y: scene.dimensions.sceneY + 4 * scene.grid.size })));
  const combat = await Combat.create({ scene: scene.id, active: true });
  await combat.createEmbeddedDocuments("Combatant", actors.map((a, i) => ({ tokenId: toks.find(t => t.actorId === a.id).id, actorId: a.id, sceneId: scene.id, initiative: i === 1 ? null : 10 - i })));
  await combat.startCombat();
  // the long-named one acts: three actions taken (badge ×3 (−6)), both stances declared, current turn
  await actors[1].setFlag(SCOPE, "actionCount", 3);
  await actors[1].setFlag(SCOPE, "actionCountRound", combat.round);   // the badge reads the count only for the current round
  await actors[1].setFlag(SCOPE, "dodging", true);
  await actors[1].setFlag(SCOPE, "parrying", { object: "rArm" });
  const turnIdx = combat.turns.findIndex(c => c.actorId === actors[1].id);
  if (turnIdx >= 0) await combat.update({ turn: turnIdx });
  const measure = (rootSel) => {
    const root = document.querySelector(rootSel);
    if (!root) return { missing: rootSel, rows: [] };
    const rows = [];
    for (const li of root.querySelectorAll("li.combatant")) {
      const R = li.getBoundingClientRect();
      const nameEl = li.querySelector(".token-name"), menuEl = li.querySelector(".combatant-controls, menu");
      const init = li.querySelector(".token-initiative");
      const ir = init?.getBoundingClientRect();
      rows.push({
        name: nameEl?.querySelector("h4")?.textContent?.trim().slice(0, 40), current: li.classList.contains("active"), rowW: Math.round(R.width),
        nameMinWidth: nameEl ? getComputedStyle(nameEl).minWidth : null, menuWrap: menuEl ? getComputedStyle(menuEl).flexWrap : null,
        menuW: Math.round(menuEl?.getBoundingClientRect().width ?? 0), controls: menuEl ? menuEl.children.length : 0,
        badge: li.querySelector(".cp-action-count-badge")?.textContent ?? null,
        initiative: init ? { right: Math.round(ir.right - R.left), overflow: Math.round(ir.right - R.right), visible: ir.width > 0 && ir.right <= R.right + 1 } : null,
      });
    }
    return { rootClasses: [...root.classList], rootW: Math.round(root.getBoundingClientRect().width), rows };
  };
  ui.sidebar.changeTab("combat", "primary"); await ui.combat.render(true); await sleep(1200);
  res.docked = measure("#combat");
  const pop = await ui.combat.renderPopout(); await sleep(1500);
  res.popout = measure("#combat-popout");
  try { await pop?.close({ animate: false }); } catch (_e) { /* fine */ }
  res.ids = { combat: combat.id, actors: actors.map(a => a.id), toks: toks.map(t => t.id) };
  return res;
});

let fail = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "   [" + detail + "]"}`); if (!ok) fail++; };
for (const where of ["docked", "popout"]) {
  const m = out[where];
  check(`${where}: the tracker root rendered with its rows`, m && !m.missing && m.rows.length === 3, JSON.stringify({ missing: m?.missing, rows: m?.rows?.length }));
  const acting = m?.rows?.find(r => r.current);
  check(`${where}: the acting row carries the full strip (badge + ten controls)`, acting && acting.controls >= 10 && /×3/.test(acting.badge ?? ""), JSON.stringify({ controls: acting?.controls, badge: acting?.badge }));
  check(`${where}: the name column's shrink floor is 0 (the module rule wins)`, m?.rows?.every(r => r.nameMinWidth === "0px"), JSON.stringify(m?.rows?.map(r => r.nameMinWidth)));
  check(`${where}: the control strip wraps (flex-wrap: wrap)`, m?.rows?.every(r => r.menuWrap === "wrap"), JSON.stringify(m?.rows?.map(r => r.menuWrap)));
  check(`${where}: the control strip never outgrows the name column`, m?.rows?.every(r => r.menuW <= r.rowW - 100), JSON.stringify(m?.rows?.map(r => `${r.menuW}/${r.rowW}`)));
  check(`${where}: the initiative control sits inside the row on EVERY row`, m?.rows?.every(r => r.initiative && r.initiative.visible && r.initiative.overflow <= 0), JSON.stringify(m?.rows?.map(r => r.initiative)));
}
await page.evaluate(async (ids) => { await game.combats.get(ids.combat)?.delete().catch(() => {}); await canvas.scene.deleteEmbeddedDocuments("Token", ids.toks.filter(id => canvas.scene.tokens.has(id))).catch(() => {}); for (const id of ids.actors) await game.actors.get(id)?.delete().catch(() => {}); }, out.ids);
check("0 console errors", errs.length === 0, errs.join(" | ").slice(0, 300));
console.log(`\n===== tracker row: ${fail === 0 ? "ALL GREEN" : fail + " RED"} =====`);
await b.close();
process.exit(fail ? 1 : 0);
