/**
 * KEEPER: cover zones Unit 1 (behavior + presets + placement + chew lifecycle).
 *  - behavior type registered (two-part manifest registration) + TYPES label resolves
 *  - COVER_PRESETS match the Core "Common Cover SPs" table (text-layer values)
 *  - placeCoverZone creates a region: behavior takes the structure it is GIVEN (2026-08-26: it no
 *    longer re-supplies 3xSP), ALWAYS visible, amber; structure 0 = permanent Core p.103 cover
 *  - chewCoverZone: exact pool debit, band recolor (amber->orange->gray), destroyed flip at 0,
 *    chat card per chew, destroyed card, idempotent on already-destroyed (no extra card)
 *  - coverChoicesFor sorts by distance to the target token
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

  if (!game.scenes.active) await (game.scenes.getName("Foundry Virtual Tabletop") ?? game.scenes.contents[0])?.activate();
  const scene = game.scenes.active;

  // stale cleanup
  for (const r of [...(scene?.regions ?? [])]) if (r.name?.startsWith("__PWK__")) await r.delete();

  const cov = await import(`/modules/${SCOPE}/module/combat/cover.js`);
  const beh = await import(`/modules/${SCOPE}/module/combat/cover-zone-behavior.js`);

  // 1. registration (manifest + CONFIG)
  ok("behavior type in CONFIG.dataModels", !!CONFIG.RegionBehavior.dataModels[beh.COVER_ZONE_BEHAVIOR]);
  ok("TYPES label resolves", game.i18n.localize(`TYPES.RegionBehavior.${beh.COVER_ZONE_BEHAVIOR}`) === "Cover");

  // 2. presets vs the book table (spot-check every band)
  const P = Object.fromEntries(cov.COVER_PRESETS.map(p => [p.label, p.sp]));
  ok("preset count 17", cov.COVER_PRESETS.length === 17, cov.COVER_PRESETS.length);
  ok("Sheetrock Wall 5", P["Sheetrock Wall"] === 5);
  ok("Concrete Block Wall 10", P["Concrete Block Wall"] === 10);
  ok("Heavy Wood Door 15", P["Heavy Wood Door"] === 15);
  ok("Steel Door 20", P["Steel Door"] === 20);
  ok("Brick Wall 25 / Curb 25", P["Brick Wall"] === 25 && P["Curb"] === 25);
  ok("Stone Wall 30 / Tree 30", P["Stone Wall"] === 30 && P["Tree, Phone Pole"] === 30);
  ok("Concrete Utility Pole 35 / Hydrant 35", P["Concrete Utility Pole"] === 35 && P["Hydrant"] === 35);
  ok("Armored Car Body 40 / AV-4 Body 40", P["Armored Car Body"] === 40 && P["AV-4 Body"] === 40);

  // 3. placement
  // ⭐ THE PLACER NO LONGER RE-SUPPLIES 3xSP (ruled 2026-08-26): the dialog prefills it VISIBLY and a
  // caller that wants the Maximum Metal lifecycle states it. See the core-mode legs at the end.
  const region = await cov.placeCoverZone({ scene, label: "__PWK__Brick", sp: 25, poolMax: 75 });
  ok("placement creates region", !!region, region?.name);
  const b = region?.behaviors?.find(x => x.type === beh.COVER_ZONE_BEHAVIOR);
  ok("behavior prefilled sp 25", b?.system?.sp === 25);
  ok("pool seeds the stated structure = 75", b?.system?.pool === 75 && b?.system?.poolMax === 75, `${b?.system?.pool}/${b?.system?.poolMax}`);
  ok("visibility ALWAYS", region?.visibility === (CONST?.REGION_VISIBILITY?.ALWAYS ?? 2), String(region?.visibility));
  ok("intact color amber", region?.color?.css?.toLowerCase?.() === "#d1a054" || String(region?.color).toLowerCase() === "#d1a054", String(region?.color?.css ?? region?.color));

  // 4. chew lifecycle — exact values
  const msgIds = new Set(game.messages.map(m => m.id));
  const newCards = () => game.messages.filter(m => !msgIds.has(m.id) && (m.content.includes("cp-cover-chew")));

  let r1 = await cov.chewCoverZone({ behaviorUuid: b.uuid, damage: 20, weaponName: "Keeper Gun" });
  ok("chew 20: pool 55", r1?.pool === 55 && r1?.destroyed === false, JSON.stringify(r1));
  ok("still amber above 2/3", String(region.color?.css ?? region.color).toLowerCase() === "#d1a054");
  let r2 = await cov.chewCoverZone({ behaviorUuid: b.uuid, damage: 20 });
  ok("chew 20: pool 35 + orange band", r2?.pool === 35 && String(region.color?.css ?? region.color).toLowerCase() === "#cc5500", `${r2?.pool} ${region.color?.css ?? region.color}`);
  let r3 = await cov.chewCoverZone({ behaviorUuid: b.uuid, damage: 50 });
  ok("chew 50: destroyed at 0", r3?.pool === 0 && r3?.destroyed === true, JSON.stringify(r3));
  ok("destroyed color gray", String(region.color?.css ?? region.color).toLowerCase() === "#555555");
  ok("behavior flags destroyed", b.system.destroyed === true && b.system.pool === 0);
  ok("sp unchanged through chew (book rule)", b.system.sp === 25);
  await new Promise(r => setTimeout(r, 400));
  const cards = newCards();
  ok("three chew cards posted", cards.length === 3, String(cards.length));
  ok("last card is the destroyed card", /destroyed/i.test(cards.at(-1)?.content ?? ""));
  const r4 = await cov.chewCoverZone({ behaviorUuid: b.uuid, damage: 10 });
  ok("already-destroyed chew is a no-op", r4?.already === true && newCards().length === 3);

  // 5. choices sorting by distance
  const far = await cov.placeCoverZone({ scene, label: "__PWK__Far", sp: 5, poolMax: 15 });
  await far.update({ shapes: [{ type: "rectangle", x: 100, y: 100, width: 100, height: 100, rotation: 0 }] });
  const near = await cov.placeCoverZone({ scene, label: "__PWK__Near", sp: 10, poolMax: 30 });
  await near.update({ shapes: [{ type: "rectangle", x: 2000, y: 1000, width: 100, height: 100, rotation: 0 }] });
  const actor = await Actor.create({ name: "__PWK__Target", type: "character" });
  const [tok] = await scene.createEmbeddedDocuments("Token", [{ name: actor.name, actorId: actor.id, x: 2100, y: 1100, width: 1, height: 1 }]);
  const choices = cov.coverChoicesFor(tok).filter(c => c.label.startsWith("__PWK__"));
  ok("choices sorted nearest-first", choices[0]?.label === "__PWK__Near", choices.map(c => c.label).join(","));

  /* 6. PER-ROUND structure debit inside the resolver — a burst wears the object down round by
        round, and the round that empties the pool is the last one the object stands for.
        Fixture: an unarmoured target, cover SP 20 over structure 60, six rounds of 25.
          r1 25 -> pool 35 | r2 25 -> pool 10 | r3 absorbs the remaining 10 -> pool 0, DESTROYED
          r4-r6 face SP 0 and land their full 25 each. */
  const DA = await import(`/modules/${SCOPE}/module/combat/DamageApplicator.js`);
  const bare = await Actor.create({ name: "__PWK__Bare", type: "npc" });
  /* ── ② THE ZONE'S OWN CORE/MM SPLIT (ruled 2026-08-26) ─────────────────────────────────────
     A zone with an SP and a TOTAL STRUCTURE OF ZERO is Core p.103 cover: it soaks and it is
     permanent. Zero is the "blank" here because the behavior's NumberField is `required` and cannot
     hold one — a wall stores its structure as a flag and CAN be genuinely empty, and the two entry
     surfaces are deliberately made to say the same thing in the only way each of them can. */
  const coreZone = await cov.placeCoverZone({ scene, label: "__PWK__CoreOnly", sp: 15, poolMax: 0 });
  const coreBeh = coreZone.behaviors.find(x => x.type === beh.COVER_ZONE_BEHAVIOR);
  const coreRow = cov.coverZonesOn(scene).find(x => x.uuid === coreBeh.uuid);
  ok("core zone: SP kept, no structure, and 0 is NOT destruction",
    coreRow?.sp === 15 && coreRow?.structured === false && coreRow?.poolMax === 0 && coreRow?.destroyed === false,
    JSON.stringify({ sp: coreRow?.sp, structured: coreRow?.structured, pool: coreRow?.pool, destroyed: coreRow?.destroyed }));
  ok("core zone: the mode predicates agree", cov.coverModeOf(coreRow) === "core" && cov.coverChews(coreRow) === false);
  ok("core zone: it is placed INTACT, not drawn as rubble",
    String(coreZone.color?.css ?? coreZone.color).toLowerCase() !== "#555555",
    String(coreZone.color?.css ?? coreZone.color));
  const coreMsgs = new Set(game.messages.map(m => m.id));
  const coreChew = await cov.chewCoverZone({ behaviorUuid: coreBeh.uuid, damage: 999 });
  await new Promise(r => setTimeout(r, 400));
  ok("core zone: a chew is refused with the core marker and writes nothing",
    coreChew?.skipped === "core" && coreBeh.system.destroyed === false, JSON.stringify(coreChew));
  ok("core zone: ⛔ NO structure card is posted for it",
    game.messages.filter(m => !coreMsgs.has(m.id) && m.content.includes("cp-cover-chew")).length === 0,
    String(game.messages.filter(m => !coreMsgs.has(m.id) && m.content.includes("cp-cover-chew")).length));
  ok("core zone: it still SOAKS — the ledger hands its SP out every round and books nothing",
    (() => { const l = cov.makeCoverLedger({ coverSP: coreRow.sp, cover: coreRow }); return l.spForRound() === 15 && l.absorb(999) === null && l.spForRound() === 15; })());
  ok("core zone: it is still a real crossing an area can soak against",
    cov.coverZonesOn(scene).some(x => x.uuid === coreBeh.uuid && x.sp === 15));
  await coreZone.delete().catch(() => {});

  const coverRow = { uuid: "__PWK__uuid", label: "__PWK__Door", sp: 20, pool: 60, poolMax: 60, destroyed: false };
  const burst = { Torso: Array.from({ length: 6 }, () => ({ damage: 25 })) };
  const rows = DA.resolveAreaDamagesSync({
    target: bare, areaDamages: burst, ap: false, armorMode: "full", ablate: false,
    coverSP: 20, cover: coverRow,
  });
  ok("resolver returns one row per round", rows.length === 6, String(rows.length));
  ok("rounds 1-3 face the object's SP 20", rows.slice(0, 3).every(r => r.coverSP === 20), rows.map(r => r.coverSP).join(","));
  ok("rounds 1-2 debit the full round (35, then 10 left)",
    rows[0]?.coverChew?.absorbed === 25 && rows[0]?.coverChew?.poolAfter === 35
    && rows[1]?.coverChew?.absorbed === 25 && rows[1]?.coverChew?.poolAfter === 10,
    JSON.stringify([rows[0]?.coverChew, rows[1]?.coverChew]));
  ok("round 3 debits only what is left (10) and empties the pool",
    rows[2]?.coverChew?.absorbed === 10 && rows[2]?.coverChew?.poolAfter === 0 && rows[2]?.coverChew?.destroyed === true,
    JSON.stringify(rows[2]?.coverChew));
  ok("round 3 still resolved through the object (after-SP 5)", rows[2]?.damageAfterSP === 5 && rows[2]?.penetrates === true, JSON.stringify({ a: rows[2]?.damageAfterSP, p: rows[2]?.penetrates }));
  ok("rounds 4-6 face SP 0", rows.slice(3).every(r => r.coverSP === 0), rows.map(r => r.coverSP).join(","));
  ok("rounds 4-6 land their full 25", rows.slice(3).every(r => r.damageAfterSP === 25), rows.map(r => r.damageAfterSP).join(","));
  ok("rounds 4-6 debit nothing (the object is gone)", rows.slice(3).every(r => !r.coverChew), JSON.stringify(rows.slice(3).map(r => r.coverChew)));

  const summary = cov.coverChewSummary(rows);
  ok("burst summary totals the rounds (60 = the whole structure)", summary?.absorbed === 60, JSON.stringify(summary));
  ok("burst summary names the object and reports it gone", summary?.label === "__PWK__Door" && summary?.pool === 0 && summary?.destroyed === true, JSON.stringify(summary));
  ok("burst summary records the round it broke on", summary?.destroyedAtRound === 3, String(summary?.destroyedAtRound));
  ok("burst summary carries one receipt per debiting round", summary?.rounds?.length === 3, String(summary?.rounds?.length));

  // negative case: a typed SP with no object folds into the math but has nothing to debit
  const typedOnly = DA.resolveAreaDamagesSync({
    target: bare, areaDamages: { Torso: [{ damage: 25 }] }, ap: false, armorMode: "full",
    ablate: false, coverSP: 20, cover: null,
  });
  ok("a typed Cover SP with no object still folds (after-SP 5)", typedOnly[0]?.damageAfterSP === 5, String(typedOnly[0]?.damageAfterSP));
  ok("a typed Cover SP with no object debits nothing", !typedOnly[0]?.coverChew && cov.coverChewSummary(typedOnly) === null);
  await bare.delete();

  /* ══════════════════ §7 the PLACEMENT GESTURE — where the button lives, and what it arms ══════════
   * MECHANISM (2026-08-28, user order): the control drops REGIONS, so it belongs in the Regions control
   * group; and confirming the preset no longer drops a fixed rectangle at the view centre — it ARMS the
   * next region THIS user draws on THIS scene, and the module then writes only its own half onto that
   * document. The shape is the referee's, start to finish.
   *
   * Every leg here is an OUTCOME: the group a real hook fire lands the tool in, the document a real
   * draw produces, the shape that document kept, and what a second draw does NOT gain. */
  {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const drawn = [];
    // A region the way the platform makes one: a shape the referee drew, no name of ours, no behavior.
    const PTS = [1200, 1200, 1500, 1200, 1500, 1450, 1350, 1600, 1200, 1450];
    const drawRegion = async (name = "Region") => {
      const [r] = await scene.createEmbeddedDocuments("Region", [{
        name, shapes: [{ type: "polygon", points: [...PTS] }],
      }]);
      drawn.push(r);
      await sleep(500);
      return r;
    };
    const behOf = (r) => r?.behaviors?.find(x => x.type === beh.COVER_ZONE_BEHAVIOR) ?? null;
    const shapeIntact = (r) => {
      const s = r?.shapes?.[0];
      const pts = Array.from(s?.points ?? []);
      return s?.type === "polygon" && pts.length === PTS.length && pts.every((v, i) => Number(v) === PTS[i]);
    };

    try {
      /* ── (a) THE BUTTON'S HOME: the REGIONS group, by value, through the REAL hook ─────────────── */
      const shape = () => ({
        tokens: { name: "tokens", tools: { select: { name: "select", order: 0 } } },
        regions: { name: "regions", tools: { select: { name: "select", order: 0 } } },
      });
      const full = shape();
      Hooks.callAll("getSceneControlButtons", full);
      ok("§7 the real control hook lands the cover tool in the REGIONS group",
        !!full.regions.tools["cp-cover-place"],
        `regions holds: ${Object.keys(full.regions.tools).join(", ")}`);
      ok("§7 ⭐ and NOT in the token group any more",
        !full.tokens.tools["cp-cover-place"],
        `tokens holds: ${Object.keys(full.tokens.tools).join(", ")}`);
      const landed = full.regions.tools["cp-cover-place"];
      ok("§7 the landed tool is a momentary button with a localized title and an action of its own",
        landed?.button === true && typeof landed?.title === "string" && !String(landed?.title).includes("CYBERPUNK.")
        && typeof landed?.onChange === "function",
        `button=${landed?.button} title="${landed?.title}" action=${typeof landed?.onChange}`);
      ok("§7 the group's existing entries are left alone", !!full.regions.tools.select);
      ok("§7 the placer names the group it chose, by value", cov.addCoverTool(shape()) === "regions");

      // FALLBACK: a control collection with no regions group (older core / no REGION_CREATE) keeps the
      // button rather than losing it.
      const legacyControls = { tokens: { name: "tokens", tools: { select: { name: "select", order: 0 } } } };
      ok("§7 FALLBACK — with no regions group the button keeps its old home",
        cov.addCoverTool(legacyControls) === "tokens" && !!legacyControls.tokens.tools["cp-cover-place"]);

      // NEGATIVE: not a referee, not a button.
      const realIsGM = Object.getOwnPropertyDescriptor(game.user, "isGM");
      Object.defineProperty(game.user, "isGM", { value: false, configurable: true });
      const asPlayer = shape();
      try { Hooks.callAll("getSceneControlButtons", asPlayer); }
      finally {
        if (realIsGM) Object.defineProperty(game.user, "isGM", realIsGM);
        else Object.defineProperty(game.user, "isGM", { value: true, configurable: true });
      }
      ok("§7 NEGATIVE — firing the same real hook without the referee flag lands nothing",
        !asPlayer.regions.tools["cp-cover-place"] && !asPlayer.tokens.tools["cp-cover-place"],
        `regions: ${Object.keys(asPlayer.regions.tools).join(",")} tokens: ${Object.keys(asPlayer.tokens.tools).join(",")}`);
      ok("§7 the referee flag was handed back", game.user.isGM === true);
      ok("§7 the LIVE toolbar carries it under regions",
        Object.keys(ui.controls?.controls?.regions?.tools ?? {}).includes("cp-cover-place"),
        `live regions tools: ${Object.keys(ui.controls?.controls?.regions?.tools ?? {}).join(", ")}`);

      /* ── (b) THE REAL GESTURE: the dialog's own confirm click arms the draw ────────────────────── */
      const pending = cov.openCoverPlacementDialog();
      let dlg = null;
      for (let i = 0; i < 40 && !dlg; i++) { await sleep(150); dlg = document.querySelector(".application.cp-cover-place"); }
      ok("§7 the placement dialog renders", !!dlg);
      if (dlg) {
        dlg.querySelector('input[name="cp-cover-label"]').value = "__PWK__Drawn Barrier";
        dlg.querySelector('input[name="cp-cover-sp"]').value = "20";
        dlg.querySelector('input[name="cp-cover-pool"]').value = "60";
        ok("§7 the dialog states the draw step before the confirm, not after it",
          /draw/i.test(dlg.querySelector(".cp-cover-place-body")?.textContent ?? ""),
          (dlg.querySelector(".cp-cover-place-hint")?.textContent ?? "").slice(0, 60));
        // GEOMETRY — the extra hint line grew the content; the window must still show all of it and
        // still put its confirm within reach (a dialog that clips its own button is a dead control).
        const confirmBtn = dlg.querySelector('button[data-action="place"]');
        const cr = confirmBtn.getBoundingClientRect();
        ok("§7 the confirm button is on screen and has real hit area",
          cr.height > 0 && cr.width > 0 && cr.bottom <= window.innerHeight,
          `h=${Math.round(cr.height)} w=${Math.round(cr.width)} bottom=${Math.round(cr.bottom)} vh=${window.innerHeight}`);
        const clipped = [...dlg.querySelectorAll(".cp-cover-place-hint")]
          .filter(p => p.scrollHeight > p.clientHeight + 1).length;
        ok("§7 no hint line is clipped by the window it grew", clipped === 0, `clipped=${clipped}`);
        // THE REAL DOM EVENT — the referee's own click on the confirm button.
        dlg.querySelector('button[data-action="place"]').click();
      }
      const armedFromDialog = await pending;
      ok("§7 ⭐ confirming ARMS the draw instead of dropping a region",
        !!armedFromDialog && armedFromDialog.sp === 20 && armedFromDialog.poolMax === 60
        && armedFromDialog.label === "__PWK__Drawn Barrier" && armedFromDialog.sceneId === scene.id,
        JSON.stringify(armedFromDialog));
      ok("§7 the client reports itself armed", !!cov.coverDrawArmed());
      ok("§7 the confirm put the referee on the region layer with a draw tool live",
        (ui.controls?.control?.name ?? ui.controls?.activeControl) === "regions" || canvas.regions?.active === true,
        `control=${ui.controls?.control?.name ?? "?"} layerActive=${canvas.regions?.active}`);
      const beforeCount = scene.regions.size;
      ok("§7 ⛔ and NOTHING was created by the confirm itself", beforeCount === scene.regions.size);

      /* ── (c) THE DRAW: the next region drawn becomes that cover, shape untouched ───────────────── */
      const first = await drawRegion();
      const fb = behOf(first);
      ok("§7 ⭐ the drawn region gained the cover behavior with the stated structure, by value",
        fb?.system?.sp === 20 && fb?.system?.pool === 60 && fb?.system?.poolMax === 60,
        JSON.stringify({ sp: fb?.system?.sp, pool: fb?.system?.pool, poolMax: fb?.system?.poolMax }));
      ok("§7 it gained the stated name, ALWAYS visibility and the intact band colour",
        first.name === "__PWK__Drawn Barrier"
        && first.visibility === (CONST?.REGION_VISIBILITY?.ALWAYS ?? 2)
        && String(first.color?.css ?? first.color).toLowerCase() === "#d1a054",
        `${first.name} / ${first.visibility} / ${first.color?.css ?? first.color}`);
      ok("§7 ⛔ THE SHAPE THE REFEREE DREW IS UNTOUCHED — five-point polygon, same points",
        shapeIntact(first), JSON.stringify(first.shapes?.[0]?.points ?? null));
      ok("§7 it is a real cover crossing the engine can see",
        cov.coverZonesOn(scene).some(x => x.uuid === fb?.uuid && x.sp === 20));

      /* ── (d) ONE-SHOT: the arming is spent, and a second draw gains nothing ────────────────────── */
      ok("§7 the arming disarmed itself on the draw", cov.coverDrawArmed() === null);
      const second = await drawRegion("__PWK__Plain Region");
      ok("§7 ⭐ a SECOND region drawn after it gains nothing",
        behOf(second) === null && second.name === "__PWK__Plain Region",
        `${second.name} behaviors=${second.behaviors?.size ?? 0}`);

      /* ── (e) THE SECOND ACT: arming again re-arms with the NEW values ──────────────────────────── */
      const rearmed = cov.armCoverDraw({ label: "__PWK__Redrawn", sp: 5, poolMax: 0 });
      ok("§7 a second arming takes the new preset", rearmed?.sp === 5 && rearmed?.poolMax === 0, JSON.stringify(rearmed));
      const third = await drawRegion();
      const tb = behOf(third);
      ok("§7 the next draw takes the SECOND arming's values, not the first's",
        tb?.system?.sp === 5 && tb?.system?.poolMax === 0 && third.name === "__PWK__Redrawn",
        JSON.stringify({ sp: tb?.system?.sp, poolMax: tb?.system?.poolMax, name: third.name }));
      ok("§7 a structure of zero is still placed INTACT, not as rubble",
        String(third.color?.css ?? third.color).toLowerCase() !== "#555555",
        String(third.color?.css ?? third.color));

      /* ── (f) A SCENE CHANGE DISARMS — an arm cannot outlive the canvas it was made on ──────────── */
      cov.armCoverDraw({ label: "__PWK__Stale", sp: 10, poolMax: 30 });
      ok("§7 armed before the scene change", !!cov.coverDrawArmed());
      Hooks.callAll("canvasTearDown");
      await sleep(200);
      ok("§7 ⭐ the scene change disarmed it", cov.coverDrawArmed() === null);
      const orphan = await drawRegion("__PWK__After Teardown");
      ok("§7 and a region drawn afterwards gains nothing",
        behOf(orphan) === null && orphan.name === "__PWK__After Teardown",
        `${orphan.name} behaviors=${orphan.behaviors?.size ?? 0}`);

      /* ── (g) REGRESSION: the exported placer still drops one at the view centre ────────────────── */
      const direct = await cov.placeCoverZone({ scene, label: "__PWK__Direct", sp: 10, poolMax: 30 });
      drawn.push(direct);
      const db = behOf(direct);
      ok("§7 REGRESSION — placeCoverZone still places a ready-made rectangle with its values",
        !!direct && direct.shapes?.[0]?.type === "rectangle"
        && db?.system?.sp === 10 && db?.system?.poolMax === 30,
        JSON.stringify({ shape: direct?.shapes?.[0]?.type, sp: db?.system?.sp, poolMax: db?.system?.poolMax }));
    } catch (e) {
      // ⛔ A SECTION THAT THROWS REPORTS AS ONE FAILED LEG, never as a lost run — this suite drives real
      // documents and a real dialog, and a build missing a symbol it asks for must still let every other
      // section report (which is also what makes a red-first pass against the pre-change serve readable
      // rather than a single stack trace).
      ok("§7 — section threw", false, e?.message ?? String(e));
    } finally {
      try { cov.cancelCoverDrawArming(); } catch (_e) {}
      for (const r of drawn) await r?.delete?.().catch?.(() => {});
    }
  }

  // cleanup
  await scene.deleteEmbeddedDocuments("Token", [tok.id]);
  await actor.delete();
  for (const r of [region, far, near]) await r?.delete?.();
  for (const m of newCards()) await m.delete();

  return out;
});

for (const c of res.checks) check(c.n, c.p, c.d);
check("0 console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
