# Third-party runtime notices

The installed application contains Python, Tcl/Tk, OpenCV, NumPy, Pillow, mss,
pytesseract and the PyInstaller runtime. Their distribution notices are in
`licenses` and the bundled runtime data directories. PyInstaller's license
includes an exception permitting distribution of bundled applications.

The `ocr` directory contains an unmodified Tesseract 5.5.3 executable and DLLs
from the UB Mannheim Windows distribution published by tesseract-ocr, plus a
pinned English tessdata_fast model. Only the main OCR executable is used; no
training executable, third-party uninstaller, system registration or PATH change
is installed. `runtime-origins.json` records download URLs and SHA-256 values.
Tesseract notices are in `ocr/doc`. The DLLs retain their upstream licenses;
Tesseract's Apache license does not replace the licenses of its dependencies.

Upstream source and build information:

- https://github.com/tesseract-ocr/tesseract/tree/5.5.3
- https://github.com/UB-Mannheim/tesseract
- https://github.com/tesseract-ocr/tessdata_fast/tree/87416418657359cb625c412a48b6e1d6d41c29bd
- https://github.com/msys2/MINGW-packages
- https://repo.msys2.org/mingw/sources/
- https://github.com/python/cpython
- https://github.com/opencv/opencv-python
- https://github.com/numpy/numpy
- https://github.com/python-pillow/Pillow
- https://github.com/BoboTiG/python-mss
- https://github.com/madmaze/pytesseract
- https://github.com/pyinstaller/pyinstaller

The monitor source is available at:
https://github.com/esp6662266/tc06-temperature-monitor
