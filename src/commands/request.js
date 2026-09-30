import { EventEmitter } from 'node:events';
import {
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { Access, hasAccess, requireAccess } from '../roles.js';
import { addTitle, fetchRequestOptions, fetchSeasons, searchMetadata } from '../scryer.js';
import {
  MAX_RESULTS,
  createSelectionSession,
  endSession,
  getSession,
  renderDetail,
  renderNotice,
  renderSelection,
  touchSession,
} from '../ui/selection.js';

const MODAL_PREFIX = 'req';

/** Emits `requested` ({ facet, titleId }) after a title is added, so discovery posts can refresh. */
export const requestEvents = new EventEmitter();
const WHOLE_SHOW = 'all';
const MAX_SELECT_OPTIONS = 25;

const FACET_LABELS = { MOVIE: 'Movie', SERIES: 'Series', ANIME: 'Anime' };

const MOVIE_MONITOR_OPTIONS = [
  { value: 'MONITORED', label: 'Monitored', description: 'Search for and download this movie' },
  { value: 'UNMONITORED', label: 'Unmonitored', description: 'Add to the library without downloading' },
];

const SERIES_MONITOR_OPTIONS = [
  { value: 'ALL_EPISODES', label: 'Monitored: all episodes', description: 'Download every episode in the chosen seasons' },
  { value: 'MISSING_AND_FUTURE_EPISODES', label: 'Monitored: missing & future', description: 'Missing episodes plus new ones as they air' },
  { value: 'FUTURE_EPISODES', label: 'Monitored: future episodes only', description: 'Only episodes that air from now on' },
  { value: 'UNMONITORED', label: 'Unmonitored', description: 'Add to the library without downloading' },
];

export const data = new SlashCommandBuilder()
  .setName('request')
  .setDescription('Search Scryer for a movie or show and request it')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((option) =>
    option
      .setName('type')
      .setDescription('What are you looking for?')
      .setRequired(true)
      .addChoices(
        { name: 'Movie', value: 'MOVIE' },
        { name: 'Series', value: 'SERIES' },
        { name: 'Anime', value: 'ANIME' },
      ),
  )
  .addStringOption((option) =>
    option.setName('query').setDescription('Title to search for').setRequired(true).setMaxLength(200),
  );

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function canRequest(interaction) {
  return hasAccess(interaction, Access.REQUEST);
}

function channelAllowed(interaction) {
  if (!config.requestChannelIds.length) return true;
  return (
    config.requestChannelIds.includes(interaction.channelId) ||
    // Allow threads created inside a request channel.
    config.requestChannelIds.includes(interaction.channel?.parentId)
  );
}

function toSelectionItem(result, index, facet) {
  const meta = [
    result.year,
    result.status,
    result.runtimeMinutes ? `${result.runtimeMinutes} min` : null,
    result.existingTitleId ? '📚 In library' : null,
  ].filter(Boolean);
  return {
    id: String(index),
    name: result.year ? `${result.name} (${result.year})` : result.name,
    imageUrl: result.posterUrl,
    description: [meta.join(' · '), truncate(result.overview, 200)].filter(Boolean).join('\n'),
    result,
    facet,
  };
}

function buildDetails(item, session) {
  const { result } = item;
  const lines = [];
  const facts = [
    `**Type:** ${FACET_LABELS[item.facet]}`,
    result.year ? `**Year:** ${result.year}` : null,
    result.status ? `**Status:** ${result.status}` : null,
    result.runtimeMinutes ? `**Runtime:** ${result.runtimeMinutes} min` : null,
    item.seasons ? `**Seasons:** ${item.seasons.filter((s) => s.number !== 0).length}` : null,
  ].filter(Boolean);
  lines.push(facts.join(' · '));

  if (result.overview) lines.push('', truncate(result.overview, 1800));

  const links = [];
  if (result.imdbId) links.push(`[IMDb](https://www.imdb.com/title/${result.imdbId})`);
  if (result.tmdbId != null) {
    links.push(`[TMDB](https://www.themoviedb.org/${item.facet === 'MOVIE' ? 'movie' : 'tv'}/${result.tmdbId})`);
  }
  if (result.tvdbId) links.push(`TVDB ${result.tvdbId}`);
  if (links.length) lines.push('', `-# ${links.join(' · ')}`);

  const options = session.state.options;
  if (result.existingTitleId) {
    item.confirmDisabledReason = '📚 This title is already in Scryer.';
  } else if (options && !options.libraries.some((library) => library.roots.length)) {
    item.confirmDisabledReason = `⚠️ Scryer has no ${FACET_LABELS[item.facet].toLowerCase()} library with a root folder.`;
  } else if (options && !options.qualityProfiles.length) {
    item.confirmDisabledReason = '⚠️ Scryer has no quality profiles configured.';
  } else {
    item.confirmDisabledReason = null;
  }

  return lines.join('\n');
}

/** Prefetch everything the request modal needs, so Confirm can open it within Discord's 3s window. */
async function onSelect(item, session) {
  const tasks = [];
  if (!session.state.options) {
    tasks.push(fetchRequestOptions(item.facet).then((options) => (session.state.options = options)));
  }
  if (item.facet !== 'MOVIE' && !item.seasons) {
    tasks.push(
      fetchSeasons(item.result)
        .then((seasons) => (item.seasons = seasons))
        .catch((error) => {
          console.warn(`Could not load seasons for ${item.result.name}:`, error.message);
          item.seasons = [];
        }),
    );
  }
  await Promise.all(tasks);
  item.details = buildDetails(item, session);
}

function defaultLibrary(libraries) {
  return libraries.find((library) => library.isDefault && library.roots.length) ?? libraries.find((l) => l.roots.length);
}

function buildRequestModal(session, item) {
  const { libraries, qualityProfiles } = session.state.options;
  const library = defaultLibrary(libraries);
  const defaultRoot = library.roots.find((root) => root.isDefault) ?? library.roots[0];
  const defaultProfileId = library.qualityProfileId;
  const isSeries = item.facet !== 'MOVIE';

  const qualitySelect = new StringSelectMenuBuilder()
    .setCustomId('quality')
    .setRequired(true)
    .addOptions(
      qualityProfiles.slice(0, MAX_SELECT_OPTIONS).map((profile) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(truncate(profile.name, 100))
          .setValue(profile.id)
          .setDefault(profile.id === defaultProfileId),
      ),
    );

  const rootOptions = libraries.flatMap((lib) =>
    lib.roots.map((root) => ({ lib, root })),
  );
  const rootSelect = new StringSelectMenuBuilder()
    .setCustomId('root')
    .setRequired(true)
    .addOptions(
      rootOptions.slice(0, MAX_SELECT_OPTIONS).map(({ lib, root }) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(truncate(root.path, 100))
          .setDescription(truncate(`Library: ${lib.name}`, 100))
          .setValue(`${lib.id}|${root.id}`)
          .setDefault(lib.id === library.id && root.id === defaultRoot.id),
      ),
    );

  const monitorOptions = isSeries ? SERIES_MONITOR_OPTIONS : MOVIE_MONITOR_OPTIONS;
  const monitorSelect = new StringSelectMenuBuilder()
    .setCustomId('monitor')
    .setRequired(true)
    .addOptions(
      monitorOptions.map((option, index) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(option.label)
          .setDescription(option.description)
          .setValue(option.value)
          .setDefault(index === 0),
      ),
    );

  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}:${session.id}:${item.id}`)
    .setTitle(truncate(`Request: ${item.result.name}`, 45));

  modal.addLabelComponents(
    new LabelBuilder().setLabel('Quality Profile').setStringSelectMenuComponent(qualitySelect),
    new LabelBuilder().setLabel('Root Folder').setStringSelectMenuComponent(rootSelect),
    new LabelBuilder().setLabel('Monitored Status').setStringSelectMenuComponent(monitorSelect),
  );

  if (isSeries) {
    const seasons = item.seasons ?? [];
    const shown = seasons.slice(0, MAX_SELECT_OPTIONS - 1);
    const seasonSelect = new StringSelectMenuBuilder()
      .setCustomId('seasons')
      .setRequired(true)
      .setMinValues(1)
      .setMaxValues(shown.length + 1)
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Whole show')
          .setDescription('Every season, including ones added later')
          .setValue(WHOLE_SHOW)
          .setDefault(true),
        ...shown.map((season) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(truncate(season.number === 0 ? 'Specials' : season.label || `Season ${season.number}`, 100))
            .setValue(String(season.number)),
        ),
      );
    const label = new LabelBuilder().setLabel('Seasons').setStringSelectMenuComponent(seasonSelect);
    const hidden = seasons.length - shown.length;
    label.setDescription(
      hidden > 0
        ? `Pick "Whole show" or specific seasons (${hidden} more not listed; use Whole show for those).`
        : 'Pick "Whole show" or one or more specific seasons.',
    );
    modal.addLabelComponents(label);
  }

  return modal;
}

async function onConfirm(interaction, item, session) {
  if (!(await requireAccess(interaction, Access.REQUEST))) return;
  if (!session.state.options || (item.facet !== 'MOVIE' && !item.seasons)) {
    // Details weren't prefetched (shouldn't happen via normal flow); load them and ask the user to retry.
    await interaction.deferUpdate();
    await onSelect(item, session);
    await interaction.editReply(await renderDetail(session, item));
    await interaction.followUp({ content: 'Loaded request options, press **Confirm** again.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (item.confirmDisabledReason) {
    await interaction.reply({ content: item.confirmDisabledReason, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.showModal(buildRequestModal(session, item));
}

export async function execute(interaction) {
  if (!channelAllowed(interaction)) {
    const where = config.requestChannelIds.map((id) => `<#${id}>`).join(', ');
    await interaction.reply({ content: `Use \`/request\` in ${where}.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!(await requireAccess(interaction, Access.REQUEST))) return;

  const facet = interaction.options.getString('type', true);
  const query = interaction.options.getString('query', true).trim();

  await interaction.deferReply();

  let results;
  try {
    results = await searchMetadata(query, facet, MAX_RESULTS);
  } catch (error) {
    console.error('Scryer search failed:', error);
    await interaction.editReply(await renderNotice(`⚠️ Scryer search failed: ${error.message}`));
    return;
  }

  if (!results.length) {
    await interaction.editReply(await renderNotice(`🔍 No ${FACET_LABELS[facet].toLowerCase()} results for **${truncate(query, 100)}**.`));
    return;
  }

  const session = createSelectionSession({
    userId: interaction.user.id,
    title: `${FACET_LABELS[facet]} results for “${truncate(query, 100)}”`,
    results: results.slice(0, MAX_RESULTS).map((result, index) => toSelectionItem(result, index, facet)),
    confirmLabel: 'Request',
    onSelect,
    onConfirm,
  });

  session.message = await interaction.editReply(await renderSelection(session, 0));
}

/**
 * Starts a private (ephemeral) request for one already-known title, e.g. picked
 * from a discovery feed post: shows its detail view with the Request button.
 */
export async function startRequestForResult(interaction, result, facet) {
  if (!(await requireAccess(interaction, Access.REQUEST))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const item = toSelectionItem(result, 0, facet);
  const session = createSelectionSession({
    userId: interaction.user.id,
    title: item.name,
    results: [item],
    confirmLabel: 'Request',
    allowBack: false,
    onSelect,
    onConfirm,
  });
  try {
    await onSelect(item, session);
  } catch (error) {
    console.error('Loading request options failed:', error);
    item.confirmDisabledReason = `⚠️ Could not load request options: ${error.message}`;
  }
  await interaction.editReply(await renderDetail(session, item));
}

export function isRequestModal(interaction) {
  return interaction.isModalSubmit() && interaction.customId.startsWith(`${MODAL_PREFIX}:`);
}

export async function handleModalSubmit(interaction) {
  const [, sessionId, itemId] = interaction.customId.split(':');
  const session = getSession(sessionId);
  if (!session) {
    await interaction.reply({ content: '⌛ This request expired. Run `/request` again.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== session.userId || !canRequest(interaction)) {
    await interaction.reply({ content: "You can't submit this request.", flags: MessageFlags.Ephemeral });
    return;
  }
  const item = session.results.find((result) => result.id === itemId);
  if (!item) {
    await interaction.reply({ content: 'That result is no longer available.', flags: MessageFlags.Ephemeral });
    return;
  }
  touchSession(session);

  const { libraries, qualityProfiles } = session.state.options;
  const qualityProfileId = interaction.fields.getStringSelectValues('quality')[0];
  const [libraryId, rootFolderId] = interaction.fields.getStringSelectValues('root')[0].split('|');
  let monitorType = interaction.fields.getStringSelectValues('monitor')[0];

  let seasonNumbers = null;
  if (item.facet !== 'MOVIE') {
    const picked = interaction.fields.getStringSelectValues('seasons');
    if (!picked.includes(WHOLE_SHOW) && monitorType !== 'UNMONITORED') {
      seasonNumbers = picked.map(Number).sort((a, b) => a - b);
      monitorType = 'ADVANCED';
    }
  }

  await interaction.deferUpdate();

  const library = libraries.find((lib) => lib.id === libraryId);
  const root = library?.roots.find((r) => r.id === rootFolderId);
  const profile = qualityProfiles.find((p) => p.id === qualityProfileId);

  try {
    const added = await addTitle(item.result, {
      facet: item.facet,
      libraryId,
      rootFolderId,
      qualityProfileId,
      monitorType,
      seasonNumbers,
    });

    endSession(session);
    requestEvents.emit('requested', { facet: item.facet, titleId: added.title.id });

    const monitorLabel =
      (item.facet === 'MOVIE' ? MOVIE_MONITOR_OPTIONS : SERIES_MONITOR_OPTIONS).find(
        (option) => option.value === interaction.fields.getStringSelectValues('monitor')[0],
      )?.label ?? monitorType;
    const seasonsLabel =
      item.facet === 'MOVIE'
        ? null
        : seasonNumbers
          ? seasonNumbers.map((n) => (n === 0 ? 'Specials' : `S${n}`)).join(', ')
          : 'Whole show';

    const lines = [
      added.reusedExistingTitle
        ? `📚 **${item.name}** was already in Scryer.`
        : `✅ **${item.name}** was requested by <@${interaction.user.id}> and added to Scryer.`,
      '',
      `**Quality Profile:** ${profile?.name ?? qualityProfileId}`,
      `**Root Folder:** \`${root?.path ?? rootFolderId}\``,
      `**Monitored Status:** ${monitorLabel}`,
      seasonsLabel ? `**Seasons:** ${seasonsLabel}` : null,
    ].filter((line) => line !== null);

    await interaction.editReply(await renderNotice(lines.join('\n'), item.imageUrl));
  } catch (error) {
    console.error('Scryer addTitle failed:', error);
    await interaction.followUp({
      content: `⚠️ Scryer couldn't add **${item.name}**: ${error.message}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
