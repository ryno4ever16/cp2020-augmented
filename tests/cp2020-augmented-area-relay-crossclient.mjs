/**
 * AREA-RELAY CROSS-CLIENT round trip (the THIRD two-session keeper) — proves the player area-spawn relays
 * (gas cloud primary; explosion as a cheap second placer from the same AREA_PLACERS map) as ONE continuous
 * flow between a PLAYER session and a GM session on the SAME world, asserting the outcome on EACH side:
 *
 *   (a) FIXTURES (GM): active scene; a player-owned attacker token + an NPC target token (the cloud/blast
 *       centre), both well inside scene bounds. Settings gasGrenadeCloudEnabled + explosivesEnabled ON
 *       (captured/restored).
 *   (b) PLAYER FIRES: the REAL `cyberpunk2020.weaponFired` hook with a Gas payload (attacker/target ids,
 *       blastRadius, dotTurns, stunSaveMod, weaponName). The player is NON-active-GM, so its gas hook only
 *       RELAYS `gasCloudFired` to the active GM — it must NOT place anything itself.
 *   (c) GM/world side: exactly ONE cloud appears — on v14 a Scene Region carrying the
 *       `cp2020-augmented.gasCloud` behavior with the payload's values (turnsLeft/stunSaveMod/weaponName),
 *       GAMEMASTER visibility; on v13 a MeasuredTemplate carrying the legacy `isGasCloud`/turnsLeft/
 *       stunSaveMod flags. A gas placement card is posted.
 *   (d) PLAYER side: the player can see the placement card; on v14 the region document EXISTS for the
 *       player and its visibility VALUE is GAMEMASTER (visibility=GAMEMASTER means the player does not see
 *       the fill — we assert the document's visibility value, not player-visible rendering).
 *   (e) EXPLOSION (cheap add, same relay map): the player fires an Explosive payload → the active GM places
 *       the blast area + posts the confirm card; the card is visible to the player. Same relay proof, near-
 *       zero extra fixture (an areaDamages number + blastRadius).
 *   (f) 0 console errors on BOTH pages (one documented core CombatTracker string filtered).
 *
 * SANITY-RED: SANITY_RED=1 → the (c) behavior-turnsLeft check expects the WRONG value (payload+7) to prove
 * the keeper actually fails on that exact check; then run clean.
 *
 * SHIP TARGET is :30004 (stock Tilt 1.1.1 + module, v14 → regions). Also run on :30003 (fork system, v13 →
 * templates): the keeper branches on the core's area backend and asserts the equivalent legacy-flag cloud.
 *
 * NOTE: this rig commonly has a SECOND connected GM client ("RemoteGM") — a documented multi-GM harness
 * condition. The area placers are activeGM-gated, so exactly one GM places the area; the keeper still counts
 * the spawned clouds and reports if that ever diverges.
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-area-relay-crossclient.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SANITY_RED = process.env.SANITY_RED === "1";
const GAS_BEHAVIOR = "cp2020-augmented.gasCloud";

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
  attachErrorGates(gm, gmErrors);

  S = await gm.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let scene = canvas?.scene ?? game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
    if (scene && game.scenes.active?.id !== scene.id) { try { await scene.activate(); } catch { /* client-only */ } }
    for (let i = 0; i < 30 && !canvas?.ready; i++) await sleep(200);
    scene = canvas?.scene ?? scene;

    // Pre-clean stray fixtures.
    for (const a of game.actors.filter((a) => a.name?.startsWith("__PW__GAS"))) await a.delete().catch(() => {});
    for (const t of scene.tokens.filter((t) => t.name?.startsWith("__PW__GAS"))) await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
    for (const r of (scene.regions ?? []).filter((r) => r.name?.startsWith?.("__PW__GAS") || r.behaviors?.some((b) => b.type === "cp2020-augmented.gasCloud" && /__PW__GAS/.test(String(b.system?.weaponName ?? ""))))) await scene.deleteEmbeddedDocuments("Region", [r.id]).catch(() => {});

    const capture = (k) => { try { return game.settings.get("cp2020-augmented", k); } catch { return undefined; } };
    const prev = { gas: capture("gasGrenadeCloudEnabled"), expl: capture("explosivesEnabled") };
    await game.settings.set("cp2020-augmented", "gasGrenadeCloudEnabled", true);
    await game.settings.set("cp2020-augmented", "explosivesEnabled", true);

    let player = game.users.find((u) => u.role === CONST.USER_ROLES.PLAYER && !u.isGM);
    let createdPlayer = false;
    if (!player) { player = await User.create({ name: "__PW__GASPlayer", role: CONST.USER_ROLES.PLAYER }); createdPlayer = true; }

    const attacker = await Actor.create({ name: "__PW__GASAttacker", type: "character" });
    await attacker.update({ [`ownership.${player.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
    const npc = await Actor.create({ name: "__PW__GASTarget", type: "character" });

    const gs = scene.grid?.size ?? 100;
    // Both tokens well inside the 3840×1920 scene.
    const [npcTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__GASTarget", actorId: npc.id, actorLink: true, x: 1700, y: 1300, width: 1, height: 1, disposition: -1 }]);
    const [atkTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__GASAttacker", actorId: attacker.id, actorLink: true, x: 1400, y: 1300, width: 1, height: 1, disposition: 1 }]);
    for (let i = 0; i < 25 && !(canvas?.tokens?.get(npcTok.id) && canvas?.tokens?.get(atkTok.id)); i++) await sleep(120);

    const usesRegions = (game.release?.generation ?? 13) >= 14;
    return {
      sceneId: scene.id, playerName: player.name, playerId: player.id, createdPlayer,
      attackerId: attacker.id, npcId: npc.id, npcTokenId: npcTok.id, atkTokenId: atkTok.id,
      usesRegions, generation: game.release?.generation ?? null, gs, prev,
    };
  });
  log.push(`setup: player=${S.playerName} (created=${S.createdPlayer}) attacker=${S.attackerId} npcTok=${S.npcTokenId} gen=${S.generation} usesRegions=${S.usesRegions}`);

  // ───────────────────────── PLAYER session join ─────────────────────────
  const plCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const pl = await plCtx.newPage();
  await joinAs(pl, new RegExp("^" + S.playerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i"), ["", GM_PW]);
  await pl.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});
  attachErrorGates(pl, plErrors);
  await pl.evaluate(async (d) => {
    const sc = game.scenes.get(d.sceneId);
    if (sc && canvas?.scene?.id !== sc.id) { try { await sc.view(); } catch (e) {} }
    for (let i = 0; i < 30 && !canvas?.ready; i++) await new Promise((r) => setTimeout(r, 150));
    try { ui.sidebar?.expand?.(); ui.sidebar?.activateTab?.("chat"); ui.chat?.render(true); } catch (e) {}
  }, S);
  await sleep(400);

  const who = await pl.evaluate((d) => ({
    isGM: game.user.isGM,
    isActiveGM: game.users.activeGM?.id === game.user.id,
    ownsAttacker: game.actors.get(d.attackerId)?.isOwner === true,
    npcTokSeen: !!canvas?.tokens?.get(d.npcTokenId),
    gasOn: (() => { try { return game.settings.get("cp2020-augmented", "gasGrenadeCloudEnabled"); } catch { return false; } })(),
    behaviorRegistered: typeof CONFIG.RegionBehavior?.dataModels?.["cp2020-augmented.gasCloud"] === "function",
  }), S);
  log.push(`player: isGM=${who.isGM} isActiveGM=${who.isActiveGM} ownsAttacker=${who.ownsAttacker} npcTokSeen=${who.npcTokSeen} gasOn=${who.gasOn}`);
  check("player session is a non-GM (so the gas hook RELAYS, not places) who owns the attacker", !who.isGM && !who.isActiveGM && who.ownsAttacker, JSON.stringify(who));
  if (who.isGM) throw new Error("player context is a GM — the relay wouldn't be exercised");

  // ───────────────────────── (b) PLAYER FIRES the real weaponFired Gas hook ─────────────────────────
  const regionsBeforeGas = await gm.evaluate((d) => ({
    regionIds: (game.scenes.get(d.sceneId).regions ?? []).map((r) => r.id),
    templateIds: (game.scenes.get(d.sceneId).templates?.contents ?? game.scenes.get(d.sceneId).templates ?? []).map((t) => t.id),
    msgIds: game.messages.contents.map((m) => m.id),
  }), S);

  const GAS = { turnsLeft: 5, stunSaveMod: -3, blastRadius: 4, weaponName: "__PW__GASGrenade" };
  const fired = await pl.evaluate(async (arg) => {
    // Exactly the payload a real gas-grenade shot emits; NO areaDamages so the single-target damage handler
    // stands down and only the gas placer engages. Player is non-active-GM → it must RELAY, not place.
    try {
      Hooks.callAll("cyberpunk2020.weaponFired", {
        attackerId: arg.attackerId,
        targetTokenId: arg.npcTokenId,
        effectTypes: ["Gas"],
        blastRadius: arg.g.blastRadius,
        dotTurns: arg.g.turnsLeft,
        stunSaveMod: arg.g.stunSaveMod,
        weaponName: arg.g.weaponName,
      });
    } catch (e) { return { err: e.message }; }
    return { ok: true };
  }, { attackerId: S.attackerId, npcTokenId: S.npcTokenId, g: GAS });
  if (fired.err) { check("player fired the gas weaponFired hook", false, fired.err); throw new Error(fired.err); }

  // ───────────────────────── (c) GM/world side: exactly ONE cloud with the payload's values ─────────────────────────
  const cloud = await pollEval(gm, (arg) => {
    const scene = game.scenes.get(arg.sceneId);
    if (arg.usesRegions) {
      const before = new Set(arg.before.regionIds);
      const regs = (scene.regions ?? []).filter((r) => !before.has(r.id) && r.behaviors?.some((b) => b.type === "cp2020-augmented.gasCloud"));
      if (!regs.length) return null;
      const reg = regs[0];
      const beh = reg.behaviors.find((b) => b.type === "cp2020-augmented.gasCloud");
      return {
        backend: "region", count: regs.length, id: reg.id,
        turnsLeft: Number(beh.system.turnsLeft), stunSaveMod: Number(beh.system.stunSaveMod), weaponName: String(beh.system.weaponName ?? ""),
        visibility: reg.visibility, gmConst: CONST.REGION_VISIBILITY?.GAMEMASTER ?? 1,
      };
    } else {
      const before = new Set(arg.before.templateIds);
      const coll = scene.templates?.contents ?? scene.templates ?? [];
      const tmps = coll.filter((t) => !before.has(t.id) && t.flags?.["cp2020-augmented"]?.isGasCloud);
      if (!tmps.length) return null;
      const t = tmps[0];
      const f = t.flags["cp2020-augmented"];
      return {
        backend: "template", count: tmps.length, id: t.id,
        turnsLeft: Number(f.turnsLeft), stunSaveMod: Number(f.stunSaveMod), weaponName: String(f.weaponName ?? ""),
        visibility: null, gmConst: null,
      };
    }
  }, { sceneId: S.sceneId, usesRegions: S.usesRegions, before: regionsBeforeGas }, { timeout: 12_000 });
  log.push(`GM gas cloud: ${JSON.stringify(cloud)}`);
  check("(c) GM page: exactly ONE gas cloud spawned from the player's relayed fire", cloud && cloud.count === 1, JSON.stringify(cloud));

  const expectTurns = SANITY_RED ? GAS.turnsLeft + 7 : GAS.turnsLeft;
  check(`(c) GM page: the cloud carries the payload's turnsLeft=${expectTurns}${SANITY_RED ? " [SANITY-RED]" : ""} + stunSaveMod=${GAS.stunSaveMod} + weaponName`,
    cloud && cloud.turnsLeft === expectTurns && cloud.stunSaveMod === GAS.stunSaveMod && /__PW__GAS/.test(cloud.weaponName), JSON.stringify(cloud));
  if (S.usesRegions) {
    check("(c) GM page: the region cloud's visibility is GAMEMASTER (GM-only default)", cloud && cloud.visibility === cloud.gmConst, JSON.stringify(cloud));
  } else {
    check("(c) v13 GM page: the legacy template cloud carries the isGasCloud flag set", cloud && cloud.backend === "template", JSON.stringify(cloud));
  }
  const cloudId = cloud?.id;

  // Placement card posted GM-side.
  const gmCard = await pollEval(gm, (arg) => {
    const before = new Set(arg.before.msgIds);
    const txt = game.messages.contents.filter((m) => !before.has(m.id)).map((m) => m.content).join("\n");
    return /Gas cloud placed on canvas/i.test(txt) && /__PW__GAS/.test(txt) ? txt.slice(0, 200) : null;
  }, { before: regionsBeforeGas }, { timeout: 8_000 });
  check("(c) GM page: a gas placement card was posted (names the weapon + radius)", !!gmCard, JSON.stringify(gmCard));

  // ───────────────────────── (d) PLAYER side: sees the card; region doc GAMEMASTER-visible ─────────────────────────
  const plCard = await pollEval(pl, () => {
    const txt = game.messages.contents.map((m) => m.content).join("\n");
    return /Gas cloud placed on canvas/i.test(txt) && /__PW__GAS/.test(txt) ? { seen: true } : null;
  }, null, { timeout: 10_000 });
  check("(d) PLAYER page: the gas placement card is visible to the player", !!plCard?.seen, JSON.stringify(plCard));

  if (S.usesRegions && cloudId) {
    const plRegion = await pollEval(pl, (arg) => {
      const reg = game.scenes.get(arg.sceneId)?.regions?.get(arg.cloudId);
      if (!reg) return null;
      return { seen: true, visibility: reg.visibility, gm: CONST.REGION_VISIBILITY?.GAMEMASTER ?? 1 };
    }, { sceneId: S.sceneId, cloudId }, { timeout: 10_000 });
    log.push(`player region view: ${JSON.stringify(plRegion)}`);
    check("(d) PLAYER page: the region doc exists for the player and its visibility VALUE is GAMEMASTER (player does not see the fill)",
      plRegion?.seen && plRegion.visibility === plRegion.gm, JSON.stringify(plRegion));
  } else {
    check("(d) v13: (region-visibility check is v14-only — template clouds have no visibility mode) [n/a-pass]", true, "v13 template backend");
  }

  // ───────────────────────── (e) EXPLOSION cheap add — same AREA_PLACERS relay ─────────────────────────
  const beforeExpl = await gm.evaluate((d) => ({
    regionIds: (game.scenes.get(d.sceneId).regions ?? []).map((r) => r.id),
    templateIds: (game.scenes.get(d.sceneId).templates?.contents ?? game.scenes.get(d.sceneId).templates ?? []).map((t) => t.id),
    msgIds: game.messages.contents.map((m) => m.id),
  }), S);
  const explFired = await pl.evaluate(async (arg) => {
    try {
      Hooks.callAll("cyberpunk2020.weaponFired", {
        attackerId: arg.attackerId,
        targetTokenId: arg.npcTokenId,
        effectTypes: ["Explosive"],
        areaDamages: { Torso: [{ damage: 15 }] },
        blastRadius: 5,
        weaponName: "__PW__GASGrenadeHE",
      });
    } catch (e) { return { err: e.message }; }
    return { ok: true };
  }, { attackerId: S.attackerId, npcTokenId: S.npcTokenId });
  if (explFired.err) log.push("explosion fire note: " + explFired.err);

  const blast = await pollEval(gm, (arg) => {
    const scene = game.scenes.get(arg.sceneId);
    if (arg.usesRegions) {
      const before = new Set(arg.before.regionIds);
      const regs = (scene.regions ?? []).filter((r) => !before.has(r.id) && r.flags?.["cp2020-augmented"]?.isExplosion);
      if (regs.length) return { backend: "region", count: regs.length, id: regs[0].id };
    } else {
      const coll = scene.templates?.contents ?? scene.templates ?? [];
      const before = new Set(arg.before.templateIds);
      const tmps = coll.filter((t) => !before.has(t.id) && t.flags?.["cp2020-augmented"]?.isExplosion);
      if (tmps.length) return { backend: "template", count: tmps.length, id: tmps[0].id };
    }
    return null;
  }, { sceneId: S.sceneId, usesRegions: S.usesRegions, before: beforeExpl }, { timeout: 12_000 });
  log.push(`GM blast area: ${JSON.stringify(blast)}`);
  check("(e) GM page: the player's relayed Explosive fire placed a blast area", !!blast?.id, JSON.stringify(blast));

  const explCard = await pollEval(gm, (arg) => {
    const before = new Set(arg.before.msgIds);
    const txt = game.messages.contents.filter((m) => !before.has(m.id)).map((m) => m.content).join("\n");
    return /Explosion/i.test(txt) && /__PW__GASGrenadeHE/.test(txt) && /cp-confirm-explosion/.test(txt) ? txt.slice(0, 160) : null;
  }, { before: beforeExpl }, { timeout: 8_000 });
  check("(e) GM page: an explosion Confirm card was posted (weapon named + confirm button)", !!explCard, JSON.stringify(explCard));

  const plExplCard = await pollEval(pl, () => {
    const txt = game.messages.contents.map((m) => m.content).join("\n");
    return /Explosion/i.test(txt) && /__PW__GASGrenadeHE/.test(txt) ? { seen: true } : null;
  }, null, { timeout: 10_000 });
  check("(e) PLAYER page: the explosion Confirm card is visible to the player", !!plExplCard?.seen, JSON.stringify(plExplCard));

  // ───────────────────────── (f) console gates ─────────────────────────
  check("(f) GM page: 0 console errors", gmErrors.length === 0, JSON.stringify(gmErrors.slice(0, 6)));
  check("(f) PLAYER page: 0 console errors", plErrors.length === 0, JSON.stringify(plErrors.slice(0, 6)));

  // ───────────────────────── cleanup ─────────────────────────
  await gm.evaluate(async (d) => {
    const scene = game.scenes.get(d.sceneId);
    for (const r of (scene.regions ?? []).filter((r) => r.behaviors?.some((b) => b.type === "cp2020-augmented.gasCloud" && /__PW__GAS/.test(String(b.system?.weaponName ?? ""))) || r.flags?.["cp2020-augmented"]?.isExplosion)) await scene.deleteEmbeddedDocuments("Region", [r.id]).catch(() => {});
    const tcoll = scene.templates?.contents ?? scene.templates ?? [];
    for (const t of tcoll.filter((t) => t.flags?.["cp2020-augmented"]?.isGasCloud || t.flags?.["cp2020-augmented"]?.isExplosion)) await scene.deleteEmbeddedDocuments("MeasuredTemplate", [t.id]).catch(() => {});
    for (const t of scene.tokens.filter((t) => t.name?.startsWith("__PW__GAS"))) await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
    for (const a of game.actors.filter((a) => a.name?.startsWith("__PW__GAS"))) await a.delete().catch(() => {});
    for (const m of game.messages.filter((m) => /__PW__GAS/.test(m.content ?? ""))) await m.delete().catch(() => {});
    if (d.createdPlayer) { const u = game.users.get(d.playerId); if (u) await u.delete().catch(() => {}); }
    try {
      const r = d.prev ?? {};
      if (r.gas !== undefined) await game.settings.set("cp2020-augmented", "gasGrenadeCloudEnabled", r.gas);
      if (r.expl !== undefined) await game.settings.set("cp2020-augmented", "explosivesEnabled", r.expl);
    } catch (e) {}
  }, S).catch(() => {});
} catch (e) {
  log.push("ERROR: " + (e?.stack ?? e?.message ?? e));
  check("no fatal exception during the round trip", false, String(e?.message ?? e));
} finally {
  await browser.close();
}

console.log(`\n===== AREA-RELAY CROSS-CLIENT (${BASE}${SANITY_RED ? " · SANITY_RED" : ""}) =====`);
log.forEach((l) => console.log("  • " + l));
console.log("");
let failed = 0;
for (const r of results) {
  console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "  got=" + r.detail}`);
  if (!r.pass) failed++;
}
console.log(`\n  ${results.length} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
