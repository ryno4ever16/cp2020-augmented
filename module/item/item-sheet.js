import { weaponTypes, meleeAttackTypes, rangedAttackTypes, attackSkills, concealability, availability, reliability, getStatNames, MARTIAL_BONUS_ACTIONS, getCalibers, AMMO_MODIFIERS, caliberMatches, normalizeCaliber, getCaliberBox, getAmmoBoxPrice, VEHICLE_TYPE_SUGGESTIONS } from "../lookups.js";
import { canBuyAmmo, applyAmmoModifierUpdate } from "../dialog/buy-ammo.js";
import { serviceModeOf, servicePeriodOf } from "../shop/services.js";
import { formulaHasDice } from "../dice.js";
import { installCyberware } from "../cyberware/install.js";
import { deleteFieldUpdate, localize, cwHasType, getSkillIndex } from "../utils.js";
import { VISION_DEVICE_MODES, MECH_PROTECTION_HAZARDS } from "../data/mech-item-data.js";
import { useConsumable } from "../mech/consumable.js";
import { createCyberpunkChatMessage, getHtmlElement, getPublicMessageMode, getRichEditorHTML, saveRichEditorHTML, rollToCyberpunkChatMessage } from "../compat.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;
const { Tabs } = foundry.applications.ux;

/** @extends {foundry.applications.sheets.ItemSheetV2} */
export class CyberpunkItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["cyberpunk", "sheet", "item", "flexcol"],
    tag: "form",
    position: {
      width: 520,
      height: 480
    },
    window: {
      resizable: true
    },
    form: {
      submitOnChange: true,
      closeOnSubmit: false
    }
  };

  /** @override */
  static PARTS = {
    form: {
      template: "modules/cp2020-augmented/templates/item/item-sheet.hbs"
    }
  };

  /**
   * Kept empty while the item sheet still uses the legacy monolithic template.
   * Tabs are bound manually in _cpActivateTabs().
   */
  static TABS = {};

  /** @override */
  async _prepareContext(options) {
    const data = await super._prepareContext(options);

    data.item = this.item;
    data.system = this.item.system;
    // Expose flags at top level so the skill martial-art fields can read/write
    // flags.cp2020-augmented.* (his skill DataModel lacks system.isMartialArt/martialBonuses, so on the
    // base system those fields live in module flags — the martial engine reads them there). The module
    // namespace (and martialBonuses) MUST be guaranteed present: the field partials read via the base
    // system's deepLookup helper, which throws on a missing intermediate (e.g. a fresh skill with no
    // cp2020-augmented flags yet).
    const flags = foundry.utils.deepClone(this.item.flags ?? {});
    const cpNs = flags["cp2020-augmented"] ?? {};
    cpNs.martialBonuses = cpNs.martialBonuses ?? {};
    flags["cp2020-augmented"] = cpNs;
    data.flags = flags;
    data.owner = this.item.isOwner;
    data.editable = this.isEditable ?? this.options?.editable ?? false;
    data.cssClass = ["cyberpunk", "sheet", "item"].join(" ");
    data.notesEditing = this._cpNotesEditing ?? false;
    data.isGM = game.user.isGM;
    data.canEditCyberwareHumanity = game.user.isGM
      || game.settings.get("cyberpunk2020", "playersCanEditCyberwareHumanity");
    // P3/P4 special-mechanics fields live on misc gear + cyberware only (the shared footer partial
    // gates on this). Vision-mode options are built here — JS owns data, labels localized.
    data.mechFieldsEligible = this.item.type === "misc" || this.item.type === "cyberware";
    if (data.mechFieldsEligible) {
      const current = this.item.system?.mechVision?.mode ?? "lowlight";
      data.mechVisionModes = VISION_DEVICE_MODES.map(m => ({
        value: m, selected: m === current,
        label: localize("MechVisionMode" + m.charAt(0).toUpperCase() + m.slice(1))
      }));
      const mp = this.item.system?.mechProtection ?? {};
      data.mechProtectionRows = MECH_PROTECTION_HAZARDS.map(h => ({
        key: h,
        label: localize("MechProtection" + h.charAt(0).toUpperCase() + h.slice(1)),
        immuneLabel: localize("MechProtectionImmune"),
        modLabel: localize("MechProtectionMod"),
        percentLabel: localize("MechProtectionPercent"),
        damageMultLabel: localize("MechProtectionDamageMult"),
        immune: !!mp[h]?.immune,
        mod: Number(mp[h]?.mod) || 0,
        percent: Number(mp[h]?.percent) || 0,
        damageMult: Number(mp[h]?.damageMult) || 0
      }));
      // P5 roll-mod provider: canonical skill names for the block's datalist (the same index the
      // CyberWorkType skill UI uses; cached). Fetched only once the block is enabled — the enable
      // checkbox submit re-renders, so the datalist is there when the fields appear.
      if (this.item.system?.mechRollMods?.enabled) {
        const skills = await getSkillIndex(game.i18n.lang);
        data.mechSkillOptions = skills.map(s => s.name);
      }
    }

    switch (this.item.type) {
      case "weapon":
        this._prepareWeapon(data);
        break;

      case "armor":
        this._prepareArmor(data);
        break;

      case "skill":
        this._prepareSkill(data);
        break;

      case "cyberware":
        await this._prepareCyberware(data);
        break;

      case "ammo":
        this._prepareAmmo(data);
        break;

      case "vehicle":
        this._prepareVehicle(data);
        break;

      case "misc":
        // Service classification lives in module flags (the base `misc` DataModel strips unknown
        // system fields). Normalize via the accessors so the settings partial binds/reads the flags.
        data.serviceMode = serviceModeOf(this.item);
        data.servicePeriod = servicePeriodOf(this.item);
        break;

      default:
        break;
    }

    return data;
  }

  /**
   * Vehicle item: speed & range are stored as a RAW value + a unit (mph|kph, mi|km) because CP2020
   * prints vehicles in mixed units. Precompute the converted ("the other unit") values so the sheet
   * can show e.g. "150 kph (93 mph)" without baking a conversion into stored data.
   */
  _prepareVehicle(sheet) {
    const sys = this.item?.system ?? {};
    const MI_PER_KM = 0.621371, KM_PER_MI = 1.609344;
    const sUnit = (sys.speed?.unit === "kph") ? "kph" : "mph";
    const sAltUnit = sUnit === "mph" ? "kph" : "mph";
    const sFactor = sUnit === "mph" ? KM_PER_MI : MI_PER_KM;
    const conv = (v) => Math.round((Number(v) || 0) * sFactor);
    const rUnit = (sys.rangeUnit === "km") ? "km" : "mi";
    const rAltUnit = rUnit === "mi" ? "km" : "mi";
    const rFactor = rUnit === "mi" ? KM_PER_MI : MI_PER_KM;

    // Fuel unit (gal|liters) drives the capacity + efficiency suffixes ("gal"/"mpg" vs "L"/"km/L").
    // Raw designations, same convention as mph/kph — no i18n keys for unit designations.
    const fUnit = (sys.fuel?.unit === "liters") ? "liters" : "gal";

    sheet.veh = {
      speedUnit: sUnit,
      speedAltUnit: sAltUnit,
      speedAlt: {
        max:          conv(sys.speed?.max),
        value:        conv(sys.speed?.value),
        maneuver:     conv(sys.speed?.maneuver),
        acceleration: conv(sys.speed?.acceleration),
        deceleration: conv(sys.speed?.deceleration)
      },
      rangeUnit: rUnit,
      rangeAltUnit: rAltUnit,
      rangeAlt: Math.round((Number(sys.range) || 0) * rFactor),
      speedUnitOptions: { mph: "mph", kph: "kph" },
      rangeUnitOptions: { mi: "mi", km: "km" },
      fuelUnit: fUnit,
      fuelCapSuffix: fUnit === "gal" ? "gal" : "L",
      fuelEffSuffix: fUnit === "gal" ? "mpg" : "km/L",
      // Fuel is DEMOTED in the UI (VEHICLE-SPEC.md §4 — printed on ~1% of vehicles): a locked sheet
      // with no fuel data skips the block; an editable sheet always shows it (data entry).
      showFuel: !!sheet.editable || !!(Number(sys.fuel?.max) || Number(sys.fuel?.value)
        || Number(sys.fuel?.efficiency) || String(sys.fuel?.type ?? "").trim()),
      // Soft-enum suggestions for the class datalist (VEHICLE_TYPE_SUGGESTIONS, module/lookups.js).
      vehicleTypeSuggestions: VEHICLE_TYPE_SUGGESTIONS
    };
  }

  _prepareSkill(sheet) {
    sheet.stats = getStatNames();
    // Action keys for the per-style bonus editor (shown when the skill is a martial art). Our net-new.
    sheet.martialBonusActions = MARTIAL_BONUS_ACTIONS;
  }

  _prepareAmmo(sheet) {
    const sys = this.item?.system ?? {};
    const updates = {};
    const setIfMissing = (key, value) => {
      if (sys[key] === null || sys[key] === undefined) updates[`system.${key}`] = value;
    };
    setIfMissing("quantity", 0);
    // Buy-box fields (our net-new): per-item box size/price + manual-quantity lock.
    setIfMissing("boxSize", 0);
    setIfMissing("boxCost", 0);
    setIfMissing("qtyLocked", true);

    setIfMissing("armorMultSoft", 1);
    setIfMissing("armorMultHard", 1);
    setIfMissing("rawDamageMult", 1);
    setIfMissing("penDamageMult", 1);
    setIfMissing("bonusDamageFormula", "");
    setIfMissing("accuracyMod", 0);

    setIfMissing("stunSaveOnHit", false);
    setIfMissing("stunSaveMod", 0);

    setIfMissing("dotEnabled", false);
    setIfMissing("dotTurns", 0);
    setIfMissing("dotDamageFormula", "");

    setIfMissing("blastRadius", 0);
    setIfMissing("blastZones", 4);
    setIfMissing("blastShrapnel", false);
    setIfMissing("blastFullDamageWithin", 1);

    const zones = Math.max(1, Math.min(10, Number(sys.blastZones ?? 4)));

    const defaultMult = (i) => 1 / (2 ** (i + 1));
    if (Array.isArray(sys.blastMultipliers) && sys.blastMultipliers.length && Number(sys.blastMultipliers[0]) === 1) {
      const fixed = sys.blastMultipliers.slice(1);

      while (fixed.length < zones) fixed.push(defaultMult(fixed.length));
      fixed.length = zones;

      updates["system.blastMultipliers"] = fixed;
    }

    if (!sys.blastMultipliers) {
      updates["system.blastMultipliers"] = Array.from({ length: zones }, (_, i) => defaultMult(i));
    } else if (!Array.isArray(sys.blastMultipliers)) {
      const obj = sys.blastMultipliers;
      const arr = Array.from({ length: zones }, (_, i) => {
        const raw = obj[i] ?? obj[String(i)];
        const n = Number(String(raw ?? "").replace(",", "."));
        return Number.isFinite(n) ? n : defaultMult(i);
      });
      updates["system.blastMultipliers"] = arr;
    } else {
      let cur = sys.blastMultipliers.slice();

      if (cur.length && Number(cur[0]) === 1) cur.shift();

      cur = cur.slice(0, zones).map((v, i) => {
        const n = Number(String(v ?? "").replace(",", "."));
        return Number.isFinite(n) ? n : defaultMult(i);
      });

      while (cur.length < zones) cur.push(defaultMult(cur.length));

      const prev = sys.blastMultipliers;
      const changed =
        cur.length !== prev.length ||
        cur.some((v, i) => v !== prev[i]);

      if (changed) {
        updates["system.blastMultipliers"] = cur;
      }
    }

    setIfMissing("spreadMode", "single");
    setIfMissing("spreadDistance", 0);
    setIfMissing("spreadDamageShort", "");
    setIfMissing("spreadDamageMedium", "");
    setIfMissing("spreadDamageLong", "");
    setIfMissing("spreadWidthShort", 1);
    setIfMissing("spreadWidthMedium", 2);
    setIfMissing("spreadWidthLong", 3);

    if (Object.keys(updates).length) {
      this.item.updateSource(updates);
      sheet.system = this.item.system;
    }

    // Weapon type (category of weapon for which the ammunition is intended)
    sheet.ammoReloadTypes = [
      // Bullet weapons.
      "AmmoReloadLightPistolSMG",
      "AmmoReloadMediumPistolSMG",
      "AmmoReloadHeavyPistolSMG",
      "AmmoReloadVeryHeavyPistol",
      "AmmoReloadAssaultRifle",
      "AmmoReloadShotgun",

      // Individual categories
      "AmmoWeaponArrows",
      "AmmoWeaponCrossbowQuarrels",
      "AmmoWeaponAirguns",
      "AmmoWeaponPaintloads",
      "AmmoReloadNeedlegunRounds",
      "AmmoReload20mmCannonRound",
      "AmmoWeaponGauss",
      "AmmoReloadFlamethrower",

      "AmmoReloadGrenades",
      "AmmoReloadRockets",
      "AmmoReloadOther"
    ];

    // Blast zones selector options
    sheet.blastZonesOptions = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => {
        const n = i + 1;
        return [n, n];
      })
    );

    // Indices for rendering multiplier inputs dynamically
    sheet.blastMultiplierIndices = Array.from(
      { length: Math.max(1, Math.min(10, Number(this.item.system?.blastZones ?? 4))) },
      (_, i) => i
    );

    // Two-axis ammo (our net-new): caliber (what weapons accept) + modifier (load). Built-in + custom calibers.
    const calibers = getCalibers();
    sheet.caliberChoices = Object.entries(calibers)
      .map(([id, c]) => ({ value: id, label: (c && c.label) ? c.label : id }))
      .sort((a, b) => a.label.localeCompare(b.label));
    sheet.modifierChoices = Object.entries(AMMO_MODIFIERS)
      .map(([id, m]) => ({ value: id, label: (m && m.label) ? m.label : id }));

    // Spread mode selector (Single / Spread)
    sheet.ammoSpreadModes = [
      { value: "single", localKey: "AmmoSpreadModeSingle" },
      { value: "spread", localKey: "AmmoSpreadModeSpread" }
    ];

    const effectTypes = Array.isArray(sys.effectTypes)
      ? sys.effectTypes
      : (sys.effectTypes ? [sys.effectTypes] : ["None"]);

    const effectKeyMap = {
      None: "AmmoEffect_None",
      CoreMods: "AmmoEffect_CoreMods",
      Stun: "AmmoEffect_Stun",
      DoT: "AmmoEffect_DoT",
      Blast: "AmmoEffect_Blast",
      Spread: "AmmoEffect_Spread"
    };

    sheet.ammoFx = {
      typeLabels: (effectTypes.length ? effectTypes : ["None"])
        .map(t => localize(effectKeyMap[t] ?? "AmmoEffect_None"))
    };
  }

  _prepareWeapon(sheet) {
    sheet.weaponTypes = Object.values(weaponTypes).sort();
    const isMelee = this.item.system.weaponType === weaponTypes.melee;
    sheet.isMelee = isMelee;
    sheet.attackTypes = isMelee ? Object.values(meleeAttackTypes).sort() : Object.values(rangedAttackTypes).sort();
    sheet.concealabilities = Object.values(concealability);
    sheet.availabilities = Object.values(availability);
    sheet.reliabilities = Object.values(reliability);

    if (this.item.system?.ammoItemId == null) {
      this.item.updateSource({ "system.ammoItemId": "" });
    }

    sheet.ammoChoices = [];
    const ammoOwner = this.item?.parent;

    if (ammoOwner) {
      // The weapon's caliber. ammoType holds the caliber id (e.g. "9mm"); normalize known typos.
      // Our net-new: only show ammo of a matching caliber (blank ammo caliber = wildcard, back-compat).
      const weaponCaliber = normalizeCaliber(this.item.system?.ammoType ?? "");
      const ammoItemsRaw = ammoOwner.itemTypes?.ammo ?? ammoOwner.items.filter(i => i.type === "ammo");
      const ammoItems = ammoItemsRaw
        .filter(a => a.system?.equipped !== false)
        .filter(a => caliberMatches(weaponCaliber, a.system?.caliber ?? ""));
      sheet.ammoChoices = [...ammoItems]
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map(a => {
          const cal = String(a.system?.caliber ?? "");
          const tag = cal || String(a.system?.ammoType ?? "");
          const label = tag ? `${a.name} (${tag})` : a.name;
          return { value: a.id, localKey: label };
        });
    }

    const actor = this.item?.parent;
    const wType = this.item.system.weaponType || weaponTypes.pistol;
    const baseKeys = attackSkills[wType] || [];
    const includeMartials = (wType === weaponTypes.melee) && (this.item.system.attackType === meleeAttackTypes.martial);
    const martialKeys = includeMartials ? (actor?.trainedMartials?.() || []) : [];
    const toAttackSkillChoice = (key) => {
      const martialLabel = actor?.getMartialDisplayName?.(key);
      const localized = localize("Skill" + key);
      return {
        value: key,
        label: martialLabel ?? (localized.includes("Skill") ? key : localized)
      };
    };

    sheet.attackSkills = [...baseKeys, ...martialKeys].map(toAttackSkillChoice);

    if (!sheet.attackSkills.length && actor?.itemTypes?.skill) {
      sheet.attackSkills = actor.itemTypes.skill
        .map(skill => ({ value: skill.name, label: skill.name }))
        .sort((a, b) => String(a.label).localeCompare(String(b.label)));
    }
  }

  _prepareArmor(sheet) {
    
  }

