# Sound Credits

The audio files in this directory are third-party works redistributed under the licenses
listed below. Every license used here permits redistribution as part of this module.

License breakdown (44 files):

- **40 × CC0 1.0 Universal (Public Domain Dedication).** Attribution is not legally
  required for CC0 but is given below as a courtesy to the original authors.
- **2 × CC BY 4.0.** Attribution *is* legally required for these; the entries are marked
  **ATTRIBUTION REQUIRED** and carry the exact credit line to reproduce.
- **2 × Pixabay Content License** (`auto-burst-alt.mp3`, `auto-loop-alt.mp3`). Permitted
  inside a larger work such as this module; standalone redistribution is not. See the
  "Pixabay-sourced alternates" section at the end for the full caveat.

No file here uses an NC (NonCommercial) or SA (ShareAlike) license.

Each file was obtained from the Freesound page linked in its entry, where that specific
sound's license is stated. Files are the Freesound-generated high-quality Ogg Vorbis
preview of the original upload — no editing, trimming, or loudness normalization was
performed by this project.

---

## `shot-pistol.ogg`

- **Title:** 9mm pistol shot
- **Author:** michorvath
- **Source:** https://freesound.org/people/michorvath/sounds/427592/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Original upload is WAV; this is Freesound's
  site-generated Ogg Vorbis preview of that file (mono, 44.1 kHz, 1.663 s).

## `shot-smg.ogg`

- **Title:** AR15 pistol shot
- **Author:** michorvath
- **Source:** https://freesound.org/people/michorvath/sounds/427598/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Original upload is WAV; this is Freesound's
  site-generated Ogg Vorbis preview of that file (mono, 44.1 kHz, 0.909 s).

## `shot-rifle.ogg`

- **Title:** Sniper Rifle Shot Sound Effect
- **Author:** qubodup
- **Source:** https://freesound.org/people/qubodup/sounds/182051/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Original upload is FLAC; this is Freesound's
  site-generated Ogg Vorbis preview of that file (stereo, 44.1 kHz, 1.950 s).
- **Note:** The uploader states this was extracted from video published by a U.S.
  Government agency and is therefore public domain at source.

## `shot-shotgun.ogg`

- **Title:** Shotgun_Shot.wav
- **Author:** ken788
- **Source:** https://freesound.org/people/ken788/sounds/386758/
- **License:** CC0 1.0 Universal - https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Original upload is WAV; this is Freesound's
  site-generated Ogg Vorbis preview of that file (stereo, 44.1 kHz, 2.173 s).
- **Note:** Replaced the previous 20-gauge recording (now `shot-shotgun-alt.ogg`) as the
  shotgun class's report. Chosen on measurement rather than description: 73.6% of its
  energy sits below 500 Hz against 31.2% for the 20-gauge clip and 58.5% for
  `shot-rifle.ogg`, spectral centroid 1552 Hz against 3773 / 2788 Hz, and 85% rolloff
  844 Hz against 2712 / 1411 Hz - lower than BOTH on every measure taken. The uploader's
  page states only "A shotgun being fired"; no gauge or model is named there.

## `shot-shotgun-burst.ogg`

- **Title:** SPAS-12
- **Author:** duesto
- **Source:** https://freesound.org/people/duesto/sounds/156904/
- **License:** CC0 1.0 Universal - https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Original upload is WAV; this is Freesound's
  site-generated Ogg Vorbis preview of that file (stereo, 44.1 kHz, 1.449 s).
- **Note:** The second report a multi-round payload plays, so a string of rounds is not
  one waveform repeated (see module/fx/effects.js, shotSoundSrc). Same depth class as the
  primary - 72.8% below 500 Hz against its 73.6%, and a heavier 80-400 Hz share (64.3%
  against 46.5%) - with more high-frequency crack, which is what an outdoor report has.
  The uploader states it was "recorded from my own weapon in Slovakia" and the upload is
  geotagged to Kysak, Kosice; it is a real Franchi SPAS-12, which is a 12-gauge weapon.

## `shot-shotgun-alt.ogg`

- **Title:** 20 gauge shotgun gunshot
- **Author:** michorvath
- **Source:** https://freesound.org/people/michorvath/sounds/427595/
- **License:** CC0 1.0 Universal - https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Original upload is WAV; this is Freesound's
  site-generated Ogg Vorbis preview of that file (mono, 44.1 kHz, 1.742 s).
- **Note:** RETIRED from the shotgun class but kept on disk for an A/B listen. It is a
  20-GAUGE recording - a smaller shell with a brighter crack - which is why it read as
  thin next to the rifle: measured, it is brighter than `shot-rifle.ogg` on every axis
  (31.2% vs 58.5% below 500 Hz; centroid 3773 vs 2788 Hz). Nothing references it.

