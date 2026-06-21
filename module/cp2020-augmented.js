/**
 * Cyberpunk 2020: Augmented Edition — companion module entry point.
 *
 * Loads on top of the `cyberpunk2020` system and adds the Augmented features
 * (vehicles & ACPA / Maximum Metal, combat automation, shopping, IP tracking)
 * as opt-in overlays, WITHOUT modifying the base system. Mirrors the system's
 * own init/ready wiring shape: registration functions imported here and called
 * from Hooks.once('init'/'ready').
 */
import { registerAugmentedSettings, combatAutomationEnabled, ipHideUI, applyCarolingianSkinClass } from "./settings.js";
import { registerAugmentedHandlebarsHelpers } from "./handlebars-helpers.js";
import { registerDamageHooks } from "./combat/damage-hooks.js";
import { registerMovementGate } from "./combat/movement-gate.js";
import { registerSaveRollHandlers } from "./combat/save-rolls.js";
import { registerPopoutCompat } from "./popout-compat.js";

// Vehicle / ACPA (Maximum Metal) sub-types — module-owned Actor/Item types, data in system.*.
import { CyberpunkVehicleActorData } from "./data/vehicle-actor-data.js";
import { CyberpunkVehicleWeaponData, CyberpunkAcpaSystemData } from "./data/vehicle-item-data.js";
import { CyberpunkVehicleSheet } from "./actor/vehicle-sheet.js";
import { CyberpunkAugmentedItemSheet } from "./item/augmented-item-sheet.js";
import { registerVehicleCanvasHooks, deployVehicleToScene, boardVehicle, disembark } from "./vehicle/vehicle-canvas.js";
import { openControlRollDialog } from "./vehicle/vehicle-control.js";
import { openVehicleDamageDialog } from "./vehicle/vehicle-damage.js";
import { weaponToPenetration, vehicleToHitModifier, openVehicleFireDialog, registerVehicleFireHandlers } from "./vehicle/vehicle-weapons.js";
import { registerVehicleTargetingHandlers } from "./vehicle/vehicle-targeting.js";
import { registerMissileFlightHooks } from "./vehicle/vehicle-missile-flight.js";
import { openAcpaMeleeDialog, registerAcpaCombatHooks, repairAcpa } from "./vehicle/vehicle-acpa-combat.js";

// IP (Improvement Points) tracker — GM engine + tracker window; IP stored in module flags.
import { registerIpHooks } from "./ip/ip.js";
import { openIpTracker } from "./ip/tracker.js";
import { registerIpSheet } from "./ip/ip-sheet.js";

// Settings presets — the GM "Choose Preset" menu button (one-click playstyle tiers).
import { PresetPicker } from "./dialog/preset-picker.js";
import { registerPinnedSubwindows } from "./pin-window.js";

// Shop / economy ([[shopping-design]]) — the sidebar cart opens a standalone catalog/shop window;
// the browse/buy engine + custom-shop curation live in module/shop/.
import { registerShopHooks, openShopWindow } from "./shop/catalog.js";
// In-sheet cyberware "Install (Surgery)" button (item sheet; vanilla-only, defers to the fork's own).
import { registerCyberwareSheet } from "./cyberware/cyberware-sheet.js";
// In-sheet Recurring Services panel (gear-tab body; NOT a nav tab).
import { registerServicesSheet } from "./shop/services-sheet.js";
// In-sheet martial-arts panel (combat tab; vanilla-only, defers to the fork's own .martial-panel).
import { registerMartialSheet } from "./martial/martial-sheet.js";
// In-skill martial-art editor on the skill item sheet (vanilla-only; writes flags.cp2020-augmented.*).
import { registerMartialSkillEditor } from "./martial/martial-skill-editor.js";

// Module flag / settings scope (per-file convention used across the module).
const SCOPE = "cp2020-augmented";
const SYSTEM_ID = "cyberpunk2020";

// Module-namespaced document sub-type ids (Foundry prefixes the manifest's bare keys with the id).
const VEHICLE_ACTOR  = `${SCOPE}.vehicle`;
const VEHICLE_WEAPON = `${SCOPE}.vehicleWeapon`;
const ACPA_SYSTEM    = `${SCOPE}.acpaSystem`;

