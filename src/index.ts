import {
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type APIInteraction,
} from 'discord-api-types/v10';
import { getConfiguredGuilds } from './db.js';
import { Rest } from './discord/rest.js';
import { verifyInteraction } from './discord/verify.js';
import { ensureHub, sweepCourtChannel } from './hub.js';
import { handleCommand } from './interactions/commands.js';
import { handleComponent } from './interactions/components.js';
import { handleModal } from './interactions/modals.js';
import { json, type Ctx } from './interactions/shared.js';
import { resolveDueCases } from './resolve.js';
import type { Env } from './types.js';

const GREETING = 'Judge. The court is in session.';

function isInteractionPath(pathname: string): boolean {
  return pathname === '/interactions' || pathname === '/';
}

async function handleInteraction(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');

  if (!(await verifyInteraction(env.DISCORD_PUBLIC_KEY, signature, timestamp, body))) {
    return new Response('invalid request signature', { status: 401 });
  }

  const interaction = JSON.parse(body) as APIInteraction;

  if (interaction.type === InteractionType.Ping) {
    return json({ type: InteractionResponseType.Pong });
  }

  const c: Ctx = { env, rest: new Rest(env.DISCORD_TOKEN), ctx };

  switch (interaction.type) {
    case InteractionType.ApplicationCommand:
      return handleCommand(interaction, c);
    case InteractionType.MessageComponent:
      return handleComponent(interaction, c);
    case InteractionType.ModalSubmit:
      return handleModal(interaction, c);
    default:
      return new Response('unsupported interaction type', { status: 400 });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(GREETING, { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    if (request.method === 'POST' && isInteractionPath(url.pathname)) {
      try {
        return await handleInteraction(request, env, ctx);
      } catch (err) {
        console.error('interaction failed', err);
        return json({
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: 'The court clerk tripped over a cable. Try again.',
            flags: MessageFlags.Ephemeral,
          },
        });
      }
    }

    return new Response('not found', { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const rest = new Rest(env.DISCORD_TOKEN);

    try {
      await resolveDueCases(env, rest);
    } catch (err) {
      console.error('resolving due cases failed', err);
    }

    let guilds: Awaited<ReturnType<typeof getConfiguredGuilds>> = [];
    try {
      guilds = await getConfiguredGuilds(env.DB);
    } catch (err) {
      console.error('listing configured guilds failed', err);
      return;
    }

    for (const settings of guilds) {
      try {
        await sweepCourtChannel(rest, settings, env.DISCORD_CLIENT_ID);
      } catch (err) {
        console.error(`sweeping ${settings.guildId} failed`, err);
      }

      try {
        await ensureHub(rest, env.DB, settings.guildId);
      } catch (err) {
        console.error(`healing the hub in ${settings.guildId} failed`, err);
      }
    }
  },
};
