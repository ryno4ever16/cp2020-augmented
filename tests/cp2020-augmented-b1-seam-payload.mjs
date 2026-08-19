/**
 * B1: what the seam-shim puts on a `cyberpunk2020.weaponFired` payload.
 *
 * The original spec asked one question — does the shim carry the loaded ammo's MECHANICS (explosion,
 * DOT, taser, penetration) into the payload — and answered it off a synthesized weapon. It passed all
 * night while `payload.modifier` was missing entirely, because it never named that field.
 *
 * ⭐ WHY THE HARDENING IS SHAPED THE WAY IT IS. The ammo's own id is the one field on the payload whose
 * absence is INVISIBLE downstream: `ammoFxKeyOf` (fx/effects.js) falls back to a fingerprint of the
 * mechanics when there is no id, so every load still resolves to something and every picture still gets
 * drawn. Exactly one pair cannot survive that fallback — `ap` and `dualPurpose` carry byte-identical
 * mechanics — so the regression's whole visible surface is `dualPurpose` silently answering "ap". That
 * is what §3 fires a real gun to catch, and it is asserted three ways: the id is on the payload by
 * value, the resolver answers by id, and the SAME payload with the id removed is shown to answer "ap"
 * — which is the fingerprint path admitting on the record that it cannot do this job.
 *
 * §1 the served helper + the shim engaged · §2 the mechanics and BOTH identity fields off a synthesized
 * weapon · §3 two REAL fired payloads off the review bench (07 api rifle · 16 dualPurpose heavy),
 * through the real UI path, read off the hook · §4 the GOLDEN-FIXTURE CONTRACT.
 *
 * ⭐ WHAT §4 IS FOR. `tests/golden-weaponfired-payloads.json` stores a real emission per fire mode so
 * the fx-rail keeper can hydrate from the shape the rail actually receives instead of hand-building a
 * four-field literal (VACUOUS-LEG-AUDIT F1). A stored shape drifts silently the moment the producer
 * changes, which would make the fixture a hand-built shape on a slower clock — so §4 re-captures a
 * LIVE emission at run time, off the SAME bench gun and load the fixture entry was captured from, and
 * diffs its field NAMES and TYPES against the stored entry in both directions. A field the producer
 * adds, drops or re-types reds here and names itself. The re-capture costs no extra trigger pull: it
 * rides §3's gun-16 shot through a second, full-fidelity recorder on the same hook.
 *
 * It restores what it disturbs: magazines refilled, target damage zeroed, its own cards deleted,
 * dialogs closed, canvas effects ended, targets released. It touches no setting.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=<pw> node cp2020-augmented-b1-seam-payload.mjs
 */
import { chromium } from "@playwright/test";
import { GOLDEN, GOLDEN_MISSING, GOLDEN_PATH } from "./golden-payload.mjs";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";

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

/* ══ §1–2. the served helper, the shim, and the fields off a synthesized weapon ══════════════════ */
const r = await p.evaluate(async (SCOPE) => {
  const srcTxt = await (await fetch(`/modules/${SCOPE}/module/seam-shim.js`, { cache: "no-store" })).text();
  const servedHasHelper = srcTxt.includes("export function ammoEffectFields");

  // Is the shim engaged on this (official) system? Its wrappers carry __cpSeamShim.
  const ItemProto = CONFIG.Item.documentClass.prototype;
  const shimEngaged = ["__fullAuto", "__threeRoundBurst", "__semiAuto", "__meleeBonk"]
    .some(m => ItemProto[m]?.__cpSeamShim === true);

  for (const a of game.actors.filter(a => a.name === "__PW__B1")) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__B1", type: "character" });
  const [ammo] = await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__ExplosiveAmmo", type: "ammo",
    system: {
      modifier: "dualPurpose", caliber: "20/9mm",
      effectTypes: ["Explosive"], blastRadius: 5, blastFullDamageWithin: 1,
      dotEnabled: true, dotTurns: 3, dotType: "fire", stunSaveOnHit: true, ap: true, penDamageMult: 2,
    },
  }]);
  const [weapon] = await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__Launcher", type: "weapon", system: { ammoItemId: ammo.id },
  }]);

  const mod = await import(`/modules/${SCOPE}/module/seam-shim.js`);
  const fields = mod.ammoEffectFields(actor.items.get(weapon.id));

  // The weapon-side cartridge fallback, on a weapon with NO ammo item linked: `ammoType` stands in for
  // `caliber`, and the identity field is correctly absent rather than invented.
  const [bare] = await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__BareShell", type: "weapon", system: { ammoType: "12ga" },
  }]);
  const bareFields = mod.ammoEffectFields(actor.items.get(bare.id));

  await actor.delete().catch(() => {});
  return { servedHasHelper, shimEngaged, fields, bareFields };
}, SCOPE);