/** Partial templates the sheets include via {{> path}} (must be preloaded for the includes to resolve). */
const AUGMENTED_TEMPLATES = [
  "modules/cp2020-augmented/templates/actor/vehicle-sheet.hbs",
  "modules/cp2020-augmented/templates/actor/acpa-sheet.hbs",
  "modules/cp2020-augmented/templates/item/parts/vehicleWeapon/summary.hbs",
  "modules/cp2020-augmented/templates/item/parts/vehicleWeapon/settings.hbs",
  "modules/cp2020-augmented/templates/item/parts/acpaSystem/summary.hbs",
  "modules/cp2020-augmented/templates/item/parts/acpaSystem/settings.hbs",
  // In-sheet UI fragments injected into the actor/item sheet (warm the cache; not partial includes).
  "modules/cp2020-augmented/templates/ip/skill-cluster.hbs",
  "modules/cp2020-augmented/templates/ip/skills-header.hbs",
  "modules/cp2020-augmented/templates/dialog/ip-neglect.hbs",
  "modules/cp2020-augmented/templates/dialog/preset-picker.hbs",
  "modules/cp2020-augmented/templates/dialog/preset-confirm.hbs",
  "modules/cp2020-augmented/templates/cyberware/install-button.hbs",
  "modules/cp2020-augmented/templates/shop/services-panel.hbs",
  "modules/cp2020-augmented/templates/martial/martial-panel.hbs",
  "modules/cp2020-augmented/templates/dialog/martial-style.hbs",
  "modules/cp2020-augmented/templates/chat/martial-attack.hbs",
  "modules/cp2020-augmented/templates/chat/martial-effect.hbs",
  "modules/cp2020-augmented/templates/chat/fumble-card.hbs",
  "modules/cp2020-augmented/templates/item/martial-skill-editor.hbs",
];

Hooks.once("init", function () {
  console.log(`${SCOPE} | Initializing Cyberpunk 2020: Augmented Edition`);

  registerAugmentedSettings();
  // GM-only "Settings Presets" menu button — applies one of the 4 playstyle tiers in one click.
  // Registered here (not settings.js) so settings.js stays free of foundry.applications imports, mirroring
  // the fork. See module/presets.js + dialog/preset-picker.js.
  game.settings.registerMenu(SCOPE, "presetMenu", {
    name: "SETTINGS.PresetMenuName",
    label: "SETTINGS.PresetMenuLabel",
    hint: "SETTINGS.PresetMenuHint",
    icon: "fa-solid fa-sliders",
    type: PresetPicker,
    restricted: true,
  });
  // Vendor the {{CPLocal}}/{{CPLocalParam}} localization helpers the module's templates use, so
  // they resolve without depending on the base system registering them (vanilla self-sufficiency).
  registerAugmentedHandlebarsHelpers();

  // Keep spawned child windows (confirm dialogs + the Attack Modifiers window) floating above the
  // ordinary window they were opened from, so clicking the parent never buries them. Idempotent: on a
  // base-system+module install the system already installed this wrap, so this call no-ops.
  registerPinnedSubwindows();

  // Register the module's vehicle/ACPA DataModels. Data lives in system.* of the sub-type
  // documents (no flags) — see module.json `documentTypes` for the manifest declaration.
  Object.assign(CONFIG.Actor.dataModels, { [VEHICLE_ACTOR]: CyberpunkVehicleActorData });
  Object.assign(CONFIG.Item.dataModels, {
    [VEHICLE_WEAPON]: CyberpunkVehicleWeaponData,
    [ACPA_SYSTEM]:    CyberpunkAcpaSystemData,
  });

  // Register the vehicle/ACPA actor sheet for the module sub-type. v15-readiness: use the
  // namespaced collection, falling back to the bare global on cores that lack it (v13).
  const _Actors = foundry?.documents?.collections?.Actors ?? Actors;
  _Actors.registerSheet(SCOPE, CyberpunkVehicleSheet, { types: [VEHICLE_ACTOR], makeDefault: true });

  // Item sheet for the module's vehicle/ACPA sub-type items. A type-specific makeDefault wins over
  // the base system's typeless makeDefault item sheet (which can't render a namespaced sub-type).
  const _Items = foundry?.documents?.collections?.Items ?? Items;
  _Items.registerSheet(SCOPE, CyberpunkAugmentedItemSheet, { types: [VEHICLE_WEAPON, ACPA_SYSTEM], makeDefault: true });

  // Preload the wrapper sub-templates the sheet includes as Handlebars partials.
  const loadTemplates = foundry?.applications?.handlebars?.loadTemplates ?? globalThis.loadTemplates;
  loadTemplates?.(AUGMENTED_TEMPLATES);

  // Vehicle canvas: tile→token+crew movement coupling. Type-discriminated on the module sub-type,
  // so it coexists with the system's own vehicle-canvas hook (each fires only for its own type).
  registerVehicleCanvasHooks();

  // Public API surface for macros and other modules. Mirrors the system's game.cyberpunk.vehicles
  // shape under the module's own namespace so it never clobbers the system API.
  game.cpAugmented = {
    vehicles: {
      deploy: deployVehicleToScene, board: boardVehicle, disembark,
      controlRoll: openControlRollDialog, applyDamage: openVehicleDamageDialog,
      weaponToPen: weaponToPenetration, toHitMod: vehicleToHitModifier, fire: openVehicleFireDialog,
      acpaMelee: openAcpaMeleeDialog, acpaRepair: repairAcpa,
    },
    // IP tracker API: open the GM Improvement-Points tracker.
    ip: { openTracker: openIpTracker },
    // Shop API: open the shop window (the sidebar cart is the primary entry point).
    shop: { open: openShopWindow },
  };
  const mod = game.modules.get(SCOPE);
  if (mod) mod.api = game.cpAugmented;
});

