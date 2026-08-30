/**
 * KEEPER (two-session, cross-client): cover — the whole attribution chain from a player's window.
 *
 * Contract: a PLAYER opens the real Apply Damage window for a shot whose line crosses a cover
 * object → no cover-object selector exists, the Cover SP field is seeded from the crossed object,
 * and Apply routes the damage over the applyDamage relay AND ONE structure debit over the coverChew
 * relay (both GM-side writes). The debit is taken ROUND BY ROUND: the burst's third round empties
 * the object, so the fourth faces no cover and lands its full roll, and the single summary card
 * reports the per-round wear plus the round the object gave out on. A window opened with no
 * attacker (the hand-opened case) seeds nothing and debits nothing.
 *
 * The spec builds and activates its OWN scene — a shared scene carrying standing cover fixtures
 * would put unrelated objects on the shot line — and hands the previous one back at the end.
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const SHOT_DIR = process.env.SHOT_DIR ?? null;

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function join(browser, userRe, passwords) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`${URL}/join`);
  await page.waitForSelector('select[name="userid"]');
  const userName = await page.evaluate(re => {
    const sel = document.querySelector('select[name="userid"]');
    const opt = [...sel.options].find(o => new RegExp(re, "i").test(o.textContent));
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
      await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 20000 });
      return { ctx, page, userName };
    } catch { await page.goto(`${URL}/join`); await page.waitForSelector('select[name="userid"]'); }
  }
  throw new Error(`could not join as ${userRe}`);
}

const browser = await chromium.launch();
const gm = await join(browser, "^gamemaster$", [GM_PW]);
const gmErrors = [];
gm.page.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(m.text())) gmErrors.push(m.text()); });

// DIAGNOSTIC COUNTER — how many coverChew datagrams this GM client actually RECEIVES. It separates
// "the socket delivered the request twice" from "one delivery performed two writes", which a card
// count alone cannot tell apart (2026-08-26).
await gm.page.evaluate(() => {
  window.__pwChewSeen = 0;
  game.socket.on("module.cp2020-augmented", (d) => { if (d?.type === "cover" + "Chew") window.__pwChewSeen++; });
  // Name the CALLER of every structure card this client writes. A count says a card was duplicated;
  // only a stack says by whom.
  window.__pwChewStacks = [];
  const origCreate = ChatMessage.create.bind(ChatMessage);
  ChatMessage.create = function (data, ...rest) {
    try {
      const c = (Array.isArray(data) ? data[0]?.content : data?.content) ?? "";
      if (String(c).includes("cp-cover-chew")) {
        window.__pwChewStacks.push(String(new Error("chew-card").stack).split(String.fromCharCode(10)).slice(1, 7).join(" | "));
      }
    } catch (e) { /* diagnostic only */ }
    return origCreate(data, ...rest);
  };
});

