<#
  di global command installer (P9-release-install-rollback):
    1) build the TS workspace (npm ci + npm run build at the repo root)
    2) install the TS CLI runtime to <diHome>/ts-cli/node_modules/...
    3) install the `di-ts` launcher (di-ts.cmd for Windows, di-ts shim for POSIX)
       to <diHome>/bin/ - the production CLI is di-ts -> dist/cli/main.js
    4) PRESERVE any existing C# di binary - di/di.exe in <diHome>/bin is never
       moved, deleted or overwritten (C# stays the default until migration done)
    5) optionally append <diHome>/bin to the user PATH (idempotent)
    6) smoke-test di-ts --info against an isolated TEMP DI_HOME and print the
       written files / exit codes as install evidence

  Data safety (validation-and-release.md 120-128): this script NEVER moves,
  deletes or rewrites <diHome>/config.json, sessions, skills, commands or
  auth/credentials. The only directories it writes are <diHome>/bin (the
  di-ts launchers) and <diHome>/ts-cli (the private TS runtime copy), both of
  which this script owns and recreates on reinstall.

  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 without a
  BOM as the ANSI codepage (GBK 936); UTF-8 non-ASCII bytes become mojibake.

  Usage (from repo root):
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -DiHome <path> -SkipPathUpdate
  Parameters:
    -DiHome <path>    install target root (default $HOME\.di); isolated drill/CI
                      installs pass a temp path so no real user data is read
    -SkipPathUpdate   do NOT append <DiHome>/bin to the user PATH (isolated/drill
                      installs use this; the default appends the dir idempotently)
    -SkipBuild        skip the npm build step (uses an already-built dist;
                      requires packages/coding-agent/dist/cli/main.js to exist)
#>
[CmdletBinding()]
param(
    [string]$DiHome = (Join-Path $HOME ".di"),
    [switch]$SkipPathUpdate,
    [switch]$SkipBuild
)
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$TargetBin = Join-Path $DiHome "bin"
$TsHome = Join-Path $DiHome "ts-cli"
$TsNodeModules = Join-Path $TsHome "node_modules"
$CliEntry = Join-Path $RepoRoot "packages\coding-agent\dist\cli\main.js"
$InstalledEntry = Join-Path $TsNodeModules "@di\coding-agent\dist\cli\main.js"

$writtenFiles = New-Object System.Collections.Generic.List[string]

function Write-TextFile($path, $content) {
    # ASCII, LF line endings: safe for both the .cmd shim and the POSIX sh shim.
    [System.IO.File]::WriteAllText($path, $content, [System.Text.Encoding]::ASCII)
    $writtenFiles.Add($path)
}

function Copy-Tree($src, $dst) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -Force -Recurse $src $dst
    $writtenFiles.Add($dst)
}

Write-Host "=== di-ts installer (P9) ==="
Write-Host "  DiHome (install root): $DiHome"

# ---------------------------------------------------------------- 1/6 build
if ($SkipBuild) {
    Write-Host "[1/6] Skipping TS workspace build (-SkipBuild)."
    if (-not (Test-Path $CliEntry)) {
        throw "dist/cli/main.js missing: $CliEntry (run npm run build first, or drop -SkipBuild)"
    }
}
else {
    Write-Host "[1/6] Building TS workspace (npm ci + npm run build)..."
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { throw "npm.cmd not found on PATH - cannot build the TS workspace." }
    Push-Location $RepoRoot
    try {
        & npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
        Write-Host "  npm ci exit: $LASTEXITCODE"
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)" }
        Write-Host "  npm run build exit: $LASTEXITCODE"
    }
    finally {
        Pop-Location
    }
    if (-not (Test-Path $CliEntry)) {
        throw "dist/cli/main.js missing after build: $CliEntry"
    }
}

# --------------------------------------------------- 2/6 install TS runtime
Write-Host "[2/6] Installing TS CLI runtime to $TsHome (recreated on reinstall)..."
if (Test-Path $TsHome) { Remove-Item -Recurse -Force $TsHome }
New-Item -ItemType Directory -Force -Path $TsHome | Out-Null
Copy-Tree (Join-Path $RepoRoot "packages\coding-agent") (Join-Path $TsNodeModules "@di\coding-agent")
Copy-Tree (Join-Path $RepoRoot "packages\ai") (Join-Path $TsNodeModules "@di\ai")
Copy-Tree (Join-Path $RepoRoot "packages\agent") (Join-Path $TsNodeModules "@di\agent")
Copy-Tree (Join-Path $RepoRoot "tui") (Join-Path $TsNodeModules "di-tui")
# Third-party runtime deps (all leaf packages at the repo root node_modules):
Copy-Tree (Join-Path $RepoRoot "node_modules\jsonc-parser") (Join-Path $TsNodeModules "jsonc-parser")
Copy-Tree (Join-Path $RepoRoot "node_modules\@earendil-works\pi-tui") (Join-Path $TsNodeModules "@earendil-works\pi-tui")
Copy-Tree (Join-Path $RepoRoot "node_modules\marked") (Join-Path $TsNodeModules "marked")
Copy-Tree (Join-Path $RepoRoot "node_modules\get-east-asian-width") (Join-Path $TsNodeModules "get-east-asian-width")
Copy-Tree (Join-Path $RepoRoot "node_modules\iconv-lite") (Join-Path $TsNodeModules "iconv-lite")
Copy-Tree (Join-Path $RepoRoot "node_modules\safer-buffer") (Join-Path $TsNodeModules "safer-buffer")
if (-not (Test-Path $InstalledEntry)) {
    throw "installed CLI entry missing after copy: $InstalledEntry"
}

