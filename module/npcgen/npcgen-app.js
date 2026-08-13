/**
 * NPC GENERATOR — THE WINDOW. ApplicationV2 + Handlebars, mirroring `dialog/preset-picker.js`'s shape
 * (static DEFAULT_OPTIONS with an `actions` table, static PARTS, `_prepareContext`) so a maintainer who
 * has read one of this module's V2 windows has read this one.
 *
 * TWO MODES, both ruled in (design §RULINGS Q0): **QUICK** is the panic case — archetype, tier, how
 * many, Generate, done. **FULL** is the prep case — the four dials individually, a seed you can see and
 * retype, and a preview you fine-tune before anything is written. They are the same machinery with a
 * different amount of it on screen; nothing is quick-only or full-only in the engine.
 *
 * The window itself computes NOTHING about an NPC. It reads the form, calls the pure `npcBlueprint`,
 * and hands the result to `materialize.js`. That is the pure/impure boundary this feature is built on,
 * and it is why the preview and the created actor cannot disagree: they are the same plan object.
 */

import { npcBlueprint } from "./blueprint.js";
import { ARCHETYPES, TIERS, SKILL_DIAL, WEAPONS_DIAL, ARMOR_DIAL, TOUGHNESS_DIAL } from "./tables.js";
import { materializeNpcSquad, planNpcGear, npcGenCatalogRows, NPCGEN_MAX_COUNT } from "./materialize.js";
import { catalogIndexReady, getCatalogIndex } from "../shop/catalog.js";
import { localize, tryLocalize } from "../utils.js";
import { npcGenEnabled } from "../settings.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** A fresh seed for a window that has just opened. A STRING, because `seedFrom` folds strings and a
 *  GM who wants to keep a squad writes this down — a 32-bit integer is a worse thing to copy by hand. */
function freshSeed() {
  return Math.random().toString(36).slice(2, 8);
}