## `shot-shotgun-short-alt.ogg`

- **Title:** shotgun-one-shot.wav
- **Author:** DeltaCode
- **Source:** https://freesound.org/people/DeltaCode/sounds/668353/
- **License:** CC0 1.0 Universal - https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Original upload is WAV; this is Freesound's
  site-generated Ogg Vorbis preview of that file (mono, 44.1 kHz, 0.719 s).
- **Note:** RETIRED as the shotgun class's multi-round asset, kept on disk for an A/B
  listen. Described by the uploader as a "computer-generated shotgun discharge one-shot"
  - synthetic rather than a recording - and although its FILE is the shortest of the set,
  its audible body is the LONGEST (0.399 s to -20 dB, against 0.360 s for the clip it was
  meant to be shorter than), so it never did the job it was selected for. Nothing
  references it.

## `shot-heavy.ogg`

- **Title:** 50 cal shot.wav
- **Author:** ajhartman42295
- **Source:** https://freesound.org/people/ajhartman42295/sounds/668071/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Original upload is WAV; this is Freesound's
  site-generated Ogg Vorbis preview of that file (stereo, 48 kHz, 1.911 s).
- **Note:** A single .50 BMG shot recorded at an outdoor range; the tail includes the
  ejected shell hitting the ground.

---

# Autofire

## `auto-burst.ogg`

- **Title:** Clean Machine Gun Burst
- **Author:** qubodup
- **Source:** https://freesound.org/people/qubodup/sounds/482122/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (mono, 48 kHz, 1.598 s).
- **Note:** The uploader states this was extracted from U.S. military video that is public
  domain at source — the same provenance basis as `shot-rifle.ogg`.

## `auto-loop.ogg`

- **Title:** Machine Gun 002 - loop.ogg
- **Author:** pgi
- **Source:** https://freesound.org/people/pgi/sounds/212608/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 0.900 s).
- **Note:** Authored from scratch by the uploader in Audacity; designed to loop seamlessly.

## `auto-minigun.ogg`

- **Title:** Minigun
- **Author:** Breviceps
- **Source:** https://freesound.org/people/Breviceps/sounds/557595/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 4.788 s).

---

# Melee

## `melee-punch.ogg`

- **Title:** Punch1.wav
- **Author:** Merrick079
- **Source:** https://freesound.org/people/Merrick079/sounds/566436/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 192 kHz source, 0.674 s).

## `melee-punch-heavy.ogg`

- **Title:** Intense Punch
- **Author:** damnsatinist
- **Source:** https://freesound.org/people/damnsatinist/sounds/493916/
- **License:** **CC BY 4.0** — https://creativecommons.org/licenses/by/4.0/
- **ATTRIBUTION REQUIRED:** "Intense Punch" by damnsatinist, licensed CC BY 4.0.
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 96 kHz source, 0.417 s).

## `melee-hammer-1.ogg`

- **Title:** Thud2.wav
- **Author:** BMacZero
- **Source:** https://freesound.org/people/BMacZero/sounds/96137/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (mono, 44.1 kHz, 0.580 s).
- **Note:** Described by the uploader as a low metal impact, "as of hitting a dense pipe
  with a hammer".

## `melee-hammer-2.ogg`

- **Title:** Thud3.wav
- **Author:** BMacZero
- **Source:** https://freesound.org/people/BMacZero/sounds/96138/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (mono, 44.1 kHz, 0.418 s).

## `melee-sword-hit-1.ogg`

- **Title:** Sword hits the body.wav
- **Author:** vdovitsky
- **Source:** https://freesound.org/people/vdovitsky/sounds/411122/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 1.674 s).

## `melee-sword-hit-2.ogg`

- **Title:** Anime Sound Effect - Piercing impact / Stabbing
- **Author:** Breviceps
- **Source:** https://freesound.org/people/Breviceps/sounds/464839/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 48 kHz, 2.295 s).

## `melee-whoosh-1.ogg`

- **Title:** Whoosh 03
- **Author:** velcronator
- **Source:** https://freesound.org/people/velcronator/sounds/733890/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 0.986 s).

## `melee-whoosh-2.ogg`

- **Title:** Clean fast Swoosh.aiff
- **Author:** Danjocross
- **Source:** https://freesound.org/people/Danjocross/sounds/507466/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Original upload is AIFF; this is Freesound's
  site-generated Ogg Vorbis preview (stereo, 48 kHz, 0.918 s).

