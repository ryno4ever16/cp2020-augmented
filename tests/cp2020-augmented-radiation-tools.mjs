/** R3b — Radiation GM TOOLS (Deep Space). Asserts the deterministic surface of the last radiation phase:
 *  the long-term effects table + roller (Deep Space p.22, user-confirmed values), the long-term reference
 *  CARD, the GM-only actor-sheet radiation PANEL (positive + negative render), the clear/cure controls, the
 *  environmental (cosmic/flare) dosing, and the scene-control tool registration (GM+enabled vs off). Runs on
 *  :30004 (1.1.1 + module). Mirrors cp2020-augmented-radiation.mjs. */
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
  const RAD = await import("/modules/cp2020-augmented/module/radiation/radiation.js");
  const TOOLS = await import("/modules/cp2020-augmented/module/radiation/radiation-tools.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const SCOPE = "cp2020-augmented";
  const LOCS = ["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"];
  const covAllFalse = Object.fromEntries(LOCS.map(k => [k, false]));
  const radsuit = (sp) => ({ name: "__PW__Radsuit", type: "armor",
    system: { equipped: true, armorType: "", coverage: covAllFalse, mechTypedSP: { type: "radiation", sp } } });

  // No radiationEnabled world setting any more — the subsystem is inert until a GM engages it, so there is
  // nothing to toggle. The GM tools show for any GM; the sheet panel shows only when the actor is irradiated.
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__RadT"))) await a.delete().catch(() => {});

  try {
    // ── (0) PURE long-term helpers (Deep Space p.22, user-confirmed) ───────────────
    const keys = (h) => RAD.longTermEffectsFor(h).map(r => r.key);
    out.lt = {
      at50: keys(50).length,                              // 0 (onset starts at 100)
      at99: keys(99).length,                              // 0
      at100: keys(100).join(","),                         // Mutations
      at300: keys(300).join(","),                         // Mutations,MinorCancers,Cataracts,Stillbirths
      at450: keys(450).length,                            // 7
      at800: keys(800).length,                            // 9 (all)
    };
    out.sterility = [449, 450, 500, 550, 600, 650, 750, 800].map(h => RAD.sterilityChancePct(h)).join(",");
    // 0,10,25,50,90,99,100,100
    out.leuk = {
      pre: RAD.leukemiaOdds(399),                          // null
      at400: RAD.leukemiaOdds(400)?.denom,                 // 300
      at450: RAD.leukemiaOdds(450)?.denom,                 // 150
      at500: RAD.leukemiaOdds(500)?.denom,                 // 75
    };
    out.offspring = [1, 3, 5, 10].map(n => RAD.offspringResultFor(n).key).join(",");
    // Favorable,Harmless,Deformed,Stillbirth

    // ── (1) LONG-TERM CARD posts + lists the right effects + rolls offspring ───────
    const ltActor = await Actor.create({ name: "__PW__RadTLong", type: "character" });
    await ltActor.setFlag(SCOPE, "radHistory", 500);
    const before = new Set(game.messages.map(m => m.id));
    await RAD.postLongTermCard(ltActor);
    await sleep(300);
    const card = game.messages.find(m => !before.has(m.id));
    const html = card?.content || "";
    out.card = {
      posted: !!card,
      hasSterility: /Sterility/.test(html),
      sterility25: /25% chance of permanent sterility/.test(html),   // pct at 500
      hasLeukemia: /Leukemia/.test(html),
      hasOffspring: /Offspring Mutation \(1d10\)/.test(html),        // history >= 100 → rolled
      noSevere: !/Severe Cancers/.test(html),                        // 600 not reached at 500
    };

    // ── (2) clear / cure controls (via the exported API the panel buttons call) ────
    const cc = await Actor.create({ name: "__PW__RadTClear", type: "character" });
    await RAD.applyRadiationDose(cc, 500, { perTurn: false, announce: false });   // band 401 → perm markers
    const expBefore = RAD.actorExposure(cc), histBefore = RAD.actorHistory(cc), mkBefore = RAD.radMarkersFor(cc).length;
    await RAD.clearExposure(cc);
    const expAfter = RAD.actorExposure(cc), histAfter = RAD.actorHistory(cc);
    const permBefore = RAD.radMarkersFor(cc).filter(m => (Number(m.turnsLeft) || 0) <= 0).length;
    await RAD.cureRadiation(cc);
    const permAfter = RAD.radMarkersFor(cc).filter(m => (Number(m.turnsLeft) || 0) <= 0).length;
    out.clearCure = {
      expBefore, histBefore, mkBefore,                    // 500, 500, >=1
      expAfterClear: expAfter, histKept: histAfter,       // 0, 500  (history monotonic)
      permBefore, permAfterCure: permAfter,               // >=1 → 0
    };

    // ── (3) environmental dosing (cosmic + flare), applied raw ─────────────────────
    const env = await Actor.create({ name: "__PW__RadTEnv", type: "character" });
    await TOOLS.applyEnvironmentalRadiation([env], { mode: "flare", hours: 3, flareStrength: 3 });   // 9d6 rads > 0
    out.envFlareExposure = RAD.actorExposure(env);        // > 0
    const cosmicActor = await Actor.create({ name: "__PW__RadTCosmic", type: "character" });
    await TOOLS.applyEnvironmentalRadiation([cosmicActor], { mode: "cosmic", hours: 100 });           // ~0.05-0.35 rads
    out.envCosmicExposure = RAD.actorExposure(cosmicActor);   // > 0 (small)

    // ── (4) scene-control tools: exactly the two dose tools; zone placement is native ───
    // Placing a zone is no longer a module scene-control tool — a zone is a native Region carrying the
    // "Radiation Zone" RegionBehavior, drawn with Foundry's own region tools. The old `cp-rad-zone` leg
    // (and its CYBERPUNK.RadToolPlaceZone title) tested a control that no longer exists; its
    // current-mechanism equivalent is the behavior TYPE being registered and labelled, asserted below.
    const mkControls = () => ({ tokens: { tools: {} } });
    const cEnabled = mkControls();
    const addedEnabled = TOOLS.addRadiationTools(cEnabled);
    const RZ_BEHAVIOR = "cp2020-augmented.radiationZone";
    const resolves = (key) => !!key && game.i18n.localize(key) !== key;
    out.tools = {
      addedEnabled,                                        // true (any GM — no toggle)
      toolNames: Object.keys(cEnabled.tokens.tools).sort().join(","),   // cp-rad-dose,cp-rad-env
      doseTitle: cEnabled.tokens.tools["cp-rad-dose"]?.title,           // CYBERPUNK.RadToolApplyDose
      envTitle: cEnabled.tokens.tools["cp-rad-env"]?.title,             // CYBERPUNK.RadToolEnvironmental
      titlesResolve: resolves(cEnabled.tokens.tools["cp-rad-dose"]?.title)
        && resolves(cEnabled.tokens.tools["cp-rad-env"]?.title),
      // The mechanism that REPLACED the placement tool.
      behaviorRegistered: typeof CONFIG.RegionBehavior?.dataModels?.[RZ_BEHAVIOR] === "function",
      behaviorLabel: game.i18n.localize(`TYPES.RegionBehavior.${RZ_BEHAVIOR}`),   // "Radiation Zone"
      behaviorFields: Object.keys(CONFIG.RegionBehavior?.dataModels?.[RZ_BEHAVIOR]?.defineSchema?.() ?? {}).sort().join(","),
    };
    // NEGATIVE: a non-GM gets no tools at all. `isGM` is a prototype getter, so shadow it with an own
    // property for the call and DELETE the shadow afterwards — restoring it by value would leave a frozen
    // own property masking the real getter for the rest of the session.
    out.tools.addedForNonGM = (() => {
      try {
        Object.defineProperty(game.user, "isGM", { value: false, configurable: true });
        return TOOLS.addRadiationTools(mkControls());
      } finally {
        delete game.user.isGM;
      }
    })();
    out.tools.isGMRestored = game.user.isGM === true;

    // ── (5) actor-sheet radiation PANEL: shown for a GM when the actor is irradiated ─────
    const ps = await Actor.create({ name: "__PW__RadTPanel", type: "character" });
    await ps.createEmbeddedDocuments("Item", [radsuit(6)]);
    await ps.setFlag(SCOPE, "radExposure", 42);
    await ps.setFlag(SCOPE, "radHistory", 130);
    await ps.sheet.render(true);
    await sleep(500);
    // Navigate to the combat tab so the panel part is in the DOM.
    const root = ps.sheet.element;
    root?.querySelector?.('.sheet-tabs [data-tab="combat"], a[data-tab="combat"], .item[data-tab="combat"]')?.click?.();
    await sleep(300);
    const panel = root?.querySelector?.(".cp-radiation-panel");
    const readouts = panel ? [...panel.querySelectorAll(".cp-rad-readout")].map(e => e.textContent.trim()) : [];
    out.panel = {
      present: !!panel,
      showsExposure: readouts.includes("42"),
      showsHistory: readouts.includes("130"),
      showsRsp: readouts.includes("6"),
      hasApplyBtn: !!panel?.querySelector(".cp-rad-apply"),
      hasClearBtn: !!panel?.querySelector(".cp-rad-clear"),
      hasCureBtn: !!panel?.querySelector(".cp-rad-cure"),
      hasLongTermBtn: !!panel?.querySelector(".cp-rad-longterm"),
      noRawKey: !/CYBERPUNK\./.test(panel?.textContent || ""),
    };
    // (5b) REAL GESTURE: clicking the panel Apply button opens the apply-dose dialog (proves the
    // _cpActivateRadiationControls listener → openApplyDoseDialog wiring, not just button presence).
    panel?.querySelector(".cp-rad-apply")?.click();
    let dlg = null;
    for (let i = 0; i < 25 && !dlg; i++) { await sleep(100); dlg = document.querySelector(".cp-rad-dialog"); }
    out.applyGesture = { opened: !!dlg, hasRadsField: !!dlg?.querySelector(".cp-rad-rads") };
    const dlgApp = [...foundry.applications.instances.values()].find(a => a.element?.querySelector?.(".cp-rad-dialog"));
    await dlgApp?.close?.();
    await sleep(200);

    // (5c) NEGATIVE (the new gate): strip all radiation state → the panel must disappear (no world toggle).
    await ps.unsetFlag(SCOPE, "radState");
    await ps.unsetFlag(SCOPE, "radExposure");
    await ps.unsetFlag(SCOPE, "radHistory");
    await ps.sheet.render(true);
    await sleep(400);
    out.panelHiddenNoRad = !ps.sheet.element?.querySelector?.(".cp-radiation-panel");
    await ps.sheet.close();

    // cleanup
    for (const a of [ltActor, cc, env, cosmicActor, ps]) await a.delete().catch(() => {});
  } catch (e) {
    out.THROWN = String(e?.stack || e);
  }
  return out;
});

