import {
  ComponentType,
  InteractionResponseType,
  MessageFlags,
  TextInputStyle,
  type APILabelComponent,
  type APIMessageComponentInteraction,
  type APIModalInteractionResponseCallbackData,
} from 'discord-api-types/v10';
import { castVote, getCase, getRecordFor, touchName } from '../db.js';
import { caseButtons, caseEmbed, recordEmbed } from '../embeds.js';
import type { CaseKind } from '../types.js';
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

const DURATION_OPTIONS = [
  { label: '10 minutes', value: '10' },
  { label: '1 hour', value: '60' },
  { label: '6 hours', value: '360' },
  { label: '24 hours', value: '1440' },
] as const;

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

export async function handleComponent(
  interaction: APIMessageComponentInteraction,
  c: Ctx,
): Promise<Response> {
  if (!interaction.guild_id || !interaction.member) {
    return ephemeral('The court only sits in a server.');
  }

  const customId = interaction.data.custom_id;

  if (customId.startsWith('vote:')) return vote(interaction, c, customId);
  if (customId === 'hub:file') {
    return json({ type: InteractionResponseType.Modal, data: filingModal('accuse') });
  }
  if (customId === 'hub:commend') {
    return json({ type: InteractionResponseType.Modal, data: filingModal('commend') });
  }
  if (customId === 'hub:record') return record(interaction, c);

  return ephemeral('That button does nothing. The court is as surprised as you are.');
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
      embeds: [caseEmbed(filed, tally, accusedName, avatarUrl)],
      components: [caseButtons(filed, tally, false)],
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
