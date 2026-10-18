import datetime as dt
import json
import numpy as np
from tc06.recovery import Recovery, Diagnostics, display_reading


def test_retry_backoff_first_good_and_immediate_recovery_without_filling_gaps():
    watch = Recovery(0)
    bad = {'status': 'ocr_failed'}
    assert watch.observe(bad, 1)['retry_seconds'] == 3
    assert watch.observe(bad, 31)['retry_seconds'] == 10
    assert not watch.observe(bad, 59)['save']
    assert watch.observe(bad, 60)['save']
    good = {'status': 'ok'}
    recovered = watch.observe(good, 63)
    assert recovered['save'] and recovered['recovered'] and recovered['retry_seconds'] == 2
    assert not watch.observe(good, 65)['save']
    assert watch.observe(good, 1000)['save']
    assert not watch.observe(good, 1001)['save']
    assert watch.next_save == 1060


def test_failure_can_never_display_a_held_value_as_current():
    at = dt.datetime(2026, 10, 18, tzinfo=dt.timezone.utc)
    good = {'status': 'ok', 'value_c': 530, 'captured_at': at.isoformat()}
    text = display_reading({'status': 'ocr_failed'}, good, at + dt.timedelta(minutes=4))
    assert '530.0' in text and '마지막 정상값' in text and '4분 전' in text
    assert display_reading({'status': 'ocr_failed'}, None, at) == '— ℃'
    assert display_reading({'status': 'ocr_failed'}, good, at + dt.timedelta(days=31)) == '— ℃'


def test_diagnostics_crops_only_bounds_images_and_records_recovery(tmp_path):
    recorder = Diagnostics(tmp_path)
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    for i in range(30):
        recorder.record({'status': 'ocr_failed', 'roi': [10, 20, 110, 40], 'captured_at': 'synthetic',
                         'ocr_candidates': ['999.9', '999.8']}, frame, now=i*31)
    images = list((tmp_path/'diagnostics').glob('crop-*.png'))
    assert len(images) == 24
    import cv2
    assert all(cv2.imread(str(image)).shape[:2] == (20, 100) for image in images)
    recorder.record({'status': 'ok'}, frame, now=1000)
    recorder.close()
    lines = (tmp_path/'diagnostics'/'failures.jsonl').read_text().splitlines()
    assert json.loads(lines[-1])['status'] == 'ok'
    assert json.loads(lines[0])['ocr_candidates'] == ['999.9', '999.8']
    assert sum(p.stat().st_size for p in images) <= 5_000_000


def test_missing_anchor_never_saves_a_full_screenshot(tmp_path):
    recorder = Diagnostics(tmp_path)
    recorder.record({'status': 'anchor_missing'}, np.zeros((50, 100, 3), dtype=np.uint8), now=0)
    recorder.close()
    assert not list((tmp_path/'diagnostics').glob('*.png'))


def test_short_retry_does_not_increase_normal_recording_frequency():
    watch=Recovery(0)
    assert watch.observe({'status':'ok'},0)['save']
    assert not watch.observe({'status':'ocr_failed'},2)['save']
    assert not watch.observe({'status':'ok'},5)['save']
    assert watch.observe({'status':'ok'},60)['save']


import pytest
@pytest.mark.parametrize('kind,expected', [('capture','source_error'),('window','window_missing'),('ocr','ocr_failed'),('timeout','ocr_timeout')])
def test_worker_categorizes_failures_without_storing_fake_values(tmp_path, monkeypatch, kind, expected):
    import tc06.worker as worker
    class Source:
        def __init__(self,*a):pass
        def read(self):
            if kind in {'capture','window'}:raise RuntimeError('window_missing' if kind=='window' else 'unavailable')
            return np.zeros((10,10,3),dtype=np.uint8)
        def close(self):pass
    class Reader:
        def __init__(self,*a):pass
        def read(self,*a):raise RuntimeError('timeout' if kind=='timeout' else 'ocr failed')
        def invalidate(self):pass
    events=[]
    monitor=worker.Monitor({'server_url':'https://example.test','source':'device','device_id':'synthetic-pc'},tmp_path,lambda event:events.append(event))
    def notify(event):
        events.append(event)
        if 'reading' in event:monitor.stop()
    monitor.notify=notify
    monkeypatch.setattr(worker,'DeviceSource',Source)
    monkeypatch.setattr(worker,'Reader',Reader)
    monitor._collect()
    reading=next(event['reading'] for event in events if 'reading' in event)
    assert reading['status']==expected and reading['value_c'] is None
    assert not any('saved_at' in event for event in events)


def test_last_good_is_persisted_and_scoped_to_device(tmp_path):
    from tc06.core import Outbox, make_record
    box=Outbox(tmp_path/'history.sqlite3')
    record=make_record({'status':'ok','value_c':530,'captured_at':'2026-10-18T00:00:00+00:00'},'synthetic-pc')
    box.add(record);box.close()
    box=Outbox(tmp_path/'history.sqlite3')
    assert box.last_good('synthetic-pc')['value_c']==530
    assert box.last_good('another-pc') is None
    box.close()
