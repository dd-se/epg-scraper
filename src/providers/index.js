// Provider registry. Adding a provider is one file in this directory plus one
// registration line here; the CLI then accepts --provider <id>.

import { registerProvider, listProviders } from '../registry.js';
import * as hurriyet from './hurriyet.js';
import * as mynet from './mynet.js';

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
    loaded = true;
  }
  return listProviders();
}
