import { openControlRollDialog } from "../vehicle/vehicle-control.js";
import { openVehicleDamageDialog, acpaResolveMode } from "../vehicle/vehicle-damage.js";
import { openVehicleFireDialog } from "../vehicle/vehicle-weapons.js";
import { openAcpaMeleeDialog, repairAcpa } from "../vehicle/vehicle-acpa-combat.js";
import { REALITY_INTERFACES, REFLEX_CONTROLS } from "../vehicle/vehicle-acpa.js";
import { COUNTERMEASURES } from "../vehicle/vehicle-missiles.js";
import { acpaSystemsSummary, acpaAreaSpaces, acpaSpacesOver, acpaBuildIssues } from "../vehicle/vehicle-acpa-systems.js";
import { effectiveVehicleRuleSystem, mmEnabled } from "../settings.js";
import { localize, localizeParam } from "../utils.js";
import { normalizeVehicleType } from "../vehicle/vehicle-deploy-request.js";
import { occupancyAcrossScenes } from "../vehicle/vehicle-occupancy.js";
import { FRONTS, resolveFront, coverSpFor, layoutFor, cycleCell, formatCells } from "../vehicle/vehicle-layout.js";
import { disembark } from "../vehicle/vehicle-canvas.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Vehicle / ACPA actor sheet (Phase 1-3) — ApplicationV2 port.
 *
 * Deliberately separate from CyberpunkActorSheet — vehicles have no skills/wound-track/
 * cyberware tabs. Shows a single SP in Core mode and all five facings under Maximum Metal
 * (the vehicleRuleSystem toggle). Derived Armor Value / Body Value are read-only.
 *
 * Template switching: isACPA vehicles render acpa-sheet.hbs; plain vehicles render
 * vehicle-sheet.hbs.  Both use the same data shape and the same sheet class — only the
 * template differs.  _configureRenderOptions() records the desired template on a private
 * instance field, and _renderHTML() reads it to override PARTS for that render cycle.
 *
 * There is no "Deploy to Canvas" button: a vehicle is placed by dragging the actor onto the
 * canvas like any other actor. The prototype-token defaults (see vehicle-canvas.js preCreateActor)
 * make that drag produce a correctly sized, low-sorted, art-fitted, vehicle-flagged token.
 */
export class CyberpunkVehicleSheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ActorSheetV2) {

  static DEFAULT_OPTIONS = {
    classes: ["cyberpunk", "sheet", "actor", "vehicle"],
    position: { width: 600, height: 780 },
    window: { resizable: true },
    tag: "form",
    form: {
      submitOnChange: true,
      closeOnSubmit:  false,
    },
    // Drag-drop: declare a handler so ActorSheetV2 wires the dragover/drop events onto
    // this.element. The inherited _onDropItem (DocumentSheetV2) creates embedded items of
    // the dropped type — exactly what vehicleWeapon and acpaSystem drops need.
    dragDrop: [{ dropSelector: null }],
    actions: {
      controlRoll:      CyberpunkVehicleSheet._onControlRoll,
      vehicleDamage:    CyberpunkVehicleSheet._onVehicleDamage,
      acpaMelee:        CyberpunkVehicleSheet._onAcpaMelee,
      acpaRepair:       CyberpunkVehicleSheet._onAcpaRepair,
      reactiveReplace:  CyberpunkVehicleSheet._onReactiveReplace,
      weaponAdd:        CyberpunkVehicleSheet._onWeaponAdd,
      weaponEdit:       CyberpunkVehicleSheet._onWeaponEdit,
      weaponDelete:     CyberpunkVehicleSheet._onWeaponDelete,
      weaponFire:       CyberpunkVehicleSheet._onWeaponFire,
      acpaSystemAdd:    CyberpunkVehicleSheet._onAcpaSystemAdd,
      acpaSystemEdit:   CyberpunkVehicleSheet._onAcpaSystemEdit,
      acpaSystemDelete: CyberpunkVehicleSheet._onAcpaSystemDelete,
      occupantDisembark: CyberpunkVehicleSheet._onOccupantDisembark,
      layoutFront:      CyberpunkVehicleSheet._onLayoutFront,
      layoutCell:       CyberpunkVehicleSheet._onLayoutCell,
      layoutReset:      CyberpunkVehicleSheet._onLayoutReset,
    },
  };

