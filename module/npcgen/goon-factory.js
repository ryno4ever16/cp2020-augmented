/**
 * GOON FACTORY — THE IMPURE HALF (GOON-FACTORY-SPEC.md §2 steps 3, 5, 6 and 8).
 *
 * This is the ONLY Goon Factory file that touches documents. `blueprint.js` plans a goon as plain
 * data and `chrome.js` / `armor.js` plan its hardware; this resolves those plans against the real
 * packs and writes real Actors. The split is the same one `materialize.js` already draws for the
 * pre-rebuild engine, and it is what makes the preview and the create the same object: both call
 * `planGoonSquad`, and Confirm just hands the result to `materializeGoonSquad`.
 *
 * ⭐ THREE THINGS A MAINTAINER MUST NOT MISS, all of them rig-proven hazards elsewhere in this repo:
 *
 *  1. **We never create skill items.** The base `CyberpunkActor._preCreate` already grants the whole
 *     default skill set to every new `npc`, so the generator's skill job is to UPDATE LEVELS. That
 *     is `materialize.js`'s `applySkillLevels`, reused here verbatim rather than re-implemented.
 *
 *  2. **Every pack copy goes through `game.items.fromCompendium`**, because that helper keeps
 *     `_stats.compendiumSource` and that stamp is the ONLY thing that makes the corrections layer
 *     fire. It is load-bearing here beyond data hygiene: the optics' `mechVision` block — the thing
 *     §2.8's token vision reads — is applied BY that corrections layer at create time. A copy made
 *     with a bare `toObject()` produces a goon with a blind cybereye.
 *
 *  3. **`system.stats` is an ObjectField, so every stat write is WHOLE-OBJECT.** A dotted
 *     `system.stats.emp.base` does not merge — it replaces the object and the schema refills the
 *     siblings from defaults, silently resetting REF and BT. That is exactly the §4 requirement
 *     "manual/reduced EMP survives actor prep", and `statsPayload` (materialize.js) is the one
 *     helper both materializers use for it.
 */

import { localize, tryLocalize } from "../utils.js";
import { getCalibers, getCaliberBox, modifiersForCaliber } from "../lookups.js";
import { ammoModifierSystemFields } from "../shop/buy-ammo.js";
import { checkInstall } from "../mech/container.js";
import { MODE_TABLE, desiredVisionFor, resolveVisionMode } from "../mech/vision.js";
import { WEAPONS_DIAL_BY_RUNG } from "./tables.js";
import { loadCatalogDoc, npcGenCatalogRows, skillNameIndex, applySkillLevels } from "./materialize.js";
import {
  allocateGoonSkills, goonBlueprint, nextGoonNumber, seedFrom, seededRng,
} from "./blueprint.js";
import { GRADE_KEYS, gradeOf, lootProfileFor } from "./grades.js";
import { CHROME_SLOTS, HOUSING_SPACES } from "./slots.js";
import { newSquadLedger, planChrome } from "./chrome.js";
import { ARMOR_BANDS, armorWeightClamp, bookHardness, composeArmorStack } from "./armor.js";

const SCOPE = "cp2020-augmented";

/** §1's cap, restated at the write edge so a console call meets the same limit the form does. */
export const GOON_MAX_COUNT = 12;

// =================================================================================================
// THE GOON LOCKER (§1 "Generate button (fused destination)")
// =================================================================================================

/**
 * ⭐ THE FOLDER IS TRACKED BY A MODULE FLAG, NOT BY ITS NAME, and that is the whole point of §1's
 * *"tracked by a module FLAG on the folder (rename-proof), re-created only if missing"*. The
 * pre-rebuild engine finds its folder by name (`ensureNpcGenFolder`), which means a GM who renames
 * it gets a second folder on the next generate. This one survives a rename, a re-localization, and
 * a language change, because none of those touch the flag.
 */
export const GOON_LOCKER_FLAG = "goonLocker";

/** The localized folder NAME used only when one is CREATED. After that the flag is the identity. */
export function goonLockerName() {
  return tryLocalize("GoonFactory.Locker", "Goon Locker");
}

/** Find the flagged locker, or null. Never falls back to a name match — that is the bug this fixes. */
export function findGoonLocker() {
  return game.folders?.find((f) => f.type === "Actor" && f.getFlag?.(SCOPE, GOON_LOCKER_FLAG)) ?? null;
}

/** Find-or-create the Goon Locker. Lazily created on the FIRST generate, never before. */
export async function ensureGoonLocker() {
  const existing = findGoonLocker();
  if (existing) return existing;
  return Folder.create({ type: "Actor", name: goonLockerName(), flags: { [SCOPE]: { [GOON_LOCKER_FLAG]: true } } });
}

/**
 * Resolve the Generate button's destination.
 *
 * §1's picker offers: the Goon Locker (default) · an existing folder · the root · a new subfolder
 * auto-named per generation (*"the cleanup opt-in"*). The auto-name is the ONE place a name is
 * generated, and it is a timestamp under the locker rather than anything clever — a GM who wants
 * this wants to be able to delete one batch, and a sortable name is what makes that easy.
 *
 * ⛔ AN EMPTY DESTINATION IS NEVER A GRAY BUTTON (§1, emphatic: *"no mysterious gray-out, ever"*).
 * This returns `{folder: null, instruct: true}` and the window turns the button label into the
 * instruction instead of disabling it.
 */
