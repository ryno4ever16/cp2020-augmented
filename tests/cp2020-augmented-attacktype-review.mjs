/**
 * ATTACK-TYPE REVIEW (source-checked 2026-09-30, RYNO: "All approved"; import-staging/ATTACKTYPE-SOURCE-REVIEW.md).
 *
 * 21 weapons in our supplement packs carried no attackType, so the fire dialog offered them Semi-Auto only and
 * the ROF-count rule handed an untagged ROF-30 machine gun a 30-shot free count. The books were read for each:
 * eleven are automatic, five semi-automatic, four select single-shot-or-burst and never full auto, one is a
 * rocket launcher. Tilt's core CAWS is tagged Shotgun but is the book's own autoshotgun example (Core p.109).
 *
 * The data now carries the tags; the weapon sheet's Burst Capable box (a field nothing used to read) marks the
 * four select-fire weapons; the module's fire-mode list honours both, plus the registry's read-time correction
 * for the CAWS; the registry patches the CAWS tag onto new copies.
 *
 * Legs:
 *   D  the SERVED packs carry the approved data (index reads: tag, burst box, ROF, the Teen Dreem dedupe)
 *   M  fire-mode lists: automatic = four modes; semi-automatic = one; burst-capable semi-automatic = two;
 *      the CAWS copy = four (registry, read-time) and its new copy carries the tag (registry, create-time)
 *   F  a three-round burst actually fires from a burst-capable semi-automatic (card + rounds)
 *   C  the ROF-count rule: a burst from such a weapon spends its count (the next shot is a new action)
 * Wording rule: legs are named after the mechanism, not the fiction.
 */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l));await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") { const l = m.location?.() ?? {}; errors.push("console: " + m.text() + (l.url ? ` @ ${l.url}:${l.lineNumber ?? "?"}` : "")); } });
await joinGM(p);

