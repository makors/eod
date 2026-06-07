import type { Message } from "spectrum-ts";
import type { BotConfig } from "./config";
import { botText } from "./style";
import { localNowDescription, localTimeTag } from "./time";
import type { Commitment, LedgerSummary, MessageRecord, ModelDecisionRecord, Penalty, ScheduledJob, SpaceStats, StoredSpace } from "./store";

export type AiReaction = {
  emoji: string;
};

export type AiSchedule = {
  delay_minutes?: number;
  due_at?: string;
  kind?: string;
  message?: string;
};

export type AiDecision = {
  check_in_at?: string;
  deadline?: string;
  excuse_until?: string;
  ledger_summary?: string;
  next_checkin_at?: string;
  note?: string;
  penalty_amount_dollars?: number;
  penalty_paid?: boolean;
  resolution?: "vague" | "specific";
  rung?: "none" | "rung1_verifiable_picture" | "rung2_photo" | "rung3_probe";
  started_at?: string;
  status?: "none" | "specificity_needed" | "declared" | "progress" | "completed" | "excused" | "failed" | "canceled";
  task?: string;
  verify?: "pass" | "fail" | "needs_more" | "not_applicable";
};

export type AiResponse = {
  cancel_pending_check_ins?: boolean;
  decision?: AiDecision;
  enabled?: boolean;
  messages: string[];
  reactions: AiReaction[];
  schedules: AiSchedule[];
};

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "assistant"; content: string }
  | { role: "user"; content: UserContentPart[] };

// gap between consecutive messages past which we mark a likely new conversation
const HISTORY_GAP_MINUTES = 180;

type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type AttachmentForPrompt = {
  id: string;
  mimeType: string;
  name: string;
  readable: boolean;
  size?: number;
};

type DeclarationContext = {
  date: string;
  excuse_until?: string;
  specificity_nudge_used: boolean;
};

export type TrajectoryContext = {
  failed_count: number;
  recent_commitments: Commitment[];
  recent_decisions: ModelDecisionRecord[];
  rung3_needs_more_count: number;
  summary?: LedgerSummary;
};

export type CharityContext = {
  charity_name: string;
  donate_url?: string;
  monthly_cap_dollars: number;
  monthly_remaining_dollars: number;
  pending_penalty?: Penalty;
};

export type SchoolContext = {
  is_school_day: boolean;
  is_school_time: boolean;
  local_day: number;
  local_hour: number;
};

export type AiTurnInput = {
  activeCommitment?: Commitment;
  attachment?: AttachmentForPrompt;
  charityContext?: CharityContext;
  declarationContext?: DeclarationContext;
  history?: MessageRecord[];
  message: Message;
  now: Date;
  schoolContext?: SchoolContext;
  space: StoredSpace;
  stats: SpaceStats;
  trajectoryContext?: TrajectoryContext;
};

export type ScheduledTurnInput = {
  activeCommitment?: Commitment;
  charityContext?: CharityContext;
  declarationContext?: DeclarationContext;
  history?: MessageRecord[];
  job: ScheduledJob;
  now: Date;
  schoolContext?: SchoolContext;
  space: StoredSpace;
  stats: SpaceStats;
  trajectoryContext?: TrajectoryContext;
};

export class AiClient {
  constructor(private readonly config: Pick<BotConfig,
    "aiApiKey" | "aiBaseUrl" | "aiMaxImageBytes" | "aiModel" | "aiTemperature" | "aiTimeoutMs" | "botTimezone"
  >) {}

