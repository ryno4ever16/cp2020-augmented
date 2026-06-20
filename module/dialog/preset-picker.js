import { PRESETS, applyPreset, undoPreset, presetChanges, currentSettings } from "../presets.js";
import { localize } from "../utils.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Settings-preset picker — a single GM-only window (opened from the System Settings menu, see the
 * registerMenu in cp2020-augmented.js) that applies one of the 4 playstyle tiers in one click.
 *
 * Apply-safety: clicking a tier opens a confirm dialog that NAMES the notable active features it
 * switches on (especially the silent RAW-IP accumulator); after applying, the picker shows a one-step
 * Undo (the snapshot taken in applyPreset). The undo state lives at MODULE scope (below), so it PERSISTS
 * across closing and reopening the window — it clears only when used or when Foundry is reloaded/restarted.
 * Markup lives in templates/dialog/preset-picker.hbs + preset-confirm.hbs; all strings are
 * CYBERPUNK.Preset* i18n keys; structure mirrors automation-notice.js.
 */

// The most recent apply, for one-step undo: { presetId, snapshot, labelKey }. Module-scoped so the undo
// survives the window being closed and reopened; resets on a page reload (a Foundry restart).
let lastApplied = null;

export class PresetPicker extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "cp-preset-picker",
    classes: ["cyberpunk", "cp-preset-picker-app"],
    window: { title: "CYBERPUNK.PresetPickerTitle", icon: "fa-solid fa-sliders" },
    position: { width: 600, height: "auto" },
    actions: {
      presetApply: PresetPicker._onApply,
      presetUndo: PresetPicker._onUndo,
    },
  };

  static PARTS = {
    main: { template: "modules/cp2020-augmented/templates/dialog/preset-picker.hbs" },
  };

  async _prepareContext(_options) {
    const tiers = PRESETS.map((p) => ({
      id: p.id,
      label: localize(p.labelKey),
      desc: localize(p.descKey),
    }));
    return {
      tiers,
      lastAppliedLabel: lastApplied ? localize(lastApplied.labelKey) : null,
    };
  }

  static async _onApply(event, target) {
    const id = target?.dataset?.preset;
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;

    const { changed, featuresOn } = presetChanges(id, currentSettings());
    if (!changed.length) {
      ui.notifications?.info?.(localize("PresetAlreadyActive", { tier: localize(preset.labelKey) }));
      return;
    }

    const render = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
    const content = await render("modules/cp2020-augmented/templates/dialog/preset-confirm.hbs", {
      tier: localize(preset.labelKey),
      desc: localize(preset.descKey),
      count: changed.length,
      features: featuresOn.map((f) => localize(f.nameKey)),
      hasFeatures: featuresOn.length > 0,
    });

    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: localize("PresetConfirmTitle") },
      content,
      rejectClose: false,
    });
    if (!ok) return;

    const result = await applyPreset(id);
    lastApplied = result ? { ...result, labelKey: preset.labelKey } : null;
    ui.notifications?.info?.(localize("PresetApplied", { tier: localize(preset.labelKey) }));
    this.render();
  }

  static async _onUndo() {
    if (!lastApplied) return;
    const label = localize(lastApplied.labelKey);
    await undoPreset(lastApplied.snapshot);
    lastApplied = null;
    ui.notifications?.info?.(localize("PresetUndone", { tier: label }));
    this.render();
  }
}
