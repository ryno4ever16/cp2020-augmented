/**
 * ACPA PILOT AT WORLD LOAD (user report, Conni, 2026-09-27 - root-caused with her exports).
 *
 * A suit's derived data (effective REF, Run, jumps, PA Combat Sense) reads its linked pilot through
 * `game.actors.get(pilotId)` inside prepareDerivedData. At world load the actors are constructed one
 * by one, and a suit that comes BEFORE its pilot in that order is prepared while the pilot does not
 * exist yet: it reads no REF (the manual fallback shows), MA 0, Run = SIB x 3. Nothing re-derived it
 * afterwards - the pilot-update hook fires only on updates - so the sheet showed the wrong numbers on
 * every client until someone re-picked the pilot. Every earlier probe had the pilot sorting first.
 *
 * Legs (two sessions: the GM reloads the world; a player joins fresh):
 *   A. fixture guard - the suit really is ahead of its pilot in the collection after the reload
 *   B. GM client after a full reload: the suit reads the pilot (Run = (SIB + MA) x 3, effective REF from
 *      the pilot, not the manual field), and the SHEET shows that Run
 *   C. control: the pair in the other order reads the same numbers (the fix is not order-specific)
 *   D. negative: a suit with NO pilot still runs at SIB x 3 with the manual REF (no phantom pilot)
 *   E. player client, fresh join: the suit-first pair reads the pilot there too (derived data is per
 *      client, so the repair has to run on every client)
 * Wording rule: legs are named after the mechanism (load order, re-derivation), not the fiction.
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function join(page, match, pw) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]'); await sel.waitFor({ state: "visible", timeout: 30000 });
  const users = await sel.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  await sel.selectOption(users.find(x => match.test(x.l)).v);
  await page.locator('input[name="password"]').fill(pw);
  await Promise.all([page.waitForNavigation({ url: /\/game/, timeout: 45000 }).catch(() => {}), page.locator('button[name="join"]').click()]);
  await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60000 });
}
const PREFIX = "__PW__PLO";
const MA = 11, REF = 8;

const browser = await chromium.launch({ headless: true });
const gm = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const errors = []; gm.on("pageerror", e => errors.push(String(e))); gm.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await join(gm, /^gamemaster$/i, PW);

const ids = await gm.evaluate(async ({ PREFIX, MA, REF }) => {
  for (const a of game.actors.filter(a => a.name?.startsWith(PREFIX))) await a.delete().catch(() => {});
  const player = game.users.find(u => !u.isGM && /test user 1/i.test(u.name));
  const own = { default: 0, [player.id]: 3 };
  const mkP = async (name) => { const p = await Actor.create({ name, type: "character", ownership: own }); await p.update({ "system.stats.ma.base": MA, "system.stats.ref.base": REF }); return p; };
  const mkS = (name, pilotId) => Actor.create({ name, type: "cp2020-augmented.vehicle", ownership: own, system: { isACPA: true, vehicleType: "acpa", pilotId, pilotRef: 3 } });
  // suit-first pair: the suit's name sorts before its pilot's
  const p1 = await mkP(`${PREFIX} Zeta Pilot`); const s1 = await mkS(`${PREFIX} Alpha Suit`, p1.id);
  // control pair: pilot first
  const p2 = await mkP(`${PREFIX} Alpha Pilot`); const s2 = await mkS(`${PREFIX} Zeta Suit`, p2.id);
  // negative: no pilot at all
  const s0 = await mkS(`${PREFIX} Empty Suit`, "");
  return { s1: s1.id, p1: p1.id, s2: s2.id, p2: p2.id, s0: s0.id };
}, { PREFIX, MA, REF });

await gm.reload({ waitUntil: "domcontentloaded" });
await gm.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60000 });
const readAll = async (page) => page.evaluate(async ({ ids, MA }) => {
  const keys = [...game.actors.keys()]; const pos = (id) => keys.indexOf(id);
  const read = (id) => { const s = game.actors.get(id); return { runM: s.system.runM, sib: s.system.sib, effectiveRef: s.system.effectiveRef, expectRun: (Number(s.system.sib) + MA) * 3 }; };
  const sheetRun = async (id) => {
    const s = game.actors.get(id); await s.sheet.render(true);
    let v = null; for (let i = 0; i < 20 && v === null; i++) { await new Promise(r => setTimeout(r, 150)); v = [...(s.sheet.element?.querySelectorAll(".field") ?? [])].find(f => /Run \(m/.test(f.textContent))?.querySelector("input")?.value ?? null; }
    await s.sheet.close().catch(() => {}); return v;
  };
  return {
    order: { suitFirstPair: pos(ids.s1) < pos(ids.p1), controlPilotFirst: pos(ids.p2) < pos(ids.s2) },
    suitFirst: { ...read(ids.s1), sheetRun: await sheetRun(ids.s1) },
    control: { ...read(ids.s2), sheetRun: await sheetRun(ids.s2) },
    empty: read(ids.s0),
  };
}, { ids, MA });
const gmRead = await readAll(gm);

const pl = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
await join(pl, /test user 1/i, "");
const plRead = await readAll(pl);

await gm.evaluate(async ({ PREFIX }) => { for (const a of game.actors.filter(a => a.name?.startsWith(PREFIX))) await a.delete().catch(() => {}); }, { PREFIX });

const legs = [];
const ok = (name, cond, got) => legs.push([name, !!cond, got]);
ok("A fixture guard: after the reload the suit-first pair really is suit-before-pilot in the collection, and the control pair pilot-before-suit", gmRead.order.suitFirstPair === true && gmRead.order.controlPilotFirst === true, JSON.stringify(gmRead.order));
ok("B GM after reload: the suit prepared before its pilot still reads the pilot - Run = (SIB + MA) x 3", gmRead.suitFirst.runM === gmRead.suitFirst.expectRun && gmRead.suitFirst.runM > gmRead.suitFirst.sib * 3, JSON.stringify(gmRead.suitFirst));
ok("B GM after reload: its effective REF comes from the pilot (8), not the manual field (3)", gmRead.suitFirst.effectiveRef === REF, JSON.stringify(gmRead.suitFirst));
ok("B GM after reload: the SHEET shows that Run", String(gmRead.suitFirst.sheetRun) === String(gmRead.suitFirst.expectRun), JSON.stringify(gmRead.suitFirst));
ok("C control: the pilot-first pair reads the same numbers", gmRead.control.runM === gmRead.control.expectRun && gmRead.control.effectiveRef === REF && String(gmRead.control.sheetRun) === String(gmRead.control.expectRun), JSON.stringify(gmRead.control));
ok("D negative: a suit with no pilot runs at SIB x 3 with the manual REF - no phantom pilot", gmRead.empty.runM === gmRead.empty.sib * 3 && gmRead.empty.effectiveRef === 3, JSON.stringify(gmRead.empty));
ok("E player fresh join: the suit-first pair reads the pilot on the player's client too", plRead.suitFirst.runM === plRead.suitFirst.expectRun && plRead.suitFirst.effectiveRef === REF && String(plRead.suitFirst.sheetRun) === String(plRead.suitFirst.expectRun), JSON.stringify(plRead.suitFirst));
ok("E player fresh join: the control pair and the empty suit read as on the GM", plRead.control.runM === plRead.control.expectRun && plRead.empty.runM === plRead.empty.sib * 3, JSON.stringify({ control: plRead.control, empty: plRead.empty }));
ok("0 console errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
let fail = 0;
for (const [n, pass, got] of legs) { if (!pass) fail++; console.log(`${pass ? "PASS" : "FAIL"}  ${n}${pass ? "" : `   [got: ${got}]`}`); }
console.log(`\n${legs.length - fail}/${legs.length} checks passed`);
await browser.close();
process.exit(fail ? 1 : 0);
