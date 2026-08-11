/**
 * KEEPER: combat FX rail (Animation Rail Unit A1 — module/fx/effects.js).
 *
 * Covers, by value:
 *  - capability detection against the INSTALLED engine + free asset tier, and the no-op shape when a
 *    verb is called with nothing to draw on
 *  - class resolution from item type data (label form + enum-key form + the unmapped types)
 *  - class resolution ORDER: the attack-type discriminator that runs ahead of the type map (a shell
 *    weapon typed Rifle for skill purposes), the negatives that hold the REMOVED shell-family
 *    fallback out, and the shipped shell-weapon compendia read as live data
 *  - asset resolution per class, extension tolerance, and the silent path when nothing is delivered
 *  - keyframe envelope values (grid-scaled) + the applied write sequence + exact restore + cleanup
 *  - payload fan-out: per-unit count, cadence spacing mechanism, fallbacks when the count is absent
 *  - the negative cases: unmapped type produces nothing; the world switch off disables the rail
 *  - EVERY mapped database key resolving against the free asset tier — the floor a user gets without
 *    paying, so a key that only the paid tier carries is caught here rather than showing nothing
 *  - the two database outcomes an install carrying both keys cannot produce (nothing resolves; only
 *    one of the pair resolves), driven on a controlled surface put in front of the adapter
 *  - 0 console errors
 *
 * PREREQUISITE (changed 2026-08-06): the optional effect engine and the free asset tier are now
 * INSTALLED on the :30004 rig, so the legs that used to assert the absent shape assert the present
 * one, and the former "simulated engine-present" section became the controlled-surface section above.
 * Run this against a rig that carries both modules; on a rig without them §1/§1b are the legs that
 * will say so by name.
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
// THE ONE THIRD-PARTY SIGNATURE THIS SPEC OWNS RATHER THAN REPORTS, and it is narrow on purpose: the
// message AND the engine's own `_createSprite` frame must both match. It is the effect engine losing a
// race with ITSELF when an effect is torn down while it is still initialising — which only ever happens
// because THIS SPEC calls endAllEffects() between sections to get a clean canvas to sample. Nothing in
// the module calls it, so it cannot occur at a table. Already on record from the FR#5 work as a keeper
// trap, isolation-proven not ours. Anything else out of the engine still fails the leg.
const engineRaces = [];
const ENGINE_TEARDOWN_RACE = /Cannot set properties of null \(setting 'volume'\)/;
const isEngineTeardownRace = (text, stack) => {
  const where = String(stack ?? text);
  // Both tokens, in EITHER order — the frame reads "_createSprite (…/sequencer.js:…)", so a regex
  // demanding the module name first never matched and five of these went through as ours.
  return ENGINE_TEARDOWN_RACE.test(text) && /_createSprite/.test(where) && /sequencer/i.test(where);
};
// THE PRESENTATION CANARY'S OWN LINE, captured rather than counted — but ONLY while §19c is deliberately
// provoking it. A canary that fires anywhere else in this run is a real report and stays in `errors`,
// which is what keeps the positive control from being a licence to ignore the thing it tests.
let canaryArmed = false;
const canaryLines = [];
const CANARY_LINE = /combat fx: the rail/;
page.on("console", m => {
  if (m.type() !== "error" || /compatibility|deprecat|screen resolution/i.test(m.text())) return;
  if (canaryArmed && CANARY_LINE.test(m.text())) { canaryLines.push(m.text()); return; }
  errors.push(m.text());
});
page.on("pageerror", e => {
  const stack = String(e.stack ?? "").replace(/\s+/g, " ").slice(0, 300);
  if (isEngineTeardownRace(e.message, stack)) { engineRaces.push(stack.slice(0, 120)); return; }
  errors.push(e.message + " ||AT|| " + stack);
});

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
  const out = { checks: [], soundsDelivered: null };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  if (!game.scenes.active) await (game.scenes.getName("Foundry Virtual Tabletop") ?? game.scenes.contents[0])?.activate();
  const scene = game.scenes.active;

  const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);

  /* ── fixtures ──────────────────────────────────────────────────────────── */
  for (const a of [...game.actors].filter(a => a.name?.startsWith("__PW__FX"))) await a.delete();
  for (const t of [...(scene?.tokens ?? [])].filter(t => t.name?.startsWith("__PW__FX"))) await t.delete();

  const actor = await Actor.create({ name: "__PW__FX Shooter", type: "character" });
  const mk = (name, weaponType, attackType = "semiAuto", extra = {}) => ({ name, type: "weapon", system: { weaponType, attackType, damage: "1d6", range: 50, rof: 1, shots: 10, shotsLeft: 10, ...extra } });
  const madeIds = {};
  for (const [key, wt] of Object.entries({
    pistol: "Pistol", smg: "SMG", smgKey: "submachinegun", rifle: "Rifle",
    shotgun: "Shotgun", heavy: "Heavy", melee: "Melee", exotic: "Exotic", blank: "",
  })) {
    const [item] = await actor.createEmbeddedDocuments("Item", [mk(`__PW__FX ${key}`, wt)]);
    madeIds[key] = item.id;
  }
  const W = (k) => actor.items.get(madeIds[k]);

  // Fixtures for the discriminator that runs AHEAD of the type map, plus the negatives around it.
  // The catalog types its shell-firing weapons "Rifle" so they take the Rifle skill, so the type map
  // alone would give them a rifle's assets — these carry the discriminating field instead, one per
  // decision path (rifleShellField is the round-naming field that must NOT steer the result).
  // They live on a SEPARATE actor deliberately: every token write in the fan-out section re-prepares
  // the shooter and its embedded items, so extra items on the shooter inflate the per-write cost and
  // would skew the cadence measurement below (measured: it doubles the burst span).
  const clsActor = await Actor.create({ name: "__PW__FX Class Fixtures", type: "character" });
  const clsIds = {};
  for (const [key, [wt, at, extra]] of Object.entries({
    rifleShotgunAtk:  ["Rifle", "Shotgun"],
    rifleAutoshotAtk: ["Rifle", "Autoshotgun"],
    shotgunNoAtk:     ["Shotgun", ""],
    rifleAutoAtk:     ["Rifle", "Auto"],
    meleeShotgunAtk:  ["Melee", "Shotgun"],
    rifleShellField:  ["Rifle", "", { caliber: "00" }],
  })) {
    const [item] = await clsActor.createEmbeddedDocuments("Item", [mk(`__PW__FX ${key}`, wt, at, extra)]);
    clsIds[key] = item.id;
  }
  const C = (k) => clsActor.items.get(clsIds[k]);

  // A token with a DISTINCTIVE pre-existing light, so a restore assertion cannot be a tautology.
  const baseLight = { bright: 3, dim: 6, color: "#00ff00", alpha: 0.9, angle: 45 };
  const [tokenDoc] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PW__FX Shooter", actorId: actor.id, actorLink: true, x: 1000, y: 1000, light: baseLight,
  }]);
  // A second token to aim AT. Two legs need a real aimed-at token rather than the shooter standing in
  // for one: the sprite is only drawn when an aim direction exists, and the payload's target field is
  // what carries that direction in from the fire path.
  const targetActor = await Actor.create({ name: "__PW__FX Dummy", type: "character" });
  const [targetDoc] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PW__FX Dummy", actorId: targetActor.id, actorLink: true, x: 1600, y: 1000,
  }]);
  await sleep(400);

  // The instrument that used to COUNT the flash's document writes is kept and inverted: the flash no
  // longer writes anything, so every entry this collects for the shooter token across the whole run
  // is a regression. It is read by the load-bearing negative in §5 and again at teardown.
  // Rotation is split out from the rest: the face-target turn is the ONE write the rail performs, and
  // it is a deliberate feature, so lumping it in would make the flash's own no-write negative
  // meaningless. Everything that is NOT a rotation still lands in tokenWrites and is still a
  // regression; the rotation bucket is asserted separately, by the face-target legs.
  const tokenWrites = [];
  const rotationWrites = [];
  const writeHook = Hooks.on("updateToken", (doc, changes) => {
    if (doc.id !== tokenDoc.id) return;
    // `lockRotation` is set BY THIS SPEC when it stages the locked-token leg — it is fixture setup,
    // not something the rail ever writes, so it is filtered out here rather than counted as a rail
    // write by the load-bearing negative at teardown.
    const keys = Object.keys(changes).filter(k => k !== "_id" && k !== "lockRotation");
    if (!keys.length) return;
    if (keys.every(k => k === "rotation")) rotationWrites.push(changes.rotation);
    else tokenWrites.push(keys.join("+"));
  });
  // Nothing in the rail is queued behind a server round trip any more, so settling is a plain wait
  // for the fan-out's own timers rather than a drain on write quiescence.
  const drain = async (ms = 400) => { await sleep(ms); return true; };

  /* ── flash-source helpers (the collection the flash actually lives in) ──── */
  const FLASH_PREFIX = `${SCOPE}.flash.`;
  const flashSources = (tokenId = null) => [...canvas.effects.lightSources.entries()]
    .filter(([k]) => k.startsWith(tokenId ? `${FLASH_PREFIX}${tokenId}.` : FLASH_PREFIX))
    .map(([k, s]) => ({ key: k, part: k.split(".").pop(), s }));
  // Hold a flash at full intensity so its live state can be read; the shipped envelope is a handful
  // of render frames, which is shorter than any poll this harness can perform.
  const holdOpen = () => fx._setFlashLevels(new Array(400).fill(1));
  const releaseHold = () => { fx._setFlashLevels(null); fx.clearFlashes(); };

  /* ── 1. capability detection against the installed engine ──────────────── */
  // This rig now carries the optional effect engine + the FREE asset tier, so detection is asserted
  // in its PRESENT shape here and the absent shape is covered by the controlled-surface legs in §9.
  ok("engine module active on this install", fx.sequencerActive() === true, String(fx.sequencerActive()));
  ok("asset module active on this install", fx.jb2aActive() === true, String(fx.jb2aActive()));
  ok("database lookup false for a key no tier delivers", fx.fxDbEntryExists("jb2a.bullet.99.chartreuse") === false);
  const absentShot = await fx.fxShot(null, null, { weaponClass: "pistol" });
  ok("visual verbs no-op with no token", absentShot.muzzle === false && absentShot.tracer === false && absentShot.light === false, JSON.stringify(absentShot));

  /* ── 1b. every mapped key resolves on the tier a user gets for free ─────── */
  // The mapping is only worth anything if the installed asset tier actually carries the keys. The
  // free tier is the floor: a key that resolves only on the paid tier would silently show nothing
  // for most users, which is the exact failure this leg exists to catch.
  const mapped = Object.entries(fx.FX_CLASSES);
  // ⏪⏪ EVERY class names a lance again (2026-08-09, the column deletion). FR#22 had made the shell a
  // ruled absence and this leg allowed for it; the shell's lance is back, so the floor now covers all
  // five rows and the count is asserted rather than tolerated.
  const lanceRows = mapped.filter(([, e]) => !!e.muzzle);
  const muzzleMisses = lanceRows.filter(([, e]) => !fx.fxDbEntryExists(e.muzzle)).map(([c, e]) => `${c}=${e.muzzle}`);
  const tracerMisses = mapped.filter(([, e]) => !fx.fxDbEntryExists(e.tracer)).map(([c, e]) => `${c}=${e.tracer}`);
  ok("mapped: every class that names a muzzle key resolves it on the installed tier",
    muzzleMisses.length === 0 && lanceRows.length === Object.keys(fx.FX_CLASSES).length,
    muzzleMisses.join(",") || `${lanceRows.length} lance row(s), ${mapped.length - lanceRows.length} without`);
  ok("mapped: every class tracer key resolves on the installed tier", tracerMisses.length === 0, tracerMisses.join(",") || "none");
  // The three keys the muzzle look added. Same floor, same reason: a key only the paid tier carries
  // would leave the spikes, the spray and the wisp silently absent for most users.
  const addedKeys = [["spark", fx.MUZZLE_SPARK.key], ["motes", fx.MUZZLE_MOTES.key], ["smoke", fx.MUZZLE_SMOKE.key],
    ["hitConfirm", fx.HIT_CONFIRM.key]];
  const addedMisses = addedKeys.filter(([, k]) => !fx.fxDbEntryExists(k)).map(([n, k]) => `${n}=${k}`);
  ok("mapped: the spark, mote and smoke keys all resolve on the installed tier",
    addedMisses.length === 0, addedMisses.join(",") || addedKeys.map(([n, k]) => `${n}=${k}`).join(" "));
  // Keys, not paths: the mapping holds dotted database keys, and the database is what turns them into
  // delivered files (the file the key resolves to is a real served path, unlike the key itself).
  const dbFiles = globalThis.Sequencer?.Database?.getAllFileEntries?.(fx.FX_CLASSES.pistol.muzzle) ?? [];
  const dbFile = String(dbFiles[0] ?? "");
  // HEAD, not GET: the assertion is that the path is served, and these are multi-hundred-KB videos.
  const dbProbe = dbFile ? await fetch(dbFile, { method: "HEAD", cache: "no-store" }) : { ok: false, status: "no file" };
  ok("mapped: keys carry no path separator and the database resolves one to a served file",
    mapped.every(([, e]) => !(e.muzzle ?? "").includes("/") && !e.tracer.includes("/")) && dbFile.includes("/") && dbProbe.ok,
    `${dbFiles.length} files / ${dbFile} → ${dbProbe.status}`);

  /* ── 2. class resolution from type data ────────────────────────────────── */
  ok("class: label Pistol", fx.weaponFxClass(W("pistol")) === "pistol");
  ok("class: label SMG", fx.weaponFxClass(W("smg")) === "smg");
  ok("class: enum key submachinegun", fx.weaponFxClass(W("smgKey")) === "smg");
  ok("class: label Rifle", fx.weaponFxClass(W("rifle")) === "rifle");
  ok("class: label Shotgun", fx.weaponFxClass(W("shotgun")) === "shotgun");
  ok("class: label Heavy", fx.weaponFxClass(W("heavy")) === "heavy");
  ok("class: Melee unmapped (negative)", fx.weaponFxClass(W("melee")) === null, String(fx.weaponFxClass(W("melee"))));
  ok("class: Exotic unmapped (negative)", fx.weaponFxClass(W("exotic")) === null, String(fx.weaponFxClass(W("exotic"))));
  ok("class: empty type unmapped (negative)", fx.weaponFxClass(W("blank")) === null);
  ok("class: no weapon unmapped (negative)", fx.weaponFxClass(null) === null);

  /* ── 2b. resolution order: the discriminator that runs ahead of the type map ─── */
  // The ONE discriminator — the attack-type field. A shell-firing weapon typed Rifle must take the
  // shell class even though the type map would answer "rifle" for it.
  ok("class resolution: attack-type discriminator overrides the type map",
    fx.weaponFxClass(C("rifleShotgunAtk")) === "shotgun", String(fx.weaponFxClass(C("rifleShotgunAtk"))));
  ok("class resolution: automatic attack-type discriminator resolves the same class",
    fx.weaponFxClass(C("rifleAutoshotAtk")) === "shotgun", String(fx.weaponFxClass(C("rifleAutoshotAtk"))));
  // A shell-family fallback keyed on the loaded round was REMOVED BY DESIGN (a pack sweep showed the
  // attack type already classifies the whole shotgun corpus). These legs hold that removal in place:
  // neither of the two fields that could name a shell round may steer the result.
  ok("class resolution: shell-caliber input is not a discriminator",
    fx.weaponFxClass({ system: { weaponType: "Rifle", attackType: "", caliber: "00" } }) === "rifle",
    String(fx.weaponFxClass({ system: { weaponType: "Rifle", attackType: "", caliber: "00" } })));
  ok("class resolution: gauge ammo input is not a discriminator",
    fx.weaponFxClass({ system: { weaponType: "Rifle", attackType: "", ammoType: "CAL12" } }) === "rifle",
    String(fx.weaponFxClass({ system: { weaponType: "Rifle", attackType: "", ammoType: "CAL12" } })));
  // The storage fact that made the removed fallback unreachable in the first place: a weapon DOCUMENT
  // cannot even hold the caliber field (it belongs to the ammo model), so a document written with one
  // reads back without it and classifies purely on its type.
  ok("class resolution: weapon documents do not carry the shell field on this host",
    C("rifleShellField").system?.caliber === undefined && fx.weaponFxClass(C("rifleShellField")) === "rifle",
    `${JSON.stringify(C("rifleShellField").system?.caliber)} / ${fx.weaponFxClass(C("rifleShellField"))}`);
  // The type map still decides everything the discriminator does not claim.
  ok("class resolution: type map still answers without any discriminator",
    fx.weaponFxClass(C("shotgunNoAtk")) === "shotgun", String(fx.weaponFxClass(C("shotgunNoAtk"))));
  ok("class resolution: a non-shell attack type leaves the type map result (negative)",
    fx.weaponFxClass(C("rifleAutoAtk")) === "rifle", String(fx.weaponFxClass(C("rifleAutoAtk"))));
  // The ranged gate runs FIRST, so the discriminator cannot pull a melee item onto the rail.
  ok("class resolution: discriminators cannot reach a melee item (negative)",
    fx.weaponFxClass(C("meleeShotgunAtk")) === null, String(fx.weaponFxClass(C("meleeShotgunAtk"))));

  // Shipped data, not fixtures: every weapon in the shell-weapon compendia must resolve the shell
  // class, whichever field carries the evidence in that entry.
  const shellPacks = ["cyberpunk2020.shotguns", "cp2020-augmented.supplement-shotguns"];
  const shellDocs = [];
  for (const key of shellPacks) {
    const pack = game.packs.get(key);
    if (!pack) continue;
    for (const d of await pack.getDocuments()) if (d.type === "weapon") shellDocs.push(d);
  }
  const shellMisses = shellDocs.filter(d => fx.weaponFxClass(d) !== "shotgun");
  ok("class resolution: every shipped shell-weapon entry resolves the shell class",
    shellDocs.length >= 14 && shellMisses.length === 0,
    `${shellDocs.length} entries / misses: ${shellMisses.map(d => `${d.name}=${fx.weaponFxClass(d)}`).join(",") || "none"}`);

  /* ── 2c. the shell class is not a copy of the rifle class ──────────────── */
  // The shell class resolved correctly but was mapped to BYTE-IDENTICAL visuals: same flash key, same
  // tracer key, same scale — only the sound differed, and at the automatic cadence ten overlapping
  // full-bodied reports blur into one roar, so a shell weapon both looked and sounded like a rifle.
  // These legs hold the two rows apart on every field the difference is carried by, so a future edit
  // cannot quietly collapse them again.
  const shellRow = fx.FX_CLASSES.shotgun, rifleRow = fx.FX_CLASSES.rifle, heavyRow = fx.FX_CLASSES.heavy;
  ok("mapping: the shell row is not a copy of the rifle row",
    JSON.stringify(shellRow) !== JSON.stringify(rifleRow), JSON.stringify(shellRow));
  ok("mapping: shell tracer key differs from the rifle's",
    shellRow.tracer !== rifleRow.tracer, `${shellRow.tracer} vs ${rifleRow.tracer}`);
  // ⏪⏪ INVERTED BACK (2026-08-09). This leg has now said three things: FR#21's "the shell's lance is
  // the widest bar the heavy's", FR#22's "the shell carries no lance fields at all", and — with the
  // discharge column deleted and the lance restored — the original claim again, by value.
  ok("mapping: the shell carries lance fields, and the rows stay ordered by bore",
    shellRow.muzzle === rifleRow.muzzle && shellRow.muzzleSquares === 1.9
    && rifleRow.muzzleSquares < shellRow.muzzleSquares
    && shellRow.muzzleSquares < heavyRow.muzzleSquares,
    `rifle ${rifleRow.muzzleSquares} < shell ${shellRow.muzzleSquares} < heavy ${heavyRow.muzzleSquares}`);
  ok("mapping: shell row carries a pellet count the rifle row does not",
    shellRow.pellets >= 3 && rifleRow.pellets === undefined, `${shellRow.pellets} vs ${rifleRow.pellets}`);
  ok("mapping: the shell hit cone is tighter than the miss divergence",
    shellRow.spreadRad > 0 && shellRow.spreadRad < fx.MISS_SPREAD_RAD,
    `${shellRow.spreadRad} vs ${fx.MISS_SPREAD_RAD}`);
  ok("mapping: shell row carries a multi-round asset the rifle row does not",
    typeof shellRow.soundBurst === "string" && rifleRow.soundBurst === undefined,
    `${shellRow.soundBurst} vs ${rifleRow.soundBurst}`);
  // The travelled-dash geometry: the shell row asks for a SHORT sprite that crosses the shot line, in
  // place of the full-length streak the rifle row still paints. The size is in grid units, so it is
  // the same fraction of a square on any scene. The bound here is a sanity floor/ceiling only — what
  // actually holds the two shapes apart is measured in pixels off the real engine further down
  // ("drawn:" legs), because the mapped number is a FRAME width and the lit slug inside it is smaller.
  ok("mapping: shell row asks for a short travelled dash the rifle row does not",
    shellRow.dashSquares > 0 && shellRow.dashSquares <= 2 && rifleRow.dashSquares === undefined,
    `${shellRow.dashSquares} squares vs rifle ${rifleRow.dashSquares}`);
  ok("mapping: the dash is given a crossing time, and it is shorter than the class's own cadence",
    shellRow.dashMs > 0 && shellRow.dashMs < shellRow.cadenceMs,
    `${shellRow.dashMs}ms flight vs ${shellRow.cadenceMs}ms cadence`);
  // The optional fields are opt-in per class: nothing else may have picked them up by accident.
  const fanned = Object.entries(fx.FX_CLASSES).filter(([, e]) => e.pellets !== undefined).map(([c]) => c);
  ok("mapping: the pellet fan is claimed by the shell class alone (negative)",
    fanned.join(",") === "shotgun", fanned.join(",") || "none");
  const dashed = Object.entries(fx.FX_CLASSES).filter(([, e]) => e.dashSquares !== undefined).map(([c]) => c);
  ok("mapping: the travelled dash is claimed by the shell class alone (negative)",
    dashed.join(",") === "shotgun", dashed.join(",") || "none");
  const paced = Object.entries(fx.FX_CLASSES).filter(([, e]) => e.cadenceMs !== undefined).map(([c]) => c);
  ok("mapping: a cadence override is claimed by the shell class alone (negative)",
    paced.join(",") === "shotgun", paced.join(",") || "none");

  /* ── 3. asset resolution per class ─────────────────────────────────────── */
  // The shipped assets, as the adapter's own listing pass sees them.
  await fx.primeFxSounds();
  out.soundsDelivered = ["pistol", "smg", "rifle", "shotgun", "heavy"].map(c => fx.shotSoundSrc(c));
  ok("delivered: every class resolves a shipped asset",
    out.soundsDelivered.every(s => typeof s === "string" && s.startsWith(`modules/${SCOPE}/sounds/shot-`)),
    JSON.stringify(out.soundsDelivered));
  // The resolved path against the real server: a wrong or undelivered path would come back non-OK
  // (and a request for a missing file is exactly what the resolver is built to avoid emitting).
  // Playback itself is NOT awaited here — a headless client has no user gesture, so the core audio
  // context never unlocks and any await on a Sound would hang rather than fail.
  const probe = await fetch(fx.shotSoundSrc("pistol"), { cache: "no-store" });
  ok("delivered: resolved path is served", probe.ok && Number(probe.headers.get("content-length")) > 0,
    `${probe.status} / ${probe.headers.get("content-length")} bytes`);
  const realCall = fx.sfx("pistol", { volume: 0 });
  ok("delivered: playback handed to the core audio entry point", realCall !== null && typeof realCall?.then === "function", String(typeof realCall));
  // The shell class's multi-round asset, against the SHIPPED listing rather than a seeded one: it has
  // to actually be delivered, or the burst falls back to the full-bodied clip and the change does
  // nothing a listener can hear.
  const burstSrc = fx.shotSoundSrc("shotgun", { burst: true });
  const singleSrc = fx.shotSoundSrc("shotgun");
  out.shellAssets = { single: singleSrc, burst: burstSrc };
  ok("delivered: the shell class's multi-round asset is shipped and distinct from its single-shot one",
    typeof burstSrc === "string" && burstSrc !== singleSrc && burstSrc.includes("shot-shotgun-burst"),
    `${singleSrc} / ${burstSrc}`);
  // Probed by NAME, not by whatever the resolver returned: with the alternate missing the resolver
  // falls back to the ordinary asset, and fetching THAT would pass this leg while the shipped set was
  // still short a file.
  const burstPath = `modules/${SCOPE}/sounds/shot-shotgun-burst.ogg`;
  const burstProbe = await fetch(burstPath, { cache: "no-store" });
  const burstBytes = Number(burstProbe.headers?.get?.("content-length") ?? 0);
  ok("delivered: the multi-round asset is served under its own name", burstProbe.ok && burstBytes > 0,
    `${burstPath} → ${burstProbe.status} / ${burstBytes} bytes`);

  // The two retired shell recordings are KEPT ON DISK for an A/B listen but must not be reachable
  // through the table — a rename that left a row pointing at the old brighter recording would sound
  // exactly like the defect coming back, and nothing else would flag it.
  const retired = ["shot-shotgun-alt.ogg", "shot-shotgun-short-alt.ogg"];
  const retiredProbes = [];
  for (const name of retired) {
    const r = await fetch(`modules/${SCOPE}/sounds/${name}`, { cache: "no-store" });
    retiredProbes.push(`${name}:${r.status}`);
  }
  ok("delivered: the retired shell recordings are still on disk for an A/B listen",
    retiredProbes.every(s => s.endsWith(":200")), retiredProbes.join(" "));
  const mappedAssets = Object.values(fx.FX_CLASSES).flatMap(e => [e.sound, e.soundBurst]).filter(Boolean);
  ok("delivered: no class row points at a retired recording (negative)",
    mappedAssets.every(a => !String(a).endsWith("-alt")), mappedAssets.join(","));

  fx._setSoundManifest(["shot-pistol.ogg", "shot-smg.ogg", "shot-rifle.ogg", "shot-shotgun.ogg", "shot-heavy.mp3"]);
  const dir = `modules/${SCOPE}/sounds`;
  ok("asset: pistol path", fx.shotSoundSrc("pistol") === `${dir}/shot-pistol.ogg`, fx.shotSoundSrc("pistol"));
  ok("asset: smg path", fx.shotSoundSrc("smg") === `${dir}/shot-smg.ogg`, fx.shotSoundSrc("smg"));
  ok("asset: rifle path", fx.shotSoundSrc("rifle") === `${dir}/shot-rifle.ogg`, fx.shotSoundSrc("rifle"));
  ok("asset: shotgun path", fx.shotSoundSrc("shotgun") === `${dir}/shot-shotgun.ogg`, fx.shotSoundSrc("shotgun"));
  ok("asset: heavy resolves alternate extension", fx.shotSoundSrc("heavy") === `${dir}/shot-heavy.mp3`, fx.shotSoundSrc("heavy"));
  ok("asset: unmapped class resolves nothing", fx.shotSoundSrc("melee") === null && fx.shotSoundSrc(null) === null);

  /* ── 3b. single-round vs multi-round asset selection ───────────────────── */
  // Driven on a seeded listing so each branch is reached deliberately rather than depending on what
  // happens to be on disk.
  fx._setSoundManifest(["shot-shotgun.ogg", "shot-shotgun-burst.ogg", "shot-rifle.ogg"]);
  ok("selection: a single round takes the class's full-bodied asset",
    fx.shotSoundSrc("shotgun") === `${dir}/shot-shotgun.ogg`, fx.shotSoundSrc("shotgun"));
  ok("selection: a multi-round payload takes the class's short asset",
    fx.shotSoundSrc("shotgun", { burst: true }) === `${dir}/shot-shotgun-burst.ogg`, fx.shotSoundSrc("shotgun", { burst: true }));
  ok("selection: a class carrying no alternate is unaffected by the multi-round flag (negative)",
    fx.shotSoundSrc("rifle", { burst: true }) === `${dir}/shot-rifle.ogg`, fx.shotSoundSrc("rifle", { burst: true }));
  // The alternate is opt-in on DELIVERY too: with it absent the class keeps its ordinary asset rather
  // than resolving nothing and going silent for the whole burst.
  fx._setSoundManifest(["shot-shotgun.ogg"]);
  ok("selection: an undelivered alternate falls back instead of going silent",
    fx.shotSoundSrc("shotgun", { burst: true }) === `${dir}/shot-shotgun.ogg`, fx.shotSoundSrc("shotgun", { burst: true }));

  fx._setSoundManifest([]);
  ok("asset: listing readable + nothing delivered -> silent", fx.shotSoundSrc("pistol") === null, String(fx.shotSoundSrc("pistol")));
  fx._setSoundManifest(null);
  ok("asset: listing unavailable -> shipped path", fx.shotSoundSrc("pistol") === `${dir}/shot-pistol.ogg`, fx.shotSoundSrc("pistol"));

  // Broadcast call shape + the silent branch, via a recorder on the core audio entry point.
  const AH = foundry.audio.AudioHelper;
  const realPlay = AH.play;
  let plays = [];
  AH.play = (data, socketOptions) => { plays.push({ t: Date.now(), src: data?.src, channel: data?.channel, volume: data?.volume, broadcast: socketOptions === true }); return null; };
  fx._setSoundManifest(["shot-rifle.ogg"]);
  fx.sfx("rifle");
  ok("audio: one broadcast call on the interface channel", plays.length === 1 && plays[0].channel === "interface" && plays[0].broadcast === true, JSON.stringify(plays[0]));
  ok("audio: source is the mapped asset", plays[0]?.src === `${dir}/shot-rifle.ogg`, plays[0]?.src);
  plays = [];
  fx.sfx("pistol");
  ok("audio: no call when the asset is not resolvable (negative)", plays.length === 0, String(plays.length));

  /* ── 4. envelope + source spec values (pure) ───────────────────────────── */
  // The envelope is counted in RENDER FRAMES, not milliseconds: the reference flash is one to three
  // frames, which is below the resolution of any timer this host offers, and the previous build's
  // millisecond schedule is precisely what delivered an 85ms spec in ~1.3s of wall clock.
  const levels = fx.muzzleFrameLevels();
  ok("envelope: five frames — attack 1, hold 2, decay 2", levels.length === 5 && fx.muzzleEnvelopeFrames() === 5, String(levels.length));
  ok("envelope: per-frame intensities 0.6 / 1 / 1 / 0.7 / 0.4",
    levels.join(",") === "0.6,1,1,0.7,0.4", levels.join(","));
  ok("envelope: the tail RAMPS down rather than stepping to a plateau",
    levels[3] < levels[2] && levels[4] < levels[3], `${levels[2]} > ${levels[3]} > ${levels[4]}`);
  ok("envelope: that comes to 85ms on a client rendering at the reference rate",
    fx.muzzleEnvelopeDurationMs() === 85, String(fx.muzzleEnvelopeDurationMs()));

  // The source class this core exposes, resolved the way core resolves it internally. Same class,
  // same constructor and same data fields on both cores this module supports.
  const SourceClass = fx.pointLightSourceClass();
  ok("compat: the core's own light-source class resolves on this build",
    typeof SourceClass === "function" && /LightSource/.test(SourceClass.name), String(SourceClass?.name));

  // Radii come back in PIXELS (what a canvas source takes), scaled by BOTH the scene's distance per
  // square and its pixels per distance unit. The reference's own light is 25 SCENE UNITS on a 2m
  // grid = 12.5 squares, measured live at 1250px there; 5ft squares at 20px/ft give 1250px here too.
  const specArgs = { gridDistance: 5, pixelsPerUnit: 20 };
  const omni = fx.muzzleSourceSpecs({ ...specArgs, aimRad: null, mode: "omni" });
  ok("spec omni: one circular source at the full radii",
    omni.length === 1 && omni[0].angle === 360 && omni[0].bright === 1250 && omni[0].dim === 1250 && omni[0].alpha === 0.5,
    JSON.stringify(omni));
  const coneSpec = fx.muzzleSourceSpecs({ ...specArgs, aimRad: 0, mode: "cone" });
  ok("spec cone: one wedge of the configured width, at the full radii",
    coneSpec.length === 1 && coneSpec[0].angle === fx.MUZZLE_LIGHT.coneDegrees && coneSpec[0].bright === 1250 && coneSpec[0].dim === 1250,
    JSON.stringify(coneSpec));
  // RE-PINNED to the reference's OWN configuration (import-staging/RED-REFERENCE-RIG.md), which
  // replaces the provisional 3/6 split read off a video frame. bright EQUALS dim on purpose: with no
  // bright/dim split there is no inner plateau and no boundary between the two, so the attenuation
  // does all of the falloff across the whole radius. That is the structural difference, so it is
  // asserted as an equality rather than as two numbers that happen to match.
  ok("spec: the radii are the reference's own, and there is NO bright/dim split to draw a boundary",
    fx.MUZZLE_LIGHT.brightSquares === 12.5 && fx.MUZZLE_LIGHT.dimSquares === 12.5
    && fx.MUZZLE_LIGHT.brightSquares === fx.MUZZLE_LIGHT.dimSquares
    && coneSpec[0].bright === coneSpec[0].dim,
    `${fx.MUZZLE_LIGHT.brightSquares} / ${fx.MUZZLE_LIGHT.dimSquares} squares`);
  // The edge. Core maps the user value through (cos(pi*a^1.5)-1)/-2 and fades the rim with
  // smoothstep over THAT fraction of the radius, so the mapped number is the fade's own width. The
  // reference runs the maximum, which spreads the fade over the ENTIRE radius — one gradient from the
  // middle to nothing, which is what leaves no edge anywhere to see.
  const mapAtten = (a) => (Math.cos(Math.PI * Math.pow(a, 1.5)) - 1) / -2;
  ok("spec: the attenuation is the reference's maximum — the fade spans the whole radius",
    fx.MUZZLE_LIGHT.attenuation === 1 && Math.abs(mapAtten(fx.MUZZLE_LIGHT.attenuation) - 1) < 1e-9,
    `${fx.MUZZLE_LIGHT.attenuation} -> fade over ${mapAtten(fx.MUZZLE_LIGHT.attenuation).toFixed(3)} of the radius (core default 0.5 -> ${mapAtten(0.5).toFixed(3)})`);
  ok("spec: every source the flash builds carries that edge, not the source class's own default",
    [...omni, ...coneSpec].every(s => s.attenuation === fx.MUZZLE_LIGHT.attenuation),
    JSON.stringify([omni[0].attenuation, coneSpec[0].attenuation]));
  // ⏪⏪ THE COLOUR IS NOW DARKNESS-GATED (FR#23), so "illumination only" is one of two regimes rather
  // than the rule. Both are asserted at the spec level, driven by an explicit darkness so neither
  // depends on which scene the run happens to be looking at.
  const litSpecs = (over = {}) => fx.muzzleSourceSpecs({ ...specArgs, aimRad: 0, darkness: 0, ...over });
  const darkSpecs = (over = {}) => fx.muzzleSourceSpecs({ ...specArgs, aimRad: 0, darkness: 1, ...over });
  ok("spec: in a LIT scene no source carries a colour — the stain stays impossible (negative)",
    [...litSpecs(), ...litSpecs({ mode: "omni" }), ...litSpecs({ mode: "hybrid" })]
      .every(s => s.color === null) && fx.MUZZLE_LIGHT.color === null,
    JSON.stringify(litSpecs()[0].color));
  ok("spec: in a DARK scene every source carries the reference's own colour",
    [...darkSpecs(), ...darkSpecs({ mode: "omni" }), ...darkSpecs({ mode: "hybrid" })]
      .every(s => s.color === fx.MUZZLE_LIGHT.referenceColor)
    && fx.MUZZLE_LIGHT.referenceColor === "#943400",
    JSON.stringify(darkSpecs()[0].color));
  ok("spec: the regime turns on the threshold, and the lit side is inclusive-below it",
    fx.flashColorFor(1) === "#943400" && fx.flashColorFor(fx.MUZZLE_LIGHT.darknessColorThreshold) === "#943400"
    && fx.flashColorFor(fx.MUZZLE_LIGHT.darknessColorThreshold - 0.01) === null
    && fx.flashColorFor(0) === null,
    `threshold ${fx.MUZZLE_LIGHT.darknessColorThreshold}`);
  ok("spec: an unreadable darkness falls to the SAFE half — it can never stain a lit floor (negative)",
    fx.flashColorFor(undefined) === null && fx.flashColorFor(null) === null && fx.flashColorFor("x") === null,
    "undefined / null / non-numeric all read as lit");
  // PART 1: the violence knob. Asserted at the spec level AND as it reaches a built source, so a
  // raised value that failed to flow through would be caught.
  ok("spec: the flash carries the raised luminosity, and every source it builds gets it",
    fx.MUZZLE_LIGHT.luminosity === 0.65
    && darkSpecs()[0].luminosity === 0.65 && litSpecs()[0].luminosity === 0.65,
    `${fx.MUZZLE_LIGHT.luminosity} at the spec, ${darkSpecs()[0].luminosity} on the wedge`);
  ok("spec: the spill companion still scales off it rather than carrying its own number",
    fx.muzzleSourceSpecs({ ...specArgs, aimRad: 0, darkness: 1, mode: "hybrid" })[1].luminosity
      === Number((fx.MUZZLE_LIGHT.luminosity * fx.MUZZLE_LIGHT.spillLevel).toFixed(3)),
    String(fx.muzzleSourceSpecs({ ...specArgs, aimRad: 0, darkness: 1, mode: "hybrid" })[1].luminosity));
  // Core centres a limited-angle shape on rotation+90 degrees, so a wedge pointed along the aim
  // carries degrees(aim) − 90. Asserted at two aims so a constant could not satisfy it.
  ok("spec cone: the wedge is pointed by the aim, on the core's own rotation convention",
    coneSpec[0].rotation === -90
    && fx.muzzleSourceSpecs({ ...specArgs, aimRad: Math.PI / 2, mode: "cone" })[0].rotation === 0,
    `${coneSpec[0].rotation} / ${fx.muzzleSourceSpecs({ ...specArgs, aimRad: Math.PI / 2, mode: "cone" })[0].rotation}`);
  const hybrid = fx.muzzleSourceSpecs({ ...specArgs, aimRad: 0, mode: "hybrid" });
  ok("spec hybrid: the wedge PLUS a circular companion",
    hybrid.length === 2 && hybrid[0].key === "cone" && hybrid[1].key === "spill" && hybrid[1].angle === 360,
    JSON.stringify(hybrid.map(s => `${s.key}@${s.angle}`)));
  ok("spec hybrid: the wedge is unchanged from the wedge-only shape",
    JSON.stringify(hybrid[0]) === JSON.stringify(coneSpec[0]), JSON.stringify(hybrid[0]));
  ok("spec hybrid: the companion glows at a fraction of the intensity and lights nothing brightly",
    hybrid[1].bright === 0 && hybrid[1].dim === 1250
    && hybrid[1].alpha === Number((fx.MUZZLE_LIGHT.alpha * fx.MUZZLE_LIGHT.spillLevel).toFixed(3)),
    JSON.stringify(hybrid[1]));
  // INVERTED on report: a missing heading used to change the SHAPE — every mode answered a null aim
  // with the circle, so a discharge that named nothing to point at drew a plain radius while every
  // other discharge drew a wedge. It no longer does. Each mode builds its OWN shape whatever the
  // heading, and the heading itself is resolved upstream from the token's facing.
  const noAimShapes = ["cone", "hybrid", "omni"].map(m => fx.muzzleSourceSpecs({ ...specArgs, aimRad: null, mode: m }));
  ok("spec: a missing heading no longer swaps the shape — each mode still builds its own",
    noAimShapes[0].length === 1 && noAimShapes[0][0].key === "cone" && noAimShapes[0][0].angle === fx.MUZZLE_LIGHT.coneDegrees
    && noAimShapes[1].map(x => x.key).join(",") === "cone,spill"
    && noAimShapes[2].length === 1 && noAimShapes[2][0].key === "omni" && noAimShapes[2][0].angle === 360,
    noAimShapes.map(s => s.map(x => `${x.key}@${x.angle}`).join("+")).join(" / "));
  ok("spec: with no heading the wedge sits at the zero rotation, not at a random one (negative)",
    noAimShapes[0][0].rotation === 0 && noAimShapes[1][0].rotation === 0,
    `${noAimShapes[0][0].rotation} / ${noAimShapes[1][0].rotation}`);
  // THE REPORTED CHANGE: "remove the radius and expand the frontal cone". Both halves are pinned by
  // value — the default resolves to ONE wedge with no circular companion at all, and the wedge is
  // wider than it was. The other two shapes are kept and still build what they always did (asserted
  // above), so the choice stays a one-word edit for the tune session.
  ok("spec: the shipped default is the pure wedge", fx.MUZZLE_MODE === "cone", fx.MUZZLE_MODE);
  const shippedSpec = fx.muzzleSourceSpecs({ ...specArgs, aimRad: 0 });
  ok("spec: the shipped default contributes NO circular spill (negative — the removed radius)",
    shippedSpec.length === 1 && shippedSpec[0].key === "cone" && shippedSpec.every(x => x.key !== "spill" && x.angle !== 360),
    shippedSpec.map(x => `${x.key}@${x.angle}`).join("+"));
  // RE-PINNED to the reference's CONFIGURED value. The first number (110) had the geometry inverted;
  // the second (269) was measured off the reference's render and landed one degree inside the value
  // the guide's module actually sets, which is 270 — so the frame corroborates the config rather than
  // competing with it, and the config is what ships.
  ok("spec: the wedge is the reference's own configured width",
    fx.MUZZLE_LIGHT.coneDegrees === 270 && shippedSpec[0].angle === 270, String(shippedSpec[0].angle));
  ok("spec: the geometry is a rear NOTCH, not a forward beam — the unlit sector is the small one",
    (360 - fx.MUZZLE_LIGHT.coneDegrees) === 90 && fx.MUZZLE_LIGHT.coneDegrees > 180,
    `${fx.MUZZLE_LIGHT.coneDegrees} degrees lit -> ${(360 - fx.MUZZLE_LIGHT.coneDegrees)} degrees unlit`);
  // Still the constraint the earlier value was chosen for, and still satisfied by a wide margin: the
  // pool has to exceed what the SPRITE draws (the ray fan measured ~45-55 degrees across) or it just
  // traces the sprite and reads as part of it.
  ok("spec: the lit sector is several times the sprite fan it is meant to light beyond",
    fx.MUZZLE_LIGHT.coneDegrees > 55 * 3, String(fx.MUZZLE_LIGHT.coneDegrees));
  // The radii are held CONSTANT across the envelope — only intensity moves. A radius that grows and
  // shrinks is the "radiates out visibly" read this transport exists to remove, and holding it fixed
  // makes that impossible at ANY frame rate rather than merely unlikely at 60fps.
  ok("spec: scaling is by scene units, not baked pixels",
    fx.muzzleSourceSpecs({ gridDistance: 10, pixelsPerUnit: 20, aimRad: null })[0].dim === 2500,
    String(fx.muzzleSourceSpecs({ gridDistance: 10, pixelsPerUnit: 20, aimRad: null })[0].dim));

  /* ── 4b. aim synthesis: ONE axis, whether or not anything was aimed at ──── */
  // The mechanism that answers "which way is this pointed" for every part of a discharge. Pure, so
  // the axis is asserted by value: a heading from the token's rotation on core's own convention
  // (rotation 0 faces +y, which is screen-south), and a point that far down it.
  const axisAt = (deg) => fx.facingAimPoint({ x: 0, y: 0 }, deg, 100);
  ok("axis: the synthesized point is the mapped distance along the token's own facing",
    Math.round(axisAt(0).x) === 0 && Math.round(axisAt(0).y) === 100
    && Math.round(axisAt(90).x) === -100 && Math.round(axisAt(90).y) === 0
    && Math.round(axisAt(270).x) === 100 && Math.round(axisAt(270).y) === 0,
    [axisAt(0), axisAt(90), axisAt(270)].map(p => `${Math.round(p.x)},${Math.round(p.y)}`).join(" / "));
  ok("axis: the synthesized heading and the wedge rotation are inverses of each other",
    fx.muzzleSourceSpecs({ ...specArgs, aimRad: fx.facingRad(35) })[0].rotation === 35
    && fx.muzzleSourceSpecs({ ...specArgs, aimRad: fx.facingRad(-70) })[0].rotation === -70,
    `${fx.muzzleSourceSpecs({ ...specArgs, aimRad: fx.facingRad(35) })[0].rotation}`);
  // The resolver: a named token wins; with none, the shooter's own facing answers instead — and it
  // answers with a POINT, because the sprite, the tracer and the spray all travel toward one.
  const axisTargeted = fx.aimPointOf(tokenDoc, targetDoc, 100);
  const axisSynth = fx.aimPointOf(tokenDoc, null, 100);
  const axisOrigin = fx.centerOf(tokenDoc);
  ok("axis: a named token still wins — the synthesis is a fallback, not a replacement",
    Math.round(axisTargeted.x) === Math.round(fx.centerOf(targetDoc).x)
    && Math.round(axisTargeted.y) === Math.round(fx.centerOf(targetDoc).y),
    JSON.stringify(axisTargeted));
  ok("axis: with nothing named the resolver still returns a point, the mapped distance out",
    Number.isFinite(axisSynth?.x) && Number.isFinite(axisSynth?.y)
    && Math.abs(Math.hypot(axisSynth.x - axisOrigin.x, axisSynth.y - axisOrigin.y) - fx.FACING_AIM_SQUARES * 100) < 0.5,
    `${JSON.stringify(axisSynth)} at ${Math.round(Math.hypot(axisSynth.x - axisOrigin.x, axisSynth.y - axisOrigin.y))}px`);
  ok("axis: the synthesized distance clears the spray's own far edge, so specks land short of it",
    fx.FACING_AIM_SQUARES > fx.MUZZLE_MOTES.farSquares,
    `${fx.FACING_AIM_SQUARES} squares vs ${fx.MUZZLE_MOTES.farSquares}`);
  ok("axis: with no shooter at all there is nothing to derive an axis from (negative)",
    fx.aimPointOf(null, null, 100) === null && fx.facingAimPoint(null, 0, 100) === null);

  /* -- 4c. face-the-target: the turn, as pure arithmetic ------------------- */
  // The inverse of the facing conversion, on core's own convention: a token at rotation 0 faces +y,
  // so a point due EAST of the shooter is rotation 270 and a point due SOUTH is rotation 0.
  ok("turn: the rotation that points a token at a place is the facing conversion inverted",
    fx.faceTargetRotation({ x: 0, y: 0 }, { x: 100, y: 0 }) === 270
    && fx.faceTargetRotation({ x: 0, y: 0 }, { x: 0, y: 100 }) === 0
    && fx.faceTargetRotation({ x: 0, y: 0 }, { x: -100, y: 0 }) === 90,
    [270, 0, 90].map((e, i) => `${[[100,0],[0,100],[-100,0]][i]}=${fx.faceTargetRotation({x:0,y:0},{x:[[100,0],[0,100],[-100,0]][i][0],y:[[100,0],[0,100],[-100,0]][i][1]})}`).join(" "));
  ok("turn: it round-trips against the heading helper — the two conversions are inverses",
    Math.abs(fx.facingRad(fx.faceTargetRotation({ x: 0, y: 0 }, { x: 100, y: 0 })) % (2 * Math.PI)) < 1e-9,
    String(fx.facingRad(fx.faceTargetRotation({ x: 0, y: 0 }, { x: 100, y: 0 }))));
  ok("turn: nothing to face -> no rotation (negative)",
    fx.faceTargetRotation(null, { x: 1, y: 1 }) === null
    && fx.faceTargetRotation({ x: 5, y: 5 }, { x: 5, y: 5 }) === null);
  // The turn is the SHORT way round, which is what makes a sweep read as a turn rather than a spin.
  ok("turn: the sweep takes the shorter arc, signed, never the long way round",
    fx.rotationDeltaDeg(350, 10) === 20 && fx.rotationDeltaDeg(10, 350) === -20
    && Math.abs(fx.rotationDeltaDeg(0, 180)) === 180 && fx.rotationDeltaDeg(90, 90) === 0
    && Math.abs(fx.rotationDeltaDeg(0, 270)) === 90,
    `${fx.rotationDeltaDeg(350, 10)} / ${fx.rotationDeltaDeg(10, 350)}`);
  ok("turn: the sweep is a visible duration, not a snap, and the dead zone is a real angle",
    fx.FACE_TARGET.durationMs >= 100 && fx.FACE_TARGET.durationMs <= 600 && fx.FACE_TARGET.minDegrees > 0,
    `${fx.FACE_TARGET.durationMs}ms sweep, ${fx.FACE_TARGET.minDegrees} degree dead zone`);

  /* -- 4d. the self-luminous route, read off the LIVE engine --------------- */
  // "The tracer renders dark" was first answered with a high elevation, and that did not work: the
  // engine picks an effect's layer from its route flags alone and otherwise parents it to the primary
  // canvas group, which is the group the darkness is multiplied over — so an elevated sprite was
  // darkened exactly like an unelevated one. Measured on this rig at darkness 1.0, peak luminance in a
  // band along the shot line: every elevation-only case crushed to 15 of 255 whatever the class or the
  // colour filter, and the same asset reached 232 the moment it was routed above the lighting.
  //
  // So this leg reads the LAYER THE ENGINE ACTUALLY PUT IT IN, not the builder call — a route that
  // stops working would leave the builder call untouched and only show up here. Driven on the PISTOL,
  // which is where the defect was reported and the thinnest asset the table maps.
  const routeShot = await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "pistol", hit: true, light: false });
  await sleep(500);
  const routed = [...(globalThis.Sequencer?.EffectManager?.effects ?? [])]
    .map(e => ({ file: String(e.data?.file ?? "").split("/").pop(), above: !!e.data?.aboveLighting,
                 inPrimary: e.parent === canvas.primary }));
  const routedTracer = routed.filter(e => /bullet/.test(e.file));
  ok("route: the pistol's own tracer is drawn OUT of the group the darkness is applied to",
    routedTracer.length > 0 && routedTracer.every(e => e.above === true && e.inPrimary === false),
    `${routedTracer.length} tracer sprite(s): ${JSON.stringify(routedTracer)}`);
  // Asserted over WHAT IS STILL LIVE when this samples, not against a fixed count: the muzzle lance is
  // trimmed to a tenth of a second, so whether it is still in the list here is a race with the sample.
  // The claim that matters is that nothing the rail drew is sitting in the darkened group.
  ok("route: every self-luminous sprite of that shot takes the same route, not just the tracer",
    routed.length >= 2 && routed.every(e => e.above === true && e.inPrimary === false),
    `${routed.length} sprite(s) live at sample: ${routed.map(e => `${e.file}@${e.above ? "aboveLighting" : "primary"}`).join(", ")}`);
  ok("route: the shot claimed the parts it drew (control)",
    routeShot.muzzle === true && routeShot.tracer === true, JSON.stringify(routeShot));
  // Left to expire on its own rather than ended: ending effects while any one of them is still
  // initialising throws from inside the engine's own sprite construction ("cannot set volume of
  // null"), which is a harness trap on record and not a product fault. These last a second at most.
  await sleep(1600);
  /* -- 4e. the travelled dash ARRIVES at what it was aimed at -------------- */
  // Reported: "the shells hit, but visibly they always fall short". The endpoints were never short —
  // the sprite was scheduled to arrive at the same instant it was destroyed (with no speed set, the
  // engine drives a moved effect for its whole lifetime), and because the movement is stepped by the
  // RENDER loop while the lifetime is a wall-clock timeout, a client dropping frames killed it
  // part-way. Measured before the fix at 0.778 of the shot line, 155-162px short of a target whose
  // half-width is 50px.
  //
  // Sampled on a CLOCK rather than per frame: this renderer runs at a few frames a second, so a
  // per-frame sample reads the animated property far too coarsely to say where it ended up (the same
  // unchanged build read 0.556 that way and 0.778 on a clock).
  const arrivalOf = async (hit) => {
    globalThis.Sequencer?.EffectManager?.endAllEffects?.();
    await sleep(1200);
    const shooter = canvas.tokens.get(tokenDoc.id), target = canvas.tokens.get(targetDoc.id);
    const from = fx.centerOf(shooter), to = fx.centerOf(target);
    const line = Math.hypot(to.x - from.x, to.y - from.y);
    const seen = new Map();
    const t0 = performance.now();
    const iv = setInterval(() => {
      for (const e of (globalThis.Sequencer?.EffectManager?.effects ?? [])) {
        if (!/bullet/.test(String(e.data?.file ?? "")) || !e.position) continue;
        // (0,0) IS THE PRE-PLACEMENT SENTINEL, not a position — the engine parks a new effect at the
        // origin until its animations are initialised. The drift sampler further down has carried this
        // guard since it was written; this one did not, and on a busy rig it read the sentinel as the
        // LAST sample for a pellet created near the end of the window: reported as 1956px from the
        // target centre, which is simply the distance from the canvas origin. Same rule, same reason.
        if (e.position.x === 0 && e.position.y === 0) continue;
        // THE DISCHARGE COLUMN IS ALSO A BULLET FILE (FR#22) and it must not be counted as a pellet:
        // it is a STRETCHED bolt spanning the whole shot, so it never travels and its "arrival" is
        // meaningless here. It reported as a seventh pellet at fraction 0 when the column shipped.
        // Discriminated by what makes it the column — a drawn width that spans the shot line — rather
        // than by file name, so a re-mapped asset cannot quietly slip back in.
        const cb = e.sprite?.getBounds?.();
        if (cb?.width && cb.width / (Number(canvas.stage?.scale?.x) || 1) >= line * 0.5) continue;
        seen.set(e.id, { x: e.position.x, y: e.position.y });
      }
      if (performance.now() - t0 > 2600) clearInterval(iv);
    }, 8);
    await fx.fxShot(shooter, target, { weaponClass: "shotgun", hit, light: false });
    await sleep(2800);
    clearInterval(iv);
    return [...seen.values()].map(p => ({
      fraction: +(Math.hypot(p.x - from.x, p.y - from.y) / line).toFixed(3),
      toCentre: Math.round(Math.hypot(p.x - to.x, p.y - to.y)),
    }));
  };
  const halfWidth = (Number(canvas.dimensions.size) || 100) / 2;
  // RETRIED, bounded. The travel is stepped by the RENDER loop while the sprite's lifetime is a
  // wall-clock timeout, and the arrival hold is sized for a couple of dropped frames — on a software
  // rasteriser under load a stall can outlast it and leave one pellet short. That is a measurement
  // artifact of this renderer, not the product: a client painting at 60fps has sixteen steps of slack
  // where this has two. The assertions below are NOT retried, only the sample they read.
  // The retry covers BOTH ways this renderer can produce an unusable sample: a pellet that stalled
  // short, and a pellet that was never observed anywhere but the pre-placement origin — the sentinel
  // guard above drops those, which leaves the sample one pellet SHORT rather than wrong. Neither is a
  // product fact; both are this rasteriser. The assertions are still not retried.
  const arrivalUnusable = (rows) => rows.length !== shellRow.pellets || rows.some(pt => pt.toCentre > halfWidth);
  let hitArrival = await arrivalOf(true);
  for (let attempt = 0; attempt < 3 && arrivalUnusable(hitArrival); attempt++) {
    hitArrival = await arrivalOf(true);
  }
  ok("arrival: every pellet of a LANDING round finishes inside the token it was aimed at",
    hitArrival.length === shellRow.pellets && hitArrival.every(p => p.toCentre <= halfWidth),
    `${hitArrival.length} pellet(s), ${Math.max(...hitArrival.map(p => p.toCentre))}px worst from centre vs ${halfWidth}px half-width`);
  ok("arrival: and it finishes at the far end of the shot line, not part-way down it",
    hitArrival.every(p => p.fraction >= 0.95),
    `fractions ${hitArrival.map(p => p.fraction).join(",")}`);
  ok("arrival: the crossing time is still the class's own, not the sprite's lifetime",
    fx.FX_CLASSES.shotgun.dashMs > 0 && fx.DASH_ARRIVAL_HOLD_MS > 0
    && fx.presentationTailMs("shotgun") >= fx.FX_CLASSES.shotgun.dashMs,
    `${fx.FX_CLASSES.shotgun.dashMs}ms crossing + ${fx.DASH_ARRIVAL_HOLD_MS}ms hold`);
  // NEGATIVE: a MISS must NOT be made to arrive — the divergence design sends each pellet to its own
  // reach and angle, so the group splays wide and at mixed depths instead of converging.
  const missArrival = await arrivalOf(false);
  const missSpread = Math.max(...missArrival.map(p => p.fraction)) - Math.min(...missArrival.map(p => p.fraction));
  const hitSpread = Math.max(...hitArrival.map(p => p.fraction)) - Math.min(...hitArrival.map(p => p.fraction));
  ok("arrival: a MISSED round still splays instead of converging (negative)",
    missArrival.some(p => p.toCentre > halfWidth) && missSpread > hitSpread,
    `miss spread ${missSpread.toFixed(3)} of the line vs hit spread ${hitSpread.toFixed(3)}; worst ${Math.max(...missArrival.map(p => p.toCentre))}px from centre`);
  await sleep(1200);

  ok("impact: the hit confirmation is a different family from the muzzle spark, sized per class",
    fx.HIT_CONFIRM.key !== fx.MUZZLE_SPARK.key
    && Object.values(fx.FX_CLASSES).every(c => c.impactSquares > 0)
    && fx.FX_CLASSES.heavy.impactSquares > fx.FX_CLASSES.pistol.impactSquares,
    `${fx.HIT_CONFIRM.key} / pistol ${fx.FX_CLASSES.pistol.impactSquares} .. heavy ${fx.FX_CLASSES.heavy.impactSquares}`);

  /* ── 5. source lifecycle: it appears, it is a real light, it goes away ──── */
  // The flash is a light source this client builds and destroys. Nothing is persisted, so the whole
  // former write-sequence/restore/stale-recovery section is replaced by the source's own lifecycle.
  const shooterPlaceable = canvas.tokens.get(tokenDoc.id);
  // Scoped to THIS shooter. The collection is world-wide, so a human firing at the table while the
  // keeper runs puts THEIR flash in it — which says nothing about whether the rail cleans up after the
  // token this section is about. liveFlashCount() stays unscoped on purpose: it counts what this
  // CLIENT is drawing, and this client has drawn nothing yet.
  ok("lifecycle: nothing of ours is in the lighting collection before a shot",
    flashSources(tokenDoc.id).length === 0 && fx.liveFlashCount() === 0,
    `${flashSources(tokenDoc.id).length} for this shooter / ${flashSources().length} on the world`);

  holdOpen();
  const docBefore = foundry.utils.deepClone(tokenDoc._source);
  const writeMark = tokenWrites.length;
  const flashAim = fx.centerOf(targetDoc);
  const started = fx.muzzleFlashLocal(tokenDoc.id, flashAim, { mode: "hybrid" });
  await sleep(400);
  const live = flashSources(tokenDoc.id);
  ok("lifecycle: the flash reports started and is tracked for the token",
    started === true && fx.flashInFlight(tokenDoc.id) === true && fx.liveFlashCount() === 1, `${started} / ${fx.liveFlashCount()}`);
  ok("lifecycle: the default shape puts BOTH sources in the collection",
    live.length === 2 && live.map(l => l.part).sort().join(",") === "cone,spill", live.map(l => l.part).join(","));
  const coneSrc = live.find(l => l.part === "cone")?.s;
  const spillSrc = live.find(l => l.part === "spill")?.s;
  ok("lifecycle: both are attached and ACTIVE, not merely present",
    coneSrc?.attached === true && coneSrc?.active === true && spillSrc?.attached === true && spillSrc?.active === true,
    `${coneSrc?.attached}/${coneSrc?.active} ${spillSrc?.attached}/${spillSrc?.active}`);
  // The envelope values, on the live sources rather than on a pure return.
  const ppuLive = Number(canvas.dimensions.distancePixels) || (canvas.dimensions.size / canvas.dimensions.distance);
  const liveSpec = fx.muzzleSourceSpecs({
    gridDistance: Number(scene.grid?.distance) || 1, pixelsPerUnit: ppuLive,
    aimRad: Math.atan2(flashAim.y - shooterPlaceable.center.y, flashAim.x - shooterPlaceable.center.x), mode: "hybrid",
  });
  ok("lifecycle: the wedge carries the spec's radii, width and edge",
    coneSrc?.data.bright === liveSpec[0].bright && coneSrc?.data.dim === liveSpec[0].dim
    && coneSrc?.data.angle === fx.MUZZLE_LIGHT.coneDegrees
    && coneSrc?.data.attenuation === fx.MUZZLE_LIGHT.attenuation,
    JSON.stringify({ b: coneSrc?.data.bright, d: coneSrc?.data.dim, a: coneSrc?.data.angle, at: coneSrc?.data.attenuation }));
  // THE ILLUMINATION-ONLY RULE, on the live source. Core decides PER LAYER whether to render at all:
  // the coloration shader's own requirement is `hasColor`, which is set from `data.color !== null`.
  // So the assertion is the layer's active flag, not an opacity — an opacity would leave a layer that
  // still runs and still contributes. Both sources of the default set are checked.
  // ⏪⏪ RE-PINNED TO THE REGIME (FR#23). These read the LIVE source, and the live source now takes its
  // colour from the viewed scene's darkness — so what they assert is the regime this run is actually
  // in, and that the mechanism matches it on both sides. The review scene is dark, so the coloured
  // regime is the one exercised here; the lit regime's own assertion is at the spec level above, where
  // the darkness can be named rather than depended upon.
  const liveDark = fx.viewedSceneDarkness();
  const wantColor = fx.flashColorFor(liveDark);
  // ⚠ CORE NORMALISES THE COLOUR: what goes in as "#943400" comes back off the source as the packed
  // number 9712640, so the comparison is made in core's own units rather than against the string.
  const packed = (hex) => (hex === null ? null : Number(foundry.utils.Color.from(hex)));
  ok("lifecycle: the live source carries exactly the colour its scene's darkness selects",
    coneSrc?.data.color === packed(wantColor) && spillSrc?.data.color === packed(wantColor),
    `darkness ${liveDark} -> ${JSON.stringify(wantColor)} (${packed(wantColor)}), source ${JSON.stringify(coneSrc?.data.color)}`);
  ok("lifecycle: core's own colour flag agrees with the regime, and the layer follows it",
    coneSrc?._flags?.hasColor === (wantColor !== null)
    && coneSrc?.layers?.coloration?.active === (wantColor !== null)
    && spillSrc?.layers?.coloration?.active === (wantColor !== null),
    JSON.stringify({ hasColor: coneSrc?._flags?.hasColor, coloration: coneSrc?.layers?.coloration?.active }));
  ok("lifecycle: the illumination layer IS active — the flash still lights the floor",
    coneSrc?.layers?.illumination?.active === true,
    String(coneSrc?.layers?.illumination?.active));
  // WHY that makes it a no-op in an already-lit area, pinned as far as a value can pin it: the only
  // layer left blends MAX_COLOR against the scene's own lighting, so where the ambient already equals
  // or exceeds the pool the maximum is the ambient and nothing changes. The coloration layer is the
  // one that would paint over regardless of ambient, and it is the one taken out.
  // ⚠ NOT ASSERTED HERE: the rendered result itself. That is a GPU blend outcome and reading it back
  // means extracting pixels from the lighting container, which costs more than the claim is worth in
  // a keeper — the dark-scene and lit-scene eyes-on captures are the record for it instead.
  ok("lifecycle: the one remaining layer blends against the scene rather than painting over it",
    SourceClass._layers?.illumination?.blendMode === "MAX_COLOR"
    && SourceClass._layers?.coloration?.blendMode === "SCREEN",
    JSON.stringify({ illumination: SourceClass._layers?.illumination?.blendMode, coloration: SourceClass._layers?.coloration?.blendMode }));
  // The knob is one field: putting a colour back turns the layer on again. Driven on a throwaway
  // source so nothing that ships is left tinted.
  const tintProbe = new SourceClass({ sourceId: `${SCOPE}.flash.__tintprobe.cone` });
  tintProbe.initialize({ x: shooterPlaceable.center.x, y: shooterPlaceable.center.y, dim: 300, bright: 150,
    color: "#ffae42", alpha: 0.5, luminosity: 0.5, walls: true, vision: false, disabled: false });
  tintProbe.add();
  await sleep(150);
  ok("lifecycle: a colour in the spec would turn that layer back on (the control for the negative)",
    tintProbe.layers?.coloration?.active === true && tintProbe._flags?.hasColor === true,
    JSON.stringify({ coloration: tintProbe.layers?.coloration?.active, hasColor: tintProbe._flags?.hasColor }));
  try { tintProbe.destroy(); } catch (e) { /* already detached */ }
  await sleep(100);
  ok("lifecycle: the wedge is pointed at the aimed-at token, not at a fixed heading",
    Math.abs(Number(coneSrc?.data.rotation) - liveSpec[0].rotation) < 0.01,
    `${coneSrc?.data.rotation} vs ${liveSpec[0].rotation}`);
  ok("lifecycle: the companion is the circular one, at the reduced intensity",
    spillSrc?.data.angle === 360 && spillSrc?.data.bright === 0
    && Math.abs(Number(spillSrc?.data.alpha) - liveSpec[1].alpha) < 0.001,
    JSON.stringify({ a: spillSrc?.data.angle, b: spillSrc?.data.bright, al: spillSrc?.data.alpha }));
  // It is a REAL light source, so it computes a wall-constrained shape from its own origin — which is
  // what makes walls and line of sight clip it. A shape with no points would render nothing.
  ok("lifecycle: each source computed a real occlusion shape from its origin",
    coneSrc?.data.walls === true && (coneSrc?.shape?.points?.length ?? 0) > 0 && (spillSrc?.shape?.points?.length ?? 0) > 0,
    `walls=${coneSrc?.data.walls} cone=${coneSrc?.shape?.points?.length} spill=${spillSrc?.shape?.points?.length}`);
  ok("lifecycle: it lights the scene without granting anyone sight (negative)",
    coneSrc?.data.vision === false && spillSrc?.data.vision === false, `${coneSrc?.data.vision}/${spillSrc?.data.vision}`);

  /* ── 5a. THE LOAD-BEARING NEGATIVE: the token document is never touched ─── */
  // The whole point of the rewrite. The previous transport delivered the envelope by UPDATING THE
  // SHOOTER'S TOKEN DOCUMENT once per keyframe — four server round trips, each broadcast to every
  // client, which is what stretched an 85ms spec into ~1.3s of visible bloom. If a future edit puts a
  // write back into this path, this leg is what says so.
  const docDuring = scene.tokens.get(tokenDoc.id)._source;
  ok("no writes: the token document is byte-identical while a flash is running",
    JSON.stringify(docDuring) === JSON.stringify(docBefore), `${tokenWrites.length - writeMark} update(s) seen`);
  ok("no writes: the token's OWN light is untouched — not overwritten and not restored",
    docDuring.light.bright === baseLight.bright && docDuring.light.dim === baseLight.dim
    && docDuring.light.color === baseLight.color && docDuring.light.alpha === baseLight.alpha
    && docDuring.light.angle === baseLight.angle, JSON.stringify(docDuring.light));
  ok("no writes: no document update reached the shooter token at all (negative)",
    tokenWrites.length - writeMark === 0, tokenWrites.slice(writeMark).join(" | ") || "none");
  ok("no writes: no restore-anchor flag is parked on the token (negative)",
    scene.tokens.get(tokenDoc.id).getFlag(SCOPE, "fxBaseLight") === undefined
    && scene.tokens.get(tokenDoc.id).getFlag(SCOPE, "fxBaseLight") !== null,
    JSON.stringify(scene.tokens.get(tokenDoc.id).flags?.[SCOPE] ?? {}));

  /* ── 5b. the flash ENDS, inside a frame budget, leaving nothing behind ──── */
  releaseHold();
  await sleep(300);
  ok("teardown: the held flash is gone from the collection",
    flashSources().length === 0 && fx.liveFlashCount() === 0, String(flashSources().length));

  // The real, unheld envelope — measured in the render frames it actually consumes.
  const measured = await (async () => {
    const t0 = performance.now();
    fx.muzzleFlashLocal(tokenDoc.id, flashAim);
    let frames = 0;
    await new Promise(res => {
      const tick = () => { frames++; if (fx.flashInFlight(tokenDoc.id) && frames < 600) requestAnimationFrame(tick); else res(); };
      requestAnimationFrame(tick);
    });
    return { frames, ms: Math.round(performance.now() - t0) };
  })();
  out.measuredEnvelope = { ...measured, specFrames: fx.muzzleEnvelopeFrames(), nominalMs: fx.muzzleEnvelopeDurationMs() };
  // Frames, not milliseconds, is the assertion: this rig renders through a software rasteriser at a
  // small fraction of the reference rate, so a millisecond bound here would only measure the rig.
  ok("teardown: the envelope ends within one frame of its spec length",
    measured.frames >= fx.muzzleEnvelopeFrames() && measured.frames <= fx.muzzleEnvelopeFrames() + 2,
    `${measured.frames} frames / ${measured.ms}ms (spec ${fx.muzzleEnvelopeFrames()} frames)`);
  ok("teardown: nothing is left in the lighting collection afterwards",
    flashSources(tokenDoc.id).length === 0 && fx.flashInFlight(tokenDoc.id) === false,
    `${flashSources(tokenDoc.id).length} for this shooter / ${flashSources().length} on the world`);
  ok("teardown: the token document is still untouched after a full unheld envelope",
    JSON.stringify(scene.tokens.get(tokenDoc.id)._source) === JSON.stringify(docBefore)
    && tokenWrites.length - writeMark === 0, `${tokenWrites.length - writeMark} update(s)`);

  /* ── 5c. the three shapes, on the live canvas ──────────────────────────── */
  for (const [mode, expectParts] of [["cone", "cone"], ["omni", "omni"], ["hybrid", "cone,spill"]]) {
    holdOpen();
    fx.muzzleFlashLocal(tokenDoc.id, flashAim, { mode });
    await sleep(350);
    const parts = flashSources(tokenDoc.id).map(l => l.part).sort().join(",");
    ok(`shape "${mode}": produces exactly its own source set on the canvas`, parts === expectParts, parts || "none");
    releaseHold();
    await sleep(200);
  }
  // The SHIPPED default, taken through the same live path with no mode argument at all: what a table
  // actually gets is one wedge on the canvas and nothing circular beside it.
  holdOpen();
  fx.muzzleFlashLocal(tokenDoc.id, flashAim);
  await sleep(350);
  const shippedLive = flashSources(tokenDoc.id);
  ok("shipped shape: the default draws ONE wedge on the canvas, with no circular companion (negative)",
    shippedLive.length === 1 && shippedLive[0].part === "cone"
    && shippedLive[0].s.data.angle === fx.MUZZLE_LIGHT.coneDegrees,
    shippedLive.map(l => `${l.part}@${l.s.data.angle}`).join(",") || "none");
  releaseHold();
  await sleep(200);

  // INVERTED on report ("I only see a radius when it is discharged without a target… I want the same
  // effect either way"): with no announced heading the canvas gets the SAME wedge, pointed by the
  // token's own facing, rather than a circle. Asserted on the live source, not only in the pure spec.
  holdOpen();
  fx.muzzleFlashLocal(tokenDoc.id, null);
  await sleep(350);
  const noAimLive = flashSources(tokenDoc.id);
  ok("shape: no announced heading -> the SAME wedge on the canvas, never a circle",
    noAimLive.length === 1 && noAimLive[0].part === "cone"
    && noAimLive[0].s.data.angle === fx.MUZZLE_LIGHT.coneDegrees
    && noAimLive.every(l => l.s.data.angle !== 360),
    noAimLive.map(l => `${l.part}@${l.s.data.angle}`).join(",") || "none");
  releaseHold();
  await sleep(200);

  /* ── 5c-ii. the facing fallback, against CORE's own rotation convention ─── */
  // "Verify, don't assume": rather than re-deriving our own arithmetic, give a token a rotation and a
  // real limited-angle light of its own, and compare where CORE points that source with where our
  // flash points for the same rotation with no heading announced. The aimed-at token is used because
  // the shooter carries the load-bearing no-write negative.
  const facingWas = { rotation: targetDoc.rotation, light: foundry.utils.deepClone(targetDoc._source.light) };
  await targetDoc.update({ rotation: 40, light: { dim: 6, bright: 3, angle: 90 } });
  await sleep(400);
  // Core hangs a token's own light source off the placeable — `light` on this core, `lightSource` on
  // older ones. Read whichever this build exposes so the comparison is against core, not against a
  // property name.
  const facingPlaceable = canvas.tokens.get(targetDoc.id);
  const coreRotation = (facingPlaceable?.light ?? facingPlaceable?.lightSource)?.data?.rotation;
  holdOpen();
  fx.muzzleFlashLocal(targetDoc.id, null);
  await sleep(350);
  const facingLive = flashSources(targetDoc.id)[0];
  ok("facing: with no heading the wedge is pointed where CORE points that token's own light source",
    Number.isFinite(Number(coreRotation)) && Number(facingLive?.s.data.rotation) === Number(coreRotation),
    `ours ${facingLive?.s.data.rotation} vs core ${coreRotation}`);
  ok("facing: the pure conversion is the same one, read back as a heading",
    Math.abs(fx.facingRad(40) - ((40 + 90) * Math.PI) / 180) < 1e-9
    && Math.abs(fx.facingRad(0) - Math.PI / 2) < 1e-9,
    `${fx.facingRad(40)} / ${fx.facingRad(0)}`);

  /* ── 5c-iii. a width above 180 renders as a rear NOTCH, not as a beam ───── */
  // The load-bearing question for the re-pinned value: core's limited-angle shape is documented to
  // invert its edge test above 180 degrees, so ONE wedge of 269 should light everything except a 91
  // degree sector behind the shooter. Measured off the source's own occlusion polygon by sampling it
  // all the way round, so the claim is about what core built rather than about what we asked for.
  const notch = (() => {
    const src = facingLive?.s;
    const o = { x: src?.data.x, y: src?.data.y };
    const r = Math.max(20, Number(src?.data.dim ?? 0) * 0.35);
    const centre = Number(src?.data.rotation ?? 0) + 90;          // core's own convention
    const inside = [];
    for (let d = 0; d < 360; d++) {
      const a = ((centre + d) * Math.PI) / 180;                    // d = degrees off the heading
      inside.push(!!src?.shape?.contains(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r));
    }
    let run = 0, best = 0;
    for (let i = 0; i < 720; i++) { run = inside[i % 360] ? 0 : run + 1; best = Math.max(best, run); }
    return { lit: inside.filter(Boolean).length, dark: 360 - inside.filter(Boolean).length, widestDarkRun: best,
      rearDark: !inside[180] && !inside[175] && !inside[185], forwardLit: inside[0], flanksLit: inside[90] && inside[270] };
  })();
  ok("notch: core built ONE shape that is lit forward AND on both flanks",
    notch.forwardLit === true && notch.flanksLit === true, JSON.stringify(notch));
  ok("notch: the unlit sector is directly behind the heading and is the SMALL one",
    notch.rearDark === true && notch.dark < 180, JSON.stringify(notch));
  ok("notch: its measured width matches the spec within the polygon's own resolution",
    Math.abs(notch.widestDarkRun - (360 - fx.MUZZLE_LIGHT.coneDegrees)) <= 6,
    `${notch.widestDarkRun} degrees measured vs ${360 - fx.MUZZLE_LIGHT.coneDegrees} specified`);
  releaseHold();
  await sleep(200);
  await targetDoc.update({ rotation: facingWas.rotation, light: facingWas.light });
  await sleep(300);

  /* ── 5d. concurrency cap: one source set per token, restarted not stacked ─ */
  // The claim/release slot system the write transport needed is gone. What replaces it is simpler and
  // lives where the drawing happens: a token that is already flashing has its envelope RESTARTED in
  // place, so a burst of any length costs one source set per shooter and reads as a flicker.
  holdOpen();
  fx.muzzleFlashLocal(tokenDoc.id, flashAim, { mode: "hybrid" });
  await sleep(250);
  const firstKeys = flashSources(tokenDoc.id).map(l => l.key).sort().join(",");
  for (let i = 0; i < 5; i++) { fx.muzzleFlashLocal(tokenDoc.id, flashAim, { mode: "hybrid" }); await sleep(40); }
  const afterKeys = flashSources(tokenDoc.id).map(l => l.key).sort().join(",");
  ok("cap: five more rounds add no sources — the running flash is restarted in place",
    afterKeys === firstKeys && flashSources(tokenDoc.id).length === 2 && fx.liveFlashCount() === 1,
    `${flashSources(tokenDoc.id).length} sources / ${fx.liveFlashCount()} live`);
  // A SECOND token gets its own set — the cap is per token, not global.
  fx.muzzleFlashLocal(targetDoc.id, fx.centerOf(tokenDoc), { mode: "omni" });
  await sleep(250);
  ok("cap: a second shooter gets its own source set (the cap is per token)",
    fx.liveFlashCount() === 2 && flashSources(targetDoc.id).length === 1 && flashSources(tokenDoc.id).length === 2,
    `${fx.liveFlashCount()} live / ${flashSources().length} sources`);
  releaseHold();
  await sleep(250);
  ok("cap: clearing drops every live flash on this client", fx.liveFlashCount() === 0 && flashSources().length === 0, String(flashSources().length));

  /* ── 5e. the socket announcement ───────────────────────────────────────── */
  // One ping per shot on the module's own channel, in the module's own type-dispatch shape. The
  // emitter never receives its own datagram, so the firing client's flash comes from the local call.
  const realEmit = game.socket.emit.bind(game.socket);
  let emitted = [];
  game.socket.emit = (channel, data, ...rest) => { emitted.push({ channel, data }); return realEmit(channel, data, ...rest); };
  holdOpen();
  const announced = fx.fxMuzzleFlash(tokenDoc, flashAim);
  await sleep(300);
  const msg = emitted.find(e => e.data?.type === "fxMuzzleFlash");
  ok("socket: exactly one announcement, on the module's own channel",
    emitted.filter(e => e.data?.type === "fxMuzzleFlash").length === 1 && msg?.channel === `module.${SCOPE}`,
    `${emitted.length} emit(s) / ${msg?.channel}`);
  ok("socket: the message carries the type, the scene, the token and the aim",
    msg?.data?.tokenId === tokenDoc.id && msg?.data?.sceneId === scene.id
    && Math.round(msg?.data?.aim?.x) === Math.round(flashAim.x) && Math.round(msg?.data?.aim?.y) === Math.round(flashAim.y),
    JSON.stringify(msg?.data));
  // ONE source, not two: the shipped shape is the pure wedge, so a flash is a single source set of
  // one. (This leg read 2 while the default carried a circular companion beside the wedge.)
  ok("socket: the emitter also drew its own flash locally (it never receives its own datagram)",
    announced === true && flashSources(tokenDoc.id).length === 1, `${announced} / ${flashSources(tokenDoc.id).length}`);
  releaseHold();
  await sleep(200);
  // A shot with no aim announces a null aim rather than omitting the field or inventing a heading.
  emitted = [];
  holdOpen();
  fx.fxMuzzleFlash(tokenDoc, null);
  await sleep(250);
  ok("socket: an unaimed shot announces a null aim (negative)",
    emitted.find(e => e.data?.type === "fxMuzzleFlash")?.data?.aim === null,
    JSON.stringify(emitted.find(e => e.data?.type === "fxMuzzleFlash")?.data));
  releaseHold();
  await sleep(200);
  // The receiving side, driven through the registered listener rather than the local verb: a payload
  // for a scene this client is not viewing is dropped instead of drawn on the wrong canvas.
  emitted = [];
  game.socket.emit = realEmit;
  holdOpen();
  const wrongScene = fx.muzzleFlashLocal(tokenDoc.id, flashAim, { sceneId: "notthisscene00000" });
  await sleep(250);
  ok("socket: a payload for another scene draws nothing here (negative)",
    wrongScene === false && flashSources().length === 0, `${wrongScene} / ${flashSources().length}`);
  // A token this client is not drawing has no lighting to affect, so it gets nothing rather than throwing.
  const unknownToken = fx.muzzleFlashLocal("nosuchtoken000000", flashAim, { sceneId: scene.id });
  ok("socket: a token this client is not drawing produces nothing (negative)",
    unknownToken === false && flashSources().length === 0, String(unknownToken));
  releaseHold();
  await sleep(200);

  /* ── 6. payload fan-out + cadence ──────────────────────────────────────── */
  fx._setSoundManifest(["shot-rifle.ogg", "shot-pistol.ogg", "shot-heavy.ogg", "shot-smg.ogg", "shot-shotgun.ogg"]);
  const payload = (over = {}) => ({ attackerId: actor.id, weaponId: madeIds.rifle, weaponName: "__PW__FX rifle", areaDamages: {}, ...over });

  ok("cadence: the DEFAULT constant is the measured value", fx.SHOT_CADENCE_MS === 80, String(fx.SHOT_CADENCE_MS));
  // Cadence is now PER CLASS: the default is what a class inherits, not what every class runs at. The
  // reported defect was a shell payload reading as one continuous event, and the resolver is what the
  // fix hangs on, so each branch of it is pinned by value rather than one global constant being read.
  ok("cadence: a class naming no cadence of its own inherits the default",
    fx.classCadenceMs("rifle") === fx.SHOT_CADENCE_MS && fx.classCadenceMs("pistol") === fx.SHOT_CADENCE_MS,
    `rifle ${fx.classCadenceMs("rifle")} / pistol ${fx.classCadenceMs("pistol")}`);
  ok("cadence: the shell class runs at its own, slower spacing",
    fx.classCadenceMs("shotgun") === shellRow.cadenceMs && shellRow.cadenceMs === 180,
    `${fx.classCadenceMs("shotgun")}ms vs mapped ${shellRow.cadenceMs}ms`);
  ok("cadence: an unmapped or absent class falls back to the default (negative)",
    fx.classCadenceMs("nosuchclass") === fx.SHOT_CADENCE_MS && fx.classCadenceMs(null) === fx.SHOT_CADENCE_MS
    && fx.classCadenceMs(undefined) === fx.SHOT_CADENCE_MS,
    String(fx.classCadenceMs("nosuchclass")));
  // WHY that number, checked against the file's other constants rather than against taste: rounds have
  // to be far enough apart that the flash from one is fully OUT before the next one starts, or the
  // light never goes dark and the burst reads as one continuous event (which is what was reported at
  // the default spacing — the envelope is longer than the gap between rounds).
  const envelopeMs = fx.muzzleEnvelopeDurationMs();
  ok("cadence: the default spacing is shorter than the flash envelope — rounds run together by design",
    fx.SHOT_CADENCE_MS < envelopeMs, `${fx.SHOT_CADENCE_MS}ms spacing vs ${envelopeMs}ms envelope`);
  ok("cadence: the shell spacing clears the flash envelope with darkness to spare",
    fx.classCadenceMs("shotgun") >= envelopeMs * 2,
    `${fx.classCadenceMs("shotgun")}ms spacing vs ${envelopeMs}ms envelope (${fx.classCadenceMs("shotgun") - envelopeMs}ms dark)`);
  await drain();
  // ⚠ THE SHIPPED CONFIGURATION IS WHAT THESE SECTIONS RUN, drop rule and all — the seam is NOT armed
  // here, and that is deliberate. The two halves of the pacing rule only hold together: anchoring
  // alone lets a starved loop catch up by firing rounds back to back (measured on this host with the
  // threshold held out of reach: audio gaps of 230, 1, 240, 1 ms), and it is the drop that turns that
  // catch-up into a refusal instead of a bunch. So every count below is a count of rounds that were
  // DRAWN — `shots − dropped` — and every gap is a real gap between two rounds that happened.
  // Timer baseline for this client: four bare cadence waits — what the machine's own clock costs when
  // nothing else is happening. ⏪ IT IS NO LONGER THE THING THE SPAN IS COMPARED AGAINST (2026-08-09):
  // the loop is now anchored to a fixed schedule and sleeps only the REMAINDER to each slot, so it
  // deliberately does NOT accumulate this client's timer overshoot the way a chain of bare sleeps does
  // — measured here at 780ms of bare waits against a 320ms nominal schedule. Kept and reported because
  // it is the number that makes the anchored span meaningful, but the assertion below is against the
  // NOMINAL schedule, which is what the rule actually promises.
  const tBase = Date.now();
  for (let i = 0; i < 4; i++) await sleep(fx.SHOT_CADENCE_MS);
  const baseline = Date.now() - tBase;
  plays = [];
  const burstMark = tokenWrites.length;
  const t0 = Date.now();
  const burst = await fx.fxWeaponFired(payload({ shotsFired: 5, shotsHit: 2, areaDamages: { Torso: [{ damage: 4 }, { damage: 3 }] } }));
  const elapsed = Date.now() - t0;
  ok("fan-out: unit count from the payload", burst.shots === 5, JSON.stringify(burst));
  ok("fan-out: landed count from areaDamages", burst.hits === 2, String(burst.hits));
  ok("fan-out: one audio call per DRAWN round — a refused round is silent as well as unseen",
    plays.length === burst.shots - burst.dropped, `${plays.length} plays, ${burst.shots} rounds, ${burst.dropped} dropped`);
  const gaps = plays.slice(1).map((p, i) => p.t - plays[i].t);
  // Gaps between rounds that WERE drawn. Where a round in between was refused the gap is a multiple
  // of the cadence, never a fraction of it — which is the property the whole rule exists for.
  ok("cadence: no two drawn rounds are closer than HALF a slot — the separation the threshold guarantees",
    gaps.every(g => g >= (fx.SHOT_CADENCE_MS - fx.dropLagMsFor(fx.SHOT_CADENCE_MS)) * 0.9),
    `${gaps.join(",")} (${burst.dropped} dropped, floor ${Math.round((fx.SHOT_CADENCE_MS - fx.dropLagMsFor(fx.SHOT_CADENCE_MS)) * 0.9)}ms)`);
  // The span tracks the bare timer waits closely: nothing in the loop waits on a server at all any
  // more — the flash is a local object plus a datagram, and the sprite half broadcasts over its own
  // socket — so what is left is four sleeps plus the synchronous cost of handing each shot off.
  // Stated as what it is meant to prove rather than as a fixed ratio: the span is the cadence waits
  // plus effect work, and the effect work has to stay a MINORITY of one round's spacing or the loop is
  // being paced by the drawing instead of by the cadence. A flat 1.25× upper bound on the baseline was
  // measuring this client's timer variance as much as the rail (it read 0.93× and 1.28× on two runs of
  // identical code), which is not a claim about the product.
  // ⏪ RE-PINNED 2026-08-09 AGAINST THE NOMINAL SCHEDULE. The old form of this leg compared the span
  // to a chain of bare sleeps and required it to be no SHORTER — which was true of the loop that
  // accumulated timer overshoot and is false of the anchored one by design. What the rule promises is
  // that the burst lasts as long as the burst says it lasts, so that is what is asserted: the span
  // against `(rounds − 1) × cadence`, with the drop rule held out of reach so this is purely the
  // schedule. The pre-fix loop ran this same shape at 2.24× and could not have passed it.
  const nominal = (burst.shots - 1) * fx.SHOT_CADENCE_MS;
  // The only thing that can push the span past its nominal length is the LAST round's own lateness —
  // that round is never dropped, so the loop cannot end before it is issued. The rail reports the worst
  // lateness it saw, so the allowance is the mechanism's own number rather than a tolerance picked to
  // make the run pass.
  ok("cadence: the burst lasts its own schedule, plus only the last round's lateness",
    elapsed >= nominal * 0.9 && elapsed <= nominal + burst.maxLagMs + 120,
    `${elapsed}ms against a nominal ${nominal}ms + ${burst.maxLagMs}ms worst lateness (bare sleeps: ${baseline}ms)`);
  ok("cadence: the payload reports the spacing it actually ran at", burst.cadenceMs === fx.SHOT_CADENCE_MS, String(burst.cadenceMs));
  // Every round announces its own flash — nothing is dropped on the way out. The bound is applied
  // where the drawing happens (§5d): the shooter still ends up with ONE source set for the burst.
  ok("fan-out: every DRAWN round announces a flash — nothing is lost on the way out",
    burst.flashes === burst.shots - burst.dropped, `${burst.flashes} flashes / ${burst.shots} rounds − ${burst.dropped} dropped`);
  await sleep(600);
  ok("cap: a five-round burst leaves at most one source set on the shooter",
    fx.liveFlashCount() <= 1 && flashSources(tokenDoc.id).length <= 2,
    `${fx.liveFlashCount()} live / ${flashSources(tokenDoc.id).length} sources`);
  // The burst wrote nothing to the shooter's document — the same negative as §5a, at the real call site.
  ok("fan-out: a five-round burst touched the token document zero times (negative)",
    tokenWrites.length - burstMark === 0, `${tokenWrites.length - burstMark} update(s)`);
  await drain();

  /* ── 6a-ii. the multi-round-only treatments, gated at the real call site ── */
  // The reported rule: the spray of specks and the smoke wisp belong to AUTOMATIC fire only — the
  // reference's semi-automatic weapon, in the same scene, threw neither. The gate is the payload's own
  // round count, so it is pinned here where a real payload is resolved rather than only in the verb.
  await drain();
  const autoAim = await fx.fxWeaponFired(payload({
    shotsFired: 6, shotsHit: 3, targetTokenId: targetDoc.id,
    areaDamages: { Torso: [{ damage: 2 }, { damage: 2 }, { damage: 2 }] },
  }));
  await sleep(500);
  // ⏪⏪ INVERTED (FR#22). This leg used to require a RUN of smoke puffs across the burst. Our burst
  // smoke is retired: the tracer asset carries its own curls, and ours were a second smoke drawn over
  // the first. The specks are unaffected — they were never smoke.
  ok("burst gate: a multi-round payload reports its mote spray and NO puffs of ours (negative)",
    autoAim.motes === fx.FX_CLASSES.rifle.motes && autoAim.smokePuffs === 0
    && fx.smokePlanFor("rifle", autoAim.shots).emissions === 0,
    `${autoAim.motes} motes / ${autoAim.smokePuffs} puff(s) (mapped ${fx.FX_CLASSES.rifle.motes} motes)`);
  await drain();
  const singleAim = await fx.fxWeaponFired(payload({
    shotsFired: 1, shotsHit: 1, targetTokenId: targetDoc.id, areaDamages: { Torso: [{ damage: 2 }] },
  }));
  await sleep(400);
  ok("burst gate: a SINGLE-round payload reports neither (negative — the semi-automatic leg)",
    singleAim.shots === 1 && singleAim.motes === 0 && singleAim.smokePuffs === 0, JSON.stringify(singleAim));
  // INVERTED on report. A multi-round payload that names nothing to point at used to lose its specks
  // and its wisp along with its wedge — the gate bailed on the missing aim rather than on the round
  // count. The round count is the ONLY gate now; the axis comes from the shooter's own facing.
  await drain();
  const autoNoAim = await fx.fxWeaponFired(payload({
    shotsFired: 6, shotsHit: 0, areaDamages: {},
  }));
  await sleep(400);
  ok("burst gate: a multi-round payload with nothing named reports the SAME spray",
    autoNoAim.shots === 6 && autoNoAim.motes === fx.FX_CLASSES.rifle.motes && autoNoAim.smokePuffs === 0,
    `${autoNoAim.motes} motes / ${autoNoAim.smokePuffs} puff(s) (mapped ${fx.FX_CLASSES.rifle.motes} motes)`);
  ok("burst gate: named and unnamed report identical counts — the two cases are one effect",
    autoNoAim.motes === autoAim.motes && autoNoAim.smokePuffs === autoAim.smokePuffs,
    `${JSON.stringify({ named: [autoAim.motes, autoAim.smokePuffs], unnamed: [autoNoAim.motes, autoNoAim.smokePuffs] })}`);
  await drain();

  /* ── 6a-iii. the SHELL class gets the same treatments its row maps ──────── */
  // Reported missing on the shell class specifically ("the smoke and the embers"). The row has always
  // carried both fields and the fan-out is class-agnostic, so what was actually missing was the axis:
  // the treatments were skipped whenever nothing was named, which is how the class was test-fired.
  // Pinned at the real call site for BOTH cases, by the class's own mapped counts.
  const shellAmbPayload = (over = {}) => payload({ weaponId: madeIds.shotgun, weaponName: "__PW__FX shotgun", ...over });
  await drain();
  const shellAimed = await fx.fxWeaponFired(shellAmbPayload({
    shotsFired: 6, targetTokenId: targetDoc.id, areaDamages: { Torso: [{ damage: 2 }, { damage: 2 }] },
  }));
  await sleep(1400);
  // ⏪ INVERTED WITH THE REST (FR#22): a shell BURST draws no puffs of ours either. Only its SINGLE
  // discharge does, which is the leg below.
  ok("shell gate: a multi-round shell payload reports its row's spray and no puffs of ours (negative)",
    shellAimed.weaponClass === "shotgun" && shellAimed.motes === shellRow.motes && shellAimed.motes > 0
    && shellAimed.smokePuffs === 0 && fx.smokePlanFor("shotgun", shellAimed.shots).emissions === 0,
    `${shellAimed.motes} motes / ${shellAimed.smokePuffs} puff(s) (mapped ${shellRow.motes} motes)`);
  await drain();
  const shellUnaimed = await fx.fxWeaponFired(shellAmbPayload({ shotsFired: 6, areaDamages: {} }));
  await sleep(1400);
  ok("shell gate: the same payload with nothing named reports the same spray",
    shellUnaimed.weaponClass === "shotgun" && shellUnaimed.motes === shellRow.motes
    && shellUnaimed.smokePuffs === shellAimed.smokePuffs,
    `${shellUnaimed.motes} motes / ${shellUnaimed.smokePuffs} puff(s) (mapped ${shellRow.motes} motes)`);
  // ⏪ RE-PINNED (FR#20). This leg used to read "a SINGLE shell round reports NEITHER" — the round-count
  // gate applied to both treatments. That is what the table actually saw as "I don't see it at all for
  // shotguns": the shell's ordinary trigger pull is ONE round, so the gate removed its smoke every time,
  // while the same table's rifle and SMG are fired on auto and smoked. The gate is now per-row for the
  // smoke only, so the two halves SPLIT here and the leg asserts the split rather than the old pair.
  let shellSingleRead = null;
  ok("shell gate: a SINGLE shell round smokes but throws no specks — the two gates now differ",
    await (async () => {
      await drain();
      shellSingleRead = await fx.fxWeaponFired(shellAmbPayload({ shotsFired: 1, areaDamages: { Torso: [{ damage: 5 }] } }));
      await sleep(600);
      return shellSingleRead.shots === 1 && shellSingleRead.motes === 0 && shellSingleRead.smokePuffs === 1;
    })(), JSON.stringify(shellSingleRead));
  // And the classes that did NOT opt out are untouched by that split — the same single round through a
  // rifle still draws neither, which is the ruling the reference set and it still stands for them.
  let rifleSingleRead = null;
  ok("shell gate: a single RIFLE round still draws neither — the opt-out is per row (negative)",
    await (async () => {
      await drain();
      rifleSingleRead = await fx.fxWeaponFired(payload({ shotsFired: 1, targetTokenId: targetDoc.id, areaDamages: { Torso: [{ damage: 5 }] } }));
      await sleep(600);
      return rifleSingleRead.shots === 1 && rifleSingleRead.motes === 0 && rifleSingleRead.smokePuffs === 0;
    })(), JSON.stringify(rifleSingleRead));
  await drain();

  /* ── 6b. each sprite starts in the same tick as its OWN unit's audio ────── */
  // The visual half used to be handed to the per-actor token-write queue AND to wait on the light
  // envelope before the Sequence was even built, which put every sprite a full beat behind the sound
  // the same unit made (measured on this rig before the change: 1126 / 1197 / 1337 / 1494 / 1794 ms,
  // widening as the queue backed up). The two halves now start together, so the offset is asserted by
  // value rather than left to the eye. Needs a real aimed-at token — with no aim there is no sprite.
  await drain();
  const realSeqPlay = globalThis.Sequence.prototype.play;
  const seqPlays = [];
  // Record WHAT each sequence carries, not just when it played: a burst now plays the ambience, the
  // smoke puffs (their own sections, at the class's stride) and the rounds, so "the sequence for round
  // i" has to be identified by content rather than by position.
  globalThis.Sequence.prototype.play = function (...a) {
    const files = (this.sections ?? []).map(sec => String(sec?._file ?? sec?.file ?? ""));
    const isSmoke = files.length > 0 && files.every(f => /SmokePuffSide|smoke\.puff/.test(f));
    const isAmbience = !isSmoke && files.some(f => f.includes(fx.MUZZLE_MOTES.key));
    // The blood splash is a once-per-payload sequence like the ambience, and it plays BEFORE the
    // rounds. Left unclassified it counts as a sixth "round" and shifts every sprite-vs-audio pairing
    // by one — which is exactly what this leg reported the first time the gore switch was left on.
    const isBlood = !isSmoke && !isAmbience && files.some(f => f.includes(fx.BLOOD_SPLATTER.key));
    seqPlays.push({ t: Date.now(), isSmoke, isAmbience, isBlood });
    return realSeqPlay.apply(this, a);
  };
  plays = [];
  const aimedBurst = await fx.fxWeaponFired(payload({
    shotsFired: 5, shotsHit: 5, targetTokenId: targetDoc.id,
    areaDamages: { Torso: [{ damage: 2 }, { damage: 2 }, { damage: 2 }, { damage: 2 }, { damage: 2 }] },
  }));
  await sleep(500);
  globalThis.Sequence.prototype.play = realSeqPlay;
  // A multi-round payload now plays ONE extra sequence ahead of the rounds — the burst ambience (the
  // mote spray and the smoke wisp, §9e). It is deliberately not per round, so the count is units + 1
  // and the first play is the ambience; the per-unit sync below is measured on the rounds themselves.
  const smokeSeqs = seqPlays.filter(x => x.isSmoke);
  const ambienceSeqs = seqPlays.filter(x => x.isAmbience);
  const bloodSeqs = seqPlays.filter(x => x.isBlood);
  const shotSeqPlays = seqPlays.filter(x => !x.isSmoke && !x.isAmbience && !x.isBlood).map(x => x.t);
  // The gore switch is a world setting a GM may have left either way, so this leg says what it EXPECTS
  // of it rather than assuming: the payload above lands on a real target, so one splash if the switch
  // is on and none if it is off — and either way it is not one of the rounds.
  // ⏪ RE-PINNED 2026-08-09: the splash is now ONE PER LANDING ROUND (capped), not one per payload.
  // This burst lands all five of its rounds, so the count is the cap — and the legs below still need
  // it excluded from the ROUNDS, which is what this classification is actually for.
  const goreOn = game.settings.get(SCOPE, "goreEnabled") === true;
  // A refused round draws no spray either, so the expected count is what the fan-out itself reports
  // it queued — bounded by the hits and by the cap, both asserted here so the report cannot be trusted
  // blindly.
  const expectedSplashes = goreOn ? (aimedBurst.blood?.queued ?? 0) : 0;
  ok("aimed burst: a splash per drawn landing round up to the cap, and none of them is one of the rounds",
    bloodSeqs.length === expectedSplashes
    && expectedSplashes <= Math.min(aimedBurst.hits, fx.BLOOD_SPLATTER.maxPerPayload),
    `switch ${goreOn ? "on" : "off"}, ${aimedBurst.hits} hits, ${aimedBurst.dropped} dropped -> ${bloodSeqs.length} splash sequence(s)`);
  // ⏪ RE-PINNED (FR#22): a burst's sequence count is now units + the one ambience, with NO puff
  // sequences among them — the smoke a viewer sees in a burst is inside the tracer clips themselves.
  ok("aimed burst: one sequence per DRAWN round plus the burst ambience, and no puff sequences (negative)",
    shotSeqPlays.length === aimedBurst.shots - aimedBurst.dropped
    && ambienceSeqs.length === 1
    && smokeSeqs.length === 0 && aimedBurst.smokePuffs === 0,
    `${seqPlays.length} sequences = ${shotSeqPlays.length} units + ${ambienceSeqs.length} ambience + ${smokeSeqs.length} puff(s)`);
  const syncGaps = shotSeqPlays.map((t, i) => t - (plays[i]?.t ?? t));
  ok("sync: every sprite starts within 100ms of its own round's audio",
    syncGaps.length === aimedBurst.shots - aimedBurst.dropped && syncGaps.length > 0
    && syncGaps.every(g => Math.abs(g) <= 100), `${syncGaps.join(",")} (${aimedBurst.dropped} dropped)`);
  await drain();

  /* ── 6c. asset selection by round count, at the real fan-out call site ──── */
  // The selection legs above act on the resolver; these act on the path the table actually takes when
  // a payload arrives, recorded at the core audio entry point.
  fx._setSoundManifest(["shot-shotgun.ogg", "shot-shotgun-burst.ogg", "shot-rifle.ogg"]);
  const shellPayload = (over = {}) => payload({ weaponId: madeIds.shotgun, weaponName: "__PW__FX shotgun", ...over });

  plays = [];
  await fx.fxWeaponFired(shellPayload({ shotsFired: 1, areaDamages: { Torso: [{ damage: 5 }] } }));
  ok("fan-out: a single-round payload plays the class's full-bodied asset",
    plays.length === 1 && plays[0].src === `${dir}/shot-shotgun.ogg`, JSON.stringify(plays.map(p => p.src)));
  await sleep(700); await drain();

  plays = [];
  const shellBurstT0 = Date.now();
  const shellBurst = await fx.fxWeaponFired(shellPayload({ shotsFired: 5, areaDamages: {} }));
  const shellElapsed = Date.now() - shellBurstT0;
  ok("fan-out: every DRAWN round of a multi-round payload plays the class's short asset",
    plays.length === shellBurst.shots - shellBurst.dropped && plays.length > 0
    && plays.every(p => p.src === `${dir}/shot-shotgun-burst.ogg`),
    `${plays.length} plays (${shellBurst.dropped} dropped): ${JSON.stringify([...new Set(plays.map(p => p.src))])}`);

  /* ── 6c-ii. the class's own spacing is what a shell payload actually runs at ── */
  // The whole point of the per-class override: the AUDIO, the pellet fan and the flash restart are all
  // driven off one wait in the fan-out loop, so proving the audio landed at the shell spacing proves
  // all three did. Measured on the same client that measured the default-spacing burst above, and
  // compared against ITS OWN bare-timer baseline — the two bursts are then directly comparable rather
  // than each being judged against a nominal number the host cannot hit.
  const tShellBase = Date.now();
  for (let i = 0; i < 4; i++) await sleep(fx.classCadenceMs("shotgun"));
  const shellBaseline = Date.now() - tShellBase;
  ok("cadence: the shell payload reports its own spacing, not the default",
    shellBurst.cadenceMs === fx.classCadenceMs("shotgun") && shellBurst.cadenceMs !== fx.SHOT_CADENCE_MS,
    `${shellBurst.cadenceMs}ms vs default ${fx.SHOT_CADENCE_MS}ms`);
  const shellGaps = plays.slice(1).map((p, i) => p.t - plays[i].t);
  ok("cadence: every shell gap between drawn rounds clears half the shell's own slot",
    shellGaps.length === Math.max(0, plays.length - 1)
    && shellGaps.every(g => g >= (fx.classCadenceMs("shotgun") - fx.dropLagMsFor(fx.classCadenceMs("shotgun"))) * 0.9),
    `${shellGaps.join(",")} (${shellBurst.dropped} dropped)`);
  // ⏪ RE-PINNED against the nominal schedule, for the reason given at the default-spacing leg: the
  // anchored loop no longer accumulates this client's timer overshoot, so a bare-sleep baseline is no
  // longer the right yardstick. What still matters, and is still asserted, is that the shell's own
  // spacing is what it ran at — so its burst is visibly longer than the default-spacing one.
  const shellNominal = (shellBurst.shots - 1) * fx.classCadenceMs("shotgun");
  ok("cadence: the shell burst lasts its own schedule, and clearly longer than the default-spacing one",
    shellElapsed >= shellNominal * 0.9 && shellElapsed <= shellNominal + shellBurst.maxLagMs + 120
    && shellElapsed > elapsed,
    `shell ${shellElapsed}ms against a nominal ${shellNominal}ms + ${shellBurst.maxLagMs}ms worst lateness (bare sleeps ${shellBaseline}ms) vs default-spacing ${elapsed}ms`);
  out.cadenceSpans = { defaultSpacing: { elapsed, baseline }, shellSpacing: { elapsed: shellElapsed, baseline: shellBaseline, gaps: shellGaps } };
  await sleep(900); await drain();

  /* ── 6d. what the fan costs, against the cadence it runs at ────────────── */
  // Measured on the REAL engine, not a stand-in: a ten-round fanned burst draws `pellets` times the
  // tracers a ten-round single-bolt burst draws. The two bursts can no longer be compared to EACH
  // OTHER — they deliberately run at different spacings now, so the shell one is longer by design and
  // a shell-vs-rifle span comparison would fail for the wrong reason. Each is instead compared against
  // what its OWN cadence costs this client in bare timer waits: what that difference isolates is the
  // effect work, which is the thing the pellet count could actually make unaffordable. Frame pacing is
  // sampled alongside the wall clock and reported — a span that held while the canvas stalled would
  // not be an honest result.
  const measureBurst = async (p) => {
    const frames = [];
    let sampling = true;
    const tick = (t) => { frames.push(t); if (sampling) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const t = Date.now();
    const r = await fx.fxWeaponFired(p);
    const span = Date.now() - t;
    await sleep(1200);
    sampling = false;
    const gaps = frames.slice(1).map((v, i) => v - frames[i]);
    return { span, shots: r.shots, frames: frames.length, worstGapMs: gaps.length ? Math.round(Math.max(...gaps)) : null };
  };
  // What nine bare waits at each cadence cost THIS client, measured right here so the comparison is
  // against the machine's actual timer resolution rather than the nominal number.
  const bareCost = async (ms) => { const t = Date.now(); for (let i = 0; i < 9; i++) await sleep(ms); return Date.now() - t; };
  const rifleBare = await bareCost(fx.SHOT_CADENCE_MS);
  const shellBare = await bareCost(fx.classCadenceMs("shotgun"));
  const rifleCost = await measureBurst(payload({ shotsFired: 10, targetTokenId: targetDoc.id, areaDamages: {} }));
  await drain();
  const shellCost = await measureBurst(shellPayload({ shotsFired: 10, targetTokenId: targetDoc.id, areaDamages: {} }));
  await drain();
  const rifleWork = rifleCost.span - rifleBare, shellWork = shellCost.span - shellBare;
  out.burstCost = {
    pelletsPerRound: shellRow.pellets,
    rifle: { ...rifleCost, cadenceMs: fx.SHOT_CADENCE_MS, bareWaitsMs: rifleBare, effectWorkMs: rifleWork, perRoundMs: Math.round(rifleWork / 10) },
    shell: { ...shellCost, cadenceMs: fx.classCadenceMs("shotgun"), bareWaitsMs: shellBare, effectWorkMs: shellWork, perRoundMs: Math.round(shellWork / 10) },
  };
  ok("cost: both ten-round bursts resolve every round", shellCost.shots === 10 && rifleCost.shots === 10,
    `${rifleCost.shots} / ${shellCost.shots}`);
  ok("cost: the fanned burst's effect work stays under one round of its own spacing",
    shellWork / 10 <= fx.classCadenceMs("shotgun"),
    `${Math.round(shellWork / 10)}ms per round vs ${fx.classCadenceMs("shotgun")}ms spacing`);
  ok("cost: the burst is paced by its cadence, not by the drawing — the waits dominate the span",
    shellCost.span <= shellBare * 1.5 && rifleCost.span <= rifleBare * 1.5,
    `shell ${shellCost.span}ms vs ${shellBare}ms of bare waits / bolt ${rifleCost.span}ms vs ${rifleBare}ms`);
  ok("cost: the canvas kept producing frames throughout both bursts",
    shellCost.frames > 0 && rifleCost.frames > 0 && shellCost.worstGapMs < 1000,
    `shell ${shellCost.frames} frames, worst gap ${shellCost.worstGapMs}ms`);
  // What the MULTI-ROUND-ONLY treatments cost. Both bursts above ALREADY carry them (they are aimed,
  // so the spray and the wisp are drawn) — so the per-round figures reported here are the whole cost
  // including them. This leg prices the addition on its own by timing the verb directly, which is the
  // only clean comparison available: turning it off by removing the aim also removes the flash sprite
  // and the tracer, so an aimed-vs-unaimed burst would be pricing three things and calling it one.
  // It is charged ONCE PER BURST, not once per round, which is what keeps it affordable at all.
  await drain();
  const ambT0 = performance.now();
  for (let i = 0; i < 5; i++) {
    await fx.fxBurstAmbience(tokenDoc, targetDoc, { weaponClass: "rifle", shots: 10, cadenceMs: fx.SHOT_CADENCE_MS });
    await sleep(120);
  }
  const ambPerCall = Math.round((performance.now() - ambT0 - 5 * 120) / 5);
  await drain();
  out.ambienceCost = { perBurstMs: ambPerCall, amortisedPerRoundMs: Math.round(ambPerCall / 10),
    motes: fx.FX_CLASSES.rifle.motes, cadenceMs: fx.SHOT_CADENCE_MS };
  // Stated AMORTISED, because once-per-burst is the whole point of the design: the cost is paid one
  // time and spread across every round of the burst, so what has to stay affordable is that share, not
  // the single call. On this client (a software rasteriser) it is roughly 14ms per queued sprite.
  ok("cost: the spray and the wisp, spread across the burst they belong to, stay under one round's spacing",
    (ambPerCall / 10) <= fx.SHOT_CADENCE_MS,
    `${ambPerCall}ms once for ${fx.FX_CLASSES.rifle.motes} specks + 1 wisp = ${Math.round(ambPerCall / 10)}ms per round of a ten-round burst, against ${fx.SHOT_CADENCE_MS}ms spacing`);

  // The spacing sections are over — hand the drop threshold back to the shipped value. §17 arms it
  // again, deliberately, to assert the refusals.
  fx._setDropLagMs(null);
  ok("cadence: the drop-threshold seam is disarmed after the spacing sections",
    fx.dropLagMsFor(fx.SHOT_CADENCE_MS) === fx.SHOT_CADENCE_MS * fx.FX_DROP_LAG_FRACTION,
    String(fx.dropLagMsFor(fx.SHOT_CADENCE_MS)));

  fx._setSoundManifest(["shot-rifle.ogg", "shot-pistol.ogg", "shot-heavy.ogg", "shot-smg.ogg", "shot-shotgun.ogg"]);

  plays = [];
  const noCount = await fx.fxWeaponFired(payload({ areaDamages: { Torso: [{ damage: 1 }], Head: [{ damage: 2 }, { damage: 3 }] } }));
  ok("fallback: count derived from landed rounds when absent", noCount.shots === 3 && noCount.hits === 3, JSON.stringify(noCount));
  ok("fallback: one audio call per DRAWN derived unit",
    plays.length === noCount.shots - noCount.dropped, `${plays.length} of ${noCount.shots} − ${noCount.dropped}`);
  await sleep(900);

  plays = [];
  const missOnly = await fx.fxWeaponFired(payload({ areaDamages: {} }));
  ok("fallback: nothing landed still resolves one unit", missOnly.shots === 1 && missOnly.hits === 0, JSON.stringify(missOnly));
  ok("fallback: one audio call for the single unit", plays.length === 1, String(plays.length));
  await sleep(500);

  const capped = fx.shotCountOf({ shotsFired: 500, areaDamages: {} });
  ok("fan-out: unit count capped", capped === fx.MAX_FX_SHOTS, String(capped));

  /* ── 7. unmapped type produces nothing (negative) ──────────────────────── */
  await drain();
  plays = [];
  const meleeMark = tokenWrites.length;
  const meleeRes = await fx.fxWeaponFired(payload({ weaponId: madeIds.melee, weaponName: "__PW__FX melee", areaDamages: { Torso: [{ damage: 6 }] } }));
  await sleep(600);
  ok("unmapped type: rail skipped on class", meleeRes.skipped === "class" && meleeRes.shots === 0, JSON.stringify(meleeRes));
  ok("unmapped type: no audio call (negative)", plays.length === 0, String(plays.length));
  ok("unmapped type: no flash source and no document write (negative)",
    flashSources().length === 0 && fx.liveFlashCount() === 0 && tokenWrites.length - meleeMark === 0,
    `${flashSources().length} sources / ${tokenWrites.length - meleeMark} update(s)`);

  /* ── 8. world switch off disables the rail (negative) ──────────────────── */
  const settingWas = game.settings.get(SCOPE, "combatFxEnabled");
  ok("switch: registered and defaults on", game.settings.settings.has(`${SCOPE}.combatFxEnabled`) && game.settings.settings.get(`${SCOPE}.combatFxEnabled`).default === true);
  await game.settings.set(SCOPE, "combatFxEnabled", false);
  plays = [];
  const offRes = await fx.fxWeaponFired(payload({ shotsFired: 3 }));
  ok("switch off: rail skipped", offRes.skipped === "disabled" && offRes.shots === 0, JSON.stringify(offRes));
  ok("switch off: no audio call (negative)", plays.length === 0, String(plays.length));
  // the WIRED listener (registered at ready), driven through the real hook
  Hooks.callAll("cyberpunk2020.weaponFired", payload({ shotsFired: 2, areaDamages: { Torso: [{ damage: 2 }] } }));
  await sleep(400);
  ok("switch off: wired listener emits nothing (negative)", plays.length === 0, String(plays.length));
  await game.settings.set(SCOPE, "combatFxEnabled", true);
  plays = [];
  Hooks.callAll("cyberpunk2020.weaponFired", payload({ shotsFired: 2, areaDamages: { Torso: [{ damage: 2 }] } }));
  await sleep(500);
  ok("switch on: wired listener drives the rail", plays.length === 2, String(plays.length));
  await sleep(900);
  await game.settings.set(SCOPE, "combatFxEnabled", settingWas);

  /* ── 9. the installed engine, then the two branches it cannot show ─────── */
  // Against the REAL engine + the real asset tier: a mapped shot must claim both sprite parts (the
  // rendered result itself is the eyes-on record, not something a headless assertion can stand in for).
  const realShot = await fx.fxShot(tokenDoc, tokenDoc, { weaponClass: "rifle", hit: true, light: false });
  await sleep(300);
  ok("installed engine: a mapped shot claims both the flash and the tracer",
    realShot.muzzle === true && realShot.tracer === true, JSON.stringify(realShot));

  /* ── 9a-ii. what the two tracer shapes MEASURE on the real engine ──────── */
  // The builder legs below pin what the adapter ASKS for; this pins what the engine then DRAWS, in
  // pixels, on this scene's grid — the difference a viewer actually sees. Sampled per animation frame
  // while the shot is in flight, because a travelled dash is gone before the sequence resolves (an
  // after-the-fact read returns nothing, which would look like "no tracer" rather than a short one).
  const gridPx = Number(canvas.scene?.grid?.size) || 100;
  const drawnTracer = async (cls, key, ms) => {
    // Settle first, THEN clear: anything still initializing from an earlier section has finished by
    // now, so the clear cannot land mid-setup (see the note at the end of this helper).
    await sleep(1200);
    Sequencer.EffectManager.endAllEffects();
    await sleep(400);
    const seen = [];
    let sampling = true;
    const tick = () => {
      if (!sampling) return;
      for (const e of Sequencer.EffectManager.effects) {
        if (String(e.data?.file ?? "") !== key) continue;
        const w = Math.round(e.sprite?.width ?? 0), h = Math.round(e.sprite?.height ?? 0);
        if (w > 0) seen.push({ w, h, x: Math.round(e.position?.x ?? 0), y: Math.round(e.position?.y ?? 0),
          vis: e.sprite?.visible === true, moves: !!e.data?.moves });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    fx.fxShot(tokenDoc, targetDoc, { weaponClass: cls, hit: true, light: false });
    await sleep(ms);
    sampling = false;
    // NOT torn down here. Ending an effect while its sprite is still being built tears the sprite out
    // from under the engine's own setup (`CanvasEffect._createSprite` sets `this.sprite.volume` after
    // an await, with no re-check), which throws inside the third-party module and trips the
    // 0-console-errors gate for a reason that has nothing to do with what is being measured. This
    // client draws at a few frames per second, so "long enough" is not a safe assumption — the
    // effects are left to expire on their own instead, and the NEXT measurement clears them after a
    // settling wait. Verified: 60 rounds / 360 pellets fired at three durations, cold and warm, with
    // no teardown produced 0 errors; the same shots with a teardown behind them produced the throw.
    const muzzle = fx.centerOf(tokenDoc);
    const offsets = seen.map(s => Math.round(Math.hypot(s.x - muzzle.x, s.y - muzzle.y)));
    return { frames: seen.length, w: seen[0]?.w ?? 0, h: seen[0]?.h ?? 0, visible: seen.every(s => s.vis),
      moves: seen.every(s => s.moves), offsets: [...new Set(offsets)].slice(0, 8),
      minOffset: offsets.length ? Math.min(...offsets) : null };
  };
  // RETRIED when the host's frame budget denied a sample. A sprite's width reads 0 for its first few
  // rendered frames (the texture has not sized yet), so a measurement only lands if the sampler is
  // given frames AFTER that point — and this client draws through a software rasteriser at a few
  // frames per second, on a scene whose lighting it has to recompute. It was found returning zero
  // frames once the rig's active scene changed to a fully dark one, on a build whose drawn sizes were
  // verified correct in isolation (the pellet measured at exactly its mapped 100px). So the retry is
  // for the SAMPLING, not for the mechanism: every attempt is an ordinary shipped-duration round
  // under identical conditions, and the first attempt that the renderer actually fed is the one read.
  const drawnTracerSampled = async (cls, key, ms, tries = 6) => {
    let r = null;
    for (let i = 0; i < tries; i++) {
      r = await drawnTracer(cls, key, ms);
      if (r.frames > 0) return { ...r, attempts: i + 1 };
      await drain();
    }
    return { ...r, attempts: tries };
  };
  const drawnDash = await drawnTracerSampled("shotgun", shellRow.tracer, 1400);
  await drain();
  const drawnBolt = await drawnTracerSampled("rifle", rifleRow.tracer, 1400);
  await drain();
  out.drawnTracers = { gridPx, dash: drawnDash, bolt: drawnBolt };
  ok("drawn: the shell pellet is rendered at the mapped dash length, in real pixels",
    drawnDash.frames > 0 && drawnDash.visible
    && Math.abs(drawnDash.w - shellRow.dashSquares * gridPx) <= 2,
    `${drawnDash.w}x${drawnDash.h}px on a ${gridPx}px grid, expected ${shellRow.dashSquares * gridPx}px wide`);
  ok("drawn: the rifle bolt is rendered spanning the shot, many times the pellet's length (control)",
    drawnBolt.frames > 0 && drawnBolt.w >= drawnDash.w * 4,
    `bolt ${drawnBolt.w}x${drawnBolt.h}px vs pellet ${drawnDash.w}x${drawnDash.h}px`);
  // Travelled vs painted, read as DISTANCE FROM THE MUZZLE rather than as movement between frames:
  // this client renders at a few frames per second, so a 150ms dash may only be sampled once and a
  // frame-to-frame comparison would be a coin toss. A painted streak is anchored AT the shooter (it
  // is drawn from there), while a travelled dash is only ever found somewhere along the shot line —
  // which is observable in a single frame and is the same difference.
  // ⚠ THE SHELL NOW DRAWS A PAINTED COLUMN TOO (FR#22), and it is the same bullet family the sampler
  // watches — anchored at the shooter like any painted streak, so it lands in the dash sampler's own
  // offsets as a reading of 0. The claim is about the PELLETS, so the bound is taken over the
  // travelling marks: the FURTHEST offset is a pellet by construction (a painted streak cannot move),
  // and the painted bolt is still read from the rifle's own shot.
  ok("drawn: a pellet is found out along the shot line while a painted bolt sits at the muzzle",
    Math.max(...drawnDash.offsets) > shellRow.dashSquares * gridPx && drawnBolt.minOffset <= 2,
    `furthest pellet ${Math.max(...drawnDash.offsets)}px from muzzle (offsets ${drawnDash.offsets.join(",")}) / bolt ${drawnBolt.minOffset}px`);
  ok("drawn: the pellet carries a movement, the bolt does not (negative)",
    drawnDash.moves === true && drawnBolt.moves === false,
    `pellet moves ${drawnDash.moves} / bolt moves ${drawnBolt.moves}`);

  // The other two database outcomes — nothing resolves, and only one of the pair resolves — cannot be
  // produced by an install that carries both keys, so they are driven on a controlled surface standing
  // in front of the adapter. The install's own state is put back immediately afterwards.
  //
  // ⚠ THE DATABASE ANSWER IS MOVED THROUGH THE ADAPTER'S OWN SEAM (_setDbProbe), NOT by replacing the
  // engine's `Sequencer` global. This section used to do the latter, and it is a harness trap rather
  // than a product fault: a queued section reads `Sequencer.SectionManager` as it starts and
  // `Sequencer.EffectManager` as it plays, both out of that global, so any effect this run had already
  // put in flight threw from inside the engine the moment the global was swapped — a console error
  // against a gate that requires none. Isolated on this rig: real sequence + swap throws every time,
  // real sequence without the swap is clean, and so is the whole shipped fan-out. The RECORDING
  // surface below still replaces `Sequence` itself, which takes nothing away from an effect already
  // running (it holds its own class reference) and is what makes the builder calls readable.
  const realSequence = globalThis.Sequence;
  const played = [];
  const playedEntries = [];
  class FakeSequence {
    constructor() { this.entries = []; }
    effect() {
      // Records every builder call the adapter makes, so BOTH tracer shapes are readable by value: a
      // painted streak sets `stretchTo`, a travelled dash sets `size` + `moveTowards` + `duration`.
      // `to` is the shot's endpoint under either shape, so the endpoint legs read one field.
      const e = { file: (f) => { this.entries.push({ file: f }); e._i = this.entries.length - 1; return e; },
                  atLocation: (l) => { this.entries[e._i].atLocation = l; return e; }, scale: () => e,
                  endTimePerc: (v) => { this.entries[e._i].endTimePerc = v; return e; },
                  timeRange: (a2, b2) => { this.entries[e._i].timeRange = [a2, b2]; return e; },
                  filter: (n, o) => { this.entries[e._i].filter = { name: n, opts: o }; return e; },
                  opacity: (v) => { this.entries[e._i].opacity = v; return e; },
                  fadeOut: (v) => { this.entries[e._i].fadeOut = v; return e; },
                  playbackRate: (v) => { this.entries[e._i].playbackRate = v; return e; },
                  rotateTowards: (p) => { this.entries[e._i].rotateTowards = p; return e; },
                  size: (s, o) => { this.entries[e._i].size = s; this.entries[e._i].sizeOpts = o; return e; },
                  elevation: (v, o) => { this.entries[e._i].elevation = v; this.entries[e._i].elevationOpts = o; return e; },
                  aboveLighting: (v) => { this.entries[e._i].aboveLighting = v; return e; },
                  delay: (v) => { this.entries[e._i].delay = v; return e; },
                  moveTowards: (p, o) => { this.entries[e._i].moveTowards = p; this.entries[e._i].moveOpts = o; this.entries[e._i].to = p; return e; },
                  moveSpeed: (v) => { this.entries[e._i].moveSpeed = v; return e; },
                  mirrorY: (v) => { this.entries[e._i].mirrorY = v; return e; },
                  name: (v) => { this.entries[e._i].name = v; return e; },
                  duration: (d) => { this.entries[e._i].duration = d; return e; },
                  stretchTo: (p) => { this.entries[e._i].stretchTo = p; this.entries[e._i].to = p; return e; } };
      return e;
    }
    async play() { played.push(this.entries.map(x => x.file)); playedEntries.push(this.entries); }
  }
  globalThis.Sequence = FakeSequence;
  ok("controlled surface: detection still reads the module as active", fx.sequencerActive() === true);
  fx._setDbProbe(() => false);
  const noEntries = await fx.fxShot(tokenDoc, tokenDoc, { weaponClass: "pistol" });
  await sleep(200);
  ok("controlled surface: absent database entries degrade silently", noEntries.muzzle === false && noEntries.tracer === false && played.length === 0, JSON.stringify(noEntries));
  fx._setDbProbe((k) => k === fx.FX_CLASSES.pistol.muzzle);
  const someEntries = await fx.fxShot(tokenDoc, tokenDoc, { weaponClass: "pistol" });
  await sleep(200);
  ok("controlled surface: present entry queued, missing one skipped", someEntries.muzzle === true && someEntries.tracer === false, JSON.stringify(someEntries));
  ok("controlled surface: queued by database key, not a file path",
    played[0]?.[0] === fx.FX_CLASSES.pistol.muzzle && !String(played[0]?.[0]).includes("/"), JSON.stringify(played[0]));

  /* ── 9b. the directional sprite always carries an axis, named or synthesized ─ */
  // The original defect: an unrotated directional sprite points its own baked direction regardless of
  // where the discharge went — a bolt stuck on the token, pointed away from what it was aimed at. The
  // first fix SUPPRESSED the sprite when nothing was named, which produced two different-looking
  // effects for one trigger pull and was rejected on report. Both halves are now pinned: the sprite
  // is queued either way, and it always carries a rotation input — the named token's centre where
  // there is one, the facing-derived point where there is not.
  fx._setDbProbe(() => true);
  played.length = 0; playedEntries.length = 0;
  const noAim = await fx.fxShot(tokenDoc, null, { weaponClass: "pistol", light: false });
  await sleep(150);
  const noAimEntry = playedEntries.flat().find(e => e.file === fx.FX_CLASSES.pistol.muzzle);
  const synthPoint = fx.aimPointOf(tokenDoc, null, Number(canvas.dimensions.size));
  ok("aim: nothing named -> the sprite is queued anyway, with a synthesized axis",
    noAim.muzzle === true && noAim.tracer === true && !!noAimEntry?.rotateTowards,
    `${JSON.stringify(noAim)} / ${played.length} queued`);
  ok("aim: that axis is the facing-derived point, not the token's own centre (negative)",
    Math.round(Number(noAimEntry?.rotateTowards?.x)) === Math.round(synthPoint.x)
    && Math.round(Number(noAimEntry?.rotateTowards?.y)) === Math.round(synthPoint.y)
    && Math.abs(Math.hypot(synthPoint.x - fx.centerOf(tokenDoc).x, synthPoint.y - fx.centerOf(tokenDoc).y)
                - fx.FACING_AIM_SQUARES * Number(canvas.dimensions.size)) < 1,
    `${JSON.stringify(noAimEntry?.rotateTowards)} vs synthesized ${JSON.stringify(synthPoint)}`);
  played.length = 0; playedEntries.length = 0;
  const withAim = await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "pistol", light: false });
  await sleep(150);
  const muzzleEntry = playedEntries.flat().find(e => e.file === fx.FX_CLASSES.pistol.muzzle);
  const aimPoint = fx.centerOf(targetDoc);
  ok("aim: aimed-at token known -> the sprite is queued WITH a rotation input",
    withAim.muzzle === true && !!muzzleEntry?.rotateTowards, JSON.stringify(muzzleEntry ?? null));
  ok("aim: the rotation input is the aimed-at token's own centre",
    Math.round(Number(muzzleEntry?.rotateTowards?.x)) === Math.round(aimPoint.x)
    && Math.round(Number(muzzleEntry?.rotateTowards?.y)) === Math.round(aimPoint.y),
    `${JSON.stringify(muzzleEntry?.rotateTowards)} vs ${JSON.stringify(aimPoint)}`);
  /* -- 9b-ii. elevation + hit confirmation, read off the builder calls ------ */
  // Every self-luminous sprite is asked to draw above the lighting; the smoke wisp is asked NOT to.
  played.length = 0; playedEntries.length = 0;
  const elevHit = await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "rifle", hit: true, light: false });
  await sleep(150);
  const elevEntries = playedEntries.flat();
  const litFiles = [fx.FX_CLASSES.rifle.muzzle, fx.FX_CLASSES.rifle.tracer, fx.MUZZLE_SPARK.key, fx.HIT_CONFIRM.key];
  ok("route: every lit sprite this shot queued asks for the above-the-lighting route",
    elevEntries.length > 0
    && elevEntries.filter(e => litFiles.includes(e.file)).every(e => e.aboveLighting === fx.LIT_SPRITE_ABOVE_LIGHTING)
    && elevEntries.some(e => e.file === fx.FX_CLASSES.rifle.tracer && e.aboveLighting === true),
    JSON.stringify(elevEntries.map(e => `${e.file.split(".").slice(-2).join(".")}@${e.aboveLighting ? "aboveLighting" : "primary"}`)));
  ok("impact: a round that LANDS queues one confirmation at the aimed-at point",
    elevHit.impact === true
    && elevEntries.filter(e => e.file === fx.HIT_CONFIRM.key).length === 1
    && Math.round(elevEntries.find(e => e.file === fx.HIT_CONFIRM.key)?.atLocation?.x) === Math.round(fx.centerOf(targetDoc).x),
    JSON.stringify(elevEntries.find(e => e.file === fx.HIT_CONFIRM.key)?.atLocation ?? null));
  played.length = 0; playedEntries.length = 0;
  const elevMiss = await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "rifle", hit: false, light: false });
  await sleep(150);
  ok("impact: a MISS queues none — the confirmation is what tells the two apart (negative)",
    elevMiss.impact === false
    && playedEntries.flat().filter(e => e.file === fx.HIT_CONFIRM.key).length === 0,
    JSON.stringify(elevMiss));
  // A travelled-dash class holds its confirmation back by the crossing time so the impact cannot
  // precede its own pellets; a painted tracer is drawn across the line at once and waits for nothing.
  played.length = 0; playedEntries.length = 0;
  await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "shotgun", hit: true, light: false });
  await sleep(150);
  const shellImpact = playedEntries.flat().find(e => e.file === fx.HIT_CONFIRM.key);
  ok("impact: a travelled-tracer class delays its confirmation by that tracer's own crossing time",
    shellImpact?.delay === fx.FX_CLASSES.shotgun.dashMs
    && elevEntries.find(e => e.file === fx.HIT_CONFIRM.key)?.delay === undefined,
    `shell ${shellImpact?.delay}ms vs painted ${elevEntries.find(e => e.file === fx.HIT_CONFIRM.key)?.delay}`);
  played.length = 0; playedEntries.length = 0;

  ok("aim: no sprite the adapter queued is left without a rotation input",
    playedEntries.flat().filter(e => e.file === fx.FX_CLASSES.pistol.muzzle).every(e => !!e.rotateTowards),
    `${playedEntries.flat().length} entries queued`);

  /* ── 9c. the shell class draws a FAN of tracers, not one bolt ──────────── */
  // The shape of the round, asserted by the values handed to the engine. The rendered result is the
  // eyes-on record; what is pinned here is that the right number of tracers is queued, that each one
  // is given its own endpoint, and that the endpoints differ — a fan drawn as one line N times would
  // satisfy a count-only assertion and look exactly like the single bolt this replaced.
  played.length = 0; playedEntries.length = 0;
  const shellFx = await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "shotgun", hit: true, light: false });
  await sleep(150);
  const shellTracers = playedEntries.flat().filter(e => e.file === shellRow.tracer);
  ok("fan: the shell round queues one tracer per pellet",
    shellFx.pellets === shellRow.pellets && shellTracers.length === shellRow.pellets,
    `${shellTracers.length} queued / ${shellFx.pellets} reported / ${shellRow.pellets} mapped`);
  ok("fan: every queued tracer carries its own aim endpoint",
    shellTracers.length > 0 && shellTracers.every(e => Number.isFinite(e.to?.x) && Number.isFinite(e.to?.y)),
    JSON.stringify(shellTracers.map(e => e.to)));
  ok("fan: the endpoints are distinct — a fan, not one line drawn N times",
    new Set(shellTracers.map(e => `${Math.round(e.to.x)},${Math.round(e.to.y)}`)).size === shellTracers.length,
    shellTracers.map(e => `${Math.round(e.to.x)},${Math.round(e.to.y)}`).join(" "));
  // ⏪⏪ INVERTED BACK (2026-08-09): the shell queues a lance again, aimed like every other class's,
  // and there is no longer a column to aim. Read off what was HANDED TO THE ENGINE.
  const shellLance = playedEntries.flat().find(e => e.file === shellRow.muzzle);
  ok("fan: the shell queues its lance, aimed down the shot, alongside the pellet fan",
    !!shellLance && Number.isFinite(shellLance.rotateTowards?.x),
    `lance ${shellLance ? "present" : "none"}, aimed at ${JSON.stringify(shellLance?.rotateTowards ?? null)}`);
  ok("fan: the lance is queued with the trim as a time range and the dwell as a playback rate",
    Array.isArray(shellLance?.timeRange) && shellLance.timeRange[0] === 0
    && shellLance.timeRange[1] === fx.MUZZLE_SPRITE.endMs
    && shellLance?.playbackRate === fx.muzzleRateFor("shotgun"),
    `range ${JSON.stringify(shellLance?.timeRange ?? null)}, rate ${shellLance?.playbackRate}`);
  ok("fan: no second bullet family is queued — the discharge column is gone (negative)",
    playedEntries.flat().every(e => !/bullet\.02/.test(String(e.file))),
    playedEntries.flat().map(e => String(e.file).split(".").slice(-2).join(".")).join(" "));
  ok("fan: the pellets take no rate of their own — the dwell is the lance's alone (negative)",
    shellTracers.length > 0 && shellTracers.every(e => e.playbackRate === undefined),
    `${shellTracers.filter(e => e.playbackRate !== undefined).length} of ${shellTracers.length} pellets carry a rate`);
  // ⭐ THE AMMO RECOLOUR REACHES THE FAN (2026-08-09 ruling). Asserted on the QUEUED sprites, because
  // the merge being right and the draw path applying it are two different facts — the previous shape of
  // this rule was correct in the table and invisible on the pellets, which is what was reported. It
  // OUTLIVED the column it was reported against, which is what these two legs now say.
  played.length = 0; playedEntries.length = 0;
  await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "shotgun", hit: true, light: false, ammoKey: "api" });
  await sleep(150);
  const apiPellets = playedEntries.flat().filter(e => e.file === shellRow.tracer);
  ok("fan recolour: an incendiary shell queues the shift on every pellet of its fan",
    apiPellets.length === shellRow.pellets
    && apiPellets.every(e => e.filter?.name === "ColorMatrix" && e.filter?.opts?.hue === fx.TRACER_COLOR_INCENDIARY.hue),
    `${apiPellets.filter(e => e.filter).length}/${apiPellets.length} pellets tinted`);
  ok("fan recolour: and an ordinary shell still queues its pellets with no filter at all (negative)",
    shellTracers.every(e => e.filter === undefined),
    `base pellets tinted ${shellTracers.filter(e => e.filter).length}`);
  // ⭐ THE DART LANGUAGE, on the queued sprites: grey means darts, orange means shot. Asserted as the
  // MATRIX each load hands the engine, because "it looks different" is not a checkable claim and the
  // matrix is.
  played.length = 0; playedEntries.length = 0;
  await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "shotgun", hit: true, light: false, ammoKey: "flechette" });
  await sleep(150);
  const flechDarts = playedEntries.flat().filter(e => e.file === shellRow.tracer);
  played.length = 0; playedEntries.length = 0;
  await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "shotgun", hit: true, light: false, ammoKey: "stundart" });
  await sleep(150);
  const stunDarts = playedEntries.flat().filter(e => e.file === shellRow.tracer);
  // ⏪ RE-PINNED 2026-08-10 (the single-file ruling, §21) and again 2026-08-11 (the same ruling extended
  // to the stun dart). This leg asserted EIGHT marks for both loads, then eight for one of them. Neither
  // row names a count now, so on the SHELL both draw the shell's own six — which is the class deciding
  // the shape, and is exactly what "if it's fired from a shotgun, no" preserves. The matrix claim, which
  // is what this leg is about, is unchanged and is asserted on every mark each load actually draws.
  ok("dart language: both dart loads queue the SAME grey matrix on every mark they draw",
    flechDarts.length === fx.FX_CLASSES.shotgun.pellets && stunDarts.length === fx.FX_CLASSES.shotgun.pellets
    && flechDarts.every(e => e.filter?.opts?.saturate === fx.TRACER_COLOR_DART.saturate)
    && stunDarts.every(e => e.filter?.opts?.saturate === fx.TRACER_COLOR_DART.saturate),
    `flechette ${flechDarts.length} @ sat ${flechDarts[0]?.filter?.opts?.saturate}, stun-dart ${stunDarts.length}`);
  ok("dart language: the grey is a desaturation and NOT a darkening — the rejected reflex stays rejected",
    fx.TRACER_COLOR_DART.saturate <= -0.85 && fx.TRACER_COLOR_DART.brightness > 1
    && fx.TRACER_COLOR_DART.hue === 0,
    JSON.stringify(fx.TRACER_COLOR_DART));
  ok("dart language: buckshot is left orange — the distinction is a difference, not a repaint of both",
    shellTracers.every(e => e.filter === undefined) && fx.FX_CLASSES.shotgun.tracerColor === null,
    "buckshot fan carries no matrix");
  // ⭐ THE VOLLEY AS QUEUED (2026-08-09, ON TRIAL). What is handed to the engine, by value: ONE effect
  // carrying the volley key, stretched to an endpoint, mirrored by this round's own chaos — and NOT a
  // single pellet or hit mark beside it. A merge-only assertion could not see the substitution.
  played.length = 0; playedEntries.length = 0;
  const volSeed = 4242;
  await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "shotgun", hit: true, light: false,
    ammoKey: "standard", volley: fx.volleySpecFor(5), shotSeed: volSeed });
  await sleep(150);
  const volQueued = playedEntries.flat();
  const volEff = volQueued.find(e => e.file === fx.VOLLEY.key);
  ok("volley queued: exactly one volley sprite is handed to the engine, stretched down the shot",
    volQueued.filter(e => e.file === fx.VOLLEY.key).length === 1 && Number.isFinite(volEff?.stretchTo?.x),
    `${volQueued.filter(e => e.file === fx.VOLLEY.key).length} volley, stretched to ${JSON.stringify(volEff?.stretchTo ?? null)}`);
  ok("volley queued: no pellet and no hit mark are queued with it — it replaces both (negative)",
    volQueued.every(e => e.file !== fx.FX_CLASSES.shotgun.tracer)
    && volQueued.every(e => e.file !== fx.HIT_CONFIRM.key),
    volQueued.map(e => String(e.file).split(".").slice(-2).join(".")).join(" "));
  ok("volley queued: the mirror knob really reaches the engine, at this round's own seeded value",
    volEff?.mirrorY === fx.volleyChaosFor(volSeed).mirrorY,
    `queued ${volEff?.mirrorY} vs seeded ${fx.volleyChaosFor(volSeed).mirrorY}`);
  // ⭐ THE SETTLE NAME lands on the volley, because it is the only element of the round that lasts —
  // the fan and the impact it replaced were the two named ones. Driven with a real tag.
  played.length = 0; playedEntries.length = 0;
  const volTagged = await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "shotgun", hit: true, light: false,
    ammoKey: "standard", volley: fx.volleySpecFor(5), shotSeed: volSeed, settleTag: "__pw__volley__tag" });
  await sleep(150);
  const volNamed = playedEntries.flat().find(e => e.file === fx.VOLLEY.key);
  ok("volley queued: the settle name lands on the volley, and on nothing else of the round",
    volNamed?.name === "__pw__volley__tag" && volTagged.tagged === 1
    && playedEntries.flat().filter(e => e.name === "__pw__volley__tag").length === 1,
    `${volTagged.tagged} tagged element(s), name ${volNamed?.name}`);
  ok("volley queued: the shell still queues its lance — the volley replaces the ROUND, not the discharge",
    volQueued.some(e => e.file === fx.FX_CLASSES.shotgun.muzzle),
    "lance present alongside the volley");
  played.length = 0; playedEntries.length = 0;

  /* ── 9c-ii. the pellet is a SHORT TRAVELLED sprite, not a painted streak ── */
  // The reported defect: the pellets "read as standard bullets" — they were the same asset the rifle
  // uses, stretched across the whole shot line, so a shell round and a rifle round were the same mark
  // at the same length. These legs pin the mechanism that replaced it, by the values handed to the
  // engine: a fixed size in GRID UNITS (so the length is a spec, not whatever the ranged asset handed
  // back for that distance), a movement to the endpoint, a crossing time, and NO stretch at all.
  const aimDistPx = Math.hypot(fx.centerOf(targetDoc).x - fx.centerOf(tokenDoc).x, fx.centerOf(targetDoc).y - fx.centerOf(tokenDoc).y);
  ok("dash: every shell pellet is sized in grid units to the mapped dash length",
    shellTracers.length === shellRow.pellets
    && shellTracers.every(e => e.size?.width === shellRow.dashSquares && e.sizeOpts?.gridUnits === true),
    JSON.stringify(shellTracers.map(e => [e.size, e.sizeOpts])[0] ?? null));
  ok("dash: the height is left on the asset's own aspect, not forced",
    shellTracers.every(e => e.size?.height === undefined), JSON.stringify(shellTracers[0]?.size ?? null));
  // THE CROSSING TIME AND THE LIFETIME ARE NOW TWO DIFFERENT NUMBERS, and that split is the fix for
  // "the shells hit but visibly fall short": with no speed set the engine drives a moved effect for its
  // whole lifetime, so the pellet was scheduled to arrive at the instant it was destroyed. The travel
  // is carried by a SPEED, and the sprite outlives it by the arrival hold so the arrival can be seen.
  ok("dash: every shell pellet is told to TRAVEL to its endpoint, its crossing carried by a speed",
    shellTracers.every(e => Number.isFinite(e.moveTowards?.x) && Number.isFinite(e.moveSpeed) && e.moveSpeed > 0),
    `speeds ${[...new Set(shellTracers.map(e => Math.round(e.moveSpeed)))].join(",")}px/s`);
  ok("dash: that speed crosses the AIM distance in exactly the class's mapped crossing time",
    shellTracers.every(e => Math.abs((aimDistPx / e.moveSpeed) * 1000 - shellRow.dashMs) < 1),
    `${Math.round(aimDistPx)}px at ${Math.round(shellTracers[0]?.moveSpeed ?? 0)}px/s = ${((aimDistPx / (shellTracers[0]?.moveSpeed || 1)) * 1000).toFixed(1)}ms vs ${shellRow.dashMs}ms`);
  ok("dash: the pellet OUTLIVES its own crossing by the arrival hold, so the arrival is visible",
    shellTracers.every(e => e.duration === shellRow.dashMs + fx.DASH_ARRIVAL_HOLD_MS && e.fadeOut === fx.DASH_ARRIVAL_HOLD_MS),
    `durations ${[...new Set(shellTracers.map(e => e.duration))].join(",")}ms = ${shellRow.dashMs} + ${fx.DASH_ARRIVAL_HOLD_MS}`);
  // The capture seam exists so the fan can be photographed on a client too slow to render it at the
  // shipped speed. It must be OFF unless a capture run turned it on, or every table would silently be
  // running a different crossing time from the one the table maps.
  played.length = 0; playedEntries.length = 0;
  ok("dash: the capture seam is off by default and reports so", fx._setDashMs(null) === null);
  fx._setDashMs(900);
  await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "shotgun", hit: true, light: false });
  await sleep(150);
  const heldTracers = playedEntries.flat().filter(e => e.file === shellRow.tracer);
  ok("dash: the capture seam replaces the crossing time and nothing else",
    heldTracers.length === shellRow.pellets
    && heldTracers.every(e => e.duration === 900 + fx.DASH_ARRIVAL_HOLD_MS
      && Math.abs((aimDistPx / e.moveSpeed) * 1000 - 900) < 1
      && e.size?.width === shellRow.dashSquares && e.stretchTo === undefined),
    `${heldTracers.length} pellets crossing in ${((aimDistPx / (heldTracers[0]?.moveSpeed || 1)) * 1000).toFixed(0)}ms, alive ${[...new Set(heldTracers.map(e => e.duration))].join(",")}ms`);
  fx._setDashMs(null);
  played.length = 0; playedEntries.length = 0;
  await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "shotgun", hit: true, light: false });
  await sleep(150);
  ok("dash: clearing the seam restores the mapped crossing time (negative)",
    playedEntries.flat().filter(e => e.file === shellRow.tracer)
      .every(e => Math.abs((aimDistPx / e.moveSpeed) * 1000 - shellRow.dashMs) < 1),
    `${[...new Set(playedEntries.flat().filter(e => e.file === shellRow.tracer).map(e => Math.round((aimDistPx / e.moveSpeed) * 1000)))].join(",")}ms`);
  ok("dash: no shell pellet is stretched across the shot line (negative — the defect itself)",
    shellTracers.every(e => e.stretchTo === undefined), JSON.stringify(shellTracers.map(e => e.stretchTo)));
  ok("dash: heading is set once — the movement is told not to rotate the sprite again",
    shellTracers.every(e => !!e.rotateTowards && e.moveOpts?.rotate === false && e.moveOpts?.ease === "linear"),
    JSON.stringify(shellTracers[0]?.moveOpts ?? null));

  // The single-bolt control: a class carrying no pellet count is untouched by any of this.
  played.length = 0; playedEntries.length = 0;
  const boltFx = await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "rifle", hit: true, light: false });
  await sleep(150);
  const boltTracers = playedEntries.flat().filter(e => e.file === rifleRow.tracer);
  ok("fan: a class with no pellet count still queues exactly one tracer (control)",
    boltFx.tracer === true && boltFx.pellets === 1 && boltTracers.length === 1,
    `${boltTracers.length} queued / ${boltFx.pellets} reported`);
  ok("dash: the rifle control is still PAINTED across the line — stretched, unsized, untimed (control)",
    boltTracers.every(e => Number.isFinite(e.stretchTo?.x) && e.size === undefined
      && e.moveTowards === undefined && e.duration === undefined),
    JSON.stringify(boltTracers[0] ?? null));

  // A MISSED shell splays: same pellet count, but each pellet takes the wide miss divergence and its
  // own reach, so the group lands at mixed depths instead of converging at the aim distance.
  played.length = 0; playedEntries.length = 0;
  const shellMiss = await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "shotgun", hit: false, light: false });
  await sleep(150);
  const missTracers = playedEntries.flat().filter(e => e.file === shellRow.tracer);
  const shooterAt = fx.centerOf(tokenDoc), aimAt = fx.centerOf(targetDoc);
  const aimDist = Math.hypot(aimAt.x - shooterAt.x, aimAt.y - shooterAt.y);
  const missReaches = missTracers.map(e => Math.hypot(e.to.x - shooterAt.x, e.to.y - shooterAt.y) / aimDist);
  ok("fan: a missed shell keeps the pellet count", shellMiss.pellets === shellRow.pellets, String(shellMiss.pellets));
  ok("fan: missed pellets land at mixed depths inside the miss reach band, not at the aim distance",
    missReaches.length === shellRow.pellets
    && missReaches.every(r => r >= fx.MISS_REACH_MIN - 0.001 && r <= fx.MISS_REACH_MAX + 0.001)
    && new Set(missReaches.map(r => r.toFixed(3))).size > 1,
    missReaches.map(r => r.toFixed(2)).join(","));

  /* -- 9d. the muzzle sprite: small, aimed, planted at the token's EDGE ---- */
  // The reported defect: "the plume of smoke and fire is too large". Two separate causes, so two
  // separate mechanisms, both pinned by the values handed to the engine.
  //   SIZE - the asset is a 600x300 clip declaring a 100px design grid, so untouched it draws six
  //   squares wide and the previous build's `scale: 0.7` drew 4.2. It is now sized in GRID UNITS, the
  //   same idiom the pellet dash uses, so the drawn width is a spec rather than a by-product.
  //   PLUME - the clip runs 0.833s and only its opening is the flash; the rest is the two clouds. It
  //   is trimmed, so the clouds are never reached at all.
  //   PLACEMENT - planted at the shooter's forward edge rather than on its centre.
  const spriteShots = {};
  for (const cls of Object.keys(fx.FX_CLASSES)) {
    played.length = 0; playedEntries.length = 0;
    await fx.fxShot(tokenDoc, targetDoc, { weaponClass: cls, hit: true, light: false });
    await sleep(120);
    spriteShots[cls] = playedEntries.flat();
  }
  const muzzleOf = (cls) => (fx.FX_CLASSES[cls].muzzle
    ? spriteShots[cls].find(e => e.file === fx.FX_CLASSES[cls].muzzle) : null);
  // ⏪⏪ THE LANCE ROWS — all five again (2026-08-09). The list is asserted by name rather than derived
  // and trusted, so a row losing its lance by accident can never pass these as "nothing to check".
  const lanceClasses = Object.keys(fx.FX_CLASSES).filter(c => !!fx.FX_CLASSES[c].muzzle);
  ok("sprite: every class draws a lance — the shell is no longer the exception",
    lanceClasses.join(",") === ["pistol", "smg", "rifle", "shotgun", "heavy"].join(","), lanceClasses.join(","));
  ok("sprite: every class that draws one sizes its flash in grid units to its OWN mapped width",
    lanceClasses.every(c => muzzleOf(c)?.size?.width === fx.FX_CLASSES[c].muzzleSquares
      && muzzleOf(c)?.sizeOpts?.gridUnits === true),
    lanceClasses.map(c => `${c}=${muzzleOf(c)?.size?.width}`).join(" "));
  ok("sprite: the height is left on the asset's own aspect, not forced",
    lanceClasses.every(c => muzzleOf(c)?.size?.height === undefined),
    JSON.stringify(muzzleOf("rifle")?.size ?? null));
  ok("sprite: no class row carries the old scale factor any more (negative - the defect's mechanism)",
    Object.values(fx.FX_CLASSES).every(e => e.scale === undefined),
    Object.entries(fx.FX_CLASSES).map(([c, e]) => `${c}=${e.scale}`).join(" "));
  // The drawn width is now a small multiple of a square rather than a screenful. Stated as the bound
  // the report asked for: no class draws its flash anywhere near the previous build's 4.2 squares.
  ok("sprite: every class that draws one keeps it inside a few squares, well under the previous 4.2",
    lanceClasses.every(c => fx.FX_CLASSES[c].muzzleSquares > 0 && fx.FX_CLASSES[c].muzzleSquares <= 2.5),
    lanceClasses.map(c => `${c}=${fx.FX_CLASSES[c].muzzleSquares}sq`).join(" "));
  ok("sprite: the flash clip is trimmed before its smoke-and-fire phase",
    lanceClasses.every(c => muzzleOf(c)?.timeRange?.[0] === 0
      && muzzleOf(c)?.timeRange?.[1] === fx.MUZZLE_SPRITE.endMs)
    && fx.MUZZLE_SPRITE.endMs > 0 && fx.MUZZLE_SPRITE.endMs < 833,
    `timeRange 0-${fx.MUZZLE_SPRITE.endMs}ms of a 833ms clip`);
  // The trim is applied as a TIME RANGE and not as the percentage form, which measured as no cut at
  // all on this build (the note in MUZZLE_SPRITE carries the numbers). Pinned so a tidy-up cannot
  // quietly swap one for the other and put the plume back.
  ok("sprite: the trim is a time range, not the percentage form that measured as no cut (negative)",
    Object.keys(fx.FX_CLASSES).every(c => muzzleOf(c)?.endTimePerc === undefined),
    String(Object.keys(fx.FX_CLASSES).filter(c => muzzleOf(c)?.endTimePerc !== undefined).length));
  // The trim leaves the sprite and the native light going out together instead of the sprite billowing
  // on for most of a second after the light is gone.
  ok("sprite: the trimmed flash is about as long as the native light's own envelope",
    Math.abs(fx.MUZZLE_SPRITE.endMs - fx.muzzleEnvelopeDurationMs()) < 60,
    `${fx.MUZZLE_SPRITE.endMs}ms sprite vs ${fx.muzzleEnvelopeDurationMs()}ms light`);
  // PLACEMENT, by value: the location is a point (not the token), it sits on the shooter -> target
  // line, and it is exactly the shooter's own half-width out - the token's edge, whatever its size.
  const gridNow = Number(canvas.dimensions?.size) || 100;
  const shooterC = fx.centerOf(tokenDoc), targetC = fx.centerOf(targetDoc);
  const placed = muzzleOf("rifle")?.atLocation;
  const expectOff = fx.tokenRadiusPx(tokenDoc, gridNow) * 2 * fx.MUZZLE_SPRITE.edgeFraction;
  const placedOff = placed ? Math.hypot(placed.x - shooterC.x, placed.y - shooterC.y) : null;
  ok("sprite: the flash is planted at the shooter's forward EDGE, not on its centre",
    Number.isFinite(placed?.x) && Math.abs(placedOff - expectOff) < 1 && placedOff > 0,
    `${Math.round(placedOff)}px from centre, expected ${Math.round(expectOff)}px on a ${gridNow}px grid`);
  ok("sprite: that point lies on the shooter-to-target line",
    Math.abs((placed.x - shooterC.x) * (targetC.y - shooterC.y) - (placed.y - shooterC.y) * (targetC.x - shooterC.x)) < 1,
    `${Math.round(placed.x)},${Math.round(placed.y)} between ${Math.round(shooterC.x)},${Math.round(shooterC.y)} and ${Math.round(targetC.x)},${Math.round(targetC.y)}`);
  ok("sprite: it still carries the aim as its rotation input", !!muzzleOf("rifle")?.rotateTowards);

  // The SPIKY companion — RULED OFF EVERY CLASS (user, 2026-08-08, after the matched A/B in eyes-on
  // 45/46 and 45b/46b): the radial star reads as sparkle rather than as a gun, its rays fire backward
  // across the shooter, and its fixed size dominates a small muzzle. The aimed lance is the muzzle
  // treatment everywhere now. These legs pin BOTH halves of that: nothing draws it as shipped, and the
  // per-class opt-in that was deliberately left in place still works when a row asks for it.
  const sparkOf = (cls) => spriteShots[cls].filter(e => e.file === fx.MUZZLE_SPARK.key);
  ok("spark: NO shipped class asks for it — the ruling, read off the table (negative)",
    Object.keys(fx.FX_CLASSES).every(c => !fx.FX_CLASSES[c].spark),
    Object.keys(fx.FX_CLASSES).map(c => `${c}:${fx.FX_CLASSES[c].spark ? "on" : "off"}`).join(" "));
  ok("spark: and none of them queues one — the lance is the whole muzzle treatment (negative)",
    Object.keys(fx.FX_CLASSES).every(c => sparkOf(c).length === 0),
    Object.keys(fx.FX_CLASSES).map(c => `${c}:${sparkOf(c).length}`).join(" "));
  ok("spark: every class still queues its LANCE, so the muzzle is not left bare (control)",
    Object.keys(fx.FX_CLASSES).every(c => !fx.FX_CLASSES[c].muzzle
      || spriteShots[c].some(e => e.file === fx.FX_CLASSES[c].muzzle)),
    Object.keys(fx.FX_CLASSES).map(c => `${c}:${fx.FX_CLASSES[c].muzzle ? spriteShots[c].filter(e => e.file === fx.FX_CLASSES[c].muzzle).length : "no lance"}`).join(" "));
  // THE OPT-IN ITSELF, still alive: the field is the gate, so a row given it back draws the star again
  // with no other change. Driven by handing the row the field on this client only and putting it back —
  // the same in-memory override the A/B captures used (FX_CLASSES is frozen at the top level only).
  const sparkWas = fx.FX_CLASSES.rifle.spark;
  fx.FX_CLASSES.rifle.spark = true;
  played.length = 0; playedEntries.length = 0;
  await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "rifle", hit: true, light: false });
  await sleep(200);
  const optedIn = playedEntries.flat().filter(e => e.file === fx.MUZZLE_SPARK.key);
  ok("spark: a row given the field back queues exactly one, sized in grid units to the spec",
    optedIn.length === 1 && optedIn[0].size?.width === fx.MUZZLE_SPARK.squares
    && optedIn[0].sizeOpts?.gridUnits === true,
    `${optedIn.length} queued, ${JSON.stringify(optedIn[0]?.size ?? null)}`);
  ok("spark: that one is planted on the SAME muzzle point as the lance",
    Math.round(optedIn[0]?.atLocation?.x) === Math.round(placed.x)
    && Math.round(optedIn[0]?.atLocation?.y) === Math.round(placed.y),
    JSON.stringify(optedIn[0]?.atLocation ?? null));
  ok("spark: and it is NOT trimmed — its rays only form in the back half of its clip",
    optedIn[0]?.timeRange === undefined && optedIn[0]?.endTimePerc === undefined,
    String(optedIn[0]?.timeRange));
  ok("spark: the spec keeps it smaller than the lance it would sit inside",
    fx.MUZZLE_SPARK.squares < fx.FX_CLASSES.rifle.muzzleSquares,
    `${fx.MUZZLE_SPARK.squares}sq spark vs ${fx.FX_CLASSES.rifle.muzzleSquares}sq lance`);
  // The tail reads the row, but the star can no longer BE the longest element: since the tail became
  // "the action has finished" it runs to the impact/tracer end, which outlasts the star's whole clip.
  // So opting the star back in must not move the tail at all — which is the leg, because a tail that
  // grew here would be one holding the apply window open for something already over.
  const tailOptedIn = fx.presentationTailMs("rifle");
  fx.FX_CLASSES.rifle.spark = sparkWas;
  ok("spark: opting it back in does not move the tail — it ends inside the impact anyway",
    tailOptedIn === fx.presentationTailMs("rifle") && fx.MUZZLE_SPARK.clipMs < tailOptedIn,
    `${tailOptedIn}ms either way, star clip ${fx.MUZZLE_SPARK.clipMs}ms`);
  ok("spark: the override is put back — the table is as shipped again (negative)",
    !fx.FX_CLASSES.rifle.spark, String(fx.FX_CLASSES.rifle.spark));

  /* -- 9d-ii. the tracer colour shift (and the lever that does NOT work) --- */
  // Asked for: the tail reading yellow near the head and fading to white, against the asset's orange.
  // A TINT cannot do it - it multiplies the asset's own colours, so a pale-yellow tint came back MORE
  // saturated orange than the untinted control when the two were photographed side by side. A hue
  // rotation with the saturation pulled down is the operation that moves orange toward yellow and then
  // toward white, so that is what the classes carry.
  const tracerOf = (cls) => spriteShots[cls].filter(e => e.file === fx.FX_CLASSES[cls].tracer);
  const tinted = ["pistol", "smg", "rifle", "heavy"];
  ok("tint: the comet classes carry the colour shift on every tracer they queue",
    tinted.every(c => tracerOf(c).length > 0 && tracerOf(c).every(e => e.filter?.name === "ColorMatrix")),
    tinted.map(c => `${c}:${tracerOf(c)[0]?.filter?.name}`).join(" "));
  ok("tint: the shift is the measured hue rotation and desaturation, by value",
    tinted.every(c => tracerOf(c).every(e => e.filter?.opts?.hue === 18
      && e.filter?.opts?.saturate === -0.35 && e.filter?.opts?.brightness === 1.15)),
    JSON.stringify(tracerOf("rifle")[0]?.filter?.opts ?? null));
  ok("tint: it is a colour MATRIX and not a tint - no queued sprite is tinted (negative)",
    Object.values(spriteShots).flat().every(e => e.tint === undefined),
    String(Object.values(spriteShots).flat().filter(e => e.tint !== undefined).length));
  // ⏪ The row now DECLARES the fan repaintable (`tracerColor: null`) instead of omitting the field, so
  // an ammo overlay can reach it — see the recolour-mask legs. What is asserted here is the half that
  // did not change: with no overlay, the shell's queued pellets carry no ColorMatrix at all.
  ok("tint: the shell class's pellets are left alone by the CLASS (negative - the settled look)",
    fx.FX_CLASSES.shotgun.tracerColor === null
    && tracerOf("shotgun").length === fx.FX_CLASSES.shotgun.pellets
    && tracerOf("shotgun").every(e => e.filter === undefined),
    `${tracerOf("shotgun").length} pellets, filters ${tracerOf("shotgun").filter(e => e.filter).length}`);

  /* -- 9e. the burst ambience: the mote spray and the smoke wisp ----------- */
  // Drawn ONCE for a whole burst, not once per round: the reference shows about a dozen specks and a
  // single wisp for a ten-round burst. The values queued are what is pinned here; the rendered result
  // is the eyes-on record.
  played.length = 0; playedEntries.length = 0;
  const amb = await fx.fxBurstAmbience(tokenDoc, targetDoc, { weaponClass: "rifle", shots: 10, cadenceMs: 80 });
  await sleep(150);
  const ambEntries = playedEntries.flat();
  const moteEntries = ambEntries.filter(e => e.file === fx.MUZZLE_MOTES.key);
  const smokeEntries = ambEntries.filter(e => e.file === fx.MUZZLE_SMOKE.key);
  ok("ambience: one sequence for the whole burst", played.length === 1, `${played.length} sequences`);
  ok("ambience: one speck per the class's OWN mapped count",
    amb.motes === fx.FX_CLASSES.rifle.motes && moteEntries.length === fx.FX_CLASSES.rifle.motes,
    `${moteEntries.length} queued / ${fx.FX_CLASSES.rifle.motes} mapped`);
  ok("ambience: each speck is sized in grid units to the spec, and is tiny",
    moteEntries.every(e => e.size?.width === fx.MUZZLE_MOTES.sizeSquares && e.sizeOpts?.gridUnits === true)
    && fx.MUZZLE_MOTES.sizeSquares < 0.25,
    `${fx.MUZZLE_MOTES.sizeSquares} squares`);
  ok("ambience: each speck travels to its OWN endpoint - a scatter, not one point drawn N times",
    moteEntries.every(e => Number.isFinite(e.moveTowards?.x))
    && new Set(moteEntries.map(e => `${Math.round(e.moveTowards.x)},${Math.round(e.moveTowards.y)}`)).size === moteEntries.length,
    moteEntries.map(e => `${Math.round(e.moveTowards.x)},${Math.round(e.moveTowards.y)}`).join(" "));
  const moteDurs = moteEntries.map(e => e.duration);
  ok("ambience: each speck crosses in its own time, inside the mapped band",
    moteDurs.every(d => d >= fx.MUZZLE_MOTES.travelMinMs && d <= fx.MUZZLE_MOTES.travelMaxMs)
    && new Set(moteDurs.map(d => Math.round(d))).size > 1,
    moteDurs.map(d => Math.round(d)).join(","));
  // Geometry against the muzzle point: inside the cone, inside the distance band. Both are what make
  // the spray read as following the round rather than spraying sideways off the shooter.
  const ambMuzzle = fx.muzzlePoint(shooterC, targetC, expectOff);
  const aimHeading = Math.atan2(targetC.y - ambMuzzle.y, targetC.x - ambMuzzle.x);
  const moteAngles = moteEntries.map(e => Math.abs(Math.atan2(e.moveTowards.y - ambMuzzle.y, e.moveTowards.x - ambMuzzle.x) - aimHeading));
  const moteReaches = moteEntries.map(e => Math.hypot(e.moveTowards.x - ambMuzzle.x, e.moveTowards.y - ambMuzzle.y) / gridNow);
  ok("ambience: every speck lands inside the firing cone the spec names",
    moteAngles.every(a => a <= fx.MUZZLE_MOTES.spreadRad + 1e-6),
    `max ${(Math.max(...moteAngles) * 180 / Math.PI).toFixed(1)} degrees off aim, cone half-angle ${(fx.MUZZLE_MOTES.spreadRad * 180 / Math.PI).toFixed(1)}`);
  ok("ambience: every speck lands inside the mapped distance band, at mixed depths",
    moteReaches.every(r => r >= fx.MUZZLE_MOTES.nearSquares - 0.01 && r <= fx.MUZZLE_MOTES.farSquares + 0.01)
    && new Set(moteReaches.map(r => r.toFixed(2))).size > 1,
    moteReaches.map(r => r.toFixed(2)).join(","));
  // THE WISP IS GONE FROM HERE — smoke is no longer part of the per-burst ambience at all. It is now a
  // STREAM of overlapping puffs emitted across the burst (§9e-ii); the embers above are unchanged.
  ok("ambience: the burst ambience no longer carries any smoke at all (negative)",
    amb.smoke === undefined && ambEntries.every(e => e.file !== fx.MUZZLE_SMOKE.key),
    `${ambEntries.filter(e => e.file === fx.MUZZLE_SMOKE.key).length} wisp(s) in the burst ambience`);

  /* -- 9e-ii. what is LEFT of the smoke system: the shell's single puff ------ */
  // ⏪⏪ SUPERSEDED (FR#22, user ruling). The legs that stood here pinned the BURST stream — the derived
  // stride, the concurrency band, the deliberate thinning of the fast automatics, the ten-round
  // emission count. All of it is retired with the machinery it described, and the chain is on record in
  // the module's own smokePlanFor block: FR#17 built the stream because the reference showed a billow
  // rolling through automatic fire; FR#22 removed it because decoding the assets showed that billow was
  // the TRACER's own built-in smoke curls overlapping per shot, so our puffs were a second smoke over
  // the first ("spammy no matter how we do it"). Deleting the legs rather than inverting them is
  // deliberate: there is no stride, no band and no stream left to assert anything about.
  //
  // What remains asserted is the one thing the ruling KEPT — the shell's single-discharge puff — plus
  // the negatives that hold the retired stream out of every other case.
  ok("smoke: nothing derives a stride or a concurrency any more — the stream machinery is gone",
    fx.smokeStrideFor === undefined && fx.MUZZLE_SMOKE.concurrency === undefined
    && Object.keys(fx.FX_CLASSES).every(c => fx.FX_CLASSES[c].smokeStride === undefined),
    `smokeStrideFor ${typeof fx.smokeStrideFor}, concurrency ${fx.MUZZLE_SMOKE.concurrency}`);
  ok("smoke: no class carries a burst smoke size any more except the one that still puffs (negative)",
    ["pistol", "smg", "rifle", "heavy"].every(c => fx.FX_CLASSES[c].smokeSquares === undefined)
    && fx.FX_CLASSES.shotgun.smokeSquares > 0,
    `shell ${fx.FX_CLASSES.shotgun.smokeSquares}, others ${["pistol", "smg", "rifle", "heavy"].map(c => String(fx.FX_CLASSES[c].smokeSquares)).join(",")}`);
  ok("smoke: a burst of ANY class plans zero puffs — for every round count (negative)",
    Object.keys(fx.FX_CLASSES).every(c => [2, 6, 10, 30].every(n => fx.smokePlanFor(c, n).emissions === 0)),
    Object.keys(fx.FX_CLASSES).map(c => `${c}:${fx.smokePlanFor(c, 10).emissions}`).join(" "));
  // THE COST, asserted rather than left as prose: the classes mapped to the tracer WITHOUT built-in
  // smoke now have none at all in automatic fire, which is the reference's own look. Recorded here so
  // the one-field remedy (swap that row's tracer to bullet.02) is discoverable from the test.
  ok("smoke: the classes on the smokeless tracer are knowingly smokeless — one row field would change it",
    ["pistol", "smg"].every(c => fx.FX_CLASSES[c].tracer === "jb2a.bullet.01.orange")
    && ["rifle", "heavy"].every(c => fx.FX_CLASSES[c].tracer === "jb2a.bullet.02.orange"),
    ["pistol", "smg", "rifle", "heavy"].map(c => `${c}:${fx.FX_CLASSES[c].tracer.split(".").slice(-2).join(".")}`).join(" "));
  // "ROPY": overlapping edges reading as strands. Lower opacity merges them; a wider phase and scale
  // spread stops successive puffs looking like the same sprite arriving again.
  ok("smoke: opacity is low enough for overlaps to merge rather than show as strands",
    fx.MUZZLE_SMOKE.opacity <= 0.3, String(fx.MUZZLE_SMOKE.opacity));
  ok("smoke: the phase and scale spreads are wide enough that successive puffs are not repeats",
    fx.MUZZLE_SMOKE.startPhaseMax >= 0.5 && (fx.MUZZLE_SMOKE.scaleMax - fx.MUZZLE_SMOKE.scaleMin) >= 0.6,
    `phase up to ${fx.MUZZLE_SMOKE.startPhaseMax} of the clip, scale ${fx.MUZZLE_SMOKE.scaleMin}-${fx.MUZZLE_SMOKE.scaleMax}`);
  // "STARTS TOO FAR FROM THE SHOOTER": the smoke is born at the barrel, inside where the flash sits.
  ok("smoke: it is born closer in than the muzzle sprite — at the barrel, not the token's edge",
    fx.MUZZLE_SMOKE.originFraction < fx.MUZZLE_SPRITE.edgeFraction,
    `smoke at ${fx.MUZZLE_SMOKE.originFraction} of the token's width vs the flash at ${fx.MUZZLE_SPRITE.edgeFraction}`);
  ok("smoke: the shell's ONE discharge does smoke, and it is the row that says so, not a named branch",
    fx.smokePlanFor("shotgun", 1).emissions === 1 && fx.smokesOnSingleShot("shotgun") === true
    && fx.FX_CLASSES.shotgun.smokeSingle === true
    && ["pistol", "smg", "rifle", "heavy"].every(c => fx.smokesOnSingleShot(c) === false),
    `shell ${fx.smokePlanFor("shotgun", 1).emissions} puff, opted-out rows: ${Object.keys(fx.FX_CLASSES).filter(c => fx.smokesOnSingleShot(c)).join(",")}`);
  ok("smoke: the opt-out moves the smoke only — a single shell still throws no specks (negative)",
    fx.FX_CLASSES.shotgun.motes > 0 && fx.smokePlanFor("shotgun", 0).emissions === 0,
    `shell maps ${fx.FX_CLASSES.shotgun.motes} specks, which stay on the burst gate`);
  // DRIFT, re-pinned (FR#20): "still gets a bit too far from the shooter, all classes". The cap was
  // 1.5 squares against a measured reach of 0.48-0.99, so it bounded nothing anyone saw. Both the cap
  // and the components that feed it are asserted, since tightening the cap alone would only clip the
  // tail and leave the typical puff where it was.
  ok("smoke: the drift cap is inside the asked-for band — about half a tile to a tile",
    fx.MUZZLE_SMOKE.driftMaxSquares >= 0.8 && fx.MUZZLE_SMOKE.driftMaxSquares <= 1.0,
    `${fx.MUZZLE_SMOKE.driftMaxSquares} squares`);
  ok("smoke: the components were pulled in with it, so the typical puff moved and not just the tail",
    fx.MUZZLE_SMOKE.driftAlongSquares <= 0.30 && fx.MUZZLE_SMOKE.driftLateralSquares <= 0.26
    && fx.MUZZLE_SMOKE.driftLateralSquares > 0,
    `along ${fx.MUZZLE_SMOKE.driftAlongSquares}, lateral ${fx.MUZZLE_SMOKE.driftLateralSquares}`);
  // The cap is measured FROM THE SHOOTER, and the planner's own worst case has to respect it — asserted
  // by driving the planner to its extremes rather than by trusting the clamp's presence.
  const driftWorst = Array.from({ length: 400 }, (_v, i) => fx.smokePuffPlan(i, {
    files: ["a.webm"], sizeSquares: 0.5, gridPx: 100,
    from: { x: 40, y: 0 }, to: { x: 900, y: 0 }, origin: { x: 0, y: 0 },
  })).map(pl => pl.driftFromOriginSquares);
  ok("smoke: no rolled puff in four hundred lands beyond the cap, measured from the shooter",
    Math.max(...driftWorst) <= fx.MUZZLE_SMOKE.driftMaxSquares + 1e-6,
    `worst ${Math.max(...driftWorst).toFixed(3)} of ${fx.MUZZLE_SMOKE.driftMaxSquares} allowed`);

  // PER-INSTANCE VARIATION, by value from the pure planner. This is the thing the reference's config
  // asks for and never gets: Sequencer rolls its randomisers once per SECTION, so the only way to have
  // instances differ is to roll them ourselves, per emission. A fed rng makes the difference assertable
  // rather than eyeballed.
  let seed = 0;
  const seededRng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const smokeFiles = ["a1.webm", "a2.webm", "a3.webm", "a4.webm", "a5.webm"];
  const plans = Array.from({ length: 5 }, (_v, i) => fx.smokePuffPlan(i, {
    files: smokeFiles, sizeSquares: 0.5, gridPx: 100,
    from: { x: 0, y: 0 }, to: { x: 600, y: 0 }, rng: seededRng,
  }));
  ok("smoke: consecutive puffs cycle the five variants rather than repeating one file",
    new Set(plans.map(pl => pl.file)).size === 5,
    plans.map(pl => pl.file).join(","));
  ok("smoke: no two puffs share a size, a rate, a rotation or a phase",
    new Set(plans.map(pl => pl.sizeSquares)).size === 5
    && new Set(plans.map(pl => pl.playbackRate)).size === 5
    && new Set(plans.map(pl => pl.rotationDeg)).size === 5
    && new Set(plans.map(pl => pl.startTimeMs)).size > 1,
    `sizes ${plans.map(pl => pl.sizeSquares).join(",")} / rates ${plans.map(pl => pl.playbackRate).join(",")}`);
  ok("smoke: every rolled value sits inside the band the spec names",
    plans.every(pl => pl.sizeSquares >= 0.5 * fx.MUZZLE_SMOKE.scaleMin - 1e-6 && pl.sizeSquares <= 0.5 * fx.MUZZLE_SMOKE.scaleMax + 1e-6)
    && plans.every(pl => pl.playbackRate >= fx.MUZZLE_SMOKE.rateMin && pl.playbackRate <= fx.MUZZLE_SMOKE.rateMax)
    && plans.every(pl => Math.abs(pl.rotationDeg) <= fx.MUZZLE_SMOKE.rotationDeg)
    && plans.every(pl => pl.startTimeMs >= 0 && pl.startTimeMs <= fx.MUZZLE_SMOKE.startPhaseMax * fx.MUZZLE_SMOKE.clipMs),
    `rotations ${plans.map(pl => pl.rotationDeg).join(",")} within +/-${fx.MUZZLE_SMOKE.rotationDeg}`);
  ok("smoke: the mirror coin is flipped per instance, not once for the run",
    new Set(plans.map(pl => pl.mirrorY)).size === 2,
    plans.map(pl => pl.mirrorY).join(","));
  ok("smoke: each puff drifts to its OWN point, off the muzzle rather than onto it",
    new Set(plans.map(pl => `${pl.driftTo.x},${pl.driftTo.y}`)).size === 5,
    plans.map(pl => Math.round(pl.driftTo.x)).join(","));
  // REPORTED: "it seems to be launching out of the gun like a projectile". The distance was never the
  // fault — it was that every puff slid along the identical bullet axis, so the group streamed
  // down-range as one jet. These pin the rework: a bounded roll, off-axis, far behind the rounds.
  ok("smoke: no puff ends further from the shooter than the spec's cap",
    plans.every(pl => pl.driftFromOriginSquares <= fx.MUZZLE_SMOKE.driftMaxSquares + 1e-6),
    `furthest ${Math.max(...plans.map(pl => pl.driftFromOriginSquares))} squares, cap ${fx.MUZZLE_SMOKE.driftMaxSquares}`);
  ok("smoke: and none of them gets more than a tile or two out — it hangs with the shooter",
    plans.every(pl => pl.driftFromOriginSquares <= 2),
    plans.map(pl => pl.driftFromOriginSquares).join(","));
  ok("smoke: every puff carries an ACROSS-the-aim component, and they go to both sides",
    plans.every(pl => Math.abs(pl.lateralSquares) > 0)
    && plans.some(pl => pl.lateralSquares > 0) && plans.some(pl => pl.lateralSquares < 0),
    `lateral ${plans.map(pl => pl.lateralSquares).join(",")} squares`);
  // BEHIND THE BULLETS, by value: the puff crawls over its whole clip while a pellet crosses the shot
  // line in its own dashMs. The ratio is the claim — smoke must never look like ordnance.
  const smokeSpeed = (Math.max(...plans.map(pl => pl.driftFromOriginSquares)) * 100) / (fx.MUZZLE_SMOKE.clipMs / 1000);
  const tracerSpeed = 600 / (fx.FX_CLASSES.shotgun.dashMs / 1000);
  ok("smoke: it moves an order of magnitude slower than the rounds it follows",
    smokeSpeed * 10 < tracerSpeed,
    `smoke ~${Math.round(smokeSpeed)}px/s against a pellet's ${Math.round(tracerSpeed)}px/s`);
  ok("smoke: it never reaches anything like the target — the rounds outrun it immediately (negative)",
    Math.max(...plans.map(pl => pl.driftFromOriginSquares)) * 100 < 600 * 0.25,
    `furthest ${Math.round(Math.max(...plans.map(pl => pl.driftFromOriginSquares)) * 100)}px of a 600px shot line`);
  // "It took me a while to even see the smoke": the first puff is emitted on the FIRST round, whatever
  // the stride, and it blooms in quickly enough to be seen rather than creeping up from nothing.
  ok("smoke: the puff goes out on the round itself, not after it",
    [1, 2, 3, 4].every(st => 0 % st === 0),
    "round index 0 satisfies i % stride === 0 for any stride");
  // ⏪ SUPERSEDED, and worth saying why rather than deleting. This leg used to demand a FAST, bright
  // bloom, on the reading that "it took me a while to even see the smoke" was a visibility problem. It
  // was not: the smoke was invisible because it was flying to the target with the rounds (the drift
  // fault below), and once it stayed at the muzzle the same treatment read as too ropy and too heavy.
  // So the bloom is soft again; what actually answers the visibility report is that the first puff goes
  // out on the first round and is born at the barrel, both pinned above.
  ok("smoke: it blooms in SOFTLY — the ropy read wanted a gentler arrival, not a brighter one",
    fx.MUZZLE_SMOKE.scaleInMs >= 200 && fx.MUZZLE_SMOKE.scaleInFrom <= 0.6,
    `scaleIn from ${fx.MUZZLE_SMOKE.scaleInFrom} over ${fx.MUZZLE_SMOKE.scaleInMs}ms at opacity ${fx.MUZZLE_SMOKE.opacity}`);

  // ⏪ SUPERSEDED (FR#22): two legs here pinned the STAGGERED ENDINGS of the burst stream — puffs
  // spawned a stride apart, each finishing on its own clip so a lessening amount was still advancing
  // after the last round. There is no stream left to stagger. The per-instance variation the planner
  // still rolls is asserted above and is what keeps the shell's repeated single discharges from
  // stamping the same puff twice.

  // The COUNT is data, not a branch: a second class with a different mapped count queues that count.
  played.length = 0; playedEntries.length = 0;
  const ambPistol = await fx.fxBurstAmbience(tokenDoc, targetDoc, { weaponClass: "pistol", shots: 4, cadenceMs: 80 });
  await sleep(150);
  ok("ambience: a different class queues ITS row's count, not the first one's (the field is the gate)",
    ambPistol.motes === fx.FX_CLASSES.pistol.motes
    && fx.FX_CLASSES.pistol.motes !== fx.FX_CLASSES.rifle.motes
    && playedEntries.flat().filter(e => e.file === fx.MUZZLE_MOTES.key).length === fx.FX_CLASSES.pistol.motes,
    `pistol ${ambPistol.motes} vs rifle ${fx.FX_CLASSES.rifle.motes}`);
  played.length = 0; playedEntries.length = 0;
  const ambNoAim = await fx.fxBurstAmbience(tokenDoc, null, { weaponClass: "rifle", shots: 10, cadenceMs: 80 });
  await sleep(120);
  // INVERTED: this used to bail on the missing aim and queue nothing at all. It now takes the
  // synthesized axis, so the same specks and the same wisp are queued — down the facing instead.
  const ambNoAimMotes = playedEntries.flat().filter(e => e.file === fx.MUZZLE_MOTES.key);
  const ambSynth = fx.aimPointOf(tokenDoc, null, Number(canvas.dimensions.size));
  ok("ambience: nothing named -> the same spray, queued down the synthesized axis",
    ambNoAim.motes === fx.FX_CLASSES.rifle.motes
    && ambNoAimMotes.length === fx.FX_CLASSES.rifle.motes && played.length === 1,
    `${ambNoAimMotes.length} queued / ${JSON.stringify(ambNoAim)}`);
  ok("ambience: the wisp takes the synthesized point as its heading, not a fixed one",
    playedEntries.flat().filter(e => e.file === fx.MUZZLE_MOTES.key).length === fx.FX_CLASSES.rifle.motes
    && playedEntries.flat().filter(e => e.file === fx.MUZZLE_MOTES.key)
        .every(e => Math.hypot(e.moveTowards.x - ambSynth.x, e.moveTowards.y - ambSynth.y) < 3 * gridNow),
    `${playedEntries.flat().filter(e => e.file === fx.MUZZLE_MOTES.key).length} specks down the synthesized axis`);
  played.length = 0; playedEntries.length = 0;
  const ambUnmapped = await fx.fxBurstAmbience(tokenDoc, targetDoc, { weaponClass: "melee", shots: 10, cadenceMs: 80 });
  await sleep(120);
  ok("route: the smoke wisp is deliberately NOT lifted above the lighting (negative)",
    (playedEntries.flat().find(e => String(e.file ?? "").includes("SmokePuffSide"))?.aboveLighting ?? null) === null
    && (playedEntries.flat().find(e => e.file === fx.MUZZLE_SMOKE.key)?.aboveLighting ?? null) === null,
    "no smoke sprite asks for the above-the-lighting route");
  ok("ambience: an unmapped class queues nothing (negative)",
    ambUnmapped.motes === 0 && ambUnmapped.smoke === undefined && played.length === 0, JSON.stringify(ambUnmapped));

  /* -- 9f. the sprite capture seam ----------------------------------------- */
  // Same family as the flash-level and dash-time seams, and for the same reason: this host takes about
  // two seconds to produce one screenshot and the whole flash is over in a tenth of that, so nothing
  // can be photographed at the shipped speed. It must be OFF unless a capture run armed it, and when
  // armed it must change the CLOCK and nothing else.
  ok("capture seam: the sprite rate is off by default and reports so", fx._setSpriteRate(null) === null);
  played.length = 0; playedEntries.length = 0;
  await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "rifle", hit: true, light: false });
  await sleep(120);
  const shippedSprites = playedEntries.flat();
  ok("capture seam: nothing carries a playback rate when it is off (negative)",
    shippedSprites.every(e => e.playbackRate === undefined),
    String(shippedSprites.filter(e => e.playbackRate !== undefined).length));
  fx._setSpriteRate(0.1);
  played.length = 0; playedEntries.length = 0;
  await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "rifle", hit: true, light: false });
  await sleep(120);
  const heldSprites = playedEntries.flat();
  ok("capture seam: armed, every queued sprite carries the requested rate",
    heldSprites.length === shippedSprites.length && heldSprites.length > 0
    && heldSprites.every(e => e.playbackRate === 0.1),
    `${heldSprites.length} sprites at ${[...new Set(heldSprites.map(e => e.playbackRate))].join(",")}`);
  ok("capture seam: it changes the clock and nothing that ships - sizes, trims and placement identical",
    heldSprites.every((e, i) => e.file === shippedSprites[i].file
      && JSON.stringify(e.size ?? null) === JSON.stringify(shippedSprites[i].size ?? null)
      && JSON.stringify(e.timeRange ?? null) === JSON.stringify(shippedSprites[i].timeRange ?? null)
      && Math.round(e.atLocation?.x ?? 0) === Math.round(shippedSprites[i].atLocation?.x ?? 0)),
    `${heldSprites.length} compared`);
  fx._setSpriteRate(null);
  played.length = 0; playedEntries.length = 0;
  await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "rifle", hit: true, light: false });
  await sleep(120);
  ok("capture seam: clearing it restores the shipped rate (negative)",
    playedEntries.flat().every(e => e.playbackRate === undefined), "cleared");

  globalThis.Sequence = realSequence;
  fx._setDbProbe(null);
  ok("controlled surface: the install's own engine and database are back",
    globalThis.Sequence === realSequence && fx.sequencerActive() === true && fx.fxDbEntryExists(fx.FX_CLASSES.pistol.tracer) === true);

  /* ── 10. miss divergence (deterministic) ───────────────────────────────── */
  const from = { x: 0, y: 0 }, to = { x: 100, y: 0 };
  const low = fx.missEndpoint(from, to, () => 0);
  const high = fx.missEndpoint(from, to, () => 1);
  const expLowX = Math.cos(-fx.MISS_SPREAD_RAD) * 60, expLowY = Math.sin(-fx.MISS_SPREAD_RAD) * 60;
  ok("divergence: minimum draw lands short and off-axis", Math.abs(low.x - expLowX) < 0.01 && Math.abs(low.y - expLowY) < 0.01, `${low.x.toFixed(2)},${low.y.toFixed(2)}`);
  ok("divergence: maximum draw lands past and off-axis", Math.abs(high.x - Math.cos(fx.MISS_SPREAD_RAD) * 115) < 0.01 && Math.abs(high.y - Math.sin(fx.MISS_SPREAD_RAD) * 115) < 0.01, `${high.x.toFixed(2)},${high.y.toFixed(2)}`);
  ok("divergence: endpoint differs from the direct line", Math.abs(low.y) > 1 && Math.abs(high.y) > 1);

  /* ── 10b. pellet-fan geometry (deterministic) ──────────────────────────── */
  const fanFrom = { x: 0, y: 0 }, fanTo = { x: 100, y: 0 };
  const cone = fx.pelletEndpoints(fanFrom, fanTo, { pellets: 4, spreadRad: 0.07, hit: true });
  ok("fan geometry: one endpoint per pellet", cone.length === 4, String(cone.length));
  ok("fan geometry: a hit converges — every pellet lands at the aim distance",
    cone.every(p => Math.abs(Math.hypot(p.x, p.y) - 100) < 0.001), cone.map(p => Math.hypot(p.x, p.y).toFixed(3)).join(","));
  const coneAngles = cone.map(p => Math.atan2(p.y, p.x));
  ok("fan geometry: offsets evenly spaced across the full cone",
    coneAngles.map(a => a.toFixed(6)).join(",") === [-0.07, -0.07 / 3, 0.07 / 3, 0.07].map(a => a.toFixed(6)).join(","),
    coneAngles.map(a => a.toFixed(5)).join(","));
  ok("fan geometry: symmetric about the aim line, with no pellet sitting on it",
    coneAngles.every(a => Math.abs(a) > 1e-6) && Math.abs(coneAngles[0] + coneAngles[3]) < 1e-9,
    coneAngles.map(a => a.toFixed(5)).join(","));
  // A miss draws the miss divergence PER PELLET — its own angle AND its own reach — which is what makes
  // the group splay rather than fan neatly past the target. Counted by draws consumed from a fed
  // sequence, so "independently" is asserted rather than assumed.
  const draws = [0, 0, 1, 1, 0, 0, 1, 1];
  let drawn = 0;
  const splay = fx.pelletEndpoints(fanFrom, fanTo, { pellets: 4, spreadRad: 0.07, hit: false, rng: () => draws[drawn++] });
  const lowMiss = fx.missEndpoint(fanFrom, fanTo, () => 0);
  const highMiss = fx.missEndpoint(fanFrom, fanTo, () => 1);
  ok("fan geometry: a miss draws the miss divergence independently per pellet",
    splay.length === 4 && drawn === 8
    && Math.abs(splay[0].x - lowMiss.x) < 0.001 && Math.abs(splay[0].y - lowMiss.y) < 0.001
    && Math.abs(splay[1].x - highMiss.x) < 0.001 && Math.abs(splay[1].y - highMiss.y) < 0.001,
    `${drawn} draws consumed for ${splay.length} pellets`);
  // The legs above feed the pure function fixed inputs; this one feeds it the SHIPPED row, so the
  // count actually in the table is exercised rather than a number that used to be in it.
  const shipped = fx.pelletEndpoints(fanFrom, fanTo, { pellets: shellRow.pellets, spreadRad: shellRow.spreadRad, hit: true });
  const shippedAngles = shipped.map(p => Math.atan2(p.y, p.x));
  ok("fan geometry: the SHIPPED pellet count fans evenly across the shipped cone",
    shipped.length === shellRow.pellets
    && Math.abs(shippedAngles[0] + shippedAngles[shippedAngles.length - 1]) < 1e-9
    && Math.abs(shippedAngles[0] + shellRow.spreadRad) < 1e-9
    && shippedAngles.every(a => Math.abs(a) > 1e-6),
    `${shipped.length} pellets, angles ${shippedAngles.map(a => a.toFixed(4)).join(",")}`);
  ok("fan geometry: no fan without a pellet count, and none without an aim (negative)",
    fx.pelletEndpoints(fanFrom, fanTo, { pellets: 1, spreadRad: 0.07 }).length === 0
    && fx.pelletEndpoints(fanFrom, fanTo, {}).length === 0
    && fx.pelletEndpoints(fanFrom, null, { pellets: 4, spreadRad: 0.07 }).length === 0);

  /* ── 11. the fire path carries the aim WITHOUT moving the damage flow ──── */
  // Where the aim comes from in the first place, and the separation that keeps it free.
  //
  // The host hands its target-token list to the FULL-AUTO resolver only, so the card every other fire
  // mode renders resolves no target of its own and the emitted payload carried a null target id on all
  // of them — which this rail reads as "pointed at nothing" and, per §9b, then draws no sprite and no
  // tracer at all. The seam captures the aimed-at token at fire time to answer that.
  //
  // But the SAME payload field the rail wanted is the one the damage handler branches on: a payload
  // carrying `targetTokenId` resolves its target and opens the damage dialog in the middle of the
  // action (path A), and a payload without one is flagged onto the shot's chat card for a button press
  // instead (path B). Carrying the aim in that field therefore moved every single shot, burst and melee
  // onto the mid-action dialog — a reported defect, not a wanted change. So the seam emits the aim under
  // its OWN field, `fxTargetTokenId`, and leaves `targetTokenId` meaning exactly what the damage flow
  // reads it to mean. These legs pin both halves: the aim arrives, and the routing does not move.
  //
  // Driven through the REAL fire methods (not hand-built payloads): the capture point is inside those
  // calls, and the routing decision is taken by the live handler listening to them.
  const autoApplyWas = game.settings.get(SCOPE, "damageAutoApply");
  await game.settings.set(SCOPE, "damageAutoApply", false);  // so a path-A payload would really open one
  const sectionMsgMark = game.messages.map(m => m.id);       // every card this section posts, for teardown
  const fired = [];
  const firedHook = Hooks.on("cyberpunk2020.weaponFired", (p) => fired.push({
    targetTokenId: p.targetTokenId, fxTargetTokenId: p.fxTargetTokenId,
    shotsFired: p.shotsFired, landed: Object.keys(p.areaDamages ?? {}).length,
  }));
  const rifle = actor.items.get(madeIds.rifle);
  // A landed round is a precondition for the routing branch at all (a card with nothing on it is
  // dropped before either path), so the fixture is made to land rather than left to the dice.
  await rifle.update({ "system.accuracy": 40 });
  const tgPlaceable = canvas.tokens.get(targetDoc.id);
  const damageWindows = () => [...foundry.applications.instances.values()].filter(a => /Damage/i.test(a?.constructor?.name ?? ""));
  const closeDamageWindows = async () => { for (const a of damageWindows()) { try { await a.close(); } catch (e) { /* already closed */ } } };
  // The host's fire cards are posted through its own roll helper, which does not always stamp a speaker
  // actor, so "the card for THIS shot" is identified by what is NEW since the shot began rather than by
  // whose it claims to be — and the flag is looked for across all of them.
  let msgMark = [];
  const newCards = () => game.messages.filter(m => !msgMark.includes(m.id));
  const cardFlagged = () => newCards().some(m => !!m.getFlag(SCOPE, "damagePayload"));
  const fireOnce = async (fireMode, targets = []) => {
    fired.length = 0;
    await closeDamageWindows();
    msgMark = game.messages.map(m => m.id);
    await rifle.update({ "system.shotsLeft": 10 });
    await rifle.__weaponRoll({ fireMode, range: "RangeClose", extraMod: 0 }, targets);
    await sleep(1400);
  };

  /* ── 11-0. clean slate: nothing may be left queued for a card ──────────── */
  // §8 drove the WIRED listener with SYNTHETIC emissions — Hooks.callAll, not a fire — so each one
  // carried damage and had NO card behind it. The damage handler queues such a payload for the next
  // card this user posts, and the next card this user posts is the first one of THIS section: the
  // "one path, not both" leg below would then read a flag belonging to §8's leftovers rather than to
  // its own shot. (Isolated on the rig: from a clean queue that shot gives a window and no flag,
  // twice over; behind an unconsumed emission the same shot gives a window AND a flag.) So the queue
  // is emptied deliberately here and then PROVEN empty rather than assumed.
  const queueDrain = async () => {
    const m = await ChatMessage.create({ content: "__PW__FX queue drain" });
    await sleep(500);
    const flagged = !!m.getFlag(SCOPE, "damagePayload");
    try { await m.delete(); } catch (e) { /* already gone */ }
    return flagged;
  };
  await queueDrain();
  ok("clean slate: nothing is left queued for a card before the routing legs run",
    (await queueDrain()) === false, "queue empty");

  tgPlaceable?.setTarget(true, { releaseOthers: true });
  await sleep(250);
  await fireOnce("SemiAuto");
  // A LANDED round is the precondition for the routing branch to be taken at all — a card with nothing
  // on it is dropped before either path is chosen — and the host's own dice decide it, so a shot that
  // misses says nothing about the routing split and reports zero windows below. (Seen once on a
  // re-run: same code, one FAIL, because the round missed.) The precondition is retried, bounded;
  // none of the assertions is. Same guard the full-auto control leg already carries.
  for (let i = 0; i < 5 && (fired[0]?.landed ?? 0) === 0; i++) await fireOnce("SemiAuto");
  ok("aim carry: a card that resolves no target of its own still reports the aim",
    fired.length === 1 && fired[0].fxTargetTokenId === targetDoc.id, JSON.stringify(fired));
  ok("routing: the aim is NOT written into the field the damage flow branches on",
    fired.length === 1 && fired[0].targetTokenId === null, JSON.stringify(fired));
  // INVERTED on report ("pistols skip the Apply dialog and post a chat card instead"). The base only
  // attaches its routing field on full auto, so a single shot at a held target used to fall to the
  // chat-button path while a burst at the same target opened a window. It now routes on the seam's
  // own aim field and takes the SAME deferred-dialog flow. The mid-action objection that kept it out
  // before is answered by the deferral, so the window is expected here — just not immediately.
  for (let i = 0; i < 60 && damageWindows().length === 0; i++) await sleep(100);
  ok("routing: a single shot at a held aim now reaches the apply window, like a burst does",
    damageWindows().length === 1, `${damageWindows().length} window(s) for ${fired[0]?.landed ?? 0} location(s) landed`);
  ok("routing: and it is NOT queued for the chat button as well — one path, not both (negative)",
    cardFlagged() === false, `${fired[0]?.landed ?? 0} location(s) landed / ${newCards().length} new cards`);
  await closeDamageWindows();

  // Full auto is the one mode whose card resolves its own target, so it is the control: its routing
  // field is unchanged by the split and it still takes the immediate path.
  await fireOnce("FullAuto", [tgPlaceable]);
  // The window this control leg reads only opens when the burst LANDS something, and the burst is
  // resolved by the host's own dice — so a run where it misses reports zero windows and says nothing
  // about the routing split. The precondition is retried, bounded; the assertions below are not.
  for (let i = 0; i < 4 && (fired[0]?.landed ?? 0) === 0; i++) await fireOnce("FullAuto", [tgPlaceable]);
  ok("control: the card that resolves its own target still reports it on the routing field",
    fired.length === 1 && fired[0].targetTokenId === targetDoc.id, JSON.stringify(fired));
  // POLLED, not slept on. The window is opened by the HOST's flow, not by this rail, and the fixed
  // wait above was marginal for it once the canvas got busier — it read 1 on some runs and 0 on
  // others with identical code. Nothing this rail does is in that path (the fan-out is fired from a
  // hook listener and never awaited by the host), so the flake is in the waiting, and polling for the
  // window is the fix rather than a longer sleep.
  for (let i = 0; i < 40 && damageWindows().length === 0; i++) await sleep(100);
  ok("control: that path is unchanged — the window still opens for it",
    damageWindows().length === 1, String(damageWindows().length));
  await closeDamageWindows();

  [...game.user.targets].forEach(t => t.setTarget(false, { releaseOthers: false }));
  await sleep(250);
  await fireOnce("SemiAuto");
  ok("aim carry: nothing aimed at -> neither field carries a token (negative)",
    fired.length === 1 && fired[0].targetTokenId === null && fired[0].fxTargetTokenId === null, JSON.stringify(fired));
  Hooks.off("cyberpunk2020.weaponFired", firedHook);
  await closeDamageWindows();

  /* ── 11a-i. the card queue does not outlive the shot that filled it ─────── */
  // The queue exists to hand a payload to the card of the shot that produced it, and that payload is
  // queued from inside the render of that very card — so the card follows within one round trip. The
  // defect this pins: an entry whose card never arrived used to sit there indefinitely and be handed
  // to whatever the user said NEXT. Reproduced plainly on the rig before the fix: one unconsumed
  // emission, then an ordinary chat line, and the chat line came back carrying an apply button.
  // Both halves are asserted — claimable while fresh, dropped once the wait it was given has passed.
  const dh = await import(`/modules/${SCOPE}/module/combat/damage-hooks.js`);
  const queueOnce = () => Hooks.callAll("cyberpunk2020.weaponFired", {
    attackerId: actor.id, weaponId: madeIds.rifle, weaponName: "__PW__FX rifle",
    shotsFired: 1, areaDamages: { Torso: [{ damage: 2 }] },
  });
  ok("queue lifetime: the wait a queued payload is given is a named span, not an open end",
    Number.isFinite(dh.PENDING_PAYLOAD_TTL_MS) && dh.PENDING_PAYLOAD_TTL_MS > 0,
    `${dh.PENDING_PAYLOAD_TTL_MS}ms`);
  queueOnce();
  await sleep(400);
  ok("queue lifetime: a fresh entry is still handed to the next card this user posts (control)",
    (await queueDrain()) === true, "claimed while fresh");
  queueOnce();
  await sleep(dh.PENDING_PAYLOAD_TTL_MS + 800);
  ok("queue lifetime: an entry whose card never came is not handed to a later message (negative)",
    (await queueDrain()) === false, `${dh.PENDING_PAYLOAD_TTL_MS}ms + margin elapsed`);

  /* ── 11a-ii. dialog deferral: the apply window waits out the presentation ── */
  // The reported defect: the apply window opened the instant a targeted shot resolved — centre-screen,
  // while the rail was still fanning the rounds out — so it covered the action it was reporting on.
  // The window now waits for the payload's own presentation span. Pinned in two parts: the arithmetic
  // by value, and the live behaviour by WHEN the window actually appears.
  // THE TAIL IS NOW "THE ACTION HAS FINISHED", per the 2026-08-08 ruling — the last round's
  // impact/tracer ending, not the muzzle-side floor it used to be. For a painted class that is the
  // impact clip against the tracer clip; the muzzle lance and the light envelope are long since over.
  const tailRifle = fx.presentationTailMs("rifle");
  ok("presentation window: one round's tail runs to its impact/tracer end, not to its muzzle",
    tailRifle === Math.max(fx.TRACER_CLIP_MS, fx.HIT_CONFIRM.clipMs)
    && tailRifle > fx.MUZZLE_SPRITE.endMs && tailRifle > fx.muzzleEnvelopeDurationMs(),
    `${tailRifle}ms vs tracer ${fx.TRACER_CLIP_MS} / impact ${fx.HIT_CONFIRM.clipMs} / lance ${fx.MUZZLE_SPRITE.endMs} / envelope ${fx.muzzleEnvelopeDurationMs()}`);
  ok("presentation window: a travelled class waits for its crossing AND then its impact",
    fx.presentationTailMs("shotgun") === shellRow.dashMs + fx.HIT_CONFIRM.clipMs
    && fx.presentationTailMs("shotgun") > tailRifle,
    `${fx.presentationTailMs("shotgun")}ms = ${shellRow.dashMs} crossing + ${fx.HIT_CONFIRM.clipMs} impact`);
  // THE RULED EXCLUSIONS: the burst dressing lingers far past the action and is deliberately not
  // waited on. Asserted by value against what the ambience itself is asked to live for.
  // ⚠ ASSERTED AS A MECHANISM, NOT AS A DURATION RACE. An earlier version of this leg compared the
  // wisp's lifetime against the TAIL alone and called it "outlives" — which is not a claim that holds:
  // the wisp starts when the burst starts while the tail only begins after the last round, so which
  // ends first depends entirely on the round count. What is actually true, and what the ruling asked
  // for, is that the dressing is not part of the signal at all: only the last round's terminal
  // elements are tagged for the engine to report on, and the ambience is never tagged.
  const taggedShot = await fx.fxShot(tokenDoc, targetDoc, { weaponClass: "shotgun", hit: true, light: false, settleTag: "__PW__FX_tagcheck" });
  const taggedAmbience = await fx.fxBurstAmbience(tokenDoc, targetDoc, { weaponClass: "shotgun", shots: 6, cadenceMs: 180 });
  await sleep(1200);
  ok("presentation window: only the round's terminal elements are tagged for the signal",
    taggedShot.tagged === taggedShot.pellets + (taggedShot.impact ? 1 : 0) && taggedShot.tagged > 0,
    `${taggedShot.tagged} tagged = ${taggedShot.pellets} pellet(s) + ${taggedShot.impact ? 1 : 0} impact`);
  ok("presentation window: the burst dressing carries no tag and cannot hold the signal (negative)",
    taggedAmbience.tagged === undefined && (taggedAmbience.motes > 0 || taggedAmbience.smoke),
    `ambience drew motes ${taggedAmbience.motes} / smoke ${taggedAmbience.smoke}, tagged ${taggedAmbience.tagged}`);
  // ⏪ SUPERSEDED: the FR#16 legs here pinned a single wisp's minMs/maxMs/fadeOutMs. That treatment is
  // gone — the long static fade was the wrong KIND of linger (see the MUZZLE_SMOKE block) — so what is
  // pinned now is the short fade the rebuild uses and the fact that the settle still ignores smoke.
  ok("smoke: the fade is short — the linger comes from staggered instances, not from one long fade",
    fx.MUZZLE_SMOKE.fadeOutMs >= 200 && fx.MUZZLE_SMOKE.fadeOutMs <= 400,
    `${fx.MUZZLE_SMOKE.fadeOutMs}ms fade ("rapidly disappearing")`);
  ok("smoke: the smoke system did NOT move the settle — the tail is unchanged by it (negative)",
    fx.presentationTailMs("shotgun") === shellRow.dashMs + fx.HIT_CONFIRM.clipMs,
    `tail still ${fx.presentationTailMs("shotgun")}ms`);
  ok("presentation window: the mote spray is not waited for either (negative)",
    fx.MUZZLE_MOTES.travelMaxMs < fx.presentationTailMs("rifle"),
    `motes done by ${fx.MUZZLE_MOTES.travelMaxMs}ms, tail runs to ${fx.presentationTailMs("rifle")}ms`);
  ok("presentation window: a travelled-tracer class is covered by its own crossing time too",
    fx.presentationTailMs("shotgun") >= shellRow.dashMs,
    `${fx.presentationTailMs("shotgun")}ms vs ${shellRow.dashMs}ms crossing`);
  ok("presentation window: a SINGLE round is one tail — not zero, and not special-cased",
    fx.presentationMs(1, "rifle") === tailRifle && fx.presentationMs(1, "shotgun") === fx.presentationTailMs("shotgun"),
    `${fx.presentationMs(1, "rifle")} / ${fx.presentationMs(1, "shotgun")}`);
  ok("presentation window: a multi-round payload is its gaps plus one tail, at its OWN cadence",
    fx.presentationMs(10, "rifle") === 9 * fx.SHOT_CADENCE_MS + tailRifle
    && fx.presentationMs(10, "shotgun") === 9 * fx.classCadenceMs("shotgun") + fx.presentationTailMs("shotgun")
    && fx.presentationMs(10, "shotgun") > fx.presentationMs(10, "rifle"),
    `rifle ${fx.presentationMs(10, "rifle")}ms / shell ${fx.presentationMs(10, "shotgun")}ms`);
  ok("presentation window: the span is bounded by the same round cap the fan-out uses",
    fx.presentationMs(9999, "shotgun") === fx.presentationMs(fx.MAX_FX_SHOTS, "shotgun")
    && fx.presentationMs(0, "rifle") === fx.presentationMs(1, "rifle"),
    `${fx.presentationMs(9999, "shotgun")}ms at the ${fx.MAX_FX_SHOTS}-round cap`);
  // The payload-facing entry point: the class is resolved the way the fan-out resolves it, and the
  // zero cases are exactly two — nothing mapped, or the rail switched off.
  const mkPayload = (over = {}) => ({ attackerId: actor.id, weaponId: madeIds.rifle, weaponName: "__PW__FX rifle", areaDamages: {}, ...over });
  ok("presentation window: a mapped payload reports its own span through the payload entry point",
    fx.payloadPresentationMs(mkPayload({ shotsFired: 6 })) === fx.presentationMs(6, "rifle")
    && fx.payloadPresentationMs(mkPayload({ shotsFired: 1 })) === fx.presentationMs(1, "rifle"),
    `${fx.payloadPresentationMs(mkPayload({ shotsFired: 6 }))}ms for six rounds`);
  ok("presentation window: an unmapped weapon reports nothing to wait for (negative)",
    fx.payloadPresentationMs(mkPayload({ weaponId: madeIds.melee, weaponName: "__PW__FX melee", shotsFired: 6 })) === 0
    && fx.payloadPresentationMs({ shotsFired: 6 }) === 0,
    "melee / no weapon");
  // It does not depend on the optional effect engine: the muzzle light and the cadence are native, so
  // a client with no sprite module still has a presentation to wait out. Driven on a database that
  // resolves nothing, which is what "no assets" looks like to this adapter.
  // This one DOES take the engine's whole namespace away, where §9 deliberately does not — because the
  // claim is about the ENGINE being absent, not about what its database answers. It is safe here and
  // only here because the swap, the read and the restore are one unbroken synchronous run: no queued
  // section can be scheduled in between, so no effect in flight can find the namespace missing.
  const realSeqDb = globalThis.Sequencer;
  globalThis.Sequencer = { Database: { entryExists: () => false } };
  ok("presentation window: it does not depend on the optional sprite engine",
    fx.payloadPresentationMs(mkPayload({ shotsFired: 6 })) === fx.presentationMs(6, "rifle"),
    String(fx.payloadPresentationMs(mkPayload({ shotsFired: 6 }))));
  globalThis.Sequencer = realSeqDb;

  /* -- 11a-ii-b. the COMPLETION SIGNAL: the rail reports, the sum stands in --- */
  // The window used to wait on a sum reproduced in the damage handler. The rail queues the durations,
  // so it now reports its own completion and the sum survives only where there is no fan-out to ask.
  // The travelled class is the case that motivated it: the old sum said 150ms where the pellets do not
  // land until their crossing plus the impact clip.
  const settleShell = fx.presentationTailMs("shotgun");
  ok("completion: the travelled class's finish is its crossing PLUS its impact, far past the old sum",
    settleShell === shellRow.dashMs + fx.HIT_CONFIRM.clipMs && settleShell > shellRow.dashMs * 5,
    `${settleShell}ms against the ${shellRow.dashMs}ms crossing the old sum stopped at`);
  // The SIGNAL route: a real fan-out arms it, and what comes back says it was the rail talking.
  const signalPayload = payload({ shotsFired: 2, targetTokenId: targetDoc.id, areaDamages: { Torso: [{ damage: 2 }] } });
  const inFlightBefore = fx.settlementsInFlight();
  const signalRun = fx.fxWeaponFired(signalPayload);
  const settledAt = Date.now();
  const signalOutcome = await fx.presentationSettled(signalPayload);
  const signalMs = Date.now() - settledAt;
  await signalRun;
  ok("completion: a real fan-out resolves from the ENGINE's own report of the elements ending",
    signalOutcome.via === "engine" && signalOutcome.created > 0 && signalOutcome.ended >= signalOutcome.created,
    JSON.stringify(signalOutcome));
  // THE POINT OF ASKING THE ENGINE. The scheduled sum under-runs what the engine actually does — the
  // effects live past their nominal durations — so a wait built on the sum releases the window while
  // the last frames are still up. Measured on this rig when the change was made: rifle 1022ms actual
  // against a 933ms schedule (+89ms), shell 1045ms against 983ms (+62ms).
  ok("completion: and it outlasts the scheduled arithmetic by the engine's real margin",
    signalOutcome.ms >= fx.presentationTailMs("rifle"),
    `settled at ${signalOutcome.ms}ms against a ${fx.presentationTailMs("rifle")}ms schedule (+${signalOutcome.ms - fx.presentationTailMs("rifle")}ms)`);
  ok("completion: the wait really spans it — it is not resolving early",
    signalMs >= fx.presentationTailMs("rifle") * 0.8, `${signalMs}ms waited`);
  ok("completion: the in-flight register is emptied once a payload settles (no leak)",
    fx.settlementsInFlight() === inFlightBefore, `${fx.settlementsInFlight()} in flight`);
  // The ARITHMETIC route: nothing armed this payload, so the pure span stands in rather than hanging.
  const orphan = payload({ shotsFired: 3, targetTokenId: targetDoc.id, areaDamages: { Torso: [{ damage: 1 }] } });
  const orphanOutcome = await fx.presentationSettled(orphan);
  ok("completion: a payload no fan-out ever armed falls back to the arithmetic, not a hang",
    orphanOutcome.via === "arithmetic" && orphanOutcome.ms === fx.payloadPresentationMs(orphan),
    JSON.stringify(orphanOutcome));
  // The FX-OFF route: with the rail switched off there is nothing to present and nothing to wait for.
  const fxWasSignal = game.settings.get(SCOPE, "combatFxEnabled");
  await game.settings.set(SCOPE, "combatFxEnabled", false);
  const offPayload = payload({ shotsFired: 4, targetTokenId: targetDoc.id, areaDamages: { Torso: [{ damage: 1 }] } });
  fx.fxWeaponFired(offPayload);
  const offOutcome = await fx.presentationSettled(offPayload);
  await game.settings.set(SCOPE, "combatFxEnabled", fxWasSignal);
  ok("completion: with the rail off it reports nothing to wait for (negative)",
    offOutcome.via === "arithmetic" && offOutcome.ms === 0, JSON.stringify(offOutcome));
  // The CAP: a fan-out that never reports can delay the window but can never park it.
  // THE LEAD (reported: "slightly sluggish"). The window opens a hair AHEAD of the engine's report,
  // floored at the scheduled end. Both halves are asserted on the pure rule, so the floor's precedence
  // is a fact about the arithmetic rather than something inferred from a stopwatch.
  ok("completion: the window opens ahead of the engine's report by the lead",
    fx.settleOpenAtMs(900, 1200) === 1200 - fx.APPLY_LEAD_MS && fx.APPLY_LEAD_MS > 0,
    `engine 1200ms - ${fx.APPLY_LEAD_MS}ms lead = ${fx.settleOpenAtMs(900, 1200)}ms`);
  ok("completion: but the scheduled floor still binds — the lead cannot drag it earlier (negative)",
    fx.settleOpenAtMs(1000, 1050) === 1000 && fx.settleOpenAtMs(1000, 900) === 1000,
    `engine 1050 - ${fx.APPLY_LEAD_MS} would be ${1050 - fx.APPLY_LEAD_MS}, floored to ${fx.settleOpenAtMs(1000, 1050)}`);
  ok("completion: the lead is a modest trim, not a return to the old scheduled-only open",
    fx.APPLY_LEAD_MS >= 100 && fx.APPLY_LEAD_MS <= 250,
    `${fx.APPLY_LEAD_MS}ms`);
  ok("completion: a live settle reports the floor, the engine and the opening it chose",
    signalOutcome.openAt === fx.settleOpenAtMs(signalOutcome.scheduledMs, signalOutcome.engineMs)
    && signalOutcome.openAt >= signalOutcome.scheduledMs,
    `floor ${signalOutcome.scheduledMs} / engine ${signalOutcome.engineMs} / opened ${signalOutcome.openAt}`);
  ok("completion: a hard cap races the signal so nothing can park the window",
    Number.isFinite(fx.PRESENTATION_CAP_MS) && fx.PRESENTATION_CAP_MS > fx.presentationMs(fx.MAX_FX_SHOTS, "shotgun"),
    `${fx.PRESENTATION_CAP_MS}ms cap vs the ${fx.presentationMs(fx.MAX_FX_SHOTS, "shotgun")}ms worst span the table can make`);
  await drain();

  // LIVE. The payload is handed to the real hook the fire path emits on, and the window is watched
  // for from the instant it goes in: absent while the rounds are still going out, present afterwards.
  const deferralRun = async (shots) => {
    await closeDamageWindows();
    await drain();
    // The span the rail WOULD present for this payload, whatever the setting says — so the rail-off
    // leg below is measured against the same yardstick as the others rather than against zero.
    const expected = fx.presentationMs(shots, "shotgun");
    const sampleAt = Math.round(expected * 0.4);
    const t0 = Date.now();
    Hooks.callAll("cyberpunk2020.weaponFired", {
      attackerId: actor.id, weaponId: madeIds.shotgun, weaponName: "__PW__FX shotgun",
      targetTokenId: targetDoc.id, shotsFired: shots, areaDamages: { Torso: [{ damage: 3 }] },
    });
    let appearedMs = null, windowsAtSample = null;
    for (let i = 0; i < 400; i++) {
      const t = Date.now() - t0;
      const n = damageWindows().length;
      if (windowsAtSample === null && t >= sampleAt) windowsAtSample = n;
      if (n > 0) { appearedMs = t; if (windowsAtSample === null) windowsAtSample = n; break; }
      if (t > expected + 8000) break;
      await sleep(25);
    }
    const after = damageWindows().length;
    await closeDamageWindows();
    await drain(600);
    return { expected, sampleAt, during: windowsAtSample, after, appearedMs };
  };
  const burstDefer = await deferralRun(6);
  out.dialogDeferral = { burst: burstDefer };
  ok("dialog deferral: a multi-round payload leaves the canvas clear while the rounds go out",
    burstDefer.during === 0, `${burstDefer.during} window(s) at ${Math.round(burstDefer.expected * 0.4)}ms of a ${burstDefer.expected}ms span`);
  ok("dialog deferral: the window then opens, no earlier than the span it waited for",
    burstDefer.after === 1 && burstDefer.appearedMs >= burstDefer.expected * 0.9,
    `${burstDefer.after} window(s) at ${burstDefer.appearedMs}ms against a ${burstDefer.expected}ms span`);
  const singleDefer = await deferralRun(1);
  out.dialogDeferral.single = singleDefer;
  ok("dialog deferral: a SINGLE round defers too — the same treatment, its own shorter span",
    singleDefer.during === 0 && singleDefer.after === 1
    && singleDefer.appearedMs >= singleDefer.expected * 0.9
    && singleDefer.expected < burstDefer.expected,
    `single ${singleDefer.appearedMs}ms / span ${singleDefer.expected}ms vs burst span ${burstDefer.expected}ms`);
  // NEGATIVE: with the rail off there is no presentation to wait for, so the window opens promptly —
  // which is what proves the wait is the rail's span and not a flat delay added to the damage flow.
  const fxWas = game.settings.get(SCOPE, "combatFxEnabled");
  await game.settings.set(SCOPE, "combatFxEnabled", false);
  const offDefer = await deferralRun(6);
  await game.settings.set(SCOPE, "combatFxEnabled", fxWas);
  out.dialogDeferral.railOff = offDefer;
  // Measured against the span this payload WOULD have been held for, not against one class's tail:
  // the tail is a moving number (it shrank when the spark came off every class) and what this leg
  // actually claims is that no presentation was waited out at all. What is left is the harness's own
  // round trip.
  ok("dialog deferral: with the rail off the window opens promptly (negative)",
    offDefer.after === 1 && offDefer.appearedMs < offDefer.expected * 0.4,
    `${offDefer.appearedMs}ms against the ${offDefer.expected}ms span it would otherwise have waited`);
  /* -- 11a-iv. the attack window's own lifetime: it goes when the shot goes -- */
  // UN-PARKED. The earlier reading — "the confirm callback is not reachable on this core, its option
  // bag carries no onConfirm and no object" — was a MISIDENTIFICATION, not a core limitation: it read
  // a live window against the BASE system's V1 dialog file, which is not the class the sheet opens.
  // The module registers its OWN ApplicationV2 dialog (module/dialog/modifiers.js); on it the callback
  // is an instance field (`_onConfirm`, held privately because V2 FREEZES `options`) and `object` is
  // only assigned when the form is submitted — which is exactly why both read undefined off a window
  // that had just been opened. Nothing is missing.
  //
  // So it is driven through the real path rather than read off the instance: the sheet's own opener
  // builds the window (the same call the `.fire-weapon` dispatch makes — that dispatch is covered by
  // tests/v14/actor-basic-actions.spec.js, and this direct-opener idiom is the one
  // tests/v14/actor-saved-attack-options.spec.js already uses), and the window's real form is
  // submitted. What is measured is WHEN the window goes away.
  //
  // The sharp assertion is "before this shot's own card exists": the announcement is emitted from
  // inside that card's RENDER, so a window that closes on the announcement is gone before the card is
  // created, while a window that waits for the whole confirm chain to settle can only close after it.
  // That is the difference this change made, and it is readable without a stopwatch.
  // WHEN the close is REQUESTED is stamped on the window's own close method rather than polled for.
  // Nothing about the flow changes — the same method still runs — but the reading is immune to render
  // and animation timing, and to how often a poll happens to look. Whether the window then actually
  // goes is asserted separately, off its own rendered state.
  // Driven on the PISTOL deliberately. It is the class the defect was reported on, and it is the one
  // whose card resolves NO target of its own — so this single leg exercises the whole reported shape:
  // the sheet's own opener, the real form, the seam's aim field carrying the routing, the deferred
  // window, and the card that must NOT also be queued for a button.
  const sheet = actor.sheet;
  const pistolItem = actor.items.get(madeIds.pistol);
  await pistolItem.update({ "system.accuracy": 40 });
  let stamps = null, attackDlg = null, openedOk = false;
  // A LANDED round is the precondition for the apply window to exist at all — a card with nothing on
  // it is dropped before either path is chosen, and the host's own dice decide that. So the WHOLE
  // gesture is retried, bounded, until one lands; the assertions below then read a shot that resolved.
  // Nothing about the assertions is retried.
  for (let attempt = 0; attempt < 5; attempt++) {
    await closeDamageWindows();
    stamps = { firedAt: null, cardAt: null, cardId: null, requestedAt: null, goneAt: null, windowAt: null, landed: 0,
               hiddenAtAnnounce: null, hideClass: null, inlineStyleAtAnnounce: null, renderedAtAnnounce: null };
    await pistolItem.update({ "system.shotsLeft": 10 });
    tgPlaceable?.setTarget(true, { releaseOthers: true });
    await sleep(250);
    attackDlg = sheet._cpOpenWeaponAttackDialog(pistolItem);
    for (let i = 0; i < 80 && !attackDlg?.rendered; i++) await sleep(50);
    openedOk = attackDlg?.rendered === true && !!attackDlg?.element;
    if (!openedOk) break;
    const realClose = attackDlg.close.bind(attackDlg);
    attackDlg.close = (...a) => { if (stamps.requestedAt === null) stamps.requestedAt = Date.now(); return realClose(...a); };
    const stampFired = Hooks.once("cyberpunk2020.weaponFired", (p) => {
      stamps.firedAt = Date.now();
      stamps.landed = Object.values(p.areaDamages ?? {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
      // Read the window on the MICROTASK after the announcement. This listener was registered before
      // the sheet's (the sheet registers its hide when the form is submitted, which is later), so
      // hooks fire this one FIRST and a synchronous read here would look at the state before the hide.
      // A microtask runs once the whole dispatch has finished and still before any paint — so it is
      // exactly what the viewer's next frame would show.
      // FRAME-LEVEL EVIDENCE, not a one-off computed read: sample whether the window would be PAINTED
      // on each animation frame from the announcement on. The close is asynchronous and (by default)
      // animated, so a single probe can miss a window that is still fading; this records what a viewer
      // would actually see, frame by frame.
      stamps.frames = [];
      const t0 = performance.now();
      const sampleFrame = () => {
        const el = attackDlg.element;
        const painted = !!el && document.contains(el)
          && getComputedStyle(el).display !== "none"
          && getComputedStyle(el).visibility !== "hidden"
          && el.getBoundingClientRect().height > 0;
        stamps.frames.push({ t: Math.round(performance.now() - t0), painted, inDom: !!el && document.contains(el) });
        if (performance.now() - t0 < 400) requestAnimationFrame(sampleFrame);
      };
      requestAnimationFrame(sampleFrame);
      queueMicrotask(() => {
        const el = attackDlg.element;
        stamps.hideClass = !!el?.classList?.contains("cp-hidden");
        const inline = el?.getAttribute?.("style") ?? "";
        // The framework positions its own windows with inline geometry (z-index/width/left/top); what
        // must NOT be there is a hand-written display/visibility, which is the thing the class exists
        // to avoid. Recorded as the offending declarations only.
        stamps.inlineStyleAtAnnounce = inline.split(";").map(d => d.trim())
          .filter(d => /^(display|visibility|opacity)\s*:/i.test(d)).join("; ");
        stamps.hiddenAtAnnounce = stamps.hideClass || el?.offsetParent === null;
        stamps.renderedAtAnnounce = attackDlg.rendered === true;
      });
    });
    // THE SHOT'S OWN CARD, not merely the next one to appear. ⚠ This used to claim the first message
    // of ANY author: on a rig with a human firing alongside the run, their card landed in the window
    // and was stamped as this shot's — observed as a card timestamped 175ms BEFORE the shot was even
    // announced, which then failed every dismissal leg downstream. Same two questions the module's own
    // matcher asks (this user authored it, and it is not older than the shot).
    const stampCard = Hooks.on("createChatMessage", (m) => {
      if (stamps.cardAt !== null || stamps.firedAt === null) return;
      const authorId = m.author?.id ?? m.user?.id ?? null;
      if (authorId && authorId !== game.user.id) return;
      stamps.cardAt = Date.now(); stamps.cardId = m.id;
    });
    attackDlg.element.requestSubmit();
    for (let i = 0; i < 800; i++) {
      if (stamps.goneAt === null && attackDlg.rendered === false) stamps.goneAt = Date.now();
      if (stamps.windowAt === null && damageWindows().length > 0) stamps.windowAt = Date.now();
      if (stamps.goneAt !== null && stamps.windowAt !== null) break;
      await sleep(10);
    }
    Hooks.off("cyberpunk2020.weaponFired", stampFired);
    Hooks.off("createChatMessage", stampCard);
    if (stamps.landed > 0) break;
  }
  ok("presentation window: the sheet's opener puts a real attack window on screen", openedOk, String(openedOk));
  const rel = (t) => (t === null || stamps.firedAt === null ? "never" : `${t - stamps.firedAt}ms`);
  out.attackWindow = { ...stamps, relative: { requested: rel(stamps.requestedAt), gone: rel(stamps.goneAt), card: rel(stamps.cardAt), applyWindow: rel(stamps.windowAt) } };
  // PART A — the window is HIDDEN synchronously at the announcement, ahead of the asynchronous close.
  // Closing an ApplicationV2 awaits its own teardown, so even asking for it at the announcement left
  // the window drawn over the opening frames of the shot. The hide is one classList add, so it lands
  // in the announcement's own tick and the stage is clean before the rail draws anything.
  ok("presentation window: the window is visually gone in the SAME tick the shot is announced",
    stamps.hiddenAtAnnounce === true,
    `hide class present at the announcement: ${stamps.hiddenAtAnnounce}`);
  ok("presentation window: it is hidden by the shared class, with no inline style written",
    stamps.hideClass === true && stamps.inlineStyleAtAnnounce === "",
    `class ${stamps.hideClass}, inline style "${stamps.inlineStyleAtAnnounce}"`);
  ok("presentation window: the hide lands BEFORE the close has finished — it is not the close doing it",
    stamps.renderedAtAnnounce === true,
    `still rendered when the hide was observed: ${stamps.renderedAtAnnounce}`);
  // THE VISUAL PROOF the report asked for: not one probe, but every frame from the announcement on.
  // The user's diagnosis was right that a computed read at a microtask says nothing about an ANIMATED
  // close — this samples what would actually be painted, and the close is now unanimated as well.
  const paintedFrames = (stamps.frames ?? []).filter(f => f.painted);
  ok("presentation window: not one frame after the announcement paints the window",
    (stamps.frames ?? []).length > 0 && paintedFrames.length === 0,
    `${paintedFrames.length} painted of ${(stamps.frames ?? []).length} frames over ${(stamps.frames ?? []).at(-1)?.t ?? 0}ms`);
  ok("presentation window: and it leaves the DOM without an awaited fade holding it there",
    (stamps.frames ?? []).some(f => !f.inDom),
    `left the DOM by ${((stamps.frames ?? []).find(f => !f.inDom)?.t ?? "never")}ms`);
  ok("presentation window: the shot is announced, and the attack window's close is requested with it",
    stamps.firedAt !== null && stamps.requestedAt !== null,
    `announced ${stamps.firedAt !== null}, close requested at ${rel(stamps.requestedAt)}`);
  ok("presentation window: the attack window is gone before the shot's own card exists",
    stamps.requestedAt !== null && stamps.cardAt !== null && stamps.requestedAt <= stamps.cardAt,
    `close requested ${rel(stamps.requestedAt)}, card ${rel(stamps.cardAt)}`);
  ok("presentation window: the window really leaves the screen, it is not merely asked to",
    stamps.goneAt !== null && attackDlg.rendered === false, `gone ${rel(stamps.goneAt)}`);
  ok("presentation window: and it is gone before the apply window takes the screen",
    stamps.windowAt !== null && stamps.goneAt !== null && stamps.goneAt <= stamps.windowAt,
    `gone ${rel(stamps.goneAt)}, apply window ${rel(stamps.windowAt)}`);
  // THE REPORTED SHAPE, end to end on the real gesture: a single targeted shot from the sheet gets the
  // window, and its card is NOT also queued for the chat button. The report was the other way round
  // ("apply damage doesn't pop up, it shows in the chat"), which is what a payload routed to the
  // button path looks like from the table.
  ok("real path: a sheet-fired single shot at a held target reaches the apply window",
    stamps.windowAt !== null, `apply window ${rel(stamps.windowAt)}`);
  ok("real path: and its own card is NOT queued for the chat button as well (negative)",
    stamps.cardId !== null && !game.messages.get(stamps.cardId)?.getFlag(SCOPE, "damagePayload"),
    `card ${stamps.cardId ? "posted" : "missing"}, flagged ${!!game.messages.get(stamps.cardId)?.getFlag(SCOPE, "damagePayload")}`);

  /* -- 11a-ii-b. dismissal path: a window closed without applying goes back to the card -- */
  // THE REPORTED GAP: "if you close the apply window with the X or the cancel button, it doesn't go
  // back to the chat cards." It is a consequence of the routing change above, and the report is right
  // about the intent: the card-first flow always carried that fallback, and giving the shot a window
  // INSTEAD of a card button ("one path, not both") left a shot that was not followed through on with
  // no way to be applied at all. The window now hands its payload back to the card it belongs to.
  //
  // Driven on the window still standing from the sheet gesture above — the real one, dismissed with
  // its own control — and read against the card id stamped when that shot posted it.
  const shotCard   = () => game.messages.get(stamps.cardId);
  const shotFlag   = () => shotCard()?.getFlag(SCOPE, "damagePayload") ?? null;
  const flaggedIds = () => game.messages.filter(m => !!m.getFlag(SCOPE, "damagePayload")).map(m => m.id);
  const dismissWin = damageWindows()[0] ?? null;
  const cancelCtl  = dismissWin?.element?.querySelector('[data-action="cancelDialog"]') ?? null;
  ok("dismissal path: the standing window offers a dismissal control to drive (precondition)",
    !!dismissWin && !!cancelCtl, `window ${!!dismissWin}, control ${!!cancelCtl}`);
  // A DECOY, posted by this same user between the shot and the dismissal, and therefore NEWER than the
  // shot's own card. If the fallback went looking for "a recent card of mine" instead of the one it was
  // told about as it was created, this is the message it would take.
  const decoy = await ChatMessage.create({ content: "__PW__FX unrelated line" });
  await sleep(600);
  ok("dismissal path: the decoy line is unclaimed while the window stands (control)",
    !decoy.getFlag(SCOPE, "damagePayload") && !shotFlag(), `decoy ${!!decoy.getFlag(SCOPE, "damagePayload")}, shot card ${!!shotFlag()}`);
  const flaggedBefore = flaggedIds();
  cancelCtl?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  for (let i = 0; i < 60 && !shotFlag(); i++) await sleep(100);
  const flaggedNew = flaggedIds().filter(id => !flaggedBefore.includes(id));
  // VALUE, not presence: what came back is the shot's own resolved damage, location for location.
  const returnedLocs = Object.values(shotFlag()?.areaDamages ?? {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
  ok("dismissal path: the shot's own card receives the payload the window was holding",
    returnedLocs === stamps.landed && stamps.landed > 0,
    `${returnedLocs} location(s) returned vs ${stamps.landed} landed`);
  ok("dismissal path: exactly one card is claimed by it, and it is the shot's (negative)",
    flaggedNew.length === 1 && flaggedNew[0] === stamps.cardId && !decoy.getFlag(SCOPE, "damagePayload"),
    `claimed ${JSON.stringify(flaggedNew)}, shot card ${stamps.cardId}, decoy claimed ${!!decoy.getFlag(SCOPE, "damagePayload")}`);
  // POLLED, not read at the flag. The announcement is made from the window's own teardown, AHEAD of the
  // asynchronous close it belongs to — which is the point: the card is handed the payload as part of the
  // dismissal, not after it. So the flag can be (and is) readable while the window is still going.
  for (let i = 0; i < 60 && damageWindows().length > 0; i++) await sleep(100);
  ok("dismissal path: the window really left the screen with it",
    damageWindows().length === 0, `${damageWindows().length} window(s)`);
  // THE VISIBLE OUTCOME, read off the rendered log rather than off the flag: the standard control is
  // what the reader actually gets back.
  const cardEl  = () => document.querySelector(`[data-message-id="${stamps.cardId}"]`);
  const applyCt = () => cardEl()?.querySelectorAll(".cp2020-apply-damage-btn").length ?? 0;
  for (let i = 0; i < 60 && applyCt() === 0; i++) await sleep(100);
  ok("dismissal path: the standard apply control is rendered on that card",
    applyCt() === 1, `${applyCt()} control(s) on the shot's card`);
  // A re-render must not stack a second one. Driven at the injection point itself — the render hook,
  // against the live element — which is the path a scrollback, a popout or an edit takes.
  Hooks.callAll("renderChatMessageHTML", shotCard(), cardEl(), {});
  await sleep(300);
  ok("dismissal path: a re-render does not stack a second control (negative)",
    applyCt() === 1, `${applyCt()} control(s) after a re-render`);
  try { await decoy.delete(); } catch (e) { /* already gone */ }

  /* -- 11a-ii-c. the applied close is NOT a dismissal, and neither is PATH B's own window -- */
  // The distinguishing claim: only a close where the apply action never ran hands the shot back. A
  // window that APPLIED must leave the card exactly as the routing left it — otherwise every resolved
  // shot would grow a button offering to resolve it again.
  //
  // These need several shots, so they drive the same routing through the weapon directly; the sheet
  // gesture above is the end-to-end proof that the same routing is what the table's own gesture takes.
  const firePathA = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await closeDamageWindows();
      let landed = 0;
      const tap = Hooks.on("cyberpunk2020.weaponFired", (p) => { landed += Object.values(p.areaDamages ?? {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0); });
      const before = game.messages.map(m => m.id);
      await pistolItem.update({ "system.shotsLeft": 10 });
      await pistolItem.__weaponRoll({ fireMode: "SemiAuto", range: "RangeClose", extraMod: 0 }, []);
      for (let i = 0; i < 100 && damageWindows().length === 0; i++) await sleep(100);
      Hooks.off("cyberpunk2020.weaponFired", tap);
      const cards = game.messages.filter(m => !before.includes(m.id)).map(m => m.id);
      if (landed > 0 && damageWindows().length === 1) return { cards, win: damageWindows()[0], landed };
    }
    return { cards: [], win: null, landed: 0 };
  };
  const appliedShot = await firePathA();
  const appliedFlaggedBefore = flaggedIds();
  const applyCtl = appliedShot.win?.element?.querySelector('[data-action="applyDamage"]') ?? null;
  applyCtl?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  for (let i = 0; i < 80 && damageWindows().length > 0; i++) await sleep(100);
  await sleep(800);
  const appliedFlaggedNew = flaggedIds().filter(id => !appliedFlaggedBefore.includes(id));
  ok("applied close: the window that applied its damage closed on its own control (precondition)",
    appliedShot.landed > 0 && !!applyCtl && damageWindows().length === 0,
    `${appliedShot.landed} landed, control ${!!applyCtl}, ${damageWindows().length} window(s)`);
  ok("applied close: no card is handed the payload afterwards — the shot is resolved (negative)",
    appliedFlaggedNew.length === 0 && appliedShot.cards.every(id => !game.messages.get(id)?.getFlag(SCOPE, "damagePayload")),
    `${appliedFlaggedNew.length} newly claimed card(s)`);

  // PATH B is untouched: its window came FROM a card that already carries the payload, so dismissing it
  // changes nothing — no second flag, no second control. Driven on the card the dismissal above restored.
  const restoredCard = shotCard();
  const bButton = cardEl()?.querySelector(".cp2020-apply-damage-btn") ?? null;
  bButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  for (let i = 0; i < 60 && damageWindows().length === 0; i++) await sleep(100);
  const bWin = damageWindows()[0] ?? null;
  const bFlaggedBefore = flaggedIds();
  bWin?.element?.querySelector('[data-action="cancelDialog"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  for (let i = 0; i < 60 && damageWindows().length > 0; i++) await sleep(100);
  await sleep(600);
  ok("card path: the card's own control opens a window and dismissing it closes it (precondition)",
    !!bButton && !!bWin && damageWindows().length === 0, `control ${!!bButton}, window ${!!bWin}`);
  ok("card path: its card keeps exactly one payload and one control — nothing is added (negative)",
    !!restoredCard?.getFlag(SCOPE, "damagePayload") && applyCt() === 1
    && flaggedIds().filter(id => !bFlaggedBefore.includes(id)).length === 0,
    `flag ${!!restoredCard?.getFlag(SCOPE, "damagePayload")}, ${applyCt()} control(s)`);

  /* -- 11a-ii-d. the remembered card outlives the queue that found it -- */
  // THE LIFETIME CLAIM, driven rather than reasoned about. The queue that hands a payload to a card is
  // deliberately SHORT — it waits for one card, which arrives within a round trip, and an entry that
  // outstays that is dropped so it cannot claim a later message (11a-i). The window, by contrast, can
  // stand open for as long as the reader likes. So the card REFERENCE cannot live in that queue: it is
  // held against the payload the open window itself is holding, and is therefore good for exactly as
  // long as the window is. Held open past the queue's whole span here, then dismissed.
  const heldShot = await firePathA();
  const heldFlaggedBefore = flaggedIds();
  const heldDecoy = await ChatMessage.create({ content: "__PW__FX unrelated line, late" });
  await sleep(dh.PENDING_PAYLOAD_TTL_MS + 1200);
  heldShot.win?.element?.querySelector('[data-action="cancelDialog"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  for (let i = 0; i < 60 && flaggedIds().length === heldFlaggedBefore.length; i++) await sleep(100);
  const heldNew = flaggedIds().filter(id => !heldFlaggedBefore.includes(id));
  ok("dismissal path: a window held open past the queue's whole span still knows its card",
    heldShot.landed > 0 && heldNew.length === 1 && heldShot.cards.includes(heldNew[0]),
    `${heldShot.landed} landed, claimed ${JSON.stringify(heldNew)} of the shot's ${JSON.stringify(heldShot.cards)} after ${dh.PENDING_PAYLOAD_TTL_MS + 1200}ms`);
  ok("dismissal path: and the line posted in that gap is not the one it takes (negative)",
    !heldDecoy.getFlag(SCOPE, "damagePayload"), `decoy claimed ${!!heldDecoy.getFlag(SCOPE, "damagePayload")}`);
  try { await heldDecoy.delete(); } catch (e) { /* already gone */ }

  /* -- 11a-ii-e. who may write it: the card's own author -- */
  // The window lives on the client that opened it, which is the client that authored the shot's card,
  // so the write is a user updating their own message. Asserted against the permission the write is
  // actually governed by, in BOTH directions, with a real non-GM user on the other side.
  for (const u of [...game.users].filter(u => u.name?.startsWith("__PW__FX"))) { try { await u.delete(); } catch (e) { /* gone */ } }
  const probePlayer = await User.create({ name: "__PW__FX Player", role: CONST.USER_ROLES.PLAYER });
  const theirCard = await ChatMessage.create({ content: "__PW__FX authored elsewhere", author: probePlayer.id });
  const mineCard  = await ChatMessage.create({ content: "__PW__FX authored here" });
  // ⚠ LET THE POSTED CARDS SETTLE BEFORE REMOVING THEM. Core animates a newly posted card into the
  // notification log and re-queries its element after that animation; a card deleted inside that window
  // leaves the re-query holding nothing and core throws — which the 0-console-errors leg then reports as
  // if it were ours. Nothing to do with this feature, but the probe cards must outlive the animation.
  await sleep(1000);
  const authoredOk = theirCard.author?.id === probePlayer.id;
  ok("write authority: a card's own author may update it — which is what the write asks for",
    authoredOk && theirCard.canUserModify(probePlayer, "update") === true,
    `authored by the probe user: ${authoredOk}, may update: ${theirCard.canUserModify(probePlayer, "update")}`);
  ok("write authority: the same non-GM user may NOT update a card authored elsewhere (negative)",
    mineCard.canUserModify(probePlayer, "update") === false,
    `may update someone else's: ${mineCard.canUserModify(probePlayer, "update")}`);
  out.writeAuthority = {
    theirs: theirCard.canUserModify(probePlayer, "update"),
    mine:   mineCard.canUserModify(probePlayer, "update"),
  };
  for (const m of [theirCard, mineCard]) { try { await m.delete(); } catch (e) { /* already gone */ } }
  try { await probePlayer.delete(); } catch (e) { /* already gone */ }

  await closeDamageWindows();
  // NEGATIVE: the base's own rule is untouched — a shot that does not go out emits nothing, so the
  // window stays open for correction. An empty magazine is the base system's own refusal path
  // (item.js __weaponRoll returns false before any roll), so this drives the real one.
  await pistolItem.update({ "system.shotsLeft": 0 });
  const refusedDlg = sheet._cpOpenWeaponAttackDialog(pistolItem);
  for (let i = 0; i < 80 && !refusedDlg?.rendered; i++) await sleep(50);
  refusedDlg.element.requestSubmit();
  await sleep(1800);
  ok("presentation window: a shot that never goes out leaves the window open for correction (negative)",
    refusedDlg.rendered === true, String(refusedDlg.rendered));
  try { await refusedDlg.close(); } catch (e) { /* already closed */ }
  await pistolItem.update({ "system.shotsLeft": 10 });
  [...game.user.targets].forEach(t => t.setTarget(false, { releaseOthers: false }));
  await sleep(200);
  await closeDamageWindows();
  await pistolItem.update({ "system.accuracy": 0 });   // the fixture is left as it was built
  try { await sheet.close(); } catch (e) { /* never opened */ }

  /* -- 11a-iii. face-the-target: the turn, live, and its lead-in ----------- */
  // The one document write the rail performs. Driven through the real fan-out so the gate, the write
  // and the arithmetic are all read at the call site rather than in isolation.
  const faceWas = game.settings.get(SCOPE, "faceTargetOnFire");
  await game.settings.set(SCOPE, "faceTargetOnFire", true);
  const shooterDoc = scene.tokens.get(tokenDoc.id);
  await shooterDoc.update({ rotation: 0 });      // aimed-at token is due EAST -> wants rotation 270
  await sleep(400);
  const rotMark = rotationWrites.length;
  const wantRotation = fx.faceTargetRotation(fx.centerOf(tokenDoc), fx.centerOf(targetDoc));
  const turnRes = await fx.fxWeaponFired(payload({
    shotsFired: 2, targetTokenId: targetDoc.id, areaDamages: { Torso: [{ damage: 2 }] },
  }));
  await sleep(900);
  ok("turn: the shooter is left facing what it fired at, by value",
    Math.abs(fx.rotationDeltaDeg(scene.tokens.get(tokenDoc.id).rotation, wantRotation)) < 0.5,
    `${scene.tokens.get(tokenDoc.id).rotation} vs wanted ${wantRotation}`);
  ok("turn: the fan-out reports the sweep it made, and it is the short way round",
    Number.isFinite(turnRes.turnedDeg) && Math.abs(turnRes.turnedDeg) <= 180 && Math.abs(turnRes.turnedDeg) > 0,
    `${turnRes.turnedDeg} degrees`);
  ok("turn: a two-round burst wrote the rotation ONCE, not once per round",
    rotationWrites.length - rotMark === 1, `${rotationWrites.length - rotMark} write(s)`);
  // Already facing: the dead zone must leave the token alone, or a burst would jitter it.
  const rotMark2 = rotationWrites.length;
  const againRes = await fx.fxWeaponFired(payload({
    shotsFired: 2, targetTokenId: targetDoc.id, areaDamages: { Torso: [{ damage: 2 }] },
  }));
  await sleep(700);
  ok("turn: a shot from a token already facing its target writes nothing at all (negative)",
    againRes.turnedDeg === null && rotationWrites.length - rotMark2 === 0,
    `${rotationWrites.length - rotMark2} write(s) / reported ${againRes.turnedDeg}`);
  // The LEAD-IN is inside the presentation span, so the apply window still lands after the turn.
  await shooterDoc.update({ rotation: 0 });
  await sleep(400);
  const spanWithTurn = fx.payloadPresentationMs(payload({ shotsFired: 2, targetTokenId: targetDoc.id }));
  const spanNoTurn = fx.presentationMs(2, "rifle");
  ok("turn: the presentation span includes the sweep when a sweep is going to happen",
    spanWithTurn === spanNoTurn + fx.FACE_TARGET.durationMs,
    `${spanWithTurn}ms with the lead-in vs ${spanNoTurn}ms without`);
  await fx.faceTarget(canvas.tokens.get(tokenDoc.id), fx.centerOf(targetDoc));
  await sleep(500);
  ok("turn: once it is already facing, the span drops the lead-in again (negative)",
    fx.payloadPresentationMs(payload({ shotsFired: 2, targetTokenId: targetDoc.id })) === spanNoTurn,
    String(fx.payloadPresentationMs(payload({ shotsFired: 2, targetTokenId: targetDoc.id }))));
  // CORE'S OWN "Lock Rotation" FLAG is the PER-TOKEN opt-out, alongside the table-wide setting. Core
  // draws a locked token's mesh upright whatever the rotation field holds, so a turn there would write
  // a heading nobody can see AND make the fan-out wait out a sweep with nothing on screen. Both halves
  // are asserted: nothing is written, and the span carries no lead-in for it.
  await game.settings.set(SCOPE, "faceTargetOnFire", true);
  await shooterDoc.update({ rotation: 0, lockRotation: true });
  await sleep(400);
  const lockMark = rotationWrites.length;
  const lockedTurn = fx.faceTargetTurn(canvas.tokens.get(tokenDoc.id), fx.centerOf(targetDoc));
  const lockedRes = await fx.fxWeaponFired(payload({
    shotsFired: 2, targetTokenId: targetDoc.id, areaDamages: { Torso: [{ damage: 2 }] },
  }));
  await sleep(700);
  ok("turn: a token core draws upright is reported as no-turn at the source (negative)",
    lockedTurn === null, JSON.stringify(lockedTurn));
  ok("turn: a locked token is not rotated and nothing is written for it (negative)",
    lockedRes.turnedDeg === null && rotationWrites.length - lockMark === 0
    && scene.tokens.get(tokenDoc.id).rotation === 0,
    `${rotationWrites.length - lockMark} write(s) at rotation ${scene.tokens.get(tokenDoc.id).rotation}`);
  ok("turn: and its span carries no lead-in — no dead pause for a sweep that never happens (negative)",
    fx.payloadPresentationMs(payload({ shotsFired: 2, targetTokenId: targetDoc.id })) === fx.presentationMs(2, "rifle"),
    `${fx.payloadPresentationMs(payload({ shotsFired: 2, targetTokenId: targetDoc.id }))}ms vs ${fx.presentationMs(2, "rifle")}ms without a lead-in`);
  await shooterDoc.update({ lockRotation: false });
  await sleep(300);

  // The setting is the gate, and it is read per shot.
  await game.settings.set(SCOPE, "faceTargetOnFire", false);
  await shooterDoc.update({ rotation: 0 });
  await sleep(400);
  const rotMark3 = rotationWrites.length;
  const faceOffRes = await fx.fxWeaponFired(payload({
    shotsFired: 2, targetTokenId: targetDoc.id, areaDamages: { Torso: [{ damage: 2 }] },
  }));
  await sleep(700);
  ok("turn: switched off, nothing turns and nothing is written (negative)",
    faceOffRes.turnedDeg === null && rotationWrites.length - rotMark3 === 0
    && scene.tokens.get(tokenDoc.id).rotation === 0,
    `${rotationWrites.length - rotMark3} write(s) at rotation ${scene.tokens.get(tokenDoc.id).rotation}`);
  ok("turn: and the span drops the lead-in with it (negative)",
    fx.payloadPresentationMs(payload({ shotsFired: 2, targetTokenId: targetDoc.id })) === spanNoTurn,
    String(fx.payloadPresentationMs(payload({ shotsFired: 2, targetTokenId: targetDoc.id }))));
  await game.settings.set(SCOPE, "faceTargetOnFire", faceWas);
  await drain();

  await closeDamageWindows();
  await game.settings.set(SCOPE, "damageAutoApply", autoApplyWas);

  /* ── 11b. the rail resolves its aim from the presentation field alone ──── */
  // The other half of the split: with the routing field empty (every single shot, burst and melee), the
  // sprite must still be pointed. Asserted by the rotation input the adapter hands the engine, on the
  // controlled surface from §9 so the value is readable — the same surface, re-installed and put back.
  const realSeq2 = globalThis.Sequence;
  globalThis.Sequence = FakeSequence;
  fx._setDbProbe(() => true);
  played.length = 0; playedEntries.length = 0;
  const fxOnly = await fx.fxWeaponFired(payload({
    shotsFired: 1, targetTokenId: null, fxTargetTokenId: targetDoc.id,
    areaDamages: { Torso: [{ damage: 3 }] },
  }));
  await sleep(400);
  const fxOnlyEntry = playedEntries.flat().find(e => !!e.rotateTowards);
  const fxAimPoint = fx.centerOf(targetDoc);
  ok("presentation field: a payload with only the aim field still draws a directional sprite",
    fxOnly.shots === 1 && !!fxOnlyEntry, `${JSON.stringify(fxOnly)} / ${playedEntries.flat().length} queued`);
  ok("presentation field: the rotation input is the aimed-at token's own centre",
    Math.round(Number(fxOnlyEntry?.rotateTowards?.x)) === Math.round(fxAimPoint.x)
    && Math.round(Number(fxOnlyEntry?.rotateTowards?.y)) === Math.round(fxAimPoint.y),
    `${JSON.stringify(fxOnlyEntry?.rotateTowards)} vs ${JSON.stringify(fxAimPoint)}`);
  played.length = 0; playedEntries.length = 0;
  const noAimAtAll = await fx.fxWeaponFired(payload({
    shotsFired: 1, targetTokenId: null, fxTargetTokenId: null, areaDamages: { Torso: [{ damage: 3 }] },
  }));
  await sleep(400);
  // INVERTED: neither field set no longer means nothing is drawn. The axis falls back to the
  // shooter's own facing, so the same directional sprite is drawn — pointed at the synthesized point.
  const bareSynth = fx.aimPointOf(canvas.tokens.get(tokenDoc.id), null, Number(canvas.dimensions.size));
  const bareEntry = playedEntries.flat().find(e => !!e.rotateTowards);
  ok("presentation field: neither field set -> the sprite is still drawn, on the synthesized axis",
    noAimAtAll.shots === 1 && !!bareEntry
    && Math.round(Number(bareEntry?.rotateTowards?.x)) === Math.round(bareSynth.x)
    && Math.round(Number(bareEntry?.rotateTowards?.y)) === Math.round(bareSynth.y),
    `${playedEntries.flat().length} queued / ${JSON.stringify(bareEntry?.rotateTowards ?? null)} vs ${JSON.stringify(bareSynth)}`);
  globalThis.Sequence = realSeq2;
  fx._setDbProbe(null);
  await drain();
  // The host's fire cards do not all carry a speaker, so the shared teardown below cannot find them by
  // actor — this section removes exactly the cards it posted.
  for (const m of game.messages.filter(m => !sectionMsgMark.includes(m.id))) { try { await m.delete(); } catch (e) { /* already gone */ } }

  /* -- 11c. the smoke stays WITH THE SHOOTER, read off the live engine ------- */
  // Placed at the END deliberately: it fires a real burst, and the sections above measure sprite sizes,
  // audio counts and a quiet lighting collection. Running a live burst in the middle of them polluted
  // every one of those readings when this leg was first written further up.
  // ⚠ THIS LEG EXISTS BECAUSE THE PLANNER LEGS WERE NOT ENOUGH. They asserted the drift the planner
  // COMPUTES, and they passed while the shipped puffs were flying to the target token — because the
  // engine moves an effect to `data.target`, and `rotateTowards(aim)` was setting that, so the planned
  // destination was never used. Measured before the fix: 6-9 squares from the shooter on a 9-square
  // shot line. Only a reading of where the sprites ACTUALLY are could catch that, so this takes one.
  // ⏪⏪ SUPERSEDED (FR#22): the three drift legs here fired a RIFLE BURST and measured where its stream
  // of puffs ended up. That burst draws no puffs of ours any more, so the legs measured an empty canvas
  // and said so. The claim they existed for — that a drawn puff stays with the shooter instead of
  // flying to the target, which is a real defect this file caught once — is not lost: it is asserted on
  // the only emission left, the shell's single discharge, in the section immediately below (and the
  // planner's own worst case is swept 400 rolls deep further up). Deleted rather than re-pointed
  // because that section already samples the same thing the same way.

  /* -- 11c-ii. THE REPORTED CASE: one shell discharge actually puts smoke on the canvas -- */
  // "I don't see it at all for shotguns." The planner legs above say the row now asks for a puff on a
  // single discharge; this one reads whether one is really THERE, on the canvas, for the gesture the
  // table actually makes — a single shell round. Same sampler as the drift legs, and the same
  // discarded-first-sightings rule, for the same reason.
  globalThis.Sequencer?.EffectManager?.endAllEffects?.();
  await sleep(1200);
  const shellFirstSeen = new Map();
  const shellSeen = new Map();
  const shellIv = setInterval(() => {
    const sc = fx.centerOf(canvas.tokens.get(tokenDoc.id));
    const grid = Number(canvas.dimensions.size) || 100;
    const now = performance.now();
    for (const e of (globalThis.Sequencer?.EffectManager?.effects ?? [])) {
      if (!/SmokePuffSide/.test(String(e.data?.file ?? "")) || !e.position) continue;
      if (e.position.x === 0 && e.position.y === 0) continue;
      if (!shellFirstSeen.has(e.id)) { shellFirstSeen.set(e.id, now); continue; }
      if (now - shellFirstSeen.get(e.id) < 150) continue;
      const prev = shellSeen.get(e.id) ?? { dist: 0, alpha: 0 };
      prev.dist = Math.max(prev.dist, Math.hypot(e.position.x - sc.x, e.position.y - sc.y) / grid);
      prev.alpha = Math.max(prev.alpha, Number(e.sprite?.worldAlpha ?? 0));
      shellSeen.set(e.id, prev);
    }
  }, 16);
  const shellOne = await fx.fxWeaponFired({ attackerId: actor.id, weaponId: madeIds.shotgun,
    weaponName: "__PW__FX shotgun", shotsFired: 1, targetTokenId: targetDoc.id,
    areaDamages: { Torso: [{ damage: 4 }] } });
  await sleep(2400);
  clearInterval(shellIv);
  const shellPuffs = [...shellSeen.values()];
  ok("shell smoke: one discharge reports a puff AND one is really drawn on the canvas",
    shellOne.smokePuffs === 1 && shellPuffs.length === 1,
    `reported ${shellOne.smokePuffs}, observed ${shellPuffs.length}`);
  ok("shell smoke: the drawn puff is visible — it carries a real alpha, not a transparent one",
    shellPuffs.length > 0 && shellPuffs[0].alpha > 0,
    `alpha ${shellPuffs[0]?.alpha ?? "none"} (spec opacity ${fx.MUZZLE_SMOKE.opacity})`);
  ok("shell smoke: and it stays with the shooter, inside the cap the spec names",
    shellPuffs.length > 0 && shellPuffs[0].dist <= fx.MUZZLE_SMOKE.driftMaxSquares + 0.1,
    `${shellPuffs[0]?.dist?.toFixed(2)} squares out, cap ${fx.MUZZLE_SMOKE.driftMaxSquares}`);
  await sleep(600);

  /* -- 11c-iii. THE SHELL DRAWS A LANCE AGAIN, and the discharge column is GONE -- */
  // ⏪⏪⏪ INVERTED BACK (2026-08-09, user ruling: "just replace the control with Shotgun blast muzzle
  // 01. Randomize between 01 and 02 on each shot."). FR#22's legs asserted the shell's lance was
  // queued and drawn; the FR#22 ruling then inverted them to assert its ABSENCE, because the discharge
  // column sat over it. The column has now been DELETED outright and the lance is back, so these legs
  // read like the originals — with one addition the first version never had: the key's own two files.
  globalThis.Sequencer?.EffectManager?.endAllEffects?.();
  await sleep(1100);
  const lanceSeen = { shell: 0, rifle: 0 };
  const lanceIv = setInterval(() => {
    for (const e of (globalThis.Sequencer?.EffectManager?.effects ?? [])) {
      if (!/muzzle_flash|MuzzleFlash/i.test(String(e.data?.file ?? ""))) continue;
      lanceSeen[globalThis.__pwLanceLabel] = Math.max(lanceSeen[globalThis.__pwLanceLabel], 1);
    }
  }, 8);
  globalThis.__pwLanceLabel = "shell";
  const shellHasLance = await fx.fxWeaponFired({ attackerId: actor.id, weaponId: madeIds.shotgun,
    weaponName: "__PW__FX shotgun", shotsFired: 1, targetTokenId: targetDoc.id,
    areaDamages: { Torso: [{ damage: 4 }] } });
  await sleep(2200);
  globalThis.__pwLanceLabel = "rifle";
  const rifleHasLance = await fx.fxWeaponFired({ attackerId: actor.id, weaponId: madeIds.rifle,
    weaponName: "__PW__FX rifle", shotsFired: 1, targetTokenId: targetDoc.id,
    areaDamages: { Torso: [{ damage: 4 }] } });
  await sleep(2200);
  clearInterval(lanceIv);
  delete globalThis.__pwLanceLabel;
  ok("shell lance: the row names the same lance key every other class names, and it resolves",
    fx.FX_CLASSES.shotgun.muzzle === "jb2a.muzzle_flash.single.01.yellow"
    && fx.fxDbEntryExists(fx.FX_CLASSES.shotgun.muzzle) === true,
    `${fx.FX_CLASSES.shotgun.muzzle}`);
  // ⭐ THE 01/02 RANDOMISATION IS THE KEY'S OWN, and this is the leg that says so by value: the ruling
  // asked for two files alternating and the database already delivers exactly that under one key. A
  // build that hand-rolled a second key and alternated it would pass every other leg here.
  const lanceFiles = (() => {
    try { return globalThis.Sequencer.Database.getAllFileEntries(fx.FX_CLASSES.shotgun.muzzle).flat(); }
    catch (_e) { return []; }
  })();
  ok("shell lance: that ONE key holds both files 01 and 02, so the engine picks per play",
    lanceFiles.length === 2 && lanceFiles.some(f => /Single01_01_/.test(f)) && lanceFiles.some(f => /Single01_02_/.test(f)),
    lanceFiles.map(f => String(f).split("/").pop()).join(" + "));
  ok("shell lance: a discharge claims one, and its pellet fan with it",
    (await fx.fxShot(canvas.tokens.get(tokenDoc.id), canvas.tokens.get(targetDoc.id),
      { weaponClass: "shotgun", hit: true, light: false })).muzzle === true,
    "muzzle true on a shell discharge");
  await sleep(1400);
  ok("shell lance: one reaches the canvas for a live shell discharge",
    lanceSeen.shell === 1 && shellHasLance.flashes === 1, `${lanceSeen.shell} lance sprite(s) for the shell`);
  ok("shell lance: the control is unchanged — the rifle still draws its own",
    lanceSeen.rifle === 1 && rifleHasLance.flashes === 1,
    `rifle ${lanceSeen.rifle} lance(s) vs shell ${lanceSeen.shell}`);
  // ⭐ THE SIZE LADDER, by value. The number is a DRAWN WIDTH in grid units, so the ladder across the
  // table is the read: the shell has to sit above the rifle (heavier bore, an expanding blast) and
  // under the 20mm. Measured on this rig at grid 100: 110 / 120 / 160 / 190 / 210 px.
  ok("shell lance: every class names its own lance and size, and the shell sits between rifle and heavy",
    ["pistol", "smg", "rifle", "shotgun", "heavy"].every(c => fx.FX_CLASSES[c].muzzle === "jb2a.muzzle_flash.single.01.yellow"
      && fx.FX_CLASSES[c].muzzleSquares > 0)
    && fx.FX_CLASSES.shotgun.muzzleSquares === 1.9
    && fx.FX_CLASSES.rifle.muzzleSquares < fx.FX_CLASSES.shotgun.muzzleSquares
    && fx.FX_CLASSES.shotgun.muzzleSquares < fx.FX_CLASSES.heavy.muzzleSquares,
    ["pistol", "smg", "rifle", "shotgun", "heavy"].map(c => `${c}:${fx.FX_CLASSES[c].muzzleSquares}`).join(" "));
  await drain();

  /* -- 11c-iii-b. THE DISCHARGE COLUMN IS DELETED — asserted as ABSENCE -- */
  // ⏪⏪⏪ 2026-08-09. Nineteen legs stood here and every one of them described a mechanism that no
  // longer exists: a stretched `bullet.02` at 1.25 squares, trimmed to 55ms of clip, dwelt over 220ms
  // by a derived rate of 0.25, tinted through its own `columnColor` field, and counted as its own term
  // in the tail. The four-report chain that produced it (FR#22 add, FR#23 shorten, FR#25 trim, FR#25
  // dwell) ended in a user ruling that replaced the whole element with the ordinary lance.
  //
  // What replaces those legs is the shape this file uses whenever a mechanism is deleted rather than
  // retuned: assert that NOTHING of it survives. A deletion that leaves half its machinery behind is
  // the failure mode — a dead constant, a mask entry, a row field an overlay can still reach — and each
  // of those is one line away from becoming live again by accident.
  ok("column deletion: every constant and helper the mechanism owned is gone from the module",
    fx.COLUMN_SQUARES === undefined && fx.COLUMN_TRIM_MS === undefined
    && fx.COLUMN_DWELL_MS === undefined && fx.columnRateFor === undefined,
    JSON.stringify({ squares: fx.COLUMN_SQUARES ?? null, trim: fx.COLUMN_TRIM_MS ?? null,
      dwell: fx.COLUMN_DWELL_MS ?? null, rate: typeof fx.columnRateFor }));
  ok("column deletion: no class row carries a `column` or a `columnColor` field (negative)",
    Object.keys(fx.FX_CLASSES).every(c => !("column" in fx.FX_CLASSES[c]) && !("columnColor" in fx.FX_CLASSES[c])),
    Object.keys(fx.FX_CLASSES).map(c => `${c}:${"column" in fx.FX_CLASSES[c]}`).join(" "));
  ok("column deletion: no ammo overlay carries a `columnColor` — the five rows that did are clean",
    Object.entries(fx.AMMO_FX).every(([, o]) => o.columnColor === undefined && o.column === undefined),
    Object.entries(fx.AMMO_FX).filter(([, o]) => o.columnColor !== undefined).map(([k]) => k).join(",") || "none");
  ok("column deletion: neither merge mask still names it, so nothing can be masked into existence",
    !fx.AMMO_FX_RECOLOR_FIELDS.includes("columnColor") && !fx.AMMO_FX_REPLACE_FIELDS.includes("column")
    && fx.AMMO_FX_RECOLOR_FIELDS.length === 1 && fx.AMMO_FX_REPLACE_FIELDS.length === 1,
    `recolour [${fx.AMMO_FX_RECOLOR_FIELDS}] replace [${fx.AMMO_FX_REPLACE_FIELDS}]`);
  ok("column deletion: a shell discharge reports no column, on the draw verb's own return (negative)",
    (await fx.fxShot(canvas.tokens.get(tokenDoc.id), canvas.tokens.get(targetDoc.id),
      { weaponClass: "shotgun", hit: true, light: false })).column === undefined,
    "column absent from the fxShot report");
  await sleep(1200);
  // ⭐ AND DRIVEN: a live shell discharge must put NO second bullet family on the canvas. The column
  // was `bullet.02` while the pellets are `bullet.01`, so its presence is decidable by file rather
  // than by size — which is the assertion the old legs could not make, because both were present.
  globalThis.Sequencer?.EffectManager?.endAllEffects?.();
  await sleep(1000);
  const colFiles = new Set();
  const colIv = setInterval(() => {
    for (const e of (globalThis.Sequencer?.EffectManager?.effects ?? [])) {
      const f = String(e.data?.file ?? "");
      // ⚠ THIS READS A DATABASE KEY, NOT A FILE PATH — the documented trap. `e.data.file` on a live
      // effect is what the section was HANDED (`jb2a.bullet.01.orange`), so the discriminator has to be
      // the key's own shape. A leg matching `Bullet_01` on a filename matches nothing here.
      if (/bullet\.0\d/i.test(f)) colFiles.add(f);
    }
  }, 8);
  await fx.fxWeaponFired({ attackerId: actor.id, weaponId: madeIds.shotgun, weaponName: "__PW__FX shotgun",
    shotsFired: 1, targetTokenId: targetDoc.id, areaDamages: { Torso: [{ damage: 4 }] } });
  await sleep(2200);
  clearInterval(colIv);
  ok("column deletion: a live shell discharge draws ONE bullet family — its pellets — and no second one",
    colFiles.size > 0 && [...colFiles].every(f => /bullet\.01/i.test(f))
    && [...colFiles].every(f => !/bullet\.02/i.test(f)),
    [...colFiles].join(" ") || "none caught");
  ok("column deletion: the shell's tail no longer takes a column term, and reads as the pellet chain alone",
    fx.presentationTailMs("shotgun") === fx.FX_CLASSES.shotgun.dashMs + fx.HIT_CONFIRM.clipMs
    && fx.presentationTailMs("shotgun") === 983,
    `shell tail ${fx.presentationTailMs("shotgun")}ms`);
  // ⭐ THE RULING THAT OUTLIVED THE MECHANISM. `tracerColor: null` was added for the column era so an
  // overlay's shift would reach the pellets as well as the column. The column is gone; the declaration
  // is not, because it was never about the column — it is about the mask.
  ok("column deletion: the shell's fan is STILL declared repaintable-but-unpainted (the ruling survives)",
    "tracerColor" in fx.FX_CLASSES.shotgun && fx.FX_CLASSES.shotgun.tracerColor === null
    && fx.ammoFxEntry("shotgun", "api").tracerColor === fx.TRACER_COLOR_INCENDIARY,
    `declared ${"tracerColor" in fx.FX_CLASSES.shotgun}, painted ${JSON.stringify(fx.FX_CLASSES.shotgun.tracerColor)}`);
  await drain();

  /* -- 11c-iii-c. THE BUCKSHOT VOLLEY — the trial, driven -- */
  // ⚠ ON TRIAL, not adopted. These legs pin what the trial SHIPS so the user's ruling lands on a known
  // object, and so that the revert is one constant: with VOLLEY.enabled false every one of them falls
  // back to the dash-fan legs above rather than to a second code path.
  ok("volley: the trial is armed, and its key resolves on the installed free tier",
    fx.VOLLEY.enabled === true && fx.fxDbEntryExists(fx.VOLLEY.key) === true
    && /volley_of_projectiles_Line\.bullet\.001\.001/.test(fx.VOLLEY.key),
    fx.VOLLEY.key);
  // ⭐ THE BAND MIRROR, against the ENGINE'S OWN PICKER rather than against our own table. This is the
  // leg that matters most: the whole tail arithmetic is derived from which file the engine will serve,
  // and a mirror that drifts from the engine is silent.
  const volEntry = globalThis.Sequencer.Database.getEntry(fx.VOLLEY.key);
  const gpx = Number(canvas.dimensions.size) || 100;
  const bandRows = [2, 4.9, 5, 6, 8.9, 9, 12, 14.9, 15, 20].map((d) => {
    const served = String(volEntry?.getFileForDistance?.(d * gpx) ?? "").match(/_(\d+ft)_/)?.[1] ?? "?";
    return { d, served, ours: fx.volleyBandFor(d) };
  });
  ok("volley: our band picker agrees with the engine's own at every boundary — 5, 9 and 15 squares",
    bandRows.every(r => r.served === r.ours),
    bandRows.map(r => `${r.d}:${r.ours}${r.served === r.ours ? "" : `!=${r.served}`}`).join(" "));
  ok("volley: the boundaries are the mirrored ones and nothing else",
    fx.volleyBandFor(4.9) === "15ft" && fx.volleyBandFor(5) === "30ft"
    && fx.volleyBandFor(8.9) === "30ft" && fx.volleyBandFor(9) === "60ft"
    && fx.volleyBandFor(14.9) === "60ft" && fx.volleyBandFor(15) === "90ft",
    fx.VOLLEY_BANDS.map(b => `${b.band}>=${b.minSquares}`).join(" "));
  // ⭐ THE TAIL, BY VALUE AT THREE DISTANCES — the whole reason the band is resolved at all. The
  // numbers are the decoded content ends, and each one is a different file.
  ok("volley: the tail is BAND-DERIVED, so a longer shot holds the window longer — by value",
    fx.presentationTailMs("shotgun", "standard", fx.volleySpecFor(2)) === 600
    && fx.presentationTailMs("shotgun", "standard", fx.volleySpecFor(6)) === 800
    && fx.presentationTailMs("shotgun", "standard", fx.volleySpecFor(12)) === 1200
    && fx.presentationTailMs("shotgun", "standard", fx.volleySpecFor(20)) === 1600,
    [2, 6, 12, 20].map(d => `${d}sq:${fx.presentationTailMs("shotgun", "standard", fx.volleySpecFor(d))}`).join(" "));
  ok("volley: a fixed guess would open the window early on a long shot — the 90ft tail beats the shell's own",
    fx.volleySpecFor(20).tailMs > fx.presentationTailMs("shotgun")
    && fx.volleySpecFor(2).crossMs < fx.volleySpecFor(20).crossMs,
    `90ft tail ${fx.volleySpecFor(20).tailMs}ms vs shell tail ${fx.presentationTailMs("shotgun")}ms`);
  ok("volley: the crossing and the tail are two different numbers per band, and the tail is the later",
    ["15ft", "30ft", "60ft", "90ft"].every(b => fx.VOLLEY.tailMs[b] > fx.VOLLEY.crossMs[b]),
    ["15ft", "30ft", "60ft", "90ft"].map(b => `${b}:${fx.VOLLEY.crossMs[b]}/${fx.VOLLEY.tailMs[b]}`).join(" "));
  // ⭐ THE CHAOS, as pure values: deterministic, per-round, and both knobs actually moving.
  const chaosA = fx.volleyChaosFor(1234), chaosB = fx.volleyChaosFor(1234);
  ok("volley chaos: it is a function of the seed alone, so two clients compute the same discharge",
    chaosA.mirrorY === chaosB.mirrorY && chaosA.jitterDeg === chaosB.jitterDeg,
    JSON.stringify(chaosA));
  const chaosSpread = Array.from({ length: 40 }, (_v, i) => fx.volleyChaosFor(fx.fxSeedOf("a", "w", 3, 3, i)));
  ok("volley chaos: the mirror really flips and the jitter really varies across discharges",
    chaosSpread.some(c => c.mirrorY) && chaosSpread.some(c => !c.mirrorY)
    && new Set(chaosSpread.map(c => c.jitterDeg)).size > 30,
    `${chaosSpread.filter(c => c.mirrorY).length}/40 mirrored, ${new Set(chaosSpread.map(c => c.jitterDeg)).size} distinct angles`);
  ok("volley chaos: every jitter stays inside the few degrees the spec names",
    chaosSpread.every(c => Math.abs(c.jitterDeg) <= fx.VOLLEY.jitterDeg), `±${fx.VOLLEY.jitterDeg}°`);
  ok("volley chaos: consecutive rounds of ONE burst differ — the seed folds in the round index",
    JSON.stringify(fx.volleyChaosFor(fx.fxSeedOf("a", "w", 3, 3, 0)))
      !== JSON.stringify(fx.volleyChaosFor(fx.fxSeedOf("a", "w", 3, 3, 1))),
    "round 0 vs round 1");
  // ⭐ THE JITTER PRESERVES THE DISTANCE, which is what keeps the band out of its reach.
  const jFrom = { x: 0, y: 0 }, jTo = { x: 500, y: 0 };
  const jRot = fx.rotateAbout(jFrom, jTo, 5);
  ok("volley chaos: the jitter ROTATES about the shooter, so the shot's own length is untouched",
    Math.abs(Math.hypot(jRot.x, jRot.y) - 500) < 1e-6 && Math.abs(jRot.y) > 1,
    `${Math.hypot(jRot.x, jRot.y).toFixed(3)}px, off-axis ${jRot.y.toFixed(1)}px`);
  // ⭐ WHICH SHOTS GET IT — buckshot alone, asked of the cartridge.
  ok("volley: buckshot claims it and the two shell loads with pictures of their own do not (negative)",
    fx.volleyOwns({ caliber: "00" }) === true
    && fx.volleyOwns({ caliber: "00", modifier: "slug", spreadMode: "slug" }) === false
    && fx.volleyOwns({ caliber: "00", modifier: "flechette", spreadMode: "flechette" }) === false
    && fx.volleyOwns({ caliber: "5.56" }) === false && fx.volleyOwns({}) === false,
    "buck yes; slug/flechette/rifle/blank no");
  // ⚠ AND IT MUST NOT FOLLOW THE PATTERN'S WORLD SWITCH — a table that switched the damage pattern off
  // has not asked for a different-looking gun. Driven with the setting really off.
  {
    const wasOn = game.settings.get(SCOPE, "shotgunSpreadEnabled");
    try {
      await game.settings.set(SCOPE, "shotgunSpreadEnabled", false);
      ok("volley: the pattern's world switch does NOT repaint the gun — the picture is the cartridge's",
        fx.volleyOwns({ caliber: "00" }) === true && fx.patternFlowOwns({ caliber: "00" }) === false,
        "switch off: volley still owns, pattern does not");
    } finally { await game.settings.set(SCOPE, "shotgunSpreadEnabled", wasOn); }
  }
  // ⭐ DRIVEN: the volley replaces the fan and suppresses our hit mark, and the other two shell loads
  // are untouched by all of it.
  globalThis.Sequencer?.EffectManager?.endAllEffects?.();
  await sleep(900);
  const volShot = await fx.fxShot(canvas.tokens.get(tokenDoc.id), canvas.tokens.get(targetDoc.id),
    { weaponClass: "shotgun", hit: true, light: false, ammoKey: "standard", volley: fx.volleySpecFor(5), shotSeed: 42 });
  await sleep(1200);
  ok("volley: a buckshot discharge draws the volley INSTEAD of the fan, and no pellets with it",
    volShot.volley === true && volShot.tracer === true && volShot.pellets === 0
    && volShot.volleyBand === "30ft",
    JSON.stringify({ volley: volShot.volley, pellets: volShot.pellets, band: volShot.volleyBand }));
  ok("volley: our own hit-confirmation mark is SUPPRESSED — the asset's baked arrival is the only one",
    volShot.impact === false && volShot.impactKey === undefined,
    JSON.stringify({ impact: volShot.impact }));
  ok("volley: it carries this round's own chaos, reported so the picture is readable by value",
    typeof volShot.volleyChaos?.mirrorY === "boolean" && Number.isFinite(volShot.volleyChaos?.jitterDeg),
    JSON.stringify(volShot.volleyChaos));
  const noVolShot = await fx.fxShot(canvas.tokens.get(tokenDoc.id), canvas.tokens.get(targetDoc.id),
    { weaponClass: "shotgun", hit: true, light: false, ammoKey: "standard" });
  await sleep(1200);
  ok("volley: without it the shell draws its six-dash fan and its hit mark exactly as before (the revert shape)",
    noVolShot.volley === false && noVolShot.pellets === fx.FX_CLASSES.shotgun.pellets
    && noVolShot.impact === true,
    JSON.stringify({ pellets: noVolShot.pellets, impact: noVolShot.impact }));
  ok("volley: the fan and the volley are never both drawn — one shot, one picture",
    (volShot.volley === true) !== (noVolShot.volley === true) && volShot.pellets === 0
    && noVolShot.pellets > 0, "exclusive by value");
  await drain();

  /* -- 11c-iv. the lance dwell: live again, on the one row it was ruled for -- */
  // ⏪⏪⏪ RESTORED (2026-08-09). FR#21 ruled a 220ms dwell for the class that fires ONE round per
  // trigger pull; FR#22 removed that class's lance and these legs became "nothing names a dwell"; the
  // deleted column then grew a private copy of the same trim-and-dwell pair. With the column gone the
  // dwell is back where it started, and the point of these legs is that there is now exactly ONE
  // mechanism doing it.
  ok("lance dwell: the shell names one, and it is the value FR#21 ruled",
    fx.FX_CLASSES.shotgun.muzzleMs === 220 && fx.muzzleDwellMs("shotgun") === 220,
    `${fx.muzzleDwellMs("shotgun")}ms`);
  ok("lance dwell: it is delivered as a RATE over the same trimmed range, never as a longer range",
    fx.muzzleRateFor("shotgun") === Number((fx.MUZZLE_SPRITE.endMs / 220).toFixed(4))
    && fx.muzzleRateFor("shotgun") === 0.5 && fx.muzzleRateFor("shotgun") < 1,
    `trim ${fx.MUZZLE_SPRITE.endMs}ms over ${fx.muzzleDwellMs("shotgun")}ms = rate ${fx.muzzleRateFor("shotgun")}`);
  ok("lance dwell: no OTHER row names one, so the other four still play at rate exactly 1 (negative)",
    ["pistol", "smg", "rifle", "heavy"].every(c => fx.FX_CLASSES[c].muzzleMs === undefined
      && fx.muzzleDwellMs(c) === fx.MUZZLE_SPRITE.endMs && fx.muzzleRateFor(c) === 1),
    ["pistol", "smg", "rifle", "heavy"].map(c => `${c}:${fx.muzzleRateFor(c)}`).join(" "));
  ok("lance dwell: the default is still the trim itself, for a class that names nothing",
    fx.muzzleDwellMs("__nonexistent__") === fx.MUZZLE_SPRITE.endMs
    && fx.MUZZLE_DWELL_DEFAULT_MS === fx.MUZZLE_SPRITE.endMs,
    `default ${fx.MUZZLE_DWELL_DEFAULT_MS}ms`);
  ok("lance dwell: every class's stretched lance is covered by its own settle tail",
    Object.keys(fx.FX_CLASSES).every(c => fx.presentationTailMs(c) >= fx.muzzleDwellMs(c)),
    `tails ${Object.keys(fx.FX_CLASSES).map(c => `${c}:${fx.presentationTailMs(c)}`).join(" ")}`);
  // THE TAIL, RECOMPUTED FOR A SHELL WITH NO COLUMN. The shell now runs one chain like every other
  // class — its pellets' crossing plus their impact — and the dwell sits far under it. Asserted as the
  // arithmetic rather than as today's number, plus the number, so a change to either is caught here.
  ok("shell tail: it is the pellet-and-impact chain alone, and the lance dwell sits under it",
    fx.presentationTailMs("shotgun") === fx.FX_CLASSES.shotgun.dashMs + fx.HIT_CONFIRM.clipMs
    && fx.muzzleDwellMs("shotgun") < fx.presentationTailMs("shotgun")
    && fx.presentationTailMs("shotgun") === 983,
    `tail ${fx.presentationTailMs("shotgun")}ms vs dwell ${fx.muzzleDwellMs("shotgun")}ms`);
  ok("shell tail: no class takes a column term any more, because no class has a column (negative)",
    fx.presentationTailMs("rifle") === Math.max(fx.TRACER_CLIP_MS, fx.HIT_CONFIRM.clipMs)
    && Object.keys(fx.FX_CLASSES).every(c => !("column" in fx.FX_CLASSES[c])),
    `rifle tail ${fx.presentationTailMs("rifle")}ms`);
  await drain();

  /* -- 11d. a fumble the table ruled on draws nothing at all -- */
  // "If the shotgun didn't fire, it shouldn't blast visibly." Driven on a REAL fumbled fire, because
  // the whole question is what the base hands the rail — the payload is not hand-built here, only the
  // die is forced.
  //
  // ⚠ THE DIE FORCE IS INVERTED, and it cost a probe to learn: this core maps the uniform to a face
  // the other way round, so 0.9999 is the natural 1 and 0.0001 is a 10 — which, on the base's own
  // `1d10x10` attack die, explodes until the recursion guard throws. It is applied to the ATTACK ROLL
  // ONLY (the one method, restored straight after) so the damage and location dice stay on the real
  // generator.
  const fumbleWas = game.settings.get("cyberpunk2020", "fumbleTableEnabled");
  if (!fumbleWas) await game.settings.set("cyberpunk2020", "fumbleTableEnabled", true);
  const shellItem = actor.items.get(madeIds.shotgun);
  const ourAudio = [];
  const realAudioPlay = foundry.audio.AudioHelper.play;
  foundry.audio.AudioHelper.play = function (...a) {
    const src = String(a[0]?.src ?? "");
    if (src.includes(`modules/${SCOPE}/sounds/`)) ourAudio.push(src);
    return realAudioPlay.apply(this, a);
  };
  const fumblePayloads = [];
  const fumbleHook = Hooks.on("cyberpunk2020.weaponFired", (p) => fumblePayloads.push(p));
  // What the base put ON THE CARD, captured at the render the seam reads — this is the evidence for the
  // claim that the round count could not have told a fumble apart from an ordinary miss.
  let fumbleCard = null;
  const realRenderTemplate = globalThis.renderTemplate;
  globalThis.renderTemplate = async function (path, data, ...rest) {
    if (/multi-hit\.hbs$/.test(String(path))) {
      fumbleCard = { fired: data?.fired, hits: data?.hits, hasFumbleBlock: !!data?.fumble };
    }
    return realRenderTemplate.call(this, path, data, ...rest);
  };
  const realAttackRoll = shellItem.attackRoll.bind(shellItem);
  shellItem.attackRoll = async function (mods) {
    const realUniform = CONFIG.Dice.randomUniform;
    CONFIG.Dice.randomUniform = () => 0.9999;
    try { return await realAttackRoll(mods); } finally { CONFIG.Dice.randomUniform = realUniform; }
  };
  const fumbleMsgMark = game.messages.map(m => m.id);
  globalThis.Sequencer?.EffectManager?.endAllEffects?.();
  await sleep(1000);
  const effectsBefore = (globalThis.Sequencer?.EffectManager?.effects ?? []).length;
  ourAudio.length = 0;
  await shellItem.update({ "system.shotsLeft": 10 });
  await shellItem.__weaponRoll({ fireMode: "SemiAuto", range: "RangeClose", extraMod: 0 }, [])
    .catch((e) => { fumblePayloads.push({ err: String(e?.message ?? e) }); });
  await sleep(2200);
  delete shellItem.attackRoll;
  globalThis.renderTemplate = realRenderTemplate;
  const liveEffectsAfter = (globalThis.Sequencer?.EffectManager?.effects ?? []).length;
  const fumbleAudioOnFire = [...ourAudio];
  Hooks.off("cyberpunk2020.weaponFired", fumbleHook);
  const fp = fumblePayloads.find(p => p && !p.err) ?? null;

  ok("fumble: the forced roll really produced a ruled fumble on a live fire (precondition)",
    fp?.fumble === true && fumbleCard?.hasFumbleBlock === true,
    `natural 1 ${fp?.fumble}, card carried the ruling ${fumbleCard?.hasFumbleBlock}`);
  // THE REASON A COUNT COULD NOT DO THIS. The base computes its round count before it consults the
  // ruling, so a fumble arrives looking exactly like an ordinary miss.
  ok("fumble: the card still reports a round fired and no hit — a count cannot tell it from a miss",
    fumbleCard?.fired === 1 && fumbleCard?.hits === 0 && fx.shotCountOf(fp ?? {}) === 1,
    `card fired ${fumbleCard?.fired} / hits ${fumbleCard?.hits}, rail would read ${fx.shotCountOf(fp ?? {})} round(s)`);
  ok("fumble: so the ruling itself rides on the payload, as its own field",
    fp?.fumbleRuled === true, `fumbleRuled ${fp?.fumbleRuled}`);
  // THE OUTCOME, off the WIRED rail rather than a direct call: nothing was drawn and nothing sounded
  // for the shot that never went down-range.
  ok("fumble: the live rail drew nothing for it — no sprite reached the canvas (negative)",
    liveEffectsAfter <= effectsBefore, `${effectsBefore} effects before, ${liveEffectsAfter} after`);
  ok("fumble: and it made no sound either — the report goes with the visuals (negative)",
    fumbleAudioOnFire.length === 0, `${fumbleAudioOnFire.length} shot sound(s): ${fumbleAudioOnFire.join(",")}`);
  // BY VALUE, from the fan-out's own report, on the very payload the fire produced.
  const fumbleRes = await fx.fxWeaponFired(fp ?? {});
  await sleep(400);
  ok("fumble: the fan-out reports the reason by name, and every count is zero",
    fumbleRes.skipped === "fumble" && fumbleRes.shots === 0 && fumbleRes.flashes === 0
    && fumbleRes.smokePuffs === 0 && fumbleRes.motes === 0,
    JSON.stringify(fumbleRes));
  ok("fumble: it still names the class it recognised — the shot is suppressed, not unrecognised",
    fumbleRes.weaponClass === "shotgun", String(fumbleRes.weaponClass));
  ok("fumble: there is no presentation to wait out for it either",
    fx.payloadPresentationMs(fp ?? {}) === 0, `${fx.payloadPresentationMs(fp ?? {})}ms`);
  // THE NEGATIVE THAT MAKES THE GATE HONEST: the same payload WITHOUT the base's ruling is an ordinary
  // bad roll — with the fumble table switched off a natural 1 means the weapon fired and missed — and
  // it must still be drawn in full. The natural-1 field is left set, so this also proves the gate is
  // the ruling and not the die.
  ourAudio.length = 0;
  await drain();
  const notRuled = { ...(fp ?? {}) };
  delete notRuled.fumbleRuled;
  const notRuledRes = await fx.fxWeaponFired(notRuled);
  await sleep(700);
  ok("fumble: a natural 1 the table did NOT rule on still fires in full — die vs ruling (negative)",
    notRuled.fumble === true && notRuledRes.skipped === null
    && notRuledRes.shots === 1 && notRuledRes.flashes === 1,
    JSON.stringify(notRuledRes));
  ok("fumble: and that one does sound, so the silence above belongs to the ruling (negative)",
    ourAudio.length === 1, `${ourAudio.length} shot sound(s)`);
  ok("fumble: its presentation span comes back too",
    fx.payloadPresentationMs(notRuled) > 0, `${fx.payloadPresentationMs(notRuled)}ms`);
  foundry.audio.AudioHelper.play = realAudioPlay;
  if (!fumbleWas) await game.settings.set("cyberpunk2020", "fumbleTableEnabled", fumbleWas);
  for (const m of game.messages.filter(m => !fumbleMsgMark.includes(m.id))) { try { await m.delete(); } catch (e) { /* gone */ } }
  await drain();


  /* ── cleanup ───────────────────────────────────────────────────────────── */
  AH.play = realPlay;
  ok("no document write OTHER THAN the face-target rotation reached the shooter token (negative)",
    tokenWrites.length === 0, tokenWrites.join(" | ") || "none");
  ok("every rotation write in this run came from the face-target turn, none from the flash",
    rotationWrites.length > 0 && rotationWrites.every(r => Number.isFinite(Number(r))),
    `${rotationWrites.length} rotation write(s): ${rotationWrites.join(",")}`);
  Hooks.off("updateToken", writeHook);
  for (const app of foundry.applications.instances.values()) {
    if (/Damage/i.test(app?.constructor?.name ?? "")) { try { await app.close(); } catch (e) { /* already closed */ } }
  }
  for (const m of game.messages.filter(m => m.speaker?.actor === actor.id)) { try { await m.delete(); } catch (e) { /* already gone */ } }
  try { await scene.deleteEmbeddedDocuments("Token", [tokenDoc.id, targetDoc.id]); } catch (e) { /* already gone */ }
  try { await actor.delete(); } catch (e) { /* already gone */ }
  try { await targetActor.delete(); } catch (e) { /* already gone */ }
  try { await clsActor.delete(); } catch (e) { /* already gone */ }

  return out;
});

/* ══ 12. TWO SESSIONS: the announcement reaches a client the fire never ran on ══════════════════ */
// The single-session legs prove the emitter's side. This one proves the point of the socket at all:
// `cyberpunk2020.weaponFired` fires ONLY on the client that resolved the shot, so without a relay
// every other player would see nothing. A second real session joins, the first announces, and the
// second is polled for a flash it built entirely from the datagram.
const xres = { checks: [] };
const xok = (n, p, d) => xres.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
let ctx2 = null;
try {
  const setup = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const scene = game.scenes.active;
    for (const t of [...scene.tokens].filter(t => t.name?.startsWith("__PW__XC"))) await t.delete();
    for (const a of [...game.actors].filter(a => a.name?.startsWith("__PW__XC"))) await a.delete();
    const actor = await Actor.create({ name: "__PW__XC Shooter", type: "character" });
    const [td] = await scene.createEmbeddedDocuments("Token", [{
      name: "__PW__XC Shooter", actorId: actor.id, actorLink: true, x: 900, y: 900, hidden: false,
    }]);
    await sleep(600);
    return { sceneId: scene.id, tokenId: td.id, actorId: actor.id };
  });

  ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  p2.on("pageerror", e => errors.push(`[session 2] ${e.message}`));
  p2.on("console", m => { if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(m.text())) errors.push(`[session 2] ${m.text()}`); });
  await p2.setViewportSize({ width: 1600, height: 900 });
  await p2.goto(`${URL}/join`);
  await p2.waitForSelector('select[name="userid"]');
  const joined = await p2.evaluate(() => {
    const sel = document.querySelector('select[name="userid"]');
    const opt = [...sel.options].find(o => /test user 1|rusty/i.test(o.textContent));
    if (!opt) return null;
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return opt.textContent.trim();
  });
  xok("two sessions: a second, non-GM user is available on this world to join as", !!joined, String(joined));
  await p2.fill('input[name="password"]', "");
  await p2.click('button[name="join"]');
  await p2.waitForFunction(() => window.game?.ready === true, null, { timeout: 60000 });
  await p2.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 60000 });

  // The receiving session WATCHES rather than polls. The relayed flash lasts a handful of render
  // frames — shorter than any round trip this harness can make — so session 2 samples the lighting
  // collection every frame for a fixed window and keeps the first sighting. That reads canvas state
  // directly, so the observation does not depend on the harness holding anything open.
  const ready2 = await p2.evaluate(async ({ tokenId }) => {
    const fx = await import("/modules/cp2020-augmented/module/fx/effects.js");
    const settings = await import("/modules/cp2020-augmented/module/settings.js");
    fx.clearFlashes();
    // A receipt counter beside the module's own listener, so a leg that fails can say WHICH half
    // failed: the datagram not arriving, or arriving and not being drawn.
    globalThis.__fxRelayReceipts = [];
    // Scoped to THIS leg's token: the channel carries every flash on the world, so a human firing
    // at the table while the keeper runs would otherwise be counted as extra receipts here.
    game.socket.on("module.cp2020-augmented", d => { if (d?.type === "fxMuzzleFlash" && d.tokenId === tokenId) globalThis.__fxRelayReceipts.push(d); });
    globalThis.__fxWatch = { frames: 0, first: null, peak: 0 };
    const prefix = `cp2020-augmented.flash.${tokenId}.`;
    const watch = () => {
      const w = globalThis.__fxWatch;
      w.frames++;
      const srcs = [...canvas.effects.lightSources.entries()].filter(([k]) => k.startsWith(prefix));
      if (srcs.length > w.peak) w.peak = srcs.length;
      if (srcs.length && !w.first) {
        w.first = srcs.map(([k, s]) => ({
          part: k.split(".").pop(), angle: s.data.angle, dim: s.data.dim, color: s.data.color,
          attenuation: s.data.attenuation, coloration: s.layers?.coloration?.active ?? null,
          active: s.active, attached: s.attached, pts: s.shape?.points?.length ?? 0,
          rotation: s.data.rotation,
        }));
      }
      if (w.frames < 400) requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    return {
      isGM: game.user.isGM, sees: !!canvas.tokens.get(tokenId), live: fx.liveFlashCount(),
      enabled: settings.combatFxEnabled(), canvasReady: canvas.ready, sceneId: canvas.scene?.id,
    };
  }, setup);
  xok("two sessions: session 2 is a non-GM that draws the shooter token and has no flash of its own",
    ready2.isGM === false && ready2.sees === true && ready2.live === 0
    && ready2.enabled === true && ready2.canvasReady === true, JSON.stringify(ready2));

  // Session 1 announces. Nothing about this call reaches session 2 except the datagram.
  const emitted1 = await page.evaluate(async ({ tokenId }) => {
    const fx = await import("/modules/cp2020-augmented/module/fx/effects.js");
    fx.clearFlashes();
    const t = canvas.tokens.get(tokenId);
    return fx.fxMuzzleFlash(t, { x: t.center.x + 400, y: t.center.y });
  }, setup);
  // Long enough for BOTH the envelope and the stalled-renderer deadline to have had their say on a
  // second session, whose renderer runs at a few frames per second under a software rasteriser.
  await new Promise(r => setTimeout(r, 3200));

  const seen = await p2.evaluate(async ({ tokenId }) => {
    const w = globalThis.__fxWatch;
    return {
      watchedFrames: w.frames, peak: w.peak, srcs: w.first ?? [],
      afterwards: [...canvas.effects.lightSources.keys()].filter(k => k.startsWith(`cp2020-augmented.flash.${tokenId}.`)).length,
      receipts: (globalThis.__fxRelayReceipts ?? []).length,
      lastReceipt: (globalThis.__fxRelayReceipts ?? []).at(-1) ?? null,
    };
  }, setup);
  xok("two sessions: session 1 announced and drew its own", emitted1 === true, String(emitted1));
  xok("two sessions: the announcement reached session 2 over the module's channel",
    seen.receipts === 1 && seen.lastReceipt?.tokenId === setup.tokenId,
    `${seen.receipts} receipt(s) / ${JSON.stringify(seen.lastReceipt)}`);
  xok("two sessions: session 2 built the flash locally from the announcement alone",
    seen.peak === 1 && seen.srcs.length === 1 && seen.watchedFrames > 5,
    `peak ${seen.peak} over ${seen.watchedFrames} frames`);
  // The SHIPPED shape on the receiving client too: one wedge, at the shipped width, aimed, and with a
  // wall-constrained polygon behind it. It reads "cone,spill" only if the default is put back to the
  // hybrid shape, which is the point of asserting the part names rather than just the count.
  // ⏪ RE-PINNED (FR#23): the receiving client resolves the colour regime from ITS OWN viewed scene, so
  // on this dark rig the relayed flash is coloured too — and that it agrees with the sender is the
  // point. (FR#24 added ONE field to the datagram — the loaded round's own colour — but it is null for
  // an ordinary load and this leg fires one, so the regime is still resolved locally here. That the
  // field is on the datagram at all, and null for an ordinary load, is asserted in §15.)
  const relayWant = await page.evaluate(async () => {
    const fx = await import("/modules/cp2020-augmented/module/fx/effects.js");
    const c = fx.flashColorFor(fx.viewedSceneDarkness());
    return c === null ? null : Number(foundry.utils.Color.from(c));
  });
  xok("two sessions: what session 2 built is the same shape, aimed and wall-aware",
    seen.srcs.map(s => s.part).sort().join(",") === "cone"
    && seen.srcs.every(s => s.angle === 270 && s.active === true && s.attached === true && s.pts > 0
      && s.color === relayWant && s.coloration === (relayWant !== null)),
    JSON.stringify(seen.srcs));
  // It also GOES AWAY on the receiving client, without that client ever being told to stop: the
  // envelope is driven locally, so nothing has to be relayed to end it.
  xok("two sessions: the relayed flash ended on session 2 with no second message (negative)",
    seen.afterwards === 0 && seen.receipts === 1, `${seen.afterwards} source(s) left / ${seen.receipts} message(s)`);

  // The load-bearing negative again, from the other side: session 2 drew a light without any token
  // document having changed — which is what the old transport could not do without a write.
  const doc2 = await p2.evaluate(({ tokenId }) => {
    const d = game.scenes.active.tokens.get(tokenId);
    return { bright: d._source.light.bright, dim: d._source.light.dim, flags: JSON.stringify(d.flags?.["cp2020-augmented"] ?? {}) };
  }, setup);
  xok("two sessions: session 2's copy of the token document carries no light change (negative)",
    doc2.bright === 0 && doc2.dim === 0 && doc2.flags === "{}", JSON.stringify(doc2));

  await p2.evaluate(async () => {
    const fx = await import("/modules/cp2020-augmented/module/fx/effects.js");
    globalThis.__fxWatch.frames = 100000;   // stop the sampler
    fx.clearFlashes();
  });
  await page.evaluate(async ({ tokenId, actorId }) => {
    const fx = await import("/modules/cp2020-augmented/module/fx/effects.js");
    fx.clearFlashes();
    try { await game.scenes.active.deleteEmbeddedDocuments("Token", [tokenId]); } catch (e) { /* gone */ }
    try { await game.actors.get(actorId)?.delete(); } catch (e) { /* gone */ }
  }, setup);
} catch (err) {
  xok("two sessions: the cross-session leg ran", false, String(err?.message ?? err));
} finally {
  try { await ctx2?.close(); } catch (e) { /* already closed */ }
}

/* ══ 13. TWO GM SESSIONS: the client that fired presents its own shot ═══════════════════════════ */
// The reported regression: with two GM sessions connected, EVERY fire mode stopped opening the apply
// window for the GM who fired — "all of the apply damage is going to chat cards instead of popups".
// The cause was a seat, not a code path, which is why it hit every mode equally: the handler stood
// down unless this client held the "active GM" seat, and the single-target emission is a LOCAL hook
// raised only on the client that resolved the shot. A GM who was not the seat-holder was therefore the
// only client to receive their own shot AND the only one told to ignore it, so nobody opened anything.
//
// This runs on its OWN two GM users so it never contends for the seats a human at the table is using,
// and it fires from whichever of them does NOT hold the seat.
const gres = { checks: [] };
const gok = (n, p, d) => gres.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
let gctxA = null, gctxB = null;
try {
  await page.evaluate(async () => {
    for (const n of ["__PW__GM2", "__PW__GM3"]) {
      if (!game.users.getName(n)) await User.create({ name: n, role: CONST.USER_ROLES.GAMEMASTER });
    }
  });
  const seat = async (name) => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage({ viewport: { width: 1280, height: 800 } });
    await p.goto(`${URL}/join`);
    await p.waitForSelector('select[name="userid"]');
    const found = await p.evaluate((n) => {
      const s = document.querySelector('select[name="userid"]');
      const o = [...s.options].find(x => x.textContent.trim() === n);
      if (!o) return false;
      s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return true;
    }, name);
    if (!found) { await ctx.close(); return null; }
    await p.locator('input[name="password"]').fill("");
    await p.click('button[name="join"]');
    await p.waitForFunction(() => window.game?.ready === true, null, { timeout: 90000 });
    await p.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 90000 });
    await p.waitForTimeout(1500);
    return { ctx, p };
  };
  const A = await seat("__PW__GM2"); gctxA = A?.ctx;
  const B = await seat("__PW__GM3"); gctxB = B?.ctx;
  gok("two GMs: both probe GM sessions are seated", !!A && !!B);
  if (A && B) {
    const wa = await A.p.evaluate(() => ({ meIsActiveGM: game.users.activeGM?.id === game.user.id, activeGM: game.users.activeGM?.name ?? null }));
    const FIRE = wa.meIsActiveGM ? B : A, OTHER = wa.meIsActiveGM ? A : B;
    gok("two GMs: one of them does NOT hold the active-GM seat — the reported situation",
      true, `active GM is "${wa.activeGM}"; firing from the other`);
    const armTap = (s) => s.p.evaluate(() => {
      globalThis.__g = { payloads: [], cards: [] };
      globalThis.__gh = [];
      const add = (n, f) => globalThis.__gh.push([n, Hooks.on(n, f)]);
      add("cyberpunk2020.weaponFired", (p) => globalThis.__g.payloads.push({
        firedHere: p.firedByUserId === game.user.id,
        landed: Object.values(p.areaDamages ?? {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0),
      }));
      add("createChatMessage", (m) => globalThis.__g.cards.push(m.id));
    });
    await armTap(A); await armTap(B);
    const fixture = await FIRE.p.evaluate(async () => {
      const scene = game.scenes.active;
      const shooter = game.actors.getName("Review · Shooter");
      const pistol = shooter.items.find(i => i.type === "weapon" && /Pistol/i.test(i.name));
      const tgt = scene.tokens.find(t => t.name === "Review · Target");
      const restore = { accuracy: pistol.system.accuracy ?? 0, shotsLeft: pistol.system.shotsLeft };
      await pistol.update({ "system.accuracy": 40 });
      canvas.tokens.get(tgt.id).setTarget(true, { releaseOthers: true });
      await new Promise(r => setTimeout(r, 400));
      return { pistolId: pistol.id, actorId: shooter.id, restore };
    });
    let landed = 0;
    for (let attempt = 0; attempt < 5 && landed === 0; attempt++) {
      await FIRE.p.evaluate(async ({ pistolId, actorId }) => {
        globalThis.__g.payloads.length = 0;
        for (const a of [...foundry.applications.instances.values()]) {
          if (/Damage/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
        }
        const actor = game.actors.get(actorId);
        await actor.items.get(pistolId).update({ "system.shotsLeft": 10 });
        await actor.sheet.render(true);
        await new Promise(r => setTimeout(r, 1600));
        const el = actor.sheet.element.querySelector(`.fire-weapon[data-item-id="${pistolId}"]`)
                ?? actor.sheet.element.querySelector(`[data-item-id="${pistolId}"] .fire-weapon`);
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }, fixture);
      await FIRE.p.waitForFunction(() => [...foundry.applications.instances.values()]
        .some(a => /ModifiersDialog/.test(a?.constructor?.name ?? "") && a.rendered === true), null, { timeout: 20000 });
      await FIRE.p.evaluate(() => {
        const dlg = [...foundry.applications.instances.values()].find(a => /ModifiersDialog/.test(a?.constructor?.name ?? ""));
        const btn = dlg.element.querySelector('button[type="submit"], footer button');
        if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); else dlg.element.requestSubmit();
      });
      // POLLED, not slept on: the apply window now waits for the engine to report the shot's last
      // elements gone, which is a real and variable span (longer again with several sessions on the
      // rig). A fixed wait raced it.
      await FIRE.p.waitForFunction(() => globalThis.__g.payloads.length > 0, null, { timeout: 20000 }).catch(() => {});
      landed = await FIRE.p.evaluate(() => globalThis.__g.payloads.reduce((n, p) => n + p.landed, 0));
      if (landed > 0) {
        await FIRE.p.waitForFunction(() => [...foundry.applications.instances.values()]
          .some(a => /Damage/i.test(a?.constructor?.name ?? "")), null, { timeout: 20000 }).catch(() => {});
      }
    }
    const read = (s) => s.p.evaluate(() => ({
      payloads: globalThis.__g.payloads,
      windows: [...foundry.applications.instances.values()].filter(a => /Damage/i.test(a?.constructor?.name ?? "")).length,
      flagged: globalThis.__g.cards.filter(id => !!game.messages.get(id)?.getFlag("cp2020-augmented", "damagePayload")).length,
    }));
    const rf = await read(FIRE), ro = await read(OTHER);
    gok("two GMs: a landed round is what this leg reads", landed > 0, `${landed} location(s)`);
    gok("two GMs: the shot is stamped with the client that fired it",
      rf.payloads.length === 1 && rf.payloads[0].firedHere === true, JSON.stringify(rf.payloads));
    gok("two GMs: the apply window opens on the client that fired, seat or no seat",
      rf.windows === 1, `${rf.windows} window(s) on the firing client`);
    gok("two GMs: and its card is NOT queued for the chat button instead (the reported symptom)",
      rf.flagged === 0, `${rf.flagged} flagged card(s)`);
    gok("two GMs: the other GM client neither receives nor handles it — no double-handling (negative)",
      ro.payloads.length === 0 && ro.windows === 0,
      `${ro.payloads.length} payload(s) / ${ro.windows} window(s) on the client that did not fire`);
    await FIRE.p.evaluate(async ({ pistolId, actorId, restore }) => {
      const actor = game.actors.get(actorId);
      await actor.items.get(pistolId).update({ "system.accuracy": restore.accuracy, "system.shotsLeft": restore.shotsLeft });
      for (const a of [...foundry.applications.instances.values()]) {
        if (/Damage|Modifiers/i.test(a?.constructor?.name ?? "")) { try { await a.close(); } catch (e) { /* closed */ } }
      }
      try { await actor.sheet.close(); } catch (e) { /* closed */ }
      [...game.user.targets].forEach(t => t.setTarget(false, { releaseOthers: false }));
      for (const id of globalThis.__g.cards) { try { await game.messages.get(id)?.delete(); } catch (e) { /* gone */ } }
    }, fixture);
  }
} catch (err) {
  gok("two GMs: the cross-session leg ran", false, String(err?.message ?? err));
} finally {
  try { await gctxA?.close(); } catch (e) { /* closed */ }
  try { await gctxB?.close(); } catch (e) { /* closed */ }
  try {
    await page.evaluate(async () => {
      for (const n of ["__PW__GM2", "__PW__GM3"]) { try { await game.users.getName(n)?.delete(); } catch (e) { /* gone */ } }
    });
  } catch (e) { /* page gone */ }
}

/* ══ 14. WRITE AUTHORITY, LIVE: a non-GM client writing the payload onto its OWN card ═══════════ */
// The dismissal fallback writes the payload from the client that held the window, and that client is
// whoever fired — a player, at most tables. The permission RULE is asserted in §11a-ii-e; this drives
// the write itself from a real non-GM session, because a rule that reads right and a write that is
// refused by the server look identical from the GM's side.
const pres = { checks: [] };
const pok = (n, p, d) => pres.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
let pctx = null;
try {
  await page.evaluate(async () => {
    if (!game.users.getName("__PW__PLAYER")) await User.create({ name: "__PW__PLAYER", role: CONST.USER_ROLES.PLAYER });
  });
  pctx = await browser.newContext();
  const pp = await pctx.newPage({ viewport: { width: 1280, height: 800 } });
  await pp.goto(`${URL}/join`);
  await pp.waitForSelector('select[name="userid"]');
  const seated = await pp.evaluate(() => {
    const s = document.querySelector('select[name="userid"]');
    const o = [...s.options].find(x => x.textContent.trim() === "__PW__PLAYER");
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return true;
  });
  if (seated) {
    await pp.locator('input[name="password"]').fill("");
    await pp.click('button[name="join"]');
    await pp.waitForFunction(() => window.game?.ready === true, null, { timeout: 90000 });
    await pp.waitForTimeout(1200);
  }
  pok("write authority: a non-GM session is seated to drive the write from", seated);
  if (seated) {
    const r = await pp.evaluate(async () => {
      const SCOPE = "cp2020-augmented";
      const mine = await ChatMessage.create({ content: "__PW__PLAYER own card" });
      let wrote = null, err = "";
      try {
        await mine.setFlag(SCOPE, "damagePayload", { areaDamages: { Torso: [{ damage: 3 }] }, weaponName: "__PW__probe" });
        await new Promise(r2 => setTimeout(r2, 600));
        wrote = mine.getFlag(SCOPE, "damagePayload");
      } catch (e) { err = String(e?.message ?? e); }
      // Outlive the notification-log animation on every connected client before removing it — a card
      // deleted mid-animation makes core's own re-query throw over there (see the same note in §11a-ii-e).
      await new Promise(r2 => setTimeout(r2, 1200));
      const id = mine.id;
      try { await mine.delete(); } catch (e) { /* gone */ }
      return { id, locations: Object.keys(wrote?.areaDamages ?? {}), err, isGM: game.user.isGM };
    });
    pok("write authority: the client really is a non-GM one (precondition)", r.isGM === false, `isGM ${r.isGM}`);
    pok("write authority: it writes the payload onto its OWN card and reads it back",
      r.locations.length === 1 && r.locations[0] === "Torso" && r.err === "",
      `wrote ${JSON.stringify(r.locations)}${r.err ? ` / refused: ${r.err}` : ""}`);
  }
} catch (err) {
  pok("write authority: the non-GM write leg ran", false, String(err?.message ?? err));
} finally {
  try { await pctx?.close(); } catch (e) { /* closed */ }
  try {
    await page.evaluate(async () => {
      for (const u of [...game.users].filter(u => u.name?.startsWith("__PW__PLAYER"))) { try { await u.delete(); } catch (e) { /* gone */ } }
      for (const m of [...game.messages].filter(m => /__PW__/.test(m.content ?? ""))) { try { await m.delete(); } catch (e) { /* gone */ } }
    });
  } catch (e) { /* page gone */ }
}

/* ══ 15. THE AMMO OVERLAY: which LOAD is in the gun, and what that changes on screen (FR#24) ══════ */
// The class row says what kind of gun fired. The overlay says what was in it. Every leg below is
// against the resolver and the merged row BY VALUE — the treatments are a table, so they are asserted
// as a table and not by looking at a canvas — followed by a live half that drives the fan-out for the
// three things arithmetic cannot answer: which asset was actually queued, how many times the
// once-per-payload elements were emitted, and what colour the light source was built with.
const ares = { checks: [] };
try {
  const r = await page.evaluate(async () => {
    const SCOPE = "cp2020-augmented";
    const out = { checks: [] };
    const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    /* ── a. resolution: the id answers first ───────────────────────────────── */
    ok("overlay resolution: an id on the payload is the answer",
      fx.ammoFxKeyOf({ modifier: "api" }) === "api"
      && fx.ammoFxKeyOf({ modifier: "flechette" }) === "flechette",
      `${fx.ammoFxKeyOf({ modifier: "api" })} / ${fx.ammoFxKeyOf({ modifier: "flechette" })}`);
    // The id is not merely consulted first, it OVERRIDES: a payload whose mechanics look like one load
    // and whose id says another follows the id. Nothing downstream may re-infer.
    ok("overlay resolution: the id overrides a contradicting fingerprint",
      fx.ammoFxKeyOf({ modifier: "standard", dotEnabled: true, dotType: "fire" }) === "standard",
      fx.ammoFxKeyOf({ modifier: "standard", dotEnabled: true, dotType: "fire" }));
    // The pair the fingerprint physically cannot split — identical mechanics, different ids.
    ok("overlay resolution: the id splits the two loads whose mechanics are identical",
      fx.ammoFxKeyOf({ modifier: "ap" }) === "ap"
      && fx.ammoFxKeyOf({ modifier: "dualPurpose" }) === "dualPurpose",
      `${fx.ammoFxKeyOf({ modifier: "ap" })} / ${fx.ammoFxKeyOf({ modifier: "dualPurpose" })}`);

    /* ── a2. …AND THE ID IS REALLY ON A REAL SHOT'S FIELDS ───────────────────────
     * ⭐ WHY THIS LEG EXISTS. Every leg above and below hands the resolver a payload this file built
     * itself, so all of them passed for a whole build while `payload.modifier` was missing from the
     * seam entirely — the fingerprint fallback answered for every load, and the only visible cost was
     * `dualPurpose` silently collapsing onto `ap`. This one asks the SHIPPED field reader
     * (seam-shim `ammoEffectFields`) about a REAL loaded gun, so what is asserted is the list that
     * actually feeds the hook. Preferred source is the review bench's own guns 07 and 16; with no
     * bench on the rig it builds the same pair as real documents and deletes them again. */
    const shim = await import(`/modules/${SCOPE}/module/seam-shim.js`);
    const benchActor = game.actors.getName("Review · Shooter");
    const benchGun = (n) => benchActor?.itemTypes.weapon
      .find(w => Number(w.getFlag(SCOPE, "reviewBench")?.n) === n) ?? null;
    let realFields = null, realSource = "bench";
    if (benchGun(7) && benchGun(16)) {
      realFields = { g07: shim.ammoEffectFields(benchGun(7)), g16: shim.ammoEffectFields(benchGun(16)) };
    } else {
      realSource = "synthesized documents";
      for (const a of [...game.actors].filter(a => a.name === "__PW__AMMOID")) await a.delete();
      const holder = await Actor.create({ name: "__PW__AMMOID", type: "character" });
      const made = await holder.createEmbeddedDocuments("Item", [
        { name: "__PW__api", type: "ammo", system: { modifier: "api", caliber: "5.56" } },
        { name: "__PW__dp", type: "ammo", system: { modifier: "dualPurpose", caliber: "20/9mm" } },
      ]);
      const guns = await holder.createEmbeddedDocuments("Item", [
        { name: "__PW__g07", type: "weapon", system: { ammoItemId: made[0].id } },
        { name: "__PW__g16", type: "weapon", system: { ammoItemId: made[1].id } },
      ]);
      realFields = {
        g07: shim.ammoEffectFields(holder.items.get(guns[0].id)),
        g16: shim.ammoEffectFields(holder.items.get(guns[1].id)),
      };
      await holder.delete();
    }
    ok("overlay resolution: the ammo's id is on the fields the seam raises for a REAL loaded gun",
      realFields.g07?.modifier === "api" && realFields.g07?.caliber === "5.56"
      && realFields.g16?.modifier === "dualPurpose" && realFields.g16?.caliber === "20/9mm",
      `${realSource}: ${JSON.stringify({ g07: [realFields.g07?.modifier, realFields.g07?.caliber], g16: [realFields.g16?.modifier, realFields.g16?.caliber] })}`);
    ok("overlay resolution: so the real dual-purpose load resolves by ID, where the fingerprint says 'ap'",
      fx.ammoFxKeyOf(realFields.g16) === "dualPurpose"
      && fx.ammoFxKeyOf({ ...realFields.g16, modifier: undefined }) === "ap"
      && fx.ammoFxKeyOf(realFields.g07) === "api",
      `${fx.ammoFxKeyOf(realFields.g16)} / no-id → ${fx.ammoFxKeyOf({ ...realFields.g16, modifier: undefined })}`);

    /* ── b. resolution: the fingerprint answers when there is no id ─────────── */
    const fp = (o) => fx.ammoFxKeyOf(o);
    ok("overlay resolution: fingerprint reads the fire damage-over-time as the incendiary load",
      fp({ armorMultSoft: 0.5, penDamageMult: 0.5, dotEnabled: true, dotType: "fire" }) === "api",
      fp({ armorMultSoft: 0.5, penDamageMult: 0.5, dotEnabled: true, dotType: "fire" }));
    ok("overlay resolution: fingerprint reads the spread mode",
      fp({ spreadMode: "flechette", armorMultSoft: 0.25, penDamageMult: 0.5 }) === "flechette");
    ok("overlay resolution: fingerprint splits the two doubled-armour loads by past-armour multiplier",
      fp({ armorMultSoft: 2, penDamageMult: 1.5 }) === "hollowPoint"
      && fp({ armorMultSoft: 2, penDamageMult: 3 }) === "safety",
      `${fp({ armorMultSoft: 2, penDamageMult: 1.5 })} / ${fp({ armorMultSoft: 2, penDamageMult: 3 })}`);
    ok("overlay resolution: fingerprint splits the two stun loads by the save modifier",
      fp({ stunSaveOnHit: true, stunSaveMod: -2 }) === "stundart"
      && fp({ stunSaveOnHit: true, stunSaveMod: 0, penDamageMult: 0.5 }) === "rubber",
      `${fp({ stunSaveOnHit: true, stunSaveMod: -2 })} / ${fp({ stunSaveOnHit: true, stunSaveMod: 0, penDamageMult: 0.5 })}`);
    ok("overlay resolution: fingerprint reads the halved multipliers as the armour-piercing load",
      fp({ armorMultSoft: 0.5, armorMultHard: 0.5, penDamageMult: 0.5 }) === "ap");
    // The documented LIMIT of the fallback, pinned so it is a known property and not a surprise.
    ok("overlay resolution: without an id the identical-mechanics pair collapses onto one (known limit)",
      fp({ armorMultSoft: 0.5, penDamageMult: 0.5 }) === "ap");
    // The one that a payload in the wild really does carry, from the b1 seam probe: a warhead sets
    // stunSaveOnHit with a zero modifier, and must NOT be painted with the baton-round treatment.
    ok("overlay resolution: a warhead's own stun fields do not read as the baton load (negative)",
      fp({ effectTypes: ["Explosive"], stunSaveOnHit: true, stunSaveMod: 0, penDamageMult: 2,
        dotEnabled: true, dotTurns: 3, dotType: "fire", armorMultSoft: 1 }) !== "rubber",
      fp({ effectTypes: ["Explosive"], stunSaveOnHit: true, stunSaveMod: 0, penDamageMult: 2, dotEnabled: true, dotTurns: 3, dotType: "fire", armorMultSoft: 1 }));
    ok("overlay resolution: an unremarkable payload reads as the baseline",
      fp({ effectTypes: ["None"] }) === "standard" && fp({}) === "standard" && fp(null) === "standard");

    /* ── c. the base classes are untouched by ammo that names no row ────────── */
    // Asserted as OBJECT IDENTITY, not field-by-field: "changes nothing" is then a property of the
    // resolver rather than a comparison that could pass by coincidence.
    for (const cls of Object.keys(fx.FX_CLASSES)) {
      ok(`base row unchanged: ${cls} with no ammo, baseline ammo, an untreated id and an unknown id`,
        fx.ammoFxEntry(cls, null) === fx.FX_CLASSES[cls]
        && fx.ammoFxEntry(cls, "standard") === fx.FX_CLASSES[cls]
        && fx.ammoFxEntry(cls, "brassCased") === fx.FX_CLASSES[cls]
        && fx.ammoFxEntry(cls, "__PW__nosuchload") === fx.FX_CLASSES[cls]);
    }
    ok("base row unchanged: an unmapped weapon class still resolves to nothing at all (negative)",
      fx.ammoFxEntry("melee", "api") === null && fx.ammoFxEntry(null, "api") === null);

    /* ── d. per-treatment values ───────────────────────────────────────────── */
    const E = (cls, key) => fx.ammoFxEntry(cls, key);
    // INCENDIARY.
    const apiRifle = E("rifle", "api");
    // ⏪ RE-PINNED 2026-08-09: the fire IMPACT is no longer part of this treatment (the ruling is in
    // §18). What the load still says is said by the bolt, the flash and the ground it sets alight.
    ok("treatment api: the bolt is red-shifted, the light carries a colour, the ground catches — and NO mark is promoted",
      eq(apiRifle.tracerColor, fx.TRACER_COLOR_INCENDIARY)
      && apiRifle.impactKey === undefined
      && typeof apiRifle.flashColor === "string" && apiRifle.flashColor.startsWith("#")
      && apiRifle.groundFire === true,
      JSON.stringify({ tracerColor: apiRifle.tracerColor, impactKey: apiRifle.impactKey ?? null, flashColor: apiRifle.flashColor }));
    ok("treatment api: the red shift rotates the hue the OPPOSITE way from the class shift",
      fx.TRACER_COLOR_INCENDIARY.hue < 0 && fx.TRACER_COLOR.hue > 0,
      `ammo ${fx.TRACER_COLOR_INCENDIARY.hue} / class ${fx.TRACER_COLOR.hue}`);
    // ⭐ THE STANDING RULING, asserted as the mechanism rather than as a special case: an overlay may
    // REPAINT an element the class already DECLARES and may never ADD one.
    //
    // ⏪⏪ INVERTED (2026-08-09, user ruling). The leg that stood here asserted the tint landed on the
    // discharge column ONLY, i.e. that an incendiary shell left its pellet fan in the asset's own
    // colour. Reported against: "for incendiary on autoshotgun the little dorito shaped pellets
    // themselves didn't get the same red treatment as the spiky cone and starburst. Make sure when you
    // update the animation for one shotgun ammo type, it's updated for all." So an ammo recolour now
    // reaches the fan as well — while the BASE look is unchanged, because the shell row declares
    // `tracerColor: null` (repaintable, painted with nothing) rather than carrying a colour. The two
    // halves are asserted separately below so a regression cannot satisfy one by breaking the other.
    const apiShell = E("shotgun", "api");
    ok("treatment api: on the shell the tint lands on the pellet fan",
      eq(apiShell.tracerColor, fx.TRACER_COLOR_INCENDIARY),
      JSON.stringify({ tracerColor: apiShell.tracerColor }));
    ok("treatment reach: every recolouring overlay reaches the shell's fan, not just the incendiary",
      eq(E("shotgun", "rubber").tracerColor, fx.TRACER_COLOR_BATON)
      && eq(E("shotgun", "stundart").tracerColor, fx.TRACER_COLOR_DART)
      && eq(E("shotgun", "ap").tracerColor, fx.TRACER_COLOR_HARDENED)
      && eq(E("shotgun", "dualPurpose").tracerColor, fx.TRACER_COLOR_HARDENED),
      ["api", "ap", "dualPurpose", "rubber", "stundart"].map(k => `${k}:${!!E("shotgun", k).tracerColor}`).join(" "));
    ok("base fan: with no overlay the shell paints its pellets with NOTHING — the settled look stands",
      E("shotgun", "standard").tracerColor === null && E("shotgun", "brassCased").tracerColor === null
      && fx.FX_CLASSES.shotgun.tracerColor === null,
      `standard fan shift ${JSON.stringify(E("shotgun", "standard").tracerColor)}`);
    ok("recolour mask: the mask is key PRESENCE, so a null declaration is repaintable and absence is not",
      "tracerColor" in fx.FX_CLASSES.shotgun && fx.FX_CLASSES.shotgun.tracerColor === null
      && fx.AMMO_FX_RECOLOR_FIELDS.length === 1 && fx.AMMO_FX_RECOLOR_FIELDS[0] === "tracerColor",
      `shell declares fan ${"tracerColor" in fx.FX_CLASSES.shotgun}, mask [${fx.AMMO_FX_RECOLOR_FIELDS}]`);
    // ⏪ The mask's negative case used to be `columnColor` on a pistol. With the column deleted the
    // guarantee is asserted against a field NO class declares, so the rule is still proved by an
    // element that genuinely does not exist rather than by one that happens to.
    ok("recolour mask: an overlay never gives a class a field its row omits (negative)",
      fx.ammoFxEntry("pistol", "__pw_probe__") === fx.FX_CLASSES.pistol
      && E("pistol", "api").columnColor === undefined && E("rifle", "rubber").column === undefined,
      "no shipped row declares a column, so none can be added");
    // ARMOUR-PIERCING, and its identical twin.
    const apRifle = E("rifle", "ap");
    ok("treatment ap: the bolt is desaturated and brighter, and the impact is a CRACK not a star",
      eq(apRifle.tracerColor, fx.TRACER_COLOR_HARDENED)
      && fx.TRACER_COLOR_HARDENED.saturate < -0.5 && fx.TRACER_COLOR_HARDENED.brightness > 1.2
      && apRifle.impactKey === fx.IMPACT_CRACK.key && /ground_crack/.test(apRifle.impactKey),
      JSON.stringify({ tracerColor: apRifle.tracerColor, impactKey: apRifle.impactKey }));
    ok("treatment dualPurpose: drawn identically to ap, because the rules make them identical",
      eq(E("rifle", "dualPurpose"), apRifle) && eq(E("shotgun", "dualPurpose"), E("shotgun", "ap")));
    // ⏪⏪ THE SIZE PAIR IS DELETED (2026-08-09, the realism razor: "a load gets a visual only if you
    // could plausibly see the difference"). Six legs stood here and pinned `hollowPoint` × 1.60 and
    // `safety` × 0.55 per class, the class order surviving the multiplier, and nothing else moving.
    // Every one described a difference nobody at a table can read — the width of a hit mark is not how
    // a hollow-point announces itself — so the rows went and these legs assert their absence. The
    // MECHANICS are untouched: this table has never been read by a damage path.
    ok("identity razor: the hollowPoint and safety rows are gone from the overlay table",
      fx.AMMO_FX.hollowPoint === undefined && fx.AMMO_FX.safety === undefined,
      Object.keys(fx.AMMO_FX).join(","));
    ok("identity razor: both loads now resolve to the class row ITSELF, on every class (identity, not a copy)",
      ["pistol", "smg", "rifle", "shotgun", "heavy"].every(c =>
        fx.ammoFxEntry(c, "hollowPoint") === fx.FX_CLASSES[c] && fx.ammoFxEntry(c, "safety") === fx.FX_CLASSES[c]),
      "same frozen object, all five classes");
    ok("identity razor: so bench guns 02 and 03 draw exactly what 01 draws — mark, asset and tail",
      ["pistol", "smg", "rifle", "shotgun", "heavy"].every(c =>
        fx.ammoFxEntry(c, "hollowPoint").impactSquares === fx.FX_CLASSES[c].impactSquares
        && fx.presentationTailMs(c, "hollowPoint") === fx.presentationTailMs(c, "standard")
        && fx.presentationTailMs(c, "safety") === fx.presentationTailMs(c, "standard")),
      ["pistol", "rifle", "heavy"].map(c => `${c}:${fx.ammoFxEntry(c, "safety").impactSquares}`).join(" "));
    ok("identity razor: the fingerprint still NAMES them — only the picture died, not the mechanics",
      fx.ammoFxFingerprintKey({ armorMultSoft: 2, penDamageMult: 1.5 }) === "hollowPoint"
      && fx.ammoFxFingerprintKey({ armorMultSoft: 2, penDamageMult: 3 }) === "safety",
      "resolution unchanged, overlay absent");
    ok("identity razor: `impactScale` is still a live mechanism — the deletion was two rows, not the field",
      fx.AMMO_FX.flechette.impactScale === 0.7
      && fx.ammoFxEntry("rifle", "flechette").impactSquares
         === Number((fx.FX_CLASSES.rifle.impactSquares * 0.7).toFixed(4))
      && fx.ammoFxEntry("rifle", "flechette").impactScale === undefined,
      `flechette mark ${fx.ammoFxEntry("rifle", "flechette").impactSquares}`);

    // ⭐ THE SLUG (2026-08-09) — the one shotgun load that is a single projectile, which until now
    // inherited the class's six-pellet fan and drew a slug as buckshot. Written entirely in the class
    // row's own fields, so these legs read the MECHANISM rather than a new word.
    const slugShell = E("shotgun", "slug");
    ok("treatment slug: it draws ONE round, by a pellet count the fan planner declines to fan",
      slugShell.pellets === 1
      && fx.pelletEndpoints({ x: 0, y: 0 }, { x: 500, y: 0 }, { pellets: 1, spreadRad: 0.07, hit: true }).length === 0,
      `pellets ${slugShell.pellets}, fan length ${fx.pelletEndpoints({ x: 0, y: 0 }, { x: 500, y: 0 }, { pellets: 1, spreadRad: 0.07 }).length}`);
    ok("treatment slug: it is PAINTED, not travelled — a zero dash length is the draw path's own switch",
      slugShell.dashSquares === 0 && fx.FX_CLASSES.shotgun.dashSquares > 0,
      `dashSquares ${slugShell.dashSquares} vs the class's ${fx.FX_CLASSES.shotgun.dashSquares}`);
    ok("treatment slug: it reads as RIFLE fire — the heavy bolt family, in the standard tracer shift",
      slugShell.tracer === "jb2a.bullet.02.orange" && slugShell.tracer === fx.FX_CLASSES.rifle.tracer
      && eq(slugShell.tracerColor, fx.TRACER_COLOR) && fx.fxDbEntryExists(slugShell.tracer),
      `${slugShell.tracer}`);
    // ⚠ THE TAIL CORRECTION, which is the leg that would have caught a cosmetic-looking mistake: leave
    // `dashMs` at the shell's 150 and the arithmetic reads the TRAVELLED branch for a PAINTED round,
    // and the apply window opens half a second early on every slug.
    ok("treatment slug: zeroing the crossing puts the tail on the PAINTED branch, where the round is",
      slugShell.dashMs === 0
      && fx.presentationTailMs("shotgun", "slug") === Math.max(fx.TRACER_CLIP_MS, fx.HIT_CONFIRM.clipMs)
      && fx.presentationTailMs("shotgun", "slug") === fx.presentationTailMs("rifle", "standard")
      && fx.presentationTailMs("shotgun", "slug") === 933,
      `slug tail ${fx.presentationTailMs("shotgun", "slug")}ms vs buckshot ${fx.presentationTailMs("shotgun")}ms`);
    ok("treatment slug: buckshot is untouched by all of it (negative)",
      fx.FX_CLASSES.shotgun.pellets === 6 && fx.FX_CLASSES.shotgun.dashSquares === 1
      && fx.FX_CLASSES.shotgun.dashMs === 150 && fx.FX_CLASSES.shotgun.tracer === "jb2a.bullet.01.orange",
      "the class row is unmoved");
    ok("treatment slug: an id-less payload still names it, off the one mechanical field that separates it",
      fx.ammoFxFingerprintKey({ spreadMode: "slug" }) === "slug"
      && fx.ammoFxKeyOf({ modifier: "slug" }) === "slug",
      "fingerprint and id agree");

    // ⏪⏪ RE-PINNED 2026-08-10 (the single-file ruling — §21 carries the full set and the measurement).
    // Three legs stood here and asserted the row's own count of eight: that a one-bolt class was GIVEN
    // a group, that the shell's own count was OVERRIDDEN by it, and that the load read as a needle
    // swarm partly BY that count. The ruling removed the count ("one after the other, single file"), so
    // all three claims are now false by design and the replacements assert the opposite where the old
    // ones asserted the count, and the unchanged half — the load's own length, crossing, mark and
    // colour — where they asserted geometry.
    const flRifle = E("rifle", "flechette");
    ok("treatment flechette: a class that draws one round per slot keeps drawing one, in the dart's geometry",
      fx.FX_CLASSES.rifle.pellets === undefined && flRifle.pellets === undefined
      && flRifle.spreadRad === undefined && flRifle.dashSquares === 1.1 && flRifle.dashMs === 170,
      JSON.stringify({ pellets: flRifle.pellets ?? null, dashSquares: flRifle.dashSquares, dashMs: flRifle.dashMs }));
    const flShell = E("shotgun", "flechette");
    ok("treatment flechette: on a class that already draws a group, the class's own count comes through",
      flShell.pellets === fx.FX_CLASSES.shotgun.pellets && flShell.spreadRad === fx.FX_CLASSES.shotgun.spreadRad
      && flShell.dashSquares === 1.1 && flShell.dashSquares !== fx.FX_CLASSES.shotgun.dashSquares,
      JSON.stringify({ pellets: flShell.pellets, dashSquares: flShell.dashSquares, spreadRad: flShell.spreadRad }));
    // ⚠ Written against the VALUES. With the count gone, what separates a dart from shot is what the
    // row still says: the length, the crossing, the smaller mark and the colour. The count and the
    // spread are no longer part of the answer on any class, which is what these two legs now read.
    ok("treatment flechette: the dart reads as a needle by its mark and its crossing, not by a count",
      flShell.impactSquares < fx.FX_CLASSES.shotgun.impactSquares
      && flShell.dashMs > fx.FX_CLASSES.shotgun.dashMs
      && flShell.tracerColor === fx.TRACER_COLOR_DART && fx.FX_CLASSES.shotgun.tracerColor === null,
      `mark ${flShell.impactSquares} vs ${fx.FX_CLASSES.shotgun.impactSquares}, crossing ${flShell.dashMs}ms vs ${fx.FX_CLASSES.shotgun.dashMs}ms, same count ${flShell.pellets}`);
    ok("treatment flechette: and it is NOT the shorter or faster mark the source comment claimed",
      flShell.dashSquares > fx.FX_CLASSES.shotgun.dashSquares
      && flShell.dashMs > fx.FX_CLASSES.shotgun.dashMs,
      `length ${flShell.dashSquares} vs ${fx.FX_CLASSES.shotgun.dashSquares}, crossing ${flShell.dashMs}ms vs ${fx.FX_CLASSES.shotgun.dashMs}ms`);
    // The tail is built from dashMs and the impact clip; the dart's LENGTH is not one of its terms, so
    // raising it must move no window. Asserted as the arithmetic rather than as "it did not change",
    // because the arithmetic is what would have to break for the window to open early.
    ok("treatment flechette: the length is not a tail input, so raising it moved no apply window",
      fx.presentationTailMs("rifle", "flechette") === flRifle.dashMs + fx.HIT_CONFIRM.clipMs
      && fx.presentationTailMs("shotgun", "flechette") === flShell.dashMs + fx.HIT_CONFIRM.clipMs
      && fx.presentationTailMs("rifle", "flechette") === 1003,
      `rifle ${fx.presentationTailMs("rifle", "flechette")}ms and shell ${fx.presentationTailMs("shotgun", "flechette")}ms = dashMs ${flRifle.dashMs} + impact ${fx.HIT_CONFIRM.clipMs}, dart length ${flRifle.dashSquares} absent from both`);
    // ⏪⏪ THE BATON PAIR (2026-08-09, user ruling). Two legs stood here and both are retired, because
    // the treatment they pinned was rejected on report: "what you did for rubber bullets doesn't look
    // good — instead of darkening/muting the color, let's look for a better asset to represent rubber
    // bullets." What they asserted was (1) that this pair's matrix was the ONLY one that darkened, and
    // (2) that the pair drew a dull bolt and a small mark. Both are now false BY DESIGN and the legs
    // below assert the opposite property on purpose, so the rejected look cannot come back unnoticed.
    const batonRifle = E("rifle", "rubber");
    ok("treatment baton: no live matrix darkens — the retired one is not on any shipped row",
      fx.TRACER_COLOR_BATON.brightness > 1 && fx.TRACER_COLOR.brightness > 1
      && fx.TRACER_COLOR_INCENDIARY.brightness > 1 && fx.TRACER_COLOR_HARDENED.brightness > 1
      && fx.TRACER_COLOR_DART.brightness > 1
      && Object.values(fx.AMMO_FX).every(o => o.tracerColor !== fx.TRACER_COLOR_INERT),
      `baton ${fx.TRACER_COLOR_BATON.brightness} vs retired ${fx.TRACER_COLOR_INERT.brightness}`);
    ok("treatment baton: the load is said with a different ASSET, on every class",
      ["pistol", "smg", "rifle", "shotgun", "heavy"].every(c =>
        E(c, "rubber").tracer === fx.BATON_ROUND.key && E(c, "rubber").tracer !== fx.FX_CLASSES[c].tracer),
      ["pistol", "smg", "rifle", "shotgun", "heavy"].map(c => `${c}:${E(c, "rubber").tracer}`).join(" "));
    ok("treatment baton: a class that PAINTED its round now TRAVELS it, at the slowest crossing on the rail",
      ["pistol", "smg", "rifle", "heavy"].every(c =>
        fx.FX_CLASSES[c].dashSquares === undefined
        && E(c, "rubber").dashSquares === fx.BATON_ROUND.squares
        && E(c, "rubber").dashMs === fx.BATON_ROUND.crossMs)
      && fx.BATON_ROUND.crossMs > fx.FX_CLASSES.shotgun.dashMs
      && fx.BATON_ROUND.crossMs > E("shotgun", "flechette").dashMs,
      `${fx.BATON_ROUND.crossMs}ms vs buckshot ${fx.FX_CLASSES.shotgun.dashMs}ms and dart ${E("shotgun", "flechette").dashMs}ms`);
    ok("treatment baton: on the shell it re-sizes and slows the fan but does NOT change the shot count",
      E("shotgun", "rubber").pellets === fx.FX_CLASSES.shotgun.pellets
      && E("shotgun", "rubber").spreadRad === fx.FX_CLASSES.shotgun.spreadRad
      && E("shotgun", "rubber").dashSquares !== fx.FX_CLASSES.shotgun.dashSquares
      && E("shotgun", "rubber").dashMs !== fx.FX_CLASSES.shotgun.dashMs,
      JSON.stringify({ pellets: E("shotgun", "rubber").pellets, dashSquares: E("shotgun", "rubber").dashSquares }));
    ok("treatment baton: the hit mark is a DUST puff, drawn at the class's own width — no shrink anywhere",
      ["pistol", "smg", "rifle", "shotgun", "heavy"].every(c =>
        E(c, "rubber").impactKey === fx.IMPACT_DUST.key
        && E(c, "rubber").impactSquares === fx.FX_CLASSES[c].impactSquares
        && E(c, "rubber").impactScale === undefined),
      ["pistol", "smg", "rifle", "shotgun", "heavy"].map(c => `${c}:${E(c, "rubber").impactSquares}`).join(" "));
    ok("treatment baton: the dust mark takes no clip of its own, so the promotion rule still holds",
      E("rifle", "rubber").impactClipMs === undefined && fx.IMPACT_DUST.clipMs > fx.HIT_CONFIRM.clipMs,
      `asset ${fx.IMPACT_DUST.clipMs}ms trimmed to the ordinary ${fx.HIT_CONFIRM.clipMs}ms`);
    // ⏪⏪ STUN-DART IS NO LONGER RUBBER'S TWIN (2026-08-09, the realism razor). The leg that stood
    // here asserted `E(c,"rubber")` and `E(c,"stundart")` were equal on all five classes, on the
    // reading that both are less-lethal and differ only by a stun modifier nobody can see. The ruling
    // reversed that on the OBJECT rather than on the mechanic: a baton round is a fat blunt slug and a
    // stun dart is a needle. So the replacement asserts they are DIFFERENT, and says how.
    ok("treatment stundart: it is no longer the baton's twin, on any class (the inverse of the retired leg)",
      ["pistol", "smg", "rifle", "shotgun", "heavy"].every(c => !eq(E(c, "rubber"), E(c, "stundart"))),
      "rubber !== stundart, all five classes");
    // ⏪ RE-PINNED 2026-08-10, and again 2026-08-11 (§21 carries the full set for both). It first
    // asserted stundart's geometry was flechette's field for field; the 2026-08-10 ruling moved one row
    // and not the other, so it was re-pinned to a shared LOOK plus a count of this row's own. The
    // 2026-08-11 ruling moved the second row the same way — "is it fired from a weapon that usually
    // fires in a single file line? If so yes" — so the two rows are one set of fields again, and what
    // decides how many darts a shot draws is the CLASS.
    ok("treatment stundart: it says a LOOK and nothing about how many — the same set the other dart row says",
      ["pistol", "rifle", "shotgun"].every(c =>
        E(c, "stundart").dashSquares === E(c, "flechette").dashSquares
        && E(c, "stundart").dashMs === E(c, "flechette").dashMs
        && E(c, "stundart").tracerColor === E(c, "flechette").tracerColor
        && E(c, "stundart").pellets === E(c, "flechette").pellets),
      `${fx.AMMO_FX.stundart.dashSquares} sq, ${fx.AMMO_FX.stundart.dashMs}ms, count ${fx.AMMO_FX.stundart.pellets ?? "none"}`);
    ok("treatment stundart: so the CLASS decides the count — one on a stream class, the shell's six on a shell",
      fx.AMMO_FX.stundart.pellets === undefined && fx.AMMO_FX.stundart.spreadRad === undefined
      && ["pistol", "rifle", "heavy"].every(c => E(c, "stundart").pellets === undefined)
      && E("shotgun", "stundart").pellets === 6 && E("shotgun", "stundart").spreadRad === 0.07,
      JSON.stringify({ row: fx.AMMO_FX.stundart.pellets ?? null, shell: E("shotgun", "stundart").pellets }));
    ok("treatment stundart: the baton's ASSET and its dust mark stay with rubber alone (negative)",
      fx.AMMO_FX.stundart.tracer === undefined && fx.AMMO_FX.stundart.impactKey === undefined
      && fx.AMMO_FX.rubber.tracer === fx.BATON_ROUND.key && fx.AMMO_FX.rubber.impactKey === fx.IMPACT_DUST.key,
      JSON.stringify({ stundartTracer: fx.AMMO_FX.stundart.tracer ?? null, rubberTracer: fx.AMMO_FX.rubber.tracer }));
    ok("treatment stundart: and its tail is the dart tail, not the baton's slow crossing",
      fx.presentationTailMs("rifle", "stundart") === fx.presentationTailMs("rifle", "flechette")
      && fx.presentationTailMs("rifle", "stundart") !== fx.presentationTailMs("rifle", "rubber"),
      `stundart ${fx.presentationTailMs("rifle", "stundart")}ms, flechette ${fx.presentationTailMs("rifle", "flechette")}ms, rubber ${fx.presentationTailMs("rifle", "rubber")}ms`);

    /* ── d-ii. THE DART LANGUAGE: grey is darts, orange is balls and bullets ── */
    // A rule rather than one row's tuning, so it is asserted across every load that has one.
    ok("dart language: both dart loads carry the SAME grey matrix, and it is the only one they carry",
      eq(fx.AMMO_FX.flechette.tracerColor, fx.TRACER_COLOR_DART)
      && eq(fx.AMMO_FX.stundart.tracerColor, fx.TRACER_COLOR_DART),
      JSON.stringify(fx.TRACER_COLOR_DART));
    ok("dart language: grey means DESATURATED, and it is the most desaturated matrix on the rail",
      fx.TRACER_COLOR_DART.saturate < fx.TRACER_COLOR.saturate
      && fx.TRACER_COLOR_DART.saturate <= fx.TRACER_COLOR_BATON.saturate
      && fx.TRACER_COLOR_DART.saturate <= fx.TRACER_COLOR_HARDENED.saturate,
      [["dart", fx.TRACER_COLOR_DART], ["class", fx.TRACER_COLOR], ["baton", fx.TRACER_COLOR_BATON],
       ["hardened", fx.TRACER_COLOR_HARDENED]].map(([n, m]) => `${n}:${m.saturate}`).join(" "));
    ok("dart language: it is NOT a darkening — the rejected reflex is not smuggled back in as a colour",
      fx.TRACER_COLOR_DART.brightness > 1 && fx.TRACER_COLOR_DART.brightness > fx.TRACER_COLOR_INERT.brightness,
      `dart ${fx.TRACER_COLOR_DART.brightness} vs retired ${fx.TRACER_COLOR_INERT.brightness}`);
    ok("dart language: it is its OWN constant, not a reuse of the baton matrix they sit next to",
      fx.TRACER_COLOR_DART !== fx.TRACER_COLOR_BATON
      && !eq(fx.TRACER_COLOR_DART, fx.TRACER_COLOR_BATON),
      `dart ${JSON.stringify(fx.TRACER_COLOR_DART)} vs baton ${JSON.stringify(fx.TRACER_COLOR_BATON)}`);
    ok("dart language: balls and bullets keep the orange — buckshot and the slug are not repainted grey",
      fx.FX_CLASSES.shotgun.tracerColor === null
      && eq(fx.ammoFxEntry("shotgun", "slug").tracerColor, fx.TRACER_COLOR)
      && !eq(fx.ammoFxEntry("shotgun", "slug").tracerColor, fx.TRACER_COLOR_DART),
      "buckshot unpainted, slug in the standard shift");

    /* ── e. every promoted / added asset resolves on the INSTALLED free tier ── */
    for (const [name, key] of [["fire impact", fx.IMPACT_FIRE.key], ["ground crack impact", fx.IMPACT_CRACK.key],
      ["burning ground", fx.GROUND_FIRE.key],
      ["dust impact", fx.IMPACT_DUST.key], ["baton round", fx.BATON_ROUND.key]]) {
      ok(`asset floor: the ${name} key resolves on the installed tier`, fx.fxDbEntryExists(key), key);
    }

    /* ── f. the tail: an overlay that moves a tail input must move the tail ─── */
    // The failure this section exists to catch is one-directional and silent: an overlay drawn by the
    // shot but not seen by the arithmetic makes the apply window open while the round is still on screen.
    ok("tail threading: baseline ammo is identical to no ammo at all, every class",
      Object.keys(fx.FX_CLASSES).every(c => fx.presentationTailMs(c) === fx.presentationTailMs(c, "standard")),
      Object.keys(fx.FX_CLASSES).map(c => `${c}:${fx.presentationTailMs(c)}`).join(" "));
    const rifleBase = fx.presentationTailMs("rifle");
    const rifleFlech = fx.presentationTailMs("rifle", "flechette");
    ok("tail threading: flechette gives a painted-bolt class a crossing time, and the tail follows it",
      rifleBase === 933 && rifleFlech === 170 + fx.HIT_CONFIRM.clipMs && rifleFlech > rifleBase,
      `${rifleBase} -> ${rifleFlech}`);
    const shellBase = fx.presentationTailMs("shotgun");
    const shellFlech = fx.presentationTailMs("shotgun", "flechette");
    ok("tail threading: flechette on the shell moves the tail by its own crossing time",
      shellBase === fx.FX_CLASSES.shotgun.dashMs + fx.HIT_CONFIRM.clipMs
      && shellFlech === 170 + fx.HIT_CONFIRM.clipMs,
      `${shellBase} -> ${shellFlech}`);
    ok("tail threading: the whole-payload span carries the overlay too",
      fx.presentationMs(10, "rifle", "flechette") === 9 * fx.classCadenceMs("rifle") + rifleFlech
      && fx.presentationMs(10, "rifle") === 9 * fx.classCadenceMs("rifle") + rifleBase,
      `${fx.presentationMs(10, "rifle", "flechette")} vs ${fx.presentationMs(10, "rifle")}`);
    // ⭐ THE RULED PROPERTY of the impact promotion: it changes the MARK, not the CLOCK. The two
    // promoted assets are 2.7x and 6x the ordinary impact's length, and the trim is what keeps the
    // apply window exactly where it was.
    ok("tail threading: an impact promotion does NOT move the window — the promoted mark is trimmed",
      fx.presentationTailMs("rifle", "api") === rifleBase
      && fx.presentationTailMs("rifle", "ap") === rifleBase
      && fx.presentationTailMs("shotgun", "api") === shellBase,
      `api ${fx.presentationTailMs("rifle", "api")} / ap ${fx.presentationTailMs("rifle", "ap")} / base ${rifleBase}`);
    ok("tail threading: and the promoted assets really ARE much longer than the mark they replace",
      fx.IMPACT_FIRE.clipMs > 2 * fx.HIT_CONFIRM.clipMs && fx.IMPACT_CRACK.clipMs > 5 * fx.HIT_CONFIRM.clipMs,
      `${fx.IMPACT_FIRE.clipMs} / ${fx.IMPACT_CRACK.clipMs} vs ${fx.HIT_CONFIRM.clipMs}`);
    // ⭐ THE BATON PAIR IS THE ONE OVERLAY THAT GENUINELY MOVES THE WINDOW, and it must, because it
    // genuinely slows the round: it hands every class a 240ms crossing where the flechette hands one
    // 170ms and the shell's own buckshot crosses in 150. The window opening early is the silent failure
    // this whole section exists to catch, so the arithmetic is asserted by value on every class rather
    // than as "it got bigger".
    // ⏪ The `=== presentationTailMs(c,"stundart")` term was dropped from this loop on 2026-08-09: the
    // stun dart stopped being the baton's twin (the realism razor), so the two loads legitimately carry
    // different tails now. The stun dart's own tail is asserted against the FLECHETTE's in the dart
    // section, which is where it belongs.
    for (const c of ["pistol", "smg", "rifle", "shotgun", "heavy"]) {
      ok(`tail threading: the baton round's crossing time moves ${c}'s tail, by the arithmetic`,
        fx.presentationTailMs(c, "rubber") === fx.BATON_ROUND.crossMs + fx.HIT_CONFIRM.clipMs
        && fx.presentationTailMs(c, "rubber") === 1073
        && fx.presentationTailMs(c, "rubber") > fx.presentationTailMs(c),
        `${c}: ${fx.presentationTailMs(c)} -> ${fx.presentationTailMs(c, "rubber")}`);
    }
    ok("tail threading: and the stun dart no longer shares it — it takes the DART tail instead",
      ["pistol", "smg", "rifle", "shotgun", "heavy"].every(c =>
        fx.presentationTailMs(c, "stundart") === fx.presentationTailMs(c, "flechette")
        && fx.presentationTailMs(c, "stundart") !== fx.presentationTailMs(c, "rubber")),
      ["pistol", "rifle", "shotgun"].map(c => `${c}:${fx.presentationTailMs(c, "stundart")}`).join(" "));
    ok("tail threading: the dust mark contributes its TRIM and not its own clip, so the move is the crossing only",
      fx.presentationTailMs("rifle", "rubber") - fx.presentationTailMs("rifle", "flechette")
        === fx.BATON_ROUND.crossMs - E("rifle", "flechette").dashMs
      && fx.presentationTailMs("rifle", "rubber") < fx.PRESENTATION_CAP_MS,
      `rubber ${fx.presentationTailMs("rifle", "rubber")} vs flechette ${fx.presentationTailMs("rifle", "flechette")}`);

    /* ── g. THE BURNING GROUND — asset, placement, bounds, and the settle exclusion ──
     *
     * ⏪⏪ THIS SECTION WAS REWRITTEN (2026-08-09). The design it used to pin — ONE `ground_cracks`
     * effect at the aim point for 3200ms — was rejected on report: "it looks like a ground shock
     * effect of some kind, not fire. It darkens and cools … I was picturing something more like
     * little animated flame decals that stayed burning on the ground in the places the shots landed,
     * not just on the target." So the legs below assert the OPPOSITE of two facts the old ones
     * asserted (the lifetime is tens of seconds, not a few; the placement is N points, not one), and
     * the rejected asset is now pinned as appearing on NO shipped row — the same shape the retired
     * baton matrix is held out by. */
    ok("burning ground: the shipped asset is a FLAME family, and the rejected crack is not it",
      /flames/i.test(fx.GROUND_FIRE.key)
      && !/ground_crack/i.test(fx.GROUND_FIRE.key)
      && fx.GROUND_FIRE.key !== "jb2a.ground_cracks.orange",
      fx.GROUND_FIRE.key);
    // The crack family is not banished from the file — it is still the armour-piercing load's IMPACT
    // mark, which is a different element and was never the thing reported. This leg says exactly that,
    // so a future reader does not "tidy" the two together again.
    ok("burning ground: the crack survives only as the armour-piercing IMPACT, which is a different mark",
      /ground_crack/i.test(fx.IMPACT_CRACK.key)
      && fx.AMMO_FX.ap.impactKey === fx.IMPACT_CRACK.key
      && fx.IMPACT_CRACK.key !== fx.GROUND_FIRE.key,
      `${fx.IMPACT_CRACK.key} vs ${fx.GROUND_FIRE.key}`);
    // ⏪ AND THE INCENDIARY LOAD NOW PROMOTES NOTHING AT ALL, so the burning GROUND is the only fire
    // it draws — which is the whole of the 2026-08-09 ruling, said here where the two were confused.
    ok("burning ground: the incendiary load's only fire is the GROUND — no mark is stamped on the target",
      fx.AMMO_FX.api.impactKey === undefined && fx.AMMO_FX.api.groundFire === true,
      JSON.stringify({ impactKey: fx.AMMO_FX.api.impactKey ?? null, groundFire: fx.AMMO_FX.api.groundFire }));
    // ⭐ THE REPORT, MEASURED OFF THE INSTALLED FILE. "It darkens and cools" is a claim about frames,
    // so it is answered with frames: the clip is sampled across its own length and the last third must
    // not be dimmer than the middle. A file that decayed inside its loop would leave a dead patch of
    // ground burning for 45 seconds, which is the failure this element was rebuilt to avoid.
    try {
      const src = (() => {
        const e = Sequencer.Database.getEntry(fx.GROUND_FIRE.key);
        if (typeof e === "string") return e;
        if (typeof e?.getAllFiles === "function") { const l = e.getAllFiles(); return typeof l?.[0] === "string" ? l[0] : (l?.[0]?.file ?? null); }
        return e?.file ?? null;
      })();
      const v = document.createElement("video");
      v.src = src; v.muted = true;
      await new Promise((done, bad) => { v.onloadedmetadata = done; v.onerror = () => bad(new Error("load")); setTimeout(() => bad(new Error("timeout")), 15000); });
      const cv = document.createElement("canvas"); cv.width = 96; cv.height = 96;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      const means = [];
      for (let i = 0; i < 9; i++) {
        await new Promise((done) => { v.onseeked = done; v.currentTime = (v.duration * (i + 0.5)) / 9; setTimeout(done, 2500); });
        ctx.clearRect(0, 0, 96, 96); ctx.drawImage(v, 0, 0, 96, 96);
        const d = ctx.getImageData(0, 0, 96, 96).data;
        let s = 0;
        for (let p = 0; p < d.length; p += 4) s += (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) * (d[p + 3] / 255);
        means.push(s / (96 * 96));
      }
      const mid = means.slice(2, 6).reduce((a, b) => a + b, 0) / 4;
      const tail = means.slice(-3).reduce((a, b) => a + b, 0) / 3;
      out.groundFireDecode = { durMs: Math.round(v.duration * 1000), means: means.map(m => +m.toFixed(1)), ratio: +(tail / mid).toFixed(2) };
      ok("burning ground: the installed clip does NOT decay — its tail is as bright as its middle",
        v.duration * 1000 >= 3000 && tail / mid >= 0.9 && mid > 1,
        JSON.stringify(out.groundFireDecode));
      v.src = "";
    } catch (err) {
      ok("burning ground: the installed clip does NOT decay — its tail is as bright as its middle",
        false, `decode failed: ${String(err?.message ?? err)}`);
    }
    ok("burning ground: the fire is TENS OF SECONDS and it is CAPPED",
      fx.GROUND_FIRE.lifetimeMs >= 20000 && fx.GROUND_FIRE.lifetimeMs <= 120000
      && Number.isFinite(fx.GROUND_FIRE.lifetimeMs),
      `fire ${fx.GROUND_FIRE.lifetimeMs}ms`);
    // ⏪ THE GROUND MARK IS GONE (user ruling 2026-08-10, verbatim "kill it"). The long-lived dark
    // decal that used to be drawn under the flames is removed outright — the constant, the draw and
    // the two fields it reported. These legs pin the ABSENCE at all three levels so a later edit
    // cannot quietly reinstate a dead field or a half-wired element: the module exports no constant
    // for it, and the verb's return shape carries no key for it either.
    ok("ground mark removal: the module exports no constant for the withdrawn decal",
      fx.GROUND_SCORCH === undefined && !("GROUND_SCORCH" in fx),
      String(fx.GROUND_SCORCH));
    {
      // Both verbs are asked for NOTHING, which exercises the return shape without putting anything on
      // the canvas: an empty point list and a zero-length ray both take their own early return, and
      // that object is the same literal the drawn path fills in.
      const shape = await fx.fxGroundFire([]);
      const empty = await fx.fxPatternGroundFire({ x: 0, y: 0, dirDeg: 0, lengthPx: 0, widthPx: 0, count: 0 });
      ok("ground mark removal: the ground-fire verb reports FIRES ONLY — no decal fields, dead or live",
        !("scorch" in shape) && !("scorchMs" in shape) && Number.isFinite(shape.fires)
        && !("scorch" in empty) && !("scorchMs" in empty) && Number.isFinite(empty.fires),
        `${JSON.stringify(Object.keys(shape))} / ${JSON.stringify(Object.keys(empty))}`);
    }
    // ⭐ THE REPORTED DEFECT AS A NUMBER. The old element spent 900ms of a 3200ms life fading — 28% of
    // it was a dim-down, which is what "darkens and cools" describes. The replacement's fade must be a
    // burn-DOWN at the very end, not a dim-through.
    ok("burning ground: the fade is a small tail of the life, not a quarter of it",
      fx.GROUND_FIRE.fadeOutMs / fx.GROUND_FIRE.lifetimeMs < 0.1
      && 900 / 3200 > 0.25,
      `${fx.GROUND_FIRE.fadeOutMs}/${fx.GROUND_FIRE.lifetimeMs} = ${(fx.GROUND_FIRE.fadeOutMs / fx.GROUND_FIRE.lifetimeMs).toFixed(3)}`);
    ok("burning ground: every bound is declared — per payload, per pattern, and per scene",
      fx.GROUND_FIRE.maxPerPayload > 0 && fx.GROUND_FIRE.maxPerPayload <= 8
      && fx.GROUND_FIRE.maxPerPattern > 0 && fx.GROUND_FIRE.maxPerPattern <= 8
      && fx.GROUND_FIRE.maxLive >= fx.GROUND_FIRE.maxPerPayload && fx.GROUND_FIRE.maxLive <= 64,
      JSON.stringify({ payload: fx.GROUND_FIRE.maxPerPayload, pattern: fx.GROUND_FIRE.maxPerPattern, live: fx.GROUND_FIRE.maxLive }));
    ok("burning ground: the fire is not waited for — the tail is far shorter than it, under the cap",
      fx.presentationTailMs("rifle", "api") < fx.GROUND_FIRE.lifetimeMs
      && fx.presentationMs(30, "rifle", "api") < fx.PRESENTATION_CAP_MS,
      `tail ${fx.presentationTailMs("rifle", "api")} / 30-round span ${fx.presentationMs(30, "rifle", "api")}`);
    // ⭐ THE EXCLUSION IS STRUCTURAL, and this is the leg that says so: the window a burning payload
    // waits for is IDENTICAL to the one an ordinary payload waits for on the same class. If a term for
    // the fire ever crept into the arithmetic, this is where a 45-second wait would appear.
    ok("burning ground: the apply window is byte-identical with the fire and without it (exclusion)",
      ["pistol", "smg", "rifle", "shotgun", "heavy"].every(c =>
        fx.presentationTailMs(c, "api") === fx.presentationTailMs(c, "standard")),
      ["pistol", "smg", "rifle", "shotgun", "heavy"].map(c => `${c}:${fx.presentationTailMs(c, "api")}`).join(" "));

    /* ── g2. WHERE THE FLAMES GO — the two planners, by value ────────────────── */
    const FROM = { x: 1000, y: 1000 }, AIM = { x: 1800, y: 1000 };
    // The fanned branch: the points ARE the pellet endpoints, so they must every one be a member of the
    // fan the tracer draws with the same arguments — not merely near it.
    const fan = fx.pelletEndpoints(FROM, AIM, { pellets: 6, spreadRad: 0.07, hit: true });
    const fanFires = fx.groundFirePoints(FROM, AIM, { landed: 3, pellets: 6, spreadRad: 0.07, max: 4 });
    const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 0.001;
    ok("flame points: a FANNED class sets fire at its own pellet endpoints, not near them",
      fanFires.length === 3 && fanFires.every(p => fan.some(q => near(p, q))),
      JSON.stringify(fanFires.map(p => `${Math.round(p.x)},${Math.round(p.y)}`)));
    ok("flame points: those picks SPAN the fan rather than clustering on one side of it",
      new Set(fanFires.map(p => fan.findIndex(q => near(p, q)))).size === 3
      && Math.max(...fanFires.map(p => fan.findIndex(q => near(p, q)))) >= 4
      && Math.min(...fanFires.map(p => fan.findIndex(q => near(p, q)))) <= 1,
      fanFires.map(p => fan.findIndex(q => near(p, q))).join(","));
    ok("flame points: the payload bound wins over the pellet count",
      fx.groundFirePoints(FROM, AIM, { landed: 30, pellets: 6, spreadRad: 0.07, max: 4 }).length === 4
      && fx.groundFirePoints(FROM, AIM, { landed: 30, pellets: 6, spreadRad: 0.07 }).length === fx.GROUND_FIRE.maxPerPayload,
      String(fx.GROUND_FIRE.maxPerPayload));
    // The single-bolt branch: one point per landed round, scattered inside the disc, never outside it.
    const scatterPx = fx.GROUND_FIRE.scatterSquares * 100;
    const boltFires = fx.groundFirePoints(FROM, AIM, { landed: 3, scatterPx, seed: 12345 });
    ok("flame points: a SINGLE-BOLT class sets one fire per landed round, inside the scatter disc",
      boltFires.length === 3
      && boltFires.every(p => Math.hypot(p.x - AIM.x, p.y - AIM.y) <= scatterPx + 0.001),
      boltFires.map(p => Math.round(Math.hypot(p.x - AIM.x, p.y - AIM.y))).join(","));
    ok("flame points: and they are not all the same point — the burst covers ground (negative)",
      new Set(boltFires.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)).size === 3);
    ok("flame points: fewer rounds landed means fewer fires, and one round means one",
      fx.groundFirePoints(FROM, AIM, { landed: 1, scatterPx, seed: 1 }).length === 1
      && fx.groundFirePoints(FROM, AIM, { landed: 2, scatterPx, seed: 1 }).length === 2);
    ok("flame points: no aim, no fire (negative)",
      fx.groundFirePoints(null, AIM, { landed: 4 }).length === 0
      && fx.groundFirePoints(FROM, null, { landed: 4 }).length === 0);
    // ⭐ DETERMINISM, computed twice and compared. This is the property that lets two clients place the
    // same fires from the same payload, and the only way a scatter can be pinned without pinning pictures.
    const twiceA = fx.groundFirePoints(FROM, AIM, { landed: 4, scatterPx, seed: 987 });
    const twiceB = fx.groundFirePoints(FROM, AIM, { landed: 4, scatterPx, seed: 987 });
    const other = fx.groundFirePoints(FROM, AIM, { landed: 4, scatterPx, seed: 988 });
    ok("flame points: the same seed gives the SAME points, to the value",
      eq(twiceA, twiceB) && twiceA.length === 4, JSON.stringify(twiceA[0]));
    ok("flame points: a different seed gives different points (so the seed is really the source)",
      !eq(twiceA, other));
    ok("flame points: the seed itself is derived from payload fields, and it spreads them",
      fx.fxSeedOf("a", "b", 1) === fx.fxSeedOf("a", "b", 1)
      && fx.fxSeedOf("a", "b", 1) !== fx.fxSeedOf("a", "b", 2)
      && Number.isInteger(fx.fxSeedOf("x")) && fx.fxSeedOf("x") >= 0,
      String(fx.fxSeedOf("a", "b", 1)));

    /* ── g3. THE SHOT PATTERN'S FIRES — inside the real polygon, by the real test ── */
    // Construction is analytic (ray-local coordinates rotated out); the CHECK is the module's own
    // containment test against the polygon the pattern is actually drawn with. Two different pieces of
    // arithmetic on purpose — a scatter that agreed with itself would prove nothing.
    const geo = await import(`/modules/${SCOPE}/module/combat/area-geometry.js`);
    const RAY = { x: 500, y: 700, dirDeg: 35, lengthPx: 1400, widthPx: 200 };
    const poly = geo.rayPolygonPoints(RAY.x, RAY.y, RAY.dirDeg, RAY.lengthPx, RAY.widthPx);
    const patPts = fx.patternFirePoints({ ...RAY, seed: 4242 });
    ok("pattern fires: every scattered point is INSIDE the pattern, by the module's own containment test",
      patPts.length === fx.GROUND_FIRE.maxPerPattern
      && patPts.every(p => geo.pointInPolygon(p.x, p.y, poly)),
      `${patPts.filter(p => geo.pointInPolygon(p.x, p.y, poly)).length}/${patPts.length} inside`);
    ok("pattern fires: none of them burns on the shooter's own end of the ray (negative)",
      patPts.every(p => Math.hypot(p.x - RAY.x, p.y - RAY.y) >= RAY.lengthPx * 0.29),
      patPts.map(p => Math.round(Math.hypot(p.x - RAY.x, p.y - RAY.y))).join(","));
    ok("pattern fires: they spread ALONG the ray rather than sitting in one place",
      new Set(patPts.map(p => Math.round(Math.hypot(p.x - RAY.x, p.y - RAY.y) / 100))).size >= 2);
    ok("pattern fires: deterministic from the pattern's own recorded facts",
      eq(fx.patternFirePoints({ ...RAY, seed: 4242 }), patPts)
      && !eq(fx.patternFirePoints({ ...RAY, seed: 4243 }), patPts));
    ok("pattern fires: the per-pattern bound cannot be argued past",
      fx.patternFirePoints({ ...RAY, count: 99, seed: 1 }).length === fx.GROUND_FIRE.maxPerPattern
      && fx.patternFirePoints({ ...RAY, lengthPx: 0, seed: 1 }).length === 0,
      String(fx.GROUND_FIRE.maxPerPattern));

    /* ── g4. WHICH FLOW OWNS THE FIRE — the same call the damage rail makes ───── */
    ok("flow gate: a shell's buckshot payload belongs to the PATTERN flow, so the rail draws no fire",
      fx.patternFlowOwns({ caliber: "00" }) === true
      && fx.patternFlowOwns({ caliber: "12ga" }) === true,
      "buck / gauge alias");
    ok("flow gate: the slug load and every non-shotgun cartridge belong to the single-target flow",
      fx.patternFlowOwns({ caliber: "00", modifier: "slug" }) === false
      && fx.patternFlowOwns({ caliber: "5.56" }) === false
      && fx.patternFlowOwns({ caliber: "" }) === false
      && fx.patternFlowOwns({}) === false,
      "slug / rifle / blank / empty");
    ok("flow gate: it is the CARTRIDGE that is asked — a stored single flag cannot suppress a pattern",
      fx.patternFlowOwns({ caliber: "00", spreadMode: "single" }) === true,
      "every seeded shell ammo carries spreadMode:single");

    /* ── g4b. THE WORLD SWITCH IS PART OF THE SAME ANSWER ──────────────────────
     * ⏪ This reverses what this file used to assert. The flow question deliberately ignored the
     * pattern's world setting, on the reasoning that neither damage gate consulted it either — and
     * that was the defect, not the design: with the pattern switched OFF the single-target gate stood
     * down for the cartridge and the pattern hook stood down for the setting, so a shell was claimed
     * by NEITHER flow, opened no apply window and threw no pattern. The switch now lives in the one
     * shared site all three callers ask, so "off" means every shell takes the ordinary route exactly
     * as the slug already does. The setting is toggled here and restored in the same breath. */
    const spreadWas = game.settings.get(SCOPE, "shotgunSpreadEnabled");
    let offOwns = null;
    try {
      await game.settings.set(SCOPE, "shotgunSpreadEnabled", false);
      offOwns = {
        buck: fx.patternFlowOwns({ caliber: "00" }),
        alias: fx.patternFlowOwns({ caliber: "12ga" }),
        flechette: fx.patternFlowOwns({ caliber: "00", spreadMode: "flechette" }),
        slugStill: fx.patternFlowOwns({ caliber: "00", modifier: "slug" }),
        rifleStill: fx.patternFlowOwns({ caliber: "5.56" }),
      };
    } finally {
      await game.settings.set(SCOPE, "shotgunSpreadEnabled", spreadWas);
    }
    ok("flow gate: with the pattern SWITCHED OFF a shell is slug-like — the single-target flow owns it",
      offOwns.buck === false && offOwns.alias === false && offOwns.flechette === false,
      JSON.stringify(offOwns));
    ok("flow gate: the loads that were already single stay single with it off (negative)",
      offOwns.slugStill === false && offOwns.rifleStill === false, JSON.stringify(offOwns));
    ok("flow gate: and switching it back restores the pattern's ownership, to the value",
      game.settings.get(SCOPE, "shotgunSpreadEnabled") === spreadWas
      && fx.patternFlowOwns({ caliber: "00" }) === (spreadWas === true),
      `setting=${game.settings.get(SCOPE, "shotgunSpreadEnabled")}`);

    /* ── h. the flash tint goes THROUGH the darkness gate, never around it ──── */
    const tint = fx.AMMO_FX.api.flashColor;
    ok("flash tint: in the DARK the ammo colour replaces the reference colour",
      fx.flashColorFor(1, tint) === tint && fx.flashColorFor(1, null) === fx.MUZZLE_LIGHT.referenceColor,
      `${fx.flashColorFor(1, tint)} / ${fx.flashColorFor(1, null)}`);
    ok("flash tint: in the LIGHT it is null — the gate answers before the ammo is consulted (negative)",
      fx.flashColorFor(0, tint) === null && fx.flashColorFor(0.1, tint) === null
      && fx.flashColorFor(NaN, tint) === null,
      `${fx.flashColorFor(0, tint)} / ${fx.flashColorFor(0.1, tint)}`);
    const th = fx.MUZZLE_LIGHT.darknessColorThreshold;
    ok("flash tint: the threshold is the same one the reference colour uses, to the value",
      fx.flashColorFor(th, tint) === tint && fx.flashColorFor(th - 0.001, tint) === null,
      `threshold ${th}`);
    ok("flash tint: the built SOURCE SPEC carries it in the dark and nothing in the light",
      fx.muzzleSourceSpecs({ darkness: 1, ammoColor: tint })[0].color === tint
      && fx.muzzleSourceSpecs({ darkness: 0, ammoColor: tint })[0].color === null
      && fx.muzzleSourceSpecs({ darkness: 1 })[0].color === fx.MUZZLE_LIGHT.referenceColor,
      JSON.stringify(fx.muzzleSourceSpecs({ darkness: 1, ammoColor: tint }).map(s => s.color)));

    /* ── i. LIVE: what the fan-out actually queues ──────────────────────────── */
    const scene = game.scenes.active;
    for (const a of [...game.actors].filter(a => a.name?.startsWith("__PW__AMMO"))) await a.delete();
    for (const t of [...(scene?.tokens ?? [])].filter(t => t.name?.startsWith("__PW__AMMO"))) await t.delete();
    const shooterActor = await Actor.create({ name: "__PW__AMMO Shooter", type: "character" });
    const targetActor = await Actor.create({ name: "__PW__AMMO Target", type: "character" });
    const [rifleItem] = await shooterActor.createEmbeddedDocuments("Item", [{
      name: "__PW__AMMO rifle", type: "weapon",
      system: { weaponType: "Rifle", attackType: "Auto", damage: "1d6", range: 50, rof: 1, shots: 40, shotsLeft: 40 },
    }]);
    const [shooterDoc, targetDoc] = await scene.createEmbeddedDocuments("Token", [
      { name: "__PW__AMMO Shooter", actorId: shooterActor.id, x: 1000, y: 1500, width: 1, height: 1 },
      { name: "__PW__AMMO Target", actorId: targetActor.id, x: 1700, y: 1500, width: 1, height: 1 },
    ]);
    await sleep(400);
    const shooterTok = canvas.tokens.get(shooterDoc.id);
    const targetTok = canvas.tokens.get(targetDoc.id);

    // Silence the shot audio for this whole section — the legs are about pictures.
    const AH = foundry.audio.AudioHelper;
    const realPlay = AH.play;
    AH.play = () => null;

    // ONE tap on the engine's creation hook, so "what was queued" is read from the engine rather than
    // from our own return values where it matters (the once-per-payload gate).
    const spawned = [];
    const spawnHook = Hooks.on("createSequencerEffect", (e) => {
      const f = String(e?.data?.file ?? e?.data?.src ?? "");
      if (f) spawned.push(f);
    });
    const clearSpawns = () => { spawned.length = 0; };
    const endAll = async () => { try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* nothing running */ } await sleep(250); };

    // fxShot, per treatment: which impact asset was queued and how wide.
    const plainShot = await fx.fxShot(shooterTok, targetTok, { weaponClass: "rifle", hit: true, light: false });
    ok("live: with no ammo key the ordinary impact is queued, at the class's own width",
      plainShot.impactKey === fx.HIT_CONFIRM.key && plainShot.impactSquares === fx.FX_CLASSES.rifle.impactSquares
      && plainShot.impactClipMs === fx.HIT_CONFIRM.clipMs && plainShot.pellets === 1,
      JSON.stringify({ key: plainShot.impactKey, w: plainShot.impactSquares, clip: plainShot.impactClipMs }));
    const apiShot = await fx.fxShot(shooterTok, targetTok, { weaponClass: "rifle", hit: true, light: false, ammoKey: "api" });
    // ⏪ RE-PINNED 2026-08-09: the incendiary load queues the ORDINARY mark now — identical to the
    // no-ammo shot above, which is the checkable form of "the promotion was withdrawn".
    ok("live: the incendiary load queues the ORDINARY impact — the same mark an unpromoted round draws",
      apiShot.impactKey === fx.HIT_CONFIRM.key && apiShot.impactKey === plainShot.impactKey
      && apiShot.impactClipMs === fx.HIT_CONFIRM.clipMs && apiShot.impactSquares === plainShot.impactSquares,
      JSON.stringify({ key: apiShot.impactKey, clip: apiShot.impactClipMs, w: apiShot.impactSquares }));
    const apShot = await fx.fxShot(shooterTok, targetTok, { weaponClass: "rifle", hit: true, light: false, ammoKey: "ap" });
    ok("live: the armour-piercing load queues the CRACK impact",
      apShot.impactKey === fx.IMPACT_CRACK.key, apShot.impactKey);
    // ⏪⏪ INVERTED (2026-08-09, the realism razor). This leg asserted a wider hollow-point mark and a
    // narrower safety one. Both rows were deleted because that difference is not one a viewer can read,
    // so the live leg now asserts the SAMENESS on the same three real shots — which is what bench guns
    // 01, 02 and 03 exist to show a reviewer.
    const hpShot = await fx.fxShot(shooterTok, targetTok, { weaponClass: "rifle", hit: true, light: false, ammoKey: "hollowPoint" });
    const sfShot = await fx.fxShot(shooterTok, targetTok, { weaponClass: "rifle", hit: true, light: false, ammoKey: "safety" });
    ok("live: hollow-point, safety and plain draw the SAME mark at the SAME width — guns 01/02/03 agree",
      hpShot.impactSquares === plainShot.impactSquares && sfShot.impactSquares === plainShot.impactSquares
      && hpShot.impactKey === fx.HIT_CONFIRM.key && sfShot.impactKey === fx.HIT_CONFIRM.key
      && hpShot.pellets === plainShot.pellets && sfShot.pellets === plainShot.pellets,
      `${sfShot.impactSquares} == ${plainShot.impactSquares} == ${hpShot.impactSquares}`);
    // ⏪ RE-PINNED 2026-08-10 (the single-file ruling, §21): this asserted eight queued marks off one
    // round. The load now queues one — the same count the plain round queues — and what it changes is
    // the mark's own width and colour, which is what this leg reads instead.
    const flShot = await fx.fxShot(shooterTok, targetTok, { weaponClass: "rifle", hit: true, light: false, ammoKey: "flechette" });
    ok("live: the dart load queues ONE mark off one round, exactly as the plain round does",
      flShot.pellets === 1 && plainShot.pellets === 1
      && flShot.impactSquares === Number((fx.FX_CLASSES.rifle.impactSquares * 0.7).toFixed(4))
      && flShot.impactSquares !== plainShot.impactSquares,
      `${plainShot.pellets} -> ${flShot.pellets}, mark ${plainShot.impactSquares} -> ${flShot.impactSquares}`);
    // THE BATON PAIR, driven rather than resolved: the swap is an ASSET change, so the leg reads which
    // file the ENGINE was handed rather than trusting the merge it already asserted above.
    await endAll();
    clearSpawns();
    const rubShot = await fx.fxShot(shooterTok, targetTok, { weaponClass: "rifle", hit: true, light: false, ammoKey: "rubber" });
    await sleep(250);
    const isBaton = (f) => /cannon_ball|LaunchCannonBall/i.test(f);
    const isDust = (f) => /smoke\.puff\.ring|SmokePuffRing/i.test(f);
    ok("live: the baton load hands the engine the SLUG asset in place of the class bullet",
      spawned.some(isBaton) && !spawned.some(f => /bullet\.02|Bullet_02/i.test(f)),
      spawned.join(" | ").slice(0, 220));
    ok("live: and the DUST mark in place of the spark, at the class's own width",
      rubShot.impactKey === fx.IMPACT_DUST.key && spawned.some(isDust)
      && rubShot.impactSquares === plainShot.impactSquares
      && rubShot.impactClipMs === fx.HIT_CONFIRM.clipMs,
      JSON.stringify({ key: rubShot.impactKey, w: rubShot.impactSquares, clip: rubShot.impactClipMs }));
    ok("live: a painted-bolt class draws ONE travelled slug, not a fan (negative)",
      rubShot.pellets === 1 && rubShot.tracer === true, String(rubShot.pellets));
    await endAll();
    clearSpawns();
    // ⏪⏪ REWRITTEN 2026-08-09. This drove `stundart` on the shell and asserted six baton slugs plus a
    // discharge column. Both halves are now false on purpose — the column is deleted and the stun dart
    // is a needle fan rather than the baton's twin — so the drive stays on `rubber`, which is where the
    // baton treatment now lives alone, and the stun dart gets its own live leg beneath it.
    const rubShell = await fx.fxShot(shooterTok, targetTok, { weaponClass: "shotgun", hit: true, light: false, ammoKey: "rubber" });
    await sleep(250);
    ok("live: on the shell the baton load draws the shell's OWN shot count as slugs, and no column",
      rubShell.pellets === fx.FX_CLASSES.shotgun.pellets && rubShell.column === undefined
      && spawned.filter(isBaton).length === fx.FX_CLASSES.shotgun.pellets
      && rubShell.impactKey === fx.IMPACT_DUST.key,
      JSON.stringify({ pellets: rubShell.pellets, column: rubShell.column ?? null, slugs: spawned.filter(isBaton).length }));
    await endAll();
    clearSpawns();
    const stunShell = await fx.fxShot(shooterTok, targetTok, { weaponClass: "shotgun", hit: true, light: false, ammoKey: "stundart" });
    await sleep(250);
    // ⏪ RE-PINNED 2026-08-11 (the single-file ruling extended to this load — §21): it asserted EIGHT,
    // which was the overlay's own count. The row names none now, so a shell draws the SHELL's six — the
    // "if it's fired from a shotgun, no" half of the ruling, read on the live draw path. What this leg
    // is really about is unchanged: darts of the class bullet, never a baton slug.
    ok("live: the stun dart draws the SHELL's own darts of the class bullet, and no baton slug anywhere (negative)",
      stunShell.pellets === fx.FX_CLASSES.shotgun.pellets && spawned.filter(isBaton).length === 0
      && spawned.some(f => /bullet\.01|Bullet_01/i.test(f))
      && stunShell.impactKey === fx.HIT_CONFIRM.key
      && stunShell.impactSquares === Number((fx.FX_CLASSES.shotgun.impactSquares * 0.7).toFixed(4)),
      JSON.stringify({ pellets: stunShell.pellets, slugs: spawned.filter(isBaton).length, impact: stunShell.impactKey, w: stunShell.impactSquares }));
    await endAll();
    clearSpawns();
    // The miss branch is untouched by any of this — an overlay changes the mark, not whether there is one.
    const missShot = await fx.fxShot(shooterTok, targetTok, { weaponClass: "rifle", hit: false, light: false, ammoKey: "api" });
    ok("live: a MISS still draws no impact whatever is loaded (negative)",
      missShot.impact === false && missShot.impactKey === undefined, JSON.stringify(missShot.impact));
    await endAll();

    // THE PLACEMENT GATE. ⏪ It used to read "ONE fire per payload" and now reads "ONE placement EVENT
    // per payload, producing N flames" — the bound it protects is unchanged and is what these legs
    // pin: the fan-out caps at thirty rounds, so a per-ROUND lingering element would be thirty fires
    // on one square for one trigger pull, and `maxPerPayload` holds the placement itself down.
    const payload = (over = {}) => ({
      attackerId: shooterActor.id, weaponId: rifleItem.id, weaponName: "__PW__AMMO rifle",
      targetTokenId: targetDoc.id, areaDamages: {}, ...over,
    });
    // ⚠ The engine reports the DATABASE KEY on `data.file`, not the resolved file path (verified on
    // this rig: an effect comes back as "jb2a.flames.orange.03.1x1"). Matching the asset's filename
    // instead silently matched nothing and read as "the gate never fired".
    const isFire = (f) => /flames\.orange|Flames03/i.test(f);
    // ⏪ THIS PREDICATE IS NOW A NEGATIVE ONLY — it names the WITHDRAWN ground mark (user ruling
    // 2026-08-10) and every leg below asserts its count is zero. It is kept rather than deleted so the
    // withdrawal is pinned by the same census that used to prove the element was drawn.
    const isScorch = (f) => /scorched_earth|ScorchedEarth/i.test(f);
    clearSpawns();
    const burst = await fx.fxWeaponFired(payload({
      modifier: "api", shotsFired: 10, shotsHit: 4,
      areaDamages: { Torso: [{ damage: 3 }, { damage: 3 }, { damage: 2 }, { damage: 2 }] },
    }));
    await sleep(1600);
    ok("live: the fan-out resolved the load off the payload and reports it",
      burst.ammoKey === "api" && burst.shots === 10 && burst.weaponClass === "rifle",
      JSON.stringify({ ammoKey: burst.ammoKey, shots: burst.shots }));
    // ⏪ THE DECAL HALF OF THIS LEG IS INVERTED (user ruling 2026-08-10): it used to require ONE mark
    // under the flames and now requires NONE. The census is read the same way, off the effects the
    // engine actually created, so the leg proves the element is gone from the canvas and not merely
    // from the constants.
    ok("live: a ten-round incendiary burst sets FOUR fires (one per landed round, at the bound) and NO ground mark",
      spawned.filter(isFire).length === Math.min(4, fx.GROUND_FIRE.maxPerPayload)
      && spawned.filter(isScorch).length === 0
      && burst.groundFire?.points === Math.min(4, fx.GROUND_FIRE.maxPerPayload),
      `${spawned.filter(isFire).length} fire / ${spawned.filter(isScorch).length} ground mark of ${spawned.length} effects`);
    // ⭐ THE POINTS THE FAN-OUT USED ARE THE POINTS THE PLANNER PREDICTS, recomputed from the seed the
    // fan-out reported. This is what makes the scatter a property of the payload rather than of the run.
    {
      const gp = Number(canvas?.dimensions?.size) || 100;
      const want = fx.groundFirePoints(
        { x: shooterTok.center.x, y: shooterTok.center.y }, { x: targetTok.center.x, y: targetTok.center.y },
        { landed: 4, scatterPx: fx.GROUND_FIRE.scatterSquares * gp, max: fx.GROUND_FIRE.maxPerPayload, seed: burst.groundFire.seed })
        .map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
      ok("live: the fires stand exactly where the seeded plan says, recomputed independently",
        eq(want, burst.groundFire.at), JSON.stringify(burst.groundFire.at));
      ok("live: and no two of them are on the same spot (the burst covers ground, negative)",
        new Set(burst.groundFire.at.map(p => `${p.x},${p.y}`)).size === burst.groundFire.at.length);
    }
    await endAll();

    // ⭐ THE EITHER/OR. A shell's buckshot payload belongs to the PATTERN flow, so the rail must set
    // nothing alight — the fires for that shot are scattered down the pattern when the GM confirms it.
    // Drawing both would set one shot alight twice.
    clearSpawns();
    const buckBurst = await fx.fxWeaponFired(payload({
      modifier: "api", caliber: "00", shotsFired: 3, shotsHit: 2,
      areaDamages: { Torso: [{ damage: 5 }, { damage: 4 }] },
    }));
    await sleep(1200);
    ok("live: a PATTERN payload draws no ground fire on the rail — the pattern flow owns it (negative)",
      buckBurst.groundFire === null && spawned.filter(isFire).length === 0 && spawned.filter(isScorch).length === 0
      && fx.patternFlowOwns({ caliber: "00", modifier: "api" }) === true,
      `${spawned.filter(isFire).length} fire / ${spawned.filter(isScorch).length} scorch`);
    await endAll();

    // ⭐ AND THE OTHER SIDE OF THE SAME SWITCH, DRIVEN. With the pattern mechanic off there is no
    // confirm to scatter an incendiary shell's fires down a path, so the fan-out must set them itself —
    // the identical payload, the opposite answer, and the difference is one world setting. This is the
    // presentation half of the ownership fix: the rail follows the mechanics without knowing the
    // setting exists. Restored in a `finally`, so a failing assertion cannot leave the world switched.
    const spreadWasLive = game.settings.get(SCOPE, "shotgunSpreadEnabled");
    let offBurst = null, offFires = 0, offScorch = 0;
    try {
      await game.settings.set(SCOPE, "shotgunSpreadEnabled", false);
      clearSpawns();
      offBurst = await fx.fxWeaponFired(payload({
        modifier: "api", caliber: "00", shotsFired: 3, shotsHit: 2,
        areaDamages: { Torso: [{ damage: 5 }, { damage: 4 }] },
      }));
      await sleep(1600);
      offFires = spawned.filter(isFire).length;
      offScorch = spawned.filter(isScorch).length;
    } finally {
      await game.settings.set(SCOPE, "shotgunSpreadEnabled", spreadWasLive);
    }
    ok("live: with the pattern OFF the same incendiary shell's fires are drawn by the RAIL again",
      offBurst?.groundFire !== null && offFires > 0 && offFires <= fx.GROUND_FIRE.maxPerPayload && offScorch === 0,
      `${offFires} fire / ${offScorch} ground mark, was 0/0 with the pattern on`);
    ok("live: and the world switch is back where this leg found it",
      game.settings.get(SCOPE, "shotgunSpreadEnabled") === spreadWasLive, String(spreadWasLive));
    await endAll();

    // ⭐ THE SCENE CAP, driven rather than reasoned about: these burn for 45 seconds, so across a
    // firefight they accumulate in a way a 3-second element never could. Enough bursts to exceed the
    // cap must leave the cap's worth burning, not the sum.
    clearSpawns();
    const bursts = Math.ceil(fx.GROUND_FIRE.maxLive / fx.GROUND_FIRE.maxPerPayload) + 2;
    for (let i = 0; i < bursts; i++) {
      await fx.fxWeaponFired(payload({
        modifier: "api", shotsFired: 4, shotsHit: 4,
        areaDamages: { Torso: [{ damage: i + 1 }, { damage: 3 }, { damage: 2 }, { damage: 1 }] },
      }));
    }
    await sleep(1200);
    const liveNow = fx.liveGroundFires().length;
    ok("live: the scene cap holds across bursts — the oldest are evicted, the newest are drawn",
      liveNow <= fx.GROUND_FIRE.maxLive && liveNow >= fx.GROUND_FIRE.maxPerPayload
      && spawned.filter(isFire).length === bursts * fx.GROUND_FIRE.maxPerPayload,
      `${bursts} bursts queued ${spawned.filter(isFire).length} flames, ${liveNow} alive against a cap of ${fx.GROUND_FIRE.maxLive}`);
    await endAll();
    ok("live: and clearing the canvas leaves none of them behind (negative)",
      fx.liveGroundFires().length === 0, String(fx.liveGroundFires().length));

    // THE PATTERN'S OWN FIRES, driven end to end on a known geometry: the flow that owns them hands
    // this verb a ray, and what comes back must be inside it and bounded by the per-pattern cap.
    clearSpawns();
    const patRay = { x: 900, y: 1400, dirDeg: 0, lengthPx: 900, widthPx: 200, seed: 777 };
    const patOut = await fx.fxPatternGroundFire(patRay);
    await sleep(900);
    ok("live: a confirmed pattern scatters its own bounded set of fires, and no ground mark under them",
      patOut.fires === fx.GROUND_FIRE.maxPerPattern && !("scorch" in patOut)
      && spawned.filter(isFire).length === fx.GROUND_FIRE.maxPerPattern
      && spawned.filter(isScorch).length === 0,
      JSON.stringify({ fires: patOut.fires, spawned: spawned.filter(isFire).length }));
    ok("live: the drawn pattern fires sit where the pure planner put them, to the value",
      eq(patOut.at, fx.patternFirePoints(patRay).map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }))),
      JSON.stringify(patOut.at));
    await endAll();

    clearSpawns();
    const missed = await fx.fxWeaponFired(payload({ modifier: "api", shotsFired: 6, shotsHit: 0, areaDamages: {} }));
    await sleep(1200);
    ok("live: a burst that LANDS NOTHING sets nothing alight (negative)",
      missed.groundFire === null && spawned.filter(isFire).length === 0 && spawned.filter(isScorch).length === 0,
      `${spawned.filter(isFire).length} fire / ${spawned.filter(isScorch).length} scorch`);
    await endAll();

    clearSpawns();
    const plainBurst = await fx.fxWeaponFired(payload({
      modifier: "standard", shotsFired: 6, shotsHit: 3,
      areaDamages: { Torso: [{ damage: 3 }, { damage: 3 }, { damage: 2 }] },
    }));
    await sleep(1200);
    ok("live: baseline ammo sets nothing alight, and draws the ordinary rail (negative)",
      plainBurst.ammoKey === "standard" && plainBurst.groundFire === null
      && spawned.filter(isFire).length === 0 && spawned.filter(isScorch).length === 0,
      `${spawned.filter(isFire).length} fire / ${spawned.filter(isScorch).length} scorch`);
    await endAll();

    // THE LIGHT SOURCE ITSELF, on this scene's own darkness. Core packs a colour to a NUMBER on the
    // source data, so the comparison is made in core's units rather than in ours.
    const darkness = fx.viewedSceneDarkness();
    const wantColor = fx.flashColorFor(darkness, tint);
    fx._setFlashLevels(new Array(400).fill(1));
    fx.clearFlashes();
    fx.muzzleFlashLocal(shooterDoc.id, { x: targetTok.center.x, y: targetTok.center.y }, { ammoColor: tint });
    await sleep(200);
    const built = [...canvas.effects.lightSources.entries()]
      .filter(([k]) => k.startsWith(`${SCOPE}.flash.${shooterDoc.id}.`))
      .map(([k, s]) => ({ part: k.split(".").pop(), color: s.data.color, coloration: s.layers?.coloration?.active ?? null }));
    ok("live: the built flash source carries the ammo colour in this scene's regime",
      built.length > 0 && built.every(s => s.color === (wantColor === null ? null : Number(foundry.utils.Color.from(wantColor)))),
      JSON.stringify({ darkness, wantColor, built }));
    // THE DATAGRAM. Every other client draws its own copy of the flash from one announcement, so the
    // ammo colour has to be IN it — a tint that existed only on the firing client would mean the table
    // saw a different muzzle from the player who pulled the trigger. `game.socket.emit` never echoes to
    // its sender, so the message is read by standing in front of the emit rather than by listening.
    const realEmit = game.socket.emit.bind(game.socket);
    const sent = [];
    game.socket.emit = (channel, data, ...rest) => {
      if (channel === `module.${SCOPE}` && data?.type === "fxMuzzleFlash") sent.push(data);
      return realEmit(channel, data, ...rest);
    };
    try {
      await fx.fxShot(shooterTok, targetTok, { weaponClass: "rifle", hit: true, light: true, ammoKey: "api" });
      await fx.fxShot(shooterTok, targetTok, { weaponClass: "rifle", hit: true, light: true, ammoKey: "standard" });
    } finally { game.socket.emit = realEmit; }
    ok("live: the flash announcement carries the ammo colour, so every client builds the same source",
      sent.length === 2 && sent[0].ammoColor === tint && sent[1].ammoColor === null,
      JSON.stringify(sent.map(s => s.ammoColor)));
    fx.clearFlashes();
    ok("live: and it is the AMMO colour, not the reference one, on a dark scene",
      darkness < fx.MUZZLE_LIGHT.darknessColorThreshold
        ? wantColor === null
        : (wantColor === tint && wantColor !== fx.MUZZLE_LIGHT.referenceColor),
      `darkness ${darkness} -> ${wantColor}`);
    fx.clearFlashes();
    fx._setFlashLevels(null);

    /* ── cleanup ───────────────────────────────────────────────────────────── */
    Hooks.off("createSequencerEffect", spawnHook);
    AH.play = realPlay;
    await endAll();
    for (const m of game.messages.filter(m => m.speaker?.actor === shooterActor.id)) { try { await m.delete(); } catch (e) { /* gone */ } }
    try { await scene.deleteEmbeddedDocuments("Token", [shooterDoc.id, targetDoc.id]); } catch (e) { /* gone */ }
    try { await shooterActor.delete(); } catch (e) { /* gone */ }
    try { await targetActor.delete(); } catch (e) { /* gone */ }
    return out;
  });
  ares.checks.push(...r.checks);
  ares.groundFireDecode = r.groundFireDecode ?? null;
} catch (err) {
  ares.checks.push({ n: "ammo overlay section ran", p: false, d: String(err?.message ?? err) });
}

/* ══ 16. THE BLOOD SPLASH: the four gates, the chosen asset, and the wait it must not join ════════ */
// One element, four independent gates, and each of them is a way the element must NOT be drawn — so
// almost every leg below is a negative. The value half asserts the switch, the target-type answer and
// the chosen asset's own numbers; the live half drives the real fan-out and reads what the ENGINE was
// handed, because "exactly one per attack" and "nothing on a structure target" cannot be seen from a
// return value alone.
const bres = { checks: [] };
try {
  const r = await page.evaluate(async () => {
    const SCOPE = "cp2020-augmented";
    const out = { checks: [], measured: {} };
    const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
    const settings = await import(`/modules/${SCOPE}/module/settings.js`);

    /* ── a. the switch: registered, world-scoped, visible, and OFF ──────────── */
    const decl = game.settings.settings.get(`${SCOPE}.goreEnabled`);
    ok("switch: registered as a world setting the GM can see, typed Boolean",
      !!decl && decl.scope === "world" && decl.config === true && decl.type === Boolean,
      JSON.stringify({ scope: decl?.scope, config: decl?.config, type: decl?.type?.name }));
    ok("switch: the shipped DEFAULT is OFF",
      decl?.default === false, String(decl?.default));
    ok("switch: its label and hint resolve to real text, not to the key",
      typeof decl?.name === "string" && game.i18n.localize(decl.name) !== decl.name
      && game.i18n.localize(decl.hint) !== decl.hint,
      `${decl?.name} -> ${game.i18n.localize(decl?.name ?? "")}`.slice(0, 80));

    const priorGore = game.settings.get(SCOPE, "goreEnabled");
    await game.settings.set(SCOPE, "goreEnabled", false);
    ok("switch: the reader follows it, and fails closed", settings.goreEnabled() === false);
    await game.settings.set(SCOPE, "goreEnabled", true);
    ok("switch: the reader follows it the other way", settings.goreEnabled() === true);

    /* ── b. the target-type answer, by value ────────────────────────────────── */
    // Phase 1 answers at the ACTOR level: the hit location is not known when this is drawn, so the
    // question asked is "is this actor structure", not "was this zone structure".
    for (const a of [...game.actors].filter(a => a.name?.startsWith("__PW__GORE"))) await a.delete();
    const fleshActor = await Actor.create({ name: "__PW__GORE Flesh", type: "character" });
    const npcActor = await Actor.create({ name: "__PW__GORE NPC", type: "npc" });
    const vehActor = await Actor.create({ name: "__PW__GORE Vehicle", type: `${SCOPE}.vehicle` });
    const acpaActor = await Actor.create({ name: "__PW__GORE Suit", type: `${SCOPE}.vehicle`, system: { isACPA: true } });
    const borgActor = await Actor.create({ name: "__PW__GORE Borg", type: "character" });
    await borgActor.setFlag(SCOPE, "fullBorg", true);
    // A cyberlimbed FLESH actor: the ruled case, and it is built from a REAL structural implant rather
    // than by writing the pool — `system.sdp.sum` is derived by the base from equipped cyberware every
    // prepare, so a direct write to it is discarded and a leg resting on one proves nothing.
    const limbActor = await Actor.create({ name: "__PW__GORE Cyberlimb", type: "character" });
    await limbActor.createEmbeddedDocuments("Item", [{
      name: "__PW__GORE Cyberarm", type: "cyberware",
      // The base folds an implant into the pool only when it is EQUIPPED, enabled, carries the
      // "Implant" work type and names a side — all four, or the pool stays zero.
      system: { equipped: true, MountZone: "Arm", CyberBodyType: { Location: "Right" },
        CyberWorkType: { Type: "Implant", Types: ["Implant"], SDP: 30 } },
    }]);

    ok("target type: flesh is not structure (character, npc)",
      fx.bearsStructuralSdp(fleshActor) === false && fx.bearsStructuralSdp(npcActor) === false);
    ok("target type: a vehicle-type actor IS structure, suit or not",
      fx.bearsStructuralSdp(vehActor) === true && fx.bearsStructuralSdp(acpaActor) === true);
    ok("target type: a full-conversion body IS structure, though its actor type is character",
      fx.bearsStructuralSdp(borgActor) === true);
    // THE RULED NUANCE, and the contrast is the whole leg: the per-zone router says that ARM is
    // structure, while the actor-level answer this rail uses says the target is flesh. Both are
    // right — the payload never says which zone was hit, so the rail cannot ask the per-zone question.
    const cyb = await import(`/modules/${SCOPE}/module/mech/cyberlimb.js`);
    ok("target type: a cyberlimbed flesh actor is NOT structure — the ruled phase-1 answer",
      limbActor.system?.sdp?.sum?.rArm === 30
      && cyb.routesToSdp(limbActor, "rArm") === true
      && cyb.routesToSdp(limbActor, "Torso") === false
      && fx.bearsStructuralSdp(limbActor) === false,
      `rArm sdp sum ${limbActor.system?.sdp?.sum?.rArm}, zone routes to structure ${cyb.routesToSdp(limbActor, "rArm")}`);
    ok("target type: nothing at all is not structure (negative)",
      fx.bearsStructuralSdp(null) === false && fx.bearsStructuralSdp(undefined) === false);

    /* ── c. the chosen asset and its numbers ────────────────────────────────── */
    ok("asset: the shipped key is the free tier's SIDE (directional) red liquid splash, and the tier carries it",
      fx.BLOOD_SPLATTER.key === "jb2a.liquid.splash_side02.red" && fx.fxDbEntryExists(fx.BLOOD_SPLATTER.key) === true,
      fx.BLOOD_SPLATTER.key);
    // ⏪ The radial splash it replaced is still on the tier — pinned so the supersession is a CHOICE
    // between two available assets rather than the only one that resolved.
    ok("asset: the superseded radial splash is still installed — the swap was a decision, not a fallback",
      fx.fxDbEntryExists("jb2a.liquid.splash02.red") === true
      && fx.BLOOD_SPLATTER.key !== "jb2a.liquid.splash02.red");
    ok("asset: the payload cap is the measured 4 — repeated spray, not a fountain",
      fx.BLOOD_SPLATTER.maxPerPayload === 4 && fx.BLOOD_SPLATTER.maxPerPayload > 1,
      String(fx.BLOOD_SPLATTER.maxPerPayload));
    ok("asset: it is sized in grid units, about one body wide",
      fx.BLOOD_SPLATTER.squares === 1.5 && fx.BLOOD_SPLATTER.squares > 1 && fx.BLOOD_SPLATTER.squares <= 2,
      String(fx.BLOOD_SPLATTER.squares));
    ok("asset: the trim keeps it transient — under the beat the ruling asked for",
      fx.BLOOD_SPLATTER.clipMs === 900 && fx.BLOOD_SPLATTER.clipMs > 0 && fx.BLOOD_SPLATTER.clipMs <= 1200,
      `${fx.BLOOD_SPLATTER.clipMs}ms`);
    // The measured file length, read off the install rather than assumed, so a tier that ever ships a
    // different cut of this clip is caught here rather than by the mark outstaying the trim.
    const src = Sequencer.Database.getAllFileEntries(fx.BLOOD_SPLATTER.key);
    const file = Array.isArray(src) ? String(src[0]) : String(src);
    const media = await new Promise((res) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => res({ ms: Math.round(v.duration * 1000), w: v.videoWidth, h: v.videoHeight });
      v.onerror = () => res({ ms: -1 });
      v.src = "/" + file.replace(/^\//, "");
      setTimeout(() => res({ ms: -2 }), 8000);
    });
    out.measured.file = { file, ...media };
    ok("asset: the installed file is the one measured, and the trim sits inside it",
      media.ms === 1033 && fx.BLOOD_SPLATTER.clipMs < media.ms,
      `${media.ms}ms ${media.w}x${media.h}`);
    ok("asset: it is the SIDE cut of the file family, not the radial one",
      /LiquidSplashSide02/i.test(file), file);
    ok("asset: it is drawn above the lighting — the documented departure, pinned so it is a choice",
      fx.BLOOD_SPLATTER.aboveLighting === true);

    /* ── d. it is NOT part of the wait ──────────────────────────────────────── */
    // Structural, not incidental: the tail arithmetic takes no gore input at all, so no value of the
    // switch can move it. Asserted across every class and both regimes.
    const tailsOff = Object.keys(fx.FX_CLASSES).map(c => fx.presentationTailMs(c));
    await game.settings.set(SCOPE, "goreEnabled", false);
    const tailsOffAgain = Object.keys(fx.FX_CLASSES).map(c => fx.presentationTailMs(c));
    await game.settings.set(SCOPE, "goreEnabled", true);
    ok("the wait: the tail arithmetic is identical with the switch on and off, every class",
      JSON.stringify(tailsOff) === JSON.stringify(tailsOffAgain),
      JSON.stringify(tailsOff));

    /* ── e. LIVE: what the fan-out actually queues ──────────────────────────── */
    const scene = game.scenes.active;
    for (const t of [...(scene?.tokens ?? [])].filter(t => t.name?.startsWith("__PW__GORE"))) await t.delete();
    const shooterActor = await Actor.create({ name: "__PW__GORE Shooter", type: "character" });
    const [rifleItem] = await shooterActor.createEmbeddedDocuments("Item", [{
      name: "__PW__GORE rifle", type: "weapon",
      system: { weaponType: "Rifle", attackType: "Auto", damage: "1d6", range: 50, rof: 1, shots: 40, shotsLeft: 40 },
    }]);
    // ⚠ ONE TOKEN PER CALL, never a multi-create destructured by position: this rig has been seen to
    // return the created documents in database order rather than in the order they were asked for,
    // and the first run of this section did exactly that — the flesh and vehicle handles came back
    // swapped, so the two target-type legs each read the OTHER target's result.
    const mkTok = async (name, actorId, x, y) => (await scene.createEmbeddedDocuments("Token",
      [{ name, actorId, x, y, width: 1, height: 1 }]))[0];
    const shooterDoc = await mkTok("__PW__GORE Shooter", shooterActor.id, 1000, 1500);
    const fleshDoc = await mkTok("__PW__GORE Flesh", fleshActor.id, 1700, 1500);
    const vehDoc = await mkTok("__PW__GORE Vehicle", vehActor.id, 1700, 1700);
    const borgDoc = await mkTok("__PW__GORE Borg", borgActor.id, 1700, 1300);
    await sleep(400);
    // The handles really are the actors they are named for — the guard that makes every target-type
    // leg below mean what it says.
    ok("live fixtures: each target token carries the actor its leg names",
      canvas.tokens.get(fleshDoc.id)?.actor?.id === fleshActor.id
      && canvas.tokens.get(vehDoc.id)?.actor?.id === vehActor.id
      && canvas.tokens.get(borgDoc.id)?.actor?.id === borgActor.id,
      JSON.stringify([canvas.tokens.get(fleshDoc.id)?.actor?.name, canvas.tokens.get(vehDoc.id)?.actor?.name, canvas.tokens.get(borgDoc.id)?.actor?.name]));

    const AH = foundry.audio.AudioHelper;
    const realPlay = AH.play;
    AH.play = () => null;

    // Read what the ENGINE was handed, not what our own return value says: "exactly one splash per
    // attack" is a property of the queue, and the settle exclusion is a property of the effect's name.
    const spawned = [];
    const spawnHook = Hooks.on("createSequencerEffect", (e) => {
      spawned.push({ file: String(e?.data?.file ?? e?.data?.src ?? ""), name: String(e?.data?.name ?? "") });
    });
    const clearSpawns = () => { spawned.length = 0; };
    const endAll = async () => { try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none live */ } await sleep(150); };
    const isBlood = (s) => /liquid\.splash_side02\.red|LiquidSplashSide02/i.test(s.file);
    const bloods = () => spawned.filter(isBlood);

    const payload = (over = {}) => ({
      attackerId: shooterActor.id, weaponId: rifleItem.id, weaponName: "__PW__GORE rifle",
      targetTokenId: fleshDoc.id, shotsFired: 10, shotsHit: 4,
      areaDamages: { Torso: [{ damage: 3 }, { damage: 3 }, { damage: 2 }, { damage: 2 }] }, ...over,
    });
    const HIT_WAIT = 1500;

    // ⚠ THE DROP THRESHOLD IS HELD OUT OF REACH FOR THIS WHOLE SECTION. A dropped round draws no
    // picture at all, and its spray goes with it (deliberately — see the call site), so a headless
    // client slow enough to drop a round would make these counts a measure of the host rather than of
    // the rule. Held high here so the counts are exact; the drop rule has its own section, where the
    // seam is armed the other way. Restored in the section's own finally.
    fx._setDropLagMs(600000);

    // 1. THE SWITCH OFF — the whole point of the setting.
    await game.settings.set(SCOPE, "goreEnabled", false);
    clearSpawns();
    const offRun = await fx.fxWeaponFired(payload());
    await sleep(HIT_WAIT);
    ok("live: with the switch OFF a landing burst draws no splash at all (negative)",
      offRun.blood === null && bloods().length === 0,
      `${bloods().length} of ${spawned.length} effects`);
    await endAll();

    // 2. ⏪ THE RULE THAT REPLACED "ONCE PER PAYLOAD": one spray per LANDING round. This payload lands
    // four of its ten rounds, so four sprays — not one (the superseded rule) and not ten (the rounds
    // that missed draw nothing).
    await game.settings.set(SCOPE, "goreEnabled", true);
    clearSpawns();
    const onRun = await fx.fxWeaponFired(payload());
    await sleep(HIT_WAIT);
    ok("live: a ten-round burst landing FOUR draws four sprays — one per landing round, not one per payload",
      onRun.blood?.queued === 4 && bloods().length === 4,
      `queued ${onRun.blood?.queued}, drawn ${bloods().length} of ${spawned.length} effects`);
    ok("live: the sprays are one per LANDING round, so the six that missed drew none (negative)",
      bloods().length === onRun.hits && bloods().length < onRun.shots,
      `${bloods().length} sprays / ${onRun.hits} hits / ${onRun.shots} rounds`);
    ok("live: and it is the mapped asset, at the target, sized as the table says",
      onRun.blood?.key === fx.BLOOD_SPLATTER.key && onRun.blood?.tokenId === fleshDoc.id
      && onRun.blood?.squares === fx.BLOOD_SPLATTER.squares,
      JSON.stringify(onRun.blood));
    await endAll();

    // 2b. THE CAP — ten LANDING rounds must not draw ten sprays.
    clearSpawns();
    const capRun = await fx.fxWeaponFired(payload({
      shotsFired: 10,
      areaDamages: { Torso: Array.from({ length: 10 }, () => ({ damage: 2 })) },
    }));
    await sleep(HIT_WAIT);
    ok("live: ten LANDING rounds are capped at maxPerPayload sprays — repeated spray, never a fountain",
      capRun.hits === 10 && capRun.blood?.queued === fx.BLOOD_SPLATTER.maxPerPayload
      && bloods().length === fx.BLOOD_SPLATTER.maxPerPayload,
      `${capRun.hits} hits -> ${bloods().length} sprays (cap ${fx.BLOOD_SPLATTER.maxPerPayload})`);
    ok("live: the cap is reported on the result, so it is readable without counting the canvas",
      capRun.blood?.cap === fx.BLOOD_SPLATTER.maxPerPayload, String(capRun.blood?.cap));
    await endAll();

    // 2c. THE DIRECTION — the ruled exit vector, asserted as geometry rather than as a look.
    const shooterTokPlaceable = canvas.tokens.placeables.find(t => t.document.id === shooterDoc.id);
    const fleshTokPlaceable = canvas.tokens.placeables.find(t => t.document.id === fleshDoc.id);
    const dir = await fx.fxBloodSplatter(shooterTokPlaceable, fleshTokPlaceable, { delayMs: 0 });
    const fromC = fx.centerOf(shooterTokPlaceable), atC = fx.centerOf(fleshTokPlaceable);
    const exit = dir.exitPoint;
    const angOf = (p) => Math.atan2(p.y - fromC.y, p.x - fromC.x);
    const degApart = exit ? Math.abs(((angOf(atC) - angOf(exit)) * 180) / Math.PI) : null;
    ok("direction: the spray is aimed at a point BEYOND the target on the shooter→target ray — an exit, not a splash-back",
      !!exit && Math.hypot(exit.x - fromC.x, exit.y - fromC.y) > Math.hypot(atC.x - fromC.x, atC.y - fromC.y),
      JSON.stringify({ exit, targetDist: Math.round(Math.hypot(atC.x - fromC.x, atC.y - fromC.y)) }));
    ok("direction: that point is COLLINEAR with the shot — the spray continues the round's own line",
      degApart !== null && degApart < 1, `${degApart}° off the shot axis`);
    ok("direction: a shot with no shooter falls back to a random rotation rather than a baked heading (negative)",
      (await fx.fxBloodSplatter(null, fleshTokPlaceable, {})).exitPoint === null);
    await endAll();

    // 2d. THE IMPACT CLOCK — the spray waits out the round's own crossing time, per load.
    clearSpawns();
    const flechRun = await fx.fxWeaponFired(payload({ modifier: "flechette", shotsFired: 2,
      areaDamages: { Torso: [{ damage: 2 }, { damage: 2 }] } }));
    await sleep(HIT_WAIT);
    const flechEntry = fx.ammoFxEntry(flechRun.weaponClass, "flechette");
    ok("clock: a travelled load's spray is held back by that load's own crossing time",
      Number(flechEntry.dashMs) === 170 && flechRun.blood?.queued === 2 && bloods().length === 2,
      `dashMs ${flechEntry.dashMs}, ${bloods().length} sprays`);
    await endAll();
    // THE SETTLE EXCLUSION, read off the queue: the terminal elements of the last round carry the
    // fan-out's settle name; the splash must not, or the damage window would wait for it.
    ok("live: the splash carries no settle name — the damage window cannot wait on it",
      bloods().every(b => !/\.settle\./.test(b.name)) && spawned.some(s => /\.settle\./.test(s.name)),
      JSON.stringify({ blood: bloods().map(b => b.name), tagged: spawned.filter(s => /\.settle\./.test(s.name)).length }));
    // The scheduled floor is the same number it was with the switch off — the splash joined nothing.
    ok("live: the scheduled tail is unmoved by the splash",
      onRun.settleTailMs === offRun.settleTailMs,
      `${offRun.settleTailMs} -> ${onRun.settleTailMs}`);
    out.measured.tail = { off: offRun.settleTailMs, on: onRun.settleTailMs };
    await endAll();

    // 3. A STRUCTURE TARGET, same shot — nothing.
    clearSpawns();
    const vehRun = await fx.fxWeaponFired(payload({ targetTokenId: vehDoc.id }));
    await sleep(HIT_WAIT);
    ok("live: the same landing burst on a vehicle target draws no splash (negative)",
      vehRun.blood === null && bloods().length === 0,
      `${bloods().length} of ${spawned.length} effects`);
    await endAll();

    clearSpawns();
    const borgRun = await fx.fxWeaponFired(payload({ targetTokenId: borgDoc.id }));
    await sleep(HIT_WAIT);
    ok("live: nor on a full-conversion body, whose actor type is character (negative)",
      borgRun.blood === null && bloods().length === 0,
      `${bloods().length} of ${spawned.length} effects`);
    await endAll();

    // 4. A RULED FUMBLE — the rail draws nothing at all, and that includes this.
    clearSpawns();
    const fumbleRun = await fx.fxWeaponFired(payload({ fumbleRuled: true }));
    await sleep(600);
    ok("live: a ruled fumble draws no splash, with everything else it does not draw (negative)",
      fumbleRun.skipped === "fumble" && fumbleRun.blood === null && bloods().length === 0,
      `${fumbleRun.skipped} / ${bloods().length}`);
    await endAll();

    // 5. THE MISS, and the shot with nobody aimed at — the other two ways nothing is drawn.
    clearSpawns();
    const missRun = await fx.fxWeaponFired(payload({ shotsHit: 0, areaDamages: {} }));
    await sleep(HIT_WAIT);
    ok("live: a burst that lands nothing draws no splash (negative)",
      missRun.blood === null && bloods().length === 0,
      `${bloods().length} of ${spawned.length} effects`);
    await endAll();

    clearSpawns();
    const noAimRun = await fx.fxWeaponFired(payload({ targetTokenId: null, fxTargetTokenId: null }));
    await sleep(HIT_WAIT);
    ok("live: a shot with no target token draws no splash — blood needs a body (negative)",
      noAimRun.blood === null && bloods().length === 0,
      `${bloods().length} of ${spawned.length} effects`);
    await endAll();

    // 6. The verb's own degrade path, driven directly: nothing to draw on means nothing drawn.
    const direct = await fx.fxBloodSplatter(null, null);
    ok("verb: called with no token it draws nothing and says so (negative)",
      direct.drawn === false && direct.key === fx.BLOOD_SPLATTER.key);

    /* ── cleanup ───────────────────────────────────────────────────────────── */
    fx._setDropLagMs(null);
    ok("cleanup: the drop-threshold seam is disarmed — nothing ships with one armed",
      fx.dropLagMsFor(fx.SHOT_CADENCE_MS) === fx.SHOT_CADENCE_MS * fx.FX_DROP_LAG_FRACTION,
      String(fx.dropLagMsFor(fx.SHOT_CADENCE_MS)));
    Hooks.off("createSequencerEffect", spawnHook);
    AH.play = realPlay;
    await endAll();
    await game.settings.set(SCOPE, "goreEnabled", priorGore);
    ok("cleanup: the switch is left as it was found", game.settings.get(SCOPE, "goreEnabled") === priorGore, String(priorGore));
    for (const m of game.messages.filter(m => m.speaker?.actor === shooterActor.id)) { try { await m.delete(); } catch (e) { /* gone */ } }
    try { await scene.deleteEmbeddedDocuments("Token", [shooterDoc.id, fleshDoc.id, vehDoc.id, borgDoc.id]); } catch (e) { /* gone */ }
    for (const a of [shooterActor, fleshActor, npcActor, vehActor, acpaActor, borgActor, limbActor]) { try { await a.delete(); } catch (e) { /* gone */ } }
    return out;
  });
  bres.checks.push(...r.checks);
  bres.measured = r.measured;
} catch (err) {
  bres.checks.push({ n: "blood splash section ran", p: false, d: String(err?.message ?? err) });
}

/* ══ 17. THE PACING CONTRACT: an anchored schedule, and a late round DROPPED rather than queued ════ */
// The defect this section pins was reported as animations running in slow motion, queueing behind the
// audio and trailing out after the shooting stopped. The cause is that the fan-out loop paces by the
// wall clock while everything it queues is drawn by the render loop, and the old loop waited a FIXED
// interval per round — so every millisecond a round's timer fired late was ADDED to the next round's
// start and the error compounded. Measured on this rig before the fix: a 30-round shell payload ran
// 11681ms against an intended 5220ms (2.24x). The rule has two halves and this section pins both by
// value first (no timing at all) and then live.
const cres = { checks: [] };
try {
  const r = await page.evaluate(async () => {
    const SCOPE = "cp2020-augmented";
    const out = { checks: [], measured: {} };
    const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);

    /* ── a. the schedule, as a value: anchored, never accumulated ───────────── */
    ok("schedule: round 0 is due at the anchor itself",
      fx.roundDueAtMs(1000, 0, 80) === 1000, String(fx.roundDueAtMs(1000, 0, 80)));
    ok("schedule: round N is due N cadences after the ANCHOR — not N sleeps after the last round",
      fx.roundDueAtMs(1000, 5, 80) === 1400 && fx.roundDueAtMs(1000, 30, 80) === 3400,
      `${fx.roundDueAtMs(1000, 5, 80)} / ${fx.roundDueAtMs(1000, 30, 80)}`);
    // The property that retires the compounding: a late round does not move any later round's slot.
    const slots = Array.from({ length: 10 }, (_, i) => fx.roundDueAtMs(0, i, 80));
    ok("schedule: the slots are a fixed ladder, so one slow round cannot push the ones after it",
      slots.every((v, i) => v === i * 80) && slots[9] - slots[0] === 720, JSON.stringify(slots));

    /* ── b. the drop decision, as a value ───────────────────────────────────── */
    // THE THRESHOLD IS HALF A SLOT, a fraction rather than a flat figure, for a reason the arithmetic
    // states: a round drawn more than half a cadence late leaves less than half a cadence before the
    // next round's slot, so the two would be drawn together. Half is what makes the separation leg
    // below a guarantee. (A flat 150ms shipped first and the rig refused it — at the default 80ms
    // spacing it produced gaps of 256, 1, 256 ms.)
    ok("drop: the threshold is half a slot — 40ms at the default spacing, 90ms at the shell's",
      fx.FX_DROP_LAG_FRACTION === 0.5
      && fx.dropLagMsFor(fx.SHOT_CADENCE_MS) === 40
      && fx.dropLagMsFor(fx.classCadenceMs("shotgun")) === 90,
      fx.dropLagMsFor(fx.SHOT_CADENCE_MS) + "ms / " + fx.dropLagMsFor(fx.classCadenceMs("shotgun")) + "ms");
    ok("drop: it is derived from the cadence, so a slower-firing class gets a proportionally larger slot",
      fx.dropLagMsFor(fx.classCadenceMs("shotgun")) > fx.dropLagMsFor(fx.SHOT_CADENCE_MS));
    ok("drop: a round inside the threshold is DRAWN (negative)",
      fx.roundDropped({ lagMs: 39, isLast: false, dropLagMs: fx.dropLagMsFor(80) }) === false);
    ok("drop: a round past it is DROPPED, not queued",
      fx.roundDropped({ lagMs: 41, isLast: false, dropLagMs: fx.dropLagMsFor(80) }) === true);
    ok("drop: the boundary itself is not a drop — the test is strictly greater",
      fx.roundDropped({ lagMs: 40, isLast: false, dropLagMs: fx.dropLagMsFor(80) }) === false);
    // THE SEPARATION GUARANTEE as arithmetic over every cadence the table ships: the worst gap two
    // drawn rounds can have is cadence minus threshold, and at half a cadence that is half a cadence.
    const worstGapAt = (c) => c - fx.dropLagMsFor(c);
    ok("drop: at every shipped cadence the closest two drawn rounds can be is HALF a slot — never a bunch",
      Object.keys(fx.FX_CLASSES).every(cls => {
        const c = fx.classCadenceMs(cls);
        return worstGapAt(c) >= c * 0.5 - 0.001;
      }),
      JSON.stringify(Object.fromEntries(Object.keys(fx.FX_CLASSES).map(cls =>
        [cls, fx.classCadenceMs(cls) + "ms slot -> worst gap " + worstGapAt(fx.classCadenceMs(cls)) + "ms"]))));
    // ⛔ THE HARD RULE. The last round carries the settle tag, so the completion signal is named on an
    // element certain to be drawn — which is what makes the damage window unable to wait on a refusal.
    ok("drop: the LAST round is never dropped, however late — it carries the settle tag",
      fx.roundDropped({ lagMs: 999999, isLast: true }) === false);
    ok("drop: a threshold of 0 disables the rule entirely (the documented escape)",
      fx.roundDropped({ lagMs: 999999, isLast: false, dropLagMs: 0 }) === false);
    ok("drop: nothing ships with the seam armed",
      fx.dropLagMsFor(fx.SHOT_CADENCE_MS) === fx.SHOT_CADENCE_MS * fx.FX_DROP_LAG_FRACTION,
      String(fx.dropLagMsFor(fx.SHOT_CADENCE_MS)));

    /* ── c. live: a healthy client drops NOTHING ────────────────────────────── */
    const toks = canvas.tokens.placeables;
    const shooterTok = toks.find(t => game.actors.get(t.actor?.id)?.items?.some(i => i.type === "weapon" && fx.weaponFxClass(i) === "shotgun"));
    const worldActor = game.actors.get(shooterTok?.actor?.id);
    const targetTok = toks.find(t => t !== shooterTok && t.actor && !fx.bearsStructuralSdp(t.actor));
    const shell = worldActor?.items?.find(i => i.type === "weapon" && fx.weaponFxClass(i) === "shotgun");
    if (!shell) { ok("pacing live fixtures present", false, "no shell weapon on the bench"); return out; }
    const mk = (shots) => ({ attackerId: worldActor.id, weaponId: shell.id, weaponName: shell.name,
      modifier: "flechette", targetTokenId: targetTok?.id ?? null, fxTargetTokenId: targetTok?.id ?? null,
      shotsFired: shots, fumbleRuled: false, areaDamages: { Torso: [{ damage: 2 }] } });

    fx._setDropLagMs(600000);                       // out of reach: nothing can be late enough
    const calm = await fx.fxWeaponFired(mk(10));
    await sleep(600);
    ok("live: with the threshold out of reach every round draws — the rule costs a healthy client nothing",
      calm.dropped === 0 && calm.shots === 10, `dropped ${calm.dropped} of ${calm.shots}`);
    try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none live */ }
    await sleep(400);

    /* ── d. live: under load the late rounds are DROPPED, and the burst still ends on time ── */
    // The threshold at the floor plus a 30-round flechette fan-out is the synthetic load: this host
    // genuinely cannot keep up with it (measured above at ~200ms of lateness per round), so the rounds
    // really are late and really are refused — nothing here fakes a clock.
    fx._setDropLagMs(1);
    const loaded = await fx.fxWeaponFired(mk(30));
    await sleep(600);
    out.measured.loaded = { shots: loaded.shots, dropped: loaded.dropped, loopMs: loaded.loopMs,
      maxLagMs: loaded.maxLagMs, intendedMs: (loaded.shots - 1) * loaded.cadenceMs };
    ok("live: rounds that miss their slot are DROPPED rather than queued behind the burst",
      loaded.dropped > 0 && loaded.dropped < loaded.shots,
      `${loaded.dropped} of ${loaded.shots} refused`);
    // THE POINT OF THE WHOLE RULE, stated as the number the report was about: the fan-out finishes
    // when the shooting finishes instead of trailing out behind it.
    const intended = (loaded.shots - 1) * loaded.cadenceMs;
    ok("live: the burst still ends on its own schedule — it no longer trails out behind the shooting",
      loaded.loopMs < intended * 1.25,
      `${loaded.loopMs}ms against an intended ${intended}ms (pre-fix this ran 2.24x)`);
    ok("live: the loop reports its own worst lateness, so the pacing is readable rather than inferred",
      Number.isFinite(loaded.maxLagMs) && loaded.maxLagMs >= 0, `${loaded.maxLagMs}ms`);
    // ⛔ SETTLE INTEGRITY UNDER THE DROP — the leg that makes the rule safe. However many rounds were
    // refused, the LAST one drew, its terminal elements carry the settle name, and the damage window
    // therefore resolves by the engine's own signal rather than falling to the cap.
    const spawned = [];
    const h = Hooks.on("createSequencerEffect", (e) => spawned.push(String(e?.data?.name ?? "")));
    // ⚠ presentationSettled is keyed on the PAYLOAD OBJECT, not on the fan-out's result — hold the
    // payload so the wait is the real one. (Handing it the result yields the "arithmetic" answer for a
    // payload it has never seen, which passes a naive assertion while testing nothing.)
    // TEN rounds, not thirty, and the reason is arithmetic rather than convenience: thirty rounds at
    // the shell's spacing is 5.2s of firing plus its tail, which legitimately runs past
    // PRESENTATION_CAP_MS on this host — so a thirty-round burst answers "cap" for a reason that has
    // nothing to do with the drop rule (it did so far harder before this unit, when the same burst ran
    // 11.7s). Ten rounds is a burst whose whole presentation fits inside the cap, so the route it takes
    // is a statement about the signal.
    const taggedPayload = mk(10);
    const settleWait = fx.presentationSettled(taggedPayload);
    const tagged = await fx.fxWeaponFired(taggedPayload);
    const settleInfo = await settleWait;
    Hooks.off("createSequencerEffect", h);
    out.measured.settleUnderDrop = { dropped: tagged.dropped, via: settleInfo.via, ms: settleInfo.ms,
      tagged: spawned.filter(n => /\.settle\./.test(n)).length };
    ok("live: with rounds being dropped the LAST round still drew and still carries the settle name",
      tagged.dropped > 0 && spawned.some(n => /\.settle\./.test(n)),
      `${tagged.dropped} dropped, ${spawned.filter(n => /\.settle\./.test(n)).length} tagged elements`);
    ok("live: and the damage window still closes on the engine's signal, not on the cap — it cannot hang",
      settleInfo.via !== "cap" && settleInfo.ms < fx.PRESENTATION_CAP_MS,
      `${settleInfo.via} at ${settleInfo.ms}ms (cap ${fx.PRESENTATION_CAP_MS}ms)`);

    fx._setDropLagMs(null);
    ok("cleanup: the seam is disarmed",
      fx.dropLagMsFor(fx.SHOT_CADENCE_MS) === fx.SHOT_CADENCE_MS * fx.FX_DROP_LAG_FRACTION);
    try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none live */ }
    await sleep(300);
    // The bookkeeping the stress run caught leaking: a watch whose elements never all reported gone
    // used to sit in the maps for the rest of the session. The hard stop is the cap.
    await sleep(fx.PRESENTATION_CAP_MS + 500);
    ok("live: no fan-out is left in flight once the cap has passed — the watches cannot accumulate",
      fx.settlementsInFlight() === 0, String(fx.settlementsInFlight()));
    return out;
  });
  cres.checks.push(...r.checks);
  cres.measured = r.measured;
} catch (err) {
  cres.checks.push({ n: "pacing section ran", p: false, d: String(err?.message ?? err) });
}

/* ══ 18. THE api OVERLAY after the 2026-08-09 report: no mark on the target, and an eased red ═════ */
const ires = { checks: [] };
try {
  const r = await page.evaluate(async () => {
    const SCOPE = "cp2020-augmented";
    const out = { checks: [] };
    const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
    const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);

    // ⏪ THE WITHDRAWN PROMOTION. The row must not name an impact at all — that is what sends it back
    // to the class's own standard hit mark, which is the whole of the fix.
    ok("api: the row names NO impact asset — the blast ring on the target is withdrawn",
      fx.AMMO_FX.api.impactKey === undefined && fx.AMMO_FX.api.impactClipMs === undefined,
      JSON.stringify({ impactKey: fx.AMMO_FX.api.impactKey ?? null }));
    for (const cls of Object.keys(fx.FX_CLASSES)) {
      const entry = fx.ammoFxEntry(cls, "api");
      const base = fx.FX_CLASSES[cls];
      ok(`api: on ${cls} the resolved hit mark is the class's own, not a promoted one`,
        (entry.impactKey ?? null) === (base.impactKey ?? null)
        && (entry.impactSquares ?? null) === (base.impactSquares ?? null),
        JSON.stringify({ impactKey: entry.impactKey ?? null, squares: entry.impactSquares }));
    }
    // The rest of the load is untouched — the report asked for the ring to go, not for the load to.
    ok("api: the tinted rounds, the tinted flash and the burning ground all remain",
      fx.AMMO_FX.api.tracerColor === fx.TRACER_COLOR_INCENDIARY
      && fx.AMMO_FX.api.columnColor === undefined
      && fx.AMMO_FX.api.flashColor === "#ff6a1a" && fx.AMMO_FX.api.groundFire === true,
      JSON.stringify(fx.AMMO_FX.api));
    ok("api: with no promotion the load's tail is the ordinary one — the window is unchanged by the removal",
      fx.presentationTailMs("rifle", "api") === fx.presentationTailMs("rifle", "standard")
      && fx.presentationTailMs("shotgun", "api") === fx.presentationTailMs("shotgun", "standard"),
      `${fx.presentationTailMs("rifle", "api")} / ${fx.presentationTailMs("shotgun", "api")}`);
    // ⏱ THE EASE, with its revert value pinned so the reversal stays a one-number edit.
    ok("api: the red is eased one notch — hue −14, with −20 recorded at the site as the revert",
      fx.TRACER_COLOR_INCENDIARY.hue === -14 && fx.TRACER_COLOR_INCENDIARY.hue > -20,
      JSON.stringify(fx.TRACER_COLOR_INCENDIARY));
    ok("api: only the hue moved — saturation and brightness are the values that were never in question",
      fx.TRACER_COLOR_INCENDIARY.saturate === 0.30 && fx.TRACER_COLOR_INCENDIARY.brightness === 1.20,
      JSON.stringify(fx.TRACER_COLOR_INCENDIARY));
    // The other two promotions are untouched — the withdrawal was api's alone.
    ok("api: the hardened loads keep THEIR promotion — this was one row's ruling, not the mechanism's (negative)",
      fx.AMMO_FX.ap.impactKey === fx.IMPACT_CRACK.key
      && fx.AMMO_FX.dualPurpose.impactKey === fx.IMPACT_CRACK.key
      && fx.AMMO_FX.rubber.impactKey === fx.IMPACT_DUST.key,
      JSON.stringify({ ap: fx.AMMO_FX.ap.impactKey, rubber: fx.AMMO_FX.rubber.impactKey }));
    ok("api: the withdrawn asset is still declared and still on the tier — restoring it is one field",
      fx.IMPACT_FIRE.key === "jb2a.impact.fire.01.orange" && fx.fxDbEntryExists(fx.IMPACT_FIRE.key) === true);
    return out;
  });
  ires.checks.push(...r.checks);
} catch (err) {
  ires.checks.push({ n: "api overlay section ran", p: false, d: String(err?.message ?? err) });
}

/* ══ 19. THE PERSONAL-REVIEW FIXES (2026-08-10) — seed entropy · overlay reach · the canary ══════ */
// These legs exist because the review found three blind spots in THIS SPEC, not only in the product.
// Each one is written so that reverting its fix fails it:
//   F3  the chaos was varied across round INDEXES and never across two separate trigger pulls, which is
//       exactly the case the identity-only seed got wrong. Driven here as six pulls that differ ONLY in
//       their rolled damage, read off what the engine was actually handed.
//   F9  the volley was pinned as "which loads own it" and never as "what does a tinted or a dart load
//       LOOK like once it owns it". Driven per load, on the queued sprite.
//   F1  the presentation canary shipped with no leg at all: both its new exception classes are driven,
//       and the second block provokes it for real so the first is not a tautology.
// F5 is measurement only — no fix was ruled — so it goes to `measured` and never to a verdict.
const fres = { checks: [], measured: {} };
try {
  const r = await page.evaluate(async () => {
    const SCOPE = "cp2020-augmented";
    const out = { checks: [], measured: {} };
    const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
    const scene = game.scenes.active;

    /* ── fixtures: one gunner, one thing to aim at, and one actor with no token at all ────────── */
    for (const a of [...game.actors].filter(a => a.name?.startsWith("__PW__RVW"))) await a.delete();
    for (const t of [...(scene?.tokens ?? [])].filter(t => t.name?.startsWith("__PW__RVW"))) await t.delete();
    const gunSystem = { weaponType: "Shotgun", attackType: "Shotgun", damage: "3d6", range: 50, rof: 1, shots: 8, shotsLeft: 8 };
    const actor = await Actor.create({ name: "__PW__RVW Shooter", type: "character" });
    const [gun] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__RVW shell gun", type: "weapon", system: gunSystem }]);
    const dummy = await Actor.create({ name: "__PW__RVW Dummy", type: "character" });
    const [shooterTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__RVW Shooter", actorId: actor.id, actorLink: true, x: 1000, y: 1400 }]);
    const [targetTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__RVW Dummy", actorId: dummy.id, actorLink: true, x: 1600, y: 1400 }]);
    await sleep(400);

    const fxWas = game.settings.get(SCOPE, "combatFxEnabled");
    const realSequence = globalThis.Sequence;
    const playedEntries = [];
    try {
      await game.settings.set(SCOPE, "combatFxEnabled", true);
      // The same recording surface §9 uses — the engine is replaced by a builder that keeps every call,
      // so what the fan-out HANDED OVER is readable by value instead of being inferred from the canvas.
      class RecSequence {
        constructor() { this.entries = []; }
        effect() {
          const e = { file: (f) => { this.entries.push({ file: f }); e._i = this.entries.length - 1; return e; },
                      atLocation: (l) => { this.entries[e._i].atLocation = l; return e; }, scale: () => e,
                      endTimePerc: () => e, timeRange: (a2, b2) => { this.entries[e._i].timeRange = [a2, b2]; return e; },
                      filter: (n, o) => { this.entries[e._i].filter = { name: n, opts: o }; return e; },
                      opacity: () => e, fadeOut: () => e, playbackRate: () => e,
                      rotateTowards: (p) => { this.entries[e._i].rotateTowards = p; return e; },
                      size: (s, o) => { this.entries[e._i].size = s; this.entries[e._i].sizeOpts = o; return e; },
                      elevation: () => e, aboveLighting: () => e, delay: () => e,
                      moveTowards: (p) => { this.entries[e._i].to = p; return e; }, moveSpeed: () => e,
                      mirrorY: (v) => { this.entries[e._i].mirrorY = v; return e; },
                      name: (v) => { this.entries[e._i].name = v; return e; },
                      duration: () => e,
                      stretchTo: (p) => { this.entries[e._i].stretchTo = p; this.entries[e._i].to = p; return e; } };
          return e;
        }
        async play() { playedEntries.push(this.entries); }
      }
      globalThis.Sequence = RecSequence;

      const basePayload = (over = {}) => ({
        attackerId: actor.id, weaponId: gun.id, weaponName: "__PW__RVW shell gun",
        caliber: "00", modifier: "standard", shotsFired: 1,
        targetTokenId: targetTok.id, fxTargetTokenId: targetTok.id,
        areaDamages: { Torso: [{ damage: 7 }] }, ...over,
      });
      // One trigger pull, reported as what the engine was handed: the volley sprite if there was one,
      // and the whole file list either way (so "it drew something else instead" is readable too).
      const pull = async (p) => {
        playedEntries.length = 0;
        const res = await fx.fxWeaponFired(p);
        await sleep(140);
        const all = playedEntries.flat();
        const v = all.find((x) => x.file === fx.VOLLEY.key) ?? null;
        // The endpoint is kept at FULL precision. Rounding it to whole pixels collapsed a ±5° arc over a
        // 600px throw into ~250 buckets, so six independently-seeded pulls collided there roughly one run
        // in twenty and the distinct-picture count came back 5 — a birthday collision in this line, not a
        // product defect. At full precision two endpoints coincide only if their jitter angles do.
        return { res, files: all.map((x) => ({ file: x.file, sat: x.filter?.opts?.saturate ?? null, hue: x.filter?.opts?.hue ?? null })),
                 volley: v ? { mirrorY: v.mirrorY, x: v.stretchTo?.x ?? 0, y: v.stretchTo?.y ?? 0,
                               filterName: v.filter?.name ?? null, hue: v.filter?.opts?.hue ?? null } : null };
      };

      /* ── F3. two TRIGGER PULLS, not two round indexes ─────────────────────────────────────── */
      // Six pulls of the same gun at the same target with the same round and hit counts: every identity
      // field the old seed folded is byte-identical across them, and only the ROLL differs. Under the
      // reverted seed all six compute one mirror and one angle, so the distinct-picture count is 1.
      const ROLLS = [7, 9, 11, 13, 15, 17];
      const pulls = [];
      for (const dmg of ROLLS) pulls.push(await pull(basePayload({ areaDamages: { Torso: [{ damage: dmg }] } })));
      const shape = (p) => JSON.stringify([p.volley?.mirrorY, p.volley?.x, p.volley?.y]);
      // The claim is "the roll reaches the seed, and the seed reaches the draw", so it is asserted on
      // those two links rather than on a raw count of distinct pictures. The old form demanded six
      // distinct DRAWN pictures, which is not a property of the mechanism: the attacker/weapon ids are
      // freshly minted every run, so the six seeds are a fresh draw each time and two of them landing on
      // one picture is ordinary chance, not a regression. Both links below are exact.
      const seedOf = (dmg) => fx.fxSeedOf(actor.id, gun.id, 1, 1, 0, JSON.stringify({ Torso: [{ damage: dmg }] }));
      const seeds = ROLLS.map(seedOf);
      const chaos = seeds.map((s) => JSON.stringify(fx.volleyChaosFor(s)));
      ok("F3 seed: six identical trigger pulls whose ROLLS differ fold six DIFFERENT seeds",
        pulls.every((p) => p.volley) && new Set(seeds).size === 6,
        `${new Set(seeds).size}/6 distinct seeds — ${seeds.join(" ")}`);
      // And the seed is what the canvas got: as many distinct volleys were drawn as there were distinct
      // chaos values to draw. One-for-one, so a seed that never reached fxShot shows up as a shortfall.
      const distinct = new Set(pulls.map(shape));
      ok("F3 seed: each distinct seeded chaos drew its own distinct volley — the seed reached the canvas",
        distinct.size === new Set(chaos).size && distinct.size > 1,
        `${distinct.size} drawn vs ${new Set(chaos).size} seeded`);
      // The agreement half of the same rule: the seed is the PAYLOAD's, so the same payload computed
      // again is the same picture. Two clients handed one payload therefore draw one discharge.
      const repeatA = await pull(basePayload({ areaDamages: { Torso: [{ damage: 21 }] } }));
      const repeatB = await pull(basePayload({ areaDamages: { Torso: [{ damage: 21 }] } }));
      ok("F3 seed: the same payload computed twice draws the SAME volley — agreement is a property of the input",
        !!repeatA.volley && shape(repeatA) === shape(repeatB), `${shape(repeatA)} vs ${shape(repeatB)}`);
      ok("F3 seed: and it is not simply constant — the differing-roll pulls did not match the repeat (negative)",
        shape(repeatA) !== shape(pulls[0]), `${shape(repeatA)} vs ${shape(pulls[0])}`);
      // The exact term list, pinned: attacker, weapon, rounds, hits, round index, THEN the rolled damage
      // in the same position the burning-ground seed folds it.
      const expect0 = fx.volleyChaosFor(fx.fxSeedOf(actor.id, gun.id, 1, 1, 0, JSON.stringify({ Torso: [{ damage: 7 }] })));
      ok("F3 seed: the drawn mirror is the one the documented term list computes, rolled damage included",
        pulls[0].volley?.mirrorY === expect0.mirrorY,
        `drawn ${pulls[0].volley?.mirrorY} vs seeded ${expect0.mirrorY} (jitter ${expect0.jitterDeg}°)`);
      ok("F3 seed: the identity fields alone would have computed ONE picture for all six (the reverted shape)",
        new Set([7, 9, 11, 13, 15, 17].map(() => JSON.stringify(fx.volleyChaosFor(fx.fxSeedOf(actor.id, gun.id, 1, 1, 0))))).size === 1,
        "identity-only seed: 1 distinct");

      /* ── F9a. the load's colour reaches the thing that replaced the round ─────────────────── */
      const apiPull = await pull(basePayload({ modifier: "api" }));
      ok("F9 colour: an incendiary shell's volley carries that load's own matrix",
        apiPull.volley?.filterName === "ColorMatrix" && apiPull.volley?.hue === fx.TRACER_COLOR_INCENDIARY.hue,
        JSON.stringify({ filter: apiPull.volley?.filterName, hue: apiPull.volley?.hue }));
      const apPull = await pull(basePayload({ modifier: "ap" }));
      ok("F9 colour: a hardened shell carries the hardened matrix, not the incendiary one",
        apPull.volley?.hue === fx.TRACER_COLOR_HARDENED.hue && fx.TRACER_COLOR_HARDENED.hue !== fx.TRACER_COLOR_INCENDIARY.hue,
        `${apPull.volley?.hue} vs incendiary ${fx.TRACER_COLOR_INCENDIARY.hue}`);
      ok("F9 colour: a BASE shell's volley carries no matrix at all — declared repaintable, painted with nothing (negative)",
        pulls[0].volley?.filterName === null && fx.FX_CLASSES.shotgun.tracerColor === null,
        `base filter ${pulls[0].volley?.filterName}`);
      // Reported on the call's own return as well, so the picture is readable without a recorder.
      const shooterPl = canvas.tokens.get(shooterTok.id), targetPl = canvas.tokens.get(targetTok.id);
      const apiShot = await fx.fxShot(shooterPl, targetPl, { weaponClass: "shotgun", hit: true, light: false, ammoKey: "api", volley: fx.volleySpecFor(6), shotSeed: 7 });
      const stdShot = await fx.fxShot(shooterPl, targetPl, { weaponClass: "shotgun", hit: true, light: false, ammoKey: "standard", volley: fx.volleySpecFor(6), shotSeed: 7 });
      ok("F9 colour: fxShot reports what it painted the volley with — the matrix, or null for none",
        apiShot.volleyColor === fx.TRACER_COLOR_INCENDIARY && stdShot.volleyColor === null && stdShot.volley === true,
        JSON.stringify({ api: apiShot.volleyColor?.hue ?? null, base: stdShot.volleyColor }));

      /* ── F9b. a load that draws its own round is not replaced by the volley ──────────────── */
      ok("F9 geometry: the TABLE says which loads draw their own projectile, by value",
        fx.ammoRedefinesProjectile("standard") === false && fx.ammoRedefinesProjectile("api") === false
        && fx.ammoRedefinesProjectile("ap") === false && fx.ammoRedefinesProjectile("dualPurpose") === false
        && fx.ammoRedefinesProjectile("stundart") === true && fx.ammoRedefinesProjectile("rubber") === true
        && fx.ammoRedefinesProjectile("flechette") === true && fx.ammoRedefinesProjectile("slug") === true
        && fx.ammoRedefinesProjectile(null) === false && fx.ammoRedefinesProjectile("__nope__") === false,
        fx.AMMO_FX_PROJECTILE_FIELDS.join(","));
      const stunPull = await pull(basePayload({ modifier: "stundart" }));
      const stunDarts = stunPull.files.filter((f) => f.file === fx.FX_CLASSES.shotgun.tracer);
      // ⏪ RE-PINNED 2026-08-11: the count was the overlay's eight and is now the SHELL's own six (§21,
      // the single-file ruling extended to this load). The escape this leg guards is untouched — it is
      // the load's GEOMETRY that keeps the volley off it, and the count was never the field carrying it.
      ok("F9 geometry: a stun-dart 00 shell draws its GREY DART FAN and no volley at all",
        stunPull.volley === null && stunPull.res.volley === null
        && stunDarts.length === fx.FX_CLASSES.shotgun.pellets
        && stunDarts.every((d) => d.sat === fx.TRACER_COLOR_DART.saturate),
        `${stunDarts.length} darts, volley ${JSON.stringify(stunPull.res.volley)}`);
      const rubberPull = await pull(basePayload({ modifier: "rubber" }));
      ok("F9 geometry: a baton 00 shell keeps its own round too — the escape is the table's, not one load's",
        rubberPull.volley === null && rubberPull.files.some((f) => f.file === fx.BATON_ROUND.key),
        rubberPull.files.map((f) => String(f.file).split(".").slice(-2).join(".")).join(" "));
      ok("F9 geometry: and buckshot still gets it — the escape did not switch the trial off (negative)",
        pulls[0].res.volley?.band === fx.volleyBandFor(fx.payloadAimSquares(shooterPl, targetPl, Number(canvas.dimensions.size))),
        JSON.stringify(pulls[0].res.volley));
      // The arithmetic has to agree with the fan-out about which shots are volleys, or the window is
      // held shut for a band the shot never drew. The lead-in cancels out of the difference.
      const dSq = fx.payloadAimSquares(shooterPl, targetPl, Number(canvas.dimensions.size));
      const armDiff = fx.payloadPresentationMs(basePayload({ modifier: "stundart" })) - fx.payloadPresentationMs(basePayload());
      const pureDiff = fx.presentationMs(1, "shotgun", "stundart", null) - fx.presentationMs(1, "shotgun", "standard", fx.volleySpecFor(dSq));
      ok("F9 geometry: the tail arithmetic asks the same question the fan-out does, by value",
        armDiff === pureDiff && armDiff !== 0,
        `payload difference ${armDiff}ms vs pure ${pureDiff}ms at ${dSq.toFixed(2)} squares`);

      /* ── F1a. nobody on the map to fire from ─────────────────────────────────────────────── */
      const lonely = await Actor.create({ name: "__PW__RVW No Token", type: "character" });
      const [lonelyGun] = await lonely.createEmbeddedDocuments("Item", [{ name: "__PW__RVW lonely gun", type: "weapon", system: gunSystem }]);
      const inFlightBefore = fx.settlementsInFlight();
      const lonelyRes = await fx.fxWeaponFired({ attackerId: lonely.id, weaponId: lonelyGun.id,
        weaponName: "__PW__RVW lonely gun", caliber: "00", modifier: "standard", shotsFired: 2,
        areaDamages: { Torso: [{ damage: 5 }] } });
      ok("F1 bail: an actor with no token anywhere is a REPORTED non-draw, named for its cause",
        lonelyRes.skipped === "shooter" && lonelyRes.flashes === 0,
        JSON.stringify({ skipped: lonelyRes.skipped, flashes: lonelyRes.flashes }));
      ok("F1 bail: the bail is a report, not a blank — the class, the load and the counts still come back",
        lonelyRes.weaponClass === "shotgun" && lonelyRes.ammoKey === "standard"
        && lonelyRes.shots === 2 && lonelyRes.hits === 1,
        JSON.stringify({ cls: lonelyRes.weaponClass, ammo: lonelyRes.ammoKey, shots: lonelyRes.shots, hits: lonelyRes.hits }));
      ok("F1 bail: it arms NO completion signal — nothing is left waiting on a promise nobody resolves",
        fx.settlementsInFlight() === inFlightBefore, `${inFlightBefore} → ${fx.settlementsInFlight()}`);
      ok("F1 bail: a shooter that IS on the map is untouched by it (negative)",
        pulls[0].res.skipped === null && pulls[0].res.flashes === 1,
        JSON.stringify({ skipped: pulls[0].res.skipped, flashes: pulls[0].res.flashes }));

      /* ── F5. measurement only — recorded for the review, no verdict ──────────────────────── */
      // (a) the arithmetic resolves a volley for a payload the fan-out now refuses outright.
      out.measured.f5NoShooter = {
        arithmeticMs: fx.payloadPresentationMs({ attackerId: lonely.id, weaponId: lonelyGun.id,
          weaponName: "__PW__RVW lonely gun", caliber: "00", modifier: "standard", shotsFired: 1,
          areaDamages: { Torso: [{ damage: 5 }] } }),
        fanOutSkipped: lonelyRes.skipped,
        volleyTermAtZeroSquares: fx.volleySpecFor(0).tailMs,
        sameShotWithNoVolleyTermMs: fx.presentationMs(1, "shotgun", "standard", null),
      };
      // (b) a missed shell stretches to a miss endpoint whose LENGTH is 0.6–1.15 of the true aim, while
      // every timing was computed from the true aim's band. Swept across the reach range by value.
      // The distances chosen are the two kinds of neighbourhood: comfortably inside a band (3, 6, 12,
      // 20) and just BELOW a boundary (4.5, 8.5, 14.5), where the long end of the miss reach is the
      // only way the drawn file can be a LONGER band than the tail was computed from.
      out.measured.f5MissBands = [3, 4.5, 6, 8.5, 12, 14.5, 20].map((d) => {
        const from = { x: 0, y: 0 }, to = { x: d * 100, y: 0 };
        const trueTail = fx.volleySpecFor(d).tailMs;
        const seen = new Set(); let shorterBand = 0, longerBand = 0; const N = 200;
        for (let i = 0; i <= N; i++) {
          const u = i / N;
          const end = fx.missEndpoint(from, to, () => u);
          const drawnSq = Math.hypot(end.x - from.x, end.y - from.y) / 100;
          const drawnTail = fx.volleySpecFor(drawnSq).tailMs;
          seen.add(fx.volleyBandFor(drawnSq));
          if (drawnTail < trueTail) shorterBand++;      // tail over-stated → the window waits too long
          if (drawnTail > trueTail) longerBand++;        // tail UNDER-stated → the scheduled floor is early
        }
        return { trueSquares: d, trueBand: fx.volleyBandFor(d), bandsDrawn: [...seen],
                 reachSquares: [Number((fx.MISS_REACH_MIN * d).toFixed(2)), Number((fx.MISS_REACH_MAX * d).toFixed(2))],
                 tailMsTrue: trueTail,
                 drewShorterBandFraction: Number((shorterBand / (N + 1)).toFixed(3)),
                 drewLongerBandFraction: Number((longerBand / (N + 1)).toFixed(3)),
                 worstUnderstatementMs: fx.volleySpecFor(fx.MISS_REACH_MAX * d).tailMs - trueTail };
      });
    } finally {
      globalThis.Sequence = realSequence;
      await game.settings.set(SCOPE, "combatFxEnabled", fxWas);
    }
    return out;
  });
  fres.checks.push(...r.checks);
  fres.measured = r.measured;
} catch (err) {
  fres.checks.push({ n: "review-fix section ran", p: false, d: String(err?.message ?? err) });
}

/* ══ 19b/c. THE CANARY, DRIVEN FOR REAL — the asset gate, then the control that proves it holds ══ */
// Two runs of the SAME provocation (every database key answers "missing", so the rail queues a whole
// discharge and the engine creates nothing): once with no asset module installed, where the new gate
// must keep it quiet, and once with the assets back, where it must speak. Without the second run the
// first proves only that nothing happened.
const canary = { checks: [] };
const provoke = async () => page.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
  const actor = game.actors.getName("__PW__RVW Shooter");
  const gun = actor?.items.find((i) => i.name === "__PW__RVW shell gun");
  try { globalThis.Sequencer?.EffectManager?.endAllEffects?.(); } catch (_e) { /* none live */ }
  await sleep(900);
  fx._setDbProbe(() => false);
  try {
    Hooks.callAll("cyberpunk2020.weaponFired", { attackerId: actor.id, weaponId: gun.id,
      weaponName: "__PW__RVW shell gun", shotsFired: 1, areaDamages: {},
      fxTargetTokenId: game.scenes.active.tokens.find((t) => t.name === "__PW__RVW Dummy")?.id ?? null });
    // The canary looks once after its own grace window plus the shot's tail; give it both and a margin.
    await sleep(7000);
  } finally { fx._setDbProbe(null); }
  return { jb2a: fx.jb2aActive() };
});

canaryArmed = true;
try {
  const off = await page.evaluate(async () => {
    const SCOPE = "cp2020-augmented";
    const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
    // The asset modules are stood down on this CLIENT only, and by REMOVING THE ENTRY the detector
    // looks up rather than by writing its `active` flag — core declares that flag non-configurable, so
    // there is nothing to overwrite. The removed objects are stashed on the page and put back below (and
    // again from the spec's own finally, so a thrown provocation cannot leave the client short a module).
    globalThis.__pwJb2aStash = globalThis.__pwJb2aStash ?? {};
    const touched = [];
    for (const id of ["jb2a_patreon", "JB2A_DnD5e"]) {
      const m = game.modules.get(id);
      if (!m?.active) continue;
      globalThis.__pwJb2aStash[id] = m;
      game.modules.delete(id);
      touched.push(id);
    }
    return { touched, jb2aWhileOff: fx.jb2aActive() };
  });
  canary.checks.push({ n: "F1 canary: the asset detector really reads as OFF for the gated run",
    p: off.jb2aWhileOff === false && off.touched.length > 0, d: JSON.stringify(off) });
  const r1 = await provoke();
  canary.checks.push({ n: "F1 canary: engine installed, NO assets — the rail draws nothing and says nothing",
    p: canaryLines.length === 0 && r1.jb2a === false, d: `${canaryLines.length} line(s): ${canaryLines.join(" | ")}` });

  const back = await page.evaluate(async () => {
    const SCOPE = "cp2020-augmented";
    const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
    for (const [id, m] of Object.entries(globalThis.__pwJb2aStash ?? {})) game.modules.set(id, m);
    globalThis.__pwJb2aStash = {};
    return { jb2aRestored: fx.jb2aActive() };
  });
  canary.checks.push({ n: "F1 canary: the asset modules are back exactly as they were found",
    p: back.jb2aRestored === true, d: String(back.jb2aRestored) });
  const before = canaryLines.length;
  const r2 = await provoke();
  const said = canaryLines.slice(before);
  canary.checks.push({ n: "F1 canary: with the assets back the SAME provocation does speak — the gate is load-bearing",
    p: said.length === 1 && /Reload this tab/.test(said[0]) && r2.jb2a === true,
    d: `${said.length} line(s): ${said.join(" | ").slice(0, 160)}` });
} catch (err) {
  canary.checks.push({ n: "canary section ran", p: false, d: String(err?.message ?? err) });
} finally {
  canaryArmed = false;
  await page.evaluate(async () => {
    // Belt and braces on the client's own module list, then the fixtures.
    for (const [id, m] of Object.entries(globalThis.__pwJb2aStash ?? {})) game.modules.set(id, m);
    globalThis.__pwJb2aStash = {};
    const scene = game.scenes.active;
    for (const t of [...(scene?.tokens ?? [])].filter((t) => t.name?.startsWith("__PW__RVW"))) await t.delete().catch(() => {});
    for (const a of [...game.actors].filter((a) => a.name?.startsWith("__PW__RVW"))) await a.delete().catch(() => {});
  }).catch(() => {});
}

/* ══ 20. TWO FIGURES, ONE ACTOR: the shot is drawn out of the one that fired ═════════════════════ */
// THE BLIND SPOT THIS CLOSES: every leg above places exactly ONE figure per actor, so the rail's
// origin lookup — first placeable whose actor id matches — could never be caught answering the wrong
// one. It was: with two figures of one actor on the map, a shot fired from the second drew its flash,
// its sprite and its rounds out of the first (reported from the table 2026-08-10). An actor id cannot
// tell the two apart — a copy shares it, and an unlinked figure's own actor carries the base id — so
// the payload has to name the figure outright, and this section drives that field.
//
// Three legs, and the last two are what keep the first honest: the named figure is used, an unnamed
// payload still resolves the way every payload did before the field existed, and a named figure this
// client is not drawing falls through to the same place rather than drawing nothing.
const twins = { checks: [] };
try {
  const r = await page.evaluate(async () => {
    const SCOPE = "cp2020-augmented";
    const out = { checks: [] };
    const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
    const scene = game.scenes.active;

    for (const t of [...(scene?.tokens ?? [])].filter((t) => t.name?.startsWith("__PW__TWIN"))) await t.delete();
    for (const a of [...game.actors].filter((a) => a.name?.startsWith("__PW__TWIN"))) await a.delete();

    const actor = await Actor.create({ name: "__PW__TWIN Shooter", type: "character" });
    const [gun] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__TWIN rifle", type: "weapon",
      system: { weaponType: "Rifle", attackType: "semiAuto", damage: "1d6", range: 50, rof: 1, shots: 10, shotsLeft: 10 } }]);
    // A second weapon whose presentation LENGTH depends on how far the shot travels — the one class
    // that bands its tail by distance. It is what makes the arithmetic leg below a real reading: the
    // two figures stand at different distances from the same mark, so the window a caller waits out
    // differs depending on which figure the arithmetic resolved.
    const [shellGun] = await actor.createEmbeddedDocuments("Item", [{ name: "__PW__TWIN shell gun", type: "weapon",
      system: { weaponType: "Shotgun", attackType: "Shotgun", damage: "3d6", range: 50, rof: 1, shots: 8, shotsLeft: 8 } }]);
    const dummy = await Actor.create({ name: "__PW__TWIN Dummy", type: "character" });
    // TWO figures of the ONE actor, far apart, so the origin is a matter of hundreds of pixels rather
    // than a rounding argument. The order of placement is what the old lookup answered by.
    const [firstTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__TWIN A", actorId: actor.id, actorLink: true, x: 800, y: 2600 }]);
    const [secondTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__TWIN B", actorId: actor.id, actorLink: true, x: 2600, y: 2600 }]);
    const [dummyTok] = await scene.createEmbeddedDocuments("Token", [{ name: "__PW__TWIN Dummy", actorId: dummy.id, actorLink: true, x: 2600, y: 1400 }]);
    await sleep(500);

    const mine = canvas.tokens.placeables.filter((t) => t.actor?.id === actor.id).map((t) => t.id);
    ok("twins: two figures of one actor are on the viewed map, and an actor-id lookup answers the FIRST",
      mine.length === 2 && canvas.tokens.placeables.find((t) => t.actor?.id === actor.id)?.id === firstTok.id,
      `${mine.length} drawn; actor-id lookup → ${canvas.tokens.placeables.find((t) => t.actor?.id === actor.id)?.id === firstTok.id ? "first" : "second"}`);

    const centre = (id) => { const t = canvas.tokens.get(id); return { x: t.center?.x ?? t.x, y: t.center?.y ?? t.y }; };
    const firstC = centre(firstTok.id), secondC = centre(secondTok.id);
    const gridPx = Number(canvas.dimensions.size) || 100;

    const fxWas = game.settings.get(SCOPE, "combatFxEnabled");
    const realSequence = globalThis.Sequence;
    const played = [];
    // The same recording surface §19 uses, with the ORIGIN kept: `atLocation` is handed the figure
    // itself for the rounds and a computed point for the muzzle, so both the id and the coordinates
    // are readable and the leg does not have to infer the origin from the canvas.
    class RecSequence {
      constructor() { this.entries = []; }
      effect() {
        const e = { file: (f) => { this.entries.push({ file: f }); e._i = this.entries.length - 1; return e; },
                    atLocation: (l) => { const t = this.entries[e._i];
                      t.atId = l?.id ?? null; t.atX = Math.round(l?.center?.x ?? l?.x ?? 0); t.atY = Math.round(l?.center?.y ?? l?.y ?? 0); return e; },
                    scale: () => e, endTimePerc: () => e, timeRange: () => e, filter: () => e, opacity: () => e,
                    fadeOut: () => e, playbackRate: () => e, rotateTowards: () => e, size: () => e,
                    elevation: () => e, aboveLighting: () => e, delay: () => e, moveTowards: () => e,
                    moveSpeed: () => e, mirrorY: () => e, name: () => e, duration: () => e,
                    stretchTo: (p) => { this.entries[e._i].toX = Math.round(p?.center?.x ?? p?.x ?? 0); return e; } };
        return e;
      }
      async play() { played.push(this.entries); }
    }
    const payload = (over = {}) => ({ attackerId: actor.id, weaponId: gun.id, weaponName: "__PW__TWIN rifle",
      shotsFired: 1, shotsHit: 1, targetTokenId: dummyTok.id, fxTargetTokenId: dummyTok.id,
      areaDamages: { Torso: [{ damage: 5 }] }, ...over });
    // One trigger pull, reported as where the drawing was anchored: the figure the rounds were hung on
    // and the point the muzzle work was placed at.
    const pull = async (p) => {
      played.length = 0;
      fx._setFlashLevels(new Array(400).fill(1));      // hold the light open long enough to read its key
      const res = await fx.fxWeaponFired(p);
      await sleep(200);
      const all = played.flat();
      const lit = [...canvas.effects.lightSources.keys()].filter((k) => k.startsWith(`${SCOPE}.flash.`));
      fx._setFlashLevels(null); fx.clearFlashes();
      await sleep(120);
      return { res,
        anchoredIds: [...new Set(all.map((x) => x.atId).filter(Boolean))],
        points: all.map((x) => ({ x: x.atX, y: x.atY })),
        flashTokenIds: [...new Set(lit.map((k) => k.split(".")[2]))] };
    };
    const near = (pt, c) => Math.hypot(pt.x - c.x, pt.y - c.y) <= gridPx * 2;
    // Asked of the shipped resolver when it is there, and reported as "no answer" when it is not, so a
    // build without it fails these legs by NAME instead of throwing the whole section away.
    const resolveVia = (p) => (typeof fx.shooterTokenForPayload === "function" ? fx.shooterTokenForPayload(p, actor) : null);

    try {
      await game.settings.set(SCOPE, "combatFxEnabled", true);
      globalThis.Sequence = RecSequence;

      /* ── the named figure is the one that is drawn from ──────────────────────────────────────── */
      const named = await pull(payload({ attackerTokenId: secondTok.id }));
      // Only the ORIGIN side is asserted here: elements anchored on the mark being shot at are the
      // target side of the same draw and belong there, so the claim is about which of the two twins
      // appears, never about the count of anchors.
      ok("twins: a payload naming the SECOND figure hangs its rounds on that figure, and never on the first",
        named.anchoredIds.includes(secondTok.id) && !named.anchoredIds.includes(firstTok.id),
        `anchored on ${JSON.stringify(named.anchoredIds)} (second=${secondTok.id}, first=${firstTok.id})`);
      ok("twins: the muzzle work is placed at the second figure and nothing is placed at the first",
        named.points.some((p) => near(p, secondC)) && !named.points.some((p) => near(p, firstC)),
        `${JSON.stringify(named.points)} — second ${JSON.stringify(secondC)} / first ${JSON.stringify(firstC)}`);
      ok("twins: the light is raised on the second figure's own key",
        named.flashTokenIds.length === 1 && named.flashTokenIds[0] === secondTok.id,
        `${JSON.stringify(named.flashTokenIds)}`);
      ok("twins: the resolver answers the named figure by value",
        resolveVia(payload({ attackerTokenId: secondTok.id }))?.id === secondTok.id,
        String(resolveVia(payload({ attackerTokenId: secondTok.id }))?.id ?? "no resolver"));

      /* ── the fallbacks: unnamed, and named-but-not-drawn-here ────────────────────────────────── */
      const unnamed = await pull(payload());
      ok("twins: a payload naming NO figure resolves the way it always did — the actor lookup (negative)",
        unnamed.anchoredIds.includes(firstTok.id) && !unnamed.anchoredIds.includes(secondTok.id)
        && unnamed.flashTokenIds[0] === firstTok.id
        && resolveVia(payload())?.id === fx.shooterTokenOf(actor)?.id,
        `anchored ${JSON.stringify(unnamed.anchoredIds)} / lit ${JSON.stringify(unnamed.flashTokenIds)}`);
      const foreign = await pull(payload({ attackerTokenId: "nosuchtoken000000" }));
      ok("twins: a figure this client is not drawing falls through to that same lookup, drawing nothing new (negative)",
        foreign.anchoredIds.includes(firstTok.id) && !foreign.anchoredIds.includes(secondTok.id)
        && foreign.res.skipped === null
        && resolveVia(payload({ attackerTokenId: "nosuchtoken000000" }))?.id === firstTok.id,
        `anchored ${JSON.stringify(foreign.anchoredIds)} / skipped ${foreign.res.skipped}`);

      /* ── the window a caller waits out follows the same figure ───────────────────────────────── */
      // The two twins stand at different distances from the mark, and a shell's tail is banded by that
      // distance, so the arithmetic reading the wrong figure is a wrong-length window — the same defect
      // one layer along. Asserted as two different answers, each matching its own figure's band.
      const shellPayload = (over = {}) => payload({ weaponId: shellGun.id, weaponName: "__PW__TWIN shell gun",
        caliber: "00", modifier: "standard", ...over });
      const sqSecond = fx.payloadAimSquares(canvas.tokens.get(secondTok.id), canvas.tokens.get(dummyTok.id), gridPx);
      const sqFirst = fx.payloadAimSquares(canvas.tokens.get(firstTok.id), canvas.tokens.get(dummyTok.id), gridPx);
      const msNamed = fx.payloadPresentationMs(shellPayload({ attackerTokenId: secondTok.id }));
      const msUnnamed = fx.payloadPresentationMs(shellPayload());
      ok("twins: the presentation window is computed from the named figure's own distance, not the first's",
        fx.volleyBandFor(sqSecond) !== fx.volleyBandFor(sqFirst) && msNamed > 0 && msNamed !== msUnnamed,
        `named ${msNamed}ms at ${sqSecond.toFixed(1)} squares (band ${fx.volleyBandFor(sqSecond)}) vs unnamed ${msUnnamed}ms at ${sqFirst.toFixed(1)} (band ${fx.volleyBandFor(sqFirst)})`);
    } finally {
      globalThis.Sequence = realSequence;
      fx._setFlashLevels(null); fx.clearFlashes();
      await game.settings.set(SCOPE, "combatFxEnabled", fxWas);
      for (const t of [...(scene?.tokens ?? [])].filter((t) => t.name?.startsWith("__PW__TWIN"))) await t.delete().catch(() => {});
      for (const a of [...game.actors].filter((a) => a.name?.startsWith("__PW__TWIN"))) await a.delete().catch(() => {});
    }
    return out;
  });
  twins.checks.push(...r.checks);
} catch (err) {
  twins.checks.push({ n: "two-figures section ran", p: false, d: String(err?.message ?? err) });
}

/* ══ 21. THE DART LOAD ON A STREAM CLASS: ONE mark per round, in the round's own slot ═════════════ */
// THE DEFECT THIS SECTION PINS, reported from the bench 2026-08-10: on a class that fires a stream of
// single rounds, the dart load's marks went on arriving for over a second after the last report was
// heard — "the animation simply isn't synced up with the shots". The cause is a count, not a clock: the
// overlay row forced a count of EIGHT onto every round, so a twenty-round payload queued a hundred and
// sixty sprites into a renderer that draws them at its own pace, and the picture finished long after the
// loop that paced it did. The loop itself was already anchored and already refuses late rounds (§17);
// what was left was the backlog those refusals could not reach, because the work was queued by the
// rounds that were NOT refused.
//
// THE RULING (user, 2026-08-10, verbatim): the marks "should come out in the same bullet stream as the
// regular shots do — one after the other, single file." So the row stops naming a count and a cone, and
// the load falls through to the single-mark path every stream class already takes, keeping its own
// geometry (length, crossing, mark width and colour).
//
// ⏪ EXTENDED TO THE OTHER DART LOAD 2026-08-11. Asked whether `stundart` should draw single file the
// way `flechette` now does, the user ruled: "Is it fired from a weapon that usually fires in a single
// file line? If so yes. If it's fired from a shotgun, no." That is the same mechanism rather than a
// second one — the class decides the shape — so the same removal was made at that row (revert values
// `pellets: 8, spreadRad: 0.1`) and its legs are asserted alongside flechette's rather than in a
// section of their own. The negative that used to say "the stun-dart row keeps its own count" is gone
// with it, replaced by the shotgun-class leg that carries what the second half of the ruling protects.
//
// Three kinds of leg, and the third is the one that matters: the row and the resolved entry by value;
// the queue count on a recording surface; and a MEASURED run against the real engine, because an
// arithmetic-only reading is exactly the blind spot this rail has been burned by before — the loop can
// finish on schedule while the picture does not.
const single = { checks: [], measured: {} };
try {
  const r = await page.evaluate(async () => {
    const SCOPE = "cp2020-augmented";
    const out = { checks: [], measured: {} };
    const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
    const scene = game.scenes.active;
    const E = (c, k) => fx.ammoFxEntry(c, k);
    // The classes that draw ONE round per slot — every row whose own geometry names no count.
    const STREAM = ["pistol", "smg", "rifle", "heavy"];

    /* ── a. the row, by value: no count and no cone, everything else kept ───── */
    ok("single file: the overlay row names NO count and NO cone of its own any more",
      fx.AMMO_FX.flechette.pellets === undefined && fx.AMMO_FX.flechette.spreadRad === undefined,
      JSON.stringify(fx.AMMO_FX.flechette));
    ok("single file: the mark's own geometry is untouched — length, crossing, width and colour all stay",
      fx.AMMO_FX.flechette.dashSquares === 1.1 && fx.AMMO_FX.flechette.dashMs === 170
      && fx.AMMO_FX.flechette.impactScale === 0.7
      && fx.AMMO_FX.flechette.tracerColor === fx.TRACER_COLOR_DART,
      JSON.stringify({ len: fx.AMMO_FX.flechette.dashSquares, cross: fx.AMMO_FX.flechette.dashMs,
        scale: fx.AMMO_FX.flechette.impactScale }));

    /* ── b. the resolved entry: one per round on a stream class, geometry kept ── */
    ok("single file: on every class that draws one round per slot, the load leaves it one",
      STREAM.every(c => E(c, "flechette").pellets === undefined && E(c, "flechette").spreadRad === undefined),
      STREAM.map(c => `${c}:${E(c, "flechette").pellets ?? "none"}`).join(" "));
    // The planner is what the draw path asks, so the absence is asserted where it is CONSUMED rather
    // than only where it is declared: no count means no fan, and the draw path falls to one endpoint.
    ok("single file: the fan planner declines to fan for that entry, so the draw path takes one endpoint",
      STREAM.every(c => fx.pelletEndpoints({ x: 0, y: 0 }, { x: 500, y: 0 },
        { pellets: E(c, "flechette").pellets, spreadRad: E(c, "flechette").spreadRad, hit: true }).length === 0),
      `fan length ${fx.pelletEndpoints({ x: 0, y: 0 }, { x: 500, y: 0 }, { pellets: E("rifle", "flechette").pellets, spreadRad: E("rifle", "flechette").spreadRad }).length}`);
    ok("single file: and the mark it draws is still the load's own, not the class's",
      STREAM.every(c => E(c, "flechette").dashSquares === 1.1 && E(c, "flechette").dashMs === 170
        && E(c, "flechette").tracerColor === fx.TRACER_COLOR_DART
        && E(c, "flechette").impactSquares === Number((fx.FX_CLASSES[c].impactSquares * 0.7).toFixed(4))),
      STREAM.map(c => `${c}:${E(c, "flechette").impactSquares}`).join(" "));

    /* ── c. the negatives: what this ruling does NOT reach ──────────────────── */
    // A class whose OWN row fans keeps fanning — the ruling is about an overlay forcing a count onto a
    // class that has none, not about the fan mechanism. With the row's count gone, the shell's own
    // comes through the merge untouched, which is the fall-through rather than a second rule.
    ok("negative: a class whose own row fans keeps fanning — the shell's count and cone come through",
      E("shotgun", "flechette").pellets === fx.FX_CLASSES.shotgun.pellets
      && E("shotgun", "flechette").spreadRad === fx.FX_CLASSES.shotgun.spreadRad
      && E("shotgun", "flechette").pellets === 6,
      JSON.stringify({ pellets: E("shotgun", "flechette").pellets, spreadRad: E("shotgun", "flechette").spreadRad }));
    ok("negative: the shell class row itself is unmoved by any of it",
      fx.FX_CLASSES.shotgun.pellets === 6 && fx.FX_CLASSES.shotgun.spreadRad === 0.07
      && fx.FX_CLASSES.shotgun.dashSquares === 1 && fx.FX_CLASSES.shotgun.dashMs === 150,
      "the class row is unmoved");

    /* ── c-ii. THE SAME RULING ON THE OTHER DART LOAD (2026-08-11) ──────────── */
    // ⏪ THE LEG THAT STOOD HERE asserted "the stun-dart row keeps its own count — this ruling named one
    // load". The 2026-08-11 ruling names this one too, on the class rather than on the load: "Is it
    // fired from a weapon that usually fires in a single file line? If so yes. If it's fired from a
    // shotgun, no." So the row's count and cone are gone by the same removal, and the shotgun half of
    // the ruling is carried by the class row exactly as it is for flechette — which is the negative
    // two legs below.
    ok("single file: the stun-dart row names NO count and NO cone of its own either",
      fx.AMMO_FX.stundart.pellets === undefined && fx.AMMO_FX.stundart.spreadRad === undefined,
      JSON.stringify(fx.AMMO_FX.stundart));
    ok("single file: the stun dart's own geometry is untouched — length, crossing, width and colour stay",
      fx.AMMO_FX.stundart.dashSquares === 1.1 && fx.AMMO_FX.stundart.dashMs === 170
      && fx.AMMO_FX.stundart.impactScale === 0.7
      && fx.AMMO_FX.stundart.tracerColor === fx.TRACER_COLOR_DART,
      JSON.stringify({ len: fx.AMMO_FX.stundart.dashSquares, cross: fx.AMMO_FX.stundart.dashMs,
        scale: fx.AMMO_FX.stundart.impactScale }));
    ok("single file: on every class that draws one round per slot, the stun dart leaves it one",
      STREAM.every(c => E(c, "stundart").pellets === undefined && E(c, "stundart").spreadRad === undefined),
      STREAM.map(c => `${c}:${E(c, "stundart").pellets ?? "none"}`).join(" "));
    // Asserted where the absence is CONSUMED, the same way flechette's is: no count means no fan.
    ok("single file: the fan planner declines to fan for the stun dart on those classes either",
      STREAM.every(c => fx.pelletEndpoints({ x: 0, y: 0 }, { x: 500, y: 0 },
        { pellets: E(c, "stundart").pellets, spreadRad: E(c, "stundart").spreadRad, hit: true }).length === 0),
      `fan length ${fx.pelletEndpoints({ x: 0, y: 0 }, { x: 500, y: 0 }, { pellets: E("rifle", "stundart").pellets, spreadRad: E("rifle", "stundart").spreadRad }).length}`);
    ok("single file: and the mark the stun dart draws is still the load's own, not the class's",
      STREAM.every(c => E(c, "stundart").dashSquares === 1.1 && E(c, "stundart").dashMs === 170
        && E(c, "stundart").tracerColor === fx.TRACER_COLOR_DART
        && E(c, "stundart").impactSquares === Number((fx.FX_CLASSES[c].impactSquares * 0.7).toFixed(4))),
      STREAM.map(c => `${c}:${E(c, "stundart").impactSquares}`).join(" "));
    // ⭐ THE SECOND HALF OF THE RULING, WHICH IS A NEGATIVE: "if it's fired from a shotgun, no." The
    // shell keeps its group, and it keeps it because the CLASS row says so rather than because the
    // overlay was left alone — the same fall-through flechette takes, so the shell's own six at its own
    // cone come through the merge and the load contributes only its look.
    ok("negative: a shotgun-class stun dart still fans — from the shell's own count and cone",
      E("shotgun", "stundart").pellets === fx.FX_CLASSES.shotgun.pellets
      && E("shotgun", "stundart").spreadRad === fx.FX_CLASSES.shotgun.spreadRad
      && E("shotgun", "stundart").pellets === 6 && E("shotgun", "stundart").spreadRad === 0.07,
      JSON.stringify({ pellets: E("shotgun", "stundart").pellets, spreadRad: E("shotgun", "stundart").spreadRad }));
    ok("negative: and that fan is still drawn in the dart look — the shell's count, the load's picture",
      E("shotgun", "stundart").dashSquares === 1.1 && E("shotgun", "stundart").dashMs === 170
      && E("shotgun", "stundart").tracerColor === fx.TRACER_COLOR_DART,
      JSON.stringify({ len: E("shotgun", "stundart").dashSquares, cross: E("shotgun", "stundart").dashMs }));
    // The two dart rows now name the same fields again, which they did before 2026-08-10 — asserted so
    // that a future ruling that moves one of them and not the other is visible here rather than silent.
    ok("single file: both dart rows now say the same thing — a look, and nothing about how many",
      JSON.stringify(Object.keys(fx.AMMO_FX.stundart).sort()) === JSON.stringify(Object.keys(fx.AMMO_FX.flechette).sort())
      && ["pistol", "smg", "rifle", "shotgun", "heavy"].every(c =>
        JSON.stringify(E(c, "stundart")) === JSON.stringify(E(c, "flechette"))),
      Object.keys(fx.AMMO_FX.stundart).sort().join(","));
    ok("classification: the stun dart still declares its own projectile — off the fields that remain",
      fx.ammoRedefinesProjectile("stundart") === true
      && fx.AMMO_FX_PROJECTILE_FIELDS.filter(f => fx.AMMO_FX.stundart[f] !== undefined).join(",") === "dashSquares,dashMs",
      fx.AMMO_FX_PROJECTILE_FIELDS.filter(f => fx.AMMO_FX.stundart[f] !== undefined).join(","));
    // The stun-dart 00 shell is the load the volley escape was WRITTEN for (it was drawing orange
    // fireballs), so the escape is re-read on this row specifically after the count came off it.
    ok("classification: so the stun-dart shell still escapes the round-replacing branch it was rescued from",
      (fx.volleyOwns({ caliber: "00", modifier: "stundart" }) && !fx.ammoRedefinesProjectile("stundart")) === false,
      `buck+stun-dart escapes: ${!(fx.volleyOwns({ caliber: "00", modifier: "stundart" }) && !fx.ammoRedefinesProjectile("stundart"))}`);
    ok("tail: the stun dart's settle arithmetic is unmoved — the crossing time is still the term it reads",
      fx.presentationTailMs("rifle", "stundart") === fx.AMMO_FX.stundart.dashMs + fx.HIT_CONFIRM.clipMs
      && fx.presentationTailMs("rifle", "stundart") === 1003
      && fx.presentationTailMs("rifle", "stundart") === fx.presentationTailMs("rifle", "flechette"),
      `${fx.presentationTailMs("rifle", "stundart")}ms tail`);
    // ⛔ THE CLASSIFICATION MUST SURVIVE THE REMOVAL. `ammoRedefinesProjectile` is key PRESENCE over a
    // list that CONTAINED the count, so dropping the count is exactly the sort of edit that could have
    // silently reclassified this load as "only a tint" — which would hand it to the volley branch and
    // undo the escape the same table's rule was written for. It still answers yes, and it answers yes
    // off the fields that remain.
    ok("classification: the load still declares its own projectile — off the fields that remain",
      fx.ammoRedefinesProjectile("flechette") === true
      && fx.AMMO_FX_PROJECTILE_FIELDS.filter(f => fx.AMMO_FX.flechette[f] !== undefined).join(",") === "dashSquares,dashMs",
      fx.AMMO_FX_PROJECTILE_FIELDS.filter(f => fx.AMMO_FX.flechette[f] !== undefined).join(","));
    ok("classification: so the escape from the replaced-round branch holds, on a buckshot cartridge too",
      (fx.volleyOwns({ caliber: "00", modifier: "flechette" }) && !fx.ammoRedefinesProjectile("flechette")) === false
      && fx.ammoRedefinesProjectile("slug") === true && fx.ammoRedefinesProjectile("api") === false,
      `buck+dart escapes: ${!(fx.volleyOwns({ caliber: "00", modifier: "flechette" }) && !fx.ammoRedefinesProjectile("flechette"))}`);
    // The tail reads `dashMs`, which the removal did not touch, so no apply window moved.
    ok("tail: the settle arithmetic is unmoved — the crossing time is still the term it reads",
      fx.presentationTailMs("rifle", "flechette") === fx.AMMO_FX.flechette.dashMs + fx.HIT_CONFIRM.clipMs
      && fx.presentationTailMs("rifle", "flechette") === 1003
      && fx.presentationMs(10, "rifle", "flechette") === 9 * fx.classCadenceMs("rifle") + 1003,
      `${fx.presentationTailMs("rifle", "flechette")}ms tail, ${fx.presentationMs(10, "rifle", "flechette")}ms for ten rounds`);

    /* ── d. fixtures for the driven legs ────────────────────────────────────── */
    for (const t of [...(scene?.tokens ?? [])].filter(t => t.name?.startsWith("__PW__SF"))) await t.delete();
    for (const a of [...game.actors].filter(a => a.name?.startsWith("__PW__SF"))) await a.delete();
    const shooterActor = await Actor.create({ name: "__PW__SF Shooter", type: "character" });
    const targetActor = await Actor.create({ name: "__PW__SF Target", type: "character" });
    const [gun] = await shooterActor.createEmbeddedDocuments("Item", [{ name: "__PW__SF rifle", type: "weapon",
      system: { weaponType: "Rifle", attackType: "auto", damage: "1d6", range: 50, rof: 20, shots: 40, shotsLeft: 40 } }]);
    const [shooterDoc, targetDoc] = await scene.createEmbeddedDocuments("Token", [
      { name: "__PW__SF Shooter", actorId: shooterActor.id, actorLink: true, x: 1000, y: 2200 },
      { name: "__PW__SF Target", actorId: targetActor.id, actorLink: true, x: 1800, y: 2200 },
    ]);
    await sleep(500);
    const shooterTok = canvas.tokens.get(shooterDoc.id);
    const targetTok = canvas.tokens.get(targetDoc.id);
    const ROUNDS = 20;
    const payload = (over = {}) => ({ attackerId: shooterActor.id, weaponId: gun.id, weaponName: "__PW__SF rifle",
      modifier: "flechette", targetTokenId: targetDoc.id, fxTargetTokenId: targetDoc.id,
      shotsFired: ROUNDS, fumbleRuled: false,
      areaDamages: { Torso: Array.from({ length: ROUNDS }, () => ({ damage: 2 })) }, ...over });

    const fxWas = game.settings.get(SCOPE, "combatFxEnabled");
    const goreWas = game.settings.get(SCOPE, "goreEnabled");
    await game.settings.set(SCOPE, "combatFxEnabled", true);
    // The spray is scene dressing that lingers by design and is excluded from the settle rule; switching
    // it off keeps the census below about the round's own elements rather than about a ruled exclusion.
    await game.settings.set(SCOPE, "goreEnabled", false);
    const AH = foundry.audio.AudioHelper;
    const realPlay = AH.play;
    const realSequence = globalThis.Sequence;
    const audioAt = [];
    AH.play = () => { audioAt.push(Date.now()); return null; };

    try {
      /* ── e. the queue count, on a recording surface ─────────────────────────── */
      // Counted where the work is HANDED OVER rather than on the canvas, so the number is exact and
      // owes nothing to how fast this host happens to draw.
      const filed = [];
      class RecSequence {
        constructor() { this.entries = []; }
        effect() {
          const e = new Proxy({}, { get: (_t, prop) => {
            if (prop === "file") return (f) => { filed.push(String(f)); return e; };
            return () => e;
          } });
          return e;
        }
        async play() { /* nothing is drawn on this surface */ }
      }
      globalThis.Sequence = RecSequence;

      filed.length = 0;
      const oneShot = await fx.fxShot(shooterTok, targetTok, { weaponClass: "rifle", hit: true, light: false, ammoKey: "flechette" });
      const oneBolts = filed.filter(f => f === fx.FX_CLASSES.rifle.tracer).length;
      ok("queue: one round of the dart load hands the engine ONE mark, not a group of them",
        oneShot.pellets === 1 && oneBolts === 1,
        `reported ${oneShot.pellets}, handed over ${oneBolts}`);

      filed.length = 0;
      const burst = await fx.fxWeaponFired(payload());
      const drawnRounds = burst.shots - burst.dropped;
      const bolts = filed.filter(f => f === fx.FX_CLASSES.rifle.tracer).length;
      out.measured.queue = { rounds: burst.shots, dropped: burst.dropped, drawnRounds, bolts,
        perRound: drawnRounds ? Number((bolts / drawnRounds).toFixed(2)) : null };
      // THE LEG THE RULING IS: the count handed over equals the number of rounds drawn, exactly. Before
      // this change it was that number times eight, which is the backlog the report was made of.
      ok("queue: a multi-round payload hands over ONE mark per round drawn — not a group per round",
        bolts === drawnRounds && drawnRounds > 0,
        `${bolts} marks for ${drawnRounds} rounds drawn (of ${burst.shots}); the group form would have handed over ${drawnRounds * 8}`);

      /* ── e-ii. THE SAME CENSUS ON THE STUN DART (2026-08-11 ruling) ─────────── */
      // Counted rather than reasoned about for the same reason: the row being right and the draw path
      // taking the single-mark branch are two different facts, and this is the one the report was about.
      filed.length = 0;
      const oneStun = await fx.fxShot(shooterTok, targetTok, { weaponClass: "rifle", hit: true, light: false, ammoKey: "stundart" });
      const stunBolts = filed.filter(f => f === fx.FX_CLASSES.rifle.tracer).length;
      ok("queue: one round of the stun-dart load hands the engine ONE mark, not a group of them",
        oneStun.pellets === 1 && stunBolts === 1,
        `reported ${oneStun.pellets}, handed over ${stunBolts}`);

      filed.length = 0;
      const stunBurst = await fx.fxWeaponFired(payload({ modifier: "stundart" }));
      const stunDrawn = stunBurst.shots - stunBurst.dropped;
      const stunBurstBolts = filed.filter(f => f === fx.FX_CLASSES.rifle.tracer).length;
      out.measured.stunQueue = { rounds: stunBurst.shots, dropped: stunBurst.dropped, drawnRounds: stunDrawn,
        bolts: stunBurstBolts, perRound: stunDrawn ? Number((stunBurstBolts / stunDrawn).toFixed(2)) : null };
      ok("queue: a stun-dart burst on a stream class hands over ONE mark per round drawn",
        stunBurstBolts === stunDrawn && stunDrawn > 0,
        `${stunBurstBolts} marks for ${stunDrawn} rounds drawn (of ${stunBurst.shots}); the group form would have handed over ${stunDrawn * 8}`);

      // ⭐ THE NEGATIVE, ON THE QUEUE: "if it's fired from a shotgun, no." One shell round still hands
      // over the shell's own six marks, so the second half of the ruling is read off the draw path and
      // not only off the merged table.
      filed.length = 0;
      const stunShell = await fx.fxShot(shooterTok, targetTok, { weaponClass: "shotgun", hit: true, light: false, ammoKey: "stundart" });
      const stunShellBolts = filed.filter(f => f === fx.FX_CLASSES.shotgun.tracer).length;
      ok("queue negative: one shotgun-class stun-dart round still hands over the SHELL's own fan",
        stunShell.pellets === fx.FX_CLASSES.shotgun.pellets && stunShellBolts === fx.FX_CLASSES.shotgun.pellets
        && stunShellBolts === 6,
        `reported ${stunShell.pellets}, handed over ${stunShellBolts}`);
      globalThis.Sequence = realSequence;
      try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none live */ }
      await sleep(400);

      /* ── f. THE MEASURED RUN — the picture ends when the reports stop ───────── */
      // ⚠ MEASURED, NOT COMPUTED, and that is the point of the leg. The arithmetic above can be right
      // while the screen is wrong: the loop paces by the wall clock and the engine draws at its own,
      // so the only honest reading of "is it in sync" is to take the engine's own report of when the
      // last element left the screen and compare it with the last report played.
      //
      // WHAT IS MEASURED. The audio is stubbed to stamp the clock, so the LAST SLOT is a real
      // observation rather than (rounds−1)×cadence assumed. The engine's end-of-element hook stamps the
      // clock for every element it retires, and the census is narrowed to the round's OWN terminal
      // elements — the mark and the hit confirmation, which are exactly the two terms
      // presentationTailMs is built from. The burst dressing (specks, smoke) lingers on purpose and is
      // excluded from the settle rule, so including it here would measure a ruled exclusion.
      //
      // THE BOUND, AND WHY IT IS A COMPARISON RATHER THAN A NUMBER. After the last report what is
      // still owed is one tail — the mark's crossing time plus the hit confirmation's own clip, which
      // is exactly presentationTailMs. On top of that every host adds its own delay between a sprite
      // being handed over and the engine reporting it retired, and on this rig that delay is NOT small:
      // the same twenty-round payload starves the loop badly enough that the drop rule refuses most of
      // it (measured here at 16 of 20, unchanged by this unit — it is a property of a headless rig, and
      // §17 measures the same on a shell payload). A fixed millisecond allowance would therefore be
      // pinning THIS HOST rather than the load.
      //
      // So the SAME payload is run twice, once with no overlay and once with the dart load, and the
      // claim is the ruling itself: the dart load ends when the ordinary stream of single rounds ends.
      // The control measures the host; the difference measures the load. The one allowance that remains
      // is the two loads' own tails, which differ by design (the dart crosses in 170ms and is then
      // marked, where a painted bolt lives its own clip), plus EPSILON_MS for run-to-run jitter.
      //
      // EPSILON = 400ms, stated rather than tuned: two separate runs on a rig that is dropping rounds
      // do not queue the same rounds at the same instants, the end-of-element hook is serviced on a
      // frame boundary, and the audio stamp and the queue call sit in the same tick but not the same
      // instruction. It is still under half the "over a second" the report named, and the absolute
      // figures are printed either way so a regression is readable even where the leg passes.
      const EPSILON_MS = 400;
      const ended = [];
      const endHook = Hooks.on("endedSequencerEffect", (e) => {
        ended.push({ file: String(e?.data?.file ?? ""), at: Date.now() });
      });
      const isRoundElement = (f) => f === fx.FX_CLASSES.rifle.tracer || f === fx.HIT_CONFIRM.key;
      // One payload, driven end to end, reported as the gap between the last report played and the last
      // of THIS round's own terminal elements leaving the screen.
      const run = async (over) => {
        ended.length = 0;
        audioAt.length = 0;
        const p = payload(over);
        const settleWait = fx.presentationSettled(p);
        const res = await fx.fxWeaponFired(p);
        const settleInfo = await settleWait;
        await sleep(900);                     // let the last elements report themselves gone
        const roundEnds = ended.filter(e => isRoundElement(e.file)).map(e => e.at);
        const lastAudioAt = audioAt.length ? Math.max(...audioAt) : null;
        const lastElementAt = roundEnds.length ? Math.max(...roundEnds) : null;
        try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none live */ }
        await sleep(400);
        return { res, settleInfo, reports: audioAt.length, roundElements: roundEnds.length,
          marks: ended.filter(e => e.file === fx.FX_CLASSES.rifle.tracer).length,
          trailMs: (lastAudioAt !== null && lastElementAt !== null) ? lastElementAt - lastAudioAt : null };
      };

      // THE CONTROL FIRST — the ordinary stream of single rounds the ruling names as the target.
      const ctrl = await run({ modifier: "standard" });
      const live = await run({});
      const dartTail = fx.presentationTailMs("rifle", "flechette");
      const ctrlTail = fx.presentationTailMs("rifle", "standard");
      const allowedMs = ctrl.trailMs !== null ? ctrl.trailMs + (dartTail - ctrlTail) + EPSILON_MS : null;
      Hooks.off("endedSequencerEffect", endHook);

      out.measured.sync = {
        rounds: live.res.shots, epsilonMs: EPSILON_MS,
        control: { load: "standard", dropped: ctrl.res.dropped, reports: ctrl.reports,
          elements: ctrl.roundElements, marks: ctrl.marks, trailMs: ctrl.trailMs, tailMs: ctrlTail,
          loopMs: ctrl.res.loopMs, settleVia: ctrl.settleInfo.via, settleMs: ctrl.settleInfo.ms },
        dart: { load: "flechette", dropped: live.res.dropped, reports: live.reports,
          elements: live.roundElements, marks: live.marks, trailMs: live.trailMs, tailMs: dartTail,
          loopMs: live.res.loopMs, settleVia: live.settleInfo.via, settleMs: live.settleInfo.ms },
        allowedMs, intendedLoopMs: (live.res.shots - 1) * live.res.cadenceMs, maxLagMs: live.res.maxLagMs,
      };

      ok("measured: both runs produced both readings — reports played and round elements retired",
        ctrl.trailMs !== null && live.trailMs !== null && live.roundElements > 0 && ctrl.roundElements > 0,
        `control ${ctrl.reports} reports / ${ctrl.roundElements} elements; dart ${live.reports} / ${live.roundElements}`);
      // ⭐ THE RULING, AS A NUMBER: the dart load's picture ends when the ordinary stream's picture ends,
      // give or take the two loads' own tails. This is the leg the report was about.
      ok("measured: the dart load's picture ends with the ordinary stream's, not a second behind it",
        live.trailMs !== null && allowedMs !== null && live.trailMs <= allowedMs,
        `dart ${live.trailMs}ms after its last report vs control ${ctrl.trailMs}ms; allowed ${allowedMs}ms (control + tail difference ${dartTail - ctrlTail}ms + ${EPSILON_MS}ms)`);
      // The loop's own half of the contract, re-read on this payload: the schedule is anchored, so the
      // reports themselves end when they are due. A trail is only meaningful against a loop that did.
      ok("measured: and the reports themselves ran to the anchored schedule, so the trail is the picture's",
        live.res.loopMs < (live.res.shots - 1) * live.res.cadenceMs * 1.25,
        `${live.res.loopMs}ms against an intended ${(live.res.shots - 1) * live.res.cadenceMs}ms`);
      // The engine drew ONE element per round, read off the engine rather than off the queue — the same
      // claim as the recording-surface leg, taken on the real surface where the backlog was.
      ok("measured: the engine retired one mark per round drawn, never a group per round",
        live.marks <= live.res.shots - live.res.dropped,
        `${live.marks} marks retired for ${live.res.shots - live.res.dropped} rounds drawn; the group form retires ${(live.res.shots - live.res.dropped) * 8}`);
      ok("measured: and the damage window still closed on the engine's own signal, not on the cap",
        live.settleInfo.via !== "cap" && live.settleInfo.ms < fx.PRESENTATION_CAP_MS,
        `${live.settleInfo.via} at ${live.settleInfo.ms}ms (cap ${fx.PRESENTATION_CAP_MS}ms)`);
    } finally {
      globalThis.Sequence = realSequence;
      AH.play = realPlay;
      try { Sequencer.EffectManager.endAllEffects(); } catch (e) { /* none live */ }
      await sleep(300);
      await game.settings.set(SCOPE, "combatFxEnabled", fxWas);
      await game.settings.set(SCOPE, "goreEnabled", goreWas);
      for (const m of game.messages.filter(m => m.speaker?.actor === shooterActor.id)) { try { await m.delete(); } catch (e) { /* gone */ } }
      for (const t of [...(scene?.tokens ?? [])].filter(t => t.name?.startsWith("__PW__SF"))) await t.delete().catch(() => {});
      for (const a of [...game.actors].filter(a => a.name?.startsWith("__PW__SF"))) await a.delete().catch(() => {});
    }
    ok("cleanup: the fixtures are gone and the switches are as they were found",
      game.actors.filter(a => a.name?.startsWith("__PW__SF")).length === 0
      && game.settings.get(SCOPE, "goreEnabled") === goreWas,
      `${game.actors.filter(a => a.name?.startsWith("__PW__SF")).length} left`);
    return out;
  });
  single.checks.push(...r.checks);
  single.measured = r.measured;
} catch (err) {
  single.checks.push({ n: "single-file section ran", p: false, d: String(err?.message ?? err) });
}

console.log("\n=== combat FX rail keeper ===");
for (const c of res.checks) check(c.n, c.p, c.d);
for (const c of xres.checks) check(c.n, c.p, c.d);
for (const c of gres.checks) check(c.n, c.p, c.d);
for (const c of pres.checks) check(c.n, c.p, c.d);
for (const c of ares.checks) check(c.n, c.p, c.d);
for (const c of bres.checks) check(c.n, c.p, c.d);
for (const c of cres.checks) check(c.n, c.p, c.d);
for (const c of ires.checks) check(c.n, c.p, c.d);
for (const c of fres.checks) check(c.n, c.p, c.d);
for (const c of canary.checks) check(c.n, c.p, c.d);
for (const c of twins.checks) check(c.n, c.p, c.d);
for (const c of single.checks) check(c.n, c.p, c.d);
console.log(`  dart load, single-file queue: ${JSON.stringify(single.measured?.queue ?? null)}`);
console.log(`  stun-dart load, single-file queue: ${JSON.stringify(single.measured?.stunQueue ?? null)}`);
console.log(`  dart load, MEASURED sync (trail after the last report): ${JSON.stringify(single.measured?.sync ?? null)}`);
console.log(`  F5 (measurement, no ruling yet) no-shooter arithmetic: ${JSON.stringify(fres.measured?.f5NoShooter ?? null)}`);
console.log(`  F5 (measurement, no ruling yet) missed-shell band sweep: ${JSON.stringify(fres.measured?.f5MissBands ?? null)}`);
console.log(`  pacing under load, measured: ${JSON.stringify(cres.measured ?? null)}`);
console.log(`  blood splash, measured: ${JSON.stringify(bres.measured ?? null)}`);
console.log(`  burning-ground clip, decoded off the install: ${JSON.stringify(ares.groundFireDecode ?? null)}`);
console.log(`  measured envelope on this rig: ${JSON.stringify(res.measuredEnvelope)}`);
console.log(`  sounds directory listing at run time: ${JSON.stringify(res.soundsDelivered)}`);
console.log(`  shell-class assets: ${JSON.stringify(res.shellAssets)}`);
console.log(`  drawn tracers: ${JSON.stringify(res.drawnTracers)}`);
console.log(`  dialog deferral: ${JSON.stringify(res.dialogDeferral)}`);
console.log(`  attack window lifetime: ${JSON.stringify(res.attackWindow)}`);
console.log(`  write authority (non-GM, own card vs another's): ${JSON.stringify(res.writeAuthority)}`);
console.log(`  ten-round burst cost: ${JSON.stringify(res.burstCost)}`);
console.log(`  engine teardown races absorbed (this spec's own endAllEffects, not the product): ${engineRaces.length}`);
check("0 console errors", errors.length === 0, errors.slice(0, 5).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} — ${pass}/${pass + fail}`);
await browser.close();
process.exit(fail ? 1 : 0);
