/** Flesh-limb injury CLEAR + the GM DIRECT SETTER (M18 recovery, and its write-side twin). Verifies the
 *  full loop on :30004: a W4RST4R hit records fleshLimbStatus, the sheet shows a VISIBLE styled badge
 *  and a VISIBLE clear control (not the base's hover-only .segment-repair trap), a real click removes
 *  the flag and the badge/button vanish, the API is idempotent, and the GM-only gate governs it.
 *  §7 adds the direct setter: a GM picks a recorded state from the limb's own display with the damage
 *  pipeline out of the loop — closed value domain, real gesture, write byte-identical to a pipeline
 *  write, sibling-safe clear, unlinked-token routing. The non-GM negative runs in a SECOND client.
 *  Needs an active scene (see test-harness). */
import { chromium } from "@playwright/test";
const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
async function joinGM(p){await p.goto(BASE+"/join",{waitUntil:"domcontentloaded"});const s=p.locator('select[name="userid"]');await s.waitFor({state:"visible",timeout:30000});const us=await s.locator("option").evaluateAll(o=>o.map(x=>({v:x.value,l:(x.textContent||"").trim()})).filter(x=>x.v));const g=us.find(u=>/gamemaster/i.test(u.l))||us[0];await s.selectOption(g.v);await p.locator('input[name="password"]').fill(PW);await Promise.all([p.waitForNavigation({url:/\/game/,timeout:45000}).catch(()=>{}),p.locator('button[name="join"]').click()]);await p.waitForFunction(()=>window.game?.ready===true,undefined,{timeout:60000});}

