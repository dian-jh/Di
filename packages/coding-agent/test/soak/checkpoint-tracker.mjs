import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

const DEFAULT_BUFFER_SIZE = 64 * 1024;

/** Incrementally count newline bytes using one reusable fixed-size buffer. */
export function makeCheckpointTracker({ bufferSize = DEFAULT_BUFFER_SIZE, allocate = Buffer.allocUnsafe } = {}) {
  if (!Number.isInteger(bufferSize) || bufferSize < 1) {
    throw new RangeError(`bufferSize must be a positive integer; got ${bufferSize}`);
  }
  const buffer = allocate(bufferSize);
  const cp = { offset: 0, lines: 0 };

  return function sampleCheckpoint(path) {
    if (!existsSync(path)) {
      cp.offset = 0;
      cp.lines = 0;
      return { bytes: 0, lines: 0 };
    }
    const size = statSync(path).size;
    if (size < cp.offset) {
      cp.offset = 0;
      cp.lines = 0;
    }
    if (size > cp.offset) {
      const fd = openSync(path, "r");
      try {
        while (cp.offset < size) {
          const wanted = Math.min(buffer.length, size - cp.offset);
          const read = readSync(fd, buffer, 0, wanted, cp.offset);
          if (read === 0) break;
          for (let i = 0; i < read; i += 1) {
            if (buffer[i] === 0x0a) cp.lines += 1;
          }
          cp.offset += read;
        }
      } finally {
        closeSync(fd);
      }
    }
    return { bytes: size, lines: cp.lines };
  };
}
