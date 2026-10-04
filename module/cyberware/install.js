import { formulaHasDice } from "../dice.js";
import { localize, tryLocalize, cappedWoundDamage } from "../utils.js";
import { canShop } from "../settings.js";
import { createCyberpunkChatMessage, getPublicMessageMode, rollToCyberpunkChatMessage } from "../compat.js";
import { correctionFor, applyCorrectionToItemData, markCorrectionApplied } from "../data-corrections.js";
import { isShopSetupMode } from "../shop/setup-mode.js";

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
 * Evaluate a dice/flat-number formula DEFENSIVELY, never throwing.
 *
 * The base system's compendia carry malformed Humanity-Cost strings — e.g. a trailing-operator
 * `"3d6+"` (the Kiroshi "Tricloptics") — which make `new Roll()` throw a peg-parse error and abort
 * an install mid-flow. A null/absent formula likewise makes `formulaHasDice()` throw on `.match`.
 * So: tolerate null/non-string, strip any dangling trailing operator before parsing, and catch any
 * parse error — falling back to a flat 0 (with a console warning) rather than throwing. Reused by
 * both the Humanity and surgical-damage rolls so there's a single hardened path.
 * @returns {Promise<{value:number, roll:Roll|null}>}
 */
async function evaluateFormulaSafe(formula) {
  // Strip a trailing operator/whitespace run left dangling by bad data ("3d6+", "2d6+ ") — a valid
  // formula never ends in an operator, so this is always safe and recovers the intended value.
  const cleaned = (formula == null ? "" : String(formula)).replace(/[+\-*/\s]+$/, "");
  if (formulaHasDice(cleaned)) {
    try {
      const roll = await new Roll(cleaned).evaluate();
      return { value: roll?.total ? roll.total : 0, roll };
    } catch (err) {
      console.warn(`cp2020-augmented | could not evaluate formula "${formula}", treating it as 0.`, err);
      return { value: 0, roll: null };
    }
  }
  const n = Number(cleaned);
  return { value: Number.isNaN(n) ? 0 : n, roll: null };
}

/**
 * Roll an item's Humanity Cost and persist the result as `system.humanityLoss`, posting a public
 * chat card (so a player can't silently reroll). Mirrors the item-sheet humanity-cost button.
 * @returns {Promise<{loss:number, roll:Roll|null}>}
 */
export async function rollCyberwareHumanity(item) {
  const hc = item?.system?.humanityCost;
  const { value: loss, roll } = await evaluateFormulaSafe(hc);
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
  const { value: dmg, roll } = await evaluateFormulaSafe(formula);
  if (dmg > 0) {
    const current = Number(actor.system?.damage) || 0;
    // fromCyberpunkDamageSystem suppresses the updateActor save-prompt hook — surgery isn't combat.
    // Clamped to the track's last box like every other wound-track writer (utils `cappedWoundDamage`,
    // 2026-08-27): a botched install must not be able to push a patient onto a wound state the table
    // prints no row for.
    await actor.update({ "system.damage": cappedWoundDamage(current + dmg) }, { fromCyberpunkDamageSystem: true });
  }
  return { dmg, roll };
}

const renderDialogTemplate = (path, context) =>
  (foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate)(path, context);

/**
 * Confirm dialog for an install. Returns the operator's choices, or null if cancelled:
 *   { proceed, installNow, paySurgery, rollHumanity, applyDamage }
 * `paySurgery` is the operator's own answer to "does the patient pay the fee" — unticking it installs
 * with the fee left unpaid (the box is only offered when there is a fee).
 * @param {object} o  { title, item, surgery, partPrice, surgeryCost, showPart, partUnpriced }
 */
