/** Effect-note row keeper (item sheet, drug + consumable blocks).
 *
 *  The effect note is a sentence. It used to sit in a half-width cell as a one-line input: 115px of
 *  box for a 430px sentence, cut off where the right-hand column begins, and still cut off with the
 *  window dragged to 1300px. It is now a full-width row whose text wraps in a box that grows.
 *
 *   A  NOTHING CLIPPED — the two reference notes (one that needs two lines, the longest shipped one)
 *      show every character at three window widths, the row spans the whole field list, and it never
 *      overlaps the row after it; a note that fits one line still stands 24px, a one-line input's height
 *   B  SAME KIND OF FIELD — in both colour schemes the box carries the ink, ground, border and face of
 *      the one-line input beside it
 *   C  THE EDIT GESTURE — typing into the box on an editable item writes the document, the value is
 *      there when the sheet is reopened, and the consumable block's note is the same kind of row
 *
 *  Run:  node tests/cp2020-augmented-effect-note.mjs            (rig :30004)
 */
import { chromium } from "@playwright/test";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const PACK = "cp2020-augmented.supplement-gear";
const FIXTURE = "__PW__ effect note";

async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

let fail = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) fail++; };

const errors = [];
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1700, height: 950 } });
p.on("pageerror", e => errors.push(String(e)));
p.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await joinGM(p);

const prior = await p.evaluate(() => foundry.utils.deepClone(game.settings.get("core", "uiConfig").colorScheme ?? {}));
const closeSheets = () => p.evaluate(async () => {
  for (const app of [...foundry.applications.instances.values()]) if (/ItemSheet/i.test(app.constructor.name)) { try { await app.close({ animate: false }); } catch { /* already gone */ } }
});

