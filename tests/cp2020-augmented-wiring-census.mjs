/** WIRING CENSUS — the meta-suite against DEAD WIRING.
 *
 *  The escape class this exists to kill: a control that RENDERS but whose handler can never act on
 *  it, because the selector the handler binds matches nothing, or because a `data-*` field the
 *  handler reads is empty on the rendered node. The module's worst instance shipped for its entire
 *  life — the IP arrow's row rendered `data-skill-id=""` after a `{{#with}}` context re-point, and a
 *  presence-only leg stayed green the whole time, because the CONTROL was there. Presence certifies
 *  nothing; this suite certifies the CONTRACT between the handler and the rendered node.
 *
 *  Three legs, in order:
 *
 *   A  SERVE PARITY — every swept source file is byte-identical between the repo and the rig's
 *      serve copy. A census taken against a stale serve certifies the wrong bytes.
 *   B  STALENESS GUARD — the suite re-derives the wiring contract from the source at run time and
 *      compares it to the MANIFEST table below. A control that is added, retargeted, or taught to
 *      read a new `data-*` field, without being censused, fails here. A new control CANNOT ship
 *      uncensused.
 *   C  RENDERED CHECK — the real surfaces are opened on the rig with a deliberately loaded fixture,
 *      and for every manifest entry whose surface is rendered: the selector must match ≥1 node, and
 *      every `data-*` field the handler reads must be NON-EMPTY on the matched nodes.
 *
 *  Classification of a manifest entry after leg C:
 *    PASS            selector matched and every read field carries a value
 *    DEAD-CONTROL    the surface rendered, no `gate` is declared, and the selector matched nothing
 *    DEAD-DATA       the selector matched, but a field the handler reads is empty on EVERY match
 *                    — the IP-arrow shape: the handler runs, resolves nothing, and returns silently
 *    PARTIAL         the field is empty on SOME matches (informational; a conditional row)
 *    NOT-EXERCISED   the surface is not in the fixture set, or a declared `gate` was not met
 *
 *  NOT-EXERCISED is a COUNT, not a failure. It is the gap list, and it is meant to shrink: to close
 *  one, either render its surface here or meet its gate with a richer fixture.
 *
 *  The `gate` column is the honest half of the design. A control that only renders in some state
 *  ("only when a limb is marked", "only for a chipped skill") would otherwise read as dead every
 *  run. Declaring the gate names the state the fixture does not reach — an entry with a gate is a
 *  KNOWN gap, an entry without one that matches nothing is a FINDING.
 *
 *  Run:   node tests/cp2020-augmented-wiring-census.mjs
 *         node tests/cp2020-augmented-wiring-census.mjs --report   (rewrites the census report)
 *         node tests/cp2020-augmented-wiring-census.mjs --refresh  (rewrites MANIFEST from source —
 *                                                                   every added row still needs a
 *                                                                   surface and a gate decision)
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const BASE = process.env.FVTT_URL || "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD || "cp2020-v14-rig";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVE = process.env.FVTT_SERVE_ROOT
  || "C:/Users/randa/FoundryVTT-Vanilla-Data/Data/modules/cp2020-augmented";
const REFRESH = process.argv.includes("--refresh");
const REPORT = process.argv.includes("--report") || REFRESH;

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  THE SWEPT SET — the closed enumeration of sheet/window source this census covers. A file that
//  is not here is not censused at all; adding one is the way to widen the net.
// ═════════════════════════════════════════════════════════════════════════════════════════════
const SWEPT = [
  "module/actor/actor-sheet.js",
  "module/actor/vehicle-sheet.js",
  "module/actor/actor-tab-popout.js",
  "module/npcgen/npcgen-app.js",
  "module/shop/catalog.js",
  "module/shop/services.js",
  "module/shop/buy-ammo.js",
  "module/shop/setup-mode.js",
  "module/item/item-sheet.js",
  "module/item/augmented-item-sheet.js",
  "module/ip/tracker.js",
  "module/dialog/modifiers.js",
  "module/dialog/automation-notice.js",
  "module/dialog/preset-picker.js",
  "module/dialog/ip-neglect.js",
  "module/dialog/buy-ammo.js",
  "module/combat/DamageDialog.js",
  "module/combat/damage-hooks.js",
  // Added 2026-08-26 with the cover-lifecycle unit: the breach's REPAIR button rides a chat card and
  // the wall fieldset's Clear/Repair controls ride the native Wall sheet, so both are exactly the
  // shape this census exists for — a control that renders on a surface the suite must reach.
  "module/combat/cover.js",
  "module/vehicle/vehicle-weapons.js",
  "module/vehicle/vehicle-control.js",
  "module/vehicle/vehicle-boarding-hud.js",
  "module/vehicle/vehicle-aboard-banner.js",
  "module/vehicle/vehicle-acpa-combat.js",
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  THE MANIFEST — one row per CONTROL, derived from the source and then annotated by hand.
//
//    [ at, fn, surface, event, selector, reads, gate, optional ]
//
//    at        file:line of the listener REGISTRATION (informational; drift is warned, not failed)
//    fn        the enclosing method — where to look when a row fails
//    surface   which rendered surface the control belongs to (see SURFACES below)
//    event     the event type bound
//    selector  the selector the handler matches against
//    reads     comma-joined `data-*` fields (dataset camelCase) the handler reads off the node
//    gate      null, or the state a fixture must reach for the control to render at all
//    optional  null, or the subset of `reads` the handler uses as a BRANCH PROBE rather than a
//              required lookup (`if (row.dataset.ammoCaliber)` — absence is a valid row, not a
//              broken one). Everything not listed here must carry a value.
//              `ANY:a,b,c` marks a UNION selector instead: no single field can be required,
//              but every matched node must carry at least ONE of them, or it is unresolvable.
//
//  `gate` and `optional` are the two hand-authored columns; --refresh carries them over by key.
//
//  To extend: add the row. The staleness guard prints paste-ready rows for anything it finds in
//  source that is not here.
// ═════════════════════════════════════════════════════════════════════════════════════════════
const MANIFEST = [
  ["module/actor/actor-sheet.js:278", "_cpRestoreScroll", "character-sheet", "scroll", ".sheet-body", "", null, null],
  ["module/actor/actor-sheet.js:317", "_cpActivateActorFilePickers", "character-sheet", "click", "[data-edit]", "edit", null, null],
  ["module/actor/actor-sheet.js:327", "_cpActivateActorFilePickers", "character-sheet", "click", ".netrun-icon-frame img", "", null, null],
  ["module/actor/actor-sheet.js:327", "_cpActivateActorFilePickers", "character-sheet", "click", "input[name=\"system.icon\"]", "", null, null],
  ["module/actor/actor-sheet.js:327", "_cpActivateActorFilePickers", "character-sheet", "click", ".filepicker", "", null, null],
  ["module/actor/actor-sheet.js:372", "_cpActivateStatusStrip", "character-sheet", "click", ".cp-pill-off", "action,drug,itemId,penalty,togglePath", null, "action,drug,penalty"],
  ["module/actor/actor-sheet.js:405", "_cpActivateStatusStrip", "character-sheet", "change", "select.cp-vision-pick", "", "no vision-governing cyberware on the fixture, so the vision pick pill is never painted", null],
  ["module/actor/actor-sheet.js:414", "_cpActivateStatusStrip", "character-sheet", "change", "select.cp-fullborg-select", "", "the borg-mode select is gated on cpShowBorgToggle — no borg body or conversion state on the fixture", null],
  ["module/actor/actor-sheet.js:425", "_cpActivateStatusStrip", "character-sheet", "mousedown", ".cp-container-uninstall, .cp-group-remove, .cp-cyber-switch", "", null, null],
  ["module/actor/actor-sheet.js:433", "_cpActivateStatusStrip", "character-sheet", "click", ".cp-cyber-switch", "itemId", null, null],
  ["module/actor/actor-sheet.js:448", "_cpActivateStatusStrip", "character-sheet", "click", ".cp-container-uninstall", "itemId", "no cyberware nested inside a container on the fixture", null],
  ["module/actor/actor-sheet.js:462", "_cpActivateStatusStrip", "character-sheet", "click", ".cp-group-remove", "itemId", "no container or loadout group anchor on the fixture", null],
  ["module/actor/actor-sheet.js:514", "_cpActivateStatusStrip", "character-sheet", "click", ".cp-chassis-delete", "itemId", "no full-borg chassis on the fixture", null],
  ["module/actor/actor-sheet.js:612", "_cpActivateActorDragDrop", "character-sheet", "dragover", "[data-drop-target]", "", null, null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".stat-roll", "", null, null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".facedown-roll", "", null, null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".recognition-roll", "", null, null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".skill-roll", "", null, null],
  // Narrowed from the bare `.roll-initiative` / `.stun-death-save` block selectors to the clickable
  // label inside each: the block wraps its modifier <input>, so a click on the input closed up to the
  // block and fired the roll (outside contribution, actor-sheet.js:730/737).
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".roll-initiative .action", "", null, null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".roll-initiative-modificator", "", null, null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".stun-death-save .action", "", null, null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".roll-stun-death-modificator", "", null, null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".damage", "damage", null, null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".item-delete", "", null, null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".item-edit", "", null, null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".item-roll", "", "ORPHAN: no template in the module OR the base system paints `.item-roll`; both bind a handler for it", null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".chipware-container .chipware[data-item-id]", "", null, null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".fire-weapon", "", null, null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".item-unequip, .cp-container-uninstall, .cp-group-remove, .cp-chassis-delete", "", null, null],
  ["module/actor/actor-sheet.js:689", "_cpActivateBasicActorActions", "character-sheet", "click", ".item-unequip, .item-delete", "", null, null],
  ["module/actor/actor-sheet.js:783", "_cpActivateBasicActorActions", "character-sheet", "contextmenu", ".rc-item-delete", "", null, null],
  ["module/actor/actor-sheet.js:1176", "_cpActivateActorFormControls", "character-sheet", "click", ".skill-level", "", null, null],
  ["module/actor/actor-sheet.js:1176", "_cpActivateActorFormControls", "character-sheet", "click", ".skill-ask-mod", "", null, null],
  ["module/actor/actor-sheet.js:1176", "_cpActivateActorFormControls", "character-sheet", "click", "[data-action=\"clear-skill-search\"], .skill-search-clear", "", null, null],
  ["module/actor/actor-sheet.js:1176", "_cpActivateActorFormControls", "character-sheet", "click", "input.skill-search", "", null, null],
  ["module/actor/actor-sheet.js:1176", "_cpActivateActorFormControls", "character-sheet", "click", ".cp-cyberlimb-repair", "zone", "no damaged cyberlimb zone on the fixture", null],
  ["module/actor/actor-sheet.js:1176", "_cpActivateActorFormControls", "character-sheet", "click", ".cp-flesh-clear", "zone", "no recorded flesh-limb injury on the fixture", null],
  ["module/actor/actor-sheet.js:1176", "_cpActivateActorFormControls", "character-sheet", "click", ".cp-flesh-set", "zone", null, null],
  ["module/actor/actor-sheet.js:1230", "_cpActivateActorFormControls", "character-sheet", "keydown", ".skill-level", "", null, null],
  ["module/actor/actor-sheet.js:1239", "_cpActivateActorFormControls", "character-sheet", "change", "input[name^=\"system.sdp.current.\"]", "", "the SDP row paints only for a figure carrying cyberlimb or borg SDP", null],
  ["module/actor/actor-sheet.js:1239", "_cpActivateActorFormControls", "character-sheet", "change", ".skill-level", "", null, null],
  ["module/actor/actor-sheet.js:1239", "_cpActivateActorFormControls", "character-sheet", "change", ".skill-sort > select, .skill-sort select", "", null, null],
  ["module/actor/actor-sheet.js:1239", "_cpActivateActorFormControls", "character-sheet", "change", ".skill-ask-mod", "", null, null],
  ["module/actor/actor-sheet.js:1239", "_cpActivateActorFormControls", "character-sheet", "change", ".roll-initiative-modificator", "", null, null],
  ["module/actor/actor-sheet.js:1239", "_cpActivateActorFormControls", "character-sheet", "change", ".roll-stun-death-modificator", "", null, null],
  ["module/actor/actor-sheet.js:1239", "_cpActivateActorFormControls", "character-sheet", "change", "input[data-edit], select[data-edit], textarea[data-edit]", "", "no data-edit field on the character sheet's rendered tabs (the item sheet carries them)", null],
  ["module/actor/actor-sheet.js:1283", "_cpActivateActorFormControls", "character-sheet", "input", "input.skill-search", "", null, null],
  ["module/actor/actor-sheet.js:1298", "_cpActivateActorFormControls", "character-sheet", "pointerdown", "[data-action=\"clear-skill-search\"], .skill-search-clear", "", null, null],
  ["module/actor/actor-sheet.js:1299", "_cpActivateActorFormControls", "character-sheet", "mousedown", "[data-action=\"clear-skill-search\"], .skill-search-clear", "", null, null],
  ["module/actor/actor-sheet.js:1380", "_cpActivateCyberwareControls", "character-sheet", "mousedown", ".item-unequip", "", null, null],
  ["module/actor/actor-sheet.js:1388", "_cpActivateCyberwareControls", "character-sheet", "click", ".item-unequip", "", null, null],
  ["module/actor/actor-sheet.js:1392", "_cpActivateCyberwareControls", "character-sheet", "change", ".anatomy-select", "", null, null],
  ["module/actor/actor-sheet.js:1392", "_cpActivateCyberwareControls", "character-sheet", "change", ".chip-toggle input[data-skill-id]", "", null, null],
  ["module/actor/actor-sheet.js:1510", "attachChipwareTooltips", "character-sheet", "mouseenter", ".chipware", "", null, null],
  ["module/actor/actor-sheet.js:1511", "attachChipwareTooltips", "character-sheet", "mouseleave", ".chipware", "", null, null],
  ["module/actor/actor-sheet.js:1619", "_cpActivateNetrunningControls", "character-sheet", "click", ".interface-skill-roll", "skillId", null, null],
  ["module/actor/actor-sheet.js:1619", "_cpActivateNetrunningControls", "character-sheet", "click", ".netrun-program .fa-edit", "", null, null],
  ["module/actor/actor-sheet.js:1619", "_cpActivateNetrunningControls", "character-sheet", "click", ".netrun-program", "", null, null],
  ["module/actor/actor-sheet.js:1619", "_cpActivateNetrunningControls", "character-sheet", "click", ".netrun-program .fa-trash", "", null, null],
  ["module/actor/actor-sheet.js:1653", "_cpActivateNetrunningControls", "character-sheet", "contextmenu", ".netrun-active-icon", "itemId", null, null],
  ["module/actor/actor-sheet.js:1738", "_cpActivateRadiationControls", "character-sheet", "click", ".cp-rad-apply", "", "the radiation panel renders only while the radiation feature is switched on", null],
  ["module/actor/actor-sheet.js:1738", "_cpActivateRadiationControls", "character-sheet", "click", ".cp-rad-longterm", "", "the radiation panel renders only while the radiation feature is switched on", null],
  ["module/actor/actor-sheet.js:1738", "_cpActivateRadiationControls", "character-sheet", "click", ".cp-rad-clear", "", "the radiation panel renders only while the radiation feature is switched on", null],
  ["module/actor/actor-sheet.js:1738", "_cpActivateRadiationControls", "character-sheet", "click", ".cp-rad-cure", "", "the radiation panel renders only while the radiation feature is switched on", null],
  ["module/actor/actor-sheet.js:1738", "_cpActivateRadiationControls", "character-sheet", "click", ".cp-rad-reset", "", "the radiation panel renders only while the radiation feature is switched on", null],
  ["module/actor/actor-sheet.js:1786", "_cpActivateActorCustomControls", "character-sheet", "click", ".cp-service-add", "", null, null],
  ["module/actor/actor-sheet.js:1786", "_cpActivateActorCustomControls", "character-sheet", "click", ".cp-service-pay", "", "no service entry recorded on the fixture", null],
  ["module/actor/actor-sheet.js:1786", "_cpActivateActorCustomControls", "character-sheet", "click", ".cp-service-edit", "", "no service entry recorded on the fixture", null],
  ["module/actor/actor-sheet.js:1786", "_cpActivateActorCustomControls", "character-sheet", "click", ".cp-service-delete", "", "no service entry recorded on the fixture", null],
  ["module/actor/actor-sheet.js:1786", "_cpActivateActorCustomControls", "character-sheet", "click", ".cp2020ae-ip-level-up", "skillId", null, null],
  ["module/actor/actor-sheet.js:1786", "_cpActivateActorCustomControls", "character-sheet", "click", ".cp2020ae-ip-lock-toggle", "", null, null],
  ["module/actor/actor-sheet.js:1786", "_cpActivateActorCustomControls", "character-sheet", "click", ".martial-action", "", null, null],
  ["module/actor/actor-sheet.js:1786", "_cpActivateActorCustomControls", "character-sheet", "click", ".cp-open-shop", "", "ORPHAN (deliberate): the control was removed from the sheet — templates/actor/parts/gear.hbs records the decision and notes the handler is left harmless", null],
  ["module/actor/actor-sheet.js:1786", "_cpActivateActorCustomControls", "character-sheet", "click", "[data-item-id]", "", null, null],
  ["module/actor/actor-sheet.js:2613", "_activateTabTearOff", "character-sheet", "pointerdown", ".item[data-tab]", "tab", null, null],
  ["module/actor/actor-sheet.js:2731", "_activateGearDragSort", "character-sheet", "dragstart", ".gear[data-item-id]", "itemId", null, null],
  ["module/actor/actor-sheet.js:2739", "_activateGearDragSort", "character-sheet", "dragend", ".gear[data-item-id]", "", null, null],
  ["module/actor/actor-sheet.js:2752", "_activateGearDragSort", "character-sheet", "dragover", ".gear[data-item-id]", "itemId", null, null],
  ["module/actor/actor-sheet.js:3511", "_cpSetupNotesActions", "character-sheet", "click", "[data-action=\"notes-edit\"]", "", null, null],
  ["module/actor/vehicle-sheet.js:460", "_cpActivateFaceSelect", "vehicle-sheet", "change", "select.cp-veh-face-select", "faceCurrent", null, null],
  ["module/actor/vehicle-sheet.js:492", "_cpActivateCivilianControls", "vehicle-sheet", "click", ".cp-veh-source", "", null, null],
  ["module/actor/vehicle-sheet.js:492", "_cpActivateCivilianControls", "vehicle-sheet", "click", ".field.accel, .field.decel", "", null, null],
  ["module/actor/vehicle-sheet.js:523", "_cpActivateCountermeasures", "vehicle-sheet", "change", "input.cp-cm-box", "", null, null],
  ["module/actor/vehicle-sheet.js:523", "_cpActivateCountermeasures", "vehicle-sheet", "change", "input.cp-cm-box:checked", "", "`:checked` is a live-state selector — no countermeasure box is ticked on the fixture", null],
  ["module/actor/vehicle-sheet.js:541", "_cpActivateAcpaMode", "vehicle-sheet", "change", "select[name='system.acpaCombatModel']", "", null, null],
  ["module/actor/vehicle-sheet.js:578", "_onControlRoll", "vehicle-sheet", "click", "[data-action=\"controlRoll\"]", "", null, null],
  ["module/actor/vehicle-sheet.js:638", "_onVehicleDamage", "vehicle-sheet", "click", "[data-action=\"vehicleDamage\"]", "", null, null],
  ["module/actor/vehicle-sheet.js:643", "_onAcpaMelee", "vehicle-sheet", "click", "[data-action=\"acpaMelee\"]", "", null, null],
  ["module/actor/vehicle-sheet.js:648", "_onAcpaRepair", "vehicle-sheet", "click", "[data-action=\"acpaRepair\"]", "", null, null],
  ["module/actor/vehicle-sheet.js:653", "_onReactiveReplace", "vehicle-sheet", "click", "[data-action=\"reactiveReplace\"]", "", "no reactive plating fitted on the fixture suit", null],
  ["module/actor/vehicle-sheet.js:660", "_onWeaponAdd", "vehicle-sheet", "click", "[data-action=\"weaponAdd\"]", "", null, null],
  ["module/actor/vehicle-sheet.js:665", "_onWeaponEdit", "vehicle-sheet", "click", "[data-action=\"weaponEdit\"]", "weaponId", "no weapons mounted on the fixture vehicle", null],
  ["module/actor/vehicle-sheet.js:670", "_onWeaponDelete", "vehicle-sheet", "click", "[data-action=\"weaponDelete\"]", "weaponId", "no weapons mounted on the fixture vehicle", null],
  ["module/actor/vehicle-sheet.js:676", "_onWeaponFire", "vehicle-sheet", "click", "[data-action=\"weaponFire\"]", "weaponId", "no weapons mounted on the fixture vehicle", null],
  ["module/actor/vehicle-sheet.js:689", "_onAcpaSystemAdd", "vehicle-sheet", "click", "[data-action=\"acpaSystemAdd\"]", "", null, null],
  ["module/actor/vehicle-sheet.js:696", "_onAcpaSystemEdit", "vehicle-sheet", "click", "[data-action=\"acpaSystemEdit\"]", "systemId", "no ACPA systems fitted on the fixture suit", null],
  ["module/actor/vehicle-sheet.js:701", "_onAcpaSystemDelete", "vehicle-sheet", "click", "[data-action=\"acpaSystemDelete\"]", "systemId", "no ACPA systems fitted on the fixture suit", null],
  ["module/actor/vehicle-sheet.js:584", "_onOccupantDisembark", "vehicle-sheet", "click", "[data-action=\"occupantDisembark\"]", "sceneId,tokenId", "no occupant aboard the fixture vehicle", null],
  ["module/actor/vehicle-sheet.js:599", "_onLayoutFront", "vehicle-sheet", "click", "[data-action=\"layoutFront\"]", "front", null, null],
  ["module/actor/vehicle-sheet.js:613", "_onLayoutCell", "vehicle-sheet", "click", "[data-action=\"layoutCell\"]", "index", null, null],
  ["module/actor/vehicle-sheet.js:632", "_onLayoutReset", "vehicle-sheet", "click", "[data-action=\"layoutReset\"]", "", null, null],
  ["module/npcgen/npcgen-app.js:415", "_onRender", "goon-factory", "change", ".cp-goon-grade, .cp-goon-role, .cp-goon-outfit, .cp-goon-disposition, .cp-goon-count, .cp-goon-dest", "", null, null],
  ["module/npcgen/npcgen-app.js:426", "_onRender", "goon-factory", "input", ".cp-goon-row", "", null, null],
  ["module/npcgen/npcgen-app.js:426", "_onRender", "goon-factory", "input", ".cp-goon-dials input[type='range']", "", null, null],
  ["module/npcgen/npcgen-app.js:718", "injectNpcGenButton", "actor-directory", "click", ".cp2020ae-npcgen-btn", "", null, null],
  ["module/npcgen/npcgen-app.js:622", "_onAdvanced", "goon-factory", "click", "[data-action=\"goonAdvanced\"]", "", null, null],
  ["module/npcgen/npcgen-app.js:629", "_onGenerate", "goon-factory", "click", "[data-action=\"goonGenerate\"]", "", null, null],
  ["module/npcgen/npcgen-app.js:638", "_onConfirm", "goon-factory", "click", "[data-action=\"goonConfirm\"]", "", "a COMPUTED action key: the go-button paints data-action=\"{{generateAction}}\", which is this key only once a batch is previewed", null],
  ["module/npcgen/npcgen-app.js:652", "_onDiscard", "goon-factory", "click", "[data-action=\"goonDiscard\"]", "", "the preview strip renders only while a generated batch is held — the fixture's Generate click did not settle one", null],
  ["module/npcgen/npcgen-app.js:665", "_onRerollOne", "goon-factory", "click", "[data-action=\"goonRerollOne\"]", "index", "the preview strip renders only while a generated batch is held — the fixture's Generate click did not settle one", null],
  ["module/npcgen/npcgen-app.js:681", "_onDeleteOne", "goon-factory", "click", "[data-action=\"goonDeleteOne\"]", "index", "the preview strip renders only while a generated batch is held — the fixture's Generate click did not settle one", null],
  ["module/npcgen/npcgen-app.js:629", "_onGenerate", "goon-factory", "click", "[data-action=\"goonPickDestination\"]", "", "a COMPUTED action key: the go-button paints data-action=\"{{generateAction}}\", which is this key only while a destination is still unpicked", null],
  ["module/shop/catalog.js:868", "_activateRowChoices", "shop-catalog", "input", ".cp-catalog-qty", "", null, null],
  ["module/shop/catalog.js:881", "_activateRowChoices", "shop-catalog", "change", ".cp-catalog-ammo-load", "", null, null],
  ["module/shop/catalog.js:881", "_activateRowChoices", "shop-catalog", "change", ".cp-cat-price b", "", null, null],
  ["module/shop/catalog.js:891", "_activateRowChoices", "shop-catalog", "change", ".cp-catalog-style", "", "the style picker paints only on fashion rows (r.fashion) in the catalog view — the windowed opening paint's rows hold none", null],
  ["module/shop/catalog.js:909", "_activateBuyerPick", "shop-catalog", "change", ".cp-buyer-pick", "", null, null],
  ["module/shop/catalog.js:987", "activateListeners", "shop-catalog", "click", ".cp-shop-back", "", null, null],
  ["module/shop/catalog.js:990", "activateListeners", "shop-home", "click", ".cp-home-catalog", "", null, null],
  ["module/shop/catalog.js:991", "activateListeners", "shop-storefront", "click", ".cp-shop-manage", "", null, null],
  ["module/shop/catalog.js:995", "activateListeners", "shop-home", "click", ".cp-home-shop", "shopId", null, null],
  ["module/shop/catalog.js:999", "activateListeners", "shop-home", "click", ".cp-home-create", "", null, null],
  ["module/shop/catalog.js:1009", "activateListeners", "shop-home", "contextmenu", ".cp-home-shop", "shopId", null, null],
  ["module/shop/catalog.js:1012", "activateListeners", "shop-catalog", "click", ".cp-shop-missing-back", "", "the dead-end panel renders only for a view whose shop has been deleted under it — driven end to end by the shop-drawer suite", null],
  ["module/shop/catalog.js:1015", "activateListeners", "shop-catalog", "input", ".cp-catalog-search", "", null, null],
  ["module/shop/catalog.js:1022", "activateListeners", "shop-catalog", "change", ".cp-catalog-showsource", "", null, null],
  ["module/shop/catalog.js:1030", "activateListeners", "shop-catalog", "click", ".cp-drawer-clear", "", "the clear control renders only while a filter is active — driven end to end by the shop-drawer suite", null],
  ["module/shop/catalog.js:1042", "activateListeners", "shop-catalog", "click", ".cp-jump", "letter", null, null],
  ["module/shop/catalog.js:1042", "activateListeners", "shop-catalog", "click", ".cp-catalog-list", "", null, null],
  ["module/shop/catalog.js:1053", "activateListeners", "shop-catalog", "click", ".cp-drawer-toggle", "", null, null],
  ["module/shop/catalog.js:1053", "activateListeners", "shop-catalog", "click", ".cp-filter-drawer", "open", null, null],
  ["module/shop/catalog.js:1068", "activateListeners", "shop-catalog", "click", ".cp-cat-expand", "cat", null, null],
  ["module/shop/catalog.js:1068", "activateListeners", "shop-catalog", "click", "i", "", null, null],
  ["module/shop/catalog.js:1092", "activateListeners", "shop-catalog", "change", ".cp-src-toggle", "source", null, null],
  ["module/shop/catalog.js:1119", "_activateRowControls", "shop-catalog", "click", ".cp-cat-itemname, .cp-cat-thumb", "", null, null],
  ["module/shop/catalog.js:1119", "_activateRowControls", "shop-catalog", "click", "[data-item-id], [data-source-key]", "", null, null],
  ["module/shop/catalog.js:1128", "_activateRowControls", "shop-catalog", "click", ".cp-catalog-buy", "", null, null],
  ["module/shop/catalog.js:1128", "_activateRowControls", "shop-catalog", "click", "[data-ammo-caliber], [data-item-id], [data-source-key]", "ammoCaliber,curated,itemId,packId,sourceKey", null, "ANY:ammoCaliber,itemId,sourceKey"],
  ["module/shop/catalog.js:1154", "_activateRowControls", "shop-catalog", "click", ".cp-list-items .cp-shop-add", "", "the ＋ add-to-shop control paints only under the build view's {{#if @root.isBuild}} branch — the catalog view paints Buy in its place", null],
  ["module/shop/catalog.js:1154", "_activateRowControls", "shop-catalog", "click", "[data-source-key]", "sourceKey", null, null],
  ["module/shop/catalog.js:1327", "_activateEyePaint", "shop-catalog", "pointerdown", ".cp-book-eye", "", null, null],
  ["module/shop/catalog.js:1327", "_activateEyePaint", "shop-catalog", "pointerdown", ".cp-src-toggle", "", null, null],
  ["module/shop/catalog.js:1335", "_activateEyePaint", "shop-catalog", "pointermove", ".cp-book-eye", "", null, null],
  ["module/shop/catalog.js:1337", "_activateEyePaint", "shop-catalog", "pointerup", ".cp-book-eye", "", null, null],
  ["module/shop/catalog.js:1338", "_activateEyePaint", "shop-catalog", "pointercancel", ".cp-book-eye", "", null, null],
  ["module/shop/catalog.js:1339", "_activateEyePaint", "shop-catalog", "click", ".cp-book-eye", "", null, null],
  ["module/shop/catalog.js:1360", "_activatePurchaseDrag", "shop-catalog", "dragstart", ".cp-catalog-list .cp-catalog-row[data-source-key]", "", null, null],
  ["module/shop/catalog.js:1391", "_activateListWindow", "shop-catalog", "scroll", ".cp-catalog-list", "", null, null],
  ["module/shop/catalog.js:1535", "_activateSetupMode", "shop-build", "click", ".cp-shop-setup-toggle", "", null, null],
  ["module/shop/catalog.js:1571", "_openContextMenu", "shop-contextmenu", "click", "button[data-action]", "action", null, null],
  ["module/shop/catalog.js:1616", "_activateBuildControls", "shop-build", "click", ".cp-shop-remove", "", "per-stocked-line control — the fixture shop's stocking did not take", null],
  ["module/shop/catalog.js:1616", "_activateBuildControls", "shop-build", "click", ".cp-bulk-add", "", null, null],
  ["module/shop/catalog.js:1633", "_activateBuildControls", "shop-build", "click", ".cp-vendor-clear", "", "the vendor tray's clear renders only for a shop holding lines", null],
  ["module/shop/catalog.js:1646", "_activateBuildControls", "shop-build", "change", ".cp-shop-price", "", "per-stocked-line control — the fixture shop's stocking did not take", null],
  ["module/shop/catalog.js:1649", "_activateBuildControls", "shop-build", "change", ".cp-shop-stock-qty", "", "per-stocked-line control — the fixture shop's stocking did not take", null],
  ["module/shop/catalog.js:1657", "_activateBuildControls", "shop-build", "click", ".cp-shop-inf", "", "per-stocked-line control — the fixture shop's stocking did not take", null],
  ["module/shop/catalog.js:1663", "_activateBuildControls", "shop-build", "click", ".cp-stockall-apply", "", "the bulk-stock strip renders only for a shop holding lines", null],
  ["module/shop/catalog.js:1663", "_activateBuildControls", "shop-build", "click", ".cp-stockall-qty", "", "the bulk-stock strip renders only for a shop holding lines", null],
  ["module/shop/catalog.js:1670", "_activateBuildControls", "shop-build", "click", ".cp-stockall-inf", "", "the bulk-stock strip renders only for a shop holding lines", null],
  ["module/shop/catalog.js:1677", "_activateBuildControls", "shop-build", "change", ".cp-shop-style", "", "per-stocked-line control — the fixture shop's stocking did not take", null],
  ["module/shop/catalog.js:1677", "_activateBuildControls", "shop-build", "change", ".cp-shop-name", "", null, null],
  ["module/shop/catalog.js:1680", "_activateBuildControls", "shop-build", "change", ".cp-shop-open", "", null, null],
  ["module/shop/catalog.js:1681", "_activateBuildControls", "shop-build", "change", ".cp-shop-fullsearch", "", null, null],
  ["module/shop/catalog.js:1682", "_activateBuildControls", "shop-build", "change", ".cp-shop-discount", "", null, null],
  ["module/shop/catalog.js:1683", "_activateBuildControls", "shop-build", "change", ".cp-shop-notes", "", null, null],
  ["module/shop/catalog.js:1684", "_activateBuildControls", "shop-build", "click", ".cp-shop-announce", "", null, null],
  ["module/shop/catalog.js:1688", "_activateBuildControls", "shop-build", "click", ".cp-shop-preview", "", null, null],
  ["module/shop/catalog.js:1689", "_activateBuildControls", "shop-build", "click", ".cp-shop-delete", "", null, null],
  ["module/shop/catalog.js:1699", "_activateBuildControls", "shop-build", "dragover", ".cp-vendor-tray", "", null, null],
  ["module/shop/catalog.js:1700", "_activateBuildControls", "shop-build", "dragleave", ".cp-vendor-tray", "", null, null],
  ["module/shop/catalog.js:1701", "_activateBuildControls", "shop-build", "drop", ".cp-vendor-tray", "", null, null],
  ["module/shop/catalog.js:2101", "injectSidebarShopButton", "sidebar", "click", ".ui-control.plain.icon.fa-solid.fa-cart-shopping.cp-shop-tab", "", null, null],
  ["module/shop/catalog.js:2155", "_wireShopCardControls", "chat-card", "click", ".cp-shop-open-link", "shopId", null, null],
  ["module/shop/catalog.js:2162", "_wireShopCardControls", "chat-card", "click", ".cp-shop-request-btn", "action", null, null],
  ["module/shop/catalog.js:2162", "_wireShopCardControls", "chat-card", "click", ".cp-shop-request", "", null, null],
  ["module/shop/catalog.js:2162", "_wireShopCardControls", "chat-card", "click", ".cp-shop-request-price", "", null, null],
  ["module/item/item-sheet.js:883", "_cpActivateArmorRestoreControl", "item-sheet:any", "click", ".cp-armor-restore", "", "renders only on a pack-sourced armor item viewed by a GM (parseCompendiumSource must resolve) — the fixture item is not one", null],
  ["module/item/item-sheet.js:897", "_cpActivateMechConsumableControls", "item-sheet:consumable", "click", ".cp-consumable-use", "", null, null],
  ["module/item/item-sheet.js:897", "_cpActivateMechConsumableControls", "item-sheet:consumable", "click", ".cp-drug-take", "", null, null],
  ["module/item/item-sheet.js:897", "_cpActivateMechConsumableControls", "item-sheet:consumable", "click", ".cp-drug-end", "", "the wear-off control renders only while the drug is active on a holder", null],
  ["module/item/item-sheet.js:897", "_cpActivateMechConsumableControls", "item-sheet:consumable", "click", ".cp-chip-choice-reset", "", "renders only for a chipware item holding a recorded choice", null],
  ["module/item/item-sheet.js:934", "_cpActivateVehicleDeployControls", "item-sheet:vehicle", "click", ".cp-vehicle-open", "actorId", "the open control renders only once the vehicle item has a deployed actor", null],
  ["module/item/item-sheet.js:934", "_cpActivateVehicleDeployControls", "item-sheet:vehicle", "click", ".cp-vehicle-deploy", "", "the deploy control is gated on the vehicle feature setting", null],
  ["module/item/item-sheet.js:979", "_cpActivateVehicleFaceSelect", "item-sheet:any", "change", "select.cp-veh-face-select", "faceCurrent", "renders on a VEHICLE item sheet only (the handler returns early for any other item type) and only when the face strip asks for it — templates/actor/parts/vehicle-face.hbs gates the select on faceControl.show", null],
  ["module/item/item-sheet.js:1077", "_cpActivateTabs", "item-sheet:any", "click", ".sheet-tabs", "", null, null],
  ["module/item/item-sheet.js:1077", "_cpActivateTabs", "item-sheet:any", "click", "[data-tab]", "tab", null, null],
  ["module/item/item-sheet.js:1131", "_cpActivateBasicItemActions", "item-sheet:any", "click", ".item-roll", "", "ORPHAN: no template in the module OR the base system paints `.item-roll`; both bind a handler for it", null],
  ["module/item/item-sheet.js:1131", "_cpActivateBasicItemActions", "item-sheet:any", "click", ".humanity-cost-roll", "", "renders on a cyberware item's settings tab, not on the weapon sheet this surface opens", null],
  ["module/item/item-sheet.js:1370", "_cpActivateCyberwareBasicControls", "item-sheet:cyberware", "change", "select.cw-add-stat", "", "the cyberware mechanics editor renders only for an item with a chosen cyberwareType", null],
  ["module/item/item-sheet.js:1370", "_cpActivateCyberwareBasicControls", "item-sheet:cyberware", "change", "select.cw-add-check", "", "the cyberware mechanics editor renders only for an item with a chosen cyberwareType", null],
  ["module/item/item-sheet.js:1370", "_cpActivateCyberwareBasicControls", "item-sheet:cyberware", "change", "select.cw-add-location", "", "the cyberware mechanics editor renders only for an item with a chosen cyberwareType", null],
  ["module/item/item-sheet.js:1370", "_cpActivateCyberwareBasicControls", "item-sheet:cyberware", "change", "select.cw-add-penalty", "", "the cyberware mechanics editor renders only for an item with a chosen cyberwareType", null],
  ["module/item/item-sheet.js:1370", "_cpActivateCyberwareBasicControls", "item-sheet:cyberware", "change", "select.cw-add-mountpolicy", "", "ORPHAN: the MountPolicy add control is bound and its list read and written, but no template paints it", null],
  ["module/item/item-sheet.js:1372", "_cpActivateCyberwareBasicControls", "item-sheet:cyberware", "click", ".cw-remove-stat", "", "renders per recorded stat entry on the cyberware mechanics editor", null],
  ["module/item/item-sheet.js:1372", "_cpActivateCyberwareBasicControls", "item-sheet:cyberware", "click", ".cw-remove-check", "", "renders per recorded check entry on the cyberware mechanics editor", null],
  ["module/item/item-sheet.js:1372", "_cpActivateCyberwareBasicControls", "item-sheet:cyberware", "click", ".cw-remove-skill", "", "renders per recorded skill entry on the cyberware mechanics editor", null],
  ["module/item/item-sheet.js:1372", "_cpActivateCyberwareBasicControls", "item-sheet:cyberware", "click", ".cw-remove-location", "", "renders per recorded location entry on the cyberware mechanics editor", null],
  ["module/item/item-sheet.js:1372", "_cpActivateCyberwareBasicControls", "item-sheet:cyberware", "click", ".cw-remove-penalty", "", "renders per recorded penalty entry on the cyberware mechanics editor", null],
  ["module/item/item-sheet.js:1372", "_cpActivateCyberwareBasicControls", "item-sheet:cyberware", "click", ".cw-remove-mount", "", "ORPHAN: the MountPolicy remove control is bound, but no template paints it", null],
  ["module/item/item-sheet.js:1544", "_cpActivateCyberwareMechanicTypeControls", "item-sheet:cyberware", "click", ".cw-ms-trigger", "", null, null],
  ["module/item/item-sheet.js:1544", "_cpActivateCyberwareMechanicTypeControls", "item-sheet:cyberware", "click", ".cw-ms", "", null, null],
  ["module/item/item-sheet.js:1544", "_cpActivateCyberwareMechanicTypeControls", "item-sheet:cyberware", "click", ".cw-ms-menu", "", null, null],
  ["module/item/item-sheet.js:1546", "_cpActivateCyberwareMechanicTypeControls", "item-sheet:cyberware", "change", ".cw-ms-menu input[type='checkbox']", "", null, null],
  ["module/item/item-sheet.js:1546", "_cpActivateCyberwareMechanicTypeControls", "item-sheet:cyberware", "change", ".cw-ms", "path", null, null],
  ["module/item/item-sheet.js:1546", "_cpActivateCyberwareMechanicTypeControls", "item-sheet:cyberware", "change", ".cw-ms-menu", "", null, null],
  ["module/item/item-sheet.js:1546", "_cpActivateCyberwareMechanicTypeControls", "item-sheet:cyberware", "change", "input[type='checkbox']:checked", "", null, null],
  ["module/item/item-sheet.js:1546", "_cpActivateCyberwareMechanicTypeControls", "item-sheet:cyberware", "change", "input[value=\"Descriptive\"]", "", null, null],
  ["module/item/item-sheet.js:1702", "_cpActivateCyberwareSkillSearchControls", "item-sheet:cyberware", "input", "input[name='cw-skill-search'], input[name='cw-chip-skill-search']", "", "the skill-search boxes render only inside the cyberware mechanics editor (needs a chosen cyberwareType)", null],
  ["module/item/item-sheet.js:1704", "_cpActivateCyberwareSkillSearchControls", "item-sheet:cyberware", "change", "input[name='cw-skill-search'], input[name='cw-chip-skill-search']", "", "the skill-search boxes render only inside the cyberware mechanics editor (needs a chosen cyberwareType)", null],
  ["module/item/item-sheet.js:1705", "_cpActivateCyberwareSkillSearchControls", "item-sheet:cyberware", "mousedown", "input[name='cw-skill-search'], input[name='cw-chip-skill-search']", "", "the skill-search boxes render only inside the cyberware mechanics editor (needs a chosen cyberwareType)", null],
  ["module/item/item-sheet.js:1706", "_cpActivateCyberwareSkillSearchControls", "item-sheet:cyberware", "click", ".cw-remove-chipskill", "key", "renders per recorded ChipSkills entry", null],
  ["module/item/item-sheet.js:1990", "_cpActivateSkillItemControls", "item-sheet:skill", "change", "input[name=\"system.level\"], input[name=\"system.chipLevel\"], input[name=\"system.isChipped\"]", "", null, null],
  ["module/item/item-sheet.js:2182", "_cpActivateNumericCommaInputs", "item-sheet:any", "change", "input[type=\"number\"]", "", null, null],
  ["module/item/item-sheet.js:2201", "_cpActivateCyberwareInstall", "item-sheet:cyberware", "click", ".cyber-install", "", "the install control renders only for cyberware held by an actor with an install target", null],
  ["module/item/item-sheet.js:2228", "_cpActivateVehicleWeaponShellControls", "item-sheet:vehicleweapon", "click", ".cp-sv-add", "", null, null],
  ["module/item/item-sheet.js:2228", "_cpActivateVehicleWeaponShellControls", "item-sheet:vehicleweapon", "click", ".cp-sv-remove", "index", "shell-variant rows render only for a weapon that defines shell variants", null],
  ["module/item/item-sheet.js:2256", "_cpActivateVehicleWeaponShellControls", "item-sheet:vehicleweapon", "change", ".cp-sv", "field", "shell-variant rows render only for a weapon that defines shell variants", null],
  ["module/item/item-sheet.js:2256", "_cpActivateVehicleWeaponShellControls", "item-sheet:vehicleweapon", "change", ".cp-shellvar", "", "shell-variant rows render only for a weapon that defines shell variants", null],
  ["module/item/item-sheet.js:2279", "_cpActivateAmmoControls", "item-sheet:ammo", "change", "input.ammo-blast-mult", "index", "the blast-multiplier row renders only for blast-capable ammo", null],
  ["module/item/item-sheet.js:2279", "_cpActivateAmmoControls", "item-sheet:ammo", "change", "select.cp-ammo-modifier", "", null, null],
  ["module/item/item-sheet.js:2279", "_cpActivateAmmoControls", "item-sheet:ammo", "change", ".ammo-ms-menu input[type=checkbox]", "", null, null],
  ["module/item/item-sheet.js:2279", "_cpActivateAmmoControls", "item-sheet:ammo", "change", ".ammo-ms", "", null, null],
  ["module/item/item-sheet.js:2279", "_cpActivateAmmoControls", "item-sheet:ammo", "change", ".ammo-ms-menu", "", null, null],
  ["module/item/item-sheet.js:2279", "_cpActivateAmmoControls", "item-sheet:ammo", "change", "input[type=checkbox]:checked", "", null, null],
  ["module/item/item-sheet.js:2279", "_cpActivateAmmoControls", "item-sheet:ammo", "change", "input[value=\"None\"]", "", null, null],
  ["module/item/item-sheet.js:2363", "_cpActivateAmmoControls", "item-sheet:ammo", "click", ".cp-ammo-qty-lock", "", null, null],
  ["module/item/item-sheet.js:2363", "_cpActivateAmmoControls", "item-sheet:ammo", "click", ".cp-ammo-buy-box", "", null, null],
  ["module/item/item-sheet.js:2363", "_cpActivateAmmoControls", "item-sheet:ammo", "click", ".ammo-ms-trigger", "", null, null],
  ["module/item/item-sheet.js:2363", "_cpActivateAmmoControls", "item-sheet:ammo", "click", ".ammo-ms", "", null, null],
  ["module/item/item-sheet.js:2491", "_cpSetupNotesActions", "item-sheet:any", "click", "[data-action=\"notes-edit\"]", "", null, null],
  ["module/item/augmented-item-sheet.js:79", "_onRender", "item-sheet:vehicleweapon", "change", "input[type=\"number\"]", "", null, null],
  ["module/item/augmented-item-sheet.js:94", "_bindShellVariants", "item-sheet:vehicleweapon", "click", ".cp-sv-add", "", null, null],
  ["module/item/augmented-item-sheet.js:103", "_bindShellVariants", "item-sheet:vehicleweapon", "click", ".cp-sv-remove", "index", "shell-variant rows render only for a weapon that defines shell variants", null],
  ["module/item/augmented-item-sheet.js:115", "_bindShellVariants", "item-sheet:vehicleweapon", "change", ".cp-sv", "field", "shell-variant rows render only for a weapon that defines shell variants", null],
  ["module/item/augmented-item-sheet.js:115", "_bindShellVariants", "item-sheet:vehicleweapon", "change", ".cp-shellvar", "", "shell-variant rows render only for a weapon that defines shell variants", null],
  ["module/ip/tracker.js:133", "_onRender", "ip-tracker", "change", ".cp-ip-amount", "", null, null],
  ["module/ip/tracker.js:138", "_onRender", "ip-tracker", "keydown", ".cp-ip-amount", "", null, null],
  ["module/ip/tracker.js:138", "_onRender", "ip-tracker", "keydown", "[data-row-id]", "", null, null],
  ["module/ip/tracker.js:148", "_onRender", "ip-tracker", "change", ".cp-ip-success", "", "the success tick renders per queue row of a kind that records one; the seeded roll row does not", null],
  ["module/ip/tracker.js:155", "_onRender", "ip-tracker", "input", ".cp-ip-filter", "", null, null],
  ["module/ip/tracker.js:189", "_applyBalanceFilter", "ip-tracker", "change", ".cp-ip-bank", "", "the balances accordion paints skill rows only for an OPENED character block — the fixture's open click did not settle one", null],
  ["module/ip/tracker.js:189", "_applyBalanceFilter", "ip-tracker", "change", "[data-skill-id]", "actorId,skillId", "the balances accordion paints skill rows only for an OPENED character block — the fixture's open click did not settle one", null],
  ["module/ip/tracker.js:195", "_applyBalanceFilter", "ip-tracker", "change", ".cp-ip-pool", "actorId", "the balances accordion paints its pool field only for an opened character block", null],
  ["module/ip/tracker.js:352", "_manualAdd", "dialog:ip-manual", "change", "[name=\"actor\"]", "", null, null],
  ["module/dialog/modifiers.js:159", "_onRender", "dialog:modifiers", "focus", "input[type=\"number\"], input[type=\"text\"]", "", null, null],
  ["module/dialog/modifiers.js:187", "_onRender", "dialog:modifiers", "change", ".cp-ammo-tracking", "", null, null],
  ["module/dialog/modifiers.js:187", "_onRender", "dialog:modifiers", "change", ".cp-ammo-tracking-label", "", null, null],
  ["module/dialog/modifiers.js:203", "_onRender", "dialog:modifiers", "click", ".reload", "", null, null],
  ["module/dialog/modifiers.js:367", "_onRender", "dialog:modifiers", "click", ".unload", "", null, null],
  ["module/dialog/modifiers.js:435", "_onRender", "dialog:modifiers", "change", "input.adv-dis.adv", "", null, null],
  ["module/dialog/modifiers.js:438", "_onRender", "dialog:modifiers", "change", "input.adv-dis.dis", "", null, null],
  ["module/dialog/automation-notice.js:130", "_onRender", "dialog:automation-notice", "change", ".cp-notice-hide", "", null, null],
  ["module/dialog/preset-picker.js:50", "_onApply", "dialog:preset-picker", "click", "[data-action=\"presetApply\"]", "preset", null, null],
  ["module/dialog/preset-picker.js:83", "_onUndo", "dialog:preset-picker", "click", "[data-action=\"presetUndo\"]", "", null, null],
  ["module/combat/DamageDialog.js:240", "_onRender", "dialog:damage", "change", "select[name='armorMode']", "", null, null],
  ["module/combat/DamageDialog.js:246", "_onRender", "dialog:damage", "change", "select[name='damageType']", "", null, null],
  ["module/combat/DamageDialog.js:252", "_onRender", "dialog:damage", "change", "input[name='coverSP']", "", null, null],
  ["module/combat/DamageDialog.js:259", "_onRender", "dialog:damage", "change", "input[name='ablate']", "", null, null],
  ["module/combat/DamageDialog.js:266", "_onRender", "dialog:damage", "change", "input.after-sp-override", "hitIndex", null, null],
  ["module/combat/DamageDialog.js:402", "_onApply", "dialog:damage", "click", "[data-action=\"applyDamage\"]", "", null, null],
  ["module/combat/DamageDialog.js:553", "_onChewCoverOnly", "dialog:damage", "click", "[data-action=\"chewCoverOnly\"]", "", "renders only when the shot's line crossed a cover OBJECT, and only until it is pressed — a hand-opened window has no line to test and a typed Cover SP names no document to debit", null],
  ["module/combat/DamageDialog.js:576", "_onCancel", "dialog:damage", "click", "[data-action=\"cancelDialog\"]", "", null, null],
  ["module/combat/damage-hooks.js:314", "onGlobalClick", "chat-card", "click", ".cp-suppression-evasion-roll", "actorId,attackerId,dmgFormula,saveDc,sceneId,tokenId", "renders on a suppressive-fire card, one row per defender caught in the lane", null],
  ["module/combat/damage-hooks.js:314", "onGlobalClick", "chat-card", "click", ".cp-suppressive-unlock", "regionId,sceneId", "renders on a placed suppressive-lane card, GM only", null],
  ["module/combat/damage-hooks.js:314", "onGlobalClick", "chat-card", "click", ".cp-confirm-explosion", "templateId", "renders on an explosion card, which needs a fired blast weapon", null],
  ["module/combat/damage-hooks.js:314", "onGlobalClick", "chat-card", "click", ".cp-confirm-spread-zone", "templateId", "renders on a spread/pattern card, which needs a fired shotgun or gas round", null],
  ["module/combat/damage-hooks.js:314", "onGlobalClick", "chat-card", "click", ".cp-clear-spread-zone", "templateId", "renders on the same pattern card as its voiding exit", null],
  ["module/combat/damage-hooks.js:314", "onGlobalClick", "combat-tracker", "click", ".cp-take-aim-btn", "", "the tracker paints these per combatant only during a LIVE combat the user controls — the census starts no combat and places no combatants", null],
  ["module/combat/damage-hooks.js:314", "onGlobalClick", "combat-tracker", "click", ".cp-wait-for-turn-btn", "combatantId", "as above, and only on the combatant whose turn is current", null],
  ["module/combat/damage-hooks.js:314", "onGlobalClick", "combat-tracker", "click", ".cp-wait-act-btn", "combatantId", "as above, and only on a combatant already flagged waitingForTurn", null],
  ["module/combat/damage-hooks.js:314", "onGlobalClick", "combat-tracker", "click", ".cp-dodge-btn", "", "as above, and only while the declared-defense feature is on", null],
  ["module/combat/damage-hooks.js:314", "onGlobalClick", "combat-tracker", "click", ".cp-parry-btn", "", "as above, and only while the declared-defense feature is on", null],
  ["module/combat/damage-hooks.js:314", "onGlobalClick", "combat-tracker", "click", ".cp-add-action-btn", "", "as above, and only while multi-action tracking is on", null],
  ["module/combat/damage-hooks.js:314", "onGlobalClick", "combat-tracker", "click", ".cp-manual-tick-btn", "", "as above, and only while manual round-ticking is on", null],
  ["module/combat/damage-hooks.js:314", "onGlobalClick", "chat-card", "click", ".cp-confirm-explosion-scatter", "templateId", "renders on the same explosion card as its second exit", null],
  ["module/combat/damage-hooks.js:314", "onGlobalClick", "chat-card", "click", "[data-message-id]", "", "the card wrapper each of the above resolves through — present only once one of those cards is posted", null],
  ["module/combat/damage-hooks.js:798", "_injectApplyDamageControl", "chat-card", "click", ".cp2020-apply-damage-btn", "", "injected only onto a card carrying an areaDamages payload, for a GM or the attacker's owner", null],
  ["module/vehicle/vehicle-weapons.js:487", "openVehicleFireDialog", "dialog:vehicle-fire", "change", "#cp-vf-gunner", "", null, null],
  ["module/vehicle/vehicle-weapons.js:496", "openVehicleFireDialog", "dialog:vehicle-fire", "change", "#cp-vf-shell", "", null, null],
  ["module/vehicle/vehicle-weapons.js:503", "openVehicleFireDialog", "dialog:vehicle-fire", "change", "#cp-vf-rofmode", "", null, null],
  // ── the cover lifecycle's controls (2026-08-26). All four render on surfaces this census does not
  //    open, so all four are declared GAPS rather than findings — each names the state a fixture would
  //    have to reach. ⛔ The breach controls additionally need a wall SHOT TO ZERO STRUCTURE, which is
  //    a damage-pipeline state, not a render state; `cp2020-augmented-cover-walls.mjs` drives the real
  //    DOM click on both of them and asserts the DOCUMENT outcome, which is where their outcome legs live.
  ["module/combat/cover.js:985", "registerCoverRepairButton", "chat-card", "click", ".cp-cover-repair", "wallUuid", "renders on a cover-DESTRUCTION card and only for a wall that BREACHED — needs a valued wall shot to zero structure; GM-only by render gate", null],
  ["module/combat/cover.js:1050", "openCoverPlacementDialog", "cover-place-dialog", "change", "select[name=\"cp-cover-preset\"]", "", "the Place Cover dialog opens from a GM scene-control button; the census opens no scene controls", null],
  ["module/combat/cover.js:1181", "registerCoverWallConfig", "wall-config", "click", ".cp-cover-wall-clear", "", "renders inside the NATIVE Wall configuration sheet, which the census does not open", null],
  ["module/combat/cover.js:1202", "registerCoverWallConfig", "wall-config", "click", ".cp-cover-wall-repair", "", "same sheet, and only while that wall is currently breached", null],
  ["module/vehicle/vehicle-weapons.js:681", "onGlobalClick", "chat-card", "click", ".cp-vfire-apply", "ap,dmg,facing,gs,hda,heat,hef,pen,range,rg,rounds,weapon", "renders on a vehicle-fire card — needs a mounted weapon fired at a target", null],
  ["module/vehicle/vehicle-control.js:411", "openControlRollDialog", "dialog:vehicle-control", "change", "#cp-ctl-driver", "", null, null],
  ["module/vehicle/vehicle-control.js:412", "openControlRollDialog", "dialog:vehicle-control", "change", "#cp-ctl-skillkey", "", null, null],
  ["module/vehicle/vehicle-control.js:413", "openControlRollDialog", "dialog:vehicle-control", "change", "#cp-ctl-difficulty", "", null, null],
  ["module/vehicle/vehicle-aboard-banner.js:54", "_syncBanner", "character-sheet", "click", ".cp-aboard-out", "", "the fixture is not aboard a vehicle, so no aboard banner is injected", null],
  ["module/vehicle/vehicle-acpa-combat.js:168", "openAcpaMeleeDialog", "dialog:acpa-melee", "change", "#cp-am-skillkind", "", null, null],
  ["module/vehicle/vehicle-acpa-combat.js:170", "openAcpaMeleeDialog", "dialog:acpa-melee", "input", "#cp-am-skill", "", null, null],
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  MANUAL-REVIEW — registration sites whose contract cannot be read off the source mechanically.
//  Recorded rather than guessed: a guessed selector is a green leg that proves nothing.
// ═════════════════════════════════════════════════════════════════════════════════════════════
const MANUAL_REVIEW = [
  ["module/actor/actor-sheet.js:362","_cpActivateStatusStrip","character-sheet","addEventListener(\"toggle\") on `root` — no literal selector at the registration"],
  ["module/actor/actor-sheet.js:643","$","character-sheet","addEventListener(\"dragstart\") on `node` — no literal selector at the registration"],
  ["module/actor/actor-sheet.js:650","$","character-sheet","addEventListener(\"dragend\") on `node` — no literal selector at the registration"],
  ["module/actor/actor-sheet.js:1485","bindHideListeners","character-sheet","addEventListener(\"DYNAMIC\") on `for (const e of HIDE_EVENTS) doc` — no literal selector at the registration"],
  ["module/actor/actor-sheet.js:2639","_activateTabTearOff","character-sheet","addEventListener(\"click\") on `nav` — no literal selector at the registration"],
  ["module/actor/actor-sheet.js:2765","_activateGearDragSort","character-sheet","addEventListener(\"drop\") on `list` — no literal selector at the registration"],
  ["module/actor/actor-sheet.js:3595","_cpSetupNotesAutosave","character-sheet","addEventListener(\"DYNAMIC\") on `root` — no literal selector at the registration"],
  ["module/shop/catalog.js:1042","activateListeners","shop-catalog","selector built from a template literal"],
  ["module/shop/catalog.js:1068","activateListeners","shop-catalog","selector built from a template literal"],
  ["module/shop/catalog.js:1237","_activateFilterPaint","shop-catalog","addEventListener(\"pointerdown\") on `btn` — no literal selector at the registration"],
  ["module/shop/catalog.js:1254","_activateFilterPaint","shop-catalog","addEventListener(\"pointermove\") on `root` — no literal selector at the registration"],
  ["module/shop/catalog.js:1256","_activateFilterPaint","shop-catalog","addEventListener(\"pointerup\") on `btn` — no literal selector at the registration"],
  ["module/shop/catalog.js:1257","_activateFilterPaint","shop-catalog","addEventListener(\"pointercancel\") on `btn` — no literal selector at the registration"],
  ["module/shop/catalog.js:1258","_activateFilterPaint","shop-catalog","addEventListener(\"click\") on `btn` — no literal selector at the registration"],
  ["module/shop/catalog.js:1272","_activateFilterPaint","shop-catalog","addEventListener(\"pointerup\") on `root` — no literal selector at the registration"],
  ["module/shop/catalog.js:1273","_activateFilterPaint","shop-catalog","addEventListener(\"pointercancel\") on `root` — no literal selector at the registration"],
  ["module/shop/catalog.js:1346","_activateEyePaint","shop-catalog","addEventListener(\"pointerup\") on `root` — no literal selector at the registration"],
  ["module/shop/catalog.js:1347","_activateEyePaint","shop-catalog","addEventListener(\"pointercancel\") on `root` — no literal selector at the registration"],
  ["module/item/item-sheet.js:1803","_cpActivateCyberwareSyncControls","item-sheet:cyberware","addEventListener(\"change\") on `root` — no literal selector at the registration"],
  ["module/item/item-sheet.js:2569","_cpSetupNotesAutosave","item-sheet:any","addEventListener(\"DYNAMIC\") on `root` — no literal selector at the registration"],
  ["module/dialog/modifiers.js:592","updateVisibility","dialog:modifiers","addEventListener(\"change\") on `fireModeEl` — no literal selector at the registration"],
  ["module/dialog/modifiers.js:593","updateVisibility","dialog:modifiers","addEventListener(\"change\") on `dualWieldEl` — no literal selector at the registration"],
  ["module/dialog/modifiers.js:595","updateVisibility","dialog:modifiers","addEventListener(\"DYNAMIC\") on `autoRoundsEl` — no literal selector at the registration"],
  ["module/dialog/modifiers.js:597","updateVisibility","dialog:modifiers","addEventListener(\"DYNAMIC\") on `numberInput(name)` — no literal selector at the registration"],
  ["module/vehicle/vehicle-boarding-hud.js:84","_hudButton","token-hud","addEventListener(\"click\") on `btn` — no literal selector at the registration"],
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  OUT OF SCOPE — document/hook/socket registrations. Not DOM control wiring, so nothing here can
//  be a dead control; listed so the swept files are fully accounted for.
// ═════════════════════════════════════════════════════════════════════════════════════════════
const NON_DOM = [
  ["module/actor/actor-sheet.js:2635","doc.addEventListener(\"pointermove\") — gesture continuation","_activateTabTearOff"],
  ["module/actor/actor-sheet.js:2636","doc.addEventListener(\"pointerup\") — gesture continuation","_activateTabTearOff"],
  ["module/actor/actor-sheet.js:2637","doc.addEventListener(\"pointercancel\") — gesture continuation","_activateTabTearOff"],
  ["module/npcgen/npcgen-app.js:698","Hooks.on(\"renderActorDirectory\")","registerGoonCountMemory"],
  ["module/shop/catalog.js:1576","doc.addEventListener(\"click\") — gesture continuation","setTimeout"],
  ["module/shop/catalog.js:2203","Hooks.on(\"renderSidebar\")","registerShopHooks"],
  ["module/shop/catalog.js:2213","Hooks.on(\"controlToken\")","registerShopHooks"],
  ["module/shop/catalog.js:2232","game.socket.on(\"module.cp2020-augmented\")","onChatCardRender"],
  ["module/shop/catalog.js:2239","Hooks.on(\"dropActorSheetData\")","onChatCardRender"],
  ["module/item/item-sheet.js:1060","root.ownerDocument.addEventListener(\"click\") — gesture continuation","_cpActivateVehicleSpeedControls"],
  ["module/item/item-sheet.js:1547","root.ownerDocument.addEventListener(\"click\") — gesture continuation","_cpActivateCyberwareMechanicTypeControls"],
  ["module/item/item-sheet.js:1944","Hooks.on(\"updateItem\")","_cpActivateCyberwareSiblingRefresh"],
  ["module/combat/damage-hooks.js:551","Hooks.on(\"cyberpunk2020.weaponFired\")","_hookWeaponFired"],
  ["module/combat/damage-hooks.js:707","Hooks.on(\"createChatMessage\")","_hookCreateChatMessage"],
  ["module/combat/damage-hooks.js:757","Hooks.on(\"DYNAMIC\")","_hookDamageDialogDismissed"],
  ["module/combat/damage-hooks.js:908","Hooks.on(\"cyberpunk2020.suppressiveFire\")","_hookSuppressiveFire"],
  ["module/combat/damage-hooks.js:1082","Hooks.on(\"DYNAMIC\")","_hookSuppressiveZoneEntered"],
  ["module/combat/damage-hooks.js:1112","Hooks.on(\"updateCombat\")","_hookSuppressiveExpiry"],
  ["module/combat/damage-hooks.js:1288","Hooks.on(\"renderCombatTracker\")","_hookAimTracking"],
  ["module/combat/damage-hooks.js:1318","Hooks.on(\"renderModifiersDialog\")","_hookAimTracking"],
  ["module/combat/damage-hooks.js:1329","Hooks.on(\"cyberpunk2020.weaponFired\")","_hookAimTracking"],
  ["module/combat/damage-hooks.js:1360","Hooks.on(\"renderCombatTracker\")","_hookWaitForTurn"],
  ["module/combat/damage-hooks.js:1397","Hooks.on(\"updateCombat\")","_hookWaitForTurn"],
  ["module/combat/damage-hooks.js:1461","Hooks.on(\"renderCombatTracker\")","_hookDodgeParry"],
  ["module/combat/damage-hooks.js:1505","Hooks.on(\"updateCombat\")","_hookDodgeParry"],
  ["module/combat/damage-hooks.js:1556","Hooks.on(\"renderModifiersDialog\")","_hookDeclaredDefensePrefill"],
  ["module/combat/damage-hooks.js:1616","Hooks.on(\"updateCombat\")","_hookDotEffects"],
  ["module/combat/damage-hooks.js:1825","Hooks.on(\"cyberpunk2020.weaponFired\")","_hookGasCloud"],
  ["module/combat/damage-hooks.js:1947","Hooks.on(\"updateCombat\")","_hookGasCloudPerTurn"],
  ["module/combat/damage-hooks.js:2122","Hooks.on(\"renderCombatTracker\")","_hookManualRoundTick"],
  ["module/combat/damage-hooks.js:2347","Hooks.on(\"cyberpunk2020.weaponFired\")","_hookExplosion"],
  ["module/combat/damage-hooks.js:2651","Hooks.on(\"cyberpunk2020.weaponFired\")","_hookSpread"],
  ["module/combat/damage-hooks.js:3521","Hooks.on(\"updateCombat\")","_hookSpreadZoneExpiry"],
  ["module/combat/damage-hooks.js:3532","Hooks.on(\"DYNAMIC\")","_hookSpreadZoneExpiry"],
  ["module/combat/damage-hooks.js:3551","Hooks.on(\"canvasReady\")","_hookSpreadZoneExpiry"],
  ["module/combat/damage-hooks.js:3631","Hooks.on(\"renderCombatTracker\")","_hookMultiActionPenalty"],
  ["module/combat/damage-hooks.js:3679","Hooks.on(\"renderModifiersDialog\")","_hookMultiActionPenalty"],
  ["module/combat/damage-hooks.js:3692","Hooks.on(\"cyberpunk2020.weaponFired\")","_hookMultiActionPenalty"],
  ["module/combat/damage-hooks.js:3719","Hooks.on(\"updateCombat\")","_incrementActionCount"],
  ["module/combat/damage-hooks.js:3726","Hooks.on(\"combatStart\")","_incrementActionCount"],
  ["module/combat/damage-hooks.js:3790","Hooks.on(\"updateActor\")","_hookLiveSheetUpdate"],
  ["module/combat/damage-hooks.js:3794","Hooks.on(\"updateItem\")","_hookLiveSheetUpdate"],
  ["module/combat/damage-hooks.js:3821","game.socket.on(\"module.cp2020-augmented\")","_hookSocketRelay"],
  ["module/vehicle/vehicle-weapons.js:523","Hooks.on(\"updateToken\")","openVehicleFireDialog"],
  ["module/vehicle/vehicle-boarding-hud.js:89","Hooks.on(\"renderTokenHUD\")","registerVehicleBoardingHud"],
  ["module/vehicle/vehicle-aboard-banner.js:68","Hooks.on(\"renderActorSheetV2\")","registerVehicleAboardBanner"],
  ["module/vehicle/vehicle-aboard-banner.js:74","Hooks.on(\"updateToken\")","_syncBanner"],
  ["module/vehicle/vehicle-acpa-combat.js:250","Hooks.on(\"updateCombat\")","wrapAcpaRollData"],
  ["module/vehicle/vehicle-acpa-combat.js:257","Hooks.on(\"updateActor\")","wrapAcpaRollData"],
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SOURCE EXTRACTION — the same derivation that produced the manifest, run again at suite time.
//  Leg B compares its output to the table above; that comparison is what stops an uncensused
//  control from shipping.
//
//  Three grammars produce a censused row. The first reads a control off a TEMPLATE-PAINTED node the
//  handler goes looking for; the other two exist because a whole family of the module's controls is
//  never painted by a template at all:
//
//   1 QUERIED BIND     `root.querySelector(".x").addEventListener(…)`, the `for (const x of
//                      root.querySelectorAll(".y"))` loop, the `.forEach(btn => …)` form, and the
//                      in-handler `ev.target.closest(".z")` lookup. The selector is a literal at or
//                      near the registration.
//
//   2 CREATED CONTROL  a button the module BUILDS: `const btn = document.createElement("button")`,
//                      given a LITERAL class in the same construct (`btn.className = "…"` or
//                      `btn.classList.add("…")`), then bound with `btn.addEventListener(…)`. No
//                      template paints it, so grammar 1 sees nothing and the site landed in
//                      manual-review — which is how the Actors-directory Goon Factory button and the
//                      chat card's Apply-Damage button went uncensused for their whole lives.
//                      The class literal IS the selector: `.cp2020ae-npcgen-btn`.
//                      Deliberate limits, so nothing here is a guess:
//                        · only the FIRST class-setting call on the variable counts. A later
//                          `classList.add("cp-active")` is STATE, not identity, and folding it in
//                          would census a selector the control only sometimes matches.
//                        · a multi-class literal becomes a compound selector in source order
//                          (`"ui-control plain … cp-shop-tab"` → `.ui-control.plain.….cp-shop-tab`).
//                          A subset of a node's classes can over-match but can never under-match.
//                        · a class built from a template literal (`\`control-icon ${cls}\``) or from
//                          any expression yields NOTHING and the site stays in manual-review. The
//                          token-HUD boarding button is exactly that shape and stays there.
//
//   3 DELEGATOR CALL   `onGlobalClick(handler)` (module/popout-compat.js) is a click registration
//                      like any other — it binds the handler to the main `document` and to every
//                      PopOut! window. It carries no `.addEventListener` at the call site, so the
//                      site scan never saw it, and every control it serves was invisible: the whole
//                      combat-tracker button row (Take Aim, Wait, Act Now, Dodge, Parry, +Action,
//                      manual tick) plus the explosion/spread/suppression chat-card buttons. Read as
//                      an event="click" registration on `document`, its body's
//                      `ev.target.closest(".x")` lookups become controls through grammar 1's
//                      machinery, and `readsIn` derives their `data-*` contract as usual.
//                      Deliberate limit: `readsIn` reads the HANDLER BODY only. A control whose
//                      dataset is read inside a helper it is PASSED to (`_combatantControlActor(btn)`)
//                      derives an empty `reads` — the control is censused, its data contract is not.
// ═════════════════════════════════════════════════════════════════════════════════════════════
const SELRE = `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
const unq = (s) => (s == null ? s : s.replace(/^["']|["']$/g, ""));

/** Same-length copy with comment bytes blanked, so a walk-back or a structural regex cannot wander
 *  into prose. String literals stay intact — the selectors live in them. */
