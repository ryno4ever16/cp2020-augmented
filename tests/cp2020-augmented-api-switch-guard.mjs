/**
 * Host-helper switch: which side wins when the base system publishes its own copy of a helper.
 * :30004 (official 1.1.1 + module).
 *
 * module/system-api.js apiHelper wraps a dozen helpers so the module PREFERS the base system's
 * version (game.cyberpunk.api.<group>.<name>) and falls back to its own. That is right for the
 * helpers whose two copies mean the same thing. It is wrong for the three whose module copy is a
 * deliberate SUPERSET — the base's version resolves under the same name with the same arity, so a
 * base that starts publishing the api silently takes over and the extra rules simply stop applying:
 *
 *   dice.rollLocation          — module copy honours the alternate location table and re-rolls a hit
 *                                on a limb that is no longer there (reporting rerolledFrom).
 *   lookups.getMartialActionBonus — module copy takes a third argument, the per-skill bonus map that
 *                                backs custom styles and per-skill overrides. A two-argument host
 *                                copy accepts the call and drops it.
 *   lookups.isFnff2Enabled     — module copy resolves the setting without throwing when the key is
 *                                not registered; the base copy reads it unguarded.
 *
 * The installed 1.1.1 base publishes no api at all, so this drives the future shape directly:
 * a stub api is installed on the page, the wrappers are called, and the stub is removed again.
 *
 *   FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node tests/cp2020-augmented-api-switch-guard.mjs
 */
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
  const out = { err: null };
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const hadApi = "api" in (game.cyberpunk ?? {});
  try {
    if (!canvas?.scene) { const sc = game.scenes.contents[0]; if (sc) { await sc.activate(); await sleep(1500); } }

    const U = await import("/modules/cp2020-augmented/module/utils.js");
    const L = await import("/modules/cp2020-augmented/module/lookups.js");
    const SCOPE = "cp2020-augmented";

    // Baseline: the installed base publishes nothing, so today every wrapper uses its own copy.
    out.baseHasNoApi = game.cyberpunk?.api === undefined;

    for (const a of game.actors.filter(a => a.name.startsWith("__PW__Switch"))) await a.delete().catch(() => {});
    const actor = await Actor.create({ name: "__PW__Switch", type: "character" });
    await sleep(150);

    // ── (A) NO api present: the pre-existing typeof guard already degrades to the local copy ──────
    game.cyberpunk.api = {};                                  // published, but empty
    out.emptyApiNoThrow = true;
    try {
      const loc = await U.rollLocation(actor, null);
      out.emptyApiLocation = typeof loc?.areaHit === "string" && loc.areaHit.length > 0;
    } catch (e) { out.emptyApiNoThrow = false; out.emptyApiErr = e?.message; }

    // ── (B) a host copy IS published: the three superset helpers must keep the module's rules ─────
    // The stubs stand in for a future base: same names, same call shapes, base semantics.
    game.cyberpunk.api = {
      i18n:    { localize: () => "__HOST_I18N__" },           // a helper whose copies agree — host wins
      dice:    { rollLocation: async () => ({ roll: null, areaHit: "__HOST_LOCATION__" }) },
      lookups: {
        // The base's own two-argument shape: it accepts the third argument and ignores it.
        getMartialActionBonus: (martialKey, actionKey) => 0,
        // The base's own unguarded read — throws when the key is not registered.
        isFnff2Enabled: () => { throw new Error("setting not registered"); },
      },
    };

    // A helper the module borrows on purpose still borrows — the switch is not turned off wholesale.
    out.borrowedHelperStillHostWins = U.localize("Cancel") === "__HOST_I18N__";

    // rollLocation keeps the module's table + gone-limb rules.
    const loc = await U.rollLocation(actor, null);
    out.locationFromModule = loc?.areaHit !== "__HOST_LOCATION__";
    out.locationIsReal = typeof loc?.areaHit === "string" && loc.areaHit.length > 0;
    // The aimed branch, which the module copy answers tolerantly for an area the table lacks.
    const aimed = await U.rollLocation(actor, "Head");
    out.aimedFromModule = aimed?.areaHit === "Head";

    // getMartialActionBonus keeps the third argument (the per-skill map) that a host copy drops.
    out.perSkillBonus = L.getMartialActionBonus("__PW__NoSuchStyle", "Strike", { Strike: 7 });
    // Negative case: no per-skill map, no built-in table entry → still 0, not an invented number.
    out.perSkillAbsent = L.getMartialActionBonus("__PW__NoSuchStyle", "Strike", null);
    // Built-in table still answers from the module's own copy.
    out.builtinBonus = L.getMartialActionBonus("Martial Arts: Aikido", "Dodge", null);

    // isFnff2Enabled resolves to a boolean instead of propagating the host copy's throw.
    out.fnff2Threw = false;
    try { out.fnff2Value = L.isFnff2Enabled(); }
    catch (e) { out.fnff2Threw = true; out.fnff2Err = e?.message; }
    out.fnff2IsBoolean = typeof out.fnff2Value === "boolean";

    // ── (C) the unlock path: a base that DECLARES the capability does get to answer ────────────────
    // Same stubs, plus the feature declaration the guard reads. This is what makes the guard a guard
    // rather than a permanent pin — the module stands aside the moment the base says it owns the rules.
    game.cyberpunk.api.features = { hitLocationRules: true, martial: true };
    const declared = await U.rollLocation(actor, null);
    out.declaredHostWinsLocation = declared?.areaHit === "__HOST_LOCATION__";
    out.declaredHostWinsBonus = L.getMartialActionBonus("Martial Arts: Aikido", "Dodge", { Dodge: 7 }) === 0;

    await actor.delete().catch(() => {});
  } catch (e) { out.err = e?.message || String(e); }
  finally { if (!hadApi) { try { delete game.cyberpunk.api; } catch {} } }
  out.stubRemoved = game.cyberpunk?.api === undefined;
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["baseline: the installed base publishes no helper api", r.baseHasNoApi === true],
  ["an empty published api degrades to the module's copy without throwing", r.emptyApiNoThrow === true && r.emptyApiLocation === true],
  ["a helper the module borrows on purpose still resolves to the host's copy", r.borrowedHelperStillHostWins === true],
  ["location roll keeps the module's table rules when a host copy is published", r.locationFromModule === true && r.locationIsReal === true],
  ["aimed location keeps the module's tolerant branch", r.aimedFromModule === true],
  ["per-skill bonus map is still honoured (7, not the host copy's 0)", r.perSkillBonus === 7],
  ["negative case: no per-skill map and no table entry → 0", r.perSkillAbsent === 0],
  ["built-in table still answers from the module's copy (Aikido Dodge 3)", r.builtinBonus === 3],
  ["the ruleset toggle resolves to a boolean instead of propagating a host throw", r.fnff2Threw === false && r.fnff2IsBoolean === true],
  ["unlock path: a base that DECLARES the capability does answer for both helpers", r.declaredHostWinsLocation === true && r.declaredHostWinsBonus === true],
  ["stub api removed, rig left as found", r.stubRemoved === true],
  ["no unexpected error in the probe", !r.err],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
