import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Per-guild discovery setup, persisted as JSON:
 * { [guildId]: { channelId, facets: ['MOVIE', ...], messages: { MOVIE: messageId, ... } } }
 */
const file = path.resolve(config.dataDir, 'discovery.json');

let guilds = {};
try {
  guilds = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') console.error(`Could not read ${file}, starting empty:`, error.message);
}

function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(guilds, null, 2));
  fs.renameSync(tmp, file);
}

export function getGuild(guildId) {
  return guilds[guildId] ?? null;
}

export function allGuilds() {
  return Object.entries(guilds).map(([guildId, setup]) => ({ guildId, ...setup }));
}

export function setGuild(guildId, setup) {
  guilds[guildId] = setup;
  save();
}

export function deleteGuild(guildId) {
  delete guilds[guildId];
  save();
}

export function setMessageId(guildId, facet, messageId) {
  const setup = guilds[guildId];
  if (!setup) return;
  setup.messages = { ...setup.messages, [facet]: messageId };
  save();
}
