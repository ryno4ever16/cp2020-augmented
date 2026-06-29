/**
 * vehicle-acpa-systems.js — ACPA systems catalog + construction/damage math (Maximum Metal p.61-79,
 * charts Appendix A p.93-95). PURE: no documents, no dice, no canvas.
 *
 * These are the NON-WEAPON suit systems (utility / sensor / movement / defensive / safety). Offensive
 * weapons are NOT here — an ACPA mounts those as ordinary `vehicleWeapon` Items, same as any vehicle.
 *
 * Scope is a verified CORE SET (a representative handful per category); the table is structured so the
 * full p.64-79 catalog can be added entry-by-entry later. Each system carries its own SDP, so a hit can
 * knock out one specific system rather than always biting the frame (this refines the D-3 SDP flow).
 *
 * Stat columns (from the charts): weight(kg) · spaces · cost(eb) · sp · sdp · mount. `mount`:
 *   "internal" (enclosed, helmet/torso interior — protected by the shell) · "external" (NOT shell-
 *   protected; carries its own SP) · "either" (YES/NO) · "retract" (stows internally, SP only extended).
 */

/* ------------------------------- Core systems catalog ------------------------------- */

export const ACPA_SYSTEM_CATEGORIES = ["utility", "sensor", "movement", "defensive", "safety"];

