// Merge results from multiple providers into a single complete guide.
//
// Channel identity is the XMLTV channel id, so channels are unioned by id
// (the first provider's name wins; a missing icon/url is backfilled from
// later providers).  Programmes are unioned and
// exact duplicates (channel, start, stop, title) removed; the XMLTV writer's
// own (channel, start, stop) dedupe then keeps the *first* provider's version
// of conflicting slots — the order given to --provider a,b,c sets the
// precedence, so list the most authoritative source first and let later
// providers fill the gaps.

function programmeKey(programme) {
  return [programme.channel, programme.start, programme.stop].join('|');
}

/**
 * Combine provider scrape() results.
 * @param {Array<{ providerId?: string, channels: object[], programmes: object[] }>} results
 * @param {(id: string) => string} [canonicalize]  maps alias ids to one
 *   canonical id (e.g. "AHABER.tr" -> "A.HABER.tr"); channel ids and every
 *   programme's channel reference are rewritten through it so the guide stays
 *   internally consistent.
 * @returns {{ channels: object[], programmes: object[], duplicates: number }}
 */
export function mergeResults(results, canonicalize = (id) => id) {
  const channelsById = new Map();
  const programmes = [];

  for (const result of results) {
    if (!result) continue; // hostile/absent entry: skip, never crash
    for (const channel of result.channels || []) {
      if (channel && channel.id) {
        const canonicalId = canonicalize(channel.id);
        const existing = channelsById.get(canonicalId);
        if (!existing) {
          channelsById.set(canonicalId, { ...channel, id: canonicalId });
        } else {
          // First provider wins, but a missing icon/url is backfilled so
          // merged guides keep TV logos even when the primary source lacks
          // them (e.g. a provider without scraped logos listed first).
          if (existing.icon == null && channel.icon != null) existing.icon = channel.icon;
          if (existing.url == null && channel.url != null) existing.url = channel.url;
        }
      }
    }
    for (const programme of result.programmes || []) {
      programmes.push({ ...programme, channel: canonicalize(programme.channel) });
    }
  }

  const seen = new Set();
  let duplicates = 0;
  const deduped = programmes.filter((p) => {
    const key = [p.channel, p.start, p.stop, p.title].join('|');
    if (seen.has(key)) {
      duplicates++;
      return false;
    }
    seen.add(key);
    return true;
  });

  return { channels: [...channelsById.values()], programmes: deduped, duplicates };
}