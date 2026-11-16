import { createMemoizedLoader } from '../lazy-load';

const loader = createMemoizedLoader(async () => {
  const [hooks, context] = await Promise.all([import('./runtime-hooks'), import('./context')]);
  context.registerMessagingRuntime(hooks.createMessagingRuntimeHooks());
  return { hooks, context };
});

let armed = false;

/** live 启动后才允许注册消息运行时钩子；真正注册推迟到首个 bot 服务加载时。 */
export function armMessagingHooks(): void {
  armed = true;
}

export async function ensureMessagingHooks(): Promise<void> {
  if (armed) await loader.load();
}

export function resetMessagingHooksIfLoaded(): void {
  armed = false;
  const loaded = loader.peek();
  loader.reset();
  if (!loaded) return;
  loaded.context.resetMessagingRuntime();
  loaded.hooks.setMessagingMeshRuntime(null);
}
