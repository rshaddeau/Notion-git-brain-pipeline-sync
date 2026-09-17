"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client } = require("@notionhq/client");
const { NotionToMarkdown } = require("notion-to-md");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID;

if (!NOTION_TOKEN) {
  console.error("Missing NOTION_TOKEN environment variable.");
  process.exit(1);
}
if (!ROOT_PAGE_ID) {
  console.error("Missing NOTION_ROOT_PAGE_ID environment variable.");
  process.exit(1);
}

const CONTENT_DIR = path.join(__dirname, "..", "content");

const notion = new Client({ auth: NOTION_TOKEN });

// parseChildPages: false keeps notion-to-md from inlining child page content
// into its parent's markdown - we walk and write child pages ourselves.
const n2m = new NotionToMarkdown({
  notionClient: notion,
  config: { parseChildPages: false },
});

const stats = {
  exported: 0,
  emptyContent: 0,
  errors: 0,
};

function slugify(title) {
  const slug = String(title)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function getPageTitle(page) {
  const properties = page.properties || {};
  for (const key of Object.keys(properties)) {
    const prop = properties[key];
    if (prop.type === "title") {
      const text = (prop.title || []).map((t) => t.plain_text).join("");
      return text || "Untitled";
    }
  }
  return "Untitled";
}

async function getChildPages(pageId) {
  const children = [];
  let cursor;
  do {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const block of response.results) {
      if (block.type === "child_page") {
        children.push({ id: block.id, title: block.child_page.title });
      }
    }
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return children;
}

// Notion serves file/image attachments via presigned S3 URLs whose query
// string (signature + expiry) changes on every fetch even when the
// underlying file hasn't. Stripping it keeps re-exports byte-stable so the
// scheduled workflow doesn't commit a diff for content that didn't change.
const PRESIGNED_S3_URL_PATTERN =
  /(https?:\/\/[^\s)<>"'\]]*?\.amazonaws\.com[^\s)<>"'\]?]*)\?[^\s)<>"'\]]*X-Amz-Signature=[^\s)<>"'\]]*/gi;

function stripPresignedS3Params(markdown) {
  return markdown.replace(PRESIGNED_S3_URL_PATTERN, "$1");
}

function buildHeader(url) {
  return [
    "<!--",
    `  Source: ${url}`,
    "  This file is generated from Notion. Do not edit directly - it will be overwritten.",
    "-->",
    "",
    "",
  ].join("\n");
}

async function exportPage(pageId, title, outputPath) {
  let url = `https://www.notion.so/${pageId.replace(/-/g, "")}`;
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    url = page.url || url;
  } catch (err) {
    console.warn(`  Could not retrieve URL for "${title}" (${pageId}): ${err.message}`);
    stats.errors += 1;
  }

  let body = "";
  try {
    const mdBlocks = await n2m.pageToMarkdown(pageId);
    body = n2m.toMarkdownString(mdBlocks).parent || "";
    body = stripPresignedS3Params(body);
  } catch (err) {
    console.warn(`  Could not read content for "${title}" (${pageId}): ${err.message}`);
    stats.errors += 1;
  }

  if (!body.trim()) {
    body = "_No readable content._\n";
    stats.emptyContent += 1;
  }

  const fileContents = buildHeader(url) + body.trim() + "\n";

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, fileContents, "utf8");
  stats.exported += 1;
  console.log(`Exported: ${path.relative(process.cwd(), outputPath)}`);
}

async function walk(pageId, title, ancestorDirs) {
  const slug = slugify(title);

  // Children have to be known before we can decide where this page's own
  // content goes: a page with children owns a folder (content/.../index.md),
  // one without stays a flat sibling file (content/....md).
  let children = [];
  try {
    children = await getChildPages(pageId);
  } catch (err) {
    console.warn(`  Could not list child pages of "${title}" (${pageId}): ${err.message}`);
    stats.errors += 1;
  }

  const hasChildren = children.length > 0;
  const outputPath = hasChildren
    ? path.join(CONTENT_DIR, ...ancestorDirs, slug, "index.md")
    : path.join(CONTENT_DIR, ...ancestorDirs, `${slug}.md`);

  await exportPage(pageId, title, outputPath);

  if (!hasChildren) return;

  const childAncestorDirs = [...ancestorDirs, slug];
  for (const child of children) {
    await walk(child.id, child.title, childAncestorDirs);
  }
}

async function main() {
  console.log(`Starting export from root page ${ROOT_PAGE_ID}...`);

  // Clean rebuild: wipe content/ so pages renamed/deleted/moved in Notion
  // don't leave orphaned files behind from a previous run.
  fs.rmSync(CONTENT_DIR, { recursive: true, force: true });
  fs.mkdirSync(CONTENT_DIR, { recursive: true });

  let rootTitle = "Index";
  try {
    const rootPage = await notion.pages.retrieve({ page_id: ROOT_PAGE_ID });
    rootTitle = getPageTitle(rootPage);
  } catch (err) {
    console.warn(`Could not retrieve root page title, defaulting to "Index": ${err.message}`);
    stats.errors += 1;
  }

  // The root page's own content is written to content/index.md. Its
  // children start directly under content/ (not nested in a root folder),
  // so e.g. a top-level "Product A" page becomes content/product-a.md,
  // and its own children become content/product-a/<slug>.md.
  await exportPage(ROOT_PAGE_ID, rootTitle, path.join(CONTENT_DIR, "index.md"));

  const topLevelChildren = await getChildPages(ROOT_PAGE_ID);
  for (const child of topLevelChildren) {
    await walk(child.id, child.title, []);
  }

  console.log("\nExport complete.");
  console.log(`  Pages exported: ${stats.exported}`);
  console.log(`  Pages with no readable content: ${stats.emptyContent}`);
  console.log(`  Errors encountered: ${stats.errors}`);
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
