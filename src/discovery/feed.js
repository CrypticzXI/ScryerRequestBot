import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { fetchDiscovery, metadataResultFromDiscovery } from '../scryer.js';
import { startRequestForResult } from '../commands/request.js';
import { loadPosters, withPosters } from '../images.js';
import * as store from '../store.js';

/**
 * Discovery feed posts: one persistent Components V2 message per selected
 * facet in a guild's discovery channel, paginated in place, with a select to
 * request any title on the current page. Custom IDs: `dsc:<FACET>:<action>[:<arg>]`.
 */

export const FACETS = {
  MOVIE: { label: 'Movies', emoji: '🎬', accent: 0xe5a00d },
  SERIES: { label: 'TV Shows', emoji: '📺', accent: 0x3b82f6 },
  ANIME: { label: 'Anime', emoji: '🌸', accent: 0xec4899 },
};
export const FACET_ORDER = ['MOVIE', 'SERIES', 'ANIME'];

const PREFIX = 'dsc';
const PAGE_SIZE = 5;

/** facet -> { items, fetchedAt, version } */
const feeds = new Map();
/** messageId -> current page, so refreshes keep people where they were */
const pages = new Map();

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function formatRating(rating) {
  if (rating == null) return null;
  return rating <= 10 ? `⭐ ${rating.toFixed(1)}` : `⭐ ${Math.round(rating)}%`;
}

async function loadFeed(facet) {
  const items = await fetchDiscovery(facet, config.discoveryMaxItems);
  const fetchedAt = Date.now();
  const feed = { items, fetchedAt, version: fetchedAt.toString(36) };
  feeds.set(facet, feed);
  return feed;
}

async function ensureFeed(facet) {
  return feeds.get(facet) ?? loadFeed(facet);
}

function pageCount(feed) {
  return Math.max(1, Math.ceil(feed.items.length / PAGE_SIZE));
}

export async function renderFeed(facet, feed, page = 0) {
  const meta = FACETS[facet];
  const pages = pageCount(feed);
  page = Math.min(Math.max(0, page), pages - 1);
  const start = page * PAGE_SIZE;
  const visible = feed.items.slice(start, start + PAGE_SIZE);
  const refreshed = `<t:${Math.floor(feed.fetchedAt / 1000)}:R>`;
  const posters = await loadPosters(visible.map((item) => item.posterUrl), 'w250');

  const container = new ContainerBuilder()
    .setAccentColor(meta.accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${meta.emoji} Discover ${meta.label}\n-# Refreshed ${refreshed}` +
          (feed.items.length ? ` · Page ${page + 1} / ${pages} · ${feed.items.length} titles` : ''),
      ),
    );

  if (!visible.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`Nothing new to discover in ${meta.label.toLowerCase()} right now. Check back after the next refresh.`),
    );
    return withPosters({ flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } }, posters);
  }

  for (const [offset, item] of visible.entries()) {
    const facts = [item.year, formatRating(item.rating), item.sectionTitle].filter(Boolean).join(' · ');
    const text = new TextDisplayBuilder().setContent(
      `### ${start + offset + 1}. ${truncate(item.displayTitle, 150)}` +
        (facts ? `\n-# ${truncate(facts, 200)}` : '') +
        (item.overview ? `\n${truncate(item.overview, 220)}` : ''),
    );
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
    const poster = posters.ref(item.posterUrl);
    if (poster) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(text)
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(poster).setDescription(truncate(item.displayTitle, 1000))),
      );
    } else {
      container.addTextDisplayComponents(text);
    }
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:${facet}:request:${feed.version}`)
    .setPlaceholder('Request one of these…')
    .addOptions(
      visible.map((item, offset) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(truncate(`${start + offset + 1}. ${item.displayTitle}${item.year ? ` (${item.year})` : ''}`, 100))
          .setValue(String(start + offset)),
      ),
    );

  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:${facet}:page:${page - 1}`)
      .setLabel('Previous')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:${facet}:noop`)
      .setLabel(`Page ${page + 1} / ${pages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:${facet}:page:${page + 1}`)
      .setLabel('Next')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages - 1),
  );

  container
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(new ActionRowBuilder().addComponents(select), nav);

  return withPosters({ flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } }, posters);
}

async function fetchChannel(client, channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    return channel?.isTextBased() ? channel : null;
  } catch {
    return null;
  }
}

/** Throws a user-facing error if the bot can't post in the channel. */
export function assertCanPost(channel, me) {
  const perms = channel.permissionsFor(me);
  const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles];
  if (channel.isThread?.()) needed.push(PermissionFlagsBits.SendMessagesInThreads);
  if (!perms?.has(needed)) {
    throw new Error(`I need **View Channel**, **Send Messages** and **Attach Files** (for posters) in <#${channel.id}>.`);
  }
}

