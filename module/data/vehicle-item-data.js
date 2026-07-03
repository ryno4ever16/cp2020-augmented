import {
  arrayField,
  booleanField,
  htmlField,
  mergeDefaults,
  normalizeArray,
  normalizeBoolean,
  numberField,
  objectField,
  stringField
} from "./schema-helpers.js";

/**
 * Item DataModels for the Augmented Edition vehicle/ACPA sub-types
 * (`cp2020-augmented.vehicleWeapon`, `cp2020-augmented.acpaSystem`).
 *
 * These mirror the base system's item-data conventions: a small `commonSchema()` shared by
 * every gear item and a `CyberpunkBaseItemData` base that normalizes the common fields. Only
 * the vehicle/ACPA item types live here — the personnel item types stay system-side.
 */

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function normalizeBooleanIfPresent(source, key, fallback = false) {
  if (hasOwn(source, key)) source[key] = normalizeBoolean(source[key], fallback);
}

function normalizeArrayIfPresent(source, key, fallback = []) {
  if (hasOwn(source, key)) source[key] = normalizeArray(source[key], fallback);
}

/**
 * Renamed the per-item structural fields SOP→SDP (the book's term is Structural Damage Points;
 * "SOP" was an OCR artifact in the Maximum Metal scan). Carry pre-1.0.3 stored values forward.
 */
function migrateSopToSdp(source) {
  if (hasOwn(source, "sop") && !hasOwn(source, "sdp")) source.sdp = source.sop;
  if (hasOwn(source, "sopDamage") && !hasOwn(source, "sdpDamage")) source.sdpDamage = source.sopDamage;
}

function commonSchema() {
  return {
    flavor: stringField(""),
    notes: htmlField(""),
    cost: numberField(0),
    weight: numberField(0),
    equipped: booleanField(true),
    source: stringField(""),
    lastOwnerId: stringField("")
  };
}

class CyberpunkBaseItemData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return commonSchema();
  }

  static migrateData(source) {
    source ??= {};

    if (hasOwn(source, "notes")) source.notes ??= "";
    if (hasOwn(source, "flavor")) source.flavor ??= "";
    if (hasOwn(source, "source")) source.source ??= "";
    normalizeBooleanIfPresent(source, "equipped", true);
    if (source.cost === null) source.cost = 0;
    if (source.weight === null) source.weight = 0;
    if (hasOwn(source, "lastOwnerId")) source.lastOwnerId ??= "";
    return super.migrateData(source);
  }
}

/**
 * Maximum Metal vehicle/ACPA weapon (Phase 5b). A catalogued Item dragged onto a vehicle actor;
 * the vehicle's "mounts" are its embedded vehicleWeapon Items. Fields come straight from the MM
 * stat-block format (SKILL · WA · DAMAGE(PEN) · #SHOTS · ROF · REL · RANGE · BURST), MM p.4/17/19/20/22.
 * Penetration is given DIRECTLY by the book (no derivation). See [[maximum-metal-reference]] §6.
 */
