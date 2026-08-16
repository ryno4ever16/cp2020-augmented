/** Honest conditional-armor DISPLAY (D5 typed-SP panel). The damage-side typed-SP MATH is covered by
 *  cp2020-augmented-typed-sp.mjs; THIS keeper covers the actor SHEET/panel that the prepareData wrap
 *  (module/mech/typed-armor-display.js) produces:
 *    • system.hitLocations[loc].stoppingPower is OVERWRITTEN with the honest CONVENTIONAL total, so a
 *      fire-only Salamander stops inflating the panel vs a bullet (the user's motivating complaint).
 *    • system.conditionalSP is published per typed damage-type for the sub-panel.
 *  Both come from the SAME exported _deriveLiveSP the damage pipeline uses → panel == damage math (the
 *  whole point). Also proves the derived map STICKS to the rendered sheet (section renders, main panel
 *  deflates) — the one thing the build subagent flagged to verify on a rig.
 *
 *  Legs F-K cover the OWNED-BUT-UNWORN cue on the same panel (live-table incident 2026-08-15): armor
 *  arrives from the shop switched off, and nothing said so. F the wearable/unworn predicate, G the two
 *  cue surfaces on an ordinary wearer, H the incident itself (a full-borg chassis fills all six SP
 *  boxes, and the cue still lands), I the all-worn negative, J the not-wearable-armor negative, K the
 *  purchase receipt's equip line and its non-armor negative.
 *  Runs on :30004 (1.1.1 + module). */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [], warns = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); else if (m.type() === "warning") warns.push(m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = {};
  const A = await import("/modules/cp2020-augmented/module/combat/DamageApplicator.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const LOCS = ["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"];

  // Real Salamander Jacket coverage: fire 20 on Torso/lArm/rArm, 0 elsewhere; fully-typed (sp 0).
  const SALAMANDER = { Head: 0, Torso: 20, lArm: 20, rArm: 20, lLeg: 0, rLeg: 0 };
  const covMap = (m) => Object.fromEntries(LOCS.map(k => [k, { stoppingPower: String(m[k] ?? 0), ablation: 0 }]));
  const covUniform = (sp) => Object.fromEntries(LOCS.map(k => [k, { stoppingPower: String(sp), ablation: 0 }]));
  const salamanderItem = () => ({ name: "__PW__Salamander Jacket", type: "armor",
    system: { equipped: true, armorType: "Soft", coverage: covMap(SALAMANDER), mechTypedSP: { type: "fire", sp: 0 } } });
  const kevlarItem = (sp) => ({ name: "__PW__Kevlar", type: "armor",
    system: { equipped: true, armorType: "Soft", coverage: covUniform(sp) } });

  const panel = (a, loc) => Number(a.system?.hitLocations?.[loc]?.stoppingPower);
  const live = (a, loc, type = "") => Number(A._deriveLiveSP(a, loc, type)) || 0;
  // The whole contract: after our wrap, the panel at EVERY armor loc equals the damage system's own
  // conventional SP; and every published conditional entry equals the damage system's typed SP.
  const panelMatchesLive = (a) => LOCS.every(loc => panel(a, loc) === live(a, loc, ""));
  const condMatchesLive = (a) => {
    const c = a.system?.conditionalSP; if (!c) return true;
    return Object.entries(c).every(([type, locs]) => Object.entries(locs).every(([loc, sp]) => sp === live(a, loc, type)));
  };
  const mk = async (name, items) => {
    const a = await Actor.create({ name, type: "character" });
    if (items?.length) await a.createEmbeddedDocuments("Item", items);
    a.prepareData();
    return a;
  };

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__CondArmor"))) await a.delete().catch(() => {});

  // ── (A) Salamander ALONE — panel deflates to 0 (typed-only), conditional shows fire on covered locs ──
  const salA = await mk("__PW__CondArmor Salamander", [salamanderItem()]);
  out.salamander = {
    panelMatchesLive: panelMatchesLive(salA),
    condMatchesLive: condMatchesLive(salA),
    torsoPanel: panel(salA, "Torso"),                              // 0 — stops nothing vs a normal hit
    condFireTorso: salA.system?.conditionalSP?.fire?.Torso,        // 20
    condFireLArm: salA.system?.conditionalSP?.fire?.lArm,          // 20
    condFireRArm: salA.system?.conditionalSP?.fire?.rArm,          // 20
    condFireHead: salA.system?.conditionalSP?.fire?.Head,          // undefined (coverage 0 → not surfaced)
    condFireLLeg: salA.system?.conditionalSP?.fire?.lLeg,          // undefined
    condTypes: Object.keys(salA.system?.conditionalSP ?? {}).sort().join(","), // "fire" only
  };

  // ── (B) Salamander OVER kevlar 18 — panel = 18 (coat skipped on normal), conditional fire = 25 (>18) ──
  const salB = await mk("__PW__CondArmor SalKevlar", [salamanderItem(), kevlarItem(18)]);
  out.salKevlar = {
    panelMatchesLive: panelMatchesLive(salB),
    condMatchesLive: condMatchesLive(salB),
    torsoPanel: panel(salB, "Torso"),                              // 18
    condFireTorso: salB.system?.conditionalSP?.fire?.Torso,        // 25 (proportional combine 20+18)
    condExceedsConv: (salB.system?.conditionalSP?.fire?.Torso ?? 0) > panel(salB, "Torso"), // 25 > 18
  };

  // ── (C) NON-typed actor (kevlar only) — no conditionalSP, panel == base (early-return path) ──
  const plain = await mk("__PW__CondArmor Plain", [kevlarItem(14)]);
  out.plain = {
    noConditional: plain.system?.conditionalSP === undefined,
    torsoPanel: panel(plain, "Torso"),                             // 14
    panelMatchesLive: panelMatchesLive(plain),
  };

  // ── (D) Remove the only typed layer → conditionalSP CLEARS (no stale section) ──
  await salA.deleteEmbeddedDocuments("Item", salA.items.map(i => i.id));
  salA.prepareData();
  out.cleared = { noConditional: salA.system?.conditionalSP === undefined, torsoPanel: panel(salA, "Torso") };

  // ── (E) SHEET RENDER — conditionalSP STICKS to the template: section renders + main panel shows 0 ──
  await salA.createEmbeddedDocuments("Item", [salamanderItem()]);
  salA.prepareData();
  out.reArmed = { condFireTorso: salA.system?.conditionalSP?.fire?.Torso }; // 20 again
  await salA.sheet.render(true);
  // Poll for the proven-present armor panel (the anchor); activate the combat tab if the sheet lazy-renders.
  let root = null, anchor = null;
  for (let i = 0; i < 30; i++) {
    root = salA.sheet.element instanceof HTMLElement ? salA.sheet.element : salA.sheet.element?.[0];
    anchor = root?.querySelector(".armor-display");
    if (anchor) break;
    root?.querySelector('[data-tab="combat"]')?.click();
    await sleep(100);
  }
  const condSection = root?.querySelector(".cp-conditional-armor");
  const torsoInput = root?.querySelector('input[name="system.hitLocations.Torso.stoppingPower"]');
  const condText = (condSection?.textContent || "").replace(/\s+/g, " ").trim();
  out.render = {
    anchorPresent: !!anchor,
    sectionPresent: !!condSection,
    sectionText: condText,
    mentionsFire: /Fire/i.test(condText),
    mentions20: /\b20\b/.test(condText),
    torsoInputValue: torsoInput?.value,                            // "0" — the honest deflation
  };
  await salA.sheet.close().catch(() => {});

  // ══ OWNED-BUT-UNWORN CUE ══════════════════════════════════════════════════════════════════
  // Live-table incident 2026-08-15: armor bought from the shop arrives `equipped: false` and the
  // panel said nothing about it. On a full-conversion borg the chassis fills all six SP boxes, so an
  // unworn coat looked exactly like a worn one. Legs F-K cover both cue surfaces and every negative.
  const U = await import("/modules/cp2020-augmented/module/utils.js");
  const L = (k) => game.i18n.localize("CYBERPUNK." + k);
  const unwornSalamander = () => { const it = salamanderItem(); it.system.equipped = false; return it; };
  const unwornKevlar = (sp) => { const it = kevlarItem(sp); it.system.equipped = false; return it; };
  // An armor item that protects nowhere: owned, switched off, and (correctly) NOT a missing protection.
  const emptyArmor = () => ({ name: "__PW__Empty Wrap", type: "armor",
    system: { equipped: false, armorType: "Soft", coverage: covUniform(0) } });

  /** Render an actor's combat tab and read every unworn-cue surface off the live DOM. */
  const readArmorPanel = async (a) => {
    await a.sheet.render(true);
    // Poll until the armor grid is not just IN the DOM but LAID OUT — the combat tab starts inactive
    // (display:none), and measuring a hidden tab would call every cue invisible whether or not it is.
    let root = null, gridAnchor = null;
    for (let i = 0; i < 40; i++) {
      root = a.sheet.element instanceof HTMLElement ? a.sheet.element : a.sheet.element?.[0];
      gridAnchor = root?.querySelector(".armor-display");
      if (gridAnchor && gridAnchor.getBoundingClientRect().height > 0) break;
      (root?.querySelector('nav [data-tab="combat"]') ?? root?.querySelector('[data-tab="combat"]'))?.click();
      await sleep(120);
    }
    const notice = root?.querySelector(".cp-unworn-armor-notice");
    const badges = Array.from(root?.querySelectorAll(".cp-armor-unworn-badge") ?? []);
    const rows = Array.from(root?.querySelectorAll(".armor-section .field-list.one-col > .field") ?? []);
    const nameOf = (row) => (row.querySelector("label.name")?.textContent || "").trim();
    const shown = (el) => { if (!el) return false; const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0
             && el.getBoundingClientRect().height > 0; };
    const res = {
      gridAnchorPresent: !!gridAnchor,
      gridLaidOut: !!gridAnchor && gridAnchor.getBoundingClientRect().height > 0,
      torsoInputValue: root?.querySelector('input[name="system.hitLocations.Torso.stoppingPower"]')?.value,
      noticePresent: !!notice,
      noticeVisible: shown(notice),
      noticeText: (notice?.textContent || "").replace(/\s+/g, " ").trim(),
      noticeInk: notice ? getComputedStyle(notice).color : null,
      noticeRule: notice ? getComputedStyle(notice).borderLeftColor : null,
      badgeCount: badges.length,
      badgeTexts: badges.map(b => (b.textContent || "").trim()),
      badgeVisible: shown(badges[0]),
      badgeInk: badges[0] ? getComputedStyle(badges[0]).color : null,
      rowNames: rows.map(nameOf),
      markedRowNames: rows.filter(r => r.classList.contains("cp-armor-row-unworn")).map(nameOf),
    };
    await a.sheet.close().catch(() => {});
    return res;
  };

  out.strings = {
    notWorn: L("ArmorNotWorn"),
    notice1: game.i18n.format("CYBERPUNK.ArmorUnwornNotice", { count: 1, names: "X" }),
    shopLine: L("ShopArmorUnworn"),
  };

  // ── (F) predicate — what "wearable but unworn" means, stated in values ──
  // Absent export ⇒ null, not a throw: a missing predicate must red its OWN legs, not abort the run
  // and hide the DOM legs behind it.
  const uw = (x) => (typeof U.isUnwornArmor === "function" ? U.isUnwornArmor(x) : null);
  out.predicate = {
    unwornCovering: uw(unwornSalamander()),                 // true
    wornCovering: uw(salamanderItem()),                     // false — it is on
    unwornButProtectsNowhere: uw(emptyArmor()),             // false — nothing to miss
    unwornWeapon: uw({ type: "weapon", system: { equipped: false } }),   // false
    unwornCyberware: uw({ type: "cyberware", system: { equipped: false,
      coverage: covUniform(10) } }),                        // false — not armor
    nullSafe: uw(null),                                     // false
  };

  // ── (G) an unworn coat on an ORDINARY wearer: row badge + panel notice ──
  const unwornOnly = await mk("__PW__CondArmor UnwornOnly", [unwornSalamander()]);
  out.unwornOnly = await readArmorPanel(unwornOnly);
  out.unwornOnlyNoConditional = unwornOnly.system?.conditionalSP === undefined; // it is off → no typed fold

  // ── (H) THE INCIDENT: full-borg chassis (SP 40 everywhere) masks the grid, cue still lands ──
  const borg = await mk("__PW__CondArmor BorgMasked", [
    { name: "__PW__CondArmor Chassis", type: "cyberware",
      system: { equipped: true, EffectMode: "Permanent" },
      flags: { "cp2020-augmented": { borgBody: {
        sp:  { Head: 40, Torso: 40, lArm: 40, rArm: 40, lLeg: 40, rLeg: 40 },
        sdp: { Head: 40, Torso: 40, lArm: 40, rArm: 40, lLeg: 40, rLeg: 40 } } } } },
    unwornSalamander(),
  ]);
  for (let i = 0; i < 25 && Number(borg.system?.hitLocations?.Torso?.stoppingPower) !== 40; i++) await sleep(200);
  out.borgMasked = await readArmorPanel(borg);

  // ── (I) NEGATIVE — every piece worn ⇒ no badge, no notice ──
  const allWorn = await mk("__PW__CondArmor AllWorn", [salamanderItem(), kevlarItem(18)]);
  out.allWorn = await readArmorPanel(allWorn);

  // ── (J) NEGATIVE — nothing that is not wearable armor raises a cue ──
  const nonArmor = await mk("__PW__CondArmor NonArmor", [
    { name: "__PW__Unworn Pistol", type: "weapon", system: { equipped: false } },
    { name: "__PW__Unworn Kit", type: "misc", system: { equipped: false } },
    emptyArmor(),
  ]);
  out.nonArmor = await readArmorPanel(nonArmor);

  // ── (K) THE SHOP HANDOFF — the receipt says the coat arrived unworn ──
  const buyer = await mk("__PW__CondArmor Buyer", []);
  await buyer.update({ "system.eurobucks": 5000 });
  const P = await import("/modules/cp2020-augmented/module/shop/purchase.js");
  const src = await fromUuid("Compendium.cp2020-augmented.supplement-armor.Item.6yIgR0Bxa4pdmGfc");
  const before = new Set(game.messages.map(m => m.id));
  const boughtOk = src ? await P.buyItem(buyer, src, { qty: 1 }) : null;
  for (let i = 0; i < 25 && game.messages.filter(m => !before.has(m.id)).length === 0; i++) await sleep(200);
  const newMsgs = game.messages.filter(m => !before.has(m.id));
  const boughtItem = buyer.items.find(i => i.type === "armor");
  out.shop = {
    sourceResolved: !!src,
    sourceName: src?.name ?? null,
    bought: boughtOk,
    arrivesUnworn: boughtItem ? boughtItem.system?.equipped === false : null,
    cardCount: newMsgs.length,
    cardText: newMsgs.map(m => (m.content || "").replace(/\s+/g, " ").trim()).join(" | "),
  };
  // A NEGATIVE on the same path: a weapon's receipt carries no equip line.
  const before2 = new Set(game.messages.map(m => m.id));
  await P.buyItem(buyer, { name: "__PW__Buy Pistol", type: "weapon", system: { cost: 50, equipped: false } }, { qty: 1 });
  for (let i = 0; i < 25 && game.messages.filter(m => !before2.has(m.id)).length === 0; i++) await sleep(200);
  const newMsgs2 = game.messages.filter(m => !before2.has(m.id));
  out.shopNegative = {
    cardCount: newMsgs2.length,
    cardText: newMsgs2.map(m => (m.content || "").replace(/\s+/g, " ").trim()).join(" | "),
  };
  for (const m of [...newMsgs, ...newMsgs2]) await m.delete().catch(() => {});

  for (const a of [salA, salB, plain, unwornOnly, borg, allWorn, nonArmor, buyer]) await a.delete().catch(() => {});
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__CondArmor"))) await a.delete().catch(() => {});
  return out;
});