/** Edits this guild's post for `facet`, or sends a new one if it's gone. */
async function publish(client, setup, facet, feed) {
  const channel = await fetchChannel(client, setup.channelId);
  if (!channel) {
    console.warn(`Discovery channel ${setup.channelId} in guild ${setup.guildId} is unavailable.`);
    return;
  }
  const messageId = setup.messages?.[facet];
  if (messageId) {
    try {
      const message = await channel.messages.fetch(messageId);
      await message.edit(await renderFeed(facet, feed, pages.get(messageId) ?? 0));
      return;
    } catch (error) {
      if (error.code !== 10008) throw error; // 10008 = Unknown Message: it was deleted, post again.
    }
  }
  const message = await channel.send(await renderFeed(facet, feed, 0));
  store.setMessageId(setup.guildId, facet, message.id);
}

const refreshing = new Map(); // facet -> { running: Promise, again: boolean }

/** Re-fetches one facet from Scryer and updates every guild's post for it. Concurrent calls coalesce. */
export function refreshFacet(client, facet) {
  const state = refreshing.get(facet);
  if (state) {
    state.again = true;
    return state.running;
  }
  const entry = { again: false };
  entry.running = (async () => {
    do {
      entry.again = false;
      const setups = store.allGuilds().filter((setup) => setup.facets.includes(facet));
      if (!setups.length) {
        feeds.delete(facet);
        break;
      }
      let feed;
      try {
        feed = await loadFeed(facet);
      } catch (error) {
        console.error(`Refreshing ${facet} discovery failed:`, error.message);
        break;
      }
      for (const setup of setups) {
        await publish(client, setup, facet, feed).catch((error) =>
          console.error(`Updating ${facet} discovery post in guild ${setup.guildId} failed:`, error.message),
        );
      }
    } while (entry.again);
  })().finally(() => refreshing.delete(facet));
  refreshing.set(facet, entry);
  return entry.running;
}

export async function refreshAll(client) {
  const facets = new Set(store.allGuilds().flatMap((setup) => setup.facets));
  for (const facet of FACET_ORDER.filter((f) => facets.has(f))) {
    await refreshFacet(client, facet);
  }
}

async function deletePosts(client, setup) {
  const channel = setup && (await fetchChannel(client, setup.channelId));
  if (!channel) return;
  for (const messageId of Object.values(setup.messages ?? {})) {
    pages.delete(messageId);
    await channel.messages.delete(messageId).catch(() => {});
  }
}

/** Saves a guild's discovery channel + facets and (re)posts the feeds there in a fixed order. */
export async function configureGuild(client, guildId, channelId, facets) {
  const ordered = FACET_ORDER.filter((facet) => facets.includes(facet));
  await deletePosts(client, store.getGuild(guildId));
  store.setGuild(guildId, { channelId, facets: ordered, messages: {} });
  const setup = { guildId, ...store.getGuild(guildId) };
  for (const facet of ordered) {
    const feed = await ensureFeed(facet);
    await publish(client, setup, facet, feed);
    setup.messages = store.getGuild(guildId).messages;
  }
}

export async function removeGuild(client, guildId) {
  await deletePosts(client, store.getGuild(guildId));
  store.deleteGuild(guildId);
}

export function isFeedInteraction(interaction) {
  return 'customId' in interaction && interaction.customId.startsWith(`${PREFIX}:`);
}

export async function handleFeedInteraction(interaction) {
  const [, facet, action, arg] = interaction.customId.split(':');
  if (!FACETS[facet]) return interaction.deferUpdate();

  const feed = await ensureFeed(facet);

  if (action === 'page') {
    // Posters download while rendering, so acknowledge first.
    await interaction.deferUpdate();
    const page = Number(arg);
    pages.set(interaction.message.id, page);
    await interaction.editReply(await renderFeed(facet, feed, page));
    return;
  }

  if (action === 'request') {
    const item = arg === feed.version ? feed.items[Number(interaction.values[0])] : null;
    if (!item) {
      // The list refreshed since this message was rendered; show the fresh one.
      await interaction.deferUpdate();
      await interaction.editReply(await renderFeed(facet, feed, pages.get(interaction.message.id) ?? 0));
      await interaction.followUp({ content: 'This list was just refreshed. Please pick again.', flags: MessageFlags.Ephemeral });
      return;
    }
    await startRequestForResult(interaction, metadataResultFromDiscovery(item), facet);
    // Reset the select so the same title can be picked again by someone else.
    await renderFeed(facet, feed, pages.get(interaction.message.id) ?? 0)
      .then((payload) => interaction.message.edit(payload))
      .catch(() => {});
    return;
  }

  await interaction.deferUpdate();
}

/** Refreshes every configured feed now, then every `DISCOVERY_REFRESH_HOURS`. */
export function startDailyRefresh(client) {
  refreshAll(client).catch((error) => console.error('Discovery refresh failed:', error));
  setInterval(() => {
    refreshAll(client).catch((error) => console.error('Discovery refresh failed:', error));
  }, config.discoveryRefreshMs).unref();
}
