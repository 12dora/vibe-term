import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import journal from '../../drizzle/meta/_journal.json';

const MIGRATIONS = [
  '0000_busy_starjammers.sql',
  '0001_lowly_the_twelve.sql',
  '0002_broad_vengeance.sql',
  '0003_glamorous_lizard.sql',
  '0004_smiling_layla_miller.sql',
  '0005_fancy_boom_boom.sql',
  '0006_bitter_bushwacker.sql',
  '0007_fearless_pestilence.sql',
  '0008_perfect_ozymandias.sql',
  '0009_lying_lethal_legion.sql',
  '0010_lucky_kabuki.sql',
  '0011_stormy_sauron.sql',
  '0012_naive_lizard.sql',
  '0013_bored_blindfold.sql',
  '0014_lucky_killraven.sql',
  '0015_wise_mongu.sql',
  '0016_cheerful_scarecrow.sql',
  '0017_fixed_greymalkin.sql',
  '0018_agent_query_indexes.sql',
  '0019_hub_auth.sql',
  '0020_node_identity_user.sql',
  '0021_tls_config.sql',
  '0022_hub_trust.sql',
  '0023_acme_account_directory.sql',
  '0024_narrow_tomas.sql',
  '0025_flat_device_groups.sql',
  '0026_acoustic_roughhouse.sql',
  '0027_tunnel_config.sql',
  '0028_magical_doctor_doom.sql',
  '0029_tunnel_access.sql',
  '0030_tunnel_access_bypass.sql',
  '0031_luxuriant_colossus.sql',
  '0032_mesh_hubs.sql',
  '0033_hub_authorizations.sql',
  '0034_hub_role_transitions.sql',
  '0035_tunnel_access_mode.sql',
  '0036_rotate_root_keep.sql',
] as const;

export interface MaterializedMigrations {
  path: string;
  cleanup: () => void;
}

function embeddedFile(name: string): Blob {
  const dot = name.lastIndexOf('.');
  const stem = name.slice(0, dot);
  const extension = name.slice(dot);
  const matches = (Bun.embeddedFiles as ReadonlyArray<Blob & { name: string }>).filter(
    (file) =>
      file.name === name || (file.name.startsWith(`${stem}-`) && file.name.endsWith(extension))
  );
  if (matches.length !== 1) {
    const names = (Bun.embeddedFiles as ReadonlyArray<Blob & { name: string }>).map(
      (file) => file.name
    );
    throw new Error(
      `managed embedded asset ${name}: expected one match, got ${matches.length}; embedded=${names.join(',')}`
    );
  }
  const match = matches[0];
  if (!match) {
    throw new Error(`managed embedded asset ${name}: match disappeared`);
  }
  return match;
}

export async function materializeManagedMigrations(): Promise<MaterializedMigrations> {
  const path = join(
    process.env.TMPDIR || tmpdir(),
    `tmex-managed-migrations-${process.pid}-${crypto.randomUUID()}`
  );
  mkdirSync(join(path, 'meta'), { recursive: true, mode: 0o700 });
  await Bun.write(join(path, 'meta', '_journal.json'), `${JSON.stringify(journal)}\n`);
  for (const name of MIGRATIONS) {
    await Bun.write(join(path, name), embeddedFile(name));
  }
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}