function blankComments(src) {
  const a = src.split(""); let inS = null, esc = false;
  for (let i = 0; i < a.length; i++) {
    const c = a[i];
    if (inS) { if (esc) { esc = false; continue; } if (c === "\\") { esc = true; continue; } if (c === inS) inS = null; continue; }
    if (c === '"' || c === "'" || c === "`") { inS = c; continue; }
    if (c === "/" && a[i + 1] === "/") { while (i < a.length && a[i] !== "\n") a[i++] = " "; continue; }
    if (c === "/" && a[i + 1] === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? a.length : e + 2; for (; i < end; i++) if (a[i] !== "\n") a[i] = " "; i--; continue; }
  }
  return a.join("");
}
function callSlice(src, open) {
  let d = 0, i = open, inS = null, esc = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inS) { if (esc) { esc = false; continue; } if (c === "\\") { esc = true; continue; } if (c === inS) inS = null; continue; }
    if (c === '"' || c === "'" || c === "`") { inS = c; continue; }
    if (c === "(") d++; else if (c === ")") { d--; if (d === 0) return [open, i + 1]; }
  }
  return [open, src.length];
}
/** Walk left from the '.' of `.addEventListener` to the head of the receiver expression, so
 *  `root.querySelector(".x")?.addEventListener(…)` yields its own bind selector. */
