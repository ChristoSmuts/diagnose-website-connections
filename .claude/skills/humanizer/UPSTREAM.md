# Vendored: blader/humanizer

`SKILL.md` and `LICENSE` in this directory are copied verbatim from
<https://github.com/blader/humanizer> (MIT, © 2025 Siqi Chen).

- **Vendored at version:** 2.11.0
- **Source path upstream:** `skills/humanizer/SKILL.md`

## Why vendored rather than installed

Installing it globally (`npx skills add blader/humanizer --global`) would make the copy standard depend
on each contributor's machine. Committing it means the standard travels with the repository, applies in
CI and in any future session, and is versioned alongside the copy it governs.

## Updating

Replace both files from upstream and bump the version above. **Do not edit `SKILL.md` locally** — it is
excluded from Prettier (see `.prettierignore`) specifically so it stays byte-identical to upstream and a
new release can be diffed cleanly.

Project-specific copy rules belong in [`../report-voice/SKILL.md`](../report-voice/SKILL.md) instead.
That separation is deliberate: `humanizer` is a general prose pass and knows nothing about this
product's honesty constraints.