/** Join as a NON-GM user (the standing "Test User 1" fixture), trying each candidate password. */
async function joinAs(page, match, passwords) {
  await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const sel = page.locator('select[name="userid"]');
  await sel.waitFor({ state: "visible", timeout: 30000 });
  const users = await sel.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  const u = users.find(x => match.test(x.l));
  if (!u) throw new Error("no user matching " + match);
  for (const pw of passwords) {
    await sel.selectOption(u.v);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([
      page.waitForNavigation({ url: /\/game/, timeout: 15000 }).catch(() => {}),
      page.locator('button[name="join"]').click(),
    ]);
    try { await page.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 15000 }); return u.l; }
    catch { await page.goto(BASE + "/join", { waitUntil: "domcontentloaded" }).catch(() => {}); await sel.waitFor({ state: "visible" }).catch(() => {}); }
  }
  throw new Error("could not join as " + u.l);
}

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
  const openSheet = async (a) => { await a.sheet.render(true); await sleep(900);
    const root = a.sheet.element;
    root?.querySelector?.('.sheet-tabs [data-tab="combat"], a[data-tab="combat"]')?.click?.(); await sleep(500);
    root.querySelector(".armor-display")?.scrollIntoView({block:"center"}); await sleep(300); return root; };
  const open = () => openSheet(actor);
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

  // (7) THE GM DIRECT SETTER. The clear half above has existed since M18; the WRITE half was a console
  //     incantation only. These legs pin the ruled control: a closed value domain taken from the reader
  //     seam, a real gesture at the limb's own display, a record indistinguishable from a pipeline
  //     write, a sibling-safe clear, and correct document routing for an unlinked token.
  const norm = m => JSON.stringify(Object.keys(m ?? {}).sort().map(k => [k, m[k]]));
  const setActor = await Actor.create({ name:"__PW__FleshSet", type:"character" });
  await setActor.update({ "system.damage":0, "system.stats.bt.value":2 });

  // 7a. the offered domain is exactly what the reader seam recognizes — no invented state string
  const opts = CL.fleshLimbStateOptions?.() ?? [];
  check("setter: the offered state domain is exactly the recorded-state vocabulary",
    JSON.stringify(opts.map(o => o.value)) === JSON.stringify(["crippled","destroyed","disabled","severed"]),
    opts.map(o => o.value));
  check("setter: every offered state carries a resolved label (no raw CYBERPUNK. key)",
    opts.length === 4 && opts.every(o => !!o.label && !/^CYBERPUNK\./.test(o.label)), opts);

  // 7b. pipeline fixture on rArm — the comparison baseline for the parity leg
  await DA.applyAreaDamages({ target: setActor, areaDamages: { rArm:[{ damage:30 }] } });
  await sleep(500);
  const pipeEntry = (setActor.getFlag(SCOPE,"fleshLimbStatus")??{}).rArm;
  check("setter fixture: the pipeline recorded rArm", pipeEntry === "severed", pipeEntry);

  // 7c. the REAL GESTURE on a second, untouched zone
  let sroot = await openSheet(setActor);
  const setBtn = sroot.querySelector('.cp-flesh-set[data-zone="lArm"]');
  const sv = vis(setBtn);
  check("sheet: a GM sees the state-set control on an unrecorded flesh limb zone, visible at rest",
    !!sv && sv.visible && sv.w > 0, sv);
  check("sheet: the state-set control is NOT offered on a non-limb zone (negative)",
    !sroot.querySelector('.cp-flesh-set[data-zone="Torso"]') && !sroot.querySelector('.cp-flesh-set[data-zone="Head"]'), null);
  setBtn?.click(); await sleep(800);
  const dlg = document.querySelector(".cp-flesh-state-dialog");
  check("gesture: the control opens a state picker", !!dlg, !!dlg);
  const sel = dlg?.querySelector("select.cp-flesh-state-pick");
  const optVals = [...(sel?.options ?? [])].map(o => o.value);
  check("picker: the rows are a clear row plus exactly the recorded states",
    JSON.stringify(optVals) === JSON.stringify(["","crippled","destroyed","disabled","severed"]), optVals);
  if (sel) { sel.value = "severed"; sel.dispatchEvent(new Event("change", { bubbles: true }));
    dlg.closest(".application")?.querySelector('button[data-action="set"]')?.click(); await sleep(800); }
  const yesBtn = [...document.querySelectorAll('button[data-action="yes"]')].pop();
  check("gesture: a limb-loss state raises a confirmation step before anything is written", !!yesBtn, !!yesBtn);
  const confirmText = yesBtn?.closest(".application")?.textContent ?? "CYBERPUNK.missing";
  check("gesture: the confirmation text is localized (no raw key leak)", !/CYBERPUNK\./.test(confirmText), confirmText.slice(0,140));
  yesBtn?.click();
  for (let i=0;i<40 && !(setActor.getFlag(SCOPE,"fleshLimbStatus")??{}).lArm; i++) await sleep(150);
  const gmEntry = (setActor.getFlag(SCOPE,"fleshLimbStatus")??{}).lArm;
  check("gesture: the GM-chosen state is recorded on the chosen zone", gmEntry === "severed", gmEntry);

  // 7d. PARITY — a GM-written entry and a pipeline-written entry are indistinguishable downstream
  check("parity: the GM-written entry equals the pipeline-written one, same primitive type",
    gmEntry === pipeEntry && typeof gmEntry === "string" && typeof pipeEntry === "string", [gmEntry, pipeEntry]);
  const srcMap = foundry.utils.deepClone(setActor._source.flags?.[SCOPE]?.fleshLimbStatus ?? {});
  check("parity: the STORED record holds both zones and nothing else",
    norm(srcMap) === norm({ rArm:"severed", lArm:"severed" }), srcMap);
  const CLmod = await import("/modules/cp2020-augmented/module/utils.js");
  check("parity: the reader seam answers the same for both zones",
    CLmod.getLimbStatus(setActor,"lArm") === CLmod.getLimbStatus(setActor,"rArm"),
    [CLmod.getLimbStatus(setActor,"lArm"), CLmod.getLimbStatus(setActor,"rArm")]);

  // 7e. and the sheet renders them identically
  await setActor.sheet.close().catch(()=>{}); sroot = await openSheet(setActor);
  const rowOf = z => sroot.querySelector(`.cp-flesh-clear[data-zone="${z}"]`)?.closest(".segment-status-row");
  const bL = vis(rowOf("lArm")?.querySelector(".segment-limb-status.cp-limb-flesh"));
  const bR = vis(rowOf("rArm")?.querySelector(".segment-limb-status.cp-limb-flesh"));
  check("render parity: the GM-set zone badge matches the pipeline-set zone badge in text and colour",
    !!bL && !!bR && bL.visible && bL.text === bR.text && bL.bg === bR.bg, [bL, bR]);

  // 7f. CLEAR one zone — the sibling entry survives (flag objects MERGE on write; a whole-object
  //     rewrite or the wrong deletion form would resurrect or drop the other limb)
  sroot.querySelector('.cp-flesh-clear[data-zone="lArm"]')?.click();
  for (let i=0;i<40 && (setActor.getFlag(SCOPE,"fleshLimbStatus")??{}).lArm; i++) await sleep(150);
  const afterClear = foundry.utils.deepClone(setActor._source.flags?.[SCOPE]?.fleshLimbStatus ?? {});
  check("clear: the cleared zone is gone and the SECOND zone is untouched",
    afterClear.lArm === undefined && afterClear.rArm === "severed", afterClear);
  check("clear: no literal `-=` key was persisted",
    !JSON.stringify(setActor._source.flags ?? {}).includes("-="), JSON.stringify(setActor._source.flags?.[SCOPE]));
  await setActor.sheet.close().catch(()=>{});

  // 7g. the domain is CLOSED at the API too
  const bogus = await CL.setFleshLimbState?.(setActor, "lLeg", "vaporized");
  check("API: an unrecognized state string is refused and writes nothing",
    bogus === false && (setActor.getFlag(SCOPE,"fleshLimbStatus")??{}).lLeg === undefined, bogus);
  const headSet = await CL.setFleshLimbState?.(setActor, "Head", "severed");
  check("API: a non-limb zone is refused and writes nothing",
    headSet === false && (setActor.getFlag(SCOPE,"fleshLimbStatus")??{}).Head === undefined, headSet);
  const repeat = await CL.setFleshLimbState?.(setActor, "rArm", "severed");
  check("API: re-setting the state already recorded is a no-op", repeat === false, repeat);

  // 7h. UNLINKED TOKEN — the sheet's own actor reference must route the write to the token DELTA
  const tScene = game.scenes.active ?? game.scenes.viewed;
  for (const t of (tScene?.tokens ?? []).filter(t => /^__PW__FleshSetTok/.test(t.name))) await tScene.deleteEmbeddedDocuments("Token",[t.id]).catch(()=>{});
  for (const a of game.actors.filter(a => a.name === "__PW__FleshSetBase")) await a.delete().catch(()=>{});
  const tBase = await Actor.create({ name:"__PW__FleshSetBase", type:"character" });
  const [tMade] = await tScene.createEmbeddedDocuments("Token", [
    { actorId: tBase.id, actorLink:false, name:"__PW__FleshSetTok", x:1400, y:1400, width:1, height:1 }]);
  const tTok = tScene.tokens.get(tMade.id);
  const synth = tTok.actor;
  await synth.sheet.render(true); await sleep(1100);
  const troot = synth.sheet.element;
  troot?.querySelector?.('.sheet-tabs [data-tab="combat"], a[data-tab="combat"]')?.click?.(); await sleep(500);
  const tBtn = troot.querySelector('.cp-flesh-set[data-zone="rLeg"]');
  check("unlinked: the state-set control renders on the token's own sheet", !!tBtn, !!tBtn);
  tBtn?.click(); await sleep(800);
  const tdlg = document.querySelector(".cp-flesh-state-dialog");
  const tsel = tdlg?.querySelector("select.cp-flesh-state-pick");
  if (tsel) { tsel.value = "severed"; tsel.dispatchEvent(new Event("change", { bubbles:true }));
    tdlg.closest(".application").querySelector('button[data-action="set"]').click(); await sleep(800);
    [...document.querySelectorAll('button[data-action="yes"]')].pop()?.click(); }
  for (let i=0;i<40 && !((tTok.delta?._source?.flags ?? {})[SCOPE]?.fleshLimbStatus?.rLeg); i++) await sleep(150);
  const tDelta = foundry.utils.deepClone(tTok.delta?._source?.flags ?? {});
  check("unlinked: the record lands on the token DELTA",
    tDelta?.[SCOPE]?.fleshLimbStatus?.rLeg === "severed", JSON.stringify(tDelta?.[SCOPE]));
  check("unlinked: the WORLD actor behind the token is untouched (negative)",
    (tBase.getFlag(SCOPE,"fleshLimbStatus") ?? {}).rLeg === undefined, JSON.stringify(tBase._source.flags?.[SCOPE]));
  await synth.sheet.close().catch(()=>{});
  for (const t of (tScene?.tokens ?? []).filter(t => /^__PW__FleshSetTok/.test(t.name))) await tScene.deleteEmbeddedDocuments("Token",[t.id]).catch(()=>{});
  await tBase.delete().catch(()=>{});
  await setActor.delete().catch(()=>{});

  // 7i. hand a PLAYER-OWNED character to the second client for the non-GM negative (§8). Provisioned
  //     here rather than assumed: the rig's standing player fixture is not guaranteed on every world.
  for (const a of game.actors.filter(a => a.name === "__PW__FleshPlayer")) await a.delete().catch(()=>{});
  const player = game.users.find(u => /Test User 1/i.test(u.name)) ?? game.users.find(u => u.role === 1);
  const plActor = await Actor.create({ name:"__PW__FleshPlayer", type:"character",
    ownership: { default: 0, ...(player ? { [player.id]: 3 } : {}) } });
  out.playerFixtureId = plActor.id;

  // cleanup + restore
  await actor.delete().catch(()=>{});
  await game.settings.set(SCOPE,"limbLossEnabled",prior.limb);
  await game.settings.set(SCOPE,"limbModel",prior.model);
  await game.settings.set(SCOPE,"cyberlimbRepairGmOnly",prior.gm);
  return out;
});

