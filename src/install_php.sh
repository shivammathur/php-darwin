#!/bin/bash

SUFFIX=''
[ "$DEBUG" = 'true' ] && SUFFIX='-debug'
[ "$TS" = 'true' ] && SUFFIX="$SUFFIX-zts"

PHP_FORMULA="php@$PHP_VERSION$SUFFIX"

brew unlink "$PHP_FORMULA" 2>/dev/null || true
brew install shivammathur/php/"$PHP_FORMULA"
brew link --overwrite --force "$PHP_FORMULA"

php_config=$(which php-config)
ext_dir="$(grep 'extension_dir=' "$php_config" | cut -d "'" -f 2)"
ext_opts=()
[ -n "$SUFFIX" ] && ext_opts+=('-s')
for extension in xdebug pcov; do
    brew install "${ext_opts[@]}" shivammathur/extensions/"$extension"@"$PHP_VERSION"
    sudo rm "$(brew --prefix)"/etc/php/"$PHP_VERSION"/conf.d/*"$extension".ini
done    
