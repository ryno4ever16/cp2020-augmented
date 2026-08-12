/**
 * Vehicle deploy requests — the bridge from a vehicle ITEM (inventory/pink-slip) to a vehicle
 * ACTOR (the FNFF/MM combat object).
 *
 * Flow (user rulings 2026-07-31):
 *  - Actor creation is a ONE-TIME action per (player, item). Players may initiate it, but a
 *    player's request must be approved by the active GM; the GM CLIENT performs the create, so
 *    no player actor-creation permission is ever needed. A GM clicking Deploy creates directly.
 *  - The proposed name defaults to "[player]'s [vehicle]" and is editable BEFORE creation.
 *  - The item↔actor link lives ONLY in flags (sourceItemUuid + createdBy) — renaming the actor
 *    (or the item) at any time breaks nothing.
 *  - Re-clicking Deploy when this player already created an actor from this item reports
 *    "already deployed as <current actor name>" (name read live at message time).
 *  - DEPLOY MEANS IT HITS THE CANVAS (user ruling 2026-08-11: "my first thought was to look at the
 *    canvas and say 'where's the roadcar'"). Approval also PLACES the vehicle, beside the token
 *    the requester is standing on, on that requester's scene. The requester's client picks the
 *    anchor (only it knows what that player has selected) and sends it with the request; the GM
 *    client, which may write tokens anywhere, does the placing. A requester with no token on a
 *    scene still gets the actor — plus a notice saying where to find it.
 */

import { localizeParam, tryLocalize } from "../utils.js";
import { deployVehicleToScene } from "./vehicle-canvas.js";
import { placeBeside } from "./vehicle-seating.js";

const SCOPE = "cp2020-augmented";
const VEHICLE_ACTOR_TYPE = "cp2020-augmented.vehicle";
const MSG_REQUEST = "vehicleActorRequest";
const MSG_RESULT = "vehicleActorRequestResult";

const { DialogV2 } = foundry.applications.api;
const renderTemplate = (path, data) =>
  (foundry.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate)(path, data);

/**
 * Map a book's free-text vehicle class onto the handling enum the control tables read.
 * `modeled: false` marks families the ingested rulesets (Core p.112 + Maximum Metal) simply do
 * not cover — submarines, spacecraft, and exotics. Those keep generic (car) handling plus an
 * honest "rules not modeled" label on the sheet, instead of silently pretending.
 */
const VEHICLE_TYPE_MAP = [
  [/sports?\s*car/i, "sportscar", true],
  [/limo/i, "limo", true],
  [/motor\s*cycle|\bcycle\b|\bbike\b/i, "cycle", true],
  [/pick.?up|\btruck\b|\bvan\b|\bsemi\b/i, "truck", true],
  [/\btank\b|\bmbt\b/i, "tank", true],
  [/\bapc\b|\bifv\b/i, "APC", true],
  [/av-?7/i, "AV-7", true],
  [/av-?6/i, "AV-6", true],
  [/\bav\b|av-?4|aerodyne/i, "AV-4", true],
  [/heli|rotor|gyro/i, "rotor", true],
  [/osprey|tilt.?rotor/i, "osprey", true],
  [/\bboat\b|\bship\b|watercraft|jet.?ski/i, "boat", true],
  [/acpa|powered? armou?r/i, "acpa", true],
  [/\bcar\b|sedan|coupe|compact/i, "car", true],
  [/submarine|\bsub\b|space|satellite|orbit|shuttle|\brpv\b|drone|remote|hover|dirigible|airship|ultralight|\bjet\b|plane|glider/i, "car", false],
];
export function normalizeVehicleType(text) {
  const t = String(text ?? "").trim();
  if (!t) return { type: "car", modeled: true };
  for (const [re, type, modeled] of VEHICLE_TYPE_MAP) {
    if (re.test(t)) return { type, modeled };
  }
  return { type: "car", modeled: false };
}

/** The actor this user already created from this item, if any (flags-keyed — rename-proof). */
export function findDeployedVehicleActor(item, userId) {
  return game.actors.find(a =>
    a.type === VEHICLE_ACTOR_TYPE
    && a.flags?.[SCOPE]?.sourceItemUuid === item.uuid
    && a.flags?.[SCOPE]?.createdBy === userId
  ) ?? null;
}

/** Name-entry prompt. Resolves the chosen name, or null on cancel.
 *  Default = "[owning actor]'s [vehicle]" (the character whose inventory holds the item —
 *  user ruling: the ACTOR's name, not the user's); a world/loose item falls back to the
 *  plain vehicle name. */
