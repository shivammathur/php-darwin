#!/bin/bash

brew remove --force $(brew list)
brew test-bot --only-cleanup-before
brew test-bot --only-setup
