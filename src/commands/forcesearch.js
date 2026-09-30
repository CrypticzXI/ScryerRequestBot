import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { Access, requireAccess } from '../roles.js';
import {
  fetchAcquisitionSearchJob,
  fetchActivityEvents,
  findMonitoredTitles,
  triggerAcquisitionSearch,
} from '../scryer.js';
import { createSelectionSession, endSession, renderNotice, renderSelection } from '../ui/selection.js';

const POLL_MS = 3_000;
const MAX_WAIT_MS = 60 * 60_000;
// Interaction tokens expire after 15 minutes; after that, edit the message directly.
const TOKEN_LIFETIME_MS = 14 * 60_000;
const MAX_RESULT_LINES = 15;

const FACET_LABELS = { MOVIE: 'Movie', SERIES: 'Series', ANIME: 'Anime' };

export const data = new SlashCommandBuilder()
  .setName('forcesearch')
  .setDescription('Make Scryer search indexers for monitored titles that are missing')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((option) =>
    option
      .setName('query')
      .setDescription('Only search this monitored title (leave empty to search everything missing)')
      .setMaxLength(200),
  );

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function displayName(title) {
  return title.year ? `${title.name} (${title.year})` : title.name;
}

function progressText(label, job) {
  const lines = [`## 🔎 Searching ${label}…`];
  if (job.total > 0) {
    lines.push(`**Progress:** ${job.processed} / ${job.total} · **Grabbed:** ${job.grabbedCount} · **Failed:** ${job.failedCount}`);
  } else {
    lines.push('Finding monitored items that need downloading…');
  }
  if (job.currentTitle) lines.push(`-# Now searching: ${truncate(job.currentTitle, 150)}`);
  return lines.join('\n');
}

async function relayedEvents(job, titleId) {
  const since = new Date(job.startedAt).getTime() - 5_000;
  const events = await fetchActivityEvents(200).catch((error) => {
    console.warn('Could not read Scryer activity:', error.message);
    return [];
  });
  return events
    .filter(
      (event) =>
        (event.kind === 'ACQUISITION_CANDIDATE_ACCEPTED' || event.kind === 'ACQUISITION_DOWNLOAD_FAILED') &&
        new Date(event.occurredAt).getTime() >= since &&
        (!titleId || event.titleId === titleId),
    )
    .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
}

function resultText(label, job, events, timedOut) {
  const icon = { COMPLETED: '✅', FAILED: '⚠️', CANCELLED: '⏹️', RUNNING: '⏳' }[job.state] ?? '✅';
  const heading = timedOut ? `## ⏳ Still searching ${label}` : `## ${icon} Search finished: ${label}`;
  const summary = timedOut
    ? 'The search is still running in Scryer. Check its Activity page for the rest.'
    : job.state === 'FAILED'
      ? job.jobRun?.errorText || job.jobRun?.summaryText || 'The search failed.'
      : job.jobRun?.summaryText || `Searched ${job.processed} item(s); grabbed ${job.grabbedCount}, failed ${job.failedCount}.`;

  const lines = [heading, summary];
  if (job.total > 0) {
    lines.push(`-# ${job.processed} / ${job.total} searched · ${job.grabbedCount} grabbed · ${job.failedCount} failed`);
  }
  if (events.length) {
    lines.push('');
    for (const event of events.slice(0, MAX_RESULT_LINES)) {
      const mark = event.kind === 'ACQUISITION_CANDIDATE_ACCEPTED' ? '📥' : '❌';
      lines.push(`${mark} ${truncate(event.message, 180)}`);
    }
    if (events.length > MAX_RESULT_LINES) lines.push(`-# …and ${events.length - MAX_RESULT_LINES} more in Scryer's Activity page.`);
  }
  return lines.join('\n');
}

/**
 * Starts the search, keeps the message updated with progress while Scryer
 * works, then relays the outcome and every grab/failure it logged.
 */
async function runSearch(interaction, { titleId = null, label, posterUrl = null }) {
  const startedAt = Date.now();
  let message = null;
  const show = async (text) => {
    const payload = await renderNotice(text, posterUrl);
    if (Date.now() - startedAt < TOKEN_LIFETIME_MS || !message) {
      message = await interaction.editReply(payload);
    } else {
      await message.edit(payload);
    }
  };

  let job;
  try {
    job = await triggerAcquisitionSearch({ titleId });
  } catch (error) {
    console.error('Starting Scryer search failed:', error);
    await show(`## ⚠️ Couldn't start the search\n${error.message}`);
    return;
  }

  let lastText = '';
  while (job.state === 'RUNNING' && Date.now() - startedAt < MAX_WAIT_MS) {
    const text = progressText(label, job);
    if (text !== lastText) {
      await show(text).catch((error) => console.warn('Progress update failed:', error.message));
      lastText = text;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    try {
      job = (await fetchAcquisitionSearchJob(job.id)) ?? { ...job, state: 'COMPLETED' };
    } catch (error) {
      console.warn('Polling Scryer search failed:', error.message);
    }
  }

  const timedOut = job.state === 'RUNNING';
  const events = await relayedEvents(job, titleId);
  await show(resultText(label, job, events, timedOut)).catch((error) => console.error('Posting search results failed:', error));
}

export async function execute(interaction) {
  if (!(await requireAccess(interaction, Access.MANAGER))) return;
  const query = interaction.options.getString('query')?.trim();
  await interaction.deferReply();

  if (!query) {
    await runSearch(interaction, { label: 'all missing monitored titles' });
    return;
  }

  let titles;
  try {
    titles = await findMonitoredTitles(query, 20);
  } catch (error) {
    console.error('Scryer title lookup failed:', error);
    await interaction.editReply(await renderNotice(`⚠️ Couldn't look up titles in Scryer: ${error.message}`));
    return;
  }

  if (!titles.length) {
    await interaction.editReply(await renderNotice(`🔍 No monitored title in Scryer matches **${truncate(query, 100)}**.`));
    return;
  }
  if (titles.length === 1) {
    const [title] = titles;
    await runSearch(interaction, { titleId: title.id, label: `**${displayName(title)}**`, posterUrl: title.posterUrl });
    return;
  }

  // Several matches: let the user pick which one to search, using the shared picker.
  const session = createSelectionSession({
    userId: interaction.user.id,
    title: `Monitored titles matching “${truncate(query, 100)}”`,
    results: titles.map((title, index) => ({
      id: String(index),
      name: displayName(title),
      imageUrl: title.posterUrl,
      description: `${FACET_LABELS[title.facet] ?? title.facet} · Monitored`,
      title,
    })),
    confirmLabel: 'Search',
    onConfirm: async (buttonInteraction, item, current) => {
      if (!(await requireAccess(buttonInteraction, Access.MANAGER))) return;
      endSession(current);
      await buttonInteraction.deferUpdate();
      await runSearch(buttonInteraction, {
        titleId: item.title.id,
        label: `**${item.name}**`,
        posterUrl: item.title.posterUrl,
      });
    },
  });
  session.message = await interaction.editReply(await renderSelection(session, 0));
}
