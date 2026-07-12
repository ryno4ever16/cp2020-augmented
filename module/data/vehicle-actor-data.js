import {
  arrayField,
  booleanField,
  htmlField,
  numberField,
  objectField,
  stringField
} from "./schema-helpers.js";

import { acpaAreaSDP, chassisStats, realityInterface, reflexControl, acpaReflexMod, acpaEffectiveRef, acpaArmorWeight, acpaArmorCost, acpaSib, acpaRunM, acpaJumpM } from "../vehicle/vehicle-acpa.js";
import { isPACombatSenseSkill, isPAPilotSkill } from "../utils.js";

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

/**
 * Vehicle / ACPA actor (CP2020 Core "Vehicles in FNFF" p.112 + Maximum Metal).
 * Standalone schema — vehicles have no stats/skills/hitLocations. Armor is stored per
 * facing (Core uses `front` as its single SP); Maximum Metal needs all five for flank rules.
 * Derived Armor Value (SP/20) and Body Value (SDP/20, or STR/20 for ACPA) are recomputed
 * in prepareDerivedData. Canvas link to the art Tile lives in flags, not the schema.
 *
 * Augmented Edition: registered as the module sub-type `cp2020-augmented.vehicle` (data in
 * `system.*`, no flags); embedded weapon/system Items are `cp2020-augmented.vehicleWeapon`
 * and `cp2020-augmented.acpaSystem`.
 */
