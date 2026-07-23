/**
 * Radiation-zone Region Behavior (module side).
 *
 * Replaces the old "place a zone through a dialog + track it by a private flag" model with a native
 * Foundry Scene Region carrying a custom "Radiation Zone" behavior. The GM draws / reshapes / moves /
 * deletes / hides the zone with Foundry's own region tools; this module only supplies the behavior
 * TYPE (its two data fields) and the per-round dosing that reads them (radiation-zones.js).
 *
 * Regions and custom Region Behaviors both exist from Foundry v12 onward, so this runs on every core the
 * module supports (v13 + v14) and needs none of the area-shapes MeasuredTemplate/Region shim — that shim
 * stays only for the transient combat areas (gas cloud, suppressive fire).
 *
 * ⚠ Registration is TWO-PART (rig-verified): the subtype must ALSO be declared in module.json under
 * documentTypes.RegionBehavior.radiationZone — Foundry freezes the valid-type list from the manifests at
 * init, so a runtime CONFIG assignment alone is rejected. This file supplies the DataModel half; the
 * manifest supplies the type declaration; both are required.
 *
 * Fields (behavior.system): radsFormula (per-round rads roll, per token inside) + sourceLabel (free text,
 * blank ok — its generic fallback is localized at DISPLAY time so a stored value never freezes the UI
 * language). The auto-generated behavior sheet renders both from their i18n label/hint keys.
 */

const SCOPE = "cp2020-augmented";

/** The behavior document type string (module-namespaced, matches module.json). */
export const RAD_ZONE_BEHAVIOR = `${SCOPE}.radiationZone`;

/** The registered DataModel class, or null before registration / on a pre-region core. */
let _radiationZoneBehaviorClass = null;
export function radiationZoneBehaviorClass() { return _radiationZoneBehaviorClass; }

/** The RegionBehaviorType base, or null on a core without Regions (pre-v12). */
function behaviorBase() {
  return foundry?.data?.regionBehaviors?.RegionBehaviorType ?? null;
}

/**
 * Register the Radiation Zone behavior TYPE at init (before scenes load). No-op + returns false on a
 * pre-region core or if the CONFIG map is absent, so the module degrades cleanly. Returns true when the
 * type was installed.
 */
export function registerRadiationZoneBehavior() {
  const Base = behaviorBase();
  if (!Base || !CONFIG?.RegionBehavior?.dataModels) return false;

  const fields = foundry.data.fields;

  class RadiationZoneBehavior extends Base {
    static defineSchema() {
      return {
        radsFormula: new fields.StringField({
          required: true, blank: false, initial: "1d10",
          label: "CYBERPUNK.RadZoneBehaviorFormula",
          hint: "CYBERPUNK.RadZoneBehaviorFormulaHint",
        }),
        sourceLabel: new fields.StringField({
          required: false, blank: true, initial: "",
          label: "CYBERPUNK.RadZoneBehaviorSource",
          hint: "CYBERPUNK.RadZoneBehaviorSourceHint",
        }),
      };
    }
  }

  _radiationZoneBehaviorClass = RadiationZoneBehavior;
  CONFIG.RegionBehavior.dataModels[RAD_ZONE_BEHAVIOR] = RadiationZoneBehavior;
  // The "Add Behavior" list reads typeIcons; the label auto-derives TYPES.RegionBehavior.<type> from
  // lang/en.json, so only the icon is set here.
  if (CONFIG.RegionBehavior.typeIcons) {
    CONFIG.RegionBehavior.typeIcons[RAD_ZONE_BEHAVIOR] = "fa-solid fa-radiation";
  }
  return true;
}

/**
 * Give a freshly-created radiation-zone region a sensible default visibility. The native default
 * ("layer" on v13 / "layer-unlocked" on v14) shows the region ONLY while the region tool is active — so
 * the GM can't see their own hazard during play. When our behavior is created on a region still at a
 * layer-only default, bump it to GAMEMASTER: the GM sees the zone during normal play, players do not, and
 * the GM stays free to set it to ALWAYS to reveal it to players (or back to a layer-only mode). Runs on
 * the single active GM to avoid duplicate writes across GM clients.
 */
export function registerRadiationZoneVisibilityDefault() {
  Hooks.on("createRegionBehavior", async (behavior) => {
    try {
      if (behavior?.type !== RAD_ZONE_BEHAVIOR) return;
      if (!game.user?.isGM || game.users?.activeGM?.id !== game.user?.id) return;
      const region = behavior.parent;
      if (!region?.update) return;
      const V = CONST?.REGION_VISIBILITY ?? {};
      // Anything the GM has already set to a genuinely-visible mode is left alone; only the layer-only
      // defaults get nudged.
      const alreadyVisible = new Set([V.GAMEMASTER, V.ALWAYS, V.OBSERVER].filter((v) => v != null));
      if (alreadyVisible.has(region.visibility)) return;
      await region.update({ visibility: V.GAMEMASTER ?? 1 });
    } catch (e) {
      console.warn(`${SCOPE} | rad-zone visibility default failed`, e);
    }
  });
}
