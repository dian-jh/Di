import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect as connectSocket, createServer as createNetServer } from "node:net";

import { createSystemProxyFetch, createWindowsSystemProxyFetch, parseWindowsConnectionSettingsFlags, parseWindowsInternetProxySettings, type WindowsInternetProxySettings } from "../../src/cli/windows-system-proxy.ts";

test("system fetch defaults to the injected Windows proxy path on Windows", async () => {
  let routed = "";
  const fetch = createSystemProxyFetch({
    platform: "win32",
    windowsProxyFetch: async (url) => { routed = url; return new Response("through-proxy"); },
    directFetch: async () => new Response("direct"),
  });
  const response = await fetch("https://example.invalid/resource");
  assert.equal(routed, "https://example.invalid/resource");
  assert.equal(await response.text(), "through-proxy");
});

test("system fetch reads POSIX environment proxies and preserves direct route when unset", async () => {
  let directCalls = 0;
  let selectedProxy = "";
  const fetch = createSystemProxyFetch({
    platform: "linux",
    environment: { https_proxy: "http://lower.local:8080", HTTPS_PROXY: "http://upper.local:8443", no_proxy: ".internal.test,exact.test,port.test:443,*", NO_PROXY: "other.test" },
    windowsProxyFetch: async () => { throw new Error("must not inspect Windows proxy"); },
    proxyFetch: async (_url, _init, proxy) => { selectedProxy = proxy; return new Response("proxy"); },
    directFetch: async () => { directCalls += 1; return new Response("direct"); },
  });
  const response = await fetch("https://example.invalid/resource");
  assert.equal(await response.text(), "proxy");
  assert.equal(selectedProxy, "http://lower.local:8080/");
  assert.equal(await (await fetch("https://internal.test/resource")).text(), "direct");
  assert.equal(await (await fetch("https://api.internal.test/resource")).text(), "direct");
  assert.equal(await (await fetch("https://exact.test:443/resource")).text(), "direct");
  assert.equal(await (await fetch("https://port.test:443/resource")).text(), "proxy");
  assert.equal(await (await fetch("https://other.test/resource")).text(), "proxy");
  assert.equal(await (await fetch("https://sub.exact.test/resource")).text(), "proxy");
  assert.equal(await (await fetch("https://star.test/resource")).text(), "proxy");
  assert.equal(directCalls, 3);
  const unsetFetch = createSystemProxyFetch({ platform: "linux", environment: {}, directFetch: async () => new Response("direct") });
  assert.equal(await (await unsetFetch("https://example.invalid/resource")).text(), "direct");
});

test("empty lower-case proxy variables fall through to upper-case and ALL_PROXY", async () => {
  const selected: string[] = [];
  const fetch = createSystemProxyFetch({
    platform: "linux",
    environment: { http_proxy: "", HTTP_PROXY: "http://upper-http.local:8000", https_proxy: "", ALL_PROXY: "http://upper-all.local:9000", all_proxy: "" },
    proxyFetch: async (_url, _init, proxy) => { selected.push(proxy); return new Response("proxy"); },
  });
  await fetch("http://example.invalid");
  await fetch("https://example.invalid");
  assert.deepEqual(selected, ["http://upper-http.local:8000/", "http://upper-all.local:9000/"]);
});

test("POSIX environment proxy follows .NET ALL_PROXY and HTTP_PROXY CGI rules", async () => {
  const selected: string[] = [];
  const fetch = createSystemProxyFetch({
    platform: "linux",
    environment: { ALL_PROXY: "http://upper-all.local:8000", all_proxy: "http://lower-all.local:9000", HTTP_PROXY: "http://upper.local:8080", http_proxy: "http://lower.local:8081", GATEWAY_INTERFACE: "" },
    proxyFetch: async (url, _init, proxy) => { selected.push(proxy); return new Response("proxy"); },
  });
  await fetch("http://example.invalid/resource");
  await fetch("https://example.invalid/resource");
  assert.deepEqual(selected, ["http://lower.local:8081/", "http://lower-all.local:9000/"]);
});

