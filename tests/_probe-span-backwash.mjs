/**
 * ONE-OFF PROBE (delete after use) — how far BEHIND the shooter's anchor each class's span draw puts
 * ink, in WORLD pixels, per distance band, on the installed tier.
 *
 * The file-space decode (scratchpad decode_backwash.py) says how many px of ink each band cut carries
 * behind the ranged template's 200px start anchor. What a viewer sees is that number scaled by whatever
 * the engine sizes the sprite to, so this reads the ENGINE'S OWN sprite width for a real queued draw and
 * reports the product. Run: node tests/_probe-span-backwash.mjs
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("  PAGEERROR:", e.message));

await page.goto(`${URL}/join`);
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const sel = document.querySelector('select[name="userid"]');
  sel.value = [...sel.options].find((o) => /gamemaster/i.test(o.textContent)).value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 60000 });
await page.evaluate(async () => {
  const scene = game.scenes.getName("Review · Dark Range") ?? game.scenes.active ?? game.scenes.contents[0];
  if (scene && canvas.scene?.id !== scene.id) await scene.view();
  globalThis.__P_SCENE = scene?.id ?? null;
});
await page.waitForFunction(() => window.canvas?.ready === true, null, { timeout: 60000 });

const out = await page.evaluate(async () => {
  const SCOPE = "cp2020-augmented";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fx = await import(`/modules/${SCOPE}/module/fx/effects.js`);
  const scene = game.scenes.get(globalThis.__P_SCENE) ?? game.scenes.active;
  const gridPx = Number(canvas.dimensions.size) || 100;

  // The file-space backwash decoded off the installed tier (leftmost lit column vs the 200px anchor).
  const FILE_BACKWASH = {
    "jb2a.bullet.01.orange": { "05ft": 114, "15ft": 39, "30ft": 39, "60ft": 39, "90ft": 39 },
    "jb2a.bullet.02.orange": { "05ft": 136, "15ft": 4, "30ft": 0, "60ft": 0, "90ft": 0 },
  };
  const FILE_WIDTH = { "05ft": 600, "15ft": 1000, "30ft": 1600, "60ft": 2800, "90ft": 4000 };

  for (const t of [...(scene?.tokens ?? [])].filter((t) => t.name?.startsWith("__PROBE__"))) await t.delete();
  for (const a of [...game.actors].filter((a) => a.name?.startsWith("__PROBE__"))) await a.delete();
  const actor = await Actor.create({ name: "__PROBE__span", type: "character" });
  const [shooter] = await scene.createEmbeddedDocuments("Token", [{
    name: "__PROBE__shooter", actorId: actor.id, actorLink: true,
    x: 5 * gridPx, y: 5 * gridPx, width: 1, height: 1,
  }]);

  const rows = [];
  const CASES = [
    { cls: "pistol", ammo: null }, { cls: "smg", ammo: null }, { cls: "rifle", ammo: null },
    { cls: "heavy", ammo: null }, { cls: "shotgun", ammo: null }, { cls: "shotgun", ammo: "slug" },
    { cls: "shotgun", ammo: "flechette" }, { cls: "shotgun", ammo: "rubber" },
  ];
  const DISTS = [1, 3, 6, 12, 18];
  const from = { x: shooter.x + gridPx / 2, y: shooter.y + gridPx / 2 };

  for (const c of CASES) {
    const entry = fx.ammoFxEntry(c.cls, c.ammo);
    for (const d of DISTS) {
      globalThis.Sequencer?.EffectManager?.endAllEffects?.();
      await sleep(120);
      const to = { x: from.x + d * gridPx, y: from.y };
      const r = await fx.fxShot(shooter, null, {
        weaponClass: c.cls, hit: true, light: false, ammoKey: c.ammo, aimPoint: to,
      });
      await sleep(260);
      const live = (globalThis.Sequencer?.EffectManager?.effects ?? []);
      // The SPAN sprite: the one whose source file is a bullet family cut.
      let span = null;
      for (const e of live) {
        const f = String(e?.data?.file ?? e?.data?.src ?? e?._file ?? "");
        if (/Bullet_0\d_Regular/i.test(f)) { span = { e, f }; break; }
      }
      const band = fx.tracerBandFor(d);
      const drawnKey = fx.tracerSpanKey(entry.tracer, d);
      const servedBand = span ? (span.f.match(/_(\d+ft)_/)?.[1] ?? "?") : "?";
      const spriteW = Number(span?.e?.sprite?.width) || Number(span?.e?.data?.scale?.x) * 0 || 0;
      const fileW = FILE_WIDTH[servedBand] ?? 0;
      const fileBack = FILE_BACKWASH[entry.tracer]?.[servedBand];
      const worldBack = (fileW > 0 && spriteW > 0 && fileBack !== undefined)
        ? Number((fileBack * (spriteW / fileW)).toFixed(1)) : null;
      rows.push({
        cls: c.cls, ammo: c.ammo ?? "-", d, shape: entry.dashSquares > 0 ? "dash" : "paint",
        tracer: entry.tracer, ourBand: band, drawnKey, servedBand,
        spriteW: Math.round(spriteW), worldBack, drewSpan: !!span, tracerOk: r.tracer,
      });
      globalThis.Sequencer?.EffectManager?.endAllEffects?.();
      await sleep(80);
    }
  }

  await shooter.delete().catch(() => {});
  await actor.delete().catch(() => {});
  return { gridPx, gridDistance: scene.grid?.distance, gridUnits: scene.grid?.units, rows };
});

console.log(`grid ${out.gridPx}px = ${out.gridDistance}${out.gridUnits}`);
console.log("cls      ammo       d  shape  ourBand servedBand drawnKey                              spriteW  worldBackPx");
for (const r of out.rows) {
  console.log(
    `${r.cls.padEnd(8)} ${String(r.ammo).padEnd(10)} ${String(r.d).padStart(2)}  ${r.shape.padEnd(5)}  ${r.ourBand.padEnd(6)}  ${r.servedBand.padEnd(9)}  ${String(r.drawnKey).padEnd(36)} ${String(r.spriteW).padStart(6)}  ${r.worldBack === null ? (r.drewSpan ? "?" : "(no span)") : r.worldBack}`
  );
}
await browser.close();
