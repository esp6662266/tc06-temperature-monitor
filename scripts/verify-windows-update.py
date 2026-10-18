"""Exercise real packaged launches and rollback in an isolated Windows user-data root."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"collector"))
from tc06.update_agent import active_executable
from tc06.updates import atomic_json
from tc06.recovery import VERSION

parser=argparse.ArgumentParser()
parser.add_argument('bundle')
parser.add_argument('report')
args=parser.parse_args()
if os.name!='nt':
    raise RuntimeError('Windows integration check only')
previous=os.environ.get('LOCALAPPDATA')
result={'ok':False,'real_packaged_processes':True,'synthetic_only':True,'field_capture_tested':False}
with tempfile.TemporaryDirectory(prefix='tc06-update-check-') as temporary:
    scratch=Path(temporary)
    runtime=scratch/'UserData'/'TC06Monitor'
    os.environ['LOCALAPPDATA']=str(runtime.parent)
    root=runtime/'updates';root.mkdir(parents=True)
    bundle=Path(args.bundle).resolve()
    staged=root/'versions'/VERSION
    shutil.copytree(bundle,staged)
    marker=runtime/'history.sqlite3';marker.write_bytes(b'Synthetic preservation marker, not an SQLite database')
    # No monitor config: these processes must never capture or upload.
    process_ids=[]
    def stop_candidate():
        report=root/'health.json'
        for report in root.glob('*-health.json'):
            data=json.loads(report.read_text('utf-8'))
            if data.get('pid'): process_ids.append(data['pid'])
        for pid in set(process_ids):
            subprocess.run(['taskkill','/PID',str(pid),'/F'],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        time.sleep(1)
    try:
        job={'command_id':str(uuid.uuid4()),'version':VERSION,'executable':str(staged/'TC06Monitor.exe'),
             'previous_executable':str(bundle/'TC06Monitor.exe'),'parent_pid':os.getpid()+1000000,'stopped_at':time.time()}
        path=root/'job.json';atomic_json(path,job)
        subprocess.run([str(bundle/'TC06Monitor.exe'),'--apply-update',str(path)],cwd=bundle,timeout=200,check=True)
        outcome=json.loads((root/'result.json').read_text('utf-8'))
        assert outcome['status']=='completed',outcome
        assert active_executable(runtime, installed_version='0.5.0')==(staged/'TC06Monitor.exe').resolve()
        assert marker.read_bytes().startswith(b'Synthetic')
        result['successful_launch_and_switch']=True
        stop_candidate()
        # A deliberately corrupt *new* executable triggers a launch failure and restarts the known good bundle.
        bad_version='999.0.0';bad=root/'versions'/bad_version;bad.mkdir(parents=True)
        (bad/'TC06Monitor.exe').write_bytes(b'Synthetic corrupt executable')
        job.update(command_id=str(uuid.uuid4()),version=bad_version,executable=str(bad/'TC06Monitor.exe'),stopped_at=time.time())
        atomic_json(path,job)
        subprocess.run([str(bundle/'TC06Monitor.exe'),'--apply-update',str(path)],cwd=bundle,timeout=200,check=True)
        outcome=json.loads((root/'result.json').read_text('utf-8'))
        assert outcome['status']=='rolled_back',outcome
        assert marker.read_bytes().startswith(b'Synthetic')
        result['corrupt_executable_rollback']=True
        # The fallback was started without a health report; find only the exact scratch-free bundle executable.
        escaped=str(bundle/'TC06Monitor.exe').replace("'","''")
        query="Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '"+escaped+"' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
        subprocess.run(['powershell','-NoProfile','-Command',query],check=True)
        time.sleep(1)
        result['ok']=True
    finally:
        stop_candidate()
        if previous is None: os.environ.pop('LOCALAPPDATA',None)
        else: os.environ['LOCALAPPDATA']=previous
Path(args.report).write_text(json.dumps(result,indent=2),encoding='utf-8')
if not result['ok']:sys.exit(1)
