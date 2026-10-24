#!/usr/bin/env python3
import copy
import importlib.util
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tarfile
import tempfile
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('preserve', ROOT / 'scripts/release/preserve-swoole-brotli.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def macho(version, library=None, marker=b''):
    commands = struct.pack('<6I', 0x32, 24, 1, 14 << 16, 14 << 16, 0)
    if library:
        name = library.encode() + b'\0'
        length = (24 + len(name) + 7) // 8 * 8
        commands += struct.pack('<6I', 0xd, length, 24, 0, version, 0x10000) + name.ljust(length - 24, b'\0')
    return struct.pack('<8I', 0xfeedfacf, 0x100000c, 0, 6, 2 if library else 1, len(commands), 0, 0) + commands + marker


def archive(root, stem, metadata, files):
    raw = root / f'{stem}.tar'
    with tarfile.open(raw, 'w', format=tarfile.PAX_FORMAT) as tar:
        for name, content in {'metadata.json': json.dumps(metadata).encode(), **files}.items():
            info = tarfile.TarInfo(name)
            info.mode, info.uid, info.gid, info.mtime = 0o755, 501, 20, 1234567890
            info.pax_headers = {'SCHILY.xattr.user.fixture': 'keep'}
            if content is None:
                info.type = tarfile.DIRTYPE
            elif isinstance(content, str):
                info.type, info.linkname = tarfile.SYMTYPE, content
            else:
                info.size = len(content)
            tar.addfile(info, io.BytesIO(content) if isinstance(content, bytes) else None)
    file = root / f'{stem}.tar.zst'
    subprocess.run(['zstd', '-q', str(raw), '-o', str(file)], check=True)
    return file, {**metadata, 'file': file.name, 'sha256': m.repack.digest(file), 'bytes': file.stat().st_size}


with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    recipe = json.loads((ROOT / 'conf/dependencies.json').read_text())['platforms']['arm64']['packages']['brotli']['source']['inputs']['recipe']
    metadata = {'schema': 1, 'name': 'swoole', 'php_version': '8.5', 'architecture': 'arm64',
                'build': 'release', 'thread_safety': 'nts', 'php_api': '20250925', 'php_semver': '8.5.12',
                'minimum_macos': 14, 'modules': ['swoole'], 'environment': {}, 'relocations': [],
                'dependencies': [{'name': 'brotli', 'versions': ['1.2.1']}], 'inputs_sha256': 'a' * 64,
                'source_records': [m.RECIPES['Formula/swoole@8.5.rb'], {'formula': 'brotli',
                  'repository': 'Homebrew/homebrew-core', 'path': 'Formula/b/brotli.rb', 'sha256': 'b' * 64, 'inputs_sha256': recipe}]}
    original = copy.deepcopy(metadata)
    original['dependencies'][0]['versions'] = ['1.2.0']
    original['source_records'][0]['sha256'] = '0' * 64
    original['source_records'][1]['inputs_sha256'] = '0' * 64
    oldfiles = {'modules/swoole.so': macho(0, marker=b'old'), 'kegs/other/1/bin/tool': macho(0, marker=b'unchanged'),
                'kegs/other/1/INSTALL_RECEIPT.json': b'original receipt', 'kegs/other/1/share/doc/empty': None,
                'licenses/swoole/LICENSE': b'original license'}
    for name in ('common', 'dec', 'enc'):
        oldfiles[f'kegs/brotli/1.2.0/lib/libbrotli{name}.1.2.0.dylib'] = macho(0x10200, f'@loader_path/libbrotli{name}.1.dylib')
        oldfiles[f'kegs/brotli/1.2.0/lib/libbrotli{name}.1.dylib'] = f'libbrotli{name}.1.2.0.dylib'
    newfiles = {m.renamed(k): m.renamed(v) if isinstance(v, str) else v for k, v in oldfiles.items()}
    for name in ('common', 'dec', 'enc'):
        newfiles[f'kegs/brotli/1.2.1/lib/libbrotli{name}.1.2.1.dylib'] = macho(0x10201, f'@loader_path/libbrotli{name}.1.dylib')
    newfiles['modules/swoole.so'] = macho(0, marker=b'rebuilt')
    newfiles['kegs/other/1/INSTALL_RECEIPT.json'] = b'new receipt'
    newfiles['kegs/other/1/share/doc/notice.html'] = b'new documentation'
    del newfiles['kegs/other/1/share/doc/empty']
    old, previous = archive(root, 'original', original, oldfiles)
    new, current = archive(root, 'rebuilt', metadata, newfiles)
    result = m.preserve(old, previous, new, current, root/'output', root/'evidence')
    output = next((root/'output').rglob('*.tar.zst'))
    actual = m.read_archive(output, result)
    uncompressed = subprocess.check_output(['zstd', '-dc', str(output)])
    final_member = list(actual.values())[-1][0]
    end = final_member.offset_data + ((final_member.size + 511) // 512) * 512
    assert uncompressed[end:] == bytes(1024), 'BSD tar requires only its two ending blocks'
    assert set(actual) == {m.renamed(k) for k in ['metadata.json', *oldfiles]}
    assert actual['kegs/other/1/INSTALL_RECEIPT.json'][1] == b'original receipt'
    assert actual['modules/swoole.so'][1] == newfiles['modules/swoole.so']
    assert actual['kegs/other/1/share/doc/empty'][0].isdir()
    assert actual['licenses/swoole/LICENSE'][0].pax_headers['SCHILY.xattr.user.fixture'] == 'keep'
    assert not (output.parent/'validation.txt').exists(), 'Repack must require fresh native tests'
    badfiles = {**newfiles, 'kegs/other/1/bin/tool': macho(0, marker=b'unexpected')}
    bad, badentry = archive(root, 'changed-unrelated', metadata, badfiles)
    for file, entry, message in [(bad, badentry, 'Unrelated rebuilt executable'),
                                 (new, {**current, 'sha256': '0'*64}, 'checksum')]:
        try: m.preserve(old, previous, file, entry, root/'bad', root/'evidence')
        except ValueError as error: assert message in str(error), str(error)
        else: raise AssertionError('Accepted an unsafe repack')
    badentry = copy.deepcopy(current)
    badentry['dependencies'].append({'name': 'unexpected', 'versions': ['2']})
    try: m.verify_entry(badentry, previous)
    except ValueError: pass
    else: raise AssertionError('Accepted an unrelated dependency update')
print('Swoole repack preserves layout, ancillary bytes, tar attributes and rebuilt executables; rejects unrelated changes')
