/**
 * SMOKE TEST for the morning review bench (cp2020-augmented-provision-review-bench.mjs).
 *
 * NOT a keeper — it does not pin values. It answers one question: can a reviewer pick each gun off
 * the numbered list and fire it with ZERO loading steps, and does the thing that gun exists to show
 * actually reach the canvas? Every shot goes through the REAL UI PATH — the sheet's fire button, the
 * modifiers dialog, its submit — and every claim is read back off the ENGINE (the payload the seam
 * raised, the files Sequencer was handed, the region documents the pattern flow wrote), never off a
 * screenshot.
 *
 * It RESTORES what it disturbs: magazines refilled, target damage zeroed, its own chat cards deleted,
 * its own regions gone, the canvas cleared of effects, targets released. It touches no combat, no
 * other scene and no setting.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=<pw> node cp2020-augmented-review-bench-smoke.mjs
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "";
const SCOPE = "cp2020-augmented";

const checks = [];
const ok = (n, p, d = "") => { checks.push({ n, p: !!p, d: String(d) }); console.log(`${p ? "  ok  " : "  FAIL"}  ${n}${d ? `   [${d}]` : ""}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", e => errors.push(String(e.message)));

await page.goto(`${URL}/join`);
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const s = document.querySelector('select[name="userid"]');
  s.value = [...s.options].find(o => /gamemaster/i.test(o.textContent)).value;
  s.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 90000 });
await page.waitForTimeout(3000);

/* ── instrumentation: one tap on each engine that can answer a question ───────────────────────── */
const setup = await page.evaluate(async (SCOPE) => {
  const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
  const g = globalThis.__smoke = { files: [], payloads: [], raw: [], cards: [], regions: [] };
  Hooks.on("createSequencerEffect", (e) => {
    const f = String(e?.data?.file ?? e?.data?.src ?? "");
    if (f) g.files.push(f);
  });
  Hooks.on("cyberpunk2020.weaponFired", (p) => { g.raw.push(p); g.payloads.push({
    weaponName: p.weaponName, modifier: p.modifier ?? null, caliber: p.caliber ?? null,
    spreadMode: p.spreadMode ?? null, shotsFired: p.shotsFired, shotsHit: p.shotsHit,
    landed: Object.values(p.areaDamages ?? {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0),
  }); });
  Hooks.on("createChatMessage", (m) => g.cards.push(m.id));
  Hooks.on("createRegion", (r) => g.regions.push(r.id));

  const shooter = game.actors.getName("Review · Shooter");
  const scene = game.scenes.active;
  return {
    actorId: shooter.id,
    guns: Object.fromEntries(shooter.itemTypes.weapon
      .filter(w => w.getFlag(SCOPE, "reviewBench"))
      .map(w => [String(w.getFlag(SCOPE, "reviewBench").n).padStart(2, "0"), { id: w.id, name: w.name }])),
    tokens: Object.fromEntries(scene.tokens.map(t => [t.name, t.id])),
    // The keys the shipped file names, read out of it — nothing here is a hardcoded asset path.
    // `createSequencerEffect` reports the DATABASE KEY the section was handed (sometimes with a
    // range/variant suffix appended: "…yellow.1"), so the match below is key-prefix, not path.
    keys: {
      groundFire: fx.GROUND_FIRE.key, blood: fx.BLOOD_SPLATTER.key, baton: fx.BATON_ROUND.key,
      dust: fx.IMPACT_DUST.key, fireImpact: fx.IMPACT_FIRE.key,
      hitConfirm: fx.HIT_CONFIRM.key,
      // ⏪ The withdrawn ground mark (user ruling 2026-08-10). Named as a literal because the module no
      // longer exports a constant for it — leg D asserts it is never drawn.
      withdrawnGroundMark: "jb2a.scorched_earth.black",
    },
    autoApply: (() => { try { return game.settings.get(SCOPE, "damageAutoApply"); } catch (e) { return "?"; } })(),
    baseline: {
      cards: game.messages.size,
      regions: scene.regions.map(r => r.id),
      effects: (globalThis.Sequencer?.EffectManager?.effects ?? []).length,
    },
  };
}, SCOPE);

console.log(`\nbench guns found: ${Object.keys(setup.guns).length} · baseline: ${setup.baseline.regions.length} region(s), ${setup.baseline.effects} live effect(s), ${setup.baseline.cards} card(s)`);

/* ── the firing gesture, exactly as a reviewer performs it ───────────────────────────────────── */
async function fire(num, targetName) {
  const gun = setup.guns[num];
  await page.evaluate(async ({ actorId, gunId, tokenId }) => {
    const g = globalThis.__smoke;
    // ⚠ DRAIN FIRST. The apply window is DEFERRED until the shot's presentation settles and may take
    // up to PRESENTATION_CAP_MS (8 s) to appear, so a window opened by the PREVIOUS shot arrives long
    // after that shot's own read — and would otherwise be counted against this one. Close, wait past
    // the cap's remainder, close again.
    for (let i = 0; i < 2; i++) {
      for (const a of [...foundry.applications.instances.values()]) {
        if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
      }
      await new Promise(r => setTimeout(r, 1200));
    }
    g.files.length = 0; g.payloads.length = 0; g.raw.length = 0; g.regions.length = 0;
    canvas.tokens.get(tokenId).setTarget(true, { releaseOthers: true });
    const actor = game.actors.get(actorId);
    await actor.sheet.render(true);
    await new Promise(r => setTimeout(r, 1500));
    const el = actor.sheet.element.querySelector(`.fire-weapon[data-item-id="${gunId}"]`)
            ?? actor.sheet.element.querySelector(`[data-item-id="${gunId}"] .fire-weapon`);
    if (!el) throw new Error(`no fire button for ${gunId}`);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }, { actorId: setup.actorId, gunId: gun.id, tokenId: setup.tokens[targetName] });

  await page.waitForFunction(() => [...foundry.applications.instances.values()]
    .some(a => /ModifiersDialog/.test(a?.constructor?.name ?? "") && a.rendered === true), null, { timeout: 25000 });
  // Cap an automatic's burst so the smoke run does not dump a 30-round fan-out on the canvas.
  await page.evaluate(() => {
    const dlg = [...foundry.applications.instances.values()].find(a => /ModifiersDialog/.test(a?.constructor?.name ?? ""));
    const rounds = dlg.element.querySelector('input[name*="fullAutoRoundsFired"], input.full-auto-rounds');
    if (rounds) { rounds.value = "3"; rounds.dispatchEvent(new Event("change", { bubbles: true })); }
    const btn = dlg.element.querySelector('button[type="submit"], footer button');
    if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    else dlg.element.requestSubmit();
  });
  await page.waitForFunction(() => globalThis.__smoke.payloads.length > 0, null, { timeout: 25000 }).catch(() => {});
  // Past PRESENTATION_CAP_MS (8 s): the fan-out, the fires, the blood AND any deferred apply window.
  await page.waitForTimeout(9000);
  return page.evaluate(() => ({
    handled: globalThis.__smoke.raw.map(p => p.handled ?? null),
    files: [...new Set(globalThis.__smoke.files)],
    payloads: globalThis.__smoke.payloads,
    newRegions: globalThis.__smoke.regions,
    dialogs: [...foundry.applications.instances.values()].filter(a => /Damage/i.test(a?.constructor?.name ?? "")).map(a => a.constructor.name),
  }));
}
const landed = (r) => (r.payloads[0]?.landed ?? 0) > 0;
/** Fire until a round LANDS. A natural 1 is a ruled fumble and draws nothing at all by design, so a
 *  leg that needs an impact must be allowed to take the shot again rather than call the rail broken. */
async function fireUntilHit(num, targetName, tries = 6) {
  let r = await fire(num, targetName);
  for (let i = 1; i < tries && !landed(r); i++) r = await fire(num, targetName);
  return r;
}
const drew = (files, key) => files.some(f => f === key || f.startsWith(`${key}.`));

/* ══ A. 01 pistol Standard at the FLESH target — the baseline, and the blood gate ═════════════ */
console.log(`\n── A · 01 pistol Standard → Review · Target (flesh) ──`);
let r = await fireUntilHit("01", "Review · Target");
ok("A: the gun fired with no loading step and the seam raised its payload",
  r.payloads.length === 1, JSON.stringify(r.payloads[0] ?? null));
ok("A: the payload carries the loaded cartridge (the ammo link is live)",
  r.payloads[0]?.caliber === "10mm", `caliber=${r.payloads[0]?.caliber}`);
ok("A: the round landed (the bench can hit — skills, not weapon accuracy)",
  (r.payloads[0]?.landed ?? 0) > 0, `${r.payloads[0]?.landed} location(s)`);
ok("A: BLOOD is drawn on a flesh hit with gore on",
  drew(r.files, setup.keys.blood), r.files.join(", ").slice(0, 200));

/* ══ B. 01 pistol at the VEHICLE — the same shot must draw NO blood ═══════════════════════════ */
console.log(`\n── B · 01 pistol Standard → Review · Target (Vehicle) — the negative ──`);
r = await fireUntilHit("01", "Review · Target (Vehicle)");
ok("B: the shot landed on the vehicle", (r.payloads[0]?.landed ?? 0) > 0, `${r.payloads[0]?.landed} location(s)`);
ok("B: and NO blood is drawn — a vehicle takes damage into structure (negative)",
  !drew(r.files, setup.keys.blood), r.files.join(", ").slice(0, 200));

/* ══ C. 05 SMG Rubber — the baton round ═══════════════════════════════════════════════════════ */
console.log(`\n── C · 05 H&K MPK-9 Rubber → Review · Target (flesh) ──`);
r = await fireUntilHit("05", "Review · Target");
ok("C: the baton round's own asset is drawn — the round is a different picture, not a dimmer one",
  drew(r.files, setup.keys.baton), r.files.join(", ").slice(0, 200));
ok("C: and the hit mark is the DUST PUFF, not the ordinary impact",
  drew(r.files, setup.keys.dust), r.files.join(", ").slice(0, 200));

/* ══ D. 07 rifle API — burning ground on the single-target flow ═══════════════════════════════ */
console.log(`\n── D · 07 Militech Ronin API → Review · Target (flesh) ──`);
r = await fireUntilHit("07", "Review · Target");
ok("D: the incendiary load sets BURNING GROUND where the rounds fell",
  drew(r.files, setup.keys.groundFire), r.files.join(", ").slice(0, 220));
// ⏪ INVERTED 2026-08-10 (user ruling "kill it"): this leg used to require one dark ground mark under
// the flames. The element is removed entirely — the flames are unchanged — so the leg now pins its
// absence on the same census.
ok("D: and NO ground mark is left under them — the decal is withdrawn (negative)",
  !drew(r.files, setup.keys.withdrawnGroundMark), r.files.join(", ").slice(0, 220));
// ⏪ REPOINTED 2026-08-10 — this leg used to require the FIRE impact mark on the target, which is the
// promotion the 2026-08-09 ruling withdrew (*"get rid of the blast circle that lands on the target. I
// think multiple are being placed"*): the row names no `impactKey` any more, so the load falls through
// to the class's own hit mark. The leg had been asserting the behaviour the ruling deleted. It now
// asserts the ruled one, with the withdrawn asset as its negative — the same shape the fx-rail spec's
// api section uses.
ok("D: the hit mark is the CLASS's own, and the withdrawn burning ring stays withdrawn (negative)",
  drew(r.files, setup.keys.hitConfirm) && !drew(r.files, setup.keys.fireImpact), r.files.join(", ").slice(0, 220));
const liveFires = await page.evaluate(() => (globalThis.Sequencer?.EffectManager?.effects ?? []).length);
ok("D: the fires are really alive on the canvas afterwards", liveFires > 0, `${liveFires} live effect(s)`);

/* ══ E. 10 shell Buckshot — the RAW pattern, its confirm card, and the delete on confirm ══════ */
console.log(`\n── E · 10 Arasaka RAS-12 Buckshot → Review · Target (flesh) ──`);
r = await fire("10", "Review · Target");   // NOT retried: a pattern is thrown hit or miss, and two would be two
ok("E: the cartridge resolves to the BUCK pattern, not a single-target shot",
  r.payloads[0]?.caliber === "00", `caliber=${r.payloads[0]?.caliber} spreadMode=${r.payloads[0]?.spreadMode}`);
const pat = await page.evaluate((SCOPE) => {
  const zones = game.scenes.active.regions.filter(x => x.getFlag(SCOPE, "isSpreadZone"));
  const card = [...game.messages].reverse().find(m => (m.content ?? "").includes("cp-confirm-spread-zone"));
  return { zones: zones.map(z => ({ id: z.id, band: z.getFlag(SCOPE, "band"), shells: z.getFlag(SCOPE, "shells"),
      dmg: z.getFlag(SCOPE, "dmgFormula") })), cardId: card?.id ?? null };
}, SCOPE);
ok("E: a shot PATTERN is placed on the canvas", pat.zones.length === 1, JSON.stringify(pat.zones));
ok("E: banded from the real token distance, one pattern for the whole burst",
  pat.zones[0]?.band === "Medium" && Number(pat.zones[0]?.shells) >= 1,
  `band=${pat.zones[0]?.band} shells=${pat.zones[0]?.shells} dmg=${pat.zones[0]?.dmg}`);
ok("E: the single-target flow did NOT claim this payload — the pattern owns it (negative)",
  r.handled.every(h => h === null), JSON.stringify(r.handled));
ok("E: and no apply window opened for it", r.dialogs.length === 0, r.dialogs.join(", "));
ok("E: a GM Confirm card was posted", !!pat.cardId, pat.cardId ?? "none");
// the real gesture: click the button on the rendered card
const confirmed = await page.evaluate(async ({ cardId }) => {
  const el = document.querySelector(`[data-message-id="${cardId}"] .cp-confirm-spread-zone`);
  if (!el) return { clicked: false };
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return { clicked: true };
}, { cardId: pat.cardId });
// POLLED, not slept on: the confirm rolls every shell against every token in the path, posts a result
// card and scatters the load's fires before it deletes — a fixed wait raced all three.
await page.waitForFunction((SCOPE) =>
  game.scenes.active.regions.filter(x => x.getFlag(SCOPE, "isSpreadZone")).length === 0,
  SCOPE, { timeout: 20000 }).catch(() => {});
const afterConfirm = await page.evaluate((SCOPE) => ({
  zones: game.scenes.active.regions.filter(x => x.getFlag(SCOPE, "isSpreadZone")).length,
}), SCOPE);
ok("E: the Confirm button on the card is clickable", confirmed.clicked);
ok("E: confirming DELETES the pattern — nothing is left hovering", afterConfirm.zones === 0, `${afterConfirm.zones} left`);

/* ══ F. 11 shell SLUG — the single-target contrast: no pattern, an apply route ════════════════ */
console.log(`\n── F · 11 Arasaka RAS-12 Slug → Review · Target (flesh) ──`);
r = await fireUntilHit("11", "Review · Target");
const slug = await page.evaluate((SCOPE) => ({
  zones: game.scenes.active.regions.filter(x => x.getFlag(SCOPE, "isSpreadZone")).length,
  flagged: [...game.messages].slice(-4).filter(m => !!m.getFlag(SCOPE, "damagePayload")).length,
  dialogs: [...foundry.applications.instances.values()].filter(a => /Damage/i.test(a?.constructor?.name ?? "")).map(a => a.constructor.name),
}), SCOPE);
ok("F: the slug is the same cartridge but declares its own spread mode",
  r.payloads[0]?.caliber === "00" && r.payloads[0]?.spreadMode === "slug",
  `caliber=${r.payloads[0]?.caliber} spreadMode=${r.payloads[0]?.spreadMode}`);
ok("F: NO pattern is thrown (negative) — the one shell load that is a single projectile",
  slug.zones === 0, `${slug.zones} pattern(s)`);
ok("F: the single-target flow CLAIMS it — the other half of the either/or",
  r.handled.some(h => h === "cp2020-augmented"), JSON.stringify(r.handled));
ok("F: and an apply route reaches the reviewer for this shot",
  slug.dialogs.length > 0 || slug.flagged > 0 || setup.autoApply === true,
  `${slug.dialogs.join(",") || "no window"} / ${slug.flagged} flagged card(s) / autoApply=${setup.autoApply}`);

/* ══ G. 12 shell API — the pattern's OWN fires, placed on confirm ═════════════════════════════ */
console.log(`\n── G · 12 Arasaka RAS-12 API → Review · Target (flesh) ──`);
await page.evaluate(async () => {
  for (const a of [...foundry.applications.instances.values()]) {
    if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
  }
  try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none */ }
});
r = await fire("12", "Review · Target");   // same reason as E
ok("G: an incendiary SHELL draws no fires yet — the pattern owns them until the GM commits (negative)",
  !drew(r.files, setup.keys.groundFire), r.files.join(", ").slice(0, 220));
