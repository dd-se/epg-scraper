import { normalizeLanguageTag } from './model.js';
import * as hurriyet from './providers/hurriyet.js';
import * as trt from './providers/trt.js';
import * as mynet from './providers/mynet.js';
import * as tvplus from './providers/tvplus.js';
import * as beinsports from './providers/beinsports.js';
import * as digiturkburada from './providers/digiturkburada.js';
import * as sporekrani from './providers/sporekrani.js';
import * as sporekraniapi from './providers/sporekraniapi.js';
import * as tivibu from './providers/tivibu.js';
import * as idmantv from './providers/idmantv.js';
import * as tvnu from './providers/tvnu.js';

export const REFERENCE_SNAPSHOTS = [
  {
    country: 'TR',
    suffix: '.tr',
    file: 'test/fixtures/epgshare01/reference.json',
    url: 'https://epgshare01.online/epgshare01/epg_ripper_TR1.xml.gz',
  },
  {
    country: 'SE',
    suffix: '.se',
    file: 'test/fixtures/epgshare01/reference-se.json',
    url: 'https://epgshare01.online/epgshare01/epg_ripper_SE1.xml.gz',
  },
];

export const PROVIDER_CATALOG = [
  {
    id: 'hurriyet',
    name: 'Hürriyet TV Rehberi',
    module: hurriyet,
    referenceCountry: 'TR',
    ci: { enabled: true, args: [], order: 10 },
    sports: { live: false },
  },
  {
    // TRT's own yayın akışı pages: 11 channels, one page per channel-day.
    // Authoritative for every TRT channel, which is why the merged
    // `hurriyetTrt` feed lists it first.
    id: 'trt',
    name: 'TRT Yayın Akışı (TRT 1/2/Haber/Spor/Belgesel/Çocuk/Müzik/Türk/Avaz/Kurdî)',
    module: trt,
    referenceCountry: 'TR',
    ci: { enabled: true, args: ['--delay-ms', '300'], order: 15 },
    sports: { live: false },
  },
  {
    id: 'mynet',
    name: 'Mynet TV Rehberi',
    module: mynet,
    referenceCountry: 'TR',
    ci: { enabled: true, args: ['--days-forward', '2', '--delay-ms', '500'], order: 20 },
    sports: { live: false },
  },
  {
    id: 'tvplus',
    name: 'TV+ (Turkcell) Yayın Akışı',
    module: tvplus,
    referenceCountry: 'TR',
    browserCompatible: false,
    ci: { enabled: true, args: ['--days-forward', '2'], order: 30 },
    sports: { live: true },
  },
  {
    id: 'beinsports',
    name: 'beIN Sports Yayın Akışı',
    module: beinsports,
    referenceCountry: 'TR',
    ci: {
      enabled: false,
      order: 40,
      reason: 'DigiturkBurada carries beIN 1-4 with full-day schedules.',
      coveredBy: ['digiturkburada'],
    },
    sports: { live: true },
  },
  {
    id: 'digiturkburada',
    name: 'DigiturkBurada Yayın Akışı (beIN Sports 1-5 / Max / GS TV)',
    module: digiturkburada,
    referenceCountry: 'TR',
    browserCompatible: false,
    ci: { enabled: true, args: ['--days-forward', '2'], order: 50 },
    sports: { live: true },
  },
  {
    id: 'sporekrani',
    name: 'Spor Ekranı Yayın Akışı (tabii spor 1-8 / S Sport Plus)',
    module: sporekrani,
    referenceCountry: 'TR',
    ci: {
      enabled: false,
      order: 60,
      reason: 'sporekraniapi matches starts and bounds the final stop to the requested day.',
      coveredBy: ['sporekraniapi'],
    },
    sports: { live: false },
  },
  {
    id: 'sporekraniapi',
    name: 'Spor Ekranı API (tabii spor 1-8 / S Sport Plus)',
    module: sporekraniapi,
    referenceCountry: 'TR',
    browserCompatible: false,
    ci: { enabled: true, args: [], order: 65 },
    sports: { live: true },
  },
  {
    id: 'tivibu',
    name: 'Tivibu Yayın Akışı (Tivibu Spor 1-4)',
    module: tivibu,
    referenceCountry: 'TR',
    browserCompatible: false,
    ci: { enabled: true, args: [], order: 70 },
    sports: { live: true },
  },
  {
    id: 'idmantv',
    name: 'iDMAN TV (İdman Televiziyası) Həftəlik Proqram',
    module: idmantv,
    timeZone: 'Asia/Baku',
    referenceCountry: 'TR',
    ci: { enabled: true, args: [], order: 90 },
    sports: { live: true },
  },
  {
    id: 'tvnu',
    name: 'TV.nu Yayın Akışı (İsveç ulusal + Nordic kanalları)',
    module: tvnu,
    country: 'SE',
    language: 'sv',
    timeZone: 'Europe/Stockholm',
    referenceCountry: 'SE',
    ci: { enabled: true, args: ['--days-forward', '2', '--delay-ms', '400'], order: 80 },
    sports: { live: false },
  },
];

