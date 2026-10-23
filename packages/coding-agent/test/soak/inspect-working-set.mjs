#!/usr/bin/env node
/** Read-only Windows working-set page classification for a process. */

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;
const MEM_COMMIT = 0x1000;
const MEM_PRIVATE = 0x20000;
const MEM_MAPPED = 0x40000;
const MEM_IMAGE = 0x1000000;
const MAX_WORKING_SET_BUFFER_BYTES = 64 * 1024 * 1024;

const REGION_NAMES = new Map([
  [MEM_PRIVATE, "MEM_PRIVATE"],
  [MEM_MAPPED, "MEM_MAPPED"],
  [MEM_IMAGE, "MEM_IMAGE"],
]);

let cachedApi;

/** Parse the standalone command line. Without --pid, inspect this process. */
export function parseInspectArgs(args, defaultPid = process.pid) {
  let pid = defaultPid;
  let seenPid = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--pid") throw new Error(`Unknown option: ${args[i]}`);
    if (seenPid || i + 1 >= args.length) throw new Error("--pid requires one positive integer.");
    seenPid = true;
    const value = args[++i];
    if (!/^[1-9]\d*$/.test(value)) throw new Error("--pid must be a positive integer.");
    pid = Number(value);
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) {
    throw new Error("PID must be a positive integer in the Windows DWORD range.");
  }
  return { pid };
}

/**
 * Group page metadata without assigning unknown region types to a known class.
 * PSAPI's Shared bit means shareable; ShareCount is a separate 3-bit field.
 */
export function classifyWorkingSetEntries(entries, pageSize = 4096) {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new RangeError("pageSize must be a positive integer.");
  const shareable = { pages: 0, bytes: 0 };
  const notShareable = { pages: 0, bytes: 0 };
  const shareCountPages = Object.create(null);
  const regions = Object.create(null);

  for (const entry of entries) {
    if (typeof entry?.shareable !== "boolean") throw new TypeError("each working-set entry must specify shareable as a boolean.");
    if (!Number.isInteger(entry.shareCount) || entry.shareCount < 0 || entry.shareCount > 7) {
      throw new TypeError("each working-set entry must specify ShareCount from 0 through 7.");
    }
    if (typeof entry.regionType !== "string" || entry.regionType.length === 0) {
      throw new TypeError("each working-set entry must specify a regionType.");
    }
    const region = regions[entry.regionType] ??= { pages: 0, bytes: 0, shareablePages: 0, notShareablePages: 0 };
    region.pages++;
    region.bytes += pageSize;
    shareCountPages[entry.shareCount] = (shareCountPages[entry.shareCount] ?? 0) + 1;
    if (entry.shareable) {
      shareable.pages++;
      shareable.bytes += pageSize;
      region.shareablePages++;
    } else {
      notShareable.pages++;
      notShareable.bytes += pageSize;
      region.notShareablePages++;
    }
  }

  return {
    pages: entries.length,
    bytes: entries.length * pageSize,
    shareable,
    notShareable,
    shareCountPages,
    regions,
    sharedFlagMeaning: "PSAPI Shared bit means shareable, not proof of current cross-process sharing; ShareCount is a separate 3-bit field (0-7).",
  };
}

/** Query one process' working-set metadata; no process memory contents are read. */
export function inspectWorkingSet(pid = process.pid, { platform = process.platform, arch = process.arch } = {}) {
  validatePid(pid);
  if (platform !== "win32") throw new Error("Working-set inspection is supported on Windows only.");
  if (arch !== "x64") throw new Error(`Working-set inspection does not support Windows architecture '${arch}'; x64 is required.`);

  const api = getWindowsApi();
  const handle = api.openProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
  if (handle == null) throw new Error(`OpenProcess failed for PID ${pid} (Windows error ${api.getLastError()}).`);

  try {
    const processInfo = readProcessCounters(api, handle);
    const pageSize = readPageSize(api);
    const wsBuffer = queryWorkingSetBuffer(api, handle, processInfo.workingSetBytes, pageSize);
    const countBig = wsBuffer.readBigUInt64LE(0);
    if (countBig <= 0n || countBig > BigInt(Math.floor((wsBuffer.length - 8) / 8))) {
      throw new Error("QueryWorkingSet returned an invalid page count.");
    }

    const pages = [];
    for (let i = 0, offset = 8; i < Number(countBig); i++, offset += 8) {
      const block = wsBuffer.readBigUInt64LE(offset);
      pages.push({
        address: (block >> 12n) << 12n,
        shareable: ((block >> 8n) & 1n) === 1n,
        shareCount: Number((block >> 5n) & 7n),
      });
    }

    const entries = classifyPageRegions(api, handle, pages, pageSize);
    return {
      pid,
      architecture: arch,
      queriedAtUtc: new Date().toISOString(),
      pageSize,
      psapiWorkingSetBytes: processInfo.workingSetBytes,
      psapiPrivateUsageBytes: processInfo.privateUsageBytes,
      ...classifyWorkingSetEntries(entries, pageSize),
    };
  } finally {
    api.closeHandle(handle);
  }
}

function validatePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) {
    throw new RangeError("PID must be a positive integer in the Windows DWORD range.");
  }
}