const patG = await page.evaluate((SCOPE) => {
  const z = game.scenes.active.regions.find(x => x.getFlag(SCOPE, "isSpreadZone"));
  const card = [...game.messages].reverse().find(m => (m.content ?? "").includes("cp-confirm-spread-zone"));
  return { zone: z?.id ?? null, ammoKey: z?.getFlag(SCOPE, "ammoKey") ?? null, cardId: card?.id ?? null };
}, SCOPE);
ok("G: the pattern records the load it was thrown with", patG.ammoKey === "api", `ammoKey=${patG.ammoKey}`);
const gFiles = await page.evaluate(async ({ cardId }) => {
  globalThis.__smoke.files.length = 0;
  const el = document.querySelector(`[data-message-id="${cardId}"] .cp-confirm-spread-zone`);
  el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 5000));
  return [...new Set(globalThis.__smoke.files)];
}, { cardId: patG.cardId });
ok("G: and on CONFIRM the fires go down the path", drew(gFiles, setup.keys.groundFire), gFiles.join(", ").slice(0, 220));
const afterG = await page.evaluate((SCOPE) =>
  game.scenes.active.regions.filter(x => x.getFlag(SCOPE, "isSpreadZone")).length, SCOPE);
ok("G: that pattern is deleted too", afterG === 0, `${afterG} left`);