export async function resolveGoonDestination(spec = {}) {
  const mode = String(spec.mode ?? "locker");
  if (mode === "root") return { folder: null, instruct: false, root: true };
  if (mode === "existing") {
    const f = game.folders?.get(spec.folderId);
    if (!f) return { folder: null, instruct: true, root: false };
    return { folder: f, instruct: false, root: false };
  }
  if (mode === "new") {
    const parent = await ensureGoonLocker();
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
    const name = String(spec.newName ?? "").trim() || `${goonLockerName()} ${stamp}`;
    const f = await Folder.create({ type: "Actor", name, folder: parent?.id ?? null });
    return { folder: f, instruct: false, root: false };
  }
  return { folder: await ensureGoonLocker(), instruct: false, root: false };
}

/** The actor names already in a destination — what §2.7's numbering continuation scans. */
export function namesInDestination(folder) {
  if (!folder) return (game.actors?.filter?.((a) => !a.folder) ?? []).map((a) => a.name);
  return (game.actors?.filter?.((a) => a.folder?.id === folder.id) ?? []).map((a) => a.name);
}

// =================================================================================================
// RESOLVING THE CRITERIA POOLS AGAINST THE REAL PACKS
// =================================================================================================

/**
 * ⚠ WHY THESE INDEXES EXIST AT ALL. The shop's catalog index carries `{name, cost, category, sub,
 * key}` and nothing else — no humanity cost, no option spaces, no armor SP, no EV. The Goon Factory
 * needs all four: §1's preview must print a humanity TRUTH-LINE and an effective SP/EV, and §3's
 * engine rule 1 spends real option spaces.
 *
 * Loading a document per item per goon would mean hundreds of pack reads behind a preview. So each
 * index loads the documents for exactly the NAMES the criteria tables can ever draw — a bounded set
 * (~90 chrome entries, ~25 armor entries) — ONCE per session. The cache is cleared with the catalog's.
 */
let _chromeIndex = null;
let _armorIndex = null;
export function clearGoonIndexCache() { _chromeIndex = null; _armorIndex = null; }

/** Every item name any chrome slot can reach: allow lists + housings + their extras + prerequisites. */
export function chromeIndexNames() {
  const names = new Set();
  for (const slot of CHROME_SLOTS) {
    for (const n of slot.allow ?? []) names.add(n);
    if (slot.housing?.name) names.add(slot.housing.name);
    for (const n of slot.housing?.extras ?? []) names.add(n);
    for (const p of slot.prerequisites ?? []) {
      for (const n of (p.anyOf ?? [p.name])) if (n) names.add(n);
    }
  }
  return [...names];
}

/**
 * Build the chrome pool: catalog rows enriched with the fields the engine actually reasons about.
 *
 * `humanityLoss` is the system's own NUMERIC field, not the `humanityCost` dice string — a generator
 * must not invent a roll the GM never saw, and the numeric field is what an installed implant costs.
 * (CHROME-COMB-77.md DATA FLAG 2/3/4 records that some module items carry a blank, `"UNKNOWN"`, or
 * a relative `"+1D6/2"` there; `Number(...) || 0` absorbs all three, and a zero contribution is
 * visible in the preview's humanity line rather than hidden.)
 */
export async function getGoonChromePool() {
  if (_chromeIndex) return _chromeIndex;
  const rows = await npcGenCatalogRows();
  const wanted = new Set(chromeIndexNames());
  const hits = rows.filter((r) => r.category === "Cyberware" && wanted.has(r.name));
  const out = [];
  for (const r of hits) {
    const doc = await loadCatalogDoc(r.key);
    out.push({
      key: r.key, name: r.name, category: r.category, sub: r.sub, cost: Number(r.cost) || 0,
      humanityLoss: Number(doc?.system?.humanityLoss) || 0,
      spaces: Number(doc?.system?.CyberWorkType?.OptionsAvailable) || Number(HOUSING_SPACES[r.name]) || 0,
      slotsTaken: Number(doc?.system?.Module?.SlotsTaken) || 0,
    });
  }
  _chromeIndex = out;
  return out;
}

/**
 * Build the armor pool for a band: real SP, EV, hardness and coverage.
 *
 * SP is the item's HIGHEST per-location stopping power, which is the number the band pools are
 * written against and the number a preview means by "SP 25". Hardness prefers the item's own
 * `armorType` and falls back to the BOOK's printed table (armor.js `bookHardness`) rather than to
 * the module's shipped heuristic — the book and the heuristic disagree on four items (flak vest,
 * flak pants, and both helmets) and the book wins.
 */
