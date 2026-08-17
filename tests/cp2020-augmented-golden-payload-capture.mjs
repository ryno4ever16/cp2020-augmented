/**
 * GOLDEN PAYLOAD CAPTURE — records what the LIVE seam emits, one entry per fire mode.
 *
 * ⭐ WHY THIS FILE EXISTS. `module/seam-shim.js` assembles the `cyberpunk2020.weaponFired` payload out
 * of three sources — the fire method's captured context, the fire card's own computed render data, and
 * the loaded ammo's `ammoEffectFields` — and sets roughly forty fields. Every keeper that exercises the
 * presentation rail used to hand-build that object as a four-field literal, so the rail was driven
 * against a shape it never receives (VACUOUS-LEG-AUDIT F1). This spec pulls a REAL trigger once per
 * fire mode, reads the emission off the hook, and writes it to `tests/golden-weaponfired-payloads.json`
 * for `golden-payload.mjs` to hydrate from. Nobody hand-writes the shape again.
 *
 * It is a CAPTURE spec, not an assertion spec: it still gates (the emission has to arrive, and the
 * world has to come back the way it was found), but its product is the fixture file. Re-run it whenever
 * the producer changes and the contract leg in `cp2020-augmented-b1-seam-payload.mjs` names a drift.
 *
 * VOLATILE IDENTIFIERS. Anything that cannot be stable across worlds — actor, token, weapon, user ids —
 * is written out as a `@@…@@` placeholder marker; the hydrator re-fills them from whatever fixtures the
 * consuming suite built. Everything else is stored as captured.
 *
 * It restores what it disturbs: magazines refilled, bench damage zeroed, its own cards deleted, dialogs
 * closed, canvas effects ended, targets released. It touches no setting and creates no world document.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=<pw> node cp2020-augmented-golden-payload-capture.mjs
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "golden-weaponfired-payloads.json");

const checks = [];
const ok = (n, p, d = "") => { checks.push({ n, p: !!p, d: String(d) }); console.log(`${p ? "  ok  " : "  FAIL"}  ${n}${d ? `   [${d}]` : ""}`); };

async function joinGM(p) {
  await p.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const s = p.locator('select[name="userid"]');
  await s.waitFor({ state: "visible", timeout: 30000 });
  const us = await s.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  await s.selectOption(us.find(u => /gamemaster/i.test(u.l)).v);
  await p.locator('input[name="password"]').fill(PW);
  await Promise.all([
    p.waitForNavigation({ url: /\/game/, timeout: 45000 }).catch(() => {}),
    p.locator('button[name="join"]').click(),
  ]);
  await p.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60000 });
}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
p.on("pageerror", e => errors.push(String(e.message)));
await joinGM(p);
await p.waitForTimeout(2500);

/* ══ setup: the bench, its scene, and a full-fidelity recorder on both seam hooks ═════════════════ */
const setup = await p.evaluate(async (SCOPE) => {
  // The recorder keeps the payload WHOLE — no field list, because a field list is exactly the thing
  // this fixture exists to stop anybody writing by hand. `undefined` is preserved as its own marker so
  // the hydrator can restore it: the producer sets several fields to `undefined` rather than null, and
  // a consumer doing `Number.isFinite(Number(v))` reads null as a finite ZERO and undefined as NaN.
  const typeOf = (v) => v === undefined ? "undefined" : v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  const snapshot = (pl) => {
    const keys = Object.keys(pl).sort();
    const types = {}; const undef = [];
    for (const k of keys) { types[k] = typeOf(pl[k]); if (pl[k] === undefined) undef.push(k); }
    const values = JSON.parse(JSON.stringify(pl, (_k, v) => v === undefined ? null : v));
    return { keys, types, undefinedKeys: undef, values };
  };
  globalThis.__golden = { fired: [], suppressive: [], snapshot };
  Hooks.on("cyberpunk2020.weaponFired", (pl) => { try { globalThis.__golden.fired.push(snapshot(pl)); } catch (e) { globalThis.__golden.fired.push({ err: String(e) }); } });
  Hooks.on("cyberpunk2020.suppressiveFire", (pl) => { try { globalThis.__golden.suppressive.push(snapshot(pl)); } catch (e) { globalThis.__golden.suppressive.push({ err: String(e) }); } });

  const shooter = game.actors.getName("Review · Shooter");
  // The bench stands on its own scene; VIEW it (client-local) rather than activate it, so no other
  // client's canvas moves. Same idiom as b1-seam-payload, with the NAME pinned first: the shooter has
  // figures on more than one review scene, so resolving purely by "a scene carrying this actor" picks
  // whichever the collection happens to order first (measured here: "Review · Cover System"), and the
  // capture would then be taken against a different layout on a different run.
  const benchScene = game.scenes.getName("Review · Dark Range")
    ?? game.scenes.find(sc => sc.tokens.some(t => t.actorId === shooter?.id)) ?? game.scenes.active;
  if (benchScene && canvas?.scene?.id !== benchScene.id) {
    try { await benchScene.view(); } catch (e) { /* client-only */ }
    for (let i = 0; i < 60 && !(canvas?.ready && canvas.scene?.id === benchScene.id); i++) await new Promise(r => setTimeout(r, 200));
  }
  const scene = benchScene;
  return {
    found: !!shooter,
    actorId: shooter?.id ?? null,
    userId: game.user?.id ?? null,
    benchSceneName: scene?.name ?? null,
    benchSceneDrawn: canvas?.ready === true && canvas.scene?.id === scene?.id,
    shooterTokenIds: (scene?.tokens ?? []).filter(t => t.actorId === shooter?.id).map(t => t.id),
    guns: Object.fromEntries((shooter?.itemTypes.weapon ?? [])
      .filter(w => w.getFlag(SCOPE, "reviewBench"))
      .map(w => [String(w.getFlag(SCOPE, "reviewBench").n).padStart(2, "0"), {
        id: w.id, name: w.name, attackType: w.system.attackType ?? "",
        load: w.getFlag(SCOPE, "reviewBench").load, rof: w.system.rof, shots: w.system.shots,
      }])),
    tokens: Object.fromEntries((scene?.tokens ?? []).map(t => [t.name, { id: t.id, actorId: t.actorId }])),
    baselineCards: game.messages.size,
  };
}, SCOPE);