async function promptForName(item) {
  const ownerName = item.parent?.name ?? null;
  const proposed = ownerName
    ? localizeParam("VehicleDeployDefaultName", { owner: ownerName, vehicle: item.name })
    : item.name;
  const content = await renderTemplate(`modules/${SCOPE}/templates/dialog/vehicle-deploy-name.hbs`, { proposed });
  return DialogV2.prompt({
    window: { title: tryLocalize("VehicleDeployNameTitle", "Deploy vehicle") },
    classes: ["cyberpunk", "cp-vehicle-deploy-name"],
    content,
    rejectClose: false,
    ok: {
      label: tryLocalize("VehicleDeploy", "Deploy"),
      callback: (event, button, dialog) => {
        const el = (dialog.element ?? dialog)?.querySelector?.('input[name="cp-deploy-name"]');
        return el?.value?.trim() || proposed;
      },
    },
  });
}

/**
 * Create the vehicle actor from the item's stats. GM-side (or direct for a GM requester).
 * The item's single SP seeds all five facings (Core's one-SP semantic; MM flanks are GM tuning).
 * sdp.value seeds full when the catalog copy carries 0 current.
 */
export async function createVehicleActorFromItem(item, { name, requesterUserId } = {}) {
  const sys = item.system ?? {};
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const sp = num(sys.sp);
  const sdpMax = num(sys.sdp?.max) || num(sys.sdp?.value);
  const folderName = tryLocalize("VehicleDeployFolder", "Vehicles");
  const folder = game.folders.find(f => f.type === "Actor" && f.name === folderName)
    ?? await Folder.create({ type: "Actor", name: folderName });

  const ownership = {};
  const requester = requesterUserId ? game.users.get(requesterUserId) : null;
  if (requester && !requester.isGM) ownership[requesterUserId] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;

  // Handling normalization + the whole-vehicle catalog layer (unified-sheet plan Phase 3):
  // the seed is essentially verbatim now — the civilian sheet mirrors the item sheet, so the
  // data must travel. ACPA items deploy straight onto the ACPA sheet.
  const norm = normalizeVehicleType(sys.vehicleType);
  const isAcpa = norm.type === "acpa";
  const topSpeed = num(sys.speed?.max) || num(sys.speed?.value);

  return Actor.create({
    name: name || item.name,
    type: VEHICLE_ACTOR_TYPE,
    img: item.img,
    folder: folder?.id,
    ownership,
    // Linked prototype: the deployed vehicle IS this vehicle — dents persist across scenes
    // (matches deployVehicleToScene's "new vehicles seed linked at creation" convention).
    prototypeToken: { actorLink: true, texture: { src: item.img } },
    flags: { [SCOPE]: { sourceItemUuid: item.uuid, createdBy: requesterUserId ?? game.user.id } },
    system: {
      vehicleType: isAcpa ? "car" : norm.type,
      vehicleTypeText: String(sys.vehicleType ?? ""),
      isACPA: isAcpa,
      isMMVehicle: isAcpa,          // civilians open on the item-mirror sheet
      sp: { front: sp, side: sp, rear: sp, top: sp, bottom: sp },
      sdp: { value: num(sys.sdp?.value) || sdpMax, max: sdpMax },
      topSpeed,
      speedValue: num(sys.speed?.value) || topSpeed,
      speedUnit: sys.speed?.unit === "kph" ? "kph" : "mph",
      safeSpeed: num(sys.speed?.maneuver),
      acc: num(sys.speed?.acceleration),
      dec: num(sys.speed?.deceleration),
      controlMod: num(sys.maneuverability?.value),
      crewSlots: Math.max(1, num(sys.crew)),
      passengerSlots: num(sys.passengers),
      range: num(sys.range),
      rangeUnit: sys.rangeUnit === "km" ? "km" : "mi",
      fuel: {
        value: num(sys.fuel?.value), max: num(sys.fuel?.max),
        unit: sys.fuel?.unit === "liters" ? "liters" : "gal",
        type: String(sys.fuel?.type ?? ""), efficiency: num(sys.fuel?.efficiency),
      },
      mass: { value: num(sys.mass?.value), unit: sys.mass?.unit === "kg" ? "kg" : "tons" },
      cargo: { value: num(sys.cargo?.value), unit: sys.cargo?.unit === "tons" ? "tons" : "kg" },
      bodyRating: num(sys.body),
      flavor: String(sys.flavor ?? ""),
      notes: String(sys.notes ?? ""),
    },
  });
}

