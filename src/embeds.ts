import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIEmbedField,
} from 'discord-api-types/v10';
import { DURATION_CHOICES, humanDuration } from './durations.js';
import { titleFor } from './flavor.js';
import type { BallotMode, Case, CaseStatus, GuildSettings, ScoreRow, StandingMode, VoteTally } from './types.js';

const COLOUR = {
  /** open accusation */
  amber: 0xd4a017,
  /** open commendation */
  blue: 0x4a7ebb,
  /** guilty */
  red: 0xb63d3d,
  /** commendation carried */
  green: 0x3fa45b,
  /** failed, dismissed, voided */
  grey: 0x6b6f76,
  /** hub and record */
  parchment: 0xc8a165,
} as const;

const BOARD_ROWS = 15;
const OPEN_CASE_ROWS = 10;
const RECORD_ROWS = 10;
const REASON_LINE_MAX = 60;

function truncate(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(max - 3, 1)).trimEnd()}...`;
}

/** Backslash-escapes the markdown Discord renders inside embed descriptions. */
function escapeMd(text: string): string {
  return text.replace(/[\\`*_~|[\]]/g, '\\$&');
}

/**
 * A reason keeps its markdown, that is half the fun, but masked links do not
 * survive: [free nitro](https://evil.example) on a public embed is a phishing
 * surface, so the brackets are escaped and the mask falls apart.
 */
function unmaskLinks(text: string): string {
  return text.replace(/[[\]]/g, '\\$&');
}

/** Keeps a multi-line reason inside the markdown quote block. */
function asQuote(reason: string): string {
  return `> ${unmaskLinks(truncate(reason, 900)).replace(/\r?\n/g, '\n> ')}`;
}

function seconds(epochMs: number): number {
  return Math.floor(epochMs / 1000);
}

function voteLabels(kind: Case['kind']): { yes: string; no: string } {
  return kind === 'accuse'
    ? { yes: 'Guilty', no: 'Not guilty' }
    : { yes: 'Seconded', no: 'Overruled' };
}

function tallyValue(kind: Case['kind'], tally: VoteTally): string {
  const labels = voteLabels(kind);
  return `${labels.yes} ${tally.yes} · ${labels.no} ${tally.no}`;
}

/** Below this many votes the raw counts speak for themselves. */
const BAR_MIN_VOTES = 25;

function voteBar(kind: Case['kind'], tally: VoteTally): string {
  const total = tally.yes + tally.no;
  const pct = Math.round((tally.yes / total) * 100);
  const filled = Math.round((tally.yes / total) * 10);
  const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled);
  return `${bar} ${pct}% ${voteLabels(kind).yes.toLowerCase()}`;
}

/**
 * A side inside the cap is listed in full. Past it, the embed defers to the
 * roll because the first 20 of 630 names is trivia and the field has a
 * 1024-character budget anyway.
 */
const JURY_SHOWN_MAX = 20;

function juryLine(label: string, voters: string[]): string {
  if (voters.length === 0) return `${label} · nobody`;
  if (voters.length > JURY_SHOWN_MAX) return `${label} · ${voters.length} names on the roll`;
  return `${label} · ${voters.map((id) => `<@${id}>`).join(' ')}`;
}

function juryField(kind: Case['kind'], tally: VoteTally): APIEmbedField {
  const labels = voteLabels(kind);
  return {
    name: 'The jury',
    value: `${juryLine(labels.yes, tally.yesVoters)}\n${juryLine(labels.no, tally.noVoters)}`,
  };
}

function stakesValue(c: Case): string {
  const sign = c.kind === 'accuse' ? '-' : '+';
  return `${sign}${c.points} points`;
}

function baseEmbed(c: Case, accusedName: string, accusedAvatarUrl: string | null): APIEmbed {
  const name = truncate(accusedName, 80);
  const embed: APIEmbed = {
    author: {
      name: c.kind === 'accuse' ? '⚖️ The court is in session' : '⚖️ Motion to commend',
    },
    title:
      c.kind === 'accuse'
        ? `Case #${c.number}: The People vs ${name}`
        : `Case #${c.number}: In praise of ${name}`,
    description: `${asQuote(c.reason)}\n\nFiled by <@${c.accuserId}>`,
  };
  if (accusedAvatarUrl) embed.thumbnail = { url: accusedAvatarUrl };
  return embed;
}

