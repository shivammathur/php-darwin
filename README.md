# PHP Darwin

[![Package cache](https://github.com/shivammathur/php-darwin/actions/workflows/cache-stable.yml/badge.svg)](https://github.com/shivammathur/php-darwin/actions/workflows/cache-stable.yml)
[![Validation](https://github.com/shivammathur/php-darwin/actions/workflows/validate.yml/badge.svg)](https://github.com/shivammathur/php-darwin/actions/workflows/validate.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Prebuilt Homebrew PHP packages for fast installation on macOS, used by
[setup-php](https://github.com/shivammathur/setup-php). Packages include PHP and
its required dependencies. Installation preserves existing PHP versions,
configuration and services.

## PHP versions

| PHP versions | Updates |
| --- | --- |
| 5.6 | Stable releases |
| 7.0 | Stable releases |
| 7.1 | Stable releases |
| 7.2 | Stable releases |
| 7.3 | Stable releases |
| 7.4 | Stable releases |
| 8.0 | Stable releases |
| 8.1 | Stable releases |
| 8.2 | Stable releases |
| 8.3 | Stable releases |
| 8.4 | Stable releases |
| 8.5 | Stable releases |
| 8.6 | Nightly |
| 8.7 | Nightly |

Every version is available in release and debug builds, with NTS and ZTS variants.
Apple Silicon (ARM64) requires macOS 14 or later; Intel (x86_64) requires macOS 15
or later.

## Extensions

| Extension | PHP versions | Availability |
| --- | --- | --- |
| Xdebug | All supported versions | Included |
| PCOV | 7.1 to 8.7 | Included |
| Imagick | All supported versions | Optional |
| MongoDB | All supported versions | Optional |
| Memcached, igbinary, msgpack | All supported versions | Optional |
| Swoole | 5.6 to 8.5 | Optional |

## Installation

Use [setup-php](https://github.com/shivammathur/setup-php) in GitHub Actions:

```yaml
- uses: shivammathur/setup-php@v2
  with:
    php-version: '8.4'
    extensions: imagick, mongodb, memcached, swoole
```

To install directly on a macOS runner:

```sh
curl --fail --location --output install.sh \
  https://github.com/shivammathur/php-darwin/releases/download/php-8.4/install.sh
bash install.sh 8.4 release nts
```

To include optional packs:

```sh
bash install.sh 8.4 release nts "" "imagick, mongodb, memcached, swoole"
```

Downloads use GitHub Releases with a checksum-verified Cloudflare fallback.
Homebrew installs and links the selected PHP as the default.

## License

[MIT](LICENSE).
