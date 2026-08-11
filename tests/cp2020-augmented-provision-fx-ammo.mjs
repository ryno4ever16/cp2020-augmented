/**
 * ⏪ SUPERSEDED 2026-08-09 by `cp2020-augmented-provision-review-bench.mjs`. Its premise — a shooter
 * carrying unloaded guns plus a shelf of ammo boxes, so a reviewer loads each gun from the sheet — was
 * retired by the user: "preload my guns with the right ammo and give me multiple guns of the same type
 * with different ammo so I can just go down the list and shoot each of them." The bench script builds
 * one PRELOADED weapon per (class × distinct-visual load) instead, and deletes this script's "· FX
 * bench" ammo as part of its rebuild. Kept for the reading it records (which treatment each class shows
 * best); running it after the bench script does nothing, because the plain-named guns it looks for are
 * gone.
 *
 * PROVISIONING (not a keeper): the ammo bench for the review shooter.
 *
 * The FX rail's ammo overlay (FR#24) draws a different shot per LOADED MODIFIER, and none of it can be
 * looked at without ammo items to load. This stocks one ammo item per treated modifier on the review
 * shooter, in a caliber one of its weapons actually takes, so a reviewer can swap loads from the sheet
 * and fire the same gun twice.
 *
 * DELIBERATELY NON-DESTRUCTIVE, and that is the point of running it rather than doing it by hand:
 *  - IDEMPOTENT. An ammo item matching (caliber + modifier) is topped back up to the stock quantity
 *    rather than duplicated, so running it twice leaves the bench exactly as running it once does.
 *  - It NEVER changes what a weapon has loaded (`system.ammoItemId`) and never touches a magazine. The
 *    review loadout is a deliverable of an earlier unit; this only adds to it. Every weapon therefore
 *    still fires the ordinary rail until a reviewer chooses otherwise.
 *  - It adds NO actor and NO token.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=<pw> node cp2020-augmented-provision-fx-ammo.mjs
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "";
const SHOOTER = process.env.FX_AMMO_ACTOR ?? "Review · Shooter";
const STOCK = 60;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(String(e.message)));

await page.goto(`${URL}/join`);
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const sel = document.querySelector('select[name="userid"]');
  sel.value = [...sel.options].find(o => /gamemaster/i.test(o.textContent)).value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 90000 });
await page.waitForTimeout(2500);

const result = await page.evaluate(async ({ SHOOTER, STOCK }) => {
  const SCOPE = "cp2020-augmented";
  const { ammoModifierSystemFields } = await import(`/modules/${SCOPE}/module/dialog/buy-ammo.js`);
  const { AMMO_MODIFIERS } = await import(`/modules/${SCOPE}/module/lookups.js`);
  const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);

  const actor = game.actors.getName(SHOOTER);
  if (!actor) return { error: `no actor named "${SHOOTER}"` };

  // The bench is derived from the shooter's OWN weapons, so it cannot drift from the loadout: every
  // row names a caliber some weapon on this sheet already takes, and the class each one resolves to is
  // read from the rail's own resolver rather than assumed.
  const weapons = actor.itemTypes.weapon
    .filter(w => w.system?.ammoType && w.system.ammoType !== "NA")
    .map(w => ({ name: w.name, caliber: w.system.ammoType, cls: fx.weaponFxClass(w) }));

  // One row per TREATED modifier (the ids AMMO_FX carries), each pointed at a weapon whose class shows
  // that treatment best. The comment on each says what a reviewer should be looking for.
  const wants = [
    ["api", "Militech Ronin Light Assault", "red bolt + burning ground (no mark under it), warm muzzle light"],
    ["api", "Arasaka Rapid Assault Shot 12", "tint on the discharge column ONLY — the pellet fan stays untinted"],
    ["ap", "Militech Ronin Light Assault", "near-white bolt, ground-crack impact"],
    ["dualPurpose", "Barrett-Arasaka Light 20mm", "identical to ap by ruling — the mechanics are identical"],
    ["hollowPoint", "Stolbovoy St-2 Pistol", "wide messy bloom, same asset, nothing else changed"],
    ["safety", "Militech Arms Avenger", "small mark — the round built not to over-penetrate"],
    ["flechette", "Arasaka Rapid Assault Shot 12", "8 darts, wider and faster than buckshot"],
    ["flechette", "Militech Ronin Light Assault", "a fan from a class that normally draws one bolt"],
    ["rubber", "H&K MPK-9", "dull, darkened bolt and a small mark"],
    ["stundart", "Arasaka Rapid Assault Shot 12", "drawn as rubber is — the stun modifier is not a visible fact"],
  ];

  const added = [], toppedUp = [], skipped = [];
  for (const [modifier, weaponName, look] of wants) {
    const w = weapons.find(x => x.name === weaponName);
    if (!w) { skipped.push({ modifier, weaponName, why: "no such weapon on the sheet" }); continue; }
    const caliber = w.caliber;
    const existing = actor.itemTypes.ammo.find(a =>
      String(a.system?.caliber ?? a.system?.ammoType ?? "") === String(caliber)
      && (a.system?.modifier ?? "standard") === modifier);
    if (existing) {
      if (Number(existing.system?.quantity ?? 0) < STOCK) {
        await existing.update({ "system.quantity": STOCK });
        toppedUp.push({ modifier, caliber, weapon: w.name, cls: w.cls, name: existing.name, look });
      } else {
        skipped.push({ modifier, weaponName, why: `already stocked (${existing.system.quantity})` });
      }
      continue;
    }
    const label = AMMO_MODIFIERS[modifier]?.label ?? modifier;
    const system = foundry.utils.mergeObject(
      { caliber, ammoType: caliber, quantity: STOCK, boxSize: 1, boxCost: 0 },
      ammoModifierSystemFields(modifier), { inplace: false });
    const [made] = await actor.createEmbeddedDocuments("Item", [{
      name: `${caliber} ${label} · FX bench`, type: "ammo", system,
    }]);
    added.push({ modifier, caliber, weapon: w.name, cls: w.cls, name: made.name, look });
  }

  // What the rail would draw for each, read from the rail itself — so the report is the product's own
  // answer and not this script's opinion of it.
  const preview = [...added, ...toppedUp].map(r => {
    const e = fx.ammoFxEntry(r.cls, r.modifier) ?? {};
    const base = fx.FX_CLASSES[r.cls] ?? {};
    return {
      ...r,
      impactKey: (e.impactKey ?? fx.HIT_CONFIRM.key).replace("jb2a.", ""),
      impactSquares: e.impactSquares,
      baseImpactSquares: base.impactSquares,
      tinted: e.tracerColor !== base.tracerColor ? "tracer" : (e.columnColor !== base.columnColor ? "column" : "—"),
      pellets: e.pellets ?? 1,
      tailMs: fx.presentationTailMs(r.cls, r.modifier),
      baseTailMs: fx.presentationTailMs(r.cls),
      groundFire: e.groundFire === true,
    };
  });

  // What was NOT touched, reported so the non-destructive claim is checkable rather than asserted.
  const untouched = actor.itemTypes.weapon.map(w => ({
    name: w.name, loaded: w.system?.ammoItemId || "(none)",
    shots: `${w.system?.shotsLeft ?? "?"}/${w.system?.shots ?? "?"}`,
  }));

  return { actor: actor.name, added, toppedUp, skipped, preview, untouched,
    ammoOnSheet: actor.itemTypes.ammo.length };
}, { SHOOTER, STOCK });

if (result.error) {
  console.log(`FAILED: ${result.error}`);
} else {
  console.log(`\n=== FX ammo bench on "${result.actor}" ===`);
  console.log(`added ${result.added.length} · topped up ${result.toppedUp.length} · skipped ${result.skipped.length} · ammo items on sheet now ${result.ammoOnSheet}`);
  console.log("\n modifier      caliber  class     item                                intended weapon                     impact                    w(base)      tint     pellets  tail(base)  fire");
  for (const p of result.preview) {
    const cell = (v, n) => String(v).padEnd(n).slice(0, n);
    console.log(` ${cell(p.modifier, 13)} ${cell(p.caliber, 8)} ${cell(p.cls, 9)} ${cell(p.name, 35)} ${cell(p.weapon, 35)} ${cell(p.impactKey, 25)} ${cell(`${p.impactSquares}(${p.baseImpactSquares})`, 12)} ${cell(p.tinted, 8)} ${cell(p.pellets, 8)} ${cell(`${p.tailMs}(${p.baseTailMs})`, 11)} ${p.groundFire ? "yes" : "—"}`);
  }
  console.log("\n what to look for:");
  for (const p of result.preview) console.log(`  ${p.modifier} on ${p.weapon}: ${p.look}`);
  if (result.skipped.length) {
    console.log("\n skipped:");
    for (const s of result.skipped) console.log(`  ${s.modifier} / ${s.weaponName} — ${s.why}`);
  }
  console.log("\n untouched (loaded ammo + magazines, proving nothing was re-loaded):");
  for (const w of result.untouched) console.log(`  ${w.name}: loaded ${w.loaded}, ${w.shots}`);
}
console.log(`\npage errors: ${errors.length}${errors.length ? ` — ${errors.slice(0, 3).join(" | ")}` : ""}`);
await browser.close();
process.exit(result.error ? 1 : 0);
