export type CaseKind = 'accuse' | 'commend';
export type CaseStatus = 'open' | 'passed' | 'failed' | 'dismissed' | 'voided';

export interface Case {
  id: number; // global, the internal key: custom ids, lookups, thread mapping
  number: number; // per-guild, counts from 1, the only case number anyone sees
  guildId: string;
  channelId: string;
  messageId: string | null;
  kind: CaseKind;
  accuserId: string;
  accusedId: string;
  reason: string;
  points: number; // always positive; sign is applied at resolution based on kind
  deadline: number; // epoch ms
  status: CaseStatus;
  createdAt: number; // epoch ms
}

export interface VoteTally {
  yes: number;
  no: number;
  /** Voter ids per side, in first-vote order. */
  yesVoters: string[];
  noVoters: string[];
}

/** How a member's standing is shown: a tier role, a nickname suffix, both, or neither. */
export type StandingMode = 'nicknames' | 'roles' | 'both' | 'off';

/** Who sees the votes: everyone, the tally only, or nothing until the verdict. */
export type BallotMode = 'public' | 'anonymous' | 'secret';

export interface GuildSettings {
  guildId: string;
  quorum: number; // minimum total votes (including the filer's auto-vote) for a valid verdict
  defaultDurationMin: number;
  categoryId: string | null; // the court category; null until /setup
  courtChannelId: string | null; // dashboard channel; holds the hub
  forumChannelId: string | null; // where cases live as posts; null until /setup
  hubMessageId: string | null; // pinned live-board message
  tags: Record<string, string> | null; // tag key to forum tag snowflake
  standing: StandingMode;
  ballot: BallotMode;
  tierRoles: Record<string, string> | null; // tier key to role snowflake; null until roles are made
  nicknameSync: boolean; // legacy, superseded by standing; the column stays, nothing reads it
}

export interface ScoreRow {
  userId: string;
  displayName: string;
  points: number;
}

export interface Env {
  DB: D1Database;
  DISCORD_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_CLIENT_ID: string;
}