// ── Assertions ────────────────────────────────────────────────────────────────────
const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });

if (r.THROWN) checks.push({ name: "no throw", ok: false, got: r.THROWN });

// (0) pure
eq("lt onset <100 empty", [r.lt?.at50, r.lt?.at99], [0, 0]);
eq("lt at100 = Mutations", r.lt?.at100, "Mutations");
eq("lt at300 group", r.lt?.at300, "Mutations,MinorCancers,Cataracts,Stillbirths");
eq("lt at450 = 7 rows", r.lt?.at450, 7);
eq("lt at800 = all 9", r.lt?.at800, 9);
eq("sterility step fn", r.sterility, "0,10,25,50,90,99,100,100");
ok("leukemia <400 null", r.leuk?.pre === null, r.leuk?.pre);
eq("leukemia denom 400/450/500", [r.leuk?.at400, r.leuk?.at450, r.leuk?.at500], [300, 150, 75]);
eq("offspring bands", r.offspring, "Favorable,Harmless,Deformed,Stillbirth");

// (1) card
ok("card posted", r.card?.posted, r.card);
ok("card lists Sterility", r.card?.hasSterility, r.card);
ok("card sterility 25% @500", r.card?.sterility25, r.card);
ok("card lists Leukemia", r.card?.hasLeukemia, r.card);
ok("card rolls offspring", r.card?.hasOffspring, r.card);
ok("card omits Severe @500", r.card?.noSevere, r.card);

