/**
 * Data corrections for BASE-SYSTEM compendium items (eyes-verified against the books).
 *
 * The base system's packs can't be edited in place (they're re-installed on every system update), so
 * book-verified corrections live here and are applied at the two places the module touches that data:
 *   1. `preCreateItem` — a copy created FROM a corrected compendium item (drag-out, shop purchase)
 *      gets the corrected name/cost/flavor plus the correction notes appended, so owned copies carry
 *      the book values. Matching is by the copy's `_stats.compendiumSource` uuid (v12+; never by name).
 *   2. The shop (catalog.js / purchase.js) — reads `correctedCost`/`correctionFor` so browsing,
 *      purchase charging and the request flow all price with the corrected values.
 *
 * `priceRange` marks a VARIABLE-PRICE item (the book prints a range, e.g. "200-1000eb by style"): the
 * catalog shows the range as a suggestion and, for these items only, a GM price override takes
 * precedence over the compendium cost (see resolveCatalogPrice's preferOverride) so the GM can set the
 * final price without editing the compendium.
 *
 * PURE DATA + pure lookups here; the only impure piece is registerDataCorrections() (the hook), called
 * from the module's init hook. Notes text is item DATA (like pack content), not UI — it stays English.
 * Sourced from the user's book audit 2026-07-05 (import-staging/item-audit/USER-AUDIT-2026-07-05.md),
 * the three upstream data PRs (#41 typos+HC, #42 weapon accuracy, #43 Avante/Llama/Blitzkrieg —
 * submitted 2026-06-26, still unmerged upstream, so module users get them here), and the special-
 * mechanics survey's base-data fixes (import-staging/special-mechanics/): embedded-weapon
 * attackSkill values that were authored in Russian, and CyberWorkType.Skill maps keyed by the
 * RU skill pack's _ids — both of which resolve to nothing on an English world. Skill maps KEEP the
 * original _id key and gain the English skill-NAME key (the engine's documented fallback), so
 * RU worlds keep working and EN worlds start working.
 *
 * A correction may carry `patch: { "<dot.path>": value }` — paths are relative to `system` and are
 * applied last (after name/cost/flavor/notesAppend).
 */

const CYBERWARE_OLD = "cyberpunk2020.cyberware-old";

// Embedded-weapon skill fixes: the payload stores the skill NAME (matching what real weapon items
// store: "Handgun", "Melee", "Brawling", "Heavy Weapons"); the shipped values are Russian.
const ATTACK_SKILL_RU_EN = {
  "Ближний бой": "Melee",
  "Драка": "Brawling",
  "Стрельба из пистолета": "Handgun",
  "Тяжёлое оружие": "Heavy Weapons",
};
/** Correction entry fixing an embedded cyberweapon's attack skill (CyberWorkType.Weapon). */
function cwAttackSkill(ru) { return { patch: { "CyberWorkType.Weapon.attackSkill": ATTACK_SKILL_RU_EN[ru] } }; }
/** Correction entry fixing a plain weapon item's attack skill. */
function weaponAttackSkill(ru) { return { patch: { attackSkill: ATTACK_SKILL_RU_EN[ru] } }; }
/** Correction entry re-keying a CyberWorkType.Skill map: keep the RU-pack _id key, add the EN name. */
function skillAlias(id, enName, mod) { return { patch: { "CyberWorkType.Skill": { [id]: mod, [enName]: mod } } }; }
/** Correction entry making a base-pack item a P3 light emitter (ranges from the item's own printed text). */
function mechLight({ shape = "cone", bright = 10, dim = 20, angle = 45, color = "" } = {}) {
  return { patch: { mechLight: { enabled: true, on: false, shape, bright, dim, angle, color } } };
}
/** P4 vision-device patch (mode per the item's own printed text; range = playable default).
 *  `requiresItem` = pipe-separated exact illuminator item names (the UV class: the device only
 *  works while one of them is carried, equipped and lit — see mech/vision.js). */
