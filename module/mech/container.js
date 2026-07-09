/**
 * Q6 — Containers (SPECIAL-MECHANICS-PROPOSAL.md, option 1): diegetic nesting of items inside
 * items (cybereye options in a cybereye, a hold-out pistol in a cyberarm compartment, gear in a
 * skin pouch), with capacity, a telescoping display, and an uninstall cascade.
 *
 * UNIFIES two link sources through one set of accessors so the display + capacity + cascade are a
 * single code path:
 *   - CYBERWARE reuses the base system's OWN system (the module already surfaces it): a child's
 *     parent is `Module.ParentId`, a parent's capacity is `CyberWorkType.OptionsAvailable`, a
 *     child's footprint is `Module.SlotsTaken`.
 *   - MISC (no base container fields) uses `mechContainer.{installedIn, capacity, slotsTaken}`.
 * A parent of either type can hold children of either type (a cyberarm holding a misc hold-out).
 *
 * Pure helpers (accessors, tree, capacity, canInstall) are exported for tests; install/uninstall
 * and the delete-cascade hook touch documents.
 */

import { cwHasType, pickCwType } from "../utils.js";

const SCOPE = "cp2020-augmented";

/** The id of the item this one is installed in ("" = loose). Cyberware → Module.ParentId. Pure. */
export function installedInOf(item) {
  if (item?.type === "cyberware") return String(item.system?.Module?.ParentId ?? "");
  return String(item?.system?.mechContainer?.installedIn ?? "");
}

/** Child slots this item provides as a container (0 = not a container). Cyberware → OptionsAvailable. Pure. */
export function capacityOf(item) {
  if (item?.type === "cyberware") return Math.max(0, Number(item.system?.CyberWorkType?.OptionsAvailable) || 0);
  return Math.max(0, Number(item?.system?.mechContainer?.capacity) || 0);
}

/** Slots this item occupies in its parent (min 1). Cyberware → Module.SlotsTaken. Pure. */
export function slotsTakenOf(item) {
  const raw = item?.type === "cyberware"
    ? Number(item.system?.Module?.SlotsTaken)
    : Number(item?.system?.mechContainer?.slotsTaken);
  return Math.max(1, Number.isFinite(raw) && raw > 0 ? raw : 1);
}

/** True when the item can hold children. Pure. */
export function isContainer(item) {
  return capacityOf(item) > 0;
}

/** Direct children of `parentId` among `items`. Pure. */
export function childrenOf(items, parentId) {
  if (!parentId) return [];
  return (items ?? []).filter(it => installedInOf(it) === parentId);
}

/** Slots used in `parentId` by its direct children. Pure. */
export function usedSlots(items, parentId) {
  return childrenOf(items, parentId).reduce((s, c) => s + slotsTakenOf(c), 0);
}

/** Free slots remaining in `parent`. Pure. */
export function freeSlots(parent, items) {
  return Math.max(0, capacityOf(parent) - usedSlots(items, parent.id ?? parent._id));
}

/** Would installing `child` into `parent` create a cycle (parent is child, or a descendant of child)? Pure. */
export function wouldCycle(child, parent, items) {
  const childId = child?.id ?? child?._id;
  let cur = parent;
  const byId = new Map((items ?? []).map(it => [it.id ?? it._id, it]));
  const seen = new Set();
  while (cur) {
    const curId = cur.id ?? cur._id;
    if (curId === childId) return true;
    if (seen.has(curId)) break;
    seen.add(curId);
    cur = byId.get(installedInOf(cur));
  }
  return false;
}

/**
 * The reasoned install check — can `child` be installed into `parent`? Returns `{ ok, reason, param }`
 * where `reason` is a stable key for a localized warning. Enforces the base system's cyberware nesting
 * model (REUSED, not re-invented — see utils.pickCwType + the item-sheet parent-picker): a cyberware
 * child must be a MODULE (`Module.IsModule`); its host must be an Implant whose `cyberwareType` matches
 * the child's `Module.AllowedParentCyberwareType` (when the child declares one), in the same MountZone
 * (and same side for a limb). That IsModule gate is what stops an optic mount (a host, not a module)
 * from nesting inside an optic. Misc↔container nesting keeps only the capacity/cycle rules (misc items
 * carry none of these cyberware fields, so cross-type compartments still work). Pure.
 *
 * Mixed-family mounts: a container may declare `CyberWorkType.AcceptsTypes` (an array of cyberware
 * families, e.g. a sensory boom hosting optics AND audio). When present it replaces the host's own
 * `cyberwareType` in the family match — children stay truthfully typed (an audio option still refuses
 * a cybereye) while the mount accepts every listed family. Such a mount also places its contents
 * wherever the mount itself lives, so the anatomy zone/side match is skipped for its children.
 */