## `melee-chainsaw.ogg`

- **Title:** Chainsaw
- **Author:** Hard3eat
- **Source:** https://freesound.org/people/Hard3eat/sounds/351775/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 8.404 s).
- **Note:** Largest file in this directory (197 KB) because it captures a full rev cycle.

---

# Archery

## `bow-shot.ogg`

- **Title:** 42 Disparar Flecha.wav
- **Author:** checholio
- **Source:** https://freesound.org/people/checholio/sounds/443832/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 48 kHz, 0.515 s).

## `bow-impact.ogg`

- **Title:** ARROW_WOOD_IMPACT_SINGLE_ARCHERY_01.wav
- **Author:** JoeDinesSound
- **Source:** https://freesound.org/people/JoeDinesSound/sounds/534956/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 48 kHz, 1.548 s).
- **Note:** Direct field recording of an arrow from a 40 lb English longbow striking a
  wooden shed.

## `crossbow-shot.ogg`

- **Title:** Crossbow Fire XI
- **Author:** DUDE_X-SoundLab
- **Source:** https://freesound.org/people/DUDE_X-SoundLab/sounds/752211/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 48 kHz, 0.417 s).

---

# Grenades & explosives

## `grenade-pin.ogg`

- **Title:** Grenade pin pull.flac
- **Author:** CGEffex
- **Source:** https://freesound.org/people/CGEffex/sounds/93837/
- **License:** **CC BY 4.0** — https://creativecommons.org/licenses/by/4.0/
- **ATTRIBUTION REQUIRED:** "Grenade pin pull" by CGEffex, licensed CC BY 4.0.
- **Modifications:** Renamed only. Original upload is FLAC; this is Freesound's
  site-generated Ogg Vorbis preview (stereo, 44.1 kHz, 2.014 s).

## `grenade-flashbang.ogg`

- **Title:** CTS 7290.wav
- **Author:** areniporgen
- **Source:** https://freesound.org/people/areniporgen/sounds/693421/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (mono, 48 kHz, 1.029 s).
- **Note:** Recording of an actual CTS Model 7290 flash-bang distraction device.

## `grenade-gas.ogg`

- **Title:** Gas Grenade.wav
- **Author:** Themiwa100
- **Source:** https://freesound.org/people/Themiwa100/sounds/551429/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (mono, 44.1 kHz, 8.377 s).

## `grenade-smoke.ogg`

- **Title:** Steam.wav
- **Author:** SukritSen
- **Source:** https://freesound.org/people/SukritSen/sounds/398077/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 48 kHz, 4.040 s).
- **Note:** Stand-in — a pressurized hiss, not a purpose-made smoke grenade. See
  `import-staging/SOUND-REPLACEMENTS.md`.

## `grenade-biotoxin.ogg`

- **Title:** Carbonation Release and Fizz.wav
- **Author:** baidonovan
- **Source:** https://freesound.org/people/baidonovan/sounds/187332/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 48 kHz, 1.955 s).
- **Note:** Stand-in — a chemical/fizzing pressure release. The uploader suggests it for
  sci-fi use. See `import-staging/SOUND-REPLACEMENTS.md`.

## `grenade-incendiary.ogg`

- **Title:** Molotovin_koktaili.mp3
- **Author:** ertzsi
- **Source:** https://freesound.org/people/ertzsi/sounds/622890/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Original upload is MP3; this is Freesound's
  site-generated Ogg Vorbis preview (stereo, 44.1 kHz, 1.846 s).

## `explosion-big.ogg`

- **Title:** explosion_big_01.ogg
- **Author:** derplayer
- **Source:** https://freesound.org/people/derplayer/sounds/587194/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 48 kHz, 2.862 s).

## `explosion-combined.ogg`

- **Title:** World Ender Explosion
- **Author:** qubodup
- **Source:** https://freesound.org/people/qubodup/sounds/814057/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 8.308 s).
- **Note:** Synthesized by the uploader by layering piano and drum material in FL Studio.

## `rocket-launch.ogg`

- **Title:** Rocket Launch
- **Author:** Jarusca
- **Source:** https://freesound.org/people/Jarusca/sounds/521377/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 48 kHz, 1.409 s).

## `shockwave.ogg`

- **Title:** Shockwave.mp3
- **Author:** TristanLuigi
- **Source:** https://freesound.org/people/TristanLuigi/sounds/110819/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Original upload is MP3; this is Freesound's
  site-generated Ogg Vorbis preview (mono, 11.025 kHz source, 1.408 s).
