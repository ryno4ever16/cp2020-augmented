/**
 * GOON FACTORY — THE WINDOW (GOON-FACTORY-SPEC.md §1).
 *
 * ApplicationV2 + Handlebars, mirroring `dialog/preset-picker.js`'s shape (static DEFAULT_OPTIONS
 * with an `actions` table, static PARTS, `_prepareContext`) so a maintainer who has read one of this
 * module's V2 windows has read this one.
 *
 * ⛔⛔ THE QUICK/FULL SPLIT IS GONE. It was two renderings of one machine, and §0's simplicity
 * invariant replaced it with something stronger: ONE form whose quick path is
 * **Outfit-or-(Role+Grade) → Generate**, with every dial Advanced-gated behind a checkbox that is
 * itself disabled until a grade is picked. There is no mode state on this class and there must not
 * be one again.
 *
 * ⭐ THE WINDOW COMPUTES NOTHING ABOUT A GOON. It reads the form, calls the pure `resolveGoonConfig`
 * / `goonBlueprint`, and hands the plan to `goon-factory.js`. That is the pure/impure boundary this
 * feature is built on, and it is why the preview and the created actor cannot disagree: they are the
 * same plan object. Every honesty line rendered below was produced by the PLAN — this file only
 * localizes it.
 */

import { resolveGoonConfig } from "./blueprint.js";
import {
  ARMAMENT_POSTURES, ARMOR_HARDNESS_FILTERS, ARMOR_WEIGHT_FILTERS, BT_TICKS, BT_RANGE, COUNT,
  GENERATOR_ROLES, GRADE_KEYS, GRADES, LOOT_DIAL, LOOT_LABEL_KEYS, REF_RANGE, STAT_POOL,
  STAT_SHAPES, STAT_SHAPE_LABEL_KEYS, clampCount,
} from "./grades.js";
import { OUTFIT_SEEDS } from "./outfits.js";
import {
  GOON_MAX_COUNT, findGoonLocker, goonLockerName, materializeGoonSquad, planGoonSquad,
} from "./goon-factory.js";
import { catalogIndexReady, getCatalogIndex } from "../shop/catalog.js";
import { localize, localizeParam, tryLocalize } from "../utils.js";
import { npcGenEnabled } from "../settings.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** A fresh root seed. §1 retired the visible-seed UI; the seed is INTERNAL and per-goon now. */
function freshSeed() { return Math.random().toString(36).slice(2, 10); }

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
    this.role = GENERATOR_ROLES[0];
    this.grade = null;              // ⛔ null is a REAL state — §1's threat level starts as dashes
    this.count = COUNT.default;
    this.advanced = false;
    this.overrides = {};            // only what the GM has actually moved; empty = pure derivation
    this.seed = freshSeed();
    this.preview = null;            // [planRow] — set by Generate, cleared by any control change
    this.destination = { mode: "locker" };
    this._countClamped = false;
    this._indexWait = null;
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
    const outfitLabel = this.outfitId
      ? tryLocalize(OUTFIT_SEEDS.find((o) => o.id === this.outfitId)?.labelKey, this.outfitId)
      : "";
    const basedOnLabel = cfg.custom && this.outfitId
      ? localizeParam("GoonFactory.CustomBasedOn", { outfit: outfitLabel })
      : localizeParam("GoonFactory.BasedOn", { outfit: outfitLabel });

    const sel = (arr, cur, labelOf) => arr.map((k) => ({
      key: k, label: labelOf(k), selected: String(k) === String(cur),
    }));

    return {
      ...context,
      catalogLoading: !ready,
      // top
      outfits: OUTFIT_SEEDS.map((o) => ({
        id: o.id, label: tryLocalize(o.labelKey, o.id), seed: !!o.seed, selected: o.id === this.outfitId,
      })),
      outfitId: this.outfitId,
      basedOnLabel,
      // header band
      roles: GENERATOR_ROLES.map((r) => ({
        key: r, label: tryLocalize(`GoonFactory.Role.${r}`, r), selected: r === cfg.role,
      })),
      grades: GRADE_KEYS.map((k) => ({
        key: k, label: tryLocalize(GRADES[k].labelKey, k),
        hint: tryLocalize(GRADES[k].hintKey, ""), selected: k === cfg.grade,
      })),
      grade: cfg.grade,
      count: this.count,
      maxCount: GOON_MAX_COUNT,
      countClamped: this._countClamped,
      advanced: this.advanced,
      advancedAvailable: cfg.advancedAvailable,
      // below the line
      ref: cfg.ref, bt: cfg.bt, refRange: REF_RANGE, btRange: BT_RANGE,
      btTicks: BT_TICKS.map((t) => ({ value: t.value, hint: tryLocalize(t.hintKey, "") })),
      skill: cfg.skillBreakdown ?? { total: 0, reserved: 0, floor: 0 },
      skillBreakdownLine: grade ? localizeParam("GoonFactory.SkillBreakdown", {
        total: cfg.skillBreakdown.total, reserved: cfg.skillBreakdown.reserved,
        grade: cfg.grade, rest: cfg.skillBreakdown.toPackage,
      }) : "",
      pool: cfg.statPoolBreakdown ?? { pool: 0, floor: 0, ceiling: STAT_POOL.ceiling },
      poolTicks: STAT_POOL.ticks.map((t) => ({ value: t.value, hint: tryLocalize(t.hintKey, "") })),
      poolBreakdownLine: grade ? localizeParam("GoonFactory.PoolBreakdown", {
        pool: cfg.statPoolBreakdown.pool, reserved: cfg.statPoolBreakdown.reserved,
        free: cfg.statPoolBreakdown.free,
      }) : "",
      shapes: sel(STAT_SHAPES, cfg.statShape, (k) => tryLocalize(STAT_SHAPE_LABEL_KEYS[k], k)),
      luckFormula: cfg.luckFormula, repFormula: cfg.repFormula,
      chromeOn: cfg.chromeOn, chromeCount: cfg.chromeCount,
      chromeDerivationLine: cfg.chromeDerivation ? localizeParam("GoonFactory.ChromeDerivation", {
        base: cfg.chromeDerivation.base, grade: cfg.grade,
        solo: cfg.chromeDerivation.soloBonus, outfit: cfg.chromeDerivation.outfitMod,
      }) : "",
      garnish: cfg.garnish,
      armorWeights: sel(ARMOR_WEIGHT_FILTERS, cfg.armorWeight, (k) => tryLocalize(`GoonFactory.Weight.${k}`, k)),
      armorHardnesses: sel(ARMOR_HARDNESS_FILTERS, cfg.armorHardness, (k) => tryLocalize(`GoonFactory.Hardness.${k}`, k)),
      armaments: sel(ARMAMENT_POSTURES, cfg.armament, (k) => tryLocalize(`GoonFactory.Armament.${k}`, k)),
      lootDial: sel(LOOT_DIAL, cfg.loot, (k) => tryLocalize(LOOT_LABEL_KEYS[k], k)),
      // preview
      hasPreview: !!this.preview?.length,
      preview: this.preview?.map((row, i) => this._previewCard(row, i)) ?? null,
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
    this.role = val(".cp-goon-role") || this.role;
    const g = val(".cp-goon-grade");
    this.grade = g || null;

    const raw = parseInt(val(".cp-goon-count"), 10);
    const clamped = clampCount(raw);
    this.count = clamped.value;
    this._countClamped = clamped.clamped;

    const destRaw = val(".cp-goon-dest");
    if (destRaw?.startsWith("f:")) this.destination = { mode: "existing", folderId: destRaw.slice(2) };
    else if (destRaw) this.destination = { mode: destRaw };

    // §1: re-picking either the outfit or the threat level RE-DERIVES CLEAN. See the trap above.
    if (this.outfitId !== prevOutfit || this.grade !== prevGrade) {
      this.overrides = {};
      this.preview = null;                          // a re-derived config invalidates a shown preview
      return;
    }

    if (!this.advanced || !this.grade) return;      // locked ⇒ nothing below the line is read

    // The derivation as it stands WITHOUT the current overrides, so "did the GM move this?" is a
    // comparison against the derived value rather than against the last thing we happened to store.
    const derived = resolveGoonConfig({ outfitId: this.outfitId || null, role: this.role, grade: this.grade });
    const ov = {};
    const put = (key, value, derivedValue) => {
      if (value === null || value === undefined || value === "") return;
      if (String(value) === String(derivedValue)) return;                 // untouched ⇒ not an override
      ov[key] = value;
    };
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
  Hooks.on("renderActorDirectory", (app, html) => {
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
  });
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
