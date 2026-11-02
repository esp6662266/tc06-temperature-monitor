import io
import json
import threading
import pytest
from tc06.collection import valid_interval, load_interval, save_interval
from tc06.recovery import Recovery
from tc06.worker import Monitor


def test_intervals_reanchor_to_last_save_without_filling_gaps():
    watch = Recovery(0)
    assert watch.observe({'status': 'ok'}, 2)['save']
    watch.set_interval(300)
    assert not watch.observe({'status': 'ok'}, 62)['save']
    assert watch.observe({'status': 'ok'}, 302)['save']
    watch.set_interval(30)
    assert watch.observe({'status': 'ok'}, 400)['save']
    assert not watch.observe({'status': 'ok'}, 401)['save']
    assert watch.next_save == 430
    watch.set_interval(600)
    assert watch.next_save == 1000


def test_failure_and_confirmed_recovery_keep_real_records():
    watch = Recovery(0, interval_seconds=300)
    assert not watch.observe({'status': 'ocr_failed'}, 60)['save']
    assert watch.observe({'status': 'ocr_failed'}, 300)['save']
    assert watch.observe({'status': 'ok'}, 310)['save']
    assert not watch.observe({'status': 'ok'}, 312)['save']
    assert watch.next_save == 610


@pytest.mark.parametrize('value', [None, True, '300', 29, 3601, 300.5])
def test_invalid_intervals_do_not_change_schedule(value):
    assert not valid_interval(value)
    watch = Recovery(0)
    with pytest.raises(ValueError):
        watch.set_interval(value)
    assert watch.next_save == 60


def test_interval_cache_is_validated_and_scoped_to_the_server(tmp_path):
    path = tmp_path / 'interval.json'
    save_interval(path, 'https://example.test', 300)
    assert load_interval(path, 'https://example.test') == 300
    assert load_interval(path, 'https://another.test') == 60
    path.write_text('[]')
    assert load_interval(path, 'https://example.test') == 60


@pytest.mark.parametrize('reply', [{'interval_seconds': 300}, {'interval_seconds': 0}, None])
def test_settings_sync_keeps_last_valid_value_and_polls_at_five_minutes(tmp_path, monkeypatch, reply):
    save_interval(tmp_path / 'collection-settings.json', 'https://example.test', 120)
    monitor = Monitor({'server_url': 'https://example.test'}, tmp_path, lambda event: None)
    waits = []
    class StopAfterWait(threading.Event):
        def wait(self, seconds):
            waits.append(seconds)
            self.set()
    monitor.stop_event = StopAfterWait()
    def response(request, timeout):
        assert request.full_url == 'https://example.test/api/settings' and timeout == 15
        if reply is None:
            raise OSError('synthetic offline')
        return io.BytesIO(json.dumps(reply).encode())
    monkeypatch.setattr('urllib.request.urlopen', response)
    monitor._sync_settings()
    expected = 300 if reply and reply.get('interval_seconds') == 300 else 120
    assert monitor.record_interval_seconds == expected
    assert load_interval(monitor.interval_path, monitor.base) == expected
    assert waits == [300]


def test_update_heartbeat_advertises_and_waits_five_minutes(tmp_path, monkeypatch):
    from tc06 import updates
    (tmp_path / 'update-link.json').write_text(json.dumps({'server_url': 'https://example.test', 'device_id': 'synthetic', 'token': 'A'*43}))
    poller = updates.UpdatePoller(tmp_path, lambda event: None)
    calls, waits = [], []
    class Client:
        def __init__(self, **kwargs):
            pass
        def request(self, action, data):
            calls.append((action, data))
            return {'command': None}
    class StopAfterWait(threading.Event):
        def wait(self, seconds):
            waits.append(seconds)
            self.set()
    poller.stop_event = StopAfterWait()
    monkeypatch.setattr(updates, 'ControlClient', Client)
    monkeypatch.setattr(updates, 'latest_manifest', lambda: None)
    poller.run()
    assert len(calls) == 1 and calls[0][0] == 'heartbeat'
    assert calls[0][1]['heartbeat_seconds'] == 300
    assert waits == [300]
