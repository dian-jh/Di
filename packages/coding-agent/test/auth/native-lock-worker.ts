import { NativeOsLockProvider } from "../../src/core/auth/lock-provider.ts";

const provider = new NativeOsLockProvider();
process.stdout.write("ATTEMPTING\n");
const handle = await provider.acquire(process.argv[2]!);
process.stdout.write("ACQUIRED\n");
process.stdin.resume();
process.on("SIGTERM", async () => {
  await handle.release();
  process.exit(0);
});
