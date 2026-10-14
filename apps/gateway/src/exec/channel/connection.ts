import type { Device } from '@vibeterm/shared';
import {
  EC_DEAD_MS,
  EC_PING_MS,
  type EcFrame,
  EcKind,
  EcProtocolError,
  type ExecChannelErrorCode,
  FrameDecoder,
  type ResolvedExecOpenSpec,
  type ValidatedExecHello,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
  validateHello,
} from '@vibeterm/shared/exec-channel';
import type { ExecChannelDeps } from './deps';
import { ExecChannelError } from './errors';
import type { ExecProcess } from './process';
import {
  commitSession,
  generateSessionId,
  getSession,
  releaseSessionSlot,
  reserveSessionSlot,
} from './registry';
import { ExecSession, ProtocolViolation } from './session';
import type { ExecChannelAuth, ExecChannelInbound, ExecTransport } from './transport-types';

const TICK_MS = 1000;
const EMPTY = new Uint8Array(0);

type Phase = 'hello' | 'opening' | 'active' | 'closed';
type Handler = (session: ExecSession, payload: Uint8Array) => void;

function readField(payload: Uint8Array, key: string): unknown {
  return (decodeJson(payload) as Record<string, unknown>)[key];
}

function numberField(payload: Uint8Array, key: string): number {
  const value = readField(payload, key);
  if (typeof value !== 'number') throw new ProtocolViolation(`invalid ${key}`);
  return value;
}

function stringField(payload: Uint8Array, key: string): string {
  const value = readField(payload, key);
  if (typeof value !== 'string') throw new ProtocolViolation(`invalid ${key}`);
  return value;
}

function booleanField(payload: Uint8Array, key: string): boolean {
  const value = readField(payload, key);
  if (typeof value !== 'boolean') throw new ProtocolViolation(`invalid ${key}`);
  return value;
}

const HANDLERS: Record<number, Handler> = {
  [EcKind.STDIN]: (s, p) => s.onStdin(p),
  [EcKind.STDIN_EOF]: (s) => s.onStdinEof(),
  [EcKind.RESIZE]: (s, p) => s.onResize(numberField(p, 'cols'), numberField(p, 'rows')),
  [EcKind.SIGNAL]: (s, p) => s.onSignal(stringField(p, 'signal')),
  [EcKind.ACK]: (s, p) => s.onAck(numberField(p, 'out')),
  [EcKind.CLOSE]: (s, p) => s.onClose(booleanField(p, 'kill')),
};

class ExecConnection implements ExecChannelInbound {
  private readonly decoder = new FrameDecoder();
  private readonly link: ExecTransport;
  private phase: Phase = 'hello';
  private session: ExecSession | null = null;
  private lastSent: number;
  private lastRecv: number;
  private tickTimer: unknown = null;

  constructor(
    transport: ExecTransport,
    private readonly auth: ExecChannelAuth,
    private readonly deps: ExecChannelDeps
  ) {
    this.lastSent = this.lastRecv = deps.clock.now();
    this.link = {
      send: (frame) => {
        this.lastSent = this.deps.clock.now();
        transport.send(frame);
      },
      get bufferedBytes() {
        return transport.bufferedBytes;
      },
      onDrain: (cb) => transport.onDrain(cb),
      close: (code, reason) => {
        this.shut();
        transport.close(code, reason);
      },
    };
    transport.onDrain(() => this.session?.pump());
    this.armTick();
  }

  onBytes(chunk: Uint8Array): void {
    if (this.phase === 'closed') return;
    this.lastRecv = this.deps.clock.now();
    try {
      for (const frame of this.decoder.push(chunk)) {
        if (this.phase === 'closed') break;
        this.handle(frame);
      }
    } catch (error) {
      const message =
        error instanceof EcProtocolError || error instanceof ProtocolViolation
          ? error.message
          : 'internal error';
      this.fail('protocol_error', message);
    }
  }

  onClose(): void {
    this.shut();
    this.session?.detach(this.link);
  }

  private shut(): void {
    this.phase = 'closed';
    if (this.tickTimer !== null) this.deps.clock.clearTimeout(this.tickTimer);
    this.tickTimer = null;
  }

  private armTick(): void {
    this.tickTimer = this.deps.clock.setTimeout(() => this.onTick(), TICK_MS);
  }

