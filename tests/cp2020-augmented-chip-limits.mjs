/** Chip limits (Core p.82-83): the chipware socket as a Q6 container ("Holds 10 chips" — the
 *  corrections give the base socket OptionsAvailable 10 + AcceptsTypes ["Chip"], and checkInstall
 *  admits chips by TYPE since they carry no Module block), plus the running cap (active chip
 *  programs ≤ INT) enforced as a refuse-with-override gate at the ChipActive update. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = {};
  const C = await import("/modules/cp2020-augmented/module/mech/container.js");
  const G = await import("/modules/cp2020-augmented/module/mech/chip-grant.js");

  // ── (0) PURE: the chip type-gate in checkInstall ─────────────────────────
  const socketShape = (over = {}) => ({ id: "sock", type: "cyberware", name: "sock",
    system: { CyberWorkType: { Type: "Descriptive", OptionsAvailable: 10, AcceptsTypes: ["Chip"] }, Module: { ParentId: "" }, ...over } });
  const chipShape = (id, parent = "") => ({ id, type: "cyberware", name: "chip" + id,
    system: { CyberWorkType: { Type: "Chip" }, Module: { ParentId: parent } } });
  const sock = socketShape();
  const plainImplant = { id: "imp", type: "cyberware", name: "imp",
    system: { CyberWorkType: { Types: ["Implant"], OptionsAvailable: 3 }, Module: { ParentId: "" } } };
  const opticModule = { id: "om", type: "cyberware", name: "om",
    system: { CyberWorkType: {}, Module: { ParentId: "", IsModule: true, SlotsTaken: 1, AllowedParentCyberwareType: "CyberOptic" } } };

  out.pure = {
    chipIntoSocket: C.checkInstall(chipShape("c1"), sock, [sock]).ok,
    chipIntoPlainImplant: C.checkInstall(chipShape("c2"), plainImplant, [plainImplant]).reason,   // not-module
    opticModuleIntoSocket: C.checkInstall(opticModule, sock, [sock]).reason,   // not-implant: only the chip type-gate admits into a Descriptive host
  };
  const tenIn = Array.from({ length: 10 }, (_, i) => chipShape("f" + i, "sock"));
  out.pure.eleventhChip = C.checkInstall(chipShape("c3"), sock, [sock, ...tenIn]).reason;          // full
  out.pure.tenthChip = C.checkInstall(chipShape("c4"), sock, [sock, ...tenIn.slice(0, 9)]).ok;

  // ── (1) LIVE: corrections fire on the REAL pack socket ───────────────────
  const pack = game.packs.get("cyberpunk2020.neuralware");
  const docs = await pack.getDocuments();
  const packSocket = docs.find(d => d.id === "vfctuWRZxDfVxzV1");
  const packPlugs = docs.find(d => d.id === "x3bHNmrZaN3ZVssf");
  // Pre-sweep any prior run's fixture (non-__PW__ name → not caught by the shared sweeps).
  for (const a of game.actors.filter(a => a.name?.startsWith("PROBE chip-limit"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "PROBE chip-limit holder", type: "character" });
  const created = [];
  try {
    const fromPack = (d) => ({ ...d.toObject(), _stats: { compendiumSource: d.uuid } });
    const [socketItem] = await actor.createEmbeddedDocuments("Item", [fromPack(packSocket)]);
    const [plugsItem] = await actor.createEmbeddedDocuments("Item", [fromPack(packPlugs)]);
    created.push(socketItem.id, plugsItem.id);
    out.corrections = {
      socketCapacity: Number(socketItem.system?.CyberWorkType?.OptionsAvailable),
      socketAccepts: socketItem.system?.CyberWorkType?.AcceptsTypes ?? null,
      socketNote: String(socketItem.system?.notes ?? "").includes("Holds 10 chips") ||
                  String(socketItem.system?.notes ?? "").includes("holds 10 chips"),
      plugsNote: String(plugsItem.system?.notes ?? "").includes("prints no count"),
      plugsStillLoose: Number(plugsItem.system?.CyberWorkType?.OptionsAvailable) === 0,
    };

    // ── (2) LIVE: slot a chip into the socket through the engine path ──────
    await socketItem.update({ "system.equipped": true }, { render: false });
    const mkChip = (n) => ({ name: "PROBE slot chip " + n, type: "cyberware",
      system: { CyberWorkType: { Type: "Chip" } } });
    const chips = await actor.createEmbeddedDocuments("Item", Array.from({ length: 12 }, (_, i) => mkChip(i)));
    created.push(...chips.map(c => c.id));
    const items = () => actor.items.contents;
    const gate = C.checkInstall(chips[0], socketItem, items());
    out.live = { firstChipGate: gate.ok };
    await chips[0].update({ "system.Module.ParentId": socketItem.id }, { render: false });
    out.live.slotted = C.childrenOf(items(), socketItem.id).length === 1;
    out.live.usedSlots = C.usedSlots(items(), socketItem.id);

    // ── (3) LIVE: the INT running cap — refuse, then override ──────────────
    const cap = Number(actor.system?.stats?.int?.total) || 0;
    out.cap = { int: cap };
    // Activate exactly `cap` chips (allowed), then one more (refused), then override it through.
    for (let i = 0; i < cap && i < chips.length - 1; i++) {
      await chips[i].update({ "system.equipped": true, "system.CyberWorkType.ChipActive": true }, { render: false });
    }
    out.cap.runningAtCap = G.activeChipCount(actor);
    const extra = chips[Math.min(cap, chips.length - 1)];
    await extra.update({ "system.equipped": true }, { render: false });
    await extra.update({ "system.CyberWorkType.ChipActive": true }, { render: false });
    out.cap.refused = extra.system?.CyberWorkType?.ChipActive !== true;
    out.cap.runningAfterRefusal = G.activeChipCount(actor);
    await extra.update({ "system.CyberWorkType.ChipActive": true }, { render: false, cp2020ChipCapOverride: true });
    out.cap.overrideWorked = extra.system?.CyberWorkType?.ChipActive === true;
    out.cap.runningAfterOverride = G.activeChipCount(actor);
    // Deactivation is never gated.
    await extra.update({ "system.CyberWorkType.ChipActive": false }, { render: false });
    out.cap.deactivateFree = extra.system?.CyberWorkType?.ChipActive === false;
    // Close the override confirm the refused attempt opened (it resolves false on close).
    // instances is a Map — iterate its values (Object.values(Map) yields [], leaving the dialog open).
    for (const app of [...(foundry.applications.instances?.values?.() ?? [])]) {
      if (app?.constructor?.name === "DialogV2") await app.close().catch(() => {});
    }
  } finally {
    await actor.delete().catch(() => {});
  }
  return out;
});

const checks = {
  pureChipIntoSocket: r.pure?.chipIntoSocket === true,
  pureChipIntoPlainImplant: r.pure?.chipIntoPlainImplant === "not-module",
  pureOpticModuleIntoSocket: r.pure?.opticModuleIntoSocket === "not-implant",
  pureTenth: r.pure?.tenthChip === true,
  pureEleventh: r.pure?.eleventhChip === "full",
  socketCapacity10: r.corrections?.socketCapacity === 10,
  socketAcceptsChip: Array.isArray(r.corrections?.socketAccepts) && r.corrections.socketAccepts.includes("Chip"),
  socketNote: r.corrections?.socketNote === true,
  plugsNoteOnly: r.corrections?.plugsNote === true && r.corrections?.plugsStillLoose === true,
  liveGateAndSlot: r.live?.firstChipGate === true && r.live?.slotted === true && r.live?.usedSlots === 1,
  capPositive: (r.cap?.int ?? 0) > 0,
  capReached: r.cap?.runningAtCap === r.cap?.int,
  capRefused: r.cap?.refused === true && r.cap?.runningAfterRefusal === r.cap?.int,
  capOverride: r.cap?.overrideWorked === true && r.cap?.runningAfterOverride === r.cap?.int + 1,
  deactivateFree: r.cap?.deactivateFree === true,
  noConsoleErrors: errors.length === 0,
};
console.log(JSON.stringify({ r, checks, errors }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? "CHIP-LIMITS KEEPER PASS" : "CHIP-LIMITS KEEPER FAIL");
await b.close();
process.exit(pass ? 0 : 1);