/* ── GM setup: a scene of this spec's own, a shooter, a GM-owned target, one object between them ── */
const setup = await gm.page.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  // ⚠ A PROBE SCENE IS NEVER THE SCENE TO HAND BACK. An aborted run leaves its own scene ACTIVE, and
  // the sweep below then deletes the very document the handback leg is holding an id for — the run
  // after a crash failed its own tidy-up leg for a mess the crash left (2026-08-25). The world's real
  // scene is whichever active scene is not one of ours, else the first non-probe scene there is.
  let prevActiveId = game.scenes.active?.id ?? null;
  if (!prevActiveId || game.scenes.get(prevActiveId)?.name?.startsWith("__PWX__")) {
    // ⛔ NAME THE RIG'S OWN SCENE — do NOT take "the first scene that is not ours". That picked an
    // arbitrary collection entry and HANDED THE RIG BACK ON THE WRONG SCENE (2026-08-26), which then
    // read as a defect in every later suite whose geometry is scene-relative: figures landed off-canvas
    // or behind that scene's walls and whole sections reported zero damage with nothing wrong in the
    // module. A tidy-up may restore the world; it may never redecorate it.
    prevActiveId = game.scenes.getName("Foundry Virtual Tabletop")?.id ?? null;
  }
  for (const s of [...game.scenes]) if (s.name?.startsWith("__PWX__")) await s.delete();
  for (const a of [...game.actors]) if (a.name?.startsWith("__PWX__")) await a.delete();

  const [scene] = await Scene.create([{
    name: "__PWX__CoverBurst", width: 4000, height: 3000, padding: 0,
    grid: { size: 100, type: CONST.GRID_TYPES.SQUARE },
  }]);
  await scene.activate();
  for (let i = 0; i < 150 && !(canvas?.ready && canvas.scene?.id === scene.id); i++) await new Promise(r => setTimeout(r, 200));

  const cov = await import(`/modules/${SCOPE}/module/combat/cover.js`);
  const G = scene.grid.size;
  // Shooter at 5G,10G and target at 15G,10G put the shot line on y = 10.5G; the object straddles it.
  // ⭐ THE STRUCTURE IS STATED, not inherited (ruled 2026-08-26 — cover.js COVER_MODE_CORE). SP alone
  // is now permanent Core p.103 cover that keeps no ledger, so a relay suite that wants the Maximum
  // Metal lifecycle has to opt in the same way a GM does. The placer no longer re-supplies 3 × SP.
  const region = await cov.placeCoverZone({ scene, label: "__PWX__CarBody", sp: 10, poolMax: 30 });
  await region.update({ shapes: [{ type: "rectangle", x: 10 * G, y: 10 * G, width: G, height: G, rotation: 0 }] });
  const behavior = region.behaviors.find(b => b.type === `${SCOPE}.coverZone`);

  const shooter = await Actor.create({ name: "__PWX__Shooter", type: "character" });
  const npc = await Actor.create({ name: "__PWX__Victim", type: "npc" });
  const [aTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PWX__ShooterTok", actorId: shooter.id, actorLink: true, x: 5 * G, y: 10 * G, width: 1, height: 1 }]);
  const [tTok] = await scene.createEmbeddedDocuments("Token", [{ name: npc.name, actorId: npc.id, actorLink: true, x: 15 * G, y: 10 * G, width: 1, height: 1 }]);

  return {
    sceneId: scene.id, prevActiveId, regionId: region.id, behaviorUuid: behavior.uuid,
    shooterId: shooter.id, npcId: npc.id, aTokId: aTok.id, tTokId: tTok.id,
    hp0: Number(npc.system.damage) || 0,
    btm: Number(npc.system.stats?.bt?.modifier) || 0,
    pool0: Number(behavior.system.pool) || 0,
  };
});
check("the object starts at the structure it was placed with (30)", setup.pool0 === 30, String(setup.pool0));

/* ── Player session: the real window, opened the way a shot opens it ── */
const pl = await join(browser, "test user 1", ["", GM_PW]);
await pl.page.waitForFunction(id => canvas?.ready && canvas.scene?.id === id, setup.sceneId, { timeout: 30000 });

// Instrument the PLAYER too: if the GM page made one card and two exist, the other creator has to be
// named rather than guessed at.
await pl.page.evaluate(() => {
  window.__pwChewStacks = [];
  window.__pwWhoAmI = { name: game.user.name, isGM: game.user.isGM, role: game.user.role,
                        activeGM: game.users.activeGM?.name ?? null,
                        amActiveGM: game.users.activeGM?.id === game.user.id };
  const origCreate = ChatMessage.create.bind(ChatMessage);
  ChatMessage.create = function (data, ...rest) {
    try {
      const c = (Array.isArray(data) ? data[0]?.content : data?.content) ?? "";
      if (String(c).includes("cp-cover-chew")) {
        window.__pwChewStacks.push(String(new Error("chew").stack).split(String.fromCharCode(10)).slice(1, 5).join(" | "));
      }
    } catch (e) { /* diagnostic only */ }
    return origCreate(data, ...rest);
  };
});

const msgIdsBefore = await gm.page.evaluate(() => game.messages.map(m => m.id));