function mechVision(mode, range = 20, requiresItem = "") {
  return { mechVision: { enabled: true, on: false, mode, range, requiresItem } };
}
/** P6 protection-tag patch: e.g. mechProtection({ gas: { immune: true } }) or, for the Q8 kinds,
 *  mechProtection({ gas: { percent: 70 } }) / mechProtection({ sonic: { damageMult: 0.75 } }). */
function mechProtection(hazards) {
  const entry = (h) => ({ immune: false, mod: 0, percent: 0, damageMult: 0, ...(hazards[h] ?? {}) });
  return { mechProtection: { enabled: true, gas: entry("gas"), flash: entry("flash"), sonic: entry("sonic") } };
}
/** P5 roll-mod-provider patch (numbers straight from the item's own printed text; `auto:false` =
 *  suggested UNTICKED, for gear whose bonus only applies in a narrow situation). */
function mechRollMods({ attackMod = 0, skillName = "", skillMod = 0, auto = true, skillMods = [] } = {}) {
  return { mechRollMods: { enabled: true, attackMod, skillName, skillMod, auto, skillMods } };
}
/** P7 timed-consumable patch (doses/duration from the item's own printed text; duration may be a
 *  roll formula, rolled at use time). */
function mechConsumable({ doses = 1, durationTurns = "", note = "" } = {}) {
  return { mechConsumable: { enabled: true, doses, durationTurns, note } };
}

/** One `<p>` block appended to a corrected item's notes. */
function note(text) { return `<p>${text}</p>`; }

const FINGER_NOTE = "Dynalar cyberfinger option (Chromebook 3 p.22). Requires an installed cyberhand or cyberarm — compatible with any model. A hand fits up to 5 cyberfinger options.";

