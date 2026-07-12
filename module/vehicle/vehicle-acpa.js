/**
 * vehicle-acpa.js — Phase 6: powered-armor (ACPA) combat math core. Maximum Metal p.52-60.
 *
 * ACPA suits are already vehicles (the isACPA flag): they take Penetration-vs-Armor-Value damage with
 * an ACPA hit-location table. This module adds the detailed powered-armor combat layer on top:
 *   - the System Hit Table + Critical Hit Chart + System Integrity Check (p.55-56, charts p.103-104)
 *   - ACPA hand-to-hand damage (Punch/Crush/Kick, p.58)
 *   - derived movement (run / jump, p.57) and the naked Linear-Frame hit chance (p.56)
 *
 * Everything here is PURE and deterministic — pass the rolled d10s; no documents, no dice, no canvas.
 * The stateful integration (applying critical effects, per-turn cooling/interface ticks, the melee
 * dialog) is built on top in later commits.
 */

/* --------------------------- System Hit Table (MM p.55) --------------------------- */

/**
 * After damage penetrates the armor + Toughness Mod, a 50% (5-in-10) chance an EXTERNAL system is
 * hit instead of the suit proper (MM p.55). PURE: d10 1-5 → external.
 */
export function externalSystemHit(d10) {
  return (Math.max(1, Math.min(10, Math.round(Number(d10) || 1)))) <= 5;
}

/**
 * System Hit Table (MM p.55). PURE — pass a d10.
 *   1-3 chassis · 4-6 enclosed · 7-9 weapons · 10 → roll again (use acpaRollAgain).
 */
export function acpaSystemHit(d10) {
  const r = Math.max(1, Math.min(10, Math.round(Number(d10) || 1)));
  if (r <= 3) return "chassis";
  if (r <= 6) return "enclosed";
  if (r <= 9) return "weapons";
  return "rollAgain";
}

/** Resolve the "10 → roll again" branch: even → Critical Damage, odd → another System Hit. PURE. */
export function acpaRollAgain(d10) {
  const r = Math.max(1, Math.min(10, Math.round(Number(d10) || 1)));
  return (r % 2 === 0) ? "critical" : "systemHit";
}

/**
 * System Integrity Check (MM p.56). PURE. Given the SDP a struck system lost vs its total:
 *   lost < ½ total → 25% chance inoperable · ≥ ½ (not exceeding) → 75% · exceeds total → destroyed.
 * @returns {{destroyed:boolean, inopChance:number}}
 */
export function systemIntegrity({ sopLost = 0, sopTotal = 0 } = {}) {
  const lost = Math.max(0, Number(sopLost) || 0);
  const total = Math.max(0, Number(sopTotal) || 0);
  if (total > 0 && lost > total) return { destroyed: true, inopChance: 1 };
  const inopChance = (total > 0 && lost >= total / 2) ? 0.75 : 0.25;
  return { destroyed: false, inopChance };
}

/**
 * ACPA body-area hit location (the PA data form: Head[1], R.Arm[2], L.Arm[3], R.Leg[4-5],
 * L.Leg[6-7], Torso[8-0]). PURE — pass a d10.
 */
export function acpaBodyArea(d10) {
  const r = Math.max(1, Math.min(10, Math.round(Number(d10) || 1)));
  if (r === 1) return "Head";
  if (r === 2) return "Right Arm";
  if (r === 3) return "Left Arm";
  if (r <= 5) return "Right Leg";
  if (r <= 7) return "Left Leg";
  return "Torso";
}

/* --------------------------- Critical Hit Chart (MM p.55-56) --------------------------- */

