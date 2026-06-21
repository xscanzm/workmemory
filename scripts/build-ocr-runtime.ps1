$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root '.ocr-build\.venv\Scripts\python.exe'
$spec = Join-Path $root 'ppocr_cli.spec'
$distRuntime = Join-Path $root 'dist\ppocr_cli'
$targetRuntime = Join-Path $root 'resources\ocr\runtime'

if (-not (Test-Path -LiteralPath $python)) {
  throw "OCR build Python not found: $python"
}

if (-not (Test-Path -LiteralPath $spec)) {
  throw "PyInstaller spec not found: $spec"
}

& $python -m PyInstaller --noconfirm $spec
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $distRuntime)) {
  throw "PyInstaller output not found: $distRuntime"
}

if (Test-Path -LiteralPath $targetRuntime) {
  Remove-Item -LiteralPath $targetRuntime -Recurse -Force
}
New-Item -ItemType Directory -Path $targetRuntime | Out-Null
Copy-Item -Path (Join-Path $distRuntime '*') -Destination $targetRuntime -Recurse -Force

Write-Host "OCR runtime copied to $targetRuntime"
