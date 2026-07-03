import { getCalibers, AMMO_MODIFIERS, getCaliberBox, getAmmoBoxPrice, normalizeCaliber } from "../lookups.js";
import { localize, tryLocalize } from "../utils.js";

/**
 * Whether the current user may purchase ammunition.
 * GMs always may. Players may only when the "playersCanBuyAmmo" world setting is on; otherwise
 * they are told ammo must be bought at a shop (the GM buys on their behalf).
 * @returns {{ ok: boolean, reason: string }}
 */
export function canBuyAmmo() {
  if (game.user?.isGM) return { ok: true, reason: "" };
  let allowed = true;
  try { allowed = game.settings.get("cp2020-augmented", "playersCanBuyAmmo") !== false; } catch (e) { /* default allow */ }
  return allowed ? { ok: true, reason: "" } : { ok: false, reason: game.i18n.localize("CYBERPUNK.AmmoBuyAtShop") };
}

/** The system-data fields (un-dotted) that a given modifier seeds onto an ammo item. */
export function ammoModifierSystemFields(modifierId) {
  const mod = AMMO_MODIFIERS[modifierId] ?? AMMO_MODIFIERS.standard;
  const mech = mod.mech ?? {};
  const fx = ["CoreMods"];
  if (mech.stunSaveOnHit) fx.push("Stun");
  if (mech.dotEnabled) fx.push("DoT");
  return {
    modifier: AMMO_MODIFIERS[modifierId] ? modifierId : "standard",
    armorMultSoft: mech.armorMultSoft ?? 1,
    armorMultHard: mech.armorMultHard ?? 1,
    penDamageMult: mech.penDamageMult ?? 1,
    rawDamageMult: mech.rawDamageMult ?? 1,
    bonusDamageFormula: mech.bonusDamageFormula ?? "",
    accuracyMod: mech.accuracyMod ?? 0,
    stunSaveOnHit: mech.stunSaveOnHit ?? false,
    stunSaveMod: mech.stunSaveMod ?? 0,
    dotEnabled: mech.dotEnabled ?? false,
    dotTurns: mech.dotTurns ?? 0,
    dotDamageFormula: mech.dotDamageFormula ?? "",
    dotType: mech.dotType ?? "acid",
    spreadMode: mech.spreadMode ?? "single",
    effectTypes: (modifierId === "standard") ? ["None"] : fx
  };
}

/** Dotted-key form of {@link ammoModifierSystemFields} for document.update(). */
export function applyAmmoModifierUpdate(modifierId) {
  const out = {};
  for (const [k, v] of Object.entries(ammoModifierSystemFields(modifierId))) out[`system.${k}`] = v;
  return out;
}

