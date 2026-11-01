# Upstream — drawn-by-code

The `core/` directory of this repo is a **renamed, completely unmodified
copy** of the upstream project:

- **Repository:** https://github.com/illodev/drawn-by-code (by illodev)
- **Commit:** `3c9c949421e4aa86dba444dfe8cba46d000f9d87`
- **Commit date:** 2026-10-15T13:14:38+02:00
- **Files copied:** 543 (the full working tree at that commit — matches the
  GitHub git-trees API count for the commit exactly)
- **Integrity verification:** every copied file's git blob SHA-1 was checked
  against the upstream tree: **543 checked, 0 different, 0 missing.**
  `git status` was also clean (0 changes) before the copy's `.git` was
  removed; the upstream `.git` directory itself was not copied.
- **How it was copied:** `git clone --depth 1` of the commit above directly
  into `core/` → `.git` removed → nothing inside edited, renamed or deleted.
  (`deploy/fetch-core.sh` reproduces this copy from the same commit.)

The user's rule, and ours: upstream's work is treated as perfect — it is
never modified. All adaptation (Telegram bot, OpenCode configuration, media
tools, deployment) lives **outside** `core/`, in this project's own files.
New files created at runtime (video jobs) follow upstream's own convention
and live in `core/sandbox/<date>-<slug>/` — the folder upstream reserves for
exactly that.

Licensing: upstream's `core/LICENSE` is the upstream author's license text
and governs `core/`. GitHub classifies the upstream repo's license as
"Other (NOASSERTION)". Our own code (everything outside `core/`) is the
project owner's.
