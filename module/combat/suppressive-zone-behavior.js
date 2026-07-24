/**
 * Suppressive-fire Region Behavior (module side).
 *
 * Third zone type on the native-region rail (after the Radiation Zone and Gas Cloud, whose files this
 * mirrors — three siblings now; if the shared shape starts itching, extract it). A suppressive-fire zone
 * is the beaten lane a burst of autofire lays across the map: anyone crossing it must evade or take
 * random hits (core rules p.101 — save = rounds fired ÷ zone width in metres). The lane is SPAWNED by
 * the placement-forward flow in damage-hooks.js (the shooter aims and sizes a client-side preview, then
 * the confirmed geometry is relayed to the active GM, who creates the Region carrying this behavior) —
 * and a GM can also hand-author a PERMANENT kill lane from scratch: draw a Region, add the "Suppressive
 * Fire" behavior, leave the shooter field blank (a blank shooter is what marks a lane permanent; a
 * spawned lane records its shooter and expires at their next turn).
 *
 * Unlike its round-tick siblings, this is the module's first EVENT-DRIVEN behavior: it subscribes to the
 * native token-enter region event, which fires both when a token walks into the lane AND — usefully —
 * for every token already standing inside at the moment the behavior is created or re-enabled. So
 * "prompt everyone in the lane at confirm" and "prompt whoever crosses later" are one code path. The
 * event handler runs on EVERY connected client (a platform fact), so it gates itself to the single
 * active GM and then only EMITS a module hook — the evasion mechanics (attacker exclusion, the save
 * prompt, hit routing) live in damage-hooks.js, which listens for that hook. The hook seam keeps this
 * file free of any damage-pipeline import (and the pipeline free of a cycle back into this file).
 *
 * ⚠ Registration is TWO-PART (rig-verified on the radiation unit): the subtype must ALSO be declared in
 * module.json under documentTypes.RegionBehavior.suppressiveFire — Foundry freezes the valid-type list
 * from the manifests at init, so a runtime CONFIG assignment alone is rejected. And a module.json change
 * means the Foundry SERVER must restart before the type is valid — a page reload is not enough.
 *
 * Fields (behavior.system): saveDC (the evasion difficulty, already derived from rounds ÷ width by the
 * placement preview), dmgFormula (the weapon's damage roll for a failed evasion), attackerId (the
 * shooting actor — excluded from saves; BLANK = a hand-authored permanent lane), weaponName (free text
 * for the cards, blank ok — its generic fallback is localized at DISPLAY time so a stored value never
 * freezes the UI language), createdRound (the combat round the lane was laid; a shooter-owned lane
 * expires when the round advances past it). The `locked` state is NOT here — it lives as a region flag
 * (GM-writable, readable by every client) so the GM Unlock control never has to touch this schema.
 */

const SCOPE = "cp2020-augmented";

/** The behavior document type string (module-namespaced, matches module.json). */
export const SUPPRESSIVE_ZONE_BEHAVIOR = `${SCOPE}.suppressiveFire`;

/** The module hook the enter handler emits (active-GM client only). damage-hooks.js listens. */
export const SUPPRESSIVE_ZONE_ENTERED_HOOK = `${SCOPE}.suppressiveZoneEntered`;

/** The registered DataModel class, or null before registration / on a pre-region core. */
let _suppressiveZoneBehaviorClass = null;
export function suppressiveZoneBehaviorClass() { return _suppressiveZoneBehaviorClass; }

/** The RegionBehaviorType base, or null on a core without Regions (pre-v12). */
function behaviorBase() {
  return foundry?.data?.regionBehaviors?.RegionBehaviorType ?? null;
}

/**
 * Register the Suppressive Fire behavior TYPE at init (before scenes load). No-op + returns false on a
 * pre-region core or if the CONFIG map is absent, so the module degrades cleanly. Returns true when the
 * type was installed.
 */
