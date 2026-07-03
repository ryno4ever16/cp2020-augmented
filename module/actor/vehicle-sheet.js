import { openControlRollDialog } from "../vehicle/vehicle-control.js";
import { openVehicleDamageDialog } from "../vehicle/vehicle-damage.js";
import { openVehicleFireDialog } from "../vehicle/vehicle-weapons.js";
import { openAcpaMeleeDialog, repairAcpa } from "../vehicle/vehicle-acpa-combat.js";
import { REALITY_INTERFACES, REFLEX_CONTROLS } from "../vehicle/vehicle-acpa.js";
import { COUNTERMEASURES } from "../vehicle/vehicle-missiles.js";
import { acpaSystemsSummary, acpaAreaSpaces, acpaSpacesOver, acpaBuildIssues } from "../vehicle/vehicle-acpa-systems.js";
import { effectiveVehicleRuleSystem, mmEnabled } from "../settings.js";

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
    position: { width: 560, height: 560 },
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
    main: { template: "modules/cp2020-augmented/templates/actor/vehicle-sheet-wrapper.hbs" },
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

    return {
      actor,
      system,
      owner,
      editable,
      ruleSystem: rule,
      isMM,
      mmOn,
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
      acpaSystems,
      acpaSpaceRows,
      acpaSystemsCost,
      acpaBuildIssues: acpaBuildIssuesArr,
      acpaBuildValid,
      countermeasureOptions,
    };
  }

  /** @override — wire the countermeasures loadout after the base render. */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this._cpActivateCountermeasures(this.element);
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

  // ── Action handlers (static; V2 binds `this` to the sheet instance) ─────

  static _onControlRoll(event, _target) {
    event.preventDefault();
    openControlRollDialog(this.actor);
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
