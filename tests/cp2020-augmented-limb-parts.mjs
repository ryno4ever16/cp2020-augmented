/** Limb-parts keeper — the cyberleg's basic foot module (user ruling 2026-09-15; Core p.89 + p.90):
 *  the FIRST foot installed in a leg host takes the slot the leg already spent on its basic foot (no
 *  additional slot); a second foot, a foot in an arm, and every hand pay their printed footprint. The
 *  sheet SHOWS the trade: a leg's badge reads capacity + 1 with a greyed "Basic foot module (included)"
 *  row until a bought foot replaces it, so the arithmetic reads like an arm's.
 *  - Pure: limbPartOf / isLegHost / waivedChild / usedSlots / freeSlots / limbSlotView / checkInstall on
 *    REAL base-pack documents (cyberpunk2020.cyberlimbs: Standard Cyberleg 3, Standard Cyberarm 4,
 *    Standard Foot 1, Standard Hand 1) imported onto a fixture actor.
 *  - Live DOM: the l-leg zone badge and the basic-foot row before/after the foot goes in; the foot row's
 *    note says it replaced the basic foot; the hand row's note says it took a slot.
 *  Runs on :30004 (official 1.1.1 + module). */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = {};
  const C = await import("/modules/cp2020-augmented/module/mech/container.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  for (const a of game.actors.filter(a => a.name?.startsWith("__PW__ limb"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__ limb parts", type: "character" });
  try {
    const pack = game.packs.get("cyberpunk2020.cyberlimbs");
    out.packFound = !!pack;
    const want = ["Standard Cyberleg", "Standard Cyberarm", "Standard Foot", "Standard Hand"];
    const docs = await pack.getDocuments({ name__in: want });
    const src = Object.fromEntries(docs.map(d => [d.name, d]));
    out.packDocs = want.map(n => !!src[n]);
    const mk = async (name, extra = {}) => {
      const data = src[name].toObject();
      data.name = `__PW__ ${name}`;
      data.system = foundry.utils.mergeObject(data.system, extra, { inplace: false });
      return (await actor.createEmbeddedDocuments("Item", [data]))[0];
    };
    const leg  = await mk("Standard Cyberleg", { equipped: true, CyberBodyType: { Location: "Left" } });
    const arm  = await mk("Standard Cyberarm", { equipped: true, CyberBodyType: { Location: "Left" } });
    const foot = await mk("Standard Foot",     { equipped: true, CyberBodyType: { Location: "Left" } });
    const foot2= await mk("Standard Foot",     { equipped: true, CyberBodyType: { Location: "Left" } });
    const hand = await mk("Standard Hand",     { equipped: true, CyberBodyType: { Location: "Left" } });
    const items = () => actor.items.contents;
    const L = () => actor.items.get(leg.id), A = () => actor.items.get(arm.id);

    // ── (0) pure recognition + the empty leg's view ──
    out.pure = {
      footPart: C.limbPartOf(foot), handPart: C.limbPartOf(hand), legPart: C.limbPartOf(leg),
      legHost: C.isLegHost(leg), armHost: C.isLegHost(arm), footHost: C.isLegHost(foot),
      legCap: C.capacityOf(leg), armCap: C.capacityOf(arm),
      legFreeEmpty: C.freeSlots(L(), items()),
      legViewEmpty: C.limbSlotView(L(), items()),        // {capacity 4, used 1, includedFoot true}
      armViewEmpty: C.limbSlotView(A(), items()),        // {capacity 4, used 0, includedFoot false}
    };

    // ── (1) sheet DOM before: leg badge 1/4 + the basic-foot row ──
    const sheet = actor.sheet; await sheet.render(true); await sleep(900);
    const root = () => sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
    const zone = (area) => root()?.querySelector(`section[data-drop-target="zone:${area}"]`);
    const badge = (area) => zone(area)?.querySelector("button .cp-capacity-badge")?.textContent?.trim() ?? null;
    out.domBefore = {
      legBadge: badge("l-leg"), armBadge: badge("l-arm"),
      basicRow: !!zone("l-leg")?.querySelector(".cp-basic-part"),
      basicRowText: zone("l-leg")?.querySelector(".cp-basic-part label")?.textContent?.trim() ?? null,
    };

    // ── (2) install the first foot: free slots unchanged, badge unchanged, row gone, note says replaced ──
    out.installFoot = await C.installItem(foot, L(), items());
    await sleep(900);
    out.afterFoot = {
      legFree: C.freeSlots(L(), items()),                  // 3
      legUsedRaw: C.usedSlots(items(), leg.id, L()),       // 0 (waived)
      legView: C.limbSlotView(L(), items()),               // {4, 1, includedFoot false}
      waived: C.waivedChild(L(), C.childrenOf(items(), leg.id))?.id === foot.id,
      legBadge: badge("l-leg"),
      basicRow: !!zone("l-leg")?.querySelector(".cp-basic-part"),
      footNote: zone("l-leg")?.querySelector(`[data-item-id="${foot.id}"] .cp-part-note`)?.getAttribute("title") ?? null,
    };

    // ── (3) a second foot pays its slot; a full leg still admits its first foot ──
    out.installFoot2 = await C.installItem(foot2, L(), items());
    out.afterFoot2 = { legFree: C.freeSlots(L(), items()), legView: C.limbSlotView(L(), items()) };   // 2, {4,2}
    await C.uninstallItem(actor.items.get(foot2.id)); await C.uninstallItem(actor.items.get(foot.id));
    // fill the leg with three non-foot options, then the foot must still fit (needed 0) and a hand must not
    const fillers = await actor.createEmbeddedDocuments("Item", [1, 2, 3].map(i => ({
      name: `__PW__ leg option ${i}`, type: "cyberware",
      system: { equipped: true, MountZone: "Leg", CyberBodyType: { Location: "Left" }, cyberwareType: "CyberLeg",
        CyberWorkType: { Types: [], Stat: {}, Skill: {}, ChipSkills: {} }, Module: { IsModule: true, ParentId: leg.id, SlotsTaken: 1, AllowedParentCyberwareType: "CyberLeg" } } })));
    out.fullLeg = {
      free: C.freeSlots(L(), items()),                                         // 0
      footFits: C.checkInstall(actor.items.get(foot.id), L(), items()),       // ok (needed 0)
      viewFull: C.limbSlotView(L(), items()),                                  // {4, 4, includedFoot true}
    };
    out.installFootIntoFull = await C.installItem(actor.items.get(foot.id), L(), items());
    out.fullLegWithFoot = {
      free: C.freeSlots(L(), items()),                                         // still 0
      secondFootFits: C.checkInstall(actor.items.get(foot2.id), L(), items()),  // full
      view: C.limbSlotView(L(), items()),                                      // {4, 4, includedFoot false}
    };
    await actor.deleteEmbeddedDocuments("Item", fillers.map(f => f.id));
    await C.uninstallItem(actor.items.get(foot.id));

    // ── (4) arm: the hand pays one of four; a foot in an arm pays too ──
    out.installHand = await C.installItem(hand, A(), items());
    await sleep(900);
    out.arm = {
      free: C.freeSlots(A(), items()),                     // 3
      view: C.limbSlotView(A(), items()),                  // {4, 1, includedFoot false}
      badge: badge("l-arm"),                                // "1/4"
      handNote: zone("l-arm")?.querySelector(`[data-item-id="${hand.id}"] .cp-part-note`)?.getAttribute("title") ?? null,
      basicRow: !!zone("l-arm")?.querySelector(".cp-basic-part"),
    };
    // a foot dropped into an arm is refused by the base nesting rule (parent type, then zone) — assert it, and that
    // even when forced by data it costs a slot (the waiver is leg-only)
    out.footIntoArm = C.checkInstall(actor.items.get(foot.id), A(), items());
    await actor.items.get(foot.id).update({ "system.Module.ParentId": arm.id });
    out.armWithForcedFoot = { free: C.freeSlots(A(), items()), view: C.limbSlotView(A(), items()) };   // 2, {4,2,false}
    await sheet.close();
  } finally {
    await actor.delete().catch(() => {});
  }
  return out;
});

