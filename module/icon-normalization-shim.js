/**
 * Actor icon-normalization shim (module side).
 *
 * The base actor data model declares the stored field `system.icon` (the netrunner Runner Icon)
 * as a strict image FilePathField. Foundry v13+ validates fields at document construction, so a
 * legacy value without a recognized image extension ("Default Runner", ".../runner") makes the
 * WHOLE actor fail to construct — it surfaces as an "unavailable" document, and the world
 * migration can never repair it because the actor fails to load before migration runs. The base
 * migrateData() flattens object-shaped and empty values but never sanitizes a bad STRING — the
 * exact gap the pending upstream PR (#39, its normalizeIconPath helper) closes.
 *
 * This shim ships that repair module-side until the PR lands: at init (before world documents
 * construct) it wraps migrateData() on every registered ACTOR data-model class whose icon field
 * is a strict FilePathField, coercing an unusable stored value to "" (blank is allowed) and
 * passing valid values through untouched. Validity is decided by the FIELD'S OWN validate(), so
 * the check can never drift from what the schema accepts.
 *
 * Self-disengaging, per the seam-shim contract:
 *  - upstream PR merged → migrateData's source contains "normalizeIconPath" → stand down;
 *  - field relaxed to a plain string (the interim hand-patch on the live install, or the fork)
 *    → no strict field → stand down;
 * so the shim is inert everywhere the problem is already solved, and engages by itself the day
 * a system update wipes the hand-patch.
 *
 * migrateData also runs over PARTIAL update diffs (see the DataModel hazard notes): the wrap
 * only ever touches an `icon` key PRESENT in the source — it never adds the key, never fills
 * defaults, never touches siblings.
 */

const SCOPE = "cp2020-augmented";

/**
 * True when a data-model class still needs the repair: its icon schema field is a strict
 * FilePathField AND its migrateData lacks the upstream normalizer. Pure — exported for the
 * rig keeper.
 *
 * @param {typeof foundry.abstract.TypeDataModel} cls
 * @returns {boolean}
 */
export function needsIconShim(cls) {
  const FilePathField = foundry?.data?.fields?.FilePathField;
  const field = cls?.schema?.fields?.icon;
  if (!FilePathField || !(field instanceof FilePathField)) return false;
  return typeof cls.migrateData === "function" && !String(cls.migrateData).includes("normalizeIconPath");
}

/** Install the wrap on every registered actor data model that needs it. Called from the module's init. */
export function registerIconNormalizationShim() {
  for (const cls of new Set(Object.values(CONFIG?.Actor?.dataModels ?? {}))) {
    try {
      if (!needsIconShim(cls) || cls.migrateData.__cpIconShim) continue;
      const field = cls.schema.fields.icon;
      const orig = cls.migrateData;
      const wrapped = function (source) {
        const out = orig.call(this, source) ?? source;
        try {
          if (Object.prototype.hasOwnProperty.call(out, "icon")) {
            let v = out.icon;
            if (v && typeof v === "object") v = v.default ?? ""; // shapes the base flatten may miss
            if (typeof v !== "string") v = "";
            let ok = (v === "");
            if (!ok) { try { ok = field.validate(v) === undefined; } catch { ok = false; } }
            if (!ok) v = "";
            out.icon = v;
          }
        } catch (e) { /* never worsen construction — an untouched value fails no worse than before */ }
        return out;
      };
      wrapped.__cpIconShim = true;
      cls.migrateData = wrapped;
    } catch (e) {
      console.warn(`${SCOPE} | icon-normalization shim failed to install`, e);
    }
  }
}
