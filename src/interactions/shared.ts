import {
  InteractionResponseType,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type APIEmbed,
  type APIInteractionResponse,
} from 'discord-api-types/v10';
import {
  castVote,
  countOpenCasesByAccuser,
  createCase,
  getBoard,
  getSettings,
  hasOpenCaseAgainst,
  setCasePost,
  touchName,
} from '../db.js';
import type { Rest } from '../discord/rest.js';
import { caseButtons, caseEmbed } from '../embeds.js';
import { refreshHub, tagIdFor } from '../hub.js';
import type { CaseKind, Env } from '../types.js';

/** Everything a handler needs: bindings, a REST client, and the request lifetime. */
export interface Ctx {
  env: Env;
  rest: Rest;
  ctx: ExecutionContext;
}

export const REASON_MAX = 200;
/** The three severity and magnitude tiers, as points. */
export const POINT_TIERS = [1, 3, 5] as const;
/** Vote windows offered anywhere a duration can be chosen. */
export const DURATION_CHOICES = [10, 60, 360, 1440] as const;

/** Nickname sync writes " (12)" onto names; never store that back as a display name. */
const SCORE_SUFFIX = /\s*\(-?\d+\)$/;

// ---------------------------------------------------------------------------
// Interaction responses
// ---------------------------------------------------------------------------

export function json(payload: APIInteractionResponse): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
  });
}

export function ephemeral(content: string): Response {
  return json({
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content, flags: MessageFlags.Ephemeral },
  });
}

export function ephemeralEmbed(embed: APIEmbed): Response {
  return json({
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { embeds: [embed], flags: MessageFlags.Ephemeral },
  });
}

/** Buys five extra minutes of budget for the REST-heavy work in waitUntil. */
export function deferEphemeral(): Response {
  return json({
    type: InteractionResponseType.DeferredChannelMessageWithSource,
    data: { flags: MessageFlags.Ephemeral },
  });
}

// ---------------------------------------------------------------------------
// Names and avatars
// ---------------------------------------------------------------------------

export function stripScoreSuffix(name: string): string {
  return name.replace(SCORE_SUFFIX, '').trim();
}

/** Server nickname first, then the account's display name, then the username. */
export function memberDisplayName(member: any): string | null {
  const candidates = [member?.nick, member?.user?.global_name, member?.user?.username];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const clean = stripScoreSuffix(candidate);
    if (clean.length > 0) return clean;
  }
  return null;
}

/** Guild avatar if they have one, otherwise the account avatar, otherwise nothing. */
export function memberAvatarUrl(guildId: string, userId: string, member: any): string | null {
  const guildAvatar = member?.avatar;
  if (typeof guildAvatar === 'string' && guildAvatar.length > 0) {
    return `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${guildAvatar}.png?size=128`;
  }
  const userAvatar = member?.user?.avatar;
  if (typeof userAvatar === 'string' && userAvatar.length > 0) {
    return `https://cdn.discordapp.com/avatars/${userId}/${userAvatar}.png?size=128`;
  }
  return null;
}

/** Name pulled from the interaction's resolved data, when Discord bothered to send it. */
export function resolvedDisplayName(resolved: any, userId: string): string | null {
  const nick = resolved?.members?.[userId]?.nick;
  if (typeof nick === 'string' && nick.trim().length > 0) return stripScoreSuffix(nick);
  const user = resolved?.users?.[userId];
  return memberDisplayName({ user });
}

export function resolvedIsBot(resolved: any, userId: string): boolean {
  return resolved?.users?.[userId]?.bot === true;
}

/** Last resort: whatever name we cached the last time they scored. */
export async function storedName(db: D1Database, guildId: string, userId: string): Promise<string | null> {
  const board = await getBoard(db, guildId);
  return board.find((row) => row.userId === userId)?.displayName ?? null;
}

/** One member fetch, best effort, for a name and a face. */
export async function fetchMember(rest: Rest, guildId: string, userId: string): Promise<any> {
  try {
    return await rest.getGuildMember(guildId, userId);
  } catch {
    return null;
  }
}

/**
 * Best available display name. The final fallback is kind-neutral because the
 * same helper names defendants and honourees.
 */