await pl.page.evaluate(async ({ npcId, tTokId, aTokId }) => {
  const { DamageDialog } = await import("/modules/cp2020-augmented/module/combat/DamageDialog.js");
  const target = game.actors.get(npcId);
  // Four rounds of 14 against structure 30: 14 -> 16 left, 14 -> 2 left, 2 empties it (that round
  // was still shot through the object), and the fourth faces nothing.
  const payload = {
    areaDamages: { Torso: [{ damage: 14 }, { damage: 14 }, { damage: 14 }, { damage: 14 }] },
    targetTokenId: tTokId, attackerTokenId: aTokId, weaponName: "Keeper Burst",
  };
  window.__pwDlg = new DamageDialog(payload, target);
  await window.__pwDlg.render(true);
}, setup);
await pl.page.waitForSelector('form.damage-dialog input[name="coverSP"]', { timeout: 15000 });

const dlg = await pl.page.evaluate(() => {
  const root = document.querySelector("form.damage-dialog");
  const rows = [...root.querySelectorAll(".damage-hit")].map(r => r.querySelector("input.after-sp-override")?.value ?? null);
  const drains = [...root.querySelectorAll(".cp-damage-breakdown-drain")].map(r => ({
    label: r.querySelector(".cp-bd-label")?.textContent?.trim() ?? "",
    value: r.querySelector(".cp-bd-value")?.textContent?.trim() ?? "",
  }));
  return {
    sp: root.querySelector('input[name="coverSP"]')?.value ?? null,
    selectors: root.querySelectorAll('select[name="coverZone"]').length,
    afterSp: rows, drains,
  };
});
check("no cover-object selector in the player's window", dlg.selectors === 0, `selects ${dlg.selectors}`);
check("Cover SP seeded from the crossed object (10)", dlg.sp === "10", String(dlg.sp));
check("preview: rounds 1-3 resolve through the object (after-SP 4 each)",
  dlg.afterSp.slice(0, 3).every(v => v === "4"), dlg.afterSp.join(","));
check("preview: round 4 faces no cover and lands its full 14", dlg.afterSp[3] === "14", dlg.afterSp.join(","));
check("preview: the math line drains the object round by round (30 -> 16 -> 2 -> destroyed)",
  dlg.drains.length === 3
  && dlg.drains[0].value.includes("16 / 30") && dlg.drains[1].value.includes("2 / 30")
  && /destroyed/i.test(dlg.drains[2].value),
  dlg.drains.map(d => `${d.label}:${d.value}`).join(" | "));
check("preview: every drain line names the object", dlg.drains.every(d => d.label === "__PWX__CarBody"), dlg.drains.map(d => d.label).join(","));
// Only on request — an unasked-for screenshot lands in whatever directory the run started from.
if (SHOT_DIR) await pl.page.screenshot({ path: `${SHOT_DIR}/cover-breakdown-dialog.png` });

/* ── Apply: both relay writes land GM-side ── */
await pl.page.click('.damage-dialog button[data-action="applyDamage"]');

// The relay writes the rounds one at a time, so "something changed" is not "the burst finished" —
// wait for the value to STOP moving before reading it, or a poll lands mid-burst and reports a
// partial total as the answer.
const after = await gm.page.evaluate(async ({ npcId, behaviorUuid, hp0 }) => {
  const read = async () => {
    const behavior = await fromUuid(behaviorUuid);
    return {
      hp: Number(game.actors.get(npcId)?.system?.damage) || 0,
      pool: Number(behavior?.system?.pool),
      destroyed: behavior?.system?.destroyed,
      sp: behavior?.system?.sp,
    };
  };
  let prev = null, stable = 0;
  for (let i = 0; i < 80; i++) {
    const now = await read();
    const moved = now.hp !== hp0 && now.pool !== 30;
    stable = (prev && now.hp === prev.hp && now.pool === prev.pool) ? stable + 1 : 0;
    if (moved && stable >= 3) return now;
    prev = now;
    await new Promise(r => setTimeout(r, 250));
  }
  return { timeout: true, ...(await read()) };
}, setup);
check("both relay writes landed (no timeout)", !after.timeout, JSON.stringify(after));

