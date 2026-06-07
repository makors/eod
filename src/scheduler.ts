import type { BotStore, ScheduledJob } from "./store";

export type SendJobResult = "sent" | "defer" | "canceled";
export type SendJob = (job: ScheduledJob) => Promise<SendJobResult>;

type SchedulerOptions = {
  logger?: Pick<Console, "error" | "log" | "warn">;
  retryDelayMs?: number;
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class Scheduler {
  private isRunning = false;
  private rerunRequested = false;
  private readonly timers = new Map<string, Timer>();
  private readonly logger: Pick<Console, "error" | "log" | "warn">;
  private readonly retryDelayMs: number;

  constructor(
    private readonly store: BotStore,
    private readonly sendJob: SendJob,
    options: SchedulerOptions = {},
  ) {
    this.logger = options.logger ?? console;
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
  }

  start() {
    this.logger.log("[scheduler] starting");
    this.normalizePendingJobs();
    this.armPendingJobs();
  }

  stop() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.logger.log("[scheduler] stopped");
  }

  schedule(input: {
    spaceId: string;
    kind: string;
    body: string;
    dueAt: Date;
    now?: Date;
    payloadJson?: string;
  }): ScheduledJob {
    const job = this.store.createJob(input);
    this.logger.log(
      `[scheduler] scheduled ${describeJob(job)} due=${job.dueAt}`,
    );
    this.armJob(job);
    return job;
  }

  cancelForSpace(spaceId: string) {
    const pending = this.store.listPendingJobs().filter((job) => job.spaceId === spaceId);
    this.store.cancelPendingJobsForSpace(spaceId);

    for (const job of pending) {
      this.clearTimer(job.id);
    }

    this.logger.log(`[scheduler] canceled ${pending.length} pending job(s) space=${spaceId}`);
  }

  async runDue(now = new Date()) {
    if (this.isRunning) {
      this.rerunRequested = true;
      return;
    }

    this.isRunning = true;
    try {
      let passNow = now;
      do {
        this.rerunRequested = false;
        await this.runDueOnce(passNow);
        passNow = new Date();
      } while (this.rerunRequested);
    } finally {
      this.isRunning = false;
    }
  }

  private async runDueOnce(now = new Date()) {
    const { cancel, run } = coalesceDueJobs(this.store.listDueJobs(now));
    for (const job of cancel) {
      this.clearTimer(job.id);
      this.store.markJobCanceled(job.id);
      this.logger.log(`[scheduler] canceled superseded due job ${describeJob(job)}`);
    }

    const jobs = run;
    if (jobs.length > 0) {
      this.logger.log(`[scheduler] running ${jobs.length} due job(s) at ${now.toISOString()}`);
    }

    for (const job of jobs) {
      this.clearTimer(job.id);
      const current = this.store.getJob(job.id);
      if (!current || current.status !== "pending") {
        this.logger.log(`[scheduler] skipped non-pending job ${describeJob(job)}`);
        continue;
      }
      if (new Date(current.dueAt).getTime() > now.getTime()) {
        this.armJob(current);
        this.logger.log(`[scheduler] skipped no-longer-due job ${describeJob(current)}`);
        continue;
      }

      const space = this.store.getSpace(current.spaceId);
      if (!space?.enabled) {
        this.store.markJobCanceled(current.id);
        this.logger.log(`[scheduler] canceled disabled-space job ${describeJob(current)}`);
        continue;
      }

      try {
        this.logger.log(`[scheduler] sending ${describeJob(current)} due=${current.dueAt}`);
        const result = await this.sendJob(current);

        if (result === "sent") {
          this.store.markJobSent(current.id, now);
          this.logger.log(`[scheduler] sent ${describeJob(current)}`);
          continue;
        }

        if (result === "canceled") {
          this.store.markJobCanceled(current.id);
          this.logger.log(`[scheduler] canceled by sender ${describeJob(current)}`);
          continue;
        }

        const dueAt = new Date(now.getTime() + this.retryDelayMs);
        this.store.rescheduleJob(current.id, dueAt);
        this.logger.warn(
          `[scheduler] deferred ${describeJob(current)} retry_at=${dueAt.toISOString()}`,
        );
        this.armJob({ ...current, dueAt: dueAt.toISOString() });
      } catch (error) {
        const message = errorMessage(error);
        this.store.markJobFailed(current.id, message);
        this.logger.error(`[scheduler] failed ${describeJob(current)} error=${message}`);
      }
    }
  }

  private armPendingJobs() {
    for (const job of this.store.listPendingJobs()) {
      this.armJob(job);
    }
    this.logger.log(`[scheduler] armed ${this.timers.size} pending job(s)`);
  }

  private normalizePendingJobs() {
    const pending = this.store.listPendingJobs();
    const grouped = new Map<string, ScheduledJob[]>();
    let canceled = 0;

    for (const job of pending) {
      if (isStaleLegacyJob(job)) {
        this.clearTimer(job.id);
        this.store.markJobCanceled(job.id);
        canceled += 1;
        this.logger.log(`[scheduler] canceled stale pending job ${describeJob(job)}`);
        continue;
      }

      const group = duplicateGroup(job);
      if (!group) {
        continue;
      }

      const existing = grouped.get(group) ?? [];
      existing.push(job);
      grouped.set(group, existing);
    }

    for (const groupJobs of grouped.values()) {
      if (groupJobs.length <= 1) {
        continue;
      }

      groupJobs.sort((a, b) => {
        const dueDelta = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
        if (dueDelta !== 0) {
          return dueDelta;
        }
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });

      for (const job of groupJobs.slice(1)) {
        this.clearTimer(job.id);
        this.store.markJobCanceled(job.id);
        canceled += 1;
        this.logger.log(`[scheduler] canceled duplicate pending job ${describeJob(job)}`);
      }
    }

    if (canceled > 0) {
      this.logger.log(`[scheduler] normalized ${canceled} pending job(s)`);
    }
  }

  private armJob(job: ScheduledJob) {
    this.clearTimer(job.id);

    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, new Date(job.dueAt).getTime() - Date.now()),
    );
    const timer = setTimeout(() => {
      void this.runDue();
    }, delayMs);
    this.timers.set(job.id, timer);
  }

  private clearTimer(jobId: string) {
    const timer = this.timers.get(jobId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.timers.delete(jobId);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeJob(job: ScheduledJob): string {
  return `job=${job.id} kind=${job.kind} space=${job.spaceId}`;
}

function coalesceDueJobs(jobs: ScheduledJob[]): { cancel: ScheduledJob[]; run: ScheduledJob[] } {
  const cancel: ScheduledJob[] = [];
  const grouped = new Map<string, ScheduledJob[]>();
  const passthrough: ScheduledJob[] = [];

  for (const job of jobs) {
    const group = coalesceGroup(job);
    if (!group) {
      passthrough.push(job);
      continue;
    }

    const existing = grouped.get(group) ?? [];
    existing.push(job);
    grouped.set(group, existing);
  }

  const run = [...passthrough];
  for (const groupJobs of grouped.values()) {
    groupJobs.sort((a, b) => {
      const dueDelta = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
      if (dueDelta !== 0) {
        return dueDelta;
      }
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
    const selected = groupJobs[groupJobs.length - 1];
    if (!selected) {
      continue;
    }
    run.push(selected);
    cancel.push(...groupJobs.slice(0, -1));
  }

  run.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  return { cancel, run };
}

function coalesceGroup(job: ScheduledJob): string | undefined {
  if (
    job.kind.startsWith("morning_wake:") ||
    job.kind.startsWith("morning_followup:") ||
    job.kind.startsWith("morning_noon:") ||
    job.kind === "morning_noon"
  ) {
    return `${job.spaceId}:morning`;
  }

  if (job.kind.startsWith("silence_followup:")) {
    return `${job.spaceId}:silence`;
  }

  if (job.kind.startsWith("penalty_followup:")) {
    return `${job.spaceId}:penalty`;
  }

  return undefined;
}

function duplicateGroup(job: ScheduledJob): string | undefined {
  if (
    job.kind.startsWith("morning_wake:") ||
    job.kind.startsWith("morning_followup:") ||
    job.kind.startsWith("morning_noon:")
  ) {
    return `${job.spaceId}:${job.kind}`;
  }

  if (job.kind === "commitment_check_in") {
    return `${job.spaceId}:${job.kind}`;
  }

  if (job.kind.startsWith("silence_followup:")) {
    return `${job.spaceId}:${job.kind}`;
  }

  if (job.kind.startsWith("penalty_followup:")) {
    const match = job.kind.match(/^penalty_followup:([^:]+)/u);
    return match ? `${job.spaceId}:penalty_followup:${match[1]}` : `${job.spaceId}:${job.kind}`;
  }

  return undefined;
}

function isStaleLegacyJob(job: ScheduledJob): boolean {
  return job.kind === "morning_noon";
}
