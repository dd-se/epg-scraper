import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CHANNEL_ID_MAP as HURRIYET_MAP } from '../src/providers/hurriyet.js';
import { CHANNEL_ID_MAP as MYNET_MAP } from '../src/providers/mynet.js';
import { CHANNEL_ID_MAP as TVPLUS_MAP } from '../src/providers/tvplus.js';
import { CHANNEL_ID_MAP as BEINSPORTS_MAP } from '../src/providers/beinsports.js';
import { CHANNEL_ID_MAP as DIGITURKBURADA_MAP } from '../src/providers/digiturkburada.js';

// Enforces provider channel-id normalization against the source of truth:
// test/fixtures/epgshare01/reference.json, a vendored snapshot of the
// channel ids in epg_ripper_TR1.xml.gz.  Refresh it at least weekly with
// `npm run update:reference` — the freshness test below fails once the
// snapshot is older than 7 days so a stale reference can never drift
// silently.  No network is used here; the snapshot is the contract.

const refPath = fileURLToPath(new URL('./fixtures/epgshare01/reference.json', import.meta.url));
const ref = JSON.parse(readFileSync(refPath, 'utf8'));
const refIds = new Set(ref.channels.map((c) => c.id));
const knownGaps = ref.knownGaps || {};

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

describe('epgshare01 reference snapshot', () => {
  it('has a valid updated date', () => {
    expect(ref.updated, 'reference.json needs an "updated": "YYYY-MM-DD" field').toMatch(
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

  it('contains a sane channel-id list', () => {
    expect(ref.channels.length).toBeGreaterThan(100);
    expect(refIds.size).toBe(ref.channels.length); // no duplicates
    for (const { id } of ref.channels) {
      expect(id.endsWith('.tr'), `reference id "${id}" must carry the .tr suffix`).toBe(true);
    }
  });

  it('every curated provider id exists upstream (or is an acknowledged gap)', () => {
    const providers = [
      ['hurriyet', HURRIYET_MAP],
      ['mynet', MYNET_MAP],
      ['tvplus', TVPLUS_MAP],
      ['beinsports', BEINSPORTS_MAP],
      ['digiturkburada', DIGITURKBURADA_MAP],
    ];
    for (const [provider, map] of providers) {
      for (const [name, id] of Object.entries(map)) {
        const ok = refIds.has(id) || Object.hasOwn(knownGaps, id);
        expect(
          ok,
          `[${provider}] curated id "${id}" (for "${name}") is neither in the ` +
            `epgshare01 snapshot nor in knownGaps — normalize it to the reference ` +
            `or acknowledge it in reference.json`
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
