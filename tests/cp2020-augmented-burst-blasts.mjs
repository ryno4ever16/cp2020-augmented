/** A burst from an automatic grenade launcher is ONE DETONATION PER ROUND (user ruling 2026-10-22; CP2020 p.108 is
 *  written per warhead): each landed round detonates on the aim point with its own rolled damage, each missed round
 *  goes to the grenade table on its own — by the faces the seam rolled for it, in order — and a confirm of one
 *  blast applies that round's damage alone, never the burst's sum. A single semi-automatic shot still places one.
 *  Fixtures as the launcher matrix's: a 1 m range, a Heavy Weapons shooter, the aimed figure at 10 m, the M-32 and
 *  its 40mm HE round from the compiled packs. Red-first; wording names mechanisms. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const b = await chromium.launch({ headless: true });
const gm = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
const errors = [];
gm.on("pageerror", e => errors.push("pageerror: " + e.message));
gm.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 240)); });
await gm.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
const s = gm.locator('select[name="userid"]'); await s.waitFor({ state: "visible", timeout: 30000 });
const us = await s.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
await s.selectOption(us.find(x => /^gamemaster$/i.test(x.l)).v);
await gm.locator('input[name="password"]').fill(PW);
await Promise.all([gm.waitForNavigation({ url: /\/game/, timeout: 20000 }).catch(() => {}), gm.locator('button[name="join"]').click()]);
await gm.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60000 });
await gm.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 60000 });

const r = await gm.evaluate(async () => {
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const SCOPE = "cp2020-augmented";
  const out = { checks: [], notes: {} };
  const add = (name, ok, detail = "") => out.checks.push({ name, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  const waitFor = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_e) {} await sleep(150); } return null; };
  const L = await import("/modules/cp2020-augmented/module/lookups.js");
  const AS = await import("/modules/cp2020-augmented/module/combat/area-shapes.js");
  const ST = await import("/modules/cp2020-augmented/module/combat/scatter-table.js");
  const base = await import("/systems/cyberpunk2020/module/lookups.js").catch(() => ({}));
  const FM = base.fireModes ?? { semiAuto: "SemiAuto", threeRoundBurst: "ThreeRoundBurst", fullAuto: "FullAuto" };
  const fumbleWas = game.settings.get("cyberpunk2020", "fumbleTableEnabled"); await game.settings.set("cyberpunk2020", "fumbleTableEnabled", false);
  const fxWas = game.settings.get(SCOPE, "combatFxEnabled"); await game.settings.set(SCOPE, "combatFxEnabled", false);
  const made = { actors: [], scene: null, msgsFrom: game.messages.size };
  try {
    for (const sc of game.scenes.filter(x => x.name.startsWith("__PW__BB"))) await sc.delete().catch(() => {});
    for (const a of game.actors.filter(a => a.name.startsWith("__PW__BB"))) await a.delete().catch(() => {});
    const scene = await Scene.create({ name: "__PW__BB Range", width: 4000, height: 3000, padding: 0, grid: { type: 1, size: 100, distance: 1, units: "m" }, tokenVision: false, fog: { exploration: false }, backgroundColor: "#303030" });
    made.scene = scene.id; await scene.view(); await sleep(1500);
    const shooter = await Actor.create({ name: "__PW__BB Shooter", type: "character" }); made.actors.push(shooter.id);
    await shooter.update({ "system.stats.ref.base": 10 });
    const hw = shooter.items.find(i => i.type === "skill" && /heavy weapons/i.test(i.name)); if (hw) await hw.update({ "system.level": 10 });
    const target = await Actor.create({ name: "__PW__BB Target", type: "npc" }); made.actors.push(target.id);
    await target.update({ "system.stats.bt.base": 2, "system.damage": 0 });
    const toks = await scene.createEmbeddedDocuments("Token", [
      { name: shooter.name, actorId: shooter.id, actorLink: true, x: 500, y: 1500 },
      { name: target.name, actorId: target.id, actorLink: true, x: 1500, y: 1500 },
    ]);
    await sleep(800);
    const tTok = toks.find(t => t.actorId === target.id); const tc = canvas.tokens.get(tTok.id).center;
    const packDocs = [];
    for (const pack of game.packs.filter(p => p.documentName === "Item")) for (const d of await pack.getDocuments()) packDocs.push(d);
    const Ldoc = packDocs.find(d => d.type === "weapon" && /M-32/.test(d.name)); const Rdoc = packDocs.find(d => d.type === "ammo" && /^40mm HE Grenade$/.test(d.name));
    add("§0 harness: the M-32 and its 40mm HE round are in the compiled packs", !!Ldoc && !!Rdoc, { l: Ldoc?.name, r: Rdoc?.name });
    if (!Ldoc || !Rdoc) return out;
    const own = async (doc) => { const data = game.items.fromCompendium(doc); delete data._id; data.system.equipped = true; const [it] = await shooter.createEmbeddedDocuments("Item", [data]); return it; };
    const launcher = await own(Ldoc); const round = await own(Rdoc); await round.update({ "system.quantity": 50 });
    await launcher.update({ "system.ammoItemId": round.id, "system.shotsLeft": 50 });
    const areas = () => AS.areasByFlag(scene, "isExplosion");
    const clearAreas = async () => { for (const h of areas()) await h.doc.delete().catch(() => {}); await sleep(150); };
    const clearCards = async () => { for (const m of game.messages.contents.filter(m => /__PW__BB|cp-confirm-explosion/.test(m.content ?? ""))) await m.delete().catch(() => {}); };
    let lastPayload = null; Hooks.on("cyberpunk2020.weaponFired", (p) => { lastPayload = p; });
    const fire = async ({ extraMod, fireMode }) => {
      for (const t of [...game.user.targets]) t.setTarget(false, { releaseOthers: false }); canvas.tokens.get(tTok.id).setTarget(true, { releaseOthers: true }); await sleep(120);
      await launcher.update({ "system.shotsLeft": 50 }); await clearAreas(); lastPayload = null;
      const warns = []; const ow = ui.notifications.warn.bind(ui.notifications); ui.notifications.warn = (m, ...a) => { warns.push(String(m)); return ow(m, ...a); };
      let threw = "", timedOut = false;
      const roll = shooter.sheet._cpFireThroughDamageGuard(launcher, () => launcher.__weaponRoll({ fireMode, extraMod, range: "RangeClose", targetArea: "", cyberTerminus: "NoCyberlimb", targetActor: target }, [{ name: tTok.name, id: tTok.id }]));
      await Promise.race([roll.catch(e => { threw = String(e?.message ?? e); }), sleep(8000).then(() => { timedOut = true; })]);
      const expected = Number(lastPayload?.shotsFired) || 1;
      await waitFor(() => areas().length >= expected, 10000); await sleep(700); ui.notifications.warn = ow;
      const list = areas().map(h => { const f = h.doc.flags?.[SCOPE] ?? {}; return { base: Number(f.baseDamage), radius: Number(f.blastRadius), scattered: !!f.scattered, x: Number(f.originX), y: Number(f.originY), aimedX: Number(f.aimedX), aimedY: Number(f.aimedY), dirFace: Number(f.scatterDirFace), driftM: Number(f.scatterDriftM), id: h.doc.id }; });
      return { warns, threw, timedOut, payload: lastPayload, areas: list };
    };
    const hitsOf = (p) => Object.values(p?.areaDamages ?? {}).flat().map(h => Number(h.damage ?? h.dmg) || 0);
    const onAim = (a) => Math.hypot(a.x - tc.x, a.y - tc.y) <= 2;
    const landedAt = (faces) => ST.scatterLandedPoint({ aimedX: tc.x, aimedY: tc.y, pixelsPerMeter: 100, dirFace: faces.dirFace, distFace: faces.distFace, sceneRect: { x: 0, y: 0, width: scene.width, height: scene.height } });

    // ── §1 the burst that lands: one blast per round, the landed ones on the aim point with their own damage ──
    const h = await fire({ extraMod: 40, fireMode: FM.threeRoundBurst });
    const hHits = hitsOf(h.payload); const hMissed = (Number(h.payload?.shotsFired) || 0) - hHits.length;
    out.notes.hit = { fired: h.payload?.shotsFired, hits: hHits, missed: hMissed, faces: h.payload?.blastScatters ?? null, areas: h.areas.map(a => ({ base: a.base, sc: a.scattered, off: Math.round(Math.hypot(a.x - tc.x, a.y - tc.y)) })) };
    add("§1 burst: the card fired three rounds and the seam carried one pair of scatter faces per MISSED round", h.payload?.shotsFired === 3 && Array.isArray(h.payload?.blastScatters) && h.payload.blastScatters.length === hMissed, out.notes.hit);
    add("§1 burst: one blast per round fired, not one summed blast", !h.warns.length && !h.threw && !h.timedOut && h.areas.length === 3, out.notes.hit);
    const landed = h.areas.filter(a => !a.scattered), drifted = h.areas.filter(a => a.scattered);
    add("§1 burst: every landed round's blast sits on the aim point and carries THAT round's rolled damage", landed.length === hHits.length && landed.every((a, i) => onAim(a) && a.base === hHits[i] && a.radius === 5), { landed, hHits });
    add("§1 burst: every missed round's blast sits where its own faces put it, with its own 7d6", drifted.length === hMissed && drifted.every((a, i) => { const p = landedAt(h.payload.blastScatters[i]); return Math.hypot(a.x - p.x, a.y - p.y) <= 2 && a.base >= 7 && a.base <= 42; }), { drifted, faces: h.payload?.blastScatters });
    add("§1 burst: each blast's card names its round of the burst", game.messages.contents.slice(-3).filter(m => /Round [123] of 3/.test((m.content ?? "").replace(/<[^>]+>/g, " "))).length === 3, game.messages.contents.slice(-3).map(m => (m.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)));

    // ── §2 a confirm of ONE landed blast applies that round alone ─────────────────────────────────────
    if (landed.length) {
      const a0 = landed[0]; await target.update({ "system.damage": 0 });
      const btn = await waitFor(() => document.querySelector(`.cp-confirm-explosion[data-template-id="${a0.id}"]`), 4000);
      btn?.click(); await waitFor(() => target.system.damage > 0, 5000); await sleep(600);
      add("§2 confirm: one blast's confirm applies one round's damage to the aimed figure (capped at the track's 40), never the burst's sum", !!btn && target.system.damage === Math.min(40, a0.base), { dmg: target.system.damage, base: a0.base, sum: hHits.reduce((x, y) => x + y, 0) });
    } else add("§2 confirm: a landed round to confirm", false, "no landed round in §1");
    await clearAreas(); await clearCards(); await target.update({ "system.damage": 0 });

    // ── §3 the burst that misses everything: three blasts, all by the table, in order ────────────────
    const m = await fire({ extraMod: -60, fireMode: FM.threeRoundBurst });
    out.notes.miss = { fired: m.payload?.shotsFired, hits: hitsOf(m.payload).length, faces: m.payload?.blastScatters ?? null, areas: m.areas.map(a => ({ base: a.base, sc: a.scattered, dir: a.dirFace, drift: a.driftM })) };
    add("§3 missed burst: three missed rounds, three pairs of faces, three scattered blasts", m.payload?.shotsFired === 3 && hitsOf(m.payload).length === 0 && m.payload?.blastScatters?.length === 3 && m.areas.length === 3 && m.areas.every(a => a.scattered), out.notes.miss);
    add("§3 missed burst: each blast sits where ITS faces land it, carrying its own rolled 7d6", m.areas.length === 3 && m.areas.every((a, i) => { const p = landedAt(m.payload.blastScatters[i]); return Math.hypot(a.x - p.x, a.y - p.y) <= 2 && a.dirFace === m.payload.blastScatters[i].dirFace && a.base >= 7 && a.base <= 42; }), out.notes.miss);
    await clearAreas(); await clearCards();

    // ── §4 a single semi-automatic shot still places exactly one blast ────────────────────────────────
    const one = await fire({ extraMod: 40, fireMode: FM.semiAuto });
    add("§4 single shot: one round, no per-round faces, one blast on the aim point", one.payload?.shotsFired === 1 && one.payload?.blastScatters == null && one.areas.length === 1 && onAim(one.areas[0]), { fired: one.payload?.shotsFired, faces: one.payload?.blastScatters, areas: one.areas.length });
    await clearAreas(); await clearCards();
  } catch (err) { add("suite ran to the end", false, String(err?.stack ?? err).slice(0, 500)); }
  finally {
    await game.settings.set("cyberpunk2020", "fumbleTableEnabled", fumbleWas); await game.settings.set(SCOPE, "combatFxEnabled", fxWas);
    try { for (const h of AS.areasByFlag(canvas.scene, "isExplosion")) await h.doc.delete().catch(() => {}); } catch (_e) {}
    for (const id of made.actors) await game.actors.get(id)?.delete().catch(() => {});
    const mine = game.messages.contents.slice(made.msgsFrom).map(m => m.id); if (mine.length) await ChatMessage.deleteDocuments(mine).catch(() => {});
    if (made.scene) { const bench = game.scenes.find(x => x.id !== made.scene && x.active) ?? game.scenes.find(x => x.id !== made.scene); await bench?.view?.().catch(() => {}); await game.scenes.get(made.scene)?.delete().catch(() => {}); }
  }
  return out;
});
for (const c of r.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "   -> " + c.detail.slice(0, 700)}`);
console.log("  notes:", JSON.stringify(r.notes).slice(0, 900));
const fails = r.checks.filter(c => !c.ok).length + (errors.length ? 1 : 0);
console.log(`  ${errors.length ? "FAIL" : "PASS"}  0 console errors${errors.length ? "   -> " + errors.join(" | ").slice(0, 400) : ""}`);
console.log(`\nRESULT: ${fails ? "FAIL" : "ALL GREEN"}  ${r.checks.length + 1 - fails}/${r.checks.length + 1}`);
await b.close();
process.exit(fails ? 1 : 0);
