@echo off
setlocal

set "INSTALL_DIR=%LOCALAPPDATA%\ABES-WiFi-AutoLogin"

reg delete "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.abes.wifi.autologin" /f >nul 2>&1
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.abes.wifi.autologin" /f >nul 2>&1

if exist "%INSTALL_DIR%" rmdir /S /Q "%INSTALL_DIR%"

echo ABES WiFi Auto Login native helper removed.
pause
exit /b 0
