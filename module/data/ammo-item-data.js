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
  // ⭐ DOES THIS LOAD'S OVER-TIME TICK KEEP ITS FULL MULTIPLIER, or diminish? The tick's default is to
  // HALVE the multiplier each surviving turn (combat/damage-hooks.js fire branch) — a generalization of
  // the CP2020 p.110 flamethrower ladder ("2D10 the 1st turn, 1D10 and 1D6 the following two turns"),
  // which is the only diminishing burn the book actually prints. Some rounds print a FLAT figure
  // instead: p.64's grenade note reads "Incendiary (4D6 for 3 turns)", with no decay stated.
  //
  // ⛔ THE INITIAL IS THE RUNTIME FLOOR AND MUST STAY `false`. Every ammo document that exists today —
  // in a world, in a pack, in somebody's inventory — answers `false` here and therefore keeps the
  // halving it has always had; the flamethrower and the Armor-Piercing Incendiary load are unchanged.
  // Only a document that states `true` opts out. Additive with a behaviour-preserving default → no
  // migration, exactly as the five fields above it (see this file's header).
  dotFlat:  (f) => new f.BooleanField({ initial: false }),
  boxSize:  (f) => new f.NumberField({ initial: 0 }),
  boxCost:  (f) => new f.NumberField({ initial: 0 }),
  // The sheet's quantity-lock toggle writes this; without a schema home the write is stripped
  // and the control is inert (connection audit N2). `true` matches the sheet's own fallback.
  qtyLocked: (f) => new f.BooleanField({ initial: true })
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