async function _confirmInstall(o) {
  const hc = o.item.system?.humanityCost ?? "—";
  const total = (o.showPart ? (Number(o.partPrice) || 0) : 0) + (Number(o.surgeryCost) || 0);
  const content = await renderDialogTemplate("modules/cp2020-augmented/templates/dialog/cyber-install.hbs", {
    showPart: o.showPart,
    partUnpriced: o.partUnpriced === true,
    partPrice: Number(o.partPrice) || 0,
    surgeryLabel: tryLocalize(o.surgery.label),
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
        icon: "fas fa-syringe",
        label: localize("CyberInstallConfirm"),
        default: true,
        callback: (ev, btn, dlg) => {
          const r = dlg.element;
          resolve({ proceed: true, installNow: true,
            paySurgery: r.querySelector('[name="paySurgery"]')?.checked ?? true,
            rollHumanity: r.querySelector('[name="rollHumanity"]')?.checked ?? true,
            applyDamage: r.querySelector('[name="applyDamage"]')?.checked ?? true });
        },
      },
    ];
    // Only the BUY flow offers "buy only" (from the sheet you already own the item you're installing).
    if (o.showPart) buttons.push({
      action: "buyOnly",
      icon: "fas fa-box",
      label: localize("CyberBuyOnly"),
      callback: () => resolve({ proceed: true, installNow: false }),
    });
    buttons.push({ action: "cancel", icon: "fas fa-times", label: localize("Cancel"), callback: () => resolve(null) });
    new foundry.applications.api.DialogV2({
      // The class is what the button-row rules in the stylesheet key on (.cp-cyber-install-dialog); the
      // width keeps the cost lines and the three option rows on one line each — left to size itself the
      // window shrank to its narrowest word and wrapped every row.
      classes: ["cp-cyber-install-dialog"],
      position: { width: 380 },
      window: { title: o.title },
      content,
      buttons,
      rejectClose: false,
      close: () => resolve(null),
    }).render({ force: true });
  });
}

/**
 * What the operation will actually cost the patient. A fee they cannot cover is NOT a refusal: whoever
 * is running the install is shown the shortfall and may go ahead with the fee left unpaid (a favour, a
 * clinic tab, chrome the character is meant to start play with). It is asked on the client that is
 * about to take the money, so when a GM approves a request it is the GM who answers.
 * @param {object} o  { name, fee, available }  `available` = eurobucks left once the part is paid for
 * @returns {Promise<number|null>} the fee to charge (0 when left unpaid), or null when they backed out
 */
async function settleSurgeryFee({ name, fee, available }) {
  const due = Math.max(0, Number(fee) || 0);
  const have = Math.max(0, Number(available) || 0);
  if (due === 0 || due <= have) return due;
  const content = await renderDialogTemplate("modules/cp2020-augmented/templates/dialog/cyber-surgery-unpaid.hbs",
    { name, fee: due, available: have });
  const go = await foundry.applications.api.DialogV2.confirm({
    window: { title: localize("CyberSurgeryUnpaidTitle") },
    content,
    yes: { icon: "fas fa-syringe", label: localize("CyberSurgeryUnpaidGo") },
    no: { icon: "fas fa-times", label: localize("Cancel") },
    rejectClose: false,
  });
  return go === true ? 0 : null;
}

