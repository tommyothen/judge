import type {
  Case,
  CaseKind,
  CaseStatus,
  GuildSettings,
  ScoreRow,
  StandingMode,
  VoteTally,
} from './types.js';

// ---------------------------------------------------------------------------
// Row shapes as they come back from D1 (snake_case, integers for booleans).
// ---------------------------------------------------------------------------

interface SettingsRow {
  guild_id: string;
  quorum: number;
  default_duration_min: number;
  category_id: string | null;
  court_channel_id: string | null;
  forum_channel_id: string | null;
  hub_message_id: string | null;
  tags_json: string | null;
  standing: string;
  tier_roles_json: string | null;
  nickname_sync: number;
}

interface CaseRow {
  id: number;
  number: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  kind: string;
  accuser_id: string;
  accused_id: string;
  reason: string;
  points: number;
  deadline: number;
  status: string;
  created_at: number;
}

const DEFAULT_QUORUM = 3;
const DEFAULT_DURATION_MIN = 360;
const DEFAULT_STANDING: StandingMode = 'roles';

const STANDING_MODES: StandingMode[] = ['nicknames', 'roles', 'both', 'off'];

function defaultSettings(guildId: string): GuildSettings {
  return {
    guildId,
    quorum: DEFAULT_QUORUM,
    defaultDurationMin: DEFAULT_DURATION_MIN,
    categoryId: null,
    courtChannelId: null,
    forumChannelId: null,
    hubMessageId: null,
    tags: null,
    standing: DEFAULT_STANDING,
    tierRoles: null,
    nicknameSync: true,
  };
}

