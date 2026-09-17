"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");

// Fine-grained GitHub PAT, scoped only to the target repos in repo-map.json.
// Required permissions: Contents Read/write (push the commit - direct to
// main for direct-push repos, to a branch for PR-mode repos) and Pull
// requests Read/write (open the PR on PR-mode repos; without it the branch
// push succeeds but the POST /pulls call 403s). Metadata Read is added
// automatically by GitHub on any fine-grained PAT, not a separate choice.
// Nothing broader than that. Store it as a secret in THIS repo only, never
// in any target repo.
const PAT = process.env.DOCS_SYNC_PAT;
if (!PAT) {
  console.error("Missing DOCS_SYNC_PAT environment variable.");
  process.exit(1);
}

const CONTENT_DIR = path.join(__dirname, "..", "content");
const REPO_MAP_PATH = path.join(__dirname, "..", "config", "repo-map.json");
const GITHUB_API = "https://api.github.com";

// One fixed branch name per repo, reused across runs, rather than a new
// branch/PR every time. Commits land on it as changes arrive; it opens
// exactly one PR that stays open and accumulates updates until merged.
// After a merge the branch is gone, so the next run recreates it fresh.
const SYNC_BRANCH = "docs-sync";

const repoMap = JSON.parse(fs.readFileSync(REPO_MAP_PATH, "utf8"));

// Content under content/ already carries the Phase 1 generated-file header
// (source Notion URL, do-not-edit notice) - export.js bakes it in at export
// time. Distribution copies files through unmodified rather than
// constructing a second header on top of the one already there.

// Add/update only, permanent design, not a temporary gap: this script never
// deletes a target repo's existing docs/ files, even ones no longer mapped.
// Deletion needs either a manifest or a full docs/ reconciliation pass, and
// reconciliation logic that removes files in a repo it doesn't own carries
// more risk than it's worth. An un-mapped stale file is a manual cleanup.

function assertInsideDocs(destPath) {
  const normalized = path.posix.normalize(destPath);
  if (normalized !== "docs" && !normalized.startsWith("docs/")) {
    throw new Error(`Refusing to write outside docs/: resolved path "${destPath}"`);
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(`Refusing to write path containing "..": "${destPath}"`);
  }
  return normalized;
}

