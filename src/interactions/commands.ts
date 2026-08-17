import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionType,
  type APIApplicationCommandInteraction,
  type APIApplicationCommandInteractionDataBasicOption,
  type APIApplicationCommandInteractionDataOption,
  type APIChatInputApplicationCommandInteraction,
} from 'discord-api-types/v10';
import { getRecordFor, getSettings, touchName, updateSettings } from '../db.js';
import { recordEmbed } from '../embeds.js';
import { setupCourt } from '../hub.js';
import { ensureTierRoles, resyncAllStanding, wantsNicknames, wantsRoles } from '../standing.js';
import type { Rest } from '../discord/rest.js';
import type { StandingMode } from '../types.js';
import {
  deferEphemeral,
  ephemeral,
  ephemeralEmbed,
  humanDuration,
  isDurationChoice,
  memberDisplayName,
  resolvedDisplayName,
  storedName,
  type Ctx,
} from './shared.js';

/** Pinned to command interactions: autocomplete options can carry partial values. */
type BasicOption = APIApplicationCommandInteractionDataBasicOption<InteractionType.ApplicationCommand>;
type CommandOption = APIApplicationCommandInteractionDataOption<InteractionType.ApplicationCommand>;

/** Flattens one level of options into a lookup, ignoring subcommand wrappers. */
function optionMap(options: CommandOption[] | undefined): Map<string, BasicOption> {
  const map = new Map<string, BasicOption>();
  for (const option of options ?? []) {
    if (
      option.type === ApplicationCommandOptionType.Subcommand ||
      option.type === ApplicationCommandOptionType.SubcommandGroup
    ) {
      continue;
    }
    map.set(option.name, option);
  }
  return map;
}

function subcommandOf(
  options: CommandOption[] | undefined,
): { name: string; options: Map<string, BasicOption> } | null {
  for (const option of options ?? []) {
    if (option.type === ApplicationCommandOptionType.Subcommand) {
      return { name: option.name, options: optionMap(option.options) };
    }
  }
  return null;
}

function stringOpt(options: Map<string, BasicOption>, name: string): string | null {
  const option = options.get(name);
  return option?.type === ApplicationCommandOptionType.String ? option.value : null;
}

function intOpt(options: Map<string, BasicOption>, name: string): number | null {
  const option = options.get(name);
  return option?.type === ApplicationCommandOptionType.Integer ? option.value : null;
}

function userOpt(options: Map<string, BasicOption>, name: string): string | null {
  const option = options.get(name);
  return option?.type === ApplicationCommandOptionType.User ? option.value : null;
}

function channelOpt(options: Map<string, BasicOption>, name: string): string | null {
  const option = options.get(name);
  return option?.type === ApplicationCommandOptionType.Channel ? option.value : null;
}

/** How /settings show names each standing mode. */
const STANDING_LABEL: Record<StandingMode, string> = {
  roles: 'tier roles',
  nicknames: 'score suffixes in nicknames',
  both: 'tier roles and score suffixes',
  off: 'off, nothing on display',
};

/** What the court says when the mode changes. */
const STANDING_CONFIRMATION: Record<StandingMode, string> = {
  roles: 'Standing is a role now. Coloured, hoisted, and swapped the moment a score crosses a line.',
  nicknames: 'Standing is a nickname suffix now, as "Sushi (130)".',
  both: 'Standing is a role and a nickname suffix now.',
  off: 'Standing is hidden. No roles, no numbers in names.',
};

function isStandingMode(value: string | null): value is StandingMode {
  return value === 'roles' || value === 'nicknames' || value === 'both' || value === 'off';
}

/**
 * The chief justice is the server owner. Discord's Manage Server gate on the
 * command keeps most people out; this keeps out the other admins. Returns the
 * refusal to send, or null when the invoker may proceed.
 */
async function benchCheck(rest: Rest, guildId: string, userId: string): Promise<Response | null> {
  const guild = await rest.getGuild(guildId).catch(() => null);
  const ownerId = typeof guild?.owner_id === 'string' ? guild.owner_id : null;
  if (ownerId === userId) return null;
  return ephemeral(
    ownerId
      ? `Only the chief justice may adjust the court. Take it up with <@${ownerId}>.`
      : 'The court could not confirm who owns this server. Try again in a moment.',
  );
}

export async function handleCommand(
  interaction: APIApplicationCommandInteraction,
  c: Ctx,
): Promise<Response> {
  if (interaction.data.type !== ApplicationCommandType.ChatInput) {
    return ephemeral('The court does not recognise that instrument.');
  }
  if (!interaction.guild_id || !interaction.member) {
    return ephemeral('The court only sits in a server.');
  }

  const chat = interaction as APIChatInputApplicationCommandInteraction;
  const guildId = interaction.guild_id;
  const options = optionMap(chat.data.options);

  switch (chat.data.name) {
    case 'record':
      return record(chat, c, guildId, options);
    case 'settings':
      return settings(chat, c, guildId);
    case 'setup':
      return setup(chat, c, guildId, options);
    default:
      return ephemeral('No such proceeding exists. The clerk checked twice.');
  }
}

