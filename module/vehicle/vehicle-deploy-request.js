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
 *  - Token placement is NOT part of this flow — the GM drags the created actor to scenes like
 *    any other actor (deployVehicleToScene remains the canvas-side helper).
 */

import { localizeParam, tryLocalize } from "../utils.js";

const SCOPE = "cp2020-augmented";
const VEHICLE_ACTOR_TYPE = "cp2020-augmented.vehicle";
const MSG_REQUEST = "vehicleActorRequest";
const MSG_RESULT = "vehicleActorRequestResult";

const { DialogV2 } = foundry.applications.api;
const renderTemplate = (path, data) =>
  (foundry.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate)(path, data);

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
      vehicleType: String(sys.vehicleType || "car"),
      sp: { front: sp, side: sp, rear: sp, top: sp, bottom: sp },
      sdp: { value: num(sys.sdp?.value) || sdpMax, max: sdpMax },
      topSpeed: num(sys.speed?.max) || num(sys.speed?.value),
      safeSpeed: num(sys.speed?.maneuver),
      acc: num(sys.speed?.acceleration),
      dec: num(sys.speed?.deceleration),
      controlMod: num(sys.maneuverability?.value),
      crewSlots: Math.max(1, num(sys.crew)),
      passengerSlots: num(sys.passengers),
      notes: String(sys.notes ?? ""),
    },
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

  if (game.user.isGM) {
    const actor = await createVehicleActorFromItem(item, { name, requesterUserId: game.user.id });
    ui.notifications?.info?.(localizeParam("VehicleDeployCreated", { name: actor.name }));
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
    game.socket.emit(`module.${SCOPE}`, {
      type: MSG_RESULT, requesterId: data.requesterId, approved: true, actorName: actor.name,
    });
  } else {
    game.socket.emit(`module.${SCOPE}`, {
      type: MSG_RESULT, requesterId: data.requesterId, approved: false,
    });
  }
}

/** Requester side: surface the GM's verdict. */
function _handleDeployResult(data) {
  if (data.requesterId !== game.user.id) return;
  if (data.approved) {
    ui.notifications?.info?.(localizeParam("VehicleDeployApproved", { name: data.actorName }));
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
