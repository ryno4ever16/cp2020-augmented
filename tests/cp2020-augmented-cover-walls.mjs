/**
 * KEEPER: cover Unit 3 — native Wall documents carrying cover data.
 *  - coverWallsOn: unflagged walls excluded; SP-only wall reads the 3xSP structure default;
 *    explicit structure numbers respected; a legacy stored material label still wins (the field that
 *    wrote it is retired but the value is still read), else the localized wall/door fallback
 *  - coverChoicesFor merges wall rows with zone rows and sorts nearest-first (every row carries a uuid)
 *  - chewCoverWall: exact structure debit, chat card per debit, destroyed flip at 0,
 *    door-state flip to open at zero structure (non-door walls leave door state untouched),
 *    idempotent on an already-destroyed wall (no extra card)
 *  - chewCover dispatcher routes a Wall uuid to the wall branch and a behavior uuid to the zone branch
 *  - the native wall configuration sheet carries exactly the three structure fields (the material
 *    input is gone and nothing writes that flag), the SP->structure pre-fill fires on a real change
 *    event, the sheet's own submit persists the flags, and an unnamed wall falls back to the
 *    localized generic label
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file>
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const SCOPE = "cp2020-augmented";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
// ⭐ COMPATIBILITY WARNINGS ARE COLLECTED SEPARATELY (2026-08-27), because the error collector below
// filters them out and the Clear/Repair controls are exactly where one used to fire: those handlers
// hand-rolled the legacy `-=` deletion key, which v14 answers with a deprecation warning rather than an
// error. They now go through `utils.deleteFieldUpdate`, which asks the RUNNING core which spelling it
// speaks — and "no warning fires when the button is pressed" is the only reading that says so.
const compatWarnings = [];
const isCompat = (t) => /deprecat|is deprecated|compatibility/i.test(t);
page.on("console", m => {
  const t = m.text();
  if (isCompat(t) && /cp2020-augmented|-=|ForcedDeletion|deletion/i.test(t)) compatWarnings.push(t);
  if (m.type() === "error" && !/compatibility|deprecat|screen resolution/i.test(t)) errors.push(t);
});
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

/* ─────────────────────── phase 1: pure engine (rows, sorting, debit lifecycle) ─────────────────────── */
const res = await page.evaluate(async (SCOPE) => {
  const out = { checks: [], ids: {} };
  const ok = (n, p, d) => out.checks.push({ n, p: !!p, d: d === undefined ? "" : String(d) });

  if (!game.scenes.active) await (game.scenes.getName("Foundry Virtual Tabletop") ?? game.scenes.contents[0])?.activate();
  const scene = game.scenes.active;
  out.ids.sceneId = scene.id;

  // stale cleanup from any interrupted run
  const staleWalls = [...scene.walls].filter(w => w.flags?.[SCOPE]?.__pwk === true).map(w => w.id);
  if (staleWalls.length) await scene.deleteEmbeddedDocuments("Wall", staleWalls);
  for (const r of [...scene.regions]) if (r.name?.startsWith("__PWX__")) await r.delete();
  for (const a of [...game.actors]) if (a.name?.startsWith("__PWX__")) await a.delete();

  const cov = await import(`/modules/${SCOPE}/module/combat/cover.js`);
  const mkWall = async (data) => {
    const [w] = await scene.createEmbeddedDocuments("Wall", [{
      ...data,
      flags: { [SCOPE]: { __pwk: true, ...(data.flags?.[SCOPE] ?? {}) } },
    }]);
    return w;
  };
  const rowFor = (uuid) => cov.coverWallsOn(scene).find(r => r.uuid === uuid);

  /* a. an unflagged wall is not a cover row */
  const wPlain = await mkWall({ c: [2000, 1000, 2200, 1000] });
  ok("unflagged wall absent from wall rows", !rowFor(wPlain.uuid));

  /* b. ⭐ SP ALONE IS CORE-MODE COVER — permanent, no structure ledger (ruled 2026-08-26).
     ⏪ THIS LEG IS INVERTED FROM WHAT IT PINNED BEFORE. It used to assert that a blank structure
     field floated on a silent 3xSP default, which is exactly the behaviour the ruling removed: a GM
     who has only read the core rulebook could watch a door they priced at SP 5 shatter under a rule
     from a book they do not own. Blank now means permanent, and the 3xSP figure is offered VISIBLY
     in the form instead (see the sheet phase below). */
  const wDefault = await mkWall({ c: [2000, 1040, 2200, 1040], flags: { [SCOPE]: { coverSp: 10 } } });
  const rDefault = rowFor(wDefault.uuid);
  ok("SP-only wall: sp 10", rDefault?.sp === 10, String(rDefault?.sp));
  ok("SP-only wall: it is CORE mode — no structure at all", rDefault?.structured === false, String(rDefault?.structured));
  ok("SP-only wall: reports no pool, and 0 is NOT destruction", rDefault?.pool === 0 && rDefault?.poolMax === 0 && rDefault?.destroyed === false,
    `${rDefault?.pool}/${rDefault?.poolMax} destroyed=${rDefault?.destroyed}`);
  ok("SP-only wall: the mode predicates agree with the row", cov.coverModeOf(rDefault) === "core" && cov.coverChews(rDefault) === false,
    `${cov.coverModeOf(rDefault)} / ${cov.coverChews(rDefault)}`);
  ok("SP-only wall: it still SOAKS — the ledger hands out its SP every round",
    (() => { const l = cov.makeCoverLedger({ coverSP: rDefault.sp, cover: rDefault }); return l.spForRound() === 10 && l.absorb(999) === null && l.spForRound() === 10; })(),
    "sp held, nothing booked");
  ok("SP-only wall: localized fallback label", rDefault?.label === "Wall", String(rDefault?.label));
  ok("fallback label carries no raw key text", !/CYBERPUNK\./.test(String(rDefault?.label)));
  /* ⛔ AND NO CARD, EVER, for core-mode cover — the whole point of the split. */
  const coreMsgIds = new Set(game.messages.map(m => m.id));
  const coreChew = await cov.chewCoverWall({ wallUuid: wDefault.uuid, damage: 999, weaponName: "__PWX__Source" });
  await new Promise(r => setTimeout(r, 400));
  ok("SP-only wall: a chew is refused with the core marker, nothing written",
    coreChew?.skipped === "core" && coreChew?.mode === "core" && wDefault.flags?.[SCOPE]?.coverPool === undefined,
    JSON.stringify(coreChew));
  ok("SP-only wall: NO structure card is posted for it",
    game.messages.filter(m => !coreMsgIds.has(m.id) && m.content.includes("cp-cover-chew")).length === 0,
    String(game.messages.filter(m => !coreMsgIds.has(m.id) && m.content.includes("cp-cover-chew")).length));
  ok("SP-only wall: it is not breached, and its restrictions are untouched",
    !wDefault.flags?.[SCOPE]?.coverBreach && rowFor(wDefault.uuid)?.destroyed === false);

  /* b-bis. ⭐ ONE NUMBER OPTS IT IN. Same wall shape, one structure value, full MM lifecycle. */
  const wOptIn = await mkWall({ c: [2000, 1020, 2200, 1020], flags: { [SCOPE]: { coverSp: 10, coverPoolMax: 30 } } });
  const rOptIn = rowFor(wOptIn.uuid);
  ok("opt-in wall: a stored total is what turns the lifecycle on",
    rOptIn?.structured === true && rOptIn?.poolMax === 30 && rOptIn?.pool === 30,
    `${rOptIn?.pool}/${rOptIn?.poolMax} structured=${rOptIn?.structured}`);
  ok("opt-in wall: the mode predicates agree", cov.coverModeOf(rOptIn) === "mm" && cov.coverChews(rOptIn) === true);
  const wOptPool = await mkWall({ c: [2000, 1000, 2100, 1002], flags: { [SCOPE]: { coverSp: 10, coverPool: 18 } } });
  ok("opt-in wall: a REMAINING structure alone also opts in, and becomes its own total",
    rowFor(wOptPool.uuid)?.structured === true && rowFor(wOptPool.uuid)?.pool === 18 && rowFor(wOptPool.uuid)?.poolMax === 18,
    JSON.stringify(rowFor(wOptPool.uuid)));

  /* c. explicit structure numbers respected; material wins the label; door fallback label */
  const wExplicit = await mkWall({ c: [2000, 1080, 2200, 1080], flags: { [SCOPE]: { coverSp: 10, coverPool: 12, coverPoolMax: 40, coverMaterial: "__PWX__Barrier" } } });
  const rExplicit = rowFor(wExplicit.uuid);
  ok("explicit structure numbers respected 12/40", rExplicit?.pool === 12 && rExplicit?.poolMax === 40, `${rExplicit?.pool}/${rExplicit?.poolMax}`);
  ok("explicit row keeps sp 10 (structure independent of SP)", rExplicit?.sp === 10, String(rExplicit?.sp));
  ok("material string wins the label", rExplicit?.label === "__PWX__Barrier", String(rExplicit?.label));
  const wDoorLabel = await mkWall({ c: [2000, 1120, 2200, 1120], door: 1, ds: 0, flags: { [SCOPE]: { coverSp: 5, coverPoolMax: 15 } } });
  const rDoorLabel = rowFor(wDoorLabel.uuid);
  ok("door wall flagged isDoor", rDoorLabel?.isDoor === true, String(rDoorLabel?.isDoor));
  ok("door fallback label", rDoorLabel?.label === "Door", String(rDoorLabel?.label));
  ok("door with a stated structure reads 15/15", rDoorLabel?.pool === 15 && rDoorLabel?.poolMax === 15, `${rDoorLabel?.pool}/${rDoorLabel?.poolMax}`);
  const wDoorCore = await mkWall({ c: [2000, 1100, 2100, 1102], door: 1, ds: 0, flags: { [SCOPE]: { coverSp: 5 } } });
  ok("a DOOR with SP alone is core cover too — it soaks and never breaks open",
    rowFor(wDoorCore.uuid)?.structured === false && rowFor(wDoorCore.uuid)?.destroyed === false);

  /* d. picker rows merge zones + walls, nearest-first */
  const farZone = await cov.placeCoverZone({ scene, label: "__PWX__FarZone", sp: 5, poolMax: 15 });
  await farZone.update({ shapes: [{ type: "rectangle", x: 100, y: 100, width: 100, height: 100, rotation: 0 }] });
  const wNear = await mkWall({ c: [2100, 1200, 2300, 1200], flags: { [SCOPE]: { coverSp: 10, coverMaterial: "__PWX__NearWall" } } });
  const actor = await Actor.create({ name: "__PWX__Probe", type: "character" });
  const [tok] = await scene.createEmbeddedDocuments("Token", [{ name: actor.name, actorId: actor.id, x: 2100, y: 1100, width: 1, height: 1 }]);
  const mine = cov.coverChoicesFor(tok).filter(c => c.label === "__PWX__NearWall" || c.label === "__PWX__FarZone");
  ok("picker rows merge wall + zone", mine.length === 2, mine.map(c => c.label).join(","));
  ok("picker rows sorted nearest-first", mine[0]?.label === "__PWX__NearWall" && mine[1]?.label === "__PWX__FarZone", mine.map(c => c.label).join(","));
  ok("wall row carries a Wall uuid", /\.Wall\./.test(String(mine[0]?.uuid)), String(mine[0]?.uuid));
  ok("zone row carries a RegionBehavior uuid", /RegionBehavior/.test(String(mine[1]?.uuid)), String(mine[1]?.uuid));

  /* e/f. debit lifecycle on a NON-door wall */
  const msgIds = new Set(game.messages.map(m => m.id));
  const newCards = () => game.messages.filter(m => !msgIds.has(m.id) && m.content.includes("cp-cover-chew"));

  const wChew = await mkWall({ c: [2000, 1160, 2200, 1160], flags: { [SCOPE]: { coverSp: 10, coverPoolMax: 30, coverMaterial: "__PWX__ChewWall" } } });
  const c1 = await cov.chewCoverWall({ wallUuid: wChew.uuid, damage: 14, weaponName: "__PWX__Source" });
  ok("structure debit exact: 30 -> 16", c1?.pool === 16 && c1?.destroyed === false, JSON.stringify(c1));
  ok("debit persisted to wall flags", wChew.flags?.[SCOPE]?.coverPool === 16 && wChew.flags?.[SCOPE]?.coverPoolMax === 30, JSON.stringify(wChew.flags?.[SCOPE]));
  await new Promise(r => setTimeout(r, 400));
  let cards = newCards();
  ok("one debit card posted", cards.length === 1, String(cards.length));
  ok("card names the object and the amount", (cards[0]?.content ?? "").includes("__PWX__ChewWall") && (cards[0]?.content ?? "").includes("14"));

  const c2 = await cov.chewCoverWall({ wallUuid: wChew.uuid, damage: 16 });
  ok("debit to zero flips destroyed", c2?.pool === 0 && c2?.destroyed === true, JSON.stringify(c2));
  ok("non-door wall keeps its door state", (wChew._source?.ds ?? wChew.ds) === 0, String(wChew._source?.ds ?? wChew.ds));
  ok("non-door wall stays a non-door", (wChew._source?.door ?? wChew.door) === 0, String(wChew._source?.door ?? wChew.door));
  await new Promise(r => setTimeout(r, 400));
  cards = newCards();
  ok("second card posted", cards.length === 2, String(cards.length));
  ok("destroyed card carries the destroyed line", /is destroyed/i.test(cards[1]?.content ?? ""), (cards[1]?.content ?? "").slice(0, 200));
  ok("destroyed card is NOT the door-opened line", !/broken open/i.test(cards[1]?.content ?? ""));

  const c3 = await cov.chewCoverWall({ wallUuid: wChew.uuid, damage: 10 });
  await new Promise(r => setTimeout(r, 400));
  ok("further debit on a destroyed wall is a no-op", c3?.already === true && c3?.pool === 0, JSON.stringify(c3));
  ok("no extra card for the no-op", newCards().length === 2, String(newCards().length));

  /* g. DOOR wall broken open at zero structure */
  const wDoor = await mkWall({ c: [2000, 1240, 2200, 1240], door: 1, ds: 0, flags: { [SCOPE]: { coverSp: 5, coverPoolMax: 15, coverMaterial: "__PWX__ChewDoor" } } });
  ok("door starts closed", (wDoor._source?.ds ?? wDoor.ds) === 0, String(wDoor._source?.ds ?? wDoor.ds));
  const d1 = await cov.chewCoverWall({ wallUuid: wDoor.uuid, damage: 15 });
  ok("door structure debit to zero flips destroyed", d1?.pool === 0 && d1?.destroyed === true, JSON.stringify(d1));
  ok("door state flips to open at zero structure", (wDoor._source?.ds ?? wDoor.ds) === (CONST?.WALL_DOOR_STATES?.OPEN ?? 1), String(wDoor._source?.ds ?? wDoor.ds));
  await new Promise(r => setTimeout(r, 400));
  cards = newCards();
  ok("door card posted", cards.length === 3, String(cards.length));
  ok("door card carries the broken-open line", /broken open/i.test(cards[2]?.content ?? ""), (cards[2]?.content ?? "").slice(0, 200));
  // ⭐ THE DOOR POP-OPEN PATH IS THE REGRESSION PIN (field-confirmed working before this unit; the
  // ruling asked only that it keep working). The BREACH below is the new behaviour beside it.
  ok("door regression pin: the pop-open path still fires at zero structure",
    (wDoor._source?.ds ?? wDoor.ds) === (CONST?.WALL_DOOR_STATES?.OPEN ?? 1));

  /* ── ① THE BREACH: at zero structure the wall's three restrictions OPEN, reversibly ────────── */
  const OPEN_MOVE = CONST?.WALL_MOVEMENT_TYPES?.NONE ?? 0;
  const OPEN_SENSE = CONST?.WALL_SENSE_TYPES?.NONE ?? 0;
  const wBreach = await mkWall({
    c: [2000, 1400, 2200, 1400],
    move: CONST.WALL_MOVEMENT_TYPES.NORMAL, sight: CONST.WALL_SENSE_TYPES.NORMAL, sound: CONST.WALL_SENSE_TYPES.NORMAL,
    flags: { [SCOPE]: { coverSp: 10, coverPoolMax: 30, coverMaterial: "__PWX__BreachWall" } },
  });
  ok("breach: the wall starts restricting all three", wBreach.move !== OPEN_MOVE && wBreach.sight !== OPEN_SENSE && wBreach.sound !== OPEN_SENSE,
    `${wBreach.move}/${wBreach.sight}/${wBreach.sound}`);
  const preMove = wBreach.move, preSight = wBreach.sight, preSound = wBreach.sound;
  const b1 = await cov.chewCoverWall({ wallUuid: wBreach.uuid, damage: 12 });
  ok("breach: a PARTIAL debit breaches nothing (negative)",
    b1?.breached !== true && wBreach.move === preMove && !wBreach.flags?.[SCOPE]?.coverBreach,
    `${JSON.stringify(b1)} move=${wBreach.move}`);
  const b2 = await cov.chewCoverWall({ wallUuid: wBreach.uuid, damage: 18 });
  ok("breach: the debit that empties the pool reports the breach", b2?.destroyed === true && b2?.breached === true, JSON.stringify(b2));
  ok("breach: ALL THREE restrictions are open — move, sight and sound",
    wBreach.move === OPEN_MOVE && wBreach.sight === OPEN_SENSE && wBreach.sound === OPEN_SENSE,
    `${wBreach.move}/${wBreach.sight}/${wBreach.sound}`);
  const snap = wBreach.flags?.[SCOPE]?.coverBreach;
  ok("breach: the ORIGINAL values are snapshotted, so the change is reversible by construction",
    snap && snap.move === preMove && snap.sight === preSight && snap.sound === preSound, JSON.stringify(snap));
  await new Promise(r => setTimeout(r, 400));
  const breachCard = game.messages.filter(m => !msgIds.has(m.id) && m.content.includes("__PWX__BreachWall")).pop();
  ok("breach: the card ANNOUNCES it", /breached/i.test(breachCard?.content ?? ""), (breachCard?.content ?? "").slice(0, 260));
  ok("breach: the card carries the GM repair control, wired to this wall",
    (breachCard?.content ?? "").includes("cp-cover-repair") && (breachCard?.content ?? "").includes(wBreach.uuid),
    (breachCard?.content ?? "").includes("cp-cover-repair") ? "button present" : "button ABSENT");
  // A second debit on a breached wall must not re-snapshot the OPEN values as the "original".
  await cov.chewCoverWall({ wallUuid: wBreach.uuid, damage: 5 });
  ok("breach: a later debit does not overwrite the snapshot with the open values",
    wBreach.flags?.[SCOPE]?.coverBreach?.move === preMove, JSON.stringify(wBreach.flags?.[SCOPE]?.coverBreach));

  /* ── ① THE REPAIR: one call, both halves back ─────────────────────────────────────────────── */
  const rep = await cov.repairCoverWall({ wallUuid: wBreach.uuid });
  ok("repair: it reports the restore and the refilled total", rep?.repaired === true && rep?.pool === 30, JSON.stringify(rep));
  ok("repair: all three restrictions are EXACTLY what they were",
    wBreach.move === preMove && wBreach.sight === preSight && wBreach.sound === preSound,
    `${wBreach.move}/${wBreach.sight}/${wBreach.sound} vs ${preMove}/${preSight}/${preSound}`);
  ok("repair: the structure is full again", rowFor(wBreach.uuid)?.pool === 30 && rowFor(wBreach.uuid)?.destroyed === false,
    JSON.stringify(rowFor(wBreach.uuid)));
  ok("repair: the snapshot is cleared, so the wall is indistinguishable from one never breached",
    wBreach.flags?.[SCOPE]?.coverBreach === undefined, String(wBreach.flags?.[SCOPE]?.coverBreach));
  await new Promise(r => setTimeout(r, 400));
  ok("repair: it posts its own receipt so the table sees the map change back",
    game.messages.filter(m => !msgIds.has(m.id) && m.content.includes("cp-cover-repair-card")).length === 1,
    String(game.messages.filter(m => !msgIds.has(m.id) && m.content.includes("cp-cover-repair-card")).length));
  const rep2 = await cov.repairCoverWall({ wallUuid: wBreach.uuid });
  ok("repair: a second press on an unbreached wall is a no-op (negative)", rep2?.already === true, JSON.stringify(rep2));
  // And the wall breaches AGAIN afterwards — the lifecycle is a cycle, not a one-shot.
  await cov.chewCoverWall({ wallUuid: wBreach.uuid, damage: 30 });
  ok("repair: a repaired wall can breach again", wBreach.move === OPEN_MOVE && !!wBreach.flags?.[SCOPE]?.coverBreach);
  await cov.repairCoverWall({ wallUuid: wBreach.uuid });

  /* ── ① a DOOR's own state rides the snapshot ──────────────────────────────────────────────── */
  const wDoorBreach = await mkWall({
    c: [2000, 1440, 2200, 1440], door: 1, ds: 0,
    move: CONST.WALL_MOVEMENT_TYPES.NORMAL, sight: CONST.WALL_SENSE_TYPES.NORMAL,
    flags: { [SCOPE]: { coverSp: 5, coverPoolMax: 15, coverMaterial: "__PWX__BreachDoor" } },
  });
  await cov.chewCoverWall({ wallUuid: wDoorBreach.uuid, damage: 15 });
  ok("breach: a door breaches AND pops open together",
    (wDoorBreach._source?.ds ?? wDoorBreach.ds) === (CONST?.WALL_DOOR_STATES?.OPEN ?? 1)
    && wDoorBreach.move === OPEN_MOVE && !!wDoorBreach.flags?.[SCOPE]?.coverBreach,
    `ds=${wDoorBreach._source?.ds ?? wDoorBreach.ds} move=${wDoorBreach.move}`);
  await cov.repairCoverWall({ wallUuid: wDoorBreach.uuid });
  ok("repair: the door is shut again and restricts what it did",
    (wDoorBreach._source?.ds ?? wDoorBreach.ds) === 0 && wDoorBreach.move !== OPEN_MOVE,
    `ds=${wDoorBreach._source?.ds ?? wDoorBreach.ds} move=${wDoorBreach.move}`);

  /* ── ⑤ THE NAKED-INDESTRUCTIBLE GUARANTEE ─────────────────────────────────────────────────── */
  // A wall with no cover values is not a cover row, cannot be chewed, cannot breach, and is
  // spread-EXEMPT rather than soaking. Every one of those asserted, plus the same state reached by
  // CLEARING a wall that used to carry values.
  const wNaked = await mkWall({ c: [2000, 1480, 2200, 1480], move: CONST.WALL_MOVEMENT_TYPES.NORMAL, sight: CONST.WALL_SENSE_TYPES.NORMAL });
  ok("naked: no picker row", !rowFor(wNaked.uuid));
  ok("naked: no row in coverChoicesFor either", !cov.coverChoicesFor(tok).some(r => r.uuid === wNaked.uuid));
  ok("naked: a chew is refused outright", (await cov.chewCoverWall({ wallUuid: wNaked.uuid, damage: 50 })) === null);
  ok("naked: it cannot breach — its restrictions are untouched and no snapshot is written",
    wNaked.move === CONST.WALL_MOVEMENT_TYPES.NORMAL && !wNaked.flags?.[SCOPE]?.coverBreach,
    `move=${wNaked.move}`);
  ok("naked: it is not a VALUED crossing, so an area exempts rather than soaks",
    cov.valuedCoverAlong(scene, { x: 2000, y: 1400 }, { x: 2200, y: 1560 }).every(r => r.uuid !== wNaked.uuid));
  const wCleared = await mkWall({
    c: [2000, 1520, 2200, 1520], move: CONST.WALL_MOVEMENT_TYPES.NORMAL, sight: CONST.WALL_SENSE_TYPES.NORMAL,
    flags: { [SCOPE]: { coverSp: 20, coverPool: 10, coverPoolMax: 60 } },
  });
  ok("cleared: it starts as a real cover row", !!rowFor(wCleared.uuid) && rowFor(wCleared.uuid)?.structured === true);
  await cov.chewCoverWall({ wallUuid: wCleared.uuid, damage: 10 });
  ok("cleared: and it breaches, so the clear has something to undo", !!wCleared.flags?.[SCOPE]?.coverBreach);
  const clearedMove = wCleared.flags?.[SCOPE]?.coverBreach?.move;
  await cov.repairCoverWall({ wallUuid: wCleared.uuid });
  await wCleared.update({
    [`flags.${SCOPE}.-=coverSp`]: null, [`flags.${SCOPE}.-=coverPool`]: null,
    [`flags.${SCOPE}.-=coverPoolMax`]: null, [`flags.${SCOPE}.-=coverBreach`]: null,
  });
  ok("cleared: clearing the values returns EXACTLY the naked state — no row, no chew, no breach",
    !rowFor(wCleared.uuid)
    && (await cov.chewCoverWall({ wallUuid: wCleared.uuid, damage: 50 })) === null
    && wCleared.move === clearedMove && !wCleared.flags?.[SCOPE]?.coverBreach,
    `move=${wCleared.move} (was ${clearedMove})`);
  ok("cleared: and it is spread-EXEMPT again, not a valued crossing",
    cov.valuedCoverAlong(scene, { x: 2000, y: 1400 }, { x: 2200, y: 1560 }).every(r => r.uuid !== wCleared.uuid));

  /* partial door debit does NOT open it (negative case) */
  const wDoor2 = await mkWall({ c: [2000, 1280, 2200, 1280], door: 1, ds: 0, flags: { [SCOPE]: { coverSp: 10, coverPoolMax: 30, coverMaterial: "__PWX__PartialDoor" } } });
  const d2 = await cov.chewCoverWall({ wallUuid: wDoor2.uuid, damage: 5 });
  ok("partial door debit: 30 -> 25, not destroyed", d2?.pool === 25 && d2?.destroyed === false, JSON.stringify(d2));
  ok("partial door stays closed", (wDoor2._source?.ds ?? wDoor2.ds) === 0, String(wDoor2._source?.ds ?? wDoor2.ds));

  /* h. dispatcher routes by resolved document type */
  const wDisp = await mkWall({ c: [2000, 1320, 2200, 1320], flags: { [SCOPE]: { coverSp: 10, coverPoolMax: 30, coverMaterial: "__PWX__DispatchWall" } } });
  const h1 = await cov.chewCover({ uuid: wDisp.uuid, damage: 5, weaponName: "__PWX__Source" });
  ok("dispatcher debits a wall uuid: 30 -> 25", h1?.pool === 25 && h1?.destroyed === false, JSON.stringify(h1));
  ok("dispatcher wall write persisted", wDisp.flags?.[SCOPE]?.coverPool === 25, String(wDisp.flags?.[SCOPE]?.coverPool));
  // ⭐ THE PLACER TAKES THE STRUCTURE IT IS GIVEN AND NO LONGER RE-SUPPLIES ONE (2026-08-26): the
  // dialog prefills 3xSP visibly, and a caller that wants the lifecycle states it.
  const dispZone = await cov.placeCoverZone({ scene, label: "__PWX__DispatchZone", sp: 5, poolMax: 15 });
  const dispBeh = dispZone.behaviors.find(b => b.type === `${SCOPE}.coverZone`);
  ok("dispatch zone seeded 15/15", dispBeh?.system?.pool === 15 && dispBeh?.system?.poolMax === 15, `${dispBeh?.system?.pool}/${dispBeh?.system?.poolMax}`);
  const h2 = await cov.chewCover({ behaviorUuid: dispBeh.uuid, damage: 5 });
  ok("dispatcher debits a behavior uuid: 15 -> 10", h2?.pool === 10 && h2?.destroyed === false, JSON.stringify(h2));
  ok("dispatcher zone write persisted", dispBeh.system.pool === 10, String(dispBeh.system.pool));
  const h3 = await cov.chewCover({ uuid: "" });
  ok("dispatcher rejects an empty uuid", h3 === null, String(h3));
  const h4 = await cov.chewCoverWall({ wallUuid: wPlain.uuid, damage: 5 });
  ok("debit on an unflagged wall returns null", h4 === null, String(h4));

  /* the wall used by the configuration-sheet phase stays flag-free until the sheet writes it */
  const wCfg = await mkWall({ c: [2000, 1360, 2200, 1360] });

  out.ids.wallIds = [wPlain, wDefault, wOptIn, wOptPool, wExplicit, wDoorLabel, wDoorCore, wNear, wChew,
    wDoor, wDoor2, wDisp, wBreach, wDoorBreach, wNaked, wCleared, wCfg].map(w => w.id);
  out.ids.cfgWallId = wCfg.id;
  out.ids.regionIds = [farZone.id, dispZone.id];
  out.ids.actorId = actor.id;
  out.ids.tokenId = tok.id;
  out.ids.msgIdsBefore = [...msgIds];
  return out;
}, SCOPE);