export async function getGoonArmorPool() {
  if (_armorIndex) return _armorIndex;
  const rows = await npcGenCatalogRows();
  const wanted = new Set(Object.values(ARMOR_BANDS).flatMap((b) => b.pool ?? []));
  const out = [];
  for (const r of rows.filter((x) => x.category === "Armor")) {
    // Pack naming drifts ("Flack Vest" vs "Flak Vest"); match on a normalized token so a band pool
    // written from the book still finds the shipped item.
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (![...wanted].some((w) => norm(w) === norm(r.name))) continue;
    const doc = await loadCatalogDoc(r.key);
    if (!doc) continue;
    const coverage = doc.system?.coverage ?? {};
    const sp = Math.max(0, ...Object.values(coverage).map((c) => Number(c?.stoppingPower) || 0));
    const covered = Object.entries(coverage).filter(([, c]) => (Number(c?.stoppingPower) || 0) > 0).map(([k]) => k);
    out.push({
      key: r.key, name: r.name, cost: Number(r.cost) || 0, sp,
      ev: Number(doc.system?.encumbrance) || 0,
      hardness: doc.system?.armorType === "hard" || doc.system?.armorType === "soft"
        ? doc.system.armorType : (bookHardness(r.name) ?? "soft"),
      // The one-head-armor rule needs to know a head piece when it sees one: an item that covers
      // ONLY the head is headgear, whatever it is called.
      location: covered.length === 1 && /head/i.test(covered[0]) ? "head" : null,
      coverage: covered,
    });
  }
  _armorIndex = out;
  return out;
}

// =================================================================================================
// §2.3 — GEAR
// =================================================================================================

/**
 * §1's armament posture biases the AMMO LOAD, *"honest when a caliber lacks the load"*.
 *
 * ⚑ GAP, REPORTED RATHER THAN INVENTED: the ammo registry (`lookups.js` AMMO_MODIFIERS) ships
 * standard, AP, hollow-point, API, dual-purpose, rubber, flechette, safety, brass-cased and the D4
 * arrow/shotgun loads — and **no CHEMICAL load exists anywhere in it**. So the Chemical posture has
 * nothing to resolve to today: it falls back to Standard and says so on the goon's honesty line,
 * which is exactly the behaviour §1 asks for when a caliber lacks the posture's load. Wiring a real
 * chemical load is a registry entry and one line here.
 */
export const POSTURE_LOADS = { standard: ["standard"], ap: ["ap", "api"], chemical: [] };

/**
 * Resolve the ammo modifier a posture wants for a caliber, with the honest fallback.
 *
 * `modifiersForCaliber` is the authority on which loads a caliber's FAMILY can take (an arrow
 * caliber cannot take AP), so the posture's preferences are filtered through it rather than assumed.
 * `satisfied: false` is what drives §1's *"honest when a caliber lacks the load"* preview line.
 */
export function loadForPosture(posture, caliberId) {
  const wanted = POSTURE_LOADS[String(posture ?? "standard")] ?? POSTURE_LOADS.standard;
  if (!wanted.length) return { modifier: "standard", satisfied: false, wanted: posture };
  let allowed = null;
  try { allowed = new Set(modifiersForCaliber(caliberId).map(([id]) => id)); } catch (e) { allowed = null; }
  const hit = wanted.find((id) => !allowed || allowed.has(id));
  if (!hit) return { modifier: "standard", satisfied: false, wanted: posture };
  return { modifier: hit, satisfied: true, wanted: posture };
}

/**
 * PICK THE PRIMARY WEAPON for a goon (§2.3: *"weapons pull (grade rung pool, posture-biased loads)"*).
 *
 * ⚑ NO BUDGET, DELIBERATELY. The pre-rebuild engine gave each tier a `loadoutBudgetEb`; the Goon
 * Factory's grades do not carry one and the spec does not ask for one — the GRADE'S WEAPONS RUNG is
 * the constraint, and it is the book's own p.40 axis. Adding a budget back would be inventing a
 * dial the design deliberately does not have.
 */
export function pickPrimaryWeapon(rows, weaponsRung, rng) {
  const dial = WEAPONS_DIAL_BY_RUNG[weaponsRung] ?? WEAPONS_DIAL_BY_RUNG[5];
  const cats = dial?.shop ?? [];
  const pool = rows.filter((r) => cats.some((c) => r.category === c.category && (!c.sub || r.sub === c.sub)));
  if (!pool.length) return null;
  return pool[Math.min(Math.floor((Number(rng()) || 0) * pool.length), pool.length - 1)];
}

// =================================================================================================
// §2 — THE WHOLE PLAN FOR ONE SQUAD (what the preview shows and what Confirm writes)
// =================================================================================================

/**
 * PLAN N GOONS AGAINST THE REAL PACKS — steps 3, 4 (re-run), 5 and 6 of §2, in the spec's order.
 *
 * ⭐ THE ORDER IS LOAD-BEARING AND IT IS THE SPEC'S. Gear comes BEFORE skills, because §2.4's
 * guarantee attaches to *"the governing skill of the ACTUALLY-PULLED primary weapon"* — a skill
 * allocation run before the gun is drawn would pin the guarantee to a weapon the goon does not
 * carry. `blueprint.js` produces a provisional allocation so a plan is complete on its own; this
 * re-runs it with the real weapon in hand and replaces it.
 *
 * Returns one row per goon, each carrying its honesty lines — §1's preview list, produced by the
 * PLAN so the preview cannot disagree with the create.
 */