  async respond(input: AiTurnInput): Promise<AiResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.aiTimeoutMs);

    try {
      const response = await fetch(`${this.config.aiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.aiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.aiModel,
          messages: await this.buildMessages(input),
          response_format: { type: "json_object" },
          temperature: this.config.aiTemperature,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`ai request failed ${response.status}: ${await response.text()}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      return parseAiResponse(content);
    } finally {
      clearTimeout(timeout);
    }
  }

  async respondToScheduled(input: ScheduledTurnInput): Promise<AiResponse> {
    return this.request(await this.buildScheduledMessages(input));
  }

  private async request(messages: ChatMessage[]): Promise<AiResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.aiTimeoutMs);

    try {
      const response = await fetch(`${this.config.aiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.aiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.aiModel,
          messages,
          response_format: { type: "json_object" },
          temperature: this.config.aiTemperature,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`ai request failed ${response.status}: ${await response.text()}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      return parseAiResponse(content);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async buildMessages(input: AiTurnInput): Promise<ChatMessage[]> {
    return [
      { role: "system", content: systemPrompt(this.config.botTimezone) },
      ...historyTurns(input.history, this.config.botTimezone, { excludeId: input.message.id }),
      { role: "user", content: await this.userContent(input) },
    ];
  }

  private async buildScheduledMessages(input: ScheduledTurnInput): Promise<ChatMessage[]> {
    return [
      { role: "system", content: systemPrompt(this.config.botTimezone) },
      ...historyTurns(input.history, this.config.botTimezone, { excludeId: `job:${input.job.id}` }),
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              event_type: "scheduled_job",
              now: input.now.toISOString(),
              local_now: localNowDescription(input.now, this.config.botTimezone),
              timezone: this.config.botTimezone,
              job: {
                id: input.job.id,
                kind: input.job.kind,
                body: input.job.body,
                due_at: input.job.dueAt,
                created_at: input.job.createdAt,
                payload: parsePayload(input.job.payloadJson),
              },
              space: {
                enabled: input.space.enabled,
                id: input.space.id,
                kind: input.space.kind,
                platform: input.space.platform,
              },
              stats: input.stats,
              active_commitment: input.activeCommitment,
              declaration_context: input.declarationContext,
              school_context: input.schoolContext,
              charity_context: input.charityContext,
              trajectory_context: input.trajectoryContext,
            }),
          },
        ],
      },
    ];
  }

  private async userContent(input: AiTurnInput): Promise<UserContentPart[]> {
    const content: UserContentPart[] = [
      {
        type: "text",
        text: JSON.stringify({
          now: input.now.toISOString(),
          local_now: localNowDescription(input.now, this.config.botTimezone),
          timezone: this.config.botTimezone,
          space: {
            enabled: input.space.enabled,
            first_seen_at: input.space.firstSeenAt,
            id: input.space.id,
            kind: input.space.kind,
            last_seen_at: input.space.lastSeenAt,
            platform: input.space.platform,
          },
          stats: input.stats,
          active_commitment: input.activeCommitment,
          charity_context: input.charityContext,
          declaration_context: input.declarationContext,
          school_context: input.schoolContext,
          trajectory_context: input.trajectoryContext,
          inbound: describeMessage(input.message),
          attachment: input.attachment,
        }),
      },
    ];

    const image = await imagePart(input.message, this.config.aiMaxImageBytes);
    if (image) {
      content.push(image);
    }

    return content;
  }
}

export function parseAiResponse(content: unknown): AiResponse {
  const raw = contentToString(content);
  const parsed = JSON.parse(extractJson(raw)) as unknown;
  const record = isRecord(parsed) ? parsed : {};

  return {
    cancel_pending_check_ins: record.cancel_pending_check_ins === true,
    decision: parseDecision(record.decision),
    enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
    messages: parseMessages(record.messages),
    reactions: parseReactions(record.reactions),
    schedules: parseSchedules(record.schedules),
  };
}

