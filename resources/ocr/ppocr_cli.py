import argparse
import json
import os
import shutil
import sys
import time
import traceback
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path


MODEL_NAMES = {
    "tiny": {
        "det": "PP-OCRv6_tiny_det",
        "rec": "PP-OCRv6_tiny_rec",
    },
    "small": {
        "det": "PP-OCRv6_small_det",
        "rec": "PP-OCRv6_small_rec",
    },
}


def _guess_model_key(model_path: str | None) -> str:
    if not model_path:
        return "tiny"
    normalized = model_path.replace("\\", "/").lower()
    if normalized.endswith("/small") or "/small/" in normalized:
        return "small"
    return "tiny"


def _default_cache_home() -> str:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return os.path.join(local_app_data, "WorkMemory", "ocr-paddlex")
    return os.path.join(os.path.expanduser("~"), ".workmemory", "ocr-paddlex")


def _get_bundled_cache_path() -> Path:
    candidates: list[Path] = []
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        candidates.extend([exe_dir / "paddlex", exe_dir.parent / "paddlex"])
    candidates.append(Path(__file__).resolve().parent / "paddlex")

    for candidate in candidates:
        if (candidate / "official_models").exists():
            return candidate
    return candidates[0]


def _prepare_model_cache() -> str:
    cache_home = os.environ.get("PADDLE_PDX_CACHE_HOME") or _default_cache_home()
    bundled_cache = _get_bundled_cache_path()
    target_cache = Path(cache_home)

    bundled_models = bundled_cache / "official_models"
    target_models = target_cache / "official_models"
    if bundled_models.exists():
        target_models.mkdir(parents=True, exist_ok=True)
        for source in bundled_models.iterdir():
            if not source.is_dir():
                continue
            destination = target_models / source.name
            if not destination.exists():
                shutil.copytree(source, destination)

    bundled_fonts = bundled_cache / "fonts"
    target_fonts = target_cache / "fonts"
    if bundled_fonts.exists() and not target_fonts.exists():
        shutil.copytree(bundled_fonts, target_fonts)

    return str(target_cache)


def _configure_dll_search_paths() -> None:
    if not getattr(sys, "frozen", False):
        return

    exe_dir = Path(sys.executable).resolve().parent
    candidates = [
        exe_dir,
        exe_dir / "_internal",
        exe_dir / "_internal" / "paddle" / "libs",
        exe_dir / "_internal" / "numpy.libs",
        exe_dir / "_internal" / "Shapely.libs",
    ]
    existing = [str(candidate) for candidate in candidates if candidate.exists()]
    if not existing:
        return

    os.environ["PATH"] = os.pathsep.join(existing + [os.environ.get("PATH", "")])
    add_dll_directory = getattr(os, "add_dll_directory", None)
    if add_dll_directory:
        for directory in existing:
            try:
                add_dll_directory(directory)
            except OSError:
                pass


def _patch_paddlex_runtime_modules() -> None:
    try:
        import pyclipper
        import paddlex.inference.models.text_detection.processors as text_detection_processors

        text_detection_processors.pyclipper = pyclipper
    except Exception:
        pass


def _box_to_rect(box) -> dict[str, int]:
    points = box.tolist() if hasattr(box, "tolist") else box
    if not isinstance(points, list) or len(points) == 0:
        return {"x": 0, "y": 0, "w": 0, "h": 0}

    xs: list[float] = []
    ys: list[float] = []
    for point in points:
        if isinstance(point, (list, tuple)) and len(point) >= 2:
            xs.append(float(point[0]))
            ys.append(float(point[1]))

    if not xs or not ys:
        return {"x": 0, "y": 0, "w": 0, "h": 0}

    min_x = min(xs)
    max_x = max(xs)
    min_y = min(ys)
    max_y = max(ys)
    return {
        "x": int(round(min_x)),
        "y": int(round(min_y)),
        "w": int(round(max_x - min_x)),
        "h": int(round(max_y - min_y)),
    }


