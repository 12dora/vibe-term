export type HttpsFetchHandler = (
  req: Request,
  server: Bun.Server<unknown>
) => Response | Promise<Response | undefined> | undefined;

export type HttpsListenerOptions = {
  fetch: HttpsFetchHandler;
  websocket: Bun.WebSocketHandler<unknown>;
  log?: (message: string) => void;
};

export type HttpsListenerConfig = {
  port: number;
  host: string;
  certPem: string;
  keyPem: string;
};

export type HttpsListenerState = {
  running: boolean;
  port: number | null;
  error: string | null;
};

export class HttpsListener {
  private server: Bun.Server<unknown> | null = null;
  private lastError: string | null = null;

  constructor(private readonly opts: HttpsListenerOptions) {}

  state(): HttpsListenerState {
    return {
      running: this.server !== null,
      port: this.server?.port ?? null,
      error: this.lastError,
    };
  }

  async apply(cfg: HttpsListenerConfig | null): Promise<void> {
    await this.stop();
    if (!cfg) {
      this.lastError = null;
      return;
    }
    try {
      this.server = Bun.serve({
        hostname: cfg.host,
        port: cfg.port,
        tls: { cert: cfg.certPem, key: cfg.keyPem },
        fetch: this.opts.fetch,
        websocket: this.opts.websocket,
      });
      this.lastError = null;
    } catch (error) {
      this.server = null;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.opts.log?.(`https listener failed to bind: ${this.lastError}`);
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    try {
      server.stop(true);
    } catch (error) {
      this.opts.log?.(
        `https listener stop failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
