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
 * through the real UI path, read off the hook.
 *
 * It restores what it disturbs: magazines refilled, target damage zeroed, its own cards deleted,
 * dialogs closed, canvas effects ended, targets released. It touches no setting.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=<pw> node cp2020-augmented-b1-seam-payload.mjs
 */
import { chromium } from "@playwright/test";

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

const setup = await p.evaluate((SCOPE) => {
  const g = globalThis.__b1 = { payloads: [] };
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
  const scene = game.scenes.active;
  return {
    found: !!shooter,
    actorId: shooter?.id ?? null,
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
  const scene = game.scenes.active;
  for (const m of [...game.messages].slice(baselineCards)) { try { await m.delete(); } catch (e) { /* gone */ } }
  const actor = game.actors.getName("Review · Shooter");
  await actor.updateEmbeddedDocuments("Item", actor.itemTypes.weapon
    .filter(w => w.getFlag(SCOPE, "reviewBench"))
    .map(w => ({ _id: w.id, "system.shotsLeft": Number(w.system.shots) })));
  await actor.updateEmbeddedDocuments("Item", actor.itemTypes.ammo
    .filter(a => a.getFlag(SCOPE, "reviewBench"))
    .map(a => ({ _id: a.id, "system.quantity": 60 })));
  const zeroed = [];
  for (const name of ["Review · Target", "Review · Target (Cyberlimb)", "Review · Target (Vehicle)"]) {
    const t = scene.tokens.find(x => x.name === name);
    if (!t) continue;
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
    zeroed,
    magazines: actor.itemTypes.weapon.filter(w => w.getFlag(SCOPE, "reviewBench"))
      .every(w => Number(w.system.shotsLeft) === Number(w.system.shots)),
    ammoFull: actor.itemTypes.ammo.filter(a => a.getFlag(SCOPE, "reviewBench"))
      .every(a => Number(a.system.quantity) === 60),
    strayActors: game.actors.filter(a => a.name === "__PW__B1").length,
    liveEffects: (globalThis.Sequencer?.EffectManager?.effects ?? []).length,
    cards: game.messages.size,
    dialogs: [...foundry.applications.instances.values()].filter(a => /Damage|Modifiers/i.test(a?.constructor?.name ?? "")).length,
  };
}, { SCOPE, baselineCards: setup.baselineCards });

ok("restore: every bench magazine is full again", restored.magazines);
ok("restore: every bench ammo box is back at stock", restored.ammoFull);
ok("restore: the targets are undamaged", restored.zeroed.every(z => /=0$|=60$|=30$/.test(z)), restored.zeroed.join(" · "));
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
