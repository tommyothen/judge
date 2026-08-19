import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionType,
  InteractionResponseType,
  MessageFlags,
  type APIApplicationCommandInteraction,
  type APIApplicationCommandInteractionDataBasicOption,
  type APIApplicationCommandInteractionDataOption,
  type APIChatInputApplicationCommandInteraction,
} from 'discord-api-types/v10';
import { getRecordFor, getSettings, touchName } from '../db.js';
import { recordEmbed, settingsComponents, settingsEmbed } from '../embeds.js';
import { setupCourt } from '../hub.js';
import type { Rest } from '../discord/rest.js';
import {
  deferEphemeral,
  ephemeral,
  ephemeralEmbed,
  json,
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

function userOpt(options: Map<string, BasicOption>, name: string): string | null {
  const option = options.get(name);
  return option?.type === ApplicationCommandOptionType.User ? option.value : null;
}

function channelOpt(options: Map<string, BasicOption>, name: string): string | null {
  const option = options.get(name);
  return option?.type === ApplicationCommandOptionType.Channel ? option.value : null;
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

  // The panel is ephemeral, so only the checked owner can press its menus. The
  // owner id in each custom id is the belt to those braces.
  const current = await getSettings(c.env.DB, guildId);
  return json({
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      embeds: [settingsEmbed(current)],
      components: settingsComponents(current, interaction.member!.user.id),
      flags: MessageFlags.Ephemeral,
    },
  });
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
