@echo off
REM ============================================================================
REM  Token Monitor - local Windows packaging (installer + portable)
REM
REM  Produces both artifacts into dist\ :
REM    - NSIS installer       Token-Monitor-Setup-<version>.exe
REM    - portable single exe  Token-Monitor-<version>.exe
REM
REM  This is the machine-specific wrapper documented in
REM  docs\CHANGES-LOCAL.zh-CN.md section 7. The portable path exists because
REM  this host cannot reach github.com reliably: the electron zip and the
REM  electron-builder tools are served from the npmmirror images, the already
REM  installed electron is reused instead of downloaded again, and Node is told
REM  to trust the Windows certificate store, because a local proxy may terminate
REM  TLS with a self-signed CA that Node does not read by default.
REM
REM  Three deliberate constraints, all learned the hard way:
REM    - Messages are ASCII. cmd.exe renders a UTF-8 batch file as mojibake on
REM      many Chinese Windows installs, and an unreadable build log is worse
REM      than an English one.
REM    - No multi-line "( ... )" block wraps an echo. An unescaped parenthesis
REM      inside one - even a balanced "electron (pkg)" - closes the block early
REM      and cmd then tries to execute the remainder, failing the build with a
REM      message that points nowhere near the real line. Conditionals below use
REM      goto instead, which cannot be broken that way.
REM    - The working tree is never written to. The Hub build marker is checked,
REM      not refreshed, so a stale marker fails the build instead of quietly
REM      changing what ends up inside the package.
REM
REM  Usage:  scripts\build-win-local.bat
REM ============================================================================
setlocal

cd /d "%~dp0.."

set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "NODE_USE_SYSTEM_CA=1"

REM Node's fetch does not read the proxy environment on its own, and the
REM vendored tokscale asset is a GitHub release this host only reaches
REM through the proxy. ensure-vendored-tokscale.js caps that download at 60
REM seconds, which the proxy clears in seconds while a direct fetch does not
REM (measured: 8.6 s through the proxy, over 4 minutes direct). Node 24 can
REM use the proxy when asked to, so pass it on when one is configured.
if defined HTTPS_PROXY set "NODE_USE_ENV_PROXY=1"
if defined HTTP_PROXY set "NODE_USE_ENV_PROXY=1"

echo =============================================================
echo  Token Monitor - local Windows packaging
echo  repo: %CD%
echo =============================================================
echo.

REM --- 1. preconditions ------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 goto :no_node
if not exist "node_modules\.bin\electron-builder.cmd" goto :no_modules
if not exist "scripts\vendor\tokscale.json" goto :no_manifest

REM electron's own postinstall downloads a ~110MB zip from GitHub, which this
REM host cannot reach, so a plain "npm ci" leaves node_modules/electron without
REM a dist directory. ELECTRON_MIRROR is already set above, so re-running that
REM installer here repairs it instead of failing the build. @electron/get
REM verifies the zip against the package's own checksums.json, so routing it
REM through a mirror is not a trust decision.
if exist "node_modules\electron\dist\electron.exe" goto :electron_ready
echo [setup] node_modules\electron\dist is missing - running its installer.
echo         A plain "npm ci" could not fetch the zip from GitHub.
echo.
node "node_modules\electron\install.js"
if errorlevel 1 goto :no_electron
if not exist "node_modules\electron\dist\electron.exe" goto :no_electron
echo.

:electron_ready
for /f "usebackq delims=" %%v in (`node -p "require('./node_modules/electron/package.json').version"`) do set "ELECTRON_VERSION=%%v"
for /f "usebackq delims=" %%v in (`node -p "String(require('./package.json').devDependencies.electron||'').replace(/^[\^~>=<\s]+/,'')"`) do set "DECLARED_VERSION=%%v"
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "APP_VERSION=%%v"

if not defined ELECTRON_VERSION goto :no_electron
if not defined APP_VERSION goto :no_electron

echo   app version      : %APP_VERSION%
echo   electron local   : %ELECTRON_VERSION%
if "%DECLARED_VERSION%"=="" goto :versions_ok
if "%DECLARED_VERSION%"=="%ELECTRON_VERSION%" goto :versions_ok
echo   electron declared: %DECLARED_VERSION%   MISMATCH
echo                      The installed copy is what gets packaged, so this
echo                      build will use %ELECTRON_VERSION%. Run npm ci to resync.
:versions_ok
echo.

REM --- 2. hub build marker ---------------------------------------------------
REM src/hub and src/shared are packaged, so a stale build identity ships an
REM outdated Hub to the widget. The registry has to be current before the build
REM starts; this script only reports, it never appends a revision - see
REM AGENTS.md, "Hub build marker".
echo [1/3] Checking the Hub build marker ...
echo       src/hub and src/shared are packaged, so a stale build identity would
echo       ship an outdated Hub to the widget. The marker has to be current
echo       before the build starts; this step only reports, it never writes.
echo.
node scripts\update-hub-build.js --check
if errorlevel 1 goto :hub_build_stale
echo.

