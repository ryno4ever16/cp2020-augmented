/**
 * KEEPER: the launched-grenade MATRIX — every launcher × every round it accepts, hit AND miss, through the
 * real fire entry (:30004, official 1.1.1 + module). Written 2026-10-21 after the Susano-O was reported
 * unable to fire for the second time; the previous keepers each covered a slice (launcher-rounds: the
 * caliber rule + one Mini-GL shot; grenade-delivery: thrown entry + the Core ladder; area-detonation: the
 * confirm + words) and no keeper walked the whole catalogue.
 *
 *  §1 fixtures: a 1 m-grid range, a Heavy Weapons shooter, four figures at 10 / 12 / 18 / 30 m (the aimed
 *     one, one inside a 2.5 m+ blast, one inside a 10 m blast, one outside everything), BTM 0, no armor.
 *  §2 for every launcher and every round the module's own caliber rule accepts:
 *     HIT  — the shot is not refused, a blast (or cloud) is placed on the aimed figure with the round's
 *            own radius, its base damage is within the round's formula, the confirm lands exactly that on
 *            the aimed figure and the falloff ladder's figure on the bystanders, a word round posts its
 *            consequence (stun prompts at the round's mod / a cloud / blind-deaf marks), the magazine
 *            drops by one and the round's quantity does not.
 *     MISS — the payload carries the two scatter faces, the blast is placed where the shared table puts
 *            them (by value, through the pure site both rails read), and it still confirms.
 *  §3 the EMPTY tube per launcher: the 08-27 ruling — a standard round of the tube's family, not a refusal.
 *  §4 a BURST from an automatic tube: how many blasts, and what each carries.
 *  §5 the thrown grenades (Core six + the module's own four) and the DCR rifle-grenade entry.
 *
 * ⚠ HARNESS: the catalogue is walked from NODE, one launcher per page.evaluate, so a row prints as it
 * lands and a stall is pinned to one launcher (a one-evaluate first draft hung for 50 minutes and said
 * nothing). Every fire is RACED against a deadline — the base's own path can await a prompt — and the
 * presentation rail is stood down (restored in the finally): nothing here reads the picture.
 *
 * Run from tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-launcher-matrix.mjs
 */
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
const errors = [];
gm.on("pageerror", e => errors.push("pageerror: " + e.message));
gm.on("console", m => { if (m.type() === "error") { const loc = m.location?.(); errors.push("console: " + m.text().slice(0, 200) + (loc?.url ? ` @ ${String(loc.url).replace(/^.*\/modules\//, "")}:${loc.lineNumber}` : "")); } });
await joinAs(gm, /^gamemaster$/i, [PW]);
await gm.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 60000 });