ok("the review bench is provisioned on this rig (16 numbered guns)",
  setup.found && Object.keys(setup.guns).length === 16, `${Object.keys(setup.guns).length} gun(s)`);
ok("the bench's own scene is drawn, with the firing figure on it",
  setup.benchSceneDrawn === true && setup.shooterTokenIds.length > 0,
  `scene=${JSON.stringify(setup.benchSceneName)} figures=${JSON.stringify(setup.shooterTokenIds)}`);

console.log("\n  bench inventory:");
for (const [n, g] of Object.entries(setup.guns)) console.log(`    ${n}  ${g.name.padEnd(44)} ${String(g.load).padEnd(12)} attackType=${g.attackType || "(semi)"} rof=${g.rof}`);

/* ══ the trigger pull ═════════════════════════════════════════════════════════════════════════════
 * The REAL UI path, exactly as b1-seam-payload drives it: the sheet's fire button → the modifiers
 * dialog → its submit. The only addition here is the FIRE MODE — the dialog's own select, set the way
 * a shooter sets it, because which of the base system's five resolvers runs is what decides which
 * fields the card computes and therefore what the seam has to carry. */
async function fire(num, targetName, { select = true, fireMode = null, rounds = null } = {}) {
  const gun = setup.guns[num];
  if (!gun) throw new Error(`bench gun ${num} not provisioned`);
  await p.evaluate(async ({ actorId, gunId, tokenId, shooterTokenId, select }) => {
    for (let i = 0; i < 2; i++) {
      for (const a of [...foundry.applications.instances.values()]) {
        if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
      }
      await new Promise(r => setTimeout(r, 1200));
    }
    globalThis.__golden.fired.length = 0;
    globalThis.__golden.suppressive.length = 0;
    canvas.tokens.get(tokenId)?.setTarget(true, { releaseOthers: true });
    if (select) canvas.tokens.get(shooterTokenId)?.control({ releaseOthers: true });
    else canvas.tokens.releaseAll();
    const actor = game.actors.get(actorId);
    await actor.sheet.render(true);
    await new Promise(r => setTimeout(r, 1500));
    const el = actor.sheet.element.querySelector(`.fire-weapon[data-item-id="${gunId}"]`)
            ?? actor.sheet.element.querySelector(`[data-item-id="${gunId}"] .fire-weapon`);
    if (!el) throw new Error(`no fire button for ${gunId}`);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }, { actorId: setup.actorId, gunId: gun.id, tokenId: setup.tokens[targetName]?.id ?? null,
       shooterTokenId: setup.shooterTokenIds[0] ?? null, select });

  // ⭐ A SPREAD WEAPON HAS NO DIALOG TO WAIT FOR YET. `_cpOpenWeaponAttackDialog` (actor-sheet.js:865)
  // routes any weapon whose loaded round throws a pattern into the CORRIDOR AIM GESTURE first, and the
  // modifiers window only opens once the shooter has confirmed a corridor. Waiting on the dialog alone
  // therefore times out on every shell gun — which is exactly what it did, deterministically, for bench
  // gun 10. The gesture is driven the way a shooter drives it: a pointer move to set the axis and reach,
  // then a left pointerdown to confirm, dispatched on `canvas.app.view` because the gesture's window-level
  // listeners test `ev.target === canvas.app.view` before they will act on anything (`_isCanvasEvent`,
  // spread-placement.js:114). The corridor this produces is REAL, so the captured payload carries a real
  // `spreadAim` block rather than a hand-written one.
  const aimed = await p.evaluate(async ({ tokenId }) => {
    for (let i = 0; i < 40; i++) {
      if (document.querySelector(".cp-spread-preview-readout")) break;
      if ([...foundry.applications.instances.values()].some(a => /ModifiersDialog/.test(a?.constructor?.name ?? "") && a.rendered === true)) return { gesture: false };
      await new Promise(r => setTimeout(r, 200));
    }
    const readout = document.querySelector(".cp-spread-preview-readout");
    if (!readout) return { gesture: false };
    const view = canvas.app.view;
    const tok = tokenId ? canvas.tokens.get(tokenId) : null;
    const world = tok ? { x: tok.center.x, y: tok.center.y }
                      : { x: canvas.stage.pivot.x + 300, y: canvas.stage.pivot.y };
    const pt = canvas.stage.worldTransform.apply(new PIXI.Point(world.x, world.y));
    const opts = { clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true, view: window };
    view.dispatchEvent(new PointerEvent("pointermove", opts));
    await new Promise(r => setTimeout(r, 250));
    const text = document.querySelector(".cp-spread-preview-readout")?.textContent ?? "";
    view.dispatchEvent(new PointerEvent("pointerdown", { ...opts, button: 0, buttons: 1 }));
    return { gesture: true, readout: text, at: { x: Math.round(pt.x), y: Math.round(pt.y) } };
  }, { tokenId: setup.tokens[targetName]?.id ?? null });

  // The dialog can be missed once when the PREVIOUS shot's presentation is still running (the rail
  // holds an apply window open for up to PRESENTATION_CAP_MS and the sheet re-renders behind it), so
  // the click is re-dispatched once rather than the whole capture being lost to a slow beat.
  const dialogUp = () => p.waitForFunction(() => [...foundry.applications.instances.values()]
    .some(a => /ModifiersDialog/.test(a?.constructor?.name ?? "") && a.rendered === true), null, { timeout: 20000 });
  try { await dialogUp(); } catch (e) {
    await p.evaluate(async ({ actorId, gunId }) => {
      const actor = game.actors.get(actorId);
      await actor.sheet.render(true);
      await new Promise(r => setTimeout(r, 2000));
      const el = actor.sheet.element.querySelector(`.fire-weapon[data-item-id="${gunId}"]`)
              ?? actor.sheet.element.querySelector(`[data-item-id="${gunId}"] .fire-weapon`);
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }, { actorId: setup.actorId, gunId: gun.id });
    await dialogUp();
  }
  const dlg = await p.evaluate(async ({ fireMode, rounds }) => {
    const d = [...foundry.applications.instances.values()].find(a => /ModifiersDialog/.test(a?.constructor?.name ?? ""));
    const root = d.element?.querySelector ? d.element : d.element?.[0];
    const sel = root.querySelector('select[name="fields.fireMode"], select[name="fireMode"], .field[data-path="fireMode"] select');
    const offered = sel ? [...sel.options].map(o => o.value) : [];
    let chosen = sel?.value ?? null;
    if (sel && fireMode) {
      if (!offered.includes(fireMode)) return { offered, chosen, missing: true };
      sel.value = fireMode; chosen = fireMode;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
    }
    const fa = root.querySelector('input[name="fullAutoRoundsFired"], input.full-auto-rounds');
    if (fa && rounds != null) { fa.value = String(rounds); fa.dispatchEvent(new Event("change", { bubbles: true })); }
    const rf = root.querySelector('input[name="roundsFired"], input[name="fields.roundsFired"]');
    if (rf && rounds != null) { rf.value = String(rounds); rf.dispatchEvent(new Event("change", { bubbles: true })); }
    await new Promise(r => setTimeout(r, 300));
    const btn = root.querySelector('button[type="submit"], footer button');
    if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    else root.requestSubmit?.();
    return { offered, chosen, missing: false };
  }, { fireMode, rounds });
  dlg.aimGesture = aimed;

  await p.waitForFunction(() => globalThis.__golden.fired.length > 0 || globalThis.__golden.suppressive.length > 0,
    null, { timeout: 25000 }).catch(() => {});
  await p.waitForTimeout(1800);
  const got = await p.evaluate(() => ({
    fired: globalThis.__golden.fired.slice(), suppressive: globalThis.__golden.suppressive.slice(),
  }));
  return { ...got, dlg };
}

