import test from "node:test";
import assert from "node:assert/strict";
import { createSystemProxyFetch } from "../../src/cli/windows-system-proxy.ts";

test("macOS without proxy environment variables consults system settings", async () => {
  const fetcher = createSystemProxyFetch({
    platform: "darwin", environment: {},
    macOSProxyFetch: async () => new Response("macOS"),
    directFetch: async () => new Response("direct"),
  });
  assert.equal(await (await fetcher("https://example.com/")).text(), "macOS");
});

test("macOS environment routing takes precedence for the entire proxy configuration", async () => {
  const fetcher = createSystemProxyFetch({
    platform: "darwin", environment: { HTTP_PROXY: "http://proxy.example:8080" },
    macOSProxyFetch: async () => { throw new Error("must not consult system settings"); },
    proxyFetch: async (_url, _init, proxy) => new Response(proxy),
    directFetch: async () => new Response("direct"),
  });
  assert.equal(await (await fetcher("http://example.com/")).text(), "http://proxy.example:8080/");
  assert.equal(await (await fetcher("https://example.com/")).text(), "direct");
});

test("empty proxy variables and NO_PROXY alone do not suppress macOS system discovery", async () => {
  const fetcher = createSystemProxyFetch({
    platform: "darwin", environment: { all_proxy: "", HTTPS_PROXY: " ", NO_PROXY: "example.com" },
    macOSProxyFetch: async () => new Response("macOS"),
    directFetch: async () => new Response("direct"),
  });
  assert.equal(await (await fetcher("https://example.com/")).text(), "macOS");
});

test("CGI ignores uppercase HTTP_PROXY when deciding whether macOS needs system discovery", async () => {
  const fetcher = createSystemProxyFetch({
    platform: "darwin", environment: { GATEWAY_INTERFACE: "", HTTP_PROXY: "http://untrusted.example:8080" },
    macOSProxyFetch: async () => new Response("macOS"),
    directFetch: async () => new Response("direct"),
  });
  assert.equal(await (await fetcher("http://example.com/")).text(), "macOS");
});

test("invalid explicit macOS environment proxies fail instead of using system or direct routes", async () => {
  const fetcher = createSystemProxyFetch({
    platform: "darwin", environment: { ALL_PROXY: "http://[invalid" },
    macOSProxyFetch: async () => { throw new Error("must not consult system settings"); },
    directFetch: async () => { throw new Error("must not go direct"); },
  });
  await assert.rejects(fetcher("https://example.com/"), /environment proxy endpoint is invalid/);
});

test("Linux without environment proxies keeps direct networking", async () => {
  const fetcher = createSystemProxyFetch({
    platform: "linux", environment: {},
    macOSProxyFetch: async () => { throw new Error("must not consult macOS"); },
    directFetch: async () => new Response("direct"),
  });
  assert.equal(await (await fetcher("https://example.com/")).text(), "direct");
});
