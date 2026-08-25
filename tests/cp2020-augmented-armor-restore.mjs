/**
 * ARMOR CATALOG RESTORE (module/mech/armor-restore.js + the item sheet's control).
 *
 * WHY THIS EXISTS. Armor degradation is destructive in place — the ablation writes in
 * combat/DamageApplicator.js put the reduced number straight into
 * `system.coverage.<Zone>.stoppingPower`, and the armor model carries no second field holding the
 * original. Once a garment had eroded, its catalog rating existed nowhere on the actor and a GM had
 * to retype six boxes from the compendium. The restore gesture reads them back from the item's own
 * pack entry instead. These legs pin the gesture's three edges:
 *
 *   §1 the write      an eroded garment's per-zone stopping power comes back to the catalog figure,
 *                     through the real rendered button, and nothing else on the item moves
 *   §2 the gate       an item with no resolvable pack entry offers no control at all, and a
 *                     non-GM seat neither sees one nor can drive the engine behind it
 *   §3 the second act pressing it again on an intact garment writes nothing and says so
 *
 * Fixtures are prefixed __PW__ and removed in the finally block. Run from tests/:
 *   FVTT_URL=http://localhost:30003 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-armor-restore.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";

/* The catalog entry the legs are pinned to: Doorgunner's Vest, cyberpunk2020.armor. It is one of
 * the five armor documents the corrections layer carries an entry for, so restoring it exercises
 * the correction pass as well as the raw pack read. Its printed Torso rating is 25. */
const PACK_ID = "cyberpunk2020.armor";
const ITEM_ID = "34GtfgYULaZEe3C7";
const CATALOG_TORSO_SP = 25;

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
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 20_000 }); return u.l; }
    catch {
      await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {});
      await sel.waitFor({ state: "visible" }).catch(() => {});
    }
  }
  throw new Error("could not join as " + u.l);
}

let failures = 0;
const checks = [];
const ok = (name, cond, got) => { checks.push({ name, pass: !!cond, got }); if (!cond) failures++; };

