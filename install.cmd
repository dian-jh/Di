@echo off
setlocal EnableDelayedExpansion
REM di global command installer: publish win-x64 self-contained single-file ->
REM copy di.exe to ~/.di/bin -> append that dir to the user PATH (idempotent).
REM NOTE: keep this file ASCII-only. cmd.exe parses batch files with the console
REM codepage (e.g. GBK 936); UTF-8 non-ASCII bytes corrupt line parsing.
REM Usage: install.cmd (run from repo root)

set "REPO=%~dp0"
set "PUBLISHED=%REPO%Di.Cli\bin\Release\net10.0\publish\di.exe"
set "TARGET=%USERPROFILE%\.di\bin"

echo [1/3] Publishing di (win-x64 self-contained single-file)...
dotnet publish "%REPO%Di.Cli" -c Release -p:PublishProfile=di
if errorlevel 1 goto :fail

echo [2/3] Copying di.exe to %TARGET% ...
if not exist "%TARGET%" mkdir "%TARGET%"
copy /Y "%PUBLISHED%" "%TARGET%\di.exe" >nul
if errorlevel 1 goto :fail

echo [3/3] Ensuring %TARGET% is on the user PATH (idempotent)...
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
