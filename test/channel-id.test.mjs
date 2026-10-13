// The channel-id format: Turkish ids are ASCII, carry no separators, keep their
// case and end in `.tr`; Swedish ids pass through untouched.  These tests are
// the contract now that no upstream guide is used as a reference — the curated
// provider maps ARE the database, so nothing but this file guards their shape.
import { describe, it, expect } from 'vitest';
import { channelIdFromName, foldChannelId, isCanonicalChannelId } from '../src/slug.js';
import { createGuideResult, validateGuideResult } from '../src/model.js';
import { generateXmltv } from '../src/xmltv.js';
import { PROVIDER_CATALOG, curatedChannelIds } from '../src/provider-catalog.js';
import { CHANNEL_CATALOG, CATALOG_EPG_GAPS } from '../src/m3u/channels.js';

describe('foldChannelId', () => {
  it('folds Turkish diacritics and removes separators', () => {
    expect(foldChannelId('TRT.ÇOCUK.tr')).toBe('TRTCOCUK.tr');
    expect(foldChannelId('CNN.TÜRK.tr')).toBe('CNNTURK.tr');
    expect(foldChannelId('TRT.KURDİ.tr')).toBe('TRTKURDI.tr');
    expect(foldChannelId('TRT.MÜZİK.tr')).toBe('TRTMUZIK.tr');
    expect(foldChannelId('HABERTÜRK.tr')).toBe('HABERTURK.tr');
    expect(foldChannelId('SİNEMA.TV.HD.tr')).toBe('SINEMATVHD.tr');
    expect(foldChannelId('FENERBAHÇE.TV.tr')).toBe('FENERBAHCETV.tr');
  });

  it('keeps the case of ids that are not fully uppercase', () => {
    expect(foldChannelId('beIN.SPORTS.1.tr')).toBe('beINSPORTS1.tr');
    expect(foldChannelId('TV8.5.tr')).toBe('TV85.tr');
  });

  it('is idempotent', () => {
    for (const id of ['TRT.ÇOCUK.tr', 'beIN.SPORTS.MAX.1.tr', '360.tr', 'A.HABER.tr']) {
      const once = foldChannelId(id);
      expect(foldChannelId(once)).toBe(once);
    }
  });

  it('leaves Swedish ids untouched, source tag and punctuation included', () => {
    expect(foldChannelId('[SVT1HD].SVT1.HD.se')).toBe('[SVT1HD].SVT1.HD.se');
    expect(foldChannelId('[COMSVHD].SVTB/SVT24.HD.se')).toBe('[COMSVHD].SVTB/SVT24.HD.se');
    expect(foldChannelId('SVT.BARN.se')).toBe('SVT.BARN.se');
  });

  it('passes non-strings and unrelated ids through untouched', () => {
    for (const value of [null, undefined, 42, {}, [], '', 'ATV', 'TLC.se']) {
      expect(foldChannelId(value)).toBe(value);
    }
  });

  it('never rewrites a URL that happens to end in .tr', () => {
    for (const url of [
      'https://www.hurriyet.com.tr/tv-rehberi/',
      'https://cdn.example.com.tr/logo.png',
    ]) {
      expect(foldChannelId(url), url).toBe(url);
    }
  });
});

describe('isCanonicalChannelId', () => {
  it('accepts only final-form Turkish ids and any Swedish id', () => {
    for (const id of ['ATV.tr', 'TRTCOCUK.tr', 'beINSPORTS1.tr', 'SSPORT1.tr', '360.tr']) {
      expect(isCanonicalChannelId(id), id).toBe(true);
    }
    expect(isCanonicalChannelId('[SVT1HD].SVT1.HD.se')).toBe(true);
    for (const id of ['TRT.ÇOCUK.tr', 'KANAL.D.tr', 'ATV', 'ATV.', '.tr', 'A.B.tr', 'x"])("onload="y']) {
      expect(isCanonicalChannelId(id), id).toBe(false);
    }
    expect(isCanonicalChannelId('')).toBe(false);
    expect(isCanonicalChannelId(null)).toBe(false);
  });
});

describe('channelIdFromName', () => {
  it('still produces a dotted fallback that the seam folds into final form', () => {
    expect(channelIdFromName('KANAL D')).toBe('KANAL.D.tr');
    expect(foldChannelId(channelIdFromName('Yeni Kanal 9'))).toBe('YENIKANAL9.tr');
    expect(channelIdFromName('SVT Barn', 'se')).toBe('SVT.BARN.se');
  });
});

describe('the curated provider maps are the database', () => {
  const curated = PROVIDER_CATALOG.flatMap((entry) =>
    curatedChannelIds(entry).map((id) => [entry.id, id])
  );

  it('curates at least one id per provider', () => {
    for (const entry of PROVIDER_CATALOG) {
      expect(curatedChannelIds(entry).length, entry.id).toBeGreaterThan(0);
    }
    expect(curated.length).toBeGreaterThan(150);
  });

  it('holds only canonical ids', () => {
    for (const [provider, id] of curated) {
      expect(isCanonicalChannelId(id), `${provider}: ${id}`).toBe(true);
    }
  });

  it('never folds two different ids onto one (case-insensitively)', () => {
    const byFold = new Map();
    for (const [provider, id] of curated) {
      const key = foldChannelId(id).toLowerCase();
      const seen = byFold.get(key);
      if (seen && seen.id !== id) {
        // The same channel curated by two providers is fine; two spellings of
        // one channel folding together is not.
        throw new Error(`"${seen.id}" (${seen.provider}) and "${id}" (${provider}) both fold to ${key}`);
      }
      if (!seen) byFold.set(key, { id, provider });
    }
  });

  it('gives the Turkish sports feeds distinct ids', () => {
    const sports = new Set(
      PROVIDER_CATALOG.filter((entry) => entry.sports?.live)
        .flatMap((entry) => curatedChannelIds(entry))
    );
    expect(sports.size).toBe(38);
  });
});

