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
  { pattern: 'ATV', id: 'atv.tr', group: 'ULUSAL', note: 'national general-interest' },
  { pattern: 'TRT 1', id: 'trt1.tr', group: 'ULUSAL', note: 'national general-interest' },
  { pattern: 'Kanal D', id: 'kanald.tr', group: 'ULUSAL', note: 'national general-interest' },
  { pattern: 'Star TV', id: 'startv.tr', group: 'ULUSAL', note: 'national general-interest' },
  // The source publishes `SHOW TV HD`; the Hürriyet guide spells the channel
  // `SHOW TV`, and a name-keyed consumer only finds the guide under that
  // spelling.  Declared here so the id/name pair stays stable if the source
  // re-spells it.  See `EPG_NAME_CONTRACT` below for the rename contract.
  { pattern: 'Show TV', id: 'showtvhd.tr', name: 'SHOW TV', group: 'ULUSAL', note: 'national general-interest' },
  { pattern: 'FOX', id: 'fox.tr', group: 'ULUSAL', note: 'national general-interest' },
  { pattern: 'NOW TV', id: 'nowtv.tr', name: 'NOW', group: 'DİZİ', note: 'national entertainment; guide spells it NOW' },
  { pattern: 'Show Turk', id: 'showturk.tr', group: 'ULUSAL', note: 'national general-interest' },
  { pattern: 'Show Max', id: 'showmax.tr', group: 'DİZİ', note: 'national entertainment' },
  { pattern: '24 TV', id: '24tv.tr', group: 'HABER', note: 'news' },

  // Haber
  { pattern: 'CNN Turk', id: 'cnnturk.tr', name: 'CNN TURK', group: 'HABER', note: 'news; ASCII id/name, guide spells it CNN TÜRK' },
  { pattern: 'NTV', id: 'ntv.tr', group: 'HABER', note: 'news' },
  { pattern: 'A Haber', id: 'ahaber.tr', group: 'HABER', note: 'news' },
  { pattern: 'TRT Haber', id: 'trthaber.tr', group: 'HABER', note: 'news' },
  { pattern: 'TV8 Haber', id: 'tv8haber.tr', group: 'HABER', note: 'news' },
  { pattern: 'Bloomberg HT', id: 'bloomberght.tr', group: 'HABER', note: 'news' },

  // Spor
  { pattern: 'TRT Spor', id: 'trtspor.tr', group: 'SPOR', note: 'sports' },
  { pattern: 'A Spor', id: 'aspor.tr', group: 'SPOR', note: 'sports' },
  { pattern: 'beIN Sports 1', id: 'beinsports1.tr', group: 'SPOR', note: 'sports' },
  { pattern: 'beIN Sports 2', id: 'beinsports2.tr', group: 'SPOR', note: 'sports' },
  { pattern: 'beIN Sports 3', id: 'beinsports3.tr', group: 'SPOR', note: 'sports' },
  { pattern: 'beIN Sports 4', id: 'beinsports4.tr', group: 'SPOR', note: 'sports' },
  { pattern: 'tabii spor 1', id: 'tabiispor1.tr', group: 'SPOR', note: 'sports' },
  { pattern: 'S Sport 1', id: 'ssport1.tr', group: 'SPOR', note: 'sports' },
  { pattern: 'Eurosport 1', id: 'eurosport1.tr', group: 'SPOR', note: 'sports' },

  // Eğlence / çocuk
  { pattern: 'TRT 4K', id: 'trt4k.tr', group: 'ULUSAL', note: '4K simulcast (E1: separate from TRT 1)' },
  { pattern: 'TRT Çocuk', id: 'trtcocuk.tr', group: 'ÇOCUK', note: 'children' },
  { pattern: 'Minik Go', id: 'minikgo.tr', group: 'ÇOCUK', note: 'children' },
  { pattern: 'Baby TV', id: 'babytv.tr', group: 'ÇOCUK', note: 'children' },
  { pattern: 'Cartoon Network', id: 'cartoonnetwork.tr', group: 'ÇOCUK', note: 'children' },
  { pattern: 'Nickelodeon', id: 'nickelodeon.tr', group: 'ÇOCUK', note: 'children' },
  { pattern: 'Disney Channel', id: 'disneychannel.tr', group: 'ÇOCUK', note: 'children' },
  // The source publishes `TV 8`; the Hürriyet guide spells it `TV8`, and the
  // space would also be illegal in a strict tvg-id.
  { pattern: 'TV 8', id: 'tv8.tr', name: 'TV8', group: 'ULUSAL', note: 'general-interest; guide spells it TV8' },
  { pattern: 'Kanal 7', id: 'kanal7.tr', group: 'ULUSAL', note: 'general-interest' },
  { pattern: 'Beyaz TV', id: 'beyaztv.tr', group: 'ULUSAL', note: 'general-interest' },
  { pattern: 'Flash TV', id: 'flashtv.tr', group: 'ULUSAL', note: 'general-interest' },
  { pattern: 'Investigation', id: 'investigation.tr', group: 'BELGESEL', note: 'documentary' },
  { pattern: 'National Geographic', id: 'nationalgeographic.tr', group: 'BELGESEL', note: 'documentary' },
  { pattern: 'Discovery Channel', id: 'discoverychannel.tr', group: 'BELGESEL', note: 'documentary' },
  { pattern: 'History', id: 'history.tr', group: 'BELGESEL', note: 'documentary' },
];

