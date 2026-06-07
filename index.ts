import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { AiClient } from "./src/ai";
import { afterScheduledJobSent, scheduleMorningPlan } from "./src/brain";
import { loadConfig } from "./src/config";
import { charityContext, schoolContext, trajectoryContext } from "./src/context";
import { handleInbound } from "./src/handler";
import { Scheduler } from "./src/scheduler";
import { BotStore, type ScheduledJob, type StoredSpace } from "./src/store";
import { dateKey } from "./src/time";
import type { Message, Space } from "spectrum-ts";

const config = loadConfig();
const store = new BotStore(config.dbPath);
const ai = new AiClient(config);
const spaces = new Map<string, Space>();

const app = await Spectrum({
  projectId: config.projectId,
  projectSecret: config.projectSecret,
  providers: [imessage.config()],
  options: { flattenGroups: true },
});

const iMessage = imessage(app);

const scheduler = new Scheduler(store, async (job) => {
  const storedSpace = store.getSpace(job.spaceId);
  if (!storedSpace?.enabled) {
    return "canceled";
  }

  const space = await getLiveSpace(storedSpace);
  if (!space) {
    console.warn(`[scheduler] space ${job.spaceId} is not live yet; deferring ${job.id}`);
    return "defer";
  }

  if (job.kind === "test_poke") {
    await space.send(job.body);
  } else {
    await runScheduledAiJob(job, storedSpace, space);
  }

  afterScheduledJobSent({
    config,
    job,
    now: new Date(),
    scheduler,
    store,
  });
  return "sent";
});

console.log(`[bot] starting with db ${config.dbPath}`);
await hydrateKnownSpaces();
for (const space of store.listEnabledSpaces()) {
  scheduleMorningPlan({
    config,
    scheduler,
    spaceId: space.id,
    store,
  });
}
scheduler.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`[bot] received ${signal}, shutting down`);
    scheduler.stop();
    store.close();
    process.exit(0);
  });
}

for await (const [space, message] of app.messages) {
  spaces.set(space.id, space);
  try {
    await handleInbound({
      ai,
      config,
      scheduler,
      space,
      message,
      store,
    });
  } catch (error) {
    console.error("[bot] failed to handle inbound message", error);
    await space.send("logged\nbut i tripped on the handler\ncheck the terminal");
  }
}

async function runScheduledAiJob(job: ScheduledJob, storedSpace: StoredSpace, space: Space) {
  store.saveMessage({
    id: `job:${job.id}`,
    spaceId: job.spaceId,
    platform: storedSpace.platform,
    direction: "outbound",
    contentType: "scheduled_event",
    text: job.kind,
    timestamp: new Date().toISOString(),
    rawJson: job.payloadJson,
  });

  const now = new Date();
  const today = dateKey(now, config.botTimezone);
  const response = await ai.respondToScheduled({
    activeCommitment: store.getActiveCommitment(job.spaceId),
    charityContext: charityContext(config, store, storedSpace, now),
    declarationContext: {
      date: today,
      excuse_until: store.getDayExcuse(job.spaceId, today),
      specificity_nudge_used: store.hasSpecificityNudge(job.spaceId, today),
    },
    history: store.listRecentMessages(job.spaceId, { since: new Date(now.getTime() - 24 * 60 * 60_000), limit: 30 }),
    job,
    now,
    schoolContext: schoolContext(config, now),
    space: storedSpace,
    stats: store.getSpaceStats(job.spaceId),
    trajectoryContext: trajectoryContext(store, job.spaceId),
  });

  const { applyAiResponse } = await import("./src/handler");
  await applyAiResponse(
    {
      config,
      message: syntheticMessage(job, storedSpace, space),
      scheduler,
      space,
      store,
    },
    response.messages.length > 0 ? response : { ...response, messages: [job.body] },
    job.spaceId,
    new Date(),
  );
}

function syntheticMessage(job: ScheduledJob, storedSpace: StoredSpace, space: Space): Message {
  return {
    content: { type: "text", text: job.kind },
    direction: "outbound",
    edit: async () => {},
    id: `job:${job.id}`,
    platform: storedSpace.platform,
    react: async () => {},
    reply: async (content: string) => space.send(content),
    sender: undefined,
    space,
    timestamp: new Date(),
  } as unknown as Message;
}

async function hydrateKnownSpaces() {
  for (const storedSpace of store.listEnabledSpaces()) {
    const space = await reconstructSpace(storedSpace);
    if (space) {
      spaces.set(storedSpace.id, space);
    }
  }
}

async function getLiveSpace(storedSpace: StoredSpace): Promise<Space | undefined> {
  const existing = spaces.get(storedSpace.id);
  if (existing) {
    return existing;
  }

  const reconstructed = await reconstructSpace(storedSpace);
  if (reconstructed) {
    spaces.set(storedSpace.id, reconstructed);
  }
  return reconstructed;
}

async function reconstructSpace(storedSpace: StoredSpace): Promise<Space | undefined> {
  const address = dmAddressFromSpaceId(storedSpace.id);
  if (!address) {
    console.warn(`[bot] cannot reconstruct non-dm space ${storedSpace.id}`);
    return undefined;
  }

  try {
    const args = storedSpace.phone ? [address, { phone: storedSpace.phone }] : [address];
    return await (iMessage as any).space(...args);
  } catch (error) {
    console.warn(`[bot] failed to reconstruct space ${storedSpace.id}`, error);
    return undefined;
  }
}

function dmAddressFromSpaceId(spaceId: string): string | undefined {
  return spaceId.startsWith("any;-;") ? spaceId.slice("any;-;".length) : undefined;
}
