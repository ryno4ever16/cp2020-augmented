/**
 * PERF PROBE (not a keeper): rig-state driver + in-page microbenchmarks.
 *
 * Subcommands (argv[2]):
 *   count                    -> report world doc counts
 *   seed <n>                 -> create <n> __PERF__ character actors (batched)
 *   module <on|off>          -> flip cp2020-augmented in core.moduleConfiguration
 *   micro                    -> per-actor prepareData/reset microbench (module state as-is)
 *   chatseed <n>             -> create <n> __PERF__ chat messages (half with damagePayload flag)
 *   chatbench                -> measure ui.chat.render(true)
 *   cleanup                  -> delete ALL __PERF__ actors + messages
 *
 * Run: FVTT_URL=http://localhost:30004 FVTT_RIG_PASSWORD=cp2020-v14-rig node <this file> <cmd> [arg]
 */
import { chromium } from "@playwright/test";

const URL = process.env.FVTT_URL ?? "http://localhost:30004";
const PW = process.env.FVTT_RIG_PASSWORD ?? "cp2020-v14-rig";
const CMD = process.argv[2];
const ARG = process.argv[3];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", e => console.log("PAGEERROR:", e.message));

await page.goto(`${URL}/join`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('select[name="userid"]');
await page.evaluate(() => {
  const sel = document.querySelector('select[name="userid"]');
  sel.value = [...sel.options].find(o => /gamemaster/i.test(o.textContent)).value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.fill('input[name="password"]', PW);
await page.click('button[name="join"]');
await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 300000 });

const PREFIX = "__PERF__";
let out;

switch (CMD) {
  case "count":
    out = await page.evaluate((P) => ({
      actors: game.actors.size,
      perfActors: game.actors.filter(a => a.name?.startsWith(P)).length,
      actorItems: game.actors.reduce((s, a) => s + a.items.size, 0),
      messages: game.messages.size,
      perfMessages: game.messages.filter(m => (m.flags?.["cp2020-perf"] != null) || /__PERF__/.test(m.content ?? "")).length,
      scenes: game.scenes.size,
      worldItems: game.items.size,
      augmentedActive: !!game.modules.get("cp2020-augmented")?.active,
      moduleConfiguration: game.settings.get("core", "moduleConfiguration"),
    }), PREFIX);
    break;

  case "seed": {
    const n = Number(ARG);
    out = await page.evaluate(async ({ P, n }) => {
      const before = game.actors.size;
      const beforeItems = game.actors.reduce((s, a) => s + a.items.size, 0);
      const start = game.actors.filter(a => a.name?.startsWith(P)).length;
      const BATCH = 25;
      const t0 = performance.now();
      for (let i = 0; i < n; i += BATCH) {
        const chunk = [];
        for (let j = i; j < Math.min(i + BATCH, n); j++) {
          chunk.push({ name: `${P}Actor ${String(start + j + 1).padStart(4, "0")}`, type: "character" });
        }
        await Actor.createDocuments(chunk);
      }
      const dt = performance.now() - t0;
      const after = game.actors.size;
      const afterItems = game.actors.reduce((s, a) => s + a.items.size, 0);
      const sample = game.actors.find(a => a.name?.startsWith(P));
      const sampleTypes = {};
      if (sample) for (const it of sample.items) sampleTypes[it.type] = (sampleTypes[it.type] ?? 0) + 1;
      return {
        created: after - before, actorsNow: after,
        itemsAdded: afterItems - beforeItems,
        itemsPerSeededActor: sample ? sample.items.size : null,
        sampleItemTypes: sampleTypes,
        actorItemsTotal: afterItems,
        createMs: Math.round(dt),
      };
    }, { P: PREFIX, n });
    break;
  }

  case "module": {
    const on = ARG === "on";
    out = await page.evaluate(async (on) => {
      const cfg = foundry.utils.duplicate(game.settings.get("core", "moduleConfiguration"));
      cfg["cp2020-augmented"] = on;
      await game.settings.set("core", "moduleConfiguration", cfg);
      return { set: on, cfg: game.settings.get("core", "moduleConfiguration") };
    }, on);
    break;
  }

  case "micro": {
    out = await page.evaluate(() => {
      const modOn = !!game.modules.get("cp2020-augmented")?.active;
      const actors = game.actors.contents;
      const bench = (fn, label) => {
        // one untimed warm pass, then 3 timed passes
        fn();
        const samples = [];
        for (let k = 0; k < 3; k++) {
          const t0 = performance.now();
          fn();
          samples.push(performance.now() - t0);
        }
        samples.sort((a, b) => a - b);
        return { label, samples: samples.map(x => Math.round(x * 100) / 100), medianMs: Math.round(samples[1] * 100) / 100 };
      };
      const resetAll = () => { for (const a of actors) a.reset(); };
      const resetPrepAll = () => { for (const a of actors) { a.reset(); a.prepareData(); } };
      const prepOnlyAll = () => { for (const a of actors) a.prepareData(); };

      // per-type slice: only characters/npcs go through the module's prepareData wraps
      const chars = actors.filter(a => a.type === "character" || a.type === "npc");
      const resetPrepChars = () => { for (const a of chars) { a.reset(); a.prepareData(); } };

      const r1 = bench(resetAll, "reset() only, all actors");
      const r2 = bench(resetPrepAll, "reset()+prepareData(), all actors");
      const r3 = bench(prepOnlyAll, "prepareData() only, all actors");
      const r4 = bench(resetPrepChars, "reset()+prepareData(), character/npc only");

      return {
        moduleActive: modOn,
        actorCount: actors.length,
        charNpcCount: chars.length,
        actorItemsTotal: actors.reduce((s, a) => s + a.items.size, 0),
        benches: [r1, r2, r3, r4].map(b => ({
          ...b,
          perActorMs: Math.round((b.medianMs / (b.label.includes("character/npc") ? chars.length : actors.length)) * 1000) / 1000,
        })),
      };
    });
    break;
  }

  case "chatseed": {
    const n = Number(ARG ?? 100);
    out = await page.evaluate(async ({ n }) => {
      const before = game.messages.size;
      const docs = [];
      for (let i = 0; i < n; i++) {
        const withFlag = i % 2 === 1;
        const d = {
          content: `<p>__PERF__ perf probe message ${i}</p>`,
          flags: { "cp2020-perf": { probe: true } },
        };
        if (withFlag) {
          d.flags["cp2020-augmented"] = {
            damagePayload: {
              areaDamages: { torso: 8, rArm: 3, head: 2 },
              attackerId: game.actors.contents[0]?.id ?? null,
              weaponName: "__PERF__ Probe Gun",
              damageType: "normal",
            },
          };
        }
        docs.push(d);
      }
      const BATCH = 25;
      for (let i = 0; i < docs.length; i += BATCH) {
        await ChatMessage.createDocuments(docs.slice(i, i + BATCH));
      }
      return { created: game.messages.size - before, messagesNow: game.messages.size };
    }, { n });
    break;
  }

  case "chatbench": {
    out = await page.evaluate(async () => {
      const modOn = !!game.modules.get("cp2020-augmented")?.active;

      // --- A: full sidebar chat-log re-render (core batch path; v14 does NOT fire
      //        renderChatMessageHTML for batch scrollback, so this measures core + any
      //        module hooks on the ChatLog application itself).
      const aSamples = [];
      for (let k = 0; k < 4; k++) {
        const t0 = performance.now();
        await ui.chat.render(true);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        aSamples.push(performance.now() - t0);
      }
      const aWarm = aSamples.slice(1).sort((x, y) => x - y);

      // --- B: per-message renderHTML() over the probe set. THIS is the path that fires
      //        renderChatMessageHTML, i.e. what a newly-posted message costs.
      const probes = game.messages.filter(m => m.flags?.["cp2020-perf"]);
      const withPayload = probes.filter(m => m.flags?.["cp2020-augmented"]?.damagePayload);
      const plain = probes.filter(m => !m.flags?.["cp2020-augmented"]?.damagePayload);
      const benchRender = async (set) => {
        for (const m of set) await m.renderHTML();          // warm
        const s = [];
        for (let k = 0; k < 3; k++) {
          const t0 = performance.now();
          for (const m of set) await m.renderHTML();
          s.push(performance.now() - t0);
        }
        s.sort((x, y) => x - y);
        return { n: set.length, medianMs: Math.round(s[1] * 100) / 100, perMsgMs: Math.round((s[1] / Math.max(set.length, 1)) * 1000) / 1000, samples: s.map(x => Math.round(x * 100) / 100) };
      };
      const bPayload = await benchRender(withPayload);
      const bPlain = await benchRender(plain);

      // confirm the injector actually engages on this path
      let btnOnPayloadRender = 0;
      if (withPayload[0]) btnOnPayloadRender = (await withPayload[0].renderHTML()).querySelectorAll(".cp2020-apply-damage-btn").length;

      return {
        moduleActive: modOn,
        totalMessages: game.messages.size,
        probeMessages: probes.length,
        payloadMessages: withPayload.length,
        renderedMessagesInDom: document.querySelectorAll("[data-message-id]").length,
        applyDamageButtonsInDom: document.querySelectorAll(".cp2020-apply-damage-btn").length,
        injectorEngagesOnRenderHTML: btnOnPayloadRender,
        A_chatLogRender: { allSamplesMs: aSamples.map(x => Math.round(x * 100) / 100), warmMedianMs: Math.round(aWarm[Math.floor(aWarm.length / 2)] * 100) / 100 },
        B_renderHTML_payloadMsgs: bPayload,
        B_renderHTML_plainMsgs: bPlain,
      };
    });
    break;
  }

  case "trim": {
    const n = Number(ARG);
    out = await page.evaluate(async ({ P, n }) => {
      const perf = game.actors.filter(a => a.name?.startsWith(P)).sort((a, b) => a.name.localeCompare(b.name));
      const ids = perf.slice(-n).map(a => a.id);   // drop the highest-numbered n
      const BATCH = 50;
      for (let i = 0; i < ids.length; i += BATCH) await Actor.deleteDocuments(ids.slice(i, i + BATCH));
      return {
        deleted: ids.length, actorsNow: game.actors.size,
        perfActorsNow: game.actors.filter(a => a.name?.startsWith(P)).length,
        actorItemsNow: game.actors.reduce((s, a) => s + a.items.size, 0),
      };
    }, { P: PREFIX, n });
    break;
  }

  case "cleanup": {
    out = await page.evaluate(async (P) => {
      const actorIds = game.actors.filter(a => a.name?.startsWith(P)).map(a => a.id);
      const msgIds = game.messages.filter(m => m.flags?.["cp2020-perf"] || /__PERF__/.test(m.content ?? "")).map(m => m.id);
      const BATCH = 50;
      for (let i = 0; i < actorIds.length; i += BATCH) await Actor.deleteDocuments(actorIds.slice(i, i + BATCH));
      for (let i = 0; i < msgIds.length; i += BATCH) await ChatMessage.deleteDocuments(msgIds.slice(i, i + BATCH));
      return {
        deletedActors: actorIds.length, deletedMessages: msgIds.length,
        actorsNow: game.actors.size, messagesNow: game.messages.size,
        actorItemsNow: game.actors.reduce((s, a) => s + a.items.size, 0),
        residualPerfActors: game.actors.filter(a => a.name?.startsWith(P)).length,
        residualPerfMessages: game.messages.filter(m => m.flags?.["cp2020-perf"]).length,
      };
    }, PREFIX);
    break;
  }

  default:
    out = { error: `unknown command ${CMD}` };
}

console.log(JSON.stringify(out, null, 2));
await page.waitForTimeout(800); // let socket writes flush
await browser.close();
