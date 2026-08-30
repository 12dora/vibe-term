import { redactSecrets } from './redact';

export class LogRingBuffer {
  private readonly lines: string[] = [];

  constructor(private readonly max = 200) {}

  push(line: string): void {
    const redacted = redactSecrets(line);
    this.lines.push(redacted);
    if (this.lines.length > this.max) {
      this.lines.splice(0, this.lines.length - this.max);
    }
  }

  snapshot(): string[] {
    return this.lines.slice();
  }

  clear(): void {
    this.lines.length = 0;
  }
}
