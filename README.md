# PHP Darwin

Prebuilt Homebrew PHP packages for macOS and setup-php.

Configuration lives in `conf/`; supported PHP versions and variants are shared by every component.

Runner preparation pins Homebrew sources, preserves the Actions Node runtime, and recovers only proven orphaned builds.

Build PHP archives with `scripts/build/build.sh`. Packages include runtime dependencies, coverage modules, development files, licenses and the pinned PHP tap.

Generate the standalone installer with `bash scripts/installer/generate-install.sh`. Edit its source inputs, never the generated `scripts/install.sh`. Installation preserves existing PHP, configuration and services and rolls back failed transactions.

Release transfers verify checksums and use bounded retries. R2 upload completion is verified against the signed object API before checking public downloads.

Publish complete PHP matrices with `scripts/release/publish.sh`. Immutable archives are verified before the matching installer and manifest are published. `mirror.yml` refreshes mirrors and installers.

Run local checks with `bash scripts/tests/run.sh` and workflow checks with `actionlint`.

[MIT license](LICENSE).
