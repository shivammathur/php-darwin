<?php
// Keep this compatible with the Swoole 2.x pack for PHP 5.6.
$table = new Swoole\Table(64);
$table->column('value', Swoole\Table::TYPE_INT);
if (!$table->create() || !$table->set('cache', array('value' => 42)) ||
    $table->get('cache')['value'] !== 42 || !$table->del('cache')) {
    throw new RuntimeException('Swoole shared table roundtrip failed');
}
$table->destroy();
echo "Swoole shared table passed\n";

// Swoole 2.x runs its reactor during PHP shutdown; explicit waits are tested
// with the newer runtime used by PHP 7 and later.
if (version_compare(swoole_version(), '4.0.0', '<')) {
    return;
}
$GLOBALS['swoolePackTimerFired'] = false;
function swoolePackTimer()
{
    $GLOBALS['swoolePackTimerFired'] = true;
}
if (swoole_timer_after(1, 'swoolePackTimer') === false) {
    throw new RuntimeException('Swoole timer creation failed');
}
swoole_event_wait();
if (!$GLOBALS['swoolePackTimerFired']) {
    throw new RuntimeException('Swoole event loop did not run the timer');
}
echo "Swoole event loop passed\n";
