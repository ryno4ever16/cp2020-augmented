/**
 * SERVICES ARE DECLARED, NEVER INFERRED (user ruling 2026-09-27). Before this date `classifyService`
 * substring-matched item names against ~100 words, so a homebrew "Headphones" filed itself on the
 * Services tab and a Gun Cleaning Kit bought from the shop was paid for with no item created. Legs:
 *   A. a homebrew misc item whose NAME carries the old trigger words is GEAR: classified gear, on the
 *      Gear tab, absent from the Services tab (the report's own examples: headphones, an inert phone)
 *   B. a base GEAR-pack row whose name carries a trigger word ("Cellular Phone", "Cab Hailer") is gear,
 *      and buying it CREATES the item (the one-off "paid, nothing received" path is gone for gear)
 *   C. the base Rentals & Services pack is declared row by row: "Cell Phone Service" recurring, "Taxi"
 *      one-off — read off the compendium document; the table covers every installed row
 *   D. an embedded copy of a Rentals row with NO flag still classifies by its compendiumSource stamp
 *      (drag-in and purchase both stamp it), so the Services tab keeps it
 *   E. the GM's own flag wins over everything: a "Headphones" flagged recurring is a service, a Rentals
 *      housing row flagged gear is gear
 *   F. the Services tab's "+" button still declares (stamps recurring)
 *   G. our supplement-gear sources carry their declaration: taxi fare one-off, the Lazarus monthly
 *      contract recurring, Gun Cleaning Kit gear, the magazine recurring per year — off the compiled pack
 * Wording rule: legs are named after the mechanism (classification, tab membership, the stamp).
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p) {
  await p.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const s = p.locator('select[name="userid"]'); await s.waitFor({ state: "visible", timeout: 30000 });
  const us = await s.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  await s.selectOption(us.find(u => /^gamemaster$/i.test(u.l)).v);
  await p.locator('input[name="password"]').fill(PW);
  await Promise.all([p.waitForNavigation({ url: /\/game/, timeout: 45000 }).catch(() => {}), p.locator('button[name="join"]').click()]);
  await p.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60000 });
}

const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const errors = []; p.on("pageerror", e => errors.push(String(e))); p.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = { errs: [] };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const svc = await import("/modules/cp2020-augmented/module/shop/services.js");
  const purchase = await import("/modules/cp2020-augmented/module/shop/purchase.js");
  const DC = await import("/modules/cp2020-augmented/module/data-corrections.js");
  const SCOPE = "cp2020-augmented";
  const FIX = ["__PW__SVC Headphones", "__PW__SVC Cell Phone (inert)", "__PW__SVC Power Cable"];
  for (const a of game.actors.filter(a => a.name?.startsWith("__PW__SVC"))) await a.delete().catch(() => {});
  // shopping is always on since the settings trim (shoppingEnabled() returns true; no switch to flip)
  try {
    const actor = await Actor.create({ name: "__PW__SVC Buyer", type: "character", system: { eurobucks: 100000 } });
    const byName = (n) => actor.items.find(i => i.name === n);

    /* A - homebrew names that used to trigger */
    await actor.createEmbeddedDocuments("Item", [
      { name: FIX[0], type: "misc", system: { cost: 40 } },
      { name: FIX[1], type: "misc", system: { cost: 100 } },
      { name: FIX[2], type: "misc", system: { cost: 5 } },
    ]);
    out.a = FIX.map(n => ({ n, cls: svc.classifyService(byName(n)), flag: svc.serviceModeOf(byName(n)) }));

    /* the sheet: Services tab membership vs the rendered item rows */
    const sheetLists = async () => {
      await actor.sheet.render(true); await sleep(900);
      const el = actor.sheet.element;
      const services = [...el.querySelectorAll(".cp-service-row .cp-service-name")].map(x => x.textContent.trim());
      const renderedIds = new Set([...el.querySelectorAll("[data-item-id]")].map(x => x.dataset.itemId));
      await actor.sheet.close().catch(() => {});
      return { services, renderedIds };
    };
    let lists = await sheetLists();
    out.aSheet = { headphonesOnServices: lists.services.includes(FIX[0]), phoneOnServices: lists.services.includes(FIX[1]), headphonesRendered: lists.renderedIds.has(byName(FIX[0]).id) };

    /* B - base gear rows with trigger words: classified gear, and a buy CREATES the item */
    const comm = game.packs.get("cyberpunk2020.communication"), elec = game.packs.get("cyberpunk2020.electronics");
    const cellIdx = (await comm.getIndex()).find(e => e.name === "Cellular Phone"), cabIdx = (await elec.getIndex()).find(e => e.name === "Cab Hailer");
    const cellDoc = cellIdx ? await comm.getDocument(cellIdx._id) : null, cabDoc = cabIdx ? await elec.getDocument(cabIdx._id) : null;
    out.b = { cellularPhone: cellDoc ? svc.classifyService(cellDoc, "communication") : "missing", cabHailer: cabDoc ? svc.classifyService(cabDoc, "electronics") : "missing" };
    const before = actor.items.size, fundsBefore = actor.system.eurobucks;
    if (cabDoc) await purchase.buyItem(actor, cabDoc, { qty: 1, unitPrice: 50 });
    await sleep(400);
    out.bBuy = { itemsAdded: actor.items.size - before, gotCabHailer: !!byName("Cab Hailer"), charged: fundsBefore - actor.system.eurobucks };

    /* C - the Rentals pack, row by row, off the compendium document */
    const rent = game.packs.get("cyberpunk2020.rentalandservices");
    const idx = await rent.getIndex();
    const rentDoc = async (n) => { const e = idx.find(x => x.name === n); return e ? rent.getDocument(e._id) : null; };
    const cps = await rentDoc("Cell Phone Service"), taxi = await rentDoc("Taxi"), house = await rentDoc("House – Moderate Zone"), kibble = await rentDoc("Kibble");
    out.c = { cellPhoneService: cps && svc.classifyService(cps), taxi: taxi && svc.classifyService(taxi), house: house && svc.classifyService(house), kibble: kibble && svc.classifyService(kibble), rowOf: cps && DC.parseCompendiumSource(cps.uuid) };
    out.cTableCoversPack = idx.filter(e => !["recurring", "oneoff"].includes(DC.correctionFor("cyberpunk2020.rentalandservices", e._id)?.serviceMode)).map(e => e.name);

    /* D - an embedded copy with NO flag classifies by its compendiumSource */
    const [copy] = await actor.createEmbeddedDocuments("Item", [game.items.fromCompendium(cps)]);
    out.d = { flag: svc.serviceModeOf(copy), source: String(copy._stats?.compendiumSource ?? ""), cls: svc.classifyService(copy), stamped: DC.isCorrectionApplied(copy) };
    lists = await sheetLists();
    out.dSheet = { onServices: lists.services.includes("Cell Phone Service") };

    /* E - the GM's own flag wins both ways */
    await byName(FIX[0]).update({ [`flags.${SCOPE}.serviceMode`]: "recurring" });
    const [houseCopy] = await actor.createEmbeddedDocuments("Item", [{ ...game.items.fromCompendium(house), flags: { [SCOPE]: { serviceMode: "gear" } } }]);
    out.e = { headphonesFlagged: svc.classifyService(byName(FIX[0])), houseFlaggedGear: svc.classifyService(houseCopy), houseSource: String(houseCopy._stats?.compendiumSource ?? "") };
    lists = await sheetLists();
    out.eSheet = { headphonesOnServices: lists.services.includes(FIX[0]), houseOnServices: lists.services.includes("House – Moderate Zone") };

    /* F - the "+" button declares */
    await actor.sheet.render(true); await sleep(900);
    const known = new Set([...actor.items].map(i => i.id));
    actor.sheet.element.querySelector(".cp-service-add")?.click();
    for (let i = 0; i < 30 && actor.items.size === known.size; i++) await sleep(100);
    const added = [...actor.items].find(i => !known.has(i.id));
    for (const app of Object.values(ui.windows)) if (app.object?.parent?.id === actor.id) await app.close().catch(() => {});
    for (const app of foundry.applications.instances.values()) if (app.document?.parent?.id === actor.id) await app.close().catch(() => {});
    await actor.sheet.close().catch(() => {});
    out.f = { added: !!added, flag: added ? svc.serviceModeOf(added) : null, cls: added ? svc.classifyService(added) : null };

    /* G - our own pack sources carry their declaration */
    const sup = game.packs.get("cp2020-augmented.supplement-gear");
    const sidx = await sup.getIndex();
    const supDoc = async (n) => { const e = sidx.find(x => x.name === n); return e ? sup.getDocument(e._id) : null; };
    const fare = await supDoc("Ground taxi fare (per mile)"), laz = await supDoc("Lazarus Group Mercenary Soldier/Agent (monthly contract)"), kit = await supDoc("Gun Cleaning Kit"), mag = await supDoc('"C" Magazine (Corporate Executive Magazine) Subscription');
    out.g = { fare: fare && svc.classifyService(fare), lazarus: laz && svc.classifyService(laz), gunCleaningKit: kit && svc.classifyService(kit), magazine: mag && { cls: svc.classifyService(mag), period: svc.servicePeriodOf(mag) } };

    await actor.delete().catch(() => {});
  } catch (e) { out.errs.push(String(e?.stack ?? e)); }
  finally {
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__SVC"))) await a.delete().catch(() => {});
  }
  return out;
});

