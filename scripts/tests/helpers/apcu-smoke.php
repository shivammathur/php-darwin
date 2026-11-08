<?php
// Compatible with APCu 4 on PHP 5.6 and APCu 5 on newer PHP versions.
// Invoke with -d apc.enable_cli=1; leave the installed CLI default unchanged.
$key = 'php-darwin-apcu-' . getmypid();
$value = array('cache' => 42, 'nested' => array('value' => 'roundtrip'));
if (!apcu_store($key, $value)) {
    throw new Exception('APCu store failed');
}
$success = false;
if (apcu_fetch($key, $success) !== $value || !$success || !apcu_exists($key)) {
    throw new Exception('APCu fetch did not preserve the value');
}
if (!apcu_delete($key) || apcu_exists($key)) {
    throw new Exception('APCu delete failed');
}
$success = true;
if (apcu_fetch($key, $success) !== false || $success) {
    throw new Exception('APCu missing-key lookup failed');
}
echo "APCu store, fetch and delete passed\n";
