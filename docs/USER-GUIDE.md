# CP2020 Augmented — User Guide

> The GM & player manual for the module's features: what each one does at the table, the exact
> gestures, and the settings that shape it. The technical companion is
> [ARCHITECTURE.md](ARCHITECTURE.md); the visual-effects reference is [FX-RAIL.md](FX-RAIL.md).

Status: LIVING DOCUMENT — spine 2026-08-11; sections marked `(stub)` fill in as features settle
after the current rework wave. Feature behavior described here matches the post-rework shape.

---

## 1. First-time setup

- Install alongside the `cyberpunk2020` system (v1.1.1+), Foundry v13–v14.
- ⚠ **Updating across versions that add map-region types requires a full SERVER restart** — a
  page reload is not enough. Hosted users: use the host's Stop/Start control.
- Optional, recommended for visuals: the free **Sequencer** and **JB2A** modules. Detected
  automatically; nothing to configure. Without them you still get the muzzle-flash light and
  sounds — with them, tracers, muzzle sprites, and impact marks.
- A **Setup & What's New** dialog appears at first load and after updates; it re-surfaces when a
  new version changes things worth knowing.

## 2. Combat automation (stub — expand after wave)

Fire from a weapon's sheet or macro → the shot resolves, draws, and sounds → the **Apply Damage**
window opens after the on-screen action. Per-hit rows show location, SP, and damage; each row
expands to a full math breakdown naming every SP source (armor layers, cover, AP effects, BTM).

## 3. Cover (post-rework shape)

- **Place cover:** scene tools → Place Cover → pick a preset ("Brick Wall [25]"…) or type your
  own SP; structure defaults to 3×SP. Zones are drawn regions; **walls and doors** can carry
  cover too, straight from the stock wall config.
- **It just works:** there is no enable setting — placing cover IS turning it on. When a shot's
  line crosses cover, the Apply window pre-fills it (editable; typed SP always wins).
- **Cover wears down per bullet.** Every round chews the cover's structure; a long burst can
  destroy a door MID-burst, and the rounds after the break hit at full force. The chat summary
  shows what the cover absorbed and what's left. A destroyed door stands open.
- Repair = restore structure / untick Destroyed on the object.

## 4. Vehicles (post-rework shape)

- **Deploy:** press Deploy on a vehicle item → (players) the GM approves → **the vehicle appears
  on the map next to you**, and its actor files into the Vehicles folder. The item and the
  deployed vehicle stay linked both ways.
- **Board:** stand within a square of the vehicle, right-click YOUR token, click the van icon.
  You take a seat inside the vehicle's footprint — shrunk to ride, still fully clickable and
  targetable (drive-by firefights with real tokens are the point). Drag onto another SEAT square of
  the footprint to change seats; the new seat is yours from then on, through resizes and turns. The
  walking-figure icon steps you out beside the car.
- **Aboard, the only drag that goes anywhere is onto a seat.** A drag that ends off the bodywork is
  refused outright — the token does not go and come back, it simply does not go, and a message says
  who is aboard what. A drag that ends ON the car but on a square that is not a seat (the engine
  block, bare bodywork) is refused the same way, for the same reason: there is nothing there to sit
  in. This holds for the GM too; to move somebody off a vehicle, step them out with the
  walking-figure icon first.
  Dropping onto a seat somebody else already holds is not refused — that seat is a real place to
  aim for — but it does not take: the rider goes back to their own seat rather than sharing a
  square. Which squares are seats is shown on the vehicle sheet's paint grid, where seats and the
  engine block each carry their own colour.
- **Dragging a box round a vehicle selects the vehicle, not its crew.** Riders sit inside the car's
  square, so a selection box drawn over a vehicle used to pick up everybody aboard as well — and the
  next drag then refused each of them in turn. The crew are now dropped back out of any box
  selection that caught their vehicle: you grabbed the car, and they ride with it anyway. Clicking a
  rider still selects that rider (sheets, targeting, everything else), and shift-clicking still
  builds whatever selection you want by hand. However many riders one drag refuses, it says so once
  — and if the vehicle is in the selection too it says nothing at all, because the car is taking
  them with it.
- **Riding:** the crew stay glued to the vehicle while it drives and turns — no throwing anyone
  off on a hard stop. A vehicle is drawn deeper than it is wide because its long axis is the way
  it travels, so it leads with a short face; Foundry turns it to face where you drag it, and the
  seats, the engine block and the armour facings all turn with it.
- **The outline round a vehicle IS the vehicle.** Foundry's own selection box cannot tilt, so a car
  parked at an angle would otherwise sit inside an upright rectangle full of pavement it is nowhere
  near. Vehicles are given a square token big enough to hold the car at any angle, that square's
  border is hidden, and the module draws the car's true outline instead — turned to its heading, with
  a short spur off the nose. Clicking, hovering and targeting follow that outline, so a click on the
  empty ground beside a car selects the ground, not the car. When you select or hover a vehicle the
  outline changes colour exactly as any other token's border would.