export async function planGoonSquad(opts = {}) {
  const rows = await npcGenCatalogRows();
  const chromePool = await getGoonChromePool();
  const armorPool = await getGoonArmorPool();
  const existingNames = namesInDestination(opts.destinationFolder ?? null);

  const probe = goonBlueprint({ ...opts, count: 1 });
  const prefix = probe[0]?.namePrefix ?? "Goon";
  const gradeKey = probe[0]?.grade ?? opts.grade;
  const start = nextGoonNumber(existingNames, prefix, gradeKey);

  const blueprints = goonBlueprint({ ...opts, startNumber: start });
  const squadLedger = newSquadLedger();          // §3's batch-wide bonus `squadLimit` lives here
  const out = [];

  for (const bp of blueprints) {
    const cfg = bp.config;
    const rng = seededRng(seedFrom(bp.seed, "gear"));
    const honesty = [...bp.honesty];

    // ── 3a. WEAPON ────────────────────────────────────────────────────────────────────────────────
    const weaponRow = pickPrimaryWeapon(rows, cfg.weaponsRung, rng);
    const weaponDoc = weaponRow ? await loadCatalogDoc(weaponRow.key) : null;
    const weapon = weaponDoc ? {
      key: weaponRow.key, name: weaponDoc.name,
      attackSkill: weaponDoc.system?.attackSkill ?? "",
      weaponType: weaponDoc.system?.weaponType ?? "",
      ammoType: weaponDoc.system?.ammoType ?? "",
      shots: Math.max(0, Math.trunc(Number(weaponDoc.system?.shots) || 0)),
    } : null;
    if (!weapon) honesty.push({ code: "noWeaponAvailable", messageKey: "GoonFactory.Honesty.NoWeapon" });

    // ── 3b. AMMO LOAD, posture-biased and honest when the posture cannot be met ───────────────────
    const load = loadForPosture(cfg.armament, weapon?.ammoType);
    if (weapon?.ammoType && !load.satisfied) {
      honesty.push({
        code: "postureLoadMissing", posture: cfg.armament, caliber: weapon.ammoType,
        messageKey: "GoonFactory.Honesty.PostureLoadMissing",
      });
    }

    // ── 3c. ARMOR ────────────────────────────────────────────────────────────────────────────────
    const band = ARMOR_BANDS[gradeKey] ?? ARMOR_BANDS.E;
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
    const bandNames = new Set((band.pool ?? []).map(norm));
    const candidates = armorPool.filter((a) => bandNames.has(norm(a.name)));

    // ── 5. CHROME (before the armor fold, because dermal chrome IS an armor layer) ────────────────
    const chromeRng = seededRng(seedFrom(bp.seed, "chrome"));
    const chrome = cfg.chromeOn
      ? planChrome({
        pool: chromePool, gradeKey, count: cfg.chromeCount, rng: chromeRng, bt: cfg.bt,
        garnish: cfg.garnish, primaryWeapon: weapon, intStat: bp.stats.int,
        knownSkills: (bp.skillLevels ?? []).map((s) => s.skillKey),
        bonusPools: cfg.bonusPools, squadLedger, outfitTags: cfg.outfitTags, goonName: bp.name,
      })
      : { items: [], pulls: [], lint: [], honesty: [], bonusItems: [], statDebits: { attr: 0 },
        needsAmmo: [], humanityLoss: 0, spaces: {}, nothingCount: 0, combatPullCount: 0 };

    // Dermal chrome enters the armor composer as layers — skinweave free, subdermal/plating counted.
    const chromeLayers = chrome.items
      .filter((it) => /skinweave|subdermal|torso plate|faceplate|cowl/i.test(it.name))
      .map((it) => ({
        name: it.name,
        sp: Number(String(it.name).match(/SP\s*(\d+)/i)?.[1]) || (/subdermal/i.test(it.name) ? 18 : 25),
        kind: /skinweave/i.test(it.name) ? "skinweave" : "subdermal",
      }));

    const armor = composeArmorStack({
      gradeKey, candidates, chromeLayers,
      filters: { hardness: cfg.armorHardness, weight: cfg.armorWeight },
    });
    honesty.push(...armor.honesty);
    honesty.push(...(chrome.honesty ?? []));

    const clamp = armorWeightClamp(gradeKey, cfg.armorWeight);
    if (clamp.clamped && !armor.honesty.some((h) => h.code === clamp.code)) {
      honesty.push({ code: clamp.code, messageKey: "GoonFactory.Honesty.ArmorWeightClamp", band: gradeKey });
    }

    // ── 4. SKILLS, RE-RUN WITH THE WEAPON THAT WAS ACTUALLY PULLED ────────────────────────────────
    // ⛔ `bp.role`, NOT `cfg.role`. Under a Random role the config holds the SENTINEL and the goon
    // holds the role it rolled; re-running the allocation off the config would hand every goon in
    // the batch the same silent `?? CAREER_PACKAGES.solo` fallback and quietly undo the draw.
    const skills = allocateGoonSkills({
      total: cfg.skillPoints, gradeKey, role: bp.role,
      primaryWeapon: weapon, rng: seededRng(seedFrom(bp.seed, "skills")), skillBias: cfg.skillBias,
    });

    // ── The honesty lines §1 lists, computed from the plan that produced them ─────────────────────
    const guaranteed = skills.skillLevels.find((s) => s.skillKey === skills.guarantee.skillKey)?.level ?? 0;
    const rawRoll = bp.stats.ref + guaranteed;
    honesty.push({
      code: "effectiveSkillRoll", messageKey: "GoonFactory.Honesty.EffectiveRoll",
      skill: skills.guarantee.skillKey, raw: rawRoll, ev: armor.effectiveEV,
      effective: rawRoll - armor.effectiveEV,
    });

    // §2.5: HUMANITY MATH ALWAYS RUNS — no gate, no checkbox, and the truth-line always prints.
    const baseEmp = bp.stats.emp;
    const humanity = baseEmp * 10 - chrome.humanityLoss;
    const emp = Math.floor(humanity / 10);
    honesty.push({
      code: emp <= 0 ? "cyberpsycho" : "humanityTruth",
      messageKey: emp <= 0 ? "GoonFactory.Honesty.Cyberpsycho" : "GoonFactory.Honesty.HumanityTruth",
      hc: chrome.humanityLoss, from: baseEmp, to: emp,
    });

    for (const l of chrome.lint) {
      honesty.push({ code: l.code, slotId: l.slotId ?? null, messageKey: `CYBERPUNK.GoonFactory.Lint.${l.code}` });
    }
    for (const n of chrome.needsAmmo) {
      honesty.push({ code: "launcherNeedsAmmo", name: n.name, caseless: n.caseless, messageKey: "GoonFactory.Honesty.LauncherNeedsAmmo" });
    }

    // ── 6. LOOT ──────────────────────────────────────────────────────────────────────────────────
    const loot = lootProfileFor(cfg.loot, gradeKey);

    out.push({
      bp,
      weapon, weaponRow, ammoModifier: load.modifier,
      armor, chrome, skills, loot,
      stats: { ...bp.stats, emp },
      humanity, emp, humanityLoss: chrome.humanityLoss,
      attrDebit: chrome.statDebits.attr,
      honesty,
    });
  }
  return out;
}

