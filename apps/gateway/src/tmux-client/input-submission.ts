export type InputCompletion = [onAck?: () => void, submission?: InputSubmission];

export class InputSubmission {
  submitted = false;
  cancelled = false;
  private readonly cancellations = new Set<() => void>();

  constructor(private readonly isCurrent: () => boolean) {}

  isValid(): boolean {
    return !this.cancelled && this.isCurrent();
  }

  cancel(): boolean {
    if (this.submitted || this.cancelled) return false;
    this.cancelQueued();
    return true;
  }

  /**
   * 撤销仍在命令窗口里等待的命令：已开始提交也照样通知监听者，
   * 保证 pane 关闭后它排队的 send-keys 不再占用设备级窗口。
   */
  cancelQueued(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const cancel of this.cancellations) cancel();
    this.cancellations.clear();
  }

  onCancel(callback: () => void): () => void {
    if (this.cancelled) callback();
    else this.cancellations.add(callback);
    return () => this.cancellations.delete(callback);
  }
}
