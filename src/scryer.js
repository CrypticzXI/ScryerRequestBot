import { config } from './config.js';

export class ScryerError extends Error {}

async function gql(query, variables = {}) {
  let response;
  try {
    response = await fetch(config.scryerGraphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${config.scryerApiToken}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new ScryerError(`Could not reach Scryer at ${config.scryerGraphqlUrl}: ${error.message}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new ScryerError(`Scryer returned HTTP ${response.status} with a non-JSON body.`);
  }

  if (body.errors?.length) {
    throw new ScryerError(body.errors.map((error) => error.message).join('; '));
  }
  if (!response.ok) {
    throw new ScryerError(`Scryer returned HTTP ${response.status}.`);
  }
  return body.data;
}

const SEARCH_METADATA = `query SearchMetadata($query: String!, $type: MediaFacetValue!, $limit: Int!, $language: String!) {
  searchMetadata(query: $query, type: $type, limit: $limit, language: $language) {
    tvdbId smgId tmdbId imdbId primarySource
    externalIds { source kind value }
    name slug type year status overview posterUrl language runtimeMinutes sortTitle
    existingTitleId
  }
}`;

const METADATA_SERIES_SEASONS = `query MetadataSeriesSeasons($input: MetadataSeriesInput!) {
  metadataSeries(input: $input) {
    seasons { number label episodeType }
  }
}`;

const REQUEST_OPTIONS = `query RequestOptions($facet: MediaFacetValue!) {
  libraries(facet: $facet, permission: MANAGE_TITLES) {
    id name isDefault qualityProfileId
    roots { id path isDefault }
  }
  qualityProfileSettings {
    profiles { id name }
  }
}`;

const ADD_TITLE = `mutation AddTitle($input: AddTitleInput!) {
  addTitle(input: $input) {
    title { id name }
    reusedExistingTitle
  }
}`;

const DISCOVERY_ITEM_FIELDS = `
      id targetKey targetKind contentType displayTitle year posterUrl overview rating
      isAdult ownedInInput resolvedTitleId statusTags sourceTags sortTitle
      externalIds { source kind id key }`;

const DISCOVERY_HOME = `query DiscoveryHome($input: DiscoveryHomeInput) {
  discoveryHome(input: $input) {
    publicSections { sectionId title items {${DISCOVERY_ITEM_FIELDS}
    } }
    personalizedSections { sectionId title items {${DISCOVERY_ITEM_FIELDS}
    } }
  }
}`;

/**
 * What Scryer's /discovery page shows for one facet, flattened across its
 * sections (personalized first), de-duplicated, without owned or adult titles.
 */
export async function fetchDiscovery(facet, maxItems) {
  const data = await gql(DISCOVERY_HOME, {
    input: {
      includePublic: true,
      includePersonalized: true,
      includeUnresolved: true,
      limitPerSection: 40,
      filters: { contentTypes: [facet] },
    },
  });
  const sections = [...data.discoveryHome.personalizedSections, ...data.discoveryHome.publicSections];
  const seen = new Set();
  const items = [];
  for (const section of sections) {
    for (const item of section.items) {
      const itemFacet = (item.contentType || item.targetKind || '').toUpperCase();
      if (itemFacet !== facet || item.ownedInInput || item.resolvedTitleId || item.isAdult) continue;
      if (seen.has(item.targetKey)) continue;
      seen.add(item.targetKey);
      items.push({ ...item, sectionTitle: section.title });
      if (items.length >= maxItems) return items;
    }
  }
  return items;
}

const EXTERNAL_ID_SOURCES = {
  imdb: 'imdb', imdbcom: 'imdb', tmdb: 'tmdb', themoviedb: 'tmdb', themoviedborg: 'tmdb',
  tvdb: 'tvdb', thetvdb: 'tvdb', thetvdbcom: 'tvdb', smg: 'smg',
  anidb: 'anidb', anilist: 'anilist', mal: 'mal', myanimelist: 'mal',
};

function normalizeSource(value) {
  return EXTERNAL_ID_SOURCES[value?.trim().toLowerCase().replace(/[\s_.-]+/g, '')] ?? null;
}

/** Parses keys like `tmdb:movie:603`, `imdb:tt0133093` or a themoviedb.org URL. */
function externalIdFromKey(key) {
  try {
    const url = new URL(key);
    const host = url.hostname.replace(/^www\./, '');
    const path = url.pathname;
    let match;
    if (host === 'imdb.com' && (match = path.match(/\/title\/(tt\d+)/i))) return { source: 'imdb', value: match[1] };
    if (host === 'themoviedb.org' && (match = path.match(/\/(movie|tv)\/(\d+)/i))) return { source: 'tmdb', value: match[2] };
    if (host === 'thetvdb.com' && (match = path.match(/\/(?:movies?|series)\/(\d+)/i))) return { source: 'tvdb', value: match[1] };
    return null;
  } catch {
    // Not a URL: fall through to `source:kind:id`.
  }
  const parts = key.split(':').map((part) => part.trim()).filter(Boolean);
  const source = normalizeSource(parts[0]);
  if (!source) return null;
  const value = source === 'imdb' ? (parts.find((part) => /^tt\d+$/i.test(part)) ?? parts.at(-1)) : parts.at(-1);
  return value ? { source, value } : null;
}

/** Turns a discovery item into the searchMetadata-shaped result addTitle expects (as Scryer's web UI does). */
export function metadataResultFromDiscovery(item) {
  const ids = new Map();
  for (const externalId of item.externalIds ?? []) {
    const source = normalizeSource(externalId.source);
    const parsed = source && externalId.id?.trim() ? { source, value: externalId.id.trim() } : externalIdFromKey(externalId.key ?? '');
    if (parsed && !ids.has(parsed.source)) ids.set(parsed.source, parsed.value);
  }
  if (!ids.size) {
    for (const key of [item.targetKey, ...(item.sourceTags ?? [])]) {
      const parsed = externalIdFromKey(key ?? '');
      if (parsed && !ids.has(parsed.source)) ids.set(parsed.source, parsed.value);
    }
  }
  return {
    smgId: Number(ids.get('smg')) || null,
    tvdbId: ids.get('tvdb') ?? '',
    tmdbId: Number(ids.get('tmdb')) || null,
    imdbId: ids.get('imdb') ?? null,
    externalIds: [...ids].map(([source, value]) => ({ source, value })),
    name: item.displayTitle,
    slug: null,
    year: item.year,
    status: item.statusTags?.[0] ?? null,
    overview: item.overview ?? null,
    posterUrl: item.posterUrl,
    language: null,
    runtimeMinutes: null,
    sortTitle: item.sortTitle,
    existingTitleId: item.resolvedTitleId ?? null,
  };
}

const MONITORED_TITLES = `query MonitoredTitles($query: String!, $limit: Int!) {
  titles(query: $query, filter: { monitored: true }, limit: $limit) {
    totalCount
    items { id name facet year posterUrl monitored }
  }
}`;

const SEARCH_JOB_FIELDS = `
    id state total processed grabbedCount failedCount currentTitle startedAt finishedAt
    jobRun { summaryText errorText }`;

const TRIGGER_ACQUISITION_SEARCH = `mutation TriggerAcquisitionSearch($input: TriggerAcquisitionSearchInput!) {
  triggerAcquisitionSearch(input: $input) {${SEARCH_JOB_FIELDS}
  }
}`;

const ACQUISITION_SEARCH_JOB = `query AcquisitionSearchJob($id: ID!) {
  acquisitionSearchJob(id: $id) {${SEARCH_JOB_FIELDS}
  }
}`;

const ACTIVITY_EVENTS = `query ActivityEvents($limit: Int!) {
  activityEvents(limit: $limit) {
    id kind severity titleId facet message occurredAt
  }
}`;

/** Monitored library titles whose name matches `query`. */
export async function findMonitoredTitles(query, limit = 20) {
  const data = await gql(MONITORED_TITLES, { query, limit });
  return data.titles.items;
}

/**
 * Starts Scryer's background search. With a `titleId` it searches that title
 * for missing content and upgrades; without, every monitored item that's missing.
 */
export async function triggerAcquisitionSearch({ titleId } = {}) {
  const input = titleId ? { titleId, intent: 'AUTOMATIC' } : { wantedKind: 'MISSING' };
  const data = await gql(TRIGGER_ACQUISITION_SEARCH, { input });
  return data.triggerAcquisitionSearch;
}

export async function fetchAcquisitionSearchJob(id) {
  const data = await gql(ACQUISITION_SEARCH_JOB, { id });
  return data.acquisitionSearchJob;
}

export async function fetchActivityEvents(limit = 200) {
  const data = await gql(ACTIVITY_EVENTS, { limit });
  return data.activityEvents;
}

/** @param {'MOVIE'|'SERIES'|'ANIME'} facet */
export async function searchMetadata(query, facet, limit = 20) {
  const data = await gql(SEARCH_METADATA, {
    query,
    type: facet,
    limit,
    language: config.scryerLanguage,
  });
  return data.searchMetadata;
}

/** Season numbers for a series/anime search result, sorted, specials (0) last. */
export async function fetchSeasons(result) {
  const input = { includeEpisodes: false, language: config.scryerLanguage };
  if (result.tvdbId) input.tvdbId = result.tvdbId;
  if (result.smgId != null) input.smgId = result.smgId;
  if (result.tmdbId != null) input.tmdbId = result.tmdbId;
  if (result.imdbId) input.imdbId = result.imdbId;

  const data = await gql(METADATA_SERIES_SEASONS, { input });
  const seen = new Map();
  for (const season of data.metadataSeries.seasons) {
    if (!seen.has(season.number)) seen.set(season.number, season);
  }
  return [...seen.values()].sort((a, b) => {
    if (a.number === 0) return 1;
    if (b.number === 0) return -1;
    return a.number - b.number;
  });
}

/** Libraries (with their root folders) and quality profiles for a facet. */
export async function fetchRequestOptions(facet) {
  const data = await gql(REQUEST_OPTIONS, { facet });
  return {
    libraries: data.libraries,
    qualityProfiles: data.qualityProfileSettings.profiles,
  };
}

/** Mirrors the Scryer web UI's external-id construction for addTitle. */
function externalIdsFor(result, facet) {
  const defaultKind = (source) => {
    if (source === 'smg') return 'title';
    if (source === 'tmdb' && facet !== 'MOVIE') return 'series';
    return undefined;
  };
  const candidates = [
    ...(result.externalIds ?? []),
    ...(result.smgId != null ? [{ source: 'smg', value: String(result.smgId) }] : []),
    ...(result.tvdbId ? [{ source: 'tvdb', value: String(result.tvdbId) }] : []),
    ...(result.tmdbId != null ? [{ source: 'tmdb', value: String(result.tmdbId) }] : []),
    ...(result.imdbId ? [{ source: 'imdb', value: result.imdbId }] : []),
  ];
  const seen = new Set();
  const ids = [];
  for (const candidate of candidates) {
    const source = candidate.source.trim().toLowerCase();
    const value = String(candidate.value).trim();
    const key = `${source}:${value}`;
    if (!source || !value || seen.has(key)) continue;
    seen.add(key);
    const kind = candidate.kind?.trim().toLowerCase() || defaultKind(source);
    ids.push(kind ? { source, kind, value } : { source, value });
  }
  return ids;
}

/**
 * @param {object} result          searchMetadata item
 * @param {object} choice
 * @param {'MOVIE'|'SERIES'|'ANIME'} choice.facet
 * @param {string} choice.libraryId
 * @param {string} choice.rootFolderId
 * @param {string} choice.qualityProfileId
 * @param {string} choice.monitorType    MonitorTypeValue
 * @param {number[]|null} choice.seasonNumbers  specific seasons (ADVANCED) or null for whole show
 */
export async function addTitle(result, choice) {
  const { facet } = choice;
  const monitored = choice.monitorType !== 'UNMONITORED' && choice.monitorType !== 'NONE';

  const options = {
    qualityProfileId: choice.qualityProfileId,
    rootFolderId: choice.rootFolderId,
    monitorType: choice.monitorType,
  };
  if (facet !== 'MOVIE') options.useSeasonFolders = true;
  if (choice.monitorType === 'ADVANCED') {
    options.monitorSelection = { seasonNumbers: choice.seasonNumbers };
  }

  const input = {
    name: result.name.trim(),
    facet,
    libraryId: choice.libraryId,
    monitored,
    tags: [],
    options,
    externalIds: externalIdsFor(result, facet),
    smgId: result.smgId ?? undefined,
    tvdbId: result.tvdbId || undefined,
    tmdbId: result.tmdbId ?? undefined,
    imdbId: result.imdbId || undefined,
    year: result.year ?? undefined,
    overview: result.overview || undefined,
    sortTitle: result.sortTitle || undefined,
    slug: result.slug || undefined,
    runtimeMinutes: result.runtimeMinutes ?? undefined,
    language: result.language || undefined,
    contentStatus: result.status || undefined,
  };

  const data = await gql(ADD_TITLE, { input });
  return data.addTitle;
}
