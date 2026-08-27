import { localizeParam } from "./utils.js";

/**
 * Submit-time guard for numeric sheet fields.
 *
 * `<input type="number">` does not keep text out of the box on every browser. Firefox accepts
 * arbitrary characters into a number field: the element then reports `validity.badInput === true`
 * while its `.value` reads back as the EMPTY STRING. Foundry's FormDataExtended reads `.value` only,
 * and its number branch maps `""` to `null` (client/applications/ux/form-data-extended.mjs), so a box
 * holding "a" submits exactly what a deliberately-cleared box submits — and the stored number is
 * overwritten by whatever the receiving path makes of the empty read (`null` on the plain form path,
 * `0` or `NaN` where a change handler runs `Number(value || 0)`).
 *
 * The distinction is gone by the time the form data exists, so the check has to be made against the
 * live ELEMENT, at the moment the form is read. That is this module. A keydown filter is not the fix:
 * unreadable contents also arrive by paste, drag, autofill and IME composition, none of which produce
 * a keydown for the offending character — the submit-time refusal is the contract.
 *
 * ⚠ BLANK IS DELIBERATELY LEFT ALONE. An empty box is a legitimate gesture on these sheets and keeps
 * whatever meaning it already had (measured on the rig before this guard existed: the plain form path
 * stores `null`; the actor sheet's own SDP change handler stores 0). Only contents that are
 * PRESENT-BUT-UNREADABLE are refused, so nothing an existing world does changes.
 */

/**
 * True when `el` is a field whose value is destined for a number. `type="number"`/`"range"` declare it
 * directly; `data-dtype="Number"` is the base system's own declaration for a field that carries a
 * number in a box of another type, and FormDataExtended reads it the same way.
 * @param {Element} el
 * @returns {boolean}
 */
function isNumericField(el) {
  const type = String(el.type || "").toLowerCase();
  if (type === "number" || type === "range") return true;
  return el.dataset?.dtype === "Number";
}

/**
 * True when `el` is a form-bound numeric field the browser cannot read as a number.
 *
 * Two signals, in order:
 *  1. `validity.badInput` — the authoritative one. The element holds characters it could not parse,
 *     and reports an empty `.value` that is indistinguishable from a cleared box.
 *  2. a non-empty raw value that is not finite — the fallback for a numeric field whose box is not of
 *     type `number` (so the browser never sanitises it) and for any host that does not set badInput.
 *
 * Blank, disabled and read-only fields are never unreadable: blank is a legitimate entry, and the
 * other two are not submitted in the first place.
 * @param {Element} el
 * @returns {boolean}
 */
export function isUnreadableNumberField(el) {
  if (!el || el.tagName !== "INPUT" || !el.name) return false;
  if (el.disabled || el.readOnly) return false;
  if (!isNumericField(el)) return false;
  if (el.validity?.badInput === true) return true;
  const raw = String(el.value ?? "").trim();
  if (raw === "") return false;
  return !Number.isFinite(Number(raw));
}

/**
 * Every unreadable numeric field currently in `form`, in document order.
 * @param {HTMLFormElement} form
 * @returns {HTMLInputElement[]}
 */
export function unreadableNumberFields(form) {
  if (!form?.querySelectorAll) return [];
  return Array.from(form.querySelectorAll("input[name]")).filter(isUnreadableNumberField);
}

/**
 * The name to print for a field: its accessible label, else its tooltip, else the data path it
 * writes. The path is always present (a field with no `name` is never submitted), so this always
 * resolves to something that identifies the box.
 * @param {HTMLInputElement} el
 * @returns {string}
 */
function fieldLabelOf(el) {
  const aria = el.getAttribute("aria-label");
  const title = el.getAttribute("title");
  return String(aria || title || el.name || "").trim();
}

/**
 * Remove `path` from an EXPANDED submit object, then discard any ancestor object the removal left
 * empty. Pruning matters because the parents are object-valued fields on the document: handing one an
 * empty object is a write of nothing, and the point of this guard is that no write happens at all.
 * @param {object} data   An expanded object (what `_processFormData` returns)
 * @param {string} path   A dot-path, e.g. "system.sdp.current.rArm"
 * @returns {boolean}     Whether anything was removed
 */
