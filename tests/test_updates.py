import base64
import hashlib
import io
import json
from pathlib import Path
import time
import uuid
import zipfile
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from tc06 import updates
from tc06.update_agent import apply_transaction, active_executable, UpdateLock


@pytest.fixture
def signing(monkeypatch):
    key = Ed25519PrivateKey.generate()
    public = base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
    original = updates.verify_manifest
    monkeypatch.setattr(updates, 'verify_manifest', lambda envelope, current=updates.VERSION: original(envelope, current, public))
    def sign(data):
        raw = json.dumps(data).encode()
        return {'payload': base64.b64encode(raw).decode(), 'signature': base64.b64encode(key.sign(raw)).decode()}
    return sign


def release(signing, extra=None, version='0.6.1'):
    buffer = io.BytesIO()
    files = {'TC06Monitor.exe': b'SYNTHETIC NOT EXECUTABLE', 'ocr/tesseract.exe': b'synthetic', 'ocr/tessdata/eng.traineddata': b'synthetic'}
    files.update(extra or {})
    with zipfile.ZipFile(buffer, 'w') as archive:
        for name, data in files.items():
            info=zipfile.ZipInfo()
            info.filename=name  # Preserve raw separators, including on Windows.
            archive.writestr(info, data)
    raw = buffer.getvalue()
    data = {'version': version, 'url': f'{updates.REPO}/releases/download/v{version}/TC06Monitor-Portable-{version}-x64.zip',
            'size': len(raw), 'unpacked_size': sum(map(len, files.values())), 'sha256': hashlib.sha256(raw).hexdigest()}
    return signing(data), raw, data


def test_signature_tampering_origin_and_downgrade(signing):
    envelope, raw, data = release(signing)
    assert updates.verify_manifest(envelope)['version'] == '0.6.1'
    with pytest.raises(ValueError): updates.verify_manifest(envelope, '0.6.1')
    envelope['payload'] = base64.b64encode(b'{"version":"9.9.9"}').decode()
    with pytest.raises(Exception): updates.verify_manifest(envelope)
    data['url'] = 'https://evil.example/payload.zip'
    with pytest.raises(ValueError): updates.verify_manifest(signing(data))


def test_verified_stage_preserves_history_and_does_not_overwrite_existing(signing, tmp_path):
    envelope, raw, _ = release(signing)
    history = tmp_path/'history.sqlite3'; history.write_bytes(b'synthetic history')
    exe = updates.stage_release(envelope, tmp_path, opener=lambda url: io.BytesIO(raw))
    assert exe.is_file() and history.read_bytes() == b'synthetic history'
    assert (exe.parent/'verified-release.json').is_file()
    assert updates.stage_release(envelope, tmp_path, opener=lambda url: io.BytesIO(raw)) == exe
    exe.write_bytes(b'corrupted staged executable')
    with pytest.raises(ValueError): updates.stage_release(envelope, tmp_path, opener=lambda url: io.BytesIO(raw))
    assert not list((tmp_path/'updates').glob('*.part'))


@pytest.mark.parametrize('path', ['../escape.exe', '/absolute.exe', 'a\\escape.exe', 'a:stream', 'NUL.txt', 'a./b', 'tc06monitor.EXE'])
def test_unsafe_archives_never_touch_existing_install(signing, tmp_path, path):
    envelope, raw, _ = release(signing, {path: b'x'})
    with pytest.raises(ValueError): updates.stage_release(envelope, tmp_path, opener=lambda url: io.BytesIO(raw))
    assert not (tmp_path/'updates'/'versions'/'0.6.1').exists()
    assert not (tmp_path/'escape.exe').exists()


@pytest.mark.parametrize('truncate', [True, False])
def test_incomplete_or_corrupt_download_is_removed(signing, tmp_path, truncate):
    envelope, raw, _ = release(signing)
    corrupt = raw[:-1] if truncate else b'X' + raw[1:]
    with pytest.raises(ValueError): updates.stage_release(envelope, tmp_path, opener=lambda url: io.BytesIO(corrupt))
    assert not list((tmp_path/'updates').glob('*.part'))
    assert not (tmp_path/'updates'/'versions'/'0.6.1').exists()


def job(tmp_path):
    return {'command_id': str(uuid.uuid4()), 'executable': str(tmp_path/'updates'/'versions'/'0.6.1'/'TC06Monitor.exe'),
            'version': '0.6.1', 'previous_executable': str(tmp_path/'installed'/'TC06Monitor.exe'),
            'parent_pid': 123, 'stopped_at': time.time()}


