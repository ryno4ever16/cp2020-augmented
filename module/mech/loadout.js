/**
 * Loadout materialization: an item that carries a `loadout` manifest (a list of prebuilt option
 * specs) auto-creates those options as real embedded cyberware when it is installed, and removes
 * them when it is uninstalled or deleted. Full-conversion 'borg bodies are the first consumer — a
 * Dragoon ships with a fixed suite of optics/weapon-mounts/systems, so installing the body should
 * populate the cyberware tab with all of them at once (before this, the body item "did nothing"
 * visible on install). Any item type could carry a manifest, so the mechanic is generic.
 *
 * The materialized options are ordinary cyberware items: each is created `equipped` with its own
 * `MountZone` (so it lands in the right cyberware-tab zone section) and linked into the body via the
 * Q6 container field `system.Module.ParentId` (so it also nests under the body in the inventory
 * tree, and the pair is one relationship rather than two). They are flagged `loadoutSource` = the
 * body's id so uninstall/delete can find and remove exactly them.
 *
 * Deliberate scope for this pass (user, 2026-07-08): the options are DESCRIPTIVE stubs — book-
 * accurate name + zone + description + noted Humanity Cost, but their active mechanics are wired in
 * the later D4 pass. Humanity is NOT re-charged per option: the body's own Humanity Cost already
 * includes the whole loadout, so each stub carries `humanityLoss: 0`.
 *
 * Ownership: these are the player's own actor items, so the INITIATING client that owns the actor
 * performs the writes (mirrors the chip-grant / consumable engines, not the token engines' GM relay).
 * A `loadoutInstalled` guard flag on the body makes materialize idempotent across re-prep/re-render.
 *
 * Pure helpers are exported for the rig spec; hooks are wired by registerMechLoadout().
 */

const SCOPE = "cp2020-augmented";
const MANIFEST_FLAG = "loadout";          // on the BODY: the array of option specs
const INSTALLED_FLAG = "loadoutInstalled"; // on the BODY: true once its loadout has been materialized
const SOURCE_FLAG = "loadoutSource";       // on each OPTION: the id of the body that spawned it

/** The loadout manifest array from an item's flags (never null). Pure. */
export function loadoutManifestOf(item) {
  const m = item?.getFlag?.(SCOPE, MANIFEST_FLAG) ?? item?.flags?.[SCOPE]?.[MANIFEST_FLAG];
  return Array.isArray(m) ? m : [];
}

/** True when the item ships a (non-empty) loadout manifest. Pure. */
export function hasLoadout(item) {
  return loadoutManifestOf(item).length > 0;
}

/**
 * The embedded-item data for one option spec, parented to `bodyId`. Pure so the rig can assert the
 * shape without touching documents. A spec is `{ name, mountZone, side?, cyberwareType?,
 * cyberwareSubtype?, description?, humanityCost?, slotsTaken?, source?, img? }`.
 */
export function loadoutItemData(spec, bodyId) {
  const zone = String(spec?.mountZone ?? "");
  const side = String(spec?.side ?? "");
  return {
    name: String(spec?.name ?? "Option"),
    type: "cyberware",
    img: spec?.img || "icons/svg/upgrade.svg",
    system: {
      notes: spec?.description ?? "",
      cost: 0,
      equipped: true,
      source: spec?.source ?? "",
      humanityCost: spec?.humanityCost ?? "",
      humanityLoss: 0,                       // body HC already includes the loadout — never re-charge
      cyberwareType: spec?.cyberwareType ?? "",
      cyberwareSubtype: spec?.cyberwareSubtype ?? "",
      MountZone: zone,
      EffectMode: "Permanent",
      EffectActive: false,
      CyberBodyType: { Type: zone, Location: side },
      Module: { ParentId: bodyId, SlotsTaken: Math.max(1, Number(spec?.slotsTaken) || 1), AllowedParentCyberwareType: "" },
      CyberWorkType: {},
    },
    flags: { [SCOPE]: { [SOURCE_FLAG]: bodyId } },
  };
}

/** True when THIS client should perform the writes: it initiated the change and owns the actor. */
function iAmTheOwner(actor, userId) {
  return userId === game.user?.id && !!actor?.isOwner;
}

/**
 * Create the body's loadout options on its actor (idempotent via the `loadoutInstalled` guard).
 * Sets the guard even when the manifest is empty, so a bare body (e.g. Alpha Class) isn't re-checked
 * on every equip.
 */
export async function materializeLoadout(bodyItem) {
  const actor = bodyItem?.actor;
  if (!actor) return;
  if (bodyItem.getFlag?.(SCOPE, INSTALLED_FLAG)) return;
  const manifest = loadoutManifestOf(bodyItem);
  const toCreate = manifest.map((spec) => loadoutItemData(spec, bodyItem.id));
  if (toCreate.length) await actor.createEmbeddedDocuments("Item", toCreate);
  await bodyItem.setFlag(SCOPE, INSTALLED_FLAG, true);
}

/** Delete every option this body spawned; clear the body's guard when it still exists (unequip). */
export async function pruneLoadout(actor, bodyId, body = null) {
  if (!actor) return;
  const items = actor.items?.contents ?? actor.items ?? [];
  const toDelete = items
    .filter((it) => (it.getFlag?.(SCOPE, SOURCE_FLAG) ?? it.flags?.[SCOPE]?.[SOURCE_FLAG]) === bodyId)
    .map((it) => it.id);
  if (toDelete.length) await actor.deleteEmbeddedDocuments("Item", toDelete);
  if (body && body.getFlag?.(SCOPE, INSTALLED_FLAG)) await body.unsetFlag(SCOPE, INSTALLED_FLAG);
}

/** Did this update flip `system.equipped`? Returns "on" | "off" | null. Pure. */
export function equippedChange(changes) {
  const v = foundry.utils.getProperty(changes ?? {}, "system.equipped");
  return v === true ? "on" : v === false ? "off" : null;
}

export function registerMechLoadout() {
  // Install / uninstall a body via its `equipped` flag: materialize on install, prune on removal.
  Hooks.on("updateItem", async (item, changes, options, userId) => {
    if (!hasLoadout(item)) return;
    const change = equippedChange(changes);
    if (!change) return;
    const actor = item.actor;
    if (!actor || !iAmTheOwner(actor, userId)) return;
    if (change === "on") await materializeLoadout(item);
    else await pruneLoadout(actor, item.id, item);
  });

  // A body deleted (equipped or not) takes its whole loadout with it.
  Hooks.on("deleteItem", async (item, options, userId) => {
    if (!hasLoadout(item)) return;
    const actor = item.actor;
    if (!actor || !iAmTheOwner(actor, userId)) return;
    await pruneLoadout(actor, item.id);
  });

  // A body imported already-installed (e.g. a pre-configured drop) materializes on arrival.
  Hooks.on("createItem", async (item, options, userId) => {
    if (!hasLoadout(item) || item.system?.equipped !== true) return;
    const actor = item.actor;
    if (!actor || !iAmTheOwner(actor, userId)) return;
    await materializeLoadout(item);
  });
}
