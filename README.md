# Judge

Someone ate one of your fries in maccies last night. You file charges, the server votes,
and if the jury agrees they lose 3 points in front of everyone. Judge is a small claims
court for a friend group: accusations, commendations, a public scoreboard, and a coloured
standing on every member so nobody forgets.

It runs as a single Cloudflare Worker. Interactions only, no gateway connection, no
privileged intents. D1 holds the settings, cases, votes and scores; a one-minute cron
closes cases that are due and tidies the courtroom.

## How it works

`/setup` builds a category with two channels. The dashboard is a locked text channel
holding one pinned hub message: the scoreboard, plus a link to every case still open. The
cases forum is where cases live, one post each; decided posts keep an outcome tag, so the
forum doubles as the archive.

Cases are filed from the hub's buttons, which open a modal asking who, what they did, and
how serious it was. An accusation costs the defendant points (-1, -3 or -5) and a
commendation adds them (+1, +3 or +5). The filer's own vote is counted automatically,
because filing is itself an opinion. You get two open accusations at a time, one per
target, you cannot commend yourself, and bots are not tried.

Everyone else votes with the two buttons on the case post: Guilty or Not guilty on an
accusation, Seconded or Overruled on a commendation. One vote each, changeable until the
deadline. Votes are public; the case embed lists who voted which way.

When the deadline passes, the cron closes the case. Below quorum it is dismissed and
nothing moves. Otherwise a majority carries and the points change hands; ties acquit.
Deleting the case post before the deadline voids the case entirely, which is the only way
to cancel a filing.

Every score falls into one of eight tiers, from Model citizen down to Beyond
rehabilitation. By default each tier is a coloured, hoisted role, so the member list sorts
itself by reputation. `/settings standing` switches to a nickname suffix like
"Sushi (130)", both, or off. Discord will not let the bot touch the server owner or anyone
ranked above it, so drag the Judge role to the top of the role list.

## Setup

### 1. Create the Discord application

At <https://discord.com/developers/applications>, create an application and add a bot.
Collect the bot token (Bot tab), the application ID and the public key (both under
General Information). No privileged intents are needed.

### 2. Install and create the database

```sh
pnpm install
wrangler login
wrangler d1 create judge
```

Put the returned `database_id` in `wrangler.jsonc`, then apply the schema with
`pnpm db:migrate` (or `pnpm db:migrate:local` for the local copy `wrangler dev` uses).

### 3. Set the secrets

```sh
wrangler secret put DISCORD_TOKEN
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_CLIENT_ID
```

### 4. Deploy and point Discord at it

```sh
pnpm run deploy
```

In the developer portal, set the Interactions Endpoint URL under General Information to
`https://<worker>.<your-subdomain>.workers.dev/interactions`. Discord sends a signed PING
when you save; if the portal refuses the URL, the usual cause is a `DISCORD_PUBLIC_KEY`
that does not match the application.

### 5. Invite the bot

Scopes `bot` and `applications.commands`, permissions `292460522512`:

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot%20applications.commands&permissions=292460522512
```

That covers viewing and posting in the court, embeds, and the management permissions the
bot actually uses: Manage Channels builds the category and channels, Manage Roles writes
the channel locks and the tier roles, Manage Threads tags and archives decided cases,
Manage Messages pins the hub and deletes intruders, and Manage Nicknames writes the score
suffix. A bot already in the server picks up new permissions when you re-run the invite
URL.

### 6. Register the slash commands

```sh
cp .dev.vars.example .dev.vars
pnpm register
```

The register script needs `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` filled in. Add
`GUILD_ID=<your server id>` to register to one server, where the commands appear
immediately; without it they register globally, which can take up to an hour.

### 7. Open the court

Run `/setup` with no options and the bot builds the lot. Some servers refuse forum
creation over the API; if so, make the forum yourself in Server Settings and run
`/setup forum:#cases dashboard:#courtroom`, which is also how you adopt channels you
already have.

## Local development

`pnpm dev` runs `wrangler dev`, which loads `.dev.vars` and a local D1 database (run
`pnpm db:migrate:local` once first). `pnpm typecheck` runs tsc. Discord cannot reach
localhost, so testing real interactions needs a deploy or a tunnel. A `GET /` on the
worker returns a plain text greeting, handy for checking a deploy is alive.

## Settings

`/settings show` prints the current values. Both `/setup` and `/settings` answer only to
the chief justice, who is the server owner.

| Setting     | Command                        | Values                                | Default |
| ----------- | ------------------------------ | ------------------------------------- | ------- |
| Quorum      | `/settings quorum value:<n>`   | 2 to 20                               | 3       |
| Vote window | `/settings duration value:<v>` | 10 minutes, 1 hour, 6 hours, 24 hours | 6 hours |
| Standing    | `/settings standing mode:<m>`  | roles, nicknames, both, off           | roles   |

Quorum counts every vote on a case, the filer's included, so a quorum of 3 needs two
other people to turn up. The vote window is the default for new cases; the filing modal
can override it per case.

## Licence

MIT, see [LICENSE](LICENSE).
