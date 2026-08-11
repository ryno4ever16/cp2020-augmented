/**
 * DAMAGE-RELAY CROSS-CLIENT round trip (the SECOND two-session keeper) — proves the player
 * applyDamage socket relay (RESOLVED mode) as ONE continuous flow between a PLAYER session and a
 * GM session on the SAME world, asserting the visible outcome on EACH side:
 *
 *   (a) FIXTURES (GM): active scene; an NPC target the player does NOT own, with a known SP (equipped
 *       armor) + BTM (BODY) state; a player-owned attacker; both tokens on the scene. A chat card
 *       carrying the module's `damagePayload` flag (Torso volley) is posted — exactly the card a real
 *       shot produces. Settings captured/restored (damageAutoApply OFF → the card opens the dialog, not
 *       auto-apply; damageArmorMode FULL + damageAblation OFF for a deterministic preview).
 *   (b) PLAYER opens the REAL DamageDialog by clicking the card's Apply-Damage button (the same entry a
 *       player uses in play — renderChatMessageHTML injects `.cp2020-apply-damage-btn` because the player
 *       owns the attacker). The dialog's own previewed FLESH total (`.damage-total-value`) is read off the
 *       page — the keeper asserts the world delta against the dialog's own number, so it never has to
 *       predict the SP/BTM math.
 *   (c) PLAYER APPLIES: a REAL rapid double-click on the dialog's Apply button. Non-GM → the dialog emits
 *       `{type:"applyDamage", mode:"resolved", resolvedHits, …}`; the ACTIVE GM applies with GM perms.
 *       GM/world side: the NPC's `system.damage` rises by EXACTLY the previewed flesh total — and the
 *       rapid second click does NOT double it (the dialog closes on first apply). Value assertion, before/
 *       after reads, then a stabilization wait proves no second (delayed) application lands.
 *   (d) PLAYER side: the relay's response leg — a `DamageApplied` notification arrives on the player page
 *       naming the applied amount + the target honestly (captured via a notifications wrap).
 *   (e) The dialog is gone on the player page after apply (single-apply behavior).
 *   (f) 0 console errors on BOTH pages (one documented core CombatTracker string filtered).
 *
 * SANITY-RED: SANITY_RED=1 → the (c) GM-delta check expects the WRONG value (previewed + 7) to prove the
 * keeper actually fails on that exact check; then run clean.
 *
 * Flesh-only volley by design: a mixed flesh+SDP volley needs a cyberlimb install (heavy fixture work),
 * and the resolved-mode relay applies the SAME pre-computed per-hit values regardless of zone type — the
 * SDP/flesh split is preview-parity, already covered by the single-client cyberlimb keeper. The cross-
 * client contract proven here is the socket round trip + the single-delta guarantee.
 *
 * SHIP TARGET is :30004 (stock Tilt 1.1.1 + module, v14). Also run on :30003 (fork system 1.2.x-beta, v13)
 * — the damage relay is core-agnostic, so both cores should be identical here (no roundsFired-style gap).
 *
 * Run from fork tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-damage-relay-crossclient.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SANITY_RED = process.env.SANITY_RED === "1";

// Known Foundry CORE bug (v13/v14), NOT ours (grep-proven absent from the module): CombatTracker._onRender
// does `data = renderData.find(...)` with no `?? {}` guard, so `"turn" in data` throws. Filtered so it
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
  attachErrorGates(gm, gmErrors);   // gate AFTER join (skip benign /join password-retry 401 noise)

  S = await gm.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let scene = canvas?.scene ?? game.scenes.viewed ?? game.scenes.active ?? game.scenes.contents[0];
    if (scene && game.scenes.active?.id !== scene.id) { try { await scene.activate(); } catch { /* client-only */ } }
    for (let i = 0; i < 30 && !canvas?.ready; i++) await sleep(200);
    scene = canvas?.scene ?? scene;

    // Pre-clean any stray fixtures from a crashed prior run.
    for (const a of game.actors.filter((a) => a.name?.startsWith("__PW__DR"))) await a.delete().catch(() => {});
    for (const t of scene.tokens.filter((t) => t.name?.startsWith("__PW__DR"))) await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
    for (const m of game.messages.filter((m) => m.getFlag?.("cp2020-augmented", "damagePayload")?.weaponName?.startsWith?.("__PW__DR"))) await m.delete().catch(() => {});

    // Deterministic settings (capture → restore at cleanup).
    const capture = (k) => { try { return game.settings.get("cp2020-augmented", k); } catch { return undefined; } };
    const prev = { autoApply: capture("damageAutoApply"), armorMode: capture("damageArmorMode"), ablation: capture("damageAblation") };
    await game.settings.set("cp2020-augmented", "damageAutoApply", false);       // card opens the DIALOG, not auto-apply
    await game.settings.set("cp2020-augmented", "damageArmorMode", "full");
    await game.settings.set("cp2020-augmented", "damageAblation", false);

    // Reuse/provision a non-GM player user (empty password), like the suppressive keeper.
    let player = game.users.find((u) => u.role === CONST.USER_ROLES.PLAYER && !u.isGM);
    let createdPlayer = false;
    if (!player) { player = await User.create({ name: "__PW__DRPlayer", role: CONST.USER_ROLES.PLAYER }); createdPlayer = true; }

    // NPC target the player does NOT own — known SP/BTM: BODY 8 (BTM derived) + equipped armor SP 12 Torso.
    const npc = await Actor.create({ name: "__PW__DRVictim", type: "character" });
    await npc.update({ "system.stats.bt.base": 8 });
    await npc.createEmbeddedDocuments("Item", [{
      name: "__PW__DRArmor", type: "armor",
      system: { equipped: true, coverage: { Torso: { stoppingPower: 12, ablation: 0 } } },
    }]);
    // Player-owned attacker (its ownership is what makes the card's Apply button appear for the player).
    const attacker = await Actor.create({ name: "__PW__DRAttacker", type: "character" });
    await attacker.update({ [`ownership.${player.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });

    const gs = scene.grid?.size ?? 100;
    const [npcTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__DRVictim", actorId: npc.id, actorLink: true, x: 1600, y: 1600, width: 1, height: 1, disposition: -1 }]);
    const [atkTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__DRAttacker", actorId: attacker.id, actorLink: true, x: 1600 - 300, y: 1600, width: 1, height: 1, disposition: 1 }]);
    for (let i = 0; i < 25 && !(canvas?.tokens?.get(npcTok.id) && canvas?.tokens?.get(atkTok.id)); i++) await sleep(120);

    return {
      sceneId: scene.id, playerName: player.name, playerId: player.id, createdPlayer,
      npcId: npc.id, npcName: npc.name, npcTokenId: npcTok.id, attackerId: attacker.id,
      gs, prev,
    };
  });
  log.push(`setup: player=${S.playerName} (created=${S.createdPlayer}) npc=${S.npcId} npcTok=${S.npcTokenId} attacker=${S.attackerId}`);

  const baseline = await gm.evaluate((d) => Number(game.actors.get(d.npcId)?.system?.damage) || 0, S);
  log.push(`GM baseline npc.system.damage = ${baseline}`);

  // ───────────────────────── PLAYER session join ─────────────────────────
  const plCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const pl = await plCtx.newPage();
  await joinAs(pl, new RegExp("^" + S.playerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i"), ["", GM_PW]);
  await pl.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});
  attachErrorGates(pl, plErrors);   // gate AFTER join

  // Player views the active scene (so its canvas has the NPC token for _resolveTarget) + capture notifications.
  await pl.evaluate(async (d) => {
    const sc = game.scenes.get(d.sceneId);
    if (sc && canvas?.scene?.id !== sc.id) { try { await sc.view(); } catch (e) {} }
    for (let i = 0; i < 30 && !canvas?.ready; i++) await new Promise((r) => setTimeout(r, 150));
    // Record every notification the module raises on this client (the relay's response leg lands here).
    window.__cpNotes = [];
    const N = ui.notifications;
    for (const m of ["notify", "info", "warn", "error"]) {
      if (typeof N?.[m] === "function") {
        const orig = N[m].bind(N);
        N[m] = (msg, ...rest) => { try { window.__cpNotes.push(String(msg)); } catch (e) {} return orig(msg, ...rest); };
      }
    }
    // Count the applyDamage requests THIS client sends — the precise "the dialog didn't double-fire the
    // relay" proof, independent of how many GM clients echo a response back.
    window.__cpApplyEmits = [];
    const origEmit = game.socket.emit.bind(game.socket);
    game.socket.emit = (ev, data, ...rest) => {
      try { if (data && data.type === "applyDamage") window.__cpApplyEmits.push(data.mode); } catch (e) {}
      return origEmit(ev, data, ...rest);
    };
    try { ui.sidebar?.expand?.(); ui.sidebar?.activateTab?.("chat"); ui.chat?.render(true); } catch (e) {}
  }, S);
  await sleep(500);

  const who = await pl.evaluate((d) => ({
    isGM: game.user.isGM,
    ownsAttacker: game.actors.get(d.attackerId)?.isOwner === true,
    ownsNpc: game.actors.get(d.npcId)?.isOwner === true,
    npcTokSeen: !!canvas?.tokens?.get(d.npcTokenId),
    autoApplyOff: (() => { try { return game.settings.get("cp2020-augmented", "damageAutoApply") === false; } catch { return false; } })(),
  }), S);
  log.push(`player: isGM=${who.isGM} ownsAttacker=${who.ownsAttacker} ownsNpc=${who.ownsNpc} npcTokSeen=${who.npcTokSeen} autoApplyOff=${who.autoApplyOff}`);
  check("player session is a non-GM who owns the attacker but NOT the NPC target", !who.isGM && who.ownsAttacker && !who.ownsNpc, JSON.stringify(who));
  if (who.isGM || who.ownsNpc) throw new Error("player context wrong (isGM or owns the NPC — the relay wouldn't be exercised)");

  // The GM posts the shot's damage card NOW, while the player is connected + watching chat — this is the
  // realistic timing (the renderChatMessageHTML button-injector fires on the live createChatMessage; a card
  // posted before the player joined is not re-decorated on the join-time chat render). The `damagePayload`
  // flag is inline so the button appears on this render. Torso volley of 30 → clearly penetrates SP 12.
  const msgId = await gm.evaluate(async (d) => {
    const attacker = game.actors.get(d.attackerId);
    const payload = {
      weaponName: "__PW__DRRifle", attackerId: d.attackerId,
      areaDamages: { Torso: [{ damage: 30 }] },
      targetTokenId: d.npcTokenId, targetActorId: d.npcId,
      ap: false, stunSaveOnHit: false,
    };
    const msg = await ChatMessage.create({
      content: `<div class="cyberpunk-card"><b>__PW__DR</b> damage card</div>`,
      flags: { "cp2020-augmented": { damagePayload: payload } },
      speaker: ChatMessage.getSpeaker({ actor: attacker }),
    });
    return msg.id;
  }, S);
  S.msgId = msgId;
  log.push(`GM posted damage card: ${msgId}`);

  // ───────────────────────── (b) PLAYER opens the REAL DamageDialog from the card ─────────────────────────
  const applyBtn = pl.locator(`[data-message-id="${S.msgId}"] .cp2020-apply-damage-btn`);
  await applyBtn.waitFor({ state: "visible", timeout: 15_000 });
  check("(b) PLAYER page: the card's Apply-Damage button rendered (player owns attacker)", await applyBtn.count() === 1);
  await applyBtn.click();

  // Dialog + its previewed flesh total.
  const previewTxt = await pollEval(pl, () => document.querySelector(".damage-dialog .damage-total-value")?.textContent ?? "", null, { timeout: 12_000 });
  const preview = Number(previewTxt);
  const previewOk = Number.isFinite(preview) && preview > 0;
  log.push(`player dialog previewed flesh total = "${previewTxt}" (${preview})`);
  check("(b) PLAYER page: the real DamageDialog opened with a positive previewed flesh total", previewOk, JSON.stringify(previewTxt));
  if (!previewOk) throw new Error("dialog preview not readable — cannot continue");
  // Sanity: the target NPC and weapon shown are the fixture's (proves the dialog is bound to the NPC).
  const dlgBinds = await pl.evaluate(() => {
    const root = document.querySelector(".damage-dialog");
    return root ? root.textContent.replace(/\s+/g, " ").slice(0, 300) : "";
  });
  check("(b) PLAYER page: the dialog names the NPC target + weapon", /__PW__DRVictim/.test(dlgBinds) && /__PW__DRRifle/.test(dlgBinds), dlgBinds);

  // ───────────────────────── (c) PLAYER APPLIES via a REAL rapid double-click ─────────────────────────
  // A real user double-clicking Apply. The dialog closes on the first apply, so the SECOND click must not
  // fire a second relay request. Proven precisely below by counting the player's applyDamage emits (== 1),
  // and corroborated by the world delta being ONE previewed total (not two).
  const applyDlgBtn = pl.locator('.damage-dialog button[data-action="applyDamage"]');
  await applyDlgBtn.waitFor({ state: "visible", timeout: 8_000 });
  try { await applyDlgBtn.dblclick({ delay: 40 }); } catch (e) { log.push("dblclick note: " + e.message); }

  // (e) NEGATIVE: the dialog emitted the applyDamage relay EXACTLY ONCE despite the rapid double-click.
  const applyEmits = await pollEval(pl, () => {
    const e = window.__cpApplyEmits ?? [];
    return e.length ? e : null;
  }, null, { timeout: 6_000 }) ?? [];
  log.push(`player applyDamage emits: ${JSON.stringify(applyEmits)}`);
  check("(e) PLAYER page: the dialog fired the applyDamage relay EXACTLY ONCE in resolved mode (rapid 2nd click did not double-fire)",
    applyEmits.length === 1 && applyEmits[0] === "resolved", JSON.stringify(applyEmits));

  // GM/world side: poll for the delta, then hold to prove no delayed second application.
  const landed = await pollEval(gm, (arg) => {
    const now = Number(game.actors.get(arg.npcId)?.system?.damage) || 0;
    return now !== arg.baseline ? { now } : null;
  }, { npcId: S.npcId, baseline }, { timeout: 12_000 });
  await sleep(1800);   // stabilization window: a second (relayed) apply would land here
  const finalDamage = await gm.evaluate((d) => Number(game.actors.get(d.npcId)?.system?.damage) || 0, S);
  const gmDelta = finalDamage - baseline;
  log.push(`GM npc.system.damage: baseline=${baseline} firstSeen=${JSON.stringify(landed)} final=${finalDamage} delta=${gmDelta} (preview=${preview})`);

  const expectDelta = SANITY_RED ? preview + 7 : preview;
  check(`(c) GM page: NPC damage rose by EXACTLY the previewed flesh total${SANITY_RED ? " +7 [SANITY-RED]" : ""} (single application, no double-apply)`,
    gmDelta === expectDelta, JSON.stringify({ gmDelta, preview, expectDelta }));

  // ───────────────────────── (d) PLAYER side: the relay's response notification ─────────────────────────
  // The relay's response leg reaches the requesting player as a DamageApplied notification naming the
  // amount + the target. NOTE: this rig has a 2nd connected GM client ("RemoteGM"), so the number of
  // response echoes scales with connected GMs (a documented multi-GM harness condition) — we assert the
  // response ARRIVED and named the honest amount, not an exact echo count.
  const note = await pollEval(pl, (arg) => {
    const notes = window.__cpNotes ?? [];
    const hit = notes.find((n) => new RegExp("\\b" + arg.preview + "\\b").test(n) && /__PW__DRVictim/.test(n));
    return hit ?? null;
  }, { preview }, { timeout: 10_000 });
  log.push(`player notifications: ${JSON.stringify((await pl.evaluate(() => window.__cpNotes ?? [])).slice(0, 6))}`);
  check("(d) PLAYER page: a DamageApplied notification arrived naming the applied amount + the NPC honestly", !!note, JSON.stringify(note));

  // ───────────────────────── (e) dialog gone on the player page ─────────────────────────
  const dlgGone = await pollEval(pl, () => document.querySelector(".damage-dialog") ? null : { gone: true }, null, { timeout: 6_000 });
  check("(e) PLAYER page: the dialog closed after apply (so a rapid 2nd click has no button to hit)", !!dlgGone?.gone, JSON.stringify(dlgGone));

  // ───────────────────────── (f) console gates ─────────────────────────
  check("(f) GM page: 0 console errors", gmErrors.length === 0, JSON.stringify(gmErrors.slice(0, 6)));
  check("(f) PLAYER page: 0 console errors", plErrors.length === 0, JSON.stringify(plErrors.slice(0, 6)));

  // ───────────────────────── cleanup ─────────────────────────
  await gm.evaluate(async (d) => {
    const scene = game.scenes.get(d.sceneId);
    for (const t of scene.tokens.filter((t) => t.name?.startsWith("__PW__DR"))) await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
    for (const a of game.actors.filter((a) => a.name?.startsWith("__PW__DR"))) await a.delete().catch(() => {});
    for (const m of game.messages.filter((m) => m.getFlag?.("cp2020-augmented", "damagePayload")?.weaponName?.startsWith?.("__PW__DR") || /__PW__DR/.test(m.content ?? ""))) await m.delete().catch(() => {});
    if (d.createdPlayer) { const u = game.users.get(d.playerId); if (u) await u.delete().catch(() => {}); }
    try {
      const r = d.prev ?? {};
      if (r.autoApply !== undefined) await game.settings.set("cp2020-augmented", "damageAutoApply", r.autoApply);
      if (r.armorMode !== undefined) await game.settings.set("cp2020-augmented", "damageArmorMode", r.armorMode);
      if (r.ablation !== undefined) await game.settings.set("cp2020-augmented", "damageAblation", r.ablation);
    } catch (e) {}
  }, S).catch(() => {});
} catch (e) {
  log.push("ERROR: " + (e?.stack ?? e?.message ?? e));
  check("no fatal exception during the round trip", false, String(e?.message ?? e));
} finally {
  await browser.close();
}

console.log(`\n===== DAMAGE-RELAY CROSS-CLIENT (${BASE}${SANITY_RED ? " · SANITY_RED" : ""}) =====`);
log.forEach((l) => console.log("  • " + l));
console.log("");
let failed = 0;
for (const r of results) {
  console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "  got=" + r.detail}`);
  if (!r.pass) failed++;
}
console.log(`\n  ${results.length} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
