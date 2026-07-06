/**
 * Special-mechanics item fields shared by `misc` gear and `cyberware`
 * (SPECIAL-MECHANICS-PROPOSAL.md — decision D1: extend the registered DataModels, the C4 pattern
 * proven on vehicles, instead of routing through module flags).
 *
 * `mechLight` (pattern P3 — light emitters): an item that can light the bearer's token.
 *   enabled  — this item IS an emitter (catalog data; the sheet shows the profile fields)
 *   on       — the emitter is currently lit (runtime state on the OWNED copy; sheet toggle)
 *   shape    — "cone" (flashlights) | "circle" (glowsticks, lamps)
 *   bright/dim — ranges in scene units (the books print real beam ranges: "3m range", "25m beam")
 *   angle    — cone spread in degrees (ignored for circle; applied as 360)
 *   color    — optional tint ("#66ff66" chem-glow etc.); empty = plain white light
 *
 * ⚠ mechLight is a real nested SchemaField, NOT the schema-helpers bare objectField, deliberately:
 * a bare ObjectField treats a dotted partial update (`{"system.mechLight.on": true}`) as a REPLACE,
 * after which defaults refill the dropped keys — rig-proven on v14.364: toggling `on` silently reset
 * `enabled` to false. A SchemaField merges partial updates per sub-field, which is exactly what the
 * sheet toggle and API callers need. (The same hazard exists on the base system's objectField groups
 * — tracked separately; see the special-mechanics task notes.)
 *
 * Built at INIT via this factory so the models EXTEND the system's own registered `misc`/`cyberware`
 * models (any field or migrateData the base later gains chains via `super`). Additive with defaults →
 * existing items float, no world migration; SchemaField fills missing sub-keys itself.
 */

export const MECH_LIGHT_DEFAULTS = {
  enabled: false, on: false, shape: "cone", bright: 10, dim: 20, angle: 45, color: ""
};

/**
 * `mechVision` (pattern P4 — vision devices): IR/low-light/thermograph/UV optics that change how
 * the wearer's token SEES (where mechLight changes how it is seen). `mode` is a soft enum
 * (VISION_DEVICE_MODES); the Foundry mapping lives in module/mech/vision.js and is deliberately a
 * small upgradeable table — the fidelity question (plain see-in-dark vs live-target detection for
 * thermograph) is an OPEN QUESTION in SPECIAL-MECHANICS-PROPOSAL.md, and the default is the simple
 * darkvision-class approximation. `range` is the device's effective sight range in scene units
 * (the books print absolutes like "see in total darkness", so the default is a playable 20).
 */
export const MECH_VISION_DEFAULTS = { enabled: false, on: false, mode: "lowlight", range: 20 };
export const VISION_DEVICE_MODES = ["lowlight", "infrared", "thermograph", "uv"];

function mechLightField() {
  const f = foundry.data.fields;
  return new f.SchemaField({
    enabled: new f.BooleanField({ initial: MECH_LIGHT_DEFAULTS.enabled }),
    on:      new f.BooleanField({ initial: MECH_LIGHT_DEFAULTS.on }),
    shape:   new f.StringField({ initial: MECH_LIGHT_DEFAULTS.shape }),
    bright:  new f.NumberField({ initial: MECH_LIGHT_DEFAULTS.bright }),
    dim:     new f.NumberField({ initial: MECH_LIGHT_DEFAULTS.dim }),
    angle:   new f.NumberField({ initial: MECH_LIGHT_DEFAULTS.angle }),
    color:   new f.StringField({ initial: MECH_LIGHT_DEFAULTS.color })
  });
}

function mechVisionField() {
  const f = foundry.data.fields;
  return new f.SchemaField({
    enabled: new f.BooleanField({ initial: MECH_VISION_DEFAULTS.enabled }),
    on:      new f.BooleanField({ initial: MECH_VISION_DEFAULTS.on }),
    mode:    new f.StringField({ initial: MECH_VISION_DEFAULTS.mode }),
    range:   new f.NumberField({ initial: MECH_VISION_DEFAULTS.range })
  });
}

/**
 * @param {typeof foundry.abstract.TypeDataModel} SystemModel  the system's registered model to extend
 * @returns {typeof foundry.abstract.TypeDataModel}
 */
export function makeMechAugmentedData(SystemModel) {
  return class CyberpunkMechAugmentedData extends SystemModel {
    static defineSchema() {
      return {
        ...super.defineSchema(),
        mechLight: mechLightField(),
        mechVision: mechVisionField()
      };
    }
  };
}
