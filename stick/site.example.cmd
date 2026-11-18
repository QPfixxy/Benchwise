@echo off
rem ===================================================================
rem  Site settings for the Benchwise stick launcher.
rem
rem  Copy this file to site.cmd (next to LAUNCH.CMD) and fill it in.
rem  site.cmd holds your Wi-Fi name and share password: keep it on your
rem  sticks only, never in a repository.
rem ===================================================================

rem Wi-Fi. Export a profile on any PC that knows the network:
rem   netsh wlan export profile name="YourNetwork" key=clear folder=.
rem then rename the file to wifi.xml and put it next to LAUNCH.CMD.
set "WIFI_NAME=YourNetwork"

rem Must answer before testing starts: 8.8.8.8, or your server's address.
set "CHECK_HOST=8.8.8.8"

rem Optional: the intake share. Reports are saved there (and kept on the
rem stick if it can't be reached); KnownTenants.txt names the client on a
rem locked unit.
rem set "SHARE=\\192.168.1.10\AutopilotLogs"
rem set "SHARE_USER=intakestation"
rem set "SHARE_PASS=change-me"
rem set "BENCHWISE_REPORTS_DIR=\\192.168.1.10\AutopilotLogs\Benchwise"
rem set "BENCHWISE_KNOWN_TENANTS=\\192.168.1.10\AutopilotLogs\Scripts\KnownTenants.txt"

rem Optional: Benchwise Hub, the central records server. Saved reports are
rem queued on the stick and sent in the background. The station key comes
rem from the Hub (Administration > Stations > Enroll); the fingerprint is
rem printed by the Hub installer (needed for its self-signed certificate).
rem set "BENCHWISE_HUB_URL=https://192.168.1.20"
rem set "BENCHWISE_HUB_KEY=bws_..."
rem set "BENCHWISE_HUB_FINGERPRINT=41:69:E0:..."
