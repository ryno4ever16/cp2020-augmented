/** Mono weapon category (CP2020 p.112) + player-visible armor hardness.
 *  - Multiplier truth: a MONO hit strips ⅓ SP vs soft / ⅔ SP vs hard; EDGED still does ½-soft/full-hard;
 *    a plain hit is unchanged. Driven through both resolveAreaDamagesSync and applyAreaDamages(dryRun).
 *  - Data-model: weapon `mono`/`edged`/`broken` and armor `armorType` persist through the DataModels.
 *  - armorType select surfaces getArmorHardness: "hard"/"soft" override, "" falls back to the heuristic.
 *  - Break-on-fumble: a mono weapon fired on a natural 1 is marked broken via the real weaponFired hook. */
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
  const A  = await import("/modules/cp2020-augmented/module/combat/DamageApplicator.js");
  const AL = await import("/modules/cp2020-augmented/module/combat/armor-layers.js");
  const S  = await import("/modules/cp2020-augmented/module/seam-shim.js");

  const cov = (sp) => Object.fromEntries(["Head","Torso","lArm","rArm","lLeg","rLeg"]
    .map(k => [k, { stoppingPower: String(k === "Torso" ? sp : 0), ablation: 0 }]));

  // ── (0) PURE: natural-1 detector drives break-on-fumble independent of the crit-table setting.
  //        Build a REAL evaluated 1d10 (its term is a Die instance) and force the first result. ──
  const realRoll = async (v) => {
    const rr = await new Roll("1d10").evaluate();
    const dt = rr.terms.find(t => t instanceof foundry.dice.terms.Die);
    dt.results[0].result = v; dt.results[0].discarded = false; dt.results[0].rerolled = false;
    return rr;
  };
  out.pure = {
    natOne:  S.rollIsNaturalOne(await realRoll(1)),   // true
    natFive: S.rollIsNaturalOne(await realRoll(5)),   // false
    noRoll:  S.rollIsNaturalOne(undefined),           // false (graceful)
  };

  for (const a of game.actors.filter(a => a.name?.startsWith("PROBE mono"))) await a.delete().catch(() => {});
  const actor = await Actor.create({ name: "PROBE mono target", type: "character" });
  const SP = 18;   // divisible cleanly: ⅓→6, ⅔→12, ½→9
  const hitTorso = { Torso: [{ damage: 100 }] };   // large → always penetrates, damageAfterSP = 100 - spFull

  try {
    // ── (1) SOFT armor: mono ⅓, edged ½, plain unchanged ──────────────────────
    await actor.createEmbeddedDocuments("Item", [
      { name: "PROBE soft vest", type: "armor",
        system: { equipped: true, armorType: "soft", coverage: cov(SP) } },
    ]);
    const softItem = actor.items.find(i => i.name === "PROBE soft vest");
    const base = { target: actor, areaDamages: hitTorso, armorMode: "full" };
    const sync = (o) => A.resolveAreaDamagesSync({ ...base, ...o })[0];
    out.soft = {
      hardness:  AL.getArmorHardness(softItem),                 // "soft" (explicit)
      plainSP:   sync({})?.spFull,                              // 18
      edgedSP:   sync({ edged: true })?.spFull,                 // 9
      monoSP:    sync({ mono: true })?.spFull,                  // 6
      monoAfter: sync({ mono: true })?.damageAfterSP,           // 100 - 6 = 94
      edgedAfter:sync({ edged: true })?.damageAfterSP,          // 100 - 9 = 91
      plainAfter:sync({})?.damageAfterSP,                       // 100 - 18 = 82
    };
    // async apply path (dryRun) must agree with the sync preview
    const asyncSoftMono = (await A.applyAreaDamages({ ...base, mono: true, dryRun: true }))[0];
    out.soft.asyncMonoSP = asyncSoftMono?.spFull;               // 6

    // ── (2) HARD armor: mono ⅔, edged FULL (no reduction), plain unchanged ─────
    await actor.deleteEmbeddedDocuments("Item", actor.items.map(i => i.id));
    await actor.createEmbeddedDocuments("Item", [
      { name: "PROBE hard plate", type: "armor",
        system: { equipped: true, armorType: "hard", coverage: cov(SP) } },
    ]);
    const hardItem = actor.items.find(i => i.name === "PROBE hard plate");
    out.hard = {
      hardness: AL.getArmorHardness(hardItem),                  // "hard" (explicit)
      plainSP:  sync({})?.spFull,                               // 18
      edgedSP:  sync({ edged: true })?.spFull,                  // 18 — edged does nothing to hard
      monoSP:   sync({ mono: true })?.spFull,                   // 12 — ⅔ of 18
    };
    out.hard.persisted = hardItem.system?.armorType;            // "hard" survived the DataModel

    // ── (3) armorType "" (Auto) → heuristic still classifies by name (no migration side-effects) ──
    await actor.deleteEmbeddedDocuments("Item", actor.items.map(i => i.id));
    await actor.createEmbeddedDocuments("Item", [
      { name: "Kevlar Vest",  type: "armor", system: { equipped: true, armorType: "", coverage: cov(SP) } },
      { name: "Metal Gear",   type: "armor", system: { equipped: true, armorType: "", coverage: cov(SP) } },
    ]);
    out.auto = {
      autoValuePersists: actor.items.find(i => i.name === "Kevlar Vest")?.system?.armorType === "",
      softByName: AL.getArmorHardness(actor.items.find(i => i.name === "Kevlar Vest")),   // "soft"
      hardByName: AL.getArmorHardness(actor.items.find(i => i.name === "Metal Gear")),    // "hard"
    };
  } finally {
    await actor.delete().catch(() => {});
  }

  // ── (4) WEAPON data model: mono/edged/broken persist ───────────────────────
  for (const a of game.actors.filter(a => a.name?.startsWith("PROBE mono wielder"))) await a.delete().catch(() => {});
  const wielder = await Actor.create({ name: "PROBE mono wielder", type: "character" });
  try {
    await wielder.createEmbeddedDocuments("Item", [
      { name: "PROBE monokatana", type: "weapon",
        system: { weaponType: "Melee", attackType: "Melee", damage: "4d6", mono: true, edged: true } },
    ]);
    let wpn = wielder.items.find(i => i.name === "PROBE monokatana");
    out.weapon = {
      monoPersists:   wpn.system?.mono === true,
      edgedPersists:  wpn.system?.edged === true,
      brokenDefault:  wpn.system?.broken === false,
    };

    // ── (5) BREAK-ON-FUMBLE via the real weaponFired hook. Empty areaDamages → the handler breaks the
    //        weapon (that call runs before the areaDamages guard) then returns without any dialog. ──
    const firePayload = (extra) => ({ attackerId: wielder.id, weaponId: wpn.id, areaDamages: {}, ...extra });
    const noteRe = /mono-edge is broken/i;
    // Poll for BOTH the broken flag and the chat note (the handler awaits update() then ChatMessage.create()).
    const waitBrokeAndChat = async () => {
      for (let i = 0; i < 60; i++) {
        const brk = wielder.items.get(wpn.id)?.system?.broken === true;
        const chat = [...game.messages].some(m => noteRe.test(m.content ?? ""));
        if (brk && chat) return { brk, chat };
        await new Promise(r => setTimeout(r, 50));
      }
      return { brk: wielder.items.get(wpn.id)?.system?.broken === true,
               chat: [...game.messages].some(m => noteRe.test(m.content ?? "")) };
    };

    Hooks.callAll("cyberpunk2020.weaponFired", firePayload({ mono: true, fumble: true }));
    const res = await waitBrokeAndChat();
    out.weapon.brokeOnFumble = res.brk;                                  // true
    out.weapon.chatPosted = res.chat;                                    // true

    // idempotent: a re-emit does not throw / re-break (already broken)
    Hooks.callAll("cyberpunk2020.weaponFired", firePayload({ mono: true, fumble: true }));
    await new Promise(r => setTimeout(r, 200));

    // non-fumble mono strike does NOT break a fresh weapon
    await wpn.update({ "system.broken": false });
    Hooks.callAll("cyberpunk2020.weaponFired", firePayload({ mono: true, fumble: false }));
    await new Promise(r => setTimeout(r, 250));
    out.weapon.noBreakWhenNoFumble = wielder.items.get(wpn.id)?.system?.broken === false;

    // non-mono weapon on a fumble does NOT break
    Hooks.callAll("cyberpunk2020.weaponFired", firePayload({ mono: false, fumble: true }));
    await new Promise(r => setTimeout(r, 250));
    out.weapon.noBreakWhenNotMono = wielder.items.get(wpn.id)?.system?.broken === false;
  } finally {
    await wielder.delete().catch(() => {});
  }
  return out;
});

