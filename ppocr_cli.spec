# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules, copy_metadata


datas = []
datas += collect_data_files('paddlex', includes=['configs/**/*', 'modules/**/*'])
datas += collect_data_files('paddleocr', includes=['**/*.txt', '**/*.yaml', '**/*.yml', '**/*.json'])
datas += collect_data_files('paddle', includes=['libs/*.dll', 'libs/*.lib'])
datas += collect_data_files('cv2')
datas += collect_data_files('shapely')
datas += copy_metadata('opencv-contrib-python')
datas += copy_metadata('shapely')
datas += copy_metadata('pyclipper')
binaries = []
binaries += collect_dynamic_libs('paddle')
hiddenimports = []
hiddenimports += collect_submodules('paddleocr._pipelines')
hiddenimports += collect_submodules('paddleocr._utils')
hiddenimports += collect_submodules('paddlex.inference.common')
hiddenimports += collect_submodules('paddlex.inference.components')
hiddenimports += collect_submodules('paddlex.inference.models.common')
hiddenimports += collect_submodules('paddlex.inference.models.predictors')
hiddenimports += collect_submodules('paddlex.inference.models.text_detection')
hiddenimports += collect_submodules('paddlex.inference.models.text_recognition')
hiddenimports += collect_submodules('paddlex.inference.pipelines.base')
hiddenimports += collect_submodules('paddlex.inference.pipelines.components')
hiddenimports += collect_submodules('paddlex.inference.pipelines.ocr')
hiddenimports += collect_submodules('paddlex.inference.utils')
hiddenimports += collect_submodules('cv2')
hiddenimports += collect_submodules('shapely')
hiddenimports += collect_submodules('pyclipper')


a = Analysis(
    ['resources\\ocr\\ppocr_cli.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ppocr_cli',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='ppocr_cli',
)