const r = await p.evaluate(async () => {
  const out = { data: {}, modes: {}, fire: {}, count: {} };
  const SCOPE = "cp2020-augmented";
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const L = await import("/modules/cp2020-augmented/module/lookups.js");
  const DC = await import("/modules/cp2020-augmented/module/data-corrections.js");

  // ── D: the served packs ───────────────────────────────────────────────────
  const EXPECT = {
    "cp2020-augmented.supplement-pistols": {
      uDMOdQvBH9HMoVLJ: { name: "Teen Dreem", atk: "Auto", rof: 10, burst: false, rel: "Unreliable" },
      KEuQYeSAC3OCYjSY: { name: 'FN Browning "3-Spot"', atk: "SemiAuto", rof: 3, burst: true },
      UwIAof7qZkSBO7oL: { name: "Glock Thirty Machine Pistol", atk: "SemiAuto", rof: 3, burst: true },
      "88Ozw8E0cKO922vK": { name: "Nova Model 338 Citygun", atk: "SemiAuto", rof: 3, burst: false },
      HlkfnZsne7tS3pnG: { name: "Budget Arms C-41", atk: "SemiAuto", burst: false },
      IDTAIZw4unfw7y10: { name: 'Mustang Arms "Mark II"', atk: "SemiAuto", burst: false },
      jZ3tSjanmVa1fJrq: { name: "Tsunami Express Racegun", atk: "SemiAuto", burst: false },
    },
    "cp2020-augmented.supplement-submachineguns": {
      // IMI Gamdall (Cg8Oe9Vb9mGxZBBf) left this table on 2026-10-03: a second record of the Gamdaii, removed.
      LNB6USobTaWUOddr: { atk: "Auto" }, Os19st71TvwDtryE: { atk: "Auto", burst: false },
      lu45fPUYlFWf6oGs: { atk: "Auto" }, nXsLHO2PLT7uadsu: { atk: "Auto" },
    },
    "cp2020-augmented.supplement-rifles": {
      "2gcpE1ckI4yZ9gQC": { atk: "SemiAuto", burst: true }, "3xmHrc3Dpv5JFQq7": { atk: "SemiAuto", burst: false }, sP0RChX4L5t5xwO5: { atk: "SemiAuto", burst: true, rof: 4 },
    },
    "cp2020-augmented.supplement-heavy": {
      "2oGhnb9dyK3GCU6g": { atk: "RPG" }, IgdWVnAo8lb8paws: { atk: "Auto", burst: false }, ecSQRLzbxcvLkOfa: { atk: "Auto", burst: false },
      // The G-6 Advanced Squad Automatic (wYynTF43e7yGVHzM) left on 2026-10-03: a second record of the G-6 SAW, removed.
      nF83fKgGZBChUsR2: { atk: "Auto" }, whr4LIFDRnXpVIij: { atk: "Auto", src: "Chromebook 1 p.53" },
    },
  };
  const mismatches = []; let checked = 0;
  for (const [packId, rows] of Object.entries(EXPECT)) {
    const pack = game.packs.get(packId);
    const idx = pack ? await pack.getIndex({ fields: ["system.attackType", "system.rof", "system.burstCapable", "system.reliability", "system.source"] }) : null;
    for (const [id, want] of Object.entries(rows)) {
      checked++;
      const e = idx?.get?.(id) ?? idx?.find?.(x => x._id === id);
      if (!e) { mismatches.push(`${packId} ${id}: MISSING`); continue; }
      const s = e.system ?? {};
      if (want.name !== undefined && e.name !== want.name) mismatches.push(`${id} name ${e.name}`);
      if (want.atk !== undefined && String(s.attackType ?? "") !== want.atk) mismatches.push(`${e.name} atk ${s.attackType}`);
      if (want.rof !== undefined && Number(s.rof) !== want.rof) mismatches.push(`${e.name} rof ${s.rof}`);
      if (want.burst !== undefined && (s.burstCapable === true) !== want.burst) mismatches.push(`${e.name} burst ${s.burstCapable}`);
      if (want.rel !== undefined && String(s.reliability ?? "") !== want.rel) mismatches.push(`${e.name} rel ${s.reliability}`);
      if (want.src !== undefined && String(s.source ?? "") !== want.src) mismatches.push(`${e.name} src ${s.source}`);
    }
  }
  const pistols = game.packs.get("cp2020-augmented.supplement-pistols");
  const pidx = await pistols.getIndex();
  out.data = { checked, mismatches, teenDreamGone: !pidx.find(x => x._id === "Zhbm632VzcgA0HN1"), teenEntries: pidx.filter(x => /teen dre/i.test(x.name)).map(x => x.name) };

  // ── M + F + C: copies on a fixture actor, the dialog's own mode list ───────
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__ATR"))) await a.delete().catch(() => {});
  const wasFumble = game.settings.get("cyberpunk2020", "fumbleTableEnabled");
  if (wasFumble) await game.settings.set("cyberpunk2020", "fumbleTableEnabled", false);
  const priorCombatId = game.combat?.id ?? null;
  let combat = null;
  const actor = await Actor.create({ name: "__PW__ATR Shooter", type: "character" });
  try {
    const importFrom = async (packId, id) => {
      const doc = await game.packs.get(packId).getDocument(id);
      const data = doc.toObject(); data._stats = { ...(data._stats ?? {}), compendiumSource: doc.uuid };
      const [created] = await actor.createEmbeddedDocuments("Item", [data]);
      return created;
    };
    const spot   = await importFrom("cp2020-augmented.supplement-pistols", "KEuQYeSAC3OCYjSY");   // burst-capable semi-auto
    const city   = await importFrom("cp2020-augmented.supplement-pistols", "88Ozw8E0cKO922vK");   // plain semi-auto
    const mpk    = await importFrom("cp2020-augmented.supplement-submachineguns", "lu45fPUYlFWf6oGs");   // automatic
    const caws   = await importFrom("cyberpunk2020.shotguns", "vWOoylh5RXN5GC5c");   // Tilt's CAWS, tag corrected
    const cawsDoc = await game.packs.get("cyberpunk2020.shotguns").getDocument("vWOoylh5RXN5GC5c");
    const modesOf = (item) => L.rangedModifiers(item, [], {})[0]?.[0]?.choices ?? null;   // the dialog's first group = Fire Mode
    const modeList = (item) => { const g = L.rangedModifiers(item, [], {}); const fm = g.flat().find(x => x?.dataPath === "fireMode"); return fm ? (Array.isArray(fm.choices) ? fm.choices.map(c => c?.value ?? c) : Object.values(fm.choices)) : null; };
    out.modes = {
      spot: modeList(spot), city: modeList(city), mpk: modeList(mpk), caws: modeList(caws),
      cawsStoredTag: cawsDoc.system?.attackType, cawsCorrected: DC.correctedAttackType(cawsDoc), cawsCopyTag: caws.system?.attackType,
      spotBase: spot.__getFireModes?.(), cawsBase: caws.__getFireModes?.(),
    };

    // F: a burst from the 3-Spot through the real dialog
    combat = await Combat.create({ scene: null, active: true });
    await combat.createEmbeddedDocuments("Combatant", [{ actorId: actor.id, initiative: 10 }]);
    await combat.startCombat(); await sleep(500);
    const sheet = actor.sheet; await sheet.render(true); await sleep(900);
    const submitOf = (d) => [...(d.element?.querySelectorAll('button[type="submit"], button.fire') ?? [])].find(bt => bt.offsetParent !== null) ?? null;
    const untilDialog = async (d) => { for (let i = 0; i < 40 && !(d.element?.querySelector("input[name='extraMod']") && submitOf(d)); i++) await sleep(150); return !!submitOf(d); };
    const open = async (item) => { const d = sheet._cpOpenWeaponAttackDialog(item); const ok = await untilDialog(d); await sleep(250); return { d, ok }; };
    const fireModeOptions = (d) => [...(d.element?.querySelectorAll('select[name="fields.fireMode"] option, select[name="fireMode"] option') ?? [])].map(o => o.value);
    const setMode = async (d, v) => { const el = d.element?.querySelector('select[name="fields.fireMode"], select[name="fireMode"]'); if (!el) return false; el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); await sleep(150); return el.value === v; };
    const fire = async (d) => { const before = new Set(game.messages.contents.map(m => m.id)); submitOf(d)?.click(); let msg = null; for (let i = 0; i < 60 && !msg; i++) { await sleep(150); msg = game.messages.contents.find(m => !before.has(m.id)) ?? null; } await sleep(900); return msg; };
    const flags = () => { const raw = actor.getFlag(SCOPE, "attackAction"); let st = null; try { st = typeof raw === "string" ? JSON.parse(raw) : null; } catch {} return { count: actor.getFlag(SCOPE, "actionCount") ?? null, attack: st }; };
    let o = await open(spot);
    const spotOptions = fireModeOptions(o.d);
    const setOk = await setMode(o.d, "ThreeRoundBurst");
    const msg = await fire(o.d);
    const txt = (msg?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    out.fire = { spotOptions, setOk, card: !!msg, snippet: txt.slice(0, 140), after: flags(), shotsLeft: actor.items.get(spot.id)?.system?.shotsLeft };
    // C: the next single shot from the 3-Spot is a NEW action (the burst spent the count)
    o = await open(spot); await setMode(o.d, "SemiAuto");
    const pre = { extraMod: o.d.element?.querySelector("input[name='extraMod']")?.value ?? null, kind: o.d.element?.querySelector(".cp-multi-action-note")?.dataset?.kind ?? null };
    const msg2 = await fire(o.d);
    out.count = { pre, card: !!msg2, after: flags() };
    const oc = await open(city); out.modes.cityOptions = fireModeOptions(oc.d); try { await oc.d.close(); } catch {}
    await sheet.close().catch(() => {});
  } catch (e) { out.error = String(e?.stack ?? e); }
  finally {
    if (combat) await combat.delete().catch(() => {});
    if (priorCombatId) await game.combats.get(priorCombatId)?.activate().catch(() => {});
    await actor.delete().catch(() => {});
    if (wasFumble) await game.settings.set("cyberpunk2020", "fumbleTableEnabled", true).catch(() => {});
  }
  return out;
});

