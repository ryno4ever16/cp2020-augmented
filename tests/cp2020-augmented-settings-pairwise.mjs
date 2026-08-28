/**
 * SETTINGS PAIRWISE SMOKE — every two-setting COMBINATION, driven against the live client.
 *
 * WHAT THIS IS FOR. The module registers dozens of independent world switches. Each one is exercised on
 * its own by the suite that owns its feature; almost none of them are ever exercised TOGETHER. The
 * defect class that lives in that gap is the interaction one — a panel that only fails to draw when its
 * master is off and a neighbour is on, a code path that only reaches an undefined read when two
 * unrelated gates disagree. Exhausting the switch space is not available (45 binary switches is 2^45
 * worlds), so this suite covers every PAIR instead: `tools/pairwise-gen.mjs` builds a covering array in
 * which all four value combinations of every two switches appear together in some row, and each row is
 * a real world the client is put into and smoke-driven.
 *
 * ⭐ THE ROWS ASSERT OUTCOMES, NOT PRESENCE. A row that only checked "a window appeared" would certify
 * nothing, so each row reads back three things whose value is DETERMINED by the row:
 *   · the character sheet's Services tab exists exactly when `shoppingEnabled` is on for that row
 *     (actor-sheet.js:132 → actor-sheet.hbs:35), and is absent when it is off;
 *   · the shop window OPENS when `shoppingEnabled` is on, and when it is off refuses LOUDLY — a warn
 *     notification and no window (catalog.js:1831), never a half-opened one;
 *   · on the System Settings page, every master's sub-settings carry the disabled marker exactly when
 *     that master is off in this row (settings-sections.js MASTERS → `.cp-mm-disabled`), checked for
 *     all nine masters the matrix moves.
 * A fired-shot payload is emitted into each row as well, and the row fails on any uncaught error or any
 * module-attributed console error raised while that row was live.
 *
 * ⛔ EXCLUSIONS — settings deliberately kept OUT of the matrix, and why. No silent caps: the suite's
 * first section asserts that the live registry contains exactly ALLOWED ∪ EXCLUDED, so a setting added
 * later cannot slip through unclassified.
 *
 *   mechTokenWrites      its onChange runs reconcileLightTokenWrites + reconcileVisionTokenWrites
 *                        (settings.js:145-149), which WRITE live TokenDocuments across the world's
 *                        scenes — restoring or re-applying light emission and sight overrides. Flipping
 *                        it 31 times would rewrite every affected token in the rig world 31 times.
 *   hideScrapedPacks     its onChange runs applyScrapedPackVisibility (settings.js:186), which calls
 *                        `pack.configure({ownership})` on two base-system packs — a write to the core
 *                        `compendiumConfiguration` world setting — and stamps/clears the companion
 *                        `hideScrapedPacksPrior` map. Two document-scope writes per flip.
 *   automationNoticeHide these four are config:false INTERNAL STATE records, not feature switches:
 *   presetFirstRunDone   what the GM last dismissed, whether first-run has happened, whether the
 *   ipNeglectMuted       IP-neglect nudge is muted or already fired. Flipping them does not change any
 *   ipNeglectNudged      behaviour a smoke probe can observe; it only rewrites bookkeeping, and
 *                        restoring them wrong would re-show dismissed notices to the user.
 *
 *   civilianSheetMigrated     ⛔ these five are MIGRATION STAMPS, and they are the most dangerous
 *   fleshLimbStatusMigrated   thing in the registry to flip. Each is a "this one-time world
 *   radZonesMigrated          sweep has run" record for a migration that WRITES DOCUMENTS, and each is
 *                        read as the guard that stops the sweep running again. Turning one OFF re-arms
 *                        its sweep; turning one ON suppresses a sweep that has not run. Verified at the
 *                        registrar in each case:
 *                          · civilianSheetMigrated — registered in `registerCivilianSheetMigration`
 *                            (vehicle/vehicle-deploy-request.js:232), whose `ready` hook then updates
 *                            EVERY vehicle actor in the world with `system.isMMVehicle = true`. Re-run
 *                            on a world that has since gained civilian vehicles stamps them onto the
 *                            combat sheet — it cannot tell them apart, which is exactly why it is
 *                            one-time.
 *                          · fleshLimbStatusMigrated — registered inside `migrateFleshLimbStatus`
 *                            (cp2020-augmented.js), which moves limb-status flags between two
 *                            namespaces across every world actor AND every unlinked scene-token actor
 *                            delta, with `deleteFieldUpdate` removals.
 *                          · radZonesMigrated — registered in `registerRadiationZones`
 *                            (radiation/radiation-zones.js) and read in `migrateLegacyRadZones`, which
 *                            walks every scene's region collection and creates RegionBehavior documents.
 *                          · fleshLimbStatusMigratedCompleted / radZonesMigratedCompleted — the
 *                            COMPANION stamp each of those two passes gained: the first stamp records
 *                            that the sweep was ATTEMPTED (written before it runs, to bound the first
 *                            attempt's cost), this one records that it FINISHED (written after). A pair
 *                            reading attempted-but-not-completed is what makes the pass re-run itself at
 *                            the next load, so clearing one of these ARMS a sweep just as surely as
 *                            clearing its partner does.
 *                        The two limb/rad passes write their first stamp BEFORE their sweep
 *                        (cp2020-augmented.js "TWO STAMPS: ONE BOUNDS THE ATTEMPT, THE OTHER RECORDS
 *                        THE FINISH"; the same block in radiation-zones.js), so the snapshot/restore
 *                        this suite relies on is not a clean undo for them: restoring either stamp to
 *                        `false` would leave the world armed to sweep again on the next boot. They are
 *                        also not feature switches — no observable behaviour hangs on them once their
 *                        sweep has run — so the matrix loses nothing by leaving them out.
 *
 * ⚠ TWO INCLUDED SETTINGS CARRY A NOTE (included, but the caveat is stated rather than hidden):
 *   combatAutomationEnabled  is registered `requiresReload: true`. Set programmatically it changes the
 *                        value and every per-event read of it, but the hooks registered at boot stay
 *                        registered — so a row that turns it off is testing the READ gate, not a fresh
 *                        boot. That is still the interaction surface worth covering; it is simply not a
 *                        substitute for a reload test.
 *   faceTargetOnFire     is the one rail setting whose ON state makes the emitted shot WRITE something
 *                        (the shooter token's rotation, settings.js:922). The write is contained: the
 *                        only token this suite fires from is its own `__PW__` fixture, on its own
 *                        `__PW__` scene, and both are deleted at teardown.
 *
 * CONTAINMENT. Every document this suite creates is a `__PW__` fixture on a `__PW__` scene of its own,
 * so any region, template or effect a row's combination produces lands there and leaves with the scene.
 * The setting snapshot is taken BEFORE the first row and restored in a `finally` that runs on any exit
 * path, including a thrown row; the restore is then asserted key by key against the snapshot.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=<pw> node tests/cp2020-augmented-settings-pairwise.mjs
 *      node tests/cp2020-augmented-settings-pairwise.mjs --rows 6     (first N rows only, for iteration)
 */
