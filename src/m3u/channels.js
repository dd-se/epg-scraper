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
// bare `ATV` never drags in the `ATV Alanya` edition; editions are listed
// explicitly below, which is the point of keeping the list authored.

export const CHANNEL_CATALOG = [
  // National general-interest
  { pattern: 'ATV', note: 'national general-interest' },
  { pattern: 'TRT 1', note: 'national general-interest' },
  { pattern: 'Kanal D', note: 'national general-interest' },
  { pattern: 'Star TV', note: 'national general-interest' },
  { pattern: 'Show TV', note: 'national general-interest' },
  { pattern: 'FOX', note: 'national general-interest' },
  { pattern: 'NOW TV', note: 'national entertainment' },
  { pattern: 'Show Turk', note: 'national general-interest' },
  { pattern: 'Show Max', note: 'national entertainment' },
  { pattern: '24 TV', note: 'news' },

  // News
  { pattern: 'CNN Turk', note: 'news' },
  { pattern: 'NTV', note: 'news' },
  { pattern: 'A Haber', note: 'news' },
  { pattern: 'TRT Haber', note: 'news' },
  { pattern: 'TV8 Haber', note: 'news' },
  { pattern: 'Bloomberg HT', note: 'news' },

  // Sports
  { pattern: 'TRT Spor', note: 'sports' },
  { pattern: 'A Spor', note: 'sports' },
  { pattern: 'beIN Sports 1', note: 'sports' },
  { pattern: 'beIN Sports 2', note: 'sports' },
  { pattern: 'beIN Sports 3', note: 'sports' },
  { pattern: 'beIN Sports 4', note: 'sports' },
  { pattern: 'tabii spor 1', note: 'sports' },
  { pattern: 'S Sport 1', note: 'sports' },
  { pattern: 'Eurosport 1', note: 'sports' },

  // Entertainment / children / regional
  { pattern: 'TRT 4K', note: '4K simulcast (E1: separate from TRT 1)' },
  { pattern: 'TRT Çocuk', note: 'children' },
  { pattern: 'Minik Go', note: 'children' },
  { pattern: 'Baby TV', note: 'children' },
  { pattern: 'Cartoon Network', note: 'children' },
  { pattern: 'Nickelodeon', note: 'children' },
  { pattern: 'Disney Channel', note: 'children' },
  { pattern: 'TV 8', note: 'general-interest' },
  { pattern: 'Kanal 7', note: 'general-interest' },
  { pattern: 'Beyaz TV', note: 'general-interest' },
  { pattern: 'Flash TV', note: 'general-interest' },
  { pattern: 'Investigation', note: 'documentary' },
  { pattern: 'National Geographic', note: 'documentary' },
  { pattern: 'Discovery Channel', note: 'documentary' },
  { pattern: 'History', note: 'documentary' },
];

/** The catalog as plain `want` patterns. */
export function catalogWantPatterns(catalog = CHANNEL_CATALOG) {
  return (Array.isArray(catalog) ? catalog : []).map((item) => item.pattern).filter(Boolean);
}

/**
 * Channels the catalog lists as unreachable or absent from the reference
 * sources.  Kept next to the catalog so the operator can see *why* an expected
 * channel is missing instead of guessing at a typo in the source list.
 */
export const CATALOG_NOTES = [
  'Regional editions (ATV Alanya / ATV Avrupa / Star TV Alanya) are separate channels by design:',
  'they carry their own tvg-id and host and must never be folded into their base channel (E1).',
  'TRT 4K is excluded from quality folding for the same reason — it is a distinct simulcast.',
].join(' ');