  /**
   * Base PARTS declaration. The template path is overridden per-render in _renderHTML()
   * based on actor.system.isACPA so two open instances (one ACPA + one vehicle) never race.
   */
  // One fixed part: a wrapper template that conditionally includes the vehicle OR ACPA layout
  // (Handlebars partials) based on system.isACPA. Reliable per-instance — no runtime PARTS
  // mutation (which V2 does not honour per render).
  static PARTS = {
    // scrollable = the in-part scroll container V2 saves/restores across re-renders (submitOnChange
    // re-renders this sheet on every field edit). The paired CSS establishes the height chain that
    // makes `.sheet-body` the bounded scroller — without it the tall ACPA/vehicle sheet is clipped
    // at the window edge with no scrollbar. Mirrors the character sheet's PARTS.main. See css scroll fix.
    main: { template: "modules/cp2020-augmented/templates/actor/vehicle-sheet-wrapper.hbs", scrollable: [".sheet-body"] },
  };

  /** @override */
  async _prepareContext(options) {
    const actor   = this.actor;
    const system  = actor.system;
    const owner   = actor.isOwner;
    const editable = this.isEditable;

    let rule = "Core";
    try { rule = effectiveVehicleRuleSystem(); } catch (e) { /* settings not ready */ }
    const isMM = rule === "MaximumMetal";
    let mmOn = false;
    try { mmOn = mmEnabled(); } catch (e) { /* settings not ready */ }
    let controlEnabled = true;
    try { controlEnabled = game.settings.get("cp2020-augmented", "vehicleControlEnabled"); } catch (e) { /* default */ }
    let damageEnabled = true;
    try { damageEnabled = game.settings.get("cp2020-augmented", "vehicleDamageEnabled"); } catch (e) { /* default */ }

    // Reactive Armor wear (MM p.23): the deflection roll drops 1 per two absorbed shaped/HE hits.
    const rHits = Number(system?.reactiveHits) || 0;
    const reactiveWear = Math.floor(rHits / 2);
    const oneReactiveHit = rHits === 1;

    // "acpa" is intentionally NOT a vehicle type — Powered Armor is marked by the ACPA checkbox
    // (system.isACPA), which is what the data model + resolver key on.
    const vehicleTypes = ["car", "sportscar", "limo", "AV-4", "AV-6", "AV-7", "cycle", "truck", "rotor", "osprey", "boat", "tank", "APC"];

    // Weapons are embedded vehicleWeapon Items (Phase 5b).
    const weapons = (actor.itemTypes?.["cp2020-augmented.vehicleWeapon"] ?? actor.items.filter(i => i.type === "cp2020-augmented.vehicleWeapon"))
      .map(i => ({ id: i.id, name: i.name, img: i.img, system: i.system }));

    // Countermeasures loadout (MM p.9-10): which CMs the vehicle/ACPA carries. The incoming-missile
    // reader (vehicle-missile-flight.js) picks the best +Difficulty a CARRIED CM imposes on the
    // missile's homing method. Single source of truth = COUNTERMEASURES (vehicle-missiles.js).
    const carriedCMs = Array.isArray(system?.countermeasures) ? system.countermeasures : [];
    const HOMING_KEY = { radar: "Vehicle.HomingRadar", thermal: "Vehicle.HomingThermal", optical: "Vehicle.HomingOptical", laser: "Laser" };
    const loc = (k, d) => { try { return game.i18n.has("CYBERPUNK." + k) ? game.i18n.localize("CYBERPUNK." + k) : d; } catch (e) { return d; } };
    const countermeasureOptions = COUNTERMEASURES.map(cm => ({
      key: cm.key,
      label: loc("Vehicle.CM_" + cm.key, cm.key),
      defeats: cm.defeats.map(m => loc(HOMING_KEY[m] || m, m)).join(", "),
      checked: carriedCMs.includes(cm.key),
    }));

    // ACPA build dropdowns (Reality Interface + Reflex/Control). Labels show the key stats inline.
    const realityInterfaceChoices = Object.values(REALITY_INTERFACES)
      .map(r => ({ key: r.key, label: `${r.label} (SIB ${r.sib >= 0 ? "+" : ""}${r.sib} / DFB ${r.dfb >= 0 ? "+" : ""}${r.dfb})` }));
    const reflexControlChoices = Object.values(REFLEX_CONTROLS)
      .map(r => ({ key: r.key, label: `${r.label} (REF ${r.refMod >= 0 ? "+" : ""}${r.refMod}, max ${r.maxRef})` }));

    // ACPA pilot link (polish #3): choose a character actor whose REF drives the suit.
    let pilotChoices = [];
    let linkedPilotName = "";
    let linkedPilotRef = null;
    try {
      const linkedPilot = system?.pilotId ? game.actors?.get(system.pilotId) : null;
      // Owned-only: a GM owns every actor (sees all); a player sees only their own character(s) — so the
      // menu never exposes GM-only NPCs. GUARD: always keep the currently-linked pilot in the list so it
      // still renders as the selected option even when the viewer doesn't own it. (Masking that pilot's
      // displayed NAME for non-owners is the separate hidden-pilot decision — see the sheet's pilot display.)
      pilotChoices = (game.actors?.filter(a => a.type === "character" && (a.isOwner || a.id === system?.pilotId)) ?? [])
        .map(a => ({ id: a.id, name: a.name }));
      linkedPilotName = linkedPilot?.name ?? "";
      linkedPilotRef = linkedPilot ? (Number(linkedPilot.system?.stats?.ref?.total) || 0) : null;
    } catch (e) { /* defaults above */ }

    // ACPA non-weapon systems = embedded acpaSystem Items (D-4d). List + per-area spaces budget.
    const sysItems = (actor.itemTypes?.["cp2020-augmented.acpaSystem"] ?? actor.items.filter(i => i.type === "cp2020-augmented.acpaSystem"));
    const acpaSystems = sysItems.map(i => ({ id: i.id, name: i.name, img: i.img, system: i.system }));
    let acpaSpaceRows = [];
    let acpaSystemsCost = 0;
    let acpaBuildIssuesArr = [];
    let acpaBuildValid = true;
    try {
      const mounted = sysItems.map(i => ({
        key: i.system?.catalogKey, area: i.system?.area, mount: i.system?.mount,
        spaces: i.system?.spaces, weight: i.system?.weight, cost: i.system?.cost
      }));
      const summary = acpaSystemsSummary(mounted);
      const avail = acpaAreaSpaces(Number(system?.str) || 0);
      acpaSpaceRows = [["head", "Head"], ["torso", "Torso"], ["rArm", "R.Arm"], ["lArm", "L.Arm"], ["rLeg", "R.Leg"], ["lLeg", "L.Leg"]]
        .map(([k, label]) => ({
          label,
          usedInt: summary.byArea[k].internal, availInt: avail[k].internal, overInt: summary.byArea[k].internal > avail[k].internal,
          usedExt: summary.byArea[k].external, availExt: avail[k].external, overExt: summary.byArea[k].external > avail[k].external,
        }));
      acpaSystemsCost = summary.totalCost;

      // Build validation (D-5): SP ≤ 2×STR, weight ≤ chassis capacity, per-area space budgets.
      const str = Number(system?.str) || 0;
      const issues = acpaBuildIssues({
        str,
        armorSP: Number(system?.sp?.front) || 0,
        totalWeight: Number(system?.totalWeight) || 0,
        chassisCapacity: Number(system?.lift) || 0,   // derived Lift/Capacity
        spacesOver: acpaSpacesOver(mounted, str),
      });
      acpaBuildIssuesArr = issues;
      acpaBuildValid = issues.length === 0;
    } catch (e) { /* defaults above */ }

    // Map layout (L1): the Front picker's four buttons, with the live heading lit. Built here rather
    // than in the template because the ACTIVE one depends on the derived default when nothing is
    // stored — the same resolveFront the seating and cover code calls, so the sheet can never show a
    // different heading from the one the mechanics use.
    const layout = this._cpLayoutContext(system);

    // Effective ACPA combat pole for display (Unit D): the stored override, else the pilot-based default.
    const acpaModeEffective = system?.isACPA ? acpaResolveMode(system) : null;
    // Ready-made localized label for the read-only "Active model" field (avoids concat/capitalize helpers
    // that may not be registered). localize() prepends the shared "CYBERPUNK." namespace (utils.js).
    const _modeLabelKey = acpaModeEffective
      ? ("Vehicle.AcpaMode" + (acpaModeEffective === "quickkill" ? "QuickKill" : "Detailed"))
      : null;
    const acpaModeEffectiveLabel = _modeLabelKey ? localize(_modeLabelKey) : "";

    return {
      actor,
      system,
      owner,
      editable,
      ruleSystem: rule,
      ruleSystemLabel: localize(isMM ? "Vehicle.RulesetNameMM" : "Vehicle.RulesetNameCore"),
      isMM,
      mmOn,
      // ── Civilian (item-mirror) sheet context — unified-sheet plan Phase 2. The civilian layout
      // renders unless the vehicle is ACPA or designated an MM combat vehicle under the MM gate.
      useCivilianSheet: !system.isACPA && !(system.isMMVehicle && mmOn),
      // Unit conversion hints (mirror of the item sheet's veh context; 1 mi = 1.609 km).
      speedAltMax: system.speedUnit === "kph" ? Math.round((Number(system.topSpeed) || 0) / 1.609)
                                              : Math.round((Number(system.topSpeed) || 0) * 1.609),
      speedAltUnit: system.speedUnit === "kph" ? "mph" : "kph",
      rangeAlt: system.rangeUnit === "km" ? Math.round((Number(system.range) || 0) / 1.609)
                                          : Math.round((Number(system.range) || 0) * 1.609),
      rangeAltUnit: system.rangeUnit === "km" ? "mi" : "km",
      showFuel: !!(Number(system.fuel?.max) || Number(system.fuel?.value) || system.fuel?.type),
      // Honest handling label: the subtype has no modeled ruleset (submarine/spacecraft/exotics).
      unmodeledSubtype: !!system.vehicleTypeText && !normalizeVehicleType(system.vehicleTypeText).modeled,
      // Provenance line back to the source item (flags-only link — rename-proof).
      sourceItemLine: (() => {
        const uuid = actor.flags?.["cp2020-augmented"]?.sourceItemUuid;
        if (!uuid) return "";
        try {
          const item = fromUuidSync(uuid);
          if (!item) return "";
          const ownerName = item.parent?.name;
          return ownerName
            ? localizeParam("VehicleSourceItemOwned", { item: item.name, owner: ownerName })
            : localizeParam("VehicleSourceItem", { item: item.name });
        } catch (e) { return ""; }
      })(),
      // Who is riding, live (user ruling: the passengers section states N of max and names them,
      // with a way to put each one back on the ground). Read across scenes so a sheet opened from
      // the sidebar answers the same as the canvas.
      occupancy: { ...occupancyAcrossScenes(actor), canManage: game.user?.isGM === true || owner },
      layout,
      controlEnabled,
      damageEnabled,
      reactiveWear,
      oneReactiveHit,
      vehicleTypes,
      weapons,
      realityInterfaceChoices,
      reflexControlChoices,
      pilotChoices,
      linkedPilotName,
      linkedPilotRef,
      // ACPA combat pole (Unit D): stored value + effective mode + its localized label.
      acpaCombatModel: system?.acpaCombatModel ?? "",
      acpaModeEffective,
      acpaModeEffectiveLabel,
      acpaSystems,
      acpaSpaceRows,
      acpaSystemsCost,
      acpaBuildIssues: acpaBuildIssuesArr,
      acpaBuildValid,
      countermeasureOptions,
      // The operating-REF cap override input is a GM adjudication control (the interlocked-cyborg
      // exception) — rendered for the GM only.
      userIsGM: game.user?.isGM === true,
    };
  }