/** Core ACPA systems (Maximum Metal charts, Appendix A). Verified stats; expand freely. */
export const ACPA_SYSTEMS = {
  // ── Sensors (Audio-Visual / Special Sensors, p.67/93) ──
  RADAR:              { key: "RADAR",              label: "Radar",                 category: "sensor",   weight: 5, spaces: 0.5,  sp: 0,  sdp: 15, cost: 1000, mount: "internal" },
  INFRARED:           { key: "INFRARED",           label: "Infra-Red Sensors",     category: "sensor",   weight: 0, spaces: 0.25, sp: 0,  sdp: 5,  cost: 400,  mount: "internal" },
  THERMAL_TARGETING:  { key: "THERMAL_TARGETING",  label: "Thermal Targeting",     category: "sensor",   weight: 0, spaces: 0.25, sp: 0,  sdp: 5,  cost: 500,  mount: "internal" },
  SENSORY_EXTENSIONS: { key: "SENSORY_EXTENSIONS", label: "Sensory Extensions",    category: "sensor",   weight: 2, spaces: 0.5,  sp: 15, sdp: 15, cost: 500,  mount: "external" },

  // ── Communications (Audio-Visual / Communications, p.67-68; grouped with Special Sensors) ──
  COMMO_RADIO_STD:    { key: "COMMO_RADIO_STD",    label: "Standard Radio",        category: "sensor",   weight: 0,  spaces: 0,    sp: 0,  sdp: 5,  cost: 200,  mount: "internal" },  // 80 km, IFF transponder
  COMMO_RADIO_LONG:   { key: "COMMO_RADIO_LONG",   label: "Long-Range Radio",      category: "sensor",   weight: 5,  spaces: 0.25, sp: 0,  sdp: 5,  cost: 1000, mount: "internal" },  // 300 km, IFF
  COMMO_RADIO_MIL:    { key: "COMMO_RADIO_MIL",    label: "Military Radio",        category: "sensor",   weight: 10, spaces: 0.5,  sp: 0,  sdp: 10, cost: 2500, mount: "internal" },  // band-jump/burst, 500 km, IFF
  SAT_UPLINK:         { key: "SAT_UPLINK",         label: "Satellite Uplink",      category: "sensor",   weight: 20, spaces: 1,    sp: 0,  sdp: 15, cost: 3000, mount: "retract" },   // links comms/recon sat; external when deployed
  CELL_PHONE:         { key: "CELL_PHONE",         label: "Cellular Phone",        category: "sensor",   weight: 2,  spaces: 0.25, sp: 0,  sdp: 5,  cost: 500,  mount: "internal" },  // 20 km urban; needs repeaters underground
  SCRAMBLER:          { key: "SCRAMBLER",          label: "Scrambler",             category: "sensor",   weight: 0,  spaces: 0.25, sp: 0,  sdp: 5,  cost: 500,  mount: "internal" },  // coded comms; +500eb decoder cracks 20%
  LASER_COM:          { key: "LASER_COM",          label: "Laser Communicator",    category: "sensor",   weight: 10, spaces: 0.25, sp: 0,  sdp: 10, cost: 7000, mount: "internal" },  // line-of-sight, unjammable

  // ── Special Sensors (Audio-Visual / Special Sensors, p.68; anchor-validated table) ──
  REMOTE_TARGETING:   { key: "REMOTE_TARGETING",   label: "Remote Targeting",      category: "sensor",   weight: 1,  spaces: 0.5,  sp: 0,  sdp: 5,  cost: 800,  mount: "internal" },  // forward-observer indirect-fire link
  ANTI_DAZZLE:        { key: "ANTI_DAZZLE",        label: "Anti-Dazzle",           category: "sensor",   weight: 0,  spaces: 0.25, sp: 0,  sdp: 5,  cost: 200,  mount: "internal" },  // = cyberoptic anti-dazzle
  LOW_LITE:           { key: "LOW_LITE",           label: "Low-Lite",              category: "sensor",   weight: 0,  spaces: 0.25, sp: 0,  sdp: 5,  cost: 200,  mount: "internal" },  // = LL goggles
  TELESCOPIC_OPTICS:  { key: "TELESCOPIC_OPTICS",  label: "Telescopic Optics",     category: "sensor",   weight: 0,  spaces: 0.25, sp: 0,  sdp: 5,  cost: 150,  mount: "internal" },  // = teleoptics
  IMAGE_ENHANCE:      { key: "IMAGE_ENHANCE",      label: "Image Enhance",         category: "sensor",   weight: 0,  spaces: 0.25, sp: 0,  sdp: 5,  cost: 450,  mount: "internal" },  // Notice/Awareness bonus
  VISUAL_BACKUP:      { key: "VISUAL_BACKUP",      label: "Visual Spectrum Backup",category: "sensor",   weight: 1,  spaces: 0.5,  sp: 0,  sdp: 15, cost: 300,  mount: "internal" },  // fallback view if primary interface fails
  AV_RECORDER:        { key: "AV_RECORDER",        label: "A/V Recorder",          category: "sensor",   weight: 2,  spaces: 0.25, sp: 0,  sdp: 10, cost: 300,  mount: "internal" },  // 6 hrs/chip, 2 chips
  SONAR:              { key: "SONAR",              label: "Sonar",                 category: "sensor",   weight: 10, spaces: 1,    sp: 0,  sdp: 10, cost: 2000, mount: "internal" },  // 50m detect / 200m listen
  MAGNETOMETER:       { key: "MAGNETOMETER",       label: "Magnetometer",          category: "sensor",   weight: 20, spaces: 1,    sp: 0,  sdp: 15, cost: 3000, mount: "internal" },  // 100m metal; railguns at 3x range
  LASER_DETECTOR:     { key: "LASER_DETECTOR",     label: "Laser Detector",        category: "sensor",   weight: 0,  spaces: 0.25, sp: 0,  sdp: 5,  cost: 1000, mount: "internal" },
  MICROWAVE_DETECTOR: { key: "MICROWAVE_DETECTOR", label: "Microwave Detector",    category: "sensor",   weight: 0,  spaces: 0.25, sp: 0,  sdp: 5,  cost: 5000, mount: "internal" },

  // ── Utility (General + Auto-Doctors, p.64) ──
  FIRE_EXTINGUISHER:  { key: "FIRE_EXTINGUISHER",  label: "Fire Extinguisher",     category: "utility",  weight: 10, spaces: 1,   sp: 20, sdp: 20, cost: 500,  mount: "either" },   // corrected to MM p.70
  HEAVY_TOOL_SUITE:   { key: "HEAVY_TOOL_SUITE",   label: "Heavy Tool Suite",      category: "utility",  weight: 50, spaces: 2,   sp: 15, sdp: 40, cost: 400,  mount: "either" },   // corrected to MM p.70
  LIGHT_TOOL_SUITE:   { key: "LIGHT_TOOL_SUITE",   label: "Light Tool Suite",      category: "utility",  weight: 8,  spaces: 1,   sp: 0,  sdp: 15, cost: 560,  mount: "internal" }, // electronic/light-mech repair (p.70)
  SEARCHLIGHT:        { key: "SEARCHLIGHT",        label: "Searchlight",           category: "utility",  weight: 5,  spaces: 0,   sp: 10, sdp: 5,  cost: 300,  mount: "external" }, // white/IR/UV; can blind (+4 WA, 200m); +200eb armors to 10SP/10SDP
  WINCH_GRAPPLE:      { key: "WINCH_GRAPPLE",      label: "Winch & Grapple",       category: "utility",  weight: 20, spaces: 1,   sp: 0,  sdp: 40, cost: 500,  mount: "internal" }, // 100m cable, 1200kg winch (p.70)
  KWIKFIX_AUTODOC:    { key: "KWIKFIX_AUTODOC",    label: "RussianArms Kwikfix",   category: "utility",  weight: 1,  spaces: 0.5, sp: 0,  sdp: 15, cost: 200,  mount: "internal" },
  BODYWEIGHT_MEDIC:   { key: "BODYWEIGHT_MEDIC",   label: "Bodyweight Medic",      category: "utility",  weight: 3,  spaces: 1,   sp: 0,  sdp: 15, cost: 2000, mount: "internal" },
  ARASAKA_MONITOR:    { key: "ARASAKA_MONITOR",    label: "Arasaka Monitor",       category: "utility",  weight: 1,  spaces: 1,   sp: 0,  sdp: 15, cost: 800,  mount: "internal" },  // 4 injections + KO/death broadcast + 1d6h beacon
  MILITECH_REPEATER:  { key: "MILITECH_REPEATER",  label: "Militech Repeater",     category: "utility",  weight: 3,  spaces: 2,   sp: 0,  sdp: 25, cost: 4000, mount: "internal" },  // 7 meds; +2 on every stun/death re-roll
  ORBITAL_AIR_PRIME:  { key: "ORBITAL_AIR_PRIME",  label: "Orbital Air Prime",     category: "utility",  weight: 2,  spaces: 1,   sp: 0,  sdp: 20, cost: 8000, mount: "internal" },  // = Repeater, smaller

  // ── Movement (p.68) ──
  CLIMBERS:           { key: "CLIMBERS",           label: "Climbers",              category: "movement", weight: 1,  spaces: 0.5, sp: 30, sdp: 15, cost: 1000, mount: "either",  perLimb: true },
  SWIMMER:            { key: "SWIMMER",            label: "Swimmer Unit",          category: "movement", weight: 50, spaces: 2,   sp: 25, sdp: 60, cost: 6000, mount: "external" },
  JUMP_JETS:          { key: "JUMP_JETS",          label: "Jump Jets",             category: "movement", weight: 0,  spaces: 1,   sp: 20, sdp: 30, cost: 10000, mount: "retract" },
  GLIDER:             { key: "GLIDER",             label: "Glider",                category: "movement", weight: 45, spaces: 6,   sp: 15, sdp: 30, cost: 3000,  mount: "retract" },   // retractable gliding wings (p.69)
  FLIGHT_UNIT:        { key: "FLIGHT_UNIT",        label: "Flight Unit",           category: "movement", weight: 300,spaces: 0,   sp: 30, sdp: 60, cost: 75000, mount: "external" },  // true flight; sled=0 spaces, flying-wing=8
  SKATES_POWERED:     { key: "SKATES_POWERED",     label: "Skates (Powered)",      category: "movement", weight: 14, spaces: 2,   sp: 20, sdp: 20, cost: 4000,  mount: "retract" },   // ~117 km/h; 1 space/leg
  SKATES_UNPOWERED:   { key: "SKATES_UNPOWERED",   label: "Skates (Unpowered)",    category: "movement", weight: 5,  spaces: 1,   sp: 20, sdp: 20, cost: 500,   mount: "external" },  // double MA; 1/2 space/leg

  // ── Safety (Trooper Safety, p.64) ──
  ESCAPE_HATCH:       { key: "ESCAPE_HATCH",       label: "Escape Hatch",          category: "safety",   weight: 1,  spaces: 0.5, sp: 0,  sdp: 30, cost: 500,  mount: "internal" },
  LIFE_SUPPORT:       { key: "LIFE_SUPPORT",       label: "Extended Life Support", category: "safety",   weight: 10, spaces: 1,   sp: 30, sdp: 20, cost: 500,  mount: "either" },   // per 10kg/4hr unit; corrected to MM p.67
  SELF_SEAL:          { key: "SELF_SEAL",          label: "Self-Seal Compression", category: "safety",   weight: 5,  spaces: 4,   sp: 0,  sdp: 50, cost: 6000, mount: "internal" },
  FOOD_FILTRATION:    { key: "FOOD_FILTRATION",    label: "Food/Filtration",       category: "safety",   weight: 2,  spaces: 0.5, sp: 0,  sdp: 10, cost: 400,  mount: "internal" },  // 2.5 days no rations/waste
  EXTRA_POWER_CELLS:  { key: "EXTRA_POWER_CELLS",  label: "Extra Power Cells",     category: "safety",   weight: 0,  spaces: 0.5, sp: 0,  sdp: 15, cost: 2000, mount: "internal" },  // wt ≈6% chassis (Russian +50%); +8 hrs each, 48 hr max

  // ── Defensive / countermeasures (ACPA Defensive Systems, p.79 / charts p.97) ──
  EMP_SPONGE:         { key: "EMP_SPONGE",         label: "EMP Sponge",            category: "defensive", weight: 2, spaces: 0.5, sp: 0,  sdp: 30, cost: 500,    mount: "internal" },  // one-shot EMP protection
  SMOKE_CANNISTER:    { key: "SMOKE_CANNISTER",    label: "Smoke Cannister",       category: "defensive", weight: 4, spaces: 1,   sp: 20, sdp: 15, cost: 200,    shots: 6, mount: "external" },  // −3 to-hit vs visual guidance; corrected to MM p.79
  IR_BAFFLING:        { key: "IR_BAFFLING",        label: "IR Baffling",           category: "defensive", weight: 0, spaces: 0,   sp: 0,  sdp: 0,  cost: 0,      mount: "internal" },  // SPECIAL: cost = 10% chassis cost; reduces IR signature only; no spaces/SP/SDP (MM p.79)
  GHOST_DECOY:        { key: "GHOST_DECOY",        label: "Ghost Decoy Cannister", category: "defensive", weight: 4, spaces: 0.5, sp: 20, sdp: 10, cost: 3000,   shots: 1, mount: "external" },  // one-shot ECM decoy (~1 min); corrected to MM p.79
  AGAMS:              { key: "AGAMS",              label: "AGAMS Anti-Missile",    category: "defensive", weight: 25, spaces: 2,  sp: 20, sdp: 20, cost: 24000,  shots: 30, mount: "external" },  // gatling anti-missile: 3d6 (Pen 0), ROF 30, 400m; 25kg empty/+13kg full mag; MM p.79
  ECM_SUITE:          { key: "ECM_SUITE",          label: "ECM Suite",             category: "defensive", weight: 25, spaces: 2,  sp: 0,  sdp: 15, cost: 500000, mount: "internal" },  // jamming, 100m radius; corrected to MM p.79
  EMP_CAPACITOR:      { key: "EMP_CAPACITOR",      label: "EMP Capacitor",         category: "defensive", weight: 2,  spaces: 1,   sp: 0,  sdp: 10, cost: 1500,   mount: "internal" },  // absorbs/discharges EMP; 50% destroyed (p.79)
  STARDUST_CANNISTER: { key: "STARDUST_CANNISTER", label: "Stardust Cannister",    category: "defensive", weight: 2,  spaces: 0.5, sp: 20, sdp: 25, cost: 500,    shots: 2, mount: "external" },  // anti-laser glass dust (90%); SDP 25 (user-confirmed from ACPA defensive table)
  RIBBON_CANNISTER:   { key: "RIBBON_CANNISTER",   label: "Ribbon Cannister",      category: "defensive", weight: 3,  spaces: 1,   sp: 20, sdp: 20, cost: 300,    shots: 3, mount: "external" },  // anti-radar chaff foil (p.79)
  FLASH_CANNISTER:    { key: "FLASH_CANNISTER",    label: "Flash Cannister",       category: "defensive", weight: 6,  spaces: 1,   sp: 20, sdp: 20, cost: 300,    shots: 6, mount: "external" },  // flash-stun + anti-thermal flare (p.79)
  ECCM:               { key: "ECCM",               label: "ECCM",                  category: "defensive", weight: 5,  spaces: 1,   sp: 0,  sdp: 15, cost: 100000, mount: "internal" },  // burns through jamming on 4-10 (p.79)
  STEALTHING:         { key: "STEALTHING",         label: "Stealthing",            category: "defensive", weight: 0,  spaces: 0,   sp: 0,  sdp: 0,  cost: 0,      mount: "internal" },  // SPECIAL: 10x suit cost, -10% capacity, -1 external space/area (p.79)
};