/**
 * Critical Hit Chart (MM p.55-56, chart p.104). PURE — pass a d10. Returns the effect descriptor;
 * the resolver rolls the listed formula and applies it (tracked stat losses / timers).
 *   1-2 seize-up (1d10+1 rounds, body-area penalties)  · 3 cooling failure (heatstroke in 2d10 min)
 *   4-5 Suit STR −1d6                                   · 6-7 Suit REF −1d6/2
 *   8 Power Unit −(1d6×2) hours of life                 · 9 Interface out 1d6 rounds (2d6 civilian)
 *   10 Mechanical Shock: 1d6 extra SDP to a random area + pilot stunned that many rounds
 */
export function acpaCriticalEffect(d10) {
  const r = Math.max(1, Math.min(10, Math.round(Number(d10) || 1)));
  switch (true) {
    case r <= 2:  return { roll: r, type: "seizeUp",      formula: "1d10+1", unit: "rounds", label: "Body area seizes up (immobile)" };
    case r === 3: return { roll: r, type: "cooling",      formula: "2d10",   unit: "minutes", label: "Cooling failure — heatstroke" };
    case r <= 5:  return { roll: r, type: "strLoss",      formula: "1d6",    label: "Suit Strength lowered" };
    case r <= 7:  return { roll: r, type: "refLoss",      formula: "1d6", divisor: 2, label: "Suit Reflexes lowered (−1d6/2)" };
    case r === 8: return { roll: r, type: "powerLoss",    formula: "1d6", mult: 2, unit: "hours", label: "Power unit life reduced" };
    case r === 9: return { roll: r, type: "interfaceOut", formula: "1d6",    unit: "rounds", label: "Interface/electronics out" };
    default:      return { roll: r, type: "mechShock",    formula: "1d6",    unit: "SDP", label: "Mechanical shock (frame damage + stun)" };
  }
}

/**
 * Translate a rolled Critical Hit effect + its rolled amount into the actor update + a note. PURE
 * (no dice, no documents) so the field-writing is unit-testable. `sys` is the ACPA's current system.
 * @param {object} sys     the ACPA actor's system (reads current strDamage/refDamage/powerHours/…)
 * @param {object} effect  from acpaCriticalEffect()
 * @param {number} amount  the rolled value of effect.formula
 * @returns {{updates:object, note:string}}
 */
export function acpaCriticalUpdate(sys, effect, amount) {
  const cur = sys ?? {};
  const A = Math.max(0, Number(amount) || 0);
  switch (effect?.type) {
    case "seizeUp":
      return { updates: { "system.seizeUp": Math.max(Number(cur.seizeUp) || 0, A), "system.immobilized": true }, note: `seizes up ${A} round(s)` };
    case "cooling":
      return { updates: { "system.coolingTimer": A }, note: `overheats in ${A} min — heatstroke` };
    case "strLoss":
      return { updates: { "system.strDamage": (Number(cur.strDamage) || 0) + A }, note: `Suit STR −${A}` };
    case "refLoss": {
      const r = Math.round(A / (effect.divisor || 1));
      return { updates: { "system.refDamage": (Number(cur.refDamage) || 0) + r }, note: `Suit REF −${r}` };
    }
    case "powerLoss": {
      const h = A * (effect.mult || 1);
      return { updates: { "system.powerHours": Math.max(0, (Number(cur.powerHours ?? 24)) - h) }, note: `power-cell −${h}h` };
    }
    case "interfaceOut":
      return { updates: { "system.interfaceOut": Math.max(Number(cur.interfaceOut) || 0, A) }, note: `interface out ${A} round(s)` };
    case "mechShock": {
      const sdp = Number(cur.sdp?.value) || 0;
      return { updates: { "system.sdp": { value: Math.max(0, sdp - A), max: Number(cur.sdp?.max) || 0 } }, note: `${A} frame damage + pilot stun` };
    }
    default:
      return { updates: {}, note: effect?.label || "" };
  }
}

/** Minutes of real time per CP2020 combat round (3-second Friday Night Firefight rounds). */
export const ACPA_ROUND_MINUTES = 0.05;
/** Heatstroke escalation after a cooling failure (MM p.55): Stun/Shock Saves "starting at Serious,
 *  progressing one level per turn until he passes out." Index by heatstrokeLevel. */