const checks = {
  // (A) Salamander alone: panel honest, conditional faithful
  A_panelMatchesLive: r.salamander?.panelMatchesLive === true,
  A_condMatchesLive: r.salamander?.condMatchesLive === true,
  A_torsoDeflatesTo0: r.salamander?.torsoPanel === 0,
  A_condFireTorso20: r.salamander?.condFireTorso === 20,
  A_condFireArms20: r.salamander?.condFireLArm === 20 && r.salamander?.condFireRArm === 20,
  A_condFireSkipsZeroCov: r.salamander?.condFireHead === undefined && r.salamander?.condFireLLeg === undefined,
  A_onlyFireType: r.salamander?.condTypes === "fire",
  // (B) over kevlar: conventional = kevlar only, conditional = combined & clearly extra
  B_panelMatchesLive: r.salKevlar?.panelMatchesLive === true,
  B_condMatchesLive: r.salKevlar?.condMatchesLive === true,
  B_torso18: r.salKevlar?.torsoPanel === 18,
  B_condFire25: r.salKevlar?.condFireTorso === 25,
  B_condExceedsConv: r.salKevlar?.condExceedsConv === true,
  // (C) non-typed actor untouched
  C_noConditional: r.plain?.noConditional === true,
  C_torso14: r.plain?.torsoPanel === 14,
  C_panelMatchesLive: r.plain?.panelMatchesLive === true,
  // (D) removing the typed layer clears the derived map
  D_clearedNoConditional: r.cleared?.noConditional === true,
  D_clearedTorso0: r.cleared?.torsoPanel === 0,
  // (E) sticks through to a rendered sheet
  E_reArmed: r.reArmed?.condFireTorso === 20,
  E_anchorPresent: r.render?.anchorPresent === true,
  E_sectionPresent: r.render?.sectionPresent === true,
  E_mentionsFire: r.render?.mentionsFire === true,
  E_mentions20: r.render?.mentions20 === true,
  E_torsoDeflatedInDom: r.render?.torsoInputValue === "0",

  // ── (F) the predicate that decides what the cue may speak about ──
  F_unwornCoveringPiece: r.predicate?.unwornCovering === true,
  F_wornPieceExcluded: r.predicate?.wornCovering === false,
  F_protectsNowhereExcluded: r.predicate?.unwornButProtectsNowhere === false,
  F_weaponExcluded: r.predicate?.unwornWeapon === false,
  F_cyberwareExcluded: r.predicate?.unwornCyberware === false,
  F_nullSafe: r.predicate?.nullSafe === false,
  // localized, not raw keys — the cue must never render as an i18n path
  F_stringsLocalized:
    r.strings?.notWorn === "Not worn"
    && /Not worn \(1\)/.test(r.strings?.notice1 || "")
    && /X/.test(r.strings?.notice1 || "")
    && /unworn/i.test(r.strings?.shopLine || ""),

  // ── (G) unworn coat, ordinary wearer: both cue surfaces render ──
  G_gridRendered: r.unwornOnly?.gridAnchorPresent === true && r.unwornOnly?.gridLaidOut === true,
  G_rowMarked: JSON.stringify(r.unwornOnly?.markedRowNames) === JSON.stringify(["__PW__Salamander Jacket"]),
  G_badgeCount1: r.unwornOnly?.badgeCount === 1,
  G_badgeSaysNotWorn: r.unwornOnly?.badgeTexts?.[0] === r.strings?.notWorn,
  G_badgeVisible: r.unwornOnly?.badgeVisible === true,
  G_noticeVisible: r.unwornOnly?.noticeVisible === true,
  G_noticeNamesThePiece: /__PW__Salamander Jacket/.test(r.unwornOnly?.noticeText || ""),
  G_noticeSaysNotWorn: /Not worn \(1\)/.test(r.unwornOnly?.noticeText || ""),
  // the cue is COLOURED, not just present: ink differs from the row's default whitesmoke value box
  G_badgeInkDistinct: !!r.unwornOnly?.badgeInk && r.unwornOnly?.badgeInk !== "rgb(245, 245, 245)",
  G_noticeHasRule: !!r.unwornOnly?.noticeRule && r.unwornOnly?.noticeRule !== "rgba(0, 0, 0, 0)",
  // an unworn typed layer publishes no conditional map (it is off) — the masking half of the incident
  G_noConditionalWhileOff: r.unwornOnlyNoConditional === true,

  // ── (H) THE INCIDENT — the borg chassis fills the grid AND the cue still lands ──
  H_chassisMasksGrid: r.borgMasked?.torsoInputValue === "40",
  H_noticeStillVisible: r.borgMasked?.noticeVisible === true,
  H_noticeNamesThePiece: /__PW__Salamander Jacket/.test(r.borgMasked?.noticeText || ""),
  H_rowStillMarked: JSON.stringify(r.borgMasked?.markedRowNames) === JSON.stringify(["__PW__Salamander Jacket"]),
  H_badgeCount1: r.borgMasked?.badgeCount === 1,

  // ── (I) NEGATIVE — everything worn ⇒ silence ──
  I_bothRowsPresent: (r.allWorn?.rowNames?.length ?? 0) === 2,
  I_noRowMarked: (r.allWorn?.markedRowNames?.length ?? 0) === 0,
  I_noBadge: r.allWorn?.badgeCount === 0,
  I_noNotice: r.allWorn?.noticePresent === false,

  // ── (J) NEGATIVE — a weapon, a misc item and a protects-nowhere wrap raise nothing ──
  J_noBadge: r.nonArmor?.badgeCount === 0,
  J_noNotice: r.nonArmor?.noticePresent === false,
  J_emptyWrapRowStillListed: (r.nonArmor?.rowNames || []).includes("__PW__Empty Wrap"),
  J_emptyWrapUnmarked: !(r.nonArmor?.markedRowNames || []).includes("__PW__Empty Wrap"),

  // ── (K) THE SHOP HANDOFF — the receipt carries the equip line, and only for armor ──
  K_sourceResolved: r.shop?.sourceResolved === true,
  K_purchaseSucceeded: r.shop?.bought === true,
  K_arrivesUnworn: r.shop?.arrivesUnworn === true,
  K_oneCard: r.shop?.cardCount === 1,
  K_cardCarriesEquipLine: /Delivered unworn/.test(r.shop?.cardText || ""),
  K_weaponCardHasNoEquipLine: r.shopNegative?.cardCount === 1
    && !/Delivered unworn/.test(r.shopNegative?.cardText || ""),

  // hygiene: the wrap never threw (would surface a sealed-model / bad-assign problem), no console errors
  wrapNeverThrew: !warns.some(w => /typed armor display failed/.test(w)),
  noConsoleErrors: errors.length === 0,
};
console.log(JSON.stringify({ r, checks, errors, warns: warns.slice(0, 6) }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? "CONDITIONAL-ARMOR-DISPLAY KEEPER PASS" : "CONDITIONAL-ARMOR-DISPLAY KEEPER FAIL");
await b.close();
process.exit(pass ? 0 : 1);
