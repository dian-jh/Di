import { execFile } from "node:child_process";
import { createRequire } from "node:module";

/** Windows current-user Internet Settings relevant to static proxy selection. */
export interface WindowsInternetProxySettings {
  readonly enabled: boolean;
  readonly proxyServer?: string;
  readonly bypass?: string;
  readonly autoConfigUrl?: string;
  readonly autoDetect: boolean;
  readonly autoConfigEnabled: boolean;
  readonly connectionFlagsKnown: boolean;
}

export interface WindowsSystemProxyFetchOptions {
  readonly platform?: string;
  readonly readSettings?: () => Promise<WindowsInternetProxySettings>;
  readonly directFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly proxyFetch?: (input: string, init: RequestInit | undefined, proxy: string) => Promise<Response>;
  readonly resolveAutomaticProxy?: (input: string, signal?: AbortSignal) => Promise<string | undefined>;
}

export interface SystemProxyFetchOptions {
  readonly platform?: string;
  readonly windowsProxyFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly directFetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const require = createRequire(import.meta.url);
const proxyAgents = new Map<string, unknown>();

/**
 * Parse `reg.exe query` output. Values are retained only in memory and are never
 * included in errors or diagnostics because proxy URLs can contain credentials.
 */
export function parseWindowsInternetProxySettings(output: string): WindowsInternetProxySettings {
  const get = (name: string): string | undefined => {
    const match = new RegExp(`^\\s*${name}\\s+REG_[A-Z0-9_]+\\s+(.+?)\\s*$`, "im").exec(output);
    return match?.[1];
  };
  const enabledValue = parseRegistryDword(get("ProxyEnable"));
  const autoDetectValue = parseRegistryDword(get("AutoDetect"));
  const autoConfigUrl = get("AutoConfigURL");
  return {
    enabled: enabledValue === 1,
    ...(get("ProxyServer") === undefined ? {} : { proxyServer: get("ProxyServer") }),
    ...(get("ProxyOverride") === undefined ? {} : { bypass: get("ProxyOverride") }),
    ...(autoConfigUrl === undefined ? {} : { autoConfigUrl }),
    autoDetect: autoDetectValue === 1,
    autoConfigEnabled: autoConfigUrl !== undefined && autoConfigUrl.trim() !== "",
    connectionFlagsKnown: false,
  };
}

/** Parse the documented proxy mode bitfield in `DefaultConnectionSettings`. */
export function parseWindowsConnectionSettingsFlags(output: string): { readonly autoConfigEnabled: boolean; readonly autoDetect: boolean } | undefined {
  const match = /^\s*DefaultConnectionSettings\s+REG_BINARY\s*([\s\S]*)$/im.exec(output);
  if (match === null) return undefined;
  const bytesText = match[1]!.replace(/^\s*hex\s*:\s*/i, "").replace(/[^0-9a-f]/gi, "");
  if (bytesText.length < 18 || bytesText.length % 2 !== 0) return undefined;
  const flags = Number.parseInt(bytesText.slice(16, 18), 16);
  if (!Number.isFinite(flags) || (flags & 0xf0) !== 0) return undefined;
  return { autoConfigEnabled: (flags & 0x04) !== 0, autoDetect: (flags & 0x08) !== 0 };
}

/**
 * Windows static proxy routing, with PAC/WPAD decisions delegated to the OS
 * proxy resolver through Windows PowerShell. Resolution errors never fall back.
 */
export function createWindowsSystemProxyFetch(options: WindowsSystemProxyFetchOptions = {}): (input: string, init?: RequestInit) => Promise<Response> {
  const platform = options.platform ?? process.platform;
  const readSettings = options.readSettings ?? readWindowsInternetProxySettings;
  const directFetch = options.directFetch ?? ((input, init) => globalThis.fetch(input, init));
  const proxyFetch = options.proxyFetch ?? fetchThroughUndiciProxy;
  const resolveAutomaticProxy = options.resolveAutomaticProxy ?? resolveWindowsSystemProxy;

  return async (input, init) => {
    if (platform !== "win32") throw new Error("DeepSeek:UseSystemProxy is available only on Windows.");
    const settings = await readSettings();
    if (!settings.connectionFlagsKnown) throw new Error("DeepSeek:UseSystemProxy automatic proxy flags could not be determined safely.");
    if (settings.autoConfigEnabled || settings.autoDetect || (settings.autoConfigUrl !== undefined && settings.autoConfigUrl.trim() !== "")) {
      const selected = await resolveAutomaticProxy(input, init?.signal ?? undefined);
      if (selected === undefined) return directFetch(input, init);
      const proxy = proxyForTarget(selected, new URL(input).protocol);
      if (proxy === undefined) throw new Error("Windows automatic proxy resolution returned an empty endpoint.");
      return proxyFetch(input, init, proxy);
    }
    const target = new URL(input);
    if (!settings.enabled) return directFetch(input, init);
    const proxy = proxyForTarget(settings.proxyServer, target.protocol);
    if (proxy === undefined) throw new Error("DeepSeek:UseSystemProxy is enabled but no static proxy server is configured for this scheme.");
    if (isBypassed(settings.bypass, target)) return directFetch(input, init);
    return proxyFetch(input, init, proxy);
  };
}

// Fixed code only: the request URL is passed as environment data, never shell code.
// Windows PowerShell uses the OS-provided .NET Framework proxy resolver, including
// automatic detection and PAC. No project C# build or installed .NET SDK is needed.
const SYSTEM_PROXY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = [Uri]$env:DI_SYSTEM_PROXY_TARGET
$systemProxy = [System.Net.WebRequest]::GetSystemWebProxy()
if ($systemProxy.IsBypassed($target)) { @{ proxy = $null } | ConvertTo-Json -Compress }
else { @{ proxy = $systemProxy.GetProxy($target).AbsoluteUri } | ConvertTo-Json -Compress }
`;

export function resolveWindowsSystemProxy(input: string, signal?: AbortSignal): Promise<string | undefined> {
  if (process.platform !== "win32") return Promise.reject(new Error("Windows proxy resolution is unavailable on this platform."));
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SYSTEM_PROXY_SCRIPT, "utf16le").toString("base64")], {
      windowsHide: true, encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024,
      signal, env: { ...process.env, DI_SYSTEM_PROXY_TARGET: input },
    }, (error, stdout) => {
      if (error !== null) { reject(new Error("Windows automatic proxy resolution failed or timed out.", { cause: error })); return; }
      try {
        const result: unknown = JSON.parse(stdout.trim());
        if (result === null || typeof result !== "object" || !("proxy" in result)) throw new Error("Invalid resolver result.");
        const proxy = (result as { proxy: unknown }).proxy;
        if (proxy === null) resolve(undefined);
        else if (typeof proxy === "string" && proxy !== "") resolve(proxy);
        else throw new Error("Invalid resolver endpoint.");
      } catch { reject(new Error("Windows automatic proxy resolution returned an invalid result.")); }
    });
  });
}

/** Match ChatGPT's default HttpClient system-proxy behavior on Windows. */
export function createSystemProxyFetch(options: SystemProxyFetchOptions = {}): (input: string, init?: RequestInit) => Promise<Response> {
  const platform = options.platform ?? process.platform;
  const directFetch = options.directFetch ?? ((input, init) => globalThis.fetch(input, init));
  const windowsProxyFetch = options.windowsProxyFetch ?? createWindowsSystemProxyFetch({ platform });
  return (input, init) => platform === "win32"
    ? windowsProxyFetch(input, init)
    : directFetch(input, init);
}

async function readWindowsInternetProxySettings(): Promise<WindowsInternetProxySettings> {
  if (process.platform !== "win32") throw new Error("Windows Internet proxy settings are unavailable on this platform.");
  const [output, connections] = await Promise.all([
    queryRegistry(INTERNET_SETTINGS_KEY, []),
    queryRegistry(`${INTERNET_SETTINGS_KEY}\\Connections`, ["/v", "DefaultConnectionSettings"]),
  ]);
  const settings = parseWindowsInternetProxySettings(output);
  const flags = parseWindowsConnectionSettingsFlags(connections);
  if (flags === undefined) return settings;
  return {
    ...settings,
    autoConfigEnabled: settings.autoConfigEnabled || flags.autoConfigEnabled,
    autoDetect: settings.autoDetect || flags.autoDetect,
    connectionFlagsKnown: true,
  };
}

function queryRegistry(key: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("reg.exe", ["query", key, ...args], { windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        reject(new Error("Cannot read the current-user Windows Internet proxy settings."));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseRegistryDword(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  const parsed = normalized.startsWith("0x") ? Number.parseInt(normalized.slice(2), 16) : Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function proxyForTarget(proxyServer: string | undefined, protocol: string): string | undefined {
  if (proxyServer === undefined || proxyServer.trim() === "") return undefined;
  const entries = proxyServer.split(";").map((entry) => entry.trim()).filter(Boolean);
  const mapped = new Map<string, string>();
  let unqualified: string | undefined;
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 0) {
      unqualified ??= entry;
      continue;
    }
    mapped.set(entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim());
  }
  const selected = mapped.get(protocol.slice(0, -1)) ?? unqualified;
  if (selected === undefined || selected === "") return undefined;
  const uri = /^[a-z][a-z0-9+.-]*:\/\//i.test(selected) ? selected : `http://${selected}`;
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new Error("DeepSeek:UseSystemProxy contains an invalid static proxy endpoint."); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") {
    throw new Error("DeepSeek:UseSystemProxy contains an unsupported static proxy endpoint.");
  }
  return parsed.toString();
}

