import { applyPoints, closeCase, getOpenCases, getSettings, getTally } from './db.js';
import { RestError, type Rest } from './discord/rest.js';
import { caseButtons, closedCaseEmbed } from './embeds.js';
import { refreshHub, tagIdFor } from './hub.js';
import { bestName, fetchMember, memberAvatarUrl } from './interactions/shared.js';
import { syncStanding } from './standing.js';
import type { Case, CaseStatus, Env, VoteTally } from './types.js';

function isNotFound(err: unknown): boolean {
  return err instanceof RestError && err.status === 404;
}

/** Quorum first, then the count. A tie acquits. */
function verdictFor(tally: VoteTally, quorum: number): Exclude<CaseStatus, 'open' | 'voided'> {
  if (tally.yes + tally.no < quorum) return 'dismissed';
  return tally.yes > tally.no ? 'passed' : 'failed';
}

function verdictText(
  filed: Case,
  status: CaseStatus,
  newTotal: number,
  tally: VoteTally,
  quorum: number,
): string {
  if (status === 'dismissed') {
    const prefix =
      filed.messageId === filed.channelId ? 'Dismissed.' : `Case #${filed.number} dismissed.`;
    return `${prefix} ${tally.yes + tally.no} votes, quorum is ${quorum}.`;
  }

  if (filed.kind === 'accuse') {
    return status === 'passed'
      ? `🔨 Guilty. <@${filed.accusedId}> loses ${filed.points} points (now at ${newTotal}).`
      : 'Not guilty.';
  }

  return status === 'passed'
    ? `Motion carries. <@${filed.accusedId}> gains ${filed.points} points (now at ${newTotal}).`
    : 'Motion denied.';
}

function outcomeTagKey(filed: Case, status: CaseStatus): string {
  if (status === 'passed') return filed.kind === 'accuse' ? 'guilty' : 'commended';
  if (status === 'failed') return filed.kind === 'accuse' ? 'not_guilty' : 'rejected';
  return status;
}

/**
 * Called once a minute by the cron. It resolves cases whose deadline has passed
 * and voids cases whose message was deleted, so a deletion takes effect on the
 * next pass rather than waiting for the deadline. Every case is isolated: one
 * broken verdict must not hold up the rest of the docket.
 */
export async function resolveDueCases(env: Env, rest: Rest): Promise<void> {
  const open = await getOpenCases(env.DB);
  const now = Date.now();

  for (const filed of open) {
    try {
      await sweepCase(env, rest, filed, now);
    } catch (err) {
      console.error(`resolving case ${filed.id} failed`, err);
    }
  }
}

/** One message existence check per open case per tick, then void or resolve. */
async function sweepCase(env: Env, rest: Rest, filed: Case, now: number): Promise<void> {
  const db = env.DB;
  const past = filed.deadline <= now;

  // A case is briefly message-less between createCase and setCasePost, so
  // only an overdue case with no message is genuinely lost.
  if (!filed.messageId) {
    if (past) await closeCase(db, filed.id, 'voided');
    return;
  }

  try {
    await rest.getMessage(filed.channelId, filed.messageId);
  } catch (err) {
    if (!isNotFound(err)) throw err;

    // The documented escape hatch: delete the case message and the whole thing
    // never happened. No verdict, no points, and the discussion gets tidied up.
    await closeCase(db, filed.id, 'voided');
    if (filed.messageId === filed.channelId) {
      const settings = await getSettings(db, filed.guildId);
      const voidedTag = tagIdFor(settings, 'voided');
      if (voidedTag) {
        try {
          await rest.editChannel(filed.channelId, { applied_tags: [voidedTag] });
        } catch {
          // A deleted forum post cannot accept its outcome tag.
        }
      }
    } else {
      try {
        await rest.archiveThread(filed.messageId);
      } catch {
        // No thread, or no permission to touch it. The case is void either way.
      }
    }
    try {
      await refreshHub(rest, db, filed.guildId);
    } catch (refreshError) {
      console.error(`refreshing the hub after voiding case ${filed.id} failed`, refreshError);
    }
    return;
  }

  if (!past) return;

  await resolveCase(env, rest, filed, filed.messageId);
}