/**
 * One-time, self-gating settings migrations mirroring the fork's setting merges (the module has no
 * migrate.js). Reads each orphaned legacy key from world storage, writes the merged value once, then
 * deletes the legacy doc so it never re-runs. Safe to fail — settings just keep their defaults.
 */
async function migrateAugmentedSettings() {
  const rawSetting = (key) => {
    try {
      const doc = game.settings?.storage?.get?.("world")?.find?.((s) => s.key === `${SCOPE}.${key}`);
      if (!doc || doc.value === undefined || doc.value === null) return undefined;
      let v = doc.value;
      if (typeof v === "string") { try { v = JSON.parse(v); } catch (e) { /* bare string */ } }
      return v;
    } catch (e) { return undefined; }
  };
  const dropLegacy = async (key) => {
    const doc = game.settings?.storage?.get?.("world")?.find?.((s) => s.key === `${SCOPE}.${key}`);
    if (doc) await doc.delete();
  };

  // limbCripplingDetailed → limbModel (Listen Up when it was on, else Core). w4rst4rLimbRules was never
  // registered here, so there's nothing to migrate from it.
  const lcd = rawSetting("limbCripplingDetailed");
  if (lcd !== undefined && rawSetting("limbModel") === undefined) {
    const model = lcd === true ? "listenup" : "core";
    await game.settings.set(SCOPE, "limbModel", model);
    await dropLegacy("limbCripplingDetailed");
    console.log(`${SCOPE} | limb-model migrated from limbCripplingDetailed → "${model}".`);
  }

  // ipSystem (3-way) → ipRawTracking (behaviour) + ipHideUI (presence). The dual-bucket flag DATA
  // (per-skill `ip` + actor `ipPool`) already exists, so there's no per-actor data migration — only
  // this setting remap: disabled → hide the UI; raw → RAW auto-tracking on; simple → neither.
  const ipOld = rawSetting("ipSystem");
  if (ipOld !== undefined) {
    if (ipOld === "raw" && rawSetting("ipRawTracking") === undefined) await game.settings.set(SCOPE, "ipRawTracking", true);
    if (ipOld === "disabled" && rawSetting("ipHideUI") === undefined) await game.settings.set(SCOPE, "ipHideUI", true);
    await dropLegacy("ipSystem");
    console.log(`${SCOPE} | IP setting migrated: ipSystem "${ipOld}" → rawTracking=${ipOld === "raw"}, hideUI=${ipOld === "disabled"}.`);
  }
}

