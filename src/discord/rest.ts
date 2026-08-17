const API_BASE = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://github.com/tommyothen/judge, 0.1.0)';

/** Longest we will ever sit on a 429 before giving up. */
const MAX_RETRY_WAIT_MS = 10_000;

export class RestError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body?: unknown) {
    super(`Discord REST ${status}: ${describe(body)}`);
    this.name = 'RestError';
    this.status = status;
    this.body = body;
  }
}

function describe(body: unknown): string {
  if (body === undefined || body === null) return 'no body';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return 'unserialisable body';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Rest {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * JSON in, JSON out. Resolves to undefined for 204 and other empty bodies,
   * throws RestError on any non-2xx. A single 429 is retried once after
   * retry_after.
   */
  async request(method: string, path: string, body?: unknown): Promise<any> {
    return this.send(method, path, body);
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    isRetry = false,
  ): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.token}`,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...extraHeaders,
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(`${API_BASE}${path}`, init);
    const text = await res.text();

    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (res.status === 429 && !isRetry) {
      const retryAfter =
        parsed && typeof parsed === 'object' && typeof (parsed as { retry_after?: unknown }).retry_after === 'number'
          ? (parsed as { retry_after: number }).retry_after
          : 1;
      const waitMs = Math.min(Math.max(retryAfter * 1000, 0), MAX_RETRY_WAIT_MS);
      await sleep(waitMs);
      return this.send(method, path, body, extraHeaders, true);
    }

    if (!res.ok) throw new RestError(res.status, parsed);
    return parsed;
  }

  createMessage(channelId: string, payload: unknown): Promise<any> {
    return this.send('POST', `/channels/${channelId}/messages`, payload);
  }

  createGuildChannel(guildId: string, payload: unknown): Promise<any> {
    return this.send('POST', `/guilds/${guildId}/channels`, payload);
  }

  editChannel(channelId: string, payload: unknown): Promise<any> {
    return this.send('PATCH', `/channels/${channelId}`, payload);
  }

  createForumPost(forumId: string, payload: unknown): Promise<any> {
    return this.send('POST', `/channels/${forumId}/threads`, payload);
  }

  getChannel(channelId: string): Promise<any> {
    return this.send('GET', `/channels/${channelId}`);
  }

  editMessage(channelId: string, messageId: string, payload: unknown): Promise<any> {
    return this.send('PATCH', `/channels/${channelId}/messages/${messageId}`, payload);
  }

  getMessage(channelId: string, messageId: string): Promise<any> {
    return this.send('GET', `/channels/${channelId}/messages/${messageId}`);
  }

  async getMessages(channelId: string, limit = 50): Promise<any[]> {
    const result = await this.send('GET', `/channels/${channelId}/messages?limit=${limit}`);
    return Array.isArray(result) ? result : [];
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.send('DELETE', `/channels/${channelId}/messages/${messageId}`);
  }

  async pinMessage(channelId: string, messageId: string): Promise<void> {
    await this.send('PUT', `/channels/${channelId}/pins/${messageId}`);
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.editChannel(threadId, { archived: true });
  }

  /** The guild object, which is how we learn who owns the place. */
  getGuild(guildId: string): Promise<any> {
    return this.send('GET', `/guilds/${guildId}`);
  }

  getGuildMember(guildId: string, userId: string): Promise<any> {
    return this.send('GET', `/guilds/${guildId}/members/${userId}`);
  }

  editGuildMember(guildId: string, userId: string, payload: unknown, reason?: string): Promise<any> {
    const headers = reason ? { 'X-Audit-Log-Reason': encodeURIComponent(reason) } : undefined;
    return this.send('PATCH', `/guilds/${guildId}/members/${userId}`, payload, headers);
  }

  /** The bot's own member object, which is how we find the roles it wears. */
  getSelfMember(guildId: string): Promise<any> {
    return this.send('GET', `/users/@me/guilds/${guildId}/member`);
  }

  async getGuildRoles(guildId: string): Promise<any[]> {
    const result = await this.send('GET', `/guilds/${guildId}/roles`);
    return Array.isArray(result) ? result : [];
  }

  createGuildRole(guildId: string, payload: unknown, reason?: string): Promise<any> {
    const headers = reason ? { 'X-Audit-Log-Reason': encodeURIComponent(reason) } : undefined;
    return this.send('POST', `/guilds/${guildId}/roles`, payload, headers);
  }

  /** Bulk reorder. Discord clamps anything the bot's own role does not sit above. */
  editRolePositions(guildId: string, payload: unknown): Promise<any> {
    return this.send('PATCH', `/guilds/${guildId}/roles`, payload);
  }

  async addMemberRole(guildId: string, userId: string, roleId: string, reason?: string): Promise<void> {
    const headers = reason ? { 'X-Audit-Log-Reason': encodeURIComponent(reason) } : undefined;
    await this.send('PUT', `/guilds/${guildId}/members/${userId}/roles/${roleId}`, undefined, headers);
  }

  async removeMemberRole(guildId: string, userId: string, roleId: string, reason?: string): Promise<void> {
    const headers = reason ? { 'X-Audit-Log-Reason': encodeURIComponent(reason) } : undefined;
    await this.send('DELETE', `/guilds/${guildId}/members/${userId}/roles/${roleId}`, undefined, headers);
  }

  async editChannelPermissions(channelId: string, overwriteId: string, payload: unknown): Promise<void> {
    await this.send('PUT', `/channels/${channelId}/permissions/${overwriteId}`, payload);
  }

  createFollowup(applicationId: string, interactionToken: string, payload: unknown): Promise<any> {
    return this.send('POST', `/webhooks/${applicationId}/${interactionToken}`, payload);
  }

  editOriginal(applicationId: string, interactionToken: string, payload: unknown): Promise<any> {
    return this.send('PATCH', `/webhooks/${applicationId}/${interactionToken}/messages/@original`, payload);
  }
}
