/**
 * Shop acquisition-state keeper (:30003 v13 rig, official 1.1.1 + module; v14 re-run owed on :30004).
 *
 * Three defects, one file, all in the shop acquisition seam:
 *
 * A. ARMOR ARRIVES SWITCHED ON. The base system's common item schema declares
 *    `equipped: booleanField(true)` (systems/cyberpunk2020/module/data/item-data.js:144) and every one
 *    of its 16 armor pack entries OMITS the field, so each materializes `equipped: true` — the shipped
 *    `armor` pack (12, incl. Flack Vest / Flack Pants) and `armor-add` (4, incl. HeadGear Cybermodem
 *    Helmet). It is a SCHEMA DEFAULT, not a pack typo, so no data correction can fix it and the
 *    purchase seam has to normalize. Section A pins the RED (the live pack document still reads true)
 *    next to the GREEN (the delivered copy reads false) so the leg cannot pass for the wrong reason.
 *
 * B. AN APPROVED PURCHASE THAT REFUSES USED TO SAY NOTHING. resolvePurchaseRequest writes
 *    status:"approved" BEFORE running the buy (the flag is the concurrency claim). When the buy then
 *    refused for funds it returned false with only a transient toast: the card read "Approved" forever
 *    for goods that never moved. Section B drives the real Approve button for a 0eb buyer and asserts
 *    the flag walks back to "failed", the card stops saying Approved, and a card naming cost-vs-funds
 *    reaches the requester.
 *
 * D. THE SETUP-MODE EXEMPTION to A. A GM furnishing NPCs is not shopping, so while GM setup mode is on
 *    armor is delivered WORN — otherwise a squad of twenty costs twenty trips through a character
 *    sheet. Section D pins the forced state from BOTH source shapes (a base-pack entry that stores
 *    nothing and one of ours that stores false), both places the GM is told about it, the silence
 *    contract the note had to be built around, and the return to A's rule when the mode goes off.
 *
 * C. BUYER PRECEDENCE. resolveSidebarBuyer took the controlled token first for everyone, so a player
 *    with any token selected silently spent that actor's money. Players now resolve their ASSIGNED
 *    character first; GMs keep token-first (the 2026-08-12 NPC-shopping workflow). Section C covers
 *    both roles, the single-owned fallback, the preserved token tiebreak, and the explicit override.
 *
 * Run:  FVTT_URL=http://localhost:30003 FVTT_RIG_PASSWORD=cp2020-v14-rig node cp2020-augmented-shop-acquire-state.mjs
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30003";
const GM_PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function joinAs(page, match, pws) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const s = page.locator('select[name="userid"]');
  await s.waitFor({ state: "visible", timeout: 60000 });
  const us = await s.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  const u = us.find(x => match.test(x.l));
  if (!u) throw new Error("no user matching " + match);
  for (const pw of pws) {
    await s.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([page.waitForNavigation({ url: /\/game/, timeout: 25000 }).catch(() => {}), page.locator('button[name="join"]').click()]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 25000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await s.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("join failed " + u.l);
}

const b = await chromium.launch({ headless: true });
const checks = []; const errors = [];
const chk = (label, ok, got) => checks.push({ label, ok: !!ok, got });
let gm, player;
try {
  gm = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  gm.on("pageerror", e => errors.push("pageerror(gm): " + e.message));
  gm.on("console", m => { if (m.type() === "error") errors.push("console(gm): " + m.text()); });
  await joinAs(gm, /^gamemaster/i, [GM_PW]);

  /* ══ SECTION A — armor delivery state ═══════════════════════════════════════════════════════════ */
  const A = await gm.evaluate(async () => {
    const P = await import("/modules/cp2020-augmented/module/shop/purchase.js");
    const U = await import("/modules/cp2020-augmented/module/utils.js");
    const out = {};

    // The three the user named, across BOTH base packs (the icon cohort he spotted).
    const named = [
      { pack: "cyberpunk2020.armor", id: "aiehEkbdjqqYZD9j", label: "Flack Vest" },
      { pack: "cyberpunk2020.armor", id: "IBWsFBQDEZveDNJP", label: "Flack Pants" },
      { pack: "cyberpunk2020.armor-add", id: "OKkVzkiGSM6SE7Hg", label: "HeadGear Cybermodem Helmet" },
      { pack: "cyberpunk2020.armor", id: "WfIvgkw2mWXjiWol", label: "Cloth, Leather" },
    ];

    // Closed enumeration of the RED across every armor entry in both base packs — the source state
    // this fix has to survive, read from the real documents rather than from the pack files.
    out.sourceRed = [];
    for (const pid of ["cyberpunk2020.armor", "cyberpunk2020.armor-add"]) {
      const pack = game.packs.get(pid); if (!pack) continue;
      for (const e of await pack.getIndex()) {
        const d = await pack.getDocument(e._id);
        if (d?.type === "armor") out.sourceRed.push({ pack: pid, name: d.name, equipped: d.system?.equipped === true });
      }
    }
    // And ours, which set the field explicitly and must be unaffected.
    out.oursSource = [];
    {
      const pack = game.packs.get("cp2020-augmented.supplement-armor");
      for (const e of await pack.getIndex()) {
        const d = await pack.getDocument(e._id);
        if (d?.type === "armor") out.oursSource.push(d.system?.equipped === true);
      }
    }

    const buyer = await Actor.create({ name: "__PW__AcqBuyer", type: "character",
      system: { eurobucks: 50000 }, flags: { "cp2020-augmented": { __pwtest: true } } });

    out.bought = [];
    for (const n of named) {
      const doc = await game.packs.get(n.pack).getDocument(n.id);
      const before = new Set(game.messages.map(m => m.id));
      const ok = await P.buyItem(buyer, doc, { qty: 1, unitPrice: 10 });
      await new Promise(r => setTimeout(r, 250));
      const copy = buyer.items.find(i => i.name === doc.name);
      const card = game.messages.filter(m => !before.has(m.id)).map(m => m.content).join(" ");
      out.bought.push({
        label: n.label,
        sourceEquipped: doc.system?.equipped === true,        // RED: the source still says worn
        deliveredEquipped: copy?.system?.equipped === true,   // GREEN: the copy does not
        ok: ok === true,
        protectsSomewhere: Object.values(copy?.system?.coverage ?? {}).some(c => (Number(c?.stoppingPower) || 0) > 0),
        cueOnCard: card.includes(game.i18n.localize("CYBERPUNK.ShopArmorUnworn")),
        predicateSaysUnworn: U.isUnwornArmor(copy) === true,
      });
    }

    // The sheet cue (Q6/Q7): the combat panel raises a NOT-WORN notice naming the pieces.
    const sheet = buyer.sheet; sheet.render(true);
    await new Promise(r => setTimeout(r, 1500));
    // Query the whole sheet: the combat part is in the DOM whether or not its tab is the active one.
    const el = sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
    out.noticeText = el?.querySelector(".cp-unworn-armor-notice")?.textContent?.trim() ?? "";
    out.badgeCount = el?.querySelectorAll(".cp-armor-unworn-badge")?.length ?? 0;
    await sheet.close();

    // NEGATIVE 1 — a NON-ARMOR item's equipped state is not touched.
    await P.buyItem(buyer, { name: "__PW__AcqPistol", type: "weapon", system: { cost: 50, equipped: true } }, { qty: 1, unitPrice: 50 });
    await new Promise(r => setTimeout(r, 200));
    out.weaponEquipped = buyer.items.find(i => i.name === "__PW__AcqPistol")?.system?.equipped === true;

    // NEGATIVE 2 — the helper itself: armor only, and it forces the state regardless of input.
    out.helperArmorTrue = P.clearEquippedOnAcquire({ type: "armor", system: { equipped: true } }).system.equipped === false;
    out.helperArmorMissing = P.clearEquippedOnAcquire({ type: "armor", system: {} }).system.equipped === false;
    out.helperWeaponUntouched = P.clearEquippedOnAcquire({ type: "weapon", system: { equipped: true } }).system.equipped === true;
    out.helperCyberUntouched = P.clearEquippedOnAcquire({ type: "cyberware", system: { equipped: true } }).system.equipped === true;

    // NEGATIVE 3 — the NPC-generator exemption. It creates goons WEARING their armor and must be
    // structurally out of reach: it calls createEmbeddedDocuments directly, never buyItem. Prove the
    // outcome (armor stays equipped through the same create path) rather than the absence of a call.
    const goon = await Actor.create({ name: "__PW__AcqGoon", type: "npc",
      system: { eurobucks: 0 }, flags: { "cp2020-augmented": { __pwtest: true } } });
    const vestDoc = await game.packs.get("cyberpunk2020.armor").getDocument("aiehEkbdjqqYZD9j");
    const goonData = vestDoc.toObject(); delete goonData._id;
    goonData.system.equipped = true;                      // exactly what goon-factory.js:647 does
    await goon.createEmbeddedDocuments("Item", [goonData]);
    out.goonArmorEquipped = goon.items.find(i => i.name === vestDoc.name)?.system?.equipped === true;

    await buyer.delete(); await goon.delete();
    return out;
  });

  const namedRows = A.bought;
  chk("A/source: every base-pack armor document still materializes equipped:true (the RED)",
    A.sourceRed.length === 16 && A.sourceRed.every(r => r.equipped), `${A.sourceRed.filter(r => r.equipped).length}/${A.sourceRed.length}`);
  chk("A/source: our own 85 armor entries are already false (unaffected by the fix)",
    A.oursSource.length === 85 && A.oursSource.every(v => v === false), `${A.oursSource.filter(v => v === false).length}/${A.oursSource.length}`);
  for (const r of namedRows) {
    chk(`A/${r.label}: source document reads equipped:true (red staged)`, r.sourceEquipped === true, r.sourceEquipped);
    chk(`A/${r.label}: delivered copy reads equipped:false`, r.ok && r.deliveredEquipped === false, `ok=${r.ok} equipped=${r.deliveredEquipped}`);
  }
  // The receipt cue is gated on the piece protecting somewhere — "Cloth, Leather" stops 0 everywhere,
  // so it must arrive unworn WITHOUT raising a cue. Both halves are asserted by their own rule.
  for (const r of namedRows.filter(x => x.protectsSomewhere)) {
    chk(`A/${r.label}: receipt carries the unworn line`, r.cueOnCard === true, r.cueOnCard);
    chk(`A/${r.label}: unworn predicate agrees`, r.predicateSaysUnworn === true, r.predicateSaysUnworn);
  }
  for (const r of namedRows.filter(x => !x.protectsSomewhere)) {
    chk(`A/${r.label}: stops nothing anywhere → arrives unworn but raises NO cue`,
      r.deliveredEquipped === false && r.cueOnCard === false && r.predicateSaysUnworn === false,
      `equipped=${r.deliveredEquipped} cue=${r.cueOnCard} predicate=${r.predicateSaysUnworn}`);
  }
  chk("A/sheet: combat panel raises the not-worn notice naming the pieces", /Not worn \(\d+\)/.test(A.noticeText), JSON.stringify(A.noticeText).slice(0, 140));
  chk("A/sheet: a not-worn badge is painted on each unworn row", A.badgeCount >= 3, A.badgeCount);
  chk("A/negative: a bought WEAPON keeps equipped:true", A.weaponEquipped === true, A.weaponEquipped);
  chk("A/helper: armor with equipped:true → false", A.helperArmorTrue, A.helperArmorTrue);
  chk("A/helper: armor with the field absent → false", A.helperArmorMissing, A.helperArmorMissing);
  chk("A/helper: weapon untouched", A.helperWeaponUntouched, A.helperWeaponUntouched);
  chk("A/helper: cyberware untouched (its equipped means installed)", A.helperCyberUntouched, A.helperCyberUntouched);
  chk("A/exemption: an NPC-generator goon still arrives WEARING its armor", A.goonArmorEquipped === true, A.goonArmorEquipped);

  /* ══ SECTION D — the GM setup-mode exemption ════════════════════════════════════════════════════
   * Section A's rule is unconditional: every acquisition delivers armor switched off. That is right
   * for a purchase and wrong for a furnishing run — a GM kitting out twenty NPCs would have to open
   * twenty sheets to switch the same twenty pieces back on. So while GM setup mode is on (client-local,
   * GM-only, in-memory — module/shop/setup-mode.js), armor is delivered WORN instead, and the GM is
   * told so twice: once at delivery, once on the mode's own explanatory surfaces.
   *
   * The delivery note is a client-local toast, not a chat card, because setup mode's contract is that
   * a furnishing run posts NOTHING — that leg is asserted here too, so the note can never be added by
   * breaking the silence. It is raised once per furnishing run rather than once per piece.
   */
  const D = await gm.evaluate(async () => {
    const P = await import("/modules/cp2020-augmented/module/shop/purchase.js");
    const S = await import("/modules/cp2020-augmented/module/shop/setup-mode.js");
    const C = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};

    // A base-pack entry (schema default → true) and one of OURS (explicit false). Both must land worn:
    // the setup-mode rule is a forced state, not a passthrough of whatever the source happened to say.
    const baseDoc = await game.packs.get("cyberpunk2020.armor").getDocument("aiehEkbdjqqYZD9j");
    const ourPack = game.packs.get("cp2020-augmented.supplement-armor");
    const ourEntry = (await ourPack.getIndex()).find(e => e.type === "armor");
    const ourDoc = await ourPack.getDocument(ourEntry._id);
    out.ourSourceEquipped = ourDoc.system?.equipped === true;      // expected false — the red control
    out.ourName = ourDoc.name;

    const buyer = await Actor.create({ name: "__PW__SetupBuyer", type: "npc",
      system: { eurobucks: 50000 }, flags: { "cp2020-augmented": { __pwtest: true } } });

    // Capture the client-local notice channel by value.
    const notices = [];
    const realInfo = ui.notifications.info.bind(ui.notifications);
    ui.notifications.info = (m, ...rest) => { notices.push(String(m)); return realInfo(m, ...rest); };
    const clearNotices = () => { notices.length = 0; };

    try {
      // Re-arm control: one NORMAL-mode acquisition first, which is also the standing rule re-checked
      // next to its exemption (Section A's state, proven again in this section's own fixture).
      S.setShopSetupMode(false);
      let before = new Set(game.messages.map(m => m.id));
      await P.buyItem(buyer, baseDoc, { qty: 1, unitPrice: 10 });
      await sleep(300);
      out.normalEquipped = buyer.items.find(i => i.name === baseDoc.name)?.system?.equipped === true;
      out.normalCardLine = game.messages.filter(m => !before.has(m.id)).map(m => m.content).join(" ")
        .includes(game.i18n.localize("CYBERPUNK.ShopArmorUnworn"));
      for (const i of buyer.items.filter(i => i.type === "armor")) await i.delete();

      // ── the exemption itself ──────────────────────────────────────────────────────────────────
      clearNotices();
      out.modeOn = S.setShopSetupMode(true) === true && S.isShopSetupMode() === true;
      before = new Set(game.messages.map(m => m.id));
      await P.buyItem(buyer, baseDoc, { qty: 1, unitPrice: 10 });
      await sleep(300);
      out.setupBaseEquipped = buyer.items.find(i => i.name === baseDoc.name)?.system?.equipped === true;
      out.noteText = game.i18n.localize("CYBERPUNK.ShopSetupArmorEquipped");
      out.noteResolves = !out.noteText.startsWith("CYBERPUNK.");
      out.noticesAfterFirst = notices.slice();

      // Second act: another piece, from the OTHER source, in the same furnishing run.
      await P.buyItem(buyer, ourDoc, { qty: 1, unitPrice: 10 });
      await sleep(300);
      out.setupOursEquipped = buyer.items.find(i => i.name === ourDoc.name)?.system?.equipped === true;
      out.noticeCount = notices.filter(n => n === out.noteText).length;
      out.setupCards = game.messages.filter(m => !before.has(m.id)).length;

      // Non-armor is not the subject: its state is untouched and it raises no note.
      clearNotices();
      await P.buyItem(buyer, { name: "__PW__SetupPistol", type: "weapon", system: { cost: 50, equipped: true } }, { qty: 1, unitPrice: 50 });
      await sleep(250);
      out.setupWeaponEquipped = buyer.items.find(i => i.name === "__PW__SetupPistol")?.system?.equipped === true;
      out.weaponRaisedNote = notices.some(n => n === out.noteText);

      // ── the second explanatory surface: the mode's own UI, while it is on ─────────────────────
      const win = C.openShopWindow(buyer, { view: "catalog" });
      for (let i = 0; i < 200 && !(win.rendered && win.element?.querySelector(".cp-shop-setup-toggle")); i++) await sleep(150);
      const root = win.element instanceof HTMLElement ? win.element : win.element?.[0];
      out.hintText = game.i18n.localize("CYBERPUNK.ShopSetupModeArmorNote");
      out.hintResolves = !out.hintText.startsWith("CYBERPUNK.");
      out.bannerText = root?.querySelector(".cp-shop-setup-banner")?.textContent?.trim() ?? "";
      out.toggleTitle = root?.querySelector(".cp-shop-setup-toggle")?.getAttribute("title") ?? "";
      await win.close();

      // ── back off: the standing rule returns, in the same window of the same run ───────────────
      S.setShopSetupMode(false);
      for (const i of buyer.items.filter(i => i.type === "armor")) await i.delete();
      clearNotices();
      before = new Set(game.messages.map(m => m.id));
      await P.buyItem(buyer, baseDoc, { qty: 1, unitPrice: 10 });
      await sleep(400);
      out.backOffEquipped = buyer.items.find(i => i.name === baseDoc.name)?.system?.equipped === true;
      out.backOffCardLine = game.messages.filter(m => !before.has(m.id)).map(m => m.content).join(" ")
        .includes(game.i18n.localize("CYBERPUNK.ShopArmorUnworn"));
      out.backOffRaisedNote = notices.some(n => n === out.noteText);

      // The forcing helper itself, mirroring the four helper legs Section A pins on its counterpart.
      out.helperExists = typeof P.equipArmorOnAcquire === "function";
      if (out.helperExists) {
        out.helperArmorFalse = P.equipArmorOnAcquire({ type: "armor", system: { equipped: false } }).system.equipped === true;
        out.helperArmorMissing = P.equipArmorOnAcquire({ type: "armor", system: {} }).system.equipped === true;
        out.helperWeaponUntouched = P.equipArmorOnAcquire({ type: "weapon", system: { equipped: false } }).system.equipped === false;
        out.helperCyberUntouched = P.equipArmorOnAcquire({ type: "cyberware", system: { equipped: false } }).system.equipped === false;
      }
    } finally {
      ui.notifications.info = realInfo;
      S.setShopSetupMode(false);
      await buyer.delete().catch(() => {});
    }
    return out;
  });

  chk("D/control: a NORMAL-mode acquisition still delivers armor switched off",
    D.normalEquipped === false, D.normalEquipped);
  chk("D/control: the normal-mode receipt still carries the unworn line", D.normalCardLine === true, D.normalCardLine);
  chk("D/precondition: setup mode reads ON for this GM client", D.modeOn === true, D.modeOn);
  chk("D/precondition: our own pack entry stores equipped:false (the passthrough would deliver unworn)",
    D.ourSourceEquipped === false, `${D.ourName}=${D.ourSourceEquipped}`);
  chk("D: a base-pack piece acquired in setup mode arrives equipped:true",
    D.setupBaseEquipped === true, D.setupBaseEquipped);
  chk("D: one of OUR pieces (source says false) is FORCED equipped:true too, not passed through",
    D.setupOursEquipped === true, D.setupOursEquipped);
  chk("D/note: the setup-mode delivery note key resolves (no raw key leakage)",
    D.noteResolves === true, D.noteText);
  chk("D/note: the delivery raises the setup-mode equipped note by value",
    D.noticesAfterFirst.includes(D.noteText), JSON.stringify(D.noticesAfterFirst).slice(0, 200));
  chk("D/note: it is raised ONCE per furnishing run, not once per piece",
    D.noticeCount === 1, D.noticeCount);
  chk("D/silence: setup mode still posts ZERO chat messages (the note did not break the silence)",
    D.setupCards === 0, D.setupCards);
  chk("D/negative: a non-armor acquisition keeps its state and raises no note",
    D.setupWeaponEquipped === true && D.weaponRaisedNote === false,
    `equipped=${D.setupWeaponEquipped} note=${D.weaponRaisedNote}`);
  chk("D/surface: the mode's explanatory note key resolves", D.hintResolves === true, D.hintText);
  chk("D/surface: the lit-mode banner states that armor arrives worn",
    D.hintResolves && D.bannerText.includes(D.hintText), D.bannerText.slice(0, 200));
  chk("D/surface: the toggle's own tooltip states it too",
    D.hintResolves && D.toggleTitle.includes(D.hintText), D.toggleTitle.slice(0, 240));
  chk("D/second act: switching the mode off restores the switched-off delivery",
    D.backOffEquipped === false, D.backOffEquipped);
  chk("D/second act: and the unworn receipt line comes back with it",
    D.backOffCardLine === true && D.backOffRaisedNote === false,
    `line=${D.backOffCardLine} note=${D.backOffRaisedNote}`);
  chk("D/helper: the forcing helper exists", D.helperExists === true, D.helperExists);
  chk("D/helper: armor with equipped:false → true", D.helperArmorFalse === true, D.helperArmorFalse);
  chk("D/helper: armor with the field absent → true", D.helperArmorMissing === true, D.helperArmorMissing);
  chk("D/helper: weapon untouched", D.helperWeaponUntouched === true, D.helperWeaponUntouched);
  chk("D/helper: cyberware untouched (its equipped means installed)",
    D.helperCyberUntouched === true, D.helperCyberUntouched);

  /* ══ SECTION D2 — an APPROVED REQUEST is not a furnishing acquisition ═══════════════════════════
   * Setup mode is client-local precisely so a GM's convenience can never reach a PLAYER's economy
   * (module/shop/setup-mode.js states that as the whole safety argument). The approval route was the
   * one place it did anyway: a request is resolved on the GM's CLIENT, so it read the GM's mode and
   * delivered a player's requested purchase free, unnarrated, and — once D's exemption shipped —
   * WORN. Ruled out 2026-08-20 ("exclude approvals from setup mode exemption"): an approval takes the
   * ordinary paid route whatever the mode says.
   *
   * Driven through the REAL Approve button on a real request card, with the mode LIT the whole time,
   * so what is asserted is the shipped path and not a hand-called helper. The paired control is the
   * point of the section — the same client, the same mode, the same instant: the approval arrives
   * unworn and the GM's own direct acquisition still arrives worn.
   */
  const D2setup = await gm.evaluate(async () => {
    const S = await import("/modules/cp2020-augmented/module/shop/setup-mode.js");
    const buyer = await Actor.create({ name: "__PW__ApprBuyer", type: "character",
      system: { eurobucks: 50000 }, flags: { "cp2020-augmented": { __pwtest: true } } });
    const doc = await game.packs.get("cyberpunk2020.armor").getDocument("aiehEkbdjqqYZD9j");
    const total = Number(doc.system.cost) || 200;
    const requester = game.users.find(u => !u.isGM);
    // ⛔ THE MODE IS ON FOR THE WHOLE OF THIS SECTION — that is the condition under test, not a stray.
    const modeOn = S.setShopSetupMode(true) === true && S.isShopSetupMode() === true;
    const msg = await ChatMessage.create({
      whisper: game.users.filter(u => u.isGM).map(u => u.id),
      content: `<div class="cp-shop-request"><p class="cp-shop-request-body">__PW__ approval request</p>
        <div class="cp-shop-request-actions">
        <button type="button" class="cp-shop-request-btn cp-approve" data-action="approve">Approve</button>
        <button type="button" class="cp-shop-request-btn cp-deny" data-action="deny">Deny</button></div></div>`,
      flags: { "cp2020-augmented": { purchaseRequest: {
        buyerId: buyer.id, packId: "cyberpunk2020.armor", itemId: "aiehEkbdjqqYZD9j",
        qty: 1, styleMult: 1, styleLabel: "", name: doc.name, total,
        needsPrice: false, priceRange: null, requesterId: requester?.id ?? game.user.id, status: "pending",
      } } },
    });
    return { msgId: msg.id, buyerId: buyer.id, itemName: doc.name, cost: total, modeOn,
             funds: Number(buyer.system?.eurobucks ?? 0) };
  });

  await gm.locator(`li[data-message-id="${D2setup.msgId}"] .cp-shop-request-btn[data-action="approve"]`).first()
    .waitFor({ state: "visible", timeout: 20000 });
  const d2MsgsBefore = await gm.evaluate(() => game.messages.size);
  await gm.locator(`li[data-message-id="${D2setup.msgId}"] .cp-shop-request-btn[data-action="approve"]`).first().click();
  await sleep(2500);

  const D2 = await gm.evaluate(async ({ buyerId, itemName, msgsBefore }) => {
    const S = await import("/modules/cp2020-augmented/module/shop/setup-mode.js");
    const P = await import("/modules/cp2020-augmented/module/shop/purchase.js");
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const buyer = game.actors.get(buyerId);
    const out = {};
    try {
      out.modeStillOn = S.isShopSetupMode() === true;
      const piece = buyer?.items?.find(i => i.name === itemName && i.type === "armor");
      out.delivered = !!piece;
      out.approvedEquipped = piece?.system?.equipped === true;
      out.fundsAfter = Number(buyer?.system?.eurobucks ?? -1);
      const newCards = game.messages.contents.slice(msgsBefore).map(m => m.content).join(" ");
      out.unwornLine = newCards.includes(game.i18n.localize("CYBERPUNK.ShopArmorUnworn"));
      out.boughtCard = /ShopBought|eb\b/.test(newCards) && newCards.length > 0;

      // ── THE PAIRED CONTROL, same client, same lit mode: the GM's OWN direct acquisition ─────────
      const npc = await Actor.create({ name: "__PW__ApprNpc", type: "npc",
        system: { eurobucks: 50000 }, flags: { "cp2020-augmented": { __pwtest: true } } });
      const doc = await game.packs.get("cyberpunk2020.armor").getDocument("aiehEkbdjqqYZD9j");
      const cardsBefore = game.messages.size;
      const npcFundsBefore = Number(npc.system?.eurobucks ?? 0);
      await P.buyItem(npc, doc, { qty: 1, unitPrice: 10 });
      await sleep(400);
      out.directEquipped = npc.items.find(i => i.name === doc.name)?.system?.equipped === true;
      out.directFree = Number(npc.system?.eurobucks ?? -1) === npcFundsBefore;
      out.directSilent = game.messages.size === cardsBefore;
      await npc.delete().catch(() => {});
    } finally {
      S.setShopSetupMode(false);
      await buyer?.delete().catch(() => {});
    }
    return out;
  }, { buyerId: D2setup.buyerId, itemName: D2setup.itemName, msgsBefore: d2MsgsBefore });

  chk("D2/precondition: setup mode was lit on the approving GM's client",
    D2setup.modeOn === true && D2.modeStillOn === true, `${D2setup.modeOn} / ${D2.modeStillOn}`);
  chk("D2: the approved request delivered the goods", D2.delivered === true, D2.delivered);
  chk("D2: an approved request arrives equipped:false even with setup mode ON",
    D2.approvedEquipped === false, D2.approvedEquipped);
  chk("D2: and it carries the unworn receipt line — an approval is receipted, not silent",
    D2.unwornLine === true, `${D2.unwornLine} (cards seen: ${D2.boughtCard})`);
  chk("D2: an approval is charged at the listed price, not waived by the GM's mode",
    D2.fundsAfter === D2setup.funds - D2setup.cost, `${D2.fundsAfter} vs ${D2setup.funds - D2setup.cost}`);
  chk("D2/pair: the GM's OWN direct acquisition in the same lit mode still arrives WORN (negative)",
    D2.directEquipped === true, D2.directEquipped);
  chk("D2/pair: and it is still free and still silent — the mode is untouched for furnishing",
    D2.directFree === true && D2.directSilent === true,
    `free=${D2.directFree} silent=${D2.directSilent}`);

  /* ══ SECTION B — approved-but-unaffordable ══════════════════════════════════════════════════════ */
  const Bsetup = await gm.evaluate(async () => {
    const pauper = await Actor.create({ name: "__PW__AcqPauper", type: "character",
      system: { eurobucks: 0 }, flags: { "cp2020-augmented": { __pwtest: true } } });
    const doc = await game.packs.get("cyberpunk2020.armor").getDocument("aiehEkbdjqqYZD9j");
    const total = Number(doc.system.cost) || 200;
    const requester = game.users.find(u => !u.isGM);
    // A pending request card in exactly the shape requestPurchase writes. The markup carries the
    // classes the render hook binds on, so the Approve button below is the REAL bound control.
    const msg = await ChatMessage.create({
      whisper: game.users.filter(u => u.isGM).map(u => u.id),
      content: `<div class="cp-shop-request"><p class="cp-shop-request-body">__PW__ request</p>
        <div class="cp-shop-request-actions">
        <button type="button" class="cp-shop-request-btn cp-approve" data-action="approve">Approve</button>
        <button type="button" class="cp-shop-request-btn cp-deny" data-action="deny">Deny</button></div></div>`,
      flags: { "cp2020-augmented": { purchaseRequest: {
        buyerId: pauper.id, packId: "cyberpunk2020.armor", itemId: "aiehEkbdjqqYZD9j",
        qty: 1, styleMult: 1, styleLabel: "", name: doc.name, total,
        needsPrice: false, priceRange: null, requesterId: requester?.id ?? game.user.id, status: "pending",
      } } },
    });
    return { msgId: msg.id, pauperId: pauper.id, cost: total, funds: 0, itemName: doc.name };
  });

  // Drive the REAL Approve button in the chat log.
  await gm.locator(`li[data-message-id="${Bsetup.msgId}"] .cp-shop-request-btn[data-action="approve"]`).first()
    .waitFor({ state: "visible", timeout: 20000 });
  const msgsBefore = await gm.evaluate(() => game.messages.size);
  await gm.locator(`li[data-message-id="${Bsetup.msgId}"] .cp-shop-request-btn[data-action="approve"]`).first().click();
  await sleep(2500);

  const B = await gm.evaluate(async ({ msgId, pauperId, msgsBefore }) => {
    const msg = game.messages.get(msgId);
    const req = msg?.getFlag("cp2020-augmented", "purchaseRequest");
    const pauper = game.actors.get(pauperId);
    const newCards = game.messages.contents.slice(msgsBefore).map(m => ({ content: m.content, whisper: m.whisper }));
    return {
      status: req?.status,
      cardSaysApproved: /cp-approved/.test(msg?.content ?? ""),
      cardSaysFailed: /cp-failed/.test(msg?.content ?? ""),
      funds: Number(pauper?.system?.eurobucks ?? -1),
      // A freshly created character carries the system's default SKILL items, so count only what a
      // purchase could have added — armor named like the requested item.
      armorCount: pauper?.items?.filter(i => i.type === "armor").length ?? -1,
      failureCards: newCards.filter(c => /could not afford/i.test(c.content)),
    };
  }, { msgId: Bsetup.msgId, pauperId: Bsetup.pauperId, msgsBefore });

  chk("B: the approval flag walks back to 'failed' when the buy refuses", B.status === "failed", B.status);
  chk("B: the card no longer claims 'Approved'", B.cardSaysApproved === false, B.cardSaysApproved);
  chk("B: the card shows the failed state instead", B.cardSaysFailed === true, B.cardSaysFailed);
  chk("B: nothing was charged (0eb buyer still at 0)", B.funds === 0, B.funds);
  chk("B: no goods were delivered (no armor landed on the buyer)", B.armorCount === 0, B.armorCount);
  chk("B: a visible failure card was posted", B.failureCards.length === 1, B.failureCards.length);
  chk("B: the failure card names cost AND funds by value",
    B.failureCards.length === 1 && B.failureCards[0].content.includes(`${Bsetup.cost}eb`) && B.failureCards[0].content.includes("0eb"),
    (B.failureCards[0]?.content ?? "").replace(/<[^>]+>/g, "").slice(0, 160));
  chk("B: the failure card reaches the REQUESTER, not just the GMs",
    B.failureCards.length === 1 && B.failureCards[0].whisper.length >= 2,
    JSON.stringify(B.failureCards[0]?.whisper ?? []));

  /* ══ SECTION C — buyer precedence ═══════════════════════════════════════════════════════════════ */
  const Csetup = await gm.evaluate(async () => {
    const mk = (name, type) => Actor.create({ name, type, system: { eurobucks: 1000 },
      flags: { "cp2020-augmented": { __pwtest: true } } });
    // ⚠ This rig carries MORE THAN ONE non-GM account, so "the first non-GM" is not necessarily the
    // account the second browser context joins as — grant to the named fixture user and hand its name
    // back, so the ownership and the join can never drift apart (the v14 re-run's first finding: on
    // :30004 the grants landed on a different player and every C leg read an empty owned set).
    const player = game.users.find(u => !u.isGM && /test user 1/i.test(u.name)) ?? game.users.find(u => !u.isGM);
    const assigned = await mk("__PW__AcqAssigned", "character");
    const incidental = await mk("__PW__AcqIncidental", "character");
    const npc = await mk("__PW__AcqNpc", "npc");
    const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    for (const a of [assigned, incidental]) await a.update({ [`ownership.${player.id}`]: OWNER });
    const prevChar = player.character?.id ?? null;
    await player.update({ character: assigned.id });

    const prevScene = game.scenes.active?.id ?? null;
    const scene = await Scene.create({ name: "__PW__AcqScene", width: 2000, height: 2000, grid: { size: 100 } });
    await scene.createEmbeddedDocuments("Token", [
      { name: incidental.name, actorId: incidental.id, actorLink: true, x: 500, y: 500 },
      { name: npc.name, actorId: npc.id, actorLink: true, x: 900, y: 500 },
    ]);
    await scene.activate();
    await new Promise(r => setTimeout(r, 2500));
    return { assignedId: assigned.id, incidentalId: incidental.id, npcId: npc.id,
      sceneId: scene.id, prevScene, playerId: player.id, playerName: player.name, prevChar };
  });

  // C4 — GM with an NPC token selected: token-first, UNCHANGED.
  const C_gm = await gm.evaluate(async ({ npcId }) => {
    const C = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    canvas.tokens.releaseAll();
    canvas.tokens.placeables.find(t => t.actor?.id === npcId)?.control({ releaseOthers: true });
    await new Promise(r => setTimeout(r, 400));
    const viaToken = C.resolveSidebarBuyer()?.name ?? null;
    // C5 — the explicit override (the buyer strip / an explicit call) still wins over the selection.
    const assigned = game.actors.getName("__PW__AcqAssigned");
    const win = C.openShopWindow(assigned, { view: "home" });
    await new Promise(r => setTimeout(r, 1200));
    const override = win?.buyer?.name ?? null;
    await win?.close?.();
    canvas.tokens.releaseAll();
    return { viaToken, override };
  }, { npcId: Csetup.npcId });

  chk("C/GM: a selected NPC token stays the buyer (2026-08-12 workflow preserved)",
    C_gm.viaToken === "__PW__AcqNpc", C_gm.viaToken);
  chk("C/override: an explicitly passed buyer beats the canvas selection",
    C_gm.override === "__PW__AcqAssigned", C_gm.override);

  /* ══ SECTION E — a window opened with no buyer must not be a dead end ══════════════════════════ */
  // Run while the player assignment is still live (the C player legs clear it below), because the
  // GM picker leg asserts that a player's assigned character is offered.
  const E = await gm.evaluate(async ({ npcId }) => {
    const C = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    canvas.tokens.releaseAll();
    await sleep(400);

    // Open the catalog with NOTHING selected — the exact gesture that used to strand the GM.
    const win = C.openShopWindow(null, { view: "catalog" });
    await sleep(2500);
    const out = { openedWithBuyer: win?.buyer?.name ?? null };
    const root = () => win.element instanceof HTMLElement ? win.element : win.element?.[0];
    out.greyAtOpen = !!root()?.querySelector(".cp-catalog-buy.cp-buy-nobuyer");
    out.stripAtOpen = root()?.querySelector(".cp-catalog-buyer")?.textContent?.trim() ?? "";
    // A populated picker must NOT read as a furnished strip: with options but no buyer chosen, the
    // "pick someone" notice has to be visible alongside the picker.
    out.warnAtOpen = !!root()?.querySelector(".cp-buyer-warn");
    out.pickerAtOpen = !!root()?.querySelector(".cp-buyer-pick");

    // The buy gesture with no buyer and nothing selected: refuses, buys nothing.
    const npc = game.actors.get(npcId);
    const fundsBefore = Number(npc.system.eurobucks);
    await win._directBuy("cyberpunk2020.armor", "aiehEkbdjqqYZD9j", { qty: 1 });
    await sleep(600);
    out.refusedBuyer = win?.buyer?.name ?? null;
    out.refusedNoCharge = Number(npc.system.eurobucks) === fundsBefore;

    // Now select the token — WITHOUT closing the window — and repeat the same gesture.
    canvas.tokens.placeables.find(t => t.actor?.id === npcId)?.control({ releaseOthers: true });
    await sleep(700);
    await win._directBuy("cyberpunk2020.armor", "aiehEkbdjqqYZD9j", { qty: 1 });
    await sleep(1200);
    out.adoptedBuyer = win?.buyer?.name ?? null;
    out.adoptedCharged = Number(npc.system.eurobucks) < fundsBefore;
    out.adoptedGoods = npc.items.some(i => i.name === "Flack Vest");
    out.adoptedArmorUnworn = npc.items.find(i => i.name === "Flack Vest")?.system?.equipped === false;
    out.stripAfter = root()?.querySelector(".cp-catalog-buyer")?.textContent ?? "";
    out.greyAfter = !!root()?.querySelector(".cp-catalog-buy.cp-buy-nobuyer");

    // The GM picker now offers a player's ASSIGNED character and the controlled token's actor.
    out.pickerNames = win._buyerOptions().map(o => o.name);
    await win?.close?.();
    canvas.tokens.releaseAll();
    return out;
  }, { npcId: Csetup.npcId });

  chk("E: opening with nothing selected still yields no buyer (precondition)", E.openedWithBuyer === null, E.openedWithBuyer);
  chk("E: Buy is painted grey while there is no buyer", E.greyAtOpen === true, E.greyAtOpen);
  chk("E: a populated picker with nobody chosen still shows the pick-a-buyer notice",
    E.pickerAtOpen === true && E.warnAtOpen === true, `picker=${E.pickerAtOpen} warn=${E.warnAtOpen}`);
  chk("E: a buy gesture with no buyer and no selection refuses and charges nothing",
    E.refusedBuyer === null && E.refusedNoCharge === true, `buyer=${E.refusedBuyer} noCharge=${E.refusedNoCharge}`);
  chk("E: selecting a token then clicking Buy ADOPTS it — no window cycle needed",
    E.adoptedBuyer === "__PW__AcqNpc", E.adoptedBuyer);
  chk("E: the adopted buy actually completes (charged + goods delivered)",
    E.adoptedCharged === true && E.adoptedGoods === true, `charged=${E.adoptedCharged} goods=${E.adoptedGoods}`);
  chk("E: armor bought through the adopted path is ALSO unworn (section A holds here)",
    E.adoptedArmorUnworn === true, E.adoptedArmorUnworn);
  chk("E: the buyer strip repaints with the adopted name", E.stripAfter.includes("__PW__AcqNpc"),
    E.stripAfter.replace(/\s+/g, " ").slice(0, 120));
  chk("E: the grey no-buyer styling is cleared after adoption", E.greyAfter === false, E.greyAfter);
  chk("E: the GM picker offers a player's ASSIGNED character",
    E.pickerNames.includes("__PW__AcqAssigned"), JSON.stringify(E.pickerNames));
  chk("E: the GM picker offers the controlled token's actor",
    E.pickerNames.includes("__PW__AcqNpc"), JSON.stringify(E.pickerNames));

  // Player client.
  player = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  // Join FIRST, listen after. The fixture account is passwordless on one rig and rig-password-protected
  // on the other, so the helper walks candidates — and a refused candidate emits a 401 + "Invalid
  // password" console error that is the harness's own doing, not module behaviour this suite counts.
  await joinAs(player, new RegExp(`^${Csetup.playerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), ["", GM_PW]);
  player.on("pageerror", e => errors.push("pageerror(player): " + e.message));
  player.on("console", m => { if (m.type() === "error") errors.push("console(player): " + m.text()); });
  await sleep(2000);

  // C1 — assignment beats an incidental controlled token. THE headline fix.
  const C1 = await player.evaluate(async ({ incidentalId }) => {
    const C = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    canvas.tokens.releaseAll();
    canvas.tokens.placeables.find(t => t.actor?.id === incidentalId)?.control({ releaseOthers: true });
    await new Promise(r => setTimeout(r, 400));
    return {
      controlled: canvas.tokens.controlled.map(t => t.actor?.name),
      assignment: game.user.character?.name ?? null,
      resolved: C.resolveSidebarBuyer()?.name ?? null,
    };
  }, { incidentalId: Csetup.incidentalId });

  chk("C/player: a different owned token IS selected (precondition)",
    C1.controlled.includes("__PW__AcqIncidental"), JSON.stringify(C1.controlled));
  chk("C/player: the assigned character wins over the selected token",
    C1.resolved === "__PW__AcqAssigned" && C1.assignment === "__PW__AcqAssigned", C1.resolved);

  // C3 — no assignment, TWO owned actors: the controlled-token tiebreak is preserved.
  await gm.evaluate(async ({ playerId }) => { await game.users.get(playerId).update({ character: null }); }, { playerId: Csetup.playerId });
  await sleep(1500);
  const C3 = await player.evaluate(async () => {
    const C = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    return { assignment: game.user.character?.name ?? null, resolved: C.resolveSidebarBuyer()?.name ?? null };
  });
  chk("C/player: no assignment + two owned actors → the controlled token still decides",
    C3.assignment === null && C3.resolved === "__PW__AcqIncidental", `${C3.assignment} / ${C3.resolved}`);

  // C2 — no assignment, exactly ONE owned actor, nothing selected.
  await gm.evaluate(async ({ incidentalId, playerId }) => {
    await game.actors.get(incidentalId).update({ [`ownership.${playerId}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE });
  }, { incidentalId: Csetup.incidentalId, playerId: Csetup.playerId });
  await sleep(1500);
  const C2 = await player.evaluate(async () => {
    const C = await import("/modules/cp2020-augmented/module/shop/catalog.js");
    canvas.tokens.releaseAll();
    await new Promise(r => setTimeout(r, 400));
    const owned = game.actors.filter(a => (a.type === "character" || a.type === "npc") && a.isOwner).map(a => a.name);
    return { owned, controlled: canvas.tokens.controlled.length, resolved: C.resolveSidebarBuyer()?.name ?? null };
  });
  chk("C/player: no assignment + exactly one owned actor + nothing selected → that actor",
    C2.owned.length === 1 && C2.controlled === 0 && C2.resolved === "__PW__AcqAssigned",
    `owned=${JSON.stringify(C2.owned)} controlled=${C2.controlled} resolved=${C2.resolved}`);

  chk("no console errors on either client", errors.length === 0, errors.slice(0, 4).join(" | "));
} catch (e) {
  chk("suite ran to completion", false, e.message);
} finally {
  // Restore world state — settings, assignment, scene, fixtures. Never on the happy path only.
  try {
    await gm?.evaluate(async () => {
      // Setup mode is client state; leave it off however this run ended.
      try { (await import("/modules/cp2020-augmented/module/shop/setup-mode.js")).setShopSetupMode(false); } catch { /* module state is best-effort */ }
      const player = game.users.find(u => !u.isGM);
      await player?.update({ character: null }).catch(() => {});
      const scene = game.scenes.getName("__PW__AcqScene");
      const prev = game.scenes.find(s => s.id !== scene?.id);
      if (prev && scene?.active) await prev.activate().catch(() => {});
      await scene?.delete().catch(() => {});
      for (const a of game.actors.filter(a => a.name?.startsWith("__PW__"))) await a.delete().catch(() => {});
      // Content OR speaker: the approval receipt (Section D2) names the item, not the fixture, so the
      // only thing tying it to this run is the actor it was spoken by.
      for (const m of game.messages.filter(m => /__PW__|could not afford|cp-shop-request/.test(m.content)
                                             || /^__PW__/.test(m.speaker?.alias ?? ""))) await m.delete().catch(() => {});
    });
  } catch { /* cleanup is best-effort */ }
  await b.close();
}

let fail = 0;
for (const c of checks) { if (!c.ok) fail++; console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.label}${c.ok ? "" : `   got: ${c.got}`}`); }
console.log(`\n${checks.length - fail}/${checks.length} passed`);
process.exit(fail ? 1 : 0);
