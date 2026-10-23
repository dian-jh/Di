import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { getHeapStatistics } from "node:v8";

let cachedWindowsSampler;
let cachedMacSampler;

function windowsSampler() {
  if (cachedWindowsSampler) return cachedWindowsSampler;
  const koffi = createRequire(import.meta.url)("koffi");
  const kernel = koffi.load("kernel32.dll");
  const psapi = koffi.load("psapi.dll");
  const countersType = koffi.struct("DI_PROCESS_MEMORY_COUNTERS_EX", {
    cb: "uint32_t", PageFaultCount: "uint32_t", PeakWorkingSetSize: "size_t", WorkingSetSize: "size_t",
    QuotaPeakPagedPoolUsage: "size_t", QuotaPagedPoolUsage: "size_t", QuotaPeakNonPagedPoolUsage: "size_t",
    QuotaNonPagedPoolUsage: "size_t", PagefileUsage: "size_t", PeakPagefileUsage: "size_t", PrivateUsage: "size_t",
  });
  const currentProcess = kernel.func("void * __stdcall GetCurrentProcess(void)");
  const getHandleCount = kernel.func("int __stdcall GetProcessHandleCount(void *hProcess, _Out_ uint32_t *pdwHandleCount)");
  const getMemoryInfo = psapi.func("int __stdcall GetProcessMemoryInfo(void *Process, _Inout_ DI_PROCESS_MEMORY_COUNTERS_EX *ppsmemCounters, uint32_t cb)");
  cachedWindowsSampler = () => {
    const processHandle = currentProcess();
    const handleOut = [null];
    if (!getHandleCount(processHandle, handleOut)) throw new Error("GetProcessHandleCount failed");
    const counters = { cb: koffi.sizeof(countersType) };
    if (!getMemoryInfo(processHandle, counters, counters.cb)) throw new Error("GetProcessMemoryInfo failed");
    return {
      os_handle_count: Number(handleOut[0]),
      working_set_bytes: Number(counters.WorkingSetSize),
      peak_working_set_bytes: Number(counters.PeakWorkingSetSize),
      private_bytes: Number(counters.PrivateUsage),
    };
  };
  return cachedWindowsSampler;
}

function kibibytes(status, name) {
  const match = status.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, "m"));
  return match ? Number(match[1]) * 1024 : null;
}

function linuxMetrics() {
  const status = readFileSync("/proc/self/status", "utf8");
  const workingSet = kibibytes(status, "VmRSS");
  const peakWorkingSet = kibibytes(status, "VmHWM");
  if (workingSet === null || peakWorkingSet === null) throw new Error("Linux process status fields unavailable");
  const descriptors = readdirSync("/proc/self/fd").length;
  let privateBytes = null;
  try {
    const rollup = readFileSync("/proc/self/smaps_rollup", "utf8");
    const privateClean = kibibytes(rollup, "Private_Clean") ?? 0;
    const privateDirty = kibibytes(rollup, "Private_Dirty") ?? 0;
    const privateHuge = kibibytes(rollup, "Private_Hugetlb") ?? 0;
    privateBytes = privateClean + privateDirty + privateHuge;
  } catch { /* smaps_rollup may be restricted; do not substitute an estimate. */ }
  return {
    os_handle_count: Math.max(0, descriptors - 1), // readdir's own transient descriptor
    working_set_bytes: workingSet,
    peak_working_set_bytes: peakWorkingSet,
    private_bytes: privateBytes,
  };
}

function macSampler() {
  if (cachedMacSampler) return cachedMacSampler;
  const koffi = createRequire(import.meta.url)("koffi");
  const libproc = koffi.load("/usr/lib/libproc.dylib");
  const procTaskInfo = koffi.struct("DI_PROC_TASKINFO", {
    pti_virtual_size: "uint64_t", pti_resident_size: "uint64_t", pti_total_user: "uint64_t", pti_total_system: "uint64_t",
    pti_threads_user: "uint64_t", pti_threads_system: "uint64_t", pti_policy: "int32_t", pti_faults: "int32_t",
    pti_pageins: "int32_t", pti_cow_faults: "int32_t", pti_messages_sent: "int32_t", pti_messages_received: "int32_t",
    pti_syscalls_mach: "int32_t", pti_syscalls_unix: "int32_t", pti_csw: "int32_t", pti_threadnum: "int32_t",
    pti_numrunning: "int32_t", pti_priority: "int32_t",
  });
  const procFdInfo = koffi.struct("DI_PROC_FDINFO", { proc_fd: "int32_t", proc_fdtype: "uint32_t" });
  const procPidInfo = libproc.func("int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ uint8_t *buffer, int buffersize)");
  const recordSize = koffi.sizeof(procFdInfo);
  const taskSize = koffi.sizeof(procTaskInfo);
  cachedMacSampler = () => {
    const taskBuffer = Buffer.alloc(taskSize);
    if (procPidInfo(process.pid, 4, 0, taskBuffer, taskSize) !== taskSize) throw new Error("PROC_PIDTASKINFO unavailable");
    const task = koffi.decode(taskBuffer, procTaskInfo);
    const maxBufferSize = 16 * 1024 * 1024;
    let fdCount;
    for (let capacity = recordSize * 128; capacity <= maxBufferSize; capacity *= 2) {
      const fdBuffer = Buffer.alloc(capacity);
      const bytes = procPidInfo(process.pid, 1, 0, fdBuffer, capacity);
      if (bytes <= 0 || bytes > capacity || bytes % recordSize !== 0) throw new Error("PROC_PIDLISTFDS unavailable");
      if (bytes < capacity) {
        fdCount = bytes / recordSize;
        break;
      }
    }
    if (fdCount === undefined) throw new Error("PROC_PIDLISTFDS result exceeds diagnostic buffer");
    return {
      os_handle_count: fdCount,
      working_set_bytes: Number(task.pti_resident_size),
      peak_working_set_bytes: null,
      private_bytes: null,
    };
  };
  return cachedMacSampler;
}

/** Test-only process diagnostics; unsupported or unavailable OS metrics stay null. */
export function sampleProcessMetrics({
  platform = process.platform,
  sampleWindows = () => windowsSampler()(),
  sampleLinux = linuxMetrics,
  sampleMac = () => macSampler()(),
} = {}) {
  const jsHandles = typeof process._getActiveHandles === "function" ? process._getActiveHandles().length : null;
  const heap = getHeapStatistics();
  const sample = {
    js_handle_count: jsHandles,
    os_handle_count: null,
    working_set_bytes: null,
    peak_working_set_bytes: null,
    private_bytes: null,
    native_metrics_error: null,
    v8_total_heap_size_bytes: heap.total_heap_size,
    v8_total_physical_size_bytes: heap.total_physical_size,
    v8_malloced_memory_bytes: heap.malloced_memory,
    v8_peak_malloced_memory_bytes: heap.peak_malloced_memory,
  };
  try {
    let native;
    if (platform === "win32") native = sampleWindows();
    else if (platform === "linux") native = sampleLinux();
    else if (platform === "darwin") native = sampleMac();
    else {
      sample.native_metrics_error = `native process metrics unsupported on ${platform}`;
      return sample;
    }
    Object.assign(sample, native);
  } catch {
    sample.native_metrics_error = "native process metrics unavailable";
  }
  return sample;
}
