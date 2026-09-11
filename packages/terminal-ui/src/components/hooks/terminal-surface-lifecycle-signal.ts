// 「首个终端内容绘制」的一次性全局信号。
//
// 冷启动预算要用它：外壳在首帧之后会趁空闲预热设备页/设置页 chunk 与 rest 语言包（约 1.2 MB），
// 这些字节排在终端字体与 wasm 前面就把终端首帧又推后好几秒。宿主据此把预热推到
// 终端真正出内容之后。进程级一次性——用户在应用里切 pane 不该再触发一轮预热。

let painted = false;
let markPainted: () => void = () => {};
let firstPaint = new Promise<void>((resolve) => {
  markPainted = resolve;
});

/** 由 TerminalSurfaceLifecycle 在首个快照落地时调用 */
export function markFirstTerminalScreenPainted(): void {
  if (painted) return;
  painted = true;
  markPainted();
}

export function hasFirstTerminalScreenPainted(): boolean {
  return painted;
}

/** 已绘制过时返回的是已 resolve 的 promise，调用方不必自己判空 */
export function whenFirstTerminalScreenPainted(): Promise<void> {
  return firstPaint;
}

export function resetFirstTerminalScreenPaintedForTest(): void {
  painted = false;
  firstPaint = new Promise<void>((resolve) => {
    markPainted = resolve;
  });
}
