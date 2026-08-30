import type { SpawnHandle, SpawnSpec, Spawner } from './spawn';

export type FakeScript = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  hold?: boolean;
  pid?: number;
};

type Rule = {
  match: (spec: SpawnSpec) => boolean;
  script: FakeScript;
  remaining: number;
};

const encoder = new TextEncoder();
let nextFakePid = 1000;

export class FakeHandle implements SpawnHandle {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  private stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
  private stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (code: number) => void;
  private settled = false;

  constructor(script: FakeScript) {
    this.pid = script.pid ?? nextFakePid++;
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stdoutCtrl = controller;
        if (script.stdout) this.writeStdout(script.stdout);
      },
    });
    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stderrCtrl = controller;
        if (script.stderr) this.writeStderr(script.stderr);
      },
    });
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    if (!script.hold) {
      queueMicrotask(() => this.exit(script.exitCode ?? 0));
    }
  }

  writeStdout(text: string): void {
    if (this.settled) return;
    this.stdoutCtrl.enqueue(encoder.encode(text.endsWith('\n') ? text : `${text}\n`));
  }

  writeStderr(text: string): void {
    if (this.settled) return;
    this.stderrCtrl.enqueue(encoder.encode(text.endsWith('\n') ? text : `${text}\n`));
  }

  kill(_signal?: NodeJS.Signals): void {
    this.exit(1);
  }

  exit(code: number): void {
    if (this.settled) return;
    this.settled = true;
    try {
      this.stdoutCtrl.close();
    } catch {}
    try {
      this.stderrCtrl.close();
    } catch {}
    this.resolveExit(code);
  }
}

export class FakeSpawner {
  readonly calls: SpawnSpec[] = [];
  readonly handles: FakeHandle[] = [];
  private readonly rules: Rule[] = [];

  on(match: (spec: SpawnSpec) => boolean, script: FakeScript): this {
    this.rules.push({ match, script, remaining: Number.POSITIVE_INFINITY });
    return this;
  }

  once(match: (spec: SpawnSpec) => boolean, script: FakeScript): this {
    this.rules.push({ match, script, remaining: 1 });
    return this;
  }

  spawn: Spawner = (spec) => {
    this.calls.push(spec);
    const rule = this.rules.find((item) => item.remaining > 0 && item.match(spec));
    const script = rule?.script ?? { exitCode: 0, stdout: '' };
    if (rule && Number.isFinite(rule.remaining)) rule.remaining -= 1;
    const handle = new FakeHandle(script);
    this.handles.push(handle);
    return handle;
  };

  lastHandle(): FakeHandle | undefined {
    return this.handles[this.handles.length - 1];
  }
}

export function argsInclude(spec: SpawnSpec, token: string): boolean {
  return spec.args.includes(token);
}
