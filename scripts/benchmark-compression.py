#!/usr/bin/env python3
"""Recompress verified PHP artifacts; never install or modify Homebrew packages."""

import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import tempfile
import time
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample", nargs=2, action="append", required=True, metavar=("ZIP", "MEMBER"))
    parser.add_argument("--levels", nargs="+", type=int, default=[15, 17, 19, 22])
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.repeats < 1 or args.threads < 1 or any(level < 1 or level > 22 for level in args.levels):
        parser.error("use positive repeats/threads and compression levels 1–22")
    results = []
    for bundle, name in args.sample:
        if pathlib.PurePosixPath(name).name != name or not name.endswith(".tar.zst"):
            parser.error("sample members must be flat .tar.zst archive filenames")
        with tempfile.TemporaryDirectory(prefix="php-darwin-compression-") as folder:
            root = pathlib.Path(folder)
            original = root / name
            with zipfile.ZipFile(bundle) as archive:
                with archive.open(name) as source, original.open("wb") as target:
                    shutil.copyfileobj(source, target)
                with original.open("rb") as source:
                    expected = archive.read(name + ".sha256").decode().split()[0]
                    if hashlib.file_digest(source, "sha256").hexdigest() != expected:
                        raise ValueError("Input archive checksum mismatch")
            raw = root / "payload.tar"
            subprocess.run(["zstd", "-q", "-d", str(original), "-o", str(raw)], check=True)
            with raw.open("rb") as source:
                expected = hashlib.file_digest(source, "sha256").hexdigest()
            for level in args.levels:
                compressed = root / f"level-{level}.zst"
                timings = []
                for _ in range(args.repeats):
                    started = time.perf_counter()
                    subprocess.run(["zstd", "--ultra", f"-{level}", "--long=27", f"-T{args.threads}",
                                    "-q", "-f", str(raw), "-o", str(compressed)], check=True)
                    timings.append(time.perf_counter() - started)
                started = time.perf_counter()
                with subprocess.Popen(["zstd", "-qdc", str(compressed)], stdout=subprocess.PIPE) as process:
                    actual = hashlib.file_digest(process.stdout, "sha256").hexdigest()
                    if process.wait() != 0 or actual != expected:
                        raise ValueError("Recompressed payload checksum mismatch")
                row = {"sample": name, "level": level, "threads": args.threads,
                       "compression_seconds": timings,
                       "decompression_and_sha256_seconds": time.perf_counter() - started,
                       "raw_bytes": raw.stat().st_size, "compressed_bytes": compressed.stat().st_size,
                       "original_bytes": original.stat().st_size,
                       "under_180MB": compressed.stat().st_size <= 180000000}
                results.append(row)
                args.output.write_text(json.dumps(results, indent=2) + "\n")
                print(json.dumps(row), flush=True)


if __name__ == "__main__":
    main()
