/**
 * GOON FACTORY — THE WINDOW (GOON-FACTORY-SPEC.md §1).
 *
 * ApplicationV2 + Handlebars, mirroring `dialog/preset-picker.js`'s shape (static DEFAULT_OPTIONS
 * with an `actions` table, static PARTS, `_prepareContext`) so a maintainer who has read one of this
 * module's V2 windows has read this one.
 *
 * ⛔⛔ THE QUICK/FULL SPLIT IS GONE. It was two renderings of one machine, and §0's simplicity
 * invariant replaced it with something stronger: ONE form whose quick path is
 * **(Threat level + Role) or Outfit → Generate**, with every dial Advanced-gated. There is no mode
 * state on this class and there must not be one again.
 *
 * ⭐ FOUR RULINGS OF 2026-08-14 (the user walked the shipped window) shape what this file renders:
 *  R1 the picks read top-down in hierarchy order — THREAT LEVEL, then role, then outfit. The outfit
 *     still prefills everything below it; only its position moved.
 *  R2 the Advanced checkbox is ALWAYS live. It used to render `disabled` until a grade was picked,
 *     and a checkbox that swallows a click reads as broken however good the reason.
 *  R3 the dial section renders from FIRST OPEN — locked (disabled controls) until Advanced, DASHED
 *     until a threat level exists. "Locked, visible" was always the rule; hiding the section behind
 *     `{{#if grade}}` broke it.
 *  R4 the count starts at 1 and then REMEMBERS what this user last asked for, across window opens
 *     and across sessions (`goonCountLast`, below).
 *
 * ⭐ THE WINDOW COMPUTES NOTHING ABOUT A GOON. It reads the form, calls the pure `resolveGoonConfig`
 * / `goonBlueprint`, and hands the plan to `goon-factory.js`. That is the pure/impure boundary this
 * feature is built on, and it is why the preview and the created actor cannot disagree: they are the
 * same plan object. Every honesty line rendered below was produced by the PLAN — this file only
 * localizes it.
 */

import { resolveGoonConfig, parseDiceExpression } from "./blueprint.js";
import {
  ARMAMENT_POSTURES, ARMOR_HARDNESS_FILTERS, ARMOR_WEIGHT_FILTERS, BT_TICKS, BT_RANGE, COUNT,
  DISPOSITIONS, GRADE_KEYS, GRADES, LOOT_DIAL, LOOT_LABEL_KEYS, REF_RANGE, ROLE_OPTIONS,
  ROLE_RANDOM, SKILL_POINTS, STAT_POOL, STAT_SHAPES, STAT_SHAPE_LABEL_KEYS,
  clampCount, salvageEstimate, trackPct,
} from "./grades.js";
import { OUTFITS } from "./outfits.js";
import {
  GOON_MAX_COUNT, findGoonLocker, goonLockerName, materializeGoonSquad, planGoonSquad,
} from "./goon-factory.js";
import { catalogIndexReady, getCatalogIndex } from "../shop/catalog.js";
import { localize, localizeParam, tryLocalize } from "../utils.js";
import { npcGenEnabled } from "../settings.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const SCOPE = "cp2020-augmented";

/** A fresh root seed. §1 retired the visible-seed UI; the seed is INTERNAL and per-goon now. */
function freshSeed() { return Math.random().toString(36).slice(2, 10); }

// =================================================================================================
// R4 — THE REMEMBERED COUNT
// =================================================================================================

/**
 * The store behind R4: *"COUNT defaults to 1 and REMEMBERS the user's last entry across window
 * opens."*
 *
 * ⭐ SHAPE: a **client-scoped, `config: false` module setting** — the module's existing store for
 * per-user UI state (`shopShowSource`, `ipShowPending` are the client-scoped pair; `hideScrapedPacksPrior`
 * and `civilianSheetMigrated` are the config:false-companion pattern). Client scope is what makes it
 * per-USER rather than per-world, and it needs no permission: a player's own client settings are
 * always writable by that player, so this works for a co-GM without a world write.
 *
 * ⭐ REGISTERED HERE, NOT IN settings.js, following `registerRadiationZones` and
 * `registerCivilianSheetMigration`: a store that never appears in the settings menu belongs beside
 * the code that writes it. `registerNpcGenHooks` (init) is where it happens.
 */
const COUNT_MEMORY = "goonCountLast";

function registerGoonCountMemory() {
  try {
    game.settings.register(SCOPE, COUNT_MEMORY, {
      scope: "client", config: false, type: Number, default: COUNT.default,
    });
  } catch (e) { /* already registered (a re-init) — the stored value stands */ }
}

/** The count this user last asked for, clamped by the same rule the form uses. Never throws. */
export function rememberedGoonCount() {
  try { return clampCount(game.settings.get(SCOPE, COUNT_MEMORY)).value; } catch (e) { return COUNT.default; }
}

/**
 * Record a count for next time. Fire-and-forget on purpose: `_readForm` is synchronous and runs on
 * every control change, and a window that awaited a settings write on each keystroke would stutter
 * for a value nothing in the current render depends on.
 */
export function rememberGoonCount(n) {
  const value = clampCount(n).value;
  try {
    if (Number(game.settings.get(SCOPE, COUNT_MEMORY)) === value) return;   // no write, no socket
    game.settings.set(SCOPE, COUNT_MEMORY, value).catch(() => { /* the window still works */ });
  } catch (e) { /* unregistered (bare import in a test) — the window still works */ }
}