/* ══ the capture pass — one entry per fire mode ═══════════════════════════════════════════════════
 * Gun choice is dictated by which base resolver each mode needs and which load makes the entry worth
 * hydrating from:
 *   singleShot   01 Stolbovoy St-2 · standard   — semiAuto is the only mode a non-auto weapon offers
 *   burst        06 Militech Ronin · standard   — __threeRoundBurst
 *   fullAuto     06 Militech Ronin · standard   — __fullAuto, the one resolver handed a target list
 *   shotgunSpread 10 Arasaka RAS 12 · buckshot  — the pattern comes off the CARTRIDGE, not a flag
 *   areaWarhead  16 Barrett-Arasaka 20mm · dualPurpose — the explosive/blast effectFields block
 *   suppressive  06 Militech Ronin · standard   — a DIFFERENT hook (see the note at the entry)
 */
const MODES = [
  { key: "singleShot",    gun: "01", mode: "SemiAuto",         rounds: null, select: true,  hook: "weaponFired" },
  { key: "burst",         gun: "06", mode: "ThreeRoundBurst",  rounds: null, select: true,  hook: "weaponFired" },
  { key: "fullAuto",      gun: "06", mode: "FullAuto",         rounds: 6,    select: true,  hook: "weaponFired" },
  // ⚠ THE MODE IS NAMED EXPLICITLY FOR THE SHELL GUN. An autoshotgun offers four resolvers and the
  // dialog defaults to the FIRST (`fireModes[0]` = FullAuto, lookups.js), so leaving it unset would
  // capture a full-auto shell burst under the name of a single spread discharge.
  { key: "shotgunSpread", gun: "10", mode: "SemiAuto",         rounds: null, select: true,  hook: "weaponFired" },
  { key: "areaWarhead",   gun: "16", mode: "SemiAuto",         rounds: null, select: false, hook: "weaponFired" },
  { key: "suppressive",   gun: "06", mode: "Suppressive",      rounds: 10,   select: true,  hook: "suppressiveFire" },
];

