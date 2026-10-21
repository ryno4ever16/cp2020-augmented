/** Melee contest (CP2020 p.111 opposed roll, p.39 ties to the defender, p.112 declarations/parry, p.104 stunned):
 *  the pure rules (defense option list + default, verdict, permission, parry redirect, the Apply-button target
 *  resolver), the live flow on real documents (contest card instead of a window, window → roll → result card,
 *  hit opens the apply window / miss opens nothing, stunned auto-hit, one card for a status manoeuvre, the parry
 *  redirect, the dodge −2 only on the attacker's side), the stance declarations (every row, advisory after the
 *  round began, round-end clear, the sheet button declares), the negatives (several targets → no contest; ranged
 *  untouched; the defense roll never touches the action counter), and a two-client permission/relay leg
 *  (player opens the window for their own PC, not for an NPC; the presenter's client opens the apply window).
 *  Red-first. Wording names mechanisms. */
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
    try { await p.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 20000 }); return u.l; }
    catch { await p.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await s.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join " + u.l);
}

const b = await chromium.launch({ headless: true });
const gmCtx = await b.newContext({ viewport: { width: 1600, height: 900 } });
const gm = await gmCtx.newPage();
const errors = [], seamWarns = [];
gm.on("pageerror", e => errors.push("gm pageerror: " + e.message));
gm.on("console", m => { if (m.type() === "error") errors.push("gm console: " + m.text()); if (m.type() === "warning" && /seam shim|cp2020-augmented \|/.test(m.text())) seamWarns.push(m.text().slice(0, 220)); });
await joinAs(gm, /gamemaster/i, [PW]);

