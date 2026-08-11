/**
 * B2 verification — suppressive-fire automation on the STOCK system (:30004, official 1.1.1 + module).
 *
 * On stock, the base `__suppressiveFire` posts a card but fires no hook, so the module's fire-zone /
 * evasion automation is inert (enabling `suppressiveFireSaves` did nothing). The seam shim now wraps
 * `__suppressiveFire` to emit `cyberpunk2020.suppressiveFire` (context from the method, computed values
 * from the suppressive.hbs render). This test drives the REAL wrapped method — NOT a bare Hooks.callAll —
 * so it proves the SHIM, not just the listener:
 *   1. player-side: the wrapper is installed and firing emits a well-formed suppressiveFire payload
 *      (including roundsFired, the placement preview's DC numerator)
 *   2. placement-forward: player (non-GM) fires -> the aim/size PREVIEW arms on the shooting client
 *      (a .cp-supp-preview-readout div) and NO fire zone is auto-placed (the old auto-place is retired)
 *
 * Run from tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-b2-suppressive.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 30_000 });
  const users = await sel.locator("option").evaluateAll((o) =>
    o.map((x) => ({ v: x.value, l: (x.textContent || "").trim() })).filter((x) => x.v));
  const u = users.find((x) => match.test(x.l));
  if (!u) throw new Error("no user matching " + match);
  for (const pw of passwords) {
    await sel.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([
      page.waitForNavigation({ url: /\/game/, timeout: 15_000 }).catch(() => {}),
      page.locator('button[name="join"]').click(),
    ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 15_000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

// In-page: count scene areas carrying a given module flag (v14 Region or v13 MeasuredTemplate).
const COUNT_AREAS = (flag) => {
  const scene = game.scenes.active ?? canvas.scene;
  let n = 0;
  for (const coll of [scene.templates, scene.regions]) {
    if (!coll) continue;
    for (const d of coll) if (d.flags?.["cp2020-augmented"]?.[flag]) n++;
  }
  return n;
};

const browser = await chromium.launch({ headless: true });
const results = {};
const log = [];
try {
  // ---- GM: served-source check + world setup ----
  const gmCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const gm = await gmCtx.newPage();
  await joinAs(gm, /gamemaster/i, [GM_PW]);
  await gm.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});

  // Confirm the rig is serving the EDITED seam-shim (symlinked module → live edits, stale manifest).
  const src = await gm.evaluate(async () => {
    const r = await fetch("/modules/cp2020-augmented/module/seam-shim.js", { cache: "no-store" });
    const t = await r.text();
    return {
      hasInstaller: t.includes("installSuppressiveFireShim"),
      hasHook: t.includes("cyberpunk2020.suppressiveFire"),
      hasTemplate: t.includes("SUPPRESSIVE_TEMPLATE"),
    };
  });
  log.push(`served seam-shim.js: installer=${src.hasInstaller} hook=${src.hasHook} template=${src.hasTemplate}`);
  if (!src.hasInstaller || !src.hasHook || !src.hasTemplate) throw new Error("rig not serving edited seam-shim.js");

  const S = await gm.evaluate(async (COUNT_AREAS_STR) => {
    const COUNT_AREAS = eval("(" + COUNT_AREAS_STR + ")");
    // Clean any prior run's fixtures + zones.
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__"))) await a.delete().catch(()=>{});
    const scene = game.scenes.active ?? canvas.scene;
    for (const t of scene.tokens.filter(t => t.name?.startsWith("__PW__"))) await t.delete().catch(()=>{});
    const F0 = (d)=> d.flags?.["cp2020-augmented"] ?? {};
    for (const coll of [scene.templates, scene.regions]) if (coll) for (const d of [...coll]) if (F0(d).isSuppressiveZone) await d.delete().catch(()=>{});

    // The firing client (player) checks this world setting BEFORE relaying → must be ON before they join.
    let savesPrev; try { savesPrev = game.settings.get("cp2020-augmented", "suppressiveFireSaves"); } catch (e) {}
    await game.settings.set("cp2020-augmented", "suppressiveFireSaves", true);

    const player = game.users.find(u => u.role === 1);
    const pc  = await Actor.create({ name: "__PW__PC",  type: "character" });
    const npc = await Actor.create({ name: "__PW__NPC", type: "character" });
    await pc.update({ [`ownership.${player.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });

    // A weapon with real suppressive inputs: rof/shotsLeft drive `rounds`, range → zone length, damage → formula.
    const [wpn] = await pc.createEmbeddedDocuments("Item", [{
      name: "__PW__SuppWpn", type: "weapon",
      system: { rof: 15, shots: 30, shotsLeft: 30, range: 30, damage: "4d6", weaponType: "rifle" },
    }]);

    const mk = (a, x) => ({ name: a.name, actorId: a.id, x, y: 1000, width: 1, height: 1, disposition: 0, actorLink: true });
    const [pcTok]  = await scene.createEmbeddedDocuments("Token", [mk(pc, 1000)]);
    const [npcTok] = await scene.createEmbeddedDocuments("Token", [mk(npc, 1400)]);
    return {
      playerName: player.name, pcId: pc.id, npcId: npc.id, weaponName: wpn.name,
      pcTokenId: pcTok.id, npcTokenId: npcTok.id, savesPrev,
      baseline: { isSuppressiveZone: COUNT_AREAS("isSuppressiveZone") },
    };
  }, COUNT_AREAS.toString());
  log.push(`setup: player=${S.playerName} pc=${S.pcId} weapon=${S.weaponName} pcTok=${S.pcTokenId}`);
  log.push(`baseline: ${JSON.stringify(S.baseline)}`);

  // ---- Player joins (owns the PC, is NOT a GM) ----
  const plCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const pl = await plCtx.newPage();
  await joinAs(pl, new RegExp(S.playerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), ["", GM_PW]);
  await pl.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});
  const who = await pl.evaluate((d) => ({
    isGM: game.user.isGM,
    ownsPC: game.actors.get(d.pcId)?.isOwner,
    savesOn: (() => { try { return game.settings.get("cp2020-augmented", "suppressiveFireSaves"); } catch { return false; } })(),
    tokenSeen: !!(canvas?.tokens?.placeables?.find(t => t.id === d.pcTokenId)),
  }), S);
  log.push(`player: isGM=${who.isGM} ownsPC=${who.ownsPC} suppressiveFireSaves=${who.savesOn} pcTokenPlaceable=${who.tokenSeen}`);
  if (who.isGM || !who.ownsPC) throw new Error("player context is wrong (isGM or not PC owner)");

  // ===== B2 step 1: player fires suppressive via the REAL wrapped method; capture the emitted payload =====
  const fired = await pl.evaluate(async (d) => {
    const pc = game.actors.get(d.pcId);
    const wpn = pc.items.find(i => i.name === d.weaponName);
    if (!wpn) return { err: "weapon not replicated to player" };
    const shimInstalled = CONFIG.Item.documentClass.prototype.__suppressiveFire?.__cpSeamShim === true;
    let payload = null;
    Hooks.once("cyberpunk2020.suppressiveFire", (p) => { payload = p; });
    try {
      await wpn.__suppressiveFire({ roundsFired: 10, zoneWidth: 2, targetsCount: 1 });
    } catch (e) {
      return { shimInstalled, err: "fire threw: " + e.message };
    }
    await new Promise(r => setTimeout(r, 300));   // belt-and-suspenders; the emit is synchronous in the awaited render
    return { shimInstalled, payload };
  }, S);
  log.push(`player fire: shimInstalled=${fired.shimInstalled} payload=${JSON.stringify(fired.payload)}${fired.err ? " ERR:" + fired.err : ""}`);

  // Assert the shim installed + the payload is well-formed and matches the deterministic inputs.
  {
    const p = fired.payload || {};
    const checks = {
      shimInstalled: fired.shimInstalled === true,
      emitted: !!fired.payload,
      saveDC: p.saveDC === 5,                       // rounds=10, width=2 -> ceil(10/2)
      roundsFired: p.roundsFired === 10,            // the shim's new DC-numerator field
      dmgFormula: p.dmgFormula === "4d6",
      weaponName: p.weaponName === S.weaponName,
      actorId: p.actorId === S.pcId,
      attackerTokenId: p.attackerTokenId === S.pcTokenId,
      zoneWidth: p.zoneWidth === 2,
      weaponRange: p.weaponRange === 30,
    };
    const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    results.B2_payload = { pass: bad.length === 0, detail: bad.length ? `bad fields: ${bad.join(",")}` : "shim emitted correct payload (saveDC5 / rounds10 / 4d6 / range30 / width2 / ids match)" };
  }

  // ===== B2 step 2: placement-forward — the shooting client's aim/size preview arms; no auto-place =====
  {
    // The suppressiveFire hook is local to the firer, so the preview arms on the PLAYER's client. Poll the
    // player page for the readout div (the aim/size overlay), then confirm the GM sees NO auto-placed zone.
    const armed = await pl.evaluate(async () => {
      for (let i = 0; i < 40; i++) { if (document.querySelector(".cp-supp-preview-readout")) return true; await new Promise(r => setTimeout(r, 150)); }
      return !!document.querySelector(".cp-supp-preview-readout");
    });
    const zoneCount = await gm.evaluate((fnStr) => eval("(" + fnStr + ")")("isSuppressiveZone"), COUNT_AREAS.toString());
    results.B2_preview_armed = {
      pass: armed && zoneCount === S.baseline.isSuppressiveZone,
      detail: `preview readout on shooting client=${armed}; auto-placed isSuppressiveZone areas ${S.baseline.isSuppressiveZone}->${zoneCount} (expected unchanged — auto-place retired)`,
    };
    // Dismiss the armed preview so it doesn't leak listeners across the run.
    await pl.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))).catch(() => {});
  }

  // ---- cleanup ----
  await gm.evaluate(async (savesPrev) => {
    const scene = game.scenes.active ?? canvas.scene;
    for (const t of scene.tokens.filter(t => t.name?.startsWith("__PW__"))) await t.delete().catch(()=>{});
    const F = (d)=> d.flags?.["cp2020-augmented"] ?? {};
    for (const coll of [scene.templates, scene.regions]) if (coll) for (const d of [...coll]) if (F(d).isSuppressiveZone) await d.delete().catch(()=>{});
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__"))) await a.delete().catch(()=>{});
    // Restore the captured setting rather than hard-resetting to false.
    try { if (savesPrev !== undefined) await game.settings.set("cp2020-augmented", "suppressiveFireSaves", savesPrev); } catch (e) {}
  }, S.savesPrev).catch(() => {});
} catch (e) {
  log.push("ERROR: " + e.message);
} finally {
  await browser.close();
}

console.log("\n===== B2 SUPPRESSIVE-FIRE SHIM (:30004, official 1.1.1 + module) =====");
log.forEach(l => console.log("  • " + l));
console.log("");
let allPass = Object.keys(results).length > 0;
for (const [k, v] of Object.entries(results)) {
  console.log(`  ${v.pass ? "PASS ✅" : "FAIL ❌"}  ${k.padEnd(16)} — ${v.detail}`);
  if (!v.pass) allPass = false;
}
console.log("\n  OVERALL: " + (allPass ? "ALL PASS ✅" : "SOME FAILED ❌"));
process.exit(allPass ? 0 : 1);
