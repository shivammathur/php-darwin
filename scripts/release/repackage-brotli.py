#!/usr/bin/env python3
"""Replace only Brotli in authenticated PHP archives, using Ubuntu workers."""
import argparse
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('repack', ROOT / 'scripts/release/repackage-installer.py')
repack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repack)
OLD, NEW = '1.2.0', '1.2.1'
OLD_ROOT, NEW_ROOT = f'Cellar/brotli/{OLD}', f'Cellar/brotli/{NEW}'
MAGIC = bytes.fromhex('cffaedfe')
ABI_CHECKS = set()


def run(*args):
    if args[0] == 'node':
        args = (os.environ.get('PHP_DARWIN_NODE', 'node'), *args[1:])
    return subprocess.check_output(list(map(str, args)), text=True).strip()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def renamed(value):
    value = value.replace(OLD_ROOT, NEW_ROOT)
    return re.sub(r'(libbrotli(?:common|dec|enc)\.)1\.2\.0(\.dylib)', rf'\g<1>{NEW}\2', value)


def symbols(file):
    args = ('nm', '-gU') if os.uname().sysname == 'Darwin' else ('llvm-nm', '-g', '--defined-only', '-j')
    return {line.split()[-1] for line in run(*args, file).splitlines() if line.split()}


def macho(content):
    """Read thin 64-bit Mach-O headers without executing target binaries."""
    if len(content) < 32 or content[:4] != MAGIC:
        raise ValueError('Expected a thin 64-bit Mach-O binary')
    cpu, = struct.unpack_from('<I', content, 4)
    count, total = struct.unpack_from('<II', content, 16)
    if 32 + total > len(content):
        raise ValueError('Truncated Mach-O load commands')
    position, libraries, minimum = 32, [], None
    for _ in range(count):
        command, size = struct.unpack_from('<II', content, position)
        if size < 8 or position + size > 32 + total:
            raise ValueError('Invalid Mach-O load command')
        if command in (0xc, 0xd, 0x80000018, 0x8000001f, 0x80000023):
            name, _, current, compatible = struct.unpack_from('<IIII', content, position + 8)
            if name < 24 or name >= size:
                raise ValueError('Invalid Mach-O library name')
            reference = content[position + name:position + size].split(b'\0', 1)[0].decode()
            libraries.append({'id': command == 0xd, 'path': reference, 'current': current, 'compatible': compatible})
        if command == 0x32:
            platform, minimum = struct.unpack_from('<II', content, position + 8)
            if platform != 1:
                raise ValueError('Replacement is not a macOS binary')
        elif command == 0x24:
            minimum, = struct.unpack_from('<I', content, position + 8)
        position += size
    if position != 32 + total:
        raise ValueError('Mach-O load-command size mismatch')
    return {'cpu': cpu, 'minimum': minimum, 'libraries': libraries}


def prepare_replacement(directory, architecture, temporary):
    provenance = json.loads((directory / 'provenance.json').read_text())
    if provenance['architecture'] != architecture or provenance['version'] != NEW or len(provenance['sources']) != 1:
        raise ValueError('Replacement identity mismatch')
    approved = json.loads((ROOT / 'conf/dependencies.json').read_text())['platforms'][architecture]['packages']['brotli']
    if approved != {'version': NEW, 'source': provenance['sources'][0]}:
        raise ValueError('Replacement is not the approved source bottle')
    keg = temporary / 'replacement'
    with tarfile.open(directory / f'brotli-{NEW}.tar.gz') as archive:
        archive.extractall(keg, filter='data')
    platform = json.loads((ROOT / 'conf/platforms.json').read_text())[architecture]
    for name in ('common', 'dec', 'enc'):
        library = keg / f'lib/libbrotli{name}.{NEW}.dylib'
        header = macho(library.read_bytes())
        if header['cpu'] != {'arm64': 0x100000c, 'x86_64': 0x1000007}[architecture]:
            raise ValueError('Wrong replacement library architecture')
        if not header['minimum'] or header['minimum'] > platform['minimum_macos'] << 16:
            raise ValueError('Replacement raises the minimum macOS version')
        identity, = [entry for entry in header['libraries'] if entry['id']]
        if identity != {'id': True, 'path': f'{platform["brew_prefix"]}/opt/brotli/lib/libbrotli{name}.1.dylib',
                        'current': 0x10201, 'compatible': 0x10000}:
            raise ValueError('Wrong Brotli install name, ABI or version')
    return keg, provenance