export class NpcGeneratorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this.mode = "quick";                 // quick | full
    this.archetype = Object.keys(ARCHETYPES)[0] ?? "goon";
    this.tier = TIERS[0]?.key ?? "mook";
    this.count = 1;
    this.seed = freshSeed();
    this.dials = { skill: null, weapons: null, armor: null, toughness: null };   // null = follow the tier
    this.preview = null;                 // [{bp, gear}] — set by Preview, cleared by any dial change
    this._indexWait = null;              // the one pending "re-render when the index lands" (design R5)
  }

  static DEFAULT_OPTIONS = {
    id: "cp-npcgen",
    classes: ["cyberpunk", "cp-npcgen-app"],
    window: { title: "CYBERPUNK.NpcGen.Title", icon: "fa-solid fa-users-gear", resizable: true },
    position: { width: 720, height: "auto" },
    actions: {
      npcGenMode: NpcGeneratorApp._onMode,
      npcGenPreview: NpcGeneratorApp._onPreview,
      npcGenReroll: NpcGeneratorApp._onReroll,
      npcGenCreate: NpcGeneratorApp._onCreate,
    },
  };

  static PARTS = {
    main: { template: "modules/cp2020-augmented/templates/npcgen/generator.hbs" },
  };

  /**
   * ⚠ THE CATALOG INDEX IS NOT AWAITED HERE, and that is design §R5 rather than an oversight. The
   * shop's own comment on `catalogIndexReady` says it plainly: awaiting the index *"is what would hold
   * the whole window closed on the first open."* So a not-yet-built index renders a pending panel and
   * `_awaitCatalogIndex` re-renders into the real thing the moment the build lands — the same two-state
   * treatment the shop window uses, for the same measured reason.
   */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const ready = catalogIndexReady();
    if (!ready) this._awaitCatalogIndex();

    const dialRows = (rows, keyOf, labelOf, chosen) => rows.map((r) => ({
      key: keyOf(r), label: labelOf(r), selected: String(keyOf(r)) === String(chosen),
    }));

    return {
      ...context,
      catalogLoading: !ready,
      isQuick: this.mode === "quick",
      isFull: this.mode === "full",
      seed: this.seed,
      count: this.count,
      maxCount: NPCGEN_MAX_COUNT,
      archetypes: Object.values(ARCHETYPES).map((a) => ({
        key: a.key, label: tryLocalize(a.labelKey, a.key),
        selected: a.key === this.archetype, placeholder: !!a.placeholder,
      })),
      // ⛔ The one shipped archetype is scaffolding and the window says so out loud. The real starter
      // set is the user's to supply (design §RULINGS Q2) and a GM should not mistake "Goon" for a
      // curated character type.
      archetypePlaceholder: !!ARCHETYPES[this.archetype]?.placeholder,
      tiers: TIERS.map((t) => ({
        key: t.key, label: tryLocalize(t.labelKey, t.key),
        selected: t.key === this.tier,
        benchmark: `ATK ${t.benchmark.atk} · ${t.benchmark.damage} · SP ${t.benchmark.sp} · BT ${t.benchmark.bt}`,
      })),
      skillDial: dialRows(SKILL_DIAL, (r) => r.key, (r) => tryLocalize(r.labelKey, r.key), this.dials.skill ?? ""),
      weaponsDial: dialRows(WEAPONS_DIAL, (r) => r.rung, (r) => r.prose, this.dials.weapons ?? ""),
      // The armor rung's label is localized from its own key, falling back to the book prose the table
      // carries — the value-is-key pattern, so the shipped table stays i18n-free and unit-testable.
      armorDial: dialRows(ARMOR_DIAL, (r) => r.key, (r) => tryLocalize(r.labelKey, r.prose), this.dials.armor ?? ""),
      toughnessDial: dialRows(TOUGHNESS_DIAL, (r) => r.key, (r) => tryLocalize(r.labelKey, r.key), this.dials.toughness ?? ""),
      preview: this.preview?.map(({ bp, gear }) => ({
        name: bp.name,
        statLine: `INT ${bp.stats.int} · REF ${bp.stats.ref} · TECH ${bp.stats.tech} · CL ${bp.stats.cool} · ATT ${bp.stats.attr} · LK ${bp.stats.luck} · MA ${bp.stats.ma} · BT ${bp.stats.bt} · EMP ${bp.stats.emp}`,
        skills: bp.skillLevels.map((s) => `${s.skillKey} ${s.level}`).join(", "),
        gear: (gear?.slots ?? []).map((s) => s.name),
        chrome: (gear?.chrome ?? []).map((c) => c.name),
        hasChrome: (gear?.chrome ?? []).length > 0,
        seed: bp.seed,
      })) ?? null,
      hasPreview: !!this.preview?.length,
    };
  }

  /** Start (or join) the index build behind the pending panel and re-render once it resolves. Both
   *  guards are the shop's: ONE pending re-render per window however many renders happen while the
   *  build runs, and a `rendered` check so a window closed mid-build re-renders nothing. */
  _awaitCatalogIndex() {
    if (this._indexWait) return;
    this._indexWait = getCatalogIndex().then(
      () => { this._indexWait = null; if (this.rendered) this.render(); },
      (err) => { this._indexWait = null; console.error("cp2020-augmented | npcgen: catalog index build failed", err); },
    );
  }

  /** Read every control back off the form. Called before each Preview/Generate so the window never acts
   *  on a stale copy of what the GM is looking at — the fields are plain inputs, not bound state. */
  _readForm() {
    const root = this.element;
    if (!root) return;
    const val = (sel) => root.querySelector(sel)?.value ?? "";
    this.archetype = val(".cp-npcgen-archetype") || this.archetype;
    this.tier = val(".cp-npcgen-tier") || this.tier;
    const n = parseInt(val(".cp-npcgen-count"), 10);
    this.count = Math.max(1, Math.min(Number.isFinite(n) ? n : 1, NPCGEN_MAX_COUNT));
    const seed = val(".cp-npcgen-seed").trim();
    if (seed) this.seed = seed;
    if (this.mode === "full") {
      const dial = (sel) => { const v = val(sel).trim(); return v === "" ? null : v; };
      this.dials = {
        skill: dial(".cp-npcgen-dial-skill"),
        weapons: dial(".cp-npcgen-dial-weapons") === null ? null : Number(val(".cp-npcgen-dial-weapons")),
        armor: dial(".cp-npcgen-dial-armor"),
        toughness: dial(".cp-npcgen-dial-toughness"),
      };
    }
  }

  /** The dial argument `npcBlueprint` expects: the tier, plus only those dials the GM actually moved.
   *  An untouched dial is ABSENT rather than null, so the tier's own value stands — the dials stay free
   *  (design §B.2) without the window having to know what each tier's defaults are. */
  _dialSpec() {
    const spec = { tier: this.tier };
    if (this.mode !== "full") return spec;
    for (const k of ["skill", "weapons", "armor", "toughness"]) {
      if (this.dials[k] !== null && this.dials[k] !== undefined && this.dials[k] !== "") spec[k] = this.dials[k];
    }
    return spec;
  }

  /** Build the plan for the current form state. Deterministic: the same seed and dials produce the same
   *  squad, which is what makes the preview honest and a rig assertion possible (design Q14). */
  async _buildPlan() {
    const bps = npcBlueprint({
      archetype: this.archetype, dials: this._dialSpec(), count: this.count, seed: this.seed,
    });
    const rows = await npcGenCatalogRows();
    return bps.map((bp) => ({ bp, gear: planNpcGear(bp, rows) }));
  }

  static async _onMode(event, target) {
    this._readForm();
    this.mode = target?.dataset?.mode === "full" ? "full" : "quick";
    this.preview = null;                             // a mode switch changes what is on screen, not what was planned
    this.render();
  }

  static async _onPreview() {
    this._readForm();
    this.preview = await this._buildPlan();
    this.render();
  }

  /** Reroll = a NEW seed and a new preview. ⛔ It writes NOTHING — the whole point of the preview stage
   *  is that a GM can spin it as often as they like before any document exists. */
  static async _onReroll() {
    this._readForm();
    this.seed = freshSeed();
    this.preview = await this._buildPlan();
    this.render();
  }

  /**
   * Create the squad. In QUICK mode there may be no preview yet — the panic case is one click, so the
   * plan is built here rather than demanded first. In FULL mode the preview already IS the plan and is
   * reused verbatim, so what the GM approved is what gets written.
   */
  static async _onCreate() {
    if (!game.user?.isGM) return;
    this._readForm();
    const plan = this.preview ?? await this._buildPlan();
    const made = await materializeNpcSquad(plan.map((p) => p.bp));
    if (made.length) {
      ui.notifications?.info(game.i18n.format("CYBERPUNK.NpcGen.Created", { n: made.length }));
      this.preview = null;
      // The seed advances so a second Generate does not silently rebuild the same squad on top of
      // itself. The GM can always type the old one back — that is what the field is for.
      this.seed = freshSeed();
      this.render();
    }
  }
}