# ----------------------------------------------------- 3/6 install launchers
Write-Host "[3/6] Installing di-ts launchers to $TargetBin ..."
New-Item -ItemType Directory -Force -Path $TargetBin | Out-Null

# Windows launcher: di-ts.cmd (native .cmd shim; npm-style shims are .cmd too).
$cmdContent = "@echo off`n" +
"where node >nul 2>&1`n" +
"if errorlevel 1 (`n" +
"  echo di-ts: node not found on PATH. Install Node.js 22.19 or newer first. 1>&2`n" +
"  exit /b 1`n" +
")`n" +
"node `"%~dp0..\ts-cli\node_modules\@di\coding-agent\dist\cli\main.js`" %*`n" +
"exit /b %ERRORLEVEL%`n"
Write-TextFile (Join-Path $TargetBin "di-ts.cmd") $cmdContent

# POSIX launcher: di-ts (shim for later non-Windows runs; written now so the
# install layout is cross-platform, but the POSIX soak is a later run).
$shContent = "#!/bin/sh`n" +
"DIR=`"`$(CDPATH= cd -- `"`$(dirname -- `"`$0`")`" && pwd)`"`n" +
"exec node `"`$DIR/../ts-cli/node_modules/@di/coding-agent/dist/cli/main.js`" `"`$@`"`n"
Write-TextFile (Join-Path $TargetBin "di-ts") $shContent

# ------------------------------------------------------- 4/6 preserve C# di
Write-Host "[4/6] Preserving the installed C# di (never overwritten)..."
$preserved = @()
foreach ($name in @("di.exe", "di")) {
    $candidate = Join-Path $TargetBin $name
    if (Test-Path $candidate) { $preserved += $candidate }
}
if ($preserved.Count -gt 0) {
    Write-Host "  PRESERVED (left byte-identical):"
    foreach ($p in $preserved) { Write-Host "    $p" }
}
else {
    Write-Host "  No existing C# di binary under $TargetBin; nothing to preserve."
}
Write-Host "  Data safety: config.json / sessions / skills / commands / auth under $DiHome are NOT touched by this script."

# ------------------------------------------------------- 5/6 PATH (optional)
Write-Host "[5/6] Ensuring $TargetBin is on the user PATH (idempotent)..."
if (-not $SkipPathUpdate) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $normTarget = $TargetBin.TrimEnd("\")
    $already = $userPath -split ";" | Where-Object { $_ -and $_.TrimEnd("\") -ieq $normTarget }
    if ($already) {
        Write-Host "  $TargetBin already on user PATH, skipping."
    }
    else {
        $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $normTarget } else { "$userPath;$normTarget" }
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        Write-Host "  Appended $TargetBin to user PATH (takes effect in a new terminal)."
    }
}
else {
    Write-Host "  Skipped (-SkipPathUpdate). Invoke di-ts by full path: $(Join-Path $TargetBin 'di-ts.cmd')"
}

# ----------------------------------------------- 6/6 smoke test + evidence
Write-Host "[6/6] Smoke test: di-ts --info (isolated TEMP DI_HOME, no real config touched)..."
$smokeHome = Join-Path $env:TEMP ("di-ts-install-smoke-" + [guid]::NewGuid().ToString("N"))
$smokeExit = -1
$env:DI_HOME = $smokeHome
$env:DEEPSEEK_API_KEY = ""
try {
    & (Join-Path $TargetBin "di-ts.cmd") --info
    $smokeExit = $LASTEXITCODE
}
finally {
    Remove-Item -Recurse -Force $smokeHome -ErrorAction SilentlyContinue
    Remove-Item Env:DI_HOME -ErrorAction SilentlyContinue
    Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
}
if ($smokeExit -ne 0) { throw "di-ts --info smoke test failed (exit $smokeExit)" }

Write-Host ""
Write-Host "=== Install evidence ==="
Write-Host "  di-ts launchers:   $(Join-Path $TargetBin 'di-ts.cmd') / $(Join-Path $TargetBin 'di-ts')"
Write-Host "  TS runtime root:   $TsHome"
Write-Host "  CLI entry:         $InstalledEntry"
Write-Host "  Smoke test:        di-ts --info exit $smokeExit"
Write-Host "  Files written:"
foreach ($f in $writtenFiles) { Write-Host "    $f" }
Write-Host "  Untouched:         existing C# di, config.json, sessions, skills, commands, auth"
Write-Host ""
Write-Host "Done. In a new terminal:"
Write-Host "  di-ts --info      # TS CLI (production entry, parallel to C# di)"
Write-Host "  di --version      # existing C# command (unchanged)"
