@echo off
rem ===================================================================
rem  Benchwise USB stick launcher
rem
rem  In Windows setup (OOBE): press Shift+F10, go to the stick's drive and
rem  run BENCHWISE. It joins Wi-Fi, waits for the network, connects your
rem  share, keeps settings and reports on the stick, then starts Benchwise.
rem
rem  Site settings and passwords live in site.cmd next to this file (copy
rem  site.example.cmd). Optional: wifi.xml (an exported Wi-Fi profile) and a
rem  WiFi_Drivers folder (.inf drivers) for units with no Wi-Fi driver.
rem ===================================================================
setlocal EnableExtensions EnableDelayedExpansion
title Benchwise
cd /d "%~dp0"
echo ===================================================
echo   BENCHWISE
echo ===================================================

if exist "%~dp0site.cmd" call "%~dp0site.cmd"
if not defined CHECK_HOST set "CHECK_HOST=8.8.8.8"

rem Settings and reports stay on the stick. If it's read-only (a CD/ISO),
rem use the unit's public folder: Windows setup's temporary account is
rem deleted when setup finishes, and anything saved in it with it.
set "BENCHWISE_DATA_DIR=%~dp0benchwise-data"
if not exist "%BENCHWISE_DATA_DIR%" mkdir "%BENCHWISE_DATA_DIR%" >nul 2>&1
(echo.>"%BENCHWISE_DATA_DIR%\.write-test") >nul 2>&1
if exist "%BENCHWISE_DATA_DIR%\.write-test" (
  del "%BENCHWISE_DATA_DIR%\.write-test" >nul 2>&1
) else (
  set "BENCHWISE_DATA_DIR=%PUBLIC%\benchwise-data"
  echo NOTE: the stick is read-only. Reports go to !BENCHWISE_DATA_DIR!
)

:connect
if exist "%~dp0wifi.xml" (
  echo [1/3] Joining Wi-Fi...
  netsh wlan add profile filename="%~dp0wifi.xml" >nul 2>&1
  if defined WIFI_NAME netsh wlan connect name="!WIFI_NAME!" >nul 2>&1
)
echo [2/3] Waiting for the network...
set /a TRIES=0
:waitnet
ping -n 1 -w 2000 %CHECK_HOST% >nul 2>&1 && goto online
set /a TRIES+=1
if !TRIES! lss 15 (
  ping -n 3 127.0.0.1 >nul
  goto waitnet
)

echo.
echo No network. The MDM / Autopilot check needs the internet.
echo   [1] Retry, e.g. after plugging in an Ethernet cable
if exist "%~dp0WiFi_Drivers" echo   [2] Install Wi-Fi drivers from the stick, then retry
echo   [3] Start Benchwise anyway
set "CHOICE="
set /p "CHOICE=Choose 1, 2 or 3: "
if "!CHOICE!"=="3" goto launch
if "!CHOICE!"=="2" if exist "%~dp0WiFi_Drivers" (
  echo Installing drivers...
  pnputil /add-driver "%~dp0WiFi_Drivers\*.inf" /subdirs /install
  echo Waiting for the adapter...
  ping -n 9 127.0.0.1 >nul
)
goto connect

:online
echo        Online.
if defined SHARE (
  echo [3/3] Connecting to the share...
  if defined SHARE_USER (
    net use "!SHARE!" /user:"!SHARE_USER!" "!SHARE_PASS!" /persistent:no >nul 2>&1
  ) else (
    net use "!SHARE!" /persistent:no >nul 2>&1
  )
  if errorlevel 1 echo        Could not connect. Reports will be kept on the stick.
)

:launch
echo Starting Benchwise...
start "" "%~dp0Benchwise.exe"
endlocal