const checks = [];
const add = (name, ok, detail = "") => { const c = { name, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) }; checks.push(c); console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "   -> " + c.detail.slice(0, 600)}`); };

// ── §1 setup: fixtures + the page-side helpers, kept on globalThis.__GL between evaluates ─────────
const S = await gm.evaluate(async () => {
  const out = { notes: {} };
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const SCOPE = "cp2020-augmented";
  const G = globalThis.__GL = { SCOPE, sleep, ids: {} };
  G.waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_e) {} await sleep(120); } return null; };
  G.L = await import("/modules/cp2020-augmented/module/lookups.js");
  G.AD = await import("/modules/cp2020-augmented/module/combat/area-delivery.js");
  G.AS = await import("/modules/cp2020-augmented/module/combat/area-shapes.js");
  G.ST = await import("/modules/cp2020-augmented/module/combat/scatter-table.js");
  G.GCB = await import("/modules/cp2020-augmented/module/combat/gas-cloud-behavior.js").catch(() => null);
  const base = await import("/systems/cyberpunk2020/module/lookups.js").catch(() => ({}));
  G.FM = base.fireModes ?? { semiAuto: "SemiAuto", threeRoundBurst: "ThreeRoundBurst", fullAuto: "FullAuto" };
  out.fumbleWas = game.settings.get("cyberpunk2020", "fumbleTableEnabled");
  await game.settings.set("cyberpunk2020", "fumbleTableEnabled", false);
  out.fxWas = game.settings.get(SCOPE, "combatFxEnabled");
  await game.settings.set(SCOPE, "combatFxEnabled", false);
  G.settings = { fumbleWas: out.fumbleWas, fxWas: out.fxWas };
  for (const sc of game.scenes.filter(s => s.name.startsWith("__PW__GL"))) await sc.delete().catch(() => {});
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__GL"))) await a.delete().catch(() => {});
  const scene = await Scene.create({ name: "__PW__GL Range", width: 4000, height: 3000, padding: 0, grid: { type: 1, size: 100, distance: 1, units: "m" }, tokenVision: false, fog: { exploration: false }, backgroundColor: "#303030" });
  G.ids.scene = scene.id; G.scene = scene;
  await scene.view(); await sleep(1500);
  const shooter = await Actor.create({ name: "__PW__GL Shooter", type: "character" });
  await shooter.update({ "system.stats.ref.base": 10 });
  const hw = shooter.items.find(i => i.type === "skill" && /heavy weapons/i.test(i.name));
  if (hw) await hw.update({ "system.level": 10 }); else out.notes.noHeavyWeaponsSkill = true;
  const mkT = async (name) => { const a = await Actor.create({ name, type: "npc" }); await a.update({ "system.stats.bt.base": 2 }); return a; };
  const T = [await mkT("__PW__GL T1 aimed"), await mkT("__PW__GL T2 2m"), await mkT("__PW__GL T3 8m"), await mkT("__PW__GL T4 20m")];
  // The near bystander stands 1.5 m out, not 2.0: a figure exactly on a 2 m blast's circumference is
  // outside the inscribed polygon a Region tests against (run 4 read 0 for it), and the book's own
  // "within" is no clearer on the line — a fixture should not stand on it.
  const positions = [[500, 1500], [1500, 1500], [1650, 1500], [2300, 1500], [3500, 1500]];
  await scene.createEmbeddedDocuments("Token", [
    { name: shooter.name, actorId: shooter.id, actorLink: true, x: positions[0][0], y: positions[0][1] },
    ...T.map((a, i) => ({ name: a.name, actorId: a.id, actorLink: true, x: positions[i + 1][0], y: positions[i + 1][1] })),
  ]);
  G.ids.actors = [shooter.id, ...T.map(a => a.id)];
  await sleep(800);
  G.shooter = shooter; G.T = T;
  const tokOf = (a) => scene.tokens.find(t => t.actorId === a.id);
  G.t1 = tokOf(T[0]); G.t1c = canvas.tokens.get(G.t1.id).center;
  const btm = (a) => Number(a.system.stats?.bt?.modifier ?? a.system.btm ?? 0) || 0;
  out.drawn = [shooter, ...T].every(a => !!canvas.tokens.get(tokOf(a).id));
  out.aimedM = Math.hypot(G.t1.x - positions[0][0], G.t1.y - positions[0][1]) / 100;
  out.btms = T.map(btm); out.armor = T.some(a => a.items.some(i => i.type === "armor"));
  G.dists = T.map(a => Math.hypot(canvas.tokens.get(tokOf(a).id).center.x - G.t1c.x, canvas.tokens.get(tokOf(a).id).center.y - G.t1c.y) / 100);
  // census through the module's own rule
  G.packDocs = [];
  for (const pack of game.packs.filter(p => p.documentName === "Item")) for (const d of await pack.getDocuments()) G.packDocs.push(d);
  G.rounds = G.packDocs.filter(d => d.type === "ammo" && G.L.isGrenadeRoundCaliber(String(d.system?.caliber ?? "")));
  G.launchers = G.packDocs.filter(d => d.type === "weapon" && G.L.isGrenadeRoundCaliber(G.L.normalizeCaliber(String(d.system?.ammoType ?? ""))) && /varies/i.test(String(d.system?.damage ?? "")));
  G.thrown = G.packDocs.filter(d => d.type === "weapon" && G.L.normalizeCaliber(String(d.system?.ammoType ?? "")) === "Grenade" && !/varies/i.test(String(d.system?.damage ?? "")));
  out.census = { rounds: G.rounds.length, launchers: G.launchers.map(d => d.name), thrown: G.thrown.map(d => `${d.name} [${d.system.attackType || "—"}] ${d.system.damage}`), families: ["25mm grenade", "25mm HP grenade", "40mm grenade", "rifle grenade", "Grenade"].filter(c => G.rounds.some(r => G.L.normalizeCaliber(r.system.caliber) === c)) };
  // helpers
  // Imported the way a drag from the compendium imports — fromCompendium stamps `_stats.compendiumSource`,
  // which is the key the corrections layer (data-corrections.js, preCreateItem) applies by: the Core
  // grenades' `effectTypes` / `stunSaveMod` / `dotTurns` live THERE, not on the pack document. A bare
  // toObject() carried none of it and every thrown word grenade read as having no word.
  G.own = async (doc) => { const data = game.items.fromCompendium(doc); delete data._id; data.system.equipped = true; const [it] = await shooter.createEmbeddedDocuments("Item", [data]); return it; };
  // Blasts by their flag; clouds by the Region BEHAVIOUR they carry on v14 (the flag is the v13 template's),
  // the way the area-detonation keeper reads them. One handle per document.
  G.areas = () => {
    const ex = G.AS.areasByFlag(scene, "isExplosion");
    const isCloud = (r) => (r.behaviors?.some?.(bv => bv.type === G.GCB?.GAS_CLOUD_BEHAVIOR) === true) || r.flags?.[SCOPE]?.isGasCloud === true;
    const clouds = [...(scene.regions ?? []), ...(scene.templates ?? [])].filter(isCloud).map(r => ({ doc: r, cloud: true }));
    const seen = new Set(); const all = [];
    for (const h of [...ex, ...clouds]) { if (seen.has(h.doc.id)) continue; seen.add(h.doc.id); all.push(h); }
    return all;
  };
  G.clearAreas = async () => { for (const h of G.areas()) await h.doc.delete().catch(() => {}); await sleep(120); };
  G.resetFigures = async () => { for (const a of T) { await a.update({ "system.damage": 0 }); for (const f of ["wordConditionState", "fireDotState", "dotState"]) await a.unsetFlag(SCOPE, f).catch(() => {}); for (const s of ["unconscious", "blind", "deaf", "prone"]) if (a.statuses?.has(s)) await a.toggleStatusEffect(s, { active: false }).catch(() => {}); } };
  G.clearCards = async () => { for (const m of game.messages.contents.filter(m => /__PW__GL|cp-confirm-explosion|cp-stun-save-roll/.test(m.content ?? ""))) await m.delete().catch(() => {}); };
  G.lastPayload = null; Hooks.on("cyberpunk2020.weaponFired", (p) => { G.lastPayload = p; });
  // Errors WITH THEIR STACKS, as the page raises them: the keeper's console tap only ever saw core's notification
  // mirror (Notifications#fetch) for the "reading '_id'" error of runs 4-7, which names the mirror and not the
  // thrower, and a targeted re-fire of the accused launcher (every round, the empty tube, a burst) raised nothing.
  // Captured here per launcher so the next sighting names its site.
  G.caught = [];
  const capErr = (kind, loc, err) => G.caught.push({ kind, loc: String(loc ?? ""), msg: String(err?.message ?? err ?? "").slice(0, 200), stack: String(err?.stack ?? "").split("\n").slice(0, 7).join(" | ").slice(0, 900) });
  Hooks.on("error", (loc, err) => capErr("hook:error", loc, err));
  const origNotifyErr = ui.notifications.error.bind(ui.notifications);
  ui.notifications.error = (m, o) => { capErr("notifications.error", "", m); return origNotifyErr(m, o); };
  window.addEventListener("unhandledrejection", (ev) => capErr("unhandledrejection", "", ev.reason));
  G.tapWarn = () => { const seen = []; const ow = ui.notifications.warn.bind(ui.notifications); ui.notifications.warn = (m, ...a) => { seen.push(String(m)); return ow(m, ...a); }; return { seen, off: () => { ui.notifications.warn = ow; } }; };
  G.target = async () => { for (const t of [...game.user.targets]) t.setTarget(false, { releaseOthers: false }); canvas.tokens.get(G.t1.id).setTarget(true, { releaseOthers: true }); await sleep(100); };
  G.fire = async (weapon, { extraMod = 40, fireMode = G.FM.semiAuto } = {}) => {
    await G.target(); await G.clearAreas();
    // A full tube before every shot: a single-shot launcher refused the miss leg with "magazine empty"
    // after the hit leg had spent its one round. The magazine leg reads the drop against this reload.
    await weapon.update({ "system.shotsLeft": Math.max(1, Number(weapon.system.shots) || 1) });
    G.lastPayload = null; const tap = G.tapWarn(); const before = game.messages.size; const shots0 = Number(weapon.system.shotsLeft);
    let threw = "", timedOut = false;
    // Through the sheet's fire guard, as the attack gesture fires — it is what hands a launcher the
    // round's warhead in place of its printed "Varies (…)" (and refuses with a message when nothing can).
    const mods = { fireMode, extraMod, range: "RangeClose", targetArea: "", cyberTerminus: "NoCyberlimb", targetActor: T[0] };
    const roll = shooter.sheet._cpFireThroughDamageGuard(weapon, () => weapon.__weaponRoll(mods, [{ name: G.t1.name, id: G.t1.id }]));
    await Promise.race([roll.catch(e => { threw = String(e?.message ?? e); }), sleep(8000).then(() => { timedOut = true; })]);
    const area = await G.waitFor(() => G.areas()[0], 4000);
    await sleep(300); tap.off();
    return { payload: G.lastPayload, area: area ?? null, areasN: G.areas().length, warns: tap.seen, threw, timedOut, cards: game.messages.size - before, shotsBefore: shots0, shotsAfter: Number(shooter.items.get(weapon.id)?.system?.shotsLeft) };
  };
  G.confirmArea = async (h) => {
    const btn = await G.waitFor(() => document.querySelector(`.cp-confirm-explosion[data-template-id="${h.doc.id}"]`), 4000);
    if (!btn) return { confirmed: false };
    const dmg0 = T.map(a => a.system.damage); const msgs0 = game.messages.size;
    btn.click();
    await G.waitFor(() => T.some((a, i) => a.system.damage !== dmg0[i]) || game.messages.size > msgs0 + 1, 4000);
    await sleep(700);
    const prompts = game.messages.contents.slice(msgs0).map(m => document.querySelector(`[data-message-id="${m.id}"] .cp-stun-save-roll`)).filter(Boolean).map(el => ({ actorId: el.dataset.actorId, saveMod: el.dataset.saveMod }));
    return { confirmed: true, dmg: T.map(a => a.system.damage), prompts, words: T.map(a => (a.getFlag(SCOPE, "wordConditionState") ?? [])), fire: T.map(a => (a.getFlag(SCOPE, "fireDotState") ?? []).length), gas: G.AS.areasByFlag(scene, "isGasCloud").length };
  };
  G.centreOf = (h) => { const s = h.doc.shapes?.[0]; return { x: Number(h.doc.flags?.[SCOPE]?.originX ?? s?.x ?? h.doc.x), y: Number(h.doc.flags?.[SCOPE]?.originY ?? s?.y ?? h.doc.y) }; };
  G.bandMult = (distM, radius, fullR = 1, mults = [0.5, 0.25, 0.125, 0.0625]) => { if (distM > radius) return 0; if (distM <= fullR) return 1; const span = Math.max(0.0001, radius - fullR); const bb = Math.min(mults.length - 1, Math.max(0, Math.floor(((distM - fullR) / span) * mults.length))); return mults[bb]; };
  return out;
});
add("§1 harness: five figures drawn on the range, aimed figure at 10 m", S.drawn && S.aimedM === 10, S);
add("§1 harness: the figures carry no BTM and no armor", S.btms.every(v => v === 0) && !S.armor, S.btms);
add("§1 census: the typed round families are all present in the compiled packs", S.census.families.length === 5, S.census);
console.log("  census:", JSON.stringify(S.census));

// ── §2 / §3 one launcher per evaluate ───────────────────────────────────────────────────────────
const runLauncher = async (name) => gm.evaluate(async (name) => {
  const G = globalThis.__GL, { SCOPE, sleep } = G;
  const rows = [];
  const Ldoc = G.launchers.find(d => d.name === name);
  const launcher = await G.own(Ldoc);
  const accepted = G.rounds.filter(rd => G.L.caliberMatches(String(launcher.system.ammoType ?? ""), String(rd.system.caliber ?? "")));
  for (const Rdoc of accepted) {
    const round = await G.own(Rdoc); await round.update({ "system.quantity": 5 });
    await launcher.update({ "system.ammoItemId": round.id, "system.shotsLeft": launcher.system.shots || 1 });
    const rs = Rdoc.system, word = (rs.effectTypes ?? []).find(w => ["Stun", "Blind", "Deaf", "Gas"].includes(w)) ?? null;
    const formula = G.AD.roundDamageOf(rs);
    // Every tube here is a grenade delivery (by attack class or by family), so a round that states no
    // radius of its own takes the book's grenade row (p.99 5 m), whatever the tube's attack class.
    const expRadius = Number(rs.blastRadius) || G.AD.AREA_DELIVERY_RADIUS_M.grenade;
    const row = { launcher: Ldoc.name, round: Rdoc.name, caliber: rs.caliber, attackType: launcher.system.attackType, formula, word, radius: expRadius, stunMod: rs.stunSaveMod ?? null };
    await G.resetFigures();
    const h = await G.fire(launcher, { extraMod: 40 });
    row.hit = { refused: h.warns.length > 0 || !!h.threw, warns: h.warns.map(w => w.slice(0, 100)), threw: h.threw, timedOut: h.timedOut, placed: !!h.area, areasN: h.areasN, shots: [h.shotsBefore, h.shotsAfter], qty: Number(G.shooter.items.get(round.id)?.system?.quantity), cards: h.cards };
    if (h.area) {
      const f = h.area.doc.flags?.[SCOPE] ?? {}; const c = G.centreOf(h.area);
      row.hit.centreOff = Math.round(Math.hypot(c.x - G.t1c.x, c.y - G.t1c.y)); row.hit.radius = Number(f.blastRadius ?? h.area.radiusM ?? NaN); row.hit.base = Number(f.baseDamage ?? NaN); row.hit.scattered = !!f.scattered; row.hit.gas = !!f.isGasCloud || !!h.area.cloud;
      if (h.area.cloud) { const sh = h.area.doc.shapes?.[0]; row.hit.radius = Number.isFinite(Number(sh?.radiusX)) ? Number(sh.radiusX) / 100 : row.hit.radius; }
      const cf = await G.confirmArea(h.area); row.hit.confirm = cf;
      // The wound track caps at 40 (the module's cappedWoundDamage): a 49-point HEAT hit lands as 40.
      if (cf.confirmed) { row.hit.t = cf.dmg; row.hit.expT1 = Math.min(40, row.hit.base); row.hit.expT2 = Math.min(40, Math.floor(row.hit.base * G.bandMult(G.dists[1], row.hit.radius))); row.hit.expT3 = Math.min(40, Math.floor(row.hit.base * G.bandMult(G.dists[2], row.hit.radius))); }
    }
    await G.resetFigures(); await G.clearCards();
    const m = await G.fire(launcher, { extraMod: -60 });
    row.miss = { refused: m.warns.length > 0 || !!m.threw, warns: m.warns.map(w => w.slice(0, 100)), timedOut: m.timedOut, placed: !!m.area, faces: m.payload?.blastScatter ?? null, hitFlag: m.payload?.baseHit ?? null };
    if (m.area) {
      const f = m.area.doc.flags?.[SCOPE] ?? {}; const c = G.centreOf(m.area); const faces = m.payload?.blastScatter;
      const expect = faces ? G.ST.scatterLandedPoint({ aimedX: G.t1c.x, aimedY: G.t1c.y, pixelsPerMeter: 100, dirFace: faces.dirFace, distFace: faces.distFace, sceneRect: { x: 0, y: 0, width: G.scene.width, height: G.scene.height } }) : null;
      row.miss.scattered = !!f.scattered; row.miss.driftM = Number(f.scatterDriftM ?? NaN); row.miss.offPx = expect ? Math.round(Math.hypot(c.x - expect.x, c.y - expect.y)) : null; row.miss.expDrift = expect?.driftM ?? null; row.miss.base = Number(f.baseDamage ?? NaN);
      const cf = await G.confirmArea(m.area); row.miss.confirmed = cf.confirmed;
    }
    await G.clearAreas(); await G.clearCards();
    rows.push(row);
    await round.delete().catch(() => {});
  }
  await launcher.update({ "system.ammoItemId": "", "system.shotsLeft": launcher.system.shots || 1 });
  await G.resetFigures();
  const e = await G.fire(launcher, { extraMod: 40 });
  const f = e.area?.doc.flags?.[SCOPE] ?? null;
  rows.push({ launcher: Ldoc.name, round: "(empty tube)", attackType: launcher.system.attackType, empty: { refused: e.warns.length > 0 || !!e.threw, warns: e.warns.map(w => w.slice(0, 100)), timedOut: e.timedOut, placed: !!e.area, base: f ? Number(f.baseDamage) : null, radius: f ? Number(f.blastRadius) : null } });
  await G.clearAreas(); await G.clearCards();
  await launcher.delete().catch(() => {});
  return { rows, caught: G.caught.splice(0) };
}, name);

const allRows = [];
let diceRows = 0, wordRows = 0;
for (const name of S.census.launchers) {
  let rows, caught;
  const errsBefore = errors.length;
  try { ({ rows, caught } = await runLauncher(name)); }
  catch (e) { add(`§2 ${name}: the launcher's rows ran`, false, String(e?.message ?? e).slice(0, 300)); continue; }
  // A page/console error is attributed to the launcher whose rows were running when it was raised — and the
  // page-side capture prints the thrower's own stack beside it.
  if (errors.length > errsBefore) console.log(`  console/page errors during ${name}: ${errors.slice(errsBefore).join(" | ").slice(0, 400)}`);
  if (caught?.length) console.log(`  caught during ${name}: ${JSON.stringify(caught).slice(0, 1500)}`);
  allRows.push(...rows);
  for (const x of rows) {
    if (x.empty) { add(`§3 ${x.launcher}: an EMPTY tube fires a standard round of its family (08-27 ruling), not a refusal`, !x.empty.refused && !x.empty.timedOut && x.empty.placed && x.empty.base > 0, x.empty); continue; }
    const tag = `${x.launcher} ← ${x.round}`, H = x.hit, M = x.miss;
    add(`§2 ${tag}: HIT fires (not refused) and places an area on the aimed figure with the round's radius`, !H.refused && !H.timedOut && H.placed && H.centreOff <= 2 && Math.abs(H.radius - x.radius) < 0.01, { refused: H.refused, warns: H.warns, threw: H.threw, timedOut: H.timedOut, placed: H.placed, off: H.centreOff, radius: [H.radius, x.radius], cards: H.cards });
    if (H.placed) {
      const fr = x.formula && x.formula.match(/^\s*(\d+)d(\d+)([+-]\d+)?\s*$/i) ? { n: +RegExp.$1, d: +RegExp.$2, k: +(RegExp.$3 || 0) } : null;
      if (fr && !x.word) { diceRows++; add(`§2 ${tag}: base within ${x.formula}; confirm lands it exactly on the aimed figure and the ladder's figure on the bystanders`, H.base >= fr.n + fr.k && H.base <= fr.n * fr.d + fr.k && H.confirm?.confirmed && H.t?.[0] === H.expT1 && H.t?.[1] === H.expT2 && H.t?.[2] === H.expT3 && H.t?.[3] === 0, { base: H.base, t: H.t, exp: [H.expT1, H.expT2, H.expT3, 0], radius: H.radius }); }
      if (x.word) {
        wordRows++;
        const inRadius = [0, 2, 8, 20].filter(d => d <= x.radius).length;
        if (x.word === "Stun") add(`§2 ${tag}: STUN word — one prompt per figure in the radius at the round's modifier`, H.confirm?.prompts?.length === inRadius && H.confirm.prompts.every(p => Number(p.saveMod) === (Number(x.stunMod) || 0)), { prompts: H.confirm?.prompts, inRadius, stunMod: x.stunMod });
        if (x.word === "Gas") add(`§2 ${tag}: GAS word — a cloud is placed`, H.gas || H.confirm?.gas > 0, { gas: H.gas, cloudsAfter: H.confirm?.gas });
        if (x.word === "Blind" || x.word === "Deaf") add(`§2 ${tag}: ${x.word} word — the aimed figure carries the mark after the confirm`, (H.confirm?.words?.[0] ?? []).some(w => w.word === x.word), H.confirm?.words?.[0]);
      }
      add(`§2 ${tag}: the magazine drops by one on the shot and the round's quantity is untouched`, H.shots[1] === H.shots[0] - 1 && H.qty === 5, { shots: H.shots, qty: H.qty });
    }
    add(`§2 ${tag}: MISS carries two scatter faces and places the blast where the shared table puts them`, !M.refused && !M.timedOut && M.placed && M.faces && M.scattered && M.offPx <= 2 && M.driftM === M.expDrift, { refused: M.refused, warns: M.warns, timedOut: M.timedOut, placed: M.placed, faces: M.faces, hitFlag: M.hitFlag, off: M.offPx, drift: [M.driftM, M.expDrift] });
  }
}