/** A stored JSON object column, or null when it is missing or unreadable. */
function parseMap(json: string | null): Record<string, string> | null {
  try {
    const parsed: unknown = json === null ? null : JSON.parse(json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    return null;
  }
  return null;
}

function toStanding(value: string): StandingMode {
  return STANDING_MODES.includes(value as StandingMode) ? (value as StandingMode) : DEFAULT_STANDING;
}

function toSettings(row: SettingsRow): GuildSettings {
  return {
    guildId: row.guild_id,
    quorum: row.quorum,
    defaultDurationMin: row.default_duration_min,
    categoryId: row.category_id,
    courtChannelId: row.court_channel_id,
    forumChannelId: row.forum_channel_id,
    hubMessageId: row.hub_message_id,
    tags: parseMap(row.tags_json),
    standing: toStanding(row.standing),
    tierRoles: parseMap(row.tier_roles_json),
    nicknameSync: row.nickname_sync !== 0,
  };
}

function toCase(row: CaseRow): Case {
  return {
    id: row.id,
    number: row.number,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    kind: row.kind as CaseKind,
    accuserId: row.accuser_id,
    accusedId: row.accused_id,
    reason: row.reason,
    points: row.points,
    deadline: row.deadline,
    status: row.status as CaseStatus,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Guild settings
// ---------------------------------------------------------------------------

/** Settings for a guild, falling back to defaults when the guild has no row. */
export async function getSettings(db: D1Database, guildId: string): Promise<GuildSettings> {
  const row = await db
    .prepare(
      `SELECT guild_id, quorum, default_duration_min, category_id, court_channel_id, forum_channel_id,
              hub_message_id, tags_json, standing, tier_roles_json, nickname_sync
         FROM guild_settings
        WHERE guild_id = ?`,
    )
    .bind(guildId)
    .first<SettingsRow>();

  return row ? toSettings(row) : defaultSettings(guildId);
}

/** Column name and encoder per settings field, for building partial updates. */
const SETTINGS_COLUMNS: Record<
  keyof Omit<GuildSettings, 'guildId'>,
  { column: string; encode: (merged: GuildSettings) => unknown }
> = {
  quorum: { column: 'quorum', encode: (m) => m.quorum },
  defaultDurationMin: { column: 'default_duration_min', encode: (m) => m.defaultDurationMin },
  categoryId: { column: 'category_id', encode: (m) => m.categoryId },
  courtChannelId: { column: 'court_channel_id', encode: (m) => m.courtChannelId },
  forumChannelId: { column: 'forum_channel_id', encode: (m) => m.forumChannelId },
  hubMessageId: { column: 'hub_message_id', encode: (m) => m.hubMessageId },
  tags: { column: 'tags_json', encode: (m) => (m.tags === null ? null : JSON.stringify(m.tags)) },
  standing: { column: 'standing', encode: (m) => m.standing },
  tierRoles: {
    column: 'tier_roles_json',
    encode: (m) => (m.tierRoles === null ? null : JSON.stringify(m.tierRoles)),
  },
  nicknameSync: { column: 'nickname_sync', encode: (m) => (m.nicknameSync ? 1 : 0) },
};

/**
 * Merge `patch` over the current settings (or the defaults), persist, and
 * return the result. On conflict only the patched columns are written, so two
 * concurrent updates to different fields (the cron healing the hub while the
 * owner flips a setting) cannot clobber each other's work.
 */
export async function updateSettings(
  db: D1Database,
  guildId: string,
  patch: Partial<Omit<GuildSettings, 'guildId'>>,
): Promise<GuildSettings> {
  const current = await getSettings(db, guildId);
  const merged: GuildSettings = { ...current, ...patch, guildId };

  const fields = Object.values(SETTINGS_COLUMNS);
  const patched = Object.keys(patch)
    .filter((key): key is keyof typeof SETTINGS_COLUMNS => key in SETTINGS_COLUMNS)
    .map((key) => SETTINGS_COLUMNS[key]);
  if (patched.length === 0) return merged;

  const sets = patched.map(({ column }) => `${column} = excluded.${column}`).join(', ');
  await db
    .prepare(
      `INSERT INTO guild_settings
         (guild_id, ${fields.map(({ column }) => column).join(', ')})
       VALUES (${['?', ...fields.map(() => '?')].join(', ')})
       ON CONFLICT (guild_id) DO UPDATE SET ${sets}`,
    )
    .bind(merged.guildId, ...fields.map(({ encode }) => encode(merged)))
    .run();

  return merged;
}

/** Every guild that has finished /setup, for the cron sweep and hub healing. */
export async function getConfiguredGuilds(db: D1Database): Promise<GuildSettings[]> {
  const { results } = await db
    .prepare(
      `SELECT guild_id, quorum, default_duration_min, category_id, court_channel_id, forum_channel_id,
              hub_message_id, tags_json, standing, tier_roles_json, nickname_sync
         FROM guild_settings
        WHERE court_channel_id IS NOT NULL`,
    )
    .all<SettingsRow>();

  return results.map(toSettings);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/** Open cases one filer may hold per kind: two accusations and two commendations. */
export const MAX_OPEN_PER_KIND = 2;

/**
 * Files a case, or returns undefined when the filer is already at the open-case
 * limit for this kind or has an open case of this kind against this target.
 * The limits are enforced inside the insert itself, so two filings racing each
 * other cannot both slip under the cap; the friendlier per-limit refusals in
 * runFiling are just the early exits.
 */
export async function createCase(
  db: D1Database,
  input: {
    guildId: string;
    channelId: string;
    kind: CaseKind;
    accuserId: string;
    accusedId: string;
    reason: string;
    points: number;
    deadline: number;
  },
): Promise<Case | undefined> {
  const createdAt = Date.now();

  // The next per-guild number is picked inside the insert, so two people filing
  // at once cannot read the same maximum and land on the same case number.
  const row = await db
    .prepare(
      `INSERT INTO cases
         (guild_id, channel_id, message_id, kind, accuser_id, accused_id, reason, points, deadline, status, created_at, number)
       SELECT ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'open', ?,
               (SELECT COALESCE(MAX(number), 0) + 1 FROM cases WHERE guild_id = ?)
       WHERE (SELECT COUNT(*) FROM cases
               WHERE guild_id = ? AND accuser_id = ? AND kind = ? AND status = 'open') < ?
         AND NOT EXISTS (SELECT 1 FROM cases
               WHERE guild_id = ? AND accuser_id = ? AND accused_id = ? AND kind = ? AND status = 'open')
       RETURNING *`,
    )
    .bind(
      input.guildId,
      input.channelId,
      input.kind,
      input.accuserId,
      input.accusedId,
      input.reason,
      input.points,
      input.deadline,
      createdAt,
      input.guildId,
      input.guildId,
      input.accuserId,
      input.kind,
      MAX_OPEN_PER_KIND,
      input.guildId,
      input.accuserId,
      input.accusedId,
      input.kind,
    )
    .first<CaseRow>();

  return row ? toCase(row) : undefined;
}

/** A forum case lives in its own post: the thread id is both the channel and the message. */
export async function setCasePost(db: D1Database, caseId: number, threadId: string): Promise<void> {
  await db
    .prepare(`UPDATE cases SET channel_id = ?, message_id = ? WHERE id = ?`)
    .bind(threadId, threadId, caseId)
    .run();
}

export async function getCase(db: D1Database, caseId: number): Promise<Case | undefined> {
  const row = await db.prepare(`SELECT * FROM cases WHERE id = ?`).bind(caseId).first<CaseRow>();
  return row ? toCase(row) : undefined;
}

/** Every open case in every guild, oldest deadline first, for the cron sweep. */
export async function getOpenCases(db: D1Database): Promise<Case[]> {
  const { results } = await db
    .prepare(`SELECT * FROM cases WHERE status = 'open' ORDER BY deadline ASC`)
    .all<CaseRow>();

  return results.map(toCase);
}

/** Open cases in one guild, newest filing first, for the hub's open-cases list. */
export async function getOpenCasesByGuild(db: D1Database, guildId: string): Promise<Case[]> {
  const { results } = await db
    .prepare(`SELECT * FROM cases WHERE guild_id = ? AND status = 'open' ORDER BY id DESC`)
    .bind(guildId)
    .all<CaseRow>();

  return results.map(toCase);
}

export async function countOpenCasesByAccuser(
  db: D1Database,
  guildId: string,
  accuserId: string,
  kind: CaseKind,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM cases
        WHERE guild_id = ? AND accuser_id = ? AND kind = ? AND status = 'open'`,
    )
    .bind(guildId, accuserId, kind)
    .first<{ n: number }>();

  return row?.n ?? 0;
}

/** Whether this accuser already has an open case of this kind against this target. */
export async function hasOpenCaseAgainst(
  db: D1Database,
  guildId: string,
  accuserId: string,
  accusedId: string,
  kind: CaseKind,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit
         FROM cases
        WHERE guild_id = ? AND accuser_id = ? AND accused_id = ? AND kind = ? AND status = 'open'
        LIMIT 1`,
    )
    .bind(guildId, accuserId, accusedId, kind)
    .first<{ hit: number }>();

  return row !== null;
}

/**
 * Close a case, but only if it is still open. Returns false when another writer
 * (a button press racing the cron sweep) already resolved it.
 */
export async function closeCase(
  db: D1Database,
  caseId: number,
  status: Exclude<CaseStatus, 'open'>,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE cases SET status = ? WHERE id = ? AND status = 'open'`)
    .bind(status, caseId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Votes
// ---------------------------------------------------------------------------

/**
 * Cast or replace a vote. `already` means the voter repeated their existing
 * choice, `changed` means they switched sides; the tally is post-vote.
 */
export async function castVote(
  db: D1Database,
  caseId: number,
  voterId: string,
  choice: 'yes' | 'no',
): Promise<{ tally: VoteTally; changed: boolean; already: boolean }> {
  const prior = await db
    .prepare(`SELECT choice FROM votes WHERE case_id = ? AND voter_id = ?`)
    .bind(caseId, voterId)
    .first<{ choice: string }>();

  const already = prior?.choice === choice;
  const changed = prior != null && prior.choice !== choice;

  if (!already) {
    await db
      .prepare(
        `INSERT INTO votes (case_id, voter_id, choice)
         VALUES (?, ?, ?)
         ON CONFLICT (case_id, voter_id) DO UPDATE SET choice = excluded.choice`,
      )
      .bind(caseId, voterId, choice)
      .run();
  }

  return { tally: await getTally(db, caseId), changed, already };
}

export async function getTally(db: D1Database, caseId: number): Promise<VoteTally> {
  // Rowid order is first-vote order: changing sides updates the row in place.
  const { results } = await db
    .prepare(`SELECT voter_id, choice FROM votes WHERE case_id = ? ORDER BY rowid`)
    .bind(caseId)
    .all<{ voter_id: string; choice: string }>();

  const yesVoters = results.filter((r) => r.choice === 'yes').map((r) => r.voter_id);
  const noVoters = results.filter((r) => r.choice === 'no').map((r) => r.voter_id);
  return { yes: yesVoters.length, no: noVoters.length, yesVoters, noVoters };
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/** Add `delta` to a member's score, refresh their cached name, return the new total. */
export async function applyPoints(
  db: D1Database,
  guildId: string,
  userId: string,
  delta: number,
  displayName: string,
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO scores (guild_id, user_id, display_name, points)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         points       = scores.points + excluded.points,
         display_name = excluded.display_name
       RETURNING points`,
    )
    .bind(guildId, userId, displayName, delta)
    .first<{ points: number }>();

  if (!row) throw new Error('applyPoints: upsert returned no row');
  return row.points;
}

/** Refresh a cached display name without creating a score row for someone at zero. */
export async function touchName(
  db: D1Database,
  guildId: string,
  userId: string,
  displayName: string,
): Promise<void> {
  await db
    .prepare(`UPDATE scores SET display_name = ? WHERE guild_id = ? AND user_id = ?`)
    .bind(displayName, guildId, userId)
    .run();
}

export async function getScore(db: D1Database, guildId: string, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT points FROM scores WHERE guild_id = ? AND user_id = ?`)
    .bind(guildId, userId)
    .first<{ points: number }>();

  return row?.points ?? 0;
}

export async function getBoard(db: D1Database, guildId: string): Promise<ScoreRow[]> {
  const { results } = await db
    .prepare(
      `SELECT user_id, display_name, points
         FROM scores
        WHERE guild_id = ?
        ORDER BY points DESC, display_name ASC`,
    )
    .bind(guildId)
    .all<{ user_id: string; display_name: string; points: number }>();

  return results.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    points: row.points,
  }));
}

/** A member's score plus their ten most recent resolved cases as the accused. */
export async function getRecordFor(
  db: D1Database,
  guildId: string,
  userId: string,
): Promise<{ points: number; cases: Case[] }> {
  const points = await getScore(db, guildId, userId);

  const { results } = await db
    .prepare(
      `SELECT *
         FROM cases
        WHERE guild_id = ? AND accused_id = ? AND status != 'open'
        ORDER BY created_at DESC, id DESC
        LIMIT 10`,
    )
    .bind(guildId, userId)
    .all<CaseRow>();

  return { points, cases: results.map(toCase) };
}
