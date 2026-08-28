/**
 * KEEPER: the shot pattern — caliber-driven placement, per-shell resolution, and zone lifecycle.
 *
 * The mechanism under test is "a shotgun is an area weapon" (CP2020 p.108) expressed as a runtime
 * derivation rather than as a stored flag, plus the pattern region's whole life from placement to
 * deletion. Sections:
 *
 *  §1 the derivation, by value — every cell of the caliber × load matrix, including the gauge aliases
 *     and the two blanks, asserted on the pure function with no document in sight
 *  §2 the seam payload carries the cartridge (without it §1 has nothing to read at fire time)
 *  §3 the either/or: a shell payload leaves the single-target flow alone (no damage dialog, no queued
 *     payload, no apply button on its card) and a slug payload does not
 *  §4 placement — ONE region per burst, GM-only, ghost look on the DRAWN object (core's own values are
 *     asserted first, so a core that stops using them fails here rather than silently)
 *  §5 per-shell, one card — N shells place once and resolve N banded rolls per contained token, by
 *     VALUE against a fixtured formula, with one confirm card and one result card
 *  §6 lifecycle — confirm deletes; a round advance expires an ignored pattern; the out-of-combat sweep
 *     expires one on the wall clock and leaves a fresh one alone
 *  §7 cover occlusion still exempts a token behind a wall
 *  §8 source guards — region.behaviors read as a Collection (.size), and no code path reads the stored
 *     spreadMode flag as the pattern decision any more
 *  §9 the load's per-hit riders travel with the pattern — the shock modifier and the over-time arming
 *     are recorded at placement and applied per landed shell at confirm, as the single-target flow does
 * §10 AIM, THEN DECLARE, THEN BANG, THEN APPLY — the placement-forward gesture driven as a real gesture:
 *     the fire control arms a corridor preview instead of a window, Esc cancels a shot that never
 *     happened (magazine by value), a confirm opens the modifiers window, the roll carries the corridor,
 *     the region is planted on the DECLARED axis rather than the target axis, and the shot ends in a
 *     RESOLUTION CARD — posted once the presentation is over, listing who the corridor caught, with the
 *     region still on the table and nothing applied until somebody presses its one Apply control
 * §11 the aim preview's ONE WHEEL — shift+wheel is the reach fine-tune (the band, the width and the
 *     banded damage all follow it), and the retired width gesture moves NOTHING: a plain wheel leaves
 *     the corridor exactly as it was, the state carries no width bias, and what survives the retirement
 *     is the load's own printed widths and the one-metre floor
 * §12 a pattern nobody applied KEEPS its card's pattern (the clocks are an orphan net, not a deadline)
 * §13 the save cadences — at Mortal BOTH saves are asked for, once each per application (the stun half
 *     moved onto the application's ledger by the 2026-08-27 ruling; see the note in the section): one death prompt per
 *     application batch, a stun prompt per damage event; plus the stabilized gate this rail now shares
 *     with the single-target one, and the p.105 rule that clears stabilization before either can read it
 * §14 a declared corridor can still MISS, and a miss goes to the grenade table — the rose, the drift, the
 *     re-derivation from the muzzle, and the two rails agreeing on where the shell landed
 * §15 WHICH FIGURE FIRED — the plant takes the corridor's origin from the figure the payload NAMES, not
 *     from the first figure on the canvas answering the shooter's actor id (two linked figures, an
 *     unlinked copy whose synthetic actor collides on that id, the unnamed fallback, and the drag-aim
 *     repro end to end), plus the source guard covering the two sibling placements
 * §16 THE BAND EDGES ARE THE FIRING WEAPON'S OWN RANGE, not fixed metres — the pure ladder by value at
 *     every rung out of three different guns, the point-blank metre, the saturation past full range,
 *     the compat edges a rangeless caller keeps, the load's printed widths, and the same aim point read
 *     two different ways through the real preview and through the plant
 * §17 A SCATTERED PATTERN SAYS SO — a forced miss driven through the real fire gesture raises exactly one
 *     notification naming the rolled direction and distance, and a shot that lands raises none
 * §18 WHO MAY END A SHOT — the pattern card's Apply/Clear controls answer to the firer's own user plus
 *     the two elevated roles (user ruling 2026-08-20). Runs across TWO clients, after the main run's
 *     teardown: the rule as a table, the firer recorded on both the pattern and its card, a GM keeping
 *     both controls on either corridor, and a player who sees the card but no controls on somebody
 *     else's — with a forged call to the resolve entry point refused and their own press still working
 *
 * ⛔ The three cover regions, the showcase combat and the four review targets on this rig belong to the
 * user's morning review; every fixture here is named __PWK__SPREAD and is deleted on the way out, and
 * the combat this spec needs is its own.
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(m.text())) errors.push(m.text()); });
page.on("pageerror", e => errors.push(e.message));

await page.goto(`${URL}/join`);
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const sel = document.querySelector('select[name="userid"]');
  sel.value = [...sel.options].find(o => /gamemaster/i.test(o.textContent)).value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 60000 });

const res = await page.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  const out = { checks: [] };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const scene = game.scenes.active;
  const lookup = await import(`/modules/${SCOPE}/module/lookups.js`);
  const hooks = await import(`/modules/${SCOPE}/module/combat/damage-hooks.js`);
  const look = await import(`/modules/${SCOPE}/module/combat/spread-zone-look.js`);
  const seam = await import(`/modules/${SCOPE}/module/seam-shim.js`);
  const areas = await import(`/modules/${SCOPE}/module/combat/area-shapes.js`);
  const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
  const scatterTable = await import(`/modules/${SCOPE}/module/combat/scatter-table.js`);
  // The corridor's VERDICT questions — the hit ruling and the scatter decision that reads it — live in
  // spread-geometry.js; scatter-table.js keeps the drift TABLE. `payloadScattersOnMiss` moved across on
  // 2026-08-26 when it started asking the ruling instead of re-comparing the roll against the DC.
  const geo = await import(`/modules/${SCOPE}/module/combat/spread-geometry.js`);
  // The fumble OUTCOME CLASS — which row of the base's Reflex (Combat) table was ruled. Its own home
  // (2026-08-26) because both rails read it and neither may derive it: the seam derives once, the
  // consumers switch on the carried field.
  const fumbleMod = await import(`/modules/${SCOPE}/module/combat/fumble-outcome.js`);
  // ⭐ THE BASE SYSTEM'S OWN PRODUCER, imported so the parse is asserted against REAL output rather than
  // against a fixture that agrees with it by construction. This is the module the class derivation reads.
  const baseUtils = await import("/systems/cyberpunk2020/module/utils.js");

  // SCOPE STATEMENT: this suite asserts the REGIONS shape — zone documents in scene.regions and the
  // Region-mesh look (§4 reads placeable meshes and shader uniforms that only exist on that backend).
  // On a core where the module's own detect picks MeasuredTemplates (the must-keep v13 platform),
  // this suite refuses loudly here instead of dying mid-eval on a placeable deref; that path is
  // covered by its own keeper (cp2020-augmented-spread-zone-v13.mjs).
  if (!areas.usesRegions()) {
    throw new Error("spread-zone suite asserts the Regions backend; this core uses MeasuredTemplates — run the -v13 keeper instead");
  }

  const mine = (r) => r?.flags?.[SCOPE]?.isSpreadZone === true;
  const myZones = () => [...(scene?.regions ?? [])].filter(mine);
  // ⚠ RE-READ THE COLLECTION IMMEDIATELY BEFORE EACH DELETE. This spec's own cleanup used to race the
  // deletes the flow itself performs — the resolution ends by deleting the pattern, and a wipe holding a
  // handle from before that call asked the server to delete a document that was already gone. The
  // rejection was caught, but the CORE still logged it, so the spec's own tidying was failing its own
  // 0-console-errors leg with a "Region does not exist" that had nothing to do with the mechanism under
  // test. One settle beat lets an in-flight delete land, then only ids the collection still holds are
  // asked for, one at a time.
  const wipeZones = async () => {
    await sleep(150);
    for (const r of myZones()) {
      if (!scene?.regions?.get?.(r.id)) continue;
      await r.delete().catch(() => {});
    }
    // A deleted pattern whose card is still open flips that card to CLEARED, and that write is an async
    // hook this loop does not await. Settling here keeps the teardown from deleting the card out from
    // under the write that is already in flight.
    await sleep(400);
  };
  /** The chat card a planted pattern records as its own, or null. */
  const cardOf = (zone) => game.messages.get(String(zone?.flags?.[SCOPE]?.cardMessageId ?? "")) ?? null;
  const wipeCards = async () => {
    for (const m of [...game.messages].filter(m => /cp-confirm-spread-zone|cp-spread-resolve-list|cp-spread-result-list/.test(m.content ?? ""))) await m.delete().catch(() => {});
  };
  await wipeZones();
  await wipeCards();

  /* ── §1  the derivation, by value ─────────────────────────────────────────────────────────── */
  const M = lookup.spreadModeForAmmo;
  ok("§1 00 buck standard → buck", M({ spreadMode: "single", caliber: "00", modifier: "standard" }) === "buck", M({ spreadMode: "single", caliber: "00", modifier: "standard" }));
  ok("§1 00 buck with NO stored spread field → buck", M({ caliber: "00" }) === "buck");
  ok("§1 gauge aliases normalize to the shell → buck", ["12ga", "20ga", "28ga", "10ga", "4ga", ".410ga", "CAL12"].every(c => M({ spreadMode: "single", caliber: c }) === "buck"));
  ok("§1 slug LOAD holds the shell off the pattern", M({ spreadMode: "slug", caliber: "00", modifier: "slug" }) === "single");
  ok("§1 slug by modifier id alone (stale spread field)", M({ spreadMode: "single", caliber: "00", modifier: "slug" }) === "single");
  ok("§1 slug by spread field alone", M({ spreadMode: "slug", caliber: "12ga", modifier: "" }) === "single");
  ok("§1 flechette shell keeps its own mode", M({ spreadMode: "flechette", caliber: "00", modifier: "flechette" }) === "flechette");
  ok("§1 flechette on a rifle cartridge still spreads", M({ spreadMode: "flechette", caliber: "10mm" }) === "flechette");
  ok("§1 rifle cartridge → single", M({ spreadMode: "single", caliber: "5.56", modifier: "ap" }) === "single");
  ok("§1 pistol cartridge → single", M({ spreadMode: "single", caliber: "9mm" }) === "single");
  ok("§1 arrow → single", M({ spreadMode: "single", caliber: "Arrow", modifier: "broadhead" }) === "single");
  ok("§1 BLANK caliber → single (no cartridge recorded, no pattern)", M({ spreadMode: "single", caliber: "" }) === "single" && M({}) === "single");
  ok("§1 unknown caliber → single", M({ caliber: "__nope__" }) === "single");
  ok("§1 buck loads keep their treatment (spread and load are orthogonal)",
    ["ap", "api", "hollowPoint", "stundart", "rubber", "safety", "brassCased", "dualPurpose"].every(m => M({ spreadMode: "single", caliber: "00", modifier: m }) === "buck"));
  ok("§1 slug modifier is registered on the shotgun family only",
    lookup.AMMO_MODIFIERS.slug?.families?.join() === "shotgun" && lookup.AMMO_MODIFIERS.slug?.mech?.spreadMode === "slug");
  ok("§1 slug is offered on a shell and NOT on a rifle round",
    lookup.modifiersForCaliber("00").some(([id]) => id === "slug") && !lookup.modifiersForCaliber("5.56").some(([id]) => id === "slug"));

  /* ── §2  the seam carries the cartridge ──────────────────────────────────────────────────── */
  // ⚠ SWEEP THE TOKENS BEFORE THE ACTORS, AND SWEEP THEM AT ALL. This opening used to clear stale
  // ACTORS only, which is not the same set: a run that never reaches its own cleanup (an aborted
  // process, a thrown leg) leaves its figures standing on the scene, and deleting the actor does not
  // take an unlinked token with it. The next run then plants its corridor across a previous run's
  // leftovers and reads three figures where its fixtures put one — which is a spec contaminating
  // itself, not a mechanism failing. Tokens first, by NAME, exactly as the cleanup at the bottom does.
  for (const t of [...(scene.tokens ?? [])].filter(t => t.name?.startsWith("__PWK__SPREAD"))) await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
  for (const a of [...game.actors].filter(a => a.name?.startsWith("__PWK__SPREAD"))) await a.delete().catch(() => {});
  // …and the encounter §6 builds for itself, for the same reason: an aborted run leaves it started and
  // the next run's out-of-combat sections would then read a world that is in combat.
  for (const c of [...game.combats].filter(c => c.name?.startsWith("__PWK__SPREAD"))) await c.delete().catch(() => {});
  await sleep(250);
  const shooter = await Actor.create({ name: "__PWK__SPREAD Shooter", type: "character" });
  const [buckAmmo] = await shooter.createEmbeddedDocuments("Item", [{
    name: "__PWK__SPREAD 00 Buck", type: "ammo",
    system: { caliber: "00", modifier: "standard", spreadMode: "single", spreadDamageMedium: "", spreadWidthMedium: 2 },
  }]);
  const [shell] = await shooter.createEmbeddedDocuments("Item", [{
    name: "__PWK__SPREAD Shell Gun", type: "weapon",
    system: { weaponType: "Shotgun", attackType: "Autoshotgun", ammoType: "12ga", damage: "3d6", range: 50, rof: 3, shots: 8, shotsLeft: 8, ammoItemId: buckAmmo.id },
  }]);
  const seamFields = seam.ammoEffectFields(shooter.items.get(shell.id));
  ok("§2 seam payload carries the loaded round's caliber", seamFields.caliber === "00", JSON.stringify({ caliber: seamFields.caliber, spreadMode: seamFields.spreadMode }));
  const [bareGun] = await shooter.createEmbeddedDocuments("Item", [{
    name: "__PWK__SPREAD Bare Shell Gun", type: "weapon",
    system: { weaponType: "Shotgun", ammoType: "12ga", damage: "3d6", range: 50, rof: 1, shots: 2, shotsLeft: 2 },
  }]);
  const bareFields = seam.ammoEffectFields(shooter.items.get(bareGun.id));
  ok("§2 with no ammo item, the WEAPON's own ammoType chambering stands in", bareFields.caliber === "12ga", JSON.stringify({ caliber: bareFields.caliber }));
  ok("§2 a bare pack shotgun therefore still throws a pattern", M(bareFields) === "buck", M(bareFields));
  // The shipped catalogue is the real input: every shell weapon records a gauge in ammoType and none
  // records a `caliber`, so a rule reading `caliber` off a weapon would have found nothing at a table.
  const shellPack = game.packs.get("cp2020-augmented.supplement-shotguns");
  const shellDocs = shellPack ? await shellPack.getDocuments() : [];
  const gauged = shellDocs.filter(d => String(d.system?.ammoType ?? "").trim());
  ok("§2 shipped shell weapons carry a gauge, and it resolves to the shell family",
    shellDocs.length > 0 && gauged.length >= shellDocs.length - 1 && gauged.every(d => M({ caliber: d.system.ammoType }) === "buck"),
    `${gauged.length}/${shellDocs.length} gauged`);
  ok("§2 the derived mode off a real seam read is buck", M(seamFields) === "buck");

  /* ── §3  the either/or: one flow or the other, never both ────────────────────────────────── */
  const [target] = await scene.createEmbeddedDocuments("Token", [{ name: "__PWK__SPREAD Target", actorId: (await Actor.create({ name: "__PWK__SPREAD Victim", type: "character" })).id, x: 700, y: 200, width: 1, height: 1 }]);
  const [shooterTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PWK__SPREAD Gunner", actorId: shooter.id, x: 300, y: 200, width: 1, height: 1, rotation: 0 }]);
  await sleep(300);

  const basePayload = (over = {}) => ({
    attackerId: shooter.id, weaponName: "__PWK__SPREAD Shell Gun", weaponId: shell.id,
    areaDamages: { Torso: [{ damage: 7 }] }, shotsFired: 1, shotsHit: 1,
    targetTokenId: target.id, fxTargetTokenId: target.id, firedByUserId: game.user.id,
    caliber: "00", modifier: "standard", spreadMode: "single",
    spreadDamageShort: "", spreadDamageMedium: "", spreadDamageLong: "",
    ...over,
  });

  // Does the single-target flow claim this payload? The claim it sets on the object IS the answer, and
  // it is the same object the pattern hook reads — so this asks the question without opening a window.
  const dialogsBefore = Object.values(ui.windows ?? {}).filter(w => w?.constructor?.name === "DamageDialog").length;
  // ⚠ SCOPED TO THIS EMISSION, NOT TO THE WORLD'S SCROLLBACK. This leg used to ask "does ANY card in
  // this world carry an apply payload whose cartridge is 00?" — a question about every shot ever fired
  // on the rig, not about the payload just raised. A SLUG shell is a 00 cartridge that is SUPPOSED to
  // carry one (it is the single-target flow's shot), so three legitimate slug cards on the review bench
  // turned this red and kept it red, with nothing wrong in the code. The contract is per-emission:
  // between this raise and the settle, the shell must flag NO card at all.
  const flaggedIdsBefore = new Set([...game.messages].filter(m => m.getFlag(SCOPE, "damagePayload")).map(m => m.id));
  const buckP = basePayload();
  Hooks.callAll("cyberpunk2020.weaponFired", buckP);
  await sleep(900);
  ok("§3 a shell payload is NOT claimed by the single-target flow", buckP.handled !== true, `handled=${buckP.handled}`);
  const dialogsAfterBuck = Object.values(ui.windows ?? {}).filter(w => w?.constructor?.name === "DamageDialog").length;
  ok("§3 no DamageDialog opened for the shell", dialogsAfterBuck === dialogsBefore, `${dialogsBefore}→${dialogsAfterBuck}`);
  const newlyFlagged = [...game.messages].filter(m => m.getFlag(SCOPE, "damagePayload") && !flaggedIdsBefore.has(m.id));
  ok("§3 the shell flagged no apply-button payload onto any card", newlyFlagged.length === 0,
    newlyFlagged.map(m => String(m.getFlag(SCOPE, "damagePayload")?.weaponName ?? "?")).join(" | "));
  ok("§3 the shell placed exactly ONE pattern", myZones().length === 1, String(myZones().length));

  await wipeZones();
  const slugP = basePayload({ modifier: "slug", spreadMode: "slug" });
  Hooks.callAll("cyberpunk2020.weaponFired", slugP);
  await sleep(900);
  ok("§3 a SLUG payload IS claimed by the single-target flow", !!slugP.handled, `handled=${slugP.handled}`);
  ok("§3 a slug places NO pattern", myZones().length === 0, String(myZones().length));
  for (const w of Object.values(ui.windows ?? {})) if (w?.constructor?.name === "DamageDialog") await w.close().catch(() => {});
  await wipeZones();

  // ⭐ THE THIRD CASE, WHICH USED TO BE NOBODY'S. Pre-existing defect, recorded as an open item until
  // this unit: with the pattern mechanic switched OFF the single-target gate stood down because the
  // cartridge derived to `buck`, and the pattern hook stood down because the setting said no — so a
  // shell payload was claimed by NEITHER flow. No apply window, no pattern, no damage at all. The
  // switch now lives in the one shared site both gates ask (lookups.js `spreadFlowModeOf`), so with the
  // mechanic off a shell is claimed by the ordinary flow exactly as a slug is. The setting is restored
  // in a `finally`, so a failing assertion cannot leave the user's world switched.
  const spreadWas = game.settings.get(SCOPE, "shotgunSpreadEnabled");
  let offP = null, offZones = null;
  try {
    await game.settings.set(SCOPE, "shotgunSpreadEnabled", false);
    offP = basePayload();
    Hooks.callAll("cyberpunk2020.weaponFired", offP);
    await sleep(900);
    offZones = myZones().length;
  } finally {
    await game.settings.set(SCOPE, "shotgunSpreadEnabled", spreadWas);
  }
  ok("§3 with the pattern SWITCHED OFF the shell is claimed by the ordinary flow — owned, not orphaned",
    !!offP.handled, `handled=${offP.handled}`);
  ok("§3 and with the mechanic off no pattern is placed either (negative)", offZones === 0, String(offZones));
  ok("§3 the world switch is back where this section found it",
    game.settings.get(SCOPE, "shotgunSpreadEnabled") === spreadWas, String(spreadWas));
  for (const w of Object.values(ui.windows ?? {})) if (w?.constructor?.name === "DamageDialog") await w.close().catch(() => {});
  await wipeZones();

  /* ── §4  placement: one region, GM-only, ghost look ──────────────────────────────────────── */
  await hooks._placeSpreadZone(basePayload({ shotsFired: 1 }));
  await sleep(500);
  const zone = myZones()[0];
  const zf = zone?.flags?.[SCOPE] ?? {};
  ok("§4 pattern created", !!zone, zone?.name);
  ok("§4 GM-only visibility", zone?.visibility === CONST.REGION_VISIBILITY.GAMEMASTER, String(zone?.visibility));
  ok("§4 orange fill colour on the document", String(zone?.color?.css ?? zone?.color).toLowerCase() === look.SPREAD_ZONE_LOOK.fillColor);
  ok("§4 flags carry band + shells + both clocks + the owning encounter",
    ["Short", "Medium", "Long"].includes(zf.band) && zf.shells === 1 && Number.isFinite(zf.createdRound) && zf.createdAt > 0 && typeof zf.combatId === "string",
    JSON.stringify({ band: zf.band, shells: zf.shells, createdRound: zf.createdRound, createdAt: !!zf.createdAt, combatId: zf.combatId }));
  ok("§4 Core's own banded damage default for the band that resolved",
    zf.dmgFormula === { Short: "4d6", Medium: "3d6", Long: "2d6" }[zf.band], `${zf.band} → ${zf.dmgFormula}`);
  // ⚠ THE EXPECTED BAND IS MEASURED, NOT TYPED (fixed 2026-08-16 — this leg was the suite's long-standing
  // "environmental" red). It used to assert "Medium", on the note that *"the lane is 20 m at this
  // scene's 5 m grid"*: a fact about ONE scene, written into a leg that runs on whatever scene the rig
  // is on. On a one-metre grid the same fixture lane is four metres, which is the Close row, so the leg
  // reported a defect that was really a difference of scenes. The INTENT survives — the geometry above
  // is pinned to a band this leg knows rather than to whatever the fixtures happened to land on — by
  // measuring the lane and asking the shared ladder, with no weapon range, exactly as the plant did.
  const laneTok = canvas.tokens.get(target.id) ?? null;
  const laneShooter = canvas.tokens.get(shooterTok.id) ?? null;
  const laneM = (laneTok && laneShooter)
    ? (await import(`/modules/${SCOPE}/module/vehicle/vehicle-grid.js`)).pixelsToMeters(scene,
        Math.hypot(laneTok.center.x - laneShooter.center.x, laneTok.center.y - laneShooter.center.y))
    : NaN;
  ok("§4 the fixture lane resolves to the band its own measured distance earns, by value",
    zf.band === lookup.spreadBandSpec(laneM).band,
    `${laneM.toFixed(2)}m → expected ${lookup.spreadBandSpec(laneM).band}, got ${zf.band}`);
  ok("§4 behaviors read as a Collection (.size, never .length)", zone?.behaviors?.size === 0 && zone?.behaviors?.length === undefined,
    `size=${zone?.behaviors?.size} length=${zone?.behaviors?.length}`);

  // The ghost, on the DRAWN object. Core's values are asserted first on a region that is NOT ours, so a
  // core release that stops using 0.5 / hatch fails here by name rather than leaving us tuning a ghost
  // against something that already changed.
  const placeable = canvas.regions.placeables.find(p => p.document.id === zone.id);
  const meshOf = (obj) => [...(canvas.regions._highlights?.children ?? [])].find(m => m.region === obj);
  const otherPlaceable = canvas.regions.placeables.find(p => !mine(p.document));
  const otherMesh = otherPlaceable ? meshOf(otherPlaceable) : null;
  ok("§4 core still draws an untouched region at alpha 0.5 with the hatch on",
    !otherMesh || (otherMesh.alpha === 0.5 && otherMesh.shader.uniforms.hatchEnabled === true),
    otherMesh ? `${otherMesh.alpha} hatch=${otherMesh.shader.uniforms.hatchEnabled}` : "no other region on scene");
  const ghostMesh = meshOf(placeable);
  ok("§4 our pattern is ghosted to the look's fill alpha", ghostMesh?.alpha === look.SPREAD_ZONE_LOOK.fillAlpha, String(ghostMesh?.alpha));
  ok("§4 the occluding hatch is off on our pattern", ghostMesh?.shader?.uniforms?.hatchEnabled === false, String(ghostMesh?.shader?.uniforms?.hatchEnabled));
  ok("§4 a thin outline is drawn on our pattern", !!placeable?.cpSpreadOutline && placeable.cpSpreadOutline.geometry?.graphicsData?.length > 0,
    `outline=${!!placeable?.cpSpreadOutline}`);
  ok("§4 the look values are the ruled ones", look.SPREAD_ZONE_LOOK.fillAlpha === 0.10 && look.SPREAD_ZONE_LOOK.hatch === false && look.SPREAD_ZONE_LOOK.outlineWidth === 2,
    JSON.stringify(look.SPREAD_ZONE_LOOK));
  // A refresh must not put core's treatment back — that is the whole reason the look is on two hooks.
  placeable.renderFlags.set({ refreshState: true });
  await sleep(200);
  ok("§4 the ghost survives a refresh (core re-asserts the hatch every time)",
    meshOf(placeable)?.shader?.uniforms?.hatchEnabled === false && meshOf(placeable)?.alpha === look.SPREAD_ZONE_LOOK.fillAlpha);
  await wipeZones();

  /* ── §5  per-shell, one card ─────────────────────────────────────────────────────────────── */
  await wipeCards();
  const msgBefore = game.messages.size;
  // A FIXTURED formula: "5" rolls exactly 5, so three shells must read 5, 5, 5 and never one roll ×3.
  await hooks._placeSpreadZone(basePayload({ shotsFired: 3, spreadDamageShort: "5", spreadDamageMedium: "5", spreadDamageLong: "5" }));
  await sleep(500);
  const burst = myZones()[0];
  ok("§5 a 3-shell burst places ONE pattern", myZones().length === 1, String(myZones().length));
  ok("§5 the pattern records the shell count", burst?.flags?.[SCOPE]?.shells === 3, String(burst?.flags?.[SCOPE]?.shells));
  ok("§5 the fixtured band formula is stored", burst?.flags?.[SCOPE]?.dmgFormula === "5");
  const confirmCards = [...game.messages].filter(m => (m.content ?? "").includes("cp-confirm-spread-zone"));
  ok("§5 ONE confirm card for the whole burst", confirmCards.length === 1, String(confirmCards.length));
  ok("§5 the card states the shell count", /3 shells/i.test(confirmCards[0]?.content ?? ""), (confirmCards[0]?.content ?? "").slice(0, 160));

  const hpBefore = Number(target.actor?.system?.damage ?? 0);
  // The real gesture: click the button on the rendered card, not the function behind it.
  const btn = document.querySelector(`[data-message-id="${confirmCards[0].id}"] .cp-confirm-spread-zone`);
  ok("§5 the confirm button is on the rendered card", !!btn);
  btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(2500);

  const resultCards = [...game.messages].filter(m => (m.content ?? "").includes("cp-spread-result-list"));
  ok("§5 ONE result card for the whole burst", resultCards.length === 1, String(resultCards.length));
  const resultText = resultCards[0]?.content ?? "";
  ok("§5 three shells rolled INDEPENDENTLY, by value (5, 5, 5)", /rolled 5, 5, 5 \(total 15\)/.test(resultText), resultText.replace(/<[^>]+>/g, " ").slice(0, 200));
  ok("§5 the AIMED-AT token is the one resolved against", /__PWK__SPREAD Target/.test(resultText), resultText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 220));
  ok("§5 exactly one token was in the lane (no bystander caught)", (resultText.match(/rolled /g) ?? []).length === 1, String((resultText.match(/rolled /g) ?? []).length));

  /* ── §6  lifecycle ──────────────────────────────────────────────────────────────────────── */
  ok("§6 confirm DELETES the pattern (count back to baseline)", myZones().length === 0, String(myZones().length));

  // ⛔ THE USER'S OWN ENCOUNTER IS NEVER TOUCHED — so this section BUILDS ITS OWN and starts it, rather
  // than borrowing whatever happens to be running. ⏪ REWRITTEN 2026-08-16 (vacuous-leg audit): the
  // previous version read `game.combats.active` and fell through to two free passes when nothing was
  // running. Nothing IS running on the certification rig (proved: `game.combats.active === null`, no
  // started encounter at all), so the live round-expiry legs had never once executed — a leg shaped
  // like coverage that tested nothing. An encounter this spec owns makes the live path unconditional.
  const priorCombat = game.combats.active ?? null;
  const encounter = await Combat.create({ name: "__PWK__SPREAD Encounter", scene: scene.id });
  await encounter.createEmbeddedDocuments("Combatant", [{ tokenId: shooterTok.id, sceneId: scene.id }]);
  // ⚠ ACTIVATE, not just start. The stamp the round rule reads is written from `game.combats.active`
  // (damage-hooks.js), which is the ACTIVE encounter — a started-but-not-activated one leaves the
  // pattern stamped with an empty combat id and the whole round rule out of reach. Cost this lane one
  // red on the first run of the rewritten section.
  await encounter.activate();
  await encounter.startCombat();
  await encounter.update({ round: 3 });
  await sleep(300);
  const showcase = game.combats.get(encounter.id);
  ok("§6 fixture: this section runs against an encounter it owns, started and on a known round " +
    "(guard against the free pass the skip branch used to hand out)",
    showcase?.started === true && showcase?.round === 3 && game.combats.active?.id === encounter.id,
    JSON.stringify({ started: showcase?.started, round: showcase?.round, isActive: game.combats.active?.id === encounter.id }));
  const RE = hooks.spreadZoneRoundExpired, CE = hooks.spreadZoneClockExpired;
  const asCombat = (id, round) => ({ id, round });
  ok("§6 round rule: the pattern's own encounter, a later round → expired",
    RE({ combatId: "C1", createdRound: 2 }, asCombat("C1", 3)) === true);
  ok("§6 round rule: the same round is still the pattern's round → kept",
    RE({ combatId: "C1", createdRound: 3 }, asCombat("C1", 3)) === false);
  ok("§6 round rule: ANOTHER encounter's round advancing never expires it",
    RE({ combatId: "C1", createdRound: 1 }, asCombat("C2", 9)) === false);
  ok("§6 round rule: a pattern thrown outside any encounter is not the round rule's business",
    RE({ combatId: "", createdRound: 0 }, asCombat("C1", 9)) === false);
  ok("§6 clock rule: fresh → kept, past the TTL → expired",
    CE({ createdAt: 1000 }, { now: 1000 + hooks.SPREAD_ZONE_TTL_MS - 1 }) === false
    && CE({ createdAt: 1000 }, { now: 1000 + hooks.SPREAD_ZONE_TTL_MS }) === true);
  ok("§6 clock rule: a pattern whose encounter is still running is the round rule's, whatever the clock says",
    CE({ createdAt: 0 }, { encounterRunning: true, now: Date.now() }) === false);
  ok("§6 clock rule: a pattern with no timestamp (pre-rule litter) is expired, not immortal",
    CE({}, { now: Date.now() }) === true);
  ok("§6 TTL constant is the documented minute", hooks.SPREAD_ZONE_TTL_MS === 60000, String(hooks.SPREAD_ZONE_TTL_MS));

  // LIVE round expiry — the real hook, the real handler, the showcase encounter's own unchanged round.
  await hooks._placeSpreadZone(basePayload());
  await sleep(400);
  const roundZone = myZones()[0];
  ok("§6 a pattern thrown during an encounter records that encounter and its round",
    roundZone?.flags?.[SCOPE]?.combatId === (showcase?.started ? showcase.id : "")
    && roundZone?.flags?.[SCOPE]?.createdRound === (game.combat?.round ?? 0),
    JSON.stringify({ combatId: roundZone?.flags?.[SCOPE]?.combatId, createdRound: roundZone?.flags?.[SCOPE]?.createdRound }));
  // Backdate the pattern by one round, then raise the round-advance hook with the encounter EXACTLY as
  // it stands. Nothing about the encounter is written; only the pattern moved. UNCONDITIONAL now.
  await roundZone.setFlag(SCOPE, "createdRound", (showcase.round ?? 1) - 1);
  // ⭐ THE ROUND RULE IS AN ORPHAN NET TOO (user ruling 2026-08-14), and this leg pair is where that
  // shows. ⏪ REALIGNED 2026-08-16: the round leg used to advance the round with the pattern's confirm
  // card STILL OPEN and expect a collection — the semantics from BEFORE the ruling. It read green for
  // months only because it never ran (no encounter on the rig ⇒ the skip branch's free pass). Both
  // halves are asserted now, in order: the open card holds the pattern back, and losing it lets go.
  Hooks.callAll("updateCombat", showcase, { round: showcase.round }, {}, game.user.id);
  await sleep(1200);
  ok("§6 a round advance does NOT collect a pattern whose card is still open — somebody has yet to answer it",
    myZones().length === 1, String(myZones().length));
  await cardOf(roundZone)?.delete()?.catch?.(() => {});
  await sleep(300);
  Hooks.callAll("updateCombat", showcase, { round: showcase.round }, {}, game.user.id);
  await sleep(1200);
  ok("§6 an ignored pattern expires when its own encounter's round advances", myZones().length === 0, String(myZones().length));
  ok("§6 the encounter is untouched by that (still started, same round)",
    showcase.started === true && showcase.round === (game.combats.get(showcase.id)?.round), `round=${showcase.round}`);
  await wipeZones();

  // LIVE clock expiry. A pattern thrown while the showcase encounter runs belongs to it, so the sweep
  // must leave it alone; clearing that ownership models a pattern thrown outside any encounter, which
  // is the only state the clock rule owns.
  await hooks._placeSpreadZone(basePayload());
  await sleep(400);
  const clockZone = myZones()[0];
  let swept = await hooks._sweepStaleSpreadZones();
  // ⏪ The `!showcase?.started ||` short-circuit that used to head this predicate is gone with the skip
  // branch: with an encounter this section owns, the real half is the only half.
  ok("§6 the sweep leaves a pattern owned by a running encounter alone",
    swept === 0 && myZones().length === 1, `swept=${swept} left=${myZones().length}`);
  await clockZone.setFlag(SCOPE, "combatId", "");
  swept = await hooks._sweepStaleSpreadZones();
  ok("§6 the sweep leaves a FRESH out-of-combat pattern alone", swept === 0 && myZones().length === 1, `swept=${swept} left=${myZones().length}`);
  await clockZone.setFlag(SCOPE, "createdAt", Date.now() - hooks.SPREAD_ZONE_TTL_MS - 1000);
  // ⭐ THE SWEEP IS AN ORPHAN NET, NOT A DEADLINE (user ruling 2026-08-14). Past the TTL it still leaves
  // a pattern whose card is open — that is a decision somebody has not made yet — and collects it only
  // once there is nobody left to ask. Both halves in one leg, so the count is unchanged.
  // ⏪ REALIGNED 2026-08-18: the collected half no longer demands OUR call be the one that counts the
  // delete. The module runs the same net on its own 15 s interval (SPREAD_ZONE_SWEEP_MS), and a tick
  // landing between the card delete and our manual sweep collects the orphan first — the manual call
  // then honestly reports 0 (twice-reproduced: whileOpen=0 afterCardGone=0 left=0). For a pattern with
  // no encounter and no card the net is the ONLY deleter, so "held while open + gone after" pins the
  // mechanism; whose tick counted it is scheduling, not behavior. The held half is now asserted on the
  // zone itself, not just the sweep's count.
  const sweptWhileOpen = await hooks._sweepStaleSpreadZones();
  const heldWhileOpen = myZones().length === 1;
  await cardOf(clockZone)?.delete()?.catch?.(() => {});
  await sleep(300);
  swept = await hooks._sweepStaleSpreadZones();
  await sleep(400);
  ok("§6 past the TTL the sweep keeps a pattern whose card is open and collects it once the card is gone",
    sweptWhileOpen === 0 && heldWhileOpen && myZones().length === 0,
    `whileOpen=${sweptWhileOpen} heldWhileOpen=${heldWhileOpen} manualSwept=${swept} left=${myZones().length}`);
  // Litter from the build that had no expiry at all carries neither flag, and must not be immortal. It
  // records no card either, so nobody can be asked about it and the net is the only thing that owns it.
  await hooks._placeSpreadZone(basePayload());
  await sleep(400);
  await myZones()[0].unsetFlag(SCOPE, "createdAt");
  await myZones()[0].setFlag(SCOPE, "combatId", "");
  await myZones()[0].unsetFlag(SCOPE, "cardMessageId");
  swept = await hooks._sweepStaleSpreadZones();
  await sleep(300);
  ok("§6 a pre-rule pattern with no timestamp and no card is swept", swept === 1 && myZones().length === 0, `swept=${swept} left=${myZones().length}`);

  // §6's own encounter is this section's fixture and dies with it; whatever was active before is put
  // back. Deleted here rather than at the bottom so the later sections run out of combat as they did.
  await encounter.delete().catch(() => {});
  if (priorCombat && game.combats.get(priorCombat.id)) await priorCombat.activate().catch(() => {});
  await sleep(300);
  ok("§6 teardown: the section's own encounter is gone and the world is back out of combat",
    !game.combats.get(encounter.id) && (game.combats.active?.id ?? null) === (priorCombat?.id ?? null),
    JSON.stringify({ stillThere: !!game.combats.get(encounter.id), active: game.combats.active?.id ?? null }));

  /* ── §7  untargeted aim + cover occlusion ───────────────────────────────────────────────── */
  // Token rotation 90 → canvas heading 180° → the shot points WEST. Chosen because it is the exact
  // opposite of the "due east" default this replaces, so the two cannot be confused by a near miss.
  await shooterTok.update({ rotation: 90 });
  await sleep(300);
  await hooks._placeSpreadZone(basePayload({ targetTokenId: null }));
  await sleep(400);
  const facingZone = myZones()[0];
  // The ray is built from the shooter's centre along its facing; assert the pattern's own geometry lies
  // BELOW the shooter rather than east of it, which is the pre-facing behaviour this replaces.
  const pts = facingZone?.shapes?.[0]?.points ?? [];
  const ys = []; for (let i = 1; i < pts.length; i += 2) ys.push(pts[i]);
  const xs = []; for (let i = 0; i < pts.length; i += 2) xs.push(pts[i]);
  const originY = Number(facingZone?.flags?.[SCOPE]?.originY ?? 0);
  const originX = Number(facingZone?.flags?.[SCOPE]?.originX ?? 0);
  ok("§7 an untargeted shell is aimed by the shooter's FACING, not due east",
    Math.min(...xs) < originX - 100 && Math.max(...xs) <= originX + 60
    && Math.abs(Math.max(...ys) - originY) < 200,
    `origin=(${originX},${originY}) xs=[${Math.min(...xs)}…${Math.max(...xs)}] ys=[${Math.min(...ys)}…${Math.max(...ys)}]`);
  await wipeZones();
  await shooterTok.update({ rotation: 0 });

  // Cover occlusion: a wall between shooter and target exempts it, so a pattern that contains the token
  // resolves against nobody. Uses this spec's own wall, deleted below.
  // ⭐ THE WALL IS DELIBERATELY UNVALUED (no cover flags), and since the 2026-08-25 soak ruling that is
  // the whole reason this leg still reads "exempt": a wall carrying `coverSp` would put the figure IN
  // the corridor with that SP folded outermost and would debit the wall's structure. This leg pins the
  // NAKED half of the split; the valued half and the barrier's own wear live in
  // cp2020-augmented-cover-area-soak.mjs.
  const occlusionOn = game.settings.get(SCOPE, "areaEffectOcclusion");
  const [wall] = await scene.createEmbeddedDocuments("Wall", [{ c: [500, 0, 500, 500] }]);
  await sleep(400);
  await wipeCards();
  await hooks._placeSpreadZone(basePayload({ spreadDamageShort: "5", spreadDamageMedium: "5", spreadDamageLong: "5" }));
  await sleep(400);
  const occZone = myZones()[0];
  await hooks._confirmSpreadZone(occZone.id);
  await sleep(1500);
  // ⏪ 2026-08-16 (vacuous-leg audit): the predicate used to open `!occlusionOn ||`, which handed the leg
  // a free pass on any world with the switch off. The switch's posture is now its own leg (it ships on,
  // and the rig runs it on), so the occlusion claim itself is unconditional.
  ok("§7 fixture: the occlusion switch is on, so the exemption below is the rule actually under test",
    occlusionOn === true, String(occlusionOn));
  ok("§7 a token behind a wall is exempted (no result card)",
    [...game.messages].filter(m => (m.content ?? "").includes("cp-spread-result-list")).length === 0,
    `occlusion=${occlusionOn}`);
  ok("§7 the pattern still vanishes when nobody was hit", myZones().length === 0, String(myZones().length));
  await scene.deleteEmbeddedDocuments("Wall", [wall.id]);

  /* ── §8  source guards ──────────────────────────────────────────────────────────────────── */
  const dhSrc = await (await fetch(`/modules/${SCOPE}/module/combat/damage-hooks.js`, { cache: "no-store" })).text();
  ok("§8 no code path reads payload.spreadMode as the pattern decision", !/payload\.spreadMode\s*(&&|!==|===)/.test(dhSrc));
  ok("§8 the derivation is called from BOTH sides of the either/or", (dhSrc.match(/if \(_spreadModeOf\(payload\)/g) ?? []).length === 2,
    String((dhSrc.match(/if \(_spreadModeOf\(payload\)/g) ?? []).length));
  ok("§8 no new code reads region.behaviors.length", !/behaviors[?.]*\.length/.test(dhSrc));
  // The structural half of the ownership fix: the world switch must be read in exactly ONE place, the
  // shared site both gates already ask. A second read here is how the two gates disagreed before.
  ok("§8 the damage rail no longer reads the pattern's world setting for itself",
    !/shotgunSpreadEnabled/.test(dhSrc));
  const lookupSrc = await (await fetch(`/modules/${SCOPE}/module/lookups.js`, { cache: "no-store" })).text();
  ok("§8 the switch lives in the shared flow site, which is what all three callers ask",
    /export function spreadFlowModeOf/.test(lookupSrc) && /shotgunSpreadEnabled/.test(lookupSrc));
  const fxSrc = await (await fetch(`/modules/${SCOPE}/module/fx/effects.js`, { cache: "no-store" })).text();
  ok("§8 the presentation rail asks that same site rather than deriving its own answer",
    /spreadFlowModeOf\(payload\)/.test(fxSrc) && !/shotgunSpreadEnabled/.test(fxSrc));
  const lookSrc = await (await fetch(`/modules/${SCOPE}/module/combat/spread-zone-look.js`, { cache: "no-store" })).text();
  ok("§8 the look keys off the flag, never a region name", /isSpreadZone/.test(lookSrc) && !/document\.name\s*===/.test(lookSrc));

  /* ── §9  the load's per-hit riders travel with the pattern ───────────────────────────────── */
  // The defect this section pins (review finding F7): a pattern carried the ARMOUR half of what a load
  // does and nothing else, so a 00 shell whose LOAD delivers shock or starts a burn lost that half the
  // moment RAW buckshot began routing through this flow. The single-target flow makes exactly two calls
  // for those riders (the shock-state write, then the over-time arming) and this flow now makes the same
  // two, once per landed shell — so the legs read the STATE those calls write, by value.
  const saves = await import(`/modules/${SCOPE}/module/combat/save-rolls.js`);
  const victim = target.actor;
  const zoneNow = () => myZones()[0];
  const flatFive = { spreadDamageShort: "5", spreadDamageMedium: "5", spreadDamageLong: "5" };
  const resetVictim = async () => {
    await victim.update({ "system.damage": 0 });
    await victim.unsetFlag(SCOPE, "taserState").catch(() => {});
    await victim.unsetFlag(SCOPE, "fireDotState").catch(() => {});
    await victim.unsetFlag(SCOPE, "dotState").catch(() => {});
  };
  // World settings the rider mechanics themselves are gated on: an inherited world state is not a
  // controlled fixture, so each is pinned here and restored in the finally.
  const riderWas = {
    taser: game.settings.get(SCOPE, "taserCumPenaltyEnabled"),
    fire: game.settings.get(SCOPE, "fireDotEnabled"),
    fireStack: game.settings.get(SCOPE, "fireDotStackMode"),
  };
  try {
    await game.settings.set(SCOPE, "taserCumPenaltyEnabled", true);
    await game.settings.set(SCOPE, "fireDotEnabled", true);
    await game.settings.set(SCOPE, "fireDotStackMode", "stack");

    /* §9a — a shock load: recorded at placement, applied per shell at confirm */
    await wipeZones(); await wipeCards(); await resetVictim();
    await hooks._placeSpreadZone(basePayload({
      modifier: "stundart", shotsFired: 2, ...flatFive,
      stunSaveOnHit: true, stunSaveMod: -2, effectTypes: ["Stun"],
    }));
    await sleep(500);
    const sf = zoneNow()?.flags?.[SCOPE] ?? {};
    ok("§9 a shock load's pattern records the rider fields, by value",
      sf.stunSaveOnHit === true && sf.stunSaveMod === -2 && Array.isArray(sf.effectTypes) && sf.effectTypes.includes("Stun"),
      JSON.stringify({ stunSaveOnHit: sf.stunSaveOnHit, stunSaveMod: sf.stunSaveMod, effectTypes: sf.effectTypes }));
    ok("§9 and records the over-time fields as the 'does nothing' values, not as absences (negative)",
      sf.dotEnabled === false && sf.dotTurns === 0 && sf.dotType === "acid" && sf.dotDamageFormula === "1d6",
      JSON.stringify({ dotEnabled: sf.dotEnabled, dotTurns: sf.dotTurns, dotType: sf.dotType }));

    const msgsBefore = new Set(game.messages.map(m => m.id));
    await hooks._confirmSpreadZone(zoneNow().id);
    await sleep(3000);
    const ts = victim.getFlag(SCOPE, "taserState");
    ok("§9 the confirm writes the shock rider ONCE PER SHELL, carrying the load's own modifier",
      ts?.count === 2 && ts?.mod === -2, JSON.stringify(ts ?? null));
    const newCards = [...game.messages].filter(m => !msgsBefore.has(m.id));
    ok("§9 a save prompt is posted for the shells that landed",
      newCards.some(m => (m.content ?? "").includes("cp-stun-save-roll")),
      newCards.map(m => (m.content ?? "").slice(0, 40)).join(" | ").slice(0, 160));
    // The modifier is not merely stored — it is what the save the table is about to roll asks for. Read
    // against the LIVE base (the shells that just landed moved the wound state too, so a base measured
    // before the confirm would have folded that drop into the rider's), with the rider then removed as
    // its own negative: the difference between the two readings is the rider and nothing else.
    const baseAfter = Math.max(1, victim.stunThreshold ? victim.stunThreshold() : 1);
    const withRider = saves.getStunThreshold(victim);
    await victim.unsetFlag(SCOPE, "taserState");
    const withoutRider = saves.getStunThreshold(victim);
    ok("§9 and that modifier really lowers the save threshold the prompt is posted with",
      withRider === Math.max(1, baseAfter - 2) && withoutRider === baseAfter && withRider < withoutRider,
      `base ${baseAfter}, with the rider ${withRider}, with it removed ${withoutRider}`);

    /* §9b — a burning load: the over-time effect is armed per shell */
    await wipeZones(); await wipeCards(); await resetVictim();
    await hooks._placeSpreadZone(basePayload({
      modifier: "api", shotsFired: 2, ...flatFive,
      dotEnabled: true, dotTurns: 2, dotType: "fire", dotDamageFormula: "1d6", effectTypes: ["DoT"],
    }));
    await sleep(500);
    const df = zoneNow()?.flags?.[SCOPE] ?? {};
    ok("§9 a burning load's pattern records the over-time fields, by value",
      df.dotEnabled === true && df.dotTurns === 2 && df.dotType === "fire" && df.dotDamageFormula === "1d6",
      JSON.stringify({ dotEnabled: df.dotEnabled, dotTurns: df.dotTurns, dotType: df.dotType }));
    await hooks._confirmSpreadZone(zoneNow().id);
    await sleep(3000);
    const burn = victim.getFlag(SCOPE, "fireDotState");
    const burnStates = Array.isArray(burn) ? burn : (burn ? [burn] : []);
    // Two shells arm two turns each under the pinned stacking mode — whether they land on one location
    // (one entry of 4) or two (two entries of 2), the total is the same number and that is what is read.
    ok("§9 the confirm arms the over-time effect once per landed shell",
      burnStates.length > 0 && burnStates.reduce((s, e) => s + Number(e.turnsLeft), 0) === 4
      && burnStates.every(e => String(e.formula) === "1d6"),
      JSON.stringify(burnStates));
    ok("§9 the burn is routed by its TYPE — the fire flag, not the armour-etching one (negative)",
      !victim.getFlag(SCOPE, "dotState"), JSON.stringify(victim.getFlag(SCOPE, "dotState") ?? null));

    /* §9c — a plain load carries neither, and the confirm adds neither */
    await wipeZones(); await wipeCards(); await resetVictim();
    await hooks._placeSpreadZone(basePayload({ shotsFired: 2, ...flatFive }));
    await sleep(500);
    const pf = zoneNow()?.flags?.[SCOPE] ?? {};
    ok("§9 a plain shell's pattern records both riders as inert (negative)",
      pf.stunSaveOnHit === false && pf.stunSaveMod === 0 && pf.dotEnabled === false && pf.dotTurns === 0
      && Array.isArray(pf.effectTypes) && pf.effectTypes.length === 0,
      JSON.stringify({ stun: pf.stunSaveOnHit, dot: pf.dotEnabled, effectTypes: pf.effectTypes }));
    await hooks._confirmSpreadZone(zoneNow().id);
    await sleep(3000);
    ok("§9 and its confirm arms neither mechanic — damage lands, nothing rides along (negative)",
      !victim.getFlag(SCOPE, "taserState") && !victim.getFlag(SCOPE, "fireDotState")
      && Number(victim.system?.damage ?? 0) > 0,
      JSON.stringify({ taser: victim.getFlag(SCOPE, "taserState") ?? null, burn: victim.getFlag(SCOPE, "fireDotState") ?? null, damage: victim.system?.damage }));
    // A pattern placed before this unit carries none of the new flags; it must still resolve, applying
    // the armour half and no riders, rather than throwing on a missing field.
    await wipeZones(); await wipeCards(); await resetVictim();
    await hooks._placeSpreadZone(basePayload({ shotsFired: 1, ...flatFive }));
    await sleep(400);
    const legacy = zoneNow();
    await legacy.update({ [`flags.${SCOPE}.-=stunSaveOnHit`]: null, [`flags.${SCOPE}.-=stunSaveMod`]: null,
      [`flags.${SCOPE}.-=dotEnabled`]: null, [`flags.${SCOPE}.-=dotTurns`]: null,
      [`flags.${SCOPE}.-=dotType`]: null, [`flags.${SCOPE}.-=dotDamageFormula`]: null });
    await sleep(200);
    await hooks._confirmSpreadZone(legacy.id);
    await sleep(2500);
    ok("§9 a pattern from before the riders existed still resolves, riders simply absent",
      myZones().length === 0 && Number(victim.system?.damage ?? 0) > 0
      && !victim.getFlag(SCOPE, "taserState") && !victim.getFlag(SCOPE, "fireDotState"),
      `damage ${victim.system?.damage}, zones ${myZones().length}`);
  } finally {
    await game.settings.set(SCOPE, "taserCumPenaltyEnabled", riderWas.taser);
    await game.settings.set(SCOPE, "fireDotEnabled", riderWas.fire);
    await game.settings.set(SCOPE, "fireDotStackMode", riderWas.fireStack);
    await resetVictim();
  }

  /* ── §10  AIM, THEN DECLARE, THEN BANG ───────────────────────────────────────────────────── */
  // The whole section is driven as the REAL gesture — the sheet's own fire control, synthetic pointer
  // events on the window, the modifiers form's own submit — because the thing under test is an ORDER,
  // and an order can only be observed by taking the steps in it. Every leg reads a value: the magazine,
  // the readout's text, the corridor on the payload, the planted region's own geometry.
  const placement = await import(`/modules/${SCOPE}/module/combat/spread-placement.js`);
  const grid = await import(`/modules/${SCOPE}/module/vehicle/vehicle-grid.js`);
  const dialogCount = () => Object.values(ui.windows ?? {}).filter(w => w?.constructor?.name === "ModifiersDialog").length;
  const closeModifiers = async () => {
    for (const w of Object.values(ui.windows ?? {})) if (w?.constructor?.name === "ModifiersDialog") await w.close().catch(() => {});
  };
  // World → client, through the stage's own transform, so a synthetic pointer event lands on the world
  // point this section means regardless of where the canvas happens to be panned.
  const toClient = (wx, wy) => {
    const p = canvas.stage.worldTransform.apply(new PIXI.Point(wx, wy));
    return { x: p.x, y: p.y };
  };
  const aimAt = async (wx, wy) => {
    const c = toClient(wx, wy);
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: c.x, clientY: c.y, bubbles: true }));
    await sleep(150);
    return c;
  };

  await wipeZones(); await wipeCards();
  // A single-shot shell gun, so the round count this section asserts on is 1 and not a fire mode's.
  const [oneShell] = await shooter.createEmbeddedDocuments("Item", [{
    name: "__PWK__SPREAD One-Shell Gun", type: "weapon",
    system: { weaponType: "Shotgun", attackType: "Shotgun", ammoType: "12ga", damage: "3d6", range: 50, rof: 1, shots: 8, shotsLeft: 8, ammoItemId: buckAmmo.id },
  }]);
  const aimGun = shooter.items.get(oneShell.id);
  const magazine = () => Number(shooter.items.get(oneShell.id)?.system?.shotsLeft);
  const sheet = shooter.sheet;
  await sheet.render(true);
  await sleep(800);

  ok("§10 the weapon answers the pattern question BEFORE it is fired, and answers 'buck'",
    lookup.weaponSpreadFlowMode(aimGun) === "buck", lookup.weaponSpreadFlowMode(aimGun));

  // The corridor this section aims: straight DOWN from the shooter, i.e. 90° away from the target token
  // that sits due east of it. Chosen so "the declared axis" and "the target axis" cannot be confused by
  // a near miss — a plant that ignored the declaration would point east instead. A second figure is put
  // down that line so the shot has somebody to resolve against, and the aim is taken at ITS centre,
  // which is also what exercises the overshoot rule by value.
  const shooterC = { x: shooterTok.x + 50, y: shooterTok.y + 50 };
  const aimReachPx = 300;
  const [downrange] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PWK__SPREAD Downrange", actorId: (await Actor.create({ name: "__PWK__SPREAD Downrange Actor", type: "character" })).id,
    x: shooterC.x - 50, y: shooterC.y + aimReachPx - 50, width: 1, height: 1,
  }]);
  await sleep(300);
  const aimWorld = { x: shooterC.x, y: shooterC.y + aimReachPx };
  const expectM = grid.pixelsToMeters(scene, aimReachPx);
  // The fixture gun's own Long range, which is what the band edges are fractions of (Core p.99) — the
  // same number the sheet hands the preview and the seam stamps on the payload. Named here so every
  // expectation in this section measures the aim against the ladder the gesture actually used.
  const aimGunRangeM = Number(oneShell.system?.range);
  const expectSpec = lookup.spreadBandSpec(expectM, { medium: 2 }, aimGunRangeM);
  const expectDmg = lookup.spreadBandDamage(expectSpec.band, {});
  // Half the aimed-at figure's own square, in metres — the overshoot the corridor is planted with.
  const expectOvershootM = grid.pixelsToMeters(scene, Number(canvas.dimensions.size)) / 2;

  /* §10a — the fire control ARMS AN AIM, and spends nothing */
  const magBefore = magazine();
  const dialogsBefore10 = dialogCount();
  const cancelGesture = sheet._cpOpenWeaponAttackDialog(aimGun);
  await sleep(400);
  ok("§10 the fire control on a spread weapon arms the aim preview", placement.spreadPreviewActive() === true);
  ok("§10 and opens NO modifiers window while the shooter is still aiming (negative)",
    dialogCount() === dialogsBefore10, `${dialogsBefore10}→${dialogCount()}`);
  ok("§10 the readout is on screen", !!document.querySelector(".cp-spread-preview-readout"));
  await aimAt(aimWorld.x, aimWorld.y);
  const readoutText = document.querySelector(".cp-spread-preview-readout")?.textContent ?? "";
  ok("§10 the readout quotes the band, the width and the load's damage, by value",
    readoutText === `${game.i18n.localize(`CYBERPUNK.SpreadBand${expectSpec.band}`)} band — ${expectSpec.widthM}m wide, ${expectDmg}`,
    `${readoutText} | expected band ${expectSpec.band} width ${expectSpec.widthM} dmg ${expectDmg}`);

  /* §10b — Esc cancels a shot that never happened */
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const cancelled = await cancelGesture;
  await sleep(300);
  ok("§10 Esc resolves the gesture as a cancel", cancelled === null, String(cancelled));
  ok("§10 the ghost and its readout are gone",
    placement.spreadPreviewActive() === false && !document.querySelector(".cp-spread-preview-readout"));
  ok("§10 NOTHING was spent — the magazine is untouched, by value", magazine() === magBefore, `${magBefore} → ${magazine()}`);
  ok("§10 no pattern was planted and no window opened by a cancelled aim (negative)",
    myZones().length === 0 && dialogCount() === dialogsBefore10, `zones=${myZones().length} windows=${dialogCount()}`);

  /* §10c — the single-target path is untouched, including its return type */
  const [pistolAmmo] = await shooter.createEmbeddedDocuments("Item", [{
    name: "__PWK__SPREAD 9mm", type: "ammo", system: { caliber: "9mm", modifier: "standard", spreadMode: "single" },
  }]);
  const [pistol] = await shooter.createEmbeddedDocuments("Item", [{
    name: "__PWK__SPREAD Pistol", type: "weapon",
    system: { weaponType: "Pistol", attackType: "Pistol", ammoType: "9mm", damage: "2d6", range: 50, rof: 1, shots: 8, shotsLeft: 8, ammoItemId: pistolAmmo.id },
  }]);
  const pistolReturn = sheet._cpOpenWeaponAttackDialog(shooter.items.get(pistol.id));
  await sleep(400);
  ok("§10 a single-target weapon still returns its dialog SYNCHRONOUSLY (not a promise)",
    pistolReturn?.constructor?.name === "ModifiersDialog", pistolReturn?.constructor?.name ?? String(pistolReturn));
  ok("§10 and arms no aim gesture at all (negative)", placement.spreadPreviewActive() === false);
  await closeModifiers();
  await sleep(300);

  /* §10d — a confirmed aim opens the window, and STILL spends nothing */
  let firedPayload = null;
  const spreadHookId = Hooks.on("cyberpunk2020.weaponFired", (p) => { if (!firedPayload) firedPayload = p; });
  const fireGesture = sheet._cpOpenWeaponAttackDialog(aimGun);
  await sleep(400);
  const clickAt = await aimAt(aimWorld.x, aimWorld.y);
  // Dispatched ON THE BOARD, not window: the aim listeners gate on ev.target being the game canvas
  // (spread-placement.js `_isCanvasEvent` — a sheet click must not place the corridor). This is the
  // same element a real click lands on.
  canvas.app.view.dispatchEvent(new PointerEvent("pointerdown", { clientX: clickAt.x, clientY: clickAt.y, button: 0, bubbles: true }));
  const fireDialog = await fireGesture;
  await sleep(600);
  ok("§10 confirming the corridor opens the ordinary modifiers window",
    fireDialog?.constructor?.name === "ModifiersDialog" && !!fireDialog?.element, fireDialog?.constructor?.name ?? String(fireDialog));
  ok("§10 and the magazine is STILL untouched at the moment of declaration, by value",
    magazine() === magBefore, `${magBefore} → ${magazine()}`);
  ok("§10 no pattern exists yet either — the region waits for the roll (negative)", myZones().length === 0, String(myZones().length));

  /* §10e — the roll commits, and the corridor rides it */
  // ⭐ THE SHOT IS FORCED TO LAND, and it has to be as of 2026-08-13: a declared corridor that MISSES
  // now scatters to the grenade table (§14), so a section whose subject is "the corridor is planted
  // and resolved exactly where the shooter declared it" has to pin the verdict or it is testing the
  // dice. Two halves, both restored afterwards: the fixture is given a competent REF, and the attack
  // die is queued at 9 (NOT 10 — the base die is `1d10x10`, so a forced maximum explodes forever).
  // 9 + REF 10 clears the Close DC of 15 with room to spare. The MISS half is §14's subject.
  const refWas = shooter.system.stats?.ref?.base;
  await shooter.update({ "system.stats.ref.base": 10 });
  const rollAt = Date.now();
  const origRU10 = CONFIG.Dice.randomUniform;
  CONFIG.Dice.randomUniform = (() => { const Q = [1 - (9 - 0.5) / 10]; return () => (Q.length ? Q.shift() : 0.5); })();
  const fireForm = fireDialog.element?.tagName === "FORM" ? fireDialog.element : fireDialog.element?.querySelector("form");
  if (fireForm?.requestSubmit) fireForm.requestSubmit();
  else fireForm?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await sleep(1500);
  CONFIG.Dice.randomUniform = origRU10;
  await shooter.update({ "system.stats.ref.base": refWas });
  ok("§10 the forced shot LANDED, so the corridor below is the declared one and not a scattered one",
    firedPayload?.attackTotal >= firedPayload?.toHitDC,
    `${firedPayload?.attackTotal} vs ${firedPayload?.toHitDC}`);
  const aimOnPayload = firedPayload?.spreadAim ?? null;
  ok("§10 the fired payload carries the confirmed corridor, by value",
    !!aimOnPayload && Math.abs(Number(aimOnPayload.angleDeg) - 90) < 0.5
    && Math.abs(Number(aimOnPayload.reachM) - expectM) < 0.01
    && Number(aimOnPayload.widthM) === expectSpec.widthM && aimOnPayload.band === expectSpec.band,
    JSON.stringify(aimOnPayload));
  ok("§10 the corridor is planted PAST the figure it was aimed at, by half that figure's own square",
    Math.abs(Number(aimOnPayload?.lengthM) - (Number(aimOnPayload?.reachM) + expectOvershootM)) < 0.01,
    `reach ${aimOnPayload?.reachM} + overshoot ${expectOvershootM} → planted ${aimOnPayload?.lengthM}`);
  ok("§10 the magazine is spent by the ROLL and by exactly one round, by value",
    magazine() === magBefore - 1, `${magBefore} → ${magazine()}`);
  ok("§10 the fired payload carries the WEAPON'S OWN RANGE, which the band edges are fractions of, by value",
    Number(firedPayload?.spreadRangeM) === aimGunRangeM,
    `${firedPayload?.spreadRangeM} vs the gun's ${aimGunRangeM}`);
  ok("§10 the pre-roll question and the fired payload's own derivation agree",
    lookup.weaponSpreadFlowMode(aimGun) === lookup.spreadFlowModeOf(firedPayload ?? {}),
    `${lookup.weaponSpreadFlowMode(aimGun)} / ${lookup.spreadFlowModeOf(firedPayload ?? {})}`);

  /* §10f — planted on the DECLARED axis, and nobody is asked to confirm it */
  const declaredZone = myZones()[0];
  const dz = declaredZone?.flags?.[SCOPE] ?? {};
  ok("§10 the pattern is planted", !!declaredZone, declaredZone?.name);
  ok("§10 it records that the corridor was DECLARED, not guessed", dz.declaredAim === true, String(dz.declaredAim));
  ok("§10 and that it landed where it was declared — no scatter on a hit (negative)",
    dz.scattered === false, String(dz.scattered));
  ok("§10 it is planted on the declared axis and geometry, by value",
    Math.abs(Number(dz.dirDeg) - 90) < 0.5 && Math.abs(Number(dz.lengthM) - Number(aimOnPayload.lengthM)) < 0.01
    && Number(dz.widthM) === expectSpec.widthM && dz.band === expectSpec.band,
    JSON.stringify({ dirDeg: dz.dirDeg, lengthM: dz.lengthM, widthM: dz.widthM, band: dz.band }));
  // The geometry itself, not just the recorded numbers: the corridor lies BELOW the shooter and reaches
  // nowhere near the target token due east of it — which is what a plant reading the target axis would
  // have drawn instead.
  const dPts = declaredZone?.shapes?.[0]?.points ?? [];
  const dXs = [], dYs = [];
  for (let i = 0; i < dPts.length; i += 2) { dXs.push(dPts[i]); dYs.push(dPts[i + 1]); }
  ok("§10 the drawn corridor runs down the declared line, not toward the target",
    Math.max(...dYs) > shooterC.y + aimReachPx - 20 && Math.max(...dXs) < shooterC.x + 120,
    `origin=(${shooterC.x},${shooterC.y}) xs=[${Math.min(...dXs).toFixed(0)}…${Math.max(...dXs).toFixed(0)}] ys=[${Math.min(...dYs).toFixed(0)}…${Math.max(...dYs).toFixed(0)}]`);
  ok("§10 and the damage has NOT landed yet — the pattern is still on the table mid-shot",
    myZones().length === 1 && [...game.messages].filter(m => (m.content ?? "").includes("cp-spread-result-list")).length === 0,
    `zones=${myZones().length}`);

  /* §10g — THE APPLY MOMENT: the shot ends in a card, and the card is what resolves it.
   *
   * ⭐ THE CONTRACT THIS SECTION USED TO HOLD IS THE ONE THAT CHANGED (user ruling). A declared corridor
   * used to apply its own damage the instant the presentation settled, with nobody left to press
   * anything; now the settle posts a RESOLUTION CARD listing who the corridor caught, the region stays
   * on the table underneath it, and one Apply control does the resolving. So the legs below read the
   * three states in order — card arrives and NOTHING has landed, the press lands it, the region goes. */
  const fxOn = game.settings.get(SCOPE, "combatFxEnabled");
  const resolveCards = () => [...game.messages].filter(m => (m.content ?? "").includes("cp-spread-resolve-list"));
  let cardAt = 0;
  for (let i = 0; i < 40 && !cardAt; i++) {
    await sleep(250);
    if (resolveCards().length) cardAt = Date.now();
  }
  ok("§10 the shot ends in ONE resolution card, posted with nobody pressing anything", resolveCards().length === 1,
    `${resolveCards().length} after ${Date.now() - rollAt}ms`);
  // The wait is the rail's own, so it is asserted against the rail's own floor rather than a figure
  // typed here. With the presentation switched off there is nothing to wait for and the leg says so.
  const floorMs = fxOn ? fx.payloadPresentationMs(firedPayload) : 0;
  // ⏪ 2026-08-16 (vacuous-leg audit): `!fxOn ||` used to head this predicate, so on a world with the
  // presentation switched off the wait leg passed without measuring anything. The switch ships on; its
  // posture is a leg of its own and the measurement is unconditional.
  ok("§10 fixture: the presentation switch is on, so there is a wait to measure at all", fxOn === true, String(fxOn));
  ok("§10 the card waited out the shot's presentation, not the trigger pull",
    (cardAt - rollAt) >= Math.min(floorMs, 400),
    `waited ${cardAt - rollAt}ms against a floor of ${floorMs}ms (presentation ${fxOn ? "on" : "off"})`);

  // NOTHING HAS BEEN APPLIED, and that is the whole of the restored moment: region still there, no
  // result card, the figure's own damage total still zero. Read as VALUES, so a card that quietly
  // applied anyway cannot pass this.
  const dmgBeforeApply = Number(downrange.actor?.system?.damage ?? 0);
  ok("§10 the pattern is STILL on the table while the card waits", myZones().length === 1, String(myZones().length));
  ok("§10 and nothing has landed yet — no result card, no damage on the figure, by value (negative)",
    [...game.messages].filter(m => (m.content ?? "").includes("cp-spread-result-list")).length === 0 && dmgBeforeApply === 0,
    `damage=${dmgBeforeApply}`);

  const resolveCard = resolveCards()[0];
  const resolveText = (resolveCard?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  ok("§10 the card lists the figure the corridor caught, and says it is in the pattern",
    /__PWK__SPREAD Downrange/.test(resolveText)
    && resolveText.includes(game.i18n.localize("CYBERPUNK.SpreadRowInPattern")),
    resolveText.slice(0, 220));
  ok("§10 and does NOT list the figure the corridor missed (negative)",
    !/__PWK__SPREAD Target/.test(resolveText), resolveText.slice(0, 220));
  ok("§10 the card quotes the corridor's own band and formula, by value",
    resolveText.includes(expectSpec.band) && resolveText.includes(expectDmg),
    `expected band ${expectSpec.band} dmg ${expectDmg} | ${resolveText.slice(0, 160)}`);
  ok("§10 the card states the p.108 basis rather than leaving the reader to know it",
    resolveText.includes(game.i18n.localize("CYBERPUNK.SpreadResolveBasis")),
    resolveText.slice(0, 240));
  ok("§10 no raw i18n key leaked onto the card (negative)", !/CYBERPUNK\./.test(resolveCard?.content ?? ""));
  // Counted in the CARD, not in the live DOM: core renders one message in more than one place (the log
  // and the notification strip), so a DOM count answers "how many times is this card on screen" rather
  // than "how many controls does this card carry", which is the contract.
  ok("§10 the card carries exactly ONE apply control, and it is the shared one",
    ((resolveCard?.content ?? "").match(/cp-confirm-spread-zone/g) ?? []).length === 1,
    String(((resolveCard?.content ?? "").match(/cp-confirm-spread-zone/g) ?? []).length));
  const applyBtn = document.querySelector(`[data-message-id="${resolveCard.id}"] .cp-confirm-spread-zone`);
  ok("§10 the control is on the rendered card and names the pattern it will resolve",
    applyBtn?.dataset?.templateId === declaredZone.id, `${applyBtn?.dataset?.templateId} / ${declaredZone.id}`);

  /* §10g(ii) — the press, and only the press, resolves it */
  applyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  let appliedAt = 0;
  for (let i = 0; i < 20 && !appliedAt; i++) {
    await sleep(250);
    if ([...game.messages].some(m => (m.content ?? "").includes("cp-spread-result-list"))) appliedAt = Date.now();
  }
  const declaredResults = [...game.messages].filter(m => (m.content ?? "").includes("cp-spread-result-list"));
  ok("§10 the apply resolves the shot — exactly ONE result card", declaredResults.length === 1, String(declaredResults.length));
  const declaredText = (declaredResults[0]?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  ok("§10 the figure standing in the DECLARED corridor is the one resolved against",
    /__PWK__SPREAD Downrange/.test(declaredText) && !/__PWK__SPREAD Target/.test(declaredText), declaredText.slice(0, 200));
  ok("§10 and the damage landed on it, by value",
    Number(downrange.actor?.system?.damage ?? 0) > 0, String(downrange.actor?.system?.damage));
  // The delete is the LAST thing the resolution does — after the result card — so the region is polled
  // for rather than read on the same beat the card appeared. A poll that never clears fails the leg.
  for (let i = 0; i < 20 && myZones().length; i++) await sleep(200);
  ok("§10 the region is gone once the apply has resolved it", myZones().length === 0, String(myZones().length));
  // The one-shot: a second press must not roll the burst a second time (card-lock + the confirm claim).
  applyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(1500);
  ok("§10 a second press resolves nothing — still one result card (negative)",
    [...game.messages].filter(m => (m.content ?? "").includes("cp-spread-result-list")).length === 1,
    String([...game.messages].filter(m => (m.content ?? "").includes("cp-spread-result-list")).length));
  await wipeZones(); await wipeCards();
  Hooks.off("cyberpunk2020.weaponFired", spreadHookId);
  await closeModifiers();
  await sheet.close().catch(() => {});

  /* §10h — the undeclared fallback is still alive, and the reader still gets a card */
  await hooks._placeSpreadZone(basePayload({ shotsFired: 1 }));
  await sleep(500);
  ok("§10 a shell nobody aimed is planted on a GUESSED corridor and says so",
    myZones()[0]?.flags?.[SCOPE]?.declaredAim === false, String(myZones()[0]?.flags?.[SCOPE]?.declaredAim));
  ok("§10 and it still posts the confirm card, because a guess is shown before it resolves",
    [...game.messages].filter(m => (m.content ?? "").includes("cp-confirm-spread-zone")).length === 1);
  await wipeZones(); await wipeCards();

  /* §10i — the declared-aim reader is strict, by value */
  const D = hooks.declaredSpreadAim;
  ok("§10 a payload with no corridor reads as none", D({}) === null && D({ spreadAim: null }) === null);
  ok("§10 a malformed corridor reads as none rather than being repaired",
    D({ spreadAim: { angleDeg: NaN, reachM: 5, lengthM: 5, widthM: 2 } }) === null
    && D({ spreadAim: { angleDeg: 0, reachM: 0, lengthM: 5, widthM: 2 } }) === null
    && D({ spreadAim: { angleDeg: 0, reachM: 5, lengthM: 5, widthM: 0 } }) === null);
  const goodAim = D({ spreadAim: { angleDeg: 12, reachM: 8, lengthM: 9, widthM: 2, band: "Medium" } });
  ok("§10 a good corridor reads back whole, by value",
    goodAim?.angleDeg === 12 && goodAim?.reachM === 8 && goodAim?.lengthM === 9 && goodAim?.widthM === 2 && goodAim?.band === "Medium",
    JSON.stringify(goodAim));
  ok("§10 a corridor with no band named derives one from its own reach",
    D({ spreadAim: { angleDeg: 0, reachM: 3, lengthM: 3, widthM: 1 } })?.band === "Short",
    D({ spreadAim: { angleDeg: 0, reachM: 3, lengthM: 3, widthM: 1 } })?.band);

  /* §10j — the band ladder is ONE derivation, read by both halves */
  const placeSrc = await (await fetch(`/modules/${SCOPE}/module/combat/spread-placement.js`, { cache: "no-store" })).text();
  ok("§10 the aim preview reads the shared band ladder rather than carrying its own",
    /spreadBandSpec/.test(placeSrc) && /spreadBandDamage/.test(placeSrc) && !/<=\s*6\b/.test(placeSrc));
  ok("§10 and the plant reads the same one", /spreadBandSpec/.test(dhSrc) && /spreadBandDamage/.test(dhSrc));
  ok("§10 the aim preview writes no document of its own (it is a client-local ghost)",
    !/createEmbeddedDocuments|\.update\(|setFlag/.test(placeSrc));

  /* ── §11  the aim preview's ONE WHEEL ────────────────────────────────────────────────────── */
  // ⏪⏪ THE WIDTH WHEEL IS RETIRED (2026-08-16), and its ABSENCE is the thing under test. The shotgun
  // table (Core p.109) states one width per range band and the band edges are fractions of the firing
  // weapon's own range (p.99), so a corridor's width is a FUNCTION of where it is pointed and never a
  // free knob — there was no book behind the ±1 m notch. What survives is everything the book does
  // state: the load's own printed `spreadWidth*` numbers, and the one-metre floor. SHIFT+wheel is
  // untouched: it is the reach fine-tune, and the band, the width and the banded damage all follow the
  // reach because all three are derived from it.
  //
  // Every leg reads the DERIVED consequence — the readout's sentence, then the confirmed corridor's own
  // numbers, then the planted region's own flag — rather than poking at the private state behind them.
  //
  // The preview is armed DIRECTLY rather than through the fire control, because this file spends nothing
  // and confirms into a plain object: no window opens, no roll is made, no round leaves the magazine, so
  // the section can confirm a corridor and read it back without disturbing anything.
  const shooterPlaceable = canvas.tokens.placeables.find(t => (t.document?.id ?? t.id) === shooterTok.id);
  const wheelMagBefore = magazine();
  // The off-board negative below reaches core's own zoom, so the board's position is noted and put back
  // at the end of the section — the user's review scene must not be left framed somewhere else.
  const viewBefore = { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
  // Dispatched ON THE BOARD: the wheel listener gates on ev.target being the game canvas
  // (spread-placement.js _isCanvasEvent), so a wheel over a sheet or the sidebar scrolls it as normal.
  const wheelOnBoard = async (deltaY, times = 1, shiftKey = false) => {
    for (let i = 0; i < times; i++) {
      canvas.app.view.dispatchEvent(new WheelEvent("wheel", { deltaY, shiftKey, bubbles: true, cancelable: true }));
    }
    await sleep(120);
  };
  const readout = () => document.querySelector(".cp-spread-preview-readout")?.textContent ?? "";
  // What the readout must SAY for a given reach — re-derived from the same shared ladder the preview
  // reads plus the floor, so this is a re-derivation of the rule rather than a copy of the sentence.
  // `widths` mirrors whatever the gesture under test was armed with; the previews below are armed
  // DIRECTLY and name no weapon range, so the ladder is asked without one here too.
  const widthFor = (reachM, widths = {}) =>
    Math.max(placement.SPREAD_MIN_WIDTH_M, lookup.spreadBandSpec(reachM, widths).widthM);
  const readoutFor = (reachM, widths = {}) => {
    const spec = lookup.spreadBandSpec(reachM, widths);
    return `${game.i18n.localize(`CYBERPUNK.SpreadBand${spec.band}`)} band — ${widthFor(reachM, widths)}m wide, ${lookup.spreadBandDamage(spec.band)}`;
  };

  /* §11a — a PLAIN wheel moves NOTHING: the retired gesture is gone, not merely capped */
  let wheelGesture = placement.armSpreadPreview({ shooterToken: shooterPlaceable });
  await sleep(300);
  await aimAt(aimWorld.x, aimWorld.y);           // cursor reach = 15m on this scene's grid → Medium band
  const baseReadout = readout();
  ok("§11 the wheel section starts on the band's own width", baseReadout === readoutFor(expectM),
    `${baseReadout} | expected ${readoutFor(expectM)}`);

  // ⚠ EVERY WHEEL NEGATIVE IS READ AFTER A RE-AIM, ON PURPOSE. A wheel the preview declines still reaches
  // CORE, which zooms the board with it — and a zoom moves the world point the (unmoved) cursor is over,
  // so the corridor's cursor-derived reach changes even though the preview added nothing. Re-aiming at
  // the same WORLD point cancels the zoom's contribution and leaves only the thing under test: whether
  // the gesture added a step of its own.
  for (let i = 0; i < 3; i++) document.body.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
  await sleep(200);
  await aimAt(aimWorld.x, aimWorld.y);
  ok("§11 a wheel that did not land on the board changes nothing at all (negative)",
    readout() === baseReadout, `${baseReadout} → ${readout()}`);

  // THE RETIREMENT, read as behaviour: notches ON the board, no shift held, in both directions — and the
  // sentence must come back byte-for-byte the band's own.
  await wheelOnBoard(-100, 4);
  await aimAt(aimWorld.x, aimWorld.y);
  ok("§11 four plain notches UP widen nothing — the corridor is still the band's, by value (negative)",
    readout() === readoutFor(expectM), `${readout()} | expected ${readoutFor(expectM)}`);
  await wheelOnBoard(100, 4);
  await aimAt(aimWorld.x, aimWorld.y);
  ok("§11 and four plain notches DOWN narrow nothing either (negative)",
    readout() === readoutFor(expectM), `${readout()} | expected ${readoutFor(expectM)}`);
  ok("§11 no width mark is ever appended, because no width is ever the table's any more (negative)",
    !readout().includes(game.i18n.localize("CYBERPUNK.SpreadWidthHouseMark")), readout());
  // Confirm and read the corridor back: the width is the band's and the reach is the cursor's.
  let wheelClick = await aimAt(aimWorld.x, aimWorld.y);
  canvas.app.view.dispatchEvent(new PointerEvent("pointerdown", { clientX: wheelClick.x, clientY: wheelClick.y, button: 0, bubbles: true }));
  let wheelAim = await wheelGesture;
  ok("§11 the confirmed corridor's WIDTH is the band's, with eight plain notches spent on it, by value",
    Number(wheelAim?.widthM) === widthFor(expectM), `${wheelAim?.widthM} vs the band's ${widthFor(expectM)}`);
  ok("§11 and its reach and band are the cursor's own (negative)",
    Math.abs(Number(wheelAim?.reachM) - expectM) < 0.01 && wheelAim?.band === lookup.spreadBandSpec(expectM).band,
    JSON.stringify({ reachM: wheelAim?.reachM, band: wheelAim?.band }));
  // End to end: what the region is planted with is the band's width too.
  await wipeZones(); await wipeCards();
  await hooks._placeSpreadZone(basePayload({ shotsFired: 1, spreadAim: wheelAim }));
  await sleep(500);
  ok("§11 the planted region carries the band's width, by value",
    Number(myZones()[0]?.flags?.[SCOPE]?.widthM) === widthFor(expectM),
    String(myZones()[0]?.flags?.[SCOPE]?.widthM));
  await wipeZones(); await wipeCards();
  // The state behind the readout carries no width bias at all — the field is GONE, not zeroed. The
  // house style keeps the removed handler as a commented revert at its old site, so the guard is that
  // every surviving mention of it is inside a comment rather than that the string is absent.
  const biasLines = placeSrc.split("\n").filter(l => /widthBiasM/.test(l));
  ok("§11 the retired width bias survives only as the commented revert, never as live code (negative, source)",
    biasLines.every(l => /^\s*(\*|\/\/|\/\*)/.test(l)),
    `${biasLines.length} mention(s): ${biasLines.map(l => l.trim().slice(0, 44)).join(" | ")}`);
  ok("§11 and the readout no longer marks any width as the table's (negative, source)",
    !/readout\.textContent\s*=\s*spec\.widthOverridden/.test(placeSrc)
    && !/widthOverridden:/.test(placeSrc.split("\n").filter(l => !/^\s*(\*|\/\/)/.test(l)).join("\n")),
    "widthOverridden in live preview code");

  /* §11b — WHAT SURVIVED THE RETIREMENT: the load's own printed widths, and the one-metre floor */
  const loadWidths = { short: 5, medium: 6, long: 7 };
  wheelGesture = placement.armSpreadPreview({ shooterToken: shooterPlaceable, widths: loadWidths });
  await sleep(300);
  await aimAt(aimWorld.x, aimWorld.y);
  // WHICH of the three printed numbers applies is the band's business, and the band is this scene's
  // metres — so the expectation is re-derived rather than typed, and the leg also pins that the number
  // taken is NOT the band's own default (which is what makes it a proof the override was read).
  const loadWidthHere = lookup.spreadBandSpec(expectM, loadWidths).widthM;
  ok("§11 a load's own printed width for this band is what the corridor is drawn at, by value",
    readout() === readoutFor(expectM, loadWidths) && readout().includes(`${loadWidthHere}m`)
    && loadWidthHere !== lookup.spreadBandSpec(expectM).widthM,
    `${readout()} | expected ${readoutFor(expectM, loadWidths)} (band default ${lookup.spreadBandSpec(expectM).widthM}m)`);
  wheelClick = await aimAt(aimWorld.x, aimWorld.y);
  canvas.app.view.dispatchEvent(new PointerEvent("pointerdown", { clientX: wheelClick.x, clientY: wheelClick.y, button: 0, bubbles: true }));
  wheelAim = await wheelGesture;
  ok("§11 and it is that printed width the corridor confirms at, by value",
    Number(wheelAim?.widthM) === loadWidthHere, `${wheelAim?.widthM} vs the load's printed ${loadWidthHere}`);

  wheelGesture = placement.armSpreadPreview({ shooterToken: shooterPlaceable, widths: { medium: 0.25 } });
  await sleep(300);
  await aimAt(aimWorld.x, aimWorld.y);
  ok("§11 a load printing a sliver of a width is floored at the ruled metre, by value",
    readout() === readoutFor(expectM, { medium: placement.SPREAD_MIN_WIDTH_M }),
    `${readout()} | expected width ${placement.SPREAD_MIN_WIDTH_M}`);
  wheelClick = await aimAt(aimWorld.x, aimWorld.y);
  canvas.app.view.dispatchEvent(new PointerEvent("pointerdown", { clientX: wheelClick.x, clientY: wheelClick.y, button: 0, bubbles: true }));
  wheelAim = await wheelGesture;
  ok("§11 and confirms at the floor rather than under it, by value",
    Number(wheelAim?.widthM) === placement.SPREAD_MIN_WIDTH_M, String(wheelAim?.widthM));
  ok("§11 the floor is the ruled one metre", placement.SPREAD_MIN_WIDTH_M === 1, String(placement.SPREAD_MIN_WIDTH_M));

  /* §11c — SHIFT+wheel is the reach fine-tune, and the band follows it */
  wheelGesture = placement.armSpreadPreview({ shooterToken: shooterPlaceable });
  await sleep(300);
  await aimAt(aimWorld.x, aimWorld.y);
  await wheelOnBoard(-100, 3, true);             // three steps further out
  ok("§11 three SHIFT steps push the reach out, and the width is still the band's",
    readout() === readoutFor(expectM + 3), `${readout()} | expected ${readoutFor(expectM + 3)}`);
  wheelClick = await aimAt(aimWorld.x, aimWorld.y);
  canvas.app.view.dispatchEvent(new PointerEvent("pointerdown", { clientX: wheelClick.x, clientY: wheelClick.y, button: 0, bubbles: true }));
  wheelAim = await wheelGesture;
  ok("§11 the confirmed corridor's REACH carries the shift wheel's steps, by value",
    Math.abs(Number(wheelAim?.reachM) - (expectM + 3)) < 0.01, `${expectM} + 3 → ${wheelAim?.reachM}`);
  ok("§11 and the band/width the reach derives travel with it",
    wheelAim?.band === lookup.spreadBandSpec(expectM + 3).band
    && wheelAim?.widthM === lookup.spreadBandSpec(expectM + 3).widthM,
    JSON.stringify({ band: wheelAim?.band, widthM: wheelAim?.widthM }));

  /* §11d — enough shift steps cross a band boundary, and the whole corridor changes with it */
  // ⚠ THE STEP COUNT IS DERIVED FROM THE SCENE, not typed. This preview is armed with no weapon range,
  // so its boundaries are the ladder's compat edges — and how many one-metre notches it takes to reach
  // the far one depends on how many metres a square is worth on the scene the rig happens to be on. A
  // hard-coded 11 was written against a 5 m grid and simply never crossed anything on a 1 m one.
  const stepsToLong = Math.ceil(lookup.SPREAD_LEGACY_MEDIUM_EDGE_M - expectM) + 1;
  wheelGesture = placement.armSpreadPreview({ shooterToken: shooterPlaceable });
  await sleep(300);
  await aimAt(aimWorld.x, aimWorld.y);
  await wheelOnBoard(-100, stepsToLong, true);
  ok("§11 crossing the band boundary re-derives the band, the width AND the formula, by value",
    readout() === readoutFor(expectM + stepsToLong) && lookup.spreadBandSpec(expectM + stepsToLong).band === "Long",
    `${readout()} | expected ${readoutFor(expectM + stepsToLong)} after ${stepsToLong} notches from ${expectM}m`);

  /* §11e — a shift wheel down pulls back, and stops at the plantable floor */
  // Far more steps down than there is corridor to give, counted from wherever §11d left the reach.
  await wheelOnBoard(100, stepsToLong + 40, true);
  ok("§11 pulling back stops at the shortest corridor the plant accepts, by value",
    readout() === readoutFor(placement.SPREAD_MIN_LENGTH_M), `${readout()} | expected ${readoutFor(placement.SPREAD_MIN_LENGTH_M)}`);
  wheelClick = await aimAt(aimWorld.x, aimWorld.y);
  canvas.app.view.dispatchEvent(new PointerEvent("pointerdown", { clientX: wheelClick.x, clientY: wheelClick.y, button: 0, bubbles: true }));
  wheelAim = await wheelGesture;
  ok("§11 and the floored corridor confirms at that floor rather than at the cursor, by value",
    Math.abs(Number(wheelAim?.reachM) - placement.SPREAD_MIN_LENGTH_M) < 0.01, String(wheelAim?.reachM));

  /* §11f — the reach bias is per-aim: a fresh gesture starts on the cursor's own distance again */
  wheelGesture = placement.armSpreadPreview({ shooterToken: shooterPlaceable });
  await sleep(300);
  await aimAt(aimWorld.x, aimWorld.y);
  ok("§11 a NEW aim starts on the cursor's own reach — the fine-tune does not outlive its gesture (negative)",
    readout() === readoutFor(expectM), `${readout()} | expected ${readoutFor(expectM)}`);
  placement.cancelSpreadPreview();
  await wheelGesture;
  await sleep(200);

  ok("§11 the whole section spent nothing — the magazine is untouched, by value",
    magazine() === wheelMagBefore, `${wheelMagBefore} → ${magazine()}`);
  ok("§11 and planted no pattern of its own beyond the one it wiped (negative)", myZones().length === 0, String(myZones().length));
  // The suppressive lane never had the retired bias and must not acquire one on the way out: its own
  // width is that lane's business (a zone the shooter sizes), not this ladder's.
  const suppSrc = await (await fetch(`/modules/${SCOPE}/module/combat/suppressive-placement.js`, { cache: "no-store" })).text();
  ok("§11 the suppressive preview carries no shot-pattern width bias either (negative)",
    !/widthBiasM/.test(suppSrc));
  await canvas.animatePan({ ...viewBefore, duration: 0 }).catch(() => {});
  await sleep(200);

  /* ── §12  an ignored resolution card KEEPS its pattern; an orphaned pattern does not ──────── */
  // ⭐ REVERSED BY THE 2026-08-14 RULING. The clocks used to take the pattern out from under an
  // unpressed card, which is what left the card's button resolving nothing. A card nobody has answered
  // is now a decision still owed and the pattern stays; the clock keeps only the patterns nobody can be
  // asked about. Driven on the wall clock, the rule that owns a pattern thrown outside an encounter.
  await wipeZones(); await wipeCards();
  await hooks._placeSpreadZone(basePayload({ shotsFired: 1 }));
  await sleep(400);
  const ignored = myZones()[0];
  await ignored.setFlag(SCOPE, "combatId", "");
  await ignored.setFlag(SCOPE, "createdAt", Date.now() - hooks.SPREAD_ZONE_TTL_MS - 1000);
  const sweptIgnored = await hooks._sweepStaleSpreadZones();
  await sleep(400);
  ok("§12 an unanswered card keeps its pattern past the clock (the apply cannot go out of date)",
    sweptIgnored === 0 && myZones().length === 1, `swept=${sweptIgnored} left=${myZones().length}`);
  await wipeZones(); await wipeCards();

  /* ── §13  the two save cadences — BOTH saves at Mortal, on their two different clocks ───────── */
  // CP2020 p.104 gives the two saves two different clocks and this flow used to run both on one:
  //   stun  — "every time a character takes damage" → per damage event, kept
  //   death — "a new save required every turn that the character remains untreated" → per TURN
  // A three-shell burst on a Mortal figure therefore owes ONE death prompt, not three. And it owes the
  // stun prompt as well: at Mortal the single-target rail posts BOTH (save-rolls.js `postSavePrompts`,
  // p.99 — the stun save governs consciousness, the death save survival), and this flow used to post the
  // death prompt alone. The legs count the prompt CARDS each burst produced, which is the thing the
  // table actually has to resolve.
  const deathCards = (since) => [...game.messages].filter(m => !since.has(m.id) && (m.content ?? "").includes("death-save-prompt"));
  const stunCards  = (since) => [...game.messages].filter(m => !since.has(m.id) && (m.content ?? "").includes("cp-stun-save-roll"));
  const wipeSaveCards = async () => {
    for (const m of [...game.messages].filter(m => /death-save-prompt|cp-stun-save-roll/.test(m.content ?? ""))) await m.delete().catch(() => {});
  };
  const victim13 = target.actor;
  await victim13.update({ "system.damage": 0 });

  /* §13a — a THREE-shell burst on a figure already at Mortal owes exactly one death prompt */
  await victim13.update({ "system.damage": 14 });            // ceil(14/4) = 4 → Mortal 0
  ok("§13 the fixture stands at Mortal before the burst, by value", (victim13.woundState?.() ?? 0) >= 4,
    `woundState=${victim13.woundState?.()}`);
  await wipeSaveCards();
  let sinceIds = new Set(game.messages.map(m => m.id));
  await hooks._placeSpreadZone(basePayload({ shotsFired: 3, spreadDamageShort: "5", spreadDamageMedium: "5", spreadDamageLong: "5" }));
  await sleep(500);
  await hooks._confirmSpreadZone(myZones()[0].id);
  await sleep(3500);
  ok("§13 three shells on one Mortal figure post ONE death prompt, not one per shell",
    deathCards(sinceIds).length === 1, String(deathCards(sinceIds).length));
  ok("§13 and the burst really did land three times (so the count above is a cadence, not a miss)",
    Number(victim13.system?.damage ?? 0) > 14, String(victim13.system?.damage));
  // ⭐ BOTH SAVES AT MORTAL (user ruling: "both"). The single-target rail has always posted the pair
  // there — save-rolls.js `postSavePrompts`, on p.99's reading that the stun save governs consciousness
  // while the death save governs survival — and this flow posted the death prompt alone, so a figure
  // shot to Mortal by a pattern was never asked whether it stayed on its feet. The two keep their own
  // cadences: death once for the batch (above), stun once per damage event, which for three shells is
  // three.
  // ⭐⭐ ONCE PER APPLICATION, NOT PER EVENT (user ruling 2026-08-27, and it REVERSES what this section
  // was written to assert). One attack is one consciousness check, recorded by every event of the
  // application and posted ONCE at the ledger's close off the body's FINAL wound state — measured on
  // the rig at four prompts for one trigger pull, the first of them printing "Serious" for a body that
  // finished at Mortal. The two saves still keep DIFFERENT clocks, which is what this section is about:
  // death once for the batch, stun once for the batch, and the per-TURN death cadence below is a third.
  ok("§13 and the same burst asks for ONE stun save — BOTH saves at Mortal, as the single-target rail does",
    stunCards(sinceIds).length === 1,
    `stun=${stunCards(sinceIds).length} death=${deathCards(sinceIds).length}`);
  await wipeZones(); await wipeCards(); await wipeSaveCards();

  /* §13b — below Mortal the stun prompt keeps its per-damage-event cadence (negative control) */
  await victim13.update({ "system.damage": 0 });
  sinceIds = new Set(game.messages.map(m => m.id));
  await hooks._placeSpreadZone(basePayload({ shotsFired: 2, spreadDamageShort: "5", spreadDamageMedium: "5", spreadDamageLong: "5" }));
  await sleep(500);
  await hooks._confirmSpreadZone(myZones()[0].id);
  await sleep(3500);
  ok("§13 a wounded-but-not-Mortal figure is asked once for the whole application, by value",
    stunCards(sinceIds).length === 1 && deathCards(sinceIds).length === 0,
    `stun=${stunCards(sinceIds).length} death=${deathCards(sinceIds).length} damage=${victim13.system?.damage}`);
  await wipeZones(); await wipeCards(); await wipeSaveCards();
  await victim13.update({ "system.damage": 0 });

  /* §13d — a stabilized patient is not asked to save against dying, and the p.105 rule that gets there first */
  // The single-target rail has always read the stabilized flag before offering the death prompt, and so
  // does the per-turn cadence; this rail did not, and now does. The two halves of this section are the
  // gate itself and the reason it looks like a no-op end to end:
  //   d1 — the gate, driven directly: a stabilized Mortal figure prompted with no fresh damage is asked
  //        for no death save, and IS still asked for a stun save, because consciousness is a separate
  //        question. Clearing the flag brings the death prompt back on the same fixture.
  //   d2 — the whole pattern flow: identical to the unstabilized case, and correctly so. Fresh damage
  //        clears stabilization (Core p.105, applyLocationDamage) before either rail reaches its check,
  //        so the figure is asked — and told, by the notice, that its stabilization is gone. Recorded
  //        as the reason the gate cannot be seen from the outside on a damaging path, so nobody later
  //        reads the gate as dead code or the prompt as the old defect.
  await victim13.update({ "system.damage": 14 });            // Mortal again
  await victim13.setFlag(SCOPE, "stabilized", true);
  ok("§13 the fixture is at Mortal and carries the stabilized flag",
    (victim13.woundState?.() ?? 0) >= 4 && victim13.getFlag(SCOPE, "stabilized") === true,
    `woundState=${victim13.woundState?.()} stabilized=${victim13.getFlag(SCOPE, "stabilized")}`);
  await wipeSaveCards();
  sinceIds = new Set(game.messages.map(m => m.id));
  await hooks._postWoundSavePrompts(victim13, target.object ?? null, new Set());
  await sleep(900);
  ok("§13 the area rail asks a stabilized Mortal figure for NO death save",
    deathCards(sinceIds).length === 0,
    `${deathCards(sinceIds).length} :: ${deathCards(sinceIds).map(m => (m.content ?? "").slice(0, 70).replace(/\s+/g, " ")).join(" ~~ ")}`);
  ok("§13 and still asks it for a stun save — consciousness is the other question",
    stunCards(sinceIds).length === 1, `stun=${stunCards(sinceIds).length}`);
  await wipeSaveCards();

  // POSITIVE CONTROL, same fixture, same call: only the flag differs.
  await victim13.unsetFlag(SCOPE, "stabilized");
  sinceIds = new Set(game.messages.map(m => m.id));
  await hooks._postWoundSavePrompts(victim13, target.object ?? null, new Set());
  await sleep(900);
  ok("§13 clearing the flag brings the death prompt straight back",
    deathCards(sinceIds).length === 1 && stunCards(sinceIds).length === 1,
    `stun=${stunCards(sinceIds).length} death=${deathCards(sinceIds).length}`);
  await wipeSaveCards();

  // d2 — end to end, where p.105 gets there first.
  await victim13.update({ "system.damage": 14 });
  await victim13.setFlag(SCOPE, "stabilized", true);
  sinceIds = new Set(game.messages.map(m => m.id));
  await hooks._placeSpreadZone(basePayload({ shotsFired: 2, spreadDamageShort: "5", spreadDamageMedium: "5", spreadDamageLong: "5" }));
  await sleep(500);
  await hooks._confirmSpreadZone(myZones()[0].id);
  await sleep(3500);
  ok("§13 fresh damage takes the stabilization away first (p.105), so the flag is gone by prompt time",
    !victim13.getFlag(SCOPE, "stabilized"), String(victim13.getFlag(SCOPE, "stabilized")));
  ok("§13 and the table is told the stabilization was lost rather than left to notice",
    [...game.messages].some(m => !sinceIds.has(m.id) && /stabiliz/i.test(m.content ?? "")),
    String([...game.messages].filter(m => !sinceIds.has(m.id) && /stabiliz/i.test(m.content ?? "")).length));
  ok("§13 so an un-stabilized Mortal figure is asked for both saves, once each",
    deathCards(sinceIds).length === 1 && stunCards(sinceIds).length === 1,
    `stun=${stunCards(sinceIds).length} death=${deathCards(sinceIds).length}`);
  await wipeZones(); await wipeCards(); await wipeSaveCards();
  await victim13.unsetFlag(SCOPE, "stabilized");
  await victim13.update({ "system.damage": 0 });

  /* §13c — the per-TURN cadence the book actually describes is already built, and it is gated */
  const savesSrc = await (await fetch(`/modules/${SCOPE}/module/combat/save-rolls.js`, { cache: "no-store" })).text();
  ok("§13 a round advance is where the recurring death prompt lives, and it respects stabilization",
    /autoDeathSavePerTurn/.test(savesSrc) && /stabilized/.test(savesSrc)
    && typeof game.settings.get(SCOPE, "autoDeathSavePerTurn") === "boolean");

  /* ── §14  a declared corridor can still MISS, and a miss goes to the grenade table ───────── */
  // CP2020 p.108: a pattern that misses has its TRUE CENTRE determined on the grenade table — 1d10 for
  // a direction, 1d10 for the metres. Nothing is rolled by the pattern flow to decide hit or miss: the
  // base system already rolled one attack for this card and the payload carries that total and the DC
  // it was measured against, so the pattern and the base's own card cannot print opposite verdicts.
  await wipeZones(); await wipeCards();

  // §14a — the verdict reader, by value, including the two shapes that must read as "nobody asked".
  ok("§14 the base's total at or above its DC is a hit, below it is a miss",
    hooks.spreadAttackOutcome({ attackTotal: 20, toHitDC: 20 })?.hit === true
    && hooks.spreadAttackOutcome({ attackTotal: 19, toHitDC: 20 })?.hit === false,
    JSON.stringify(hooks.spreadAttackOutcome({ attackTotal: 19, toHitDC: 20 })));
  ok("§14 a payload carrying no roll answers null — not a hit, not a miss (negative)",
    hooks.spreadAttackOutcome({}) === null && hooks.spreadAttackOutcome(basePayload()) === null);
  ok("§14 and a RELAYED payload whose fields serialized to null answers null, not a hit at DC zero",
    hooks.spreadAttackOutcome(JSON.parse(JSON.stringify({ attackTotal: NaN, toHitDC: NaN }))) === null,
    JSON.stringify(JSON.parse(JSON.stringify({ attackTotal: NaN, toHitDC: NaN }))));

  // §14a-bis — THE BASE'S RULED BOOLEAN OUTRANKS THE COMPARISON (2026-08-26). The comparison alone
  // cannot see everything the base ruled on: `_maybeApplyRangedFumble` sets `forceMiss`, and every fire
  // path zeroes its hit count from that flag while `attackRoll.total` still stands over the DC. The
  // field-repro'd numbers are used verbatim — 31 against a DC of 15, which the arithmetic calls a hit
  // and the base's own card called a miss.
  ok("§14 a ruled FUMBLE is a miss whatever the roll totalled — the field repro, by value",
    hooks.spreadAttackOutcome({ attackTotal: 31, toHitDC: 15, baseHit: false, fumbleRuled: true })?.hit === false
    && hooks.spreadAttackOutcome({ attackTotal: 31, toHitDC: 15, baseHit: false, fumbleRuled: true })?.source === "fumble"
    && hooks.spreadAttackOutcome({ attackTotal: 31, toHitDC: 15, baseHit: false, fumbleRuled: true })?.total === 31,
    JSON.stringify(hooks.spreadAttackOutcome({ attackTotal: 31, toHitDC: 15, baseHit: false, fumbleRuled: true })));
  ok("§14 a ruled MISS over the DC reads as a miss, and a ruled HIT under it as a hit (both directions)",
    hooks.spreadAttackOutcome({ attackTotal: 31, toHitDC: 15, baseHit: false })?.hit === false
    && hooks.spreadAttackOutcome({ attackTotal: 31, toHitDC: 15, baseHit: false })?.source === "base"
    && hooks.spreadAttackOutcome({ attackTotal: 9, toHitDC: 15, baseHit: true })?.hit === true,
    JSON.stringify([hooks.spreadAttackOutcome({ attackTotal: 31, toHitDC: 15, baseHit: false }),
                    hooks.spreadAttackOutcome({ attackTotal: 9, toHitDC: 15, baseHit: true })]));
  ok("§14 an autoshotgun's TIE arrives ruled a miss, which is how the base counts its rounds",
    hooks.spreadAttackOutcome({ attackTotal: 20, toHitDC: 20, baseHit: false, baseHits: 0 })?.hit === false
    && hooks.spreadAttackOutcome({ attackTotal: 20, toHitDC: 20, baseHit: false, baseHits: 0 })?.hits === 0,
    JSON.stringify(hooks.spreadAttackOutcome({ attackTotal: 20, toHitDC: 20, baseHit: false, baseHits: 0 })));
  // ⏪ THE UNSTAMPED FALLBACK IS UNCHANGED, tie included. A payload with no verdict field — a macro, a
  // keeper placement, a client mid-update — still gets the comparison, and its tie still reads as a hit
  // because that is the base's SEMI-AUTO rule (item.js:689), the only fire mode a plain shotgun has
  // (__getFireModes, item.js:408). ⛔ Whether that fallback should instead be strictly-over is a live
  // user call, recorded in import-staging/SPREAD-FUMBLE-VERDICT.md; nothing about a fired-in-anger shot
  // depends on it any more.
  ok("§14 a payload carrying NO verdict field keeps the comparison, tie included (negative)",
    hooks.spreadAttackOutcome({ attackTotal: 20, toHitDC: 20 })?.source === "derived"
    && hooks.spreadAttackOutcome({ attackTotal: 20, toHitDC: 20 })?.hit === true
    && hooks.spreadAttackOutcome({ attackTotal: 19, toHitDC: 20 })?.hit === false
    && hooks.spreadAttackOutcome({ attackTotal: 31, toHitDC: 15, baseHit: null })?.source === "derived",
    JSON.stringify([hooks.spreadAttackOutcome({ attackTotal: 20, toHitDC: 20 }),
                    hooks.spreadAttackOutcome({ attackTotal: 31, toHitDC: 15, baseHit: null })]));

  /* ── §14a-ter  THE RULED FUMBLE'S OUTCOME CLASS — the base's table row, read once ──────────── */
  // A ruled fumble is not one outcome. The base rolls a second d10 against its Reflex (Combat) table
  // (base utils.js:641-648) and the rows say different things: 1-4 is "no fumble, you just screw up" —
  // an ordinary miss with a round in flight — while 5 and 7 put no round out at all, 6 puts one out
  // harmlessly, and 8-10 are resolved entirely by the base's own card. Treating them alike made the
  // 40 % case vanish. These legs pin the mapping, the ANCHOR that decides whether the html can be read
  // at all, the auto-only-jam branch that prints no table row, and the two predicates both rails ask.
  {
    // The two shapes the base's `_dieSpan` emits (base utils.js:286-304): the anchor form when it has a
    // Roll in hand, the span form when it does not. Both must be recognised — a real block carries one
    // of each, because the main-roll line often has no Roll object to serialise.
    const dieAnchor = (v) => `<a class="inline-roll inline-result cp-inline-roll roll-result roll die d10" data-roll="%7B%22formula%22%3A%221d10%22%7D">${v}</a>`;
    const dieSpan = (v) => `<span class="roll-result roll die d10">${v}</span>`;
    // The block's shape, in the base's own order: main-roll line, table-roll line, row prose, then any
    // trailing dice a row asks for (a location die, a reliability die).
    const blockHtml = (sub, { main = 1, trailing = [] } = {}) =>
      `<p><b>Fumble</b>: main roll was ${dieSpan(main)}.</p>`
      + `<p><b>Reflex (Combat)</b>: additional roll ${dieAnchor(sub)}.</p>`
      + `<p>row prose</p>`
      + trailing.map(v => `<p>trailing ${dieAnchor(v)}</p>`).join("");
    const classOf = (sub, opts) => fumbleMod.rangedFumbleClassFrom({ html: blockHtml(sub, opts) });

    const EXPECT = { 1: "plainMiss", 2: "plainMiss", 3: "plainMiss", 4: "plainMiss",
                     5: "noDischarge", 6: "harmlessDischarge", 7: "noDischarge",
                     8: "ownSide", 9: "ownSide", 10: "ownSide" };
    const mapped = {};
    for (let s = 1; s <= 10; s++) mapped[s] = classOf(s);
    ok("§14a-ter every table row maps to its outcome class, by value across all ten faces",
      Object.keys(EXPECT).every(k => mapped[k] === EXPECT[k]), JSON.stringify(mapped));
    // Trailing dice belong to the ROW, not to the classification — a row-8 block carries a location die
    // and a damage total after its table face, and a row-6 block carries a reliability die. Neither may
    // move the answer, which is what makes the SECOND face (not the last) the one that is read.
    ok("§14a-ter trailing row dice do not move the class (row 8 + location, row 6 + reliability)",
      classOf(8, { trailing: [4] }) === "ownSide" && classOf(6, { trailing: [9] }) === "harmlessDischarge",
      JSON.stringify({ eight: classOf(8, { trailing: [4] }), six: classOf(6, { trailing: [9] }) }));
    // ⭐ THE ANCHOR. A fumble block only exists because the main die came up 1 (base isFumbleRoll,
    // utils.js:282-284), so the first face is a checkable invariant. A block whose first face is not 1
    // is not the shape this parse was written against, and it must say UNKNOWN rather than read the
    // wrong element — a null falls back to the uniform bail, which is the behaviour that already ships.
    ok("§14a-ter a block whose first face is not 1 is refused, not guessed at (the anchor)",
      classOf(3, { main: 7 }) === null
      && fumbleMod.rangedFumbleClassFrom({ html: `<p>${dieSpan(1)}</p>` }) === null
      && fumbleMod.rangedFumbleClassFrom({ html: "" }) === null
      && fumbleMod.rangedFumbleClassFrom({}) === null,
      JSON.stringify({ wrongAnchor: classOf(3, { main: 7 }),
                       oneFace: fumbleMod.rangedFumbleClassFrom({ html: `<p>${dieSpan(1)}</p>` }),
                       empty: fumbleMod.rangedFumbleClassFrom({ html: "" }) }));
    ok("§14a-ter the face reader returns the base's own faces in document order",
      JSON.stringify(fumbleMod.fumbleTableDieFaces(blockHtml(6, { trailing: [9] }))) === "[1,6,9]"
      && fumbleMod.fumbleTableSubRoll(blockHtml(6, { trailing: [9] })) === 6,
      JSON.stringify(fumbleMod.fumbleTableDieFaces(blockHtml(6, { trailing: [9] }))));
    // The auto-only-jam early return prints NO table row — its second face is a reliability die — so the
    // branch is stated by the caller and classified without parsing. Both of its ends are rounds that
    // never left, so the whole branch is noDischarge (a lane call, recorded in the file's header).
    ok("§14a-ter the auto-only-jam branch classifies without parsing, whatever face the html shows",
      fumbleMod.rangedFumbleClassFrom({ html: blockHtml(3), autoOnlyJamBranch: true }) === "noDischarge"
      && fumbleMod.rangedFumbleClassFrom({ html: blockHtml(9), autoOnlyJamBranch: true }) === "noDischarge"
      && fumbleMod.rangedFumbleClassFrom({ html: "", autoOnlyJamBranch: true }) === "noDischarge",
      JSON.stringify([fumbleMod.rangedFumbleClassFrom({ html: blockHtml(3), autoOnlyJamBranch: true }),
                      fumbleMod.rangedFumbleClassFrom({ html: blockHtml(9), autoOnlyJamBranch: true })]));

    // The reader consumers use, and the two predicates. An unknown string, a null and an absent field
    // all read as "the payload does not say" — the legacy shape, which must keep the uniform bail.
    ok("§14a-ter the carried class is normalised: only the four known strings survive the read",
      fumbleMod.fumbleClassOf({ fumbleClass: "plainMiss" }) === "plainMiss"
      && fumbleMod.fumbleClassOf({ fumbleClass: "somethingElse" }) === null
      && fumbleMod.fumbleClassOf({ fumbleClass: null }) === null
      && fumbleMod.fumbleClassOf({}) === null,
      JSON.stringify(fumbleMod.FUMBLE_CLASSES));
    const pred = (fumbleClass) => ({
      down: fumbleMod.fumbleStandsRailsDown({ fumbleRuled: true, fumbleClass }),
      miss: fumbleMod.fumbleIsOrdinaryMiss({ fumbleRuled: true, fumbleClass }),
    });
    ok("§14a-ter exactly one class keeps both rails running, and the other three stand them down",
      pred("plainMiss").miss === true && pred("plainMiss").down === false
      && pred("noDischarge").down === true && pred("noDischarge").miss === false
      && pred("harmlessDischarge").down === true && pred("harmlessDischarge").miss === false
      && pred("ownSide").down === true && pred("ownSide").miss === false
      && pred(undefined).down === true && pred(undefined).miss === false,
      JSON.stringify({ plainMiss: pred("plainMiss"), noDischarge: pred("noDischarge"),
                       harmlessDischarge: pred("harmlessDischarge"), ownSide: pred("ownSide"),
                       legacy: pred(undefined) }));
    ok("§14a-ter a payload with no ruled fumble stands nothing down and is no ordinary-miss fumble",
      fumbleMod.fumbleStandsRailsDown({ fumbleClass: "plainMiss" }) === false
      && fumbleMod.fumbleIsOrdinaryMiss({ fumbleClass: "plainMiss" }) === false
      && fumbleMod.fumbleStandsRailsDown({}) === false,
      JSON.stringify({ unruledPlain: fumbleMod.fumbleStandsRailsDown({ fumbleClass: "plainMiss" }) }));

    // The verdict site carries the class through, and the scatter decision reads it: an ordinary-miss
    // fumble goes to the grenade table like any other miss, the other three roll nothing.
    const fp = (fumbleClass) => ({ attackTotal: 31, toHitDC: 15, baseHit: false, fumbleRuled: true, fumbleClass });
    ok("§14a-ter the verdict site carries the class beside the ruling, and still rules every fumble a miss",
      hooks.spreadAttackOutcome(fp("plainMiss"))?.fumbleClass === "plainMiss"
      && hooks.spreadAttackOutcome(fp("plainMiss"))?.hit === false
      && hooks.spreadAttackOutcome(fp("plainMiss"))?.source === "fumble"
      && hooks.spreadAttackOutcome({ attackTotal: 31, toHitDC: 15, baseHit: false })?.fumbleClass === null,
      JSON.stringify(hooks.spreadAttackOutcome(fp("plainMiss"))));
    // A corridor record good enough for the predicate's entry condition (declaredSpreadAim wants a
    // finite angle and three positive lengths); the behavioural sections build the real one.
    const aim14ater = { angleDeg: 0, reachM: 20, lengthM: 22, widthM: 2, band: "Medium" };
    const scat = (fumbleClass) => geo.payloadScattersOnMiss({ spreadAim: aim14ater, ...fp(fumbleClass) });
    ok("§14a-ter only the ordinary-miss class sends the centre to the grenade table",
      scat("plainMiss") === true && scat("noDischarge") === false
      && scat("harmlessDischarge") === false && scat("ownSide") === false && scat(undefined) === false,
      JSON.stringify({ plainMiss: scat("plainMiss"), noDischarge: scat("noDischarge"),
                       harmlessDischarge: scat("harmlessDischarge"), ownSide: scat("ownSide"),
                       legacy: scat(undefined) }));

    /* THE LIVE PRODUCER. Everything above reads a fixture built to the base's shape; this drives the
     * BASE SYSTEM'S OWN builder and classifies what it actually writes, so a base edit that moves a line
     * or drops a die is caught here rather than at somebody's table. 300 builds sample every row
     * (P(missing the 10 % row) ≈ 3e-14), and the two structured flags the base DOES expose
     * (`outcome.discharge`, `outcome.jam`) cross-check the parsed face independently of the parse. */
    const stubWeapon = {
      _getWeaponSystem: () => ({ reliability: "Standard", damage: "1d6" }),
      actor: { getRollData: () => ({}) },
    };
    const seen = new Set();
    let builds = 0, unreadable = 0, mismatched = 0, dischargeOffRow6 = 0, jamOffRow7 = 0;
    for (let i = 0; i < 300; i++) {
      const built = await baseUtils.buildRangedCombatFumbleData({
        item: stubWeapon, attackRoll: {}, isAutoWeapon: false, autoOnlyJam: false,
      });
      builds++;
      const face = fumbleMod.fumbleTableSubRoll(built.html);
      const cls = fumbleMod.rangedFumbleClassFrom({ html: built.html });
      if (face === null || cls === null) { unreadable++; continue; }
      if (cls !== EXPECT[face]) mismatched++;
      if (built.outcome?.discharge === true && face !== 6) dischargeOffRow6++;
      if (built.outcome?.jam === true && face !== 7) jamOffRow7++;
      seen.add(cls);
    }
    ok("§14a-ter every block the base's own builder writes is readable and classifies to its own face",
      builds === 300 && unreadable === 0 && mismatched === 0,
      JSON.stringify({ builds, unreadable, mismatched }));
    ok("§14a-ter the two flags the base DOES expose agree with the parsed face (independent cross-check)",
      dischargeOffRow6 === 0 && jamOffRow7 === 0,
      JSON.stringify({ dischargeOffRow6, jamOffRow7 }));
    ok("§14a-ter all four classes are produced by the live builder over 300 draws",
      seen.size === 4 && fumbleMod.FUMBLE_CLASSES.every(c => seen.has(c)),
      JSON.stringify([...seen].sort()));
    // …and the auto-only-jam branch really is unreadable positionally, which is why the caller states it.
    // Its second face is a reliability die, so a positional read answers a table row that was never rolled.
    let autoBlocks = 0, autoMisread = 0;
    for (let i = 0; i < 60; i++) {
      const built = await baseUtils.buildRangedCombatFumbleData({
        item: stubWeapon, attackRoll: {}, isAutoWeapon: true, autoOnlyJam: true,
      });
      autoBlocks++;
      const naive = fumbleMod.rangedFumbleClassFrom({ html: built.html });
      const stated = fumbleMod.rangedFumbleClassFrom({ html: built.html, autoOnlyJamBranch: true });
      if (stated !== "noDischarge") autoMisread++;
      if (naive !== null && naive !== "noDischarge") seen.add("__autoNaiveDiffered__");
    }
    ok("§14a-ter the stated branch classifies every auto-only-jam block the base writes",
      autoBlocks === 60 && autoMisread === 0, JSON.stringify({ autoBlocks, autoMisread }));
    ok("§14a-ter …and that flag is load-bearing: read positionally the same blocks answer differently",
      seen.has("__autoNaiveDiffered__"), JSON.stringify([...seen].sort()));
  }

  // §14b — the rose and the drift, by value. Diagonals are unit-normalised, so a 3 travels the rolled
  // distance south-east rather than that distance on each axis; faces 5 and 10 are the no-drift results.
  const drift3 = hooks.scatterDriftM(3, 10);
  ok("§14 a diagonal face travels the rolled distance, not that distance per axis",
    Math.abs(Math.hypot(drift3.dxM, drift3.dyM) - 10) < 1e-9 && drift3.dxM > 0 && drift3.dyM > 0,
    JSON.stringify(drift3));
  ok("§14 south is +y on screen axes, and its drift is the rolled metres exactly",
    hooks.scatterDriftM(2, 7).dyM === 7 && hooks.scatterDriftM(2, 7).dxM === 0 && hooks.scatterDriftM(8, 7).dyM === -7,
    JSON.stringify(hooks.scatterDriftM(2, 7)));
  ok("§14 both no-drift faces report zero however the distance die fell",
    hooks.scatterDriftM(5, 10).distanceM === 0 && hooks.scatterDriftM(10, 10).distanceM === 0
    && hooks.scatterDriftM(5, 10).name === "on-target" && hooks.scatterDriftM(10, 10).name === "direct hit");
  ok("§14 the rose has ten faces and this is the GRENADE table, not the indirect-fire one",
    Object.keys(hooks.SCATTER_ROSE).length === 10
    && (await import(`/modules/${SCOPE}/module/vehicle/vehicle-indirect.js`)).scatterDirectionDeg(3) === 72,
    Object.keys(hooks.SCATTER_ROSE).length);

  // §14c — the corridor re-derives from the MUZZLE to the scattered centre. A 20 m corridor that drifts
  // 7 m south is 21.19 m long on a heading of 19.29°, which is still the Medium band.
  const scDeclared = { angleDeg: 0, reachM: 20, lengthM: 20, widthM: 2, band: "Medium" };
  const sc = hooks.scatteredSpreadCorridor({
    originX: 0, originY: 0, declared: scDeclared, pixelsPerMeter: 10, dirFace: 2, distFace: 7,
  });
  ok("§14 the scattered centre is the AIMED point moved by the drift, in pixels",
    Math.abs(sc.aimX - 200) < 1e-6 && Math.abs(sc.aimY - 70) < 1e-6, JSON.stringify({ x: sc.aimX, y: sc.aimY }));
  ok("§14 the reach is re-measured from the unmoved muzzle, by value",
    Math.abs(sc.reachM - Math.hypot(20, 7)) < 1e-9, `${sc.reachM} vs ${Math.hypot(20, 7)}`);
  ok("§14 the heading is re-read from the muzzle to where the shell landed, by value",
    Math.abs(sc.angleDeg - (Math.atan2(7, 20) * 180 / Math.PI)) < 1e-9, String(sc.angleDeg));
  ok("§14 band, width and the banded damage all re-derive from the NEW distance",
    sc.band === lookup.spreadBandSpec(sc.reachM).band && sc.widthM === lookup.spreadBandSpec(sc.reachM).widthM
    && lookup.spreadBandDamage(sc.band) === "3d6",
    JSON.stringify({ band: sc.band, widthM: sc.widthM }));
  // A long scatter walks the corridor into the outermost band and stops there — the ladder saturates,
  // so pellets never gain reach they did not have.
  const scLong = hooks.scatteredSpreadCorridor({
    originX: 0, originY: 0, declared: { ...scDeclared, reachM: 24, widthM: 2 }, pixelsPerMeter: 10, dirFace: 6, distFace: 10,
  });
  ok("§14 a scatter past the band ladder's end lands in the outermost band and no further",
    scLong.band === "Long" && scLong.widthM === 3 && lookup.spreadBandDamage(scLong.band) === "2d6",
    JSON.stringify({ reachM: scLong.reachM, band: scLong.band, widthM: scLong.widthM }));
  // ⏪ THE DECLARED WIDTH IS NOT CARRIED ACROSS THE SCATTER, and that changed with the width wheel's
  // retirement (2026-08-16). While the wheel existed this function recovered the table's ±1 m notch from
  // the declared corridor and re-applied it to the new band; now a declared width is always either the
  // band's own or the load's printed one, and both re-derive correctly from the new band by themselves.
  // So a corridor handed an off-ladder width lands at the NEW BAND's width, not at that width plus a
  // recovered difference.
  const scHouse = hooks.scatteredSpreadCorridor({
    originX: 0, originY: 0, declared: { ...scDeclared, widthM: 4 }, pixelsPerMeter: 10, dirFace: 2, distFace: 7,
  });
  ok("§14 an off-ladder declared width does not ride the scatter — the new band's width is what lands, by value",
    scHouse.widthM === lookup.spreadBandSpec(scHouse.reachM).widthM && scHouse.widthM !== 4,
    `${scHouse.widthM} vs the new band's ${lookup.spreadBandSpec(scHouse.reachM).widthM}`);
  // What DOES survive is the load's own printed widths, because they are read on the new band directly.
  const scLoad = hooks.scatteredSpreadCorridor({
    originX: 0, originY: 0, declared: scDeclared, widths: { short: 5, medium: 6, long: 7 },
    pixelsPerMeter: 10, dirFace: 2, distFace: 7,
  });
  ok("§14 a load's printed width for the band it lands in is what the scattered corridor takes, by value",
    scLoad.band === "Medium" && scLoad.widthM === 6, JSON.stringify({ band: scLoad.band, widthM: scLoad.widthM }));
  ok("§14 and no scattered corridor is ever narrower than the one-metre floor",
    hooks.scatteredSpreadCorridor({
      originX: 0, originY: 0, declared: { ...scDeclared, widthM: 1 }, widths: { long: 0.2 },
      pixelsPerMeter: 10, dirFace: 3, distFace: 10,
    }).widthM >= placement.SPREAD_MIN_WIDTH_M);
  // Off the map: the centre is clamped onto the scene rect rather than being left where nobody can read it.
  const rect = { x: 0, y: 0, width: 210, height: 210 };
  const scClamp = hooks.scatteredSpreadCorridor({
    originX: 0, originY: 0, declared: scDeclared, pixelsPerMeter: 10, dirFace: 6, distFace: 10, sceneRect: rect,
  });
  ok("§14 a centre that drifts off the map is clamped onto the scene rect and says so",
    scClamp.clamped === true && scClamp.aimX === 210 && scClamp.aimX <= rect.x + rect.width,
    JSON.stringify({ x: scClamp.aimX, clamped: scClamp.clamped }));
  ok("§14 a centre that stays on the map is not clamped (negative)",
    hooks.scatteredSpreadCorridor({
      originX: 0, originY: 0, declared: scDeclared, pixelsPerMeter: 10, dirFace: 2, distFace: 7, sceneRect: { x: 0, y: 0, width: 1000, height: 1000 },
    }).clamped === false);

  // §14d — END TO END THROUGH THE PLANT, with two figures standing where the two answers put the
  // corridor: one on the point that was AIMED at, one where the shell lands after the rolled drift.
  // Foundry v14 maps a face as Math.ceil((1 − u) · faces), so u = 1 − (k − 0.5)/N forces a d10 to k
  // (the a1a5 harness's D()).
  const scOrigin = shooterPlaceable.center;
  const scPpm = grid.metersToPixels(scene, 1);
  const scHalfSq = canvas.dimensions.size / 2;
  // The overshoot rule, in metres: half a one-square figure's own width. Both answers below run the
  // corridor that far past the centre so the figure standing on it is unambiguously inside.
  const scOvershootM = grid.pixelsToMeters(scene, canvas.dimensions.size) / 2;
  const scAimPt = { x: scOrigin.x + 20 * scPpm, y: scOrigin.y };
  const scHitPt = { x: scOrigin.x + 20 * scPpm, y: scOrigin.y + 7 * scPpm };
  const [scAimTok] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PWK__SPREAD Aimed", actorId: (await Actor.create({ name: "__PWK__SPREAD Aimed Actor", type: "character" })).id,
    x: scAimPt.x - scHalfSq, y: scAimPt.y - scHalfSq, width: 1, height: 1,
  }]);
  const [scHitTok] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PWK__SPREAD Landed", actorId: (await Actor.create({ name: "__PWK__SPREAD Landed Actor", type: "character" })).id,
    x: scHitPt.x - scHalfSq, y: scHitPt.y - scHalfSq, width: 1, height: 1,
  }]);
  await sleep(400);

  const declaredAim = {
    sceneId: scene.id, originX: scOrigin.x, originY: scOrigin.y,
    angleDeg: 0, reachM: 20, lengthM: 20 + scOvershootM, widthM: 2, band: "Medium", dmgFormula: "3d6",
  };
  const newCardSince = async (since) => {
    for (let i = 0; i < 40; i++) {
      const c = resolveCards().filter(m => !since.has(m.id));
      if (c.length) return c[c.length - 1];
      await sleep(250);
    }
    return null;
  };
  const plain = (m) => (m?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  // HIT — the corridor stays exactly where it was aimed, and the card says so.
  let sinceScatter = new Set(game.messages.map(m => m.id));
  await hooks._placeSpreadZone(basePayload({ shotsFired: 1, spreadAim: declaredAim, attackTotal: 30, toHitDC: 15 }));
  const scHitCard = await newCardSince(sinceScatter);
  const scF = myZones()[0]?.flags?.[SCOPE] ?? {};
  ok("§14 a HIT plants the corridor exactly as aimed — heading, reach and width untouched",
    scF.scattered === false && Math.abs(Number(scF.dirDeg) - 0) < 1e-9
    && Math.abs(Number(scF.lengthM) - (20 + scOvershootM)) < 1e-9 && Number(scF.widthM) === 2,
    JSON.stringify({ scattered: scF.scattered, dirDeg: scF.dirDeg, lengthM: scF.lengthM, widthM: scF.widthM }));
  ok("§14 its card carries the roll line with the verdict, and NO scatter line (negative)",
    /30/.test(plain(scHitCard)) && /HIT/.test(plain(scHitCard)) && !/Scatter/i.test(plain(scHitCard)),
    plain(scHitCard).slice(0, 180));
  ok("§14 and the figure standing on the aimed point is the one the card lists",
    /__PWK__SPREAD Aimed/.test(plain(scHitCard)) && !/__PWK__SPREAD Landed/.test(plain(scHitCard)),
    plain(scHitCard).slice(0, 220));
  await wipeZones(); await wipeCards();

  // MISS — two forced d10s send the true centre 7 m south, and every number re-derives from there.
  const origRU = CONFIG.Dice.randomUniform;
  const D10 = (k) => 1 - (k - 0.5) / 10;
  const queue = (...ks) => { const Q = ks.map(D10); CONFIG.Dice.randomUniform = () => (Q.length ? Q.shift() : 0.5); };
  let scMissF = null, scMissCard = null, scSelfCheck = null;
  try {
    // Self-check the override before leaning on it (the a1a5 lesson): if the queue does not drive Roll
    // on this core, every number below is meaningless rather than merely wrong.
    queue(2);
    scSelfCheck = (await new Roll("1d10").evaluate()).total;
    queue(2, 7);
    sinceScatter = new Set(game.messages.map(m => m.id));
    await hooks._placeSpreadZone(basePayload({ shotsFired: 1, spreadAim: declaredAim, attackTotal: 9, toHitDC: 15 }));
    scMissCard = await newCardSince(sinceScatter);
    scMissF = myZones()[0]?.flags?.[SCOPE] ?? {};
  } finally {
    CONFIG.Dice.randomUniform = origRU;
  }
  ok("§14 the forced dice really do drive the roll (self-check)", scSelfCheck === 2, String(scSelfCheck));
  const wantReach = Math.hypot(20, 7), wantDeg = Math.atan2(7, 20) * 180 / Math.PI;
  ok("§14 a MISS moves the true centre by the rolled vector — face 2 is south, 7 metres — and records it",
    scMissF.scattered === true && scMissF.scatterDirFace === 2 && scMissF.scatterDriftM === 7,
    JSON.stringify({ scattered: scMissF.scattered, face: scMissF.scatterDirFace, drift: scMissF.scatterDriftM }));
  ok("§14 the planted corridor's heading and reach are re-derived from the unmoved muzzle, by value",
    Math.abs(Number(scMissF.dirDeg) - wantDeg) < 0.01
    && Math.abs(Number(scMissF.lengthM) - (wantReach + scOvershootM)) < 0.01,
    JSON.stringify({ dirDeg: scMissF.dirDeg, lengthM: scMissF.lengthM, wantDeg, wantLength: wantReach + scOvershootM }));
  ok("§14 and its band, width and banded damage are the NEW distance's, not the aim's",
    scMissF.band === lookup.spreadBandSpec(wantReach).band
    && Number(scMissF.widthM) === lookup.spreadBandSpec(wantReach).widthM
    && scMissF.dmgFormula === lookup.spreadBandDamage(lookup.spreadBandSpec(wantReach).band),
    JSON.stringify({ band: scMissF.band, widthM: scMissF.widthM, dmg: scMissF.dmgFormula }));
  ok("§14 the card states the miss and the drift it took",
    /MISS/.test(plain(scMissCard)) && /Scatter/i.test(plain(scMissCard)) && /7m/.test(plain(scMissCard)),
    plain(scMissCard).slice(0, 220));

  // §14e — the OCCUPANTS are re-read on the corridor that was actually PLANTED, so the card lists the
  // figure standing where the shell landed and not the one standing on the aimed point.
  ok("§14 the figure standing where the shell LANDED is the one the scattered card lists",
    /__PWK__SPREAD Landed/.test(plain(scMissCard)), plain(scMissCard).slice(0, 260));
  ok("§14 and the figure standing on the point that was AIMED at is not (negative)",
    !/__PWK__SPREAD Aimed/.test(plain(scMissCard)), plain(scMissCard).slice(0, 260));
  // The same answer read off the region itself rather than off the card, so a card built from a stale
  // snapshot could not pass the pair.
  const scInside = areas.tokensInArea(areas.areaById(scene, myZones()[0].id), [...(scene.tokens ?? [])])
    .map(td => td.name ?? td.document?.name);
  ok("§14 and the region agrees with its own card about who is standing in it",
    scInside.includes("__PWK__SPREAD Landed") && !scInside.includes("__PWK__SPREAD Aimed"), scInside.join(" | "));

  // §14f — THE SHOOTER STAYS OUT OF THEIR OWN PATTERN, scattered or not, and this is a DESIGN CALL
  // rather than an oversight: the corridor is anchored at the muzzle and runs outward, so the shooter
  // sits at the polygon's start on EVERY shot they fire, hit or miss. Dropping the attacker exemption
  // "so a scattered pattern can catch them" would therefore catch them on every shot ever fired, which
  // is not what p.108 describes. A pattern that can turn on its thrower needs detached geometry, and
  // that is a different ruling. The exemption is untouched; this pins that it still holds after a scatter.
  ok("§14 the shooter is not listed in their own scattered pattern (the attacker exemption still holds)",
    !/__PWK__SPREAD Gunner/.test(plain(scMissCard)), plain(scMissCard).slice(0, 260));
  await wipeZones(); await wipeCards();

  // §14g — a corridor NOBODY declared is untouched by all of this: no verdict is consulted, no scatter
  // is rolled, and the guessed-corridor card still asks the reader to look before it resolves.
  await hooks._placeSpreadZone(basePayload({ shotsFired: 1, attackTotal: 2, toHitDC: 30 }));
  await sleep(700);
  ok("§14 an UNDECLARED corridor never scatters, however badly the roll went (negative)",
    myZones()[0]?.flags?.[SCOPE]?.scattered === false && myZones()[0]?.flags?.[SCOPE]?.declaredAim === false,
    JSON.stringify({ scattered: myZones()[0]?.flags?.[SCOPE]?.scattered, declared: myZones()[0]?.flags?.[SCOPE]?.declaredAim }));
  await wipeZones(); await wipeCards();
  for (const t of [scAimTok, scHitTok]) await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});

  // §14h — THE ROUNDS FOLLOW THE SCATTER. Two rails read one shot: the plant puts the pattern about the
  // missed centre, the presentation draws the rounds toward it. They used to answer separately — the
  // plant rolled its own dice on the ACTIVE GM's client, after the FIRING client's fan-out had already
  // resolved its axis toward the aimed point — so on every miss the rounds crossed one line while the
  // pattern was planted on another. The dice are rolled once now, at the seam, and ride the payload.
  //
  // Both answers are read here IN PIXELS off the same payload and compared by value. The fixture tokens
  // are gone by this point, deliberately: with nothing standing on the landed centre the corridor takes
  // no overshoot, so its far end IS the centre and the two numbers are directly comparable.
  await sleep(800);   // the two fixture figures have to leave the CANVAS, not just the scene document
  {
    const ppm14h = grid.metersToPixels(scene, 1);
    const rect14h = canvas.dimensions.sceneRect;
    // A SCATTERED corridor runs half a standing figure's width past its new centre, so an unnoticed
    // bystander there would move the far end by metres and this section would be comparing two different
    // things. Only the LANDED point needs to be bare: an aimed corridor takes its length from the aim
    // record, which already carries its own overshoot, and the plant measures nothing.
    const occupied = (p) => (canvas?.tokens?.placeables ?? []).some((t) => {
      const b = t.bounds ?? { x: t.x, y: t.y, width: t.w ?? 0, height: t.h ?? 0 };
      return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    });
    const farEndOf = (flags) => {
      const rad = (Number(flags.dirDeg) * Math.PI) / 180;
      return { x: Number(flags.originX) + Math.cos(rad) * Number(flags.lengthM) * ppm14h,
               y: Number(flags.originY) + Math.sin(rad) * Number(flags.lengthM) * ppm14h };
    };
    const near = (a, b, tol = 0.5) => !!a && !!b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
    const say = (p) => p ? `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})` : "null";

    // the decision itself, before any dice: a corridor plus the base system's own verdict
    ok("§14h the scatter decision wants BOTH a declared corridor and a ruled miss",
      geo.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: 9, toHitDC: 15 }) === true
      && geo.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: 30, toHitDC: 15 }) === false
      && geo.payloadScattersOnMiss({ attackTotal: 9, toHitDC: 15 }) === false
      && geo.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: null, toHitDC: null }) === false,
      JSON.stringify([
        geo.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: 9, toHitDC: 15 }),
        geo.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: 30, toHitDC: 15 }),
        geo.payloadScattersOnMiss({ attackTotal: 9, toHitDC: 15 }),
        geo.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: null, toHitDC: null }),
      ]));
    // …and it reads the RULING, not the arithmetic: a payload whose numbers say "over the DC" but whose
    // base verdict says miss scatters, and a ruled FUMBLE scatters nothing at all because nothing is
    // planted for one. The drift table is no longer the home of this question — assert that too, so a
    // future edit that puts a second copy back in scatter-table.js is caught by name.
    ok("§14h the scatter decision follows the base's ruling over the two numbers",
      geo.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: 31, toHitDC: 15, baseHit: false }) === true
      && geo.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: 9, toHitDC: 15, baseHit: true }) === false
      && geo.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: 31, toHitDC: 15, baseHit: false, fumbleRuled: true }) === false
      && scatterTable.payloadScattersOnMiss === undefined,
      JSON.stringify({
        ruledMiss: geo.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: 31, toHitDC: 15, baseHit: false }),
        ruledHit: geo.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: 9, toHitDC: 15, baseHit: true }),
        fumble: geo.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: 31, toHitDC: 15, baseHit: false, fumbleRuled: true }),
        stillInDriftTable: scatterTable.payloadScattersOnMiss !== undefined,
      }));

    // WHERE THE DICE ARE ROLLED, read off the served code: the seam that assembles the payload on the
    // FIRING client, not the plant that runs on the GM's. The behavioural legs below prove the plant
    // honours what it is given; this one proves something gives it.
    const seamSrc = await (await fetch(`/modules/${SCOPE}/module/seam-shim.js`, { cache: "no-store" })).text();
    ok("§14h the seam asks the scatter question and stamps the two faces onto the payload it raises",
      /payloadScattersOnMiss\(/.test(seamSrc) && /spreadScatter\s*=\s*\{/.test(seamSrc)
      && /\bspreadScatter,/.test(seamSrc),
      JSON.stringify({ asks: /payloadScattersOnMiss\(/.test(seamSrc), rolls: /spreadScatter\s*=\s*\{/.test(seamSrc), carries: /\bspreadScatter,/.test(seamSrc) }));

    // A HIT: nothing scatters, and both rails sit on the point the shooter clicked. The PLANTED corridor
    // runs the declared overshoot past that point (the aim record's own lengthM − reachM, the reach into
    // the aimed-at figure's square), so the far end is compared against the aim plus exactly that.
    const aimedPt = { x: scOrigin.x + 20 * scPpm, y: scOrigin.y };
    const declaredOvershootPx = (declaredAim.lengthM - declaredAim.reachM) * ppm14h;
    const hitP = basePayload({ shotsFired: 1, spreadAim: declaredAim, attackTotal: 30, toHitDC: 15 });
    const hitDrawn = fx.declaredAimPointOf(hitP, shooterPlaceable);
    await hooks._placeSpreadZone(hitP);
    await sleep(500);
    const hitPlanted = farEndOf(myZones()[0]?.flags?.[SCOPE] ?? {});
    ok("§14h on a HIT the rounds are drawn to the aimed point and the pattern is planted on it",
      near(hitDrawn, aimedPt) && near(hitPlanted, { x: aimedPt.x + declaredOvershootPx, y: aimedPt.y }),
      `drawn ${say(hitDrawn)} planted ${say(hitPlanted)} aimed ${say(aimedPt)} +overshoot ${declaredOvershootPx.toFixed(1)}px`);
    await wipeZones(); await wipeCards();

    // A MISS, with the two faces CARRIED on the payload — face 2 is south, 7 metres.
    const missP = basePayload({
      shotsFired: 1, spreadAim: declaredAim, attackTotal: 9, toHitDC: 15,
      spreadScatter: { dirFace: 2, distFace: 7 },
    });
    const landedPt = scatterTable.scatterLandedPoint({
      aimedX: aimedPt.x, aimedY: aimedPt.y, pixelsPerMeter: ppm14h, dirFace: 2, distFace: 7, sceneRect: rect14h,
    });
    ok("§14h nothing is standing where the shell lands, so the scattered corridor takes no overshoot",
      occupied(landedPt) === false, JSON.stringify({ landed: occupied(landedPt) }));
    const missDrawn = fx.declaredAimPointOf(missP, shooterPlaceable);
    // ⛔ THE PLANT MUST NOT ROLL WHEN THE FACES ARE CARRIED, so the generator is forced to a face that
    // would give a VISIBLY different answer (9 is north-east, 1 metre). If the plant reached for the dice
    // the pattern would land somewhere the drawn rounds are not, which is the whole defect.
    const origRU14h = CONFIG.Dice.randomUniform;
    let missPlanted = null, missFlags = null;
    try {
      const Q = [9, 1].map((k) => 1 - (k - 0.5) / 10);
      CONFIG.Dice.randomUniform = () => (Q.length ? Q.shift() : 0.5);
      await hooks._placeSpreadZone(missP);
      await sleep(500);
      missFlags = myZones()[0]?.flags?.[SCOPE] ?? {};
      missPlanted = farEndOf(missFlags);
    } finally {
      CONFIG.Dice.randomUniform = origRU14h;
    }
    ok("§14h a MISS displaces the drawn rounds and the planted pattern to the SAME point",
      near(missDrawn, { x: landedPt.x, y: landedPt.y }) && near(missPlanted, { x: landedPt.x, y: landedPt.y }),
      `drawn ${say(missDrawn)} planted ${say(missPlanted)} landed ${say(landedPt)}`);
    ok("§14h and that point is 7 metres south of the aim — the vector the carried faces name",
      Math.abs((landedPt.y - aimedPt.y) / ppm14h - 7) < 1e-6 && Math.abs(landedPt.x - aimedPt.x) < 1e-6,
      `drift (${((landedPt.x - aimedPt.x) / ppm14h).toFixed(3)}, ${((landedPt.y - aimedPt.y) / ppm14h).toFixed(3)}) m`);
    ok("§14h the plant used the CARRIED faces and never reached for the dice",
      missFlags?.scatterDirFace === 2 && missFlags?.scatterDriftM === 7,
      JSON.stringify({ face: missFlags?.scatterDirFace, drift: missFlags?.scatterDriftM, forced: "9 / 1m" }));
    ok("§14h the drawn axis moves ONLY because the faces are carried (negative: same miss, no faces)",
      !near(fx.declaredAimPointOf(
        basePayload({ shotsFired: 1, spreadAim: declaredAim, attackTotal: 9, toHitDC: 15 }), shooterPlaceable),
        { x: landedPt.x, y: landedPt.y }),
      say(fx.declaredAimPointOf(basePayload({ shotsFired: 1, spreadAim: declaredAim, attackTotal: 9, toHitDC: 15 }), shooterPlaceable)));
    await wipeZones(); await wipeCards();
  }

  /* ── §14i  THE BASE'S RULING REACHES THE PLANT, AND A FUMBLE PLANTS NOTHING ───────────────── */
  // Reported from the table 2026-08-26: a shell that FUMBLED posted the base system's fumble card and
  // drew no presentation at all — and this flow planted a corridor anyway and put a card over it reading
  // "Attack 31 vs 15 — HIT". One shot, two verdicts, in the same chat log. The mechanism was that the
  // payload carried the roll and the DC but not the base's own RULING, and the base rules on more than
  // the arithmetic (`forceMiss` on every fumble its table resolves). The pure legs for that live in
  // §14a-bis; these are the two behaviours it buys, end to end through the plant.
  await wipeZones(); await wipeCards();
  {
    // (a) A RULED FUMBLE: nothing planted, nothing posted. The presentation rail has skipped its whole
    // fan-out on this field since it shipped, so this is the resolution half of one answer.
    const fumbleSince = new Set(game.messages.map(m => m.id));
    await hooks._placeSpreadZone(basePayload({
      shotsFired: 1, spreadAim: declaredAim, attackTotal: 31, toHitDC: 15, baseHit: false, fumbleRuled: true,
    }));
    await sleep(900);
    ok("§14i a ruled FUMBLE plants no corridor at all",
      myZones().length === 0, String(myZones().length));
    ok("§14i …and posts no resolution card over it — the base's fumble card is the whole account",
      resolveCards().filter(m => !fumbleSince.has(m.id)).length === 0,
      String(resolveCards().filter(m => !fumbleSince.has(m.id)).length));
    // The presentation answers the same way about the same payload, which is the point of the pair —
    // and the identical payload WITHOUT the ruling still describes a corridor, so the null above is the
    // fumble and not the rail being off or the flow disowning the payload.
    const fumbledFxP = basePayload({
      shotsFired: 1, spreadAim: declaredAim, attackTotal: 31, toHitDC: 15, baseHit: false, fumbleRuled: true,
    });
    const notFumbledFxP = basePayload({
      shotsFired: 1, spreadAim: declaredAim, attackTotal: 31, toHitDC: 15, baseHit: false,
    });
    ok("§14i the presentation rail describes no corridor for it either (one answer, two rails)",
      fx.patternCorridorFor(fumbledFxP, shooterPlaceable) === null
      && fx.patternCorridorFor(notFumbledFxP, shooterPlaceable) !== null
      && fxOn === true,
      `fumbled=${fx.patternCorridorFor(fumbledFxP, shooterPlaceable) === null} ` +
      `control=${fx.patternCorridorFor(notFumbledFxP, shooterPlaceable) !== null} fxOn=${fxOn}`);
    await wipeZones(); await wipeCards();

    // (b) A RULED MISS whose NUMBERS say hit — the shape the arithmetic could never see. It scatters
    // like any other miss, and the card says MISS over the same total the base printed.
    const ruledSince = new Set(game.messages.map(m => m.id));
    await hooks._placeSpreadZone(basePayload({
      shotsFired: 1, spreadAim: declaredAim, attackTotal: 31, toHitDC: 15, baseHit: false,
      spreadScatter: { dirFace: 2, distFace: 7 },
    }));
    const ruledCard = await newCardSince(ruledSince);
    const ruledF = myZones()[0]?.flags?.[SCOPE] ?? {};
    ok("§14i a shot the base RULED a miss scatters, though its total stands over the DC",
      ruledF.scattered === true && ruledF.scatterDirFace === 2 && ruledF.scatterDriftM === 7,
      JSON.stringify({ scattered: ruledF.scattered, face: ruledF.scatterDirFace, drift: ruledF.scatterDriftM }));
    ok("§14i and its card prints the base's own verdict beside the base's own total",
      /31/.test(plain(ruledCard)) && /MISS/.test(plain(ruledCard)) && !/HIT/.test(plain(ruledCard)),
      plain(ruledCard).slice(0, 200));
    await wipeZones(); await wipeCards();

    // (c) ⏪ THE LEGACY PAYLOAD IS UNTOUCHED — the same numbers with NO verdict field still plant as a
    // hit, on the comparison, exactly as they did before any of this existed. This is the macro, the
    // keeper placement and the client mid-update, and it is the half that must not move.
    const legacySince = new Set(game.messages.map(m => m.id));
    await hooks._placeSpreadZone(basePayload({
      shotsFired: 1, spreadAim: declaredAim, attackTotal: 31, toHitDC: 15,
    }));
    const legacyCard = await newCardSince(legacySince);
    ok("§14i a payload with NO verdict field keeps the comparison and plants as aimed (negative)",
      (myZones()[0]?.flags?.[SCOPE] ?? {}).scattered === false && /HIT/.test(plain(legacyCard)),
      JSON.stringify({ scattered: myZones()[0]?.flags?.[SCOPE]?.scattered,
                       card: plain(legacyCard).slice(0, 120) }));
    await wipeZones(); await wipeCards();

    /* (d) ⭐⭐ THE ORDINARY-MISS CLASS PLANTS (2026-08-26). Rows 1-4 of the base's table read "no
     * fumble, you just screw up" — a round left the barrel and went somewhere else — so this class is
     * resolved as a miss like any other: the centre goes to the grenade table, the corridor is rebuilt
     * there, and the card is posted over it. Leg (a) above is the SAME payload minus the class, and it
     * still plants nothing, which is what makes this the class doing the work and not the gate falling
     * over. The two faces are carried so the plant cannot reach for dice of its own. */
    const plainSince = new Set(game.messages.map(m => m.id));
    const plainMissP = basePayload({
      shotsFired: 1, spreadAim: declaredAim, attackTotal: 31, toHitDC: 15, baseHit: false,
      fumbleRuled: true, fumbleClass: "plainMiss", spreadScatter: { dirFace: 2, distFace: 7 },
    });
    await hooks._placeSpreadZone(plainMissP);
    const plainCard = await newCardSince(plainSince);
    const plainF = myZones()[0]?.flags?.[SCOPE] ?? {};
    ok("§14i the ordinary-miss class plants a corridor at the SCATTERED centre, off the carried faces",
      myZones().length === 1 && plainF.scattered === true
      && plainF.scatterDirFace === 2 && plainF.scatterDriftM === 7,
      JSON.stringify({ zones: myZones().length, scattered: plainF.scattered,
                       face: plainF.scatterDirFace, drift: plainF.scatterDriftM }));
    ok("§14i …and posts one resolution card reading MISS over the base's own total",
      !!plainCard && /31/.test(plain(plainCard)) && /MISS/.test(plain(plainCard)) && !/HIT/.test(plain(plainCard)),
      plain(plainCard ?? {}).slice(0, 200));
    ok("§14i the presentation rail describes the SAME corridor for it (one answer, two rails)",
      fx.patternCorridorFor(plainMissP, shooterPlaceable) !== null,
      JSON.stringify(fx.patternCorridorFor(plainMissP, shooterPlaceable) ?? null));
    await wipeZones(); await wipeCards();

    /* (e) AND THE OTHER THREE CLASSES PLANT NOTHING, each asserted on its own so a gate that collapsed
     * to "any class plants" or "no class plants" cannot pass. Same payload, same carried faces, same
     * declared corridor — only the class differs, which is the single-variable form of the check. */
    for (const cls of ["noDischarge", "harmlessDischarge", "ownSide"]) {
      const since = new Set(game.messages.map(m => m.id));
      const p = basePayload({
        shotsFired: 1, spreadAim: declaredAim, attackTotal: 31, toHitDC: 15, baseHit: false,
        fumbleRuled: true, fumbleClass: cls, spreadScatter: { dirFace: 2, distFace: 7 },
      });
      await hooks._placeSpreadZone(p);
      await sleep(900);
      const posted = resolveCards().filter(m => !since.has(m.id)).length;
      ok(`§14i the ${cls} class plants no corridor and posts no card, and the rail agrees`,
        myZones().length === 0 && posted === 0 && fx.patternCorridorFor(p, shooterPlaceable) === null,
        JSON.stringify({ cls, zones: myZones().length, cards: posted,
                         corridor: fx.patternCorridorFor(p, shooterPlaceable) }));
      await wipeZones(); await wipeCards();
    }
  }

  /* ── §15  THE ORIGIN IS THE FIGURE THAT FIRED, not the actor's first figure ───────────────── */
  // The plant rebuilds the corridor as AN ANGLE AND A LENGTH FROM AN ORIGIN, and it used to find that
  // origin by scanning the canvas for the first figure whose actor id matched the payload's. An actor id
  // cannot name a figure: two tokens of one actor share it, and an UNLINKED copy's synthetic actor
  // answers the base actor's id as well. So an actor with two figures on the board had every pattern
  // planted from whichever one the canvas drew first — same heading, same reach, same width, the whole
  // polygon translated by the distance between the two figures (reported from the table 2026-08-15,
  // reproduced end to end). The seam has NAMED the firing figure on the payload since it started
  // capturing it at the trigger pull; this section pins that the plant reads that name.
  await wipeZones(); await wipeCards();
  {
    const sq = Number(canvas.dimensions.size);
    const rect15 = canvas.dimensions.sceneRect;
    const inX = (x) => Math.min(Math.max(x, rect15.x), rect15.x + rect15.width - sq);
    const inY = (y) => Math.min(Math.max(y, rect15.y), rect15.y + rect15.height - sq);
    // Two more figures of the ONE shooter, far enough off that a plant from the wrong one cannot be
    // mistaken for rounding: a LINKED duplicate (the dragged-out second token) and an UNLINKED copy
    // (the id-collision class — its synthetic actor answers the base actor's id).
    const [gunnerTwo] = await scene.createEmbeddedDocuments("Token", [{
      name: "__PWK__SPREAD Gunner Two", actorId: shooter.id, actorLink: true,
      x: inX(shooterTok.x), y: inY(shooterTok.y + 5 * sq), width: 1, height: 1, rotation: 0,
    }]);
    const [gunnerCopy] = await scene.createEmbeddedDocuments("Token", [{
      name: "__PWK__SPREAD Gunner Copy", actorId: shooter.id, actorLink: false,
      x: inX(shooterTok.x + 9 * sq), y: inY(shooterTok.y + 5 * sq), width: 1, height: 1, rotation: 0,
    }]);
    await sleep(700);

    const twoPl  = canvas.tokens.get(gunnerTwo.id) ?? null;
    const copyPl = canvas.tokens.get(gunnerCopy.id) ?? null;
    const onePl  = canvas.tokens.get(shooterTok.id) ?? null;
    const mineOnBoard = () => (canvas?.tokens?.placeables ?? []).filter(t => t.actor?.id === shooter.id);
    // WHAT THE OLD SCAN WOULD HAVE ANSWERED, written as the literal expression the plant used to run —
    // read rather than assumed, because draw order is the canvas's business and the whole point of this
    // section is that it must stop being the plant's.
    const scanned = (canvas?.tokens?.placeables ?? []).find(t => t.actor?.id === shooter.id) ?? null;
    const mOf = (px) => grid.pixelsToMeters(scene, px);
    const gapM = (a, b) => (a && b) ? mOf(Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y)) : NaN;
    const say15 = (p) => p ? `(${Number(p.x).toFixed(0)}, ${Number(p.y).toFixed(0)})` : "null";
    const sayOrigin = (r) => r ? `(${Number(r.originX).toFixed(0)}, ${Number(r.originY).toFixed(0)})` : "null";

    ok("§15 three figures of ONE actor stand on the board, apart from each other",
      mineOnBoard().length === 3 && gapM(onePl, twoPl) > 2 && gapM(twoPl, copyPl) > 2 && gapM(onePl, copyPl) > 2,
      `count=${mineOnBoard().length} one↔two ${gapM(onePl, twoPl).toFixed(1)}m two↔copy ${gapM(twoPl, copyPl).toFixed(1)}m one↔copy ${gapM(onePl, copyPl).toFixed(1)}m`);
    ok("§15 the UNLINKED copy's own actor answers the base actor's id — the collision the scan cannot see",
      copyPl?.actor?.isToken === true && copyPl?.actor?.id === shooter.id,
      `isToken=${copyPl?.actor?.isToken} id=${copyPl?.actor?.id} base=${shooter.id}`);
    ok("§15 so an actor-id scan can only answer ONE of the three, whichever the canvas drew first",
      !!scanned && mineOnBoard().every(t => t.actor?.id === scanned.actor?.id),
      `scan answers ${scanned?.document?.name ?? scanned?.name}`);
    // THE PREMISE THE TWO NEGATIVES BELOW REST ON. If draw order ever stops answering the first-placed
    // figure this leg reds and says so, rather than letting a negative pass because the two answers
    // happened to coincide.
    ok("§15 and the one it answers is the figure that was on the board FIRST, not either duplicate",
      scanned?.id === shooterTok.id, `${scanned?.document?.name ?? scanned?.name} · expected __PWK__SPREAD Gunner`);

    // A corridor declared FROM a given figure, so the aim record and the figure agree and the only
    // question left for the plant is which figure it takes the origin off.
    const aimFrom = (pl, reachM = 8) => ({
      sceneId: scene.id, originX: pl.center.x, originY: pl.center.y,
      angleDeg: 0, reachM, lengthM: reachM + scOvershootM, widthM: 2, band: "Medium", dmgFormula: "3d6",
    });
    const plantFrom = async (over) => {
      await wipeZones(); await wipeCards();
      await hooks._placeSpreadZone(basePayload({ shotsFired: 1, attackTotal: 30, toHitDC: 15, ...over }));
      await sleep(600);
      return myZones()[0]?.flags?.[SCOPE] ?? {};
    };
    const plantedAt = (f) => (f && f.originX !== undefined) ? { x: Number(f.originX), y: Number(f.originY) } : null;
    const onCentre = (f, pl) => { const p = plantedAt(f); return !!p && !!pl && Math.abs(p.x - pl.center.x) < 0.5 && Math.abs(p.y - pl.center.y) < 0.5; };

    // §15a — the payload NAMES the figure, and the plant takes the origin off that one.
    const namedTwo = await plantFrom({ attackerTokenId: gunnerTwo.id, spreadAim: aimFrom(twoPl) });
    ok("§15 a payload naming the SECOND figure plants the corridor from the second figure, by value",
      onCentre(namedTwo, twoPl),
      `planted ${say15(plantedAt(namedTwo))} · fired-from ${say15(twoPl?.center)} · first figure ${say15(scanned?.center)}`);
    ok("§15 and not from the figure the actor-id scan reaches (negative — this is where it used to plant)",
      !!plantedAt(namedTwo) && Math.hypot(plantedAt(namedTwo).x - (scanned?.center?.x ?? 0), plantedAt(namedTwo).y - (scanned?.center?.y ?? 0)) > sq,
      `planted ${say15(plantedAt(namedTwo))} · scan's figure ${say15(scanned?.center)}`);

    const namedCopy = await plantFrom({ attackerTokenId: gunnerCopy.id, spreadAim: aimFrom(copyPl) });
    ok("§15 a payload naming the UNLINKED copy plants from the copy, id collision and all, by value",
      onCentre(namedCopy, copyPl),
      `planted ${say15(plantedAt(namedCopy))} · fired-from ${say15(copyPl?.center)}`);

    // §15b — THE FALLBACK IS UNCHANGED. A payload that carries no such field (a direct macro call, a
    // build older than the seam change) still gets exactly the answer it always got: the actor scan's.
    const unnamed = await plantFrom({ attackerTokenId: undefined, spreadAim: aimFrom(scanned) });
    ok("§15 a payload naming NO figure still falls back to the actor scan, by value (negative)",
      onCentre(unnamed, scanned),
      `planted ${say15(plantedAt(unnamed))} · scan's figure ${say15(scanned?.center)}`);
    const namedGhost = await plantFrom({ attackerTokenId: "__PWK__notAFigure", spreadAim: aimFrom(scanned) });
    ok("§15 and a named figure this canvas is not drawing falls back the same way, rather than refusing",
      onCentre(namedGhost, scanned),
      `planted ${say15(plantedAt(namedGhost))} · scan's figure ${say15(scanned?.center)}`);
    await wipeZones(); await wipeCards();

    // §15c — THE DIAGNOSIS'S OWN REPRO, driven as the real gesture: select the second figure, fire from
    // the sheet, drag a corridor, confirm it, force the roll to land, and read the region that appears.
    const refWas15 = shooter.system.stats?.ref?.base;
    const origRU15 = CONFIG.Dice.randomUniform;
    let firedTwo = null, hook15 = null;
    try {
      await scene.deleteEmbeddedDocuments("Token", [gunnerCopy.id]).catch(() => {});
      await sleep(500);
      twoPl?.control({ releaseOthers: true });
      await sleep(250);
      ok("§15 the selected figure is the one the seam names as the firer, by value",
        seam.firingTokenIdOf(shooter) === gunnerTwo.id,
        `${seam.firingTokenIdOf(shooter)} vs second figure ${gunnerTwo.id}`);

      hook15 = Hooks.on("cyberpunk2020.weaponFired", (p) => { if (!firedTwo) firedTwo = p; });
      await sheet.render(true);
      await sleep(800);
      const gesture15 = sheet._cpOpenWeaponAttackDialog(aimGun);
      await sleep(500);
      const aim15 = { x: inX(twoPl.center.x + 4 * sq), y: twoPl.center.y };
      const click15 = await aimAt(aim15.x, aim15.y);
      canvas.app.view.dispatchEvent(new PointerEvent("pointerdown", { clientX: click15.x, clientY: click15.y, button: 0, bubbles: true }));
      const dlg15 = await gesture15;
      await sleep(700);
      ok("§15 the drag-aim from the second figure confirms into the ordinary modifiers window",
        dlg15?.constructor?.name === "ModifiersDialog" && !!dlg15?.element, dlg15?.constructor?.name ?? String(dlg15));

      // Forced to LAND, for §10's reason: a declared corridor that misses goes to the grenade table, and
      // this section's subject is the origin, not the scatter. REF 10 + a 9 on the exploding d10.
      await shooter.update({ "system.stats.ref.base": 10 });
      CONFIG.Dice.randomUniform = (() => { const Q = [1 - (9 - 0.5) / 10]; return () => (Q.length ? Q.shift() : 0.5); })();
      const form15 = dlg15?.element?.tagName === "FORM" ? dlg15.element : dlg15?.element?.querySelector("form");
      if (form15?.requestSubmit) form15.requestSubmit();
      else form15?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await sleep(2000);

      const gz = myZones()[0]?.flags?.[SCOPE] ?? {};
      const ghost = firedTwo?.spreadAim ?? null;
      ok("§15 the shot LANDED, so the corridor below is the declared one and not a scattered one",
        firedTwo?.attackTotal >= firedTwo?.toHitDC, `${firedTwo?.attackTotal} vs ${firedTwo?.toHitDC}`);
      ok("§15 the fired payload carries the figure that fired, by value",
        firedTwo?.attackerTokenId === gunnerTwo.id, `${firedTwo?.attackerTokenId} vs ${gunnerTwo.id}`);
      ok("§15 the ghost the shooter drew is anchored to that same figure, by value",
        !!ghost && Math.abs(Number(ghost.originX) - twoPl.center.x) < 0.5 && Math.abs(Number(ghost.originY) - twoPl.center.y) < 0.5,
        `ghost ${sayOrigin(ghost)} · second figure ${say15(twoPl?.center)}`);
      ok("§15 the pattern is planted", !!myZones()[0], String(myZones().length));
      const ghostGapM = (!!ghost && !!plantedAt(gz))
        ? mOf(Math.hypot(Number(ghost.originX) - plantedAt(gz).x, Number(ghost.originY) - plantedAt(gz).y)) : NaN;
      const firstGapM = (!!plantedAt(gz) && !!onePl)
        ? mOf(Math.hypot(plantedAt(gz).x - onePl.center.x, plantedAt(gz).y - onePl.center.y)) : NaN;
      ok("§15 THE REGION IS PLANTED FROM THE FIGURE THAT FIRED, by value",
        onCentre(gz, twoPl),
        `planted ${say15(plantedAt(gz))} · fired-from ${say15(twoPl?.center)} · first figure ${say15(onePl?.center)}`);
      ok("§15 the ghost and the region share ONE origin — zero gap, by value",
        ghostGapM < 0.01, `gap ${Number.isFinite(ghostGapM) ? ghostGapM.toFixed(2) : "n/a"} m`);
      ok("§15 and it is NOT translated onto the first figure (negative — the reported symptom)",
        firstGapM > 2, `offset from first figure ${Number.isFinite(firstGapM) ? firstGapM.toFixed(1) : "n/a"} m`);
    } finally {
      CONFIG.Dice.randomUniform = origRU15;
      if (hook15 !== null) Hooks.off("cyberpunk2020.weaponFired", hook15);
      await shooter.update({ "system.stats.ref.base": refWas15 }).catch(() => {});
      await closeModifiers();
      for (const t of [gunnerTwo, gunnerCopy]) await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
      canvas?.tokens?.releaseAll?.();
      await wipeZones(); await wipeCards();
      await sleep(600);
    }

    // §15d — THE ONE-FIGURE CONTROL. The duplicates gone, the actor answers one figure again and both
    // routes — named and unnamed — put the corridor on it. Zero gap, as it was before any of this.
    ok("§15 the duplicates are off the board again", mineOnBoard().length === 1, String(mineOnBoard().length));
    const soloPl = mineOnBoard()[0] ?? null;
    const soloNamed = await plantFrom({ attackerTokenId: soloPl?.id, spreadAim: aimFrom(soloPl) });
    ok("§15 one figure, payload names it — planted on it, zero gap, by value", onCentre(soloNamed, soloPl),
      `planted ${say15(plantedAt(soloNamed))} · figure ${say15(soloPl?.center)}`);
    const soloUnnamed = await plantFrom({ attackerTokenId: undefined, spreadAim: aimFrom(soloPl) });
    ok("§15 one figure, payload names none — planted on it just the same, by value", onCentre(soloUnnamed, soloPl),
      `planted ${say15(plantedAt(soloUnnamed))} · figure ${say15(soloPl?.center)}`);
    await wipeZones(); await wipeCards();

    // §15e — THE SIBLING PLACEMENTS, read off the served source. The gas cloud and the blast centre on
    // the thrower's own figure when nothing is targeted, and misplaced the same way for the same reason.
    // They have no suite of their own to plant in, and neither is exported, so the guard is that all
    // three untargeted placements now ask ONE reader and none of them scans by actor id on its own.
    ok("§15 all three untargeted placements resolve the firing figure through the one shared reader",
      (dhSrc.match(/const atk = _firingTokenOf\(payload\);/g) ?? []).length === 3,
      String((dhSrc.match(/const atk = _firingTokenOf\(payload\);/g) ?? []).length));
    ok("§15 that reader asks the payload for the figure BEFORE it scans anything",
      /function _firingTokenOf\(payload\)[\s\S]{0,300}?canvas\?\.tokens\?\.get\(payload\.attackerTokenId\)/.test(dhSrc),
      "named-first shape in the served source");
    ok("§15 and the actor-id scan survives in exactly ONE place — the shared fallback (negative)",
      (dhSrc.match(/placeables\?\.find\(t => t\.actor\?\.id === attackerId\)/g) ?? []).length === 1,
      String((dhSrc.match(/placeables\?\.find\(t => t\.actor\?\.id === attackerId\)/g) ?? []).length));
    ok("§15 the stale note claiming the payload carries no attacker token id is gone (negative)",
      !/carry no attacker token id/i.test(dhSrc));
  }

  /* ── §16  THE BAND EDGES ARE THE FIRING WEAPON'S OWN RANGE ───────────────────────────────── */
  // The shotgun table (Core p.109) prints its pattern AGAINST THE RANGE BANDS — Close·PB 1 m 4D6,
  // Medium 2 m 3D6, Long 3 m 2D6 — and the bands themselves are defined per weapon on p.99: Point Blank
  // is touching to 1 m, Close is a QUARTER of the weapon's Long range, Medium a HALF, Long the full
  // range. So the metre at which a pattern stops being Close is a fact about the GUN. This ladder used
  // to hard-code 6 m / 25 m, which is one particular weapon's answer applied to every weapon.
  //
  // The legs read the pure ladder first (no document, no canvas), then the same rule through the real
  // aim preview and through the plant, so a derivation that is right in isolation and unthreaded at one
  // of its four call sites cannot pass.
  await wipeZones(); await wipeCards();
  {
    const magBefore16 = magazine();
    const B = (d, r) => lookup.spreadBandSpec(d, {}, r);
    const dmgOf = (d, r) => lookup.spreadBandDamage(B(d, r).band);
    // What the preview's readout must SAY for a reach measured against a given weapon range — the same
    // re-derivation §11's helper does, with the range threaded through it.
    const readoutFor16 = (reachM, r) => {
      const spec = lookup.spreadBandSpec(reachM, {}, r);
      const widthM = Math.max(placement.SPREAD_MIN_WIDTH_M, spec.widthM);
      return `${game.i18n.localize(`CYBERPUNK.SpreadBand${spec.band}`)} band — ${widthM}m wide, ${lookup.spreadBandDamage(spec.band)}`;
    };

    /* §16a — the three rungs, by value, out of a 40 m gun (edges: 10 m and 20 m) */
    ok("§16 inside a quarter of the weapon's range the Close·PB row applies — 1 m, 4d6, by value",
      B(8, 40).band === "Short" && B(8, 40).widthM === 1 && dmgOf(8, 40) === "4d6",
      JSON.stringify(B(8, 40)));
    ok("§16 between a quarter and a half it is the Medium row — 2 m, 3d6, by value",
      B(15, 40).band === "Medium" && B(15, 40).widthM === 2 && dmgOf(15, 40) === "3d6",
      JSON.stringify(B(15, 40)));
    ok("§16 between a half and the full range it is the Long row — 3 m, 2d6, by value",
      B(22, 40).band === "Long" && B(22, 40).widthM === 3 && dmgOf(22, 40) === "2d6",
      JSON.stringify(B(22, 40)));

    /* §16b — THE EDGES MOVE WITH THE WEAPON, which is the whole change. One distance, three guns. */
    ok("§16 eight metres is Close out of a 40 m gun and Medium out of a 20 m one — the edge is the gun's",
      B(8, 40).band === "Short" && B(8, 20).band === "Medium",
      `40m→${B(8, 40).band} · 20m→${B(8, 20).band}`);
    ok("§16 twenty-two metres is Long out of a 40 m gun and Close out of a 100 m one (negative on fixed metres)",
      B(22, 40).band === "Long" && B(22, 100).band === "Short",
      `40m→${B(22, 40).band} · 100m→${B(22, 100).band}`);
    ok("§16 the boundaries land exactly on the quarter and the half, by value",
      B(10, 40).band === "Short" && B(10.01, 40).band === "Medium"
      && B(20, 40).band === "Medium" && B(20.01, 40).band === "Long",
      JSON.stringify([B(10, 40).band, B(10.01, 40).band, B(20, 40).band, B(20.01, 40).band]));

    /* §16c — the point-blank metre the Close·PB row prints survives a gun whose quarter-range is under it */
    ok("§16 a short-ranged weapon still gives its point-blank metre to the Close·PB row",
      B(1, 4).band === "Short" && B(0.5, 2).band === "Short" && B(1, 2).band === "Short",
      JSON.stringify([B(1, 4).band, B(0.5, 2).band, B(1, 2).band]));
    ok("§16 and past that metre the ladder still climbs rather than collapsing",
      B(1.5, 4).band === "Medium" && B(3, 4).band === "Long",
      JSON.stringify([B(1.5, 4).band, B(3, 4).band]));

    /* §16d — PAST THE WEAPON'S FULL RANGE the Long row continues. The table prints no Extreme row, so
     * this is a stated interpretation rather than a printed rule: the last row continues, and no fourth
     * width is invented. Also the reason the scatter needs no cap. */
    ok("§16 past the weapon's full range the Long row continues — no fourth width is invented",
      B(41, 40).band === "Long" && B(500, 40).band === "Long"
      && B(500, 40).widthM === 3 && dmgOf(500, 40) === "2d6",
      JSON.stringify(B(500, 40)));

    /* §16e — the COMPAT PATH: a caller that names no range keeps the edges this module always used */
    ok("§16 the compat edges are the documented six and twenty-five",
      lookup.SPREAD_LEGACY_CLOSE_EDGE_M === 6 && lookup.SPREAD_LEGACY_MEDIUM_EDGE_M === 25,
      `${lookup.SPREAD_LEGACY_CLOSE_EDGE_M} / ${lookup.SPREAD_LEGACY_MEDIUM_EDGE_M}`);
    ok("§16 no range named → the old fixed edges, by value (the compat path, not the rule)",
      B(6, null).band === "Short" && B(6.01, null).band === "Medium"
      && B(25, null).band === "Medium" && B(25.01, null).band === "Long",
      JSON.stringify([B(6, null).band, B(6.01, null).band, B(25, null).band, B(25.01, null).band]));
    ok("§16 a range of zero, a blank one and a nonsense one all fall back the same way (negative)",
      B(8, 0).band === "Medium" && B(8, undefined).band === "Medium"
      && B(8, "").band === "Medium" && B(8, "x").band === "Medium" && B(8, -50).band === "Medium",
      JSON.stringify([B(8, 0).band, B(8, undefined).band, B(8, "").band, B(8, "x").band, B(8, -50).band]));
    ok("§16 and an unmeasurable distance is still the Close·PB row, range or no range (negative)",
      B(NaN, 40).band === "Short" && B(null, null).band === "Short",
      JSON.stringify([B(NaN, 40).band, B(null, null).band]));

    /* §16f — the load's own printed widths win at whatever band the weapon's range put the shot in */
    const LW = { short: 5, medium: 6, long: 7 };
    ok("§16 a load's printed width is taken from the band the WEAPON's range chose, by value",
      lookup.spreadBandSpec(8, LW, 40).widthM === 5 && lookup.spreadBandSpec(15, LW, 40).widthM === 6
      && lookup.spreadBandSpec(22, LW, 40).widthM === 7
      && lookup.spreadBandSpec(8, LW, 20).widthM === 6,
      JSON.stringify([lookup.spreadBandSpec(8, LW, 40).widthM, lookup.spreadBandSpec(8, LW, 20).widthM]));

    /* §16g — ONE AIM POINT, THREE GUNS, THROUGH THE REAL PREVIEW.
     *
     * ⚠ THE RANGES ARE DERIVED FROM THE AIM, NOT TYPED. This rig's scene is one metre a square, so the
     * corridor §10 draws is a few metres long and a range typed here as "100 m" would put every reading
     * in the same band and prove nothing. So the three guns are described relative to the aim itself: a
     * gun whose range is 2.5× the aim (quarter-range under it, half-range over it → Medium), a gun whose
     * range IS the aim (half-range under it → Long), and no gun at all (the compat edges → Close, since
     * the aim is inside the old fixed 6 m). The premise leg pins that those three really are different. */
    ok("§16 the aim this section reads is inside the compat Close edge and outside the point-blank metre",
      expectM > 1.5 && expectM <= lookup.SPREAD_LEGACY_CLOSE_EDGE_M, `${expectM} m`);
    const midRangeM = expectM * 2.5, shortRangeM = expectM;
    const readAimWith = async (r) => {
      const g = placement.armSpreadPreview({ shooterToken: shooterPlaceable, ...(r === null ? {} : { rangeM: r }) });
      await sleep(300);
      await aimAt(aimWorld.x, aimWorld.y);
      const line = readout();
      const click = await aimAt(aimWorld.x, aimWorld.y);
      canvas.app.view.dispatchEvent(new PointerEvent("pointerdown", { clientX: click.x, clientY: click.y, button: 0, bubbles: true }));
      return { line, aim: await g };
    };
    const midGun = await readAimWith(midRangeM);
    ok("§16 the preview bands the aim against the gun it is held in — a mid-range gun reads Medium here",
      midGun.line === readoutFor16(expectM, midRangeM) && midGun.aim?.band === "Medium" && Number(midGun.aim?.widthM) === 2,
      `${midGun.line} | corridor ${JSON.stringify({ band: midGun.aim?.band, widthM: midGun.aim?.widthM })}`);
    const shortGun = await readAimWith(shortRangeM);
    ok("§16 the SAME aim point out of a gun whose full range it already is reads Long, by value",
      shortGun.line === readoutFor16(expectM, shortRangeM) && shortGun.aim?.band === "Long" && Number(shortGun.aim?.widthM) === 3,
      `${shortGun.line} | corridor ${JSON.stringify({ band: shortGun.aim?.band, widthM: shortGun.aim?.widthM })}`);
    const noGun = await readAimWith(null);
    ok("§16 and with no range named the same point falls back to the compat edges — Close (negative)",
      noGun.line === readoutFor16(expectM, null) && noGun.aim?.band === "Short" && Number(noGun.aim?.widthM) === 1,
      `${noGun.line} | corridor ${JSON.stringify({ band: noGun.aim?.band, widthM: noGun.aim?.widthM })}`);
    ok("§16 the three readings of that ONE aim point really are three different corridors",
      new Set([midGun.line, shortGun.line, noGun.line]).size === 3,
      [midGun.line, shortGun.line, noGun.line].join(" · "));

    /* §16h — and through the PLANT: one undeclared corridor at one distance, two ranges on the payload.
     * Same derivation of the ranges, and for the same reason. */
    const tgtPl = canvas.tokens.get(target.id) ?? null;
    const tgtM = grid.pixelsToMeters(scene,
      Math.hypot((tgtPl?.center?.x ?? 0) - shooterPlaceable.center.x, (tgtPl?.center?.y ?? 0) - shooterPlaceable.center.y));
    ok("§16 the fixture target stands inside the compat Close edge, so the two plants below must differ",
      tgtM > 1.5 && tgtM <= lookup.SPREAD_LEGACY_CLOSE_EDGE_M, `${tgtM} m`);
    await wipeZones(); await wipeCards();
    await hooks._placeSpreadZone(basePayload({ shotsFired: 1, spreadRangeM: tgtM }));
    await sleep(900);
    const f16long = myZones()[0]?.flags?.[SCOPE] ?? {};
    ok("§16 the plant bands an undeclared corridor against the payload's own weapon range, by value",
      f16long.band === "Long" && Number(f16long.widthM) === 3 && f16long.dmgFormula === "2d6",
      JSON.stringify({ band: f16long.band, widthM: f16long.widthM, dmg: f16long.dmgFormula }));
    await wipeZones(); await wipeCards();
    await hooks._placeSpreadZone(basePayload({ shotsFired: 1 }));
    await sleep(900);
    const f16none = myZones()[0]?.flags?.[SCOPE] ?? {};
    ok("§16 and a payload carrying no range plants exactly what it always planted (negative, compat)",
      f16none.band === "Short" && Number(f16none.widthM) === 1 && f16none.dmgFormula === "4d6",
      JSON.stringify({ band: f16none.band, widthM: f16none.widthM, dmg: f16none.dmgFormula }));
    await wipeZones(); await wipeCards();

    /* §16i — the declared-aim reader derives a missing band against the same range */
    ok("§16 a corridor that names no band derives one against the payload's weapon range, by value",
      hooks.declaredSpreadAim({ spreadAim: { angleDeg: 0, reachM: 8, lengthM: 8, widthM: 1 }, spreadRangeM: 40 })?.band === "Short"
      && hooks.declaredSpreadAim({ spreadAim: { angleDeg: 0, reachM: 8, lengthM: 8, widthM: 1 } })?.band === "Medium",
      JSON.stringify([
        hooks.declaredSpreadAim({ spreadAim: { angleDeg: 0, reachM: 8, lengthM: 8, widthM: 1 }, spreadRangeM: 40 })?.band,
        hooks.declaredSpreadAim({ spreadAim: { angleDeg: 0, reachM: 8, lengthM: 8, widthM: 1 } })?.band,
      ]));

    /* §16j — and the scattered corridor re-derives against it too, so a miss cannot change ladders */
    const sc16 = hooks.scatteredSpreadCorridor({
      originX: 0, originY: 0, declared: { angleDeg: 0, reachM: 20, lengthM: 20, widthM: 2, band: "Medium" },
      rangeM: 100, pixelsPerMeter: 10, dirFace: 2, distFace: 7,
    });
    ok("§16 a scattered corridor is banded against the weapon's range, not against the old fixed metres",
      sc16.band === "Short" && sc16.widthM === 1,
      JSON.stringify({ reachM: sc16.reachM, band: sc16.band, widthM: sc16.widthM }));

    ok("§16 the section spent nothing — the magazine is untouched, by value",
      magazine() === magBefore16, `${magBefore16} → ${magazine()}`);
  }

  /* ── §17  A SCATTERED PATTERN SAYS SO ────────────────────────────────────────────────────── */
  // ⭐ THE SIGNPOST (user ruling 2026-08-16: *"yes, or just some way to let the player know it's behaving
  // as intended"*). A missed pattern's true centre goes to the grenade table, so the corridor that
  // resolves is NOT the corridor the shooter aimed — which from the shooter's seat is indistinguishable
  // from the aim gesture having been ignored. One notification, on the firing client, naming the rolled
  // direction and distance in the same idiom the resolution card uses.
  //
  // Driven as the REAL gesture and the REAL roll, because the thing under test is WHEN the notification
  // is raised: at the seam that assembles the payload, on the client that pulled the trigger.
  await wipeZones(); await wipeCards();
  {
    const utils = await import(`/modules/${SCOPE}/module/utils.js`);
    const notes = [];
    const origInfo = ui.notifications.info.bind(ui.notifications);
    ui.notifications.info = (msg, ...rest) => { notes.push(String(msg)); return origInfo(msg, ...rest); };
    // ⚠ THE SCATTER FACES ARE NOT FORCED, and that is deliberate rather than lazy. The base system rolls
    // an unknown number of dice per fire card between the attack roll and the seam's two faces (measured
    // on this rig: a queue of three was exhausted before the faces were reached, so both defaulted), so a
    // fixed queue pins the wrong rolls. Only the ATTACK die is forced — that one is first, and it is the
    // die that decides hit or miss. The sentence the notification must carry is then re-derived from the
    // faces the payload actually reports, through the shared table and the shared i18n edge, which is a
    // stronger contract than a fixed pair: whatever was rolled, the notice names THAT.
    const noticeFor = (faces) => {
      const d = scatterTable.scatterDriftM(faces?.dirFace, faces?.distFace);
      return d.distanceM
        ? game.i18n.format("CYBERPUNK.SpreadScatterNotice", { dir: utils.tryLocalize(d.name), dist: d.distanceM })
        : game.i18n.localize("CYBERPUNK.SpreadScatterNoticeNoDrift");
    };
    const anyScatterNote = () => notes.filter(n =>
      n === game.i18n.localize("CYBERPUNK.SpreadScatterNoticeNoDrift")
      || /^Shot missed/.test(n));

    const refWas17 = shooter.system.stats?.ref?.base;
    const origRU17 = CONFIG.Dice.randomUniform;
    let missPayload = null, hook17 = null;
    // ⚠ A DECLARED CORRIDOR'S SHOT IS NOT OVER WHEN THE ROLL IS. The plant waits out the presentation
    // and only then posts the resolution card, so a teardown that runs on a fixed sleep can delete the
    // region out from under a card that is still being built — which this suite's own wipe note names
    // as the way to fail a 0-console-errors leg with tidying rather than with the mechanism. Every fire
    // below waits for its card to actually land before anything is wiped.
    const waitForResolveCard = async (since) => {
      for (let i = 0; i < 48; i++) {
        if (resolveCards().some(m => !since.has(m.id))) { await sleep(400); return true; }
        await sleep(250);
      }
      return false;
    };
    try {
      hook17 = Hooks.on("cyberpunk2020.weaponFired", (p) => { missPayload = p; });
      await sheet.render(true);
      await sleep(600);

      /* §17a — a forced MISS: a low attack die against a low REF, then the two grenade faces */
      await shooter.update({ "system.stats.ref.base": 1 });
      const gesture17 = sheet._cpOpenWeaponAttackDialog(aimGun);
      await sleep(500);
      const click17 = await aimAt(aimWorld.x, aimWorld.y);
      canvas.app.view.dispatchEvent(new PointerEvent("pointerdown", { clientX: click17.x, clientY: click17.y, button: 0, bubbles: true }));
      const dlg17 = await gesture17;
      await sleep(600);
      notes.length = 0;                                    // drop the gesture's own "aim armed" notice
      // The ATTACK die only — forced to 2, which misses against this REF and (unlike a forced 10 on the
      // exploding die) terminates. Every later roll, the scatter faces included, falls as it really falls.
      //
      // ⚠ NOT A 1, AND THAT IS THE FIXTURE'S WHOLE POINT NOW (2026-08-26). This section used to force the
      // attack die to 1 to guarantee a miss. With `fumbleTableEnabled` on — the rig's standing state —
      // a natural 1 is not an ordinary miss: the base RULES a fumble, sets `forceMiss`, and posts its own
      // fumble card in place of a result. A ruled fumble now plants no corridor at all and rolls no
      // grenade-table faces (damage-hooks `_placeSpreadZone`, spread-geometry `payloadScattersOnMiss`),
      // matching the presentation rail, which has skipped its whole fan-out on that field since it
      // shipped. So a forced 1 tests the FUMBLE path, not the SCATTER path this section is about, and it
      // red-herringed five legs here the first run after the verdict fix. Two is the smallest die face
      // that misses without being ruled a fumble; the fumble path has its own legs in §14i.
      const Q17 = [1 - (2 - 0.5) / 10];
      CONFIG.Dice.randomUniform = () => (Q17.length ? Q17.shift() : origRU17());
      const since17 = new Set(game.messages.map(m => m.id));
      const form17 = dlg17?.element?.tagName === "FORM" ? dlg17.element : dlg17?.element?.querySelector("form");
      if (form17?.requestSubmit) form17.requestSubmit();
      else form17?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await sleep(1200);
      CONFIG.Dice.randomUniform = origRU17;
      const missCarded = await waitForResolveCard(since17);

      ok("§17 the forced shot MISSED, so there is a scatter to signpost (the premise)",
        Number(missPayload?.attackTotal) < Number(missPayload?.toHitDC),
        `${missPayload?.attackTotal} vs ${missPayload?.toHitDC}`);
      const faces17 = missPayload?.spreadScatter ?? null;
      const wantNotice = noticeFor(faces17);
      const wantDrift = scatterTable.scatterDriftM(faces17?.dirFace, faces17?.distFace);
      ok("§17 the payload carries the two grenade-table faces the notification has to name",
        Number.isFinite(Number(faces17?.dirFace)) && Number.isFinite(Number(faces17?.distFace)),
        JSON.stringify(faces17));
      ok("§17 ONE notification is raised on the firing client, and it is the one those faces produce",
        notes.filter(n => n === wantNotice).length === 1,
        `${notes.filter(n => n === wantNotice).length} of ${notes.length} — wanted: ${wantNotice}`);
      ok("§17 it names the rolled direction and distance in plain language, by value",
        wantDrift.distanceM
          ? (wantNotice.includes(wantDrift.name) && wantNotice.includes(`${wantDrift.distanceM}m`))
          : /no-drift/i.test(wantNotice),
        `faces ${faces17?.dirFace}/${faces17?.distFace} → ${wantNotice}`);
      ok("§17 no SECOND notice is raised for the one pattern (negative)",
        anyScatterNote().length === 1, `${anyScatterNote().length} scatter notices`);
      ok("§17 the missed shot finished its own presentation and posted its card (the shot really ran)",
        missCarded === true, String(missCarded));
      ok("§17 and the pattern really did take those faces, so the notification describes what happened",
        myZones()[0]?.flags?.[SCOPE]?.scattered === true
        && Number(myZones()[0]?.flags?.[SCOPE]?.scatterDirFace) === Number(faces17?.dirFace)
        && Number(myZones()[0]?.flags?.[SCOPE]?.scatterDriftM) === wantDrift.distanceM,
        JSON.stringify({ flags: myZones()[0]?.flags?.[SCOPE]?.scatterDirFace, faces: faces17 }));
      await wipeZones(); await wipeCards();

      /* §17b — a shot that LANDS says nothing (the negative that makes the positive mean something) */
      notes.length = 0;
      missPayload = null;
      await shooter.update({ "system.stats.ref.base": 10 });
      const gestureHit = sheet._cpOpenWeaponAttackDialog(aimGun);
      await sleep(500);
      const clickHit = await aimAt(aimWorld.x, aimWorld.y);
      canvas.app.view.dispatchEvent(new PointerEvent("pointerdown", { clientX: clickHit.x, clientY: clickHit.y, button: 0, bubbles: true }));
      const dlgHit = await gestureHit;
      await sleep(600);
      notes.length = 0;
      const QHit = [1 - (9 - 0.5) / 10];                   // 9, not 10 — a forced maximum explodes forever
      CONFIG.Dice.randomUniform = () => (QHit.length ? QHit.shift() : origRU17());
      const sinceHit = new Set(game.messages.map(m => m.id));
      const formHit = dlgHit?.element?.tagName === "FORM" ? dlgHit.element : dlgHit?.element?.querySelector("form");
      if (formHit?.requestSubmit) formHit.requestSubmit();
      else formHit?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      // ⚠ WAIT FOR THE SHOT, DO NOT TIME IT. This used to be a flat 1200 ms and went red about one
      // run in three with "undefined vs undefined" — the premise leg reporting that no payload had
      // been captured at all, which is the spec out-running its own fixture rather than a defect in
      // the mechanism (the capture hook sits at the fire seam, upstream of everything this section
      // asserts). The submit chain's length is not this spec's to predict: it runs a real roll, a
      // real card and, for the first shot of the pair, a pattern whose own writes are still settling.
      // Polling for the thing the next three legs read makes the wait as long as the shot needs and
      // no longer, and a shot that genuinely never fires still fails — on the assertion, with the
      // same message, after the bound.
      for (let i = 0; i < 40 && missPayload === null; i++) await sleep(100);
      await sleep(400);   // let the payload's own card/pattern chain land before the reads below
      CONFIG.Dice.randomUniform = origRU17;
      await waitForResolveCard(sinceHit);

      ok("§17 the second shot LANDED (the premise of the negative below)",
        Number(missPayload?.attackTotal) >= Number(missPayload?.toHitDC),
        `${missPayload?.attackTotal} vs ${missPayload?.toHitDC}`);
      ok("§17 a shot that lands rolls no faces and raises no scatter notice at all (negative)",
        !missPayload?.spreadScatter && anyScatterNote().length === 0,
        `faces=${JSON.stringify(missPayload?.spreadScatter)} notices=${anyScatterNote().length}`);
    } finally {
      CONFIG.Dice.randomUniform = origRU17;
      ui.notifications.info = origInfo;
      placement.cancelSpreadPreview();               // an aim left armed by a thrown leg must not survive
      if (hook17 !== null) Hooks.off("cyberpunk2020.weaponFired", hook17);
      await shooter.update({ "system.stats.ref.base": refWas17 }).catch(() => {});
      await closeModifiers();
      // ⚠ SETTLE BEFORE TIDYING, NOT AFTER. Two real shots ran in this section and each ends in an async
      // chain the spec does not hold a handle on (the card write, the region's own card-clear). Deleting
      // into one of those is how this suite's teardown logs core's "Region does not exist" and fails its
      // own 0-console-errors leg with housekeeping rather than with the mechanism under test.
      await sleep(1500);
      await wipeZones(); await wipeCards();
      await sleep(600);
    }

    // WHERE the notification is raised, read off the served source: beside the roll at the seam that
    // assembles the payload on the FIRING client — not in the plant, which runs on the active GM and on
    // a player's shot is a different seat entirely.
    const seamSrc17 = await (await fetch(`/modules/${SCOPE}/module/seam-shim.js`, { cache: "no-store" })).text();
    ok("§17 the signpost sits at the seam's own roll site, where the firing client learns both facts",
      /payloadScattersOnMiss\([\s\S]{0,400}?_signpostSpreadScatter\(/.test(seamSrc17)
      && /ui\.notifications\?\.info/.test(seamSrc17),
      "signpost call inside the seam's scatter branch");
    const dhSrc17 = await (await fetch(`/modules/${SCOPE}/module/combat/damage-hooks.js`, { cache: "no-store" })).text();
    ok("§17 and the plant raises no scatter notification of its own (negative — it is the wrong client)",
      !/_signpostSpreadScatter/.test(dhSrc17) && !/SpreadScatterNotice/.test(dhSrc17));
  }

  /* ── cleanup ────────────────────────────────────────────────────────────────────────────── */
  await wipeZones();
  await wipeCards();
  // By NAME, not by the handles this run happens to hold: a handle-only sweep leaves behind anything an
  // earlier aborted run created, and an orphaned fixture token on the review scene is exactly what the
  // user must not find in the morning. Tokens go before actors — a token whose actor is already gone
  // still deletes, but it no longer answers to any of the actor-shaped filters.
  for (const t of [...(scene.tokens ?? [])].filter(t => t.name?.startsWith("__PWK__SPREAD"))) await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
  for (const a of [...game.actors].filter(a => a.name?.startsWith("__PWK__SPREAD"))) await a.delete().catch(() => {});
  out.leftovers = {
    zones: myZones().length,
    cards: [...game.messages].filter(m => /cp-confirm-spread-zone|cp-spread-resolve-list|cp-spread-result-list/.test(m.content ?? "")).length,
    tokens: [...(scene.tokens ?? [])].filter(t => t.name?.startsWith("__PWK__")).length,
    actors: game.actors.filter(a => a.name?.startsWith("__PWK__SPREAD")).length,
  };
  return out;
});

for (const c of res.checks) check(c.n, c.p, c.d);
check("scene left clean (no stray pattern, card, token or actor)",
  res.leftovers.zones === 0 && res.leftovers.cards === 0 && res.leftovers.tokens === 0 && res.leftovers.actors === 0,
  JSON.stringify(res.leftovers));

/* ══ §18  WHO MAY END A SHOT — the pattern card's controls, across two clients ═══════════════════
 *
 * The reported behaviour (2026-08-19): the Apply Spread Damage / Clear Pattern controls rendered for
 * EVERY viewer of the card, so any player at the table could resolve — or void — somebody else's shot.
 * The ruling (2026-08-20) names three people: the two elevated roles, and the user whose client fired
 * the shell.
 *
 * Two corridors are planted so ONE extra client covers both directions: corridor A is recorded as
 * FIRED BY the player, corridor B as fired by the GM. The same player then reads both cards.
 *
 * ⚠ HIDING A BUTTON IS NOT THE GATE, so the negative is driven through the module's own entry point
 * rather than through the DOM: the player calls the resolve function directly for the corridor that is
 * not theirs, which is what a press would have reached, and the corridor must survive it.
 *
 * This section runs AFTER the main run's own teardown, so the leftovers assertion above still reports
 * a clean scene; §18 cleans up after itself and is checked the same way. */
const gateSetup = await page.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { checks: [], err: "" };
  const ok = (n, p, d = "") => out.checks.push({ n, p, d: String(d) });
  try {
    const DH = await import(`/modules/${SCOPE}/module/combat/damage-hooks.js`);
    const scene = canvas.scene;
    const player = game.users.find(u => u.role === CONST.USER_ROLES.PLAYER && /Test User 1/i.test(u.name))
      ?? game.users.find(u => u.role === CONST.USER_ROLES.PLAYER);
    if (!player) throw new Error("no PLAYER-role user on this rig to run the gate against");
    out.playerId = player.id;
    out.playerName = player.name;
    out.gmId = game.user.id;

    // The rule itself, as plain values — every row the ruling names, plus the unrecorded-firer case.
    const asUser = (role, id) => ({ id, role });
    out.table = {
      firerIsPlayer:  DH.mayResolvePattern(player.id, asUser(CONST.USER_ROLES.PLAYER, player.id)),
      otherPlayer:    DH.mayResolvePattern(player.id, asUser(CONST.USER_ROLES.PLAYER, "someone-else")),
      trusted:        DH.mayResolvePattern(player.id, asUser(CONST.USER_ROLES.TRUSTED, "trusted-user")),
      assistant:      DH.mayResolvePattern(player.id, asUser(CONST.USER_ROLES.ASSISTANT, "assistant-user")),
      gamemaster:     DH.mayResolvePattern(player.id, asUser(CONST.USER_ROLES.GAMEMASTER, "gm-user")),
      noFirerPlayer:  DH.mayResolvePattern("", asUser(CONST.USER_ROLES.PLAYER, player.id)),
      noFirerGm:      DH.mayResolvePattern("", asUser(CONST.USER_ROLES.GAMEMASTER, "gm-user")),
      noUser:         DH.mayResolvePattern(player.id, null),
    };

    // Fixtures: a shooter and a figure to stand in the corridor.
    const shooter = await Actor.create({ name: "__PWK__SPREADGATE Shooter", type: "character" });
    const victim  = await Actor.create({ name: "__PWK__SPREADGATE Victim",  type: "character" });
    await victim.update({ "system.damage": 0, "system.stats.bt.value": 5 });
    const grid = scene.grid?.size ?? 100;
    const [sTok, vTok] = [
      (await scene.createEmbeddedDocuments("Token", [{ name: "__PWK__SPREADGATE S", actorId: shooter.id,
        actorLink: true, x: 6 * grid, y: 6 * grid, width: 1, height: 1,
        texture: { src: "icons/svg/mystery-man.svg" } }]))[0],
      (await scene.createEmbeddedDocuments("Token", [{ name: "__PWK__SPREADGATE V", actorId: victim.id,
        actorLink: true, x: 9 * grid, y: 6 * grid, width: 1, height: 1,
        texture: { src: "icons/svg/mystery-man.svg" } }]))[0],
    ];
    await sleep(400);
    const payloadFrom = (firer) => ({
      attackerId: shooter.id, weaponName: "__PWK__SPREADGATE Shell Gun",
      areaDamages: { Torso: [{ damage: 7 }] }, shotsFired: 1, shotsHit: 1,
      targetTokenId: vTok.id, fxTargetTokenId: vTok.id, firedByUserId: firer,
      caliber: "00", modifier: "standard", spreadMode: "single",
      spreadDamageShort: "3", spreadDamageMedium: "3", spreadDamageLong: "3",
    });

    const gateZones = () => [...(scene.regions ?? [])]
      .filter(r => r.flags?.[SCOPE]?.isSpreadZone === true
        && /__PWK__SPREADGATE/.test(String(r.flags?.[SCOPE]?.weaponName ?? "")));
    for (const r of gateZones()) await r.delete().catch(() => {});

    await DH._placeSpreadZone(payloadFrom(player.id));
    await sleep(700);
    const zoneA = gateZones().find(r => r.flags[SCOPE].firedByUserId === player.id) ?? null;
    await DH._placeSpreadZone(payloadFrom(game.user.id));
    await sleep(700);
    const zoneB = gateZones().find(r => r.flags[SCOPE].firedByUserId === game.user.id) ?? null;

    ok("§18 the pattern records WHICH USER fired it, not just which actor",
      zoneA?.flags?.[SCOPE]?.firedByUserId === player.id && zoneA?.flags?.[SCOPE]?.attackerId === shooter.id,
      `firer=${zoneA?.flags?.[SCOPE]?.firedByUserId} actor=${zoneA?.flags?.[SCOPE]?.attackerId}`);
    ok("§18 the second corridor records the other user (the two fixtures really differ)",
      !!zoneB && zoneB.flags[SCOPE].firedByUserId === game.user.id && zoneB.id !== zoneA?.id,
      `${zoneA?.id} / ${zoneB?.id}`);

    const cardA = game.messages.get(String(zoneA?.flags?.[SCOPE]?.cardMessageId ?? "")) ?? null;
    const cardB = game.messages.get(String(zoneB?.flags?.[SCOPE]?.cardMessageId ?? "")) ?? null;
    ok("§18 the firer travels onto the CARD too, so a client with no region can still be told",
      cardA?.getFlag(SCOPE, "patternFirer") === player.id
      && cardB?.getFlag(SCOPE, "patternFirer") === game.user.id,
      `${cardA?.getFlag(SCOPE, "patternFirer")} / ${cardB?.getFlag(SCOPE, "patternFirer")}`);

    // The GM's own view: both cards keep both controls, whoever fired them.
    await sleep(500);
    const domOf = (id) => document.querySelector(`.message[data-message-id="${id}"], li[data-message-id="${id}"]`);
    const ctlCount = (id) => domOf(id)?.querySelectorAll(".cp-confirm-spread-zone, .cp-clear-spread-zone").length ?? -1;
    ok("§18 a GM keeps both controls on a corridor a PLAYER fired", ctlCount(cardA?.id) === 2, String(ctlCount(cardA?.id)));
    ok("§18 a GM keeps both controls on their own corridor too", ctlCount(cardB?.id) === 2, String(ctlCount(cardB?.id)));

    out.zoneA = zoneA?.id ?? ""; out.zoneB = zoneB?.id ?? "";
    out.cardA = cardA?.id ?? ""; out.cardB = cardB?.id ?? "";
    out.victimId = victim.id;
  } catch (e) { out.err = String(e?.message ?? e); }
  return out;
});
for (const c of gateSetup.checks) check(c.n, c.p, c.d);
check("§18 the two-client fixture was built", !gateSetup.err, gateSetup.err);
{
  const t = gateSetup.table ?? {};
  check("§18 rule: the user who fired it may resolve it", t.firerIsPlayer === true, String(t.firerIsPlayer));
  check("§18 rule NEGATIVE: another player at the same table may not", t.otherPlayer === false, String(t.otherPlayer));
  check("§18 rule NEGATIVE: a TRUSTED player is still below the floor", t.trusted === false, String(t.trusted));
  check("§18 rule: an assistant GM may", t.assistant === true, String(t.assistant));
  check("§18 rule: a gamemaster may", t.gamemaster === true, String(t.gamemaster));
  check("§18 rule NEGATIVE: a corridor naming no firer is not resolvable by a plain player",
    t.noFirerPlayer === false, String(t.noFirerPlayer));
  check("§18 rule: but the elevated roles still may resolve one", t.noFirerGm === true, String(t.noFirerGm));
  check("§18 rule NEGATIVE: no user, no permission", t.noUser === false, String(t.noUser));
}

