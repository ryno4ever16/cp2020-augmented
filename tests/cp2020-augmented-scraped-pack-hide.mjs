/**
 * KEEPER (two-session, GM + player): the `hideScrapedPacks` compendium-ownership scoping, plus the
 * supplement-shotguns `attackType` source values.
 *
 * PART A (node file reads, no rig): the 11 `src/packs/supplement-shotguns/*.json` sources carry the
 * ratified attackType values and the Enfield source citation. Read from SOURCE on purpose — the
 * COMPILED pack in `packs/` predates these edits and stays stale until the release re-seed, so a
 * compiled-value assertion would be asserting the old data.
 *
 * PART B (rig): contract — while the world setting `hideScrapedPacks` is on (default), the two
 * bulk-scraped base packs `cyberpunk2020.pistols-add` / `rifles-add` carry PLAYER/TRUSTED ownership
 * "NONE", so a real PLAYER session sees `pack.visible === false` and no sidebar row, while the GM's
 * own level stays OWNER. Turning the setting off restores the ownership snapshotted before the first
 * change (here: no configured entry at all) and clears the snapshot; the player sees the packs again.
 * Turning it back on re-hides them. 0 console errors in both sessions.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const SRC = process.env.CP_MODULE_SRC
  ?? "c:/Users/randa/AppData/Local/FoundryVTT/Data/modules/cp2020-augmented/src/packs/supplement-shotguns";
const SCOPE = "cp2020-augmented";
const PACK_IDS = ["cyberpunk2020.pistols-add", "cyberpunk2020.rifles-add"];

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

/* ── PART A — source-file values ───────────────────────────────────────────────────────────── */
// The ratified split (import-staging/SHOTGUN-ATTACKTYPE-EVIDENCE.md + the user's King Buck ruling).
const EXPECTED = {
  "Constitution Hurricane": "Autoshotgun",
  "H&K CAWS 11": "Autoshotgun",
  "M-12 Close Assault": "Autoshotgun",
  "Tsunami Arms Helix": "Autoshotgun",
  "United Arms CLAW": "Autoshotgun",
  "Double Barrel Shotgun": "Shotgun",
  "Enfield LastChance": "Shotgun",
  "Militech Military/Police Shotgun": "Shotgun",
  "SplatShell": "Shotgun",
  "\"Whippet\" Scattergun": "Shotgun",
  "Luigi Franchi King Buck": "Shotgun",
};

console.log("PART A — supplement-shotguns source values");
{
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".json"));
  check(`enumeration closes: ${files.length} source JSONs in supplement-shotguns`,
    files.length === 11, `found ${files.length}`);

  const byName = {};
  let parseFailures = 0, encodingFailures = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(SRC, f), "utf8");
    if (raw.charCodeAt(0) === 0xFEFF || raw.includes("\r")) encodingFailures.push(f);
    try { const d = JSON.parse(raw); byName[d.name] = d; } catch { parseFailures++; }
  }
  check("every source JSON parses", parseFailures === 0, `${parseFailures} parse failures`);
  check("every source JSON is BOM-free with LF endings",
    encodingFailures.length === 0, encodingFailures.join(", "));

  const wrong = [];
  for (const [name, want] of Object.entries(EXPECTED)) {
    const got = byName[name]?.system?.attackType;
    if (got !== want) wrong.push(`${name}: want "${want}", got ${JSON.stringify(got)}`);
  }
  check(`all 11 attackType values match the ratified split (5 Autoshotgun / 6 Shotgun)`,
    wrong.length === 0, wrong.join(" · "));

  // King Buck called out on its own — it is the one value the ruling REVERSED, so a silent revert
  // to Autoshotgun (which would hand it burst + suppressive fire) must fail loudly.
  check('King Buck is "Shotgun" (user ruling: it loses the burst/suppressive it never should have had)',
    byName["Luigi Franchi King Buck"]?.system?.attackType === "Shotgun",
    JSON.stringify(byName["Luigi Franchi King Buck"]?.system?.attackType));

  check('Enfield LastChance source reads "Eurosource p.72"',
    byName["Enfield LastChance"]?.system?.source === "Eurosource p.72",
    JSON.stringify(byName["Enfield LastChance"]?.system?.source));

  // Nothing outside attackType/source moved: every item still names a shotgun gauge the ratified
  // caliber-alias tier resolves, so the conformance lint's ammo leg is unaffected by this change.
  const gauges = Object.values(byName).map((d) => d.system?.ammoType).filter((a) => a !== "");
  const knownGauges = ["12ga", "10ga", "4ga"];
  check("ammoType untouched: every non-blank gauge is a ratified alias spelling",
    gauges.every((g) => knownGauges.includes(g)), [...new Set(gauges)].join(", "));
}

