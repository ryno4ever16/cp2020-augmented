/**
 * Facedown / Recognition (CP2020 p.54).
 *
 * The combat tab ships these to every install, including a stock base system that has neither the
 * fork's `rollFacedown`/`rollRecognition` actor methods nor its `reputation` DataModel field. So the
 * module OWNS the feature: it renders the cards itself, and it stores the actor's Reputation in a
 * MODULE FLAG (`flags.cp2020-augmented.reputation`) — the stock `CyberpunkCharacterData` schema has no
 * `reputation` field and STRIPS any `system.reputation` write, so that value would always read 0. The
 * combat-tab input binds to that flag and `_prepareContext` reads it back for display. Cards render
 * through the shared `renderChatCard` → `templates/chat/{facedown,recognition}.hbs`; strings are CPLocal.
 *
 * (No host-deference: Reputation now lives in the flag, so deferring to a host `actor.rollFacedown`
 * that reads `system.reputation` would read the wrong store. The module fully owns the feature.)
 */
import { makeD10Roll } from "../dice.js";
import { createCyberpunkRollCard, renderChatCard } from "../compat.js";

const SCOPE = "cp2020-augmented";

/** The actor's Reputation, from the module flag (see file header for why it isn't system.reputation). */
function getReputation(actor) {
  return Number(actor?.getFlag?.(SCOPE, "reputation")) || 0;
}

/** Per-combatant Facedown line: split the rolled total back into die + COOL + Reputation for the card. */
function facedownLineData(actor, roll) {
  const cool = Number(actor.system?.stats?.cool?.total) || 0;
  const rep = getReputation(actor);
  const die = roll.total - cool - rep;   // the 1d10 (incl. any 10-explosion) portion
  return { name: actor.name, die, cool, rep, total: roll.total };
}

/**
 * Facedown (CP2020 p.54): roll 1d10 + COOL + Reputation. With exactly one OTHER token targeted this is a
 * CONTESTED roll — both sides roll, the card names the winner and posts the −3-vs-that-foe reminder (the
 * GM enforces it). With no/ambiguous target it just posts this actor's Facedown total.
 */
export async function rollFacedown(actor) {
  // COOL comes from system.stats (present on every base system); Reputation from the module flag,
  // passed as a literal term (the base DataModel has no @reputation roll-data path).
  const mkRoll = (a) => makeD10Roll(["@stats.cool.total", String(getReputation(a))], a.system).evaluate();

  const myRoll = await mkRoll(actor);
  const foes = [...(game.user?.targets ?? [])].map((t) => t.actor).filter((a) => a && a.id !== actor.id);
  const foe = foes.length === 1 ? foes[0] : null;

  let content, rolls;
  if (!foe) {
    content = await renderChatCard("facedown.hbs", {
      lines: [facedownLineData(actor, myRoll)], solo: true,
    });
    rolls = [myRoll];
  } else {
    const foeRoll = await mkRoll(foe);
    const tie = myRoll.total === foeRoll.total;
    const winner = myRoll.total >= foeRoll.total ? actor : foe;
    const loser = winner === actor ? foe : actor;
    content = await renderChatCard("facedown.hbs", {
      lines: [facedownLineData(actor, myRoll), facedownLineData(foe, foeRoll)],
      solo: false, tie, winnerName: winner.name, loserName: loser.name,
    });
    rolls = [myRoll, foeRoll];
  }
  await createCyberpunkRollCard({ rolls, speaker: ChatMessage.getSpeaker({ actor }), content });
}

/**
 * Recognition (CP2020 p.54): roll a flat 1d10 — rolling OVER your Reputation means they haven't heard of
 * you; rolling at or under your Rep means they recognize you. GM-facing "does this NPC know me?" check.
 */
export async function rollRecognition(actor) {
  const rep = getReputation(actor);
  const roll = await new Roll("1d10").evaluate();
  const recognized = roll.total <= rep;
  const content = await renderChatCard("recognition.hbs", {
    recognized, name: actor.name, roll: roll.total, rep,
  });
  await createCyberpunkRollCard({ rolls: [roll], speaker: ChatMessage.getSpeaker({ actor }), content });
}