for (const c of res.checks) check(c.n, c.p, c.d);

/* ─────────────────── phase 2: the native wall configuration sheet (real DOM) ─────────────────── */
const appId = await page.evaluate(async ({ sceneId, cfgWallId }) => {
  const wall = game.scenes.get(sceneId).walls.get(cfgWallId);
  const app = wall.sheet;
  await app.render(true);
  await new Promise(r => setTimeout(r, 800));
  return app.element?.id ?? app.id ?? null;
}, res.ids);

let fieldsetSeen = true;
try {
  await page.waitForSelector(".cp-cover-wall-fields", { timeout: 10000 });
} catch { fieldsetSeen = false; }
check("wall configuration sheet carries the injected fieldset", fieldsetSeen, String(appId));

if (fieldsetSeen) {
  const dom = await page.evaluate((SCOPE) => {
    const fs = document.querySelector(".cp-cover-wall-fields");
    const names = [...fs.querySelectorAll("input")].map(i => i.getAttribute("name"));
    return { names, text: fs.textContent, inForm: !!fs.closest("form") };
  }, SCOPE);
  const want = ["coverSp", "coverPool", "coverPoolMax"].map(k => `flags.${SCOPE}.${k}`);
  check("the three structure inputs are present", want.every(n => dom.names.includes(n)), dom.names.join(","));
  check("the retired material/name input is gone", !dom.names.includes(`flags.${SCOPE}.coverMaterial`), dom.names.join(","));
  check("the fieldset carries exactly those three inputs", dom.names.length === 3, String(dom.names.length));
  check("fieldset sits inside the sheet's own form", dom.inForm === true);
  check("no raw key text leaks into the fieldset", !/CYBERPUNK\./.test(dom.text), dom.text.slice(0, 120));

  /* ── ③ DIEGETIC BOOK LABELS + REAL TOOLTIPS, asserted by CONTENT, not by presence ──────────── */
  const diegetic = await page.evaluate(() => {
    const fs = document.querySelector(".cp-cover-wall-fields");
    const rows = [...fs.querySelectorAll(".form-group")].map(g => ({
      label: g.querySelector("label")?.textContent?.trim() ?? "",
      labelTip: g.querySelector("label")?.getAttribute("data-tooltip") ?? "",
      inputTip: g.querySelector("input")?.getAttribute("data-tooltip") ?? "",
      inputName: g.querySelector("input")?.getAttribute("name") ?? "",
    })).filter(r => r.inputName);
    const btns = [...fs.querySelectorAll("button")].map(b => ({
      cls: b.className, text: b.textContent.trim(), tip: b.getAttribute("data-tooltip") ?? "",
    }));
    // ⭐ THE HINTS ARE READ AS A PAIR NOW (rework 2026-08-27): the SUMMARY that is on the face and the
    // FULL RULE that is on its `data-tooltip`. Reading only `textContent`, as this did before the
    // rework, would report the teaching as deleted when it has only moved onto hover.
    return {
      rows, btns,
      hints: [...fs.querySelectorAll("p.hint")].map(h => ({
        text: h.textContent.trim(), tip: h.getAttribute("data-tooltip") ?? "",
      })),
    };
  });
  check("every field carries a SHORT book-tagged label",
    diegetic.rows.length === 3
    && /Cover SP \(Core p\.103\)/.test(diegetic.rows[0].label)
    && /Maximum Metal p\.58/.test(diegetic.rows[1].label)
    && /Maximum Metal p\.58/.test(diegetic.rows[2].label),
    diegetic.rows.map(r => r.label).join(" | "));
  check("labels stay SHORT — the teaching is in the tooltip, not the label",
    diegetic.rows.every(r => r.label.length > 0 && r.label.length <= 44),
    diegetic.rows.map(r => `${r.label.length}`).join(","));
  check("every field AND its input carry a real tooltip",
    diegetic.rows.every(r => r.labelTip.length > 40 && r.inputTip === r.labelTip),
    diegetic.rows.map(r => r.labelTip.length).join(","));
  check("every tooltip names the BOOK and the PAGE",
    diegetic.rows.every(r => /p\.\d+/.test(r.labelTip)) && /Core/.test(diegetic.rows[0].labelTip)
    && diegetic.rows.slice(1).every(r => /Maximum Metal/.test(r.labelTip)),
    diegetic.rows.map(r => (r.labelTip.match(/p\.\d+/) ?? ["-"])[0]).join(","));
  check("every tooltip says what leaving the field BLANK means",
    diegetic.rows.every(r => /blank/i.test(r.labelTip)),
    diegetic.rows.map(r => /blank/i.test(r.labelTip)).join(","));
  check("no tooltip leaks a raw i18n key",
    diegetic.rows.every(r => !/CYBERPUNK\./.test(r.labelTip)) && diegetic.btns.every(b => !/CYBERPUNK\./.test(b.tip)));
  // ⭐ THE PROSE MOVED ONTO HOVER (user ruling 2026-08-27 — the block "eats half the screen"). Every
  // leg below reads the SAME facts it read before the rework; what changed is WHERE the fact has to be
  // found. The summaries are asserted short, the full rules are asserted intact on the tooltips, and
  // the book names are asserted still on the FACE — that half of the 2026-08-26 labelling ruling did
  // not move and a rework that quietly buried it would be a regression this leg has to catch.
  const summaries = diegetic.hints.filter(h => !/currently breached/i.test(h.text));
  check("the hint block is FOUR one-line summaries, not paragraphs",
    summaries.length === 4 && summaries.every(h => h.text.length > 0 && h.text.length <= 64),
    summaries.map(h => h.text.length).join(","));
  check("every summary carries the FULL rule on hover — nothing was deleted, it moved",
    summaries.every(h => h.tip.length > 120),
    summaries.map(h => h.tip.length).join(","));
  check("the mode line names BOTH books on the FACE, not only on hover",
    summaries.some(h => /Core p\.103/.test(h.text) && /Maximum Metal p\.58/.test(h.text)),
    summaries.map(h => h.text).join(" // ").slice(0, 240));
  check("the hint tooltips explain BOTH models and name both books",
    summaries.some(h => /Core p\.103/.test(h.tip) && /Maximum Metal p\.58/.test(h.tip)),
    summaries.map(h => h.tip).join(" // ").slice(0, 200));
  /* ── ④ the hint block covers zero structure (breach + repair) and blesses low cover ────────── */
  check("the hints explain what zero structure does — breach AND repair",
    summaries.some(h => /breach/i.test(h.text)) && summaries.some(h => /[Rr]epair/.test(h.text))
    && summaries.some(h => /breach/i.test(h.tip) && /[Rr]epair/.test(h.tip)),
    summaries.filter(h => /breach/i.test(h.tip)).map(h => h.tip).join(" // ").slice(0, 200));
  check("the hints BLESS the low-cover idiom (a movement- or sight-open valued wall)",
    summaries.some(h => /chest-high|armoured window|armored window/i.test(h.tip)
      && /movement/i.test(h.tip) && /sight/i.test(h.tip)),
    summaries.filter(h => /chest-high/i.test(h.tip)).map(h => h.tip).join("").slice(0, 200));
  check("no hint tooltip leaks a raw i18n key", summaries.every(h => !/CYBERPUNK\./.test(h.tip)),
    summaries.map(h => h.tip.slice(0, 30)).join(" | "));
  /* ── ④b THE REWORK'S OWN CLAIM, MEASURED. "It eats half the screen" is a geometry complaint, so the
   *      answer is a geometry assertion: the strip's rendered height on the real 480px Wall sheet, and
   *      the share of the fieldset it takes. A summary that wrapped to two lines would show up here as
   *      a height the bound refuses, which is the failure mode a character-count leg cannot see. */
  const strip = await page.evaluate(() => {
    const fs = document.querySelector(".cp-cover-wall-fields");
    const hints = fs?.querySelector(".cp-cover-wall-hints");
    if (!fs || !hints) return null;
    const lines = [...hints.querySelectorAll(".cp-cover-hint")].map(p => Math.round(p.getBoundingClientRect().height));
    return {
      stripH: Math.round(hints.getBoundingClientRect().height),
      fieldsetH: Math.round(fs.getBoundingClientRect().height),
      lines, sheetW: Math.round(fs.closest(".application, .app")?.getBoundingClientRect().width ?? 0),
    };
  });
  check("the hint strip renders as four SINGLE lines (no summary wraps at the sheet's own width)",
    !!strip && strip.lines.length === 4 && strip.lines.every(h => h <= 26),
    JSON.stringify(strip));
  check("the hint strip is a minority of the fieldset — the fields are reachable without scrolling past prose",
    !!strip && strip.stripH < strip.fieldsetH * 0.45,
    strip ? `strip ${strip.stripH}px of fieldset ${strip.fieldsetH}px (sheet ${strip.sheetW}px)` : "no strip");
  /* ── ④c OUTCOME, NOT PRESENCE: a real hover must actually PUT THE PROSE ON SCREEN. A `data-tooltip`
   *      attribute that core never shows is exactly the shape of the dead-control class (coverage
   *      rule #1), and it is the whole of this rework's promise. */
  const hovered = await page.evaluate(async () => {
    const line = document.querySelector(".cp-cover-wall-hints .cp-cover-hint");
    if (!line) return { shown: "" };
    line.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
    await new Promise(r => setTimeout(r, 900));
    const tip = document.getElementById("tooltip");
    return { shown: (tip?.textContent ?? "").trim(), visible: !!tip && tip.classList.contains("active") };
  });
  check("hovering a summary shows its FULL rule in core's own tooltip",
    hovered.shown.length > 120 && summaries.some(h => h.tip === hovered.shown),
    `${hovered.shown.length} chars, active=${hovered.visible} — ${hovered.shown.slice(0, 80)}`);
  check("the Clear Cover button is present, book-tagged and tooltipped",
    diegetic.btns.some(b => /cp-cover-wall-clear/.test(b.cls) && b.text.length > 0 && b.tip.length > 40),
    JSON.stringify(diegetic.btns));

  // SP -> structure pre-fill fires on a REAL change event
  await page.evaluate((SCOPE) => {
    const sp = document.querySelector(`.cp-cover-wall-fields input[name="flags.${SCOPE}.coverSp"]`);
    sp.value = "20";
    sp.dispatchEvent(new Event("change", { bubbles: true }));
  }, SCOPE);
  await page.waitForTimeout(300);
  const filled = await page.evaluate((SCOPE) => {
    const q = k => document.querySelector(`.cp-cover-wall-fields input[name="flags.${SCOPE}.${k}"]`)?.value;
    return { pool: q("coverPool"), poolMax: q("coverPoolMax") };
  }, SCOPE);
  // ⭐ THE PREFILL IS THE OPT-IN, AND IT IS VISIBLE — the whole difference from the retired silent
  // default. The figure lands IN THE INPUT where the GM can read it and blank it.
  check("SP edit pre-fills empty structure fields with 3xSP, visibly in the form", filled.pool === "60" && filled.poolMax === "60", JSON.stringify(filled));

  /* ── ④ CLEAR COVER: drive the REAL click and assert the DOCUMENT outcome ───────────────────── */
  {
    // Seed the wall with values AND a breach, so the clear has both halves to undo.
    await page.evaluate(async ({ sceneId, cfgWallId }) => {
      const scope = "cp2020-augmented";
      const w = game.scenes.get(sceneId).walls.get(cfgWallId);
      await w.update({
        move: CONST.WALL_MOVEMENT_TYPES.NORMAL, sight: CONST.WALL_SENSE_TYPES.NORMAL,
        [`flags.${scope}.coverSp`]: 20, [`flags.${scope}.coverPool`]: 60, [`flags.${scope}.coverPoolMax`]: 60,
      });
      const cov = await import(`/modules/${scope}/module/combat/cover.js`);
      await cov.chewCoverWall({ wallUuid: w.uuid, damage: 60 });
      await w.sheet.render(true);
      await new Promise(r => setTimeout(r, 800));
    }, res.ids);
    const before = await page.evaluate(({ sceneId, cfgWallId }) => {
      const w = game.scenes.get(sceneId).walls.get(cfgWallId);
      return { move: w.move, sight: w.sight, breached: !!w.flags?.["cp2020-augmented"]?.coverBreach,
               sp: w.flags?.["cp2020-augmented"]?.coverSp };
    }, res.ids);
    check("clear: the wall is breached and valued before the press",
      before.breached === true && before.sp === 20 && before.move === 0, JSON.stringify(before));
    // WIRING: the handler's selector matches the rendered node, and the node is real.
    const wired = await page.evaluate(() => {
      const b = document.querySelector(".cp-cover-wall-fields .cp-cover-wall-clear");
      return { found: !!b, tag: b?.tagName, type: b?.getAttribute("type") };
    });
    check("clear: the rendered control matches the handler's own selector",
      wired.found === true && wired.tag === "BUTTON" && wired.type === "button", JSON.stringify(wired));
    // ⚠ SCOPED TO THE PRESS. The collector runs for the whole page lifetime and the module raises one
    // deprecation of its own at INIT (the seam shim deliberately reads and wraps the global
    // `renderTemplate`, which is a deprecation accessor — see module/seam-shim.js). A cumulative count
    // would charge that to this button. The reading is the DELTA across the gesture.
    const warnBeforeClear = compatWarnings.length;
    await page.click(".cp-cover-wall-fields .cp-cover-wall-clear");
    await page.waitForTimeout(900);
    const after = await page.evaluate(({ sceneId, cfgWallId }) => {
      const scope = "cp2020-augmented";
      const w = game.scenes.get(sceneId).walls.get(cfgWallId);
      const f = w.flags?.[scope] ?? {};
      const q = k => document.querySelector(`.cp-cover-wall-fields input[name="flags.${scope}.${k}"]`)?.value;
      return { sp: f.coverSp, pool: f.coverPool, poolMax: f.coverPoolMax, breach: f.coverBreach,
               move: w.move, sight: w.sight,
               inputs: { sp: q("coverSp"), pool: q("coverPool"), poolMax: q("coverPoolMax") } };
    }, res.ids);
    check("clear: ALL cover values are gone from the document, not merely blanked in the form",
      after.sp === undefined && after.pool === undefined && after.poolMax === undefined, JSON.stringify(after));
    check("clear: the breach is repaired first — the wall restricts again and keeps no snapshot",
      after.breach === undefined && after.move !== 0 && after.sight !== 0,
      `move=${after.move} sight=${after.sight} breach=${after.breach}`);
    check("clear: the form's own inputs are emptied so a pending submit cannot rewrite them",
      after.inputs.sp === "" && after.inputs.pool === "" && after.inputs.poolMax === "",
      JSON.stringify(after.inputs));
    const rowAfter = await page.evaluate(({ sceneId, cfgWallId }) => import("/modules/cp2020-augmented/module/combat/cover.js").then(cov => {
      const scene = game.scenes.get(sceneId);
      const w = scene.walls.get(cfgWallId);
      return cov.coverWallsOn(scene).some(r => r.uuid === w.uuid);
    }), res.ids);
    check("clear: ⑤ the wall is plain-indestructible again — no cover row at all", rowAfter === false, String(rowAfter));
    // ⭐ AND NO CORE COMPATIBILITY WARNING CAME OUT OF IT (2026-08-27). Clear unsets four flags at once,
    // and it used to spell the deletion key by hand (`flags.<scope>.-=coverSp`), which v14 answers with a
    // deprecation warning — a working button that shouts in the console every time a GM presses it. The
    // writes go through `utils.deleteFieldUpdate` now, which asks the RUNNING core which spelling it
    // speaks. Asserted on the whole press, from the dedicated collector at the top of this file.
    check("clear: the press raises no core compatibility warning",
      compatWarnings.length === warnBeforeClear,
      compatWarnings.slice(warnBeforeClear, warnBeforeClear + 3).join(" | ") || "none");

    /* ── ④b REPAIR: the other half of the same pair, driven the same way ───────────────────────── */
    const warnAtRepair = compatWarnings.length;
    await page.evaluate(async ({ sceneId, cfgWallId }) => {
      const scope = "cp2020-augmented";
      const w = game.scenes.get(sceneId).walls.get(cfgWallId);
      await w.update({
        move: CONST.WALL_MOVEMENT_TYPES.NORMAL, sight: CONST.WALL_SENSE_TYPES.NORMAL,
        [`flags.${scope}.coverSp`]: 20, [`flags.${scope}.coverPool`]: 60, [`flags.${scope}.coverPoolMax`]: 60,
      });
      const cov = await import(`/modules/${scope}/module/combat/cover.js`);
      await cov.chewCoverWall({ wallUuid: w.uuid, damage: 60 });   // breach it again
      // ⚠ CLOSED AND REOPENED, not re-rendered (2026-08-27). The fieldset is INJECTED into an already
      // rendered sheet and the injector returns early when one is already present, so a sheet that was
      // open BEFORE the breach keeps its pre-breach fieldset — no Repair control — until it is reopened.
      // That is a real staleness edge (recorded in the lane report); what this block is about is the
      // Repair gesture itself, so it opens the sheet the way a GM meets a wall that is already breached.
      await w.sheet.close().catch(() => {});
      await new Promise(r => setTimeout(r, 400));
      await w.sheet.render(true);
      await new Promise(r => setTimeout(r, 1100));
    }, res.ids);
    const repairWired = await page.evaluate(({ sceneId, cfgWallId }) => {
      const scope = "cp2020-augmented";
      const w = game.scenes.get(sceneId).walls.get(cfgWallId);
      const b = document.querySelector(".cp-cover-wall-fields .cp-cover-wall-repair");
      return {
        found: !!b, tag: b?.tagName,
        // The PRECONDITION, read beside the control: "no button" and "no breach" are different
        // diagnoses and a leg that cannot tell them apart sends the next reader to the wrong file.
        breached: !!w.flags?.[scope]?.coverBreach,
        pool: w.flags?.[scope]?.coverPool, poolMax: w.flags?.[scope]?.coverPoolMax,
        fieldsetOnScreen: !!document.querySelector(".cp-cover-wall-fields"),
      };
    }, res.ids);
    check("repair: the wall really is breached before the control is looked for (precondition)",
      repairWired.breached === true && repairWired.fieldsetOnScreen === true, JSON.stringify(repairWired));
    check("repair: a breached wall offers the control, and it matches the handler's selector",
      repairWired.found === true && repairWired.tag === "BUTTON", JSON.stringify(repairWired));
    if (repairWired.found) {
      await page.click(".cp-cover-wall-fields .cp-cover-wall-repair");
      await page.waitForTimeout(1200);
      const repaired = await page.evaluate(({ sceneId, cfgWallId }) => {
        const scope = "cp2020-augmented";
        const w = game.scenes.get(sceneId).walls.get(cfgWallId);
        const f = w.flags?.[scope] ?? {};
        return { breach: f.coverBreach, move: w.move, sight: w.sight, pool: f.coverPool, poolMax: f.coverPoolMax };
      }, res.ids);
      check("repair: the breach is closed and the structure refilled, by value",
        repaired.breach === undefined && repaired.move !== 0 && repaired.sight !== 0
        && repaired.pool === repaired.poolMax && repaired.pool === 60, JSON.stringify(repaired));
      check("repair: the press raises no core compatibility warning either",
        compatWarnings.length === warnAtRepair,
        compatWarnings.slice(warnAtRepair, warnAtRepair + 3).join(" | ") || "none");
    }
    // Clear it back down so the re-seed below starts from the state the later legs expect.
    await page.click(".cp-cover-wall-fields .cp-cover-wall-clear").catch(() => {});
    await page.waitForTimeout(900);
    // Re-seed for the submit-persistence legs below, which expect an SP of 20 typed into the sheet.
    await page.evaluate((SCOPE) => {
      const sp = document.querySelector(`.cp-cover-wall-fields input[name="flags.${SCOPE}.coverSp"]`);
      sp.value = "20";
      sp.dispatchEvent(new Event("change", { bubbles: true }));
    }, SCOPE);
    await page.waitForTimeout(300);
  }

  // the sheet's OWN submit persists the flags
  let submitted = false;
  try {
    const btn = page.locator(`#${appId} button[type="submit"]`).first();
    await btn.click({ timeout: 5000 });
    submitted = true;
  } catch { submitted = false; }

  const persisted = await page.evaluate(async ({ sceneId, cfgWallId }) => {
    const scope = "cp2020-augmented";
    for (let i = 0; i < 30; i++) {
      const f = game.scenes.get(sceneId).walls.get(cfgWallId)?.flags?.[scope] ?? {};
      if (f.coverSp === 20) return { sp: f.coverSp, pool: f.coverPool, poolMax: f.coverPoolMax, material: f.coverMaterial };
      await new Promise(r => setTimeout(r, 200));
    }
    const f = game.scenes.get(sceneId).walls.get(cfgWallId)?.flags?.[scope] ?? {};
    return { timeout: true, sp: f.coverSp, pool: f.coverPool, poolMax: f.coverPoolMax, material: f.coverMaterial };
  }, res.ids);

  if (!submitted || persisted.timeout) {
    check("sheet submit persists the cover flags [PARKED — submit path did not land headless]", false, `submitted=${submitted} ${JSON.stringify(persisted)}`);
  } else {
    check("sheet submit persists the cover flags", persisted.sp === 20 && persisted.pool === 60 && persisted.poolMax === 60, JSON.stringify(persisted));
    check("no material flag is written any more", persisted.material === undefined, String(persisted.material));
    const row = await page.evaluate(({ sceneId, cfgWallId }) => import("/modules/cp2020-augmented/module/combat/cover.js").then(cov => {
      const scene = game.scenes.get(sceneId);
      const w = scene.walls.get(cfgWallId);
      const r = cov.coverWallsOn(scene).find(x => x.uuid === w.uuid);
      return r ? { label: r.label, sp: r.sp, pool: r.pool, poolMax: r.poolMax, destroyed: r.destroyed } : null;
    }), res.ids);
    // With nothing to name it, the row falls back to the localized generic wall label — a wall
    // document has no name of its own, so this is the honest floor.
    check("sheet-authored wall becomes a cover row", row?.sp === 20 && row?.pool === 60 && row?.poolMax === 60 && row?.destroyed === false, JSON.stringify(row));
    check("an unnamed wall falls back to the generic label", row?.label === "Wall", String(row?.label));
  }
}

