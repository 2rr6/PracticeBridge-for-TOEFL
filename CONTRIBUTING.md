# Contributing

Run `npm ci`, `npm run check`, and `node scripts/verify.mjs --profile pure-js`.
Use self-authored synthetic fixtures. Never submit real test questions, private PDFs, recordings, API keys, model weights, desktop profiles, user data or private review logs.

New runtime code, schemas, workers and assets require explicit entries in `docs/development/release-policy.json`. Record binary origins, licenses and hashes. Dependency changes require lock-based inventory regeneration and review; do not loosen the publishing policy to a directory wildcard. Preserve original materials and existing attempt snapshots.

Tests that use synthetic audio do not establish real microphone quality. Report skipped or unavailable checks. Publishing is a separate maintainer-approved action; a contribution or passing CI does not grant publication authority.
