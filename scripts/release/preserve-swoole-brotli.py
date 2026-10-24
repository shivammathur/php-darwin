#!/usr/bin/env python3
"""Package rebuilt Swoole/Brotli while preserving the published archive layout."""
import argparse
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import posixpath
import subprocess
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('repack', ROOT / 'scripts/release/repackage-installer.py')
repack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repack)
spec = importlib.util.spec_from_file_location('brotli', ROOT / 'scripts/release/repackage-brotli.py')
brotli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(brotli)
RECIPES = json.loads((Path(__file__).with_name('brotli-swoole-recipes.json')).read_text())
ORIGINS = ['https://github.com/shivammathur/php-darwin/releases/download/extensions',
           'https://artifacts.php-darwin.setup-php.com/extensions']
BROTLI = 'kegs/brotli/1.2.1'


def identity(entry):
    return tuple(entry[k] for k in ('name', 'php_version', 'architecture', 'build', 'thread_safety'))


def renamed(value):
    return value.replace('kegs/brotli/1.2.0', BROTLI).replace('.1.2.0.dylib', '.1.2.1.dylib')


def replaced(name):
    return name.startswith(BROTLI + '/') or name in (
        'metadata.json', 'modules/swoole.so', 'kegs/curl/8.22.0_1/lib/libcurl.4.dylib',
        'kegs/curl/8.22.0_1/bin/curl')


def verify_entry(current, previous):
    if identity(current) != identity(previous) or current['name'] != 'swoole':
        raise ValueError('Swoole identity changed')
    normalized = copy.deepcopy(current)
    dependency = next(d for d in normalized['dependencies'] if d['name'] == 'brotli')
    if dependency['versions'] != ['1.2.1']: raise ValueError('Expected Brotli 1.2.1')
    dependency['versions'] = ['1.2.0']
    for i, record in enumerate(normalized['source_records']):
        if record.get('formula') == 'brotli':
            approved = json.loads((ROOT / 'conf/dependencies.json').read_text())['platforms'][current['architecture']]['packages']['brotli']['source']['inputs']['recipe']
            if record.get('inputs_sha256') != approved: raise ValueError('Unapproved Brotli source')
        elif record['path'] == f"Formula/swoole@{current['php_version']}.rb":
            approved = RECIPES[record['path']]
            if record != approved and not (record.get('inputs_sha256') == approved.get('inputs_sha256') and
                    {k: v for k, v in record.items() if k != 'sha256'} == {k: v for k, v in approved.items() if k != 'sha256'}):
                raise ValueError('Unapproved Swoole source')
        else:
            continue
        normalized['source_records'][i] = next(r for r in previous['source_records'] if
            r['repository'] == record['repository'] and r['path'] == record['path'])
    # Rebuilding against the currently published PHP patch release does not change its ABI.
    for field in ('inputs_sha256', 'sha256', 'bytes', 'file', 'php_semver'):
        normalized[field] = previous[field]
    if normalized != previous: raise ValueError('Unrelated dependency or compatibility metadata changed')


def read_archive(file, expected):
    if repack.digest(file) != expected['sha256'] or file.stat().st_size != expected['bytes']:
        raise ValueError('Archive checksum/size mismatch')
    items = {}
    for member, stream in repack.members(file):
        if member.name in items: raise ValueError('Duplicate archive member')
        items[member.name] = (member, stream.read() if stream else None)
    metadata = json.loads(items['metadata.json'][1])
    if metadata != {k: v for k, v in expected.items() if k not in ('file', 'bytes', 'sha256')}:
        raise ValueError('Embedded extension metadata mismatch')
    return items


