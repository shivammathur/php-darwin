# Private PHP release staging

The `php-darwin-private` R2 bucket is provisioned separately from CI. Keep both
its managed public URL and custom-domain access disabled. It contains `uploads/`
and `builds/`; no workflow creates a bucket or enables public access.

Upload an official release candidate tarball as `uploads/php-X.Y.Z.tar.xz` or
`uploads/php-X.Y.Z.tar.gz`. The internal `main/php_version.h` must report exactly
X.Y.Z, and the archive must contain `configure`. An upload can be replaced before
staging, but each staging run takes an immutable copy and records its SHA-256.

## Build and test ahead of the announcement

Run **Stage private PHP** (`cache-private.yml`) on `main` with:

- `php-version`: the stable minor, for example `8.4`.
- `source-file`: optional exact filename, for example `php-8.4.27.tar.xz`.
  Omit only when exactly one supported archive in `uploads/` matches the minor.
- `source-sha256`: optional checksum supplied with the candidate. Otherwise the
  workflow records the checksum of the authenticated R2 download.

The workflow builds all eight ARM64/Intel, release/debug, NTS/ZTS packages and
runs the same native runtime, linkage, FPM, Homebrew and preservation checks as
normal builds on every configured compatibility runner. Dependencies remain
pinned to `conf/dependencies.json`. PHP and coverage extensions build afresh;
embargoed candidates never populate public source-bottle releases or mirrors.

Sources are fetched through authenticated R2 and placed in Homebrew's source
cache after verification. The four formulae are committed in a temporary tap
snapshot with the final public php.net URL and checksum. The snapshot has no
private URL, credentials or obsolete bottle definitions. The installed/archive
PHP version is checked against the uploaded release version.
Packaged private snapshots use a marked local branch, allowing a later Homebrew
update to switch to public `main` without replaying the candidate recipe commit.
If the public tap later differs, normal freshness checks can rebuild from its
public inputs; the synthetic commit does not need to exist on GitHub.
Scheduled builds wait while the public tap is older than the published PHP
version. Publication also rejects downgrades, including older builds that were
already queued when the staged security release was published.

Each run uses `builds/RUN_ID-ATTEMPT/`:

- `inputs/`: immutable source archive and pinned tap snapshot.
- `plan.json`: source checksum, repository/tap/core revisions and full matrix.
- `packages/`: archives, checksums and metadata.
- `results/`: per-build and per-runner test records, bound to exact package hashes.
- `logs/`: build, test, approval and cleanup diagnostics.
- `ready.json`: signed approval, written only after all required tests pass.
- `workflow.json`: GitHub run and job evidence preserved before run deletion.

There are no Actions artifact uploads in this flow. Child process stdout/stderr,
including failures, is captured into private R2 logs. GitHub still exposes the
run's existence, branch, timing, status and dispatch inputs; do not use inputs
for credentials. Infrastructure failures or forcibly killed runners can prevent
private log upload. A build/test log-upload failure fails its job and prevents
the approval job from running.

The configured macOS runners can be hosted or trusted self-hosted machines.
Self-hosted jobs retain the normal pipeline's Homebrew preservation behavior;
they never run the disposable-host purge. Private source bottles, build scratch
files and Homebrew logs use the job's temporary directory. Cleanup removes seeded
source downloads and restores the previous PHP tap before the private log upload.
Successful jobs then remove their private workspace. Forcibly killed jobs or
failed cleanup/log transfers can leave local diagnostics for the runner owner.

Start a new staging run to retry after cleanup has deleted the previous run.
If retrying before deletion, use **Re-run all jobs**, not **Re-run failed jobs**:
a new attempt creates a new immutable staging directory and must have its own
complete plan and evidence.

Once merged to the default branch, `cleanup-private.yml` automatically preserves
completed runs' evidence and deletes their GitHub runs. It also accepts a manual
`build-id` for retrying cleanup. Cleanup does not delete R2 objects. The release
workflow uses the signed R2 approval and does not need the deleted GitHub run.
Branch builds are useful for development but are rejected for production release.

## Publish after the announcement

Run **Release PHP from private R2** (`release-private.yml`) on `main` with:

- `php-version`: the minor to update.
- `build-id`: the `RUN_ID-ATTEMPT` directory under `builds/`.
- `release-version`: the exact announced version.
- `source-sha256`: the official checksum for the staged compression format.

The workflow verifies the signed complete build/test record, all downloaded
package hashes, the requested version and the official php.net source bytes.
A changed candidate requires a new build. It then calls the existing publisher
under the shared per-minor publication lock: upload archives, verify the public
R2 mirror, publish the installer and commit the manifest. It does not compile
PHP. Public setup-php E2E checks follow publication.

## Credentials

The repository needs these Actions secrets:

- `PRIVATE_R2_ACCESS_KEY_ID` and `PRIVATE_R2_SECRET_ACCESS_KEY`: Object Read & Write
  scoped exclusively to `php-darwin-private`.
- `CF_R2_AWS_S3_ENDPOINT`: the existing account's S3 endpoint.
- `PRIVATE_RELEASE_SIGNING_KEY`: a random 32-byte key encoded as 64 lowercase hex
  characters. Keep it for as long as staged builds may need publication.
- Existing public R2 secrets and `TOKEN`: unchanged, used for public publication
  and authorized run cleanup respectively.

Private storage requires the scoped credentials and never falls back to the
public bucket token. No credentials belong in this Git branch.

## Branch trial before integration

For a development trial, set the repository Actions variable
`PRIVATE_TEST_PHP_VERSION` to the minor and push a commit containing
`[private-stage]` to `feature/private-r2-releases`. Ordinary pushes do not stage
private sources. Source archives are selected from authenticated R2; never put
private source contents, candidate filenames or hashes in the commit. Ubuntu
also needs `PRIVATE_TEST_BUILDER_BUILD_ID` set to the signed Builder run-attempt.
The full configured matrix is used. All intermediate handoffs use private R2,
including SAPI archives, final packages, and the Builder-to-Ubuntu handoff.
No GitHub Actions artifacts or Actions caches are used by private staging.

Until the cleanup workflow is on the default branch, archive and delete completed
trial runs with the repository's private cleanup script from a trusted local
checkout. Verify R2 evidence before deleting the run. Branch trial approvals are
for validation only and remain ineligible for production promotion.