export function historyTurns(
  history: MessageRecord[] | undefined,
  timeZone: string,
  opts: { excludeId?: string } = {},
): ChatMessage[] {
  if (!history || history.length === 0) {
    return [];
  }

  const turns: ChatMessage[] = [];
  let prevTimestamp: number | undefined;

  for (const record of history) {
    if (opts.excludeId && record.id === opts.excludeId) {
      continue;
    }
    // skip internal scheduled-event markers; they are noise, not conversation
    if (record.contentType === "scheduled_event") {
      continue;
    }

    const time = new Date(record.timestamp);
    const stamp = Number.isNaN(time.getTime()) ? undefined : time.getTime();

    let gapNote = "";
    if (prevTimestamp !== undefined && stamp !== undefined) {
      const gapMinutes = Math.round((stamp - prevTimestamp) / 60_000);
      if (gapMinutes >= HISTORY_GAP_MINUTES) {
        const gapHours = Math.round(gapMinutes / 60);
        gapNote = ` — ${gapHours}h since last message`;
      }
    }
    if (stamp !== undefined) {
      prevTimestamp = stamp;
    }

    const body = record.text?.trim()
      ? record.text.trim()
      : record.contentType === "attachment"
        ? "[sent an attachment]"
        : `[${record.contentType}]`;
    const tag = stamp !== undefined ? `[${localTimeTag(time, timeZone)}${gapNote}] ` : "";
    const text = `${tag}${body}`;

    if (record.direction === "outbound") {
      turns.push({ role: "assistant", content: text });
    } else {
      turns.push({ role: "user", content: [{ type: "text", text }] });
    }
  }

  return turns;
}

function parseMessages(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      if (typeof item === "string") {
        return botText(item);
      }
      if (isRecord(item) && typeof item.text === "string") {
        return botText(item.text);
      }
      return undefined;
    })
    .filter((item): item is string => Boolean(item));
}

function parseReactions(input: unknown): AiReaction[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      if (typeof item === "string") {
        return { emoji: item };
      }
      if (isRecord(item) && typeof item.emoji === "string") {
        return { emoji: item.emoji };
      }
      return undefined;
    })
    .filter((item): item is AiReaction => Boolean(item));
}

function parseSchedules(input: unknown): AiSchedule[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      if (!isRecord(item)) {
        return undefined;
      }

      const schedule: AiSchedule = {};
      if (typeof item.delay_minutes === "number" && Number.isFinite(item.delay_minutes) && item.delay_minutes > 0) {
        schedule.delay_minutes = item.delay_minutes;
      }
      if (typeof item.due_at === "string") {
        schedule.due_at = item.due_at;
      }
      if (typeof item.kind === "string") {
        schedule.kind = item.kind;
      }
      if (typeof item.message === "string") {
        schedule.message = botText(item.message);
      }

      return schedule.delay_minutes || schedule.due_at ? schedule : undefined;
    })
    .filter((item): item is AiSchedule => Boolean(item));
}

function parseDecision(input: unknown): AiDecision | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const decision: AiDecision = {};
  if (isRung(input.rung)) {
    decision.rung = input.rung;
  }
  if (isVerify(input.verify)) {
    decision.verify = input.verify;
  }
  if (typeof input.check_in_at === "string") {
    decision.check_in_at = input.check_in_at;
  }
  if (typeof input.deadline === "string") {
    decision.deadline = input.deadline;
  }
  if (typeof input.next_checkin_at === "string") {
    decision.next_checkin_at = input.next_checkin_at;
  }
  if (typeof input.started_at === "string") {
    decision.started_at = input.started_at;
  }
  if (typeof input.excuse_until === "string") {
    decision.excuse_until = input.excuse_until;
  }
  if (typeof input.note === "string") {
    decision.note = input.note;
  }
  if (typeof input.ledger_summary === "string") {
    decision.ledger_summary = input.ledger_summary;
  }
  if (typeof input.penalty_amount_dollars === "number" && Number.isFinite(input.penalty_amount_dollars)) {
    decision.penalty_amount_dollars = input.penalty_amount_dollars;
  }
  if (typeof input.penalty_paid === "boolean") {
    decision.penalty_paid = input.penalty_paid;
  }
  if (input.resolution === "vague" || input.resolution === "specific") {
    decision.resolution = input.resolution;
  }
  if (isDecisionStatus(input.status)) {
    decision.status = input.status;
  }
  if (typeof input.task === "string") {
    decision.task = input.task;
  }

  return Object.keys(decision).length > 0 ? decision : undefined;
}

