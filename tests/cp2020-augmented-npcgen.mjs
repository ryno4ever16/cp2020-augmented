/** NPC generator — the assembly layer (module/npcgen/materialize.js + npcgen-app.js + its templates).
 *  The pure layer has its own no-VTT unit suite (tests/npcgen-blueprint.test.mjs); this proves the half
 *  that only a running Foundry can answer:
 *   - a fixed seed produces a named squad in the generator's own folder, and the SAME seed twice
 *     produces a byte-identical plan (so the preview is what gets written);
 *   - the skill LEVELS land on the items the BASE system granted — the generator creates no skills;
 *   - guns come loaded with a matching ammo item, armor is equipped, chrome is carried NOT installed;
 *   - every copied item keeps its compendium provenance, so the corrections layer actually fires;
 *   - humanity is consistent with the chrome that was really stocked;
 *   - token defaults are hostile / no nameplate / unlinked-by-inheritance;
 *   - Preview and Reroll write NOTHING;
 *   - the master setting controls whether the directory button exists at all.
 *  All fixtures self-clean (actors by id, and the folder only if this run created it). */
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
  const SCOPE = "cp2020-augmented";
  const SEED = "keeper-seed-1";

  const BP  = await import("/modules/cp2020-augmented/module/npcgen/blueprint.js");
  const MAT = await import("/modules/cp2020-augmented/module/npcgen/materialize.js");
  const APP = await import("/modules/cp2020-augmented/module/npcgen/npcgen-app.js");

  const madeActorIds = [];
  let folderCreatedByThisRun = false;
  let settingRestored = null;

  try {
    // ── The plan layer: determinism, which is what makes "the preview is what you get" true ──
    const rows = await MAT.npcGenCatalogRows();
    check("catalog rows resolve for the generator (curated, priced)", rows.length > 0, rows.length);
    check("every catalog row the generator may draw from carries a price", rows.every(x => !x.unpriced), rows.filter(x=>x.unpriced).length);

    const planOnce = () => BP.npcBlueprint({ archetype: "goon", dials: "veteran", count: 3, seed: SEED })
      .map(bp => ({ bp, gear: MAT.planNpcGear(bp, rows) }));
    const planA = planOnce();
    const planB = planOnce();
    check("same seed ⇒ byte-identical plan (blueprint + gear picks)",
      JSON.stringify(planA) === JSON.stringify(planB), null);
    const planOther = BP.npcBlueprint({ archetype: "goon", dials: "veteran", count: 3, seed: "keeper-seed-2" })
      .map(bp => ({ bp, gear: MAT.planNpcGear(bp, rows) }));
    check("a different seed ⇒ a different plan (the seed is really used)",
      JSON.stringify(planA) !== JSON.stringify(planOther), null);

    // ── Preview / Reroll write NOTHING ──
    const actorsBefore = game.actors.size;
    const msgsBefore = game.messages.size;
    // ⚠ THE WINDOW THIS BLOCK USED TO DRIVE IS GONE. The Goon Factory rebuild retired the
    // QUICK/FULL split and with it ; the new window has its own keeper
    // (tests/cp2020-augmented-goon-factory.mjs), which covers gating, the preview and the fused
    // Generate in far more depth than this block ever did. What is still worth asserting HERE is the
    // property the retired window relied on and the SURVIVING engine still provides: planning is
    // read-only. So the plan is built through the engine directly, which is exactly what the window
    // did on its behalf.
    const planPreview = BP.npcBlueprint({ archetype: "goon", dials: "veteran", count: 3, seed: SEED })
      .map(bp => ({ bp, gear: MAT.planNpcGear(bp, rows) }));
    check("planning produces a 3-NPC plan", planPreview.length === 3, planPreview.length);
    BP.npcBlueprint({ archetype: "goon", dials: "veteran", count: 3, seed: SEED });   // a second pass
    check("planning created NO actors", game.actors.size === actorsBefore, { before: actorsBefore, now: game.actors.size });
    check("planning posted NO chat messages", game.messages.size === msgsBefore, { before: msgsBefore, now: game.messages.size });
    const planReseeded = BP.npcBlueprint({ archetype: "goon", dials: "veteran", count: 3, seed: "keeper-seed-3" })
      .map(bp => ({ bp, gear: MAT.planNpcGear(bp, rows) }));
    check("a re-seeded plan differs and still writes nothing",
      JSON.stringify(planReseeded) !== JSON.stringify(planPreview) && game.actors.size === actorsBefore,
      { actors: game.actors.size });

    // ── The real create ──
    const folderName = MAT.npcGenFolderName();
    folderCreatedByThisRun = !game.folders.find(f => f.type === "Actor" && f.name === folderName);
    const blueprints = planA.map(x => x.bp);
    const summaries = await MAT.materializeNpcSquad(blueprints);
    for (const s of summaries) madeActorIds.push(s.id);
    check("3 NPCs were created", summaries.length === 3, summaries.length);

    const folder = game.folders.find(f => f.type === "Actor" && f.name === folderName);
    check(`output folder "${folderName}" exists`, !!folder, folderName);
    const inFolder = game.actors.filter(a => a.folder?.id === folder?.id && madeActorIds.includes(a.id));
    check("all 3 landed in that folder", inFolder.length === 3, inFolder.length);
    const names = inFolder.map(a => a.name).sort();
    check('names are the placeholder sequence "Goon 1".."Goon 3"',
      JSON.stringify(names) === JSON.stringify(["Goon 1","Goon 2","Goon 3"]), names);

    const a0 = game.actors.get(summaries[0].id);
    const bp0 = blueprints[0];

    // ── The base system granted the skills; we only moved the numbers ──
    const skillItems = a0.items.filter(i => i.type === "skill");
    check("the base _preCreate granted the full skill set (>100 skill items), generator created none",
      skillItems.length > 100, skillItems.length);
    const nameByKey = await MAT.skillNameIndex();
    const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const levelOfKey = (key) => {
      const hit = nameByKey.get(norm(key));
      const it = a0.items.filter(i => i.type === "skill").find(i => norm(i.name) === norm(hit?.name ?? key));
      return it ? Number(it.system?.level) : null;
    };
    // Three spot-asserts BY SCHEMA KEY, including the two whose pack name differs from the key —
    // "AwarenessNotice" ships as "Awareness/Notice" and "CombatSense" as "Combat Sense", which is the
    // whole reason the name index exists.
    for (const key of ["Handgun", "AwarenessNotice", "CombatSense"]) {
      const want = bp0.skillLevels.find(s => s.skillKey === key)?.level ?? null;
      const got = levelOfKey(key);
      check(`skill level written for "${key}" matches the blueprint (${want})`, want != null && got === want, { want, got });
    }
    check("the tier's whole career pool was spent on the sheet",
      bp0.skillLevels.reduce((t, s) => t + s.level, 0) === 40, bp0.skillLevels.reduce((t,s)=>t+s.level,0));
    // The special ability lives in the role-skills pack, which the base _preCreate does NOT grant — so
    // the generator has to create it or the one skill the book insists on is the one that goes missing.
    check("the special-ability skill was GRANTED (role-skills pack is never auto-granted)",
      summaries[0].skillsGranted.includes("CombatSense"), summaries[0].skillsGranted);
    check("exactly ONE Combat Sense item exists (granted, not duplicated)",
      a0.items.filter(i => i.type === "skill" && norm(i.name) === "combatsense").length === 1,
      a0.items.filter(i => i.type === "skill" && norm(i.name) === "combatsense").map(i => i.name));
    check("the granted special ability kept the pack's own skill data (isRoleSkill)",
      a0.items.find(i => i.type === "skill" && norm(i.name) === "combatsense")?.system?.isRoleSkill === true,
      a0.items.find(i => i.type === "skill" && norm(i.name) === "combatsense")?.system?.isRoleSkill);

    // ── Gear: provenance, loaded guns, equipped armor, carried chrome ──
    const gear = a0.items.filter(i => ["weapon","armor","cyberware","ammo"].includes(i.type) && i.getFlag(SCOPE, "npcGenToken"));
    check("gear items were stocked", gear.length > 0, gear.length);
    const copied = gear.filter(i => i.type !== "ammo");
    check("EVERY copied pack item kept _stats.compendiumSource (the corrections trigger)",
      copied.length > 0 && copied.every(i => !!i._stats?.compendiumSource),
      copied.map(i => ({ n: i.name, src: i._stats?.compendiumSource ?? null })));

    const weapons = a0.items.filter(i => i.type === "weapon" && i.getFlag(SCOPE, "npcGenToken") && Number(i.system?.shots) > 0);
    check("at least one magazine-fed weapon was stocked", weapons.length > 0, weapons.length);
    for (const w of weapons) {
      const ammo = a0.items.get(w.system?.ammoItemId);
      check(`"${w.name}" is LOADED — ammoItemId points at a real ammo item`, !!ammo && ammo.type === "ammo", w.system?.ammoItemId);
      check(`"${w.name}" magazine is full (shotsLeft ${w.system?.shots})`,
        Number(w.system?.shotsLeft) === Number(w.system?.shots), { shotsLeft: w.system?.shotsLeft, shots: w.system?.shots });
      check(`"${w.name}" ammo item carries a full magazine of rounds (${w.system?.shots})`,
        Number(ammo?.system?.quantity) === Number(w.system?.shots), ammo?.system?.quantity);
      check(`"${w.name}" ammo caliber matches the weapon`,
        String(ammo?.system?.caliber) === String(w.system?.ammoType), { ammo: ammo?.system?.caliber, weapon: w.system?.ammoType });
    }

    const armor = a0.items.filter(i => i.type === "armor" && i.getFlag(SCOPE, "npcGenToken"));
    check("armor was stocked", armor.length > 0, armor.length);
    for (const ar of armor) {
      check(`"${ar.name}" is EQUIPPED (the damage pipeline reads it)`, ar.system?.equipped === true, ar.system?.equipped);
      const sp = Math.max(0, ...Object.values(ar.system?.coverage ?? {}).map(c => Number(c?.stoppingPower) || 0));
      check(`"${ar.name}" carries real per-location SP (${sp})`, sp > 0, sp);
    }

    const chrome = a0.items.filter(i => i.type === "cyberware" && i.getFlag(SCOPE, "npcGenToken"));
    if (chrome.length) {
      check("cyberware is CARRIED, not installed (equipped false on every piece)",
        chrome.every(c => c.system?.equipped === false), chrome.map(c => ({ n: c.name, e: c.system?.equipped })));
    } else {
      check("cyberware plan produced no pieces this seed (recorded, not a failure)", true, 0);
    }

    // ── Humanity is consistent with the chrome ACTUALLY stocked ──
    const loss = chrome.reduce((t, c) => t + (Number(c.system?.humanityLoss) || 0), 0);
    const wantHum = (Number(bp0.stats.emp) || 0) * 10 - loss;
    check(`humanity written = EMP×10 − chrome loss (${wantHum})`, Number(a0.system?.humanity) === wantHum,
      { got: a0.system?.humanity, want: wantHum, loss });
    check("EMP was re-derived from the post-chrome humanity",
      Number(a0.system?.stats?.emp?.base) === Math.floor(wantHum / 10), { emp: a0.system?.stats?.emp?.base, want: Math.floor(wantHum/10) });
    check("the rolled stats reached the sheet at system.stats.<k>.base",
      Number(a0.system?.stats?.ref?.base) === bp0.stats.ref && Number(a0.system?.stats?.bt?.base) === bp0.stats.bt,
      { ref: a0.system?.stats?.ref?.base, bt: a0.system?.stats?.bt?.base, want: { ref: bp0.stats.ref, bt: bp0.stats.bt } });
    check("a legal system.role.value was written", (a0.system?.role?.value ?? "") === bp0.role, a0.system?.role?.value);

    // ── Token defaults ──
    const proto = a0.prototypeToken;
    check("prototype token disposition is HOSTILE", proto.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE, proto.disposition);
    check("prototype token nameplate is hidden", proto.displayName === CONST.TOKEN_DISPLAY_MODES.NONE, proto.displayName);
    // Inherited, not forced: the base system gives an npc no actorLink, and we never write one.
    check("prototype token is UNLINKED by inheritance (we never set actorLink)", proto.actorLink === false, proto.actorLink);

    // ── Provenance flag the summary/preview and a later cleanup both rely on ──
    const stamp = a0.getFlag(SCOPE, "npcGen");
    check("actor carries the npcGen provenance flag (seed + tier + archetype)",
      stamp?.tier === "veteran" && stamp?.archetype === "goon" && stamp?.seed === bp0.seed,
      stamp);
    check("the placeholder archetype is recorded as a placeholder on the actor", stamp?.archetypePlaceholder === true, stamp?.archetypePlaceholder);

    // ── The corrections layer really fires on the generator's copy path ──
    // A deterministic, known-corrected base item: data-corrections renames pistols/ghAVVP4pbH2zOIx6
    // from the pack's misspelling to "Llama Comanche". Copied exactly the way the generator copies.
    const doc = await game.packs.get("cyberpunk2020.pistols")?.getDocument("ghAVVP4pbH2zOIx6");
    if (doc) {
      const [made] = await a0.createEmbeddedDocuments("Item", [game.items.fromCompendium(doc)]);
      check("corrections fired on a fromCompendium copy — corrected NAME applied",
        made?.name === "Llama Comanche", { got: made?.name, packName: doc.name });
      check("corrections stamped correctionApplied on the copy", made?.getFlag(SCOPE, "correctionApplied") === true,
        made?.getFlag(SCOPE, "correctionApplied"));
      await made?.delete();
    } else {
      check("known-corrected probe item present in this world", false, "cyberpunk2020.pistols/ghAVVP4pbH2zOIx6 missing");
    }

    // ── The summary card, GM-whispered ──
    const cards = game.messages.contents.filter(m => (m.content ?? "").includes("cp-npcgen-card"));
    const card = cards[cards.length - 1];
    check("one GM-whispered summary card was posted", !!card, cards.length);
    const gmIds = ChatMessage.getWhisperRecipients("GM").map(u => u.id).sort();
    check("summary card is whispered to the GMs, concretely",
      JSON.stringify([...(card?.whisper ?? [])].sort()) === JSON.stringify(gmIds), { got: card?.whisper, want: gmIds });
    check("summary card names the carried-not-installed limitation when there is chrome",
      chrome.length === 0 || (card?.content ?? "").includes("CARRIED"), null);

    // ── The directory button obeys the master setting ──
    settingRestored = game.settings.get(SCOPE, "npcGenEnabled");
    await game.settings.set(SCOPE, "npcGenEnabled", true);
    await ui.actors.render(true); await sleep(400);
    const onEl = document.querySelector("#actors .cp2020ae-npcgen-btn, .cp2020ae-npcgen-btn");
    check("master ON ⇒ the GM sees the NPC Generator button in the Actors directory", !!onEl, null);
    check("the button's label is localized (no raw key leaked)",
      !!onEl && !(onEl.textContent || "").includes("CYBERPUNK."), onEl?.textContent);
    await game.settings.set(SCOPE, "npcGenEnabled", false);
    await ui.actors.render(true); await sleep(400);
    check("master OFF ⇒ the button is gone", !document.querySelector(".cp2020ae-npcgen-btn"), null);
    check("master OFF ⇒ openNpcGenerator() refuses to open a window",
      APP.openNpcGenerator() === null, null);
    await game.settings.set(SCOPE, "npcGenEnabled", settingRestored);
    settingRestored = null;

  } catch (e) {
    check("keeper body ran without throwing", false, String(e?.stack ?? e));
  } finally {
    try { if (settingRestored !== null) await game.settings.set(SCOPE, "npcGenEnabled", settingRestored); } catch {}
    for (const id of madeActorIds) { try { await game.actors.get(id)?.delete(); } catch {} }
    if (folderCreatedByThisRun) {
      try { await game.folders.find(f => f.type === "Actor" && f.name === MAT.npcGenFolderName())?.delete(); } catch {}
    }
    try {
      for (const m of game.messages.contents.filter(m => (m.content ?? "").includes("cp-npcgen-card"))) await m.delete();
    } catch {}
  }
  return out;
});

for (const line of r.checks) console.log(line);
const consoleFails = errors.length;
console.log(consoleFails ? `  FAIL  0 console errors  got=${JSON.stringify(errors.slice(0, 6))}` : "  PASS  0 console errors");
const total = r.checks.length + 1;
const failed = r.fails.length + (consoleFails ? 1 : 0);
console.log(`\n${total - failed}/${total} passed`);
await b.close();
process.exit(failed ? 1 : 0);
