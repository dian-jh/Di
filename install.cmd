@echo off
setlocal EnableDelayedExpansion
REM di global command installer: publish win-x64 self-contained single-file ->
REM copy di.exe to ~/.di/bin -> build+install TS TUI to ~/.di/tui ->
REM append ~/.di/bin to the user PATH (idempotent).
REM NOTE: keep this file ASCII-only. cmd.exe parses batch files with the console
REM codepage (e.g. GBK 936); UTF-8 non-ASCII bytes corrupt line parsing.
REM Usage: install.cmd (run from repo root)

set "REPO=%~dp0"
set "PUBLISHED=%REPO%Di.Cli\bin\Release\net10.0\publish\di.exe"
set "TARGET=%USERPROFILE%\.di\bin"

echo [1/4] Publishing di (win-x64 self-contained single-file)...
dotnet publish "%REPO%Di.Cli" -c Release -p:PublishProfile=di
if errorlevel 1 goto :fail

echo [2/4] Copying di.exe to %TARGET% ...
if not exist "%TARGET%" mkdir "%TARGET%"
copy /Y "%PUBLISHED%" "%TARGET%\di.exe" >nul
if errorlevel 1 goto :fail

echo [3/4] Building TS TUI and installing to %USERPROFILE%\.di\tui ...
REM npm ci WITHOUT --omit=dev: typescript (tsc, the build tool) is a devDependency.
REM If node/npm is missing, or the build fails, di.exe alone remains functional
REM and interactive mode falls back to the C# REPL.
set "TUI_TARGET=%USERPROFILE%\.di\tui"
where node >nul 2>nul
if errorlevel 1 goto :tui_missing
where npm >nul 2>nul
if errorlevel 1 goto :tui_missing
pushd "%REPO%tui"
call npm ci --no-audit --no-fund
if errorlevel 1 goto :tui_build_fail
call npm run build
if errorlevel 1 goto :tui_build_fail
popd
if not exist "%TUI_TARGET%" mkdir "%TUI_TARGET%"
if exist "%TUI_TARGET%\dist" rmdir /S /Q "%TUI_TARGET%\dist"
xcopy /Y /E /I "%REPO%tui\dist" "%TUI_TARGET%\dist" >nul
copy /Y "%REPO%tui\package.json" "%TUI_TARGET%\package.json" >nul
if exist "%TUI_TARGET%\node_modules" rmdir /S /Q "%TUI_TARGET%\node_modules"
xcopy /Y /E /I "%REPO%tui\node_modules" "%TUI_TARGET%\node_modules" >nul
goto :path_step

:tui_missing
echo WARNING: node/npm not found - TS TUI not installed. di will fall back to the REPL.
goto :path_step

:tui_build_fail
popd
echo WARNING: TS TUI build failed - di will fall back to the REPL (di.exe alone remains functional).
goto :path_step

:path_step
echo [4/4] Ensuring %TARGET% is on the user PATH (idempotent)...
set "KEY=HKCU\Environment"
set "OLD="
for /f "tokens=2*" %%A in ('reg query "%KEY%" /v Path 2^>nul') do set "OLD=%%B"
if defined OLD (
    REM findstr /c: is unreliable here: '.' stays a wildcard and /i breaks the
    REM match, so a duplicate slips through. Use PowerShell membership instead.
    powershell -NoProfile -Command "exit $(if ('%TARGET%' -in (([Environment]::GetEnvironmentVariable('Path','User')) -split ';')) { 0 } else { 1 })"
    if not errorlevel 1 (
        echo %TARGET% already on user PATH, skipping.
        goto :done
    )
)
if defined OLD (
    setx PATH "!OLD!;%TARGET%" >nul
) else (
    setx PATH "%TARGET%" >nul
)
if errorlevel 1 goto :fail
echo Appended %TARGET% to user PATH (takes effect in a new terminal).

:done
echo.
echo Done. Open a new terminal and run: di --version
exit /b 0

:fail
echo.
echo Install failed. Make sure the .NET 10 SDK is installed and on PATH.
exit /b 1