/* ------------------------------------------------------------------ canvas placement */

/**
 * The token a deploy should appear beside, chosen on the REQUESTER's own client: whatever they
 * have selected, else their assigned character's token on the scene they are looking at, else
 * (for a player, whose ownership is meaningful) any token they own there.
 * @returns {{sceneId:string, tokenId:string}|null}
 */
export function requesterAnchor() {
  const controlled = canvas?.tokens?.controlled?.[0];
  if (controlled?.id && canvas?.scene?.id) return { sceneId: canvas.scene.id, tokenId: controlled.id };
  const scene = canvas?.scene ?? game.scenes?.active ?? null;
  if (!scene) return null;
  const charId = game.user?.character?.id ?? null;
  const tokens = [...(scene.tokens ?? [])];
  const own = charId ? tokens.find(t => t.actorId === charId) : null;
  const fallback = game.user?.isGM ? null : tokens.find(t => t.actor?.isOwner);
  const pick = own ?? fallback;
  return pick ? { sceneId: scene.id, tokenId: pick.id } : null;
}

/**
 * Put the freshly created vehicle on the canvas next to the requester's token. Runs on the GM
 * client (token writes on any scene). Never throws — a placement failure must not cost the actor.
 * @returns {Promise<{placed:boolean, sceneName:string|null}>}
 */
export async function placeDeployedVehicle(actor, anchor) {
  try {
    const scene = anchor?.sceneId ? game.scenes.get(anchor.sceneId) : null;
    const anchorToken = anchor?.tokenId ? scene?.tokens?.get(anchor.tokenId) : null;
    if (!scene || !anchorToken) return { placed: false, sceneName: null };

    const grid = scene.grid?.size ?? 100;
    const size = {
      w: Number(actor.prototypeToken?.width) || 4,
      h: Number(actor.prototypeToken?.height) || 2,
    };
    const anchorRect = {
      x: anchorToken.x, y: anchorToken.y,
      w: (anchorToken.width ?? 1) * grid, h: (anchorToken.height ?? 1) * grid,
    };
    const blockers = [...(scene.tokens ?? [])].map(t => ({
      x: t.x, y: t.y, w: (t.width ?? 1) * grid, h: (t.height ?? 1) * grid,
    }));
    const spot = placeBeside(anchorRect, grid, size, blockers, { width: scene.width, height: scene.height });
    const res = await deployVehicleToScene(actor, { scene, x: spot.x, y: spot.y, gw: size.w, gh: size.h });
    return { placed: !!res, sceneName: scene.name };
  } catch (err) {
    console.warn("Cyberpunk2020 | vehicle deploy placement failed", err);
    return { placed: false, sceneName: null };
  }
}

/**
 * One-time migration for the civilian-sheet split: vehicle actors that predate isMMVehicle keep
 * the combat sheet (stamped true) so existing worlds change nothing; new creates/deploys default
 * to the civilian layout. World-setting stamped; GM client only; NEVER via migrateData (Foundry
 * applies migrateData to update changes too — a fill there would wipe a civilian's false on any
 * unrelated partial update; see the recorded ObjectField/mergeDefaults hazards).
 */
export function registerCivilianSheetMigration() {
  game.settings.register(SCOPE, "civilianSheetMigrated", {
    scope: "world", config: false, type: Boolean, default: false,
  });
  Hooks.once("ready", async () => {
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
    if (game.settings.get(SCOPE, "civilianSheetMigrated")) return;
    // Every vehicle actor that exists when this first runs predates the civilian sheet (deploy-
    // created civilians can only appear after ready) — stamp them all onto the combat sheet.
    // NOTE: a source-absence check would never fire here — DataModel cleaning fills schema
    // initials into _source at load, so isMMVehicle reads false even on pre-split docs.
    for (const a of game.actors.filter(x => x.type === VEHICLE_ACTOR_TYPE)) {
      const updates = { "system.isMMVehicle": true };
      if (!a.system.vehicleTypeText) updates["system.vehicleTypeText"] = a.system.vehicleType ?? "";
      await a.update(updates);
    }
    await game.settings.set(SCOPE, "civilianSheetMigrated", true);
  });
}

/**
 * Sheet-button entry point. Dedupe → name prompt → direct create (GM) or GM-approval relay.
 */
