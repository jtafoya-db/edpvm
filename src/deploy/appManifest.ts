/**
 * A manifest of the staged app source (databricks-app/), and a comparison of
 * the workspace copy against it.
 *
 * Why: a GovCloud `bundle deploy` from Windows Git Bash uploaded the app source
 * without server/_ssr/ssr.mjs and server/_chunks/ssr-renderer.mjs, gitignored
 * build output that `sync.include` is meant to add. serve.mjs only imports
 * server/index.mjs, so it started, and every request then failed in Nitro.
 * scripts/deploy.sh writes this manifest after staging, exports the workspace
 * copy after the upload, and repairs it with `workspace import-dir --overwrite`
 * when anything is missing or differs.
 *
 * Node built-ins only, so `node scripts/app-manifest.ts` runs it directly.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ManifestEntry {
  /** Forward-slash path relative to the app source root. */
  path: string;
  size: number;
  sha256: string;
}

export interface ManifestDiff {
  /** Staged, but absent from the workspace copy. */
  missing: string[];
  /** Present in both with a different size or hash. */
  changed: string[];
  /**
   * Only in the workspace copy. `import-dir --overwrite` never deletes these, so
   * a mismatch here is repaired by deleting the app source dir and re-uploading.
   */
  unexpected: string[];
}

export function buildManifest(root: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const walk = (relative: string[]) => {
    for (const item of readdirSync(join(root, ...relative), { withFileTypes: true })) {
      const parts = [...relative, item.name];
      if (item.isDirectory()) walk(parts);
      else if (item.isFile()) {
        const bytes = readFileSync(join(root, ...parts));
        entries.push({
          path: parts.join("/"),
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  };
  walk([]);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function compareManifest(expected: ManifestEntry[], actual: ManifestEntry[]): ManifestDiff {
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const expectedPaths = new Set(expected.map((entry) => entry.path));
  const missing: string[] = [];
  const changed: string[] = [];
  for (const entry of expected) {
    const found = actualByPath.get(entry.path);
    if (!found) missing.push(entry.path);
    else if (found.size !== entry.size || found.sha256 !== entry.sha256) changed.push(entry.path);
  }
  const unexpected = actual.map((entry) => entry.path).filter((path) => !expectedPaths.has(path));
  return { missing, changed, unexpected };
}

export const manifestDiffIsClean = (diff: ManifestDiff) =>
  diff.missing.length === 0 && diff.changed.length === 0 && diff.unexpected.length === 0;

/**
 * The workspace imports these extensions as notebooks (and export-dir adds or
 * rewrites extensions), so a staged file with one would never verify
 * byte-for-byte. The staged tree must not contain any.
 */
const NOTEBOOK_EXTENSIONS = /\.(py|sql|scala|r|ipynb)$/i;
export const notebookConvertiblePaths = (manifest: ManifestEntry[]) =>
  manifest.map((entry) => entry.path).filter((path) => NOTEBOOK_EXTENSIONS.test(path));

export class ScopeError extends Error {}

/**
 * A path this guard accepts: absolute under /Workspace/, every segment
 * non-empty, not `.` or `..`, with no backslash, `%` (percent-encoding),
 * control character, whitespace other than an inner space, or leading/trailing
 * space. No trailing slash, no `//`. Anything else is rejected, not normalized.
 */
function isCanonicalWorkspacePath(path: string): boolean {
  if (!path.startsWith("/Workspace/")) return false;
  return path
    .slice(1)
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        segment === segment.trim() &&
        // eslint-disable-next-line no-control-regex
        !/[\\%\u0000-\u001f\u007f]|[^\S ]/.test(segment),
    );
}

/**
 * The app source path deploy.sh may delete before re-uploading: exactly
 * `<bundle files path>/databricks-app`, where both are canonical paths inside
 * /Workspace/ (at least two segments below it). Anything else throws, so the
 * delete can never reach outside the bundle's own copy of the app source.
 */
export function scopedAppSourcePath(sourcePath: string, filesPath: string): string {
  const refuse = (why: string): never => {
    throw new ScopeError(
      `refusing to delete ${JSON.stringify(sourcePath)}: ${why} (bundle files path ${JSON.stringify(filesPath)}).`,
    );
  };
  if (!isCanonicalWorkspacePath(filesPath) || filesPath.split("/").length < 4) {
    refuse("the bundle files path isn't a canonical path at least two levels inside /Workspace/");
  }
  if (!isCanonicalWorkspacePath(sourcePath)) refuse("the app source path isn't canonical");
  if (sourcePath !== `${filesPath}/databricks-app`) {
    refuse("it isn't exactly <bundle files path>/databricks-app");
  }
  return sourcePath;
}

export function formatManifestDiff(diff: ManifestDiff): string {
  return [
    ...diff.missing.map((path) => `  missing: ${path}`),
    ...diff.changed.map((path) => `  differs: ${path}`),
    ...diff.unexpected.map((path) => `  extra: ${path}`),
  ].join("\n");
}