def transform(archive, expected, keg, provenance, output, evidence):
    if repack.digest(archive) != expected['sha256'] or archive.stat().st_size != expected['bytes']:
        raise ValueError('Input archive checksum/size mismatch')
    name = expected['name']
    metadata_name = 'var/php-darwin/' + name.replace('.tar.zst', '.json')
    before, changes, metadata = {}, {}, None
    with tempfile.TemporaryDirectory(prefix='brotli-repack-') as temporary:
        tmp = Path(temporary)
        for member, stream in repack.members(archive):
            content = stream.read() if stream else None
            if member.name in before:
                raise ValueError('Duplicate input member')
            before[member.name] = repack.record(member, content)
            if member.name == metadata_name:
                metadata = json.loads(content)
            if member.isfile() and member.name.endswith('/INSTALL_RECEIPT.json'):
                target = tmp / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            if member.name == OLD_ROOT or member.name.startswith(OLD_ROOT + '/'):
                if content and content[:4] == MAGIC and member.name.endswith('.dylib'):
                    previous = tmp / 'previous' / Path(member.name).name
                    previous.parent.mkdir(exist_ok=True)
                    previous.write_bytes(content)
                    replacement = keg / 'lib' / renamed(previous.name)
                    key = repack.digest(previous), repack.digest(replacement)
                    if key not in ABI_CHECKS:
                        missing = symbols(previous) - symbols(replacement)
                        if missing:
                            raise ValueError(f'Brotli removes exported symbols: {sorted(missing)}')
                        ABI_CHECKS.add(key)
                changes[member.name] = None
                continue
            if member.issym() or member.islnk():
                if renamed(member.name) != member.name or renamed(member.linkname) != member.linkname:
                    updated = copy.deepcopy(member)
                    updated.name, updated.linkname = renamed(member.name), renamed(member.linkname)
                    updated.pax_headers = {k: renamed(v) if k in ('path', 'linkpath') else v for k, v in updated.pax_headers.items()}
                    changes[member.name] = updated, None
            if content and content[:4] == MAGIC and (b'brotli' in content or b'BrotliDecoder' in content):
                if any(renamed(entry['path']) != entry['path'] for entry in macho(content)['libraries']):
                    raise ValueError(f'Consumer needs rebuilding; refusing to modify its load commands: {member.name}')
                binary = tmp / 'consumer'
                binary.write_bytes(content)
                if any(re.match(r'^_BrotliDecoder(?:Decompress|CreateInstance|DecompressStream)$', symbol) for symbol in symbols(binary)):
                    raise ValueError(f'Statically linked decoder needs rebuilding: {member.name}')
        if metadata is None or metadata['archive'] != name:
            raise ValueError('Missing or mismatched archive metadata')
        for field in ('architecture', 'build', 'thread_safety', 'minimum_macos'):
            if metadata[field] != expected[field]:
                raise ValueError(f'Archive identity mismatch: {field}')
        package, = [p for p in metadata['packages'] if p['name'] == 'brotli']
        if package['opt_target'] != '../' + OLD_ROOT:
            raise ValueError('Unexpected original Brotli version')
        package['opt_target'] = '../' + NEW_ROOT
        for link in metadata['links']:
            link['path'], link['target'] = renamed(link['path']), renamed(link['target'])
        records = metadata['build_inputs']['source_records']
        index, = [i for i, record in enumerate(records) if record.get('formula') == 'brotli']
        records[index] = provenance['source_record']
        replacement = tmp / NEW_ROOT
        shutil.copytree(keg, replacement, symlinks=True)
        metadata_file = tmp / metadata_name
        write_json(metadata_file, metadata)
        run('node', ROOT / 'scripts/installer/generate-install.cjs', tmp / repack.CONTROLLER, metadata_file, tmp)
        for member, _ in repack.members(archive):
            if member.name in (metadata_name, repack.CONTROLLER):
                changes[member.name] = copy.deepcopy(member), (tmp / member.name).read_bytes()
        additions = []
        for file in sorted(replacement.rglob('*')):
            if file.is_dir() and not file.is_symlink():
                continue
            if any(part in ('doc', 'info', 'man', 'gnuman') for part in file.relative_to(replacement).parts):
                continue
            with tarfile.open(fileobj=io.BytesIO(), mode='w') as helper:
                member = helper.gettarinfo(str(file), str(file.relative_to(tmp)))
            member.mtime, member.mode = int(member.mtime), member.mode & 0o7777
            additions.append((member, file.read_bytes() if member.isfile() else None))
        output.mkdir(parents=True, exist_ok=True)
        destination = output / name
        compressor = subprocess.Popen(['zstd', '--ultra', '-19', '--long=27', '-T2', '-q', '-f', '-o', str(destination)], stdin=subprocess.PIPE)
        try:
            with tarfile.open(fileobj=compressor.stdin, mode='w|', format=tarfile.PAX_FORMAT) as target:
                def add(member, content):
                    if content is not None:
                        member.size = len(content)
                        if 'size' in member.pax_headers:
                            member.pax_headers['size'] = str(member.size)
                    target.format = tarfile.PAX_FORMAT if member.pax_headers else tarfile.GNU_FORMAT
                    target.addfile(member, io.BytesIO(content) if content is not None else None)
                for member, stream in repack.members(archive):
                    if member.name in changes:
                        if changes[member.name] is not None:
                            add(*changes[member.name])
                    else:
                        target.format = tarfile.PAX_FORMAT if member.pax_headers else tarfile.GNU_FORMAT
                        target.addfile(member, stream)
                for item in additions:
                    add(*item)
        finally:
            compressor.stdin.close()
            if compressor.wait() != 0:
                raise ValueError('Compression failed')
        after = {}
        for member, stream in repack.members(destination):
            if member.name in after:
                raise ValueError('Duplicate output member')
            after[member.name] = repack.record(member, stream.read() if stream else None)
        excluded = set(changes) | {renamed(n) for n in changes} | {m.name for m, _ in additions}
        unchanged = repack.verify_payload(before, after, excluded)
        if any(n == OLD_ROOT or n.startswith(OLD_ROOT + '/') for n in after):
            raise ValueError('Old Brotli keg survived')
        for member, content in additions + [change for change in changes.values() if change]:
            if after[member.name] != repack.record(member, content):
                raise ValueError(f'Changed member verification failed: {member.name}')
        if destination.stat().st_size > json.loads((ROOT / 'conf/build.json').read_text())['max_archive_bytes'][metadata['php_version']]:
            raise ValueError('Repacked archive exceeds its size limit')
        sha = repack.digest(destination)
        write_json(output / name.replace('.tar.zst', '.json'), metadata)
        (output / (name + '.sha256')).write_text(f'{sha}  {name}\n')
        proof = {'archive': name, 'input_sha256': expected['sha256'], 'sha256': sha,
                 'old_brotli': OLD, 'new_brotli': NEW, 'unchanged_members': unchanged,
                 'php_rebuilt': False, 'consumer_binaries_unchanged': True,
                 'replacement_source': provenance['sources'][0], 'changed_members': sorted(excluded)}
        write_json(evidence / (name + '.json'), proof)
        print(json.dumps({k: v for k, v in proof.items() if k not in ('replacement_source', 'changed_members')}), flush=True)


