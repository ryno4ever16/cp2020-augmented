import { formulaHasDice } from "../dice.js";
import { localize, tryLocalize } from "../utils.js";
import { canShop } from "../settings.js";
import { createCyberpunkChatMessage, getPublicMessageMode, rollToCyberpunkChatMessage, renderChatCard } from "../compat.js";
import { correctionFor, applyCorrectionToItemData, markCorrectionApplied } from "../data-corrections.js";

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
  const { data, partPrice, surgery, surgeryCost } = cyberwareTerms(source, opts.partPrice);

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

  const item = await chargeAndStockCyberware(actor, data, { charge, installed: installNow });
  if (!item) return false;
  if (!installNow) return postCyberwareBoughtOnly(actor, item, charge);
  return completeCyberwareInstall(actor, item, {
    surgery, charged: charge, rollHumanity: choices.rollHumanity, applyDamage: choices.applyDamage,
  });
}

/* ══════════════════════ The shared halves ══════════════════════
 *
 * Everything below is what `buyAndInstallCyberware` above is made of, pulled out so the OTHER route to
 * the same purchase — a player's request, approved by the GM, where the choice belongs to the player
 * and the surgery to the GM (see `offerCyberwareChoice`) — runs the same engine rather than a second
 * reading of it. Split at the two points where the flow can pause for a person: after the terms are
 * known, and after the item exists.
 */

/** Resolve a catalog document into the terms a buyer has to decide on: the item data to create, what
 *  the part costs, and what the surgery its code names costs and does. */
