/**
 * Facedown / Recognition (CP2020 p.54) — module fallback.
 *
 * These are a host-system feature (`CyberpunkActor.rollFacedown` / `rollRecognition` on our fork),
 * but the module's combat tab ships the Facedown/Recognition BUTTONS to every install — including a
 * stock base system that has no such actor methods. There the buttons would throw
 * ("actor.rollFacedown is not a function") and do nothing. This module file ports the host logic so
 * the buttons work everywhere, while `rollFacedown(actor)` / `rollRecognition(actor)` PREFER the
 * host's own actor method when present (a future base that ships it wins automatically) — the same
 * prefer-host-else-fallback contract as `apiHelper` in system-api.js. Cards render through the shared
 * `renderChatCard` → `templates/chat/{facedown,recognition}.hbs`; all strings are CPLocal-localized.
 */
import { makeD10Roll } from "../dice.js";
import { createCyberpunkRollCard, renderChatCard } from "../compat.js";

/** Per-combatant Facedown line: split the rolled total back into die + COOL + Reputation for the card. */
function facedownLineData(actor, roll) {
  const cool = Number(actor.system?.stats?.cool?.total) || 0;
  const rep = Number(actor.system?.reputation) || 0;
  const die = roll.total - cool - rep;   // the 1d10 (incl. any 10-explosion) portion
  return { name: actor.name, die, cool, rep, total: roll.total };
}

/**
 * Facedown (CP2020 p.54): roll 1d10 + COOL + Reputation. With exactly one OTHER token targeted this is a
 * CONTESTED roll — both sides roll, the card names the winner and posts the −3-vs-that-foe reminder (the
 * GM enforces it). With no/ambiguous target it just posts this actor's Facedown total.
 */
async function moduleRollFacedown(actor) {
  const mkRoll = (a) => makeD10Roll(["@stats.cool.total", "@reputation"], a.system).evaluate();

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
async function moduleRollRecognition(actor) {
  const rep = Number(actor.system?.reputation) || 0;
  const roll = await new Roll("1d10").evaluate();
  const recognized = roll.total <= rep;
  const content = await renderChatCard("recognition.hbs", {
    recognized, name: actor.name, roll: roll.total, rep,
  });
  await createCyberpunkRollCard({ rolls: [roll], speaker: ChatMessage.getSpeaker({ actor }), content });
}

/** Prefer the host system's own actor method when present; else use the module port. */
export function rollFacedown(actor) {
  return (typeof actor?.rollFacedown === "function") ? actor.rollFacedown() : moduleRollFacedown(actor);
}

/** Prefer the host system's own actor method when present; else use the module port. */
export function rollRecognition(actor) {
  return (typeof actor?.rollRecognition === "function") ? actor.rollRecognition() : moduleRollRecognition(actor);
}
