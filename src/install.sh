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

  BREW_PREFIX="$(brew --prefix)"

  tar_file=php@"$version$SUFFIX".tar.zst
  get /tmp/"$tar_file" "https://github.com/shivammathur/php-darwin/releases/latest/download/$tar_file"
  zstd -dq --force /tmp/"$tar_file"
  sudo rm -rf "$BREW_PREFIX"/share/gettext/its "$BREW_PREFIX"/lib/httpd
  sudo tar xf /tmp/php@"$version$SUFFIX".tar -C "$BREW_PREFIX"
  # if command -v gtar 2>/dev/null;
  #   sudo gtar --overwrite -xf /tmp/php@"$version$SUFFIX".tar -C "$BREW_PREFIX"
  # else
  #   sudo rm -rf "$BREW_PREFIX"/share/gettext/its
  #   sudo tar xf /tmp/php@"$version$SUFFIX".tar -C "$BREW_PREFIX"
  # fi  
}

version=$1
debug=$2
ts=$3
install
