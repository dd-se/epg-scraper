// Provider registry. A provider is a plain object:
//
// {
//   id: string              — unique, used on the CLI (--provider <id>)
//   name: string            — human label
//   baseUrl: string         — informational
//   requiresBrowser?: boolean — if true, CLI auto-launches headless Chromium
//                               via Playwright for JS-rendered pages.
//   daysBack?: number       — days before today to include (default 0)
//   daysForward?: number    — days after today to include (default 6)
//   async scrape({ dates, fetchImpl, log }) -> { channels, programmes }
// }
//
// `dates` is an ordered array of YYYY-MM-DD strings the provider should cover
// (today + daysForward by default, so a Monday run yields Mon..Sun).
// `fetchImpl` is injected by the CLI — either the default HTTP fetch or a
// Playwright-backed browser fetcher (when --browser or requiresBrowser).
// Everything else (URLs, day slugs, channel-id maps) is provider-internal.

const providers = new Map();

export function registerProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('provider must be an object');
  }
  if (!provider.id || typeof provider.id !== 'string') {
    throw new Error('provider.id is required');
  }
  if (typeof provider.scrape !== 'function') {
    throw new Error(`provider "${provider.id}" must implement scrape()`);
  }
  providers.set(provider.id, provider);
  return provider;
}

export function getProvider(id) {
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(
      `Unknown provider "${id}". Registered: ${[...providers.keys()].join(', ') || '(none)'}`
    );
  }
  return provider;
}

export function listProviders() {
  return [...providers.values()];
}

// Ordered list of YYYY-MM-DD strings for the run window, computed from a
// reference date (default: now, Istanbul wall time).
export function buildDateRange({ referenceDate = new Date(), daysBack = 0, daysForward = 6, timeZone = 'Europe/Istanbul' } = {}) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const anchor = fmt.format(referenceDate); // en-CA gives YYYY-MM-DD
  const base = new Date(`${anchor}T12:00:00Z`);
  const dates = [];
  for (let offset = -daysBack; offset <= daysForward; offset++) {
    const day = new Date(base.getTime() + offset * 86400000);
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}