console.log("\n===== §1–2: the seam's payload fields, off a synthesized weapon =====");
ok("§1 the served seam-shim exports ammoEffectFields", r.servedHasHelper);
ok("§1 the shim is engaged on the official system", r.shimEngaged);

const f = r.fields || {};
ok("§2 the MECHANICS ride the payload (explosion · DOT · taser · penetration)",
  f.effectTypes?.[0] === "Explosive" && f.blastRadius === 5 && f.blastFullDamageWithin === 1
  && f.dotEnabled === true && f.dotTurns === 3 && f.penDamageMult === 2 && f.stunSaveOnHit === true,
  JSON.stringify({ effectTypes: f.effectTypes, blastRadius: f.blastRadius, dotTurns: f.dotTurns, penDamageMult: f.penDamageMult }));
// ⭐ THE TWO IDENTITY FIELDS, BY VALUE AND TOGETHER. They answer different questions — which LOAD is in
// the gun, and which CARTRIDGE it is — and the regression this leg exists for replaced one with the
// other in a single list. Asserting them in one leg is deliberate: it is the shape of the defect.
ok("§2 the ammo's own MODIFIER id rides the payload, by value",
  f.modifier === "dualPurpose", `modifier=${JSON.stringify(f.modifier)}`);
ok("§2 the CARTRIDGE rides it too, by value — beside the id, never instead of it",
  f.caliber === "20/9mm", `caliber=${JSON.stringify(f.caliber)}`);
ok("§2 with no ammo item linked the WEAPON's own chambering stands in as the cartridge",
  r.bareFields?.caliber === "12ga", `caliber=${JSON.stringify(r.bareFields?.caliber)}`);
ok("§2 and no identity is invented for a weapon that has no load (negative)",
  r.bareFields?.modifier === undefined, `modifier=${JSON.stringify(r.bareFields?.modifier)}`);

/* ══ §3. REAL fired payloads off the review bench ════════════════════════════════════════════════ */
console.log("\n===== §3: real fired payloads — 07 api rifle · 16 dualPurpose heavy =====");

