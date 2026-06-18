/**
 * vehicle-acpa-systems.js — ACPA systems catalog + construction/damage math (Maximum Metal p.61-79,
 * charts Appendix A p.93-95). PURE: no documents, no dice, no canvas.
 *
 * These are the NON-WEAPON suit systems (utility / sensor / movement / defensive / safety). Offensive
 * weapons are NOT here — an ACPA mounts those as ordinary `vehicleWeapon` Items, same as any vehicle.
 *
 * Scope is a verified CORE SET (a representative handful per category); the table is structured so the
 * full p.64-79 catalog can be added entry-by-entry later. Each system carries its own SOP, so a hit can
 * knock out one specific system rather than always biting the frame (this refines the D-3 SOP flow).
 *
 * Stat columns (from the charts): weight(kg) · spaces · cost(eb) · sp · sop · mount. `mount`:
 *   "internal" (enclosed, helmet/torso interior — protected by the shell) · "external" (NOT shell-
 *   protected; carries its own SP) · "either" (YES/NO) · "retract" (stows internally, SP only extended).
 */

/* ------------------------------- Core systems catalog ------------------------------- */

export const ACPA_SYSTEM_CATEGORIES = ["utility", "sensor", "movement", "defensive", "safety"];

/** Core ACPA systems (Maximum Metal charts, Appendix A). Verified stats; expand freely. */
export const ACPA_SYSTEMS = {
  // ── Sensors (Audio-Visual / Special Sensors, p.67/93) ──
  RADAR:              { key: "RADAR",              label: "Radar",                 category: "sensor",   weight: 5, spaces: 0.5,  sp: 0,  sop: 15, cost: 1000, mount: "internal" },
  INFRARED:           { key: "INFRARED",           label: "Infra-Red Sensors",     category: "sensor",   weight: 0, spaces: 0.25, sp: 0,  sop: 5,  cost: 400,  mount: "internal" },
  THERMAL_TARGETING:  { key: "THERMAL_TARGETING",  label: "Thermal Targeting",     category: "sensor",   weight: 0, spaces: 0.25, sp: 0,  sop: 5,  cost: 500,  mount: "internal" },
  SENSORY_EXTENSIONS: { key: "SENSORY_EXTENSIONS", label: "Sensory Extensions",    category: "sensor",   weight: 2, spaces: 0.5,  sp: 15, sop: 15, cost: 500,  mount: "external" },

  // ── Utility (General + Auto-Doctors, p.64) ──
  FIRE_EXTINGUISHER:  { key: "FIRE_EXTINGUISHER",  label: "Fire Extinguisher",     category: "utility",  weight: 20, spaces: 1,   sp: 0,  sop: 40, cost: 500,  mount: "internal" },
  HEAVY_TOOL_SUITE:   { key: "HEAVY_TOOL_SUITE",   label: "Heavy Tool Suite",      category: "utility",  weight: 10, spaces: 1,   sp: 20, sop: 20, cost: 500,  mount: "either" },
  KWIKFIX_AUTODOC:    { key: "KWIKFIX_AUTODOC",    label: "RussianArms Kwikfix",   category: "utility",  weight: 1,  spaces: 0.5, sp: 0,  sop: 15, cost: 200,  mount: "internal" },
  BODYWEIGHT_MEDIC:   { key: "BODYWEIGHT_MEDIC",   label: "Bodyweight Medic",      category: "utility",  weight: 3,  spaces: 1,   sp: 0,  sop: 15, cost: 2000, mount: "internal" },

  // ── Movement (p.68) ──
  CLIMBERS:           { key: "CLIMBERS",           label: "Climbers",              category: "movement", weight: 1,  spaces: 0.5, sp: 30, sop: 15, cost: 1000, mount: "either",  perLimb: true },
  SWIMMER:            { key: "SWIMMER",            label: "Swimmer Unit",          category: "movement", weight: 50, spaces: 2,   sp: 25, sop: 60, cost: 6000, mount: "external" },
  JUMP_JETS:          { key: "JUMP_JETS",          label: "Jump Jets",             category: "movement", weight: 0,  spaces: 1,   sp: 20, sop: 30, cost: 10000, mount: "retract" },

  // ── Safety (Trooper Safety, p.64) ──
  ESCAPE_HATCH:       { key: "ESCAPE_HATCH",       label: "Escape Hatch",          category: "safety",   weight: 1,  spaces: 0.5, sp: 0,  sop: 30, cost: 500,  mount: "internal" },
  LIFE_SUPPORT:       { key: "LIFE_SUPPORT",       label: "Extended Life Support", category: "safety",   weight: 2,  spaces: 0.5, sp: 0,  sop: 10, cost: 400,  mount: "internal" },
  SELF_SEAL:          { key: "SELF_SEAL",          label: "Self-Seal Compression", category: "safety",   weight: 5,  spaces: 4,   sp: 0,  sop: 50, cost: 6000, mount: "internal" },

  // ── Defensive / countermeasures (ACPA Defensive Systems, p.79 / charts p.97) ──
  EMP_SPONGE:         { key: "EMP_SPONGE",         label: "EMP Sponge",            category: "defensive", weight: 2, spaces: 0.5, sp: 0,  sop: 30, cost: 500,    mount: "internal" },  // one-shot EMP protection
  SMOKE_CANNISTER:    { key: "SMOKE_CANNISTER",    label: "Smoke Cannister",       category: "defensive", weight: 2, spaces: 1,   sp: 0,  sop: 10, cost: 1500,   mount: "internal" },  // −3 to-hit vs visual guidance
  IR_BAFFLING:        { key: "IR_BAFFLING",        label: "IR Baffling",           category: "defensive", weight: 6, spaces: 1,   sp: 20, sop: 20, cost: 300,    mount: "external" },  // vs thermal/IR
  GHOST_DECOY:        { key: "GHOST_DECOY",        label: "Ghost Decoy Cannister", category: "defensive", weight: 2, spaces: 0.5, sp: 20, sop: 25, cost: 500,    mount: "external" },  // one-shot ECM decoy (~1 min)
  AGAMS:              { key: "AGAMS",              label: "AGAMS Anti-Missile",    category: "defensive", weight: 4, spaces: 0.5, sp: 20, sop: 10, cost: 3000,   mount: "external" },  // shoots down inbound missiles
  ECM_SUITE:          { key: "ECM_SUITE",          label: "ECM Suite",             category: "defensive", weight: 5, spaces: 1,   sp: 0,  sop: 15, cost: 100000, mount: "internal" },  // jamming, 100m radius
};

