#!/bin/bash

cd $(brew --prefix) || exit 1

SUFFIX=''
[ "$DEBUG" = 'true' ] && SUFFIX='-debug'
[ "$TS" = 'true' ] && SUFFIX="$SUFFIX-zts"

sudo git add .
sudo git commit -q -m "installed php"

mkdir /tmp/php
for file in $(git log -p -n 1 --name-only | tail -n +5 | xargs -L1 echo); do
  if [ -e "$file" ]; then
    sudo rsync -Rl "$file" /tmp/php || true
  fi  
done

brew install zstd 2>/dev/null || true
(
  cd /tmp/php || exit 1
  tar cf - ./* | zstd -22 -T0 --ultra --force > ../php@"$PHP_VERSION$SUFFIX".tar.zst
)

cd "$GITHUB_WORKSPACE" || exit 1
mkdir builds
mv /tmp/*.zst ./builds
ls -laR ./builds
