<#
  di global command installer:
    1) build the TS workspace (npm ci + npm run build at the repo root)
    2) install the TS CLI runtime to <diHome>/ts-cli/node_modules/...
    3) install the explicit `di-ts` launcher and default `di` alias
    4) optionally append <diHome>/bin to the user PATH (idempotent)
    5) smoke-test di-ts --info against an isolated TEMP DI_HOME and print the
       written files / exit codes as install evidence

  The installer recreates <diHome>/ts-cli and writes launchers under
  <diHome>/bin. It does not modify config.json, sessions, skills, commands,
  auth/credentials, or unrelated files under <diHome>/bin.

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
$PlatformIsWindows = $env:OS -eq "Windows_NT"
$CliEntry = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $RepoRoot "packages") "coding-agent") "dist") "cli") "main.js"
$InstalledEntry = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $TsNodeModules "@di") "coding-agent") "dist") "cli") "main.js"

if ($PlatformIsWindows) {
    $shadowingExe = Join-Path $TargetBin "di.exe"
    if (Test-Path -LiteralPath $shadowingExe -PathType Leaf) {
        throw "Existing executable blocks the default di launcher: $shadowingExe. Remove or rename it before installing."
    }
}

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

Write-Host "=== di TypeScript installer ==="
Write-Host "  DiHome (install root): $DiHome"