const expectedHp = [4, 4, 4, 14].reduce((s, a) => s + Math.max(1, a - setup.btm), 0);
check("the damage written is the four rounds' own values", after.hp - setup.hp0 === expectedHp, `delta ${after.hp - setup.hp0}, expected ${expectedHp} (btm ${setup.btm})`);
check("the whole structure was debited in one write: 30 -> 0", after.pool === 0, `pool ${after.pool}`);
check("the object reads destroyed", after.destroyed === true, String(after.destroyed));
check("its SP never moved while it stood (book rule)", after.sp === 10, String(after.sp));

/* ── The summary card: ONE card for the burst, carrying the round-by-round wear ── */
const card = await gm.page.evaluate(async (before) => {
  const seen = new Set(before);
  for (let i = 0; i < 24; i++) {
    // ⚠ SCOPED TO THIS OBJECT, not to every chew card in the world. "How many cards did this burst
    // post" is the question; counting every `cp-cover-chew` created since the snapshot answers a
    // question about the whole session, and a suite that ran before this one in a battery could still
    // have a card landing (2026-08-26 — it did, and turned three legs red with nothing wrong here).
    const cards = game.messages.filter(m => !seen.has(m.id) && m.content.includes("cp-cover-chew")
      && m.content.includes("__PWX__CarBody"));
    if (cards.length) {
      return {
        count: cards.length, content: cards[cards.length - 1].content,
        // ⚠ DIAGNOSTIC: when the count is wrong, say WHAT the extra cards were and who was connected.
        // A bare count cannot tell a double-handled relay from a second suite's leftovers.
        all: cards.map(c => ({
          at: c.timestamp, by: c.author?.name ?? c.user?.name ?? "?",
          text: (c.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 90),
        })),
        activeUsers: game.users.filter(u => u.active).map(u => `${u.name}${u.isGM ? "(GM)" : ""}`),
        activeGM: game.users.activeGM?.name ?? null,
      };
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return { count: 0, content: "" };
}, msgIdsBefore);
const chewSeen = await gm.page.evaluate(() => {
  const ls = game.socket.listeners ? game.socket.listeners("module.cp2020-augmented") : [];
  // A datagram count cannot see a SECOND module listener — each listener fires once per event, and the
  // counter is itself only one of them. Count the module's own coverChew handlers directly.
  // ⚠ Match the MODULE's handler only. An earlier version of this filter also matched the diagnostic
  // listener installed just above and reported a phantom "two handlers" (2026-08-26).
  const chewHandlers = ls.filter(f => /MSG_CHEW/.test(String(f))).length;
  return { seen: window.__pwChewSeen ?? -1, listeners: ls.length, chewHandlers,
           gmStacks: (window.__pwChewStacks ?? []).length };
});
const plSide = await pl.page.evaluate(() => ({
  who: window.__pwWhoAmI, plStacks: (window.__pwChewStacks ?? []).length,
  stacks: window.__pwChewStacks ?? [],
}));
check("exactly ONE chew card for the whole burst", card.count === 1,
  `${card.count} · gm=${JSON.stringify(chewSeen)} · player=${JSON.stringify(plSide)}${card.count === 1 ? "" : " · " + JSON.stringify({ all: card.all, activeUsers: card.activeUsers })}`);
check("the card totals the burst (30)", /absorbed 30/.test(card.content), card.content.replace(/<[^>]+>/g, " ").slice(0, 200));
check("the card lists one line per debiting round", (card.content.match(/<li>/g) ?? []).length === 3, String((card.content.match(/<li>/g) ?? []).length));
check("the card's round lines carry the falling structure", /16 \/ 30/.test(card.content) && /2 \/ 30/.test(card.content), card.content.replace(/<[^>]+>/g, " ").slice(0, 300));
check("the card names the round the object gave out on (3)", /gave out on round 3/.test(card.content), card.content.replace(/<[^>]+>/g, " ").slice(0, 300));
check("the card names the object", /__PWX__CarBody/.test(card.content));

/* ── Negative: a window with no attacker seeds nothing and debits nothing ── */
const poolBefore = await gm.page.evaluate(async ({ behaviorUuid }) => {
  const b = await fromUuid(behaviorUuid);
  await b.update({ system: { pool: 20, destroyed: false } });   // stand it back up for the negative
  return Number(b.system.pool);
}, setup);
check("object stood back up for the negative case (20)", poolBefore === 20, String(poolBefore));

await pl.page.evaluate(async ({ npcId, tTokId }) => {
  const { DamageDialog } = await import("/modules/cp2020-augmented/module/combat/DamageDialog.js");
  window.__pwDlg2 = new DamageDialog({ areaDamages: { Torso: [{ damage: 6 }] }, targetTokenId: tTokId }, game.actors.get(npcId));
  await window.__pwDlg2.render(true);
}, setup);
await pl.page.waitForSelector('.damage-dialog button[data-action="applyDamage"]', { timeout: 10000 });
const noSeed = await pl.page.evaluate(() => document.querySelector('form.damage-dialog input[name="coverSP"]')?.value ?? null);
check("no attacker token: Cover SP stays 0", noSeed === "0", String(noSeed));
await pl.page.click('.damage-dialog button[data-action="applyDamage"]');
await new Promise(r => setTimeout(r, 3000));
const untouched = await gm.page.evaluate(async ({ behaviorUuid }) => Number((await fromUuid(behaviorUuid)).system.pool), setup);
check("no attacker token: nothing is debited (structure still 20)", untouched === 20, String(untouched));

/* ── The AREA path's own relay: a player resolves a corridor that crosses the object ──────────────
 * Ruling 2026-08-25 (soak-and-chew): a figure behind a cover-VALUED object is IN the corridor and
 * takes its damage with that object's SP folded outermost, and the object is debited ONCE for the
 * whole application. Both writes are GM-side, and a PLAYER pressing the corridor's apply control is
 * the cross-client half — the press relays, the GM executes, and the wear has to land all the same.
 */
const areaPrev = await gm.page.evaluate(async ({ behaviorUuid }) => {
  const SCOPE = "cp2020-augmented";
  const keep = {};
  for (const k of ["headHitDoubling", "limbModel", "damageArmorMode"]) {
    try { keep[k] = game.settings.get(SCOPE, k); } catch (e) { /* absent */ }
  }
  try { await game.settings.set(SCOPE, "headHitDoubling", false); } catch (e) {}
  try { await game.settings.set(SCOPE, "limbModel", "core"); } catch (e) {}
  try { await game.settings.set(SCOPE, "damageArmorMode", "full"); } catch (e) {}
  const b = await fromUuid(behaviorUuid);
  await b.update({ system: { pool: 30, destroyed: false } });
  return keep;
}, setup);

const areaPlaced = await gm.page.evaluate(async ({ shooterId, tTokId, npcId, firerName }) => {
  const SCOPE = "cp2020-augmented";
  const scene = game.scenes.active;
  const G = scene.grid.size;
  const hooks = await import(`/modules/${SCOPE}/module/combat/damage-hooks.js`);
  const grid = await import(`/modules/${SCOPE}/module/vehicle/vehicle-grid.js`);
  const ppm = grid.metersToPixels(scene, 1) || 1;
  // The firer is named by NAME, not by role: the ruling on who may resolve a corridor lets the firer's
  // own user press it, and this rig's second seat is not guaranteed to be role 1 — picking by role
  // recorded a DIFFERENT user as the firer and the render gate then stripped the control from the very
  // client the leg drives (cost a red pass 2026-08-25).
  const player = game.users.find(u => u.name === firerName) ?? game.users.find(u => u.role === 1);
  // A CONSTANT roll, so every number below is exact: 18 raw, the object's SP 10 folded outermost.
  await hooks._placeSpreadZone({
    attackerId: shooterId, weaponName: "__PWX__Corridor", targetTokenId: tTokId,
    areaDamages: { Torso: [{ damage: 18 }] }, shotsFired: 1, shotsHit: 1,
    firedByUserId: player?.id ?? game.user.id,
    caliber: "00", modifier: "standard", spreadMode: "single",
    spreadDamageShort: "18", spreadDamageMedium: "18", spreadDamageLong: "18",
    spreadWidthShort: (2 * G) / ppm, spreadWidthMedium: (2 * G) / ppm, spreadWidthLong: (2 * G) / ppm,
    spreadRangeM: (40 * G) / ppm,
    spreadAim: { angleDeg: 0, reachM: (10 * G) / ppm, lengthM: (10.5 * G) / ppm, widthM: (2 * G) / ppm, band: "Medium" },
  });
  let zone = null;
  for (let i = 0; i < 60 && !zone; i++) {
    zone = [...(scene.regions ?? []), ...(scene.templates ?? [])].find(r => r.flags?.[SCOPE]?.isSpreadZone === true) ?? null;
    if (!zone) await new Promise(r => setTimeout(r, 250));
  }
  const card = zone ? game.messages.get(String(zone.flags?.[SCOPE]?.cardMessageId ?? "")) : null;
  return {
    zoneId: zone?.id ?? null,
    cardHtml: card?.content ?? "",
    hpBefore: Number(game.actors.get(npcId)?.system?.damage) || 0,
    msgIds: game.messages.map(m => m.id),
  };
}, { ...setup, firerName: pl.userName });
check("area relay: the corridor was placed and named its card", !!areaPlaced.zoneId && !!areaPlaced.cardHtml, String(areaPlaced.zoneId));
check("area relay: the card row states the object and the SP the apply will fold",
  /__PWX__Victim/.test(areaPlaced.cardHtml) && /__PWX__CarBody/.test(areaPlaced.cardHtml) && /SP 10/.test(areaPlaced.cardHtml),
  areaPlaced.cardHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 220));
check("area relay: the card is not worded as an exemption", !/exempt/i.test(areaPlaced.cardHtml));

const pressed = await pl.page.evaluate(async (zoneId) => {
  for (let i = 0; i < 60; i++) {
    const btn = document.querySelector(`.cp-confirm-spread-zone[data-template-id="${zoneId}"]`);
    if (btn) { btn.click(); return { clicked: true }; }
    await new Promise(r => setTimeout(r, 250));
  }
  const msg = [...game.messages].find(m => (m.content ?? "").includes(zoneId));
  return {
    clicked: false,
    cardInLog: !!msg,
    cardRendered: !!document.querySelector(`[data-message-id="${msg?.id}"]`),
    anyControls: document.querySelectorAll(".cp-confirm-spread-zone").length,
    me: game.user.name, role: game.user.role,
  };
}, areaPlaced.zoneId);
check("area relay: the player's client offered the apply control and it was pressed",
  pressed.clicked === true, JSON.stringify(pressed));

const areaAfter = await gm.page.evaluate(async ({ behaviorUuid, npcId, placed }) => {
  const seen = new Set(placed.msgIds);
  const read = async () => {
    const b = await fromUuid(behaviorUuid);
    return {
      pool: Number(b?.system?.pool), sp: Number(b?.system?.sp),
      hp: Number(game.actors.get(npcId)?.system?.damage) || 0,
      // Scoped to this object for the reason the burst's own count is — see that leg's note.
      chewCards: game.messages.filter(m => !seen.has(m.id) && m.content.includes("cp-cover-chew")
        && m.content.includes("__PWX__CarBody")).length,
    };
  };
  let prev = null, stable = 0;
  for (let i = 0; i < 80; i++) {
    const now = await read();
    const moved = now.pool !== 30 && now.hp !== placed.hpBefore;
    stable = (prev && now.pool === prev.pool && now.hp === prev.hp) ? stable + 1 : 0;
    if (moved && stable >= 3) return now;
    prev = now; await new Promise(r => setTimeout(r, 250));
  }
  return { timeout: true, ...(await read()) };
}, { ...setup, placed: areaPlaced });
check("area relay: both GM-side writes landed (no timeout)", !areaAfter.timeout, JSON.stringify(areaAfter));
check("area relay: the object is debited by the corridor's own 18, once (30 -> 12)",
  areaAfter.pool === 12, `pool ${areaAfter.pool}`);
check("area relay: its SP never moved while it stood", areaAfter.sp === 10, String(areaAfter.sp));
check("area relay: the figure took 18 less the folded SP 10 = 8 (less BTM, floor 1)",
  areaAfter.hp - areaPlaced.hpBefore === Math.max(1, 8 - setup.btm),
  `delta ${areaAfter.hp - areaPlaced.hpBefore}, expected ${Math.max(1, 8 - setup.btm)} (btm ${setup.btm})`);
check("area relay: exactly ONE structure card for the whole application", areaAfter.chewCards === 1, String(areaAfter.chewCards));

await gm.page.evaluate(async (keep) => {
  const SCOPE = "cp2020-augmented";
  for (const [k, v] of Object.entries(keep ?? {})) { try { await game.settings.set(SCOPE, k, v); } catch (e) {} }
  const scene = game.scenes.active;
  for (const r of [...(scene?.regions ?? []), ...(scene?.templates ?? [])]) {
    if (r.flags?.["cp2020-augmented"]?.isSpreadZone) await r.delete().catch(() => {});
  }
}, areaPrev).catch(() => {});

/* ── The cover-only control, pressed from a PLAYER's client ───────────────────────────────────────
 * Ruling 2026-08-26 (call 4): a button beside Apply that charges the picked cover object the window's
 * RAW damage and writes NOTHING to the target. It is a GM-side document write like every other chew, so
 * a player's press has to travel the same relay — that is the half only two sessions can prove.
 */
const btnPrep = await gm.page.evaluate(async ({ behaviorUuid, npcId }) => {
  const b = await fromUuid(behaviorUuid);
  await b.update({ system: { pool: 30, destroyed: false } });
  return { pool: Number(b.system.pool), hp: Number(game.actors.get(npcId)?.system?.damage) || 0,
           msgIds: game.messages.map(m => m.id) };
}, setup);
check("cover-only: object stood back up for the leg (30)", btnPrep.pool === 30, String(btnPrep.pool));

const btnSeen = await pl.page.evaluate(async ({ npcId, tTokId, aTokId }) => {
  const { DamageDialog } = await import("/modules/cp2020-augmented/module/combat/DamageDialog.js");
  // 7 raw, so the debit is unmistakably the WINDOW'S number and not the armour-reduced remainder.
  window.__pwDlg3 = new DamageDialog(
    { areaDamages: { Torso: [{ damage: 7 }] }, targetTokenId: tTokId, attackerTokenId: aTokId,
      weaponName: "Keeper Cover-Only" },
    game.actors.get(npcId));
  await window.__pwDlg3.render(true);
  for (let i = 0; i < 40; i++) {
    const el = window.__pwDlg3.element?.querySelector('button[data-action="chewCoverOnly"]');
    if (el) return { offered: true, sp: window.__pwDlg3.element?.querySelector("input[name='coverSP']")?.value ?? null };
    await new Promise(r => setTimeout(r, 150));
  }
  return { offered: false, sp: window.__pwDlg3.element?.querySelector("input[name='coverSP']")?.value ?? null };
}, setup);
check("cover-only: the control is offered on the player's window", btnSeen.offered === true, JSON.stringify(btnSeen));

await pl.page.evaluate(() => window.__pwDlg3.element.querySelector('button[data-action="chewCoverOnly"]').click());

const btnAfter = await gm.page.evaluate(async ({ behaviorUuid, npcId }) => {
  for (let i = 0; i < 60; i++) {
    const b = await fromUuid(behaviorUuid);
    const pool = Number(b?.system?.pool);
    if (pool !== 30) {
      await new Promise(r => setTimeout(r, 600));
      const b2 = await fromUuid(behaviorUuid);
      return {
        pool: Number(b2?.system?.pool), sp: Number(b2?.system?.sp),
        hp: Number(game.actors.get(npcId)?.system?.damage) || 0,
      };
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return { timeout: true, pool: 30, hp: Number(game.actors.get(npcId)?.system?.damage) || 0 };
}, setup);
check("cover-only: the relay reached the GM (no timeout)", !btnAfter.timeout, JSON.stringify(btnAfter));

const btnFinal = await gm.page.evaluate(async ({ behaviorUuid, npcId }) => {
  const b = await fromUuid(behaviorUuid);
  return { pool: Number(b?.system?.pool), sp: Number(b?.system?.sp),
           hp: Number(game.actors.get(npcId)?.system?.damage) || 0 };
}, setup);
check("cover-only: the object is debited the window's raw 7 (30 → 23)", btnFinal.pool === 23, `pool ${btnFinal.pool}`);
check("cover-only: ⛔ the target took nothing", btnFinal.hp === btnPrep.hp, `${btnPrep.hp} → ${btnFinal.hp}`);
check("cover-only: SP is untouched (the object still stands)", btnFinal.sp === 10, String(btnFinal.sp));

const btnCard = await gm.page.evaluate(async (before) => {
  const seen = new Set(before);
  const cards = game.messages.filter(m => !seen.has(m.id) && m.content.includes("cp-cover-chew")
    && m.content.includes("__PWX__CarBody"));
  return { count: cards.length, content: cards[cards.length - 1]?.content ?? "" };
}, btnPrep.msgIds);
check("cover-only: exactly one structure card", btnCard.count === 1, String(btnCard.count));
check("cover-only: the card names the object and the amount",
  /__PWX__CarBody/.test(btnCard.content) && /absorbed 7 damage/.test(btnCard.content),
  btnCard.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160));

const btnLatch = await pl.page.evaluate(async () => {
  const again = window.__pwDlg3.element?.querySelector('button[data-action="chewCoverOnly"]');
  if (again) { again.click(); await new Promise(r => setTimeout(r, 1200)); return { offered: true }; }
  return { offered: false, spent: !!window.__pwDlg3.element?.querySelector("button.cp-chew-cover-only[disabled]") };
});
check("cover-only: the control is spent after one press", btnLatch.offered === false, JSON.stringify(btnLatch));
const btnNoDouble = await gm.page.evaluate(async ({ behaviorUuid }) =>
  Number((await fromUuid(behaviorUuid))?.system?.pool), setup);
check("cover-only: no second debit (still 23)", btnNoDouble === 23, String(btnNoDouble));
await pl.page.evaluate(() => window.__pwDlg3?.close?.()).catch(() => {});

/* ── cleanup + rig hygiene ── */
await gm.page.evaluate(async ({ sceneId, prevActiveId }) => {
  for (const app of [...foundry.applications.instances.values()]) {
    if (app.constructor?.name === "DamageDialog") await app.close().catch(() => {});
  }
  for (const a of [...game.actors]) if (a.name?.startsWith("__PWX__")) await a.delete().catch(() => {});
  for (const m of [...game.messages].filter(x => x.content.includes("__PWX__") || x.content.includes("cp-cover-chew")
    || /cp-confirm-spread-zone|cp-spread-resolve-list|cp-spread-result-list/.test(x.content ?? ""))) await m.delete().catch(() => {});
  const prev = prevActiveId ? game.scenes.get(prevActiveId) : null;
  if (prev) { await prev.activate().catch(() => {}); for (let i = 0; i < 150 && canvas?.scene?.id !== prev.id; i++) await new Promise(r => setTimeout(r, 200)); }
  await game.scenes.get(sceneId)?.delete().catch(() => {});
}, setup).catch(e => console.log(`  (cleanup warning: ${e.message})`));

const leftovers = await gm.page.evaluate(({ prevActiveId }) => ({
  probeScenes: game.scenes.filter(s => s.name?.startsWith("__PWX__")).length,
  actors: game.actors.filter(a => a.name?.startsWith("__PWX__")).length,
  activeRestored: (game.scenes.active?.id ?? null) === prevActiveId ? 0 : 1,
}), setup);
check("fixtures swept and the previously active scene handed back", Object.values(leftovers).every(v => v === 0), JSON.stringify(leftovers));

check("0 GM console errors", gmErrors.length === 0, gmErrors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