function receiverStart(src, dot) {
  let i = dot - 1;
  for (;;) {
    while (i >= 0 && /\s/.test(src[i])) i--;
    if (i < 0) break;
    const c = src[i];
    if (c === ")" || c === "]") {
      const open = c === ")" ? "(" : "["; let d = 0;
      for (; i >= 0; i--) { if (src[i] === c) d++; else if (src[i] === open) { d--; if (!d) break; } }
      i--; continue;
    }
    if (/[\w$]/.test(c)) { while (i >= 0 && /[\w$]/.test(src[i])) i--; continue; }
    if (c === "?" || c === ".") { i--; continue; }
    break;
  }
  return i + 1;
}
/** Extent of the construct a loop/callback variable belongs to, so a bind variable cannot leak
 *  past its own loop and lend its selector to an unrelated registration further down the file. */
function blockAfter(src, from) {
  const b = src.indexOf("{", from), p = src.indexOf(";", from);
  if (b < 0 || (p >= 0 && p < b)) return p < 0 ? from : p;
  let d = 0;
  for (let i = b; i < src.length; i++) { const c = src[i]; if (c === "{") d++; else if (c === "}") { d--; if (!d) return i; } }
  return src.length;
}
/** End of the block a statement sits INSIDE — the first `}` that closes further out than the
 *  statement does. A created element's class literal and its bind must both live in here, or the
 *  two belong to different constructs and pairing them would be a guess. */