const r = await gm.evaluate(async () => {
  const out = { checks: [], notes: {} };
  const add = (name, ok, detail = "") => out.checks.push({ name, ok: !!ok, detail: String(detail) });
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const SCOPE = "cp2020-augmented";
  const flagged = (flag) => game.messages.contents.filter(m => m.getFlag?.(SCOPE, flag));
  const waitFor = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_e) { /* retry */ } await sleep(150); } return null; };
  const windows = () => [...foundry.applications.instances.values()].filter(a => a.constructor.name === "DamageDialog");
  const closeWindows = async () => { for (const a of windows()) { try { await a.close({ animate: false }); } catch (_e) { /* gone */ } } };
  const defenseWindows = () => [...foundry.applications.instances.values()].filter(a => (a.options?.classes ?? []).includes("cp-melee-defense-dialog"));

  let M, D;
  try { M = await import("/modules/cp2020-augmented/module/martial/melee-contest.js"); }
  catch (e) { add("§0 contest module is served", false, e.message); return out; }
  add("§0 contest module is served", true);
  D = await import("/modules/cp2020-augmented/module/combat/damage-hooks.js");
  // Harness guard: what the shot path was handed (the seam's own event), so a routing red names its cause.
  const shots = [];
  const S = await import("/modules/cp2020-augmented/module/seam-shim.js");
  out.notes.railAtStart = S.renderEmitLive();
  out.notes.swings = [];
  Hooks.on("cyberpunk2020.weaponFired", (p) => shots.push({ method: p.fireMethod, targets: p.targetCount, fx: p.fxTargetTokenId, tt: p.targetTokenId, fired: p.firedByUserId === game.user.id, total: p.attackTotal, keys: Object.keys(p.areaDamages ?? {}), applies: M.contestApplies(p) }));

  // ── §1 pure rules ─────────────────────────────────────────────────────────────────────────────
  const v = (o) => M.meleeVerdict({ attackTotal: 15, defenseTotal: 14, ...o });
  add("§1 verdict: higher attack wins", v({}) === "hit");
  add("§1 verdict: a tie goes to the defender (p.39)", v({ defenseTotal: 15 }) === "miss");
  add("§1 verdict: a fumbled attack misses whatever the numbers", v({ attackTotal: 40, defenseTotal: 5, fumble: true }) === "miss");
  add("§1 verdict: a defender who cannot defend is hit whatever the numbers", v({ attackTotal: 5, defenseTotal: 40, cannotDefend: true }) === "hit");
  add("§1 verdict: unreadable totals read as a miss, never a throw", v({ attackTotal: null, defenseTotal: 10 }) === "miss" && v({ attackTotal: NaN }) === "miss");
  {
    const opts = [{ id: "a", total: 12 }, { id: "b", total: 15 }, { id: "c", total: 15 }];
    add("§1 default option: the highest total, first on a tie", M.defaultDefenseOption(opts)?.id === "b");
    add("§1 default option: an empty list yields null", M.defaultDefenseOption([]) === null);
  }
  {
    const dmg = { Head: [{ damage: 7 }], Torso: [{ damage: 3 }] };
    const arm = M.parryRedirect(dmg, { object: "lArm" });
    add("§1 parry redirect: an arm parry moves every hit onto that arm", Object.keys(arm.areaDamages).join() === "lArm" && arm.areaDamages.lArm.length === 2 && arm.breakSave === false, JSON.stringify(arm));
    const blade = M.parryRedirect(dmg, { object: "weapon", bladed: true, weaponName: "Sword" });
    add("§1 parry redirect: a bladed weapon takes the hit instead — no damage, a break save", blade.breakSave === true && Object.keys(blade.areaDamages).length === 0 && blade.weaponName === "Sword", JSON.stringify(blade));
    const club = M.parryRedirect(dmg, { object: "weapon", bladed: false });
    add("§1 parry redirect: a non-bladed weapon parries like the weapon arm", Object.keys(club.areaDamages).join() === "rArm" && club.breakSave === false, JSON.stringify(club));
    const none = M.parryRedirect(dmg, null);
    add("§1 parry redirect: no parry leaves the damage untouched", JSON.stringify(none.areaDamages) === JSON.stringify(dmg));
  }

  // ── fixtures ──────────────────────────────────────────────────────────────────────────────────
  // The base's fumble table rules a natural 1 a fumble, and a fumbled attack is a MISS by design (its own leg
  // covers that rule purely). Stood down for the live legs so a 1-in-10 die cannot flip a verdict leg;
  // restored at the end (see the cleanup).
  out.notes.fumbleTableWas = game.settings.get("cyberpunk2020", "fumbleTableEnabled");
  await game.settings.set("cyberpunk2020", "fumbleTableEnabled", false);
  for (const c of game.combats.filter(c => c.combatants.some(x => x.name?.startsWith("__PW__MC")))) await c.delete().catch(() => {});
  const scene = canvas.scene;
  for (const t of scene.tokens.filter(t => t.name?.startsWith("__PW__MC"))) await t.delete().catch(() => {});
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__MC"))) await a.delete().catch(() => {});
  await closeWindows();
  const attacker = await Actor.create({ name: "__PW__MC Attacker", type: "character" });
  const defender = await Actor.create({ name: "__PW__MC Defender", type: "npc" });
  await attacker.update({ "system.stats.ref.base": 8 });
  await defender.update({ "system.stats.ref.base": 6 });
  const setSkill = async (actor, name, level) => { const sk = actor.items.find(i => i.type === "skill" && i.name === name); if (sk) await sk.update({ "system.level": level }); return !!sk; };
  await setSkill(attacker, "Melee", 6);
  await setSkill(defender, "Melee", 5); await setSkill(defender, "Fencing", 2); await setSkill(defender, "Athletics", 3);
  const karate = defender.items.find(i => i.type === "skill" && /Karate/.test(i.name));
  if (karate) await karate.update({ "system.level": 4 });
  // ⚠ createEmbeddedDocuments returns in ITS order, not the input's (rig-keeper gotcha): a run on 2026-10-21
  // destructured the pistol as `fists`, fired it for the Hold and the Throw (nothing emitted, no card) and
  // the fists for the ranged leg (a contest card for a "pistol") — five reds from one swap. By name.
  const madeItems = await attacker.createEmbeddedDocuments("Item", [
    { name: "__PW__MC Blade", type: "weapon", system: { weaponType: "Melee", attackType: "Melee", damage: "1d6", attackSkill: "Melee" } },
    { name: "__PW__MC Fists", type: "weapon", system: { weaponType: "Melee", attackType: "Martial", damage: "1d6/2" } },
    { name: "__PW__MC Pistol", type: "weapon", system: { weaponType: "Pistol", attackType: "SemiAuto", damage: "2d6", range: 50, shots: 10, shotsLeft: 10, rof: 1, attackSkill: "Handgun" } },
  ]);
  const madeByName = (n) => madeItems.find(i => i.name === n) ?? attacker.items.getName(n);
  const blade = madeByName("__PW__MC Blade"), fists = madeByName("__PW__MC Fists"), pistol = madeByName("__PW__MC Pistol");
  const gs = scene.grid.size;
  const toks = await scene.createEmbeddedDocuments("Token", [
    { name: attacker.name, actorId: attacker.id, actorLink: true, x: scene.dimensions.sceneX + 4 * gs, y: scene.dimensions.sceneY + 4 * gs },
    { name: defender.name, actorId: defender.id, actorLink: true, x: scene.dimensions.sceneX + 5 * gs, y: scene.dimensions.sceneY + 4 * gs },
  ]);
  const atkTok = toks.find(t => t.actorId === attacker.id), defTok = toks.find(t => t.actorId === defender.id);
  await sleep(500);
  const combat = await Combat.create({ scene: scene.id, active: true });
  await combat.createEmbeddedDocuments("Combatant", [
    { tokenId: atkTok.id, actorId: attacker.id, sceneId: scene.id, initiative: 20 },
    { tokenId: defTok.id, actorId: defender.id, sceneId: scene.id, initiative: 10 },
  ]);
  await combat.startCombat(); await sleep(600);
  add("§2 harness: attacker is the current combatant", combat.current?.combatantId === combat.combatants.find(c => c.actorId === attacker.id)?.id);

  // §1b option list on a real actor (REF 6; Melee 5, Fencing 2, Athletics 3, Karate 4 with its Block key)
  {
    const opts = M.defenseOptionsFor(defender);
    const ref = Number(defender.system.stats.ref.total) || 0;
    const melee = opts.find(o => o.kind === "skill" && /Melee/.test(o.label));
    const karateRows = opts.filter(o => o.kind === "art" && /Karate/.test(o.label));
    out.notes.options = opts.map(o => `${o.label}=${o.total}`);
    add("§1 options: every eligible skill lists REF + level", !!melee && melee.total === ref + 5, JSON.stringify(melee));
    add("§1 options: a trained art lists a Block row and a Dodge row carrying the art's keys", karateRows.length === 2 && karateRows.some(o => o.maneuver === "BlockParry" && o.key === 2 && o.total === ref + 4 + 2) && karateRows.some(o => o.maneuver === "Dodge" && o.key === 0), JSON.stringify(karateRows));
    const best = M.defaultDefenseOption(opts);
    add("§1 options: the default is the best total (Karate Block, REF+6)", best && /Karate/.test(best.label) && best.maneuver === "BlockParry", JSON.stringify(best));
    add("§1 permission: the referee may choose any defense", M.canChooseDefense(game.user, defender) === true);
  }

  const target = async (tokDoc, releaseOthers = true) => { canvas.tokens.get(tokDoc.id).setTarget(true, { releaseOthers }); await sleep(150); };
  const untarget = async () => { for (const t of [...game.user.targets]) t.setTarget(false, { releaseOthers: false }); await sleep(100); };
  const swing = async (item, mods, targetDocs) => {
    await untarget(); for (const t of targetDocs) await target(t, false);
    const tts = targetDocs.map(t => ({ name: t.name, id: t.id }));
    const before = game.messages.size, shotsBefore = shots.length, liveBefore = S.renderEmitLive();
    await item.__weaponRoll({ extraMod: 0, targetArea: "", cyberTerminus: "NoCyberlimb", ...mods }, tts);
    await waitFor(() => game.messages.size > before, 5000); await sleep(400);
    out.notes.swings.push({ item: item.name.replace("__PW__MC ", ""), liveBefore, liveAfter: S.renderEmitLive(), emitted: shots.length - shotsBefore, msgs: game.messages.size - before });
    return before;
  };
  const rollWindowDefault = async (card, { extra = 0 } = {}) => {
    const stale = defenseWindows().length;
    let openErr = "";
    // NOT awaited: the window's promise settles only when a button is pressed, and the press comes below.
    M.openDefenseWindow(card.id).catch(e => { openErr = String(e?.message ?? e); });
    const dlg = await waitFor(() => defenseWindows().find(a => a.rendered && a.element?.isConnected), 5000);
    if (!dlg) return { opened: false, stale, openErr, instances: defenseWindows().length };
    await sleep(400);
    const root = dlg.element;
    const sel = root.querySelector('select[name="defense"]');
    const ex = root.querySelector('input[name="extraMod"]');
    const defaultChoice = sel?.value ?? null;
    if (ex) ex.value = String(extra);
    root.querySelector('button[data-action="roll"]')?.click();
    const closed = !!(await waitFor(() => !defenseWindows().some(a => a.rendered), 5000));
    const result = await waitFor(() => flagged("meleeResult").find(m => m.getFlag(SCOPE, "meleeResult")?.contestMessageId === card.id), 6000);
    return { opened: true, stale, openErr, closed, defaultChoice, options: sel ? sel.options.length : 0, result: result?.getFlag(SCOPE, "meleeResult") ?? null, resultMsg: result };
  };

  // ── §2 live flow: swing → contest card, not a window ───────────────────────────────────────────
  await closeWindows();
  const w0 = windows().length;
  await swing(blade, { extraMod: 40 }, [defTok]);
  let card = await waitFor(() => flagged("meleeContest").find(m => m.getFlag(SCOPE, "meleeContest")?.defenderTokenId === defTok.id && !m.getFlag(SCOPE, "meleeContest")?.resolved), 6000);
  out.notes.firstSwing = shots[0] ?? null;
  add("§2 harness: the swing raised one shot event — melee method, one target, gate open", shots.length === 1 && shots[0].method === "__meleeBonk" && shots[0].targets === 1 && shots[0].applies === true && shots[0].fired === true, JSON.stringify(shots));
  add("§2 flow: a melee swing at one target posts a contest card", !!card, JSON.stringify({ contests: flagged("meleeContest").length, defTok: defTok.id, cards: flagged("meleeContest").map(m => m.getFlag(SCOPE, "meleeContest")?.defenderTokenId) }));
  add("§2 flow: no apply window opens before the contest", windows().length === w0, windows().length);
  const cflag = card?.getFlag(SCOPE, "meleeContest") ?? {};
  add("§2 flow: the card carries the attack total and the shot's damage", Number.isFinite(cflag.attackTotal) && cflag.payload?.areaDamages && Object.keys(cflag.payload.areaDamages).length === 1, JSON.stringify({ t: cflag.attackTotal, keys: Object.keys(cflag.payload?.areaDamages ?? {}) }));
  add("§2 flow: the shot card itself carries no apply button payload", !game.messages.contents.slice(-3).some(m => m.getFlag(SCOPE, "damagePayload")));
  {
    const rr = card ? await rollWindowDefault(card) : { opened: false };
    add("§2 window: opens from the card with the option list and the best default selected", rr.opened && rr.options >= 5 && rr.defaultChoice && /Karate/.test(rr.defaultChoice), JSON.stringify({ o: rr.opened, n: rr.options, d: rr.defaultChoice }));
    add("§2 window: the roll posts a result card tied to the contest", !!rr.result && rr.result.contestMessageId === card?.id, JSON.stringify(rr.result));
    add("§2 verdict: a +40 attack beats the defense → hit", rr.result?.verdict === "hit", rr.result?.verdict);
    const opened = await waitFor(() => windows().length > w0, 8000);
    add("§2 consequence: a hit opens the apply window on the presenting client", !!opened, windows().length);
    add("§2 consequence: the window carries the shot's damage at its rolled location", windows()[0]?.payload?.areaDamages && Object.keys(windows()[0].payload.areaDamages).length === 1, JSON.stringify(Object.keys(windows()[0]?.payload?.areaDamages ?? {})));
    add("§2 lock: the contest card is marked resolved", card?.getFlag(SCOPE, "meleeContest")?.resolved === true || (await waitFor(() => card?.getFlag(SCOPE, "meleeContest")?.resolved === true, 3000)) === true);
    await closeWindows();
  }
  // miss: the defender's extra +40 in the window
  {
    const w1 = windows().length;
    await swing(blade, { extraMod: 0 }, [defTok]);
    card = await waitFor(() => flagged("meleeContest").find(m => !m.getFlag(SCOPE, "meleeContest")?.resolved), 6000);
    const rr = card ? await rollWindowDefault(card, { extra: 40 }) : { opened: false, noCard: true, shots: shots.length };
    add("§2 verdict: the defender's +40 beats the attack → miss", rr.result?.verdict === "miss", JSON.stringify({ v: rr.result?.verdict, o: rr.opened, stale: rr.stale, err: rr.openErr, closed: rr.closed, noCard: rr.noCard, lastShot: shots.at(-1) }));
    await sleep(1200);
    add("§2 consequence: a miss opens nothing", windows().length === w1, windows().length);
    add("§2 result: the breakdown names the skill and both totals", rr.result && Number.isFinite(rr.result.defenseTotal) && Number.isFinite(rr.result.attackTotal) && typeof rr.result.skillLabel === "string" && rr.result.skillLabel.length > 0, JSON.stringify(rr.result));
  }
  // the declared dodge is the attacker's −2, never a defender +2
  {
    await defender.setFlag(SCOPE, "dodging", true);
    await swing(blade, { extraMod: 0 }, [defTok]);
    card = await waitFor(() => flagged("meleeContest").find(m => !m.getFlag(SCOPE, "meleeContest")?.resolved), 6000);
    const rr = card ? await rollWindowDefault(card) : { opened: false };
    const d = rr.result?.defense ?? {};
    add("§2 dodge: the defense total is REF + skill + key + extra + die with NO declaration bonus", rr.result && d.total === d.ref + d.level + (d.key || 0) + (d.extra || 0) + d.die && !("stance" in d), JSON.stringify(d));
    await defender.unsetFlag(SCOPE, "dodging");
    await sleep(800); await closeWindows();
  }
  // stunned: `unconscious` status → the card resolves itself as a hit
  {
    const w2 = windows().length;
    await defender.toggleStatusEffect("unconscious", { active: true }); await sleep(300);
    await swing(blade, { extraMod: 0 }, [defTok]);
    card = await waitFor(() => flagged("meleeContest").find(m => m.getFlag(SCOPE, "meleeContest")?.cannotDefend === true), 6000);
    add("§2 stunned: the contest card states the defender cannot defend (p.104)", !!card);
    const opened = await waitFor(() => windows().length > w2, 8000);
    add("§2 stunned: the apply window opens without any defense roll", !!opened, windows().length);
    await defender.toggleStatusEffect("unconscious", { active: false });
    await closeWindows(); await sleep(300);
  }
  // one card for a status manoeuvre; the effect lands on the hit verdict; no old offer card
  {
    const offersBefore = game.messages.contents.filter(m => /martial-defense-offer/.test(m.content)).length;
    const contestsBefore = flagged("meleeContest").length;
    await swing(fists, { action: "Hold", martialArt: "Brawling", extraMod: 40 }, [defTok]);
    card = await waitFor(() => flagged("meleeContest").find(m => !m.getFlag(SCOPE, "meleeContest")?.resolved), 6000);
    add("§2 manoeuvre: exactly one contest card and no legacy offer card", flagged("meleeContest").length === contestsBefore + 1 && game.messages.contents.filter(m => /martial-defense-offer/.test(m.content)).length === offersBefore, JSON.stringify({ c: flagged("meleeContest").length - contestsBefore }));
    add("§2 manoeuvre: the card names the action", card?.getFlag(SCOPE, "meleeContest")?.action === "Hold", card?.getFlag(SCOPE, "meleeContest")?.action);
    const rr = card ? await rollWindowDefault(card) : { opened: false };
    const held = await waitFor(() => defender.getFlag(SCOPE, "heldBy"), 6000);
    add("§2 manoeuvre: the status lands on the hit verdict", rr.result?.verdict === "hit" && held === attacker.id, JSON.stringify({ v: rr.result?.verdict, held }));
    await defender.unsetFlag(SCOPE, "heldBy").catch(() => {});
    await closeWindows();
  }
  // the Throw's −2 rides the stun prompt the APPLY posts (p.111); a plain hit's prompt carries 0
  {
    const promptFor = (from) => game.messages.contents.slice(from).map(m => document.querySelector(`[data-message-id="${m.id}"] .cp-stun-save-roll[data-actor-id="${defender.id}"]`)).filter(Boolean).pop() ?? null;
    const applyAndRead = async () => {
      const win = await waitFor(() => windows()[0], 8000);
      if (!win) return { opened: false };
      await sleep(500);
      const from = game.messages.size;
      win.element.querySelector('button[data-action="applyDamage"]')?.click();
      const btn = await waitFor(() => promptFor(from), 8000);
      return { opened: true, prompt: !!btn, saveMod: btn?.dataset?.saveMod ?? null };
    };
    await swing(fists, { action: "Throw", martialArt: "Brawling", extraMod: 40 }, [defTok]);
    card = await waitFor(() => flagged("meleeContest").find(m => !m.getFlag(SCOPE, "meleeContest")?.resolved), 6000);
    const rt = card ? await rollWindowDefault(card) : { opened: false };
    const thrown = rt.result?.verdict === "hit" ? await applyAndRead() : { opened: false, noHit: true };
    add("§2 throw: the apply's stun prompt carries the Throw's −2 on its control", thrown.prompt && String(thrown.saveMod) === "-2", JSON.stringify({ v: rt.result?.verdict, ...thrown }));
    await closeWindows(); await sleep(300);
    await swing(blade, { extraMod: 40 }, [defTok]);
    card = await waitFor(() => flagged("meleeContest").find(m => !m.getFlag(SCOPE, "meleeContest")?.resolved), 6000);
    const rp = card ? await rollWindowDefault(card) : { opened: false };
    const plain = rp.result?.verdict === "hit" ? await applyAndRead() : { opened: false, noHit: true };
    add("§2 throw (negative): a plain hit's stun prompt carries no penalty", plain.prompt && String(plain.saveMod) === "0", JSON.stringify({ v: rp.result?.verdict, ...plain }));
    await closeWindows(); await sleep(300);
  }
  // parry: arm → the window opens on that arm; blade → no window, a break-save card
  {
    await defender.setFlag(SCOPE, "parrying", { object: "lArm" });
    await swing(blade, { extraMod: 40 }, [defTok]);
    card = await waitFor(() => flagged("meleeContest").find(m => !m.getFlag(SCOPE, "meleeContest")?.resolved), 6000);
    const rr = card ? await rollWindowDefault(card) : { opened: false };
    const win = await waitFor(() => windows()[0], 8000);
    add("§2 parry (arm): the apply window opens on the parrying arm", rr.result?.verdict === "hit" && win && Object.keys(win.payload?.areaDamages ?? {}).join() === "lArm", JSON.stringify(Object.keys(win?.payload?.areaDamages ?? {})));
    await closeWindows();
    const [sword] = await defender.createEmbeddedDocuments("Item", [{ name: "__PW__MC Sword", type: "weapon", system: { weaponType: "Melee", attackType: "Melee", damage: "2d6", equipped: true } }]);
    await defender.setFlag(SCOPE, "parrying", { object: "weapon", itemId: sword.id, bladed: true });
    const wB = windows().length, breaksBefore = flagged("parryBreakSave").length;
    await swing(blade, { extraMod: 40 }, [defTok]);
    card = await waitFor(() => flagged("meleeContest").find(m => !m.getFlag(SCOPE, "meleeContest")?.resolved), 6000);
    const rb = card ? await rollWindowDefault(card) : { opened: false };
    const breakCard = await waitFor(() => flagged("parryBreakSave").length > breaksBefore, 6000);
    await sleep(800);
    add("§2 parry (blade): a hit posts the break-save card and opens no apply window", rb.result?.verdict === "hit" && !!breakCard && windows().length === wB, JSON.stringify({ v: rb.result?.verdict, b: !!breakCard, w: windows().length }));
    await defender.unsetFlag(SCOPE, "parrying"); await sword.delete();
  }
  // negatives: several targets → no contest (the old route: the window); ranged → untouched; counter untouched
  {
    await closeWindows();
    const contests = flagged("meleeContest").length;
    await swing(blade, { extraMod: 0 }, [defTok, atkTok]);
    const openedMulti = await waitFor(() => windows().length > 0, 8000);
    add("§2 several targets: no contest card; the shot takes the route it always did (the apply window)", flagged("meleeContest").length === contests && !!openedMulti, JSON.stringify({ c: flagged("meleeContest").length - contests, w: windows().length }));
    await closeWindows(); await untarget();
    await swing(pistol, { fireMode: "SemiAuto", range: "RangeClose", extraMod: 40 }, [defTok]);
    const opened = await waitFor(() => windows().length > 0, 8000);
    add("§2 ranged: no contest card; the apply window opens as before", flagged("meleeContest").length === contests && !!opened, JSON.stringify({ c: flagged("meleeContest").length - contests, w: windows().length }));
    await closeWindows();
    add("§2 counter: the defense rolls never touched the defender's action count", (Number(defender.getFlag(SCOPE, "actionCount")) || 0) === 0, defender.getFlag(SCOPE, "actionCount"));
  }

  // ── §3 declarations ────────────────────────────────────────────────────────────────────────────
  {
    const warns = [];
    const origWarn = ui.notifications.warn.bind(ui.notifications);
    ui.notifications.warn = (m, ...a) => { warns.push(String(m)); return origWarn(m, ...a); };
    try {
      await ui.combat.render(true); await sleep(700);
      const defRow = document.querySelector(`#combat li.combatant[data-combatant-id="${combat.combatants.find(c => c.actorId === defender.id)?.id}"]`);
      add("§3 stance: the dodge control renders on a NON-current row", !!defRow?.querySelector(".cp-dodge-btn"), defRow ? [...defRow.querySelectorAll("[class*=cp-]")].map(e => e.className).join("|") : "no row");
      await D.toggleDeclaredStance(defender, "dodging", { combat });
      await sleep(300);
      add("§3 stance: declaring after the round began sets the flag AND raises the advisory", defender.getFlag(SCOPE, "dodging") === true && warns.some(w => !/CYBERPUNK\./.test(w) && /round|turn/i.test(w)), JSON.stringify(warns));
      await attacker.setFlag(SCOPE, "parrying", { object: "rArm" });
      await combat.nextRound(); await sleep(900);
      add("§3 stance: both stances clear at round end", !defender.getFlag(SCOPE, "dodging") && !attacker.getFlag(SCOPE, "parrying"), JSON.stringify({ d: defender.getFlag(SCOPE, "dodging"), p: attacker.getFlag(SCOPE, "parrying") }));
      // the style picker opens on the BEST fighting skill: Karate 4 over Brawling 0 for the defender; a fighter
      // with no trained art opens on Brawling (user ruling 2026-10-21 — a weapon-less NPC remembers nothing)
      {
        const pickerFor = async (actor) => {
          await actor.sheet._cpOpenMartialActionDialog({ dataset: { action: "Strike", itemId: "" } });
          const dlg = await waitFor(() => [...foundry.applications.instances.values()].find(a => a.constructor.name === "ModifiersDialog" && a.rendered), 6000);
          await sleep(400);
          const v = dlg?.element?.querySelector('select[name="martialArt"]')?.value ?? null;
          await dlg?.close({ animate: false }).catch(() => {});
          return v;
        };
        const forDefender = await pickerFor(defender), forAttacker = await pickerFor(attacker);
        add("§3 picker: a trained art outranking Brawling is the preselected style", /Karate/.test(forDefender ?? ""), forDefender);
        add("§3 picker (negative): with no trained art the style stays Brawling", forAttacker === "Brawling", forAttacker);
      }
      // the sheet's Dodge button is the same declaration — no lone roll card
      const sheet = attacker.sheet; const msgs = game.messages.size;
      await sheet._cpOpenMartialActionDialog({ dataset: { action: "Dodge", itemId: fists.id } });
      await sleep(700);
      const newMsgs = game.messages.contents.slice(msgs);
      add("§3 sheet: the Dodge button declares the stance and posts no attack-formula card", attacker.getFlag(SCOPE, "dodging") === true && !newMsgs.some(m => (m.rolls ?? []).length > 0), JSON.stringify({ d: attacker.getFlag(SCOPE, "dodging"), rolls: newMsgs.map(m => (m.rolls ?? []).length) }));
      await attacker.unsetFlag(SCOPE, "dodging");
    } finally { ui.notifications.warn = origWarn; }
  }

  // ── §5 the Apply-button target resolver ───────────────────────────────────────────────────────
  {
    await untarget(); await target(atkTok, true);
    const own = D.fallbackTargetFor({ targetTokenId: defTok.id });
    const none = D.fallbackTargetFor({});
    add("§5 apply button: a card with its own target keeps it over the current canvas target", own?.id === defender.id, own?.name);
    add("§5 apply button: an untargeted card takes the current canvas target", none?.id === attacker.id, none?.name);
    await untarget();
  }

  out.ids = { attacker: attacker.id, defender: defender.id, defTok: defTok.id, atkTok: atkTok.id, combat: combat.id, fumbleTableWas: out.notes.fumbleTableWas };
  return out;
});