const legs = [];
const ok = (name, cond, got) => legs.push([name, !!cond, got]);
ok("A classification: a homebrew 'Headphones' is gear, not a service", r.a?.[0]?.cls === "gear" && r.a?.[0]?.flag === "", JSON.stringify(r.a?.[0]));
ok("A classification: an inert homebrew 'Cell Phone' is gear", r.a?.[1]?.cls === "gear", JSON.stringify(r.a?.[1]));
ok("A classification: a 'Power Cable' is gear (the old recurring words are dead)", r.a?.[2]?.cls === "gear", JSON.stringify(r.a?.[2]));
ok("A tab membership: neither homebrew item is on the Services tab, and the headphones render on the sheet", r.aSheet?.headphonesOnServices === false && r.aSheet?.phoneOnServices === false && r.aSheet?.headphonesRendered === true, JSON.stringify(r.aSheet));
ok("B classification: base 'Cellular Phone' and 'Cab Hailer' rows are gear", r.b?.cellularPhone === "gear" && r.b?.cabHailer === "gear", JSON.stringify(r.b));
ok("B purchase: buying the Cab Hailer CREATES the item and charges its price", r.bBuy?.itemsAdded === 1 && r.bBuy?.gotCabHailer === true && r.bBuy?.charged === 50, JSON.stringify(r.bBuy));
ok("C Rentals rows by declaration: Cell Phone Service recurring / Taxi one-off / House recurring / Kibble recurring", r.c?.cellPhoneService === "recurring" && r.c?.taxi === "oneoff" && r.c?.house === "recurring" && r.c?.kibble === "recurring", JSON.stringify(r.c));
ok("C the origin parser reads the pack and id off the compendium document", r.c?.rowOf?.packId === "cyberpunk2020.rentalandservices" && typeof r.c?.rowOf?.itemId === "string", JSON.stringify(r.c?.rowOf));
ok("C the corrections registry declares every row of the installed Rentals pack (none fall to the one-off default)", Array.isArray(r.cTableCoversPack) && r.cTableCoversPack.length === 0, JSON.stringify(r.cTableCoversPack));
ok("D an embedded Rentals copy with NO flag classifies recurring by its compendiumSource stamp", r.d?.flag === "" && /rentalandservices/.test(r.d?.source ?? "") && r.d?.cls === "recurring", JSON.stringify(r.d));
ok("D tab membership: that copy sits on the Services tab", r.dSheet?.onServices === true, JSON.stringify(r.dSheet));
ok("D read-time only: a copy whose entry carries just the service class is NOT stamped as corrected (nothing was written)", r.d?.stamped === false, JSON.stringify(r.d));
ok("E the GM's flag wins: flagged 'Headphones' is recurring; a housing row flagged gear is gear", r.e?.headphonesFlagged === "recurring" && r.e?.houseFlaggedGear === "gear" && /rentalandservices/.test(r.e?.houseSource ?? ""), JSON.stringify(r.e));
ok("E tab membership follows the flag both ways", r.eSheet?.headphonesOnServices === true && r.eSheet?.houseOnServices === false, JSON.stringify(r.eSheet));
ok("F the Services tab's + button declares the new item recurring", r.f?.added === true && r.f?.flag === "recurring" && r.f?.cls === "recurring", JSON.stringify(r.f));
ok("G our supplement-gear sources declare: taxi fare one-off / Lazarus contract recurring / Gun Cleaning Kit gear / magazine recurring per year", r.g?.fare === "oneoff" && r.g?.lazarus === "recurring" && r.g?.gunCleaningKit === "gear" && r.g?.magazine?.cls === "recurring" && r.g?.magazine?.period === "year", JSON.stringify(r.g));
ok("harness: the run threw nothing", (r.errs ?? []).length === 0, JSON.stringify(r.errs));
ok("0 console errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
let fail = 0;
for (const [n, pass, got] of legs) { if (!pass) fail++; console.log(`${pass ? "PASS" : "FAIL"}  ${n}${pass ? "" : `   [got: ${got}]`}`); }
console.log(`\n${legs.length - fail}/${legs.length} checks passed`);
await b.close();
process.exit(fail ? 1 : 0);
