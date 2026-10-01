import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PROVIDER_CATALOG,
  REFERENCE_SNAPSHOTS,
  curatedChannelIds,
} from '../src/provider-catalog.js';
import { refresh } from '../scripts/update-reference-ids.js';

// Enforces provider channel-id normalization against the source of truth: the
// vendored epgshare01 per-country snapshots under test/fixtures/epgshare01/.
// Each snapshot is the contract for the providers targeting that country —
// reference.json (epg_ripper_TR1.xml.gz) for the Turkish providers,
// reference-se.json (epg_ripper_SE1.xml.gz) for tvnu — and maps ids to the
// `.tr` / `.se` suffix that country's guide uses.
//
// Freshness: rather than failing on a stale date, this suite RE-VENDORS the
// snapshot itself.  We do not control when upstream publishes, so a date-based
// hard failure was guaranteed to resurface on a schedule nobody chose while
// telling us nothing about actual drift.  Refreshing pulls the real upstream
// guide, so the id assertions below still run against current data and a
// genuinely renamed upstream id is still caught.  Set
// EPG_REFERENCE_NO_REFRESH=1 to make staleness a hard failure again instead.
//
// The refresh is the only network access in the suite, it happens at most once
// per country per run, and it only ever touches the vendored fixture itself.
// Everything else here reads the file.

const SNAPSHOTS = REFERENCE_SNAPSHOTS.map((snapshot) => ({
  file: snapshot.file.split('/').at(-1),
  country: snapshot.country,
  suffix: snapshot.suffix,
  url: snapshot.url,
  providers: PROVIDER_CATALOG.filter(
    (entry) => entry.referenceCountry === snapshot.country
  ).map((entry) => [entry.id, curatedChannelIds(entry)]),
}));

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

for (const { file, country, suffix, url, providers } of SNAPSHOTS) {
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

    it('is at most 7 days old, re-vendoring upstream when it is not', async () => {
      const ageMs = () => Date.now() - Date.parse(`${ref.updated}T00:00:00Z`);
      if (ageMs() <= MAX_AGE_MS) return; // fresh enough, nothing to do

      if (process.env.EPG_REFERENCE_NO_REFRESH === '1') {
        expect(
          ageMs(),
          `reference snapshot is ${Math.floor(ageMs() / 86400000)} day(s) old ` +
            `(updated: ${ref.updated}) and EPG_REFERENCE_NO_REFRESH=1 forbids re-vendoring. ` +
            `Run npm run update:reference.`
        ).toBeLessThanOrEqual(MAX_AGE_MS);
        return;
      }

      // Re-vendor the real upstream guide in place.  `ref`, `refIds` and
      // `knownGaps` are updated so the curated-id and knownGaps assertions
      // below evaluate against the refreshed data rather than whatever
      // happened to be on disk when the run started.
      //
      // A failed download is reported as a plain staleness failure with the
      // cause attached, not a raw fetch/gunzip stack: offline and flaky-CDN
      // are the common cases and neither is a defect in this repo.
      let result;
      try {
        result = await refresh({ country, file, url }, { log: (line) => console.log(`  ${line}`) });
      } catch (error) {
        expect.unreachable(
          `could not re-vendor ${file} from ${url} (${error && error.message ? error.message : error}). ` +
            `It is ${Math.floor(ageMs() / 86400000)} day(s) old. Re-run with network access, or ` +
            `set EPG_REFERENCE_NO_REFRESH=1 to skip the freshness check entirely.`
        );
        return;
      }
      const updated = JSON.parse(readFileSync(refPath, 'utf8'));
      ref.updated = updated.updated;
      ref.channels = updated.channels;
      ref.channelCount = updated.channelCount;
      refIds.clear();
      for (const { id } of updated.channels) refIds.add(id);
      Object.assign(knownGaps, updated.knownGaps || {});

      expect(ageMs(), `reference refresh did not stamp a current date (still ${ref.updated})`)
        .toBeLessThanOrEqual(MAX_AGE_MS);
      expect(result.channelCount).toBeGreaterThan(100);
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
      for (const [provider, ids] of providers) {
        for (const id of ids) {
          expect(
            id.endsWith(suffix),
            `[${provider}] curated id "${id}" must carry the ${suffix} ` +
              `suffix to match the ${country} reference`
          ).toBe(true);
          const ok = refIds.has(id) || Object.hasOwn(knownGaps, id);
          expect(
            ok,
            `[${provider}] curated id "${id}" is neither in ${file} nor in ` +
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
