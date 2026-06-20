import { localize } from "./utils.js";

const SCOPE = "cp2020-augmented";

/**
 * Settings organizer — enhances Foundry's NATIVE System Settings page (no parallel app, no config:false
 * flips): inserts labelled section headers, reorders each section's settings contiguously, and
 * master-gates sub-options (grey + disable while their master toggle is off, live-updating). This
 * generalizes the module's original Maximum-Metal + IP renderSettingsConfig hooks into one data-driven
 * mechanism, so a human edits a list instead of N bespoke hooks. Everything is wrapped so a DOM hiccup
 * can never break the settings page (it just renders unorganized).
 *
 * Headers use CYBERPUNK.Section* i18n keys (via localize). Master-gating reuses the .cp-mm-disabled
 * class. Only the module's own registered settings (a [name="cp2020-augmented.<key>"] control) are
 * touched; the preset-menu button + config:false stores are left untouched. Mirrors the fork's
 * settings-sections.js, scoped to the module's actual setting universe.
 */

// Display order of the sections + the settings in each (registered keys only; absent ones are skipped).
const SECTIONS = [
  { key: "SectionDamage", keys: [
    "damageArmorMode", "damageAblation", "damageAutoApply", "headHitDoubling", "limbLossEnabled",
    "limbModel", "hitLocationCoreDisplay",
  ] },
  { key: "SectionCombatAutomation", keys: [
    "combatAutomationEnabled", "autoDeathSavePerTurn", "autoSaveRePrompt", "activeDodgeParryEnabled",
    "aimTrackingEnabled", "waitForTurnEnabled", "specialMeleeEffectsEnabled", "multiActionPenaltyEnabled",
    "multiActionAutoTrack", "suppressiveFireSaves", "restrictMovementOncePerTurn",
  ] },
  { key: "SectionWeaponEffects", keys: [
    "shotgunSpreadEnabled", "explosivesEnabled", "explosivesDetailed", "areaEffectOcclusion",
    "gasGrenadeCloudEnabled", "gasCloudAutoMove", "taserCumPenaltyEnabled", "acidArmorDotEnabled",
    "acidDotStackMode", "fireDotEnabled", "fireDotStackMode",
  ] },
  { key: "SectionOptionalRules", keys: ["fnff2Enabled"] },
  { key: "SectionImprovementPoints", keys: [
    "ipRawTracking", "ipAwardModel", "ipAutoBaselineAmount", "ipThrottle", "ipSkillLockMode",
    "ipHideUI", "ipShowPending",
  ] },
  { key: "SectionShopping", keys: ["shoppingEnabled", "playersCanShop", "shopAllowHomebrew", "ammoBlackhandsPricing", "shopShowSource"] },
  { key: "SectionVehicles", keys: ["vehicleControlEnabled", "vehicleDamageEnabled", "mmEnabled", "vehicleRuleSystem", "vehicleArmorDamageEnabled", "vehicleMoraleEnabled", "vehicleArcEnforcement"] },
  { key: "SectionAccess", keys: ["playersCanBuyAmmo"] },
  { key: "SectionDisplay", keys: ["carolingianSkin"] },
];

// master toggle → the sub-settings that only matter when it's on (greyed + disabled while it's off).
const MASTERS = {
  mmEnabled:                 ["vehicleRuleSystem", "vehicleArmorDamageEnabled", "vehicleMoraleEnabled", "vehicleArcEnforcement"],
  ipRawTracking:             ["ipAwardModel", "ipAutoBaselineAmount", "ipThrottle", "ipSkillLockMode"],
  shoppingEnabled:           ["playersCanShop", "shopAllowHomebrew", "shopShowSource"],
  explosivesEnabled:         ["explosivesDetailed", "areaEffectOcclusion"],
  gasGrenadeCloudEnabled:    ["gasCloudAutoMove"],
  acidArmorDotEnabled:       ["acidDotStackMode"],
  fireDotEnabled:            ["fireDotStackMode"],
  multiActionPenaltyEnabled: ["multiActionAutoTrack"],
};

/** Normalize the renderSettingsConfig hook's 2nd arg to a root HTMLElement (V2 element or V1 jQuery). */
function _rootEl(html) {
  if (!html) return null;
  if (html instanceof HTMLElement) return html;
  if (html.jquery) return html[0] ?? null;
  return html[0] ?? html;
}

/** Organize the rendered System Settings page (called from the renderSettingsConfig hook). */
export function enhanceSettingsConfig(html) {
  try {
    const root = _rootEl(html);
    if (!root?.querySelector) return;
    const groupOf = (k) => {
      const el = root.querySelector(`[name="${SCOPE}.${k}"], [data-setting-id="${SCOPE}.${k}"]`);
      return el?.closest(".form-group") ?? el?.closest(".setting") ?? null;
    };

    // 1. Build the ordered [header, ...groups] sequence for each present section.
    const sequence = [];
    for (const section of SECTIONS) {
      const groups = section.keys.map(groupOf).filter(Boolean);
      if (!groups.length) continue;
      let header = root.querySelector(`.cp-settings-header[data-cp-section="${section.key}"]`);
      if (!header) {
        header = document.createElement("h3");
        header.className = "cp-settings-header";
        header.dataset.cpSection = section.key;
        header.textContent = localize(section.key);
      }
      sequence.push(header, ...groups);
    }
    if (!sequence.length) return;

    // 2. Reorder: place the sequence right after whatever currently precedes our first setting group
    //    (keeps the system header + the preset-menu button at the top untouched).
    const firstGroup = SECTIONS.flatMap((s) => s.keys).map(groupOf).find(Boolean);
    const container = firstGroup?.parentNode;
    if (!container) return;
    let cursor = firstGroup.previousSibling;
    for (const node of sequence) {
      const ref = cursor ? cursor.nextSibling : container.firstChild;
      if (node !== ref) container.insertBefore(node, ref);
      cursor = node;
    }

    // 3. Master-gating: grey + disable each master's sub-settings while it's off; live-update on change.
    for (const [master, subs] of Object.entries(MASTERS)) {
      const masterInput = groupOf(master)?.querySelector(`[name="${SCOPE}.${master}"]`);
      if (!masterInput || masterInput.dataset.cpGateBound === "1") continue;
      const subGroups = subs.map(groupOf).filter(Boolean);
      if (!subGroups.length) continue;
      const setEnabled = (on) => {
        for (const g of subGroups) {
          g.classList.toggle("cp-mm-disabled", !on);
          g.querySelectorAll("input,select,button,textarea").forEach((el) => { el.disabled = !on; });
        }
      };
      setEnabled(!!masterInput.checked);
      masterInput.addEventListener("change", () => setEnabled(!!masterInput.checked));
      masterInput.dataset.cpGateBound = "1";
    }
  } catch (err) {
    console.warn("cp2020-augmented | settings-config organizer failed (settings still usable)", err);
  }
}