function enclosingEnd(src, from) {
  let d = 0, inS = null, esc = false;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (inS) { if (esc) { esc = false; continue; } if (c === "\\") { esc = true; continue; } if (c === inS) inS = null; continue; }
    if (c === '"' || c === "'" || c === "`") { inS = c; continue; }
    if (c === "{") d++;
    else if (c === "}") { if (!d) return i; d--; }
  }
  return src.length;
}
/** The class literal a created element is given, as a selector. `null` when the class is not a
 *  plain string literal — the control then stays in manual-review rather than being guessed at. */
function createdClassSelector(src, v, from, end) {
  const q = v.replace(/[.$?[\]()]/g, "\\$&");
  const win = src.slice(from, end);
  const m = win.match(new RegExp(`${q}\\s*\\.\\s*(?:className\\s*=\\s*${SELRE}|classList\\s*\\.\\s*add\\s*\\(([^)]*)\\))`));
  if (!m) return null;
  const lits = m[1] ? [unq(m[1])] : [...(m[2] ?? "").matchAll(new RegExp(SELRE, "g"))].map(x => unq(x[1]));
  const classes = lits.join(" ").split(/\s+/).filter(Boolean);
  if (!classes.length) return null;
  return "." + classes.join(".");
}
const NONDOM_RECV = /^(Hooks|game\.socket|socket|window|canvas)$/;
const GESTURE_RECV = /^(doc|document|root\.ownerDocument)$/;