// The playlist builder keeps its own lowercase `tvg-id` namespace, deliberately
// not aligned with the guide ids — but a viewer joins the two by id, so every
// catalog id needs a guide counterpart (compared folded and case-insensitively,
// the way a consumer folds both sides).  Channels no guide serves are listed in
// `CATALOG_EPG_GAPS` with a reason, so the exception is a decision on record.
//
// The comparison is over *curated* ids, so a channel a provider serves only
// through the generic slug still reads as a gap.  Two entries currently do
// (Baby TV, Discovery Channel, both served by mynet); see
// `docs/research/channels-without-guides.md` for the evidence and the fix.
describe('the playlist catalog and the guides agree on channel identity', () => {
  const guideIds = new Set(
    PROVIDER_CATALOG.flatMap((entry) => curatedChannelIds(entry)).map((id) => foldChannelId(id).toLowerCase())
  );
  const catalogIds = CHANNEL_CATALOG.map((item) => item.id);
  const gaps = CATALOG_EPG_GAPS.map((gap) => gap.id);

  it('gives every catalog channel a guide counterpart or a recorded reason', () => {
    const orphans = catalogIds.filter(
      (id) => !guideIds.has(foldChannelId(id).toLowerCase()) && !gaps.includes(id)
    );
    expect(orphans).toEqual([]);
  });

  it('records a reason for every gap', () => {
    for (const gap of CATALOG_EPG_GAPS) {
      expect(typeof gap.id, JSON.stringify(gap)).toBe('string');
      expect(typeof gap.reason, gap.id).toBe('string');
      expect(gap.reason.trim().length, gap.id).toBeGreaterThan(10);
    }
  });

  it('never excuses a channel a guide does serve', () => {
    // Give one of these channels a real guide id and its entry has to go with
    // it, or this list rots into a blanket excuse.
    const stale = gaps.filter((id) => guideIds.has(foldChannelId(id).toLowerCase()));
    expect(stale).toEqual([]);
  });

  it('never excuses a channel the catalog no longer carries', () => {
    const unknown = gaps.filter((id) => !catalogIds.includes(id));
    expect(unknown).toEqual([]);
  });

  it('keeps the gap list free of duplicates', () => {
    expect(new Set(gaps).size).toBe(gaps.length);
  });
});

describe('the guide-result seam', () => {
  it('folds channel ids and keeps programme references pointing at them', () => {
    const result = createGuideResult({
      channels: [
        { id: 'TRT.ÇOCUK.tr', name: 'TRT Çocuk' },
        { id: 'beIN.SPORTS.1.tr', name: 'beIN Sports 1' },
      ],
      programmes: [
        {
          channel: 'TRT.ÇOCUK.tr',
          start: '2026-09-07T15:00:00+03:00',
          stop: '2026-09-07T16:00:00+03:00',
          title: 'Çocuk',
        },
        {
          channel: 'beIN.SPORTS.1.tr',
          start: '2026-09-07T16:00:00+03:00',
          stop: '2026-09-07T17:00:00+03:00',
          title: 'Maç',
        },
      ],
    });
    // A programme naming the pre-fold spelling still resolves to the emitted
    // id, so folding orphans nothing.
    expect(result.channels.map((c) => c.id)).toEqual(['TRTCOCUK.tr', 'beINSPORTS1.tr']);
    expect(result.programmes.map((p) => p.channel)).toEqual([
      'TRTCOCUK.tr',
      'beINSPORTS1.tr',
    ]);
    expect(result.failures).toBe(0);
  });

  it('refuses to write a non-canonical id, and the writer surfaces it', () => {
    const channels = [{ id: 'KANAL.D.tr', name: 'KANAL D' }];
    expect(() => validateGuideResult({ channels, programmes: [], lang: 'tr' })).toThrow(
      /is not in canonical form/
    );
    // The writer runs the same check as its final defense...
    expect(() => generateXmltv({ channels, programmes: [] })).toThrow(
      /is not in canonical form/
    );
    // ...but a guide that came through the seam is already folded, so it writes.
    const folded = createGuideResult({ channels, programmes: [] });
    expect(generateXmltv(folded)).toContain('<channel id="KANALD.tr">');
  });

  it('keeps Swedish ids and their programmes intact', () => {
    const result = createGuideResult({
      channels: [{ id: '[SVT1HD].SVT1.HD.se', name: 'SVT 1' }],
      programmes: [
        {
          channel: '[SVT1HD].SVT1.HD.se',
          start: '2026-09-07T15:00:00+02:00',
          stop: '2026-09-07T16:00:00+02:00',
          title: 'Rapport',
        },
      ],
      language: 'sv',
    });
    expect(result.channels[0].id).toBe('[SVT1HD].SVT1.HD.se');
    expect(result.programmes[0].channel).toBe('[SVT1HD].SVT1.HD.se');
    expect(generateXmltv(result)).toContain('<channel id="[SVT1HD].SVT1.HD.se">');
  });
});