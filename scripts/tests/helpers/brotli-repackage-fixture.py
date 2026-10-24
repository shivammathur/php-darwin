#!/usr/bin/env python3
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('brotli_repack', ROOT / 'scripts/release/repackage-brotli.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

for names in [('../escape',), ('absolute', '/escape'), ('link', 'link/file')]:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        with tarfile.open(root / 'unsafe.tar', 'w') as archive:
            for name in names:
                member = tarfile.TarInfo(name)
                if name == 'link':
                    member.type, member.linkname = tarfile.SYMTYPE, 'inside'
                archive.addfile(member)
        with tarfile.open(root / 'unsafe.tar') as archive:
            try:
                module.extract_replacement(archive, root / 'output')
            except ValueError:
                pass
            else:
                raise AssertionError('Accepted an unsafe replacement archive')

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    keg = root / 'keg'
    (keg / 'lib').mkdir(parents=True)
    (keg / 'lib/libbrotlidec.1.2.1.dylib').write_bytes(b'new decoder fixture')
    (keg / 'lib/libbrotlidec.1.dylib').symlink_to('libbrotlidec.1.2.1.dylib')
    record = {'formula': 'brotli', 'repository': 'Homebrew/homebrew-core', 'path': 'Formula/b/brotli.rb', 'sha256': 'a' * 64}
    metadata = {'schema': 1, 'name': 'swoole', 'php_version': '8.5', 'build': 'release', 'thread_safety': 'nts',
                'architecture': 'arm64', 'minimum_macos': 14, 'dependencies': [{'name': 'brotli', 'versions': ['1.2.0']}],
                'source_records': [record], 'inputs_sha256': 'b' * 64, 'relocations': []}
    archive = root / 'old.tar.zst'
    raw = root / 'old.tar'
    with tarfile.open(raw, 'w') as target:
        for name, content in [('metadata.json', json.dumps(metadata).encode()),
                              ('kegs/brotli/1.2.0/lib/libbrotlidec.1.2.0.dylib', b'old decoder fixture'),
                              ('modules/swoole.so', b'unchanged extension'),
                              ('kegs/curl/8/lib/libcurl.dylib', b'unchanged curl')]:
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.uid, info.gid, info.mtime = len(content), 0o755, 501, 20, 1234567890
            info.pax_headers = {'SCHILY.xattr.user.fixture': 'preserve me'}
            target.addfile(info, io.BytesIO(content))
        info = tarfile.TarInfo('kegs/brotli/1.2.0/lib/libbrotlidec.1.dylib')
        info.type, info.linkname = tarfile.SYMTYPE, 'libbrotlidec.1.2.0.dylib'
        target.addfile(info)
    subprocess.run(['zstd', '-q', str(raw), '-o', str(archive)], check=True)
    expected = {**metadata, 'file': archive.name, 'sha256': module.repack.digest(archive), 'bytes': archive.stat().st_size}
    provenance = {'source_record': {**record, 'sha256': 'c' * 64}, 'sources': [{'fixture': True}]}
    module.transform(archive, expected, keg, provenance, root / 'output', root / 'evidence', private=True)
    result, = (root / 'output').glob('*.tar.zst')
    contents = {m.name: (m, s.read() if s else None) for m, s in module.repack.members(result)}
    assert not any('brotli/1.2.0' in n for n in contents)
    assert contents['modules/swoole.so'][1] == b'unchanged extension'
    assert contents['modules/swoole.so'][0].uid == 501
    assert contents['modules/swoole.so'][0].pax_headers['SCHILY.xattr.user.fixture'] == 'preserve me'
    assert contents['kegs/brotli/1.2.1/lib/libbrotlidec.1.dylib'][0].linkname == 'libbrotlidec.1.2.1.dylib'
    updated = json.loads(contents['metadata.json'][1])
    assert updated['dependencies'][0]['versions'] == ['1.2.1']
    assert updated['source_records'][0]['sha256'] == 'c' * 64
    for bad, message in [({**expected, 'sha256': '0' * 64}, 'checksum'),
                         ({**expected, 'architecture': 'x86_64'}, 'identity mismatch'),
                         ({**expected, 'inputs_sha256': '0' * 64}, 'metadata differs')]:
        try:
            module.transform(archive, bad, keg, provenance, root / 'bad', root / 'evidence', private=True)
        except ValueError as error:
            assert message in str(error), str(error)
        else:
            raise AssertionError('Accepted invalid source archive')
    assert module.renamed('opt/brotli/lib/libbrotlidec.1.dylib') == 'opt/brotli/lib/libbrotlidec.1.dylib'
    assert module.renamed('@loader_path/../kegs/brotli/1.2.0/lib/libbrotlidec.1.dylib') == '@loader_path/../kegs/brotli/1.2.1/lib/libbrotlidec.1.dylib'
print('Brotli replacement preserves unrelated payload and tar attributes and rejects corrupt or mismatched inputs')