import { chromium } from "@playwright/test";
import { pairwiseBinary, uncoveredPairs, matrixReport } from "../tools/pairwise-gen.mjs";
import { GOLDEN_MISSING, GOLDEN_PATH, installGoldenHydrator } from "./golden-payload.mjs";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";
const ROW_LIMIT = (() => {
  const i = process.argv.indexOf("--rows");
  return i > 0 ? Math.max(1, Number(process.argv[i + 1]) || 0) : 0;
})();

/** The world-scoped BOOLEAN switches the matrix moves. */
const ALLOWED = [
  "combatAutomationEnabled",
  "mechRoundTickAutomation",
  "mechDocumentAutomation",
  "cyberlimbRepairGmOnly",
  "damageAblation",
  "headHitDoubling",
  "limbLossEnabled",
  "rerollGoneLimbLocation",
  "suppressiveFireSaves",
  "autoDeathSavePerTurn",
  "autoSaveRePrompt",
  "activeDodgeParryEnabled",
  "aimTrackingEnabled",
  "waitForTurnEnabled",
  "gasGrenadeCloudEnabled",
  "gasCloudAutoMove",
  "taserCumPenaltyEnabled",
  "acidArmorDotEnabled",
  "fireDotEnabled",
  "multiActionPenaltyEnabled",
  "multiActionAutoTrack",
  "restrictMovementOncePerTurn",
  "shotgunSpreadEnabled",
  "explosivesEnabled",
  "areaEffectOcclusion",
  "explosivesDetailed",
  "hitLocationCoreDisplay",
  "vehicleControlEnabled",
  "vehicleDamageEnabled",
  "mmEnabled",
  "vehicleArmorDamageEnabled",
  "vehicleMoraleEnabled",
  "fnff2Enabled",
  "specialMeleeEffectsEnabled",
  "autoRangefinding",
  "ipRawTracking",
  "ipHideUI",
  "shoppingEnabled",
  "playersCanShop",
  "shopAllowHomebrew",
  "playersCanBuyAmmo",
  "npcGenEnabled",
  "combatFxEnabled",
  "faceTargetOnFire",
  // ⏪ "goreEnabled" stood here until 2026-08-28: the setting was retired with the element it switched.
];