function contentToString(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
      .join("");
  }
  throw new Error("ai response did not include text content");
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("ai response was not json");
  }
  return trimmed.slice(start, end + 1);
}

function describeMessage(message: Message) {
  if (message.content.type === "text") {
    return {
      content_type: "text",
      direction: message.direction,
      id: message.id,
      text: message.content.text,
      timestamp: message.timestamp.toISOString(),
    };
  }

  if (message.content.type === "attachment") {
    return {
      content_type: "attachment",
      direction: message.direction,
      id: message.id,
      attachment: {
        id: message.content.id,
        mime_type: message.content.mimeType,
        name: message.content.name,
        readable: typeof message.content.read === "function",
        size: message.content.size,
      },
      timestamp: message.timestamp.toISOString(),
    };
  }

  return {
    content_type: message.content.type,
    direction: message.direction,
    id: message.id,
    timestamp: message.timestamp.toISOString(),
  };
}

function systemPrompt(timezone: string): string {
  return [
    "you are an anti procrastination imessage bot",
    `timezone is ${timezone}`,
    "reply only as json",
    "no markdown",
    "json shape:",
    `{"messages":[{"text":"string"}],"reactions":[{"emoji":"string"}],"schedules":[{"delay_minutes":30,"due_at":"iso optional","kind":"check_in","message":"string"}],"cancel_pending_check_ins":false,"enabled":true,"decision":{"status":"none|specificity_needed|declared|progress|completed|excused|failed|canceled","resolution":"vague|specific","rung":"none|rung1_verifiable_picture|rung2_photo|rung3_probe","verify":"pass|fail|needs_more|not_applicable","started_at":"iso optional","deadline":"iso optional","next_checkin_at":"iso optional","check_in_at":"iso optional legacy alias for next_checkin_at","excuse_until":"iso optional","penalty_amount_dollars":1,"penalty_paid":false,"ledger_summary":"string optional","task":"string optional","note":"string optional"}}`,
    "messages must be strict lowercase",
    "messages must be short rapid fire bursts",
    "use absolute minimum punctuation",
    "no trailing periods",
    "be a firm coach and funny friend",
    "do not be preachy",
    "use casual profanity when the user is clearly ignoring you or doesn't seem to care",
    "profanity should feel natural, not forced or overdone",
    "you enforce declarations, not your own idea of productivity",
    "the user chooses the contract and you hold them to that exact resolution",
    "a vague declaration is allowed after one specificity nudge, but it only creates a vague contract",
    "a specific declaration can be enforced as completion because the user named what done means",
    "when there is no active commitment and the user is vague, push once for a sharper task",
    "the specificity nudge should be one quick prod toward something concrete, phrased fresh in your own voice",
    "never recite the nudge verbatim like what would done look like or what exactly; rephrase it naturally every time",
    "nudge with a light touch, not an interrogation; one short question or prompt is plenty",
    "the commitment intent has three independent time fields: started_at, deadline, and next_checkin_at",
    "started_at is the moment the user declares; declaring is starting immediately, there is no begins later state",
    "deadline is the hard line the stake fires on; if the user declares without naming one, ask for it once with a light touch",
    "next_checkin_at is a touchpoint poke, default it to about 60 minutes out from local_now, never 24 hours",
    "cap next_checkin_at so it never lands after the deadline; if the deadline is sooner, set the check-in before it",
    "check_in_at is a legacy alias for next_checkin_at; prefer next_checkin_at in new decisions",
    "never let a check-in masquerade as the deadline; they are independent concepts",
    "if declaration_context.specificity_nudge_used is true, accept whatever the user gives and move on, do not nudge again",
    "never narrate your own rules or state at the user, things like you already got the specificity nudge or nothing isnt a task; just react like a person",
    "once you accept a task, get out of the way; acknowledge it briefly and let them go",
    "a pure non declaration like im doing something or stuff is not a task, but call it out once with humor not a lecture",
    "bad excuses are not excused: vague busy, later, doing something, idk, or trust me",
    "good excuses are concrete unavailability, health, family, school, commute, sleep, emergency, or a bounded rest plan",
    "school is a good excuse only when school_context says it is a school day and school time",
    "if the excuse is good return status excused and excuse_until when possible",
    "if the excuse is bad ask for a real excuse or a bounded task",
    "you choose the evidence rung",
    "for v0 a live inbound image attachment can be rung1_verifiable_picture if the pixels and metadata plausibly verify the claim",
    "if no strong evidence exists use rung3_probe or none",
    "local_now is the user's current wall clock time in their timezone; always reason about time from local_now, never from the raw now field",
    "never do timezone math in your head and never quote utc to the user; talk in their local time using local_now",
    "when the user names a time like midnight tonight or 4 hours from now, anchor it to local_now and reflect it back in their local time",
    "for scheduling prefer delay_minutes computed from how far away the time is; only use due_at when you are sure of the exact utc instant",
    "you choose next_checkin_at timing, default about 60 minutes out",
    "when you ask the one specificity question return decision.status specificity_needed and no task",
    "when the user declares a real task return decision.status declared and decision.task",
    "include decision.resolution vague or specific when declaring",
    "when the user has a real temporary excuse return decision.status excused and excuse_until",
    "when evidence passes return decision.status completed and verify pass",
    "when evidence is missing return verify needs_more",
    "decision.status canceled is only for genuine mistakes or test data, never for changed minds or laziness",
    "if the user wants to bail on a real commitment they declared, that is failed not canceled",
    "when a scheduled job fires, respond to that event and update the decision if needed",
    "when repeated rung3 probes or failed weak commitments show a pattern, say so and include a ledger_summary",
    "if charity_context has a pending penalty, push the user to complete the donation using the donate url",
    "if the user provides believable donation proof, set penalty_paid true",
    "when assigning a penalty choose 1, 5, 10, or 25 dollars based on severity",
    "1 is allowed for tiny misses, 5 or 10 for school or small tasks, 25 for huge project failures",
    "never exceed charity_context.monthly_remaining_dollars",
    "use schedules for future check ins",
    "use reactions only when useful",
    "never claim a single text probe proves a lie",
    "you are not a rigid state machine",
    "scheduled jobs are conversational check-ins, not forced state transitions",
    "after a commitment is completed or excused, you may schedule a 1-hour follow-up to ask if the user wants to define another task",
    "do not rigidly repeat the same nudge; vary your tone and approach based on the full conversation context",
    "if the user already has an active commitment, do not push for another one unless they bring it up",
  ].join("\n");
}