export class CyberpunkVehicleActorData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const f = foundry.data.fields;
    return {
      vehicleType: stringField("car"),   // car/sportscar/limo/AV-4/AV-6/AV-7/cycle/truck/rotor/osprey/boat/tank/APC/acpa
      isACPA:      booleanField(false),
      str:         numberField(0),        // ACPA chassis STR — drives Body Value when isACPA

      // Armor SP per facing + structure, as nested SchemaFields (NOT bare objectField): Foundry applies
      // migrateData to UPDATE CHANGES too, so a mergeDefaults floor over a bare objectField expanded a
      // partial dotted update (e.g. {"system.sp.front": 10} from a future armor-repair/API path) into a
      // full object of defaults, WIPING the other facings. SchemaFields give per-key merge on partial
      // updates AND fill missing keys on legacy sources at clean time — both floors, no fills over
      // changes. Mirrors the fix already applied to vehicle-item-data (speed/fuel).
      sp: new f.SchemaField({
        front:  new f.NumberField({ initial: 0 }),
        side:   new f.NumberField({ initial: 0 }),
        rear:   new f.NumberField({ initial: 0 }),
        top:    new f.NumberField({ initial: 0 }),
        bottom: new f.NumberField({ initial: 0 }),
      }),
      sdp: new f.SchemaField({
        value: new f.NumberField({ initial: 0 }),
        max:   new f.NumberField({ initial: 0 }),
      }),

      // Movement
      topSpeed:   numberField(0),
      safeSpeed:  numberField(0),
      acc:        numberField(0),
      dec:        numberField(0),
      controlMod: numberField(0),

      // Crew
      crewSlots:      numberField(1),
      passengerSlots: numberField(0),

      // Systems
      vehicleLink:   booleanField(false),
      damageControl: booleanField(false),
      compositeArmor: booleanField(false),   // halves shaped-charge (HEAT) Penetration (MM p.23)
      reactiveArmor: booleanField(false),    // explosive tiles: 1d10 (2-10) halves shaped-charge Pen, degrades w/ hits (MM p.23)
      reactiveHits:  numberField(0),         // shaped/HE hits absorbed; −1 to the deflect roll per 2; reset by "Replace"
      sensors:       booleanField(false),    // radar/detectors: auto-detect inbound missiles (90%)
      antiMissile:   booleanField(false),    // AGAMS/AEAMS: can attempt to shoot down inbound missiles
      fireControl:   numberField(0),
      countermeasures: arrayField(stringField(), []),
      weaponMounts:    arrayField(null, []),   // [{ name, penetration, rof, shots, range, arc, ammoType }]

      // Status (set by the damage resolver in later phases)
      onFire:         booleanField(false),
      immobilized:    booleanField(false),
      damagedSystems: arrayField(stringField(), []),

      // ACPA combat status (Maximum Metal p.55-56) — written by the powered-armor damage resolver.
      // Additive: existing actors get the schema defaults on load (no migration / relaunch needed).
      strDamage:    numberField(0),    // accumulated Suit STR loss from criticals
      refDamage:    numberField(0),    // accumulated Suit REF loss (already ÷2 per the chart)
      powerHours:   numberField(24),   // remaining power-cell life in hours (24h default)
      coolingTimer: numberField(0),    // minutes until heatstroke (0 = cooling OK)
      heatstrokeLevel: numberField(0), // 0 = none; ≥1 escalating Stun-save level after build-up (Serious→…)
      interfaceOut: numberField(0),    // rounds the interface/electronics are out
      seizeUp:      numberField(0),    // rounds a body area is seized up

      // ACPA frame structure (Maximum Metal p.61): CURRENT per-area frame SDP (damage tracked by the
      // powered-armor resolver). Max + chassis stats are DERIVED from chassis STR below.
      frameSDP:    objectField({ head: 0, rArm: 0, lArm: 0, rLeg: 0, lLeg: 0, torso: 0 }),

      // ACPA build selections (Maximum Metal p.64-65). Additive — existing actors get these defaults
      // on load (no migration / relaunch). Defaults are the neutral military baseline: Full-HUD
      // Wideband (SIB 0, so no surprise to existing suits) + Advanced reflex/control (full REF, max 10).
      realityInterface: stringField("FULL_HUD_WIDEBAND"),
      reflexControl:    stringField("ADVANCED"),
      // GM override on the operating-REF cap (0 = RAW, the Reflex/Control system's own maxRef).
      // Exists for the printed interlocked cyborg/ACPA exception (Firestorm: Shockwave — a
      // directly-wired full-conversion pilot is not subject to the plug/vehicle-link caps; the
      // DaiOni's REF 15 + 2 = 17). The construction picker itself stays RAW-capped.
      refCapOverride:   numberField(0),
      commandComputer:  booleanField(false),   // C3: +1 initiative/awareness while linked (integrable with any)
      pilotId:          stringField(""),        // linked pilot character actor (its REF + takes overflow damage)
      pilotRef:         numberField(0),         // fallback pilot base REF when no pilot actor is linked
      trooperCapacity:  numberField(114),       // pilot+gear weight set aside for SIB (114 std; Russian 136; elite 80-91)
      systemsWeight:    numberField(0),          // aggregate weight of mounted systems (D-4d computes this; manual for now)
      carriedGearKg:    numberField(0),          // GM-entered hand-held / ejectable external gear weight (MM p.57 overload). Additive default → legacy suits load as 0.

      // ACPA combat pole (Unit D). "" = auto (a linked pilot ⇒ detailed MM p.52, no pilot ⇒ quick-kill
      // MM p.6); "detailed" / "quickkill" force a pole. Additive default → existing suits load as auto,
      // no migration. Read by acpaResolveMode in vehicle-damage.js.
      acpaCombatModel:  stringField(""),

      // Derived (recomputed each prepare; stored so they're available to templates/rolls)
      armorValue: objectField({ front: 0, side: 0, rear: 0, top: 0, bottom: 0 }),
      bodyValue:  numberField(0),
      destroyed:  booleanField(false),
      // ACPA-derived frame stats (from chassis STR via the Chassis Inventory Table).
      frameSDPMax: objectField({ head: 0, rArm: 0, lArm: 0, rLeg: 0, lLeg: 0, torso: 0 }),
      toughness:   numberField(0),    // damage-reduction Toughness Mod (negative)
      damMod:      stringField(""),   // linear-frame melee Damage Mod (display)
      lift:        numberField(0),
      carry:       numberField(0),
      // ACPA-derived interface/reflex stats (from the Reality Interface + Reflex/Control selections).
      dfb:          numberField(0),    // Direct-Fire Bonus — to-hit mod when the suit fires its weapons
      interfaceSib: numberField(0),    // Reality Interface's contribution to the suit's Initiative Bonus
      interfaceSdp: numberField(0),    // Reality Interface SDP (build budget)
      maxRef:       numberField(10),   // operating-REF cap from the Reflex/Control system
      refMod:       numberField(0),    // REF modifier from the Reflex/Control system
      effectiveRef: numberField(0),    // clamp(pilotRef + refMod, 0..maxRef) − refDamage
      // ACPA-derived weight + initiative (from the Armor Inventory + SIB derivation, MM p.61-62).
      armorWeight:  numberField(0),    // armor-shell weight (kg) from the chosen shell SP
      armorCost:    numberField(0),    // armor-shell cost (eb) from the chosen shell SP
      mountedSystemsWeight: numberField(0),  // summed weight of embedded acpaSystem Items
      mountedSystemsCost:   numberField(0),  // summed cost of embedded acpaSystem Items
      totalWeight:  numberField(0),    // total fully-loaded weight (chassis + armor + trooper + systems)
      buildCost:    numberField(0),    // total build cost (chassis + armor + interface + reflex + systems)
      sib:          numberField(0),    // Suit Initiative Bonus = round(cap ÷ totalWeight) − 1 + interface SIB

      notes: htmlField("")
    };
  }

  static migrateData(source) {
    source ??= {};
    // sp/sdp are nested SchemaFields now (per-key merge on partial updates + legacy-key fill at clean
    // time), so the old mergeDefaults floors here — which expanded a partial dotted sp/sdp update into a
    // full object of defaults and WIPED the un-named facings/keys (the documented partial-update wipe) —
    // are removed. Only the value-preserving SOP→SDP renames remain below.
    // Renamed the ACPA frame structural fields SOP→SDP (the book's term is Structural Damage Points;
    // "SOP" was an OCR artifact in the Maximum Metal scan). Carry pre-1.0.3 stored values forward.
    if (hasOwn(source, "frameSOP")    && !hasOwn(source, "frameSDP"))    source.frameSDP    = source.frameSOP;
    if (hasOwn(source, "frameSOPMax") && !hasOwn(source, "frameSDPMax")) source.frameSDPMax = source.frameSOPMax;
    if (hasOwn(source, "interfaceSop") && !hasOwn(source, "interfaceSdp")) source.interfaceSdp = source.interfaceSop;
    return super.migrateData(source);
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    const av = (sp) => Math.round((Number(sp) || 0) / 20);   // Armor Value = SP/20 (MM p.4)
    const sp = this.sp ?? {};
    this.armorValue = {
      front: av(sp.front), side: av(sp.side), rear: av(sp.rear), top: av(sp.top), bottom: av(sp.bottom)
    };
    // Body Value = SDP/20; ACPA uses chassis STR as its SDP source.
    const sdpMax = this.isACPA ? (Number(this.str) || 0) : (Number(this.sdp?.max) || 0);
    this.bodyValue = Math.round(sdpMax / 20);
    // An ACPA does NOT track the vehicle-level sdp.value (its structure is per-area frameSDP), so deriving
    // "destroyed" from sdp.value would flag every pristine suit as destroyed (sdpMax = STR > 0, sdp.value = 0).
    // ACPA destruction is set EXPLICITLY by the damage resolvers (torso frame gone / catastrophic) and cleared
    // by Repair, so for a suit we keep that stored flag; only a plain vehicle uses the sdp.value derivation.
    const storedDestroyed = this.destroyed === true;
    this.destroyed = this.isACPA ? storedDestroyed : (sdpMax > 0 && (Number(this.sdp?.value) || 0) <= 0);

    // ACPA frame derivations (Maximum Metal p.61-62): per-area frame SDP max + Chassis Inventory stats.
    if (this.isACPA) {
      const str = Number(this.str) || 0;
      this.frameSDPMax = acpaAreaSDP(str);
      const cs = chassisStats(str);
      this.toughness = cs.toughness;
      this.damMod = cs.damMod;
      this.lift = cs.lift;
      this.carry = cs.carry;

      // Reality Interface + Reflex/Control derivations (Maximum Metal p.64-65).
      const ri = realityInterface(this.realityInterface);
      const rc = reflexControl(this.reflexControl);
      this.dfb = ri.dfb;
      this.interfaceSib = ri.sib;
      this.interfaceSdp = ri.sdp;
      // The GM cap override (the interlocked-cyborg exception) replaces the system's maxRef when
      // set; 0 keeps RAW. Folded here so the stored maxRef always shows the EFFECTIVE cap.
      const capOverride = Number(this.refCapOverride) || 0;
      this.maxRef = capOverride > 0 ? capOverride : rc.maxRef;
      // Basic control on a military STR42+ frame is stricter (REF−3 not −2) — acpaReflexMod handles it.
      this.refMod = acpaReflexMod(this.reflexControl, str);
      // A linked pilot actor supplies the base REF; otherwise the manual pilotRef field is the fallback.
      // The same pilot also supplies MA (for run/jump) and PA Combat Sense (its initiative bonus).
      let pilotRef = Number(this.pilotRef) || 0;
      let pilotPACS = 0, pilotMA = 0, pilotPAPilot = 0;
      try {
        if (this.pilotId) {
          const pilot = game.actors?.get(this.pilotId);
          const r = Number(pilot?.system?.stats?.ref?.total);
          if (Number.isFinite(r)) pilotRef = r;
          pilotMA = Number(pilot?.system?.stats?.ma?.total) || 0;
          // PA Combat Sense is matched by _id (isPACombatSenseSkill), never by skill name — a Solo's
          // generic "Combat Sense" must NOT count as the ACPA-specific implant.
          const rsv = pilot.constructor?.realSkillValue;
          const paItem = pilot?.itemTypes?.skill?.find(isPACombatSenseSkill);
          if (paItem && typeof rsv === "function") {
            pilotPACS = Number(rsv(paItem)) || 0;
          }
          // PA Pilot (MM p.53) grants the MANEUVER bonus (the in-suit Martial-Arts cap) but NOT the
          // initiative bonus — so it feeds pilotPAManeuver (below), never pilotPACS.
          const ppItem = pilot?.itemTypes?.skill?.find(isPAPilotSkill);
          if (ppItem && typeof rsv === "function") {
            pilotPAPilot = Number(rsv(ppItem)) || 0;
          }
        }
      } catch (e) { /* actors not ready */ }
      this.pilotPACS = pilotPACS;
      // The in-suit maneuver cap (Martial Arts, MM p.60) is raised by EITHER PA Combat Sense (a Trooper)
      // OR PA Pilot (a non-Trooper) — take the better. Initiative uses pilotPACS ONLY (PA Pilot gives none).
      this.pilotPAManeuver = Math.max(pilotPACS, pilotPAPilot);
      this.effectiveRef = acpaEffectiveRef({
        pilotRef, refMod: this.refMod, maxRef: this.maxRef, refDamage: this.refDamage
      });

      // Weight budget + Suit Initiative Bonus (Maximum Metal p.61-62). Total loaded weight = chassis
      // + armor shell + Trooper capacity + interface + mounted systems (+1kg for a Command Computer).
      const armorSP = Number(this.sp?.front) || 0;
      this.armorWeight = acpaArmorWeight(armorSP);
      this.armorCost = acpaArmorCost(armorSP);
      const trooper = Number(this.trooperCapacity) || 0;
      const sysW = Number(this.systemsWeight) || 0;
      const cmdW = this.commandComputer ? 1 : 0;
      // Sum embedded acpaSystem Items (prepared by now) for the mounted-systems weight + cost.
      let mountedSystemsWeight = 0, mountedSystemsCost = 0;
      const items = this.parent?.items;
      if (items) for (const it of items) if (it.type === "cp2020-augmented.acpaSystem") {
        mountedSystemsWeight += Number(it.system?.weight) || 0;
        mountedSystemsCost   += Number(it.system?.cost)   || 0;
      }
      this.mountedSystemsWeight = mountedSystemsWeight;
      this.mountedSystemsCost = mountedSystemsCost;
      this.totalWeight = cs.weight + this.armorWeight + trooper + ri.weight + mountedSystemsWeight + sysW + cmdW;
      this.sib = acpaSib({ chassisCapacity: cs.lift, totalWeight: this.totalWeight, interfaceSib: ri.sib });
      // External load & the p.57 overload penalty (MM p.57, L5725-5734): a suit carries external / hand-held
      // gear up to ½ its chassis Carry rating freely; "If the amount carried is between 1/2 and the full
      // rating, subtract 2 from the suit's initiative bonus (SIB)." Sum embedded acpaSystem Items flagged
      // mount:"external" (their weight) + the GM-entered carriedGearKg. (cp2020-augmented.vehicleWeapon Items
      // carry NO internal/external mount marker — only `mountType` for the vehicle mount style and `area` for
      // the ACPA body slot — so weapon weight is intentionally left out and no field is invented for it.)
      let externalLoadKg = Number(this.carriedGearKg) || 0;
      if (items) for (const it of items) if (it.type === "cp2020-augmented.acpaSystem" && it.system?.mount === "external") {
        externalLoadKg += Number(it.system?.weight) || 0;
      }
      this.externalLoadKg = externalLoadKg;
      // Boundary: EXACTLY ½ Carry is NOT overloaded — the book penalizes weight "between 1/2 and the full rating".
      this.sibOverloaded = externalLoadKg > (cs.carry / 2);
      if (this.sibOverloaded) this.sib -= 2;   // applied BEFORE runM below, so run/jump inherit the −2.
      // Movement (MM p.57): Run = (SIB + pilot MA) × 3; standing jump = Run/6, running jump = Run/4.
      this.runM = acpaRunM({ sib: this.sib, ma: pilotMA });
      this.jumpStanding = acpaJumpM(this.runM, {});
      this.jumpRunning = acpaJumpM(this.runM, { running: true });
      // Total build cost (chassis + armor shell + interface + reflex/control + Command Computer + systems).
      this.buildCost = (Number(cs.cost) || 0) + this.armorCost + (Number(ri.cost) || 0) + (Number(rc.cost) || 0)
        + (this.commandComputer ? 5000 : 0) + mountedSystemsCost;
    }
  }
}
