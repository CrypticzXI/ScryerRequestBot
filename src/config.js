function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function list(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function graphqlEndpoint(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/graphql') ? trimmed : `${trimmed}/graphql`;
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  // When set, commands register to this guild instantly; otherwise globally.
  discordGuildId: process.env.DISCORD_GUILD_ID?.trim() || null,

  scryerUrl: required('SCRYER_URL').replace(/\/+$/, ''),
  scryerGraphqlUrl: graphqlEndpoint(required('SCRYER_URL')),
  scryerApiToken: required('SCRYER_API_TOKEN'),
  scryerLanguage: process.env.SCRYER_LANGUAGE?.trim() || 'eng',

  // Channels where /request may be used. Empty = any channel.
  requestChannelIds: list('REQUEST_CHANNEL_IDS'),

  sessionTtlMs: Number(process.env.SESSION_TTL_MINUTES || 15) * 60_000,

  // Where the /discovery channel setup is saved.
  dataDir: process.env.DATA_DIR?.trim() || './data',
  discoveryRefreshMs: Number(process.env.DISCOVERY_REFRESH_HOURS || 24) * 3_600_000,
  discoveryMaxItems: Math.min(Math.max(Number(process.env.DISCOVERY_MAX_ITEMS || 50), 5), 125),
};
