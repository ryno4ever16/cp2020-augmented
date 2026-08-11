/** Martial-art stable-id resolution repair (module/martial/id-resolution-shim.js + the vendored
 *  selection fix in module/martial/martial.js). On :30004 (vanilla base 1.1.1 + module):
 *  the base candidate helper reads only the legacy flags.core.sourceId, so compendium-dragged
 *  style rows (v12+ stamp their origin on _stats.compendiumSource) misclassify as custom
 *  entries — canonical-key level lookups return 0 and the bonus-table lookup misses. With the
 *  shim: candidate lists gain the pack-id tail, classification/level/table/dialog options all
 *  go canonical, and the selection repair prefers the higher effective level when a seeded
 *  level-0 row and a leveled dragged copy share one stable id. Pins the fnff2Enabled world
 *  setting false for core-table value asserts (restored at the end). RED before the module
 *  sync (shim absent on the rig), GREEN after. */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l))||us[0];await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await joinGM(p);

const r = await p.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = { checks: [], fails: [] };
  const check = (n, ok, got) => { out.checks.push(`${ok?"  PASS":"  FAIL"}  ${n}${ok?"":"  got="+JSON.stringify(got)}`); if(!ok) out.fails.push(n); };

  const BL = await import("/systems/cyberpunk2020/module/lookups.js");           // base tables + bonus lookup
  const ML = await import("/modules/cp2020-augmented/module/lookups.js");        // module option builder
  const MM = await import("/modules/cp2020-augmented/module/martial/martial.js");// vendored resolver
  const SH = await import("/modules/cp2020-augmented/module/martial/id-resolution-shim.js");
  const K = CONFIG.Actor.documentClass;
  const PACK = "cyberpunk2020.default-skills-en";
  const canonicalByKey = BL.MARTIAL_ART_ID_BY_KEY;
  const canonicalIds = new Set(Object.values(canonicalByKey));

  const prior = { fnff2: game.settings.get("cyberpunk2020", "fnff2Enabled") };
  await game.settings.set("cyberpunk2020", "fnff2Enabled", false);
  for (const a of game.actors.filter(a => a.name.startsWith("__PW__MAIdRes"))) await a.delete().catch(()=>{});

  // Real drop path: compendium doc -> fromDropData -> embedded create (one per call), then level 5.
  const dropArt = async (actor, nameRe) => {
    const pack = game.packs.get(PACK);
    const idx = [...(await pack.getIndex())].find(e => e.type === "skill" && nameRe.test(e.name));
    if (!idx) return null;
    const doc = await Item.implementation.fromDropData({ type: "Item", uuid: `Compendium.${PACK}.Item.${idx._id}` });
    const [created] = await actor.createEmbeddedDocuments("Item", [doc.toObject()]);
    await created.update({ "system.level": 5 });
    return { packId: idx._id, embId: created.id, name: created.name, row: created };
  };

  try {
    // ── Shim engagement (the healing below must be the shim's, engaged on this vanilla base) ──
    check("candidate wrap installed + marked on the base class", K._getItemIdCandidates?.__cpIdResolutionShim === true, K._getItemIdCandidates?.__cpIdResolutionShim);
    check("selection wrap installed + marked on the base prototype", K.prototype._getSkillByStableId?.__cpIdResolutionShim === true, K.prototype._getSkillByStableId?.__cpIdResolutionShim);

    // ── Actor A: isolation (seeded canonical rows removed, then two dragged rows) ──
    const A = await Actor.create({ name: "__PW__MAIdRes A", type: "character" });
    await sleep(400);
    const seededA = A.items.filter(i => i.type === "skill" && canonicalIds.has(i.id)).map(i => i.id);
    check("creation seeded canonical style rows to remove (isolation precondition)", seededA.length > 0, seededA.length);
    if (seededA.length) await A.deleteEmbeddedDocuments("Item", seededA);
    const akf = await dropArt(A, /Animal Kung Fu/i);
    const kar = await dropArt(A, /Karate/i);
    check("both style rows dropped from the pack", !!akf && !!kar, { akf: !!akf, kar: !!kar });

    // Data condition: v12+ origin field present, legacy flag absent, fresh embedded id.
    const srcOk = (d) => d && d.row.getFlag("core", "sourceId") == null
      && String(d.row._stats?.compendiumSource ?? "").endsWith(d.packId) && d.embId !== d.packId;
    check("dragged rows carry the v12+ origin field, no legacy flag, fresh id", srcOk(akf) && srcOk(kar), null);
    check("candidate list for a dragged row includes its pack-id tail", K._getItemIdCandidates(kar.row).includes(kar.packId), K._getItemIdCandidates(kar.row));

    // Classification, level, table, dialog options — all canonical.
    const tmA = A.trainedMartials();
    const wantA = ["Martial Arts: AnimalKungFu", "Martial Arts: Karate"];
    check("base classification: both dragged styles resolve to canonical keys", wantA.every(k => tmA.includes(k)), tmA);
    check("base classification: no custom-entry values remain", tmA.every(v => !String(v).startsWith("custom-martial:")), tmA);
    check("base level lookup by canonical key = 5 (both)", A.getSkillVal(wantA[0]) === 5 && A.getSkillVal(wantA[1]) === 5, [A.getSkillVal(wantA[0]), A.getSkillVal(wantA[1])]);
    const absentKey = Object.keys(canonicalByKey).find(k => !wantA.includes(k));
    check(`NEGATIVE: absent style's canonical level lookup = 0 (${absentKey})`, A.getSkillVal(absentKey) === 0, A.getSkillVal(absentKey));
    check("core-table bonus lookup by canonical key (Karate/Strike) = 2", BL.getMartialActionBonus("Martial Arts: Karate", "Strike") === 2, BL.getMartialActionBonus("Martial Arts: Karate", "Strike"));
    check("NEGATIVE: custom-entry key still misses the table = 0", BL.getMartialActionBonus("custom-martial:zzz", "Strike") === 0, null);
    const optA = ML.martialOptions(A)[0][0].choices.map(c => c.value);
    check("dialog option values are canonical (both present, none custom)", wantA.every(k => optA.includes(k)) && optA.every(v => !String(v).startsWith("custom-martial:")), optA);

    // ── Actor B: seeded rows KEPT + a duplicate dragged copy (the shadowing repair) ──
    const Bx = await Actor.create({ name: "__PW__MAIdRes B", type: "character" });
    await sleep(400);
    const karId = canonicalByKey["Martial Arts: Karate"];
    const seededKar = Bx.items.get(karId);
    check("seeded level-0 row exists under the canonical id (shadow precondition)", seededKar?.type === "skill" && Number(seededKar.system?.level ?? 0) === 0, seededKar?.system?.level);
    const dup = await dropArt(Bx, /Karate/i);
    check("duplicate dragged copy created (fresh id, level 5)", !!dup && dup.embId !== karId, dup?.embId);

    check("selection prefers the higher effective level over the seeded 0", Bx.getSkillVal("Martial Arts: Karate") === 5, Bx.getSkillVal("Martial Arts: Karate"));
    check("direct stable-id selection returns the leveled copy", Bx._getSkillByStableId(karId)?.id === dup.embId, Bx._getSkillByStableId(karId)?.id);
    const tmB = Bx.trainedMartials();
    check("classification lists the style once, canonically", tmB.filter(v => v === "Martial Arts: Karate").length === 1 && tmB.every(v => !String(v).startsWith("custom-martial:")), tmB);
    const seededOnlyKey = Object.keys(canonicalByKey).find(k => k !== "Martial Arts: Karate" && Bx.items.get(canonicalByKey[k]));
    check(`NEGATIVE: seeded-only level-0 style stays unlisted (${seededOnlyKey})`, !tmB.includes(seededOnlyKey), tmB.includes(seededOnlyKey));

    // Vendored resolver (contested-defense path) heals the same way.
    check("vendored level lookup prefers the leveled copy = 5", MM.getSkillVal(Bx, "Martial Arts: Karate") === 5, MM.getSkillVal(Bx, "Martial Arts: Karate"));
    const mmB = MM.trainedMartials(Bx).filter(m => m.value === "Martial Arts: Karate");
    check("vendored classification lists the style once, canonically", mmB.length === 1, MM.trainedMartials(Bx));

    // Tie rule: equal effective levels -> the direct embedded-id (seeded) row wins, deterministically.
    await dup.row.update({ "system.level": 0 });
    check("tie at equal levels selects the direct-id row", Bx._getSkillByStableId(karId)?.id === karId, Bx._getSkillByStableId(karId)?.id);
    await dup.row.update({ "system.level": 5 });

    // ── Idempotence + the disengage predicate (pure) ──
    const before = K._getItemIdCandidates;
    SH.registerMartialIdResolutionShim();
    check("re-registration is a no-op (same wrapped function object)", K._getItemIdCandidates === before, null);
    check("predicate: a base that reads compendiumSource needs NO shim", SH.needsCandidateShim(function(){ return "compendiumSource"; }) === false, null);
    check("predicate: a base without the read still needs the shim", SH.needsCandidateShim(function(){}) === true, null);
  } finally {
    for (const a of game.actors.filter(a => a.name.startsWith("__PW__MAIdRes"))) await a.delete().catch(()=>{});
    await game.settings.set("cyberpunk2020", "fnff2Enabled", prior.fnff2).catch(()=>{});
  }
  return out;
});

for (const line of r.checks) console.log(line);
const errOk = errors.length === 0;
console.log(`${errOk?"  PASS":"  FAIL"}  0 console errors${errOk?"":"  got="+JSON.stringify(errors.slice(0,5))}`);
const failed = r.fails.length + (errOk ? 0 : 1);
console.log(`\n${r.checks.length + 1} checks, ${failed} failed`);
await b.close();
process.exit(failed ? 1 : 0);
