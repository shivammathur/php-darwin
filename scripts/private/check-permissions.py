"""Reject packages whose payload is inaccessible to other installation users."""
import json
import subprocess
import sys
import tarfile


def check(archive):
    process = subprocess.Popen(['zstd', '-qdc', archive], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    members = 0
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|') as contents:
            for member in contents:
                members += 1
                required = 0o555 if member.isdir() else 0o444
                if member.isfile() and member.mode & 0o100:
                    required |= 0o111
                if (member.isfile() or member.isdir()) and member.mode & required != required:
                    raise ValueError('Package member is not accessible to installation users: '
                                     + member.name + ' (' + oct(member.mode) + ')')
        # Consume the complete frame, including its checksum after tar padding.
        process.stdout.read()
        diagnostic = process.stderr.read()
        if process.wait() != 0:
            raise ValueError('Invalid compressed package: ' + diagnostic.decode(errors='replace'))
        if not members:
            raise ValueError('Empty package')
        return {'policy': 'public-readable-v1', 'members': members}
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()
        process.stderr.close()


if __name__ == '__main__':
    print(json.dumps(check(sys.argv[1])))
