/**
 * WALK ERROR COLLECTOR — the opt-in fault journal, so a field report can arrive as a stack.
 *
 * WHAT IT IS FOR. A fault that happens at somebody else's table arrives as prose: "it went weird
 * during the fight." The console held the answer for about as long as that browser tab lived. This
 * collects the two channels a browser gives for an unhandled fault — the `error` event and
 * `unhandledrejection` — into a small in-memory ring, and gives a GM one call that writes the ring
 * into a journal entry they can read, keep, or paste back. Nothing leaves the client on its own.
 *
 * WHY A RING AND NOT A LOG. A tab that starts faulting usually faults in a loop, and an unbounded
 * list of those would be the second bug. The ring holds the most recent RING.CAP entries and drops
 * the oldest — which is also the right end to keep, because the last faults before a GM notices are
 * the ones they can describe.
 *
 * WHY `addEventListener` AND NOT `window.onerror`. `window.onerror` is a single slot: assigning it
 * takes the slot from whatever already held it (core, another module) and gives it back on toggle-
 * off only if nothing else claimed it meanwhile. Listeners compose, and `removeEventListener` with
 * the same function reference detaches exactly ours — which is what the setting's off position has
 * to mean. Both handlers are pure collectors: they never call `preventDefault`, never re-throw and
 * never log, so the console a developer is watching is unchanged by their presence.
 *
 * WHAT AN ENTRY HOLDS. `{ time, message, stackHead, url }`. `stackHead` is the FIRST stack frame
 * naming this module, falling back to the first frame of any kind — one line, because the value of
 * a field report is "which of our files, which line", and a full stack of engine frames buries it.
 *
 * HOW A GM GETS IT OUT. `game.modules.get("cp2020-augmented").api.exportErrorJournal()` — from a
 * script macro, or from the console. It creates a journal entry titled with today's date holding
 * one page of plain text, one paragraph per entry. Journal creation is a document write, so it is
 * GM-only; a player who calls it is told to ask their GM rather than being met with a permission
 * fault. Both routes are named in the setting's hint, so the feature explains itself where it is
 * switched on.
 */
import { localize, localizeParam } from "../utils.js";

const SCOPE = "cp2020-augmented";

/**
 * ⛔ FROZEN SPEC — the ring's bounds and how much of any one fault is kept.
 *
 * CAP              entries held before the oldest is dropped. ~200 covers a session's worth of a
 *                  repeating fault while staying small enough to sit in memory unnoticed and to
 *                  read in one page.
 * MESSAGE_MAX      characters kept from a fault's message. Some engine faults carry a serialized
 *                  payload as their message; the identifying part is the front.
 * STACK_HEAD_MAX   characters kept from the chosen stack frame. A frame is a path plus two numbers.
 */
const RING = Object.freeze({
  CAP: 200,
  MESSAGE_MAX: 500,
  STACK_HEAD_MAX: 240,
});

/** The ring itself (oldest first), the attach guard, and the mirror of the setting. */
const _entries = [];
let _attached = false;
let _on = false;

/** The first stack frame naming this module, else the first frame of any kind, else "". */
function stackHeadOf(stack) {
  if (typeof stack !== "string" || !stack) return "";
  const lines = stack.split("\n").map((l) => l.trim()).filter(Boolean);
  const frames = lines.filter((l) => l.includes("/") || l.startsWith("at "));
  const ours = frames.find((l) => l.includes(`/modules/${SCOPE}/`));
  return (ours ?? frames[0] ?? "").slice(0, RING.STACK_HEAD_MAX);
}

/** Append one fault, dropping the oldest once the ring is full. */
function record({ message, stack, url }) {
  _entries.push({
    time: new Date().toISOString(),
    message: String(message ?? "").slice(0, RING.MESSAGE_MAX),
    stackHead: stackHeadOf(stack),
    url: String(url ?? ""),
  });
  while (_entries.length > RING.CAP) _entries.shift();
}

/**
 * The two handlers, held as module-level references so `removeEventListener` can name them.
 * A rejection's reason is whatever was thrown — an Error, a string, or an object — so its message
 * and stack are read defensively rather than assumed.
 */
function onWindowError(event) {
  try {
    record({
      message: event?.message ?? String(event?.error ?? ""),
      stack: event?.error?.stack,
      url: event?.filename || document?.location?.href,
    });
  } catch (e) { /* a collector that fails must not become the fault it collects */ }
}
function onUnhandledRejection(event) {
  try {
    const reason = event?.reason;
    record({
      message: reason?.message ?? String(reason ?? ""),
      stack: reason?.stack,
      url: document?.location?.href,
    });
  } catch (e) { /* same */ }
}

/** Attach (or detach) the two listeners. Idempotent in both directions. */
function setListeners(on) {
  if (on && !_attached) {
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    _attached = true;
  } else if (!on && _attached) {
    window.removeEventListener("error", onWindowError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    _attached = false;
  }
}

/** A copy of the ring, oldest first. For a macro, a keeper, or the export below. */
export function readErrorJournal() {
  return _entries.map((e) => ({ ...e }));
}

/** Empty the ring — for a GM starting a fresh reproduction attempt. */
export function clearErrorJournal() { _entries.length = 0; }

/** Whether the collector is currently attached on this client. */
export function errorJournalActive() { return _attached; }

/**
 * Write the ring into a new journal entry and return it (or `null` when nothing was written).
 *
 * Exposed on the module API as `exportErrorJournal` and callable from a script macro. The page is
 * MARKDOWN-formatted plain text rather than HTML: the entries are a diagnostic transcript, and
 * building markup in JS for something a human reads as text is exactly what this codebase does not
 * do. One paragraph per entry, newest last, in the order they happened.
 */
export async function exportErrorJournal() {
  if (!game.user?.isGM) {
    ui.notifications?.info?.(localize("Augmented.Dev.ErrorJournalAskGm"));
    return null;
  }
  const entries = readErrorJournal();
  if (!entries.length) {
    ui.notifications?.info?.(localize("Augmented.Dev.ErrorJournalEmpty"));
    return null;
  }
  const date = new Date().toISOString().slice(0, 10);
  const title = localizeParam("Augmented.Dev.ErrorJournalTitle", { date });
  const body = entries
    .map((e, i) => `${i + 1}. ${e.time} — ${e.message}\n${e.stackHead || "(no frame)"}\n${e.url}`)
    .join("\n\n");

  const entry = await JournalEntry.create({
    name: title,
    pages: [{
      name: title,
      type: "text",
      text: {
        content: body,
        format: CONST?.JOURNAL_ENTRY_PAGE_FORMATS?.MARKDOWN ?? 2,
      },
    }],
  });
  ui.notifications?.info?.(localizeParam("Augmented.Dev.ErrorJournalWritten", {
    title, count: entries.length,
  }));
  return entry;
}

/**
 * Register the setting and follow it.
 *
 * Called early in the module's init wiring: the earlier the listeners can be attached, the more of
 * a load-time fault they can catch on a client that already had the setting on.
 */
export function registerDevErrorJournal() {
  game.settings.register(SCOPE, "devErrorJournal", {
    name: "SETTINGS.DevErrorJournal",
    hint: "SETTINGS.DevErrorJournalHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: (value) => {
      _on = value === true;
      setListeners(_on);
    },
  });
  try { _on = game.settings.get(SCOPE, "devErrorJournal") === true; } catch (e) { _on = false; }
  setListeners(_on);
}
