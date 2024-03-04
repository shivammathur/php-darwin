#!/bin/bash

get() {
  file_path=$1
  shift
  links=("$@")
  for link in "${links[@]}"; do
    status_code=$(sudo curl -w "%{http_code}" -o "$file_path" -sL "$link")
    [ "$status_code" = "200" ] && break
  done
}

install() {
  SUFFIX=''
  [ "$debug" = 'true' ] && SUFFIX='-debug'
  [ "$ts" = 'true' ] && SUFFIX="$SUFFIX-zts"

  tar_file=php@"$version$SUFFIX".tar.zst
  get /tmp/"$tar_file" "https://github.com/shivammathur/php-darwin/releases/latest/download/$tar_file"
  zstd -dq --long=30 --force /tmp/"$tar_file"
  sudo tar xf /tmp/php@"$version$SUFFIX".tar -C "$(brew --prefix)"
  cp $(brew --cellar php@"$version$SUFFIX")/*/homebrew.mxcl.php@"$version".plist ~/Library/LaunchAgents/homebrew.mxcl.php.plist
}

version=$1
debug=$2
ts=$3
install
