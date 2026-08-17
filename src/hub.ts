import { ChannelType, SortOrderType, ThreadAutoArchiveDuration } from 'discord-api-types/v10';
import { RestError, type Rest } from './discord/rest.js';
import { getBoard, getOpenCasesByGuild, getSettings, updateSettings } from './db.js';
import { hubButtons, hubEmbed } from './embeds.js';
import { ensureTierRoles, wantsRoles } from './standing.js';
import type { GuildSettings } from './types.js';

/** SEND_MESSAGES */
const SEND_MESSAGES = '2048';
/** SEND_MESSAGES_IN_THREADS */
const SEND_MESSAGES_IN_THREADS = '274877906944';
/** VIEW_CHANNEL | SEND_MESSAGES | MANAGE_MESSAGES | EMBED_LINKS | READ_MESSAGE_HISTORY */
const BOT_CHANNEL_PERMISSIONS = '93184';
/** Overwrite target type for a role (@everyone is the guild id). */
const OVERWRITE_TYPE_ROLE = 0;
/** Overwrite target type for a single member. */
const OVERWRITE_TYPE_MEMBER = 1;
/** MessageType.ChannelPinnedMessage */
const PIN_NOTIFICATION = 6;

const SWEEP_LIMIT = 50;

/** Outcome tags on the cases forum. Names stay under Discord's 20 character cap. */
export const CASE_TAGS = [
  { key: 'open', name: 'Open' },
  { key: 'guilty', name: 'Guilty' },
  { key: 'not_guilty', name: 'Not guilty' },
  { key: 'dismissed', name: 'Dismissed' },
  { key: 'commended', name: 'Commended' },
  { key: 'rejected', name: 'Rejected' },
  { key: 'voided', name: 'Voided' },
] as const;

function everyoneOverwrite(guildId: string, isForum: boolean): Record<string, unknown> {
  return {
    id: guildId,
    type: OVERWRITE_TYPE_ROLE,
    allow: isForum ? SEND_MESSAGES_IN_THREADS : '0',
    deny: SEND_MESSAGES,
  };
}

function botOverwrite(botUserId: string): Record<string, unknown> {
  return {
    id: botUserId,
    type: OVERWRITE_TYPE_MEMBER,
    allow: BOT_CHANNEL_PERMISSIONS,
    deny: '0',
  };
}

/** The forum tag id for a key, when setup managed to record one. */
export function tagIdFor(settings: GuildSettings, key: string): string | null {
  return settings.tags?.[key] ?? null;
}

async function hubPayload(db: D1Database, guildId: string): Promise<{ embeds: unknown[]; components: unknown[] }> {
  const [board, openCases] = await Promise.all([getBoard(db, guildId), getOpenCasesByGuild(db, guildId)]);
  return { embeds: [hubEmbed(board, openCases, guildId)], components: [hubButtons()] };
}

/** Posts a fresh hub message, pins it if allowed, and records the new id. */
async function repostHub(rest: Rest, db: D1Database, guildId: string, channelId: string): Promise<string> {
  const message = await rest.createMessage(channelId, await hubPayload(db, guildId));
  const messageId = String(message.id);
  try {
    await rest.pinMessage(channelId, messageId);
  } catch {
    // Pinning is cosmetic. A missing Manage messages permission must not
    // stop the hub from existing.
  }
  await updateSettings(db, guildId, { hubMessageId: messageId });
  return messageId;
}

function isNotFound(err: unknown): boolean {
  return err instanceof RestError && err.status === 404;
}