/** Catalog entry for a key (or null). PURE. */
export function acpaSystemDef(key) {
  return ACPA_SYSTEMS[key] ?? null;
}

/**
 * A system's structural points (SOP). The charts list SOP directly; a system given an SP but no SOP
 * has SOP = 3 × SP (MM p.62). PURE — accepts a catalog def or any {sop, sp}.
 */
export function acpaSystemSop(def) {
  const sop = Number(def?.sop) || 0;
  if (sop > 0) return sop;
  const sp = Number(def?.sp) || 0;
  return sp > 0 ? sp * 3 : 0;
}

/* ------------------------------- Per-area spaces (MM p.61) ------------------------------- */

/**
 * Internal + external spaces available in each body area, by chassis STR (MM p.61). External spaces =
 * internal − 1 (external systems are NOT protected by the suit's armor). PURE.
 *   STR 16-20 → Head 2 / Arm-Leg 2 each / Torso 3 · 25-37 → 2 / 3 / 4 · 40-52 → 3 / 4 / 5.
 * @returns {{head:{internal,external}, rArm, lArm, rLeg, lLeg, torso}}
 */
export function acpaAreaSpaces(str) {
  const s = Number(str) || 0;
  let head, armLeg, torso;
  if (s >= 40)      { head = 3; armLeg = 4; torso = 5; }
  else if (s >= 25) { head = 2; armLeg = 3; torso = 4; }
  else              { head = 2; armLeg = 2; torso = 3; }   // 16-20 (and clamp below)
  const area = (internal) => ({ internal, external: Math.max(0, internal - 1) });
  return {
    head:  area(head),
    rArm:  area(armLeg), lArm: area(armLeg),
    rLeg:  area(armLeg), lLeg: area(armLeg),
    torso: area(torso),
  };
}

const _AREA_KEYS = ["head", "rArm", "lArm", "rLeg", "lLeg", "torso"];

/* ------------------------------- Mounted-systems aggregation ------------------------------- */

/**
 * Aggregate a list of mounted systems (each { key, area, mount }) against the catalog: total weight,
 * total cost, and spaces used per area split by internal/external. `mount` falls back to the catalog
 * default. PURE — unknown keys are skipped.
 * @returns {{totalWeight, totalCost, byArea:{[area]:{internal,external}}}}
 */
export function acpaSystemsSummary(mounted = []) {
  const byArea = Object.fromEntries(_AREA_KEYS.map(a => [a, { internal: 0, external: 0 }]));
  let totalWeight = 0, totalCost = 0;
  for (const m of mounted ?? []) {
    const def = acpaSystemDef(m?.key) ?? {};
    // Prefer the mounted entry's own values (a placed Item may have been edited); fall back to catalog.
    const weight = m?.weight ?? def.weight ?? 0;
    const cost   = m?.cost   ?? def.cost   ?? 0;
    const spaces = m?.spaces ?? def.spaces ?? 0;
    const mount  = m?.mount  ?? def.mount  ?? "internal";
    if (def.key == null && m?.key == null && weight === 0 && spaces === 0 && cost === 0) continue;
    totalWeight += Number(weight) || 0;
    totalCost   += Number(cost)   || 0;
    const area = _AREA_KEYS.includes(m?.area) ? m.area : "torso";
    // External mount uses external spaces; everything else (internal/either/retract) uses internal.
    const kind = mount === "external" ? "external" : "internal";
    byArea[area][kind] += Number(spaces) || 0;
  }
  return { totalWeight, totalCost, byArea };
}

