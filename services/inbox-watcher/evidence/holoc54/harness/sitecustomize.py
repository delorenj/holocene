"""Review-only inherited process guard. No source changes; all artifacts under review scratch."""
import atexit
import ipaddress
import json
import os
from pathlib import Path
import sys

ROOT = Path(os.environ['HOLOC54_SCRATCH']).resolve()
if not ROOT.is_relative_to(Path('/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch').resolve()):
    raise RuntimeError('HOLOC54_SCRATCH must be inside the active profile scratch directory')
BOUND = []
COUNTS = {'scratch_write_events': 0, 'fixture_connect_events': 0, 'fixture_process_events': 0}
BLOCKED = []

def inside(raw):
    if isinstance(raw, int) or raw is None or raw in ('/dev/null', b'/dev/null'):
        return True
    try:
        return Path(os.fsdecode(raw)).resolve().is_relative_to(ROOT)
    except (ValueError, TypeError, OSError):
        return False

def deny(event, detail):
    BLOCKED.append({'event':event, 'detail':str(detail)[:500]})
    raise PermissionError('review guard refused ' + event + ': ' + str(detail)[:200])

def audit(event, args):
    if event == 'open':
        path, mode, flags = args
        if (isinstance(mode,str) and any(c in mode for c in 'wax+')) or (isinstance(flags,int) and flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND)):
            if not inside(path): deny(event,path)
            COUNTS['scratch_write_events'] += 1
        elif isinstance(path,(str,bytes)):
            p = os.fsdecode(path)
            if '/.mc/' in p or ('/.hermes/' in p and not inside(p) and p.endswith(('config.yaml','.env','converse.json','state.json'))):
                deny('protected_read', p)
    elif event in ('os.mkdir','os.remove','os.rmdir','os.chmod','os.utime','os.truncate'):
        if not inside(args[0]): deny(event,args[0])
    elif event in ('os.rename','os.link'):
        if not all(inside(x) for x in args[:2]): deny(event,args[:2])
    elif event == 'os.symlink':
        if not inside(args[1]): deny(event,args)
    elif event == 'socket.bind':
        sock, address = args
        if not isinstance(address,tuple) or address[0] not in ('127.0.0.1','::1','localhost','0.0.0.0') or address[1] != 0:
            deny(event,address)
        BOUND.append(sock)
    elif event == 'socket.connect':
        sock,address = args
        ports = set()
        for s in BOUND:
            try: ports.add(s.getsockname()[1])
            except OSError: pass
        # Bound ephemeral fake HTTP servers, plus the deliberately closed localhost port 9.
        if not isinstance(address,tuple) or address[0] not in ('127.0.0.1','::1') or address[1] not in ports|{9}:
            deny(event,address)
        COUNTS['fixture_connect_events'] += 1
    elif event == 'subprocess.Popen':
        executable, argv, cwd, env = args
        ep = Path(os.fsdecode(executable)).resolve()
        # Python is permitted only for inspected source imports/CLI or scratch fixture scripts.
        if not inside(ep) and not (ep.name.startswith('python') and (str(ep).startswith('/usr/bin/') or str(ep).startswith('/home/delorenj/.hermes/installs/'))):
            deny(event,argv)
        if ep.name.startswith('python'):
            texts = ' '.join(map(str,argv))
            if any(x in texts for x in ('skillex/all-skills','inbox_watcher.py --once','inbox_watcher.py --drain')):
                deny(event,argv)
        COUNTS['fixture_process_events'] += 1
    elif event == 'os.system':
        deny(event,args)

sys.addaudithook(audit)

def finish():
    p = ROOT / ('guard-' + str(os.getpid()) + '.json')
    p.write_text(json.dumps({'pid':os.getpid(),'counts':COUNTS,'blocked':BLOCKED},indent=2))
atexit.register(finish)
