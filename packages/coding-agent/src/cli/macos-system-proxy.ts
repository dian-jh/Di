import { execFile } from "node:child_process";

/** Static proxy data exposed by macOS `scutil --proxy`. */
export interface MacOSSystemProxySettings {
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  readonly socksProxy?: string;
  readonly bypass: readonly string[];
  readonly excludeSimpleHostnames: boolean;
  readonly automatic: boolean;
}

export interface MacOSSystemProxyFetchOptions {
  readonly platform?: string;
  readonly readSettings?: (signal?: AbortSignal) => Promise<MacOSSystemProxySettings>;
  readonly directFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly proxyFetch?: (input: string, init: RequestInit | undefined, proxy: string) => Promise<Response>;
}

/*
 * Route through the static macOS HTTP, HTTPS or SOCKS proxy. PAC and WPAD are
 * detected but fail closed: this implementation does not evaluate PAC scripts.
 */
export function createMacOSSystemProxyFetch(options: MacOSSystemProxyFetchOptions = {}): (input: string, init?: RequestInit) => Promise<Response> {
  const platform = options.platform ?? process.platform;
  const readSettings = options.readSettings ?? readMacOSSystemProxySettings;
  const directFetch = options.directFetch ?? ((input, init) => globalThis.fetch(input, init));
  const proxyFetch = options.proxyFetch;
  return async (input, init) => {
    init?.signal?.throwIfAborted();
    if (platform !== "darwin") throw new Error("macOS system proxy discovery is available only on macOS.");
    const settings = await readSettings(init?.signal ?? undefined);
    init?.signal?.throwIfAborted();
    if (settings.automatic) throw new Error("macOS PAC/WPAD system proxy is enabled but automatic proxy resolution is unsupported.");
    const target = new URL(input);
    if (isBypassed(settings, target.hostname)) return directFetch(input, init);
    const proxy = target.protocol === "http:" ? settings.httpProxy ?? settings.socksProxy
      : target.protocol === "https:" ? settings.httpsProxy ?? settings.socksProxy
        : undefined;
    if (proxy !== undefined) {
      if (proxyFetch === undefined) throw new Error("A shared proxy transport is required for macOS system proxy routing.");
      return proxyFetch(input, init, proxy);
    }
    return directFetch(input, init);
  };
}

/** Read current system proxy configuration using macOS's read-only scutil interface. */
export function readMacOSSystemProxySettings(signal?: AbortSignal): Promise<MacOSSystemProxySettings> {
  signal?.throwIfAborted();
  if (process.platform !== "darwin") return Promise.reject(new Error("macOS system proxy settings are unavailable on this platform."));
  return new Promise((resolve, reject) => {
    execFile("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, signal }, (error, stdout) => {
      if (error !== null) {
        if (error.name === "AbortError") {
          reject(error);
          return;
        }
        reject(new Error("Cannot read macOS system proxy settings."));
        return;
      }
      try { resolve(parseMacOSSystemProxySettings(stdout)); }
      catch { reject(new Error("macOS system proxy settings could not be parsed safely.")); }
    });
  });
}

/** Parse the stable key/value and array sections emitted by `scutil --proxy`. */
export function parseMacOSSystemProxySettings(output: string): MacOSSystemProxySettings {
  if (!/^\s*<dictionary>\s*\{/m.test(output)) throw new Error("Missing proxy dictionary");
  const values = new Map<string, string>();
  const arrays = new Map<string, string[]>();
  let currentArray: string[] | undefined;
  let arrayIndent = -1;
  for (const line of output.split(/\r?\n/)) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    const arrayMatch = /^(\w+)\s*:\s*<array>\s*\{$/.exec(trimmed);
    if (arrayMatch !== null && indent === 2) {
      currentArray = [];
      arrays.set(arrayMatch[1]!, currentArray);
      arrayIndent = indent;
      continue;
    }
    if (currentArray !== undefined) {
      if (trimmed === "}" && indent <= arrayIndent) {
        currentArray = undefined;
        continue;
      }
      const item = /^\d+\s*:\s*(.*?)\s*$/.exec(trimmed);
      if (item !== null && indent === arrayIndent + 2 && item[1] !== undefined && item[1] !== "") currentArray.push(item[1]);
      continue;
    }
    const pair = /^(\w+)\s*:\s*(.*?)\s*$/.exec(trimmed);
    if (pair !== null && indent === 2) values.set(pair[1]!, pair[2]!);
  }
  const enabled = (key: string): boolean => {
    const value = values.get(key);
    if (value !== undefined && value !== "0" && value !== "1") throw new Error("Unknown proxy flag");
    return value === "1";
  };
  const port = (key: string): number | undefined => {
    const value = values.get(key);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("Invalid proxy port");
    return parsed;
  };
  const endpoint = (isEnabled: boolean, hostKey: string, portKey: string, scheme: string): string | undefined => {
    if (!isEnabled) return undefined;
    const host = values.get(hostKey);
    const proxyPort = port(portKey);
    if (host === undefined || host === "" || proxyPort === undefined) throw new Error("Incomplete proxy endpoint");
    const url = new URL(`${scheme}://${host.includes(":") && !host.startsWith("[") ? `[${host}]`: host}:${proxyPort}`);
    if (url.hostname === "" || url.username !== "" || url.password !== "") throw new Error("Invalid proxy endpoint");
    return url.toString();
  };
  const automatic = enabled("ProxyAutoConfigEnable") || enabled("ProxyAutoDiscoveryEnable");
  const httpProxy = endpoint(enabled("HTTPEnable"), "HTTPProxy", "HTTPPort", "http");
  const httpsProxy = endpoint(enabled("HTTPSEnable"), "HTTPSProxy", "HTTPSPort", "http");
  const socksProxy = endpoint(enabled("SOCKSEnable"), "SOCKSProxy", "SOCKSPort", "socks5");
  return {
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(socksProxy === undefined ? {} : { socksProxy }),
    bypass: arrays.get("ExceptionsList") ?? [],
    excludeSimpleHostnames: enabled("ExcludeSimpleHostnames"),
    automatic,
  };
}

function isBypassed(settings: MacOSSystemProxySettings, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (settings.excludeSimpleHostnames && !host.includes(".") && !host.includes(":")) return true;
  return settings.bypass.some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (pattern === "") return false;
    const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(pattern);
    if (cidr !== null) return ipv4MatchesCidr(host, cidr[1]!, Number(cidr[2]));
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i").test(host);
  });
}

function ipv4MatchesCidr(host: string, network: string, prefix: number): boolean {
  if (prefix < 0 || prefix > 32) return false;
  const toNumber = (address: string): number | undefined => {
    const octets = address.split(".");
    if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return undefined;
    return octets.reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
  };
  const hostValue = toNumber(host);
  const networkValue = toNumber(network);
  if (hostValue === undefined || networkValue === undefined) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (hostValue & mask) === (networkValue & mask);
}
