import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIEmbedField,
} from 'discord-api-types/v10';
import { titleFor } from './flavor.js';
import type { Case, CaseStatus, ScoreRow, VoteTally } from './types.js';

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

/** Embed field values cap at 1024 characters; a mention is ~22 of them. */
const JURY_SHOWN_MAX = 20;

function juryLine(label: string, voters: string[]): string {
  if (voters.length === 0) return `${label} · nobody`;
  const shown = voters.slice(0, JURY_SHOWN_MAX).map((id) => `<@${id}>`).join(' ');
  const extra = voters.length > JURY_SHOWN_MAX ? ` and ${voters.length - JURY_SHOWN_MAX} more` : '';
  return `${label} · ${shown}${extra}`;
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
): APIEmbed {
  const embed = baseEmbed(c, accusedName, accusedAvatarUrl);
  const sec = seconds(c.deadline);
  const fields: APIEmbedField[] = [
    { name: 'Stakes', value: stakesValue(c), inline: true },
    { name: 'Verdict', value: `<t:${sec}:R>, at <t:${sec}:t>`, inline: true },
    { name: 'Tally', value: tallyValue(c.kind, tally), inline: true },
    juryField(c.kind, tally),
  ];

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
): APIEmbed {
  const embed = baseEmbed(c, accusedName, accusedAvatarUrl);
  embed.color = closedColour(c.kind, status);
  embed.fields = [
    { name: 'Stakes', value: stakesValue(c), inline: true },
    { name: 'Verdict', value: outcomeText(c.kind, status), inline: true },
    { name: 'Final tally', value: tallyValue(c.kind, tally), inline: true },
    juryField(c.kind, tally),
  ];
  return embed;
}

export function caseButtons(
  c: Case,
  tally: VoteTally,
  disabled: boolean,
): APIActionRowComponent<APIComponentInMessageActionRow> {
  const { yes: yesLabel, no: noLabel } = voteLabels(c.kind);

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: c.kind === 'accuse' ? ButtonStyle.Danger : ButtonStyle.Success,
        label: `${yesLabel} (${tally.yes})`,
        custom_id: `vote:${c.id}:yes`,
        disabled,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        label: `${noLabel} (${tally.no})`,
        custom_id: `vote:${c.id}:no`,
        disabled,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        label: 'Withdraw',
        custom_id: `withdraw:${c.id}`,
        disabled,
      },
    ],
  };
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
