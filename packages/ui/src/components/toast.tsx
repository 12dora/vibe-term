import type { ExternalToast } from 'sonner';

type ToastKind = 'success' | 'error' | 'warning' | 'info' | 'message';

// sonner 只在首屏之后懒挂（见 apps/fe main.tsx）；这里的门面让业务代码不再把 sonner 静态钉进入口 chunk。
// 所有调用点都是 fire-and-forget，不需要返回的 toast id。
function emit(kind: ToastKind, message: string, options?: ExternalToast): void {
  void import('sonner').then(
    (module) => {
      const fn = kind === 'message' ? module.toast : module.toast[kind];
      fn(message, options);
    },
    () => {}
  );
}

export const toast = {
  success: (message: string, options?: ExternalToast) => emit('success', message, options),
  error: (message: string, options?: ExternalToast) => emit('error', message, options),
  warning: (message: string, options?: ExternalToast) => emit('warning', message, options),
  info: (message: string, options?: ExternalToast) => emit('info', message, options),
  message: (message: string, options?: ExternalToast) => emit('message', message, options),
};
