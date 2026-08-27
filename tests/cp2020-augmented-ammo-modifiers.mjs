/** D4 ammo variants as scoped ammo-modifiers (user: "model as ammo-modifiers, but arrow loads must
 *  not be selectable on bullets or vice versa"). Covers the pure compat gate, the modifier→effect
 *  mapping, the ammo item-sheet dropdown scoping, the shop purchase guard, and the seam that carries
 *  the loaded ammo's effect field into the fire pipeline. Runs on :30004 (official 1.1.1 + module). */
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
  const L = await import("/modules/cp2020-augmented/module/lookups.js");
  const BA = await import("/modules/cp2020-augmented/module/dialog/buy-ammo.js");
  const SHOP = await import("/modules/cp2020-augmented/module/shop/buy-ammo.js");
  const SEAM = await import("/modules/cp2020-augmented/module/seam-shim.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  // ── (0) PURE compat gate ──────────────────────────────────────────────────
  out.family = {
    arrow: L.caliberFamily("Arrow"), bolt: L.caliberFamily("Bolt"),
    firearm: L.caliberFamily("9mm"), shotgun: L.caliberFamily("00"), unset: L.caliberFamily("")
  };
  out.applies = {
    broadheadOnArrow: L.modifierAppliesToCaliber("broadhead", "Arrow"),
    broadheadOnBullet: L.modifierAppliesToCaliber("broadhead", "9mm"),   // must be false
    apOnBullet: L.modifierAppliesToCaliber("ap", "9mm"),
    apOnArrow: L.modifierAppliesToCaliber("ap", "Arrow"),               // must be false
    stundartOnShotgun: L.modifierAppliesToCaliber("stundart", "00"),
    stundartOnBullet: L.modifierAppliesToCaliber("stundart", "9mm"),    // must be false
    standardOnArrow: L.modifierAppliesToCaliber("standard", "Arrow")    // universal → true
  };
  const idsFor = (cal) => L.modifiersForCaliber(cal).map(([id]) => id);
  out.listArrow = idsFor("Arrow");
  out.listBullet = idsFor("9mm");
  out.listShotgun = idsFor("00");

  // ── (1) modifier → effect fields ──────────────────────────────────────────
  const upd = (id) => BA.applyAmmoModifierUpdate(id);
  out.mech = {
    broadhead: upd("broadhead")["system.penDamageMult"],
    spinner: upd("spinner")["system.penDamageMult"],
    targetSoft: upd("target")["system.armorMultSoft"], targetHard: upd("target")["system.armorMultHard"],
    stundartStun: upd("stundart")["system.stunSaveOnHit"], stundartMod: upd("stundart")["system.stunSaveMod"]
  };

  // ── (2) effect-field SEAM: loaded arrow → weaponFired payload ──────────────
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Ammo"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__AmmoPunk", type: "character" });
  await actor.update({ "system.eurobucks": 100000 });
  const [bow] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__Bow", type: "weapon", system: { caliber: "Arrow" } }]);
  const [arrow] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__BroadheadArrow", type: "ammo",
    system: foundry.utils.mergeObject({ caliber: "Arrow", quantity: 12 }, BA.ammoModifierSystemFields("broadhead"), { inplace: false }) }]);
  await bow.update({ "system.ammoItemId": arrow.id });
  await sleep(200);
  const fx = SEAM.ammoEffectFields(bow);
  out.seam = { penDamageMult: fx.penDamageMult, storedModifier: arrow.system?.modifier };

  // ── (3) shop purchase guard: an incompatible load (arrow "broadhead" on a bullet caliber) is REFUSED
  //        (warn + no item created), matching the item-sheet modifier picker — NOT coerced to Standard. ──
  const buyGuardRet = await SHOP.purchaseAmmo(actor, { caliber: "9mm", modifier: "broadhead", boxes: 1 }); await sleep(300);
  const boughtBullet = (actor.itemTypes?.ammo ?? []).find(a => a.system?.caliber === "9mm");
  out.buyGuard = { rejected: buyGuardRet === false, madeItem: !!boughtBullet };
  await SHOP.purchaseAmmo(actor, { caliber: "Arrow", modifier: "broadhead", boxes: 1 }); await sleep(300);
  const boughtArrow = (actor.itemTypes?.ammo ?? []).filter(a => a.system?.caliber === "Arrow").find(a => a.system?.modifier === "broadhead");
  out.buyArrow = { modifier: boughtArrow?.system?.modifier, pen: boughtArrow?.system?.penDamageMult };

  // ── (4) item-sheet dropdown scoping ───────────────────────────────────────
  const [bulletAmmo] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__9mmAmmo", type: "ammo", system: { caliber: "9mm" } }]);
  await bulletAmmo.sheet.render(true); await sleep(700);
  let root = bulletAmmo.sheet.element;
  const bulletOpts = [...(root?.querySelectorAll("select.cp-ammo-modifier option") ?? [])].map(o => o.textContent.trim());
  out.bulletDropdown = { hasBroadhead: bulletOpts.includes("Broadhead"), hasAP: bulletOpts.includes("Armor-Piercing") };
  await bulletAmmo.sheet.close().catch(() => {});

  const [arrowAmmo] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__ArrowAmmo", type: "ammo", system: { caliber: "Arrow" } }]);
  await arrowAmmo.sheet.render(true); await sleep(700);
  root = arrowAmmo.sheet.element;
  const arrowOpts = [...(root?.querySelectorAll("select.cp-ammo-modifier option") ?? [])].map(o => o.textContent.trim());
  out.arrowDropdown = { hasBroadhead: arrowOpts.includes("Broadhead"), hasTarget: arrowOpts.includes("Target"), hasAP: arrowOpts.includes("Armor-Piercing") };
  await arrowAmmo.sheet.close().catch(() => {});

  // ── (5) quantity-lock augment field ───────────────────────────────────────
  //  The lock control writes `system.qtyLocked`. That field had no home in either the base ammo
  //  schema or the augment factory, so every write was stripped on the way to storage and the
  //  control was inert (connection audit N2). Three layers: the field is DECLARED with its
  //  initial, a write ROUND-TRIPS to the stored source, and the real DOM control flips both the
  //  icon and the quantity input's readonly state — both ways.
  const [lockAmmo] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__LockAmmo", type: "ammo",
    system: { caliber: "9mm", quantity: 50 } }]);
  out.lockField = {
    declared: !!lockAmmo.system?.schema?.fields?.qtyLocked,
    initial: lockAmmo.system?.qtyLocked,
    sourceInitial: lockAmmo._source?.system?.qtyLocked
  };

  // Round trip: write, then read back off the STORED source (not just the prepared view) after a
  // re-fetch — a stripped write leaves the source untouched while the live object can still lie.
  await lockAmmo.update({ "system.qtyLocked": false }); await sleep(250);
  const relock = actor.items.get(lockAmmo.id);
  out.lockRoundTrip = { prepared: relock?.system?.qtyLocked, stored: relock?.toObject()?.system?.qtyLocked };
  await lockAmmo.update({ "system.qtyLocked": true }); await sleep(250);
  out.lockRoundTripBack = actor.items.get(lockAmmo.id)?.toObject()?.system?.qtyLocked;

  // GESTURE: render the sheet and click the real control; read the redrawn DOM each time.
  await lockAmmo.sheet.render(true); await sleep(900);
  const readLock = () => {
    const el = lockAmmo.sheet.element;
    const btn = el?.querySelector(".cp-ammo-qty-lock");
    const icon = btn?.querySelector("i");
    const qty = el?.querySelector('input[name="system.quantity"]');
    const rc = btn?.getBoundingClientRect();
    const cs = btn ? getComputedStyle(btn) : null;
    const hit = rc ? document.elementFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2) : null;
    return {
      present: !!btn,
      boxed: !!rc && rc.width > 0 && rc.height > 0 && cs.display !== "none" && cs.visibility !== "hidden",
      reachable: !!hit && (hit === btn || btn.contains(hit)),
      closedIcon: !!icon?.classList.contains("fa-lock"),
      openIcon: !!icon?.classList.contains("fa-lock-open"),
      readonly: qty ? qty.hasAttribute("readonly") : null,
      doc: lockAmmo.system?.qtyLocked
    };
  };
  const clickLock = async () => {
    lockAmmo.sheet.element?.querySelector(".cp-ammo-qty-lock")?.click();
    await sleep(900);
  };
  out.lockAtRest = readLock();
  await clickLock();
  out.lockAfterClick = readLock();
  // Second act: the same gesture again must send it back, not stick in the released state.
  await clickLock();
  out.lockAfterSecondClick = readLock();
  await lockAmmo.sheet.close().catch(() => {});

  await actor.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const arr = r.listArrow, bul = r.listBullet, sho = r.listShotgun;