// =================================================================================================
// §2.8 — MATERIALIZE
// =================================================================================================

/** The nine stats as the schema wants them — WHOLE OBJECT, always. See the file header, point 3. */
function statsPayload(stats, overrides = {}) {
  const merged = { ...stats, ...overrides };
  return Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, { base: Math.trunc(Number(v) || 0), tempMod: 0 }]));
}

/** The default face — the base system's own edgerunner, the honest "a person" silhouette. */
const GOON_DEFAULT_IMG = "systems/cyberpunk2020/img/edgerunner.svg";

/**
 * §2.8's prototype token. Disposition is hostile by default, PREFILLED by an outfit, and settable by
 * the GM from the window's top band (ruled 2026-08-15) — `resolveGoonConfig` resolves those three
 * rungs into one value and this is where that value becomes a real token field. The `friendly`
 * mapping stays for a direct caller even though the control offers only hostile/neutral.
 *
 * ⛔ `actorLink` IS DELIBERATELY ABSENT. The base system gives `npc` no actorLink on purpose, which
 * is what makes every goon's tokens take their own hits — exactly what a squad wants. Writing
 * `false` here would be re-deciding something the system already decided the same way, and would
 * fight a GM who linked one on purpose.
 */
function goonPrototypeToken(disposition, img) {
  const d = String(disposition ?? "hostile").toLowerCase();
  const map = {
    hostile: CONST.TOKEN_DISPOSITIONS.HOSTILE,
    neutral: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
    friendly: CONST.TOKEN_DISPOSITIONS.FRIENDLY,
  };
  return {
    disposition: map[d] ?? CONST.TOKEN_DISPOSITIONS.HOSTILE,
    displayName: CONST.TOKEN_DISPLAY_MODES.NONE,
    texture: { src: img || GOON_DEFAULT_IMG },
  };
}

/**
 * §2.8 + §4: **token VISION configured from chrome optics, on the UNLINKED PROTOTYPE token.**
 *
 * ⚠ WHY THIS IS NOT JUST `applyActorVision(actor)`. That helper is the live path and it writes
 * TOKENS — `tokensOf()` resolves linked dependents or active placeables, and a freshly generated
 * goon has neither: it is an unlinked actor with no token on any scene. The vision would therefore
 * land on nothing, and the first token a GM drags out would be blind despite the cybereye. So the
 * prototype token is written directly here, using the SAME decision functions the live path uses
 * (`desiredVisionFor` / `resolveVisionMode` / `MODE_TABLE`), so a goon's dragged-out token and a
 * hand-built character's token resolve identically.
 *
 * The optic's `mechVision` block is applied by the corrections layer at create time, which is why
 * point 2 of the file header matters here specifically.
 */
