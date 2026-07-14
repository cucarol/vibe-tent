/** JSON-RPC application error thrown by service handlers / catalog. */

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
