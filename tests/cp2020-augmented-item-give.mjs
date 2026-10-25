/** Alt + drop = give (user rulings 2026-10-22/23; item/item-give.js). Core's plain drop stays a copy (negative leg);
 *  Alt on a sheet drop moves the item, unequipped, and posts the hand-over card; Alt on the recipient's TOKEN does
 *  the same through the canvas drop hook; a player's give to a figure they cannot write is relayed to the referee's
 *  session and lands once; a player's Alt-drag off a sheet they do not own is refused and moves nothing; an
 *  installed cyberware and a skill are refused. Two clients. Red-first; wording names mechanisms. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinAs(p, match, passwords) {
  await p.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const s = p.locator('select[name="userid"]'); await s.waitFor({ state: "visible", timeout: 30000 });
  const us = await s.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  const u = us.find(x => match.test(x.l)); if (!u) throw new Error("no user " + match);
  for (const pw of passwords) {
    await s.selectOption(u.v); await p.locator('input[name="password"]').fill(pw);
    await Promise.all([p.waitForNavigation({ url: /\/game/, timeout: 20000 }).catch(() => {}), p.locator('button[name="join"]').click()]);
    try { await p.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 30000 }); return u.l; }
    catch { await p.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await s.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join " + u.l);
}
const b = await chromium.launch({ headless: true });
const gm = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
const pl = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
const errors = [];
for (const [n, p] of [["gm", gm], ["pl", pl]]) { p.on("pageerror", e => errors.push(`${n} pageerror: ${e.message}`)); p.on("console", m => { if (m.type() === "error") errors.push(`${n} console: ${m.text().slice(0, 240)}`); }); }
await joinAs(gm, /^gamemaster$/i, [PW]); await gm.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 60000 });
await joinAs(pl, /Test User 1/i, ["", PW]); await pl.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 60000 }).catch(() => {}); await pl.waitForTimeout(1200);
const checks = [];
const add = (name, ok, detail = "") => { const c = { name, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) }; checks.push(c); console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "   -> " + c.detail.slice(0, 500)}`); };

const F = await gm.evaluate(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const player = game.users.find(u => /Test User 1/i.test(u.name)); if (!player) return { error: "no 'Test User 1' on this rig" };
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__GV"))) await a.delete().catch(() => {});
  const rusty = await Actor.create({ name: "__PW__GV Rusty", type: "character", ownership: { default: 0, [player.id]: 3 } });
  const dummy = await Actor.create({ name: "__PW__GV Dummy", type: "npc", ownership: { default: 1 } });   // the player may SEE it
  const scene = canvas.scene, gs = scene.grid.size;
  const toks = await scene.createEmbeddedDocuments("Token", [
    { name: rusty.name, actorId: rusty.id, actorLink: true, x: scene.dimensions.sceneX + 6 * gs, y: scene.dimensions.sceneY + 6 * gs },
    { name: dummy.name, actorId: dummy.id, actorLink: true, x: scene.dimensions.sceneX + 9 * gs, y: scene.dimensions.sceneY + 6 * gs },
  ]);
  const rTok = toks.find(t => t.actorId === rusty.id), dTok = toks.find(t => t.actorId === dummy.id);
  await sleep(500);
  return { rustyId: rusty.id, dummyId: dummy.id, rTokId: rTok.id, dTokId: dTok.id, toks: toks.map(t => t.id), playerId: player.id };
});
if (F.error) add("§0 harness: Test User 1 present", false, F.error);
else {
  // ── §1 the referee: Alt on a sheet moves; plain drop copies (core kept); Alt on a token moves ─────────
  const g1 = await gm.evaluate(async ({ rustyId, dummyId, dTokId }) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms)); const SCOPE = "cp2020-augmented";
    const rusty = game.actors.get(rustyId), dummy = game.actors.get(dummyId);
    const [pistol, vest] = await Promise.all([
      dummy.createEmbeddedDocuments("Item", [{ name: "__PW__GV Pistol", type: "weapon", system: { weaponType: "Pistol", attackType: "SemiAuto", damage: "2d6", equipped: true } }]).then(x => x[0]),
      dummy.createEmbeddedDocuments("Item", [{ name: "__PW__GV Vest", type: "armor", system: { equipped: true } }]).then(x => x[0]),
    ]);
    const msgs0 = game.messages.size;
    await rusty.sheet.render(true); await sleep(900);
    const root = rusty.sheet.element;
    const fakeEvent = (altKey) => ({ altKey, target: root, preventDefault() {}, stopPropagation() {} });
    // Alt + drop: the pistol MOVES (core resolves the dropped Item before calling the sheet's _onDropItem, so
    // the document is what the handler receives — the keeper hands it the same)
    await rusty.sheet._onDropItem(fakeEvent(true), pistol); await sleep(900);
    const moved = { onRusty: rusty.items.getName("__PW__GV Pistol") ?? null, onDummy: !!dummy.items.get(pistol.id) };
    const card = game.messages.contents.slice(msgs0).find(m => /hands/.test(m.content ?? ""));
    // plain drop: the vest is COPIED — core's behaviour untouched
    await rusty.sheet._onDropItem(fakeEvent(false), vest); await sleep(900);
    const copied = { onRusty: !!rusty.items.getName("__PW__GV Vest"), stillOnDummy: !!dummy.items.get(vest.id) };
    // Alt + drop on Dummy's TOKEN: the (now Rusty's) pistol goes back through the canvas hook
    const rp = rusty.items.getName("__PW__GV Pistol"); const tok = canvas.tokens.get(dTokId);
    const allowed = tok && rp ? Hooks.call("dropCanvasData", canvas, { type: "Item", uuid: rp.uuid, x: tok.center.x, y: tok.center.y }, { altKey: true }) : "no-fixture";
    await sleep(900);
    const viaToken = { allowed, backOnDummy: !!dummy.items.getName("__PW__GV Pistol"), goneFromRusty: !rusty.items.getName("__PW__GV Pistol") };
    await rusty.sheet.close({ animate: false }).catch(() => {});
    return { moved: { onRusty: !!moved.onRusty, unequipped: moved.onRusty ? moved.onRusty.system.equipped === false : null, onDummy: moved.onDummy }, cardText: (card?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160), copied, viaToken };
  }, F);
  add("§1 Alt on a sheet: the item leaves the giver's sheet and arrives on the recipient's, unequipped", g1.moved.onRusty && g1.moved.onDummy === false && g1.moved.unequipped === true, g1.moved);
  add("§1 Alt on a sheet: one hand-over card names who gave what to whom", /Gamemaster/i.test(g1.cardText) && /__PW__GV Pistol/.test(g1.cardText) && /__PW__GV Dummy/.test(g1.cardText) && /__PW__GV Rusty/.test(g1.cardText), g1.cardText);
  add("§1 plain drop (negative): core's copy is untouched — the vest is on both sheets", g1.copied.onRusty && g1.copied.stillOnDummy, g1.copied);
  add("§1 Alt on a token: the canvas drop gives to the figure under the point and stops core", g1.viaToken.allowed === false && g1.viaToken.backOnDummy && g1.viaToken.goneFromRusty, g1.viaToken);

  // ── §2 the player: a relayed give lands once; a drag off a sheet they do not own is refused; refusals ──
  const p2 = await pl.evaluate(async ({ rustyId, dummyId }) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const G = await import("/modules/cp2020-augmented/module/item/item-give.js");
    const rusty = game.actors.get(rustyId), dummy = game.actors.get(dummyId);
    const [knife] = await rusty.createEmbeddedDocuments("Item", [{ name: "__PW__GV Knife", type: "weapon", system: { weaponType: "Melee", attackType: "Melee", damage: "1d6" } }]);
    const [skill] = await rusty.createEmbeddedDocuments("Item", [{ name: "__PW__GV Trick", type: "skill", system: { level: 1 } }]);
    const [chip] = await rusty.createEmbeddedDocuments("Item", [{ name: "__PW__GV Implant", type: "cyberware", system: { equipped: true } }]);
    const warns = []; const ow = ui.notifications.warn.bind(ui.notifications); ui.notifications.warn = (m, ...a) => { warns.push(String(m)); return ow(m, ...a); };
    const out = { canWriteDummy: dummy.isOwner };
    // the give to the NPC the player cannot write → relayed
    out.relayed = await G.giveDroppedItem({ type: "Item", uuid: knife.uuid }, dummy);
    // The referee's session creates the copy, THEN deletes the original — two round trips; the arrival is seen
    // on this client a beat before the removal, so both are waited for rather than read in the same breath.
    let landed = null; for (let i = 0; i < 40 && !landed; i++) { await sleep(250); landed = dummy.items.getName("__PW__GV Knife") ?? null; }
    let gone = false; for (let i = 0; i < 40 && !gone; i++) { await sleep(250); gone = !rusty.items.get(knife.id); }
    out.landed = { onDummy: !!landed, goneFromRusty: gone, copies: dummy.items.filter(i => i.name === "__PW__GV Knife").length };
    // a drag off a sheet the player does not own → refused, nothing moves
    const dummyPistol = dummy.items.getName("__PW__GV Pistol");
    const w0 = warns.length;
    out.refusedForeign = dummyPistol ? await G.giveDroppedItem({ type: "Item", uuid: dummyPistol.uuid }, rusty) : "no-fixture";
    await sleep(600);
    out.foreign = { warned: warns.length > w0, stillOnDummy: !!dummy.items.getName("__PW__GV Pistol"), notOnRusty: !rusty.items.getName("__PW__GV Pistol") };
    // a skill and an installed implant are refused
    const w1 = warns.length;
    await G.giveDroppedItem({ type: "Item", uuid: skill.uuid }, dummy); await G.giveDroppedItem({ type: "Item", uuid: chip.uuid }, dummy); await sleep(600);
    out.refusals = { warned: warns.length - w1, skillStays: !!rusty.items.get(skill.id), chipStays: !!rusty.items.get(chip.id) };
    ui.notifications.warn = ow;
    return out;
  }, F);
  add("§2 relay: a player's give to a figure they cannot write lands on it exactly once, through the referee's session", p2.canWriteDummy === false && p2.relayed === true && p2.landed.onDummy && p2.landed.goneFromRusty && p2.landed.copies === 1, p2);
  add("§2 permission: a player's Alt-drag off a sheet they do not own is refused with a notice and moves nothing", p2.refusedForeign === true && p2.foreign.warned && p2.foreign.stillOnDummy && p2.foreign.notOnRusty, p2.foreign);
  add("§2 refusals: a skill and an installed implant are not handed over", p2.refusals.warned === 2 && p2.refusals.skillStays && p2.refusals.chipStays, p2.refusals);
}
await gm.evaluate(async (F) => {
  if (!F.toks) return;
  await canvas.scene.deleteEmbeddedDocuments("Token", F.toks.filter(id => canvas.scene.tokens.has(id))).catch(() => {});
  for (const id of [F.rustyId, F.dummyId]) await game.actors.get(id)?.delete().catch(() => {});
  const mine = game.messages.contents.filter(m => /__PW__GV/.test(m.content ?? "") || /__PW__GV/.test(m.speaker?.alias ?? "")).map(m => m.id);
  if (mine.length) await ChatMessage.deleteDocuments(mine).catch(() => {});
}, F);
add("0 console errors", errors.length === 0, errors.join(" | ").slice(0, 400));
const fails = checks.filter(c => !c.ok).length;
console.log(`\nRESULT: ${fails ? "FAIL" : "ALL GREEN"}  ${checks.length - fails}/${checks.length}`);
await b.close();
process.exit(fails ? 1 : 0);
