import type { Message, Space } from "spectrum-ts";
import type { AiClient, AiResponse, AiSchedule } from "./ai";
import {
  applyProductDecision,
  clearSilenceOnInbound,
  scheduleMorningPlan,
} from "./brain";
import type { BotConfig } from "./config";
import { charityContext, schoolContext, trajectoryContext } from "./context";
import type { Scheduler } from "./scheduler";
import { messages } from "./style";
import { dateKey } from "./time";
import type { AttachmentRecord, BotStore, MessageRecord, SpaceSnapshot } from "./store";

export type HandlerContext = {
  ai: AiClient;
  config: Pick<
    BotConfig,
    | "charityDonateUrl"
    | "charityMonthlyCapDollars"
    | "charityName"
    | "botTimezone"
    | "morningJitterMaxMinutes"
    | "morningJitterMinMinutes"
    | "morningNoonAnnoyanceIntervalMinutes"
    | "morningTargetHour"
    | "schoolDays"
    | "schoolEndHour"
    | "schoolStartHour"
    | "silenceFollowupAfterHour"
    | "silenceFollowupDelayMinutes"
    | "testPokeDelaySeconds"
  >;
  scheduler: Scheduler;
  space: TypingSpace;
  message: Message;
  store: BotStore;
};

type TypingSpace = Space & {
  responding?: <T>(fn: () => Promise<T>) => Promise<T>;
  startTyping?: () => Promise<void>;
  stopTyping?: () => Promise<void>;
};

export async function handleInbound(ctx: HandlerContext) {
  const now = new Date();
  const snapshot = snapshotSpace(ctx.space);
  const { space: storedSpace } = ctx.store.upsertSpace(snapshot, now);

  ctx.store.saveMessage(toMessageRecord(ctx.message, snapshot.id));
  const attachment = saveAttachmentIfPresent(ctx.store, ctx.message, snapshot.id);
  clearSilenceOnInbound(ctx.store, snapshot.id);
    scheduleMorningPlan({
      config: ctx.config,
      now,
      scheduler: ctx.scheduler,
      spaceId: snapshot.id,
      store: ctx.store,
    });

  if (ctx.message.content.type === "attachment") {
    await runAiTurn(ctx, storedSpace.id, attachment, now);
    return;
  }

  if (ctx.message.content.type !== "text") {
    await runAiTurn(ctx, storedSpace.id, attachment, now);
    return;
  }

  const command = normalizeCommand(ctx.message.content.text);

  if (command === "start") {
    ctx.store.setSpaceEnabled(snapshot.id, true);
    await ctx.space.send(messages.started());
    return;
  }

  if (command === "stop") {
    ctx.store.setSpaceEnabled(snapshot.id, false);
    ctx.scheduler.cancelForSpace(snapshot.id);
    await ctx.space.send(messages.stopped());
    return;
  }

  if (command === "status") {
    const stats = ctx.store.getSpaceStats(snapshot.id);
    const nextJob = ctx.store.getNextPendingJob(snapshot.id);
    await ctx.space.send(
      messages.status({
        enabled: storedSpace.enabled,
        inboundCount: stats.inboundCount,
        attachmentCount: stats.attachmentCount,
        nextJobDueAt: nextJob?.dueAt,
      }),
    );
    return;
  }

  if (command === "test poke") {
    const dueAt = new Date(now.getTime() + ctx.config.testPokeDelaySeconds * 1000);
    ctx.scheduler.schedule({
      spaceId: snapshot.id,
      kind: "test_poke",
      body: messages.testPokeBody(),
      dueAt,
      now,
    });
    await ctx.space.send(messages.testPokeScheduled(ctx.config.testPokeDelaySeconds));
    return;
  }

  await runAiTurn(ctx, storedSpace.id, attachment, now);
}

export function snapshotSpace(space: Space): SpaceSnapshot {
  const maybeIMessageSpace = space as Space & { type?: string; phone?: string };
  return {
    id: space.id,
    platform: space.__platform,
    kind: maybeIMessageSpace.type,
    phone: maybeIMessageSpace.phone,
  };
}

function toMessageRecord(message: Message, spaceId: string): MessageRecord {
  return {
    id: message.id,
    spaceId,
    platform: message.platform,
    direction: message.direction,
    senderId: message.sender?.id,
    contentType: message.content.type,
    text: message.content.type === "text" ? message.content.text : undefined,
    timestamp: message.timestamp.toISOString(),
    rawJson: safeJson({
      contentType: message.content.type,
      sender: message.sender?.id,
      platform: message.platform,
    }),
  };
}

