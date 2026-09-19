/**
 * Weapon melee-category extension (mirrors the ammo-relocation slice): the module models a couple of
 * melee weapon properties the base `weapon` DataModel does not declare — `edged` (½ SP vs soft armor,
 * CP2020 p.112) and `mono` (mono-edge: ⅓ SP vs soft / ⅔ SP vs hard, and breaks on a fumble) — plus a
 * `broken` flag the mono break-on-fumble rule sets. Those net-new fields live in the module, NOT the
 * base system's `weapon` model — so on a VANILLA host (Tilt's 1.1.1) the base model silently strips
 * them on write (the same class of gap the ammo/misc/skill notes describe), which left the combat
 * engine's `edged`/`mono` armor-multiplier branches with nothing persisted to read.
 *
 * This factory EXTENDS the registered `weapon` model (the C4 / mech pattern) and adds ONLY the fields
 * the base model is missing — so it fills the gap on vanilla and is a NO-OP on a fork whose weapon
 * schema already defines them, never re-declaring an existing field. Additive with defaults → no
 * migration; existing weapon items float (all three default false).
 */

const WEAPON_AUGMENT_FIELDS = {
  edged:  (f) => new f.BooleanField({ initial: false }),
  mono:   (f) => new f.BooleanField({ initial: false }),
  broken: (f) => new f.BooleanField({ initial: false }),
  // ── The gas-payload family (2026-08-28) ──────────────────────────────────────────────────────
  // A THROWN grenade is its own warhead: it has no loaded round to carry effect fields, so the
  // seam's fallback reads them off the WEAPON's own system (seam-shim.js ammoEffectFields, second
  // pass) — and the base weapon model strips undeclared fields on write, which is why the base
  // heavy pack's thrown Gas Grenade fired without ever raising its cloud. Same four fields the
  // cloud hook prices off a payload (damage-hooks.js _placeGasCloud: radius / duration / save
  // penalty), populated on the base item by the corrections layer (data-corrections.js, heavy).
  effectTypes: (f) => new f.ArrayField(new f.StringField({ required: true, blank: false }), { initial: [] }),
  blastRadius: (f) => new f.NumberField({ initial: 0 }),
  dotTurns:    (f) => new f.NumberField({ initial: 0 }),
  stunSaveMod: (f) => new f.NumberField({ initial: 0 }),
  // ── Over-time effects ON THE WEAPON (user-ruled 2026-09-19) ────────────────────────────────
  // A LIST, because a weapon may carry more than one (an acid-tipped blade that is also on fire is
  // two rows), each row one statement the damage pipeline already understands: `type` routes it
  // (acid eats armour, fire burns HP — save-rolls.js applyDotFromPayload), `turns` is its duration,
  // `formula` its per-application roll — BLANK means "the weapon's own damage roll at the location"
  // (the Core p.107-108 airgun/Powersquirt reading: the acid that hit is the acid that eats) — and
  // `flat` is fire's opt-out from the halving ladder (the ammo model's `dotFlat`). Additive with an
  // empty default → no migration; a weapon with no rows is a weapon as it always was. The rows ride
  // the weaponFired payload as `overTime` (seam-shim.js AMMO_EFFECT_FIELDS) beside — never instead
  // of — a loaded round's own single statement.
  overTime: (f) => new f.ArrayField(new f.SchemaField({
    type:    new f.StringField({ initial: "acid", blank: false }),
    turns:   new f.NumberField({ initial: 3, integer: true, min: 0 }),
    formula: new f.StringField({ initial: "" }),
    flat:    new f.BooleanField({ initial: false }),
  }), { initial: [] })
};

/**
 * @param {typeof foundry.abstract.TypeDataModel} SystemModel  the system's registered `weapon` model
 * @returns {typeof foundry.abstract.TypeDataModel}
 */
export function makeWeaponAugmentedData(SystemModel) {
  return class CyberpunkWeaponAugmentedData extends SystemModel {
    static defineSchema() {
      const base = super.defineSchema();
      const f = foundry.data.fields;
      const add = {};
      for (const [key, make] of Object.entries(WEAPON_AUGMENT_FIELDS)) {
        if (base[key] === undefined) add[key] = make(f);
      }
      return { ...base, ...add };
    }
  };
}
