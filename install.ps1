<#
  di global command installer:
    1) dotnet publish win-x64 self-contained single-file di.exe
    2) copy it to ~/.di/bin/
    3) build+install TS TUI to ~/.di/tui/ (optional; node/npm missing or
       build failure only warns - di.exe alone remains functional)
    4) append ~/.di/bin to the user PATH (idempotent)

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

Write-Host "[1/4] Publishing di (win-x64 self-contained single-file)..."
& dotnet publish (Join-Path $RepoRoot "Di.Cli") -c Release -p:PublishProfile=di
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed (exit $LASTEXITCODE)" }

Write-Host "[2/4] Copying di.exe to $TargetDir ..."
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
Copy-Item -Force (Join-Path $PublishDir "di.exe") (Join-Path $TargetDir "di.exe")

# Step 3: build+install the TypeScript TUI (optional, non-fatal).
# Note: npm ci WITHOUT --omit=dev - typescript (tsc, the build tool) is a devDependency.
# If node/npm is missing or the build fails, di.exe alone remains functional and
# interactive mode falls back to the C# REPL.
Write-Host "[3/4] Building TS TUI and installing to ~/.di/tui ..."
$TuiTarget = Join-Path $HOME ".di\tui"
$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
$built = $false
if (-not $node -or -not $npm) {
    Write-Host "WARNING: node/npm not found - TS TUI not installed. di will fall back to the REPL."
}
else {
    Push-Location (Join-Path $RepoRoot "tui")
    try {
        & npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)" }
        $built = $true
    }
    catch {
        Write-Host "WARNING: TS TUI build failed ($($_.Exception.Message)). di will fall back to the REPL."
    }
    finally {
        Pop-Location
    }
    if ($built) {
        New-Item -ItemType Directory -Force -Path $TuiTarget | Out-Null
        $distTarget = Join-Path $TuiTarget "dist"
        if (Test-Path $distTarget) { Remove-Item -Recurse -Force $distTarget }
        Copy-Item -Force -Recurse (Join-Path $RepoRoot "tui\dist") $distTarget
        Copy-Item -Force (Join-Path $RepoRoot "tui\package.json") (Join-Path $TuiTarget "package.json")
        $nmTarget = Join-Path $TuiTarget "node_modules"
        if (Test-Path $nmTarget) { Remove-Item -Recurse -Force $nmTarget }
        Copy-Item -Force -Recurse (Join-Path $RepoRoot "tui\node_modules") $nmTarget
    }
}

Write-Host "[4/4] Ensuring $TargetDir is on the user PATH (idempotent)..."
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
