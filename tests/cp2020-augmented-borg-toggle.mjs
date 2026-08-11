/** Full-conversion borg manual toggle (sheet). :30004 (official 1.1.1 + module).
 *  A 3-state select (Auto / Full Borg / Not a Borg) on the combat tab's armor-section overrides the
 *  fullBorg flag: on→true, off→false, auto→unset (detection falls back to an equipped body item). Shown
 *  only for borg-capable actors (a body item / the flag / any cyber-SDP). No canvas (sheet render only). */
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
  const out = {};
  const BG = await import("/modules/cp2020-augmented/module/mech/borg.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const SCOPE = "cp2020-augmented";

  const openCombat = async (actor) => {
    await actor.sheet.render(true); await sleep(700);
    const root = actor.sheet.element;
    root.querySelector('nav [data-tab="combat"], [data-tab="combat"].item, a[data-tab="combat"]')?.click?.();
    await sleep(400);
    return root;
  };

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Toggle"))) await a.delete().catch(() => {});

  // ── borg-capable actor: an equipped body item (auto-detects as borg, flag unset) ──
  const actor = await Actor.create({ name: "__PW__ToggleBorg", type: "character" });
  await actor.createEmbeddedDocuments("Item", [{
    name: "__PW__Body", type: "cyberware", system: { equipped: true, EffectMode: "Permanent" },
    flags: { [SCOPE]: { borgBody: {
      sp:  { Head:25, Torso:25, lArm:25, rArm:25, lLeg:25, rLeg:25 },
      sdp: { Head:30, Torso:40, lArm:30, rArm:30, lLeg:30, rLeg:30 }
    } } }
  }]);
  for (let i = 0; i < 25 && (Number(actor.system?.sdp?.sum?.Torso) || 0) !== 40; i++) await sleep(200);

  const root = await openCombat(actor);
  const sel0 = root.querySelector(".cp-fullborg-select");
  out.render = {
    present: !!sel0,
    options: sel0 ? [...sel0.options].map(o => o.value).join(",") : "",
    selected: sel0?.value ?? "",                                       // "auto" (flag unset)
    noRawKeys: sel0 ? ![...sel0.options].some(o => /CYBERPUNK\./.test(o.textContent)) : false,
    autoIsBorg: BG.isFullBorg(actor),                                  // auto detects the body item → true
  };

  // change the select and confirm the flag + effective isFullBorg follow (re-query after each re-render)
  const setMode = async (mode) => {
    const sel = actor.sheet.element.querySelector(".cp-fullborg-select");
    if (!sel) return { ok: false };
    sel.value = mode;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(600);
    return {
      ok: true,
      flag: actor.getFlag(SCOPE, "fullBorg"),
      isBorg: BG.isFullBorg(actor),
      selNow: actor.sheet.element.querySelector(".cp-fullborg-select")?.value ?? null,
    };
  };
  out.off  = await setMode("off");    // force off: flag false, NOT a borg despite the body item
  out.on   = await setMode("on");     // force on:  flag true
  out.auto = await setMode("auto");   // auto: flag cleared → falls back to the body item (borg again)

  // ── plain character: no cyber-SDP, no borg item → the toggle must NOT render ──
  const plain = await Actor.create({ name: "__PW__TogglePlain", type: "character" });
  const proot = await openCombat(plain);
  out.plainHidden = !proot.querySelector(".cp-fullborg-select");

  // ── SDP-edit clobber fix: editing ONE zone's SDP on the sheet must not heal the OTHER zones (bare
  //    ObjectField dotted-write hazard, §7). Damage two zones, edit one, assert the other is preserved. ──
  out.sdpEdit = { err: null };
  try {
    await actor.unsetFlag(SCOPE, "fullBorg");   // back to auto (borg via the body item)
    await actor.update({ "system.sdp.current": { ...(actor.system.sdp.current || {}), Head: 12, Torso: 20 } });
    await sleep(300);
    const root2 = await openCombat(actor);
    const torsoInput = root2.querySelector('input[name="system.sdp.current.Torso"]');
    out.sdpEdit.hasInput = !!torsoInput;
    if (torsoInput) {
      torsoInput.value = "25";
      torsoInput.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(700);
    }
    out.sdpEdit.torsoAfter = Number(actor.system?.sdp?.current?.Torso);   // 25 (the edited zone persists)
    out.sdpEdit.headAfter = Number(actor.system?.sdp?.current?.Head);     // still 12 (NOT healed to 30)
  } catch (e) { out.sdpEdit.err = e?.message || String(e); }

  await actor.sheet.close().catch(() => {});
  await plain.sheet.close().catch(() => {});
  await actor.delete().catch(() => {});
  await plain.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["toggle renders for a borg-capable actor, 3 options (auto,on,off)", r.render.present === true && r.render.options === "auto,on,off"],
  ["defaults to Auto (flag unset) and auto-detects the body item as a borg", r.render.selected === "auto" && r.render.autoIsBorg === true],
  ["option labels are localized (no raw CYBERPUNK. keys)", r.render.noRawKeys === true],
  ["force OFF → flag false, NOT a borg despite the equipped body item", r.off.ok && r.off.flag === false && r.off.isBorg === false],
  ["force ON → flag true, is a borg", r.on.flag === true && r.on.isBorg === true],
  ["AUTO → flag cleared (unset), falls back to the body item (borg again)", (r.auto.flag === undefined || r.auto.flag === null) && r.auto.isBorg === true],
  ["select reflects the persisted state after re-render (auto)", r.auto.selNow === "auto"],
  ["plain character (no cyber-SDP) does NOT show the toggle", r.plainHidden === true],
  ["sheet SDP edit persists the edited zone (Torso → 25)", r.sdpEdit.hasInput === true && r.sdpEdit.torsoAfter === 25],
  ["sheet SDP edit does NOT heal sibling zones (Head stays 12, not full)", r.sdpEdit.headAfter === 12],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
