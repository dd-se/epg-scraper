import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHANNEL_ID_MAP as HURRIYET_MAP } from '../src/providers/hurriyet.js';
import { CHANNEL_ID_MAP as MYNET_MAP } from '../src/providers/mynet.js';
import { CHANNEL_ID_MAP as TVPLUS_MAP } from '../src/providers/tvplus.js';
import { CHANNEL_ID_MAP as BEINSPORTS_MAP } from '../src/providers/beinsports.js';
import { CHANNEL_ID_MAP as DIGITURKBURADA_MAP } from '../src/providers/digiturkburada.js';
import { CHANNEL_ID_MAP as SPOREKRANI_MAP } from '../src/providers/sporekrani.js';
import { CHANNEL_ID_MAP as TIVIBU_MAP } from '../src/providers/tivibu.js';
import { CHANNEL_ID_MAP as IDMAN_MAP } from '../src/providers/idmantv.js';
import { CHANNEL_ID_MAP as TVNU_MAP } from '../src/providers/tvnu.js';

// Enforces provider channel-id normalization against the source of truth: the
// vendored epgshare01 per-country snapshots under test/fixtures/epgshare01/.
// Each snapshot is the contract for the providers targeting that country —
// reference.json (epg_ripper_TR1.xml.gz) for the Turkish providers,
// reference-se.json (epg_ripper_SE1.xml.gz) for tvnu — and maps ids to the
// `.tr` / `.se` suffix that country's guide uses.  Refresh both at least
// weekly with `npm run update:reference`: the freshness test fails once a
// snapshot is older than 7 days, so a stale reference can never drift
// silently.  No network is used here; the snapshots are the contract.

const SNAPSHOTS = [
  {
    file: 'reference.json',
    country: 'TR',
    suffix: '.tr',
    providers: [
      ['hurriyet', HURRIYET_MAP],
      ['mynet', MYNET_MAP],
      ['tvplus', TVPLUS_MAP],
      ['beinsports', BEINSPORTS_MAP],
      ['digiturkburada', DIGITURKBURADA_MAP],
      ['sporekrani', SPOREKRANI_MAP],
      ['tivibu', TIVIBU_MAP],
      ['idmantv', IDMAN_MAP],
    ],
  },
  {
    file: 'reference-se.json',
    country: 'SE',
    suffix: '.se',
    providers: [['tvnu', TVNU_MAP]],
  },
];

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

for (const { file, country, suffix, providers } of SNAPSHOTS) {
  const refPath = fileURLToPath(new URL(`./fixtures/epgshare01/${file}`, import.meta.url));
  const ref = JSON.parse(readFileSync(refPath, 'utf8'));
  const refIds = new Set(ref.channels.map((c) => c.id));
  const knownGaps = ref.knownGaps || {};

  describe(`epgshare01 reference snapshot (${country})`, () => {
    it('has a valid updated date', () => {
      expect(ref.updated, `${file} needs an "updated": "YYYY-MM-DD" field`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/
      );
      expect(Number.isNaN(Date.parse(`${ref.updated}T00:00:00Z`))).toBe(false);
    });

    it('is at most 7 days old — refresh with npm run update:reference', () => {
      const ageMs = Date.now() - Date.parse(`${ref.updated}T00:00:00Z`);
      expect(ageMs).toBeGreaterThanOrEqual(0);
      expect(
        ageMs,
        `reference snapshot is ${Math.floor(ageMs / 86400000)} day(s) old ` +
          `(updated: ${ref.updated}). Run npm run update:reference to re-vendor it.`
      ).toBeLessThanOrEqual(MAX_AGE_MS);
    });

    it('declares the country whose guide it snapshots', () => {
      expect(ref.country).toBe(country);
      expect(ref.source).toMatch(new RegExp(`epg_ripper_${country}\\d*\\.xml\\.gz$`));
    });

    it('contains a sane channel-id list', () => {
      expect(ref.channels.length).toBeGreaterThan(100);
      expect(ref.channelCount).toBe(ref.channels.length);
      expect(refIds.size).toBe(ref.channels.length); // no duplicates
      for (const { id } of ref.channels) {
        expect(id.endsWith(suffix), `reference id "${id}" must carry the ${suffix} suffix`).toBe(
          true
        );
      }
    });

    it('every curated provider id exists upstream (or is an acknowledged gap)', () => {
      for (const [provider, map] of providers) {
        for (const [name, id] of Object.entries(map)) {
          expect(
            id.endsWith(suffix),
            `[${provider}] curated id "${id}" (for "${name}") must carry the ${suffix} ` +
              `suffix to match the ${country} reference`
          ).toBe(true);
          const ok = refIds.has(id) || Object.hasOwn(knownGaps, id);
          expect(
            ok,
            `[${provider}] curated id "${id}" (for "${name}") is neither in ${file} nor in ` +
              `its knownGaps — normalize it to the reference or acknowledge it there`
          ).toBe(true);
        }
      }
    });

    it('acknowledged gaps are still gaps — drop them once upstream adds the id', () => {
      for (const [id, reason] of Object.entries(knownGaps)) {
        expect(reason && reason.length > 0, `knownGaps["${id}"] needs a reason`).toBe(true);
        expect(
          refIds.has(id),
          `known gap "${id}" is now covered upstream — remove it from knownGaps (${reason})`
        ).toBe(false);
      }
    });
  });
}
