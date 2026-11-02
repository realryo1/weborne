@echo off
chcp 65001 >nul
rem weborne をこの PC から配信し、Android の Chrome から開けるようにする。
rem スマホの USB 端子は torne に使うので、adb は「ワイヤレス デバッグ」で先につないでおくこと
rem （開発者向けオプション → ワイヤレス デバッグ → adb pair / adb connect）。
cd /d "%~dp0"

adb reverse tcp:8080 tcp:8080
if errorlevel 1 (
  echo.
  echo スマホが見つかりません。ワイヤレス デバッグで adb connect してから、もう一度実行してください。
  echo PC の Chrome だけで使う場合は、このまま http://localhost:8080/ を開けます。
  echo.
) else (
  echo スマホの Chrome で http://localhost:8080/ を開いてください。
)

node serve.js 8080
