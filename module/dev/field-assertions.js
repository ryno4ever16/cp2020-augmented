/**
 * DEV FIELD ASSERTIONS — the unusable-number tripwire, off unless a GM asks for it.
 *
 * WHAT IT IS FOR. Every derivation this module adds runs as a post-step on top of the base
 * system's own `prepareData` pass, and the failure that survives every suite in the battery is the
 * QUIET one: a number that lands in `system` as `NaN`, `Infinity`, or an explicitly-`undefined`
 * numeric field. Nothing throws. The sheet renders "NaN" in a box a player may never look at, the
 * damage pipeline multiplies by it, and the report that eventually reaches the table is prose ("my
 * armour went weird") rather than a path. This turns that class into a named path the first time it
 * is prepared.
 *
 * WHY IT IS A CLIENT SETTING AND DEFAULT OFF. It costs a full recursive walk of `system` on every
 * document preparation, which is the hottest path in the client — so it is not something a table
 * runs. It is per-user (a GM chasing a report turns it on for their own tab, without asking the
 * whole table to reload) and defaults OFF per the module's standing rule that power features are
 * opt-in. When it is off the wrapper reads ONE cached boolean and returns; nothing is allocated,
 * nothing is walked, and the setting store is not consulted (the value is mirrored into `_on` at
 * registration and kept current by the setting's own `onChange`).
 *
 * THE WRAP SITE. `prepareData`, not `prepareDerivedData` — the base computes its stat totals inside
 * `prepareData` itself, so a `prepareDerivedData` post-step runs while those numbers are still
 * undefined (the hazard the whole mech family is built around; see module/mech/stat-mods.js). This
 * file follows that same wrap idiom, once for Actor and once for Item, and is registered LAST among
 * the module's `prepareData` wraps so it reads what every other post-step has finished writing —
 * which is the state a sheet will actually render.
 *
 * WHAT IT REPORTS, AND HOW OFTEN. On the first finding for a given document it raises ONE
 * notification naming the document and the first bad path, plus one console warning carrying the
 * whole list. That document is then silent for the rest of the session — preparation re-runs on
 * every update, so an un-throttled report would be a scrolling wall for a single defect.
 *
 * WHAT IT CANNOT SEE. An `undefined` numeric field is only nameable when the document's schema can
 * resolve the path to a NumberField; on a host whose documents carry no DataModel (or for a path
 * inside an array, which schemas do not all resolve) the walk reports non-finite NUMBERS only. That
 * is a smaller claim, not a false one — it never guesses that a field is numeric.
 */
import { localizeParam } from "../utils.js";

const SCOPE = "cp2020-augmented";

/**
 * ⛔ FROZEN SPEC — the bounds of one scan and of the whole session's reporting.
 *
 * MAX_DEPTH        how deep the walk descends. `system` is a shallow tree; a deeper structure is a
 *                  reference cycle the WeakSet already caught, or noise.
 * MAX_FINDINGS     findings collected per document before the walk stops. One report names the
 *                  defect; a hundred paths from one broken derivation name it a hundred times.
 * REPORTED_CAP     how many DISTINCT documents may be reported in one session. The throttle needs a
 *                  memory, and a memory that grows with the world is a leak — at the cap the whole
 *                  scan stands down for the session and says so once.
 */
const SCAN_LIMITS = Object.freeze({
  MAX_DEPTH: 8,
  MAX_FINDINGS: 12,
  REPORTED_CAP: 200,
});

/** Mirror of the setting, so the hot path never touches the settings store. */
let _on = false;
/** Wrap-once guards (one per document class), mirroring the mech family's `_wrapped` idiom. */
let _wrappedActor = false;
let _wrappedItem = false;
/** Documents already reported this session (the throttle), and the cap's own one-shot flag. */
const _reported = new Set();
let _capped = false;

/**
 * Every non-finite number under `root`, plus every explicitly-`undefined` leaf the schema can name
 * as a NumberField. Returns an array of `path=value` strings, bounded by SCAN_LIMITS.
 *
 * Shape mirrors the fuzz suite's page-side scanner (tests/cp2020-augmented-seam-fuzz.mjs
 * `__cpScan`) so a finding here reads identically to a finding there: same depth cap, same cycle
 * guard, same `path=value` rendering. That scanner lives inside a test file as a source string with
 * no import surface, so it is re-stated here rather than shared.
 */