export function goonPrototypeSight(items) {
  // The live path only counts a device that is switched ON. A generated goon's chrome is installed
  // and working, so the optic is treated as on for the decision — which is what "the implant is in
  // their head and functioning" means.
  const candidates = (items ?? [])
    .filter((it) => it.type === "cyberware" && it.system?.mechVision?.enabled)
    .map((it) => ({ ...it, system: { ...it.system, equipped: true, mechVision: { ...it.system.mechVision, on: true } } }));
  const desired = desiredVisionFor(candidates, "");
  if (!desired) return null;
  const patch = {
    "sight.enabled": true,
    "sight.visionMode": resolveVisionMode(desired.mode),
    "sight.range": MODE_TABLE[desired.mode]?.terrainSight === false ? 0 : desired.range,
  };
  return { patch, mode: desired.mode, range: desired.range, heat: !!MODE_TABLE[desired.mode]?.heat };
}

/**
 * The CREDCHIP — §1's loot dial: *"cash as the CREDCHIP gear item (new module item; value field;
 * lootable/draggable; GM edits/deletes)"*.
 *
 * ⚑ DEVIATION, RECORDED: the spec calls it a new module ITEM, which would normally mean a new pack
 * entry. Adding one would require a pack source edit plus a compendium recompile — a build-artifact
 * change well outside this unit, and one that would put a half-curated item into a shipped pack. So
 * the credchip is SYNTHESIZED at materialize time as a `misc` document instead: it is a real,
 * lootable, draggable item on the goon with its value in `system.cost` (the schema's own value
 * field) and a module flag marking it, and the GM can edit or delete it exactly as the spec asks.
 * Promoting it to a pack entry later changes this one function and nothing else.
 */
export function credchipItemData(valueEb) {
  return {
    name: localize("GoonFactory.Credchip"),
    type: "misc",
    img: "modules/cp2020-augmented/img/weapon-icon.svg",
    system: {
      cost: Math.max(0, Math.round(Number(valueEb) || 0)),
      weight: 0, equipped: false,
      notes: localize("GoonFactory.CredchipNote"),
    },
    flags: { [SCOPE]: { credchip: { valueEb: Math.max(0, Math.round(Number(valueEb) || 0)) } } },
  };
}

/**
 * ⭐ THE OUTFIT'S FLAVOUR, GM-SIDE ONLY (OUTFIT-CATALOGUE-PREP.md §B.3, ruled 2026-08-14).
 *
 * The outfit carries jurisdiction, reinforcement and a flavour note as KEYS (blueprint.js is pure and
 * may hold no localized text); this is where they become sentences and where they land.
 *
 * ⛔ THEY LAND IN EXACTLY ONE PLACE: `system.notes` — the actor's own biography/notes region, which
 * is the base system's `htmlField` and the only description surface an actor has. §B.3's condition
 * is verbatim *"they land in the actor's GM-side description/notes — players never see an unowned
 * NPC's sheet — and never in token tooltips, chat cards, or any player-visible surface"*, and that
 * is why this returns HTML for one document field and nothing else:
 *   · the generated actor is created with NO ownership grant, so its default ownership is NONE and
 *     no player can open the sheet the text sits on;
 *   · the prototype token's `displayName` is NONE, so no tooltip carries anything at all — and no
 *     token field is written from this text in any case;
 *   · the Goon Factory posts NO chat card (the pre-rebuild engine's summary card is a different
 *     materializer and reads none of these fields);
 *   · the preview cards in the window are built from the PLAN's honesty lines, which this is not.
 * A future surface that wants to show a goon's description must decide its own audience question;
 * nothing here leaks into one by default.
 *
 * Returns "" when the outfit states no flavour, so the field is left completely alone rather than
 * being stamped with an empty heading.
 */
export function goonGmNotes(flavor) {
  const keys = [flavor?.jurisdictionKey, flavor?.reinforcementKey, flavor?.noteKey].filter(Boolean);
  const lines = keys.map((k) => tryLocalize(k, "")).filter((s) => String(s).trim().length > 0);
  if (!lines.length) return "";
  const heading = localize("GoonFactory.GmNotes");
  return `<p><strong>${heading}</strong></p>\n${lines.map((l) => `<p>${l}</p>`).join("\n")}`;
}

/** A magazine for a weapon, built from the shop's OWN ammo engine so it matches a bought box. */
function ammoItemDataFor(weaponDoc, modifierId) {
  const caliber = String(weaponDoc?.system?.ammoType ?? "").trim();
  if (!caliber) return null;
  const shots = Math.max(0, Math.trunc(Number(weaponDoc.system?.shots) || 0));
  if (shots <= 0) return null;
  const calLabel = getCalibers()[caliber]?.label ?? caliber;
  return {
    name: `${calLabel} ${modifierId === "standard" ? "Standard" : modifierId}`,
    type: "ammo",
    img: "modules/cp2020-augmented/img/weapon-icon.svg",
    system: foundry.utils.mergeObject(
      { caliber, ammoType: caliber, quantity: shots, boxSize: Number(getCaliberBox(caliber).box) || 1, equipped: true },
      ammoModifierSystemFields(modifierId),
      { inplace: false },
    ),
  };
}

/**
 * ONE planned goon → one Actor, fully stocked, chromed and installed.
 *
 * The order is not arbitrary and each step needs the one before it:
 *   1. `Actor.create` — the base `_preCreate` grants 103 skills + Kick/Strike right here.
 *   2. skill LEVELS onto those granted items (never creating a skill that already exists).
 *   3. the gear + the chrome, in ONE create call, each stamped with a unique token.
 *   4. the compound INSTALL: options into their housing, resolved by token, never by index or name.
 *   5. the stat write — LAST, whole-object, carrying the chrome-derived EMP and any ATTR debit.
 *   6. the prototype token's sight, from the optics that actually landed.
 */