function errorCode(err: unknown): number | null {
  if (!(err instanceof RestError) || err.body === null || typeof err.body !== 'object') return null;
  const code = (err.body as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

async function syncForumTags(rest: Rest, forumId: string): Promise<Record<string, string> | null> {
  try {
    const channel = await rest.getChannel(forumId);
    const existing = Array.isArray(channel?.available_tags) ? channel.available_tags : [];
    const ours = CASE_TAGS.map((wanted) => {
      const found = existing.find((tag: any) => tag?.name === wanted.name);
      return found ?? { name: wanted.name };
    });
    const names = new Set(CASE_TAGS.map((tag) => tag.name));
    const unrelated = existing.filter((tag: any) => typeof tag?.name === 'string' && !names.has(tag.name));
    const updated = await rest.editChannel(forumId, { available_tags: [...ours, ...unrelated].slice(0, 20) });
    const tags = Array.isArray(updated?.available_tags) ? updated.available_tags : [];
    const mapped: Record<string, string> = {};
    for (const wanted of CASE_TAGS) {
      const found = tags.find((tag: any) => tag?.name === wanted.name);
      if (typeof found?.id !== 'string') return null;
      mapped[wanted.key] = found.id;
    }
    return mapped;
  } catch {
    return null;
  }
}

async function lockChannel(
  rest: Rest,
  channelId: string,
  guildId: string,
  botUserId: string,
  isForum: boolean,
): Promise<boolean> {
  try {
    await rest.editChannelPermissions(channelId, botUserId, botOverwrite(botUserId));
  } catch {
    return false;
  }

  try {
    await rest.editChannelPermissions(channelId, guildId, everyoneOverwrite(guildId, isForum));
    return true;
  } catch {
    return false;
  }
}

export async function setupCourt(
  rest: Rest,
  db: D1Database,
  guildId: string,
  botUserId: string,
  chosen: { forumId: string | null; dashboardId: string | null },
): Promise<string> {
  if ((chosen.forumId === null) !== (chosen.dashboardId === null)) {
    return 'Name both the forum and the dashboard, or name neither and I will build them.';
  }

  const adopting = chosen.forumId !== null && chosen.dashboardId !== null;
  let categoryId: string | null = null;
  let dashboardId: string;
  let forumId: string;
  let dashboardLocked: boolean;
  let forumLocked: boolean;
  let tags: Record<string, string> | null;

  if (adopting) {
    dashboardId = chosen.dashboardId!;
    forumId = chosen.forumId!;
    tags = await syncForumTags(rest, forumId);
    dashboardLocked = await lockChannel(rest, dashboardId, guildId, botUserId, false);
    forumLocked = await lockChannel(rest, forumId, guildId, botUserId, true);
    try {
      const dashboard = await rest.getChannel(dashboardId);
      categoryId = typeof dashboard?.parent_id === 'string' ? dashboard.parent_id : null;
    } catch {
      categoryId = null;
    }
  } else {
    const category = await rest.createGuildChannel(guildId, {
      name: 'the court',
      type: ChannelType.GuildCategory,
      permission_overwrites: [everyoneOverwrite(guildId, false), botOverwrite(botUserId)],
    });
    categoryId = String(category.id);
    const dashboard = await rest.createGuildChannel(guildId, {
      name: 'courtroom',
      type: ChannelType.GuildText,
      parent_id: categoryId,
      permission_overwrites: [everyoneOverwrite(guildId, false), botOverwrite(botUserId)],
    });
    dashboardId = String(dashboard.id);
    dashboardLocked = true;
    try {
      const forum = await rest.createGuildChannel(guildId, {
        name: 'cases',
        type: ChannelType.GuildForum,
        parent_id: categoryId,
        permission_overwrites: [everyoneOverwrite(guildId, true), botOverwrite(botUserId)],
        available_tags: CASE_TAGS.map((tag) => ({ name: tag.name })),
        default_auto_archive_duration: ThreadAutoArchiveDuration.OneDay,
        default_sort_order: SortOrderType.LatestActivity,
      });
      forumId = String(forum.id);
      forumLocked = true;
      const availableTags = Array.isArray(forum?.available_tags) ? forum.available_tags : [];
      tags = {};
      for (const wanted of CASE_TAGS) {
        const found = availableTags.find((tag: any) => tag?.name === wanted.name);
        if (typeof found?.id !== 'string') {
          tags = null;
          break;
        }
        tags[wanted.key] = found.id;
      }
    } catch (err) {
      if (err instanceof RestError && (err.status === 403 || errorCode(err) === 50024)) {
        return [
          'I built the category and the dashboard, but Discord refused to let me create the forum channel. Some servers only allow forums through the interface.',
          'Make a forum channel yourself under the court category, then run /setup again naming both: /setup forum:#cases dashboard:#courtroom',
          'Nothing has been deleted. The dashboard is waiting.',
        ].join('\n');
      }
      throw err;
    }
  }

  const message = await rest.createMessage(dashboardId, await hubPayload(db, guildId));
  const messageId = String(message.id);

  let pinned = true;
  try {
    await rest.pinMessage(dashboardId, messageId);
  } catch {
    pinned = false;
  }

  const saved = await updateSettings(db, guildId, {
    categoryId,
    courtChannelId: dashboardId,
    forumChannelId: forumId,
    hubMessageId: messageId,
    tags,
  });

  const lines = [adopting ? 'The court has moved in.' : 'The court is built.'];
  lines.push(`Dashboard: <#${dashboardId}>`);
  lines.push(`Cases: <#${forumId}>`);
  if (adopting && tags !== null) {
    lines.push('Existing tags kept. Seven outcome tags are on the forum.');
  }
  lines.push(
    dashboardLocked
      ? 'Dashboard locked. Members can no longer post there.'
      : 'Warning: I could not lock the dashboard. I need Manage roles there, otherwise anyone can post. I leave it unlocked rather than lock myself out of it.',
  );
  lines.push(
    forumLocked
      ? 'Cases forum locked. Only I can open a case, but anyone can argue inside one.'
      : 'Warning: I could not lock the cases forum. I need Manage roles there, otherwise anyone can open a case by hand.',
  );
  lines.push(
    pinned
      ? 'Hub message pinned.'
      : 'Warning: I could not pin the hub message. I need Manage messages here. The hub still works unpinned.',
  );
  if (adopting && tags === null) {
    lines.push('Warning: I could not set the outcome tags on that forum. Cases will still work, they just will not be tagged.');
  }
  if (wantsRoles(saved.standing)) {
    lines.push(await ensureTierRoles(rest, db, guildId));
  }
  lines.push(
    'Administrators bypass the lock, so their messages still get through. The janitor sweep deletes anything in the dashboard that is not mine within a minute.',
  );

  return lines.join('\n');
}

/**
 * Redraws the hub after a score change. Self heals if somebody deleted the
 * message between the last write and now.
 */
export async function refreshHub(rest: Rest, db: D1Database, guildId: string): Promise<void> {
  const settings = await getSettings(db, guildId);
  if (!settings.courtChannelId || !settings.hubMessageId) return;

  try {
    await rest.editMessage(settings.courtChannelId, settings.hubMessageId, await hubPayload(db, guildId));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await repostHub(rest, db, guildId, settings.courtChannelId);
  }
}

/** Cron heal: confirms the hub message still exists, reposts it if not. */
export async function ensureHub(rest: Rest, db: D1Database, guildId: string): Promise<void> {
  const settings = await getSettings(db, guildId);
  if (!settings.courtChannelId || !settings.hubMessageId) return;

  try {
    await rest.getMessage(settings.courtChannelId, settings.hubMessageId);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await repostHub(rest, db, guildId, settings.courtChannelId);
  }
}

/**
 * The janitor. Admins bypass the channel lock, so this is what actually keeps
 * the courtroom clean: everything that is not a bot message goes, plus the
 * "someone pinned a message" system notices the bot's own pin generates.
 */
export async function sweepCourtChannel(rest: Rest, settings: GuildSettings, botUserId: string): Promise<void> {
  const channelId = settings.courtChannelId;
  if (!channelId) return;

  const messages = await rest.getMessages(channelId, SWEEP_LIMIT);

  for (const message of messages) {
    const messageId = message?.id as string | undefined;
    if (!messageId) continue;
    if (messageId === settings.hubMessageId) continue;

    const isOurs = message?.author?.id === botUserId;
    const isPinNotice = message?.type === PIN_NOTIFICATION;
    if (isOurs && !isPinNotice) continue;

    try {
      await rest.deleteMessage(channelId, messageId);
    } catch {
      // Already gone, or somebody's message we cannot touch. Either way the
      // next sweep gets another go.
    }
  }
}
