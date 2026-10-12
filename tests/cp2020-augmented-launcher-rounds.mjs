/**
 * KEEPER: launched grenade ROUNDS for the supplement launchers (:30004, official 1.1.1 + module).
 *
 *  §1 the pack census (node file reads): the 31 typed rounds in supplement-heavy, each with a caliber of
 *     one of the four launcher families, a formula or an effect word, a cost and its book; the two
 *     "Launched Grenades" placeholder weapons are gone; every launcher's ammo type resolves to a family.
 *  §2 the caliber rule by VALUE (lookups.js on the rig): the Militech Mini-GL takes a 25mm round and
 *     refuses a Tsunami high-pressure one; the Core Grenade Launcher takes a 40mm round and a 40mm
 *     launcher takes a Core round (Blackhand's prints the Core launcher as 30-40mm); the 30mm borg
 *     auto-GL takes 40mm rounds (SoF2: 30mm launchers count as 40mm) while the 30mm Wrist Rocket does
 *     not; rifle grenades load only into a rifle-grenade entry.
 *  §3 the shop index: the rounds are rows on the Ammo shelf with a source key; bullets are still the
 *     generated caliber rows only; the placeholders are not offered.
 *  §4 a purchase: 3 rounds land as ONE ammo stack of 3 with the quantity unlocked, charged at the book
 *     price; buying 2 more stacks onto the same item; a second kind is its own stack.
 *  §5 loading and firing: the weapon sheet's ammo list offers the right rounds and not the wrong ones;
 *     a loaded 25mm round supplies the formula the launcher's "Varies" cannot, the launcher detonates,
 *     counts as launched, and the blast radius is the round's own.
 *
 *  Run:  node tests/cp2020-augmented-launcher-rounds.mjs            (rig :30004)
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src", "packs", "supplement-heavy");

async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

let fail = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) fail++; };

const FAMILIES = ["25mm grenade", "25mm HP grenade", "40mm grenade", "rifle grenade"];
const ROUND_COUNT = 31;

// ── §1 pack census ─────────────────────────────────────────────────────────────────────────────
console.log("§1 pack census");
{
  const docs = fs.readdirSync(SRC).filter(f => f.endsWith(".json")).map(f => JSON.parse(fs.readFileSync(path.join(SRC, f), "utf8").replace(/^﻿/, "")));
  const rounds = docs.filter(d => d.type === "ammo" && FAMILIES.includes(d.system?.caliber));
  check(`§1 exactly ${ROUND_COUNT} typed launcher rounds in the pack`, rounds.length === ROUND_COUNT, `${rounds.length}`);
  const byFam = Object.fromEntries(FAMILIES.map(f => [f, rounds.filter(r => r.system.caliber === f).length]));
  check("§1 the four families are 10 / 4 / 13 / 4", JSON.stringify(byFam) === JSON.stringify({ "25mm grenade": 10, "25mm HP grenade": 4, "40mm grenade": 13, "rifle grenade": 4 }), JSON.stringify(byFam));
  const rollable = s => /^[0-9dD+\-*/().\s]+$/.test(s) && /\d/.test(s);
  const bad = rounds.filter(r => { const s = r.system; const words = Array.isArray(s.effectTypes) ? s.effectTypes : []; const hasWord = words.some(w => ["Gas", "Stun", "Blind", "Deaf"].includes(w)); return !(rollable(String(s.bonusDamageFormula || "")) || hasWord) || s.ammoType !== s.caliber || !(Number(s.cost) > 0) || !/p\.\d+/.test(String(s.source)) || !/THE BOOK/.test(String(s.notes)); }).map(r => r.name);
  check("§1 every round carries a formula or an effect word, caliber = ammoType, a price and a cited page", bad.length === 0, bad.join(", "));
  const placeholders = docs.filter(d => /Launched Grenades$/.test(d.name)).map(d => d.name);
  check("§1 the two 'Launched Grenades' placeholder weapons are gone", placeholders.length === 0, placeholders.join(", "));
  const adaptor = docs.find(d => d._id === "0aoNOy2BtMlEIVxW");
  check("§1 the pistol-grenade record is the 200eb adaptor chambered for 25mm, Grenade class", adaptor?.name === "Militech 25mm Pistol-Grenade Adaptor" && adaptor.system.cost === 200 && adaptor.system.ammoType === "25mm grenade" && adaptor.system.attackType === "Grenade", JSON.stringify([adaptor?.name, adaptor?.system?.cost, adaptor?.system?.ammoType, adaptor?.system?.attackType]));
  const tsunami = docs.find(d => d._id === "9QXE81s2UolBAW8u");
  check("§1 the Pocket Tsunami is chambered for the high-pressure family and its damage reads Varies", tsunami?.system?.ammoType === "25mm HP grenade" && /^Varies/.test(tsunami.system.damage) && tsunami.system.attackType === "Grenade", JSON.stringify([tsunami?.system?.ammoType, tsunami?.system?.damage]));
  const single = ["X14eZW3TZFV5i2PP", "XMcTvryaoyquq8VB", "HbW6JGUuSqDNVyOI", "dn1249EuFkSNDxSY", "wr4a6DWUNEulOOTy", "Pv7ZpdlxN2dR4iij", "e4ixi79YbsebZEP9", "TEQOlJgZKxp3G2vW"].map(id => docs.find(d => d._id === id)).map(d => `${d?.name}:${d?.system?.attackType}`);
  check("§1 the eight single-shot launchers carry the Grenade attack class", single.every(s => s.endsWith(":Grenade")), single.join(" | "));
}