export class CyberpunkVehicleWeaponData extends CyberpunkBaseItemData {
  static defineSchema() {
    return {
      ...commonSchema(),
      // Classification — drives the resolution archetype (MM weapon classes A–H).
      weaponClass: stringField("directFire"),  // directFire|burst|rocket|missile|artillery|bomb|cone|melee|special
      mountType:   stringField("turret"),       // turret|fixed|articulated|open|pintle|pod|juryRigged
      arc:         stringField("turret"),       // turret(360)|front|side|rear — firing arc
      // To-hit.
      wa:          numberField(0),               // Weapon Accuracy modifier
      // Damage scale. MM lists Vehicle Penetration directly; `damage` dice kept for vs-personnel (p.8 alt).
      penetration: numberField(0),
      damage:      stringField(""),
      ap:          booleanField(false),
      heat:        booleanField(false),          // shaped-charge: range-immune; Composite Armor halves Pen
      hiEx:        booleanField(false),          // high-explosive: range-immune
      highDensityAP: booleanField(false),        // errata p.105: full damage through armor like HEAT
      railgun:     booleanField(false),          // errata "Armor Damage via Penetration": SP-erosion factor 0.20, not 0.60 generic AP
      burst:       numberField(0),               // burst radius in meters (0 = none)
      // Rate / ammo.
      rof:         numberField(1),
      rofAlt:      numberField(0),               // variable ROF ("30 OR 5" → rof 30, rofAlt 5; 0 = none)
      shots:       numberField(1),
      shotsLeft:   numberField(1),
      // MM lists weapon weight as "empty / full-magazine" (p.75-78). `weight` (commonSchema) holds the
      // empty weapon; `magWeight` holds a full magazine. Carried weight = weight + magWeight×shotsLeft/shots
      // (no consumer yet — data preserved for a future encumbrance pass). Additive; default 0, no migration.
      magWeight:   numberField(0),
      // Range.
      range:       numberField(0),
      minRange:    numberField(0),               // missiles: 1/10 Long range
      reliability: stringField("VR"),
      // Guided weapons (class D).
      guidance:      stringField("none"),        // none|semiActive|active|paint
      guidanceSkill: numberField(0),             // active missile's own Skill (+15/+20)
      homingMethod:  stringField("radar"),       // radar|thermal|optical|laser (which countermeasures defeat it); "wire" = wire-guided, no onboard CM defeats it (break LOS / kill the operator instead)
      // Cone weapons (class F scatter-packs).
      coneAngle:   numberField(0),               // degrees (60/120/180)
      projectiles: numberField(0),               // munitions launched per volley (ammo/flavour; the "24" in "6x24")
      scatterDice: numberField(0),               // MM p.72: XD6 rolled PER hit target for # munitions that strike (0 = not a scatter-pack)
      // Shell / warhead variants (selected at fire time). Each: {name, pen, burst, ap, heat, hiEx, damage}.
      shellVariants: arrayField(null, []),
      activeShell:   stringField(""),            // selected variant name ("" = base stats)
      // Construction.
      space:       numberField(0),
      // ACPA mounting (Maximum Metal p.95-96): which body area, and the weapon's own SDP so a
      // System Hit can knock out this specific weapon (additive — schema defaults; no migration).
      area:        stringField("torso"),   // head|rArm|lArm|rLeg|lLeg|torso (when mounted on an ACPA)
      sdp:         numberField(0),          // structural points (0 = no per-weapon tracking → frame)
      sdpDamage:   numberField(0),
      destroyed:   booleanField(false),
      // ACPA armed-melee weapons add the chassis Fist strike (round(STR/9) d10) on top of their own
      // dice (MM p.70 "+FIST"); the resolver adds it + its Penetration when an ACPA wields the weapon.
      addFist:     booleanField(false)
    };
  }

  static migrateData(source) {
    source ??= {};
    normalizeBooleanIfPresent(source, "ap", false);
    normalizeBooleanIfPresent(source, "heat", false);
    normalizeBooleanIfPresent(source, "hiEx", false);
    normalizeBooleanIfPresent(source, "highDensityAP", false);
    normalizeBooleanIfPresent(source, "railgun", false);
    normalizeBooleanIfPresent(source, "destroyed", false);
    normalizeBooleanIfPresent(source, "addFist", false);
    normalizeArrayIfPresent(source, "shellVariants", []);
    migrateSopToSdp(source);
    return super.migrateData(source);
  }
}

/**
 * ACPA non-weapon system (Maximum Metal p.61-79). A utility / sensor / movement / defensive / safety
 * device mounted in a powered-armor body area. Carries its own SDP (so a hit can knock out this one
 * system), its build budget (weight/spaces/cost/SP), and where it sits (area + internal/external mount).
 * Offensive systems are vehicleWeapon Items, not this type. `weight`/`cost` come from commonSchema.
 */