function deleteExpandedPath(data, path) {
  const keys = String(path).split(".");
  const chain = [data];
  let node = data;
  for (let i = 0; i < keys.length - 1; i++) {
    node = node?.[keys[i]];
    if (!node || typeof node !== "object") return false;
    chain.push(node);
  }
  const leaf = keys[keys.length - 1];
  if (!Object.prototype.hasOwnProperty.call(node, leaf)) return false;
  delete node[leaf];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length) break;
    delete chain[i - 1][keys[i - 1]];
  }
  return true;
}

/**
 * What the document has actually SAVED at `path` — the stored bytes (`_source`) in preference to the
 * prepared value, because the prepared one can be a derived number the sheet computed rather than the
 * one a write would put back (a structural pool with an empty entry, for instance, is prepared as
 * full). Falls back to the prepared value for a path the source does not carry, and to `undefined`
 * when the document holds nothing there at all.
 * @param {foundry.abstract.Document} doc
 * @param {string} path
 * @returns {*}
 */
function storedValueOf(doc, path) {
  if (!doc) return undefined;
  const fromSource = doc._source ? foundry.utils.getProperty(doc._source, path) : undefined;
  if (fromSource !== undefined) return fromSource;
  return foundry.utils.getProperty(doc, path);
}

/**
 * Refuse every unreadable numeric field in `form`: put the value the document already holds back into
 * `submitData` in place of the unreadable read, repaint the box from that same value so the screen
 * stops showing something that was never saved, and say so once.
 *
 * ⚠ WHY THE PATH IS PINNED AND NOT SIMPLY DELETED. Several of these boxes write into a single
 * `ObjectField` (`system.stats`, `system.sdp.current`, `system.hitLocations`), and a form submit
 * carries the WHOLE object — updating one replaces it rather than merging into it, so a key missing
 * from the payload comes back as the schema's default, not as the value that was stored. Deleting the
 * path therefore destroys the number for exactly the fields most worth protecting (measured: dropping
 * `system.stats.ref.base` from the payload reset a stored 8 to the default 5). Writing the stored
 * value back makes the update a no-op for that path under either semantics. The path is deleted only
 * when the document holds nothing there to put back — and then any ancestor object the removal
 * emptied goes with it, so no empty object is handed to a field as a write of nothing.
 *
 * Call from a sheet's `_processFormData` override, on the object `super` returned. Returns the field
 * paths that were refused (empty when the form was clean), so a caller can assert on them.
 *
 * @param {object} submitData             The expanded submit object, mutated in place
 * @param {HTMLFormElement} form          The form being read
 * @param {foundry.abstract.Document} doc The document the sheet edits — the source of the kept value
 * @returns {string[]}                    The refused field paths
 */
export function refuseUnreadableNumberFields(submitData, form, doc) {
  const bad = unreadableNumberFields(form);
  if (!bad.length) return [];

  const refused = [];
  const labels = [];
  for (const el of bad) {
    const stored = storedValueOf(doc, el.name);
    if (stored === undefined) deleteExpandedPath(submitData, el.name);
    else foundry.utils.setProperty(submitData, el.name, stored);
    refused.push(el.name);
    labels.push(fieldLabelOf(el));
    // Assigning `.value` also clears the element's bad-input state, so the box is readable again and
    // the next change event carries a real number.
    el.value = (stored === undefined || stored === null) ? "" : String(stored);
  }

  ui.notifications?.warn?.(localizeParam("NumberFieldUnreadable", { fields: labels.join(", ") }));
  return refused;
}

/* ───────────────────────────── the other way a number is wrong ───────────────────────────── */

/**
 * The `min`/`max` a numeric input declares, as numbers, or null when it declares neither.
 *
 * The attributes are read from the ELEMENT rather than from a table in code for the same reason the
 * unreadable check is: the box is where the range is already written down. `input type="number"`
 * carries min/max for the spinner and for native validation, both of which a typed-in figure walks
 * straight past — the browser marks the field `:out-of-range` and submits it anyway — so the range is
 * stated but nothing was enforcing it.
 * @param {HTMLInputElement} el
 * @returns {{min:number, max:number}|null}
 */