/** Post the install summary chat card. */
async function _postInstallSummary(actor, item, { surgery, charged, loss, dmg }) {
  const speaker = ChatMessage.getSpeaker(actor ? { actor } : {});
  await createCyberpunkChatMessage({
    speaker,
    content: localize("CyberInstalledSummary", {
      actor: actor?.name ?? game.user.name, item: item.name,
      surgery: tryLocalize(surgery.label), charged, loss, dmg
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
  if (item.system?.equipped === true) {
    ui.notifications?.warn(localize("CyberAlreadyInstalled", { item: item.name }));
    return false;
  }
  const surgery = getSurgery(item.system?.surgCode);
  // GM setup mode waives the FEE and nothing else: the confirm dialog, the Humanity roll, the surgical
  // damage and the summary card all still happen, because installing chrome is a decision the GM wants
  // to see even while they are furnishing (module/shop/setup-mode.js — the user's own amendment).
  const listedFee = (chargeSurgery && !isShopSetupMode()) ? surgery.cost : 0;

  let choices = { proceed: true, paySurgery: true, rollHumanity: true, applyDamage: true };
  if (confirm) {
    choices = await _confirmInstall({
      title: localize("CyberInstallTitle", { item: item.name }),
      item, surgery, surgeryCost: listedFee, showPart: false
    });
    if (!choices) return false;
  }

  const funds = Number(actor.system?.eurobucks) || 0;
  const surgeryCost = await settleSurgeryFee({
    name: item.name, fee: choices.paySurgery === false ? 0 : listedFee, available: funds });
  if (surgeryCost === null) return false;
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
 *
 * Two callers reach this. A buyer acting for themselves gets the confirm dialog here (`confirm`, the
 * default). A GM approving a buyer's REQUEST passes `confirm: false` with the answers the buyer already
 * gave on their own client (`install`, `paySurgery`, `rollHumanity`, `applyDamage` — see
 * `askCyberwareChoice`) and the `requesterId` that marks the purchase as somebody else's.
 * @param {Actor} actor
 * @param {Item|object} source      catalog Item or raw data
 * @param {object} [opts]           { partPrice, confirm=true, install, paySurgery, rollHumanity, applyDamage, requesterId }
 * @returns {Promise<boolean>}
 */
export async function buyAndInstallCyberware(actor, source, opts = {}) {
  if (!actor) { ui.notifications?.warn(localize("ShopNoActor")); return false; }
  if (!canShop()) { ui.notifications?.warn(localize("ShopNotAllowed")); return false; }

  const { confirm = true } = opts;
  const { data, partPrice, surgery, surgeryCost } = cyberwareTerms(source, opts.partPrice, { requesterId: opts.requesterId });

  // The PART has to be paid for: buy-only must stay reachable even when the buyer can't afford the
  // surgery, and the surgery fee is settled on its own below.
  const funds = Number(actor.system?.eurobucks) || 0;
  if (partPrice > funds) {
    ui.notifications?.warn(game.i18n.format("CYBERPUNK.ShopInsufficientFunds", { name: data.name ?? "cyberware", cost: partPrice, funds }));
    return false;
  }

  let choices = {
    proceed: true, installNow: opts.install !== false, paySurgery: opts.paySurgery !== false,
    rollHumanity: opts.rollHumanity !== false, applyDamage: opts.applyDamage !== false,
  };
  if (confirm) {
    choices = await _confirmInstall({
      title: localize("CyberBuyInstallTitle", { item: data.name ?? "cyberware" }),
      item: { name: data.name, system: data.system }, surgery, partPrice, surgeryCost, showPart: true
    });
    if (!choices) return false;
  }
  const installNow = choices.installNow !== false && opts.install !== false;
  let fee = 0;
  if (installNow) {
    fee = await settleSurgeryFee({
      name: data.name ?? "cyberware", fee: choices.paySurgery === false ? 0 : surgeryCost, available: funds - partPrice });
    if (fee === null) return false;
  }
  const charge = partPrice + fee;

  const item = await chargeAndStockCyberware(actor, data, { charge, installed: installNow });
  if (!item) return false;
  if (!installNow) return postCyberwareBoughtOnly(actor, item, charge);
  return completeCyberwareInstall(actor, item, {
    surgery, charged: charge, rollHumanity: choices.rollHumanity !== false, applyDamage: choices.applyDamage !== false,
  });
}

/**
 * Ask the buyer the install question for a purchase that is about to go to the GM as a REQUEST. It is
 * asked on the buyer's own client, BEFORE the request is sent, so the person playing the character
 * decides what is done to it and the GM is left one thing to do: approve or deny. Nothing is charged or
 * created here; the answers travel on the request and come back through `buyAndInstallCyberware`.
 * @param {Actor} actor
 * @param {Item|object} source
 * @param {object} [o]  { partPrice }  null = the part has no catalog price yet (the GM sets one)
 * @returns {Promise<{install:boolean, paySurgery:boolean, rollHumanity:boolean, applyDamage:boolean,
 *   surgeryLabel:string, surgeryCost:number}|null>} null when the buyer cancelled
 */
export async function askCyberwareChoice(actor, source, { partPrice = null } = {}) {
  const unpriced = partPrice == null;
  const { data, partPrice: price, surgery, surgeryCost } = cyberwareTerms(source, unpriced ? 0 : partPrice, { requesterId: game.user.id });
  const name = data.name ?? "cyberware";
  const choices = await _confirmInstall({
    title: localize("CyberBuyInstallTitle", { item: name }),
    item: { name: data.name, system: data.system }, surgery, partPrice: price, surgeryCost,
    showPart: true, partUnpriced: unpriced,
  });
  if (!choices) return null;
  const install = choices.installNow !== false;
  let paySurgery = install && surgeryCost > 0 && choices.paySurgery !== false;
  // With a known part price the shortfall is already visible, so it is settled now and the GM sees the
  // request as it will be carried out. (A part the buyer cannot afford at all is left for the approval
  // to report; an unpriced part cannot be judged until the GM prices it.)
  const funds = Number(actor?.system?.eurobucks) || 0;
  if (paySurgery && !unpriced && price <= funds) {
    const fee = await settleSurgeryFee({ name, fee: surgeryCost, available: funds - price });
    if (fee === null) return null;
    paySurgery = fee > 0;
  }
  return {
    install, paySurgery,
    rollHumanity: choices.rollHumanity !== false, applyDamage: choices.applyDamage !== false,
    surgeryLabel: surgery.label, surgeryCost,
  };
}

/* ══════════════════════ The shared halves ══════════════════════
 *
 * Everything below is what `buyAndInstallCyberware` above is made of.
 */

/** Resolve a catalog document into the terms a buyer has to decide on: the item data to create, what
 *  the part costs, and what the surgery its code names costs and does.
 *  `requesterId` marks a purchase made on somebody else's behalf (a player's request the GM is
 *  approving): GM setup mode never applies to those — the same rule buyItem follows for ordinary goods
 *  (module/shop/purchase.js, the `setup` line). */
export function cyberwareTerms(source, partPriceOverride, { requesterId = null } = {}) {
  const data = (source && typeof source.toObject === "function") ? source.toObject() : foundry.utils.deepClone(source ?? {});
  // Shop-bought copy of a base-compendium item: stamp its origin uuid (toObject drops it) AND apply the
  // book corrections up front, so the surgery below prices from the CORRECTED Surgery Code and the created
  // item carries the corrected data. Stamped so the preCreateItem hook (data-corrections.js) won't re-apply.
  if (source?.pack && typeof source.uuid === "string") {
    data._stats = { ...(data._stats ?? {}), compendiumSource: source.uuid };
    const corr = correctionFor(source.pack, source.id);
    if (corr) { applyCorrectionToItemData(data, corr); markCorrectionApplied(data); }
  }
  // In GM setup mode both halves of the bill go to zero — the part and the surgery — while the terms
  // themselves (the surgery's label, its damage, the Humanity cost) travel unchanged, so every card
  // downstream still shows the GM what the operation actually does.
  const setup = isShopSetupMode() && !requesterId;
  const partPrice = setup ? 0 : Math.max(0, Math.round(Number(partPriceOverride ?? data.system?.cost ?? 0)));
  const surgery = getSurgery(data.system?.surgCode);
  return { data, partPrice, surgery, surgeryCost: setup ? 0 : surgery.cost };
}

/** Charge, then create — and refund if the create fails. Same discipline, and the same order, as
 *  buyItem. Funds are read HERE rather than passed in, because every caller has been away from the
 *  actor for as long as a person took to press a button. Returns the created item, or null. */
export async function chargeAndStockCyberware(actor, data, { charge = 0, installed = false } = {}) {
  const funds = Number(actor.system?.eurobucks) || 0;
  if (charge > funds) {
    ui.notifications?.warn(game.i18n.format("CYBERPUNK.ShopInsufficientFunds", { name: data.name ?? "cyberware", cost: charge, funds }));
    return null;
  }
  await actor.update({ "system.eurobucks": funds - charge });
  try {
    const payload = foundry.utils.deepClone(data);
    delete payload._id; delete payload.folder; delete payload.ownership;
    if (payload.flags?.["cp2020-augmented"]?.shop) delete payload.flags["cp2020-augmented"].shop;
    payload.system = payload.system ?? {};
    payload.system.equipped = installed;   // buy-only leaves it uninstalled (no EMP/Humanity hit yet)
    const [item] = await actor.createEmbeddedDocuments("Item", [payload]);
    return item;
  } catch (err) {
    console.error("cp2020-augmented | cyberware purchase failed to stock, refunding.", err);
    await actor.update({ "system.eurobucks": funds });
    ui.notifications?.error(localize("ShopBuyFailed"));
    return null;
  }
}

/** Buy-only: it sits in inventory uninstalled and the owner can Install (Surgery) later from the sheet. */
export async function postCyberwareBoughtOnly(actor, item, charged) {
  const speaker = ChatMessage.getSpeaker(actor ? { actor } : {});
  await createCyberpunkChatMessage({
    speaker,
    content: localize("CyberBoughtUninstalled", { actor: actor?.name ?? game.user.name, item: item.name, cost: charged })
  }, { messageMode: getPublicMessageMode() });
  ui.notifications?.info(localize("CyberBoughtInfo", { item: item.name }));
  return true;
}

/** The surgery itself, on an item that already exists and is already paid for. */
export async function completeCyberwareInstall(actor, item, { surgery, charged = 0, rollHumanity = true, applyDamage = true } = {}) {
  let loss = 0, dmg = 0;
  if (rollHumanity) loss = (await rollCyberwareHumanity(item)).loss;
  if (applyDamage) dmg = (await rollSurgicalDamage(actor, surgery.damage)).dmg;
  await _postInstallSummary(actor, item, { surgery, charged, loss, dmg });
  ui.notifications?.info(localize("CyberInstalled", { item: item.name }));
  return true;
}
