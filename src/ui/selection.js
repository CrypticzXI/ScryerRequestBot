import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { loadPosters, withPosters } from '../images.js';

/**
 * Reusable paginated "pick one of N results" UI built on Discord Components V2.
 *
 * An item is `{ id, name, imageUrl?, description?, details?, confirmDisabledReason? }`:
 *  - `description` shows in the list (truncated) and the select option.
 *  - `details` is full markdown shown on the detail view (falls back to description).
 *  - `confirmDisabledReason` disables Confirm and shows the reason instead.
 *
 * Custom IDs are `sel:<sessionId>:<action>[:<arg>]`, so any command can reuse
 * this by calling `createSelectionSession()` and routing interactions whose
 * custom ID starts with `sel:` to `handleSelectionInteraction()`.
 */

export const PAGE_SIZE = 5;
export const MAX_RESULTS = 20;
const PREFIX = 'sel';
const ACCENT = 0x7c5cff;

const sessions = new Map();

/**
 * @param {object} options
 * @param {string} options.userId              only this user may interact
 * @param {Array}  options.results             up to 20 items
 * @param {string} options.title               heading shown above the results
 * @param {string} [options.confirmLabel]
 * @param {boolean} [options.allowBack]       show "Back to results" on the detail view
 * @param {(item, session) => Promise<void>} [options.onSelect]
 *        runs (after the interaction is deferred) before the detail view renders;
 *        may mutate `item` (e.g. add details) or stash data on `session.state`.
 * @param {(interaction, item, session) => Promise<void>} options.onConfirm
 *        receives the *unacknowledged* button interaction, so it can show a modal.
 */
export function createSelectionSession({ userId, results, title, confirmLabel = 'Confirm', allowBack = true, onSelect, onConfirm }) {
  const session = {
    id: randomBytes(6).toString('hex'),
    userId,
    results: results.slice(0, MAX_RESULTS),
    title,
    confirmLabel,
    allowBack,
    onSelect,
    onConfirm,
    page: 0,
    state: {},
    message: null,
    expiresAt: Date.now() + config.sessionTtlMs,
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    expireSession(session);
    return null;
  }
  return session;
}

/** Keeps the session alive while the user is actively using it. */
export function touchSession(session) {
  session.expiresAt = Date.now() + config.sessionTtlMs;
}

export function endSession(session) {
  sessions.delete(session.id);
}

function expireSession(session) {
  sessions.delete(session.id);
  renderNotice('⌛ This selection expired. Run the command again to start over.')
    .then((payload) => session.message?.edit(payload))
    .catch(() => {});
}

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (now > session.expiresAt) expireSession(session);
  }
}, 60_000).unref();

