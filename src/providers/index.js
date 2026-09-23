import { registerProvider, listProviders } from '../registry.js';
import { PROVIDER_CATALOG, toProviderRegistration } from '../provider-catalog.js';

let loaded = false;

export function loadProviders() {
  if (!loaded) {
    for (const entry of PROVIDER_CATALOG) {
      registerProvider(toProviderRegistration(entry));
    }
    loaded = true;
  }
  return listProviders();
}
