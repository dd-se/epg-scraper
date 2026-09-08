// Comparisons between two scrape() results.
//
// Two flavours, both wired to the CLI under --compare:
//
// - compareResults() — HTTP vs browser: the same provider scraped once with
//   plain HTTP and once with a headless browser.  Catches divergence from
//   JS-only channels, lazy-loaded rows, differently-rendered titles, ...
//
// - compareProviderResults() — provider vs provider: two different providers
//   (--provider a,b), diffed channel by channel so you can see whether, say,
//   hurriyet's and mynet's ATV schedules agree.

// Identity of a programme slot: channel + start + stop.  The XMLTV writer
// already dedupes on this triple, so comparison uses the same footing.
export function programmeKey(programme) {
  return [programme.channel, programme.start, programme.stop].join('|');
}

// Collapse each side to one programme per (channel, start, stop), keeping the
// first occurrence, before comparing.
function dedupeByKey(items, keyFn) {
  const byKey = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return byKey;
}

// Fields compared when the same slot exists on both sides.
const COMPARE_FIELDS = ['title', 'category'];

/**
 * Structurally diff two scrape() results.
 * @param {{ http: object, browser: object }} sides — { channels, programmes }
 * @returns {{
 *   channels: { http, browser, common, onlyHttp[], onlyBrowser[] },
 *   programmes: { http, browser, matched, changed[], onlyHttp[], onlyBrowser[] }
 * }}
 */
export function compareResults({ http, browser, canonicalize }) {
  const compared = compareSides({ a: http, b: browser, canonicalize });
  return {
    channels: {
      http: compared.summary.channelsA,
      browser: compared.summary.channelsB,
      common: compared.summary.common,
      onlyHttp: compared.summary.onlyAChannels,
      onlyBrowser: compared.summary.onlyBChannels,
    },
    programmes: {
      http: compared.summary.programmesA,
      browser: compared.summary.programmesB,
      matched: compared.summary.matched,
      changed: compared.summary.changed.map((s) => ({
        key: s.key,
        http: s.a,
        browser: s.b,
        diffs: s.diffs,
      })),
      onlyHttp: compared.summary.onlyA.map((s) => s.programme),
      onlyBrowser: compared.summary.onlyB.map((s) => s.programme),
    },
  };
}

/**
 * Diff two scrape() results (any two sides: http/browser or provider A/B)
 * channel by channel.  Programmes are deduped per side on (channel, start,
 * stop) before comparing; same-slot title/category changes count as
 * "changed", missing slots as only-a / only-b.
 *
 * @param {{ a: object, b: object, canonicalize?: (id: string) => string }} options
 *   a/b — { channels, programmes }; canonicalize maps alias ids to one
 *   canonical id (e.g. "AHABER.tr" -> "A.HABER.tr") so both sides line up.
 * @returns {{ channels: Array, summary: object }}
 */
export function compareProviderResults({ a, b, canonicalize }) {
  return compareSides({ a, b, canonicalize });
}