const checks = [
  ["pure: family map (arrow/bolt/firearm/shotgun/unset)", r.family.arrow === "arrow" && r.family.bolt === "arrow" && r.family.firearm === "firearm" && r.family.shotgun === "shotgun" && r.family.unset === ""],
  ["pure: arrow load fits arrows, NOT bullets", r.applies.broadheadOnArrow === true && r.applies.broadheadOnBullet === false],
  ["pure: firearm load fits bullets, NOT arrows", r.applies.apOnBullet === true && r.applies.apOnArrow === false],
  ["pure: shotgun load fits shotgun, NOT bullets", r.applies.stundartOnShotgun === true && r.applies.stundartOnBullet === false],
  ["pure: Standard is universal", r.applies.standardOnArrow === true],
  ["pure: Arrow list = arrow loads + Standard, no firearm loads", arr.includes("broadhead") && arr.includes("spinner") && arr.includes("target") && arr.includes("standard") && !arr.includes("ap") && !arr.includes("hollowPoint") && !arr.includes("stundart")],
  ["pure: 9mm list = firearm loads, no arrow/shotgun-only loads", bul.includes("ap") && bul.includes("hollowPoint") && !bul.includes("broadhead") && !bul.includes("stundart")],
  ["pure: 00 list includes Stundart + firearm loads, not arrow loads", sho.includes("stundart") && sho.includes("ap") && !sho.includes("broadhead")],
  ["mech: Broadhead pen×2 / Spinner pen×3", r.mech.broadhead === 2 && r.mech.spinner === 3],
  ["mech: Target halves armor (soft+hard 0.5)", r.mech.targetSoft === 0.5 && r.mech.targetHard === 0.5],
  ["mech: Stundart forces stun save at −2", r.mech.stundartStun === true && r.mech.stundartMod === -2],
  ["seam: loaded Broadhead arrow carries penDamageMult 2 into weaponFired", r.seam.penDamageMult === 2 && r.seam.storedModifier === "broadhead"],
  ["buy guard: broadhead on 9mm is REFUSED (arrow load, no bullet ammo created)", r.buyGuard.rejected === true && r.buyGuard.madeItem === false],
  ["buy: broadhead on Arrow keeps the load (pen 2)", r.buyArrow.modifier === "broadhead" && r.buyArrow.pen === 2],
  ["dropdown: bullet ammo hides Broadhead, shows Armor-Piercing", r.bulletDropdown.hasBroadhead === false && r.bulletDropdown.hasAP === true],
  ["dropdown: arrow ammo shows Broadhead+Target, hides Armor-Piercing", r.arrowDropdown.hasBroadhead === true && r.arrowDropdown.hasTarget === true && r.arrowDropdown.hasAP === false],
  ["augment field: quantity-lock declared on the ammo schema, initial engaged", r.lockField.declared === true && r.lockField.initial === true && r.lockField.sourceInitial === true],
  ["augment field: quantity-lock write round-trips (released value reaches stored source)", r.lockRoundTrip.prepared === false && r.lockRoundTrip.stored === false],
  ["augment field: quantity-lock write-back round-trips (engaged value returns to stored source)", r.lockRoundTripBack === true],
  ["lock control: real box, reachable by hit-test at rest", r.lockAtRest.present === true && r.lockAtRest.boxed === true && r.lockAtRest.reachable === true],
  ["lock control at rest: closed icon, quantity readonly, document engaged", r.lockAtRest.closedIcon === true && r.lockAtRest.openIcon === false && r.lockAtRest.readonly === true && r.lockAtRest.doc === true],
  ["lock control click: icon flips open, readonly drops, document released", r.lockAfterClick.openIcon === true && r.lockAfterClick.closedIcon === false && r.lockAfterClick.readonly === false && r.lockAfterClick.doc === false],
  ["lock control second click: icon re-closes, readonly returns, document engaged", r.lockAfterSecondClick.closedIcon === true && r.lockAfterSecondClick.openIcon === false && r.lockAfterSecondClick.readonly === true && r.lockAfterSecondClick.doc === true],
  ["0 console errors", errors.length === 0]
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
