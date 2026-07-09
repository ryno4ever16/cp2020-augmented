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
 * The embedded-item data for one option spec. `parentId` is the item it links to via Module.ParentId
 * (the body for a top-level option, or a container option — a Front Optic Mount — for a nested one);
 * `bodyId` is always the chassis, stamped as the SOURCE flag so loadout membership is one relationship
 * regardless of nesting depth (defaults to parentId for a flat option). Pure so the rig can assert the
 * shape without touching documents. A spec is `{ name, mountZone, side?, cyberwareType?,
 * cyberwareSubtype?, description?, humanityCost?, slotsTaken?, source?, img?, key?, parentKey?,
 * isModule?, allowedParent?, optionsAvailable?, types?, acceptsTypes? }` — the last group models the
 * container ↔ module hierarchy (a mount carries `optionsAvailable`/`types:["Implant"]`; an optic carries
 * `isModule` + `allowedParent`), reusing the base AllowedParentCyberwareType system so nesting rules
 * apply. `acceptsTypes` marks a mixed-family mount (a sensory boom hosting optics AND audio) — it maps
 * to `CyberWorkType.AcceptsTypes`, which checkInstall consults in place of the host's own family.
 */
export function loadoutItemData(spec, parentId, bodyId = parentId) {
  const zone = String(spec?.mountZone ?? "");
  const side = String(spec?.side ?? "");
  const cwt = {};
  if (spec?.optionsAvailable != null) cwt.OptionsAvailable = Math.max(0, Number(spec.optionsAvailable) || 0);
  if (Array.isArray(spec?.types)) cwt.Types = spec.types.slice();
  if (Array.isArray(spec?.acceptsTypes)) cwt.AcceptsTypes = spec.acceptsTypes.slice();
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
      Module: {
        ParentId: parentId,
        SlotsTaken: Math.max(1, Number(spec?.slotsTaken) || 1),
        AllowedParentCyberwareType: spec?.allowedParent ?? "",
        IsModule: !!spec?.isModule,
      },
      CyberWorkType: cwt,
      // Mech engine payloads ride the spec verbatim (mechVision / mechRollMods / mechTypedSP /
      // mechProtection / ...): the borg-option wiring pass stores each stub's payload in its
      // manifest entry, and materialization copies it onto the created item unchanged.
      ...(spec?.mech && typeof spec.mech === "object" ? foundry.utils.deepClone(spec.mech) : {}),
    },
    flags: { [SCOPE]: { [SOURCE_FLAG]: bodyId } },
  };
}

/** True when THIS client should perform the writes: it initiated the change and owns the actor. */
function iAmTheOwner(actor, userId) {
  return userId === game.user?.id && !!actor?.isOwner;
}

/** Every option item this body spawned (by source flag), equipped or carried. Pure. The single source
 *  of truth for "the loadout's members" so a bulk control's confirm count == the set it acts on. */
export function loadoutOptionsOf(actor, bodyId) {
  const items = actor?.items?.contents ?? actor?.items ?? [];
  return items.filter((it) => (it.getFlag?.(SCOPE, SOURCE_FLAG) ?? it.flags?.[SCOPE]?.[SOURCE_FLAG]) === bodyId);
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
  if (manifest.length) await createLoadoutTree(actor, bodyItem, manifest);
  await bodyItem.setFlag(SCOPE, INSTALLED_FLAG, true);
}

/**
 * Materialize a (possibly nested) manifest in dependency order. A spec with a `parentKey` parents to the
 * item created for the spec whose `key` matches (an optic → its Front Optic Mount), so its Module.ParentId
 * points at the mount, not the body; a spec with no parentKey parents to the body. Created level by level
 * so a child's parent id already exists. A spec whose parentKey never resolves (bad data) falls back to
 * the body, so no option is ever dropped. Every option's SOURCE flag is the body regardless of depth.
 * A nested spec inherits its container spec's zone/side (same rule as the sheet's host-drop): the
 * contents live wherever the mount lives (a shoulder boom's optics sit in the Torso zone with it).
 */
async function createLoadoutTree(actor, bodyItem, manifest) {
  const keyToId = {};
  const keyToSpec = Object.fromEntries(manifest.filter((s) => s?.key).map((s) => [s.key, s]));
  const placed = (s) => {
    const p = s?.parentKey ? keyToSpec[s.parentKey] : null;
    return p?.mountZone ? { ...s, mountZone: p.mountZone, side: p.side ?? "" } : s;
  };
  let pending = manifest.slice();
  let guard = 0;
  while (pending.length && guard++ < 20) {
    const ready = pending.filter((s) => !s?.parentKey || keyToId[s.parentKey]);
    if (!ready.length) break;   // remaining specs reference an unresolved parentKey → handle as fallback
    const created = await actor.createEmbeddedDocuments("Item",
      ready.map((s) => loadoutItemData(placed(s), s?.parentKey ? keyToId[s.parentKey] : bodyItem.id, bodyItem.id)));
    ready.forEach((s, i) => { if (s?.key) keyToId[s.key] = created[i].id; });
    pending = pending.filter((s) => !ready.includes(s));
  }
  if (pending.length) {
    await actor.createEmbeddedDocuments("Item", pending.map((s) => loadoutItemData(s, bodyItem.id, bodyItem.id)));
  }
}

/** Delete the ATTACHED (equipped) options this body spawned when the body itself is deleted — the
 *  chrome physically in the destroyed chassis goes with it. Options the player already shelved to
 *  Carried Options are their own kept property and SURVIVE (never destroy carried chrome). The
 *  chassis-strip delete offers an explicit "delete the options too" choice; this is the safe default
 *  for any other delete path. */
export async function pruneLoadout(actor, bodyId, body = null) {
  if (!actor) return;
  const toDelete = loadoutOptionsOf(actor, bodyId)
    .filter((it) => it.system?.equipped === true)
    .map((it) => it.id);
  if (toDelete.length) await actor.deleteEmbeddedDocuments("Item", toDelete);
  if (body && body.getFlag?.(SCOPE, INSTALLED_FLAG)) await body.unsetFlag(SCOPE, INSTALLED_FLAG);
}

/**
 * Uninstall (do NOT delete) every option this body spawned, so removing them is non-destructive — the
 * options become CARRIED (kept in inventory, no Humanity hit, re-equippable). Used when the body is
 * UNINSTALLED, or when the player clears the loadout from the sheet. Matches the sheet's per-item
 * uninstall exactly: unequip + clear the host link (ParentId) + clear the body side, so a cleared
 * option is fully loose in Carried Options rather than a still-nested-but-unequipped ghost. Acts on the
 * WHOLE member set (not just the currently-equipped ones) so a bulk ⊗ clears all of it — already-carried
 * members are a harmless no-op. The `loadoutInstalled` guard is KEPT set so re-installing the body
 * doesn't re-materialize duplicates (the options are still there, just carried; the player re-equips
 * what they want). Expensive chrome is never destroyed by removal.
 */
export async function deactivateLoadout(actor, bodyId) {
  if (!actor) return;
  const updates = loadoutOptionsOf(actor, bodyId).map((it) => ({
    _id: it.id,
    "system.equipped": false,
    "system.Module.ParentId": "",
    "system.CyberBodyType.Location": "",
  }));
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
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
    else await deactivateLoadout(actor, item.id);   // uninstall PRESERVES: unequip options → carried
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
