"""Public site interval, validated and cached for this server only."""
import json
from pathlib import Path


def valid_interval(value):
    return type(value) is int and 30 <= value <= 3600


def load_interval(path, server):
    try:
        data = json.loads(Path(path).read_text("utf-8"))
        if data.get("server") == server and valid_interval(data.get("interval_seconds")):
            return data["interval_seconds"]
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return 60


def save_interval(path, server, seconds):
    from .updates import atomic_json
    atomic_json(Path(path), {"server": server, "interval_seconds": seconds})
