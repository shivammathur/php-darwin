# PHP Darwin

Prebuilt Homebrew PHP packages for macOS and setup-php.

Configuration lives in `conf/`; supported PHP versions and variants are shared by every component.

Runner preparation pins Homebrew sources, preserves the Actions Node runtime, and recovers only proven orphaned builds.

Run local checks with `bash scripts/tests/run.sh` and workflow checks with `actionlint`.

[MIT license](LICENSE).