/* ══ RESTORE ══════════════════════════════════════════════════════════════════════════════════ */
console.log(`\n── restore ──`);
const restored = await page.evaluate(async ({ SCOPE, baselineCards, baselineRegions }) => {
  for (const a of [...foundry.applications.instances.values()]) {
    if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
  }
  try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none */ }
  const scene = game.scenes.active;
  // any pattern this run left behind
  const strayZones = scene.regions.filter(r => !baselineRegions.includes(r.id));
  if (strayZones.length) await scene.deleteEmbeddedDocuments("Region", strayZones.map(r => r.id));
  // this run's cards only — the baseline count is the cut line
  const mine = [...game.messages].slice(baselineCards);
  for (const m of mine) { try { await m.delete(); } catch (e) { /* gone */ } }
  // magazines back to full
  const actor = game.actors.getName("Review · Shooter");
  const refill = actor.itemTypes.weapon.filter(w => w.getFlag(SCOPE, "reviewBench"))
    .map(w => ({ _id: w.id, "system.shotsLeft": Number(w.system.shots) }));
  await actor.updateEmbeddedDocuments("Item", refill);
  // ammo boxes back to stock
  const ammo = actor.itemTypes.ammo.filter(a => a.getFlag(SCOPE, "reviewBench"))
    .map(a => ({ _id: a.id, "system.quantity": 60 }));
  await actor.updateEmbeddedDocuments("Item", ammo);
  // damage zeroed + effects the shots left on the targets
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
  try { await actor.sheet.close(); } catch (e) { /* closed */ }
  await new Promise(r => setTimeout(r, 800));
  return {
    zeroed,
    magazines: actor.itemTypes.weapon.filter(w => w.getFlag(SCOPE, "reviewBench"))
      .every(w => Number(w.system.shotsLeft) === Number(w.system.shots)),
    ammoFull: actor.itemTypes.ammo.filter(a => a.getFlag(SCOPE, "reviewBench"))
      .every(a => Number(a.system.quantity) === 60),
    regions: scene.regions.map(r => r.name),
    liveEffects: (globalThis.Sequencer?.EffectManager?.effects ?? []).length,
    cards: game.messages.size,
    dialogs: [...foundry.applications.instances.values()].filter(a => /Damage|Modifiers/i.test(a?.constructor?.name ?? "")).length,
  };
}, { SCOPE, baselineCards: setup.baseline.cards, baselineRegions: setup.baseline.regions });

ok("restore: every magazine is full again", restored.magazines);
ok("restore: every ammo box is back at stock", restored.ammoFull);
ok("restore: damage is zero on all three targets", restored.zeroed.every(z => /=0$|=60$|=30$/.test(z)), restored.zeroed.join(" · "));
ok("restore: the canvas holds no live effect", restored.liveEffects === 0, `${restored.liveEffects}`);
ok("restore: only the three cover regions remain", restored.regions.length === setup.baseline.regions.length, restored.regions.join(", "));
ok("restore: the chat log is back to where this run found it",
  restored.cards === setup.baseline.cards, `${restored.cards} vs ${setup.baseline.cards}`);
ok("restore: no dialog left open", restored.dialogs === 0, `${restored.dialogs}`);
ok("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const passed = checks.filter(c => c.p).length;
console.log(`\n=== review-bench smoke: ${passed}/${checks.length} ===`);
if (passed !== checks.length) for (const c of checks.filter(x => !x.p)) console.log(`  FAILED: ${c.n}   [${c.d}]`);
await browser.close();
process.exit(passed === checks.length ? 0 : 1);