- **Note:** Low source sample rate — muffled by design ("the shockwave following a bomb
  hitting you"), but it is the lowest-fidelity file in this set.

---

# Energy & sci-fi FX

## `emp-blast.ogg`

- **Title:** EMP Blast.wav
- **Author:** 2887679652
- **Source:** https://freesound.org/people/2887679652/sounds/110564/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 3.027 s).

## `emp-grenade.ogg`

- **Title:** Ion Cannon
- **Author:** qubodup
- **Source:** https://freesound.org/people/qubodup/sounds/814049/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 6.462 s).
- **Note:** Stand-in — an energy discharge, not a purpose-made EMP grenade. See
  `import-staging/SOUND-REPLACEMENTS.md`.

## `fx-electricity.ogg`

- **Title:** Electricity Sound
- **Author:** NachtmahrTV
- **Source:** https://freesound.org/people/NachtmahrTV/sounds/556717/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 2.671 s).

## `fx-flamethrower.ogg`

- **Title:** Blast + Flamethrower cooldown
- **Author:** Breviceps
- **Source:** https://freesound.org/people/Breviceps/sounds/447941/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 1.923 s).

## `fx-scifi-whoosh.ogg`

- **Title:** robowhoosh electrobass 4
- **Author:** Logicogonist
- **Source:** https://freesound.org/people/Logicogonist/sounds/807444/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 0.541 s).

## `fx-scifi-spell-1.ogg`

- **Title:** Creation Magic Blast
- **Author:** qubodup
- **Source:** https://freesound.org/people/qubodup/sounds/814044/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 7.200 s).

## `fx-scifi-spell-2.ogg`

- **Title:** Magical Mirror Blast
- **Author:** qubodup
- **Source:** https://freesound.org/people/qubodup/sounds/814051/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 8.308 s).

---

# Additional firearms

## `shot-vhp.ogg`

- **Title:** 357 Magnum Revolver Gunshot
- **Author:** Shark_Anthony
- **Source:** https://freesound.org/people/Shark_Anthony/sounds/683186/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 0.902 s).
- **Note:** Fills the "very heavy pistol" slot — a large-calibre revolver report.

## `shot-paintball.ogg`

- **Title:** paintball_shoot1.wav
- **Author:** fabianofa
- **Source:** https://freesound.org/people/fabianofa/sounds/98189/
- **License:** CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/
- **Modifications:** Renamed only. Freesound's site-generated Ogg Vorbis preview
  (stereo, 44.1 kHz, 0.469 s).
- **Note:** This is the original Freesound upload that the reference set's
  `paintball_shoot1-91934` was mirrored from.

---

# Pixabay-sourced alternates

The two files below are the **only** files in this directory that are not CC0 or CC BY.
They come from Pixabay under the **Pixabay Content License**, which permits commercial and
non-commercial use inside a larger work without attribution, but prohibits redistributing
the file on a *standalone* basis. Shipping them as assets consumed by this module is a
larger-work use and is permitted; extracting and re-publishing them on their own is not.

Both are mirrors of the reference set's original files, uploaded to Pixabay by the bulk
`freesound_community` account. That account does not record which upstream Freesound sound
each file came from, so the original uploader could not be identified and the upstream CC0
status could not be independently confirmed — the license below is the one asserted by the
hosting page, which is the only license claim available for these files.

They are provided as **A/B alternates only**. The primary files for these slots
(`auto-burst.ogg`, `auto-loop.ogg`) are fully-verified CC0 and are also higher fidelity
(44.1–48 kHz vs. 24 kHz here). If a fully CC0/CC-BY sound directory is preferred, these two
files can be deleted with no loss of slot coverage.

## `auto-burst-alt.mp3`

- **Title:** BurstFire.wav
- **Author:** Credited on Pixabay only as `freesound_community` (bulk mirror account)
- **Source:** https://pixabay.com/sound-effects/burstfirewav-14443/
- **License:** Pixabay Content License — https://pixabay.com/service/license-summary/
- **Modifications:** Renamed only. Pixabay's served MP3 (MPEG-2 Layer III, 160 kbps,
  24 kHz, joint stereo, ~3.86 s).

## `auto-loop-alt.mp3`

- **Title:** MachineGunloop.wav
- **Author:** Credited on Pixabay only as `freesound_community` (bulk mirror account)
- **Source:** https://pixabay.com/sound-effects/machinegunloopwav-14862/
- **License:** Pixabay Content License — https://pixabay.com/service/license-summary/
- **Modifications:** Renamed only. Pixabay's served MP3 (MPEG-2 Layer III, 160 kbps,
  24 kHz, joint stereo, ~9.17 s).
