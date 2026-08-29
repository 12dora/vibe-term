export class TlsApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'TlsApiError';
    this.code = code;
    this.status = status;
  }
}
