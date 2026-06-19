# Russian (`ru`) translation status — Cyberpunk 2020: Augmented Edition

`lang/ru.json` is a **machine-generated SEED, not a complete or reviewed translation.** It needs a
native Russian speaker to finish and check it.

## What was done (mechanical, safe)
- **Exact-string reuse** from the base system's `lang/ru.json` — SuperCoon666's (Tilt's) **native**
  Russian translation (678 keys). For each Augmented key whose **English string is identical** to a
  string Tilt already translated, his Russian was copied **verbatim**.
- Reuse was restricted to **unambiguous** strings only: if Tilt rendered the same English differently
  in different keys (e.g. *Combat* → «Бой» *or* «Боевая»; *Melee* → «Ближний бой» *or* «Ближнебойное»),
  it was **skipped** and left for a native speaker, because the right form is context-dependent.
- Every reused entry passed a **placeholder-integrity** check (the `{tokens}` in the Russian match the
  English).

## Coverage
- **98 / 1070** keys seeded by reuse (verbatim, placeholder-verified).
- **972** keys still need native translation.
- Foundry falls back to English per missing key, so the UI is never broken — untranslated keys just
  show English.

## For the translator
- **Conventions source:** the base system's `lang/ru.json` (Tilt's 678 keys) is the authoritative
  terminology/house-style reference — follow it.
- **Untranslated keys** = every key in `lang/en.json` not present in `lang/ru.json`.
- ⚠ A reused string is correct for that exact string, but a short label reused in a new grammatical
  slot may need a different inflected form (Russian case/gender/number/aspect). Review the seed, don't
  assume it's final.
- The Augmented module's net-new features (vehicles / Maximum Metal, shop, IP, combat automation) are
  the bulk of the untranslated surface — Tilt has never seen these, so there is no upstream Russian for
  them yet. Faithful translation of these is the real work this seed cannot do.