/**
 * Prepares data for the cyberware item sheet template.
 * Gathers option lists, selected values, and labels.
*/
async _prepareCyberware(sheet) {
  const L = (k) => {
    if (game.i18n.has(`CYBERPUNK.${k}`)) return game.i18n.localize(`CYBERPUNK.${k}`);
    if (game.i18n.has(k)) return game.i18n.localize(k);
    return k;
  };

  const sys = this.item?.system ?? {};
  const cwt = sys.CyberWorkType ?? {};
  sheet.cw = sheet.cw ?? {};

  sheet.cw.types = Array.isArray(cwt.Types) && cwt.Types.length
    ? [...cwt.Types]
    : (cwt.Type ? [cwt.Type] : ["Descriptive"]);

  const mapKeyToLoc = (k) => {
    switch (k) {
      case "Descriptive": return game.i18n.localize("CYBERPUNK.CWT_Type_Descriptive");
      case "Characteristic": return game.i18n.localize("CYBERPUNK.CWT_Type_Characteristic");
      case "Armor": return game.i18n.localize("CYBERPUNK.CWT_Type_Armor");
      case "Weapon": return game.i18n.localize("CYBERPUNK.CWT_Type_Weapon");
      case "Implant": return game.i18n.localize("CYBERPUNK.CWT_Type_Implant");
      case "Chip": return game.i18n.localize("CYBERPUNK.CWT_Type_Chip");
      default: return k;
    }
  };
  sheet.cw.typeLabels = sheet.cw.types.map(mapKeyToLoc);

  // Ensure Module exists for bindings
  if (!this.item.system.Module) {
    this.item.updateSource({
      "system.Module": {
        IsModule: false,
        ParentId: "",
        SlotsTaken: 0,
        AllowedParentCyberwareType: ""
      }
    });
  }

  if (this.item.system?.EffectMode == null) {
    this.item.updateSource({ "system.EffectMode": "Permanent" });
  }
  if (this.item.system?.EffectActive == null) {
    this.item.updateSource({ "system.EffectActive": false });
  }

  // Characteristic: stats and checks
  const STAT_KEYS = [
    { key: "int", label: L("IntFull") },
    { key: "ref", label: L("RefFull") },
    { key: "tech", label: L("TechFull") },
    { key: "cool", label: L("CoolFull") },
    { key: "attr", label: L("AttrFull") },
    { key: "luck", label: L("LuckFull") },
    { key: "ma", label: L("MaFull") },
    { key: "bt", label: L("BtFull") },
    { key: "emp", label: L("EmpFull") }
  ];

  const CHECK_KEYS = [
    { key: "Initiative", label: L("CWT_Checks_Initiative") },
    { key: "SaveStun", label: L("CWT_Checks_SaveStun") }
  ];

  const findLabel = (list, key) => list.find((i) => i.key === key)?.label ?? key;

  const statObj = cwt.Stat ?? {};
  sheet.cw.currentStats = Object.keys(statObj).map((k) => ({ key: k, label: findLabel(STAT_KEYS, k) }));
  sheet.cw.statRemain = STAT_KEYS.filter((s) => !(s.key in statObj));

  const checkObj = cwt.Checks ?? {};
  sheet.cw.currentChecks = Object.keys(checkObj).map((k) => ({ key: k, label: findLabel(CHECK_KEYS, k) }));
  sheet.cw.checkRemain = CHECK_KEYS.filter((c) => !(c.key in checkObj));

  // Armor: locations and penalties
  const LOCATION_KEYS = [
    { key: "Head", label: L("Head") },
    { key: "Torso", label: L("Torso") },
    { key: "lArm", label: L("lArm") },
    { key: "rArm", label: L("rArm") },
    { key: "lLeg", label: L("lLeg") },
    { key: "rLeg", label: L("rLeg") }
  ];

  const PENALTY_KEYS = STAT_KEYS;

  const locObj = cwt.Locations ?? {};
  sheet.cw.currentLocations = Object.keys(locObj).map((k) => ({ key: k, label: findLabel(LOCATION_KEYS, k) }));
  sheet.cw.locationRemain = LOCATION_KEYS.filter((l) => !(l.key in locObj));

  const penObj = cwt.Penalties ?? {};
  sheet.cw.currentPenalties = Object.keys(penObj).map((k) => ({ key: k, label: findLabel(PENALTY_KEYS, k) }));
  sheet.cw.penaltyRemain = PENALTY_KEYS.filter((p) => !(p.key in penObj));

  // Skills:
  // - If we have an Actor: use Actor's embedded skill Items (supports custom skills).
  // - If there is no Actor (e.g. compendium/world item): load skills from locale compendiums.
  // IMPORTANT: store selected skills in implants by Skill Item _id (stable across localizations).
  const actorSkills = this.actor?.itemTypes?.skill ?? [];
  const skillsList = actorSkills.length
    ? actorSkills.map((s) => ({ id: s.id, name: s.name }))
    : await getSkillIndex(game.i18n.lang);

  skillsList.sort((a, b) => a.name.localeCompare(b.name));

  sheet.cw.skillOptions = skillsList.map((s) => s.name);
  sheet.cw.hasActor = !!this.actor;

  // Maps used by sheet interaction handlers (name -> id) and for display (id -> name).
  this._cwSkillNameToId = new Map(skillsList.map((s) => [s.name, s.id]));
  this._cwSkillIdToName = new Map(skillsList.map((s) => [s.id, s.name]));

  const resolveSkillLabel = (key) => {
    // Prefer actor's current localized name, if actor has the skill
    const byId = this.actor?.items?.get(key);
    if (byId?.type === "skill") return byId.name;
    // Otherwise resolve via compendium index for current UI language
    return this._cwSkillIdToName.get(key) || key;
  };

  sheet.cw.currentSkills = Object.keys(cwt.Skill ?? {})
    .map((k) => ({ key: k, label: resolveSkillLabel(k) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  sheet.cw.currentChipSkills = Object.keys(cwt.ChipSkills ?? {})
    .map((k) => ({ key: k, label: resolveSkillLabel(k) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Weapon options: from the actor's inventory or from Items
  if (this.actor) {
    sheet.cw.weaponOptions = (this.actor.itemTypes.weapon ?? [])
      .map((w) => ({ id: w.id, name: w.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } else {
    const allItems = Array.from(game.items ?? []);
    sheet.cw.weaponOptions = allItems
      .filter((i) => i.type === "weapon")
      .map((w) => ({ id: w.id, name: w.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Implant: allowed installation slot
  const bodyAll = [
    { key: "Head", label: L("Head") },
    { key: "Torso", label: L("Torso") },
    { key: "Arm", label: L("Arm") },
    { key: "Leg", label: L("Leg") },
    { key: "Nervous", label: L("Nervous") },
    { key: "Chip", label: L("Chip") }
  ];
  sheet.cw.bodyZones = bodyAll;

  sheet.weaponTypes = Object.values(weaponTypes).sort();
  const cwW = this.item.system?.CyberWorkType?.Weapon || {};
  const isMelee = cwW.weaponType === weaponTypes.melee;
  sheet.cwWeaponIsMelee = isMelee;
  sheet.attackTypes = isMelee ? Object.values(meleeAttackTypes).sort() : Object.values(rangedAttackTypes).sort();
  sheet.concealabilities = Object.values(concealability);
  sheet.availabilities = Object.values(availability);
  sheet.reliabilities = Object.values(reliability);

  if (this.item.system?.CyberWorkType?.Weapon?.ammoItemId == null) {
    this.item.updateSource({ "system.CyberWorkType.Weapon.ammoItemId": "" });
  }

  sheet.cwAmmoChoices = [];
  const ammoOwner = this.actor;

  if (ammoOwner) {
    const ammoItemsRaw = ammoOwner.itemTypes?.ammo ?? ammoOwner.items.filter(i => i.type === "ammo");
    const ammoItems = ammoItemsRaw.filter(a => a.system?.equipped !== false);

    sheet.cwAmmoChoices = [...ammoItems]
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map(a => {
        const ammoType = String(a.system?.ammoType ?? "");
        const label = ammoType ? `${a.name} (${ammoType})` : a.name;
        return { value: a.id, localKey: label };
      });
  }

  const actor = this.item?.parent;
  const baseKeys = attackSkills[cwW.weaponType || weaponTypes.pistol] || [];
  const includeMartials = isMelee && (cwW.attackType === meleeAttackTypes.martial);
  const martialKeys = includeMartials ? (actor?.trainedMartials?.() || []) : [];
  const toAttackSkillChoice = (key) => {
    const martialLabel = actor?.getMartialDisplayName?.(key);
    const localized = localize("Skill" + key);
    return {
      value: key,
      label: martialLabel ?? (localized.includes("Skill") ? key : localized)
    };
  };

  sheet.attackSkills = [...baseKeys, ...martialKeys].map(toAttackSkillChoice);
  
  if (!sheet.attackSkills.length && this.actor) {
    sheet.attackSkills = (this.actor.itemTypes.skill || [])
      .map(skill => ({ value: skill.name, label: skill.name }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  const TYPE_CHOICES_BASE = [
    { value: "CyberArm", localKey: "CWT_ImplantType_CyberArm" },
    { value: "CyberLeg", localKey: "CWT_ImplantType_CyberLeg" },
    { value: "CyberAudio", localKey: "CWT_ImplantType_CyberAudio" },
    { value: "CyberOptic", localKey: "CWT_ImplantType_CyberOptic" },
    { value: "CyberTorso", localKey: "CWT_ImplantType_CyberTorso" }
  ];

  const typeAliases = {
    "CYBERARM": "CyberArm",
    "CYBERHAND": "CyberArm",
    "CYBERLEG": "CyberLeg",
    "CYBERFOOT": "CyberLeg",
    "CYBEREAR": "CyberAudio",
    "CYBEROPTIC":"CyberOptic",
    "IMPLANT": "CyberTorso",
    "Arm": "CyberArm", "Leg": "CyberLeg",
    "Ear": "CyberAudio", "Eye": "CyberOptic", "Torso": "CyberTorso"
  };

  const pickType = (t) => {
    if (!t) return null;
    if (typeof t === "string") {
      const k = t.trim();
      return typeAliases[k] || k;
    }
    if (typeof t === "object") {
      const k = (t.key ?? t.value ?? t.name);
      if (typeof k === "string") {
        const s = k.trim();
        return typeAliases[s] || s;
      }
    }
    return null;
  };

    // Only module-capable implant base types (no dynamic extras)
    sheet.cw.parentCwTypeChoices = TYPE_CHOICES_BASE;

      sheet.cw.cyberwareTypeSelected = pickType(this.item.system?.cyberwareType) || "";
    sheet.cw.allowedParentCwTypeSelected =
      pickType(this.item.system?.Module?.AllowedParentCyberwareType) ||
      String(this.item.system?.Module?.AllowedParentCyberwareType || "");

    // Implant: free/taken options with automatic module accounting (only equipped modules count)
    const provided = Number(this.item.system?.CyberWorkType?.OptionsAvailable) || 0;
    let used = 0;
    if (this.actor) {
      const all = this.actor.items?.contents || [];
      const selfId = this.item.id;
      used = all
        .filter(i =>
          i.type === "cyberware" &&
          i.system?.Module?.IsModule &&
          i.system?.Module?.ParentId === selfId &&
          !!i.system?.equipped
        )
        .reduce((sum, m) => sum + (Number(m.system?.Module?.SlotsTaken) || 0), 0);
    }
    sheet.cw.implantSlotsUsed = used;
    sheet.cw.implantSlotsTotal = provided;
    sheet.cw.implantSlotsLeft = Math.max(0, provided - used);

    // Module: implants available on the actor that match the type (only equipped, same zone/side, exclude self)
    const isModule = !!this.item.system?.Module?.IsModule;
    if (isModule && this.actor) {
      const needType = this.item.system?.Module?.AllowedParentCyberwareType || "";
      const all = this.actor.items?.contents || [];

      const zoneOf = (it) => String(it.system?.MountZone || it.system?.CyberBodyType?.Type || "");
      const sideOf = (it) => String(it.system?.CyberBodyType?.Location || "");
      const needZone = zoneOf(this.item);
      const needSide = sideOf(this.item);

      // Count available slots of a candidate implant (only equipped modules count)
      const leftFor = (p) => {
        const provided = Number(p.system?.CyberWorkType?.OptionsAvailable || 0);
        const used = all
          .filter(i =>
            i.type === "cyberware" &&
            i.system?.Module?.IsModule &&
            i.system?.Module?.ParentId === p.id &&
            !!i.system?.equipped
          )
          .reduce((sum, m) => sum + (Number(m.system?.Module?.SlotsTaken) || 0), 0);
        return Math.max(0, provided - used);
      };

      sheet.cw.parentImplants = all
        .filter(i =>
          i.type === "cyberware" &&
          cwHasType(i, "Implant") &&
          i.id !== this.item.id &&
          !!i.system?.equipped &&
          (!needType || pickType(i.system?.cyberwareType) === pickType(needType)) &&
          (zoneOf(i) === needZone) &&
          (needZone === "Arm" || needZone === "Leg" ? (!needSide || sideOf(i) === needSide) : true)
        )
        .map(i => ({ id: i.id, name: i.name, left: leftFor(i) }));
    } else {
      sheet.cw.parentImplants = [];
    }

    // Implant: free/taken options (ONLY equipped modules count)
    if (cwHasType(this.item, "Implant")) {
      const provided = Number(this.item.system?.CyberWorkType?.OptionsAvailable) || 0;
      let used = 0;

      if (this.actor) {
        const all = this.actor.items?.contents || [];
        const selfId = this.item.id;
        used = all.reduce((sum, it) => {
          const mod = it.system?.Module;
          if (
            it.type === "cyberware" &&
            mod?.IsModule &&
            mod?.ParentId === selfId &&
            !!it.system?.equipped
          ) {
            return sum + (Number(mod.SlotsTaken) || 0);
          }
          return sum;
        }, 0);
      }

      sheet.cw.implantSlotsUsed = used;
      sheet.cw.implantSlotsTotal = provided;
      sheet.cw.implantSlotsLeft = Math.max(0, provided - used);
    }
}

  async _ammoSet(path, value) {
    const update = {};
    foundry.utils.setProperty(update, path, value);
    await this.item.update(update);
    this.render(false);
  }
  _resolveSkillKey(query) {
    const q = String(query || "").trim();
    if (!q) return null;

    // Allow pasting a skill _id directly
    const byId = this.actor?.items?.get(q);
    if (byId?.type === "skill") return q;
    if (this._cwSkillIdToName?.has(q)) return q;

    // Exact match by displayed name (from prepared option list)
    const idFromName = this._cwSkillNameToId?.get(q);
    if (idFromName) return idFromName;

    // Fallback: exact name match on actor skills (custom skills)
    const skills = this.actor?.itemTypes?.skill || [];
    const exact = skills.find((s) => s.name === q);
    return exact ? exact.id : null;
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);

    const root = getHtmlElement(this.element);
    if (!root) return;

    this._cpActivateTabs(root);
    this._cpActivateNotesEditor(root);
    this._cpActivateVehicleSpeedControls(root);
    this._cpActivateBasicItemActions(root);
    this._cpActivateCyberwareBasicControls(root);
    this._cpActivateCyberwareMechanicTypeControls(root);
    this._cpActivateCyberwareSkillSearchControls(root);
    this._cpActivateSkillItemControls(root);

    // Net-new feature controls (not on upstream): ammo system, vehicle-weapon shells,
    // cyberware surgical install, comma-decimal inputs. See the helper block further below.
    this._cpActivateNumericCommaInputs(root);
    this._cpActivateCyberwareInstall(root);
    this._cpActivateVehicleWeaponShellControls(root);
    this._cpActivateAmmoControls(root);
    this._cpActivateMechConsumableControls(root);
  }

  /** P7 consumable Use button — spends a dose via the mech engine (bind-once). */
  _cpActivateMechConsumableControls(root) {
    if (!root?.ownerDocument) return;
    if (!this.isEditable) return;
    if (root.dataset.cpMechConsumableBound === "1") return;
    root.dataset.cpMechConsumableBound = "1";
    root.addEventListener("click", async (event) => {
      const btn = event.target?.closest?.(".cp-consumable-use");
      if (!btn) return;
      event.preventDefault();
      await useConsumable(this.item);
    });
  }

  _cpActivateVehicleSpeedControls(root) {
    if (!root?.ownerDocument) return;

    // Always remove a previously-bound handler first, so a sheet that re-renders from editable to
    // locked (e.g. opening the same item out of a locked compendium) un-wires the +/- controls.
    if (this._cpVehicleSpeedRoot && this._cpVehicleSpeedHandler) {
      try {
        this._cpVehicleSpeedRoot.ownerDocument.removeEventListener("click", this._cpVehicleSpeedHandler, true);
      } catch (_) {}
      this._cpVehicleSpeedRoot = null;
      this._cpVehicleSpeedHandler = null;
    }

    // The +/- accel/decel controls write speed.value to the item, so only wire them when the sheet
    // is editable — otherwise a click on a locked compendium item fires item.update() and Foundry
    // warns "you can't modify a locked compendium." (The template also hides them when !editable.)
    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;

    const handler = async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const control = target.closest(".accel, .decel");
      if (!control) return;
      if (!root.contains(control)) return;
      if (this.item.type !== "vehicle") return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      const readNumber = (selector, path, fallback = 0) => {
        const input = root.querySelector(selector);
        const raw = input?.value ?? foundry.utils.getProperty(this.item.system, path) ?? fallback;
        const value = Number(String(raw).replace(",", "."));
        return Number.isFinite(value) ? value : fallback;
      };

      const current = readNumber('input[name="system.speed.value"]', "speed.value", 0);
      const acceleration = readNumber('input[name="system.speed.acceleration"]', "speed.acceleration", 0);
      const max = readNumber('input[name="system.speed.max"]', "speed.max", current);

      const direction = control.classList.contains("decel") ? -1 : 1;
      const rawNext = current + (acceleration * direction);
      const upperLimit = Number.isFinite(max) ? max : rawNext;
      const next = Math.max(0, Math.min(rawNext, upperLimit));

      const valueInput = root.querySelector('input[name="system.speed.value"]');
      if (valueInput) valueInput.value = String(next);

      await this.item.update({ "system.speed.value": next }, { render: false });
      await this.render({ force: true });
    };

    root.ownerDocument.addEventListener("click", handler, true);

    this._cpVehicleSpeedRoot = root;
    this._cpVehicleSpeedHandler = handler;
  }

  _cpActivateTabs(root) {
    const nav = root.querySelector(".sheet-tabs");
    const body = root.querySelector(".sheet-body");
    if (!nav || !body) return;

    const activeTab =
      this._cpActiveTab
      ?? nav.querySelector("[data-tab].active")?.dataset.tab
      ?? body.querySelector(".tab.active")?.dataset.tab
      ?? "settings";

    nav.addEventListener("click", async (event) => {
      const target = event.target?.closest?.("[data-tab]");
      if (!target) return;

      const nextTab = target.dataset.tab || "settings";

      if (this._cpNotesEditing && nextTab !== "notes") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        await this._cpExitNotesEditing(root, { render: false });
        this._cpActiveTab = nextTab;

        await this.render({ force: true });
        return;
      }

      this._cpActiveTab = nextTab;
    }, true);

    const tabs = new Tabs({
      navSelector: ".sheet-tabs",
      contentSelector: ".sheet-body",
      initial: activeTab
    });

    tabs.bind(root);
    tabs.activate(activeTab, false);

    this._cpTabs = tabs;
  }

  /** @override */
  _onPosition(position) {
    super._onPosition(position);

    const root = getHtmlElement(this.element);
    const sheetBody = root?.querySelector?.(".sheet-body");
    if (!sheetBody) return;

    const height = Number(position?.height);
    if (!Number.isFinite(height)) return;

    sheetBody.style.height = `${Math.max(0, height - 192)}px`;
  }

  _cpActivateBasicItemActions(root) {
    if (!root?.addEventListener) return;
    if (root.dataset.cpBasicItemActionsBound === "1") return;

    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;

    // Set the bind-once flag only once we're actually binding. A read-only first render must NOT claim
    // it — otherwise a later editable render is skipped by the guard above and the roll/humanity
    // handlers never bind (dead buttons until close+reopen). This matches the guard order the module's
    // own _cpActivate* helpers already use + document below. (F6)
    root.dataset.cpBasicItemActionsBound = "1";

    root.addEventListener("click", async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const itemRoll = target.closest(".item-roll");
      if (itemRoll) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        await this.item.roll();
        return;
      }

      const humanityRoll = target.closest(".humanity-cost-roll");
      if (humanityRoll) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        await this._cpRollHumanityCost();
      }
    }, true);
  }

  async _cpRollHumanityCost() {
    if (this.item.type !== "cyberware") return;

    const cyber = this.item;
    const hc = cyber.system?.humanityCost;
    let loss = 0;
    let roll = null;

    if (formulaHasDice(hc)) {
      roll = await new Roll(hc).evaluate();
      loss = roll?.total ? roll.total : 0;
    } else {
      const num = Number(hc);
      loss = Number.isFinite(num) ? num : 0;
    }

    await cyber.update({ "system.humanityLoss": loss });

    const actor = cyber.actor ?? null;
    const speaker = ChatMessage.getSpeaker(actor ? { actor } : {});
    const messageMode = getPublicMessageMode();

    if (roll) {
      await rollToCyberpunkChatMessage(
        roll,
        {
          speaker,
          flavor: game.i18n.format("CYBERPUNK.Chat.HumanityRollFlavor", {
            actor: actor?.name ?? game.user.name,
            item: cyber.name
          })
        },
        { messageMode }
      );

      return;
    }

    await createCyberpunkChatMessage({
      speaker,
      content: game.i18n.format("CYBERPUNK.Chat.HumanityLossSet", {
        actor: actor?.name ?? game.user.name,
        item: cyber.name,
        loss
      })
    }, { messageMode });
  }

  _cpRemoveCyberwareBasicListeners() {
    try {
      if (this._cpCyberwareBasicControlsRoot && this._cpCyberwareBasicAddHandler) {
        this._cpCyberwareBasicControlsRoot.removeEventListener("change", this._cpCyberwareBasicAddHandler, true);
      }

      if (this._cpCyberwareBasicControlsRoot && this._cpCyberwareBasicRemoveHandler) {
        this._cpCyberwareBasicControlsRoot.removeEventListener("click", this._cpCyberwareBasicRemoveHandler, true);
      }
    } catch (_) {}

    this._cpCyberwareBasicControlsRoot = null;
    this._cpCyberwareBasicAddHandler = null;
    this._cpCyberwareBasicRemoveHandler = null;
  }

  async _cpUpdateCyberwareDocument(update) {
    const actor = this.item.actor ?? this.actor ?? null;

    if (actor) {
      await actor.updateEmbeddedDocuments("Item", [
        { _id: this.item.id, ...update }
      ], { render: false });
    } else {
      await this.item.update(update, { render: false });
    }

    await this._cpRenderCyberwareDependentSheets(actor);
  }

  async _cpRenderCyberwareDependentSheets(actor = null) {
    const owner = actor ?? this.item.actor ?? this.actor ?? null;

    await this._cpRenderOpenSheet(owner);
    await this.render({ force: true });
  }

  async _cpSetCyberwarePath(path, value) {
    const update = {};
    foundry.utils.setProperty(update, path, value);
    await this._cpUpdateCyberwareDocument(update);
  }

  async _cpDeleteCyberwarePath(path) {
    await this._cpUpdateCyberwareDocument(deleteFieldUpdate(path));
  }

  _cpGetCyberwareMountPolicyList() {
    const mountPolicy = this.item.system?.CyberWorkType?.MountPolicy;
    if (Array.isArray(mountPolicy)) return [...mountPolicy];
    if (mountPolicy) return [mountPolicy];
    return [];
  }

  _cpActivateCyberwareBasicControls(root) {
    this._cpRemoveCyberwareBasicListeners();

    if (!root?.addEventListener) return;
    if (this.item.type !== "cyberware") return;

    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;

    const addSelectSelector = [
      "select.cw-add-stat",
      "select.cw-add-check",
      "select.cw-add-location",
      "select.cw-add-penalty",
      "select.cw-add-mountpolicy"
    ].join(", ");

    const removeControlSelector = [
      ".cw-remove-stat",
      ".cw-remove-check",
      ".cw-remove-skill",
      ".cw-remove-location",
      ".cw-remove-penalty",
      ".cw-remove-mount"
    ].join(", ");

    const addHandler = async (event) => {
      const select = event.target?.closest?.(addSelectSelector);
      if (!select || !root.contains(select)) return;

      const key = String(select.value ?? "");
      if (!key) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      try {
        if (select.matches("select.cw-add-stat")) {
          await this._cpSetCyberwarePath(`system.CyberWorkType.Stat.${key}`, 0);
          return;
        }

        if (select.matches("select.cw-add-check")) {
          const checks = foundry.utils.duplicate(this.item.system?.CyberWorkType?.Checks || {});
          if (checks[key] == null) checks[key] = 0;
          await this._cpSetCyberwarePath("system.CyberWorkType.Checks", checks);
          return;
        }

        if (select.matches("select.cw-add-location")) {
          await this._cpSetCyberwarePath(`system.CyberWorkType.Locations.${key}`, 0);
          return;
        }

        if (select.matches("select.cw-add-penalty")) {
          await this._cpSetCyberwarePath(`system.CyberWorkType.Penalties.${key}`, 0);
          return;
        }

        if (select.matches("select.cw-add-mountpolicy")) {
          const list = this._cpGetCyberwareMountPolicyList();
          if (!list.includes(key)) list.push(key);
          await this._cpSetCyberwarePath("system.CyberWorkType.MountPolicy", list);
        }
      } finally {
        select.value = "";
      }
    };

    const removeHandler = async (event) => {
      const control = event.target?.closest?.(removeControlSelector);
      if (!control || !root.contains(control)) return;

      const key = String(control.dataset.key ?? "");
      if (!key) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      if (control.matches(".cw-remove-stat")) {
        await this._cpDeleteCyberwarePath(`system.CyberWorkType.Stat.${key}`);
        return;
      }

      if (control.matches(".cw-remove-check")) {
        await this._cpDeleteCyberwarePath(`system.CyberWorkType.Checks.${key}`);
        return;
      }

      if (control.matches(".cw-remove-skill")) {
        await this._cpDeleteCyberwarePath(`system.CyberWorkType.Skill.${key}`);
        return;
      }

      if (control.matches(".cw-remove-location")) {
        await this._cpDeleteCyberwarePath(`system.CyberWorkType.Locations.${key}`);
        return;
      }

      if (control.matches(".cw-remove-penalty")) {
        await this._cpDeleteCyberwarePath(`system.CyberWorkType.Penalties.${key}`);
        return;
      }

      if (control.matches(".cw-remove-mount")) {
        const list = this._cpGetCyberwareMountPolicyList().filter((value) => value !== key);
        await this._cpSetCyberwarePath("system.CyberWorkType.MountPolicy", list);
      }
    };

    root.addEventListener("change", addHandler, true);
    root.addEventListener("click", removeHandler, true);

    this._cpCyberwareBasicControlsRoot = root;
    this._cpCyberwareBasicAddHandler = addHandler;
    this._cpCyberwareBasicRemoveHandler = removeHandler;
  }

  _cpRemoveCyberwareMechanicTypeListeners() {
    try {
      if (this._cpCyberwareMechanicTypeRoot && this._cpCyberwareMechanicTypeClickHandler) {
        this._cpCyberwareMechanicTypeRoot.removeEventListener("click", this._cpCyberwareMechanicTypeClickHandler, true);
      }

      if (this._cpCyberwareMechanicTypeRoot && this._cpCyberwareMechanicTypeChangeHandler) {
        this._cpCyberwareMechanicTypeRoot.removeEventListener("change", this._cpCyberwareMechanicTypeChangeHandler, true);
      }

      if (this._cpCyberwareMechanicTypeDocument && this._cpCyberwareMechanicTypeDocumentClickHandler) {
        this._cpCyberwareMechanicTypeDocument.removeEventListener("click", this._cpCyberwareMechanicTypeDocumentClickHandler, true);
      }
    } catch (_) {}

    this._cpCyberwareMechanicTypeRoot = null;
    this._cpCyberwareMechanicTypeClickHandler = null;
    this._cpCyberwareMechanicTypeChangeHandler = null;
    this._cpCyberwareMechanicTypeDocument = null;
    this._cpCyberwareMechanicTypeDocumentClickHandler = null;
  }

  _cpActivateCyberwareMechanicTypeControls(root) {
    this._cpRemoveCyberwareMechanicTypeListeners();

    if (!root?.addEventListener) return;
    if (this.item.type !== "cyberware") return;

    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;

    root.querySelectorAll(".cw-ms").forEach((menuRoot) => {
      menuRoot.closest(".field")?.classList.add("cw-ms-field");
    });

    const clearMenu = (menuRoot) => {
      if (!menuRoot) return;

      menuRoot.classList.remove("open");
      menuRoot.classList.remove("drop-up");
    };

    const closeOpenMenus = (except = null) => {
      root.querySelectorAll(".cw-ms.open").forEach((menuRoot) => {
        if (menuRoot !== except) clearMenu(menuRoot);
      });
    };

    const closeAllMenus = () => {
      root.querySelectorAll(".cw-ms.open").forEach((menuRoot) => clearMenu(menuRoot));
    };

    const updateMenuPlacement = (trigger, menuRoot, menu) => {
      menuRoot.classList.remove("drop-up");

      const view = root.ownerDocument?.defaultView ?? window;
      const viewportHeight = view.innerHeight ?? document.documentElement.clientHeight;
      const scrollRoot = trigger.closest?.(".window-content");
      const scrollRect = scrollRoot?.getBoundingClientRect?.();
      const triggerRect = trigger.getBoundingClientRect();

      const clipTop = Math.max(0, scrollRect?.top ?? 0);
      const clipBottom = Math.min(viewportHeight, scrollRect?.bottom ?? viewportHeight);

      const spaceAbove = triggerRect.top - clipTop;
      const spaceBelow = clipBottom - triggerRect.bottom;
      const menuHeight = Math.min(menu.scrollHeight || 240, 240);

      const dropUp = spaceBelow < menuHeight + 8 && spaceAbove > spaceBelow;
      menuRoot.classList.toggle("drop-up", dropUp);
    };

    const clickHandler = (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const trigger = target.closest(".cw-ms-trigger");
      if (trigger && root.contains(trigger)) {
        const menuRoot = trigger.closest(".cw-ms");
        const menu = menuRoot?.querySelector(".cw-ms-menu");

        if (!menuRoot || !menu) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        const wasOpen = menuRoot.classList.contains("open");

        closeOpenMenus(menuRoot);

        if (wasOpen) {
          clearMenu(menuRoot);
          return;
        }

        menuRoot.classList.add("open");
        updateMenuPlacement(trigger, menuRoot, menu);
        return;
      }

      if (!target.closest(".cw-ms")) {
        closeAllMenus();
      }
    };

    const documentClickHandler = (event) => {
      const target = event.target;
      if (!target?.closest) {
        closeAllMenus();
        return;
      }

      const menuRoot = target.closest(".cw-ms");
      if (menuRoot && root.contains(menuRoot)) return;

      closeAllMenus();
    };

    const changeHandler = async (event) => {
      const input = event.target?.closest?.(".cw-ms-menu input[type='checkbox']");
      if (!input || !root.contains(input)) return;

      const menuRoot = input.closest(".cw-ms");
      if (!menuRoot) return;

      const path = String(menuRoot.dataset.path ?? "");
      if (path !== "system.CyberWorkType.Types") return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      const menu = menuRoot.querySelector(".cw-ms-menu");
      if (!menu) return;

      let next = Array.from(menu.querySelectorAll("input[type='checkbox']:checked"))
        .map((checkbox) => String(checkbox.value || ""))
        .filter(Boolean);

      const changed = String(input.value || "");
      const turnedOn = !!input.checked;

      if (changed === "Descriptive" && turnedOn) {
        next = ["Descriptive"];

        menu.querySelectorAll("input[type='checkbox']").forEach((checkbox) => {
          checkbox.checked = checkbox.value === "Descriptive";
        });
      } else if (turnedOn) {
        const descriptive = menu.querySelector('input[value="Descriptive"]');
        if (descriptive) descriptive.checked = false;

        next = next.filter((value) => value !== "Descriptive");
      }

      if (!next.length) {
        next = ["Descriptive"];

        const descriptive = menu.querySelector('input[value="Descriptive"]');
        if (descriptive) descriptive.checked = true;
      }

      await this._cpSetCyberwarePath("system.CyberWorkType.Types", next);
    };

    root.addEventListener("click", clickHandler, true);
    root.addEventListener("change", changeHandler, true);
    root.ownerDocument.addEventListener("click", documentClickHandler, true);

    this._cpCyberwareMechanicTypeRoot = root;
    this._cpCyberwareMechanicTypeClickHandler = clickHandler;
    this._cpCyberwareMechanicTypeChangeHandler = changeHandler;
    this._cpCyberwareMechanicTypeDocument = root.ownerDocument;
    this._cpCyberwareMechanicTypeDocumentClickHandler = documentClickHandler;
  }

  _cpRemoveCyberwareSkillSearchListeners() {
    try {
      if (this._cpCyberwareSkillSearchRoot && this._cpCyberwareSkillSearchInputHandler) {
        this._cpCyberwareSkillSearchRoot.removeEventListener("input", this._cpCyberwareSkillSearchInputHandler, true);
      }

      if (this._cpCyberwareSkillSearchRoot && this._cpCyberwareSkillSearchChangeHandler) {
        this._cpCyberwareSkillSearchRoot.removeEventListener("change", this._cpCyberwareSkillSearchChangeHandler, true);
      }

      if (this._cpCyberwareSkillSearchRoot && this._cpCyberwareSkillSearchMouseDownHandler) {
        this._cpCyberwareSkillSearchRoot.removeEventListener("mousedown", this._cpCyberwareSkillSearchMouseDownHandler, true);
      }

      if (this._cpCyberwareSkillSearchRoot && this._cpCyberwareSkillSearchClickHandler) {
        this._cpCyberwareSkillSearchRoot.removeEventListener("click", this._cpCyberwareSkillSearchClickHandler, true);
      }
    } catch (_) {}

    this._cpCyberwareSkillSearchRoot = null;
    this._cpCyberwareSkillSearchInputHandler = null;
    this._cpCyberwareSkillSearchChangeHandler = null;
    this._cpCyberwareSkillSearchMouseDownHandler = null;
    this._cpCyberwareSkillSearchClickHandler = null;
  }

  async _cpSyncCyberwareChipSkills() {
    if (typeof this._cp_syncChipLevelsToSkills === "function") {
      await this._cp_syncChipLevelsToSkills();
    }

    if (typeof this._cp_syncActiveFlagsToSkills === "function") {
      await this._cp_syncActiveFlagsToSkills();
    }
  }

  async _cpRenderCyberwareSkillKeySheets(skillKey) {
    const actor = this.item.actor ?? this.actor ?? null;
    if (!actor || !skillKey) return;

    const byId = actor.items.get(skillKey);
    if (byId?.type === "skill") {
      await this._cpRenderOpenSheet(byId);
    }

    // Legacy fallback: older maps may still store localized skill names as keys.
    const byName = actor.items.filter((item) => item.type === "skill" && item.name === skillKey);
    for (const skill of byName) {
      await this._cpRenderOpenSheet(skill);
    }
  }

  async _cpAddCyberwareSkillFromInput(input, pathPrefix, { syncChipSkills = false } = {}) {
    if (!input) return false;

    const rawValue = String(input.value ?? "").trim();
    if (!rawValue) return false;

    const skillKey = this._resolveSkillKey(rawValue);
    if (!skillKey) return false;

    const current = foundry.utils.getProperty(this.item.system, pathPrefix.replace(/^system\./, "")) || {};
    if (current[skillKey] != null) {
      input.value = "";
      input.blur();
      return true;
    }

    await this._cpSetCyberwarePath(`${pathPrefix}.${skillKey}`, 0);

    if (syncChipSkills) {
      await this._cpSyncCyberwareChipSkills();
      await this._cpRenderCyberwareSkillKeySheets(skillKey);
      await this._cpRenderCyberwareDependentSheets(this.item.actor ?? this.actor ?? null);
    }

    input.value = "";
    input.blur();

    return true;
  }

  _cpActivateCyberwareSkillSearchControls(root) {
    this._cpRemoveCyberwareSkillSearchListeners();

    if (!root?.addEventListener) return;
    if (this.item.type !== "cyberware") return;

    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;

    const handleSkillSearch = async (event) => {
      const input = event.target?.closest?.("input[name='cw-skill-search'], input[name='cw-chip-skill-search']");
      if (!input || !root.contains(input)) return;

      const isChipSkillSearch = input.name === "cw-chip-skill-search";
      const pathPrefix = isChipSkillSearch
        ? "system.CyberWorkType.ChipSkills"
        : "system.CyberWorkType.Skill";

      const added = await this._cpAddCyberwareSkillFromInput(input, pathPrefix, {
        syncChipSkills: isChipSkillSearch
      });

      if (!added) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };

    const handleSkillSearchMouseDown = (event) => {
      const input = event.target?.closest?.("input[name='cw-skill-search'], input[name='cw-chip-skill-search']");
      if (!input || !root.contains(input)) return;
      if (root.ownerDocument.activeElement !== input) return;

      const listId = input.getAttribute("list");
      if (!listId) return;

      event.preventDefault();

      input.removeAttribute("list");
      input.blur();

      setTimeout(() => {
        input.setAttribute("list", listId);
        input.focus();
      }, 150);
    };

    const handleSkillRemove = async (event) => {
      const control = event.target?.closest?.(".cw-remove-chipskill");
      if (!control || !root.contains(control)) return;

      const skillKey = String(control.dataset.key ?? "");
      if (!skillKey) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      await this._cpDeleteCyberwarePath(`system.CyberWorkType.ChipSkills.${skillKey}`);
      await this._cpSyncCyberwareChipSkills();
      await this._cpRenderCyberwareSkillKeySheets(skillKey);
      await this._cpRenderCyberwareDependentSheets(this.item.actor ?? this.actor ?? null);
    };

    root.addEventListener("input", handleSkillSearch, true);
    root.addEventListener("change", handleSkillSearch, true);
    root.addEventListener("mousedown", handleSkillSearchMouseDown, true);
    root.addEventListener("click", handleSkillRemove, true);

    this._cpCyberwareSkillSearchRoot = root;
    this._cpCyberwareSkillSearchInputHandler = handleSkillSearch;
    this._cpCyberwareSkillSearchChangeHandler = handleSkillSearch;
    this._cpCyberwareSkillSearchMouseDownHandler = handleSkillSearchMouseDown;
    this._cpCyberwareSkillSearchClickHandler = handleSkillRemove;
  }

  _cpActivateSkillItemControls(root) {
    if (!root?.addEventListener) return;
    if (this.item.type !== "skill") return;

    if (this._cpSkillItemControlsRoot && this._cpSkillItemControlsHandler) {
      try {
        this._cpSkillItemControlsRoot.removeEventListener("change", this._cpSkillItemControlsHandler, true);
      } catch (_) {}
    }

    const handler = async (event) => {
      const input = event.target;
      if (!input?.matches?.(
        'input[name="system.level"], input[name="system.chipLevel"], input[name="system.isChipped"]'
      )) return;

      if (!root.contains(input)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      if (input.name === "system.level") {
        await this._cpHandleSkillLevelChange(input);
        return;
      }

      if (input.name === "system.chipLevel") {
        await this._cpHandleSkillChipLevelChange(input);
        return;
      }

      if (input.name === "system.isChipped") {
        await this._cpHandleSkillIsChippedChange(input);
      }
    };

    root.addEventListener("change", handler, true);

    this._cpSkillItemControlsRoot = root;
    this._cpSkillItemControlsHandler = handler;
  }

  _cpParseSkillNumber(value) {
    const n = Number.parseInt(value ?? 0, 10);
    return Number.isFinite(n) ? n : 0;
  }

  async _cpUpdateThisSkill(patch) {
    const actor = this.item.actor ?? this.actor ?? null;

    if (actor) {
      await actor.updateEmbeddedDocuments("Item", [
        { _id: this.item.id, ...patch }
      ], { render: false });
      return;
    }

    await this.item.update(patch, { render: false });
  }

  _cpFindChipsForThisSkill() {
    const actor = this.item.actor ?? this.actor ?? null;
    if (!actor) return [];

    const skillId = this.item.id;
    const skillName = this.item.name;

    return actor.items.filter((item) => {
      if (item.type !== "cyberware") return false;
      if (!cwHasType(item, "Chip")) return false;
      if (item.system?.equipped === false) return false;

      const chipSkills = item.system?.CyberWorkType?.ChipSkills;
      if (!chipSkills) return false;

      return (
        (skillId && Object.prototype.hasOwnProperty.call(chipSkills, skillId)) ||
        Object.prototype.hasOwnProperty.call(chipSkills, skillName)
      );
    });
  }

  _cpIsSheetOpen(sheet) {
    return !!(sheet?.rendered || sheet?.element);
  }

  async _cpRenderOpenSheet(document) {
    const sheet = document?.sheet;
    if (!this._cpIsSheetOpen(sheet)) return;

    try {
      await sheet.render({ force: true });
    } catch (_) {
      try {
        await sheet.render(true);
      } catch (_) {}
    }
  }

  async _cpRenderSkillRelatedSheets({ actor = null, chips = [] } = {}) {
    await this._cpRenderOpenSheet(actor);

    for (const chip of chips) {
      await this._cpRenderOpenSheet(chip);
    }

    await this.render({ force: true });
  }

  async _cpHandleSkillLevelChange(input) {
    const value = this._cpParseSkillNumber(input.value);
    const prev = Number(this.item.system?.level || 0);

    if (prev !== value) {
      await this._cpUpdateThisSkill({ "system.level": value });
    }

    const actor = this.item.actor ?? this.actor ?? null;

    await this._cpRenderSkillRelatedSheets({ actor });
  }

  async _cpHandleSkillIsChippedChange(input) {
    const checked = !!input.checked;
    const prev = !!this.item.system?.isChipped;

    if (prev === checked) {
      await this.render({ force: true });
      return;
    }

    const actor = this.item.actor ?? this.actor ?? null;
    const chips = this._cpFindChipsForThisSkill();

    if (actor && chips.length) {
      const chipUpdates = chips.map((chip) => ({
        _id: chip.id,
        "system.CyberWorkType.ChipActive": checked
      }));

      await actor.updateEmbeddedDocuments("Item", chipUpdates, { render: false });

      if (typeof this._cp_syncChipLevelsToSkills === "function") {
        await this._cp_syncChipLevelsToSkills();
      }

      if (typeof this._cp_syncActiveFlagsToSkills === "function") {
        await this._cp_syncActiveFlagsToSkills();
      }
    } else {
      await this._cpUpdateThisSkill({
        "system.isChipped": checked,
        ...deleteFieldUpdate("system.chipped")
      });
    }

    await this._cpRenderSkillRelatedSheets({ actor, chips });
  }

  async _cpHandleSkillChipLevelChange(input) {
    const value = this._cpParseSkillNumber(input.value);
    const prev = Number(this.item.system?.chipLevel || 0);

    if (prev !== value) {
      await this._cpUpdateThisSkill({ "system.chipLevel": value });
    }

    const actor = this.item.actor ?? this.actor ?? null;
    const chips = this._cpFindChipsForThisSkill();

    if (actor && chips.length) {
      const skillId = this.item.id;
      const skillName = this.item.name;

      const chipUpdates = chips.map((chip) => {
        const chipSkills = chip.system?.CyberWorkType?.ChipSkills || {};
        const patch = { _id: chip.id };

        if (skillId && Object.prototype.hasOwnProperty.call(chipSkills, skillId)) {
          patch[`system.CyberWorkType.ChipSkills.${skillId}`] = value;
        }

        // Legacy fallback: older data may still store chip skill maps by localized name.
        if (Object.prototype.hasOwnProperty.call(chipSkills, skillName)) {
          patch[`system.CyberWorkType.ChipSkills.${skillName}`] = value;
        }

        return patch;
      }).filter((patch) => Object.keys(patch).length > 1);

      if (chipUpdates.length) {
        await actor.updateEmbeddedDocuments("Item", chipUpdates, { render: false });
      }

      if (typeof this._cp_syncChipLevelsToSkills === "function") {
        await this._cp_syncChipLevelsToSkills();
      }
    }

    await this._cpRenderSkillRelatedSheets({ actor, chips });
  }

  /* -------------------------------------------------------------------------- */
  /*  Net-new feature controls (not present on upstream supercoon/v1.2.0-dev).    */
  /*  Ammo system (blast/spread/buy-box/modifier/effect-menu/locker), vehicle-     */
  /*  weapon shell variants, cyberware surgical install, comma-decimal inputs.     */
  /*                                                                               */
  /*  These mirror his bind-once delegated idiom (_cpActivateBasicItemActions):    */
  /*  one capture-phase listener on the persistent V2 root + closest() dispatch.   */
  /*  All are root-bound (no ownerDocument/document listeners), so they die with   */
  /*  the root on close — no _preClose teardown needed (unlike his MechanicType/   */
  /*  VehicleSpeed helpers, which bind to ownerDocument and therefore tear down).  */
  /*                                                                               */
  /*  NOTE on guard order: the editable-check runs BEFORE the dataset bind-flag.   */
  /*  His _cpActivateBasicItemActions sets the flag first, which permanently       */
  /*  un-binds a sheet that first renders non-editable and later becomes editable  */
  /*  (the persistent root keeps the flag). The actor-sheet A2 migration hit this; */
  /*  we use the corrected order here.                                             */
  /* -------------------------------------------------------------------------- */

  /** Comma-decimal nicety: rewrite "1,5" -> "1.5" on number inputs (locale-friendly). */
  _cpActivateNumericCommaInputs(root) {
    if (!root?.addEventListener) return;
    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;
    if (root.dataset.cpNumericCommaBound === "1") return;
    root.dataset.cpNumericCommaBound = "1";

    // Capture phase so the value is normalized before the V2 form's submitOnChange reads it.
    root.addEventListener("change", (event) => {
      const el = event.target?.closest?.('input[type="number"]');
      if (!el || !root.contains(el)) return;
      if (typeof el.value === "string" && el.value.includes(",")) {
        el.value = el.value.replace(",", ".");
      }
    }, true);
  }

  /** Cyberware "Install (Surgery)": pay surgery cost, roll humanity, apply damage, mark installed. */
  _cpActivateCyberwareInstall(root) {
    if (!root?.addEventListener) return;
    if (this.item.type !== "cyberware") return;
    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;
    if (root.dataset.cpCyberInstallBound === "1") return;
    root.dataset.cpCyberInstallBound = "1";

    root.addEventListener("click", async (event) => {
      const control = event.target?.closest?.(".cyber-install");
      if (!control || !root.contains(control)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      const actor = this.item?.actor;
      if (!actor) { ui.notifications?.warn(localize("ShopNoActor")); return; }
      await installCyberware(actor, this.item, { confirm: true });
    }, true);
  }

  /** Vehicle-weapon shell/warhead variants editor (array of {name,pen,burst,warhead,ap}). */
  _cpActivateVehicleWeaponShellControls(root) {
    if (!root?.addEventListener) return;
    if (this.item.type !== "vehicleWeapon") return;
    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;
    if (root.dataset.cpShellControlsBound === "1") return;
    root.dataset.cpShellControlsBound = "1";

    const svArray = () => Array.isArray(this.item.system?.shellVariants)
      ? foundry.utils.duplicate(this.item.system.shellVariants)
      : [];

    root.addEventListener("click", async (event) => {
      const add = event.target?.closest?.(".cp-sv-add");
      if (add && root.contains(add)) {
        event.preventDefault();
        const arr = svArray();
        arr.push({
          name: localize("Vehicle.NewShell"),
          pen: Number(this.item.system?.penetration) || 0,
          burst: Number(this.item.system?.burst) || 0,
          warhead: "",
          ap: false
        });
        await this.item.update({ "system.shellVariants": arr });
        return;
      }

      const remove = event.target?.closest?.(".cp-sv-remove");
      if (remove && root.contains(remove)) {
        event.preventDefault();
        const idx = Number(remove.dataset.index);
        const arr = svArray();
        if (Number.isFinite(idx) && idx >= 0 && idx < arr.length) {
          arr.splice(idx, 1);
          await this.item.update({ "system.shellVariants": arr });
        }
      }
    }, true);

    root.addEventListener("change", async (event) => {
      const field = event.target?.closest?.(".cp-sv");
      if (!field || !root.contains(field)) return;
      const idx = Number(field.closest(".cp-shellvar")?.dataset?.index);
      const key = field.dataset.field;
      const arr = svArray();
      if (!Number.isFinite(idx) || !key || idx < 0 || idx >= arr.length) return;
      arr[idx][key] = field.type === "checkbox"
        ? !!field.checked
        : (field.type === "number" ? (Number(String(field.value).replace(",", ".")) || 0) : field.value);
      await this.item.update({ "system.shellVariants": arr }, { render: false });
    }, true);
  }

  /** Ammo item controls: blast multipliers, quantity lock, buy-box, modifier load, effect-type menu. */
  _cpActivateAmmoControls(root) {
    if (!root?.addEventListener) return;
    if (this.item.type !== "ammo") return;
    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;
    if (root.dataset.cpAmmoControlsBound === "1") return;
    root.dataset.cpAmmoControlsBound = "1";

    root.addEventListener("change", async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      // Blast multiplier input (no name=; persisted manually).
      const blast = target.closest("input.ammo-blast-mult");
      if (blast && root.contains(blast)) {
        event.preventDefault();
        event.stopPropagation();

        const idx = Number(blast.dataset.index);
        if (!Number.isFinite(idx)) return;

        const val = Number(String(blast.value ?? "").replace(",", "."));
        const zones = Math.max(1, Math.min(10, Number(this.item.system?.blastZones ?? 4)));
        const defaultMult = (i) => 1 / (2 ** (i + 1));

        let cur = this.item.system?.blastMultipliers;
        if (!Array.isArray(cur)) {
          cur = Array.from({ length: zones }, (_, i) => defaultMult(i));
        } else {
          cur = cur.slice(0, zones);
          while (cur.length < zones) cur.push(defaultMult(cur.length));
        }
        cur[idx] = Number.isFinite(val) ? val : cur[idx];

        await this.item.update({ "system.blastMultipliers": cur }, { render: false });
        this.render(false);
        return;
      }

      // Modifier (load) select: seed the mechanical fields from the modifier definition.
      const modifier = target.closest("select.cp-ammo-modifier");
      if (modifier && root.contains(modifier)) {
        event.preventDefault();
        const modId = String(modifier.value ?? "standard");
        await this.item.update(applyAmmoModifierUpdate(modId));
        return;
      }

      // Effect-type multi-select menu checkboxes ("None" is exclusive).
      const fxCheckbox = target.closest(".ammo-ms-menu input[type=checkbox]");
      if (fxCheckbox && root.contains(fxCheckbox)) {
        const menuRoot = fxCheckbox.closest(".ammo-ms");
        if (!menuRoot) return;
        const menu = menuRoot.querySelector(".ammo-ms-menu");

        let next = Array.from(menu.querySelectorAll("input[type=checkbox]:checked")).map(i => i.value);
        const changed = fxCheckbox.value;
        const turnedOn = fxCheckbox.checked;

        if (changed === "None" && turnedOn) {
          next = ["None"];
          menu.querySelectorAll("input[type=checkbox]").forEach(i => { i.checked = (i.value === "None"); });
        } else if (turnedOn) {
          const none = menu.querySelector('input[value="None"]');
          if (none) none.checked = false;
          next = next.filter(v => v !== "None");
        }

        if (!next.length) {
          next = ["None"];
          const none = menu.querySelector('input[value="None"]');
          if (none) none.checked = true;
        }

        await this._ammoSet("system.effectTypes", next);
        return;
      }
    }, true);

    root.addEventListener("click", async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      // Manual-quantity lock toggle.
      const lock = target.closest(".cp-ammo-qty-lock");
      if (lock && root.contains(lock)) {
        event.preventDefault();
        event.stopPropagation();
        const locked = !(this.item.system?.qtyLocked ?? true);
        await this.item.update({ "system.qtyLocked": locked });
        return;
      }

      // Buy a box: restock this exact ammo item.
      const buyBox = target.closest(".cp-ammo-buy-box");
      if (buyBox && root.contains(buyBox)) {
        event.preventDefault();
        event.stopPropagation();
        await this._cpBuyAmmoBox();
        return;
      }

      // Effect-menu open/close trigger.
      const trigger = target.closest(".ammo-ms-trigger");
      if (trigger && root.contains(trigger)) {
        event.preventDefault();
        const menuRoot = trigger.closest(".ammo-ms");
        if (menuRoot) menuRoot.classList.toggle("open");
        return;
      }

      // Click anywhere outside an open effect-menu closes it.
      if (!target.closest(".ammo-ms")) {
        root.querySelectorAll(".ammo-ms.open").forEach(m => m.classList.remove("open"));
      }
    }, true);
  }

  /**
   * Restock THIS exact ammo item by one box. Box size/price come from the caliber+modifier
   * registry, with the item's own boxSize/boxCost as optional overrides; charges the owning actor.
   */
  async _cpBuyAmmoBox() {
    const sys = this.item.system ?? {};
    const registryBox = getCaliberBox(sys.caliber ?? "");
    const boxSize = Math.max(0, Math.floor(Number(sys.boxSize) > 0 ? Number(sys.boxSize) : registryBox.box));
    const boxCost = Math.max(0, Number(sys.boxCost) > 0 ? Number(sys.boxCost) : getAmmoBoxPrice(sys.caliber ?? "", sys.modifier ?? "standard"));

    if (boxSize <= 0) {
      ui.notifications.warn(game.i18n.localize("CYBERPUNK.AmmoBuyNoBoxSize"));
      return;
    }

    const actor = this.item.actor;
    const qty = Number(sys.quantity ?? 0);

    // Unowned (world/compendium) ammo has no one to charge — just stock the box.
    if (!actor) {
      await this.item.update({ "system.quantity": qty + boxSize });
      ui.notifications.info(game.i18n.format("CYBERPUNK.AmmoBoughtNoCharge", { count: boxSize }));
      return;
    }

    // Access gate: players may be restricted from buying (GM-only / "buy at a shop").
    const gate = canBuyAmmo();
    if (!gate.ok) { ui.notifications.warn(gate.reason); return; }

    const funds = Number(actor.system?.eurobucks ?? 0);
    if (funds < boxCost) {
      ui.notifications.warn(game.i18n.format("CYBERPUNK.AmmoBuyInsufficientFunds", { cost: boxCost, funds }));
      return;
    }

    // Charge first, then stock; if stocking throws, refund so eurobucks aren't lost (the charge-first/
    // refund-on-failure guard shop/purchase.js and the other buy paths use).
    await actor.update({ "system.eurobucks": funds - boxCost });
    try {
      await this.item.update({ "system.quantity": qty + boxSize });
    } catch (err) {
      console.error("cp2020-augmented | Ammo restock failed after charging, refunding.", err);
      await actor.update({ "system.eurobucks": funds }).catch(() => {});
      ui.notifications.error(game.i18n.localize("CYBERPUNK.AmmoBuyFailed"));
      return;
    }
    ui.notifications.info(game.i18n.format("CYBERPUNK.AmmoBought", { count: boxSize, cost: boxCost }));
  }

  _cpActivateNotesEditor(root) {
    this._cpSetupNotesActions(root);
    this._cpSetupNotesAutosave(root);
  }

  async _cpExitNotesEditing(root, { render = false } = {}) {
    if (!this._cpNotesEditing) return;

    await this._cpFlushNotesAutosave(root, { force: true, serialize: false });
    this._cpNotesEditing = false;

    if (render && this.rendered) {
      await this.render({ force: true });
    }
  }

  _cpSetupNotesActions(root) {
    if (!root?.addEventListener) return;

    if (this._cpNotesActionsRoot && this._cpNotesActionsHandler) {
      try {
        this._cpNotesActionsRoot.removeEventListener("click", this._cpNotesActionsHandler, true);
      } catch (_) {}
    }

    const handler = async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const editButton = target.closest('[data-action="notes-edit"]');
      if (!editButton) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      this._cpNotesEditing = true;
      await this.render({ force: true });
    };

    root.addEventListener("click", handler, true);

    this._cpNotesActionsRoot = root;
    this._cpNotesActionsHandler = handler;
  }

  _cpSetupNotesAutosave(root) {
    if (!root?.addEventListener) return;

    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;

    if (!this._cpNotesAutosaveState) {
      this._cpNotesAutosaveState = {
        saving: false,
        pending: false,
        pendingForce: false,
        pendingSerialize: false,
        timer: null,
        lastSaved: String(this.item.system?.notes ?? "")
      };
    }

    if (this._cpNotesAutosaveRoot && this._cpNotesAutosaveHandler) {
      for (const eventName of ["save", "input", "change", "close"]) {
        try {
          this._cpNotesAutosaveRoot.removeEventListener(eventName, this._cpNotesAutosaveHandler, true);
        } catch (_) {}
      }
    }

    const isNotesEvent = (event) => {
      const target = event?.target;
      if (!target?.closest) return false;

      const editor = target.closest(".cp-notes-editor");
      if (!editor) return false;

      const notesTab = target.closest('.tab[data-tab="notes"]');
      return !!notesTab;
    };

    const scheduleFlush = ({ force = false, serialize = false, delay = 250 } = {}) => {
      const state = this._cpNotesAutosaveState;
      if (!state) return;

      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }

      state.timer = setTimeout(() => {
        state.timer = null;
        this._cpFlushNotesAutosave(root, { force, serialize });
      }, delay);
    };

    const handler = (event) => {
      if (!isNotesEvent(event)) return;

      if (event.type === "save" || event.type === "close") {
        window.setTimeout(async () => {
          await this._cpFlushNotesAutosave(root, { force: true, serialize: false });

          if (this._cpNotesEditing) {
            this._cpNotesEditing = false;
            await this.render({ force: true });
          }
        }, 0);

        return;
      }

      scheduleFlush({ force: false, serialize: false, delay: 350 });
    };

    for (const eventName of ["save", "input", "change", "close"]) {
      root.addEventListener(eventName, handler, true);
    }

    this._cpNotesAutosaveRoot = root;
    this._cpNotesAutosaveHandler = handler;
  }

  _cpReadNotesHTML(root, { serialize = false } = {}) {
    if (!root) return null;

    const reader = serialize ? saveRichEditorHTML : getRichEditorHTML;
    const html = reader(this, root, "system.notes", [".cp-notes-view"]);

    if (html != null) return html;

    return String(this.item.system?.notes ?? "");
  }

  async _cpFlushNotesAutosave(root, { force = false, serialize = false } = {}) {
    const st = this._cpNotesAutosaveState;
    if (!st) return;

    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }

    if (st.saving) {
      st.pending = true;
      st.pendingForce = st.pendingForce || force;
      st.pendingSerialize = st.pendingSerialize || serialize;
      return;
    }

    const html = this._cpReadNotesHTML(root, { serialize });
    if (html == null) return;
    if (!force && st.lastSaved === html) return;

    st.saving = true;
    try {
      await this.item.update({ "system.notes": html }, { render: false });
      st.lastSaved = html;
    } catch (err) {
      console.warn("CP2020: item notes save failed", err);
    } finally {
      st.saving = false;

      if (st.pending) {
        const pendingForce = st.pendingForce;
        const pendingSerialize = st.pendingSerialize;

        st.pending = false;
        st.pendingForce = false;
        st.pendingSerialize = false;

        await this._cpFlushNotesAutosave(root, {
          force: pendingForce,
          serialize: pendingSerialize
        });
      }
    }
  }

  /** @override */
  async _preClose(options) {
    try {
      const root = getHtmlElement(this.element);

      if (this._cpNotesAutosaveState?.timer) {
        clearTimeout(this._cpNotesAutosaveState.timer);
        this._cpNotesAutosaveState.timer = null;
      }

      await this._cpFlushNotesAutosave(root, { force: true, serialize: false });
      this._cpNotesEditing = false;
    } catch (_) {}

    try {
      if (this._cpNotesAutosaveRoot && this._cpNotesAutosaveHandler) {
        for (const eventName of ["save", "input", "change", "close"]) {
          this._cpNotesAutosaveRoot.removeEventListener(eventName, this._cpNotesAutosaveHandler, true);
        }
      }

      this._cpNotesAutosaveRoot = null;
      this._cpNotesAutosaveHandler = null;
    } catch (_) {}

    try {
      if (this._cpNotesActionsRoot && this._cpNotesActionsHandler) {
        this._cpNotesActionsRoot.removeEventListener("click", this._cpNotesActionsHandler, true);
      }

      this._cpNotesActionsRoot = null;
      this._cpNotesActionsHandler = null;
    } catch (_) {}

    try {
      if (this._cpVehicleSpeedRoot && this._cpVehicleSpeedHandler) {
        this._cpVehicleSpeedRoot.ownerDocument.removeEventListener("click", this._cpVehicleSpeedHandler, true);
      }

      this._cpVehicleSpeedRoot = null;
      this._cpVehicleSpeedHandler = null;
    } catch (_) {}

    try {
      this._cpRemoveCyberwareBasicListeners();
    } catch (_) {}

    try {
      this._cpRemoveCyberwareMechanicTypeListeners();
    } catch (_) {}

    try {
      this._cpRemoveCyberwareSkillSearchListeners();
    } catch (_) {}

    try {
      if (this._cpSkillItemControlsRoot && this._cpSkillItemControlsHandler) {
        this._cpSkillItemControlsRoot.removeEventListener("change", this._cpSkillItemControlsHandler, true);
      }

      this._cpSkillItemControlsRoot = null;
      this._cpSkillItemControlsHandler = null;
    } catch (_) {}

    return super._preClose(options);
  }

  /** @override */
  _processFormData(event, form, formData) {
    const data = super._processFormData(event, form, formData);

    if (this.item.type === "cyberware") {
      const pickLastString = (v) => {
        if (Array.isArray(v)) return v.length ? String(v[v.length - 1] ?? "") : "";
        return v == null ? "" : String(v);
      };
      const t = foundry.utils.getProperty(data, "system.cyberwareType");
      if (t !== undefined) {
        foundry.utils.setProperty(data, "system.cyberwareType", pickLastString(t));
      }

      const ap = foundry.utils.getProperty(data, "system.Module.AllowedParentCyberwareType");
      if (ap !== undefined) {
        foundry.utils.setProperty(data, "system.Module.AllowedParentCyberwareType", pickLastString(ap));
      }

      const slots = foundry.utils.getProperty(data, "system.Module.SlotsTaken");
      if (slots !== undefined) {
        const n = Number(slots);
        foundry.utils.setProperty(data, "system.Module.SlotsTaken", Number.isFinite(n) ? n : 0);
      }
    }

    if (this.item.type === "skill") {
      const fixNum = v => {
        const n = parseInt(v ?? 0, 10);
        return isNaN(n) ? 0 : n;
      };

      // In Foundry v14 an ItemSheet change submit may contain only the changed
      // input, not the complete form. Do not create missing skill fields here,
      // or changing level will overwrite chipLevel with 0 and vice versa.
      if (foundry.utils.hasProperty(data, "system.level")) {
        foundry.utils.setProperty(data, "system.level", fixNum(foundry.utils.getProperty(data, "system.level")));
      }
      if (foundry.utils.hasProperty(data, "system.chipLevel")) {
        foundry.utils.setProperty(data, "system.chipLevel", fixNum(foundry.utils.getProperty(data, "system.chipLevel")));
      }
    }

    const legacy = foundry.utils.getProperty(data, "system.chipped");
    if (legacy !== undefined) {
      foundry.utils.setProperty(data, "system.isChipped", !!legacy);
      if (data.system && "chipped" in data.system) delete data.system.chipped;
    }

    if (this.item.type === "cyberware") {
      const equip = foundry.utils.getProperty(data, "system.equipped");
      if (equip === true) {
        const zone = String(
          foundry.utils.getProperty(data, "system.MountZone") ||
          foundry.utils.getProperty(data, "system.CyberBodyType.Type") ||
          this.item.system?.MountZone ||
          this.item.system?.CyberBodyType?.Type ||
          ""
        );
        const loc = String(
          foundry.utils.getProperty(data, "system.CyberBodyType.Location") ||
          this.item.system?.CyberBodyType?.Location ||
          ""
        );
        if ((zone === "Arm" || zone === "Leg") && !loc) {
          foundry.utils.setProperty(data, "system.CyberBodyType.Location", "Left");
        }
      }
    }

    return data;
  }

  /**
   * Collect the chip level aggregate for all of the actor's chip implants
   * Take the maximum chip level for each affected skill.
  */
  async _cp_syncChipLevelsToSkills() {
    const actor = this.item.actor;
    if (!actor) return;

    const chipItems = actor.items.filter(i =>
      i.type === "cyberware" &&
      cwHasType(i, "Chip") &&
      i.system?.equipped !== false &&
      !!i.system?.CyberWorkType?.ChipActive
    );

    const agg = {};
    for (const cw of chipItems) {
      const map = cw.system?.CyberWorkType?.ChipSkills || {};
      for (const [key, lvl] of Object.entries(map)) {
        const n = Number(lvl) || 0;
        if (n < 0) continue;
        agg[key] = Math.max(agg[key] ?? 0, n);
      }
    }

    const skillItems = actor.items.filter(i => i.type === "skill");
    const updates = [];
    const updatedSkillIds = [];

    for (const s of skillItems) {
      const want = Number(agg[s.id] ?? agg[s.name] ?? 0);
      const cur  = Number(s.system?.chipLevel || 0);
      if (want !== cur) {
        updates.push({ _id: s.id, "system.chipLevel": want });
        updatedSkillIds.push(s.id);
      }
    }

    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, { render: false });

      for (const sid of updatedSkillIds) {
        const sk = actor.items.get(sid);
        if (sk?.sheet?.rendered) sk.sheet.render(true);
      }
    }
  }
  /**
   * Set system.isChipped for skills based on all active chips of the actor
   * true — if there is at least one active chip for the skill that grants this skill
   * false — if there are no active chips for the skill
  */
  async _cp_syncActiveFlagsToSkills() {
    const actor = this.item.actor;
    if (!actor) return;

    const activeChips = actor.items.filter(i =>
      i.type === "cyberware" &&
      cwHasType(i, "Chip") &&
      i.system?.equipped !== false &&
      !!i.system?.CyberWorkType?.ChipActive
    );

    const activeMap = {};
    for (const ch of activeChips) {
      const skills = ch.system?.CyberWorkType?.ChipSkills || {};
      for (const key of Object.keys(skills)) activeMap[key] = true;
    }

    const skills = actor.items.filter(i => i.type === "skill");
    const updates = [];
    const updatedIds = [];
    for (const s of skills) {
      const want = !!(activeMap[s.id] ?? activeMap[s.name]);
      const cur  = !!(s.system?.isChipped);
      if (want !== cur) {
        updates.push({ _id: s.id, "system.isChipped": want });
        updatedIds.push(s.id);
      }
    }
    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, { render: false });
      for (const sid of updatedIds) {
        const sk = actor.items.get(sid);
        if (sk?.sheet?.rendered) sk.sheet.render(true);
      }
    }
  }
}