export function registerSuppressiveZoneBehavior() {
  const Base = behaviorBase();
  if (!Base || !CONFIG?.RegionBehavior?.dataModels) return false;

  const fields = foundry.data.fields;
  const EVENTS = CONST?.REGION_EVENTS ?? {};

  class SuppressiveZoneBehavior extends Base {
    static defineSchema() {
      return {
        saveDC: new fields.NumberField({
          required: true, integer: true, min: 1, initial: 1,
          label: "CYBERPUNK.SuppZoneBehaviorSaveDC",
          hint: "CYBERPUNK.SuppZoneBehaviorSaveDCHint",
        }),
        dmgFormula: new fields.StringField({
          required: true, blank: false, initial: "1d6",
          label: "CYBERPUNK.SuppZoneBehaviorDamage",
          hint: "CYBERPUNK.SuppZoneBehaviorDamageHint",
        }),
        attackerId: new fields.StringField({
          required: false, blank: true, initial: "",
          label: "CYBERPUNK.SuppZoneBehaviorAttacker",
          hint: "CYBERPUNK.SuppZoneBehaviorAttackerHint",
        }),
        weaponName: new fields.StringField({
          required: false, blank: true, initial: "",
          label: "CYBERPUNK.SuppZoneBehaviorWeapon",
          hint: "CYBERPUNK.SuppZoneBehaviorWeaponHint",
        }),
        createdRound: new fields.NumberField({
          required: true, integer: true, min: 0, initial: 0,
          label: "CYBERPUNK.SuppZoneBehaviorRound",
          hint: "CYBERPUNK.SuppZoneBehaviorRoundHint",
        }),
      };
    }

    // Native token-enter subscription: fires for a token crossing INTO the lane, and for every token
    // already inside when the behavior is created/re-enabled (rig-proven both cores) — one path for
    // "in the lane at confirm" and "walked in later". Invoked with `this` = this system data model.
    static events = EVENTS.TOKEN_ENTER ? { [EVENTS.TOKEN_ENTER]: this.#onTokenEnter } : {};

    static async #onTokenEnter(event) {
      try {
        // The event runs on EVERY connected client; only the single active GM acts (it owns the
        // prompts + hit routing, exactly like the round-tick zones).
        if (!game.user?.isGM || game.users?.activeGM?.id !== game.user?.id) return;
        Hooks.callAll(SUPPRESSIVE_ZONE_ENTERED_HOOK, {
          behavior: this.parent,
          region: event.region,
          tokenDoc: event.data?.token ?? null,
          user: event.user ?? null,
        });
      } catch (e) {
        console.warn(`${SCOPE} | suppressive-zone enter handler failed`, e);
      }
    }
  }

  _suppressiveZoneBehaviorClass = SuppressiveZoneBehavior;
  CONFIG.RegionBehavior.dataModels[SUPPRESSIVE_ZONE_BEHAVIOR] = SuppressiveZoneBehavior;
  // The "Add Behavior" list reads typeIcons; the label auto-derives TYPES.RegionBehavior.<type> from
  // lang/en.json, so only the icon is set here.
  if (CONFIG.RegionBehavior.typeIcons) {
    CONFIG.RegionBehavior.typeIcons[SUPPRESSIVE_ZONE_BEHAVIOR] = "fa-solid fa-crosshairs";
  }
  return true;
}

/**
 * Give a hand-authored suppressive-fire region a sensible default visibility. Where the hazard zones
 * (radiation, gas) default to GAMEMASTER — the GM's secret — a suppressive lane is a declared,
 * tracer-lit battlefield fact, and the user ruled players see their own AOEs: bump a layer-only default
 * to ALWAYS. Spawned lanes never reach this hook (the enter-hook analogue of the gas note: a behavior
 * embedded inline at Region creation fires no createRegionBehavior hook) — the spawn path sets ALWAYS
 * directly in its creation data. A visibility the GM already chose deliberately is left alone. Runs on
 * the single active GM to avoid duplicate writes across GM clients.
 */
export function registerSuppressiveZoneVisibilityDefault() {
  Hooks.on("createRegionBehavior", async (behavior) => {
    try {
      if (behavior?.type !== SUPPRESSIVE_ZONE_BEHAVIOR) return;
      if (!game.user?.isGM || game.users?.activeGM?.id !== game.user?.id) return;
      const region = behavior.parent;
      if (!region?.update) return;
      const V = CONST?.REGION_VISIBILITY ?? {};
      // Only the layer-only defaults get nudged; GAMEMASTER/ALWAYS/OBSERVER were deliberate choices.
      const alreadyVisible = new Set([V.GAMEMASTER, V.ALWAYS, V.OBSERVER].filter((v) => v != null));
      if (alreadyVisible.has(region.visibility)) return;
      await region.update({ visibility: V.ALWAYS ?? 2 });
    } catch (e) {
      console.warn(`${SCOPE} | suppressive-zone visibility default failed`, e);
    }
  });
}
