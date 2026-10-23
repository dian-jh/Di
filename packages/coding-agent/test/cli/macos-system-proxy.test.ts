import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMacOSSystemProxyFetch,
  parseMacOSSystemProxySettings,
  readMacOSSystemProxySettings,
} from "../../src/cli/macos-system-proxy.ts";

test("parses static HTTP, HTTPS, SOCKS and bypass settings", () => {
  const settings = parseMacOSSystemProxySettings(`
<dictionary> {
  HTTPEnable : 1
  HTTPProxy : proxy.local
  HTTPPort : 8080
  HTTPSEnable : 1
  HTTPSProxy : secure-proxy.local
  HTTPSPort : 8443
  SOCKSEnable : 1
  SOCKSProxy : socks.local
  SOCKSPort : 1080
  ExcludeSimpleHostnames : 1
  ExceptionsList : <array> {
    0 : localhost
    1 : *.internal.example
  }
  __SCOPED__ : <dictionary> {
    HTTPEnable : 0
    HTTPProxy : scoped-proxy.example
    HTTPPort : 9876
  }
}
`);
  assert.deepEqual(settings, {
    httpProxy: "http://proxy.local:8080/",
    httpsProxy: "http://secure-proxy.local:8443/",
    socksProxy: "socks5://socks.local:1080",
    bypass: ["localhost", "*.internal.example"],
    excludeSimpleHostnames: true,
    automatic: false,
  });
});

test("routes static proxy by target scheme and honors system bypass entries", async () => {
  const calls: string[] = [];
  const fetcher = createMacOSSystemProxyFetch({
    platform: "darwin",
    readSettings: async () => ({
      httpProxy: "http://proxy.local:8080",
      httpsProxy: "http://secure-proxy.local:8443",
      bypass: ["localhost", "*.internal.example"],
      excludeSimpleHostnames: true,
      automatic: false,
    }),
    directFetch: async (url) => { calls.push(`direct:${url}`); return new Response("direct"); },
    proxyFetch: async (url, _init, proxy) => { calls.push(`proxy:${proxy}:${url}`); return new Response("proxy"); },
  });
  await fetcher("http://example.com/");
  await fetcher("https://example.com/");
  await fetcher("https://api.internal.example/");
  await fetcher("http://printer/");
  assert.deepEqual(calls, [
    "proxy:http://proxy.local:8080:http://example.com/",
    "proxy:http://secure-proxy.local:8443:https://example.com/",
    "direct:https://api.internal.example/",
    "direct:http://printer/",
  ]);
});

test("uses direct mode when a static proxy is absent for the requested scheme", async () => {
  const routes: string[] = [];
  const fetcher = createMacOSSystemProxyFetch({
    platform: "darwin",
    readSettings: async () => ({ httpProxy: "http://proxy.local:8080", bypass: [], excludeSimpleHostnames: false, automatic: false }),
    directFetch: async (url) => { routes.push(`direct:${url}`); return new Response(); },
    proxyFetch: async (url, _init, proxy) => { routes.push(`proxy:${proxy}:${url}`); return new Response(); },
  });
  await fetcher("https://example.com/");
  assert.deepEqual(routes, ["direct:https://example.com/"]);
});

test("uses configured SOCKS proxy for HTTP and HTTPS when scheme proxies are absent", async () => {
  const seen: string[] = [];
  const fetcher = createMacOSSystemProxyFetch({
    platform: "darwin",
    readSettings: async () => ({ socksProxy: "socks5://socks.local:1080", bypass: [], excludeSimpleHostnames: false, automatic: false }),
    proxyFetch: async (url, _init, proxy) => { seen.push(`${proxy}:${url}`); return new Response(); },
  });
  await fetcher("http://example.com/");
  await fetcher("https://example.com/");
  assert.deepEqual(seen, ["socks5://socks.local:1080:http://example.com/", "socks5://socks.local:1080:https://example.com/"]);
});

test("fails closed when automatic proxy discovery is enabled", async () => {
  const fetcher = createMacOSSystemProxyFetch({
    platform: "darwin",
    readSettings: async () => ({ automatic: true, bypass: [], excludeSimpleHostnames: false }),
    directFetch: async () => { throw new Error("must not go direct"); },
  });
  await assert.rejects(fetcher("https://example.com/"), /PAC\/WPAD.*unsupported/i);
});

test("pre-aborted request does not read settings", async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const fetcher = createMacOSSystemProxyFetch({
    platform: "darwin",
    readSettings: async () => { reads++; return { bypass: [], excludeSimpleHostnames: false, automatic: false }; },
  });
  await assert.rejects(fetcher("https://example.com/", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(reads, 0);
});

test("abort during system settings read prevents both direct and proxy requests", async () => {
  const controller = new AbortController();
  let releaseRead!: (settings: { httpProxy: string; bypass: string[]; excludeSimpleHostnames: boolean; automatic: boolean }) => void;
  const readSettings = new Promise<{ httpProxy: string; bypass: string[]; excludeSimpleHostnames: boolean; automatic: boolean }>((resolve) => { releaseRead = resolve; });
  let networkCalls = 0;
  const fetcher = createMacOSSystemProxyFetch({
    platform: "darwin",
    readSettings: () => readSettings,
    directFetch: async () => { networkCalls++; return new Response(); },
    proxyFetch: async () => { networkCalls++; return new Response(); },
  });
  const pending = fetcher("https://example.com/", { signal: controller.signal });
  controller.abort();
  releaseRead({ httpProxy: "http://proxy.local:8080", bypass: [], excludeSimpleHostnames: false, automatic: false });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(networkCalls, 0);
});

test("rejects malformed or unknown system settings instead of silently choosing direct", () => {
  assert.throws(() => parseMacOSSystemProxySettings(""), /dictionary/i);
  assert.throws(() => parseMacOSSystemProxySettings("<dictionary> {\n  HTTPEnable : 2\n}"), /flag/i);
  assert.throws(() => parseMacOSSystemProxySettings("<dictionary> {\n  HTTPEnable : 1\n  HTTPProxy : proxy.local\n}"), /safely|proxy/i);
});

test("treats a disabled PAC URL as inert and supports IPv4 CIDR bypasses", async () => {
  const parsed = parseMacOSSystemProxySettings(`<dictionary> {
  ProxyAutoConfigEnable : 0
  ProxyAutoConfigURLString : http://pac.invalid/proxy.pac
  HTTPEnable : 1
  HTTPProxy : proxy.local
  HTTPPort : 8080
  ExceptionsList : <array> {
    0 : 169.254.0.0/16
  }
}`);
  assert.equal(parsed.automatic, false);
  const routes: string[] = [];
  const fetcher = createMacOSSystemProxyFetch({
    platform: "darwin",
    readSettings: async () => parsed,
    directFetch: async (url) => { routes.push(`direct:${url}`); return new Response(); },
    proxyFetch: async (url, _init, proxy) => { routes.push(`proxy:${proxy}:${url}`); return new Response(); },
  });
  await fetcher("http://169.254.10.20/");
  await fetcher("http://169.253.10.20/");
  await fetcher("http://[fe80::1]/");
  assert.deepEqual(routes, [
    "direct:http://169.254.10.20/",
    "proxy:http://proxy.local:8080/:http://169.253.10.20/",
    "proxy:http://proxy.local:8080/:http://[fe80::1]/",
  ]);
});

test("macOS CI can read the real system proxy API without modifying it", { skip: process.platform !== "darwin" }, async () => {
  const settings = await readMacOSSystemProxySettings();
  assert.equal(typeof settings.automatic, "boolean");
  assert.ok(Array.isArray(settings.bypass));
});
