/**
 * PROVISIONING (not a keeper): the MORNING REVIEW BENCH on Review · Shooter.
 *
 * Spec: modules/cp2020-augmented/import-staging/REVIEW-BENCH-SPEC.md (user-ruled 2026-08-09) —
 *   "preload my guns with the right ammo and give me multiple guns of the same type with different
 *    ammo so I can just go down the list and shoot each of them."
 *
 * WHAT IT BUILDS. One weapon per (FX class × distinct-visual load), each PRELOADED, named with a
 * numbered prefix so the sheet reads as an ordered walk-down list. Firing takes zero loading steps:
 * every gun's `system.ammoItemId` points at its OWN dedicated ammo item and `shotsLeft` is the
 * magazine's capacity. `ammoItemId` is the field the seam actually reads (seam-shim.js
 * `ammoEffectFields`), so that link IS "loaded" on the ship-target system.
 *
 * ⚠ `loadedAmmoId` / `loadedAmmo` — the snapshot pair the spec also names — exist ONLY on the FORK's
 * weapon schema (module/data/item-data.js there); the shipped system (cyberpunk2020 1.1.1) has
 * neither field and a write to one is dropped by the DataModel. This script therefore writes them
 * when the running system's schema carries them and reports when it does not, rather than writing
 * dead keys and claiming a link that is not there.
 *
 * SUPERSEDES the 8-weapon unloaded bench and `cp2020-augmented-provision-fx-ammo.mjs`'s ammo rows.
 * The old plain-named guns and the old "· FX bench" ammo are deleted deliberately — that design is
 * superseded by the ruling above. Melee (Kick / Strike) is left alone; other specs use it.
 *
 * IDEMPOTENT BY REBUILD. Every run deletes what it owns (its own flagged items + the superseded
 * bench) and recreates the same 16 rows, in order, one at a time — so the Combat tab, which lists
 * `actor.itemTypes.weapon` in COLLECTION order and not by name, reads 01 → 16 top to bottom on the
 * first run and on the fiftieth. Re-running is also the reset: magazines full, loads re-linked.
 *
 * IT ALSO SETS THE RANGE UP, because a bench you cannot hit with is not a bench:
 *  - the three targets are moved to ~11 m (inside every bench weapon's CLOSE band, DC 15), fanned
 *    one square apart, with name labels forced visible;
 *  - the shooter's four combat skills are raised to 10 (REF 5 + 10 beats DC 15 on any die) — the
 *    WEAPONS are untouched and stay at their shipped accuracy, per the spec;
 *  - damage is zeroed on all three targets.
 *
 * IT DOES NOT TOUCH: any other scene, the showcase encounter, the three cover regions, any other
 * actor, or any world setting except that it turns the gore switch ON if it is off (the spec asks
 * for blood without fiddling).
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=<pw> node cp2020-augmented-provision-review-bench.mjs
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "";
const SHOOTER = process.env.BENCH_ACTOR ?? "Review · Shooter";
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
  const { AMMO_MODIFIERS, modifierAppliesToCaliber, spreadModeForAmmo } = await import(`/modules/${SCOPE}/module/lookups.js`);
  const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);

  const actor = game.actors.getName(SHOOTER);
  if (!actor) return { error: `no actor named "${SHOOTER}"` };

  /* ── THE BENCH ────────────────────────────────────────────────────────────────────────────────
   * One row per (class × distinct-visual load), in walk-down order: pistol → smg → rifle → shell →
   * heavy. `load` is an AMMO_MODIFIERS id; `label` overrides the modifier's own label only where the
   * plain label would not say what the reviewer is looking at (the shell's Standard IS buckshot).
   * Every pairing is checked against modifiersForCaliber below — no 9mm load lands in a 10mm gun,
   * and no firearm-only load lands on a shell.
   */
  const BENCH = [
    { n: 1,  base: "Stolbovoy St-2 Pistol",          load: "standard"    },
    { n: 2,  base: "Stolbovoy St-2 Pistol",          load: "hollowPoint" },
    { n: 3,  base: "Stolbovoy St-2 Pistol",          load: "safety"      },
    { n: 4,  base: "H&K MPK-9",                      load: "standard"    },
    { n: 5,  base: "H&K MPK-9",                      load: "rubber"      },
    { n: 6,  base: "Militech Ronin Light Assault",   load: "standard"    },
    { n: 7,  base: "Militech Ronin Light Assault",   load: "api"         },
    { n: 8,  base: "Militech Ronin Light Assault",   load: "ap"          },
    { n: 9,  base: "Militech Ronin Light Assault",   load: "flechette"   },
    { n: 10, base: "Arasaka Rapid Assault Shot 12",  load: "standard",   label: "Buckshot" },
    { n: 11, base: "Arasaka Rapid Assault Shot 12",  load: "slug"        },
    { n: 12, base: "Arasaka Rapid Assault Shot 12",  load: "api"         },
    { n: 13, base: "Arasaka Rapid Assault Shot 12",  load: "stundart"    },
    { n: 14, base: "Arasaka Rapid Assault Shot 12",  load: "flechette"   },
    { n: 15, base: "Barrett-Arasaka Light 20mm",     load: "standard"    },
    { n: 16, base: "Barrett-Arasaka Light 20mm",     load: "dualPurpose" },
  ];
  const BASE_NAMES = [...new Set(BENCH.map(r => r.base))];
  // The one extra plain gun the superseded bench carried that no numbered row needs. Named so the
  // deletion is a decision in this file rather than a side effect of a name pattern.
  const RETIRED_PLAIN = ["Militech Arms Avenger"];
  const pad = (n) => String(n).padStart(2, "0");
  const loadLabel = (r) => r.label ?? (AMMO_MODIFIERS[r.load]?.label ?? r.load);

  /* ── 1. SOURCES, resolved BEFORE anything is deleted ─────────────────────────────────────────
   * Three places, in order of least IO: a plain item still on the sheet (first run), a bench item
   * this script made earlier (every later run — it carries the same base stats), then the packs.
   */
  const sources = {}, sourceFrom = {};
  const benchFlagged = actor.items.filter(i => i.getFlag(SCOPE, "reviewBench"));
  for (const b of BASE_NAMES) {
    const plain = actor.itemTypes.weapon.find(w => w.name === b && !w.getFlag(SCOPE, "reviewBench"));
    if (plain) { sources[b] = plain.toObject(); sourceFrom[b] = "sheet (plain)"; continue; }
    const prior = benchFlagged.find(i => i.type === "weapon" && i.getFlag(SCOPE, "reviewBench")?.base === b);
    if (prior) { sources[b] = prior.toObject(); sourceFrom[b] = "sheet (previous bench)"; continue; }
  }
  const missing = BASE_NAMES.filter(b => !sources[b]);
  if (missing.length) {
    for (const p of game.packs) {
      if (p.documentName !== "Item" || !missing.length) continue;
      const idx = await p.getIndex();
      for (const b of [...missing]) {
        const e = idx.find(i => i.name === b && (i.type === undefined || i.type === "weapon"));
        if (!e) continue;
        const doc = await p.getDocument(e._id);
        if (doc?.type !== "weapon") continue;
        sources[b] = doc.toObject(); sourceFrom[b] = p.collection;
        missing.splice(missing.indexOf(b), 1);
      }
    }
  }
  if (missing.length) return { error: `no source item found for: ${missing.join(", ")}` };

  // Legality gate: refuse to build a row whose (caliber, modifier) pair the registry forbids, and
  // report the derived spread mode so "buck vs slug vs flechette" is the product's answer, not ours.
  const illegal = [];
  for (const r of BENCH) {
    const caliber = String(sources[r.base].system?.ammoType ?? "").trim();
    if (!caliber || caliber === "NA") { illegal.push(`${pad(r.n)} ${r.base}: no ammoType on the source item`); continue; }
    if (!modifierAppliesToCaliber(r.load, caliber)) illegal.push(`${pad(r.n)} ${r.base}: ${r.load} is not legal on ${caliber}`);
  }
  if (illegal.length) return { error: `illegal (caliber, load) pairing(s): ${illegal.join(" | ")}` };

  /* ── 2. DELETE what this script owns + the superseded bench ─────────────────────────────────── */
  const doomed = actor.items.filter(i =>
    i.getFlag(SCOPE, "reviewBench")                                        // ours, from a previous run
    || (i.type === "weapon" && BASE_NAMES.includes(i.name))                // the plain guns it replaces
    || (i.type === "weapon" && RETIRED_PLAIN.includes(i.name))             // the plain gun no row needs
    || (i.type === "ammo" && / · FX bench$/.test(i.name)));                // the superseded ammo bench
  const deleted = doomed.map(i => `${i.type}:${i.name}`);
  if (doomed.length) await actor.deleteEmbeddedDocuments("Item", doomed.map(i => i.id));

  /* ── 3. AMMO, one dedicated item per row ─────────────────────────────────────────────────────
   * Created before the guns because each gun's `ammoItemId` has to name one. Every item's caliber IS
   * its gun's own `ammoType` string, which is what keeps the calibers honest by construction.
   */
  const ammoByRow = {};
  for (const r of BENCH) {
    const caliber = String(sources[r.base].system.ammoType).trim();
    const system = foundry.utils.mergeObject(
      { caliber, ammoType: caliber, quantity: STOCK, boxSize: 1, boxCost: 0 },
      ammoModifierSystemFields(r.load), { inplace: false });
    const [made] = await actor.createEmbeddedDocuments("Item", [{
      name: `${pad(r.n)} · ${caliber} ${loadLabel(r)}`,
      type: "ammo", sort: 100000 + r.n * 100, system,
      flags: { [SCOPE]: { reviewBench: { n: r.n, base: r.base, load: r.load, kind: "ammo" } } },
    }]);
    ammoByRow[r.n] = made;
  }

  /* ── 4. WEAPONS, one at a time so the collection order IS the walk-down order ────────────────── */
  const weaponSchema = CONFIG.Item.dataModels?.weapon?.schema?.fields ?? {};
  const hasLoadedPair = ("loadedAmmoId" in weaponSchema) && ("loadedAmmo" in weaponSchema);
  const built = [];
  for (const r of BENCH) {
    const src = foundry.utils.deepClone(sources[r.base]);
    delete src._id; delete src._stats; delete src.folder; delete src.ownership; delete src.effects;
    const ammo = ammoByRow[r.n];
    const capacity = Math.max(1, Math.floor(Number(src.system?.shots) || 1));
    src.name = `${pad(r.n)} · ${r.base} · ${loadLabel(r)}`;
    src.sort = 100000 + r.n * 100;
    src.flags = { [SCOPE]: { reviewBench: { n: r.n, base: r.base, load: r.load, kind: "weapon" } } };
    src.system.ammoItemId = ammo.id;      // ⭐ the link the seam reads — this IS "loaded" on stock
    src.system.shotsLeft = capacity;
    if (hasLoadedPair) {                  // fork-only snapshot pair; skipped (not faked) on stock
      src.system.loadedAmmoId = ammo.id;
      src.system.loadedAmmo = { name: ammo.name, img: ammo.img, system: ammo.toObject().system };
    }
    const [made] = await actor.createEmbeddedDocuments("Item", [src]);
    built.push({ n: r.n, name: made.name, ammo: ammo.name, caliber: ammo.system.caliber, load: r.load,
      cls: fx.weaponFxClass(made), attackType: made.system.attackType || "(semi)",
      rof: made.system.rof, shots: `${made.system.shotsLeft}/${made.system.shots}`,
      accuracy: made.system.accuracy ?? 0,
      linked: made.system.ammoItemId === ammo.id,
      spread: spreadModeForAmmo({ spreadMode: ammo.system.spreadMode, caliber: ammo.system.caliber, modifier: ammo.system.modifier }),
      qty: ammo.system.quantity });
  }

  /* ── 5. SKILLS: the shooter must be able to HIT, or the whole walk-down draws misses ─────────── */
  const SKILLS = { Handgun: 10, Rifle: 10, Submachinegun: 10, "Heavy Weapons": 10 };
  const skillReport = [];
  for (const [name, level] of Object.entries(SKILLS)) {
    const s = actor.itemTypes.skill.find(x => x.name === name);
    if (!s) { skillReport.push(`${name}: MISSING`); continue; }
    if (Number(s.system?.level) !== level) await s.update({ "system.level": level });
    skillReport.push(`${name}=${actor.itemTypes.skill.find(x => x.name === name).system.level}`);
  }

  /* ── 6. THE RANGE ────────────────────────────────────────────────────────────────────────────
   * Three targets two squares out and one square apart: 10.0–11.2 m on a 5 m grid, which is inside
   * the CLOSE band of every gun on the bench (the pistol's is the tightest at 50/4 = 12.5 m) and
   * outside the shot pattern's Short band (≤ 6 m), so buckshot throws its Medium 2 m / 3d6 pattern.
   */
  const scene = game.scenes.active;
  // The flesh target sits dead ahead — it is the one most shots want, and putting the SHORTEST name on
  // the shooter's own row is what keeps the two nameplates from running into each other at this spacing.
  const LAYOUT = {
    "Review · Target (Cyberlimb)":  { x: 1400, y:  900 },
    "Review · Target":              { x: 1400, y: 1000 },
    "Review · Target (Vehicle)":    { x: 1400, y: 1100 },
    "Review · Shooter":             { x: 1200, y: 1000 },
  };
  const ALWAYS = CONST.TOKEN_DISPLAY_MODES.ALWAYS;
  const tokenUpdates = [], rangeReport = [];
  for (const [name, pos] of Object.entries(LAYOUT)) {
    const t = scene.tokens.find(x => x.name === name);
    if (!t) { rangeReport.push(`${name}: NO TOKEN`); continue; }
    tokenUpdates.push({ _id: t.id, x: pos.x, y: pos.y, displayName: ALWAYS, displayBars: ALWAYS });
  }
  if (tokenUpdates.length) await scene.updateEmbeddedDocuments("Token", tokenUpdates);

  // Damage zeroed on every target, on the TOKEN's actor (two of the three are unlinked, so that is
  // where their state really lives) and on the world actor behind it.
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
      zeroed.push(`${a.name}${a.isToken ? " (token)" : ""}`);
    }
  }

  // Distances, measured after the move, so the CLOSE-band claim above is a reading and not a plan.
  // The settle is not decoration: on the FIRST run of a session this read raced the move and printed
  // the tokens' old separation, which is exactly the kind of number a reader would have trusted.
  await new Promise(r => setTimeout(r, 500));
  const gridSize = scene.grid?.size ?? 100, gridDist = scene.grid?.distance ?? 1;
  const sh = scene.tokens.find(x => x.name === "Review · Shooter");
  for (const name of ["Review · Target", "Review · Target (Cyberlimb)", "Review · Target (Vehicle)"]) {
    const t = scene.tokens.find(x => x.name === name);
    if (!t || !sh) continue;
    const d = Math.hypot((t.x - sh.x), (t.y - sh.y)) / gridSize * gridDist;
    rangeReport.push(`${name}: ${d.toFixed(1)} m · spread band ${d <= 6 ? "Short" : d <= 25 ? "Medium" : "Long"} · label ${t.displayName === ALWAYS ? "ALWAYS" : t.displayName}`);
  }

  /* ── 7. GORE ON (the spec: blood must show without touching settings) ────────────────────────── */
  let gore = null;
  try {
    gore = game.settings.get(SCOPE, "goreEnabled");
    if (gore !== true) { await game.settings.set(SCOPE, "goreEnabled", true); gore = game.settings.get(SCOPE, "goreEnabled"); }
  } catch (e) { gore = `ERR ${e.message}`; }
  let spreadOn = null;
  try { spreadOn = game.settings.get(SCOPE, "shotgunSpreadEnabled"); } catch (e) { spreadOn = `ERR ${e.message}`; }

  /* ── 8. VERIFY, by reading the documents back ────────────────────────────────────────────────── */
  const order = actor.itemTypes.weapon.map(w => w.name);
  const unloaded = actor.itemTypes.weapon
    .filter(w => w.getFlag(SCOPE, "reviewBench"))
    .filter(w => !w.system.ammoItemId || !actor.items.get(w.system.ammoItemId)
             || Number(w.system.shotsLeft) !== Number(w.system.shots))
    .map(w => w.name);

  return {
    actor: actor.name, built, deleted, sourceFrom, skillReport, rangeReport, zeroed,
    gore, spreadOn, hasLoadedPair, order, unloaded,
    counts: { weapons: actor.itemTypes.weapon.length, ammo: actor.itemTypes.ammo.length },
    sceneName: scene.name,
  };
}, { SHOOTER, STOCK });