/** Kept out of the matrix, each with the reason the header states at length. */
const EXCLUDED = {
  mechTokenWrites: "onChange rewrites live TokenDocuments (light + vision reconcile)",
  hideScrapedPacks: "onChange writes core compendium ownership + the prior-ownership map",
  automationNoticeHide: "config:false internal state record, not a feature switch",
  presetFirstRunDone: "config:false internal state record, not a feature switch",
  ipNeglectMuted: "config:false internal state record, not a feature switch",
  ipNeglectNudged: "config:false internal state record, not a feature switch",
  civilianSheetMigrated: "migration stamps: flipping re-fires or suppresses one-time world sweeps (document writes); restoring wrong re-runs a migration",
  fleshLimbStatusMigrated: "migration stamps: flipping re-fires or suppresses one-time world sweeps (document writes); restoring wrong re-runs a migration",
  radZonesMigrated: "migration stamps: flipping re-fires or suppresses one-time world sweeps (document writes); restoring wrong re-runs a migration",
  fleshLimbStatusMigratedCompleted: "migration stamps: the companion 'sweep finished' record; clearing it makes the next load re-run that sweep",
  radZonesMigratedCompleted: "migration stamps: the companion 'sweep finished' record; clearing it makes the next load re-run that sweep",
  // ⚠ Classified 2026-08-20 after §1 went red on them. They are the vehicle hull/frame sweep's stamp
  // pair (module/vehicle/vehicle-hull-migration.js), registered config:false and never added here when
  // that sweep landed — the same shape as the five stamps above, and the same reason for staying out.
  vehicleHullFramed: "migration stamps: flipping re-fires or suppresses one-time world sweeps (document writes); restoring wrong re-runs a migration",
  vehicleHullFramedCompleted: "migration stamps: the companion 'sweep finished' record; clearing it makes the next load re-run that sweep",
};

/** Master → sub-settings, mirrored from settings-sections.js MASTERS. The row asserts the greying. */
const MASTERS = {
  mmEnabled: ["vehicleRuleSystem", "vehicleArmorDamageEnabled", "vehicleMoraleEnabled", "vehicleArcEnforcement"],
  ipRawTracking: ["ipAwardModel", "ipAutoBaselineAmount", "ipThrottle", "ipSkillLockMode"],
  shoppingEnabled: ["playersCanShop", "shopBuySource", "shopAllowHomebrew", "shopShowSource"],
  npcGenEnabled: ["npcGenTokenArtFolder"],
  explosivesEnabled: ["explosivesDetailed", "areaEffectOcclusion"],
  gasGrenadeCloudEnabled: ["gasCloudAutoMove"],
  acidArmorDotEnabled: ["acidDotStackMode"],
  fireDotEnabled: ["fireDotStackMode"],
  multiActionPenaltyEnabled: ["multiActionAutoTrack"],
};

const checks = [];
const ok = (n, p, d = "") => {
  checks.push({ n, p: !!p, d: String(d) });
  console.log(`${p ? "  ok  " : "  FAIL"}  ${n}${d ? `   [${d}]` : ""}`);
};

async function joinGM(p) {
  await p.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const s = p.locator('select[name="userid"]');
  await s.waitFor({ state: "visible", timeout: 30000 });
  const us = await s.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  const u = us.find(x => /gamemaster/i.test(x.l));
  if (!u) throw new Error("no Gamemaster user on this rig");
  await s.selectOption(u.v);
  await p.locator('input[name="password"]').fill(PW);
  await Promise.all([
    p.waitForNavigation({ url: /\/game/, timeout: 45000 }).catch(() => {}),
    p.locator('button[name="join"]').click(),
  ]);
  await p.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60000 });
}

/* ── the page-side fault recorder, installed before the client boots ──────────────────────────────
 * UNCAUGHT is the hard class: a window `error` event or an unhandled promise rejection. Foundry wraps
 * hook listeners in its own try/catch and reports a listener throw through console.error instead, so
 * that channel is captured too and split by ATTRIBUTION — an entry naming this module (or carrying a
 * stack frame inside it) is this suite's business, and core's own logging is not.
 */
const RECORDER = () => {
  const rec = (globalThis.__cpFault = { uncaught: [], moduleErrors: [], otherErrors: [], warns: [] });
  const text = (args) => args.map(a => (a && a.stack) ? String(a.stack) : String(a)).join(" ");
  const mine = (s) => /cp2020-augmented/.test(s);
  window.addEventListener("error", (e) => rec.uncaught.push(String(e?.message ?? e)));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e?.reason;
    rec.uncaught.push("unhandledrejection: " + String(r?.stack ?? r?.message ?? r));
  });
  const ce = console.error.bind(console);
  const cw = console.warn.bind(console);
  console.error = (...a) => { const s = text(a); (mine(s) ? rec.moduleErrors : rec.otherErrors).push(s.slice(0, 400)); ce(...a); };
  console.warn = (...a) => { const s = text(a); if (mine(s)) rec.warns.push(s.slice(0, 300)); cw(...a); };
  globalThis.__cpFaultReset = () => { rec.uncaught.length = 0; rec.moduleErrors.length = 0; rec.otherErrors.length = 0; rec.warns.length = 0; };
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
const nodeErrors = [];
page.on("pageerror", e => nodeErrors.push(String(e.message)));
await page.addInitScript(RECORDER);
await joinGM(page);
await page.waitForTimeout(2500);

let snapshot = null;
let fixtures = null;
let rows = [];

