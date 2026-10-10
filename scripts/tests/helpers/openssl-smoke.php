<?php

$recipe = file_get_contents($argv[1]);
if (!preg_match('/^\s*depends_on "openssl@(\d+)[^"]*"/m', $recipe, $dependency)) {
    throw new RuntimeException('Missing declared OpenSSL dependency');
}
ob_start();
phpinfo(INFO_MODULES);
$info = ob_get_clean();
if (!preg_match('/^OpenSSL Library Version => OpenSSL (\d+)\./m', $info, $runtime)
    || !preg_match('/^OpenSSL (\d+)\./', OPENSSL_VERSION_TEXT, $headers)
    || $dependency[1] !== $runtime[1] || $dependency[1] !== $headers[1]) {
    throw new RuntimeException('OpenSSL headers or runtime differ from the formula dependency');
}

$data = 'php-darwin OpenSSL smoke test';
$key = openssl_random_pseudo_bytes(32);
$iv = openssl_random_pseudo_bytes(16);
$encrypted = openssl_encrypt($data, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);
if ($encrypted === false || openssl_decrypt($encrypted, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv) !== $data) {
    throw new RuntimeException('OpenSSL AES round trip failed');
}
$privateKey = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
if ($privateKey === false || !openssl_sign($data, $signature, $privateKey, OPENSSL_ALGO_SHA256)) {
    throw new RuntimeException('OpenSSL RSA signing failed');
}
$publicKey = openssl_pkey_get_details($privateKey);
if ($publicKey === false || openssl_verify($data, $signature, $publicKey['key'], OPENSSL_ALGO_SHA256) !== 1) {
    throw new RuntimeException('OpenSSL RSA verification failed');
}
echo 'OpenSSL ', $dependency[1], ": headers, runtime, AES and RSA verified\n";