export function caseEmbed(
  c: Case,
  tally: VoteTally,
  accusedName: string,
  accusedAvatarUrl: string | null,
  settings: GuildSettings,
): APIEmbed {
  const embed = baseEmbed(c, accusedName, accusedAvatarUrl);
  const sec = seconds(c.deadline);
  const fields: APIEmbedField[] = [
    { name: 'Stakes', value: stakesValue(c), inline: true },
    { name: 'Verdict', value: `<t:${sec}:R>, at <t:${sec}:t>`, inline: true },
    {
      name: 'Tally',
      value: [
        settings.ballot === 'secret'
          ? `${tally.yes + tally.no} ballot${tally.yes + tally.no === 1 ? '' : 's'} in the box · sealed until the verdict`
          : tallyValue(c.kind, tally),
        tally.yes + tally.no < settings.quorum
          ? `${tally.yes + tally.no} of ${settings.quorum} toward quorum`
          : 'quorum met',
        ...(settings.ballot !== 'secret' && tally.yes + tally.no >= BAR_MIN_VOTES
          ? [voteBar(c.kind, tally)]
          : []),
      ].join('\n'),
      inline: true,
    },
  ];
  if (settings.ballot === 'public') fields.push(juryField(c.kind, tally));
  if (settings.ballot === 'anonymous') {
    fields.push({ name: 'The jury', value: 'Deliberates in private. Only the tally is public.' });
  }

  embed.color = c.kind === 'accuse' ? COLOUR.amber : COLOUR.blue;
  embed.fields = fields;
  embed.footer = { text: 'Deleting this post voids the case.' };
  return embed;
}

function outcomeText(kind: Case['kind'], status: CaseStatus): string {
  if (status === 'passed') return kind === 'accuse' ? 'Guilty' : 'Commended';
  if (status === 'failed') return kind === 'accuse' ? 'Not guilty' : 'Rejected';
  if (status === 'dismissed') return 'Dismissed, quorum not met';
  // A case voided by deletion has no embed left to edit, so a rendered voided
  // case can only have been withdrawn.
  if (status === 'voided') return 'Withdrawn by the filer';
  return 'Still open';
}

function closedColour(kind: Case['kind'], status: CaseStatus): number {
  if (status !== 'passed') return COLOUR.grey;
  return kind === 'accuse' ? COLOUR.red : COLOUR.green;
}

export function closedCaseEmbed(
  c: Case,
  tally: VoteTally,
  status: CaseStatus,
  accusedName: string,
  accusedAvatarUrl: string | null,
  ballot: BallotMode,
): APIEmbed {
  const embed = baseEmbed(c, accusedName, accusedAvatarUrl);
  embed.color = closedColour(c.kind, status);
  const fields: APIEmbedField[] = [
    { name: 'Stakes', value: stakesValue(c), inline: true },
    { name: 'Verdict', value: outcomeText(c.kind, status), inline: true },
    {
      name: 'Final tally',
      value: [
        tallyValue(c.kind, tally),
        ...(ballot !== 'secret' && tally.yes + tally.no >= BAR_MIN_VOTES
          ? [voteBar(c.kind, tally)]
          : []),
      ].join('\n'),
      inline: true,
    },
  ];
  fields.push(
    ballot === 'public'
      ? juryField(c.kind, tally)
      : { name: 'The jury', value: 'Deliberated in private.' },
  );
  embed.fields = fields;
  return embed;
}

export function caseButtons(
  c: Case,
  tally: VoteTally,
  closed: boolean,
  ballot: BallotMode,
): APIActionRowComponent<APIComponentInMessageActionRow> {
  const { yes: yesLabel, no: noLabel } = voteLabels(c.kind);
  // A secret ballot leaks through button labels, so counts only appear once public.
  const showCounts = ballot !== 'secret' || closed;

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: c.kind === 'accuse' ? ButtonStyle.Danger : ButtonStyle.Success,
        label: showCounts ? `${yesLabel} (${tally.yes})` : yesLabel,
        custom_id: `vote:${c.id}:yes`,
        disabled: closed,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        label: showCounts ? `${noLabel} (${tally.no})` : noLabel,
        custom_id: `vote:${c.id}:no`,
        disabled: closed,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        label: 'Withdraw',
        custom_id: `withdraw:${c.id}`,
        disabled: closed,
      },
      ...(ballot === 'public' && (tally.yes > JURY_SHOWN_MAX || tally.no > JURY_SHOWN_MAX)
        ? [{
            type: ComponentType.Button as const,
            style: ButtonStyle.Secondary as const,
            label: 'The roll',
            custom_id: `roll:${c.id}:0`,
            // The vote ends but the record stays public, so the roll outlives the verdict.
            disabled: false,
          }]
        : []),
    ],
  };
}