const playerPage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
playerPage.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(m.text())) errors.push("player: " + m.text()); });
playerPage.on("pageerror", e => errors.push("player: " + e.message));
let gatePlayer = { checks: [], err: "no player client" };
if (!gateSetup.err && gateSetup.playerName) {
  try {
    await playerPage.goto(`${URL}/join`);
    await playerPage.waitForSelector('select[name="userid"]');
    await playerPage.evaluate((name) => {
      const sel = document.querySelector('select[name="userid"]');
      sel.value = [...sel.options].find(o => o.textContent.trim() === name).value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, gateSetup.playerName);
    // The rig's player fixtures are password-less; the rig password is tried as the fallback.
    for (const pw of ["", PW]) {
      await playerPage.fill('input[name="password"]', pw);
      await Promise.all([
        playerPage.waitForNavigation({ url: /\/game/, timeout: 20000 }).catch(() => {}),
        playerPage.click('button[name="join"]'),
      ]);
      try { await playerPage.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 20000 }); break; }
      catch { await playerPage.goto(`${URL}/join`); await playerPage.waitForSelector('select[name="userid"]'); }
    }
    gatePlayer = await playerPage.evaluate(async (ids) => {
      const SCOPE = "cp2020-augmented";
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const out = { checks: [], err: "" };
      const ok = (n, p, d = "") => out.checks.push({ n, p, d: String(d) });
      try {
        const DH = await import(`/modules/${SCOPE}/module/combat/damage-hooks.js`);
        ok("§18 the second client is a plain PLAYER, not a GM (the premise)",
          game.user.isGM === false && game.user.role === CONST.USER_ROLES.PLAYER,
          `isGM=${game.user.isGM} role=${game.user.role}`);
        ok("§18 the rule agrees on this client: their own corridor yes, the GM's no",
          DH.mayResolvePattern(game.user.id, game.user) === true
          && DH.mayResolvePattern(ids.gmId, game.user) === false, "");

        await sleep(1500);
        const domOf = (id) => document.querySelector(`.message[data-message-id="${id}"], li[data-message-id="${id}"]`);
        const cardBEl = domOf(ids.cardB);
        const cardAEl = domOf(ids.cardA);
        ok("§18 the player can SEE both cards — the card is not hidden, only its controls (the premise)",
          !!cardAEl && !!cardBEl, `A=${!!cardAEl} B=${!!cardBEl}`);
        ok("§18 a corridor somebody ELSE fired shows the player NO controls",
          (cardBEl?.querySelectorAll(".cp-confirm-spread-zone, .cp-clear-spread-zone").length ?? -1) === 0,
          String(cardBEl?.querySelectorAll(".cp-confirm-spread-zone, .cp-clear-spread-zone").length));
        ok("§18 and the card's own text is still there — they can read what happened",
          (cardBEl?.textContent ?? "").trim().length > 0 && !/CYBERPUNK\./.test(cardBEl?.textContent ?? ""),
          (cardBEl?.textContent ?? "").slice(0, 60));
        ok("§18 their OWN corridor keeps both controls",
          (cardAEl?.querySelectorAll(".cp-confirm-spread-zone, .cp-clear-spread-zone").length ?? -1) === 2,
          String(cardAEl?.querySelectorAll(".cp-confirm-spread-zone, .cp-clear-spread-zone").length));

        // THE FORGED PRESS: the module's own entry point, called for the corridor that is not theirs.
        const warns = [];
        const realWarn = ui.notifications.warn.bind(ui.notifications);
        ui.notifications.warn = (m, ...r) => { warns.push(String(m)); return realWarn(m, ...r); };
        try {
          await DH._confirmSpreadZone(ids.zoneB);
          await sleep(900);
          await DH._clearSpreadZone(ids.zoneB, ids.cardB);
          await sleep(900);
        } finally { ui.notifications.warn = realWarn; }
        ok("§18 a forged apply/clear on somebody else's corridor is REFUSED, and says so",
          warns.length === 2 && warns.every(w => !/CYBERPUNK\./.test(w)), warns.join(" | "));

        // THE REAL PRESS on their own corridor, through the button that is actually rendered.
        cardAEl?.querySelector(".cp-confirm-spread-zone")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await sleep(2500);
        out.pressed = true;
      } catch (e) { out.err = String(e?.message ?? e); }
      return out;
    }, { cardA: gateSetup.cardA, cardB: gateSetup.cardB, zoneA: gateSetup.zoneA, zoneB: gateSetup.zoneB, gmId: gateSetup.gmId });
  } catch (e) { gatePlayer = { checks: [], err: String(e?.message ?? e) }; }
}
for (const c of (gatePlayer.checks ?? [])) check(c.n, c.p, c.d);
check("§18 the player client ran", !gatePlayer.err, gatePlayer.err ?? "");