/**
 * Per-area space overage: spaces used minus spaces available (MM p.61). A positive number in either
 * bucket means that area is over budget. PURE.
 * @returns {{[area]:{internal:number, external:number}}}  (used − available; ≤0 = within budget)
 */
export function acpaSpacesOver(mounted, str) {
  const used = acpaSystemsSummary(mounted).byArea;
  const avail = acpaAreaSpaces(str);
  const out = {};
  for (const a of _AREA_KEYS) {
    out[a] = {
      internal: (used[a]?.internal || 0) - (avail[a]?.internal || 0),
      external: (used[a]?.external || 0) - (avail[a]?.external || 0),
    };
  }
  return out;
}

/* ------------------------------- Per-system SOP damage (MM p.55) ------------------------------- */

/**
 * Apply SOP damage to one mounted system in a struck body area (MM p.55-56). Picks the first LIVE
 * system in the area, adds the damage to its accumulated `sopDamage`, and marks it destroyed once that
 * meets/exceeds its SOP. PURE — returns a NEW array plus the outcome; if no live system is in the area,
 * nothing is consumed (the caller falls through to frame SOP, per D-3).
 * @param {Array}  mounted  [{ key, area, mount, sopDamage?, destroyed? }]
 * @param {string} area     struck body-area key (head/rArm/lArm/rLeg/lLeg/torso)
 * @param {number} sopDamage incoming SOP damage
 * @returns {{ index:number, hitKey:(string|null), destroyed:boolean, overflow:number, updated:Array }}
 */
export function acpaHitSystem(mounted = [], area, sopDamage = 0) {
  const updated = (mounted ?? []).map(m => ({ ...m }));
  const dmg = Math.max(0, Number(sopDamage) || 0);
  const index = updated.findIndex(m => m?.area === area && !m?.destroyed);
  if (index < 0) return { index: -1, hitKey: null, destroyed: false, overflow: dmg, updated };
  const m = updated[index];
  // Prefer the mounted entry's own SOP/SP (a placed Item may be edited); fall back to the catalog.
  const def = acpaSystemDef(m.key) ?? {};
  const sop = acpaSystemSop({ sop: m.sop ?? def.sop, sp: m.sp ?? def.sp });
  const prev = Math.max(0, Number(m.sopDamage) || 0);
  const total = prev + dmg;
  const destroyed = sop > 0 && total >= sop;
  m.sopDamage = Math.min(total, sop || total);
  m.destroyed = !!destroyed;
  // Damage beyond what destroying this system absorbs spills back to the caller (→ frame SOP).
  const overflow = destroyed ? Math.max(0, total - sop) : 0;
  return { index, hitKey: m.key, destroyed, overflow, updated };
}

/* ------------------------------- Build validation (MM p.61) ------------------------------- */

const _AREA_LABEL = { head: "Head", rArm: "Right Arm", lArm: "Left Arm", rLeg: "Right Leg", lLeg: "Left Leg", torso: "Torso" };

/**
 * Validate a powered-armor build against the Maximum Metal construction limits (p.61). PURE — returns
 * a list of human-readable issue strings (empty = a legal build):
 *   - the armor shell SP cannot exceed 2× the chassis STR,
 *   - the fully-loaded suit cannot weigh more than the chassis Lift/Capacity,
 *   - no body area may exceed its internal or external space budget.
 * @param {{str, armorSP, totalWeight, chassisCapacity, spacesOver}} opts
 *   spacesOver: the per-area {internal, external} overage from acpaSpacesOver().
 * @returns {string[]}
 */
export function acpaBuildIssues({ str = 0, armorSP = 0, totalWeight = 0, chassisCapacity = 0, spacesOver = {} } = {}) {
  const issues = [];
  const s = Number(str) || 0;
  const sp = Number(armorSP) || 0;
  if (s > 0 && sp > 2 * s) issues.push(`Armor SP ${sp} exceeds 2× chassis STR (max ${2 * s}).`);
  const cap = Number(chassisCapacity) || 0;
  const tw = Number(totalWeight) || 0;
  if (cap > 0 && tw > cap) issues.push(`Overweight: ${tw} kg exceeds the chassis Lift/Capacity (${cap} kg).`);
  for (const a of _AREA_KEYS) {
    const o = spacesOver?.[a] ?? {};
    if ((Number(o.internal) || 0) > 0) issues.push(`${_AREA_LABEL[a]}: ${o.internal} over the internal space budget.`);
    if ((Number(o.external) || 0) > 0) issues.push(`${_AREA_LABEL[a]}: ${o.external} over the external space budget.`);
  }
  return issues;
}
