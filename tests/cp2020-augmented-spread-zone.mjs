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
 * §11 the aim preview's TWO WHEELS — the plain one is the house WIDTH override (a metre a notch, floored
 *     at a metre, marked in the readout, planted on the region), shift+wheel is the reach fine-tune;
 *     read through the readout the rule derives, the confirmed corridor and the planted region, plus the
 *     board gate, both floors, the per-aim reset, and the plant's own floor
 * §12 a pattern nobody applied is still collected by its own clock (the card does not make it immortal)
 * §13 the save cadences — at Mortal BOTH saves are asked for, on their two clocks: one death prompt per
 *     application batch, a stun prompt per damage event; plus the stabilized gate this rail now shares
 *     with the single-target one, and the p.105 rule that clears stabilization before either can read it
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
  };
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
  // The lane is 20m at this scene's 5m grid, which is the Medium band — so the geometry above is
  // pinned to a known band rather than to whatever the fixtures happened to land on.
  ok("§4 the fixture lane resolves to the Medium band", zf.band === "Medium", zf.band);
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

  // ⛔ THE SHOWCASE ENCOUNTER ON THIS RIG IS THE USER'S AND IS NOT TOUCHED. Both expiry rules are
  // therefore asserted the way they are actually decided — as two pure predicates, by value — and then
  // driven live: the round rule through the same `updateCombat` hook core raises (with the encounter's
  // OWN current round, so nothing about it moves), the clock rule through the real sweep.
  const showcase = game.combats.active;
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
  if (showcase?.started) {
    // Backdate the pattern by one round, then raise the round-advance hook with the encounter EXACTLY
    // as it stands. Nothing about the user's combat is written; only the pattern moved.
    await roundZone.setFlag(SCOPE, "createdRound", (showcase.round ?? 1) - 1);
    Hooks.callAll("updateCombat", showcase, { round: showcase.round }, {}, game.user.id);
    await sleep(1200);
    ok("§6 an ignored pattern expires when its own encounter's round advances", myZones().length === 0, String(myZones().length));
    ok("§6 the showcase encounter is untouched by that (still started, same round)",
      showcase.started === true && showcase.round === (game.combats.get(showcase.id)?.round), `round=${showcase.round}`);
  } else {
    await wipeZones();
    ok("§6 (round-expiry live leg skipped: no running encounter on this rig)", true);
    ok("§6 (showcase-untouched leg skipped with it)", true);
  }
  await wipeZones();

  // LIVE clock expiry. A pattern thrown while the showcase encounter runs belongs to it, so the sweep
  // must leave it alone; clearing that ownership models a pattern thrown outside any encounter, which
  // is the only state the clock rule owns.
  await hooks._placeSpreadZone(basePayload());
  await sleep(400);
  const clockZone = myZones()[0];
  let swept = await hooks._sweepStaleSpreadZones();
  ok("§6 the sweep leaves a pattern owned by a running encounter alone",
    !showcase?.started || (swept === 0 && myZones().length === 1), `swept=${swept} left=${myZones().length}`);
  await clockZone.setFlag(SCOPE, "combatId", "");
  swept = await hooks._sweepStaleSpreadZones();
  ok("§6 the sweep leaves a FRESH out-of-combat pattern alone", swept === 0 && myZones().length === 1, `swept=${swept} left=${myZones().length}`);
  await clockZone.setFlag(SCOPE, "createdAt", Date.now() - hooks.SPREAD_ZONE_TTL_MS - 1000);
  swept = await hooks._sweepStaleSpreadZones();
  await sleep(400);
  ok("§6 the sweep expires one past the TTL", swept === 1 && myZones().length === 0, `swept=${swept} left=${myZones().length}`);
  // Litter from the build that had no expiry at all carries neither flag, and must not be immortal.
  await hooks._placeSpreadZone(basePayload());
  await sleep(400);
  await myZones()[0].unsetFlag(SCOPE, "createdAt");
  await myZones()[0].setFlag(SCOPE, "combatId", "");
  swept = await hooks._sweepStaleSpreadZones();
  await sleep(300);
  ok("§6 a pre-rule pattern with no timestamp is swept", swept === 1 && myZones().length === 0, `swept=${swept} left=${myZones().length}`);

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
  const occlusionOn = game.settings.get(SCOPE, "areaEffectOcclusion");
  const [wall] = await scene.createEmbeddedDocuments("Wall", [{ c: [500, 0, 500, 500] }]);
  await sleep(400);
  await wipeCards();
  await hooks._placeSpreadZone(basePayload({ spreadDamageShort: "5", spreadDamageMedium: "5", spreadDamageLong: "5" }));
  await sleep(400);
  const occZone = myZones()[0];
  await hooks._confirmSpreadZone(occZone.id);
  await sleep(1500);
  ok("§7 a token behind a wall is exempted (no result card)",
    !occlusionOn || [...game.messages].filter(m => (m.content ?? "").includes("cp-spread-result-list")).length === 0,
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
  const expectSpec = lookup.spreadBandSpec(expectM, { medium: 2 });
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
  ok("§10 the card waited out the shot's presentation, not the trigger pull",
    !fxOn || (cardAt - rollAt) >= Math.min(floorMs, 400),
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

  /* ── §11  the aim preview's TWO WHEELS ───────────────────────────────────────────────────── */
  // ⭐ THE MAPPING IS THE THING UNDER TEST (user ruling 2026-08-13: the wheel "lengthens instead of
  // widening… It should go meter by meter"). The PLAIN wheel is the corridor's WIDTH — a house override
  // added on top of the book's banded width, a metre a notch, floored so a corridor is never narrower
  // than a metre. SHIFT+wheel is the reach fine-tune the plain wheel used to be. The band and the banded
  // damage stay a pure function of the REACH either way, so a width override must move neither — which
  // is what most of the negatives below say.
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
  // What the readout must SAY for a given reach and width override — re-derived from the same shared
  // ladder the preview reads plus the house floor, so this is a re-derivation of the rule rather than a
  // copy of the sentence. A non-zero override carries the house mark; a zero one must not.
  const widthFor = (reachM, biasM = 0) =>
    Math.max(placement.SPREAD_MIN_WIDTH_M, lookup.spreadBandSpec(reachM).widthM + biasM);
  const readoutFor = (reachM, biasM = 0) => {
    const spec = lookup.spreadBandSpec(reachM);
    const line = `${game.i18n.localize(`CYBERPUNK.SpreadBand${spec.band}`)} band — ${widthFor(reachM, biasM)}m wide, ${lookup.spreadBandDamage(spec.band)}`;
    return biasM === 0 ? line : `${line} ${game.i18n.localize("CYBERPUNK.SpreadWidthHouseMark")}`;
  };

  /* §11a — the PLAIN wheel widens the corridor, a metre a notch, and moves nothing else */
  let wheelGesture = placement.armSpreadPreview({ shooterToken: shooterPlaceable });
  await sleep(300);
  await aimAt(aimWorld.x, aimWorld.y);           // cursor reach = 15m on this scene's grid → Medium band
  const baseReadout = readout();
  ok("§11 the wheel section starts on the book's own banded width, unmarked", baseReadout === readoutFor(expectM),
    `${baseReadout} | expected ${readoutFor(expectM)}`);

  // ⚠ THE NEGATIVE IS READ AFTER A RE-AIM, ON PURPOSE. A wheel the preview declines still reaches CORE,
  // which zooms the board with it — and a zoom moves the world point the (unmoved) cursor is over, so the
  // corridor's cursor-derived reach changes even though the preview added nothing. Re-aiming at the same
  // WORLD point cancels the zoom's contribution and leaves only the thing under test: whether an
  // off-board wheel added a step of its own. Three of them, so a single leaked step would show.
  for (let i = 0; i < 3; i++) document.body.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
  await sleep(200);
  await aimAt(aimWorld.x, aimWorld.y);
  ok("§11 a wheel that did not land on the board changes nothing at all (negative)",
    readout() === baseReadout, `${baseReadout} → ${readout()}`);

  await wheelOnBoard(-100, 2);                   // two notches wider, on the board this time
  ok("§11 two plain notches widen the corridor by two metres and say so, by value",
    readout() === readoutFor(expectM, 2), `${readout()} | expected ${readoutFor(expectM, 2)}`);
  ok("§11 the readout carries the house-override mark once the width is the table's, not the book's",
    readout().includes(game.i18n.localize("CYBERPUNK.SpreadWidthHouseMark")) && !baseReadout.includes(game.i18n.localize("CYBERPUNK.SpreadWidthHouseMark")),
    `${baseReadout} → ${readout()}`);
  ok("§11 and the band and the banded damage are untouched by a width override (negative)",
    readout().includes(game.i18n.localize(`CYBERPUNK.SpreadBand${expectSpec.band}`)) && readout().includes(expectDmg),
    `${readout()} | band ${expectSpec.band} dmg ${expectDmg}`);
  // Confirm and read the corridor back: the width carries the override, the reach is still the cursor's.
  let wheelClick = await aimAt(aimWorld.x, aimWorld.y);
  canvas.app.view.dispatchEvent(new PointerEvent("pointerdown", { clientX: wheelClick.x, clientY: wheelClick.y, button: 0, bubbles: true }));
  let wheelAim = await wheelGesture;
  ok("§11 the confirmed corridor's WIDTH carries the plain wheel's notches, by value",
    Number(wheelAim?.widthM) === widthFor(expectM, 2), `${lookup.spreadBandSpec(expectM).widthM} + 2 → ${wheelAim?.widthM}`);
  ok("§11 and its reach is still the cursor's own, unmoved by the plain wheel (negative)",
    Math.abs(Number(wheelAim?.reachM) - expectM) < 0.01 && wheelAim?.band === expectSpec.band,
    JSON.stringify({ reachM: wheelAim?.reachM, band: wheelAim?.band }));
  // End to end: the overridden width is what the REGION is planted with, not just what the ghost showed.
  await wipeZones(); await wipeCards();
  await hooks._placeSpreadZone(basePayload({ shotsFired: 1, spreadAim: wheelAim }));
  await sleep(500);
  ok("§11 the planted region is the width the table set, by value",
    Number(myZones()[0]?.flags?.[SCOPE]?.widthM) === widthFor(expectM, 2),
    String(myZones()[0]?.flags?.[SCOPE]?.widthM));
  await wipeZones(); await wipeCards();

  /* §11b — the width floor holds: a corridor is never narrower than a metre */
  wheelGesture = placement.armSpreadPreview({ shooterToken: shooterPlaceable });
  await sleep(300);
  await aimAt(aimWorld.x, aimWorld.y);
  await wheelOnBoard(100, 40);                   // far more notches down than there is width to give
  ok("§11 narrowing stops at the house floor, by value",
    readout() === readoutFor(expectM, placement.SPREAD_MIN_WIDTH_M - lookup.spreadBandSpec(expectM).widthM),
    `${readout()} | expected width ${placement.SPREAD_MIN_WIDTH_M}`);
  wheelClick = await aimAt(aimWorld.x, aimWorld.y);
  canvas.app.view.dispatchEvent(new PointerEvent("pointerdown", { clientX: wheelClick.x, clientY: wheelClick.y, button: 0, bubbles: true }));
  wheelAim = await wheelGesture;
  ok("§11 and the floored corridor confirms at the floor, by value",
    Number(wheelAim?.widthM) === placement.SPREAD_MIN_WIDTH_M, String(wheelAim?.widthM));
  ok("§11 the floor is the ruled one metre", placement.SPREAD_MIN_WIDTH_M === 1, String(placement.SPREAD_MIN_WIDTH_M));

  /* §11c — SHIFT+wheel is the reach fine-tune, and the band follows it */
  wheelGesture = placement.armSpreadPreview({ shooterToken: shooterPlaceable });
  await sleep(300);
  await aimAt(aimWorld.x, aimWorld.y);
  await wheelOnBoard(-100, 3, true);             // three steps further out
  ok("§11 three SHIFT steps push the reach out, and the width stays the book's (negative on the mark)",
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
  wheelGesture = placement.armSpreadPreview({ shooterToken: shooterPlaceable });
  await sleep(300);
  await aimAt(aimWorld.x, aimWorld.y);
  await wheelOnBoard(-100, 11, true);            // 15m + 11 → 26m, past the Medium/Long boundary at 25m
  ok("§11 crossing the band boundary re-derives the band, the width AND the formula, by value",
    readout() === readoutFor(expectM + 11) && lookup.spreadBandSpec(expectM + 11).band === "Long",
    `${readout()} | expected ${readoutFor(expectM + 11)}`);

  /* §11e — a shift wheel down pulls back, and stops at the plantable floor */
  await wheelOnBoard(100, 40, true);             // far more steps down than there is corridor to give
  ok("§11 pulling back stops at the shortest corridor the plant accepts, by value",
    readout() === readoutFor(placement.SPREAD_MIN_LENGTH_M), `${readout()} | expected ${readoutFor(placement.SPREAD_MIN_LENGTH_M)}`);
  wheelClick = await aimAt(aimWorld.x, aimWorld.y);
  canvas.app.view.dispatchEvent(new PointerEvent("pointerdown", { clientX: wheelClick.x, clientY: wheelClick.y, button: 0, bubbles: true }));
  wheelAim = await wheelGesture;
  ok("§11 and the floored corridor confirms at that floor rather than at the cursor, by value",
    Math.abs(Number(wheelAim?.reachM) - placement.SPREAD_MIN_LENGTH_M) < 0.01, String(wheelAim?.reachM));

  /* §11f — the override is per-aim: a fresh gesture starts on the book's width again */
  wheelGesture = placement.armSpreadPreview({ shooterToken: shooterPlaceable });
  await sleep(300);
  await aimAt(aimWorld.x, aimWorld.y);
  ok("§11 a NEW aim starts on the book's banded width — the override does not outlive its gesture (negative)",
    readout() === readoutFor(expectM), `${readout()} | expected ${readoutFor(expectM)}`);
  placement.cancelSpreadPreview();
  await wheelGesture;
  await sleep(200);

  ok("§11 the whole section spent nothing — the magazine is untouched, by value",
    magazine() === wheelMagBefore, `${wheelMagBefore} → ${magazine()}`);
  ok("§11 and planted no pattern of its own beyond the one it wiped (negative)", myZones().length === 0, String(myZones().length));
  // The suppressive lane's own widths are NOT the shooter's to override — the ruling is spread-corridor
  // only, so its preview must carry no width gesture at all.
  const suppSrc = await (await fetch(`/modules/${SCOPE}/module/combat/suppressive-placement.js`, { cache: "no-store" })).text();
  ok("§11 the suppressive preview took no width override (the ruling is the shot pattern's alone) (negative)",
    !/widthBiasM/.test(suppSrc));
  await canvas.animatePan({ ...viewBefore, duration: 0 }).catch(() => {});
  await sleep(200);

  /* ── §12  an ignored resolution card still loses its pattern to the clocks ────────────────── */
  // The region now outlives the card that asks about it, so the two expiry rules are what stop an
  // unpressed card from leaving a corridor on the table forever. Driven on the wall clock, which is the
  // rule that owns a pattern thrown outside an encounter.
  await wipeZones(); await wipeCards();
  await hooks._placeSpreadZone(basePayload({ shotsFired: 1 }));
  await sleep(400);
  const ignored = myZones()[0];
  await ignored.setFlag(SCOPE, "combatId", "");
  await ignored.setFlag(SCOPE, "createdAt", Date.now() - hooks.SPREAD_ZONE_TTL_MS - 1000);
  const sweptIgnored = await hooks._sweepStaleSpreadZones();
  await sleep(400);
  ok("§12 a pattern nobody applied is collected by its own clock, card or no card",
    sweptIgnored === 1 && myZones().length === 0, `swept=${sweptIgnored} left=${myZones().length}`);
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
  ok("§13 and the same burst asks for a stun save per damage event — BOTH saves at Mortal, as the single-target rail does",
    stunCards(sinceIds).length === 3,
    `stun=${stunCards(sinceIds).length} death=${deathCards(sinceIds).length}`);
  await wipeZones(); await wipeCards(); await wipeSaveCards();

  /* §13b — below Mortal the stun prompt keeps its per-damage-event cadence (negative control) */
  await victim13.update({ "system.damage": 0 });
  sinceIds = new Set(game.messages.map(m => m.id));
  await hooks._placeSpreadZone(basePayload({ shotsFired: 2, spreadDamageShort: "5", spreadDamageMedium: "5", spreadDamageLong: "5" }));
  await sleep(500);
  await hooks._confirmSpreadZone(myZones()[0].id);
  await sleep(3500);
  ok("§13 a wounded-but-not-Mortal figure is still asked once per damage event, by value",
    stunCards(sinceIds).length === 2 && deathCards(sinceIds).length === 0,
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
  ok("§13 so an un-stabilized Mortal figure is asked for both saves on their own clocks",
    deathCards(sinceIds).length === 1 && stunCards(sinceIds).length === 2,
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
  // The table's house width override survives the scatter: it is recovered from the declared corridor
  // and re-applied on top of whatever width the NEW band earns.
  const scHouse = hooks.scatteredSpreadCorridor({
    originX: 0, originY: 0, declared: { ...scDeclared, widthM: 4 }, pixelsPerMeter: 10, dirFace: 2, distFace: 7,
  });
  ok("§14 a house width override rides the scatter — +2 m over the book, still +2 m after",
    scHouse.widthM === lookup.spreadBandSpec(scHouse.reachM).widthM + 2, String(scHouse.widthM));
  ok("§14 and the override can never take the scattered corridor under the one-metre floor",
    hooks.scatteredSpreadCorridor({
      originX: 0, originY: 0, declared: { ...scDeclared, widthM: 1 }, pixelsPerMeter: 10, dirFace: 3, distFace: 10,
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
      scatterTable.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: 9, toHitDC: 15 }) === true
      && scatterTable.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: 30, toHitDC: 15 }) === false
      && scatterTable.payloadScattersOnMiss({ attackTotal: 9, toHitDC: 15 }) === false
      && scatterTable.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: null, toHitDC: null }) === false,
      JSON.stringify([
        scatterTable.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: 9, toHitDC: 15 }),
        scatterTable.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: 30, toHitDC: 15 }),
        scatterTable.payloadScattersOnMiss({ attackTotal: 9, toHitDC: 15 }),
        scatterTable.payloadScattersOnMiss({ spreadAim: declaredAim, attackTotal: null, toHitDC: null }),
      ]));

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
check("0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
