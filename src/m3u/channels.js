// The data-driven channel catalog for the M3U mode.
//
// The EPG side keeps its channel identity in authored data (`CHANNEL_ID_MAP` in
// each provider adapter); the playlist builder does the same here so the
// operator's channel selection lives in a **file** rather than in shell
// history.  `--m3u-want` still appends ad-hoc patterns for a one-off run, but
// the curated selection is this catalog.
//
// A channel is requested by its *glob*, matched against the same four
// normalized selection forms the matcher uses.  Patterns are anchored, so a
// bare `ATV` never drags in an `ATV Alanya`-style edition; an edition has to be
// listed explicitly below, which is the point of keeping the list authored.
//
// The `group` is the **declared** category for that channel, written in the
// playlist's own language (Turkish).  The sources disagree — one files
// `Beyaz TV` under `Undefined`, the other under `ULUSAL` — so rather than
// inferring the answer from how many copies happen to carry each label, you
// state it here.  A declared group replaces whatever the playlist published
// and wins over the unify-by-count pass, which makes this file the single
// source of truth for "which folder is this channel in".  Drop the `group`
// field and that channel falls back to the sources' own label.

export const CHANNEL_CATALOG = [
  // Ulusal genel yayın
  { pattern: 'ATV', group: 'ULUSAL', note: 'national general-interest' },
  { pattern: 'TRT 1', group: 'ULUSAL', note: 'national general-interest' },
  { pattern: 'Kanal D', group: 'ULUSAL', note: 'national general-interest' },
  { pattern: 'Star TV', group: 'ULUSAL', note: 'national general-interest' },
  { pattern: 'Show TV', group: 'ULUSAL', note: 'national general-interest' },
  { pattern: 'FOX', group: 'ULUSAL', note: 'national general-interest' },
  { pattern: 'NOW TV', group: 'DİZİ', note: 'national entertainment' },
  { pattern: 'Show Turk', group: 'ULUSAL', note: 'national general-interest' },
  { pattern: 'Show Max', group: 'DİZİ', note: 'national entertainment' },
  { pattern: '24 TV', group: 'HABER', note: 'news' },

  // Haber
  { pattern: 'CNN Turk', group: 'HABER', note: 'news' },
  { pattern: 'NTV', group: 'HABER', note: 'news' },
  { pattern: 'A Haber', group: 'HABER', note: 'news' },
  { pattern: 'TRT Haber', group: 'HABER', note: 'news' },
  { pattern: 'TV8 Haber', group: 'HABER', note: 'news' },
  { pattern: 'Bloomberg HT', group: 'HABER', note: 'news' },

  // Spor
  { pattern: 'TRT Spor', group: 'SPOR', note: 'sports' },
  { pattern: 'A Spor', group: 'SPOR', note: 'sports' },
  { pattern: 'beIN Sports 1', group: 'SPOR', note: 'sports' },
  { pattern: 'beIN Sports 2', group: 'SPOR', note: 'sports' },
  { pattern: 'beIN Sports 3', group: 'SPOR', note: 'sports' },
  { pattern: 'beIN Sports 4', group: 'SPOR', note: 'sports' },
  { pattern: 'tabii spor 1', group: 'SPOR', note: 'sports' },
  { pattern: 'S Sport 1', group: 'SPOR', note: 'sports' },
  { pattern: 'Eurosport 1', group: 'SPOR', note: 'sports' },

  // Eğlence / çocuk
  { pattern: 'TRT 4K', group: 'ULUSAL', note: '4K simulcast (E1: separate from TRT 1)' },
  { pattern: 'TRT Çocuk', group: 'ÇOCUK', note: 'children' },
  { pattern: 'Minik Go', group: 'ÇOCUK', note: 'children' },
  { pattern: 'Baby TV', group: 'ÇOCUK', note: 'children' },
  { pattern: 'Cartoon Network', group: 'ÇOCUK', note: 'children' },
  { pattern: 'Nickelodeon', group: 'ÇOCUK', note: 'children' },
  { pattern: 'Disney Channel', group: 'ÇOCUK', note: 'children' },
  { pattern: 'TV 8', group: 'ULUSAL', note: 'general-interest' },
  { pattern: 'Kanal 7', group: 'ULUSAL', note: 'general-interest' },
  { pattern: 'Beyaz TV', group: 'ULUSAL', note: 'general-interest' },
  { pattern: 'Flash TV', group: 'ULUSAL', note: 'general-interest' },
  { pattern: 'Investigation', group: 'BELGESEL', note: 'documentary' },
  { pattern: 'National Geographic', group: 'BELGESEL', note: 'documentary' },
  { pattern: 'Discovery Channel', group: 'BELGESEL', note: 'documentary' },
  { pattern: 'History', group: 'BELGESEL', note: 'documentary' },
];

/** The catalog as plain `want` patterns. */
export function catalogWantPatterns(catalog = CHANNEL_CATALOG) {
  return (Array.isArray(catalog) ? catalog : []).map((item) => item.pattern).filter(Boolean);
}

/**
 * The catalog's declared groups as `{ pattern, group }` rules, applied on top of
 * whatever the sources publish.  Entries without a `group` are skipped, so a
 * partially-annotated catalog is valid and those channels simply fall back to
 * the sources' own label.
 *
 * @param {object[]} [catalog]
 * @returns {{pattern: string, group: string}[]}
 */
export function catalogGroupOverrides(catalog = CHANNEL_CATALOG) {
  return (Array.isArray(catalog) ? catalog : [])
    .filter((item) => item && typeof item.pattern === 'string' && item.pattern.trim())
    .filter((item) => typeof item.group === 'string' && item.group.trim())
    .map((item) => ({ pattern: item.pattern.trim(), group: item.group.trim() }));
}

/**
 * Channels the catalog lists as unreachable or absent from the reference
 * sources.  Kept next to the catalog so the operator can see *why* an expected
 * channel is missing instead of guessing at a typo in the source list.
 */
export const CATALOG_NOTES = [
  'Regional editions (ATV Alanya / ATV Avrupa / Star TV Alanya) are not curated:',
  'they are the same feed as their base channel, so selecting them only adds duplicate rows.',
  'TRT 4K is listed separately because it is a distinct 4K simulcast, not a quality variant of TRT 1.',
].join(' ');