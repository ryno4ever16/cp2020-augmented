/**
 * KEEPER: the approved cyberware request, driven as ONE flow across TWO real sessions
 * (:30004, official 1.1.1 + module).
 *
 * The contract (ruled 2026-08-13): when a GM approves a player's REQUEST for cyberware, the
 * install-or-buy-only choice belongs to the BUYER — it is their Humanity and their wound track — and
 * the surgery confirmation, with the referee's own two knobs, belongs to the GM. Neither half can be
 * seen from one client, so the whole round trip runs here as one flow:
 *
 *   §1  player asks (published-shops-only routes a catalog buy through a request)
 *   §2  GM approves — and gets NO install dialog; the choice card lands on the PLAYER
 *   §3  player picks Install — nothing is charged yet, and the GM gets the surgery card
 *   §4  GM confirms — part + surgery debited together, item embedded EQUIPPED, Humanity rolled,
 *       surgical damage applied, summary card posted
 *   §5  second run, player picks Buy only — part price only, item embedded UNEQUIPPED, no GM card
 *   §6  0 console errors on both sessions
 *
 * Every gesture is the real DOM button on the client that owns it, not a function call, because the
 * thing under test is WHICH client is asked.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 30_000 });
  const users = await sel.locator("option").evaluateAll(o =>
    o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  const u = users.find(x => match.test(x.l));
  if (!u) throw new Error("no user matching " + match);
  for (const pw of passwords) {
    await sel.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([
      page.waitForNavigation({ url: /\/game/, timeout: 20_000 }).catch(() => {}),
      page.locator('button[name="join"]').click(),
    ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 20_000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

const browser = await chromium.launch({ headless: true });
const gmErrors = [], pcErrors = [];
const collect = (page, bag) => {
  page.on("pageerror", e => bag.push(String(e?.message || e)));
  page.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(m.text())) bag.push(m.text()); });
};

// Press the LAST matching control in this client's chat log. Playwright's own click refuses an
// element the log has scrolled out of the viewport (the sidebar's scroller does not cooperate with
// scrollIntoViewIfNeeded), so the click is dispatched in the page — still the element's real click
// event through its real listener, which is the thing under test.
async function pressInLog(page, selector) {
  const hit = await page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)];
    const el = els[els.length - 1];
    if (!el) return false;
    el.click();
    return true;
  }, selector);
  if (!hit) throw new Error("no control matched " + selector);
}
const CARD = (cls) => `.chat-message .${cls}`;

try {
  const gm = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  collect(gm, gmErrors);
  await joinAs(gm, /^gamemaster$/i, [GM_PW]);

  // ── setup, GM side ────────────────────────────────────────────────────────────────────────────
  const S = await gm.evaluate(async (SCOPE) => {
    const out = {};
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__CYBER"))) await a.delete().catch(() => {});
    for (const m of [...game.messages].filter(m => /cp-shop-request|cp-shop-cyber/.test(m.content ?? ""))) await m.delete().catch(() => {});

    const player = game.users.find(u => u.role === 1 && u.name);
    const buyer = await Actor.create({ name: "__PW__CYBER Buyer", type: "character", system: { eurobucks: 100000 } });
    await buyer.update({ [`ownership.${player.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });

    // A real catalog piece with a real surgery code — the surgery has to cost something and hurt,
    // or §4's arithmetic proves nothing.
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    const all = await C.getCatalogIndex();
    let picked = null;
    for (const row of all.filter(r => r.category === "Cyberware" && r.cost > 0)) {
      const doc = await game.packs.get(row.packId)?.getDocument(row.id);
      const code = String(doc?.system?.surgCode ?? "").trim().toUpperCase();
      if (!doc || !["M", "MA", "CR"].includes(code)) continue;
      const hc = String(doc.system?.humanityCost ?? "");
      if (!hc || hc === "0") continue;
      picked = { packId: row.packId, itemId: row.id, name: doc.name, cost: row.cost, surgCode: code, humanityCost: hc };
      break;
    }
    const prevSource = game.settings.get(SCOPE, "shopBuySource");
    await game.settings.set(SCOPE, "shopBuySource", "shops");   // published-shops-only → a player buy asks
    return { ...out, playerName: player.name, playerId: player.id, buyerId: buyer.id, picked, prevSource };
  }, SCOPE);

  check("a priced cyberware piece with a real surgery code was found in the catalog", !!S.picked,
    S.picked ? `${S.picked.name} ${S.picked.cost}eb code ${S.picked.surgCode} HC ${S.picked.humanityCost}` : "none");
  if (!S.picked) throw new Error("no suitable cyberware in the catalog");

  const SURGERY_COST = { M: 500, MA: 1500, CR: 2500 }[S.picked.surgCode];

  const pc = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  collect(pc, pcErrors);
  await joinAs(pc, new RegExp(`^${S.playerName}$`, "i"), ["", GM_PW]);
  await pc.waitForTimeout(2500);

  /* ─────────────────── §1 the player asks ─────────────────── */
  console.log("\n§1 the player asks");
  const asked = await pc.evaluate(async ({ SCOPE, buyerId, picked }) => {
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    const buyer = game.actors.get(buyerId);
    const before = new Set(game.messages.map(m => m.id));
    await C.purchaseCatalogItem(buyer, picked.packId, picked.itemId, { qty: 1 });
    await new Promise(r => setTimeout(r, 1200));
    const req = [...game.messages].filter(m => !before.has(m.id) && m.getFlag(SCOPE, "purchaseRequest"));
    return { requests: req.length, embedded: buyer.items.filter(i => i.name === picked.name).length, funds: Number(buyer.system.eurobucks) };
  }, { SCOPE, buyerId: S.buyerId, picked: S.picked });
  check("the player's catalog buy became a request, not a purchase", asked.requests === 1, String(asked.requests));
  check("nothing was embedded on the character yet", asked.embedded === 0, String(asked.embedded));
  check("nothing was charged yet", asked.funds === 100000, String(asked.funds));

  /* ─────────────────── §2 the GM approves; the CHOICE goes to the player ─────────────────── */
  console.log("\n§2 the GM approves");
  await gm.waitForTimeout(1500);
  await pressInLog(gm, `${CARD("cp-shop-request")} .cp-shop-request-btn.cp-approve`);
  await gm.waitForTimeout(2500);
  await pc.waitForTimeout(1500);

  const gmAfterApprove = await gm.evaluate((SCOPE) => ({
    installDialogs: [...foundry.applications.instances.values()].filter(a => a.element?.querySelector?.(".cp-cyber-install")).length,
    choiceCards: [...game.messages].filter(m => m.getFlag(SCOPE, "cyberChoice")).length,
    surgeryCards: [...game.messages].filter(m => m.getFlag(SCOPE, "cyberSurgery")).length,
  }), SCOPE);
  check("the GM is shown NO install dialog", gmAfterApprove.installDialogs === 0, String(gmAfterApprove.installDialogs));
  check("no surgery card exists yet — the buyer has not chosen", gmAfterApprove.surgeryCards === 0, String(gmAfterApprove.surgeryCards));

  const pcChoice = await pc.evaluate(({ SCOPE, playerId }) => {
    const cards = [...game.messages].filter(m => m.getFlag(SCOPE, "cyberChoice"));
    const c = cards[cards.length - 1];
    const job = c?.getFlag(SCOPE, "cyberChoice");
    return {
      count: cards.length, status: job?.status ?? null, partPrice: job?.partPrice ?? null,
      surgeryCost: job?.surgeryCost ?? null, whisperedToMe: !!c?.whisper?.includes(playerId),
      authoredByMe: c?.author?.id === playerId,
      visible: !!document.querySelector(".chat-message .cp-shop-cyber-choice"),
      // De-duplicated: this core paints a message in the sidebar log AND in its notification stack, so
      // every control has two live copies. Both are wired (the bind guard is per element); what the leg
      // is about is which controls exist, not how many times the log draws them.
      buttons: [...new Set([...document.querySelectorAll(".chat-message .cp-shop-cyber-choice-btn")].map(b => b.dataset.action))],
    };
  }, { SCOPE, playerId: S.playerId });
  check("the choice card reached the buying player", pcChoice.count === 1 && pcChoice.whisperedToMe, `${pcChoice.count} whispered=${pcChoice.whisperedToMe}`);
  check("and it is rendered with both buttons on their client",
    pcChoice.visible && pcChoice.buttons.join(",") === "install,buyOnly", pcChoice.buttons.join(","));
  check("the card is authored by the player, so their answer can close it", pcChoice.authoredByMe, String(pcChoice.authoredByMe));
  check("the card carries the approved part price", pcChoice.partPrice === S.picked.cost, `${pcChoice.partPrice} vs ${S.picked.cost}`);
  check("and the surgery cost its code prices", pcChoice.surgeryCost === SURGERY_COST, `${pcChoice.surgeryCost} vs ${SURGERY_COST}`);

  /* ─────────────────── §3 the player picks Install ─────────────────── */
  console.log("\n§3 the player picks Install");
  await pressInLog(pc, `${CARD("cp-shop-cyber-choice")} .cp-shop-cyber-choice-btn[data-action="install"]`);
  await pc.waitForTimeout(2500);
  await gm.waitForTimeout(2000);

  const afterChoice = await pc.evaluate(({ SCOPE, buyerId }) => {
    const buyer = game.actors.get(buyerId);
    const cards = [...game.messages].filter(m => m.getFlag(SCOPE, "cyberChoice"));
    return {
      funds: Number(buyer.system.eurobucks),
      items: buyer.items.filter(i => i.type === "cyberware").length,
      choiceStatus: cards[cards.length - 1]?.getFlag(SCOPE, "cyberChoice")?.status ?? null,
    };
  }, { SCOPE, buyerId: S.buyerId });
  check("choosing Install charges nothing on the player's side", afterChoice.funds === 100000, String(afterChoice.funds));
  check("and stocks nothing yet", afterChoice.items === 0, String(afterChoice.items));
  check("the choice card closes as awaiting the operation", afterChoice.choiceStatus === "awaitingSurgery", String(afterChoice.choiceStatus));

  const gmSurgery = await gm.evaluate((SCOPE) => {
    const cards = [...game.messages].filter(m => m.getFlag(SCOPE, "cyberSurgery"));
    return {
      count: cards.length,
      status: cards[cards.length - 1]?.getFlag(SCOPE, "cyberSurgery")?.status ?? null,
      visible: !!document.querySelector(".chat-message .cp-shop-cyber-surgery"),
      knobs: [...new Set([...document.querySelectorAll(".chat-message .cp-shop-cyber-surgery input[type=checkbox]")].map(i => i.name))],
    };
  }, SCOPE);
  check("the surgery card reached the GM", gmSurgery.count === 1 && gmSurgery.status === "pending", `${gmSurgery.count}/${gmSurgery.status}`);
  check("and carries the referee's own two knobs", gmSurgery.visible && gmSurgery.knobs.join(",") === "rollHumanity,applyDamage", gmSurgery.knobs.join(","));

  /* ─────────────────── §4 the GM confirms the operation ─────────────────── */
  console.log("\n§4 the GM confirms");
  await pressInLog(gm, `${CARD("cp-shop-cyber-surgery")} .cp-shop-cyber-surgery-btn[data-action="operate"]`);
  await gm.waitForTimeout(3500);

  const done = await gm.evaluate(({ SCOPE, buyerId, name }) => {
    const buyer = game.actors.get(buyerId);
    const item = buyer.items.find(i => i.name === name && i.type === "cyberware");
    return {
      funds: Number(buyer.system.eurobucks),
      hasItem: !!item,
      equipped: item?.system?.equipped === true,
      humanityLoss: Number(item?.system?.humanityLoss ?? 0),
      damage: Number(buyer.system?.damage ?? 0),
      summary: [...game.messages].filter(m => (m.content ?? "").includes("surgical damage") && (m.content ?? "").includes(name)).length,
      surgeryStatus: [...game.messages].filter(m => m.getFlag(SCOPE, "cyberSurgery")).pop()?.getFlag(SCOPE, "cyberSurgery")?.status ?? null,
    };
  }, { SCOPE, buyerId: S.buyerId, name: S.picked.name });
  const expectCharge = S.picked.cost + SURGERY_COST;
  check("part and surgery are debited together, by value",
    done.funds === 100000 - expectCharge, `${done.funds} (expected ${100000 - expectCharge} = 100000 − ${S.picked.cost} − ${SURGERY_COST})`);
  check("the piece is embedded on the character", done.hasItem, String(done.hasItem));
  check("and it is EQUIPPED — the operation happened", done.equipped, String(done.equipped));
  check("the Humanity loss was rolled onto the item", done.humanityLoss > 0, String(done.humanityLoss));
  check("the surgical damage reached the wound track", done.damage > 0, String(done.damage));
  check("one summary card was posted, naming the piece", done.summary === 1, String(done.summary));
  check("the surgery card closed as done", done.surgeryStatus === "done", String(done.surgeryStatus));

  /* ─────────────────── §5 the same round trip, answered Buy only ─────────────────── */
  console.log("\n§5 the buyer answers Buy only");
  await gm.evaluate(async ({ SCOPE, buyerId }) => {
    const buyer = game.actors.get(buyerId);
    await buyer.deleteEmbeddedDocuments("Item", buyer.items.filter(i => i.type === "cyberware").map(i => i.id));
    await buyer.update({ "system.eurobucks": 100000, "system.damage": 0 });
    for (const m of [...game.messages].filter(m => /cp-shop-request|cp-shop-cyber/.test(m.content ?? ""))) await m.delete().catch(() => {});
  }, { SCOPE, buyerId: S.buyerId });
  await pc.waitForTimeout(1200);

  await pc.evaluate(async ({ SCOPE, buyerId, picked }) => {
    const C = await import(`/modules/${SCOPE}/module/shop/catalog.js`);
    await C.purchaseCatalogItem(game.actors.get(buyerId), picked.packId, picked.itemId, { qty: 1 });
  }, { SCOPE, buyerId: S.buyerId, picked: S.picked });
  await gm.waitForTimeout(2000);
  await pressInLog(gm, `${CARD("cp-shop-request")} .cp-shop-request-btn.cp-approve`);
  await gm.waitForTimeout(2500);
  await pc.waitForTimeout(1500);
  await pressInLog(pc, `${CARD("cp-shop-cyber-choice")} .cp-shop-cyber-choice-btn[data-action="buyOnly"]`);
  await pc.waitForTimeout(3000);
  await gm.waitForTimeout(2000);

  const bought = await gm.evaluate(({ SCOPE, buyerId, name }) => {
    const buyer = game.actors.get(buyerId);
    const item = buyer.items.find(i => i.name === name && i.type === "cyberware");
    return {
      funds: Number(buyer.system.eurobucks),
      hasItem: !!item,
      equipped: item?.system?.equipped === true,
      damage: Number(buyer.system?.damage ?? 0),
      surgeryCards: [...game.messages].filter(m => m.getFlag(SCOPE, "cyberSurgery")).length,
      choiceStatus: [...game.messages].filter(m => m.getFlag(SCOPE, "cyberChoice")).pop()?.getFlag(SCOPE, "cyberChoice")?.status ?? null,
    };
  }, { SCOPE, buyerId: S.buyerId, name: S.picked.name });
  check("buy-only debits the part price alone, by value",
    bought.funds === 100000 - S.picked.cost, `${bought.funds} (expected ${100000 - S.picked.cost})`);
  check("the piece is embedded", bought.hasItem, String(bought.hasItem));
  check("and it is NOT equipped — no operation happened", bought.equipped === false, String(bought.equipped));
  check("no surgical damage was taken", bought.damage === 0, String(bought.damage));
  check("the GM was never asked to confirm an operation", bought.surgeryCards === 0, String(bought.surgeryCards));
  check("the choice card closed as bought-only", bought.choiceStatus === "boughtOnly", String(bought.choiceStatus));

  /* ─────────────────── cleanup ─────────────────── */
  await gm.evaluate(async ({ SCOPE, buyerId, prevSource }) => {
    try { await game.settings.set(SCOPE, "shopBuySource", prevSource); } catch {}
    for (const m of [...game.messages].filter(m => /cp-shop-request|cp-shop-cyber|CyberBoughtUninstalled|Cyberware:/.test(m.content ?? ""))) await m.delete().catch(() => {});
    try { await game.actors.get(buyerId)?.delete(); } catch {}
    for (const a of game.actors.filter(a => a.name?.startsWith("__PW__CYBER"))) await a.delete().catch(() => {});
  }, { SCOPE, buyerId: S.buyerId, prevSource: S.prevSource });

  console.log("\n§6 console");
  check("0 console errors on the GM session", gmErrors.length === 0, gmErrors.slice(0, 3).join(" | "));
  check("0 console errors on the player session", pcErrors.length === 0, pcErrors.slice(0, 3).join(" | "));
} catch (e) {
  console.error("TEST ERROR:", e?.stack || e?.message || e);
  fail++;
} finally {
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
