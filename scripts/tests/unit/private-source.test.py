import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'scripts/private/source_archive.py').is_file())
sys.path.insert(0, str(ROOT / 'scripts/private'))
from source_archive import inspect_source


class SourceArchiveTests(unittest.TestCase):
    def check_archive(self, entries, valid=True, root=None, version='8.1.99', compression='gz'):
        root = root or 'php-' + version
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp, 'source.tar.' + compression)
            with tarfile.open(file, 'w:' + compression) as tar:
                for name, data, kind in entries:
                    info = tarfile.TarInfo(name.replace('ROOT', root))
                    info.type = kind
                    info.linkname = '/outside' if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ''
                    info.size = len(data) if kind == tarfile.REGTYPE else 0
                    tar.addfile(info, io.BytesIO(data) if info.size else None)
            if valid:
                return inspect_source(file, version)
            with self.assertRaises((ValueError, tarfile.TarError)):
                inspect_source(file, version)

    def header(self, version='8.1.99'):
        return ('ROOT/main/php_version.h', ('#define PHP_VERSION "' + version + '"\n').encode(), tarfile.REGTYPE)

    def test_release_and_git_exports_for_both_compressions(self):
        for compression in ('gz', 'xz'):
            result = self.check_archive([self.header(), ('ROOT/configure', b'fixture', tarfile.REGTYPE)], compression=compression)
            self.assertEqual(result['layout'], 'release')
            for template in ('configure.ac', 'configure.in'):
                result = self.check_archive([self.header(), ('ROOT/buildconf', b'fixture', tarfile.REGTYPE),
                                             ('ROOT/' + template, b'fixture', tarfile.REGTYPE)],
                                            root='example-php-src-backports-' + 'a' * 40, compression=compression)
                self.assertEqual(result['layout'], 'git')

    def test_reject_unsafe_members_and_duplicate_version_headers(self):
        base = [self.header(), ('ROOT/configure', b'fixture', tarfile.REGTYPE)]
        for name in ['ROOT/../escape', '/outside', 'different/extra', 'ROOT/./main/php_version.h',
                     'ROOT//extra', 'ROOT/back\\slash', 'ROOT/line\nbreak', 'ROOT/main/php_version.h']:
            self.check_archive(base + [(name, b'extra', tarfile.REGTYPE)], valid=False)
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE):
            self.check_archive(base + [('ROOT/extra', b'', kind)], valid=False)

    def test_reject_missing_or_mismatched_version_and_incomplete_build_inputs(self):
        self.check_archive([], valid=False)
        self.check_archive([self.header('8.1.98'), ('ROOT/configure', b'fixture', tarfile.REGTYPE)], valid=False)
        self.check_archive([self.header()], valid=False)
        self.check_archive([self.header(), ('ROOT/configure', b'', tarfile.DIRTYPE)], valid=False)
        git = 'example-php-src-backports-' + 'a' * 40
        self.check_archive([self.header(), ('ROOT/buildconf', b'fixture', tarfile.REGTYPE)], root=git, valid=False)
        self.check_archive([self.header(), ('ROOT/configure.ac', b'fixture', tarfile.REGTYPE)], root=git, valid=False)
        self.check_archive([self.header(), ('ROOT/configure', b'fixture', tarfile.REGTYPE)], root='unrecognized', valid=False)
        duplicate = self.header()[1] * 2
        self.check_archive([('ROOT/main/php_version.h', duplicate, tarfile.REGTYPE),
                            ('ROOT/configure', b'fixture', tarfile.REGTYPE)], valid=False)


if __name__ == '__main__':
    unittest.main()