// (2) clear/cure
eq("dose set exposure/history 500", [r.clearCure?.expBefore, r.clearCure?.histBefore], [500, 500]);
ok("markers created", r.clearCure?.mkBefore >= 1, r.clearCure?.mkBefore);
eq("clear resets exposure, keeps history", [r.clearCure?.expAfterClear, r.clearCure?.histKept], [0, 500]);
ok("cure removes perm markers", r.clearCure?.permBefore >= 1 && r.clearCure?.permAfterCure === 0, r.clearCure);

// (3) environmental
ok("flare env dose > 0", r.envFlareExposure > 0, r.envFlareExposure);
ok("cosmic env dose > 0", r.envCosmicExposure > 0, r.envCosmicExposure);

// (4) scene tools + the native zone behavior that replaced the placement tool
ok("tools added (any GM)", r.tools?.addedEnabled === true, r.tools);
eq("exactly the two dose tools (no placement tool)", r.tools?.toolNames, "cp-rad-dose,cp-rad-env");
eq("apply-dose tool title key", r.tools?.doseTitle, "CYBERPUNK.RadToolApplyDose");
eq("environmental tool title key", r.tools?.envTitle, "CYBERPUNK.RadToolEnvironmental");
ok("both tool titles resolve (no raw key in the control bar)", r.tools?.titlesResolve, r.tools);
ok("no tools for a non-GM", r.tools?.addedForNonGM === false, r.tools);
ok("isGM shadow removed after the negative case", r.tools?.isGMRestored === true, r.tools);
ok("zone behavior type registered", r.tools?.behaviorRegistered === true, r.tools);
eq("zone behavior label resolves", r.tools?.behaviorLabel, "Radiation Zone");
eq("zone behavior fields", r.tools?.behaviorFields, "radsFormula,sourceLabel");

