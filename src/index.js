import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } from 'discord.js';
import { config } from './config.js';
import * as request from './commands/request.js';
import * as discovery from './commands/discovery.js';
import * as forcesearch from './commands/forcesearch.js';
import { handleFeedInteraction, isFeedInteraction, refreshFacet, startDailyRefresh } from './discovery/feed.js';
import { handleSelectionInteraction, isSelectionInteraction } from './ui/selection.js';
import { ROLE_NAMES, setupRoles } from './roles.js';

const commands = new Map([request, discovery, forcesearch].map((command) => [command.data.name, command]));

async function registerCommands() {
  const rest = new REST().setToken(config.discordToken);
  const body = [...commands.values()].map((command) => command.data.toJSON());
  const route = config.discordGuildId
    ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
    : Routes.applicationCommands(config.discordClientId);
  await rest.put(route, { body });
  console.log(`Registered ${body.length} command(s) ${config.discordGuildId ? `in guild ${config.discordGuildId}` : 'globally'}.`);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (ready) => {
  console.log(`Logged in as ${ready.user.tag}. Scryer: ${config.scryerGraphqlUrl}`);
  if (config.requestChannelIds.length) {
    console.log(`/request restricted to channel(s): ${config.requestChannelIds.join(', ')}`);
  }
  console.log(`Access roles: ${Object.values(ROLE_NAMES).join(', ')} (Administrators always have access)`);
  setupRoles(client);
  try {
    await registerCommands();
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
  startDailyRefresh(client);
});

// A new request changes what's "new" for that media type, so refresh its feed (debounced).
const pendingRefresh = new Map();
request.requestEvents.on('requested', ({ facet }) => {
  clearTimeout(pendingRefresh.get(facet));
  pendingRefresh.set(
    facet,
    setTimeout(() => {
      pendingRefresh.delete(facet);
      refreshFacet(client, facet).catch((error) => console.error('Discovery refresh failed:', error));
    }, 5_000),
  );
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await commands.get(interaction.commandName)?.execute(interaction);
    } else if (interaction.isMessageComponent() && isSelectionInteraction(interaction)) {
      await handleSelectionInteraction(interaction);
    } else if (interaction.isMessageComponent() && isFeedInteraction(interaction)) {
      await handleFeedInteraction(interaction);
    } else if (interaction.isMessageComponent() && discovery.isDiscoveryConfigInteraction(interaction)) {
      await discovery.handleConfigInteraction(interaction);
    } else if (request.isRequestModal(interaction)) {
      await request.handleModalSubmit(interaction);
    }
  } catch (error) {
    console.error('Interaction failed:', error);
    if (!interaction.isRepliable()) return;
    const payload = { content: `⚠️ Something went wrong: ${error.message}`, flags: MessageFlags.Ephemeral };
    await (interaction.replied || interaction.deferred ? interaction.followUp(payload) : interaction.reply(payload)).catch(() => {});
  }
});

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

client.login(config.discordToken);
