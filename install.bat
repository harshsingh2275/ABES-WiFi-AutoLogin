@echo off
setlocal

title ABES WiFi Auto Login - V4.2 Installer

echo.
echo ==========================================
echo   ABES WiFi Auto Login V4.2 Installer
echo ==========================================
echo.

if not defined LOCALAPPDATA (
  echo [ERROR] LOCALAPPDATA is not available.
  echo.
  pause
  exit /b 1
)

set "INSTALL_DIR=%LOCALAPPDATA%\ABES-WiFi-AutoLogin"
set "EXE_SOURCE=%~dp0native-host\abes-wifi-helper.exe"
set "MAIN_SOURCE=%~dp0native-host\main.go"
set "EXE_DEST=%INSTALL_DIR%\abes-wifi-helper.exe"
set "MANIFEST=%INSTALL_DIR%\com.abes.wifi.autologin.json"
set "EXTENSION_ID=hmkageifnlhphobpdidialmhclebakhk"

REM ============================================================
REM Added: automatically build the helper from main.go if the
REM executable is missing. The original install flow below is
REM kept unchanged.
REM ============================================================

echo [0/4] Checking native helper...

if not exist "%EXE_SOURCE%" (
  echo [INFO] Native helper executable is missing.
  echo [INFO] Checking for Go...
  echo.

  where go >nul 2>&1
  if not errorlevel 1 (
    set "GO_CMD=go"
    echo [OK] Go is already installed.
  ) else (
    echo [INFO] Go is not installed.
    echo [INFO] Checking for Windows Package Manager...
    echo.

    where winget >nul 2>&1
    if errorlevel 1 (
      echo [ERROR] Windows Package Manager ^(winget^) was not found.
      echo.
      echo Install Go manually from:
      echo https://go.dev/dl/
      echo.
      pause
      exit /b 1
    )

    echo [INFO] Installing Go with winget...
    echo.
    winget install --id GoLang.Go -e --accept-source-agreements --accept-package-agreements

    if errorlevel 1 (
      echo.
      echo [ERROR] Go installation failed or was cancelled.
      echo.
      pause
      exit /b 1
    )

    echo.
    echo [OK] Go installation command completed.
  )

  REM A newly installed Go may not be on PATH in this CMD session.
  where go >nul 2>&1
  if not errorlevel 1 (
    set "GO_CMD=go"
  ) else if exist "%ProgramFiles%\Go\bin\go.exe" (
    set "GO_CMD=%ProgramFiles%\Go\bin\go.exe"
  ) else if exist "%LocalAppData%\Programs\Go\bin\go.exe" (
    set "GO_CMD=%LocalAppData%\Programs\Go\bin\go.exe"
  ) else (
    echo.
    echo [ERROR] Go was installed, but go.exe could not be located.
    echo.
    echo Close this window, open a new Command Prompt, and run
    echo install.bat again.
    echo.
    pause
    exit /b 1
  )

  if not exist "%MAIN_SOURCE%" (
    echo.
    echo [ERROR] main.go was not found:
    echo         "%MAIN_SOURCE%"
    echo.
    pause
    exit /b 1
  )

  echo.
  echo [INFO] Building the native helper from main.go...
  pushd "%~dp0native-host"
  "%GO_CMD%" build -o "abes-wifi-helper.exe" "main.go"
  set "BUILD_ERROR=%errorlevel%"
  popd

  if not "%BUILD_ERROR%"=="0" (
    echo.
    echo [ERROR] Go could not build the native helper.
    echo.
    pause
    exit /b 1
  )

  if not exist "%EXE_SOURCE%" (
    echo.
    echo [ERROR] Build completed, but the helper executable was not found:
    echo         "%EXE_SOURCE%"
    echo.
    pause
    exit /b 1
  )

  echo [OK] Native helper built successfully.
) else (
  echo [OK] Native helper already exists.
)

echo.
echo [1/4] Checking native helper...

if not exist "%EXE_SOURCE%" (
  echo [ERROR] Native helper was not found:
  echo         "%EXE_SOURCE%"
  echo.
  echo Make sure this install.bat is inside the V4.2 root folder.
  echo.
  pause
  exit /b 1
)

echo [OK] Native helper found.
echo.

echo [2/4] Creating install directory...

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

if errorlevel 1 (
  echo [ERROR] Could not create:
  echo         "%INSTALL_DIR%"
  echo.
  pause
  exit /b 1
)

echo [OK] Install directory ready.
echo.

echo [3/4] Copying native helper...

copy /Y "%EXE_SOURCE%" "%EXE_DEST%" >nul

if errorlevel 1 (
  echo [ERROR] Failed to copy the native helper.
  echo.
  echo Source:
  echo "%EXE_SOURCE%"
  echo.
  echo Destination:
  echo "%EXE_DEST%"
  echo.
  pause
  exit /b 1
)

echo [OK] Native helper copied.
echo.

echo [4/4] Registering Native Messaging host...

(
  echo {"name":"com.abes.wifi.autologin","description":"ABES WiFi Auto Login Wi-Fi SSID helper","path":"%EXE_DEST:\=\\%","type":"stdio","allowed_origins":["chrome-extension://%EXTENSION_ID%/"]}
) > "%MANIFEST%"

if errorlevel 1 (
  echo [ERROR] Failed to create the Native Messaging manifest.
  echo.
  echo Manifest:
  echo "%MANIFEST%"
  echo.
  pause
  exit /b 1
)

reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.abes.wifi.autologin" /ve /t REG_SZ /d "%MANIFEST%" /f >nul

if errorlevel 1 (
  echo [ERROR] Failed to register Native Messaging for Brave.
  echo.
  pause
  exit /b 1
)

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.abes.wifi.autologin" /ve /t REG_SZ /d "%MANIFEST%" /f >nul

if errorlevel 1 (
  echo [ERROR] Failed to register Native Messaging for Chrome.
  echo.
  pause
  exit /b 1
)

echo.
echo ==========================================
echo   Installation completed successfully!
echo ==========================================
echo.
echo Extension ID:
echo %EXTENSION_ID%
echo.
echo Now open:
echo brave://extensions/
echo.
echo Then click "Load unpacked" and select:
echo %~dp0extension
echo.
echo ==========================================
echo   Press any key to close this window.
echo ==========================================
pause
exit /b 0
