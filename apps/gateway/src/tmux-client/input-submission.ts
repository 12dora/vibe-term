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
    this.cancelled = true;
    for (const cancel of this.cancellations) cancel();
    this.cancellations.clear();
    return true;
  }

  onCancel(callback: () => void): () => void {
    if (this.cancelled) callback();
    else this.cancellations.add(callback);
    return () => this.cancellations.delete(callback);
  }
}
