/**
 * GM SESSION PRIMARY — the two-session election (:30004, official 1.1.1 + module).
 *
 * ⛔ THE DEFECT UNDER TEST. Every relayed-write guard in the module compared a USER
 * (`game.users.activeGM?.id === game.user.id`), so a referee with the world open in TWO TABS passed
 * the guard in both and every relayed datagram was handled twice. The roster shows one "Gamemaster"
 * either way, so nothing on screen said so; and because the wound-track write is read-modify-write,
 * the duplicate SWALLOWS its twin, which is why counting hit points UNDER-reports the fault.
 *
 * ⭐ THE REPRODUCTION VEHICLE, and why it is two TABS and not two contexts: measured here, two pages
 * of ONE browser context both reach `game.ready` as the same Gamemaster, and the first is not
 * evicted — the browser's session cookie already authenticates the second. A second browser CONTEXT
 * cannot do it at all (the join form disables an already-connected user's option), which is also why
 * this suite never touches the join form for the second session.
 *
 * Sections
 *   A · session identity — what does and does not tell two tabs apart on this core build
 *   B · presence + election — one primary among two sessions, and it is the lowest id
 *   C · BY VALUE — one player emit, one card and one full wound-track total, with two sessions up
 *   D · handoff — the primary tab closes and the survivor takes over
 *   E · sweep — no bare user-id seat comparison survives outside the election module
 *
 * Run from tests/:  FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig \
 *                   node cp2020-augmented-gm-session-primary.mjs
 */
import { chromium } from "@playwright/test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
/** The SERVED copy — the bytes the rig actually runs. Hash-verified against the repo by the lane. */
const SERVE_MODULE_DIR = process.env.CP_SERVE_MODULE_DIR
  || "C:/Users/randa/FoundryVTT-Vanilla-Data/Data/modules/cp2020-augmented/module";

const FIXTURE = "__PW__GMSESS Target";
const HITS = [
  { location: "Torso",    netDamage: 4, afterSP: 4, penetrates: true, btmResult: 4 },
  { location: "R Arm",    netDamage: 5, afterSP: 5, penetrates: true, btmResult: 5 },
  { location: "L Arm",    netDamage: 6, afterSP: 6, penetrates: true, btmResult: 6 },
];
const HIT_TOTAL = HITS.reduce((n, h) => n + h.netDamage, 0);   // 15

/* ── harness ─────────────────────────────────────────────────────────────────────────────────── */

const checks = [];
const notes = [];
function check(name, pass, detail = "") {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? "ok " : "FAIL"}  ${name}${detail ? `   [${detail}]` : ""}`);
}
const section = (t) => console.log(`\n── ${t} ──`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 25_000 }); return u.l; }
    catch {
      await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {});
      await sel.waitFor({ state: "visible" }).catch(() => {});
    }
  }
  throw new Error("could not join as " + u.l);
}

/** A SECOND session of the already-joined user: a new tab in the same context, cookie only. */
async function openSecondTab(context) {
  const page = await context.newPage();
  await page.goto(BASE + "/game", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 30_000 });
  return page;
}

/** The election module's own snapshot, read out of the live page. */
const readElection = (page) => page.evaluate(async () => {
  const m = await import("/modules/cp2020-augmented/module/gm-session-primary.js");
  return m.gmSessionPrimaryState();
});

/** What core itself offers as an identity, measured rather than assumed. */
const readCoreIdentity = (page) => page.evaluate(() => ({
  userId: game.user?.id ?? null,
  socketId: game.socket?.id ?? null,
  serverSessionId: game.socket?.session?.sessionId ?? null,
  activeGMUserId: game.users?.activeGM?.id ?? null,
  gamemasterCount: game.users.filter((u) => u.active && u.isGM).length,
}));

const pageErrors = [];
const consoleErrors = [];
function watch(page, label) {
  page.on("pageerror", (e) => pageErrors.push(`${label}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`${label}: ${m.text()}`); });
}

/* ── the measurement: one relayed apply, counted by cards AND by the wound track ──────────────── */

async function resetFixture(gmPage) {
  return gmPage.evaluate(async (name) => {
    let a = game.actors.find((x) => x.name === name);
    if (!a) a = await Actor.create({ name, type: "character" });
    await a.update({ "system.damage": 0 }, { render: false });
    await a.unsetFlag("cp2020-augmented", "stabilized").catch(() => {});
    return { actorId: a.id, damage: Number(a.system.damage) || 0, messages: game.messages.size };
  }, FIXTURE);
}

async function relayFromPlayer(playerPage, actorId, hits) {
  await playerPage.evaluate(({ actorId, hits }) => {
    game.socket.emit("module.cp2020-augmented", {
      type: "applyDamage",
      mode: "resolved",
      targetActorId: actorId,
      resolvedHits: hits,
      requesterId: game.user.id,
      armorMode: "full",
      ablate: false,
      damageType: "bullet",
      fxSilent: true,
    });
  }, { actorId, hits });
}