async function resolveCase(
  env: Env,
  rest: Rest,
  filed: Case,
  messageId: string,
): Promise<void> {
  const db = env.DB;

  const settings = await getSettings(db, filed.guildId);
  const tally = await getTally(db, filed.id);
  const status = verdictFor(tally, settings.quorum);

  // Claim the case before spending points or posting anything, so a racing
  // cron invocation cannot double up the verdict.
  if (!(await closeCase(db, filed.id, status))) return;

  const member = await fetchMember(rest, filed.guildId, filed.accusedId);
  const accusedName = await bestName(db, filed.guildId, filed.accusedId, member, null);
  const avatarUrl = memberAvatarUrl(filed.guildId, filed.accusedId, member);

  let newTotal = 0;
  if (status === 'passed') {
    const delta = filed.kind === 'accuse' ? -filed.points : filed.points;
    newTotal = await applyPoints(db, filed.guildId, filed.accusedId, delta, accusedName);

    try {
      await syncStanding(rest, db, filed.guildId, filed.accusedId);
    } catch (err) {
      console.error(`standing sync after case ${filed.id} failed`, err);
    }
  }

  // Every outcome leaves the hub stale: the case drops off the open list even
  // when no points changed hands.
  try {
    await refreshHub(rest, db, filed.guildId);
  } catch (err) {
    console.error(`refreshing the hub after case ${filed.id} failed`, err);
  }

  const forumCase = filed.messageId === filed.channelId;
  if (forumCase) {
    // A quiet case can auto-archive on the same schedule as its own deadline,
    // and an archived thread refuses message edits and new messages. Waking it
    // first costs one call and is a no-op when it was never asleep. Unarchiving
    // is the one thread edit that does not need Manage threads.
    try {
      await rest.editChannel(messageId, { archived: false });
    } catch (err) {
      console.error(`waking the forum post for case ${filed.id} failed`, err);
    }

    try {
      await rest.editMessage(messageId, messageId, {
        embeds: [closedCaseEmbed(filed, tally, status, accusedName, avatarUrl)],
        components: [caseButtons(filed, tally, true)],
      });
    } catch (err) {
      console.error(`editing the forum post for case ${filed.id} failed`, err);
    }

    try {
      await rest.createMessage(messageId, {
        content: verdictText(filed, status, newTotal, tally, settings.quorum),
        allowed_mentions: { users: [filed.accusedId] },
      });
    } catch (err) {
      console.error(`posting the verdict for case ${filed.id} failed`, err);
    }

    const outcomeTag = tagIdFor(settings, outcomeTagKey(filed, status));
    if (outcomeTag) {
      try {
        await rest.editChannel(messageId, { applied_tags: [outcomeTag] });
      } catch (err) {
        console.error(`tagging case ${filed.id} failed`, err);
      }
    }

    try {
      await rest.editChannel(messageId, { archived: true });
    } catch (err) {
      console.error(`archiving case ${filed.id} failed`, err);
    }
  } else {
    try {
      await rest.editMessage(filed.channelId, messageId, {
        embeds: [closedCaseEmbed(filed, tally, status, accusedName, avatarUrl)],
        components: [caseButtons(filed, tally, true)],
      });
    } catch (err) {
      console.error(`editing the message for case ${filed.id} failed`, err);
    }

    try {
      await rest.createMessage(filed.channelId, {
        content: verdictText(filed, status, newTotal, tally, settings.quorum),
        message_reference: {
          message_id: messageId,
          channel_id: filed.channelId,
          guild_id: filed.guildId,
          fail_if_not_exists: false,
        },
        allowed_mentions: { users: [filed.accusedId] },
      });
    } catch (err) {
      console.error(`posting the verdict for case ${filed.id} failed`, err);
    }

    try {
      await rest.archiveThread(messageId);
    } catch {
      // No thread, or no permission to touch it. Either way the verdict stands.
    }
  }
}