/* ── PART B — rig ──────────────────────────────────────────────────────────────────────────── */
async function join(browser, userRe, passwords) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${URL}/join`);
  await page.waitForSelector('select[name="userid"]');
  const userName = await page.evaluate((re) => {
    const sel = document.querySelector('select[name="userid"]');
    const opt = [...sel.options].find((o) => new RegExp(re, "i").test(o.textContent));
    if (!opt) return null;
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return opt.textContent.trim();
  }, userRe);
  if (!userName) throw new Error(`no user matching ${userRe}`);
  for (const pw of passwords) {
    await page.fill('input[name="password"]', pw);
    await page.click('button[name="join"]');
    try {
      await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 25000 });
      return { ctx, page, userName };
    } catch { await page.goto(`${URL}/join`); await page.waitForSelector('select[name="userid"]'); }
  }
  throw new Error(`could not join as ${userRe}`);
}

const isNoise = (t) => /compatibility|deprecat|screen resolution|Error: The .* is deprecated/i.test(t);

console.log("\nPART B — pack visibility on the rig");
const browser = await chromium.launch();
try {
  const gm = await join(browser, "^gamemaster$", [GM_PW]);
  const gmErrors = [];
  gm.page.on("pageerror", (e) => gmErrors.push(String(e)));
  gm.page.on("console", (m) => { if (m.type() === "error" && !isNoise(m.text())) gmErrors.push(m.text()); });

  // ── registration + i18n ──
  const reg = await gm.page.evaluate(({ SCOPE }) => {
    const cfg = game.settings.settings.get(`${SCOPE}.hideScrapedPacks`);
    const store = game.settings.settings.get(`${SCOPE}.hideScrapedPacksPrior`);
    return {
      registered: !!cfg, scope: cfg?.scope, config: cfg?.config, dflt: cfg?.default,
      storeRegistered: !!store, storeConfig: store?.config, storeScope: store?.scope,
      name: game.i18n.localize(cfg?.name ?? ""), hint: game.i18n.localize(cfg?.hint ?? ""),
      nameKey: cfg?.name, hintKey: cfg?.hint,
    };
  }, { SCOPE });
  check("hideScrapedPacks registered world-scoped, in the menu, default true",
    reg.registered && reg.scope === "world" && reg.config === true && reg.dflt === true,
    JSON.stringify(reg));
  check("hideScrapedPacksPrior registered world-scoped and OUT of the menu",
    reg.storeRegistered && reg.storeScope === "world" && reg.storeConfig === false, "");
  check("both i18n keys resolve (no raw SETTINGS.* leakage)",
    reg.name && reg.name !== reg.nameKey && reg.hint && reg.hint !== reg.hintKey,
    `${reg.name} / ${reg.hint.slice(0, 60)}…`);
  check("the hint names both packs and says the GM can turn it off",
    /Pistols-Add/i.test(reg.hint) && /Rifles-Add/i.test(reg.hint) && /Turn it off/i.test(reg.hint), "");

  // ── ON: hidden for players, untouched for the GM ──
  const on = await gm.page.evaluate(async ({ SCOPE, PACK_IDS }) => {
    const S = await import(`/modules/${SCOPE}/module/settings.js`);
    if (game.settings.get(SCOPE, "hideScrapedPacks") !== true) await game.settings.set(SCOPE, "hideScrapedPacks", true);
    await S.applyScrapedPackVisibility();
    const player = game.users.find((u) => !u.isGM && u.role === CONST.USER_ROLES.PLAYER);
    return {
      playerId: player?.id, playerName: player?.name,
      prior: foundry.utils.deepClone(game.settings.get(SCOPE, "hideScrapedPacksPrior")),
      packs: PACK_IDS.map((id) => {
        const p = game.packs.get(id);
        return {
          id, present: !!p,
          configured: foundry.utils.deepClone(p?.config?.ownership ?? null),
          playerLevel: player ? p?.getUserLevel(player) : null,
          gmLevel: p?.getUserLevel(game.user), gmVisible: p?.visible,
        };
      }),
      // control pack: an untouched base pack must be unaffected
      control: (() => {
        const p = game.packs.get("cyberpunk2020.pistols");
        return { configuredOwnership: p?.config?.ownership ?? null, playerLevel: player ? p.getUserLevel(player) : null };
      })(),
    };
  }, { SCOPE, PACK_IDS });

  check("both scraped packs exist on this install", on.packs.every((p) => p.present), JSON.stringify(on.packs.map((p) => p.present)));
  check('ON: both packs configured PLAYER="NONE" and TRUSTED="NONE"',
    on.packs.every((p) => p.configured?.PLAYER === "NONE" && p.configured?.TRUSTED === "NONE"),
    JSON.stringify(on.packs.map((p) => p.configured)));
  check("ON: the player's ownership level on both packs is NONE (0), below the OBSERVER(2) visibility bar",
    on.packs.every((p) => p.playerLevel === 0), JSON.stringify(on.packs.map((p) => p.playerLevel)));
  check("ON: the GM's own level is OWNER(3) and both packs stay visible to the GM",
    on.packs.every((p) => p.gmLevel === 3 && p.gmVisible === true),
    JSON.stringify(on.packs.map((p) => [p.gmLevel, p.gmVisible])));
  check("ON: the prior-ownership snapshot is stamped for both packs",
    PACK_IDS.every((id) => id in (on.prior ?? {})), JSON.stringify(on.prior));
  check("control pack cyberpunk2020.pistols is NOT touched (player still OBSERVER, no config entry written)",
    on.control.playerLevel === 2 && on.control.configuredOwnership === null, JSON.stringify(on.control));

  // ── a real PLAYER session ──
  const pl = await join(browser, on.playerName ?? "test user 1", ["", GM_PW]);
  const plErrors = [];
  pl.page.on("pageerror", (e) => plErrors.push(String(e)));
  pl.page.on("console", (m) => { if (m.type() === "error" && !isNoise(m.text())) plErrors.push(m.text()); });

  const plOn = await pl.page.evaluate(async ({ PACK_IDS }) => {
    await ui.compendium.render(true);
    await new Promise((r) => setTimeout(r, 400));
    const root = ui.compendium.element;
    return {
      isGM: game.user.isGM, role: game.user.role,
      visible: PACK_IDS.map((id) => game.packs.get(id)?.visible),
      rows: PACK_IDS.map((id) => !!root?.querySelector(`[data-pack="${id}"]`)),
      controlVisible: game.packs.get("cyberpunk2020.pistols")?.visible,
      controlRow: !!root?.querySelector('[data-pack="cyberpunk2020.pistols"]'),
    };
  }, { PACK_IDS });
  check("the second session really is a non-GM player", plOn.isGM === false, `role ${plOn.role}`);
  check("ON, player perspective: pack.visible is false for both scraped packs",
    plOn.visible.every((v) => v === false), JSON.stringify(plOn.visible));
  check("ON, player perspective: neither pack has a row in the Compendium sidebar",
    plOn.rows.every((r) => r === false), JSON.stringify(plOn.rows));
  check("ON, player perspective: the clean cyberpunk2020.pistols pack is still visible and listed",
    plOn.controlVisible === true && plOn.controlRow === true, JSON.stringify([plOn.controlVisible, plOn.controlRow]));

  // ── OFF: restore the snapshotted ownership ──
  const off = await gm.page.evaluate(async ({ SCOPE, PACK_IDS }) => {
    await game.settings.set(SCOPE, "hideScrapedPacks", false);      // onChange runs the restore
    await new Promise((r) => setTimeout(r, 600));
    const player = game.users.find((u) => !u.isGM && u.role === CONST.USER_ROLES.PLAYER);
    return {
      prior: foundry.utils.deepClone(game.settings.get(SCOPE, "hideScrapedPacksPrior")),
      packs: PACK_IDS.map((id) => {
        const p = game.packs.get(id);
        return {
          id, configured: foundry.utils.deepClone(p?.config?.ownership ?? null),
          playerLevel: p?.getUserLevel(player), gmLevel: p?.getUserLevel(game.user), gmVisible: p?.visible,
        };
      }),
    };
  }, { SCOPE, PACK_IDS });

  const priorWas = Object.fromEntries(PACK_IDS.map((id) => [id, on.prior?.[id] ?? null]));
  check("OFF: the configured ownership equals the pre-change snapshot for both packs",
    PACK_IDS.every((id, i) => JSON.stringify(off.packs[i].configured) === JSON.stringify(priorWas[id])),
    `snapshot ${JSON.stringify(priorWas)} vs restored ${JSON.stringify(off.packs.map((p) => p.configured))}`);
  check("OFF: the player's level is back to OBSERVER(2) on both packs",
    off.packs.every((p) => p.playerLevel === 2), JSON.stringify(off.packs.map((p) => p.playerLevel)));
  check("OFF: the GM is still OWNER(3) on both packs",
    off.packs.every((p) => p.gmLevel === 3 && p.gmVisible === true), JSON.stringify(off.packs.map((p) => p.gmLevel)));
  check("OFF: the snapshot stamp is cleared for both packs",
    PACK_IDS.every((id) => !(id in (off.prior ?? {}))), JSON.stringify(off.prior));

  const readPlayer = (page) => page.evaluate(async ({ PACK_IDS }) => {
    await new Promise((r) => setTimeout(r, 1200));   // let the setting broadcast + the reconcile land
    const root = ui.compendium.element;
    return {
      visible: PACK_IDS.map((id) => game.packs.get(id)?.visible),
      rows: PACK_IDS.map((id) => !!root?.querySelector(`[data-pack="${id}"]`)),
    };
  }, { PACK_IDS });

  const plOff = await readPlayer(pl.page);
  check("OFF, player perspective (same live session, no reload): both packs are visible again",
    plOff.visible.every((v) => v === true), JSON.stringify(plOff.visible));
  check("OFF, player perspective: both packs are listed in the Compendium sidebar again (no reload)",
    plOff.rows.every((r) => r === true), JSON.stringify(plOff.rows));

  // ── back ON (also restores the rig to the shipped default) + idempotence ──
  const back = await gm.page.evaluate(async ({ SCOPE, PACK_IDS }) => {
    const S = await import(`/modules/${SCOPE}/module/settings.js`);
    await game.settings.set(SCOPE, "hideScrapedPacks", true);
    await new Promise((r) => setTimeout(r, 600));
    const first = PACK_IDS.map((id) => foundry.utils.deepClone(game.packs.get(id)?.config?.ownership ?? null));
    const priorAfterFirst = foundry.utils.deepClone(game.settings.get(SCOPE, "hideScrapedPacksPrior"));
    await S.applyScrapedPackVisibility();       // the ready-hook re-assert: must be a no-op
    await S.applyScrapedPackVisibility();
    const after = PACK_IDS.map((id) => foundry.utils.deepClone(game.packs.get(id)?.config?.ownership ?? null));
    const player = game.users.find((u) => !u.isGM && u.role === CONST.USER_ROLES.PLAYER);
    return {
      first, after, priorAfterFirst,
      priorAfter: foundry.utils.deepClone(game.settings.get(SCOPE, "hideScrapedPacksPrior")),
      playerLevels: PACK_IDS.map((id) => game.packs.get(id)?.getUserLevel(player)),
      gmLevels: PACK_IDS.map((id) => game.packs.get(id)?.getUserLevel(game.user)),
    };
  }, { SCOPE, PACK_IDS });
  check("back ON: both packs are hidden from the player again and the GM is unaffected",
    back.playerLevels.every((l) => l === 0) && back.gmLevels.every((l) => l === 3),
    JSON.stringify([back.playerLevels, back.gmLevels]));
  check("back ON: the snapshot is re-stamped for both packs",
    PACK_IDS.every((id) => id in (back.priorAfter ?? {})), JSON.stringify(back.priorAfter));
  check("re-assert is idempotent: two further applies change no ownership and no snapshot",
    JSON.stringify(back.first) === JSON.stringify(back.after)
    && JSON.stringify(back.priorAfterFirst) === JSON.stringify(back.priorAfter),
    `${JSON.stringify(back.first)} vs ${JSON.stringify(back.after)}`);

  // The direction that actually protects the table: the player was ALREADY connected (and had the
  // packs listed) when the GM switched the hide back on. Core re-renders the sidebar on an ownership
  // change but does not re-derive the directory tree that filters on pack.visible, so without the
  // module's updateSetting reconcile the row survives and the pack still opens — measured on the rig.
  const plBackOn = await readPlayer(pl.page);
  check("back ON, player perspective (already-connected session, no reload): pack.visible is false again",
    plBackOn.visible.every((v) => v === false), JSON.stringify(plBackOn.visible));
  check("back ON, player perspective: the sidebar rows are gone without a reload (the tree reconcile)",
    plBackOn.rows.every((r) => r === false), JSON.stringify(plBackOn.rows));
  const plOpen = await pl.page.evaluate(async ({ PACK_IDS }) => {
    const results = [];
    for (const id of PACK_IDS) {
      const p = game.packs.get(id);
      try { await p.getIndex(); results.push("index-read-succeeded"); }
      catch (e) { results.push("blocked"); }
      results.push(p.testUserPermission(game.user, "OBSERVER") ? "permitted" : "denied");
      for (const app of Object.values(p.apps ?? {})) { try { await app.close(); } catch {} }
    }
    return results;
  }, { PACK_IDS });
  check("back ON, player perspective: the permission test denies OBSERVER on both packs",
    plOpen.filter((r) => r === "denied").length === 2, JSON.stringify(plOpen));

  check("0 console errors — GM session", gmErrors.length === 0, gmErrors.slice(0, 4).join(" | "));
  check("0 console errors — player session", plErrors.length === 0, plErrors.slice(0, 4).join(" | "));
} finally {
  await browser.close();
}

console.log(`\nRESULT: ${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
