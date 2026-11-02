@echo off
rem weborne: assigns the in-box WinUSB driver to torne (Sony CECH-ZD1 J).
rem Based on coax driver\windows\install-winusb.bat (Apache-2.0, Till0196),
rem with cech-zd1j-winusb.inf embedded. Double-click it and answer the UAC prompt.
rem (The batch part is ASCII on purpose: cmd.exe reads it in the ANSI code page.)

setlocal EnableExtensions
set "WEBORNE_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$m='#@P'+'S'; $s=Get-Content -LiteralPath $env:WEBORNE_SELF -Raw -Encoding UTF8; Invoke-Expression (($s -split $m,2)[1])"
exit /b %ERRORLEVEL%

#@PS
$ErrorActionPreference = 'Stop'
function Quote([string]$s) { "'" + ($s -replace "'", "''") + "'" }
$self = $env:WEBORNE_SELF

# ドライバの導入には管理者権限が要るので、UACで自分自身を起動し直す。
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $boot = '$m=' + (Quote ('#@P' + 'S')) + '; $s=Get-Content -LiteralPath $env:WEBORNE_SELF -Raw -Encoding UTF8; Invoke-Expression (($s -split $m,2)[1])'
  $cmd = '$env:WEBORNE_SELF=' + (Quote $self) + '; ' + $boot
  Start-Process -Verb RunAs -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd | Out-Null
  exit 0
}

$inf = @'
; Copyright 2026 Till0196
; SPDX-License-Identifier: Apache-2.0
;
; Development INF for binding the Sony CECH-ZD1 J to the in-box WinUSB
; driver. Production distribution requires a signed catalog.

[Version]
Signature   = "$Windows NT$"
Class       = USBDevice
ClassGuid   = {88BAE032-5A81-49F0-BC3D-A4FF138216D6}
Provider    = %ProviderName%
CatalogFile = cech-zd1j-winusb.cat
DriverVer   = 09/25/2026,1.0.0.0

[Manufacturer]
%ManufacturerName% = DeviceList,NTamd64,NTarm64

[DeviceList.NTamd64]
%DeviceName% = WinUSBInstall, USB\VID_054C&PID_04B2

[DeviceList.NTarm64]
%DeviceName% = WinUSBInstall, USB\VID_054C&PID_04B2

[WinUSBInstall]
Include = winusb.inf
Needs   = WINUSB.NT
AddProperty = DeviceSetup.AddProperty

[WinUSBInstall.Services]
Include = winusb.inf
Needs   = WINUSB.NT.Services

[WinUSBInstall.HW]
AddReg = DeviceInterfaceGUID

[DeviceInterfaceGUID]
HKR,,DeviceInterfaceGUIDs,0x10000,"{B8F4B677-E19A-4BEB-A60C-C0A7AC2D0F6B}"

[DeviceSetup.AddProperty]
; DEVPKEY_Device_SafeRemovalRequiredOverride = FALSE
{afd97640-86a3-4210-b67c-289c41aabe55},3,0x00000011,,0

[Strings]
ProviderName     = "coax"
ManufacturerName = "Sony"
DeviceName       = "Sony CECH-ZD1 J (WinUSB)"
'@

Write-Host 'torne (Sony CECH-ZD1 J)にWinUSBドライバを割り当てます。' -ForegroundColor Cyan

# この実行のためだけの署名用証明書を作り、カタログに署名する。公開鍵は
# RootとTrustedPublisherに入れ、秘密鍵は署名が終わったら消す。
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=coax WinUSB signing' `
  -CertStoreLocation Cert:\LocalMachine\My -NotAfter (Get-Date).AddYears(2)
$signer = "Cert:\LocalMachine\My\$($cert.Thumbprint)"
$failed = $false
$stage = Join-Path $env:TEMP ('weborne-winusb-' + [guid]::NewGuid().ToString('N'))
try {
  $cer = Join-Path $env:TEMP ('weborne-signing-' + $cert.Thumbprint + '.cer')
  Export-Certificate -Cert $cert -FilePath $cer | Out-Null
  try {
    foreach ($store in 'Root', 'TrustedPublisher') {
      Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\LocalMachine\$store" | Out-Null
    }
  } finally {
    Remove-Item -LiteralPath $cer -Force -ErrorAction SilentlyContinue
  }

  New-Item -ItemType Directory -Path $stage | Out-Null
  $infPath = Join-Path $stage 'cech-zd1j-winusb.inf'
  [IO.File]::WriteAllText($infPath, ($inf -replace "`r?`n", "`r`n"), [Text.Encoding]::ASCII)
  New-FileCatalog -Path $stage -CatalogFilePath (Join-Path $stage 'cech-zd1j-winusb.cat') -CatalogVersion 2 | Out-Null
  $sig = Set-AuthenticodeSignature -FilePath (Join-Path $stage 'cech-zd1j-winusb.cat') -Certificate $cert
  if ($sig.Status -ne 'Valid') { throw "署名に失敗しました: $($sig.StatusMessage)" }

  & pnputil.exe /add-driver $infPath /install
  switch ($LASTEXITCODE) {
    0 { Write-Host '完了しました。' -ForegroundColor Green }
    259 { Write-Host 'ドライバを登録しました（torneはまだ挿さっていません）。挿せばそのまま使えます。' -ForegroundColor Green }
    3010 { Write-Host '完了しました。Windowsが再起動を求めています。' -ForegroundColor Yellow }
    default { Write-Host "pnputilが失敗しました(コード$LASTEXITCODE)。" -ForegroundColor Red; $failed = $true }
  }
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  $failed = $true
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $signer -DeleteKey -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if (-not $failed) { Write-Host 'torneを一度抜いて挿し直し、ブラウザで「接続」を押してください。' }
Read-Host 'Enterキーで閉じます'
