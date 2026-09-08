// e2e 选区探针（__vibetermE2eTerminalSelectionText）是整页唯一的全局，而分屏下同一页会挂
// 多个控制器，每一帧都会往这里写自己的选区文本。没有归属判定时，对侧空闲 pane 的任意
// 一帧都会把本 pane 的选区抹成 null；渲染循环是按需调度的，本 pane 空闲后不会再有帧把
// 它写回来，探针就永久停在 null。故：写非空选区者取得归属，只有归属者（或无人归属时）
// 才能清空。
let probeOwner: unknown = null;

export function writeSelectionTextProbe(owner: unknown, value: string | null): void {
  const probes = globalThis as { __vibetermE2eTerminalSelectionText?: string | null };
  if (value !== null) {
    probeOwner = owner;
    probes.__vibetermE2eTerminalSelectionText = value;
    return;
  }

  if (probeOwner === owner || probeOwner === null) {
    probeOwner = null;
    probes.__vibetermE2eTerminalSelectionText = null;
  }
}