# ---------------------------------------------------------------- 1/5 build
if ($SkipBuild) {
    Write-Host "[1/5] Skipping TS workspace build (-SkipBuild)."
    if (-not (Test-Path $CliEntry)) {
        throw "dist/cli/main.js missing: $CliEntry (run npm run build first, or drop -SkipBuild)"
    }
}
else {
    Write-Host "[1/5] Building TS workspace (npm ci + npm run build)..."
    $npmCommand = if ($PlatformIsWindows) { "npm.cmd" } else { "npm" }
    $npm = Get-Command $npmCommand -ErrorAction SilentlyContinue
    if (-not $npm) { throw "$npmCommand not found on PATH - cannot build the TS workspace." }
    Push-Location $RepoRoot
    try {
        & $npmCommand ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
        Write-Host "  npm ci exit: $LASTEXITCODE"
        & $npmCommand run build
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

# --------------------------------------------------- 2/5 install TS runtime
Write-Host "[2/5] Installing TS CLI runtime to $TsHome (recreated on reinstall)..."
if (Test-Path $TsHome) { Remove-Item -Recurse -Force $TsHome }
New-Item -ItemType Directory -Force -Path $TsHome | Out-Null
Copy-Tree (Join-Path (Join-Path $RepoRoot "packages") "coding-agent") (Join-Path (Join-Path $TsNodeModules "@di") "coding-agent")
Copy-Tree (Join-Path (Join-Path $RepoRoot "packages") "ai") (Join-Path (Join-Path $TsNodeModules "@di") "ai")
Copy-Tree (Join-Path (Join-Path $RepoRoot "packages") "agent") (Join-Path (Join-Path $TsNodeModules "@di") "agent")
Copy-Tree (Join-Path $RepoRoot "tui") (Join-Path $TsNodeModules "di-tui")
# Third-party runtime deps (all leaf packages at the repo root node_modules):
Copy-Tree (Join-Path (Join-Path $RepoRoot "node_modules") "jsonc-parser") (Join-Path $TsNodeModules "jsonc-parser")
Copy-Tree (Join-Path (Join-Path (Join-Path $RepoRoot "node_modules") "@earendil-works") "pi-tui") (Join-Path (Join-Path $TsNodeModules "@earendil-works") "pi-tui")
Copy-Tree (Join-Path (Join-Path $RepoRoot "node_modules") "marked") (Join-Path $TsNodeModules "marked")
Copy-Tree (Join-Path (Join-Path $RepoRoot "node_modules") "get-east-asian-width") (Join-Path $TsNodeModules "get-east-asian-width")
Copy-Tree (Join-Path (Join-Path $RepoRoot "node_modules") "iconv-lite") (Join-Path $TsNodeModules "iconv-lite")
Copy-Tree (Join-Path (Join-Path $RepoRoot "node_modules") "safer-buffer") (Join-Path $TsNodeModules "safer-buffer")
Copy-Tree (Join-Path (Join-Path $RepoRoot "node_modules") "koffi") (Join-Path $TsNodeModules "koffi")
Copy-Tree (Join-Path (Join-Path $RepoRoot "node_modules") "undici") (Join-Path $TsNodeModules "undici")
if (-not (Test-Path $InstalledEntry)) {
    throw "installed CLI entry missing after copy: $InstalledEntry"
}

# ----------------------------------------------------- 3/5 install launchers
Write-Host "[3/5] Installing di-ts launchers to $TargetBin ..."
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
$posixLauncher = Join-Path $TargetBin "di-ts"
if (-not $PlatformIsWindows) {
    & chmod 755 $posixLauncher
    if ($LASTEXITCODE -ne 0) { throw "Could not mark POSIX launcher executable: $posixLauncher" }
}

Write-Host "  Data safety: config.json / sessions / skills / commands / auth under $DiHome are NOT touched by this script."

# ------------------------------------------------------- 4/5 PATH (optional)
Write-Host "[4/5] Ensuring $TargetBin is on the user PATH (idempotent)..."
if ($PlatformIsWindows -and -not $SkipPathUpdate) {
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
elseif (-not $PlatformIsWindows) {
    Write-Host "  Shell profiles are not modified. Add this directory to PATH if desired:"
    Write-Host ("    export PATH=`"{0}:`$PATH`"" -f $TargetBin)
    Write-Host "  The installer continues without changing the current user environment."
}
else {
    Write-Host "  Skipped (-SkipPathUpdate). Invoke di-ts by full path: $(Join-Path $TargetBin 'di-ts.cmd')"
}

# ----------------------------------------------- 5/5 smoke test + evidence
Write-Host "[5/5] Smoke test: di-ts --info (isolated TEMP DI_HOME, no real config touched)..."
$smokeHome = Join-Path ([System.IO.Path]::GetTempPath()) ("di-ts-install-smoke-" + [guid]::NewGuid().ToString("N"))
$smokeExit = -1
$oldDiHome = [Environment]::GetEnvironmentVariable("DI_HOME", "Process")
$oldDeepSeekApiKey = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "Process")
$env:DI_HOME = $smokeHome
$env:DEEPSEEK_API_KEY = ""
$smokeLauncher = if ($PlatformIsWindows) { Join-Path $TargetBin "di-ts.cmd" } else { Join-Path $TargetBin "di-ts" }
try {
    & $smokeLauncher --info
    $smokeExit = $LASTEXITCODE
}
finally {
    Remove-Item -Recurse -Force $smokeHome -ErrorAction SilentlyContinue
    [Environment]::SetEnvironmentVariable("DI_HOME", $oldDiHome, "Process")
    [Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", $oldDeepSeekApiKey, "Process")
}
if ($smokeExit -ne 0) { throw "di-ts --info smoke test failed (exit $smokeExit)" }

# Install the default global command alongside the explicit alias.
Write-Host "[default] Installing the global di shim for TypeScript..."
$defaultShim = if ($PlatformIsWindows) { Join-Path $TargetBin "di.cmd" } else { Join-Path $TargetBin "di" }
if (Test-Path -LiteralPath $defaultShim -PathType Leaf) {
    $oldContent = [IO.File]::ReadAllText($defaultShim)
    $isOurShim = if ($PlatformIsWindows) { $oldContent -match 'di-ts\.cmd' } else { $oldContent -match '\$DIR/di-ts' }
    if (-not $isOurShim) { throw "Refusing to overwrite an unmanaged di launcher: $defaultShim" }
}
if ($PlatformIsWindows) {
    $defaultContent = "@echo off`r`ncall `"%~dp0di-ts.cmd`" %*`r`nexit /b %ERRORLEVEL%`r`n"
} else {
$defaultContent = "#!/bin/sh`nDIR=`"`$(CDPATH= cd -- `"`$(dirname -- `"`$0`")`" && pwd)`"`nexec `"`$DIR/di-ts`" `"`$@`"`n"
}
Write-TextFile $defaultShim $defaultContent
if (-not $PlatformIsWindows) {
    & chmod 755 $defaultShim
    if ($LASTEXITCODE -ne 0) { throw "Could not mark TypeScript di launcher executable: $defaultShim" }
}
Write-Host ""
Write-Host "=== Install evidence ==="
Write-Host "  di-ts launchers:   $(Join-Path $TargetBin 'di-ts.cmd') / $(Join-Path $TargetBin 'di-ts')"
Write-Host "  TS runtime root:   $TsHome"
Write-Host "  CLI entry:         $InstalledEntry"
Write-Host "  Smoke test:        di-ts --info exit $smokeExit"
Write-Host "  Files written:"
foreach ($f in $writtenFiles) { Write-Host "    $f" }
Write-Host "  Untouched:         config.json, sessions, skills, commands, auth and unrelated bin files"
Write-Host ""
Write-Host "Done. In a new terminal:"
Write-Host "  di-ts --info      # TypeScript CLI"
Write-Host "  di --info         # TypeScript CLI (default command)"
