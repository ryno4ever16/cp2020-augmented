import { formulaHasDice } from "../dice.js";
import { localize } from "../utils.js";
import { canShop } from "../settings.js";
import { createCyberpunkChatMessage, getPublicMessageMode, rollToCyberpunkChatMessage } from "../compat.js";

/**
 * Cyberware buy-and-install flow (Shopping #14 — [[shopping-design]]).
 *
 * Installing chrome is a deliberate, confirmed act (a ripperdoc visit), never silent automation:
 *   • charge the surgery cost (from the item's Surgery Code),
 *   • roll Humanity loss (the item's Humanity Cost dice) and store it on the item — the actor's
 *     EMP/Humanity is DERIVED from the sum of humanityLoss across equipped cyberware (actor.js),
 *   • roll + apply Surgical Damage to the wound track (suppressing the combat stun/death prompt),
 *   • mark the item equipped (= installed).
 *
 * Surgery Codes in the data: N / M / MA / CR / CRx2 (+ a few blank). Costs/damage per the Core
 * Surgery table ([[core-rules-reference]]); CRx2 = a double-critical (full-borg) op = 2× Critical.
 */
export const SURGERY = {
  N:    { label: "Negligible",  cost: 0,    damage: "1" },
  M:    { label: "Minor",       cost: 500,  damage: "1d6+1" },
  MA:   { label: "Major",       cost: 1500, damage: "2d6+1" },
  CR:   { label: "Critical",    cost: 2500, damage: "3d6+1" },
  CRX2: { label: "Critical ×2", cost: 5000, damage: "6d6+2" }
};