/** About 70 mentions a page keeps the description far under the 4096 cap. */
const ROLL_PAGE_LINES = 14;

export function rollView(
  c: Case,
  tally: VoteTally,
  page: number,
): { embed: APIEmbed; components: APIActionRowComponent<APIComponentInMessageActionRow>[] } {
  const labels = voteLabels(c.kind);
  const lines: string[] = [];
  const addSide = (label: string, voters: string[]): void => {
    if (voters.length === 0) return;
    if (lines.length > 0) lines.push('');
    lines.push(`**${label} · ${voters.length}**`);
    for (let i = 0; i < voters.length; i += 5) {
      lines.push(voters.slice(i, i + 5).map((id) => `<@${id}>`).join(' '));
    }
  };
  addSide(labels.yes, tally.yesVoters);
  addSide(labels.no, tally.noVoters);

  const pages = Math.max(1, Math.ceil(lines.length / ROLL_PAGE_LINES));
  const currentPage = Math.min(Math.max(page, 0), pages - 1);
  const total = tally.yes + tally.no;
  const embed: APIEmbed = {
    color: COLOUR.parchment,
    title: `Case #${c.number} · the roll`,
    description: lines
      .slice(currentPage * ROLL_PAGE_LINES, (currentPage + 1) * ROLL_PAGE_LINES)
      .join('\n'),
    footer: {
      text: `Page ${currentPage + 1} of ${pages} · ${total} ballot${total === 1 ? '' : 's'}`,
    },
  };
  if (pages === 1) return { embed, components: [] };

  return {
    embed,
    components: [{
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          label: 'Back',
          custom_id: `roll:${c.id}:${currentPage - 1}`,
          disabled: currentPage === 0,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          label: 'Next',
          custom_id: `roll:${c.id}:${currentPage + 1}`,
          disabled: currentPage === pages - 1,
        },
      ],
    }],
  };
}

const BALLOT_SHORT: Record<BallotMode, string> = {
  public: 'Public',
  anonymous: 'Anonymous',
  secret: 'Secret',
};

const STANDING_SHORT: Record<StandingMode, string> = {
  roles: 'Tier roles',
  nicknames: 'Nickname suffixes',
  both: 'Roles and nicknames',
  off: 'Off',
};

export function settingsEmbed(s: GuildSettings): APIEmbed {
  const courtroom =
    s.courtChannelId && s.forumChannelId
      ? `Dashboard <#${s.courtChannelId}> · cases in <#${s.forumChannelId}>`
      : 'Not built yet. Run /setup and the court will raise its own walls.';
  return {
    color: COLOUR.parchment,
    title: 'Court settings',
    description: 'The court as currently constituted. Adjust it with the menus below.',
    fields: [
      { name: 'Quorum', value: `${s.quorum} votes`, inline: true },
      { name: 'Vote window', value: humanDuration(s.defaultDurationMin), inline: true },
      { name: 'Ballot', value: BALLOT_SHORT[s.ballot], inline: true },
      { name: 'Standing', value: STANDING_SHORT[s.standing], inline: true },
      { name: 'Courtroom', value: courtroom },
    ],
    footer: { text: 'Changes apply from the next vote or filing.' },
  };
}

export function settingsComponents(
  s: GuildSettings,
  ownerId: string,
): APIActionRowComponent<APIComponentInMessageActionRow>[] {
  const quorumChoices = [2, 3, 5, 7, 10, 15, 20, 30, 50];
  return [
    {
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: `set:ballot:${ownerId}`,
        placeholder: `Ballot: ${BALLOT_SHORT[s.ballot]}`,
        options: [
          { label: 'Public ballots', value: 'public', description: 'The case lists who voted which way.', default: s.ballot === 'public' },
          { label: 'Anonymous ballots', value: 'anonymous', description: 'Running tallies, but never names.', default: s.ballot === 'anonymous' },
          { label: 'Secret ballots', value: 'secret', description: 'The tally stays sealed until the verdict.', default: s.ballot === 'secret' },
        ],
      }],
    },
    {
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: `set:quorum:${ownerId}`,
        placeholder: `Quorum: ${s.quorum} votes`,
        options: [
          ...quorumChoices.map((n) => ({ label: `${n} votes`, value: String(n), default: s.quorum === n })),
          { label: 'Custom…', value: 'custom', description: 'Any number from 2 to 100.' },
        ],
      }],
    },
    {
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: `set:window:${ownerId}`,
        placeholder: `Vote window: ${humanDuration(s.defaultDurationMin)}`,
        options: DURATION_CHOICES.map((m) => ({ label: humanDuration(m), value: String(m), default: s.defaultDurationMin === m })),
      }],
    },
    {
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: `set:standing:${ownerId}`,
        placeholder: `Standing: ${STANDING_SHORT[s.standing]}`,
        options: [
          { label: 'Tier roles', value: 'roles', description: 'Coloured, hoisted roles from Model citizen down.', default: s.standing === 'roles' },
          { label: 'Nickname suffixes', value: 'nicknames', description: 'The score written into nicknames, as "Sushi (130)".', default: s.standing === 'nicknames' },
          { label: 'Roles and nicknames', value: 'both', description: 'Both at once.', default: s.standing === 'both' },
          { label: 'Off', value: 'off', description: 'No public standing.', default: s.standing === 'off' },
        ],
      }],
    },
  ];
}

