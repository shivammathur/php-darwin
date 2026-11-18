#!/usr/bin/env python3
import hashlib
import copy
from contextlib import nullcontext
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import sys
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[3]
VERSION = json.loads((ROOT / 'conf/package.json').read_text())['current_version']
SEMVER = VERSION + '.0'
spec = importlib.util.spec_from_file_location('repack', ROOT / 'scripts/release/repackage-installer.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    tree = root / 'tree'
    tap = tree / 'var/php-darwin/homebrew-php'
    (tap / 'Formula').mkdir(parents=True)
    for name in ['php', 'php-zts', 'php-debug', 'php-debug-zts']:
        (tap / 'Formula' / (name + '.rb')).write_text('# packaging fixture\n')
    (tap / 'tool.sh').write_text('#!/bin/sh\nexit 0\n')
    (tap / 'tool.sh').chmod(0o755)
    (tap / 'formula-link').symlink_to('Formula/php.rb')
    branch = sys.argv[1] if len(sys.argv) > 1 else 'main'
    run('git', 'init', '-b', branch, str(tap))
    run('git', '-C', str(tap), 'add', '.')
    run('git', '-C', str(tap), '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture')
    commit = run('git', '-C', str(tap), 'rev-parse', 'HEAD')
    run('git', '-C', str(tap), 'remote', 'add', 'origin', 'https://github.com/shivammathur/homebrew-php')
    run('git', '-C', str(tap), 'update-ref', 'refs/remotes/origin/main', commit)
    if branch == 'php-darwin-staged':
        run('git', '-C', str(tap), 'config', 'php-darwin.private-snapshot', commit)
    source_hash = run('bash', str(ROOT / 'scripts/lib/source-hash.sh'), VERSION, env={**os.environ, 'HOMEBREW_PHP_PATH': str(tap)})
    archive_name = f'php_{VERSION}-nts-release+darwin_arm64.tar.zst'
    metadata = json.loads((ROOT / 'templates/cache-metadata.json').read_text())
    metadata.update(archive=archive_name, architecture='arm64', brew_prefix='/opt/homebrew', build='release', formula='php',
                    formula_sha256='a' * 64, homebrew_php_commit=commit, extensions_source_hash='b'*64, homebrew_extensions_commit='c'*40,
                    minimum_macos=14, macos_version='14.0', platform_key='arm64_sonoma', requested_formula=f'php@{VERSION}',
                    php_version=VERSION, php_semver=SEMVER, php_src_commit='', source_hash=source_hash, tap_snapshot='var/php-darwin/homebrew-php',
                    thread_safety='nts', pear_path='share/pear', pecl_extension='20250925',
                    packages=[{'name':'php','opt_target':f'../Cellar/php/{SEMVER}','keg_only':False}],
                    links=[{'path':'bin/php','target':f'../Cellar/php/{SEMVER}/bin/php'}], state_paths=[f'etc/php/{VERSION}/pear.conf'],tap_formulae=['php'])
    def write(name, data):
        file = tree / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(data)
    write('var/php-darwin/' + archive_name.replace('.tar.zst','.json'), json.dumps(metadata, indent=2)+'\n')
    write(f'Cellar/php/{SEMVER}/INSTALL_RECEIPT.json', json.dumps({'runtime_dependencies':[]}))
    write(f'Cellar/php/{SEMVER}/bin/php', 'unchanged payload\n')
    (tree/f'Cellar/php/{SEMVER}/bin/php').chmod(0o755)
    long_name = f'Cellar/php/{SEMVER}/share/php/pear/doc/Structures_Graph/docs/tutorials/Structures_Graph/Structures_Graph.pkg'
    write(long_name, 'long USTAR path without extended headers\n')
    write(f'etc/php/{VERSION}/pear.conf', '/opt/homebrew/share/pear\n')
    (tree/'bin').mkdir()
    (tree/'bin/php').symlink_to(f'../Cellar/php/{SEMVER}/bin/php')
    tar = root / 'fixture.tar'
    with tarfile.open(tar, 'w') as stream:
        for file in sorted(tree.rglob('*')):
            if file.is_dir(): continue
            name = str(file.relative_to(tree))
            info = stream.gettarinfo(file, arcname=name)
            # Real Intel archives include long USTAR paths, while other members
            # carry PAX timestamps. Exercise both encodings in the same input.
            stream.format = tarfile.USTAR_FORMAT if name == long_name else tarfile.PAX_FORMAT
            if name == long_name: info.mtime = int(info.mtime)
            with open(file, 'rb') if info.isfile() else nullcontext() as body:
                stream.addfile(info, body)
        info = tarfile.TarInfo(f'Cellar/php/{SEMVER}/bin/php-hardlink')
        info.type, info.linkname = tarfile.LNKTYPE, f'Cellar/php/{SEMVER}/bin/php'
        stream.addfile(info)
    archive = root / archive_name
    run('zstd', '-q', '-f', str(tar), '-o', str(archive))
    # A valid tar can have more padding than fits in the decompressor pipe.
    # Tar readers stop at the end marker; the zstd frame must still be drained
    # and checked, including a truncated footer after all members were read.
    padded_tar = root / 'padded.tar'
    padded_tar.write_bytes(tar.read_bytes() + bytes(1024 * 1024))
    padded = root / 'padded.tar.zst'
    run('zstd', '-q', '-f', str(padded_tar), '-o', str(padded))
    assert [m.name for m, _ in module.members(padded)] == [m.name for m, _ in module.members(archive)]
    truncated = root / 'truncated.tar.zst'
    truncated.write_bytes(padded.read_bytes()[:-1])
    try: list(module.members(truncated))
    except (RuntimeError, tarfile.ReadError): pass
    else: raise AssertionError('accepted a truncated zstd frame after the tar end marker')
    expected = {key:metadata[key] for key in ['architecture','build','thread_safety','minimum_macos']}
    expected.update(name=archive_name,sha256=module.digest(archive),bytes=archive.stat().st_size)
    proof = module.repack(archive, expected, root/'out', root/'evidence')
    assert proof['payload_members_unchanged'] > 5 and proof['php_rebuilt'] is False
    packaged = list(module.members(root/'out'/archive_name)) # first two member identities, bodies read below independently
    assert packaged[0][0].name.endswith('.json') and packaged[1][0].name == module.CONTROLLER
    def inventory(file):
        return {member.name:module.record(member, body.read() if body else None) for member,body in module.members(file)}
    before, after = inventory(archive), inventory(root/'out'/archive_name)
    assert after[long_name] == before[long_name] and after[long_name]['pax_headers'] == {}
    assert after[f'Cellar/php/{SEMVER}/bin/php']['mode'] == 0o755
    assert after[f'Cellar/php/{SEMVER}/bin/php-hardlink']['type'] == tarfile.LNKTYPE.hex()
    # Verify the gate rejects content, permission, link, ownership, timestamp,
    # extended-attribute and member-set changes rather than only tar corruption.
    excluded = ('var/php-darwin/'+archive_name.replace('.tar.zst','.json'), module.CONTROLLER)
    for field, value in [('sha256','0'*64),('mode',0),('uid',42),('mtime',0),('pax_headers',{'SCHILY.xattr.user.test':'changed'}),('linkname','elsewhere')]:
        changed = copy.deepcopy(after)
        changed[long_name][field] = value
        try: module.verify_payload(before, changed, excluded)
        except ValueError as error: assert 'runtime payload' in str(error)
        else: raise AssertionError('accepted changed '+field)
    for change in ['remove','add']:
        changed = copy.deepcopy(after)
        if change == 'remove': del changed[long_name]
        else: changed['unexpected'] = changed[long_name]
        try: module.verify_payload(before, changed, excluded)
        except ValueError: pass
        else: raise AssertionError('accepted member-set change')
    # A subsequent installer-only refresh preserves the same runtime payload.
    repeated = {**expected, 'sha256':proof['sha256'], 'bytes':(root/'out'/archive_name).stat().st_size}
    repeat_proof = module.repack(root/'out'/archive_name, repeated, root/'repeat', root/'repeat-evidence')
    assert repeat_proof['payload_members_unchanged'] == proof['payload_members_unchanged']
    migration = module.repack(archive, expected, root/'migration', root/'migration-evidence', baseline=True)
    migrated = json.loads((root/'migration'/archive_name.replace('.tar.zst','.json')).read_text())
    assert migrated['minimum_macos'] == 15 and migrated['platform_key'] == 'arm64_sequoia'
    assert migrated['macos_version'] == metadata['macos_version']
    assert migrated['homebrew_php_commit'] == metadata['homebrew_php_commit']
    assert migration['previous_baseline'] == {'minimum_macos':14, 'platform_key':'arm64_sonoma'}
    assert migration['payload_members_unchanged'] == proof['payload_members_unchanged']
    assert module.verify_payload(before, inventory(root/'migration'/archive_name), excluded) == proof['payload_members_unchanged']
    try: module.repack(archive, {**expected,'architecture':'x86_64'}, root/'wrong', root/'wrong-evidence')
    except ValueError as error: assert 'identity mismatch' in str(error)
    else: raise AssertionError('accepted wrong architecture')
    expected['sha256'] = '0' * 64
    try:
        module.repack(archive, expected, root/'bad', root/'bad-evidence')
        raise AssertionError('accepted corrupt input')
    except ValueError as error:
        assert 'checksum' in str(error)
    print('Repack preserved every payload member, tar attribute and symlink; controller/context and input authentication passed')
