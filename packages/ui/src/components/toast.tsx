import type { ExternalToast } from 'sonner';

type ToastKind = 'success' | 'error' | 'warning' | 'info' | 'message';

type SonnerModule = Pick<typeof import('sonner'), 'toast'>;

interface QueuedToast {
  kind: ToastKind;
  message: string;
  options?: ExternalToast;
}

/** Toaster 迟迟不就位时的积压上限：超出丢最旧的，过期通知不该把新的挤掉 */
const MAX_QUEUED_TOASTS = 32;

const defaultImporter = (): Promise<SonnerModule> => import('sonner');

let importSonner = defaultImporter;
let toasterReady = false;
let queue: QueuedToast[] = [];

function deliver(item: QueuedToast): void {
  void importSonner().then(
    (module) => {
      const fn = item.kind === 'message' ? module.toast : module.toast[item.kind];
      fn(item.message, item.options);
    },
    () => {}
  );
}

// sonner 只在首屏之后懒挂（见 apps/fe main.tsx）；这里的门面让业务代码不再把 sonner 静态钉进入口 chunk。
// 所有调用点都是 fire-and-forget，不需要返回的 toast id。
//
// Toaster 挂载（订阅 ToastState）之前发出的通知会被 sonner 直接丢掉——它的 Toaster 初始 state 为空，
// 也不回放已有 toasts。因此就位前一律排队，由 `markToasterReady()` 按序补发。
function emit(kind: ToastKind, message: string, options?: ExternalToast): void {
  const item: QueuedToast = { kind, message, options };
  if (toasterReady) {
    deliver(item);
    return;
  }
  queue.push(item);
  if (queue.length > MAX_QUEUED_TOASTS) queue.shift();
}

/** 由挂载 `<Toaster>` 的宿主在其 effect 里调用：此时订阅已建立，积压的通知按序补发 */
export function markToasterReady(): void {
  toasterReady = true;
  const pending = queue;
  queue = [];
  for (const item of pending) deliver(item);
}

/** 仅供测试：替换 sonner 的动态 import 并清空队列与就绪标记 */
export function resetToastQueueForTests(importer?: (() => Promise<SonnerModule>) | null): void {
  importSonner = importer ?? defaultImporter;
  toasterReady = false;
  queue = [];
}

function plain(message: string, options?: ExternalToast): void {
  emit('message', message, options);
}

export const toast = Object.assign(plain, {
  success: (message: string, options?: ExternalToast) => emit('success', message, options),
  error: (message: string, options?: ExternalToast) => emit('error', message, options),
  warning: (message: string, options?: ExternalToast) => emit('warning', message, options),
  info: (message: string, options?: ExternalToast) => emit('info', message, options),
  message: plain,
});