/** packId → itemId → correction: { name?, cost?, flavor?, priceRange?{min,max}, notesAppend? } */
export const DATA_CORRECTIONS = {
  [CYBERWARE_OLD]: {
    // Super Compact Braindance → the book's full product name (Chromebook 3 p.23).
    tsY2j88C5WxOTbDG: { name: "Super Compact Braindance Recorder" },
    // LiveWires: 400eb is the NON-implant wearable's price; the body implant costs 200eb (CB3 p.24).
    s4D3tB3dwEsVs3AE: {
      cost: 200,
      flavor: "Prehensile interface cables (body-implant version)",
      notesAppend: note("Body-implant version: 200eb. A non-implant wearable version exists for 400eb (sold as gear). (Chromebook 3 p.24)"),
    },
    // Bonespike (CB3 p.25): surgery code, breakage roll, concealment.
    lNqrIKwpKnbbkZKi: {
      notesAppend: note("Surgery: MA. Damage 1d6+4. Roll 3 or less on 1d10 to avoid breakage. Noticing the bonespike slit requires a Very Difficult Awareness check; X-rays and scanners see only forearm reinforcement. (Chromebook 3 p.25)"),
    },
    // Enable cyberlimbs (CB3 p.34): the pack carried the USED prices; the book's new prices are
    // 4000/arm and 6000/leg. Used prices kept in the description.
    ksNQKhJLA69OyVZi: {
      cost: 4000,
      flavor: "23/33 SDP; REF -1. New price; used examples ~500eb",
      notesAppend: note("New: 4,000eb per arm (used examples ~500eb). 23 SDP to disable, 33 SDP to destroy. Reduces the user's REF by 1. Humanity Cost 2d6+2. (Chromebook 3 p.34)"),
    },
    "58jU3dLX2vobSely": {
      cost: 6000,
      flavor: "28/35 SDP; REF -1; MA -1 per leg. New price; used examples ~700eb",
      notesAppend: note("New: 6,000eb per leg (used examples ~700eb). 28 SDP to disable, 35 SDP to destroy. Reduces the user's REF by 1; MA reduced by 1 per leg. Humanity Cost 3d6+3 each. (Chromebook 3 p.34)"),
    },
    // General Products exoskeletons (CB3 p.34): the book's movement caveat.
    NpOACgBGfKqubbbU: { notesAppend: note("The wearer moves like a vehicle instead of a person while the exoskeleton is worn. (Chromebook 3 p.34)") },
    ZCcxYK3Hd9yJC9wy: { notesAppend: note("The wearer moves like a vehicle instead of a person while the exoskeleton is worn. (Chromebook 3 p.34)") },
    // Spectrum outer-ear attachments (CB3 p.35): variable price by style.
    hqp1XekLTwvDxuIC: {
      priceRange: { min: 200, max: 1000 },
      notesAppend: note("Outer-ear attachments, 200–1000eb by style: Elven, pointed, batwing, scooping. The GM sets the final price for the chosen style. (Chromebook 3 p.35)"),
    },
    // Gene-Tek See-It transparent skin (CB3 p.35): per-square-meter pricing + HC.
    qBZuO58sBE7zvcyu: {
      notesAppend: note("Cost is per square meter of skin covered. Humanity Cost 3d6 per square meter — 6d6 if the entire body is covered. Arms are ½ square meter each; legs are 1 square meter each. (Chromebook 3 p.35)"),
    },
    // Dermatech Mood Skin (CB3 p.35): per-m² HC + the legacy-stock BODY degradation.
    OLnmO8cNfiDhd6cW: {
      notesAppend: note("Cost is per square meter of skin covered. Humanity Cost 1d6 per square meter (a single entire limb ≈1d6; the torso ≈2d6). Old stock is still floating around and being used anew: a character implanted with it loses 1 BODY every 2 months for a year. (Chromebook 3 p.35)"),
    },
    // Lead's nails (CB3 p.36): set vs per-nail pricing; Show-Off extras.
    POMGj69ON3zmGXoQ: { notesAppend: note("200eb for a set of 10 nails, or 25eb per single nail. (Chromebook 3 p.36)") },
    "9e7tY4x9hcXqY64r": {
      notesAppend: note("425eb for a set of 10 nails, or 45eb per single nail. A 90eb coloring nail pen is sold separately. The nails may be permanently implanted as cyberware for 2 Humanity Cost per pair of hands or feet. (Chromebook 3 p.36)"),
    },
    // The Chromebook 3 p.22 Dynalar cyberfinger options (7 products): option requirement + limit.
    // Probe Link prints "-1 to all actions with vehicles" (spans Drive/Pilot rolls — nothing to
    // auto-wire onto one skill, so the penalty stays a note for the modifiers window).
    oC2Znx4VqJKXvTYD: { notesAppend: note(FINGER_NOTE) + note("Book note: −1 to all actions with vehicles. Apply the −1 in the modifiers window when operating a vehicle through the plug. Cannot be used with the Quick-Change option.") },
    JRjY6m94O54GmMas: { notesAppend: note(FINGER_NOTE) },   // Parabolic Microphone
    vIS7tLKn2knqwZYJ: { notesAppend: note(FINGER_NOTE) },   // Flasher
    atR26dOPGVwYD9nv: { notesAppend: note(FINGER_NOTE) },   // IR/UV Flashlight
    SIUDnA5V2TsKt8iE: { notesAppend: note(FINGER_NOTE) },   // Flare
    // Storage Compartment prints no capacity ("a small storage space inside the finger") →
    // default 1 stowed-item slot, GM-editable on the item.
    "6nlw0wJmhdg1z9wu": {
      patch: { "CyberWorkType.OptionsAvailable": 1 },
      notesAppend: note(FINGER_NOTE) + note("Container: 1 stowed-item slot — the book prints no capacity; the count is editable on this item (Options Available). What fits inside a finger is the GM's call."),
    },
    Go9manEx2jk02j8i: { notesAppend: note(FINGER_NOTE) },   // Laser Pointer

    // ── PR #41 (upstream, unmerged): typo + malformed Humanity Cost ──
    "6YZWh3c73DRynHoi": { patch: { humanityCost: "3d6" } },          // Kiroshi: "3d6+" is not a rollable formula
    "2iPdzr4QzklAsWDn": { name: "Air Hypo" },                        // was "Aip Hypo"
    sx1PGl6gzLSZ18sn: { name: "Dynalar Endo-Frame (Basic)" },        // was "Dynala"
    // ── PR #43 (upstream, unmerged): Blitzkrieg (Chromebook 4 text: 1050eb; surgery M; HC 2d6) ──
    Vg33kDXF2VZlqX1K: { cost: 1050, patch: { surgCode: "M", humanityCost: "2d6" } },
    // ── P3 light emitters (beam ranges from each item's own printed text) ──
    "4wxdvs3c63eQKino": mechLight({ shape: "cone", bright: 1, dim: 3 }),            // Cyberlimb Flashlight — "3m range"
    D5uZmayiXzXXLTRM: mechLight({ shape: "circle", bright: 0, dim: 1 }),            // Flashlite Implant — "semi-focused glow; 1m"
    z3unj4w9y7CpJgOq: mechLight({ shape: "cone", bright: 1, dim: 3 }),              // Flashlight Implant — "3m range"
    wAGWZRb3afAZDYhj: mechLight({ shape: "cone", bright: 10, dim: 25 }),            // Mini Light — "25m beam"
  },

  // ── PR #41 (upstream, unmerged): name typos across gear packs ──
  "cyberpunk2020.medical": {
    fA02aOWaC6JRuWg8: { name: "First Aid Kit" },                     // was "Fist Aid Kit"
    // P5: "+2 on DiagnoseSkill" (Medical p.71) — suggested on Diagnose Illness rolls.
    oTl9WjtAxnwI2wly: { patch: mechRollMods({ skillName: "Diagnose Illness", skillMod: 2 }) },  // Medscanner
    // P7: an adhesive drug patch is one application; the drug it carries is the GM's call
    // ("Price differs per used Drug" — the book prices the drug, not the patch).
    I2c4U3FtntrJCIEl: { patch: mechConsumable({ doses: 1 }) },       // Slap Patch
  },
  "cyberpunk2020.rentalandservices": {
    oN5HJZeZ4Ef4MMTY: { name: "Apartment/Condo – Combat Zone" },
    Odj2rS5kKKejVWVr: { name: "Apartment/Condo – Corporate Zone" },
    a1PfGEaWAmwhvKIg: { name: "Apartment/Condo – Executive Zone" },
    fe2JHml3p3rOS9M3: { name: "Apartment/Condo – Moderate Zone" },
  },
  "cyberpunk2020.surveillance": {
    // PR #41 name fixes + P4 vision profiles (their own text: IR / light amplification).
    j8D1o1qngrZDsmaB: { name: "IR Goggles", patch: mechVision("infrared") },       // was "Googles"
    cok1ozJSd3VniVAt: { name: "Light Booster Goggles", patch: mechVision("lowlight") },
    // Invisible illumination can't be a token light (everyone would see it); the engine instead
    // recognizes this item BY NAME as an equipped illuminator for requiresItem-gated viewers.
    "79Nyt0GU3pYGu7BF": { notesAppend: note("Invisible infrared illuminator — lights a scene only for IR/UV viewers (Core). Carrying it equipped satisfies devices that require an IR source (e.g. UV optics list it by name); it never paints a visible token light.") },  // IR Flash
  },
  "cyberpunk2020.tools": {
    gkjBAKUHKs4pd9uE: { name: "Protective Goggles" },
    // ── P3 light emitters (Tools p.69; glow durations stay in the flavor text) ──
    KjN5Qr3r8vPjiD9i: mechLight({ shape: "cone", bright: 10, dim: 20 }),                  // Flashtube
    LRy3GrRtMME1asRE: mechLight({ shape: "circle", bright: 0, dim: 2 }),                  // Flash Paint (painted surfaces, 4h)
    OLlP8EaVlXIqzCVE: mechLight({ shape: "circle", bright: 1, dim: 4, color: "#66ff66" }), // Glowstick (6h chem-glow)
    yqmogdOnO4BpGlHl: mechLight({ shape: "circle", bright: 0, dim: 2 }),                  // Flash Tape (6h)
    // ── P6 protection: a filter mask seals breathing while worn ("Contains 2 Filters") ──
    iQcJpq8LofSYbPJO: { patch: mechProtection({ gas: { immune: true } }) },               // Breathing Mask
    // Core p.69 prints prose only (diagnostic microcomp) — no game number to wire.
    mIH2I6fOI5iwj7wa: { notesAppend: note("Handheld diagnostic microcomp with I/O connectors and probes: runs diagnostics, identifies malfunctioning components, displays internal schematics (Core p.69). The book prints no roll bonus — any repair help is the GM's call.") },  // Techscanner
  },
  "cyberpunk2020.furnishing": {
    nlf3SoNWrlRZLwEM: mechLight({ shape: "circle", bright: 5, dim: 10 }),                 // Lamp
  },

  // ── PR #42 (upstream, unmerged): weapon-accuracy corrections (book WA values) ──
  // Thrown/area/emplaced heavy weapons print WA 0, the pack shipped 1.
  "cyberpunk2020.heavy": {
    WJMz0EzGuDgv3KXu: { patch: { accuracy: 0 } },  // Barrett-Arasaka Light 20mm
    B5brbHA8AfLERMNH: { patch: { accuracy: 0 } },  // C-6 "Flatfire" Plastic Explosive
    kzs0XczTAwo1pgfb: { patch: { accuracy: 0 } },  // Dazzle Grenade
    CG2nNDkUA2eroMti: { patch: { accuracy: 0 } },  // Gas Grenade
    P1fY9ea1Et8yT2Zd: { patch: { accuracy: 0 } },  // Incendiary Grenade
    u9R4ZnzKOlIFva0o: { patch: { accuracy: 0 } },  // Grenade Launcher (conventional)
    iN1wBc0bMIf1m7kG: { patch: { accuracy: 0 } },  // Sonic Grenade
    ggK24JleGw0yaQBt: { patch: { accuracy: 0 } },  // Stun Grenade
    IpfEt6QiPxF1Jhfl: { patch: { accuracy: 0 } },  // Fragmentation Grenade
    MKMz4FoO3R3tOqoB: { patch: { accuracy: 0 } },  // Mine (all types)
  },
  "cyberpunk2020.exotics": {
    wOxrlZlz79WpiWqI: { patch: { accuracy: 0 } },  // EagleTech "Tomcat" Compound Bow
    "4AdEzzSAr2oUZPYn": { patch: { accuracy: 0 } },  // Militech Electronics LaserCannon
    "5v3kRF7MZ8t702Aa": { patch: { accuracy: 0 } },  // Techtronica 15 Microwaver
    // PR #43: Avante is the P-1135 (core p.62-63 + Data Screen), WA 0.
    "5d4juFywt9NMCYTw": { name: "Avante P-1135 Needlegun", patch: { accuracy: 0 } },
  },
  "cyberpunk2020.melee": {
    CfQQEwck7VZNQzC6: { patch: { accuracy: 1 } },  // Kendachi Monoknife Naginata (blank; Tanto form is WA 1)
    // Unarmed strikes rolled with the Brawling skill; the pack shipped the RU skill name.
    TF0nBrjofPX2RiuG: weaponAttackSkill("Драка"),  // Kick
    TZoiQuE8fUzJ8Jta: weaponAttackSkill("Драка"),  // Strike
  },
  "cyberpunk2020.rifles-add": {
    qzZ9KgXMqlWkfZ8B: { patch: { accuracy: 4 } },  // FR-F6 (book WA 4)
  },
  "cyberpunk2020.pistols": {
    ghAVVP4pbH2zOIx6: { name: "Llama Comanche" },  // PR #43: was "Commanche"
  },

  // ── Embedded cyberweapons: attackSkill authored in Russian → the English skill name ──
  "cyberpunk2020.cyberlimbs": {
    JJQxF1pH3sixjEeH: cwAttackSkill("Ближний бой"),  // BuzzHand → Melee
    WdE0SLOXaCxzF2fD: cwAttackSkill("Ближний бой"),  // Spike Hand → Melee
    ZPYXXzR9Uchj3sR5: cwAttackSkill("Ближний бой"),  // Hammer Hand → Melee
    eXLpplQloedXOMqO: cwAttackSkill("Ближний бой"),  // Spike Heel Foot → Melee
    sEi6YjMyjBBfCBwo: cwAttackSkill("Ближний бой"),  // Talon Foot → Melee
    tyrJCuKZ85jdTU4q: cwAttackSkill("Драка"),        // Ripper Hand → Brawling
    // Web Foot: Swimming +3 was keyed by the RU skill pack's _id → add the EN name key.
    rLCoPPiA8FLcLLdm: skillAlias("VP45FA534hCM3PdM", "Swimming", 3),
    // Cyberarm compartments: the pack ships them as inert Descriptive options (OptionsAvailable 0),
    // so they can't actually HOLD anything. Giving them slots makes them containers in the Q6
    // engine: install into a cyberarm as usual, then stow gear inside (drag onto the option, or the
    // gear item's "installed into" picker). WHAT fits is deliberately not type-gated — size is the
    // GM's call (the slot count is a soft default, editable on the item as Options Available).
    "84GMoHFhEThjcYTi": {   // Hidden Holster — holds the one holstered weapon
      patch: { "CyberWorkType.OptionsAvailable": 1 },
      notesAppend: "Container: 1 stowed-item slot for the holstered weapon (drag it onto this option once the holster is installed). Weapon size based on Body Type — what fits is the GM's call.",
    },
    I5jT46ciWO4jF1pQ: {     // Storage Space — a small lockable 2"x6" compartment
      patch: { "CyberWorkType.OptionsAvailable": 2 },
      notesAppend: "Container: 2 stowed-item slots (2\"x6\" lockable space). What fits is the GM's call; the slot count is editable on this item (Options Available).",
    },
  },
  "cyberpunk2020.cyberweapons": {
    "32q2BsXIyO3zzNP2": cwAttackSkill("Драка"),        // Scratchers → Brawling
    "39em8YDfUbk6I1tb": cwAttackSkill("Стрельба из пистолета"),  // Popup Gun → Handgun
    EFjaaxAWk4CjyI5H: cwAttackSkill("Стрельба из пистолета"),    // 2 shot Capacitor Laser → Handgun
    Ec5j4rEoTSDUkvbY: cwAttackSkill("Драка"),          // Rippers → Brawling
    PGSQ5CXATS4wruv5: cwAttackSkill("Ближний бой"),    // Cybersnake → Melee
    REpTpQ8k1fUiUOzD: cwAttackSkill("Драка"),          // Wolvers → Brawling
    V0EqKSFZ1qL6eEKR: cwAttackSkill("Ближний бой"),    // Slice N' Dice → Melee
    WPWyNQZmHHX9PjI9: cwAttackSkill("Стрельба из пистолета"),    // Flame thrower → Handgun
    bgCK2vGTXzSfIXRN: cwAttackSkill("Драка"),          // Vampires - Canines → Brawling
    rtmqdwfsRopUS9wP: cwAttackSkill("Тяжёлое оружие"), // Micro-missile Launcher → Heavy Weapons
    tDX55k41mQRLkCjA: cwAttackSkill("Тяжёлое оружие"), // Grenade Launcher → Heavy Weapons
    txTtZM5zEibnsRTn: cwAttackSkill("Драка"),          // Big Knucks → Brawling
  },

  // ── CyberWorkType.Skill maps keyed by RU-pack skill _ids → add the EN skill-name key ──
  "cyberpunk2020.bioware": {
    sLFvdD9v8CZcBZHx: skillAlias("svx86NhUYhqVlLNw", "Resist Torture/Drugs", 4),  // Toxin Binders
  },
  "cyberpunk2020.cyberaudio": {
    HAFF2PM96a1WkrFF: skillAlias("jBfPdSDGwvIEq66p", "Awareness/Notice", 2),  // Sound Editing
    JNhdO6o73hylJLga: skillAlias("jBfPdSDGwvIEq66p", "Awareness/Notice", 1),  // Amplified Hearing
    jgAQuEGsaj8fykCJ: skillAlias("4ylTN4krm7fhMYJv", "Human Perception", 2),  // Voice Stress Analyzer
    // P6/Q8: "Automatic noise compensation. −25% from SW" → a sonic damage multiplier of 0.75.
    // Data-ready: no sonic damage path consumes it yet (flash/sonic effect engines come later),
    // so this stores the book's number without an invented save-mod mapping.
    fkF5mng29EpC7nvE: { patch: mechProtection({ sonic: { damageMult: 0.75 } }) },  // Level Damper
  },
  "cyberpunk2020.cyberoptic": {
    C868gK04Emnui8Dm: skillAlias("jBfPdSDGwvIEq66p", "Awareness/Notice", 2),  // Image Enhancement
    // P4 vision devices — modes straight from each option's printed text.
    qiTXkPooklv9UHsI: { patch: mechVision("infrared") },     // Infrared — "see in total darkness, using heat emissions"
    YBS9vFZX14R6bwk0: { patch: mechVision("lowlight") },     // Low Lite — "see in dim light, almost total darkness"
    yOFBoZ9tV3czAW2B: { patch: mechVision("thermograph") },  // Thermograph sensor — "see heat patterns"
    // Ultra Violet — "see in darkness; using UV flash": only works while an illuminator is carried
    // (Q1c — the cyberfinger IR/UV Flashlight or the surveillance IR Flash), equipped and lit.
    XG6ffmsWnkUWNkcW: { patch: mechVision("uv", 20, "IR/UV Flashlight|IR Flash") },
    // P6: "Immune to flash; laser blinding" — data-ready for the future flash effect engine.
    H7PSx0gcnKET6usp: { patch: mechProtection({ flash: { immune: true } }) },  // Anti-Dazzle
    // P5: "+1 on all Smartgun attacks" — pre-ticked; untick when firing a non-smart weapon.
    wO5L7J2iuRHjXI7d: { patch: mechRollMods({ attackMod: 1 }) },  // Targeting Scope
  },
  "cyberpunk2020.fashonware": {
    T7uGBTZgaeB7NKIm: skillAlias("svx86NhUYhqVlLNw", "Resist Torture/Drugs", 2),  // Biomonitor
  },
  "cyberpunk2020.implants": {
    i264oefxjekvVgnN: skillAlias("WotYfaW9pqhl7S6N", "Seduction", 1),  // Mr Studd Sexual Implant
    // P6: sealed internal air ("good for 10 to 25 minutes" — duration stays in the flavor).
    zOzfWnALVczrmjkZ: { patch: mechProtection({ gas: { immune: true } }) },  // Independent Air Supply
    // P6/Q8: "Stops gases; fumes. 70% effective" — the book's own percentage, kept as a per-exposure
    // d10 gate (roll ≤ 7 → the filter held this turn), NOT an invented save mod. The gas-cloud
    // per-turn block rolls it and shows the roll on the card.
    "1DFttayJLRcOeS94": { patch: mechProtection({ gas: { percent: 70 } }) },  // Nasal Filters
    // P7: "Boosts REF by +1 for 1d6+2 turns 3x per day" — the pack already carries Stat {ref:+1}
    // + Activatable, so the BASE engine owns the +1 while active; this adds the uses counter
    // (3; the per-day reset is the GM's) + the rolled duration whose expiry switches it back off.
    EHOfG6zqqaFTHIV8: { patch: mechConsumable({ doses: 3, durationTurns: "1d6+2", note: "+1 REF" }) },  // Adrenal Booster
  },
  "cyberpunk2020.neuralware": {
    "4gYluthCnbT7zVQQ": skillAlias("jBfPdSDGwvIEq66p", "Awareness/Notice", 2),  // Olfactory Boost
    "9CXsUvDafTQCGmbU": skillAlias("jBfPdSDGwvIEq66p", "Awareness/Notice", 2),  // Tactile Boost
    // P5: "+2 to Smartgun attacks" — pre-ticked (its owner's loadout is smart weapons);
    // untick when firing a non-smart weapon. Its Characteristic tag ships with empty payloads,
    // so this is the item's first live mechanic, not a double-apply.
    GWnQ3KQVL6PZpedS: { patch: mechRollMods({ attackMod: 2 }) },  // Smartgun Link
    // Q6 + the book's chip capacity: "Chipware Socket … Holds 10 chips." (Core p.83). AcceptsTypes
    // admits chips by type (they carry no Module block); the count stays GM-editable on the item.
    vfctuWRZxDfVxzV1: {   // Chipware Socket
      patch: { "CyberWorkType.OptionsAvailable": 10, "CyberWorkType.AcceptsTypes": ["Chip"] },
      notesAppend: "Container: holds 10 chips (Core p.83) — drag chips onto the installed socket to slot them. The count is editable on this item (Options Available).",
    },
    // The book also lets chips sit directly in the plugs but prints no count — notes only.
    x3bHNmrZaN3ZVssf: {   // Interface Plugs
      notesAppend: "Chips can be inserted directly into the plugs (Core p.82); the book prints no count. Set Options Available on this item if you want the plugs to hold chips as a container.",
    },
  },

  // ── P5 roll-mod tools (Security p.70): each prints a flat check bonus against ONE lock type,
  //    so the suggestion renders UNTICKED — the player claims it only when it actually applies. ──
  "cyberpunk2020.security": {
    oVGBBUXDnAph5s72: { patch: mechRollMods({ skillName: "Electronic Security", skillMod: 5, auto: false }) },  // Voc Decryptor — "+5 on Check against VocaLock"
    ycLktwLxqVMsxr7K: { patch: mechRollMods({ skillName: "Electronic Security", skillMod: 5, auto: false }) },  // Code Decryptor — "+5 on Check against CardLock"
  },
};

