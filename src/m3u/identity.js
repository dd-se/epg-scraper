// Channel identity for playlist entries.
//
// "Is this the same channel as that one?" has no single answer field: measured
// over the two reference sources, `tvg-id` is missing on 315/453 entries and is
// the placeholder `ext` on 21 more, `tvg-name` is missing on 337/453, and 162 of
// source A's display names are decorated with a resolution (`ATV (360p)`).
// Every key source fails somewhere, so identity is the **union** of several
// normalized keys, and two entries are the same channel when their key sets
// intersect (union-find keeps that transitive and order-independent).
//
// The invariant that must never break: **editions are separate channels**
// (SPEC §6.5.1, E1). `ATV Alanya`, `ATV Avrupa`, `ALANYA ATV`, `Kanal D Drama`
// and `TRT 4K` never join `ATV` / `Kanal D` / `TRT 1`. Two mechanisms enforce
// it: edition words are never quality tokens, and selection uses anchored
// globs so a request cannot widen into an edition by substring.

import { channelIdFromName } from '../slug.js';

// Format descriptors of the *same* channel, not separate channels.  `4K` is
// deliberately excluded: `TRT 4K` is a distinct simulcast with its own
// `tvg-id` and host, so folding it would be wrong in principle.
export const DEFAULT_QUALITY_TOKENS = ['HD', 'FHD', 'UHD', 'SD'];

// Country/quality suffix stripped from a `tvg-id` before it becomes a key.
const TVG_ID_SUFFIX = /\s*\b(?:TR|SE)\b\s*$/;
const TVG_ID_QUALITY = /\s*\b(?:HD|4K|FHD|UHD|SD)\b\s*$/;

// A trailing `(360p)` / `(1080p)`-style resolution.  Applied to the RAW string
// before normalization: normalizing first would fold the parentheses into
// spaces and the pattern could never match, leaving `ATV (360p)` keyed as
// `ATV 360P` — which silently breaks `--m3u-want "ATV"`.
const RESOLUTION_PARENS = /\(\s*\d{3,4}\s*p\s*\)/gi;

// Turkish diacritics must fold to their ASCII base letters, not vanish.
// `Ç`/`Ğ`/`İ`/`Ö`/`Ş`/`Ü` are not in `A-Z`, so a naive `[^A-Z0-9]` replace
// turns `Kanal Çocuk` into `KANAL COCUK` -> `KANAL  OCUK` -> `KANAL OCUK`:
// the letter disappears and `Kanal Çocuk` keys identically to `Kanal C`.
// These are the letters Turkish channel names actually use.
const DIACRITIC_FOLD = {
  Ç: 'C', Ğ: 'G', İ: 'I', I: 'I', Ö: 'O', Ş: 'S', Ü: 'U',
  ç: 'C', ğ: 'G', ı: 'I', ö: 'O', ş: 'S', ü: 'U',
  â: 'A', Â: 'A', î: 'I', Î: 'I', û: 'U', Û: 'U',
};

/**
 * Canonical comparison form: NFKC-folded, uppercased, Turkish diacritics
 * mapped to ASCII, every non-alphanumeric run collapsed to a single space,
 * trimmed.  Turkish case folding matters — `Çocuk`/`çocuk` and `Kanal Çocuk`
 * vs `KANAL COCUK` must land on the same key across sources.
 */
export function normalizeName(value) {
  const folded = String(value == null ? '' : value)
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[ÇĞİÖŞÜÂÎÛçğıöşüâîû]/g, (ch) => DIACRITIC_FOLD[ch] || ch);
  return folded
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Display name with a trailing `(NNNp)` resolution removed, then normalized. */
export function stripResolution(value) {
  return normalizeName(String(value == null ? '' : value).replace(RESOLUTION_PARENS, ' '));
}

/**
 * Remove quality tokens from an already-normalized name.
 *
 * Only whole tokens are removed, so `HD` folds `KANAL D HD` -> `KANAL D` while
 * a channel that merely *contains* a token is untouched.  A token list that
 * happens to contain regex metacharacters is escaped before use.
 */