// ── §4 a burst from an automatic tube; §5 the thrown grenades + the DCR entry ───────────────────
const tail = await gm.evaluate(async () => {
  const G = globalThis.__GL, { SCOPE, sleep } = G; const out = { thrown: [] };
  const Ldoc = G.launchers.find(d => /M-32/.test(d.name)); const Rdoc = G.rounds.find(d => /^40mm HE Grenade$/.test(d.name));
  if (Ldoc && Rdoc) {
    const launcher = await G.own(Ldoc); const round = await G.own(Rdoc); await round.update({ "system.quantity": 50 });
    await launcher.update({ "system.ammoItemId": round.id, "system.shotsLeft": 50 });
    await G.resetFigures();
    const bst = await G.fire(launcher, { extraMod: 40, fireMode: G.FM.threeRoundBurst });
    await sleep(1200);
    out.burst = { launcher: Ldoc.name, round: Rdoc.name, refused: bst.warns.length > 0 || !!bst.threw, warns: bst.warns, timedOut: bst.timedOut, shotsFired: bst.payload?.shotsFired ?? null, shotsHit: bst.payload?.shotsHit ?? null, hits: Object.values(bst.payload?.areaDamages ?? {}).flat().length, areas: G.areas().map(h => ({ base: Number(h.doc.flags?.[SCOPE]?.baseDamage), radius: Number(h.doc.flags?.[SCOPE]?.blastRadius) })), shots: [bst.shotsBefore, bst.shotsAfter] };
    await G.clearAreas(); await G.clearCards(); await launcher.delete().catch(() => {}); await round.delete().catch(() => {});
  }
  for (const Tdoc of G.thrown) {
    const g = await G.own(Tdoc); await g.update({ "system.shotsLeft": 1 });
    await G.resetFigures();
    const th = await G.fire(g, { extraMod: 40 });
    const f = th.area?.doc.flags?.[SCOPE] ?? null;
    out.thrown.push({ name: Tdoc.name, attackType: Tdoc.system.attackType, damage: Tdoc.system.damage, refused: th.warns.length > 0 || !!th.threw, warns: th.warns.map(w => w.slice(0, 100)), threw: th.threw.slice(0, 100), timedOut: th.timedOut, placed: !!th.area, base: f ? Number(f.baseDamage) : null, radius: f ? Number(f.blastRadius) : null, gas: !!f?.isGasCloud, word: f?.wordWarhead ?? null });
    await G.clearAreas(); await G.clearCards(); await g.delete().catch(() => {});
  }
  const dcr = G.packDocs.find(d => d.type === "weapon" && /DCR Rifle Grenades/.test(d.name));
  if (dcr) { const rifleRound = G.rounds.find(d => /^Rifle Grenade, HE$/.test(d.name)); const coreRound = G.rounds.find(d => /^Fragmentation Grenade Round$/.test(d.name)); out.dcr = { ammoType: dcr.system.ammoType, damage: dcr.system.damage, acceptsRifleHE: G.L.caliberMatches(dcr.system.ammoType, rifleRound?.system?.caliber ?? ""), acceptsCoreFrag: G.L.caliberMatches(dcr.system.ammoType, coreRound?.system?.caliber ?? "") }; }
  return out;
});
if (tail.burst) { console.log("  burst detail:", JSON.stringify(tail.burst)); add(`§4 ${tail.burst.launcher}: a three-round burst — one blast per round that landed, each carrying one round's damage`, !tail.burst.refused && !tail.burst.timedOut && tail.burst.hits >= 2 && tail.burst.areas.length === tail.burst.hits && tail.burst.areas.every(a => a.base >= 7 && a.base <= 42), tail.burst); }
for (const x of tail.thrown) add(`§5 thrown ${x.name} [${x.attackType || "—"}] "${x.damage}": throws and places its warhead`, !x.refused && !x.timedOut && x.placed, x);
if (tail.dcr) add("§5 DCR Rifle Grenades: chambered for the rifle-grenade family (loads 'Rifle Grenade, HE'), not the Core hand-grenade caliber", tail.dcr.acceptsRifleHE === true, tail.dcr);

