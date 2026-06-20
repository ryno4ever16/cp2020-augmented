import { openIpTracker } from "../ip/tracker.js";
import { clearQueue } from "../ip/ip.js";
import { localize } from "../utils.js";

const SCOPE = "cp2020-augmented";

/**
 * RAW-IP neglect nudge — one GM-only dialog when the un-awarded skill-roll queue crosses the threshold.
 * The three off-ramps live right in the prompt, so an accidental RAW activation self-corrects in one
 * click: Open the tracker / Clear the backlog / Turn RAW tracking off. A "don't ask again" checkbox
 * mutes it. Markup lives in templates/dialog/ip-neglect.hbs; this module is loaded LAZILY from ip.js
 * (dynamic import) to avoid an ip.js ↔ tracker.js static import cycle.
 */
export async function showIpNeglectNudge(pendingCount) {
  const render = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  const content = await render("modules/cp2020-augmented/templates/dialog/ip-neglect.hbs", { count: pendingCount });

  const applyMute = async (dialog) => {
    const muted = !!dialog?.element?.querySelector?.(".cp-ip-neglect-mute")?.checked;
    if (muted) { try { await game.settings.set(SCOPE, "ipNeglectMuted", true); } catch (e) { /* ignore */ } }
  };

  await foundry.applications.api.DialogV2.wait({
    window: { title: localize("IpNeglectTitle"), icon: "fa-solid fa-graduation-cap" },
    content,
    rejectClose: false,
    buttons: [
      { action: "open", default: true, icon: "fa-solid fa-graduation-cap", label: localize("IpNeglectOpen"),
        callback: async (ev, btn, dialog) => { await applyMute(dialog); openIpTracker(); } },
      { action: "clear", icon: "fa-solid fa-trash", label: localize("IpNeglectClear"),
        callback: async (ev, btn, dialog) => { await applyMute(dialog); await clearQueue(); } },
      { action: "off", icon: "fa-solid fa-power-off", label: localize("IpNeglectTurnOff"),
        callback: async (ev, btn, dialog) => { await applyMute(dialog); try { await game.settings.set(SCOPE, "ipRawTracking", false); } catch (e) { /* ignore */ } } },
    ],
  });
}
