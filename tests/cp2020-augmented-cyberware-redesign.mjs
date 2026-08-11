/** LIVE verification on :30004 (vanilla Tilt 1.1.1 + module) of the cyberware diegetic redesign:
 *  the anatomy body map telescopes (host implants nest their options in-zone), one uninstall model
 *  (⏏ / drag-off → Carried Options, cascading), the borg chassis ⊗ clears the whole loadout, and
 *  nothing double-lists. Drives the REAL DOM GESTURES (drop onto a host row, click ⏏, drag off the
 *  body, click ⊗ + confirm) — not the functions behind them — per the gesture-verification lesson.
 *  Each lane is guarded so one failure still reports the rest. Assertion text names the mechanism. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = { err: {} };
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const guard = async (name, fn) => { try { await fn(); } catch (e) { out.err[name] = String(e?.stack || e?.message || e); } };
  const packBy = (name) => game.packs.get(`cp2020-augmented.${name}`) || [...game.packs].find(pk => pk.metadata?.name === name);
  const cyber = packBy("supplement-cyberware");
  out.packs = { cyber: !!cyber };

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Redesign"))) await a.delete().catch(() => {});

  // ════ NORMAL CHARACTER: telescoping + one-uninstall + drag-off ════════════════════════════════════
  const actor = await Actor.create({ name: "__PW__RedesignNormal", type: "character" });
  // A cybereye HOST (Implant, CyberOptic, 3 option slots) in Head; a valid optic MODULE carried (IsModule,
  // AllowedParentCyberwareType=CyberOptic — mirrors the real compendium data); a standalone arm.
  const [eye] = await actor.createEmbeddedDocuments("Item", [{
    name: "__pw_eye", type: "cyberware",
    system: { equipped: true, cyberwareType: "CyberOptic", MountZone: "Head", CyberBodyType: { Type: "Head" }, CyberWorkType: { Types: ["Implant"], OptionsAvailable: 3 } }
  }]);
  const [scope] = await actor.createEmbeddedDocuments("Item", [{
    name: "__pw_scope", type: "cyberware",
    system: { equipped: false, cyberwareType: "CyberOptic", MountZone: "Head", CyberBodyType: { Type: "Head" }, Module: { IsModule: true, SlotsTaken: 1, AllowedParentCyberwareType: "CyberOptic" } }
  }]);
  const [arm] = await actor.createEmbeddedDocuments("Item", [{
    name: "__pw_arm", type: "cyberware",
    system: { equipped: true, MountZone: "Arm", CyberBodyType: { Type: "Arm", Location: "Left" } }
  }]);

  await actor.sheet.render(true); await sleep(900);
  let root = actor.sheet.element;
  const drop = async (targetEl, item) => { await actor.sheet._onDropItem({ preventDefault() {}, target: targetEl }, { type: "Item", uuid: item.uuid }); await sleep(350); };
  const reget = (id) => actor.items.get(id);

  // ── Gesture A: drop the scope onto the cybereye HOST ROW → nests it (Q6 link) in the head zone ────
  await guard("nest", async () => {
    out.nest_eyeId = eye.id;
    const hostEl = root.querySelector(`[data-drop-target="host:${eye.id}"]`);
    out.nest_hostElFound = !!hostEl;
    await drop(hostEl, scope);
    out.nest_scopeEquipped = reget(scope.id)?.system?.equipped === true;
    out.nest_scopeParent = reget(scope.id)?.system?.Module?.ParentId;    // expect eye.id
    root = actor.sheet.element;
    out.nest_scopeNestedUnderEye = !!root.querySelector(`.cp-zone-children .cp-zone-node[data-item-id="${scope.id}"]`);
    out.nest_scopeRowCount = root.querySelectorAll(`.cp-zone-node[data-item-id="${scope.id}"]`).length; // exactly 1
    out.nest_scopeNotInCarried = !root.querySelector(`.carried-options .cp-carried[data-item-id="${scope.id}"]`);
    out.nest_eyeIsHost = !!root.querySelector(`.cp-zone-host[data-item-id="${eye.id}"]`);
  });

  // ── Restriction: dropping a HOST (an optic mount — a container, NOT a module) onto the eye must NOT
  //     nest (the reverse-nesting the user reported). It falls back to standalone in the zone instead. ──
  await guard("reject-reverse-nest", async () => {
    root = actor.sheet.element;
    const [mount] = await actor.createEmbeddedDocuments("Item", [{
      name: "__pw_mount", type: "cyberware",
      system: { equipped: false, cyberwareType: "CyberOptic", MountZone: "Head", CyberBodyType: { Type: "Head" }, CyberWorkType: { Types: ["Implant"], OptionsAvailable: 2 } }
    }]);
    const hostEl = root.querySelector(`[data-drop-target="host:${eye.id}"]`);
    await drop(hostEl, mount);
    out.reject_mountNotNested = reget(mount.id)?.system?.Module?.ParentId !== eye.id;   // not a child of the eye
    out.reject_mountEquipped = reget(mount.id)?.system?.equipped === true;              // installed standalone instead
    root = actor.sheet.element;
    out.reject_mountNotUnderEye = !root.querySelector(`.cp-zone-node[data-item-id="${eye.id}"] ~ .cp-zone-children .cp-zone-node[data-item-id="${mount.id}"]`);
    await reget(mount.id)?.delete?.().catch(() => {});
  });

  // ── Gesture B: click the ⏏ on the cybereye row → uninstall cascades (eye + nested scope → carried) ─
  await guard("uninstall-cascade", async () => {
    root = actor.sheet.element;
    const eyeUnequip = root.querySelector(`.cp-zone-node[data-item-id="${eye.id}"] .item-unequip`);
    out.uninstall_ctrlFound = !!eyeUnequip;
    eyeUnequip.click();                                   // real gesture (mousedown-swallow + _onActiveUnequip)
    await sleep(500);
    out.uninstall_eyeCarried = reget(eye.id)?.system?.equipped === false;
    out.uninstall_scopeCarried = reget(scope.id)?.system?.equipped === false;      // cascaded
    out.uninstall_scopeParentCleared = !(reget(scope.id)?.system?.Module?.ParentId);
    root = actor.sheet.element;
    out.uninstall_bothInCarried =
      !!root.querySelector(`.carried-options .cp-carried[data-item-id="${eye.id}"]`) &&
      !!root.querySelector(`.carried-options .cp-carried[data-item-id="${scope.id}"]`);
    out.uninstall_eyeGoneFromMap = !root.querySelector(`.cp-zone-node[data-item-id="${eye.id}"]`);
  });

  // ── Gesture C: drag the standalone arm OFF the body (drop on the anatomy image, no drop target) ───
  await guard("drag-off", async () => {
    root = actor.sheet.element;
    out.dragoff_armEquippedBefore = reget(arm.id)?.system?.equipped === true;
    const offTarget = root.querySelector("#anatomy-img") || root.querySelector(".anatomy-container");
    out.dragoff_targetHasNoDropZone = !!offTarget && !offTarget.closest("[data-drop-target]");
    await drop(offTarget, arm);
    out.dragoff_armCarried = reget(arm.id)?.system?.equipped === false;
    root = actor.sheet.element;
    out.dragoff_armInCarried = !!root.querySelector(`.carried-options .cp-carried[data-item-id="${arm.id}"]`);
  });

  await actor.sheet.close().catch(() => {});
  await actor.delete().catch(() => {});

  // ════ FULL BORG: chassis strip + ⊗ clears the WHOLE loadout (count == acted), via the dialog ═══════
  await guard("borg-chassis", async () => {
    const cidx = await cyber.getIndex();
    const dragoon = await cyber.getDocument(cidx.find(e => e.name === "Dragoon")._id);
    const borg = await Actor.create({ name: "__PW__RedesignBorg", type: "character" });
    const [body] = await borg.createEmbeddedDocuments("Item", [dragoon.toObject()]);
    await body.update({ "system.equipped": true });
    const borgManifestLen = (body.getFlag("cp2020-augmented", "loadout") ?? []).length;
    const opts = () => borg.items.filter(i => i.getFlag("cp2020-augmented", "loadoutSource") === body.id);
    // Materialization is multi-pass (parents, then nested children level-by-level): wait until the
    // count STABILIZES, not just crosses a threshold, or the baseline samples a partial (pre-nesting)
    // set and the subsequent ⊗/delete acts on a still-growing option list.
    { let last = -1, stable = 0; for (let i = 0; i < 80 && stable < 3; i++) { await sleep(200); const n = opts().length; if (n > 0 && n === last) stable++; else { stable = 0; last = n; } } }
    out.borg_materialized = opts().length;
    out.borg_manifestLen = borgManifestLen;

    await borg.sheet.render(true); await sleep(900);
    let broot = borg.sheet.element;
    // chassis folded into the Active Cyberware header (name + ⊗); options render as roots in their zones
    const chassisInline = broot.querySelector(".cp-active-cyber-header .cp-chassis-inline");
    out.borg_chassisPresent = !!chassisInline && /Dragoon/.test(chassisInline.textContent || "");
    out.borg_chassisNoNumber = !broot.querySelector(".cp-chassis-count");   // number removed
    const groupRemove = broot.querySelector(".cp-chassis-inline .cp-group-remove");
    out.borg_clearCtrlFound = !!groupRemove;
    out.borg_optionsRenderInZones = broot.querySelectorAll(".active-cyberware .cp-zone-node").length;

    const equippedBefore = opts().filter(i => i.system?.equipped === true).length;
    out.borg_equippedBefore = equippedBefore;
    groupRemove.click();                                  // real gesture → opens the confirm dialog
    let yes = null;
    for (let i = 0; i < 40 && !yes; i++) { await sleep(100); yes = document.querySelector('button[data-action="yes"], .dialog-buttons button.yes, dialog .form-footer button:first-child'); }
    out.borg_dialogAppeared = !!yes;
    yes?.click();
    await sleep(700);
    const after = opts();
    out.borg_allCarried = after.length > 0 && after.every(i => i.system?.equipped !== true); // ALL cleared
    out.borg_noneDeleted = after.length === out.borg_materialized;                            // kept, not deleted
    broot = borg.sheet.element;
    out.borg_carriedShown = broot.querySelectorAll(".carried-options .cp-carried").length;
    await borg.sheet.close().catch(() => {});
    await borg.delete().catch(() => {});
  });

  // ════ CHASSIS DELETE: the 🗑 prompts what to do with attached options (keep vs delete) ═════════════
  await guard("borg-chassis-delete", async () => {
    const cidx = await cyber.getIndex();
    const dragoon = await cyber.getDocument(cidx.find(e => e.name === "Dragoon")._id);
    const mkBorg = async (name) => {
      const bg = await Actor.create({ name, type: "character" });
      const [bd] = await bg.createEmbeddedDocuments("Item", [dragoon.toObject()]);
      await bd.update({ "system.equipped": true });
      const os = () => bg.items.filter(i => i.getFlag("cp2020-augmented", "loadoutSource") === bd.id);
      // Wait for multi-pass materialization (parents + nested children) to STABILIZE before sampling
      // the baseline, or the chassis-delete handler's `attached` set misses still-materializing options.
      { let last = -1, stable = 0; for (let i = 0; i < 80 && stable < 3; i++) { await sleep(200); const n = os().length; if (n > 0 && n === last) stable++; else { stable = 0; last = n; } } }
      return { bg, bd, os };
    };
    const clickDelete = async (bg, action) => {
      await bg.sheet.render(true); await sleep(700);
      const del = bg.sheet.element.querySelector(".cp-chassis-inline .cp-chassis-delete");
      if (!del) return { found: false, dialog: false };
      del.click();                                        // real gesture → opens the choice dialog
      let btn = null;
      for (let i = 0; i < 40 && !btn; i++) { await sleep(100); btn = document.querySelector(`button[data-action="${action}"]`); }
      btn?.click();
      await sleep(700);
      return { found: true, dialog: !!btn };
    };

    // (a) KEEP choice: body deleted, attached options SURVIVE as carried (none deleted)
    const A = await mkBorg("__PW__RedesignBorgDelKeep");
    const beforeKeep = A.os().length;
    const rk = await clickDelete(A.bg, "unequip");
    out.del_deleteCtrlFound = rk.found;
    out.del_keepDialog = rk.dialog;
    out.del_keepBodyGone = !A.bg.items.get(A.bd.id);
    out.del_keepOptionsSurvive = beforeKeep > 0 && A.os().length === beforeKeep;
    out.del_keepOptionsCarried = A.os().length > 0 && A.os().every(i => i.system?.equipped !== true);
    await A.bg.sheet.close().catch(() => {});
    await A.bg.delete().catch(() => {});

    // (b) DELETE choice: body deleted AND its attached options deleted with it
    const B = await mkBorg("__PW__RedesignBorgDelAll");
    const beforeDel = B.os().length;
    const rd = await clickDelete(B.bg, "delete");
    out.del_delDialog = rd.dialog;
    out.del_delBodyGone = !B.bg.items.get(B.bd.id);
    out.del_delOptionsGone = beforeDel > 0 && B.os().length === 0;
    await B.bg.sheet.close().catch(() => {});
    await B.bg.delete().catch(() => {});
  });

  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["compendium cyberware pack loads", r.packs?.cyber === true],
  // Gesture A — telescoping nest
  ["nest: the cybereye renders as a host drop target row", r.nest_hostElFound === true && r.nest_eyeIsHost === true],
  ["nest: dropping a scope on the host nests it (equipped + ParentId=eye)", r.nest_scopeEquipped === true && r.nest_scopeParent === r.nest_eyeId],
  ["nest: the scope renders nested under the eye in-zone", r.nest_scopeNestedUnderEye === true],
  ["nest: the scope is listed exactly once and NOT also in Carried", r.nest_scopeRowCount === 1 && r.nest_scopeNotInCarried === true],
  ["restrict: a host (optic mount) dropped on the eye is NOT nested (reverse-nesting blocked); lands standalone", r.reject_mountNotNested === true && r.reject_mountEquipped === true && r.reject_mountNotUnderEye === true],
  // Gesture B — one uninstall, cascading
  ["uninstall: the ⏏ control renders on the body-map row", r.uninstall_ctrlFound === true],
  ["uninstall: clicking ⏏ uninstalls the host AND its nested option (cascade)", r.uninstall_eyeCarried === true && r.uninstall_scopeCarried === true],
  ["uninstall: the nested option's host link is cleared", r.uninstall_scopeParentCleared === true],
  ["uninstall: both land in Carried Options and leave the body map", r.uninstall_bothInCarried === true && r.uninstall_eyeGoneFromMap === true],
  // Gesture C — drag off the body
  ["drag-off: the drop target is genuinely outside any drop zone", r.dragoff_targetHasNoDropZone === true],
  ["drag-off: dragging an equipped implant off the map uninstalls it to Carried", r.dragoff_armCarried === true && r.dragoff_armInCarried === true],
  // Gesture D — borg chassis ⊗
  ["borg: the loadout materialized (exactly the manifest spec count)", r.borg_materialized === r.borg_manifestLen && (r.borg_manifestLen || 0) > 0],
  ["borg: the chassis folds into the Active Cyberware header (name + ⊗), no number", r.borg_chassisPresent === true && r.borg_clearCtrlFound === true && r.borg_chassisNoNumber === true],
  ["borg: loadout options render as nodes in their anatomy zones", (r.borg_optionsRenderInZones || 0) > 0],
  ["borg: clicking ⊗ opens a confirm dialog", r.borg_dialogAppeared === true],
  ["borg: confirming ⊗ uninstalls ALL loadout options (count == acted)", r.borg_allCarried === true],
  ["borg: none of the options are deleted (kept in Carried)", r.borg_noneDeleted === true && (r.borg_carriedShown || 0) > 0],
  // Chassis delete prompt
  ["chassis delete: the 🗑 control renders on the chassis strip", r.del_deleteCtrlFound === true],
  ["chassis delete (keep): prompt opens, chassis removed, attached options SURVIVE as carried", r.del_keepDialog === true && r.del_keepBodyGone === true && r.del_keepOptionsSurvive === true && r.del_keepOptionsCarried === true],
  ["chassis delete (delete): chassis removed AND its attached options deleted with it", r.del_delDialog === true && r.del_delBodyGone === true && r.del_delOptionsGone === true],
  ["0 console errors", errors.length === 0],
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (Object.keys(r.err || {}).length) console.log("lane errors:", r.err);
if (errors.length) console.log("console/page errors:", errors.slice(0, 8));
await b.close();
process.exit(fail ? 1 : 0);
