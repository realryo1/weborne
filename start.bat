@echo off
chcp 65001 >nul
rem weborneをこのPCから配信し、AndroidのChromeから開けるようにする。
remスマホのUSB端子はtorneに使うので、adbは「ワイヤレス デバッグ」で先につないでおくこと
rem（開発者向けオプション → ワイヤレス デバッグ → adb pair / adb connect）。
cd /d "%~dp0"

adb reverse tcp:8080 tcp:8080
if errorlevel 1 (
  echo.
  echoスマホが見つかりません。ワイヤレス デバッグでadb connectしてから、もう一度実行してください。
  echo PCのChromeだけで使う場合は、このままhttp://localhost:8080/ を開けます。
  echo.
) else (
  echoスマホのChromeでhttp://localhost:8080/ を開いてください。
)

node serve.js 8080
