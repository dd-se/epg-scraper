// Source collection: fetch each playlist, then run the parse → select →
// group → collapse → name pipeline over everything.
//
// Degradation is a feature here: one unreachable source must cost a `warn:`
// line and a failure count, never the run.  Only an all-sources-failed or
// nothing-matched run is a failure.  Every URL that can reach a log line passes
// through `redactUrl()` first, because playlist URLs routinely carry
// `?token=`/`?app=` credentials.

import fs from 'node:fs';
import path from 'node:path';
import { fetchText, createPoliteFetch, redactUrl } from '../http.js';
import { parseM3U } from './parser.js';
import { selectEntries } from './selection.js';
import {
  groupEntries,
  collapseIdenticalFeeds,
  unifyGroupTitles,
  applyNamingStyle,
  expandYedek,
  applyMaxCopies,
  baseDisplayName,
  normalizeStreamUrl,
} from './identity.js';

/**
 * Read one source.  A `file://` URL or a plain path is read from disk, which
 * is how fixtures and offline runs work; anything else goes through the shared
 * polite transport.
 */
async function readSource(source, options) {
  const { fetchImpl, politenessDelayMs = 0, transportOptions = {}, cwd = process.cwd() } = options;
  const target = source.url;

  if (/^file:\/\//i.test(target)) {
    return fs.promises.readFile(decodeURIComponent(new URL(target).pathname), 'utf8');
  }
  if (!/^https?:\/\//i.test(target)) {
    return fs.promises.readFile(path.resolve(cwd, target), 'utf8');
  }

  const politeFetch = createPoliteFetch(fetchImpl, politenessDelayMs);
  return fetchText(target, { ...transportOptions, fetchImpl: politeFetch });
}

/**
 * Fetch every source and build the merged, de-duplicated playlist.
 *
 * @param {object} options
 * @param {{id:string,url:string,weight?:number}[]} options.sources
 * @returns {Promise<object>} the run result (see `buildResult`)
 */
export async function collectEntries(options = {}) {
  const {
    sources = [],
    fetchImpl,
    log = () => {},
    politenessDelayMs = 0,
    transportOptions = {},
    want = [],
    exclude = [],
    style = 'backup',
    stripQuality = ['HD', 'FHD', 'UHD', 'SD'],
    useYedek = true,
    dedupeIdenticalUrls = true,
    unifyGroups = true,
    unifyScheme = true,
    keepQuery = false,
    inferTvgId = true,
    idSuffix = 'tr',
    maxCopies = 6,
    maxBytes,
    maxEntries,
    cwd = process.cwd(),
  } = options;

  const failures = [];
  const sourceReports = [];
  const all = [];
  let parsedTotal = 0;

  for (let order = 0; order < sources.length; order += 1) {
    const source = sources[order];
    try {
      const text = await readSource(source, { fetchImpl, politenessDelayMs, transportOptions, cwd });
      const { entries, stats } = parseM3U(text, { maxBytes, maxEntries, sourceId: source.id });
      parsedTotal += entries.length;
      // Stamp the provenance the ranking needs: config order and the source's
      // own weight (higher wins).
      all.push(...entries.map((entry) => ({
        ...entry,
        weight: Number(source.weight || 0),
        sourceOrder: order,
        sourceName: source.name,
      })));
      sourceReports.push({ id: source.id, url: redactUrl(source.url), ok: true, parsed: entries.length, stats });
      log(`source: ${source.id} — ${entries.length} entries (${redactUrl(source.url)})`);
      if (stats.truncated) log(`warn: source ${source.id} was truncated at the configured cap`);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      failures.push({ id: source.id, error: message });
      sourceReports.push({ id: source.id, url: redactUrl(source.url), ok: false, parsed: 0 });
      log(`warn: source ${source.id} failed: ${message}`);
    }
  }

  if (all.length === 0) {
    return buildResult({
      entries: [], failures, sources: sourceReports, unmatchedPatterns: [], conflicts: [],
      stats: { parsed: 0, yedekFound: 0, collapsedDuplicates: 0, maxCopiesDropped: 0 },
    });
  }

  const { kept, unmatchedPatterns } = selectEntries(all, { want, exclude });
  for (const pattern of unmatchedPatterns) log(`warn: pattern "${pattern}" matched no channel`);

  const { entries: expanded, yedekFound } = expandYedek(kept, { enabled: useYedek });
  const groups = groupEntries(expanded, { stripQuality });
  const { groups: collapsed, collapsedDuplicates } = collapseIdenticalFeeds(groups, {
    unifyScheme, keepQuery, dedupeIdenticalUrls,
  });
  const { groups: capped, maxCopiesDropped } = applyMaxCopies(collapsed, { maxCopies });
  // Unify the copies' group-title before naming so every copy of a channel
  // lands in one player folder (the label carried by the most copies wins).
  const unified = unifyGroups ? unifyGroupTitles(capped) : capped;
  const named = applyNamingStyle(unified, style, { idSuffix, inferTvgId });

  // Cross-group identical feeds.  Collapse runs per group, so two *differently
  // named* channels that happen to publish the very same URL ("A2TV" vs "A2")
  // survive it — measured at 21 such pairs across the reference sources.  A
  // duplicated URL is not a backup: it gives a player no redundancy, so it is
  // dropped and counted rather than shipped under a second name.
  //
  // The query string is deliberately KEPT for this pass.  Inside one group that
  // is right (a `?ce=` cache-buster is the same feed), but *across* groups the
  // query can select the channel itself —
  // `tvsms.club/tv.php?...&kanal=damar` vs `&kanal=vivatv` are two different
  // programs behind one path, and merging them here would silently delete a
  // real channel.  Only a byte-identical URL is unambiguous, so only that is
  // dropped.  Entries arrive in rank order, so the first occurrence is best.
  const seenFeeds = new Set();
  const emitted = [];
  let duplicateUrlDropped = 0;
  for (const entry of named.channels) {
    const feed = normalizeStreamUrl(entry.url, { unifyScheme, keepQuery: true });
    if (seenFeeds.has(feed)) {
      duplicateUrlDropped += 1;
      continue;
    }
    seenFeeds.add(feed);
    emitted.push(entry);
  }

  return buildResult({
    entries: emitted,
    failures,
    sources: sourceReports,
    unmatchedPatterns,
    conflicts: named.conflicts,
    droppedCopies: named.droppedCopies,
    maxCopiesDropped,
    duplicateUrlDropped,
    collapsedDuplicates,
    yedekFound,
    parsed: parsedTotal,
    groups: groups.length,
    selected: kept.length,
  });
}

