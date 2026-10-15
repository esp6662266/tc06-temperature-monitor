"""Collect installed Python distribution notices for the frozen distribution."""
import importlib.metadata
from pathlib import Path
import shutil
import sys

target = Path(sys.argv[1])
target.mkdir(parents=True, exist_ok=True)
index = []
for dist in importlib.metadata.distributions():
    name = dist.metadata.get("Name", "unknown")
    index.append(f"{name} {dist.version}")
    for member in dist.files or []:
        if any(word in str(member).lower() for word in ("license", "copying", "notice")):
            source = Path(dist.locate_file(member))
            if source.is_file():
                dest = target / name / str(member).replace("..", "_").replace("/", "_").replace("\\", "_")
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, dest)
for source in [Path(sys.base_prefix)/"LICENSE.txt", Path(sys.base_prefix)/"LICENSE"]:
    if source.is_file():
        shutil.copy2(source, target/"PYTHON-LICENSE.txt")
(target/"DISTRIBUTIONS.txt").write_text("\n".join(sorted(index))+"\n", encoding="utf-8")
