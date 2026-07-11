import { martialOptions, martialActionGroups, meleeAttackTypes, meleeBonkOptions, rangedModifiers, weaponTypes, FNFF2_ONLY_MARTIAL_ART_KEYS, isFnff2Enabled, ANATOMY_IMAGES, DEFAULT_ANATOMY_KEY } from "../lookups.js"
import { deleteFieldUpdate, localize, localizeParam, tryLocalize, cwHasType, cwIsEnabled, cwIsSkinweave, isCombatSenseSkill, properCase } from "../utils.js"
import { makeD10Roll } from "../dice.js"
import { ModifiersDialog } from "../dialog/modifiers.js"
import { SortOrders, sortSkills } from "./skill-sort.js";
import { rollFacedown as cpRollFacedown, rollRecognition as cpRollRecognition } from "./reputation.js";
import { getHtmlElement, getRichEditorHTML, itemFromDropData, saveRichEditorHTML } from "../compat.js";
import { resolveAttackRange } from "../combat/rangefinding.js";
import { attackModProviders, skillModProviders, statModProviders, gearModGroup, gearModSum } from "../mech/roll-mods.js";
import { activeInfluencesFor, statContributionsFor } from "../mech/status.js";
import { clearAddiction, clearDrugMarker } from "../mech/drug.js";
import { cyberlimbSheetStatus, repairCyberlimb, contributingItems, fleshLimbStatusLabel } from "../mech/cyberlimb.js";
import { isFullBorg, borgBodyOf, borgOptionSpaces, cyberAreaOf, isBorgBody } from "../mech/borg.js";
import { isLivingActor } from "../mech/vision.js";
import { buildContainerTree, buildZoneTrees, uninstallItem, checkInstall, installedInOf, childrenOf, descendantIds, slotsTakenOf, capacityOf, usedSlots } from "../mech/container.js";
import { hasLoadout, deactivateLoadout, loadoutOptionsOf } from "../mech/loadout.js";
import { getAutoLayerOrder } from "../combat/armor-layers.js";
import { openShopForPlayer, purchaseByDrop } from "../shop/catalog.js";
import { classifyService, payService, servicePeriodOf } from "../shop/services.js";
import { ipCost, ipLockState, canEditSkillLevels, levelUpSkill, toggleSkillLock } from "../ip/ip.js";
import { shoppingEnabled, ipEnabled, ipRawTracking, ipShowPending, autoRangefindingEnabled, cyberlimbRepairGmOnly, radiationEnabled } from "../settings.js";
import { actorExposure, actorHistory, actorRSP, radMarkersFor, clearExposure, cureRadiation, postLongTermCard } from "../radiation/radiation.js";
import { openApplyDoseDialog } from "../radiation/radiation-tools.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Character / NPC actor sheet — ApplicationV2 port.
 *
 * Native ApplicationV2 sheet. `_prepareContext` builds on `super._prepareContext`, and all listener
 * wiring is split into small native `_cpActivate*` helpers called from `_onRender` — matching the
 * upstream CyberpunkActorSheet structure: Tabs, ActorFilePickers, BasicActorActions, ActorFormControls,
 * CyberwareControls, NetrunningControls, ActorCustomControls (CP2020-specific), NotesEditor, and
 * ActorDragDrop. Each is a bind-once delegated listener on the persistent root (Stage A2 replaced the
 * former ~760-line jQuery `activateListeners` entirely). Behaviour is covered by the
 * tests/v14/actor-*.spec.js rig suite (both v13.350 and v14.364).
 *
 * @extends {foundry.applications.sheets.ActorSheetV2}
 */
export class CyberpunkActorSheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ActorSheetV2) {

  static DEFAULT_OPTIONS = {
    classes: ["cyberpunk", "sheet", "actor"],
    position: { width: 590, height: 600 },
    window: { resizable: true },
    tag: "form",
    form: { submitOnChange: true, closeOnSubmit: false },
    // Drag-drop: declare handlers so DocumentSheetV2 wires dragstart/dragover/drop onto this.element.
    // The custom _onDragStart / _onDrop / _onDropItem overrides below extend the inherited chain.
    dragDrop: [{ dragSelector: ".item[data-item-id]", dropSelector: null }],
  };

  /**
   * Single wrapper part: the existing actor template. Its root <form> was changed to a <div> so it
   * satisfies the V2 "one root element per part" rule (the <form> is now provided by tag:"form").
   */
  static PARTS = {
    // scrollable = the in-part scroll container AppV2 saves/restores across re-renders. It must be an
    // element INSIDE the part; "" (the part root) doesn't scroll and the real scroller (the frame's
    // section.window-content) is an ancestor the framework can't reach — so scroll reset to top on every
    // re-render. The paired CSS moves the scroll onto .sheet-body so this preserves it. See css scroll fix.
    main: { template: "modules/cp2020-augmented/templates/actor/actor-sheet.hbs", scrollable: [".sheet-body"] },
  };

  /** V1 tab config, reused by the manual Tabs binding in _onRender (V2 has no auto-tab option). */
  static TAB_CONFIG = { navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "skills" };

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    // V2 convention (Foundry core AND upstream both do this): start from the base context the
    // framework builds — document, fields, source, editable, etc. — then augment, instead of
    // hand-constructing the object. Keeps the sheet aligned with the base-class contract as
    // Foundry evolves (the prior hand-built literal was a frozen snapshot that never received
    // `fields`/`source`). Downstream code still sets system/owner/editable + the derived fields.
    const sheetData = await super._prepareContext(options);
    sheetData.actor = this.actor;
    sheetData.cssClass = this.isEditable ? "editable" : "locked";
    sheetData.limited = this.actor.limited;
    sheetData.options = this.options;
    sheetData.title = this.title;

    const actor = this.actor;
    const system = actor.system;

    sheetData.system = system;
    sheetData.owner = this.actor.isOwner;
    sheetData.editable = this.isEditable ?? this.options?.editable ?? false;
    // Life-tab notes: false = read-only view (+ Edit button), true = ProseMirror editor.
    // Sheet-only UI state (not persisted on the actor); see _cpSetupNotesActions / _cpExitNotesEditing.
    sheetData.notesEditing = !!this._cpNotesEditing;

    if (actor.type === 'character' || actor.type === 'npc') {
      // Sheet-only UI state; do not store search text in actor.system.
      sheetData.skillFilter = this._cpSkillFilter ?? "";

      this._prepareCharacterItems(sheetData);
      this._addWoundTrack(sheetData);
      this._prepareSkills(sheetData);

      sheetData.weaponTypes = weaponTypes;

      const initiativeMod = foundry.utils.getProperty(system, "initiativeMod") || 0;
      sheetData.initiativeMod = initiativeMod;

      const StunDeathMod = foundry.utils.getProperty(system, "StunDeathMod") || 0;
      sheetData.StunDeathMod = StunDeathMod;

      // Facedown/Recognition Reputation lives in a MODULE FLAG, not system.* — the stock base
      // system's DataModel has no `reputation` field and strips any system.reputation write.
      // The combat-tab input binds to flags.cp2020-augmented.reputation; this reads it back for
      // display. See module/actor/reputation.js.
      sheetData.reputation = Number(actor.getFlag("cp2020-augmented", "reputation")) || 0;

      // Whether to show the "Shop" button on the gear tab (world setting; default off).
      sheetData.showShop = shoppingEnabled();

      // §3c visibility hybrid: status-strip rows + item-row badges + stat tooltips. mech/status.js
      // supplies mechanism rows; this is their render edge (labels localized here, names literal).
      this._cpPrepareStatusVisibility(sheetData);

      // GM-only Deep Space radiation hub (R3b): a readout of the running exposure / lifetime history / RSP
      // / active stat loss + the GM controls. Shown only to a GM while the subsystem is enabled — inert
      // otherwise, so the sheet is byte-identical for players and for a world with radiation off.
      this._cpPrepareRadiation(sheetData);
    }

    sheetData.cyberwareSegmentsRight = [
      { area: "nervous" },
      { area: "body" },
      { area: "r-arm" },
      { area: "r-leg" }
    ];

    sheetData.cyberwareSegmentsLeft = [
      { area: "head" },
      { area: "l-arm" },
      { area: "l-leg" }
    ];

    const ZONE_I18N = {
      "head": "Head", "body": "Torso", "nervous": "Nervous",
      "l-arm": "lArm", "r-arm": "rArm", "l-leg": "lLeg", "r-leg": "rLeg"
    };
    for (const seg of [...sheetData.cyberwareSegmentsRight, ...sheetData.cyberwareSegmentsLeft]) {
      const k = ZONE_I18N[seg.area] ?? seg.area;
      seg.areaLabel = game.i18n.localize(`CYBERPUNK.${k}`);
      // Per-zone option-slot used/total, computed earlier in _prepareCharacterItems (which runs first).
      const cap = sheetData.zoneCapacity?.[seg.area];
      seg.slotUsed = cap?.used ?? 0;
      seg.slotTotal = cap?.total ?? 0;
    }


    // Collect all programs that belong to this actor.
    const allPrograms = this.actor.items.filter(i => i.type === "program");
    allPrograms.sort((a, b) => a.name.localeCompare(b.name));
    sheetData.netrunPrograms = allPrograms;

    sheetData.programsTotalCost = allPrograms
    .reduce((sum, p) => sum + Number(p.system.cost || 0), 0);

    const activeProgIds = this.actor.system.activePrograms || [];
    const activePrograms = allPrograms.filter(p => activeProgIds.includes(p.id));
    sheetData.netrunActivePrograms = activePrograms;

    const allSkills = this.actor.items.filter(i => i.type === "skill");

    const interfaceName = game.i18n.localize("CYBERPUNK.SkillInterface");
    let interfaceItem = allSkills.find(i => i.name === interfaceName);

    let interfaceValue = 0;
    let interfaceItemId = null;
    if (interfaceItem) {
      interfaceValue = Number(interfaceItem.system?.level || 0);
      interfaceItemId = interfaceItem.id;
    }

    sheetData.interfaceSkill = {
      value: interfaceValue,
      itemId: interfaceItemId
    };

