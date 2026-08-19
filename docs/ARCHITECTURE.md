# CP2020 Augmented — Architecture & Maintainer's Handoff

> Written as the principal architect's handoff. If you are the next maintainer: this document,
> [FX-RAIL.md](FX-RAIL.md) (the FX rail's own deep-doc), and the keeper suite in `tests/` are the
> three things to trust. Everything here is either verified against the code at writing time or
> marked ⚠ TO-VERIFY. When this document and the code disagree, the code has moved — fix the doc.

Status: LIVING DOCUMENT, spine + first passes 2026-08-11. Sections marked `(stub)` are queued.

---

## 0. The one-paragraph mental model

The module is an **opt-in automation overlay on someone else's system**. The base system
(`cyberpunk2020`, by "Tilt") owns every actor/item schema, every sheet the module didn't
explicitly register, and all compendium base packs. The module adds behavior exclusively through:
**hooks** (init/ready registration from one entry file), **module-owned document sub-types**
(`cp2020-augmented.vehicle`, ACPA), **flags** (`flags.cp2020-augmented.*` — our only writable
namespace on system documents), **wrappers** around a small number of system functions, and **one
interception seam** (`seam-shim.js`) that turns base-system combat actions into events the module
consumes. Nothing in the base system's files is ever edited. The consequence that shapes
everything: *any state the module needs must live in a flag, a module sub-type, a world setting,
or a module-owned document — and every schema question is answered by reading the SYSTEM's
`template.json`, not ours.*

## 1. Boot topology

Entry point: `module/cp2020-augmented.js` — verified: the ONLY file `module.json` `esmodules`
names; everything else is reached by import. Registration order matters and is deliberate:

1. **`Hooks.once("init")`** — settings registration (`settings.js` — every setting in one file;
   `settings-sections.js` holds the SECTIONS organizer that groups them in the config UI: ⚠ a
   key not listed in SECTIONS renders stranded at the bottom of the menu — always file new keys),
   document sub-type registration, sheet registration, handlebars helpers, template preloads.
2. **`Hooks.once("ready")`** — feature wiring. Ready-hook registrations go through a **`wire()`
   isolation wrapper** so one throwing feature cannot starve the rest (added after a real
   incident where it did). Migrations run here too — see §10.
3. **Late/deferred** — canvas- and UI-dependent features register their own hooks
   (`renderTokenHUD`, `renderActorDirectory`, `canvasReady`, region behaviors) from their own
   files, imported by the entry file.

Rule of thumb for adding a feature: its file exports a `registerX()` function; the entry file
calls it inside `wire()`; the feature's own file owns its hooks. Grep for `registerVehicleBoardingHud`
for a clean example.

## 2. The compatibility layer

- **`module/compat.js`** — the v13/v14 split lives here and ONLY here. `getHtmlElement()`
  normalizes the hook-argument difference (v13 hooks may hand jQuery, v14 hands HTMLElement);
  every render-hook consumer routes through it. Never test `instanceof jQuery` in feature code —
  a core that exposes no jQuery global makes that a ReferenceError (this bug shipped once;
  fixed 2026-08-11, commits `bfb4ea7`/`4cd5b92`).
- **`module/chat-render-compat.js`** — `onChatCardRender(pass)`: register a chat-card renderer
  AND catch up over the existing log + popout. Exists because `renderChatMessageHTML` fires for
  scrollback BEFORE ready-registered listeners exist (both cores). Any feature that decorates
  chat cards MUST use this, not a bare hook, or its cards die on reload.
- **`module/system-api.js`** — `apiHelper(ns, fn, fallback)`: prefer the base system's public
  helpers (`game.cyberpunk.api.*`) at call time, fall back to bundled copies in `lookups.js`/
  `utils.js`. This is why the module runs on a stock install and why our copies must not drift
  silently: the fallback is the contract.
- **`module/popout-compat.js`**, **`shimmer.js`** — PopOut! module interop and sheet-shimmer
  helpers. (stub — expand on next pass)

## 3. The seam (how base-system combat reaches the module)

`module/seam-shim.js` is the single most load-bearing file. The base system has no event API for
combat actions, so the shim intercepts the only interception point available (a template-render
seam — intrinsically noisy re deprecation warnings; retires if/when the base system ships real
hooks) and emits module-consumed events, most importantly **`cyberpunk2020.weaponFired`** with a
payload contract (see FX-RAIL for the FX-side fields).

Payload facts the next maintainer must not break:
- `attackerTokenId` rides every fire payload (`_firingTokenId()`: synthetic actor's own token →
  controlled token → `ChatMessage.getSpeaker` → null). Consumers PREFER it over any
  actor→first-token lookup — the find-first-token idiom draws from the wrong token when one
  actor has two tokens and is banned (see §12 Hazards).
- `payload.modifier` (ammo modifier key) + caliber ride all fire exits; the FX rail and damage
  riders key off them.
- The hook fires ONLY on the client that resolved the shot; anything other clients must see
  goes over the module socket (`module.cp2020-augmented` channel).
- The damage window flow consumes the same payload (`combat/damage-hooks.js`): pending payloads
  carry a TTL (~5s) so a stray Apply button cannot resurrect a stale shot.

## 4. Data ownership & the corrections layer

- **The system owns all schema.** Stats write to `system.stats.<k>.base` (NOT `.value` — silent
  no-op), skills are ITEMS (auto-granted: the system's `_preCreate` gives every new actor the
  full ~103-item default skill set + Kick/Strike — never create skill items, update levels),
  `npc` type is a schema clone of `character`, unlinked by default.
- **Module sub-types**: vehicles/ACPA are `cp2020-augmented.vehicle` etc. — the only documents
  whose schema we own (`module/data/`). DataModel rules: typed nested SchemaFields for anything
  partially updated; NEVER default-fill in `migrateData` (it runs on update CHANGES and wipes
  siblings); a dotted update into an ObjectField MERGES rather than replaces — whole-object
  writes for zone maps (see §12).
- **`module/data-corrections.js`** — the runtime repair layer over BASE pack data we cannot edit
  (base packs are reinstalled on every system update). Keyed pack-id → item `_id`, applied at
  `preCreateItem` by reading **`_stats.compendiumSource`** — which means: ANY code path that
  copies a pack item and drops that field silently hands out uncorrected data. Use
  `game.items.fromCompendium(doc)` (keeps it) or re-stamp it like `shop/purchase.js` does. This
  is the highest-probability silent bug class in the module (it has been caught in review more
  than once).
- **Policy (user-ruled 2026-08-11):** defects in the base system's data are NOT mass-patched
  from the module. The shipped B1/B2 overlays (reliability matcher line, caliber aliases,
  availability normalizer) are FROZEN — the campaign ended with them. New base-data defects:
  record, hide (`hideScrapedPacks` pattern), or stage an upstream PR for the user's manual
  review. Module-owned pack data is fixed at `src/packs/` source (then RE-SEED before release —
  the seed step only CREATES, it never updates).

## 5. The damage pipeline (stub — full pass queued)

`combat/DamageApplicator.js` — `resolveHitMath` (SP → AP halving → penetrating multiplier),
`applyAreaDamages` (per-round loop: ablation, per-round COVER chew as of `55054bc`, BTM,
wound track, limb rules per the 3-model setting), `applyBTM` (min 1 when penetrated).
`combat/DamageDialog.js` — the Apply window; auto-detect cover seeds `_coverZoneUuid`+`_coverSP`
whenever the dialog knows the attacker token (from a fire card — a manual HUD apply has no shot
line); the per-hit expandable breakdown row (`c21abe5`) names every SP component. Armor layering:
`combat/armor-layers.js` (proportional-armor combine, hard/soft, cover folds in OUTERMOST via
`combineArmorSP`). Key invariant: preview (`resolveAreaDamagesSync`) and apply share the same
math including the simulated cover ledger — if they diverge, that is a bug, not a feature.

## 6. Cover (stub — post-rework pass queued after tonight's wave settles)

Zones = native Region behaviors (`combat/cover-zone-behavior.js`, document type declared in
module.json — ⚠ adding/renaming document types requires a full SERVER RESTART, not a reload).
Walls carry `flags.cp2020-augmented.coverSp/coverPool/...`. `combat/cover.js`: presets
("Name [SP]" format), `coverBetween` ray (wall lineSegmentIntersects + region testPoint — ⚠ v14
`RegionDocument#testPoint` takes ONE ElevatedPoint: carry elevation inside both positions),
`chewCover*` document writes. Placement-is-consent: there is NO enable setting — placing cover
IS the opt-in (user principle, 2026-08-11; do not add toggles to placement-gated systems).

## 7. Vehicles & ACPA (stub — post-rework pass queued)

`module/vehicle/`: deploy request flow (player ask → GM approval → actor in Vehicles folder →
`deployVehicleToScene()` places the handle token beside the requester), seat-slot boarding
(`seatIndex` flag; crew sorts ABOVE hull; boarded scale via `texture.scaleX/Y` so the hit-square
survives; displace waypoints on board/step-out — v14 streams fractional positions during move
animation), occupancy surfaces, ordnance (v14 cloud via `createArea`). Pilot damage routes to the
world actor BY DESIGN (unlinked pilots share the base).

**ONE rotation-zero convention** (`vehicle-layout.js`: `ROTATION_ZERO_FRONT = "s"`,
`headingVector()`): a token at rotation 0 faces SOUTH, which is the core's own statement and what
its drag auto-rotate acts on. Every consumer reads it — the shipped footprint (`DEFAULT_FOOTPRINT`
2 across × 4 deep, so the long axis is the travel axis and a short face leads), the seat/engine
layout, the cover ray's engine cells, the footprint outline's nose spur, and `computeFacing()`'s
front/side/rear arcs. Three of those used to answer differently (east / north / north), which is how
a driven vehicle came to lead with its longest face.

**Rider coupling is presentation, bookkeeping is one write.** `vehicle-ride.js` draws every aboard
rider at its seat on each `refreshToken` frame of the vehicle (PIXI transforms only, per client,
never a document write, and never a token a hand is holding). `vehicle-canvas.js` commits the
rider documents once per pose change, from the vehicle's `_source` pose, with displace waypoints.
Both ask the same `riderSeatAt()`, so the last drawn frame and the committed position are the same
pixel. Seat position is derived from the seat INDEX, never carried as a delta — a dragged rider's
new square is adopted as an index (`adoptDraggedSeat`) so it survives resizes and heading changes.

## 8. Shop (stub)

`module/shop/`: `catalog.js` — the catalog index is a once-per-session memoized promise
(`getCatalogIndex()`), built on FIRST shop open (never at ready — that was perf finding S1),
indexes COMPENDIUM Item packs only (world items never appear), ~3.1k rows ≈ 1.5–2 MB retained.
`purchase.js` — the copy path with the compendiumSource re-stamp (§4). `categories.js` — the
two-level taxonomy + excluded packs/types. First-open spinner; `hideScrapedPacks` world setting
(default ON) hides the two scraped base packs from players and restores prior permissions on
toggle-off.

## 9. The FX rail

Fully documented in [FX-RAIL.md](FX-RAIL.md) — treat that file as authoritative for everything
drawn or played. The ratified authoring standard is both an FX-RAIL section and the
`cp2020-sequencer-fx` project skill. Contract points other subsystems must respect: the settle
signal gates the damage window; `payload.modifier`/`attackerTokenId` come from the seam (§3);
sounds play on the interface channel; Sequencer/JB2A are OPTIONAL — every draw degrades to
nothing without them, and `fxDbEntryExists` guards every sprite key.

## 10. Migrations

Pattern (post-hardening `9e489ea`/`1889fdf`): world-scoped completion flag written FIRST
(flag-first: a mid-run throw costs one attempt, never a forever-loop), try/catch with a loud
console.error naming the manual re-run path, and an api escape hatch:
`game.modules.get("cp2020-augmented").api.migrations.*` (also `game.cpAugmented.migrations`).
Additive fields + runtime floors over data rewrites wherever possible.

## 11. Testing & rigs

- **Keepers** live in `tests/` (module repo — adopted from the retired fork at `0af78e6`; the
  fork is ABANDONED, never commit there). Plain node Playwright scripts:
  `FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=<rig pw> node tests/<keeper>.mjs`.
  `tests/package.json` supplies `@playwright/test`; node_modules is gitignored; the release
  zip's ALLOWLIST excludes tests/ (keep it that way).
- **The bar**: red-first for new mechanisms, assert VALUES not presence, drive REAL UI gestures
  (dispatch the event, assert the visible outcome), run twice (the second run has caught real
  teardown bugs), leave the rig clean (own scenes for fixtures, sweeps scoped to them — a keeper
  sweep once ate shared review fixtures).
- **Rigs**: :30004 = ship target (v14 + vanilla system + module; serves a REAL COPY at
  `FoundryVTT-Vanilla-Data/Data/modules/cp2020-augmented` — copy changed files there and verify
  the serve BEFORE running keepers). :30003 = v13. :30000 = the user's LIVE world — never touch.
- The `cp2020-rig-keeper` skill (untracked, `.claude/skills/`) is the full procedure.

## 12. THE HAZARDS CATALOG — the traps that cost real debugging time

Read this section before touching anything. Each entry was earned.

1. **ObjectField dotted updates MERGE.** A dotted write into `system.…current.<zone>` resets
   sibling zones. Whole-object writes for zone maps. (Cyberlimb SDP repair.)
2. **Flag-object deletes need `-=key`.** Flag objects merge on update; plain omission lingers.
3. **Unlinked-token id collision.** A synthetic actor shares `id` with its world actor —
   `game.actors.get(id)` retargets the base and every same-base mook bleeds one HP pool. Use
   `utils.resolveActorRef`; the re-fetch idiom is BANNED. ⚠ Attacker-side counters still key on
   bare `attackerId` in places (aim-clear, action count) — known gap, relevant to squads.
4. **`_stats.compendiumSource` is the corrections trigger** (§4). `toObject()` drops it.
5. **The system's `_preCreate` grants all skills.** Never "first add the skills."
6. **`renderChatMessageHTML` fires before ready listeners** — use `chat-render-compat.js`.
7. **v14 `RegionDocument#testPoint` takes ONE ElevatedPoint** — elevation in both positions.
8. **v14 streams token positions during move animation** — fractional mid-glide reads; use
   `{teleport:true}` or await the animation before reading positions.
9. **Token creation needs a fully-drawn canvas** — creating during canvas init throws in
   `TokenDocument._onCreate`; activate + poll `canvas.ready` first.
10. **`createEmbeddedDocuments` return order ≠ input order** on multi-creates (rig-proven) —
    never index-map children to parents.
11. **Stat writes go to `.base`** — `.value` fails silently.
12. **module.json documentTypes changes ⇒ server restart** (not reload) — release-note it.
13. **PowerShell 5.1 `-Encoding utf8` writes a BOM** — Foundry fatals on BOM'd JSON/lang files;
    write BOM-free LF (the repo's convention).
14. **Settings keys must be filed in `settings-sections.js`** or they strand at the menu bottom.
15. **Draw/refresh hooks fire during token destroy** — guard placeable liveness in canvas UI
    (`Cannot set properties of null (_parentID)` class).
16. **A keeper's stale-sweep must be scoped to its own scene** — an unscoped marker sweep
    deleted shared review fixtures (2026-08-11).
17. **jQuery may not exist** — no `instanceof jQuery`, no bare `$`; `getHtmlElement()` (§2).

## 13. Conventions (the house style, condensed)

The module deliberately follows the base system's own conventions so the work stays mergeable
upstream: templates own structure, JS owns data; zero user-facing strings in JS — everything
via i18n keys (`CYBERPUNK.*` nested groups, `SETTINGS.*`; created-DOCUMENT names stay English —
they are data, not chrome); no HTML/CSS strings in JS (templates + `css/cp2020-augmented.css`);
pure/impure split (pure blueprint functions with injected rng, one impure materializer); commits
via `git commit -F` with mechanism-first prose; no time estimates anywhere. Skills in
`.claude/skills/` are untracked tooling. `import-staging/` is the untracked working area — never
staged. The release recipe is tag-first with a zip built from an allowlist (`module/ css/ fonts/
img/ lang/ templates/ packs/ module.json LICENSE README.md`).

## 14. What is deliberately NOT built (do not "fix" these)

- No base-system file edits, ever — mergeability upstream is a design goal.
- No mass-patching of base pack data (policy, §4).
- Explosion system: RULED to retire in favor of the base system's when its 1.2.0 ships
  (occlusion/sound propagation) — don't invest here.
- Netrunner NPC generation waits for the netrunning pass (recorded earmark).
- The fork repo (`cyberpunk2020-fork`) is a retired test bed — read-only history.

---

*Next passes queued: full §5/§6/§7/§8 subsystem walkthroughs (post-wave, so they document the
reworked shapes), mech/chipware + radiation/gas + IP + martial sections, i18n/packs build detail,
and a file-by-file index.*
