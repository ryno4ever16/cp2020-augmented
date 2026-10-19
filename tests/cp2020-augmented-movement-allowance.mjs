/** Movement allowance on the token ruler (CP2020 p.99: Run = MA × 3 m per turn). Legs: the pure budget rule and
 *  the pure advisory decision; the live readers on real documents (Run in scene units, the distance used this
 *  turn from core's per-turn movement history); the ruler tint and readout on the REAL TokenRuler instance of a
 *  token in a started encounter, with the out-of-encounter negative; the drop-time advisory handler. Red-first. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = { checks: [], notes: {} };
  const add = (name, ok, detail = "") => out.checks.push({ name, ok: !!ok, detail: String(detail) });
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const near = (a, b, eps = 0.011) => Math.abs(Number(a) - Number(b)) <= eps;

  let M;
  try { M = await import("/modules/cp2020-augmented/module/combat/movement-allowance.js"); }
  catch (e) { add("§0 module file is served", false, e.message); return out; }
  add("§0 module file is served", true);

  // ── §1 the pure budget rule ───────────────────────────────────────────────────────────────────
  const bud = (usedUnits, runMeters, metersPerUnit = 1) => M.runBudget({ usedUnits, runMeters, metersPerUnit });
  add("§1 budget: under the allowance reads within", bud(10, 15).state === "within", JSON.stringify(bud(10, 15)));
  add("§1 budget: exactly the allowance reads at", bud(15, 15).state === "at", JSON.stringify(bud(15, 15)));
  add("§1 budget: a hair past the allowance reads over", bud(15.01, 15).state === "over", JSON.stringify(bud(15.01, 15)));
  add("§1 budget: no allowance (0 / NaN / missing) reads none", bud(5, 0).state === "none" && bud(5, NaN).state === "none" && bud(5, undefined).state === "none");
  add("§1 budget: a feet scene carries Run into feet", near(bud(0, 15, 0.3048).runUnits, 49.21), bud(0, 15, 0.3048).runUnits);
  add("§1 budget: remaining is floored at zero", bud(20, 15).remainingUnits === 0 && bud(10, 15).remainingUnits === 5, JSON.stringify([bud(20, 15).remainingUnits, bud(10, 15).remainingUnits]));
  add("§1 budget: an unmeasurable path (∞) reads none", bud(Infinity, 15).state === "none");

  // ── §1b the pure advisory decision ────────────────────────────────────────────────────────────
  const w = (o) => M.shouldWarnOverRun({ inCombat: true, isGM: false, totalUnits: 16, runUnits: 15, ...o });
  add("§1 advisory: over the allowance, non-referee, started encounter → advise", w({}) === true);
  add("§1 advisory: a referee is never advised", w({ isGM: true }) === false);
  add("§1 advisory: outside a started encounter → quiet", w({ inCombat: false }) === false);
  add("§1 advisory: exactly the allowance → quiet", w({ totalUnits: 15 }) === false);
  add("§1 advisory: no allowance → quiet", w({ runUnits: 0 }) === false);

  // ── §2 live readers + the real ruler instance ─────────────────────────────────────────────────
  const scene = canvas.scene;
  if (!scene) { add("§2 a viewed scene exists", false, "none"); return out; }
  const gs = scene.grid.size, d = Number(scene.grid.distance) || 1, units = scene.grid.units;
  const mPerUnit = M.metersPerUnitOf(scene);
  out.notes.scene = { gs, d, units, mPerUnit };
  for (const c of game.combats.filter(c => c.combatants.some(x => x.name?.startsWith("__PW__Run")))) await c.delete().catch(() => {});
  for (const t of scene.tokens.filter(t => t.name?.startsWith("__PW__Run"))) await t.delete().catch(() => {});
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Run"))) await a.delete().catch(() => {});

  const actor = await Actor.create({ name: "__PW__Run Mover", type: "character" });
  await actor.update({ "system.stats.ma.base": 5 });
  const runM = M.runMetersOf(actor);
  add("§2 reader: Run comes off the actor's derived MA (MA 5 → 15 m)", runM === 15, runM);
  add("§2 reader: a vehicle-type actor has no Run allowance here", M.runMetersOf({ type: "cp2020-augmented.vehicle", system: { stats: { ma: { run: 30 } } } }) === 0);
  add("§2 reader: a plain object without stats reads 0", M.runMetersOf({ type: "character", system: {} }) === 0 && M.runMetersOf(null) === 0);

  const x0 = scene.dimensions.sceneX + 3 * gs, y0 = scene.dimensions.sceneY + 3 * gs;
  const [tokenDoc] = await scene.createEmbeddedDocuments("Token", [{ name: actor.name, actorId: actor.id, actorLink: true, x: x0, y: y0 }]);
  await sleep(600);
  const placeable = canvas.tokens.get(tokenDoc.id);
  add("§2 harness: the figure is drawn on the viewed scene", !!placeable && canvas.scene?.id === scene.id);

  // Out of any encounter: nothing is active, styles are stock.
  const idle = M.allowanceFor(tokenDoc);
  add("§2 reader: outside an encounter the allowance is inactive", idle.active === false && idle.state === "none", JSON.stringify(idle));

  const combat = await Combat.create({ scene: scene.id, active: true });
  await combat.createEmbeddedDocuments("Combatant", [{ tokenId: tokenDoc.id, actorId: actor.id, sceneId: scene.id, initiative: 10 }]);
  await combat.startCombat();
  await sleep(700);
  const fresh = M.allowanceFor(tokenDoc);
  const runUnits = runM / mPerUnit;
  add("§2 reader: a started encounter activates the allowance at Run in scene units", fresh.active === true && near(fresh.runUnits, runUnits) && fresh.usedUnits === 0 && fresh.state === "within", JSON.stringify(fresh));

  // Move 1: two squares. Core records the history; the reader sums it.
  await tokenDoc.update({ x: x0 + 2 * gs, y: y0 }, { animate: false });
  await sleep(900);
  const after1 = M.allowanceFor(tokenDoc);
  const exp1 = 2 * d;
  add("§2 reader: the distance used this turn is the recorded history (2 squares)", near(after1.usedUnits, exp1) && after1.state === (exp1 < runUnits ? "within" : exp1 === runUnits ? "at" : "over"), JSON.stringify({ after1, exp1, runUnits }));

  // The real ruler instance: tint by cumulative cost, stock otherwise.
  const ruler = placeable.ruler;
  const wp = (cost, extra = {}) => ({ measurement: { cost, distance: cost, backward: { cost: d, distance: d } }, cost: d, actionConfig: { visualize: true, teleport: false }, userId: game.user.id, stage: "planned", previous: { stage: "planned" }, next: null, unreachable: false, intermediate: false, explicit: true, ...extra });
  const stock = ruler._getSegmentStyle(wp(Math.max(0, runUnits - d)));
  const tinted = ruler._getSegmentStyle(wp(runUnits + d));
  const atEdge = ruler._getSegmentStyle(wp(runUnits));
  out.notes.styles = { stock, tinted, atEdge };
  add("§2 ruler: a segment inside the allowance keeps the stock colour", stock.width > 0 && stock.color !== M.RUN_TINT.over && stock.color !== M.RUN_TINT.at, JSON.stringify(stock));
  add("§2 ruler: a segment past the allowance is tinted over", tinted.color === M.RUN_TINT.over && tinted.width > 0, JSON.stringify(tinted));
  add("§2 ruler: a segment ending exactly on the allowance is tinted at", atEdge.color === M.RUN_TINT.at, JSON.stringify(atEdge));
  const gridOver = ruler._getGridHighlightStyle(wp(runUnits + d), { i: 0, j: 0, k: 0 });
  const gridHidden = ruler._getGridHighlightStyle(wp(runUnits + d, { unreachable: true }), { i: 0, j: 0, k: 0 });
  add("§2 ruler: a highlighted square past the allowance is tinted over", gridOver.color === M.RUN_TINT.over && gridOver.alpha > 0, JSON.stringify(gridOver));
  add("§2 ruler: core's own hidden square (alpha 0) stays hidden", !(gridHidden.alpha > 0), JSON.stringify(gridHidden));

  // The readout the label carries: "used / Run" plus a state class, built by the same helper the wrap uses.
  const ro = M.runReadoutFor(tokenDoc, runUnits + d);
  add("§2 readout: past the allowance reads used / Run with the over class", typeof ro.text === "string" && ro.text.includes("/") && ro.cssClass === "cp-run-over", JSON.stringify(ro));
  const roIn = M.runReadoutFor(tokenDoc, d);
  add("§2 readout: inside the allowance carries the within class", roIn.cssClass === "cp-run-within", JSON.stringify(roIn));
  // The real wrap on the real instance, fed a label-complete synthetic waypoint.
  let ctx = null, ctxErr = "";
  try {
    const base = wp(runUnits + d);
    ctx = ruler._getWaypointLabelContext({ ...base, index: 1, elevation: 0, hidden: false, checkpoint: false, ray: { distance: gs }, center: { x: x0, y: y0 }, previous: { ...base, elevation: 0, previous: null, stage: "planned" } }, {});
  } catch (e) { ctxErr = e.message; }
  add("§2 label: the context the template renders carries used / Run and the state class", !!ctx && String(ctx.cost?.total ?? "").includes("/") && /cp-run-over/.test(ctx.cssClass ?? ""), ctx ? JSON.stringify({ total: ctx.cost?.total, units: ctx.cost?.units, cssClass: ctx.cssClass }) : ctxErr);

  // Move 2: far enough to cross the allowance → the reader says over.
  const squaresLeft = Math.max(1, Math.ceil((runUnits - after1.usedUnits) / d) + 1);
  await tokenDoc.update({ x: x0 + (2 + squaresLeft) * gs, y: y0 }, { animate: false });
  await sleep(900);
  const after2 = M.allowanceFor(tokenDoc);
  add("§2 reader: a second move past the allowance reads over", after2.state === "over" && after2.usedUnits > runUnits, JSON.stringify({ after2, squaresLeft }));

  // ── §3 the drop-time advisory handler (the preMoveToken wrap), with the referee exemption ──────
  const warns = [];
  const origWarn = ui.notifications.warn.bind(ui.notifications);
  ui.notifications.warn = (m, ...a) => { warns.push(String(m)); return origWarn(m, ...a); };
  try {
    const move = { history: { cost: after1.usedUnits }, passed: { cost: runUnits }, pending: { cost: 0 } };
    const asReferee = M.advisePreMove(tokenDoc, move);
    add("§3 advisory: the referee's own drop raises nothing", asReferee === undefined && warns.length === 0, JSON.stringify(warns));
    M.advisePreMove(tokenDoc, move, { isGM: false });
    add("§3 advisory: a non-referee drop past the allowance raises the notice and never cancels", warns.length === 1 && /\d/.test(warns[0]) && !/CYBERPUNK\./.test(warns[0]), JSON.stringify(warns));
    warns.length = 0;
    M.advisePreMove(tokenDoc, { history: { cost: 0 }, passed: { cost: d }, pending: { cost: 0 } }, { isGM: false });
    add("§3 advisory: a drop inside the allowance is quiet", warns.length === 0, JSON.stringify(warns));
    add("§3 advisory: the hook is registered", (Hooks.events.preMoveToken ?? []).some(h => String(h.fn?.name ?? h.fn).includes("Allowance") || h.fn?.__cpMovementAllowance === true), (Hooks.events.preMoveToken ?? []).length);
  } finally { ui.notifications.warn = origWarn; }

  // Encounter ends → inactive again, styles stock again (the negative beside every positive).
  await combat.delete(); await sleep(500);
  const ended = M.allowanceFor(tokenDoc);
  const stockAgain = ruler._getSegmentStyle(wp(runUnits + d));
  add("§2 reader: after the encounter ends the allowance is inactive", ended.active === false, JSON.stringify(ended));
  add("§2 ruler: after the encounter ends a long segment is stock again", stockAgain.color !== M.RUN_TINT.over, JSON.stringify(stockAgain));

  await tokenDoc.delete().catch(() => {});
  await actor.delete().catch(() => {});
  return out;
});
await b.close();

let fail = 0;
for (const c of r.checks) { if (!c.ok) fail++; console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "   -> " + c.detail}`); }
console.log("  notes:", JSON.stringify(r.notes));
const errOk = errors.length === 0;
console.log(`  ${errOk ? "PASS" : "FAIL"}  z: 0 console errors${errOk ? "" : "   -> " + errors.slice(0, 3).join(" | ")}`);
if (!errOk) fail++;
console.log(`\nRESULT: ${fail ? "FAIL" : "ALL GREEN"}  ${r.checks.length + 1 - fail}/${r.checks.length + 1}`);
process.exit(fail ? 1 : 0);