function compareSides({ a, b, canonicalize = (id) => id }) {
  // Tolerate absent sides entirely (null/undefined scrape results).
  const aChannels = (a && a.channels) || [];
  const bChannels = (b && b.channels) || [];
  const aProgrammes = (a && a.programmes) || [];
  const bProgrammes = (b && b.programmes) || [];

  // Canonicalize channel ids (optional alias map) so both sides land on the
  // same id for the same channel.
  const canon = (id) => canonicalize(String(id));
  const aById = new Map(aChannels.map((c) => [canon(c.id), c]));
  const bById = new Map(bChannels.map((c) => [canon(c.id), c]));
  const ids = [...new Set([...aById.keys(), ...bById.keys()])].sort();
  const aProgsFor = (id) => aProgrammes.filter((p) => canon(p.channel) === id);
  const bProgsFor = (id) => bProgrammes.filter((p) => canon(p.channel) === id);
  // Key on the canonical channel id so aliased ids land on the same slot.
  const canonKey = (programme) =>
    [canon(programme.channel), programme.start, programme.stop].join('|');

  const channels = [];
  const summary = {
    channelsA: aById.size,
    channelsB: bById.size,
    common: [], // channel ids present on both sides
    onlyAChannels: [],
    onlyBChannels: [],
    programmesA: aProgrammes.length,
    programmesB: bProgrammes.length,
    matched: 0,
    changed: [], // { key, a, b, diffs }
    onlyA: [], // { key, programme }
    onlyB: [], // { key, programme }
  };

  for (const id of ids) {
    const inA = aById.has(id);
    const inB = bById.has(id);
    if (inA && inB) {
      summary.common.push(id);
    } else if (inA) {
      summary.onlyAChannels.push(id);
      // Every programme on a channel only A carries is missing from B.
      for (const [key, programme] of dedupeByKey(aProgsFor(id), canonKey)) {
        summary.onlyA.push({ key, programme });
      }
    } else {
      summary.onlyBChannels.push(id);
      for (const [key, programme] of dedupeByKey(bProgsFor(id), canonKey)) {
        summary.onlyB.push({ key, programme });
      }
    }

    const entry = {
      id,
      inA,
      inB,
      programmesA: aProgsFor(id).length,
      programmesB: bProgsFor(id).length,
      matched: 0,
      changed: 0,
      onlyA: 0,
      onlyB: 0,
      samples: [],
    };

    if (inA && inB) {
      const aProgs = dedupeByKey(aProgsFor(id), canonKey);
      const bProgs = dedupeByKey(bProgsFor(id), canonKey);
      for (const [key, aProgramme] of aProgs) {
        const bProgramme = bProgs.get(key);
        if (!bProgramme) {
          entry.onlyA++;
          summary.onlyA.push({ key, programme: aProgramme });
          entry.samples.push({ kind: 'onlyA', key, programme: aProgramme });
          continue;
        }
        const diffs = COMPARE_FIELDS.filter((field) => aProgramme[field] !== bProgramme[field]);
        if (diffs.length === 0) {
          entry.matched++;
          summary.matched++;
        } else {
          entry.changed++;
          const diffEntry = { key, a: aProgramme, b: bProgramme, diffs };
          summary.changed.push(diffEntry);
          entry.samples.push({ kind: 'changed', ...diffEntry });
        }
      }
      for (const [key, bProgramme] of bProgs) {
        if (!aProgs.has(key)) {
          entry.onlyB++;
          summary.onlyB.push({ key, programme: bProgramme });
          entry.samples.push({ kind: 'onlyB', key, programme: bProgramme });
        }
      }
    }
    channels.push(entry);
  }

  return { channels, summary };
}

/**
 * Render a compareResults() report as human-readable lines.
 * @param {{ providerId: string, report: object, limit?: number }} options
 * @returns {string[]}
 */
export function renderCompareReport({ providerId, report, limit = 10 }) {
  const lines = [];
  const { channels, programmes } = report;

  lines.push(`compare: http vs browser (${providerId})`);
  lines.push(
    `  channels:   http ${channels.http} | browser ${channels.browser} | ` +
      `common ${channels.common.length} | only-http ${channels.onlyHttp.length} | ` +
      `only-browser ${channels.onlyBrowser.length}`
  );
  lines.push(
    `  programmes: http ${programmes.http} | browser ${programmes.browser} | ` +
      `matched ${programmes.matched} | changed ${programmes.changed.length} | ` +
      `only-http ${programmes.onlyHttp.length} | only-browser ${programmes.onlyBrowser.length}`
  );

  if (channels.onlyHttp.length > 0) {
    lines.push(`  channels only in http:    ${channels.onlyHttp.join(', ')}`);
  }
  if (channels.onlyBrowser.length > 0) {
    lines.push(`  channels only in browser: ${channels.onlyBrowser.join(', ')}`);
  }

  const samples = [];
  for (const diff of programmes.changed) {
    const before = diff.diffs.map((f) => `${f}="${diff.http[f]}"`).join(' ');
    const after = diff.diffs.map((f) => `${f}="${diff.browser[f]}"`).join(' ');
    samples.push(`  [changed]      ${diff.key}  http ${before} -> browser ${after}`);
  }
  for (const programme of programmes.onlyHttp) {
    samples.push(`  [only http]    ${programmeKey(programme)}  "${programme.title}"`);
  }
  for (const programme of programmes.onlyBrowser) {
    samples.push(`  [only browser] ${programmeKey(programme)}  "${programme.title}"`);
  }

  if (samples.length === 0) {
    lines.push('  result: no differences — HTTP and browser scraping agree');
  } else {
    lines.push(
      `  differences (showing ${Math.min(samples.length, limit)} of ${samples.length}):`
    );
    lines.push(...samples.slice(0, limit));
  }
  return lines;
}

