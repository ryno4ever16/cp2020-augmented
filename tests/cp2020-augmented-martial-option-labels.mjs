/**
 * Style-dropdown option labels in the martial modifier dialog. :30004 (official 1.1.1 + module).
 *
 * The dialog's <select> rows are rendered by the BASE system's shared field template
 * (systems/cyberpunk2020/templates/fields/select.hbs) through its `selectOption` helper
 * (module/handlebars-helpers.js). That helper copies exactly four properties off a choice —
 * value / localKey / localData / label — and the template prints `label` when present, else
 * `CPLocal localKey` (which falls back to the bare key string when no translation exists).
 * So a choice's display text has to arrive as `label`; any other property name is dropped and the
 * row prints its raw VALUE instead — for a built-in style that is the canonical key
 * ("Martial Arts: Aikido"), for a custom one the internal handle ("custom-martial:<itemId>").
 *
 * Checks the produced option TEXT in the real rendered dialog, and that the option VALUE (what the
 * form submits, and what every downstream style lookup keys off) is unchanged by the display fix.
 *
 *   FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node tests/cp2020-augmented-martial-option-labels.mjs
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = { err: null };
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  try {
    if (!canvas?.scene) { const sc = game.scenes.contents[0]; if (sc) { await sc.activate(); await sleep(1500); } }

    const L = await import("/modules/cp2020-augmented/module/lookups.js");

    for (const a of game.actors.filter(a => a.name.startsWith("__PW__StyleRow"))) await a.delete().catch(() => {});
    const actor = await Actor.create({ name: "__PW__StyleRow", type: "character" });

    // Give every seeded style a level so trainedMartials() reports them, and add one uniquely named
    // custom style (the branch whose value is an internal handle rather than a readable key).
    const seeded = actor.itemTypes.skill.filter(s => L.isMartialArtSkillItem?.(s));
    if (seeded.length) {
      await actor.updateEmbeddedDocuments("Item", seeded.slice(0, 3).map(s => ({ _id: s.id, "system.level": 4 })));
    }
    await actor.createEmbeddedDocuments("Item", [
      { name: "Martial Arts: __PW__Kravat", type: "skill", system: { level: 5 } }
    ]);
    await sleep(200);

    const keys = actor.trainedMartials();
    out.keyShape = typeof keys[0];
    out.keyCount = keys.length;

    // ── (A) the data contract: what property carries the display text ──────────────────────────
    const groups = L.martialOptions(actor);
    const styleRow = groups[0].find(r => r.dataPath === "martialArt");
    const choices = styleRow.choices;
    out.choiceCount = choices.length;
    // Brawling is the localKey control row — it is meant to have NO label and localize by key.
    const trained = choices.filter(c => c.value !== "Brawling");
    out.trainedCount = trained.length;
    out.allCarryLabel = trained.every(c => typeof c.label === "string" && c.label.length > 0);
    out.noneCarryStrayText = trained.every(c => c.text === undefined);
    out.brawlingUsesLocalKey = choices[0]?.value === "Brawling" && choices[0]?.localKey === "SkillBrawling";

    // ── (B) the rendered row: what a player actually reads ────────────────────────────────────
    const sheet = actor.sheet;
    await sheet.render(true);
    await sleep(900);
    sheet._cpOpenMartialActionDialog({ dataset: { action: "Strike" } });
    await sleep(1200);

    const dlg = [...foundry.applications.instances.values()]
      .filter(a => a.constructor?.name === "ModifiersDialog").pop();
    out.dialogOpen = !!dlg?.element;
    const sel = dlg?.element?.querySelector('select[name="martialArt"]');
    out.selectFound = !!sel;
    const opts = [...(sel?.options ?? [])].map(o => ({ value: o.value, text: (o.textContent || "").trim() }));
    out.options = opts;

    const rendered = opts.filter(o => o.value !== "Brawling");
    // Each rendered row must read as the actor's own display name for that style.
    out.textsMatchDisplayName = rendered.every(o => o.text === actor.getMartialDisplayName(o.value));
    // The two raw-value leaks the dropped property produces.
    out.noRawPrefixLeak = rendered.every(o => !/^Martial Arts:/i.test(o.text));
    out.noInternalHandleLeak = rendered.every(o => !/^custom-martial:/.test(o.text));
    out.customRowReadable = rendered.some(o => o.text === "__PW__Kravat");
    // The submitted value is the key, untouched by the display fix.
    out.valuesStillKeys = rendered.every(o => keys.includes(o.value));
    out.brawlingRowText = opts.find(o => o.value === "Brawling")?.text ?? null;

    await dlg?.close?.().catch(() => {});
    await sheet.close().catch(() => {});
    await actor.delete().catch(() => {});
  } catch (e) { out.err = e?.message || String(e); }
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["fixture reports trained styles to the row builder", r.keyCount > 0 && !r.err],
  ["every trained choice carries the display text in `label` (the property the renderer copies)", r.allCarryLabel === true],
  ["no trained choice ships display text under a property the renderer ignores", r.noneCarryStrayText === true],
  ["control row: Brawling still localizes by key, no label of its own", r.brawlingUsesLocalKey === true],
  ["dialog renders with the style row present", r.dialogOpen === true && r.selectFound === true],
  ["each rendered row reads as the actor's display name for that style", r.textsMatchDisplayName === true],
  ["no row prints the raw canonical key (\"Martial Arts: …\")", r.noRawPrefixLeak === true],
  ["no row prints the internal handle (\"custom-martial:…\")", r.noInternalHandleLeak === true],
  ["the custom style reads as its own name", r.customRowReadable === true],
  ["submitted values are still the style keys (display fix only)", r.valuesStillKeys === true],
  ["control row text is the localized Brawling label, not a bare key", typeof r.brawlingRowText === "string" && r.brawlingRowText.length > 0 && !r.brawlingRowText.includes("CYBERPUNK.")],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