function declaredRangeOf(el) {
  // ⛔ ASK THE ATTRIBUTE WHETHER IT IS THERE, never `Number.isFinite(Number(getAttribute(...)))`.
  // A missing attribute reads back as `null`, and **`Number(null)` is 0** — which is finite. The
  // obvious test therefore answers "this box declares min 0 and max 0" for every numeric box that
  // declares neither, and the guard then clamps every ordinary figure on the sheet to zero. Caught on
  // the rig the first time this ran: one footprint edit reported the vehicle's Crew and Passengers as
  // 2 and 3 in their boxes and stored 0 for both. (The same `Number(null)` trap the hull's
  // `hasRecordedHull` carries a warning about — it is worth re-reading before writing either idiom.)
  const read = (name) => {
    const raw = el.getAttribute(name);
    if (raw === null || String(raw).trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const min = read("min"), max = read("max");
  if (min === null && max === null) return null;
  return { min: min ?? -Infinity, max: max ?? Infinity };
}

/** `n` forced into `range`. */
function clampTo(n, range) {
  return Math.min(range.max, Math.max(range.min, n));
}

/**
 * Refuse every numeric field in `form` whose entry is outside the range the box itself declares:
 * replace the submitted figure with the nearest one the field will actually hold, repaint the box
 * from it, and say so once.
 *
 * ⛔ WHY THIS EXISTS, WHICH IS NOT TIDINESS (field incident 2026-08-25). A GM typed `10000` into a
 * vehicle's Footprint box, which declares `min="1"` and nothing else. The write took; the sheet then
 * asked the browser for 20,000 grid cells and the token layer for a 10000-square frame, the tab ran
 * out of memory, and — because both are recomputed on every open — the vehicle could not be opened
 * again to correct the number. A figure the box's own attributes call illegal must not reach the
 * document.
 *
 * ⚠ HOW THIS DIFFERS FROM THE UNREADABLE GUARD ABOVE, deliberately. A box holding "1e" carries no
 * usable intention, so the guard puts the STORED value back and the write becomes a no-op. A box
 * holding 10000 carries a perfectly clear intention that is simply out of bounds, so the field goes
 * to the nearest legal figure instead: the stored value clamped when the document holds a number
 * there, and otherwise the entry itself clamped. Reverting an out-of-range entry to the raw stored
 * value would be the one wrong answer available — on a vehicle already poisoned with 10000 that
 * would write 10000 straight back, which is the state this whole unit exists to get out of.
 *
 * Call from a sheet's `_processFormData` override, AFTER `refuseUnreadableNumberFields` (an
 * unreadable box has no figure to compare against a range). Returns the field paths that were
 * refused, so a caller can assert on them.
 *
 * @param {object} submitData             The expanded submit object, mutated in place
 * @param {HTMLFormElement} form          The form being read
 * @param {foundry.abstract.Document} doc The document the sheet edits
 * @returns {string[]}                    The refused field paths
 */
export function refuseOutOfRangeNumberFields(submitData, form, doc) {
  if (!form?.querySelectorAll) return [];
  const refused = [];
  const labels = [];
  for (const el of Array.from(form.querySelectorAll("input[name]"))) {
    if (el.disabled || el.readOnly || !isNumericField(el)) continue;
    if (isUnreadableNumberField(el)) continue;              // the other guard owns this one
    const range = declaredRangeOf(el);
    if (!range) continue;
    const raw = String(el.value ?? "").trim();
    if (raw === "") continue;                               // blank keeps whatever meaning it had
    const entered = Number(raw);
    if (!Number.isFinite(entered)) continue;
    if (entered >= range.min && entered <= range.max) continue;

    // `typeof`, not `Number(...)`: an unrecorded nullable field stores `null`, and `Number(null)` is
    // 0 — which would put a floor-clamped 1 into a field whose whole meaning is "nothing recorded".
    // Nothing stored ⇒ the entry itself is what gets clamped.
    const stored = storedValueOf(doc, el.name);
    const hasStored = (typeof stored === "number") && Number.isFinite(stored);
    const kept = clampTo(hasStored ? stored : entered, range);
    foundry.utils.setProperty(submitData, el.name, kept);
    el.value = String(kept);
    refused.push(el.name);
    labels.push(fieldLabelOf(el));
  }
  if (!refused.length) return [];
  ui.notifications?.warn?.(localizeParam("NumberFieldOutOfRange", { fields: labels.join(", ") }));
  return refused;
}