Hooks.once("ready", function () {
  // Hard guard: the Augmented Edition only works on the cyberpunk2020 system.
  if (game.system.id !== SYSTEM_ID) {
    console.error(`${SCOPE} | requires the ${SYSTEM_ID} system; current system is "${game.system.id}".`);
    ui.notifications?.error(game.i18n.localize("CYBERPUNK.Augmented.WrongSystem"));
    return;
  }

  // One-time settings migrations (GM-only, self-gating, no version bump). The module has no migrate.js,
  // so the fork's setting-merge migrations live here. Each reads the orphaned legacy key straight from
  // world storage, writes the merged value once, then deletes the legacy doc so it never re-runs.
  if (game.user?.isGM) migrateAugmentedSettings().catch((e) => console.warn(`${SCOPE} | settings migration failed`, e));

  // First-run only: offer the settings-preset picker once for a new GM (mirrors the system's own
  // first-run picker). The flag flips immediately so the picker never reappears on later loads; the
  // GM can reopen it from the System Settings "Settings Presets" menu. Guarded so a hiccup is non-fatal.
  if (game.user?.isGM) {
    try {
      if (!game.settings.get(SCOPE, "presetFirstRunDone")) {
        game.settings.set(SCOPE, "presetFirstRunDone", true);
        new PresetPicker().render(true);
      }
    } catch (e) {
      console.warn(`${SCOPE} | first-run preset picker failed (open it from System Settings)`, e);
    }
  }

  // Apply the per-user Carolingian / Restyler terminal sheet skin (toggles the cp-carolingian
  // <body> class that gates the skin CSS in cp2020-augmented.css). Client-side cosmetic, so it
  // runs independently of the combat-automation gate below.
  applyCarolingianSkinClass();

  // combatAutomationEnabled is the master gate for the Augmented combat layer
  // (damage application, saves, area effects, combat-tracker controls, vehicle/ACPA
  // weapon fire + targeting + missiles); each individual behaviour is further gated by
  // its own setting. This mirrors the system's own "ready" registration, minus the
  // shop/IP registrars that land in later slices.
  if (combatAutomationEnabled()) {
    registerPopoutCompat();
    registerDamageHooks();
    registerMovementGate();
    registerSaveRollHandlers();

    // Vehicle / ACPA combat handlers (chat-button + per-round flight + crit hooks).
    registerVehicleFireHandlers();
    registerVehicleTargetingHandlers();
    registerMissileFlightHooks();
    registerAcpaCombatHooks();
  }

  // IP (Improvement Points) tracker — independent of the combat layer; the auto-queue self-gates on
  // ipRawTracking (RAW mode only), the in-sheet UI on ipEnabled (= !ipHideUI).
  registerIpHooks();
  // Player-facing in-sheet IP UI (per-skill level-up + lock header); self-gates on ipEnabled() per render.
  registerIpSheet();
  // In-sheet cyberware Install button on the item sheet; self-gates on shoppingEnabled() + vanilla-only.
  registerCyberwareSheet();
  // In-sheet Recurring Services panel in the gear tab; self-gates on shoppingEnabled() per render.
  registerServicesSheet();
  // In-sheet martial-arts panel on the combat tab; self-gates on combatAutomationEnabled() + vanilla-only.
  registerMartialSheet();
  // In-skill martial-art editor on the skill item sheet; self-gates on combatAutomationEnabled() + vanilla-only.
  registerMartialSkillEditor();

  // Shop / economy — the sidebar cart button + chat links + live buyer sync + the GM stock-decrement
  // relay. Independent of the combat layer; self-gates on shoppingEnabled (the sidebar button only
  // injects when shopping is on, and the catalog index is only warmed then).
  registerShopHooks();

  console.log(`${SCOPE} | Ready (on ${SYSTEM_ID} v${game.system.version}).`);
});

/**
 * Add a GM "IP Tracker" button to the Actors directory header when the IP system is enabled.
 * Mirrors the system's own button, scoped to the module's tracker.
 */
Hooks.on("renderActorDirectory", (app, html) => {
  try {
    if (!game.user.isGM || ipHideUI()) return;
    const root = html instanceof jQuery ? html[0] : html;
    if (!root || root.querySelector(".cp2020ae-ip-tracker-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cp2020ae-ip-tracker-btn";
    btn.innerHTML = `<i class="fas fa-graduation-cap"></i> ${game.i18n.localize("CYBERPUNK.IpTrackerTitle")}`;
    btn.addEventListener("click", () => openIpTracker());
    const header = root.querySelector(".directory-header") ?? root.querySelector(".header-actions") ?? root.firstElementChild ?? root;
    header.prepend(btn);
  } catch (e) { /* non-fatal */ }
});
