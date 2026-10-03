// Build the "latest" release body for the Daily EPG scrape workflow.
//
// Usage: node scripts/build-release-notes.js --guides <dir> --date YYYY-MM-DD
//
// Reads every epg_*.xml[.gz] guide in <dir> (the artifacts downloaded in the
// publish job) and prints markdown to stdout: one collapsible section per
// provider file listing exactly which channels that provider scraped, plus
// one section per merged guide.  Generating this from the actual files
// (instead of hardcoding) keeps the notes accurate when lineups change.
// Unreadable files degrade to a note — never a crash.
//
// A merged asset's filename says nothing about what went into it, so each one
// is resolved back to the COMMAND_PROFILES entry that produced it and described
// with that profile's real inputs.  Without that lookup a merged guide would be
// reported as a provider of its own (`epg_hurriyet_trt_merged_TR.xml.gz` →
// "provider `hurriyet_trt_merged`"), and its sources would be guessed from
// whichever provider guides happened to be in the directory.
//
// The workflow stores the output in $GITHUB_ENV (RELEASE_BODY) and passes
// it as the release `body`.

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readXmltvFile } from '../src/xmltv.js';
import { COMMAND_PROFILES, profileInputFiles } from '../src/provider-catalog.js';

// The profile whose `output` is this file, i.e. what was merged into it.
const mergedProfileFor = (basename) =>
  Object.entries(COMMAND_PROFILES).find(([, profile]) => profile.output === basename)?.[0];

function providerIdFor(basename) {
  // Provider guides are epg_<id>_<COUNTRY>.xml[.gz] (TR unless the provider
  // declares otherwise — tvnu writes _SE).  Compare-mode files insert an
  // extra .http/.browser segment before the extension; merged guides are
  // handled by isMergedGuide() below, not here.
  const m = /^epg_(.+)_([A-Za-z]{2})([.]http|[.]browser)?([.]xml(?:[.]gz)?)?$/i.exec(basename);
  return m ? m[1] : undefined;
}

function isMergedGuide(basename) {
  // epg_sports_merged_TR.xml.gz, epg_hurriyet_trt_merged_TR.xml.gz, …
  return /^epg_.*_merged_[A-Za-z]{2}[.]xml/i.test(basename);
}

async function readChannels(guidesDir, file) {
  try {
    const { channels } = await readXmltvFile(path.join(guidesDir, file));
    return channels;
  } catch {
    return null;
  }
}

export async function buildReleaseNotes({ guidesDir, guideDate }) {
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
  const mergedSections = [];

  for (const file of files) {
    const channels = await readChannels(guidesDir, file);
    if (isMergedGuide(file)) {
      const profileName = mergedProfileFor(file);
      const profile = profileName ? COMMAND_PROFILES[profileName] : null;
      mergedSections.push({
        file,
        channels,
        profileName,
        // Fall back to naming the profile's own guide files; a profile we do
        // not recognize (a hand-made merge) gets the generic wording below.
        inputs: profile ? profileInputFiles(profile) : null,
        exclusiveChannels: profile?.exclusiveChannels === true,
      });
      continue;
    }
    providerSections.push({ file, provider: providerIdFor(file) || 'unknown', channels });
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

  for (const { file, channels, profileName, inputs, exclusiveChannels } of mergedSections) {
    const count = channels ? `${channels.length} channels` : 'channel count unknown';
    const label = profileName ? `merged guide \`${profileName}\`, ${count}` : `merged guide, ${count}`;
    lines.push(`<details><summary><b>\`${file}\`</b> — ${label}</summary>`);
    lines.push('');
    if (!channels) {
      lines.push('This merged guide could not be read in CI.');
    } else if (inputs) {
      const sources = inputs.map((input) => `\`${input}\``).join(' + ');
      lines.push(`Union of ${sources} — the first guide wins conflicting slots.`);
      if (exclusiveChannels) {
        lines.push('');
        lines.push(
          `Each channel comes from exactly one guide: the first guide that lists a channel owns it, so \`${inputs[0]}\`'s channels are not interleaved with the rest.`
        );
      }
    } else {
      lines.push('Union of the provider guides above (first file wins conflicting slots).');
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      guides: { type: 'string' },
      date: { type: 'string' },
    },
  });
  const guidesDir = values.guides || 'guide';
  const guideDate = values.date || new Date().toISOString().slice(0, 10);
  process.stdout.write(await buildReleaseNotes({ guidesDir, guideDate }));
}