def _extract_result(prediction) -> tuple[list[str], list[dict[str, int]], list[float]]:
    texts: list[str] = []
    boxes: list[dict[str, int]] = []
    scores: list[float] = []

    for item in prediction:
        data = getattr(item, "json", None)
        if isinstance(data, dict):
            data = data.get("res", data)
        elif hasattr(item, "to_dict"):
            data = item.to_dict()
        elif isinstance(item, dict):
            data = item
        else:
            data = {}

        rec_texts = data.get("rec_texts") or data.get("texts") or []
        rec_scores = data.get("rec_scores") or data.get("scores") or []
        rec_boxes = data.get("rec_boxes") or data.get("dt_polys") or data.get("boxes") or []

        for text in rec_texts:
            texts.append(str(text))
        for score in rec_scores:
            try:
                scores.append(float(score))
            except (TypeError, ValueError):
                scores.append(1.0)
        for box in rec_boxes:
            boxes.append(_box_to_rect(box))

    return texts, boxes, scores


def _prepare_runtime(cpu_threads: int) -> None:
    _configure_dll_search_paths()
    os.environ["OMP_NUM_THREADS"] = str(max(1, cpu_threads))
    os.environ["FLAGS_cpu_deterministic"] = "1"
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    os.environ["PADDLE_PDX_CACHE_HOME"] = _prepare_model_cache()

    import paddlex.utils.deps as paddlex_deps

    # PyInstaller has already bundled the runtime modules, but PaddleX checks
    # package metadata that can be incomplete in a frozen app. The CLI is a
    # fixed local OCR runtime, so skip those metadata-only gates.
    paddlex_deps.is_dep_available = lambda dep, check_version=False: True
    paddlex_deps.require_deps = lambda *deps, obj_name=None: None
    paddlex_deps.is_extra_available = lambda extra: True
    paddlex_deps.require_extra = lambda extra, obj_name=None, alt=None: None

    from paddleocr import PaddleOCR
    _patch_paddlex_runtime_modules()

    return PaddleOCR


def create_ocr(model_path: str | None, cpu_threads: int):
    PaddleOCR = _prepare_runtime(cpu_threads)

    models = MODEL_NAMES[_guess_model_key(model_path)]

    return PaddleOCR(
        ocr_version="PP-OCRv6",
        lang="ch",
        text_detection_model_name=models["det"],
        text_recognition_model_name=models["rec"],
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
        enable_mkldnn=False,
        cpu_threads=max(1, cpu_threads),
    )


def predict_with_ocr(ocr, image_path: str) -> dict:
    start = time.perf_counter()
    with open(os.devnull, "w", encoding="utf-8") as sink:
        with redirect_stdout(sink), redirect_stderr(sink):
            prediction = ocr.predict(image_path)

    texts, boxes, scores = _extract_result(prediction)
    elapsed = int((time.perf_counter() - start) * 1000)
    confidence = sum(scores) / len(scores) if scores else 1.0
    return {
        "text": "\n".join(text for text in texts if text.strip()),
        "boxes": boxes,
        "confidence": confidence,
        "elapsed": elapsed,
    }


def recognize(image_path: str, model_path: str | None, cpu_threads: int) -> dict:
    with open(os.devnull, "w", encoding="utf-8") as sink:
        with redirect_stdout(sink), redirect_stderr(sink):
            ocr = create_ocr(model_path, cpu_threads)
    return predict_with_ocr(ocr, image_path)


def server_loop(model_path: str | None, cpu_threads: int) -> int:
    try:
        with open(os.devnull, "w", encoding="utf-8") as sink:
            with redirect_stdout(sink), redirect_stderr(sink):
                ocr = create_ocr(model_path, cpu_threads)
        print(json.dumps({"ready": True}, ensure_ascii=False), flush=True)
    except Exception as exc:
        print(json.dumps(
            {"ready": False, "error": str(exc), "traceback": traceback.format_exc()},
            ensure_ascii=False,
        ), flush=True)
        return 1

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            image_path = str(request.get("image_path") or "")
            if not image_path:
                raise ValueError("image_path is required")
            result = predict_with_ocr(ocr, image_path)
            print(json.dumps(result, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps(
                {"error": str(exc), "traceback": traceback.format_exc()},
                ensure_ascii=False,
            ), flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="WorkMemory PP-OCRv6 CLI")
    parser.add_argument("--image_path")
    parser.add_argument("--cpu_threads", type=int, default=4)
    parser.add_argument("--model_path", default=None)
    parser.add_argument("--output", choices=["json"], default="json")
    parser.add_argument("--server", action="store_true")
    args = parser.parse_args()

    if args.server:
        return server_loop(args.model_path, args.cpu_threads)

    if not args.image_path:
        print("--image_path is required unless --server is used", file=sys.stderr, flush=True)
        return 2

    try:
        result = recognize(args.image_path, args.model_path, args.cpu_threads)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr, flush=True)
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
