#!/usr/bin/env python3
"""Replace Brotli in authenticated published archives without compiling consumers."""
import argparse
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('repack', ROOT / 'scripts/release/repackage-installer.py')
repack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repack)
OLD, NEW = '1.2.0', '1.2.1'
MAGIC = {bytes.fromhex(value) for value in ('cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca')}
ABI_CHECKS = set()


def run(*args):
    return subprocess.check_output(list(map(str, args)), text=True).strip()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def renamed(value):
    value = value.replace(f'brotli/{OLD}', f'brotli/{NEW}')
    return re.sub(r'(libbrotli(?:common|dec|enc)\.)1\.2\.0(\.dylib)', rf'\g<1>{NEW}\2', value)


def update_record(records, replacement):
    matches = [i for i, item in enumerate(records) if item.get('formula') == 'brotli']
    if len(matches) != 1:
        raise ValueError('Expected exactly one Brotli recipe record')
    records[matches[0]] = replacement


def native_patch(file, private=False):
    """Change Mach-O load commands, then repair and verify the ad-hoc signature."""
    refs = [line.strip().split(' (compatibility version')[0]
            for line in run('otool', '-L', file).splitlines()[1:]]
    args = []
    for ref in refs:
        target = renamed(ref)
        if private and 'libbrotli' in ref:
            target = '@loader_path/' + os.path.relpath(private / 'lib' / Path(target).name, file.parent)
        if target != ref:
            args += ['-change', ref, target]
    if private and file.name.endswith('.dylib'):
        args += ['-id', '@loader_path/' + file.name]
    if args:
        run('install_name_tool', *args, file)
        run('codesign', '--force', '--sign', '-', file)
        run('codesign', '--verify', '--strict', file)
    return bool(args)


def verify_exports(previous, replacement):
    key = repack.digest(previous), repack.digest(replacement)
    if key in ABI_CHECKS:
        return
    def symbols(file):
        return {line.split()[-1] for line in run('nm', '-gU', file).splitlines() if line.split()}
    missing = symbols(previous) - symbols(replacement)
    if missing:
        raise ValueError(f'Brotli replacement removes exported symbols: {sorted(missing)}')
    ABI_CHECKS.add(key)


def extract_replacement(archive, root):
    """Bound all paths and reject traversal through links on macOS's Python 3.9."""
    def relative(name):
        while name.startswith('./'):
            name = name[2:]
        if name in ('', '.'):
            return Path('.')
        path = Path(name)
        if path.is_absolute() or '..' in path.parts:
            raise ValueError('Unsafe replacement member')
        return path
    members = archive.getmembers()
    paths = {relative(m.name): m for m in members}
    if len(paths) != len(members):
        raise ValueError('Duplicate replacement member')
    for name, member in paths.items():
        if any(parent in paths and not paths[parent].isdir() for parent in name.parents):
            raise ValueError('Replacement member traverses a link')
        if member.issym():
            destination = (root / name.parent / member.linkname).resolve()
            if not destination.is_relative_to(root.resolve()):
                raise ValueError('Replacement symlink escapes its root')
        elif member.islnk():
            target = relative(member.linkname)
            if target not in paths or not paths[target].isfile():
                raise ValueError('Invalid replacement hardlink')
        elif not member.isfile() and not member.isdir():
            raise ValueError('Unsupported replacement member')
    # Every destination and link was checked before extracting anything.
    archive.extractall(root)


def prepare_replacement(directory, architecture, temporary):
    provenance = json.loads((directory / 'provenance.json').read_text())
    if provenance['architecture'] != architecture or provenance['version'] != NEW or len(provenance['sources']) != 1:
        raise ValueError('Replacement identity mismatch')
    keg = temporary / 'replacement'
    keg.mkdir()
    with tarfile.open(directory / f'brotli-{NEW}.tar.gz') as archive:
        extract_replacement(archive, keg)
    version = subprocess.check_output([str(keg / 'bin/brotli'), '--version'], text=True,
                                     env={**os.environ, 'DYLD_LIBRARY_PATH': str(keg / 'lib')}).strip()
    if version != 'brotli ' + NEW:
        raise ValueError('Replacement executable version mismatch')
    for name in ('common', 'dec', 'enc'):
        library = keg / f'lib/libbrotli{name}.{NEW}.dylib'
        if architecture not in run('lipo', '-archs', library):
            raise ValueError('Wrong replacement library architecture')
        if 'compatibility version 1.0.0, current version 1.2.1' not in run('otool', '-L', library):
            raise ValueError('Wrong Brotli ABI/version')
    return keg, provenance


