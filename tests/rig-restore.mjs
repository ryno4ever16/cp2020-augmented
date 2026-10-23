// RIG TOOL (not a keeper; run by hand): repair :30004 after a KILLED keeper skipped its cleanup — the fumble table back on,
// stray fixtures swept, the bench scene reported. Prints what it found and what it changed.
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const b = await chromium.launch({ headless: true });
const page = await (await b.newContext()).newPage();
await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
const s = page.locator('select[name="userid"]'); await s.waitFor({ state: "visible", timeout: 60000 });
const us = await s.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
await s.selectOption(us.find(x => /gamemaster/i.test(x.l)).v);
await page.locator('input[name="password"]').fill(PW);
await Promise.all([page.waitForNavigation({ url: /\/game/, timeout: 30000 }).catch(() => {}), page.locator('button[name="join"]').click()]);
await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 90000 });
const out = await page.evaluate(async () => {
  const r = { before: {}, swept: {} };
  r.before.fumble = game.settings.get("cyberpunk2020", "fumbleTableEnabled");
  if (r.before.fumble !== true) await game.settings.set("cyberpunk2020", "fumbleTableEnabled", true);
  r.after = { fumble: game.settings.get("cyberpunk2020", "fumbleTableEnabled") };
  const stray = /^(__PW__|__PROBE__|__GYM__|__PWX__)/;
  const combats = game.combats.filter(c => c.combatants.some(x => stray.test(x.name ?? "")));
  for (const c of combats) await c.delete().catch(() => {});
  let tokens = 0;
  for (const sc of game.scenes) { const ids = sc.tokens.filter(t => stray.test(t.name ?? "")).map(t => t.id); if (ids.length) { await sc.deleteEmbeddedDocuments("Token", ids).catch(() => {}); tokens += ids.length; } }
  const actors = game.actors.filter(a => stray.test(a.name ?? ""));
  for (const a of actors) await a.delete().catch(() => {});
  const items = game.items.filter(i => stray.test(i.name ?? ""));
  for (const i of items) await i.delete().catch(() => {});
  const scenes = game.scenes.filter(sc => stray.test(sc.name ?? ""));
  for (const sc of scenes) await sc.delete().catch(() => {});
  r.swept = { combats: combats.length, tokens, actors: actors.length, items: items.length, scenes: scenes.length };
  r.activeScene = game.scenes.active?.name ?? null;
  return r;
});
console.log(JSON.stringify(out));
await b.close();
