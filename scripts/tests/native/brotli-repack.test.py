#!/usr/bin/env python3
"""Exercise PHP's unchanged curl binding against the replacement decoder."""
import ctypes
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import subprocess
import sys
import threading

prefix, php = sys.argv[1:]
library = ctypes.CDLL(str(Path(prefix) / 'opt/brotli/lib/libbrotlidec.1.dylib'))
library.BrotliDecoderVersion.restype = ctypes.c_uint32
assert library.BrotliDecoderVersion() == 0x1002001
message = b'PHP Darwin Brotli 1.2.1 runtime roundtrip\n' * 100
encoded = subprocess.check_output([str(Path(prefix) / 'opt/brotli/bin/brotli'), '-c'], input=message)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Encoding', 'br')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *args):
        pass


server = HTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    actual = subprocess.check_output([php, '-n', '-r',
        '$c=curl_init($argv[1]); curl_setopt($c,CURLOPT_RETURNTRANSFER,true); '
        'curl_setopt($c,CURLOPT_ENCODING,"br"); $r=curl_exec($c); '
        'if ($r===false) { fwrite(STDERR,curl_error($c)); exit(1); } echo $r;',
        f'http://127.0.0.1:{server.server_port}/'])
    assert actual == message
finally:
    server.shutdown()
    server.server_close()
print('Brotli reports 1.2.1; PHP curl decoded a Brotli HTTP response')
