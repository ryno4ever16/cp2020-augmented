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
import { deployVehicleToScene, DEFAULT_FOOTPRINT } from "./vehicle-canvas.js";
import { placeBeside } from "./vehicle-seating.js";
// ⚠ vehicle-face.js imports `normalizeVehicleType` back out of THIS file, so the two form an ESM
// cycle. It is safe and must stay safe: neither side may touch the other's bindings at module
// evaluation time. Both uses here are inside function bodies, and `normalizeVehicleType` is a
// hoisted function declaration, so whichever module is evaluated first the other is complete by
// the time anything is called.
import { FACE_DESIGNATIONS, FACE_ACPA, FACE_STANDARD, FACE_CHOSEN, explicitFace } from "./vehicle-face.js";
import { isPrimaryGMSession } from "../gm-session-primary.js";

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

  // ⚠ SIX FAMILIES WERE MARKED "NOT COVERED" THAT THE BOOK COVERS. MM p.11's REVISED CONTROL MODIFIERS
  // prints a handling value for Hover (−2), Airship (+5), Light Plane (−0), Med/Hvy Plane (−3), Small
  // Jet (+1) and Large Jet (−4) — and vehicle-control.js has always carried the hover and airship rows,
  // so the module was contradicting itself: one file knew the number while another told the sheet the
  // rules did not exist. The order matters — the specific rows must precede the generic `plane`/`jet`
  // ones, because "light plane" also matches /plane/.
  [/hover/i, "hover", true],
  [/dirigible|airship|blimp|zeppelin/i, "airship", true],
  [/light\s*plane|ultralight\s*plane/i, "light plane", true],
  [/small\s*jet/i, "small jet", true],
  [/large\s*jet|heavy\s*jet/i, "large jet", true],
  [/\bjet\b/i, "jet", true],
  [/plane|airplane|aeroplane/i, "plane", true],

  // Still genuinely uncovered: neither Core p.112 nor MM prints handling for these. p.8 discusses RPVs
  // but sends their stats to Chromebook 2 / Protect and Serve, which are not ingested here, so an RPV
  // stays honest rather than borrowing a car's numbers under a "modeled" label.
  [/submarine|\bsub\b|space|satellite|orbit|shuttle|\brpv\b|drone|remote|ultralight|glider/i, "car", false],
];
export function normalizeVehicleType(text) {
  const t = String(text ?? "").trim();
  if (!t) return { type: "car", modeled: true };
  for (const [re, type, modeled] of VEHICLE_TYPE_MAP) {
    if (re.test(t)) return { type, modeled };
  }
  return { type: "car", modeled: false };
}

/**
 * The vehicle actor this ITEM is linked to, if any (flags-keyed — rename-proof for both documents).
 *
 * ⛔ THE LINK IS THE ITEM'S, NOT (ITEM, USER)'S — the load-bearing correction of the 2026-08-25 bug
 * bundle. This used to also require `createdBy === userId`, which made the link a per-user opinion:
 * a GM who deployed a player's truck stamped `createdBy` with the GM's id, so the SAME item's row on
 * the player's client still read "Deploy". She pressed it, the request was approved, and the world
 * gained a second truck for the same pink slip. One item, one vehicle.
 *
 * `preferUserId` does not filter, it only ORDERS: when several actors are already linked (worlds
 * that ran the old per-user rule can hold two), the one this user created is the one they get back,
 * and everyone else converges on the oldest — a stable answer on every client, which is what makes
 * the button read the same everywhere.
 *
 * @param {Item} item
 * @param {string|null} [preferUserId]  tie-break only; NEVER a filter
 * @returns {Actor|null}
 */
export function findDeployedVehicleActor(item, preferUserId = null) {
  const uuid = item?.uuid;
  if (!uuid) return null;
  const linked = game.actors.filter(a =>
    a.type === VEHICLE_ACTOR_TYPE && a.flags?.[SCOPE]?.sourceItemUuid === uuid);
  if (linked.length === 0) return null;
  if (linked.length === 1) return linked[0];
  const mine = preferUserId ? linked.find(a => a.flags?.[SCOPE]?.createdBy === preferUserId) : null;
  // Oldest first, so two clients looking at the same leftover pair name the same vehicle.
  return mine ?? [...linked].sort((a, b) => (a._stats?.createdTime ?? 0) - (b._stats?.createdTime ?? 0))[0];
}

