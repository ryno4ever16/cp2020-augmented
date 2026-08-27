/**
 * ONE ELECTED GM *SESSION*, NOT ONE ELECTED GM *USER*.
 *
 * ⛔ THE DEFECT THIS EXISTS FOR. Every relay guard in the module used to read
 * `game.user.isGM && game.users.activeGM?.id === game.user.id`. `game.users.activeGM` is a **User
 * document**, so that expression asks *"am I the elected GM user?"* — a question that is TRUE in
 * every browser tab that user has open. A referee with the world open in two tabs (or on a laptop
 * and a tablet) is ONE user and TWO sockets, so a single relayed datagram was handled twice: two
 * chat cards, two placed regions, two deployed vehicles, two missile tokens, two stock decrements.
 * The player roster shows one "Gamemaster" either way, so nothing on screen said it was happening.
 *
 * Worse than duplication: the wound-track write is read-modify-write
 * (`combat/damage-hooks.js` — `current + damage`), so two sessions read the same `current` and
 * write the same sum. The duplicate SWALLOWS its twin, and a multi-hit volley lands an arbitrary
 * interleaved SUBSET of its hits. Measuring the fault by hit points therefore UNDER-reports it —
 * only create-shaped effects show its true size. (Receipts: `import-staging/RIG-CLEANUP-VERIFY.md` §5.)
 *
 * ── WHAT IDENTIFIES A SESSION ON THIS CORE (measured on the v14 rig, 2026-08-26, two tabs of one
 *    browser both holding the world as the same Gamemaster) ──
 *   · `game.user.id`                  — SAME in both tabs. This is the value the old guards compared.
 *   · `game.socket.session.sessionId` — SAME in both tabs (`622291c1…`). It is the server's
 *                                       cookie-scoped session, shared by every tab of one browser,
 *                                       so it cannot tell the two-tab case apart. **Not usable.**
 *   · `game.socket.id`                — DIFFERS (`2DnLXEi0…` vs `U09_K8gc…`). Unique per connection,
 *                                       but socket.io mints a NEW one on every reconnect, so an
 *                                       identity built on it changes under a dropped wifi link.
 * So this module mints its own per-tab nonce at load: unique per tab like `socket.id`, and stable
 * across reconnects like nothing else on offer. `socket.id` is carried alongside it for diagnosis only.
 *
 * ── THE ELECTION ──
 * The primary GM session is the lexicographically LOWEST live session id among the sessions of the
 * user `game.users.activeGM` already elects. The user-level answer is preserved exactly and only
 * narrowed: a world with one GM tab open behaves byte-identically to before, because a session with
 * no observed peer is primary by definition (see the failure posture below).
 *
 * ── PRESENCE ──
 * GM sessions announce themselves over the module socket (`gmSessionPresence`). A `reply` flag makes
 * discovery symmetric: a joining session asks, every incumbent answers, and nobody storms. While —
 * and ONLY while — a peer is known, each session heartbeats so a departure is noticed; a lone GM
 * session emits exactly ONE datagram for the whole session and then goes quiet. Departure is
 * announced on page unload (best effort), and any peer not heard from inside {@link STALE_MS} is
 * dropped. Pruning happens on READ as well as on the beat, so the staleness window is a real bound
 * and not a multiple of the timer.
 *
 * ── FAILURE POSTURE (deliberate, and load-bearing) ──
 * If no peer has been observed, {@link isPrimaryGMSession} returns the OLD user-level answer. A lone
 * referee is never made to wait for a quorum that will never arrive, and a module that fails to load
 * on the other tab degrades to exactly today's behaviour rather than to silence.
 *
 * ── THE RACE, AND ITS BOUND ──
 * Between a second GM session announcing itself and the incumbent's reply arriving, BOTH sessions
 * believe they are alone and both act: one socket round trip (sub-millisecond on a LAN, a few
 * hundred milliseconds across the internet), once, at the moment a second tab is opened. Compare
 * with the defect it replaces, which was permanent. The announce is sent at `setup`, ahead of the
 * `ready` hook where the one-time world migrations run, so those see a settled roster in the normal
 * case; each of them is stamp-gated and idempotent regardless.
 * The mirror-image bound: after an UNGRACEFUL loss of the primary session (a crash or a yanked
 * cable, where no departure datagram was sent), a surviving session may defer to the ghost for up to
 * {@link STALE_MS} before taking over. `userConnected` collapses that to zero whenever the lost
 * session was the user's last one, which is the ordinary shape of the ordinary accident.
 */