const legs = [];
const ok = (name, cond, got) => legs.push([name, !!cond, got]);
const J = (x) => JSON.stringify(x);
const D = r.data ?? {};
ok("D1 the served packs carry the approved tags, burst boxes, ROFs, reliability and source for every reviewed weapon", D.checked === 19 && D.mismatches?.length === 0, J(D));
ok("D2 the Blackhand's duplicate is gone and the book's Teen Dreem entry is the only one", D.teenDreamGone === true && J(D.teenEntries) === '["Teen Dreem"]', J({ gone: D.teenDreamGone, entries: D.teenEntries }));
const M = r.modes ?? {};
ok("M1 a burst-capable semi-automatic offers Semi-Auto and Three-Round Burst, nothing more (the base alone offered one)", J(M.spot) === '["SemiAuto","ThreeRoundBurst"]' && J(M.spotBase) === '["SemiAuto"]', J({ spot: M.spot, base: M.spotBase, err: r.error }));
ok("M2 a plain semi-automatic offers Semi-Auto only", J(M.city) === '["SemiAuto"]', J(M.city));
ok("M3 an automatic keeps the base's four modes", J(M.mpk) === '["FullAuto","Suppressive","ThreeRoundBurst","SemiAuto"]', J(M.mpk));
ok("M4 CAWS: stored tag Shotgun, registry reads Autoshotgun, the new copy carries Autoshotgun, the dialog offers four modes", M.cawsStoredTag === "Shotgun" && M.cawsCorrected === "Autoshotgun" && M.cawsCopyTag === "Autoshotgun" && J(M.caws) === '["FullAuto","Suppressive","ThreeRoundBurst","SemiAuto"]', J({ stored: M.cawsStoredTag, corrected: M.cawsCorrected, copy: M.cawsCopyTag, modes: M.caws, base: M.cawsBase }));
const F = r.fire ?? {};
ok("F1 the real dialog lists both modes for the 3-Spot and a three-round burst fires (card posted, rounds spent)", J(F.spotOptions) === '["SemiAuto","ThreeRoundBurst"]' && F.setOk && F.card && F.after?.count === 1, J(F));
const C = r.count ?? {};
ok("C1 the burst spent the weapon's count: the next single shot is a new action with -3 seeded", C.pre?.extraMod === "-3" && C.pre?.kind === "rofSpent" && C.after?.count === 2, J(C));
ok("M5 the real dialog for the plain semi-automatic lists one mode", J(M.cityOptions) === '["SemiAuto"]', J(M.cityOptions));
ok("0 console errors", errors.length === 0, J(errors.slice(0, 3)));

let fail = 0;
for (const [n, pass, got] of legs) { if (!pass) fail++; console.log(`${pass ? "PASS" : "FAIL"}  ${n}${pass ? "" : `   [got: ${got}]`}`); }
console.log(`\n${legs.length - fail}/${legs.length} checks passed`);
await b.close();
process.exit(fail ? 1 : 0);
