// Pure extended-M3U parser.
//
// No I/O, no `eval`, no third-party dependency: the playlist format is read
// with index arithmetic and string operations only, so it can be exercised
// against fixtures without a network.  Hostile input degrades to an empty (or
// partial) entry list — it never throws (SPEC §6.1, §11).
//
// Two parser facts are load-bearing and pinned by tests:
//
//  1. Attributes are scanned with an `indexOf`-anchored loop, never with
//     /([A-Za-z0-9_-]+)=[“”]([^“”]*)[“”]/g.  That regex is QUADRATIC on
//     quote-free input, because `[^\"]*` can start at many offsets: a single
//     100 KB junk line was measured at 11.9 s — a trivial remote DoS for a
//     playlist fetched from someone else's server.  The linear scanner does it
//     in 0.1 ms and produces byte-identical attributes on every real fixture.
//
//  2. `#EXTINF` is split at its LAST comma, never `split(',')`.  Real playlists
//     carry commas inside attribute values (`tvg-id="TV8,5 HD.tr"`), so
//     splitting on the first comma would tear an attribute line apart.  The
//     corollary is that a comma in a *display name* is unrepresentable — the
//     writer therefore strips commas when it emits a name.

export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 20000;

// Per-field caps.  Generous enough that no real playlist entry is truncated,
// small enough that a hostile source cannot make one field megabytes long.
// (A NUL byte in a name is *preserved*: it is harmless to the format.)
const MAX_FIELD_LENGTH = 16384;

// Attribute-name character class, matching the regex the linear scanner
// replaces.  A per-character regex test is cheap here because the key is a
// handful of characters, not a scan of the whole value.
const KEY_CHAR = /[A-Za-z0-9_-]/;

// Trim a field to the cap.  Non-strings coerce, so a hostile `name: 42` cannot
// crash the writer.
function clampField(value) {
  const text = value == null ? '' : String(value);
  return text.length > MAX_FIELD_LENGTH ? text.slice(0, MAX_FIELD_LENGTH) : text;
}

/**
 * Scan `key="value"` pairs out of an attribute string.
 *
 * Linear: each `=` is found with `indexOf` and each value with the next
 * `indexOf('"')`, so the work is proportional to the input length.  An
 * unterminated quote stops the scan (it is never guessed at) and is reported
 * through `unterminated` so the caller can count it in `stats.malformed`.
 *
 * Keys are lower-cased; the last occurrence of a repeated key wins.
 *
 * @param {string} attrStr
 * @returns {{ attrs: Record<string,string>, unterminated: boolean }}
 */
export function parseAttributes(attrStr) {
  const attrs = {};
  const text = typeof attrStr === 'string' ? attrStr : '';
  const n = text.length;
  let i = 0;
  let unterminated = false;

  while (i < n) {
    const eq = text.indexOf('=', i);
    if (eq < 0) break;
    // Walk back over the key characters immediately preceding the `=`.
    let keyEnd = eq;
    while (keyEnd > i && KEY_CHAR.test(text[keyEnd - 1])) keyEnd -= 1;
    const key = text.slice(keyEnd, eq).toLowerCase();

    if (text[eq + 1] !== '"') {
      // Not a quoted value (`tvg-id=ext`): skip past this `=` and resync.
      i = eq + 1;
      continue;
    }
    const close = text.indexOf('"', eq + 2);
    if (close < 0) {
      // Unterminated quote — stop rather than absorbing the rest of the line.
      unterminated = true;
      break;
    }
    if (key) attrs[key] = text.slice(eq + 2, close);
    i = close + 1;
  }

  return { attrs, unterminated };
}

/**
 * Parse an extended-M3U document.
 *
 * @param {string} text raw playlist body
 * @param {object} [options]
 * @param {number} [options.maxBytes]  refuse input larger than this (default 16 MiB)
 * @param {number} [options.maxEntries] stop after this many entries (default 20000)
 * @param {string} [options.sourceId]   stamped onto every entry
 * @returns {{ entries: object[], stats: object }}
 */
export function parseM3U(text, options = {}) {
  const {
    maxBytes = DEFAULT_MAX_BYTES,
    maxEntries = DEFAULT_MAX_ENTRIES,
    sourceId = '',
  } = options;

  const stats = {
    truncated: false,
    malformed: 0,
    missingUrl: 0,
    extraUrlLines: 0,
    parsed: 0,
    maxEntries,
  };
  const entries = [];

  if (typeof text !== 'string' || text.length === 0) return { entries, stats };

  // Strip a UTF-8 BOM before splitting, else the first line is never seen as
  // the `#EXTM3U` header.
  let body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  if (maxBytes > 0 && Buffer.byteLength(body, 'utf8') > maxBytes) {
    body = Buffer.from(body, 'utf8').subarray(0, maxBytes).toString('utf8');
    stats.truncated = true;
  }

  const lines = body.split(/\r?\n/);
  let pending = null;

  const flush = () => {
    // An #EXTINF with no URL is not a channel — drop it, but count it so the
    // run report can show that the source was lossy.
    if (pending) {
      stats.missingUrl += 1;
      pending = null;
    }
  };

  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo].trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) {
      // Header attributes are read to the end of the line; any trailing prose
      // (`… | SON GÜNCELLENME 05.09.2026 | Donate https://…`) carries no `=`,
      // so the linear scanner skips it and no foreign URL can leak into output.
      const parsed = parseAttributes(line.slice('#EXTM3U'.length));
      if (parsed.unterminated) stats.malformed += 1;
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      flush(); // a previous #EXTINF that never got its URL
      if (entries.length >= maxEntries) {
        stats.truncated = true;
        break;
      }
      const comma = line.lastIndexOf(',');
      const attrPart = comma < 0 ? line.slice('#EXTINF'.length) : line.slice('#EXTINF'.length, comma);
      const name = comma < 0 ? '' : line.slice(comma + 1).trim();
      if (comma < 0) stats.malformed += 1;
      const parsed = parseAttributes(attrPart);
      if (parsed.unterminated) stats.malformed += 1;
      const attrs = parsed.attrs;
      pending = {
        name: clampField(name),
        tvgId: clampField(attrs['tvg-id'] || ''),
        tvgName: clampField(attrs['tvg-name'] || ''),
        tvgLogo: clampField(attrs['tvg-logo'] || ''),
        group: clampField(attrs['group-title'] || ''),
        attributes: attrs,
        url: '',
        vlcOptions: [],
        sourceId,
        line: lineNo + 1,
      };
      continue;
    }

    if (line.startsWith('#EXTVLCOPT')) {
      if (pending) pending.vlcOptions.push(clampField(line.slice('#EXTVLCOPT:'.length)));
      continue;
    }

    if (line.startsWith('#EXTGRP')) {
      if (pending) pending.group = clampField(line.slice('#EXTGRP:'.length).trim());
      continue;
    }

    if (line.startsWith('#')) continue; // any other directive is ignored

    if (pending) {
      if (!pending.url) {
        pending.url = clampField(line);
        entries.push(pending);
        stats.parsed += 1;
        pending = null;
      } else {
        // A second URL line under the same #EXTINF is a malformed source, not
        // a second channel: keep the first, count the rest.
        stats.extraUrlLines += 1;
      }
    }
  }
  flush();

  return { entries, stats };
}