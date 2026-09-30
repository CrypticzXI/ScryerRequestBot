import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import * as store from '../store.js';
import { Access, requireAccess } from '../roles.js';
import { FACETS, FACET_ORDER, assertCanPost, configureGuild, removeGuild } from '../discovery/feed.js';

const PREFIX = 'dcfg';

export const data = new SlashCommandBuilder()
  .setName('discovery')
  .setDescription('Set the channel where Scryer discovery feeds are posted')
  .setContexts(InteractionContextType.Guild)
  .addChannelOption((option) =>
    option
      .setName('channel')
      .setDescription('Channel to post the discovery feeds in')
      .setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );

function feedList(facets) {
  return facets.map((facet) => `${FACETS[facet].emoji} ${FACETS[facet].label}`).join(', ');
}

export async function execute(interaction) {
  if (!(await requireAccess(interaction, Access.MANAGER))) return;
  const option = interaction.options.getChannel('channel', true);
  const channel = await interaction.client.channels.fetch(option.id).catch(() => null);
  if (!channel) {
    await interaction.reply({ content: "⚠️ I can't see that channel.", flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    assertCanPost(channel, interaction.client.user);
  } catch (error) {
    await interaction.reply({ content: `⚠️ ${error.message}`, flags: MessageFlags.Ephemeral });
    return;
  }

  const current = store.getGuild(interaction.guildId);
  const selected = current?.facets?.length ? current.facets : FACET_ORDER;

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:facets:${channel.id}`)
    .setPlaceholder('Choose which feeds to post…')
    .setMinValues(1)
    .setMaxValues(FACET_ORDER.length)
    .addOptions(
      FACET_ORDER.map((facet) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(FACETS[facet].label)
          .setEmoji(FACETS[facet].emoji)
          .setValue(facet)
          .setDefault(selected.includes(facet)),
      ),
    );

  const rows = [new ActionRowBuilder().addComponents(select)];
  if (current) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${PREFIX}:remove`)
          .setLabel('Remove discovery posts')
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }

  const status = current
    ? `Currently posting ${feedList(current.facets)} in <#${current.channelId}>.\n`
    : '';
  await interaction.reply({
    content:
      `${status}Pick the feeds to post in <#${channel.id}>. Each gets its own post, refreshed daily and whenever someone requests a title. ` +
      'Choosing again replaces the existing posts.',
    components: rows,
    flags: MessageFlags.Ephemeral,
  });
}

export function isDiscoveryConfigInteraction(interaction) {
  return 'customId' in interaction && interaction.customId.startsWith(`${PREFIX}:`);
}

export async function handleConfigInteraction(interaction) {
  if (!(await requireAccess(interaction, Access.MANAGER))) return;
  const [, action, channelId] = interaction.customId.split(':');

  if (action === 'remove') {
    await interaction.update({ content: 'Removing discovery posts…', components: [] });
    await removeGuild(interaction.client, interaction.guildId);
    await interaction.editReply({ content: '🗑️ Discovery posts removed. Run `/discovery` to set them up again.' });
    return;
  }

  if (action === 'facets') {
    const facets = FACET_ORDER.filter((facet) => interaction.values.includes(facet));
    await interaction.update({ content: `Posting ${feedList(facets)} in <#${channelId}>…`, components: [] });
    try {
      await configureGuild(interaction.client, interaction.guildId, channelId, facets);
      await interaction.editReply({ content: `✅ Discovery is set up in <#${channelId}>: ${feedList(facets)}.` });
    } catch (error) {
      console.error('Configuring discovery failed:', error);
      await interaction.editReply({ content: `⚠️ Couldn't set up discovery: ${error.message}` });
    }
  }
}