def preserve(original, previous, rebuilt, entry, output, evidence):
    verify_entry(entry, previous)
    before = read_archive(original, previous)
    source = read_archive(rebuilt, entry)
    transformed = {}
    for name, (member, data) in before.items():
        new_name = renamed(name)
        info = copy.deepcopy(member)
        info.name, info.linkname = new_name, renamed(info.linkname)
        info.pax_headers = {key: renamed(value) if key in ('path', 'linkpath') else value
                            for key, value in info.pax_headers.items()}
        if replaced(new_name) and info.isfile():
            if new_name not in source or not source[new_name][0].isfile():
                raise ValueError(f'Missing rebuilt payload: {new_name}')
            data = source[new_name][1]
            info.size = len(data)
            if 'size' in info.pax_headers: info.pax_headers['size'] = str(info.size)
        elif new_name in source and info.type != source[new_name][0].type:
            raise ValueError(f'Rebuilt file type changed: {new_name}')
        transformed[new_name] = (info, data)
    for name, (member, data) in source.items():
        if data and data[:4] == brotli.MAGIC:
            if name not in transformed or transformed[name][1] != data:
                raise ValueError(f'Unrelated rebuilt executable changed: {name}')
    cpu = {'arm64': 0x100000c, 'x86_64': 0x1000007}[entry['architecture']]
    dylibs = 0
    for name, (member, data) in transformed.items():
        if not data or data[:4] != brotli.MAGIC: continue
        parsed = brotli.macho(data)
        if parsed['cpu'] != cpu or parsed['minimum'] is None or parsed['minimum'] > entry['minimum_macos'] << 16:
            raise ValueError(f'Architecture or minimum macOS changed: {name}')
        for library in parsed['libraries']:
            if 'brotli/1.2.0' in library['path'] or '.1.2.0.dylib' in library['path']:
                raise ValueError('Stale Brotli library reference')
            reference = library['path']
            if reference.startswith('@loader_path/'):
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), reference[13:]))
                if target not in transformed: raise ValueError(f'Missing private library: {name}: {reference}')
            elif not reference.startswith(('/usr/lib/', '/System/Library/')):
                raise ValueError(f'External runtime library: {name}: {reference}')
            if name.startswith(BROTLI + '/') and library['id']:
                if library['current'] != 0x10201 or library['compatible'] != 0x10000:
                    raise ValueError('Brotli dylib version mismatch')
                dylibs += 1
    if dylibs != 3: raise ValueError('Expected three Brotli libraries')
    key = '-'.join(str(entry[k]) for k in ('name', 'php_version', 'build', 'thread_safety', 'architecture'))
    directory = output / f'extension-{key}'
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f'{key}.tar.zst'
    config = json.loads((ROOT / 'conf/build.json').read_text())
    compressor = subprocess.Popen(['zstd', '--ultra', '-' + str(config['compression_level']), '-T2', '-q', '-f', '-o', str(destination)], stdin=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=compressor.stdin, mode='w|') as target:
            for info, data in transformed.values():
                target.format = tarfile.PAX_FORMAT if info.pax_headers else tarfile.GNU_FORMAT
                target.addfile(info, io.BytesIO(data) if data is not None else None)
    finally:
        compressor.stdin.close()
        if compressor.wait() != 0: raise RuntimeError('Compression failed')
    after = {}
    for member, stream in repack.members(destination):
        if member.name in after: raise ValueError('Duplicate output member')
        after[member.name] = repack.record(member, stream.read() if stream else None)
    expected = {name: repack.record(info, data) for name, (info, data) in transformed.items()}
    repack.verify_payload(expected, after, ())
    original_records = {renamed(name): repack.record(info, data) for name, (info, data) in before.items()}
    unchanged = repack.verify_payload(original_records, after,
        {name for name in after if replaced(name) or name == BROTLI})
    if {(renamed(n), i.type) for n, (i, _) in before.items()} != {(n, bytes.fromhex(v['type'])) for n, v in after.items()}:
        raise ValueError('Archive layout changed')
    sha = repack.digest(destination)
    filename = f'{key}-{sha}.tar.zst'
    result = {**entry, 'file': filename, 'sha256': sha, 'bytes': destination.stat().st_size}
    destination.rename(directory / filename)
    (directory / f'{key}.json').write_text(json.dumps(result, indent=2) + '\n')
    # Native validation must create a fresh validation.txt for this new archive.
    proof = {'key': key, 'original_sha256': previous['sha256'], 'rebuilt_sha256': entry['sha256'],
             'sha256': sha, 'members': len(after), 'unchanged_members': unchanged,
             'layout_preserved': True, 'rebuilt_executable_bytes_preserved': True,
             'platform': os.uname().sysname}
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / f'{key}.json').write_text(json.dumps(proof, indent=2) + '\n')
    print(json.dumps(proof), flush=True)
    return result


def run(version, architecture, source, output, evidence):
    evidence.mkdir(parents=True, exist_ok=True)
    manifest_file = evidence / f'extensions-{version}-manifest.json'
    repack.fetch([f'{base}/{manifest_file.name}' for base in ORIGINS], manifest_file)
    previous = json.loads(manifest_file.read_text())['assets']
    entries = []
    for file in source.rglob('*.json'):
        entry = json.loads(file.read_text())
        if not isinstance(entry, dict) or entry.get('name') != 'swoole': continue
        if entry['php_version'] != version or entry['architecture'] != architecture:
            raise ValueError('Unexpected source variant')
        entries.append((file, entry))
    if {(e['build'], e['thread_safety']) for _, e in entries} != {(b, t) for b in ('debug', 'release') for t in ('nts', 'zts')} or len(entries) != 4:
        raise ValueError('Expected exactly four source variants')
    result = []
    for file, entry in entries:
        old = next(e for e in previous if identity(e) == identity(entry))
        with tempfile.TemporaryDirectory(prefix='swoole-original-') as directory:
            original = Path(directory) / old['file']
            repack.fetch([f"{base}/{old['file']}" for base in ORIGINS], original, old['sha256'])
            result.append(preserve(original, old, file.parent / entry['file'], entry, output, evidence))
    (evidence / 'entries.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('version')
    parser.add_argument('architecture', choices=('arm64', 'x86_64'))
    for name in ('source', 'output', 'evidence'): parser.add_argument(name, type=Path)
    args = parser.parse_args()
    if os.uname().sysname != 'Linux': raise RuntimeError('Published archives must be repackaged on Ubuntu')
    run(args.version, args.architecture, args.source, args.output, args.evidence)