const SCOPE = "cp2020-augmented";
const PRESENCE_TYPE = "gmSessionPresence";

/** How often a session re-announces itself — but ONLY while it knows of a peer. */
const HEARTBEAT_MS = 5000;
/**
 * A peer unheard-from for this long is treated as gone. Three missed beats, plus network slack.
 *
 * ⚠ THE TWO FAILURES THIS NUMBER TRADES BETWEEN ARE NOT SYMMETRIC, which is why it errs LONG. Too
 * long, and after an ungraceful loss of the primary nobody acts for up to this window — a bounded,
 * visible gap that the referee can simply re-trigger. Too short, and one slow network moment makes a
 * live primary look dead: the survivor claims primacy while the real primary is still acting, and both
 * write. That is the original defect, re-created by the fix for it. So the gap is the acceptable half.
 */
const STALE_MS = 16000;

/**
 * This tab's identity, minted once at module load. NOT `game.socket.session.sessionId` (shared by
 * every tab of one browser — see the header) and NOT `game.socket.id` (re-minted on every reconnect).
 */
const SESSION_ID = _mintSessionId();

/** sessionId → { userId, lastSeen }. Peers only; this session is never in it. */
const peers = new Map();

let heartbeatTimer = null;
let departed = false;
let registered = false;

/** A random 16-character id in Foundry's own alphabet, with a dependency-free fallback. */
function _mintSessionId() {
  try {
    const id = foundry?.utils?.randomID?.(16);
    if (id) return id;
  } catch (e) { /* pre-globals load order — fall through */ }
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 16; i++) out += A[Math.floor(Math.random() * A.length)];
  return out;
}

/** Drop every peer whose last word is older than the staleness window. Called on read AND on the beat. */
function _pruneStalePeers(now = Date.now()) {
  for (const [id, rec] of peers) if ((now - rec.lastSeen) > STALE_MS) peers.delete(id);
}

/** Emit this session's presence. `reply: true` asks every incumbent to answer (discovery). */
function _announce({ reply = false, state = "here" } = {}) {
  try {
    game.socket?.emit(`module.${SCOPE}`, {
      type: PRESENCE_TYPE,
      sessionId: SESSION_ID,
      userId: game.user?.id ?? null,
      socketId: game.socket?.id ?? null,   // diagnosis only; never compared
      state,
      reply,
    });
  } catch (e) {
    console.warn(`${SCOPE} | GM-session presence announce failed`, e);
  }
}

/** The beat runs only while a peer is known, so the ordinary one-tab table pays nothing for it. */
function _startHeartbeat() {
  if (heartbeatTimer !== null) return;
  heartbeatTimer = setInterval(() => {
    _pruneStalePeers();
    if (!peers.size) { _stopHeartbeat(); return; }
    _announce({ reply: false });
  }, HEARTBEAT_MS);
}