const setup = await p.evaluate(async (SCOPE) => {
  const g = globalThis.__b1 = { payloads: [], whole: [] };
  // ⭐ THE SECOND RECORDER, AND WHY IT IS SEPARATE. The one below keeps a NAMED SUBSET, because the legs
  // in §3 are about specific fields and a named subset is what makes them readable. §4's contract is the
  // opposite question — "is the field set still the field set" — and a named subset cannot answer it: a
  // recorder that lists the fields it keeps can never notice a field the producer added. So this one
  // keeps the payload WHOLE, with its key names and their types, and names nothing.
  //
  // ⚠ ONE EXCLUSION, for a field the PRODUCER does not write. `handled` is the commitment stamp this
  // module's own weaponFired listener sets to claim a shot, synchronously, while `Hooks.callAll` is
  // still walking the listener list — so a recorder registered after it sees a field the seam never
  // emitted, and §4 would report a producer drift that never happened. It is excluded here for the same
  // reason and by the same name as in cp2020-augmented-golden-payload-capture.mjs, so the live reading
  // and the stored fixture are taken over the same field set. Nothing else is named: a whole-payload
  // recorder that started listing what it keeps could no longer notice a field the producer added.
  const CONSUMER_WRITTEN = new Set(["handled"]);
  const typeOf = (v) => v === undefined ? "undefined" : v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  g.snapshot = (pl) => {
    const keys = Object.keys(pl).filter(k => !CONSUMER_WRITTEN.has(k)).sort();
    const types = {}; for (const k of keys) types[k] = typeOf(pl[k]);
    return { keys, types };
  };
  Hooks.on("cyberpunk2020.weaponFired", (pl) => { try { g.whole.push(g.snapshot(pl)); } catch (e) { g.whole.push({ err: String(e) }); } });
  Hooks.on("cyberpunk2020.weaponFired", (pl) => g.payloads.push(foundry.utils.deepClone({
    weaponName: pl.weaponName, modifier: pl.modifier ?? null, caliber: pl.caliber ?? null,
    spreadMode: pl.spreadMode ?? null, armorMultSoft: pl.armorMultSoft ?? null,
    armorMultHard: pl.armorMultHard ?? null, penDamageMult: pl.penDamageMult ?? null,
    dotEnabled: pl.dotEnabled ?? null, dotType: pl.dotType ?? null,
    stunSaveOnHit: pl.stunSaveOnHit ?? null, stunSaveMod: pl.stunSaveMod ?? null,
    shotsFired: pl.shotsFired ?? null,
    // ⭐ WHICH FIGURE ON THE MAP THE SHOT CAME FROM. The actor id alone cannot answer it — two tokens
    // of one actor share it, and an unlinked token's own actor carries the base actor's id — so a
    // consumer resolving the origin by actor id answers whichever token was placed first. This field
    // is the seam's answer, captured at the trigger pull; the legs below read it by value.
    attackerTokenId: pl.attackerTokenId ?? null,
  })));
  const shooter = game.actors.getName("Review · Shooter");
  // ⭐ THE BENCH HAS ITS OWN SCENE, and this leg assumed the world's active one. The standing review
  // bench is laid out on "Review · Dark Range" (provision-review-bench.mjs:222-235 arranges the four
  // figures there), while the rig's active scene is the default map. Reading `game.scenes.active`
  // therefore found no bench figure at all — `shooterTokenIds` came back `[]` and the two
  // "which figure did this shot come from" legs could only report `attackerTokenId=null`, even though
  // the seam was working. Resolve the scene from where the shooter actually STANDS, and VIEW it —
  // `.view()` is client-local (the vehicle-seating idiom), so the world's active scene is untouched
  // and no other suite in the battery is disturbed. The canvas must be drawn because the legs below
  // select and target through `canvas.tokens`.
  // ⏪ 2026-08-17 (ruled fix): "a scene carrying the shooter" is not unique — the rig also carries
  // "Review · Cover System", which stands the same figure up for a different lane. This section could
  // therefore run on one scene while the restore block below pins "Review · Dark Range" by name, so a
  // run could damage the bench on one canvas and tidy another. The bench scene is named here too, with
  // the carries-the-shooter search kept only as the fallback.
  const benchScene = game.scenes.getName("Review · Dark Range")
    ?? game.scenes.find(sc => sc.tokens.some(t => t.actorId === shooter?.id))
    ?? game.scenes.active;
  if (benchScene && canvas?.scene?.id !== benchScene.id) {
    try { await benchScene.view(); } catch (e) { /* client-only */ }
    for (let i = 0; i < 60 && !(canvas?.ready && canvas.scene?.id === benchScene.id); i++) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  const scene = benchScene;
  return {
    found: !!shooter,
    actorId: shooter?.id ?? null,
    benchSceneName: scene?.name ?? null,
    benchSceneDrawn: canvas?.ready === true && canvas.scene?.id === scene?.id,
    shooterTokenIds: (scene?.tokens ?? []).filter(t => t.actorId === shooter?.id).map(t => t.id),
    guns: Object.fromEntries((shooter?.itemTypes.weapon ?? [])
      .filter(w => w.getFlag(SCOPE, "reviewBench"))
      .map(w => [String(w.getFlag(SCOPE, "reviewBench").n).padStart(2, "0"), { id: w.id, name: w.name }])),
    tokens: Object.fromEntries((scene?.tokens ?? []).map(t => [t.name, t.id])),
    baselineCards: game.messages.size,
  };
}, SCOPE);

ok("§3 the review bench is provisioned on this rig (16 numbered guns)",
  setup.found && Object.keys(setup.guns).length === 16, `${Object.keys(setup.guns).length} gun(s)`);
ok("§3 the bench's own scene is drawn, with the firing figure on it",
  setup.benchSceneDrawn === true && setup.shooterTokenIds.length > 0,
  `scene=${JSON.stringify(setup.benchSceneName)} drawn=${setup.benchSceneDrawn} figures=${JSON.stringify(setup.shooterTokenIds)}`);

/** One shot through the REAL UI path: the sheet's fire button → the modifiers dialog → its submit.
 *  Drains any apply window the PREVIOUS shot deferred (up to PRESENTATION_CAP_MS, 8 s) first, so a
 *  stale dialog never blocks this one's.
 *
 *  `select` chooses which way the firing figure is established for THIS shot: with it, the figure is
 *  selected on the canvas the way an ordinary turn leaves it; without it, nothing is selected and the
 *  seam has to fall through to the core resolution. Both are driven, because both are ordinary. */
async function fire(num, targetName, { select = false } = {}) {
  const gun = setup.guns[num];
  await p.evaluate(async ({ actorId, gunId, tokenId, shooterTokenId, select }) => {
    for (let i = 0; i < 2; i++) {
      for (const a of [...foundry.applications.instances.values()]) {
        if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
      }
      await new Promise(r => setTimeout(r, 1200));
    }
    globalThis.__b1.payloads.length = 0;
    globalThis.__b1.whole.length = 0;
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
  }, { actorId: setup.actorId, gunId: gun.id, tokenId: setup.tokens[targetName],
       shooterTokenId: setup.shooterTokenIds[0] ?? null, select });

  await p.waitForFunction(() => [...foundry.applications.instances.values()]
    .some(a => /ModifiersDialog/.test(a?.constructor?.name ?? "") && a.rendered === true), null, { timeout: 25000 });
  await p.evaluate(() => {
    const dlg = [...foundry.applications.instances.values()].find(a => /ModifiersDialog/.test(a?.constructor?.name ?? ""));
    const rounds = dlg.element.querySelector('input[name*="fullAutoRoundsFired"], input.full-auto-rounds');
    if (rounds) { rounds.value = "3"; rounds.dispatchEvent(new Event("change", { bubbles: true })); }
    const btn = dlg.element.querySelector('button[type="submit"], footer button');
    if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    else dlg.element.requestSubmit();
  });
  await p.waitForFunction(() => globalThis.__b1.payloads.length > 0, null, { timeout: 25000 }).catch(() => {});
  await p.waitForTimeout(1500);
  return p.evaluate(() => globalThis.__b1.payloads[0] ?? null);
}

/** How the presentation rail reads a payload — asked of the SHIPPED resolver, and asked twice: once as
 *  fired, once with the id stripped, so the leg shows what the fingerprint alone would have answered. */
async function resolve(payload) {
  return p.evaluate(async ({ SCOPE, payload }) => {
    const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
    const withoutId = { ...payload }; delete withoutId.modifier;
    return { byId: fx.ammoFxKeyOf(payload), byFingerprint: fx.ammoFxKeyOf(withoutId) };
  }, { SCOPE, payload });
}

/* ── 07 · Militech Ronin Light Assault · Armor-Piercing Incendiary (5.56) ──────────────────────── */
const p07 = await fire("07", "Review · Target", { select: true });
ok("§3 gun 07 fired and the seam raised its payload", !!p07, JSON.stringify(p07)?.slice(0, 160));
ok("§3 07 · payload.modifier is the loaded ammo's own id, by value",
  p07?.modifier === "api", `modifier=${JSON.stringify(p07?.modifier)}`);
ok("§3 07 · payload.caliber is the loaded cartridge, by value",
  p07?.caliber === "5.56", `caliber=${JSON.stringify(p07?.caliber)}`);
const k07 = await resolve(p07);
ok("§3 07 · the rail resolves the load BY ID from the real payload",
  k07.byId === "api", `ammoFxKeyOf → ${k07.byId}`);
// ⭐ THE ORIGIN FIELD, off a real shot fired with the figure selected on the canvas.
ok("§3 07 · the payload names the FIGURE the shot was fired from, by value (selected on the canvas)",
  !!p07?.attackerTokenId && p07.attackerTokenId === setup.shooterTokenIds[0],
  `attackerTokenId=${JSON.stringify(p07?.attackerTokenId)} vs placed ${JSON.stringify(setup.shooterTokenIds)}`);

/* ── 16 · Barrett-Arasaka Light 20mm · Dual-Purpose (20/9mm) — the case the id exists for ──────── */
const p16 = await fire("16", "Review · Target", { select: false });
ok("§3 gun 16 fired and the seam raised its payload", !!p16, JSON.stringify(p16)?.slice(0, 160));
ok("§3 16 · payload.modifier is the loaded ammo's own id, by value",
  p16?.modifier === "dualPurpose", `modifier=${JSON.stringify(p16?.modifier)}`);
ok("§3 16 · payload.caliber is the loaded cartridge, by value",
  p16?.caliber === "20/9mm", `caliber=${JSON.stringify(p16?.caliber)}`);
const k16 = await resolve(p16);
ok("§3 16 · the rail resolves dualPurpose BY ID and it does NOT collapse onto ap",
  k16.byId === "dualPurpose", `ammoFxKeyOf → ${k16.byId}`);
// ⭐ The leg that makes the one above mean something. The fingerprint path is not broken — it is
// INCAPABLE here, because ap and dualPurpose carry identical mechanics. Asserting what it answers on
// the very same payload is the record that the id is load-bearing and not decorative.
ok("§3 16 · and the same payload WITHOUT the id answers 'ap' — the fingerprint cannot split this pair",
  k16.byFingerprint === "ap", `ammoFxKeyOf(no id) → ${k16.byFingerprint}`);
// The same origin field with NOTHING selected — the seam has to fall through to the core resolution,
// and the answer must still be a figure of the firing actor rather than nothing or somebody else's.
ok("§3 16 · with nothing selected the payload still names a firing figure",
  !!p16?.attackerTokenId && p16.attackerTokenId === setup.shooterTokenIds[0],
  `attackerTokenId=${JSON.stringify(p16?.attackerTokenId)} vs placed ${JSON.stringify(setup.shooterTokenIds)}`);
const owns = await p.evaluate(({ tokenId, actorId }) => {
  const tok = tokenId ? canvas.tokens.get(tokenId) : null;
  return { drawn: !!tok, actorId: tok?.actor?.id ?? null, matches: tok?.actor?.id === actorId };
}, { tokenId: p16?.attackerTokenId ?? null, actorId: setup.actorId });
ok("§3 the named figure is one this client is drawing AND belongs to the firing actor",
  owns.drawn && owns.matches, JSON.stringify(owns));

/* ══ §4. THE GOLDEN-FIXTURE CONTRACT — the stored shape vs the one just emitted ═══════════════════
 *
 * ⛔ WHY THIS IS NOT OPTIONAL. `tests/golden-weaponfired-payloads.json` is what ~68 fx-rail call sites
 * now hydrate from. A stored shape has no way of noticing that its producer moved, so without this leg
 * the fixture becomes exactly the thing it was built to retire: a hand-built payload, drifting from
 * reality, on a slower clock. The diff is run BOTH WAYS and by TYPE, because the three ways a producer
 * can move are the three ways this can fail — a field added, a field dropped, a field re-typed.
 *
 * ⭐ WHY IT IS COMPARED AGAINST THE `areaWarhead` ENTRY SPECIFICALLY. The producer's field set is not
 * one fixed list: `ammoEffectFields` (seam-shim.js) copies only the fields the LOADED AMMO actually
 * defines, so a standard round and a dual-purpose round legitimately emit different key sets. Comparing
 * a live gun-16 shot against an entry captured from gun 16 with the same load holds that variable
 * still, and leaves the diff measuring the only thing it should measure: the producer. The gun and load
 * the entry claims are asserted first, so the comparison can never be made against the wrong entry. */
console.log("\n===== §4: the golden fixture contract =====");

const liveWhole = await p.evaluate(() => globalThis.__b1.whole[0] ?? null);
const stored = GOLDEN?.modes?.areaWarhead ?? null;

ok("§4 contract: the stored golden fixture is on disk and names the producer it was captured from",
  !GOLDEN_MISSING && stored != null && GOLDEN.producer === "module/seam-shim.js",
  GOLDEN_MISSING ? `missing at ${GOLDEN_PATH} — run cp2020-augmented-golden-payload-capture.mjs`
                 : `producer=${JSON.stringify(GOLDEN.producer)} captured=${GOLDEN.capturedAt} modes=[${Object.keys(GOLDEN.modes).join(", ")}]`);
ok("§4 contract: that entry was captured from the SAME bench gun and load this run just fired",
  stored?.gun === "16" && stored?.load === "dualPurpose" && stored?.hook === "cyberpunk2020.weaponFired",
  `entry gun=${JSON.stringify(stored?.gun)} load=${JSON.stringify(stored?.load)} hook=${JSON.stringify(stored?.hook)}`);

const liveKeys = liveWhole?.keys ?? [];
const storedKeys = stored?.keys ?? [];
const added = liveKeys.filter(k => !storedKeys.includes(k));
const dropped = storedKeys.filter(k => !liveKeys.includes(k));
const retyped = liveKeys.filter(k => storedKeys.includes(k) && liveWhole.types[k] !== stored.types[k])
  .map(k => `${k}: fixture ${stored.types[k]} → live ${liveWhole.types[k]}`);

ok("§4 contract: the live emission carries no field the stored fixture has never seen",
  !!liveWhole && !liveWhole.err && added.length === 0,
  added.length ? `ADDED BY THE PRODUCER: ${added.join(", ")} — re-run cp2020-augmented-golden-payload-capture.mjs`
               : `${liveKeys.length} field(s), none new`);
ok("§4 contract: the live emission drops no field the stored fixture carries",
  !!liveWhole && !liveWhole.err && dropped.length === 0,
  dropped.length ? `DROPPED BY THE PRODUCER: ${dropped.join(", ")} — every fx-rail leg hydrating that field is now testing a value nothing produces`
                 : `${storedKeys.length} stored field(s), all still emitted`);
ok("§4 contract: every shared field still carries the type the stored fixture recorded",
  !!liveWhole && !liveWhole.err && retyped.length === 0,
  retyped.length ? `RE-TYPED BY THE PRODUCER: ${retyped.join(" · ")}` : `${liveKeys.length} field(s) type-identical`);

/* ══ RESTORE ═════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n===== restore =====");
const restored = await p.evaluate(async ({ SCOPE, baselineCards }) => {
  for (let i = 0; i < 2; i++) {
    for (const a of [...foundry.applications.instances.values()]) {
      if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none */ }
  // ⭐ THE RESTORE HAS TO SWEEP THE SCENE THE BENCH IS ON, not the world's active one. The three
  // named targets stand on "Review · Dark Range" (the same scene §setup resolves from the shooter's
  // own figure); the rig's active scene is the default map and carries none of them. Reading
  // `game.scenes.active` here meant the loop below found ZERO tokens, so nothing was ever restored —
  // and because `[].every()` is true, the leg that exists to prove the restore happened passed on an
  // empty sweep for as long as it has existed (VACUOUS-LEG-AUDIT F4). The leg now also counts, so an
  // empty sweep can never read as a clean one again.
  const scene = game.scenes.getName("Review · Dark Range")
    ?? game.scenes.find(sc => sc.tokens.some(t => t.name === "Review · Target (Vehicle)"))
    ?? game.scenes.active;
  for (const m of [...game.messages].slice(baselineCards)) { try { await m.delete(); } catch (e) { /* gone */ } }
  const actor = game.actors.getName("Review · Shooter");
  await actor.updateEmbeddedDocuments("Item", actor.itemTypes.weapon
    .filter(w => w.getFlag(SCOPE, "reviewBench"))
    .map(w => ({ _id: w.id, "system.shotsLeft": Number(w.system.shots) })));
  await actor.updateEmbeddedDocuments("Item", actor.itemTypes.ammo
    .filter(a => a.getFlag(SCOPE, "reviewBench"))
    .map(a => ({ _id: a.id, "system.quantity": 60 })));
  const zeroed = [];
  const covered = [];
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
  canvas.tokens.releaseAll();   // §3 selected the firing figure for one of its shots
  try { await actor.sheet.close(); } catch (e) { /* closed */ }
  await new Promise(r => setTimeout(r, 800));
  return {
    zeroed, covered, restoreScene: scene?.name ?? null,
    magazines: actor.itemTypes.weapon.filter(w => w.getFlag(SCOPE, "reviewBench"))
      .every(w => Number(w.system.shotsLeft) === Number(w.system.shots)),
    ammoFull: actor.itemTypes.ammo.filter(a => a.getFlag(SCOPE, "reviewBench"))
      .every(a => Number(a.system.quantity) === 60),
    strayActors: game.actors.filter(a => a.name === "__PW__B1").length,
    // ⚠ THE SHOT RAIL'S TRANSIENTS ONLY — persistent condition overlays (module/fx/status-fx.js) are
    // supposed to still be on screen while their condition is, so a figure that is legitimately
    // burning must not read as a muzzle or tracer that never ended. See the same filter in the
    // review-bench smoke spec.
    liveEffects: (globalThis.Sequencer?.EffectManager?.effects ?? [])
      .filter(e => !String(e?.data?.name ?? "").startsWith("cp2020-augmented.statusfx.")).length,
    cards: game.messages.size,
    dialogs: [...foundry.applications.instances.values()].filter(a => /Damage|Modifiers/i.test(a?.constructor?.name ?? "")).length,
  };
}, { SCOPE, baselineCards: setup.baselineCards });