const checks = {
  pureNatOne:  r.pure?.natOne === true,
  pureNatFive: r.pure?.natFive === false,
  pureNoRoll:  r.pure?.noRoll === false,

  softHardness:  r.soft?.hardness === "soft",
  softPlain:     r.soft?.plainSP === 18,
  softEdged:     r.soft?.edgedSP === 9,
  softMono:      r.soft?.monoSP === 6,
  softMonoAfter: r.soft?.monoAfter === 94,
  softEdgedAfter:r.soft?.edgedAfter === 91,
  softPlainAfter:r.soft?.plainAfter === 82,
  softAsyncAgrees: r.soft?.asyncMonoSP === 6,

  hardHardness:  r.hard?.hardness === "hard",
  hardPlain:     r.hard?.plainSP === 18,
  hardEdgedFull: r.hard?.edgedSP === 18,
  hardMono:      r.hard?.monoSP === 12,
  hardPersisted: r.hard?.persisted === "hard",

  autoPersists:  r.auto?.autoValuePersists === true,
  autoSoftName:  r.auto?.softByName === "soft",
  autoHardName:  r.auto?.hardByName === "hard",

  wpnMono:   r.weapon?.monoPersists === true,
  wpnEdged:  r.weapon?.edgedPersists === true,
  wpnBrokenDefault: r.weapon?.brokenDefault === true,
  wpnBrokeOnFumble: r.weapon?.brokeOnFumble === true,
  wpnChatPosted:    r.weapon?.chatPosted === true,
  wpnNoBreakNoFumble: r.weapon?.noBreakWhenNoFumble === true,
  wpnNoBreakNotMono:  r.weapon?.noBreakWhenNotMono === true,

  noConsoleErrors: errors.length === 0,
};
console.log(JSON.stringify({ r, checks, errors }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? "MONO-WEAPON KEEPER PASS" : "MONO-WEAPON KEEPER FAIL");
await b.close();
process.exit(pass ? 0 : 1);