  /**
   * The Front picker's render data. `front` is the heading in force (stored, else derived from the
   * footprint), and each option carries its own arrow icon + localized compass name so the template
   * stays a plain {{#each}} and no bare string is built in JS.
   */
  _cpLayoutContext(system) {
    const w = Number(this.actor.prototypeToken?.width) || 1;
    const h = Number(this.actor.prototypeToken?.height) || 1;
    const front = resolveFront(system?.layout?.front, w, h);
    const ICONS = { n: "fa-solid fa-arrow-up", e: "fa-solid fa-arrow-right", s: "fa-solid fa-arrow-down", w: "fa-solid fa-arrow-left" };
    const KEYS = { n: "Vehicle.FrontNorth", e: "Vehicle.FrontEast", s: "Vehicle.FrontSouth", w: "Vehicle.FrontWest" };
    // Cover SP: the numbers in play (type prefill unless overridden) drive the PLACEHOLDERS, while
    // the inputs carry only what is actually stored. An untouched field therefore stays empty and
    // keeps deriving — including when the GM later changes the vehicle's type.
    const cover = coverSpFor(system);
    const storedSp = (v) => (typeof v === "number" && Number.isFinite(v)) ? v : "";
    // The paint grid, as rows of cells. An unpainted vehicle shows its DERIVED roles, so the grid
    // opens on what the vehicle is already doing rather than a blank slate — and the first click
    // materializes that same layout with one cell changed.
    const resolved = layoutFor(w, h, system?.layout?.front, system?.layout?.cells);
    const ROLE = {
      ".": { role: "body", icon: "", key: "Vehicle.CellBody" },
      "S": { role: "seat", icon: "fa-solid fa-user", key: "Vehicle.CellSeat" },
      "E": { role: "engine", icon: "fa-solid fa-gear", key: "Vehicle.CellEngine" },
    };
    const grid = [];
    for (let row = 0; row < h; row++) {
      const cells = [];
      for (let col = 0; col < w; col++) {
        const index = row * w + col;
        const spec = ROLE[resolved.cells[index]] ?? ROLE["."];
        cells.push({ index, role: spec.role, icon: spec.icon, title: localize(spec.key) });
      }
      grid.push(cells);
    }
    return {
      front,
      grid,
      painted: resolved.painted,
      providesCover: cover.providesCover,
      bodySp: cover.bodySp,
      engineSp: cover.engineSp,
      bodySpStored: storedSp(system?.layout?.bodySp),
      engineSpStored: storedSp(system?.layout?.engineSp),
      // "" in storage means the heading is still the footprint-derived default — worth knowing when
      // reading a sheet, and the Reset path in the paint grid returns to exactly this state.
      frontStored: String(system?.layout?.front ?? ""),
      frontOptions: FRONTS.map(key => ({
        key, icon: ICONS[key], label: localize(KEYS[key]), active: key === front,
      })),
    };
  }

