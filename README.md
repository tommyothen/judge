# Judge

Someone ate one of your fries in maccies last night. You file charges, the server votes,
and if the jury agrees they lose 3 points in front of everyone. Judge is a small claims
court for a friend group: accusations, commendations, a public scoreboard, and a coloured
standing on every member so nobody forgets.

It exists because petty grievances used to evaporate into the chat scrollback. Now they
get a case number, a jury, and a permanent record.

## Invite it

[Invite Judge](https://discord.com/oauth2/authorize?client_id=1538485024867876944&scope=bot%20applications.commands&permissions=292460522512),
then have the server owner run `/setup`. The bot builds a category with a locked
dashboard channel and a cases forum, and pins the hub message: the scoreboard, plus every
case still open. Cases are filed from the hub's buttons, voted on with the buttons on the
case post (one vote each, changeable until the deadline, and public: the case lists who
voted which way), and decided automatically when the deadline passes. Below quorum the
case is dismissed; otherwise a majority moves the points and ties acquit. Deleting a case
post before the deadline voids it.

Defaults are a quorum of 3, a six-hour vote window, and standing shown as coloured,
hoisted tier roles from Model citizen down to Beyond rehabilitation. The server owner can
change all three with `/settings`. Drag the Judge role to the top of the role list,
because Discord will not let it re-role anyone ranked above it.

Judge does not listen to your chat. It has no gateway connection and no privileged
intents, so Discord only ever sends it commands and button presses. The one place it
reads messages is the dashboard channel, which it sweeps to delete anything that is not
the hub. The permissions it asks for:

| Permission               | Why                                                     |
| ------------------------ | ------------------------------------------------------- |
| View Channels            | see the court                                           |
| Send Messages            | post the hub and open case posts                        |
| Send Messages in Threads | post the verdict inside a case                          |
| Embed Links              | every case is an embed                                  |
| Read Message History     | the cleanup sweep reads recent dashboard messages       |
| Manage Messages          | pin the hub, delete stray messages in the dashboard     |
| Manage Channels          | build the category, the dashboard and the forum         |
| Manage Threads           | tag and archive decided cases                           |
| Manage Roles             | lock the channels, create and assign the tier roles     |
| Manage Nicknames         | write the score suffix when standing uses nicknames     |

## Why Cloudflare

Discord interactions are plain HTTPS webhooks, so a bot like this needs no long-running
process: a request arrives when someone presses a button, and the rest of the time
nothing is running at all. That shape fits a Cloudflare Worker exactly. D1 holds the
settings, cases, votes and scores in SQLite, a cron trigger fires once a minute to
deliver due verdicts and tidy the courtroom, and at friend group scale the whole thing
sits inside the free tier. Deploying is one command and there is no server to maintain.

## Self-hosting

You need a Cloudflare account, `pnpm` and `wrangler`.

1. At <https://discord.com/developers/applications>, create an application and add a
   bot. Collect the bot token (Bot tab), the application ID and the public key (General
   Information). No privileged intents are needed.

2. Install, create the database and apply the schema:

   ```sh
   pnpm install
   wrangler login
   wrangler d1 create judge   # put the returned database_id in wrangler.jsonc
   pnpm db:migrate
   ```

3. Set the secrets, then deploy:

   ```sh
   wrangler secret put DISCORD_TOKEN
   wrangler secret put DISCORD_PUBLIC_KEY
   wrangler secret put DISCORD_CLIENT_ID
   pnpm run deploy
   ```

4. In the developer portal, set the Interactions Endpoint URL under General Information
   to `https://<worker>.<your-subdomain>.workers.dev/interactions`. If the portal
   refuses the URL, the usual cause is a `DISCORD_PUBLIC_KEY` that does not match the
   application.

5. Register the slash commands. Copy `.dev.vars.example` to `.dev.vars`, fill in
   `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`, and run `pnpm register`. Set
   `GUILD_ID=<your server id>` in `.dev.vars` to register to one server for instant
   testing; leave it unset to register globally, which can take up to an hour.

6. Invite your instance using the invite URL above with your own application ID, and run
   `/setup`. Servers that refuse forum creation over the API get told to make the forum
   by hand and run `/setup forum:#cases dashboard:#courtroom`, which is also how you
   adopt channels you already have.

For local work, `pnpm dev` runs `wrangler dev` against `.dev.vars` and a local D1
database (run `pnpm db:migrate:local` once first), and `pnpm typecheck` runs tsc.
Discord cannot reach localhost, so testing real interactions needs a deploy or a tunnel.

## Licence

MIT, see [LICENSE](LICENSE).
