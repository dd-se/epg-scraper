import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadProviders } from '../src/providers/index.js';
import {
  COMMAND_PROFILES,
  PROVIDER_CATALOG,
  REFERENCE_SNAPSHOTS,
  ciSportsProviders,
  curatedChannelIds,
  dailyCiMatrix,
  liveSportsProviders,
  profileInputFiles,
  resolveProviderContext,
  toProviderRegistration,
} from '../src/provider-catalog.js';

const EXPECTED_IDS = [
  'hurriyet',
  'trt',
  'mynet',
  'tvplus',
  'beinsports',
  'digiturkburada',
  'sporekrani',
  'sporekraniapi',
  'tivibu',
  'idmantv',
  'tvnu',
];

describe('provider operational inventory', () => {
  it('owns provider registration order and effective metadata', () => {
    expect(PROVIDER_CATALOG.map((entry) => entry.id)).toEqual(EXPECTED_IDS);
    expect(loadProviders().map((provider) => provider.id)).toEqual(EXPECTED_IDS);

    for (const entry of PROVIDER_CATALOG) {
      const registration = toProviderRegistration(entry);
      expect(registration.id).toBe(entry.id);
      expect(registration.baseUrl).toBe(entry.module.BASE_URL);
      expect(registration.scrape).toBe(entry.module.scrape);
    }

    expect(resolveProviderContext(PROVIDER_CATALOG.find((entry) => entry.id === 'tvnu'))).toEqual({
      country: 'SE',
      language: 'sv',
      timeZone: 'Europe/Stockholm',
    });
    expect(resolveProviderContext(PROVIDER_CATALOG.find((entry) => entry.id === 'idmantv'))).toEqual({
      country: 'TR',
      language: 'tr',
      timeZone: 'Asia/Baku',
    });
    expect(resolveProviderContext(PROVIDER_CATALOG.find((entry) => entry.id === 'hurriyet'))).toEqual({
      country: 'TR',
      language: 'tr',
      timeZone: 'Europe/Istanbul',
    });
  });

  it('fails closed when a catalog entry has no curated channel map', () => {
    expect(() => curatedChannelIds({ id: 'broken', module: {} })).toThrow(/CHANNEL_ID_MAP/);
    expect(() => curatedChannelIds({ id: 'empty', module: { CHANNEL_ID_MAP: {} } })).toThrow(
      /at least one id/
    );
  });

  it('makes HTTP-only provider capability explicit', () => {
    const registrations = PROVIDER_CATALOG.map(toProviderRegistration);
    expect(
      registrations.filter((provider) => provider.browserCompatible === false).map((provider) => provider.id)
    ).toEqual(['tvplus', 'digiturkburada', 'sporekraniapi', 'tivibu']);
  });

  it('owns the daily CI matrix and provider-specific arguments', () => {
    expect(dailyCiMatrix()).toEqual([
      { provider: 'hurriyet', args: '' },
      { provider: 'trt', args: '--delay-ms 300' },
      { provider: 'mynet', args: '--days-forward 2 --delay-ms 500' },
      { provider: 'tvplus', args: '--days-forward 2' },
      { provider: 'digiturkburada', args: '--days-forward 2' },
      { provider: 'sporekraniapi', args: '' },
      { provider: 'tivibu', args: '' },
      { provider: 'tvnu', args: '--days-forward 2 --delay-ms 400' },
      { provider: 'idmantv', args: '' },
    ]);
  });

  it('keeps live and CI sports profiles explicit while preserving the union', () => {
    expect(liveSportsProviders().map((entry) => entry.id)).toEqual([
      'tvplus',
      'beinsports',
      'digiturkburada',
      'sporekraniapi',
      'tivibu',
      'idmantv',
    ]);
    expect(ciSportsProviders().map((entry) => entry.id)).toEqual([
      'tvplus',
      'digiturkburada',
      'sporekraniapi',
      'tivibu',
      'idmantv',
    ]);

    const union = (entries) =>
      new Set(entries.flatMap((entry) => curatedChannelIds(entry)));
    const liveIds = union(liveSportsProviders());
    const ciIds = union(ciSportsProviders());
    expect(liveIds.size).toBe(38);
    expect(ciIds.size).toBe(38);
    for (const id of curatedChannelIds(PROVIDER_CATALOG.find((entry) => entry.id === 'beinsports'))) {
      expect(ciIds.has(id)).toBe(true);
    }
  });

  it('owns the hurriyet+trt command profile with TRT owning its channels', () => {
    const profile = COMMAND_PROFILES.hurriyetTrt;
    expect(profile).toEqual({
      // trt first: with exclusiveChannels it claims every TRT channel, so
      // Hürriyet contributes only the channels TRT does not serve.
      providerIds: ['trt', 'hurriyet'],
      exclusiveChannels: true,
      args: ['--delay-ms', '300'],
      output: 'epg_hurriyet_trt_merged_TR.xml.gz',
    });
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(packageJson.scripts['scrape:hurriyet-trt']).toBe(
      'node scripts/provider-inventory.js --run hurriyetTrt'
    );
    // The offline rebuild of the same feed is the CLI's own merge mode — no
    // wrapper script — with trt first and channels owned exclusively.
    expect(packageJson.scripts['merge:hurriyet-trt']).toBe(
      'node bin/epg-scraper.js --merge --from epg_trt_TR.xml.gz,epg_hurriyet_TR.xml.gz ' +
        '--exclusive-channels --out epg_hurriyet_trt_merged_TR.xml.gz'
    );
  });

  it('owns the sports command profile the CI sports merge rebuilds from', () => {
    expect(COMMAND_PROFILES.sports).toEqual({
      providerIds: ciSportsProviders().map((entry) => entry.id),
      args: [],
      output: 'epg_sports_merged_TR.xml.gz',
    });
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    // Order must match the profile: the CLI resolves the first file's
    // conflicting slots as the winner.
    const fromList = /--from (\S+)/.exec(packageJson.scripts['merge:sports'])[1];
    expect(fromList.split(',')).toEqual(profileInputFiles(COMMAND_PROFILES.sports));
    expect(packageJson.scripts['merge:sports']).toContain('--out epg_sports_merged_TR.xml.gz');
  });

  it('resolves every merge profile to the guide files its inputs are scraped to', () => {
    for (const [name, profile] of Object.entries(COMMAND_PROFILES)) {
      expect(profileInputFiles(profile), name).toEqual(
        profile.providerIds.map((id) => {
          const entry = PROVIDER_CATALOG.find((candidate) => candidate.id === id);
          expect(entry, `${name} references ${id}`).toBeDefined();
          return `epg_${id}_${resolveProviderContext(entry).country}.xml.gz`;
        })
      );
    }
    expect(() => profileInputFiles({ providerIds: ['no-such-provider'] })).toThrow(
      /unknown provider: no-such-provider/
    );
  });

  it('owns the special mynet-sports command profile', () => {
    const profile = COMMAND_PROFILES.mynetSports;
    expect(profile).toEqual({
      providerIds: [
        'mynet',
        'tvplus',
        'beinsports',
        'digiturkburada',
        'sporekraniapi',
        'tivibu',
        'idmantv',
      ],
      aliasMap: 'aliases.mynet-sports.json',
      args: ['--days-forward', '2', '--delay-ms', '300'],
      output: 'epg_mynet_sports_merged_TR.xml.gz',
    });
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(packageJson.scripts['scrape:mynet-sports']).toBe(
      'node scripts/provider-inventory.js --run mynetSports'
    );
  });

  it('groups reference coverage by country', () => {
    expect(REFERENCE_SNAPSHOTS.map((snapshot) => snapshot.country)).toEqual(['TR', 'SE']);
    for (const snapshot of REFERENCE_SNAPSHOTS) {
      expect(PROVIDER_CATALOG.filter((entry) => entry.referenceCountry === snapshot.country)).not.toEqual(
        []
      );
    }
  });
});
