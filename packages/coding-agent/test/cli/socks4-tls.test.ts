import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer, connect as connectSocket, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { fetch as undiciFetch } from "undici";

import { createSystemProxyFetch } from "../../src/cli/windows-system-proxy.ts";
import { createSocks4Dispatcher } from "../../src/cli/socks4-proxy.ts";

const fixtures = new URL("../fixtures/tls/", import.meta.url);
const certPath = fileURLToPath(new URL("localhost-cert.pem", fixtures));
const keyPath = fileURLToPath(new URL("localhost-key.pem", fixtures));

interface RunningRoute {
  readonly proxyPort: number;
  readonly originPort: number;
  readonly requestedPorts: number[];
  readonly requestedHosts: string[];
  close(): Promise<void>;
}

async function startRoute(): Promise<RunningRoute> {
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  const origin = createTlsServer({ cert, key }, (_request, response) => {
    response.writeHead(200, { "content-length": "9", connection: "close" });
    response.end("tls-good!");
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originAddress = origin.address();
  assert.ok(originAddress !== null && typeof originAddress !== "string");

  const sockets = new Set<Socket>();
  const requestedPorts: number[] = [];
  const requestedHosts: string[] = [];
  const proxy = createNetServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let input = Buffer.alloc(0);
    let complete = false;
    socket.on("data", (chunk) => {
      if (complete) return;
      input = Buffer.concat([input, chunk]);
      if (input.length < 9) return;
      const userEnd = input.indexOf(0, 8);
      if (userEnd < 0) return;
      const hostEnd = input.indexOf(0, userEnd + 1);
      if (hostEnd < 0) return;
      complete = true;
      requestedPorts.push(input.readUInt16BE(2));
      requestedHosts.push(input.subarray(userEnd + 1, hostEnd).toString("utf8"));
      const upstream = connectSocket(originAddress.port, "127.0.0.1", () => {
        socket.write(Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]));
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      socket.once("close", () => upstream.destroy());
      upstream.once("error", () => socket.destroy());
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress !== null && typeof proxyAddress !== "string");
  return {
    proxyPort: proxyAddress.port,
    originPort: originAddress.port,
    requestedPorts,
    requestedHosts,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => origin.close(() => resolve())),
      ]);
    },
  };
}

test("SOCKS4a HTTPS rejects a self-signed origin certificate without direct fallback", async () => {
  const route = await startRoute();
  let directCalls = 0;
  const fetch = createSystemProxyFetch({
    platform: "linux",
    environment: { all_proxy: `socks4a://127.0.0.1:${route.proxyPort}`, https_proxy: "", HTTPS_PROXY: "" },
    directFetch: async () => { directCalls++; return new Response("direct route used"); },
  });
  try {
    await assert.rejects(fetch("https://localhost/", { signal: AbortSignal.timeout(5_000) }), (error: unknown) => {
      const chain = `${String(error)} ${String((error as Error).cause)} ${String(((error as Error).cause as Error | undefined)?.cause)}`;
      assert.match(chain, /self[- ]signed|SELF_SIGNED|certificate/i);
      return true;
    });
    assert.deepEqual(route.requestedPorts, [443]);
    assert.deepEqual(route.requestedHosts, ["localhost"]);
    assert.equal(directCalls, 0);
  } finally {
    await route.close();
  }
});

test("SOCKS4a HTTPS succeeds when its test certificate is trusted in a child process", async () => {
  const route = await startRoute();
  const node = process.execPath;
  const sourceUrl = new URL("../../src/cli/windows-system-proxy.ts", import.meta.url).href;
  const childSource = `import { createSystemProxyFetch } from ${JSON.stringify(sourceUrl)}; const response = await createSystemProxyFetch({ platform: "linux", environment: { all_proxy: process.env.DI_TEST_SOCKS_PROXY, no_proxy: "" } })("https://localhost/"); process.stdout.write(await response.text());`;
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_EXTRA_CA_CERTS: certPath,
    DI_TEST_SOCKS_PROXY: `socks4a://127.0.0.1:${route.proxyPort}`,
    all_proxy: `socks4a://127.0.0.1:${route.proxyPort}`,
    ALL_PROXY: "",
    https_proxy: "",
    HTTPS_PROXY: "",
    no_proxy: "",
    NO_PROXY: "",
  };
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(node, ["--input-type=module", "-e", childSource], { env: childEnv, windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      const timeout = setTimeout(() => child.kill(), 10_000);
      child.once("error", reject);
      child.once("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "tls-good!");
    assert.deepEqual(route.requestedPorts, [443]);
    assert.deepEqual(route.requestedHosts, ["localhost"]);
  } finally {
    await route.close();
  }
});

test("SOCKS4 rejects bracketed IPv6 destinations before opening a proxy connection", async () => {
  const dispatcher = createSocks4Dispatcher(new URL("socks4://127.0.0.1:9"));
  try {
    await assert.rejects(undiciFetch("http://[::1]/", { dispatcher: dispatcher.dispatcher }), (error: unknown) => {
      assert.match(String((error as Error).cause), /SOCKS4 does not support IPv6 destinations/);
      return true;
    });
  } finally {
    await dispatcher.destroy();
  }
});

test("SOCKS4 connects to an IPv6-addressed proxy after stripping URL brackets", async () => {
  const origin = createHttpServer((_request, response) => response.end("ipv6-proxy-ok"));
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originAddress = origin.address();
  assert.ok(originAddress !== null && typeof originAddress !== "string");
  const sockets = new Set<Socket>();
  const proxy = createNetServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let input = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (input.length < 9 || input[8] !== 0) return;
      socket.removeAllListeners("data");
      const upstream = connectSocket(originAddress.port, "127.0.0.1", () => {
        socket.write(Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]));
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      socket.once("close", () => upstream.destroy());
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "::1", resolve));
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress !== null && typeof proxyAddress !== "string");
  const dispatcher = createSocks4Dispatcher(new URL(`socks4://[::1]:${proxyAddress.port}`));
  try {
    const response = await undiciFetch(`http://127.0.0.1:${originAddress.port}/`, { dispatcher: dispatcher.dispatcher, signal: AbortSignal.timeout(5_000) });
    assert.equal(await response.text(), "ipv6-proxy-ok");
  } finally {
    await dispatcher.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => origin.close(() => resolve())),
    ]);
  }
});