function isBypassed(bypass: string | undefined, target: URL): boolean {
  if (bypass === undefined) return false;
  const hostname = target.hostname.toLowerCase();
  const hostAndPort = target.port === "" ? hostname : `${hostname}:${target.port}`;
  return bypass.split(/[;,]/).map((entry) => entry.trim().toLowerCase()).filter(Boolean).some((entry) => {
    if (entry === "<local>") return !hostname.includes(".");
    const candidate = entry.replace(/^\*\./, "*.");
    const escaped = candidate.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    const pattern = new RegExp(`^${escaped}$`, "i");
    return pattern.test(hostAndPort) || (target.port !== "" && pattern.test(hostname));
  });
}

interface UndiciProxyApi {
  readonly ProxyAgent: new (proxyUri: string) => { close(): Promise<void> };
  readonly fetch: (input: string, init?: RequestInit & { readonly dispatcher: unknown }) => Promise<Response>;
}

async function fetchThroughUndiciProxy(input: string, init: RequestInit | undefined, proxy: string): Promise<Response> {
  let dispatcher = proxyAgents.get(proxy);
  if (dispatcher === undefined) {
    let undici: UndiciProxyApi;
    try { undici = require("undici") as UndiciProxyApi; }
    catch (error) { throw new Error("DeepSeek:UseSystemProxy requires the bundled undici dependency.", { cause: error }); }
    dispatcher = new undici.ProxyAgent(proxy);
    proxyAgents.set(proxy, dispatcher);
  }
  const undici = require("undici") as UndiciProxyApi;
  return undici.fetch(input, { ...init, dispatcher });
}