/** Honesty codes that read as a WARNING rather than as information. Drives the row's CSS tone only. */
const WARN_CODES = new Set([
  "cyberpsycho", "invalidLuckFormula", "invalidRepFormula", "lightCannotReachBand", "noWeapon",
  "noWeaponAvailable", "postureLoadMissing", "slotEmpty", "slotExhausted", "housingFull",
  "statPoolClamped", "skillPointsClamped", "statPoolUnspent", "launcherNeedsAmmo",
  "noArmorAvailable", "prerequisiteMissing", "housingMissing", "hardnessFilterEmpty",
]);

export class NpcGeneratorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this.outfitId = "";
    // ⭐ RANDOM IS THE ROLE CONTROL'S DEFAULT (ruled 2026-08-15), and this field is now only ever the
    // DEFAULT: every role the GM actually picks travels as `overrides.role`, so an outfit's prefill
    // can beat the default while an explicit pick — including an explicit pick of Random — still
    // beats the outfit. Mirroring the select into this field is what made a flip back to Random
    // impossible: the outfit's roleDefault outranks it, so the flip was swallowed every time.
    this.role = ROLE_RANDOM;
    this.grade = null;              // ⛔ null is a REAL state — §1's threat level starts as dashes
    this.count = rememberedGoonCount();   // R4: 1 for a user who has never typed one, else theirs
    this.advanced = false;
    this.overrides = {};            // only what the GM has actually moved; empty = pure derivation
    this.seed = freshSeed();
    this.preview = null;            // [planRow] — set by Generate, cleared by any control change
    this.destination = { mode: "locker" };
    this._countClamped = false;
    this._indexWait = null;
    this._boundRoot = null;         // the element the change/input listeners are attached to
    this._staleDials = false;       // set by a re-derive, cleared by the repaint — see _readForm
  }

  static DEFAULT_OPTIONS = {
    id: "cp-npcgen",
    classes: ["cyberpunk", "cp-npcgen-app", "cp-goon-app"],
    window: { title: "CYBERPUNK.GoonFactory.Title", icon: "fa-solid fa-users-gear", resizable: true },
    position: { width: 760, height: "auto" },
    actions: {
      goonAdvanced: NpcGeneratorApp._onAdvanced,
      goonGenerate: NpcGeneratorApp._onGenerate,
      goonConfirm: NpcGeneratorApp._onConfirm,
      goonDiscard: NpcGeneratorApp._onDiscard,
      goonRerollOne: NpcGeneratorApp._onRerollOne,
      goonDeleteOne: NpcGeneratorApp._onDeleteOne,
      goonPickDestination: NpcGeneratorApp._onGenerate,
    },
  };

  static PARTS = { main: { template: "modules/cp2020-augmented/templates/npcgen/generator.hbs" } };

  // ===============================================================================================
  // RENDER
  // ===============================================================================================

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const ready = catalogIndexReady();
    if (!ready) this._awaitCatalogIndex();

    const cfg = resolveGoonConfig({
      outfitId: this.outfitId || null, role: this.role, grade: this.grade, overrides: this.overrides,
    });
    const grade = cfg.grade ? GRADES[cfg.grade] : null;

    // §1: any manual edit after an outfit → "Custom (based on X)"; re-picking re-derives clean.
    const picked = this.outfitId ? OUTFITS.find((o) => o.id === this.outfitId) : null;
    const outfitLabel = picked ? tryLocalize(picked.labelKey, this.outfitId) : "";
    const basedOnLabel = cfg.custom && this.outfitId
      ? localizeParam("GoonFactory.CustomBasedOn", { outfit: outfitLabel })
      : localizeParam("GoonFactory.BasedOn", { outfit: outfitLabel });

    const sel = (arr, cur, labelOf) => arr.map((k) => ({
      key: k, label: labelOf(k), selected: String(k) === String(cur),
    }));

    // ⭐ R3's DASHES. `gradeDerived` is the pure layer's own answer to "is there anything to derive
    // from?", so the readouts ask it rather than re-deciding. A slider cannot display a dash, so the
    // pair splits: the input takes a parking VALUE (the bottom of its range) and the readout beside
    // it carries the truth. That is the same idiom the threat level select already uses — its first
    // option is a dash, and an unpicked grade is a real state rather than a silent E.
    const derived = !!cfg.gradeDerived;
    const unset = localize("GoonFactory.Unset");
    const skillBreakdown = cfg.skillBreakdown ?? { total: 0, reserved: 0, floor: 0 };
    const poolBreakdown = cfg.statPoolBreakdown ?? { pool: 0, reserved: 0, floor: 0, ceiling: STAT_POOL.ceiling };

    // ⭐ R6/R7's GEOMETRY, computed once here and handed to the render edge as bare NUMBERS.
    // A tick's position and the reserved band's edge are the same question — "where does this value
    // sit on this track?" — so both are `trackPct`, and both tracks are the FIXED scale (0→max)
    // rather than the old floor→max, which is what makes the reservation drawable at all.
    const salvage = this.preview?.length ? salvageEstimate(this.preview) : null;

    return {
      ...context,
      catalogLoading: !ready,
      // top
      outfits: OUTFITS.map((o) => ({
        id: o.id, label: tryLocalize(o.labelKey, o.id), selected: o.id === this.outfitId,
      })),
      outfitId: this.outfitId,
      basedOnLabel,
      // ⭐ §B.2's GRADE-SPAN NOTE — the paired-entry cross-reference ("elite squads run higher — see
      // …"), and the whole of what B2 asks for: a DISPLAY surface, no mechanics. It renders only for
      // the outfit actually picked and only when that outfit has a pair, so the ladder is visible
      // without the mixed-patrol composition engine that would let one squad span two grades.
      gradeSpanNote: picked?.gradeSpanNoteKey ? tryLocalize(picked.gradeSpanNoteKey, "") : "",
      // header band
      // ROLE_OPTIONS leads with `random` and its label lives in the same `GoonFactory.Role.*` map as
      // the nine book roles, so the sentinel needs no special case in the template.
      roles: ROLE_OPTIONS.map((r) => ({
        key: r, label: tryLocalize(`GoonFactory.Role.${r}`, r), selected: r === cfg.role,
      })),
      // ⭐ DISPOSITION IS A BASELINE CONTROL, so it renders in the top band beside the three picks
      // and carries no `disabled` state at all — the Advanced lock is below it.
      dispositions: sel(DISPOSITIONS, cfg.disposition, (k) => tryLocalize(`GoonFactory.Disposition.${k}`, k)),
      grades: GRADE_KEYS.map((k) => ({
        key: k, label: tryLocalize(GRADES[k].labelKey, k),
        hint: tryLocalize(GRADES[k].hintKey, ""), selected: k === cfg.grade,
      })),
      grade: cfg.grade,
      count: this.count,
      maxCount: GOON_MAX_COUNT,
      countClamped: this._countClamped,
      advanced: this.advanced,
      // below the line — R3: rendered in every state, so each control ships a VALUE and a READOUT
      unsetMark: unset,
      refRange: REF_RANGE, btRange: BT_RANGE,
      refValue: derived ? cfg.ref : REF_RANGE.min,
      refOut: derived ? cfg.ref : unset,
      btValue: derived ? cfg.bt : BT_RANGE.min,
      btOut: derived ? cfg.bt : unset,
      // R6: the BT ticks are the BTM breakpoints, drawn as marks ON the track. The `pct` is the mark's
      // own position; the stylesheet turns it into a mark. (The REF slider stays tickless by its own
      // ruling — it has no book breakpoints to name.)
      btTicks: BT_TICKS.map((t) => ({
        value: t.value, hint: tryLocalize(t.hintKey, ""),
        pct: trackPct(t.value, BT_RANGE.min, BT_RANGE.max),
      })),
      skill: skillBreakdown,
      skillScale: SKILL_POINTS,
      skillValue: skillBreakdown.total,
      skillOut: derived ? skillBreakdown.total : unset,
      // R7: the reserved segment, as a percentage of the FIXED track. It is the same number the
      // breakdown line states in words, so the band and the sentence cannot disagree.
      skillReservedPct: trackPct(skillBreakdown.floor, SKILL_POINTS.scaleMin, SKILL_POINTS.scaleMax),
      // ⭐ THE LINE STATES ALL THREE HALVES, and the third is there because of the ruled deviation:
      // the role's special ability is levelled at the GRADE, not bought out of the slider's points
      // (see CAREER_PACKAGES in blueprint.js). A GM reading "32 to the role package" would otherwise
      // have no way to know the special ability was extra.
      // R3: an underived breakdown line is a DASH, not an empty gap — the reader can tell the
      // difference between "nothing picked yet" and "this line failed to build".
      skillBreakdownLine: grade ? localizeParam("GoonFactory.SkillBreakdown", {
        total: skillBreakdown.total, reserved: skillBreakdown.reserved,
        grade: cfg.grade, rest: skillBreakdown.toPackage, special: grade.skillPts,
      }) : unset,
      pool: poolBreakdown,
      poolScale: STAT_POOL,
      poolValue: poolBreakdown.pool,
      poolOut: derived ? poolBreakdown.pool : unset,
      poolTicks: STAT_POOL.ticks.map((t) => ({
        value: t.value, hint: tryLocalize(t.hintKey, ""),
        pct: trackPct(t.value, STAT_POOL.scaleMin, STAT_POOL.ceiling),
      })),
      // The band ends where the THUMB stops, which is the dynamic floor — REF + BODY plus the
      // minimum every remaining stat must keep. The line below names both halves for that reason:
      // a band drawn to the floor and a sentence naming only REF + BODY would not agree.
      poolReservedPct: trackPct(poolBreakdown.floor, STAT_POOL.scaleMin, STAT_POOL.ceiling),
      poolBreakdownLine: grade ? localizeParam("GoonFactory.PoolBreakdown", {
        pool: poolBreakdown.pool, reserved: poolBreakdown.reserved, free: poolBreakdown.free,
        floor: poolBreakdown.floor, mins: poolBreakdown.floor - poolBreakdown.reserved,
      }) : unset,
      shapes: sel(STAT_SHAPES, cfg.statShape, (k) => tryLocalize(STAT_SHAPE_LABEL_KEYS[k], k)),
      luckFormula: cfg.luckFormula, repFormula: cfg.repFormula,
      chromeOn: cfg.chromeOn,
      // A number field cannot show a dash, so the underived state is an EMPTY field with the dash
      // as its placeholder (the template supplies it from `unsetMark`).
      chromeCountValue: derived ? cfg.chromeCount : "",
      chromeDerivationLine: cfg.chromeDerivation ? localizeParam("GoonFactory.ChromeDerivation", {
        base: cfg.chromeDerivation.base, grade: cfg.grade,
        solo: cfg.chromeDerivation.soloBonus, outfit: cfg.chromeDerivation.outfitMod,
      }) : unset,
      garnish: cfg.garnish,
      armorWeights: sel(ARMOR_WEIGHT_FILTERS, cfg.armorWeight, (k) => tryLocalize(`GoonFactory.Weight.${k}`, k)),
      armorHardnesses: sel(ARMOR_HARDNESS_FILTERS, cfg.armorHardness, (k) => tryLocalize(`GoonFactory.Hardness.${k}`, k)),
      armaments: sel(ARMAMENT_POSTURES, cfg.armament, (k) => tryLocalize(`GoonFactory.Armament.${k}`, k)),
      lootDial: sel(LOOT_DIAL, cfg.loot, (k) => tryLocalize(LOOT_LABEL_KEYS[k], k)),
      // preview
      hasPreview: !!this.preview?.length,
      preview: this.preview?.map((row, i) => this._previewCard(row, i)) ?? null,
      // ⭐ THE SALVAGE DISCLOSURE (the loot rescope, ruled 2026-08-14). It prints at EVERY dial
      // setting, `off` included: the dial cannot gate gear, so the honest affordance is to say what
      // the squad is worth rather than to pretend it is worth nothing. `salvageEstimate` states its
      // own rounding rule and excludes the credchip and the spare magazines — those ARE the dial.
      salvageLine: salvage
        ? localizeParam("GoonFactory.Salvage", { eb: salvage.rounded.toLocaleString("en-US") })
        : "",
      // the fused generate button
      ...this._generateButton(),
      destinations: this._destinationOptions(),
    };
  }

  /** One preview card. Everything here is DISPLAY of a plan row — nothing is decided at this level. */
  _previewCard(row, index) {
    const s = row.stats;
    const chromeNames = [...(row.chrome?.items ?? []), ...(row.chrome?.bonusItems ?? [])].map((c) => c.name);
    return {
      index,
      name: row.bp.name,
      // ⭐ THE ROLLED ROLE, NAMED BEFORE THE GM CONFIRMS. It renders only when the batch was set to
      // Random, because that is the only state in which the goon's role is not already on screen in
      // the control above — a fixed-role batch would just be repeating itself on every card.
      // The role comes from `bp.role` (the RESOLVED one) and is localized here, in the same place
      // the gear / armor / chrome lines are localized: the plan is pure and holds no display text.
      roleLine: row.bp.roleRolled
        ? localizeParam("GoonFactory.PreviewRole", {
          role: tryLocalize(`GoonFactory.Role.${row.bp.role}`, row.bp.role),
        })
        : "",
      statLine: `INT ${s.int} · REF ${s.ref} · TECH ${s.tech} · CL ${s.cool} · ATT ${s.attr} · LK ${s.luck} · MA ${s.ma} · BT ${s.bt} · EMP ${s.emp}`,
      gearLine: row.weapon ? localizeParam("GoonFactory.PreviewGear", { weapon: row.weapon.name }) : "",
      armorLine: (row.armor?.layers ?? []).length
        ? localizeParam("GoonFactory.PreviewArmor", {
          names: row.armor.layers.map((l) => l.name).join(", "),
          sp: row.armor.effectiveSP, ev: row.armor.effectiveEV,
        })
        : "",
      chromeLine: chromeNames.length ? localizeParam("GoonFactory.PreviewChrome", { names: chromeNames.join(", ") }) : "",
      honesty: (row.honesty ?? []).map((h) => ({
        tone: WARN_CODES.has(h.code) ? "warn" : "info",
        text: this._honestyText(h),
      })),
    };
  }

  /**
   * Localize one honesty row. The PLAN supplies a code, a message key and the numbers; this turns
   * that into a sentence. A code whose key is missing degrades to the code itself rather than to an
   * empty line — a silent blank in the honesty list would defeat the whole point of the list.
   */
  _honestyText(h) {
    // Data-layer keys are stored BARE (no "CYBERPUNK." prefix), matching tables.js's own convention;
    // `localizeParam` adds it. A missing key degrades to the code rather than to an empty line — a
    // silent blank in the honesty list would defeat the entire point of the list.
    if (!h.messageKey) return h.code ?? "";
    const full = `CYBERPUNK.${h.messageKey}`;
    if (!game.i18n.has(full)) return h.code ?? "";
    return localizeParam(h.messageKey, { ...h });
  }

  /**
   * §1's FUSED destination button, and its empty-state rule.
   *
   * ⛔ *"If destination is ever empty the button label becomes the instruction … no mysterious
   * gray-out, ever."* So this never returns a disabled button: it returns a different LABEL and a
   * different action. A GM always has something to click and always knows what it will do.
   */
  _generateButton() {
    const destOk = this.destination.mode !== "existing" || !!game.folders?.get(this.destination.folderId);
    if (!destOk) {
      return { generateLabel: localize("GoonFactory.PickDestination"), generateAction: "goonPickDestination" };
    }
    const folderName = this.destination.mode === "existing"
      ? (game.folders?.get(this.destination.folderId)?.name ?? goonLockerName())
      : this.destination.mode === "root" ? localize("GoonFactory.DestRoot") : goonLockerName();
    if (this.preview?.length) {
      return {
        generateLabel: localizeParam("GoonFactory.Confirm", { n: this.preview.length, folder: folderName }),
        generateAction: "goonConfirm",
      };
    }
    return {
      generateLabel: localizeParam("GoonFactory.Generate", { n: this.count, folder: folderName }),
      generateAction: "goonGenerate",
    };
  }

  /** Existing folders / the Goon Locker / the root / a new auto-named subfolder. */
  _destinationOptions() {
    const cur = this.destination;
    const opts = [
      { value: "locker", label: goonLockerName(), selected: cur.mode === "locker" },
      { value: "root", label: localize("GoonFactory.DestRoot"), selected: cur.mode === "root" },
      { value: "new", label: localize("GoonFactory.DestNew"), selected: cur.mode === "new" },
    ];
    const locker = findGoonLocker();
    for (const f of game.folders?.filter?.((x) => x.type === "Actor" && x.id !== locker?.id) ?? []) {
      opts.push({ value: `f:${f.id}`, label: f.name, selected: cur.mode === "existing" && cur.folderId === f.id });
    }
    return opts;
  }

  /**
   * Bind the controls whose change alters what everything ELSE displays.
   *
   * ⭐ WHY THIS EXISTS AT ALL, and why it is R3's other half. Until now the window listened to
   * nothing: only the `data-action` controls (Advanced, Generate, the preview icons) ever caused a
   * read or a repaint, so picking a threat level changed no pixel until the GM pressed something
   * else. That was survivable while the dials were hidden behind the grade; it is not survivable now
   * that they are always on screen, because R3's *"controls show their grade-derived values once a
   * grade exists"* is a statement about the moment the grade is picked.
   *
   * ⛔ ONLY THE DERIVATION DRIVERS RE-RENDER (threat level · role · outfit · count · destination).
   * The dials deliberately do NOT: a repaint mid-adjustment would snap a slider back to the derived
   * value under the GM's own hand. They are read where they always were — at the Advanced toggle and
   * at Generate. The `input` handler keeps a moved slider's own readout honest by writing TEXT into
   * the readout beside it; it changes no state and triggers no render.
   *
   * Bind-once, by remembering the element: ApplicationV2 re-renders replace the PART's inner markup
   * but keep the window element, so a delegated listener survives a render and must not be stacked.
   */
  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if (!root) return;
    this._staleDials = false;        // the repaint happened: the form's values are trustworthy again
    this._paintReservations(root, context);   // EVERY render — the band follows the derivation
    if (this._boundRoot === root) return;
    this._boundRoot = root;

    root.addEventListener("change", (ev) => {
      const t = ev.target;
      // ⭐ THE TOP-BAND CONTROLS ALL RE-RENDER. Disposition joined the list with its 2026-08-15
      // ruling: its own "Custom (based on X)" label and its select's selected option both come from
      // the resolved config, so a flip that did not repaint would leave the window disagreeing with
      // the plan it is about to build.
      if (!t?.matches?.(".cp-goon-grade, .cp-goon-role, .cp-goon-outfit, .cp-goon-disposition, .cp-goon-count, .cp-goon-dest")) return;
      this._readForm();
      this.render();
    });

    root.addEventListener("input", (ev) => {
      const t = ev.target;
      if (!t?.matches?.(".cp-goon-dials input[type='range']")) return;
      // ⭐ R7's CLAMP, LANDING EXACTLY ON THE BAND'S EDGE. The floor used to be the input's own `min`
      // attribute, which clamped correctly but drew nothing: a track that STARTS at the floor cannot
      // show the reservation. The scale is fixed now and the floor rides as data on the control, so
      // the thumb still cannot pass the guarantee — it stops on the band's edge, visibly.
      const floor = Number(t.dataset.cpFloor);
      if (Number.isFinite(floor) && Number(t.value) < floor) t.value = String(floor);
      const out = t.closest(".cp-goon-row")?.querySelector(".cp-goon-out");
      if (out) out.textContent = t.value;
    });

    // ⭐ NUMBER FIELDS TAKE DIGITS, full stop (user-ordered 2026-08-28, two rounds): a type="number"
    // input lets Chromium type the exponent characters e E + - . into the VALUE — the original
    // "I can type letters" report — and blocking only those left the other letters to Chromium's own
    // handling, which "accepts" one typed over a selection by wiping the visible value into the
    // bad-input state until blur (round two: visual-only, but an inconsistency). So the rule is the
    // consistent one: any single character that is not a digit is refused at the keystroke, for
    // every number field in the window. Editing and navigation keys (Backspace, arrows, Tab …) have
    // multi-character names and pass untouched; Ctrl/Cmd chords (copy, paste, select-all) pass, and
    // a pasted mess is caught by the clamp below when the edit lands.
    root.addEventListener("keydown", (ev) => {
      const t = ev.target;
      if (!t?.matches?.('input[type="number"]')) return;
      if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !/[0-9]/.test(ev.key)) ev.preventDefault();
    });
    root.addEventListener("change", (ev) => {
      const t = ev.target;
      if (!t?.matches?.('input[type="number"]')) return;
      if (t.value === "") return;                       // empty = "re-derive" everywhere in this window
      const n = Math.trunc(Number(t.value));
      const min = t.min !== "" ? Number(t.min) : -Infinity;
      const max = t.max !== "" ? Number(t.max) : Infinity;
      const clamped = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : "";
      if (String(clamped) !== t.value) t.value = String(clamped);
    });

    // ⭐ THE PROMISED AT-THE-FIELD FORMULA CHECK, actually wired (user report 2026-08-28: the dice
    // boxes took anything). blueprint.js's parser doc has claimed since it was written that "the
    // impure edge additionally runs Roll.validate so a GM is told at the field rather than silently
    // falling back at generate time" — but nothing ever supplied the template's formulaNote, so the
    // promise never fired. This is that edge: both parsers must accept the text (our small grammar
    // is the floor, Roll.validate the ceiling) or the field marks itself and the note names the
    // fallback that generate time will actually use.
    root.addEventListener("input", (ev) => {
      const t = ev.target;
      if (!t?.matches?.(".cp-goon-luck, .cp-goon-rep")) return;
      const text = String(t.value ?? "").trim();
      let bad = false;
      if (text) {
        let rollOk = true;
        try { rollOk = Roll.validate(text); } catch { rollOk = false; }
        bad = !parseDiceExpression(text) || !rollOk;
      }
      t.classList.toggle("cp-goon-field-invalid", bad);
      const note = root.querySelector(".cp-goon-formula-note");
      if (note) {
        note.hidden = !bad;
        if (bad) note.textContent = game.i18n.format("CYBERPUNK.GoonFactory.FormulaInvalid", { formula: text });
      }
    });
  }

  /**
   * R7's ONE DYNAMIC VALUE, and the whole of what JS contributes to the reserved band.
   *
   * ⛔ IT IS A NUMBER, NOT A STYLE. `--cp-goon-reserved` carries a bare 0–100 percentage onto the two
   * sliders that have a reservation; `css/cp2020-augmented.css` owns the gradient, both themes'
   * colours and the mark geometry. Nothing here names a colour, a length or a gradient — the house
   * rule against building CSS in JS holds, and this is the sanctioned exception's exact shape: one
   * datum the stylesheet cannot know.
   *
   * Written on EVERY render rather than once, because the reservation moves with the threat level.
   * It deliberately does NOT follow a live REF/BODY drag: the breakdown line beside it is rendered
   * text and only refreshes on a re-render, and a band that moved while the sentence did not would
   * be the two disagreeing. They refresh together, always.
   */
  _paintReservations(root, context) {
    const bands = [
      [".cp-goon-skillpoints", context?.skillReservedPct],
      [".cp-goon-statpool", context?.poolReservedPct],
    ];
    for (const [selector, pct] of bands) {
      const el = root.querySelector(selector);
      if (el) el.style.setProperty("--cp-goon-reserved", String(Number(pct) || 0));
    }
  }

  _awaitCatalogIndex() {
    if (this._indexWait) return;
    this._indexWait = getCatalogIndex().then(
      () => { this._indexWait = null; if (this.rendered) this.render(); },
      (err) => { this._indexWait = null; console.error(`cp2020-augmented | goon factory: catalog index build failed`, err); },
    );
  }

  // ===============================================================================================
  // FORM READ
  // ===============================================================================================

  /**
   * Read every control back off the form.
   *
   * ⭐ ONLY WHAT THE GM ACTUALLY MOVED BECOMES AN OVERRIDE, and that is what makes §1's derivation
   * rules work. A control sitting at its grade-derived value is NOT recorded, so a grade re-pick
   * re-derives it cleanly; the moment a value differs from the derivation it is recorded and the
   * config flips to "Custom (based on X)".
   *
   * ⛔ A LOCKED CONTROL IS TRULY INERT. When Advanced is off, the below-the-line inputs are rendered
   * `disabled` and this function does not read them at all — so a stale DOM value (or a browser that
   * restored one) can never leak into the plan. That is §4's "locked controls truly inert" leg.
   *
   * ⛔ NEITHER IS AN UNDERIVED ONE (R2/R3). Advanced now unlocks with no threat level picked, and
   * those unlocked controls have nothing to be compared against — "did the GM move this?" is a
   * comparison against a DERIVED value, and there is none. So nothing below the line is recorded
   * until a grade exists, and the grade pick re-derives everything anyway.
   *
   * ⛔⛔ THE STALE-DOM TRAP ON A RE-PICK, and it is why the outfit/grade change RETURNS EARLY.
   * §1 requires a re-pick to "re-derive uniformly (visible reset)". Dropping the overrides is only
   * half of that: the below-the-line inputs still hold the PREVIOUS derivation's values until the
   * next render repaints them, so reading them in the same pass immediately re-creates every
   * override that was just dropped. A rig leg caught exactly this — a REF forced to 10 under grade B
   * survived a re-pick to grade A. So a changed outfit or grade drops the overrides AND stops
   * reading here; the render that follows repaints the controls at the new derived values, and the
   * next read sees those.
   */
  _readForm() {
    const root = this.element;
    if (!root) return;
    const val = (sel) => root.querySelector(sel)?.value ?? "";
    const checked = (sel) => !!root.querySelector(sel)?.checked;

    const prevOutfit = this.outfitId;
    const prevGrade = this.grade;
    this.outfitId = val(".cp-goon-outfit");
    const g = val(".cp-goon-grade");
    this.grade = g || null;

    const raw = parseInt(val(".cp-goon-count"), 10);
    const clamped = clampCount(raw);
    this.count = clamped.value;
    this._countClamped = clamped.clamped;
    rememberGoonCount(this.count);      // R4: the number the GM typed is the number they see next time

    const destRaw = val(".cp-goon-dest");
    if (destRaw?.startsWith("f:")) this.destination = { mode: "existing", folderId: destRaw.slice(2) };
    else if (destRaw) this.destination = { mode: destRaw };

    // §1: re-picking either the outfit or the threat level RE-DERIVES CLEAN. See the trap above.
    const outfitChanged = this.outfitId !== prevOutfit;
    if (outfitChanged || this.grade !== prevGrade) {
      this.overrides = {};
      this.preview = null;                          // a re-derived config invalidates a shown preview
      // ⛔⛔ THE PHANTOM GRADE CHANGE, and it swallowed a real edit until 2026-08-15.
      // An outfit PREFILLS the threat level, and the render paints that prefill into the grade
      // SELECT — but `this.grade` was left holding the GM's own (usually empty) pick. The next read
      // therefore saw the prefilled letter as a brand-new grade pick, took this branch a SECOND
      // time, and dropped the override for whatever control the GM had just touched. Caught by the
      // role flip-back leg: pick an outfit, flip Role to Random, and the flip vanished on render.
      // Moving `this.grade` with the prefill closes it; the end state is the one the old code
      // reached one pass later anyway, so nothing about "re-derives clean" changes.
      if (outfitChanged) {
        const prefilledGrade = resolveGoonConfig({ outfitId: this.outfitId || null, role: this.role }).grade;
        if (prefilledGrade) this.grade = prefilledGrade;
      }
      // ⛔ AND NOTHING BELOW THE LINE IS READ AGAIN UNTIL THE REPAINT. Returning is only enough for
      // THIS pass; a second read arriving before the render lands (a second listener, a Generate
      // click in the same tick) would see the very same stale inputs and re-create the overrides
      // that were just dropped. The flag closes that window and `_onRender` opens it again.
      this._staleDials = true;
      return;
    }
    if (this._staleDials) return;                   // the re-derived values are not on screen yet

    const ov = {};
    const put = (key, value, derivedValue) => {
      if (value === null || value === undefined || value === "") return;
      // ⛔ NaN IS NOT AN OVERRIDE (found 2026-08-28 under the chrome-count report): a cleared or
      // garbage numeric field parseInts to NaN, which passed the guards above and was RECORDED —
      // so clearing the chrome box bricked the batch to zero chrome instead of re-deriving. An
      // unreadable number is the same statement as an empty field: nothing was picked.
      if (typeof value === "number" && !Number.isFinite(value)) return;
      if (String(value) === String(derivedValue)) return;                 // untouched ⇒ not an override
      ov[key] = value;
    };

    // ── THE TOP-BAND CONTROLS (ruled 2026-08-15) ──────────────────────────────────────────────────
    // ⛔ ROLE AND DISPOSITION ARE READ IN EVERY STATE. They sit ABOVE the Advanced line, so neither
    // the lock nor an unpicked threat level may gate them — the two early returns below are about the
    // DIALS and must not swallow a control the GM can see and click right now.
    //
    // They still go through the same "untouched ⇒ not an override" comparison every dial uses, which
    // is what makes the ruled behaviour fall out with no special case: a control left sitting at the
    // outfit's prefill records nothing (re-picking the outfit re-derives clean), and a hand flip —
    // including a flip of the role BACK to Random — records an override that outranks the outfit and
    // flips the config to "Custom (based on X)".
    const top = resolveGoonConfig({ outfitId: this.outfitId || null, role: this.role, grade: this.grade });
    const prevTopRole = this.overrides.role;
    const prevTopDisposition = this.overrides.disposition;
    put("role", val(".cp-goon-role"), top.role);
    put("disposition", val(".cp-goon-disposition"), top.disposition);
    // A shown preview was planned against the OLD role / disposition, and the fused button would
    // happily confirm it. Both change what every goon in the batch IS, so a change invalidates the
    // preview exactly as an outfit or threat-level re-pick does.
    if (ov.role !== prevTopRole || ov.disposition !== prevTopDisposition) this.preview = null;
    this.overrides = ov;                            // the top band alone, until the dials are read

    if (!this.advanced || !this.grade) return;      // locked or underived ⇒ nothing below is read

    // The derivation as it stands WITHOUT the DIAL overrides, so "did the GM move this?" is a
    // comparison against the derived value rather than against the last thing we happened to store.
    // ⚠ The top-band overrides ARE folded in, and they have to be: the chrome count derives from the
    // role (the Solo bonus), so comparing a Solo batch's chrome field against a Random derivation
    // would read an untouched field as a hand edit.
    const derived = resolveGoonConfig({
      outfitId: this.outfitId || null, role: this.role, grade: this.grade, overrides: { ...ov },
    });
    put("ref", parseInt(val(".cp-goon-ref"), 10), derived.ref);
    put("bt", parseInt(val(".cp-goon-bt"), 10), derived.bt);
    put("skillPoints", parseInt(val(".cp-goon-skillpoints"), 10), derived.skillPoints);
    put("statPool", parseInt(val(".cp-goon-statpool"), 10), derived.statPool);
    put("statShape", val(".cp-goon-shape"), derived.statShape);
    put("luckFormula", val(".cp-goon-luck"), derived.luckFormula);
    put("repFormula", val(".cp-goon-rep"), derived.repFormula);
    put("chromeCount", parseInt(val(".cp-goon-chrome-count"), 10), derived.chromeCount);
    put("armorWeight", val(".cp-goon-armor-weight"), derived.armorWeight);
    put("armorHardness", val(".cp-goon-armor-hardness"), derived.armorHardness);
    put("armament", val(".cp-goon-armament"), derived.armament);
    put("loot", val(".cp-goon-loot"), derived.loot);
    const chromeOn = checked(".cp-goon-chrome-on");
    if (chromeOn !== derived.chromeOn) ov.chromeOn = chromeOn;
    const garnish = checked(".cp-goon-garnish");
    if (garnish !== derived.garnish) ov.garnish = garnish;
    this.overrides = ov;
  }

  /** The argument set both the plan and the blueprint take. One place, so they cannot drift. */
  _planOpts() {
    return {
      outfitId: this.outfitId || null, role: this.role, grade: this.grade,
      overrides: this.overrides, count: this.count, seed: this.seed,
    };
  }

  // ===============================================================================================
  // ACTIONS
  // ===============================================================================================

  static async _onAdvanced() {
    this._readForm();
    this.advanced = !this.advanced;
    this.render();
  }

  /** Build the plan and show the preview. ⛔ Writes NOTHING — this is the confirmation step. */
  static async _onGenerate() {
    this._readForm();
    if (!this.grade) { ui.notifications?.warn(localize("GoonFactory.NeedGrade")); return; }
    const dest = this.destination.mode === "existing" ? game.folders?.get(this.destination.folderId) : null;
    this.preview = await planGoonSquad({ ...this._planOpts(), destinationFolder: dest ?? findGoonLocker() });
    this.render();
  }

  /** Confirm creates. The preview IS the plan, reused verbatim — what was approved is what is written. */
  static async _onConfirm() {
    if (!game.user?.isGM) return;
    if (!this.preview?.length) return;
    const made = await materializeGoonSquad(this.preview, this.destination);
    if (made.length) {
      ui.notifications?.info(localizeParam("GoonFactory.Created", { n: made.length }));
      this.preview = null;
      // A fresh root seed so a second Generate does not silently rebuild the same squad on top of
      // itself. Numbering continues from the folder scan, so the two batches do not collide.
      this.seed = freshSeed();
      this.render();
    }
  }

  static async _onDiscard() {
    this.preview = null;
    this.seed = freshSeed();
    this.render();
  }

  /**
   * Reroll ONE goon in the preview (§1: per-goon REROLL and DELETE icons).
   *
   * The goon is re-planned alone, on a fresh sub-seed, and dropped back into its slot — so rerolling
   * the third goon leaves the other five exactly as they were. Re-planning the whole squad would
   * have been one line shorter and would have silently rerolled everybody.
   */
  static async _onRerollOne(event, target) {
    const i = Number(target?.dataset?.index);
    if (!Number.isFinite(i) || !this.preview?.[i]) return;
    const dest = this.destination.mode === "existing" ? game.folders?.get(this.destination.folderId) : null;
    const one = await planGoonSquad({
      ...this._planOpts(), count: 1, seed: `${this.seed}:${i}:${Math.random().toString(36).slice(2, 6)}`,
      destinationFolder: dest ?? findGoonLocker(),
    });
    if (one?.[0]) {
      // Keep the slot's NAME so the squad's numbering stays contiguous after a reroll.
      one[0].bp.name = this.preview[i].bp.name;
      this.preview[i] = one[0];
    }
    this.render();
  }

  static async _onDeleteOne(event, target) {
    const i = Number(target?.dataset?.index);
    if (!Number.isFinite(i) || !this.preview?.[i]) return;
    this.preview.splice(i, 1);
    if (!this.preview.length) this.preview = null;
    this.render();
  }
}