/**
 * Who owns a vehicle deployed from this item — the SAME answer on both deploy paths.
 *
 * ⛔ The GM path used to hand out no ownership at all (its requester is a GM, and a GM owns
 * everything), so a GM deploying a player's truck produced a vehicle the player could not see. The
 * player's own row then had nothing to point at and offered Deploy again. Ownership follows the
 * ITEM: whoever owns the character whose inventory holds the pink slip owns the machine, plus the
 * requester when they are a player. A GM needs no entry either way.
 */
export function deployOwnershipFor(item, requesterUserId = null) {
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const ownership = {};
  const carrier = item?.parent;               // the character holding the item, if any
  for (const [userId, level] of Object.entries(carrier?.ownership ?? {})) {
    if (userId === "default") continue;       // never widen to the world
    if (level !== OWNER) continue;
    if (game.users.get(userId)?.isGM) continue;
    ownership[userId] = OWNER;
  }
  const requester = requesterUserId ? game.users.get(requesterUserId) : null;
  if (requester && !requester.isGM) ownership[requesterUserId] = OWNER;
  return ownership;
}

/* ------------------------------------------------------- the pending-request state, client-local */

/**
 * Requests this client has sent and the GM has not answered yet, keyed by item uuid.
 *
 * Why client-local and not a flag on the item: a request is not a fact about the vehicle, it is a
 * fact about this browser's last click. It must not survive a reload, must not be visible to other
 * players, and must never need a write to a document the requester may not own.
 *
 * The stamp is a TIME, not a boolean, so a GM who drops off the world cannot wedge the button
 * forever — an unanswered request ages out and the row offers Deploy again.
 */
const _pendingDeploys = new Map();
const PENDING_TTL_MS = 120000;

