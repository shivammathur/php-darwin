#!/usr/bin/env python3
"""Compare Zstd levels and decoders on identical verified release contents."""
import argparse
import hashlib
import json
import pathlib
import subprocess
import tempfile
import time


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=pathlib.Path)
    parser.add_argument('checksum')
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--levels', nargs='+', type=int, default=[4, 19, 22])
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()
    assert sha256(args.archive) == args.checksum, 'Release archive checksum mismatch'
    results = []
    with tempfile.TemporaryDirectory(prefix='php-darwin-extraction-') as directory:
        root = pathlib.Path(directory)
        raw = root / 'payload.tar'
        subprocess.run(['zstd', '-qd', str(args.archive), '-o', str(raw)], check=True)
        expected = sha256(raw)
        for level in args.levels:
            archive = root / f'level-{level}.tar.zst'
            started = time.monotonic()
            subprocess.run(['zstd', '--ultra', f'-{level}', '--long=27', '-T2', '-q', str(raw), '-o', str(archive)], check=True)
            row = {'level': level, 'compressed_bytes': archive.stat().st_size,
                   'compression_seconds': time.monotonic() - started, 'decompression_seconds': [],
                   'libarchive_extract_seconds': [], 'zstd_pipe_extract_seconds': []}
            for repeat in range(args.repeats):
                decoded = root / 'decoded.tar'
                started = time.monotonic()
                subprocess.run(['zstd', '-qdf', str(archive), '-o', str(decoded)], check=True)
                row['decompression_seconds'].append(time.monotonic() - started)
                assert sha256(decoded) == expected, 'Recompression changed archive contents'
                decoded.unlink()
                # Alternate order to avoid systematically favouring warm reads.
                modes = ['libarchive', 'zstd_pipe'] if repeat % 2 == 0 else ['zstd_pipe', 'libarchive']
                for mode in modes:
                    with tempfile.TemporaryDirectory(dir=root) as destination:
                        started = time.monotonic()
                        command = ['tar', '--ignore-zeros', '-xmpf', str(archive) if mode == 'libarchive' else '-',
                                   '--no-same-owner', '-C', destination]
                        if mode == 'libarchive':
                            subprocess.run(command, check=True)
                        else:
                            with subprocess.Popen(['zstd', '-qdc', str(archive)], stdout=subprocess.PIPE) as decoder:
                                subprocess.run(command, stdin=decoder.stdout, check=True)
                                decoder.stdout.close()
                                assert decoder.wait() == 0
                        row[mode + '_extract_seconds'].append(time.monotonic() - started)
                        assert any(pathlib.Path(destination).glob('Cellar/php*/**/bin/php')), 'PHP missing after extraction'
            results.append(row)
            args.output.write_text(json.dumps({'archive': args.archive.name, 'sha256': args.checksum,
                                             'raw_bytes': raw.stat().st_size, 'results': results}, indent=2) + '\n')
            print(json.dumps(row), flush=True)


if __name__ == '__main__':
    main()