export async function bestName(
  db: D1Database,
  guildId: string,
  userId: string,
  member: any,
  hint: string | null,
): Promise<string> {
  return (
    memberDisplayName(member) ?? hint ?? (await storedName(db, guildId, userId)) ?? 'a member of this server'
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function humanDuration(minutes: number): string {
  if (minutes === 60) return '1 hour';
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? '24 hours' : `${days} days`;
  }
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

export function isPointTier(value: number): boolean {
  return (POINT_TIERS as readonly number[]).includes(value);
}

export function isDurationChoice(value: number): boolean {
  return (DURATION_CHOICES as readonly number[]).includes(value);
}

// ---------------------------------------------------------------------------
// Filing, shared by the slash commands and the hub modals
// ---------------------------------------------------------------------------

export interface FilingRequest {
  kind: CaseKind;
  guildId: string;
  invokedChannelId: string | null;
  accuserId: string;
  accuserName: string;
  accusedId: string;
  accusedNameHint: string | null;
  accusedIsBotHint: boolean;
  reason: string;
  points: number;
  /** Null means whatever the guild's default is. */
  durationMin: number | null;
  token: string;
}

/** Discord caps forum post names at 100 characters. */
const POST_NAME_MAX = 100;

/**
 * The whole filing flow, run inside waitUntil after a deferred ephemeral reply.
 * Every exit edits the original response, so the user always hears something
 * back even when the court refuses to take the case.
 */
export async function runFiling(c: Ctx, req: FilingRequest): Promise<void> {
  const { env, rest } = c;
  const db = env.DB;
  const reply = (content: string) => rest.editOriginal(env.DISCORD_CLIENT_ID, req.token, { content });

  try {
    if (req.accusedId === env.DISCORD_CLIENT_ID) {
      await reply('The court is beyond reproach.');
      return;
    }

    const member = await fetchMember(rest, req.guildId, req.accusedId);
    if (member?.user?.bot === true || req.accusedIsBotHint) {
      await reply('The court does not try robots.');
      return;
    }

    const reason = req.reason.trim().slice(0, REASON_MAX);
    if (reason.length === 0) {
      await reply('You have filed a blank page. The court needs something to read.');
      return;
    }

    if (req.kind === 'accuse') {
      const open = await countOpenCasesByAccuser(db, req.guildId, req.accuserId);
      if (open >= 2) {
        await reply('You have enough open lawsuits already. Let one conclude first.');
        return;
      }
      if (await hasOpenCaseAgainst(db, req.guildId, req.accuserId, req.accusedId)) {
        await reply('You already have a case open against them. One grievance at a time.');
        return;
      }
    } else if (req.accuserId === req.accusedId) {
      await reply('You cannot commend yourself. The court admires the confidence.');
      return;
    }

    const settings = await getSettings(db, req.guildId);
    const durationMin = req.durationMin ?? settings.defaultDurationMin;
    if (!settings.forumChannelId) {
      await reply('The court has nowhere to sit. Ask the server owner to run /setup.');
      return;
    }

    const accusedName = await bestName(db, req.guildId, req.accusedId, member, req.accusedNameHint);

    const filed = await createCase(db, {
      guildId: req.guildId,
      channelId: settings.forumChannelId,
      kind: req.kind,
      accuserId: req.accuserId,
      accusedId: req.accusedId,
      reason,
      points: req.points,
      deadline: Date.now() + durationMin * 60_000,
    });

    // The filer's own vote is implied by filing at all.
    const { tally } = await castVote(db, filed.id, req.accuserId, 'yes');
    await touchName(db, req.guildId, req.accuserId, req.accuserName);
    await touchName(db, req.guildId, req.accusedId, accusedName);

    const avatarUrl = memberAvatarUrl(req.guildId, req.accusedId, member);
    const postName = (
      req.kind === 'accuse'
        ? `Case #${filed.number}: The People vs ${accusedName}`
        : `Case #${filed.number}: In praise of ${accusedName}`
    ).slice(0, POST_NAME_MAX);
    const openTag = tagIdFor(settings, 'open');
    const post = await rest.createForumPost(settings.forumChannelId, {
      name: postName,
      auto_archive_duration: ThreadAutoArchiveDuration.OneDay,
      applied_tags: openTag ? [openTag] : [],
      message: {
        embeds: [caseEmbed(filed, tally, accusedName, avatarUrl)],
        components: [caseButtons(filed, tally, false)],
      },
    });
    const threadId = String(post.id);
    await setCasePost(db, filed.id, threadId);

    try {
      await refreshHub(rest, db, req.guildId);
    } catch (err) {
      console.error(`refreshing the hub after filing case ${filed.id} failed`, err);
    }

    const conscience =
      req.accuserId === req.accusedId ? ' The court admires a guilty conscience.' : '';
    const url = `https://discord.com/channels/${req.guildId}/${threadId}`;
    await reply(`Case #${filed.number} filed. The court will hear it.${conscience} ${url}`);
  } catch (err) {
    console.error('filing failed', err);
    try {
      await reply('The filing did not take. The clerk blames the paperwork. Try again.');
    } catch {
      // The interaction token has expired or Discord is unwell. Nothing left to do.
    }
  }
}
