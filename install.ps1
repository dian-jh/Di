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
$InstallId = [guid]::NewGuid().ToString("N")
$StageHome = "$TsHome.stage-$InstallId"
$BackupHome = "$TsHome.backup-$InstallId"
$PreviousHome = Join-Path $DiHome "ts-cli.previous"
$PlatformIsWindows = $env:OS -eq "Windows_NT"
$DefaultShimName = if ($PlatformIsWindows) { "di.cmd" } else { "di" }
$TsShimName = if ($PlatformIsWindows) { "di-ts.cmd" } else { "di-ts" }
$DefaultShim = Join-Path $TargetBin $DefaultShimName
$TsShim = Join-Path $TargetBin $TsShimName
$CliEntry = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $RepoRoot "packages") "coding-agent") "dist") "cli") "main.js"
$InstalledEntry = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $TsNodeModules "@di") "coding-agent") "dist") "cli") "main.js"
$PreviousEntry = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $PreviousHome "node_modules") "@di") "coding-agent") "dist") "cli") "main.js"

New-Item -ItemType Directory -Force -Path $DiHome | Out-Null
$InstallLockPath = Join-Path $DiHome ".di-install.lock"
try {
    $InstallLock = [System.IO.File]::Open($InstallLockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
}
catch {
    throw "Another installation is using $DiHome (lock: $InstallLockPath): $($_.Exception.Message)"
}

try {

function Move-PathToAbsentDestination($source, $destination, [switch]$Force) {
    if (Test-Path -LiteralPath $destination) {
        throw "Refusing to move $source because destination already exists: $destination"
    }
    if ($Force) { Move-Item -LiteralPath $source -Destination $destination -Force }
    else { Move-Item -LiteralPath $source -Destination $destination }
}

if ($PlatformIsWindows) {
    $shadowingExe = Join-Path $TargetBin "di.exe"
    if (Test-Path -LiteralPath $shadowingExe -PathType Leaf) {
        throw "Existing executable blocks the default di launcher: $shadowingExe. Remove or rename it before installing."
    }
}

function Test-ManagedShim($path) {
    if (-not (Test-Path -LiteralPath $path)) { return $true }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    $content = [IO.File]::ReadAllText($path)
    if ($path -eq $DefaultShim) {
        if ($PlatformIsWindows) { return ($content -match 'di-ts\.cmd') }
        return ($content -match '\$DIR/di-ts')
    }
    if ($PlatformIsWindows) { return ($content -match 'ts-cli\\node_modules\\@di\\coding-agent') }
    return ($content -match 'ts-cli/node_modules/@di/coding-agent')
}

foreach ($shimPath in @($DefaultShim, $TsShim)) {
    if (-not (Test-ManagedShim $shimPath)) {
        throw "Refusing to overwrite an unmanaged launcher: $shimPath"
    }
}
if ((Test-Path -LiteralPath $PreviousHome) -and -not (Test-Path -LiteralPath $PreviousEntry -PathType Leaf)) {
    throw "Refusing to replace an unmanaged previous runtime: $PreviousHome"
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

function Copy-PackageRuntime($src, $dst) {
    if (-not (Test-Path -LiteralPath (Join-Path $src "package.json") -PathType Leaf)) {
        throw "Runtime package metadata missing: $(Join-Path $src 'package.json')"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $src "dist") -PathType Container)) {
        throw "Runtime package dist missing: $(Join-Path $src 'dist')"
    }
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Copy-Item -LiteralPath (Join-Path $src "package.json") -Destination (Join-Path $dst "package.json") -Force
    Copy-Item -LiteralPath (Join-Path $src "dist") -Destination (Join-Path $dst "dist") -Recurse -Force
    $writtenFiles.Add((Join-Path $dst "package.json"))
    $writtenFiles.Add((Join-Path $dst "dist"))
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

# --------------------------------------------------- 2/5 stage TS runtime
Write-Host "[2/5] Staging TS CLI runtime at $StageHome ..."
$stageNodeModules = Join-Path $StageHome "node_modules"
$stageEntry = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $stageNodeModules "@di") "coding-agent") "dist") "cli") "main.js"
try {
    New-Item -ItemType Directory -Force -Path $stageHome | Out-Null
    Copy-PackageRuntime (Join-Path (Join-Path $RepoRoot "packages") "coding-agent") (Join-Path (Join-Path $stageNodeModules "@di") "coding-agent")
    Copy-PackageRuntime (Join-Path (Join-Path $RepoRoot "packages") "ai") (Join-Path (Join-Path $stageNodeModules "@di") "ai")
    Copy-PackageRuntime (Join-Path (Join-Path $RepoRoot "packages") "agent") (Join-Path (Join-Path $stageNodeModules "@di") "agent")
    Copy-PackageRuntime (Join-Path $RepoRoot "tui") (Join-Path $stageNodeModules "di-tui")
    # Third-party runtime dependencies are copied as complete packages.
    Copy-Tree (Join-Path (Join-Path $RepoRoot "node_modules") "jsonc-parser") (Join-Path $stageNodeModules "jsonc-parser")
    Copy-Tree (Join-Path (Join-Path (Join-Path $RepoRoot "node_modules") "@earendil-works") "pi-tui") (Join-Path (Join-Path $stageNodeModules "@earendil-works") "pi-tui")
    Copy-Tree (Join-Path (Join-Path $RepoRoot "node_modules") "marked") (Join-Path $stageNodeModules "marked")
    Copy-Tree (Join-Path (Join-Path $RepoRoot "node_modules") "get-east-asian-width") (Join-Path $stageNodeModules "get-east-asian-width")
    Copy-Tree (Join-Path (Join-Path $RepoRoot "node_modules") "iconv-lite") (Join-Path $stageNodeModules "iconv-lite")
    Copy-Tree (Join-Path (Join-Path $RepoRoot "node_modules") "safer-buffer") (Join-Path $stageNodeModules "safer-buffer")
    Copy-Tree (Join-Path (Join-Path $RepoRoot "node_modules") "koffi") (Join-Path $stageNodeModules "koffi")
    Copy-Tree (Join-Path (Join-Path $RepoRoot "node_modules") "undici") (Join-Path $stageNodeModules "undici")

    if (-not (Test-Path -LiteralPath $stageEntry -PathType Leaf)) { throw "staged CLI entry missing: $stageEntry" }
    Write-Host "[3/5] Smoke testing the complete staged runtime..."
    $smokeHome = Join-Path ([System.IO.Path]::GetTempPath()) ("di-ts-install-smoke-" + [guid]::NewGuid().ToString("N"))
    $oldDiHome = [Environment]::GetEnvironmentVariable("DI_HOME", "Process")
    $oldDeepSeekApiKey = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "Process")
    try {
        $env:DI_HOME = $smokeHome
        $env:DEEPSEEK_API_KEY = ""
        & node $stageEntry --info
        $smokeExit = $LASTEXITCODE
    }
    finally {
        Remove-Item -Recurse -Force $smokeHome -ErrorAction SilentlyContinue
        [Environment]::SetEnvironmentVariable("DI_HOME", $oldDiHome, "Process")
        [Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", $oldDeepSeekApiKey, "Process")
    }
    if ($smokeExit -ne 0) { throw "staged CLI --info smoke test failed (exit $smokeExit)" }
}
catch {
    $stageError = $_
    Remove-Item -LiteralPath $stageHome -Recurse -Force -ErrorAction SilentlyContinue
    throw $stageError
}