def transform(archive, expected, keg, provenance, output, evidence, private=False):
    if repack.digest(archive) != expected['sha256'] or archive.stat().st_size != expected['bytes']:
        raise ValueError('Input archive checksum/size mismatch')
    name = expected['file'] if private else expected['name']
    metadata_name = 'metadata.json' if private else 'var/php-darwin/' + name.replace('.tar.zst', '.json')
    old_root = ('kegs' if private else 'Cellar') + f'/brotli/{OLD}'
    new_root = renamed(old_root)
    before, changes, changed_binaries = {}, {}, []
    with tempfile.TemporaryDirectory(prefix='brotli-repack-') as tmp:
        tmp = Path(tmp)
        # Only materialize metadata, receipts, tap records and affected Mach-O files.
        for member, stream in repack.members(archive):
            content = stream.read() if stream else None
            if member.name in before:
                raise ValueError('Duplicate input member')
            before[member.name] = repack.record(member, content)
            if member.name == metadata_name:
                metadata = json.loads(content)
            if not private and member.isfile() and (member.name.endswith('/INSTALL_RECEIPT.json') or
                                                      member.name.startswith('var/php-darwin/homebrew-php/')):
                target = tmp / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                target.chmod(member.mode)
            if member.name == old_root or member.name.startswith(old_root + '/'):
                if content and content[:4] in MAGIC and member.name.endswith('.dylib'):
                    previous = tmp / 'previous' / Path(member.name).name
                    previous.parent.mkdir(exist_ok=True)
                    previous.write_bytes(content)
                    verify_exports(previous, keg / 'lib' / renamed(previous.name))
                changes[member.name] = None
                continue
            if member.issym() or member.islnk():
                if renamed(member.name) != member.name or renamed(member.linkname) != member.linkname:
                    updated = copy.deepcopy(member)
                    updated.name, updated.linkname = renamed(member.name), renamed(member.linkname)
                    updated.pax_headers = {k: renamed(v) if k in ('path', 'linkpath') else v for k, v in updated.pax_headers.items()}
                    changes[member.name] = updated, None
            if content and content[:4] in MAGIC and b'BrotliDecoder' in content:
                target = tmp / 'native' / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                target.chmod(member.mode | 0o200)
                # Refuse to claim a dynamic replacement fixes an embedded decoder.
                symbols = run('nm', '-gU', target)
                if re.search(r'\b_BrotliDecoder(?:Decompress|CreateInstance|DecompressStream)$', symbols, re.M):
                    raise ValueError(f'Statically linked Brotli decoder needs rebuilding: {member.name}')
                if native_patch(target):
                    changes[member.name] = copy.deepcopy(member), target.read_bytes()
                    changed_binaries.append(member.name)
            elif content and content[:4] in MAGIC and f'brotli/{OLD}'.encode() in content:
                target = tmp / 'native' / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                target.chmod(member.mode | 0o200)
                if native_patch(target):
                    changes[member.name] = copy.deepcopy(member), target.read_bytes()
                    changed_binaries.append(member.name)
        for field in ('architecture', 'build', 'thread_safety', 'minimum_macos'):
            if metadata[field] != expected[field]:
                raise ValueError(f'Archive identity mismatch: {field}')
        if private:
            if metadata != {k: v for k, v in expected.items() if k not in ('file', 'sha256', 'bytes')}:
                raise ValueError('Extension archive metadata differs from manifest')
            dependency, = [p for p in metadata['dependencies'] if p['name'] == 'brotli']
            if dependency['versions'] != [OLD]:
                raise ValueError('Unexpected original Brotli version')
            dependency['versions'] = [NEW]
            update_record(metadata['source_records'], provenance['source_record'])
            metadata['inputs_sha256'] = hashlib.sha256(json.dumps({k: v for k, v in metadata.items()
                if k not in ('inputs_sha256', 'relocations')}, separators=(',', ':')).encode()).hexdigest()
        else:
            if metadata['archive'] != name:
                raise ValueError('PHP archive name mismatch')
            package, = [p for p in metadata['packages'] if p['name'] == 'brotli']
            if package['opt_target'] != '../' + old_root:
                raise ValueError('Unexpected original Brotli version')
            package['opt_target'] = '../' + new_root
            for link in metadata['links']:
                link['path'], link['target'] = renamed(link['path']), renamed(link['target'])
            update_record(metadata['build_inputs']['source_records'], provenance['source_record'])
        replacement = tmp / new_root
        shutil.copytree(keg, replacement, symlinks=True)
        if private:
            # Use the same runtime filter as ordinary extension packaging.
            shutil.rmtree(replacement)
            run('node', '-e', "require('./scripts/build/extension-pack.cjs').copyRuntime(process.argv[1], process.argv[2])",
                keg, replacement)
            for file in replacement.rglob('*'):
                if file.is_file() and not file.is_symlink() and file.read_bytes()[:4] in MAGIC:
                    native_patch(file, private=replacement)
        metadata_file = tmp / metadata_name
        write_json(metadata_file, metadata)
        if not private:
            controller = tmp / repack.CONTROLLER
            run('node', ROOT / 'scripts/installer/generate-install.cjs', controller, metadata_file, tmp)
            changes[repack.CONTROLLER] = None  # Replaced below using the original attributes.
        for member, stream in repack.members(archive):
            if member.name == metadata_name or (not private and member.name == repack.CONTROLLER):
                changes[member.name] = copy.deepcopy(member), (tmp / member.name).read_bytes()
        additions = []
        for file in sorted(replacement.rglob('*')):
            if file.is_dir() and not file.is_symlink():
                continue
            if any(part in ('doc', 'info', 'man', 'gnuman') for part in file.relative_to(replacement).parts):
                continue
            with tarfile.open(fileobj=io.BytesIO(), mode='w') as helper:
                member = helper.gettarinfo(str(file), str(file.relative_to(tmp)))
            member.mtime = int(member.mtime)
            member.mode &= 0o7777
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
        if any(n == old_root or n.startswith(old_root + '/') for n in after):
            raise ValueError('Old Brotli keg survived')
        if not any(n.startswith(new_root + '/') for n in after):
            raise ValueError('New Brotli keg missing')
        for member, content in additions:
            if after[member.name] != repack.record(member, content):
                raise ValueError(f'Replacement changed: {member.name}: {after[member.name]} != {repack.record(member, content)}')
        for original, change in changes.items():
            if change and after[change[0].name] != repack.record(*change):
                raise ValueError(f'Changed member verification failed: {original}')
        if any('/bin/php' in n or '/sbin/php-fpm' in n for n in changed_binaries):
            raise ValueError('PHP unexpectedly needs relinking')
        sha = repack.digest(destination)
        limits = json.loads((ROOT / 'conf/build.json').read_text())
        limit = limits['extension_max_archive_bytes'] if private else limits['max_archive_bytes'][metadata['php_version']]
        if destination.stat().st_size > limit:
            raise ValueError('Repacked archive exceeds its size limit')
        if private:
            identity = '-'.join(str(expected[k]) for k in ('name', 'php_version', 'build', 'thread_safety', 'architecture'))
            file = f'{identity}-{sha}.tar.zst'
            destination.rename(output / file)
            result = {**metadata, 'file': file, 'sha256': sha, 'bytes': (output / file).stat().st_size}
            write_json(output / (identity + '.json'), result)
        else:
            write_json(output / name.replace('.tar.zst', '.json'), metadata)
            (output / (name + '.sha256')).write_text(f'{sha}  {name}\n')
        proof = {'archive': name, 'input_sha256': expected['sha256'], 'sha256': sha,
                 'old_brotli': OLD, 'new_brotli': NEW, 'unchanged_members': unchanged,
                 'relinked_binaries': changed_binaries, 'php_rebuilt': False, 'extensions_rebuilt': False,
                 'replacement_source': provenance['sources'][0], 'changed_members': sorted(excluded)}
        write_json(evidence / (name + '.json'), proof)
        print(json.dumps({k: v for k, v in proof.items() if k not in ('replacement_source', 'changed_members')}), flush=True)


