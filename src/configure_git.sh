#!/bin/bash

BREW_PREFIX="$(brew --prefix)"

git config --global user.email "you@example.com"
git config --global user.name "Your Name"

sudo rm -rf "$BREW_PREFIX"/.git "$BREW_PREFIX"/.gitignore

sudo git -C "$BREW_PREFIX" init
sudo git -C "$BREW_PREFIX" add .
sudo git -C "$BREW_PREFIX" commit -m "init"