/**
 * The entry point: a GM-only button in the Actors directory header, beside the IP Tracker's.
 *
 * Mirrors that button exactly (`cp2020-augmented.js`'s `renderActorDirectory` hook) — the same GM
 * guard, the same idempotent class check so a re-render cannot stack two of them, the same
 * `header.prepend`, and the same whole-body try/catch so a DOM change in a future core costs the
 * button and not the directory. `reference-tilt-way-patterns.md` §"Tracker / non-chat DOM UI" blesses
 * building this one element in JS, provided it carries a CSS class rather than inline styling and its
 * label is localized — both of which it does.
 *
 * Registered through the ready-time `wire()` isolation in cp2020-augmented.js, so a throw here costs
 * this feature and not the nineteen registrations after it.
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
      btn.innerHTML = `<i class="fas fa-users-gear"></i> ${game.i18n.localize("CYBERPUNK.NpcGen.Button")}`;
      btn.addEventListener("click", () => openNpcGenerator());
      const header = root.querySelector(".directory-header") ?? root.querySelector(".header-actions") ?? root.firstElementChild ?? root;
      header.prepend(btn);
    } catch (e) { /* non-fatal */ }
  });
}

/** Open (or focus) the single generator window. GM-only and setting-gated, checked here as well as at
 *  the button, so a macro or a console call meets the same two gates the button does. */
export function openNpcGenerator() {
  if (!game.user?.isGM) { ui.notifications?.warn(localize("NpcGen.GmOnly")); return null; }
  if (!npcGenEnabled()) { ui.notifications?.warn(localize("NpcGen.Disabled")); return null; }
  const existing = [...foundry.applications.instances.values()].find((w) => w instanceof NpcGeneratorApp);
  if (existing) { existing.render({ force: true }); try { existing.bringToFront?.(); } catch { /* not ready */ } return existing; }
  const app = new NpcGeneratorApp();
  app.render({ force: true });
  return app;
}
