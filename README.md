# PHP Darwin

Prebuilt Homebrew PHP packages for macOS and setup-php.

Configuration lives in `conf/`; supported PHP versions and variants are shared by every component.

Runner preparation pins Homebrew sources, preserves the Actions Node runtime, and recovers only proven orphaned builds.

Build PHP archives with `scripts/build/build.sh`. Packages include runtime dependencies, coverage modules, development files, licenses and the pinned PHP tap.

Generate the standalone installer with `bash scripts/installer/generate-install.sh`. Edit its source inputs, never the generated `scripts/install.sh`. Installation preserves existing PHP, configuration and services and rolls back failed transactions.

Release transfers verify checksums and use bounded retries. R2 upload completion is verified against the signed object API before checking public downloads.

Publish complete PHP matrices with `scripts/release/publish.sh`. Immutable archives are verified before the matching installer and manifest are published. `mirror.yml` refreshes mirrors and installers.

`test.yml` checks native archives. `e2e.yml` checks direct installation and setup-php on ARM and Intel; inspect runtime, linkage and preservation evidence.

`cache-stable.yml` and `cache-nightly.yml` build the configured architecture and variant matrices, test them, and publish only after required checks pass.

`update.yml` and `update-nightly.yml` compare PHP, extension, dependency and nightly source inputs before dispatching builds. Installer-only changes do not require rebuilding PHP.

`cache-bottles.yml` mirrors exact upstream bottle digests into Cloudflare. Homebrew remains responsible for installation and relocation.

Source-cache keys include software/dependency versions, target platform and PHP ABI. Existing configuration is preserved while producing clean reusable bottles.

Source bottles use named GitHub Releases and Cloudflare mirrors. Build claims coordinate concurrent workers. `test-source-cache.yml` verifies native cold and warm reuse; `test-source-lock.yml` checks live coordination.

Normal builds require `conf/dependencies.json`. `update-dependencies.yml` prepares and verifies a replacement on both architectures before promotion. Missing approved bottles fail instead of compiling dependencies.

Verified archive checkpoints support partial reruns and expire after seven days. Payloads and relevant build inputs must match before reuse.

`publish.yml` retries publication from a validated PHP run. It verifies source workflow provenance, build/test plans, successful jobs and exact artifact IDs and digests.

Optional Imagick, MongoDB and Memcached packs carry private runtime libraries, licenses and serializer headers. Their standalone installer requires matching PHP release, source, architecture and ABI.

The PHP installer accepts optional extensions in its fifth argument and prepares packs while PHP installs. Activation follows successful runtime verification; pack failures retain setup-php fallback behavior.

`cache-extensions.yml` batches extension builds and compatibility tests. `update-extensions.yml` dispatches scheduled refreshes. Publication verifies archives on both origins before committing each manifest.

Run local checks with `bash scripts/tests/run.sh` and workflow checks with `actionlint`.

[MIT license](LICENSE).