const browser = await chromium.launch({ headless: true });
let gm = null, player = null, cleanupIds = null;
try {
  const gmCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  gm = await gmCtx.newPage();
  const pageErrors = [];
  gm.on("pageerror", (e) => pageErrors.push(String(e?.message || e)));
  gm.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
  await joinAs(gm, /^gamemaster$/i, [GM_PW]);

  /* ── fixture: an actor carrying a pack-sourced garment and a hand-made one ─────────────────── */
  const F = await gm.evaluate(async ({ packId, itemId }) => {
    const M = "/modules/cp2020-augmented/module";
    const AR = await import(`${M}/mech/armor-restore.js`);
    for (const a of game.actors.filter(a => a.name === "__PW__ Armor Restore")) await a.delete().catch(() => {});
    const actor = await Actor.create({ name: "__PW__ Armor Restore", type: "character" });

    // Acquisition mirrors the module's own buy path: toObject() drops the compendium origin, so the
    // origin is stamped back on exactly as buyItem does. That stamp IS the join under test.
    const packDoc = await game.packs.get(packId).getDocument(itemId);
    const data = packDoc.toObject();
    delete data._id;
    data.name = `__PW__ ${data.name}`;
    data._stats = { ...(data._stats ?? {}), compendiumSource: packDoc.uuid };
    const [worn] = await actor.createEmbeddedDocuments("Item", [data]);

    // A hand-made garment: same type, same coverage shape, no pack origin anywhere.
    const [custom] = await actor.createEmbeddedDocuments("Item", [{
      name: "__PW__ Hand-made Vest", type: "armor",
      system: { coverage: { Torso: { stoppingPower: 14, ablation: 0 } } },
    }]);

    // A player seat that owns the actor, so the non-GM legs render the same sheets.
    let user = game.users.find(u => u.name === "__PW__ Player");
    if (!user) user = await User.create({ name: "__PW__ Player", role: 1 });
    await actor.update({ [`ownership.${user.id}`]: 3 });

    return {
      actorId: actor.id, wornId: worn.id, customId: custom.id, userId: user.id,
      packSourceResolves: AR.armorPackSource(worn) !== null,
      customSourceResolves: AR.armorPackSource(custom) !== null,
      catalog: await AR.armorCatalogSp(worn),
      customCatalog: await AR.armorCatalogSp(custom),
    };
  }, { packId: PACK_ID, itemId: ITEM_ID });
  cleanupIds = F;

  ok("§0 the pack-sourced garment's catalog entry resolves", F.packSourceResolves === true, F.packSourceResolves);
  ok("§0 the hand-made garment resolves no catalog entry", F.customSourceResolves === false, F.customSourceResolves);
  ok("§0 the catalog read returns the printed torso rating",
    F.catalog?.Torso === CATALOG_TORSO_SP, JSON.stringify(F.catalog));
  ok("§0 the hand-made garment has no catalog read at all", F.customCatalog === null, F.customCatalog);

  /* ── §1 the write, driven through the rendered control ────────────────────────────────────── */
  const eroded = await gm.evaluate(async ({ actorId, wornId }) => {
    const actor = game.actors.get(actorId);
    const item = actor.items.get(wornId);
    // Erode it the way the damage path does: a full coverage-object write, three points off the
    // torso and the item marked as worn, so the fixture is a garment in real use.
    const coverage = foundry.utils.deepClone(item.system.coverage || {});
    coverage.Torso = { ...(coverage.Torso ?? {}), stoppingPower: Number(coverage.Torso?.stoppingPower ?? 0) - 3 };
    await item.update({ "system.coverage": coverage, "system.equipped": true });
    await item.sheet.render(true);
    await new Promise(r => setTimeout(r, 900));
    const root = item.sheet.element;
    const btn = root?.querySelector(".cp-armor-restore");
    return {
      appId: root?.id ?? null,
      sp: Number(item.system.coverage?.Torso?.stoppingPower),
      controlPresent: !!btn,
      controlLabel: btn?.textContent?.trim() ?? null,
      encumbrance: item.system.encumbrance, equipped: item.system.equipped, name: item.name,
    };
  }, F);

  ok("§1 the fixture is eroded below catalog before the gesture",
    eroded.sp === CATALOG_TORSO_SP - 3, eroded.sp);
  ok("§1 the GM's armor sheet renders the restore control", eroded.controlPresent === true, eroded.controlPresent);
  ok("§1 the control's label leaks no raw key",
    typeof eroded.controlLabel === "string" && eroded.controlLabel.length > 0
    && !eroded.controlLabel.includes("CYBERPUNK."), eroded.controlLabel);

  // A real DOM click on the rendered button, with the confirm answered — outcome, not presence.
  const restored = await gm.evaluate(async ({ actorId, wornId, appId }) => {
    const item0 = game.actors.get(actorId).items.get(wornId);
    const btn = document.querySelector(`[id="${appId}"] .cp-armor-restore`);
    // No control rendered is itself a reportable outcome — return the untouched state rather than
    // throwing, so the remaining sections still run and the report shows where the break is.
    if (!btn) return {
      sawDialog: false,
      sp: Number(item0.system.coverage?.Torso?.stoppingPower),
      head: Number(item0.system.coverage?.Head?.stoppingPower),
      encumbrance: item0.system.encumbrance, equipped: item0.system.equipped, name: item0.name,
    };
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    // Answer the confirm by pressing its own Yes button, so the dialog wiring is under test too.
    const yes = await (async () => {
      for (let i = 0; i < 60; i++) {
        const el = document.querySelector('.application.dialog button[data-action="yes"]');
        if (el) return el;
        await new Promise(r => setTimeout(r, 100));
      }
      return null;
    })();
    const sawDialog = !!yes;
    yes?.click();
    await new Promise(r => setTimeout(r, 1200));
    const item = game.actors.get(actorId).items.get(wornId);
    return {
      sawDialog,
      sp: Number(item.system.coverage?.Torso?.stoppingPower),
      head: Number(item.system.coverage?.Head?.stoppingPower),
      encumbrance: item.system.encumbrance, equipped: item.system.equipped, name: item.name,
    };
  }, { ...F, appId: eroded.appId });

  ok("§1 the gesture asks before writing", restored.sawDialog === true, restored.sawDialog);
  ok("§1 the torso rating comes back to the catalog figure", restored.sp === CATALOG_TORSO_SP, restored.sp);
  ok("§1 an uncovered location stays at its catalog zero", restored.head === 0, restored.head);
  ok("§1 the item's other fields are untouched",
    restored.name === eroded.name && restored.equipped === eroded.equipped
    && restored.encumbrance === eroded.encumbrance,
    `${restored.name} | ${restored.equipped} | ${restored.encumbrance}`);

  /* ── §3 the second act: an intact garment writes nothing ──────────────────────────────────── */
  const again = await gm.evaluate(async ({ actorId, wornId }) => {
    const AR = await import("/modules/cp2020-augmented/module/mech/armor-restore.js");
    const item = game.actors.get(actorId).items.get(wornId);
    const before = Number(item.system.coverage?.Torso?.stoppingPower);
    const wrote = await AR.restoreArmorToCatalog(item, { confirm: false });
    const after = Number(game.actors.get(actorId).items.get(wornId).system.coverage?.Torso?.stoppingPower);
    return { wrote, before, after };
  }, F);
  ok("§3 a second pass on an intact garment reports no write", again.wrote === false, again.wrote);
  ok("§3 and leaves the rating exactly where it was", again.after === again.before, `${again.before}->${again.after}`);

  /* ── §2 the gate: no catalog entry ⇒ no control ───────────────────────────────────────────── */
  const customSheet = await gm.evaluate(async ({ actorId, customId }) => {
    const AR = await import("/modules/cp2020-augmented/module/mech/armor-restore.js");
    const item = game.actors.get(actorId).items.get(customId);
    await item.sheet.render(true);
    await new Promise(r => setTimeout(r, 900));
    const wrote = await AR.restoreArmorToCatalog(item, { confirm: false });
    const sp = Number(game.actors.get(actorId).items.get(customId).system.coverage?.Torso?.stoppingPower);
    const present = !!item.sheet.element?.querySelector(".cp-armor-restore");
    await item.sheet.close().catch(() => {});
    return { present, wrote, sp };
  }, F);
  ok("§2 a hand-made garment's sheet carries no restore control", customSheet.present === false, customSheet.present);
  ok("§2 and the engine refuses it outright", customSheet.wrote === false, customSheet.wrote);
  ok("§2 leaving the hand-entered rating alone", customSheet.sp === 14, customSheet.sp);

  /* ── §2 the gate: a non-GM seat ───────────────────────────────────────────────────────────── */
  const pCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  player = await pCtx.newPage();
  await joinAs(player, /^__PW__ Player$/, ["", GM_PW]);
  const asPlayer = await player.evaluate(async ({ actorId, wornId }) => {
    const AR = await import("/modules/cp2020-augmented/module/mech/armor-restore.js");
    const item = game.actors.get(actorId).items.get(wornId);
    // Drop the rating on the player's own seat first, so "no control" is asserted on a sheet that
    // would legitimately have something to restore.
    const coverage = foundry.utils.deepClone(item.system.coverage || {});
    coverage.Torso = { ...(coverage.Torso ?? {}), stoppingPower: 9 };
    await item.update({ "system.coverage": coverage });
    await item.sheet.render(true);
    await new Promise(r => setTimeout(r, 900));
    const present = !!item.sheet.element?.querySelector(".cp-armor-restore");
    const wrote = await AR.restoreArmorToCatalog(item, { confirm: false });
    const sp = Number(game.actors.get(actorId).items.get(wornId).system.coverage?.Torso?.stoppingPower);
    await item.sheet.close().catch(() => {});
    return { isGM: game.user.isGM, present, wrote, sp };
  }, F);
  ok("§2 the player seat is not a GM seat", asPlayer.isGM === false, asPlayer.isGM);
  ok("§2 a player's armor sheet carries no restore control", asPlayer.present === false, asPlayer.present);
  ok("§2 and the engine refuses a non-GM caller", asPlayer.wrote === false, asPlayer.wrote);
  ok("§2 leaving the reduced rating in place", asPlayer.sp === 9, asPlayer.sp);

  const clean = pageErrors.length === 0;
  ok("0 console errors", clean, pageErrors.slice(0, 3).join(" | ") || 0);
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  failures++;
} finally {
  try {
    if (gm && cleanupIds) {
      await gm.evaluate(async ({ actorId, userId }) => {
        const a = game.actors.get(actorId);
        for (const i of (a?.items ?? [])) { try { await i.sheet?.close(); } catch {} }
        try { await a?.sheet?.close(); } catch {}
        try { await a?.delete(); } catch {}
        try { await game.users.get(userId)?.delete(); } catch {}
      }, cleanupIds).catch(() => {});
    }
  } catch {}
  await browser.close();
}

console.log("\nArmor catalog restore\n" + checks.map(c =>
  `  [${c.pass ? "PASS" : "FAIL"}] ${String(c.name).padEnd(66)} got=${c.got}`).join("\n"));
console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