// ── §4 two clients: permission + the presenter's window ─────────────────────────────────────────
const plCtx = await b.newContext({ viewport: { width: 1600, height: 900 } });
const pl = await plCtx.newPage();
pl.on("pageerror", e => errors.push("pl pageerror: " + e.message));
pl.on("console", m => { if (m.type() === "error") errors.push("pl console: " + m.text()); });
let two = { checks: [] };
try {
  await joinAs(pl, /Test User 1/i, ["", PW]);
  await pl.waitForTimeout(1500);
  const prep = await gm.evaluate(async () => {
    const SCOPE = "cp2020-augmented"; const sleep = (ms) => new Promise(res => setTimeout(res, ms));
    // A PC owned by the player user and an NPC owned by nobody but the GM — built here, not assumed.
    const player = game.users.find(u => /Test User 1/i.test(u.name));
    if (!player) return { error: "no 'Test User 1' on this rig" };
    const rusty = await Actor.create({ name: "__PW__MC Rusty", type: "character", ownership: { default: 0, [player.id]: 3 } });
    const dummy = await Actor.create({ name: "__PW__MC Dummy", type: "npc" });
    await rusty.update({ "system.stats.ref.base": 6 });
    const scene = canvas.scene;
    const [rTok, dTok] = await scene.createEmbeddedDocuments("Token", [
      { name: rusty.name, actorId: rusty.id, actorLink: true, x: scene.dimensions.sceneX + 8 * scene.grid.size, y: scene.dimensions.sceneY + 4 * scene.grid.size },
      { name: dummy.name, actorId: dummy.id, actorLink: true, x: scene.dimensions.sceneX + 9 * scene.grid.size, y: scene.dimensions.sceneY + 4 * scene.grid.size },
    ]);
    const combat = game.combat;
    for (const [tok, actor] of [[rTok, rusty], [dTok, dummy]]) if (!combat.combatants.some(c => c.actorId === actor.id)) await combat.createEmbeddedDocuments("Combatant", [{ tokenId: tok.id, actorId: actor.id, sceneId: scene.id, initiative: 5 }]);
    const [club] = await dummy.createEmbeddedDocuments("Item", [{ name: "__PW__MC Club", type: "weapon", system: { weaponType: "Melee", attackType: "Melee", damage: "1d6" } }]);
    for (const t of [...game.user.targets]) t.setTarget(false, { releaseOthers: false });
    canvas.tokens.get(rTok.id).setTarget(true, { releaseOthers: true }); await sleep(150);
    const before = game.messages.size;
    await club.__weaponRoll({ extraMod: 40, targetArea: "", cyberTerminus: "NoCyberlimb" }, [{ name: rTok.name, id: rTok.id }]);
    await sleep(900);
    const card = game.messages.contents.slice(before).find(m => m.getFlag(SCOPE, "meleeContest"));
    return { rustyId: rusty.id, dummyId: dummy.id, rTokId: rTok.id, dTokId: dTok.id, clubId: club.id, cardId: card?.id ?? null, presenter: card?.getFlag(SCOPE, "meleeContest")?.presenterUserId ?? null, me: game.user.id };
  });
  if (prep.error) two.checks.push({ name: "§4 harness: standing two-client fixtures present", ok: false, detail: prep.error });
  else {
    two.checks.push({ name: "§4 harness: the referee's swing at the player's PC posted a contest card", ok: !!prep.cardId, detail: JSON.stringify(prep) });
    two.checks.push({ name: "§4 presenter: the card names the swinging client as the presenter", ok: prep.presenter === prep.me, detail: `${prep.presenter} vs ${prep.me}` });
    const wBefore = await gm.evaluate(() => [...foundry.applications.instances.values()].filter(a => a.constructor.name === "DamageDialog").length);
    const plr = await pl.evaluate(async ({ cardId, rustyId, dummyId }) => {
      const SCOPE = "cp2020-augmented"; const sleep = (ms) => new Promise(res => setTimeout(res, ms));
      const M = await import("/modules/cp2020-augmented/module/martial/melee-contest.js");
      const waitFor = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_e) { /* retry */ } await sleep(150); } return null; };
      const rusty = game.actors.get(rustyId), dummy = game.actors.get(dummyId);
      const ownPc = M.canChooseDefense(game.user, rusty), npc = M.canChooseDefense(game.user, dummy);
      const card = await waitFor(() => game.messages.get(cardId), 8000);
      const btn = await waitFor(() => document.querySelector(`[data-message-id="${cardId}"] .cp-melee-defense-choose`), 8000);
      let openErr = "";
      M.openDefenseWindow(cardId).catch(e => { openErr = String(e?.message ?? e); });   // not awaited: it settles on the button press below
      const dlg = await waitFor(() => [...foundry.applications.instances.values()].find(a => (a.options?.classes ?? []).includes("cp-melee-defense-dialog") && a.rendered), 6000);
      if (!dlg) await sleep(500);
      const instances = [...foundry.applications.instances.values()].map(a => a.constructor.name).slice(0, 8);
      let rolled = null;
      if (dlg) { await sleep(400); dlg.element.querySelector('button[data-action="roll"]')?.click(); rolled = await waitFor(() => game.messages.contents.find(m => m.getFlag(SCOPE, "meleeResult")?.contestMessageId === cardId), 8000); }
      // the NPC's defense is not this player's to choose
      const warns = []; const ow = ui.notifications.warn.bind(ui.notifications); ui.notifications.warn = (m, ...a) => { warns.push(String(m)); return ow(m, ...a); };
      let refused = null;
      try { refused = await M.openDefenseWindow(cardId, { defenderOverride: dummy }); } catch (_e) { refused = "threw"; } finally { ui.notifications.warn = ow; }
      return { ownPc, npc, sawCard: !!card, sawButton: !!btn, windowOpened: !!dlg, openErr, instances, rolled: !!rolled, verdict: rolled?.getFlag(SCOPE, "meleeResult")?.verdict ?? null, refusedWarn: warns.length };
    }, prep);
    two.checks.push({ name: "§4 permission: the player may choose the defense of their own PC", ok: plr.ownPc === true, detail: JSON.stringify(plr) });
    two.checks.push({ name: "§4 permission: the player may not choose an NPC's defense", ok: plr.npc === false && plr.refusedWarn >= 1, detail: JSON.stringify(plr) });
    two.checks.push({ name: "§4 relay: the player's client sees the card and its choose control", ok: plr.sawCard && plr.sawButton, detail: JSON.stringify(plr) });
    two.checks.push({ name: "§4 relay: the player's roll posts the result card", ok: plr.windowOpened && plr.rolled && plr.verdict === "hit", detail: JSON.stringify(plr) });
    const opened = await gm.evaluate(async (wBefore) => { const sleep = (ms) => new Promise(res => setTimeout(res, ms)); for (let i = 0; i < 50; i++) { const n = [...foundry.applications.instances.values()].filter(a => a.constructor.name === "DamageDialog").length; if (n > wBefore) return n; await sleep(200); } return -1; }, wBefore);
    two.checks.push({ name: "§4 relay: the apply window opens on the presenting (referee) client after the player's roll", ok: opened > wBefore, detail: String(opened) });
    await gm.evaluate(async ({ dummyId, rustyId, rTokId, dTokId }) => {
      for (const a of [...foundry.applications.instances.values()].filter(a => a.constructor.name === "DamageDialog")) await a.close({ animate: false }).catch(() => {});
      await canvas.scene.deleteEmbeddedDocuments("Token", [rTokId, dTokId]).catch(() => {});
      for (const id of [dummyId, rustyId]) await game.actors.get(id)?.delete().catch(() => {});
    }, prep);
  }
} catch (e) { two.checks.push({ name: "§4 two-client leg ran", ok: false, detail: e.message }); }

