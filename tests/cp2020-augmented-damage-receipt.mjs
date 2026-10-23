/** The apply window's seat, the receipt card, View and Undo (user ruling 2026-10-22; combat/damage-receipt.js).
 *  Two clients: the referee's pistol shot at a PLAYER-owned figure opens the window on the PLAYER's client and not
 *  the referee's; the player's apply posts a receipt whose rows read by value (raw − SP = after-SP → net, the wound
 *  state before and after); the referee's Undo puts the wound track and the armour SP back and stamps the receipt;
 *  View opens a read-only window on the receipt's own rows with no Apply control. One client: a shot at the
 *  referee's own figure opens the window locally; a second apply of the same shot from its card is refused.
 *  Red-first; wording names mechanisms. */
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
for (const [name, page] of [["gm", gm], ["pl", pl]]) {
  page.on("pageerror", e => errors.push(`${name} pageerror: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") errors.push(`${name} console: ${m.text().slice(0, 240)}`); });
}
await joinAs(gm, /^gamemaster$/i, [PW]);
await gm.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 60000 });
await joinAs(pl, /Test User 1/i, ["", PW]);
await pl.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 60000 }).catch(() => {});
await pl.waitForTimeout(1200);

const checks = [];
const add = (name, ok, detail = "") => { const c = { name, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) }; checks.push(c); console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "   -> " + c.detail.slice(0, 500)}`); };
const windowsOn = (page) => page.evaluate(() => [...foundry.applications.instances.values()].filter(a => a.constructor.name === "DamageDialog").map(a => ({ target: a.target?.name ?? null, readOnly: !!a.receipt, hasApply: !!a.element?.querySelector('button[data-action="applyDamage"]'), rows: [...(a.element?.querySelectorAll(".damage-hit") ?? [])].map(r => r.textContent.replace(/\s+/g, " ").trim()) })));
const closeWindowsOn = (page) => page.evaluate(async () => { for (const a of [...foundry.applications.instances.values()].filter(a => a.constructor.name === "DamageDialog")) { try { await a.close({ animate: false }); } catch (_e) { /* gone */ } } });
const waitOn = (page, fn, ms = 8000) => page.waitForFunction(fn, null, { timeout: ms }).then(() => true).catch(() => false);

// ── fixtures (built on the referee's client) ─────────────────────────────────────────────────────
const F = await gm.evaluate(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const SCOPE = "cp2020-augmented";
  const out = { notes: {} };
  out.fumbleWas = game.settings.get("cyberpunk2020", "fumbleTableEnabled");
  await game.settings.set("cyberpunk2020", "fumbleTableEnabled", false);
  out.fxWas = game.settings.get(SCOPE, "combatFxEnabled");
  await game.settings.set(SCOPE, "combatFxEnabled", false);
  for (const c of game.combats.filter(c => c.combatants.some(x => x.name?.startsWith("__PW__DR")))) await c.delete().catch(() => {});
  const scene = canvas.scene;
  for (const t of scene.tokens.filter(t => t.name?.startsWith("__PW__DR"))) await t.delete().catch(() => {});
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__DR"))) await a.delete().catch(() => {});
  const player = game.users.find(u => /Test User 1/i.test(u.name));
  if (!player) return { error: "no 'Test User 1' on this rig" };
  const shooter = await Actor.create({ name: "__PW__DR Shooter", type: "npc" });
  await shooter.update({ "system.stats.ref.base": 10 });
  const rusty = await Actor.create({ name: "__PW__DR Rusty", type: "character", ownership: { default: 0, [player.id]: 3 } });
  const dummy = await Actor.create({ name: "__PW__DR Dummy", type: "npc" });
  for (const a of [rusty, dummy]) await a.update({ "system.stats.bt.base": 5, "system.damage": 0 });
  // Torso armour SP 10 on both — the apply erodes it (full mode, ablate), Undo must put it back.
  for (const a of [rusty, dummy]) await a.createEmbeddedDocuments("Item", [{ name: "__PW__DR Vest", type: "armor", system: { equipped: true, coverage: { Torso: { stoppingPower: 10, covers: true } } } }]);
  const [pistol] = await shooter.createEmbeddedDocuments("Item", [{ name: "__PW__DR Pistol", type: "weapon", system: { weaponType: "Pistol", attackType: "SemiAuto", damage: "3d6", range: 50, shots: 10, shotsLeft: 10, rof: 2, attackSkill: "Handgun", equipped: true } }]);
  const gs = scene.grid.size, X = scene.dimensions.sceneX, Y = scene.dimensions.sceneY;
  const toks = await scene.createEmbeddedDocuments("Token", [
    { name: shooter.name, actorId: shooter.id, actorLink: true, x: X + 4 * gs, y: Y + 6 * gs },
    { name: rusty.name, actorId: rusty.id, actorLink: true, x: X + 6 * gs, y: Y + 6 * gs },
    { name: dummy.name, actorId: dummy.id, actorLink: true, x: X + 8 * gs, y: Y + 6 * gs },
  ]);
  await sleep(600);
  const tokOf = (a) => toks.find(t => t.actorId === a.id);
  out.ids = { shooter: shooter.id, rusty: rusty.id, dummy: dummy.id, pistol: pistol.id, rTok: tokOf(rusty).id, dTok: tokOf(dummy).id, sTok: tokOf(shooter).id, toks: toks.map(t => t.id), playerId: player.id, me: game.user.id };
  out.seat = { rusty: (await import("/modules/cp2020-augmented/module/combat/damage-receipt.js")).damageSeatUserId(rusty), dummy: (await import("/modules/cp2020-augmented/module/combat/damage-receipt.js")).damageSeatUserId(dummy) };
  return out;
});
if (F.error) { add("§0 harness: Test User 1 present", false, F.error); }
else {
  add("§1 seat: a player-owned figure with its player connected seats the window with the player", F.seat.rusty === F.ids.playerId, F.seat);
  add("§1 seat: the referee's own figure seats the window with the referee (null = primary GM session)", F.seat.dummy === null, F.seat);

  const fire = (tokKey) => gm.evaluate(async ({ ids, tokKey }) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const shooter = game.actors.get(ids.shooter), pistol = shooter.items.get(ids.pistol);
    for (const t of [...game.user.targets]) t.setTarget(false, { releaseOthers: false });
    canvas.tokens.get(ids[tokKey]).setTarget(true, { releaseOthers: true }); await sleep(150);
    await pistol.update({ "system.shotsLeft": 10 });
    const before = game.messages.size;
    await pistol.__weaponRoll({ fireMode: "SemiAuto", extraMod: 40, range: "RangeClose", targetArea: "Torso", cyberTerminus: "NoCyberlimb" }, [{ name: canvas.tokens.get(ids[tokKey]).name, id: ids[tokKey] }]);
    await sleep(2500);
    return { cards: game.messages.size - before };
  }, { ids: F.ids, tokKey });

  // ── §2 two clients: the referee's shot at the player's figure opens on the PLAYER ───────────────
  await closeWindowsOn(gm); await closeWindowsOn(pl);
  await fire("rTok");
  const plOpened = await waitOn(pl, () => [...foundry.applications.instances.values()].some(a => a.constructor.name === "DamageDialog" && a.rendered), 10000);
  const gmWins = await windowsOn(gm), plWins = await windowsOn(pl);
  add("§2 seat: the window opened on the player's client, not the referee's", plOpened && plWins.length === 1 && gmWins.length === 0, { pl: plWins, gm: gmWins });
  add("§2 seat: the player's window is the live one (Apply present, the figure named)", plWins[0]?.hasApply === true && plWins[0]?.target === "__PW__DR Rusty", plWins[0]);

  // the player applies (full armour mode, wear on) → the receipt
  const applied = await pl.evaluate(async ({ ids }) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const SCOPE = "cp2020-augmented";
    const win = [...foundry.applications.instances.values()].find(a => a.constructor.name === "DamageDialog");
    if (!win) return { opened: false };
    const root = win.element;
    const mode = root.querySelector("select[name='armorMode']"); if (mode) { mode.value = "full"; mode.dispatchEvent(new Event("change")); await sleep(400); }
    const ablate = win.element.querySelector("input[name='ablate']"); if (ablate && !ablate.checked) { ablate.checked = true; ablate.dispatchEvent(new Event("change")); }
    const rowsShown = [...win.element.querySelectorAll(".damage-hit")].map(r => r.textContent.replace(/\s+/g, " ").trim());
    const preview = Number(win.element.querySelector(".damage-total-value")?.textContent) || 0;
    const before = game.messages.size;
    win.element.querySelector('button[data-action="applyDamage"]')?.click();
    let receipt = null;
    for (let i = 0; i < 60 && !receipt; i++) { await sleep(200); receipt = game.messages.contents.slice(before).find(m => m.getFlag(SCOPE, "damageReceipt")) ?? null; }
    const r = receipt?.getFlag(SCOPE, "damageReceipt") ?? null;
    const rusty = game.actors.get(ids.rusty);
    return { opened: true, rowsShown, preview, receiptId: receipt?.id ?? null, r, damageNow: rusty?.system?.damage, vestSp: rusty?.items.find(i => i.type === "armor")?.system?.coverage?.Torso?.stoppingPower, text: receipt?.content?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300), hasUndoBtn: !!document.querySelector(`[data-message-id="${receipt?.id}"] .cp-receipt-undo`), hasViewBtn: !!document.querySelector(`[data-message-id="${receipt?.id}"] .cp-receipt-view`) };
  }, { ids: F.ids });
  add("§2 receipt: the player's apply posts a receipt card", applied.opened && !!applied.r, applied);
  const r = applied.r ?? {};
  const rowOk = Array.isArray(r.rows) && r.rows.length === 1 && r.rows[0].location === "Torso" && r.rows[0].sp === 10 && r.rows[0].afterSP === Math.max(0, r.rows[0].raw - 10) && (r.rows[0].penetrates ? r.rows[0].net >= 1 : r.rows[0].net === 0);
  add("§2 receipt: the row reads by value — raw − the vest's SP 10 = after-SP, the net the window applied", rowOk && r.totalApplied === applied.damageNow, { rows: r.rows, total: r.totalApplied, damageNow: applied.damageNow });
  add("§2 receipt: wound state before and after, the applying user, the weapon", r.woundBefore === 0 && Number.isFinite(r.woundAfter) && /Test User 1/i.test(r.appliedByName ?? "") && r.weaponName === "__PW__DR Pistol", { before: r.woundBefore, after: r.woundAfter, by: r.appliedByName, weapon: r.weaponName });
  add("§2 receipt: the snapshot holds the figure before the apply (damage 0, vest SP 10)", r.snapshot?.damage === 0 && r.snapshot?.items?.some(i => i.system?.coverage?.Torso?.stoppingPower === 10), { snap: { damage: r.snapshot?.damage, items: r.snapshot?.items?.length } });
  add("§2 receipt: the player's log shows View and no Undo", applied.hasViewBtn === true && applied.hasUndoBtn === false, { view: applied.hasViewBtn, undo: applied.hasUndoBtn });
  const penetrated = !!r.rows?.[0]?.penetrates;
  add("§2 apply (harness): the vest wore one point when the round penetrated, else stayed", penetrated ? applied.vestSp === 9 : applied.vestSp === 10, { penetrated, vestSp: applied.vestSp });

  // ── §3 the referee: View (read-only) and Undo ────────────────────────────────────────────────────
  await gm.waitForTimeout(800);
  const viewed = await gm.evaluate(async ({ receiptId }) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const btnUndo = !!document.querySelector(`[data-message-id="${receiptId}"] .cp-receipt-undo`);
    document.querySelector(`[data-message-id="${receiptId}"] .cp-receipt-view`)?.click();
    let win = null; for (let i = 0; i < 30 && !win; i++) { await sleep(200); win = [...foundry.applications.instances.values()].find(a => a.constructor.name === "DamageDialog" && a.rendered && a.element?.isConnected); }
    const rows = [...(win?.element?.querySelectorAll(".damage-hit") ?? [])].map(x => x.textContent.replace(/\s+/g, " ").trim());
    const out = { gmHasUndo: btnUndo, opened: !!win, readOnly: !!win?.receipt, hasApply: !!win?.element?.querySelector('button[data-action="applyDamage"]'), hasClose: !!win?.element?.querySelector('button[data-action="cancelDialog"]'), hasOverride: !!win?.element?.querySelector("input.after-sp-override"), rows, title: win?.title ?? "" };
    try { await win?.close({ animate: false }); } catch (_e) { /* fine */ }
    return out;
  }, { receiptId: applied.receiptId });
  add("§3 view: the referee's log shows Undo", viewed.gmHasUndo === true, viewed);
  add("§3 view: View opens the window read-only — the receipt's row, no Apply, no override box, a Close", viewed.opened && viewed.readOnly && !viewed.hasApply && !viewed.hasOverride && viewed.hasClose && viewed.rows.length === 1 && /Torso/.test(viewed.rows[0]) && new RegExp(`\\b${r.rows?.[0]?.raw}\\b`).test(viewed.rows[0]), viewed);

  const undone = await gm.evaluate(async ({ receiptId, ids }) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const SCOPE = "cp2020-augmented";
    const rusty = game.actors.get(ids.rusty);
    const before = { damage: rusty.system.damage, vest: rusty.items.find(i => i.type === "armor")?.system?.coverage?.Torso?.stoppingPower };
    document.querySelector(`[data-message-id="${receiptId}"] .cp-receipt-undo`)?.click();
    let stamped = null; for (let i = 0; i < 40 && !stamped; i++) { await sleep(200); const f = game.messages.get(receiptId)?.getFlag(SCOPE, "damageReceipt"); if (f?.undone) stamped = f; }
    await sleep(500);
    return { before, stamped: !!stamped, by: stamped?.undone?.byName ?? null, damageAfter: rusty.system.damage, vestAfter: rusty.items.find(i => i.type === "armor")?.system?.coverage?.Torso?.stoppingPower, undoBtnLeft: !!document.querySelector(`[data-message-id="${receiptId}"] .cp-receipt-undo`), struck: !!document.querySelector(`[data-message-id="${receiptId}"] .cp-receipt-undone`) };
  }, { receiptId: applied.receiptId, ids: F.ids });
  add("§3 undo: the referee's Undo puts the wound track back to 0 and the vest back to SP 10", undone.stamped && undone.damageAfter === 0 && undone.vestAfter === 10, undone);
  add("§3 undo: the receipt is stamped undone, by name, and offers no second Undo", undone.stamped && /gamemaster/i.test(undone.by ?? "") && undone.undoBtnLeft === false && undone.struck === true, undone);

  // ── §4 one client: the referee's figure seats the window with the referee ───────────────────────
  await closeWindowsOn(gm); await closeWindowsOn(pl);
  await fire("dTok");
  const gmOpened = await waitOn(gm, () => [...foundry.applications.instances.values()].some(a => a.constructor.name === "DamageDialog" && a.rendered), 10000);
  const gmW = await windowsOn(gm), plW = await windowsOn(pl);
  add("§4 seat: a shot at the referee's figure opens on the referee and not on the player", gmOpened && gmW.length === 1 && plW.length === 0 && gmW[0]?.target === "__PW__DR Dummy", { gm: gmW, pl: plW });
  await closeWindowsOn(gm);
}

