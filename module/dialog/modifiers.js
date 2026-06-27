import { deepSet, localize, localizeParam } from "../utils.js"
import { fireModes, caliberMatches, normalizeCaliber, isEnergyAttackType } from "../lookups.js"
import { createCyberpunkChatMessage, getGMUserIds } from "../compat.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Dialog used to select attack, range, fire-mode and miscellaneous modifiers.
 * @implements {ApplicationV2}
 */
export class ModifiersDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  // Pin this window above the sheet it was opened from so clicking the sheet doesn't bury it.
  // Read by module/pin-window.js (registerPinnedSubwindows). See [[pin-window]].
  static CP_PIN_ON_TOP = true;

  /**
   * @param {Object} object  — legacy first argument (actor); kept for call-site compat but not used by the dialog itself
   * @param {Object} options — per-instance options: weapon, modifierGroups, targetTokens, extraMod,
   *                           showAdvDis, advantage, disadvantage, hiddenAdvantage, onConfirm, title
   */
  constructor(object, options = {}) {
    // Pull dialog-specific keys out before passing the rest to ApplicationV2.
    // ApplicationV2 accepts window.title via DEFAULT_OPTIONS; per-instance title comes from options.window.
    const {
      weapon           = null,
      modifierGroups   = [],
      targetTokens     = [],
      extraMod         = true,
      showAdvDis       = false,
      advantage        = false,
      disadvantage     = false,
      hiddenAdvantage  = false,
      onConfirm        = () => {},
      title,
      closeOnSubmit,   // consumed; ignored — V2 manages this via DEFAULT_OPTIONS.form
      ...rest
    } = options;

    // Allow a per-instance title via options.window.title or the legacy flat options.title.
    const windowOpts = rest.window ?? {};
    if (title && !windowOpts.title) windowOpts.title = title;
    super({ ...rest, window: windowOpts });

    this._weapon          = weapon;
    this._modifierGroups  = modifierGroups;
    this._targetTokens    = targetTokens;
    this._extraMod        = extraMod;
    this._showAdvDis      = showAdvDis;
    this._advantage       = advantage;
    this._disadvantage    = disadvantage;
    this._hiddenAdvantage = hiddenAdvantage;
    this._onConfirm       = onConfirm;

    // Per-instance data is held on the private fields above. ApplicationV2 FREEZES `this.options`,
    // so writing this._weapon etc. throws "object is not extensible"; internal code reads
    // the private fields instead.
  }

  static DEFAULT_OPTIONS = {
    id:      "weapon-modifier",
    classes: ["cyberpunk2020"],
    tag:     "form",
    window:  { title: "CYBERPUNK.AttackModifiers" },
    position: { width: 500, height: "auto" },
    actions: {},
    form: {
      handler:        ModifiersDialog._formHandler,
      submitOnChange: false,
      closeOnSubmit:  false,
    },
  };

  static PARTS = {
    main: { template: "modules/cp2020-augmented/templates/dialog/modifiers.hbs" },
  };

  /**
   * Return a reference to the target attribute (legacy compat).
   * @type {String}
   */
  get attribute() {
    return this.options.name;
  }

  async _prepareContext(options) {
    // Augment the base V2 context rather than replacing it (Tilt's sheet pattern) — more
    // robust if the framework starts seeding context fields in a future Foundry version.
    const context = await super._prepareContext(options);
    const groups = JSON.parse(JSON.stringify(this._modifierGroups || []));

    if (this._weapon) {
      const sys = this._weapon._getWeaponSystem ? this._weapon._getWeaponSystem() : this._weapon.system;
      const rof = Number(sys?.rof) || 0;
      const shotsLeft = Number(sys?.shotsLeft) || 0;
      groups.forEach(group => {
        group.forEach(mod => {
          if (mod.dataPath === "roundsFired" && (mod.defaultValue === undefined || mod.defaultValue === null || mod.defaultValue === "")) {
            mod.defaultValue = rof;
            if (mod.min === undefined) mod.min = 1;
            if (mod.max === undefined) mod.max = shotsLeft;
          }
        });
      });
    }

    if (this._extraMod) {
      const already = groups.some(g =>
        g.some(m => m.dataPath === "extraMod"));
      if (!already) {
        groups.push([{
          localKey: "ExtraModifiers",
          dataPath: "extraMod",
          defaultValue: 0
        }]);
      }
    }

    const defaultValues = {};
    groups.forEach(group => {
      group.forEach(mod => {
        const t = mod.choices ? "select" : (["string","number","boolean"].includes(typeof mod.defaultValue) ? typeof mod.defaultValue : "string");
        mod.fieldPath = `fields/${t}`;
        deepSet(defaultValues, mod.dataPath, mod.defaultValue !== undefined ? mod.defaultValue : "");
      });
    });

    return {
      ...context,
      modifierGroups: groups,
      targetTokens: this._targetTokens,
      defaultValues,
      isRanged: this._weapon?.isRanged?.() ?? false,
      // Per-actor ammo-tracking flag (default ON). Unchecked here = Free Fire (weapon ignores ammo).
      // Relocated from the combat-tab Weapons header; the toggle lives in this dialog now.
      ammoTracking: (this._weapon?.actor?.getFlag?.("cyberpunk2020", "ammoTracking")) ?? true,
      shotsLeft: (this._weapon?._getWeaponSystem?.().shotsLeft) ?? (this._weapon?.system.shotsLeft) ?? 0,
      showAdvDis: this._showAdvDis,
      advantage: this._advantage,
      disadvantage: this._disadvantage,
      isGM: game.user.isGM
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if (!root) return;

    // Select a field's contents on focus so the player can immediately type to overwrite it
    // (e.g. the Extra Modifiers value) instead of the caret landing mid-value.
    for (const inp of root.querySelectorAll('input[type="number"], input[type="text"]')) {
      inp.addEventListener("focus", () => { try { inp.select(); } catch (_) {} });
    }

    // ── AMMO TRACKING / FREE FIRE ───────────────────────────────────────────
    // Per-actor toggle, relocated here from the combat-tab Weapons header. Unchecked = Free Fire
    // (the weapon ignores ammo). Writes the same flags.cyberpunk2020.ammoTracking the fire/reload
    // paths read, so the behaviour is unchanged — only the control moved. The label flips to match.
    root.querySelector(".cp-ammo-tracking")?.addEventListener("change", async (ev) => {
      const on = !!ev.target.checked;
      const label = root.querySelector(".cp-ammo-tracking-label");
      if (label) label.textContent = localize(on ? "AmmoTracking" : "FreeFire");
      try {
        await this._weapon?.actor?.setFlag("cyberpunk2020", "ammoTracking", on);
      } catch (e) {
        console.warn("Cyberpunk2020 | ammo-tracking toggle failed", e);
      }
    });

    // ── RELOAD ──────────────────────────────────────────────────────────────
    root.querySelector(".reload")?.addEventListener("click", async (ev) => {
      ev.preventDefault();

      const weapon = this._weapon;
      if (!weapon) return;

      const sys = weapon._getWeaponSystem?.() ?? weapon.system ?? {};
      const capacity = Number(sys.shots ?? 0);
      const currentLeft = Number(sys.shotsLeft ?? 0);

      const weaponFieldPrefix = (weapon.type === "cyberware") ? "system.CyberWorkType.Weapon." : "system.";

      const updateWeaponShotsLeft = async (value) => {
        if (weapon.__setWeaponField) {
          await weapon.__setWeaponField("shotsLeft", value);
          return;
        }
        if (weapon.type === "cyberware") {
          await weapon.update({ "system.CyberWorkType.Weapon.shotsLeft": value });
        } else {
          await weapon.update({ "system.shotsLeft": value });
        }
      };

      const updateWeaponFields = async (fields, opts = { render: false }) => {
        const data = {};
        for (const [k, v] of Object.entries(fields)) data[`${weaponFieldPrefix}${k}`] = v;
        await weapon.update(data, opts);
      };

      const gmReloadAudit = async (shotsLeftAfter) => {
        try {
          const actor = weapon.actor;
          if (actor && actor.type !== "npc" && !game.user.isGM) {
            const gmRecipients = getGMUserIds();
            if (!gmRecipients.length) return;
            const shotsText = `${shotsLeftAfter}/${capacity}`;
            await createCyberpunkChatMessage({
              speaker: ChatMessage.getSpeaker({ actor }),
              whisper: gmRecipients,
              content: localizeParam("Chat.Reload", {
                actor: actor.name,
                weapon: weapon.name,
                shots: shotsText
              })
            });
          }
        } catch (err) {
          console.warn("Cyberpunk2020 | reload audit message failed", err);
        }
      };

      const applyLocalState = (shotsLeftAfter) => {
        if (weapon.type === "weapon") {
          this._weapon.system.shotsLeft = shotsLeftAfter;
        } else if (weapon.type === "cyberware" && weapon.system?.CyberWorkType?.Weapon) {
          this._weapon.system.CyberWorkType.Weapon.shotsLeft = shotsLeftAfter;
        }
        root.querySelectorAll("input.number[readonly]").forEach(el => { el.value = String(shotsLeftAfter); });
      };

      const ammoTracking = weapon.actor?.getFlag?.("cyberpunk2020", "ammoTracking") ?? true;
      const ammoItemId = String(sys.ammoItemId ?? "");

      if (!ammoTracking) {
        await updateWeaponShotsLeft(capacity);
        ui.notifications.info(localize("Reloaded"));
        await gmReloadAudit(capacity);
        applyLocalState(capacity);
        return;
      }

      if (isEnergyAttackType(sys.attackType)) {
        if (!Number.isFinite(capacity) || capacity <= 0) { ui.notifications.warn(localize("WeaponCannotRecharge")); return; }
        await updateWeaponShotsLeft(capacity);
        ui.notifications.info(localize("Recharged"));
        await gmReloadAudit(capacity);
        applyLocalState(capacity);
        return;
      }

      const actor = weapon.actor;
      if (!ammoItemId) {
        ui.notifications.warn(localize("NoLinkedAmmo"));
        return;
      }

      const ammoItem = actor?.items?.get(ammoItemId);
      if (!ammoItem || ammoItem.type !== "ammo") {
        ui.notifications.warn(localize("NoLinkedAmmo"));
        return;
      }

      const weaponCaliber = normalizeCaliber(sys.ammoType ?? "");
      if (!caliberMatches(weaponCaliber, ammoItem.system?.caliber ?? "")) {
        ui.notifications.warn(localizeParam("AmmoCaliberMismatch", {
          weapon: weaponCaliber || "?",
          ammo: normalizeCaliber(ammoItem.system?.caliber ?? "") || "?"
        }));
        return;
      }

      const loadedId = String(sys.loadedAmmoId ?? "");
      if (currentLeft > 0 && loadedId && loadedId !== ammoItemId) {
        ui.notifications.warn(localize("AmmoUnloadFirst"));
        return;
      }

      const ammoQty = Number(ammoItem.system?.quantity ?? 0);

      if (!Number.isFinite(capacity) || capacity <= 0) {
        ui.notifications.warn(localize("WeaponCannotReload"));
        return;
      }

      const missing = Math.max(0, capacity - currentLeft);
      if (missing <= 0) {
        ui.notifications.info(localize("Reloaded"));
        return;
      }

      if (ammoQty <= 0) {
        ui.notifications.warn(localize("NotEnoughAmmoToReload"));
        return;
      }

      const reloadByMagazines = !!game.settings.get("cyberpunk2020", "reloadByMagazines");

      let ammoToLoad;
      let shotsLeftAfter;
      if (reloadByMagazines) {
        ammoToLoad = Math.min(capacity, ammoQty);
        shotsLeftAfter = ammoToLoad;
      } else {
        ammoToLoad = Math.min(missing, ammoQty);
        shotsLeftAfter = currentLeft + ammoToLoad;
      }

      await ammoItem.update(
        { "system.quantity": Math.max(0, ammoQty - ammoToLoad) },
        { render: false }
      );

      const snapObj = ammoItem.toObject();
      const loadedSnap = { name: snapObj.name, img: snapObj.img, system: snapObj.system };
      await updateWeaponFields({
        shotsLeft: shotsLeftAfter,
        loadedAmmoId: ammoItem.id,
        loadedAmmo: loadedSnap
      });

      ui.notifications.info(localize("Reloaded"));
      await gmReloadAudit(shotsLeftAfter);
      applyLocalState(shotsLeftAfter);

      const _wsys = weapon._getWeaponSystem?.() ?? weapon.system;
      if (_wsys) {
        _wsys.loadedAmmoId = ammoItem.id;
        _wsys.loadedAmmo = loadedSnap;
      }
    });

    // ── UNLOAD ──────────────────────────────────────────────────────────────
    root.querySelector(".unload")?.addEventListener("click", async (ev) => {
      ev.preventDefault();

      const weapon = this._weapon;
      if (!weapon) return;

      const sys = weapon._getWeaponSystem?.() ?? weapon.system ?? {};
      const currentLeft = Number(sys.shotsLeft ?? 0);

      if (currentLeft <= 0) {
        ui.notifications.info(localize("MagazineAlreadyEmpty"));
        return;
      }

      const weaponFieldPrefix = (weapon.type === "cyberware") ? "system.CyberWorkType.Weapon." : "system.";
      const actor = weapon.actor;
      const loadedId = String(sys.loadedAmmoId ?? "");
      const loadedSnap = sys.loadedAmmo;

      let returnedTo = null;
      if (actor && loadedId) {
        const src = actor.items.get(loadedId);
        if (src && src.type === "ammo") {
          const q = Number(src.system?.quantity ?? 0);
          await src.update({ "system.quantity": q + currentLeft }, { render: false });
          returnedTo = src;
        }
      }

      if (!returnedTo && actor && loadedSnap && typeof loadedSnap === "object" && loadedSnap.system && Object.keys(loadedSnap).length) {
        const created = await actor.createEmbeddedDocuments("Item", [{
          name: loadedSnap.name || localize("UnloadedRounds"),
          type: "ammo",
          img: loadedSnap.img,
          system: { ...loadedSnap.system, quantity: currentLeft }
        }]);
        returnedTo = created?.[0] ?? null;
      }

      await weapon.update({
        [`${weaponFieldPrefix}shotsLeft`]: 0,
        [`${weaponFieldPrefix}loadedAmmoId`]: "",
        [`${weaponFieldPrefix}loadedAmmo`]: {}
      }, { render: false });

      const _wsys = weapon._getWeaponSystem?.() ?? weapon.system;
      if (_wsys) {
        _wsys.shotsLeft = 0;
        _wsys.loadedAmmoId = "";
        _wsys.loadedAmmo = {};
      }
      root.querySelectorAll("input.number[readonly]").forEach(el => { el.value = "0"; });

      if (returnedTo) {
        ui.notifications.info(localizeParam("UnloadedToItem", { count: currentLeft, item: returnedTo.name }));
      } else {
        ui.notifications.info(localizeParam("UnloadedNoSource", { count: currentLeft }));
      }
    });

    // ── Advantage / Disadvantage mutual exclusion ────────────────────────
    const advEl = root.querySelector("input.adv-dis.adv");
    const disEl = root.querySelector("input.adv-dis.dis");
    advEl?.addEventListener("change", ev => {
      if (ev.currentTarget.checked && disEl) disEl.checked = false;
    });
    disEl?.addEventListener("change", ev => {
      if (ev.currentTarget.checked && advEl) advEl.checked = false;
    });

    // ── Suppressive / Autofire field visibility ──────────────────────────
    const fireModeEl = root.querySelector(
      'select[name="fields.fireMode"], select[name="fireMode"], .field[data-path="fireMode"] select'
    );

    // Collect the parent row elements for suppression-only fields.
    const supSelectors = [
      '.field[data-path="zoneWidth"]',
      '.field[data-path="roundsFired"]',
      '.field[data-path="targetsCount"]',
      'input[name="fields.zoneWidth"], input[name="zoneWidth"]',
      'input[name="fields.roundsFired"], input[name="roundsFired"]',
      'input[name="fields.targetsCount"], input[name="targetsCount"]',
    ];
    const supRows = _collectParentRows(root, supSelectors);

    const autoSelectors = [
      '.field[data-path="autoRounds"]',
      'input[name="fields.autoRounds"], input[name="autoRounds"]',
    ];
    const autoRows = _collectParentRows(root, autoSelectors);

    const updateVisibility = () => {
      const mode = fireModeEl?.value ?? "";
      _setVisible(supRows,  mode === fireModes.suppressive);
      _setVisible(autoRows, mode === fireModes.fullAuto);
    };

    updateVisibility();
    fireModeEl?.addEventListener("change", updateVisibility);
  }

  /** Form handler — called when the submit button is clicked. */
  static async _formHandler(event, form, formData) {
    // formData.object holds the flat key→value map equivalent to the old FormApplication formData.
    this.object = formData.object;
    const fired = await this._onConfirm(this.object);
    if (fired !== false) this.close();
  }
}

// ── Private helpers ─────────────────────────────────────────────────────────

/**
 * Given a root element and an array of CSS selector strings, find all matching
 * elements then walk up to their nearest `.field` or `.form-group` parent,
 * deduplicated. Returns a plain Array of HTMLElement.
 */
function _collectParentRows(root, selectors) {
  const seen = new Set();
  const rows = [];
  for (const sel of selectors) {
    let els;
    try { els = root.querySelectorAll(sel); } catch { continue; }
    els.forEach(el => {
      const row = el.closest(".field, .form-group") ?? el;
      if (!seen.has(row)) { seen.add(row); rows.push(row); }
    });
  }
  return rows;
}

/** Show or hide an array of elements by toggling the .cp-hidden CSS class. */
function _setVisible(els, visible) {
  for (const el of els) {
    el.classList.toggle("cp-hidden", !visible);
  }
}
