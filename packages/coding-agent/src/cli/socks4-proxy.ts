import { lookup } from "node:dns/promises";
import { connect as connectSocket, type Socket } from "node:net";
import { createRequire } from "node:module";
import { buildConnector, type Dispatcher } from "undici";

interface ConnectorOptions { hostname: string; protocol: string; port: string; servername?: string; httpSocket?: Socket; }
type ConnectorCallback = (error: Error | null, socket: Socket | import("node:tls").TLSSocket | null) => void;
interface AgentApi { readonly Agent: new (options: { connect: (options: ConnectorOptions, callback: ConnectorCallback) => void }) => Dispatcher & { close(): Promise<void>; destroy(error?: Error): Promise<void> }; }

/** Build an Undici dispatcher that opens each origin connection through SOCKS4/4a. */
export function createSocks4Dispatcher(proxy: URL, signal?: AbortSignal): { readonly dispatcher: Dispatcher; close(): Promise<void>; destroy(error?: Error): Promise<void> } {
  if (signal?.aborted) throw abortError();
  const host = proxy.hostname.startsWith("[") && proxy.hostname.endsWith("]")
    ? proxy.hostname.slice(1, -1)
    : proxy.hostname;
  const port = Number(proxy.port || 80);
  const userId = decodeURIComponent(proxy.username);
  const userBytes = Buffer.from(userId, "utf8");
  if (userBytes.length > 255 || userBytes.includes(0)) throw new Error("The configured SOCKS4 proxy user ID is invalid.");
  const remoteDns = proxy.protocol === "socks4a:";
  const tlsConnector = buildConnector({});
  const undici = require("undici") as AgentApi;
  const sockets = new Set<Socket>();
  const agent = new undici.Agent({ connect(options, callback) {
    let called = false;
    const complete: ConnectorCallback = (error, socket) => { if (called) return; called = true; callback(error, socket); };
    void openTunnel(options, host, port, userBytes, remoteDns, signal, (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); }).then((socket) => {
      if (options.protocol === "https:") {
        try {
          tlsConnector({ hostname: options.hostname, protocol: options.protocol, port: options.port, servername: options.servername, httpSocket: socket }, complete);
        } catch (error) {
          socket.destroy();
          complete(error instanceof Error ? error : new Error("SOCKS4 TLS connection failed."), null);
        }
      } else complete(null, socket);
    }, (error: unknown) => complete(error instanceof Error ? error : new Error("SOCKS4 connection failed."), null));
  } });
  const onAbort = (): void => { for (const socket of sockets) socket.destroy(); void agent.destroy(abortError()).catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    dispatcher: agent,
    async close() { try { await agent.close(); } finally { signal?.removeEventListener("abort", onAbort); } },
    async destroy(error) { try { await agent.destroy(error); } finally { signal?.removeEventListener("abort", onAbort); } },
  };
}

const require = createRequire(import.meta.url);

async function openTunnel(options: ConnectorOptions, proxyHost: string, proxyPort: number, userId: Buffer, remoteDns: boolean, signal?: AbortSignal, trackSocket?: (socket: Socket) => void): Promise<Socket> {
  if (signal?.aborted) throw abortError();
  let socket: Socket | undefined;
  let failAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { failAbort = reject; });
  const onAbort = (): void => { socket?.destroy(); failAbort(abortError()); };
  const timer = setTimeout(() => { socket?.destroy(); failAbort(new Error("SOCKS4 connection timed out.")); }, 15_000);
  signal?.addEventListener("abort", onAbort, { once: true });
  const race = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);
  try {
  const targetHost = options.hostname.startsWith("[") && options.hostname.endsWith("]")
    ? options.hostname.slice(1, -1)
    : options.hostname;
  let address: Buffer;
  let domain: Buffer | undefined;
  if (net.isIP(targetHost) === 6) throw new Error("SOCKS4 does not support IPv6 destinations.");
  if (remoteDns && net.isIP(targetHost) === 0) {
    domain = Buffer.from(targetHost, "utf8");
    if (domain.length === 0 || domain.length > 255 || domain.includes(0)) throw new Error("SOCKS4a destination name is invalid.");
    address = Buffer.from([0, 0, 0, 1]);
  } else {
    const resolved = net.isIP(targetHost) === 4 ? targetHost : (await race(lookup(targetHost, { family: 4 }))).address;
    if (signal?.aborted) throw abortError();
    if (net.isIP(resolved) !== 4) throw new Error("SOCKS4 requires an IPv4 destination.");
    address = Buffer.from(resolved.split(".").map(Number));
  }
  const targetPort = Number(options.port || (options.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error("SOCKS4 destination port is invalid.");
  const request = Buffer.concat([Buffer.from([4, 1, targetPort >> 8, targetPort & 255]), address, userId, Buffer.from([0]), ...(domain === undefined ? [] : [domain, Buffer.from([0])])]);
  socket = connectSocket(proxyPort, proxyHost);
  trackSocket?.(socket);
  const connectedSocket = socket;
  await race(new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { connectedSocket.off("connect", onConnect); connectedSocket.off("error", onError); connectedSocket.off("close", onClose); };
      const onConnect = (): void => { cleanup(); resolve(); };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onClose = (): void => { cleanup(); reject(new Error("SOCKS4 proxy connection closed.")); };
      connectedSocket.once("connect", onConnect); connectedSocket.once("error", onError); connectedSocket.once("close", onClose);
    }));
    connectedSocket.write(request);
    const reply = await race(readBytes(connectedSocket, 8));
    if (reply[0] !== 0 || reply[1] !== 90) throw new Error("SOCKS4 proxy rejected the connection.");
    return connectedSocket;
  } catch (error) {
    socket?.destroy();
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function abortError(): Error { const error = new Error("The operation was aborted."); error.name = "AbortError"; return error; }

async function readBytes(socket: Socket, count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => { socket.off("data", onData); socket.off("error", onError); socket.off("end", onEnd); socket.off("close", onClose); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onEnd = (): void => { cleanup(); reject(new Error("SOCKS4 proxy closed during its response.")); };
    const onClose = (): void => { cleanup(); reject(new Error("SOCKS4 proxy closed during its response.")); };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < count) return;
      const extra = buffer.subarray(count);
      cleanup();
      if (extra.length > 0) socket.unshift(extra);
      resolve(buffer.subarray(0, count));
    };
    socket.on("data", onData); socket.once("error", onError); socket.once("end", onEnd); socket.once("close", onClose);
  });
}

import * as net from "node:net";