# --------------------------------------------------- 4/5 stage launchers
Write-Host "[4/5] Preparing launchers and PATH update..."
$stageTsShim = "$TsShim.stage-$InstallId"
$stageDefaultShim = "$DefaultShim.stage-$InstallId"
$pathBefore = [Environment]::GetEnvironmentVariable("Path", "User")
$pathAfter = $pathBefore
try {
New-Item -ItemType Directory -Force -Path $TargetBin | Out-Null
if ($PlatformIsWindows) {
    $tsContent = "@echo off`r`nwhere node >nul 2>&1`r`nif errorlevel 1 (`r`n  echo di-ts: node not found on PATH. Install Node.js 22.19 or newer first. 1>&2`r`n  exit /b 1`r`n)`r`nnode `"%~dp0..\ts-cli\node_modules\@di\coding-agent\dist\cli\main.js`" %*`r`nexit /b %ERRORLEVEL%`r`n"
    $defaultContent = "@echo off`r`ncall `"%~dp0di-ts.cmd`" %*`r`nexit /b %ERRORLEVEL%`r`n"
}
else {
    $tsContent = "#!/bin/sh`nDIR=`"`$(CDPATH= cd -- `"`$(dirname -- `"`$0`")`" && pwd)`"`nexec node `"`$DIR/../ts-cli/node_modules/@di/coding-agent/dist/cli/main.js`" `"`$@`"`n"
    $defaultContent = "#!/bin/sh`nDIR=`"`$(CDPATH= cd -- `"`$(dirname -- `"`$0`")`" && pwd)`"`nexec `"`$DIR/di-ts`" `"`$@`"`n"
}
Write-TextFile $stageTsShim $tsContent
Write-TextFile $stageDefaultShim $defaultContent
if (-not $PlatformIsWindows) {
    & chmod 755 $stageTsShim $stageDefaultShim
    if ($LASTEXITCODE -ne 0) { throw "Could not mark staged launchers executable." }
}

if ($PlatformIsWindows -and -not $SkipPathUpdate) {
    $normTarget = $TargetBin.TrimEnd("\")
    $already = $pathBefore -split ";" | Where-Object { $_ -and $_.TrimEnd("\") -ieq $normTarget }
    if (-not $already) { $pathAfter = if ([string]::IsNullOrWhiteSpace($pathBefore)) { $normTarget } else { "$pathBefore;$normTarget" } }
}
}
catch {
    $prepareError = $_
    Remove-Item -LiteralPath $StageHome -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stageTsShim -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stageDefaultShim -Force -ErrorAction SilentlyContinue
    throw $prepareError
}

# ---------------------------------------------------- 5/5 commit or restore
Write-Host "[5/5] Switching to the validated runtime..."
$runtimeBackedUp = $false
$runtimeInstalled = $false
$shimBackups = New-Object System.Collections.Generic.List[object]
$shimInstalled = New-Object System.Collections.Generic.List[string]
$pathAttempted = $false
try {
    foreach ($shimPath in @($DefaultShim, $TsShim)) {
        if (-not (Test-ManagedShim $shimPath)) { throw "Launcher changed during install; refusing to replace it: $shimPath" }
    }
    if (Test-Path -LiteralPath $TsHome) {
        Move-PathToAbsentDestination $TsHome $BackupHome
        $runtimeBackedUp = $true
    }
    Move-PathToAbsentDestination $StageHome $TsHome
    $runtimeInstalled = $true

    foreach ($item in @(@{ Source = $stageTsShim; Destination = $TsShim }, @{ Source = $stageDefaultShim; Destination = $DefaultShim })) {
        $backup = "$($item.Destination).backup-$InstallId"
        if (Test-Path -LiteralPath $item.Destination) {
            Move-PathToAbsentDestination $item.Destination $backup
            $shimBackups.Add(@{ Original = $item.Destination; Backup = $backup })
        }
        Move-PathToAbsentDestination $item.Source $item.Destination
        $shimInstalled.Add($item.Destination)
    }

    if ($PlatformIsWindows -and -not $SkipPathUpdate -and $pathAfter -ne $pathBefore) {
        $pathAttempted = $true
        [Environment]::SetEnvironmentVariable("Path", $pathAfter, "User")
    }
}
catch {
    $commitError = $_
    $recoveryErrors = New-Object System.Collections.Generic.List[string]
    if ($pathAttempted) {
        try { [Environment]::SetEnvironmentVariable("Path", $pathBefore, "User") }
        catch { $recoveryErrors.Add("restore user PATH: $($_.Exception.Message)") }
    }
    foreach ($installedShim in $shimInstalled) {
        try {
            Remove-Item -LiteralPath $installedShim -Force
            if (Test-Path -LiteralPath $installedShim) { throw "destination remains after removal: $installedShim" }
        }
        catch { $recoveryErrors.Add("remove new launcher ${installedShim}: $($_.Exception.Message)") }
    }
    foreach ($savedShim in $shimBackups) {
        try { Move-PathToAbsentDestination $savedShim.Backup $savedShim.Original -Force }
        catch { $recoveryErrors.Add("restore launcher $($savedShim.Original): $($_.Exception.Message)") }
    }
    if ($runtimeInstalled) {
        try {
            Remove-Item -LiteralPath $TsHome -Recurse -Force
            if (Test-Path -LiteralPath $TsHome) { throw "destination remains after removal: $TsHome" }
        }
        catch { $recoveryErrors.Add("remove failed runtime ${TsHome}: $($_.Exception.Message)") }
    }
    if ($runtimeBackedUp) {
        try { Move-PathToAbsentDestination $BackupHome $TsHome }
        catch { $recoveryErrors.Add("restore runtime ${TsHome}: $($_.Exception.Message)") }
    }
    $recoveryText = if ($recoveryErrors.Count) { " Recovery issues: $($recoveryErrors -join '; ')." } else { " Previous runtime and launchers restored." }
    throw "Install switch failed: $($commitError.Exception.Message).$recoveryText"
}
finally {
    Remove-Item -LiteralPath $StageHome -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stageTsShim -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stageDefaultShim -Force -ErrorAction SilentlyContinue
}

if ($runtimeBackedUp) {
    $priorPrevious = "$PreviousHome.backup-$InstallId"
    try {
        if (Test-Path -LiteralPath $PreviousHome) { Move-PathToAbsentDestination $PreviousHome $priorPrevious }
        Move-PathToAbsentDestination $BackupHome $PreviousHome
        Remove-Item -LiteralPath $priorPrevious -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  Previous runtime retained at $PreviousHome"
    }
    catch {
        Write-Warning "New runtime is active, but previous-version rotation was incomplete: $($_.Exception.Message). Recoverable backup: $BackupHome"
    }
}
foreach ($savedShim in $shimBackups) { Remove-Item -LiteralPath $savedShim.Backup -Force -ErrorAction SilentlyContinue }
Write-Host "  Data safety: config.json / sessions / skills / commands / auth under $DiHome are NOT touched by this script."
if ($PlatformIsWindows -and -not $SkipPathUpdate) {
    if ($pathAfter -eq $pathBefore) { Write-Host "  $TargetBin already on user PATH, skipping." }
    else { Write-Host "  Appended $TargetBin to user PATH (takes effect in a new terminal)." }
}
elseif (-not $PlatformIsWindows) {
    Write-Host "  Shell profiles are not modified. Add this directory to PATH if desired:"
    Write-Host ("    export PATH=`"{0}:`$PATH`"" -f $TargetBin)
}
else { Write-Host "  Skipped (-SkipPathUpdate). Invoke di by full path: $DefaultShim" }

Write-Host ""
Write-Host "=== Install evidence ==="
Write-Host "  di-ts launchers:   $(Join-Path $TargetBin 'di-ts.cmd') / $(Join-Path $TargetBin 'di-ts')"
Write-Host "  TS runtime root:   $TsHome"
Write-Host "  CLI entry:         $InstalledEntry"
Write-Host "  Smoke test:        staged di-ts --info exit $smokeExit"
Write-Host "  Files written:"
foreach ($f in $writtenFiles) {
    $evidencePath = $f
    if ($f.StartsWith($StageHome, [System.StringComparison]::OrdinalIgnoreCase)) {
        $relativePath = $f.Substring($StageHome.Length).TrimStart([char[]]@("\", "/"))
        $evidencePath = Join-Path $TsHome $relativePath
    }
    elseif ($f -ieq $stageTsShim) { $evidencePath = $TsShim }
    elseif ($f -ieq $stageDefaultShim) { $evidencePath = $DefaultShim }
    Write-Host "    $evidencePath"
}
Write-Host "  Untouched:         config.json, sessions, skills, commands, auth and unrelated bin files"
Write-Host ""
Write-Host "Done. In a new terminal:"
Write-Host "  di-ts --info      # TypeScript CLI"
Write-Host "  di --info         # TypeScript CLI (default command)"
}
finally {
    if ($InstallLock) { $InstallLock.Dispose() }
}
