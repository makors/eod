import { Database } from "bun:sqlite";

export type SpaceSnapshot = {
  id: string;
  platform: string;
  kind?: string;
  phone?: string;
};

export type StoredSpace = SpaceSnapshot & {
  enabled: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type MessageRecord = {
  id: string;
  spaceId: string;
  platform: string;
  direction: string;
  senderId?: string;
  contentType: string;
  text?: string;
  timestamp: string;
  rawJson?: string;
};

export type AttachmentRecord = {
  id: string;
  messageId: string;
  spaceId: string;
  name: string;
  mimeType: string;
  size?: number;
  readable: boolean;
  timestamp: string;
};

export type JobStatus = "pending" | "sent" | "canceled" | "failed";

export type ScheduledJob = {
  id: string;
  spaceId: string;
  kind: string;
  body: string;
  dueAt: string;
  status: JobStatus;
  createdAt: string;
  sentAt?: string;
  error?: string;
  payloadJson?: string;
};

export type CommitmentStatus = "active" | "canceled" | "completed" | "excused" | "failed";

export type Commitment = {
  id: string;
  spaceId: string;
  task: string;
  rung?: string;
  status: CommitmentStatus;
  startedAt?: string;
  deadline?: string;
  checkInAt?: string;
  silenceLevel: number;
  excuseUntil?: string;
  createdAt: string;
  updatedAt: string;
};

export type SpaceStats = {
  inboundCount: number;
  attachmentCount: number;
};

export type ModelDecisionRecord = {
  id?: string;
  messageId: string;
  spaceId: string;
  rawJson: string;
  rung?: string;
  verify?: string;
  checkInAt?: string;
  startedAt?: string;
  deadline?: string;
  nextCheckinAt?: string;
  task?: string;
  note?: string;
  createdAt?: string;
};

export type LedgerSummary = {
  id: string;
  spaceId: string;
  summary: string;
  createdAt: string;
};

export type PenaltyStatus = "pending" | "paid" | "canceled";

export type Penalty = {
  id: string;
  spaceId: string;
  commitmentId?: string;
  amountDollars: number;
  charityName: string;
  charityDonateUrl?: string;
  reason: string;
  status: PenaltyStatus;
  createdAt: string;
  paidAt?: string;
};

export class BotStore {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  upsertSpace(space: SpaceSnapshot, now = new Date()): { isNew: boolean; space: StoredSpace } {
    const existing = this.getSpace(space.id);
    const nowIso = now.toISOString();

    if (existing) {
      this.db
        .query(
          `UPDATE spaces
           SET platform = $platform,
               kind = $kind,
               phone = $phone,
               last_seen_at = $lastSeenAt
           WHERE id = $id`,
        )
        .run({
          $id: space.id,
          $platform: space.platform,
          $kind: space.kind ?? null,
          $phone: space.phone ?? null,
          $lastSeenAt: nowIso,
        });
      return { isNew: false, space: this.getSpace(space.id)! };
    }

    this.db
      .query(
        `INSERT INTO spaces (id, platform, kind, phone, enabled, first_seen_at, last_seen_at)
         VALUES ($id, $platform, $kind, $phone, 1, $firstSeenAt, $lastSeenAt)`,
      )
      .run({
        $id: space.id,
        $platform: space.platform,
        $kind: space.kind ?? null,
        $phone: space.phone ?? null,
        $firstSeenAt: nowIso,
        $lastSeenAt: nowIso,
      });

    return { isNew: true, space: this.getSpace(space.id)! };
  }

  getSpace(spaceId: string): StoredSpace | undefined {
    const row = this.db
      .query(
        `SELECT id, platform, kind, phone, enabled, first_seen_at, last_seen_at
         FROM spaces
         WHERE id = $spaceId`,
      )
      .get({ $spaceId: spaceId }) as SpaceRow | null;

    return row ? mapSpace(row) : undefined;
  }

  setSpaceEnabled(spaceId: string, enabled: boolean) {
    this.db
      .query("UPDATE spaces SET enabled = $enabled WHERE id = $spaceId")
      .run({ $spaceId: spaceId, $enabled: enabled ? 1 : 0 });
  }

  listEnabledSpaces(): StoredSpace[] {
    const rows = this.db
      .query(
        `SELECT id, platform, kind, phone, enabled, first_seen_at, last_seen_at
         FROM spaces
         WHERE enabled = 1
         ORDER BY last_seen_at DESC`,
      )
      .all() as SpaceRow[];

    return rows.map(mapSpace);
  }

  saveMessage(message: MessageRecord) {
    this.db
      .query(
        `INSERT OR REPLACE INTO messages
          (id, space_id, platform, direction, sender_id, content_type, text, timestamp, raw_json)
         VALUES
          ($id, $spaceId, $platform, $direction, $senderId, $contentType, $text, $timestamp, $rawJson)`,
      )
      .run({
        $id: message.id,
        $spaceId: message.spaceId,
        $platform: message.platform,
        $direction: message.direction,
        $senderId: message.senderId ?? null,
        $contentType: message.contentType,
        $text: message.text ?? null,
        $timestamp: message.timestamp,
        $rawJson: message.rawJson ?? null,
      });
  }

  saveAttachment(attachment: AttachmentRecord) {
    this.db
      .query(
        `INSERT OR REPLACE INTO attachments
          (id, message_id, space_id, name, mime_type, size, readable, timestamp)
         VALUES
          ($id, $messageId, $spaceId, $name, $mimeType, $size, $readable, $timestamp)`,
      )
      .run({
        $id: attachment.id,
        $messageId: attachment.messageId,
        $spaceId: attachment.spaceId,
        $name: attachment.name,
        $mimeType: attachment.mimeType,
        $size: attachment.size ?? null,
        $readable: attachment.readable ? 1 : 0,
        $timestamp: attachment.timestamp,
      });
  }

  saveModelDecision(decision: ModelDecisionRecord) {
    this.db
      .query(
        `INSERT INTO model_decisions
          (id, message_id, space_id, raw_json, rung, verify, check_in_at, started_at, deadline, next_checkin_at, task, note, created_at)
         VALUES
          ($id, $messageId, $spaceId, $rawJson, $rung, $verify, $checkInAt, $startedAt, $deadline, $nextCheckinAt, $task, $note, $createdAt)`,
      )
      .run({
        $id: decision.id ?? crypto.randomUUID(),
        $messageId: decision.messageId,
        $spaceId: decision.spaceId,
        $rawJson: decision.rawJson,
        $rung: decision.rung ?? null,
        $verify: decision.verify ?? null,
        $checkInAt: decision.checkInAt ?? null,
        $startedAt: decision.startedAt ?? null,
        $deadline: decision.deadline ?? null,
        $nextCheckinAt: decision.nextCheckinAt ?? null,
        $task: decision.task ?? null,
        $note: decision.note ?? null,
        $createdAt: decision.createdAt ?? new Date().toISOString(),
      });
  }

  createJob(input: {
    spaceId: string;
    kind: string;
    body: string;
    dueAt: Date;
    now?: Date;
    payloadJson?: string;
  }): ScheduledJob {
    const job: ScheduledJob = {
      id: crypto.randomUUID(),
      spaceId: input.spaceId,
      kind: input.kind,
      body: input.body,
      dueAt: input.dueAt.toISOString(),
      status: "pending",
      createdAt: (input.now ?? new Date()).toISOString(),
      payloadJson: input.payloadJson,
    };

    this.db
      .query(
        `INSERT INTO scheduled_jobs
          (id, space_id, kind, body, due_at, status, created_at, payload_json)
         VALUES
          ($id, $spaceId, $kind, $body, $dueAt, $status, $createdAt, $payloadJson)`,
      )
      .run({
        $id: job.id,
        $spaceId: job.spaceId,
        $kind: job.kind,
        $body: job.body,
        $dueAt: job.dueAt,
        $status: job.status,
        $createdAt: job.createdAt,
        $payloadJson: job.payloadJson ?? null,
      });

    return job;
  }

  getJob(id: string): ScheduledJob | undefined {
    const row = this.db
      .query(
        `SELECT id, space_id, kind, body, due_at, status, created_at, sent_at, error, payload_json
         FROM scheduled_jobs
         WHERE id = $id`,
      )
      .get({ $id: id }) as JobRow | null;

    return row ? mapJob(row) : undefined;
  }

  listPendingJobs(): ScheduledJob[] {
    const rows = this.db
      .query(
        `SELECT id, space_id, kind, body, due_at, status, created_at, sent_at, error, payload_json
         FROM scheduled_jobs
         WHERE status = 'pending'
         ORDER BY due_at ASC`,
      )
      .all() as JobRow[];

    return rows.map(mapJob);
  }

  listDueJobs(now = new Date()): ScheduledJob[] {
    const rows = this.db
      .query(
        `SELECT id, space_id, kind, body, due_at, status, created_at, sent_at, error, payload_json
         FROM scheduled_jobs
         WHERE status = 'pending' AND due_at <= $now
         ORDER BY due_at ASC`,
      )
      .all({ $now: now.toISOString() }) as JobRow[];

    return rows.map(mapJob);
  }

  getNextPendingJob(spaceId: string): ScheduledJob | undefined {
    const row = this.db
      .query(
        `SELECT id, space_id, kind, body, due_at, status, created_at, sent_at, error, payload_json
         FROM scheduled_jobs
         WHERE status = 'pending' AND space_id = $spaceId
         ORDER BY due_at ASC
         LIMIT 1`,
      )
      .get({ $spaceId: spaceId }) as JobRow | null;

    return row ? mapJob(row) : undefined;
  }

  getPendingJobByKind(spaceId: string, kind: string): ScheduledJob | undefined {
    const row = this.db
      .query(
        `SELECT id, space_id, kind, body, due_at, status, created_at, sent_at, error, payload_json
         FROM scheduled_jobs
         WHERE status = 'pending' AND space_id = $spaceId AND kind = $kind
         ORDER BY due_at ASC
         LIMIT 1`,
      )
      .get({ $spaceId: spaceId, $kind: kind }) as JobRow | null;

    return row ? mapJob(row) : undefined;
  }

  markJobSent(jobId: string, now = new Date()) {
    this.db
      .query(
        `UPDATE scheduled_jobs
         SET status = 'sent', sent_at = $sentAt, error = NULL
         WHERE id = $jobId`,
      )
      .run({ $jobId: jobId, $sentAt: now.toISOString() });
  }

  markJobCanceled(jobId: string) {
    this.db
      .query("UPDATE scheduled_jobs SET status = 'canceled' WHERE id = $jobId")
      .run({ $jobId: jobId });
  }

  markJobFailed(jobId: string, error: string) {
    this.db
      .query("UPDATE scheduled_jobs SET status = 'failed', error = $error WHERE id = $jobId")
      .run({ $jobId: jobId, $error: error.slice(0, 500) });
  }

  rescheduleJob(jobId: string, dueAt: Date) {
    this.db
      .query(
        `UPDATE scheduled_jobs
         SET due_at = $dueAt
         WHERE id = $jobId AND status = 'pending'`,
      )
      .run({ $jobId: jobId, $dueAt: dueAt.toISOString() });
  }

  cancelPendingJobsForSpace(spaceId: string) {
    this.db
      .query(
        `UPDATE scheduled_jobs
         SET status = 'canceled'
         WHERE space_id = $spaceId AND status = 'pending'`,
      )
      .run({ $spaceId: spaceId });
  }

  cancelPendingJobsForSpaceByKindPrefix(spaceId: string, kindPrefix: string) {
    this.db
      .query(
        `UPDATE scheduled_jobs
         SET status = 'canceled'
         WHERE space_id = $spaceId AND status = 'pending' AND kind LIKE $kindLike`,
      )
      .run({ $spaceId: spaceId, $kindLike: `${kindPrefix}%` });
  }

  listRecentMessages(
    spaceId: string,
    opts: { since: Date; limit?: number } = { since: new Date(Date.now() - 24 * 60 * 60_000) },
  ): MessageRecord[] {
    const rows = this.db
      .query(
        `SELECT id, space_id, platform, direction, sender_id, content_type, text, timestamp, raw_json
         FROM messages
         WHERE space_id = $spaceId AND timestamp >= $since
         ORDER BY timestamp DESC
         LIMIT $limit`,
      )
      .all({
        $spaceId: spaceId,
        $since: opts.since.toISOString(),
        $limit: opts.limit ?? 30,
      }) as MessageRow[];

    return rows.map(mapMessage).reverse();
  }

  getLastInboundAt(spaceId: string): string | undefined {
    const row = this.db
      .query(
        `SELECT timestamp
         FROM messages
         WHERE space_id = $spaceId AND direction = 'inbound'
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .get({ $spaceId: spaceId }) as { timestamp: string } | null;

    return row?.timestamp;
  }

  hasSpecificityNudge(spaceId: string, date: string): boolean {
    const row = this.db
      .query(
        `SELECT specificity_nudged_at
         FROM declaration_days
         WHERE space_id = $spaceId AND date = $date`,
      )
      .get({ $spaceId: spaceId, $date: date }) as { specificity_nudged_at: string | null } | null;

    return Boolean(row?.specificity_nudged_at);
  }

  getDayExcuse(spaceId: string, date: string): string | undefined {
    const row = this.db
      .query(
        `SELECT excuse_until
         FROM declaration_days
         WHERE space_id = $spaceId AND date = $date`,
      )
      .get({ $spaceId: spaceId, $date: date }) as { excuse_until: string | null } | null;

    return row?.excuse_until ?? undefined;
  }

  markDayExcused(spaceId: string, date: string, excuseUntil: string, now = new Date()) {
    this.db
      .query(
        `INSERT INTO declaration_days (space_id, date, excuse_until, created_at, updated_at)
         VALUES ($spaceId, $date, $excuseUntil, $createdAt, $updatedAt)
         ON CONFLICT(space_id, date) DO UPDATE SET
           excuse_until = excluded.excuse_until,
           updated_at = excluded.updated_at`,
      )
      .run({
        $spaceId: spaceId,
        $date: date,
        $excuseUntil: excuseUntil,
        $createdAt: now.toISOString(),
        $updatedAt: now.toISOString(),
      });
  }

  markSpecificityNudge(spaceId: string, date: string, now = new Date()) {
    this.db
      .query(
        `INSERT INTO declaration_days (space_id, date, specificity_nudged_at, created_at, updated_at)
         VALUES ($spaceId, $date, $nudgedAt, $createdAt, $updatedAt)
         ON CONFLICT(space_id, date) DO UPDATE SET
           specificity_nudged_at = COALESCE(declaration_days.specificity_nudged_at, excluded.specificity_nudged_at),
           updated_at = excluded.updated_at`,
      )
      .run({
        $spaceId: spaceId,
        $date: date,
        $nudgedAt: now.toISOString(),
        $createdAt: now.toISOString(),
        $updatedAt: now.toISOString(),
      });
  }

  upsertActiveCommitment(input: {
    checkInAt?: string;
    deadline?: string;
    now?: Date;
    rung?: string;
    spaceId: string;
    startedAt?: string;
    task: string;
  }): Commitment {
    const existing = this.getActiveCommitment(input.spaceId);
    const now = (input.now ?? new Date()).toISOString();

    if (existing) {
      this.db
        .query(
          `UPDATE commitments
           SET task = $task,
               rung = $rung,
               started_at = COALESCE($startedAt, started_at),
               deadline = COALESCE($deadline, deadline),
               check_in_at = $checkInAt,
               status = 'active',
               updated_at = $updatedAt
           WHERE id = $id`,
        )
        .run({
          $id: existing.id,
          $task: input.task,
          $rung: input.rung ?? null,
          $startedAt: input.startedAt ?? null,
          $deadline: input.deadline ?? null,
          $checkInAt: input.checkInAt ?? null,
          $updatedAt: now,
        });
      return this.getCommitment(existing.id)!;
    }

    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO commitments
          (id, space_id, task, rung, status, started_at, deadline, check_in_at, silence_level, created_at, updated_at)
         VALUES
          ($id, $spaceId, $task, $rung, 'active', $startedAt, $deadline, $checkInAt, 0, $createdAt, $updatedAt)`,
      )
      .run({
        $id: id,
        $spaceId: input.spaceId,
        $task: input.task,
        $rung: input.rung ?? null,
        $startedAt: input.startedAt ?? null,
        $deadline: input.deadline ?? null,
        $checkInAt: input.checkInAt ?? null,
        $createdAt: now,
        $updatedAt: now,
      });

    return this.getCommitment(id)!;
  }

  getActiveCommitment(spaceId: string): Commitment | undefined {
    const row = this.db
      .query(
        `SELECT id, space_id, task, rung, status, started_at, deadline, check_in_at, silence_level, excuse_until, created_at, updated_at
         FROM commitments
         WHERE space_id = $spaceId AND status = 'active'
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get({ $spaceId: spaceId }) as CommitmentRow | null;

    return row ? mapCommitment(row) : undefined;
  }

  getCommitment(id: string): Commitment | undefined {
    const row = this.db
      .query(
        `SELECT id, space_id, task, rung, status, started_at, deadline, check_in_at, silence_level, excuse_until, created_at, updated_at
         FROM commitments
         WHERE id = $id`,
      )
      .get({ $id: id }) as CommitmentRow | null;

    return row ? mapCommitment(row) : undefined;
  }

  setCommitmentStatus(id: string, status: CommitmentStatus, now = new Date()) {
    this.db
      .query(
        `UPDATE commitments
         SET status = $status, updated_at = $updatedAt
         WHERE id = $id`,
      )
      .run({ $id: id, $status: status, $updatedAt: now.toISOString() });
  }

  excuseCommitment(id: string, excuseUntil: string, now = new Date()) {
    this.db
      .query(
        `UPDATE commitments
         SET status = 'excused', excuse_until = $excuseUntil, updated_at = $updatedAt
         WHERE id = $id`,
      )
      .run({ $id: id, $excuseUntil: excuseUntil, $updatedAt: now.toISOString() });
  }

  incrementSilenceLevel(id: string, now = new Date()): Commitment | undefined {
    this.db
      .query(
        `UPDATE commitments
         SET silence_level = silence_level + 1, updated_at = $updatedAt
         WHERE id = $id`,
      )
      .run({ $id: id, $updatedAt: now.toISOString() });

    return this.getCommitment(id);
  }

  saveLedgerSummary(input: {
    now?: Date;
    spaceId: string;
    summary: string;
  }): LedgerSummary {
    const summary: LedgerSummary = {
      id: crypto.randomUUID(),
      spaceId: input.spaceId,
      summary: input.summary,
      createdAt: (input.now ?? new Date()).toISOString(),
    };

    this.db
      .query(
        `INSERT INTO ledger_summaries (id, space_id, summary, created_at)
         VALUES ($id, $spaceId, $summary, $createdAt)`,
      )
      .run({
        $id: summary.id,
        $spaceId: summary.spaceId,
        $summary: summary.summary,
        $createdAt: summary.createdAt,
      });

    return summary;
  }

  getLatestLedgerSummary(spaceId: string): LedgerSummary | undefined {
    const row = this.db
      .query(
        `SELECT id, space_id, summary, created_at
         FROM ledger_summaries
         WHERE space_id = $spaceId
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get({ $spaceId: spaceId }) as LedgerSummaryRow | null;

    return row ? mapLedgerSummary(row) : undefined;
  }

  listRecentCommitments(spaceId: string, limit = 20): Commitment[] {
    const rows = this.db
      .query(
        `SELECT id, space_id, task, rung, status, started_at, deadline, check_in_at, silence_level, excuse_until, created_at, updated_at
         FROM commitments
         WHERE space_id = $spaceId
         ORDER BY created_at DESC
         LIMIT $limit`,
      )
      .all({ $spaceId: spaceId, $limit: limit }) as CommitmentRow[];

    return rows.map(mapCommitment);
  }

  listRecentDecisions(spaceId: string, limit = 30): ModelDecisionRecord[] {
    const rows = this.db
      .query(
        `SELECT id, message_id, space_id, raw_json, rung, verify, check_in_at, task, note, created_at
         FROM model_decisions
         WHERE space_id = $spaceId
         ORDER BY created_at DESC
         LIMIT $limit`,
      )
      .all({ $spaceId: spaceId, $limit: limit }) as ModelDecisionRow[];

    return rows.map(mapModelDecision);
  }

  createPenalty(input: {
    amountDollars: number;
    charityDonateUrl?: string;
    charityName: string;
    commitmentId?: string;
    now?: Date;
    reason: string;
    spaceId: string;
  }): Penalty {
    const penalty: Penalty = {
      id: crypto.randomUUID(),
      spaceId: input.spaceId,
      commitmentId: input.commitmentId,
      amountDollars: input.amountDollars,
      charityName: input.charityName,
      charityDonateUrl: input.charityDonateUrl,
      reason: input.reason,
      status: "pending",
      createdAt: (input.now ?? new Date()).toISOString(),
    };

    this.db
      .query(
        `INSERT INTO penalties
          (id, space_id, commitment_id, amount_dollars, charity_name, charity_donate_url, reason, status, created_at)
         VALUES
          ($id, $spaceId, $commitmentId, $amountDollars, $charityName, $charityDonateUrl, $reason, $status, $createdAt)`,
      )
      .run({
        $id: penalty.id,
        $spaceId: penalty.spaceId,
        $commitmentId: penalty.commitmentId ?? null,
        $amountDollars: penalty.amountDollars,
        $charityName: penalty.charityName,
        $charityDonateUrl: penalty.charityDonateUrl ?? null,
        $reason: penalty.reason,
        $status: penalty.status,
        $createdAt: penalty.createdAt,
      });

    return penalty;
  }

  getPendingPenalty(spaceId: string): Penalty | undefined {
    const row = this.db
      .query(
        `SELECT id, space_id, commitment_id, amount_dollars, charity_name, charity_donate_url, reason, status, created_at, paid_at
         FROM penalties
         WHERE space_id = $spaceId AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get({ $spaceId: spaceId }) as PenaltyRow | null;

    return row ? mapPenalty(row) : undefined;
  }

  markPendingPenaltyPaid(spaceId: string, now = new Date()) {
    this.db
      .query(
        `UPDATE penalties
         SET status = 'paid', paid_at = $paidAt
         WHERE id IN (
           SELECT id FROM penalties
           WHERE space_id = $spaceId AND status = 'pending'
           ORDER BY created_at ASC
           LIMIT 1
         )`,
      )
      .run({ $spaceId: spaceId, $paidAt: now.toISOString() });
  }

  monthlyPenaltyTotal(spaceId: string, monthPrefix: string): number {
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(amount_dollars), 0) as total
         FROM penalties
         WHERE space_id = $spaceId
           AND status IN ('pending', 'paid')
           AND created_at LIKE $monthLike`,
      )
      .get({ $spaceId: spaceId, $monthLike: `${monthPrefix}%` }) as { total: number } | null;

    return Number(row?.total ?? 0);
  }

  getSpaceStats(spaceId: string): SpaceStats {
    const inbound = this.db
      .query("SELECT count(*) as count FROM messages WHERE space_id = $spaceId AND direction = 'inbound'")
      .get({ $spaceId: spaceId }) as CountRow;
    const attachments = this.db
      .query("SELECT count(*) as count FROM attachments WHERE space_id = $spaceId")
      .get({ $spaceId: spaceId }) as CountRow;

    return {
      inboundCount: Number(inbound.count),
      attachmentCount: Number(attachments.count),
    };
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        kind TEXT,
        phone TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        direction TEXT NOT NULL,
        sender_id TEXT,
        content_type TEXT NOT NULL,
        text TEXT,
        timestamp TEXT NOT NULL,
        raw_json TEXT,
        FOREIGN KEY (space_id) REFERENCES spaces(id)
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER,
        readable INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (id, message_id),
        FOREIGN KEY (space_id) REFERENCES spaces(id),
        FOREIGN KEY (message_id) REFERENCES messages(id)
      );

      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        due_at TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        error TEXT,
        payload_json TEXT,
        FOREIGN KEY (space_id) REFERENCES spaces(id)
      );

      CREATE TABLE IF NOT EXISTS model_decisions (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        rung TEXT,
        verify TEXT,
        check_in_at TEXT,
        task TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (space_id) REFERENCES spaces(id),
        FOREIGN KEY (message_id) REFERENCES messages(id)
      );

      CREATE TABLE IF NOT EXISTS commitments (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        task TEXT NOT NULL,
        rung TEXT,
        status TEXT NOT NULL,
        check_in_at TEXT,
        silence_level INTEGER NOT NULL DEFAULT 0,
        excuse_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (space_id) REFERENCES spaces(id)
      );

      CREATE TABLE IF NOT EXISTS declaration_days (
        space_id TEXT NOT NULL,
        date TEXT NOT NULL,
        specificity_nudged_at TEXT,
        excuse_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (space_id, date),
        FOREIGN KEY (space_id) REFERENCES spaces(id)
      );

      CREATE TABLE IF NOT EXISTS ledger_summaries (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (space_id) REFERENCES spaces(id)
      );

      CREATE TABLE IF NOT EXISTS penalties (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        commitment_id TEXT,
        amount_dollars INTEGER NOT NULL,
        charity_name TEXT NOT NULL,
        charity_donate_url TEXT,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        paid_at TEXT,
        FOREIGN KEY (space_id) REFERENCES spaces(id),
        FOREIGN KEY (commitment_id) REFERENCES commitments(id)
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_pending_due
        ON scheduled_jobs(status, due_at);
      CREATE INDEX IF NOT EXISTS idx_messages_space_id
        ON messages(space_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_space_id
        ON attachments(space_id);
      CREATE INDEX IF NOT EXISTS idx_model_decisions_space_id
        ON model_decisions(space_id);
      CREATE INDEX IF NOT EXISTS idx_commitments_space_status
        ON commitments(space_id, status);
      CREATE INDEX IF NOT EXISTS idx_ledger_summaries_space
        ON ledger_summaries(space_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_penalties_space_status
        ON penalties(space_id, status);
    `);
    this.ensureColumn("scheduled_jobs", "payload_json", "TEXT");
    this.ensureColumn("declaration_days", "excuse_until", "TEXT");
    this.ensureColumn("commitments", "started_at", "TEXT");
    this.ensureColumn("commitments", "deadline", "TEXT");
    this.ensureColumn("model_decisions", "started_at", "TEXT");
    this.ensureColumn("model_decisions", "deadline", "TEXT");
    this.ensureColumn("model_decisions", "next_checkin_at", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

type SpaceRow = {
  id: string;
  platform: string;
  kind: string | null;
  phone: string | null;
  enabled: number;
  first_seen_at: string;
  last_seen_at: string;
};

type MessageRow = {
  id: string;
  space_id: string;
  platform: string;
  direction: string;
  sender_id: string | null;
  content_type: string;
  text: string | null;
  timestamp: string;
  raw_json: string | null;
};

type JobRow = {
  id: string;
  space_id: string;
  kind: string;
  body: string;
  due_at: string;
  status: JobStatus;
  created_at: string;
  sent_at: string | null;
  error: string | null;
  payload_json: string | null;
};

type CountRow = {
  count: number;
};

type CommitmentRow = {
  id: string;
  space_id: string;
  task: string;
  rung: string | null;
  status: CommitmentStatus;
  started_at: string | null;
  deadline: string | null;
  check_in_at: string | null;
  silence_level: number;
  excuse_until: string | null;
  created_at: string;
  updated_at: string;
};

type LedgerSummaryRow = {
  id: string;
  space_id: string;
  summary: string;
  created_at: string;
};

type ModelDecisionRow = {
  id: string;
  message_id: string;
  space_id: string;
  raw_json: string;
  rung: string | null;
  verify: string | null;
  check_in_at: string | null;
  started_at: string | null;
  deadline: string | null;
  next_checkin_at: string | null;
  task: string | null;
  note: string | null;
  created_at: string;
};

type PenaltyRow = {
  id: string;
  space_id: string;
  commitment_id: string | null;
  amount_dollars: number;
  charity_name: string;
  charity_donate_url: string | null;
  reason: string;
  status: PenaltyStatus;
  created_at: string;
  paid_at: string | null;
};

function mapSpace(row: SpaceRow): StoredSpace {
  return {
    id: row.id,
    platform: row.platform,
    kind: row.kind ?? undefined,
    phone: row.phone ?? undefined,
    enabled: row.enabled === 1,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    spaceId: row.space_id,
    platform: row.platform,
    direction: row.direction,
    senderId: row.sender_id ?? undefined,
    contentType: row.content_type,
    text: row.text ?? undefined,
    timestamp: row.timestamp,
    rawJson: row.raw_json ?? undefined,
  };
}

function mapJob(row: JobRow): ScheduledJob {
  return {
    id: row.id,
    spaceId: row.space_id,
    kind: row.kind,
    body: row.body,
    dueAt: row.due_at,
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
    error: row.error ?? undefined,
    payloadJson: row.payload_json ?? undefined,
  };
}

function mapCommitment(row: CommitmentRow): Commitment {
  return {
    id: row.id,
    spaceId: row.space_id,
    task: row.task,
    rung: row.rung ?? undefined,
    status: row.status,
    startedAt: row.started_at ?? undefined,
    deadline: row.deadline ?? undefined,
    checkInAt: row.check_in_at ?? undefined,
    silenceLevel: row.silence_level,
    excuseUntil: row.excuse_until ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLedgerSummary(row: LedgerSummaryRow): LedgerSummary {
  return {
    id: row.id,
    spaceId: row.space_id,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

function mapModelDecision(row: ModelDecisionRow): ModelDecisionRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    spaceId: row.space_id,
    rawJson: row.raw_json,
    rung: row.rung ?? undefined,
    verify: row.verify ?? undefined,
    checkInAt: row.check_in_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    deadline: row.deadline ?? undefined,
    nextCheckinAt: row.next_checkin_at ?? undefined,
    task: row.task ?? undefined,
    note: row.note ?? undefined,
    createdAt: row.created_at,
  };
}

function mapPenalty(row: PenaltyRow): Penalty {
  return {
    id: row.id,
    spaceId: row.space_id,
    commitmentId: row.commitment_id ?? undefined,
    amountDollars: row.amount_dollars,
    charityName: row.charity_name,
    charityDonateUrl: row.charity_donate_url ?? undefined,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    paidAt: row.paid_at ?? undefined,
  };
}