test("environment proxy fail closed without exposing credentials in errors", async () => {
  const fetch = createSystemProxyFetch({ platform: "linux", environment: { HTTPS_PROXY: "http://[invalid" } });
  await assert.rejects(fetch("https://target.invalid"), (error: unknown) => {
    assert.match(String(error), /invalid/);
    assert.doesNotMatch(String(error), /\[invalid/);
    return true;
  });
});

test("environment ProxyAgent tunnels an HTTP request through a loopback CONNECT proxy", async () => {
  const origin = createServer((_request, response) => { response.writeHead(200, { "content-length": "9" }); response.end("origin-ok"); });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originAddress = origin.address();
  assert.ok(originAddress !== null && typeof originAddress !== "string");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer();
  let connected = "";
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("connect", (request, socket) => {
    connected = request.url ?? "";
    const upstream = connectSocket(originAddress.port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    socket.once("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const fetch = createSystemProxyFetch({ platform: "linux", environment: { HTTP_PROXY: `http://127.0.0.1:${address.port}` } });
  try {
    const response = await fetch(`http://127.0.0.1:${originAddress.port}/probe`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "origin-ok");
    assert.equal(connected, `127.0.0.1:${originAddress.port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  }
});

test("Socks5ProxyAgent connects through a loopback SOCKS5 proxy to an HTTP origin", async () => {
  const origin = createServer((_request, response) => { response.writeHead(200, { "content-length": "9" }); response.end("socks-ok!"); });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originAddress = origin.address();
  assert.ok(originAddress !== null && typeof originAddress !== "string");

  const sockets = new Set<import("node:net").Socket>();
  const server = createNetServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let stage: "greeting" | "request" | "connected" = "greeting";
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting") {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
        buffer = buffer.subarray(2 + buffer[1]!);
        socket.write(Buffer.from([5, 0]));
        stage = "request";
      }
      if (stage === "request") {
        if (buffer.length < 10) return;
        assert.equal(buffer[0], 5);
        assert.equal(buffer[1], 1);
        const port = buffer.readUInt16BE(8);
        const remaining = buffer.subarray(10);
        buffer = Buffer.alloc(0);
        stage = "connected";
        const upstream = connectSocket(port, "127.0.0.1", () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          socket.pipe(upstream);
          upstream.pipe(socket);
          if (remaining.length > 0) upstream.write(remaining);
        });
        socket.once("close", () => upstream.destroy());
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const proxyAddress = server.address();
  assert.ok(proxyAddress !== null && typeof proxyAddress !== "string");
  const fetch = createSystemProxyFetch({ platform: "linux", environment: { ALL_PROXY: `socks5://127.0.0.1:${proxyAddress.port}` } });
  try {
    const response = await fetch(`http://127.0.0.1:${originAddress.port}/probe`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "socks-ok!");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  }
});

test("SOCKS5 environment proxy without a port preserves .NET's default port 80", async () => {
  let selected = "";
  const fetch = createSystemProxyFetch({
    platform: "linux",
    environment: { ALL_PROXY: "socks5://proxy.example.test" },
    proxyFetch: async (_url, _init, proxy) => { selected = proxy; return new Response("proxy"); },
  });
  await fetch("https://example.invalid");
  assert.equal(selected, "socks5://proxy.example.test:80");
});

test("explicit SOCKS4 environment proxy fails clearly instead of falling back", async () => {
  let proxyCalls = 0;
  const fetch = createSystemProxyFetch({
    platform: "linux",
    environment: { https_proxy: "socks4://user:secret@proxy.example.test:1080", HTTPS_PROXY: "http://upper-proxy.example.test:8080" },
    proxyFetch: async () => { proxyCalls++; return new Response("unexpected"); },
  });
  await assert.rejects(fetch("https://target.invalid"), (error: unknown) => {
    assert.match(String(error), /protocol is unsupported/);
    assert.doesNotMatch(String(error), /secret|proxy\.example\.test/);
    return true;
  });
  assert.equal(proxyCalls, 0);
});

test("SOCKS5 proxy failure and cancellation never fall back to direct networking", async () => {
  for (const mode of ["error", "cancel"] as const) {
    const sockets = new Set<import("node:net").Socket>();
    const server = createNetServer();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", (_greeting: Buffer) => {
        if (mode === "error") socket.end(Buffer.from([5, 255]));
        else {
          socket.write(Buffer.from([5, 0]));
          socket.once("data", () => {});
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    let directCalls = 0;
    const fetch = createSystemProxyFetch({
      platform: "linux",
      environment: { ALL_PROXY: `socks5://127.0.0.1:${address.port}` },
      directFetch: async () => { directCalls++; return new Response("should-not-connect-directly"); },
    });
    try {
      const signal = mode === "error" ? AbortSignal.timeout(5_000) : AbortSignal.timeout(100);
      await assert.rejects(fetch("http://tunnel.synthetic.invalid/probe", { signal }));
      assert.equal(directCalls, 0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("POSIX proxy failure and cancellation never fall back to direct networking", async () => {
  for (const mode of ["error", "cancel"] as const) {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer();
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    server.on("connect", (_request, socket) => {
      if (mode === "error") socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    let directCalls = 0;
    const fetch = createSystemProxyFetch({
      platform: "linux",
      environment: { HTTPS_PROXY: `http://127.0.0.1:${address.port}` },
      directFetch: async () => { directCalls++; return new Response("should-not-connect-directly"); },
    });
    try {
      const signal = mode === "error" ? AbortSignal.timeout(5_000) : AbortSignal.timeout(100);
      await assert.rejects(fetch("https://tunnel.synthetic.invalid/probe", { signal }));
      assert.equal(directCalls, 0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("PAC and WPAD use the system resolver for proxy and direct decisions", async () => {
  for (const autoDetect of [false, true]) {
    const signal = new AbortController().signal;
    let resolvedUrl = "";
    let resolvedSignal: AbortSignal | undefined;
    let selectedProxy = "";
    let direct = false;
    const fetch = createWindowsSystemProxyFetch({
      platform: "win32",
      readSettings: async () => ({ enabled: false, autoDetect, autoConfigEnabled: !autoDetect, connectionFlagsKnown: true }),
      resolveAutomaticProxy: async (url, receivedSignal) => { resolvedUrl = url; resolvedSignal = receivedSignal; return direct ? undefined : "http://pac-proxy.invalid:8080"; },
      proxyFetch: async (_url, _init, proxy) => { selectedProxy = proxy; return new Response("proxy"); },
      directFetch: async () => new Response("direct"),
    });
    assert.equal(await (await fetch("https://target.invalid/path", { signal })).text(), "proxy");
    assert.equal(resolvedUrl, "https://target.invalid/path");
    assert.equal(resolvedSignal, signal);
    assert.equal(selectedProxy, "http://pac-proxy.invalid:8080/");
    direct = true;
    assert.equal(await (await fetch("https://target.invalid/path")).text(), "direct");
  }
});

test("automatic proxy resolution errors never trigger a direct request", async () => {
  let directCalls = 0;
  const fetch = createWindowsSystemProxyFetch({
    platform: "win32",
    readSettings: async () => ({ enabled: false, autoDetect: true, autoConfigEnabled: false, connectionFlagsKnown: true }),
    resolveAutomaticProxy: async () => { throw new Error("synthetic resolver failure"); },
    directFetch: async () => { directCalls++; return new Response("unexpected"); },
  });
  await assert.rejects(fetch("https://target.invalid"), /synthetic resolver failure/);
  assert.equal(directCalls, 0);
});

test("Windows Internet proxy settings parser reads static endpoints and bypasses", () => {
  const settings = parseWindowsInternetProxySettings([
    "ProxyEnable    REG_DWORD    0x1",
    "ProxyServer    REG_SZ    http=proxy.local:8080;https=secure-proxy.local:8443",
    "ProxyOverride REG_SZ    *.internal.local;<local>",
    "AutoDetect     REG_DWORD    0x0",
  ].join("\n"));
  assert.deepEqual(settings, {
    enabled: true,
    proxyServer: "http=proxy.local:8080;https=secure-proxy.local:8443",
    bypass: "*.internal.local;<local>",
    autoDetect: false,
    autoConfigEnabled: false,
    connectionFlagsKnown: false,
  });
});

test("Windows connection flags identify PAC and WPAD, unknown flags fail closed", () => {
  assert.deepEqual(parseWindowsConnectionSettingsFlags("DefaultConnectionSettings REG_BINARY 3c 00 00 00 1f 00 00 00 0c 00 00 00"), {
    autoConfigEnabled: true,
    autoDetect: true,
  });
  assert.equal(parseWindowsConnectionSettingsFlags("DefaultConnectionSettings REG_BINARY 01"), undefined);
});

test("Windows system proxy fetch selects scheme proxy, honors bypass, and never bypasses PAC/WPAD", async () => {
  const routed: string[] = [];
  let settings: WindowsInternetProxySettings = {
    enabled: true,
    proxyServer: "http=http-proxy.local:8080;https=https-proxy.local:8443",
    bypass: "*.internal.local;<local>",
    autoConfigUrl: undefined,
    autoDetect: false,
    autoConfigEnabled: false,
    connectionFlagsKnown: true,
  };
  const fetch = createWindowsSystemProxyFetch({
    platform: "win32",
    readSettings: async () => settings,
    resolveAutomaticProxy: async () => { throw new Error("PAC/WPAD resolver failure"); },
    directFetch: async (url) => { routed.push(`direct:${url}`); return new Response("direct"); },
    proxyFetch: async (url, _init, proxy) => { routed.push(`${proxy}:${url}`); return new Response("proxy"); },
  });

  await fetch("https://api.example.test/v1", {});
  await fetch("http://api.example.test/v1", {});
  await fetch("https://inside.internal.local/v1", {});
  await fetch("https://printer/v1", {});
  assert.deepEqual(routed, [
    "http://https-proxy.local:8443/:https://api.example.test/v1",
    "http://http-proxy.local:8080/:http://api.example.test/v1",
    "direct:https://inside.internal.local/v1",
    "direct:https://printer/v1",
  ]);

  settings = { ...settings, autoConfigUrl: "https://proxy-config.invalid/proxy.pac" };
  await assert.rejects(fetch("https://api.example.test/v1", {}), /PAC\/WPAD/);
  settings = { ...settings, autoConfigUrl: undefined, autoDetect: true };
  await assert.rejects(fetch("https://api.example.test/v1", {}), /PAC\/WPAD/);
});

test("enabled system proxy with no static server fails closed", async () => {
  const fetch = createWindowsSystemProxyFetch({
    platform: "win32",
    readSettings: async () => ({ enabled: true, autoDetect: false, autoConfigEnabled: false, connectionFlagsKnown: true }),
    directFetch: async () => { throw new Error("must not silently connect direct"); },
    proxyFetch: async () => { throw new Error("missing proxy must fail before dispatch"); },
  });
  await assert.rejects(fetch("https://api.example.test", {}), /static proxy server/);
});

test("unknown Windows connection flags fail closed instead of assuming direct", async () => {
  const fetch = createWindowsSystemProxyFetch({
    platform: "win32",
    readSettings: async () => ({ enabled: false, autoDetect: false, autoConfigEnabled: false, connectionFlagsKnown: false }),
  });
  await assert.rejects(fetch("https://api.example.test", {}), /flags could not be determined safely/);
});

test("system proxy disabled follows the configured direct route", async () => {
  let directCalls = 0;
  const fetch = createWindowsSystemProxyFetch({
    platform: "win32",
    readSettings: async () => ({ enabled: false, autoDetect: false, autoConfigEnabled: false, connectionFlagsKnown: true }),
    directFetch: async () => { directCalls++; return new Response("direct"); },
    proxyFetch: async () => { throw new Error("proxy should not be used"); },
  });
  const response = await fetch("https://api.example.test", {});
  assert.equal(await response.text(), "direct");
  assert.equal(directCalls, 1);
});

test("Undici ProxyAgent sends the request through a successful CONNECT tunnel", async () => {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer();
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("connect", (_request, socket, head) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const respond = (): void => { socket.end("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nproxy-ok"); };
    if (head.length > 0) respond();
    else socket.once("data", respond);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const fetch = createWindowsSystemProxyFetch({
    platform: "win32",
    readSettings: async () => ({ enabled: true, proxyServer: `127.0.0.1:${address.port}`, autoDetect: false, autoConfigEnabled: false, connectionFlagsKnown: true }),
  });
  try {
    const response = await fetch("http://synthetic.invalid/probe", { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "proxy-ok");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("proxy errors and cancellation do not fall back to direct networking", async () => {
  for (const mode of ["error", "cancel"] as const) {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer();
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    server.on("connect", (_request, socket, head) => {
      if (mode === "error") {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      } else {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length === 0) socket.once("data", () => {});
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    let directCalls = 0;
    const fetch = createWindowsSystemProxyFetch({
      platform: "win32",
      readSettings: async () => ({ enabled: true, proxyServer: `127.0.0.1:${address.port}`, autoDetect: false, autoConfigEnabled: false, connectionFlagsKnown: true }),
      directFetch: async () => { directCalls++; return new Response("must-not-fallback"); },
    });
    try {
      const signal = mode === "error" ? AbortSignal.timeout(5_000) : AbortSignal.timeout(100);
      await assert.rejects(fetch("http://synthetic.invalid/probe", { signal }));
      assert.equal(directCalls, 0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