/* ───────────────────────────────────── cleanup ───────────────────────────────────── */
await page.evaluate(async ({ sceneId, wallIds, regionIds, actorId, tokenId, msgIdsBefore }) => {
  const scene = game.scenes.get(sceneId);
  for (const app of [...foundry.applications.instances.values()]) {
    if (app.constructor?.name === "WallConfig") await app.close().catch(() => {});
  }
  if (scene.tokens.get(tokenId)) await scene.deleteEmbeddedDocuments("Token", [tokenId]).catch(() => {});
  await game.actors.get(actorId)?.delete().catch(() => {});
  const live = wallIds.filter(id => scene.walls.get(id));
  if (live.length) await scene.deleteEmbeddedDocuments("Wall", live).catch(() => {});
  const leftover = [...scene.walls].filter(w => w.flags?.["cp2020-augmented"]?.__pwk === true).map(w => w.id);
  if (leftover.length) await scene.deleteEmbeddedDocuments("Wall", leftover).catch(() => {});
  for (const id of regionIds) await scene.regions.get(id)?.delete().catch(() => {});
  const before = new Set(msgIdsBefore);
  for (const m of game.messages.filter(x => !before.has(x.id) && (x.content.includes("cp-cover-chew") || x.content.includes("__PWX__")))) {
    await m.delete().catch(() => {});
  }
}, res.ids).catch(e => console.log(`  (cleanup warning: ${e.message})`));

check("0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
