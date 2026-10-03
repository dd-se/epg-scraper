import {
  createGuideResult,
  programmeIdentityKey,
} from './model.js';

// Combine N provider results into one guide.
//
// Channels are unioned by canonical id: the first provider's entry wins, and a
// missing icon/url is backfilled from a later one.  Programmes are unioned and
// deduped by (channel, start, stop, title), so a slot both providers publish
// *identically* appears once — in the earlier provider's version.  Differing
// slot boundaries for the same channel both survive.
//
// `exclusiveChannels: true` makes the merge *exclusive* instead of additive for
// channels an earlier provider already listed: once a channel id is claimed by
// provider 1..n-1, provider n contributes nothing for it, so its slots never
// interleave with the owner's.  That is what you want when one feed is
// authoritative for a channel the others merely duplicate (TRT's own schedule
// vs Hürriyet's copy of the same channels).  Channels are still unioned, so a
// later provider's logo backfills an owner that has none.  Dropped slots are
// reported as `shadowed`.
export function mergeResults(
  results,
  canonicalize = (id) => id,
  { onIssue = () => {}, exclusiveChannels = false } = {}
) {
  const channelsById = new Map();
  const programmes = [];
  let days = 0;
  let failures = 0;
  let language;
  let shadowed = 0;

  for (const result of Array.isArray(results) ? results : []) {
    if (!result) continue;
    const guide = createGuideResult(result, { onIssue, sort: false });
    days += guide.days;
    failures += guide.failures;
    if (language == null) language = guide.language;
    else if (guide.language !== language) onIssue( 'mixed-language', 1);

    // Channel ids claimed by an *earlier* provider, snapshotted before this
    // provider's own channels are unioned in below. Consulted only in exclusive
    // mode; null means "keep everything" (the additive default).
    const ownedByOthers = exclusiveChannels ? new Set(channelsById.keys()) : null;

    for (const channel of guide.channels) {
      const canonicalId = canonicalize(channel.id);
      if (typeof canonicalId !== 'string' || canonicalId.trim() === '') {
        onIssue( 'invalid-channel', 1);
        continue;
      }
      const existing = channelsById.get(canonicalId);
      if (!existing) {
        channelsById.set(canonicalId, { ...channel, id: canonicalId });
      } else {
        if (existing.icon == null && channel.icon != null) existing.icon = channel.icon;
        if (existing.url == null && channel.url != null) existing.url = channel.url;
      }
    }

    for (const programme of guide.programmes) {
      const channel = canonicalize(programme.channel);
      if (typeof channel !== 'string' || channel.trim() === '') {
        onIssue( 'invalid-programme', 1);
        continue;
      }
      if (ownedByOthers != null && ownedByOthers.has(channel)) {
        shadowed++;
        continue;
      }
      programmes.push({ ...programme, channel });
    }
  }

  const identities = new Set();
  let duplicates = 0;
  const uniqueProgrammes = [];
  for (const programme of programmes) {
    const identity = programmeIdentityKey(programme);
    if (identities.has(identity)) {
      duplicates++;
      continue;
    }
    identities.add(identity);
    uniqueProgrammes.push(programme);
  }

  const merged = createGuideResult(
    {
      channels: [...channelsById.values()],
      programmes: uniqueProgrammes,
      days,
      failures,
      language: language || 'tr',
    },
    { onIssue, sort: false }
  );
  return { ...merged, duplicates, shadowed };
}
