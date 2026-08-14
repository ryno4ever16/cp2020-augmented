/** Item-sheet Notes tab: the rich-text editor mounts, is reachable, edits, and persists.
 *
 *  Field report (2026-08-14): on a `program` item the Notes tab could not be typed into and the
 *  Format menu did nothing. Cause was a broken height chain — `.cp-notes-canvas` had no CSS on the
 *  item sheet (the whole `cp-notes-*` block was scoped to `.sheet.actor`), so the editor collapsed
 *  to the height of its menubar and its `position:absolute` content area landed OUTSIDE the
 *  element's box, where no click could reach it. The load-bearing assertion is therefore
 *  REACHABILITY (`document.elementFromPoint` at the content centre), not presence: the editor was
 *  in the DOM and `contenteditable="true"` the whole time it was unusable.
 *
 *   A  closed enumeration — which Item types carry a Notes tab
 *   B  every notes-bearing type: the editor gets a real box AND is hit-testable
 *   C  real gesture per representative type: click in, type, persist, reopen, still there
 *   D  the Format menu opens, its submenu opens, and a heading applies + persists
 *   E  actor Life tab (the in-house working reference) still passes the same bar
 *   F  no scroll regression: tall settings tabs still reach their last field
 *   G  window-header controls: every control's painted box contains its glyph and is clickable
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

/** Types whose sheet is expected to carry a Notes tab (the base system declares `notes` an
 *  htmlField for exactly these); the module's own vehicleWeapon/acpaSystem use other sheets. */
const NOTES_TYPES = ["skill", "program", "weapon", "ammo", "armor", "cyberware", "vehicle", "misc"];
/** Full click-and-type lane. The reported type plus one simple and one field-heavy sheet. */
const GESTURE_TYPES = ["program", "armor", "cyberware"];

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const P = [];
const chk = (name, ok, detail = "") => P.push({ name, ok: !!ok, detail: String(detail) });
const S = (o) => JSON.stringify(o);
/** A real click that RECORDS a failure instead of throwing. When the editor is unreachable
 *  Playwright's actionability check refuses the click ("… intercepts pointer events") — that is the
 *  defect under test, so it has to read as a FAIL line, not an uncaught timeout. */
const tryClick = async (locator, what) => {
  try { await locator.click({ timeout: 8000 }); return true; }
  catch (e) { chk(what, false, String(e.message).split("\n")[0]); return false; }
};

// ── helpers driven from Node so the gestures are REAL page input, not dispatched events ──
const openNotes = (kind, type) => p.evaluate(async ([kind, type]) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (const it of game.items.filter(i => i.name.startsWith("__PW__NOTES"))) await it.delete().catch(() => {});
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__NOTES"))) await a.delete().catch(() => {});
  const doc = kind === "item"
    ? await Item.create({ name: `__PW__NOTES ${type}`, type })
    : await Actor.create({ name: "__PW__NOTES punk", type: "character" });
  await doc.sheet.render(true);
  await sleep(kind === "item" ? 900 : 1400);
  const root = doc.sheet.element.closest(".application");
  root.querySelector(kind === "item" ? 'nav.sheet-tabs a[data-tab="notes"]' : 'nav a[data-tab="life"]').click();
  await sleep(350);
  const editBtn = root.querySelector(".cp-notes-edit");
  const hadEditButton = !!editBtn;
  editBtn?.click();
  await sleep(1100);
  return { appId: doc.sheet.element.closest(".application").id, hadEditButton, docId: doc.id };
}, [kind, type]);

