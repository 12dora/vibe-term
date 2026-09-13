import type { Client } from 'ssh2';
import { loadSsh2 } from './ssh2-lazy';

export async function createSsh2Client(): Promise<Client> {
  const { Client } = await loadSsh2();
  return new Client();
}
