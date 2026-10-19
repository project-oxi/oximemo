#!/usr/bin/env python3
"""Disposable loopback integration smoke test; no user vault or tailnet access."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / 'target/debug/oximemo'


def main():
    with tempfile.TemporaryDirectory(prefix='oximemo-mobile-') as temporary:
        directory = Path(temporary)
        vault = directory / 'vault'
        vault.mkdir()
        legacy = '# Legacy\n\nUntouched.\n'
        (vault / 'legacy.md').write_text(legacy)
        token = secrets.token_hex(32)
        token_file = directory / 'token'
        token_file.write_text(token)
        os.chmod(token_file, 0o600)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        with (directory / 'server.log').open('w') as log:
            environment = os.environ.copy()
            environment['OXI_HOME'] = str(directory / 'oxi')
            server = subprocess.Popen([str(BINARY), '--vault', str(vault), 'mobile-serve', '--bind', f'127.0.0.1:{port}', '--token-file', str(token_file)], stdout=log, stderr=log, env=environment)
            try:
                def request(route, payload=None, auth=True, origin=False):
                    headers = {'Content-Type': 'application/json'}
                    if auth:
                        headers['Authorization'] = f'Bearer {token}'
                    if origin:
                        headers['Origin'] = 'https://example.invalid'
                    data = json.dumps(payload).encode() if payload is not None else None
                    req = urllib.request.Request(f'http://127.0.0.1:{port}/v1/{route}', data=data, headers=headers)
                    try:
                        with urllib.request.urlopen(req, timeout=5) as response:
                            return response.status, json.load(response)
                    except urllib.error.HTTPError as error:
                        return error.code, json.load(error)
                for _ in range(100):
                    if server.poll() is not None:
                        raise RuntimeError((directory / 'server.log').read_text())
                    try:
                        status, manifest = request('manifest')
                        break
                    except urllib.error.URLError:
                        time.sleep(.05)
                else:
                    raise RuntimeError('server did not start')
                assert status == 200 and manifest['protocol'] == 'oximemo-sync/1'
                assert request('manifest', auth=False)[0] == 401
                assert request('manifest', origin=True)[0] == 401
                assert request('pairing/new', {'endpoint': 'https://pc.tail123.ts.net'}, auth=False)[0] == 401
                qr_file = directory / 'pairing.html'
                displayed = subprocess.run([str(BINARY), 'mobile-pair', '--url', 'https://pc.tail123.ts.net', '--server', f'127.0.0.1:{port}', '--token-file', str(token_file), '--qr-file', str(qr_file)], capture_output=True, text=True, check=True, env=environment)
                connection_code = next(line for line in displayed.stdout.splitlines() if line.startswith('OM1:'))
                assert '<svg ' in qr_file.read_text()
                assert token not in qr_file.read_text()
                assert qr_file.stat().st_mode & 0o077 == 0
                secret = connection_code.split('#', 1)[1].replace('-', '')
                claim = {'secret': secret, 'request_id': str(uuid.uuid4()), 'expected_vault_id': manifest['vault_id']}
                assert request('pair', claim, auth=False, origin=True)[0] == 401
                wrong = {**claim, 'secret': '0' * 32}
                assert request('pair', wrong, auth=False)[0] == 403
                assert request('pair', {**claim, 'expected_vault_id': 'wrong-vault'}, auth=False)[0] == 403
                status, paired = request('pair', claim, auth=False)
                assert status == 200 and paired['token'] == token and paired['vault_id'] == manifest['vault_id']
                assert request('pair', claim, auth=False) == (200, paired)
                assert request('pair', {**claim, 'request_id': str(uuid.uuid4())}, auth=False)[0] == 403
                assert request('pairing/new', {'endpoint': 'https://pc.tail123.ts.net'})[0] == 200
                assert request('pair', claim, auth=False)[0] == 403
                assert manifest['entries'][0]['class'] == 'legacy_markdown'
                assert request('source', {'path': '../outside.md'})[0] == 422
                operation = {'operation_id': str(uuid.uuid4()), 'vault_id': manifest['vault_id'], 'change': {'kind': 'create', 'title': 'Phone capture', 'body': '# Phone capture\n\n==Text==\n', 'body_profile': 'pdc-markdown/1'}}
                status, created = request('apply', operation)
                assert status == 200, created
                assert 'format: pdc-document/2' in created['content']
                assert request('apply', operation) == (200, created)
                assert len(list(vault.glob('*.md'))) == 2
                path = vault / created['path']
                preserved = path.read_text().replace('oximemo_editor: source', 'oximemo_editor: source\n# user comment\ncustom: {nested: [one, two]}')
                path.write_text(preserved)
                update = {'operation_id': str(uuid.uuid4()), 'vault_id': manifest['vault_id'], 'change': {'kind': 'update', 'document_id': created['document_id'], 'expected_sha256': created['sha256'], 'title': 'Changed', 'body': 'Phone change\n'}}
                assert request('apply', update)[0] == 409
                assert path.read_text() == preserved
                status, fresh = request('source', {'path': created['path']})
                assert status == 200
                update['operation_id'] = str(uuid.uuid4())
                update['change']['expected_sha256'] = fresh['sha256']
                status, changed = request('apply', update)
                assert status == 200, changed
                assert '# user comment\ncustom: {nested: [one, two]}' in changed['content']
                assert request('apply', update) == (200, changed)
                assert (vault / 'legacy.md').read_text() == legacy
                print('PASS: QR/code generation, private QR page, single-use pairing, retry, regeneration, auth, containment, canonical writes, conflict, legacy visibility')
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)


if __name__ == '__main__':
    main()
