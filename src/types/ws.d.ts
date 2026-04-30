/**
 * Minimal type declarations for the `ws` WebSocket package.
 * Install @types/ws for full typings.
 */

declare module "ws" {
  import { EventEmitter } from "node:events";
  import type { ClientRequestArgs } from "node:http";

  interface WebSocketOptions extends ClientRequestArgs {
    headers?: Record<string, string>;
  }

  class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;

    readonly readyState: 0 | 1 | 2 | 3;

    constructor(url: string, options?: WebSocketOptions);
    constructor(url: string, protocols?: string | string[], options?: WebSocketOptions);

    send(data: string | Buffer | ArrayBuffer | Uint8Array, cb?: (err?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    ping(data?: unknown, mask?: boolean, cb?: (err: Error) => void): void;
    pong(data?: unknown, mask?: boolean, cb?: (err: Error) => void): void;

    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: Buffer | string | Buffer[]) => void): this;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- compat with existing callers
    on(event: "message", listener: (data: any) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "ping" | "pong", listener: (data: Buffer) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;

    once(event: "open", listener: () => void): this;
    once(event: "message", listener: (data: Buffer | string) => void): this;
    once(event: "error", listener: (err: Error) => void): this;
    once(event: "close", listener: (code: number, reason: Buffer) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
  }

  interface WebSocketServerOptions {
    noServer?: boolean;
    port?: number;
    host?: string;
    path?: string;
  }

  class WebSocketServer extends EventEmitter {
    constructor(options?: WebSocketServerOptions);
    handleUpgrade(request: any, socket: any, head: any, callback: (ws: WebSocket) => void): void;
    close(cb?: () => void): void;
    on(event: "connection", listener: (ws: WebSocket, req: any) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export { WebSocket, WebSocketServer };
  export default WebSocket;
}
