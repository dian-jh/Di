<#
  di global command installer:
    1) dotnet publish win-x64 self-contained single-file di.exe
    2) copy it to ~/.di/bin/
    3) append that dir to the user PATH (idempotent)

  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 without a
  BOM as the ANSI codepage (GBK 936); UTF-8 non-ASCII bytes become mojibake.

  Usage (from repo root):
    powershell -ExecutionPolicy Bypass -File install.ps1

  Note: SetEnvironmentVariable writes the registry; already-open terminals
  won't pick it up. Open a new terminal and run: di --version
#>
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PublishDir = Join-Path $RepoRoot "Di.Cli\bin\Release\net10.0\publish"
$TargetDir = Join-Path $HOME ".di\bin"

Write-Host "[1/3] Publishing di (win-x64 self-contained single-file)..."
& dotnet publish (Join-Path $RepoRoot "Di.Cli") -c Release -p:PublishProfile=di
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed (exit $LASTEXITCODE)" }

Write-Host "[2/3] Copying di.exe to $TargetDir ..."
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
Copy-Item -Force (Join-Path $PublishDir "di.exe") (Join-Path $TargetDir "di.exe")

Write-Host "[3/3] Ensuring $TargetDir is on the user PATH (idempotent)..."
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$normTarget = $TargetDir.TrimEnd("\")
$already = $userPath -split ";" | Where-Object { $_ -and $_.TrimEnd("\") -ieq $normTarget }
if ($already) {
    Write-Host "$TargetDir already on user PATH, skipping."
}
else {
    $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $normTarget } else { "$userPath;$normTarget" }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "Appended $TargetDir to user PATH (takes effect in a new terminal)."
}

Write-Host ""
Write-Host "Done. Open a new terminal and run: di --version"
