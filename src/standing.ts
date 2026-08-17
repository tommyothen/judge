import { getBoard, getScore, getSettings, updateSettings } from './db.js';
import { RestError, type Rest } from './discord/rest.js';
import { TIERS, tierFor } from './flavor.js';
import { clearAllNicknames, syncNickname } from './nicknames.js';
import type { GuildSettings, StandingMode } from './types.js';

const AUDIT_REASON = 'Judge standing';

/** Missing permission (role hierarchy, or the guild owner) and unknown member. */
function isIgnorable(err: unknown): boolean {
  return err instanceof RestError && (err.status === 403 || err.status === 404);
}

export function wantsRoles(mode: StandingMode): boolean {
  return mode === 'roles' || mode === 'both';
}

export function wantsNicknames(mode: StandingMode): boolean {
  return mode === 'nicknames' || mode === 'both';
}

/**
 * Puts the tier roles best-highest, just under the bot's own role. Discord will
 * not let the bot hand out a role above itself, so the top of the stack is the
 * bot's own position minus one.
 */
async function orderTierRoles(rest: Rest, guildId: string, tierRoles: Record<string, string>): Promise<void> {
  const self = await rest.getSelfMember(guildId);
  const worn = new Set<string>((Array.isArray(self?.roles) ? self.roles : []).map(String));
  const roles = await rest.getGuildRoles(guildId);

  let highest = 0;
  for (const role of roles) {
    if (!worn.has(String(role?.id))) continue;
    const position = typeof role?.position === 'number' ? role.position : 0;
    if (position > highest) highest = position;
  }

  // Leaving room for every tier keeps the lowest one above @everyone at zero.
  const top = Math.max(highest - 1, TIERS.length);
  const payload = TIERS.map((tier, i) => ({ id: tierRoles[tier.key], position: top - i })).filter(
    (entry) => typeof entry.id === 'string',
  );

  await rest.editRolePositions(guildId, payload);
}

/**
 * Makes sure a role exists for every tier, adopting any role already named after
 * one, and records the key to role id map. Returns a line for the setup report.
 */
export async function ensureTierRoles(rest: Rest, db: D1Database, guildId: string): Promise<string> {
  let existing: any[];
  try {
    existing = await rest.getGuildRoles(guildId);
  } catch {
    return "Warning: I could not read this server's roles, so nobody has a standing role. I need Manage roles.";
  }

  const tierRoles: Record<string, string> = {};
  let adopted = 0;
  let created = 0;

  for (const tier of TIERS) {
    const found = existing.find((role: any) => role?.name === tier.title && typeof role?.id === 'string');
    if (found) {
      tierRoles[tier.key] = String(found.id);
      adopted += 1;
      continue;
    }

    try {
      const role = await rest.createGuildRole(
        guildId,
        { name: tier.title, color: tier.color, hoist: true, permissions: '0', mentionable: false },
        AUDIT_REASON,
      );
      if (typeof role?.id !== 'string') {
        return 'Warning: Discord accepted the standing roles but would not say what they are. Try /settings standing roles again.';
      }
      tierRoles[tier.key] = String(role.id);
      created += 1;
    } catch {
      return 'Warning: I could not create the standing roles. I need Manage roles, and my own role has to sit above the ones I hand out.';
    }
  }

  await updateSettings(db, guildId, { tierRoles });

  try {
    await orderTierRoles(rest, guildId, tierRoles);
  } catch {
    // Ordering is cosmetic. The roles are hoisted either way, so the member
    // list still groups by standing; the groups just may not be in rank order.
  }

  return `Standing roles ready: ${created} created, ${adopted} adopted. The member list now groups by standing.`;
}

/** Swaps a member onto the role their score earns and strips the others. */
async function applyTierRole(
  rest: Rest,
  db: D1Database,
  guildId: string,
  userId: string,
  tierRoles: Record<string, string>,
): Promise<void> {
  const ours = new Set(Object.values(tierRoles));

  try {
    const member = await rest.getGuildMember(guildId, userId);
    const points = await getScore(db, guildId, userId);
    const wanted = tierRoles[tierFor(points).key];
    const held: string[] = (Array.isArray(member?.roles) ? member.roles : []).map(String);

    if (wanted && !held.includes(wanted)) {
      await rest.addMemberRole(guildId, userId, wanted, AUDIT_REASON);
    }
    for (const roleId of held) {
      if (roleId === wanted || !ours.has(roleId)) continue;
      await rest.removeMemberRole(guildId, userId, roleId, AUDIT_REASON);
    }
  } catch (err) {
    if (isIgnorable(err)) return;
    throw err;
  }
}

/** Takes every tier role off a member, for when the guild stops using them. */
async function stripTierRoles(
  rest: Rest,
  guildId: string,
  userId: string,
  tierRoles: Record<string, string>,
): Promise<void> {
  const ours = new Set(Object.values(tierRoles));

  try {
    const member = await rest.getGuildMember(guildId, userId);
    const held: string[] = (Array.isArray(member?.roles) ? member.roles : []).map(String);
    for (const roleId of held) {
      if (!ours.has(roleId)) continue;
      await rest.removeMemberRole(guildId, userId, roleId, AUDIT_REASON);
    }
  } catch (err) {
    if (isIgnorable(err)) return;
    throw err;
  }
}

async function applyStanding(
  rest: Rest,
  db: D1Database,
  guildId: string,
  userId: string,
  settings: GuildSettings,
): Promise<void> {
  if (wantsRoles(settings.standing) && settings.tierRoles) {
    await applyTierRole(rest, db, guildId, userId, settings.tierRoles);
  }
  if (wantsNicknames(settings.standing)) {
    await syncNickname(rest, db, guildId, userId);
  }
}

/** Brings one member's role and nickname into line with their score. */
export async function syncStanding(rest: Rest, db: D1Database, guildId: string, userId: string): Promise<void> {
  await applyStanding(rest, db, guildId, userId, await getSettings(db, guildId));
}

/**
 * Walks the whole board after a mode change. Anything the new mode no longer
 * wants is taken back off, so a server is never left with stale numbers in
 * names or a colour nobody earned.
 */
export async function resyncAllStanding(rest: Rest, db: D1Database, guildId: string): Promise<void> {
  const settings = await getSettings(db, guildId);
  const board = await getBoard(db, guildId);

  for (const row of board) {
    try {
      await applyStanding(rest, db, guildId, row.userId, settings);
    } catch (err) {
      console.error('standing sync failed', row.userId, err);
    }
  }

  if (!wantsNicknames(settings.standing)) {
    try {
      await clearAllNicknames(rest, db, guildId);
    } catch (err) {
      console.error('clearing nicknames failed', guildId, err);
    }
  }

  if (!wantsRoles(settings.standing) && settings.tierRoles) {
    for (const row of board) {
      try {
        await stripTierRoles(rest, guildId, row.userId, settings.tierRoles);
      } catch (err) {
        console.error('stripping tier roles failed', row.userId, err);
      }
    }
  }
}