// ── cleanup ──────────────────────────────────────────────────────────────────────────────────────
await gm.evaluate(async () => {
  const G = globalThis.__GL; if (!G) return;
  try { await game.settings.set("cyberpunk2020", "fumbleTableEnabled", !!G.settings?.fumbleWas); } catch (_e) {}
  try { await game.settings.set(G.SCOPE, "combatFxEnabled", !!G.settings?.fxWas); } catch (_e) {}
  for (const m of game.messages.contents.filter(m => /__PW__GL|cp-confirm-explosion|cp-stun-save-roll/.test(m.content ?? ""))) await m.delete().catch(() => {});
  for (const id of (G.ids.actors ?? [])) await game.actors.get(id)?.delete().catch(() => {});
  if (G.ids.scene) { const bench = game.scenes.find(s => s.id !== G.ids.scene && s.active) ?? game.scenes.find(s => s.id !== G.ids.scene); if (bench) await bench.view().catch(() => {}); await game.scenes.get(G.ids.scene)?.delete().catch(() => {}); }
}).catch(e => add("cleanup ran", false, String(e?.message ?? e)));
await b.close();

const errOk = errors.length === 0;
add("0 console errors", errOk, errors.slice(0, 5).join(" | "));
const fail = checks.filter(c => !c.ok).length;
console.log(`  rows: ${allRows.filter(x => x.hit).length} launcher×round (${diceRows} dice, ${wordRows} word) · empty ${allRows.filter(x => x.empty).length} · thrown ${tail.thrown.length}`);
console.log(`\nRESULT: ${fail ? "FAIL" : "ALL GREEN"}  ${checks.length - fail}/${checks.length}`);
process.exit(fail ? 1 : 0);
