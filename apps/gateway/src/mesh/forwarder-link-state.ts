import { LinkError, type LinkSession } from '@vibeterm/shared/link';

/** `closed` 已兑现时为真。没有 `closed` 的测试替身视为还活着。 */
export async function linkSessionClosed(session: LinkSession): Promise<boolean> {
  const closed = session.closed;
  if (!closed || typeof closed.then !== 'function') return false;
  let settled = false;
  const done = closed.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.race([done, Promise.resolve()]);
  return settled;
}

/** WP-A 已把会话标死时，不要再在上面开流。 */
export async function rejectClosedLink(session: LinkSession): Promise<void> {
  if (await linkSessionClosed(session)) throw new LinkError('closed', 'link-closed');
}
