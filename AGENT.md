# PHP Darwin maintenance

See `README.md` for usage and `docs/maintenance.md` for workflow operations.

Run `bash scripts/tests/run.sh` and `actionlint` after changes.

Regenerate `scripts/install.sh` after changing any input in `conf/install-files`. Preserve existing PHP kegs, configuration and services.
