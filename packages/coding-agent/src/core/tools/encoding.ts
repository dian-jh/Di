import { spawn } from "node:child_process";
import iconv from "iconv-lite";

/** OEM stdin encoder for cmd; no global console-code-page changes. */
export function createLegacyEncoder(codePage: number): ((text: string) => Uint8Array) | undefined {
  const label = codePage === 65001 ? "utf8" : `cp${codePage}`;
  if (!iconv.encodingExists(label)) return undefined;
  return (text) => iconv.encode(text, label);
}

/**
 * Output/file decoding per P4-win-encoding-probe.md.
 *
 * Strategy (mirrors `Core/Tools/ProcessEncoding.cs` SmartDecode):
 * 1. strict UTF-8 decode (fatal) — valid UTF-8 wins immediately;
 * 2. else trim 1–3 bytes from the tail (a multi-byte char cut at the seam),
 *    then 1–3 bytes from the head, re-testing strict UTF-8;
 * 3. else fall back to the system OEM code page decoder.
 *
 * The OEM code page is discovered lazily (`chcp.com`, cached) and mapped to a
 * WHATWG `TextDecoder` label; pages ICU lacks (e.g. OEM 437) and unknown pages
 * resolve to no decoder, which the caller must surface as an explicit decode
 * error (never silent mojibake). Non-Windows OEM is 65001 (UTF-8), which strict
 * decode already covered.
 */

/** Decodes legacy-encoded bytes (system OEM code page). */
export type LegacyDecoder = (bytes: Uint8Array) => string;

/** Strict UTF-8 decode; undefined when `bytes` are not valid UTF-8. */
function tryStrictUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Pure SmartDecode with a known OEM decoder (shared with the process tools later). */
export function smartDecode(bytes: Uint8Array, oem: LegacyDecoder): string {
  const whole = tryStrictUtf8(bytes);
  if (whole !== undefined) return whole;
  for (let cut = 1; cut <= 3 && bytes.length > cut; cut += 1) {
    const slice = tryStrictUtf8(bytes.subarray(0, bytes.length - cut));
    if (slice !== undefined) return slice;
  }
  for (let cut = 1; cut <= 3 && bytes.length > cut; cut += 1) {
    const slice = tryStrictUtf8(bytes.subarray(cut));
    if (slice !== undefined) return slice;
  }
  return oem(bytes);
}

/**
 * Lazy-OEM variant: only resolves the OEM decoder when strict UTF-8 fails, and
 * reports an explicit decode error when no OEM decoder exists.
 */
export async function decodeSmart(
  bytes: Uint8Array,
  resolveOem: () => Promise<LegacyDecoder | undefined>,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const whole = tryStrictUtf8(bytes);
  if (whole !== undefined) return { ok: true, text: whole };
  const oem = await resolveOem();
  if (oem === undefined) {
    return { ok: false, error: "error: 无法解码：非 UTF-8 且系统 OEM 解码器不可用" };
  }
  return { ok: true, text: smartDecode(bytes, oem) };
}

/** Windows OEM code page -> WHATWG TextDecoder label (probe §2 table). */
const CODE_PAGE_TO_LABEL: Readonly<Record<number, string>> = {
  65001: "utf-8",
  936: "gbk",
  932: "shift_jis",
  949: "euc-kr",
  950: "big5",
  866: "ibm866",
  1251: "windows-1251",
  1252: "windows-1252",
};

/**
 * Resolve a legacy decoder for an OEM code page; undefined when the page is
 * unmapped or ICU lacks it (constructor throws ERR_ENCODING_NOT_SUPPORTED).
 */
export function createLegacyDecoder(codePage: number): LegacyDecoder | undefined {
  const label = CODE_PAGE_TO_LABEL[codePage];
  if (label === undefined) return undefined;
  try {
    // Construction throws for labels this ICU build lacks.
    new TextDecoder(label);
    return (bytes) => new TextDecoder(label).decode(bytes);
  } catch {
    return undefined;
  }
}

let cachedOemCodePage: number | undefined;
let oemDiscoveryFailed = false;

/** Discover and cache the system OEM code page (probe §1: chcp.com, ~50 ms once). */
export async function discoverOemCodePage(): Promise<number | undefined> {
  if (cachedOemCodePage !== undefined || oemDiscoveryFailed) {
    return cachedOemCodePage;
  }
  if (process.platform !== "win32") {
    // C# maps non-Windows OEM to UTF-8 (65001); strict UTF-8 already covered it.
    cachedOemCodePage = 65001;
    return cachedOemCodePage;
  }
  try {
    cachedOemCodePage = await spawnChcp();
    return cachedOemCodePage;
  } catch {
    oemDiscoveryFailed = true;
    return undefined;
  }
}

/** Run `chcp.com`, parse the trailing ASCII code page number; bounded output. */
function spawnChcp(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("chcp.com", [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer): void => {
      // Output is a single short line; keep the tail only if something is absurd.
      if (total < 4096) {
        chunks.push(chunk);
        total += chunk.length;
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`chcp 退出码 ${code}: ${Buffer.concat(chunks).toString("utf8").trim()}`));
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const match = /(\d+)\s*$/.exec(text);
      if (match === null) {
        reject(new Error(`chcp 输出无代码页数字: ${text.trim()}`));
        return;
      }
      resolve(Number.parseInt(match[1]!, 10));
    });
  });
}