def main(version, architecture, replacement, output):
    if os.uname().sysname != 'Darwin':
        raise ValueError('Mach-O changes and signing require macOS')
    platforms = json.loads((ROOT / 'conf/platforms.json').read_text())
    if os.uname().machine != architecture or int(run('sw_vers', '-productVersion').split('.')[0]) != platforms[architecture]['minimum_macos']:
        raise ValueError('Use the configured native baseline runner')
    evidence = output / 'evidence'
    evidence.mkdir(parents=True, exist_ok=True)
    package = json.loads((ROOT / 'conf/package.json').read_text())
    with tempfile.TemporaryDirectory(prefix='brotli-update-') as tmp:
        tmp = Path(tmp)
        keg, provenance = prepare_replacement(replacement, architecture, tmp)
        for private in (False, True):
            tag = 'extensions' if private else f'php-{version}'
            manifest_name = f'extensions-{version}-manifest.json' if private else f'php-{version}-manifest.json'
            origins = [f'https://github.com/{package["release_repository"]}/releases/download/{tag}', f'{package["artifact_mirror"]}/{tag}']
            manifest_file = evidence / manifest_name
            repack.fetch([base + '/' + manifest_name for base in origins], manifest_file)
            manifest = json.loads(manifest_file.read_text())
            for entry in manifest['assets']:
                if entry['architecture'] != architecture:
                    continue
                if private and not any(d['name'] == 'brotli' for d in entry['dependencies']):
                    continue
                filename = entry['file'] if private else entry['download']
                archive = tmp / filename
                repack.fetch([base + '/' + filename for base in origins], archive, entry['sha256'])
                destination = output / ('extensions' if private else architecture)
                if private:
                    destination /= '-'.join(entry[k] for k in ('name', 'php_version', 'build', 'thread_safety', 'architecture'))
                transform(archive, entry, keg, provenance, destination, evidence, private)
                archive.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('version')
    parser.add_argument('architecture', choices=('arm64', 'x86_64'))
    parser.add_argument('replacement', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    main(args.version, args.architecture, args.replacement.resolve(), args.output.resolve())
