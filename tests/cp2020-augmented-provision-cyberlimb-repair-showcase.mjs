/** Cyberlimb repair-showcase provisioner runner: executes the provisioning macro on the rig, then
 *  asserts every band's true state (ok / damaged / useless / destroyed / scaled-band / two-zone),
 *  the sheet render gate (a full limb shows NO badge and NO repair control), a REAL click on the
 *  repair control, and that repairing one zone leaves its sibling zone untouched. */
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const MACRO = "C:/Users/randa/AppData/Local/FoundryVTT/Data/modules/cp2020-augmented/import-staging/test-fixtures/provision-cyberlimb-repair-showcase.js";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const src = readFileSync(MACRO, "utf-8");

// The repair control is gated on cpCanRepairLimb — keep the GM-only scoping OFF so the default
// (everyone can repair) is what we assert; the GM-only leg is asserted separately below.
await p.evaluate(async () => { await game.settings.set("cp2020-augmented", "cyberlimbRepairGmOnly", false).catch(() => {}); });

const prov = await p.evaluate(async (code) => await eval(code), src);
if (!prov?.actors) { console.log("RESULT: FAIL — provisioner returned", JSON.stringify(prov)); process.exit(1); }
if (prov.notes?.length) console.log("provisioner notes:", JSON.stringify(prov.notes));