export class CyberpunkAcpaSystemData extends CyberpunkBaseItemData {
  static defineSchema() {
    return {
      ...commonSchema(),
      category:   stringField("utility"),    // utility|sensor|movement|defensive|safety
      area:       stringField("torso"),      // head|rArm|lArm|rLeg|lLeg|torso — body-area placement
      mount:      stringField("internal"),   // internal(enclosed)|external(unprotected)|either|retract
      spaces:     numberField(0),            // spaces consumed in its area
      sp:         numberField(0),            // intrinsic SP (external / retractable items)
      shots:      numberField(0),            // charges for dispensers (countermeasure cannisters / AGAMS); 0 = N/A
      sdp:        numberField(0),            // structural points (0 → derive 3×SP at runtime)
      sdpDamage:  numberField(0),            // accumulated SDP damage (per-system tracking)
      destroyed:  booleanField(false),
      catalogKey: stringField("")            // links back to ACPA_SYSTEMS (blank = custom)
    };
  }

  static migrateData(source) {
    source ??= {};
    normalizeBooleanIfPresent(source, "destroyed", false);
    migrateSopToSdp(source);
    return super.migrateData(source);
  }
}

/**
 * Extended model for the BARE `vehicle` item type (BMW 600, Musashi, the supplement catalog).
 *
 * The base system owns the `vehicle` type and registers its own model (OctarineSourcerer legacy:
 * sdp/sp/passengers/speed/maneuverability/fuel). The module RE-REGISTERS a richer model for the same
 * type (module loads after the system, so it wins) so the Augmented-Edition additions persist even for
 * users on the STOCK system: `range`+`rangeUnit` and a per-vehicle `speed.unit`. CP2020 prints vehicle
 * speed/range in MIXED units (mph & kph, miles & km) — empirically the catalog stored the raw printed
 * number in the book's own unit — so we keep the RAW value + its unit and convert at display time (no
 * lossy precompute). All additions are additive with sensible defaults (mph/mi/0), so existing items
 * migrate with no data change.
 *
 * Built at INIT via this factory so the model EXTENDS the system's own registered `vehicle` model
 * (`CONFIG.Item.dataModels.vehicle`) instead of a static mirror of it. Consequence: any field the base
 * model later gains — AND its `migrateData` — CHAIN automatically via `super`, instead of being silently
 * dropped by a stale mirror. Only the `speed` override (to add `unit`) remains a manual sync point.
 * Falls back to the module's own base if the system registered no vehicle model (a very old base).
 * See [[feedback-module-fork-sync]].
 *
 * @param {typeof foundry.abstract.TypeDataModel} [SystemVehicleData]  the system's registered vehicle model
 * @returns {typeof foundry.abstract.TypeDataModel}
 */
export function makeVehicleItemData(SystemVehicleData) {
  const Base = SystemVehicleData ?? CyberpunkBaseItemData;
  return class CyberpunkVehicleItemData extends Base {
    static defineSchema() {
      return {
        ...super.defineSchema(),   // the system's full vehicle schema (chains any future field it gains)
        // Override `speed` ONLY to add `unit` (mph|kph), covering value/max/maneuver/acceleration.
        speed:     objectField({ value: 0, max: 0, maneuver: 0, acceleration: 0, unit: "mph" }),
        // Travel range in `rangeUnit` (mi|km) — Chromebook/SoF stat-block field the base model lacked.
        range:     numberField(0),
        rangeUnit: stringField("mi")
      };
    }

    static migrateData(source) {
      source ??= {};
      if (hasOwn(source, "sdp"))             source.sdp             = mergeDefaults(source.sdp,             { value: 0, max: 0 });
      if (hasOwn(source, "speed"))           source.speed           = mergeDefaults(source.speed,           { value: 0, max: 0, maneuver: 0, acceleration: 0, unit: "mph" });
      if (hasOwn(source, "maneuverability")) source.maneuverability = mergeDefaults(source.maneuverability, { value: 0, condition: "" });
      if (hasOwn(source, "fuel"))            source.fuel            = mergeDefaults(source.fuel,            { type: "", efficiency: 0, max: 0, value: 0 });
      return super.migrateData(source);   // chains to the system's vehicle/base migrateData
    }
  };
}
