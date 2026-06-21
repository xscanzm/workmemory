$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$venvRoot = Join-Path $root '.ocr-build\.venv'
$python = Join-Path $root '.ocr-build\.venv\Scripts\python.exe'
$systemPython = Get-Command python -ErrorAction SilentlyContinue
$spec = Join-Path $root 'ppocr_cli.spec'
$distRuntime = Join-Path $root 'dist\ppocr_cli'
$targetRuntime = Join-Path $root 'resources\ocr\runtime'
$requirements = @(
  'pip'
  'setuptools'
  'wheel'
  'pyinstaller==6.21.0'
  'paddlepaddle==3.3.1'
  'paddleocr==3.7.0'
  'paddlex==3.7.1'
  'opencv-contrib-python==4.10.0.84'
  'shapely==2.1.2'
  'pyclipper==1.4.0'
)

function Initialize-OcrBuildVenv {
  if (Test-Path -LiteralPath $python) {
    return
  }

  if (-not $systemPython) {
    throw "System Python not found. Install Python 3.11+ or pre-create $venvRoot."
  }

  Write-Host "Creating OCR build virtual environment at $venvRoot"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $venvRoot) | Out-Null
  & $systemPython.Source -m venv $venvRoot
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  if (-not (Test-Path -LiteralPath $python)) {
    throw "OCR build Python not created: $python"
  }

  & $python -m ensurepip --upgrade
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  & $python -m pip install --upgrade @requirements
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

Initialize-OcrBuildVenv

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
