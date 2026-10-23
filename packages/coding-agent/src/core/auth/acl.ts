import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod as fsChmod, stat as fsStat } from "node:fs/promises";
import { userInfo } from "node:os";

/*
 * Owner-only ACL adapter.
 *
 * Windows: set + read back a current-user-only DACL via the `icacls` subprocess
 * ( §3b proved readback works). Node `stat.mode` on NTFS is
 * NEVER used as the verification channel — the probe (§3a/§3b) proved it always
 * reads `0o100666` regardless of the real DACL, so it cannot distinguish a
 * restricted file from an open one.
 *
 * POSIX: chmod 0700 directory / 0600 file with `stat.mode` readback (valid on a
 * real POSIX filesystem).
 *
 * Fail-closed contract: any failure to apply OR verify the protection surfaces
 * {@link AclError}, and the credential store refuses to write the token (the old
 * file is preserved). The contract forbids "log a warning and keep claiming
 * safety-equivalence".
 *
 * The `chmod`/`stat`/`run` seams are injectable so the POSIX branch and the
 * icacls failure path are testable on any host; defaults use real fs/icacls.
 */

/** Fail-closed signal: the protection could not be applied or verified. */
export class AclError extends Error {
  readonly code = "acl-failed" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AclError";
  }
}

export interface AclAdapter {
  /** Secure + verify a credentials directory (Windows: current-user-only inheriting DACL; POSIX: 0700). */
  secureDirectory(path: string): Promise<void>;
  /** Secure + verify a credential file (Windows: current-user-only DACL; POSIX: 0600). */
  secureFile(path: string): Promise<void>;
}

type RunCommand = (file: string, args: readonly string[]) => Promise<{ stdout: Buffer | string }>;

export interface AclAdapterOptions {
  /** Windows account name for the icacls grant; defaults to `os.userInfo.username`. */
  readonly winUser?: string;
  /** Override the effective platform (testability). Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** icacls executable name (testability). Defaults to `"icacls"`. */
  readonly icacls?: string;
  /** Subprocess runner (testability). Defaults to a promisified `execFile`. */
  readonly run?: RunCommand;
  /** POSIX chmod (testability). Defaults to `fs.promises.chmod`. */
  readonly chmod?: (path: string, mode: number) => Promise<void>;
  /** POSIX stat (testability). Defaults to `fs.promises.stat`. */
  readonly stat?: (path: string) => Promise<{ mode: number }>;
}

const execFileAsync = promisify(execFile);

/** Decode icacls output (GBK on the Windows console code page); ASCII ACE lines decode cleanly either way. */
function decodeOutput(stdout: Buffer | string, win32: boolean): string {
  if (typeof stdout === "string") return stdout;
  if (win32) return new TextDecoder("gbk").decode(stdout);
  return stdout.toString("utf8");
}

export function createAclAdapter(options: AclAdapterOptions = {}): AclAdapter {
  const platform = options.platform ?? process.platform;
  const win32 = platform === "win32";
  const winUser = options.winUser ?? userInfo().username;
  const icacls = options.icacls ?? "icacls";
  const run: RunCommand =
    options.run ?? (async (file, args) => (await execFileAsync(file, [...args], { windowsHide: true })) as unknown as { stdout: Buffer });
  const chmod = options.chmod ?? fsChmod;
  const stat = options.stat ?? fsStat;

  /** Run an icacls command; any subprocess failure becomes a fail-closed AclError. */
  const runIcacls = async (path: string, args: readonly string[]): Promise<string> => {
    try {
      return decodeOutput((await run(icacls, [path, ...args])).stdout, true);
    } catch (error) {
      throw new AclError(`Windows ACL failed for ${path}: ${errorMessage(error)}`, { cause: error });
    }
  };

  /** Verify a readback shows the user's ACE carrying every required token. */
  const verifyReadback = (path: string, what: string, text: string): void => {
    if (!hasAce(text, winUser, what)) {
      throw new AclError(`Windows ACL verify failed for ${path}: expected owner ACE ${what}`);
    }
  };

  async function secureDirectory(path: string): Promise<void> {
    if (win32) {
      // Grant: current-user-only inheriting FullControl, replacing any inherited ACEs.
      await runIcacls(path, ["/inheritance:r", "/grant:r", `${winUser}:(OI)(CI)F`]);
      // Read back and verify the ACE list (probe §3b: readback proves the DACL).
      verifyReadback(path, "(OI)(CI)F", await runIcacls(path, []));
    } else {
      await chmod(path, 0o700);
      const mode = (await stat(path)).mode & 0o777;
      if (mode !== 0o700) throw new AclError(`POSIX mode verify failed for directory ${path}: expected 0700, got ${mode.toString(8)}`);
    }
  }

  async function secureFile(path: string): Promise<void> {
    if (win32) {
      await runIcacls(path, ["/inheritance:r", "/grant:r", `${winUser}:F`]);
      verifyReadback(path, "(F)", await runIcacls(path, []));
    } else {
      await chmod(path, 0o600);
      const mode = (await stat(path)).mode & 0o777;
      if (mode !== 0o600) throw new AclError(`POSIX mode verify failed for file ${path}: expected 0600, got ${mode.toString(8)}`);
    }
  }

  return { secureDirectory, secureFile };
}

/**
 * True when `text` contains an ACE line for the user carrying every required
 * token. The bare `winUser` is a substring of the resolved `DOMAIN\user`, so a
 * readback that resolved the account still matches.
 */
function hasAce(text: string, winUser: string, tokens: string): boolean {
  if (winUser.length === 0) return false;
  // "(OI)(CI)F" → ["(OI", "(CI", "F"]; "(F)" → ["(F"].
  const required = tokens
    .split(")")
    .map((t) => t + ")")
    .filter((t) => t.length > 1);
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(winUser)) continue;
    if (required.every((t) => line.includes(t))) return true;
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
