<#
  di global command installer (P9-release-install-rollback):
    1) build the TS workspace (npm ci + npm run build at the repo root)
    2) install the TS CLI runtime to <diHome>/ts-cli/node_modules/...
    3) install the `di-ts` launcher and, when requested, make `di` launch TS
    4) optionally remove known C# launchers in <diHome>/bin after TS smoke passes
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
    -UseAsDefault     install a di shim that invokes the installed TypeScript CLI
    -RemoveCSharp     with -UseAsDefault, remove di.exe/di.exe.bak-*/di-csharp.exe
                      (Windows) or di-csharp (POSIX) after the TS smoke test
#>
[CmdletBinding()]
param(
    [string]$DiHome = (Join-Path $HOME ".di"),
    [switch]$SkipPathUpdate,
    [switch]$SkipBuild,
    [switch]$UseAsDefault,
    [switch]$RemoveCSharp
)
$ErrorActionPreference = "Stop"
if ($RemoveCSharp -and -not $UseAsDefault) { throw "-RemoveCSharp requires -UseAsDefault." }

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$TargetBin = Join-Path $DiHome "bin"
$TsHome = Join-Path $DiHome "ts-cli"
$TsNodeModules = Join-Path $TsHome "node_modules"
$PlatformIsWindows = $env:OS -eq "Windows_NT"
$CliEntry = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $RepoRoot "packages") "coding-agent") "dist") "cli") "main.js"
$InstalledEntry = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $TsNodeModules "@di") "coding-agent") "dist") "cli") "main.js"

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

# --------------------------------------------------- 2/6 install TS runtime
Write-Host "[2/6] Installing TS CLI runtime to $TsHome (recreated on reinstall)..."
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
$posixLauncher = Join-Path $TargetBin "di-ts"
if (-not $PlatformIsWindows) {
    & chmod 755 $posixLauncher
    if ($LASTEXITCODE -ne 0) { throw "Could not mark POSIX launcher executable: $posixLauncher" }
}

# -------------------------------------------------------- 4/6 default preflight
Write-Host "[4/6] Checking default command selection..."
if ($UseAsDefault -and $PlatformIsWindows) {
    foreach ($name in @("di.com", "di.bat", "di.ps1")) {
        $shadow = Join-Path $TargetBin $name
        if (Test-Path -LiteralPath $shadow -PathType Leaf) { throw "A higher-priority Windows launcher blocks the TypeScript default: $shadow" }
    }
    if ((Test-Path -LiteralPath (Join-Path $TargetBin "di.exe") -PathType Leaf) -and -not $RemoveCSharp) {
        throw "A C# di.exe blocks the TypeScript default; rerun with -RemoveCSharp."
    }
}
if (-not $UseAsDefault) { Write-Host "  Keeping the existing default command; installed di-ts remains available." }
Write-Host "  Data safety: config.json / sessions / skills / commands / auth under $DiHome are NOT touched by this script."

# ------------------------------------------------------- 5/6 PATH (optional)
Write-Host "[5/6] Ensuring $TargetBin is on the user PATH (idempotent)..."
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

# ----------------------------------------------- 6/6 smoke test + evidence
Write-Host "[6/6] Smoke test: di-ts --info (isolated TEMP DI_HOME, no real config touched)..."
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

# Remove only known C# launcher names, and only after the replacement TS CLI has
# passed its isolated smoke test. Other executables and user data are untouched.
if ($RemoveCSharp) {
    Write-Host "[cleanup] Removing explicitly managed C# launchers from $TargetBin ..."
}
if ($UseAsDefault) {
    $defaultShim = if ($PlatformIsWindows) { Join-Path $TargetBin "di.cmd" } else { Join-Path $TargetBin "di" }
    if (Test-Path -LiteralPath $defaultShim -PathType Leaf) {
        $oldContent = [IO.File]::ReadAllText($defaultShim)
        $isOurShim = if ($PlatformIsWindows) { $oldContent -match 'di-ts\.cmd' } else { $oldContent -match '\$DIR/di-ts' }
        if (-not $isOurShim -and -not ($RemoveCSharp -and -not $PlatformIsWindows)) {
            throw "Refusing to overwrite an unmanaged di launcher: $defaultShim"
        }
    }
}
if ($RemoveCSharp) {
    $selectionState = Join-Path $TargetBin ".di-cli-selection.json"
    if (Test-Path -LiteralPath $selectionState -PathType Leaf) {
        try { $oldSelection = Get-Content -LiteralPath $selectionState -Raw | ConvertFrom-Json }
        catch { throw "Refusing C# cleanup because selector state is unreadable: $selectionState" }
        if ($oldSelection.version -ne 1 -or $oldSelection.runtime -ne "typescript") {
            throw "Refusing C# cleanup because selector state is not a recognized TypeScript selection: $selectionState"
        }
    }
    $csharpPaths = @()
    if ($PlatformIsWindows) {
        $csharpPaths += Join-Path $TargetBin "di.exe"
        $csharpPaths += Join-Path $TargetBin "di"
        $csharpPaths += Join-Path $TargetBin "di-csharp.exe"
        $csharpPaths += @(Get-ChildItem -LiteralPath $TargetBin -File -Filter "di.exe.bak-*" | ForEach-Object { $_.FullName })
    } else {
        $csharpPaths += Join-Path $TargetBin "di-csharp"
    }
    foreach ($candidate in $csharpPaths) {
        $resolved = [IO.Path]::GetFullPath($candidate)
        $prefix = [IO.Path]::GetFullPath($TargetBin).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing C# cleanup outside DI_HOME/bin: $resolved" }
        if (Test-Path -LiteralPath $resolved -PathType Leaf) {
            Remove-Item -LiteralPath $resolved -Force
            Write-Host "  REMOVED $resolved"
        }
    }
    if (Test-Path -LiteralPath $selectionState -PathType Leaf) {
        Remove-Item -LiteralPath $selectionState -Force
        Write-Host "  REMOVED obsolete selector state $selectionState"
    }
}

# Only switch the default after the TS smoke and explicit cleanup both succeed.
if ($UseAsDefault) {
    Write-Host "[default] Installing the global di shim for TypeScript..."
    $defaultShim = if ($PlatformIsWindows) { Join-Path $TargetBin "di.cmd" } else { Join-Path $TargetBin "di" }
    if ($PlatformIsWindows) {
        $defaultContent = "@echo off`r`ncall `"%~dp0di-ts.cmd`" %*`r`nexit /b %ERRORLEVEL%`r`n"
    } else {
        $defaultContent = "#!/bin/sh`nDIR=`$(CDPATH= cd -- `"`$(dirname -- `"`$0`")`" && pwd)`nexec `"`$DIR/di-ts`" `"`$@`"`n"
    }
    Write-TextFile $defaultShim $defaultContent
    if (-not $PlatformIsWindows) {
        & chmod 755 $defaultShim
        if ($LASTEXITCODE -ne 0) { throw "Could not mark TypeScript di launcher executable: $defaultShim" }
    }
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
if ($UseAsDefault) { Write-Host "  di --info         # TypeScript CLI (default command)" }
