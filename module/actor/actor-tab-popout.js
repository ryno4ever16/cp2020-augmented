import { CyberpunkActorSheet } from "./actor-sheet.js";
import { shimmerWindow } from "../shimmer.js";

/**
 * Tear-off tab windows for the character/NPC sheet.
 *
 * Each instance is the SAME actor sheet, but its template renders a single tab's body in its own
 * window — so a player can pop the Combat tab to one place and the Cyberware tab to another. Because
 * this subclasses {@link CyberpunkActorSheet}, it inherits getData(), activateListeners(), _onDrop()
 * and every roll/edit handler unchanged: the popped-out tab is fully interactive and persists edits.
 * It also registers in `actor.apps`, so it live-updates whenever the actor changes.
 *
 * PopOut! friendly: the tab's listeners are bound directly to its own DOM (not global delegation), so
 * they travel with the nodes when PopOut! moves the window to a second monitor.
 */

// tab key -> { label (CYBERPUNK.<label>), width, height } for the popped-out window.
const TAB_META = {
  skills:   { label: "TabSkills",  width: 560, height: 620 },
  combat:   { label: "TabCombat",  width: 600, height: 660 },
  gear:     { label: "TabGear",    width: 560, height: 620 },
  services: { label: "ServicesTab", width: 540, height: 560 },
  cyber:    { label: "TabCyber",   width: 600, height: 660 },
  life:     { label: "Life",       width: 560, height: 560 },
  netrun:   { label: "NetRun",     width: 560, height: 620 },
};

export const POPOUT_TABS = Object.keys(TAB_META);

export class CyberpunkActorTabSheet extends CyberpunkActorSheet {
  static DEFAULT_OPTIONS = {
    classes: ["cp-tab-popout"],          // merged with the parent's cyberpunk/sheet/actor classes (V2)
    position: { width: 580, height: 620 },
  };

  /** Override the parent's PART so this window renders a single tab body (its own template). */
  static PARTS = {
    main: { template: "modules/cp2020-augmented/templates/actor/actor-tab-popout.hbs", scrollable: [""] },
  };

  /** Which tab this window shows (passed through render options). */
  get tabKey() {
    return this.options.tabKey ?? "combat";
  }

  /** A distinct DOM id per (actor, tab) so several tab windows of one actor can coexist.
   *  NOTE: ApplicationV2 derives the real element id + the foundry.applications.instances key from
   *  `options.id` (the "{id}" template → document-derived), NOT from this getter. So this override
   *  alone is IGNORED by V2 — `static open()` MUST pass the same string as `options.id` (it does),
   *  or every tab popout of one actor collides on `CyberpunkActorTabSheet-Actor-<id>` and the 2nd
   *  render clobbers the 1st. This getter is kept only to mirror that id for any `this.id` reader. */
  get id() {
    return `cp-tab-${this.actor.id}-${this.tabKey}`;
  }

  /** @override */
  get title() {
    const meta = TAB_META[this.tabKey];
    const name = meta ? game.i18n.localize(`CYBERPUNK.${meta.label}`) : this.tabKey;
    return `${this.actor.name} — ${name}`;
  }

  /** @override */
  async _prepareContext(options) {
    const data = await super._prepareContext(options);
    data.tabKey = this.tabKey;
    data.isTabPopout = true;
    return data;
  }

  /** Re-grey the parent character sheet's nav whenever this tab window appears or closes, so a
   *  popped-out tab shows as detached on the main sheet. `exclude` names a window the refresh must
   *  treat as GONE: at close() time this window's registry entry / rendered flag can settle a tick
   *  AFTER close() resolves, so the one-shot refresh would still count it as open and the parent
   *  nav would stay marked forever (caught by the tear-out keeper's recovery leg). */
  _syncParentNav(exclude = null) {
    Object.values(this.actor?.apps ?? {})
      .find((a) => a.constructor?.name === "CyberpunkActorSheet" && a.rendered)
      ?._refreshDetachedTabs?.(exclude);
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this._syncParentNav();
  }

  /** @override */
  async close(options) {
    // Mark BEFORE awaiting super.close: a parent sheet that re-renders during the close window reads the
    // rendered-popout set, and this window's registry entry / rendered flag can still look open for a
    // tick after close() resolves — the flag drops it so the nav mark can't get re-stuck (finding 7).
    this._cpClosing = true;
    const r = await super.close(options);
    this._syncParentNav(this);   // the closing window no longer counts as open, whatever its state
    return r;
  }

  /**
   * Open (or focus) the given tab as its own window for this actor. Singleton per (actor, tab):
   * re-triggering brings the existing window forward instead of spawning a duplicate. An optional
   * {left, top} positions the window (used by the drag-to-place tear-off gesture).
   */
  static open(actor, tabKey, { left = null, top = null } = {}) {
    if (!actor || !TAB_META[tabKey]) return null;
    const existing = Object.values(actor.apps ?? {})
      .find(a => a instanceof CyberpunkActorTabSheet && a.tabKey === tabKey);
    if (existing) {
      // Already open → just resurface it (NO re-render: a full render flashes the layout and would
      // wipe the shimmer overlay we're about to add).
      if (left != null && top != null) existing.setPosition({ left, top });
      (existing.bringToFront ?? existing.bringToTop)?.call(existing);
      shimmerWindow(existing); // draw the eye to it
      return existing;
    }
    const meta = TAB_META[tabKey];
    const position = { width: meta.width, height: meta.height };
    if (left != null) position.left = left;
    if (top != null) position.top = top;
    // V2: ActorSheetV2 takes an options object with the document; `tabKey` is a custom option read
    // by get tabKey(). Pass an explicit per-(actor,tab) `id` — V2 keys the real element + the
    // instances registry off options.id, so without this every tab popout of one actor shares the
    // document-derived id and the 2nd render clobbers the 1st (the tear-out "only one tab" bug).
    return new CyberpunkActorTabSheet({ document: actor, tabKey, id: `cp-tab-${actor.id}-${tabKey}`, position }).render({ force: true });
  }
}
