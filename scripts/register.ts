/**
 * Pushes the slash commands to Discord.
 *
 *   pnpm register            # guild commands when GUILD_ID is set, else global
 *
 * Run with `tsx --env-file=.dev.vars scripts/register.ts` so the same secrets
 * the worker uses are picked up from .dev.vars.
 */
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  Routes,
  type RESTPutAPIApplicationCommandsJSONBody,
} from 'discord-api-types/v10';

const token = process.env.DISCORD_TOKEN;
const applicationId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !applicationId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID. Put both in .dev.vars and try again.');
  process.exit(1);
}

/** Manage Server, the bar for touching the court's configuration. */
const MANAGE_GUILD = '32';

const guildOnly = {
  integration_types: [ApplicationIntegrationType.GuildInstall],
  contexts: [InteractionContextType.Guild],
};

const commands: RESTPutAPIApplicationCommandsJSONBody = [
  {
    type: ApplicationCommandType.ChatInput,
    name: 'record',
    description: "Look up somebody's criminal history.",
    ...guildOnly,
    options: [
      {
        type: ApplicationCommandOptionType.User,
        name: 'user',
        description: 'Whose record. Defaults to yours.',
        required: false,
      },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'settings',
    description: 'Open the court settings.',
    ...guildOnly,
    default_member_permissions: MANAGE_GUILD,
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'setup',
    description: 'Build the court, or adopt channels you already made.',
    ...guildOnly,
    default_member_permissions: MANAGE_GUILD,
    options: [
      {
        type: ApplicationCommandOptionType.Channel,
        name: 'forum',
        description: 'The cases forum. Leave both empty and I will build them.',
        required: false,
        channel_types: [ChannelType.GuildForum],
      },
      {
        type: ApplicationCommandOptionType.Channel,
        name: 'dashboard',
        description: 'The dashboard channel. Name it only if you also name the forum.',
        required: false,
        channel_types: [ChannelType.GuildText],
      },
    ],
  },
];

const route = guildId
  ? Routes.applicationGuildCommands(applicationId, guildId)
  : Routes.applicationCommands(applicationId);

const response = await fetch(`https://discord.com/api/v10${route}`, {
  method: 'PUT',
  headers: {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  console.error(`Registration failed: ${response.status} ${response.statusText}`);
  console.error(await response.text());
  process.exit(1);
}

const registered = (await response.json()) as { name: string }[];
const names = registered.map((command) => command.name).sort().join(', ');

if (guildId) {
  console.log(`Registered ${registered.length} commands in guild ${guildId}: ${names}`);
  console.log('Guild commands appear immediately.');
} else {
  console.log(`Registered ${registered.length} global commands: ${names}`);
  console.log('Global commands can take up to an hour to appear everywhere.');
}