export const HEATSTROKE_LEVELS = ["", "Serious", "Critical", "Mortal", "unconscious (heatstroke — death in 15 min if not removed)"];

/**
 * One combat round of ACPA status decay (MM p.55-56). PURE — pass the suit's system, get the actor
 * update + narration lines. Round-based timers (seize-up, interface-out) count down; seize-up ending
 * restores mobility. Cooling reconciles the minutes-vs-rounds scales: the 2d10-minute heat build-up
 * ticks down in real round-time (3s/round), and once it expires the pilot makes an escalating
 * Stun/Shock Save each round (Serious → Critical → Mortal → out), tracked in heatstrokeLevel.
 * The narration `lines` are i18n DESCRIPTORS ({key, params?}) — not English — so this pure,
 * unit-tested function stays free of game.i18n; tickAcpaCombatant localizes them at the render edge.
 * @returns {{updates:object, lines:{key:string, params?:object}[]}}
 */
export function acpaTickStatus(sys) {
  const seize = Number(sys?.seizeUp) || 0;
  const iface = Number(sys?.interfaceOut) || 0;
  const cool = Number(sys?.coolingTimer) || 0;
  const heat = Number(sys?.heatstrokeLevel) || 0;
  const updates = {};
  const lines = [];
  if (seize > 0) {
    const next = seize - 1;
    updates["system.seizeUp"] = next;
    if (next <= 0) { updates["system.immobilized"] = false; lines.push({ key: "Vehicle.AcpaSeizeEnds" }); }
    else lines.push({ key: "Vehicle.AcpaSeizedUp", params: { rounds: next } });
  }
  if (iface > 0) {
    const next = iface - 1;
    updates["system.interfaceOut"] = next;
    lines.push(next <= 0 ? { key: "Vehicle.AcpaInterfaceRestored" } : { key: "Vehicle.AcpaInterfaceOut", params: { rounds: next } });
  }
  // Cooling failure → heat build-up (minutes) → escalating heatstroke Stun/Shock Saves (per round).
  if (cool > 0) {
    const next = Math.max(0, Math.round((cool - ACPA_ROUND_MINUTES) * 100) / 100);
    updates["system.coolingTimer"] = next;
    if (next <= 0) {
      updates["system.heatstrokeLevel"] = 1;
      lines.push({ key: "Vehicle.AcpaHeatstrokeBegins" });
    } else {
      lines.push({ key: "Vehicle.AcpaOverheating", params: { min: next } });
    }
  } else if (heat > 0) {
    const lvl = Math.min(heat + 1, HEATSTROKE_LEVELS.length - 1);
    updates["system.heatstrokeLevel"] = lvl;
    lines.push({ key: "Vehicle.AcpaHeatstrokeWorsens", params: { level: HEATSTROKE_LEVELS[lvl] } });
  }
  return { updates, lines };
}

/* ------------------------------- Hand-to-hand (MM p.58) ------------------------------- */

/**
 * ACPA melee damage in d10s (MM p.58). PURE.
 *   X = round(STR / 9);  Punch = X d10 · Crush = (X+1) d10 · Kick = round(1.5·X) d10.
 * @returns {{x:number, dice:number, formula:string}}
 */
export function acpaMeleeDamage(str, kind = "punch") {
  const x = Math.max(0, Math.round((Number(str) || 0) / 9));
  let dice;
  switch (String(kind).toLowerCase()) {
    case "crush": dice = x + 1; break;
    case "kick":  dice = Math.round(x * 1.5); break;
    default:      dice = x; break;   // punch
  }
  dice = Math.max(1, dice);
  return { x, dice, formula: `${dice}d10` };
}

/* --------------------------------- Movement (MM p.57) --------------------------------- */