/**
 * The three renames a name-keyed consumer needs, and why.
 *
 * Such a consumer folds both the playlist name and the XMLTV `<display-name>`
 * (lowercase, Turkish-insensitively) and matches on the result, keeping word
 * breaks — so `TV 8` and `TV8` are *different* channels and only one of them
 * has a guide.  Each entry pairs the source's spelling with the guide's.
 *
 * The `tvg-id` deliberately keeps its ORIGINAL slug: the id is the stored
 * identity for a viewer's selection and must never change once published, while
 * the name is only a label.
 */
export const EPG_NAME_CONTRACT = [
  { from: 'NOW TV', to: 'NOW', guide: 'NOW', epgId: 'FOX.tr' },
  { from: 'TV 8', to: 'TV8', guide: 'TV8', epgId: 'TV8.tr' },
  { from: 'SHOW TV HD', to: 'SHOW TV', guide: 'SHOW TV', epgId: 'SHOW.TV.tr' },
];

/**
 * Channels that ship in the playlist but carry no programme data in either
 * published EPG feed, so a viewer picking them gets a channel with no
 * NOW/NEXT.  Kept beside the catalog so the gap is a decision on record rather
 * than a silent omission.
 */
export const CATALOG_EPG_GAPS = [
  { name: 'TRT 4K', reason: 'no provider serves it and the upstream epgshare01 reference carries no TRT 4K id' },
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
 * The catalog's declared identity as `{ pattern, id, name }` rules.
 *
 * A declared `id` is **permanent**: it is what a consumer stores for a viewer's
 * selection, so it is authored here rather than derived from whatever the source
 * happens to publish this week.  A declared `name` pins the display label to
 * the spelling the EPG guide uses.
 *
 * Entries without a field are skipped rather than defaulted, so a partially
 * annotated catalog is valid: an undeclared id is derived as before, and an
 * undeclared name keeps the source's own spelling.
 *
 * @param {object[]} [catalog]
 * @returns {{pattern: string, id?: string, name?: string}[]}
 */
export function catalogIdentityOverrides(catalog = CHANNEL_CATALOG) {
  return (Array.isArray(catalog) ? catalog : [])
    .filter((item) => item && typeof item.pattern === 'string' && item.pattern.trim())
    .map((item) => {
      const rule = { pattern: item.pattern.trim() };
      if (typeof item.id === 'string' && item.id.trim()) rule.id = item.id.trim();
      if (typeof item.name === 'string' && item.name.trim()) rule.name = item.name.trim();
      return rule;
    })
    .filter((rule) => rule.id || rule.name);
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