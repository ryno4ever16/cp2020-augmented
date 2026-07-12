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
  broken: (f) => new f.BooleanField({ initial: false })
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