/** Running speed in metres/combat round: (SIB + MA) × 3 (MM p.57), floored at 0 (a badly overloaded /
 *  aperture-interface suit can drive SIB+MA negative — Run must not display below 0, matching acpaJumpM
 *  which already floors run at 0). PURE. */
export function acpaRunM({ sib = 0, ma = 0 } = {}) {
  return Math.max(0, ((Number(sib) || 0) + (Number(ma) || 0)) * 3);
}

/** Jump distance in metres (MM p.57): stationary = run/6, running = run/4, vertical = horizontal/3. PURE. */
export function acpaJumpM(runM, { running = false, vertical = false } = {}) {
  const r = Math.max(0, Number(runM) || 0);
  const horizontal = running ? r / 4 : r / 6;
  return vertical ? horizontal / 3 : horizontal;
}

/* ------------------------------ Construction / Linear Frame (MM p.61-63) ------------------------------ */

/**
 * Per-body-area frame SDP from chassis STR (MM p.61): Head and each Arm 25%, each Leg 50%, Torso 75%
 * (rounded). These are the Structural Damage Points of the FRAME in each area; destroying an area's
 * frame SDP knocks out its systems, and destroying the Torso shuts the suit down. PURE.
 * @returns {{head:number, rArm:number, lArm:number, rLeg:number, lLeg:number, torso:number}}
 */
export function acpaAreaSDP(str) {
  const s = Math.max(0, Number(str) || 0);
  const r = (p) => Math.round(s * p);
  return { head: r(0.25), rArm: r(0.25), lArm: r(0.25), rLeg: r(0.5), lLeg: r(0.5), torso: r(0.75) };
}

/** The Chassis Inventory Table (MM p.62): chassis STR → frame stats. Toughness Mod reduces incoming damage. */
const CHASSIS_TABLE = [
  { str: 12, toughness: -5,  damMod: "+4",     lift: 600,  carry: 180, weight: 125, cost: 5000 },
  { str: 14, toughness: -5,  damMod: "+6",     lift: 700,  carry: 210, weight: 138, cost: 7000 },
  { str: 16, toughness: -5,  damMod: "1d6+2",  lift: 800,  carry: 240, weight: 150, cost: 9000 },
  { str: 20, toughness: -6,  damMod: "1d10",   lift: 1000, carry: 300, weight: 116, cost: 28450 },
  { str: 25, toughness: -7,  damMod: "1d10+2", lift: 1250, carry: 375, weight: 138, cost: 37360 },
  { str: 27, toughness: -7,  damMod: "1d10+5", lift: 1350, carry: 405, weight: 146, cost: 38700 },
  { str: 30, toughness: -8,  damMod: "1d10+5", lift: 1500, carry: 450, weight: 158, cost: 46990 },
  { str: 32, toughness: -8,  damMod: "3d6-1",  lift: 1600, carry: 480, weight: 166, cost: 50890 },
  { str: 35, toughness: -9,  damMod: "3d6-1",  lift: 1750, carry: 525, weight: 180, cost: 56140 },
  { str: 37, toughness: -9,  damMod: "3d6-1",  lift: 1850, carry: 555, weight: 185, cost: 61050 },
  { str: 40, toughness: -10, damMod: "2d10",   lift: 2000, carry: 600, weight: 200, cost: 66000 },
  { str: 42, toughness: -10, damMod: "2d10",   lift: 2100, carry: 630, weight: 208, cost: 69970 },
  { str: 45, toughness: -11, damMod: "2d10",   lift: 2250, carry: 675, weight: 222, cost: 75250 },
  { str: 50, toughness: -12, damMod: "2d10+5", lift: 2500, carry: 750, weight: 242, cost: 85230 },
  { str: 52, toughness: -12, damMod: "2d10+5", lift: 2600, carry: 780, weight: 250, cost: 89230 },
];

