// 浏览器剪贴板写入：Clipboard API 优先，被拒/不可用时回退 textarea + execCommand('copy')。
// 纯浏览器侧模块（无 node 依赖），非浏览器环境下调用会抛 'clipboard unavailable'。

export async function writeTextToClipboard(text: string): Promise<void> {
  if (!text) {
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to execCommand fallback
    }
  }

  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    throw new Error('clipboard unavailable');
  }

  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', 'true');
  helper.style.position = 'fixed';
  helper.style.left = '-9999px';
  helper.style.top = '0';
  document.body.appendChild(helper);
  try {
    helper.select();
    if (!document.execCommand('copy')) {
      throw new Error('execCommand copy failed');
    }
  } finally {
    helper.remove();
  }
}
