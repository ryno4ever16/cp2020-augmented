/** BOOK-LEGALITY ENFORCEMENT — the armor layer law and the boost family limit, with teeth in the math.
 *
 *  What this keeper proves, all by VALUE on the ship-target rig (:30004, vanilla 1.1.1 + module):
 *    • the per-location fold admits only a book-legal subset (max 3 counted layers, max 1 hard,
 *      skinweave free) — surplus pieces contribute NOTHING, and the sheet panel equals the fold;
 *    • the layer surcharge (2nd counted layer −1 EV, 3rd −2 more) lands in the derived encumbrance
 *      figure the REF total already rides on;
 *    • a second boosterware contributes nothing to the initiative implant figure;
 *    • the read-time hardness corrections make the six mis-typed base pack entries read HARD, and
 *      agree with the generator's own book table across EVERY base armor-bearing entry (drift guard);
 *    • each warning key fires exactly ONCE on the equip that creates the violation, and the equip is
 *      never refused.
 *  Fixture values are the real pack numbers, so the expected folds are the book's own arithmetic. */
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
  const out = {};
  const AL = await import("/modules/cp2020-augmented/module/combat/armor-layers.js");
  const BL = await import("/modules/cp2020-augmented/module/combat/book-legality.js");
  const DA = await import("/modules/cp2020-augmented/module/combat/DamageApplicator.js");
  const GEN = await import("/modules/cp2020-augmented/module/npcgen/armor.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  // Real base-pack entries, by id (never by name).
  const P = {
    metalGear:   ["cyberpunk2020.armor", "q0Ay1r3Y4WLUjaT4"],
    flackVest:   ["cyberpunk2020.armor", "aiehEkbdjqqYZD9j"],
    flackPants:  ["cyberpunk2020.armor", "IBWsFBQDEZveDNJP"],
    kevlar:      ["cyberpunk2020.armor", "alaT1Zav1cW7j2PH"],
    heavyLeather:["cyberpunk2020.armor", "u5Nus9ejrk0KZbqR"],
    steelHelm:   ["cyberpunk2020.armor", "jK6hLgReS5Wsf2Hv"],
    nylonHelm:   ["cyberpunk2020.armor", "IU87ySLjve8eHgGf"],
    doorgunner:  ["cyberpunk2020.armor", "34GtfgYULaZEe3C7"],
    heavyJacket: ["cyberpunk2020.armor", "X0X3NTrChqfQ4wbO"],
    lightJacket: ["cyberpunk2020.armor", "x7WjXaNNtzSQJewW"],
    // A fully-typed garment: coverage 20 at the torso/arms, mechTypedSP { fire, 0 } — so its
    // CONVENTIONAL value is 0 and its coverage map is what a fire hit meets.
    salamander:  ["cp2020-augmented.supplement-armor", "6yIgR0Bxa4pdmGfc"],
    skinweave12: ["cyberpunk2020.bioware", "zlBiYh3NIlJ6QRcF"],
    cowl:        ["cyberpunk2020.other-cyberware", "nIxqf9f5cA5j7L1E"],
    kerenzikov1: ["cyberpunk2020.neuralware", "wjnYaHhvxqvRoLs1"],
    kerenzikov2: ["cyberpunk2020.neuralware", "8ak5IXMChXXqb4gh"],
    cyberarm:    ["cyberpunk2020.cyberlimbs", "aeiFWzAH0ZSYOjyy"],
    armorCover:  ["cyberpunk2020.cyberlimbs", "pFg0dfizfmbTc5IZ"],
    realSkinn:   ["cyberpunk2020.cyberlimbs", "IWdRPZeizxA6tQVx"],
  };
  const packData = async (key, { equipped = true } = {}) => {
    const [packId, id] = P[key];
    const doc = await game.packs.get(packId).getDocument(id);
    const data = game.items.fromCompendium(doc);
    data.system = data.system ?? {};
    data.system.equipped = equipped;
    return data;
  };

  await Promise.all(game.actors.filter(a => a.name.startsWith("__PW__Legality")).map(a => a.delete().catch(() => {})));

  const mk = async (name, keys, { ref = 8 } = {}) => {
    const a = await Actor.create({ name, type: "character", system: { stats: { ref: { base: ref } } } });
    // One create per entry: batch creates do not guarantee return/collection order, and the boost
    // family limit's "first installed wins" verdict has to be unambiguous in the fixture.
    for (const k of keys) await a.createEmbeddedDocuments("Item", [await packData(k)]);
    a.reset();
    return a;
  };
  const live  = (a, loc) => Number(DA._deriveLiveSP(a, loc, "")) || 0;
  const panel = (a, loc) => Number(a.system?.hitLocations?.[loc]?.stoppingPower) || 0;
  const surplusAt = (a, loc) => (AL.getArmorContributors(a, loc).illegalLayers ?? []).map(i => i.name).sort();
  const countedAt = (a, loc) => AL.getArmorContributors(a, loc).countedLayers;

  // ── F1 · four layers at the torso, one of them a surplus hard piece ───────────────────────────
  // Torso inside-out = Skinweave 12 (free) · Kevlar 10 · Flack Vest 20 (hard) · Metal Gear 25 (hard).
  // Legal fold [12,10,20] = 27; the type-blind four-layer fold would be 33.
  const f1 = await mk("__PW__Legality Four", ["metalGear", "flackVest", "kevlar", "skinweave12"]);
  out.f1 = {
    torsoLive: live(f1, "Torso"), torsoPanel: panel(f1, "Torso"),
    headLive: live(f1, "Head"), headPanel: panel(f1, "Head"),
    torsoSurplus: surplusAt(f1, "Torso"), torsoCounted: countedAt(f1, "Torso"),
    headCounted: countedAt(f1, "Head"),
    refArmorMod: Number(f1.system.stats.ref.armorMod),
    refTotal: Number(f1.system.stats.ref.total),
    layerEv: BL.actorLayerEv(f1).ev,
  };

  // ── F2 · three COUNTED layers → the full −1/−2 surcharge ──────────────────────────────────────
  const f2 = await mk("__PW__Legality Three", ["metalGear", "flackVest", "kevlar", "heavyLeather", "skinweave12"]);
  out.f2 = {
    torsoLive: live(f2, "Torso"), torsoPanel: panel(f2, "Torso"),
    torsoCounted: countedAt(f2, "Torso"), torsoSurplus: surplusAt(f2, "Torso"),
    refArmorMod: Number(f2.system.stats.ref.armorMod),
    layerEv: BL.actorLayerEv(f2).ev,
  };

  // ── F3 · two rigid head pieces — the second one earns nothing ─────────────────────────────────
  const f3 = await mk("__PW__Legality Head", ["steelHelm", "nylonHelm"]);
  out.f3 = {
    headLive: live(f3, "Head"), headPanel: panel(f3, "Head"),
    headSurplus: surplusAt(f3, "Head"), headCounted: countedAt(f3, "Head"),
  };

  // ── F4 · boost family limit ───────────────────────────────────────────────────────────────────
  const f4 = await mk("__PW__Legality Boost", ["kerenzikov1", "kerenzikov2"]);
  const f4solo = await mk("__PW__Legality BoostSolo", ["kerenzikov2"]);
  out.f4 = {
    pair: Number(f4.system.initiativeImplantMod),
    solo: Number(f4solo.system.initiativeImplantMod),
    activeName: BL.boosterwareLayers(f4).active?.name ?? "",
    surplusNames: BL.boosterwareLayers(f4).surplus.map(i => i.name),
    soloSurplus: BL.boosterwareLayers(f4solo).surplus.length,
  };

  // ── F5 · nothing over-layered → byte-for-byte the base answer ─────────────────────────────────
  const f5 = await mk("__PW__Legality Single", ["kevlar"]);
  out.f5 = {
    torsoLive: live(f5, "Torso"), torsoPanel: panel(f5, "Torso"),
    torsoCounted: countedAt(f5, "Torso"), torsoSurplus: surplusAt(f5, "Torso"),
    refArmorMod: Number(f5.system.stats.ref.armorMod), layerEv: BL.actorLayerEv(f5).ev,
  };

  // ── F6 · read-time hardness corrections + drift guard against the generator's book table ──────
  const hardnessOf = async (key) => {
    const [packId, id] = P[key];
    const doc = await game.packs.get(packId).getDocument(id);
    const [it] = await Item.createDocuments([game.items.fromCompendium(doc)]);
    const h = AL.getArmorHardness(it);
    await it.delete().catch(() => {});
    return h;
  };
  out.f6 = {
    flackVest:   await hardnessOf("flackVest"),
    flackPants:  await hardnessOf("flackPants"),
    nylonHelm:   await hardnessOf("nylonHelm"),
    steelHelm:   await hardnessOf("steelHelm"),
    doorgunner:  await hardnessOf("doorgunner"),
    cowl:        await hardnessOf("cowl"),
    // controls: entries the book calls soft, and the one the heuristic already got right
    kevlar:      await hardnessOf("kevlar"),
    heavyJacket: await hardnessOf("heavyJacket"),
    metalGear:   await hardnessOf("metalGear"),
  };
  // Closed drift check across EVERY base armor-bearing entry the book's table speaks about.
  const drift = [];
  for (const packId of ["cyberpunk2020.armor", "cyberpunk2020.bioware", "cyberpunk2020.implants",
                        "cyberpunk2020.other-cyberware", "cyberpunk2020.cyberlimbs"]) {
    const pack = game.packs.get(packId);
    if (!pack) continue;
    for (const idx of await pack.getIndex()) {
      const doc = await pack.getDocument(idx._id);
      const types = doc.system?.CyberWorkType?.Types ?? [];
      const bears = doc.type === "armor" || (doc.type === "cyberware" && Array.isArray(types) && types.includes("Armor"));
      if (!bears) continue;
      const book = GEN.bookHardness(doc.name);
      if (!book) continue;
      const [it] = await Item.createDocuments([game.items.fromCompendium(doc)]);
      const got = AL.getArmorHardness(it);
      await it.delete().catch(() => {});
      if (got !== book) drift.push(`${doc.name}: fold=${got} book=${book}`);
    }
  }
  out.drift = drift;

  // ── F8 · a layer worth 0 conventionally spends no slot, so it evicts nothing ───────────────────
  // Torso inside-out = Kevlar 10 · Light Armor Jacket 14 · Metal Gear 25 (hard) · Salamander Jacket
  // (coverage 20, typed fire, conventional value 0). The legality walk must value the entries the way
  // the fold values them, so the typed piece takes the free-layer branch and the three conventional
  // pieces stay counted: fold [10,14,25] = 30. Valuing it by RAW coverage instead spends the third
  // slot on it and ejects Metal Gear, dropping the wearer to fold [10,14] = 19.
  const f8base = await mk("__PW__Legality TypedBase", ["kevlar", "lightJacket", "metalGear"]);
  const f8 = await mk("__PW__Legality Typed", ["kevlar", "lightJacket", "metalGear", "salamander"]);
  out.f8 = {
    baseLive: live(f8base, "Torso"), baseCounted: countedAt(f8base, "Torso"),
    baseSurplus: surplusAt(f8base, "Torso"),
    torsoLive: live(f8, "Torso"), torsoPanel: panel(f8, "Torso"),
    torsoSurplus: surplusAt(f8, "Torso"), torsoCounted: countedAt(f8, "Torso"),
    torsoFire: Number(DA._deriveLiveSP(f8, "Torso", "fire")) || 0,
    refArmorMod: Number(f8.system.stats.ref.armorMod),
    // The derived conditional map the armor sub-panel renders from.
    condTypes: Object.keys(f8.system?.conditionalSP ?? {}).sort(),
    condFireLocs: Object.keys(f8.system?.conditionalSP?.fire ?? {}).sort(),
    condFireTorso: Number(f8.system?.conditionalSP?.fire?.Torso) || 0,
  };

  // ── F9 · the same free layer charges no encumbrance ───────────────────────────────────────────
  // Kevlar (EV 0) + the typed garment (EV 0). One counted layer ⇒ no layer surcharge, so the derived
  // encumbrance figure and the REF total are exactly the single-layer wearer's.
  const f9 = await mk("__PW__Legality TypedEv", ["kevlar", "salamander"]);
  out.f9 = {
    torsoLive: live(f9, "Torso"), torsoFire: Number(DA._deriveLiveSP(f9, "Torso", "fire")) || 0,
    torsoCounted: countedAt(f9, "Torso"), torsoSurplus: surplusAt(f9, "Torso"),
    layerEv: BL.actorLayerEv(f9).ev,
    refArmorMod: Number(f9.system.stats.ref.armorMod),
    refTotal: Number(f9.system.stats.ref.total),
  };

  // ── F7 · warnings — the real equip action, recorded once, never refused ───────────────────────
  const origWarn = ui.notifications.warn.bind(ui.notifications);
  let recorded = [];
  ui.notifications.warn = (msg, ...rest) => { recorded.push(String(msg)); return origWarn(msg, ...rest); };
  const equipAndCatch = async (actor, key, { parentId = "" } = {}) => {
    recorded = [];
    const data = await packData(key, { equipped: false });
    if (parentId) { data.system.Module = { ...(data.system.Module ?? {}), IsModule: true, ParentId: parentId }; }
    const [it] = await actor.createEmbeddedDocuments("Item", [data]);
    await it.update({ "system.equipped": true });
    await sleep(400);
    return { messages: [...recorded], stillEquipped: it.system.equipped === true, item: it };
  };
  const keyed = (msgs, needle) => msgs.filter(m => m.includes(needle)).length;

  // (a) a fourth counted layer
  const w1 = await mk("__PW__Legality WarnLayers", ["kevlar", "heavyLeather", "flackVest"]);
  const r1 = await equipAndCatch(w1, "metalGear");
  out.warnMaxLayers = { count: keyed(r1.messages, "Maximum Armor"), equipped: r1.stillEquipped, all: r1.messages };

  // (b) a second rigid head piece
  const w2 = await mk("__PW__Legality WarnHead", ["steelHelm"]);
  const r2 = await equipAndCatch(w2, "nylonHelm");
  out.warnHead = { count: keyed(r2.messages, "head armor"), equipped: r2.stillEquipped, all: r2.messages };

  // (c) a second hard layer away from the head
  const w3 = await mk("__PW__Legality WarnHard", ["flackVest"]);
  const r3 = await equipAndCatch(w3, "doorgunner");
  out.warnHard = { count: keyed(r3.messages, "one hard layer"), equipped: r3.stillEquipped, all: r3.messages };

  // (d) a second boosterware
  const w4 = await mk("__PW__Legality WarnBoost", ["kerenzikov1"]);
  const r4 = await equipAndCatch(w4, "kerenzikov2");
  out.warnBoost = { count: keyed(r4.messages, "boosterware"), equipped: r4.stillEquipped, all: r4.messages };

  // (e) a second covering on the same limb
  const w5 = await mk("__PW__Legality WarnCover", ["cyberarm"]);
  const arm = w5.items.find(i => i.name.includes("Cyberarm"));
  await equipAndCatch(w5, "armorCover", { parentId: arm.id });
  const r5 = await equipAndCatch(w5, "realSkinn", { parentId: arm.id });
  out.warnCovering = { count: keyed(r5.messages, "covering"), equipped: r5.stillEquipped, all: r5.messages };

  // (f) NEGATIVE — a legal second layer says nothing at all
  const w6 = await mk("__PW__Legality WarnNone", ["kevlar"]);
  const r6 = await equipAndCatch(w6, "heavyLeather");
  out.warnNone = { count: r6.messages.length, equipped: r6.stillEquipped, all: r6.messages };

  ui.notifications.warn = origWarn;

  await Promise.all(game.actors.filter(a => a.name.startsWith("__PW__Legality")).map(a => a.delete().catch(() => {})));
  return out;
});

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — got ${JSON.stringify(got)}${ok ? "" : `, want ${JSON.stringify(want)}`}`);
};

console.log("── F1 · four layers, surplus excluded ──");
eq("torso fold admits the legal three only", r.f1.torsoLive, 27);
eq("torso panel equals the fold", r.f1.torsoPanel, 27);
eq("head fold unchanged (one counted piece)", r.f1.headLive, 28);
eq("head panel equals the fold", r.f1.headPanel, 28);
eq("torso surplus names the excluded piece", r.f1.torsoSurplus, ["Metal Gear"]);
eq("torso counted layers", r.f1.torsoCounted, 2);
eq("head counted layers (weave is free)", r.f1.headCounted, 1);
eq("layer surcharge at two counted layers", r.f1.layerEv, 1);
eq("derived encumbrance figure carries it", r.f1.refArmorMod, -4);
eq("REF total rides the same figure", r.f1.refTotal, 4);

console.log("── F2 · three counted layers ──");
eq("torso fold", r.f2.torsoLive, 28);
eq("torso panel equals the fold", r.f2.torsoPanel, 28);
eq("torso counted layers", r.f2.torsoCounted, 3);
eq("torso surplus", r.f2.torsoSurplus, ["Metal Gear"]);
eq("layer surcharge at three counted layers", r.f2.layerEv, 3);
eq("derived encumbrance figure", r.f2.refArmorMod, -6);

console.log("── F3 · two rigid head pieces ──");
eq("head fold keeps only the first rigid piece", r.f3.headLive, 14);
eq("head panel equals the fold", r.f3.headPanel, 14);
eq("head surplus", r.f3.headSurplus, ["Nylon Helmet"]);
eq("head counted layers", r.f3.headCounted, 1);

console.log("── F4 · boost family limit ──");
eq("paired boosts contribute the first only", r.f4.pair, 1);
eq("a single boost is untouched", r.f4.solo, 2);
eq("the retained entry is the earlier one", r.f4.activeName, "Kerenzikov Boosterware I");
eq("the later entry is recorded as surplus", r.f4.surplusNames, ["Kerenzikov Boosterware II"]);
eq("a single boost has no surplus", r.f4.soloSurplus, 0);

console.log("── F5 · nothing over-layered ──");
eq("single layer fold", r.f5.torsoLive, 10);
eq("single layer panel", r.f5.torsoPanel, 10);
eq("single layer counted", r.f5.torsoCounted, 1);
eq("single layer surplus", r.f5.torsoSurplus, []);
eq("no surcharge at one counted layer", r.f5.layerEv, 0);
eq("encumbrance figure untouched", r.f5.refArmorMod, 0);

console.log("── F6 · read-time hardness corrections ──");
eq("Flack Vest", r.f6.flackVest, "hard");
eq("Flack Pants", r.f6.flackPants, "hard");
eq("Nylon Helmet", r.f6.nylonHelm, "hard");
eq("Steel Helmet", r.f6.steelHelm, "hard");
eq("Doorgunner's Vest", r.f6.doorgunner, "hard");
eq("Cowl", r.f6.cowl, "hard");
eq("control · Kevlar stays soft", r.f6.kevlar, "soft");
eq("control · Heavy Armor Jacket stays soft", r.f6.heavyJacket, "soft");
eq("control · Metal Gear already hard", r.f6.metalGear, "hard");
eq("no hardness drift vs the generator's book table", r.drift, []);

console.log("── F8 · a zero-value layer spends no slot ──");
eq("control · the three conventional pieces fold", r.f8.baseLive, 30);
eq("control · three counted, nothing surplus", [r.f8.baseCounted, r.f8.baseSurplus], [3, []]);
eq("the typed piece evicts nothing", r.f8.torsoSurplus, []);
eq("counted layers unchanged by the typed piece", r.f8.torsoCounted, 3);
eq("conventional torso fold unchanged", r.f8.torsoLive, 30);
eq("torso panel equals the fold", r.f8.torsoPanel, 30);
eq("the typed piece still folds against its own type", r.f8.torsoFire, 33);
eq("derived encumbrance figure (EV 2 + three-layer surcharge)", r.f8.refArmorMod, -5);
eq("conditional map publishes the typed row", r.f8.condTypes, ["fire"]);
eq("conditional map covers the garment's locations", r.f8.condFireLocs, ["Torso", "lArm", "rArm"]);
eq("conditional torso value equals the typed fold", r.f8.condFireTorso, 33);

console.log("── F9 · a zero-value layer charges no encumbrance ──");
eq("conventional fold is the single conventional piece", r.f9.torsoLive, 10);
eq("typed fold combines both", r.f9.torsoFire, 23);
eq("counted layers", r.f9.torsoCounted, 1);
eq("nothing surplus", r.f9.torsoSurplus, []);
eq("no layer surcharge", r.f9.layerEv, 0);
eq("derived encumbrance figure untouched", r.f9.refArmorMod, 0);
eq("REF total untouched", r.f9.refTotal, 8);

console.log("── F7 · equip-time notices ──");
eq("layer-cap notice fires once", r.warnMaxLayers.count, 1);
eq("layer-cap equip is not refused", r.warnMaxLayers.equipped, true);
eq("head-piece notice fires once", r.warnHead.count, 1);
eq("head-piece equip is not refused", r.warnHead.equipped, true);
eq("hard-layer notice fires once", r.warnHard.count, 1);
eq("hard-layer equip is not refused", r.warnHard.equipped, true);
eq("boost-family notice fires once", r.warnBoost.count, 1);
eq("boost-family equip is not refused", r.warnBoost.equipped, true);
eq("covering notice fires once", r.warnCovering.count, 1);
eq("covering equip is not refused", r.warnCovering.equipped, true);
eq("a legal addition says nothing", r.warnNone.count, 0);

eq("0 console errors", errors, []);
await b.close();
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
