/**
 * Suppressive-fire CROSS-CLIENT round trip (the FIRST two-session keeper) — proves the whole
 * placement-forward loop as ONE continuous flow between a GM session and a PLAYER session on the
 * SAME world, asserting the visible outcome on EACH side at every step:
 *   (a) FIXTURES (GM): active scene, a shooter actor OWNED by a non-GM player with an autofire weapon,
 *       a separate victim token, no combat.
 *   (b) PLAYER FIRES: the player drives the REAL wrapped __suppressiveFire in suppressive mode with a
 *       declared zoneWidth (4m) + rounds (12) → the aim/size preview arms ON THE PLAYER PAGE (readout
 *       div present, localized, "Width 4m — evasion save 3"). The GM page has NO preview.
 *   (c) PLAYER CONFIRMS: a real aimed click on the player canvas relays the geometry to the GM, which
 *       plants a native Scene Region → on the GM SESSION the region carries saveDC 3 / attackerId /
 *       suppressiveLocked / ALWAYS visibility; on the PLAYER SESSION the region doc is readable and
 *       its visibility is ALWAYS (the player-visible ruling).
 *   (d) ENTER: on the GM session, a real API walk-in — the victim token is moved (tokenDoc.update) from
 *       OUTSIDE the lane INTO it; arrival is proven by a committed-position (_source) poll BEFORE trusting
 *       the enter result, then the native enter event fires the evasion prompt. A token CREATED inside the
 *       lane is a second entry-path check (the at-plant path).
 *       NOTE: programmatic moves (tokenDoc.update / teleport / move) DO recompute region membership and
 *       fire the enter event headless on BOTH cores — only the synthetic MOUSE-DRAG gesture is undriveable
 *       headless. An earlier off-scene fixture (movement silently CLAMPS to the 3840×1920 scene edge, so
 *       the token never reached the lane) was the false negative behind the retired "drag" approach.
 *   (e) GM UNLOCK: a real click on the placement card's Unlock button clears the region lock flag AND
 *       re-arms the preview on the PLAYER page (readout present again, seeded with the lane's width).
 *   (f) PLAYER RE-CONFIRMS at a shifted aim → the SAME region is UPDATED on the GM session (shapes
 *       changed, re-locked, same region id — not a second region).
 *   (g) 0 console errors on BOTH pages (one documented core CombatTracker string filtered).
 *
 * SANITY-RED: run once with SANITY_RED=1 → the (b) readout DC check expects the WRONG value ("save 9")
 * to prove the keeper actually fails; then run clean.
 *
 * Needs the module SYNCED + the rig Foundry server RESTARTED (module.json changed → the RegionBehavior
 * type is only valid after a reload). All fixtures self-clean; the toggled setting is restored.
 *
 * SHIP TARGET is :30004 (stock Tilt 1.1.1 + module) → 17/17. On the :30003 FORK rig (system 1.2.x-beta)
 * the DC checks (b)/(c-saveDC) FAIL by design: the fork's OWN __suppressiveFire (module/item/item.js)
 * emits cyberpunk2020.suppressiveFire natively (so the module's seam-shim correctly stands down) but its
 * payload OMITS roundsFired — the numerator the placement preview divides by the live width — so the
 * preview floors the evasion DC to 1 instead of 3. Fork-side gap for the upstream-merge track (one-line
 * fix: add `roundsFired: rounds` to that emit), NOT a defect on the ship target. Everything else is
 * cross-core identical.
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-suppressive-crossclient.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SANITY_RED = process.env.SANITY_RED === "1";
const SCOPE = "cp2020-augmented";
const T = "cp2020-augmented.suppressiveFire";

// Known Foundry CORE bug (v13/v14), NOT ours: CombatTracker._onRender does `data = renderData.find(...)`
// with no `?? {}` guard, so `"turn" in data` throws when a keeper drives combat.update({round}) on a combat
// that momentarily isn't the tracker's viewed one. Grep-proven absent from the module; filtered here so it
// doesn't phantom-fail the 0-console-errors gate (see test-harness.md).
const CORE_TURN_BUG = /Cannot use 'in' operator to search for 'turn' in undefined/;

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
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

function attachErrorGates(page, bag) {
  page.on("pageerror", (e) => { if (!CORE_TURN_BUG.test(e.message)) bag.push("pageerror: " + e.message); });
  page.on("console", (m) => { if (m.type() === "error" && !CORE_TURN_BUG.test(m.text())) bag.push("console: " + m.text()); });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll a page.evaluate until it returns a truthy value (or timeout → returns the last value).
async function pollEval(page, fn, arg, { timeout = 10_000, interval = 200 } = {}) {
  const start = Date.now();
  let last = await page.evaluate(fn, arg);
  while (!last && Date.now() - start < timeout) { await sleep(interval); last = await page.evaluate(fn, arg); }
  return last;
}

const results = [];
const log = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail: detail ?? "" }); };

const browser = await chromium.launch({ headless: true });
const gmErrors = [];
const plErrors = [];
let S = null;
try {
  // ───────────────────────── (a) FIXTURES — GM session ─────────────────────────
  const gmCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const gm = await gmCtx.newPage();
  await joinAs(gm, /gamemaster/i, [GM_PW]);
  await gm.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});
  // Gate console errors only AFTER join: the /join password-retry loop can log a benign 401 for a
  // password-protected user, which is harness noise, not a feature error.
  attachErrorGates(gm, gmErrors);

  S = await gm.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Active, drawn canvas (region enter events + the preview stage need a live canvas).
    let scene = canvas?.scene ?? game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
    if (scene && game.scenes.active?.id !== scene.id) { try { await scene.activate(); } catch { /* client-only */ } }
    for (let i = 0; i < 30 && !canvas?.ready; i++) await sleep(200);
    scene = canvas?.scene ?? scene;

    // Pre-clean any stray fixtures from a crashed prior run.
    for (const d of (scene.regions ?? []).filter((d) => d.behaviors?.some((bb) => bb.type === "cp2020-augmented.suppressiveFire"))) await scene.deleteEmbeddedDocuments("Region", [d.id]).catch(() => {});
    for (const a of game.actors.filter((a) => a.name?.startsWith("__PW__XC"))) await a.delete().catch(() => {});
    for (const t of scene.tokens.filter((t) => t.name?.startsWith("__PW__XC"))) await t.delete().catch(() => {});

    // Feature gate ON before the player joins (the SHOOTING client reads it before arming).
    let savesPrev; try { savesPrev = game.settings.get("cp2020-augmented", "suppressiveFireSaves"); } catch (e) {}
    await game.settings.set("cp2020-augmented", "suppressiveFireSaves", true);

    // A non-GM player user — reuse an existing role-1 user or create one (empty password), so this runs on
    // both cores regardless of the world's roster.
    let player = game.users.find((u) => u.role === CONST.USER_ROLES.PLAYER && !u.isGM);
    let createdPlayer = false;
    if (!player) { player = await User.create({ name: "__PW__XCPlayer", role: CONST.USER_ROLES.PLAYER }); createdPlayer = true; }

    const shooter = await Actor.create({ name: "__PW__XCShooter", type: "character" });
    const victim = await Actor.create({ name: "__PW__XCVictim", type: "character" });
    await shooter.update({ [`ownership.${player.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });

    // Autofire weapon: rof/shotsLeft drive rounds (min(15,30)=15; a request of 12 clamps to 12), range → lane
    // length, damage → the hit formula. Mirrors the b2 fixture.
    const [wpn] = await shooter.createEmbeddedDocuments("Item", [{
      name: "__PW__XCWpn", type: "weapon",
      system: { rof: 15, shots: 30, shotsLeft: 30, range: 30, damage: "4d6", weaponType: "rifle" },
    }]);

    const gs = scene.grid?.size ?? 100;
    // Shooter near a known world point; victim placed NORTH of the future east-running lane (outside it).
    const sx = 1500, sy = 1500;
    const [shooterTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__XCShooter", actorId: shooter.id, actorLink: true, x: sx - gs / 2, y: sy - gs / 2, width: 1, height: 1, disposition: 1 }]);
    const [victimTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__XCVictim", actorId: victim.id, actorLink: true, x: sx - gs / 2, y: sy - 400 - gs / 2, width: 1, height: 1, disposition: -1 }]);
    for (let i = 0; i < 25 && !(canvas?.tokens?.get(shooterTok.id) && canvas?.tokens?.get(victimTok.id)); i++) await sleep(120);

    return {
      sceneId: scene.id, playerName: player.name, playerId: player.id, createdPlayer,
      shooterId: shooter.id, victimId: victim.id, weaponName: wpn.name,
      shooterTokenId: shooterTok.id, victimTokenId: victimTok.id, gs, sx, sy, savesPrev,
    };
  });
  log.push(`setup: player=${S.playerName} (created=${S.createdPlayer}) shooter=${S.shooterId} shooterTok=${S.shooterTokenId} victimTok=${S.victimTokenId}`);

  // Pan the GM to the shooter so lane coords stay on-screen for the drag later.
  await gm.evaluate((d) => { const t = canvas.tokens.get(d.shooterTokenId); if (t) canvas.animatePan({ x: t.center.x, y: t.center.y, scale: 0.6, duration: 1 }); }, S);
  await sleep(400);

  // ───────────────────────── PLAYER session join ─────────────────────────
  const plCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const pl = await plCtx.newPage();
  await joinAs(pl, new RegExp("^" + S.playerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i"), ["", GM_PW]);
  await pl.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});
  attachErrorGates(pl, plErrors);   // gate AFTER join (skip benign /join password-retry 401 noise)
  // Make sure the player is viewing the active scene, then pan to the shooter.
  await pl.evaluate(async (d) => {
    const sc = game.scenes.get(d.sceneId);
    if (sc && canvas?.scene?.id !== sc.id) { try { await sc.view(); } catch (e) {} }
    for (let i = 0; i < 30 && !canvas?.ready; i++) await new Promise((r) => setTimeout(r, 150));
    const t = canvas.tokens.get(d.shooterTokenId); if (t) canvas.animatePan({ x: t.center.x, y: t.center.y, scale: 0.6, duration: 1 });
  }, S);
  await sleep(500);

  const who = await pl.evaluate((d) => ({
    isGM: game.user.isGM,
    ownsShooter: game.actors.get(d.shooterId)?.isOwner === true,
    savesOn: (() => { try { return game.settings.get("cp2020-augmented", "suppressiveFireSaves"); } catch { return false; } })(),
    shimInstalled: CONFIG.Item.documentClass.prototype.__suppressiveFire?.__cpSeamShim === true,
    shooterTokSeen: !!canvas?.tokens?.get(d.shooterTokenId),
    behaviorRegistered: typeof CONFIG.RegionBehavior?.dataModels?.["cp2020-augmented.suppressiveFire"] === "function",
  }), S);
  log.push(`player: isGM=${who.isGM} ownsShooter=${who.ownsShooter} savesOn=${who.savesOn} shim=${who.shimInstalled} tokSeen=${who.shooterTokSeen} behaviorReg=${who.behaviorRegistered}`);
  // shimInstalled is informational, not asserted: on STOCK Tilt (ship target) the module's seam-shim wraps
  // __suppressiveFire; on the FORK system the base emits cyberpunk2020.suppressiveFire natively so the shim
  // correctly stands down (shim=false is CORRECT there). The true cross-core invariant is that firing arms
  // the preview — proven by (b) below — regardless of which side emits the hook.
  check("player session is a non-GM owner of the shooter", !who.isGM && who.ownsShooter, JSON.stringify(who));
  check("player session: suppressive setting ON + behavior type registered", who.savesOn && who.behaviorRegistered, JSON.stringify(who));
  if (who.isGM || !who.ownsShooter) throw new Error("player context wrong (isGM or not shooter owner)");

  // ───────────────────────── (b) PLAYER FIRES → preview arms on player page ─────────────────────────
  const fired = await pl.evaluate(async (d) => {
    const shooter = game.actors.get(d.shooterId);
    const wpn = shooter.items.find((i) => i.name === d.weaponName);
    if (!wpn) return { err: "weapon not replicated to player" };
    try { await wpn.__suppressiveFire({ roundsFired: 12, zoneWidth: 4, targetsCount: 1 }); }
    catch (e) { return { err: "fire threw: " + e.message }; }
    return { ok: true };
  }, S);
  if (fired.err) { check("player fire drove __suppressiveFire", false, fired.err); throw new Error(fired.err); }

  const previewTxt = await pollEval(pl, () => document.querySelector(".cp-supp-preview-readout")?.textContent ?? "", null, { timeout: 8_000 });
  log.push(`player preview readout: "${previewTxt}"`);
  const dcNeedle = SANITY_RED ? /save 9\b/i : /save 3\b/i;   // SANITY-RED flips the expected DC
  const previewOk = !!previewTxt && !/CYBERPUNK\.|SuppPreviewReadout/.test(previewTxt) && /4m/i.test(previewTxt) && dcNeedle.test(previewTxt);
  check(`(b) PLAYER page: preview armed, localized, width 4m & ${SANITY_RED ? "save 9 [SANITY-RED]" : "save 3"} (DC ceil(12/4))`, previewOk, JSON.stringify(previewTxt));
  const gmHasPreview = await gm.evaluate(() => !!document.querySelector(".cp-supp-preview-readout"));
  check("(b) GM page: NO preview readout (the aim hook is local to the firer)", !gmHasPreview, `gmHasPreview=${gmHasPreview}`);

  // ───────────────────────── (c) PLAYER CONFIRMS → GM plants the region ─────────────────────────
  const regionsBefore = await gm.evaluate((d) => (game.scenes.get(d.sceneId).regions ?? []).map((r) => r.id), S);
  // Aim EAST (world +dx, same y) so the lane runs east from the shooter, then a real left click confirms.
  const aim = await pl.evaluate((d) => {
    const t = canvas.tokens.get(d.shooterTokenId); const c = t.center;
    const p = canvas.stage.worldTransform.apply(new PIXI.Point(c.x + 300, c.y));
    return { x: p.x, y: p.y };
  }, S);
  await pl.mouse.move(aim.x, aim.y, { steps: 4 });   // sets the aim angle (onMove)
  await sleep(120);
  await pl.mouse.down();                              // onDown(button 0) → confirm() → relay to GM
  await pl.mouse.up();

  const planted = await pollEval(gm, (arg) => {
    const scene = game.scenes.get(arg.sceneId);
    const before = new Set(arg.before);
    const reg = (scene.regions ?? []).find((r) => !before.has(r.id) && r.behaviors?.some((b) => b.type === "cp2020-augmented.suppressiveFire"));
    if (!reg) return null;
    const beh = reg.behaviors.find((b) => b.type === "cp2020-augmented.suppressiveFire");
    return {
      id: reg.id,
      saveDC: Number(beh.system.saveDC), attackerId: beh.system.attackerId, weaponName: beh.system.weaponName,
      visibility: reg.visibility, locked: reg.flags?.["cp2020-augmented"]?.suppressiveLocked === true,
      alwaysConst: CONST.REGION_VISIBILITY?.ALWAYS ?? 2,
    };
  }, { sceneId: S.sceneId, before: regionsBefore }, { timeout: 12_000 });
  log.push(`GM plant: ${JSON.stringify(planted)}`);
  check("(c) GM page: a Region carrying the suppressiveFire behavior was planted", !!planted?.id, JSON.stringify(planted));
  check("(c) GM page: behavior saveDC=3, attackerId=shooter, weaponName carried", planted && planted.saveDC === 3 && planted.attackerId === S.shooterId && planted.weaponName === S.weaponName, JSON.stringify(planted));
  check("(c) GM page: region visibility is ALWAYS", planted && planted.visibility === planted.alwaysConst, JSON.stringify(planted));
  check("(c) GM page: region planted LOCKED", planted && planted.locked === true, JSON.stringify(planted));
  const regionId = planted?.id;
  if (!regionId) throw new Error("region never planted — cannot continue the round trip");

  // Player side: the region doc is readable and ALWAYS-visible (player-visible ruling).
  const plRegion = await pollEval(pl, (arg) => {
    const reg = game.scenes.get(arg.sceneId)?.regions?.get(arg.regionId);
    if (!reg) return null;
    return { seen: true, visibility: reg.visibility, always: (CONST.REGION_VISIBILITY?.ALWAYS ?? 2) };
  }, { sceneId: S.sceneId, regionId }, { timeout: 10_000 });
  log.push(`player region view: ${JSON.stringify(plRegion)}`);
  check("(c) PLAYER page: the planted region is readable and ALWAYS-visible", plRegion?.seen && plRegion.visibility === plRegion.always, JSON.stringify(plRegion));

  // The confirm tore down the preview; make sure the player page has no stray readout.
  await pl.evaluate(() => { try { window.cp2020PreviewCancel?.(); } catch (e) {} });

  // ───────────────────────── (d) ENTER via a real API walk-in (PRIMARY) + create-inside (secondary) ──
  // Programmatic moves DO recompute region membership + fire the native enter event headless (proven on
  // both cores); only the synthetic mouse-drag GESTURE is undriveable headless. The victim starts OUTSIDE
  // the lane (its north fixture position, well inside scene bounds) and is walked in via tokenDoc.update.
  // Interior target = the planted lane's own centreline a bit past the origin (robust to any grid scale).
  const target = await gm.evaluate((arg) => {
    const scene = game.scenes.get(arg.sceneId);
    const geo = scene.regions.get(arg.regionId).flags["cp2020-augmented"].suppressiveGeometry;
    const rad = (Number(geo.angleDeg) || 0) * Math.PI / 180;
    const d = Math.min((Number(geo.lengthPx) || 400) * 0.35, 250);
    const cx = geo.origin.x + Math.cos(rad) * d, cy = geo.origin.y + Math.sin(rad) * d;
    const gs = scene.grid?.size ?? 100;
    return { topX: Math.round(cx - gs / 2), topY: Math.round(cy - gs / 2), cx: Math.round(cx), cy: Math.round(cy) };
  }, { sceneId: S.sceneId, regionId });
  const msgBeforeWalk = await gm.evaluate(() => game.messages.contents.map((m) => m.id));
  await gm.evaluate(async (arg) => {
    await game.scenes.get(arg.sceneId).tokens.get(arg.victimTokenId).update({ x: arg.topX, y: arg.topY });
  }, { sceneId: S.sceneId, victimTokenId: S.victimTokenId, topX: target.topX, topY: target.topY });
  // ARRIVAL PROOF (standing rule): never trust an enter/no-enter result without proving the token reached
  // the lane. v13 gotcha — the animated getter lags, so poll the committed _source position.
  const arrived = await pollEval(gm, (arg) => {
    const tdoc = game.scenes.get(arg.sceneId).tokens.get(arg.victimTokenId);
    return (tdoc._source.x === arg.topX && tdoc._source.y === arg.topY) ? { x: tdoc._source.x, y: tdoc._source.y } : null;
  }, { sceneId: S.sceneId, victimTokenId: S.victimTokenId, topX: target.topX, topY: target.topY }, { timeout: 8_000 });
  log.push(`(d) walk-in: target center (${target.cx},${target.cy}); arrived=${JSON.stringify(arrived)}`);
  check("(d) walk-in: victim token ARRIVED at the in-lane position (movement committed)", !!arrived, JSON.stringify({ target, arrived }));
  const walkPrompt = await pollEval(gm, (arg) => {
    const before = new Set(arg.before);
    const txt = game.messages.contents.filter((m) => !before.has(m.id)).map((m) => m.content).join("\n");
    return (/__PW__XCVictim/.test(txt) && /Evasion/i.test(txt)) ? txt.slice(0, 200) : null;
  }, { before: msgBeforeWalk }, { timeout: 8_000 });
  check("(d) ENTER (API walk-in): moving the victim into the lane fired the native enter event → evasion prompt", !!walkPrompt, JSON.stringify(walkPrompt));

  // Second entry-path check: a token CREATED inside the lane is also prompted (covers the at-plant path).
  const msgBeforeCreate = await gm.evaluate(() => game.messages.contents.map((m) => m.id));
  await gm.evaluate(async (arg) => {
    const scene = game.scenes.get(arg.sceneId);
    const a = await Actor.create({ name: "__PW__XCEnterer", type: "character" });
    await scene.createEmbeddedDocuments("Token", [{ name: "__PW__XCEnterer", actorId: a.id, actorLink: true, x: arg.topX, y: arg.topY, width: 1, height: 1 }]);
  }, { sceneId: S.sceneId, topX: target.topX, topY: target.topY });
  const createPrompt = await pollEval(gm, (arg) => {
    const before = new Set(arg.before);
    const txt = game.messages.contents.filter((m) => !before.has(m.id)).map((m) => m.content).join("\n");
    return (/__PW__XCEnterer/.test(txt) && /Evasion/i.test(txt)) ? txt.slice(0, 200) : null;
  }, { before: msgBeforeCreate }, { timeout: 8_000 });
  check("(d) ENTER (create-inside): a token created inside the lane is also prompted to evade", !!createPrompt, JSON.stringify(createPrompt));

  // ───────────────────────── (e) GM UNLOCK via a real card-button click ─────────────────────────
  await gm.evaluate(() => { try { ui.sidebar?.expand?.(); ui.sidebar?.activateTab?.("chat"); ui.chat?.render(true); } catch (e) {} });
  await sleep(300);
  const unlockClicked = await gm.evaluate((arg) => {
    const btn = document.querySelector(`.cp-suppressive-unlock[data-region-id="${arg.regionId}"]`);
    if (!btn) return { found: false };
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));   // document-level handler
    return { found: true };
  }, { regionId });
  log.push(`unlock button: found=${unlockClicked.found}`);
  check("(e) GM page: the placement card Unlock button is present + clickable", unlockClicked.found, JSON.stringify(unlockClicked));

  const unlocked = await pollEval(gm, (arg) => {
    const reg = game.scenes.get(arg.sceneId)?.regions?.get(arg.regionId);
    return reg?.flags?.["cp2020-augmented"]?.suppressiveLocked === false ? { cleared: true } : null;
  }, { sceneId: S.sceneId, regionId }, { timeout: 8_000 });
  check("(e) GM page: unlock cleared the region's suppressiveLocked flag", !!unlocked?.cleared, JSON.stringify(unlocked));

  const rearmTxt = await pollEval(pl, () => document.querySelector(".cp-supp-preview-readout")?.textContent ?? "", null, { timeout: 8_000 });
  log.push(`player re-arm readout: "${rearmTxt}"`);
  check("(e) PLAYER page: unlock re-armed the preview (readout present again, seeded at width 4m)", !!rearmTxt && /4m/i.test(rearmTxt) && !/CYBERPUNK\.|SuppPreviewReadout/.test(rearmTxt), JSON.stringify(rearmTxt));

  // ───────────────────────── (f) PLAYER RE-CONFIRMS at a shifted aim → SAME region updated ─────────────────────────
  const shapeBefore = await gm.evaluate((arg) => JSON.stringify(game.scenes.get(arg.sceneId)?.regions?.get(arg.regionId)?.shapes?.[0]?.points ?? []), { sceneId: S.sceneId, regionId });
  const aim2 = await pl.evaluate((d) => {
    const t = canvas.tokens.get(d.shooterTokenId); const c = t.center;
    const p = canvas.stage.worldTransform.apply(new PIXI.Point(c.x + 220, c.y - 220));   // shifted: NE instead of E
    return { x: p.x, y: p.y };
  }, S);
  await pl.mouse.move(aim2.x, aim2.y, { steps: 4 });
  await sleep(120);
  await pl.mouse.down();
  await pl.mouse.up();

  const reconfirmed = await pollEval(gm, (arg) => {
    const scene = game.scenes.get(arg.sceneId);
    const reg = scene?.regions?.get(arg.regionId);
    if (!reg) return null;
    const shapeNow = JSON.stringify(reg.shapes?.[0]?.points ?? []);
    if (shapeNow === arg.shapeBefore) return null;   // wait for the UPDATE to land
    const regionCount = (scene.regions ?? []).filter((r) => r.behaviors?.some((b) => b.type === "cp2020-augmented.suppressiveFire")).length;
    return { shapeChanged: true, relocked: reg.flags?.["cp2020-augmented"]?.suppressiveLocked === true, sameId: reg.id === arg.regionId, regionCount };
  }, { sceneId: S.sceneId, regionId, shapeBefore }, { timeout: 12_000 });
  log.push(`re-confirm: ${JSON.stringify(reconfirmed)}`);
  check("(f) GM page: the SAME region was UPDATED with a new shape (not a second region)", reconfirmed && reconfirmed.shapeChanged && reconfirmed.sameId && reconfirmed.regionCount === 1, JSON.stringify(reconfirmed));
  check("(f) GM page: the re-confirmed lane is re-locked", reconfirmed && reconfirmed.relocked === true, JSON.stringify(reconfirmed));

  await pl.evaluate(() => { try { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch (e) {} });

  // ───────────────────────── (g) console gates ─────────────────────────
  check("(g) GM page: 0 console errors", gmErrors.length === 0, JSON.stringify(gmErrors.slice(0, 6)));
  check("(g) PLAYER page: 0 console errors", plErrors.length === 0, JSON.stringify(plErrors.slice(0, 6)));

  // ───────────────────────── cleanup ─────────────────────────
  await gm.evaluate(async (d) => {
    const scene = game.scenes.get(d.sceneId);
    for (const r of (scene.regions ?? []).filter((r) => r.behaviors?.some((b) => b.type === "cp2020-augmented.suppressiveFire"))) await scene.deleteEmbeddedDocuments("Region", [r.id]).catch(() => {});
    for (const t of scene.tokens.filter((t) => t.name?.startsWith("__PW__XC"))) await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
    for (const a of game.actors.filter((a) => a.name?.startsWith("__PW__XC"))) await a.delete().catch(() => {});
    if (d.createdPlayer) { const u = game.users.get(d.playerId); if (u) await u.delete().catch(() => {}); }
    try { if (d.savesPrev !== undefined) await game.settings.set("cp2020-augmented", "suppressiveFireSaves", d.savesPrev); } catch (e) {}
  }, S).catch(() => {});
} catch (e) {
  log.push("ERROR: " + (e?.stack ?? e?.message ?? e));
  check("no fatal exception during the round trip", false, String(e?.message ?? e));
} finally {
  await browser.close();
}

console.log(`\n===== SUPPRESSIVE CROSS-CLIENT (${BASE}${SANITY_RED ? " · SANITY_RED" : ""}) =====`);
log.forEach((l) => console.log("  • " + l));
console.log("");
let failed = 0;
for (const r of results) {
  console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "  got=" + r.detail}`);
  if (!r.pass) failed++;
}
console.log(`\n  ${results.length} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
