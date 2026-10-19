"""Validate a PHP release tarball or Git source export without extracting it."""
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

GIT_ROOT = re.compile(r"(?:[A-Za-z0-9_.-]+-)?php-src(?:-backports(?:-security)?)?-[a-f0-9]{40}")


def inspect_source(file, version):
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Invalid source version")
    if Path(file).stat().st_size > 256 * 1024**2:
        raise ValueError("Source archive is too large")
    root, layout, total, header = None, None, 0, None
    seen, regular = set(), set()
    with tarfile.open(file) as archive:
        for member in archive:
            name = member.name.rstrip("/")
            parts = PurePosixPath(name).parts
            if (not parts or name.startswith("/") or ".." in parts or
                    str(PurePosixPath(name)) != name or "\\" in name or
                    re.search(r"[\x00-\x1f\x7f]", name)):
                raise ValueError("Unsafe source archive path")
            if root is None:
                root = parts[0]
                layout = "release" if root == "php-" + version else "git"
                if layout == "git" and not GIT_ROOT.fullmatch(root):
                    raise ValueError("Unrecognized PHP source root")
            if parts[0] != root or name in seen:
                raise ValueError("Mixed roots or duplicate source member")
            if not (member.isfile() or member.isdir()) or (len(parts) == 1 and not member.isdir()):
                raise ValueError("Source must contain only regular files and directories")
            seen.add(name)
            total += member.size
            if len(seen) > 200000 or total > 2 * 1024**3:
                raise ValueError("Expanded source is too large")
            if member.isfile():
                relative = "/".join(parts[1:])
                regular.add(relative)
                if relative == "main/php_version.h":
                    if member.size >= 65536:
                        raise ValueError("Invalid source version header")
                    header = archive.extractfile(member).read().decode("utf-8")
    if header is None or re.findall(r'^#define PHP_VERSION "([^"]+)"$', header, re.M) != [version]:
        raise ValueError("Source header version differs from filename")
    if layout == "release":
        if "configure" not in regular:
            raise ValueError("Release source lacks configure")
    elif "buildconf" not in regular or not ({"configure.ac", "configure.in"} & regular):
        raise ValueError("Git source lacks buildconf or its configure template")
    return {"root": root, "layout": layout, "members": len(seen), "expanded_bytes": total}


if __name__ == "__main__":
    print(json.dumps(inspect_source(sys.argv[1], sys.argv[2])))