const v = (o, c, u, f) => o && o.capacity === c && o.used === u && o.includedFoot === f;
const checks = {
  packAndDocs:        r.packFound === true && Array.isArray(r.packDocs) && r.packDocs.every(Boolean),
  pureParts:          r.pure?.footPart === "foot" && r.pure?.handPart === "hand" && r.pure?.legPart === "",
  pureHosts:          r.pure?.legHost === true && r.pure?.armHost === false && r.pure?.footHost === false,
  pureCaps:           r.pure?.legCap === 3 && r.pure?.armCap === 4,
  emptyLegFree:       r.pure?.legFreeEmpty === 3,
  emptyLegView:       v(r.pure?.legViewEmpty, 4, 1, true),
  emptyArmView:       v(r.pure?.armViewEmpty, 4, 0, false),
  domBeforeBadge:     r.domBefore?.legBadge === "1/4" && r.domBefore?.armBadge === "0/4",
  domBeforeBasicRow:  r.domBefore?.basicRow === true && /basic foot/i.test(r.domBefore?.basicRowText ?? ""),
  footInstalls:       r.installFoot === true,
  footFreeUnchanged:  r.afterFoot?.legFree === 3 && r.afterFoot?.legUsedRaw === 0,
  footView:           v(r.afterFoot?.legView, 4, 1, false) && r.afterFoot?.waived === true,
  domAfterFoot:       r.afterFoot?.legBadge === "1/4" && r.afterFoot?.basicRow === false,
  footNoteReplaces:   /replaces/i.test(r.afterFoot?.footNote ?? ""),
  secondFootPays:     r.installFoot2 === true && r.afterFoot2?.legFree === 2 && v(r.afterFoot2?.legView, 4, 2, false),
  fullLegAdmitsFoot:  r.fullLeg?.free === 0 && r.fullLeg?.footFits?.ok === true && v(r.fullLeg?.viewFull, 4, 4, true),
  fullLegFootIn:      r.installFootIntoFull === true && r.fullLegWithFoot?.free === 0 && v(r.fullLegWithFoot?.view, 4, 4, false),
  fullLegRefusesTwo:  r.fullLegWithFoot?.secondFootFits?.ok === false && r.fullLegWithFoot?.secondFootFits?.reason === "full",
  handPays:           r.installHand === true && r.arm?.free === 3 && v(r.arm?.view, 4, 1, false) && r.arm?.badge === "1/4",
  handNoteSlot:       /one option slot/i.test(r.arm?.handNote ?? "") && r.arm?.basicRow === false,
  // The base nesting rule refuses a foot in an arm on its parent TYPE (AllowedParentCyberwareType CyberLeg)
  // before the zone check ever runs; either refusal is the right answer.
  footIntoArmZone:    r.footIntoArm?.ok === false && ["wrong-type", "wrong-zone"].includes(r.footIntoArm?.reason),
  forcedFootArmPays:  r.armWithForcedFoot?.free === 2 && v(r.armWithForcedFoot?.view, 4, 2, false),
  noConsoleErrors:    errors.length === 0,
};
console.log(JSON.stringify({ r, checks, errors }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? "LIMB-PARTS KEEPER PASS" : "LIMB-PARTS KEEPER FAIL");
await b.close();
process.exit(pass ? 0 : 1);
