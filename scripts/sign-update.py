"""Sign a tested portable artifact. Signing material is never written to the release."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import zipfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "collector"))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from tc06.updates import REPO, verify_manifest
from tc06.trust import PUBLIC_KEY

parser = argparse.ArgumentParser()
parser.add_argument("portable")
parser.add_argument("version")
parser.add_argument("--key-file")
args = parser.parse_args()
key = (Path(args.key_file).read_bytes() if args.key_file else base64.b64decode(os.environ["TC06_SIGNING_KEY"], validate=True))
private = Ed25519PrivateKey.from_private_bytes(key)
public = base64.b64encode(private.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)).decode()
if public != PUBLIC_KEY:
    raise ValueError("Signing key does not match the application's pinned public key")
path = Path(args.portable)
with zipfile.ZipFile(path) as archive:
    unpacked = sum(info.file_size for info in archive.infolist())
payload = json.dumps({"version":args.version,"url":f"{REPO}/releases/download/v{args.version}/{path.name}",
    "size":path.stat().st_size,"unpacked_size":unpacked,"sha256":hashlib.sha256(path.read_bytes()).hexdigest()},separators=(",",":")).encode()
envelope = {"payload":base64.b64encode(payload).decode(),"signature":base64.b64encode(private.sign(payload)).decode()}
verify_manifest(envelope, "0.0.0")
(path.parent / "update-manifest.json").write_text(json.dumps(envelope,indent=2),encoding="utf-8")
print("Signed update-manifest.json created for verified portable artifact")