/** Map a raw surgCode to a surgery entry; blank/unknown → Negligible (free, 1 pt). */
export function getSurgery(code) {
  const key = String(code ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return SURGERY[key] ?? SURGERY.N;
}

/**
 * Roll an item's Humanity Cost and persist the result as `system.humanityLoss`, posting a public
 * chat card (so a player can't silently reroll). Mirrors the item-sheet humanity-cost button.
 * @returns {Promise<{loss:number, roll:Roll|null}>}
 */
export async function rollCyberwareHumanity(item) {
  const hc = item?.system?.humanityCost;
  let loss = 0, roll = null;
  if (formulaHasDice(hc)) {
    roll = await new Roll(hc).evaluate();
    loss = roll?.total ? roll.total : 0;
  } else {
    const n = Number(hc);
    loss = Number.isNaN(n) ? 0 : n;
  }
  await item.update({ "system.humanityLoss": loss });

  const actor = item.actor ?? null;
  const speaker = ChatMessage.getSpeaker(actor ? { actor } : {});
  const messageMode = getPublicMessageMode();
  if (roll) {
    await rollToCyberpunkChatMessage(roll,
      { speaker, flavor: localize("Chat.HumanityRollFlavor", { actor: actor?.name ?? game.user.name, item: item.name }) },
      { messageMode });
  } else {
    await createCyberpunkChatMessage(
      { speaker, content: localize("Chat.HumanityLossSet", { actor: actor?.name ?? game.user.name, item: item.name, loss }) },
      { messageMode });
  }
  return { loss, roll };
}

/** Roll a surgical-damage formula and add it to the actor's wound track (no stun/death prompt). */
async function rollSurgicalDamage(actor, formula) {
  let dmg = 0, roll = null;
  if (formulaHasDice(formula)) {
    roll = await new Roll(formula).evaluate();
    dmg = roll?.total ? roll.total : 0;
  } else {
    dmg = Number(formula) || 0;
  }
  if (dmg > 0) {
    const current = Number(actor.system?.damage) || 0;
    // fromCyberpunkDamageSystem suppresses the updateActor save-prompt hook — surgery isn't combat.
    await actor.update({ "system.damage": current + dmg }, { fromCyberpunkDamageSystem: true });
  }
  return { dmg, roll };
}

/**
 * Confirm dialog for an install. Returns { proceed, rollHumanity, applyDamage } or null if cancelled.
 * @param {object} o  { title, item, surgery, partPrice, surgeryCost, showPart }
 */
async function _confirmInstall(o) {
  const hc = o.item.system?.humanityCost ?? "—";
  const total = (o.showPart ? (Number(o.partPrice) || 0) : 0) + (Number(o.surgeryCost) || 0);
  const render = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  const content = await render("modules/cp2020-augmented/templates/dialog/cyber-install.hbs", {
    showPart: o.showPart,
    partPrice: Number(o.partPrice) || 0,
    surgeryLabel: o.surgery.label,
    surgeryCost: Number(o.surgeryCost) || 0,
    total,
    hc: String(hc),
    surgeryDamage: o.surgery.damage,
  });
  return new Promise((resolve) => {
    // Buttons are built INSIDE the executor so their callbacks close over `resolve`.
    const buttons = [
      {
        action: "ok",
        icon: '<i class="fas fa-syringe"></i>',
        label: localize("CyberInstallConfirm"),
        default: true,
        callback: (ev, btn, dlg) => {
          const r = dlg.element;
          resolve({ proceed: true, installNow: true,
            rollHumanity: r.querySelector('[name="rollHumanity"]')?.checked ?? true,
            applyDamage: r.querySelector('[name="applyDamage"]')?.checked ?? true });
        },
      },
    ];
    // Only the BUY flow offers "buy only" (from the sheet you already own the item you're installing).
    if (o.showPart) buttons.push({
      action: "buyOnly",
      icon: '<i class="fas fa-box"></i>',
      label: localize("CyberBuyOnly"),
      callback: () => resolve({ proceed: true, installNow: false }),
    });
    buttons.push({ action: "cancel", icon: '<i class="fas fa-times"></i>', label: localize("Cancel"), callback: () => resolve(null) });
    new foundry.applications.api.DialogV2({
      window: { title: o.title },
      content,
      buttons,
      rejectClose: false,
      close: () => resolve(null),
    }).render({ force: true });
  });
}

/** Post the install summary chat card. */
async function _postInstallSummary(actor, item, { surgery, charged, loss, dmg }) {
  const speaker = ChatMessage.getSpeaker(actor ? { actor } : {});
  await createCyberpunkChatMessage({
    speaker,
    content: localize("CyberInstalledSummary", {
      actor: actor?.name ?? game.user.name, item: item.name,
      surgery: surgery.label, charged, loss, dmg
    })
  }, { messageMode: getPublicMessageMode() });
}

/**
 * Install a cyberware item already on the actor (the item-sheet "Install (Surgery)" button, or the
 * second half of a shop purchase). Confirms, charges surgery, rolls humanity, applies surgical
 * damage, and marks it equipped.
 * @param {Actor} actor
 * @param {Item}  item       a cyberware Item embedded on `actor`
 * @param {object} [opts]    { confirm=true, chargeSurgery=true }
 * @returns {Promise<boolean>}
 */
export async function installCyberware(actor, item, opts = {}) {
  const { confirm = true, chargeSurgery = true } = opts;
  if (!actor || !item || item.type !== "cyberware") return false;
  const surgery = getSurgery(item.system?.surgCode);
  const surgeryCost = chargeSurgery ? surgery.cost : 0;

  let choices = { proceed: true, rollHumanity: true, applyDamage: true };
  if (confirm) {
    choices = await _confirmInstall({
      title: localize("CyberInstallTitle", { item: item.name }),
      item, surgery, surgeryCost, showPart: false
    });
    if (!choices) return false;
  }

  const funds = Number(actor.system?.eurobucks) || 0;
  if (surgeryCost > funds) {
    ui.notifications?.warn(localize("CyberSurgeryFunds", { cost: surgeryCost, funds }));
    return false;
  }
  if (surgeryCost > 0) await actor.update({ "system.eurobucks": funds - surgeryCost });
  if (item.system?.equipped !== true) await item.update({ "system.equipped": true });

  let loss = Number(item.system?.humanityLoss) || 0;
  if (choices.rollHumanity) loss = (await rollCyberwareHumanity(item)).loss;
  let dmg = 0;
  if (choices.applyDamage) dmg = (await rollSurgicalDamage(actor, surgery.damage)).dmg;

  await _postInstallSummary(actor, item, { surgery, charged: surgeryCost, loss, dmg });
  ui.notifications?.info(localize("CyberInstalled", { item: item.name }));
  return true;
}

/**
 * Buy a cyberware item from the catalog/shop AND install it in one confirmed step (Shopping #14).
 * Charges part cost + surgery cost together, creates the item (equipped), rolls humanity + surgical
 * damage. Refunds on stocking failure.
 * @param {Actor} actor
 * @param {Item|object} source      catalog Item or raw data
 * @param {object} [opts]           { partPrice, priceLabel, confirm=true }
 * @returns {Promise<boolean>}
 */
export async function buyAndInstallCyberware(actor, source, opts = {}) {
  if (!actor) { ui.notifications?.warn(localize("ShopNoActor")); return false; }
  if (!canShop()) { ui.notifications?.warn(localize("ShopNotAllowed")); return false; }

  const { confirm = true } = opts;
  const data = (source && typeof source.toObject === "function") ? source.toObject() : foundry.utils.deepClone(source ?? {});
  const partPrice = Math.max(0, Math.round(Number(opts.partPrice ?? data.system?.cost ?? 0)));
  const surgery = getSurgery(data.system?.surgCode);
  const surgeryCost = surgery.cost;

  // Initial affordability is checked against the PART price alone — buy-only must stay reachable even
  // if the buyer can't afford the surgery; the actual charge is re-validated after the choice.
  const funds = Number(actor.system?.eurobucks) || 0;
  if (partPrice > funds) {
    ui.notifications?.warn(game.i18n.format("CYBERPUNK.ShopInsufficientFunds", { name: data.name ?? "cyberware", cost: partPrice, funds }));
    return false;
  }

  let choices = { proceed: true, installNow: opts.install !== false, rollHumanity: true, applyDamage: true };
  if (confirm) {
    choices = await _confirmInstall({
      title: localize("CyberBuyInstallTitle", { item: data.name ?? "cyberware" }),
      item: { name: data.name, system: data.system }, surgery, partPrice, surgeryCost, showPart: true
    });
    if (!choices) return false;
  }
  const installNow = choices.installNow !== false && opts.install !== false;
  const charge = installNow ? partPrice + surgeryCost : partPrice;

  // Re-check funds (settings/funds could change while the dialog was open).
  const funds2 = Number(actor.system?.eurobucks) || 0;
  if (charge > funds2) { ui.notifications?.warn(game.i18n.format("CYBERPUNK.ShopInsufficientFunds", { name: data.name, cost: charge, funds: funds2 })); return false; }

  // Charge first, then create (refund on failure) — same discipline as buyItem.
  await actor.update({ "system.eurobucks": funds2 - charge });
  let item;
  try {
    delete data._id; delete data.folder; delete data.ownership;
    if (data.flags?.["cp2020-augmented"]?.shop) delete data.flags["cp2020-augmented"].shop;
    data.system = data.system ?? {};
    data.system.equipped = installNow;   // buy-only leaves it uninstalled (no EMP/Humanity hit yet)
    [item] = await actor.createEmbeddedDocuments("Item", [data]);
  } catch (err) {
    console.error("cp2020-augmented | cyberware purchase failed to stock, refunding.", err);
    await actor.update({ "system.eurobucks": funds2 });
    ui.notifications?.error(localize("ShopBuyFailed"));
    return false;
  }

  // Buy-only: drop it in inventory uninstalled; the player can Install (Surgery) later from the sheet.
  if (!installNow) {
    const speaker = ChatMessage.getSpeaker(actor ? { actor } : {});
    await createCyberpunkChatMessage({
      speaker,
      content: localize("CyberBoughtUninstalled", { actor: actor?.name ?? game.user.name, item: item.name, cost: charge })
    }, { messageMode: getPublicMessageMode() });
    ui.notifications?.info(localize("CyberBoughtInfo", { item: item.name }));
    return true;
  }

  let loss = 0, dmg = 0;
  if (choices.rollHumanity) loss = (await rollCyberwareHumanity(item)).loss;
  if (choices.applyDamage) dmg = (await rollSurgicalDamage(actor, surgery.damage)).dmg;

  await _postInstallSummary(actor, item, { surgery, charged: charge, loss, dmg });
  ui.notifications?.info(localize("CyberInstalled", { item: item.name }));
  return true;
}
