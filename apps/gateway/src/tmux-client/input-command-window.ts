interface InputCommandJob {
  run(): Promise<unknown>;
  resolve(): void;
  reject(error: unknown): void;
}

export class InputCommandWindow {
  private readonly pending: InputCommandJob[] = [];
  private inFlight = 0;
  private pumping = false;
  private closed: Error | null = null;

  constructor(private readonly capacity: () => number) {}

  get disposed(): boolean {
    return this.closed !== null;
  }

  enqueue(
    commands: readonly string[][],
    execute: (argv: string[]) => Promise<unknown>
  ): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    // 整段先入队再写出，确保跨输入、跨 pane 的分块顺序。
    const completions = commands.map(
      (argv) =>
        new Promise<void>((resolve, reject) => {
          this.pending.push({ run: () => execute(argv), resolve, reject });
        })
    );
    const result = Promise.all(completions).then(() => undefined);
    this.pump();
    return result;
  }

  dispose(reason: string): void {
    if (this.closed) return;
    this.closed = new Error(reason);
    for (const job of this.pending.splice(0)) job.reject(this.closed);
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      this.startPending();
    } finally {
      this.pumping = false;
    }
  }

  private startPending(): void {
    while (!this.closed && this.inFlight < this.capacity()) {
      const job = this.pending.shift();
      if (!job) return;
      this.inFlight += 1;
      let result: Promise<unknown>;
      try {
        result = job.run();
      } catch (error) {
        result = Promise.reject(error);
      }
      void result.then(
        () => {
          job.resolve();
          this.finish();
        },
        (error) => {
          job.reject(error);
          this.finish();
        }
      );
    }
  }

  private finish(): void {
    this.inFlight -= 1;
    this.pump();
  }
}