function parsePayload(payload: string | undefined): unknown {
  if (!payload) {
    return undefined;
  }
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

async function imagePart(message: Message, maxBytes: number): Promise<UserContentPart | undefined> {
  if (message.content.type !== "attachment") {
    return undefined;
  }
  if (!message.content.mimeType.startsWith("image/")) {
    return undefined;
  }
  if (message.content.size && message.content.size > maxBytes) {
    return undefined;
  }
  if (typeof message.content.read !== "function") {
    return undefined;
  }

  const bytes = await message.content.read();
  if (bytes.length > maxBytes) {
    return undefined;
  }

  return {
    type: "image_url",
    image_url: {
      url: `data:${message.content.mimeType};base64,${bytes.toString("base64")}`,
    },
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function isRung(input: unknown): input is AiDecision["rung"] {
  return (
    input === "none" ||
    input === "rung1_verifiable_picture" ||
    input === "rung2_photo" ||
    input === "rung3_probe"
  );
}

function isVerify(input: unknown): input is AiDecision["verify"] {
  return input === "pass" || input === "fail" || input === "needs_more" || input === "not_applicable";
}

function isDecisionStatus(input: unknown): input is AiDecision["status"] {
  return (
    input === "none" ||
    input === "specificity_needed" ||
    input === "declared" ||
    input === "progress" ||
    input === "completed" ||
    input === "excused" ||
    input === "failed" ||
    input === "canceled"
  );
}
