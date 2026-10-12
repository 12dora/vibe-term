import {
  type RelayJoinToken,
  type RelayJoinTokenEntry,
  normalizeRelayUrl,
} from '../../../shared/src/relay';
import { JoinError } from './join-error';

/** join 串里的中继表就是 failover 顺序；命令行给的 url 只能用来把其中一条提前。 */
export function orderRelayEntries(
  decoded: RelayJoinToken,
  preferredRaw: string,
  warn?: (message: string) => void
): RelayJoinTokenEntry[] {
  if (!preferredRaw) return [...decoded.relays];
  let preferred: string;
  try {
    preferred = normalizeRelayUrl(preferredRaw);
  } catch (error) {
    throw new JoinError(
      'invalid_url',
      error instanceof Error ? error.message : 'invalid relay url'
    );
  }
  const match = decoded.relays.find((entry) => entry.url === preferred);
  if (!match) {
    (warn ?? console.warn)(
      `relay url is not listed in the join token and will be ignored: ${preferred}`
    );
    return [...decoded.relays];
  }
  return [match, ...decoded.relays.filter((entry) => entry.url !== preferred)];
}