// cleanup
await gm.evaluate(async (ids) => {
  const SCOPE = "cp2020-augmented";
  for (const a of [...foundry.applications.instances.values()]) if (a.constructor.name === "DamageDialog" || (a.options?.classes ?? []).includes("cp-melee-defense-dialog")) await a.close({ animate: false }).catch(() => {});
  await game.combats.get(ids.combat)?.delete().catch(() => {});
  await canvas.scene.deleteEmbeddedDocuments("Token", [ids.atkTok, ids.defTok]).catch(() => {});
  for (const id of [ids.attacker, ids.defender]) await game.actors.get(id)?.delete().catch(() => {});
  for (const m of game.messages.contents.filter(m => m.getFlag?.(SCOPE, "meleeContest") || m.getFlag?.(SCOPE, "meleeResult") || m.getFlag?.(SCOPE, "parryBreakSave"))) await m.delete().catch(() => {});
  if (ids.fumbleTableWas !== undefined) await game.settings.set("cyberpunk2020", "fumbleTableEnabled", !!ids.fumbleTableWas).catch(() => {});
}, r.ids ?? {});
await b.close();

let fail = 0;
for (const c of [...r.checks, ...two.checks]) { if (!c.ok) fail++; console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "   -> " + c.detail}`); }
console.log("  notes:", JSON.stringify(r.notes ?? {}));
if (seamWarns.length) console.log("  seam warnings:", JSON.stringify(seamWarns.slice(0, 6)));
const errOk = errors.length === 0;
console.log(`  ${errOk ? "PASS" : "FAIL"}  z: 0 console errors${errOk ? "" : "   -> " + errors.slice(0, 4).join(" | ")}`);
if (!errOk) fail++;
const total = r.checks.length + two.checks.length + 1;
console.log(`\nRESULT: ${fail ? "FAIL" : "ALL GREEN"}  ${total - fail}/${total}`);
process.exit(fail ? 1 : 0);
