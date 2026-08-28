# PHP Darwin

Fast, architecture-specific Homebrew PHP caches for GitHub-hosted macOS runners.

The project covers PHP 5.6 through 8.6 in every combination of:

- NTS and ZTS
- release and debug builds
- ARM64 and x86_64

PHP 5.6 through 8.5 follow stable formula updates in
[`shivammathur/homebrew-php`](https://github.com/shivammathur/homebrew-php). PHP 8.6 is rebuilt by the nightly workflow.

## Release layout

Each PHP minor has one public GitHub Release such as `php-8.5`. It contains eight deterministic assets:

- `php_8.5-nts-release+darwin_arm64.tar.zst`
- `php_8.5-nts-release+darwin_x86_64.tar.zst`
- the corresponding ARM64 and x86_64 archives for NTS/ZTS and debug/release

New builds replace those assets with `gh release upload --clobber`, so a patch release does not create a
new package or tag. A deterministic `php-8.5-manifest.json` records the exact PHP version, every asset
hash and size, Homebrew formula-set hash, minimum macOS version, and source commit. The update workflow
uses that manifest to detect formula changes; the install path does not fetch it.

All archives are built on macOS 15, the minimum supported runner generation. Each is tested on
macOS 15 and macOS 26 before publication. ARM64 and x86_64 packages are never used as fallbacks for
one another. Every build in a publication is pinned to one `homebrew-php` commit, and publication
requires the complete NTS/ZTS, debug/release, and architecture matrix to pass.

Each archive contains the requested PHP keg plus dependency kegs absent from the build runner's Homebrew
baseline. The selected keg versions are recorded exactly in archive metadata. This keeps the fast path
small and targets the Homebrew baseline already provided by GitHub's macOS runners. Long-range Zstandard
compression deduplicates the similar PHP CLI, CGI, FPM, Apache, and debugger binaries. Build cleanup uses
Homebrew's declared dependency graph for the pinned PHP formula, pins dependencies already installed on
the runner for the duration of the build, disables implicit autoremove, and removes only the explicitly
selected unrelated formulae. This avoids reinstalling or packaging patch-level updates for the runner's
existing PHP dependencies.

## Installation

```bash
bash scripts/install.sh 8.5 release nts
```

`scripts/install.sh` is standalone: it embeds the required shell helpers and configuration and does not
fetch or check out this repository. It makes one logical network request for the architecture/configuration
release asset, then extracts it directly into the Homebrew prefix. When setup-php downloads the installer,
the full cold path is two logical requests: one for this script and one for the archive.

Before extraction, the installer records compact exclusions for existing keg trees,
configuration files, PEAR files, and opt links. Formula-managed post-install files are moved aside for
rollback while tar writes their preconfigured replacements directly to their final Homebrew paths.
Because the archive has no directory entries, tar adds only missing runtime paths without reading,
copying, changing permissions on, or replacing excluded paths. An older requested PHP keg is retained
side-by-side and unlinked before extraction, matching Homebrew's upgrade model; only an exact duplicate
cached keg must be removed.
The archive includes the exact symlinks from Homebrew's build-time `unlink --dry-run` plan, so new
dependencies and the requested PHP formula become linked during the same extraction. Other active PHP
variants are unlinked first, and Homebrew relinks only dependencies that replace a pre-existing keg.
Every cached symlink and linked-keg marker is verified against the archive metadata. Homebrew also verifies
that the delta supplies every missing dependency before it is
configured; an incomplete cache is removed so setup-php can use its existing Brew fallback. The archive
contains the shared PEAR tree, PEAR configuration, and PECL extension directory name produced by the
formula's successful build-time `post_install`, avoiding the same PHP/PEAR startup work on every runner.
Dependencies updated by the cache are relinked through Homebrew; unrelated pre-existing formulae remain
untouched. Homebrew's own `tap`, `trust`, `uninstall`, `missing`, `unlink`, `link`, and service commands
manage Homebrew-owned state.
Tap preparation runs in parallel with the package fetch and is local when the tap already exists.

The configured performance budget is three seconds for release-asset fetch, seven seconds
for extraction and Homebrew configuration, and ten seconds end to end. Set `PHP_DARWIN_TIMING_LOG` to a
writable path to log release download, extraction, configuration, linking, and verification phases.
Failed installs also record `failure.phase` and print the phase-specific error plus rollback duration, so a
caller can explain why it is falling back to `brew install`.

The build and compatibility test matrices are data-driven by [`conf`](conf). Shell files under
[`scripts`](scripts) contain the build, release, installation, and verification logic. CI checks out the
repository and uses the source scripts directly; `scripts/install.sh` is generated from those files for the
standalone production path.

## License

The code in this project is licensed under the [MIT license](LICENSE).
