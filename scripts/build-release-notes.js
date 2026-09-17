// Build the "latest" release body for the Daily EPG scrape workflow.
//
// Usage: node scripts/build-release-notes.js --guides <dir> --date YYYY-MM-DD
//
// Reads every epg_*.xml[.gz] guide in <dir> (the artifacts downloaded in the
// publish job) and prints markdown to stdout: one collapsible section per
// provider file listing exactly which channels that provider scraped, plus
// a union summary for the merged sports guide.  Generating this from the
// actual files (instead of hardcoding) keeps the notes accurate when
// lineups change.  Unreadable files degrade to a note — never a crash.
//
// The workflow stores the output in $GITHUB_ENV (RELEASE_BODY) and passes
// it as the release `body`.

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readXmltvFile } from '../src/xmltv.js';

const { values } = parseArgs({
  options: {
    guides: { type: 'string' },
    date: { type: 'string' },
  },
});
const guidesDir = values.guides || 'guide';
const guideDate = values.date || new Date().toISOString().slice(0, 10);

function providerIdFor(basename) {
  // Provider guides are epg_<id>_<COUNTRY>.xml[.gz] (TR unless the provider
  // declares otherwise — tvnu writes _SE).  Compare-mode files insert an
  // extra .http/.browser segment before the extension; merged guides are
  // handled by isMergedGuide() below, not here.
  const m = /^epg_(.+)_([A-Za-z]{2})([.]http|[.]browser)?([.]xml(?:[.]gz)?)?$/i.exec(basename);
  return m ? m[1] : undefined;
}

function isMergedGuide(basename) {
  return /^epg_(sports_)?merged_[A-Za-z]{2}[.]xml/i.test(basename);
}

let files = [];
try {
  files = readdirSync(guidesDir)
    .filter((f) => /^epg_.*[.]xml([.]gz)?$/i.test(f))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
} catch {
  files = [];
}

const lines = [
  `Daily XMLTV guides (Türkiye + Sweden), scraped ${guideDate} (00:30 UTC). Point your IPTV app's XMLTV/EPG source at the .xml.gz files below.`,
  '',
  'Which provider scraped which channels:',
  '',
];

const providerSections = [];
let mergedInfo;

for (const file of files) {
  let channels = null;
  try {
    ({ channels } = await readXmltvFile(path.join(guidesDir, file)));
  } catch {
    channels = null;
  }
  if (isMergedGuide(file)) {
    mergedInfo = { file, count: channels ? channels.length : undefined };
    continue;
  }
  const provider = providerIdFor(file) || 'unknown';
  if (!channels) {
    providerSections.push({ file, provider, channels: null });
    continue;
  }
  providerSections.push({ file, provider, channels });
}

for (const { file, provider, channels } of providerSections) {
  if (!channels) {
    lines.push(`- \`${file}\` (provider \`${provider}\`) — could not be read in CI`);
    lines.push('');
    continue;
  }
  lines.push(`<details><summary><b>\`${file}\`</b> — provider \`${provider}\`, ${channels.length} channels</summary>`);
  lines.push('');
  for (const channel of channels) {
    const name = String(channel.name || channel.id).replace(/`/g, "'");
    lines.push(`- ${name} (\`${channel.id}\`)`);
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');
}

if (mergedInfo) {
  const sources = providerSections.map((s) => `\`${s.file}\``).join(' + ') || 'the provider guides above';
  const count = mergedInfo.count != null ? `${mergedInfo.count} channels` : 'channel count unknown';
  lines.push(`<details><summary><b>\`${mergedInfo.file}\`</b> — merged guide, ${count}</summary>`);
  lines.push('');
  lines.push(`Union of ${sources} (first file wins conflicting slots; channel lists per source above).`);
  lines.push('');
  lines.push('</details>');
  lines.push('');
}

process.stdout.write(lines.join('\n'));