def main(version, architecture, replacement, output):
    if os.uname().sysname != 'Linux':
        raise ValueError('Published PHP archives must be repackaged on Ubuntu')
    for tool in ('llvm-nm', 'zstd', 'jq', 'git', 'tar'):
        if not shutil.which(tool):
            raise ValueError(f'Missing packaging tool: {tool}')
    evidence = output / 'evidence'
    evidence.mkdir(parents=True, exist_ok=True)
    package = json.loads((ROOT / 'conf/package.json').read_text())
    with tempfile.TemporaryDirectory(prefix='brotli-update-') as temporary:
        tmp = Path(temporary)
        keg, provenance = prepare_replacement(replacement, architecture, tmp)
        origins = [f'https://github.com/{package["release_repository"]}/releases/download/php-{version}', f'{package["artifact_mirror"]}/php-{version}']
        manifest_name = f'php-{version}-manifest.json'
        manifest_file = evidence / manifest_name
        repack.fetch([base + '/' + manifest_name for base in origins], manifest_file)
        manifest = json.loads(manifest_file.read_text())
        for entry in manifest['assets']:
            if entry['architecture'] != architecture:
                continue
            archive = tmp / entry['download']
            repack.fetch([base + '/' + entry['download'] for base in origins], archive, entry['sha256'])
            transform(archive, entry, keg, provenance, output / architecture, evidence)
            archive.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('version')
    parser.add_argument('architecture', choices=('arm64', 'x86_64'))
    parser.add_argument('replacement', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    main(args.version, args.architecture, args.replacement.resolve(), args.output.resolve())