- **Footprint** on the vehicle sheet is the CAR's size in squares, across × deep — not the token's.
  Type the shape you want and the token resizes itself to suit; the seats, the engine block, the
  paint grid and the cover geometry all follow it.
- **First load after this update:** every vehicle already in your world is measured once. Cars that
  were built broader than they were deep — everything the module shipped before the facing fix — are
  turned to run nose-first, which is what stops them driving sideways. They do not move on the map.
  If you genuinely wanted a broad, shallow vehicle, type its figures back into the Footprint field
  and nothing will change them again.
- **Occupancy:** the vehicle shows an aboard count; its sheet lists riders with per-person
  step-out buttons; your own sheet shows an "Aboard" strip while riding. A control on the
  vehicle's HUD fades occupants (only on your screen) when you want to admire the car.
- Vehicle damage, SDP, and Maximum Metal combat: (stub).

## 5. Shopping (stub)

GM opens the shop, players buy from the compendium-backed catalog with live pricing and GM
curation (supplement visibility, price overrides). First open of a session stocks the shelves
(brief loading panel). Two legacy bulk-import packs are hidden from players by default
(reversible world setting).

## 6. Weapon & ammo effects (stub — see FX-RAIL for the full visual reference)

On by default; one master switch (*Display: Weapon-Fire Effects*). Sounds ride each player's own
interface-volume slider. Ammo loads that would visibly differ, do; blood is a separate opt-in
world setting, off by default.

## 7. Radiation & hazard zones (stub)

## 8. Improvement Points

Two modes, one setting. **Simple** (the default) gives every character a fungible IP pool the GM
tops up by hand — ignorable if your table doesn't track advancement. **RAW auto-tracking**
(*Improvement Points: RAW auto-tracking*) turns on the full per-skill system described here: skill
rolls collect themselves for the GM to rule on, IP banks per skill, and players level a skill from
its own bank (then the pool).

**The pipeline.** IP moves through three stages, named across the top of the tracker:

`roll → QUEUED → PENDING → BANKED`

- **Queued** — a player rolls a skill; the roll lands in the GM's queue. Nothing is awarded yet.
- **Pending** — the GM awards a queued row an amount. Pending IP is the GM's working figure and is
  **hidden from the player**, so you can revise it, or hand out a session's worth at once.
- **Banked** — **Apply** releases all pending IP to the players. Banked IP is what a player spends.

**Apply applies, and nothing else.** It banks pending IP and starts a new throttle cycle. It does
not award, skip or discard anything in the queue: rows you haven't ruled on are still there
afterwards, and awarding one later simply puts it in the next cycle's pending. To throw queued rolls
away, use **Clear queue** — it asks first and tells you how many rolls are about to go.

**Working the queue.** Each row is one character + one skill. Type the IP and press **Enter** (or
click ✓) to award it; ✕ discards that row. Under the manual model a row arrives carrying the last
figure you typed, so a run of equal awards is Enter, Enter, Enter. Under the *Auto baseline + GM
bonus* model a row arrives already ticked as a success — worth the baseline as it stands — and the
number field beside it adds a bonus on top; untick the tick if the use taught nothing.

**Repeat rolls group.** Rolling the same skill five times makes ONE row reading `Name · Skill ×5`,
not five rows. The count is all the row says — no average, no best-of, because a summary invites
ruling on the summary and hides the roll that mattered. Click the row to open it: every roll is
listed newest first with its total and how long ago it happened, and each carries a small ✕ that
**drops that roll out of the group** (junk and spam come out; the count follows). The award stays at
group level — one amount, one ✓, one throttle count for the row. Want to pay for exactly one roll?
Prune the group down to it.

**Balances.** Below the queue, one collapsed line per character shows their pool and everything they
have banked; open it for the per-skill rows. Pool and banked are editable — type an absolute value
to correct a mis-award. The filter box matches characters and skills as you type.

**While no GM is connected, skill rolls are not queued.** They are not held and delivered later,
by design: a login should not detonate a backlog. Weapon fire never queues in any case — only skill
rolls do. The tracker states this in its footer.

**Two safety rails.** The queue holds 100 rows; beyond that the oldest age out, announced once.
(Repeat rolls are cap-neutral — a spree of one skill is one row.) And if 20 rows sit un-awarded, a
one-time prompt offers to open the tracker, clear the backlog, or turn RAW tracking off.

Other settings worth knowing: **award model** (manual vs auto baseline + amount), the **anti-grind
throttle** (off / diminishing returns / one award per skill per cycle), **skill lock** (who may
hand-edit skill levels), and **hide the IP UI entirely** for tables that don't use it at all.

## 9. Chipware & skill chips (stub)

## 10. Settings reference (stub — regenerate at release; every setting, its default, and who it's for)