/** Surface for a (file, enclosing method) pair. Hand-authored: only a person knows that the shop
 *  window's build controls and its catalog controls are different rendered views of one class. */
function surfaceOf(rel, fn, sel = "") {
  // `activateListeners` wires every view of the shop window from one method, so the method alone
  // cannot say which view a control belongs to — the selector can.
  if (rel === "module/shop/catalog.js" && fn === "activateListeners") {
    if (/\.cp-home-/.test(sel)) return "shop-home";
    if (/\.cp-shop-manage/.test(sel)) return "shop-storefront";
  }
  // One global click delegator serves two completely different surfaces — the combat tracker's
  // per-combatant button row and the chat log's cards — from one registration, so the enclosing
  // method cannot say which. The selector can: these seven classes are built into a tracker row.
  if (rel === "module/combat/damage-hooks.js") {
    return /^\.cp-(take-aim|wait-for-turn|wait-act|dodge|parry|add-action|manual-tick)-btn$/.test(sel)
      ? "combat-tracker" : "chat-card";
  }
  switch (rel) {
    case "module/actor/actor-sheet.js": return "character-sheet";
    case "module/vehicle/vehicle-aboard-banner.js": return "character-sheet";
    case "module/actor/vehicle-sheet.js": return "vehicle-sheet";
    case "module/actor/actor-tab-popout.js": return "actor-tab-popout";
    // The Goon Factory is two things: a window, and the Actors-directory button that opens it.
    case "module/npcgen/npcgen-app.js":
      return /^(registerGoonCountMemory|injectNpcGenButton|registerNpcGenHooks)$/.test(fn) ? "actor-directory" : "goon-factory";
    // One window class paints four distinct views; a control that lives in the home directory is
    // not "on the shop window", it is on the HOME view, and censusing it against the catalog view
    // would report the whole directory as dead.
    case "module/shop/catalog.js": return {
      _wireShopCardControls: "chat-card", onChatCardRender: "chat-card",
      injectSidebarShopButton: "sidebar", registerShopHooks: "non-dom",
      _openContextMenu: "shop-contextmenu", setTimeout: "shop-contextmenu",
      _activateBuildControls: "shop-build", _activateSetupMode: "shop-build",
    }[fn] ?? "shop-catalog";
    case "module/shop/services.js": case "module/shop/buy-ammo.js": case "module/shop/setup-mode.js":
      return "shop-catalog";
    case "module/item/item-sheet.js":
      if (/Cyberware/.test(fn)) return "item-sheet:cyberware";
      if (/Ammo/.test(fn)) return "item-sheet:ammo";
      if (/VehicleWeaponShell/.test(fn)) return "item-sheet:vehicleweapon";
      if (/Vehicle(Deploy|Speed)/.test(fn)) return "item-sheet:vehicle";
      if (/SkillItem/.test(fn)) return "item-sheet:skill";
      if (/MechConsumable/.test(fn)) return "item-sheet:consumable";
      return "item-sheet:any";
    case "module/item/augmented-item-sheet.js": return "item-sheet:vehicleweapon";
    case "module/ip/tracker.js": return fn === "_manualAdd" ? "dialog:ip-manual" : "ip-tracker";
    case "module/dialog/modifiers.js": return "dialog:modifiers";
    case "module/dialog/automation-notice.js": return "dialog:automation-notice";
    case "module/dialog/preset-picker.js": return "dialog:preset-picker";
    case "module/dialog/ip-neglect.js": return "dialog:ip-neglect";
    case "module/dialog/buy-ammo.js": return "dialog:buy-ammo";
    case "module/combat/DamageDialog.js": return "dialog:damage";
    // The fire dialog's own fields, except the delegator that answers its chat card's apply button
    // — one file, two surfaces, told apart by the selector for the same reason the shop's are.
    case "module/vehicle/vehicle-weapons.js":
      return /^\.cp-vfire-/.test(sel) ? "chat-card" : "dialog:vehicle-fire";
    case "module/vehicle/vehicle-control.js": return "dialog:vehicle-control";
    case "module/vehicle/vehicle-boarding-hud.js": return "token-hud";
    case "module/vehicle/vehicle-acpa-combat.js": return "dialog:acpa-melee";
    default: return "unknown";
  }
}

