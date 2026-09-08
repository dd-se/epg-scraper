// Provider registry. Adding a provider is one file in this directory plus one
// registration line here; the CLI then accepts --provider <id>.

import { registerProvider, listProviders } from '../registry.js';
import * as hurriyet from './hurriyet.js';
import * as mynet from './mynet.js';
import * as tvplus from './tvplus.js';
import * as beinsports from './beinsports.js';
import * as digiturkburada from './digiturkburada.js';

let loaded = false;

export function loadProviders() {
  if (!loaded) {
    registerProvider({
      id: 'hurriyet',
      name: 'Hürriyet TV Rehberi',
      baseUrl: hurriyet.BASE_URL,
      scrape: hurriyet.scrape,
    });
    registerProvider({
      id: 'mynet',
      name: 'Mynet TV Rehberi',
      baseUrl: mynet.BASE_URL,
      scrape: mynet.scrape,
    });
    registerProvider({
      id: 'tvplus',
      name: 'TV+ (Turkcell) Yayın Akışı',
      baseUrl: tvplus.BASE_URL,
      // Plain-HTTP JSON API only — the Playwright fetcher cannot POST.
      scrape: tvplus.scrape,
    });
    registerProvider({
      id: 'beinsports',
      name: 'beIN Sports Yayın Akışı',
      baseUrl: beinsports.BASE_URL,
      scrape: beinsports.scrape,
    });
    registerProvider({
      id: 'digiturkburada',
      name: 'DigiturkBurada Yayın Akışı (beIN Sports 5 / Max / GS TV)',
      baseUrl: digiturkburada.BASE_URL,
      // Plain-HTTP form POSTs only — the Playwright fetcher cannot POST.
      scrape: digiturkburada.scrape,
    });
    loaded = true;
  }
  return listProviders();
}