export async function requestVehicleDeploy(item) {
  if (item?.type !== "vehicle") return null;

  const existing = findDeployedVehicleActor(item, game.user.id);
  if (existing) {
    ui.notifications?.info?.(localizeParam("VehicleDeployAlready", { name: existing.name }));
    return null;
  }

  const name = await promptForName(item);
  if (!name) return null;

  // The anchor is read HERE, on the requester's client, because only this client knows what this
  // player has selected — the approving GM cannot see another user's selection.
  const anchor = requesterAnchor();

  if (game.user.isGM) {
    const actor = await createVehicleActorFromItem(item, { name, requesterUserId: game.user.id });
    const { placed } = await placeDeployedVehicle(actor, anchor);
    ui.notifications?.info?.(localizeParam("VehicleDeployCreated", { name: actor.name }));
    if (!placed) ui.notifications?.warn?.(localizeParam("Vehicle.DeployNoTokenFallback", { name: actor.name }));
    return actor;
  }

  if (!game.users?.activeGM) {
    ui.notifications?.warn?.(tryLocalize("VehicleDeployNoGM", "A GM must be online to approve a vehicle deploy."));
    return null;
  }

  game.socket.emit(`module.${SCOPE}`, {
    type: MSG_REQUEST,
    itemUuid: item.uuid,
    proposedName: name,
    requesterId: game.user.id,
    requesterName: game.user.name,
    anchor,
  });
  ui.notifications?.info?.(localizeParam("VehicleDeployRequestSent", { name }));
  return null;
}

/** Active-GM side: show the approval prompt and act on the verdict. */
async function _handleDeployRequest(data) {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;

  const item = await fromUuid(data.itemUuid);
  if (!item) return;

  // Race guard: the request may have been fulfilled already (double click, second GM).
  const dupe = findDeployedVehicleActor(item, data.requesterId);
  if (dupe) return;

  const content = await renderTemplate(`modules/${SCOPE}/templates/dialog/vehicle-deploy-approve.hbs`, {
    requesterName: data.requesterName,
    vehicleName: item.name,
    proposedName: data.proposedName,
  });
  const approved = await DialogV2.wait({
    window: { title: tryLocalize("VehicleDeployApproveTitle", "Vehicle deploy request") },
    classes: ["cyberpunk", "cp-vehicle-deploy-approve"],
    content,
    rejectClose: false,
    buttons: [
      { action: "approve", label: tryLocalize("VehicleDeployApprove", "Approve"), default: true },
      { action: "decline", label: tryLocalize("VehicleDeployDecline", "Decline") },
    ],
  });

  if (approved === "approve") {
    const actor = await createVehicleActorFromItem(item, {
      name: data.proposedName, requesterUserId: data.requesterId,
    });
    const { placed } = await placeDeployedVehicle(actor, data.anchor);
    if (!placed) ui.notifications?.warn?.(localizeParam("Vehicle.DeployNoTokenFallback", { name: actor.name }));
    game.socket.emit(`module.${SCOPE}`, {
      type: MSG_RESULT, requesterId: data.requesterId, approved: true,
      actorName: actor.name, actorId: actor.id, placed,
    });
  } else {
    game.socket.emit(`module.${SCOPE}`, {
      type: MSG_RESULT, requesterId: data.requesterId, approved: false,
    });
  }
}

/** Requester side: surface the GM's verdict — and open the new vehicle's sheet (the moment that
 *  teaches the pink-slip → vehicle model: the player watches the item become an actor). */
function _handleDeployResult(data) {
  if (data.requesterId !== game.user.id) return;
  if (data.approved) {
    ui.notifications?.info?.(localizeParam("VehicleDeployApproved", { name: data.actorName }));
    // Deploy normally lands the vehicle beside the player. When it couldn't (they had no token
    // on a scene), say where the vehicle actually is instead of leaving them hunting the canvas.
    if (data.placed === false) {
      ui.notifications?.warn?.(localizeParam("Vehicle.DeployNoTokenFallback", { name: data.actorName }));
    }
    // The actor may arrive over the world sync a beat after the socket message — retry briefly.
    const tryOpen = (attempt = 0) => {
      const actor = game.actors.get(data.actorId);
      if (actor) return actor.sheet?.render(true);
      if (attempt < 20) setTimeout(() => tryOpen(attempt + 1), 250);
    };
    tryOpen();
  } else {
    ui.notifications?.warn?.(tryLocalize("VehicleDeployDeclined", "The GM declined the vehicle deploy request."));
  }
}

export function registerVehicleDeploySocket() {
  game.socket.on(`module.${SCOPE}`, async data => {
    if (data?.type === MSG_REQUEST) await _handleDeployRequest(data);
    else if (data?.type === MSG_RESULT) _handleDeployResult(data);
  });
}
