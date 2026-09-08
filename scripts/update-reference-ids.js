// Refresh the vendored epgshare01 channel-id snapshot used by
// test/reference.test.mjs to enforce provider id normalization.
//
// Usage: npm run update:reference
//
// Downloads https://epgshare01.online/epgshare01/epg_ripper_TR1.xml.gz
// (the source of truth for XMLTV channel ids), extracts every channel
// id + display name, and rewrites test/fixtures/epgshare01/reference.json
// with today's UTC date in the `updated` field.  The `knownGaps` map
// (curated ids our providers use that upstream does not carry yet, with
// reasons) is preserved across refreshes.
//
// Run this at least weekly — the test suite fails when the snapshot is
// older than 7 days, so a stale reference can never silently drift.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEntities } from '../src/entities.js';

const SOURCE_URL = 'https://epgshare01.online/epgshare01/epg_ripper_TR1.xml.gz';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const outPath = path.join(root, 'test', 'fixtures', 'epgshare01', 'reference.json');

const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`reference download failed: HTTP ${response.status} (${SOURCE_URL})`);
}
const xml = gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8');

const byId = new Map();
for (const match of xml.matchAll(/<channel id="([^"]+)">([\s\S]*?)<\/channel>/g)) {
  const id = match[1];
  const nameMatch = /<display-name[^>]*>([\s\S]*?)<\/display-name>/.exec(match[2]);
  const name = nameMatch ? decodeEntities(nameMatch[1]).replace(/\s+/g, ' ').trim() : '';
  if (!byId.has(id)) byId.set(id, name);
}
if (byId.size === 0) {
  throw new Error('no <channel> entries found in the downloaded reference — refusing to overwrite the snapshot');
}

const channels = [...byId.entries()]
  .map(([id, name]) => ({ id, name }))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// Preserve human-curated acknowledgments across refreshes.
let knownGaps = {};
if (existsSync(outPath)) {
  try {
    knownGaps = JSON.parse(readFileSync(outPath, 'utf8')).knownGaps || {};
  } catch {
    knownGaps = {};
  }
}

const previous = new Set(
  existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, 'utf8')).channels.map((c) => c.id)
    : []
);
const current = new Set(channels.map((c) => c.id));
const added = channels.map((c) => c.id).filter((id) => !previous.has(id));
const removed = [...previous].filter((id) => !current.has(id));
const gapsNowCovered = Object.keys(knownGaps).filter((id) => current.has(id));

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    { source: SOURCE_URL, updated: today, channelCount: channels.length, knownGaps, channels },
    null,
    2
  ) + '\n'
);

console.log(`reference: ${channels.length} channel ids from ${SOURCE_URL}`);
console.log(`snapshot:  ${outPath} (updated: ${today})`);
if (added.length > 0) console.log(`added upstream (${added.length}): ${added.join(', ')}`);
if (removed.length > 0) console.log(`removed upstream (${removed.length}): ${removed.join(', ')}`);
if (gapsNowCovered.length > 0) {
  console.log(
    `known gaps now covered upstream — drop them from knownGaps: ${gapsNowCovered.join(', ')}`
  );
}