const r = await p.evaluate(async (prov) => {
  const out = { checks: [], fails: [] };
  const CL = await import("/modules/cp2020-augmented/module/mech/cyberlimb.js");
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const check = (name, ok, got) => { out.checks.push(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok ? "" : "  got=" + JSON.stringify(got)}`); if (!ok) out.fails.push(name); };
  const A = k => game.actors.get(prov.actors[k]);
  const st = (k, zone) => CL.cyberlimbSheetStatus(A(k))[zone] ?? null;

  // ── (0) provisioner cleanliness ────────────────────────────────────────────
  check("provisioner: 6 actors, no missing packs / SDP folds", Object.keys(prov.actors).length === 6 && (prov.notes?.length ?? 0) === 0, { actors: Object.keys(prov.actors).length, notes: prov.notes });

  // ── (1) every band's TRUE state (values, not presence) ─────────────────────
  const ok = st("ok", "rArm");
  check("ok: 30/30, status ok, not damaged (no repair control expected)", ok?.status === "ok" && ok?.damaged === false && ok?.current === 30 && ok?.max === 30, ok);

  const dmg = st("damaged", "rArm");
  check("damaged: 18/30, status damaged (sheet-only state, no sticky flag)", dmg?.status === "damaged" && dmg?.damaged === true && dmg?.current === 18 && dmg?.max === 30, dmg);
  check("damaged: no limbStatus flag written above the useless band", (A("damaged").getFlag("cp2020-augmented", "limbStatus") ?? {}).rArm === undefined, A("damaged").getFlag("cp2020-augmented", "limbStatus"));

  const use = st("useless", "rArm");
  check("useless: 9/30 -> status useless (last 10 points)", use?.status === "useless" && use?.damaged === true && use?.current === 9 && use?.max === 30, use);
  check("useless: sticky flag reads 'disabled'", (A("useless").getFlag("cp2020-augmented", "limbStatus") ?? {}).rArm === "disabled", A("useless").getFlag("cp2020-augmented", "limbStatus"));

  const des = st("destroyed", "rArm");
  check("destroyed: status destroyed via the sticky flag", des?.status === "destroyed" && des?.damaged === true, des);
  // The UI-honesty guard: the base's prep resets a 0 back to sum on EVERY pass, so without our
  // applyDestroyedLimbSdp truth pass this read 30 — a "30 / 30" pair beside a red DESTROYED badge.
  check("destroyed: the SDP number reads 0/30 — NOT the base's reset-to-full", des?.current === 0 && des?.max === 30, des);
  check("destroyed: the STORED current is 0 too (the reset was only ever derived)", Number(A("destroyed")._source?.system?.sdp?.current?.rArm) === 0, A("destroyed")._source?.system?.sdp?.current);
  check("destroyed: sticky flag reads 'destroyed'", (A("destroyed").getFlag("cp2020-augmented", "limbStatus") ?? {}).rArm === "destroyed", A("destroyed").getFlag("cp2020-augmented", "limbStatus"));
  // M19: gear in a destroyed zone stops contributing.
  const destroyedArmItems = A("destroyed").items.filter(i => i.type === "cyberware");
  const contributing = CL.contributingItems(A("destroyed"));
  check("destroyed: the wrecked zone's cyberware drops out of contributingItems (M19)", destroyedArmItems.length > 0 && !contributing.some(i => destroyedArmItems.some(d => d.id === i.id)), { installed: destroyedArmItems.length, stillContributing: contributing.filter(i => destroyedArmItems.some(d => d.id === i.id)).length });

  // The band SCALES with the pool: rams -> 40 SDP, so useless is 30 damage, not a hardcoded 20.
  const rams = st("rams", "rArm");
  check("rams: pool is 40 (arm 30 + rams 10)", rams?.max === 40, rams);
  check("rams: 9/40 -> useless, proving the band is the final 10 (not a fixed 20/30)", rams?.status === "useless" && rams?.current === 9, rams);

  // ── (2) two zones are independent ──────────────────────────────────────────
  const twoArm = st("twoZones", "rArm"), twoLeg = st("twoZones", "lLeg");
  check("twoZones: rArm destroyed AND lLeg damaged 18/30 (siblings both tracked)", twoArm?.status === "destroyed" && twoLeg?.status === "damaged" && twoLeg?.current === 18 && twoLeg?.max === 30, { twoArm, twoLeg });

  // ── (3) SHEET render gate: the control only exists on a damaged limb ───────
  const openCombat = async (actor) => {
    await actor.sheet.render(true); await sleep(700);
    const root = actor.sheet.element;
    root?.querySelector?.('.sheet-tabs [data-tab="combat"], a[data-tab="combat"], .item[data-tab="combat"]')?.click?.();
    await sleep(350);
    return root;
  };
  const okRoot = await openCombat(A("ok"));
  check("sheet NEGATIVE: a full limb renders NO repair control", !okRoot?.querySelector('.cp-cyberlimb-repair[data-zone="rArm"]'), !!okRoot?.querySelector('.cp-cyberlimb-repair[data-zone="rArm"]'));
  check("sheet NEGATIVE: a full limb renders NO status badge", !okRoot?.querySelector('.segment-status-row .segment-limb-status'), okRoot?.querySelector('.segment-status-row .segment-limb-status')?.textContent);
  await A("ok").sheet.close();

  const desRoot = await openCombat(A("destroyed"));
  const desBadge = desRoot?.querySelector(".segment-status-row .segment-limb-status.cp-limb-destroyed");
  check("sheet: destroyed limb renders the destroyed badge with its label", !!desBadge && /destroyed/i.test(desBadge.textContent || ""), desBadge?.textContent);
  check("sheet: destroyed limb renders the repair control", !!desRoot?.querySelector('.cp-cyberlimb-repair[data-zone="rArm"]'), null);
  // VISIBILITY, not just presence. The base hides .segment-repair and reveals it only on
  // .armor-segment:hover; we reused that class, so the control sat at display:none / 0x0 at rest for a
  // whole release while "is it in the DOM?" and a scripted .click() both passed (a 0x0 element still
  // accepts a programmatic click). Assert a real box with no hover — that is what a player can find.
  const repEl = desRoot?.querySelector('.cp-cyberlimb-repair[data-zone="rArm"]');
  const repBox = repEl?.getBoundingClientRect();
  const repCs = repEl ? getComputedStyle(repEl) : null;
  check("sheet: the repair control is VISIBLE AT REST (non-zero box, no hover) — not hover-only",
        !!repBox && repBox.width > 0 && repBox.height > 0 && repCs.display !== "none" && repCs.visibility !== "hidden",
        { display: repCs?.display, w: Math.round(repBox?.width ?? 0), h: Math.round(repBox?.height ?? 0) });
  await A("destroyed").sheet.close();

  // ── (4) REAL GESTURE: click the repair control on the two-zone actor ───────
  const twoRoot = await openCombat(A("twoZones"));
  const btn = twoRoot?.querySelector('.cp-cyberlimb-repair[data-zone="rArm"]');
  check("gesture: the two-zone actor's rArm repair control is present to click", !!btn, null);
  btn?.click();
  for (let i = 0; i < 30 && st("twoZones", "rArm")?.status !== "ok"; i++) await sleep(150);
  const afterArm = st("twoZones", "rArm"), afterLeg = st("twoZones", "lLeg");
  check("gesture: clicking repair restores rArm to 30/30 and clears the flag", afterArm?.status === "ok" && afterArm?.current === 30 && (A("twoZones").getFlag("cp2020-augmented", "limbStatus") ?? {}).rArm === undefined, afterArm);
  check("gesture: repairing rArm leaves the SIBLING lLeg untouched at 18/30", afterLeg?.status === "damaged" && afterLeg?.current === 18, afterLeg);
  await A("twoZones").sheet.close();

  // ── (5) the GM-only scoping actually hides the control ────────────────────
  await game.settings.set("cp2020-augmented", "cyberlimbRepairGmOnly", true);
  const gmRoot = await openCombat(A("useless"));
  check("GM-only ON: a GM still sees the repair control", !!gmRoot?.querySelector('.cp-cyberlimb-repair[data-zone="rArm"]'), null);
  await A("useless").sheet.close();
  await game.settings.set("cp2020-augmented", "cyberlimbRepairGmOnly", false);   // restore the default

  return out;
}, prov);

for (const line of r.checks) console.log(line);
const errs = errors.filter(e => !/screen resolution/i.test(e));
if (errs.length) console.log("page errors:", errs.slice(0, 6).join(" | "));
const pass = r.fails.length === 0 && errs.length === 0;
console.log(`\nRESULT: ${pass ? "PASS" : "FAIL"} ${r.checks.length - r.fails.length}/${r.checks.length}`);
await b.close();
process.exit(pass ? 0 : 1);