const gateAfter = await page.evaluate(async (ids) => {
  const SCOPE = "cp2020-augmented";
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(1500);
  const scene = canvas.scene;
  const victim = game.actors.get(ids.victimId);
  const out = {
    zoneBAlive: !!scene.regions?.get?.(ids.zoneB),
    zoneAGone: !scene.regions?.get?.(ids.zoneA),
    cardBCleared: game.messages.get(ids.cardB)?.getFlag(SCOPE, "spreadCleared") === true,
    victimDamage: Number(victim?.system?.damage) || 0,
  };
  // teardown, by name
  for (const r of [...(scene.regions ?? [])].filter(r => /__PWK__SPREADGATE/.test(String(r.flags?.[SCOPE]?.weaponName ?? "")))) await r.delete().catch(() => {});
  await sleep(300);
  for (const m of [...game.messages].filter(m => /__PWK__SPREADGATE/.test(m.content ?? ""))) await m.delete().catch(() => {});
  for (const t of [...(scene.tokens ?? [])].filter(t => t.name?.startsWith("__PWK__SPREADGATE"))) await scene.deleteEmbeddedDocuments("Token", [t.id]).catch(() => {});
  for (const a of [...game.actors].filter(a => a.name?.startsWith("__PWK__SPREADGATE"))) await a.delete().catch(() => {});
  out.leftovers = [...(scene.regions ?? [])].filter(r => /__PWK__SPREADGATE/.test(String(r.flags?.[SCOPE]?.weaponName ?? ""))).length
    + [...game.actors].filter(a => a.name?.startsWith("__PWK__SPREADGATE")).length
    + [...(scene.tokens ?? [])].filter(t => t.name?.startsWith("__PWK__SPREADGATE")).length;
  return out;
}, { zoneA: gateSetup.zoneA, zoneB: gateSetup.zoneB, cardB: gateSetup.cardB, victimId: gateSetup.victimId });
check("§18 the refused corridor is STILL ON THE TABLE — nothing was applied and nothing was voided",
  gateAfter.zoneBAlive === true && gateAfter.cardBCleared === false,
  `alive=${gateAfter.zoneBAlive} cleared=${gateAfter.cardBCleared}`);
check("§18 the firer's own press went through — their corridor resolved and is gone",
  gateAfter.zoneAGone === true, String(gateAfter.zoneAGone));
check("§18 and it really applied — the figure in that corridor took damage",
  gateAfter.victimDamage > 0, `${gateAfter.victimDamage} damage`);
check("§18 the section left the scene clean", gateAfter.leftovers === 0, String(gateAfter.leftovers));

check("0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