/** Frame stats for a chassis STR (the row at or below it; clamped to the smallest). PURE. */
export function chassisStats(str) {
  const s = Number(str) || 0;
  let row = CHASSIS_TABLE[0];
  for (const r of CHASSIS_TABLE) { if (s >= r.str) row = r; else break; }
  return { ...row };
}

/* ------------------- Reality Interface & Reflex/Control (MM p.64-65) ------------------- */

/**
 * Reality Interface systems (MM p.64). The interface always lives in the helmet. Each level sets
 * the suit's SIB bonus (added in the SIB derivation) and its Direct-Fire Bonus (DFB) — the to-hit
 * modifier applied when the suit fires its OWN weapons (this replaces any smartgun bonus).
 * `sdp`/`weight`/`spaces`/`cost` feed the build budget; `maxWeapons` = simultaneous targets. PURE.
 */
export const REALITY_INTERFACES = {
  APERTURE_BASED:    { key: "APERTURE_BASED",    label: "Aperture-Based",    sib: -6, dfb: -2, sdp: 20, weight: 0, spaces: 0,   cost: 100,  enclosed: true,  maxWeapons: 1 },
  ENHANCED_APERTURE: { key: "ENHANCED_APERTURE", label: "Enhanced Aperture", sib: -4, dfb:  0, sdp: 15, weight: 1, spaces: 0.5, cost: 300,  enclosed: true,  maxWeapons: 1 },
  WIDEBAND_APERTURE: { key: "WIDEBAND_APERTURE", label: "Wideband Aperture", sib: -2, dfb:  1, sdp: 15, weight: 1, spaces: 0.5, cost: 800,  enclosed: true,  maxWeapons: 1 },
  FULL_HUD_WIDEBAND: { key: "FULL_HUD_WIDEBAND", label: "Full-HUD Wideband", sib:  0, dfb:  2, sdp: 10, weight: 2, spaces: 0.5, cost: 2400, enclosed: false, maxWeapons: 1 },
  ECI_WIDEBAND_HUD:  { key: "ECI_WIDEBAND_HUD",  label: "ECI Wideband HUD",  sib:  2, dfb:  2, sdp: 10, weight: 2, spaces: 0.5, cost: 4000, enclosed: false, maxWeapons: 3 },
  RUSSIAN_ARMS_VRI:  { key: "RUSSIAN_ARMS_VRI",  label: "Russian Arms VRI",  sib:  3, dfb:  3, sdp: 25, weight: 3, spaces: 1,   cost: 6000, enclosed: false, maxWeapons: 4 },
  MILITECH_VRI:      { key: "MILITECH_VRI",      label: "Militech VRI",      sib:  3, dfb:  3, sdp: 15, weight: 2, spaces: 1,   cost: 8000, enclosed: false, maxWeapons: 4 },
};

/** Reality Interface row for a key (defaults to Full-HUD Wideband — the neutral SIB-0 baseline). PURE. */
export function realityInterface(key) {
  return REALITY_INTERFACES[key] ?? REALITY_INTERFACES.FULL_HUD_WIDEBAND;
}

/** The three Aperture interfaces provide NO HUD or VR (MM p.60). */
const _NO_HUD_INTERFACES = new Set(["APERTURE_BASED", "ENHANCED_APERTURE", "WIDEBAND_APERTURE"]);

/**
 * Whether a suit's Reality Interface includes a HUD or VR (MM p.60). Only HUD/VR-equipped suits may fire
 * TARGETED (unguided rockets/GLs used indirectly) or GUIDED (missile) weapons for INDIRECT fire — an
 * Aperture-only suit lacks the target designation to do so. Defaults to true for an unknown key (the
 * neutral Full-HUD baseline). PURE.
 */
export function interfaceHasHud(key) {
  return !_NO_HUD_INTERFACES.has(realityInterface(key).key);
}