/** Sorted [{id,label}] caliber + modifier option lists for the buy UI. */
function _ammoOptions() {
  const calibers = getCalibers();
  const caliberOpts = Object.entries(calibers)
    .map(([id, c]) => ({ id, label: (c && c.label) ? tryLocalize(c.label) : id }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const modifierOpts = Object.entries(AMMO_MODIFIERS).map(([id, m]) => ({ id, label: (m && m.label) ? tryLocalize(m.label) : id }));
  return { caliberOpts, modifierOpts };
}

/**
 * Open the Buy-Ammo dialog for an actor. Pick caliber + modifier + number of boxes; on confirm,
 * deducts eurobucks and creates/restocks a matching ammo Item.
 * @param {Actor} actor
 */
export async function openBuyAmmoDialog(actor) {
  if (!actor) { ui.notifications.warn(localize("AmmoBuyNoActor")); return; }

  const gate = canBuyAmmo();
  if (!gate.ok) { ui.notifications.warn(gate.reason); return; }

  const { caliberOpts, modifierOpts } = _ammoOptions();
  const render = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  const content = await render("modules/cp2020-augmented/templates/dialog/buy-ammo.hbs", { caliberOpts, modifierOpts });

  return new Promise((resolve) => {
    new foundry.applications.api.DialogV2({
      window: { title: localize("AmmoBuyTitle") },
      content,
      buttons: [
        {
          action: "buy",
          icon: '<i class="fas fa-cart-plus"></i>',
          label: localize("AmmoBuyConfirm"),
          default: true,
          callback: async (ev, btn, dlg) => { await _doPurchase(actor, dlg.element); resolve(true); },
        },
        {
          action: "cancel",
          icon: '<i class="fas fa-times"></i>',
          label: localize("Cancel"),
          callback: () => resolve(false),
        },
      ],
      rejectClose: false,
      close: () => resolve(false),
      render: (event, dialog) => {
        const root = dialog.element;
        const preview = root.querySelector(".cp-buy-ammo-preview");
        const update = () => {
          const cal = String(root.querySelector('[name="caliber"]')?.value ?? "");
          const mod = String(root.querySelector('[name="modifier"]')?.value ?? "standard");
          const boxes = Math.max(1, Math.floor(Number(root.querySelector('[name="boxes"]')?.value) || 1));
          const box = getCaliberBox(cal);
          const unit = getAmmoBoxPrice(cal, mod);
          if (preview) preview.textContent = game.i18n.format("CYBERPUNK.AmmoBuyPreview", {
            boxes, per: box.box, rounds: box.box * boxes, cost: unit * boxes
          });
        };
        root.querySelectorAll("select, input").forEach(el => el.addEventListener("change", update));
        update();
      },
    }).render({ force: true });
  });
}

async function _doPurchase(actor, html) {
  const root = html[0] ?? html;
  const caliber = String(root.querySelector('[name="caliber"]')?.value ?? "").trim();
  const modifier = String(root.querySelector('[name="modifier"]')?.value ?? "standard");
  const boxes = Math.max(1, Math.floor(Number(root.querySelector('[name="boxes"]')?.value) || 1));
  await purchaseAmmo(actor, { caliber, modifier, boxes });
}

/**
 * Buy `boxes` boxes of `caliber` + `modifier` ammunition for `actor`: charge eurobucks then create/restock
 * a matching ammo Item. Charge-first-then-stock with refund-on-failure (the proven idiom), so a failed
 * create can never leave free ammo or a double charge. Shared by the Buy-Ammo dialog AND the shop catalog
 * ammo rows ([[shopping-design]]). Re-validates the access gate + funds at execution time.
 * @param {Actor} actor
 * @param {{caliber:string, modifier?:string, boxes?:number}} opts
 * @returns {Promise<boolean>} true on success
 */
export async function purchaseAmmo(actor, { caliber, modifier = "standard", boxes = 1 } = {}) {
  if (!actor) { ui.notifications.warn(localize("AmmoBuyNoActor")); return false; }
  caliber = String(caliber ?? "").trim();
  if (!caliber) { ui.notifications.warn(localize("AmmoBuyNoCaliber")); return false; }

  // Re-validate access at execution time (settings could have changed since the UI opened).
  const gate = canBuyAmmo();
  if (!gate.ok) { ui.notifications.warn(gate.reason); return false; }

  const n = Math.max(1, Math.floor(Number(boxes) || 1));
  const box = getCaliberBox(caliber);
  const unitPrice = getAmmoBoxPrice(caliber, modifier);
  const totalCost = unitPrice * n;
  const totalRounds = (Number(box.box) || 1) * n;

  const funds = Number(actor.system?.eurobucks ?? 0);
  if (funds < totalCost) {
    ui.notifications.warn(game.i18n.format("CYBERPUNK.AmmoBuyInsufficientFunds", { cost: totalCost, funds }));
    return false;
  }

  // Stack onto an existing matching (same caliber + modifier) ammo item if present.
  const existing = (actor.itemTypes?.ammo ?? []).find(
    a => normalizeCaliber(a.system?.caliber) === normalizeCaliber(caliber)
      && (a.system?.modifier ?? "standard") === modifier
  );

  // Charge first, then stock. (update before create so a failed create doesn't leave free ammo.)
  await actor.update({ "system.eurobucks": funds - totalCost });

  try {
    if (existing) {
      await existing.update({ "system.quantity": Number(existing.system?.quantity ?? 0) + totalRounds });
    } else {
      const calLabel = (getCalibers()[caliber]?.label) ?? caliber;
      const modLabel = AMMO_MODIFIERS[modifier]?.label ?? "Standard";
      const system = foundry.utils.mergeObject(
        {
          caliber,
          ammoType: caliber,
          quantity: totalRounds,
          boxSize: Number(box.box) || 1,
          boxCost: unitPrice
        },
        ammoModifierSystemFields(modifier),
        { inplace: false }
      );
      await actor.createEmbeddedDocuments("Item", [{
        name: `${calLabel} ${modLabel}`,
        type: "ammo",
        img: "systems/cyberpunk2020/img/weapon-icon.svg",
        system
      }]);
    }
  } catch (err) {
    // Refund if stocking failed, so the player isn't charged for nothing.
    console.error("Cyberpunk2020 | Buy ammo: failed to stock, refunding.", err);
    await actor.update({ "system.eurobucks": funds });
    ui.notifications.error(localize("AmmoBuyFailed"));
    return false;
  }

  ui.notifications.info(game.i18n.format("CYBERPUNK.AmmoBoughtFull", {
    rounds: totalRounds, cal: caliber, mod: tryLocalize(AMMO_MODIFIERS[modifier]?.label ?? "Standard"), cost: totalCost
  }));
  return true;
}
