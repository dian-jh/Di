[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet("typescript", "csharp")][string]$Runtime,
    [Parameter(Mandatory = $true)][string]$DiHome
)
$ErrorActionPreference = "Stop"

$CliIsWindows = $env:OS -eq "Windows_NT"
$bin = [IO.Path]::GetFullPath((Join-Path $DiHome "bin")).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$separator = [IO.Path]::DirectorySeparatorChar
$statePath = Join-Path $bin ".di-cli-selection.json"
$shimName = if ($CliIsWindows) { "di.cmd" } else { "di" }
$backupName = if ($CliIsWindows) { "di-csharp.exe" } else { "di-csharp" }
$shimPath = Join-Path $bin $shimName
$backupPath = Join-Path $bin $backupName

function Assert-BinPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $prefix = $bin + $separator
    $comparison = if ($CliIsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    if (-not $full.StartsWith($prefix, $comparison)) { throw "Refusing path outside explicit DI_HOME/bin: $full" }
    return $full
}
function Get-Hash([string]$Path) { return (Get-FileHash -LiteralPath (Assert-BinPath $Path) -Algorithm SHA256).Hash }
function Read-State {
    if (-not (Test-Path -LiteralPath (Assert-BinPath $statePath) -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json) }
    catch { throw "CLI selection state is unreadable; refusing to alter launchers: $statePath" }
}
function Write-State($State) {
    $json = $State | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText((Assert-BinPath $statePath), $json, (New-Object Text.UTF8Encoding($false)))
}

if (-not (Test-Path -LiteralPath $bin -PathType Container)) { throw "DI_HOME/bin does not exist: $bin (install the TS runtime first)" }
$state = Read-State
if ($Runtime -eq "typescript") {
    $tsLauncher = Join-Path $bin $(if ($CliIsWindows) { "di-ts.cmd" } else { "di-ts" })
    $tsEntry = Join-Path $DiHome "ts-cli/node_modules/@di/coding-agent/dist/cli/main.js"
    if (-not (Test-Path -LiteralPath $tsLauncher -PathType Leaf) -or -not (Test-Path -LiteralPath $tsEntry -PathType Leaf)) {
        throw "TS runtime is not installed under this DI_HOME; run install.ps1 with -DiHome $DiHome first."
    }
    if ($CliIsWindows) {
        $shadowNames = if ($null -ne $state) { @("di.com", "di.exe", "di.bat", "di.ps1", "di") } else { @("di.com", "di.bat", "di.ps1") }
        foreach ($name in $shadowNames) {
            $candidate = Assert-BinPath (Join-Path $bin $name)
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { throw "A higher-priority Windows launcher blocks TS selection: $candidate" }
        }
    }
    if ($null -ne $state) {
        if ($state.version -ne 1 -or $state.runtime -ne "typescript") { throw "Unsupported or conflicting CLI selection state." }
        if ((Get-Hash $backupPath) -ne $state.originalHash -or (Get-Hash $shimPath) -ne $state.shimHash) {
            throw "Managed launcher changed since TS selection; refusing to overwrite it."
        }
        Write-Host "TypeScript CLI is already selected."
        exit 0
    }
    if (Test-Path -LiteralPath (Assert-BinPath $backupPath)) { throw "Reserved C# backup already exists: $backupPath" }
    if ($CliIsWindows -and (Test-Path -LiteralPath (Assert-BinPath $shimPath))) { throw "Unmanaged launcher already exists: $shimPath" }
    $csharpNames = if ($CliIsWindows) { @("di.exe", "di") } else { @("di") }
    $csharpPaths = @($csharpNames | ForEach-Object { Join-Path $bin $_ } | Where-Object { Test-Path -LiteralPath (Assert-BinPath $_) -PathType Leaf })
    if ($csharpPaths.Count -ne 1) { throw "Expected exactly one existing C# di launcher under $bin; found $($csharpPaths.Count)." }
    $originalPath = Assert-BinPath $csharpPaths[0]
    $originalName = [IO.Path]::GetFileName($originalPath)
    $originalHash = Get-Hash $originalPath
    Move-Item -LiteralPath $originalPath -Destination (Assert-BinPath $backupPath)
    try {
        $content = if ($CliIsWindows) {
            "@echo off`r`ncall `"%~dp0di-ts.cmd`" %*`r`nexit /b %ERRORLEVEL%`r`n"
        } else {
            "#!/bin/sh`nDIR=`$(CDPATH= cd -- `"`$(dirname -- `"`$0`")`" && pwd)`nexec `"`$DIR/di-ts`" `"`$@`"`n"
        }
        [IO.File]::WriteAllText((Assert-BinPath $shimPath), $content, [Text.Encoding]::ASCII)
        if (-not $CliIsWindows) {
            & chmod 755 (Assert-BinPath $shimPath)
            if ($LASTEXITCODE -ne 0) { throw "Could not mark TS launcher executable." }
        }
        $state = [ordered]@{ version = 1; runtime = "typescript"; originalName = $originalName; originalHash = $originalHash; shimName = $shimName; shimHash = Get-Hash $shimPath }
        Write-State $state
    } catch {
        if (Test-Path -LiteralPath (Assert-BinPath $shimPath)) { Remove-Item -LiteralPath (Assert-BinPath $shimPath) -Force }
        Move-Item -LiteralPath (Assert-BinPath $backupPath) -Destination $originalPath
        throw
    }
    Write-Host "Selected TypeScript CLI. C# launcher preserved as $backupPath."
    exit 0
}

if ($null -eq $state) {
    if (Test-Path -LiteralPath (Assert-BinPath $backupPath)) { throw "C# backup exists without a managed selection state; refusing to guess." }
    $currentNames = if ($CliIsWindows) { @("di.exe", "di") } else { @("di") }
    $current = @($currentNames | ForEach-Object { Join-Path $bin $_ } | Where-Object { Test-Path -LiteralPath (Assert-BinPath $_) -PathType Leaf })
    if ($current.Count -ne 1) { throw "No managed TS selection to roll back and no unique C# launcher is present." }
    Write-Host "C# CLI is already selected."
    exit 0
}
if ($state.version -ne 1 -or $state.runtime -ne "typescript" -or $state.originalName -notin @("di.exe", "di")) { throw "Unsupported or conflicting CLI selection state." }
$originalPath = Assert-BinPath (Join-Path $bin $state.originalName)
if ((Get-Hash $backupPath) -ne $state.originalHash -or (Get-Hash $shimPath) -ne $state.shimHash) { throw "Managed launcher changed since TS selection; refusing rollback." }
if ($CliIsWindows -and (Test-Path -LiteralPath $originalPath)) { throw "Original C# launcher path is occupied; refusing to overwrite: $originalPath" }
Remove-Item -LiteralPath (Assert-BinPath $shimPath) -Force
Move-Item -LiteralPath (Assert-BinPath $backupPath) -Destination $originalPath
Remove-Item -LiteralPath (Assert-BinPath $statePath) -Force
Write-Host "Restored C# CLI to $originalPath. The separate di-ts command remains installed."