export function cyberwareTerms(source, partPriceOverride) {
  const data = (source && typeof source.toObject === "function") ? source.toObject() : foundry.utils.deepClone(source ?? {});
  // Shop-bought copy of a base-compendium item: stamp its origin uuid (toObject drops it) AND apply the
  // book corrections up front, so the surgery below prices from the CORRECTED Surgery Code and the created
  // item carries the corrected data. Stamped so the preCreateItem hook (data-corrections.js) won't re-apply.
  if (source?.pack && typeof source.uuid === "string") {
    data._stats = { ...(data._stats ?? {}), compendiumSource: source.uuid };
    const corr = correctionFor(source.pack, source.id);
    if (corr) { applyCorrectionToItemData(data, corr); markCorrectionApplied(data); }
  }
  const partPrice = Math.max(0, Math.round(Number(partPriceOverride ?? data.system?.cost ?? 0)));
  const surgery = getSurgery(data.system?.surgCode);
  return { data, partPrice, surgery, surgeryCost: surgery.cost };
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

/* ══════════════════════ The approved-request route ══════════════════════
 *
 * A player asks the GM to buy a piece of chrome; the GM approves. The money and the stock are the
 * GM's business and are settled before this point (module/shop/catalog.js), but the two questions
 * left are not the same person's:
 *
 *   • Install it, or just buy the part?  — the BUYER's, because it is their character's Humanity and
 *     their character's wound track. Asked of the GM, a player found out what had been done to them
 *     from the summary card.
 *   • Roll the Humanity loss? Apply the surgical damage?  — the GM's, because those are referee knobs
 *     that exist for tables handling either by hand.
 *
 * So the approval hands a whispered CHOICE card to the requesting player, and picking Install hands a
 * whispered SURGERY card back to the GMs. Nothing is charged until the hop that actually does the
 * thing: buy-only charges the part at the player's click, install charges part plus surgery at the
 * GM's. Funds are re-read at every hop, because between hops is a person deciding.
 *
 * The card idiom is the purchase request's own, verbatim: flags carrying the whole job, a `status`
 * field flipped before the charge so a second click on another client finds it resolved, an in-memory
 * claim so a double-click on THIS client cannot fire twice, and the content re-rendered to a resolved
 * state. Buttons are bound in module/shop/catalog.js's single chat-card pass — these cards carry the
 * `cp-shop-` class prefix its cheap bail looks for, which they earn honestly: they exist only as steps
 * of a shop purchase.
 */

const SCOPE = "cp2020-augmented";

/** Cards being resolved on THIS client — claimed synchronously, before any await. */
const _resolvingCyberCards = new Set();

/** Re-read the catalog document a card names and rebuild its terms. The cards carry pack/item ids
 *  rather than a copy of the item, so a correction landing between hops is picked up and a card that
 *  outlives its compendium resolves to nothing instead of to stale data. */
async function _termsFromCard(job) {
  const doc = await game.packs.get(job.packId)?.getDocument(job.itemId);
  if (!doc) { ui.notifications?.warn(localize("ShopItemUnavailable")); return null; }
  return cyberwareTerms(doc, job.partPrice);
}

/** Flip a card's status flag and re-render its content into the resolved state. */
async function _closeCyberCard(message, flagKey, template, context) {
  const content = await renderChatCard(template, context);
  await message.update({ content, [`flags.${SCOPE}.${flagKey}.status`]: context.status });
}

/**
 * Hand the buyer the install-or-buy-only choice, whispered. Called by the shop's request resolver in
 * place of the confirm dialog the direct path shows — the direct path is unchanged and still runs its
 * dialog on the client that started it.
 */
export async function offerCyberwareChoice(buyer, source, { partPrice, packId, itemId, requesterId } = {}) {
  if (!buyer) { ui.notifications?.warn(localize("ShopNoActor")); return false; }
  const { data, partPrice: price, surgery, surgeryCost } = cyberwareTerms(source, partPrice);
  const job = {
    buyerId: buyer.id, packId, itemId, name: data.name ?? "", partPrice: price,
    surgeryCost, requesterId: requesterId ?? "", approvedBy: game.user.id, status: "pending",
  };
  const context = {
    pending: true, status: "pending",
    name: job.name, buyer: buyer.name, partPrice: price,
    surgeryLabel: tryLocalize(surgery.label), surgeryCost, surgeryDamage: surgery.damage,
    humanityCost: String(data.system?.humanityCost ?? "—"),
    total: price + surgeryCost,
  };
  const content = await renderChatCard("shop/cyber-choice.hbs", context);
  const card = {
    content,
    whisper: [requesterId, ...ChatMessage.getWhisperRecipients("GM").map(u => u.id)].filter(Boolean),
    speaker: ChatMessage.getSpeaker({ actor: buyer }),
    flags: { [SCOPE]: { cyberChoice: job } },
  };
  // ⭐ AUTHORED BY THE PLAYER, deliberately, even though a GM is creating it. A chat message's author
  // is its owner, and the player has to be able to close this card when they answer it — a card the
  // GM owns would refuse the player's own update and the decision would die on their client. A GM may
  // create a message under any author (core's own create rule); a player may not, which is exactly why
  // the reverse card, whispered back to the GMs, is authored by whoever posts it.
  if (requesterId) card.author = requesterId;
  await ChatMessage.create(card);
  return true;
}

/**
 * The buyer's answer. "buyOnly" ends here — they own the character, so the charge and the item are
 * ordinary local writes. "install" charges nothing and asks the GMs for the surgery.
 * @returns {Promise<boolean>} false when the clicker should be able to try again (funds, a missing
 *   document): the card stays pending and its buttons come back.
 */
export async function resolveCyberChoice(message, action) {
  const job = message?.getFlag?.(SCOPE, "cyberChoice");
  if (!job || job.status !== "pending") return true;
  // Whispered to the requester and to the GMs; the requester decides, and a GM may decide for them —
  // the table's own convention when a player is away from the keyboard.
  if (game.user.id !== job.requesterId && !game.user.isGM) return true;
  const buyer = game.actors.get(job.buyerId);
  if (!buyer) { ui.notifications?.warn(localize("ShopNoActor")); return false; }
  if (_resolvingCyberCards.has(message.id)) return true;
  _resolvingCyberCards.add(message.id);
  try {
    const terms = await _termsFromCard(job);
    if (!terms) return false;
    const funds = Number(buyer.system?.eurobucks) || 0;

    if (action === "buyOnly") {
      if (terms.partPrice > funds) {
        ui.notifications?.warn(game.i18n.format("CYBERPUNK.ShopInsufficientFunds", { name: job.name, cost: terms.partPrice, funds }));
        return false;
      }
      await _closeCyberCard(message, "cyberChoice", "shop/cyber-choice.hbs", {
        pending: false, status: "boughtOnly", name: job.name, buyer: buyer.name,
        partPrice: terms.partPrice, resolvedBy: game.user.name,
      });
      const item = await chargeAndStockCyberware(buyer, terms.data, { charge: terms.partPrice, installed: false });
      if (!item) return true;                       // the card is closed; the refund happened inside
      await postCyberwareBoughtOnly(buyer, item, terms.partPrice);
      return true;
    }

    // Install: the money is taken at the GM's hop, so nothing is charged here — but refuse now rather
    // than send the GM a card for a purchase that cannot be paid for.
    const total = terms.partPrice + terms.surgeryCost;
    if (total > funds) {
      ui.notifications?.warn(game.i18n.format("CYBERPUNK.ShopInsufficientFunds", { name: job.name, cost: total, funds }));
      return false;
    }
    await _closeCyberCard(message, "cyberChoice", "shop/cyber-choice.hbs", {
      pending: false, status: "awaitingSurgery", name: job.name, buyer: buyer.name,
      partPrice: terms.partPrice, resolvedBy: game.user.name,
    });
    await _requestSurgery(buyer, job, terms);
    return true;
  } finally {
    _resolvingCyberCards.delete(message.id);
  }
}

/** Whisper the GMs the surgery confirmation, carrying the referee's own two knobs. */
async function _requestSurgery(buyer, job, terms) {
  const context = {
    pending: true, status: "pending",
    name: job.name, buyer: buyer.name, patient: game.users.get(job.requesterId)?.name ?? "",
    partPrice: terms.partPrice, surgeryLabel: tryLocalize(terms.surgery.label),
    surgeryCost: terms.surgeryCost, surgeryDamage: terms.surgery.damage,
    humanityCost: String(terms.data.system?.humanityCost ?? "—"),
    total: terms.partPrice + terms.surgeryCost,
  };
  const content = await renderChatCard("shop/cyber-surgery.hbs", context);
  await ChatMessage.create({
    content,
    whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id),
    speaker: ChatMessage.getSpeaker({ actor: buyer }),
    flags: { [SCOPE]: { cyberSurgery: { ...job, status: "pending" } } },
  });
  ui.notifications?.info(localize("CyberSurgeryRequested", { item: job.name }));
}

