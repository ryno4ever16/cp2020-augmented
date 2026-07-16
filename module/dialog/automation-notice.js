const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * "Setup & What's New" notice — shown once per load to the GM until they tick "Don't show again".
 *
 * Rewritten from an inline-HTML DialogV2 (hand-built markup + inline styles + hardcoded English) to a
 * proper ApplicationV2: markup lives in templates/dialog/automation-notice.hbs, every string lives in
 * lang/*.json (so it's translatable), and styling lives in css/cyberpunk2020.css (.cp-automation-notice).
 * See [[feedback-no-hardcoded-html-css-in-js]].
 *
 * PAGES is a data structure of i18n KEY references (not text) — the structure/grouping is config; the
 * words are in the lang files. The page-flip nav uses V2 actions (data-action), not hand-wired clicks.
 */
const PAGES = [
  {
    intro: "CYBERPUNK.AutoNotice.Intro",
    boxes: [
      {
        headingKey: "CYBERPUNK.AutoNotice.OptInHeading",
        rows: [
          ["CYBERPUNK.AutoNotice.AblationName",    "CYBERPUNK.AutoNotice.AblationDesc"],
          ["CYBERPUNK.AutoNotice.LimbName",        "CYBERPUNK.AutoNotice.LimbDesc"],
          ["CYBERPUNK.AutoNotice.DeathSaveName",   "CYBERPUNK.AutoNotice.DeathSaveDesc"],
          ["CYBERPUNK.AutoNotice.StunName",        "CYBERPUNK.AutoNotice.StunDesc"],
          ["CYBERPUNK.AutoNotice.MultiActionName", "CYBERPUNK.AutoNotice.MultiActionDesc"],
          ["CYBERPUNK.AutoNotice.LayerEvName",     "CYBERPUNK.AutoNotice.LayerEvDesc"],
        ],
      },
      {
        headingKey: "CYBERPUNK.AutoNotice.CoreRuleHeading",
        variant: "corerule",
        rows: [
          ["CYBERPUNK.AutoNotice.HeadDoublingName", "CYBERPUNK.AutoNotice.HeadDoublingDesc"],
        ],
      },
    ],
  },
  {
    boxes: [
      {
        headingKey: "CYBERPUNK.AutoNotice.CombatHeading",
        bullets: Array.from({ length: 12 }, (_, i) => `CYBERPUNK.AutoNotice.CombatItem${i + 1}`),
      },
      {
        headingKey: "CYBERPUNK.AutoNotice.BeyondHeading",
        variant: "gold",
        bullets: Array.from({ length: 7 }, (_, i) => `CYBERPUNK.AutoNotice.BeyondItem${i + 1}`),
      },
    ],
  },
  {
    intro: "CYBERPUNK.AutoNotice.NewIn110Intro",
    boxes: [
      {
        headingKey: "CYBERPUNK.AutoNotice.NewSystemsHeading",
        bullets: Array.from({ length: 10 }, (_, i) => `CYBERPUNK.AutoNotice.NewSystemsItem${i + 1}`),
      },
      {
        headingKey: "CYBERPUNK.AutoNotice.NewContentHeading",
        variant: "gold",
        bullets: Array.from({ length: 3 }, (_, i) => `CYBERPUNK.AutoNotice.NewContentItem${i + 1}`),
      },
    ],
  },
];

export class AutomationNotice extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "cp-automation-notice",
    classes: ["cyberpunk", "cp-automation-notice-app"],
    window: { title: "CYBERPUNK.AutoNotice.Title" },
    position: { width: 560, height: "auto" },
    actions: {
      noticePrev: AutomationNotice._onPrev,
      noticeNext: AutomationNotice._onNext,
      noticeSettings: AutomationNotice._onOpenSettings,
    },
  };

  static PARTS = {
    main: { template: "modules/cp2020-augmented/templates/dialog/automation-notice.hbs" },
  };

  constructor(options = {}) {
    super(options);
    this._page = 0;
  }

  async _prepareContext(_options) {
    const L = (k) => game.i18n.localize(k);
    const def = PAGES[this._page];
    const page = {
      intro: def.intro ? L(def.intro) : null,
      boxes: def.boxes.map((b) => ({
        heading: L(b.headingKey),
        variant: b.variant ?? "",
        rows: b.rows ? b.rows.map(([n, d]) => ({ name: L(n), desc: L(d) })) : null,
        bullets: b.bullets ? b.bullets.map(L) : null,
      })),
    };
    return {
      page,
      pageNum: this._page + 1,
      pageCount: PAGES.length,
      canBack: this._page > 0,
      isLast: this._page === PAGES.length - 1,
      hideChecked: !!this._noticeHide(),
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    // "Don't show again" is a checkbox → dynamic state, wired here (not markup). Persists to the setting.
    // Ticking it also stamps the current module version, so the notice re-surfaces only when the
    // module updates (the version-aware gate in _hookAutomationMigrationNotice).
    const cb = this.element?.querySelector?.(".cp-notice-hide");
    cb?.addEventListener("change", () => {
      try {
        game.settings.set("cp2020-augmented", "automationNoticeHide", cb.checked);
        if (cb.checked) {
          const v = game.modules.get("cp2020-augmented")?.version ?? "";
          game.settings.set("cp2020-augmented", "automationNoticeVersion", v);
        }
      } catch { /* setting not ready */ }
    });
  }

  _noticeHide() {
    try { return game.settings.get("cp2020-augmented", "automationNoticeHide"); } catch { return false; }
  }

  static _onPrev() {
    if (this._page > 0) { this._page -= 1; this.render(); }
  }

  static _onNext() {
    if (this._page < PAGES.length - 1) { this._page += 1; this.render(); }
    else this.close();
  }

  static _onOpenSettings() {
    try {
      if (typeof SettingsConfig !== "undefined") new SettingsConfig().render(true);
      else game.settings.sheet?.render(true);
    } catch {
      ui.notifications.info(game.i18n.localize("CYBERPUNK.AutoNotice.SettingsHint"));
    }
  }
}