export const COMMAND_PROFILES = {
  // The public general-interest feed: TRT's own schedules first (it owns every
  // TRT channel), then Hürriyet for the ~30 channels TRT does not serve.
  // `exclusiveChannels` drops Hürriyet's duplicate TRT slots entirely, so the
  // TRT channels are not split between two feeds' slot boundaries.
  hurriyetTrt: {
    providerIds: ['trt', 'hurriyet'],
    exclusiveChannels: true,
    args: ['--delay-ms', '300'],
    output: 'epg_hurriyet_trt_merged_TR.xml.gz',
  },
  // The published sports merge, rebuilt in CI from the per-provider guides the
  // scrape job already produced (an offline merge, so the providers are never
  // hit twice). `sports.live` minus the SSR baseline `sporekrani`, which the
  // day-scoped `sporekraniapi` adapter covers instead.
  sports: {
    providerIds: ciSportsProviders().map((entry) => entry.id),
    args: [],
    output: 'epg_sports_merged_TR.xml.gz',
  },
  mynetSports: {
    providerIds: ['mynet', ...PROVIDER_CATALOG.filter((entry) => entry.sports.live).map((entry) => entry.id)],
    aliasMap: 'aliases.mynet-sports.json',
    args: ['--days-forward', '2', '--delay-ms', '300'],
    output: 'epg_mynet_sports_merged_TR.xml.gz',
  },
};

export function toProviderRegistration(entry) {
  return {
    id: entry.id,
    name: entry.name,
    baseUrl: entry.module.BASE_URL,
    country: entry.country || 'TR',
    language: entry.language || 'tr',
    timeZone: entry.timeZone || 'Europe/Istanbul',
    requiresBrowser: entry.requiresBrowser === true,
    ...(entry.browserCompatible === false ? { browserCompatible: false } : {}),
    scrape: entry.module.scrape,
  };
}

export function resolveProviderContext(provider) {
  const country = provider?.country;
  const timeZone = provider?.timeZone;
  let validTimeZone = 'Europe/Istanbul';
  if (typeof timeZone === 'string' && timeZone.trim()) {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: timeZone.trim() });
      validTimeZone = timeZone.trim();
    } catch {
      validTimeZone = 'Europe/Istanbul';
    }
  }
  return {
    country:
      typeof country === 'string' && /^[A-Za-z]{2}$/.test(country.trim())
        ? country.trim().toUpperCase()
        : 'TR',
    language: normalizeLanguageTag(provider?.language) || 'tr',
    timeZone: validTimeZone,
  };
}

export function dailyCiMatrix() {
  return PROVIDER_CATALOG.filter((entry) => entry.ci.enabled)
    .sort((a, b) => a.ci.order - b.ci.order)
    .map((entry) => ({
      provider: entry.id,
      args: entry.ci.args.join(' '),
    }));
}

export function liveSportsProviders() {
  return PROVIDER_CATALOG.filter((entry) => entry.sports.live);
}

export function ciSportsProviders() {
  return liveSportsProviders().filter((entry) => entry.ci.enabled);
}

// The per-provider guide files a merge profile consumes, in precedence order
// (first provider wins conflicts). Shared by `npm run merge:<profile>` and the
// CI merge jobs so a merged feed's input list lives in exactly one place.
export function profileInputFiles(profile) {
  return (profile?.providerIds || []).map((id) => {
    const entry = PROVIDER_CATALOG.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Merge profile references unknown provider: ${id}`);
    return `epg_${id}_${resolveProviderContext(entry).country}.xml.gz`;
  });
}

export function curatedChannelIds(entry) {
  const map = entry?.module?.CHANNEL_ID_MAP;
  if (!map || typeof map !== 'object') {
    throw new Error(`Provider ${entry?.id || '<unknown>'} must export CHANNEL_ID_MAP`);
  }
  const ids = [...new Set(Object.values(map).filter((id) => typeof id === 'string'))].sort();
  if (ids.length === 0) {
    throw new Error(`Provider ${entry.id} CHANNEL_ID_MAP must contain at least one id`);
  }
  return ids;
}