function getWindowsApi() {
  if (cachedApi !== undefined) return cachedApi;
  const koffi = createRequire(import.meta.url)("koffi");
  const kernel = koffi.load("kernel32.dll");
  const psapi = koffi.load("psapi.dll");
  const countersType = koffi.struct("DI_INSPECT_PROCESS_MEMORY_COUNTERS_EX", {
    cb: "uint32_t", PageFaultCount: "uint32_t", PeakWorkingSetSize: "size_t", WorkingSetSize: "size_t",
    QuotaPeakPagedPoolUsage: "size_t", QuotaPagedPoolUsage: "size_t", QuotaPeakNonPagedPoolUsage: "size_t",
    QuotaNonPagedPoolUsage: "size_t", PagefileUsage: "size_t", PeakPagefileUsage: "size_t", PrivateUsage: "size_t",
  });
  const mbiType = koffi.struct("DI_INSPECT_MEMORY_BASIC_INFORMATION", {
    BaseAddress: "void *", AllocationBase: "void *", AllocationProtect: "uint32_t", PartitionId: "uint16_t",
    RegionSize: "size_t", State: "uint32_t", Protect: "uint32_t", Type: "uint32_t",
  });
  if (koffi.sizeof(countersType) !== 80 || koffi.sizeof(mbiType) !== 48) {
    throw new Error("Windows memory structure layout is not supported on this architecture.");
  }
  cachedApi = {
    koffi,
    countersType,
    openProcess: kernel.func("void * __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)"),
    closeHandle: kernel.func("int __stdcall CloseHandle(void *hObject)"),
    getLastError: kernel.func("uint32_t __stdcall GetLastError(void)"),
    getSystemInfo: kernel.func("void __stdcall GetSystemInfo(_Out_ uint8_t *info)"),
    getProcessMemoryInfo: psapi.func("int __stdcall GetProcessMemoryInfo(void *Process, _Out_ uint8_t *buffer, uint32_t cb)"),
    queryWorkingSet: psapi.func("int __stdcall QueryWorkingSet(void *hProcess, _Out_ uint8_t *buffer, uint32_t cb)"),
    virtualQueryEx: kernel.func("size_t __stdcall VirtualQueryEx(void *hProcess, uintptr_t address, _Out_ uint8_t *buffer, size_t length)"),
    mbiSize: koffi.sizeof(mbiType),
  };
  return cachedApi;
}

function readProcessCounters(api, handle) {
  const buffer = Buffer.alloc(api.koffi.sizeof(api.countersType));
  buffer.writeUInt32LE(buffer.length, 0);
  if (!api.getProcessMemoryInfo(handle, buffer, buffer.length)) {
    throw new Error(`GetProcessMemoryInfo failed (Windows error ${api.getLastError()}).`);
  }
  return {
    workingSetBytes: Number(buffer.readBigUInt64LE(16)),
    // PROCESS_MEMORY_COUNTERS_EX.PrivateUsage is commit usage, not private WS pages.
    privateUsageBytes: Number(buffer.readBigUInt64LE(72)),
  };
}

function readPageSize(api) {
  const info = Buffer.alloc(48);
  api.getSystemInfo(info);
  const pageSize = info.readUInt32LE(4);
  if (pageSize !== 4096) throw new Error(`Unsupported Windows page size ${pageSize}; expected 4096.`);
  return pageSize;
}

function queryWorkingSetBuffer(api, handle, workingSetBytes, pageSize) {
  const estimatedEntries = Math.ceil(workingSetBytes / pageSize);
  let size = Math.max(64 * 1024, estimatedEntries * 8 + 64 * 1024);
  while (size <= MAX_WORKING_SET_BUFFER_BYTES) {
    const buffer = Buffer.alloc(size);
    if (api.queryWorkingSet(handle, buffer, buffer.length)) return buffer;
    const error = api.getLastError();
    if (error !== 24 || size === MAX_WORKING_SET_BUFFER_BYTES) {
      throw new Error(`QueryWorkingSet failed (Windows error ${error}).`);
    }
    size = Math.min(size * 2, MAX_WORKING_SET_BUFFER_BYTES);
  }
  throw new Error("QueryWorkingSet exceeded the 64 MiB diagnostic buffer limit.");
}

function classifyPageRegions(api, handle, pages, pageSize) {
  pages.sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  const entries = [];
  const info = Buffer.alloc(api.mbiSize);
  let i = 0;
  while (i < pages.length) {
    const start = pages[i].address;
    const resultSize = api.virtualQueryEx(handle, start, info, info.length);
    if (resultSize !== api.mbiSize) {
      throw new Error(`VirtualQueryEx failed for a working-set page (Windows error ${api.getLastError()}).`);
    }
    const regionBase = info.readBigUInt64LE(0);
    const regionSize = info.readBigUInt64LE(24);
    const regionEnd = regionBase + regionSize;
    const state = info.readUInt32LE(32);
    const type = info.readUInt32LE(40);
    if (start < regionBase || regionEnd <= start) {
      throw new Error("VirtualQueryEx returned an invalid working-set region.");
    }
    const regionType = state === MEM_COMMIT
      ? REGION_NAMES.get(type) ?? `UNKNOWN_0x${type.toString(16)}`
      : `UNKNOWN_STATE_0x${state.toString(16)}`;
    while (i < pages.length && pages[i].address < regionEnd) {
      entries.push({ shareable: pages[i].shareable, shareCount: pages[i].shareCount, regionType });
      i++;
    }
  }
  if (entries.length !== pages.length || entries.length * pageSize <= 0) {
    throw new Error("Working-set page classification did not conserve the snapshot.");
  }
  return entries;
}

function main() {
  try {
    if (process.argv[2] === "--help") {
      process.stdout.write("Usage: node inspect-working-set.mjs [--pid <positive-integer>]\n");
      return;
    }
    const { pid } = parseInspectArgs(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(inspectWorkingSet(pid), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