/** The correction entry for a compendium item, or null. */
export function correctionFor(packId, itemId) {
  return DATA_CORRECTIONS[packId]?.[itemId] ?? null;
}

/** The book-corrected cost for a compendium item (falls back to the raw cost when uncorrected). */
export function correctedCost(packId, itemId, rawCost) {
  const c = correctionFor(packId, itemId);
  return c && c.cost !== undefined ? c.cost : rawCost;
}

/** Parse "Compendium.<pack.id>.Item.<docId>" → {packId, itemId}, else null. */
function parseCompendiumSource(uuid) {
  const m = /^Compendium\.(.+)\.Item\.([A-Za-z0-9]{16})$/.exec(String(uuid ?? ""));
  return m ? { packId: m[1], itemId: m[2] } : null;
}

/** Pure dotted-path setter into plain objects (creates missing intermediates; no array paths needed). */
function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for (const p of parts.slice(0, -1)) o = (o[p] ??= {});
  o[parts[parts.length - 1]] = value;
}

/**
 * Apply a correction to a to-be-created item copy (mutates `data`, returns true if changed).
 * Pure given (data, correction) — exported for the corrections rig test.
 */
export function applyCorrectionToItemData(data, c) {
  if (!c) return false;
  if (c.name) data.name = c.name;
  data.system ??= {};
  if (c.cost !== undefined) data.system.cost = c.cost;
  if (c.flavor !== undefined) data.system.flavor = c.flavor;
  if (c.notesAppend && !String(data.system.notes ?? "").includes(c.notesAppend)) {
    data.system.notes = `${data.system.notes ?? ""}${c.notesAppend}`;
  }
  // Generic field patches (paths relative to `system`) — applied last so they win.
  if (c.patch) for (const [path, value] of Object.entries(c.patch)) setPath(data.system, path, value);
  return true;
}

/** Hook: copies created from a corrected compendium item carry the corrected data. */
export function registerDataCorrections() {
  Hooks.on("preCreateItem", (doc, data) => {
    const src = parseCompendiumSource(doc?._stats?.compendiumSource ?? data?._stats?.compendiumSource);
    if (!src) return;
    const c = correctionFor(src.packId, src.itemId);
    if (!c) return;
    const patch = { name: data.name, system: foundry.utils.deepClone(data.system ?? {}) };
    if (applyCorrectionToItemData(patch, c)) doc.updateSource({ name: patch.name, system: patch.system });
  });
}