function listFilesRecursive(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

// Resolves every "mapped" entry + target in repo-map.json into a flat list
// of { repo, destPath, sourceAbsPath }, per the config's resolutionRule:
// a glob source's files land at destDir/<path relative to the glob root>,
// a single-file source lands at destDir/<basename>.
function resolveWrites() {
  const writes = [];
  for (const entry of repoMap.entries) {
    if (entry.status !== "mapped") continue;

    const isGlob = entry.source.endsWith("/**");
    const sourceFiles = [];

    if (isGlob) {
      const sourceRoot = entry.source.slice(0, -"/**".length);
      const sourceRootAbs = path.join(CONTENT_DIR, sourceRoot);
      if (!fs.existsSync(sourceRootAbs)) {
        console.warn(`Skipping "${entry.id}": source root "${sourceRoot}" not found in content/.`);
        continue;
      }
      for (const abs of listFilesRecursive(sourceRootAbs)) {
        const rel = path.relative(sourceRootAbs, abs).split(path.sep).join("/");
        sourceFiles.push({ abs, relToRoot: rel });
      }
    } else {
      const abs = path.join(CONTENT_DIR, entry.source);
      if (!fs.existsSync(abs)) {
        console.warn(`Skipping "${entry.id}": source file "${entry.source}" not found in content/.`);
        continue;
      }
      sourceFiles.push({ abs, relToRoot: path.basename(entry.source) });
    }

    for (const target of entry.targets) {
      for (const src of sourceFiles) {
        const destPath = assertInsideDocs(`${target.destDir}/${src.relToRoot}`);
        writes.push({ repo: target.repo, destPath, sourceAbsPath: src.abs });
      }
    }
  }
  return writes;
}

// Never logs headers or request/response bodies - both can carry the PAT
// or full file contents. Callers that need the body read res.json directly.
async function ghRequest(method, urlPath, body) {
  const res = await fetch(`${GITHUB_API}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // No JSON body (e.g. some 404s) - leave json as null.
  }
  return { status: res.status, ok: res.ok, json };
}

async function ghRequestLogged(method, urlPath, body) {
  const result = await ghRequest(method, urlPath, body);
  console.log(`  ${method} ${urlPath} -> ${result.status}`);
  return result;
}

async function getFileOnRef(repo, filePath, ref) {
  const result = await ghRequest("GET", `/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`);
  if (result.status === 404) return null;
  if (!result.ok) {
    throw new Error(`Failed to read ${repo}:${filePath}@${ref} (status ${result.status})`);
  }
  const content = Buffer.from(result.json.content, "base64").toString("utf8");
  return { content, sha: result.json.sha };
}

async function putFileOnBranch(repo, filePath, content, branch, sha, message) {
  const result = await ghRequestLogged("PUT", `/repos/${repo}/contents/${filePath}`, {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch,
    ...(sha ? { sha } : {}),
  });
  if (!result.ok) {
    throw new Error(`Failed to write ${repo}:${filePath}@${branch} (status ${result.status})`);
  }
}

async function getBranchCommitSha(repo, branch) {
  const result = await ghRequest("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (result.status === 404) return null;
  if (!result.ok) {
    throw new Error(`Failed to read ref ${repo}:${branch} (status ${result.status})`);
  }
  return result.json.object.sha;
}

async function ensureBranchExists(repo, branch, fromSha) {
  const existingSha = await getBranchCommitSha(repo, branch);
  if (existingSha) return existingSha;
  const result = await ghRequestLogged("POST", `/repos/${repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: fromSha,
  });
  if (!result.ok) {
    throw new Error(`Failed to create branch ${repo}:${branch} (status ${result.status})`);
  }
  return fromSha;
}

async function findOpenPr(repo, branch) {
  const owner = repo.split("/")[0];
  const result = await ghRequest("GET", `/repos/${repo}/pulls?state=open&head=${owner}:${branch}`);
  if (!result.ok) {
    throw new Error(`Failed to list PRs for ${repo} (status ${result.status})`);
  }
  return result.json[0] || null;
}

async function openPr(repo, branch, changedPaths) {
  const body = [
    "Automated docs sync.",
    "",
    "This PR updates generated reference material under `docs/`. Do not hand-edit these files - the next sync overwrites them with no error.",
    "",
    "Changed files:",
    ...changedPaths.map((p) => `- \`${p}\``),
  ].join("\n");

  const result = await ghRequestLogged("POST", `/repos/${repo}/pulls`, {
    title: `Docs sync: ${changedPaths.length} file(s) updated`,
    head: branch,
    base: "main",
    body,
  });
  if (!result.ok) {
    throw new Error(`Failed to open PR on ${repo} (status ${result.status})`);
  }
  return result.json;
}

async function processRepo(repo, pushMode, writesForRepo) {
  console.log(`\n${repo} (${pushMode} mode):`);

  // "What's currently in the target repo" always means the default branch,
  // never an in-flight sync branch - otherwise an old unmerged PR would
  // make later runs think nothing changed.
  const changed = [];
  for (const write of writesForRepo) {
    const current = await getFileOnRef(repo, write.destPath, "main");
    const newContent = fs.readFileSync(write.sourceAbsPath, "utf8");
    if (current && current.content === newContent) continue;
    changed.push({ ...write, newContent, mainSha: current ? current.sha : null });
  }

  if (changed.length === 0) {
    console.log("  No changes, skipping.");
    return;
  }

  console.log(`  ${changed.length} file(s) changed:`);
  for (const c of changed) console.log(`    ${c.destPath}`);

  if (pushMode === "direct") {
    for (const c of changed) {
      await putFileOnBranch(repo, c.destPath, c.newContent, "main", c.mainSha, `Docs sync: update ${c.destPath}`);
    }
    console.log("  Pushed directly to main.");
    return;
  }

  if (pushMode !== "pr") {
    throw new Error(`Unknown pushMode "${pushMode}" for ${repo}.`);
  }

  const mainSha = await getBranchCommitSha(repo, "main");
  await ensureBranchExists(repo, SYNC_BRANCH, mainSha);

  for (const c of changed) {
    const onBranch = await getFileOnRef(repo, c.destPath, SYNC_BRANCH);
    if (onBranch && onBranch.content === c.newContent) continue; // already applied on the branch
    await putFileOnBranch(
      repo,
      c.destPath,
      c.newContent,
      SYNC_BRANCH,
      onBranch ? onBranch.sha : null,
      `Docs sync: update ${c.destPath}`
    );
  }

  const existingPr = await findOpenPr(repo, SYNC_BRANCH);
  if (existingPr) {
    console.log(`  Updated existing PR: ${existingPr.html_url}`);
    return;
  }
  const pr = await openPr(
    repo,
    SYNC_BRANCH,
    changed.map((c) => c.destPath)
  );
  console.log(`  Opened PR: ${pr.html_url}`);
}

async function main() {
  const writes = resolveWrites();

  // Optional single-repo filter, e.g. ONLY_REPO=your-org/repo-1. Useful for
  // a staged rollout: process one target repo at a time while you're still
  // building trust in the pipeline, so a run never touches repos you
  // haven't reviewed the output for yet.
  const onlyRepo = process.env.ONLY_REPO;
  if (onlyRepo && !repoMap.repos[onlyRepo]) {
    console.error(`ONLY_REPO "${onlyRepo}" is not a known repo in repo-map.json.`);
    process.exit(1);
  }

  const byRepo = new Map();
  for (const w of writes) {
    if (onlyRepo && w.repo !== onlyRepo) continue;
    if (!byRepo.has(w.repo)) byRepo.set(w.repo, []);
    byRepo.get(w.repo).push(w);
  }

  for (const [repo, repoWrites] of byRepo) {
    const repoConfig = repoMap.repos[repo];
    if (!repoConfig) {
      console.warn(`No repos[] entry for ${repo}, skipping (pushMode unknown).`);
      continue;
    }
    await processRepo(repo, repoConfig.pushMode, repoWrites);
  }

  console.log("\nDistribution complete.");
}

main().catch((err) => {
  console.error("Distribution failed:", err.message);
  process.exit(1);
});