/**
 * Normalize one channel copy into the emitted shape, applying `tvg-id` hygiene:
 * never emit the `ext` sentinel or an empty id, infer a missing id from the
 * channel's base name, and disambiguate repeats with an ordinal.
 */
function finalizeEntry(entry, seenIds, { inferTvgId = true } = {}) {
  const rawId = String(entry.tvgId == null ? '' : entry.tvgId).trim();
  let tvgId = rawId && rawId.toLowerCase() !== 'ext' ? rawId : '';

  if (!tvgId && inferTvgId) {
    // Infer from the *base* name, not the renamed copy name: the SPEC worked
    // example emits `tvg-id="ATV"` on the second, id-less copy.  Using the
    // renamed name would give `tvg-id="ATV Backup"`, which reads as a
    // different channel when the entry is joined against an EPG guide.
    tvgId = (
      String(entry.tvgName || '').trim() ||
      String(entry.baseName || '').trim() ||
      baseDisplayName(entry)
    ).trim();
  }

  if (tvgId) {
    // A repeated id makes the id useless for joining against an EPG guide
    // later, so repeats get an ordinal: `KANAL D HD.tr`, `KANAL D HD.2.tr`.
    const key = tvgId.toLowerCase();
    const count = (seenIds.get(key) || 0) + 1;
    seenIds.set(key, count);
    if (count > 1) {
      // An id inferred from a base name carries no country suffix
      // (`Halk TV`, not `Halk TV.tr`), so the ordinal has to be appended even
      // when the suffix form does not apply — otherwise the duplicate id
      // survives and the writer rejects the whole playlist.
      tvgId = /(\.[a-z]{2})$/i.test(tvgId)
        ? tvgId.replace(/(\.[a-z]{2})$/i, `.${count}$1`)
        : `${tvgId}.${count}`;
    }
  }

  return {
    id: entry.id,
    name: entry.name,
    tvgId,
    tvgName: entry.tvgName || '',
    logo: entry.tvgLogo || '',
    groupTitle: entry.group || '',
    url: entry.url,
    vlcOptions: entry.vlcOptions || [],
    sourceId: entry.sourceId || '',
    copyIndex: entry.copyIndex || 0,
    baseName: entry.baseName || '',
  };
}

function buildResult(raw) {
  const seenIds = new Map();
  const entries = (raw.entries || []).map((entry) => finalizeEntry(entry, seenIds, raw));
  return {
    entries,
    failures: raw.failures || [],
    sources: raw.sources || [],
    stats: {
      parsed: raw.parsed || 0,
      selected: raw.selected || 0,
      groups: raw.groups || 0,
      yedekFound: raw.yedekFound || 0,
      collapsedDuplicates: raw.collapsedDuplicates || 0,
      maxCopiesDropped: raw.maxCopiesDropped || 0,
      duplicateUrlDropped: raw.duplicateUrlDropped || 0,
      droppedCopies: raw.droppedCopies || 0,
      written: entries.length,
    },
    unmatchedPatterns: raw.unmatchedPatterns || [],
    conflicts: raw.conflicts || [],
  };
}

/**
 * Serialize a run report.  Every URL is redacted, so a token embedded in a
 * stream URL never reaches a file on disk.
 */
export function buildM3uReport(result) {
  return {
    generatedAt: new Date().toISOString(),
    stats: result.stats,
    failures: result.failures,
    unmatchedPatterns: result.unmatchedPatterns,
    conflicts: result.conflicts,
    sources: result.sources,
    entries: result.entries.map((entry) => ({
      name: entry.name,
      tvgId: entry.tvgId,
      sourceId: entry.sourceId,
      copyIndex: entry.copyIndex,
      url: redactUrl(entry.url),
    })),
    deadEntries: (result.deadEntries || []).map((dead) => ({
      name: dead.name,
      reason: dead.reason,
      status: dead.status,
      url: redactUrl(dead.url),
    })),
  };
}

export { buildResult, finalizeEntry };