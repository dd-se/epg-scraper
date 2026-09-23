import {
  createGuideResult,
  programmeIdentityKey,
} from './model.js';

export function mergeResults(results, canonicalize = (id) => id, { onIssue = () => {} } = {}) {
  const channelsById = new Map();
  const programmes = [];
  let days = 0;
  let failures = 0;
  let language;

  for (const result of Array.isArray(results) ? results : []) {
    if (!result) continue;
    const guide = createGuideResult(result, { onIssue, sort: false });
    days += guide.days;
    failures += guide.failures;
    if (language == null) language = guide.language;
    else if (guide.language !== language) onIssue( 'mixed-language', 1);

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
  return { ...merged, duplicates };
}