console.log("\n===== capture: one real trigger pull per fire mode =====");
const captured = {};
for (const m of MODES) {
  let r = null, thrown = null, bucket = [], snap = null, refires = 0;
  // ⛔ A FUMBLED SHOT IS A DEGENERATE CAPTURE, so it is re-fired rather than stored. When the base
  // system's fumble table rules a shot a fumble it sets `forceMiss` and the card computes nothing: the
  // emission comes through as one round, no hits, empty `areaDamages` and `fumbleRuled: true` — and the
  // presentation rail bails on exactly that field (`skipped: "fumble"`, fx/effects.js), so a factory
  // hydrating from it would draw nothing at all and every leg downstream would be measuring the bail.
  // Observed for real on the first capture run: the ThreeRoundBurst entry came back a natural 1.
  // A mode that cannot be driven at all must not cost the run every mode after it: it reds its own leg
  // and the fixture is still written for the ones that worked, so a partial capture is diagnosable
  // rather than an empty file plus a stack trace.
  for (let attempt = 0; attempt < 4; attempt++) {
    thrown = null;
    try { r = await fire(m.gun, "Review · Target", { select: m.select, fireMode: m.mode, rounds: m.rounds }); }
    catch (e) { thrown = String(e?.message ?? e).split("\n")[0]; }
    bucket = thrown ? [] : (m.hook === "suppressiveFire" ? r.suppressive : r.fired);
    snap = bucket[0] ?? null;
    if (thrown || !snap || snap.err) break;
    if (snap.values?.fumbleRuled !== true) break;
    refires++;
    await p.waitForTimeout(3000);
  }
  ok(`capture · ${m.key}: gun ${m.gun} fired and the seam raised a ${m.hook} payload`,
    !!snap && !snap.err,
    thrown ? `THREW: ${thrown}`
           : `mode=${JSON.stringify(r.dlg.chosen)} offered=${JSON.stringify(r.dlg.offered)} emissions=${bucket.length} keys=${snap?.keys?.length ?? 0}${refires ? ` (re-fired ${refires}× past a ruled fumble)` : ""}`);
  if (m.hook === "weaponFired") ok(`capture · ${m.key}: the stored entry is a shot that actually went down-range, not a ruled fumble`,
    snap?.values?.fumbleRuled === false, `fumbleRuled=${JSON.stringify(snap?.values?.fumbleRuled)} shotsFired=${JSON.stringify(snap?.values?.shotsFired)} shotsHit=${JSON.stringify(snap?.values?.shotsHit)}`);
  ok(`capture · ${m.key}: the dialog offered and took the ${m.mode} resolver`,
    !thrown && r.dlg.missing !== true && r.dlg.chosen === m.mode,
    thrown ? "(not reached)" : `chosen=${JSON.stringify(r.dlg.chosen)} offered=${JSON.stringify(r.dlg.offered)}`
      + (r.dlg.aimGesture?.gesture ? ` · corridor aimed: ${JSON.stringify(r.dlg.aimGesture.readout)}` : ""));
  if (snap && !snap.err) {
    captured[m.key] = { hook: `cyberpunk2020.${m.hook}`, gun: m.gun, gunName: setup.guns[m.gun].name,
      load: setup.guns[m.gun].load, fireMode: r.dlg.chosen, emissions: bucket.length,
      aimGesture: r.dlg.aimGesture?.gesture === true, ...snap };
  }
  // Let the previous shot's presentation and its apply window finish before the next trigger pull —
  // the rail holds a window open for up to PRESENTATION_CAP_MS (8s) and a shot fired into that beat is
  // what loses the next dialog.
  await p.waitForTimeout(4000);
}