export function checkInstall(child, parent, items) {
  if (!child || !parent) return { ok: false, reason: "invalid" };
  const childId = child.id ?? child._id;
  const parentId = parent.id ?? parent._id;
  if (childId === parentId) return { ok: false, reason: "self" };
  if (!isContainer(parent)) return { ok: false, reason: "not-container" };
  if (wouldCycle(child, parent, items)) return { ok: false, reason: "cycle" };

  if (child.type === "cyberware" && parent.type === "cyberware") {
    if (!child.system?.Module?.IsModule) return { ok: false, reason: "not-module" };
    if (!cwHasType(parent, "Implant")) return { ok: false, reason: "not-implant" };
    const accepts = (parent.system?.CyberWorkType?.AcceptsTypes ?? []).map(pickCwType).filter(Boolean);
    const needType = String(child.system?.Module?.AllowedParentCyberwareType || "");
    if (needType) {
      const need = pickCwType(needType);
      const typeOk = accepts.length ? accepts.includes(need)
        : pickCwType(parent.system?.cyberwareType) === need;
      if (!typeOk) return { ok: false, reason: "wrong-type", param: { type: need || needType } };
    }
    if (!accepts.length) {
      const zoneOf = (it) => String(it.system?.MountZone || it.system?.CyberBodyType?.Type || "");
      const sideOf = (it) => String(it.system?.CyberBodyType?.Location || "");
      const cz = zoneOf(child), pz = zoneOf(parent);
      if (cz && pz && cz !== pz) return { ok: false, reason: "wrong-zone", param: { zone: pz } };
      if (pz === "Arm" || pz === "Leg") {
        const cs = sideOf(child), ps = sideOf(parent);
        if (cs && ps && cs !== ps) return { ok: false, reason: "wrong-side" };
      }
    }
  }

  if (freeSlots(parent, items) < slotsTakenOf(child)) return { ok: false, reason: "full" };
  return { ok: true, reason: null };
}

/** Can `child` be installed into `parent`? Pure. (Boolean facade over checkInstall.) */
export function canInstall(child, parent, items) {
  return checkInstall(child, parent, items).ok;
}

/**
 * A telescoping tree of the actor's items rooted at loose (uninstalled) items, each carrying its
 * children recursively. `filterRoot` selects which loose items become roots (e.g. only cyberware
 * for the cyber tab). Children of any type are included regardless of the root filter. Pure.
 */
export function buildContainerTree(items, filterRoot = () => true) {
  const list = items ?? [];
  const node = (item) => ({
    item,
    capacity: capacityOf(item),
    used: usedSlots(list, item.id ?? item._id),
    isContainer: isContainer(item),
    installed: !!installedInOf(item),
    children: childrenOf(list, item.id ?? item._id).map(node)
  });
  return list.filter(it => !installedInOf(it) && filterRoot(it)).map(node);
}

/**
 * Group items into per-zone telescoping trees for the anatomy body map. `areaOf(item)` returns the
 * zone-area id an item occupies ("" = not placeable in the map). A tree ROOT is a placeable item whose
 * container-parent is NOT another placeable item on this actor — so a normal cyberarm is a root in its
 * arm zone with its options nested underneath, while a full-borg option (parented to the zoneless
 * chassis) is a root in its own zone (the chassis isn't placeable, so the option isn't nested under it).
 * Children (any depth) attach via the container link regardless of their own area, so each item appears
 * exactly once. Returns `{ [area]: [node, …] }`, node = `{ item, area, capacity, used, isContainer,
 * children }`. Pass the already-filtered set you want shown (e.g. the equipped/enabled cyberware). Pure.
 */
export function buildZoneTrees(items, areaOf) {
  const list = items ?? [];
  const idOf = (it) => it?.id ?? it?._id;
  const placeable = (it) => String(areaOf(it) || "") !== "";
  const byId = new Map(list.map(it => [idOf(it), it]));
  const node = (item) => ({
    item,
    area: areaOf(item),
    capacity: capacityOf(item),
    used: usedSlots(list, idOf(item)),
    isContainer: isContainer(item),
    children: childrenOf(list, idOf(item)).map(node),
  });
  const isRoot = (it) => {
    if (!placeable(it)) return false;
    const parent = byId.get(installedInOf(it));
    return !(parent && placeable(parent));   // nested under a visible host ⇒ not a root
  };
  const zones = {};
  for (const it of list) {
    if (!isRoot(it)) continue;
    (zones[areaOf(it)] ??= []).push(node(it));
  }
  return zones;
}

/** Ids of all items nested (any depth) under `parentId`. Pure. */
export function descendantIds(items, parentId) {
  const out = [];
  const walk = (pid) => {
    for (const c of childrenOf(items, pid)) {
      const id = c.id ?? c._id;
      out.push(id);
      walk(id);
    }
  };
  walk(parentId);
  return out;
}

/** The update patch that clears an item's installed-in link (type-aware). Pure. */
function detachPatch(item) {
  return item?.type === "cyberware"
    ? { "system.Module.ParentId": "" }
    : { "system.mechContainer.installedIn": "" };
}

/** The update patch that sets an item's installed-in link to `parentId` (type-aware). Pure. */
function attachPatch(item, parentId) {
  return item?.type === "cyberware"
    ? { "system.Module.ParentId": parentId }
    : { "system.mechContainer.installedIn": parentId };
}

/** Install `child` into `parent` when allowed (returns true on success). */
export async function installItem(child, parent, items) {
  if (!canInstall(child, parent, items ?? child?.actor?.items?.contents ?? [])) return false;
  await child.update(attachPatch(child, parent.id ?? parent._id));
  return true;
}

/** Uninstall `child` (detach to loose inventory). */
export async function uninstallItem(child) {
  await child.update(detachPatch(child));
}

/** Register the uninstall cascade: deleting a container detaches its DIRECT children (they become
 *  loose, keeping their own subtrees). Owner/initiating-client only, so it runs once. */
export function registerMechContainer() {
  Hooks.on("preDeleteItem", async (item, options, userId) => {
    const actor = item.actor;
    if (!actor || userId !== game.user?.id || !actor.isOwner) return;
    if (!isContainer(item)) return;
    const items = actor.items?.contents ?? [];
    const kids = childrenOf(items, item.id).map(c => c.id);
    if (!kids.length) return;
    // Detach after the delete resolves, so the child updates don't fight the delete transaction.
    Hooks.once("deleteItem", async (deleted) => {
      if (deleted.id !== item.id) return;
      for (const id of kids) {
        const child = actor.items.get(id);
        if (child) await child.update(detachPatch(child)).catch(() => {});
      }
    });
  });
}
