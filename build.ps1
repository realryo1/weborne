# Builds web/weborne.wasm and copies the runtime files into web/.
#   powershell -ExecutionPolicy Bypass -File build.ps1
# Needs Go 1.26+ (PATH, or the portable copy in .work\go) and npm.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$go = 'go'
if (Test-Path "$here\.work\go\bin\go.exe") { $go = "$here\.work\go\bin\go.exe" }

Push-Location "$here\go"
try {
  $env:GOOS = 'js'; $env:GOARCH = 'wasm'
  & $go build -trimpath -ldflags='-s -w' -o "$here\web\weborne.wasm" ./cmd/weborne-wasm
  if ($LASTEXITCODE -ne 0) { throw 'go build failed' }
  $goroot = (& $go env GOROOT)
  Copy-Item "$goroot\lib\wasm\wasm_exec.js" "$here\web\wasm_exec.js" -Force
} finally {
  Remove-Item Env:GOOS, Env:GOARCH -ErrorAction SilentlyContinue
  Pop-Location
}

Push-Location $here
try {
  if (-not (Test-Path "node_modules\@ffmpeg\core")) { npm install --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm install failed' } }
  New-Item -ItemType Directory -Force "web\ffmpeg" | Out-Null
  Copy-Item "node_modules\@ffmpeg\core\dist\esm\ffmpeg-core.js", "node_modules\@ffmpeg\core\dist\esm\ffmpeg-core.wasm" "web\ffmpeg\" -Force
} finally {
  Pop-Location
}
Write-Host 'built web/'
