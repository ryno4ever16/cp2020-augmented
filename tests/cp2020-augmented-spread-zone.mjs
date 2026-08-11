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

  const mine = (r) => r?.flags?.[SCOPE]?.isSpreadZone === true;
  const myZones = () => [...(scene?.regions ?? [])].filter(mine);
  const wipeZones = async () => { for (const r of myZones()) await r.delete().catch(() => {}); };
  const wipeCards = async () => {
    for (const m of [...game.messages].filter(m => /cp-confirm-spread-zone|cp-spread-result-list/.test(m.content ?? ""))) await m.delete().catch(() => {});
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
  for (const a of [...game.actors].filter(a => a.name?.startsWith("__PWK__SPREAD"))) await a.delete().catch(() => {});
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
  const buckP = basePayload();
  Hooks.callAll("cyberpunk2020.weaponFired", buckP);
  await sleep(900);
  ok("§3 a shell payload is NOT claimed by the single-target flow", buckP.handled !== true, `handled=${buckP.handled}`);
  const dialogsAfterBuck = Object.values(ui.windows ?? {}).filter(w => w?.constructor?.name === "DamageDialog").length;
  ok("§3 no DamageDialog opened for the shell", dialogsAfterBuck === dialogsBefore, `${dialogsBefore}→${dialogsAfterBuck}`);
  const buckCards = [...game.messages].filter(m => m.getFlag(SCOPE, "damagePayload"));
  ok("§3 no apply-button payload flagged onto any card", buckCards.every(m => m.getFlag(SCOPE, "damagePayload")?.caliber !== "00"));
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
    cards: [...game.messages].filter(m => /cp-confirm-spread-zone|cp-spread-result-list/.test(m.content ?? "")).length,
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
