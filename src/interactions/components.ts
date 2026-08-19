import {
  ComponentType,
  InteractionResponseType,
  MessageFlags,
  TextInputStyle,
  type APILabelComponent,
  type APIMessageComponentInteraction,
  type APIModalInteractionResponseCallbackData,
} from 'discord-api-types/v10';
import { castVote, closeCase, getCase, getRecordFor, getSettings, getTally, touchName, updateSettings } from '../db.js';
import { DURATION_CHOICES, humanDuration, isDurationChoice } from '../durations.js';
import { caseButtons, caseEmbed, closedCaseEmbed, recordEmbed, rollView, settingsComponents, settingsEmbed } from '../embeds.js';
import { refreshHub, tagIdFor } from '../hub.js';
import type { BallotMode, CaseKind, GuildSettings, StandingMode } from '../types.js';
import { ensureTierRoles, resyncAllStanding, wantsNicknames, wantsRoles } from '../standing.js';
import {
  bestName,
  ephemeral,
  ephemeralEmbed,
  fetchMember,
  json,
  memberAvatarUrl,
  memberDisplayName,
  REASON_MAX,
  type Ctx,
} from './shared.js';

const SEVERITY_OPTIONS = {
  accuse: [
    { label: 'Petty offence (-1)', value: '1' },
    { label: 'Proper crime (-3)', value: '3' },
    { label: 'Heinous act (-5)', value: '5' },
  ],
  commend: [
    { label: 'Small kindness (+1)', value: '1' },
    { label: 'Good deed (+3)', value: '3' },
    { label: 'Act of heroism (+5)', value: '5' },
  ],
} as const;

const DURATION_OPTIONS = DURATION_CHOICES.map((m) => ({ label: humanDuration(m), value: String(m) }));

/** Big servers need real quorums, hence the ceiling well above the old 20. */
export const QUORUM_MIN = 2;
export const QUORUM_MAX = 100;

/** What the court says when the mode changes. */
const STANDING_CONFIRMATION: Record<StandingMode, string> = {
  roles: 'Standing is a role now. Coloured, hoisted, and swapped the moment a score crosses a line.',
  nicknames: 'Standing is a nickname suffix now, as "Sushi (130)".',
  both: 'Standing is a role and a nickname suffix now.',
  off: 'Standing is hidden. No roles, no numbers in names.',
};

function label(
  text: string,
  description: string | undefined,
  component: APILabelComponent['component'],
): APILabelComponent {
  return {
    type: ComponentType.Label,
    label: text,
    ...(description === undefined ? {} : { description }),
    component,
  };
}

/**
 * The filing modal. Five top-level Label components at most, each wrapping one
 * input; action rows in modals are on their way out.
 */
export function filingModal(kind: CaseKind): APIModalInteractionResponseCallbackData {
  const accusing = kind === 'accuse';

  return {
    custom_id: accusing ? 'file:accuse' : 'file:commend',
    title: accusing ? 'File a case' : 'Commend someone',
    components: [
      label(
        accusing ? 'The defendant' : 'The honouree',
        accusing ? 'Who has wronged you.' : 'Who deserves better than they are getting.',
        {
          type: ComponentType.UserSelect,
          custom_id: 'target',
          required: true,
          placeholder: accusing ? 'Name the accused' : 'Name the honouree',
        },
      ),
      label(
        accusing ? 'The charge' : 'The deed',
        `${REASON_MAX} characters max.`,
        {
          type: ComponentType.TextInput,
          custom_id: 'reason',
          style: TextInputStyle.Paragraph,
          required: true,
          max_length: REASON_MAX,
          placeholder: accusing
            ? 'ate one of my fries in maccies last night'
            : 'gave me the last of the chips without being asked',
        },
      ),
      label(
        accusing ? 'How serious is this?' : 'How generous was it?',
        undefined,
        {
          type: ComponentType.StringSelect,
          custom_id: 'severity',
          required: true,
          placeholder: accusing ? 'Pick a charge' : 'Pick a magnitude',
          options: [...SEVERITY_OPTIONS[accusing ? 'accuse' : 'commend']],
        },
      ),
      label('How long should the vote run?', 'Optional. Leave it and the court decides.', {
        type: ComponentType.StringSelect,
        custom_id: 'duration',
        required: false,
        placeholder: '6 hours unless told otherwise',
        options: [...DURATION_OPTIONS],
      }),
    ],
  };
}