/** Derive every control's wiring contract from one source file. */
function extractFile(rel) {
  const raw = fs.readFileSync(path.join(REPO, rel), "utf8");
  const src = blankComments(raw);
  const lines = raw.split("\n");
  const lineOf = (i) => src.slice(0, i).split("\n").length;
  const fnAt = (line) => {
    for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
      const m = lines[i].match(/^\s{0,4}(?:export\s+)?(?:static\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*\(/);
      if (m && !/^(if|for|while|switch|catch|return|await)$/.test(m[1])) return m[1];
    }
    return "?";
  };

  // Bind-variable definitions, each scoped to the construct that introduces it.
  const defs = []; let m;
  const p0 = new RegExp(`for\\s*\\(\\s*(?:const|let)\\s+([\\w$]+)\\s+of\\s+[^;)]*?\\.(?:querySelectorAll|querySelector)\\s*\\??\\.?\\s*\\(\\s*${SELRE}\\s*\\)`, "g");
  while ((m = p0.exec(src))) defs.push({ v: m[1], sel: unq(m[2]), at: m.index, end: blockAfter(src, m.index + m[0].length) });
  const p1 = new RegExp(`\\.(?:querySelectorAll|querySelector)\\s*\\??\\.?\\s*\\(\\s*${SELRE}\\s*\\)[^;]{0,60}?\\.forEach\\s*\\(\\s*\\(?\\s*([\\w$]+)`, "g");
  while ((m = p1.exec(src))) { const o = src.indexOf("(", m.index + m[0].indexOf(".forEach")); defs.push({ v: unq(m[2]), sel: unq(m[1]), at: m.index, end: callSlice(src, o)[1] }); }
  const p2 = new RegExp(`(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*[^;\\n]*?\\.(?:querySelector|querySelectorAll|closest)\\s*\\??\\.?\\s*\\(\\s*${SELRE}\\s*\\)`, "g");
  while ((m = p2.exec(src))) defs.push({ v: m[1], sel: unq(m[2]), at: m.index, end: m.index + 1500 });
  // GRAMMAR 2 — created controls. The element is built, classed and bound inside one construct, so
  // the construct is the scope: a `btn` two functions down cannot borrow this one's class.
  const p3 = /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$]+\s*\.\s*)*createElement\s*\(/g;
  while ((m = p3.exec(src))) {
    const end = enclosingEnd(src, m.index + m[0].length);
    const sel = createdClassSelector(src, m[1], m.index, end);
    if (sel) defs.push({ v: m[1], sel, at: m.index, end });
  }

  // Registration sites.
  const sites = [];
  // GRAMMAR 3 — `onGlobalClick(fn)` is the module's own click delegator (popout-compat.js): a
  // `document.addEventListener("click", fn)` that also reaches PopOut! windows. Counted as a
  // registration site, or every control it serves is invisible to the census.
  const re = /\.(addEventListener|on)\s*\(|\bonGlobalClick\s*\(/g;
  while ((m = re.exec(src))) {
    const delegator = m[1] === undefined;
    const dot = m.index, open = m.index + m[0].length - 1;
    const [s, e] = callSlice(src, open), rs = delegator ? m.index : receiverStart(src, dot);
    sites.push({ kind: delegator ? "delegator" : m[1], line: lineOf(rs), s, e, body: src.slice(s, e),
      recv: delegator ? "document" : src.slice(rs, dot).replace(/\s+/g, " ").trim().replace(/\?$/, "") });
  }

  const entries = [], manual = [], nondom = [];
  const seen = new Set();
  for (const site of sites) {
    const inner = sites.filter(o => o !== site && o.s > site.s && o.e <= site.e);
    const cov = (i) => inner.some(o => site.s + i >= o.s && site.s + i < o.e);
    let b = site.body;
    // `root.addEventListener("change", addHandler, true)` — the contract lives in the named
    // function, not at the registration. Splice its body in so the scan below can see it.
    const named = b.match(/^\(\s*(?:"[^"]*"|'[^']*')\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/);
    if (named) {
      // NEAREST definition before the registration, never the file's first — handler names like
      // `handler` / `onChange` repeat across methods, and taking the first splices a completely
      // unrelated method's selectors into this control's contract.
      const dre = new RegExp(`(?:const|let|var|function)\\s+${named[1]}\\s*[=(]`, "g");
      let dIdx = -1, dm;
      while ((dm = dre.exec(src))) { if (dm.index > site.s) break; dIdx = dm.index; }
      if (dIdx >= 0) {
        const o = src.indexOf("{", src.indexOf(named[1], dIdx) + named[1].length);
        if (o >= 0) {
          let d = 0, i = o;
          for (; i < src.length; i++) { const c = src[i]; if (c === "{") d++; else if (c === "}") { d--; if (!d) break; } }
          b += "\n" + src.slice(o, i);
        }
      }
    }
    const at = `${rel}:${site.line}`, fn = fnAt(site.line);
    // The delegator takes the handler as its FIRST argument, so there is no event literal to read:
    // the call itself names the event.
    const event = site.kind === "delegator"
      ? "click"
      : unq((b.match(new RegExp(`^\\(\\s*${SELRE}`)) || [])[1]) || "DYNAMIC";
    if (site.kind === "on" && NONDOM_RECV.test(site.recv)) { nondom.push([at, `${site.recv}.on("${event}")`, fn]); continue; }
    // A delegator's receiver IS the document — deliberately, so the controls it serves survive a
    // PopOut!. That is the opposite of a gesture-continuation listener and must not be filed as one.
    if (site.kind !== "delegator" && GESTURE_RECV.test(site.recv)) { nondom.push([at, `${site.recv}.addEventListener("${event}") — gesture continuation`, fn]); continue; }

    const readsIn = (v, text) => {
      const rd = new Set(); const q = v.replace(/[.$?[\]()]/g, "\\$&"); let x;
      const r1 = new RegExp(`${q}\\??\\.dataset\\??\\.(\\w+)`, "g");
      while ((x = r1.exec(text))) if (!cov(x.index)) rd.add(x[1]);
      const r2 = new RegExp(`${q}\\??\\.getAttribute\\s*\\(\\s*["']data-([^"']+)`, "g");
      while ((x = r2.exec(text))) if (!cov(x.index)) rd.add(x[1].replace(/-(\w)/g, (_, c) => c.toUpperCase()));
      return [...rd];
    };
    let bindSel = null;
    const inRecv = [...site.recv.matchAll(new RegExp(`\\.(?:querySelector|querySelectorAll|find|closest)\\s*\\??\\.?\\s*\\(\\s*${SELRE}\\s*\\)`, "g"))].pop();
    if (inRecv) bindSel = unq(inRecv[1]);
    else { const d = defs.filter(d => d.v === site.recv && d.at < site.s && site.s < d.end).pop(); if (d) bindSel = d.sel; }
    const delegated = site.kind === "on" ? unq((b.match(new RegExp(`^\\(\\s*${SELRE}\\s*,\\s*${SELRE}\\s*,`)) || [])[2]) : null;
    const bindReads = new Set();
    for (const v of ["ev.currentTarget", "event.currentTarget", "e.currentTarget", site.recv])
      for (const r of readsIn(v, b)) bindReads.add(r);

    const controls = [];
    const asg = new RegExp(`(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*[^;\\n]*?\\.(?:closest|querySelector|querySelectorAll)\\s*\\??\\.?\\s*\\(\\s*${SELRE}\\s*\\)`, "g");
    let k;
    while ((k = asg.exec(b))) { if (!cov(k.index)) controls.push({ v: k[1], sel: unq(k[2]) }); }
    for (const c of controls) c.reads = readsIn(c.v, b);
    const inl = new RegExp(`\\.(?:closest|matches)\\s*\\??\\.?\\s*\\(\\s*${SELRE}\\s*\\)`, "g");
    while ((k = inl.exec(b))) {
      if (cov(k.index)) continue;
      if (/(?:const|let|var)\s+[\w$]+\s*=\s*[^;\n]*$/.test(b.slice(Math.max(0, k.index - 120), k.index))) continue;
      controls.push({ v: null, sel: unq(k[1]), reads: [] });
    }
    const tgtReads = new Set();
    for (const v of ["event.target", "ev.target", "e.target"]) for (const r of readsIn(v, b)) tgtReads.add(r);

    const add = (sel, reads) => {
      if (!sel) return false;
      const key = `${rel}|${event}|${sel}`;
      if (seen.has(key)) return true;
      seen.add(key);
      entries.push([at, fn, surfaceOf(rel, fn, sel), event, sel, [...new Set(reads)].sort().join(","), null, null]);
      return true;
    };
    let placed = false;
    if (bindSel) placed = add(bindSel, [...bindReads]) || placed;
    if (delegated) placed = add(delegated, [...bindReads]) || placed;
    for (const c of controls) placed = add(c.sel, [...c.reads, ...(bindSel || delegated ? [] : tgtReads)]) || placed;
    if (!placed) manual.push([at, fn, surfaceOf(rel, fn), `${site.kind}("${event}") on \`${site.recv}\` — no literal selector at the registration`]);
    const dre = /\.(?:closest|matches|querySelector|querySelectorAll)\s*\??\.?\s*\(\s*`[^`]*\$\{/g;
    while ((k = dre.exec(b))) if (!cov(k.index)) manual.push([at, fn, surfaceOf(rel, fn), "selector built from a template literal"]);
  }

  // ApplicationV2 `actions` maps bind `[data-action="key"]` — a wiring contract with no
  // addEventListener anywhere, and exactly as capable of pointing at nothing.
  const am = src.match(/\n\s*actions\s*:\s*\{\n([\s\S]*?)\n\s*\},/);
  if (am) {
    for (const [, key, ref] of am[1].matchAll(/([\w$]+)\s*:\s*([\w$.]+)\s*,/g)) {
      const fnName = ref.split(".").pop();
      const hIdx = src.search(new RegExp(`static\\s+(?:async\\s+)?${fnName}\\s*\\(`));
      const reads = new Set(); let hLine = null;
      if (hIdx >= 0) {
        hLine = lineOf(hIdx);
        const o = src.indexOf("{", src.indexOf("(", hIdx));
        let d = 0, i = o;
        for (; i < src.length; i++) { const c = src[i]; if (c === "{") d++; else if (c === "}") { d--; if (!d) break; } }
        const body = src.slice(o, i);
        const argM = src.slice(hIdx, o).match(/\(\s*([\w$]+)\s*,\s*([\w$]+)\s*\)/);
        const tv = argM ? argM[2] : "target";
        let x;
        const r1 = new RegExp(`\\b${tv}\\??\\.dataset\\??\\.(\\w+)`, "g");
        while ((x = r1.exec(body))) reads.add(x[1]);
        const r4 = new RegExp(`(?:const|let)\\s+([\\w$]+)\\s*=\\s*${tv}\\??\\.closest\\s*\\??\\.?\\s*\\(\\s*${SELRE}\\s*\\)`, "g");
        while ((x = r4.exec(body))) {
          const rr = new RegExp(`\\b${x[1]}\\??\\.dataset\\??\\.(\\w+)`, "g");
          let y; while ((y = rr.exec(body))) reads.add(y[1]);
        }
      }
      const at = `${rel}:${hLine ?? "?"}`, fn = hLine ? fnAt(hLine) : fnName;
      const sel = `[data-action="${key}"]`;
      const dedupe = `${rel}|click|${sel}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      entries.push([at, fn, surfaceOf(rel, fn), "click", sel, [...reads].sort().join(","), null, null]);
    }
  }
  return { entries, manual, nondom };
}

function extractAll() {
  const entries = [], manual = [], nondom = [];
  for (const rel of SWEPT) {
    const r = extractFile(rel);
    entries.push(...r.entries); manual.push(...r.manual); nondom.push(...r.nondom);
  }
  return { entries, manual, nondom };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  MARKUP CORPUS — every place a control can be painted from: the module's and the base system's
//  Handlebars templates, plus the JS lines that build markup by hand (a string carrying both the
//  token and a `<`). This is what separates the two reasons a selector matched nothing:
//
//    the token exists in markup somewhere  → the fixture did not reach the state that paints it
//    the token exists NOWHERE in markup    → nothing can ever paint it. ORPHANED HANDLER.
//
//  The second is a finding no amount of fixture enrichment will clear, and it is decidable
//  mechanically — which is the point. A binding site is not evidence: the module and the base
//  system both bind `.item-roll`, and neither renders it.
// ═════════════════════════════════════════════════════════════════════════════════════════════
const SYSTEM_ROOT = process.env.FVTT_SYSTEM_ROOT
  || path.resolve(REPO, "..", "..", "systems", "cyberpunk2020");

function readCorpus() {
  const parts = [];
  const walk = (dir, keep) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/node_modules|\.git|packs/.test(e.name)) walk(f, keep); continue; }
      if (!keep.test(e.name)) continue;
      const txt = fs.readFileSync(f, "utf8");
      if (e.name.endsWith(".hbs")) { parts.push(txt); continue; }
      // A JS line only counts as markup if it is actually building some.
      for (const line of txt.split("\n")) if (line.includes("<")) parts.push(line);
    }
  };
  for (const base of [REPO, SYSTEM_ROOT]) {
    walk(path.join(base, "templates"), /\.hbs$/);
    walk(path.join(base, "module"), /\.js$/);
  }
  return parts.join("\n");
}
const CORPUS = readCorpus();

/** Every token a selector needs the markup to carry. */
function tokensOf(alt) {
  const t = [];
  for (const m of alt.matchAll(/\.([A-Za-z_][\w-]*)/g)) t.push({ kind: "class", v: m[1] });
  for (const m of alt.matchAll(/\[([\w-]+)\s*(?:([~^$*|]?)=\s*["']?([^\]"']*)["']?)?\]/g))
    t.push({ kind: "attr", name: m[1], op: m[2] ?? "", v: m[3] ?? null });
  return t;
}
/** Can this selector be painted by anything in the corpus? Comma alternatives are OR'd. */
function inMarkup(sel) {
  for (const alt of sel.split(",").map(s => s.trim()).filter(Boolean)) {
    const toks = tokensOf(alt);
    if (!toks.length) continue;                       // bare tag selector — presence is meaningless
    const ok = toks.every(t => {
      if (t.kind === "class") return new RegExp(`[\\s"'\`{]${t.v}[\\s"'\`}]|["'\`]${t.v}["'\`]`).test(CORPUS) || CORPUS.includes(t.v);
      if (t.v === null || t.v === "") return CORPUS.includes(t.name);
      // `[name^="system.sdp.current."]` is satisfied by any name that starts with the prefix.
      return CORPUS.includes(t.v);
    });
    if (ok) return true;
  }
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SURFACES — how each rendered surface is opened on the rig. A surface with no opener here is
//  simply NOT-EXERCISED; that is the gap list, and adding an opener is how it shrinks.
// ═════════════════════════════════════════════════════════════════════════════════════════════
const RENDERED = [
  "character-sheet", "vehicle-sheet", "goon-factory", "actor-directory", "ip-tracker",
  "shop-home", "shop-catalog", "shop-build", "shop-storefront",
  "item-sheet:any", "item-sheet:skill", "item-sheet:cyberware", "item-sheet:ammo",
  "item-sheet:vehicleweapon", "item-sheet:consumable", "item-sheet:vehicle",
];

/** User impact of each recorded orphan, so the findings list is ranked by what it costs a table
 *  rather than by file order. 3 = a feature the user can reach is inert; 2 = a feature is
 *  unreachable but nothing looks broken; 1 = dead code behind a deliberate removal. */
const ORPHAN_IMPACT = {
  "select.cw-add-mountpolicy": [2, "The cyberware mount-policy editor is fully implemented behind the sheet — read, write and remove all exist — and no markup exposes any of it. A shipped feature nobody can reach."],
  ".cw-remove-mount": [2, "The remove half of the same unreachable mount-policy editor."],
  ".item-roll": [1, "Dead in the BASE SYSTEM too — Tilt's sheets bind it and his templates do not paint it either. A mirrored handler, not a module-introduced defect; harmless, but it is the shape the census exists to find."],
  ".cp-open-shop": [1, "Deliberate: the control was moved to the sidebar Shop tab and the template records the decision, keeping the handler as a documented no-op."],
};

const P = [];
const chk = (name, ok, detail = "") => { P.push({ name, ok: !!ok, detail: String(detail) }); return !!ok; };

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  LEG A — serve parity
// ═════════════════════════════════════════════════════════════════════════════════════════════
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const staleServe = [];
for (const rel of SWEPT) {
  const a = path.join(REPO, rel), c = path.join(SERVE, rel);
  if (!fs.existsSync(c)) { staleServe.push(rel + " (absent from the serve copy)"); continue; }
  if (sha(a) !== sha(c)) staleServe.push(rel + " (bytes differ)");
}
chk(`serve parity — all ${SWEPT.length} swept files byte-identical repo↔serve`, staleServe.length === 0, staleServe.join("; "));

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  LEG B — staleness guard
// ═════════════════════════════════════════════════════════════════════════════════════════════
const derived = extractAll();
const keyOf = (e) => `${e[0].split(":")[0]}|${e[3]}|${e[4]}`;   // file | event | selector — line-independent
const manByKey = new Map(MANIFEST.map(e => [keyOf(e), e]));
const derByKey = new Map(derived.entries.map(e => [keyOf(e), e]));
const uncensused = derived.entries.filter(e => !manByKey.has(keyOf(e)));
const vanished = MANIFEST.filter(e => !derByKey.has(keyOf(e)));
const readDrift = [];
for (const [k, d] of derByKey) {
  const mrow = manByKey.get(k);
  if (mrow && mrow[5] !== d[5]) readDrift.push(`${d[0]} ${d[4]} — manifest reads [${mrow[5]}] vs source [${d[5]}]`);
}
const lineDrift = [];
for (const [k, d] of derByKey) { const mrow = manByKey.get(k); if (mrow && mrow[0] !== d[0]) lineDrift.push(`${mrow[0]} → ${d[0]}`); }

chk(`staleness guard — no uncensused control (${derived.entries.length} derived from source)`,
  uncensused.length === 0,
  uncensused.slice(0, 12).map(e => `${e[0]} ${e[3]} ${e[4]}`).join(" | "));
chk("staleness guard — no manifest row without a source registration", vanished.length === 0,
  vanished.slice(0, 12).map(e => `${e[0]} ${e[3]} ${e[4]}`).join(" | "));
chk("staleness guard — the data-* contract each handler reads is unchanged", readDrift.length === 0,
  readDrift.slice(0, 8).join(" | "));
if (lineDrift.length) console.log(`  note: ${lineDrift.length} manifest row(s) carry a drifted line number (informational; --refresh updates them)`);

if (REFRESH) {
  writeManifest(derived);
  console.log(`\n--refresh: MANIFEST rewritten from source (${derived.entries.length} rows, ${derived.manual.length} manual-review, ${derived.nondom.length} out-of-scope).`);
  console.log("Declared gates are carried over by key; every ADDED row still needs a surface check and a gate decision.");
  console.log("Re-run without --refresh to take the census.\n");
  process.exit(0);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  LEG C — the rendered check
// ═════════════════════════════════════════════════════════════════════════════════════════════
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1800, height: 1100 } });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

async function joinGM(pg) {
  await pg.goto(BASE + "/join", { waitUntil: "domcontentloaded" });
  const s = pg.locator('select[name="userid"]');
  await s.waitFor({ state: "visible", timeout: 30000 });
  const us = await s.locator("option").evaluateAll(o => o.map(x => ({ v: x.value, l: (x.textContent || "").trim() })).filter(x => x.v));
  const g = us.find(u => /gamemaster/i.test(u.l));
  await s.selectOption(g.v);
  await pg.locator('input[name="password"]').fill(PW);
  await Promise.all([pg.waitForNavigation({ url: /\/game/, timeout: 45000 }).catch(() => {}), pg.locator('button[name="join"]').click()]);
  await pg.waitForFunction(() => window.game?.ready === true, undefined, { timeout: 60000 });
}
await joinGM(p);

let census = null;
try {
  census = await p.evaluate(async ({ manifest, rendered }) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const rootOf = (app) => (app?.element instanceof HTMLElement ? app.element : app?.element?.[0] ?? null);
    const out = { surfaces: {}, results: [], notes: [], fixtureErr: null };
    const made = { actors: [], shopIds: [], apps: [] };
    let shopWas = null, ipWas = null, pcId = null;   // ⏪ npcWas retired with npcGenEnabled 2026-08-28

    try {
      // ── FIXTURES ───────────────────────────────────────────────────────────────────────────
      // Deliberately loaded, per the fixture-diversity rule: a bare actor renders almost no rows,
      // and an empty sheet would report every conditional control as dead.
      for (const a of game.actors.filter(a => a.name.startsWith("__PW__CENSUS"))) await a.delete().catch(() => {});

      const pc = await Actor.create({ name: "__PW__CENSUS Punk", type: "character" });
      made.actors.push(pc); pcId = pc.id;
      await pc.update({
        "system.stats.int.base": 8, "system.stats.ref.base": 8, "system.stats.body.base": 8,
        "system.stats.emp.base": 7, "system.stats.tech.base": 6, "system.stats.cool.base": 7,
        "system.wealth.money": 25000,
      });

      const mkItems = async (defs) => {
        const out = [];
        for (const d of defs) { const [x] = await pc.createEmbeddedDocuments("Item", [d]); out.push(x); }
        return out;
      };
      // A weapon (equipped, so the fire row paints), armor WORN and UNWORN (the negative case next
      // to the positive), a plain implant, an ACTIVATABLE implant (the ⚡ body-map switch), an
      // ACTIVE CHIP (Type "Chip" + enabled + ChipActive — all three, or the chip strip is empty),
      // ammo, a program, and a consumable/drug (both mechanic blocks switched on, since each gates
      // its own button).
      const [wpn, armorOn, armorOff, cyber, cyberOn, chip, ammo, prog, drug] = await mkItems([
        { name: "__PW__CENSUS Pistol", type: "weapon", system: { equipped: true, weaponType: "P", attackType: "Pistol", damage: "2d6", rof: 2, shotsMax: 12, shots: 12 } },
        { name: "__PW__CENSUS Vest", type: "armor", system: { equipped: true, sp: 14, ev: 1, coverage: { torso: true } } },
        { name: "__PW__CENSUS Spare Vest", type: "armor", system: { equipped: false, sp: 10, ev: 1 } },
        { name: "__PW__CENSUS Implant", type: "cyberware", system: { equipped: true, humanityCost: "2", cwIsEnabled: true } },
        { name: "__PW__CENSUS Booster", type: "cyberware", system: { equipped: true, humanityCost: "2", cwIsEnabled: true, EffectMode: "Activatable", EffectActive: true } },
        { name: "__PW__CENSUS Chip", type: "cyberware", system: { equipped: true, cwIsEnabled: true, CyberWorkType: { Type: "Chip", Types: ["Chip"], ChipActive: true } } },
        { name: "__PW__CENSUS Rounds", type: "ammo", system: { caliber: "9mm", amount: 50 } },
        { name: "__PW__CENSUS Program", type: "program", system: {} },
        { name: "__PW__CENSUS Stim", type: "misc", system: { equipped: false,
            mechConsumable: { enabled: true, doses: 3, durationTurns: "1d6" },
            mechDrug: { enabled: true, durationTurns: "1d6", addictionDifficulty: 15 } } },
      ]);
      // A martial-art skill and a chipped skill — the row-level controls key off both.
      const martial = pc.items.find(i => i.type === "skill" && /Martial Arts/i.test(i.name));
      if (martial) await martial.update({ "system.level": 4 });
      const anySkill = pc.items.find(i => i.type === "skill" && i.name !== martial?.name);
      // A skill carrying MORE banked IP than its next level costs — the only state in which the
      // level-up arrow renders at all, and the exact control whose `data-skill-id` shipped empty
      // for the module's whole life. Banked IP is a FLAG, not a system field: writing
      // `system.ipPoints` funds nothing and leaves the arrow unpainted.
      if (anySkill) {
        await anySkill.update({ "system.level": 1, "system.isChipped": true, "system.chipLevel": 5 });
        await anySkill.setFlag("cp2020-augmented", "ip", 4000);
      }
      await pc.setFlag("cp2020-augmented", "ipPool", 500);
      // The Interface skill, by the localized name the netrunning tab looks it up by — without it
      // the tab's interface field renders with an empty `data-skill-id` and its handler can only warn.
      const ifaceName = game.i18n.localize("CYBERPUNK.SkillInterface");
      if (!pc.items.some(i => i.type === "skill" && i.name === ifaceName))
        await pc.createEmbeddedDocuments("Item", [{ name: ifaceName, type: "skill", system: { level: 4, stat: "int" } }]);
      // An ACTIVE program, so the netrunning tab paints its active-icon row.
      if (prog) await pc.update({ "system.activePrograms": [prog.id] }).catch(() => {});
      await sleep(300);

      // Two vehicle figures, because the sheet is two sheets: a civilian rig and an ACPA suit
      // render different control sets from one class, and a census on either alone reports the
      // other's whole half as dead.
      const VD = await import("/modules/cp2020-augmented/module/vehicle/vehicle-deploy-request.js");
      const vpack = game.packs.get("cp2020-augmented.supplement-vehicles");
      const vidx = vpack ? await vpack.getIndex() : null;
      const vseed = vidx?.contents?.find(e => e.type === "vehicle");
      const vitem = vseed ? await vpack.getDocument(vseed._id) : null;
      const veh = vitem ? await VD.createVehicleActorFromItem(vitem, { name: "__PW__CENSUS Rig" }) : null;
      if (veh) made.actors.push(veh);
      const acpa = await Actor.create({ name: "__PW__CENSUS Suit", type: `${"cp2020-augmented"}.vehicle` }).catch(() => null);
      if (acpa) { made.actors.push(acpa); await acpa.update({ "system.isACPA": true }).catch(() => {}); }
      await sleep(200);

      // ── OPEN AND MEASURE, SURFACE BY SURFACE ───────────────────────────────────────────────
      // Measured AT OPEN TIME, never all at the end. The shop is one window class that re-renders
      // itself into four views in place, so a root captured on the catalog view holds BUILD markup
      // the moment the build view opens — reading it later reported the entire catalog as dead.
      // A surface may be measured more than once (civilian rig + ACPA suit); the reads accumulate,
      // and a selector counts as matched if it matched in ANY view of its surface.
      const acc = new Map();  // selector-key → running record
      for (const row of manifest) {
        const [at, fn, surface, event, sel, reads, gate, optional] = row;
        acc.set(`${at}|${event}|${sel}`, { at, fn, surface, event, sel, reads, gate, optional, matched: 0, fields: {}, err: null, seen: false });
      }
      const measure = (surface, root) => {
        for (const rec of acc.values()) {
          if (rec.surface !== surface) continue;
          rec.seen = true;
          let nodes;
          try { nodes = [...root.querySelectorAll(rec.sel)]; }
          catch (e) { rec.err = e.message; continue; }
          rec.matched += nodes.length;
          for (const f of (rec.reads ? rec.reads.split(",").filter(Boolean) : [])) {
            const vals = nodes.map(n => n.dataset?.[f]);
            const cur = (rec.fields[f] ??= { withValue: 0, total: 0 });
            cur.withValue += vals.filter(v => v !== undefined && v !== "").length;
            cur.total += vals.length;
          }
        }
      };
      const open = async (key, fn, settle = 300) => {
        try {
          const r = await fn();
          await sleep(settle);
          if (!r) { out.notes.push(`${key}: opener returned no root`); return null; }
          const s = (out.surfaces[key] ??= { present: true, views: 0, nodes: 0 });
          s.present = true; s.views++; s.nodes += r.querySelectorAll("*").length;
          measure(key, r);
          return r;
        } catch (e) { out.notes.push(`${key}: opener threw — ${e.message}`); return null; }
      };

      // ── the shop, first: enabling it is what makes the character sheet's shop button render ──
      const SCOPE = "cp2020-augmented";
      const CAT = await import("/modules/cp2020-augmented/module/shop/catalog.js");
      const SH = await import("/modules/cp2020-augmented/module/shop/shops.js");
      // The window refuses to open at all while shopping is switched off, which would read as ~50
      // dead controls. Force it on for the census and restore the world's own value afterwards.
      try {
        shopWas = game.settings.get(SCOPE, "shoppingEnabled");
        if (shopWas !== true) await game.settings.set(SCOPE, "shoppingEnabled", true);
      } catch { /* setting absent — openShopWindow will report it */ }
      // Raw IP tracking is switched on HERE, before any sheet renders — the per-skill IP cluster
      // and its level-up arrow are gated on it, and enabling it after the sheet had already
      // painted was reporting the module's most-regressed control as dead.
      try {
        ipWas = game.settings.get(SCOPE, "ipRawTracking");
        if (ipWas !== true) await game.settings.set(SCOPE, "ipRawTracking", true);
      } catch {}

      /** Wait for the single CatalogBrowser instance to paint the marker its view is known by.
       *  The catalog builds ~2,500 rows on first open, so this polls rather than sleeping once. */
      const shopWin = () => [...foundry.applications.instances.values()].find(w => w?.constructor?.name === "CatalogBrowser") ?? null;
      const shopRoot = async (marker) => {
        for (let i = 0; i < 45; i++) {
          const r = shopWin() ? rootOf(shopWin()) : null;
          if (r?.querySelector(marker)) return r;
          await sleep(400);
        }
        return shopWin() ? rootOf(shopWin()) : null;
      };
      // A stocked shop, because every build-view per-row control (price, stock, ∞, style, remove)
      // renders per stocked line — an empty shop reports all of them as dead.
      const shopDef = await SH.createShop({ name: "__PW__CENSUS Storefront" });
      if (shopDef?.id) {
        made.shopIds.push(shopDef.id);
        try {
          const idx = CAT.getCatalogIndex?.() ?? [];
          const seed = (Array.isArray(idx) ? idx : [...idx]).slice(0, 3);
          for (const row of seed) await SH.addShopItem(shopDef.id, row.sourceKey ?? `${row.packId}.${row.id}`);
          await SH.setAllShopStock(shopDef.id, { qty: 5 });
        } catch (e) { out.notes.push("shop stocking: " + e.message); }
      }
      await open("shop-home", async () => { CAT.openShopWindow(pc, { view: "home" }); return shopRoot(".cp-home-shop, .cp-home-create"); }, 400);
      // The catalog opens straight onto its item list, drawer and all — there is no front page in
      // between, so there is no second shop surface to measure. Clear is pressed once before the
      // measurement, and for a reason: the opening category set leaves Ammo out, the per-row load
      // dropdown rides those generated caliber rows, and an empty set is the state that offers
      // EVERYTHING at once. Pressing the Ammo chip instead would narrow to the caliber rows alone
      // (the first press against an untouched default set replaces it), trading one blind spot for
      // a larger one.
      await open("shop-catalog", async () => {
        CAT.openCatalogBrowser(pc);
        await shopRoot(".cp-catalog-buy, .cp-catalog-row");
        rootOf(shopWin())?.querySelector(".cp-drawer-clear")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return shopRoot(".cp-catalog-row[data-ammo-caliber]");
      }, 800);
      await open("shop-build", async () => {
        CAT.openShopWindow(pc, { view: "build", shopId: shopDef?.id ?? null });
        return shopRoot(".cp-shop-name, .cp-vendor-tray");
      }, 400);
      // The storefront is the published, player-facing view — a fourth distinct render of the
      // same window, and where the GM's "Manage" control lives.
      await open("shop-storefront", async () => {
        if (shopDef?.id) { try { await CAT.publishShop(shopDef.id); } catch {} }
        CAT.openShopWindow(pc, { view: "storefront", shopId: shopDef?.id ?? null });
        return shopRoot(".cp-shop-manage, .cp-catalog-row, .cp-catalog-empty");
      }, 400);
      try { await shopWin()?.close({ force: true }); } catch {}

      // ── the character sheet ────────────────────────────────────────────────────────────────
      await open("character-sheet", async () => {
        await pc.sheet.render(true); await sleep(900);
        const r = rootOf(pc.sheet);
        // Every tab's markup is in the DOM on a rendered sheet, but click through anyway so a tab
        // that builds its rows on first activation has actually been built before the census reads.
        for (const t of r?.querySelectorAll("nav.sheet-tabs .item[data-tab]") ?? []) {
          t.dispatchEvent(new MouseEvent("click", { bubbles: true })); await sleep(140);
        }
        await sleep(400);
        return r;
      }, 300);

      if (veh) await open("vehicle-sheet", async () => { await veh.sheet.render(true); await sleep(900); return rootOf(veh.sheet); }, 300);
      if (acpa) await open("vehicle-sheet", async () => { await acpa.sheet.render(true); await sleep(900); return rootOf(acpa.sheet); }, 300);

      const itemRoot = async (item) => { if (!item) return null; await item.sheet.render(true); await sleep(700); return rootOf(item.sheet); };
      await open("item-sheet:any", () => itemRoot(wpn), 250);
      await open("item-sheet:skill", () => itemRoot(anySkill ?? wpn), 250);
      await open("item-sheet:cyberware", () => itemRoot(cyber), 250);
      await open("item-sheet:ammo", () => itemRoot(ammo), 250);
      await open("item-sheet:consumable", () => itemRoot(drug), 250);
      // The deploy/open pair lives on a VEHICLE item's sheet, not on any item's sheet.
      await open("item-sheet:vehicle", () => itemRoot(vitem), 250);

      // A Maximum Metal vehicle weapon, for the shell-variant controls.
      await open("item-sheet:vehicleweapon", async () => {
        const pack = game.packs.get("cp2020-augmented.vehicle-weapons");
        if (!pack) return null;
        const idx = await pack.getIndex();
        const first = idx.contents?.[0];
        if (!first) return null;
        const doc = await pack.getDocument(first._id);
        await doc.sheet.render(true); await sleep(900);
        made.apps.push(doc.sheet);
        return rootOf(doc.sheet);
      }, 250);

      // ── the Actors directory, for the one control that opens the goon factory ───────────────
      // A HOOK-BUILT control: no template paints it, `renderActorDirectory` builds it in JS. It is
      // GM-only, and the directory is re-rendered — which is the exact path the 2026-08-25 field case
      // took (the button was absent until something forced a render), so a match here certifies the
      // injection, not just the class name.
      // ⏪ A `npcGenEnabled` force-on stood here until 2026-08-28; the switch is retired (the feature
      // is always present), so there is nothing left to force.
      await open("actor-directory", async () => {
        await ui.actors?.render({ force: true });
        await sleep(700);
        return rootOf(ui.actors);
      }, 300);

      // ── the goon factory, measured TWICE: empty, then holding a generated preview, because the
      //    confirm/discard/reroll/delete row only exists once a batch has been rolled.
      await open("goon-factory", async () => {
        const APP = await import("/modules/cp2020-augmented/module/npcgen/npcgen-app.js");
        const Cls = APP.NpcGeneratorApp ?? APP.default;
        const app = new Cls();
        made.apps.push(app);
        await app.render(true); await sleep(2000);
        return rootOf(app);
      }, 300);
      await open("goon-factory", async () => {
        const app = made.apps.find(a => a?.constructor?.name === "NpcGeneratorApp");
        const r = app ? rootOf(app) : null;
        const gen = r?.querySelector('[data-action="goonGenerate"]');
        if (!gen) return null;
        gen.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        for (let i = 0; i < 30; i++) {
          const rr = rootOf(app);
          if (rr?.querySelector('[data-action="goonConfirm"], [data-action="goonRerollOne"]')) return rr;
          await sleep(400);
        }
        return rootOf(app);
      }, 300);
      // Discard the preview so the run leaves no half-built batch behind.
      try {
        const app = made.apps.find(a => a?.constructor?.name === "NpcGeneratorApp");
        rootOf(app)?.querySelector('[data-action="goonDiscard"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await sleep(600);
      } catch {}

      // ── the IP tracker, with a queued row AND an opened balance block ──────────────────────
      await open("ip-tracker", async () => {
        const T = await import("/modules/cp2020-augmented/module/ip/tracker.js");
        const IP = await import("/modules/cp2020-augmented/module/ip/ip.js");
        // A queue row is what the amount/success/Enter controls are painted per; with an empty
        // queue the whole award strip reads as dead wiring. Seeded through the real recording
        // entry point (raw tracking was switched on with the shop settings, above).
        try {
          const sk = pc.items.find(i => i.type === "skill");
          if (sk) { IP.recordSkillRoll({ actorId: pc.id, skillId: sk.id, total: 14 }); await sleep(500); }
        } catch (e) { out.notes.push("ip queue seed: " + e.message); }
        const app = new T.IpTracker();
        made.apps.push(app);
        await app.render(true); await sleep(1500);
        const r = rootOf(app);
        // The balances accordion paints its skill rows only for an OPENED character block.
        const block = r?.querySelector(".cp-ip-bal-block [data-action='ipOpenActor'], .cp-ip-bal-block");
        block?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await sleep(700);
        return rootOf(app);
      }, 300);

      for (const k of rendered) if (!(k in out.surfaces)) out.surfaces[k] = { present: false, views: 0, nodes: 0 };

      // ── CLASSIFY ───────────────────────────────────────────────────────────────────────────
      for (const rec of acc.values()) {
        const { gate, optional, reads } = rec;
        const fields = reads ? reads.split(",").filter(Boolean) : [];
        if (rec.err) { rec.state = "SELECTOR-INVALID"; out.results.push(rec); continue; }
        if (!rec.seen) {
          rec.state = "NOT-EXERCISED";
          rec.why = rendered.includes(rec.surface) ? "surface failed to open" : "surface not in the fixture set";
          out.results.push(rec); continue;
        }
        if (!rec.matched) rec.state = gate ? "NOT-EXERCISED" : "UNMATCHED";
        else if (/^ANY:/.test(optional || "")) {
          // A UNION selector (`[data-ammo-caliber], [data-item-id], [data-source-key]`) resolves a
          // row through whichever key that row carries, so no single field can be required. What
          // CAN be required — and is the same guarantee — is that every matched node carries at
          // least one of them. A row carrying none is unresolvable: the IP-arrow shape for unions.
          const any = optional.slice(4).split(",").filter(Boolean);
          rec.anyOf = any;
          rec.anyCovered = Math.min(...any.map(f => rec.fields[f]?.total ?? 0));
          const covered = any.reduce((n, f) => n + (rec.fields[f]?.withValue ?? 0), 0);
          rec.state = covered >= rec.matched ? "PASS" : "DEAD-DATA";
          rec.deadFields = rec.state === "DEAD-DATA"
            ? [`no union key on ${rec.matched - covered} of ${rec.matched} nodes (${any.join("|")})`] : [];
          rec.partialFields = [];
        }
        else {
          const opt = new Set((optional || "").split(",").filter(Boolean));
          const dead = fields.filter(f => !opt.has(f) && rec.fields[f].withValue === 0);
          const partial = fields.filter(f => !opt.has(f) && rec.fields[f].withValue > 0 && rec.fields[f].withValue < rec.fields[f].total);
          rec.deadFields = dead; rec.partialFields = partial;
          rec.state = dead.length ? "DEAD-DATA" : partial.length ? "PARTIAL" : "PASS";
        }
        if (rec.state === "NOT-EXERCISED" && gate) rec.why = "gate not met: " + gate;
        out.results.push(rec);
      }
    } catch (e) {
      out.fixtureErr = e.message + "\n" + (e.stack ?? "");
    } finally {
      // Restore settings and clear fixtures in a finally block, not on the happy path — a keeper
      // that leaves `shoppingEnabled` rewritten or `__PW__` actors behind reds unrelated suites.
      for (const app of made.apps) { try { await app.close({ force: true }); } catch {} }
      try { for (const w of [...foundry.applications.instances.values()].filter(w => w?.constructor?.name === "CatalogBrowser")) await w.close({ force: true }); } catch {}
      try {
        const SH = await import("/modules/cp2020-augmented/module/shop/shops.js");
        for (const id of made.shopIds) { try { await SH.deleteShop(id); } catch {} }
      } catch {}
      // The seeded queue row names a fixture actor that is about to be deleted — leaving it would
      // hand every later IP suite an orphan row to trip over.
      try { const IP = await import("/modules/cp2020-augmented/module/ip/ip.js"); await IP.removeActorFromQueue(pcId); } catch {}
      for (const a of made.actors) { try { await a.delete(); } catch {} }
      for (const a of game.actors.filter(a => a.name.startsWith("__PW__CENSUS"))) await a.delete().catch(() => {});
      if (shopWas !== null && shopWas !== true) {
        try { await game.settings.set("cp2020-augmented", "shoppingEnabled", shopWas); } catch {}
      }
      if (ipWas !== null && ipWas !== true) {
        try { await game.settings.set("cp2020-augmented", "ipRawTracking", ipWas); } catch {}
      }
    }
    return out;
  }, { manifest: MANIFEST, rendered: RENDERED });
} finally {
  await b.close();
}

chk("fixture build + surface open completed without throwing", !census?.fixtureErr, census?.fixtureErr ?? "");

const bucket = (s) => census.results.filter(r => r.state === s);
const openedSurfaces = Object.entries(census.surfaces).filter(([, v]) => v.present).map(([k]) => k);
const failedOpen = RENDERED.filter(k => !census.surfaces[k]?.present);

chk(`surfaces opened — ${openedSurfaces.length}/${RENDERED.length} of the declared rendered set`,
  failedOpen.length === 0, failedOpen.length ? "did not open: " + failedOpen.join(", ") : "");

// The split that makes an unmatched selector actionable: one that no markup anywhere can paint is
// an ORPHANED HANDLER — a real dead control, and no fixture will ever clear it. One whose token
// does exist in markup is a fixture-state gap, which enriching the fixture closes.
const unmatched = bucket("UNMATCHED");
for (const r of unmatched) r.orphan = !inMarkup(r.sel);
const newOrphans = unmatched.filter(r => r.orphan);
const gaps = unmatched.filter(r => !r.orphan);
const deadData = bucket("DEAD-DATA");
const invalid = bucket("SELECTOR-INVALID");
const partial = bucket("PARTIAL");
const passed = bucket("PASS");
// A gate beginning "ORPHAN" is a RECORDED FINDING, not a fixture gap: the control is known to be
// unpaintable and the module source is not this suite's to change. It is reported in its own
// section every run so it cannot quietly become normal, and it does not red the suite — while any
// orphan that has NOT been recorded does.
const declaredOrphans = bucket("NOT-EXERCISED").filter(r => /^ORPHAN/.test(r.gate ?? ""));
const notEx = bucket("NOT-EXERCISED").filter(r => !/^ORPHAN/.test(r.gate ?? ""));
const orphans = [...declaredOrphans, ...newOrphans];

chk(`no UNRECORDED orphaned handler (${declaredOrphans.length} recorded)`, newOrphans.length === 0,
  newOrphans.slice(0, 15).map(r => `${r.at} [${r.surface}] ${r.sel}`).join(" | "));
chk(`fixture reach — every censused selector on a rendered surface matched ≥1 node or names its gate (${gaps.length} undeclared)`,
  gaps.length === 0, gaps.slice(0, 15).map(r => `${r.at} [${r.surface}] ${r.sel}`).join(" | "));
chk("no DEAD DATA — every data-* field a handler reads carries a value on the rendered node",
  deadData.length === 0, deadData.slice(0, 15).map(r => `${r.at} ${r.sel} → ${r.deadFields.join(",")} empty on all ${r.matched}`).join(" | "));
chk("every censused selector is valid CSS", invalid.length === 0,
  invalid.slice(0, 8).map(r => `${r.at} ${r.sel}: ${r.err}`).join(" | "));

console.log(`\n  census: ${passed.length} pass · ${partial.length} partial · ${orphans.length} ORPHAN · ${gaps.length} fixture-gap · ${deadData.length} dead-data · ${notEx.length} not-exercised · ${MANIFEST.length} total`);
console.log(`  manual-review sites: ${MANUAL_REVIEW.length} · out-of-scope registrations: ${NON_DOM.length}`);

chk("0 console errors", errors.length === 0, errors.slice(0, 6).join(" | "));

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  REPORT + VERDICT
// ═════════════════════════════════════════════════════════════════════════════════════════════
if (REPORT) writeReport(census, { orphans, gaps, deadData, partial, passed, notEx, invalid, openedSurfaces, failedOpen });

let fails = 0;
for (const c of P) { console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail && !c.ok ? "\n        " + c.detail : ""}`); if (!c.ok) fails++; }
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);

// ═════════════════════════════════════════════════════════════════════════════════════════════
function fmtRow(e) {
  const q = (s) => JSON.stringify(s);
  const opt = (v) => (v === null || v === undefined ? "null" : q(v));
  return `  [${q(e[0])}, ${q(e[1])}, ${q(e[2])}, ${q(e[3])}, ${q(e[4])}, ${q(e[5])}, ${opt(e[6])}, ${opt(e[7])}],`;
}
function writeManifest(der) {
  const self = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const hand = new Map(MANIFEST.map(e => [keyOf(e), [e[6] ?? null, e[7] ?? null]]));
  const rows = der.entries.map(e => { const h = hand.get(keyOf(e)) ?? [null, null]; return [...e.slice(0, 6), h[0], h[1]]; });
  const man = "const MANIFEST = [\n" + rows.map(fmtRow).join("\n") + "\n];";
  const manual = "const MANUAL_REVIEW = [\n" + der.manual.map(m => "  " + JSON.stringify(m) + ",").join("\n") + "\n];";
  const nondom = "const NON_DOM = [\n" + der.nondom.map(m => "  " + JSON.stringify(m) + ",").join("\n") + "\n];";
  const next = self
    .replace(/const MANIFEST = \[[\s\S]*?\n\];/, man)
    .replace(/const MANUAL_REVIEW = \[[\s\S]*?\n\];/, manual)
    .replace(/const NON_DOM = \[[\s\S]*?\n\];/, nondom);
  fs.writeFileSync(fileURLToPath(import.meta.url), next);
}
function writeReport(c, g) {
  const out = [];
  const bySurf = {};
  for (const r of c.results) (bySurf[r.surface] ??= []).push(r);
  out.push("# Wiring census\n");
  out.push("_Generated by `tests/cp2020-augmented-wiring-census.mjs --report`. Do not hand-edit._\n");
  out.push(`Manifest: **${MANIFEST.length}** controls across **${SWEPT.length}** swept files.`);
  out.push(`Pass ${g.passed.length} · partial ${g.partial.length} · **orphaned ${g.orphans.length}** · fixture-gap ${g.gaps.length} · **dead-data ${g.deadData.length}** · not-exercised ${g.notEx.length}\n`);
  out.push("## Swept files\n");
  for (const f of SWEPT) out.push(`- \`${f}\` — ${MANIFEST.filter(e => e[0].startsWith(f + ":")).length} censused control(s)`);
  out.push("\n## Surfaces\n\n| surface | opened | censused |\n|---|---|---|");
  for (const s of Object.keys(bySurf).sort()) out.push(`| ${s} | ${c.surfaces[s]?.present ? "yes" : "no"} | ${bySurf[s].length} |`);
  if (g.orphans.length) {
    out.push("\n## FINDINGS — orphaned handlers, ranked by user impact\n");
    out.push("A handler registered on every render that nothing can ever satisfy: the selector's token");
    out.push("appears in no template, in the module OR the base system. No fixture will clear these, and");
    out.push("this suite does not change module source — each is a finding for a ruling.\n");
    const rank = (r) => ORPHAN_IMPACT[r.sel]?.[0] ?? 3;
    const ordered = [...g.orphans].sort((a, z) => rank(z) - rank(a) || a.at.localeCompare(z.at));
    for (const r of ordered) {
      const [lvl, why] = ORPHAN_IMPACT[r.sel] ?? [3, "**Newly found this run — unranked and unrecorded.**"];
      const band = lvl === 3 ? "HIGH" : lvl === 2 ? "MEDIUM" : "LOW";
      out.push(`\n### ${band} · \`${r.sel}\` — ${r.surface}\n`);
      out.push(`- registered at \`${r.at}\` (\`${r.fn}\`), on \`${r.event}\``);
      out.push(`- fields the handler would read: ${r.reads ? "`" + r.reads + "`" : "none"}`);
      out.push(`- what the handler does when the user acts: **nothing — the event never reaches it, because the node it matches is never painted.**`);
      out.push(`- ${why}`);
    }
  }
  if (g.gaps.length) {
    out.push("\n## FIXTURE GAPS — the selector exists in markup, but this fixture never painted it\n");
    out.push("Undeclared state gates. Close each by enriching the fixture, or by naming the state in");
    out.push("the manifest's `gate` column.\n");
    out.push("| registration | surface | event | selector | reads |\n|---|---|---|---|---|");
    for (const r of g.gaps) out.push(`| \`${r.at}\` (${r.fn}) | ${r.surface} | ${r.event} | \`${r.sel}\` | ${r.reads || "—"} |`);
  }
  if (g.deadData.length) {
    out.push("\n## DEAD-DATA — the handler reads a field that is empty on every rendered node\n");
    out.push("| registration | surface | selector | empty field(s) | matched nodes |\n|---|---|---|---|---|");
    for (const r of g.deadData) out.push(`| \`${r.at}\` (${r.fn}) | ${r.surface} | \`${r.sel}\` | **${r.deadFields.join(", ")}** | ${r.matched} |`);
  }
  if (g.partial.length) {
    out.push("\n## PARTIAL — field present on some matches only (conditional rows; informational)\n");
    for (const r of g.partial) out.push(`- \`${r.at}\` ${r.sel} — ${r.partialFields.map(f => `${f} on ${r.fields[f].withValue}/${r.fields[f].total}`).join(", ")}`);
  }
  out.push("\n## NOT-EXERCISED — the gap list\n");
  const gaps = {};
  for (const r of g.notEx) (gaps[r.why ?? "?"] ??= []).push(r);
  for (const why of Object.keys(gaps).sort()) {
    out.push(`\n**${why}** (${gaps[why].length})\n`);
    // A row on a surface the fixture never opens still carries its own state gate — the classifier
    // stops at the surface and never reads it, so print it here or the gate is invisible.
    for (const r of gaps[why].slice(0, 60))
      out.push(`- \`${r.at}\` [${r.surface}] \`${r.sel}\`${r.gate && !/^gate not met/.test(why) ? ` — ${r.gate}` : ""}`);
    if (gaps[why].length > 60) out.push(`- …${gaps[why].length - 60} more`);
  }
  out.push("\n## MANUAL-REVIEW — registrations whose contract cannot be derived mechanically\n");
  out.push("| registration | method | surface | why |\n|---|---|---|---|");
  for (const m of MANUAL_REVIEW) out.push(`| \`${m[0]}\` | ${m[1]} | ${m[2]} | ${m[3]} |`);
  out.push("\n## Out of scope — hook/socket/document registrations\n");
  for (const m of NON_DOM) out.push(`- \`${m[0]}\` ${m[1]} (${m[2]})`);
  fs.writeFileSync(path.join(REPO, "import-staging", "WIRING-CENSUS.md"), out.join("\n") + "\n");
}