  private onTick(): void {
    this.tickTimer = null;
    const now = this.deps.clock.now();
    if (now - this.lastRecv >= EC_DEAD_MS) {
      this.session?.detach(this.link);
      this.link.close(4408, 'idle');
      return;
    }
    if (now - this.lastSent >= EC_PING_MS) this.link.send(encodeFrame(EcKind.PING, EMPTY));
    this.armTick();
  }

  private fail(code: ExecChannelErrorCode, message: string): void {
    if (this.phase === 'closed') return;
    this.link.send(encodeJsonFrame(EcKind.ERROR, { code, message }));
    this.session?.detach(this.link);
    this.link.close(code === 'forbidden' ? 4403 : 4400, code);
  }

  private handle(frame: EcFrame): void {
    if (this.phase === 'hello') {
      this.onHello(frame);
      return;
    }
    if (frame.kind === EcKind.PING) {
      this.link.send(encodeFrame(EcKind.PONG, EMPTY));
      return;
    }
    if (frame.kind === EcKind.PONG) return;
    if (this.phase === 'opening') throw new ProtocolViolation('frame before READY');
    const handler = HANDLERS[frame.kind];
    if (!handler || !this.session) throw new ProtocolViolation('unexpected frame');
    handler(this.session, frame.payload);
  }

  private onHello(frame: EcFrame): void {
    if (frame.kind !== EcKind.HELLO) throw new ProtocolViolation('first frame must be HELLO');
    const result = validateHello(decodeJson(frame.payload));
    if (!result.ok) {
      this.fail('invalid_request', result.message);
      return;
    }
    this.phase = 'opening';
    if (result.hello.op === 'open') void this.open(result.hello.spec);
    else this.resume(result.hello);
  }

  private resume(hello: Extract<ValidatedExecHello, { op: 'resume' }>): void {
    const session = getSession(hello.sessionId);
    if (!session || session.uid !== this.auth.uid) {
      this.fail('session_not_found', 'session not found');
      return;
    }
    const backlog = session.resumeFrames(hello.out);
    if (!backlog) {
      this.fail('resume_gap', 'output offset is no longer retained');
      return;
    }
    this.link.send(encodeJsonFrame(EcKind.READY, session.ready(true, hello.out)));
    this.session = session;
    this.phase = 'active';
    session.attach(this.link, backlog);
  }

  private async launch(spec: ResolvedExecOpenSpec): Promise<{ device: Device; proc: ExecProcess }> {
    const device = this.deps.resolveDevice(spec.device);
    if (!device) throw new ExecChannelError('device_not_found', 'device not found');
    if (device.type !== 'local' && device.type !== 'ssh') {
      throw new ExecChannelError('exec_unsupported_device', 'device type does not support exec');
    }
    return { device, proc: await this.deps.spawn(device, spec) };
  }

  private async open(spec: ResolvedExecOpenSpec): Promise<void> {
    if (!reserveSessionSlot(this.deps.maxSessions)) {
      this.fail('session_limit', 'too many exec sessions');
      return;
    }
    let launched: { device: Device; proc: ExecProcess };
    try {
      launched = await this.launch(spec);
    } catch (error) {
      releaseSessionSlot();
      const code = error instanceof ExecChannelError ? error.code : 'exec_spawn_failed';
      this.fail(code, error instanceof Error ? error.message : 'spawn failed');
      return;
    }
    if (this.phase !== 'opening') {
      launched.proc.kill();
      releaseSessionSlot();
      return;
    }
    const session = new ExecSession(
      { id: generateSessionId(), ...this.principal(), spec, ...launched },
      this.deps.clock
    );
    commitSession(session);
    this.session = session;
    this.phase = 'active';
    this.link.send(encodeJsonFrame(EcKind.READY, session.ready(false, 0)));
    session.attach(this.link, []);
    session.start();
  }

  private principal(): { uid: string | null; tokenId: string | null } {
    return { uid: this.auth.uid, tokenId: this.auth.tokenId };
  }
}

export function attachExecChannelWith(
  transport: ExecTransport,
  auth: ExecChannelAuth,
  deps: ExecChannelDeps
): ExecChannelInbound {
  const connection = new ExecConnection(transport, auth, deps);
  return {
    onBytes: (chunk) => connection.onBytes(chunk),
    onClose: () => connection.onClose(),
  };
}
