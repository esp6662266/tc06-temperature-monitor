"""Packaged-runtime check; synthetic frames only, no camera or network access."""
import json
import platform
from pathlib import Path
import sys
import traceback
from .recovery import VERSION


def run(report):
    result = {"ok": False, "version": VERSION, "platform": platform.platform(),
              "python": platform.python_version(), "bundled": bool(getattr(sys, "frozen", False)),
              "synthetic_only": True, "upload_performed": False, "cases": []}
    try:
        import cv2
        import numpy as np
        import pytesseract
        import mss
        import sqlite3
        from PIL import Image, ImageTk
        from .ocr import Reader
        from .runtime import resolve_ocr
        result["ocr"] = resolve_ocr()
        pytesseract.pytesseract.tesseract_cmd = result["ocr"]
        result["tesseract"] = str(pytesseract.get_tesseract_version())
        for value in ["350.0", "900.0", "999.9", "1000.0"]:
            reader = Reader()
            for tick in range(3):
                image = np.full((720,1280,3),215,np.uint8)
                cv2.putText(image, f"12:34:{56+tick}", (1040,40), cv2.FONT_HERSHEY_SIMPLEX,.7,(0,0,0),2)
                cv2.putText(image,"TC-06",(280,360),cv2.FONT_HERSHEY_SIMPLEX,.7,(0,0,0),2)
                cv2.rectangle(image,(365,343),(465,365),(85,85,85),-1)
                cv2.putText(image,value,(370,360),cv2.FONT_HERSHEY_SIMPLEX,.55,(255,255,255),1)
                cv2.putText(image,"C",(450,360),cv2.FONT_HERSHEY_SIMPLEX,.55,(255,255,255),1)
                reading = reader.read(image)
                if tick < 2:
                    assert reading["value_c"] is None, reading
            assert reading["status"] == "ok" and reading["value_c"] == float(value), reading
            result["cases"].append({"input": value, "actual": reading["value_c"], "status": reading["status"]})
        result["ok"] = True
    except Exception:
        result["error"] = traceback.format_exc()
    target = Path(report)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if result["ok"] else 1
