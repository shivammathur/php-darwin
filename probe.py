from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib
import json
import subprocess
import tempfile
import time

OBJECTS = json.loads(Path('objects.json').read_text())
BASE = 'https://artifacts.php-darwin.setup-php.com/extensions'
GITHUB = 'https://github.com/shivammathur/php-darwin/releases/download/extensions'


def probe(item, label):
    with tempfile.TemporaryDirectory(prefix='extension-read-') as temporary:
        body = Path(temporary) / 'body'
        headers = Path(temporary) / 'headers'
        url = (GITHUB if label == 'github' else BASE) + '/' + item['name']
        if label.endswith('-query'):
            url += '?verify=' + str(time.time_ns())
        args = ['curl', '-q', '--silent', '--show-error', '--location',
                '--connect-timeout', '5', '--max-time', '45',
                '--proto', '=https', '--proto-redir', '=https',
                '--output', str(body), '--dump-header', str(headers), '--write-out', '%{json}']
        if label.startswith('http1-'):
            args.append('--http1.1')
        args.append(url)
        started = time.monotonic()
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        samples = []
        while process.poll() is None:
            samples.append({'seconds': round(time.monotonic() - started, 3),
                            'bytes': body.stat().st_size if body.exists() else 0})
            time.sleep(0.25)
        stdout, stderr = process.communicate()
        info = json.loads(stdout) if stdout.strip() else {}
        data = body.read_bytes() if body.exists() else b''
        sha = hashlib.sha256(data).hexdigest()
        selected = {}
        for line in headers.read_text().splitlines() if headers.exists() else []:
            if line.startswith('HTTP/'):
                selected = {}
            key, _, value = line.partition(':')
            if key.lower() in ('cf-ray', 'cf-cache-status', 'age', 'content-length', 'content-range'):
                selected[key.lower()] = value.strip()
        record = {'name': item['name'], 'case': label, 'exit': process.returncode,
                  'http': info.get('http_code'), 'bytes': len(data), 'sha256': sha,
                  'headers': selected, 'samples': samples, 'stderr': stderr.strip(),
                  'passed': process.returncode == 0 and info.get('http_code') == 200
                  and len(data) == item['bytes'] and sha == item['sha256']}
        record['metrics'] = {key: info.get(key) for key in ['time_namelookup', 'time_connect', 'time_appconnect',
                                                         'time_starttransfer', 'time_total', 'size_download',
                                                         'http_version', 'remote_ip', 'speed_download']}
        print(json.dumps({key: value for key, value in record.items() if key != 'samples'}), flush=True)
        return record


def compare(case):
    index, item = case
    modes = ['default-query', 'http1-query', 'http1-normal', 'default-normal']
    if index % 2:
        modes.reverse()
    return [probe(item, label) for label in modes + ['github']]


if __name__ == '__main__':
    assert len(OBJECTS) == 4
    with ThreadPoolExecutor(max_workers=2) as pool:
        records = [record for group in pool.map(compare, enumerate(OBJECTS)) for record in group]
    Path('report.json').write_text(json.dumps(records, indent=2) + '\n')
    raise SystemExit(0 if all(record['passed'] for record in records) else 1)