const probeBox = (appId) => p.evaluate((appId) => {
  const root = document.getElementById(appId);
  const canvas = root.querySelector(".cp-notes-canvas");
  const pm = root.querySelector("prose-mirror");
  const cm = root.querySelector("prose-mirror .editor-content.ProseMirror") ?? root.querySelector("prose-mirror .ProseMirror");
  const box = e => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
  if (!canvas || !pm || !cm) return { canvasFound: !!canvas, pmFound: !!pm, cmFound: !!cm };
  const r = cm.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return {
    canvasFound: true, pmFound: true, cmFound: true,
    canvasDisplay: getComputedStyle(canvas).display,
    canvasBox: box(canvas), pmBox: box(pm), cmBox: box(cm),
    editable: cm.getAttribute("contenteditable") === "true",
    // ⭐ the load-bearing check: a click at the centre of the text area must land ON the text area
    reachable: hit === cm || cm.contains(hit),
    hit: (hit?.tagName ?? "none") + "." + String(hit?.className ?? "").slice(0, 48)
  };
}, appId);

// ── A · closed enumeration ────────────────────────────────────────────────────────────
const enumeration = await p.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = { all: Object.keys(CONFIG.Item.dataModels ?? {}).filter(t => t !== "base"), withNotes: [], without: [] };
  for (const type of out.all) {
    let it;
    try { it = await Item.create({ name: `__PW__ENUM ${type}`, type }); } catch (e) { out.without.push(type); continue; }
    await it.sheet.render(true); await sleep(600);
    const root = it.sheet.element.closest(".application") ?? it.sheet.element;
    (root.querySelector('nav.sheet-tabs a[data-tab="notes"]') ? out.withNotes : out.without).push(type);
    await it.sheet.close(); await it.delete().catch(() => {});
  }
  return out;
});
chk("closed enumeration: exactly the notes-bearing Item types expose a Notes tab",
  enumeration.withNotes.slice().sort().join(",") === NOTES_TYPES.slice().sort().join(","),
  `withNotes=${S(enumeration.withNotes)} without=${S(enumeration.without)}`);

// ── B · every notes-bearing type gets a real, reachable editor box ─────────────────────
for (const type of NOTES_TYPES) {
  const { appId, hadEditButton } = await openNotes("item", type);
  const g = await probeBox(appId);
  chk(`${type}: the Notes tab offers the Edit control`, hadEditButton === true, S({ hadEditButton }));
  chk(`${type}: the editor canvas is a flex column, not a collapsed block`,
    g.canvasDisplay === "flex", S({ display: g.canvasDisplay }));
  chk(`${type}: the editor element has a usable box (>120px tall)`,
    g.pmFound && g.pmBox.h > 120, S(g.pmBox ?? g));
  chk(`${type}: the text area has a usable box (>80px tall) and is contenteditable`,
    g.cmFound && g.cmBox.h > 80 && g.editable === true, S({ box: g.cmBox, editable: g.editable }));
  chk(`${type}: a click at the text-area centre reaches the text area`,
    g.reachable === true, S({ hit: g.hit, box: g.cmBox }));
  await p.evaluate(async () => {
    for (const it of game.items.filter(i => i.name.startsWith("__PW__NOTES"))) { await it.sheet?.close?.(); await it.delete().catch(() => {}); }
  });
}

// ── C · the real click-and-type gesture, per representative type ───────────────────────
for (const type of GESTURE_TYPES) {
  const { appId } = await openNotes("item", type);
  const typed = `Ripperdoc note ${type}`;
  const clicked = await tryClick(p.locator(`#${appId} prose-mirror .ProseMirror`).first(),
    `${type}: the text area accepts a real click (nothing intercepts it)`);
  if (clicked) { await p.keyboard.type(typed); await p.waitForTimeout(900); }
  const res = await p.evaluate(async (typed) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const doc = game.items.find(i => i.name.startsWith("__PW__NOTES"));
    const whileEditing = doc.system.notes;
    await doc.sheet.close(); await sleep(900);
    const afterClose = doc.system.notes;
    await doc.sheet.render(true); await sleep(900);
    const root = doc.sheet.element.closest(".application");
    root.querySelector('nav.sheet-tabs a[data-tab="notes"]').click(); await sleep(400);
    const view = (root.querySelector(".cp-notes-view")?.textContent ?? "").trim();
    await doc.sheet.close(); await doc.delete().catch(() => {});
    return { whileEditing, afterClose, view, typed };
  }, typed);
  chk(`${type}: typing into the text area writes through to the document`,
    String(res.whileEditing).includes(typed), S(res.whileEditing));
  chk(`${type}: the typed note survives closing the sheet`,
    String(res.afterClose).includes(typed), S(res.afterClose));
  chk(`${type}: reopening the sheet renders the saved note in the read-only view`,
    res.view === typed, S({ view: res.view, expected: typed }));
}