/**
 * Render a compareProviderResults() report as human-readable lines: summary
 * counts, a per-channel breakdown, and sample differences.
 * @param {{ providerA: string, providerB: string, report: object, limit?: number }} options
 * @returns {string[]}
 */
export function renderProviderCompareReport({ providerA, providerB, report, limit = 10 }) {
  const lines = [];
  const { channels, summary: s } = report;

  lines.push(`compare providers: ${providerA} vs ${providerB}`);
  lines.push(
    `  channels:   ${providerA} ${s.channelsA} | ${providerB} ${s.channelsB} | ` +
      `common ${s.common.length} | only-${providerA} ${s.onlyAChannels.length} | ` +
      `only-${providerB} ${s.onlyBChannels.length}`
  );
  lines.push(
    `  programmes: ${providerA} ${s.programmesA} | ${providerB} ${s.programmesB} | ` +
      `matched ${s.matched} | changed ${s.changed.length} | ` +
      `only-${providerA} ${s.onlyA.length} | only-${providerB} ${s.onlyB.length}`
  );

  if (s.onlyAChannels.length > 0) {
    lines.push(`  channels only in ${providerA}: ${s.onlyAChannels.join(', ')}`);
  }
  if (s.onlyBChannels.length > 0) {
    lines.push(`  channels only in ${providerB}: ${s.onlyBChannels.join(', ')}`);
  }

  lines.push('channel breakdown:');
  for (const channel of channels) {
    if (channel.inA && channel.inB) {
      lines.push(
        `  ${channel.id.padEnd(24)} both: ${providerA} ${channel.programmesA} progs | ` +
          `${providerB} ${channel.programmesB} progs | matched ${channel.matched} | ` +
          `changed ${channel.changed} | only-${providerA} ${channel.onlyA} | ` +
          `only-${providerB} ${channel.onlyB}`
      );
    } else if (channel.inA) {
      lines.push(`  ${channel.id.padEnd(24)} only in ${providerA} (${channel.programmesA} programmes)`);
    } else {
      lines.push(`  ${channel.id.padEnd(24)} only in ${providerB} (${channel.programmesB} programmes)`);
    }
  }

  const samples = [];
  for (const channel of channels) {
    for (const sample of channel.samples) {
      if (sample.kind === 'changed') {
        const before = sample.diffs.map((f) => `${f}="${sample.a[f]}"`).join(' ');
        const after = sample.diffs.map((f) => `${f}="${sample.b[f]}"`).join(' ');
        samples.push(`  [changed]      ${sample.key}  ${providerA} ${before} -> ${providerB} ${after}`);
      } else if (sample.kind === 'onlyA') {
        samples.push(`  [only ${providerA}] ${sample.key}  "${sample.programme.title}"`);
      } else {
        samples.push(`  [only ${providerB}] ${sample.key}  "${sample.programme.title}"`);
      }
    }
  }

  const total = samples.length;
  if (total === 0) {
    lines.push('  result: no differences — the two providers agree');
  } else {
    lines.push(`differences (showing ${Math.min(total, limit)} of ${total}):`);
    lines.push(...samples.slice(0, limit));
  }
  return lines;
}