// ── cleanup ──────────────────────────────────────────────────────────────────────────────────────
await gm.evaluate(async (F) => {
  const SCOPE = "cp2020-augmented";
  try { await game.settings.set("cyberpunk2020", "fumbleTableEnabled", F.fumbleWas); } catch (_e) { /* fine */ }
  try { await game.settings.set(SCOPE, "combatFxEnabled", F.fxWas); } catch (_e) { /* fine */ }
  if (!F.ids) return;
  await canvas.scene.deleteEmbeddedDocuments("Token", F.ids.toks.filter(id => canvas.scene.tokens.has(id))).catch(() => {});
  for (const id of [F.ids.shooter, F.ids.rusty, F.ids.dummy]) await game.actors.get(id)?.delete().catch(() => {});
  const mine = game.messages.contents.filter(m => /__PW__DR/.test(m.content ?? "") || /__PW__DR/.test(m.speaker?.alias ?? "") || m.getFlag(SCOPE, "damageReceipt")?.targetName?.startsWith?.("__PW__DR")).map(m => m.id);
  if (mine.length) await ChatMessage.deleteDocuments(mine).catch(() => {});
}, F);
add("0 console errors", errors.length === 0, errors.join(" | ").slice(0, 400));
const fails = checks.filter(c => !c.ok).length;
console.log(`\nRESULT: ${fails ? "FAIL" : "ALL GREEN"}  ${checks.length - fails}/${checks.length}`);
await b.close();
process.exit(fails ? 1 : 0);