// ── D · the Format menu opens and applies ─────────────────────────────────────────────
{
  const { appId } = await openNotes("item", "program");
  const clicked = await tryClick(p.locator(`#${appId} prose-mirror .ProseMirror`).first(),
    "the text area accepts a real click before a Format action");
  if (clicked) { await p.keyboard.type("Formatted line"); await p.waitForTimeout(700); }
  const before = await p.evaluate(() => !!document.querySelector("#prosemirror-dropdown"));
  await tryClick(p.locator(`#${appId} prose-mirror menu button.pm-dropdown`).first(), "the Format control accepts a real click");
  await p.waitForTimeout(450);
  const opened = await p.evaluate(() => {
    const el = document.querySelector("#prosemirror-dropdown");
    if (!el) return { present: false };
    const first = el.querySelector(":scope > ul > li");
    const r = first?.getBoundingClientRect();
    const hit = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
    return { present: true, entries: el.querySelectorAll(":scope > ul > li").length,
             firstReachable: !!first && (hit === first || first.contains(hit)) };
  });
  chk("the Format menu is closed until its control is clicked", before === false, S({ before }));
  chk("clicking the Format control opens a populated, hit-testable menu",
    opened.present === true && opened.entries >= 5 && opened.firstReachable === true, S(opened));

  await p.locator('#prosemirror-dropdown > ul > li[data-action="headings"]').first().hover({ timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(400);
  const sub = await p.evaluate(() => {
    const s = document.querySelector('#prosemirror-dropdown li[data-action="headings"] > ul');
    const r = s?.getBoundingClientRect();
    return { display: s ? getComputedStyle(s).display : null, h: r ? Math.round(r.height) : 0 };
  });
  chk("hovering a Format group opens its submenu", sub.display === "block" && sub.h > 40, S(sub));

  await tryClick(p.locator('#prosemirror-dropdown li[data-action="h2"]').first(), "the Heading 2 entry accepts a real click");
  await p.waitForTimeout(700);
  const dom = await p.locator(`#${appId} prose-mirror .ProseMirror`).first().innerHTML();
  const persisted = await p.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const doc = game.items.find(i => i.name.startsWith("__PW__NOTES"));
    await doc.sheet.close(); await sleep(900);
    const notes = doc.system.notes;
    await doc.delete().catch(() => {});
    return notes;
  });
  chk("choosing Heading 2 applies the heading in the editor", /<h2>Formatted line<\/h2>/.test(dom), S(dom));
  chk("a menu-applied heading is flushed to the document on close",
    /<h2>Formatted line<\/h2>/.test(String(persisted)), S(persisted));
}

// ── E · actor Life tab — the in-house reference must stay green ────────────────────────
{
  const { appId, hadEditButton } = await openNotes("actor", null);
  const g = await probeBox(appId);
  chk("actor Life tab: the Edit control is present", hadEditButton === true, S({ hadEditButton }));
  chk("actor Life tab: a click at the text-area centre reaches the text area",
    g.reachable === true && g.cmBox.h > 80, S({ hit: g.hit, box: g.cmBox }));
  const aClicked = await tryClick(p.locator(`#${appId} prose-mirror .ProseMirror`).first(),
    "actor Life tab: the text area accepts a real click");
  if (aClicked) { await p.keyboard.type("Lifepath entry"); await p.waitForTimeout(900); }
  const res = await p.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const a = game.actors.find(a => a.name.startsWith("__PW__NOTES"));
    await a.sheet.close(); await sleep(900);
    const notes = a.system.notes;
    await a.delete().catch(() => {});
    return notes;
  });
  chk("actor Life tab: the typed note persists", String(res).includes("Lifepath entry"), S(res));
}