/* ══ placeholder substitution ═════════════════════════════════════════════════════════════════════
 * ONLY the identifiers that cannot be stable across worlds. Everything else — the numbers the card
 * computed, the ammo's mechanics, the nulls the producer deliberately writes — is stored as captured,
 * because that is the shape the rail actually receives. */
const targetTok = setup.tokens["Review · Target"] ?? { id: null, actorId: null };
const SUBS = [
  [setup.actorId,               "@@ATTACKER_ACTOR@@"],
  [setup.userId,                "@@FIRED_BY_USER@@"],
  [setup.shooterTokenIds[0],    "@@ATTACKER_TOKEN@@"],
  [targetTok.id,                "@@TARGET_TOKEN@@"],
  [targetTok.actorId,           "@@TARGET_ACTOR@@"],
  ...Object.values(setup.guns).map(g => [g.id, "@@WEAPON@@"]),
].filter(([v]) => typeof v === "string" && v.length >= 8);

const placeholderise = (v) => {
  if (typeof v === "string") { const hit = SUBS.find(([id]) => id === v); return hit ? hit[1] : v; }
  if (Array.isArray(v)) return v.map(placeholderise);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, placeholderise(x)]));
  return v;
};
let markedTotal = 0;
for (const entry of Object.values(captured)) {
  const before = JSON.stringify(entry.values);
  entry.values = placeholderise(entry.values);
  markedTotal += (JSON.stringify(entry.values).match(/@@[A-Z_]+@@/g) ?? []).length;
  entry.placeholdersApplied = before !== JSON.stringify(entry.values);
}
ok("every captured entry carries placeholder markers in place of world-local identifiers",
  Object.values(captured).length > 0 && Object.values(captured).every(e => e.placeholdersApplied),
  `${markedTotal} marker(s) across ${Object.keys(captured).length} entr(ies)`);

