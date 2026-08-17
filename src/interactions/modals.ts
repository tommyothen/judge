import {
  ComponentType,
  type APIModalSubmissionComponent,
  type APIModalSubmitInteraction,
  type ModalSubmitComponent,
} from 'discord-api-types/v10';
import type { CaseKind } from '../types.js';
import {
  deferEphemeral,
  ephemeral,
  isDurationChoice,
  isPointTier,
  memberDisplayName,
  resolvedDisplayName,
  resolvedIsBot,
  runFiling,
  type Ctx,
} from './shared.js';

/**
 * Modal submissions arrive as Label wrappers around one component each. Older
 * action-row modals are still legal, so both shapes get flattened here.
 */
function flatten(components: APIModalSubmissionComponent[] | undefined): Map<string, ModalSubmitComponent> {
  const found = new Map<string, ModalSubmitComponent>();

  for (const component of components ?? []) {
    if (component.type === ComponentType.Label) {
      found.set(component.component.custom_id, component.component);
    } else if (component.type === ComponentType.ActionRow) {
      for (const child of component.components) found.set(child.custom_id, child);
    }
  }

  return found;
}

function firstValue(component: ModalSubmitComponent | undefined): string | null {
  if (!component) return null;
  if ('values' in component) return component.values[0] ?? null;
  if ('value' in component && typeof component.value === 'string') return component.value;
  return null;
}

export async function handleModal(interaction: APIModalSubmitInteraction, c: Ctx): Promise<Response> {
  if (!interaction.guild_id || !interaction.member) {
    return ephemeral('The court only sits in a server.');
  }

  const customId = interaction.data.custom_id;
  if (customId !== 'file:accuse' && customId !== 'file:commend') {
    return ephemeral('The court does not recognise that form.');
  }
  const kind: CaseKind = customId === 'file:accuse' ? 'accuse' : 'commend';

  const fields = flatten(interaction.data.components);
  const accusedId = firstValue(fields.get('target'));
  const reason = firstValue(fields.get('reason'));
  const points = Number(firstValue(fields.get('severity')));
  const rawDuration = firstValue(fields.get('duration'));
  const duration = rawDuration === null ? null : Number(rawDuration);

  if (!accusedId || reason === null || !isPointTier(points)) {
    return ephemeral('That filing is malformed. The clerk has sent it back.');
  }

  const member = interaction.member;
  const resolved = interaction.data.resolved;

  c.ctx.waitUntil(
    runFiling(c, {
      kind,
      guildId: interaction.guild_id,
      invokedChannelId: interaction.channel?.id ?? interaction.channel_id ?? null,
      accuserId: member.user.id,
      accuserName: memberDisplayName(member) ?? member.user.username,
      accusedId,
      accusedNameHint: resolvedDisplayName(resolved, accusedId),
      accusedIsBotHint: resolvedIsBot(resolved, accusedId),
      reason,
      points,
      durationMin: duration !== null && isDurationChoice(duration) ? duration : null,
      token: interaction.token,
    }),
  );

  return deferEphemeral();
}
