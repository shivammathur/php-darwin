#!/usr/bin/env python3
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import struct
import sys
import tarfile
import tempfile
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('brotli_repack', ROOT / 'scripts/release/repackage-brotli.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    keg = root / 'keg'
    (keg / 'lib').mkdir(parents=True)
    (keg / 'lib/libbrotlidec.1.2.1.dylib').write_bytes(b'new decoder fixture')
    (keg / 'lib/libbrotlidec.1.dylib').symlink_to('libbrotlidec.1.2.1.dylib')
    (keg / 'INSTALL_RECEIPT.json').write_text('{"runtime_dependencies":[]}')
    record = {'formula': 'brotli', 'repository': 'Homebrew/homebrew-core', 'path': 'Formula/b/brotli.rb', 'sha256': 'a' * 64}
    name = 'php_8.5-nts-release+darwin_arm64.tar.zst'
    metadata = json.loads((ROOT / 'templates/cache-metadata.json').read_text())
    metadata.update(archive=name, architecture='arm64', brew_prefix='/opt/homebrew', build='release', formula='php',
        minimum_macos=14, platform_key='arm64_sonoma', requested_formula='php@8.5', php_version='8.5', php_semver='8.5.12',
        homebrew_php_commit='a'*40, source_hash='b'*64, tap_snapshot='var/php-darwin/homebrew-php',
        thread_safety='nts', pear_path='share/pear', pecl_extension='20250925',
        packages=[{'name':'php','opt_target':'../Cellar/php/8.5.12','keg_only':False},
                  {'name':'brotli','opt_target':'../Cellar/brotli/1.2.0','keg_only':False}],
        links=[{'path':'lib/libbrotlidec.1.2.0.dylib','target':'../Cellar/brotli/1.2.0/lib/libbrotlidec.1.2.0.dylib'}],
        build_inputs={'schema':1,'source_records':[record]})
    archive, raw = root / name, root / 'old.tar'
    metadata_name = 'var/php-darwin/' + name.replace('.tar.zst', '.json')
    with tarfile.open(raw, 'w') as target:
        for member_name, content in [(metadata_name, json.dumps(metadata).encode()),
                (module.repack.CONTROLLER, ("#!/bin/bash\n# Preserve this previous controller verbatim\ncat <<'PHP_DARWIN_METADATA'\n" + json.dumps(metadata) + "\nPHP_DARWIN_METADATA\nprintf '%s' 'Cellar/brotli/1.2.0'\n").encode()),
                ('Cellar/brotli/1.2.0/lib/libbrotlidec.1.2.0.dylib', b'old decoder fixture'),
                ('Cellar/brotli/1.2.0/INSTALL_RECEIPT.json', b'{"runtime_dependencies":[]}'),
                ('Cellar/php/8.5.12/bin/php', b'unchanged PHP'),
                ('Cellar/php/8.5.12/INSTALL_RECEIPT.json', b'{"runtime_dependencies":[]}'),
                ('Cellar/curl/8/lib/libcurl.dylib', b'unchanged curl')]:
            info = tarfile.TarInfo(member_name)
            info.size, info.mode, info.uid, info.gid, info.mtime = len(content), 0o755, 501, 20, 1234567890
            info.pax_headers = {'SCHILY.xattr.user.fixture': 'preserve me'}
            target.addfile(info, io.BytesIO(content))
        info = tarfile.TarInfo('Cellar/brotli/1.2.0/lib/libbrotlidec.1.dylib')
        info.type, info.linkname = tarfile.SYMTYPE, 'libbrotlidec.1.2.0.dylib'
        target.addfile(info)
        info = tarfile.TarInfo('lib/libbrotlidec.1.2.0.dylib')
        info.type, info.linkname = tarfile.SYMTYPE, '../Cellar/brotli/1.2.0/lib/libbrotlidec.1.2.0.dylib'
        target.addfile(info)
    subprocess.run(['zstd', '-q', str(raw), '-o', str(archive)], check=True)
    expected = {**metadata, 'name': name, 'sha256': module.repack.digest(archive), 'bytes': archive.stat().st_size}
    provenance = {'source_record': {**record, 'sha256': 'c' * 64}, 'sources': [{'fixture': True}]}
    module.transform(archive, expected, keg, provenance, root / 'output', root / 'evidence')
    contents = {m.name: (m, s.read() if s else None) for m, s in module.repack.members(root / 'output' / name)}
    assert not any('brotli/1.2.0' in n for n in contents)
    assert b'# Preserve this previous controller verbatim' in contents[module.repack.CONTROLLER][1]
    assert contents[module.repack.CONTROLLER][1].endswith(b"printf '%s' 'Cellar/brotli/1.2.1'\n")
    assert contents['Cellar/php/8.5.12/bin/php'][1] == b'unchanged PHP'
    assert contents['Cellar/php/8.5.12/bin/php'][0].uid == 501
    assert contents['Cellar/php/8.5.12/bin/php'][0].pax_headers['SCHILY.xattr.user.fixture'] == 'preserve me'
    assert contents['lib/libbrotlidec.1.2.1.dylib'][0].linkname == '../Cellar/brotli/1.2.1/lib/libbrotlidec.1.2.1.dylib'
    updated = json.loads(contents[metadata_name][1])
    assert updated['packages'][1]['opt_target'] == '../Cellar/brotli/1.2.1'
    assert updated['build_inputs']['source_records'][0]['sha256'] == 'c' * 64
    for bad, message in [({**expected, 'sha256': '0' * 64}, 'checksum'),
                         ({**expected, 'architecture': 'x86_64'}, 'identity mismatch')]:
        try:
            module.transform(archive, bad, keg, provenance, root / 'bad', root / 'evidence')
        except ValueError as error:
            assert message in str(error), str(error)
        else:
            raise AssertionError('Accepted invalid source archive')
    header = struct.pack('<IIIIIIII', 0xfeedfacf, 0x100000c, 0, 6, 1, 24, 0, 0)
    load = struct.pack('<IIIIII', 0x32, 24, 1, 14 << 16, 14 << 16, 0)
    assert module.macho(header + load)['minimum'] == 14 << 16
    for bad in (b'not Mach-O', header + load[:-1]):
        try:
            module.macho(bad)
        except ValueError:
            pass
        else:
            raise AssertionError('Accepted invalid Mach-O headers')
print('Brotli-only replacement preserves PHP, other payload, tar attributes and normal versioned paths')