def test_failed_new_process_rolls_back_without_changing_config_or_outbox(tmp_path):
    config = tmp_path/'config.json'; config.write_text('synthetic config')
    history = tmp_path/'history.sqlite3'; history.write_bytes(b'synthetic history')
    j = job(tmp_path); launched=[];stopped=[]
    def start(exe, health): launched.append((str(exe), health)); return 'new process'
    def check(target, preflight):
        if not preflight: raise TimeoutError('synthetic launch failure')
    result = apply_transaction(tmp_path, j, start, check, stopped.append, wait_old=lambda pid: None)
    assert result['status'] == 'rolled_back'
    assert launched[-1] == (j['previous_executable'], False) and stopped == ['new process']
    assert json.loads((tmp_path/'updates'/'active.json').read_text()) == {}
    assert config.read_text() == 'synthetic config' and history.read_bytes() == b'synthetic history'
    with pytest.raises(ValueError): apply_transaction(tmp_path, j, start, check, stopped.append, wait_old=lambda pid: None)


def test_successful_switch_keeps_previous_pointer_and_rejects_replay(tmp_path):
    j=job(tmp_path);exe=Path(j['executable']);exe.parent.mkdir(parents=True);exe.write_bytes(b'fixture')
    updates.atomic_json(tmp_path/'updates'/'active.json', {})
    result=apply_transaction(tmp_path,j,lambda *a,**k:'new',lambda *a,**k:None,lambda p:None,wait_old=lambda pid:None)
    assert result['status']=='completed'
    assert active_executable(tmp_path)==exe
    assert json.loads((tmp_path/'updates'/'transaction.json').read_text())['previous_pointer']=={}


def test_interrupted_switch_restores_previous_pointer(tmp_path):
    root=tmp_path/'updates';root.mkdir()
    updates.atomic_json(root/'active.json', {'executable':'uncommitted.exe'})
    updates.atomic_json(root/'transaction.json', {'status':'switching','command_id':str(uuid.uuid4()),'previous_pointer':{}})
    assert active_executable(tmp_path) is None
    assert json.loads((root/'result.json').read_text())['status']=='rolled_back'


def test_concurrent_agents_cannot_apply_twice(tmp_path):
    with UpdateLock(tmp_path/'agent.lock'):
        with pytest.raises(OSError):
            with UpdateLock(tmp_path/'agent.lock'): pass


def test_restarted_candidate_reports_switching_then_reads_final_result(tmp_path, monkeypatch):
    from tc06.updates import UpdatePoller
    updates.atomic_json(tmp_path/'update-link.json', {'base':'https://example.test','device_id':'synthetic-pc','token':'A'*43})
    command_id=str(uuid.uuid4())
    updates.atomic_json(tmp_path/'updates'/'last-command.json', {'command_id':command_id})
    updates.atomic_json(tmp_path/'updates'/'transaction.json', {'command_id':command_id,'status':'switching'})
    sent=[]
    poller=UpdatePoller(tmp_path,lambda event:None)
    class Client:
        def __init__(self,**kwargs):pass
        def request(self,action,data):
            sent.append(data)
            if len(sent)==1:
                updates.atomic_json(tmp_path/'updates'/'result.json', {'command_id':command_id,'status':'completed','gap_seconds':2})
            else: poller.stop_event.set()
            return {}
    monkeypatch.setattr(updates,'ControlClient',Client)
    monkeypatch.setattr(updates,'latest_manifest',lambda:None)
    monkeypatch.setattr(poller.stop_event,'wait',lambda seconds:False)
    poller.run()
    assert [item['status'] for item in sent]==['switching','completed']
    assert sent[-1]['result']['gap_seconds']==2


def test_newer_manual_installer_never_launches_an_older_cached_version(tmp_path):
    exe=tmp_path/'updates'/'versions'/'0.6.1'/'TC06Monitor.exe';exe.parent.mkdir(parents=True);exe.write_bytes(b'fixture')
    updates.atomic_json(tmp_path/'updates'/'active.json', {'executable':str(exe),'version':'0.6.1'})
    assert active_executable(tmp_path, installed_version='0.7.0') is None
    assert active_executable(tmp_path, installed_version='0.6.0')==exe


def test_ambiguous_claim_response_is_reported_failed_instead_of_executing(tmp_path, monkeypatch):
    from tc06.updates import UpdatePoller
    updates.atomic_json(tmp_path/'update-link.json', {'base':'https://example.test','device_id':'synthetic-pc','token':'A'*43})
    poller=UpdatePoller(tmp_path,lambda event:None);sent=[];command_id=str(uuid.uuid4())
    class Client:
        def __init__(self,**kwargs):pass
        def request(self,action,data):
            if action=='claim':raise OSError('Synthetic lost claim response')
            sent.append(data)
            if len(sent)==1:return {'command':{'id':command_id}}
            poller.stop_event.set();return {}
    monkeypatch.setattr(updates,'ControlClient',Client)
    monkeypatch.setattr(updates,'latest_manifest',lambda:None)
    monkeypatch.setattr(poller.stop_event,'wait',lambda seconds:False)
    monkeypatch.setattr(updates,'stage_release',lambda *a,**k:pytest.fail('Must not execute an ambiguous claim'))
    poller.run()
    assert sent[-1]['status']=='failed' and sent[-1]['command_id']==command_id
