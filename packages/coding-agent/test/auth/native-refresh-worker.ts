import { ChatGptAuth } from "../../src/core/auth/chatgpt-auth.ts";
import { CredentialStore } from "../../src/core/auth/credential-store.ts";
import { NativeOsLockProvider } from "../../src/core/auth/lock-provider.ts";

const store = new CredentialStore({
  lock: new NativeOsLockProvider({ retryDelayMs: 15 }),
  acl: { secureDirectory: async () => {}, secureFile: async () => {} },
  directory: process.argv[2]!,
});
const endpoint = process.argv[3]!;
const auth = new ChatGptAuth(store, {
  http: async (_url, init) => fetch(endpoint, { method: init?.method, headers: init?.headers, body: init?.body, signal: init?.signal }),
});
process.stdout.write(`TOKEN=${await auth.accessToken()}\n`);
