---
name: notion-git-docs-sync
description: Guides setting up a one-way Notion-to-git documentation distribution pipeline — Notion as source of truth, exported on a schedule to a central "brain" git repo, then distributed into project repos' docs/ folders so Claude Code sessions there stay current without manual copy-paste. Use when the user wants to sync Notion docs into GitHub repos, keep CLAUDE.md/docs/ current automatically across multiple repos, or mentions documentation drift from manual copying between Notion and git.
---

# Notion → git docs sync

Helps a user design and build their own version of this pipeline against
their own Notion workspace and their own repos. This is a *reference*
skill — it doesn't run the pipeline itself, it guides the conversation that
sets one up, using this repo's actual working code as the basis rather than
inventing something from scratch.

## When to use this

Reach for this when the user's request is shaped like:

- "Sync my Notion docs into GitHub so Claude Code always has current
  context."
- "I keep manually copying Notion pages into `CLAUDE.md`/`docs/` and it
  goes stale."
- "Set up an export from Notion to a repo, then push it out to my other
  repos."
- Anything describing documentation drift between a Notion workspace and
  one or more git repos, where the desired fix is automation rather than a
  one-off copy.

Not a fit for: syncing *into* Notion (this pipeline is one-way, Notion →
git, by design — see README.md's "What problem this solves"), or a
one-time manual export with no ongoing sync need.

## What to do

1. **Read `README.md` in this repo first.** It has the full architecture
   (two phases: Notion → brain repo, brain repo → project repos), the
   prerequisites, and a step-by-step setup walkthrough written in the order
   this was actually built and verified. Don't re-derive the design —
   follow that walkthrough's sequencing, especially "build and verify Phase
   1 completely before touching Phase 2."
2. **Use the actual scripts and workflows in this repo as the starting
   point**, not new code: `scripts/export.js`, `scripts/distribute.js`,
   `.github/workflows/export.yml`, `.github/workflows/distribute.yml`,
   `config/repo-map.example.json`, `.env.example`. Copy them into the
   user's new repo and adapt names/paths to their situation — the logic
   (empty-diff skip, generated-file header, `assertInsideDocs()` path
   safety, PR-mode vs. direct-push gating, the explicit
   `gh workflow run distribute.yml` dispatch) is already debugged; don't
   rewrite it.
3. **Never let a repo default to direct-push without an explicit,
   live-verified deploy-trigger audit** for that specific repo. PR mode is
   the safe default — see README.md section 4, step "Audit each target
   repo's deploy trigger," and the repo-map example's comments.
4. **Point out the gotchas in README.md's "Lessons learned" section**
   proactively, before the user hits them — especially the GitHub Actions
   anti-recursion rule (a `GITHUB_TOKEN`-authored push doesn't trigger
   other workflows) if they're building the two-workflow chain, and the
   deliberate no-delete design if they ask about cleaning up stale files.
5. **Keep Notion-side scope discipline explicit**: the export should only
   ever cover the Notion pages actually shared with the integration/PAT
   used, and it should be scoped as narrowly as the user's real need — see
   README.md's Security notes.
