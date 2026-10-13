// XMLTV channel ids are this project's own format. Two namespaces exist:
//
// - Turkish guides (`.tr`): the channel name in ASCII with every Turkish
//   diacritic folded to its Latin letter (Ç→C, Ğ→G, İ→I, I→I, ı→I, Ö→O,
//   Ş→S, Ü→U and the lowercase forms), no separators at all, case preserved,
//   plus the `.tr` suffix — "TRT Çocuk" -> "TRTCOCUK.tr", "beIN Sports 1" ->
//   "beINSPORTS1.tr", "TRT 2" -> "TRT2.tr". Only the suffix may contain a dot.
// - Swedish guides (`.se`): ids keep their upstream spelling, including the
//   bracketed source tag and any punctuation it carries
//   (`[SVT1HD].SVT1.HD.se`), and pass through untouched.
//
// `foldChannelId` implements the Turkish rule and is idempotent, so it is safe
// to apply at any seam; `isCanonicalChannelId` is the writer-side check.
// Provider adapters keep a curated map for spellings the generic slug rule
// cannot recover (station aliases, case-sensitive ids like "beINSPORTS1.tr",
// SD/HD qualifiers), so `channelIdFromName` is only a fallback.

const TR_SUFFIX = '.tr';
const SE_SUFFIX = '.se';
const CANONICAL_TR_RE = /^[A-Za-z0-9]+\.[a-z]{2}$/;

const TURKISH_FOLD = new Map([
  ['Ç', 'C'],
  ['ç', 'C'],
  ['Ğ', 'G'],
  ['ğ', 'G'],
  ['İ', 'I'],
  ['ı', 'I'],
  ['Ö', 'O'],
  ['ö', 'O'],
  ['Ş', 'S'],
  ['ş', 'S'],
  ['Ü', 'U'],
  ['ü', 'U'],
]);

/**
 * Fold a channel id into this project's canonical spelling. Turkish ids lose
 * their diacritics and their dots; every other id (Swedish, and anything the
 * caller made up) is returned unchanged.  A `.tr` *domain* would also end in
 * the id suffix, so ids carrying path or scheme punctuation are passed through
 * untouched — only channel ids belong in here.
 *
 * @param {string} id
 * @returns {string}
 */
export function foldChannelId(id) {
  if (typeof id !== 'string' || !id.endsWith(TR_SUFFIX)) return id;
  if (id.includes('/') || id.includes(':')) return id;
  const base = id.slice(0, -TR_SUFFIX.length);
  const folded = [...base].map((char) => TURKISH_FOLD.get(char) ?? char).join('');
  return folded.replace(/\./g, '') + TR_SUFFIX;
}

/**
 * @param {string} id
 * @returns {boolean} true when `id` is already in its final emitted spelling.
 */
export function isCanonicalChannelId(id) {
  if (typeof id !== 'string' || id === '') return false;
  if (id.endsWith(SE_SUFFIX)) return true;
  return CANONICAL_TR_RE.test(id) && foldChannelId(id) === id;
}

export function channelIdFromName(name, country = 'tr') {
  const upper = String(name == null ? '' : name).trim().toUpperCase();
  const slug = upper
    .replace(/[^A-Z0-9]+/g, '.')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  const suffix = String(country == null ? 'tr' : country).trim().toLowerCase() || 'tr';
  return (slug || 'UNKNOWN') + '.' + suffix;
}
