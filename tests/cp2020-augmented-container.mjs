/** Q6 containers (SPECIAL-MECHANICS-PROPOSAL.md, option 1): the unifying accessors (cyberware base
 *  fields vs misc mechContainer), capacity/cycle guards, the tree, and on a real actor the cyberware
 *  + misc + cross-type install lifecycle, the uninstall-cascade on container delete, and the
 *  telescoping actor-sheet render. */
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
  const C = await import("/modules/cp2020-augmented/module/mech/container.js");
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  // ── (0) PURE accessors + tree ─────────────────────────────────────────────
  const cyber = (id, over = {}) => ({ id, type: "cyberware", name: "cw" + id,
    system: { Module: { ParentId: "", SlotsTaken: 1 }, CyberWorkType: { OptionsAvailable: 0 }, ...over } });
  const misc = (id, over = {}) => ({ id, type: "misc", name: "m" + id,
    system: { mechContainer: { installedIn: "", capacity: 0, slotsTaken: 1 }, ...over } });

  const cyEye = cyber("eye", { cyberwareType: "CyberOptic", CyberWorkType: { OptionsAvailable: 3, Types: ["Implant"] } });
  const cyOpt = cyber("opt", { Module: { ParentId: "eye", SlotsTaken: 2, IsModule: true, AllowedParentCyberwareType: "CyberOptic" } });
  const pouch = misc("pouch", { mechContainer: { installedIn: "", capacity: 2, slotsTaken: 1 } });
  const stored = misc("stored", { mechContainer: { installedIn: "pouch", capacity: 0, slotsTaken: 1 } });
  const list = [cyEye, cyOpt, pouch, stored];

  out.accessors = {
    cyberParent: C.installedInOf(cyOpt),            // Module.ParentId
    miscParent: C.installedInOf(stored),            // mechContainer.installedIn
    cyberCap: C.capacityOf(cyEye),                  // OptionsAvailable
    miscCap: C.capacityOf(pouch),                   // mechContainer.capacity
    cyberSlots: C.slotsTakenOf(cyOpt),              // Module.SlotsTaken
    miscSlots: C.slotsTakenOf(stored),              // mechContainer.slotsTaken (default 1)
    // FIX: a whole-chassis stat upgrade (borgStatDelta flag) occupies 0 zone slots — the "Increased …"
    // full-borg options ARE the body, not a zone occupant, so the zone badge/gate never over-counts.
    statDeltaSlots: C.slotsTakenOf({ type: "cyberware", system: { Module: { SlotsTaken: 3 } }, flags: { "cp2020-augmented": { borgStatDelta: { ref: 1 } } } }),
    eyeIsContainer: C.isContainer(cyEye),
    optIsContainer: C.isContainer(cyOpt)
  };
  out.slots = {
    eyeChildren: C.childrenOf(list, "eye").length,
    eyeUsed: C.usedSlots(list, "eye"),              // opt takes 2
    eyeFree: C.freeSlots(cyEye, list),              // 3 - 2 = 1
    pouchUsed: C.usedSlots(list, "pouch")           // stored takes 1
  };
  out.guards = {
    selfInstall: C.canInstall(cyEye, cyEye, list),
    intoNonContainer: C.canInstall(cyEye, cyOpt, list),      // opt has capacity 0
    overCapacity: C.canInstall(cyber("big", { Module: { SlotsTaken: 5, IsModule: true, AllowedParentCyberwareType: "CyberOptic" } }), cyEye, list),  // valid optic module, needs 5, has 1 → full
    fits: C.canInstall(misc("small"), cyEye, list),          // misc child: capacity only, needs 1, has 1
    cycle: C.wouldCycle(cyEye, cyOpt, list),                 // opt is under eye → installing eye into opt cycles
    // base AllowedParentCyberwareType model:
    notModule: C.canInstall(cyber("base", { CyberWorkType: { OptionsAvailable: 0, Types: ["Implant"] } }), cyEye, list),  // not IsModule (a host, e.g. an optic mount) → rejected
    wrongType: C.canInstall(cyber("armopt", { Module: { SlotsTaken: 1, IsModule: true, AllowedParentCyberwareType: "CyberArm" } }), cyEye, list),  // wants a CyberArm host, eye is CyberOptic → rejected
    reasonWrongType: C.checkInstall(cyber("armopt2", { Module: { SlotsTaken: 1, IsModule: true, AllowedParentCyberwareType: "CyberArm" } }), cyEye, list).reason
  };

  // mixed-family mount: CyberWorkType.AcceptsTypes replaces the host's own family in the match,
  // and its contents follow the mount's placement (the anatomy zone match is skipped for it).
  const boom = cyber("boom", { cyberwareType: "", MountZone: "Torso", CyberBodyType: { Type: "Torso" },
    CyberWorkType: { OptionsAvailable: 3, Types: ["Implant"], AcceptsTypes: ["CyberOptic", "CyberAudio"] } });
  const audMod = cyber("aud", { cyberwareType: "CyberAudio", MountZone: "Head", CyberBodyType: { Type: "Head" },
    Module: { SlotsTaken: 1, IsModule: true, AllowedParentCyberwareType: "CyberAudio" } });
  const optMod = cyber("optm", { cyberwareType: "CyberOptic", MountZone: "Head", CyberBodyType: { Type: "Head" },
    Module: { SlotsTaken: 1, IsModule: true, AllowedParentCyberwareType: "CyberOptic" } });
  const legMod = cyber("legm", { Module: { SlotsTaken: 1, IsModule: true, AllowedParentCyberwareType: "CyberLeg" } });
  const boomList = [boom, audMod, optMod, legMod, cyEye];
  out.acceptsTypes = {
    audioIntoBoom: C.checkInstall(audMod, boom, boomList).ok,      // listed family → allowed
    opticIntoBoom: C.checkInstall(optMod, boom, boomList).ok,      // listed family; Head child into a Torso mount → zone match skipped
    legIntoBoom: C.checkInstall(legMod, boom, boomList).reason,    // family not listed → "wrong-type"
    audioIntoEye: C.checkInstall(audMod, cyEye, boomList).reason   // truthful typing: an audio module still refuses a cybereye → "wrong-type"
  };
  const tree = C.buildContainerTree(list, (it) => it.type === "cyberware");
  out.tree = {
    roots: tree.length,                             // only cyEye is a loose cyberware root
    rootId: tree[0]?.item?.id,
    rootCap: tree[0]?.capacity,
    rootUsed: tree[0]?.used,
    childCount: tree[0]?.children?.length,          // cyOpt nested
    childInstalled: tree[0]?.children?.[0]?.installed
  };
  out.descendants = C.descendantIds(list, "eye");

  // ── (1) Real actor lifecycle ──────────────────────────────────────────────
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__Cont"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "__PW__ContPunk", type: "character" });
  const mk = async (d) => (await actor.createEmbeddedDocuments("Item", [d]))[0];
  const eye = await mk({ name: "__PW__Cybereye", type: "cyberware",
    system: { equipped: true, CyberWorkType: { Types: ["Implant"], OptionsAvailable: 3, Stat: {}, Skill: {}, ChipSkills: {} }, Module: { IsModule: false, ParentId: "", SlotsTaken: 1 } } });
  const opt = await mk({ name: "__PW__LowLite", type: "cyberware",
    system: { equipped: true, CyberWorkType: { Types: [], Stat: {}, Skill: {}, ChipSkills: {} }, Module: { IsModule: true, ParentId: "", SlotsTaken: 1 } } });
  const arm = await mk({ name: "__PW__Cyberarm", type: "cyberware",
    system: { equipped: true, CyberWorkType: { Types: ["Implant"], OptionsAvailable: 2, Stat: {}, Skill: {}, ChipSkills: {} }, Module: { IsModule: false, ParentId: "", SlotsTaken: 1 } } });
  const holdout = await mk({ name: "__PW__Holdout", type: "misc", system: { equipped: false, mechContainer: { installedIn: "", capacity: 0, slotsTaken: 1 } } });
  const pouchItem = await mk({ name: "__PW__Pouch", type: "misc", system: { equipped: true, mechContainer: { installedIn: "", capacity: 2, slotsTaken: 1 } } });
  const trinket = await mk({ name: "__PW__Trinket", type: "misc", system: { equipped: false, mechContainer: { installedIn: "", capacity: 0, slotsTaken: 1 } } });

  const items = () => actor.items.contents;
  // cyberware option → cybereye (base Module.ParentId path)
  await C.installItem(opt, eye, items());
  // misc holdout → cyberarm compartment (cross-type)
  await C.installItem(holdout, arm, items());
  // misc trinket → misc pouch
  await C.installItem(trinket, pouchItem, items());
  await sleep(400);
  out.installed = {
    optIn: actor.items.get(opt.id).system.Module.ParentId === eye.id,
    holdoutIn: actor.items.get(holdout.id).system.mechContainer.installedIn === arm.id,
    trinketIn: actor.items.get(trinket.id).system.mechContainer.installedIn === pouchItem.id,
    eyeUsed: C.usedSlots(items(), eye.id),
    armUsed: C.usedSlots(items(), arm.id)
  };

  // type restriction e2e: a wrong-allowed-type cyberware module won't install into the eye (stays loose)
  const armOpt = await mk({ name: "__PW__ArmOptReject", type: "cyberware",
    system: { equipped: true, Module: { IsModule: true, ParentId: "", SlotsTaken: 1, AllowedParentCyberwareType: "CyberArm" } } });
  const armOptOk = await C.installItem(armOpt, actor.items.get(eye.id), items());
  out.typeReject = armOptOk === false && actor.items.get(armOpt.id).system.Module.ParentId === "";
  await armOpt.delete().catch(() => {});

  // capacity guard on a real over-fill: a 2nd option into the single-free-slot arm should fail
  const opt2 = await mk({ name: "__PW__ExtraOpt", type: "cyberware",
    system: { equipped: true, CyberWorkType: { Types: [] }, Module: { IsModule: true, ParentId: "", SlotsTaken: 3 } } });
  const overfill = await C.installItem(opt2, arm, items());   // arm free = 2 - 1(holdout) = 1, needs 3
  out.overfillRejected = overfill === false && actor.items.get(opt2.id).system.Module.ParentId === "";
  await opt2.delete().catch(() => {});

  // uninstall the holdout → back to loose
  await C.uninstallItem(actor.items.get(holdout.id)); await sleep(300);
  out.uninstalled = { holdoutLoose: actor.items.get(holdout.id).system.mechContainer.installedIn === "" };

  // uninstall CASCADE: delete the pouch (container) → trinket detached, not deleted
  await actor.items.get(pouchItem.id).delete(); await sleep(800);
  const trinketAfter = actor.items.get(trinket.id);
  out.cascade = {
    trinketSurvives: !!trinketAfter,
    trinketDetached: trinketAfter?.system?.mechContainer?.installedIn === ""
  };

  // ── (2) Sheet render: container-node.hbs telescoping in the GEAR tab (its remaining home — the cyber
  //        tab now telescopes INSIDE the anatomy body map, covered by cp2020-augmented-cyberware-redesign.mjs).
  //        A misc bag with a nested widget exercises the same partial + the ⏏ uninstall control. ────
  const bag = await mk({ name: "__PW__Bag", type: "misc", system: { equipped: true, mechContainer: { installedIn: "", capacity: 2, slotsTaken: 1 } } });
  const widget = await mk({ name: "__PW__Widget", type: "misc", system: { equipped: false, mechContainer: { installedIn: "", capacity: 0, slotsTaken: 1 } } });
  await C.installItem(widget, bag, items()); await sleep(300);
  await actor.sheet.render(true); await sleep(900);
  const root = actor.sheet.element;
  const bagNode = root?.querySelector(`.cp-container-node [data-item-id="${bag.id}"]`)?.closest(".cp-container-node");
  out.render = {
    eyeNodePresent: !!bagNode,
    optNested: !!bagNode?.querySelector(`.cp-container-children [data-item-id="${widget.id}"]`),
    capacityBadge: !!bagNode?.querySelector(".cp-capacity-badge"),
    uninstallControl: !!bagNode?.querySelector(`.cp-container-children [data-item-id="${widget.id}"] .cp-container-uninstall`),
    deleteX: !!bagNode?.querySelector(".item-delete")
  };

  // Clicking the nested item's ⏏ detaches it WITHOUT opening its item sheet (the item-edit row
  // handler must yield to the uninstall control).
  const openBefore = foundry.applications.instances.size;
  bagNode?.querySelector(`.cp-container-children [data-item-id="${widget.id}"] .cp-container-uninstall`)?.click();
  await sleep(900);
  out.uninstallClick = {
    optDetached: actor.items.get(widget.id).system.mechContainer.installedIn === "",
    noSheetOpened: foundry.applications.instances.size <= openBefore
  };
  await actor.sheet.close().catch(() => {});
  await actor.delete().catch(() => {});
  return out;
});