REM --- 3. vendored tokscale binary ------------------------------------------
echo [2/3] Vendoring the tokscale binary ...
echo       scripts/vendor/tokscale.json pins a fork build that npm does not
echo       publish, so this step downloads and swaps it in. It is a no-op once
echo       the pinned build is already in place.
echo.
call npm run ensure:tokscale -- --platform=win32-x64
if errorlevel 1 goto :tokscale_failed
echo.

REM --- 4. build ---------------------------------------------------------------
echo [3/3] Building NSIS installer + portable exe ...
echo       reusing node_modules\electron\dist, no electron download.
echo.
call "node_modules\.bin\electron-builder.cmd" --win --x64 --publish never --config.electronDist="%CD%\node_modules\electron\dist" --config.electronVersion=%ELECTRON_VERSION%
if errorlevel 1 goto :build_failed

REM --- 5. verify the artifacts ------------------------------------------------
REM dist\ keeps artifacts from older versions, so "the build finished" is not
REM the same as "the right files are there". Check the current version's pair
REM exists, then let the repo's own verifier confirm the updater metadata
REM points at artifacts that are actually on disk.
echo.
echo [done] Verifying the artifacts ...
echo.
if not exist "dist\Token-Monitor-Setup-%APP_VERSION%.exe" goto :missing_installer
if not exist "dist\Token-Monitor-%APP_VERSION%.exe" goto :missing_portable
echo   installer : dist\Token-Monitor-Setup-%APP_VERSION%.exe
echo   portable  : dist\Token-Monitor-%APP_VERSION%.exe
echo.
call npm run verify:release-artifact-names
if errorlevel 1 goto :artifact_check_failed
echo.

echo =============================================================
echo  Done. Artifacts in %CD%\dist
echo =============================================================
dir /o-d "dist\*.exe"
echo.
echo   Artifacts from older versions are not removed. Check the date
echo   column before shipping one.
echo.
echo   These builds are NOT signed; official signing happens in CI.
echo   Windows SmartScreen will warn on first run: choose
echo   "More info" then "Run anyway".
echo.
endlocal
exit /b 0

REM --- failure paths ---------------------------------------------------------
:no_node
echo [FAIL] node is not on PATH. Install Node 22.15+ and reopen this window.
endlocal & exit /b 1

:no_modules
echo [FAIL] node_modules is missing or incomplete.
echo        Run from the repo root:  npm ci
echo        See docs\NETWORK-SETUP.zh-CN.md if the download fails.
endlocal & exit /b 1

:no_electron
echo [FAIL] node_modules\electron\dist\electron.exe is missing.
echo        This script already retried electron's own installer through
echo        ELECTRON_MIRROR, so the mirror is unreachable too:
echo          https://npmmirror.com/mirrors/electron/
echo        See docs\NETWORK-SETUP.zh-CN.md for this host's network route.
endlocal & exit /b 1

:no_manifest
echo [FAIL] scripts\vendor\tokscale.json is missing. Run this from the repo.
endlocal & exit /b 1

:hub_build_stale
echo.
echo [FAIL] The Hub build registry is stale.
echo        Run  npm run update:hub-build  and commit the result, then build
echo        again. Packaging a stale marker ships an outdated Hub build
echo        identity to the widget.
endlocal & exit /b 1

:tokscale_failed
echo.
echo [FAIL] ensure:tokscale did not complete.
echo        In override mode it downloads a fork build from a GitHub
echo        release, and github.com is not reachable from here without the
echo        proxy described in docs\NETWORK-SETUP.zh-CN.md.
echo        Everything up to this point is reusable; only this step and the
echo        build need the network.
endlocal & exit /b 1

:build_failed
echo.
echo [FAIL] electron-builder exited with an error. See the log above.
echo        The usual cause on this host is a tool-cache miss for 7zip,
echo        winCodeSign or nsis; see docs\CHANGES-LOCAL.zh-CN.md.
endlocal & exit /b 1

:missing_installer
echo.
echo [FAIL] dist\Token-Monitor-Setup-%APP_VERSION%.exe is missing.
echo        The build did not produce the NSIS installer for this version.
echo        Older artifacts stay in dist\ - check the build log above.
endlocal & exit /b 1

:missing_portable
echo.
echo [FAIL] dist\Token-Monitor-%APP_VERSION%.exe is missing.
echo        The build did not produce the portable executable for this version.
echo        Older artifacts stay in dist\ - check the build log above.
endlocal & exit /b 1

:artifact_check_failed
echo.
echo [FAIL] The updater metadata does not match the built artifacts.
echo        See the message above.
endlocal & exit /b 1