/** True while THIS client is waiting on a GM verdict for this item. */
export function deployRequestPending(item) {
  const at = _pendingDeploys.get(item?.uuid);
  if (!at) return false;
  if (Date.now() - at > PENDING_TTL_MS) { _pendingDeploys.delete(item.uuid); return false; }
  return true;
}
export function markDeployRequestPending(itemUuid) { _pendingDeploys.set(itemUuid, Date.now()); }
export function clearDeployRequestPending(itemUuid) { _pendingDeploys.delete(itemUuid); }

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

  // ONE ownership answer for both deploy paths — see deployOwnershipFor. A GM deploying a player's
  // truck now produces a vehicle that player owns, which is what makes their own Deploy row flip.
  const ownership = deployOwnershipFor(item, requesterUserId);

  // Handling normalization + the whole-vehicle catalog layer (unified-sheet plan Phase 3):
  // the seed is essentially verbatim now — the civilian sheet mirrors the item sheet, so the
  // data must travel. ACPA items deploy straight onto the ACPA sheet.
  const norm = normalizeVehicleType(sys.vehicleType);
  const isAcpa = norm.type === "acpa";
  const topSpeed = num(sys.speed?.max) || num(sys.speed?.value);

  // Which FACE the new actor opens on. The ITEM's own designation wins when it has one (the pink
  // slip's face control, user ruling 2026-08-25); with nothing designated the class decides, which
  // is exactly what this line did before the item carried a designation at all. The pair is read
  // out of the ONE table so the actor can never be seeded with a combination the picker cannot
  // produce — the old literal `isMMVehicle: isAcpa` seeded a suit as {true, true}.
  // `explicitFace` and not `designatedFace`, because an item whose GM picked "Standard" carries the
  // same two booleans as one nobody has touched — only the choice flag tells them apart, and a
  // Standard-marked tank must not deploy onto the combat sheet its class would otherwise derive.
  const itemFace = explicitFace(item);
  const facePair = FACE_DESIGNATIONS[itemFace || (isAcpa ? FACE_ACPA : FACE_STANDARD)];

  return Actor.create({
    name: name || item.name,
    type: VEHICLE_ACTOR_TYPE,
    img: item.img,
    folder: folder?.id,
    ownership,
    // Linked prototype: the deployed vehicle IS this vehicle — dents persist across scenes
    // (matches deployVehicleToScene's "new vehicles seed linked at creation" convention).
    prototypeToken: { actorLink: true, texture: { src: item.img } },
    flags: { [SCOPE]: {
      sourceItemUuid: item.uuid,
      createdBy: requesterUserId ?? game.user.id,
      // A pink slip whose face was CHOSEN hands that choice on, so the new vehicle opens where the
      // item said and does not re-derive from its class. An item nobody designated hands on nothing
      // and the actor keeps deriving, exactly as before.
      ...(itemFace ? { [FACE_CHOSEN]: true } : {}),
    } },
    system: {
      vehicleType: isAcpa ? "car" : norm.type,
      vehicleTypeText: String(sys.vehicleType ?? ""),
      isACPA: facePair.isACPA,
      isMMVehicle: facePair.isMMVehicle,   // civilians open on the item-mirror sheet
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
    // The clearance to look for is the token's own FRAME — the square the vehicle is carried in —
    // because that is the box the core will refuse to overlap, not the hull inside it. It is read
    // off the prototype the preCreateActor seeding already squared; the DEFAULT_FOOTPRINT hull is
    // the fallback for a prototype that somehow never got one, imported rather than repeated here so
    // the two can never drift into two different shipped shapes.
    const side = Number(actor.prototypeToken?.width)
      || Math.max(DEFAULT_FOOTPRINT.w, DEFAULT_FOOTPRINT.h);
    const size = { w: side, h: Number(actor.prototypeToken?.height) || side };
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
    // ⚠ THE ONE PLACE THE STARTUP RACE CAN STILL BE FELT: `ready` runs early enough that a second GM
    // session opened at the very same moment may not have been observed yet, so both could sweep. The
    // sweep is stamp-gated and its per-actor write is the same value from either client, so a doubled
    // run is redundant rather than wrong. See module/gm-session-primary.js for the bound.
    if (!isPrimaryGMSession()) return;
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
 *
 * ⭐ TWO dedupe questions, not one (bug bundle 2026-08-25): is a vehicle already linked to this
 * item — BY ANYONE, either deploy path — and is a request for it already in the GM's hands? The
 * second one is what stopped the reported double-request: the row stayed on "Deploy" for the whole
 * round trip, so a second click sent a second request before the first was answered.
 */
export async function requestVehicleDeploy(item) {
  if (item?.type !== "vehicle") return null;

  const existing = findDeployedVehicleActor(item, game.user.id);
  if (existing) {
    ui.notifications?.info?.(localizeParam("VehicleDeployAlready", { name: existing.name }));
    return null;
  }
  if (deployRequestPending(item)) {
    ui.notifications?.info?.(tryLocalize("VehicleDeployPendingNotice",
      "A deploy request for this vehicle is already waiting for the GM."));
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

  // Marked BEFORE the emit: the row must read "pending" from the instant the request leaves, not
  // from whenever the GM gets round to answering. The repaint belongs HERE and not only in the
  // button's own handler, so the state is a property of the request rather than of one caller —
  // a macro, a relay or the API produce the same row a click does.
  markDeployRequestPending(item.uuid);
  refreshVehicleItemSheets(item.uuid);
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

/** Primary-GM-session side: show the approval prompt and act on the verdict. */
async function _handleDeployRequest(data) {
  // ⛔ THE MOST VISIBLE ROW OF THE LOT: without a session-level answer a referee with two tabs open
  // got TWO approval prompts for one request, and answering both deployed two vehicles. The
  // cross-path dedupe below catches a request already fulfilled, but only after a prompt was shown.
  if (!isPrimaryGMSession()) return;

  const item = await fromUuid(data.itemUuid);
  if (!item) return;

  // ⛔ CROSS-PATH DEDUPE. The request may have been fulfilled already — by a double click, by a
  // second GM, or (the reported case) by a GM who deployed this very pink slip themselves before
  // the player pressed anything. Silence was the old answer, which left the requester's row stuck
  // on "pending" and told them nothing; the verdict now travels back so the row settles on the
  // vehicle that already exists.
  const dupe = findDeployedVehicleActor(item, data.requesterId);
  if (dupe) {
    game.socket.emit(`module.${SCOPE}`, {
      type: MSG_RESULT, requesterId: data.requesterId, itemUuid: data.itemUuid,
      approved: true, already: true, actorName: dupe.name, actorId: dupe.id, placed: true,
    });
    return;
  }

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
      type: MSG_RESULT, requesterId: data.requesterId, itemUuid: data.itemUuid, approved: true,
      actorName: actor.name, actorId: actor.id, placed,
    });
  } else {
    game.socket.emit(`module.${SCOPE}`, {
      type: MSG_RESULT, requesterId: data.requesterId, itemUuid: data.itemUuid, approved: false,
    });
  }
}

/** Requester side: surface the GM's verdict — and open the new vehicle's sheet (the moment that
 *  teaches the pink-slip → vehicle model: the player watches the item become an actor). */
function _handleDeployResult(data) {
  if (data.requesterId !== game.user.id) return;
  // Whatever the verdict, this client is no longer waiting: release the row's pending state and
  // repaint it from what is true now. A verdict that never arrives ages out instead (PENDING_TTL_MS).
  if (data.itemUuid) clearDeployRequestPending(data.itemUuid);
  refreshVehicleItemSheets(data.itemUuid ?? null);
  if (data.approved) {
    // The already-deployed answer is not an approval — nothing was created, the vehicle was
    // already there. Say that instead of announcing a creation that did not happen.
    ui.notifications?.info?.(data.already
      ? localizeParam("VehicleDeployAlready", { name: data.actorName })
      : localizeParam("VehicleDeployApproved", { name: data.actorName }));
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

/* ------------------------------------------------------------------ keeping the row honest */

/**
 * Repaint every open vehicle ITEM sheet (or just the one item's), so the Deploy row states what is
 * true NOW rather than what was true when the sheet was opened.
 *
 * @param {string|null} itemUuid  limit to one item's sheets; null repaints all vehicle item sheets
 */
export function refreshVehicleItemSheets(itemUuid = null) {
  let apps = [];
  try { apps = [...foundry.applications.instances.values()]; } catch (e) { return; }
  for (const app of apps) {
    const doc = app.document ?? app.item ?? null;
    if (doc?.documentName !== "Item" || doc.type !== "vehicle") continue;
    if (itemUuid && doc.uuid !== itemUuid) continue;
    if (!app.rendered) continue;
    try { app.render(); } catch (e) { /* a sheet mid-close is not a fault */ }
  }
}

/**
 * The deploy link, kept live on every client.
 *
 * ⛔ THE REPORTED DEAD BUTTON. Both trucks were deleted and the row still read "Open" — and that
 * Open did nothing, because the actor it named was gone and nothing repainted the sheet. The row
 * was a photograph taken when the sheet opened. These three hooks make it a reading: the moment a
 * linked vehicle is created, deleted, renamed or re-shared, every open pink slip that points at it
 * repaints. A vehicle that no longer exists therefore reverts the control to Deploy LIVE, on every
 * client that can see the item, without closing anything.
 *
 * Presentation only — no document writes, so this is safe to run on every client (it must, or the
 * player's sheet would only ever update when the GM happened to have it open).
 */
export function registerVehicleDeployLinkHooks() {
  const relink = (actor) => {
    if (actor?.type !== VEHICLE_ACTOR_TYPE) return;
    const uuid = actor.flags?.[SCOPE]?.sourceItemUuid ?? null;
    if (!uuid) return;
    // A linked vehicle appearing or vanishing answers any request this client was waiting on.
    clearDeployRequestPending(uuid);
    refreshVehicleItemSheets(uuid);
  };
  Hooks.on("createActor", relink);
  Hooks.on("deleteActor", relink);
  // A rename changes the row's TEXT ("Deployed as …"), and an ownership change decides whether the
  // Open button is offered at all — both are things the row states, so both repaint it.
  Hooks.on("updateActor", (actor, changes) => {
    if (!changes) return;
    if (changes.name === undefined && changes.ownership === undefined) return;
    relink(actor);
  });
}
