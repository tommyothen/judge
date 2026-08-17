import { RestError, type Rest } from './discord/rest.js';
import { getBoard, getScore } from './db.js';

/** Discord caps nicknames at 32 characters. */
const NICK_LIMIT = 32;
/** Trailing score suffix we own, for example " (130)" or " (-12)". */
const SCORE_SUFFIX = /\s*\(-?\d+\)$/;

const AUDIT_REASON = 'Judge score sync';

/** Missing permission (role hierarchy, or the guild owner) and unknown member. */
function isIgnorable(err: unknown): boolean {
  return err instanceof RestError && (err.status === 403 || err.status === 404);
}

function stripSuffix(name: string): string {
  return name.replace(SCORE_SUFFIX, '').trim();
}

/** Name the member would have with no Judge suffix attached. */
function baseNameOf(member: any): string {
  const raw = member?.nick ?? member?.user?.global_name ?? member?.user?.username ?? '';
  return stripSuffix(String(raw));
}

/** Their plain Discord name, used to decide whether a nick can be cleared. */
function accountNameOf(member: any): string {
  const raw = member?.user?.global_name ?? member?.user?.username ?? '';
  return String(raw);
}

function withScore(base: string, points: number): string {
  const suffix = ` (${points})`;
  const room = NICK_LIMIT - suffix.length;
  if (room <= 0) return `${base}${suffix}`.slice(0, NICK_LIMIT);
  const trimmed = base.length > room ? base.slice(0, room).trimEnd() : base;
  return `${trimmed}${suffix}`;
}

/**
 * Writes one member's score into their nickname. Whether the guild wants this at
 * all is standing.ts's decision; this is only the how.
 */
export async function syncNickname(rest: Rest, db: D1Database, guildId: string, userId: string): Promise<void> {
  try {
    const member = await rest.getGuildMember(guildId, userId);
    const points = await getScore(db, guildId, userId);
    const target = withScore(baseNameOf(member), points);

    if (member?.nick === target) return;
    await rest.editGuildMember(guildId, userId, { nick: target }, AUDIT_REASON);
  } catch (err) {
    if (isIgnorable(err)) return;
    throw err;
  }
}

/**
 * Strips the score suffix from everyone on the board. Used when nickname sync
 * is turned off, so the server is not left full of stale numbers.
 */
export async function clearAllNicknames(rest: Rest, db: D1Database, guildId: string): Promise<void> {
  const board = await getBoard(db, guildId);

  for (const row of board) {
    try {
      const member = await rest.getGuildMember(guildId, row.userId);
      const current = member?.nick;
      if (typeof current !== 'string' || current.length === 0) continue;

      const stripped = stripSuffix(current);
      if (stripped === current) continue;

      // Clearing the nick entirely is tidier than restoring a nick that only
      // ever existed because we wrote it.
      const next = stripped.length === 0 || stripped === accountNameOf(member) ? null : stripped;
      await rest.editGuildMember(guildId, row.userId, { nick: next }, AUDIT_REASON);
    } catch (err) {
      if (isIgnorable(err)) continue;
      throw err;
    }
  }
}
