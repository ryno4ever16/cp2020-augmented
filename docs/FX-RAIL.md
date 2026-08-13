# The FX rail

*First edition — 2026-08-09. Covers `module/fx/effects.js` and the seam that feeds it, plus the one
thing a shot puts on the canvas that is not a sprite: the shotgun's shot pattern
(`module/combat/spread-zone-look.js`, and the flow that places it in `module/combat/damage-hooks.js`).*

This is the maintainer's document for everything the module draws when a gun goes off. It is written
for someone who has never read a development report: every number here is either measured on a real
install or ruled by the module's user, and where the two disagree the document says which is which.

**The one rule to read first.** `module/fx/` is the *only* place that knows about outside effect
engines. Every asset key, every colour, every duration and every geometry constant lives there — in
`effects.js` for everything a trigger pull draws, and in `status-fx.js` for the marks a figure wears
while a condition is on it (§2a). If an animation looks wrong, one of those two files is where it is
wrong; nothing else needs opening. *(The rule named `effects.js` alone until 2026-08-12; it was always
about containment, and containment is now the folder. `status-fx.js` asks every capability question
through `effects.js`'s own answers, so there is still exactly one adapter to the engine.)*

---

## 1. Architecture

### 1.1 The seam

```
   base system fires a weapon
        │
        │  (the base emits no hook of its own — module/seam-shim.js wraps its fire
        │   methods and its card render, and raises one instead)
        ▼
   Hooks: "cyberpunk2020.weaponFired"  ── payload ──┐
        │                                           │
        ├─→ module/combat/damage-hooks.js           │  (damage: what happened)
        └─→ module/fx/effects.js  fxWeaponFired()   │  (presentation: what it looked like)
                                                    │
                            both read the SAME payload object
```

The payload is one resolved burst against one target. Its presentation-relevant fields:

| Field | Meaning | Set by |
|---|---|---|
| `attackerId` | **whose** shot it is — the ACTOR id, which cannot name a figure on the map | seam shim |
| `attackerTokenId` | **which figure fired** — the origin every effect is drawn out of | seam shim, captured at the trigger pull (see below) |
| `weaponId` / `weaponName` | which weapon (id is exact — two same-named weapons can carry different ammo) | seam shim |
| `shotsFired` / `shotsHit` | rounds spent and rounds that landed **for this card** | the base's own card data |
| `areaDamages` | one entry per landing round, by hit location | the base's own card data |
| `targetTokenId` | the card's own resolved target — **damage-flow routing** | the card |
| `fxTargetTokenId` | the aimed-at token — **presentation only**, set on every fire mode | seam shim |
| `firedByUserId` | the one client that resolved the shot | seam shim |
| `fumbleRuled` | the base actually *resolved* a fumble (not merely "a 1 was rolled") | seam shim |
| `modifier` | the loaded ammo's modifier id — **the ammo overlay's input** | seam shim, from the loaded ammo item. Sits **beside** `caliber` in `AMMO_EFFECT_FIELDS`, never instead of it: the two answer different questions (which load, which cartridge) and a build that swapped one for the other cost `dualPurpose` its identity for a day — see §6, 2026-08-09 |
| `caliber` | the cartridge in the chamber — **the pattern flow's input** | seam shim, from the loaded ammo's `caliber`, falling back to the weapon's own `ammoType` |
| `armorMultSoft`, `penDamageMult`, `spreadMode`, `dotType`, … | the loaded ammo's mechanics | seam shim, from the loaded ammo item |

Two target fields exist on purpose. `targetTokenId` decides whether the damage window opens
mid-action; `fxTargetTokenId` only says which way the shot was pointed. Folding them together would
silently move every single-shot and burst card onto the mid-action damage path, which the user
explicitly did not want.

**⭐ THE ORIGIN FIELD — `attackerTokenId` (2026-08-10).** The actor id names an ACTOR, and an actor can
have several figures drawn at once; an unlinked figure's own actor even carries the base actor's id. So
resolving the origin from `attackerId` can only answer *"whichever figure was placed first"* — which is
what a shot fired from the second copy of a figure used to do: it drew its flash, its muzzle work and
its rounds out of the first one. The seam captures the firing figure at the trigger pull, where the
identity is unambiguous, in this order (`_firingTokenId`, `module/seam-shim.js`):

1. a **synthetic actor** (an unlinked figure's own actor) belongs to exactly one figure and names it;
2. else the figure the firing user has **selected** on the viewed canvas — what an ordinary turn leaves
   selected;
3. else **core's own speaker resolution** for that actor (which itself prefers a selected figure and
   otherwise takes the actor's first drawn one);
4. else `null` — nothing could be established.

The rail reads it through `shooterTokenForPayload(payload, actor)` (`fx/effects.js`), used by BOTH the
fan-out and the tail arithmetic so the window a caller waits out is measured from the same figure the
shot is drawn from. It **falls back to `shooterTokenOf(actor)`** in two cases — the field is absent (an
older or re-emitted payload) or it names a figure this client is not drawing (a payload relayed from
another scene) — so a payload without it behaves exactly as every payload did before the field existed.
`shooterTokenOf` itself is untouched; whether a shot with no figure on the *viewed* scene should draw at
all is a separate open question (§8) and is deliberately not decided here. The same field name is what
the suppressive payload has always used, and the suppressive wrapper now captures it by the same rule.

### 1.1a Two resolution flows, and the one question that chooses between them

One payload is resolved by **exactly one** of two flows, and they never overlap:

```
   cyberpunk2020.weaponFired  ── payload ──▶  spreadFlowModeOf(payload)   (module/lookups.js)
                                                        │
                    ┌───────────────────────────────────┴────────────────────────────┐
                    │ "single"                                                       │ "buck" / "flechette"
                    ▼                                                                ▼
   SINGLE-TARGET FLOW                                          PATTERN FLOW
   damage-hooks.js _hookWeaponFired                            damage-hooks.js _hookSpread
   · one target, resolved by hit location                      · a ray from the shooter, width + damage by range band
   · DamageDialog, or the card's Apply button                  · EVERYONE in the path, no evasion (CP2020 p.108)
   · waits on presentationSettled()                            · GM aims a GM-only zone, then ONE Confirm card
                                                               · confirm applies, posts one result card, scatters
                                                                 the burning load's fires down the
                                                                 path, deletes the zone
```

⭐ **What the pattern CARRIES** (2026-08-10, review finding F7). The zone the GM aims is the only record
of the shot by the time anyone clicks Confirm, so it has to carry everything the shell will do — not just
the armour half. Its flags hold the armour terms (`ap`, `edged`, `mono`, `armorMult*`, `penDamageMult`),
the banded damage and geometry, both lifecycle clocks — **and the load's per-hit riders**
(`stunSaveOnHit`, `stunSaveMod`, `dotEnabled`, `dotTurns`, `dotType`, `dotDamageFormula`, `effectTypes`).
`_confirmSpreadZone` applies those riders through `_applyAreaHitToToken`, which makes the **same two
calls the single-target flow makes** (`updateTaserState`, then `applyDotFromPayload`) in the same order,
once per landed shell per token. A load with no riders stores the inert values and neither call does
anything, so the explosion path through the same helper is unchanged.

Since 2026-08-09 there is a **third** caller of that same question and it is on the presentation side:
`patternFlowOwns(payload)` in `fx/effects.js`, which decides whether the fan-out draws the burning
ground or leaves it to the pattern's own confirm.

All three ask **one shared site**, `spreadFlowModeOf(payload)` in `module/lookups.js`, so they cannot
answer differently. That site is `spreadModeForAmmo` — what the *round* is — plus the pattern's world
switch, which is what the module will *do* with it:

```
spreadModeForAmmo(fields)   what the ROUND is        (the caliber rule above — nothing else)
        └── spreadFlowModeOf(payload)   what the MODULE DOES with it   ← the one site all three ask
                 · pattern switched ON  → the derived mode stands
                 · pattern switched OFF → "single": no flow places a pattern, so the ordinary
                                          single-target flow owns every shell, exactly as it
                                          already owns the slug
```

⏪ **The switch used to be read only by the pattern hook, and that was a defect, not a design.** With
the pattern off, the single-target gate stood down because the cartridge derived to `buck` and the
pattern hook stood down because the setting said no — so a shell payload was claimed by **neither**
flow: no apply window, no pattern, no damage. Folding the switch into the shared answer makes "off"
mean what a reader expects, and the presentation follows for free — with the pattern off, an incendiary
shell's burning ground is drawn by the fan-out again, because the confirm that would otherwise have
scattered those fires down the path never happens.

The two damage gates are literally the same call (`_spreadModeOf(payload)`, twice), which is the whole
guarantee: if they ever disagreed, a shell would be damaged **twice** — once by the dialog and once by
the pattern — or not at all. A keeper leg counts the call sites; another asserts the damage rail reads
the world setting **nowhere** of its own.

**The question is asked of the CARTRIDGE, not of a flag.** The shotgun is an area weapon in the Core
rules; buckshot patterns because of what it is. Every shotgun ammo item ever seeded carries
`spreadMode: "single"` (the ammo-modifier seeder's default), so a rule that read the stored field
would have made the book behaviour reachable only by hand-editing every ammo item in every world.
Deriving it at fire time means an untouched world's buckshot fires the pattern on its next shot, with
no migration and no re-seed. The four cases, in decision order:

| Input | Result |
|---|---|
| the `slug` load (by `spreadMode: "slug"` **or** by modifier id) | `single` — the one shotgun load that is a single projectile |
| any other explicitly declared non-single mode (`flechette`) | that mode, unchanged |
| a caliber that is not shotgun-family — **including blank or unknown** | `single` (safe default: no cartridge recorded, no pattern) |
| anything left: a shotgun-family caliber | `buck` |

**The cartridge is recorded under two different names**, and the seam resolves both: an *ammo* item
stores the round it **is** in `system.caliber`; a *weapon* stores the round it **takes** in
`system.ammoType` — the base system's own field, and the only one its weapon schema has (a `caliber`
written to a weapon is dropped). Every shell weapon in the shipped catalogue records a gauge there and
nothing anywhere else, so without the second reading a shell fired on free fire, or from a weapon never
reloaded, would report no cartridge at all and throw no pattern.

### 1.2 What runs where

`cyberpunk2020.weaponFired` is a **local** `Hooks.callAll` — it fires only on the client that resolved
the shot. Each element reaches the other clients differently:

| Element | Transport | Notes |
|---|---|---|
| Shot audio | `AudioHelper.play(..., true)` broadcast | interface channel, so each player's own slider governs it |
| Muzzle **light** | the module's own socket channel, drawn locally by every receiver | no document is written |
| Sprites (lance, tracer/volley, impact, smoke, ground fire) | Sequencer's own socket | |
| Face-target turn | an ordinary token document update | **the only document write on this rail** |

### 1.3 Dependency policy

Sequencer and JB2A are **optional**. Sprite verbs no-op silently when they are absent; the muzzle
light and the audio are native and always work. An asset key that the *installed* JB2A tier does not
carry is skipped, never played — `fxDbEntryExists()` is the gate, and every key on the rail passes
through it. All shipped keys are chosen from the **free** tier and are pinned by a keeper leg.

---

## 2. Element reference

Everything one trigger pull can put on screen, in the order it appears.

| # | Element | Asset / mechanism | Gate | Above lighting? |
|---|---|---|---|---|
| 1 | **Face-target turn** | token document `rotation` update, 220 ms sweep | table setting **and** token not `lockRotation` **and** turn ≥ 5° | n/a |
| 2 | **Muzzle light** | native `PointLightSource`, built and driven per render frame | always (native) | it *is* a light — clips to walls |
| 3 | **Muzzle lance** | `jb2a.muzzle_flash.single.01.yellow`, trimmed to 110 ms, dwelt by the row's `muzzleMs` | row names `muzzle` — **every class, including the shell again** | yes |
| 4 | **Spark star** | `jb2a.impact.006.yellow` | row names `spark` — **no shipped row does** | yes |
| 5 | ~~Discharge column~~ | ⏪ **DELETED 2026-08-09.** The whole mechanism — asset, 1.25 sq stretch, 55 ms trim, 220 ms dwell, its own colour field and its own tail term — is gone, not disabled. §6 | — | — |
| 6 | **Tracer / pellet fan** | `jb2a.bullet.01/02.orange`, or an ammo's own round (`rubber` → `jb2a.throwable.launch.cannon_ball.01.black`) | row names `tracer` | yes |
| ~~6b~~ | ~~**Buckshot volley**~~ | ⏪ **VETOED 2026-08-11** and switched off, not deleted. `VOLLEY.enabled: false` ⇒ the resolver answers null, buckshot draws #6 again and #9 comes back with it. §6, §3.2b | — | — |
| 7 | **Mote spray** | `jb2a.impact.006.yellow` at speck size | row names `motes` **and** payload is multi-round | yes |
| 8 | **Smoke puff** | `jb2a.smoke.puff.side.grey` | row names `smokeSingle` **and** payload is *single*-round | **no** (smoke does not glow) |
| 9 | **Hit confirmation** | `jb2a.impact.005.orange`, or one of three promoted keys (fire · ground crack · **dust puff**) | the round **hit** and the row has `impactSquares` — **delayed by that round's own arrival** (§4.2a), and drawn for a round the pacing rule refused as well as for one it drew | yes |
| 9b | **Pellet arrival marks** ⭐ *new 2026-08-11* | `jb2a.smoke.puff.ring.01.white` at **0.45 sq**, trimmed to **500 ms**, one at each pellet endpoint | the round **hit**, the class draws a **fan**, and the load does **not** set its own landing points alight (§3.2b) | yes |
| 10 | **Burning ground** | `jb2a.flames.orange.03.1x1` (Flames03, a 05x05ft ground plate), 0.9 sq, **45 s**, one flame per landing point | overlay names `groundFire` **and** ≥ 1 round landed **and** the single-target flow owns the payload — **one placement event per payload** | yes |
| ~~11~~ | ~~**Ground mark**~~ | ⏪ **REMOVED 2026-08-10** — the dark decal that used to be drawn under #10 was withdrawn on user ruling. The flames are unchanged. Revert values in the rulings log below and in the note beside `GROUND_FIRE` in `module/fx/effects.js`. | — | — |
| 13 | **Impact audio** ⭐ *new 2026-08-12* | `sounds/hit-flesh.ogg` (flesh) / `sounds/hit-sdp.ogg` (structure), native `AudioHelper`, **interface** channel, broadcast | the round **hit** and there is a target token — **delayed by that round's own arrival** (§4.2a), one per landing round, capped at **4**, refused rounds included | n/a (not drawn) |
| 12 | **Blood splash** | `jb2a.liquid.splash_side02.red`, trimmed to 900 ms, **rotated to the exit vector** | the world setting **and** the round landed **and** there is a target token **and** that token's actor is not structure — **one per landing round**, capped at 4, **refused rounds included** (§4.1a) | **yes** — a deliberate departure, below |

**The above-lighting rule.** Anything that *emits* light is routed above the lighting layer; anything
*lit by the world* stays below it. This is not cosmetic: measured on the rig at darkness 1.0, a sprite
left in the primary group crushes to a peak of 15/255 whatever the class or filter, and the same asset
reaches 232 the moment it is routed up. **The cost:** that route is above the *vision* mask too, so a
lifted sprite is drawn across ground the viewer cannot see. The engine offers no route that clears the
darkness and keeps the mask. The muzzle light is unaffected — it is a real light source and still
clips to walls, so the flash stays honest about the room even when the bolt is drawn over it.

**Where the burning ground goes (#10), which is the whole of the 2026-08-09 redesign.** A fire is put
where the *rounds* went, never on the target, and neither answer is invented:

| The class draws | Landing points are | Bound |
|---|---|---|
| a **pellet fan** (the shell, by its own class row — ⏪ and any class under a `flechette` or `stundart` load until those rows stopped naming a count, 2026-08-10 and 2026-08-11; no overlay row forces a fan any more) | a subset of the very endpoints the tracer fans to, picked evenly across the cone | `maxPerPayload` = 4 |
| **one bolt** (every other class) | one point per landed round, scattered inside a 0.8-square disc around the aim — the payload says how many rounds landed and never where, so the disc is an admission rather than a claim | `maxPerPayload` = 4 |
| a **shot pattern** (buckshot, RAW) | scattered inside the pattern polygon, beyond its first 30 %, placed when the GM **confirms** | `maxPerPattern` = 5 |

The scatter is **seeded off the payload** (`fxSeedOf` → `seededRng`), so two clients computing it agree
and a test can compute it twice. Across bursts a scene holds at most **`maxLive` = 24** flames; a
placement that would exceed it ends the **oldest** first, through the engine's own manager, which
relays the end to every client exactly as the placement was relayed.

**How the blood splash is aimed and how often it is drawn (#12), rebuilt 2026-08-09.** Both halves
of this were reversed on report and both reversals are recorded in §6.

*Direction.* The first build used `liquid.splash02.red` precisely **because** it is radial — its ink
centroid holds at 0.50/0.51 of its own frame from 170 ms to 510 ms, so it needed no rotation and could
never disagree with the shot axis. That safety is what made it wrong: a radial burst says the wound has
no direction. The shipped asset is now `liquid.splash_side02.red`, whose ink **traverses** its own frame
0.29 → 0.65 left-to-right, and it is rotated (`rotateTowards`, the tracers' own call and the tracers'
own basis) at a point **one grid unit beyond the target on the shooter→target ray**. The spray therefore
continues the round's line and leaves on the far side, as an exit. A shot with no shooter — nothing on
the rail draws one today, but the verb is callable — falls back to a random rotation rather than to a
baked heading, because a wrong direction is a worse lie than none. Capture 64a.

*How many.* One spray per **landing round**, not one per payload, capped at `maxPerPayload` = **4**.
The cap is measured rather than picked: the clip lives 900 ms and hits are the leading rounds of the
burst, so at the default 80 ms cadence ten hits would put ten sprays inside one clip's life — a fountain
rather than a body being hit repeatedly. Four are still four distinguishable arrivals, each still on
screen when the next lands. A round the pacing rule **refuses** (§4.1a) draws no spray either; the spray
is issued from the same place the arrival mark is, so the two can never disagree.

⏪ **A round the pacing rule refuses now sprays and marks anyway (2026-08-11).** The sentence above used
to read "a round the pacing rule **refuses** draws no spray either", and that was the second half of the
bench report: *"hits late in a long burst get NO blood at all"*. The drop rule is right about what it was
written for — a tracer is a sprite per pellet, every cadence slot, and a backlog of them is what put the
picture a second behind the sound — but a mark and a spray are one sprite each, at the far end of the
shot, and they are the only thing that says the round landed on somebody. The two budgets are separate
now: §4.1a. Capture 64b.

**The one departure from that rule is the blood splash (#12).** Blood is not a light source, so the
rule as written puts it below — and on the rig's own dark range that is not a dimmer effect, it is no
effect (capture 58d is the same splash routed below, and there is a smudge where there should be a
mark). The trade is therefore between an element invisible exactly where a table plays and an element
drawn over ground the viewer cannot see, and the second is the lesser cost *here only*, because this
element lives for under a second. The one element that took the other side of the same trade — a dark
ground mark that stayed below the lighting and therefore vanished on a dark range, for minutes at a
time — was removed on 2026-08-10, so the splash is now the only place the departure is taken. It is a
knob (`BLOOD_SPLATTER.aboveLighting`), not a constant in the draw path.

**What a landed round SOUNDS like (#13), added 2026-08-12.** The rail has always played the weapon's
own report from inside the fan-out loop; this is the other half — the noise at the far end of the shot.

*Two clips, chosen by what took it.* `hitSoundKindFor` asks the **same** predicate the blood splash asks
(`bearsStructuralSdp`), so structure and flesh cannot disagree about one target: a vehicle, a
powered-armour suit or a full-conversion cyborg sounds as **structure**, everything else as **flesh**.
Assets are resolved through `_deliveredSrc` exactly as the reports are, so a build that ships without
them is silent rather than broken — the audio equivalent of the missing-key skip.

*Levels, measured off the shipped files rather than off their sources.* Both candidates arrive as
Freesound MP3 previews and are transcoded to Ogg Vorbis for delivery, and the transcode moved the flesh
clip's peak by ~0.95 dB — so a gain computed from the MP3 would have been wrong by that much.

| file | peak | loudest 100 ms | duration |
|---|---|---|---|
| `hit-flesh.ogg` | −1.23 dBFS | −18.68 dB | 0.157 s |
| `hit-sdp.ogg` | −2.58 dBFS | −12.83 dB | 0.418 s |

`HIT_SOUND.structure.gain` = **1.1677** (0.8677 / 0.7431) peak-matches the two to each other, so
choosing a clip is not also choosing a loudness. `HIT_SOUND_VOLUME` = **0.55** sets both **against the
reports**: the shot assets peak at +1.88 / +0.44 / +1.45 / −0.38 dBFS and play at `SHOT_VOLUME` 0.8, so a
pistol report reaches ~0.99 of full scale and an impact reaches ~0.477 — **6.4 dB under the report of the
weapon that caused it**, which is the relationship a downrange event should have to a muzzle event the
listener already heard.

*Variation is by LEVEL, because this host has no rate.* The note on `sfx()` records at length why a
per-round playback-rate wobble cannot be delivered uniformly here (no `playbackRate`, no `detune`, and
the broadcast path discards extra fields). Volume **is** carried on both paths, so `HIT_SOUND_VARIANCE`
= `[1, 0.9, 0.96, 0.86]` is applied by round index — deterministic and indexed rather than rolled, so a
keeper asserts the ladder by value.

*The cap is the blood splash's, by import rather than by copy.* `HIT_SOUND_MAX_PER_PAYLOAD` **is**
`BLOOD_SPLATTER.maxPerPayload` (4) and moves with it. It is deliberately **not** the mark's 30: thirty
marks are thirty sprites over thirty squares of canvas and the eye reads them as thirty confirmations,
where thirty copies of one 0.16 s clip inside a two-second burst is one continuous noise.

⚠ **The rail sounds a round that LANDED, not one that PENETRATED, and that is a documented asymmetry.**
At the arrival nothing knows whether the round beat armour — penetration is computed at apply time — so
the rail uses exactly the information its two neighbouring draws already use. The **apply-side** legs,
which do know, are penetration-gated: a hit stopped dead by armour is silent there, and a hit that
routed into a cyberlimb's own SDP sounds as *structure* even on an otherwise flesh target, because
`routesToSdp` answers per **zone** where the rail can only ask about the actor.

**The three seams, and the one flag that keeps them from doubling.**

| Seam | Where | Sounds when |
|---|---|---|
| the rail | `fxWeaponFired` → `markAndBleed` | a round LANDED — delayed by that round's arrival, capped at 4 |
| personnel apply | `applyLocationDamage` (**not** `applyAreaDamages`) | `!fxSilent` **and** the round penetrated **and** it moved something |
| structure apply | `applyVehicleDamageCore` · the ACPA frame block | `!fxSilent` **and** SDP actually moved (`res.through > 0`) |

`fxSilent` is threaded by the caller and is named for what it DOES rather than for one of the two
reasons a caller has for setting it: the flow **came off a shot the rail already sounded**
(`_autoApply`, its GM-side relay, `routeWeaponFiredToVehicle`), or the apply **is not an impact at
all** — a burn or acid tick, accumulated damage becoming permanent, a radiation dose, an ACPA pilot's
overflow from a hit the suit already voiced. Each call site says which.

⭐ **The personnel leg sits one seam LOWER than it first looked.** The hand-applied damage dialog calls
`applyLocationDamage` directly, row by row, and never touches `applyAreaDamages` — so a leg placed on
the latter would have left the module's most-used manual path silent. `applyAreaDamages` only threads
the flag down.

**The un-indexed caller's bound.** The fan-out counts its own impacts and hands each one an `index`, so
it is exempt. An apply seam cannot: it walks its rows in one synchronous loop with no payload to count
against, and N un-indexed plays in a single tick phase into one smear rather than reading as N hits. So
an un-indexed call takes its index from a rolling counter that resets after `HIT_SOUND_BURST_WINDOW_MS`
(**700 ms**, a shade over the longest clip plus a reading pause) and is **refused** past the cap inside
one window — reported as `skipped: "burst"`.

⚠ **The capture seam is consulted BEFORE the host's audio state** (§9 I). An armed sink never reaches an
audio device, so it cannot care whether the context is unlocked; ordering it the other way makes a
headless keeper measure its own page — which genuinely IS locked, since a run never produces a user
gesture on the game document — instead of the element. Measured on the rig: `pageAudioLocked: true`.

---

## 2a. Condition overlays — what a figure wears while something is wrong with it

*Added 2026-08-12. `module/fx/status-fx.js`, and the keeper is
`tests/cp2020-augmented-status-fx.mjs`.*

Everything above is drawn **because a trigger was pulled**. This section is the other kind: a looping
mark that rides a figure for exactly as long as a condition is on it, and goes the moment it clears.

⚠ **The rail's one rule now reads `module/fx/`, not `module/fx/effects.js`.** The rule was always about
containment — one place a reader goes when a drawing looks wrong — and effects.js had reached 5 262
lines. The condition table lives in its own file beside it and asks every capability question through
effects.js's own answers (`sequencerActive`, `fxDbEntryExists`, `tokenRadiusPx`,
`LIT_SPRITE_ABOVE_LIGHTING`), so there is still exactly **one** adapter to the outside engine.

### 2a.1 The closed inventory — every condition this system can put on a figure

Two roads reach a figure and the resolver reads both. **The base system registers no status effects of
its own** — verified by literal-string count across every `.js`, `.json`, `.hbs` and `.css` in the
installed system: `statusEffects` 0 files, `CONFIG.statusEffects` 0, `toggleStatusEffect` 0,
`ActiveEffect` 0, `.statuses` 0, `TokenDocument` 0. Its only `CONFIG` writes are document classes and
DataModels. So a token carries **exactly Foundry core's default list**, and the module's own mechanisms
speak that same vocabulary. Read on core 14.364, 34 ids:

`dead · unconscious · sleep · stun · prone · restrain · paralysis · fly · blind · deaf · silence · fear
· burning · frozen · shock · corrode · bleeding · disease · poison · curse · regen · degen · hover ·
burrow · upgrade · downgrade · invisible · target · eye · bless · fireShield · coldShield · magicShield
· holyShield`

| Marker | Detection source | Written by | Value domain | Treatment |
|---|---|---|---|---|
| **Dead** | condition id `dead` | `DamageApplicator.js:182` · `save-rolls.js:404,428` (death save) · `mech/borg.js:342` | present / absent | ✅ **ships** |
| **Unconscious** | condition id `unconscious` | `save-rolls.js:373` (failed stun check), lifted again at `:572` by the recovery check | present / absent | ✅ **ships** — as the *stunned* row, because this engine's stun outcome IS `unconscious` |
| **Stunned (hand-set)** | condition id `stun` | nothing in the module — a GM's own token-HUD toggle | present / absent | ✅ **ships**, same row |
| **On fire** | `flags.cp2020-augmented.fireDotState` | `damage-hooks.js:1436-1493` (per-turn burn, HP) | array of `{location, turnsLeft, formula, mult}`; absent or `[]` = not burning | ✅ **ships** |
| **Burning (hand-set)** | condition id `burning` | nothing in the module | present / absent | ✅ **ships**, same row |
| **Acid / armour degradation** | `flags.cp2020-augmented.dotState` | `damage-hooks.js:1389-1425` (per-turn SP loss) | array of `{location, turnsLeft, …}`; absent or `[]` = clear | ✅ **ships** |
| **Corroding (hand-set)** | condition id `corrode` | nothing in the module | present / absent | ✅ **ships**, same row |
| **Poisoned** | condition id `poison` | **nothing** — no module mechanism produces poison today | present / absent | ✅ **ships** (the core id only) |
| **Wound state** | `actor.woundState()`, derived `Math.ceil(system.damage / 4)` — a METHOD, there is no `system.woundState` | base system `actor/actor.js:509-514`; the only write site for `system.damage` is `actor-sheet.js:532-537` | integer 0–10: 0 unhurt · 1 Light · 2 Serious · 3 Critical · 4–10 Mortal 0–6 | ⚠ **no treatment — awaiting the user's call** |
| **Taser / stun accumulation** | `flags.cp2020-augmented.taserState` | `damage-hooks.js:1712` | `{count, round, mod}` | ⚠ **awaiting call** |
| **Choking** | `flags.cp2020-augmented.chokeState` | `damage-hooks.js:1506-1512` | `{formula, …}` | ⚠ **awaiting call** |
| **Stabilized** | `flags.cp2020-augmented.stabilized` | `save-rolls.js` (successful stabilization roll) | `true` / absent | ⚠ **awaiting call** |
| **Radiation — current exposure** | `flags.cp2020-augmented.radExposure` (+ `radHistory`, `radBandCrossed`, `radExposureSeq`) | `radiation/radiation.js:388-391` | numbers (rads) | ⚠ **awaiting call** |
| **Radiation — stat loss** | `flags.cp2020-augmented.radState` | `radiation/radiation.js:288,489,582` | marker array, each tagged `{seq}` | ⚠ **awaiting call** |
| **Drugged** | `flags.cp2020-augmented.drugState` | `mech/drug.js` (`DRUG_FLAG`) | marker array | ⚠ **awaiting call** |
| **Addicted** | `flags.cp2020-augmented.addictionState` | `mech/drug.js` (`ADDICTION_FLAG`) | marker array | ⚠ **awaiting call** |
| **Consumable timer running** | `flags.cp2020-augmented.consumableState`, **plus** a real inert `ActiveEffect` carrying `flags.cp2020-augmented.consumableItemId` | `mech/consumable.js:98-133` | marker array / one effect per running item | ⚠ **awaiting call** — this one already draws core's own icon on the token |
| **Flesh limb lost** | `flags.cp2020-augmented.fleshLimbStatus` | `DamageApplicator.js:200,221`, `mech/cyberlimb.js` | per-limb status map | ⚠ **awaiting call** |
| **Cyberlimb SDP damage** | `system.sdp.current.<zone>` vs `system.sdp.sum.<zone>` | base system `actor-sheet.js:327-336` | integer per zone; `0` = destroyed **by convention only — the base draws no conclusion from it** | ⚠ **awaiting call** |

**Recorded as NOT conditions**, so the list above is closed rather than merely long: the combat-posture
flags (`dodging`, `parrying`, `aimRounds`, `waitingForTurn`, `waitingAfterId`, `actionCount`,
`actionCountRound`) are one action's bookkeeping, not a lasting state; `preStunMovement` is the saved
walk speed the unconscious lock restores; and `fullBorg`, `ammoTracking`, `loadout`, `visionPick`,
`mechBaseLight`, `mechBaseSight`, `origMountZone`, `originX/Y`, `damagePayload`, `reputation` are
configuration or transport. **Cyberpsychosis has no marker of any kind** on either side — there is
nothing to detect.

⛔ **Why the awaiting-call rows have no look.** The user's instruction was that conditions which do not
read straight across from the source material get adapted **with** them. Inventing a picture for
"addicted" or "wound state" is the thing that instruction exists to prevent, so those rows sit in §8 as
calls rather than in the table as guesses. Each is **one row** in `STATUS_FX_ROWS` when a call arrives —
a table entry, not a code change.

### 2a.2 The five shipped rows — THE RING STANDARD (reworked 2026-08-12)

**User ruling 2026-08-12: "All of our effects should look like this ring effect."** The reference
setup dresses its conditions as a ring riding the figure's rim (its "On Fire" tiers are the JB2A
`shield_themed` fire rings: Mild = below-token, Strong = above-token, Deadly = both at `_03`, the
one tier that is patreon-gated). Every non-ground row is a **ring** now; the 2026-08-11 centered
flame / badge treatments are superseded, each row's old key recorded at its site as the revert.

| Row | Raised by | Database key | Placement | Size / opacity |
|---|---|---|---|---|
| `burning` | `burning` · `fireDotState` | `jb2a.shield_themed.below.fire.01.orange` | **ring**, above lighting | `scaleToObject` 1.18 (= 400/339 ink), opacity 0.85 |
| `poison` | `poison` | `jb2a.markers.smoke.ring.loop.bluepurple` **recoloured** | **ring**, above lighting | `scaleToObject` 1.0 (ink is full-frame), opacity 0.85 |
| `acid` | `corrode` · `dotState` | `jb2a.shield_themed.below.molten_earth.01.orange` **recoloured** | **ring**, above lighting | `scaleToObject` 1.05 (= 400/382), opacity 0.8 |
| `stunned` | `stun` · `unconscious` | `jb2a.shield_themed.below.eldritch_web.01.dark_purple` | **ring**, above lighting | `scaleToObject` 1.25 (= 400/320), opacity 0.9 |
| `dead` | `dead` | `jb2a.markers.simple.001.loop.001.red` | **ground**, below tokens | `scaleToObject` 1.25, opacity 0.55 — already a ring; unchanged |

**Every key was decoded before it was chosen** (§9 A/4). The ring set, read off the installed clips
(thirds = mean luminance per clip third; seam = |first − last| frame):

| Clip | Frame | Duration | Thirds | Seam | Verdict |
|---|---|---|---|---|---|
| `shield_themed.below.fire.01.orange` | 400×400, ink 339×345 | 5000 ms | 28.3 / 30.6 / 26.5 | 5.39 | ✅ **taken** — flat across its thirds; the flame flicker masks the seam |
| `shield_themed.above.fire.01.orange` | 400×400, ink 358×361 | 5000 ms | **60.2 / 49.9 / 40.9** | 7.48 | ✗ as a loop — it DECAYS across its own clip and pulses every 5 s. Kept on record as the "stronger tier" one-key swap, carrying this caveat |
| `shield_themed.below.molten_earth.01.orange` | 400×400, ink 382×384 | 5000 ms | 31.0 / 31.9 / 31.0 | **2.59** | ✅ **taken**, recoloured — the cleanest loop of the set |
| `shield_themed.below.eldritch_web.01.dark_purple` | 400×400, ink 320×317 | **10042 ms** | 47.6 / 47.6 / 47.5 | 2.87 | ✅ **taken** — dead flat, native purple, longest loop of the set |
| `markers.smoke.ring.loop.bluepurple` | 400×400, ink full-frame (30 fps) | 5067 ms | 56.9 / 56.9 / 54.5 | 5.05 | ✅ **taken**, recoloured toward green |
| `shield.01.loop.blue` | 400×400, ink 328×332 | 4033 ms | 75.8 / 75.3 / 77.7 | **0.45** | ○ the glass-dome sheen on its own — not layered in v1 (the shield_themed rings carry their own sheen); recorded as the layering option |

Superseded decodes (the 2026-08-11 table: `flames.02.orange`, `flames.01`, `flames.orange.03.1x1`,
`markers.stun.purple.02`, `dizzy_stars`, `markers.poison.dark_green.02`, `bubble.002/001`) remain in
git history at this section; their verdicts still hold for what they measured.

**Two colours are ours, not the assets'.** Acid: hue **−120**, saturate +0.15 rotates the molten
orange to green. Poison: hue **+130**, saturate +0.1 rotates the smoke ring's blue-purple to a fume
green. Reverting either is deleting one field.

**Reference-fidelity note.** The reference draws its `Below` ring UNDER the mini; ours rides above
the token so `aboveLighting` keeps it visible on unlit squares (the rail's standing visibility
ruling). `below: true` on a row is the reference-exact revert — at the cost of vanishing in
darkness, the dead row's documented trade.

### 2a.3 Stacking, and the rule that stops marks from sliding

Three placement families, each with its own answer, because one offset scheme for all of them would put
a badge on a figure's chest or a flame on the floor:

- **ring** (the house standard since 2026-08-12) — `scaleToObject` at the row's ink-fraction scale,
  **centred, no slot offset**: rings stack CONCENTRICALLY, and their differing rim scales (1.0 /
  1.05 / 1.18 / 1.25) are what keep simultaneous conditions apart. All four non-ground rows use it.
- **body** — `scaleToObject`, nudged sideways by `bodySpread` (**0.22**) × the figure's own width.
  No shipped row uses it since the ring rework; the family and its constant stay for a future row
  that is genuinely a body treatment.
- **badge** — a fixed **0.55 sq** mark, `badgeSpacing` **0.42** apart, sitting `badgeRise` **0.30**
  above the figure's own top edge. Also unused since the rework; kept for the §8 rows whose
  eventual look may be a badge.
- **ground** — centred, no offset (the dead row).

⭐ **A slot belongs to a ROW, not to draw order.** `statusFxOffset` is a pure function of the row id, so
a figure that gains a third condition does not shuffle the two it is already wearing. Reordering
`STATUS_FX_ROWS` is what moves marks on screen, and that is the only thing that does.

**One suppression rule ships:** `dead` cancels `stunned`. These genuinely stand together — the
applicator sets `dead` while the stun check had already set `unconscious` — and stars over a body is
noise. It is one field (`suppressedBy`).

### 2a.4 Lifecycle — mutation points, never a timer

| Event | Hook | What it does |
|---|---|---|
| a core condition arrives or goes | `createActiveEffect` · `updateActiveEffect` · `deleteActiveEffect` | reconcile every figure that actor is drawn as |
| a module flag is written | `updateActor` (`setFlag` **is** an actor update) | same |
| an unlinked figure's own state changes | `updateToken` | reconcile that figure |
| a figure arrives already marked | `createToken` | reconcile that figure |
| a figure is deleted | `deleteToken` | sweep **by name** — the placeable is mid-destruction and is never read |
| a scene is drawn | `canvasReady` + the catch-up below | reconcile every figure on it |
| a scene goes | `canvasTearDown` | end everything |
| an overlay ends by itself | `endedSequencerEffect` | re-issue if the condition is still there |

Nothing polls. **Every entry point calls one reconciler** (`syncTokenStatusFx`) which recomputes the
answer from the condition rather than tracking add/remove events, so a missed hook, a reload, a scene
change and a GM clearing a status by hand all converge on the same picture instead of each needing its
own branch. It is also what makes running it twice free.

⭐⭐ **THE CATCH-UP, AND WHY IT HANGS ON THE ENGINE'S SIGNAL** — the finding of this unit. Measured hook
order on a real load:

```
   canvasReady    @ +0 ms      ← the redraw a reload needs … before this file exists
   ready          @ +12 ms     ← where the module registers, and where a naive catch-up would run
   sequencerReady @ +677 ms    ← where the effect engine can actually draw
```

`canvasReady` fires during game setup, **before** the module's ready hook, so the listener is registered
too late to hear the load that installed it — the known register-plus-catch-up shape
(`module/chat-render-compat.js`). But a catch-up taken at `ready` is **also wrong, in the other
direction**: `sequencerActive()` is already true there (the module is active and its constructor
exists), so the sweep does not bail — it queues work against an engine that is not up, the work is
silently lost, and the screen looks exactly as it did before the fix. Hanging it on `sequencerReady`
puts it after both. Caught by the reload leg of the keeper, which failed twice for these two different
reasons before it passed.

### 2a.5 Budget, and what is deliberately not spent

- **No document is written.** Sequencer's own `persist()` writes the effect into the **scene's flags**,
  which is a document write from presentation (§9 G/22). Measured on the rig: an attached, named,
  duration-bounded effect leaves `scene.flags.sequencer` with **zero** keys and is still queryable and
  endable by name. The keeper asserts that count is 0 with two overlays live and again before a reload.
- **Lifetime `lifetimeMs` = 600 000 ms**, and it is not the condition's lifetime — a condition can
  outlast any clip, so the overlay is re-issued when the engine reports it ended while the condition
  still stands. Ten minutes is rare enough to be invisible and short enough that a leak cannot outlive
  a session. It is a cap, exactly as the burning ground's 45 s is.
- **Scene cap `maxLive` = 60** (five rows × twelve figures), enforced by ending the **oldest** through
  the engine's own manager, with the **pending** tally counted against it — the same construction, and
  the same reason, as `GROUND_FIRE`. ⚠ An evicted overlay is **not a lost condition**: the next event
  touching that figure redraws it, because the reconciler always recomputes from the condition.
- **Excluded from the settle signal**, by construction: nothing here takes a `settleTag` and
  `presentationTailMs` takes no term for it. An overlay meant to outlive the action is scene dressing in
  exactly the sense the 2026-08-08 ruling names.
- **Everyone sees them, with no GM gate.** These are state visibility, not a GM's secret, and every
  condition with a shipped row is already public: core draws its own status icon for every client, and
  the module's lasting-damage cards post to chat. **There is no GM-only condition on this system to
  mirror** — the survey found none.
- **Attached, not planted** (`attachTo`, `followRotation: false`), so a figure that walks carries its
  condition and a badge stays upright when the rail turns a token to face a shot.

---

## 2b. The medical-extraction arrival — a referee-placed sequence

*Added 2026-08-12. `module/fx/trauma-team.js` (the sequence) and `module/fx/trauma-team-tool.js` (the
gesture); the keeper is `tests/cp2020-augmented-trauma-team.mjs`.*

Neither of the two kinds above. §2 is drawn **because a trigger was pulled**; §2a is drawn **because a
condition is on a figure**. This one is drawn **because a referee asked for it** — a set piece, placed
by hand, that runs a ladder and then leaves something standing.

### 2b.1 What it is

The reference the user described, and its five facts are rulings rather than build-lane choices:

1. an animated **rectangular** landing area with caution marks and a holographic border, pulsing;
2. an aircraft **descends from off frame** onto it;
3. it **HOVERS — it never lands** — through roughly **four circular pulses**;
4. **five figures unload ONE AFTER ANOTHER**;
5. the sequence **ends with the aircraft still on station**.

A second use of the control sends it back up (reverse ascent). Everything else in this section is a
number, and every number is one constant listed in §8.

### 2b.2 ⛔ It draws a picture, and only a picture

The five figures are **sprites, not documents**. No actor is created, no token is placed, no region is
written, and the scene's own flags are untouched from the first frame to the last — the keeper asserts
region / tile / token / drawing counts and `scene.flags.sequencer` on both sides of a full run. This is
standard §G/22 taken without an exception.

⛔ **THE SCOPING CALL, made in the build lane and flagged for the user (§8).** The reference shows five
*people*. A table that wants five figures it can move and roll for wants **documents**, which is a
different feature with its own questions (which actors? owned by whom? cleaned up when?) and it belongs
to whatever builds non-player figures, not to a presentation rail. v1 ships the cinematic only.

### 2b.3 The ladder

One **anchored schedule** — every phase is an absolute offset from the placement instant, so a late
timer cannot push the ones after it (standard §D/11).

| ms | Phase | What is drawn |
|---|---|---|
| 0 | marked area | the ground plate + four caution marks, on their own beat |
| 900 | descent begins | the airframe, and the descent cue |
| 1800 | downdraft | blown dust under the arrival |
| 3100 / 3600 | dust rings | two puff rings at touchdown height |
| 3500 | on station | the descent ends; station-keeping begins |
| 3700 / 4900 / 6100 / 7300 | the four rings | one expanding ring each |
| 4600 / 5300 / 6000 / 6700 / 7400 | the five figures | one mark each, stepped across the far edge and progressively further out |
| — | end state | the plate, its marks and the airframe **remain** |

`landingLadderMs()` = **10 050 ms**, which is the last *ring's* content end rather than the last
figure's — over-stating, which is the safe direction for the same reason the shot rail's tail
over-states.

### 2b.4 The composition, and why each key

Free tier only; 2 061 installed keys were enumerated before anything was chosen.

| Part | Key | Why |
|---|---|---|
| plate | `jb2a.zoning.outward.square.loop.bluegreen.01` | the tier's only asset that is both rectangular and holographic, with a border that travels outward on its own loop. Parent key → two variants, randomised per placement |
| caution marks | `jb2a.markers_scifi.001.loop.001.orangeyellow` | amber IS the caution read; the family's other eight colourways say magic |
| airframe | *engine-native shape* | **no aircraft art exists** in this module, the base system or the free tier |
| downdraft | `jb2a.smoke.plumes_loop.01.grey` | a grey billowing loop — air pushed onto the ground, seen from above |
| dust | `jb2a.smoke.puff.ring.01.white` | the shot rail's own arrival dust (`IMPACT_DUST`), reused rather than re-picked |
| rings | `jb2a.zoning.outward.circle.once.bluegreen.01` | concentric arcs travelling outward; the plate's own family, so ring and pad read as one system |
| figures | `jb2a.token_stage.round.blue.01` | purpose-built for a figure *taking its place*; parent of six variants, so the five differ for free |

⚠⚠ **TWO KEYS WERE PICKED BY NAME AND BOTH WERE WRONG.** This is standard §A/4 ("decode, don't guess")
earning its place a second time, and both were caught by *looking at a rig capture*, not by reading:

- `jb2a.template_circle.out_pulse.01.burst.bluewhite` — sounds like an outward pulse; decodes as **a
  ring of musical notes**. It is a dance effect. It went into a real capture before it was seen.
- `jb2a.wind_stream.white` — sounds like a downdraft; decodes as a full-bleed field of **horizontal**
  white streaks with no transparent ground, i.e. wind blowing *across* the map. It would have carpeted
  the scene.

**Ink fractions were measured, not assumed** (max extent over every frame, 10 % threshold):

| Clip | Frame | Duration | Ink | Fraction |
|---|---|---|---|---|
| `ZoningSquare01Out_…_Loop` | 600×600 | 3 042 ms (73 @ 24 fps) | 536×537 | **0.893 × 0.895** |
| `ZoningCircle01Out_…` | 600×600 | 2 750 ms (66 @ 24 fps) | 536×534 | 0.893 × 0.890 |
| `MarkerScifiLoop001_…OrangeYellow` | 600×600 | 3 000 ms | 600×600 | 1.000 |
| `SmokePlumesLoop01_01` | 400×400 | 2 000 ms | 241×234 | 0.603 × 0.585 |
| `SmokePuffRing01_01` | 400×400 | 1 067 ms | 390×398 | 0.975 × 0.995 |

The plate and the downdraft are therefore drawn to `size / inkFraction`, so their ink lands on the
rectangle rather than inside it. Drawn at face value the plate's border reached only **0.73** of the
marked area mid-travel — visible in the first capture, and the reason `zoneInkFraction` exists.

The rings are spaced **1 200 ms** apart against their own **2 750 ms** clip. At the first pick (900 ms)
three rings were on screen at once and it read as churn rather than as four waves.

### 2b.5 The airframe, and the engine finding that shaped it

There is no aircraft art anywhere available to this module, and this rail does not source art of its
own (§8 carries the asset ask). So the airframe is an **engine-native shape** — a dark rounded lozenge
with a lit edge, which is what a top-down camera sees of a planform. With real art it becomes one
`.file()` call and the shape goes.

⭐ **MEASURED ENGINE FINDING: shapes are drawn from their TOP-LEFT.** The installed build's
`drawRect(offset.x, offset.y, w, h)` treats the offset as the corner, so an uncorrected body sits a full
half-width right and half-length down of the point it was given — photographed on the rig with the hull
hanging off the corner of its own pad. `anchor` **is declared in the engine's typings but is not applied
to the RECT / RREC cases**; only ELLIPSE is centre-drawn. The correction is half the body, negative, in
grid units, and it lives at one site (`airframeShape()`) because two calls draw the hull.

**The flight is `animateProperty`, not the travel verb.** The engine's move takes a speed, which would
have to be back-solved from a distance; `animateProperty("spriteContainer", "position.y", …)` takes the
duration the ladder already states. Station-keeping then rides the **sprite inside that container**
(`loopProperty`, ping-pong, delayed to the descent's end), so the two never contend for one property.
Both are individually guarded — a host without one still puts the airframe on station.

### 2b.6 Sound — one beat shipped, the bed recorded as missing

The shipped library was measured, not skimmed:

| file | dur | centroid | head/mid/tail rms |
|---|---|---|---|
| `fx-scifi-whoosh.ogg` | 0.54 s | **197 Hz** | 0.858 / 0.580 / 0.104 |
| `rocket-launch.ogg` | 1.41 s | 6 827 Hz | 0.200 / 0.056 / 0.002 |
| `shockwave.ogg` | 1.41 s | 668 Hz | 0.285 / 0.438 / 0.094 |
| `fx-flamethrower.ogg` | 1.92 s | 1 317 Hz | 0.138 / 0.167 / 0.026 |

One fits one beat: `fx-scifi-whoosh` is the lowest thing in the library and decays head-to-tail — a
heavy mass passing overhead, i.e. the descent. It plays there at 0.5.

⛔ **What is NOT there and is not faked: a station-keeping bed.** Every candidate decays to silence;
there is no rotor or turbine LOOP in the library, and the sequence's longest phase is a machine hanging
in the air. The hover is silent and the ask is in §8. **No audio was sourced for this unit.**

The locked-context guard is taken here rather than deferred: a cue that fires on the viewer's next click
instead of on the arrival is worse than silence on a cinematic.

### 2b.7 The long-lived contract, and what survives what

All three of standard §G/21, and the shape is the condition overlays' exactly:

- **cap** — one placement at a time; a second replaces the first. Its part count is resolved *before*
  anything is queued (18 parts) and the cap is asked once.
- **`maxLive` 40** with oldest-out eviction **through the engine's manager**, pending counted, released
  in `finally`.
- **one stamped prefix** (`cp2020-augmented.traumateam.<placement>.<part>`) so the census is a **query
  of the engine**, never a ledger of ours.
- **`lifetimeMs` 600 000** is a leak bound, not the sequence's life. A part that reaches it ends, the
  engine reports it, and the reconciler re-issues — the intentional-end register is what stops a
  departure or an eviction from undoing itself.

**Nothing is persisted.** The record of what is on station lives in each client's memory, so a scene
change and a canvas rebuild are recovered and a **full reload is not** (§8). ⭐ The catch-up hangs on
`sequencerReady`, not `ready` — the +0 / +12 / +677 ms ordering measured for the condition overlays
applies unchanged, and a sweep at `ready` queues work against an engine that is not up yet.

**Sync**: one socket announcement, dispatched by type on the module's standing channel. The referee's
client emits and draws its own copy locally (an emit never echoes to its sender), every other client
draws from the announcement. No active-referee election, because nothing is written.

### 2b.8 The entry surface

One momentary button on the **token** scene-control group — the df-active-lights idiom the radiation
tools and the cover placement already use: augment an existing group, never invent a canvas layer.
**Referee-gated twice**: `addTraumaTeamTool` refuses to render it, and `onTraumaTeamTool` refuses to
act. The API (`game.cpAugmented.traumaTeam.land/end/active/state`) is gated the same way, because an API
is a door too.

The button is a toggle in *behaviour*, not in state: nothing on station → arm the placement ghost;
something on station → send it away.

⭐ **Review·Shooter parity** is satisfied by construction rather than by a bench row. The standing rule
is that every shipped element must be reachable from the bench; this element is not payload-driven, so
a firing range cannot reach it — its trigger IS a one-click control that is present on every scene for
every referee, which is a lower bar to exercise than any bench gun. Nothing needs provisioning: open a
scene, press the button, click.

The ghost is `combat/spread-placement.js`'s shape — a world-space PIXI outline, window-level **capture**
listeners so the confirming click cannot be eaten by a placeable, right-click / Esc cancel, a
`canvasTearDown` safety net, and the scene's own grid snap. It draws the rectangle by **importing**
`landingRect` rather than copying it, so what the referee aims is what the module puts down. It spends
nothing and writes nothing at either end.

### 2b.9 Settle

The whole element is **excluded** from the shot rail's settle signal and carries no tail entry: it is
scene dressing in exactly the sense that ruling names (standard §E/14), no damage window waits on it,
and it is never queued from a payload.

### 2b.10 What the keeper pins — `tests/cp2020-augmented-trauma-team.mjs`, 62 legs

**By value:** the control is added for a referee and **refused** without the flag, with nothing written
into the group, and the handler refuses again at the action layer · the rectangle, its four corners in
order, the offscreen entry point and the five stepped exit points as **numbers**, all scaling with the
grid, all computed twice and identical · the ring and figure ladders as numbers, with the five instants
asserted **strictly increasing** and the five places asserted **distinct** (the one-after-another ruling
is a value, not a comment) · every shipped key asserted **resolving on the installed tier**, so a
paid-tier or renamed key is caught here rather than by showing nothing.

**Driven live**, with the whole ladder compressed through the capture seam: the exact 18-part queue in
order · the plate and marks up *before* the airframe arrives · the plate, its marks and the airframe
still there when the ladder has finished · every part stamped under the one prefix.

**The negatives and the guards:** master switch off → `{queued: [], skipped: "disabled"}` and nothing
drawn · every key absent (through the rail's own database seam) → the asset parts skip silently and the
engine-native hull still marks the spot · **zero document writes**, asserted as region / tile / token /
drawing counts and `scene.flags.sequencer` on both sides · the re-issue (a part ended by nobody comes
back, exactly one) · the rebuild driven through the **real hooks** — `canvasTearDown` takes every sprite
away, the record survives it, and `sequencerReady` rebuilds the standing half and **only** it, one of
each, with a sweep straight after adding nothing · the departure leaving nothing under the prefix · a
clean rig · 0 console errors.

Siblings re-run because `effects.js` gained one export: `cp2020-augmented-fx-rail.mjs` **823/823**,
`cp2020-augmented-review-bench-smoke.mjs` **36/36**, `cp2020-augmented-b1-seam-payload.mjs` **28/28**.

---

## 3. The tables

### 3.1 Weapon classes — `FX_CLASSES`

Resolution is by weapon **type**, never by item name. Shotgun-ness is read from the *attack* type
(`Shotgun` / `Autoshotgun`) **before** the type map, because base data types shell weapons as `Rifle`
so they take the Rifle skill.

| Class | Tracer | Muzzle | Impact (sq) | Cadence | Distinctive |
|---|---|---|---|---|---|
| `pistol` | bullet.01 | 1.1 sq lance | 0.70 | 80 ms | 8 motes |
| `smg` | bullet.01 | 1.2 sq lance | 0.75 | 80 ms | 12 motes |
| `rifle` | bullet.02 | 1.6 sq lance | 0.95 | 80 ms | 13 motes |
| `shotgun` | bullet.01, `tracerColor: null` | **1.9 sq lance, 220 ms dwell** | 1.15 | **180 ms** | 6 pellets @ 0.07 rad, **0.7 sq** dashes crossing in 150 ms, per-pellet jitter (§3.2b), single-shot smoke |
| `heavy` | bullet.02 | 2.1 sq lance | 1.30 | 80 ms | 16 motes |

Sizes are in **grid units**, not scale factors — the same fraction of a square on any scene.

Optional row fields: `pellets`, `spreadRad`, `dashSquares`, `dashMs`, `cadenceMs`, `soundBurst`,
`spark`, `tracerColor`, `motes`, `smokeSquares`, `smokeSingle`, `muzzleMs`, `impactKey`,
`impactClipMs`. A row that omits one simply does not get that treatment; **no branch anywhere in the
file names a specific class.** ⏪ `column` and `columnColor` were removed from this vocabulary on
2026-08-09 with the element they described.

**The shell's lance, restored (2026-08-09).** FR#22 had taken it off this row because it sat as a second
flame under the discharge column's bloom; with the column deleted that reason went with it, and the
shell draws its discharge exactly the way the other four do. Two numbers are worth stating:
- **`muzzleSquares: 1.9`** — a drawn width in grid units, so the ladder across the table *is* the read:
  pistol 1.1 → smg 1.2 → rifle 1.6 → **shell 1.9** → heavy 2.1. Measured on the rig at grid 100 px, the
  five lances draw at 110 / 120 / 160 / **190** / 210 px, i.e. the number is the spec and not an
  approximation of one. A 12-gauge bore is roughly three times a 5.56's and the load leaves as an
  expanding blast rather than a jet, so the shell has to read heavier than the rifle; it sits one notch
  under the 20 mm because that weapon is a cannon and this one is not. Capture **67d**.
- **`muzzleMs: 220`** — the single-discharge dwell FR#21 ruled, delivered as a playback **rate** of 0.5
  over the same 110 ms trim. It is the only row that names one; the other four play at rate 1.

**The 01/02 randomisation is the database's, not ours.** `jb2a.muzzle_flash.single.01.yellow` resolves
to **two** files on the installed free tier — `MuzzleFlashSingle01_01_…` and `…_02_…`, both 833 ms,
differing in shape rather than in clock (the front edge reaches 0.68 of frame on 01 and 0.55 on 02) — so
naming one key delivers the user's *"randomize between 01 and 02 on each shot"* with no alternation
machinery of our own. Verified against the install rather than assumed, and pinned by a keeper leg that
counts the files under the key.

**Omitted is not the same as `null`.** For the recolour field the difference is load-bearing: omitting it
means "this class has no such element, and no overlay may give it one"; `null` means "the element exists
and is repaintable, and the class paints it with nothing". The shell row uses `tracerColor: null` so that
ordinary buckshot carries no colour shift while an ammo overlay reaches the pellets. That ruling
**outlived the column it was reported against** — it was always about the mask, never about which two
elements the mask happened to reach. See §3.2.

### 3.2 Ammo overlays — `AMMO_FX`

Keyed by the loaded ammo's `system.modifier` (lookups.js `AMMO_MODIFIERS`). The overlay is merged over
the class row; ammo that names no row draws exactly what the class drew before this table existed.

The **Tracer** column below means every element the class *declares* as repaintable. On the four
single-bolt classes that is the bolt; on the shell it is the pellet fan.

⭐ **THE REALISM RAZOR (user ruling, 2026-08-09): a load gets a visual only if you could plausibly see
the difference.** Two rows were **deleted** under it rather than retuned, and one was rebuilt:

| Row | Was | Now |
|---|---|---|
| `hollowPoint` | `impactScale` × 1.60 | ⏪ **deleted.** Nobody reads a hollow-point off the width of a mark |
| `safety` | `impactScale` × 0.55 | ⏪ **deleted.** Same reason |
| `stundart` | byte-identical to `rubber` | ⏪ **rebuilt as a grey dart.** A baton round is a fat blunt slug and a stun dart is a needle — drawing them alike was the visible error. (It was rebuilt as a *fan* and stopped being one on 2026-08-11 — §6, the single-file ruling; the look is what that pass bought and the look is what stayed) |
| `slug` | *(no row — it inherited the shell's six-pellet fan)* | ⭐ **new: one painted `bullet.02` bolt.** A slug was being drawn as buckshot |

The mechanics of every one of these are **untouched** — nothing in any damage path has ever read this
table — so only the pictures changed. Bench guns 02 and 03 now draw identically to 01, which is the point
of those rows rather than a regression in them, and `impactScale` remains a live field (`flechette` uses
it), so restoring either deleted row is one line.

| Modifier | Tracer | Impact | Impact width | Fan | Light | Ground |
|---|---|---|---|---|---|---|
| `standard`, `brassCased` | — | — | — | — | — | — |
| `api` | red-shifted (hue **−14**, sat +0.30, bright 1.20) | class default | class | — | **tinted `#ff6a1a`** (dark only) | fire (⏪ the mark under it was removed 2026-08-10) |
| `ap` | ⏪ **none — it flies exactly like standard** (2026-08-11, the razor; the withdrawn matrix was hue 8, sat −0.85, bright 1.45) | ground crack | class | — | — | — |
| `dualPurpose` | *identical to `ap`* | ground crack | class | — | — | — |
| `slug` ⭐ | **the round is a different asset** — `bullet.02`, **painted** (`dashSquares: 0`), in the standard shift | class default | class | **`pellets: 1`** — no fan at all | — | — |
| `flechette` | **grey dart** (hue 0, sat **−0.90**, bright 1.15) | class default | × 0.70 | ⏪ **none of its own** — 1.1 sq / 170 ms per round, **one per cadence slot** on a single-round class, the class's own count on a class that draws a group (2026-08-10) | — | — |
| `stundart` ⭐ | *identical to `flechette`* | class default | × 0.70 | ⏪ **none of its own** — same removal, same reason, 2026-08-11: one dart per cadence slot on a single-round class, the shell's own six at 0.07 rad on a shell. (Was **8 @ 0.10 rad**, mirrored from `flechette` until 2026-08-10 and stated here until 2026-08-11) | — | — |
| `rubber` | **the round is a different asset** — `cannon_ball` slug, travelled 2.4 sq / 240 ms; repainted colourless-but-brighter (hue 0, sat −0.85, **bright 1.30**) | **dust puff** | class | count/spread unchanged, size and speed replaced | — | — |
| ~~`hollowPoint`~~ / ~~`safety`~~ | ⏪ **rows deleted** — both resolve to the class row itself, by identity | | | | | |

Arrow loads (`broadhead`, `spinner`, `target`) have no rows: there is no bow FX class yet.

### The dart language — grey is darts, orange is balls and bullets

A **rule**, not one row's tuning, and it is the whole of what the `stundart`/`flechette` pass bought.

The free tier ships exactly one projectile family and it is orange. So a group of darts and a group of
shot were the same picture with a different count — and at the 150–170 ms these things cross in, a count
is not a difference a viewer can take. Colour is the one axis on this rail that separates them inside a
single frame, and it is also the load's own true statement: a flechette or a needle-dart is a bare metal
spike, where shot and bullets leave a barrel glowing.

⭐ **The rule carries the whole load since 2026-08-11.** With the single-file ruling (§6) the `flechette`
row stopped naming a count on 2026-08-10 and the `stundart` row followed on 2026-08-11, so **neither dart
row names one** — on a class that fires one round per slot the colour, the length and the smaller mark
are the *entire* difference between a dart and a bullet, and on a shell the two dart loads and buckshot
all draw the same six marks, separated by nothing but this colour. The count used to do part of that work
and now does none of it, which is why the grey is a rule rather than a preference.

`TRACER_COLOR_DART` = **hue 0, saturate −0.90, brightness 1.15**, and every number in it is doing
something:

- **saturate −0.90** is the strongest desaturation on the rail (against the class shift's −0.35, the
  baton's −0.85 and the hardened load's −0.85). It is what takes the fire out of an orange bullet sprite.
- **brightness 1.15 sits ABOVE 1**, and that is deliberate rather than incidental. The rejected rubber
  treatment pulled a round to 0.60 and the ruling was that a dimmed sprite on a dark scene is not a
  quieter round, it is a round the eye has to hunt for. What is taken out here is the colour; the light
  is left in and lifted a little, so a needle reads as cold bright metal.
- **its own constant**, not a reuse of `TRACER_COLOR_BATON` (0 / −0.85 / 1.30), which is numerically
  close. The two say different things and are allowed to drift apart: the baton matrix repaints a solid
  greyscale slug and is tuned to lift *that* asset off a black floor, while this one repaints an orange
  bullet and is tuned to take the fire out of it. One shared constant would make a later change to
  either silently change the other.

What stays orange: buckshot (unpainted), the slug (standard shift), and every bullet class. Captures
**67f** (stun dart), **67g** (flechette), **67x** (buckshot control) and the **67fgh** triptych.

### 3.2b The buckshot fan, and the volley that was vetoed

⏪⏪ **THE TRIAL IS OVER — VETOED 2026-08-11** at the bench. The verdict, in the user's terms: *"the
visible bullets and long trails are a problem"* — buckshot is small balls thrown in an irregular grouped
spread, and `jb2a.volley_of_projectiles_Line.bullet.001.001.orangeyellow` draws **aligned side-by-side
lanes of long-trailed rounds**, which reads as a rank of rifle fire rather than as a shot pattern. The
instruction was *"choose a new asset for buckshot or go back to what we had"*, and the half that was
praised was kept: *"the arrival fireballs were GREAT"* — scaled down by at least half and moved onto the
fan's own pellet endpoints.

**The whole mechanism is SHELVED, not deleted.** `VOLLEY.enabled: false` ⇒ `volleySpecFor` answers null
at every distance, `volleyOwns` answers false for every cartridge, and every downstream site falls
**through** to the pellet fan it was always written to fall through to — including the hit mark `fxShot`
suppressed while the trial ran. Restoring the trial is that one field and nothing else: the key, the
band mirror, the crossing/tail tables, the jitter and the mirror flip all stand, and a keeper leg drives
the shelved branch with a hand-built spec so the revert is proved rather than promised.

**Two review findings die with it.** F9 (a branch that replaces the round must still honour the resolved
entry's treatments) was fixed on 2026-08-10 and is moot with the branch off — the treatments now reach
the fan, which is where the *"update one shotgun load's animation, update them all"* ruling always
pointed. F4 (an untrimmed long asset needs an engine-wait cap at its content end) belongs to an element
nothing draws.

#### What buckshot draws now — the fan, irregularised

The six travelled dashes the shell row has always described, with the four things the volley was
reaching for built into the fan itself rather than baked into one clip. All four are **seeded** off the
shot's own seed (`fxSeedOf` → `pelletChaosFor`), so two clients draw the identical cluster while two
consecutive identical trigger pulls do not — the seed folds the round index *and the rolled damage*, the
same entropy rule the burning ground follows and the one the volley failed.

| Knob | Ships as | Scaled by | What it buys |
|---|---|---|---|
| `slotFraction` | **0.9** | half the pellet's own **slot** in the even ladder | the slots stop being a ladder — at 0.9 a pellet can almost reach its neighbour's place |
| `reachFraction` | **0.35** | the cone's own **lateral** half-spread at that distance | mixed depths: a near side and a far side, instead of six marks on one arc |
| `sizeFraction` | **0.25** | the row's `dashSquares` | no two balls in one shot are the same ball |
| `staggerMs` | **45** | — | pellets leave a few milliseconds apart, so they are many objects and not one |

⛔⛔ **BOTH GEOMETRY KNOBS ARE SCALED BY THE CLASS'S OWN CONE, AND THAT IS LOAD-BEARING.** The first
build scaled the angle by the *whole* cone and the depth by the *whole shot*: the outer pellets were
pushed to 1.45 × the declared spread and the arrival moved by a fifth of the shot's length, and a **HIT
stopped landing on the body it was aimed at** — measured on the rig at **113 px** from the target's
centre against a 50 px half-width. Converging on the target is what makes a hit a hit; the irregularity
has to live *inside* the cone rather than on top of it. The resolved offset is additionally **clamped**
to ±`spreadRad`, because a symmetric nudge on an outermost slot would otherwise still cross the edge.
Swept over 400 seeds at 6 squares: worst pellet **45.0 px** from centre (vs a 50 px half-width), nearest
stop **0.9755** of the shot line. A keeper leg runs that sweep.

**The dash length: `dashSquares` 1 → 0.7.** The number is the sprite's drawn **width** and the asset
lights roughly a fifth of it, so shortening the frame shortens the *trail* more than it shortens the
ball — which is the read the ruling asked for. It is deliberately **not** taken further: **0.5 was the
first value ever tried on this row** and was rejected by eye as "a few pixels, reads as dirt on the
screen", so 0.7 is the shortest step that stays clear of the value already known to disappear. With the
±25 % size jitter the six draw between **0.53 and 0.88** squares, all of them above that floor. ⏪ The
revert value is `dashSquares: 1`. **This is a look call and it wants eyes.**

#### The arrival marks, and the razor split

`PELLET_ARRIVAL` — the dust ring at **0.45 squares**, trimmed to **500 ms**, one at each pellet's own
endpoint, delayed by that round's arrival plus that pellet's own stagger. Against the class's aim-point
mark at 1.15 squares that is under 40 %, comfortably inside the "at least half down" the ruling asks
for, and what keeps six of them from becoming the wall of fire the volley's blooms were being scaled
back from. Never named for the settle signal: trimmed well under the aim mark, they can never be the
last thing on screen, so the tail takes no term for them.

⛔ **STANDARD BUCK GETS DUST; THE INCENDIARY SHELL GETS ITS FIRES.** The ruling reserves fire arrivals
for the incendiary load — and the incendiary load **already has them**: its landing points are the same
pellet endpoints, and the burning ground sets a real flame at each one. So the split is not two assets
chosen by load name; it is one gate, `entry.groundFire`, and a load that lights its landings does not
also get dust over them. That also honours the standing 2026-08-09 ruling that removed the api row's
fire impact (*"get rid of the blast circle that lands on the target"*): drawing a fire mark here would
have re-created exactly the doubling that ruling deleted. **The api shell's red treatment is untouched**,
which is what the user asked for.

⚠ **The mark shares its asset with `IMPACT_DUST`**, deliberately — that key was chosen out of a closed
enumeration of the free tier's impacts precisely as the blunt, radial, no-rotation-question arrival, and
this is the same job at a smaller size. It is declared as its own constant because the two elements
answer to different rulings. A reader counting sprites should know that a baton shell puts its own dust
mark on the aim point at 1.15 squares and six of these at 0.45, out of one key: **tell them apart by
size, not by file.**

#### The burning ground takes the same jitter

Once the fan became irregular, `groundFirePoints` had to take the irregularity with it or the flames
would sit on the even ladder while the pellets that lit them flew a square either side. It is handed the
**first round's** own jitter record — the same helper, off the same seed the draw uses — because the
fires are one placement event for the whole payload and that is the round whose landing they depict.
The standard's "never invent a position you could have asked for" is the rule being kept here.

#### The shelf, for the record

`jb2a.volley_of_projectiles_Line.bullet.001.001.orangeyellow` is one ranged asset that draws a
**five-round fan** crossing to the aim point and blooming into **arrival fireballs**, all baked into its
own clip. It is served in four distance bands, and the two numbers per band answer two different
questions — `crossMs` (the arrival) is when the rounds get there; `tailMs` (the content end) is when the
element stops being worth waiting for.

| Band | `crossMs` | `tailMs` |
|---|---|---|
| 15ft | 240 | 600 |
| 30ft | 480 | 800 |
| 60ft | 840 | 1200 |
| 90ft | 1200 | 1600 |

Its own chaos (a seeded mirror flip and ±5° of aim jitter, rotated **about the shooter** so the band
cannot move) is intact, as is `ammoRedefinesProjectile` — the rule, written on the **table** rather than
on a list of load names, that keeps a load which draws its own projectile (`stundart`, `rubber`,
`flechette`, `slug`) out of any branch that would replace the round wholesale. That rule outlives the
volley: it is the general statement of "a load that has been given a picture keeps it".

**Known limits of the shelved element, if it is ever revived:** a **miss still lights fireballs in the
dirt** (the asset bakes its arrival, so a missed volley blooms wherever it lands — capture **67c**); it
draws **five** rounds where our fan draws six; and its arrival bloom reaches up to ~0.7 of a square past
the aim point, which is why our own mark was suppressed rather than merely moved.

#### ⭐ A CANDIDATE THE VETO TURNED UP — **variant 002**, not adopted, wants eyes

The free tier's delivered ranged/projectile/throwable families were enumerated off the install at the
veto (54 families; the shipped bullets are single bolts, the throwables are single objects, and the
arrow volleys come in `Circle` / `Cone5e` / `ConePF2e` formations that are shape-right for a pattern but
draw **arrows**). One row of that list is worth the user's eyes:

`jb2a.volley_of_projectiles_Line.bullet.001.**002**.orangeyellow` — the **second** bullet-volley variant,
which this arc has never drawn. Decoded against the vetoed 001 on the same 30ft band:

| | `001.001` (vetoed) | `001.002` (candidate) |
|---|---|---|
| mid-frame blobs | **7** | **32** |
| their columns | 446 / 1278×2 / 1380 / 1387×2 / 1496 — two aligned ranks | 489 … 1414, spread across the whole frame |
| their rows | 117–285, wide | 174–240, a narrow band |
| clip | 79f / 2633 ms | 146f / **4867 ms** |

That is a **stream of many small projectiles at mixed depths** rather than side-by-side lanes — which is
the read the ruling asked for, out of one asset. Two reasons it was **not** switched to: the ruling says
the user sees captures before any asset change, and the clip is nearly five seconds, so adopting it
would need a trim plus the engine-wait cap rule (§9 rule 16) before it could carry a settle tag. Recorded
here, with the key, so the choice is one the user can make rather than one they have to discover.

Anything beyond this row is a paid-tier or third-party question.

**Two rules govern the merge** (`ammoFxEntry`):

1. **Repaint, never add** — and **re-picture, never add** with it. Two masked lists, one rule:
   `AMMO_FX_RECOLOR_FIELDS` (`tracerColor`) is *what colour an element is*, and `AMMO_FX_REPLACE_FIELDS`
   (`tracer`) is *which picture it is*. Both are applied *only where the class row already **carries the
   key***. The test is key presence (`=== undefined`), not truthiness, so a row may carry `null` and mean
   "repaintable, painted with nothing". Four outcomes, one rule, no class named anywhere:

   | Case | Row says | Result |
   |---|---|---|
   | ordinary shell | `tracerColor: null` | no shift on the fan — the settled buckshot look |
   | incendiary shell | overlay supplies the shift | the pellet fan goes red |
   | incendiary rifle | row carries `tracerColor` | the single bolt it actually draws is red |
   | any class, a field its row omits | key absent | the overlay's value is dropped, never added |

   ⏪ The earlier form of this rule left `tracerColor` *off* the shell row, which kept the fan untinted
   under every load. The user superseded that for ammo overlays (§6); the base look is unchanged.

   ⏪ **Both masks were one entry shorter on 2026-08-09.** `columnColor` and `column` left them with the
   discharge column: each had been added for exactly one reason — so that an overlay could never hand a
   pistol a shotgun's discharge blast — and with no such element in the file there is nothing left to
   guard. The rule itself is unchanged and is now proved on the fields that remain.
2. **`impactScale` is a multiplier, never a width.** An absolute value would flatten the classes into
   one size; the table steps the impact from 0.70 (pistol) to 1.30 (heavy) precisely because a heavy
   round lands harder. The multiplier is spent during resolution and removed from the result, so the draw
   path only ever sees an ordinary row.

Resolved widths, for reference:

| | pistol | smg | rifle | shotgun | heavy |
|---|---|---|---|---|---|
| base | 0.70 | 0.75 | 0.95 | 1.15 | 1.30 |
| `flechette` / `stundart` | 0.49 | 0.525 | 0.665 | 0.805 | 0.91 |

`rubber`, `slug`, `api`, `ap` and `dualPurpose` carry no `impactScale` and land at the class's own width.
⏪ `rubber` used to sit at × 0.60 — a blunt round does not make a *smaller* mark than a bullet, it makes
a *different* one. ⏪ The `hollowPoint` (1.12 / 1.20 / 1.52 / 1.84 / 2.08) and `safety` (0.385 / 0.4125 /
0.5225 / 0.6325 / 0.715) rows that used to sit in this table are gone with their overlays.

### 3.2a The shot pattern's own look — `SPREAD_ZONE_LOOK`

`module/combat/spread-zone-look.js`. The pattern zone is a canvas object rather than a sprite, so its
appearance is not the effect engine's business — but it is the same kind of fact and it lives in the
same kind of block: one frozen object, no branch anywhere else.

| Value | Ships as | What it is |
|---|---|---|
| `fillColor` | `#ffaa00` | the wash, and the region document's own `color` |
| `outlineColor` | `#cc6600` | the drawn edge |
| `fillAlpha` | **0.10** | against core's own **0.5** — the user's "near-transparent … you can read tokens and shots through it" |
| `hatch` | **false** | core's diagonal bars are opaque, so they are the half that actually occludes |
| `outlineWidth` / `outlineAlpha` | 2 px × ui scale / 0.85 | thin and nearly solid: the inverse of the fill, and what carries the shape |

⚠ **Core gives the document no way to say any of this.** A v14 Region carries `color` and `visibility`
and no opacity of any kind: its highlight is a `RegionMesh` whose alpha is assigned the literal `0.5`
inside the placeable's own `_draw`, and whose hatch is switched back **on** by `_refreshState` on every
refresh. So the treatment is applied to the drawn object, on both `drawRegion` and `refreshRegion`,
for regions carrying our `isSpreadZone` flag and no others. The outline is ours for the same reason:
core's own region border is bound to interaction (`controlled || hover || layer.highlightObjects`), so
an unhovered region on a non-active layer has no edge at all, and a 0.10 fill with no edge is not
"ghost", it is "gone". A keeper leg asserts **core's** 0.5-and-hatched values on an untouched region
first, so a core release that changes them fails by name rather than leaving us tuning against
something that already moved. Captures **60a** (ours) and **60a-control** (core's, same region).

### 3.3 How the load is identified

`ammoFxKeyOf(payload)`:

1. **The id, if the payload has one** (`payload.modifier`). This is the design. It also settles a case
   nothing else can: `ap` and `dualPurpose` carry *byte-identical* mechanics, so no amount of looking
   at the consequences distinguishes them.
2. **A fingerprint of the mechanics, only when there is no id** — a compatibility path for payloads
   emitted before the field existed.

| Load | Fingerprint |
|---|---|
| `api` | `dotEnabled && dotType === "fire"` — the only fire damage-over-time in the registry |
| `flechette` | `spreadMode === "flechette"` |
| `slug` | `spreadMode === "slug"` — the one mechanical field that separates the shotgun loads |
| `safety` | `armorMultSoft === 2 && penDamageMult === 3` |
| `hollowPoint` | `armorMultSoft === 2 && penDamageMult === 1.5` |
| `stundart` | `stunSaveOnHit && stunSaveMod === -2` |
| `rubber` | `stunSaveOnHit && stunSaveMod === 0 && penDamageMult === 0.5` |
| `ap` | `armorMultSoft === 0.5 && penDamageMult === 0.5` |

Order matters where loads overlap: `api` is tested before `ap` (api's armour multipliers *are* ap's);
`stundart` before `rubber`. The `penDamageMult` term on `rubber` is not decoration — a warhead's own
fields include `stunSaveOnHit: true, stunSaveMod: 0`, so the pair alone would paint every grenade with
the baton-round treatment. **Known limit:** without an id, `dualPurpose` collapses onto `ap`.

---

## 4. The sequencing contract

### 4.1 One payload

```
faceTarget()                       ← awaited; the rounds start from a token already pointed
fxBurstAmbience()                  ← once, multi-round payloads only (mote spray)
fxGroundFire(points)               ← ONE placement, N flames, incendiary + at least one hit +
                                     the single-target flow owns the payload; NOT awaited
fxBloodSplatter()                  ← once, gore on + a hit + a flesh target token; NOT awaited
for each round i of shots:
    sleep until t0 + i×cadence      ← the ONE wait, and it is ANCHORED (§4.1a)
    if this round is too late:     ← DROP it entirely and go to the next
        continue
    sfx()                          ← audio
    fxSmokePuff()                  ← single-discharge classes only; NOT awaited
    fxShot()                       ← light + sprites + tracer + impact; NOT awaited
    fxBloodSplatter()              ← landing rounds only, up to the cap; NOT awaited
_watchSettleTag(settleTag, presentationTailMs(class, ammo))
```

Everything a round draws starts in the **same tick** as that round's audio. Nothing in this path waits
on a server. Rounds are capped at `MAX_FX_SHOTS` (30).

Hits are assigned to the **leading** rounds of the burst: the payload knows how many rounds landed,
not which, and inventing an order would be inventing a fact.

**A ruled fumble draws nothing at all** — no light, no sprite, no tracer, no impact, no audio. The gate
is `payload.fumbleRuled` (the base actually resolved a fumble), *not* a natural 1: with the fumble
table switched off a natural 1 is an ordinary bad roll and the weapon really did fire.

### 4.1a Pacing: an anchored schedule, and a late round dropped rather than queued

**The report.** Animations ran in slow motion, queued behind the audio, and went on arriving after the
shooting had stopped — worst on the heavy multi-sprite payloads (flechette's 8 darts a round, the
shell's column plus fan).

⏪ **This section fixed the LOOP; it did not fix every report.** The same complaint came back on
2026-08-10 for the dart load specifically, and the residual was the one thing a pacing rule cannot
reach: the backlog queued by the rounds it *chose to keep*. That was answered by removing the count
rather than by re-tuning anything here — §6, the single-file ruling, extended to `stundart` on
2026-08-11 by the same reasoning. Reproducing the table below now needs a class whose **own** row draws
a group, because no overlay row does.

**The mechanism, measured on the rig 2026-08-09 rather than reasoned about.** The loop paces by the
wall clock while everything it queues is drawn by the render loop. The old loop waited a **fixed**
`cadenceMs` each iteration, so every millisecond a round's timer fired late was *added* to the next
round's start instead of being absorbed — the error compounded, without bound:

| Rounds (shell, 180 ms cadence, flechette) | Intended | Measured before | Ratio |
|---|---|---|---|
| 5 | 720 ms | 1 534 ms | 2.13× |
| 10 | 1 620 ms | 3 630 ms | 2.24× |
| 20 | 3 420 ms | 7 617 ms | 2.23× |
| 30 | 5 220 ms | **11 681 ms** | **2.24×** |

The obvious suspect is wrong, and it changes the fix: **building a round's Sequence is cheap** —
`fxShot`'s synchronous cost measured at a median of **1 ms**. The lateness is the loop's own
`setTimeout` being starved while the engine draws what earlier rounds already queued (the same run
measured the canvas at 5 FPS with 421 effects live). No amount of making the round body cheaper touches
it; the loop has to stop trusting that its sleep slept for the time it asked for.

**Half one — the schedule is anchored.** Round *i* is due at `t0 + i × cadence` (`roundDueAtMs`), and the
loop sleeps only the **remainder** to that instant. A round that ran late no longer pushes its
successors: lateness is measured fresh each round against a fixed origin instead of accumulating.

**Half two — a round that still cannot start on time is DROPPED, not queued.** User ruling 2026-08-09,
verbatim reason: *"the audio already told the ear the story."* The round goes **entirely** — its audio
with its picture. The first build of the rule kept the audio and refused only the sprites; the rig
refused that reading by measurement, because a starved loop reaches several slots at once and keeping
the audio put two and three reports in a single tick (measured gaps of **231, 0, 235, 0 ms** across one
five-round burst). Dropping the round outright leaves the rounds that *do* play sitting on their own
slots — the burst keeps its rhythm at the cost of a round, rather than losing the rhythm to keep one.

**The threshold is half a slot** (`FX_DROP_LAG_FRACTION` = 0.5 → 40 ms at the default 80 ms cadence,
90 ms at the shell's 180 ms), and it is a **fraction rather than a flat figure** for a reason the
arithmetic settles. The gap between two rounds that both get drawn is `cadence − (how late the earlier
one was)`. A flat 150 ms shipped first — and the rig refused it on the second run, at the default
cadence, with gaps of **256, 1, 256 ms**: a round drawn 150 ms behind its slot is already past the next
round's slot, so the two are drawn together. At half a cadence no round is ever drawn more than half a
slot late, and therefore **no two drawn rounds are ever closer together than half a cadence**. That is a
property of the arithmetic, not of the host, and a keeper leg pins it at every cadence the table ships.

**⛔ The last round is never dropped**, however late. It carries the settle tag, so the completion signal
is always named on an element that is certain to be drawn — which is what makes retagging machinery
unnecessary and what stops the apply window ever waiting on a refusal.

**What it costs a healthy client: nothing.** Timer lateness on a client that is keeping up is a frame or
two, well inside 40 ms, and a keeper leg drives a ten-round burst with the threshold held out of reach
and asserts `dropped === 0`. The rule is also self-correcting, which is what actually retires the
report: dropping late rounds removes exactly the queued work that was starving the timer.

**Measured after, same host, same payloads:**

| Rounds | Intended | After | Drift |
|---|---|---|---|
| 5 | 720 ms | 785 ms | +65 ms |
| 10 | 1 620 ms | 1 797 ms | +177 ms |
| 20 | 3 420 ms | 3 639 ms | +219 ms |
| 30 | 5 220 ms | **5 309 ms** | **+89 ms** (was +6 461 ms) |

The fan-out reports `dropped`, `maxLagMs` and `loopMs` on its result, so the pacing is readable rather
than inferred. `_setDropLagMs(ms)` is a test seam for an absolute threshold; nothing ships with it armed.

⭐⭐ **THE IMPACT FAMILY IS NOT ON THE TRACER'S BUDGET (2026-08-11).** Bench report: *"hits late in a
long burst get NO blood at all"*. The drop rule above takes a late round **whole** — audio with picture —
and it is right about what it was written for: a report landing on top of another report is worse than a
missing report, and a backlog of tracers is what put the picture a second behind the sound. But it was
also taking the round's **arrival** with it, and an arrival is not a pacing cost. A tracer is a sprite
per pellet, issued from the muzzle every cadence slot; a hit mark and a blood spray are **one sprite
each**, at the far end of the shot, and they are the only thing on screen that says the round landed on
somebody. A ten-round burst that hit six times was marking three, which reads as a burst that mostly
missed.

So the two budgets are separate:

| Budget | Owned by | Bound |
|---|---|---|
| **tracer / audio / flash / lance** | the pacing rule — may refuse a late round outright | the last round is never refused |
| **hit mark** | the payload's own hit count | `HIT_MARK_MAX_PER_PAYLOAD` = `MAX_FX_SHOTS` (30) |
| **blood spray** | the same, capped much tighter | `BLOOD_SPLATTER.maxPerPayload` = 4 |

A round that **hit** gets its impact family whether or not its tracer was drawn. A refused round's mark
is issued on its own (`fxHitMark`) with the lateness that caused the drop **subtracted** from the
arrival, so a mark for a round already 200 ms behind its slot lands 200 ms sooner and arrives on the
canvas alongside the rounds that were drawn on time. It is never named for the settle signal — the last
round is never refused, so the tag always rides an ordinary `fxShot`.

The hit-mark bound is deliberately the fan-out's own round cap rather than something smaller: the mark
is one transient sprite (833 ms) on the aimed square, so N of them is N confirmations of N landed
rounds — which is the thing the ruling asks to stop losing. The element that genuinely does not survive
repetition is the spray, and it keeps its own much tighter cap. Both paths resolve the mark through one
function (`hitMarkFor`), so a promoted asset cannot reach one path and not the other. Measured on the
rig, a 20-round burst with 20 hits: **13 rounds refused by the pacing rule, 20 arrivals marked, 13 of
them issued on their own**, 4 sprays.

**One knock-on, and it was a real bounding defect.** The faster hand-over exposed a race in the burning
ground's scene cap: the cap read `liveGroundFires()`, but the engine does not create an effect until its
own play resolves, so two placements issued inside that beat both read the same number and both
under-evicted — eight bursts left **28 flames alive against a cap of 24**. Flames now queued but not yet
created are counted too (`pendingGroundFires`), which makes the cap hold rather than approximately hold.

### 4.2 The tail, and when the damage window may open

The damage window waits for the rail. Three routes, and each reports which one it took:

| Route | When | Value |
|---|---|---|
| `signal` | normal — the engine reported the last round's terminal elements gone | measured |
| `arithmetic` | no fan-out registered (rail off, unmapped weapon, nothing drawn) | `payloadPresentationMs()` |
| `cap` | the signal never arrived | `PRESENTATION_CAP_MS` (8 s) |

The **terminal elements** are the last round's tracer and impact; only they are named for the engine to
report on. The scheduled tail is the *floor* (never open early) and the fallback.

**A watch now always ends.** Both of the watch's original exits require a count to be right — the
scheduled fallback fires only when *nothing* was created, and the engine exit only when `ended` catches
`created` — so a watch whose elements were created but never all reported gone satisfied neither and sat
in the maps for the rest of the session. Measured: five overlapping 30-round fan-outs left **2 of 5**
watches unresolved and still holding their payloads fifteen seconds after everything had left the
screen. The apply window was never at risk (`presentationSettled` always races the cap), but the
bookkeeping grew without bound. A hard stop on the **same** `PRESENTATION_CAP_MS` the window already
honours now drops the entry; because any waiter has already taken the capped answer by then, it cannot
change what a caller observes. Note that a 30-round shell burst legitimately runs past that cap on a
slow client — 5.2 s of firing plus its tail — and opens the window at the ceiling; it did so far harder
before this unit, when the same burst ran 11.7 s.

`presentationTailMs(class, ammoKey, volley, arrivalMs)` — the longest of: light envelope · lance dwell ·
spark clip · tracer end (travelled: `dashMs + 260`; painted: 933) · **impact end (`arrivalMs +
impactClipMs`)**. ⏪ The **column dwell** term left this list on 2026-08-09 with the element it
described; the shell's own lance dwell (220 ms) is now an ordinary `muzzleDwellMs` term like every other
class's, which is one of the things the deletion bought.

⭐ **The ARRIVAL is a fourth input as of 2026-08-11**, and it is *passed* rather than derived: a painted
round's arrival is a property of the shot's **length**, and this function is pure and has no way to ask
how long the shot was. Both shipping callers resolve it — the fan-out off the canvas it is drawing on,
`payloadPresentationMs` off the same two tokens — and hand it in, so the floor the apply window rests on
covers a mark that is now drawn most of a second later than it used to be. Called **without** one it
falls back to the row's own crossing time, which is exactly what it computed before the arrival existed;
that is the answer a caller holding only a class and a load gets, rather than an invented one. By value
on the rifle: **933 ms** with no arrival, **1200 ms** at the 30ft band, **1533 ms** at 90ft. A travelled
class does not move at all — its crossing was always the term.

⚠ **A volley is its own whole answer** and returns early rather than joining that maximum. (Shelved
since the 2026-08-11 veto — nothing hands one in today; the branch stands so the revert is one field.) That is not a
shortcut: when the volley is drawn, the pellet fan is *not* (it replaces it) and the hit mark is *not*
(`fxShot` suppresses it), so folding in a `tracerEnd` and an `impactEnd` for elements the shot does not
draw would over-state the wait on exactly the loads that are already slowest. The term is the band's
**content end** — 600 / 800 / 1200 / 1600 ms — see §3.2b.

Shipped values:

| Class | tail (standard) | tail (`flechette` / `stundart`) | tail (`api` / `ap`) | tail (`slug`) | tail (`rubber`) |
|---|---|---|---|---|---|
| pistol / smg / rifle / heavy | 933 ms | 1003 ms | 933 ms | n/a | **1073 ms** |
| shotgun | 983 ms | 1003 ms | 983 ms | **933 ms** | **1073 ms** |

| Buckshot **with the volley** (shotgun) | < 5 sq | 5–9 sq | 9–15 sq | ≥ 15 sq |
|---|---|---|---|---|
| tail | **600 ms** | **800 ms** | **1200 ms** | **1600 ms** |

`rubber` is the one *ammo* overlay that genuinely moves the window, and it must: it hands every class a
240 ms crossing time (`240 + 833`), against the flechette's 170 and buckshot's own 150. A keeper leg pins
1073 by the arithmetic on all five classes. Its **impact** promotion is free in the usual way — the dust
puff's own 1067 ms clip is trimmed to the ordinary 833 ms, so the whole move is the crossing.

⭐ **`slug` moves the shell's tail DOWN, and that is a correction rather than a saving.** The row sets
`dashMs: 0` alongside `dashSquares: 0`, and the zero is not cosmetic: `dashSquares: 0` switches the draw
path from a travelled dash to a *painted* bolt, and a painted bolt lives `TRACER_CLIP_MS` (933) rather
than `dashMs + 260`. Leave `dashMs` at the shell's 150 and the arithmetic reads the travelled branch for
a round that is painted — 410 ms against a real 933 — and the apply window opens half a second early on
every slug. Zeroing it is what puts the tail on the branch the round is actually on, and the shell's slug
consequently reads **933 ms, identical to a rifle's standard round**, which is what it now looks like.

**Deliberately *not* in the tail:** burst smoke, mote spray, burning ground, **blood splash**.
They are scene dressing that lingers on purpose; waiting for them would hold the damage window shut for
seconds after a viewer has already called the action over. The exclusion is structural rather than a
flag — none of them is given a settle name, and `presentationTailMs` takes no term for any of them, so
no setting and no ammo can pull one into the wait. A keeper leg pins the tail across every class with
the gore switch both ways.

**An impact promotion changes the mark, not the clock.** The two promoted assets are 2267 ms (fire) and
5033 ms (crack) against the ordinary impact's 833 ms. Every impact is played through
`timeRange(0, impactClipMs)`, defaulting to the ordinary impact's own length — so a promotion is free
in the dimension the user is sensitive to. What is given up is each asset's trailing fade; on
incendiary that loss is covered by the burning ground, which goes on burning where the rounds fell
for three quarters of a minute.

**Any overlay that moves a tail input must be threaded into the tail.** `flechette` gives a class a
crossing time it did not have; `impactClipMs` changes how long the mark is drawn. Both are read
through the same resolver the draw path uses, so they cannot drift. The failure mode if they ever do
is silent and one-directional: the window opens while the last round is still on screen.

### 4.2a The arrival clock — when a round *gets there*

⏪ **THE DEFECT THIS ANSWERS (bench report, 2026-08-11):** *"blood splashes and dust/impact marks play
when the round DEPARTS"*, worst on the rifle and the heavy. The mechanism was one expression — the
impact was held back by `dashSquares > 0 ? dashMs : 0`, and **four of the five shipped classes carry no
dash**, so a PAINTED round confirmed its hit in the same tick the muzzle lit. The bug was the ordinary
case, not an edge of it. The same zero reached the blood splash and the burning ground through
`arrivalMs`, which is why the two were reported together.

⚠ **A painted round *has* an arrival — it just was not being computed.** `stretchTo` scales the asset
across the whole shooter→aim line in one go, but the asset is not a static streak: it animates a head
travelling from one end of its own frame to the other, and the engine hands back a **different file per
distance band**, each animating that crossing over its own span. So the arrival is a property of the
band, exactly as the shelved volley's was — and it is read off the file rather than guessed.

**Decoded off the installed free tier**, not picked. Per frame, the rightmost lit column of the frame is
the head's position; the arrival is the first frame at which that leading edge stops advancing (98 % of
the clip's own maximum, which normalises away each file's different trailing padding). All ten files are
30 fps.

| Band | `bullet.01` (pistol · smg · shotgun) | `bullet.02` (rifle · heavy · slug) |
|---|---|---|
| 05ft | 100 ms *(16f, 533 ms clip)* | 267 ms *(28f, 933 ms)* |
| 15ft | 333 ms *(16f, 533 ms)* | 200 ms *(28f, 933 ms)* |
| 30ft | 467 ms *(19f, 633 ms)* | 367 ms *(28f, 933 ms)* |
| 60ft | 567 ms *(25f, 833 ms)* | 533 ms *(28f, 933 ms)* |
| 90ft | 733 ms *(29f, 967 ms)* | 700 ms *(28f, 933 ms)* |

⚠ **Two anomalies in the decode, recorded rather than smoothed.** `bullet.01`'s 05ft file opens with its
head already halfway across its own frame and never reaches the frame edge (max lead 0.83), so its
100 ms is "this shot is over before it starts" and not a crossing; and `bullet.02`'s 05ft reads *longer*
than its 15ft (267 vs 200) because the two files pad differently (max lead 1.00 vs 0.94). Both are short
shots inside the two nearest bands, and neither is worth a special case — but the inversion is not a
typing error.

**The band boundaries** (`TRACER_ARRIVAL_BANDS`) are the mirror of the engine's own picker for the
five-file families: 90ft ≥ 15 · 60ft ≥ 9 · 30ft ≥ 5 · 15ft ≥ 2 · 05ft ≥ 0 squares. The engine serves
the **nearest** band, so each boundary sits at the midpoint of two neighbours (3 / 6 / 12 / 18 squares
are 15 / 30 / 60 / 90 ft on a 5 ft grid). Asserted against `getFileForDistance` on the installed engine
rather than trusted — the same leg shape the shelved volley's mirror carries.

**One resolver, three shapes** (`arrivalSpecFor`), and it reports which one answered:

| `source` | When | Value |
|---|---|---|
| `volley` | a volley spec was handed in (shelved) | that band's baked `crossMs` |
| `dash` | the resolved row names a `dashMs` — the travelled shapes | `dashMs`, unbanded, the same at every range |
| `stretch` | everything else — the painted shapes | the band table above, keyed by the **tracer key** |

The table is keyed by the tracer key rather than by the class, which is what makes an overlay that
**replaces** the picture get the right answer with no branch: the `slug` row hands the shotgun a
`bullet.02`, and the slug is banded off the picture it was replaced with. A key the table does not carry
falls to `TRACER_ARRIVAL_FALLBACK_MS` (400).

⛔ **It is ONE derivation per payload.** The hit mark, the pellet arrival marks, the blood spray, the
burning ground and the tail floor all hang on this number; a second derivation anywhere is a way for the
mark and the blood on one shot to disagree about when the round got there. `fxWeaponFired` resolves it
once, before the loop, and threads it into every verb — exactly as it threads the load key. `fxShot`
derives its own only when called on its own (the keeper does, and a caller with no measured shot must
still get an arrival rather than the zero that was the defect).

**A miss is untouched.** A missed round draws no mark at all, so nothing waits for an arrival it never
has; the miss splay still sends each pellet to its own reach and lands wide or short exactly as the
divergence design intends.

### 4.3 The darkness gate

The muzzle light's **colour** is chosen from the viewed scene's darkness, read fresh per flash:

| Scene darkness | Colour |
|---|---|
| ≥ 0.25 | the loaded round's `flashColor` if it has one, else `#943400` |
| < 0.25 | **null** — core removes the coloration layer from the render entirely |

This is not an opacity. `hasColor` is set from `data.color !== null`, so a null colour takes the layer
out of the render (`layers.coloration.active === false`). The gate is inviolable and the ammo tint is
passed *through* it, never around it: below the threshold `flashColorFor()` has already returned null
before the ammo is consulted. The reason is measured — a coloured source moves **44.8%** of a lit
frame's pixels on this core, where the uncoloured one moves 0.2%.

### 4.4 The declared corridor — where a shot-pattern payload is pointed

**Aim, then declare, then bang** (user ruling 2026-08-11). A spread weapon fired from the sheet does not
open its modifiers window first: the fire control arms an aim preview, the shooter drags the corridor
against the map and confirms it with a click, and only that confirmed corridor opens the window. So by
the time the rail sees the payload, where the shot is pointed is a **statement by the shooter** rather
than an inference from whoever happened to be targeted.

The gesture lives in `module/combat/spread-placement.js` and draws nothing on this rail — it is one PIXI
corridor and a DOM readout on the aiming client, built from the same pure geometry (`rayPolygonShape`)
and the same pure band ladder (`lookups.js spreadBandSpec`) that the planted region uses, so the ghost
and the region are the same shape. It spends nothing: the magazine is decremented inside the base
system's own fire methods, which are two steps further down, so Esc cancels a shot that never happened.

What reaches this file is one field on the payload — `spreadAim` — carrying an **angle and two reaches**
rather than a point:

| Field | Read by | Meaning |
|---|---|---|
| `angleDeg` | rail + plant | the axis, in canvas degrees |
| `reachM` | **rail** | where the shooter clicked — what the rounds are drawn to |
| `lengthM` | **plant** | that plus the overshoot into the aimed-at figure's own square, so containment is unambiguous |
| `widthM` / `band` | plant + card | the corridor's width and its Core range band |

⭐ **It is a description, not a position, and that is the point.** Every consumer rebuilds the corridor
off the shooter's figure **as it stands** (`declaredAimPointOf`), so a token nudged between the aim and
the roll still fires along the line that was drawn, out of the barrel it is actually holding. A stored
pair of world coordinates would have quietly disagreed with the muzzle.

The aim is resolved **once per payload** in the fan-out (`payloadAimPoint`) and threaded into every verb
— the turn, the burst ambience, the smoke, the burning ground, each round's `fxShot`, and the hit marks
issued for refused rounds. It was read four separate times from the same two tokens before, which was
harmless only while there was one possible answer. The fan-out now **reports** what it used (`aim`,
`aimSquares`, `aimDeclared`) for the same reason it reports its pacing: an axis that can only be checked
by looking at the canvas is an axis nothing can assert.

**Damage and animation are one event.** A corridor the shooter already confirmed needs no second
confirmation, so the chat card's Confirm button — which used to do two jobs, aiming *and* resolving —
keeps only the job the roll has already committed to, and the pattern resolves itself when the rail says
the shot is over (`presentationSettled`, the same signal the single-target apply window waits out). On a
client that did not draw the shot (a player's shell relayed to the GM) that call takes its arithmetic
route, which is the honest floor. This is what retires review finding F4's late-window complaint for this
flow: the rounds cross the corridor and the damage lands as they arrive.

⏪ **A shell nobody aimed still gets the card.** A payload with no `spreadAim` — a macro, a keeper driving
the roll directly — is planted on a corridor the module *guessed* from the target axis, exactly as every
shell was before this unit, and a guessed corridor is still shown to a reader before it resolves.

---

## 5. Tune-knob index

Everything worth changing, and what it does. All in `module/fx/effects.js`.

| Knob | Ships as | Changes |
|---|---|---|
| `SHOT_CADENCE_MS` | 80 | default spacing between rounds |
| `MAX_FX_SHOTS` | 30 | per-payload fan-out cap |
| `FX_DROP_LAG_FRACTION` | **0.5** | how late a round may be before it is dropped, as a share of its own slot (§4.1a). 0 drops nothing — anchoring alone, which measurably bunches. ⏪ the earlier flat figure was **150 ms**, which does not hold the separation guarantee at any cadence we ship |
| `MUZZLE_MODE` | `"cone"` | flash shape: `cone` / `omni` / `hybrid` |
| `MUZZLE_LIGHT.coneDegrees` | 270 | wedge width (a 90° notch behind the shooter) |
| `MUZZLE_LIGHT.luminosity` | 0.65 | flash strength — **raised from the reference's 0.5 on request** |
| `MUZZLE_LIGHT.referenceColor` | `#943400` | dark-regime colour (`#ffae42` is the earlier warm option) |
| `MUZZLE_LIGHT.darknessColorThreshold` | 0.25 | where the colour regime switches |
| `MUZZLE_LIGHT.brightSquares` / `dimSquares` | 12.5 / 12.5 | equal on purpose — attenuation does *all* the falloff |
| `MUZZLE_SPRITE.endMs` | 110 | lance trim — beyond this the clip's smoke-and-fire plume returns |
| `MUZZLE_SPRITE.edgeFraction` | 0.5 | how far along the aim the sprite is planted, as a fraction of token width |
| `FACING_AIM_SQUARES` | 3 | how far the synthesized aim point sits for an untargeted shot |
| `SPREAD_PREVIEW_FILL_ALPHA` ⭐ | **0.18** | how solid the aim ghost is while it is being dragged (`module/combat/spread-placement.js` — the one knob in this index that is not in `effects.js`, listed here because it is the shot's own look). Revert to `SPREAD_ZONE_LOOK.fillAlpha` (0.10) to make the dragged ghost identical to the planted one |
| `SPREAD_MIN_LENGTH_M` ⭐ | **2** | the shortest corridor an aim may confirm, in metres — mirrors the plant's own floor |
| `FX_CLASSES.shotgun.muzzleSquares` | **1.9** | the shell's lance width in grid units — between the rifle's 1.6 and the heavy's 2.1; measured 190 px on a 100 px grid |
| `FX_CLASSES.shotgun.muzzleMs` | **220** | the shell's lance dwell, the only row that names one; delivered as `muzzleRateFor("shotgun")` = 0.5 |
| ~~`COLUMN_SQUARES` / `COLUMN_TRIM_MS` / `COLUMN_DWELL_MS` / `columnRateFor()`~~ | ⏪ **deleted 2026-08-09** | the discharge column's four constants went with the mechanism (§6). A keeper leg asserts all four are `undefined` |
| `VOLLEY.enabled` | ⏪ **false** — *vetoed 2026-08-11* | the buckshot volley master switch, and the whole of the shelf. **True restores the trial**: the resolver answers a band spec again, the volley replaces the fan and the hit mark is suppressed once more. Nothing else is edited either way |
| `PELLET_CHAOS.slotFraction` ⭐ | **0.9** | how far a pellet's angle may wander, as a share of **half its own slot** in the even ladder. At 0.9 a pellet almost reaches its neighbour's place; the result is clamped to the class's declared cone, so this can never widen a spread |
| `PELLET_CHAOS.reachFraction` ⭐ | **0.35** | how much nearer or further a pellet stops, as a share of the cone's own **lateral** half-spread. The depth half of the irregular cluster. ⚠ Raising it past ~0.5 walks a pellet of a HIT off a one-square token — measured, §6 |
| `PELLET_CHAOS.sizeFraction` ⭐ | **0.25** | per-pellet drawn-width variance about the row's `dashSquares` |
| `PELLET_CHAOS.staggerMs` ⭐ | **45** | how late a pellet may leave, per pellet |
| `FX_CLASSES.shotgun.dashSquares` | ⏪ **0.7** (was **1**) | the drawn width of one pellet. Shortened on the veto so the dashes read as balls; **not** taken to 0.5, which is the value already rejected by eye as "a few pixels, reads as dirt on the screen" |
| `PELLET_ARRIVAL` ⭐ | dust ring, **0.45 sq**, trimmed to **500 ms** | the small mark at each pellet's landing point — the half of the volley trial the ruling kept, scaled down |
| `TRACER_ARRIVAL_MS` ⭐ | bullet.01 100/333/467/567/733 · bullet.02 267/200/367/533/700, by band | **decoded off the installed files** — when a PAINTED round arrives. ⚠ not a tuning knob: re-measure if the asset changes |
| `TRACER_ARRIVAL_BANDS` ⭐ | 90ft ≥ 15 · 60ft ≥ 9 · 30ft ≥ 5 · 15ft ≥ 2 · 05ft ≥ 0 | the mirror of the engine's own band picker for the five-file bullet families — **do not tune, it must match `SequencerFileRangeFind`** |
| `TRACER_ARRIVAL_FALLBACK_MS` ⭐ | 400 | the arrival for a tracer family this file has not decoded |
| `HIT_MARK_MAX_PER_PAYLOAD` ⭐ | `MAX_FX_SHOTS` (30) | the bound on arrival marks per payload, refused rounds included. Deliberately the fan-out's own round cap: the mark is one transient sprite on the aimed square, and N of them is N confirmations of N landed rounds |
| `VOLLEY.key` | `volley_of_projectiles_Line.bullet.001.001.orangeyellow` | which picture the volley is (variant `001` is the 5-round fan) |
| `VOLLEY.crossMs` | 240 / 480 / 840 / 1200 by band | when the rounds ARRIVE — what the blood spray and the burning ground are delayed by |
| `VOLLEY.tailMs` | 600 / 800 / 1200 / 1600 by band | when the element stops being worth waiting for — the tail term (§3.2b) |
| `VOLLEY.jitterDeg` | **5** | how far the aim may be rotated per discharge, about the shooter. Mean \|jitter\| measures 2.45° over 300 seeds |
| `VOLLEY.mirrorFlip` | `true` | mirror the sprite across its own long axis on ~half of discharges |
| `VOLLEY_BANDS` | 90ft ≥ 15 · 60ft ≥ 9 · 30ft ≥ 5 · 15ft ≥ 0 | the mirror of the engine's own band picker — **do not tune, it must match `SequencerFileRangeFind`** |
| `DASH_ARRIVAL_HOLD_MS` | 260 | how long a travelled pellet lives after arriving |
| `TRACER_CLIP_MS` | 933 | painted tracer's on-screen life (upper bound of the mapped families) |
| `TRACER_COLOR` | hue 18, sat −0.35, bright 1.15 | the class colour shift |
| `TRACER_COLOR_INCENDIARY` / `_BATON` | see §3.2 | the ammo colour shifts. ⏱ incendiary eased 2026-08-09, hue −20 → **−14**; ⏪ the revert value **−20** is recorded at the site, saturation and brightness unchanged |
| `TRACER_COLOR_HARDENED` | hue 8, sat −0.85, bright 1.45 | ⏪ **retired from use 2026-08-11** — the hardened rounds' flight tint; declared, on no shipped row. Restoring it is one field on each of two rows |
| `TRACER_COLOR_INERT` | hue 0, sat −0.55, bright 0.60 | ⏪ **retired from use** — the rejected darkening; declared, on no shipped row |
| `TRACER_COLOR_DART` | hue 0, sat **−0.90**, bright 1.15 | the dart language's grey — the most desaturated matrix on the rail, and above 1 in brightness on purpose (§3.2) |
| `BATON_ROUND` | `throwable.launch.cannon_ball.01.black`, 2.4 sq frame, 240 ms crossing | the whole less-lethal representation, in one block |
| `IMPACT_FIRE` / `IMPACT_CRACK` / `IMPACT_DUST` | keys + measured clip lengths | the promoted impacts |
| `AMMO_FX_RECOLOR_FIELDS` / `AMMO_FX_REPLACE_FIELDS` | colour pair / asset pair | which overlay fields may only repaint an element the class already declares |
| `GROUND_FIRE.key` | `flames.orange.03.1x1` | **which picture the fire is** — the whole of the rejected/shipped decision |
| `GROUND_FIRE.squares` | 0.9 | one flame's drawn width in grid units (0.5 reads as a spark, 1.6 as a bonfire) |
| `GROUND_FIRE.lifetimeMs` | **45000** | how long a flame burns — the "stayed burning" call |
| `GROUND_FIRE.fadeOutMs` | 2500 | the burn-**down** at the very end (5.6 % of the life; the rejected build spent 28 % fading) |
| `GROUND_FIRE.scatterSquares` | 0.8 | radius of the landing scatter when the class gives no per-round geometry |
| `GROUND_FIRE.maxPerPayload` | 4 | the most flames one payload may place |
| `GROUND_FIRE.maxPerPattern` | 5 | the most flames one confirmed shot pattern may scatter |
| `GROUND_FIRE.maxLive` | 24 | the most flames alive on a scene at once — oldest evicted first |
| `BLOOD_SPLATTER.key` | `jb2a.liquid.splash_side02.red` | the splash asset — **natively blood-coloured, no filter is applied**; the SIDE (directional) cut, rotated to the exit vector. ⏪ the radial `splash02.red` is still on the tier |
| `BLOOD_SPLATTER.maxPerPayload` | 4 | the most sprays one payload may draw — repeated spray, never a fountain |
| `BLOOD_SPLATTER.squares` | 1.5 | the drawn **frame** width in grid units; the ink is ~0.75 sq at 170 ms, ~1.3 sq at peak |
| `BLOOD_SPLATTER.clipMs` | 900 | the trim — content is spent by ~700 ms of an 1133 ms file |
| `BLOOD_SPLATTER.aboveLighting` | `true` | the documented departure from the routing rule (§2) |
| `goreEnabled` (world setting, `module/settings.js`) | default `false` | the blood master switch — config-visible, fail-closed reader; every splash gate reads it |
| `shotgunSpreadEnabled` (world setting) | default `true` | the pattern master switch — read ONLY inside `spreadFlowModeOf` (§1.1a); off ⇒ shells take the single-target flow |
| `MUZZLE_SMOKE.*` | see the block | one puff's size, phase, drift and cap |
| `MUZZLE_MOTES.*` | see the block | speck geometry, all off the reference frame |
| `PRESENTATION_CAP_MS` | 8000 | hard ceiling on how long the damage window may be held |
| `APPLY_LEAD_MS` | 150 | how far ahead of the engine's report the window may open |
| `SETTLE_CONFIRM_MS` | 60 | how long "all ended" must hold before it is believed |
| `FACE_TARGET.durationMs` / `minDegrees` | 220 / 5 | the turn sweep and its dead zone |
| `HIT_SOUND_VOLUME` ⭐ | **0.55** | interface level for a landed round's impact, before the per-asset gain and the index wobble. Set against the reports: 6.4 dB under a pistol's peak at `SHOT_VOLUME` 0.8 |
| `HIT_SOUND.<kind>.gain` ⭐ | flesh **1.0** / structure **1.1677** | peak-matches the two impact clips to each other (0.8677 / 0.7431, measured off the shipped `.ogg`s). Raise the structure figure to let a vehicle hit sit above a body hit |
| `HIT_SOUND_MAX_PER_PAYLOAD` ⭐ | **4** (= `BLOOD_SPLATTER.maxPerPayload`) | how many impacts one payload may sound. Shared with the splash by import, not by copy |
| `HIT_SOUND_VARIANCE` ⭐ | `[1, 0.9, 0.96, 0.86]` | the per-round level wobble, by round index — the only variation this host's audio layer can deliver uniformly |
| `HIT_SOUND_BURST_WINDOW_MS` ⭐ | **700** | how long the rolling tally an UN-indexed caller draws on stays open. Past the cap inside one window a play is refused (`skipped: "burst"`); quiet reopens it. The fan-out supplies its own index and is exempt |

Test/capture seams (**nothing ships with one armed**): `_setFlashLevels`, `_setDashMs`,
`_setSpriteRate`, `_setDbProbe`, `_setSoundManifest`, `_setDropLagMs`, `_setHitSoundSink`,
`_setStatusFxRate` (`module/fx/status-fx.js`).

**The condition overlays' knobs** ⭐ *new 2026-08-12* — `module/fx/status-fx.js`, and the whole feature
is the table, so a sixth condition is a row rather than a change:

| Knob | Ships as | Changes |
|---|---|---|
| `STATUS_FX_ROWS[].key` | see §2a.2 | which clip a condition wears. Every key is guarded by `fxDbEntryExists`, so a tier without it skips silently |
| `STATUS_FX_ROWS[].placement` | `ring` / `body` / `badge` / `ground` | where the mark sits, and therefore which sizing rule it takes. `ring` (the 2026-08-12 standard) is centred and concentric; moving the `dead` row to `badge` lifts it above the lighting |
| `STATUS_FX_ROWS[].colour` | acid: hue **−120**, sat **+0.15** · poison: hue **+130**, sat **+0.1** | the two ring recolours (molten orange → acid green; smoke blue-purple → fume green). Deleting the field restores the asset's own colour |
| `STATUS_FX_ROWS[].scale` / `.opacity` | burning 1.18/0.85 · poison 1.0/0.85 · acid 1.05/0.8 · stunned 1.25/0.9 · dead 1.25/0.55 | ring scales are the decode's ink-fraction compensation (frame ÷ ink), measured not chosen; the opacities are build-lane picks |
| `STATUS_FX.badgeSquares` | **0.55** | a badge's drawn frame in grid units (the marker clips carry ink across ~0.7 of it) |
| `STATUS_FX.badgeRise` / `.badgeSpacing` | **0.30** / **0.42** | how far above the figure's own top edge badges sit, and how far apart |
| `STATUS_FX.bodySpread` | **0.22** | how far two body treatments are pushed apart, as a fraction of the figure's width |
| `STATUS_FX.lifetimeMs` | **600000** | how long one issue of an overlay runs before it is re-issued. Not the condition's lifetime |
| `STATUS_FX.maxLive` | **60** | how many overlays may be alive on a scene at once; oldest out, through the engine's manager |
| `STATUS_FX.fadeInMs` / `.fadeOutMs` | 300 / 400 | how a mark arrives and leaves |
| `combatFxEnabled` (world setting) | default `true` | **shared with the shot rail** — the overlays ride the same master switch, read per event, and a switch-off sweeps what is already drawn |

**The shot pattern's knobs**, which are not in `effects.js` because the pattern is not a sprite:

| Knob | Ships as | Changes | Where |
|---|---|---|---|
| `SPREAD_ZONE_LOOK.*` | see §3.2a | the whole ghost treatment | `module/combat/spread-zone-look.js` |
| `SPREAD_ZONE_TTL_MS` | 60000 | how long an **unconfirmed** pattern lives outside an encounter | `module/combat/damage-hooks.js` |
| `SPREAD_ZONE_SWEEP_MS` | 15000 | how often the out-of-combat sweep looks | `module/combat/damage-hooks.js` |
| the band table | 1/2/3 m, 4d6/3d6/2d6 | width and damage by Close / Medium / Long — Core defaults, overridden per ammo item | `_placeSpreadZone` |

**The arrival sequence's knobs** — all in one frozen block, `TRAUMA_TEAM` in
`module/fx/trauma-team.js`, except the last row. Every one is a single constant.

| Knob | Ships as | Changes |
|---|---|---|
| `zoneWidthSquares` / `zoneLengthSquares` | 4 / 6 | the marked rectangle, in grid squares |
| `zoneInkFraction` | **0.893** | measured; the plate is drawn to `size / this` so its border reaches the corner marks. **Revert = 1** |
| `downdraftInkFraction` | 0.603 | same correction for the dust loop |
| `cornerSquares` | 0.9 | each caution mark's drawn frame |
| `airframeWidthSquares` / `airframeLengthSquares` / `airframeCornerSquares` | 2.4 / 4.6 / 0.8 | the hull's planform |
| `airframeFill` / `airframeFillAlpha` / `airframeLine` | `0x0a0d12` / 0.72 / `0x37e0c0` | how heavy and how lit the hull reads |
| `entryRiseSquares` / `entryScale` | 8 / 0.55 | how far off frame it starts, and how small it is while high |
| `descentAtMs` / `descentMs` | 900 / 2600 | when it enters and how long it takes to come down |
| `bobSquares` / `bobMs` | 0.16 / 2400 | station-keeping sway. **0 stops it dead** |
| `pulseCount` / `pulseFirstAtMs` / `pulseGapMs` | 4 / 3700 / **1200** | the rings. The gap is set against their own 2 750 ms clip |
| `pulseSquares` | 7.2 | ring frame, sized so its ink clears the rectangle |
| `figureCount` / `unloadAtMs` / `unloadGapMs` | 5 / 4600 / 700 | the file of figures. **The count and the one-after-another are rulings** |
| `figureStepSquares` / `figureWalkSquares` / `figureWalkGrowthSquares` | 0.9 / 1.1 / 0.18 | how they are spread and how far out each walks |
| `downdraft*` / `dust*` | see the block | the air under it |
| `ascentMs` | 2200 | the departure |
| `lifetimeMs` / `maxLive` | 600000 / 40 | the leak bound and the scene cap |
| `TRAUMA_TEAM_SOUND.descent` / `.volume` | `fx-scifi-whoosh` / 0.5 | the one shipped cue. **`null` ships it silent** |
| `LANDING_GHOST.*` | amber, alpha 0.12 | the placement ghost — `module/fx/trauma-team-tool.js` |

---

## 6. Rulings log

Dated decisions, mined from the supersession chains in the code. Values and *why*, never change
history. ⏪ marks a decision that reversed an earlier one.

**2026-08-12 — ⏪ the ring standard: condition overlays wear the reference's rim ring.**
User, on seeing the centered flame on the review target: it is "not going to cut it… the reference
has a sort of glass sheen effect with a fire spinning around the circular rim of the token" — then,
on the identified `shield_themed` family: **"All of our effects should look like this ring effect."**
Reversal of the 2026-08-11 unit's centered-flame/badge looks (their decodes and keys stay recorded at
§2a.2 history + per-row in status-fx.js).

| Ruling | Value | Why |
|---|---|---|
| every non-ground row is a **ring** | new placement family `ring`, concentric, no slot offset | the user's directive; the reference's own composition (its "On Fire" tiers are `shield_themed` fire rings) |
| burning = the reference's own key | `jb2a.shield_themed.below.fire.01.orange` | free tier carries the exact file the reference names; only the `_03` "Deadly" tier is patreon-gated |
| ring diameter compensates ink | scale = frame ÷ ink extent per decode | a ring drawn at frame scale sits inside the rim by its own padding |
| rings ride OVER the token, above lighting | `aboveLighting`, no `below` | visibility on unlit squares (the rail's standing ruling); `below: true` per row = reference-exact underlay — **user call open, §8** |

**2026-08-12 — a referee can call in an arrival, and it hovers.**
The docket described a recorded reference: a marked rectangular area with caution marks and a
holographic border, an aircraft descending from off frame, a hover with roughly four circular pulses,
five figures unloading one after another, and an ending with the aircraft still on station.

| Ruling | Value | Why |
|---|---|---|
| the marked area is **rectangular** | 4 × 6 squares | from the reference. The tier's square zoning plate is stretched to it, and its border ink is thicker on the short sides as a result — stated, not smoothed |
| it **hovers, never lands** | the airframe's own element persists past the ladder | from the reference, and it is what makes this a long-lived element rather than a one-shot |
| **four** rings | `pulseCount: 4` | from the reference |
| **five** figures, **one after another** | `figureCount: 5`, `unloadGapMs: 700` | from the reference. Five distinct instants and five distinct places, never five copies of one |
| the sequence ends with it **on station** | the ladder ends; nothing takes the hull down | from the reference. A second use of the control sends it back up |
| ⛔ **the figures are SPRITES, not documents** | zero document writes, asserted | build-lane scoping call. Real figures are a document feature with its own questions; a presentation rail does not half-build one. **Flagged for the user — §8** |
| the entry is **one referee button on an existing group** | `cp-tt-land` on the token group | the df-active-lights idiom the radiation and cover tools already use. Gated at render AND in the handler AND in the API |
| the button is **the opt-in** | no new setting | placement is consent; the master `combatFxEnabled` still governs |

⚠ **Two keys were picked by name and both were wrong** (§2b.4), and both were caught by looking at a
rig capture rather than by reading. `template_circle.out_pulse.*.bluewhite` is **a ring of musical
notes**; `wind_stream.white` is a full-bleed field of **horizontal** streaks. Standard §A/4 exists for
exactly this, and it had to be paid twice in one unit.

⭐ **Engine finding: shapes draw from their TOP-LEFT.** `drawRect(offset.x, offset.y, w, h)` in the
installed build, and `anchor` is declared in the engine's typings but never applied to the RECT / RREC
cases — only ELLIPSE is centre-drawn. Half the body, negative, in grid units, at one site.

⚠ **The hover is silent, and that is a recorded gap rather than an omission.** The library was measured
(§2b.6); one clip fits the descent beat and nothing in it is a station-keeping bed. No audio was sourced
for this unit, per the docket.

**2026-08-12 — a figure wears what is wrong with it, for as long as it is wrong.**
The docket asked for persistent overlays on every condition the system applies, auto-applied whenever
the condition is on the figure, with the ones that do not read across from the source material adapted
**with** the user rather than invented.

| Ruling | Value | Why |
|---|---|---|
| ⭐ **Detection reads BOTH roads, and the module's own flags are the half that actually fires** | `statusMarkersOf({statuses, flags})` — core condition ids **and** `flags.cp2020-augmented.*` marker arrays | The base system registers **no** status effects at all (§2a.1, counted), so a token carries core's default list — and the module's lasting-damage engines do not use it: burning lives in `fireDotState` and armour degradation in `dotState`, neither of which is a status. A build watching `actor.statuses` alone would have drawn nothing for the two conditions the request named first. |
| **A flag counts as raised only when it holds a live marker** | non-empty array, or a non-empty object | The engines write `[]` and unset the key at different points in their own teardown; treating "present" as "raised" leaves a mark up for a burn that finished. Asserted both ways in the keeper. |
| **Five rows ship; every other condition is a call, not a guess** | §2a.1's table — 11 markers recorded with detection source and no look | The instruction was to adapt the non-obvious ones *with* the user. A picture invented for "addicted" or "wound state" is precisely what that forbids, so those sit in §8. Each is one row when a call arrives. |
| **`unconscious` is the stunned row, not a row of its own** | `statuses: ["stun", "unconscious"]` | This engine's stun outcome IS `unconscious` — the failed stun check toggles it and the recovery check lifts it. Core's own `stun` is watched beside it so a hand-marked figure reads the same. Whether the two deserve different looks is an open call. |
| **`dead` suppresses `stunned`** | `suppressedBy: "dead"` | They genuinely stand together: the applicator sets `dead` while the stun check had already set `unconscious`. Stars over a body is noise. |
| ⏪ **Not `persist()`** | `attachTo` + `duration` + a stamped `name`, re-issued on expiry | Sequencer's own persistence writes the effect into the **scene's flags** — a document write from presentation, which this rail does not do (§9 G/22). Measured: an attached, named, duration-bounded effect leaves `scene.flags.sequencer` with **zero** keys and is still queryable and endable. The only thing given up is a redraw on reload, which `canvasReady` does anyway. |
| ⭐⭐ **The load catch-up hangs on `sequencerReady`, not on `ready`** | measured order: `canvasReady` +0 ms → `ready` +12 ms → `sequencerReady` +677 ms | Two different failures, one leg. `canvasReady` fires during setup, so the listener is registered too late to hear the load that installed it — the known register-plus-catch-up shape. But a catch-up at `ready` is too EARLY: `sequencerActive()` is already true there, so the sweep does not bail, it queues against an engine that is not up, and the work is silently lost. The reload leg failed for both reasons in turn before it passed. |
| **Slots belong to rows, not to draw order** | `statusFxOffset(id, widthSquares)`, pure | A figure that gains a third condition must not shuffle the two it is wearing. Reordering `STATUS_FX_ROWS` is the only thing that moves a mark. |
| **Badges measure from the figure, not from the grid** | `badgeRise` above `tokenRadiusPx` — y −0.80 at 1 square, **−1.30** at 2 | A fixed grid-unit rise puts a badge on a 2×2 figure's chest. |
| **The acid row is recoloured, and says so** | hue −120 / saturate +0.15 / brightness 1.0 over `bubble.002.001.loop.blue` | Asset-native first (§9 A/3) — but the free tier's only true bubbling loop is blue, and the alternative was a green clip with the wrong motion. One field reverts it. Unsigned look call, §8. |
| **Everyone sees them** | no GM gate anywhere | State visibility, not a secret: every shipped row's condition is already public (core draws its own icon for all clients, the lasting-damage cards post to chat). The survey found **no** GM-only condition on this system to mirror. |
| **The bench specs' "no live effect" restore leg now excludes this prefix** | `cp2020-augmented.statusfx.` filtered out in `review-bench-smoke` and `b1-seam-payload` | That leg exists to catch a muzzle or tracer that never ended. An overlay is *supposed* to still be there, so a legitimately burning figure would have failed it for doing its job — which is exactly how it was found. |

**2026-08-12 — a landed round makes a noise, and the rail is what makes it.**
The docket asked for impact sounds differentiated by what was hit, replacing a placeholder probe that
had been wired into the two SDP-decrement sites to prove the trigger seam.

| Ruling | Value | Why |
|---|---|---|
| ⭐ **The impact sounds on the ARRIVAL clock, from the rail — not at damage-apply wall time** | `hitSoundPlanFor` before the loop, `fxHitSound(kind, {delayMs: arriveIn, index})` inside it, beside the mark and the spray | The apply runs after `presentationSettled` by construction: for a burst that is the last round's tail, for a declared corridor it is whenever the GM confirms. An impact sounded there is not late by a frame, it is late by the whole action. The three elements that say a round landed — the mark, the spray and now the noise — hang on the ONE arrival this payload resolved (§4.2a), so nothing on one shot can disagree about when the round got there. |
| **The apply paths keep a leg, for the shots that never had an arrival** | `fxSilent` on `applyLocationDamage` / `applyVehicleDamageCore` / `applyVehicleDamageMM`, threaded through `applyAreaDamages`; set by `_autoApply`, its GM-side relay and `routeWeaponFiredToVehicle` | A hand-resolved damage dialog, a vehicle-damage dialog and an area shell resolved on confirm have no shot behind them and nothing to be late for, so they play immediately. The flows that DID come off a shot say so and stay quiet — otherwise a five-round burst on a vehicle would sound five more impacts, all of them late. The flag is named for what it does, because its **other** user is the applies that are not impacts at all (burn/acid ticks, permanent-damage conversion, radiation doses, an ACPA pilot's overflow). |
| ⭐ **The personnel leg goes on `applyLocationDamage`, not on `applyAreaDamages`** | one call site per zone outcome, inside the shared seam | Found by reading the callers rather than by assuming: the hand-applied damage dialog calls `applyLocationDamage` **directly**, row by row, and never passes through `applyAreaDamages`. A leg one level up would have covered the automated flows — which are the ones the rail already sounds — and left the manual one, the whole reason the apply leg exists, silent. |
| **An un-indexed caller gets a tally from the element** | `HIT_SOUND_BURST_WINDOW_MS` 700 ms, refused past the cap as `skipped: "burst"` | The apply seams walk their rows in one synchronous loop and have no payload to count against, so N plays land in the SAME tick and phase into one smear. Tested on the raw argument, not on `Number(index)` — `Number(null)` is 0, which is finite, and coercing first made every un-indexed caller look like caller zero (measured: nine rows in one tick, all at one level). |
| ⭐ **The capture seam is consulted before the host's audio state** | `_setHitSoundSink` wins over the `locked` check | §9 I says the seam is applied first, and here that is load-bearing rather than tidy: a sink never reaches an audio device, and a headless keeper page is GENUINELY locked (it never produces a user gesture on the game document — the join click lands on the previous one). With the order reversed every driven leg would have been measuring the page instead of the element. |
| **A hit stopped by armour is silent on the apply seam, and audible on the rail** | apply: `penetrates && (netDamage > 0 ‖ cyberlimb structural > 0)`; rail: the round landed | Asymmetric on purpose, and the asymmetry is which seam can answer. Penetration exists only after the armour math, which is the apply; at the arrival the rail knows only what its own two draws know. Matching the picture is the point — an impact the eye is shown and the ear is not reads as a defect. |
| **The apply seam chooses its clip per ZONE, the rail per ACTOR** | apply: `routesToSdp` (via `applyLocationDamage`'s `cyberlimb`) ‖ `isFullBorg`; rail: `bearsStructuralSdp` | The same known limit the blood splash carries: the payload says how many rounds landed and never where, so a per-zone answer does not exist at draw time. Where it DOES exist it is used, so a round into a cyberarm sounds like the chrome it hit. |
| **The cap is the blood splash's, not the mark's** | `HIT_SOUND_MAX_PER_PAYLOAD` = `BLOOD_SPLATTER.maxPerPayload` = 4 | Thirty marks are thirty confirmations; thirty copies of one 0.16 s clip inside a two-second burst is one noise. Taken by import so the two move together rather than drifting apart. |
| ⭐ **A locked audio context is a skip, not a delay** | `fxHitSound` returns `skipped: "locked"` when `game.audio.locked` | **Measured on the rig 2026-08-12, and it is the defect the placeholder was reported for.** Until a client produces a genuine user gesture the three audio contexts do not exist (`game.audio.interface` and `.music` both read `undefined`), and core's `Sound#load` opens with `if (game.audio.locked) await game.audio.unlock;` — so `AudioHelper.play` hands back a promise that **never settles** on such a client. Two consequences, both observed: a caller that awaits it stalls outright (two probe runs parked for minutes on one play call), and a rejection arriving after the eventual unlock lands **outside** the synchronous try/catch that issued it. Skipping is also the right behaviour: a parked impact plays at the first click, not at the arrival. The play promise additionally carries a `.catch` naming the verb, the same discipline every fire-and-forget draw here follows. |
| **The delay is a timer, not a playback option** | one `setTimeout` before the `AudioHelper.play` call | Read from core rather than assumed: `AudioHelper.play` hands `game.audio.play` exactly `{volume, loop, context}` on the local path, and the receiving client's `playAudio` handler rebuilds the same three — a `delay` put on the object is dropped at both ends. One timer on the issuing client is enough **because the rail runs on one client**: it fires there and the broadcast goes out at the arrival instant, so every listener hears it then. |

**2026-08-11 (the bench walk) — a spread weapon is AIMED before it is declared.**
*"Shouldn't they have to place the pattern first, then they say how they'll attack?"* Raised against the
sequencing the walk saw: the animation played at the roll while the damage waited on a Confirm click,
and the corridor the damage used was drawn *after* the shot had already been declared.

| Ruling | Value | Why |
|---|---|---|
| ⭐ **The fire control enters placement, not the modifiers window** | one PIXI corridor + a DOM readout on the aiming client (`module/combat/spread-placement.js`); Esc or right-click cancels | A shotgun is an area weapon in the Core rules, so the corridor decides the band, the width and the banded damage — everything the modifiers window would otherwise ask about blind. Aiming *is* the declaration. Nothing is spent by it: the magazine is decremented inside the base system's fire methods, two steps further down, so a cancelled aim is a shot that never happened — asserted by value on `shotsLeft`, not by inspection. |
| **The shooter places it, and only the shooter sees it** | the ghost is client-local PIXI; the planted region keeps its GM-only visibility | The aim belongs to whoever is taking the shot, and it is theirs until they commit to it. Once planted, the pattern reverts to the existing semantics with no new rule: a client-local Graphics is invisible to the table by construction, so this cost no visibility code at all. |
| **The corridor is an angle and two reaches, not a point** | `angleDeg` · `reachM` (rail) · `lengthM` = reach + the aimed-at figure's half-width (plant) · `widthM` · `band` | One rotation basis, the rule this rail follows everywhere. Every consumer rebuilds the line off the shooter's figure as it stands, so a token nudged between the aim and the roll still fires along the line that was drawn. The two reaches are two different questions: the rounds are drawn to where the shooter clicked; the region is planted past it, because ending the polygon on a figure's centre puts that centre on its end edge and makes containment a floating-point comparison — the defect that once resolved a burst against a bystander. |
| ⭐ **The aim is resolved ONCE per payload and threaded** | `payloadAimPoint` → turn, ambience, smoke, burning ground, every `fxShot`, every refused round's hit mark | It was read four times from the same two tokens, which was harmless only while there was one possible answer. There are two now, and a declared corridor may be aimed short of a figure, past it, or at open ground — so a second reading is how the rounds cross one line while the region is planted on another. The fan-out reports what it used (`aim`, `aimSquares`, `aimDeclared`) for the same reason it reports its pacing. |
| ⭐ **Damage and animation are one event** | the plant awaits `presentationSettled(payload)` and resolves the pattern itself; no Confirm card is posted for a declared corridor | The Confirm click did two jobs — aim and resolve — and the ruling moved the aiming half to the front. What is left is "resolve now", which the roll already committed to, so it happens when the rail says the shot is over. On a client that did not draw the shot the same call takes its arithmetic route, which is the honest floor. This is what retires review finding F4's late-window complaint for this flow. |
| ⏪ **A shell nobody aimed keeps the card** | gated on `declaredAim`, recorded on the region | A payload with no corridor was planted on one the module *guessed* from the target axis. A guess is still shown to a reader before it resolves; a statement is not. Keeping the fallback is also what leaves the flow reachable from a macro or a keeper driving the roll directly. |
| **The band ladder is one pure derivation** | `lookups.js spreadBandSpec` / `spreadBandDamage`, read by the preview and by the plant | The arithmetic existed once, inside the plant, because nothing else needed it. Two readers is how a preview starts promising a width the plant does not honour. |

**2026-08-11 (the bench walk) — impact-family effects fire at ARRIVAL, and every hit keeps them.**
Reported in two halves against the MPK-9 and the Ronin: *"blood splashes and dust/impact marks play when
the round DEPARTS"* (worst on rifle and heavy, the classes whose round is visible longest), and *"hits
late in a long burst get NO blood at all"*.

| Ruling | Value | Why |
|---|---|---|
| ⭐ **A painted round has an arrival, and it is measured** | `TRACER_ARRIVAL_MS` — bullet.01 100/333/467/567/733, bullet.02 267/200/367/533/700, by band; fallback 400 | The impact was held back by `dashSquares > 0 ? dashMs : 0`, and four of the five shipped classes carry no dash — so the ordinary case confirmed its hit at the muzzle. `stretchTo` paints the whole line at once but the **asset** animates a head across its own frame, and the engine serves a different file per distance band, so the arrival is a property of the band. Decoded off the installed files at 30 fps: the first frame at which the leading lit column stops advancing (98 % of the clip's own maximum, which normalises each file's padding). Two short-band anomalies recorded rather than smoothed — §4.2a. |
| ⛔ **ONE derivation per payload, threaded** | `arrivalSpecFor(class, ammoKey, distSquares, volley)` → `{ms, source, band}` | The mark, the pellet arrivals, the spray, the burning ground and the tail floor all hang on this number. A second derivation is how the mark and the blood on one shot come to disagree. Resolved once in `fxWeaponFired` and handed down, exactly as the load key is. Keyed by the **tracer key**, so a load that replaces the picture (`slug` → `bullet.02`) is banded off the picture it was replaced with, with no branch. |
| **The tail takes it** | `presentationTailMs(class, ammoKey, volley, arrivalMs)`; rifle 933 → **1200** ms at the 30ft band, **1533** at 90ft; travelled classes unmoved | The mark is drawn most of a second later than it was, so a floor computed without that term opens the apply window over it — the silent, one-directional failure the standard's rule 15 names. Passed rather than derived because the arrival needs the shot's **length** and the function is pure. With nothing passed it returns exactly what it returned before, so a caller holding only a class and a load gets the old answer rather than an invented one. |
| ⭐⭐ **The impact family is off the tracer's budget** | `HIT_MARK_MAX_PER_PAYLOAD` = `MAX_FX_SHOTS` (30); blood keeps its own cap of 4 | The pacing rule refuses a late round **whole**, and it is right to — but a tracer is a sprite per pellet every cadence slot, while a mark and a spray are one sprite each at the far end of the shot, and they are the only thing that says the round landed on somebody. A ten-round burst that hit six was marking three. A refused round's mark is issued on its own, with the lateness that caused the drop subtracted from the arrival so it lands beside the rounds drawn on time. Measured: 20 rounds, 20 hits → 13 refused, **20 arrivals marked**, 4 sprays. §4.1a. |
| Both paths resolve the mark through one function | `hitMarkFor(class, ammoKey)` | A second copy of the promotion rule (`impactKey` where a row names one, `impactClipMs` likewise) is how a promoted asset ends up drawn on one path and not the other. |

**2026-08-11 (the bench walk) — ⏪⏪ the buckshot volley is VETOED; the fan returns, irregularised.**
Verbatim essence: *"the visible bullets and long trails are a problem"* — buckshot is small balls in an
irregular grouped spread, not a rank of side-by-side rounds — *"the arrival fireballs were GREAT but
scale them down"* (≥ 50 %) — *"choose a new asset for buckshot or go back to what we had"*.

| Ruling | Value | Why |
|---|---|---|
| ⏪⏪ **`VOLLEY.enabled` → false** | shelved, not deleted; the hit mark the trial suppressed comes back with it | Every downstream site was written as a fall-through, so one field reverts the whole thing and a keeper leg drives the shelved branch with a hand-built spec to prove it. Findings **F9** (overlay reach) and **F4** (settle cap at the content end) die with the element. |
| ⭐ **The fan is irregularised, seeded** | `PELLET_CHAOS` — `slotFraction` 0.9 · `reachFraction` 0.35 · `sizeFraction` 0.25 · `staggerMs` 45 | Per-pellet angle, depth, drawn size and start, all from the **shot's own seed** — which folds the round index *and the rolled damage*, so two clients agree while two identical trigger pulls do not. That is the F3 entropy rule the volley failed, applied to the thing that replaced it. |
| ⛔ **Both geometry knobs are scaled by the class's own cone, and the result is clamped to it** | measured: worst pellet **45.0 px** from centre over 400 seeds, against a 50 px half-width | The first build scaled the angle by the whole cone and the depth by the whole shot, and a **hit stopped landing on the body it was aimed at** — 113 px from centre, measured on the rig. Converging on the target is what makes a hit a hit. |
| ⏪ **`dashSquares` 1 → 0.7** | revert value `1`; the six draw 0.53–0.88 with the size jitter | The number is the drawn **width** and the asset lights roughly a fifth of it, so shortening the frame shortens the trail more than the ball. Deliberately not taken to **0.5**, which is the value already rejected by eye on this row as "a few pixels, reads as dirt on the screen". **A look call — it wants eyes.** |
| ⭐ **Small arrival marks at the pellet endpoints** | `PELLET_ARRIVAL` — dust ring, **0.45 sq** (under 40 % of the class's 1.15 aim mark), trimmed to **500 ms** | The half of the trial the ruling kept, moved onto the fan's own endpoints, which `pelletEndpoints` already computes. Never named for the settle signal. |
| ⛔ **The razor split: standard buck gets dust, the incendiary shell gets its fires** | one gate, `entry.groundFire` | The incendiary load's landing points are the same pellet endpoints and the burning ground already sets a real flame at each. Adding a fire mark would have re-created exactly the doubling the 2026-08-09 ruling deleted (*"get rid of the blast circle that lands on the target"*). **The api shell's red treatment is untouched.** |
| The burning ground takes the fan's jitter | the **first round's** own record, same helper, same seed | Once the fan was irregular, flames on the even ladder would sit a square off the pellets that lit them. "Never invent a position you could have asked for." |
| **No better asset exists on the free tier** | re-enumerated at the veto | The ranged families are single bolts, the volley families are the aligned-lane clips just vetoed, and the throwables are single objects. Anything better is a paid-tier or third-party question, and captures come before any switch. |

**2026-08-11 (the bench walk) — ⏪ the hardened rounds' FLIGHT tint is deleted; the impact stays.**
The question the user put was a consistency one: `hollowPoint` had already been deleted under the
realism razor for saying a difference a viewer cannot see, so why does an armour-piercing round still
**fly** differently? The answer is that it does not.

| Ruling | Value | Why |
|---|---|---|
| ⏪ **`ap` and `dualPurpose` lose `tracerColor`** | revert value `tracerColor: TRACER_COLOR_HARDENED` (hue 8, sat −0.85, bright 1.45), recorded at each row and at the constant | A hardened core changes what happens when the round **lands**, not what it looks like crossing a room — so the near-white bolt was the rail asserting something untrue about the flight. Both rows now fall through to the **class's** own tracer colour, which is to say an AP round flies exactly like a standard one. On the shell that is `null`: the fan is left in the asset's own colour. |
| ⭐ **The IMPACT stays, which is what passes the razor** | `impactKey: IMPACT_CRACK.key` on both rows | The difference is real and it is at the far end: a visibly different strike. Deleting a distinction is only right where nobody could see it; this one is exactly where a viewer *can*. |
| The matrix stays declared | on no shipped row | This file's standing habit for a superseded mechanism — restoring the tint is one field on each of two rows. |

**2026-08-10 — the dart load draws SINGLE FILE on a stream-firing class.** Reported from the bench,
gun 09 (a stream-firing 5.56 class under the `flechette` load), verbatim: *"Flechettes still keep coming
for over a second after the firing sound stops. The animation simply isn't synced up with the shots.
Since this is an assault rifle shooting flechettes, they should come out in the same bullet stream as
the regular shots do — one after the other, single file."*

| Ruling | Value | Why |
|---|---|---|
| ⏪⏪ **The `flechette` row stops naming a count and a cone** | removed: **`pellets: 8, spreadRad: 0.1`** (the revert values, recorded at the row and here). Kept: `dashSquares: 1.1` · `dashMs: 170` · `impactScale: 0.7` · `tracerColor: TRACER_COLOR_DART` | One mark per round, through the same per-round path standard ammo takes, in the round's own cadence slot. The **look is untouched** — what was rejected is the group, not the round. Written as a *removal* rather than as a branch, so a class that draws one round per slot resolves to one and a class whose own row draws a group (the shell: 6 at 0.07 rad) keeps its own; both are fall-throughs. |
| ⭐ **The count was the defect, not the clock** | measured on the rig, 20 rounds at the rifle's 80 ms spacing | The pacing unit (§4.1a) had **already** anchored the schedule and already refused rounds it could not draw on time, and the loop did finish when the reports did (1593 ms against an intended 1520 ms). The picture still did not: a count of eight on a twenty-round payload is 160 sprites handed to a renderer that draws at its own pace, and **no pacing rule can reach a backlog created by the rounds it chose to keep.** The only lever on that backlog is the count. Before: the last mark left the screen **3433 ms** after the last report. After: **2248 ms**, against a same-payload **control** with no overlay at **2278 ms** — i.e. the load is now indistinguishable from the ordinary stream, and the ~2.2 s that remains is this headless rig's own drawing delay for *any* load. ≈**1.2 s** of the report was the count, which is the "over a second" it named. |
| ⛔ **The load still declares its own projectile** | `ammoRedefinesProjectile("flechette") === true`, now off `dashSquares,dashMs` | `AMMO_FX_PROJECTILE_FIELDS` lists `pellets` among four, and the test is key presence — so dropping the count is exactly the edit that could have silently reclassified this load as "a tint only" and handed it to the branch that replaces the round wholesale (F9b, below). It still answers true off the fields that remain, so the volley escape holds and `presentationTailMs` still reads `dashMs`: the tail is **1003 ms** on the rifle, unchanged, and no apply window moved. A keeper leg pins *which* fields carry the answer. |
| The `stundart` row **keeps its group**, and the count becomes its own — ⏪ **superseded 2026-08-11, see the entry below** | `pellets: 8, spreadRad: 0.1` stated at that row rather than mirrored from `flechette` | The two rows were deliberately written as one set of numbers so a change to the dart look would move both. This ruling moved one and not the other, so the shared half (length, crossing, mark, grey) stayed shared and the count became local. Its last sentence — "a later ruling on this load is a two-field edit at that row" — is exactly what happened the next day. |

**2026-08-11 — the same ruling, on the stun dart, decided by the WEAPON CLASS.** Asked whether the
`stundart` load should draw single file the way `flechette` now does, the user ruled, verbatim: *"Is it
fired from a weapon that usually fires in a single file line? If so yes. If it's fired from a shotgun,
no."*

| Ruling | Value | Why |
|---|---|---|
| ⏪⏪ **The `stundart` row stops naming a count and a cone too** | removed: **`pellets: 8, spreadRad: 0.1`** (the revert values, recorded at the row and here). Kept: `dashSquares: 1.1` · `dashMs: 170` · `impactScale: 0.7` · `tracerColor: TRACER_COLOR_DART` | The ruling names a **class**, not a load, and the mechanism for "the class decides the shape" already exists — it is the removal the day before. A row that names no count leaves the class's own answer standing, so a stream-firing class draws one dart per cadence slot and a shotgun class fans from its own row. Both halves of the ruling are therefore one edit and **no branch**: "if so yes" is the fall-through to the per-round path, and "if it's fired from a shotgun, no" is the shell's own `pellets: 6, spreadRad: 0.07` coming through the merge untouched. |
| The **dart look is untouched**, exactly as it was for `flechette` | 1.1 sq at 170 ms, a × 0.70 mark, `TRACER_COLOR_DART` | What was rejected is the group, not the round. `dashMs` is the tail's own input and did not move, so the tail is still **1003 ms** on every class and no apply window opened early — the arithmetic is byte-identical before and after. |
| ⛔ **The load still declares its own projectile** | `ammoRedefinesProjectile("stundart") === true`, now off `dashSquares,dashMs` | Same guard as the day before and it matters more here: the stun-dart 00 shell is the *specific* load the F9b escape was written for — it was drawing orange fireballs out of the round-replacing branch until 2026-08-10 — so silently reclassifying it as "a tint only" would have reopened a fixed defect. Keeper legs pin the answer, the fields carrying it, and the escape on a buckshot cartridge. |
| The two dart rows are **one set of fields again** | `stundart` and `flechette` now resolve identically on all five classes | Which is what they were before 2026-08-10, for the reason that was always true: a stun dart and a flechette dart are the same object fired for different reasons. They stay written out separately rather than shared — one ruling has already moved one without the other. A keeper leg asserts the two are equal, so a future divergence is visible rather than silent. |

**2026-08-11 (later the same day) — ⏪ the bench row built to SHOW that ruling is withdrawn.** The
ruling above was honoured in the rail immediately, but the bench could only exercise its second half:
`stundart` is registry-locked to the shotgun caliber family, so the only guns that carry the load and
still resolve to a stream class are shell-chambering oddities whose pack entry happens to read
`attackType: "Auto"`. A row was added on one of those to make the first half visible. Shown that, the
user ruled it out, verbatim: *"The request was meant to fill out the actual ammo types with animations,
not invent a new one from scratch."*

| Ruling | Value | Why |
|---|---|---|
| ⏪ **Bench row 17 is removed, along with the smoke section that read it** | the bench is **16 rows** again; the smoke is back to **36 checks** | The bench's job is to walk down the loads the product ships and see each one drawn. A row that has to be arranged out of a caliber-family coincidence is not one of those, so it was misreporting what the bench is for. Removed at the source (the provisioner no longer builds it) rather than merely hidden, and the rig's bench actor had the weapon and its magazine deleted with it. |
| **The `stundart` family lock stays as it is** | `AMMO_MODIFIERS.stundart.families` untouched — shotgun family only | The open question in §8 asked whether to widen it so an ordinary cartridge weapon could chamber the load. It is closed the same way: leave it. This is a **rules** position and not a code one — the books give the stun dart as a shell, and the shipping Stundart Pistol carries a proprietary round rather than a load — so nothing in the registry, the gate or the ammo sheet moved. |
| **The rail itself is untouched** | `AMMO_FX.stundart` keeps `dashSquares: 1.1` · `dashMs: 170` · `impactScale: 0.7` · `tracerColor: TRACER_COLOR_DART` | The removal is a bench decision, not a reversal of the ruling above it. That row is what styles the dart on the path that **is** reachable — the shotgun class, where the class supplies the fan and the load supplies only the look. The rail keeper still pins both halves of the class-decides rule and every leg covering the shotgun path stays green. |
| 📌 **SHELVED, not deleted: how to bring the stream demonstration back** | zero new code | Recorded because the knowledge cost more than the row did. `weaponFxClass` resolves `attackType` **before** `weaponType`, so any weapon typed `Rifle` with `attackType: "Auto"` answers `rifle` no matter what it chambers; and the `stundart` overlay names no count, so a stream class already draws it one dart per cadence slot with its own length, crossing and grey. Any weapon that could legally take the load and resolved to a stream class would therefore render single file the moment it existed — **the only barrier is the family lock**, which is deliberate and ruled kept. The withdrawn row used a 10-gauge weapon (`CAL10`, a shotgun-family caliber, so the pairing passed the gate on its own terms) carrying `attackType: "Auto"`, and ⚠ that entry comes from the scraped `rifles-add` set the data-rot sweep flagged — it may be correct and it may be rot, which is a second reason not to have rested a demonstration on it. Every such weapon in every pack is RoF 1–2, so the "stream" was two darts even when it worked. |

**2026-08-10 — the origin field: the payload names WHICH FIGURE fired.** Reported from the table: a
scene held two figures of one actor, and firing from one drew the muzzle work and the rounds out of the
other. User GO to carry the firing figure's identity on the payload and have the rail prefer it.

| Ruling | Value | Why |
|---|---|---|
| ⭐ **The payload carries the firing figure — `attackerTokenId`** | captured in the fire wrapper by `_firingTokenId(actor)`: synthetic actor's own figure → the selected figure on the viewed canvas → core's speaker resolution → `null` (`module/seam-shim.js`) | The rail resolved the origin from `attackerId`, which is an ACTOR id — two figures of one actor share it, and an unlinked figure's own actor carries the base id as well — so the lookup could only answer "whichever was placed first" and a shot from the second figure was drawn from the first. The identity is unambiguous at the trigger pull and nowhere afterwards, so it is captured there and carried. The **name is deliberate parity**: the suppressive payload has always called this field `attackerTokenId`, and `DamageDialog._attackerTokenDoc` and `vehicle-targeting.resolveFacing` already read it — so the fire payload gains the field those consumers were already asking for. §1.1 |
| The rail **prefers the named figure, and keeps the old lookup as the fallback** | `shooterTokenForPayload(payload, actor)`, read by the fan-out AND by `payloadPresentationMs` | Two fallbacks, both deliberate: a payload with no such field (older or re-emitted) and a named figure this client is not drawing (relayed from another scene) both resolve exactly as before. `shooterTokenOf` itself is **unchanged** — whether a shot with no figure on the viewed scene should draw at all is a separate open question (§8) and pre-empting it here would have decided it by accident. Both call sites read the one resolver so the window a caller waits out is measured from the figure the shot is drawn from; the keeper pins that by value (a 12-square shot's 1200 ms against the same payload resolved to the far figure's 1600 ms). |
| The **suppressive capture is the same rule** | `_firingTokenId(this.actor)` replaces the first-match-by-actor-id lookup in the suppressive wrapper | It had the identical defect in the identical shape, one field along, and two rules for "which figure is this actor" in one file is the thing that lets them drift. |

**2026-08-10 — the personal-review fixes (F3 · F9 · F7 · F1).** A read-only review of the whole FX arc
raised nine findings; the user ruled four of them for fixing on the same day. All four are below, and
each one closed a blind spot in the *keeper* as well as in the product.

| Ruling | Value | Why |
|---|---|---|
| ⭐ **F3 — the volley seed folds in the ROLLED DAMAGE** | `fxSeedOf(attackerId, weaponId, shots, hits, i, JSON.stringify(areaDamages))` | User, verbatim: *"use a more dynamic seed… damage numbers."* Every term the seed had was identical across two consecutive shots from the same gun at the same target, so the chaos knobs answered "the volley is too neat" for the rounds of one burst and not for repeat trigger pulls: a bench firing the same gun saw at most two pictures. The rolled damage is the term the burning-ground seed already folds, in the same position — so the two seeds now have one shape between them. Clients still agree because the rolls ride the payload. §3.2b |
| ⭐ **F9a — the volley honours the resolved entry's colour** | `if (entry.tracerColor) shot.filter("ColorMatrix", entry.tracerColor)` on the volley sprite; reported as `out.volleyColor` | A branch that REPLACES the drawn round still owes the load its treatments (standard rule 20). The volley read no overlay field at all, so an incendiary 00 shell drew the plain orange clip, `ap`/`dualPurpose` lost their hardened tint, and the standing *"update one shotgun ammo type's animation, update them all"* ruling was true of the pellet fan and false of the thing that replaced it. Same expression as the fan's, so the declared-vs-painted semantics carry over untouched: the shell row's `tracerColor: null` paints the base volley with nothing. |
| ⭐ **F9b — a load that draws its own projectile is NOT replaced by the volley** | `ammoRedefinesProjectile(key)`; `AMMO_FX_PROJECTILE_FIELDS` = `pellets` · `dashSquares` · `dashMs` · `tracer` | `volleyOwns` asks the *cartridge*, and a stun-dart or baton 00 shell is buckshot by caliber while being a needle swarm or a blunt slug by picture — so the branch that replaces the round was replacing rounds the table had already described. The rule is written against the overlay table rather than against a list of load names, so a new row that names its own geometry is covered the day it is added. Both the fan-out and `payloadPresentationMs` ask it, so the tail matches the picture actually drawn. §3.2b |
| ⭐ **F7 — the load's per-hit riders travel with the pattern** | zone flags gain `stunSaveOnHit` · `stunSaveMod` · `dotEnabled` · `dotTurns` · `dotType` · `dotDamageFormula` · `effectTypes`; `_applyAreaHitToToken` makes the single-target flow's own two calls | The pattern carried the ARMOUR half of what a load does and nothing else. That was invisible while only flechette threw a pattern (a load with no riders); the moment RAW buckshot joined the pattern flow, every 00 shell carrying riders lost them — a stun dart's −2 and an incendiary's ignition simply stopped happening, because the pattern outlives the payload and the region recorded neither. The confirm now applies them **per landed shell per token**, mirroring `_autoApply` exactly, including its ordering (the shock-state write before the prompt that reads it). Loads with no riders store the "does nothing" values, and a pattern placed before this change resolves unchanged. |
| ⭐ **F1 — the canary gains two exception classes** | `skipped: "shooter"` bail; `jb2aActive()` gate | A sheet-fire by an actor with no token, and an install with the engine but no assets, are both ordinary and both made a healthy client say the module was faulty — the second while advising a reload that could not help. §7.5 |

**2026-08-09 — the column deletion, the muzzle restoration, the volleybul trial and the identity pass.**

| Ruling | Value | Why |
|---|---|---|
| ⏪⏪⏪ The **discharge column is DELETED** — the four-report saga ends by deletion, not by another trim | `COLUMN_SQUARES`, `COLUMN_TRIM_MS`, `COLUMN_DWELL_MS`, `columnRateFor()`, the build site, the two row fields, the two mask entries, the five overlay `columnColor`s and the tail term — all gone | User, verbatim: *"just replace the control with Shotgun blast muzzle 01. Randomize between 01 and 02 on each shot."* The chain is the argument: **FR#22** added a stretched `bullet.02` to give the shell the spiky bloom the lance could not, and removed the shell's lance in the same breath; **FR#23** shortened it to 1.25 squares because stretched to the aim point it drew a rifle-like round on the pellet fan; **FR#25** trimmed it 300 → 55 ms because the frames after the bloom were a tail and a starburst; and the same report gave it a 220 ms dwell to buy back the presence the trim had spent. Four reports, each removing more of an asset chosen for one frame of itself — and it had by then grown a private copy of the lance's own trim-and-dwell machinery. Nothing is left wired: an element needing a trim, a dwell, a derived rate and a shortened stretch to show one frame is not a mechanism worth keeping one field from use. §2, §3.1 |
| The shell takes the **ordinary muzzle lance**, at 1.9 squares | `muzzle` + `muzzleSquares: 1.9` + `muzzleMs: 220` | FR#22 had taken the lance off this row *because* the column sat over it; with the column gone that reason goes too. 1.9 is measured against the ladder rather than picked: drawn width in grid units, so pistol 1.1 → smg 1.2 → rifle 1.6 → **shell 1.9** → heavy 2.1, which on this rig at grid 100 draws 110 / 120 / 160 / **190** / 210 px. A 12-gauge bore is ~3× a 5.56's and leaves as an expanding blast, so it must read heavier than the rifle; it sits under the 20 mm because that is a cannon. Capture 67d. |
| The **01/02 randomisation is the key's own** | one key, two files | Verified against the install rather than assumed: `jb2a.muzzle_flash.single.01.yellow` resolves to `MuzzleFlashSingle01_**01**_…` and `…_**02**_…`, both 833 ms, differing in shape not clock. Naming one key delivers the ruling with no alternation machinery; a second key with hand-rolled alternation would have been a mechanism where the database already has one. A keeper leg counts the files under the key. |
| ⏪ The 220 ms **single-discharge dwell returns to the lance** | `muzzleMs: 220`, rate 0.5 | The same number FR#21 ruled, now carried by the one mechanism instead of two. FR#21 added it for the class that fires one round per pull; FR#22 orphaned it; the column then reimplemented it privately. One mechanism, one row, four classes still at rate 1. |
| ⏪ The **pellet-tint ruling OUTLIVED the column** | `tracerColor: null` stays on the shell row | It was reported against the column era ("the little dorito shaped pellets didn't get the same red treatment as the spiky cone") but it was never about the column — it is about the **mask**. Deleting the column left it intact with one element to reach instead of two. |
| ⚠ **VOLLEYBUL: a live TRIAL, explicitly NOT ADOPTED** | `VOLLEY.enabled = true`, revert is that one constant | User, verbatim: *"I honestly like the whole clip, the fireballs look good… I need to see this on the test rig myself before I say adopt. Let's try full range."* Buckshot draws `volley_of_projectiles_Line.bullet.001.001.orangeyellow` — a five-round fan with baked arrival fireballs — in place of the six-dash fan, with our own hit mark **suppressed** so the square carries one arrival rather than two. Flechette and slug never enter the branch. Everything about it is built to be withdrawn: every downstream consumer is a fall-through, not a second path. §3.2b |
| The volley's tail is **band-derived**, off a mirror of the engine's own picker | 600 / 800 / 1200 / 1600 ms at < 5 / 5–9 / 9–15 / ≥ 15 squares | The asset is range-banded: the database serves a different FILE per distance and each bakes its own crossing. Boundaries read out of `SequencerFileRangeFind.ftToDistanceMap` rather than guessed (5, 9, 15 squares), and the two per-band numbers decoded off the installed files at 40 ms — arrival 240/480/840/1200, content end 600/800/1200/1600. A fixed guess opens a 15-square shot's apply window a full second before its rounds land. The tail takes the CONTENT END, not the file duration: every band spends its last 1–2 s on a residue at 40–70/255 over 0.1 % of frame, and holding the window 3.4 s for that is the cost §4.2 exists to refuse. |
| The volley's **chaos is seeded, and per SHELL** | `mirrorFlip` on, `jitterDeg` 5, seed folds in the round index | Reported: the volley is too neat. The mirror flip and the aim jitter are properties of the SHOT rather than of the client that drew it, so two clients agree and a test can compute it twice. The jitter rotates **about the shooter**, so the distance — and therefore the band and the whole tail arithmetic — is out of its reach. Folding the round index in is what makes an autoshotgun's three shells differ from each other; a per-payload seed would have made a burst three identical copies, which is the report one level up. Measured over 300 seeds: 151 mirrors, mean \|jitter\| 2.45°. |
| ⚠ A volley **miss still lights fireballs in the dirt** | accepted for the trial | The arrival is baked into the asset, so a missed volley blooms wherever it lands. The user judges this live — capture 67c is the frame. |
| ⭐⭐ **THE REALISM RAZOR:** a load gets a visual only if you could plausibly see the difference | — | The user's own framing, and it is what the next three rows are decided by. A table shown a difference that does not exist learns to distrust the ones that do. |
| ⏪ **`hollowPoint` and `safety` are DELETED** | both rows gone; `impactScale` stays a live field | Their entire content was a multiplier on the hit mark's width — × 1.60 and × 0.55. Nobody watching a firefight reads a hollow-point off the size of a mark. **Mechanics untouched:** this table has never been read by any damage path, so only the pictures died. Bench guns 02 and 03 now draw identically to 01, which is the point of those rows rather than a regression in them. Capture 67i; restoring either is one line. |
| ⭐ The **slug gets its own row** — one heavy painted bolt | `pellets: 1`, `dashSquares: 0`, `dashMs: 0`, `tracer: bullet.02`, standard shift | It had been inheriting the shell's six-pellet fan, i.e. a single projectile drawn as buckshot. Written entirely in the class row's own fields: `pellets: 1` returns no fan at all (the planner only fans above one) so the draw path falls through to the single-endpoint branch every other class takes, and `dashSquares: 0` is the path's own switch from travelled to painted. `dashMs: 0` is **not cosmetic** — it is a tail correction, see §4.2. It should read like rifle fire, and it does: same bolt family, same 933 ms tail. Capture 67e. |
| ⏪ **The stun dart stops being the baton's twin** | `stundart` = the flechette geometry in the dart grey | They had been byte-identical, on the reading that both are less-lethal and differ only by a stun modifier nobody can see. The ruling reverses that on the **object** rather than on the mechanic: a baton round is a fat blunt slug and a stun dart is a *needle* — thin, finned, fired in a group — so they do not look alike at all, and drawing them alike was the visible error. The baton asset and the dust puff stay with `rubber` alone. Capture 67f. ⏪ The "fired in a group" half of that sentence was superseded on 2026-08-11 (the single-file ruling above): the group is now the shell's to draw, and the needle is said by the colour, the length and the mark. What this ruling bought — the look — is untouched. |
| ⭐ **The dart language: grey is darts, orange is balls and bullets** | `TRACER_COLOR_DART` = hue 0, sat −0.90, bright 1.15 | A rule, not one row's tuning. The tier ships one projectile family and it is orange, so an 8-dart flechette fan and a 6-pellet buckshot fan were the same picture with a different count — and a count is not a difference the eye takes at 150–170 ms. Colour separates them in one frame and says the load's own true thing: a dart is a bare metal spike. ⚠ It is a **desaturation, not a darkening** — brightness sits above 1 for the same reason `TRACER_COLOR_BATON`'s 1.30 does, because the rejected rubber treatment proved a dimmed sprite on a dark scene is a round the eye has to hunt for. Its own constant rather than a reuse of the baton matrix, so a later change to one cannot silently change the other. Captures 67f / 67g / 67x, and the 67fgh triptych. |

**2026-08-09 — the pacing unit.**

| Ruling | Value | Why |
|---|---|---|
| A round that cannot start on its slot is **dropped, not queued** | `FX_DROP_LAG_FRACTION` 0.5 | User, verbatim: *"the audio already told the ear the story."* The fan-out paced by wall clock against a render loop, with a fixed per-round sleep, so timer lateness compounded — a 30-round shell burst measured **11 681 ms against an intended 5 220 ms (2.24×)**. Anchoring the schedule plus dropping the late rounds brings the same burst to **5 309 ms (+89 ms)**. §4.1a |
| The drop takes the round's **audio** too | — | ⏪ The first build kept the audio and refused only the picture. A starved loop reaches several slots at once, so keeping the audio put two and three reports in one tick — measured gaps of **231, 0, 235, 0 ms**. The rhythm is worth more than the round. |
| The threshold is a **fraction of the cadence**, not a flat figure | 0.5 → 40 ms / 90 ms | ⏪ A flat **150 ms** shipped first and the rig refused it at the default 80 ms cadence: gaps of **256, 1, 256 ms**. A round drawn more than half a slot late is already past the next slot, so the two draw together. Half a cadence makes "no two drawn rounds closer than half a cadence" arithmetic rather than hope. |
| The **last round is never dropped** | — | It carries the settle tag. Keeping it means the completion signal is always named on a drawn element, so the apply window can never wait on a refusal — and no retagging machinery is needed. |
| A settle watch always ends | hard stop at `PRESENTATION_CAP_MS` | Neither original exit fires for a watch whose elements were created but never all reported gone; five overlapping fan-outs left **2 of 5** in the maps indefinitely. Resolving on the cap the window already honours cannot change what a caller sees. §4.2 |
| Flames **queued but not yet created** count against the scene cap | `pendingGroundFires` | Exposed by the faster hand-over: two placements inside one beat both read the same `liveGroundFires()` and both under-evicted — **28 alive against a cap of 24**. |

**2026-08-09 — the blood rebuild and the api report.**

| Ruling | Value | Why |
|---|---|---|
| The spray is **directional**, along the shot | `jb2a.liquid.splash_side02.red`, `rotateTowards` a point one grid unit beyond the target | User, verbatim: *"It's angled. The blood pushes out in a direction. It should move in the same direction as the bullet that strikes the target."* ⏪ supersedes the radial `splash02.red`, which had been chosen **because** it was radial (centroid fixed at 0.50/0.51 of its frame) and so could never disagree with the axis — the very property that made it say the wound had no direction. The side cut's ink traverses 0.29 → 0.65 of its own frame. Capture 64a. |
| One spray per **landing round**, not per payload | cap 4 | ⏪ User, on the MPK-9 burst: a ten-round burst marked its target exactly as hard as a single shot. The cap is measured — the clip lives 900 ms and hits are the leading rounds, so ten hits at an 80 ms cadence would overlap ten sprays inside one clip's life. Four read as four arrivals. Capture 64b. |
| Each spray runs on its round's **visual-impact clock** | `delayMs` = the load's `dashMs` | The spray starts when *its* round arrives, not when the payload resolved. A round the pacing rule refuses draws no spray either — the two share one draw block. |
| The incendiary **blast ring on the target** is withdrawn | `AMMO_FX.api.impactKey` removed | User, verbatim: *"get rid of the blast circle that lands on the target. I think multiple are being placed."* Removing the field is the whole fix — the row falls through to the class's own standard hit mark, like every unpromoted load. The tail is unchanged (the promotion was already trimmed to 833 ms). The tinted rounds, tinted flash and burning ground all stay; `IMPACT_FIRE` stays declared, one field from returning. Capture 64c. |
| The incendiary red is **eased one notch** | hue −20 → **−14** | User. Saturation and brightness were never in question. ⏪ The revert value −20 is recorded at the site. |
| The out-of-combat pattern TTL **works as built** | — | Verified live end to end on a real fired pattern: placed with no owning encounter, still present at 20 s, removed by the module's own interval at **70.0 s** (TTL 60 s + one 15 s sweep tick). The lingering patterns that prompted the check belonged to the **round** rule, not the clock rule — see §8. |

| Date / ref | Ruling | Why |
|---|---|---|
| FR#1–5 | The flash is a **client-local light source**, not a token document update | The document transport delivered an 85 ms envelope in ~1.3 s of wall clock; a viewer watched the light bloom outward and fade. Nothing about the values was wrong; the transport was. |
| FR#5 | Lit sprites are routed **above the lighting**, not merely elevated | Elevation does not choose the layer — route flags do. Measured: elevation-only crushes every class to a peak of 15/255; the same asset reaches 232 above the lighting. Accepted cost: above the vision mask too. |
| — | Flash colour **dropped** in favour of illumination only | A coloured source moved 44.8% of a *lit* frame's pixels on this core; the reference's engine does not do that. The user's hard requirement was "no visible flash in a lit area". |
| ⏪ FR#23 | Flash colour **restored, darkness-gated** | Uncoloured read "too white". The stain measurement still binds — but only in a lit scene. Gating keeps both requirements instead of trading one for the other. |
| FR#23 | Luminosity raised 0.5 → **0.65** | "I'd like them to feel pretty violent." A deliberate departure upward from the reference-exact value; it cannot reintroduce the stain, which is the coloration layer's doing. |
| FR#14 | Lance **trimmed to 110 ms** and sized in grid units | Reported "too large / a plume of smoke and fire". Frame-by-frame: the clip opens as a lance and then develops two billowing clouds. Scaling cannot remove a plume; only a trim can. |
| FR#14 | The trim is a **time range**, never `endTimePerc` | Measured: the percentage form cut nothing (1752 ms vs 1634 ms untrimmed); a time range gave 861 ms. Do not swap back without re-measuring. |
| FR#16 | Tracer colour is a **ColorMatrix**, never a tint | `tint` *multiplies*, so tinting orange with pale yellow returns *more* saturated orange — the opposite of the asked-for shift. Photographed side by side. |
| FR#17 | Smoke is **many short puffs overlapping out of phase** | "A lessening amount of smoke continues to advance, rapidly disappearing." One sprite dimming cannot produce that. Structure borrowed from the reference; assets are ours. |
| FR#18 | Every puff is its **own** `.effect()` section | Sequencer's randomisers roll **once per section**, not per repetition. A section with `.repeats(n)` yields n identical copies — the reference itself falls into this. |
| FR#18 | The puff's heading is set with `spriteRotation`, not `rotateTowards` | `rotateTowards` **sets the movement destination**. Puffs built with both flew to the target instead of drifting; measured 6–9 squares out on a 9-square shot line. |
| FR#19 | Pellets are driven by a **speed**, with an arrival hold | With no speed the travel is driven by the lifetime, so a pellet was destroyed at the instant it arrived — and on a client dropping frames, before. Measured: every pellet died at 0.778 of the line. |
| FR#20 | Smoke drift is **capped against the shooter**, with a lateral component | Reported "launching out of the gun like a projectile". The distance was never the fault — every puff slid along the same axis, so the group streamed as one jet. |
| FR#20 | The shell smokes on a **single** discharge (`smokeSingle`) | Reported "I don't see it at all for shotguns". Diagnosis: the shell path drew its puffs correctly; the table simply fires **one** round, and the multi-round gate then asked for none. |
| FR#21 | `muzzleMs` dwell added (lance stretched by playback **rate**, not range) | A single discharge's 110 ms lance is over before the eye settles, where an automatic's restarts read as sustained. Extending the *range* would let the plume back in. |
| FR#22 ⏪ **DELETED 2026-08-09** | The shell gets a **discharge column** (`bullet.02`, stretched) | Decoding the assets showed `bullet.02` carries a spiky bloom, smoke curls and an impact star baked into its own clip. The "spiky piece" lives in the asset, not in our lance. |
| ⏪ FR#22 ⏪ **REVERSED 2026-08-09** — the lance and its dwell are both back | The shell draws **no lance**, and the dwell goes with it | "The newly added spiky cone looks great, but the flame lance from before still sits below it and it doesn't look good. Remove the flame lance." Mechanism left wired — it is one row field from use. |
| ⏪ FR#22 | The burst smoke **stream is retired** | The premise was wrong: `bullet.02` already carries its own smoke, so our puffs were a second smoke over a smoke. That is the reported "spammy no matter how we do it". Cost: pistol/SMG (`bullet.01`) autos are now smokeless — one row field from changing. |
| 2026-08-08 | **No spark star** on any class | Matched A/B on the rig (captures 45/46, 45b/46b): the radial star reads "magical" and "busy" for a firearm, fires rays backward across the shooter, and is a fixed size so it dominates a pistol. "The angled one is good enough." Mechanism left wired. |
| 2026-08-08 | The action is over when the **last round's impact/tracer** ends | Burst smoke and mote motes linger on purpose. Waiting for them would hold the window seconds past the point a viewer calls it done. |
| FR#22 | The settle signal asks the **engine**, not the clock | The engine keeps an effect alive past its nominal time. Measured: RIFLE 1022 ms vs a 933 ms schedule, SHELL 1045 ms vs 983 ms. That overhang is exactly the reported remainder. |
| FR#23 | `APPLY_LEAD_MS` = 150 | Reported "slightly sluggish". The final frames of an impact are nearly transparent, so the eye finishes before the engine does. The scheduled floor still overrides the lead. |
| FR#23 | The column is shortened to 1.25 sq and trimmed to 300 ms | Stretched to the aim point it drew "a rifle-like single bullet per shotgun shot". What it exists for is the bloom at its origin. |
| FR#23 | ⚠ ~~**Open:** at that short stretch the asset's arrival star is not separable~~ | ⏪ **Superseded 2026-08-09** — see the four entries at the end of this table. The star *is* separable, by trim; the "long stretch" alternative recorded here was measured and is wrong. |
| — | A **ruled fumble** draws and sounds nothing | "If the shotgun didn't fire, it shouldn't blast visibly." The round count cannot catch it — the base computes `roundsFired` before consulting the ruling — so the seam forwards the ruling itself. |
| — | An **untargeted** shot is drawn along the shooter's own facing | The previous build answered "which way" separately per element and answered "unknown", so a shot at nothing drew a plain radius and no sprites. Honest limit: it is only as good as a token's rotation. |
| **FR#24, 2026-08-09** | The ammo's **id** rides the payload | Everything else forwarded is a mechanical *consequence*; this is the modifier itself. Two of thirteen (`ap`/`dualPurpose`) carry identical mechanics and were indistinguishable at any distance. Presentation-only: no damage path reads it. |
| **FR#24, 2026-08-09** ⏱ mask narrowed to one field each on 2026-08-09 | Overlays **repaint, never add** | Standing ruling: shell pellets are never tinted, `columnColor` is the escape hatch. Expressed as a merge rule so no branch names the shell. |
| **FR#24, 2026-08-09** | `impactScale` is a multiplier | An absolute width would flatten the per-class impact ladder, which exists because a heavy round lands harder. |
| **FR#24, 2026-08-09** | An impact promotion is **trimmed to the ordinary mark's length** | Otherwise every AP hit would hold the damage window shut for five seconds — a cost nobody asked for, arriving as a side effect of choosing a different picture. |
| **FR#24, 2026-08-09** | The ammo tint goes **through** the darkness gate | The gate is inviolable; the lit-floor stain stays impossible by construction rather than by opacity. |
| **FR#24, 2026-08-09** ⏪ *the mark half was removed 2026-08-10* | Burning ground and its ground mark are **once per payload** and excluded from the settle signal | The fan-out caps at 30 rounds; a per-round lingering element would put 30 overlapping fires on one square for one trigger pull. |
| **FR#24, 2026-08-09** ⏪ **SUPERSEDED — the element was removed 2026-08-10** | The ground mark is **session-bound**, with a lifetime cap in minutes | Real persistence means a document write on the scene from whichever client resolved the shot. That is a shared question with blood decals and needs its own ruling. An uncapped Sequencer effect is a leak by another name. |
| **FR#24, 2026-08-09** | No **audio** layer for the ammo treatments | Sourcing is owed. Recorded so the omission is a decision, not a gap. |
| **FR#25, 2026-08-09** ⏪ **SUPERSEDED BY THE DELETION ABOVE** | ⏪ The column's **tail is out**: trim 300 → **55 ms** | "The shotgun's spiky cone is currently emitting a tail. Let's eliminate that tail (looks like a round or round tail)." The clip was decoded frame by frame off the installed 05 ft file: cone alone at 33–66 ms, a streak behind the muzzle from ~66, heads separating and running forward from ~96, the starburst from ~160. 55 is the largest trim under all three, with the overshoot margin below subtracted. ⏪ Supersedes the FR#23 300 ms value. |
| **FR#25, 2026-08-09** | ⏪ The "long band" alternative is **wrong**, not merely untaken | The 55c note assumed a longer distance band spreads the phases further apart in time. Decoded: all five bands are **933 ms**; they differ in width (600→4000 px), and the bloom is the same ~230 px of art in every one. Head position as a multiple of the bloom's extent at 133 ms of clip: 05 ft = 1.05×, 90 ft = 1.9×. The long band puts the round *further* from the bloom, not nearer. The short band is strictly best; the trim is the only lever. |
| **FR#25, 2026-08-09** | The **starburst and the tail were one element** | Reported separately — "shotgun also has this standard starburst in addition to the spiky cone" — and decomposed on the rig: the starburst appears in a sequence carrying *only* the column, with no pellets and no hit mark drawn. It is `bullet.02`'s own baked arrival phase, ~1.5 squares off the barrel. The trim removes it; the hit confirmation at the target is a different asset and is untouched. Capture 57c. |
| **FR#25, 2026-08-09** ⏪ **SUPERSEDED BY THE DELETION ABOVE** (the dwell moved back to the lance) | The trim gets a **dwell** (220 ms, rate 0.25) rather than being left at 55 ms of wall clock | Two reasons, and the second is why it cannot be tidied away. (1) FR#21 already ruled that a *single* discharge needs ~220 ms of presence, and this is the one class that draws no lance at all. (2) Measured: the media overshoots its range end by a slice of **wall** time, so a slow rate converts less of it into clip. Rate 1 is the **worst** case, not the safest — 139 ms of clip reached against a 70 ms range. At 55/220 the worst clip reached over 16 real discharges was **59 ms**. |
| **FR#25, 2026-08-09** | ⏪ The flechette dart's length is raised **0.8 → 1.1 sq** | User approval. 0.8 was an unmeasured guess ("smaller than buckshot's 1.0") and read faint on a painted-bolt class — capture 56e on the rifle, 57f is the same framing at 1.1. The field is the sprite's drawn *frame* width and the lit slug is roughly a fifth of it, which is the same trap the shell's pellet-size note records (0.5 read as dirt on the screen). 1.1 sits just above buckshot; what kept a dart swarm reading as needles rather than shot was the **count and the spread**, not a shorter mark. `dashMs` is unchanged at 170, and the length is not a tail term, so no apply window moved. ⏪ The count-and-spread half of that sentence was superseded on 2026-08-10 (the single-file ruling below): on a single-round class the answer is now the colour, the length and the mark. |
| **BLOOD, 2026-08-09** | Blood on flesh hits is **approved, phase 1: transient only** | "Blood splatter is approved." Floor decals are explicitly out of this phase — real persistence was the same open question the incendiary ground mark had, and it was to be answered once for both. ⏪ That mark was removed on 2026-08-10, so the question is now the blood splash's alone. |
| **BLOOD, 2026-08-09** | It is **off by default**, on a world switch | This is the one thing the rail draws that a table may object to rather than merely find noisy. World-scoped and not per-player: a table that has agreed to it should not have one player watching a different scene. |
| **BLOOD, 2026-08-09** | **No blood on a target that takes damage into structure** | Vehicles, powered armour and full-conversion bodies do not bleed. Asked at the ACTOR level (`bearsStructuralSdp`), which is the honest limit — see the next entry. |
| **BLOOD, 2026-08-09** | The target-type question is asked **of the actor, not of the zone** | `routesToSdp` is the function that really decides, and it takes a hit LOCATION the payload does not carry: the card says how many rounds landed, never where. So a cyberlimbed character reads as flesh and still bleeds when the round in fact struck the arm. The alternative — suppressing blood for anyone wearing chrome — would be wrong far more often. A keeper leg pins both halves: the arm routes to structure, the actor does not. |
| **BLOOD, 2026-08-09** | ⏪ The free tier **does** carry a blood-coloured asset; no colour filter is used | The unit's own design note said "no blood family, red-tint a liquid splash". Half right: nothing is *named* blood, but `jb2a.liquid.*` ships red variants. Decoded off the installed file, this one means R91 G1 B1 at 113 ms, R95 G1 B2 at 283 ms, R157 G3 B4 at 453 ms — a deep near-black red with the other two channels at zero. A ColorMatrix over that would repaint red with red. |
| **BLOOD, 2026-08-09** ⏪ **REVERSED the same day** | Chose the **radial** liquid; the **side** one now ships | Measured centroids: `splash02.red` holds at 0.50/0.51 of its own frame from 170 ms to 510 ms, so it is radial about its centre and needs no rotation to agree with the shot; `splash_side02.red` traverses 0.29 → 0.65 and is a directional wave. The measurement stands and the conclusion drawn from it did not: "cannot disagree with the axis" was treated as a virtue, and the user ruled that a wound with no direction is the defect. The traversal that disqualified the side cut is exactly what now qualifies it. See §6. |
| **BLOOD, 2026-08-09** | Size is the drawn **frame**, 1.5 sq; trim is where the **content** ends, 900 ms | Ink coverage falls from 17.1% of the frame at 283 ms to 0.07% at 680 ms and peak alpha is 5/255 by 963 ms, so 900 keeps every frame that has anything in it. The frame-vs-ink distinction is the same trap the flechette dart length records. |
| **BLOOD, 2026-08-09** | Drawn **above the lighting**, against this file's own routing rule | Below it, on a dark scene, the mark does not exist (capture 58d). The accepted cost is the vision mask, for under a second. Stated as a departure with a knob rather than folded in silently. |
| **BLOOD, 2026-08-09** | **Once per payload**, and never part of the settle wait | The same rule and the same reason as the burning ground: the fan-out caps at 30 rounds, and the damage window may not be held for scene dressing. |
| **BATON, 2026-08-09** | ⏪⏪ The rubber / stun-dart **darkening is rejected outright**, not re-tuned | "What you did for rubber bullets doesn't look good. Instead of darkening/muting the color, let's look for a better asset to represent rubber bullets." The old treatment was a bolt at brightness **0.60** and a mark at **× 0.60**. Its premise was not wrong about the round — a baton round does carry less energy — it was wrong about the **screen**: a dimmed sprite on a dark scene is not a quieter round, it is a round the eye has to hunt for. Capture 59-control. Both halves are gone, including the shrink: a blunt round makes a *different* mark, not a *smaller* one. |
| **BATON, 2026-08-09** | The load is now said with a **different asset**: the round is a solid travelled slug | `jb2a.throwable.launch.cannon_ball.01.black`, sized 2.4 sq of frame (≈ 0.25–0.55 sq of actual ball, measured) and crossing in **240 ms** — the slowest thing the rail fires. Chosen from a closed enumeration of the tier's ranged family, not by name: `bullet.03.blue` develops a full spiky starburst at 0.30 s (the 2026-08-08 no-starburst ruling is about the shape, not the colour); `snowball_toss` ends in snowflakes; `boulder.toss.02` is legible but its art travels *backward* across its own frame (centroid 0.46 → 0.27 → 0.65) and reads as a thrown stone. Captures 59a / 59b / 59c. |
| **BATON, 2026-08-09** | The round is **travelled**, not painted — and that is a correctness choice, not a style one | A painted tracer's on-screen life is the *asset's* clip, bounded once for the whole rail by `TRACER_CLIP_MS` = 933. This asset's five distance bands are 467 / 767 / 1167 / 2067 / 2433 ms, so painting it would put two of them past that bound and the tail would come back short with no signal — exactly the silent, one-directional failure `presentationTailMs` exists to prevent. A travelled sprite's life is `dashMs + 260` and owes the asset nothing. |
| **BATON, 2026-08-09** | The hit mark becomes a **dust puff** (`jb2a.smoke.puff.ring.01.white`) | Enumerated the same way. Every blue impact on the tier (`001`–`004`, `011`, `012`) is a spike starburst; `impact.water.02.blue` reads liquid; `side_impact.part.smoke.*` is crystalline shards at 3067 ms; `smoke.puff.centered.grey` peaks at luminance 87/255 and is too faint to read as an arrival. The one genuinely *blunt* alternative — `side_impact.part.shockwave.blue`, a concentric ring wave — is rejected on **mechanism**, not looks: its arcs face one baked direction and the impact is drawn with no rotation, so it would point the same way whichever way the shot went. The chosen puff is radial, peaks at 217/255, and takes no `impactClipMs`, so the promotion rule trims it to the ordinary mark's 833 ms unchanged. |
| **BATON, 2026-08-09** | **One matrix** repaints the slug *and* the shell's discharge column | `TRACER_COLOR_BATON` = hue 0, sat −0.85, **brightness 1.30**. The number to read is 1.30 — above 1, where the rejected value was 0.60. It says a different true thing about each element it touches: the slug's art is already greyscale (mean luminance 99/255 measured), so the *brightness* is what lifts it off a black floor; the column is `bullet.02`'s orange bloom, so the *desaturation* is what turns a fire blast into the pale gas flash of a reduced-pressure load. One matrix rather than two is what makes the shell's two elements agree — the standing uniformity ruling. |
| **BATON, 2026-08-09** | The masked-merge rule is widened from **colour** to **asset** | The baton treatment is the first overlay that swaps a *file*, and a bare overwrite would have made `column` a way to hand a pistol a shotgun's discharge blast — one field away from what `columnColor` is already forbidden to do. `AMMO_FX_REPLACE_FIELDS` puts `tracer` and `column` behind the same key-presence mask. No shipped behaviour changes; the guarantee becomes structural instead of conventional. |
| **SPREAD, 2026-08-09** | The shotgun is played **RAW**: buckshot throws the p.108 pattern, and which shot does is read from the **cartridge** at fire time | "Then do it RAW." The Core rules list the shotgun on their own Area Effect table — 1 m / 2 m / 3 m wide by Close / Medium / Long, 4d6 / 3d6 / 2d6, everyone in the path, no evasion. Deriving it from the caliber rather than from the stored `spreadMode` is not a style choice: every shotgun ammo item ever seeded carries `spreadMode: "single"`, so reading the flag would have made the book behaviour reachable only by hand-editing every ammo item in every existing world. Derived, an untouched world's buckshot patterns on its next shot with no migration. |
| **SPREAD, 2026-08-09** | ⛔ **The slug is a LOAD, because the registry has no slug cartridge to be** | The build spec asked for "the slug caliber". There is none: `CALIBERS` models **one** shotgun entry, `"00"`, labelled *"00 Buck / Slug"*, and all six gauge spellings alias onto it — so the cartridge physically cannot say which of the two is chambered. A slug is therefore expressed as a shotgun-family ammo **modifier** (`slug`, `spreadMode: "slug"`), which is also what it is: the same hull, a different projectile. Additive only — one row in a lookup table, one selector option, no schema, no migration, nothing re-seeded. **This is the build lane's call and not a ruling.** |
| **SPREAD, 2026-08-09** | An autoshotgun's N shells are **N rolls on ONE card** | No special autoshotgun rule exists in the recorded read, so RAW is that each shell throws its own pattern — and N patterns aimed identically *are* one pattern resolved N times. The mechanics stay per shell (N banded rolls per token, each through the armour pipeline, which is a different number from N × one roll the moment SP is in the way); only the aiming and the clicking collapse. Card text states the count; one result card lists the rolls. Captures 60b / 60c. |
| **SPREAD, 2026-08-09** | The pattern is **ghost orange**, at 0.10 against core's 0.5, with the hatch off | "Ghost orange … the old opacity was horrible to look at and it blocks things including the shots." Values and the reason core forces this to be done on the drawn object are in §3.2a. The hatch is the half that actually occludes, so alpha alone would not have answered the report. Captures 60a and 60a-control are the same region under both treatments. |
| **SPREAD, 2026-08-09** | The pattern is **GM-only** | It is an aiming aid the GM has not committed to yet. The table should not watch an unconfirmed blast hover over their tokens, and a player who can see it can read the GM's intent before the GM has one. Uses the shim's existing GAMEMASTER default. |
| **SPREAD, 2026-08-09** | **Confirm, then vanish** — and an ignored pattern expires on its own | The defect this replaces was pinned live: every spread shot created a region and *nothing* deleted it — no confirm path, no consumer for the round it recorded — so the count grew one per shot forever. Confirm now deletes on every exit that reached a real pattern, including the one where nobody was inside it. |
| **SPREAD, 2026-08-09** | Expiry is **two clocks**, and which one owns a pattern is decided when it is thrown | A pattern thrown during an encounter belongs to that encounter's rounds; one thrown outside any encounter has no round to wait for and belongs to a 60-second wall clock. Asking later — "is a combat running *now*?" — is wrong in both directions: a pattern thrown out of combat became immortal the moment somebody rolled initiative, and one thrown in combat was swept off the table if its own round ran long. The encounter id is stored, so it also survives that encounter being deleted. A pattern carrying **no** timestamp is litter from the build that had no expiry at all, and is read as expired rather than as immortal — which is what lets an already-littered world tidy itself on load instead of needing a migration. |
| **SPREAD, 2026-08-09** | The pattern reaches the **far edge of the target's own square**, not its centre | Found by the keeper, not by eye: ending the ray exactly at the aimed-at centre put that centre *on* the polygon's end edge, so whether the token the shooter aimed at was inside its own pattern came down to a floating-point comparison. Reproduced on the rig — a three-shell burst resolved against a bystander and missed the target entirely. Half the target's own width is the smallest overshoot that settles it, and it costs no other square. |
| **SPREAD, 2026-08-09** | An **untargeted** shell is thrown along the shooter's facing | The same answer, for the same reason, that the presentation rail already gives an untargeted shot (§6, "An untargeted shot is drawn along the shooter's own facing"). It was due east before. Honest limit, unchanged: it is only as good as a token's rotation, and the band stays Medium because an untargeted shot names no distance. Capture 60e. |
| **BURNING GROUND, 2026-08-09** | ⏪⏪ The **ground-crack asset is rejected outright**, not re-tuned | *"The 'on fire' effect that goes on the ground when incendiary hits is not what we're looking for. First off, it looks like a ground shock effect of some kind, not fire. It darkens and cools, making it not look like an active flame."* Half of "darkens and cools" was ours and half was the asset's, and the fixes differ: decoded off the installed GroundCrackLoop file its own luminance is **flat** — mean 55–57/255 and 46 % of the frame lit at every one of twelve sample points — so the cooling was our own envelope, a 900 ms fade on a 3200 ms life, i.e. 28 % of the element was a dim-down. What no envelope could fix is the picture: it draws glowing **fissures in the floor**, which is cooling magma. The family stays in the file as the armour-piercing load's *impact* mark, which is a different element and was never the thing reported. |
| **BURNING GROUND, 2026-08-09** | The fire is `jb2a.flames.orange.03.1x1` | Chosen from a closed enumeration of the installed tier — 2061 keys, every family whose name carries fire/flame/burn/ember/torch/brazier/lava/scorch/crack, then decoded frame by frame. Two facts decided it. **Top-down:** its own filename says 05x05ft, so it is a square ground plate; the tier's other genuine loops that hold their light are 400×600 (`Flames04`) and 400×1000 (`Campfire03`) portraits — a flame seen from the *side*, which laid on a floor reads as a wall sprite. **No decay:** 5000 ms, and its tail third measures **brighter** than its own middle (ratio 1.19), so it cannot cool inside its loop. Rejected with reasons: `campfire.01` / `bonfire.01` are ringed with **stones**; `braziers.*` has a bowl; `fire_trap.01` is a comet streak, not a fire; `fireball.loop_no_debris` is a whole burning field at 49 % coverage; `impact.fire` (then the incendiary hit mark, since withdrawn — §6) decays to **zero** by 1417 ms of its 2267 and is not a loop at all. |
| **BURNING GROUND, 2026-08-09** | ⏪ **N flames at the landing points**, not one at the target | *"I was picturing something more like little animated flame decals that stayed burning on the ground in the places the shots landed, not just on the target."* Neither branch invents a position: a fanning class already computes real per-pellet endpoints for its tracer, so a subset of those **is** where its shot landed; a single-bolt class puts every round on one aim point, so its rounds are scattered inside a 0.8-square disc — an admission that the exact square is not known, which is the same limit that makes the fan-out assign hits to the leading rounds. |
| **BURNING GROUND, 2026-08-09** | A pattern shot's fires belong to the **path**, and are placed on **confirm** | For buckshot the Core rules put the shot across the whole 1–3 m path and the module already asserts that by damaging everyone in it, so "where the shot landed" is not the target. The geometry is owned by the flow that drew it, and the fires go down when the **GM confirms**: an unconfirmed pattern is a GM-only aiming aid and a fire is not, so lighting the ground mid-decision would leak the aim and leave fires burning for a shot nobody resolved. The rail correspondingly draws none for a pattern payload, gated on the **same call** the two damage gates make (`spreadFlowModeOf`) so the three cannot disagree. |
| **BURNING GROUND, 2026-08-09** | The gate is now **one placement event per payload**, and two bounds replace the old one | The old rule said "one fire" and existed because the fan-out caps at 30 rounds — a per-round lingering element would be thirty fires on one square for one trigger pull. That bound is unchanged: the call still sits outside the round loop, so the loop cannot multiply it, and `maxPerPayload` (4) holds the placement itself down. A **second** bound is new because these live for 45 s rather than 3.2: `maxLive` (24) caps what may burn on a scene at once, enforced by ending the **oldest** — the shot a viewer is watching is the one that must be drawn. |
| **BURNING GROUND, 2026-08-09** | The scatter is **seeded from the payload**, not from `Math.random` | Sequencer broadcasts the resolved sequence rather than the code that built it, so today one client rolls and everyone draws the same fires — but a scatter that is only correct because of *where* it was computed is one refactor from two clients disagreeing about where a fire burns for the next 45 seconds. Seeding makes the agreement a property of the inputs. It is also the only way to pin a scatter in a test without pinning pictures: the keeper recomputes the plan from the seed the fan-out reported and compares by value. |
| **BURNING GROUND, 2026-08-09** ⏪ *the mark half is void — removed 2026-08-10* | Lifetime **45 s**, and the ground mark stays **one** per placement | 45 s is a look call, not a measurement, taken on the precedent the mark already set for a session-bound element with a cap in place of a persistence ruling; the fade is 5.6 % of it, against the 28 % that produced the report. The 45 s stands. The mark deliberately did **not** follow the flame count: it lived for three minutes, so four per burst is exactly the accumulation the payload gate exists to prevent, where four 45-second flames are not. |
| **SEAM, 2026-08-09** | The ammo's **id and its cartridge both ride the payload — beside each other, never one instead of the other** | The spread unit added `caliber` to `AMMO_EFFECT_FIELDS` and took `modifier` out with it, and **nothing failed**: `ammoFxKeyOf` falls back to a fingerprint of the mechanics when there is no id, so every load still resolved and every picture was still drawn. The one pair the fingerprint cannot split is `ap` / `dualPurpose` — byte-identical mechanics — so the entire visible cost was `dualPurpose` silently answering `ap`, which is the exact case the id was added to settle. The two fields answer different questions (which **load** is in the gun; which **cartridge** it is) and both are load-bearing. The real lesson is the keeper's, not the code's: every existing leg handed the resolver a payload it had built itself, so 610 checks could not see a field the seam never sent. The fix is one string; the guard is a leg that reads a **real** fired payload off the hook and asserts, on the same object, that the id answers `dualPurpose` while the id-stripped copy answers `ap`. |
| **SPREAD, 2026-08-09** | ⏪ The pattern's **world switch is part of the flow question**, asked at one shared site | Pre-existing gap, recorded as an open item since the spread unit and closed here. The switch was read only by the pattern hook, so with it **off** a shell was owned by nobody — the single-target gate stood down for the cartridge, the pattern hook stood down for the setting, and the shot did no damage at all. "Off" now means the module does not do patterns, so every shell takes the ordinary single-target route exactly as the slug already does. Put in `spreadFlowModeOf` (lookups.js) rather than at either gate because the guarantee that matters is that all **three** callers — both damage gates and the presentation rail's `patternFlowOwns` — cannot answer differently, and a second reader of the setting is precisely how they disagreed. ⏪ Supersedes the note at `patternFlowOwns` that the setting was deliberately not consulted "because neither damage gate does": neither did, and that was the bug. |
| **FR#25, 2026-08-09** | ⏪ An ammo recolour now reaches the **pellet fan**; the base fan stays untinted | "For incendiary on autoshotgun the little dorito shaped pellets themselves didn't get the same red treatment as the spiky cone and starburst. Make sure when you update the animation for one shotgun ammo type, it's updated for all." Expressed as `tracerColor: null` on the class row — declared repaintable, painted with nothing — so the base look is byte-identical and every recolouring overlay (`api`, `ap`, `dualPurpose`, `rubber`, `stundart`) lands on column and fan alike. ⏪ Supersedes FR#24's "shell pellets are never tinted" for overlays only. |
| **GROUND MARK, 2026-08-10** | ⏪⏪ The incendiary **ground mark is removed entirely**; the flames are unchanged | *"kill it."* The dark decal the burning ground used to leave under itself is withdrawn — the constant, the draw site and the two fields it reported on `fxGroundFire`'s return shape are all deleted rather than switched off, because a field that is always false is a mechanism a later reader has to disprove. **Revert values, so a restore is a transcription and not a rebuild:** key `jb2a.scorched_earth.black`, **1.5 squares**, opacity **0.7**, lifetime **180000 ms**, fadeIn **600**, fadeOut **3000**, `loopOptions({ loops: 1 })` (load-bearing — the asset is 6250 ms and an effect outliving its clip re-blooms by default), **below** the lighting, **one per payload** at the flames' **centroid**, delayed by the same arrival time the flames take. Two things outlive it: the fire's own 45 s lifetime, which was set on the precedent this element established and is still a cap; and the open decal-persistence question, now carried by the blood splash alone. |

---

## 7. Testing story

**The keeper.** `tests/cp2020-augmented-fx-rail.mjs` in the fork repo, run against a rig carrying
Foundry + this module + Sequencer + the free JB2A tier:

```
FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=<pw> node cp2020-augmented-fx-rail.mjs
```

What it pins, in outline: capability detection against the *installed* engine and tier · class
resolution from item type data, including the attack-type discriminator that runs ahead of the type
map · **every mapped database key resolving on the free tier** (so a paid-tier-only key is caught here
rather than by showing nothing) · the flash envelope by value, the applied write sequence, and that
**no document write reaches the shooter token** other than the face-target rotation · the fan-out's
counts and cadence · the ammo overlay resolution, every treatment's values, the tail threading, the
burning ground's placement gate, its planners and its scene cap, and the flash tint through the
darkness gate · **the pacing contract** — the anchored slot ladder and the drop decision as pure values
(including the separation guarantee at every shipped cadence and the last-round exemption), then live
both ways: the threshold held out of reach to prove a healthy client drops **nothing**, and the
threshold at the floor with a 30-round dart-load **shell** fan-out (a class whose own row draws a group,
so the load is one this host genuinely cannot keep up with and the refusals are real) to prove late rounds are dropped, the burst still ends on its own
schedule, the last round still carries the settle name, and the window still closes on the engine's
signal · **the api overlay after the report** — no promoted mark on any class, the eased hue with its
revert value, and the other promotions untouched · two real sessions, to
prove the socket relay draws a flash on a client the fire never ran on · a non-GM session driving a
write, because a rule that reads right and a write the server refuses look identical from the GM's
side · 0 console errors.

⭐ **§19, the review-fix section (2026-08-10)** — three legs' worth of blind spot the review found in
*this spec* rather than in the product, each written so that reverting its fix fails it. The chaos had
been varied across round **indexes** and never across two separate **trigger pulls**, which is exactly
the case the identity-only seed got wrong: §19 drives six pulls that differ only in their rolled damage
and requires six distinct pictures (the reverted seed gives one). The volley had been pinned as *which
loads own it* and never as *what a tinted or a dart load looks like once it owns it*: §19 reads the
matrix off the queued volley per load, and reads the dart fan on the loads that now escape it. And the
presentation canary shipped with **no leg at all**: §19b stands the asset modules down on the client and
provokes a whole discharge with every database key answering "missing", which must stay quiet — then
§19c puts the assets back and provokes the identical shot, which must speak, so the quiet half is not a
tautology. The pattern flow's half of the same review (the load's per-hit riders) is
`tests/cp2020-augmented-spread-zone.mjs` §9, which reads the state the two rider calls write — the shock
count and modifier, the threshold that modifier lowers with the rider removed as its own negative, and
the armed over-time turns — plus a plain load that arms neither and a pre-change pattern that still
resolves.

⭐ **§21, the single-file section (2026-08-10, extended to `stundart` 2026-08-11)** — the dart loads'
count, in three kinds of leg, and the third is the one that matters. **By value:** neither row names a
count or a cone; every single-round class resolves to no count for either load, and the *fan planner* is
asked with each entry and returns nothing, so the absence is asserted where it is consumed and not only
where it is declared; each load's own length, crossing, mark and colour are unchanged, and the two rows
are asserted **equal** on all five classes so a future divergence is visible rather than silent.
**Negatives:** a class whose own row draws a group keeps drawing it — the shell's 6 at 0.07 rad come
through the merge for *both* loads, which is the "if it's fired from a shotgun, no" half of the 2026-08-11
ruling read off the resolved entry and off the queue; the shell class row is unmoved; and — the leg that
guards the edit that could have gone wrong silently — `ammoRedefinesProjectile` still answers **true** for
each, off `dashSquares,dashMs` rather than off the count it used to answer off, so the escape from the
round-replacing branch holds (re-read on the stun-dart 00 shell specifically, the load that escape was
written for) and the tail arithmetic is untouched at 1003 ms. **Driven:** a recording surface counts what
is *handed over* — one mark per round drawn, exactly, for a single round and for a 20-round burst of each
load; the group form would hand over eight times that; and one shell round of the stun dart still hands
over six. **Measured:** the same 20-round payload is run twice on the real engine — once with no
overlay as a **control**, once with the dart load — with the audio stubbed to stamp the clock and the
engine's own end-of-element hook stamping it too, and the claim is the ruling itself: the dart load's
last mark leaves the screen when the ordinary stream's does. The control is what makes that honest, since
a headless rig adds seconds of its own drawing delay to *any* load; a fixed millisecond allowance would
have been pinning the host. Allowance = control + the two loads' tail difference (70 ms) + a stated
400 ms of run-to-run jitter.

⭐ **§20, two figures of one actor (2026-08-10)** — the multiplicity the spec had never varied. Every
other leg places exactly ONE figure per actor, so an origin lookup that answers "the first one placed"
could not be caught by any of them. §20 places two figures of one actor far apart, fires a payload that
NAMES the second, and asserts the rounds are hung on that figure, the muzzle work is placed at its
coordinates and nothing at the other's, the muzzle light is raised on its own key, and the resolver
answers it by value. The two fallbacks are legs of their own — a payload naming no figure, and one
naming a figure this client is not drawing, both of which must resolve exactly as before — and the last
leg puts the tail arithmetic on the same footing: the two figures stand at different distances from one
mark, so a shell's banded window reads **1200 ms** from the named figure against **1600 ms** from the
first, which is the same defect one layer along. The seam's half of the same question is
`tests/cp2020-augmented-b1-seam-payload.mjs`: it reads `attackerTokenId` **off the payload a real fired
shot carried**, once with the figure selected on the canvas and once with nothing selected, so both of
the ordinary capture paths are on the record.

**Assertion style.** Every pure helper on the rail (`muzzleSourceSpecs`, `pelletEndpoints`,
`moteEndpoints`, `smokePuffPlan`, `presentationTailMs`, `flashColorFor`, `ammoFxEntry`, …) takes an
injectable `rng` or plain arguments precisely so its output is asserted **by value**, with no canvas,
no engine and no shot. Anything that cannot be — which asset was queued, how many were emitted, what
colour a source was built with — is driven live and read back off the engine.

⚠ **And the limit of that style, which this unit exists to fix.** A leg that hands a pure helper a payload it built
itself proves the helper, and says **nothing** about whether the seam sends that field. `payload.modifier`
went missing from `AMMO_EFFECT_FIELDS` for a whole build while 610 checks stayed green, because every
one of them supplied the id in the fixture. `tests/cp2020-augmented-b1-seam-payload.mjs` is the answer
and is now the seam's own keeper: it fires bench guns **07** and **16** through the real UI path and
asserts `modifier`, `caliber` and the resolved overlay key **off the payload the hook actually carried**,
with gun 16 chosen because it is the one load a fingerprint physically cannot identify. Its sharpest leg
asks the resolver twice about the same real payload — once as fired, once with the id deleted — so the
record contains the fallback answering `ap`, which is what makes the id's presence a claim and not a
formality. The fx-rail spec carries the same question in miniature against the real bench items rather
than a fixture. **Any field the seam forwards wants one leg of this shape**; a fixture cannot fail for
the absence of something it supplies.

**Three sections are written as the inverse of the ones they replace, and one is written as an absence.**
The deletion sections are the newer shape and the more important one: when a mechanism is *deleted*
rather than retuned, the failure mode is a half-deletion — a dead constant, a mask entry, a row field an
overlay can still reach — and each of those is one line from becoming live again by accident. So the
column's nineteen legs became six that assert **nothing of it survives**: every constant and the helper
are `undefined`; no class row and no overlay carries either field; neither merge mask still names it; the
draw verb's own report has no `column`; and — driven — a live shell discharge puts exactly **one** bullet
family on the canvas, decided by file rather than by size, which is the assertion the old legs could not
make because both families were present. A seventh asserts the one thing that *did* survive: the shell's
fan is still declared repaintable-but-unpainted, because that ruling was about the mask and not about
the column. The `hollowPoint`/`safety` legs took the same shape — the rows are gone, both loads resolve
to the class row **by identity** (`===`, not a field comparison), their tails equal `standard`'s on all
five classes, the *fingerprint* still names them so the mechanics are visibly untouched, and
`impactScale` is still live on `flechette` so the deletion is two rows and not the field.

**The volley's legs pin a trial, which is a different job.** They exist so the user's ruling lands on a
known object and so the revert is provably one constant. The sharpest is the **band mirror**: our picker
is asserted against the *engine's own* `getFileForDistance` at every boundary (2, 4.9, 5, 6, 8.9, 9, 12,
14.9, 15, 20 squares), because the whole tail arithmetic is derived from which file the engine will serve
and a mirror that drifts is silent. Around it: the four band tails by value; that the 90 ft tail beats
the shell's own (so a fixed guess would open the window early); the chaos computed **twice** from one
seed and compared, with a 40-seed spread proving both knobs really move and stay inside ±5°; that
consecutive rounds of one burst differ; that the jitter rotation preserves the distance to 1e-6, which is
what keeps the band out of its reach; that buckshot claims the branch while slug and flechette do not;
that the pattern's **world switch** does not repaint the gun, driven with the setting really off and
restored in a `finally`; and then driven — the volley replaces the fan (`pellets === 0`), suppresses the
hit mark (`impact === false`), carries the settle name on itself, and the same shot without it draws six
dashes and a mark, which is the revert shape asserted rather than assumed.

**The baton pair's legs are written as the inverse of the ones they replace.** Two legs used to assert
that this pair's matrix was the only one that *darkened* and that it drew a *dull bolt and a small mark*.
Both facts are now false by design, so the replacements assert the opposite on purpose: that **no** live
matrix darkens and that the retired one appears on **no** shipped row; that the load is said with a
different asset on every class; that a class which painted its round now travels it; that the shell's
shot **count** and spread are untouched while its size and speed are replaced; that the mark is the dust
key at the class's own width with no `impactScale` anywhere; and that the tail is `240 + 833` on all five
classes. Two legs drive it live and read the file the *engine* was handed rather than the merge — an asset
swap is exactly the change a value-only assertion cannot see.

**The burning-ground section is written as the inverse of the one it replaces**, in the same way the
baton pair's was, because the rebuild made three of its facts false on purpose. Where the old legs said
the lifetime was *a few seconds*, that ONE fire was set, and that the fire was the crack family, the
replacements say the lifetime is **tens of** seconds, that a ten-round burst sets **four** fires and
(⏪ since 2026-08-10) **no** ground mark under them, and that the crack survives only as the
armour-piercing *impact* — a different element that was
never the thing reported. Around those sit the legs the redesign needs: both planners asserted **by
value** (a fanned class's fires must each be a member of the very pellet fan the tracer draws, and must
span it rather than cluster; a single-bolt class's must be N distinct points inside the scatter disc);
determinism computed **twice** and compared, with a second seed proving the seed is really the source;
the pattern's scatter checked against the **real polygon** with the module's own `pointInPolygon`, which
is deliberately a different piece of arithmetic from the ray-local construction that produced it; the
either/or by value on both sides; the scene cap **driven** — enough bursts to exceed it must leave the
cap's worth burning and not the sum — and the canvas clear leaving none; and the settle exclusion pinned
as an identity, that an incendiary payload's apply window is byte-for-byte the ordinary one on all five
classes. One leg decodes the shipped clip off the **installed file** and asserts its tail is no dimmer
than its middle, because "it darkens and cools" is a claim about frames and is answered with frames.

The gore unit added a section of its own, and it is almost entirely negatives, because four
independent gates each mean "this must NOT be drawn": the switch registered world-scoped and shipping
OFF · the reader following it both ways · the target-type answer by value for flesh, npc, vehicle,
powered armour, full conversion and the ruled cyberlimb case (which also asserts that the *zone*
routes to structure while the *actor* does not) · the asset key resolving on the free tier and the
installed file measuring the length the trim was chosen against · then live: nothing with the switch
off, exactly ONE splash from a ten-round burst, nothing on a vehicle, nothing on a full conversion,
nothing on a ruled fumble, nothing on a burst that misses, nothing when no token was aimed at, and the
scheduled tail identical with the switch on and off.

**The shot pattern has its own spec**, `tests/cp2020-augmented-spread-zone.mjs` (81 checks), because
what it tests is the damage rail and a canvas document's lifetime rather than anything the effect
engine draws. Eight sections: the derivation asserted by value across the whole caliber × load matrix
(including every gauge alias and both blanks) · the seam carrying the cartridge, checked against the
**shipped shell compendium** rather than a fixture, so a catalogue that stopped recording gauges would
fail here · the either/or, driven by raising the real hook and asking whether the single-target flow
**claimed** the payload — which answers "was a dialog opened?" without opening one · placement, with
core's own 0.5-and-hatched values asserted on an untouched region before ours are asserted on
ours · per-shell resolution against a **fixtured** band formula, so three shells must read `5, 5, 5`
and can never be one roll counted three times, driven by a real DOM click on the posted card's
button · both expiry rules as pure predicates by value, then driven live · cover occlusion · and a
source scan for the two ways this could silently rot (the stored flag being read again, and
`region.behaviors.length`).

⛔ **The spec must not disturb the review rig**, and two of its legs exist only because of that. The
showcase encounter on :30004 is the user's, so the round rule is driven by raising `updateCombat` with
that encounter's **own unchanged round** and a backdated pattern — nothing about the combat is
written, and a leg asserts afterwards that it still stands where it did. The clock rule is reached by
clearing the pattern's recorded encounter, which is exactly the document state an out-of-combat throw
produces. Fixtures live in an empty lane far from the review targets: the first run of this spec put
its pattern across **Review · Shooter** and damaged it, which is also how the ray-overshoot defect
above was found.

**Traps a new leg will hit.** A `timeRange` end is a **budget, not a guarantee** — the media element
starts after the effect does and can run past the range end, so anything asserting "content X is never
drawn" must be measured against the video's own `currentTime`, not inferred from the constant · the
host refuses a media `playbackRate` below **0.0625** (it throws `NotSupportedError` and the clip then
plays at 1, which silently invalidates every held capture taken through it) · this rig renders at about
**12 fps**, so a `requestAnimationFrame` sampler sees a 200 ms effect three times and every duration
inferred from it is noise — sample on an interval and read the media clock ·
Sequencer randomisers roll once per section · `endTimePerc` is a no-op on
this build (use `timeRange`) · `rotateTowards` sets the movement destination · core packs colours to
**numbers** on source data, so compare in core's units · the capture seam must be applied *first* in a
chain (the engine reads the playback rate when it works out a trim point) · `endAllEffects()` between
sections can make the engine lose a race with itself, which is why the harness absorbs exactly that one
third-party signature and nothing else · **a multi-document create does not guarantee the order of what
it hands back** — this rig returned four tokens in database order, so a leg that destructured them by
position read the wrong target's result and two gates looked broken that were not. Create one at a
time, and assert the handle carries the actor its leg names.

**Capture seams.** Screenshots on a software rasteriser cannot catch a 110 ms sprite or a pellet that
crosses in under a frame. `_setSpriteRate`, `_setDashMs` and `_setFlashLevels` stretch the *clock*
without changing a single shipped value — sizes, trims, geometry and colour are untouched. Every image
taken through one says **HELD** in its filename.

**Provisioning — the review bench.** `tests/cp2020-augmented-provision-review-bench.mjs` builds the
whole review loadout: **one weapon per (class × distinct-visual load), each already loaded**, named with
a numbered prefix so the shooter's Combat tab reads as an ordered walk-down list. It is idempotent by
**rebuild** — every run deletes what it owns and recreates the same rows, one at a time, because the
Combat tab lists `actor.itemTypes.weapon` in collection order and not by name, so creation order *is*
the reading order. Re-running is therefore also the reset (magazines full, loads re-linked, damage
zeroed, targets back in position).

⚠ **"Loaded" on the ship target means `system.ammoItemId`, and only that.** That is the field the seam
reads (`ammoEffectFields`), so it is what puts a load's mechanics and its cartridge on the payload. The
`loadedAmmoId` / `loadedAmmo` snapshot pair exists on the **fork's** weapon schema and not on the
shipped system's; the provisioner writes the pair when the running schema carries it and reports when it
does not, rather than writing keys the DataModel drops.

⏪ It **supersedes** `tests/cp2020-augmented-provision-fx-ammo.mjs`, which stocked loose ammo boxes on a
shooter carrying unloaded guns and left the reviewer to load each one from the sheet. That design was
retired by the user on 2026-08-09: *"preload my guns with the right ammo and give me multiple guns of the
same type with different ammo so I can just go down the list and shoot each of them."*

The bench, as it ships (walk-down order, pistol → smg → rifle → shell → heavy):

| # | Weapon | Caliber | Load | Class | What that row exists to show |
|---|---|---|---|---|---|
| 01 | Stolbovoy St-2 Pistol | 10mm | `standard` | pistol | the class baseline — 0.70 sq mark; the control for 02/03 |
| 02 | Stolbovoy St-2 Pistol | 10mm | `hollowPoint` | pistol | ⏪ **nothing — the row was deleted.** It must draw exactly what 01 draws |
| 03 | Stolbovoy St-2 Pistol | 10mm | `safety` | pistol | ⏪ **nothing — same deletion.** Sameness across 01/02/03 is the pass condition |
| 04 | H&K MPK-9 | 9mm | `standard` | smg | the burst cadence (80 ms), mote spray, smokeless auto |
| 05 | H&K MPK-9 | 9mm | `rubber` | smg | **the baton treatment, now the only load wearing it** — `cannon_ball` slug + dust puff |
| 06 | Militech Ronin Light Assault | 5.56 | `standard` | rifle | the class baseline — 0.95 sq mark |
| 07 | Militech Ronin Light Assault | 5.56 | `api` | rifle | **burning ground on the single-target flow** — ≤ 4 flames in the scatter disc, and (⏪ 2026-08-10) no mark under them |
| 08 | Militech Ronin Light Assault | 5.56 | `ap` | rifle | near-white bolt + ground-crack impact; the control for 16 |
| 09 | Militech Ronin Light Assault | 5.56 | `flechette` | rifle | ⏪ **ONE grey dart per round, in the same stream the standard rounds come out in** (2026-08-10 ruling — was 8 darts a round from a class that draws one bolt). 1.1 sq at 170 ms with a × 0.70 mark: the dart language carried by colour, length and mark rather than by a count |
| 10 | Arasaka Rapid Assault Shot 12 | 00 | `standard` | shotgun | ⚠ **the VOLLEYBUL TRIAL — the adopt/veto ruling this bench exists for**; plus the RAW buck pattern + confirm + delete, and the shell's restored 1.9 sq lance |
| 11 | Arasaka Rapid Assault Shot 12 | 00 | `slug` | shotgun | **one heavy painted bolt** (new), and the single-target contrast — the one shell load that throws no pattern |
| 12 | Arasaka Rapid Assault Shot 12 | 00 | `api` | shotgun | **burning ground on the pattern flow** — ≤ 5 flames placed on *confirm*; the pellet fan red |
| 13 | Arasaka Rapid Assault Shot 12 | 00 | `stundart` | shotgun | ⏪ **a grey needle-dart fan** — no longer the baton's twin; ⏪ and since 2026-08-11 the fan is the SHELL's own six at its own 0.07 rad rather than the row's eight, which is the "if it's fired from a shotgun, no" half of that ruling standing up on the bench |
| 14 | Arasaka Rapid Assault Shot 12 | 00 | `flechette` | shotgun | a **grey** dart swarm — ⏪ now the SHELL's own six at its own 0.07 rad rather than the row's eight (2026-08-10), and a flechette pattern rather than a buck one |
| 15 | Barrett-Arasaka Light 20mm | 20/9mm | `standard` | heavy | the top of the impact ladder — 1.30 sq |
| 16 | Barrett-Arasaka Light 20mm | 20/9mm | `dualPurpose` | heavy | identical to `ap` by ruling — the pair the payload's ammo **id** exists for |

Every pairing is checked against `modifiersForCaliber` before the row is built, and every magazine's
caliber IS its gun's own `ammoType` string — so a load can never land in a barrel that does not take it,
and the check is the registry's answer rather than the script's. Sixteen rows, five classes, ten distinct
loads. ⏪ Since 2026-08-09 **three** of those loads deliberately draw nothing of their own —
`brassCased`, `hollowPoint` and `safety` all resolve to the class row itself — so rows 02 and 03 exist
to prove a *sameness* rather than a difference. The range is set up with it: three labelled targets (flesh · cyberlimb · vehicle) at 10–11 m,
inside every bench gun's Close band and in the pattern's Medium band, at zero damage, gore ON.

**The bench's own smoke test.** `tests/cp2020-augmented-review-bench-smoke.mjs` (36 checks) is not a
keeper — it pins no values. It answers one question: can each gun be picked up and fired with zero
loading steps, and does the thing that row exists to show actually reach the canvas? Every shot goes
through the **real UI path** (the sheet's fire button → the modifiers dialog → its submit) and every
claim is read off the **engine**: the payload the seam raised, the database keys Sequencer was handed
(`createSequencerEffect`), the region documents the pattern flow wrote. It drives blood on flesh and its
absence on the vehicle, the baton asset and its dust mark, the burning ground and (⏪ since 2026-08-10)
the absence of any mark under it, the buck
pattern's placement / confirm / deletion, the incendiary shell's fires arriving only **on confirm**, and
the either/or by value on both sides — `payload.handled` unset for buckshot and `"cp2020-augmented"` for
the slug. It restores everything it disturbs.

⚠ **Two traps it hit, recorded because the next leg will hit them too.** `createSequencerEffect` reports
the **database key** a section was handed (sometimes with a variant suffix, `…yellow.1`), *not* a resolved
file path — a leg matching on `Sequencer.Database` filenames matches nothing. And the apply window is
**deferred until the presentation settles**, up to `PRESENTATION_CAP_MS` (8 s), so a window opened by the
*previous* shot arrives long after that shot's own read: a leg that counts windows must drain past the cap
before it fires, or it attributes one shot's dialog to the next one's payload.

### 7.4 Client-side failure shapes — what a dead-looking rail actually means

Three distinct things make the rail *look* broken, and they are told apart by where the evidence is.
Recorded 2026-08-10 after an evening spent chasing the wrong one twice.

| What the table sees | Where the evidence is | What it is | Cure |
|---|---|---|---|
| A client's OWN shots draw nothing; other clients' shots draw on it normally; rolls, magazine and damage all work | its console: many `canvas-effect.js` `Cannot set properties of null (setting 'volume')` from Sequencer's `_createSprite` | **The tab has run out of media players.** A browser caps how many media elements one document may hold, and a tab open for hours across hundreds of effects reaches it. From then on every video texture comes back null and the engine throws before anything is drawn. Nothing in the rail can see this — it queues its work and the work quietly dies downstream. | **Reload the tab.** The pool resets. Nothing to fix in the module; the canary below is what makes it self-reporting. |
| A client loading *while* effects are broadcasting logs ~6× `Cannot read properties of null (reading 'viewedScene')` at Sequencer's `shouldPlay` ← `sockets.js playEffect` | its console, during load only | **Relayed effect packets arriving before that client's canvas is ready.** Those effects skip. Cosmetic, self-limiting, not ours. | None needed. |
| Every client is fine but the module's whole combat layer is absent on ONE — attack rolls and magazine work, no damage window, no presentation | that client's console, near load: a `cp2020-augmented \| ready wiring` line | **A ready-time wiring step threw.** See §7.5. | Reload; the named step tells you what actually broke. |

⚠ **`document.querySelectorAll("video")` cannot measure the first row.** Sequencer 4.2.3 decodes into PIXI
textures from media elements that are never attached to the document, so the count reads 0 no matter how
many are live — measured on the rig across 150 effects in six batches (0 video nodes at every mark, 0
errors, `EffectManager.effects` back to 0 after each batch, so *ending* an effect does release it). The
ceiling is real but is not observable from page JS; it is reached by tab AGE and cumulative effect count,
not by concurrency, and a fresh session does not approach it.

### 7.5 The two canaries — the rail now reports its own silence

Both were built 2026-08-10 for the failure above, because every check that existed said the shot had been
presented while the screen stayed empty.

- **The presentation canary** (`_reportSilentPresentation` / `_confirmSilentPresentation`, effects.js).
  Counts what the ENGINE reports creating (`createSequencerEffect` → `_drawsSeen`) across one fan-out and
  compares it to the count taken before. It splits its message by `result.flashes`: non-zero means the rail
  reached its build sites and the engine made nothing → **this client cannot draw, reload it**; zero means
  the rail never asked → **a module fault, reloading will not help**. Silent when no Sequencer is installed
  (the light and the report are the whole presentation there, by design), **when no asset module is
  installed beside it**, when the rail deliberately bailed (`skipped`: disabled / unrecognised class /
  ruled fumble / **no shooter**), and when the count moved. Once per session.
  ⭐ **Two exception classes were added 2026-08-10** (review finding F1), because a healthy client tripped
  it in two ordinary situations.
  **(a) A sheet-fire by an actor with no token placed anywhere.** Every draw verb is shooter-gated, so the
  fan-out ran to draw nothing, reported nothing in `skipped`, and four seconds later told the table their
  module was faulty. The rail now bails with `skipped: "shooter"` — *after* the load and the counts are
  resolved, so the report still says what was fired, and *before* `_armSettlement`, so nothing is left
  waiting on a promise nobody resolves. It also silences the report from nowhere, since the shot's audio
  is played from inside the loop the bail skips.
  **(b) Sequencer installed, no JB2A.** Every key then misses and every sprite is skipped *by the
  silent-degrade rule*, so the creation count cannot move — while `flashes` is non-zero, which earns the
  "reload this tab" message for a client whose only problem is that it has no asset library, and which a
  reload will not install. Gated on `jb2aActive()`, which stays informational everywhere else
  (`fxDbEntryExists` is the real per-key gate) and is exactly the right question here, where the subject
  is not one key but whether there was ever anything to draw at all. The fx-rail keeper drives both halves
  and then **provokes the canary for real** with the assets back, so the quiet half is not a tautology.
  ⚠ **It must not read at the moment the fan-out resolves.** The creation hook for the last queued round
  routinely lands after that promise settles, and on a one-round shot it almost always does — the first
  version did read there, called a healthy client dead, and was caught by the fx-rail keeper's
  `0 console errors` leg on the same run it was written. The reading is now taken after
  `SILENT_CHECK_GRACE_MS` (4000) plus the shot's own `settleTailMs`.
- **The seam canary** (`renderEmitLive` / `assertRenderEmit`, seam-shim.js). The payload that starts all of
  this is raised from a wrap on the *global* `renderTemplate` — one shared binding, the only part of the
  shim another actor can replace, and it leaves no trace when it goes. The wrapper is now kept by identity,
  checked on every shot, re-asserted if it is not ours, and reported once. Emissions are deduplicated per
  card (`_emittedFor`) so re-asserting can never double-emit even if something wrapped ours.

---

## 8. Open items

| Item | State |
|---|---|
| ~~The ammo's `modifier` id is ruled onto the payload but is not on it~~ | ✅ **CLOSED 2026-08-09.** `AMMO_EFFECT_FIELDS` had had `modifier` **replaced** by `caliber` rather than joined by it, so `payload.modifier` was `undefined` on every real shot and every load resolved through `ammoFxKeyOf`'s fingerprint branch — collapsing `dualPurpose` onto `ap`, the one case the id exists to settle. Both fields now sit in the list, with the comment block saying why one may never displace the other. The guard is the point: `tests/cp2020-augmented-b1-seam-payload.mjs` now fires bench guns **07** (`api`, 5.56) and **16** (`dualPurpose`, 20/9mm) through the real UI path and asserts `payload.modifier`, `payload.caliber` and the resolved key off the payload the hook actually carried — plus, on that same object, that stripping the id makes it answer `ap`. Reverting the one string turns four of its legs red. See §6. |
| **The burning ground's size, density and lifetime are not signed off** | ⚠ **The open item of this unit.** The asset was chosen by measurement and the placement was ruled, but three numbers are look calls the build lane made while the user was away: one flame is **0.9 squares** (picked off a 0.5 / 0.7 / 1.0 / 1.6 comparison on the dark range), a payload places **up to 4** and a pattern **5**, and a flame burns **45 s**. Each is one constant, and a veto costs nothing: `GROUND_FIRE.squares`, `.maxPerPayload` / `.maxPerPattern`, `.lifetimeMs`. Captures 61a–61d. |
| ~~A shell fired with the shot pattern **switched off** is claimed by neither flow~~ | ✅ **CLOSED 2026-08-09.** The world switch is now part of the flow question itself, asked at one shared site (`spreadFlowModeOf`, lookups.js) by both damage gates and by `patternFlowOwns`. With the pattern off a shell resolves to `single`, so the ordinary apply flow claims it exactly as it claims a slug, and the fan-out draws an incendiary shell's burning ground itself because no confirm will. Pinned three ways: the spread-zone spec drives a shell with the setting off and asserts the single-target flow **claimed** it (and that no pattern was placed), the fx-rail spec drives the same payload's fires on the rail, and a source leg asserts the damage rail reads the setting **nowhere** of its own. Both specs restore the setting in a `finally`. See §1.1a and §6. |
| **The baton round's final look is not signed off** | ⚠ **The open item of this unit.** The darkening was rejected and the replacement was chosen, built and shipped while the user was away, so what is in the file is the build lane's best call and not a ruling. Three candidates were composed on the rig and photographed on **both** classes the uniformity rule covers — the SMG (rubber 9mm) and the shell (stun-dart 00) — against the rejected look as a control: **59-AB-smg-all-candidates-HELD.png** and **59-AB-shell-all-candidates-HELD.png** are the two grids to open, with per-candidate files 59-control / 59a (slug) / 59b (slug + dust, **shipped**) / 59c (stone) beside them. Every frame is HELD: the crossing time is stretched to 1200 ms for the camera, which is the only value the captures do not show at its shipped setting. A veto is cheap by construction — the whole treatment is `BATON_ROUND` plus one matrix plus one impact key, and the retired matrix is still declared one row field away. |
| ~~The discharge column's on-screen presence at the new trim~~ | ⏪ **RETIRED 2026-08-09 BY DELETION.** The user replaced the element rather than ruling on it: the column is gone and the shell draws the ordinary muzzle lance at 1.9 squares with the 220 ms dwell that was always ruled for it. There is no longer an on-screen presence to call. §6. |
| ~~⚠⚠ **THE VOLLEYBUL IS NOT ADOPTED**~~ | ✅ **CLOSED 2026-08-11 — VETOED at the bench.** §6 and §3.2b carry the verdict and what replaced it. The trial's own record follows, struck through: ⏪ Buckshot draws the volley clip on trial, at the user's own instruction to try it live at full range. Three things need eyes in motion and none of them can be measured: **(a) adopt or veto** the whole-clip look with its baked arrival fireballs; **(b) the chaos** — is a random mirror plus ±5° of aim jitter enough, too much, or the wrong kind of variation (`VOLLEY.jitterDeg`, `VOLLEY.mirrorFlip`); **(c) the miss** — a missed volley still lights fireballs in the dirt, because the arrival is baked into the asset and cannot be separated from the crossing. Accepted for the trial; capture **67c** is the frame to look at. Revert is `VOLLEY.enabled = false` and nothing else. Captures 67a / 67b / 67c / 67h. |
| ~~The volley draws **five** rounds where our fan draws six~~ | ⏪ Moot with the veto — the shell row's `pellets: 6` is what draws. Recorded so it is a decision rather than a gap. The asset's round count is baked in and is not a knob; the shell row's `pellets: 6` is untouched and returns the moment the trial is switched off. Nothing in the rules ties the drawn count to the damage, which is resolved by the p.108 pattern and not by sprites. |
| ~~The volley's arrival bloom reaches ~0.7 of a square past the aim point~~ | ⏪ Moot with the veto. Measured off the installed clips (the front edge holds at 0.94–0.99 of frame after arrival). It is the asset's own composition, not a placement error, and it is why the hit mark is suppressed rather than merely moved. |
| **The dart grey is a build-lane pick** | ⚠ The *rule* is the user's (grey = darts, orange = balls and bullets, under the realism razor). The *numbers* are mine: hue 0, saturate −0.90, brightness 1.15. A veto is one constant (`TRACER_COLOR_DART`) and it reaches both dart loads at once, which is the point of it being one constant. Captures 67f / 67g / 67x and the 67fgh triptych. |
| ~~Whether the stun-dart load should be allowed on ordinary cartridges~~ | ✅ **CLOSED 2026-08-11 — leave it as it is.** Asked whether to widen `AMMO_MODIFIERS.stundart.families` past the shotgun family so the load could reach a stream-firing weapon, the user ruled the question shut along with the bench row that raised it: the bench is for the loads the product ships, not for arranging a state it cannot otherwise reach. The family lock stands, the registry gate and the ammo sheet keep refusing the pairing, and no data was changed. The revival path, if it is ever wanted, is in §6 under the same date. |
| **The shell lance at 1.9 squares is a build-lane pick** | ⚠ The *restoration* is the user's ruling; the *width* is mine, chosen against the ladder (rifle 1.6, heavy 2.1) and verified as a drawn 190 px on a 100 px grid. One constant, `FX_CLASSES.shotgun.muzzleSquares`. Capture 67d has the two shells and the rifle in one frame. |
| ⭐ **A second volley variant exists and has never been drawn** | ⚠ **Found during the 2026-08-11 veto, needs eyes before anything changes.** `jb2a.volley_of_projectiles_Line.bullet.001.002.orangeyellow` decodes as 32 small blobs at mixed depths where the vetoed variant decodes as 7 in two aligned ranks — i.e. it may be the "small balls, irregular grouped spread" the ruling asked for, in one asset. Not adopted: the ruling requires captures first, and at 4867 ms it would need a trim and an engine-wait cap before it could carry a settle tag. §3.2b has the decode. |
| **The pattern now resolves itself, with nobody left to press anything** | ⚠ **Stated so it is a decision, not a surprise.** The ruling says the damage resolution *opens* at the animation's content end, and for the pattern flow there is no window to open — the resolution IS the application plus its result card. So a declared corridor applies its damage automatically when the rail settles, and the only thing a reader can still stop is a shell nobody aimed (which keeps its card). If what was wanted was a card that appears at the content end and still waits for a click, that is one branch: post the confirm card instead of calling `_confirmSpreadZone` in `_placeSpreadZone`, after the same `presentationSettled` await. |
| **The aim ghost's alpha and the readout's wording are build-lane calls** | ⚠ The gesture and its order are the user's; the ghost is drawn at **0.18** where the planted pattern sits at 0.10 (it is being dragged, against a dark map, by the person who owns it), and the readout reads `"{band} band — {width}m wide, {dmg}"`. One constant (`SPREAD_PREVIEW_FILL_ALPHA`) and one i18n key (`SpreadPreviewReadout`). |
| **The buckshot fan's new look is not signed off** | ⚠ **The open item of this unit.** The *veto* and the *direction* are the user's; the numbers are the build lane's, made from the bench report rather than in front of the user. Four constants and a fifth: `PELLET_CHAOS.slotFraction` **0.9** · `.reachFraction` **0.35** · `.sizeFraction` **0.25** · `.staggerMs` **45**, plus `FX_CLASSES.shotgun.dashSquares` **0.7** (revert **1**; not taken to **0.5**, the value already rejected by eye on this row). A veto on any one is a one-number edit. §3.2b. |
| **The pellet arrival marks are a build-lane call, and so is the razor split** | ⚠ **The open item of this unit.** The ruling says "small arrival marks at pellet endpoints, ≤ 50 % of the volley's fireballs" and "fire arrivals reserved for the incendiary shell". The size (**0.45 sq**, under 40 % of the class's own aim mark) and the trim (**500 ms**) are mine; the *split* is implemented as one gate (`entry.groundFire`) rather than as two assets, so the incendiary shell keeps the fires it already sets and gets no dust over them — which is also what keeps the withdrawn 2026-08-09 blast-ring ruling honoured. If the intent was a fire mark **as well**, that is a different build. §3.2b. |
| **Six pellet marks land on the same square as the restored aim-point star** | ⚠ **Raised by the build, needs eyes.** The veto restores the hit-confirmation star (1.15 sq at the aim point) *and* the ruling adds six 0.45 sq marks at the pellet endpoints — and on a hit the pellets converge within 0.28–0.84 squares of that aim point, so the seven marks overlap. The stagger spreads them over a few frames rather than stamping them at once. If it reads busy in motion, dropping **either** is one edit: the star is the class's `impactSquares`, the marks are `PELLET_ARRIVAL`. |
| **The arrival ladder lengthens the apply window on painted classes** | ⚠ **Stated so it is a decision, not a surprise.** The mark is now drawn at the round's arrival, so the settle floor grows with it — the rifle's tail goes 933 → **1200** ms at the 30ft band and **1533** ms at 90ft, and a long shot therefore holds the damage window a little longer than it did. That is the correct direction (over-stating is safe, under-stating opens the window over a mark still coming) and the engine's own end still ends the wait first in ordinary play, but it is a felt change at the table. |
| **The two impact clips are not signed off by ear** | ⚠ **The open item of this unit.** The *feature* and the two files are the user's picks (`flesh-01` = *Bullet Blood 3*, `sdp-02` = *HeavyBulletPing*, kept out of a 40-candidate audition). The *levels* are the build lane's: `HIT_SOUND_VOLUME` **0.55** and the structure clip's peak-match `gain` **1.1677**. ⚠ Peak-matching does **not** equalise them by ear — the structure clip carries **5.85 dB** more energy in its loudest 100 ms because it rings and the flesh clip does not, so it will read as the bigger event at a matched peak. That may be correct (a round into a vehicle IS the bigger event) but nobody has ruled it. Two constants revert either half. The audition manifest also records the user's own reservations about both files: `flesh-01` reads to two commenters as a *knife*, and `sdp-02` is honestly-labelled kitchenware foley described as "not loved". |
| **`sfx()` carries the same locked-context hazard the impact leg now guards** | ⚠ **Found while fixing the impact leg 2026-08-12, deliberately NOT changed.** A shot fired on a client whose audio context has never been unlocked hands back a promise that never settles, and the report then plays whenever the first click happens rather than when the shot did (§6, same date). The impact leg skips outright; `sfx()` still parks, because changing it changes SHOT audio behaviour and that is a different unit's call. One line if it is wanted: the same `game.audio.locked` guard, with a `skipped` report. |
| Audio for the ammo treatments | Sourcing owed; no runtime pitch variation is available on this host (verified against core's audio sources — no `playbackRate`, no `detune`, and the broadcast path discards extra fields). |
| Real decal persistence (**blood only** now) | Needs a ruling: who owns the write, who cleans it up, what a table does about a scene that accumulates them. The blood splash is transient by ruling — floor decals were explicitly held out of phase 1. ⏪ This row used to carry the incendiary ground mark alongside it; that element was **removed outright on 2026-08-10**, so the question is the splash's alone. |
| ~~Animations run in slow motion and trail out after the shooting stops~~ | ✅ **CLOSED 2026-08-09.** Measured, not guessed: a fixed per-round sleep against a starved timer compounded to **2.24×** on every burst size tried. Anchored schedule + drop rule brings a 30-round burst from +6 461 ms of drift to **+89 ms**. §4.1a, and the keeper drives both halves. |
| ~~The out-of-combat pattern TTL may not be deleting~~ | ✅ **CHECKED LIVE 2026-08-09, and it works.** A real fired pattern was placed out of combat, was still there at 20 s, and was removed by the module's own interval at **70.0 s** (TTL 60 s + one 15 s tick), with nothing called by hand. What had been seen lingering was a different rule — see the row below. |
| **A started encounter that never advances a round keeps its patterns forever** | ⚠ **Found during the 2026-08-09 autopsy; needs a ruling, not a fix.** 11 patterns were sitting on the rig's review scene 105 minutes after they were thrown. All of them belonged to an encounter that was **started and still on round 3**, and both clocks decline them by design: the wall-clock rule stands down whenever the owning encounter is running (`encounterRunning`), and the round rule only fires on a round **advance**. So an encounter left started and idle makes its patterns immortal. That is the rules as written — a pattern belongs to the round it was thrown on — but a table that stops advancing rounds accumulates them. Options are a wall-clock backstop for in-combat patterns, or a sweep when an encounter is deleted; both are design calls. |
| **A shooter resolved from a token on a scene nobody is looking at draws the shot from that scene's coordinates** | ⚠ **MEASURED 2026-08-10 (review finding F2), needs a ruling.** `shooterTokenOf` falls back to `tokensOf(actor)[0]`, which reaches **across scenes**. Probed on the rig: an actor whose only token sits at (2200, 2400) on an unviewed scene, fired while the GM views a 2800 × 2000 scene, queued **four sprites on the viewed canvas** — the lance at (2216.8, 2412.6), the tracer stretched from (2200, 2400) to the aim at (650, 650), the impact and the blood on the target — i.e. the shot is drawn from a point 400 px **below the viewed scene's own bottom edge**. The `skipped` bail added the same day does not cover it: that fires only when the actor has **no token anywhere**. ⭐ The second half of the finding is **REFUTED**: the off-scene token's rotation does **not** change. `faceTargetTurn` does compute a turn (138.366°, delta 138.366°, 220 ms), but the write throws — *"You must provide an `_id` for every object in the update data Array"*, the exact cross-scene `TokenDocument` hazard `mech/light.js` already documents — and `faceTarget`'s own try/catch swallows it as a warning. So the defect is a misdraw, not a stray document write. Options: prefer a token on the **viewed** scene and treat "none here" as no shooter, or keep the cross-scene fallback and skip the draw. Both are design calls. |
| **A pattern on an unviewed scene survives a round advance** | ⚠ **CONFIRMED 2026-08-10 (review finding F8), cosmetic, needs a ruling.** Probed on the rig with the probe's own encounter: a pattern placed on scene A at round 1, the GM then viewing scene B, `combat.update({round: 2})` → **the pattern is still there**, while the pure rule (`spreadZoneRoundExpired`) says `true` for exactly that pattern. Both expiry paths walk `canvas.scene` only. Returning to A and advancing to round 3 collected it. So it self-corrects the moment the GM looks back and a round passes; the fix would be to walk the pattern's **own** scene (`areasByFlag` per scene, or the combat's scene) rather than the viewed one. |
| **A missed PAINTED round is scheduled off a different band than it flies** | ⚠ **MEASURED 2026-08-10 as F5 against the volley, RE-MEASURED 2026-08-11 against the arrival ladder that replaced it (§4.2a); still no ruling.** A miss draws **no mark at all**, so nothing visible hangs on it — what moves is the scheduled floor. The old volley reading follows for the record: ⏪ A missed shell stretches to `missEndpoint`, whose reach is **0.6–1.15 ×** the true aim distance, while every timing came from the true aim's band. Swept by value over the reach range: at 6 squares the drawn file is a **shorter** band 42.3 % of the time, at 12 and 20 squares 27.4 % — all in the safe direction (the tail over-states). The unsafe direction is confined to the neighbourhood just **under** a boundary, where 1.15 × reaches the next band up: at 4.5 squares **7.5 %** of missed shells draw a longer band (tail under-stated by **200 ms**), at 8.5 squares **16.9 %** (**400 ms**), at 14.5 squares **21.4 %** (**400 ms**). It moves the **scheduled floor** only: the settle still waits on the engine's own end for the effect that was really drawn, so the exposure is the no-engine fallback rather than ordinary play. |
| ~~**The arithmetic still prices a volley for a shot the fan-out now refuses**~~ | ⏪ **Moot with the veto** — no volley term is resolved for any payload. The reading for the record: ⚠ **MEASURED 2026-08-10 (F5a), no ruling.** `payloadPresentationMs` resolves its volley spec without the `&& shooter` guard the fan-out applies, so a buckshot payload from an actor with no token computes **600 ms** (the 15ft band at a zero-square aim) for a shot the rail now reports as `skipped: "shooter"` and does not draw at all; the same payload with no volley term computes 983 ms. Harmless today — a caller waits a beat over an empty canvas — but the two answers should come from one question. |
| Blood asks the ACTOR, not the hit location | A cyberlimbed character bleeds even when the round struck the chrome arm. The payload carries how many rounds landed and never where, so the per-zone answer does not exist at draw time; getting it would mean the seam forwarding hit locations to the presentation rail, which is a change to what the payload *is*. Recorded as a known limit, not a defect. |
| The blood splash is routed above the lighting | The one departure from the file's own routing rule, taken because below it the mark does not exist on a dark scene. It is a **look** call the user has not yet made in motion: the cost is that a splash is drawn over ground the viewer cannot see, for under a second. One constant (`BLOOD_SPLATTER.aboveLighting`) reverses it. Captures 58a vs 58d. |
| **The rebuilt blood splash is not signed off** | ⚠ **The open item of this unit.** The direction and the per-hit rule are both rulings and both are built; the remaining numbers are build-lane calls made while the user was away — the payload cap of **4** and the one-grid-unit exit offset that sets the heading. Each is one constant (`BLOOD_SPLATTER.maxPerPayload`; the `+ gridPx` in `fxBloodSplatter`). Captures 64a (angled shot, held) and 64b (burst). |
| **The incendiary load still burns the ground the target is standing on** | ⚠ **Raised by capture 64c, needs a ruling.** The blast ring the report named is gone. But on a hit the aim point *is* the target's square, so the burning ground — which was ruled to stay — still lands there and reads as fire on the target. If what was actually objected to was the fire rather than the ring, the fix is a different one (offset the landing points off the target, or suppress ground fire on a hit). One look at 64c settles which. |
| **The slug is modelled as a LOAD, and that is a build-lane call** | ⚠ **The open item of the spread unit.** The registry has one shotgun cartridge, `"00"`, labelled *"00 Buck / Slug"* — so nothing about the caliber can say which is chambered, and the build expressed the slug as a shotgun-family ammo modifier instead (see §6). The alternative is splitting the cartridge into two registry entries, which is a migration and a re-seed and would break the gauge aliases that currently all point at one id. A veto is cheap by construction: the whole thing is one row in `AMMO_MODIFIERS`, one option on the ammo sheet's spread selector, and the first branch of `spreadModeForAmmo`. |
| One shipped shell weapon records **no gauge** | 10 of the 11 shell weapons in `supplement-shotguns` carry a gauge in `ammoType`; one carries an empty string, so it reports no cartridge and throws no pattern until an ammo item is loaded. Same shape as the known blank-`vehicleType` data gap, and it belongs to the pack-data sweep rather than to this rail. |
| The pattern's look is **verified on v14 only** | `spread-zone-look.js` carries a v13 branch (a MeasuredTemplate's own alpha, and its control icon hidden) written from that core's API and never run: the ship target is v14 and the rig is v14. Structurally the same two facts; it is untested and says so at the site. |
| ⭐⭐ **ELEVEN CONDITIONS HAVE NO TREATMENT AND ARE WAITING ON THE USER** | ⚠ **The open item of this unit, and it is a batch of calls rather than a defect.** The instruction was that conditions which do not read straight across from the source material get adapted **with** the user, so the inventory (§2a.1) is closed and complete while the look for each of these is deliberately blank. Each becomes **one row** in `STATUS_FX_ROWS` — a table entry, not a code change. In the order I would ask them: ① **wound state** (`actor.woundState()`, 0–10 — the one every table would notice; a badge that changes with the tier, or nothing?) · ② **radiation** (two markers: `radExposure` the running dose, `radState` the stat loss — one look or two?) · ③ **drugged** and ④ **addicted** (`drugState` / `addictionState`) · ⑤ **taser accumulation** (`taserState`) · ⑥ **choking** (`chokeState`) · ⑦ **stabilized** (`stabilized` — arguably a *good* mark, the one row in the list that is not a problem) · ⑧ **flesh limb lost** (`fleshLimbStatus`) · ⑨ **cyberlimb SDP damage** (derived from `sdp.current` vs `sdp.sum`; note the base system draws no conclusion from a zeroed zone) · ⑩ **consumable timer running** (`consumableState` — this one **already** puts core's own icon on the token, so a second mark may be redundant) · ⑪ the ~25 core condition ids nothing in the module ever sets (`prone`, `blind`, `deaf`, `fear`, `bleeding`, `frozen`, …) — a GM can toggle any of them by hand and none has a look. |
| ~~The stunned look is the marker clip, not the circling stars~~ | ⏪ **SUPERSEDED 2026-08-12 by the ring standard** — stunned now wears the eldritch-web ring (`shield_themed.below.eldritch_web.01.dark_purple`, native purple, 10 s dead-flat loop). The stars question stands unchanged for the record: `dizzy_stars` is still not a loop (2000 ms, fades to black, strobes if looped) and remains one constant away with that pulse attached. |
| **Whether `stun` and `unconscious` deserve two different looks** | ⚠ They share one row today because this engine's stun outcome IS `unconscious` (the failed check sets it, the recovery check lifts it) and core's `stun` is only ever hand-set. If a table wants "rattled" to read differently from "out cold", that is a second row and a second key. |
| **The acid row's colour is a build-lane pick** | ⚠ Carried across the ring rework: hue **−120**, saturate **+0.15** now rotates the molten-earth ring's orange to acid green (the ring set has no green). Deleting the `colour` field restores the asset's own orange. |
| **The poison row's colour is a build-lane pick** | ⚠ New with the ring rework: hue **+130**, saturate **+0.1** rotates the smoke ring's blue-purple toward a fume green. Deleting the `colour` field restores the asset's own colour. |
| **Rings ride OVER the token; the reference draws its Below ring UNDER the mini** | ⚠ **The look call of the ring rework, needs eyes.** Over-token + `aboveLighting` keeps a condition visible on unlit squares (the rail's standing visibility ruling) at the cost of flames/web overlapping the mini's edges — which is also roughly what the reference's *Strong* tier looks like. `below: true` on a row restores the reference-exact underlay and inherits the dead row's darkness trade. One field per row. |
| **A stronger burning tier is one key away, and it pulses** | ⚠ The reference tiers its fire (Mild = below ring, Strong = above ring, Deadly = both at `_03`, patreon-gated). Our single `fireDotState` ships the below ring. `shield_themed.above.fire.01.orange` is installed and free — but it DECAYS across its own clip (thirds 60.2/49.9/40.9) and pulses every 5 s when looped. If a stronger look is wanted, layering below+above at `_01` is the honest free-tier approximation; the pulse rides along and is recorded here first. |
| **The dead ring is invisible on an unlit square** | ⚠ **Stated so it is a decision, not a surprise.** It is drawn **below the tokens**, which is also below the lighting, so on a dark scene it is not there to be seen. Accepted on this row alone because core's own skull icon on the token is unaffected and still carries the fact. One field (`placement: "badge"`) lifts it out. |
| **The ring opacities are build-lane picks; the scales are measured** | ⚠ Each ring's `scaleToObject` is the decode's ink-fraction compensation (burning 1.18 = 400/339 · acid 1.05 · stunned 1.25 · poison 1.0) — measured, not chosen. The OPACITIES are mine: 0.85 / 0.8 / 0.9 / 0.85, dead 0.55. Every one is a single constant and a veto costs nothing. |
| **The overlays ride the shot rail's master switch and have none of their own** | ⚠ `combatFxEnabled` governs both, which is what the docket specified. A table that wants gunfire effects but no condition marks (or the reverse) has no way to say so today; a dedicated sub-toggle is one setting plus one reader if it is wanted. |
| **An evicted overlay is silent about being evicted** | ⚠ Past `maxLive` = 60 the oldest mark is ended to make room, so on a very busy scene a figure can be wearing a condition with nothing drawn until the next event touching it redraws it. The reconciler makes this self-correcting rather than permanent, and 60 is twelve fully-marked figures, but the failure mode is worth knowing before someone reports a missing flame. |
| ⛔⛔ **THE ARRIVAL'S FIVE FIGURES ARE A CINEMATIC, NOT FIVE FIGURES — AND THAT IS A BUILD-LANE CALL** | ⚠ **THE OPEN ITEM OF THIS UNIT, and the first thing to ask.** The reference shows five people getting out. What ships is five SPRITES: no actor, no token, no document of any kind (asserted both directions by the keeper). The reasoning is that real figures are a *document* feature carrying questions a presentation rail cannot answer — which actors, owned by whom, cleaned up when, and what happens to them when the aircraft leaves — and half-building one is worse than not building it. If what was wanted is five figures a table can move and roll for, that is the non-player-figure generator's job and this sequence becomes its trigger: the seam is `figureSchedule()`, which already returns five stated points and five stated instants, so a document-creating caller has exactly the geometry it needs and nothing else has to move. |
| **An asset ask: there is no aircraft art** | ⚠ **Recorded rather than solved, and nothing was scraped.** All 2 061 installed keys were enumerated; the free tier has no aircraft, and neither the module nor the base system ships one (module `img/` is five files; the system's is 22, all sheet furniture). So the airframe is an engine-native rounded shape — a dark planform with a lit edge, which is at least what a top-down camera would see. **With a licensed top-down aerodyne image this becomes one `.file()` call and the shape goes**, along with `airframeShape()` and the offset correction under it. That is the single highest-value asset the user could hand this rail. |
| **A sound ask: there is no station-keeping bed** | ⚠ **Measured, not assumed (§2b.6).** Every candidate in the 46-file library decays to silence and none is a rotor or turbine LOOP, so the longest phase of the sequence — a machine hanging in the air — is silent. The descent gets `fx-scifi-whoosh` (197 Hz, decaying, the lowest thing shipped) because it genuinely fits that one beat. What is wanted is a **loopable low turbine/rotor bed** and, if a second is ever sourced, a spin-up/spin-down pair for the arrival and departure. No audio was sourced for this unit, per the docket. |
| **A full reload loses a placement that is on station** | ⚠ **Stated so it is a decision, not a surprise.** Nothing is persisted (§G/22), so the record of what is standing lives in each client's memory. A scene change and a canvas rebuild are recovered by the reconciler; a browser reload is not, and the referee places it again. Persisting it would mean a document write from presentation, which this rail does not do — the alternative, if it is ever wanted, is the referee's own client answering a "what is on station?" request from a joining client, which is a socket round trip rather than a write. |
| **The arrival's heading is fixed** | ⚠ The rectangle is axis-aligned and the aircraft comes in from screen-north (`entryPointFor`). One heading means one rotation basis and nothing computing a second one (§B/6), which is why v1 has it. A referee-chosen heading is a rotation applied to the plate, the four marks, the hull and this one point — not a new mechanism — plus a way to express it in the ghost. |
| **Twelve numbers in the arrival's ladder are build-lane picks** | ⚠ **The rest of the open items for this unit, and every one is a one-edit veto** (the full list with its ships-as values is in §5). The five facts from the reference are rulings and are built; these are the numbers around them: the 4 × 6 footprint · the hull's 2.4 × 4.6 lozenge at fill alpha **0.72** (it is a heavy dark shape over somebody's map — the most likely thing to be objected to) · the 900 / 2600 ms entry and descent · the **1200 ms** ring spacing · the 0.9 / 1.1 / 0.18 figure spread · the 2200 ms departure · and the descent cue at **0.5**. |
| Exotic weapon palette (bows, beams) | No FX class exists; the arrow ammo loads therefore have no overlay rows. A design unit of its own. |
| Pistol/SMG automatic fire is smokeless | A consequence of retiring the burst smoke stream — `bullet.01` carries none of its own. One row field (`tracer` → `bullet.02.orange`) if that is ever wanted. |
| Vision mask vs. self-luminous sprites | The engine offers no route that clears the darkness and keeps the mask. Accepted, documented at the site. |

---

## 9. The Sequencer authoring standard — **RATIFIED 2026-08-11**

Every rule below is one this arc either followed and benefited from, or violated and paid for; the
lesson that produced each is cited beside it. Ratified by the user on 2026-08-11 from the review draft,
and it is the **conformance bar for every new element** from here: a unit that adds or replaces
something on this rail is not done until it can be read against this section. The working-procedure form
of the same standard is the project skill `cp2020-sequencer-fx`.

### A. The element's contract (before any code)

1. **Spec block first.** Every element gets ONE frozen constant block carrying every number a reviewer
   might move, each with the measured basis or the ruling that set it, and the **revert value recorded
   at the site** when a ruling replaces something. *(This file's standing habit —
   `TRACER_COLOR_INCENDIARY`'s revert note; the discharge column's four-report decay.)*
2. **Database keys, never file paths.** Keys resolve on whichever asset tier is installed; existence is
   guarded per draw (`fxDbEntryExists`) and a missing key **skips silently**. Never vendor assets
   (JB2A free is CC BY-NC-SA).
3. **Asset-native first.** Prefer what the clip already bakes in — a multi-file key randomises per play,
   a range-banded key picks per distance, an arrival bloom comes free. **An element that needs a trim, a
   dwell, a derived rate AND a shortened stretch to show one frame of itself is the wrong asset —
   replace it, don't tune it.** *(The discharge column, deleted after four reports.)*
4. **Decode, don't guess.** Sizes are the **drawn frame**, not the ink; durations are measured off the
   installed file's own clock; distance-banded assets get a per-band table, and **arrival and
   content-end are two different numbers answering two different questions**. *(`dashSquares: 0.8`
   "picked, never measured" read faint; the volley band table; the 2026-08-11 arrival decode.)*

### B. Geometry and placement

5. **Grid units, not pixels or scale factors** (`gridUnits: true`), so the look survives any scene.
   Token-relative plants measure from the token's own edge (`tokenRadiusPx`).
6. **One rotation basis.** Everything directional takes its axis from the shooter→aim ray through the
   same call (`rotateTowards` at a point along that ray). An element that computed its own heading is an
   element that can disagree with the round that caused it. *(Blood's exit vector deliberately reuses
   the tracers' basis.)*
7. **Never invent a position you could have asked for.** Fanned classes reuse their **real** pellet
   endpoints; single-bolt classes scatter inside a stated disc **as an admission of ignorance**.
   Constructions that must stay inside a shape are built in the shape's own coordinates and rotated out
   (`patternFirePoints`), with the containment test kept as a **separate** check.
   ⭐ *Extended 2026-08-11:* when the endpoints gain a jitter, everything derived from them takes the
   **same** jitter record — the burning ground now does — or the derived positions quietly stop being
   where the rounds went.

### C. Determinism and randomness

8. **Transient + one-client → `Math.random` is fine** (miss splay, motes), with an injectable `rng` for
   tests. **Long-lived, cross-client-meaningful, or replayed → payload-seeded** (`fxSeedOf` →
   `seededRng`), so agreement is a property of the inputs.
9. ⚠ **The seed must carry per-event entropy when variety across events is the point.** Fold in a rolled
   value (`areaDamages` JSON), a stamped `createdAt`, or a payload nonce — **identity fields alone
   (attacker, weapon, counts) make two identical trigger pulls draw the same picture.** *(Review finding
   F3: the ground-fire seed folds `areaDamages` and varies; the volley seed did not and repeated. The
   pellet fan that replaced the volley folds the same term in the same position.)*
10. **Per-round variety folds in the round index** beside the payload fields.

### D. The fan-out loop (pacing)

11. **One wait per loop, anchored to a slot ladder** (`roundDueAtMs` from one `loopStart`); sleep only
    the remainder. Never accumulate a fixed cadence — timer lateness compounds (measured 2.24×).
12. **Drop-not-queue:** a round later than `FX_DROP_LAG_FRACTION` (0.5) of its own cadence is dropped
    **whole** — audio with picture. The **last round is never dropped** (it carries the settle tag).
    Thresholds are fractions of cadence, never flat ms (a flat 150 fails below 300 ms cadence —
    measured).
    ⭐ *Amended 2026-08-11:* the drop rule owns the **tracer budget only**. A round that HIT still gets
    its arrival elements — they are one sprite each, at the far end of the shot, and they are what says
    the round landed. State the impact budget separately and bound it separately (§4.1a).
13. **Nothing inside the loop is awaited except the one sleep.** Draw verbs are fire-and-forget with a
    `.catch` naming the verb. *(Awaiting one `play()` cost 330 ms per round.)*

### E. The completion signal (settle)

14. **Every element either participates in the settle signal or carries a documented exclusion plus a
    tail entry.** Only the last round's latest-ending element is tagged; scene dressing that outlives
    the action (fires, blood, the pellet arrival marks) is excluded so the damage window never waits on
    it.
15. **The tail arithmetic reads the RESOLVED entry** — class row + ammo overlay + banded spec — so any
    overlay field that moves a duration is a tail input. **Over-stating an element's life is the safe
    direction; under-stating opens the apply window early**, which is the silent one-directional
    failure. *(2026-08-11: the arrival became a tail input the moment the mark started waiting for it.)*
16. ⚠ **Untrimmed long assets need an engine-wait CAP at their content end.** The engine's exit fires at
    clip end, not at the last visible frame; a tagged element whose final seconds are invisible residue
    holds the window shut for them. *(Review finding F4, against the volley.)*

### F. Overlays and load identity

17. **One merge site** (`ammoFxEntry`); the draw path reads only the resolved entry and never knows an
    overlay happened. The key is resolved **once per payload** and threaded down.
18. **Repaint-never-add masks use `=== undefined` key presence.** Declared-as-`null` means "repaintable,
    painted with nothing" — never "tidy" it to a falsy check.
19. **Identity rides the payload** (`modifier` beside `caliber` — they answer different questions and
    neither may displace the other); fingerprints are the compatibility path.
20. ⚠ **A branch that REPLACES the drawn round must still honour the resolved entry's treatments**
    (colour, at minimum) or explicitly document that it suspends them. *(Review finding F9. The branch
    it was written against is shelved; the rule is general and outlives it.)*

### G. Long-lived elements

21. **Caps + lifetimes + eviction, all three:** a per-payload bound, a scene-wide `maxLive` with
    oldest-out eviction (evicted **through the engine's manager**, so the end relays to every client),
    and a stamped `name` under one prefix so the census is a **query of the engine**, never our own
    ledger. Count the **pending** (queued-not-yet-created) against the cap, and release in `finally`.
22. **No document writes from presentation.** The one exception (the face-target rotation) is
    owner-gated, dead-zoned, and its duration joins the presentation arithmetic.

### H. Flow ownership and clocks

23. **One flow-ownership site** (`spreadFlowModeOf`): what-the-round-**is** (pure derivation) and
    what-the-module-**does** (world switch) are two questions with one authoritative answer. Presentation
    asks the IS question when the look must survive the switch — and says so at the call site.
24. **Three clocks, named:** roll time → **visual impact** (`arrivalMs`, ONE derivation per payload) →
    damage application (settle-gated). Delayed dressing hangs on clock 2; the apply window on clock 3.
    ⭐ *Corrected 2026-08-11:* clock 2 must have an answer for **every** draw shape the rail supports. It
    had one for travelled and banded rounds and a **zero** for painted ones, and that zero put four of
    five classes' impacts at the muzzle. A shape with no clock-2 answer is a defect, not a default.

### I. Registration, capture, verification

25. **Capture seams are part of the element** (`_held`, the `_set*` family, armed by nothing that ships)
    and are applied **first** in the chain — a rate or filter set after the seam silently defeats it.
26. **The keeper asserts VALUES:** queued entries, resolved specs, negative cases (off / missing key /
    wrong class), determinism by computing twice — plus at least one leg per element that exercises the
    **live** path, and one that varies the inputs a real table varies (**two separate trigger pulls, not
    two indexes** — the F3 blind-spot rule).
27. **The Review·Shooter exercises every shipped element** (review-shooter parity), and `docs/FX-RAIL.md`
    gets the element's entry **and** its rulings-log lines in the same unit.

### The once-per-payload gate — THE ONE IDIOM

Resolve every gate **once** in `fxWeaponFired`, before the loop, into a local plan object; then declare
the element's issue policy explicitly:

- **`per-payload`** — the call sits **outside** the loop. *(The burning ground's shape.)*
- **`per-round-capped`** — the plan carries a `cap` and the loop checks `queued < cap`. *(The blood
  spray's shape, and the hit mark's since 2026-08-11.)*

Row-flag gating (the smoke's `smokeSingle` + `!burst`) is **retired for new elements**: put the policy in
the plan, not half in the row and half in the loop condition.

### Conformance grades (living elements, at ratification)

| Element | Grade | Gaps against this standard |
|---|---|---|
| Flash light (native) | **A** | n/a (not Sequencer); spec-blocked, capped, socket-announced |
| Muzzle lance | **A** | model citizen — spec, decode, dwell-as-rate, capture-seam order |
| Tracer / pellet fan | **A** | irregularised 2026-08-11, seeded with per-event entropy, bounded by the class's own cone |
| Impact marks (`HIT_CONFIRM` / crack / dust) | **A** | parent-path keys documented; promotion masked; **arrival-anchored and off the tracer budget since 2026-08-11** |
| Pellet arrival marks | **A−** | new 2026-08-11 — spec-blocked, endpoint-reusing, excluded from settle; size and trim are unsigned look calls (§8) |
| Smoke puff | **B+** | gate still split row-flag + loop condition — the drift the idiom above retires |
| Motes / burst ambience | **A−** | `Math.random` appropriate (transient); await-cost lesson recorded |
| Ground fire | **A** | the standard's exemplar: seeded with entropy, capped, evicted, named — and it now takes the fan's own jitter |
| Impact audio | **A−** | new 2026-08-12 — spec-blocked with measured levels, arrival-anchored, per-round-capped by import from the splash, capture-seamed (`_setHitSoundSink`), reported by value (`hitAudio`). The two clips' relative loudness is an unsigned look call (§8) |
| Condition overlays | **A** | new 2026-08-12 — spec-blocked with decoded bases and rejected candidates recorded, database-keyed and guarded, grid-unit geometry measured off the figure's own width, slot-per-row so marks cannot slide, capped + evicted + named so the census is a query of the engine, zero document writes (asserted), excluded from the settle signal, capture-seamed (`_setStatusFxRate`), reported by value. Detection is event-driven at the real mutation points with the catch-up on the engine's own signal. Sizes, the acid recolour and the stunned key are unsigned look calls (§8) |
| Extraction arrival | **A−** | new 2026-08-12 — spec-blocked with the reference's five rulings separated from the numbers, database-keyed and guarded per draw, ink fractions measured off the installed clips and corrected for, one anchored ladder, capped + evicted + named so the census is a query of the engine, zero document writes (asserted both directions), excluded from the settle signal with the exclusion stated, capture-seamed (`_setTraumaTimeScale`), reported by value, socket-threaded, referee-gated three times. **The −** is that two of its seven keys were first chosen by NAME and were wrong (§2b.4) — decoded and replaced before ship, but the rule exists so that does not happen at all. The cinematic-only scoping call and the asset/sound asks are in §8 |
| Blood splatter | **A−** | per-round-capped idiom done right; rotation basis shared; F2 inherits |
| Baton round | **A−** | replace-mask precedent; asset measured |
| Spread-zone ghost look | **B+** | not Sequencer; isolated and flag-keyed, but the v13 branch is unverified |
| Spread aim preview | **A−** | added 2026-08-11 — not Sequencer; one spec-blocked alpha, geometry and band ladder shared with the plant by import rather than by copy, teardown on cancel/confirm/`canvasTearDown`, writes no document. Its alpha and readout wording are unsigned look calls (§8) |

*(The volley's own **C** — F3 seed entropy, F4 settle cap, F9 overlay reach, all three — went with the
element on 2026-08-11. It is recorded in §6 rather than graded here: a shelved branch is not a living
element, and the three findings that made it a C are the reason three of the rules above are written the
way they are.)*
