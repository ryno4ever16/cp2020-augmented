/**
 * Ammo two-axis extension (the "ammo-relocation slice"): the module models ammunition as caliber
 * (what weapons accept) + modifier (the load), plus a little shop/effect metadata. Those net-new
 * fields live in the module, NOT the base system's `ammo` DataModel — so on a VANILLA host (Tilt's
 * 1.1.1) the base model silently strips `caliber` / `modifier` / `dotType` / `boxSize` / `boxCost`
 * on write (rig-confirmed: penDamageMult + effectTypes survive, these five do not). That broke the
 * caliber-scoped ammo-modifier picker (an arrow load must not be selectable on a bullet) because the
 * scope keys off `caliber`, which never persisted.
 *
 * This factory EXTENDS the registered `ammo` model (the C4 / mech pattern) and adds ONLY the fields
 * the base model is missing — so it fills the gap on vanilla and is a NO-OP on the fork (whose ammo
 * schema already defines them), never re-declaring an existing field. Additive with defaults → no
 * migration; existing ammo items float (a blank caliber is a load-into-anything wildcard already).
 */

const AMMO_AUGMENT_FIELDS = {
  caliber:  (f) => new f.StringField({ initial: "" }),
  modifier: (f) => new f.StringField({ initial: "standard" }),
  dotType:  (f) => new f.StringField({ initial: "acid" }),
  boxSize:  (f) => new f.NumberField({ initial: 0 }),
  boxCost:  (f) => new f.NumberField({ initial: 0 })
};

/**
 * @param {typeof foundry.abstract.TypeDataModel} SystemModel  the system's registered `ammo` model
 * @returns {typeof foundry.abstract.TypeDataModel}
 */
export function makeAmmoAugmentedData(SystemModel) {
  return class CyberpunkAmmoAugmentedData extends SystemModel {
    static defineSchema() {
      const base = super.defineSchema();
      const f = foundry.data.fields;
      const add = {};
      for (const [key, make] of Object.entries(AMMO_AUGMENT_FIELDS)) {
        if (base[key] === undefined) add[key] = make(f);
      }
      return { ...base, ...add };
    }
  };
}
