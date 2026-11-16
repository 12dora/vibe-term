import { createMemoizedLoader } from '../lazy-load';
import { liveServicesEnabled, liveServicesStopping } from '../live-start-gates';

type TunnelManagerModule = typeof import('./manager');

let hostSetup: ((mod: TunnelManagerModule) => void) | null = null;

const loader = createMemoizedLoader(async () => {
  const mod = await import('./manager');
  hostSetup?.(mod);
  return mod;
});

let started: Promise<void> | null = null;

export function loadTunnelManager() {
  return loader.load();
}

export function peekTunnelManager() {
  return loader.peek();
}

/** 宿主注入（host env 读写等，后注册的覆盖先前的）：已加载立即生效，否则在首次加载时、start 之前生效。 */
export function configureTunnelManager(setup: (mod: TunnelManagerModule) => void): void {
  hostSetup = setup;
  const loaded = loader.peek();
  if (loaded) setup(loaded);
}

/** start 不幂等（autoStart 会再拉一次 cloudflared），这里只跑一次；停机开始后加载完成的不再 start。 */
export function startTunnelManager(): Promise<void> {
  started ??= loadTunnelManager()
    .then(async ({ tunnelManager }) => {
      if (!liveServicesStopping()) await tunnelManager.start();
    })
    .catch((err: unknown) => {
      started = null;
      throw err;
    });
  return started;
}

/** REST 首次触达：live 模式下补上开机时跳过的 start。 */
export async function ensureTunnelManager() {
  if (liveServicesEnabled()) await startTunnelManager();
  return (await loadTunnelManager()).tunnelManager;
}

/** 未加载即没有本进程托管的隧道，公网地址只可能来自持久化配置（由调用方另行读取）。 */
export function peekTunnelPublicUrl(): string | null {
  return peekTunnelManager()?.tunnelManager.status().process.publicUrl ?? null;
}

/** 先等在途的加载与 start 落定，再 stop：否则 start 可能在 stop 之后才拉起 cloudflared。 */
export async function stopTunnelManagerIfLoaded() {
  const inFlight = started;
  started = null;
  await inFlight?.catch(() => undefined);
  const loaded = await loader.settled();
  if (loaded) await loaded.tunnelManager.stop();
}

export function resetTunnelManagerLoaderForTests() {
  loader.reset();
  started = null;
  hostSetup = null;
}