export function stripQualityTokens(value, tokens) {
  let text = normalizeName(value);
  for (const rawToken of tokens || []) {
    const token = String(rawToken || '').trim();
    if (!token) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'gi'), ' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * `tvg-id` as a comparison key.
 *
 * The literal sentinel `ext` (21 occurrences in source B) and empty values are
 * discarded: a placeholder is not a channel identity.  The trailing country and
 * quality suffixes are removed so `KanalD.tr` and `KANAL D HD` can meet.
 */
export function idKey(entry) {
  const raw = String((entry && entry.tvgId) || '').trim();
  if (!raw || raw.toLowerCase() === 'ext') return '';
  return normalizeName(raw).replace(TVG_ID_SUFFIX, '').replace(TVG_ID_QUALITY, '').trim();
}

/**
 * The ordered key set identifying an entry's channel.  Any overlap ⇒ the same
 * channel.  Key 4 (quality-stripped) is the one that folds `ATV FHD` into
 * `ATV`; it is disabled by passing an empty token list.
 */
export function channelKeys(entry, options = {}) {
  const { stripQuality = DEFAULT_QUALITY_TOKENS } = options;
  const keys = [];
  const add = (key) => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  add(idKey(entry));
  add(normalizeName(entry && entry.tvgName));
  add(stripResolution(entry && entry.name));
  if (stripQuality && stripQuality.length) {
    // From the raw name: normalization first would hide a `HD` written as
    // part of a decorated name.
    add(stripQualityTokens(stripResolution(entry && entry.name), stripQuality));
  }
  return keys;
}

/**
 * The channel's display name, cleaned — never copied verbatim.
 *
 * Source A decorates 162 of 198 names with a resolution, so ranking by source
 * order and copying the winner verbatim would emit a channel literally called
 * `24 TV (720p)`.  Order: `tvg-name` (what the source publishes alongside the
 * decorated name) → paren-stripped display name → raw display name.
 *
 * Quality tokens are deliberately *not* removed here (they are only an identity
 * concern), so a channel whose only name is `ATV FHD` is still emitted as
 * `ATV FHD` rather than being silently downgraded to `ATV`.
 */
export function baseDisplayName(entry) {
  const tvgName = String((entry && entry.tvgName) || '').trim();
  if (tvgName) return tvgName;
  const name = String((entry && entry.name) || '').trim();
  const stripped = stripResolutionPreserveCase(name);
  return stripped || name;
}

function stripResolutionPreserveCase(value) {
  return String(value == null ? '' : value).replace(RESOLUTION_PARENS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Group entries into channels: union-find over the union of their key sets.
 *
 * Transitive by construction (`ATV` ↔ `ATV FHD` ↔ `ATV (360p)`) and
 * order-independent: the caller's entry order only decides the order *within*
 * a group, never the grouping itself.
 *
 * @param {object[]} entries
 * @param {object} [options] forwarded to `channelKeys`
 * @returns {{ id: string, keys: string[], entries: object[] }[]}
 */
export function groupEntries(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const parent = new Map();
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    // Path compression keeps repeated lookups O(1) amortized.
    let cursor = x;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const entry of list) parent.set(entry, entry);
  for (const entry of list) {
    for (const key of channelKeys(entry, options)) {
      const node = `k:${key}`;
      if (!parent.has(node)) parent.set(node, node);
      union(entry, node);
    }
  }

  const groups = new Map();
  for (const entry of list) {
    const root = find(entry);
    if (!groups.has(root)) groups.set(root, { entries: [], keys: new Set() });
    const group = groups.get(root);
    group.entries.push(entry);
    for (const key of channelKeys(entry, options)) group.keys.add(key);
  }

  return [...groups.values()].map((group) => ({
    id: [...group.keys].sort()[0] || '',
    keys: [...group.keys].sort(),
    entries: group.entries,
  }));
}

/**
 * Canonical form of a stream URL, used to decide whether two entries point at
 * the *same feed*.
 *
 * The measured data makes two normalizations mandatory rather than cosmetic:
 *
 *  * **Scheme unification.** `ATV (360p)` and `ATV FHD` point at the same path
 *    on the same host, one over `http://` and one over `https://`.  Without
 *    unification they read as two channels and invent a phantom `ATV B3`.
 *  * **Query ignored.** `…/kanald.m3u8?app=kanald_web&ce=3` and
 *    `…/kanald.m3u8?app=kanald_web` are one feed, not two — a cache-buster is
 *    not a backup.  This accounts for 6 host+path URLs carrying 19 query
 *    variants.  Hosts where the query really does select the channel (e.g.
 *    `tvsms.club/tv.php?...&kanal=damar` vs `&kanal=vivatv`) are in *different*
 *    identity groups, so host+path equality never merges them.
 *
 * `--m3u-keep-scheme` / `--m3u-keep-query` opt out of either.
 *
 * @returns {string} canonical key, or the trimmed input when it cannot parse
 */
export function normalizeStreamUrl(url, options = {}) {
  const { unifyScheme = true, keepQuery = false } = options;
  const text = String(url == null ? '' : url).trim();
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return text;
  }
  const scheme = unifyScheme ? 'http' : parsed.protocol.replace(/:$/, '').toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port && parsed.port !== '80' && parsed.port !== '443' ? `:${parsed.port}` : '';
  const path = parsed.pathname
    .replace(/\.m3u8?$/i, '')
    .replace(/\/+$/, '');
  const query = keepQuery
    ? [...parsed.searchParams.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('&')
    : '';
  return `${scheme}://${host}${port}${path}${query ? `?${query}` : ''}`;
}

/**
 * Rank the surviving copies of a group.
 *
 * Fully deterministic and independent of fetch completion order: source weight
 * (higher wins), then config order, then playlist position.
 */
export function rankEntries(entries) {
  return [...entries].sort((a, b) => {
    const wa = Number((a && a.weight) || 0);
    const wb = Number((b && b.weight) || 0);
    if (wa !== wb) return wb - wa;
    const sa = Number((a && a.sourceOrder) || 0);
    const sb = Number((b && b.sourceOrder) || 0);
    if (sa !== sb) return sa - sb;
    return (a && a.line ? a.line : 0) - (b && b.line ? b.line : 0);
  });
}

/**
 * Collapse entries that point at the *same feed* inside each group.
 *
 * A duplicate feed is never renamed — it is the same stream published twice, and
 * treating it as a backup would invent a phantom `ATV B3`.  Entries in
 * *different* groups are never merged, so a query string that really selects
 * the channel stays safe.
 *
 * The caller's entries are not mutated.
 *
 * @returns {{ groups: object[], collapsedDuplicates: number }}
 */
export function collapseIdenticalFeeds(groups, options = {}) {
  const { unifyScheme = true, keepQuery = false, dedupeIdenticalUrls = true } = options;
  let collapsedDuplicates = 0;
  const out = [];

  for (const group of Array.isArray(groups) ? groups : []) {
    if (!dedupeIdenticalUrls) {
      out.push(group);
      continue;
    }
    const byFeed = new Map();
    for (const entry of group.entries) {
      const feed = normalizeStreamUrl(entry.url, { unifyScheme, keepQuery });
      if (!byFeed.has(feed)) byFeed.set(feed, entry);
      else collapsedDuplicates += 1;
    }
    const entries = rankEntries([...byFeed.values()]);
    out.push({ ...group, entries });
  }
  return { groups: out, collapsedDuplicates };
}

export const NAMING_STYLES = ['numbered', 'parenthesized', 'none', 'backup', 'source', 'keep-first', 'fail'];

/**
 * The `tvg-id` a consumer must accept, and the shape a catalog-declared id has
 * to satisfy.  A strict Tizen 5 parser refuses anything else and drops the whole
 * entry, so an id that fails here is not merely ugly — it is a lost channel.
 *
 * Lowercase ASCII, no spaces, first character alphanumeric.  The 128 cap is the
 * parser's own limit, not an arbitrary one.
 */
export const TIZEN_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

/**
 * Reduce any name to a `tvg-id` the strict parser accepts: lowercase, Turkish
 * diacritics transliterated to ASCII, every other run collapsed to a dot.
 * `24 TV HD` -> `24-tv-hd`, `CNN TÜRK` -> `cnn-turk`.
 */
export function toPortableId(value) {
  const ascii = String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')       // drop the combining marks NFKD split off
    .replace(/İ/g, 'I').replace(/I/g, 'I').replace(/ı/g, 'i')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
    .replace(/ş/g, 's').replace(/Ş/g, 'S')
    .replace(/ç/g, 'c').replace(/Ç/g, 'C')
    .replace(/ö/g, 'o').replace(/Ö/g, 'O')
    .replace(/ü/g, 'u').replace(/Ü/g, 'U')
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '.')
    .replace(/^[._:-]+/, '')
    .replace(/[._:-]+$/, '')
    .replace(/\.{2,}/g, '.');
  return ascii.slice(0, 128);
}

/**
 * Assign display names and ids to the copies of each channel.
 *
 * Naming styles (the examples use the measured `ATV` group, which has 2
 * distinct feeds after collapse):
 *
 * | Style | 2 copies | 3 copies |
 * | --- | --- | --- |
 * | `numbered` | `ATV`, `ATV B2` | `ATV`, `ATV B2`, `ATV B3` |
 * | `parenthesized` | `ATV`, `ATV (1)` | `ATV`, `ATV (1)`, `ATV (2)` |
 * | `none` | `ATV`, `ATV` | `ATV`, `ATV`, `ATV` |
 * | `backup`   | `ATV`, `ATV Backup` | `ATV`, `ATV Backup`, `ATV Backup 2` |
 * | `source`   | `ATV`, `ATV (hayati-tr)` | …one per source id |
 * | `keep-first` | `ATV` only, rest dropped+reported | same |
 * | `fail`     | run reports the conflict and exits 1 | same |
 *
 * `none` exists for consumers that key on the display name: a Tizen engine
 * matches a channel to its XMLTV guide by name, so a `B2`/`(1)` marker in the
 * name strands the copy with no programme data.  Rule 1 of that contract
 * (one `tvg-id` per channel, shared by all its feeds) is the counterpart — the
 * id is what encodes "these are alternative feeds", so the name does not need
 * to.  `numbered` cannot express that, which is why `none` is separate.
 *
 * `source` shows the id of the *kept* copy, which is why a channel can be
 * renamed after a source it did not come from; full provenance stays in the run
 * report.  A generated name that collides with another channel's name or id
 * takes the next free ordinal, so uniqueness is guaranteed and deterministic.
 *
 * @returns {{ channels: object[], droppedCopies: number, conflicts: string[] }}
 */
export function applyNamingStyle(groups, style = 'numbered', options = {}) {
  const { idSuffix = 'tr' } = options;
  if (!NAMING_STYLES.includes(style)) {
    throw new Error(`unknown naming style "${style}" (expected one of ${NAMING_STYLES.join(', ')})`);
  }

  const usedNames = new Set();
  const usedIds = new Set();
  const channels = [];
  let droppedCopies = 0;
  const conflicts = [];

  // Stable base order: by normalized channel id, so the output does not depend
  // on which source happened to be fetched first.
  const ordered = [...(Array.isArray(groups) ? groups : [])].sort((a, b) => {
    const ka = a.keys && a.keys.length ? a.keys[0] : '';
    const kb = b.keys && b.keys.length ? b.keys[0] : '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const uniqueName = (candidate) => {
    let name = candidate;
    let n = 1;
    while (usedNames.has(name.toLowerCase())) {
      n += 1;
      name = `${candidate} ${n}`;
    }
    usedNames.add(name.toLowerCase());
    return name;
  };

  const uniqueId = (candidate) => {
    let id = candidate;
    let n = 1;
    while (usedIds.has(id.toLowerCase())) {
      n += 1;
      id = candidate.replace(/(\.[a-z]{2})$/i, `.${n}$1`);
    }
    usedIds.add(id.toLowerCase());
    return id;
  };

  for (const group of ordered) {
    const ranked = rankEntries(group.entries);
    if (ranked.length === 0) continue;
    const base = baseDisplayName(ranked[0]);

    if (ranked.length > 1 && style === 'fail') {
      conflicts.push(`${base} (${ranked.length} feeds)`);
      continue;
    }

    let copies = ranked;
    if (style === 'keep-first') {
      droppedCopies += ranked.length - 1;
      copies = ranked.slice(0, 1);
    }

    // One id for the whole channel, allocated up front so every copy can share
    // it.  `uniqueId` is still consulted, so a second channel that slugifies to
    // the same string takes the next free ordinal instead of colliding.
    //
    // A catalog-declared `tvgId` (stamped by applyIdentityOverrides) wins: it
    // is the permanent identity, and re-deriving it from the display name would
    // silently change a value consumers have already stored.
    //
    // It is read from the first copy that CARRIES one, not from `ranked[0]`:
    // ranking decides which feed is preferred, and the preferred feed is not
    // necessarily the one the catalog matched (its source may have published no
    // `tvg-id` at all).  A source id like `24 HD.tr` would otherwise win over
    // the declared `24tv.tr`.
    const declaredId = ranked
      .map((e) => String((e && e.tvgId) || '').trim())
      .find(Boolean) || '';
    const sharedId = style === 'none'
      ? uniqueId(declaredId || channelIdFromName(base, idSuffix))
      : null;

    copies.forEach((entry, index) => {
      let name;
      if (style === 'keep-first' || style === 'none' || index === 0) {
        name = base;
      } else if (style === 'backup') {
        name = index === 1 ? `${base} Backup` : `${base} Backup ${index}`;
      } else if (style === 'parenthesized') {
        name = `${base} (${index})`;
      } else if (style === 'source') {
        name = `${base} (${entry.sourceId || 'unknown'})`;
      } else {
        name = `${base} B${index + 1}`;
      }

      // `none` gives every copy the SAME name *and* the SAME id: the id is what
      // tells a consumer the entries are alternative feeds of one channel, so
      // the name needs no marker.  Every other style renames the copy, and so
      // must give it its own id to stay unique.
      if (style === 'none') {
        channels.push({
          ...entry,
          name: base,
          id: sharedId,
          // The writer prefers `tvgId` over `id`, so the shared id has to be
          // stamped on both or the copy keeps the source's own id.
          tvgId: sharedId,
          // Rule 3 of the name-keyed contract: every feed of a channel carries the
          // SAME `tvg-name` as the display text.  The sources spell a channel's
          // copies inconsistently (`A Spor` vs `A SPOR`) and often omit
          // `tvg-name` altogether, so it is stamped from the channel's base name
          // instead of being copied per feed.
          tvgName: base,
          baseName: base,
          copyIndex: index,
          identityKeys: group.keys || [],
        });
        return;
      }

      const finalName = uniqueName(name);
      // A declared id is permanent, so the FIRST copy keeps it verbatim. Later
      // copies are distinct channels in the eyes of every other style, so they
      // take a derived (uniquified) id instead — which keeps `24tv.tr` and
      // `24tv.2.tr` in one readable family rather than orphaning the copies
      // under an unrelated name-derived slug.
      const copyId = index === 0 && declaredId
        ? declaredId
        : uniqueId(channelIdFromName(finalName, idSuffix));
      channels.push({
        ...entry,
        name: finalName,
        id: copyId,
        baseName: base,
        copyIndex: index,
        // `identityKeys`, NOT `group`: `entry.group` is the playlist's own
        // `group-title` attribute and must survive to the writer.
        identityKeys: group.keys || [],
      });
    });
  }

  return { channels, droppedCopies, conflicts };
}

// A declared backup URL attribute: `Yedek`, `Yedek1`…`Yedek11`, and the
// lower-case `yedek9` that source B really ships.  Matched case-insensitively,
// and anchored so a hypothetical `YedekBackup` attribute is not mistaken for one.
// A placeholder carries no category information: the sources spell "we don't
// know" as `Undefined`, or leave the attribute off entirely.
function isPlaceholderGroupLabel(label) {
  const trimmed = String(label == null ? '' : label).trim().toLowerCase();
  return trimmed === '' || trimmed === 'undefined';
}

/**
 * Unify the `group-title` a channel's copies carry.
 *
 * The sources categorize the same channel differently — one files `Beyaz TV`
 * under `Undefined`, the other under `ULUSAL` — so without this a player shows
 * one channel in two folders.  Every copy adopts one label, so a channel lands
 * in exactly one group:
 *
 *  - A **placeholder** (`Undefined`, or an empty `group-title`) loses to any
 *    real label, however few copies publish that real one: `Undefined` means
 *    "uncategorized", so one source knowing the category beats another source
 *    not knowing it.
 *  - Among real labels, the one carried by the **most copies** wins (three
 *    `ULUSAL` copies beat a single `News`).
 *  - A tie keeps the base (highest-ranked) copy's label, so the result stays
 *    deterministic.
 *  - Only when *every* copy is a placeholder does one of them have to win.
 *
 * @param {object[]} groups
 * @returns {object[]} the same groups with each entry's `group` unified
 */
export function unifyGroupTitles(groups) {
  return (Array.isArray(groups) ? groups : []).map((group) => {
    const entries = Array.isArray(group && group.entries) ? group.entries : [];
    if (entries.length === 0) return group;

    const counts = new Map();
    for (const item of entries) {
      const label = String((item && item.group) || '');
      counts.set(label, (counts.get(label) || 0) + 1);
    }

    const real = [...counts.entries()].filter(([label]) => !isPlaceholderGroupLabel(label));
    const candidates = real.length > 0 ? real : [...counts.entries()];

    const baseLabel = String((rankEntries(entries)[0] || {}).group || '');
    const baseIsCandidate = candidates.some(([label]) => label === baseLabel);
    let winner = baseIsCandidate ? baseLabel : '';
    let best = baseIsCandidate ? counts.get(baseLabel) || 0 : 0;
    for (const [label, count] of candidates) {
      if (count > best) {
        best = count;
        winner = label;
      }
    }

    if (entries.every((item) => String((item && item.group) || '') === winner)) return group;
    return {
      ...group,
      entries: entries.map((item) => ({ ...item, group: winner })),
    };
  });
}

const YEDEK_ATTRIBUTE = /^yedek\d*$/i;

/**
 * Expand declared backup URLs into real channel copies.
 *
 * Source B stores its alternates as `Yedek="…"`, `Yedek2="…"` … on the
 * `#EXTINF` line — 46 entries carrying 171 URLs.  Expanding them (the default)
 * turns declared alternates into entries that flow through identical-feed
 * collapse and the naming styles exactly like any other copy, so a channel is
 * never emitted twice under one name.  Empty values and URLs identical to the
 * primary are skipped.
 *
 * Off by default in no release: `enabled` defaults to true because these are
 * genuine alternates the operator asked to see; `--m3u-no-yedek` opts out.
 *
 * The caller's entries are not mutated.
 *
 * @returns {{ entries: object[], yedekFound: number }}
 */
export function expandYedek(entries, options = {}) {
  const { enabled = true } = options;
  const list = Array.isArray(entries) ? entries : [];
  if (!enabled) return { entries: list, yedekFound: 0 };

  const out = [];
  let yedekFound = 0;

  for (const entry of list) {
    out.push(entry);
    const attributes = (entry && entry.attributes) || {};
    // Object key order follows the source's attribute order, which is the
    // declared backup order (`Yedek`, `Yedek2`, … `Yedek11`).
    const backupKeys = Object.keys(attributes)
      .filter((key) => YEDEK_ATTRIBUTE.test(key))
      .sort((a, b) => {
        const na = Number(a.replace(/\D/g, '')) || 0;
        const nb = Number(b.replace(/\D/g, '')) || 0;
        return na - nb;
      });

    const seen = new Set([String(entry.url || '').trim()]);
    for (const key of backupKeys) {
      const url = String(attributes[key] || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      yedekFound += 1;
      out.push({
        ...entry,
        url,
        // A backup copy keeps the channel's identity but has no private
        // attributes of its own (its `Yedek*` URLs were consumed here).
        attributes: {},
        vlcOptions: [],
        isBackup: true,
        backupOf: key,
      });
    }
  }
  return { entries: out, yedekFound };
}

/**
 * Trim the long copy tail that backup expansion can create.
 *
 * `A Spor` reaches 13 copies and `TRT 1` / `TV8` reach 11 with expansion on —
 * noise rather than useful redundancy.  Dropped copies are counted and their
 * URLs reported, never silently discarded.  `maxCopies: 0` means unlimited.
 *
 * @returns {{ groups: object[], maxCopiesDropped: number }}
 */
export function applyMaxCopies(groups, options = {}) {
  const { maxCopies = 6 } = options;
  let maxCopiesDropped = 0;
  if (!Number.isInteger(maxCopies) || maxCopies <= 0) {
    return { groups: Array.isArray(groups) ? groups : [], maxCopiesDropped };
  }
  const out = (Array.isArray(groups) ? groups : []).map((group) => {
    if (!group || !Array.isArray(group.entries) || group.entries.length <= maxCopies) return group;
    maxCopiesDropped += group.entries.length - maxCopies;
    return { ...group, entries: group.entries.slice(0, maxCopies) };
  });
  return { groups: out, maxCopiesDropped };
}