/** A forum case links to its post; a legacy case links to its message. */
export function caseUrl(guildId: string, c: Case): string | null {
  if (c.messageId === null) return null;
  if (c.messageId === c.channelId) return `https://discord.com/channels/${guildId}/${c.channelId}`;
  return `https://discord.com/channels/${guildId}/${c.channelId}/${c.messageId}`;
}

export function hubEmbed(board: ScoreRow[], openCases: Case[], guildId: string): APIEmbed {
  const rows = board.slice(0, BOARD_ROWS);
  const boardDescription =
    rows.length === 0
      ? 'Nobody has any points yet.'
      : rows
          .map((row, i) => `${i + 1}. ${escapeMd(truncate(row.displayName, 40))} · ${row.points} pts · ${titleFor(row.points)}`)
          .join('\n');

  const shownCases = openCases.slice(0, OPEN_CASE_ROWS);
  const caseRows = shownCases.map((c) => {
    const url = caseUrl(guildId, c);
    const label = url ? `[Case #${c.number}](${url})` : `Case #${c.number}`;
    return `${label} · <@${c.accusedId}> · closes <t:${seconds(c.deadline)}:R>`;
  });
  if (caseRows.length === 0) caseRows.push('None.');
  if (openCases.length > OPEN_CASE_ROWS) caseRows.push(`and ${openCases.length - OPEN_CASE_ROWS} more.`);

  const description = `${boardDescription}\n\n**Open cases**\n${caseRows.join('\n')}`;

  return {
    color: COLOUR.parchment,
    title: 'The public record',
    // The quiet attribution: the hub title links to the source.
    url: 'https://github.com/tommyothen/judge',
    description,
    footer: { text: 'File a case below. The court is always in session.' },
  };
}

export function hubButtons(): APIActionRowComponent<APIComponentInMessageActionRow> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Danger,
        label: 'File a case',
        custom_id: 'hub:file',
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Success,
        label: 'Commend someone',
        custom_id: 'hub:commend',
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        label: 'My record',
        custom_id: 'hub:record',
      },
    ],
  };
}

function recordTag(c: Case): { tag: string; signed: string | null } {
  if (c.status === 'passed') {
    return c.kind === 'accuse'
      ? { tag: 'convicted', signed: `-${c.points}` }
      : { tag: 'commended', signed: `+${c.points}` };
  }
  if (c.status === 'failed') {
    return { tag: c.kind === 'accuse' ? 'acquitted' : 'rejected', signed: null };
  }
  if (c.status === 'dismissed') return { tag: 'dismissed', signed: null };
  if (c.status === 'voided') return { tag: 'voided', signed: null };
  return { tag: 'pending', signed: null };
}

export function recordEmbed(displayName: string, points: number, cases: Case[]): APIEmbed {
  const header = `${points} points`;
  const rows = cases.slice(0, RECORD_ROWS).map((c) => {
    const { tag, signed } = recordTag(c);
    const head = signed ? `${tag} ${signed}` : tag;
    return `${head} · ${unmaskLinks(truncate(c.reason, REASON_LINE_MAX))} · <t:${seconds(c.createdAt)}:R>`;
  });

  const body = rows.length === 0 ? 'No criminal record.' : rows.join('\n');

  return {
    color: COLOUR.parchment,
    title: `${truncate(displayName, 80)}'s record`,
    description: `${header}\n\n${body}`,
  };
}
