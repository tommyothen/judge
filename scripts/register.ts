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
    description: 'Adjust how the court runs.',
    ...guildOnly,
    default_member_permissions: MANAGE_GUILD,
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'show',
        description: 'Show the current settings.',
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'quorum',
        description: 'Set how many votes a verdict needs.',
        options: [
          {
            type: ApplicationCommandOptionType.Integer,
            name: 'value',
            description: 'Between 2 and 20 votes.',
            required: true,
            min_value: 2,
            max_value: 20,
          },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'duration',
        description: 'Set the default vote window for new cases.',
        options: [
          {
            type: ApplicationCommandOptionType.Integer,
            name: 'value',
            description: 'How long new cases run.',
            required: true,
            choices: [
              { name: '10 minutes', value: 10 },
              { name: '1 hour', value: 60 },
              { name: '6 hours', value: 360 },
              { name: '24 hours', value: 1440 },
            ],
          },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'standing',
        description: 'Show standing as tier roles, nicknames, both, or neither.',
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: 'mode',
            description: 'How standing is shown.',
            required: true,
            choices: [
              { name: 'roles', value: 'roles' },
              { name: 'nicknames', value: 'nicknames' },
              { name: 'both', value: 'both' },
              { name: 'off', value: 'off' },
            ],
          },
        ],
      },
    ],
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
