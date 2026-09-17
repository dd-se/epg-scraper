// Refresh the vendored epgshare01 channel-id snapshots used by
// test/reference.test.mjs to enforce provider id normalization.
//
// Usage: npm run update:reference
//
// Downloads the per-country epgshare01 guides that our providers normalize
// against:
//
//   https://epgshare01.online/epgshare01/epg_ripper_TR1.xml.gz -> reference.json
//   https://epgshare01.online/epgshare01/epg_ripper_SE1.xml.gz -> reference-se.json
//
// (the Turkish guide is the source of truth for the Turkish providers, the
// Swedish guide for the tvnu provider), extracts every channel id + display
// name, and rewrites each snapshot with today's UTC date in the `updated`
// field.  The `knownGaps` map of each file (curated ids our providers use
// that upstream does not carry yet, with reasons) is preserved across
// refreshes.
//
// Run this at least weekly — the test suite fails when a snapshot is older
// than 7 days, so a stale reference can never silently drift.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEntities } from '../src/entities.js';

// One snapshot per country guide we normalize provider ids against.  `file`
// lives in test/fixtures/epgshare01/ and keeps the same schema for both.
export const SNAPSHOTS = [
  {
    country: 'TR',
    file: 'reference.json',
    url: 'https://epgshare01.online/epgshare01/epg_ripper_TR1.xml.gz',
  },
  {
    country: 'SE',
    file: 'reference-se.json',
    url: 'https://epgshare01.online/epgshare01/epg_ripper_SE1.xml.gz',
  },
];

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD

// Extract every `<channel id>` + its first `<display-name>` from a guide.
export function extractChannels(xml) {
  const byId = new Map();
  for (const match of xml.matchAll(/<channel id="([^"]+)">([\s\S]*?)<\/channel>/g)) {
    const id = match[1];
    const nameMatch = /<display-name[^>]*>([\s\S]*?)<\/display-name>/.exec(match[2]);
    const name = nameMatch ? decodeEntities(nameMatch[1]).replace(/\s+/g, ' ').trim() : '';
    if (!byId.has(id)) byId.set(id, name);
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function refresh({ country, file, url }) {
  const outPath = path.join(root, 'test', 'fixtures', 'epgshare01', file);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`reference download failed: HTTP ${response.status} (${url})`);
  }
  const xml = gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8');

  const channels = extractChannels(xml);
  if (channels.length === 0) {
    throw new Error(`no <channel> entries found in ${url} — refusing to overwrite ${file}`);
  }

  // Preserve human-curated acknowledgments across refreshes.
  let knownGaps = {};
  let previous = new Set();
  if (existsSync(outPath)) {
    try {
      const old = JSON.parse(readFileSync(outPath, 'utf8'));
      knownGaps = old.knownGaps || {};
      previous = new Set((old.channels || []).map((c) => c.id));
    } catch {
      knownGaps = {};
    }
  }

  const current = new Set(channels.map((c) => c.id));
  const added = channels.map((c) => c.id).filter((id) => !previous.has(id));
  const removed = [...previous].filter((id) => !current.has(id));
  const gapsNowCovered = Object.keys(knownGaps).filter((id) => current.has(id));

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      { source: url, country, updated: today, channelCount: channels.length, knownGaps, channels },
      null,
      2
    ) + '\n'
  );

  console.log(`[${country}] reference: ${channels.length} channel ids from ${url}`);
  console.log(`[${country}] snapshot:  ${outPath} (updated: ${today})`);
  if (added.length > 0) console.log(`[${country}] added upstream (${added.length}): ${added.join(', ')}`);
  if (removed.length > 0) console.log(`[${country}] removed upstream (${removed.length}): ${removed.join(', ')}`);
  if (gapsNowCovered.length > 0) {
    console.log(
      `[${country}] known gaps now covered upstream — drop them from knownGaps: ${gapsNowCovered.join(', ')}`
    );
  }
}

// Only download when run as a script (npm run update:reference); importing it
// from a test must never hit the network.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  for (const snapshot of SNAPSHOTS) {
    await refresh(snapshot);
  }
}

