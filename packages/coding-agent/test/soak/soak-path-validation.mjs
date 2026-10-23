import { dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function validateSoakPaths({ mode, diHome, out, workspace, repo, home = homedir() }) {
  const required = mode === "child" ? ["--di-home", diHome, "--workspace", workspace, "--out", out]
    : ["--di-home", diHome, "--out", out, "--workspace", workspace];
  for (let i = 0; i < required.length; i += 2) {
    const flag = required[i];
    const value = required[i + 1];
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${flag} is required and must be a non-empty path`);
    if (value.startsWith("--")) throw new Error(`${flag} requires a path value before the next option ${value}`);
  }

  const resolvedHome = resolve(diHome);
  const resolvedOut = resolve(out);
  const resolvedWorkspace = resolve(workspace);
  const resolvedRepo = resolve(repo);
  const artifactRoot = resolve(dirname(resolvedOut));
  if (samePath(resolvedHome, artifactRoot) || !isWithin(artifactRoot, resolvedHome)) {
    throw new Error(`--di-home must be inside the artifact run root (${artifactRoot}); received ${resolvedHome}`);
  }

  const resolvedProfile = resolve(home);
  const protectedPaths = [resolvedProfile, resolve(home, ".di")];
  for (const protectedPath of protectedPaths) {
    if (samePath(resolvedHome, protectedPath) || isWithin(resolvedHome, protectedPath)) {
      throw new Error(`--di-home overlaps a protected profile path (${protectedPath}): ${resolvedHome}`);
    }
  }
  for (const protectedPath of [resolvedRepo, resolvedWorkspace]) {
    if (pathsOverlap(resolvedHome, protectedPath)) {
      throw new Error(`--di-home overlaps the repository/workspace (${protectedPath}): ${resolvedHome}`);
    }
  }
  return { diHome: resolvedHome, out: resolvedOut, workspace: resolvedWorkspace };
}