/**
 * Reflex/Control systems (MM p.65). They regulate how the pilot drives the suit: a REF modifier
 * (`refMod`) plus a hard cap (`maxRef`) on the operating Reflex. They take NO spaces. Basic is the
 * civilian "idiot-proof" system (REF−2, and −3 on STR42+ frames — modelled via refModHeavy); Advanced
 * is the free military standard; Low/High Boost raise the cap (Boost cannot be "on" while plugged in
 * to PA — the suit's reflex/control replaces cyberware reflexes). PURE.
 */
export const REFLEX_CONTROLS = {
  BASIC:      { key: "BASIC",      label: "Basic",      refMod: -2, refModHeavy: -3, maxRef: 8,  cost: -2000, weight: 0, spaces: 0 },
  ADVANCED:   { key: "ADVANCED",   label: "Advanced",   refMod:  0, refModHeavy:  0, maxRef: 10, cost: 0,     weight: 0, spaces: 0 },
  LOW_BOOST:  { key: "LOW_BOOST",  label: "Low Boost",  refMod:  1, refModHeavy:  1, maxRef: 11, cost: 3000,  weight: 0, spaces: 0 },
  HIGH_BOOST: { key: "HIGH_BOOST", label: "High Boost", refMod:  2, refModHeavy:  2, maxRef: 12, cost: 9000,  weight: 0, spaces: 0 },
};

/** Reflex/Control row for a key (defaults to Advanced — the free military standard, full REF / max 10). PURE. */
export function reflexControl(key) {
  return REFLEX_CONTROLS[key] ?? REFLEX_CONTROLS.ADVANCED;
}

/**
 * The REF modifier from a Reflex/Control system, applying the heavy-frame variant: Basic control on a
 * military linear frame of STR 42+ is even stricter — REF−3 instead of −2 (MM p.65). PURE.
 */
export function acpaReflexMod(key, str) {
  const rc = reflexControl(key);
  return (rc.key === "BASIC" && (Number(str) || 0) >= 42) ? rc.refModHeavy : rc.refMod;
}

/**
 * Effective operating REF in the suit (MM p.65): clamp(pilotRef + refMod, 0..maxRef), then subtract
 * accumulated suit-REF critical damage (refDamage). PURE.
 */
export function acpaEffectiveRef({ pilotRef = 0, refMod = 0, maxRef = 10, refDamage = 0 } = {}) {
  const capped = Math.min(Math.max(0, (Number(pilotRef) || 0) + (Number(refMod) || 0)), Math.max(0, Number(maxRef) || 0));
  return Math.max(0, capped - (Number(refDamage) || 0));
}

/* ------------------------------ Armor Inventory + SIB (MM p.61-62) ------------------------------ */

/**
 * Armor Inventory Table (MM p.62): the suit's armor "shell" SP → weight(kg)/cost(eb). The shell
 * protects equally on all sides; a chassis cannot carry a shell with SP > 2× its STR. NOTE: the SP25
 * row is the lightweight MetalGear comparison variant — the real ACPA shells run SP30-80 (~5kg & 400eb
 * per SP), so interpolating across 25→30 is intentionally steep. PURE table.
 */
export const ARMOR_INVENTORY = [
  { sp: 25, weight: 36,  cost: 1200  },
  { sp: 30, weight: 150, cost: 5600  },
  { sp: 40, weight: 200, cost: 9600  },
  { sp: 50, weight: 250, cost: 13600 },
  { sp: 65, weight: 330, cost: 19600 },
  { sp: 80, weight: 400, cost: 25600 },
];

