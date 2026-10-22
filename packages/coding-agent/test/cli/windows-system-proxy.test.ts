import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

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

test("system fetch remains direct on non-Windows platforms", async () => {
  let directCalls = 0;
  const fetch = createSystemProxyFetch({
    platform: "linux",
    windowsProxyFetch: async () => { throw new Error("must not inspect Windows proxy"); },
    directFetch: async () => { directCalls += 1; return new Response("direct"); },
  });
  const response = await fetch("https://example.invalid/resource");
  assert.equal(directCalls, 1);
  assert.equal(await response.text(), "direct");
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
