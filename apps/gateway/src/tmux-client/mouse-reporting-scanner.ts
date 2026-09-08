const reportingModes = new Set([1000, 1002, 1003]);

export class MouseReportingScanner {
  private sequence = '';
  private readonly enabled = new Set<number>();

  push(bytes: Uint8Array): boolean {
    let disabled = false;
    for (const byte of bytes) {
      if (byte === 0x1b) {
        this.sequence = '\x1b';
      } else if (this.sequence) {
        this.sequence += String.fromCharCode(byte);
        if (this.sequence.length === 2 && byte === 0x5b) continue;
        if (byte >= 0x40 && byte <= 0x7e) {
          disabled = this.apply() || disabled;
          this.sequence = '';
        } else if (this.sequence.length > 128) {
          this.sequence = '';
        }
      }
    }
    return disabled;
  }

  private apply(): boolean {
    const match = /^\[\?([\d;]+)([hl])$/.exec(this.sequence.slice(1));
    if (!match) return false;
    let reset = false;
    for (const value of match[1].split(';')) {
      const mode = Number(value);
      if (!reportingModes.has(mode)) continue;
      if (match[2] === 'h') this.enabled.add(mode);
      else {
        this.enabled.delete(mode);
        reset = true;
      }
    }
    // 连接可能在应用开启模式后才建立，首次看到 reset 也要清掉旧输入。
    return reset && this.enabled.size === 0;
  }
}
