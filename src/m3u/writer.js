// Extended-M3U writer.
//
// M3U has **no escape syntax**, which makes writing harder than it looks.  An
// `#EXTINF` line is split at its *last* comma and attribute values are
// delimited by `"`, so three characters cannot be escaped and must instead be
// *removed*:
//
//   | In a display name | In an attribute value | Action |
//   | --- | --- | --- |
//   | `,` comma | `,` comma | safe in an attribute (it sits inside quotes), but **stripped from a display name** — otherwise `Show, The Movie` re-reads as `The Movie`, silently renaming the channel |
//   | `"` quote | `"` quote | replaced with `'` everywhere — a quote desyncs attribute parsing |
//   | CR/LF | CR/LF | replaced with a space everywhere — a newline forges a new entry |
//
// The comma-stripping rule is lossless on real data: 0 of the 651 reference
// entries carry a comma or quote in a display name.  Attribute values *do* need
// commas (`tvg-id="TV8,5 HD.tr"` appears twice in source B), so those survive.

import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Attributes the writer emits, in the order the reference playlists publish
// them.  Readers key on names, not position, but matching the sources keeps
// the output familiar to anything that diffs against them.
export const DEFAULT_KEEP_ATTRIBUTES = ['tvg-id', 'tvg-name', 'tvg-logo', 'group-title'];

const MAX_FIELD_LENGTH = 4096;

/** Attribute value: commas are SAFE here, quotes and newlines are not. */
function escapeAttributeValue(value) {
  return String(value == null ? '' : value)
    .replace(/"/g, "'")
    .replace(/[\r\n]+/g, ' ')
    .slice(0, MAX_FIELD_LENGTH);
}

/** Display name: additionally loses commas, which would re-read as the separator. */
function escapeDisplayName(value) {
  return String(value == null ? '' : value)
    .replace(/"/g, "'")
    .replace(/[\r\n]+/g, ' ')
    .replace(/,/g, '')
    .trim()
    .slice(0, MAX_FIELD_LENGTH);
}

/**
 * Validate a result strictly before emitting.
 *
 * The writer is the last defense — the same posture `generateXmltv()` takes
 * with `validateGuideResult()` — so a caller that bypasses the pipeline still
 * cannot write a malformed playlist.  On any violation this throws with a
 * precise message instead of producing a file that silently corrupts.
 */
export function validateM3uResult(result, options = {}) {
  // `allowSharedIdentity` is the `none` naming style: one id and one name per
  // CHANNEL, repeated across its alternate feeds.  That is exactly what a
  // name-keyed consumer requires (it keys failover off the id), so the duplicate
  // checks below are suspended rather than weakened — every other rule applies.
  const { allowSharedIdentity = false } = options;
  const entries = result && Array.isArray(result.entries) ? result.entries : null;
  if (!entries) throw new Error('generateM3U: result.entries must be an array');

  const names = new Set();
  const ids = new Set();
  const urls = new Set();

  entries.forEach((entry, index) => {
    const at = `entry #${index}`;
    const name = escapeDisplayName(entry && entry.name);
    if (!name) throw new Error(`generateM3U: ${at} has an empty display name`);

    const lowerName = name.toLowerCase();
    if (!allowSharedIdentity && names.has(lowerName)) {
      throw new Error(`generateM3U: duplicate display name "${name}"`);
    }
    names.add(lowerName);

    const id = escapeAttributeValue(entry.tvgId != null ? entry.tvgId : entry.id);
    if (id.toLowerCase() === 'ext') {
      throw new Error(`generateM3U: ${at} ("${name}") carries the "ext" placeholder as its id`);
    }
    if (id && !allowSharedIdentity) {
      const lowerId = id.toLowerCase();
      if (ids.has(lowerId)) throw new Error(`generateM3U: duplicate tvg-id "${id}"`);
      ids.add(lowerId);
    } else if (id) {
      ids.add(id.toLowerCase());
    }

    const url = String((entry && entry.url) || '').trim();
    if (!url) throw new Error(`generateM3U: ${at} ("${name}") has no stream URL`);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`generateM3U: ${at} ("${name}") has an unparseable URL "${url}"`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`generateM3U: ${at} ("${name}") has a non-http(s) URL "${url}"`);
    }
    if (urls.has(url)) throw new Error(`generateM3U: duplicate stream URL for "${name}"`);
    urls.add(url);
  });

  return entries;
}

/**
 * Render a playlist as an extended-M3U string.
 *
 * Output is UTF-8 without a BOM, LF line endings, one `#EXTM3U` header, and a
 * trailing newline.  `#EXTINF:-1` denotes a live stream, matching both
 * reference playlists.
 */
export function generateM3U(result, options = {}) {
  const { keepAttributes = DEFAULT_KEEP_ATTRIBUTES, allowSharedIdentity = false } = options;
  const entries = validateM3uResult(result, { allowSharedIdentity });

  const lines = ['#EXTM3U'];
  for (const entry of entries) {
    const name = escapeDisplayName(entry.name);
    const attributes = [];
    const push = (key, value) => {
      const text = escapeAttributeValue(value);
      if (text) attributes.push(`${key}="${text}"`);
    };

    // Only the standard attributes survive; `Yedek*`, `nexus-score` and other
    // provider-private attributes are dropped unless explicitly kept.
    for (const key of keepAttributes) {
      if (key === 'tvg-id') push('tvg-id', entry.tvgId != null ? entry.tvgId : entry.id);
      else if (key === 'tvg-name') push('tvg-name', entry.tvgName);
      else if (key === 'tvg-logo') push('tvg-logo', entry.logo != null ? entry.logo : entry.tvgLogo);
      else if (key === 'group-title') push('group-title', entry.groupTitle != null ? entry.groupTitle : entry.group);
      else push(key, entry.attributes && entry.attributes[key]);
    }

    const prefix = attributes.length ? `#EXTINF:-1 ${attributes.join(' ')},` : '#EXTINF:-1,';
    lines.push(prefix + name);
    for (const option of entry.vlcOptions || []) {
      const text = escapeAttributeValue(option);
      if (text) lines.push(`#EXTVLCOPT:${text}`);
    }
    lines.push(String(entry.url).trim());
  }
  return lines.join('\n') + '\n';
}

/**
 * Write a playlist to disk.  Mirrors `writeXmltv()`: gzip streams through
 * `node:zlib` level 9 via `pipeline()`.
 */
export async function writeM3U(result, options = {}) {
  const { outputPath, gzip = false, keepAttributes, allowSharedIdentity } = options;
  if (!outputPath) throw new Error('writeM3U: outputPath is required');
  const text = generateM3U(result, { keepAttributes, allowSharedIdentity });
  const fs = await import('node:fs');
  const out = fs.createWriteStream(outputPath);
  const source = Readable.from([text]);
  if (gzip) await pipeline(source, createGzip({ level: 9 }), out);
  else await pipeline(source, out);
  return { bytes: Buffer.byteLength(text), gzip: Boolean(gzip), outputPath };
}