# Scryer Request Bot

A Discord bot for your self-hosted [Scryer](https://github.com/scryer-media/scryer). Your friends can request movies, TV shows and anime from Discord, browse what's new, and managers can kick off searches.

## What you get

| Command | Who | What it does |
|---|---|---|
| `/request` | Scryer Request | Search for a movie, show or anime, pick it, choose quality / folder / monitoring / seasons, and it's added to Scryer. |
| `/discovery` | Scryer Manager | Pick a channel and the bot posts **Movies**, **TV Shows** and **Anime** feeds from Scryer's Discovery page. They refresh daily and after every request, and anyone with Scryer Request can request straight from them. |
| `/forcesearch` | Scryer Manager | Tell Scryer to search for everything missing, or for one title (`query`), and see what it grabbed. |

The bot creates the **Scryer Request** and **Scryer Manager** roles itself. Admins can always use everything.

## Setup (about 5 minutes)

### 1. Make the Discord bot
1. Go to https://discord.com/developers/applications → **New Application**.
2. Copy the **Application ID** from *General Information*.
3. Open **Bot** → **Reset Token** → copy the token.
4. Open **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `View Channels`, `Send Messages`, `Attach Files`, `Embed Links`, `Manage Roles`
5. Open the generated link and add the bot to your server.

### 2. Get a Scryer API key
In Scryer go to **Settings → API Keys** and create one. It starts with `ska`.

### 3. Configure
Copy `.env.example` to `.env` and fill in:

```env
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-application-id
DISCORD_GUILD_ID=your-server-id
SCRYER_URL=http://localhost:8080
SCRYER_API_TOKEN=ska...
```

To get IDs like `DISCORD_GUILD_ID`, turn on *Developer Mode* in Discord (Settings → Advanced), then right-click your server → **Copy Server ID**.

### 4. Run it

With Node.js 22+:

```bash
npm install
npm start
```

Or with Docker, using the prebuilt image (amd64 + arm64). Put your `.env` next to [`docker-compose.yml`](docker-compose.yml), then run:

```bash
docker compose up -d
```

Or without compose:

```bash
docker run -d --name scryer-request-bot --restart unless-stopped --env-file .env -e DATA_DIR=/app/data -v ./data:/app/data ghcr.io/crypticzxi/scryerrequestbot:latest
```

To update: `docker compose pull && docker compose up -d`.

### 5. In Discord
1. Give people the **Scryer Request** role, and yourself or your mods **Scryer Manager**.
2. Run `/discovery channel:#discovery` and pick which feeds you want.
3. Try `/request`.

## Optional settings

| Setting | Default | What it does |
|---|---|---|
| `REQUEST_CHANNEL_IDS` | any channel | Only allow `/request` in these channels (comma-separated IDs) |
| `DISCOVERY_REFRESH_HOURS` | `24` | How often the discovery feeds refresh |
| `DISCOVERY_MAX_ITEMS` | `50` | Titles per feed (5 per page) |
| `SCRYER_LANGUAGE` | `eng` | Metadata language |
| `REQUEST_ROLE_NAME` / `MANAGER_ROLE_NAME` | `Scryer Request` / `Scryer Manager` | Use different role names |

## Troubleshooting

- **Commands don't show up:** set `DISCORD_GUILD_ID`. Without it, Discord can take up to an hour to show the commands.
- **Roles weren't created:** the bot needs **Manage Roles**. You can also create the two roles yourself with those exact names.
- **No posters:** the bot needs **Attach Files** in that channel.
- **"Could not reach Scryer":** check `SCRYER_URL`. In Docker, use Scryer's container name instead of `localhost`, e.g. `http://scryer:8080`.