export async function materializeGoon(row, { folder, nameByKey }) {
  const { bp, weapon, weaponRow, ammoModifier, armor, chrome, skills, loot } = row;
  const cfg = bp.config;

  // §B.3: the outfit's jurisdiction / reinforcement / flavour note, GM-side only. Empty string when
  // the outfit states none, and the field is then not written at all.
  const gmNotes = goonGmNotes(cfg.flavor);

  const actor = await Actor.create({
    name: bp.name,
    type: "npc",
    img: GOON_DEFAULT_IMG,
    folder: folder?.id ?? null,
    prototypeToken: goonPrototypeToken(cfg.disposition, GOON_DEFAULT_IMG),
    // ⛔ THE ROLE WRITTEN HERE IS `bp.role` — the one this goon RESOLVED to. `cfg.role` may hold the
    // "random" sentinel, which is not in the schema's role enum and must never reach a document.
    // `roleRolled` records that the batch was set to Random, so a GM reading the flag later can tell
    // a drawn Cop from a picked one.
    flags: { [SCOPE]: { goonFactory: {
      grade: bp.grade, role: bp.role, roleRolled: !!bp.roleRolled,
      outfitId: cfg.outfitId, basedOn: cfg.basedOn,
      custom: !!cfg.custom, seed: bp.seed, rootSeed: bp.plan?.rootSeed ?? null,
      index: bp.plan?.index ?? 0, statShape: cfg.statShape,
      version: game.modules.get(SCOPE)?.version ?? "",
    } } },
    system: {
      role: { value: bp.role },
      stats: statsPayload(bp.stats),
      reputation: bp.reputation,
      ...(gmNotes ? { notes: gmNotes } : {}),
    },
  });
  if (!actor) return null;

  const skillResult = await applySkillLevels(actor, { skillLevels: skills.skillLevels }, nameByKey);

  // ── ITEMS ─────────────────────────────────────────────────────────────────────────────────────
  const toCreate = [];
  const stamp = (data, token) => {
    data.flags = data.flags ?? {};
    data.flags[SCOPE] = { ...(data.flags[SCOPE] ?? {}), goonToken: token };
    return data;
  };
  let seq = 0;
  const missing = [];
  let weaponToken = null;
  let ammoToken = null;

  if (weaponRow) {
    const doc = await loadCatalogDoc(weaponRow.key);
    if (doc) {
      const data = game.items.fromCompendium(doc);
      weaponToken = `w${seq++}`;
      stamp(data, weaponToken);
      data.system = data.system ?? {};
      toCreate.push(data);
      const ammo = ammoItemDataFor(doc, ammoModifier);
      if (ammo) {
        ammoToken = `a${seq++}`;
        stamp(ammo, ammoToken);
        toCreate.push(ammo);
        // §1's loot dial: spare magazines are REAL ammo items, not a number on a card.
        for (let i = 0; i < loot.spareMags; i++) {
          const spare = ammoItemDataFor(doc, ammoModifier);
          spare.system.equipped = false;
          stamp(spare, `s${seq++}`);
          toCreate.push(spare);
        }
      }
    } else missing.push(weaponRow.name);
  }

  // Armor: EQUIPPED, because the damage pipeline reads `equipped` and a GM should not have to open
  // the sheet to make a goon's coat count.
  for (const layer of armor.layers ?? []) {
    const doc = layer.key ? await loadCatalogDoc(layer.key) : null;
    if (!doc) { missing.push(layer.name); continue; }
    const data = game.items.fromCompendium(doc);
    stamp(data, `r${seq++}`);
    data.system = data.system ?? {};
    data.system.equipped = true;
    toCreate.push(data);
  }

  // Chrome: INSTALLED, not carried. The compound pull only means anything if the option ends up in
  // the housing, so `equipped` is true and the parent wiring happens right after create.
  const chromeTokens = [];
  for (const it of [...(chrome.items ?? []), ...(chrome.bonusItems ?? [])]) {
    const doc = it.key ? await loadCatalogDoc(it.key) : null;
    if (!doc) { missing.push(it.name); continue; }
    const data = game.items.fromCompendium(doc);
    const token = `c${seq++}`;
    stamp(data, token);
    data.system = data.system ?? {};
    data.system.equipped = true;
    toCreate.push(data);
    chromeTokens.push({ token, entry: it });
  }

  if (loot.cashEb > 0) toCreate.push(stamp(credchipItemData(loot.cashEb), `k${seq++}`));

  if (toCreate.length) await actor.createEmbeddedDocuments("Item", toCreate);

  // ⛔ RESOLVE EVERYTHING BY TOKEN. `createEmbeddedDocuments`' return order is NOT guaranteed to
  // match its input order (rig-proven on multi-creates), and matching by NAME collides the moment a
  // goon carries two identical implants. Every created item carries a unique token in our own flag
  // namespace and the pairing is resolved from that.
  const byToken = new Map();
  for (const it of actor.items) {
    const t = it.getFlag(SCOPE, "goonToken");
    if (t) byToken.set(t, it);
  }

  const updates = [];
  if (weaponToken && ammoToken) {
    const w = byToken.get(weaponToken);
    const a = byToken.get(ammoToken);
    if (w && a) {
      updates.push({
        _id: w.id, "system.ammoItemId": a.id,
        "system.shotsLeft": Math.max(0, Math.trunc(Number(w.system?.shots) || 0)),
        "system.equipped": true,
      });
    }
  } else if (weaponToken) {
    const w = byToken.get(weaponToken);
    if (w) updates.push({ _id: w.id, "system.equipped": true });
  }

  // ── THE COMPOUND INSTALL ──────────────────────────────────────────────────────────────────────
  // Options are wired into the housing the plan put them in. `checkInstall` is the module's own
  // container gate (capacity + parent-type), and it is asked rather than assumed — a pack whose
  // capacity data has rotted refuses the install and the goon keeps the implant loose instead of
  // silently exceeding a budget the sheet would then show as over-capacity.
  const installNotes = [];
  const housingByName = new Map();
  for (const { token, entry } of chromeTokens) {
    if (entry.role !== "housing") continue;
    const item = byToken.get(token);
    if (item) housingByName.set(entry.name, item);
  }
  for (const { token, entry } of chromeTokens) {
    if (entry.role !== "option" || !entry.housing) continue;
    const child = byToken.get(token);
    const parent = housingByName.get(entry.housing);
    if (!child || !parent) continue;
    const check = checkInstall(child, parent, actor.items.contents);
    if (!check?.ok) { installNotes.push({ name: entry.name, reason: check?.reason ?? "refused" }); continue; }
    updates.push({ _id: child.id, "system.Module.ParentId": parent.id });
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);

  // ── THE STAT WRITE — LAST, AND WHOLE-OBJECT ───────────────────────────────────────────────────
  // §2.5's humanity math has already run in the plan; this is where it lands on the sheet. §4
  // requires the reduced EMP to SURVIVE actor prep, which is precisely why the whole stats object
  // goes back: a dotted `system.stats.emp.base` would take the other eight stats with it and the
  // schema would refill them from defaults, resetting the rolled REF and BT.
  const attr = Math.max(0, (Number(bp.stats.attr) || 0) + (Number(row.attrDebit) || 0));
  await actor.update({
    "system.humanity": row.humanity,
    "system.stats": statsPayload(bp.stats, { emp: row.emp, attr }),
  });

  // ── §2.8 TOKEN VISION, on the prototype token ─────────────────────────────────────────────────
  const sight = goonPrototypeSight(actor.items.contents);
  if (sight) {
    await actor.update(Object.fromEntries(Object.entries(sight.patch).map(([k, v]) => [`prototypeToken.${k}`, v])));
  }

  return {
    id: actor.id, name: actor.name, grade: bp.grade, role: bp.role, roleRolled: !!bp.roleRolled,
    stats: { ...bp.stats, emp: row.emp, attr },
    humanity: row.humanity, emp: row.emp, humanityLoss: row.humanityLoss,
    weapon: weapon?.name ?? null, armor: (armor.layers ?? []).map((l) => l.name),
    effectiveSP: armor.effectiveSP, effectiveEV: armor.effectiveEV,
    chrome: (chrome.items ?? []).map((i) => i.name),
    bonusItems: (chrome.bonusItems ?? []).map((i) => i.name),
    loot, missing, installNotes,
    skillsUpdated: skillResult.updated, skillsGranted: skillResult.granted,
    visionMode: sight?.mode ?? null,
    // Reported so a caller can see the GM-side text was written WITHOUT having to read the sheet.
    // It is a summary field, not a surface: nothing renders this object to a player.
    gmNotes,
    honesty: row.honesty,
  };
}

