"""One-time, additive Gateway change authorized for Pulso. No env/DB access."""
import ast
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import types
import urllib.request

TARGET = Path('/opt/agent-platform/gateway/current/api/app/services/gateway_tools.py')
SERVICE = 'agent-gateway.service'
ADDITIONS = [
    {'method': 'GET', 'path': '/api/v1/models', 'label': 'Inventario nativo',
     'description': 'Verifica el tipo y la instancia cargada de modelos de decisiones.',
     'requires_api_key': False, 'body_enabled': False, 'example_body': None},
    {'method': 'POST', 'path': '/v1/systemone', 'label': 'Decisiones Clef',
     'description': 'Ejecuta decisiones tipadas del modelo Clef cargado en LM Studio.',
     'requires_api_key': False, 'body_enabled': True, 'example_body': None},
]

def catalog(source):
    ast.parse(source)
    module = types.ModuleType('_pulso_route_check')
    sys.modules[module.__name__] = module
    exec(compile(source, str(TARGET), 'exec'), module.__dict__)
    return module.list_gateway_tools(module.ToolRuntimeConfig())

def replace_atomically(path, data, info):
    fd, temp = tempfile.mkstemp(prefix='.pulso-clef-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
            os.fchmod(out.fileno(), stat.S_IMODE(info.st_mode))
            os.fchown(out.fileno(), info.st_uid, info.st_gid)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)

def restart_and_check():
    subprocess.run(['systemctl', 'restart', SERVICE], check=True, timeout=45, capture_output=True)
    healthy = 0
    for _ in range(15):
        time.sleep(1)
        try:
            subprocess.run(['systemctl', 'is-active', '--quiet', SERVICE], check=True, timeout=5, capture_output=True)
            with urllib.request.urlopen('http://127.0.0.1:9000/openapi.json', timeout=3) as response:
                if response.status != 200 or not json.load(response).get('paths'):
                    raise RuntimeError('Gateway HTTP not ready')
            healthy += 1
            if healthy >= 3:
                return
        except Exception:
            healthy = 0
    raise RuntimeError('Gateway did not reach stable HTTP readiness')

def main():
    if TARGET.is_symlink():
        raise RuntimeError('Unexpected source symlink')
    original = TARGET.read_bytes()
    info = TARGET.stat()
    before = catalog(original.decode())
    targets = [t for t in before if t['key'] == 'gemma']
    if len(targets) != 1:
        raise RuntimeError('Unexpected tool catalog')
    routes = {(r['method'], r['path']) for r in targets[0]['paths']}
    desired = {(r['method'], r['path']) for r in ADDITIONS}
    if desired <= routes:
        # Recover an interrupted prior attempt between atomic replace/restart.
        restart_and_check()
        print(json.dumps({'operation': 'enable-clef-native-routes', 'changed': False, 'already_present': True, 'service_ready': True}))
        return
    if routes != {('GET', '/v1/models'), ('POST', '/api/v1/chat'), ('POST', '/v1/chat/completions')}:
        raise RuntimeError('Gateway routes changed; inspect before applying')
    text = original.decode()
    marker = '"key": "gemma",'
    if text.count(marker) != 1:
        raise RuntimeError('Ambiguous tool source')
    offset = text.index('"paths": [', text.index(marker)) + len('"paths": [')
    addition = ''.join('\n' + '\n'.join('                ' + line for line in repr(route).splitlines()) + ',' for route in ADDITIONS)
    changed = (text[:offset] + addition + text[offset:]).encode()
    after = catalog(changed.decode())
    expected = json.loads(json.dumps(before))
    next(t for t in expected if t['key'] == 'gemma')['paths'] = ADDITIONS + targets[0]['paths']
    if after != expected:
        raise RuntimeError('Unexpected change outside the two new routes')
    old_hash = hashlib.sha256(original).hexdigest()
    backup_dir = Path('/var/backups/pulso-clef-native')
    backup_dir.mkdir(mode=0o700, exist_ok=True)
    backup = backup_dir / (old_hash + '.py')
    if backup.exists():
        if backup.read_bytes() != original:
            raise RuntimeError('Backup mismatch')
    else:
        with backup.open('xb') as out:
            os.fchmod(out.fileno(), 0o600)
            out.write(original)
            out.flush()
            os.fsync(out.fileno())
    if TARGET.read_bytes() != original:
        raise RuntimeError('Concurrent Gateway change')
    replace_atomically(TARGET, changed, info)
    try:
        restart_and_check()
    except Exception:
        if TARGET.read_bytes() == changed:
            replace_atomically(TARGET, original, info)
            try:
                restart_and_check()
            except Exception:
                print(json.dumps({'operation': 'enable-clef-native-routes', 'rollback_source_restored': True, 'service_ready': False}), file=sys.stderr)
                raise
        raise RuntimeError('Restart failed; original source restored')
    print(json.dumps({'operation': 'enable-clef-native-routes', 'changed': True, 'service': SERVICE,
        'source_sha256_before': old_hash, 'source_sha256_after': hashlib.sha256(changed).hexdigest(),
        'backup': str(backup), 'added': [{'method': r['method'], 'path': r['path']} for r in ADDITIONS],
        'other_tools_unchanged': True, 'environment_changed': False, 'database_writes': 0}))

try:
    main()
except Exception as error:
    # Only fixed messages are useful here; no command output/env in diagnostics.
    print(json.dumps({'operation': 'enable-clef-native-routes', 'error_type': type(error).__name__}), file=sys.stderr)
    raise SystemExit(1)
