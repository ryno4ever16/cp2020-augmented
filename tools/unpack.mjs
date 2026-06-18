/**
 * Extract compiled LevelDB compendium packs to reviewable JSON source under src/packs/.
 *
 * Source of truth = the LevelDB pack DIRECTORIES in packs/ (the data Foundry loads / the release
 * ships). Any stale `*.db` NeDB single-files in packs/ are leftovers and are ignored here.
 *
 * Only packs REGISTERED in module.json are extracted. Orphan LevelDB dirs that exist on disk but
 * aren't declared are skipped so they don't get re-tracked. Pass an explicit name to override.
 *
 * Workflow: edit in Foundry (writes LevelDB) -> `npm run unpack` -> commit the src/packs/ diff.
 * Round-trip: `npm run pack` rebuilds the LevelDB from src/packs/ (compiled packs/** stay gitignored).
 *
 * Usage: `npm run unpack` (all registered) or `node tools/unpack.mjs vehicle-weapons` (only named).
 */
import { extractPack } from "@foundryvtt/foundryvtt-cli";
import { existsSync, readdirSync, statSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const PACKS = "packs";
const SRC = "src/packs";
const only = process.argv.slice(2);

// Pack names declared in module.json (the compendia Foundry actually loads).
const registered = new Set(
  (JSON.parse(readFileSync("module.json", "utf8")).packs ?? []).map((p) => p.name.toLowerCase())
);

/** A LevelDB pack dir = a directory with a CURRENT manifest pointer that is registered in module.json. */
const levelDbPacks = readdirSync(PACKS).filter((name) => {
  const dir = path.join(PACKS, name);
  let s; try { s = statSync(dir); } catch { return false; }
  if (!(s.isDirectory() && existsSync(path.join(dir, "CURRENT")))) return false;
  return registered.has(name.toLowerCase()) || only.includes(name);
});

let n = 0;
for (const name of levelDbPacks) {
  if (only.length && !only.includes(name)) continue;
  const src = path.join(PACKS, name);
  const dest = path.join(SRC, name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  try {
    await extractPack(src, dest, { yaml: false, jsonOptions: { space: 2 }, log: false });
    console.log(`unpacked ${name} -> ${dest}`);
    n++;
  } catch (e) {
    console.error(`FAILED ${name}: ${e.message} (is a local Foundry world holding the pack LOCK?)`);
  }
}
console.log(`done — ${n} pack(s) extracted`);