// (5) panel
ok("panel present (GM + irradiated actor)", r.panel?.present, r.panel);
ok("panel shows exposure 42", r.panel?.showsExposure, r.panel);
ok("panel shows history 130", r.panel?.showsHistory, r.panel);
ok("panel shows RSP 6", r.panel?.showsRsp, r.panel);
ok("panel has apply/longterm/clear/cure", r.panel?.hasApplyBtn && r.panel?.hasLongTermBtn && r.panel?.hasClearBtn && r.panel?.hasCureBtn, r.panel);
ok("panel no raw CYBERPUNK. key", r.panel?.noRawKey, r.panel);
ok("panel Apply button opens dialog (gesture)", r.applyGesture?.opened && r.applyGesture?.hasRadsField, r.applyGesture);
ok("panel hidden when actor has no radiation", r.panelHiddenNoRad, r.panelHiddenNoRad);

// console
ok("0 console errors", errors.length === 0, errors.slice(0, 6));

const pass = checks.filter(c => c.ok).length, fail = checks.length - pass;
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "  got=" + JSON.stringify(c.got) + (c.want !== undefined ? " want=" + JSON.stringify(c.want) : "")}`);
console.log(`\nRESULT: ${fail === 0 ? "ALL GREEN" : "FAIL"}  ${pass}/${checks.length}`);
if (errors.length) console.log("ERRORS:\n" + errors.slice(0, 8).join("\n"));
await b.close();
process.exit(fail === 0 ? 0 : 1);
