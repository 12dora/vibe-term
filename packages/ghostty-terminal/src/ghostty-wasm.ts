// ghostty wasm ABI 门面：GhosttyBindings 由 core → terminal → formatter → render-state → encoders
// 的分层子类逐层拼出，各层实现见同名 `ghostty-wasm-*.ts`；本文件只负责模块加载与单例缓存。
import { GhosttyBindingsEncoders } from './ghostty-wasm-encoders';
import { instantiateGhosttyModule } from './ghostty-wasm-loader';

export class GhosttyBindings extends GhosttyBindingsEncoders {}

let bindingsPromise: Promise<GhosttyBindings> | null = null;

async function instantiateGhosttyBindings(): Promise<GhosttyBindings> {
  const { exports, layout } = await instantiateGhosttyModule();
  return new GhosttyBindings(exports, layout);
}

export async function getGhosttyBindings(): Promise<GhosttyBindings> {
  if (!bindingsPromise) {
    // 只缓存成功：失败的 promise 留在缓存里会把一次性的加载错误（网络、资源缺失）
    // 变成进程级永久失效，之后任何调用都拿不到 bindings 也无从重试。
    const pending = instantiateGhosttyBindings().catch((error: unknown) => {
      if (bindingsPromise === pending) {
        bindingsPromise = null;
      }
      throw error;
    });
    bindingsPromise = pending;
  }

  return bindingsPromise;
}

export {
  GHOSTTY_FORMATTER_FORMAT_HTML,
  GHOSTTY_FORMATTER_FORMAT_PLAIN,
  GHOSTTY_KEY_ACTION_PRESS,
  GHOSTTY_KEY_ACTION_RELEASE,
  GHOSTTY_KEY_ACTION_REPEAT,
} from './ghostty-wasm-abi';
export { keyboardEventToGhosttyMods } from './ghostty-wasm-encoders';