// ── rig ──────────────────────────────────────────────────────────────────────────────────────
const errors = [];
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1700, height: 950 } });
p.on("pageerror", e => errors.push(String(e)));
p.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await joinGM(p);

try {
  // §2 caliber rule
  console.log("§2 the caliber rule");
  const cal = await p.evaluate(async () => {
    const L = await import("/modules/cp2020-augmented/module/lookups.js");
    const m = (w, a) => L.caliberMatches(w, a);
    return {
      miniGL25: m("25mm mini-grenade", "25mm grenade"), miniGLHP: m("25mm mini-grenade", "25mm HP grenade"),
      cowboy25: m("25mm grenades", "25mm grenade"), tsunamiHP: m("25mm HP grenade", "25mm HP grenade"), tsunami25: m("25mm HP grenade", "25mm grenade"),
      core40: m("Grenade", "40mm grenade"), fortyCore: m("40mm grenade", "Grenade"), coreCore: m("Grenade", "Grenade"), forty25: m("40mm grenade", "25mm grenade"),
      borg30: m("30mm caseless", "40mm grenade"), wrist30: m("30mm", "40mm grenade"), rifle: m("rifle grenade", "rifle grenade"), rifle40: m("rifle grenade", "40mm grenade"),
      nine: m("9mm", "40mm grenade"), bullets: m("9mm", "9mm"),
      norm: ["25mm grenades", "25mm mini-grenade", "40mm grenades", "30mm caseless", "30mm grenade", "Grenade"].map(x => L.normalizeCaliber(x)),
    };
  });
  check("§2 a 25mm round loads into the Mini-GL ('25mm mini-grenade') and the Cowboy ('25mm grenades'); a high-pressure one does not", cal.miniGL25 && cal.cowboy25 && !cal.miniGLHP, JSON.stringify(cal));
  check("§2 the Tsunami takes its own HP round and not the Militech 25mm", cal.tsunamiHP && !cal.tsunami25, JSON.stringify([cal.tsunamiHP, cal.tsunami25]));
  check("§2 the Core launcher takes 40mm rounds, a 40mm launcher takes Core rounds, Core still takes Core, 40mm refuses 25mm", cal.core40 && cal.fortyCore && cal.coreCore && !cal.forty25, JSON.stringify([cal.core40, cal.fortyCore, cal.coreCore, cal.forty25]));
  check("§2 the 30mm borg auto-GL takes 40mm rounds; the 30mm Wrist Rocket does not", cal.borg30 && !cal.wrist30, JSON.stringify([cal.borg30, cal.wrist30]));
  check("§2 rifle grenades load only into a rifle-grenade entry; bullets are untouched", cal.rifle && !cal.rifle40 && !cal.nine && cal.bullets, JSON.stringify([cal.rifle, cal.rifle40, cal.nine, cal.bullets]));
  check("§2 the launcher spellings normalise to their family", JSON.stringify(cal.norm) === JSON.stringify(["25mm grenade", "25mm grenade", "40mm grenade", "40mm grenade", "40mm grenade", "Grenade"]), JSON.stringify(cal.norm));

  // §3 shop index
  console.log("§3 the shop index");
  const idx = await p.evaluate(async () => {
    const cat = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    cat.clearCatalogIndexCache();
    const all = await cat.getCatalogIndex();
    const rounds = all.filter(i => i.type === "ammo" && i.packId === "cp2020-augmented.supplement-heavy");
    const frag = rounds.find(i => i.name === "25mm Fragmentation Grenade");
    return {
      count: rounds.length, cats: [...new Set(rounds.map(i => `${i.category}/${i.sub}`))], keyed: rounds.every(i => i.key && i.id),
      frag: frag ? { cost: frag.cost, unpriced: frag.unpriced, supplement: frag.supplement } : null,
      bulletDocs: all.filter(i => i.type === "ammo" && /^9mm|^5\.56|^12ga|^00/.test(String(i.name))).length,
      placeholders: all.filter(i => /Launched Grenades$/.test(i.name)).length,
      coreRounds: all.filter(i => i.type === "ammo" && /Grenade Round$/.test(i.name)).length,
    };
  });
  check("§3 the 31 typed rounds and the 6 Core rounds are index rows under Ammo, keyed", idx.count === 37 && idx.cats.join() === "Ammo/" && idx.keyed && idx.coreRounds === 6, JSON.stringify(idx));
  check("§3 a round is priced at its book cost and tagged with its book", idx.frag?.cost === 30 && idx.frag.unpriced === false && idx.frag.supplement !== "Untagged", JSON.stringify(idx.frag));
  check("§3 bullets are still generated rows only and the placeholders are not offered", idx.bulletDocs === 0 && idx.placeholders === 0, JSON.stringify([idx.bulletDocs, idx.placeholders]));

  // §4 purchase + §5 load/fire on fixtures
  console.log("§4 purchase, §5 loading and firing");
  const r = await p.evaluate(async () => {
    const P = await import("/modules/cp2020-augmented/module/shop/purchase.js");
    const AD = await import("/modules/cp2020-augmented/module/combat/area-delivery.js");
    const out = { errors: [] };
    const pack = game.packs.get("cp2020-augmented.supplement-heavy");
    const docs = await pack.getDocuments();
    const byName = n => docs.find(d => d.name === n);
    const actor = await Actor.create({ name: "__PW__ Grenadier", type: "character", system: { eurobucks: 10000 } });
    try {
      const frag = byName("25mm Fragmentation Grenade"), hp = byName("Tsunami 25mm HP HE Grenade"), he40 = byName("40mm HE Grenade");
      const miniGL = byName("Militech Mini-Grenade Launcher (Pump)");
      const coreGL = (await game.packs.get("cyberpunk2020.heavy").getDocuments()).find(d => d.name === "Grenade Launcher");
      out.have = { frag: !!frag, hp: !!hp, he40: !!he40, miniGL: !!miniGL, coreGL: !!coreGL };
      const funds0 = actor.system.eurobucks;
      await P.buyItem(actor, frag, { qty: 3 });
      const after1 = actor.itemTypes.ammo.filter(a => a.name === frag.name);
      out.buy1 = { stacks: after1.length, qty: after1[0]?.system?.quantity, locked: after1[0]?.system?.qtyLocked, caliber: after1[0]?.system?.caliber, charged: funds0 - actor.system.eurobucks };
      await P.buyItem(actor, frag, { qty: 2 });
      const after2 = actor.itemTypes.ammo.filter(a => a.name === frag.name);
      out.buy2 = { stacks: after2.length, qty: after2[0]?.system?.quantity, charged: funds0 - actor.system.eurobucks };
      await P.buyItem(actor, hp, { qty: 1 }); await P.buyItem(actor, he40, { qty: 1 });
      out.stacks = actor.itemTypes.ammo.map(a => `${a.name}:${a.system.quantity}`).sort();
      // weapons
      const [gl] = await actor.createEmbeddedDocuments("Item", [miniGL.toObject()]);
      const [cgl] = await actor.createEmbeddedDocuments("Item", [coreGL.toObject()]);
      const choices = async (w) => { const sh = w.sheet; await sh.render(true); await new Promise(r => setTimeout(r, 900)); const ctx = await sh.getData?.() ?? await sh._prepareContext?.({}); await sh.close(); return (ctx?.ammoChoices ?? ctx?.sheet?.ammoChoices ?? []).map(c => c.localKey); };
      out.miniChoices = await choices(gl);
      out.coreChoices = await choices(cgl);
      // load the 25mm frag into the Mini-GL and read the fire-time answers
      const fragItem = actor.itemTypes.ammo.find(a => a.name === frag.name);
      await gl.update({ "system.ammoItemId": fragItem.id, "system.loadedAmmoId": fragItem.id, "system.shotsLeft": 1 });
      out.fire = { formula: await AD.warheadDamageFor(gl), detonates: AD.weaponDetonates(gl), launched: AD.areaDeliveryIsLaunched(gl), radius: AD.areaDeliveryOf({ attackType: gl.system.attackType, blastRadius: fragItem.system.blastRadius })?.radiusM, printed: gl.system.damage };
      // the Core launcher loaded with a 40mm HE round
      const heItem = actor.itemTypes.ammo.find(a => a.name === he40.name);
      await cgl.update({ "system.ammoItemId": heItem.id, "system.loadedAmmoId": heItem.id, "system.shotsLeft": 1 });
      out.coreFire = { formula: await AD.warheadDamageFor(cgl), radius: AD.areaDeliveryOf({ attackType: cgl.system.attackType, blastRadius: heItem.system.blastRadius })?.radiusM };
    } catch (e) { out.errors.push(String(e?.stack ?? e)); }
    finally { await actor.delete().catch(() => {}); }
    return out;
  });
  check("§4/5 fixtures: the rounds, the Mini-GL and the Core launcher resolved from the packs", r.have && Object.values(r.have).every(Boolean), JSON.stringify(r.have));
  check("§4 three rounds land as one stack of 3, quantity unlocked, caliber kept, charged 90eb", r.buy1?.stacks === 1 && r.buy1.qty === 3 && r.buy1.locked === false && r.buy1.caliber === "25mm grenade" && r.buy1.charged === 90, JSON.stringify(r.buy1));
  check("§4 two more stack onto the same item (5), charged 150eb in all", r.buy2?.stacks === 1 && r.buy2.qty === 5 && r.buy2.charged === 150, JSON.stringify(r.buy2));
  check("§4 a different round is its own stack", JSON.stringify(r.stacks) === JSON.stringify(["25mm Fragmentation Grenade:5", "40mm HE Grenade:1", "Tsunami 25mm HP HE Grenade:1"]), JSON.stringify(r.stacks));
  check("§5 the Mini-GL's sheet offers the 25mm round and neither the HP nor the 40mm", r.miniChoices?.some(c => c.startsWith("25mm Fragmentation")) && !r.miniChoices.some(c => /Tsunami|40mm/.test(c)), JSON.stringify(r.miniChoices));
  check("§5 the Core launcher's sheet offers the 40mm round and not the 25mm ones", r.coreChoices?.some(c => c.startsWith("40mm HE")) && !r.coreChoices.some(c => /25mm/.test(c)), JSON.stringify(r.coreChoices));
  check("§5 loaded, the Mini-GL fires 2d6+1 over its printed 'Varies', detonates, counts as launched, radius 2.5 m", r.fire?.formula === "2d6+1" && r.fire.detonates === true && r.fire.launched === true && r.fire.radius === 2.5 && /^Varies/.test(r.fire.printed), JSON.stringify(r.fire));
  check("§5 the Core launcher loaded with a 40mm HE fires 7d6 at 5 m", r.coreFire?.formula === "7d6" && r.coreFire.radius === 5, JSON.stringify(r.coreFire));
  check("§4/5 the fixture run threw nothing", r.errors.length === 0, r.errors.join(" | ").slice(0, 300));
} finally {
  await p.evaluate(async () => { for (const a of game.actors.filter(a => a.name.startsWith("__PW__ Grenadier"))) await a.delete().catch(() => {}); }).catch(() => {});
  check("0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await b.close();
}
console.log(fail ? `${fail} FAILED` : "ALL PASSED");
process.exit(fail ? 1 : 0);
