/** ACPA seeded-load rig check — REAL, already-seeded powered-armour actors load + derive + render clean
 *  after the ACPA changes (new derived pilotPACS/runM/jumpStanding/jumpRunning, the acpaCombatModel
 *  field, and the pristine-suit "destroyed" fix). READ-ONLY: discovers suits in the world + every Actor
 *  compendium, asserts the derived numbers are finite, the pristine-suit destroyed flag holds, the combat
 *  model is a string, and the world sheets render with no raw i18n keys. Creates/deletes nothing.
 *  Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-acpa-seeded-load.mjs */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });   // ≥1366×768 or Foundry logs a resolution error
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = { discovery: { actorPacks: [], packErrors: [], list: [] }, results: [] };
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const isFin = v => Number.isFinite(v);

  // "no damage" = STR-loss 0 AND REF-loss 0 AND no damaged systems (array empty / string blank|na).
  const noDamage = (s) => {
    const sd = Number(s.strDamage) || 0;
    const rd = Number(s.refDamage) || 0;
    const ds = s.damagedSystems;
    let dsEmpty;
    if (Array.isArray(ds)) dsEmpty = ds.length === 0;
    else if (typeof ds === "string") dsEmpty = ds.trim() === "" || /^n\/?a$/i.test(ds.trim());
    else dsEmpty = ds == null;
    return sd === 0 && rd === 0 && dsEmpty;
  };

  // Shared assertion set over a prepared system object (world actor or pack doc).
  const assess = (sys) => {
    const raw = { effectiveRef: sys.effectiveRef, sib: sys.sib, runM: sys.runM, pilotPACS: sys.pilotPACS, bodyValue: sys.bodyValue };
    const fields = {}; let allFinite = true;
    for (const [k, v] of Object.entries(raw)) { const f = isFin(v); fields[k] = { v, finite: f }; if (!f) allFinite = false; }
    const destroyedIsBool = typeof sys.destroyed === "boolean";
    const pristine = noDamage(sys);
    const destroyedOkForPristine = !pristine || sys.destroyed === false;   // the fix: a pristine suit is NOT destroyed
    const combatModelIsString = typeof sys.acpaCombatModel === "string";
    return { fields, allFinite, destroyed: sys.destroyed, destroyedIsBool, pristine,
             destroyedOkForPristine, acpaCombatModel: sys.acpaCombatModel, combatModelIsString };
  };

  // ── Discovery (a): world actors ──
  const worldAcpas = game.actors.filter(a => a.type === "cp2020-augmented.vehicle" && a.system?.isACPA);

  // ── Discovery (b): every Actor compendium ──
  const packAcpas = [];
  for (const pack of game.packs) {
    if (pack.metadata.type !== "Actor") continue;
    out.discovery.actorPacks.push(pack.collection);
    let idx;
    try { idx = await pack.getIndex(); } catch (e) { out.discovery.packErrors.push({ pack: pack.collection, error: String(e?.message || e) }); continue; }
    for (const entry of idx) {
      // Safe fast-skip: if the index carries a type and it is definitively NOT our vehicle sub-type,
      // don't load the doc (avoids pulling hundreds of unrelated NPCs). Missing type ⇒ fall through & load.
      if (entry.type && entry.type !== "cp2020-augmented.vehicle") continue;
      let doc;
      try { doc = await pack.getDocument(entry._id); } catch (e) { out.discovery.packErrors.push({ pack: pack.collection, error: `getDocument ${entry._id}: ${String(e?.message || e)}` }); continue; }
      if (doc?.type === "cp2020-augmented.vehicle" && doc?.system?.isACPA) packAcpas.push({ doc, pack: pack.collection });
    }
  }

  // De-dup by uuid (world uuids never collide with compendium uuids; guards against a pack yielding a dup).
  const seen = new Set();
  const targets = [];
  for (const a of worldAcpas) { if (seen.has(a.uuid)) continue; seen.add(a.uuid); targets.push({ kind: "world", actor: a, name: a.name, source: "world" }); }
  for (const { doc, pack } of packAcpas) { if (seen.has(doc.uuid)) continue; seen.add(doc.uuid); targets.push({ kind: "pack", actor: doc, name: doc.name, source: "pack:" + pack }); }

  out.discovery.worldCount = worldAcpas.length;
  out.discovery.packCount = packAcpas.length;
  out.discovery.total = targets.length;
  out.discovery.list = targets.map(t => ({ name: t.name, source: t.source }));

  // ── Per-target assertions ──
  for (const t of targets) {
    const res = { name: t.name, source: t.source, kind: t.kind };
    try {
      Object.assign(res, assess(t.actor.system));
      res.threw = false;
    } catch (e) { res.threw = true; res.error = String(e?.message || e); }

    if (t.kind === "world" && !res.threw) {
      // Sheet render: root exists + no raw CYBERPUNK. i18n key leaks in the visible text, then close.
      try {
        await t.actor.sheet.render(true);
        await sleep(700);
        const sheet = t.actor.sheet;
        const root = sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
        res.sheetRoot = !!root;
        const txt = root?.textContent || "";
        res.rawKeyLeak = txt.includes("CYBERPUNK.");
        if (res.rawKeyLeak) { const i = txt.indexOf("CYBERPUNK."); res.leakSnippet = txt.slice(Math.max(0, i - 20), i + 40).replace(/\s+/g, " "); }
        await sheet.close().catch(() => {});
        await sleep(150);
      } catch (e) { res.sheetError = String(e?.message || e); res.sheetRoot = false; }
    } else if (t.kind === "pack") {
      res.sheetRoot = "n/a";
    }

    res.pass = !res.threw && res.allFinite && res.destroyedIsBool && res.destroyedOkForPristine && res.combatModelIsString
      && (t.kind === "pack" || (res.sheetRoot === true && res.rawKeyLeak === false && !res.sheetError));
    out.results.push(res);
  }

  return out;
});

