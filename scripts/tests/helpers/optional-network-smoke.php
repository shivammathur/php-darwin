<?php
// Keep these checks usable with the extension releases for PHP 5.6 onward.
// Exercise local APIs and connection failures without requiring external services.
$names = isset($argv[1]) ? explode(',', $argv[1]) : array('redis', 'amqp', 'yaml', 'ssh2', 'rdkafka');
foreach ($names as $name) {
    if (!extension_loaded($name)) {
        throw new Exception($name . ' is not loaded');
    }
    switch ($name) {
        case 'redis':
            $redis = new Redis();
            $value = array('cache' => 42, 'nested' => array('value' => 'roundtrip'));
            $serializers = array(Redis::SERIALIZER_PHP, Redis::SERIALIZER_IGBINARY);
            if (PHP_VERSION_ID >= 70000) {
                $serializers[] = Redis::SERIALIZER_MSGPACK;
            }
            foreach ($serializers as $serializer) {
                if (!$redis->setOption(Redis::OPT_SERIALIZER, $serializer) ||
                    $redis->_unserialize($redis->_serialize($value)) !== $value) {
                    throw new Exception('Redis serializer roundtrip failed');
                }
            }
            break;
        case 'yaml':
            $value = array('number' => 42, 'text' => 'php-darwin', 'nested' => array(true, false, null));
            if (yaml_parse(yaml_emit($value)) !== $value) {
                throw new Exception('YAML roundtrip failed');
            }
            break;
        case 'amqp':
        case 'ssh2':
            // Reserve then close a loopback port to test the native failure path.
            $server = stream_socket_server('tcp://127.0.0.1:0', $errno, $error);
            if (!$server) {
                throw new Exception('Could not reserve the connection test port');
            }
            $address = stream_socket_get_name($server, false);
            $port = (int) substr(strrchr($address, ':'), 1);
            fclose($server);
            if ($name === 'ssh2') {
                if (@ssh2_connect('127.0.0.1', $port) !== false) {
                    throw new Exception('SSH2 accepted an unavailable server');
                }
            } else {
                $connection = new AMQPConnection(array('host' => '127.0.0.1', 'port' => $port, 'connect_timeout' => 0.2));
                if ($connection->getHost() !== '127.0.0.1' || $connection->getPort() !== $port || $connection->isConnected()) {
                    throw new Exception('AMQP connection configuration failed');
                }
                $failed = false;
                try {
                    $connection->connect();
                } catch (AMQPConnectionException $exception) {
                    $failed = true;
                }
                if (!$failed || $connection->isConnected()) {
                    throw new Exception('AMQP connection failure was not handled');
                }
            }
            break;
        case 'rdkafka':
            $configuration = new RdKafka\Conf();
            $configuration->set('client.id', 'php-darwin');
            $configuration->set('log_level', '0');
            $settings = $configuration->dump();
            if ($settings['client.id'] !== 'php-darwin') {
                throw new Exception('Kafka configuration did not retain its value');
            }
            $producer = new RdKafka\Producer($configuration);
            $producer->setLogLevel(LOG_EMERG);
            $topic = $producer->newTopic('php-darwin');
            if ($topic->getName() !== 'php-darwin' || $producer->getOutQLen() !== 0) {
                throw new Exception('Kafka producer initialization failed');
            }
            $producer->poll(0);
            break;
        default:
            throw new Exception('Unknown optional extension check: ' . $name);
    }
    echo $name . " runtime validation passed\n";
}