export function quorumModal(ownerId: string, current: number): APIModalInteractionResponseCallbackData {
  return {
    custom_id: `setq:${ownerId}`,
    title: 'Set the quorum',
    components: [
      label('Votes needed for a verdict', 'From 2 to 100. Below quorum a case is dismissed.', {
        type: ComponentType.TextInput,
        custom_id: 'value',
        style: TextInputStyle.Short,
        required: true,
        max_length: 3,
        placeholder: String(current),
      }),
    ],
  };
}

export async function handleComponent(
  interaction: APIMessageComponentInteraction,
  c: Ctx,
): Promise<Response> {
  if (!interaction.guild_id || !interaction.member) {
    return ephemeral('The court only sits in a server.');
  }

  const customId = interaction.data.custom_id;

  if (customId.startsWith('set:')) return settingsChange(interaction, c, customId);
  if (customId.startsWith('roll:')) return roll(interaction, c, customId);
  if (customId.startsWith('vote:')) return vote(interaction, c, customId);
  if (customId.startsWith('withdraw:')) return withdraw(interaction, c, customId);
  if (customId === 'hub:file') {
    return json({ type: InteractionResponseType.Modal, data: filingModal('accuse') });
  }
  if (customId === 'hub:commend') {
    return json({ type: InteractionResponseType.Modal, data: filingModal('commend') });
  }
  if (customId === 'hub:record') return record(interaction, c);

  return ephemeral('That button does nothing. The court is as surprised as you are.');
}

function panelUpdate(updated: GuildSettings, ownerId: string): Response {
  return json({
    type: InteractionResponseType.UpdateMessage,
    data: { embeds: [settingsEmbed(updated)], components: settingsComponents(updated, ownerId) },
  });
}

