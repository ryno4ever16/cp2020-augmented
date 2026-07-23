/**
 * Gas-cloud Region Behavior (module side).
 *
 * The second zone type on the native-region rail (the first is the Radiation Zone —
 * module/radiation/radiation-zone-behavior.js, whose structure this file deliberately mirrors; if a THIRD
 * zone type ever lands, extract the shared shape instead of mirroring again). A gas cloud is usually
 * SPAWNED programmatically by the weaponFired pipeline (damage-hooks.js) when a gas grenade goes off — but
 * once it exists as a Region carrying this behavior, the GM manages it with Foundry's own region tools:
 * reshape it, move it, hide it, delete it, or open the behavior sheet and edit the fields below (extend a
 * cloud's duration, soften its save penalty). A GM can also hand-author a lingering gas hazard from
 * scratch: draw a Region, add the "Gas Cloud" behavior.
 *
 * On v13 the combat shim still spawns MeasuredTemplates (Regions replace templates only on v14), tracked by
 * the legacy `isGasCloud` flag — this behavior is simply never attached there; the per-round tick in
 * damage-hooks.js reads BOTH sources (behavior-carrying regions first, then legacy flagged areas).
 *
 * ⚠ Registration is TWO-PART (rig-verified on the radiation unit): the subtype must ALSO be declared in
 * module.json under documentTypes.RegionBehavior.gasCloud — Foundry freezes the valid-type list from the
 * manifests at init, so a runtime CONFIG assignment alone is rejected. This file supplies the DataModel
 * half; the manifest supplies the type declaration; both are required. (And a module.json change means the
 * Foundry SERVER must restart before the type is valid — a page reload is not enough.)
 *
 * Fields (behavior.system): turnsLeft (rounds until the cloud disperses — the tick decrements it here, so
 * the GM sees and can edit the live countdown), stunSaveMod (the save penalty for tokens inside, usually
 * negative), weaponName (free text for the cards, blank ok — its generic fallback is localized at DISPLAY
 * time so a stored value never freezes the UI language).
 */

const SCOPE = "cp2020-augmented";

/** The behavior document type string (module-namespaced, matches module.json). */
export const GAS_CLOUD_BEHAVIOR = `${SCOPE}.gasCloud`;

/** The registered DataModel class, or null before registration / on a pre-region core. */
let _gasCloudBehaviorClass = null;
export function gasCloudBehaviorClass() { return _gasCloudBehaviorClass; }

/** The RegionBehaviorType base, or null on a core without Regions (pre-v12). */
function behaviorBase() {
  return foundry?.data?.regionBehaviors?.RegionBehaviorType ?? null;
}

/**
 * Register the Gas Cloud behavior TYPE at init (before scenes load). No-op + returns false on a pre-region
 * core or if the CONFIG map is absent, so the module degrades cleanly. Returns true when the type was
 * installed.
 */
export function registerGasCloudBehavior() {
  const Base = behaviorBase();
  if (!Base || !CONFIG?.RegionBehavior?.dataModels) return false;

  const fields = foundry.data.fields;

  class GasCloudBehavior extends Base {
    static defineSchema() {
      return {
        turnsLeft: new fields.NumberField({
          required: true, integer: true, min: 0, initial: 3,
          label: "CYBERPUNK.GasCloudBehaviorTurns",
          hint: "CYBERPUNK.GasCloudBehaviorTurnsHint",
        }),
        stunSaveMod: new fields.NumberField({
          required: true, integer: true, initial: 0,
          label: "CYBERPUNK.GasCloudBehaviorStunMod",
          hint: "CYBERPUNK.GasCloudBehaviorStunModHint",
        }),
        weaponName: new fields.StringField({
          required: false, blank: true, initial: "",
          label: "CYBERPUNK.GasCloudBehaviorWeapon",
          hint: "CYBERPUNK.GasCloudBehaviorWeaponHint",
        }),
      };
    }
  }

  _gasCloudBehaviorClass = GasCloudBehavior;
  CONFIG.RegionBehavior.dataModels[GAS_CLOUD_BEHAVIOR] = GasCloudBehavior;
  // The "Add Behavior" list reads typeIcons; the label auto-derives TYPES.RegionBehavior.<type> from
  // lang/en.json, so only the icon is set here.
  if (CONFIG.RegionBehavior.typeIcons) {
    CONFIG.RegionBehavior.typeIcons[GAS_CLOUD_BEHAVIOR] = "fa-solid fa-smog";
  }
  return true;
}

/**
 * Give a hand-authored gas-cloud region a sensible default visibility (the radiation zone's exact idiom).
 * The native default ("layer" on v13 / "layer-unlocked" on v14) shows the region ONLY while the region tool
 * is active — so the GM can't see their own hazard during play. When this behavior is added to a region
 * still at a layer-only default, bump it to GAMEMASTER: the GM sees the cloud during normal play, players
 * do not, and the GM stays free to set it to ALWAYS to reveal it (or back to a layer-only mode). Spawned
 * clouds never reach this hook (createRegionBehavior does not fire for a behavior embedded inline at Region
 * creation) — the spawn path already creates its regions GM-visible. Runs on the single active GM to avoid
 * duplicate writes across GM clients.
 */
export function registerGasCloudVisibilityDefault() {
  Hooks.on("createRegionBehavior", async (behavior) => {
    try {
      if (behavior?.type !== GAS_CLOUD_BEHAVIOR) return;
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
      console.warn(`${SCOPE} | gas-cloud visibility default failed`, e);
    }
  });
}