    return sheetData;
  }

  /**
   * V2 render hook — the single place all sheet interactivity is wired, as a table of contents of
   * native `_cpActivate*` helpers (tabs, file pickers, actions, form controls, cyberware, netrunning,
   * custom controls, notes, drag-drop). Each helper binds once on the persistent root.
   * @override
   */
  async _onRender(context, options) {
    await super._onRender?.(context, options);
    const root = this.element;
    // Tabs + tear-off wiring — extracted to an upstream-aligned helper (Stage A2).
    this._cpActivateTabs(root);
    // FilePicker (avatar/image) wiring — extracted to an upstream-aligned helper (Stage A2).
    this._cpActivateActorFilePickers(root);
    // Basic actor click actions (rolls + damage box) — upstream-aligned native helper (Stage A2).
    this._cpActivateBasicActorActions(root);
    // Form controls (SDP / skill-level / skill-sort / ask-mod / init+stun modifiers) — Stage A2.
    this._cpActivateActorFormControls(root);
    // Re-apply the skill-search DOM filter (+ clear-button state) every render so it persists.
    this._cpRefreshSkillSearchUI(root);
    // Cyberware controls (anatomy-select / chip-toggle / equip-unequip / chip tooltips) — Stage A2.
    this._cpActivateCyberwareControls(root);
    // Status-strip quick toggles (§3c visibility hybrid).
    this._cpActivateStatusStrip(root);
    // Netrunning controls (interface roll / program edit/trash / deactivate) — Stage A2.
    this._cpActivateNetrunningControls(root);
    // CP2020-specific controls (ammo toggle / shop / services / IP / martial) — Stage A2.
    this._cpActivateActorCustomControls(root);
    // GM-only Deep Space radiation panel controls (R3b): apply-dose / long-term / clear / cure.
    this._cpActivateRadiationControls(root);
    // Life-tab (system.notes) ProseMirror autosave — extracted to an upstream-aligned helper (Stage A2).
    this._cpActivateNotesEditor(root);
    // Drag-drop (drop-target dragover, gear sort, owned-item drag sources) — upstream-aligned helper (Stage A2).
    this._cpActivateActorDragDrop(root);
    // Restore the tab-body scroll LAST — after the active tab is switched on above, so the tall content
    // is laid out and the position isn't clamped. AppV2's own `scrollable` restore runs before this tab
    // activation, so it can't preserve scroll for our manual tabs; this does. Stage A2 complete otherwise.
    this._cpRestoreScroll(root);
  }

  /**
   * Preserve the tab-body scroll position across re-renders (a drop/edit re-renders the whole part and
   * would otherwise snap scroll to the top). A live scroll listener records the position on `this`
   * (survives re-renders); this runs at the end of _onRender — after the active tab is shown — to put it
   * back. Paired with PARTS.main scrollable:[".sheet-body"] + the CSS that makes .sheet-body the scroller.
   */
  _cpRestoreScroll(root) {
    const sb = root?.querySelector?.(".sheet-body");
    if (!sb) return;
    if (Number.isFinite(this._cpScrollTop)) sb.scrollTop = this._cpScrollTop;
    // Bind once per (replaced) element: record the user's scroll so the next re-render can restore it.
    if (sb.dataset.cpScrollBound !== "1") {
      sb.dataset.cpScrollBound = "1";
      sb.addEventListener("scroll", () => { this._cpScrollTop = sb.scrollTop; }, { passive: true });
    }
  }

  /**
   * Avatar / image FilePicker wiring. Mirrors upstream's `_cpActivateActorFilePickers`: a single
   * capture-phase listener on the persistent root opens a FilePicker when the avatar
   * ([data-edit="img"]) is clicked. The prior listener is removed before re-adding so it stays
   * single-bound across re-renders (the root element persists in V2). Extracted verbatim from
   * activateListeners in Stage A2 — still uses the same FilePicker namespacing.
   */
  _cpActivateActorFilePickers(root) {
    if (!root) return;

    if (this._cpAvatarCapture) {
      try {
        root.removeEventListener("pointerdown", this._cpAvatarCapture, { capture: true });
        root.removeEventListener("click", this._cpAvatarCapture, { capture: true });
      } catch (_) {}
    }

    const cpAvatarCapture = (ev) => {
      const editable = ev.target?.closest?.("[data-edit]");
      if (!editable) return;
      if ((editable.dataset?.edit || "") !== "img") return;

      ev.preventDefault();
      ev.stopImmediatePropagation?.();

      const fp = new (foundry.applications?.apps?.FilePicker?.implementation ?? foundry.applications?.apps?.FilePicker ?? FilePicker)({
        type: "image",
        activeSource: "data",
        current: "",
        callback: (path) => this.actor.update({ img: path })
      });
      // V2 FilePicker shows the browser on render; the legacy fp.browse(...) re-navigation throws
      // ("target.replace is not a function") because browse() expects a string path, not an object.
      fp.render(true);
    };

    root.addEventListener("pointerdown", cpAvatarCapture, { capture: true });
    root.addEventListener("click", cpAvatarCapture, { capture: true });
    this._cpAvatarCapture = cpAvatarCapture;

    // Netrunner persona icon picker (the .filepicker frame). Bound once (bubble phase); resolves
    // the control from event.target. (Moved from activateListeners in Stage A2.)
    if (root.dataset.cpFilePickerBound !== "1") {
      root.dataset.cpFilePickerBound = "1";
      root.addEventListener("click", (event) => {
        if (!event.target?.closest?.(".filepicker")) return;
        event.preventDefault();
        const currentPath = this.actor.system.icon || "";
        const fp = new (foundry.applications?.apps?.FilePicker?.implementation ?? foundry.applications?.apps?.FilePicker ?? FilePicker)({
          type: "image",
          current: currentPath,
          callback: (path) => {
            this.actor.update({ "system.icon": path });
            const img = root.querySelector(".netrun-icon-frame img");
            if (img) img.setAttribute("src", path);
            const input = root.querySelector('input[name="system.icon"]');
            if (input) input.value = path;
          }
        });
        fp.render(true);
      });
    }
  }

  /**
   * Status-strip quick toggles (§3c): one delegated click handler; a pill's × writes `false` to
   * the boolean path the row advertised (mech/status.js quickTogglePathOf — mechLight.on /
   * mechVision.on / equipped / EffectActive / ChipActive). Bind-once on the persistent root;
   * editable checked BEFORE the flag so a read-only first render doesn't consume the binding.
   */
  _cpActivateStatusStrip(root) {
    if (!root?.addEventListener) return;

    // Persist the collapsible strip's open/closed state across re-renders (the `toggle` event does not
    // bubble, so listen in the capture phase). This records DISPLAY state, not a document write, so it
    // must bind BEFORE the editable gate below — an observer (read-only) sheet keeps its open state too.
    // Its own bind-once guard, since the editable section's guard is skipped on a read-only sheet.
    if (root.dataset.cpStatusToggleBound !== "1") {
      root.dataset.cpStatusToggleBound = "1";
      root.addEventListener("toggle", (event) => {
        const d = event.target;
        if (d?.classList?.contains?.("cp-status-details")) this._cpStatusOpen = d.open;
      }, true);
    }

    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;
    if (root.dataset.cpStatusStripBound === "1") return;
    root.dataset.cpStatusStripBound = "1";

    root.addEventListener("click", async (event) => {
      const off = event.target.closest?.(".cp-pill-off");
      if (!off || !root.contains(off)) return;
      event.preventDefault();
      event.stopPropagation();
      // The addiction pill's × clears the WHOLE tally (per-drug history included, no undo) —
      // GM-only (the control renders only for the GM) and confirmed, unlike the reversible
      // quick-off ×s that share its look.
      if (off.dataset.action === "clear-addiction") {
        if (game.user?.isGM !== true) return;
        const ok = await foundry.applications.api.DialogV2.confirm({
          window: { title: localize("AddictionClearTitle") },
          content: `<p>${localizeParam("AddictionClearConfirm", { name: this.actor.name })}</p>`,
          rejectClose: false,
        });
        if (ok) await clearAddiction(this.actor);
        return;
      }
      // Orphaned drug marker (source item deleted): clear it from the strip — the marker is the
      // only thing left to act on, so this goes through the engine, not an item update.
      if (off.dataset.action === "clear-drug") {
        await clearDrugMarker(this.actor, off.dataset.itemId, off.dataset.penalty === "1");
        return;
      }
      const item = this.actor.items.get(off.dataset.itemId);
      const path = off.dataset.togglePath;
      if (!item || !path) return;
      await item.update({ [path]: false });
    });

    // Q5 vision picker: persist the governor choice ("" auto / "natural" / item id) on the actor.
    root.addEventListener("change", async (event) => {
      if (!event.target?.matches?.("select.cp-vision-pick")) return;
      event.stopPropagation();
      const v = event.target.value;
      if (v) await this.actor.setFlag("cp2020-augmented", "visionPick", v);
      else await this.actor.unsetFlag("cp2020-augmented", "visionPick");
    });

    // Full-conversion borg override: "on"/"off" force the fullBorg flag; "auto" clears it (detection
    // falls back to an equipped borg-body item). stopPropagation keeps the form's submitOnChange out.
    root.addEventListener("change", async (event) => {
      if (!event.target?.matches?.("select.cp-fullborg-select")) return;
      event.stopPropagation();
      const v = event.target.value;
      if (v === "on") await this.actor.setFlag("cp2020-augmented", "fullBorg", true);
      else if (v === "off") await this.actor.setFlag("cp2020-augmented", "fullBorg", false);
      else await this.actor.unsetFlag("cp2020-augmented", "fullBorg");
    });

    // Q6 container: the ⏏ on a nested (installed) row detaches it to loose inventory; the ⊗ on a
    // group anchor removes the whole group at once. Mousedown swallowed first so neither starts a drag.
    root.addEventListener("mousedown", (event) => {
      if (event.target?.closest?.(".cp-container-uninstall, .cp-group-remove")) { event.preventDefault(); event.stopPropagation(); }
    });
    root.addEventListener("click", async (event) => {
      const btn = event.target?.closest?.(".cp-container-uninstall");
      if (!btn || !root.contains(btn)) return;
      event.preventDefault();
      event.stopPropagation();
      const item = this.actor.items.get(btn.dataset.itemId);
      if (!item) return;
      // A cyberware compartment ⏏ routes through the type-aware cascade (unequip + shed host links for
      // the item AND its whole nested subtree) — the link-only detach left a cyberware container equipped,
      // popping back into the body map as a standalone zone root (RULED unification with ⊗ / the body ⏏).
      // _cpUninstallCyber updates {render:false}, so re-render here; uninstallItem re-renders on its own.
      if (item.type === "cyberware") { await this._cpUninstallCyber(item.id); this.render(true); }
      else await uninstallItem(item);
    });

    // ⊗ Clear a whole group from its anchor row — NON-DESTRUCTIVE: a loadout body UNEQUIPS its options
    // (they become carried, kept in inventory); a generic container detaches its children to loose
    // inventory. Nothing is deleted (deletion stays a deliberate per-item action).
    root.addEventListener("click", async (event) => {
      const btn = event.target?.closest?.(".cp-group-remove");
      if (!btn || !root.contains(btn)) return;
      event.preventDefault();
      event.stopPropagation();
      const item = this.actor.items.get(btn.dataset.itemId);
      if (!item) return;
      // The member set the ⊗ acts on must equal the count shown, or it "removes only some": a loadout
      // body's members are the options it spawned (by source flag), a generic container's are its nested
      // children (by ParentId). Use the same set for the confirm count and the action.
      const isLoad = hasLoadout(item);
      const items = this.actor.items.contents ?? [];
      const members = isLoad
        ? loadoutOptionsOf(this.actor, item.id)
        : childrenOf(items, item.id);
      if (!members.length) return;
      // Confirm-count parity: the generic ⊗ cascades each cyberware member with its whole nested
      // subtree (the per-item uninstall set), so count that acted set — not just the direct children —
      // or the dialog under-reports. Loadout members are already the flagged full set deactivateLoadout
      // removes, so their count stands as-is.
      let count = members.length;
      if (!isLoad) {
        const acted = new Set();
        for (const c of members) {
          acted.add(c.id);
          if (c.type === "cyberware") for (const d of descendantIds(items, c.id)) acted.add(d);
        }
        count = acted.size;
      }
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: localize("MechGroupRemoveTitle") },
        content: `<p>${localizeParam("MechGroupRemoveConfirm", { count, name: item.name })}</p>`,
        rejectClose: false,
      });
      if (!ok) return;
      if (isLoad) await deactivateLoadout(this.actor, item.id);
      // Generic container (user-ruled 2026-07-10): the control's wording promises UNEQUIP, so
      // cyberware members leave the body for Carried (the full uninstall cascade — detach-only
      // left them equipped, popping back into the zone as standalone roots); stowed non-cyberware
      // just detaches to loose inventory (it has no equipped state to shed).
      else for (const c of members) {
        if (c.type === "cyberware") await this._cpUninstallCyber(c.id);
        else await uninstallItem(c);
      }
      // _cpUninstallCyber updates {render:false}, so nothing repaints until an unrelated re-render —
      // repaint now. (The loadout branch's deactivateLoadout re-renders itself; a second is harmless.)
      this.render(true);
    });

    // Chassis delete (the 🗑 on the chassis strip): remove the full-borg body, deciding at delete-time
    // what happens to its currently-ATTACHED options — delete them with the chassis, or unequip them to
    // Carried Options (kept). Options already shelved to Carried aren't touched (pruneLoadout is
    // equipped-only). A bare chassis (no attached options) just confirms.
    root.addEventListener("click", async (event) => {
      const btn = event.target?.closest?.(".cp-chassis-delete");
      if (!btn || !root.contains(btn)) return;
      event.preventDefault();
      event.stopPropagation();
      const body = this.actor.items.get(btn.dataset.itemId);
      if (!body) return;
      const items = this.actor.items.contents ?? [];
      const attached = loadoutOptionsOf(this.actor, body.id).filter(it => it.system?.equipped === true);
      // The acted set for the delete-time choice is the flagged attached members PLUS anything
      // personally nested inside them (descendantIds) — a user-added option in an attached mount must
      // not survive equipped + pointing at the deleted/carried host (mirrors the per-item cascade).
      const actedIds = new Set();
      for (const it of attached) { actedIds.add(it.id); for (const d of descendantIds(items, it.id)) actedIds.add(d); }
      const DialogV2 = foundry.applications.api.DialogV2;
      let choice = "delete-body";
      if (attached.length) {
        choice = await DialogV2.wait({
          window: { title: localize("BorgDeleteTitle") },
          content: `<p>${localizeParam("BorgDeleteAttachedPrompt", { name: body.name, count: attached.length })}</p>`,
          buttons: [
            { action: "unequip", label: localize("BorgDeleteOptionsUnequip"), icon: "fas fa-box", default: true, callback: () => "unequip" },
            { action: "delete", label: localize("BorgDeleteOptionsDelete"), icon: "fas fa-trash", callback: () => "delete" },
            { action: "cancel", label: localize("Cancel"), icon: "fas fa-times", callback: () => "cancel" },
          ],
          rejectClose: false,
        }).catch(() => "cancel");
      } else {
        const ok = await DialogV2.confirm({
          window: { title: localize("BorgDeleteTitle") },
          content: `<p>${localizeParam("BorgDeleteBarePrompt", { name: body.name })}</p>`,
          rejectClose: false,
        });
        if (!ok) return;
      }
      if (choice === "cancel" || !choice) return;
      if (choice === "unequip") {
        // Keep the attached options + their nested extras: unequip + clear host links → Carried, before
        // the body delete (so pruneLoadout's equipped-only sweep finds nothing of theirs to take). The
        // cyberware keys are stripped on a stowed non-cyberware descendant (a no-op), so it travels with
        // its carried mount rather than detaching loose.
        await this.actor.updateEmbeddedDocuments("Item", [...actedIds].map(id => ({
          _id: id, "system.equipped": false, "system.Module.ParentId": "", "system.CyberBodyType.Location": "",
        })));
      } else if (choice === "delete") {
        await this.actor.deleteEmbeddedDocuments("Item", [...actedIds]);
      }
      await body.delete();
    });
  }

  /**
   * Tab wiring. Mirrors upstream's `_cpActivateTabs`: binds Foundry's Tabs UX class with the V1
   * selectors (V2 dropped the auto-`tabs` option), preserving the active tab across re-renders,
   * then wires the press-and-hold tear-off gesture and refreshes which tabs are popped out.
   * Consolidated from the inline _onRender binding + activateListeners in Stage A2.
   */
  _cpActivateTabs(root) {
    try {
      const TabsCls = foundry.applications?.ux?.Tabs?.implementation
        ?? foundry.applications?.ux?.Tabs
        ?? globalThis.Tabs;
      if (TabsCls) {
        this._cpTabs = new TabsCls({
          ...CyberpunkActorSheet.TAB_CONFIG,
          initial: this._cpActiveTab ?? CyberpunkActorSheet.TAB_CONFIG.initial,
          callback: (_ev, _tabs, active) => {
            this._cpActiveTab = active;
            // Navigating away from the life tab while editing notes: persist + drop back to the
            // read-only view (mirrors upstream's tab-switch guard, adapted to our Tabs-class flow).
            if (this._cpNotesEditing && active !== "life") {
              this._cpExitNotesEditing(getHtmlElement(this.element) ?? root, { render: true });
            }
          },
        });
        this._cpTabs.bind(root);
      }
    } catch (e) { console.warn("cyberpunk2020 | actor-sheet tab bind failed", e); }

    // Tear-off tabs: press-and-hold a tab, then drag it out to pop it into its own window.
    this._activateTabTearOff(root);
    this._refreshDetachedTabs();
  }

  /**
   * Actor drag-drop wiring. Mirrors upstream's `_cpActivateActorDragDrop`: prevents default dragover
   * on declared drop targets, wires the gear-tab reorder / drag-off-to-delete gestures, and (on an
   * editable sheet) makes owned-item rows drag sources. Per-node `draggableInit` + the gear helper's
   * own guards keep it safe to call every render. (Framework dragstart/drop are declared in
   * DEFAULT_OPTIONS.dragDrop.) Consolidated from activateListeners in Stage A2.
   */
  _cpActivateActorDragDrop(root) {
    if (!root) return;

    // Prevent default dragover on declared drop targets (bound to the per-render child elements).
    $(root).find('[data-drop-target]').on('dragover', (ev) => ev.preventDefault());

    // Gear tab: drag a row to reorder, or drag it off the window to delete.
    this._activateGearDragSort(root);

    // Owned-item drag sources — only on an editable sheet (preserves the prior placement after the
    // activateListeners editable guard).
    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;

    const el = getHtmlElement(root);
    if (!el?.querySelectorAll) return;

    const selector = [
      '.field[data-item-id]',
      '.item[data-item-id]',
      '.skill[data-item-id]',
      '.gear[data-item-id]',
      '.fire-weapon[data-item-id]',
      '.netrun-program[data-item-id]',
      '.chipware[data-item-id]'
    ].join(',');

    el.querySelectorAll(selector).forEach((node) => {
      if (node.dataset.draggableInit === '1') return;
      if (node.closest?.('.item-delete, .item-unequip, .item-controls')) return;

      node.dataset.draggableInit = '1';
      node.setAttribute('draggable', 'true');
      node.addEventListener('dragstart', (ev) => {
        const id = node.dataset.itemId;
        const it = this.actor.items.get(id);
        if (!it) return;
        this._cpWriteOwnedItemDragData(ev, it);
        node.classList.add('is-dragging');   // visual feedback (CSS styles .netrun-program.is-dragging)
      });
      node.addEventListener('dragend', () => node.classList.remove('is-dragging'));
    });
  }

  /** Resolve the owned Item from a clicked element: the control's own data-item-id / data-skill-id,
   *  else the nearest [data-item-id]/[data-skill-id] ancestor. Mirrors upstream's
   *  `_cpGetItemFromTarget`; used by the native item-control dispatch in _cpActivateBasicActorActions. */
  _cpGetItemFromTarget(target) {
    const itemId = target?.dataset?.itemId
      ?? target?.dataset?.skillId
      ?? target?.closest?.("[data-item-id]")?.dataset?.itemId
      ?? target?.closest?.("[data-skill-id]")?.dataset?.skillId;
    return this.actor.items.get(itemId);
  }

  /**
   * Basic actor click actions — stat / Facedown / Recognition / skill / initiative / stun-death
   * rolls and the wound-track damage box. Mirrors upstream's `_cpActivateBasicActorActions`: one
   * delegated click listener on the persistent root, dispatched via `target.closest(...)`, bound
   * once per window (the root persists across V2 re-renders, so binding every render would stack
   * duplicates). Native-DOM rewrite of the former per-element jQuery `.click` handlers (Stage A2);
   * covered by tests/v14/actor-basic-actions.spec.js.
   * Also handles the item controls (open / roll / delete + right-click delete), active-chip open,
   * and the weapon "fire" control. Dispatch order: item controls are checked BEFORE `.fire-weapon`,
   * because the item image (`.item-edit`) is nested inside `.fire-weapon` — clicking the image opens
   * the item sheet, clicking elsewhere in the fire area fires. (See DEV-GUIDE.md Part 6 for the
   * event-propagation reason this coupling exists.)
   */
  _cpActivateBasicActorActions(root) {
    if (!root?.addEventListener) return;
    // Editable-only (these were after the activateListeners editable guard). Check editable BEFORE
    // setting the bound flag, so a non-editable first render doesn't consume the one-time binding.
    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;
    if (root.dataset.cpBasicActorActionsBound === "1") return;
    root.dataset.cpBasicActorActionsBound = "1";

    root.addEventListener("click", (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const statRoll = target.closest(".stat-roll");
      if (statRoll) {
        this._cpRollStatFromElement(statRoll);
        return;
      }

      const facedown = target.closest(".facedown-roll");
      if (facedown) {
        event.preventDefault();
        cpRollFacedown(this.actor);
        return;
      }

      const recognition = target.closest(".recognition-roll");
      if (recognition) {
        event.preventDefault();
        cpRollRecognition(this.actor);
        return;
      }

      const skillRoll = target.closest(".skill-roll");
      if (skillRoll) {
        this._cpRollSkillFromElement(skillRoll);
        return;
      }

      const initiative = target.closest(".roll-initiative");
      if (initiative) {
        const input = root.querySelector(".roll-initiative-modificator");
        this.actor.addToCombatAndRollInitiative(input?.value);
        return;
      }

      const stunDeath = target.closest(".stun-death-save");
      if (stunDeath) {
        const input = root.querySelector(".roll-stun-death-modificator");
        this.actor.rollStunDeath(input?.value);
        return;
      }

      const damageBox = target.closest(".damage");
      if (damageBox) {
        this.actor.update({ "system.damage": Number(damageBox.dataset.damage) });
        return;
      }

      // Item controls — checked before .fire-weapon (the image is nested inside it). Delete is
      // checked before edit so a delete button inside an edit row deletes rather than opens.
      const itemDelete = target.closest(".item-delete");
      if (itemDelete) {
        event.stopPropagation();
        this._confirmDeleteItem(this._cpGetItemFromTarget(itemDelete));
        return;
      }

      const itemEdit = target.closest(".item-edit");
      if (itemEdit) {
        // The uninstall / clear / chassis-delete controls live inside an (item-edit) row — let their own
        // handlers run instead of opening the item sheet.
        if (target.closest(".item-unequip, .cp-container-uninstall, .cp-group-remove, .cp-chassis-delete")) return;
        event.stopPropagation();
        this._cpGetItemFromTarget(itemEdit)?.sheet?.render(true);
        return;
      }

      const itemRoll = target.closest(".item-roll");
      if (itemRoll) {
        event.stopPropagation();
        this._cpGetItemFromTarget(itemRoll)?.roll();
        return;
      }

      const chip = target.closest(".chipware-container .chipware[data-item-id]");
      if (chip) {
        if (target.closest(".item-unequip, .item-delete")) return;
        event.stopPropagation();
        const item = this._cpGetItemFromTarget(chip);
        if (item) item.sheet.render(true);
        return;
      }

      // Weapon "fire" control — last, so a click on the nested item image is handled by item-edit above.
      const fireWeapon = target.closest(".fire-weapon");
      if (fireWeapon) {
        event.stopPropagation();
        this._cpOpenWeaponAttackDialog(this._cpGetItemFromTarget(fireWeapon));
        return;
      }
    });

    // Right-click delete on a row. (Adopts upstream's behaviour: suppress the browser context menu.)
    root.addEventListener("contextmenu", (event) => {
      const rowDelete = event.target?.closest?.(".rc-item-delete");
      if (!rowDelete) return;
      event.preventDefault();
      event.stopPropagation();
      this._confirmDeleteItem(this._cpGetItemFromTarget(rowDelete));
    });
  }

  /**
   * Roll a skill from its `.skill-roll` element. If the skill has askMods set — or equipped gear
   * advertises a bonus to this skill (P5 mechRollMods) — open a ModifiersDialog first (gear
   * suggestions + extra-mod + adv/dis), otherwise roll directly. Checked gear rows fold into the
   * roll's extraMod term. (Was the inline .skill-roll handler.)
   */
  _cpRollSkillFromElement(el) {
    const id = el?.dataset?.skillId;
    const skill = this.actor.items.get(id);
    if (!skill) return;

    // Zone gate (M19): providers hosted in a destroyed limb don't reach the roll dialog.
    const gearProviders = skillModProviders(contributingItems(this.actor), skill.name);

    return this._cpRollWithProviders(gearProviders, skill.system?.askMods,
      () => this.actor.rollSkill(id),
      (mod, opts) => this.actor.rollSkill(id, mod, !!opts.advantage, !!opts.disadvantage, !!opts.hiddenAdvantage),
      "ModifiersSkillTitle");
  }

  /**
   * Q9 (Photo Memory): roll a bare STAT from its `.stat-roll` element. If equipped gear advertises a
   * bonus to this stat (mechRollMods.statName/statMod), open the Modifiers dialog and fold the checked
   * rows into the roll; otherwise roll directly via the base rollStat (unchanged for the common case).
   */
  _cpRollStatFromElement(el) {
    const statName = el?.dataset?.statName;
    if (!statName) return;
    // Zone gate (M19): a stat provider hosted in a destroyed limb doesn't reach the roll (matches the
    // skill path :698 and the attack path :784, which both pass contributingItems).
    const gearProviders = statModProviders(contributingItems(this.actor), statName);
    return this._cpRollWithProviders(gearProviders, false,
      () => this.actor.rollStat(statName),
      (mod) => this._cpRollStatWithMod(statName, mod),
      "ModifiersStatTitle");
  }

  /** Roll a bare stat with a folded modifier (Q9). Self-contained via makeD10Roll + toMessage —
   *  only reached when a stat provider is active, so the base rollStat styling is untouched otherwise. */
  async _cpRollStatWithMod(statName, mod) {
    const flavor = localize(properCase(statName) + "Full");
    const terms = [`@stats.${statName}.total`];
    if (mod) terms.push(String(mod));
    const roll = await makeD10Roll(terms, this.actor.system).evaluate();
    await roll.toMessage({ flavor, speaker: ChatMessage.getSpeaker({ actor: this.actor }) });
    return roll;
  }

  /** Shared opener: with providers or askMods, show the Modifiers dialog (gear rows + extraMod +
   *  adv/dis) and fold the checked rows via `confirm(mod, opts)`; else call `direct()`. */
  _cpRollWithProviders(gearProviders, askMods, direct, confirm, titleKey) {
    if (askMods || gearProviders.length) {
      const modifierGroups = [];
      if (gearProviders.length) modifierGroups.push(gearModGroup(gearProviders));
      modifierGroups.push([
        { localKey: "ExtraModifiers", dataPath: "extraMod", defaultValue: 0 }
      ]);
      const dlg = new ModifiersDialog(this.actor, {
        title: localize(titleKey),
        showAdvDis: true,
        modifierGroups,
        onConfirm: (options) => {
          const mod = (Number(options.extraMod) || 0) + gearModSum(options, gearProviders);
          return confirm(mod, options);
        }
      });
      return dlg.render(true);
    }
    return direct();
  }

  /**
   * Open the attack (Modifiers) dialog for a weapon: build the target list + ranged/martial/melee
   * modifier groups (with auto-rangefinding when exactly one target is selected) and fire via the
   * dialog's onConfirm. Body ported verbatim from the former .fire-weapon jQuery handler (Stage A2);
   * mirrors upstream's `_cpOpenWeaponAttackDialog`.
   */
  _cpOpenWeaponAttackDialog(item) {
    if (!item) return;
    let isRanged = item.isRanged();

    // Saved attack options: pre-fill the dialog with this weapon's last-used choices. Ranged
    // restores the fire mode; melee restores martial art + cyberlimb terminus. (Our martial flow
    // picks the ACTION via the combat-tab button panel, not the dialog, so upstream's saved
    // `action` is intentionally not ported — see the re-seat earmark.)
    const savedAttackOptions = isRanged
      ? this._cpGetSavedRangedAttackOptions(item)
      : this._cpGetSavedMeleeAttackOptions(item);

    let modifierGroups = undefined;
    let targetTokens = Array.from(game.users.current.targets.values()).map(target => {
      return {
        name: target.document.name,
        id: target.id};
    });

    // P5 mechRollMods: equipped gear advertising a ranged-attack bonus (smartgun link, targeting
    // scope) becomes a suggestion row in the dialog; checked rows fold into extraMod on confirm.
    // Ranged only — every wired attack provider is a ranged aid (see mech/roll-mods.js).
    // Zone gate (M19): providers hosted in a destroyed limb don't reach the dialog.
    const gearProviders = isRanged ? attackModProviders(contributingItems(this.actor)) : [];

    if(isRanged) {
      modifierGroups = rangedModifiers(item, targetTokens, savedAttackOptions);
      if (gearProviders.length) modifierGroups.push(gearModGroup(gearProviders));

      // ── Automated Rangefinding ──────────────────────────────────────────
      // If enabled and exactly one target is selected, measure the token
      // distance and pre-select the correct range category in the dialog.
      const rangefindingEnabled = autoRangefindingEnabled();

      if (rangefindingEnabled && targetTokens.length === 1) {
        const attackerToken = canvas?.tokens?.placeables?.find(
          t => t.actor?.id === this.actor.id
        ) ?? null;
        const targetTokenPlaceable = canvas?.tokens?.placeables?.find(
          t => t.id === targetTokens[0].id
        ) ?? null;

        if (attackerToken && targetTokenPlaceable) {
          const rangeResult = resolveAttackRange(item, attackerToken, targetTokenPlaceable);

          // rangeResult.category is e.g. "pointBlank" — map to ranges key string
          const CATEGORY_TO_RANGE_KEY = {
            pointBlank:  "RangePointBlank",
            close:       "RangeClose",
            medium:      "RangeMedium",
            long:        "RangeLong",
            extreme:     "RangeExtreme",
            outOfRange:  "RangeExtreme",   // still show dialog, GM can see it's extreme
          };
          const rangeKey = CATEGORY_TO_RANGE_KEY[rangeResult.category] ?? "RangeClose";

          // Localized plain category name for the GM-facing note/notifications. This is the only
          // consumer of rangefinding.js's English LABELS, so the render edge lives here.
          const RANGE_CAT_LABEL_KEY = {
            pointBlank: "RangeCatPointBlank", close: "RangeCatClose", medium: "RangeCatMedium",
            long: "RangeCatLong", extreme: "RangeCatExtreme", outOfRange: "RangeCatOutOfRange",
          };
          const rangeLabel = localize(RANGE_CAT_LABEL_KEY[rangeResult.category] ?? "RangeCatClose");

          // modifierGroups[0] is the first row; [1] is the Range selector
          if (modifierGroups?.[0]?.[1]?.dataPath === "range") {
            modifierGroups[0][1].defaultValue = rangeKey;
            // Add distance info to the label so the GM can see the measurement
            modifierGroups[0][1]._rangefindingNote =
              localize("RangefindingNote", { range: rangeLabel, dist: rangeResult.distanceMeters, max: rangeResult.longRange });
          }

          // Notify in chat log so GM can see the auto-selected range
          if (rangeResult.category === "outOfRange") {
            ui.notifications.warn(
              localize("RangefindingBeyondExtreme", { name: item.name, dist: rangeResult.distanceMeters, max: rangeResult.longRange * 2 })
            );
          } else {
            ui.notifications.info(
              localize("RangefindingInfo", { range: rangeLabel, dist: rangeResult.distanceMeters, max: rangeResult.longRange })
            );
          }
        }
      }
      // ───────────────────────────────────────────────────────────────────
    }
    else if ((item._getWeaponSystem?.().attackType) === meleeAttackTypes.martial) {
      modifierGroups = martialOptions(this.actor, savedAttackOptions);
    }
    else {
      modifierGroups = meleeBonkOptions(savedAttackOptions);
    }

    // Q9 (Ambidexterity): gear rows whose bonus applies ONLY when dual-wielding — the dialog shows
    // them only while the Dual Wield checkbox is ticked. gearMod_<id> is the input name.
    const dualWieldGearPaths = gearProviders.filter(g => g.dualWieldOnly).map(g => `gearMod_${g.id}`);

    let dialog = new ModifiersDialog(this.actor, {
      weapon: item,
      targetTokens: targetTokens,
      modifierGroups: modifierGroups,
      dualWieldGearPaths,
      onConfirm: async (fireOptions) => {
        // Persist the chosen options so the next attack with this weapon pre-fills them.
        if (isRanged) await this._cpSaveRangedAttackOptions(item, fireOptions);
        else await this._cpSaveMeleeAttackOptions(item, fireOptions);
        if (gearProviders.length) {
          // Q9: a dual-wield-only provider (Ambidexterity) folds in only when Dual Wield is on —
          // even if its (hidden) row stayed pre-ticked, an off dual-wield state excludes it.
          const effective = gearProviders.filter(g => !g.dualWieldOnly || fireOptions.dualWield);
          fireOptions.extraMod = (Number(fireOptions.extraMod) || 0) + gearModSum(fireOptions, effective);
        }
        return item.__weaponRoll(fireOptions, targetTokens);
      }
    });
    dialog.render(true);
    return dialog;
  }

  /**
   * Read a weapon's last-used RANGED attack options ({ fireMode }) from its flags. Returns a plain
   * mutable copy (empty object if none saved). Mirrors upstream's `_cpGetSavedRangedAttackOptions`.
   */
  _cpGetSavedRangedAttackOptions(item) {
    return foundry.utils.duplicate(item?.getFlag?.("cyberpunk2020", "lastRangedAttackOptions") ?? {});
  }

  /**
   * Persist a weapon's RANGED attack options after a roll (only the fire mode, and only when it
   * changed — avoids a needless document update / re-render). Mirrors upstream's
   * `_cpSaveRangedAttackOptions`.
   */
  async _cpSaveRangedAttackOptions(item, fireOptions) {
    if (!item?.update) return;
    const saved = this._cpGetSavedRangedAttackOptions(item);
    const fireMode = fireOptions?.fireMode;
    if (fireMode === undefined || fireMode === saved.fireMode) return;
    await item.update(
      { "flags.cyberpunk2020.lastRangedAttackOptions": { ...saved, fireMode } },
      { render: false }
    );
  }

  /**
   * Read a weapon's last-used MELEE attack options ({ martialArt, cyberTerminus }) from its flags.
   * Returns a plain mutable copy (empty object if none saved). Mirrors upstream's
   * `_cpGetSavedMeleeAttackOptions`.
   */
  _cpGetSavedMeleeAttackOptions(item) {
    return foundry.utils.duplicate(item?.getFlag?.("cyberpunk2020", "lastMeleeAttackOptions") ?? {});
  }

  /**
   * Persist a weapon's MELEE attack options after a roll. We save the martial art + cyberlimb
   * terminus (whichever the dialog supplied) and only when they changed. Upstream also saves a
   * martial `action`, but our martial flow chooses the action via the combat-tab button panel, so
   * that field is intentionally skipped (re-seat earmark). Mirrors upstream's
   * `_cpSaveMeleeAttackOptions` otherwise.
   */
  async _cpSaveMeleeAttackOptions(item, fireOptions) {
    if (!item?.update) return;
    const saved = this._cpGetSavedMeleeAttackOptions(item);
    const next = { ...saved };
    let changed = false;
    if (fireOptions?.martialArt !== undefined && fireOptions.martialArt !== saved.martialArt) {
      next.martialArt = fireOptions.martialArt;
      changed = true;
    }
    if (fireOptions?.cyberTerminus !== undefined && fireOptions.cyberTerminus !== saved.cyberTerminus) {
      next.cyberTerminus = fireOptions.cyberTerminus;
      changed = true;
    }
    if (!changed) return;
    await item.update(
      { "flags.cyberpunk2020.lastMeleeAttackOptions": next },
      { render: false }
    );
  }

  /**
   * Actor form controls — SDP current, skill-level (select-on-click / Enter-to-blur / change),
   * skill-sort, skill-ask-mod, and the initiative / stun-death modifier fields. Mirrors upstream's
   * `_cpActivateActorFormControls`: native click/keydown/change listeners on the persistent root,
   * dispatched via `closest`/`matches`, bound once per window. Native-DOM rewrite of the former
   * jQuery handlers (Stage A2); covered by tests/v14/actor-form-controls.spec.js.
   * Skill search is also handled here now: typing filters the rendered rows in place via
   * `_cpApplySkillFilterToDOM` (upstream's no-re-render approach), instead of our old re-render filter.
   */
  _cpActivateActorFormControls(root) {
    if (!root?.addEventListener) return;
    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;
    if (root.dataset.cpActorFormControlsBound === "1") return;
    root.dataset.cpActorFormControlsBound = "1";

    root.addEventListener("click", (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const skillLevel = target.closest(".skill-level");
      if (skillLevel) { skillLevel.select?.(); return; }

      const askMods = target.closest(".skill-ask-mod");
      if (askMods) { event.stopPropagation(); return; }

      const clearSearch = target.closest('[data-action="clear-skill-search"], .skill-search-clear');
      if (clearSearch) {
        event.preventDefault();
        event.stopPropagation();
        const input = root.querySelector("input.skill-search");
        if (input) { input.value = ""; input.focus({ preventScroll: true }); }
        this._cpSkillFilter = "";
        this._cpRefreshSkillSearchUI(root);
        return;
      }

      // Cyberlimb repair (armor-display SDP row): restore the limb's SDP + clear its disabled/
      // destroyed flag.
      const repairLimb = target.closest(".cp-cyberlimb-repair");
      if (repairLimb) {
        event.preventDefault();
        const zone = repairLimb.dataset.zone;
        if (zone) repairCyberlimb(this.actor, zone);
        return;
      }
    });

    root.addEventListener("keydown", (event) => {
      const target = event.target;
      if (!target?.matches?.(".skill-level")) return;
      if (event.key === "Enter") {
        event.preventDefault();
        target.blur();
      }
    });

    root.addEventListener("change", async (event) => {
      const target = event.target;
      if (!target?.matches) return;

      if (target.matches('input[name^="system.sdp.current."]')) {
        const path = target.getAttribute("name");
        const zone = path?.split(".").pop();
        // system.sdp.current is a bare ObjectField with a default floor: a dotted single-zone update
        // resets the OTHER zones to 0, which the base prep then heals back to sum (full) — so editing
        // one zone on a borg's sheet silently heals every other zone. Write the WHOLE object instead
        // (mech/cyberlimb.js absorbCyberlimbHit does the same; feedback-datamodel-partial-updates §7).
        if (zone) {
          const next = { ...(this.actor.system?.sdp?.current ?? {}), [zone]: Number(target.value || 0) };
          await this.actor.update({ "system.sdp.current": next });
        }
        return;
      }
      if (target.matches(".skill-level")) { await this._cpSaveSkillLevelFromInput(target); return; }
      if (target.matches(".skill-sort > select, .skill-sort select")) { this.actor.sortSkills(target.value); return; }
      if (target.matches(".skill-ask-mod")) { await this._cpUpdateAskModsFromInput(target); return; }
      if (target.matches(".roll-initiative-modificator")) { await this.actor.update({ "system.initiativeMod": Number(target.value) }); return; }
      if (target.matches(".roll-stun-death-modificator")) { await this.actor.update({ "system.StunDeathMod": Number(target.value) }); return; }

      // Generic data-edit fields (custom inputs that store via data-edit / data-dtype, not `name`).
      if (target.matches("input[data-edit], select[data-edit], textarea[data-edit]")) {
        event.preventDefault();
        const path = target.dataset.edit;
        const dtype = target.dataset.dtype;
        let value = target.value;
        if (dtype === "Number") { value = Number(value || 0); if (target.type === "checkbox") value = target.checked ? 1 : 0; }
        else if (dtype === "Boolean") { value = target.checked; }
        this.actor.update({ [path]: value });
        return;
      }
    });

    // Skill search: filter the rendered rows in place (upstream's DOM-filter approach) instead of
    // re-rendering. The filter is re-applied on every render via _cpRefreshSkillSearchUI (_onRender),
    // so it persists across re-renders.
    root.addEventListener("input", (event) => {
      if (!event.target?.matches?.("input.skill-search")) return;
      this._cpSkillFilter = event.target.value || "";
      this._cpRefreshSkillSearchUI(root);
    });

    // Keep focus in the search box when its × clear button is pressed (don't let mousedown blur it).
    const preventClearBlur = (event) => {
      if (!event.target?.closest?.('[data-action="clear-skill-search"], .skill-search-clear')) return;
      event.preventDefault();
    };
    root.addEventListener("pointerdown", preventClearBlur);
    root.addEventListener("mousedown", preventClearBlur);
  }

  /** Filter the rendered skill rows in place (mirrors upstream's `_cpApplySkillFilterToDOM`): show
   *  rows whose skill name contains the case-insensitive query, hide the rest. No re-render.
   *  (Match logic is name-substring for now — see [[feature-idea-skill-search-matching]] for the
   *  planned multi-term "OR" upgrade.) */
  _cpApplySkillFilterToDOM(root, filter) {
    const normalized = String(filter ?? "").trim().toUpperCase();
    for (const row of root.querySelectorAll(".field.skill[data-item-id]")) {
      const skill = this.actor.items.get(row.dataset.itemId);
      const haystack = String(skill?.name ?? "").toUpperCase();
      const match = !normalized || haystack.includes(normalized);
      row.classList.toggle("cp-hidden", !match);
    }
  }

  /** Re-apply the current skill filter to the DOM + toggle the clear (×) button's visibility. Called
   *  on every render (so the filter survives re-renders) and on search input / clear. */
  _cpRefreshSkillSearchUI(root) {
    if (!root) return;
    const filter = this._cpSkillFilter ?? "";
    const clear = root.querySelector(".skill-search-clear");
    if (clear) clear.classList.toggle("is-visible", !!filter);
    this._cpApplySkillFilterToDOM(root, filter);
  }

  /**
   * Cyberware-tab controls. Mirrors upstream's `_cpActivateCyberwareControls`: native bind-once
   * mousedown/click (equip-unequip via _onActiveUnequip) and change (anatomy body-type select +
   * chip-toggle). Chip hover-tooltips are re-attached every render via _cpActivateChipTooltips
   * (our feature; upstream's same-named helper is an empty stub). Native-DOM rewrite of the former
   * jQuery handlers (Stage A2); covered by tests/v14/actor-cyberware-controls.spec.js.
   */
  _cpActivateCyberwareControls(root) {
    if (!root?.addEventListener) return;

    // Chip hover-tooltips re-attach to the (re-rendered) .chipware elements every render.
    this._cpActivateChipTooltips(root);

    // Check editable BEFORE setting the bound flag, so a non-editable first render doesn't consume
    // the one-time binding (otherwise the listeners would never bind once the sheet becomes editable).
    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;
    if (root.dataset.cpCyberwareControlsBound === "1") return;
    root.dataset.cpCyberwareControlsBound = "1";

    // item-unequip: swallow the mousedown (so the X can't start a drag), then unequip on click.
    root.addEventListener("mousedown", (event) => {
      if (!event.target?.closest?.(".item-unequip")) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    });
    root.addEventListener("click", async (event) => {
      if (!event.target?.closest?.(".item-unequip")) return;
      await this._onActiveUnequip(event);
    });

    root.addEventListener("change", async (event) => {
      const target = event.target;
      if (!target?.matches) return;

      if (target.matches(".anatomy-select")) {
        const key = target.value;
        const valid = Object.prototype.hasOwnProperty.call(ANATOMY_IMAGES, key) ? key : DEFAULT_ANATOMY_KEY;
        await this.actor.setFlag("cyberpunk2020", "anatomyImage", valid);
        return;
      }
      if (target.matches(".chip-toggle input[data-skill-id]")) {
        await this._cpSetSkillChipActiveFromInput(target);
        return;
      }
    });
  }

  /**
   * Activate/deactivate a skill's chip from its `.chip-toggle` checkbox: if linked chip cyberware
   * exists, flip its ChipActive flag and re-sync chip↔skill levels/flags; otherwise set the skill's
   * own isChipped flag. (Body ported verbatim from the former jQuery chip-toggle handler; Stage A2.)
   */
  async _cpSetSkillChipActiveFromInput(input) {
    const checked = !!input.checked;
    const skillId = input.dataset.skillId;
    const skill = this.actor.items.get(skillId);
    if (!skill || skill.type !== "skill") return;

    const skillName = skill.name;

    const chips = this.actor.items.filter(i => {
      if (i.type !== "cyberware") return false;
      if (!cwHasType(i, "Chip")) return false;
      if (i.system?.equipped === false) return false;
      const map = i.system?.CyberWorkType?.ChipSkills;
      if (!map) return false;

      return (skillId && Object.prototype.hasOwnProperty.call(map, skillId)) ||
            Object.prototype.hasOwnProperty.call(map, skillName);
    });

    if (chips.length) {
      const updates = chips.map(ch => ({
        _id: ch.id,
        "system.CyberWorkType.ChipActive": checked
      }));
      await this.actor.updateEmbeddedDocuments("Item", updates, { render: false });

      await this._cp_syncChipLevelsToSkills();
      await this._cp_syncActiveFlagsToSkills();
    } else {
      await skill.update({
        "system.isChipped": checked,
        ...deleteFieldUpdate("system.chipped")
      }, { render: false });
    }

    if (this.rendered) this.render(true);
    for (const ch of chips) if (ch.sheet?.rendered) ch.sheet.render(true);
    if (skill.sheet?.rendered) skill.sheet.render(true);
  }

  /**
   * Hover tooltips for the active-chip tiles (shows the chip's full name). Re-created every render
   * (the singleton tooltip div is cleaned up via _cpChipTooltipCleanup) and re-attached to the new
   * .chipware elements. PopOut!-aware: the tooltip + hide-listeners follow the chip's document.
   * (Our feature — upstream's same-named helper is an empty stub.)
   */
  _cpActivateChipTooltips(root) {
    if (this._cpChipTooltipCleanup) {
      try { this._cpChipTooltipCleanup(); } catch (_) {}
      this._cpChipTooltipCleanup = null;
    }

    const tooltip = document.createElement("div");
    tooltip.className = "chip-tooltip";
    document.body.appendChild(tooltip);

    const HIDE_EVENTS = ["drop", "dragend", "click", "mousedown", "mouseup"];
    let listenerDoc = null;  // PopOut!: which document the hide-listeners are bound to (moves on popout)

    // Inline display (not a CSS class) is deliberate: the tooltip is a free-floating element that
    // gets adoptNode'd between documents for PopOut!, so it must hide/show without depending on a
    // stylesheet class being present in whichever document it currently lives in.
    function hideTooltip() {
      tooltip.style.display = "none";
    }

    // PopOut!: keep the hide-on-interaction listeners on whichever document the tooltip currently lives in.
    function bindHideListeners(doc) {
      if (listenerDoc === doc) return;
      if (listenerDoc) for (const e of HIDE_EVENTS) listenerDoc.removeEventListener(e, hideTooltip);
      for (const e of HIDE_EVENTS) doc.addEventListener(e, hideTooltip);
      listenerDoc = doc;
    }

    function showTooltip(chip) {
      const fullName = chip.dataset.full;
      if (!fullName) return;

      const doc = chip.ownerDocument;
      if (tooltip.ownerDocument !== doc) { doc.adoptNode(tooltip); doc.body.appendChild(tooltip); }
      bindHideListeners(doc);

      tooltip.textContent = fullName;
      tooltip.style.display = "block";

      const rect = chip.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();

      tooltip.style.top = `${rect.top - tooltipRect.height - 6}px`;
      tooltip.style.left = `${rect.left + rect.width / 2}px`;
      tooltip.style.transform = "translateX(-50%)";
    }

    function attachChipwareTooltips(r) {
      r.querySelectorAll(".chipware").forEach(chip => {
        chip.addEventListener("mouseenter", () => showTooltip(chip));
        chip.addEventListener("mouseleave", hideTooltip);
      });
    }

    attachChipwareTooltips(root ?? document);
    bindHideListeners(document);  // initial: main window; re-binds to the popout on first hover there

    this._cpChipTooltipCleanup = () => {
      hideTooltip();
      tooltip.remove();
      if (listenerDoc) for (const e of HIDE_EVENTS) listenerDoc.removeEventListener(e, hideTooltip);
      listenerDoc = null;
    };
  }

  /**
   * Persist a skill's level from its `.skill-level` input (chipped → chipLevel, else level), sync any
   * linked active chips, refresh the Combat Sense modifier, and re-render. Body ported verbatim from
   * the former saveSkillLevel closure (Stage A2; takes the input element instead of the event).
   */
  async _cpSaveSkillLevelFromInput(input) {
    const skill = this.actor.items.get(input.dataset.skillId);
    if (!skill) return;

    const isChipped = !!skill.system.isChipped;
    const value = Number.parseInt(input.value, 10);
    const safeValue = Number.isFinite(value) ? value : 0;

    const targetKey = isChipped ? "system.chipLevel" : "system.level";
    await skill.update({ [targetKey]: safeValue }, { render: false });

    if (isChipped) {
      const skillId = skill.id;
      const skillName = skill.name;

      const chips = this.actor.items.filter((i) => {
        if (i.type !== "cyberware") return false;
        if (!cwHasType(i, "Chip")) return false;
        if (i.system?.equipped === false) return false;
        const map = i.system?.CyberWorkType?.ChipSkills;
        if (!map) return false;

        if (skillId && Object.prototype.hasOwnProperty.call(map, skillId)) return true;

        return Object.prototype.hasOwnProperty.call(map, skillName);
      });

      if (chips.length) {
        const updates = [];
        for (const ch of chips) {
          const map = ch.system?.CyberWorkType?.ChipSkills || {};
          const key =
            (skillId && Object.prototype.hasOwnProperty.call(map, skillId)) ? skillId : skillName;

          updates.push({
            _id: ch.id,
            [`system.CyberWorkType.ChipSkills.${key}`]: safeValue
          });
        }

        await this.actor.updateEmbeddedDocuments("Item", updates, { render: false });

        for (const ch of chips) if (ch.sheet?.rendered) ch.sheet.render(true);
      }
    }

    // Combat Sense (Solo) adds its level to Initiative + Awareness rolls — find it by stable _id,
    // never by name (the old name match hardcoded the EN + RU spellings and broke in any other locale).
    const combatSenseLevel =
      this.actor.items.find(item => isCombatSenseSkill(item))?.system.level ?? 0;
    await this.actor.update({ "system.CombatSenseMod": Number(combatSenseLevel) }, { render: false });

    if (this.rendered) this.render(true);

    if (skill.sheet?.rendered) skill.sheet.render(true);
  }

  /** Toggle a skill's askMods flag from its `.skill-ask-mod` checkbox, reverting the box on failure.
   *  (Was the inline .skill-ask-mod change handler; ported in Stage A2.) */
  async _cpUpdateAskModsFromInput(input) {
    const skill = this.actor.items.get(input.dataset.skillId);
    if (!skill) return ui.notifications.warn(localize("SkillNotFound"));

    try {
      await skill.update({ "system.askMods": !!input.checked });
    } catch (err) {
      console.error(err);
      ui.notifications.error(localize("UpdateAskModsError"));
      input.checked = !input.checked;
    }
  }

  /**
   * Netrunning controls. Mirrors upstream's `_cpActivateNetrunningControls`: native bind-once click
   * (interface-skill roll, program edit/trash) + contextmenu (right-click an active program to
   * deactivate it and recompute RAM). Native-DOM rewrite of the former jQuery handlers (Stage A2);
   * covered by tests/v14/actor-netrunning-controls.spec.js.
   * NOTE: program drag (the `.netrun-program` dragstart/is-dragging) stays with the drag system
   * (makeDraggable in _cpActivateActorDragDrop), and the netrun-icon FilePicker is still a jQuery
   * handler in activateListeners — both deferred.
   */
  _cpActivateNetrunningControls(root) {
    if (!root?.addEventListener) return;
    // Editable check before the bound flag (so a non-editable first render can't consume the binding).
    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;
    if (root.dataset.cpNetrunningControlsBound === "1") return;
    root.dataset.cpNetrunningControlsBound = "1";

    root.addEventListener("click", (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const interfaceSkill = target.closest(".interface-skill-roll");
      if (interfaceSkill) {
        event.preventDefault();
        event.stopPropagation();
        const skillId = interfaceSkill.dataset.skillId;
        if (!skillId) { ui.notifications.warn(localize("InterfaceSkillNotFound")); return; }
        this.actor.rollSkill(skillId);
        return;
      }

      const programEdit = target.closest(".netrun-program .fa-edit");
      if (programEdit) {
        event.preventDefault();
        event.stopPropagation();
        const item = this._cpGetItemFromTarget(programEdit.closest(".netrun-program"));
        if (item) item.sheet.render(true);
        return;
      }

      const programDelete = target.closest(".netrun-program .fa-trash");
      if (programDelete) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const item = this._cpGetItemFromTarget(programDelete.closest(".netrun-program"));
        if (item) this._confirmDeleteItem(item);
        return;
      }
    });

    root.addEventListener("contextmenu", async (event) => {
      const activeIcon = event.target?.closest?.(".netrun-active-icon");
      if (!activeIcon) return;
      event.preventDefault();
      event.stopPropagation();

      const itemId = activeIcon.dataset.itemId;
      if (!itemId) return;

      const currentActive = [...(this.actor.system.activePrograms || [])];
      const idx = currentActive.indexOf(itemId);
      if (idx < 0) return;
      currentActive.splice(idx, 1);

      let sumMU = 0;
      for (const progId of currentActive) {
        const progItem = this.actor.items.get(progId);
        if (!progItem) continue;
        sumMU += Number(progItem.system.mu) || 0;
      }

      await this.actor.update({
        "system.activePrograms": currentActive,
        "system.ramUsed": sumMU
      });

      ui.notifications.info(localize("ProgramDeactivated"));
    });
  }

  /**
   * CP2020-specific actor controls with no upstream equivalent: the ammo-tracking toggle, the Shop
   * button, the Services tab (add/pay/edit/delete), the IP tracker (level-up / lock-toggle), and the
   * martial-action panel. Same native bind-once dispatch shape as the upstream-mirrored clusters
   * (Stage A2); covered by tests/v14/actor-custom-controls.spec.js.
   */
  /**
   * Build the GM-only radiation panel context (R3b): the running exposure, lifetime history, the actor's
   * RSP, and a compact aggregate of the active radiation stat loss ("BT −2, REF −1"). Populated only for a
   * GM while the subsystem is enabled — otherwise `radiation.show` is false and combat.hbs skips the whole
   * panel, keeping the sheet byte-identical for players / radiation-off worlds. Mirrors
   * _cpPrepareStatusVisibility (a render-edge helper off _prepareContext).
   */
  _cpPrepareRadiation(sheetData) {
    if (!(radiationEnabled() && game.user.isGM)) { sheetData.radiation = { show: false }; return; }
    const actor = this.actor;

    // Aggregate every active marker's stat mods into one signed-per-stat summary for the readout.
    const agg = {};
    for (const m of radMarkersFor(actor)) {
      for (const b of m?.statBoosts ?? []) {
        const key = String(b?.stat ?? "").toUpperCase();
        if (!key) continue;
        agg[key] = (agg[key] || 0) + (Number(b?.mod) || 0);
      }
    }
    const statLoss = Object.entries(agg)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v}`)
      .join(", ");

    sheetData.radiation = {
      show: true,
      exposure: actorExposure(actor),
      history: actorHistory(actor),
      rsp: actorRSP(actor),
      statLoss,
    };
  }

  /**
   * Wire the GM-only radiation panel buttons (R3b) — native bind-once on the persistent root (the
   * _cpActivate* idiom). The buttons only exist in the DOM for a GM (combat.hbs guards on radiation.show),
   * and every action re-checks GM/owner in the radiation API, so this is defence-in-depth. Apply opens the
   * dose dialog for THIS actor; long-term posts the reference card; clear/cure mutate + let the flag write
   * re-render the sheet (the readout refreshes off the updated flags).
   */
  _cpActivateRadiationControls(root) {
    if (!root?.addEventListener) return;
    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;
    if (root.dataset.cpRadiationControlsBound === "1") return;
    root.dataset.cpRadiationControlsBound = "1";

    root.addEventListener("click", async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      if (target.closest(".cp-rad-apply")) {
        event.preventDefault();
        await openApplyDoseDialog([this.actor]);
        return;
      }
      if (target.closest(".cp-rad-longterm")) {
        event.preventDefault();
        await postLongTermCard(this.actor);
        return;
      }
      if (target.closest(".cp-rad-clear")) {
        event.preventDefault();
        await clearExposure(this.actor);
        return;
      }
      if (target.closest(".cp-rad-cure")) {
        event.preventDefault();
        await cureRadiation(this.actor);
        return;
      }
    });
  }

  _cpActivateActorCustomControls(root) {
    if (!root?.addEventListener) return;
    // Editable check before the bound flag (so a non-editable first render can't consume the binding).
    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;
    if (root.dataset.cpActorCustomControlsBound === "1") return;
    root.dataset.cpActorCustomControlsBound = "1";

    root.addEventListener("click", async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      if (target.closest(".cp-open-shop")) {
        event.preventDefault();
        openShopForPlayer(this.actor);
        return;
      }

      // Services tab (recurring bills).
      const svcAdd = target.closest(".cp-service-add");
      if (svcAdd) {
        event.preventDefault();
        const [created] = await this.actor.createEmbeddedDocuments("Item", [{
          name: localize("NewService"), type: "misc",
          system: { cost: 0 },
          // serviceMode/servicePeriod live in MODULE flags, not system.*: the base `misc` data model is
          // bare and strips unknown system fields on a vanilla host, so the item would never classify as
          // a service (it'd stay in Gear). services.js reads these via serviceModeOf/servicePeriodOf.
          flags: { "cp2020-augmented": { serviceMode: "recurring", servicePeriod: "month" } }
        }]);
        created?.sheet?.render(true);
        return;
      }
      const svcPay = target.closest(".cp-service-pay");
      if (svcPay) {
        event.preventDefault();
        const item = this._cpGetItemFromTarget(svcPay);
        if (item) await payService(this.actor, item);
        return;
      }
      const svcEdit = target.closest(".cp-service-edit");
      if (svcEdit) {
        event.preventDefault();
        this._cpGetItemFromTarget(svcEdit)?.sheet?.render(true);
        return;
      }
      const svcDelete = target.closest(".cp-service-delete");
      if (svcDelete) {
        event.preventDefault();
        const item = this._cpGetItemFromTarget(svcDelete);
        if (item) await item.delete();
        return;
      }

      // IP tracker: self-service level-up + skill-lock toggle.
      const ipLevel = target.closest(".ip-level-up");
      if (ipLevel) {
        event.preventDefault();
        event.stopPropagation();
        const skill = this.actor.items.get(ipLevel.dataset.skillId);
        if (skill) await levelUpSkill(this.actor, skill);
        return;
      }
      const ipLock = target.closest(".ip-lock-toggle");
      if (ipLock) {
        event.preventDefault();
        await toggleSkillLock(this.actor);
        this.render(false);
        return;
      }

      // Martial-arts action button (combat tab).
      const martial = target.closest(".martial-action");
      if (martial) {
        event.preventDefault();
        event.stopPropagation();
        this._cpOpenMartialActionDialog(martial);
        return;
      }
    });
  }

  /**
   * Open the attack dialog for a martial-arts action button: the action is fixed by the button, so
   * the dialog only collects martial-art style + cyberlimb, injecting the action into the fire
   * options. Uses a real martial weapon if the button names one, else a transient unarmed weapon.
   * (Body ported verbatim from the former .martial-action jQuery handler; Stage A2.)
   */
  _cpOpenMartialActionDialog(button) {
    const action = button.dataset.action;
    if (!action) return;

    let item = button.dataset.itemId ? this.actor.items.get(button.dataset.itemId) : null;
    if (!item) {
      item = new CONFIG.Item.documentClass(
        { name: localize("MartialArt"), type: "weapon", img: "systems/cyberpunk2020/img/punch-icon.svg",
          system: { attackType: meleeAttackTypes.martial, weaponType: "Melee" } },
        { parent: this.actor }
      );
    }

    const targetTokens = Array.from(game.users.current.targets.values()).map(target => ({
      name: target.document.name, id: target.id,
    }));

    const dialog = new ModifiersDialog(this.actor, {
      weapon: item,
      targetTokens,
      modifierGroups: martialOptions(this.actor),
      onConfirm: async (fireOptions) => {
        await item.__weaponRoll({ ...fireOptions, action }, targetTokens);
        // Special martial hit-effect (A6 → the offered contest): a hold / grapple / choke / throw /
        // sweep on a single target no longer applies on-declare — it posts the defense-offer card
        // (martial.js postMartialDefenseOffer): the target's owner may roll the opposed defense, and
        // the GM adjudicates [lands / evaded / apply-without-contest]. Escape stays immediate — it is
        // the actor freeing themselves, not an attack on the target. Damage adjudication is unchanged
        // (Apply-Damage). Both paths self-gate on specialMeleeEffectsEnabled.
        if (targetTokens.length === 1) {
          const targetActor = canvas?.tokens?.get(targetTokens[0].id)?.actor ?? null;
          if (targetActor) {
            const M = await import("../martial/martial.js");
            const offered = M.CONTESTED_MARTIAL_ACTIONS.has(action)
              ? await M.postMartialDefenseOffer({
                  attackerActor: this.actor, targetActor,
                  targetTokenId: targetTokens[0].id, action,
                })
              : false;
            if (!offered) await this._cpApplyOrRelayMartialEffect(action, targetActor);
          }
        }
      },
    });
    dialog.render(true);
  }

  /** Apply a special martial hit-effect to the target — directly if this client can write the target,
   *  else relayed to the active GM. Delegates to the single home in martial.js (the offer card's
   *  buttons use the same helper), so the two paths can never drift. (A6) */
  async _cpApplyOrRelayMartialEffect(action, targetActor) {
    const { applyOrRelayMartialEffect } = await import("../martial/martial.js");
    await applyOrRelayMartialEffect(action, targetActor, this.actor);
  }

  _prepareSkills(sheetData) {
    sheetData.skillsSort = this.actor.system.skillsSortedBy || "Name";
    sheetData.skillsSortChoices = Object.keys(SortOrders);

    // Render ALL skills (sorted); the search filter is applied to the DOM in place at runtime by
    // _cpApplySkillFilterToDOM (Stage A2) rather than at render time. `skillFilter` is still passed
    // to the template so the search box keeps its value across re-renders.
    sheetData.filteredSkillIDs = this._getSortedSkillIDs(sheetData);

    sheetData.skillDisplayList = sheetData.filteredSkillIDs
      .map(id => this.actor.items.get(id))
      .filter(Boolean);

    // IP tracker (feature [[ip-tracker-design]]): per-skill banked/pending/level-up data + global flags.
    this._prepareIp(sheetData);
  }

  /** Build the IP display data (global flags + per-skill cost/banked/pending/canLevel). */
  _prepareIp(sheetData) {
    let on = false;
    try { on = ipEnabled(); } catch (e) { on = false; }
    if (!on) { sheetData.ip = { enabled: false }; sheetData.ipBySkill = {}; return; }

    const simple = !ipRawTracking();
    const isGM = game.user.isGM;
    const lock = ipLockState(this.actor);
    const pool = Number(this.actor.system?.ipPool) || 0;
    sheetData.ip = {
      enabled: true, simple, isGM,
      showPending: isGM && ipShowPending(),
      locked: !canEditSkillLevels(this.actor),
      lockOwner: lock.owner, lockGm: lock.gm, lockMode: lock.mode,
      pool
    };

    const map = {};
    for (const s of sheetData.skillDisplayList) {
      if (s.type !== "skill") continue;
      const cost = ipCost(s);
      const banked = Number(s.system?.ip) || 0;
      // Dual-bucket (Model A): available = the skill's own bank + the fungible pool, in every mode.
      const have = banked + pool;
      map[s.id] = { cost, banked, pending: Number(s.system?.ipPending) || 0, canLevel: have >= cost };
    }
    sheetData.ipBySkill = map;
  }
  _getSortedSkillIDs(sheetData) {
    const system = sheetData?.system ?? this.actor.system;
    const sortOrder = system.skillsSortedBy || "Name";

    let currentSkills =
      this.actor.itemTypes?.skill ?? this.actor.items.filter(i => i.type === "skill");

    if (!isFnff2Enabled()) {
      // Filter by the martial-art KEY (= the skill's name), NOT the embedded _id: a copied/re-created
      // skill gets a fresh _id, so id-matching would fail to hide it (the documented inverse id-match trap).
      currentSkills = currentSkills.filter(s => !FNFF2_ONLY_MARTIAL_ART_KEYS.has(s.name));
    }

    const currentIds = currentSkills.map(s => s.id);

    const cached = system.sortedSkillIDs;
    const cachedOk = Array.isArray(cached)
      && cached.length === currentIds.length
      && cached.every(id => currentIds.includes(id));

    if (cachedOk) return cached;

    return sortSkills(currentSkills, SortOrders[sortOrder]).map(s => s.id);
  }

  // NOTE: skill filtering moved out of _prepareContext to a runtime DOM filter in Stage A2
  // (_cpApplySkillFilterToDOM); _prepareSkills now renders all sorted skills. (The old _filterSkills
  // render-time filter was removed.)

  /**
   * §3c visibility hybrid — the render edge of mech/status.js. Builds:
   *   cpStatusRows    — status-strip pills [{itemId, kind, kindLabel, text, title, togglePath}]
   *   cpActiveBadges  — {itemId: tooltip} for the gear/cyberware row active-dots
   *   cpStatTips      — {statKey: "8 = 6 base +1 temp +1 Adrenal Booster"} title tooltips
   * Kind/part labels localize here; item and skill names stay literal (dynamic data, the
   * martialOptions precedent).
   */
  _cpPrepareStatusVisibility(sheetData) {
    const actor = this.actor;
    const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
    const KIND_LABEL = {
      light: "StatusStripKindLight", vision: "StatusStripKindVision",
      protection: "StatusStripKindProtection", timer: "StatusStripKindTimer",
      chip: "StatusStripKindChip", stat: "StatusStripKindStat",
      skill: "StatusStripKindSkill", roll: "StatusStripKindRoll",
      moddy: "StatusStripKindModdy", drug: "StatusStripKindDrug",
      addiction: "StatusStripKindAddiction"
    };
    const HAZARD_LABEL = { gas: "MechProtectionGas", flash: "MechProtectionFlash", sonic: "MechProtectionSonic" };
    const detailText = (r) => {
      switch (r.kind) {
        case "light": return `${r.detail.range}m`;
        case "vision": {
          const modeKey = "MechVisionMode" + r.detail.mode.charAt(0).toUpperCase() + r.detail.mode.slice(1);
          return `${localize(modeKey)} ${r.detail.range}m`;
        }
        case "protection": return r.detail.hazards.map(h => {
          const label = localize(HAZARD_LABEL[h.hazard]);
          if (h.immune) return `${label} ${localize("MechProtectionImmune")}`;
          const parts = [];
          if (h.mod) parts.push(signed(h.mod));
          if (h.percent) parts.push(`${h.percent}%`);
          if (h.damageMult) parts.push(`×${h.damageMult}`);
          return `${label} ${parts.join(" ") || signed(h.mod)}`;
        }).join(", ");
        case "timer": return localizeParam("StatusStripTurnsLeft", { turns: r.detail.turnsLeft });
        case "chip": return r.detail.skills.map(s => `${s.name} ${s.level}`).join(", ");
        case "stat": return r.detail.stats.map(s => `${s.stat.toUpperCase()} ${signed(s.mod)}`).join(", ");
        case "skill": return r.detail.skills.map(s => `${s.name} ${signed(s.mod)}`).join(", ");
        case "roll": {
          const parts = [];
          if (r.detail.attackMod) parts.push(r.detail.dualWieldOnly
            ? localizeParam("StatusStripDualWieldMod", { mod: signed(r.detail.attackMod) })
            : localizeParam("StatusStripRangedMod", { mod: signed(r.detail.attackMod) }));
          if (r.detail.skillMod && r.detail.skillName) parts.push(`${r.detail.skillName} ${signed(r.detail.skillMod)}`);
          for (const e of r.detail.skillMods ?? []) parts.push(`${e.skillName} ${signed(e.mod)}`);
          if (r.detail.statMod && r.detail.statName) parts.push(`${r.detail.statName.toUpperCase()} ${signed(r.detail.statMod)}`);
          if (r.detail.facedownMod) parts.push(localizeParam("StatusStripFacedownMod", { mod: signed(r.detail.facedownMod) }));
          return parts.join(", ");
        }
        case "moddy": return r.detail.mods.map(m => {
          const st = m.stat.toUpperCase();
          if (m.isSet) return `${st} =${m.set}`;
          if (m.context === "split") return `${st} ${signed(m.mod)}/${signed(m.combatMod)}`;
          const ctx = m.context === "combat" ? ` ${localize("StatusStripCtxCombat")}`
            : m.context === "noncombat" ? ` ${localize("StatusStripCtxNoncombat")}` : "";
          return `${st} ${signed(m.mod)}${ctx}`;
        }).join(", ");
        case "drug": {
          const parts = [];
          for (const b of r.detail.statBoosts) if (b.mod) parts.push(`${String(b.stat).toUpperCase()} ${signed(b.mod)}`);
          for (const b of r.detail.rollBoosts) if (b.mod) parts.push(`${b.label} ${signed(b.mod)}`);
          if (r.detail.psychosis) parts.push(r.detail.psychosis);
          if (r.detail.turnsLeft > 0) parts.push(localizeParam("StatusStripTurnsLeft", { turns: r.detail.turnsLeft }));
          const body = parts.join(", ");
          return r.detail.isPenalty ? `${localize("DrugCrashLabel")}: ${body}` : body;
        }
        case "addiction": {
          const breakdown = r.detail.byDrug.map(d => `${d.name} ×${d.count}`).join(", ");
          return breakdown
            ? localizeParam("StatusStripAddiction", { total: r.detail.total, breakdown })
            : String(r.detail.total);
        }
        default: return "";
      }
    };

    const rows = activeInfluencesFor(actor);
    sheetData.cpStatusRows = rows.map(r => {
      const kindLabel = localize(KIND_LABEL[r.kind] ?? KIND_LABEL.stat);
      const detail = detailText(r);
      const noteClause = r.kind === "timer" && r.detail.note ? ` — ${r.detail.note}` : "";
      // The addiction tally has no source item/name — its text IS the detail (a bare count breakdown).
      return {
        itemId: r.itemId, kind: r.kind, kindLabel,
        text: r.name ? (detail ? `${r.name} (${detail})` : r.name) : detail,
        title: r.name ? `${kindLabel}: ${r.name}${detail ? ` — ${detail}` : ""}${noteClause}` : `${kindLabel}: ${detail}`,
        togglePath: r.togglePath ?? "",
        // The GM clears the addiction tally from the strip when a character kicks the habit —
        // GM-ONLY: the tally is a GM-side consequence tracker, and its × wipes the whole history.
        clearAddiction: r.kind === "addiction" && game.user?.isGM === true,
        // Orphan escape: a drug marker whose source item is gone (no Wear-off control anywhere else).
        clearDrug: r.kind === "drug" && !!r.detail?.orphan,
        drugPenalty: r.kind === "drug" && r.detail?.isPenalty ? "1" : "0"
      };
    });

    const badges = {};
    for (const r of rows) {
      if (!r.itemId) continue;
      const piece = `${localize(KIND_LABEL[r.kind] ?? KIND_LABEL.stat)}: ${detailText(r)}`;
      badges[r.itemId] = badges[r.itemId] ? `${badges[r.itemId]} · ${piece}` : piece;
    }
    sheetData.cpActiveBadges = badges;

    // Q5 vision picker: rendered beside the strip while any vision device is switched on (or a
    // pick is stuck, so it can be un-stuck). Options: Auto (longest range) / Natural / each
    // active device by name. The choice lives in the actor flag `visionPick`.
    const pick = String(actor.getFlag?.("cp2020-augmented", "visionPick") ?? "");
    const visionRowList = rows.filter(r => r.kind === "vision");
    sheetData.cpVisionPick = (visionRowList.length || pick) ? {
      current: pick,
      options: [
        { value: "", label: localize("VisionPickAuto"), selected: pick === "" },
        { value: "natural", label: localize("VisionPickNatural"), selected: pick === "natural" },
        ...visionRowList.map(r => ({ value: r.itemId, label: r.name, selected: pick === r.itemId }))
      ]
    } : null;

    // Living flag (heat-sense target gate): explicit flag wins, else the actor-type default.
    sheetData.cpLiving = isLivingActor(actor);

    // The strip renders when it has pills OR the picker (no `or` helper in this stack). It's a collapsible
    // <details> (summary by default, expands to the pills) so a long list doesn't crowd the header; the
    // open/closed choice persists across re-renders via _cpStatusOpen (a drug tick re-renders the sheet).
    sheetData.cpShowStrip = !!(sheetData.cpStatusRows.length || sheetData.cpVisionPick);
    sheetData.cpStatusOpen = !!this._cpStatusOpen;

    const PART_LABEL = {
      base: "StatBreakdownBase", temp: "StatBreakdownTemp", encumbrance: "StatBreakdownEncumbrance",
      wounds: "StatBreakdownWounds", humanity: "StatBreakdownHumanity", other: "StatBreakdownOther"
    };
    const tips = {};
    for (const key of Object.keys(actor.system?.stats ?? {})) {
      const parts = statContributionsFor(actor, key);
      if (!parts.length) continue;
      const text = parts.map((p, i) => {
        if (p.kind === "item") return `${signed(p.value)} ${p.name}`;
        const label = localize(PART_LABEL[p.kind] ?? PART_LABEL.other);
        return i === 0 ? `${p.value} ${label}` : `${signed(p.value)} ${label}`;
      }).join(" ");
      tips[key] = `${actor.system.stats[key].total} = ${text}`;
    }
    sheetData.cpStatTips = tips;

    // Cyberlimb SDP status per zone (the repair UI, read on the armor-display). status = the TRUE
    // state from the sticky limbStatus flag ("destroyed"/"useless") or "damaged" (current<max); the
    // localized label rides along so the destroyed-limb-reads-full-SDP quirk shows correctly.
    const CL_STATUS_LABEL = { destroyed: "CyberlimbStatusDestroyed", useless: "CyberlimbStatusUseless", damaged: "CyberlimbStatusDamaged" };
    const cl = cyberlimbSheetStatus(actor);
    const clOut = {};
    for (const [zone, info] of Object.entries(cl)) {
      clOut[zone] = { ...info, statusLabel: info.status !== "ok" ? localize(CL_STATUS_LABEL[info.status] ?? CL_STATUS_LABEL.damaged) : "" };
    }
    sheetData.cpCyberlimb = clOut;
    // M18 CONTRACT (flesh-limb lane): per-zone FLESH state for the armor display's non-cyberlimb rows —
    // a recorded severed/wounded FLESH limb shows a status the way the cyberlimb SDP row shows its badge
    // one row up. Keyed by the hitLocation zone so armor-display.hbs can `lookup` it by the same `name`
    // it uses for cpCyberlimb; fleshLimbStatusLabel (mech/cyberlimb.js, owned by the limb lane) returns
    // "" for a cyberlimb'd or unrecorded zone, so only genuine flesh rows get an entry.
    const fleshOut = {};
    for (const zone of Object.keys(actor.system?.hitLocations ?? {})) {
      const label = fleshLimbStatusLabel(actor, zone);
      if (label) fleshOut[zone] = { fleshStatusLabel: label };
    }
    sheetData.cpFleshLimb = fleshOut;
    // Repair permission scoping (world setting): hide the control from non-GMs when restricted —
    // repairCyberlimb re-checks, so a stale render can't bypass it.
    sheetData.cpCanRepairLimb = !cyberlimbRepairGmOnly() || game.user?.isGM === true;

    // Full-conversion borg mode: a 3-state override (auto / on / off) mirroring isFullBorg's flag
    // logic. Shown only for actors that are or could be a borg (a body item, the explicit flag, or any
    // cyber-SDP) so plain characters aren't cluttered. Persisted by an explicit change handler (NOT a
    // form-bound `name`), so the sheet's submitOnChange can't silently turn "auto" into a forced value.
    const rawBorg = actor.getFlag("cp2020-augmented", "fullBorg");
    sheetData.cpBorgMode = rawBorg === true ? "on" : rawBorg === false ? "off" : "auto";
    sheetData.cpIsFullBorg = isFullBorg(actor);
    const anyZoneSdp = Object.values(actor.system?.sdp?.sum ?? {}).some(v => (Number(v) || 0) > 0);
    sheetData.cpShowBorgToggle = sheetData.cpIsFullBorg || !!borgBodyOf(actor) || anyZoneSdp;
  }

  _addWoundTrack(sheetData) {
    // Add localized wound states, excluding uninjured. All non-mortal, plus mortal
    const nonMortals = ["Light", "Serious", "Critical"].map(e => game.i18n.localize("CYBERPUNK."+e));
    const mortals = Array(7).fill().map((_,index) => game.i18n.format("CYBERPUNK.Mortal", {mortality: index}));
    sheetData.woundStates = nonMortals.concat(mortals);
  }

  /**
   * Items that aren't actually cyberware or skills - everything that should be shown in the gear tab. 
   */
  _gearTabItems(allItems) {
    // As per https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Collator
    // Compares locale-compatibly, and pretty fast too apparently.
    let hideThese = new Set(["cyberware", "skill", "program"]);
    // Recurring services move to the Services tab — but ONLY when shopping is enabled (that tab is
    // shown). With shopping off there is no Services tab, so leave them here or they'd be unreachable.
    let hideServices = false;
    try { hideServices = shoppingEnabled(); } catch (e) { hideServices = false; }
    let nameSorter = new Intl.Collator();
    let showItems = allItems
      .filter((item) => !hideThese.has(item.type))
      .filter((item) => !(hideServices && item.type === "misc" && classifyService(item) === "recurring"))
      // Manual order (drag-to-reorder persists the `sort` field); name is the tiebreak, so actors
      // whose items all share sort 0 still read alphabetically — only reordered items differ.
      .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || nameSorter.compare(a.name, b.name));
    return showItems;
  }

  /**
   * Organize and classify Items for Character sheets.
   *
   * @param {Object} actorData The actor to prepare.
   *
   * @return {undefined}
   */
  _prepareCharacterItems(sheetData) {
    let sortedItems = sheetData.actor.itemTypes;

    sheetData.gearTabItems = this._gearTabItems(sheetData.actor.items);

    // Services tab (Shopping #15): recurring-service misc items, shown only when shopping is on.
    let shopOn = false;
    try { shopOn = shoppingEnabled(); } catch (e) { shopOn = false; }
    if (shopOn) {
      const recurring = sheetData.actor.items.filter(i => i.type === "misc" && classifyService(i) === "recurring");
      sheetData.services = recurring
        .map(i => ({ id: i.id, name: i.name, img: i.img, cost: Number(i.system?.cost) || 0, period: servicePeriodOf(i) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      sheetData.servicesTotal = sheetData.services.reduce((s, x) => s + x.cost, 0);
    }

    sheetData.gear = {
      weapons: sortedItems.weapon,
      armor: sortedItems.armor,
      cyberware: sortedItems.cyberware,
      misc: sortedItems.misc,
      cyberCost: sortedItems.cyberware.reduce((a,b) => a + b.system.cost, 0)
    };

    // One consolidated Martial Arts panel: the actions (Defensive/Attacks/Grapple) render as
    // vertical rows in the combat tab; clicking one supplies the action to the attack dialog (the
    // style is chosen there). Backed by the actor's first martial-arts weapon — they are
    // interchangeable entry points (the action + style are chosen at click time, not the weapon).
    sheetData.martialActionGroups = martialActionGroups();
    sheetData.MARTIAL_ATTACK_TYPE = meleeAttackTypes.martial;
    const _martialWeapon =
      sortedItems.weapon.find(w => w.system?.attackType === meleeAttackTypes.martial)
      ?? sortedItems.cyberware.find(c =>
           cwHasType(c.system?.CyberWorkType, "Weapon")
           && c.system?.CyberWorkType?.Weapon?.attackType === meleeAttackTypes.martial
           && cwIsEnabled(c));
    sheetData.martialWeaponId = _martialWeapon?.id ?? null;

    // Cyberware inventory & zones
    const allCyber = (sortedItems.cyberware || []).slice();

    sheetData.gear.cyberware = allCyber;
    sheetData.gear.cyberwareInventory = allCyber;

    // Q6 telescoping: the GEAR list still renders as a flat tree (loose items as roots, installed
    // items nested). The CYBERWARE tab telescopes INSIDE the anatomy body map instead (cyberZoneTrees
    // below) — each host implant shows its options nested under it in the right zone — so it has no
    // separate flat tree.
    const allItems = sheetData.actor.items?.contents ?? [];
    const gearTabItems = sheetData.gearTabItems ?? [];
    const gearIds = new Set(gearTabItems.map((i) => i.id));
    // Real compartments: a cyberware container holding NON-cyberware children joins the gear tree
    // too — the body map is cyberware-only, so without this row the stowed gear (a holstered
    // pistol) renders nowhere once its own sheet closes. The compartment's HOST (the arm) isn't
    // in this list, so the tree's tolerant root rule (parent absent ⇒ loose) roots it here.
    const compartmentHosts = [];
    for (const it of allItems) {
      if (it.type !== "cyberware") continue;
      if (childrenOf(allItems, it.id).some((c) => c.type !== "cyberware")) { gearIds.add(it.id); compartmentHosts.push(it); }
    }
    // Build the root list in the gear tab's SORTED order (drag-reorder persists `sort`; name is the
    // tiebreak) — buildContainerTree keeps its input order for roots, so ordering gearList here is what
    // restores the persisted sort AND the alphabetical default. gearTabItems is already sorted; append
    // the compartment hosts (cyberware, absent from gearTabItems) in the same comparator order.
    const gearNameSorter = new Intl.Collator();
    compartmentHosts.sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || gearNameSorter.compare(a.name, b.name));
    const gearList = [...gearTabItems.filter((it) => gearIds.has(it.id)), ...compartmentHosts];
    sheetData.gearTree = buildContainerTree(gearList, (it) => gearIds.has(it.id), allItems);

    // PLACEMENT vs POWER: an equipped implant renders in its zone even while switched OFF —
    // hiding a disabled Activatable removed its only re-enable affordance (the zone row is how
    // you reach its sheet). `placedCyber` drives WHERE things render; `activeCyber` (equipped +
    // enabled) keeps driving the "active" tallies; cpCyberOff drives the dimmed row style.
    const placedCyber = allCyber.filter(it => !!it.system?.equipped);
    const isEnabled = (it) => !!it.system?.equipped && cwIsEnabled(it);
    const activeCyber = allCyber.filter(isEnabled);
    sheetData.cpCyberOff = Object.fromEntries(
      placedCyber.filter(it => !cwIsEnabled(it)).map(it => [it.id, true]));
    const isChip = (it) => {
      const cwt = it.system?.CyberWorkType ?? {};
      return Array.isArray(cwt?.Types) ? cwt.Types.includes("Chip") : cwt?.Type === "Chip";
    };

    const AREAS = ["head", "body", "nervous", "l-arm", "r-arm", "l-leg", "r-leg"];

    // Installed cyberware grouped by anatomy area (the flat per-zone tally, used for the zone badges).
    const activeByArea = {};
    for (const area of AREAS) activeByArea[area] = placedCyber.filter(it => cyberAreaOf(it) === area);

    // The anatomy body map now telescopes: each zone renders a tree of its installed cyberware — host
    // implants (a cyberarm, a cybereye) with their installed options nested underneath, one per zone.
    // A full borg's options land as flat roots in their zones (their host is the zoneless chassis).
    sheetData.cyberZoneTrees = buildZoneTrees(placedCyber, cyberAreaOf, allItems);

    // Catch-all: installed cyberware with no anatomy zone (and not the chassis or a chip) — so nothing
    // installed vanishes when it lacks a MountZone. Anything already shown in a zone tree is excluded.
    const inZoneIds = new Set();
    const collectIds = (n) => { inZoneIds.add(n.item.id); (n.children ?? []).forEach(collectIds); };
    for (const area of Object.keys(sheetData.cyberZoneTrees)) sheetData.cyberZoneTrees[area].forEach(collectIds);
    sheetData.cyberOther = placedCyber.filter(it => !inZoneIds.has(it.id) && !isBorgBody(it) && !isChip(it));

    // The equipped full-borg chassis (zoneless, so not a row in the map itself). Its pinned strip is
    // built after the per-zone slot tallies below, so its badge can sum them. Null for a normal char.
    const borgBody = placedCyber.find(it => isBorgBody(it)) ?? null;

    // Per-zone option-slot capacity for the anatomy body-map badges (surface each limb's option spaces).
    // Borg: the chassis's fixed per-zone pool (borgBody.optionSpaces) — TOTAL capacity (factory fit-out
    // + the book's free spaces), consumed by the zone's ROOT items only. An item consumes its IMMEDIATE
    // parent's capacity: the zone pool when it sits in the chassis directly, its container's own
    // OptionsAvailable when nested — so a mount's contents never double-count against the zone.
    // Normal character: the summed option capacity of any container-cyberware mounted in that zone
    // (each cyberlimb/eye's own OptionsAvailable). A zone with no capacity gets no badge (gated by
    // slotTotal in the template).
    const borgSpaces = borgOptionSpaces(this.actor);
    const zoneRoot = (it) => {
      const pid = installedInOf(it);
      const host = pid ? allItems.find((x) => x.id === pid) : null;
      return !host || isBorgBody(host);
    };
    const zoneCapacity = (area) => {
      const inZone = activeByArea[area] ?? [];
      if (borgSpaces) {
        return { used: inZone.filter(zoneRoot).reduce((s, it) => s + slotsTakenOf(it), 0), total: Number(borgSpaces[area]) || 0 };
      }
      let used = 0, total = 0;
      for (const it of inZone) {
        const cap = capacityOf(it);
        if (cap > 0) { total += cap; used += usedSlots(allItems, it.id); }
      }
      return { used, total };
    };
    // Store as a per-area map: the anatomy segments are built later in _prepareContext (after this
    // method returns), so they read their used/total from here rather than being mutated in place.
    sheetData.zoneCapacity = {};
    for (const area of AREAS) {
      sheetData.zoneCapacity[area] = zoneCapacity(area);
    }

    // The full-borg chassis folds into the Active Cyberware header (no dedicated segment): just its name
    // + the loadout-option count that gates the ⊗ clear-all control. Per-zone slot usage is already shown
    // by the zone badges, so no chassis-wide number (it would conflate option slots with built-in
    // systems). The delete-prompt count is computed live in the handler.
    sheetData.borgChassis = borgBody
      ? { id: borgBody.id, name: borgBody.name, loadoutCount: loadoutOptionsOf(this.actor, borgBody.id).length }
      : null;

    sheetData.chipsActive = allCyber.filter(it =>
      isChip(it) &&
      cwIsEnabled(it) &&
      it.system?.CyberWorkType?.ChipActive === true
    );

    sheetData.gear.cyberwareActive = activeCyber;

    // Carried options: cyberware the player owns but hasn't installed (equipped=false) — the parts bin,
    // rendered in a dedicated Carried Options area distinct from the active body map. A carried chip is
    // "owned but not installed" too, so it lives here (the Active Chipware section shows only running
    // chips); drag one onto Active Chipware or a limb to re-install it. An uninstalled/spare full-borg
    // chassis lives here too (the equipped one is the chassis strip) so it isn't hidden.
    sheetData.carriedCyber = allCyber.filter(it => it.system?.equipped !== true);

    // ── Cyberware-tab anatomy image (player-chosen body type; see ANATOMY_IMAGES) ──
    const anatomyKey = this.actor.getFlag?.("cyberpunk2020", "anatomyImage") || DEFAULT_ANATOMY_KEY;
    const anatomyDef = ANATOMY_IMAGES[anatomyKey] ?? ANATOMY_IMAGES[DEFAULT_ANATOMY_KEY];
    sheetData.anatomy = { key: anatomyKey, src: anatomyDef.src, svg: anatomyDef.svg };
    sheetData.anatomyOptions = Object.entries(ANATOMY_IMAGES).map(([key, v]) => ({ key, label: tryLocalize(v.label), selected: key === anatomyKey }));

    // ── Armor layer compliance panel ───────────────────────────────────────
    // Vendored onto the base system: "damageLayersEnabled" is a fork-only setting neither the host
    // system nor the module registers, so guard the read (an unregistered key throws) → panel off.
    sheetData.showArmorLayers = (() => {
      try { return game.settings.get("cyberpunk2020", "damageLayersEnabled") ?? false; }
      catch (e) { return false; }
    })();

    const LOCATION_LABELS = {
      Head:  localize("Head"),
      Torso: localize("Torso"),
      lArm:  localize("ArmorLayers.LocLArm"),
      rArm:  localize("ArmorLayers.LocRArm"),
      lLeg:  localize("ArmorLayers.LocLLeg"),
      rLeg:  localize("ArmorLayers.LocRLeg"),
    };

    // Inline hard-armor check (mirrors getArmorHardness in armor-layers.js)
    const _isHardArmor = (item) => {
      if (item.system?.armorType === "hard") return true;
      if (item.system?.armorType === "soft") return false;
      const name = (item.name ?? "").toLowerCase();
      return /metal gear|body armor|full body|plate|rigid|hard armor|bodyplating/.test(name);
    };

    const allEquippedArmor  = (sortedItems.armor    || []).filter(a => a.system.equipped);
    const allEquippedCyber  = (sortedItems.cyberware || []).filter(c =>
      c.system.equipped && cwIsEnabled(c) && cwHasType(c, "Armor")
    );

    sheetData.armorLayersSummary = Object.entries(LOCATION_LABELS).map(([key, label]) => {
      // Inventory armor at this location, auto-ordered inside-out
      const invItems = getAutoLayerOrder(
        allEquippedArmor.filter(a => (Number(a.system?.coverage?.[key]?.stoppingPower) || 0) > 0)
      );

      // Cyberware armor at this location (always innermost per RAW)
      const cwItems = allEquippedCyber
        .filter(c => (Number(c.system?.CyberWorkType?.Locations?.[key]) || 0) > 0)
        .map(c => {
          const nameLower = (c.name ?? "").toLowerCase();
          return {
            name:        c.name,
            sp:          Number(c.system?.CyberWorkType?.Locations?.[key]) || 0,
            isHard:      /bodyplating|body plating/.test(nameLower),
            isSkinweave: cwIsSkinweave(c),
            isCyberware: true,
          };
        });

      const invLayers = invItems.map(item => ({
        name:        item.name,
        sp:          Number(item.system?.coverage?.[key]?.stoppingPower) || 0,
        isHard:      _isHardArmor(item),
        isSkinweave: false,
        isCyberware: false,
      }));

      const allLayers = [...cwItems, ...invLayers];
      if (allLayers.length === 0) return null;

      const layerCount  = allLayers.length;
      const hardCount   = allLayers.filter(l => l.isHard).length;
      // EV penalties apply to all non-Skinweave layers beyond the first
      const penaltyCount = allLayers.filter(l => !l.isSkinweave).length;
      const extraEV     = penaltyCount >= 3 ? 3 : penaltyCount >= 2 ? 1 : 0;

      const violations = [];
      if (layerCount > 3)  violations.push("MAX_LAYERS");
      if (hardCount  > 1)  violations.push("MAX_HARD");

      const n = allLayers.length;
      const layers = allLayers.map((layer, i) => ({
        ...layer,
        layerLabel: n <= 1 ? ""
          : i === 0       ? localize("ArmorLayers.LayerLabelInner")
          : i === n - 1   ? localize("ArmorLayers.LayerLabelOuter")
          : localize("ArmorLayers.LayerLabelMid"),
        layerTitle: n <= 1 ? localize("ArmorLayers.OnlyLayer")
          : i === 0       ? localize("ArmorLayers.Innermost")
          : i === n - 1   ? localize("ArmorLayers.Outermost")
          : localize("ArmorLayers.LayerN", { n: i + 1 }),
        isLast: i === n - 1,
      }));

      return { locationKey: key, label, layers, layerCount, hardCount, extraEV, violations,
               layerCountText: layerCount === 1 ? localize("ArmorLayers.LayerCountOne") : localize("ArmorLayers.LayerCountMany", { n: layerCount }) };
    }).filter(Boolean);

    // CB4 clothing layer summary — only used when layerRuleSystem === "Chromebook 4"
    const layerSystem = (() => {
      try { return game.settings.get("cyberpunk2020", "layerRuleSystem"); }
      catch { return "Core"; }
    })();
    sheetData.layerRuleSystem = layerSystem;

    if (layerSystem === "Chromebook 4") {
      const t = this.actor.system?.cb4Torso ?? { Light: 0, Medium: 0, Heavy: 0 };
      const l = this.actor.system?.cb4Legs  ?? { Light: 0, Medium: 0, Heavy: 0 };
      const rowIfAny = (label, count, freeCount, penEV) => {
        if (count <= 0) return null;
        const extra = Math.max(0, count - freeCount);
        const pen   = extra * penEV;
        return { label, count, freeCount, extra, pen,
                 warn: extra > 0 };
      };
      sheetData.cb4TorsoRows = [
        rowIfAny(localize("Light"),  t.Light,  1, 1),
        rowIfAny(localize("Medium"), t.Medium, 0, 3),
        rowIfAny(localize("Heavy"),  t.Heavy,  1, 4),
      ].filter(Boolean);
      sheetData.cb4LegsRows = [
        rowIfAny(localize("Light"),  l.Light,  0, 1),
        rowIfAny(localize("Medium"), l.Medium, 1, 2),
        rowIfAny(localize("Heavy"),  l.Heavy,  1, 3),
      ].filter(Boolean);
      sheetData.cb4TorsoEV = sheetData.cb4TorsoRows.reduce((s, r) => s + r.pen, 0);
      sheetData.cb4LegsEV  = sheetData.cb4LegsRows.reduce((s, r) => s + r.pen, 0);
    }
    // ──────────────────────────────────────────────────────────────────────
  }

  /**
   * Tear-off tabs — press-and-hold a tab, then drag it out to pop it into its own window.
   *
   * The tab bar is heavily restyled by UI modules (crlngn-ui / cyberpunk-restyler) which put
   * `pointer-events:none` on tab CHILDREN — so we don't inject anything into the tab. The tab <a>
   * itself still receives pointer events (that's how switching works), so we bind a hold→drag gesture
   * there (capture phase, to win over the module/Tabs handlers):
   *   - a quick click switches tabs as normal (we only preventDefault once the drag has "armed");
   *   - press and hold ~300ms without a large move to "pick up" the tab (a ghost label appears);
   *   - drag and release to open that tab in its own window AT the drop point.
   * The ghost lives on document.body (away from the module-styled nav). After an armed drop we swallow
   * the trailing click so the tab doesn't also switch.
   */
  _activateTabTearOff(root) {
    const nav = root?.querySelector?.("nav.sheet-tabs");
    if (!nav || nav._cpTearWired) return;
    nav._cpTearWired = true;

    const HOLD_MS = 375;     // press duration before a tab is "picked up"
    const MOVE_CANCEL = 12;  // px of pre-arm movement that aborts the pick-up (a swipe/scroll)
    let st = null;           // active gesture state

    const end = (suppressClick) => {
      const doc = st?.doc ?? document;            // document the gesture was bound to (popout-aware)
      document.documentElement.classList.remove("cp-tab-dragging"); // always clear the global cursor
      doc.documentElement.classList.remove("cp-tab-dragging");      // …and the popout's, if any
      if (!st) return;
      clearTimeout(st.timer);
      st.ghost?.remove();
      st.item?.classList.remove("cp-tab-grabbing", "cp-tab-pressing");
      doc.removeEventListener("pointermove", onMove, true);
      doc.removeEventListener("pointerup", onUp, true);
      doc.removeEventListener("pointercancel", onCancel, true);
      if (suppressClick) this._cpSuppressTabClick = true;
      st = null;
    };

    const arm = () => {
      if (!st) return;
      st.armed = true;
      st.item?.classList.remove("cp-tab-pressing");
      st.item?.classList.add("cp-tab-grabbing");
      // Build the ghost in the document that OWNS the tab (the popout window when the sheet is popped
      // out via PopOut!, else the main window) so it is visible + correctly positioned over that window.
      const doc = st.doc;
      doc.documentElement.classList.add("cp-tab-dragging"); // force a grabbing cursor everywhere
      const ghost = doc.createElement("div");
      ghost.className = "cp-tab-ghost";
      ghost.textContent = `⇗ ${(st.item?.textContent || "Tab").trim()}`;
      ghost.style.left = `${st.x + 12}px`;
      ghost.style.top = `${st.y + 12}px`;
      doc.body.appendChild(ghost);
      st.ghost = ghost;
    };

    const onMove = (ev) => {
      if (!st) return;
      if (!st.armed) {
        if (Math.hypot(ev.clientX - st.x, ev.clientY - st.y) > MOVE_CANCEL) end(false);
        return;
      }
      ev.preventDefault();
      if (st.ghost) { st.ghost.style.left = `${ev.clientX + 12}px`; st.ghost.style.top = `${ev.clientY + 12}px`; }
    };

    const onCancel = () => end(false);

    const onUp = async (ev) => {
      if (!st) return;
      const armed = st.armed, tabKey = st.tabKey, dropX = ev.clientX, dropY = ev.clientY;
      // Swallow the trailing click ONLY when the release lands on the nav. A click fires on the common
      // ancestor of the pointerdown+pointerup targets, so an OFF-nav drop produces no trailing nav-click;
      // setting the suppress flag then would linger and eat the NEXT real tab click (F7).
      const releasedOnNav = !!(ev.target && nav.contains(ev.target));
      end(armed && releasedOnNav);
      if (!armed) return;
      ev.preventDefault();
      const left = Math.max(0, Math.min(dropX - 40, window.innerWidth - 220));
      const top = Math.max(0, Math.min(dropY - 8, window.innerHeight - 120));
      const { CyberpunkActorTabSheet } = await import("./actor-tab-popout.js");
      CyberpunkActorTabSheet.open(this.actor, tabKey, { left, top });
    };

    nav.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      const item = ev.target?.closest?.(".item[data-tab]");
      if (!item || !nav.contains(item)) return;
      if (item.classList.contains("cp-tab-detached")) {
        // Already popped out → just resurface its window; NEVER switch the main sheet to it. Handle it
        // here on pointerdown (earliest) and eat the trailing click so the nav can't switch.
        ev.preventDefault();
        ev.stopImmediatePropagation();
        this._cpSuppressTabClick = true;
        const tabKey = item.dataset.tab;
        import("./actor-tab-popout.js").then((m) => m.CyberpunkActorTabSheet.open(this.actor, tabKey));
        return;
      }
      end(false); // clear any stale gesture
      // Bind the gesture to the document that owns the tab RIGHT NOW — main window normally, or the
      // popout window once PopOut! has moved the sheet — so move/up fire and the ghost shows there.
      const doc = item.ownerDocument || document;
      st = { tabKey: item.dataset.tab, item, x: ev.clientX, y: ev.clientY, armed: false, timer: null, ghost: null, doc };
      item.classList.add("cp-tab-pressing"); // grab cursor from the moment of press
      st.timer = setTimeout(arm, HOLD_MS);
      doc.addEventListener("pointermove", onMove, true);
      doc.addEventListener("pointerup", onUp, true);
      doc.addEventListener("pointercancel", onCancel, true);
    }, true);

    // Capture phase: eat the click that follows an armed tear-off or a detached-tab focus so the nav
    // doesn't also switch tabs.
    nav.addEventListener("click", (ev) => {
      if (this._cpSuppressTabClick) {
        this._cpSuppressTabClick = false;
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    }, true);
  }

  /** Grey out the nav tabs whose content is currently popped out into its own window (and un-grey the
   *  rest). Driven on render and whenever a tab window opens/closes. */
  _refreshDetachedTabs(exclude = null) {
    // this.element is the native element on ApplicationV2; the old `?.[0]` indexed it like a V1
    // jQuery wrapper and always yielded undefined, so this whole method silently no-op'd.
    const root = getHtmlElement(this.element);
    if (!root) return;
    // `exclude` = a popout that is CLOSING right now: its registry entry / rendered flag can settle
    // a tick after its close() resolves, so it must be dropped from the open set explicitly or the
    // nav mark sticks forever (the tear-out keeper's recovery leg).
    const open = new Set(
      Object.values(this.actor?.apps ?? {})
        .filter((a) => a !== exclude && !a._cpClosing && a.constructor?.name === "CyberpunkActorTabSheet" && a.rendered)
        .map((a) => a.tabKey)
    );
    const items = [...root.querySelectorAll("nav.sheet-tabs .item[data-tab]")];
    items.forEach((item) => {
      item.classList.toggle("cp-tab-detached", open.has(item.dataset.tab));
    });

    // Don't render a popped-out tab in BOTH places: if the tab currently shown on THIS sheet is now
    // detached, switch the main sheet to the first non-detached tab so only the popout renders it.
    // (Also un-sticks the parent after a re-render: the active tab is never left as the detached one.)
    if (!items.length || !this._cpTabs) return;
    // Read the live active tab from the DOM (reliable; this._cpActiveTab can lag a programmatic switch).
    const activeKey = root.querySelector("nav.sheet-tabs .item.active[data-tab]")?.dataset.tab
      ?? this._cpActiveTab ?? CyberpunkActorSheet.TAB_CONFIG.initial;
    if (open.has(activeKey)) {
      const fallback = items.map((i) => i.dataset.tab).find((t) => !open.has(t));
      if (fallback) this._cpTabs.activate(fallback);
    }
  }

  /** True if (x,y) is empty space — not over any app window or the sidebar — i.e. the "drag-off"
   *  delete zone. (Dropping on the canvas/desktop deletes; on another sheet/dialog/sidebar it doesn't.) */
  _isGearDropToVoid(x, y, doc = document) {
    const el = doc.elementFromPoint?.(x, y) ?? null;
    return !el?.closest?.(".app, .application, #sidebar");
  }

  /** Shared delete-item confirm dialog (used by the row delete controls and the gear drag-off gesture). */
  _confirmDeleteItem(item) {
    if (!item) return;
    foundry.applications.api.DialogV2.confirm({
      window: { title: localize("ItemDeleteConfirmTitle") },
      content: `<p>${localizeParam("ItemDeleteConfirmText", { itemName: item.name })}</p>`,
      // Guard the delete: DialogV2 disables its buttons, awaits this callback, and only re-enables +
      // closes the dialog when the callback RESOLVES. A raw `() => item.delete()` that rejects (or
      // hangs) leaves the dialog stuck open with dead buttons. Swallow-and-report so it always resolves.
      yes: { label: localize("Yes"), callback: async () => {
        try { await item.delete(); }
        catch (e) {
          console.error(`cp2020-augmented | delete failed for "${item.name}"`, e);
          ui.notifications?.error(localizeParam("ItemDeleteFailed", { itemName: item.name }));
        }
      } },
      no: { label: localize("No"), default: true },
      rejectClose: false,
    });
  }

  /**
   * Gear tab drag gestures:
   *  - drag a gear row and drop it within the list → reorder (persisted via the item `sort` field);
   *  - drag a gear row OFF this window (released in empty space) → raise the delete confirm;
   *  - dropping onto another actor's sheet still copies (Foundry default) and does NOT delete here.
   * State is per-sheet-instance, so a popped-out Gear tab reorders/deletes against ITS own window.
   */
  _activateGearDragSort(root) {
    const list = root?.querySelector?.(".gear-sortable");
    if (!list) return;

    const clearMarks = () => list
      .querySelectorAll(".cp-gear-drop-before, .cp-gear-drop-after")
      .forEach((el) => el.classList.remove("cp-gear-drop-before", "cp-gear-drop-after"));

    let dragId = null, dropTargetId = null, dropBefore = true;

    list.querySelectorAll(".gear[data-item-id]").forEach((row) => {
      row.setAttribute("draggable", "true");
      row.addEventListener("dragstart", (ev) => {
        dragId = row.dataset.itemId;
        const item = this.actor.items.get(dragId);
        // Standard Item payload so dropping on another sheet still copies normally.
        try { ev.dataTransfer.setData("text/plain", JSON.stringify(item?.toDragData?.() ?? { type: "Item", uuid: item?.uuid })); } catch (_) {}
        ev.dataTransfer.effectAllowed = "all";
        row.classList.add("cp-gear-dragging");
      });
      row.addEventListener("dragend", (ev) => {
        row.classList.remove("cp-gear-dragging");
        clearMarks();
        // Released over empty space (not over any app window/sidebar) → offer to delete. A drop within
        // this sheet reorders; a drop on another sheet copies (Foundry default). We can't trust
        // dropEffect — the canvas accepts the drag, so it isn't "none" when released off the sheet.
        if (dragId) {
          const doc = ev.currentTarget?.ownerDocument ?? document;
          if (this._isGearDropToVoid(ev.clientX, ev.clientY, doc)) this._confirmDeleteItem(this.actor.items.get(dragId));
        }
        dragId = null; dropTargetId = null;
      });
    });

    list.addEventListener("dragover", (ev) => {
      if (!dragId) return; // only OUR gear-row drags reorder; external drops fall through to core
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      const row = ev.target.closest?.(".gear[data-item-id]");
      clearMarks();
      if (!row || row.dataset.itemId === dragId) { dropTargetId = null; return; }
      const r = row.getBoundingClientRect();
      dropBefore = (ev.clientY - r.top) < r.height / 2;
      dropTargetId = row.dataset.itemId;
      row.classList.add(dropBefore ? "cp-gear-drop-before" : "cp-gear-drop-after");
    });

    list.addEventListener("drop", async (ev) => {
      if (!dragId) return;
      ev.preventDefault();
      ev.stopPropagation();
      clearMarks();
      const source = this.actor.items.get(dragId);
      const target = dropTargetId ? this.actor.items.get(dropTargetId) : null;
      if (!source || !target || source.id === target.id) return;
      // Rebuild the displayed order with the source moved before/after the target (per the cursor
      // half), then reindex every gear item's `sort` — deterministic and honours the drop indicator.
      const ids = this._gearTabItems(this.actor.items).map((i) => i.id).filter((id) => id !== source.id);
      const idx = ids.indexOf(target.id);
      if (idx < 0) return;
      ids.splice(dropBefore ? idx : idx + 1, 0, source.id);
      const updates = ids.map((id, i) => ({ _id: id, sort: (i + 1) * 100000 }));
      await this.actor.updateEmbeddedDocuments("Item", updates);
    });
  }

  /**
   * Build drag payload for an Item already owned by this Actor.
   * @param {Item} item
   * @returns {object}
   * @private
   */
  _cpOwnedItemDragData(item) {
    const dragData = (typeof item?.toDragData === "function")
      ? item.toDragData()
      : { type: "Item", uuid: item?.uuid };

    dragData.type = dragData.type || "Item";
    dragData.uuid = dragData.uuid || item?.uuid;
    dragData.actorId = this.actor.id;
    dragData.actorUuid = this.actor.uuid;
    dragData.itemId = item.id;

    return dragData;
  }

  /**
   * @param {DragEvent} event
   * @param {Item} item
   * @private
   */
  _cpWriteOwnedItemDragData(event, item) {
    const dragData = this._cpOwnedItemDragData(item);
    event.dataTransfer?.setData("text/plain", JSON.stringify(dragData));
  }

  /**
   * Extract possible Item ids from Foundry drag data.
   * @param {object} data
   * @returns {string[]}
   * @private
   */
  _cpDropItemIdCandidates(data) {
    const ids = [];
    const add = (value) => {
      if (value == null || value === "") return;
      const id = String(value);
      if (!ids.includes(id)) ids.push(id);
    };

    add(data?.itemId);
    add(data?.data?._id);
    add(data?._id);

    const uuid = String(data?.uuid ?? data?.documentUuid ?? data?.itemUuid ?? "");
    const marker = ".Item.";
    const idx = uuid.indexOf(marker);
    if (idx >= 0) add(uuid.slice(idx + marker.length).split(".")[0]);

    return ids;
  }

  /**
   * Does the drop payload represent an Item already owned by this Actor?
   * @param {object} data
   * @returns {boolean}
   * @private
   */
  _cpIsSameActorItemDrop(data) {
    if (!data || data.type !== "Item") return false;

    if (data.actorId && String(data.actorId) === String(this.actor.id)) return true;
    if (data.actorUuid && String(data.actorUuid) === String(this.actor.uuid)) return true;

    const uuid = String(data.uuid ?? data.documentUuid ?? data.itemUuid ?? "");
    if (!uuid) return false;

    if (uuid.startsWith(`${this.actor.uuid}.Item.`)) return true;
    if (uuid.includes(`Actor.${this.actor.id}.Item.`)) return true;

    return false;
  }

  /**
   * Resolve a same-actor drop to the existing owned Item.
   * @param {object} data
   * @returns {Item|null}
   * @private
   */
  _cpGetOwnedDropItem(data) {
    for (const id of this._cpDropItemIdCandidates(data)) {
      const item = this.actor.items.get(id);
      if (item) return item;
    }
    return null;
  }

  /**
   * Normalize an Item document or plain Item source object to source data.
   * @param {Item|object} itemOrData
   * @returns {object}
   * @private
   */
  _cpToItemSource(itemOrData) {
    if (typeof itemOrData?.toObject === "function") return itemOrData.toObject();
    return foundry.utils.deepClone(itemOrData ?? {});
  }

  /**
   * Resolve dropped Item data.
   *
   * @param {object} data
   * @returns {Promise<{item: Item|null, itemData: object, sameActor: boolean}>}
   * @private
   */
  async _cpResolveDroppedItem(data) {
    const sameActor = this._cpIsSameActorItemDrop(data);
    const owned = sameActor ? this._cpGetOwnedDropItem(data) : null;
    if (owned) return { item: owned, itemData: owned.toObject(), sameActor: true };

    const resolved = await itemFromDropData(data);
    const resolvedSameActor = !!(resolved?.parent && resolved.parent === this.actor);
    const item = resolvedSameActor ? resolved : null;
    const itemData = this._cpToItemSource(resolved);

    return { item, itemData, sameActor: sameActor || resolvedSameActor };
  }

  /**
   * Warn (but do NOT block) when dropping a skill the actor already has, matched by normalized name.
   * Several CP2020 skills are legitimately taken multiple times for different foci (Play Instrument,
   * Teaching, Perform, Composition, …) and our compendium ships them under one generic name, so a hard
   * block would break those — this just flags accidental sheet→sheet / compendium duplicates. The drop
   * still proceeds. Side-effect-free (resolve + notify only).
   * @param {object} data  the drop payload
   * @private
   */
  async _cpWarnDuplicateSkillDrop(data) {
    try {
      const { itemData, sameActor } = await this._cpResolveDroppedItem(data);
      // Owned-item self-drag (the drop resolves to an item already on this actor — a sheet→sheet drag,
      // which Foundry treats as a sort, NOT an add): never warn. The `sameActor` flag resolved here
      // (via the dropped item's parent) is reliable where the cheap _cpIsSameActorItemDrop pre-check on
      // the bare payload can miss it. The warning is for COMPENDIUM drops that would add a real dup.
      if (sameActor) return;
      if (itemData?.type !== "skill") return;
      const norm = (s) => String(s ?? "").trim().toLowerCase();
      const has = this.actor.items.some(i => i.type === "skill" && norm(i.name) === norm(itemData.name));
      if (has) ui.notifications?.warn(localize("DuplicateSkillAdded", { name: itemData.name }));
    } catch (_) { /* resolution failed → leave it to the normal drop flow */ }
  }

  /**
   * Return an owned Item for a drop target, creating one only for external drops.
   *
   * @param {object} data
   * @param {{item: Item|null, itemData: object, sameActor: boolean}|null} resolved
   * @returns {Promise<{item: Item|null, itemData: object, sameActor: boolean}>}
   * @private
   */
  async _cpEnsureDroppedItemOwned(data, resolved = null) {
    const drop = resolved ?? await this._cpResolveDroppedItem(data);
    if (drop.item) return drop;

    const existing = drop.itemData?._id ? this.actor.items.get(drop.itemData._id) : null;
    if (existing) {
      return { item: existing, itemData: existing.toObject(), sameActor: drop.sameActor };
    }

    const created = await this.actor.createEmbeddedDocuments("Item", [drop.itemData]);
    const item = created[0] ?? null;
    return { item, itemData: item?.toObject() ?? drop.itemData, sameActor: false };
  }

  async _onActiveUnequip(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();

    // Native dispatch (Stage A2): the listener is on the sheet root, so resolve the unequip control
    // from event.target rather than currentTarget.
    const target = event.target?.closest?.('.item-unequip') ?? event.currentTarget;
    const id = target?.dataset?.itemId
            || target?.closest?.('[data-item-id]')?.dataset?.itemId;

    if (!id) return;
    if (await this._cpUninstallCyber(id)) this.render(true);
  }

  /**
   * Uninstall an installed cyberware and everything nested inside it → Carried Options, non-destructively:
   * unequip + clear the host link (Module.ParentId) + clear the body side + drop the chip-active flag, for
   * the item AND all its descendants. Taking a container off the body takes its contents off with it (kept
   * in inventory, re-installable) so nothing is left equipped-but-hostless. This is the single uninstall
   * path shared by the per-row control (_onActiveUnequip) and the drag-off-the-body gesture (_onDropItem).
   * Returns true when something was uninstalled. Does not re-render (the caller decides).
   * @param {string} id  the cyberware item id
   */
  async _cpUninstallCyber(id) {
    const item = this.actor.items.get(id);
    if (!item) return false;
    const items = this.actor.items?.contents ?? [];
    const ids = [id, ...descendantIds(items, id)];
    // Type-aware cascade: cyberware descendants unequip + shed their host links; NON-cyberware
    // stowed in a compartment clears its OWN containment field (mechContainer.installedIn) —
    // pushing cyberware-shaped keys at a misc item would be stripped by its DataModel while the
    // stale link kept it hidden and its slots consumed.
    const updates = ids.map((i) => {
      const it = this.actor.items.get(i);
      if (it?.type !== "cyberware") return { _id: i, "system.mechContainer.installedIn": "" };
      const patch = {
        _id: i,
        "system.equipped": false,
        "system.CyberWorkType.ChipActive": false,
        "system.Module.ParentId": "",
        "system.CyberBodyType.Location": "",
      };
      // Restore a MountZone that host-nesting overwrote (stashed under the origMountZone flag), then
      // drop the stash with the `-=` deletion idiom — otherwise the freed option stays routed to the
      // now-detached host's zone. No stash flag ⇒ never nested cross-zone ⇒ leave MountZone alone.
      const orig = it?.getFlag?.("cp2020-augmented", "origMountZone");
      if (orig !== undefined) {
        patch["system.MountZone"] = orig;
        patch["flags.cp2020-augmented.-=origMountZone"] = null;
      }
      return patch;
    });
    await this.actor.updateEmbeddedDocuments("Item", updates, { render: false });
    await this._cp_syncChipLevelsToSkills();
    await this._cp_syncActiveFlagsToSkills();
    if (item.sheet?.rendered) item.sheet.render(true);
    return true;
  }

  /** @override */
  /** Intercept a shop "drag-to-buy" drop before the normal item-drop flow: a shop row dropped here
   *  purchases the item/service for THIS actor (owner-gated). Everything else falls through to core. */
  async _onDrop(event) {
    let data = null;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { /* not our JSON payload */ }
    if (data?.type === "cyberpunk2020Purchase") {
      event.preventDefault();
      if (!this.actor?.isOwner) return;
      return purchaseByDrop(this.actor, data);
    }
    return super._onDrop(event);
  }

  async _onDropItem(event, data) {
    event.preventDefault();

    const dropTarget = event.target.closest("[data-drop-target]");
    const sameActorDrop = this._cpIsSameActorItemDrop(data);

    if (!dropTarget) {
      if (sameActorDrop) {
        // Drag-off-the-body → uninstall: an equipped cyberware row dragged out of the anatomy map and
        // dropped on empty sheet space (or off the window) comes off the body → Carried Options,
        // mirroring the per-row ⏏. Any other same-actor drop with no target is a no-op sort.
        const owned = this._cpGetOwnedDropItem(data);
        if (owned?.type === "cyberware" && owned.system?.equipped === true) {
          if (await this._cpUninstallCyber(owned.id)) this.render(true);
        }
        return false;
      }
      await this._cpWarnDuplicateSkillDrop(data);
      return super._onDropItem(event, data);
    }

    const target = dropTarget.dataset.dropTarget;
    const warn = (msg) => ui.notifications?.warn(msg);

    if (target === "program-list") {
      const resolved = await this._cpResolveDroppedItem(data);
      const { itemData, sameActor } = resolved;

      if (itemData.type !== "program") {
        return ui.notifications.warn(localize("NotAProgram", { name: itemData.name }));
      }

      if (sameActor) {
        const existing = resolved.item ?? this._cpGetOwnedDropItem(data) ?? this.actor.items.get(itemData._id);
        if (existing) ui.notifications.warn(localize("ProgramAlreadyExists", { name: existing.name }));
        return false;
      }

      return this.actor.createEmbeddedDocuments("Item", [itemData]);
    }

    if (target === "active-programs") {
      const resolved = await this._cpResolveDroppedItem(data);
      const { itemData } = resolved;

      if (itemData.type !== "program") {
        return ui.notifications.warn(localize("OnlyProgramsCanBeActivated", { name: itemData.name }));
      }

      const { item } = await this._cpEnsureDroppedItemOwned(data, resolved);
      if (!item) return;

      const currentActive = [...(this.actor.system.activePrograms || [])];
      const newMu = Number(item.system.mu) || 0;

      const usedMu = currentActive.reduce((sum, id) => {
        const p = this.actor.items.get(id);
        return sum + (Number(p?.system.mu) || 0);
      }, 0);

      const ramMax = Number(this.actor.system.ramMax) || 0;
      if (ramMax && (usedMu + newMu) > ramMax) {
        return ui.notifications.warn(
          localize("NotEnoughRAM", { name: item.name, used: usedMu, max: ramMax })
        );
      }

      if (!currentActive.includes(item.id)) {
        currentActive.push(item.id);

        await this.actor.update({
          "system.activePrograms": currentActive,
          "system.ramUsed": usedMu + newMu
        });

        this.render(true);
      }

      return;
    }

    if (target === "active-chips") {
      const resolved = await this._cpResolveDroppedItem(data);
      const { itemData } = resolved;

      if (itemData.type !== "cyberware") return warn(localize("ChipwareOnlyHere"));

      const cwt = itemData.system?.CyberWorkType ?? {};
      const types = Array.isArray(cwt.Types) ? cwt.Types : (cwt.Type ? [cwt.Type] : []);
      if (!types.includes("Chip")) return warn(localize("OnlyChipsHere"));

      const { item } = await this._cpEnsureDroppedItemOwned(data, resolved);
      if (!item) return;

      await item.update({
        "system.equipped": true,
        "system.CyberWorkType.ChipActive": true
      }, { render: false });

      await this._cp_syncChipLevelsToSkills();
      await this._cp_syncActiveFlagsToSkills();

      if (item.sheet?.rendered) item.sheet.render(true);
      this.render(true);
      return;
    }

    if (target === "cyber-inventory") {
      const resolved = await this._cpResolveDroppedItem(data);
      const { itemData } = resolved;

      if (itemData.type !== "cyberware") return warn(localize("OnlyCyberwareHere"));

      const { item } = await this._cpEnsureDroppedItemOwned(data, resolved);
      if (!item) return;

      // Dropped on Carried Options → uninstall to the parts bin (cascade the item + its nested options
      // off the body). Same non-destructive path as the ⏏ control; a newly-added external drop simply
      // lands here carried.
      await this._cpUninstallCyber(item.id);
      this.render(true);
      return;
    }

    // Dropped onto a HOST implant row in the body map → nest the option inside it (Q6 container link),
    // when the host has room. This is what makes telescoping work for a normal character (a scope into a
    // cybereye), not just materialized borg loadouts. Falls back to a standalone in the host's own zone
    // when the host can't contain it, so the drop is never silently lost.
    if (target?.startsWith("host:")) {
      const hostId = target.split(":")[1];
      const host = this.actor.items.get(hostId);
      const resolved = await this._cpResolveDroppedItem(data);
      const { itemData } = resolved;

      if (itemData.type !== "cyberware") return warn(localize("OnlyCyberwareHere"));

      const { item } = await this._cpEnsureDroppedItemOwned(data, resolved);
      if (!item || !host || item.id === host.id) return;

      const items = this.actor.items?.contents ?? [];
      const check = checkInstall(item, host, items);
      if (check.ok) {
        // Nest: link to the host + inherit its zone/side so the option sits in the right place. Stash
        // the option's OWN MountZone first (only once — a re-nest onto another host must not overwrite
        // the true original with a host-inherited value) so uninstall can restore it instead of leaving
        // the freed option re-routed to the detached host's zone.
        const nestUpdate = {
          "system.equipped": true,
          "system.Module.ParentId": host.id,
          "system.MountZone": host.system?.MountZone || item.system?.MountZone || "",
          "system.CyberBodyType.Location": host.system?.CyberBodyType?.Location || ""
        };
        if (item.getFlag("cp2020-augmented", "origMountZone") === undefined) {
          nestUpdate["flags.cp2020-augmented.origMountZone"] = item.system?.MountZone ?? "";
        }
        await item.update(nestUpdate, { render: false });
        if (item.sheet?.rendered) item.sheet.render(true);
        return this.render(true);
      }
      // Can't nest here (the base cyberware rules) — say WHY, then install it standalone in the host's
      // zone so the drop isn't lost. This is what blocks e.g. an optic mount from nesting inside an optic.
      let msg;
      switch (check.reason) {
        case "not-module":    msg = localizeParam("CyberNestNotModule", { item: item.name }); break;
        case "wrong-type":    msg = localizeParam("CyberNestWrongType", { item: item.name, type: check.param?.type ?? "" }); break;
        case "full":          msg = localizeParam("CyberNestFull", { host: host.name }); break;
        case "not-container": msg = localizeParam("CyberNestNoSlots", { host: host.name }); break;
        default:              msg = localizeParam("CyberNestGeneric", { item: item.name, host: host.name });
      }
      warn(msg);
      return this._cpEquipCyberIntoZone(item, itemData, cyberAreaOf(host));
    }

    if (target?.startsWith("zone:")) {
      const zoneKey = target.split(":")[1];
      const resolved = await this._cpResolveDroppedItem(data);
      const { itemData } = resolved;

      if (itemData.type !== "cyberware") return warn(localize("OnlyCyberwareHere"));

      const { item } = await this._cpEnsureDroppedItemOwned(data, resolved);
      if (!item) return;

      return this._cpEquipCyberIntoZone(item, itemData, zoneKey);
    }

    if (sameActorDrop) return false;
    await this._cpWarnDuplicateSkillDrop(data);
    return super._onDropItem(event, data);
  }

  /**
   * Equip a cyberware as a STANDALONE implant in an anatomy zone (a root in that limb, not nested in a
   * host). A chip activates instead; a mount-zone implant takes the dropped side and is checked against a
   * full borg's per-zone option pool. Clears any stale host link so it renders as a zone root. Renders on
   * success. Shared by the `zone:` drop target and the `host:` fallback when the host can't contain it.
   * @param {Item} item        the owned cyberware being equipped
   * @param {object} itemData  its source data (type/CyberWorkType/MountZone), pre-resolved
   * @param {string} zoneKey   the anatomy area id (head/body/nervous/l-arm/r-arm/l-leg/r-leg)
   */
  async _cpEquipCyberIntoZone(item, itemData, zoneKey) {
    const warn = (msg) => ui.notifications?.warn(msg);
    const cwt = itemData.system?.CyberWorkType ?? {};
    const types = Array.isArray(cwt.Types) ? cwt.Types : (cwt.Type ? [cwt.Type] : []);

    if (types.includes("Chip")) {
      await item.update({
        "system.equipped": true,
        "system.CyberWorkType.ChipActive": true,
        "system.CyberBodyType.Location": "",
        "system.Module.ParentId": ""
      }, { render: false });
      await this._cp_syncChipLevelsToSkills();
      await this._cp_syncActiveFlagsToSkills();
      if (item.sheet?.rendered) item.sheet.render(true);
      return this.render(true);
    }

    const mount = String(itemData.system?.MountZone || itemData.system?.CyberBodyType?.Type || "");
    const updates = { "system.equipped": true, "system.Module.ParentId": "" };

    const sideFromDrop = (key) => ({
      "l-arm": "Left", "r-arm": "Right",
      "l-leg": "Left", "r-leg": "Right"
    })[key];

    if (mount === "Arm" || mount === "Leg") {
      const dropSide = sideFromDrop(zoneKey);
      updates["system.CyberBodyType.Location"] =
        dropSide || (itemData.system?.CyberBodyType?.Location || "Left");
    } else {
      updates["system.CyberBodyType.Location"] = "";
    }

    // Borg option-space limit: block a drop that would exceed the chassis's per-zone option pool.
    // Only positive per-zone caps enforce (0/undefined = unconstrained, so imperfect data can't lock
    // a zone). The zone the item lands in follows its MountZone + the resolved side. Only the zone's
    // ROOT items consume the pool — container-nested items consume their container's capacity instead
    // (an item counts against its immediate parent, never both).
    const spaces = borgOptionSpaces(this.actor);
    if (spaces) {
      const destArea = cyberAreaOf({ system: { MountZone: mount, CyberBodyType: { Type: mount, Location: updates["system.CyberBodyType.Location"] } } });
      const cap = Number(spaces[destArea]) || 0;
      if (cap > 0) {
        const list = this.actor.items?.contents ?? [];
        const isRoot = (it) => {
          const pid = installedInOf(it);
          const host = pid ? list.find((x) => x.id === pid) : null;
          return !host || isBorgBody(host);
        };
        const used = list
          // Placement, not power, consumes zone space (the PLACEMENT-vs-POWER design comment above the
          // placedCyber tally): a switched-OFF implant still holds its slot, so the gate counts every
          // PLACED root — no cwIsEnabled — to match the zone badge (which tallies placedCyber roots).
          .filter(it => it.id !== item.id && it.system?.equipped && cyberAreaOf(it) === destArea && isRoot(it))
          .reduce((s, it) => s + slotsTakenOf(it), 0);
        if (used + slotsTakenOf(item) > cap) return warn(localizeParam("ZoneOptionSpacesFull", { used, total: cap }));
      }
    }

    await item.update(updates);
    return this.render(true);
  }

  async _cp_syncChipLevelsToSkills() {
    const actor = this.actor;
    if (!actor) return;

    const activeChips = actor.items.filter(i =>
      i.type === "cyberware" &&
      cwHasType(i, "Chip") &&
      i.system?.equipped !== false &&
      !!i.system?.CyberWorkType?.ChipActive
    );

    const agg = {};
    for (const ch of activeChips) {
      const skills = ch.system?.CyberWorkType?.ChipSkills || {};
      for (const [key, lvl] of Object.entries(skills)) {
        const n = Number(lvl) || 0;
        agg[key] = Math.max(agg[key] || 0, n);
      }
    }

    const skills = actor.items.filter(i => i.type === "skill");
    const updates = [];
    const updatedIds = [];
    const updatedMap = {};

    for (const s of skills) {
      const want = Number(agg[s.id] ?? agg[s.name] ?? 0);
      const cur  = Number(s.system?.chipLevel || 0);
      if (want !== cur) {
        updates.push({ _id: s.id, "system.chipLevel": want });
        updatedIds.push(s.id);
        updatedMap[s.id] = { ...(updatedMap[s.id] || {}), chipLevel: want };
      }
    }

    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, { render: false });

      this._cp_forceRefreshOpenSkillSheets(updatedMap);

      for (const sid of updatedIds) {
        const sk = actor.items.get(sid);
        if (sk?.sheet?.rendered) sk.sheet.render(true);
      }
    }
  }

  _cp_forceRefreshOpenSkillSheets(updatedMap) {
    // updatedMap: { [skillId]: { isChipped?: boolean, chipLevel?: number } }
    if (!updatedMap) return;

    for (const [sid, patch] of Object.entries(updatedMap)) {
      const skill = this.actor.items.get(sid);
      const sheet = skill?.sheet;
      if (!sheet?.rendered) continue;

      // sheet.element is a native HTMLElement on the V2 item sheet; the old jQuery `.find()` threw here
      // ("html.find is not a function"), aborting the tail of the chip-toggle / unequip / drop handler.
      const root = sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
      if (!root) continue;

      if (Object.prototype.hasOwnProperty.call(patch, "isChipped")) {
        const cb = root.querySelector('input[name="system.isChipped"]');
        if (cb) cb.checked = !!patch.isChipped;
      }

      if (Object.prototype.hasOwnProperty.call(patch, "chipLevel")) {
        for (const inp of root.querySelectorAll('input[name="system.chipLevel"], select[name="system.chipLevel"]')) {
          inp.value = String(patch.chipLevel);
        }
      }
    }
  }

  async _cp_syncActiveFlagsToSkills() {
    const actor = this.actor;
    if (!actor) return;

    const activeChips = actor.items.filter(i =>
      i.type === "cyberware" &&
      cwHasType(i, "Chip") &&
      i.system?.equipped !== false &&
      !!i.system?.CyberWorkType?.ChipActive
    );

    const activeMap = {};
    for (const ch of activeChips) {
      const skills = ch.system?.CyberWorkType?.ChipSkills || {};
      for (const key of Object.keys(skills)) activeMap[key] = true;
    }

    const skills = actor.items.filter(i => i.type === "skill");
    const updates = [];
    const updatedIds = [];
    const updatedMap = {};

    for (const s of skills) {
      const want = !!(activeMap[s.id] ?? activeMap[s.name]);
      const cur  = !!(s.system?.isChipped);
      if (want !== cur) {
        updates.push({ _id: s.id, "system.isChipped": want });
        updatedIds.push(s.id);
        updatedMap[s.id] = { ...(updatedMap[s.id] || {}), isChipped: want };
      }
    }

    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, { render: false });

      this._cp_forceRefreshOpenSkillSheets(updatedMap);

      for (const sid of updatedIds) {
        const sk = actor.items.get(sid);
        if (sk?.sheet?.rendered) sk.sheet.render(true);
      }
    }
  }

  /**
   * Life-tab notes editor wiring. Mirrors upstream's `_cpActivateNotesEditor`: sets up the
   * view↔edit toggle (the Edit button) and the debounced ProseMirror autosave. Both inner helpers
   * are idempotent across re-renders (each removes its prior listener before re-binding).
   */
  _cpActivateNotesEditor(root) {
    this._cpSetupNotesActions(root);
    this._cpSetupNotesAutosave(root);
  }

  /**
   * Leave notes edit mode: flush any pending content (force-serialized so an open-but-uncommitted
   * editor is captured), drop back to the read-only view, and optionally re-render so the template
   * swaps the ProseMirror editor for the rendered notes. Mirrors upstream's `_cpExitNotesEditing`.
   */
  async _cpExitNotesEditing(root, { render = false } = {}) {
    if (!this._cpNotesEditing) return;

    await this._cpFlushNotesAutosave(root, { force: true, serialize: true });
    this._cpNotesEditing = false;

    if (render && this.rendered) {
      await this.render({ force: true });
    }
  }

  /**
   * Bind the "Edit life notes" button (data-action="notes-edit"): clicking it enters edit mode and
   * re-renders so the ProseMirror editor replaces the read-only view. One delegated capture-phase
   * click listener on the root, removed + re-added each render so it stays single-bound. Mirrors
   * upstream's `_cpSetupNotesActions`.
   */
  _cpSetupNotesActions(root) {
    if (!root?.addEventListener) return;

    if (this._cpNotesActionsRoot && this._cpNotesActionsHandler) {
      try {
        this._cpNotesActionsRoot.removeEventListener("click", this._cpNotesActionsHandler, true);
      } catch (_) {}
    }

    const handler = async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const editButton = target.closest('[data-action="notes-edit"]');
      if (!editButton) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      this._cpNotesEditing = true;
      await this.render({ force: true });
    };

    root.addEventListener("click", handler, true);

    this._cpNotesActionsRoot = root;
    this._cpNotesActionsHandler = handler;
  }

  /**
   * Debounced ProseMirror autosave for the life-tab notes. Capture-phase listeners for
   * save/input/change/close on the root: a `save`/`close` flushes immediately and exits edit mode
   * (returns to the read-only view); input/change schedule a debounced flush. Self-gates on editable
   * and stays single-bound across re-renders. Mirrors upstream's `_cpSetupNotesAutosave`.
   */
  _cpSetupNotesAutosave(root) {
    if (!root?.addEventListener) return;

    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;

    if (!this._cpNotesAutosaveState) {
      this._cpNotesAutosaveState = {
        saving: false,
        pending: false,
        pendingForce: false,
        pendingSerialize: false,
        timer: null,
        lastSaved: String(this.actor.system?.notes ?? "")
      };
    }

    if (this._cpNotesAutosaveRoot && this._cpNotesAutosaveHandler) {
      for (const eventName of ["save", "input", "change", "close"]) {
        try {
          this._cpNotesAutosaveRoot.removeEventListener(eventName, this._cpNotesAutosaveHandler, true);
        } catch (_) {}
      }
    }

    const isNotesEvent = (event) => {
      const target = event?.target;
      if (!target?.closest) return false;

      const editor = target.closest(".cp-notes-editor");
      if (!editor) return false;

      const lifeTab = target.closest('.tab.life[data-tab="life"]') ?? target.closest(".tab.life");
      return !!lifeTab;
    };

    const scheduleFlush = ({ force = false, serialize = false, delay = 250 } = {}) => {
      const state = this._cpNotesAutosaveState;
      if (!state) return;

      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }

      state.timer = setTimeout(() => {
        state.timer = null;
        this._cpFlushNotesAutosave(root, { force, serialize });
      }, delay);
    };

    const handler = (event) => {
      if (!isNotesEvent(event)) return;

      if (event.type === "save" || event.type === "close") {
        window.setTimeout(async () => {
          await this._cpFlushNotesAutosave(root, { force: true, serialize: false });

          if (this._cpNotesEditing) {
            this._cpNotesEditing = false;
            await this.render({ force: true });
          }
        }, 0);

        return;
      }

      scheduleFlush({ force: false, serialize: false, delay: 350 });
    };

    for (const eventName of ["save", "input", "change", "close"]) {
      root.addEventListener(eventName, handler, true);
    }

    this._cpNotesAutosaveRoot = root;
    this._cpNotesAutosaveHandler = handler;
  }

  _cpReadNotesHTML(root, { serialize = false } = {}) {
    if (!root) return null;

    const reader = serialize ? saveRichEditorHTML : getRichEditorHTML;
    const html = reader(this, root, "system.notes", [".cp-notes-view"]);

    if (html != null) return html;

    return String(this.actor.system?.notes ?? "");
  }

  async _cpFlushNotesAutosave(root, { force = false, serialize = false } = {}) {
    const st = this._cpNotesAutosaveState;
    if (!st) return;

    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }

    if (st.saving) {
      st.pending = true;
      st.pendingForce = st.pendingForce || force;
      st.pendingSerialize = st.pendingSerialize || serialize;
      return;
    }

    const html = this._cpReadNotesHTML(root, { serialize });
    if (html == null) return;
    if (!force && st.lastSaved === html) return;

    st.saving = true;
    try {
      await this.actor.update({ "system.notes": html }, { render: false });
      st.lastSaved = html;
    } catch (err) {
      console.warn("CP2020: notes save failed", err);
    } finally {
      st.saving = false;

      if (st.pending) {
        const pendingForce = st.pendingForce;
        const pendingSerialize = st.pendingSerialize;

        st.pending = false;
        st.pendingForce = false;
        st.pendingSerialize = false;

        await this._cpFlushNotesAutosave(root, { force: pendingForce, serialize: pendingSerialize });
      }
    }
  }

  /**
   * Flush notes + tear down the notes listeners before the sheet closes. Replaces our former
   * `close()` override with upstream's `_preClose` hook (data-safety: nothing typed is lost on
   * close) and mirrors his cleanup. We force-serialize the flush (serialize:true) so an open,
   * uncommitted editor is still captured. Our own chip-tooltip cleanup is preserved.
   * @override
   */
  async _preClose(options) {
    try {
      const root = getHtmlElement(this.element);

      if (this._cpNotesAutosaveState?.timer) {
        clearTimeout(this._cpNotesAutosaveState.timer);
        this._cpNotesAutosaveState.timer = null;
      }

      await this._cpFlushNotesAutosave(root, { force: true, serialize: true });
      this._cpNotesEditing = false;
    } catch (_) {}

    try {
      this._cpChipTooltipCleanup?.();
      this._cpChipTooltipCleanup = null;
    } catch (_) {}

    try {
      if (this._cpNotesAutosaveRoot && this._cpNotesAutosaveHandler) {
        for (const eventName of ["save", "input", "change", "close"]) {
          this._cpNotesAutosaveRoot.removeEventListener(eventName, this._cpNotesAutosaveHandler, true);
        }
      }

      this._cpNotesAutosaveRoot = null;
      this._cpNotesAutosaveHandler = null;
    } catch (_) {}

    try {
      if (this._cpNotesActionsRoot && this._cpNotesActionsHandler) {
        this._cpNotesActionsRoot.removeEventListener("click", this._cpNotesActionsHandler, true);
      }

      this._cpNotesActionsRoot = null;
      this._cpNotesActionsHandler = null;
    } catch (_) {}

    return super._preClose(options);
  }
}