/**
 * The entry point: a GM-only button in the Actors directory header, beside the IP Tracker's.
 *
 * Mirrors that button exactly — the same GM guard, the same idempotent class check so a re-render
 * cannot stack two of them, the same `header.prepend`, and the same whole-body try/catch so a DOM
 * change in a future core costs the button and not the directory.
 */
export function registerNpcGenHooks() {
  registerGoonCountMemory();          // R4's per-user store, registered with the feature that writes it
  Hooks.on("renderActorDirectory", (app, html) => injectNpcGenButton(html));
  // ⚠ CATCH-UP, NOT REDUNDANCY: core paints the sidebar BEFORE module ready fires, so on a fresh page
  // load the hook above has already missed the directory's first render — the button then existed only
  // after something ELSE re-rendered the directory (field case 2026-08-25: absent on the live world
  // until a forced render summoned it). One injection into the already-rendered directory closes the
  // gap; the in-DOM class check keeps hook + catch-up idempotent in either arrival order.
  try { if (ui.actors?.rendered) injectNpcGenButton(ui.actors.element); } catch { /* non-fatal */ }
}

/** Put the button into one rendered directory DOM (jQuery or HTMLElement). Every guard lives here so
 *  the hook path and the ready-time catch-up meet identical gates. */
function injectNpcGenButton(html) {
  try {
    if (!game.user?.isGM || !npcGenEnabled()) return;
    const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
    if (!root?.querySelector || root.querySelector(".cp2020ae-npcgen-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cp2020ae-npcgen-btn";
    btn.innerHTML = `<i class="fas fa-users-gear"></i> ${game.i18n.localize("CYBERPUNK.GoonFactory.Button")}`;
    btn.addEventListener("click", () => openNpcGenerator());
    const header = root.querySelector(".directory-header") ?? root.querySelector(".header-actions") ?? root.firstElementChild ?? root;
    header.prepend(btn);
  } catch (e) { /* non-fatal */ }
}

/** Open (or focus) the single generator window. GM-only and setting-gated, checked here as well as
 *  at the button, so a macro or a console call meets the same two gates the button does. */
export function openNpcGenerator() {
  if (!game.user?.isGM) { ui.notifications?.warn(localize("GoonFactory.GmOnly")); return null; }
  if (!npcGenEnabled()) { ui.notifications?.warn(localize("GoonFactory.Disabled")); return null; }
  const existing = [...foundry.applications.instances.values()].find((w) => w instanceof NpcGeneratorApp);
  if (existing) { existing.render({ force: true }); try { existing.bringToFront?.(); } catch { /* not ready */ } return existing; }
  const app = new NpcGeneratorApp();
  app.render({ force: true });
  return app;
}