/**
 * The GM's answer to the surgery card. Approve charges part + surgery together and runs the whole
 * install; the two checkboxes are read off the card the GM is looking at.
 * @returns {Promise<boolean>} false when the GM should be able to try again.
 */
export async function resolveCyberSurgery(message, approve, { rollHumanity = true, applyDamage = true } = {}) {
  if (!game.user.isGM) return true;
  const job = message?.getFlag?.(SCOPE, "cyberSurgery");
  if (!job || job.status !== "pending") return true;
  const buyer = game.actors.get(job.buyerId);
  if (approve && !buyer) { ui.notifications?.warn(localize("ShopNoActor")); return false; }
  if (_resolvingCyberCards.has(message.id)) return true;
  _resolvingCyberCards.add(message.id);
  try {
    if (!approve) {
      await _closeCyberCard(message, "cyberSurgery", "shop/cyber-surgery.hbs", {
        pending: false, status: "refused", name: job.name, buyer: buyer?.name ?? "", resolvedBy: game.user.name,
      });
      const player = game.users.get(job.requesterId);
      if (player) await ChatMessage.create({
        whisper: [player.id],
        content: localize("CyberSurgeryRefusedWhisper", { item: foundry.utils.escapeHTML(job.name ?? "") }),
      });
      return true;
    }
    const terms = await _termsFromCard(job);
    if (!terms) return false;
    const charge = terms.partPrice + terms.surgeryCost;
    const funds = Number(buyer.system?.eurobucks) || 0;
    if (charge > funds) {
      ui.notifications?.warn(game.i18n.format("CYBERPUNK.ShopInsufficientFunds", { name: job.name, cost: charge, funds }));
      return false;
    }
    // Close the card BEFORE the charge, for the reason the purchase request flips its status early:
    // a second GM's click has to find this resolved rather than charge a second time.
    await _closeCyberCard(message, "cyberSurgery", "shop/cyber-surgery.hbs", {
      pending: false, status: "done", name: job.name, buyer: buyer.name, resolvedBy: game.user.name,
    });
    const item = await chargeAndStockCyberware(buyer, terms.data, { charge, installed: true });
    if (!item) return true;                         // charge already refunded inside
    await completeCyberwareInstall(buyer, item, { surgery: terms.surgery, charged: charge, rollHumanity, applyDamage });
    return true;
  } finally {
    _resolvingCyberCards.delete(message.id);
  }
}
