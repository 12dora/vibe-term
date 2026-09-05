/**
 * 给任意 Promise 套超时：`ms` 内未 settle 就以 `Error(message)` 拒绝，定时器无论谁先到都会清掉，
 * 不留悬挂 timer。
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message?: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message ?? `timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