try {
  // ── A + B: the shipped notes, both schemes, three widths ───────────────────────────────────────
  for (const scheme of ["dark", "light"]) {
    for (const itemName of ["'Dorph", "Paracaine"]) {
      await closeSheets();
      const r = await p.evaluate(async ({ scheme, itemName, PACK }) => {
        const sleep = ms => new Promise(res => setTimeout(res, ms));
        const cfg = foundry.utils.deepClone(game.settings.get("core", "uiConfig")); cfg.colorScheme = { applications: scheme, interface: scheme };
        await game.settings.set("core", "uiConfig", cfg); await sleep(500);
        ui.notifications?.clear?.();
        const pack = game.packs.get(PACK);
        const e = (await pack.getIndex()).find(x => x.name === itemName);
        if (!e) return { missing: true };
        const doc = await pack.getDocument(e._id);
        await doc.sheet.render(true); await sleep(1600);
        const root = doc.sheet.element.closest(".application") ?? doc.sheet.element;
        const rect = el => { const q = el.getBoundingClientRect(); return { y: Math.round(q.y), w: Math.round(q.width), h: Math.round(q.height), b: Math.round(q.bottom) }; };
        const LOOK = ["color", "backgroundColor", "borderTopWidth", "borderRadius", "fontFamily", "fontSize", "fontWeight", "boxShadow"];
        const look = el => Object.fromEntries(LOOK.map(k => [k, getComputedStyle(el)[k]]));
        const measure = () => {
          const ta = root.querySelector('textarea[name="system.mechDrug.note"]');
          if (!ta) return { noBox: true, tag: root.querySelector('[name="system.mechDrug.note"]')?.tagName ?? null };
          const field = ta.closest(".field"); const list = field.closest(".field-list"); const next = field.nextElementSibling;
          const sib = root.querySelector('input[name="system.mechDrug.duration"]');
          return { app: rect(root).w, listW: rect(list).w, rowW: rect(field).w, rowB: rect(field).b, nextY: next ? rect(next).y : null,
            boxH: rect(ta).h, clientH: ta.clientHeight, scrollH: ta.scrollHeight, clientW: ta.clientWidth, scrollW: ta.scrollWidth,
            chars: ta.value.length, look: look(ta), sibLook: look(sib) };
        };
        const out = { default: measure() };
        if (out.default.noBox) return out;
        for (const w of [420, 900]) { doc.sheet.setPosition({ width: w }); await sleep(450); out["w" + w] = measure(); }
        doc.sheet.setPosition({ width: out.default.app }); await sleep(200);
        return out;
      }, { scheme, itemName, PACK });

      const tag = `${scheme} / ${itemName}`;
      if (r.missing || r.default?.noBox) { check(`A  ${tag}: the note renders as a wrapping box`, false, r.missing ? "item not in the pack" : `element is ${r.default.tag}`); continue; }
      for (const [k, m] of Object.entries(r)) {
        check(`A  ${tag} @${k}: every character of the ${m.chars}-character note is shown`, m.scrollH <= m.clientH && m.scrollW <= m.clientW,
          `height ${m.clientH}/${m.scrollH}, width ${m.clientW}/${m.scrollW}, window ${m.app}`);
        check(`A  ${tag} @${k}: the row spans the whole field list and clears the next row`, m.rowW === m.listW && (m.nextY === null || m.rowB <= m.nextY),
          `row ${m.rowW} of list ${m.listW}; row bottom ${m.rowB}, next top ${m.nextY}`);
      }
      const wide = r.w900;
      if (itemName === "'Dorph") check(`A  ${tag} @w900: a note that fits one line stands a one-line input's height`, wide.boxH === 24, `box ${wide.boxH}px`);
      const d = r.default;
      const off = Object.keys(d.look).filter(k => d.look[k] !== d.sibLook[k]).map(k => `${k}: ${d.look[k]} vs ${d.sibLook[k]}`);
      check(`B  ${tag}: the box carries the look of the one-line input beside it`, off.length === 0, off.join("; "));
    }
  }

  // ── C: the edit gesture on an editable item ────────────────────────────────────────────────────
  await closeSheets();
  await p.evaluate(async ({ PACK, FIXTURE, prior }) => {
    const cfg = foundry.utils.deepClone(game.settings.get("core", "uiConfig")); cfg.colorScheme = prior; await game.settings.set("core", "uiConfig", cfg);
    for (const i of game.items.filter(x => x.name === FIXTURE)) await i.delete();
    const pack = game.packs.get(PACK);
    const e = (await pack.getIndex()).find(x => x.name === "'Dorph");
    const src = (await pack.getDocument(e._id)).toObject(); delete src._id; src.name = FIXTURE;
    const item = await Item.create(src);
    await item.sheet.render(true); await new Promise(res => setTimeout(res, 1600));
  }, { PACK, FIXTURE, prior });

  const TYPED = "Typed by the keeper: a sentence long enough to need a second line in the box at the default width.";
  const box = p.locator('textarea[name="system.mechDrug.note"]').first();
  const before = await p.evaluate((FIXTURE) => game.items.getName(FIXTURE).system.mechDrug.note, FIXTURE);
  check("C  the fixture opens editable, holding the shipped note", await box.isEditable() && /Stun Saves/.test(before), `editable ${await box.isEditable()}, note "${before.slice(0, 40)}…"`);
  await box.fill(TYPED);
  await box.press("Tab");
  const saved = await p.waitForFunction(({ FIXTURE, TYPED }) => game.items.getName(FIXTURE)?.system.mechDrug.note === TYPED, { FIXTURE, TYPED }, { timeout: 8000 }).then(() => true).catch(() => false);
  const stored = await p.evaluate((FIXTURE) => { const s = game.items.getName(FIXTURE).system.mechDrug; return { note: s.note, duration: s.duration, turns: s.durationTurns }; }, FIXTURE);
  check("C  typing in the box and leaving it writes the document", saved && stored.note === TYPED, `stored "${stored.note.slice(0, 50)}…"`);
  check("C  the neighbouring fields are untouched by that write", stored.duration === "1D6+1 turns" && stored.turns === "1d6+1", JSON.stringify({ duration: stored.duration, turns: stored.turns }));

  const reopened = await p.evaluate(async ({ FIXTURE }) => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const item = game.items.getName(FIXTURE);
    await item.sheet.close({ animate: false }); await sleep(300);
    await item.update({ "system.mechConsumable.enabled": true, "system.mechConsumable.note": "Second block, same kind of row: the text wraps here as well and nothing is cut off at the cell edge." });
    await item.sheet.render(true); await sleep(1600);
    const root = item.sheet.element.closest(".application") ?? item.sheet.element;
    const drug = root.querySelector('textarea[name="system.mechDrug.note"]');
    const cons = root.querySelector('textarea[name="system.mechConsumable.note"]');
    const facts = (ta) => ta ? { value: ta.value, clipped: ta.scrollHeight > ta.clientHeight || ta.scrollWidth > ta.clientWidth,
      spans: Math.round(ta.closest(".field").getBoundingClientRect().width) === Math.round(ta.closest(".field-list").getBoundingClientRect().width) } : null;
    return { drug: facts(drug), cons: facts(cons) };
  }, { FIXTURE });
  check("C  the reopened sheet shows the typed note, unclipped", reopened.drug?.value === TYPED && reopened.drug.clipped === false, JSON.stringify(reopened.drug)?.slice(0, 120));
  check("C  the consumable block's note is the same full-width wrapping row", !!reopened.cons && reopened.cons.spans && reopened.cons.clipped === false && /Second block/.test(reopened.cons.value),
    JSON.stringify(reopened.cons)?.slice(0, 120));
} finally {
  await closeSheets().catch(() => {});
  await p.evaluate(async ({ FIXTURE, prior }) => {
    for (const i of game.items.filter(x => x.name === FIXTURE)) await i.delete().catch(() => {});
    const cfg = foundry.utils.deepClone(game.settings.get("core", "uiConfig")); cfg.colorScheme = prior; await game.settings.set("core", "uiConfig", cfg);
  }, { FIXTURE, prior }).catch(() => {});
}

const left = await p.evaluate((FIXTURE) => ({ fixtures: game.items.filter(x => x.name === FIXTURE).length, scheme: game.settings.get("core", "uiConfig").colorScheme ?? {} }), FIXTURE);
check("Z  fixture removed and the colour scheme restored", left.fixtures === 0 && JSON.stringify(left.scheme) === JSON.stringify(prior), JSON.stringify(left));
check("Z  0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await b.close();
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