/**
 * The whole squad.
 *
 * ⚠ SEQUENTIAL ON PURPOSE. Each `Actor.create` costs roughly half a second because of the ~105
 * embedded documents the base grants inside it; firing twelve concurrently does not make the work
 * smaller, it makes the failure modes concurrent. One at a time also means a squad that fails
 * half-way has produced N whole goons rather than N broken ones.
 */
export async function materializeGoonSquad(planRows, destination = {}) {
  if (!game.user?.isGM) {
    ui.notifications?.warn(localize("GoonFactory.GmOnly"));
    return [];
  }
  const dest = await resolveGoonDestination(destination);
  if (dest.instruct) { ui.notifications?.warn(localize("GoonFactory.PickDestination")); return []; }
  const nameByKey = await skillNameIndex();
  const made = [];
  for (const row of (planRows ?? []).slice(0, GOON_MAX_COUNT)) {
    try {
      const summary = await materializeGoon(row, { folder: dest.folder, nameByKey });
      if (summary) made.push(summary);
    } catch (e) {
      console.error(`${SCOPE} | goon factory: "${row?.bp?.name}" failed to materialize`, e);
    }
  }
  return made;
}

/** Grade rows for a window that wants the ladder without importing the whole table. */
export const GOON_GRADE_ROWS = GRADE_KEYS.map((k) => gradeOf(k));
