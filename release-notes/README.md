# Release notes

One file per release tag: `release-notes/v0.2.3.md`. It holds the prose of the
release body, written in the same commit that bumps the version, so the notes are
reviewed before the tag exists.

The file is Markdown with two jobs:

- the **first line is the release title**, an H1 that names the tag —
  `# v0.2.3 — the tag assembles its own release`
- everything below it is the top of the body: what is in it, what changed, what
  to watch out for.

`release.yml` (and `npm run release:assemble` locally) appends the parts of the
body that are facts — the asset table with the real hashes, the reproduction
recipe carrying the bundle's hash, the signer and fingerprint when the release is
signed, and the commit list — so the numbers in the notes cannot disagree with
the files. Two rules keep them single-sourced:

- **Do not write hashes.** Any 64-character hex string in the prose has to be a
  hash this release publishes; anything else fails the assembly. A hash typed
  from memory is a hash nobody compared with a file, which is exactly how the
  hand-written notes drifted.
- **Do not write an `### Assets` section.** That table is generated from the
  staged files, for the same reason.

The published notes for `v0.2.1` and `v0.2.2` show the shape and the tone: these
are read by people deciding whether to upgrade.