async function record(
  interaction: APIChatInputApplicationCommandInteraction,
  c: Ctx,
  guildId: string,
  options: Map<string, BasicOption>,
): Promise<Response> {
  const db = c.env.DB;
  const member = interaction.member!;
  const targetId = userOpt(options, 'user') ?? member.user.id;

  const name =
    targetId === member.user.id
      ? (memberDisplayName(member) ?? member.user.username)
      : (resolvedDisplayName(interaction.data.resolved, targetId) ??
        (await storedName(db, guildId, targetId)) ??
        'That person');

  const { points, cases } = await getRecordFor(db, guildId, targetId);
  // A no-op unless they already have a score row, which is exactly what we want.
  await touchName(db, guildId, targetId, name);

  return ephemeralEmbed(recordEmbed(name, points, cases));
}

async function settings(
  interaction: APIChatInputApplicationCommandInteraction,
  c: Ctx,
  guildId: string,
): Promise<Response> {
  const denied = await benchCheck(c.rest, guildId, interaction.member!.user.id);
  if (denied) return denied;

  const db = c.env.DB;
  const sub = subcommandOf(interaction.data.options);
  if (!sub) return ephemeral('Tell the court which setting you mean.');

  if (sub.name === 'show') {
    const current = await getSettings(db, guildId);
    const lines = [
      `Quorum: ${current.quorum} votes before a verdict counts.`,
      `Default vote window: ${humanDuration(current.defaultDurationMin)}.`,
      current.courtChannelId
        ? `Dashboard: <#${current.courtChannelId}>.`
        : 'Dashboard: not set. Run /setup to build the court.',
      current.forumChannelId
        ? `Cases forum: <#${current.forumChannelId}>.`
        : 'Cases forum: not set. Run /setup.',
      `Standing: ${STANDING_LABEL[current.standing]}.`,
    ];
    return ephemeral(lines.join('\n'));
  }

  if (sub.name === 'quorum') {
    const value = intOpt(sub.options, 'value');
    if (value === null || value < 2 || value > 20) {
      return ephemeral('Quorum must be between 2 and 20. The court has standards, if not many.');
    }
    await updateSettings(db, guildId, { quorum: value });
    return ephemeral(`Quorum set to ${value}. Democracy calibrated.`);
  }

  if (sub.name === 'duration') {
    const value = intOpt(sub.options, 'value');
    if (value === null || !isDurationChoice(value)) {
      return ephemeral('Pick one of the offered vote windows. The court keeps office hours.');
    }
    await updateSettings(db, guildId, { defaultDurationMin: value });
    return ephemeral(`New cases will run for ${humanDuration(value)}. Justice at its own pace.`);
  }

  if (sub.name === 'standing') {
    const mode = stringOpt(sub.options, 'mode');
    if (!isStandingMode(mode)) {
      return ephemeral('Pick one of the offered standings. The court keeps a short list.');
    }

    // Creating eight roles and walking the board is far more than an
    // interaction reply has time for, so the answer is deferred like /setup.
    const { env, rest } = c;
    c.ctx.waitUntil(
      (async () => {
        try {
          await updateSettings(db, guildId, { standing: mode });

          const lines = [STANDING_CONFIRMATION[mode]];
          if (wantsRoles(mode)) lines.push(await ensureTierRoles(rest, db, guildId));
          if (wantsNicknames(mode)) {
            lines.push(
              'I cannot rename the server owner, and I cannot rename anyone whose highest role sits above mine. They keep plain names.',
            );
          }
          lines.push('Working through the board now.');

          await rest.editOriginal(env.DISCORD_CLIENT_ID, interaction.token, {
            content: lines.join('\n'),
          });
        } catch (err) {
          console.error('standing change failed', err);
        }

        try {
          await resyncAllStanding(rest, db, guildId);
        } catch (err) {
          console.error('resyncAllStanding failed', err);
        }
      })(),
    );

    return deferEphemeral();
  }

  return ephemeral('No such setting. The clerk checked the filing cabinet.');
}

async function setup(
  interaction: APIChatInputApplicationCommandInteraction,
  c: Ctx,
  guildId: string,
  options: Map<string, BasicOption>,
): Promise<Response> {
  const denied = await benchCheck(c.rest, guildId, interaction.member!.user.id);
  if (denied) return denied;

  const forumId = channelOpt(options, 'forum');
  const dashboardId = channelOpt(options, 'dashboard');

  const { env, rest } = c;
  c.ctx.waitUntil(
    (async () => {
      try {
        const report = await setupCourt(rest, env.DB, guildId, env.DISCORD_CLIENT_ID, {
          forumId,
          dashboardId,
        });
        await rest.editOriginal(env.DISCORD_CLIENT_ID, interaction.token, { content: report });
      } catch (err) {
        console.error('setup failed', err);
        try {
          await rest.editOriginal(env.DISCORD_CLIENT_ID, interaction.token, {
            content: 'Setup failed. Check that I can manage channels, then try again.',
          });
        } catch {
          // Token gone. The admin will notice the missing hub soon enough.
        }
      }
    })(),
  );

  return deferEphemeral();
}
