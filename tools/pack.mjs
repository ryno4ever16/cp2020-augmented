/**
 * Compile JSON source (src/packs/) back into the LevelDB pack directories Foundry loads.
 * Inverse of tools/unpack.mjs. The compiled packs/** stay gitignored; src/packs/ is the tracked source.
 *
 * Usage: `npm run pack` (all) or `node tools/pack.mjs vehicle-weapons acpa-systems` (only named packs).
 */
import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { readdirSync, statSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const SRC = "src/packs";
const PACKS = "packs";
const only = process.argv.slice(2);

if (!existsSync(PACKS)) mkdirSync(PACKS, { recursive: true });

// Strip any legacy NeDB ".db" FILES before building. Foundry probes "<pack>.db" on load and, if it finds
// one, runs a NeDB->LevelDB migration that must WRITE into the package folder — which fails on fresh,
// read-only/locked-down installs and leaves compendiums blank. The LevelDB pack DIRECTORIES are the real
// data; these .db files are stale cruft that must never ship. (Runs every build, even for named runs.)
let purged = 0;
for (const f of readdirSync(PACKS)) {
  if (!f.endsWith(".db")) continue;
  const fp = path.join(PACKS, f);
  try { if (statSync(fp).isFile()) { unlinkSync(fp); purged++; } } catch { /* gone */ }
}
if (purged) console.log(`purged ${purged} stale legacy .db file(s) from ${PACKS}/ (Foundry NeDB-migration footgun)`);

let n = 0;
for (const name of readdirSync(SRC)) {
  if (only.length && !only.includes(name)) continue;
  const src = path.join(SRC, name);
  let s; try { s = statSync(src); } catch { continue; }
  if (!s.isDirectory()) continue;
  const dest = path.join(PACKS, name);
  await compilePack(src, dest, { yaml: false, log: false });
  console.log(`packed ${name} -> ${dest}`);
  n++;
}
console.log(`done — ${n} pack(s) compiled`);
