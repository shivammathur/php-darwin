#!/usr/bin/env python3
"""Linux packaging migration. Preserve all payload bytes and tar attributes."""
import argparse
import concurrent.futures
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
CONTROLLER = 'var/php-darwin/installer/install.sh'
TRANSFERS = json.loads((ROOT / 'conf/transfers.json').read_text())

def digest(file):
    with open(file, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def members(archive):
    process = subprocess.Popen(['zstd', '-qdc', str(archive)], stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|') as stream:
            for member in stream:
                if member.name.startswith('/') or any(p in ('', '.', '..') for p in member.name.rstrip('/').split('/')):
                    raise ValueError(f'Unsafe archive member: {member.name}')
                yield member, stream.extractfile(member) if member.isfile() else None
        # Tar stops at its end marker, before all block padding has necessarily
        # left zstd's pipe. Drain it so zstd can verify the complete frame rather
        # than receiving SIGPIPE when the reader closes early.
        while process.stdout.read(1024 * 1024):
            pass
    finally:
        process.stdout.close()
        status = process.wait()
    if status != 0:
        raise RuntimeError(f'Incomplete input archive (zstd exited {status})')

def record(member, content):
    return {**{name: getattr(member, name) for name in ['size', 'mode', 'uid', 'gid', 'uname', 'gname', 'mtime', 'linkname', 'pax_headers']},
            'type': member.type.hex(), 'sha256': hashlib.sha256(content).hexdigest() if content is not None else None}

def verify_payload(before, after, excluded):
    before = {key: value for key, value in before.items() if key not in excluded}
    after = {key: value for key, value in after.items() if key not in excluded}
    changed = sorted(key for key in before.keys() | after.keys() if before.get(key) != after.get(key))
    if changed:
        raise ValueError(f'Repack changed the runtime payload: {changed[:5]}')
    return len(before)

def repack(archive, expected, output, evidence):
    if digest(archive) != expected['sha256'] or archive.stat().st_size != expected['bytes']:
        raise ValueError('Input archive checksum/size mismatch')
    name = expected['name']
    metadata_member = 'var/php-darwin/' + name.replace('.tar.zst', '.json')
    before = {}
    with tempfile.TemporaryDirectory(prefix='php-repack-') as directory:
        directory = Path(directory)
        metadata = None
        original_metadata = None
        for member, stream in members(archive):
            if member.name in before:
                raise ValueError(f'Duplicate archive member: {member.name}')
            content = stream.read() if stream else None
            before[member.name] = record(member, content)
            if member.name == metadata_member:
                metadata = json.loads(content)
                original_metadata = member
            elif (member.isfile() and member.name.endswith('/INSTALL_RECEIPT.json')) or member.name.startswith('var/php-darwin/homebrew-php/'):
                receipt = directory / member.name
                receipt.parent.mkdir(parents=True, exist_ok=True)
                if member.isfile():
                    receipt.write_bytes(content)
                    receipt.chmod(member.mode)
                elif member.issym():
                    target = receipt.parent / member.linkname
                    if not target.resolve().is_relative_to(directory.resolve()): raise ValueError('Unsafe tap symlink')
                    receipt.symlink_to(member.linkname)
                elif member.islnk():
                    target = directory / member.linkname
                    if not target.resolve().is_relative_to(directory.resolve()): raise ValueError('Unsafe tap hardlink')
                    os.link(target, receipt)
                elif member.isdir():
                    receipt.mkdir(exist_ok=True)
                else: raise ValueError('Unsupported tap member')
        if not metadata or not original_metadata.isfile():
            raise ValueError('Missing archive metadata')
        for field in ('architecture', 'build', 'thread_safety', 'minimum_macos'):
            if metadata[field] != expected[field]:
                raise ValueError(f'Archive identity mismatch: {field}')
        if metadata['archive'] != name:
            raise ValueError('Archive name mismatch')
        metadata['installer'] = {'schema': 1, 'path': CONTROLLER}
        metadata_file = directory / 'metadata.json'
        metadata_file.write_text(json.dumps(metadata, indent=2) + '\n')
        # Use the same producer validation as normal PHP packaging.
        env = {**os.environ, 'META': str(metadata_file), 'VERSION': metadata['php_version'], 'BUILD': metadata['build'],
               'TS': metadata['thread_safety'], 'ARCH': metadata['architecture'], 'PREFIX': metadata['brew_prefix'],
               'MACOS': str(metadata['minimum_macos'])}
        subprocess.run(['bash', '-c', '. scripts/lib/lib.sh; php_darwin_validate_cache_metadata "$META" "$VERSION" "$BUILD" "$TS" "$ARCH" "$PREFIX" "$MACOS"'], cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
        package = json.loads((ROOT / 'conf/package.json').read_text())
        subprocess.run(['bash', str(ROOT / 'scripts/installer/validate-tap.sh'), str(directory / metadata['tap_snapshot']),
                        metadata['php_version'], metadata['source_hash'], package['tap_repository'],
                        metadata['homebrew_php_commit'], package['tap_branch']], check=True, stdout=subprocess.DEVNULL)
        controller = directory / 'install.sh' 
        subprocess.run(['node', str(ROOT / 'scripts/installer/generate-install.cjs'), str(controller), str(metadata_file), str(directory)], check=True)
        configuration = json.loads((ROOT / 'conf/build.json').read_text())
        output.mkdir(parents=True, exist_ok=True)
        destination = output / name
        compressor = subprocess.Popen(['zstd', '--ultra', '-' + str(configuration['compression_level']), '--long=' + str(configuration['compression_long']), '-T2', '-q', '-f', '-o', str(destination)], stdin=subprocess.PIPE)
        try:
            with tarfile.open(fileobj=compressor.stdin, mode='w|', format=tarfile.PAX_FORMAT) as target:
                info = copy.deepcopy(original_metadata)
                content = metadata_file.read_bytes()
                info.size = len(content)
                if 'size' in info.pax_headers: info.pax_headers['size'] = str(info.size)
                target.addfile(info, io.BytesIO(content))
                info = tarfile.TarInfo(CONTROLLER)
                content = controller.read_bytes()
                info.size, info.mode, info.mtime = len(content), 0o755, original_metadata.mtime
                target.addfile(info, io.BytesIO(content))
                for member, stream in members(archive):
                    if member.name in (metadata_member, CONTROLLER):
                        if stream: stream.read()
                        continue
                    # PAX_FORMAT introduces a new `path` field for long USTAR
                    # names. Keep members without PAX attributes in GNU format,
                    # which supports long names without adding PAX attributes.
                    target.format = tarfile.PAX_FORMAT if member.pax_headers else tarfile.GNU_FORMAT
                    target.addfile(member, stream)
        finally:
            compressor.stdin.close()
            if compressor.wait() != 0:
                raise RuntimeError('Compression failed')
        after = {}
        for member, stream in members(destination):
            if member.name in after: raise ValueError('Duplicate output member')
            after[member.name] = record(member, stream.read() if stream else None)
        payload_count = verify_payload(before, after, (metadata_member, CONTROLLER))
        if after[metadata_member]['sha256'] != digest(metadata_file) or after[CONTROLLER]['sha256'] != digest(controller):
            raise ValueError('Installer/metadata verification failed')
        if list(after)[:2] != [metadata_member, CONTROLLER] or after[CONTROLLER]['mode'] != 0o755:
            raise ValueError('Packaged installer must be executable and immediately follow metadata')
        if destination.stat().st_size > configuration['max_archive_bytes'][metadata['php_version']]:
            raise ValueError('Repacked archive exceeds the configured size limit')
        (output / name.replace('.tar.zst', '.json')).write_bytes(metadata_file.read_bytes())
        sha = digest(destination)
        (output / (name + '.sha256')).write_text(f'{sha}  {name}\n')
        evidence.mkdir(parents=True, exist_ok=True)
        proof = {'archive': name, 'input_sha256': expected['sha256'], 'sha256': sha, 'payload_members_unchanged': payload_count,
                 'installer_sha256': digest(controller), 'php_rebuilt': False, 'platform': os.uname().sysname}
        (evidence / (name + '.json')).write_text(json.dumps(proof, indent=2) + '\n')
        return proof

def fetch(urls, output, expected=None):
    failure = None
    for url in urls:
        for attempt in range(TRANSFERS['attempts']):
            try:
                with urllib.request.urlopen(url, timeout=TRANSFERS['archive']['timeout']) as response, open(output, 'wb') as stream:
                    while chunk := response.read(1024 * 1024): stream.write(chunk)
                if expected and digest(output) != expected: raise ValueError('Download checksum mismatch')
                return
            except Exception as error:
                failure = error
                if attempt + 1 < TRANSFERS['attempts']: time.sleep(TRANSFERS['retry_delay'] * 2 ** attempt)
    raise failure

def run(version, output):
    package = json.loads((ROOT / 'conf/package.json').read_text())
    build = json.loads((ROOT / 'conf/build.json').read_text())
    origins = [f'https://github.com/{package["release_repository"]}/releases/download/php-{version}', f'{package["artifact_mirror"]}/php-{version}']
    evidence = output.parent / 'evidence'
    evidence.mkdir(parents=True, exist_ok=True)
    manifest_file = evidence / f'php-{version}-manifest.json'
    fetch([f'{base}/php-{version}-manifest.json?repack={time.time_ns()}' for base in origins], manifest_file)
    manifest = json.loads(manifest_file.read_text())
    subprocess.run(['bash', '-c', '. scripts/lib/lib.sh; php_darwin_validate_release_manifest "$1" "$2"', 'repack', str(manifest_file), version], cwd=ROOT, check=True)
    def worker(entry):
        with tempfile.TemporaryDirectory(prefix='php-download-') as directory:
            archive = Path(directory) / entry['name']
            fetch([f'{base}/{entry["download"]}' for base in origins], archive, entry['sha256'])
            proof = repack(archive, entry, output / entry['architecture'], evidence)
            print(json.dumps(proof), flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=build.get('repack_concurrency', 2)) as pool:
        list(pool.map(worker, manifest['assets']))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('version')
    parser.add_argument('output', type=Path)
    arguments = parser.parse_args()
    if os.uname().sysname != 'Linux': raise RuntimeError('Published archives must be repackaged on Linux')
    run(arguments.version, arguments.output.resolve())