/** Piecewise-linear interpolation of an Armor Inventory column for an arbitrary SP (clamped). PURE. */
function interpArmor(sp, field) {
  const s = Math.max(0, Number(sp) || 0);
  const T = ARMOR_INVENTORY;
  if (s <= 0) return 0;
  if (s <= T[0].sp) return Math.round(T[0][field] * (s / T[0].sp));      // scale down from the lightest row
  if (s >= T[T.length - 1].sp) return T[T.length - 1][field];            // clamp at the heaviest
  for (let i = 0; i < T.length - 1; i++) {
    const a = T[i], b = T[i + 1];
    if (s >= a.sp && s <= b.sp) {
      const t = (s - a.sp) / (b.sp - a.sp);
      return Math.round(a[field] + t * (b[field] - a[field]));
    }
  }
  return T[T.length - 1][field];
}

/** Armor-shell weight (kg) for a shell SP, from the Armor Inventory Table (interpolated). PURE. */
export function acpaArmorWeight(sp) { return interpArmor(sp, "weight"); }
/** Armor-shell cost (eb) for a shell SP, from the Armor Inventory Table (interpolated). PURE. */
export function acpaArmorCost(sp)   { return interpArmor(sp, "cost"); }

/**
 * Suit Initiative Bonus — SIB (MM p.61). Reflects the suit's power-to-weight agility. PURE.
 *   1. ratio = chassisCapacity (the Lift/Cap. column) ÷ total fully-loaded weight.
 *   2. round: if the ratio has a whole part, round to nearest using a 0.8 threshold (frac < 0.8 → down,
 *      ≥ 0.8 → up); if it is only a fraction (ratio < 1), treat it as 0. Then subtract 1.
 *   3. add the Reality Interface's SIB bonus.
 * Verified against the MM worked example (data form: cap≈2500 / total 1235 kg, Full-HUD → SIB +1).
 */
export function acpaSib({ chassisCapacity = 0, totalWeight = 0, interfaceSib = 0 } = {}) {
  const cap = Math.max(0, Number(chassisCapacity) || 0);
  const tw = Math.max(0, Number(totalWeight) || 0);
  const iface = Number(interfaceSib) || 0;
  if (tw <= 0) return iface - 1;          // degenerate (no weight) — base rounds to 0
  const ratio = cap / tw;
  const whole = Math.floor(ratio);
  const frac = ratio - whole;
  const rounded = (whole >= 1) ? (frac < 0.8 ? whole : whole + 1) : 0;   // <1 → "treat as 0"
  return (rounded - 1) + iface;
}

/**
 * Roll-data terms so the shared system initiative formula
 *   "1d10 + @stats.ref.total + @CombatSenseMod + @initiativeMod + @initiativeImplantMod"
 * evaluates, for an ACPA suit, to 1d10 + effective REF + SIB + PA Combat Sense (+1 Command Computer).
 * Vehicles have none of these stats natively, so the actor's getRollData() maps the suit's derived
 * values here. PA Combat Sense feeds @CombatSenseMod but is capped so SIB + PA Combat Sense ≤ 20
 * (MM p.53). PURE.
 * @param {object} sys  the ACPA actor's system (reads effectiveRef / sib / pilotPACS / commandComputer)
 */
export function acpaInitiativeRollData(sys) {
  const s = sys ?? {};
  const sib = Number(s.sib) || 0;
  const pacs = Math.max(0, Math.min(Number(s.pilotPACS) || 0, 20 - sib));   // MM p.53: SIB + PA Combat Sense ≤ 20
  return {
    stats: { ref: { total: Number(s.effectiveRef) || 0 } },
    CombatSenseMod: pacs,
    initiativeMod: sib,
    initiativeImplantMod: s.commandComputer ? 1 : 0,
  };
}

/* ------------------------------ Linear Frame (naked) (MM p.56) ------------------------------ */

/**
 * A naked Linear Frame takes a weapon hit only on a chance based on size (MM p.56). PURE.
 *   basic (STR 12-16) → 2-in-10 (0.2) · advanced (STR 20-52) → 3-in-10 (0.3).
 */
export function linearFrameHitChance(str) {
  const s = Number(str) || 0;
  if (s >= 20) return 0.3;
  if (s >= 12) return 0.2;
  return 0.2;
}