const weaponFiredModes = MODES.filter(m => m.hook === "weaponFired").map(m => m.key);
ok("every weaponFired fire mode produced an entry",
  weaponFiredModes.every(k => captured[k]), `captured=[${Object.keys(captured).join(", ")}]`);

/* ══ RESTORE ══════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n===== restore =====");
const restored = await p.evaluate(async ({ SCOPE, baselineCards }) => {
  for (let i = 0; i < 2; i++) {
    for (const a of [...foundry.applications.instances.values()]) {
      if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none */ }
  const scene = game.scenes.getName("Review · Dark Range")
    ?? game.scenes.find(sc => sc.tokens.some(t => t.name === "Review · Target (Vehicle)"))
    ?? game.scenes.active;
  for (const m of [...game.messages].slice(baselineCards)) { try { await m.delete(); } catch (e) { /* gone */ } }
  // A suppressive shot arms a placement preview and can leave a zone behind; clear anything this run
  // could have planted, on the bench scene only.
  for (const coll of [scene?.templates, scene?.regions]) {
    if (!coll) continue;
    for (const d of [...coll]) {
      const f = d.flags?.[SCOPE] ?? {};
      if (f.isSuppressiveZone || f.isSpreadPattern || f.isBlastZone) { try { await d.delete(); } catch (e) { /* gone */ } }
    }
  }
  const actor = game.actors.getName("Review · Shooter");
  await actor.updateEmbeddedDocuments("Item", actor.itemTypes.weapon
    .filter(w => w.getFlag(SCOPE, "reviewBench"))
    .map(w => ({ _id: w.id, "system.shotsLeft": Number(w.system.shots) })));
  await actor.updateEmbeddedDocuments("Item", actor.itemTypes.ammo
    .filter(a => a.getFlag(SCOPE, "reviewBench"))
    .map(a => ({ _id: a.id, "system.quantity": 60 })));
  const zeroed = [], covered = [];
  for (const name of ["Review · Target", "Review · Target (Cyberlimb)", "Review · Target (Vehicle)"]) {
    const t = scene.tokens.find(x => x.name === name);
    if (!t) continue;
    covered.push(name);
    for (const a of new Set([t.actor, game.actors.get(t.actorId)].filter(Boolean))) {
      const sys = a.system ?? {};
      const upd = {};
      if (sys.damage !== undefined) upd["system.damage"] = 0;
      if (sys.sdp?.sum) {
        upd["system.sdp.current"] = foundry.utils.deepClone(sys.sdp.sum);
        upd["system.sdp.touched"] = Object.fromEntries(Object.keys(sys.sdp.sum).map(k => [k, false]));
      }
      if (sys.sdp?.max !== undefined) upd["system.sdp.value"] = sys.sdp.max;
      if (Object.keys(upd).length) await a.update(upd);
      if (a.effects.size) await a.deleteEmbeddedDocuments("ActiveEffect", a.effects.map(e => e.id));
      zeroed.push(`${a.name}=${a.system.damage ?? a.system.sdp?.value}`);
    }
  }
  [...game.user.targets].forEach(t => t.setTarget(false, { releaseOthers: false }));
  canvas.tokens.releaseAll();
  try { await actor.sheet.close(); } catch (e) { /* closed */ }
  await new Promise(r => setTimeout(r, 800));
  return {
    zeroed, covered,
    magazines: actor.itemTypes.weapon.filter(w => w.getFlag(SCOPE, "reviewBench"))
      .every(w => Number(w.system.shotsLeft) === Number(w.system.shots)),
    ammoFull: actor.itemTypes.ammo.filter(a => a.getFlag(SCOPE, "reviewBench"))
      .every(a => Number(a.system.quantity) === 60),
    liveEffects: (globalThis.Sequencer?.EffectManager?.effects ?? [])
      .filter(e => !String(e?.data?.name ?? "").startsWith("cp2020-augmented.statusfx.")).length,
    cards: game.messages.size,
    dialogs: [...foundry.applications.instances.values()].filter(a => /Damage|Modifiers/i.test(a?.constructor?.name ?? "")).length,
  };
}, { SCOPE, baselineCards: setup.baselineCards });