// (8) NON-GM NEGATIVE, in a SECOND client. The setter is GM-only power: a player must neither see the
//     control on a sheet they own nor be able to drive the API behind it (an owned actor is writable by
//     that player, so only the gate stands between them and the record).
const pl = await b.newPage({ viewport: { width: 1400, height: 900 } });
pl.on("pageerror", e => errors.push("player pageerror: " + e.message));
pl.on("console", m => { if (m.type() === "error") errors.push("player console: " + m.text()); });
await joinAs(pl, /Test User 1/i, ["", PW]);
const rp = await pl.evaluate(async (fixtureId) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = { checks: [], fails: [] };
  const check = (n, ok, got) => { out.checks.push(`${ok?"  PASS":"  FAIL"}  ${n}${ok?"":"  got="+JSON.stringify(got)}`); if(!ok) out.fails.push(n); };
  const SCOPE = "cp2020-augmented";
  const CL = await import("/modules/cp2020-augmented/module/mech/cyberlimb.js");
  check("player: this client is not a GM", game.user?.isGM === false, game.user?.isGM);
  const owned = game.actors.get(fixtureId);
  check("player fixture: the provisioned character is owned by this non-GM client",
    !!owned && owned.isOwner === true, [owned?.name, owned?.isOwner]);
  if (!owned?.isOwner) return out;
  check("player: the eligibility map is empty for a non-GM (negative)",
    Object.keys(CL.fleshLimbSetZones?.(owned) ?? { blocked: true }).length === 0, CL.fleshLimbSetZones?.(owned));
  await owned.sheet.render(true); await sleep(1200);
  const root = owned.sheet.element;
  root?.querySelector?.('.sheet-tabs [data-tab="combat"], a[data-tab="combat"]')?.click?.(); await sleep(500);
  check("player: the state-set control is absent from the rendered sheet (negative)",
    root.querySelectorAll(".cp-flesh-set").length === 0, root.querySelectorAll(".cp-flesh-set").length);
  const before = JSON.stringify(owned.getFlag(SCOPE, "fleshLimbStatus") ?? {});
  const ret = await CL.setFleshLimbState?.(owned, "rArm", "severed");
  await sleep(600);
  const after = JSON.stringify(owned.getFlag(SCOPE, "fleshLimbStatus") ?? {});
  check("player: the API refuses the write even on an OWNED actor, and the record is unchanged",
    ret === false && after === before, [ret, before, after]);
  await owned.sheet.close().catch(()=>{});
  return out;
}, r.playerFixtureId);

// tear the player fixture down from the GM client (a player cannot delete a world actor)
await p.evaluate(async () => {
  for (const a of game.actors.filter(a => a.name === "__PW__FleshPlayer")) await a.delete().catch(()=>{});
}).catch(()=>{});

const checks = [...r.checks, ...rp.checks];
const fails = [...r.fails, ...rp.fails];
for (const l of checks) console.log(l);
const errs = errors.filter(e => !/screen resolution/i.test(e));
if (errs.length) console.log("errors:", errs.slice(0,5).join(" | "));
const pass = fails.length===0 && errs.length===0;
console.log(`\nRESULT: ${pass?"PASS":"FAIL"} ${checks.length-fails.length}/${checks.length}`);
await b.close();
process.exit(pass?0:1);