// ── Report ──
console.log("\n===== ACPA seeded-load rig check =====");
console.log(`  Actor compendiums scanned: ${r.discovery.actorPacks.length ? r.discovery.actorPacks.join(", ") : "(none)"}`);
if (r.discovery.packErrors.length) for (const e of r.discovery.packErrors) console.log(`  ⚠ pack error [${e.pack}]: ${e.error}`);
console.log(`  discovery: world=${r.discovery.worldCount} pack=${r.discovery.packCount} → ${r.discovery.total} unique ACPA suit(s)`);
for (const d of r.discovery.list) console.log(`    • "${d.name}"  [${d.source}]`);

const fmtFinite = (f) => Object.entries(f).map(([k, o]) => `${k}=${o.v}${o.finite ? "" : "✗NOT-FINITE"}`).join("  ");

if (r.discovery.total === 0) {
  console.log("\n  NO SEEDED ACPAs found in the world or any Actor compendium.");
  console.log("  → This rig check is MOOT (nothing real to load); the synthetic keepers");
  console.log("    cp2020-augmented-acpa-fnff.mjs + -acpa-toggle-gesture.mjs already cover the derivations.");
  console.log("  page errors:", errors.length ? errors.slice(0, 6) : "none");
  const pass = errors.length === 0;
  console.log("\n  RESULT: " + (pass ? "PASS ✅ — no seeded ACPAs (moot, not a failure)" : "FAIL ❌ — page errors during discovery"));
  await b.close();
  process.exit(pass ? 0 : 1);
}

console.log("\n  --- per-suit assertions ---");
for (const res of r.results) {
  if (res.threw) { console.log(`  ❌ [${res.source}] "${res.name}" — THREW reading system: ${res.error}`); continue; }
  const dstate = `destroyed=${res.destroyed}${res.destroyedIsBool ? "" : "(NOT-BOOL)"} ${res.pristine ? "pristine" : "damaged"}${res.pristine && res.destroyed !== false ? " ⛔DESTROYED-BUG" : ""}`;
  const mstate = `model=${JSON.stringify(res.acpaCombatModel)}${res.combatModelIsString ? "" : "(NOT-STRING)"}`;
  const sstate = res.kind === "pack"
    ? "sheet=n/a(pack doc)"
    : `sheet:root=${res.sheetRoot ? "yes" : "NO"} rawKeyLeak=${res.rawKeyLeak ? ("YES " + JSON.stringify(res.leakSnippet)) : "no"}${res.sheetError ? (" ERR:" + res.sheetError) : ""}`;
  console.log(`  ${res.pass ? "✅" : "❌"} [${res.source}] "${res.name}"`);
  console.log(`       finite: ${fmtFinite(res.fields)}`);
  console.log(`       ${dstate}  ·  ${mstate}  ·  ${sstate}`);
}

const failed = r.results.filter(x => !x.pass);
const pass = failed.length === 0 && errors.length === 0;
console.log("\n  page errors:", errors.length ? errors.slice(0, 6) : "none");
console.log("\n  RESULT: " + (pass
  ? `PASS ✅ — ${r.results.length}/${r.results.length} seeded ACPA suit(s) load, derive & render clean`
  : `FAIL ❌ — failed: ${failed.map(f => `"${f.name}"`).join(", ") || "(none)"}${errors.length ? ` · page errors: ${errors.length}` : ""}`));
await b.close();
process.exit(pass ? 0 : 1);