if (result.error) {
  console.log(`FAILED: ${result.error}`);
} else {
  const cell = (v, n) => String(v).padEnd(n).slice(0, n);
  console.log(`\n=== Morning review bench on "${result.actor}" · scene "${result.sceneName}" ===`);
  console.log(`deleted ${result.deleted.length} superseded item(s) · built ${result.built.length} gun(s) + ${result.built.length} magazine(s)`);
  console.log(`sources: ${Object.entries(result.sourceFrom).map(([k, v]) => `${k} ← ${v}`).join(" · ")}`);
  console.log(`\n ##  weapon                                          load          caliber  class     mag     rof  mode          spread     rounds`);
  for (const b of result.built) {
    console.log(` ${cell(String(b.n).padStart(2, "0"), 3)} ${cell(b.name, 46)} ${cell(b.load, 13)} ${cell(b.caliber, 8)} ${cell(b.cls, 9)} ${cell(b.shots, 7)} ${cell(b.rof, 4)} ${cell(b.attackType, 13)} ${cell(b.spread, 10)} ${b.qty}${b.linked ? "" : "  ⛔ NOT LINKED"}`);
  }
  console.log(`\n every gun loaded + full: ${result.unloaded.length === 0 ? "YES" : `NO — ${result.unloaded.join(", ")}`}`);
  console.log(` fork-only loadedAmmoId/loadedAmmo pair present in this system's weapon schema: ${result.hasLoadedPair ? "yes (written)" : "NO (skipped — ammoItemId is the loaded link here)"}`);
  console.log(` sheet order (Combat tab reads this top-to-bottom):`);
  for (const n of result.order) console.log(`   ${n}`);
  console.log(`\n skills: ${result.skillReport.join(" · ")}`);
  console.log(` range:`);
  for (const r of result.rangeReport) console.log(`   ${r}`);
  console.log(` damage zeroed on: ${[...new Set(result.zeroed)].join(", ")}`);
  console.log(` gore setting: ${result.gore} · shotgun spread pattern: ${result.spreadOn}`);
  console.log(` items on sheet now: ${result.counts.weapons} weapon(s) / ${result.counts.ammo} ammo`);
}
console.log(`\npage errors: ${errors.length}${errors.length ? ` — ${errors.slice(0, 3).join(" | ")}` : ""}`);
await browser.close();
process.exit(result.error ? 1 : 0);
