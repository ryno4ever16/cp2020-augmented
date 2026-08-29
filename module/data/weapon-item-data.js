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
  stunSaveMod: (f) => new f.NumberField({ initial: 0 })
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
