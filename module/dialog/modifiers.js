import { deepSet, localize, localizeParam } from "../utils.js"
import { fireModes, caliberMatches, normalizeCaliber, isEnergyAttackType } from "../lookups.js"
import { createCyberpunkChatMessage, getGMUserIds } from "../compat.js";
import { ammoTrackingOn, setAmmoTracking } from "../mech/free-fire.js";

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
      dualWieldGearPaths = [],   // Q9: gearMod_<id> rows shown only while Dual Wield is checked
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
    this._dualWieldGearPaths = Array.isArray(dualWieldGearPaths) ? dualWieldGearPaths : [];

    // Per-instance data is held on the private fields above. ApplicationV2 FREEZES `this.options`,
    // so writing this._weapon etc. throws "object is not extensible"; internal code reads
    // the private fields instead.
  }

  static DEFAULT_OPTIONS = {
    // No fixed `id`: a fixed id makes ApplicationV2 treat the dialog as a SINGLETON, so opening the Fire
    // dialog for a second weapon while the first is still open replaces the first's window in place and
    // orphans its onConfirm callback. Omitting id lets V2 assign a unique id per instance (styling is via
    // the `cyberpunk2020` class + the template's `.weapon-modifiers` class, not the id).
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
      // Read via the single source in mech/free-fire.js (module flag scope) so the native row and the
      // keep-topped engine agree. Resolve the actor pre-submit off the private weapon field.
      ammoTracking: ammoTrackingOn(this._weapon?.actor ?? this.options?.weapon?.actor),
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

    /**
     * The two round-count fields are bounded by the magazine, so anything that CHANGES the magazine
     * while the window is open has to move their ceiling with it. Mirrors the base dialog's own
     * applyLocalState (module/dialog/modifiers.js): rewrite `data-max`, seat the value at the new
     * maximum, and clear any standing complaint about the old one.
     *
     * ⚠ THIS IS THE ROAD BACK INTO A DEFECT THAT WAS ALREADY CLOSED ONCE. The bounds are read from
     * `data-max` by the validators below, and they are computed when the row is BUILT — before the
     * reload. Leave them alone and a reload leaves the ceiling stale LOW (the field refuses a burst the
     * gun can now fire) while an unload leaves it stale HIGH (the field accepts a burst out of an empty
     * gun, and the fire path silently cuts it — the exact silent-clamp the autofire unit closed).
     * Both directions are covered because both gestures live in this window.
     */
    const refreshRoundBounds = (shotsLeftAfter) => {
      const sysAfter = this._weapon?._getWeaponSystem?.() ?? this._weapon?.system ?? {};
      const rof = Math.max(0, Math.floor(Number(sysAfter?.rof) || 0));
      const maxRounds = Math.min(rof, Math.max(0, Math.floor(Number(shotsLeftAfter) || 0)));
      for (const name of ["fullAutoRoundsFired", "roundsFired"]) {
        const input = root.querySelector(`input[name="${name}"], input[name="fields.${name}"]`);
        if (!input) continue;
        input.dataset.max = String(maxRounds);
        input.value = String(maxRounds);
        input.setCustomValidity("");
      }
    };

    // ── AMMO TRACKING / FREE FIRE ───────────────────────────────────────────
    // Per-actor toggle, relocated here from the combat-tab Weapons header. Unchecked = Free Fire
    // (the weapon ignores ammo). Reads/writes the module-scope flag via the single source in
    // mech/free-fire.js, so this native row and the injected V1 row and the keep-topped engine all
    // agree. Turning it OFF also tops every magazine (setAmmoTracking). The label flips to match.
    root.querySelector(".cp-ammo-tracking")?.addEventListener("change", async (ev) => {
      const on = !!ev.target.checked;
      const label = root.querySelector(".cp-ammo-tracking-label");
      if (label) label.textContent = localize(on ? "AmmoTracking" : "FreeFire");
      try {
        await setAmmoTracking(this._weapon?.actor ?? this.options?.weapon?.actor, on);
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
        refreshRoundBounds(shotsLeftAfter);
      };

      const ammoTracking = ammoTrackingOn(weapon.actor);
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
      // Emptying the magazine drops the ceiling to nothing — see the note on refreshRoundBounds for why
      // an unload is the more dangerous of the two directions.
      refreshRoundBounds(0);

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

    // Collect the parent row elements for suppression-only fields. (zoneWidth seeds the canvas placement
    // preview's opening width; the shooter can re-size it on the map.)
    const supSelectors = [
      '.field[data-path="zoneWidth"]',
      '.field[data-path="roundsFired"]',
      '.field[data-path="targetsCount"]',
      'input[name="fields.zoneWidth"], input[name="zoneWidth"]',
      'input[name="fields.roundsFired"], input[name="roundsFired"]',
      'input[name="fields.targetsCount"], input[name="targetsCount"]',
    ];
    const supRows = _collectParentRows(root, supSelectors);

    // The autofire round count is the BASE system's `fullAutoRoundsFired` field — see the row in
    // lookups.js for why the name is load-bearing.
    const autoSelectors = [
      '.field[data-path="fullAutoRoundsFired"]',
      'input[name="fields.fullAutoRoundsFired"], input[name="fullAutoRoundsFired"]',
    ];
    const autoRows = _collectParentRows(root, autoSelectors);

    // ── Dual-wield-only gear rows (Q9, Ambidexterity): show only while Dual Wield is checked ──
    const dualWieldEl = root.querySelector(
      'input[name="fields.dualWield"], input[name="dualWield"], .field[data-path="dualWield"] input[type="checkbox"]'
    );
    const dualWieldRows = _collectParentRows(root,
      (this._dualWieldGearPaths ?? []).flatMap(p => [`input[name="fields.${p}"]`, `input[name="${p}"]`]));

    // ── Autofire round count: the base system's own bounds check, ported ──
    // The shared number field renders its bounds as `data-min`/`data-max` rather than as native
    // `min`/`max` attributes, so a browser enforces nothing by itself and the check has to be asked
    // for. The base dialog asks for it (`validateFullAutoRoundsInput`); ours replaces that dialog, so
    // without this the field would accept any number and lean entirely on the fire path's clamp —
    // which works, but silently, and a shooter who typed 99 would never learn their burst was cut.
    // Same message key as the base, so the two dialogs say the same thing in every language.
    // ⚠ Only while FULL AUTO is selected: the row is hidden in every other mode and a hidden field
    // that reports invalid blocks the whole form.
    const numberInput = (name) => root.querySelector(`input[name="${name}"], input[name="fields.${name}"]`);
    const autoRoundsEl = numberInput("fullAutoRoundsFired");

    /** Complain on one field. With `report`, put the caret on it and raise the browser's own bubble —
     *  which is what turns a silently blocked submit into a shooter being told what is wrong. */
    const showFieldValidation = (input, message, { report = false } = {}) => {
      if (!input) return false;
      input.setCustomValidity(message);
      if (report) { input.focus(); input.reportValidity(); }
      return false;
    };

    const clearFieldValidation = (...inputs) => {
      for (const input of inputs) if (input) input.setCustomValidity("");
    };

    // The three shapes the base system checks with, kept as three named helpers for the same reason it
    // does: each row says which shape it wants, and the message key travels with the shape.
    const validateIntegerRangeInput = (input, { min = 1, max = 1, messageKey = "IntegerRangeInvalid", report = false } = {}) => {
      if (!input) return true;
      input.setCustomValidity("");
      const raw = String(input.value ?? "").trim();
      const value = Number(raw);
      const invalid = raw === "" || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max;
      if (!invalid) return true;
      return showFieldValidation(input, localizeParam(messageKey, { min, max }), { report });
    };

    const validateNumberMinInput = (input, { min = 1, messageKey = "NumberMinInvalid", report = false } = {}) => {
      if (!input) return true;
      input.setCustomValidity("");
      const raw = String(input.value ?? "").trim();
      const value = Number(raw);
      const invalid = raw === "" || !Number.isFinite(value) || value < min;
      if (!invalid) return true;
      return showFieldValidation(input, localizeParam(messageKey, { min }), { report });
    };

    const validateIntegerMinInput = (input, { min = 1, messageKey = "IntegerMinInvalid", report = false } = {}) => {
      if (!input) return true;
      input.setCustomValidity("");
      const raw = String(input.value ?? "").trim();
      const value = Number(raw);
      const invalid = raw === "" || !Number.isFinite(value) || !Number.isInteger(value) || value < min;
      if (!invalid) return true;
      return showFieldValidation(input, localizeParam(messageKey, { min }), { report });
    };

    const validateAutoRounds = ({ report = false } = {}) => {
      if (!autoRoundsEl) return true;
      autoRoundsEl.setCustomValidity("");
      if ((fireModeEl?.value ?? "") !== fireModes.fullAuto) return true;
      const min = Math.max(1, Math.floor(Number(autoRoundsEl.dataset.min) || 1));
      const max = Math.max(0, Math.floor(Number(autoRoundsEl.dataset.max) || 0));
      // No rounds available at all: the weapon roll's own NoAmmo guard is the right place to say so.
      if (max <= 0) return true;
      return validateIntegerRangeInput(autoRoundsEl, { min, max, messageKey: "FullAutoRoundsInvalid", report });
    };

    // ── SUPPRESSIVE DECLARATION — the base system's own two-gate check, ported ────────────────
    // A suppressive burst is DECLARED, not merely rolled: the shooter says how many rounds go down a
    // corridor how many metres wide, at how many people, and the base derives its evasion DC from those
    // numbers (ceil(rounds ÷ width), floor 2 m). Every one of them is silently rewritten downstream if
    // it arrives wrong — the rounds get clamped into the magazine, the width gets floored, the count
    // gets treated as one — so a bad declaration does not misfire, it LIES: the card and the zone quote
    // numbers the shooter never asked for. The base dialog refuses instead, and now so does this one.
    const validateSuppressiveInputs = ({ report = false } = {}) => {
      const roundsInput = numberInput("roundsFired");
      const zoneWidthInput = numberInput("zoneWidth");
      const targetsInput = numberInput("targetsCount");

      clearFieldValidation(roundsInput, zoneWidthInput, targetsInput);
      if ((fireModeEl?.value ?? "") !== fireModes.suppressive) return true;

      const maxRounds = Math.max(0, Math.floor(Number(roundsInput?.dataset?.max) || 0));
      // No rounds available at all: the weapon roll's own NoAmmo guard is the right place to say so.
      if (maxRounds > 0) {
        if (!validateIntegerRangeInput(roundsInput, { min: 1, max: maxRounds, messageKey: "IntegerRangeInvalid", report })) return false;
      }

      const zoneMin = Math.max(1, Math.floor(Number(zoneWidthInput?.dataset?.min) || 2));
      if (!validateNumberMinInput(zoneWidthInput, { min: zoneMin, messageKey: "NumberMinInvalid", report })) return false;

      if (!validateIntegerMinInput(targetsInput, { min: 1, messageKey: "IntegerMinInvalid", report })) return false;

      return true;
    };

    const updateVisibility = () => {
      const mode = fireModeEl?.value ?? "";
      _setVisible(supRows,  mode === fireModes.suppressive);
      _setVisible(autoRows, mode === fireModes.fullAuto);
      _setVisible(dualWieldRows, !!dualWieldEl?.checked);
      // ⚠ A HIDDEN FIELD THAT REPORTS INVALID BLOCKS THE WHOLE FORM, and the browser cannot focus it to
      // say why — so every row's complaint is cleared the moment its mode is deselected. Both validators
      // are no-ops outside their own mode for the same reason.
      validateAutoRounds();
      validateSuppressiveInputs();
    };

    // The submit gate reaches these from the static form handler. Both are re-run there with `report` on,
    // so the refusal names the field instead of just not happening.
    this._cpValidateOnSubmit = () => {
      const autoOk = validateAutoRounds({ report: true });
      if (!autoOk) return false;
      return validateSuppressiveInputs({ report: true });
    };

    updateVisibility();
    fireModeEl?.addEventListener("change", updateVisibility);
    dualWieldEl?.addEventListener("change", updateVisibility);
    for (const ev of ["input", "change"]) {
      autoRoundsEl?.addEventListener(ev, () => validateAutoRounds());
      for (const name of ["roundsFired", "zoneWidth", "targetsCount"]) {
        numberInput(name)?.addEventListener(ev, () => validateSuppressiveInputs());
      }
    }
  }

  /** Form handler — called when the submit button is clicked. */
  static async _formHandler(event, form, formData) {
    // ⛔ THE SUBMIT GATE. Native constraint validation already refuses a submit while a visible field is
    // marked invalid, but it is not the whole answer: a value can be made invalid without an `input`
    // event ever firing (a magazine changed by the Reload/Unload controls beside this button), and a
    // form submitted by any road other than the button skips the browser's pass entirely. Re-running
    // both checks here is the one place every submit passes through — and running them with `report` on
    // means the shooter is TOLD, on the offending field, rather than left pressing a dead button.
    if (this._cpValidateOnSubmit && this._cpValidateOnSubmit() === false) return;
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