ok("restore: every bench magazine is full again", restored.magazines);
ok("restore: every bench ammo box is back at stock", restored.ammoFull);
// ⛔ THE COUNT IS HALF THE LEG. `[].every()` is true, so without a count an empty sweep — the state
// this leg was actually in for months — reads exactly like a clean one. All three bench figures have
// to have been REACHED, and each figure the sweep touched has to read back at rest. (Two of the three
// are unlinked, so each contributes BOTH its token actor and the world actor behind it; the entry
// count is therefore five, not three, and the names are what the claim is made about.)
ok("restore: all three bench targets were reached and are back to undamaged",
  restored.covered.length === 3 && restored.zeroed.length >= 3
  && restored.zeroed.every(z => /=0$|=60$|=30$/.test(z)),
  `scene=${restored.restoreScene} covered=[${restored.covered.join(", ")}] ${restored.zeroed.join(" · ")}`);
ok("restore: the synthesized fixture actor is gone", restored.strayActors === 0, `${restored.strayActors}`);
ok("restore: the canvas holds no live effect", restored.liveEffects === 0, `${restored.liveEffects}`);
ok("restore: the chat log is back where this run found it",
  restored.cards === setup.baselineCards, `${restored.cards} vs ${setup.baselineCards}`);
ok("restore: no dialog left open", restored.dialogs === 0, `${restored.dialogs}`);
ok("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const passed = checks.filter(c => c.p).length;
console.log(`\n===== B1 seam payload: ${passed}/${checks.length} =====`);
if (passed !== checks.length) for (const c of checks.filter(x => !x.p)) console.log(`  FAILED: ${c.n}   [${c.d}]`);
await b.close();
process.exit(passed === checks.length ? 0 : 1);
