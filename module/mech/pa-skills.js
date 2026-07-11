/**
 * PA (Powered Armor) skills — auto-populate on pilot-link (Maximum Metal).
 *
 * When a character is linked as an ACPA suit's pilot, the pilot should carry the three powered-armor
 * skills at natural level 0: PA Combat Sense (the PA Trooper's special ability, read later by the ACPA
 * initiative code), PA Tech, and Expert (PA Design). This engine backfills any the pilot lacks straight
 * from the module's skills compendium — the SINGLE source of truth for that data (never hardcoded here).
 *
 * The created skills are made with { keepId: true } so each keeps its stable compendium `_id`; that is
 * what lets isPACombatSenseSkill (utils.js) match PA Combat Sense by `_id` later, independent of name.
 *
 * Ownership: an embedded skill is the pilot's own actor data, so — like the chip-grant engine — only the
 * INITIATING client that OWNS the pilot performs the writes (no GM relay, no socket). Idempotent: a skill
 * the pilot already has (by `_id` or a compendium sourceId ending in that id) is never re-created, so
 * re-linking the same or another pilot can't duplicate.
 *
 * Self-contained: the isACPA/pilotId fields it reads are declared on the vehicle actor DataModel
 * (module/data/vehicle-actor-data.js); this engine only reads them off the live actor.
 */

import { mechDocumentAutomationEnabled } from "../settings.js";

const SCOPE = "cp2020-augmented";

// The module sub-type id for the ACPA/vehicle actor (Foundry prefixes the manifest's bare key).
const VEHICLE_ACTOR = `${SCOPE}.vehicle`;
// Single source of truth for the skill data — the module's skills compendium (NOT hardcoded here).
const PA_SKILLS_PACK = `${SCOPE}.supplement-skills`;
// The three PA skills' stable compendium _ids. Order = create order; all three are backfilled together.
const PA_SKILL_IDS = ["PACombatSense001", "PATechSkill00001", "ExpertPADesign01"];

/** True when the actor already owns the skill with this stable compendium id — matched by the item's
 *  own `_id` OR a `flags.core.sourceId` ending in the id (a drag-imported copy keeps sourceId, not the
 *  id). Keyed on the id, never the name. Pure. */
function actorHasPaSkill(items, id) {
  return (items ?? []).some((it) => {
    if (it?.type !== "skill") return false;
    if (it._id === id) return true;
    const src = it?.flags?.core?.sourceId;
    return typeof src === "string" && src.endsWith(id);
  });
}

/**
 * Ensure `actor` carries the three PA skills at level 0, creating any it lacks from the compendium.
 * Idempotent and self-contained: fetches each missing skill's data from PA_SKILLS_PACK, and creates the
 * whole missing set in ONE createEmbeddedDocuments call with { keepId: true } so the compendium `_id`s
 * survive (required for later `_id`-keyed identity checks). Never throws — logs a warning on failure.
 */
export async function backfillPaSkills(actor) {
  if (!actor) return;
  try {
    const items = actor.items?.contents ?? actor.items ?? [];
    const missing = PA_SKILL_IDS.filter((id) => !actorHasPaSkill(items, id));
    if (!missing.length) return;                     // idempotent: nothing to add

    const pack = game.packs?.get(PA_SKILLS_PACK);
    if (!pack) {
      console.warn(`${SCOPE} | PA-skill backfill: compendium "${PA_SKILLS_PACK}" not found`);
      return;
    }

    const toCreate = [];
    for (const id of missing) {
      const doc = await pack.getDocument(id);        // compendium = single source of truth
      if (!doc) {
        console.warn(`${SCOPE} | PA-skill backfill: skill "${id}" not in "${PA_SKILLS_PACK}"`);
        continue;
      }
      toCreate.push(doc.toObject());
    }
    if (toCreate.length) {
      // keepId:true → the created skills keep their compendium _ids (so isPACombatSenseSkill matches
      // by _id later). Batched into a single create call.
      await actor.createEmbeddedDocuments("Item", toCreate, { keepId: true });
    }
  } catch (e) {
    console.warn(`${SCOPE} | PA-skill backfill failed`, e);
  }
}

/**
 * Register the pilot-link trigger: when an ACPA suit's pilot is (re)assigned, backfill the new pilot's
 * PA skills. Fires only for the four guarded conditions (each a correctness trap):
 *   (a) the updated actor is a cp2020-augmented.vehicle that IS an ACPA suit;
 *   (b) the update actually set system.pilotId to a non-empty value (a link, not an unlink);
 *   (c) this client is the one that made the change (userId === game.user.id) — no duplicate creates
 *       from every connected client;
 *   (d) the newly-linked pilot actor exists and this client OWNS it (else it can't create items — skip).
 */
export function registerPaSkillBackfill() {
  Hooks.on("updateActor", (actor, changes, options, userId) => {
    // (a) an ACPA suit
    if (actor?.type !== VEHICLE_ACTOR || !actor.system?.isACPA) return;
    // Document automation (auto-creating skill items) — respect the same master toggle chip-grant /
    // borg loadout use, so a table that turns document automation off gets no auto-created PA skills.
    if (!mechDocumentAutomationEnabled()) return;
    // (b) the pilot link changed to a non-empty pilot (unlinking sets "" → falsy → skip)
    const pilotId = changes?.system?.pilotId;
    if (!pilotId) return;
    // (c) only the initiating client runs, so N clients don't each create the skills
    if (userId !== game.user?.id) return;
    // (d) the linked pilot exists and this client can write to it
    const pilot = game.actors?.get(pilotId);
    if (!pilot?.isOwner) return;
    // Fire-and-forget: backfillPaSkills is self-contained + swallows its own errors (never throws out
    // of the hook). Guard the call site too, so a synchronous slip can't escape the hook either.
    try {
      backfillPaSkills(pilot);
    } catch (e) {
      console.warn(`${SCOPE} | PA-skill backfill hook failed`, e);
    }
  });
}