async function settingsChange(
  interaction: APIMessageComponentInteraction,
  c: Ctx,
  customId: string,
): Promise<Response> {
  const [, field, ownerId] = customId.split(':');
  if (interaction.member!.user.id !== ownerId) {
    return ephemeral('This bench is not yours. Only the chief justice may sit here.');
  }
  const value = 'values' in interaction.data ? interaction.data.values[0] : undefined;
  if (!value || !field || !ownerId) {
    return ephemeral('That lever does nothing. The court is as surprised as you are.');
  }

  const { env, rest } = c;
  const db = env.DB;
  const guildId = interaction.guild_id!;
  if (field === 'ballot') {
    if (value !== 'public' && value !== 'anonymous' && value !== 'secret') {
      return ephemeral('That lever does nothing. The court is as surprised as you are.');
    }
    return panelUpdate(await updateSettings(db, guildId, { ballot: value as BallotMode }), ownerId);
  }
  if (field === 'window') {
    const minutes = Number(value);
    if (!isDurationChoice(minutes)) {
      return ephemeral('That lever does nothing. The court is as surprised as you are.');
    }
    return panelUpdate(await updateSettings(db, guildId, { defaultDurationMin: minutes }), ownerId);
  }
  if (field === 'quorum') {
    if (value === 'custom') {
      const current = await getSettings(db, guildId);
      return json({ type: InteractionResponseType.Modal, data: quorumModal(ownerId, current.quorum) });
    }
    const quorum = Number(value);
    if (!Number.isInteger(quorum) || quorum < QUORUM_MIN || quorum > QUORUM_MAX) {
      return ephemeral('That lever does nothing. The court is as surprised as you are.');
    }
    return panelUpdate(await updateSettings(db, guildId, { quorum }), ownerId);
  }
  if (field === 'standing') {
    if (value !== 'roles' && value !== 'nicknames' && value !== 'both' && value !== 'off') {
      return ephemeral('That lever does nothing. The court is as surprised as you are.');
    }
    const mode: StandingMode = value;
    c.ctx.waitUntil((async () => {
      // The mode has to land before anything is resynced: resyncing against
      // the old mode after a failed write would dress everyone up wrongly.
      try {
        await updateSettings(db, guildId, { standing: mode });
      } catch (err) {
        console.error('standing change failed', err);
        try {
          await rest.createFollowup(env.DISCORD_CLIENT_ID, interaction.token, {
            content: 'The change did not take. The clerk blames the filing cabinet. Try again.',
            flags: MessageFlags.Ephemeral,
          });
        } catch {
          // The interaction token has expired or Discord is unwell.
        }
        return;
      }

      const lines = [STANDING_CONFIRMATION[mode]];
      try {
        if (wantsRoles(mode)) lines.push(await ensureTierRoles(rest, db, guildId));
        if (wantsNicknames(mode)) {
          lines.push('I cannot rename the server owner, and I cannot rename anyone whose highest role sits above mine. They keep plain names.');
        }
        lines.push('Working through the board now.');
        const fresh = await getSettings(db, guildId);
        await rest.editOriginal(env.DISCORD_CLIENT_ID, interaction.token, {
          embeds: [settingsEmbed(fresh)],
          components: settingsComponents(fresh, ownerId),
        });
        await rest.createFollowup(env.DISCORD_CLIENT_ID, interaction.token, {
          content: lines.join('\n'),
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        console.error('standing change failed', err);
      }

      try {
        await resyncAllStanding(rest, db, guildId);
      } catch (err) {
        console.error('resyncAllStanding failed', err);
      }
    })());
    return json({ type: InteractionResponseType.DeferredMessageUpdate });
  }
  return ephemeral('That lever does nothing. The court is as surprised as you are.');
}

async function vote(
  interaction: APIMessageComponentInteraction,
  c: Ctx,
  customId: string,
): Promise<Response> {
  const { env, rest } = c;
  const db = env.DB;
  const guildId = interaction.guild_id!;
  const member = interaction.member!;

  const [, rawCaseId, rawChoice] = customId.split(':');
  const caseId = Number(rawCaseId);
  if (!Number.isInteger(caseId) || (rawChoice !== 'yes' && rawChoice !== 'no')) {
    return ephemeral('That ballot is unreadable.');
  }

  const filed = await getCase(db, caseId);
  if (!filed || filed.status !== 'open' || filed.deadline <= Date.now()) {
    return ephemeral('Voting has ended on this case.');
  }
  const settings = await getSettings(db, guildId);

  const voterId = member.user.id;
  const { tally, changed, already } = await castVote(db, caseId, voterId, rawChoice);
  await touchName(db, guildId, voterId, memberDisplayName(member) ?? member.user.username);

  const accused = await fetchMember(rest, guildId, filed.accusedId);
  const accusedName = await bestName(db, guildId, filed.accusedId, accused, null);
  const avatarUrl = memberAvatarUrl(guildId, filed.accusedId, accused);

  const line = already ? 'You have already voted.' : changed ? 'Vote changed.' : 'Vote recorded.';

  c.ctx.waitUntil(
    rest
      .createFollowup(env.DISCORD_CLIENT_ID, interaction.token, {
        content: line,
        flags: MessageFlags.Ephemeral,
      })
      .catch((err) => {
        console.error('vote followup failed', err);
      }),
  );

  return json({
    type: InteractionResponseType.UpdateMessage,
    data: {
      embeds: [caseEmbed(filed, tally, accusedName, avatarUrl, settings)],
      components: [caseButtons(filed, tally, false, settings.ballot)],
    },
  });
}

/**
 * The filer's escape hatch, next to the documented delete-the-post one. Voids
 * the case in place: no verdict, no points, and the post is tagged and
 * archived the same way a deletion would leave it.
 */
async function withdraw(
  interaction: APIMessageComponentInteraction,
  c: Ctx,
  customId: string,
): Promise<Response> {
  const { env, rest } = c;
  const db = env.DB;
  const guildId = interaction.guild_id!;
  const member = interaction.member!;

  const caseId = Number(customId.split(':')[1]);
  if (!Number.isInteger(caseId)) return ephemeral('That motion is unreadable.');

  const filed = await getCase(db, caseId);
  if (!filed || filed.status !== 'open' || filed.deadline <= Date.now()) {
    return ephemeral('This case is past withdrawing.');
  }
  if (member.user.id !== filed.accuserId) {
    return ephemeral('Only the filer may withdraw a case. You are welcome to vote instead.');
  }
  const settings = await getSettings(db, guildId);

  // The same open-only claim the cron uses, so a verdict and a withdrawal
  // cannot both land.
  if (!(await closeCase(db, filed.id, 'voided'))) {
    return ephemeral('This case just closed. The verdict stands.');
  }

  const tally = await getTally(db, filed.id);
  const accused = await fetchMember(rest, guildId, filed.accusedId);
  const accusedName = await bestName(db, guildId, filed.accusedId, accused, null);
  const avatarUrl = memberAvatarUrl(guildId, filed.accusedId, accused);

  // The tidy-up has to run in order: the case message must flip to its closed
  // state before the thread archives, because an archived thread refuses
  // edits. Answering with an UpdateMessage instead would race the archiving,
  // so the interaction is deferred and the edit made explicitly first.
  c.ctx.waitUntil(
    (async () => {
      if (filed.messageId) {
        try {
          await rest.editMessage(filed.channelId, filed.messageId, {
            embeds: [closedCaseEmbed(filed, tally, 'voided', accusedName, avatarUrl, settings.ballot)],
            components: [caseButtons(filed, tally, true, settings.ballot)],
          });
        } catch (err) {
          console.error(`editing withdrawn case ${filed.id} failed`, err);
        }
      }

      try {
        await rest.createMessage(filed.channelId, {
          content: 'The filer has withdrawn the case. The court pretends it never happened.',
        });
      } catch (err) {
        console.error(`posting the withdrawal note for case ${filed.id} failed`, err);
      }

      if (filed.messageId === filed.channelId) {
        const voidedTag = tagIdFor(settings, 'voided');
        if (voidedTag) {
          try {
            await rest.editChannel(filed.channelId, { applied_tags: [voidedTag] });
          } catch (err) {
            console.error(`tagging withdrawn case ${filed.id} failed`, err);
          }
        }
      }

      if (filed.messageId) {
        try {
          await rest.archiveThread(filed.messageId);
        } catch {
          // No thread, or no permission to touch it. The case is void either way.
        }
      }

      try {
        await refreshHub(rest, db, guildId);
      } catch (err) {
        console.error(`refreshing the hub after withdrawing case ${filed.id} failed`, err);
      }
    })(),
  );

  return json({ type: InteractionResponseType.DeferredMessageUpdate });
}

async function roll(
  interaction: APIMessageComponentInteraction,
  c: Ctx,
  customId: string,
): Promise<Response> {
  const parts = customId.split(':');
  const [, rawCaseId, rawPage] = parts;
  const caseId = Number(rawCaseId);
  const page = Number(rawPage);
  if (
    parts.length !== 3
    || rawCaseId === ''
    || rawPage === ''
    || !Number.isInteger(caseId)
    || !Number.isInteger(page)
  ) {
    return ephemeral('That ledger is unreadable.');
  }

  const db = c.env.DB;
  const filed = await getCase(db, caseId);
  if (!filed) return ephemeral('That case has left the record.');

  const settings = await getSettings(db, interaction.guild_id!);
  // The mode can change after the button was printed.
  if (settings.ballot !== 'public') {
    return ephemeral('The ballots are not public in this court.');
  }

  const tally = await getTally(db, caseId);
  if (tally.yes + tally.no === 0) return ephemeral('Nobody has voted yet.');

  const { embed, components } = rollView(filed, tally, page);
  // The case post is a regular channel message. The roll is the only
  // ephemeral message carrying roll ids.
  const fromRoll = ((interaction.message.flags ?? 0) & MessageFlags.Ephemeral) !== 0;
  return json({
    type: fromRoll
      ? InteractionResponseType.UpdateMessage
      : InteractionResponseType.ChannelMessageWithSource,
    data: {
      embeds: [embed],
      components,
      ...(fromRoll ? {} : { flags: MessageFlags.Ephemeral }),
    },
  });
}

async function record(interaction: APIMessageComponentInteraction, c: Ctx): Promise<Response> {
  const db = c.env.DB;
  const member = interaction.member!;
  const name = memberDisplayName(member) ?? member.user.username;

  const { points, cases } = await getRecordFor(db, interaction.guild_id!, member.user.id);
  await touchName(db, interaction.guild_id!, member.user.id, name);

  return ephemeralEmbed(recordEmbed(name, points, cases));
}