function scanSystem(root, schema) {
  const bad = [];
  const seen = new WeakSet();
  const isNumericField = (rel) => {
    if (!schema?.getField || !rel) return false;
    try {
      const field = schema.getField(rel);
      const NumberField = foundry?.data?.fields?.NumberField;
      return !!field && !!NumberField && field instanceof NumberField;
    } catch (e) {
      return false;          // a path the schema cannot resolve is not claimed to be numeric
    }
  };
  const walk = (v, path, rel, depth) => {
    if (bad.length >= SCAN_LIMITS.MAX_FINDINGS || depth > SCAN_LIMITS.MAX_DEPTH) return;
    if (typeof v === "number") { if (!Number.isFinite(v)) bad.push(`${path}=${v}`); return; }
    if (v === undefined) { if (isNumericField(rel)) bad.push(`${path}=undefined`); return; }
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], `${path}[${i}]`, rel ? `${rel}.${i}` : `${i}`, depth + 1);
      return;
    }
    for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`, rel ? `${rel}.${k}` : k, depth + 1);
  };
  walk(root, "system", "", 0);
  return bad;
}

/**
 * The post-step itself: scan one prepared document and, on a first finding for it, say so once.
 * Exported so a macro can put a single document through the same check without the setting on.
 */
export function assertDocumentFields(doc) {
  if (_capped) return [];
  const system = doc?.system;
  if (!system || typeof system !== "object") return [];
  // The schema comes off the system DataModel when the host has one; a plain-object `system` simply
  // yields no schema, and the walk then reports non-finite numbers only.
  const findings = scanSystem(system, system.schema);
  if (!findings.length) return [];

  const key = doc.uuid ?? doc.id ?? doc.name;
  if (_reported.has(key)) return findings;                     // this document has already spoken
  if (_reported.size >= SCAN_LIMITS.REPORTED_CAP) {
    _capped = true;
    console.warn(`${SCOPE} | field assertions: ${SCAN_LIMITS.REPORTED_CAP} documents reported this `
      + `session — the check is standing down so its record cannot grow further. Reload to resume it.`);
    return findings;
  }
  _reported.add(key);

  const name = doc.name || key;
  const kind = doc.documentName || "Document";
  console.warn(`${SCOPE} | field assertions: ${kind} "${name}" (${key}) carries `
    + `${findings.length} unusable value(s): ${findings.join(", ")}`);
  // `console: false` because the line above already said it, in full. Foundry's notifier logs every
  // notification to the console by default, which would put a TRUNCATED second copy of this finding
  // directly beneath the complete one — two entries in the log for one defect, the shorter of them
  // missing the path list that makes the report worth reading.
  ui.notifications?.warn?.(localizeParam("Augmented.Dev.FieldAssertionFinding", {
    document: name, path: findings[0], count: findings.length,
  }), { console: false });
  return findings;
}

/** Reset the per-session throttle — for a macro (or a keeper) re-running the check deliberately. */
export function resetFieldAssertionThrottle() {
  _reported.clear();
  _capped = false;
}

/** Whether the check is currently armed on this client (the cached setting value). */
export function fieldAssertionsOn() { return _on === true; }

/**
 * Register the setting and install the two `prepareData` post-steps.
 *
 * Called from the module's init wiring AFTER every other `prepareData` wrap, so this one is
 * outermost and observes the finished numbers rather than an intermediate pass.
 */
export function registerDevFieldAssertions() {
  game.settings.register(SCOPE, "devFieldAssertions", {
    name: "SETTINGS.DevFieldAssertions",
    hint: "SETTINGS.DevFieldAssertionsHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: (value) => {
      _on = value === true;
      // A fresh arming starts from a clean slate, so turning the check on again after a fix
      // re-reports whatever is still wrong instead of staying silent about it.
      if (_on) resetFieldAssertionThrottle();
    },
  });
  try { _on = game.settings.get(SCOPE, "devFieldAssertions") === true; } catch (e) { _on = false; }

  const actorProto = CONFIG?.Actor?.documentClass?.prototype;
  if (actorProto && !_wrappedActor) {
    const orig = actorProto.prepareData;
    actorProto.prepareData = function () {
      orig.call(this);
      if (!_on) return;                                       // the whole cost when the check is off
      try { assertDocumentFields(this); } catch (e) { console.warn(`${SCOPE} | field assertions failed`, e); }
    };
    _wrappedActor = true;
  }

  // The ITEM wrap covers embedded items too: the base prepares an actor's items inside its own
  // `super.prepareData()`, so an owned weapon's numbers pass through here without the actor wrap
  // having to walk its whole collection a second time.
  const itemProto = CONFIG?.Item?.documentClass?.prototype;
  if (itemProto && !_wrappedItem) {
    const orig = itemProto.prepareData;
    itemProto.prepareData = function () {
      orig.call(this);
      if (!_on) return;
      try { assertDocumentFields(this); } catch (e) { console.warn(`${SCOPE} | field assertions failed`, e); }
    };
    _wrappedItem = true;
  }
}