async function runAiTurn(
  ctx: HandlerContext,
  spaceId: string,
  attachment: AttachmentRecord | undefined,
  now: Date,
) {
  const space = ctx.store.getSpace(spaceId);
  if (!space?.enabled) {
    return;
  }

  await withTypingIndicator(ctx.space, async () => {
    const response = await ctx.ai.respond({
      activeCommitment: ctx.store.getActiveCommitment(spaceId),
      attachment,
      charityContext: charityContext(ctx.config, ctx.store, space, now),
      declarationContext: declarationContext(ctx.store, spaceId, now, ctx.config.botTimezone),
      history: ctx.store.listRecentMessages(spaceId, { since: new Date(now.getTime() - 24 * 60 * 60_000), limit: 30 }),
      message: ctx.message,
      now,
      schoolContext: schoolContext(ctx.config, now),
      space,
      stats: ctx.store.getSpaceStats(spaceId),
      trajectoryContext: trajectoryContext(ctx.store, spaceId),
    });

    await applyAiResponse(ctx, response, spaceId, now);
  });
}

function declarationContext(store: BotStore, spaceId: string, now: Date, timeZone: string) {
  const date = dateKey(now, timeZone);
  return {
    date,
    excuse_until: store.getDayExcuse(spaceId, date),
    specificity_nudge_used: store.hasSpecificityNudge(spaceId, date),
  };
}

async function withTypingIndicator<T>(space: TypingSpace, fn: () => Promise<T>): Promise<T> {
  if (typeof space.responding === "function") {
    return space.responding(fn);
  }

  if (typeof space.startTyping !== "function" || typeof space.stopTyping !== "function") {
    return fn();
  }

  await space.startTyping();
  try {
    return await fn();
  } finally {
    await space.stopTyping();
  }
}

export async function applyAiResponse(
  ctx: Pick<HandlerContext, "config" | "message" | "scheduler" | "space" | "store">,
  response: AiResponse,
  spaceId: string,
  now = new Date(),
) {
  if (typeof response.enabled === "boolean") {
    ctx.store.setSpaceEnabled(spaceId, response.enabled);
    if (!response.enabled) {
      ctx.scheduler.cancelForSpace(spaceId);
    }
  }

  if (response.cancel_pending_check_ins) {
    ctx.scheduler.cancelForSpace(spaceId);
  }

  if (response.decision?.penalty_paid) {
    ctx.store.markPendingPenaltyPaid(spaceId, now);
    ctx.store.cancelPendingJobsForSpaceByKindPrefix(spaceId, "penalty_followup:");
  }

  if (response.decision) {
    ctx.store.saveModelDecision({
      messageId: ctx.message.id,
      spaceId,
      rawJson: JSON.stringify(response.decision),
      rung: response.decision.rung,
      verify: response.decision.verify,
      checkInAt: response.decision.check_in_at,
      startedAt: response.decision.started_at,
      deadline: response.decision.deadline,
      nextCheckinAt: response.decision.next_checkin_at,
      task: response.decision.task,
      note: response.decision.note,
      createdAt: now.toISOString(),
    });
  }

  applyProductDecision({
    config: ctx.config,
    now,
    response,
    scheduler: ctx.scheduler,
    spaceId,
    store: ctx.store,
  });

  for (const schedule of response.schedules) {
    if (response.decision?.task && isCheckInSchedule(schedule)) {
      continue;
    }

    const dueAt = scheduleDueAt(schedule, now);
    if (!dueAt) {
      continue;
    }

    ctx.scheduler.schedule({
      spaceId,
      kind: schedule.kind ?? "ai_check_in",
      body: schedule.message || "check in\nwhat moved",
      dueAt,
      now,
    });
  }

  for (const reaction of response.reactions) {
    try {
      await ctx.message.react(reaction.emoji);
    } catch (error) {
      console.warn("[bot] failed to send reaction", error);
    }
  }

  let index = 0;
  for (const message of response.messages) {
    await ctx.space.send(message);
    ctx.store.saveMessage({
      id: `${ctx.message.id}:out:${index}`,
      spaceId,
      platform: ctx.message.platform,
      direction: "outbound",
      contentType: "text",
      text: message,
      timestamp: new Date().toISOString(),
    });
    index += 1;
  }
}

function isCheckInSchedule(schedule: AiSchedule): boolean {
  return !schedule.kind || schedule.kind.includes("check");
}

function scheduleDueAt(schedule: AiSchedule, now: Date): Date | undefined {
  if (schedule.due_at) {
    const dueAt = new Date(schedule.due_at);
    if (!Number.isNaN(dueAt.getTime())) {
      return dueAt;
    }
  }

  if (schedule.delay_minutes && schedule.delay_minutes > 0) {
    return new Date(now.getTime() + schedule.delay_minutes * 60_000);
  }

  return undefined;
}

function saveAttachmentIfPresent(
  store: BotStore,
  message: Message,
  spaceId: string,
): AttachmentRecord | undefined {
  if (message.content.type !== "attachment") {
    return undefined;
  }

  const attachment: AttachmentRecord = {
    id: message.content.id,
    messageId: message.id,
    spaceId,
    name: message.content.name,
    mimeType: message.content.mimeType,
    size: message.content.size,
    readable: typeof message.content.read === "function",
    timestamp: message.timestamp.toISOString(),
  };

  store.saveAttachment(attachment);
  return attachment;
}

function normalizeCommand(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