/** Settle, then read what landed. `baseline` is the reading from resetFixture. */
async function readOutcome(gmPage, actorId, baseline, settleMs = 6000) {
  await sleep(settleMs);
  return gmPage.evaluate(({ actorId, before }) => {
    const a = game.actors.get(actorId);
    return {
      damage: Number(a?.system?.damage) || 0,
      cards: game.messages.size - before,
    };
  }, { actorId, before: baseline.messages });
}

/* ── E · the sweep, over the SERVED bytes ────────────────────────────────────────────────────── */

function walkJs(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkJs(p, out);
    else if (e.endsWith(".js")) out.push(p);
  }
  return out;
}

/* ── run ─────────────────────────────────────────────────────────────────────────────────────── */

const browser = await chromium.launch({ headless: true });
let gmCtx = null;
let tab1 = null;
let tab2 = null;
let playerPage = null;

try {
  gmCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  tab1 = await gmCtx.newPage();
  watch(tab1, "gm-tab1");
  await joinAs(tab1, /^gamemaster$/i, [GM_PW]);
  await tab1.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});

  const playerCtx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  playerPage = await playerCtx.newPage();
  watch(playerPage, "player");
  await joinAs(playerPage, /Test User 1/i, ["", GM_PW]);

  /* ── C1 · the single-session CONTROL (the negative case for every C leg) ── */
  section("C1 · one GM session — the control reading");
  const base1 = await resetFixture(tab1);
  await relayFromPlayer(playerPage, base1.actorId, HITS);
  const out1 = await readOutcome(tab1, base1.actorId, base1);
  check("C1: the relayed rows land their full declared total once",
    out1.damage === HIT_TOTAL, `damage=${out1.damage} expected=${HIT_TOTAL}`);
  check("C1: the apply posts a bounded number of cards",
    out1.cards >= 1, `cards=${out1.cards}`);
  notes.push(`single-session baseline: damage=${out1.damage} cards=${out1.cards}`);

  /* ── A · what tells two sessions apart ── */
  section("A · session identity on this core build");
  tab2 = await openSecondTab(gmCtx);
  watch(tab2, "gm-tab2");
  await tab2.waitForFunction(() => window.canvas?.ready === true, undefined, { timeout: 30_000 }).catch(() => {});
  await sleep(3000);   // presence round trip

  const id1 = await readCoreIdentity(tab1);
  const id2 = await readCoreIdentity(tab2);
  check("A: two tabs of one browser both hold the world as the same GM user",
    !!id1.userId && id1.userId === id2.userId, `userId ${id1.userId} / ${id2.userId}`);
  check("A: the roster still shows exactly ONE connected Gamemaster",
    id1.gamemasterCount === 1, `active GM users=${id1.gamemasterCount}`);
  check("A: core's cookie session id is the SAME in both tabs (unusable as a session identity)",
    !!id1.serverSessionId && id1.serverSessionId === id2.serverSessionId,
    `${id1.serverSessionId} / ${id2.serverSessionId}`);
  check("A: the socket connection id DIFFERS between the tabs",
    !!id1.socketId && !!id2.socketId && id1.socketId !== id2.socketId,
    `${id1.socketId} / ${id2.socketId}`);

  const el1 = await readElection(tab1);
  const el2 = await readElection(tab2);
  check("A: the election module mints a distinct id per tab",
    !!el1.sessionId && !!el2.sessionId && el1.sessionId !== el2.sessionId,
    `${el1.sessionId} / ${el2.sessionId}`);

  /* ── B · presence + election ── */
  section("B · presence and election");
  check("B: tab1 has observed tab2 as a peer",
    el1.peers.some((p) => p.sessionId === el2.sessionId), `peers=${JSON.stringify(el1.peers.map(p => p.sessionId))}`);
  check("B: tab2 has observed tab1 as a peer",
    el2.peers.some((p) => p.sessionId === el1.sessionId), `peers=${JSON.stringify(el2.peers.map(p => p.sessionId))}`);
  check("B: exactly ONE of the two sessions reports itself primary",
    (el1.isPrimary ? 1 : 0) + (el2.isPrimary ? 1 : 0) === 1,
    `tab1=${el1.isPrimary} tab2=${el2.isPrimary}`);
  const lowest = el1.sessionId < el2.sessionId ? el1 : el2;
  check("B: the primary is the lexicographically lowest session id",
    lowest.isPrimary === true, `lowest=${lowest.sessionId} isPrimary=${lowest.isPrimary}`);
  check("B: the heartbeat runs in both sessions while a peer is known",
    el1.heartbeat === true && el2.heartbeat === true, `tab1=${el1.heartbeat} tab2=${el2.heartbeat}`);
  check("B: both sessions still agree on the elected GM USER (the old answer is preserved)",
    id1.activeGMUserId === id1.userId && id2.activeGMUserId === id2.userId,
    `activeGM=${id1.activeGMUserId}`);

  /* ── C2 · BY VALUE, with two sessions up ── */
  section("C2 · two GM sessions — one emit, one application");
  const base2 = await resetFixture(tab1);
  await relayFromPlayer(playerPage, base2.actorId, HITS);
  const out2 = await readOutcome(tab1, base2.actorId, base2);
  check("C2: ⭐ the wound track carries the FULL declared total, not an interleaved subset",
    out2.damage === HIT_TOTAL, `damage=${out2.damage} expected=${HIT_TOTAL}`);
  check("C2: ⭐ the apply posts the same number of cards as with one session",
    out2.cards === out1.cards, `two-session=${out2.cards} one-session=${out1.cards}`);

  /* ── D · handoff on tab close ── */
  section("D · the primary session closes");
  const primaryTab = el1.isPrimary ? tab1 : tab2;
  const survivorTab = el1.isPrimary ? tab2 : tab1;
  const survivorIsTab1 = survivorTab === tab1;
  await primaryTab.close();
  if (primaryTab === tab1) tab1 = null; else tab2 = null;
  await sleep(3000);

  const elS = await readElection(survivorTab);
  check("D: the survivor has dropped the departed peer",
    elS.peers.length === 0, `peers=${elS.peers.length}`);
  check("D: the survivor is now the primary session",
    elS.isPrimary === true, `isPrimary=${elS.isPrimary}`);
  check("D: the heartbeat stands down once no peer remains",
    elS.heartbeat === false, `heartbeat=${elS.heartbeat}`);

  const base3 = await resetFixture(survivorTab);
  await relayFromPlayer(playerPage, base3.actorId, HITS);
  const out3 = await readOutcome(survivorTab, base3.actorId, base3);
  check("D: the relay still lands after the handoff",
    out3.damage === HIT_TOTAL, `damage=${out3.damage} expected=${HIT_TOTAL}`);
  check("D: and it lands exactly once",
    out3.cards === out1.cards, `cards=${out3.cards} baseline=${out1.cards}`);
  notes.push(`handoff survivor was ${survivorIsTab1 ? "tab1" : "tab2"}`);

  /* ── E · sweep the served bytes ── */
  section("E · no private seat comparison survives");
  const files = walkJs(SERVE_MODULE_DIR);
  const seatRe = /activeGM\s*\??\.\s*id\s*[!=]==\s*game\s*\??\.\s*user/;
  const offenders = [];
  for (const f of files) {
    const rel = f.replace(/\\/g, "/").split("/module/").slice(1).join("/module/");
    const text = readFileSync(f, "utf8");
    text.split("\n").forEach((line, i) => {
      if (seatRe.test(line)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  const allowed = offenders.filter((o) => o.startsWith("gm-session-primary.js"));
  check("E: zero bare seat comparisons outside the election module",
    offenders.length - allowed.length === 0, offenders.length ? offenders.join(" · ") : "0 sites");
  check("E: the sweep actually read the module tree",
    files.length > 50, `${files.length} served .js files`);

  // The two DELIBERATE exemptions: draw-only announcements that must reach every client, so they hold
  // no seat comparison AND do not import the election at all. Both must still SAY so at their site.
  const importRe = /^\s*import[^\n]*gm-session-primary/m;
  const fxDraw = readFileSync(join(SERVE_MODULE_DIR, "fx", "effects.js"), "utf8");
  const ttDraw = readFileSync(join(SERVE_MODULE_DIR, "fx", "trauma-team.js"), "utf8");
  check("E: the draw-only FX announcement stays guard-free (every client draws its own copy)",
    !seatRe.test(fxDraw) && !importRe.test(fxDraw), "fx/effects.js");
  check("E: the draw-only extraction announcement stays guard-free",
    !seatRe.test(ttDraw) && !importRe.test(ttDraw), "fx/trauma-team.js");
  check("E: both exemptions name the election they are exempt from, at their own site",
    /gm-session-primary\.js/.test(fxDraw) && /gm-session-primary\.js/.test(ttDraw),
    "exemption notes present");

  const electionSrc = readFileSync(join(SERVE_MODULE_DIR, "gm-session-primary.js"), "utf8");
  check("E: the election module documents why the cookie session id is unusable",
    /cookie-scoped session/i.test(electionSrc), "header note present");

} catch (e) {
  check("harness completed without throwing", false, String(e.message || e).slice(0, 300));
} finally {
  section("cleanup");
  const alive = tab1 ?? tab2;
  if (alive) {
    await alive.evaluate(async (name) => {
      for (const a of game.actors.filter((x) => x.name === name)) await a.delete().catch(() => {});
    }, FIXTURE).catch(() => {});
  }
  check("0 page errors", pageErrors.length === 0, pageErrors.slice(0, 4).join(" | "));
  check("0 console errors", consoleErrors.length === 0, consoleErrors.slice(0, 4).join(" | "));
  await browser.close().catch(() => {});
}

for (const n of notes) console.log(`  note: ${n}`);
const failed = checks.filter((c) => !c.pass);
console.log(`\nRESULT: ${failed.length ? "FAIL" : "PASS"} — ${checks.length - failed.length}/${checks.length}`);
for (const f of failed) console.log(`   FAIL  ${f.name}   [${f.detail}]`);
process.exit(failed.length ? 1 : 0);