// ── F · no scroll regression on the settings tab ──────────────────────────────────────
const scroll = await p.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  for (const type of ["cyberware", "weapon", "ammo", "vehicle"]) {
    const it = await Item.create({ name: `__PW__NOTESSCROLL ${type}`, type });
    await it.sheet.render(true); await sleep(800);
    const root = it.sheet.element.closest(".application");
    root.querySelector('nav.sheet-tabs a[data-tab="settings"]').click(); await sleep(350);
    const wc = root.querySelector("section.window-content");
    const tab = root.querySelector('.tab[data-tab="settings"]');
    const kids = [...tab.querySelectorAll("*")];
    const last = kids[kids.length - 1];
    wc.scrollTop = wc.scrollHeight; await sleep(250);
    const lr = last.getBoundingClientRect(), wr = wc.getBoundingClientRect();
    out[type] = {
      scrollable: wc.scrollHeight > wc.clientHeight,
      lastFieldReachable: lr.bottom <= wr.bottom + 2 && lr.top >= wr.top - 2
    };
    await it.sheet.close(); await it.delete().catch(() => {});
  }
  return out;
});
for (const [type, s] of Object.entries(scroll)) {
  chk(`${type}: the settings tab still scrolls on the window content`, s.scrollable === true, S(s));
  chk(`${type}: the last settings field is reachable after scrolling to the bottom`, s.lastFieldReachable === true, S(s));
}

// ── G · window-header controls: painted box contains its glyph, and is clickable ───────
const header = await p.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  const item = await Item.create({ name: "__PW__NOTESHDR prog", type: "program" });
  const actor = await Actor.create({ name: "__PW__NOTESHDR punk", type: "character" });
  const grab = async (doc, key) => {
    // one sheet at a time: a centre hit-test is z-order sensitive
    await doc.sheet.render(true); await sleep(900);
    const root = doc.sheet.element.closest(".application");
    out[key] = [...root.querySelectorAll(".window-header button.header-control")].map(bt => {
      const r = bt.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        action: bt.dataset.action,
        w: Math.round(r.width), h: Math.round(r.height),
        // the glyph is a ::before inside the button's content box — an overflow means the painted
        // background box does not cover it
        glyphOverflows: bt.scrollWidth > bt.clientWidth + 0.5 || bt.scrollHeight > bt.clientHeight + 0.5,
        centred: getComputedStyle(bt).alignItems === "center" && getComputedStyle(bt).justifyContent === "center",
        clickable: hit === bt || bt.contains(hit)
      };
    });
    await doc.sheet.close(); await sleep(250);
  };
  await grab(item, "item");
  await grab(actor, "actor");
  await item.delete().catch(() => {}); await actor.delete().catch(() => {});
  return out;
});
for (const [key, controls] of Object.entries(header)) {
  chk(`${key} sheet: all three window-header controls are present`, controls.length === 3, S(controls.map(c => c.action)));
  for (const c of controls) {
    chk(`${key} sheet header control "${c.action}": its painted box covers its glyph`,
      c.w >= 20 && c.h >= 20 && c.glyphOverflows === false && c.centred === true, S(c));
    chk(`${key} sheet header control "${c.action}": the box centre is the button itself`, c.clickable === true, S(c));
  }
}

// ── cleanup + console gate ────────────────────────────────────────────────────────────
await p.evaluate(async () => {
  for (const it of game.items.filter(i => i.name.startsWith("__PW__"))) await it.delete().catch(() => {});
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__"))) await a.delete().catch(() => {});
}).catch(() => {});
chk("0 console errors", errors.length === 0, errors.slice(0, 6).join(" | "));

let fail = 0;
for (const c of P) { if (!c.ok) fail++; console.log(`${c.ok ? "PASS" : "FAIL"} — ${c.name}${c.ok ? "" : "  [" + c.detail + "]"}`); }
console.log(`\n${P.length - fail}/${P.length} checks passed`);
await b.close();
process.exit(fail ? 1 : 0);
