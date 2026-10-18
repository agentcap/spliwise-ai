# Preparing a public repository

Publish the Git repository, not a ZIP of the development workspace. Ignored
local directories can contain private ledgers, statement imports, backups,
credentials, model caches, logs and retained experiment artifacts. They are
not part of the public source and should remain local.

Before publishing, run:

```sh
npm run check:secrets
npm run check:secrets -- --history
```

The first command checks tracked and non-ignored new files. The second also
checks every blob reachable through local Git refs. Checks cover common token
and private-key formats, personal home-directory paths, and private artifacts.
Automated checks are pattern-based; inspect new screenshots and sample data too.

The committed expense CSV and application screenshots use synthetic sample
data. Benchmark adaptations are anonymized; original names, private databases,
account identifiers and real financial amounts are not distributed. Reserved
example-domain email addresses in authentication tests are intentional fixtures.

If an older commit contains private information, editing its current file is
insufficient. Prepare and verify cleaned history before publishing. Replacing
existing remote history changes commit IDs and requires coordination with any
collaborators. Do not change repository visibility while the old history is
still present. A new remote created from a verified clean copy avoids publishing
the old remote's retained objects.

Keep any recovery bundle outside published Git refs and inside ignored private
storage. Never upload the recovery bundle, local environment files, financial
backups or the complete development workspace as release assets.