export function pageCount(session) {
  return Math.max(1, Math.ceil(session.results.length / PAGE_SIZE));
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Paginated results view: each item as a section with a poster thumbnail, then a select + nav buttons. */
export async function renderSelection(session, page = session.page) {
  const pages = pageCount(session);
  page = Math.min(Math.max(0, page), pages - 1);
  session.page = page;

  const start = page * PAGE_SIZE;
  const visible = session.results.slice(start, start + PAGE_SIZE);
  const posters = await loadPosters(visible.map((item) => item.imageUrl), 'w250');

  const container = new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${truncate(session.title, 200)}\n-# Page ${page + 1} / ${pages} · ${session.results.length} result${session.results.length === 1 ? '' : 's'}`),
    );

  for (const [offset, item] of visible.entries()) {
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
    const text = new TextDisplayBuilder().setContent(
      `### ${start + offset + 1}. ${truncate(item.name, 150)}` +
        (item.description ? `\n${truncate(item.description, 300)}` : ''),
    );
    const poster = posters.ref(item.imageUrl);
    if (poster) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(text)
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(poster).setDescription(truncate(item.name, 1000))),
      );
    } else {
      container.addTextDisplayComponents(text);
    }
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:${session.id}:select`)
    .setPlaceholder('Choose a result…')
    .addOptions(
      visible.map((item, offset) => {
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(truncate(`${start + offset + 1}. ${item.name}`, 100))
          .setValue(String(item.id));
        if (item.description) option.setDescription(truncate(item.description, 100));
        return option;
      }),
    );

  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:${session.id}:previous:${page - 1}`)
      .setLabel('Previous')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:${session.id}:page`)
      .setLabel(`Page ${page + 1} / ${pages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:${session.id}:next:${page + 1}`)
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

/** Detail view for one item: large poster, full info, Confirm + Back to results. */
export async function renderDetail(session, item) {
  const posters = await loadPosters([item.imageUrl], 'original');
  const poster = posters.ref(item.imageUrl);
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${truncate(item.name, 200)}`));

  if (poster) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(poster).setDescription(truncate(item.name, 1000)),
      ),
    );
  }

  const body = item.details || item.description;
  if (body) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(truncate(body, 3000)));
  }
  if (item.confirmDisabledReason) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${item.confirmDisabledReason}`));
  }

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:${session.id}:confirm:${item.id}`)
      .setLabel(session.confirmLabel)
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(Boolean(item.confirmDisabledReason)),
  );
  if (session.allowBack) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:${session.id}:back:${session.page}`)
        .setLabel('Back to results')
        .setEmoji('↩️')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  container
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(buttons);

  return withPosters({ flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } }, posters);
}

/** A single-container message with no interactive components (final/expired states). */
export async function renderNotice(content, imageUrl = null) {
  const posters = await loadPosters([imageUrl], 'w250');
  const poster = posters.ref(imageUrl);
  const container = new ContainerBuilder().setAccentColor(ACCENT);
  const text = new TextDisplayBuilder().setContent(truncate(content, 3500));
  if (poster) {
    container.addSectionComponents(
      new SectionBuilder().addTextDisplayComponents(text).setThumbnailAccessory(new ThumbnailBuilder().setURL(poster)),
    );
  } else {
    container.addTextDisplayComponents(text);
  }
  return withPosters({ flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } }, posters);
}

export function isSelectionInteraction(interaction) {
  return 'customId' in interaction && interaction.customId.startsWith(`${PREFIX}:`);
}

/** Handles select/pagination/detail/confirm interactions for any selection session. */
export async function handleSelectionInteraction(interaction) {
  const [, sessionId, action, arg] = interaction.customId.split(':');
  const session = getSession(sessionId);

  if (!session) {
    await interaction.reply({
      content: '⌛ This selection has expired. Run the command again to start over.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== session.userId) {
    await interaction.reply({
      content: `Only <@${session.userId}> can use this selection. Run the command yourself to start your own.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  touchSession(session);
  session.message ??= interaction.message;

  // Rendering downloads posters, so acknowledge first to stay inside Discord's 3s window.
  switch (action) {
    case 'previous':
    case 'next':
    case 'back':
      await interaction.deferUpdate();
      await interaction.editReply(await renderSelection(session, Number(arg)));
      return;

    case 'select': {
      await interaction.deferUpdate();
      const item = session.results.find((result) => String(result.id) === interaction.values[0]);
      if (!item) {
        await interaction.editReply(await renderSelection(session));
        return;
      }
      const posterWarmup = loadPosters([item.imageUrl], 'original');
      try {
        await session.onSelect?.(item, session);
      } catch (error) {
        console.error('Selection onSelect failed:', error);
        item.confirmDisabledReason = `⚠️ Could not load details: ${error.message}`;
      }
      await posterWarmup;
      await interaction.editReply(await renderDetail(session, item));
      return;
    }

    case 'confirm': {
      const item = session.results.find((result) => String(result.id) === arg);
      if (!item) {
        await interaction.deferUpdate();
        await interaction.editReply(await renderSelection(session));
        return;
      }
      await session.onConfirm(interaction, item, session);
      return;
    }

    default:
      await interaction.deferUpdate();
  }
}
