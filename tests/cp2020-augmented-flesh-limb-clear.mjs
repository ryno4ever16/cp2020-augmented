/** Flesh-limb injury CLEAR (M18 recovery) — the medical counterpart to cyberlimb repair. Verifies the
 *  full loop on :30004: a W4RST4R hit records fleshLimbStatus, the sheet shows a VISIBLE styled badge
 *  and a VISIBLE clear control (not the base's hover-only .segment-repair trap), a real click removes
 *  the flag and the badge/button vanish, the API is idempotent, and the GM-only gate governs it.
 *  Needs an active scene (see test-harness). */
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
  const DA = await import("/modules/cp2020-augmented/module/combat/DamageApplicator.js");
  const CL = await import("/modules/cp2020-augmented/module/mech/cyberlimb.js");
  const SCOPE = "cp2020-augmented";
  const prior = { limb: game.settings.get(SCOPE,"limbLossEnabled"), model: game.settings.get(SCOPE,"limbModel"), gm: game.settings.get(SCOPE,"cyberlimbRepairGmOnly") };

  for (const a of game.actors.filter(a => a.name.startsWith("__PW__FleshClear"))) await a.delete().catch(()=>{});
  await game.settings.set(SCOPE,"limbLossEnabled",true);
  await game.settings.set(SCOPE,"limbModel","w4rst4r");
  await game.settings.set(SCOPE,"cyberlimbRepairGmOnly",false);

  const actor = await Actor.create({ name:"__PW__FleshClear", type:"character" });
  await actor.update({ "system.damage":0, "system.stats.bt.value":2 });
  await DA.applyAreaDamages({ target: actor, areaDamages: { rArm:[{ damage:30 }] } });
  await sleep(500);

  // (1) automated write
  const flag1 = (actor.getFlag(SCOPE,"fleshLimbStatus")??{}).rArm;
  check("damage records fleshLimbStatus rArm = severed", flag1 === "severed", flag1);

  // (2) sheet: badge + clear control both VISIBLE AT REST (no hover)
  const open = async () => { await actor.sheet.render(true); await sleep(900);
    const root = actor.sheet.element;
    root?.querySelector?.('.sheet-tabs [data-tab="combat"], a[data-tab="combat"]')?.click?.(); await sleep(500);
    root.querySelector(".armor-display")?.scrollIntoView({block:"center"}); await sleep(300); return root; };
  let root = await open();
  const badge = root.querySelector(".segment-status-row .segment-limb-status.cp-limb-flesh");
  const clearBtn = root.querySelector('.cp-flesh-clear[data-zone="rArm"]');
  const vis = el => { if(!el) return null; const q=el.getBoundingClientRect(); const cs=getComputedStyle(el);
    return { text: el.textContent.trim(), w:Math.round(q.width), h:Math.round(q.height), visible: q.width>0&&q.height>0&&cs.display!=="none"&&cs.visibility!=="hidden", bg: cs.backgroundColor }; };
  const bv = vis(badge), cv = vis(clearBtn);
  check("sheet: flesh badge visible at rest + reads 'severed' + has a colour (styled)", !!bv && bv.visible && /sever/i.test(bv.text) && bv.bg !== "rgba(0, 0, 0, 0)", bv);
  check("sheet: flesh CLEAR control visible at rest (not hover-only)", !!cv && cv.visible && cv.w>0, cv);

  // (3) REAL GESTURE: click the clear control
  clearBtn.click();
  for (let i=0;i<30 && (actor.getFlag(SCOPE,"fleshLimbStatus")??{}).rArm; i++) await sleep(150);
  const flag2 = (actor.getFlag(SCOPE,"fleshLimbStatus")??{}).rArm;
  check("gesture: clicking clear removes the fleshLimbStatus entry", flag2 === undefined, flag2);
  await actor.sheet.close().catch(()=>{});
  root = await open();
  check("gesture: badge + clear control GONE after clearing", !root.querySelector(".segment-status-row .segment-limb-status.cp-limb-flesh") && !root.querySelector('.cp-flesh-clear[data-zone="rArm"]'), null);
  await actor.sheet.close().catch(()=>{});

  // (4) API idempotency + return values
  const again = await CL.clearFleshLimb(actor, "rArm");
  check("API: clearFleshLimb on an already-clean zone returns false", again === false, again);
  // re-damage, then GM-only gate check (still true as GM)
  await DA.applyAreaDamages({ target: actor, areaDamages: { lLeg:[{ damage:30 }] } }); await sleep(400);
  await game.settings.set(SCOPE,"cyberlimbRepairGmOnly",true);
  root = await open();
  check("GM-only ON: a GM still sees the flesh clear control", !!root.querySelector('.cp-flesh-clear[data-zone="lLeg"]'), null);
  await actor.sheet.close().catch(()=>{});

  // (5) weaponFired arm notice covers a CRIPPLED flesh arm (1.1.1: it was omitted, only the upper
  //     bands fired). Set the flag directly so the check is model-independent, then fire the hook.
  await actor.setFlag(SCOPE, "fleshLimbStatus", { rArm: "crippled" }); await sleep(150);
  const crippledWord = game.i18n.localize("CYBERPUNK.FleshLimbStatusCrippled");
  const q = game.messages.size;
  Hooks.callAll("cyberpunk2020.weaponFired", { attackerId: actor.id, areaDamages: {} });
  await sleep(600);
  const armCards = game.messages.contents.slice(q).filter(m => (m.content||"").includes(actor.name) && (m.content||"").includes(crippledWord)).length;
  check("weaponFired: a CRIPPLED flesh arm posts the arm-use notice", armCards >= 1, armCards);

  // (6) THE M18 SPLIT MIGRATION, through its own exposed re-run seam. Before M18 both kinds of limb
  //     wound shared `limbStatus`; the flesh models now write `fleshLimbStatus`, so pre-M18 state has
  //     to move — but only for a zone with no structural pool, and only for documents that carry the
  //     old key at all. Driven here rather than through a reload, because the reload path is the boot
  //     hook and what is worth pinning is the sweep's own decisions.
  //     ⚠ NOT PINNED HERE: the hotfix's other half, that a clean unlinked token's synthetic actor is
  //     never built. On this core it cannot be observed — core prepares every scene's token documents
  //     at world load (Scene.prepareEmbeddedDocuments → TokenDocument.applyActiveEffects reads
  //     `token.actor` for every unlinked token, drawn scene or not), so the read has already happened
  //     before any sweep runs. The guard still saves the sweep from doing it a second time per token;
  //     it is simply not attributable from a spy on this core.
  const scene = game.scenes.active ?? game.scenes.viewed;
  for (const a of game.actors.filter(a => /^__PW__MIG/.test(a.name))) await a.delete().catch(()=>{});
  for (const t of (scene?.tokens ?? []).filter(t => /^__PW__MIG/.test(t.name))) await scene.deleteEmbeddedDocuments("Token",[t.id]).catch(()=>{});
  const migWorld = await Actor.create({ name: "__PW__MIG World", type: "character",
    flags: { [SCOPE]: { limbStatus: { lArm: { severity: "mangled" } } } } });
  const migBase = await Actor.create({ name: "__PW__MIG Base", type: "character" });
  const proto = { actorId: migBase.id, actorLink: false, width: 1, height: 1, y: 1600 };
  const made = await scene.createEmbeddedDocuments("Token", [
    { ...proto, name: "__PW__MIG Dirty", x: 1600 },
    { ...proto, name: "__PW__MIG Clean", x: 1800 },
  ]);
  const dirty = scene.tokens.get(made.find(t => /Dirty/.test(t.name)).id);
  const clean = scene.tokens.get(made.find(t => /Clean/.test(t.name)).id);
  await dirty.actor.update({ [`flags.${SCOPE}.limbStatus`]: { rLeg: { severity: "broken" } } });
  await sleep(300);
  const rawFlags = (td) => foundry.utils.deepClone(td.delta?._source?.flags ?? {});
  const migrate = game.modules.get(SCOPE)?.api?.migrations?.fleshLimbStatus;
  check("migration: the forced re-run seam is exposed on the module api", typeof migrate === "function", typeof migrate);
  await migrate({ force: true });
  await sleep(700);
  check("migration: a world actor's flesh state moves to fleshLimbStatus, by value",
    migWorld._source.flags?.[SCOPE]?.fleshLimbStatus?.lArm?.severity === "mangled",
    JSON.stringify(migWorld._source.flags?.[SCOPE]));
  check("migration: and the old limbStatus zone is gone from its source",
    migWorld._source.flags?.[SCOPE]?.limbStatus?.lArm === undefined,
    JSON.stringify(migWorld._source.flags?.[SCOPE]?.limbStatus));
  check("migration: an unlinked token's DELTA shows the same move, by value",
    rawFlags(dirty)?.[SCOPE]?.fleshLimbStatus?.rLeg?.severity === "broken"
    && rawFlags(dirty)?.[SCOPE]?.limbStatus?.rLeg === undefined,
    JSON.stringify(rawFlags(dirty)?.[SCOPE]));
  check("migration: a token with nothing to move is left alone (negative)",
    !rawFlags(clean)?.[SCOPE]?.limbStatus && !rawFlags(clean)?.[SCOPE]?.fleshLimbStatus,
    JSON.stringify(rawFlags(clean)));
  check("migration: no literal `-=` key was persisted anywhere it wrote",
    !JSON.stringify(migWorld._source.flags ?? {}).includes("-=")
    && !JSON.stringify(dirty.delta?._source ?? {}).includes("-="),
    `${JSON.stringify(migWorld._source.flags?.[SCOPE])} | ${JSON.stringify(rawFlags(dirty))}`);
  check("migration: the completion flag is stamped", game.settings.get(SCOPE, "fleshLimbStatusMigrated") === true,
    game.settings.get(SCOPE, "fleshLimbStatusMigrated"));
  const beforeSecond = JSON.stringify([migWorld._source.flags?.[SCOPE], rawFlags(dirty), rawFlags(clean)]);
  await migrate({ force: true });
  await sleep(600);
  check("migration: running it again changes nothing (it is a move, not an accumulator)",
    JSON.stringify([migWorld._source.flags?.[SCOPE], rawFlags(dirty), rawFlags(clean)]) === beforeSecond,
    JSON.stringify([migWorld._source.flags?.[SCOPE], rawFlags(dirty), rawFlags(clean)]));
  for (const t of (scene?.tokens ?? []).filter(t => /^__PW__MIG/.test(t.name))) await scene.deleteEmbeddedDocuments("Token",[t.id]).catch(()=>{});
  await migWorld.delete().catch(()=>{});
  await migBase.delete().catch(()=>{});

  // cleanup + restore
  await actor.delete().catch(()=>{});
  await game.settings.set(SCOPE,"limbLossEnabled",prior.limb);
  await game.settings.set(SCOPE,"limbModel",prior.model);
  await game.settings.set(SCOPE,"cyberlimbRepairGmOnly",prior.gm);
  return out;
});

for (const l of r.checks) console.log(l);
const errs = errors.filter(e => !/screen resolution/i.test(e));
if (errs.length) console.log("errors:", errs.slice(0,5).join(" | "));
const pass = r.fails.length===0 && errs.length===0;
console.log(`\nRESULT: ${pass?"PASS":"FAIL"} ${r.checks.length-r.fails.length}/${r.checks.length}`);
await b.close();
process.exit(pass?0:1);
