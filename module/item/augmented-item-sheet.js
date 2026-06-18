const { HandlebarsApplicationMixin } = foundry.applications.api;

// Module flag / settings scope (per-file convention used across the module).
const SCOPE = "cp2020-augmented";

/**
 * Item sheet for the Augmented Edition vehicle/ACPA sub-type items
 * (`cp2020-augmented.vehicleWeapon`, `cp2020-augmented.acpaSystem`).
 *
 * The base system's CyberpunkItemSheet keys its part templates off the bare item type, so it
 * can't render a module-namespaced sub-type. This focused ItemSheetV2 renders the vendored
 * `item/parts/<type>/{summary,settings}.hbs` partials via a single wrapper part (the proven
 * vehicle-sheet-wrapper pattern: one root element, conditional partial include — no runtime
 * PARTS mutation). Settings fields auto-submit (`name="system.*"`); the only bespoke
 * interactivity is the vehicleWeapon shell-variant editor.
 *
 * @extends {foundry.applications.sheets.ItemSheetV2}
 */
export class CyberpunkAugmentedItemSheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2) {

  static DEFAULT_OPTIONS = {
    classes: ["cyberpunk", "sheet", "item", "cp2020ae-item"],
    position: { width: 520, height: 480 },
    window: { resizable: true },
    tag: "form",
    form: { submitOnChange: true, closeOnSubmit: false },
  };

  // Single wrapper part: <form> comes from tag:"form"; the wrapper's <div> is the part's single root.
  static PARTS = {
    main: { template: "modules/cp2020-augmented/templates/item/augmented-item-sheet.hbs", scrollable: [""] },
  };

  /** @override */
  async _prepareContext(options) {
    const item = this.item;
    return {
      item,
      document: this.document,
      system: item.system,
      editable: this.isEditable,
      owner: item.isOwner,
      // Bare sub-type name (drop the module prefix) → selects which item/parts/<type>/ partials render.
      partType: String(item.type).replace(`${SCOPE}.`, ""),
    };
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender?.(context, options);
    const root = this.element;
    if (!root || !this.isEditable) return;

    // Allow a comma decimal separator in numeric inputs (convert to dot before the form reads it).
    for (const el of root.querySelectorAll('input[type="number"]')) {
      el.addEventListener("change", () => {
        if (typeof el.value === "string" && el.value.includes(",")) el.value = el.value.replace(",", ".");
      });
    }

    if (this.item.type === `${SCOPE}.vehicleWeapon`) this._bindShellVariants(root);
  }

  /**
   * Shell/warhead variants are an array on system.shellVariants edited in place (the inputs carry
   * data-field, not name=, so they're outside the auto-submit form). Read → mutate → write back.
   */
  _bindShellVariants(root) {
    const svArray = () => Array.isArray(this.item.system?.shellVariants)
      ? foundry.utils.duplicate(this.item.system.shellVariants) : [];

    root.querySelector(".cp-sv-add")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const arr = svArray();
      arr.push({ name: "New Shell", pen: Number(this.item.system?.penetration) || 0, burst: Number(this.item.system?.burst) || 0, warhead: "", ap: false });
      await this.item.update({ "system.shellVariants": arr });
    });

    for (const btn of root.querySelectorAll(".cp-sv-remove")) {
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const idx = Number(ev.currentTarget.dataset.index);
        const arr = svArray();
        if (Number.isFinite(idx) && idx >= 0 && idx < arr.length) {
          arr.splice(idx, 1);
          await this.item.update({ "system.shellVariants": arr });
        }
      });
    }

    for (const el of root.querySelectorAll(".cp-sv")) {
      el.addEventListener("change", async (ev) => {
        const idx = Number(ev.currentTarget.closest(".cp-shellvar")?.dataset?.index);
        const field = ev.currentTarget.dataset.field;
        const arr = svArray();
        if (!Number.isFinite(idx) || !field || idx < 0 || idx >= arr.length) return;
        const t = ev.currentTarget;
        arr[idx][field] = t.type === "checkbox" ? !!t.checked
          : (t.type === "number" ? (Number(String(t.value).replace(",", ".")) || 0) : t.value);
        await this.item.update({ "system.shellVariants": arr }, { render: false });
      });
    }
  }
}
