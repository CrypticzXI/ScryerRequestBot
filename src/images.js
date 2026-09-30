import { AttachmentBuilder } from 'discord.js';
import sharp from 'sharp';
import { config } from './config.js';

/**
 * Posters from Scryer are usually relative proxy URLs (`/images/media/<token>/<variant>`)
 * on a server Discord can't reach, so the bot downloads them itself and uploads
 * them as message attachments, referenced from components as `attachment://<name>`.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_LIMIT = 300;
const cache = new Map(); // absolute url -> Promise<{ data: Buffer, ext: string } | null>

// Formats Discord displays reliably. Anything else (Scryer caches posters as AVIF) is converted to JPEG.
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_WIDTH = 1000;

async function toDiscordFormat(data) {
  return sharp(data)
    .rotate()
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

/** Absolute URL for a poster, picking a Scryer proxy size variant (`original`, `w250`, `w70`). */
export function resolveImageUrl(url, variant = 'original') {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url, `${config.scryerUrl}/`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  parsed.pathname = parsed.pathname.replace(/(\/images\/media\/[^/]+\/)[^/]+$/, `$1${variant}`);
  return parsed.toString();
}

function isScryerUrl(url) {
  try {
    return new URL(url).origin === new URL(config.scryerUrl).origin;
  } catch {
    return false;
  }
}

async function download(url) {
  try {
    const response = await fetch(url, {
      headers: isScryerUrl(url) ? { Authorization: `Bearer ${config.scryerApiToken}` } : {},
      signal: AbortSignal.timeout(6_000),
    });
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (!response.ok || !(type.startsWith('image/') || type === 'application/octet-stream')) {
      console.warn(`Poster ${url} skipped: HTTP ${response.status}, ${type || 'no content-type'}`);
      return null;
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > MAX_BYTES) return null;
    if (EXTENSIONS[type]) return { data, ext: EXTENSIONS[type] };
    return { data: await toDiscordFormat(data), ext: 'jpg' };
  } catch (error) {
    console.warn(`Poster ${url} failed: ${error.message}`);
    return null;
  }
}

function cached(url) {
  let entry = cache.get(url);
  if (entry) {
    // Refresh LRU position.
    cache.delete(url);
    cache.set(url, entry);
    return entry;
  }
  entry = download(url);
  // Don't remember failures, so a temporarily unreachable poster is retried next time.
  entry.then((result) => result || cache.delete(url));
  cache.set(url, entry);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return entry;
}

/**
 * Downloads posters in parallel. Returns a `PosterSet`:
 * `ref(url)` gives the `attachment://…` URL to use in a component (or null if the
 * poster is unavailable), and `files()` the attachments actually referenced.
 */
export async function loadPosters(urls, variant = 'original') {
  const unique = [...new Set(urls.filter(Boolean))];
  const loaded = await Promise.all(
    unique.map(async (url) => {
      const absolute = resolveImageUrl(url, variant);
      return [url, absolute ? await cached(absolute) : null];
    }),
  );

  const byUrl = new Map();
  loaded.forEach(([url, image], index) => {
    if (image) byUrl.set(url, { name: `poster-${index}.${image.ext}`, data: image.data });
  });

  const used = new Set();
  return {
    ref(url) {
      const image = byUrl.get(url);
      if (!image) return null;
      used.add(image);
      return `attachment://${image.name}`;
    },
    files() {
      return [...used].map((image) => new AttachmentBuilder(image.data, { name: image.name }));
    },
  };
}

/**
 * Finalizes a Components V2 payload with the posters it referenced.
 * `attachments: []` drops the previous page's posters when a message is edited.
 */
export function withPosters(payload, posters) {
  return { ...payload, files: posters.files(), attachments: [] };
}
