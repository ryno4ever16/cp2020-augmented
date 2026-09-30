/**
 * ATTACK-ROLL BREAKDOWN (user-relayed Discord request 2026-09-30; RYNO: labels like the damage hover,
 * zeros off the visible line).
 *
 * The base card prints "Attack: N" and bare terms. The module now derives a labelled breakdown from the
 * context captured at the trigger pull, VERIFIES it against the roll the card carries, writes it into the
 * card's stored markup as an anchor on the total, and on render binds a hover and hides the zero terms.
 *
 * Legs:
 *   P  pure: signed term reading; reconciliation (match / value mismatch / total mismatch); the extra
 *      term split into the seeded parts + the typed remainder; the martial formula read positionally
 *   E1 ranged shot with aim, running, a typed extra and WA: the stored card carries the anchor, the rows
 *      name die / REF / skill by name / Aim / Running / Extra / WA and sum to the printed total
 *   E2 second action in the round: the seeded multi-action penalty appears as its own named row
 *   E3 melee: zero terms are hidden on the visible line (the "+" and the "0"), rows still carry them
 *   E4 martial Strike: the six positional terms are labelled and reconcile
 *   E5 full auto: the rounds modifier row carries the rounds fired
 *   E6 hover: mouseenter draws the tooltip with every row + total, mouseleave removes it
 * Wording rule: legs are named after the mechanism (reconcile, inject, hide), not the fiction.
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") { const l = m.location?.() ?? {}; errors.push("console: " + m.text() + (l.url ? ` @ ${l.url}:${l.lineNumber ?? "?"}` : "")); } });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = { pure: {}, e: {} };
  const SCOPE = "cp2020-augmented";
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const AB = await import("/modules/cp2020-augmented/module/combat/attack-breakdown.js");

  // ── P: pure ───────────────────────────────────────────────────────────────
  const die = (...results) => ({ faces: 10, results: results.map(r => ({ result: r, active: true })) });
  const op = (o) => ({ operator: o });
  const num = (n) => ({ number: n });
  const roll = (terms, total) => ({ terms, total });
  out.pure.signed = AB.signedNumericTerms(roll([die(9), op("+"), num(8), op("-"), num(3), op("+"), num(-2)], 12));   // [8, -3, -2]
  const ctx = (over = {}) => ({ method: "__semiAuto", isRanged: true, martial: false, ref: 8, wa: 0, skillKey: "Handgun", skillVal: 5, skillLabel: "Handgun", mods: [{ key: "extra", value: -1 }], extraParts: [], martialArt: "", martialAction: "", ...over });
  const ok1 = AB.attackBreakdownRows(roll([die(4), op("+"), num(8), op("+"), num(5), op("-"), num(1)], 16), ctx(), { toHit: 15, hit: true });
  out.pure.match = ok1 ? { keys: ok1.rows.map(r => r.key), values: ok1.rows.map(r => r.value), labels: ok1.rows.map(r => r.label), total: ok1.total, toHit: ok1.toHit, hit: ok1.hit } : null;
  out.pure.valueMismatch = AB.attackBreakdownRows(roll([die(4), op("+"), num(8), op("+"), num(4), op("-"), num(1)], 15), ctx());   // skill 4 vs ctx 5 → null
  out.pure.totalMismatch = AB.attackBreakdownRows(roll([die(4), op("+"), num(8), op("+"), num(5), op("-"), num(1)], 17), ctx());   // sum 16 vs 17 → null
  out.pure.countMismatch = AB.attackBreakdownRows(roll([die(4), op("+"), num(8), op("+"), num(5)], 17), ctx());                    // 2 terms vs 3 → null
  const split = AB.attackBreakdownRows(roll([die(4), op("+"), num(8), op("+"), num(5), op("-"), num(4)], 13), ctx({ mods: [{ key: "extra", value: -4 }], extraParts: [{ key: "multiAction", label: "Multi-action penalty", value: -3 }] }));
  out.pure.split = split ? split.rows.map(r => [r.key, r.value]) : null;   // ..., ["extra:multiAction", -3], ["extra:typed", -1]
  const mart = AB.attackBreakdownRows(roll([die(7), op("+"), num(8), op("+"), num(3), op("+"), num(0), op("+"), num(0), op("+"), num(0), op("+"), num(0)], 18), ctx({ method: "__martialBonk", martial: true, isRanged: false, skillKey: "", mods: [], martialArt: "Karate", martialAction: "Strike" }));
  out.pure.martial = mart ? mart.rows.map(r => [r.key, r.value]) : null;
  out.pure.martialBadRef = AB.attackBreakdownRows(roll([die(7), op("+"), num(7), op("+"), num(3), op("+"), num(0), op("+"), num(0), op("+"), num(0), op("+"), num(0)], 17), ctx({ martial: true, ref: 8, wa: 0, skillKey: "", mods: [] }));
  out.pure.injected = AB.injectAttackBreakdown('<div><span>Attack: </span><span>16</span><span class="flex-pad"></span></div>', ok1);

  // ── E: the real cards ─────────────────────────────────────────────────────
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__ABD"))) await a.delete().catch(() => {});
  const wasFumble = game.settings.get("cyberpunk2020", "fumbleTableEnabled");
  if (wasFumble) await game.settings.set("cyberpunk2020", "fumbleTableEnabled", false);
  const wasPenalty = game.settings.get(SCOPE, "multiActionPenaltyEnabled");
  if (!wasPenalty) await game.settings.set(SCOPE, "multiActionPenaltyEnabled", true);
  const priorCombatId = game.combat?.id ?? null;
  let combat = null;
  const actor = await Actor.create({ name: "__PW__ABD Shooter", type: "character" });
  try {
    await actor.update({ "system.stats.ref.base": 8 });
    // the attack skill, by the name the base resolves it under (actor.getSkillVal → localize("Skill" + key))
    let handgun = actor.itemTypes.skill.find(s => /^handgun$/i.test(s.name));
    if (handgun) await handgun.update({ "system.level": 5, "system.isChipped": false });
    else [handgun] = await actor.createEmbeddedDocuments("Item", [{ name: "Handgun", type: "skill", system: { level: 5, stat: "ref" } }]);
    const mk = (name, system) => ({ name, type: "weapon", system });
    await actor.createEmbeddedDocuments("Item", [
      mk("__PW__ABD Pistol", { weaponType: "Pistol", attackType: "SemiAuto", attackSkill: "Handgun", rof: 2, shots: 12, shotsLeft: 12, damage: "2d6+1", range: 50, accuracy: 1, reliability: "ST", ammoType: "9mm" }),
      mk("__PW__ABD SMG",    { weaponType: "SMG",    attackType: "Auto",     attackSkill: "Handgun", rof: 25, shots: 30, shotsLeft: 30, damage: "2d6+1", range: 150, accuracy: 0, reliability: "ST", ammoType: "9mm" }),
      mk("__PW__ABD Knife",  { weaponType: "Melee",  attackType: "Melee",    attackSkill: "Melee",   rof: 1, damage: "1d6", range: 1, accuracy: 0, reliability: "ST" }),
      mk("__PW__ABD Fist",   { attackType: "Martial", weaponType: "Melee", damage: "1d6", accuracy: 0 }),
    ]);
    const byName = (n) => actor.items.find(i => i.name === `__PW__ABD ${n}`);
    const PISTOL = byName("Pistol"), SMG = byName("SMG"), KNIFE = byName("Knife"), FIST = byName("Fist");
    out.e.fixtures = { skillVal: actor.getSkillVal?.("Handgun"), pistol: !!PISTOL, smg: !!SMG, knife: !!KNIFE, fist: !!FIST, knifeRanged: KNIFE?.isRanged?.() };

    combat = await Combat.create({ scene: null, active: true });
    await combat.createEmbeddedDocuments("Combatant", [{ actorId: actor.id, initiative: 10 }]);
    await combat.startCombat();
    await sleep(600);

    const sheet = actor.sheet; await sheet.render(true); await sleep(900);
    const submitOf = (d) => [...(d.element?.querySelectorAll('button[type="submit"], button.fire') ?? [])].find(bt => bt.offsetParent !== null) ?? null;
    const untilDialog = async (d) => { for (let i = 0; i < 40 && !(d.element?.querySelector("input[name='extraMod']") && submitOf(d)); i++) await sleep(150); return !!submitOf(d); };
    const field = (d, name) => d.element?.querySelector(`[name="fields.${name}"], [name="${name}"], .field[data-path="${name}"] select, .field[data-path="${name}"] input`) ?? null;
    const setField = async (d, name, value) => { const el = field(d, name); if (!el) return false; if (el.type === "checkbox") el.checked = !!value; else el.value = String(value); el.dispatchEvent(new Event("change", { bubbles: true })); el.dispatchEvent(new Event("input", { bubbles: true })); await sleep(150); return true; };
    const parseCard = (m) => {
      const div = document.createElement("div"); div.innerHTML = m?.content ?? "";
      const a = div.querySelector("a.cp-attack-total[data-cp-breakdown]");
      let data = null; try { data = a ? JSON.parse(a.getAttribute("data-cp-breakdown")) : null; } catch { data = "unparseable"; }
      const printedTotal = a ? Number(a.textContent) : null;
      return { anchor: !!a, printedTotal, data, terms: [...div.querySelectorAll(".roll-results .roll-result")].map(s => s.textContent.trim()) };
    };
    const renderedOf = (id) => {
      const el = document.querySelector(`#chat .message[data-message-id="${id}"], .chat-log .message[data-message-id="${id}"], .message[data-message-id="${id}"]`);
      if (!el) return null;
      const results = el.querySelector(".roll-results");
      return { found: true, zeroHidden: results ? results.querySelectorAll(".cp-zero-term").length : null, visible: results ? [...results.querySelectorAll(".roll-result")].filter(s => !s.classList.contains("cp-zero-term")).map(s => s.textContent.trim()) : null, anchor: el.querySelector("a.cp-attack-total") ?? null };
    };
    const fire = async (d) => {
      const before = new Set(game.messages.contents.map(m => m.id));
      submitOf(d)?.click();
      let msg = null;
      for (let i = 0; i < 60 && !msg; i++) { await sleep(150); msg = game.messages.contents.find(m => !before.has(m.id)) ?? null; }
      await sleep(900);
      return msg;
    };
    const open = async (item) => { const d = sheet._cpOpenWeaponAttackDialog(item); const ok = await untilDialog(d); await sleep(250); return { d, ok }; };

    // E1: ranged with aim 2, running, typed extra -1 (the first action of the round: nothing seeded)
    let o = await open(PISTOL);
    const set1 = { aim: await setField(o.d, "aimRounds", 2), running: await setField(o.d, "running", true), extra: await setField(o.d, "extraMod", -1) };
    let msg = await fire(o.d);
    out.e.e1 = { set: set1, card: parseCard(msg), rendered: renderedOf(msg?.id), stored: (msg?.content ?? "").includes("cp-attack-total") };

    // E2: the seeded multi-action penalty shows as its own named row. Shot 2 of an ROF-2 pistol continues
    // the action (nothing seeded - the ROF rule); shot 3 is past the ROF and opens action 2 at -3.
    o = await open(PISTOL); await fire(o.d);
    o = await open(PISTOL);
    await setField(o.d, "aimRounds", 0); await setField(o.d, "running", false);   // the dialog remembers E1's picks
    const seeded = o.d.element?.querySelector("input[name='extraMod']")?.value ?? null;
    msg = await fire(o.d);
    out.e.e2 = { seeded, card: parseCard(msg) };

    // E3: melee - zero terms (skill 0) leave the visible line
    await combat.nextRound(); await sleep(900);
    o = await open(KNIFE);
    msg = await fire(o.d);
    out.e.e3 = { card: parseCard(msg), rendered: renderedOf(msg?.id) };

    // E4: martial Strike - positional labels
    await combat.nextRound(); await sleep(900);
    sheet._cpOpenMartialActionDialog({ dataset: { action: "Strike", itemId: FIST.id } });
    let dm = null;
    for (let i = 0; i < 40 && !dm; i++) { await sleep(150); dm = [...foundry.applications.instances.values()].find(a => a.element?.querySelector?.(".weapon-modifiers") && a.element?.querySelector?.("input[name='extraMod']")) ?? null; }
    const okm = !!dm && !!submitOf(dm); await sleep(250);
    msg = dm ? await fire(dm) : null;
    out.e.e4 = { opened: okm, card: parseCard(msg) };

    // E5: full auto - the rounds modifier row
    await combat.nextRound(); await sleep(900);
    o = await open(SMG);
    await setField(o.d, "fireMode", "FullAuto");
    msg = await fire(o.d);
    out.e.e5 = { card: parseCard(msg) };

    // E6: the hover on the E1 card
    const e1el = document.querySelector(`.message[data-message-id="${out.e.e1.card && msg ? game.messages.contents.find(m => m.content.includes("cp-attack-total"))?.id : ""}"]`);
    const anchor = e1el?.querySelector("a.cp-attack-total") ?? document.querySelector(".message a.cp-attack-total");
    let hover = { anchor: !!anchor };
    if (anchor) {
      anchor.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      await sleep(150);
      const tip = document.querySelector(".cp-attack-tip");
      hover.shown = !!tip;
      hover.rows = tip ? tip.querySelectorAll(".cp-attack-row").length : 0;
      hover.total = tip?.querySelector(".cp-attack-row-total span:last-child")?.textContent ?? null;
      const rowsExpected = (() => { try { return JSON.parse(anchor.getAttribute("data-cp-breakdown")).rows.length; } catch { return null; } })();
      hover.rowsExpected = rowsExpected;
      hover.printed = anchor.textContent;
      anchor.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
      await sleep(100);
      hover.removed = !document.querySelector(".cp-attack-tip");
    }
    out.e.e6 = hover;
    await sheet.close().catch(() => {});
  } catch (e) { out.e.error = String(e?.stack ?? e); }
  finally {
    if (combat) await combat.delete().catch(() => {});
    if (priorCombatId) await game.combats.get(priorCombatId)?.activate().catch(() => {});
    await actor.delete().catch(() => {});
    if (wasFumble) await game.settings.set("cyberpunk2020", "fumbleTableEnabled", true).catch(() => {});
    await game.settings.set(SCOPE, "multiActionPenaltyEnabled", wasPenalty).catch(() => {});
  }
  return out;
});

const legs = [];
const ok = (name, cond, got) => legs.push([name, !!cond, got]);
const J = (x) => JSON.stringify(x);
const P = r.pure;
ok("P1 numeric terms read signed by the operator before them", J(P.signed) === "[8,-3,-2]", J(P.signed));
ok("P2 a matching roll labels die / REF / skill by name / extra and reports the total and To Hit", P.match && J(P.match.keys) === '["die","ref","skill","extra"]' && J(P.match.values) === "[4,8,5,-1]" && P.match.labels[2] === "Handgun" && P.match.total === 16 && P.match.toHit === 15 && P.match.hit === true, J(P.match));
ok("P3 a value mismatch, a total mismatch and a term-count mismatch each yield nothing", P.valueMismatch === null && P.totalMismatch === null && P.countMismatch === null, J([P.valueMismatch, P.totalMismatch, P.countMismatch]));
ok("P4 the extra term splits into the seeded part and the typed remainder", P.split && J(P.split.slice(-2)) === '[["extra:multiAction",-3],["extra:typed",-1]]', J(P.split));
ok("P5 the martial formula reads positionally (REF, art level, key technique, action bonus, extra, called shot)", P.martial && J(P.martial.map(x => x[0])) === '["die","ref","martialLevel","keyTechnique","actionBonus","extra","targetArea"]' && P.martial[2][1] === 3, J(P.martial));
ok("P6 a martial roll whose first term is not the actor's REF yields nothing", P.martialBadRef === null, J(P.martialBadRef));
ok("P7 the anchor is written around the printed total only", /<span>Attack: <\/span><span><a class="cp-attack-total" title="[^"]*" data-cp-breakdown="[^"]+">16<\/a><\/span>/.test(P.injected ?? ""), P.injected);
const E = r.e;
ok("E0 fixtures: Handgun 5, four weapons, knife is melee", E.fixtures?.skillVal === 5 && E.fixtures?.pistol && E.fixtures?.smg && E.fixtures?.knife && E.fixtures?.fist && E.fixtures?.knifeRanged === false, J({ f: E.fixtures, err: E.error }));
const e1 = E.e1 ?? {};
const keys1 = e1.card?.data?.rows?.map(x => x.key) ?? [];
const sum1 = (e1.card?.data?.rows ?? []).reduce((a, x) => a + x.value, 0);
ok("E1a the stored card carries the anchor and a parseable breakdown", e1.stored === true && e1.card?.anchor && typeof e1.card?.data === "object" && e1.card?.data !== null, J({ set: e1.set, stored: e1.stored, anchor: e1.card?.anchor, data: typeof e1.card?.data }));
ok("E1b rows: die, REF 8, Handgun 5, Aim +2, Running -3, Extra -1, WA +1 - and they sum to the printed total", J(keys1) === '["die","ref","skill","aim","running","extra","wa"]' && e1.card?.data?.rows?.[1]?.value === 8 && e1.card?.data?.rows?.[2]?.value === 5 && e1.card?.data?.rows?.[2]?.label === "Handgun" && e1.card?.data?.rows?.[3]?.value === 2 && e1.card?.data?.rows?.[4]?.value === -3 && e1.card?.data?.rows?.[5]?.value === -1 && e1.card?.data?.rows?.[6]?.value === 1 && sum1 === e1.card?.printedTotal && e1.card?.data?.total === e1.card?.printedTotal, J({ keys: keys1, rows: e1.card?.data?.rows, printed: e1.card?.printedTotal }));
ok("E1c To Hit rides the breakdown with the hit verdict", Number.isFinite(e1.card?.data?.toHit) && typeof e1.card?.data?.hit === "boolean", J({ toHit: e1.card?.data?.toHit, hit: e1.card?.data?.hit }));
const e2 = E.e2 ?? {};
const keys2 = e2.card?.data?.rows?.map(x => x.key) ?? [];
const seededN = Number(e2.seeded);
const typedExpected = seededN - (-3);
const typedRow = (e2.card?.data?.rows ?? []).find(x => x.key === "extra:typed");
ok("E2 the seeded multi-action penalty (shot 3, past the ROF) is its own named row; anything else in the field is the typed remainder", Number.isFinite(seededN) && seededN <= -3 && (e2.card?.data?.rows ?? []).find(x => x.key === "extra:multiAction")?.value === -3 && (typedExpected === 0 ? !typedRow : typedRow?.value === typedExpected), J({ seeded: e2.seeded, keys: keys2, rows: e2.card?.data?.rows }));
const e3 = E.e3 ?? {};
const keys3 = e3.card?.data?.rows?.map(x => x.key) ?? [];
ok("E3a melee rows: die, REF, Melee skill (0) - no extra term when nothing was typed", J(keys3) === '["die","ref","skill"]' && e3.card?.data?.rows?.[2]?.value === 0, J({ keys: keys3, rows: e3.card?.data?.rows, terms: e3.card?.terms }));
ok("E3b the rendered line hides the zero term and its operator (2 spans), the rest stays visible", e3.rendered?.found && e3.rendered?.zeroHidden === 2 && Array.isArray(e3.rendered?.visible) && !e3.rendered.visible.includes("0"), J(e3.rendered));
const e4 = E.e4 ?? {};
const keys4 = e4.card?.data?.rows?.map(x => x.key) ?? [];
ok("E4 martial Strike: die + six positional rows, REF 8, reconciled to the printed total", e4.opened && J(keys4) === '["die","ref","martialLevel","keyTechnique","actionBonus","extra","targetArea"]' && e4.card?.data?.rows?.[1]?.value === 8 && e4.card?.data?.total === e4.card?.printedTotal, J({ keys: keys4, rows: e4.card?.data?.rows, printed: e4.card?.printedTotal, terms: e4.card?.terms }));
const e5 = E.e5 ?? {};
const fa = (e5.card?.data?.rows ?? []).find(x => x.key === "fullAuto");
ok("E5 full auto: the rounds-modifier row names the rounds fired and the rows reconcile", e5.card?.anchor && fa && Number(fa.rounds ?? 0) >= 1 && e5.card?.data?.total === e5.card?.printedTotal, J({ rows: e5.card?.data?.rows, printed: e5.card?.printedTotal }));
const e6 = E.e6 ?? {};
ok("E6 hover: the tooltip draws every row plus the total (and To Hit), then leaves on mouseleave", e6.anchor && e6.shown && e6.rowsExpected !== null && e6.rows >= e6.rowsExpected + 1 && String(e6.total) === String(e6.printed) && e6.removed === true, J(e6));
ok("0 console errors", errors.length === 0, J(errors.slice(0, 3)));

let fail = 0;
for (const [n, pass, got] of legs) { if (!pass) fail++; console.log(`${pass ? "PASS" : "FAIL"}  ${n}${pass ? "" : `   [got: ${got}]`}`); }
console.log(`\n${legs.length - fail}/${legs.length} checks passed`);
await b.close();
process.exit(fail ? 1 : 0);