try {
  /* ══ §1. THE REGISTRY IS FULLY CLASSIFIED ══════════════════════════════════════════════════════
   * Every world-scoped boolean the module registers is either in the matrix or in the exclusion list
   * with a stated reason. A setting added later lands in neither and reds here by name — which is what
   * keeps the exclusions from becoming a silent cap. */
  console.log("\n===== §1: the switch inventory =====");
  const live = await page.evaluate((scope) => {
    const out = [];
    for (const [id, cfg] of game.settings.settings.entries()) {
      if (!id.startsWith(`${scope}.`)) continue;
      if (cfg.scope !== "world") continue;
      if (typeof cfg.default !== "boolean") continue;
      out.push({ key: cfg.key ?? id.slice(scope.length + 1), config: cfg.config !== false, def: cfg.default });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }, SCOPE);

  const liveKeys = live.map(s => s.key);
  const classified = new Set([...ALLOWED, ...Object.keys(EXCLUDED)]);
  const unclassified = liveKeys.filter(k => !classified.has(k));
  const phantom = [...classified].filter(k => !liveKeys.includes(k));

  ok("§1 the client registers a world-scoped boolean set of the expected size",
    liveKeys.length >= 40, `${liveKeys.length} world boolean setting(s)`);
  ok("§1 every registered world boolean is either in the matrix or in the stated exclusion list",
    unclassified.length === 0,
    unclassified.length ? `UNCLASSIFIED: ${unclassified.join(", ")} — add to ALLOWED or to EXCLUDED with a reason`
                        : `${ALLOWED.length} in the matrix · ${Object.keys(EXCLUDED).length} excluded`);
  ok("§1 the matrix and the exclusion list name nothing the client does not register",
    phantom.length === 0, phantom.length ? `NOT REGISTERED: ${phantom.join(", ")}` : "none");
  ok("§1 every exclusion carries a stated reason",
    Object.values(EXCLUDED).every(r => typeof r === "string" && r.length > 10),
    Object.entries(EXCLUDED).map(([k, v]) => `${k}: ${v}`).join(" · "));

  /* ══ §2. THE COVERING ARRAY ════════════════════════════════════════════════════════════════════ */
  console.log("\n===== §2: the covering array =====");
  rows = pairwiseBinary(ALLOWED);
  const report = matrixReport(ALLOWED, rows);
  const missing = uncoveredPairs(ALLOWED, rows);
  ok("§2 the matrix covers all four value combinations of every switch pair",
    missing.length === 0,
    missing.length ? `${missing.length} combination(s) missing, e.g. ${missing[0].a}=${missing[0].aValue}/${missing[0].b}=${missing[0].bValue}`
                   : `${report.rows} row(s) covering ${report.pairsRequired} combination(s) over ${report.keys} switches`);
  ok("§2 the matrix is small enough to drive and large enough to mean something",
    rows.length >= 8 && rows.length <= 60, `${rows.length} row(s)`);
  ok("§2 no row is degenerate — each mixes on and off values",
    rows.every(r => { const on = ALLOWED.filter(k => r[k]).length; return on > 0 && on < ALLOWED.length; }),
    `on-per-row: ${report.onPerRow.join(",")}`);
  ok("§2 the golden fired-shot fixture is on disk to drive each row with",
    !GOLDEN_MISSING, GOLDEN_MISSING ? `missing at ${GOLDEN_PATH} — run cp2020-augmented-golden-payload-capture.mjs` : "present");
  if (GOLDEN_MISSING) throw new Error("no golden fixture to drive the rows with");
  await installGoldenHydrator(page);

  const driven = ROW_LIMIT ? rows.slice(0, ROW_LIMIT) : rows;
  if (ROW_LIMIT) console.log(`  (--rows ${ROW_LIMIT}: driving ${driven.length} of ${rows.length} rows)`);

  /* ══ §3. SNAPSHOT + FIXTURES ═══════════════════════════════════════════════════════════════════ */
  console.log("\n===== §3: snapshot and fixtures =====");
  snapshot = await page.evaluate(({ scope, keys }) => {
    const snap = {};
    for (const k of keys) snap[k] = game.settings.get(scope, k);
    return snap;
  }, { scope: SCOPE, keys: ALLOWED });
  ok("§3 the world's current value was read for every switch the matrix will move",
    Object.keys(snapshot).length === ALLOWED.length
    && Object.values(snapshot).every(v => typeof v === "boolean"),
    `${Object.keys(snapshot).length} value(s) recorded`);

  fixtures = await page.evaluate(async ({ scope }) => {
    for (const s of game.scenes.filter(s => s.name === "__PW__Pairwise Stage")) await s.delete().catch(() => {});
    for (const a of game.actors.filter(a => /^__PW__PAIRWISE/.test(a.name))) await a.delete().catch(() => {});

    const shooter = await Actor.create({ name: "__PW__PAIRWISE Shooter", type: "character" });
    const target = await Actor.create({ name: "__PW__PAIRWISE Target", type: "character" });
    const [gun] = await shooter.createEmbeddedDocuments("Item", [{
      name: "__PW__PAIRWISE Sidearm", type: "weapon",
      system: { ammoType: "10mm", shots: 8, shotsLeft: 8, damage: "2d6+1", range: 50 },
    }]);
    // Which canvas this client was looking at before the suite took it over. `view()` is client-local
    // (nothing about the world's active scene changes), so putting it back is a courtesy to whoever is
    // watching this client rather than a world-state repair — but a run that leaves a deleted stage on
    // screen looks like a broken rig to the next person to open it.
    const priorSceneId = canvas?.scene?.id ?? null;
    const scene = await Scene.create({ name: "__PW__Pairwise Stage", width: 2000, height: 2000, padding: 0, grid: { size: 100, distance: 2, units: "m" } });
    const made = await scene.createEmbeddedDocuments("Token", [
      { name: "__PW__PAIRWISE Shooter", actorId: shooter.id, actorLink: true, x: 300, y: 300, width: 1, height: 1 },
      { name: "__PW__PAIRWISE Target", actorId: target.id, actorLink: true, x: 900, y: 300, width: 1, height: 1 },
    ]);
    const tokById = Object.fromEntries(made.map(t => [t.name, t.id]));
    await scene.view();
    for (let i = 0; i < 80 && !(canvas?.ready && canvas.scene?.id === scene.id); i++) {
      await new Promise(r => setTimeout(r, 200));
    }
    return {
      sceneId: scene.id, priorSceneId, sceneDrawn: canvas?.ready === true && canvas.scene?.id === scene.id,
      shooterId: shooter.id, targetId: target.id, weaponId: gun.id,
      shooterTokenId: tokById["__PW__PAIRWISE Shooter"] ?? null,
      targetTokenId: tokById["__PW__PAIRWISE Target"] ?? null,
      baselineCards: game.messages.size,
    };
  }, { scope: SCOPE });

  ok("§3 the suite's own stage is drawn with both fixture figures on it",
    fixtures.sceneDrawn === true && !!fixtures.shooterTokenId && !!fixtures.targetTokenId,
    `scene=${fixtures.sceneId} shooter=${fixtures.shooterTokenId} target=${fixtures.targetTokenId}`);

  /* ══ §4. THE ROWS ══════════════════════════════════════════════════════════════════════════════ */
  console.log(`\n===== §4: ${driven.length} row(s) =====`);
  const verdicts = [];

  for (let i = 0; i < driven.length; i++) {
    const row = driven[i];
    const v = await page.evaluate(async ({ scope, row, fx, masters }) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const out = { applied: 0, notes: [] };

      /* ⚠ DRAIN WHAT THE PREVIOUS ROW DEFERRED. The apply window opens several seconds behind the
       * shot (fx/effects.js PRESENTATION_CAP_MS, 8 s), which is longer than a row takes — so the
       * window belonging to row N-1 arrives during row N. Clearing it here means each row is read on
       * a stage holding only its own windows. */
      for (const a of [...foundry.applications.instances.values()]) {
        if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close({ force: true }); } catch (e) { /* closed */ } }
      }

      /* apply the row */
      for (const [k, want] of Object.entries(row)) {
        if (game.settings.get(scope, k) !== want) { await game.settings.set(scope, k, want); out.applied++; }
      }
      await sleep(400);
      out.readback = Object.keys(row).every(k => game.settings.get(scope, k) === row[k]);

      globalThis.__cpFaultReset();
      const notified = [];
      const notif = ui.notifications;
      const origWarn = notif.warn.bind(notif);
      const origErr = notif.error.bind(notif);
      notif.warn = (m, o) => { notified.push("warn: " + String(m)); return origWarn(m, o); };
      notif.error = (m, o) => { notified.push("error: " + String(m)); return origErr(m, o); };

      try {
        /* ── UI 1: the character sheet ── */
        const shooter = game.actors.get(fx.shooterId);
        await shooter.sheet.render(true);
        for (let t = 0; t < 40 && !shooter.sheet.element?.querySelector('[data-tab="combat"]'); t++) await sleep(200);
        const sheetRoot = shooter.sheet.element ?? null;
        out.sheetDrawn = !!sheetRoot?.querySelector('[data-tab="combat"]')
          && !!sheetRoot?.querySelector('[data-tab="gear"]');
        // The value the row determines: the Services tab is rendered from `showShop`, which IS
        // shoppingEnabled (actor-sheet.js:132), so its presence is the row's own answer read back.
        out.servicesTab = !!sheetRoot?.querySelector('[data-tab="services"]');
        out.servicesMatchesRow = out.servicesTab === (row.shoppingEnabled === true);

        /* ── UI 2: the shop catalog window ── */
        const CAT = await import(`/modules/${scope}/module/shop/catalog.js`);
        const winOf = () => [...foundry.applications.instances.values()].find(w => w?.constructor?.name === "CatalogBrowser") ?? null;
        const wantShop = row.shoppingEnabled === true;
        CAT.openShopWindow(shooter, { view: "catalog" });
        // ⚠ ONLY THE ROWS THAT EXPECT A WINDOW WAIT FOR ONE. Polling the full opening budget on a row
        // that switched shopping off would spend it all confirming an absence — half the matrix, once
        // per row. A row that expects nothing settles briefly and reads the refusal instead.
        if (wantShop) {
          for (let t = 0; t < 90; t++) {
            const w = winOf();
            if (w?.rendered && w.element?.querySelector(".cp-catalog-list")) break;
            await sleep(300);
          }
        } else {
          await sleep(800);
        }
        const shopWin = winOf();
        const shopRoot = shopWin?.element ?? null;
        out.shopOpened = !!shopWin?.rendered && !!shopRoot?.querySelector(".cp-catalog-list");
        out.shopRows = shopRoot?.querySelectorAll(".cp-catalog-row").length ?? 0;
        // Off must REFUSE, and say so BY NAME: the disabled notice and no window at all, never a
        // half-drawn one (catalog.js:1831). Matching the message keeps an unrelated warning raised by
        // the sheet render from standing in for the refusal.
        const refusal = game.i18n.localize("CYBERPUNK.ShopDisabled");
        out.shopRefused = !shopWin && notified.some(n => n.startsWith("warn: ") && n.includes(refusal));
        out.shopMatchesRow = wantShop ? out.shopOpened : out.shopRefused;

        /* ── UI 3: the System Settings page, with the module's organizer on it ── */
        const SettingsApp = foundry.applications?.settings?.SettingsConfig ?? globalThis.SettingsConfig;
        const cfg = game.settings.sheet ?? (globalThis.__cpSettingsApp ??= new SettingsApp());
        await cfg.render(true);
        for (let t = 0; t < 40 && !cfg.element?.querySelector(".cp-settings-header"); t++) await sleep(200);
        const cfgRoot = cfg.element ?? null;
        out.settingsDrawn = (cfgRoot?.querySelectorAll(".cp-settings-header").length ?? 0) >= 5;
        // The value the row determines: each master's sub-settings are greyed exactly when it is off.
        const gateMisses = [];
        const groupOf = (k) => {
          const el = cfgRoot?.querySelector(`[name="${scope}.${k}"], [data-setting-id="${scope}.${k}"]`);
          return el?.closest(".form-group") ?? el?.closest(".setting") ?? null;
        };
        for (const [master, subs] of Object.entries(masters)) {
          if (!(master in row)) continue;
          const on = row[master] === true;
          for (const sub of subs) {
            const g = groupOf(sub);
            if (!g) continue;                                    // that sub is not on this page
            const greyed = g.classList.contains("cp-mm-disabled");
            if (greyed === on) gateMisses.push(`${master}=${on} → ${sub} greyed=${greyed}`);
          }
        }
        out.gateMisses = gateMisses;

        /* ── the fired-shot payload ── */
        const payload = globalThis.__goldenPayload("singleShot", {
          attackerId: fx.shooterId, attackerTokenId: fx.shooterTokenId,
          weaponId: fx.weaponId, targetTokenId: fx.targetTokenId,
          targetActorId: fx.targetId, firedByUserId: game.user.id,
        }, { targetTokenId: fx.targetTokenId, fxTargetTokenId: fx.targetTokenId });
        const dmgBefore = Number(game.actors.get(fx.targetId)?.system?.damage ?? 0);
        Hooks.callAll("cyberpunk2020.weaponFired", payload);
        await sleep(1600);
        const dmgAfter = Number(game.actors.get(fx.targetId)?.system?.damage ?? 0);
        out.emitted = true;
        out.damageStayedSane = Number.isFinite(dmgAfter) && dmgAfter >= dmgBefore;
        out.damage = `${dmgBefore}→${dmgAfter}`;
      } catch (err) {
        out.threw = String(err?.stack ?? err).slice(0, 400);
      } finally {
        notif.warn = origWarn;
        notif.error = origErr;
        /* close everything this row opened, and clear the rail */
        try { await game.actors.get(fx.shooterId)?.sheet?.close(); } catch (e) { /* closed */ }
        try { await [...foundry.applications.instances.values()].find(w => w?.constructor?.name === "CatalogBrowser")?.close({ force: true }); } catch (e) { /* closed */ }
        try { await (game.settings.sheet ?? globalThis.__cpSettingsApp)?.close({ force: true }); } catch (e) { /* closed */ }
        for (const a of [...foundry.applications.instances.values()]) {
          if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
        }
        try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none */ }
        await sleep(500);
      }

      const f = globalThis.__cpFault;
      out.uncaught = f.uncaught.slice(0, 3);
      out.moduleErrors = f.moduleErrors.slice(0, 3);
      out.warns = f.warns.length;
      out.notified = notified.length;
      return out;
    }, { scope: SCOPE, row, fx: fixtures, masters: MASTERS });

    const clean = v.readback && !v.threw
      && v.sheetDrawn && v.servicesMatchesRow
      && v.shopMatchesRow && v.settingsDrawn && (v.gateMisses?.length ?? 0) === 0
      && v.emitted && v.damageStayedSane
      && v.uncaught.length === 0 && v.moduleErrors.length === 0;
    verdicts.push({ i, v, clean });

    const on = ALLOWED.filter(k => row[k]).length;
    console.log(`${clean ? "  ok  " : "  FAIL"}  row ${String(i).padStart(2, "0")} (${on}/${ALLOWED.length} on)`
      + `  sheet=${v.sheetDrawn ? "y" : "n"} services=${v.servicesTab ? "y" : "n"}(want ${row.shoppingEnabled ? "y" : "n"})`
      + ` shop=${v.shopOpened ? `y/${v.shopRows}` : "n"} settings=${v.settingsDrawn ? "y" : "n"}`
      + ` gates=${v.gateMisses?.length ?? "?"} dmg=${v.damage} warns=${v.warns} uncaught=${v.uncaught.length}`
      + (v.threw ? `  THREW ${v.threw.split("\n")[0]}` : "")
      + (v.uncaught.length ? `  ${v.uncaught[0].slice(0, 120)}` : "")
      + (v.moduleErrors.length ? `  MODULE-ERR ${v.moduleErrors[0].slice(0, 120)}` : "")
      + ((v.gateMisses?.length) ? `  ${v.gateMisses[0]}` : ""));

    /* housekeeping between rows: the cards this row's shot posted */
    await page.evaluate(async (baseline) => {
      for (const m of [...game.messages].slice(baseline)) { try { await m.delete(); } catch (e) { /* gone */ } }
    }, fixtures.baselineCards).catch(() => {});
  }

  console.log("");
  const cleanRows = verdicts.filter(x => x.clean).length;
  ok("§4 every row's settings were actually applied and read back",
    verdicts.every(x => x.v.readback), `${verdicts.filter(x => x.v.readback).length}/${verdicts.length}`);
  ok("§4 no row threw while being driven",
    verdicts.every(x => !x.v.threw), verdicts.find(x => x.v.threw)?.v.threw ?? "none");
  ok("§4 the character sheet drew in every row",
    verdicts.every(x => x.v.sheetDrawn), `${verdicts.filter(x => x.v.sheetDrawn).length}/${verdicts.length}`);
  ok("§4 the Services tab is present in exactly the rows that enable shopping",
    verdicts.every(x => x.v.servicesMatchesRow),
    verdicts.filter(x => !x.v.servicesMatchesRow).map(x => `row ${x.i}`).join(", ") || "all rows agree");
  ok("§4 the shop window opens when shopping is on and refuses by name when it is off",
    verdicts.every(x => x.v.shopMatchesRow),
    verdicts.filter(x => !x.v.shopMatchesRow).map(x => `row ${x.i}`).join(", ") || "all rows agree");
  // ⛔ BOTH POPULATIONS, AND THE CENSUS. The either/or above is satisfiable by a matrix that only ever
  // took one of its two branches, and by a window that opened EMPTY — so both branches must have been
  // walked, and the windows that opened must have listed something.
  const opened = verdicts.filter(x => x.v.shopOpened);
  const refused = verdicts.filter(x => x.v.shopRefused);
  ok("§4 both branches were actually walked — some rows opened the shop and some were refused",
    opened.length > 0 && refused.length > 0, `${opened.length} opened · ${refused.length} refused`);
  ok("§4 an opened shop window listed catalog rows rather than opening empty",
    opened.length > 0 && opened.every(x => x.v.shopRows > 0),
    opened.length ? `smallest listing ${Math.min(...opened.map(x => x.v.shopRows))} row(s)` : "no row opened it");
  ok("§4 the System Settings page drew with the module's section headers in every row",
    verdicts.every(x => x.v.settingsDrawn), `${verdicts.filter(x => x.v.settingsDrawn).length}/${verdicts.length}`);
  ok("§4 every master greys its sub-settings in exactly the rows that switch it off",
    verdicts.every(x => (x.v.gateMisses?.length ?? 1) === 0),
    verdicts.flatMap(x => (x.v.gateMisses ?? []).map(g => `row ${x.i}: ${g}`)).slice(0, 4).join(" · ") || "all masters agree in all rows");
  ok("§4 the fired-shot payload left the target's damage a finite, never-decreasing number in every row",
    verdicts.every(x => x.v.damageStayedSane),
    verdicts.filter(x => !x.v.damageStayedSane).map(x => `row ${x.i} ${x.v.damage}`).join(", ") || "every row finite");
  ok("§4 no row raised an uncaught fault",
    verdicts.every(x => x.v.uncaught.length === 0),
    verdicts.flatMap(x => x.v.uncaught.map(u => `row ${x.i}: ${u.slice(0, 160)}`)).slice(0, 3).join(" | ") || "none");
  ok("§4 no row logged a module-attributed error",
    verdicts.every(x => x.v.moduleErrors.length === 0),
    verdicts.flatMap(x => x.v.moduleErrors.map(u => `row ${x.i}: ${u.slice(0, 160)}`)).slice(0, 3).join(" | ") || "none");
  console.log(`  (${cleanRows}/${verdicts.length} rows fully clean)`);
} catch (err) {
  ok("the suite ran to completion", false, String(err?.stack ?? err).slice(0, 500));
} finally {
  /* ══ RESTORE — runs on every exit path, including a thrown row ═════════════════════════════════ */
  console.log("\n===== restore =====");
  if (snapshot) {
    const restored = await page.evaluate(async ({ scope, snap }) => {
      const failures = [];
      for (const [k, want] of Object.entries(snap)) {
        try {
          if (game.settings.get(scope, k) !== want) await game.settings.set(scope, k, want);
        } catch (e) { failures.push(`${k}: ${String(e).slice(0, 80)}`); }
      }
      // ⏪ POLL, DON'T SLEEP ONCE (2026-08-19): a settings.set round-trip can still be in flight past
      // a flat 600 ms — a real run read `vehicleArmorDamageEnabled: is false, was true` while the
      // restore write was landing, and a probe a minute later found it correct. The verifier now
      // re-checks on a bounded poll and re-issues the write once mid-way; only a value still wrong
      // after the full window is a genuine restore failure.
      const driftOf = () => Object.entries(snap).filter(([k, want]) => game.settings.get(scope, k) !== want)
        .map(([k, want]) => `${k}: is ${game.settings.get(scope, k)}, was ${want}`);
      let drift = driftOf();
      for (let tick = 0; tick < 8 && drift.length; tick++) {
        await new Promise(r => setTimeout(r, 400));
        if (tick === 3) {
          for (const [k, want] of Object.entries(snap)) {
            try { if (game.settings.get(scope, k) !== want) await game.settings.set(scope, k, want); }
            catch (e) { failures.push(`${k} (retry): ${String(e).slice(0, 80)}`); }
          }
        }
        drift = driftOf();
      }
      return { failures, drift, count: Object.keys(snap).length };
    }, { scope: SCOPE, snap: snapshot }).catch(e => ({ failures: [String(e)], drift: ["restore evaluate failed"], count: 0 }));

    ok("restore: every switch the matrix moved is back at the value this run found",
      restored.drift.length === 0 && restored.failures.length === 0,
      restored.drift.length ? `⛔ STILL CHANGED — ${restored.drift.join(" · ")}` : `${restored.count} switch(es) verified`);
  } else {
    ok("restore: a snapshot existed to restore from", false, "the run failed before the snapshot was taken");
  }

  if (fixtures) {
    const swept = await page.evaluate(async ({ baseline, priorSceneId }) => {
      for (const m of [...game.messages].slice(baseline)) { try { await m.delete(); } catch (e) { /* gone */ } }
      try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none */ }
      for (const a of [...foundry.applications.instances.values()]) {
        if (/Damage|Modifiers|CatalogBrowser|SettingsConfig/i.test(a?.constructor?.name ?? "")) {
          try { await a.close({ force: true }); } catch (e) { /* closed */ }
        }
      }
      for (const s of game.scenes.filter(s => s.name === "__PW__Pairwise Stage")) await s.delete().catch(() => {});
      for (const a of game.actors.filter(a => /^__PW__PAIRWISE/.test(a.name))) await a.delete().catch(() => {});
      if (priorSceneId) { try { await game.scenes.get(priorSceneId)?.view(); } catch (e) { /* client-only */ } }
      await new Promise(r => setTimeout(r, 500));
      return {
        scenes: game.scenes.filter(s => s.name === "__PW__Pairwise Stage").length,
        actors: game.actors.filter(a => /^__PW__PAIRWISE/.test(a.name)).length,
        cards: game.messages.size,
        windows: [...foundry.applications.instances.values()].filter(a => /Damage|Modifiers|CatalogBrowser/i.test(a?.constructor?.name ?? "")).length,
      };
    }, { baseline: fixtures.baselineCards, priorSceneId: fixtures.priorSceneId })
      .catch(e => ({ scenes: -1, actors: -1, cards: -1, windows: -1, err: String(e) }));

    ok("restore: the suite's stage, figures, cards and windows are gone",
      swept.scenes === 0 && swept.actors === 0 && swept.windows === 0 && swept.cards === fixtures.baselineCards,
      JSON.stringify(swept));
  }

  const other = await page.evaluate(() => (globalThis.__cpFault?.otherErrors ?? []).length).catch(() => -1);
  ok("no uncaught fault reached the node side across the whole run",
    nodeErrors.length === 0, nodeErrors.slice(0, 3).join(" | "));
  console.log(`  (informational: ${other} non-module console error(s) logged by the core client during the run)`);

  const passed = checks.filter(c => c.p).length;
  console.log(`\n===== settings pairwise: ${passed}/${checks.length} · ${rows.length} matrix row(s) over ${ALLOWED.length} switches =====`);
  if (passed !== checks.length) for (const c of checks.filter(x => !x.p)) console.log(`  FAILED: ${c.n}   [${c.d}]`);
  await browser.close();
  process.exit(passed === checks.length ? 0 : 1);
}