  /** @override — wire the countermeasures loadout after the base render. */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this._cpActivateCountermeasures(this.element);
    this._cpActivateAcpaMode(this.element);
    this._cpActivateCivilianControls(this.element);
  }

  /**
   * Civilian-sheet controls: the +/− speed buttons (accelerate by acc, brake by dec — falling
   * back to acc when no deceleration is recorded — clamped to [0, topSpeed]) and the provenance
   * link back to the source item. Delegated on the persistent root, bound once.
   */
  _cpActivateCivilianControls(root) {
    if (!root || root.dataset.cpCivBound === "1") return;
    root.dataset.cpCivBound = "1";
    root.addEventListener("click", async (ev) => {
      const src = ev.target?.closest?.(".cp-veh-source");
      if (src && root.contains(src)) {
        ev.preventDefault();
        const uuid = this.actor.flags?.["cp2020-augmented"]?.sourceItemUuid;
        const item = uuid ? await fromUuid(uuid) : null;
        item?.sheet?.render(true);
        return;
      }
      const control = ev.target?.closest?.(".field.accel, .field.decel");
      if (!control || !root.contains(control) || !this.isEditable) return;
      ev.preventDefault();
      const sys = this.actor.system;
      const acc = Number(sys.acc) || 0;
      const dec = Number(sys.dec) || acc;
      const cur = Number(sys.speedValue) || 0;
      const top = Number(sys.topSpeed) || cur;
      const next = control.classList.contains("decel") ? Math.max(0, cur - dec) : Math.min(top, cur + acc);
      await this.actor.update({ "system.speedValue": next });
    });
  }

  /**
   * Countermeasures loadout: a change on any CM checkbox rewrites the WHOLE system.countermeasures
   * array from the currently-checked boxes (so deselecting them all clears it — a bare multi-select
   * can't). Delegated on the sheet root (which persists across V2 re-renders, unlike the replaced
   * inner content) and bound once. `stopPropagation` keeps the form's submitOnChange from also firing.
   */
  _cpActivateCountermeasures(root) {
    if (!root || root.dataset.cpCmBound === "1") return;
    root.dataset.cpCmBound = "1";
    root.addEventListener("change", async (ev) => {
      const box = ev.target?.closest?.("input.cp-cm-box");
      if (!box) return;
      ev.stopPropagation();
      if (!this.isEditable) return;
      const selected = [...root.querySelectorAll("input.cp-cm-box:checked")].map(b => b.dataset.cm).filter(Boolean);
      await this.actor.update({ "system.countermeasures": selected });
    });
  }

  /**
   * ACPA combat-mode select (Unit D). Only the GM changes it. Flipping the pole on a suit that is
   * damaged or in an active combat can leave inconsistent damage tracking (the two poles record
   * damage in different fields), so confirm first; on cancel, re-render to revert the select.
   */
  _cpActivateAcpaMode(root) {
    if (!root || root.dataset.cpAcpaModeBound === "1") return;
    root.dataset.cpAcpaModeBound = "1";
    // CAPTURE phase (the `true`): this listener must run BEFORE ApplicationV2's bubble-phase
    // submitOnChange handler on the same form, so stopPropagation() actually suppresses the auto-write
    // for this NAMED <select>. A bubble-phase listener fires too late — submitOnChange writes `next`
    // first and the confirm/cancel can no longer control the value (the confirm becomes cosmetic).
    root.addEventListener("change", async (ev) => {
      const sel = ev.target?.closest?.("select[name='system.acpaCombatModel']");
      if (!sel) return;
      ev.stopPropagation();                              // suppress the form's submitOnChange (capture → it hasn't fired yet)
      if (!game.user?.isGM || !this.isEditable) { this.render(false); return; }
      const next = sel.value;
      const prev = this.actor.system?.acpaCombatModel ?? "";
      if (next === prev) return;
      if (this._acpaSuitAtRisk()) {
        const ok = await foundry.applications.api.DialogV2.confirm({
          window: { title: localize("Vehicle.AcpaModeChangeTitle") },
          content: `<p>${localize("Vehicle.AcpaModeChangeWarn")}</p>`,
          rejectClose: false, modal: true,
        });
        if (!ok) { this.render(false); return; }         // cancel: nothing was written (capture suppressed it) — just revert the DOM select
      }
      await this.actor.update({ "system.acpaCombatModel": next });
    }, true);
  }

  /** True when the suit shows combat damage or is in an active combat (mode-flip guardrail). */
  _acpaSuitAtRisk() {
    const s = this.actor.system ?? {};
    const damaged = (Number(s.strDamage) || 0) > 0 || (Number(s.refDamage) || 0) > 0
      || (Array.isArray(s.damagedSystems) && s.damagedSystems.length > 0)
      || s.destroyed === true || s.immobilized === true;
    const inCombat = !!game.combat && (game.combat.combatants?.some(c => c.actorId === this.actor.id || (s.pilotId && c.actorId === s.pilotId)) ?? false);
    return damaged || inCombat;
  }

  // ── Action handlers (static; V2 binds `this` to the sheet instance) ─────

  static _onControlRoll(event, _target) {
    event.preventDefault();
    openControlRollDialog(this.actor);
  }

  /** Put one named rider back on the ground, from the vehicle's own passengers list. */
  static async _onOccupantDisembark(event, target) {
    event.preventDefault();
    const scene = game.scenes.get(target?.dataset?.sceneId);
    const tokenDoc = scene?.tokens?.get(target?.dataset?.tokenId);
    if (!tokenDoc) return;
    await disembark(tokenDoc);
    this.render(false);
  }

  /**
   * Point the vehicle's nose. Writes the one dotted key (the schema's nested SchemaField merges it
   * per key), which the canvas hook picks up to re-seat anyone already aboard. A click always SETS
   * a heading — the un-set "derive from the footprint" state is where a vehicle starts, not
   * somewhere a picker click should drop it by surprise.
   */
  static async _onLayoutFront(event, target) {
    event.preventDefault();
    if (!this.isEditable) return;
    const next = String(target?.dataset?.front ?? "");
    if (!FRONTS.includes(next)) return;
    if (next === String(this.actor.system?.layout?.front ?? "")) return;
    await this.actor.update({ "system.layout.front": next });
  }

  /**
   * Paint one footprint cell: body → seat → engine → body. The write is the WHOLE string, built
   * from the layout currently in force — so the first click on an unpainted vehicle materializes
   * its derived layout with exactly one cell changed, and the GM never starts from a blank grid.
   */
  static async _onLayoutCell(event, target) {
    event.preventDefault();
    if (!this.isEditable) return;
    const index = Number(target?.dataset?.index);
    if (!Number.isInteger(index) || index < 0) return;
    const w = Number(this.actor.prototypeToken?.width) || 1;
    const h = Number(this.actor.prototypeToken?.height) || 1;
    const layout = this.actor.system?.layout ?? {};
    const cells = [...layoutFor(w, h, layout.front, layout.cells).cells];
    if (index >= cells.length) return;
    cells[index] = cycleCell(cells[index]);
    await this.actor.update({ "system.layout.cells": formatCells(cells) });
  }

  /**
   * Back to the defaults: drop the painted grid AND the picked heading, so the vehicle derives both
   * from its footprint again. Clearing the grid alone would leave a vehicle half-overridden, which
   * is harder to reason about than either end state.
   */
  static async _onLayoutReset(event, _target) {
    event.preventDefault();
    if (!this.isEditable) return;
    await this.actor.update({ "system.layout.cells": "", "system.layout.front": "" });
  }

  static _onVehicleDamage(event, _target) {
    event.preventDefault();
    openVehicleDamageDialog(this.actor);
  }

  static _onAcpaMelee(event, _target) {
    event.preventDefault();
    openAcpaMeleeDialog(this.actor);
  }

  static _onAcpaRepair(event, _target) {
    event.preventDefault();
    repairAcpa(this.actor);
  }

  static async _onReactiveReplace(event, _target) {
    event.preventDefault();
    await this.actor.update({ "system.reactiveHits": 0 });
  }

  // ── Weapon mount actions ─────────────────────────────────────────────────

  static async _onWeaponAdd(event, _target) {
    event.preventDefault();
    await this.actor.createEmbeddedDocuments("Item", [{ name: "New Weapon", type: "cp2020-augmented.vehicleWeapon" }]);
  }

  static _onWeaponEdit(event, target) {
    event.preventDefault();
    this.actor.items.get(target.dataset.weaponId)?.sheet?.render(true);
  }

  static async _onWeaponDelete(event, target) {
    event.preventDefault();
    const w = this.actor.items.get(target.dataset.weaponId);
    if (w) await w.delete();
  }

  static _onWeaponFire(event, target) {
    event.preventDefault();
    const w = this.actor.items.get(target.dataset.weaponId);
    if (!w) return;
    // Adapter to the Phase-5 fire dialog shape; firing is reworked around the Item in 5c/5d.
    openVehicleFireDialog(this.actor, {
      name: w.name, penetration: Number(w.system?.penetration) || 0,
      rof: Number(w.system?.rof) || 1, arc: w.system?.arc || "turret", itemId: w.id
    });
  }

  // ── ACPA non-weapon system actions ───────────────────────────────────────

  static async _onAcpaSystemAdd(event, _target) {
    event.preventDefault();
    // Seed a sane, editable default SDP so a freshly added system has real integrity (a 0-SDP system is
    // now overrun immediately rather than absorbing forever — see acpaHitSystem — but 0 is still a poor default).
    await this.actor.createEmbeddedDocuments("Item", [{ name: "New System", type: "cp2020-augmented.acpaSystem", system: { sdp: 10 } }]);
  }

  static _onAcpaSystemEdit(event, target) {
    event.preventDefault();
    this.actor.items.get(target.dataset.systemId)?.sheet?.render(true);
  }

  static async _onAcpaSystemDelete(event, target) {
    event.preventDefault();
    const s = this.actor.items.get(target.dataset.systemId);
    if (s) await s.delete();
  }
}
