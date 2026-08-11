/**
 * KEEPER: cover zones Unit 1 (behavior + presets + placement + chew lifecycle).
 *  - behavior type registered (two-part manifest registration) + TYPES label resolves
 *  - COVER_PRESETS match the Core "Common Cover SPs" table (text-layer values)
 *  - placeCoverZone creates a region: behavior prefilled (pool = 3xSP), ALWAYS visible, amber
 *  - chewCoverZone: exact pool debit, band recolor (amber->orange->gray), destroyed flip at 0,
 *    chat card per chew, destroyed card, idempotent on already-destroyed (no extra card)
 *  - coverChoicesFor sorts by distance to the target token
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

const res = await page.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  const out = { checks: [] };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });

  if (!game.scenes.active) await (game.scenes.getName("Foundry Virtual Tabletop") ?? game.scenes.contents[0])?.activate();
  const scene = game.scenes.active;

  // stale cleanup
  for (const r of [...(scene?.regions ?? [])]) if (r.name?.startsWith("__PWK__")) await r.delete();

  const cov = await import(`/modules/${SCOPE}/module/combat/cover.js`);
  const beh = await import(`/modules/${SCOPE}/module/combat/cover-zone-behavior.js`);

  // 1. registration (manifest + CONFIG)
  ok("behavior type in CONFIG.dataModels", !!CONFIG.RegionBehavior.dataModels[beh.COVER_ZONE_BEHAVIOR]);
  ok("TYPES label resolves", game.i18n.localize(`TYPES.RegionBehavior.${beh.COVER_ZONE_BEHAVIOR}`) === "Cover");

  // 2. presets vs the book table (spot-check every band)
  const P = Object.fromEntries(cov.COVER_PRESETS.map(p => [p.label, p.sp]));
  ok("preset count 17", cov.COVER_PRESETS.length === 17, cov.COVER_PRESETS.length);
  ok("Sheetrock Wall 5", P["Sheetrock Wall"] === 5);
  ok("Concrete Block Wall 10", P["Concrete Block Wall"] === 10);
  ok("Heavy Wood Door 15", P["Heavy Wood Door"] === 15);
  ok("Steel Door 20", P["Steel Door"] === 20);
  ok("Brick Wall 25 / Curb 25", P["Brick Wall"] === 25 && P["Curb"] === 25);
  ok("Stone Wall 30 / Tree 30", P["Stone Wall"] === 30 && P["Tree, Phone Pole"] === 30);
  ok("Concrete Utility Pole 35 / Hydrant 35", P["Concrete Utility Pole"] === 35 && P["Hydrant"] === 35);
  ok("Armored Car Body 40 / AV-4 Body 40", P["Armored Car Body"] === 40 && P["AV-4 Body"] === 40);

  // 3. placement
  const region = await cov.placeCoverZone({ scene, label: "__PWK__Brick", sp: 25 });
  ok("placement creates region", !!region, region?.name);
  const b = region?.behaviors?.find(x => x.type === beh.COVER_ZONE_BEHAVIOR);
  ok("behavior prefilled sp 25", b?.system?.sp === 25);
  ok("pool seeds 3xSP = 75", b?.system?.pool === 75 && b?.system?.poolMax === 75, `${b?.system?.pool}/${b?.system?.poolMax}`);
  ok("visibility ALWAYS", region?.visibility === (CONST?.REGION_VISIBILITY?.ALWAYS ?? 2), String(region?.visibility));
  ok("intact color amber", region?.color?.css?.toLowerCase?.() === "#d1a054" || String(region?.color).toLowerCase() === "#d1a054", String(region?.color?.css ?? region?.color));

  // 4. chew lifecycle — exact values
  const msgIds = new Set(game.messages.map(m => m.id));
  const newCards = () => game.messages.filter(m => !msgIds.has(m.id) && (m.content.includes("cp-cover-chew")));

  let r1 = await cov.chewCoverZone({ behaviorUuid: b.uuid, damage: 20, weaponName: "Keeper Gun" });
  ok("chew 20: pool 55", r1?.pool === 55 && r1?.destroyed === false, JSON.stringify(r1));
  ok("still amber above 2/3", String(region.color?.css ?? region.color).toLowerCase() === "#d1a054");
  let r2 = await cov.chewCoverZone({ behaviorUuid: b.uuid, damage: 20 });
  ok("chew 20: pool 35 + orange band", r2?.pool === 35 && String(region.color?.css ?? region.color).toLowerCase() === "#cc5500", `${r2?.pool} ${region.color?.css ?? region.color}`);
  let r3 = await cov.chewCoverZone({ behaviorUuid: b.uuid, damage: 50 });
  ok("chew 50: destroyed at 0", r3?.pool === 0 && r3?.destroyed === true, JSON.stringify(r3));
  ok("destroyed color gray", String(region.color?.css ?? region.color).toLowerCase() === "#555555");
  ok("behavior flags destroyed", b.system.destroyed === true && b.system.pool === 0);
  ok("sp unchanged through chew (book rule)", b.system.sp === 25);
  await new Promise(r => setTimeout(r, 400));
  const cards = newCards();
  ok("three chew cards posted", cards.length === 3, String(cards.length));
  ok("last card is the destroyed card", /destroyed/i.test(cards.at(-1)?.content ?? ""));
  const r4 = await cov.chewCoverZone({ behaviorUuid: b.uuid, damage: 10 });
  ok("already-destroyed chew is a no-op", r4?.already === true && newCards().length === 3);

  // 5. choices sorting by distance
  const far = await cov.placeCoverZone({ scene, label: "__PWK__Far", sp: 5 });
  await far.update({ shapes: [{ type: "rectangle", x: 100, y: 100, width: 100, height: 100, rotation: 0 }] });
  const near = await cov.placeCoverZone({ scene, label: "__PWK__Near", sp: 10 });
  await near.update({ shapes: [{ type: "rectangle", x: 2000, y: 1000, width: 100, height: 100, rotation: 0 }] });
  const actor = await Actor.create({ name: "__PWK__Target", type: "character" });
  const [tok] = await scene.createEmbeddedDocuments("Token", [{ name: actor.name, actorId: actor.id, x: 2100, y: 1100, width: 1, height: 1 }]);
  const choices = cov.coverChoicesFor(tok).filter(c => c.label.startsWith("__PWK__"));
  ok("choices sorted nearest-first", choices[0]?.label === "__PWK__Near", choices.map(c => c.label).join(","));

  // cleanup
  await scene.deleteEmbeddedDocuments("Token", [tok.id]);
  await actor.delete();
  for (const r of [region, far, near]) await r?.delete?.();
  for (const m of newCards()) await m.delete();

  return out;
});

for (const c of res.checks) check(c.n, c.p, c.d);
check("0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