function _stopHeartbeat() {
  if (heartbeatTimer === null) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function _onPresence(data) {
  if (data?.type !== PRESENCE_TYPE) return;
  if (!game.user?.isGM) return;                    // only a GM session keeps the roster
  const id = data.sessionId;
  if (!id || id === SESSION_ID) return;            // a socket emit never reaches its own sender anyway
  if (data.state === "gone") {
    peers.delete(id);
    if (!peers.size) _stopHeartbeat();
    return;
  }
  peers.set(id, { userId: data.userId ?? null, lastSeen: Date.now() });
  _pruneStalePeers();
  _startHeartbeat();
  // A joining session asks once; incumbents answer without asking back, so N sessions cost N replies
  // and not N².
  if (data.reply) _announce({ reply: false });
}

/**
 * Announce departure while the page can still write to the socket. **Best effort by nature, and
 * deliberately not relied on**: core connects its socket with `closeOnBeforeunload: true`, so on a real
 * tab close socket.io may well have closed the connection before this line runs. Both `beforeunload`
 * and `pagehide` are wired because they fire in different orders in different browsers and under a
 * headless harness; whichever gets through, gets through. When none does, the staleness window is what
 * covers it — which is why {@link STALE_MS} is the honest bound and this is the fast path.
 *
 * ⚠ NOT wired to `visibilitychange`, though it would fire earlier and more reliably: a backgrounded tab
 * is still a live session, and announcing its departure would hand primacy to a peer while it kept
 * acting — the original defect, re-created on a tab switch.
 */
function _onUnload() {
  if (departed) return;
  departed = true;
  _stopHeartbeat();
  if (game.user?.isGM) _announce({ reply: false, state: "gone" });
}

/**
 * Wire the presence protocol. Called once from the module's `init` hook (the socket exists by then —
 * the cover relay registers there too). Announces at `setup` and again at `ready`.
 */
export function registerGmSessionPrimary() {
  if (registered) return;
  registered = true;

  game.socket?.on(`module.${SCOPE}`, _onPresence);

  // A user going fully inactive takes ALL of its sessions with it. This is the instant half of
  // departure detection; the staleness window covers the case where one tab of a still-connected
  // user dies without a word.
  Hooks.on("userConnected", (user, active) => {
    if (active || !user?.id) return;
    for (const [id, rec] of peers) if (rec.userId === user.id) peers.delete(id);
    if (!peers.size) _stopHeartbeat();
  });

  // Announced at SETUP, ahead of the `ready` listeners that run the one-time world migrations, so
  // the roster is settled before the first guarded work of the session.
  Hooks.once("setup", () => { if (game.user?.isGM) _announce({ reply: true }); });
  Hooks.once("ready", () => { if (game.user?.isGM) _announce({ reply: true }); });

  window.addEventListener("beforeunload", _onUnload);
  window.addEventListener("pagehide", _onUnload);
  // ⚠ THE UN-DEPARTURE, and it is not theoretical. `pagehide` also fires when a page goes into the
  // back/forward cache, and `beforeunload` fires on a navigation the user can still cancel — either
  // way this session may announce "gone" and then keep running. Peers would have dropped it while it
  // still believed itself primary, which is the original two-writers fault wearing a different hat.
  // Coming back, it says so again.
  window.addEventListener("pageshow", () => {
    if (!departed) return;
    departed = false;
    if (game.user?.isGM) _announce({ reply: true });
  });
}

/** The live peer sessions belonging to one user id, this session excluded. */
function _rivalSessionsOfUser(userId) {
  _pruneStalePeers();
  const out = [];
  for (const [id, rec] of peers) if (rec.userId === userId) out.push(id);
  return out;
}

/**
 * ⭐ THE ONE PREDICATE. True when THIS session is the single one that should perform GM-side relayed
 * and hook-driven work. Replaces every `game.users.activeGM?.id === game.user.id` comparison in the
 * module — no site keeps a private copy of the question.
 *
 * Shape, in order:
 *   1. not a GM at all → false (this half was implicit at several old sites; it is explicit here);
 *   2. not the elected GM USER → false — the existing user-level election is preserved unchanged;
 *   3. no peer session observed → TRUE, which is exactly the old answer (see the failure posture);
 *   4. otherwise the lowest live session id among that user's sessions wins.
 * @returns {boolean}
 */
export function isPrimaryGMSession() {
  const me = game?.user;
  if (!me?.isGM) return false;
  const activeGM = game.users?.activeGM;
  if (!activeGM || activeGM.id !== me.id) return false;
  const rivals = _rivalSessionsOfUser(activeGM.id);
  if (!rivals.length) return true;
  for (const id of rivals) if (id < SESSION_ID) return false;
  return true;
}

/**
 * "Someone else will do it." True when a GM is online to act and this client is not the session that
 * will. The counterpart used by whole-sweep early-outs and by stand-down logging — a player reads
 * true here, and so does a GM's second tab.
 * @returns {boolean}
 */
export function primaryGMSessionIsElsewhere() {
  if (!game.users?.activeGM) return false;   // nobody is going to do it; the caller decides what that means
  return !isPrimaryGMSession();
}

/** This tab's session id — for keepers, diagnostics and log lines. */
export function gmSessionId() { return SESSION_ID; }

/** A plain snapshot of the election, for keepers and for a GM asking what their table looks like. */
export function gmSessionPrimaryState() {
  _pruneStalePeers();
  return {
    sessionId: SESSION_ID,
    socketId: game.socket?.id ?? null,
    userId: game.user?.id ?? null,
    isGM: !!game.user?.isGM,
    activeGMUserId: game.users?.activeGM?.id ?? null,
    peers: [...peers].map(([id, rec]) => ({ sessionId: id, userId: rec.userId, ageMs: Date.now() - rec.lastSeen })),
    heartbeat: heartbeatTimer !== null,
    isPrimary: isPrimaryGMSession(),
  };
}
