import { spawnSync } from 'node:child_process';
import {
  COMMAND_PROFILES,
  PROVIDER_CATALOG,
  ciSportsProviders,
  curatedChannelIds,
  dailyCiMatrix,
  liveSportsProviders,
  resolveProviderContext,
} from '../src/provider-catalog.js';

const matrix = { include: dailyCiMatrix() };
const sportsInputs = ciSportsProviders().map((entry) => {
  const { country } = resolveProviderContext(entry);
  return `guides/epg_${entry.id}_${country}.xml.gz`;
});
const unionSize = (entries) =>
  new Set(entries.flatMap((entry) => curatedChannelIds(entry))).size;

const runIndex = process.argv.indexOf('--run');
if (runIndex !== -1) {
  const profileName = process.argv[runIndex + 1];
  const profile = COMMAND_PROFILES[profileName];
  if (!profile) throw new Error(`Unknown provider profile: ${profileName || '<missing>'}`);
  const args = [
    'bin/epg-scraper.js',
    '--provider',
    profile.providerIds.join(','),
    '--merge',
    '--alias-map',
    profile.aliasMap,
    ...profile.args,
    '--out',
    profile.output,
  ];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status == null ? 1 : result.status;
} else if (process.argv.includes('--github-output')) {
  console.log(`matrix=${JSON.stringify(matrix)}`);
  console.log(`sports_inputs=${JSON.stringify(sportsInputs)}`);
} else {
  console.log(
    JSON.stringify(
      {
        providers: PROVIDER_CATALOG.map((entry) => entry.id),
        matrix,
        sportsInputs,
        counts: {
          providers: PROVIDER_CATALOG.length,
          dailyCi: matrix.include.length,
          liveSportsChannels: unionSize(liveSportsProviders()),
          ciSportsChannels: unionSize(ciSportsProviders()),
        },
      },
      null,
      2
    )
  );
}