console.log(JSON.stringify(r, null, 1));
const checks = [
  ["pure: parent link — cyberware Module.ParentId, misc mechContainer.installedIn", r.accessors.cyberParent === "eye" && r.accessors.miscParent === "pouch"],
  ["pure: capacity — cyberware OptionsAvailable, misc mechContainer.capacity", r.accessors.cyberCap === 3 && r.accessors.miscCap === 2],
  ["pure: slots taken — cyberware SlotsTaken, misc default 1", r.accessors.cyberSlots === 2 && r.accessors.miscSlots === 1],
  ["pure: a borgStatDelta stat-upgrade occupies 0 zone slots (slotsTakenOf)", r.accessors.statDeltaSlots === 0],
  ["pure: isContainer by capacity", r.accessors.eyeIsContainer === true && r.accessors.optIsContainer === false],
  ["pure: children + used/free slots", r.slots.eyeChildren === 1 && r.slots.eyeUsed === 2 && r.slots.eyeFree === 1 && r.slots.pouchUsed === 1],
  ["pure: guards — self/non-container/over-capacity rejected, fitting allowed", r.guards.selfInstall === false && r.guards.intoNonContainer === false && r.guards.overCapacity === false && r.guards.fits === true],
  ["pure: type rules — a non-module (host) and a wrong-allowed-type module are rejected", r.guards.notModule === false && r.guards.wrongType === false && r.guards.reasonWrongType === "wrong-type"],
  ["pure: mixed-family mount — AcceptsTypes admits both listed families (zone follows the mount), rejects an unlisted one, and children stay truthfully typed", r.acceptsTypes.audioIntoBoom === true && r.acceptsTypes.opticIntoBoom === true && r.acceptsTypes.legIntoBoom === "wrong-type" && r.acceptsTypes.audioIntoEye === "wrong-type"],
  ["pure: cycle detected", r.guards.cycle === true],
  ["pure: tree — one cyber root, nested installed child, capacity/used", r.tree.roots === 1 && r.tree.rootId === "eye" && r.tree.rootCap === 3 && r.tree.rootUsed === 2 && r.tree.childCount === 1 && r.tree.childInstalled === true],
  ["pure: descendantIds", r.descendants.length === 1 && r.descendants[0] === "opt"],
  ["e2e: cyberware option installs via Module.ParentId", r.installed.optIn === true && r.installed.eyeUsed === 1],
  ["e2e: misc installs into a cyberware compartment (cross-type)", r.installed.holdoutIn === true && r.installed.armUsed === 1],
  ["e2e: misc installs into a misc pouch", r.installed.trinketIn === true],
  ["e2e: over-capacity install rejected", r.overfillRejected === true],
  ["e2e: a wrong-allowed-type module is refused installation into the eye", r.typeReject === true],
  ["e2e: uninstall detaches to loose", r.uninstalled.holdoutLoose === true],
  ["e2e: deleting a container cascades — child detached, not deleted", r.cascade.trinketSurvives === true && r.cascade.trinketDetached === true],
  ["render: gear container node with nested item, capacity badge, uninstall + delete controls", r.render.eyeNodePresent === true && r.render.optNested === true && r.render.capacityBadge === true && r.render.uninstallControl === true && r.render.deleteX === true],
  ["render: clicking uninstall detaches without opening the item sheet", r.uninstallClick.optDetached === true && r.uninstallClick.noSheetOpened === true],
  ["0 console errors", errors.length === 0]
];
let fail = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; }
if (errors.length) console.log("errors:", errors.slice(0, 6));
await b.close();
process.exit(fail ? 1 : 0);