ok("restore: every bench magazine is full again", restored.magazines);
ok("restore: every bench ammo box is back at stock", restored.ammoFull);
ok("restore: all three bench targets were reached and are back to undamaged",
  restored.covered.length === 3 && restored.zeroed.length >= 3
  && restored.zeroed.every(z => /=0$|=60$|=30$/.test(z)),
  `covered=[${restored.covered.join(", ")}] ${restored.zeroed.join(" · ")}`);
ok("restore: the canvas holds no live effect", restored.liveEffects === 0, `${restored.liveEffects}`);
ok("restore: the chat log is back where this run found it",
  restored.cards === setup.baselineCards, `${restored.cards} vs ${setup.baselineCards}`);
ok("restore: no dialog left open", restored.dialogs === 0, `${restored.dialogs}`);
ok("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

/* ══ write the fixture ════════════════════════════════════════════════════════════════════════════ */
if (Object.keys(captured).length) {
  const doc = {
    _comment: "GENERATED by tests/cp2020-augmented-golden-payload-capture.mjs — do not hand-edit. "
      + "Each entry is a real cyberpunk2020.weaponFired (or suppressiveFire) emission read off the live "
      + "seam on the :30004 review bench. World-local identifiers are @@…@@ markers the hydrator re-fills.",
    capturedAt: new Date().toISOString(),
    producer: "module/seam-shim.js",
    rig: BASE,
    modes: captured,
  };
  writeFileSync(FIXTURE, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.log(`\n  fixture written: ${FIXTURE}`);
  for (const [k, e] of Object.entries(captured)) console.log(`    ${k.padEnd(14)} ${String(e.keys.length).padStart(2)} field(s)  hook=${e.hook}`);
}

const passed = checks.filter(c => c.p).length;
console.log(`\n===== golden payload capture: ${passed}/${checks.length} =====`);
if (passed !== checks.length) for (const c of checks.filter(x => !x.p)) console.log(`  FAILED: ${c.n}   [${c.d}]`);
await b.close();
process.exit(passed === checks.length ? 0 : 1);