/** Catalog entry for a key (or null). PURE. */
export function acpaSystemDef(key) {
  return ACPA_SYSTEMS[key] ?? null;
}

/**
 * A system's structural points (SDP). The charts list SDP directly; a system given an SP but no SDP
 * has SDP = 3 × SP (MM p.62). PURE — accepts a catalog def or any {sdp, sp}.
 */
export function acpaSystemSdp(def) {
  const sdp = Number(def?.sdp) || 0;
  if (sdp > 0) return sdp;
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

/* ------------------------------- Per-system SDP damage (MM p.55) ------------------------------- */

/**
 * Apply SDP damage to one mounted system in a struck body area (MM p.55-56). Picks the first LIVE
 * system in the area, adds the damage to its accumulated `sdpDamage`, and marks it destroyed once that
 * meets/exceeds its SDP. PURE — returns a NEW array plus the outcome; if no live system is in the area,
 * nothing is consumed (the caller falls through to frame SDP, per D-3).
 * @param {Array}  mounted  [{ key, area, mount, sdpDamage?, destroyed? }]
 * @param {string} area     struck body-area key (head/rArm/lArm/rLeg/lLeg/torso)
 * @param {number} sdpDamage incoming SDP damage
 * @returns {{ index:number, hitKey:(string|null), destroyed:boolean, overflow:number, updated:Array }}
 */
export function acpaHitSystem(mounted = [], area, sdpDamage = 0) {
  const updated = (mounted ?? []).map(m => ({ ...m }));
  const dmg = Math.max(0, Number(sdpDamage) || 0);
  const index = updated.findIndex(m => m?.area === area && !m?.destroyed);
  if (index < 0) return { index: -1, hitKey: null, destroyed: false, overflow: dmg, updated };
  const m = updated[index];
  // Prefer the mounted entry's own SDP/SP (a placed Item may be edited); fall back to the catalog.
  const def = acpaSystemDef(m.key) ?? {};
  const sdp = acpaSystemSdp({ sdp: m.sdp ?? def.sdp, sp: m.sp ?? def.sp });
  const prev = Math.max(0, Number(m.sdpDamage) || 0);
  const total = prev + dmg;
  const destroyed = sdp > 0 && total >= sdp;
  m.sdpDamage = Math.min(total, sdp || total);
  m.destroyed = !!destroyed;
  // Damage beyond what destroying this system absorbs spills back to the caller (→ frame SDP).
  const overflow = destroyed ? Math.max(0, total - sdp) : 0;
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
