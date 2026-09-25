import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

record = json.loads(Path('record.json').read_text())
expected = record['sha256']
key = f'homebrew/source-bottles/sha256/{expected}.tar'
public = f'https://artifacts.php-darwin.setup-php.com/{key}'
control_sha = 'd2c46fcf9f66ea205290cc0ae1d6b23b7fd810b412e9a0b715d1f7210b9e1c4a'
allowed_headers = {'content-length', 'content-type', 'content-range', 'cf-ray',
                   'cf-cache-status', 'age', 'etag', 'server', 'date',
                   'cache-control', 'last-modified', 'x-amz-request-id',
                   'x-amz-id-2'}


def probe(case):
    label, url, sha = case
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='mirror-read-') as temp:
        body = Path(temp) / 'body'
        headers = Path(temp) / 'headers'
        if label == 'r2':
            args = ['aws', '--endpoint-url', os.environ['CF_R2_ENDPOINT'], 's3', 'cp',
                    f's3://php-darwin/{key}', str(body), '--only-show-errors',
                    '--cli-connect-timeout', '5', '--cli-read-timeout', '130']
        else:
            args = ['curl', '-q', '--silent', '--show-error', '--location',
                    '--proto', '=https', '--proto-redir', '=https',
                    '--connect-timeout', '5', '--max-time', '135',
                    '--dump-header', str(headers), '--output', str(body),
                    '--write-out', '%{json}', url]
        result = subprocess.run(args, capture_output=True, timeout=150)
        data = body.read_bytes() if body.exists() else b''
        report = {'probe': label, 'exit_code': result.returncode,
                  'elapsed_seconds': time.monotonic() - started,
                  'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                  'expected_sha256': sha, 'sha_matches': hashlib.sha256(data).hexdigest() == sha}
        if label != 'r2':
            metrics = json.loads(result.stdout or b'{}')
            # Curl's full JSON contains URLs. Retain only diagnostic fields.
            report['curl'] = {k: metrics.get(k) for k in ['http_code', 'http_version',
                             'remote_ip', 'time_namelookup', 'time_connect',
                             'time_appconnect', 'time_starttransfer', 'time_total',
                             'size_download', 'num_redirects']}
            report['headers'] = [line for line in headers.read_text().splitlines()
                                 if line.startswith('HTTP/') or
                                 line.partition(':')[0].lower() in allowed_headers] if headers.exists() else []
        return report


cases = [('public', public, expected),
         ('public_fresh_query', f'{public}?diagnostic={uuid.uuid4()}', expected),
         ('public_control', f'https://artifacts.php-darwin.setup-php.com/homebrew/source-bottles/sha256/{control_sha}.tar', control_sha),
         ('github', record['url'], expected),
         ('r2', None, expected)]
reports = []
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
    futures = {pool.submit(probe, case): case[0] for case in cases}
    for future in concurrent.futures.as_completed(futures):
        try:
            report = future.result()
        except Exception as error:
            # Never print command arguments or the private R2 endpoint.
            report = {'probe': futures[future], 'error_type': type(error).__name__}
        reports.append(report)
        Path('report.json').write_text(json.dumps(reports, indent=2) + '\n')
        print(json.dumps(report), flush=True)

# This is an observation job: preserve every result rather than stopping at
# the first failed public request. No objects or settings are modified.
