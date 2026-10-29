import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

type ExternalUrl = { context: string; url: string };

const SOURCE_EXTENSIONS = new Set([".css", ".js", ".jsx", ".ts", ".tsx"]);
const THIS_TEST = resolve("src/routes/-external-font-egress.test.ts");
const INERT_URL_ALLOWLIST = new Set([
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1998/Math/MathML",
  "https://json-schema.org/draft/2020-12/schema",
  "https://developer.mozilla.org/",
]);

function findExternalFontUrls(source: string): ExternalUrl[] {
  const matches: ExternalUrl[] = [];
  const importRanges: Array<[number, number]> = [];
  const importPattern = /@import\s+(?:url\(\s*)?["']?((?:https?:)?\/\/[^"'\s;)]+)/gi;

  for (const match of source.matchAll(importPattern)) {
    matches.push({ context: "@import", url: match[1]! });
    importRanges.push([match.index, match.index + match[0].length]);
  }

  for (const match of source.matchAll(/url\(\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi)) {
    const insideImport = importRanges.some(
      ([start, end]) => match.index >= start && match.index < end,
    );
    if (!insideImport) matches.push({ context: "url()", url: match[1]! });
  }

  const linkPattern = /<link\b[^>]*\bhref\s*=\s*(?:\{\s*)?["']((?:https?:)?\/\/[^"']+)/gi;
  for (const match of source.matchAll(linkPattern)) {
    matches.push({ context: "<link href>", url: match[1]! });
  }

  const headHrefPattern = /\bhref\s*:\s*["']((?:https?:)?\/\/[^"']+)/gi;
  for (const match of source.matchAll(headHrefPattern)) {
    matches.push({ context: "head href", url: match[1]! });
  }

  return matches.filter(({ url }) => !INERT_URL_ALLOWLIST.has(url));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE_EXTENSIONS.has(extname(entry.name)) && resolve(path) !== THIS_TEST ? [path] : [];
  });
}

describe("external font egress", () => {
  it("detects an external stylesheet imported from CSS", () => {
    const source = '@import url("https://fonts.googleapis.com/css2?family=Public+Sans");';

    expect(findExternalFontUrls(source)).toEqual([
      { context: "@import", url: "https://fonts.googleapis.com/css2?family=Public+Sans" },
    ]);
  });

  it("detects an external font file in a CSS url", () => {
    const source = '@font-face { src: url("https://use.typekit.net/example.woff2"); }';

    expect(findExternalFontUrls(source)).toEqual([
      { context: "url()", url: "https://use.typekit.net/example.woff2" },
    ]);
  });

  it("detects an external stylesheet linked from the document head", () => {
    const source = '<link rel="stylesheet" href="https://cdn.example.gov/fonts.css" />';

    expect(findExternalFontUrls(source)).toEqual([
      { context: "<link href>", url: "https://cdn.example.gov/fonts.css" },
    ]);
  });

  it("detects an external stylesheet in a TanStack head-link object", () => {
    const source = '{ rel: "stylesheet", href: "https://fonts.googleapis.com/css2" }';

    expect(findExternalFontUrls(source)).toEqual([
      { context: "head href", url: "https://fonts.googleapis.com/css2" },
    ]);
  });

  it("detects a protocol-relative preconnect in a TanStack head-link object", () => {
    const source = '{ rel: "preconnect", href: "//fonts.gstatic.com" }';

    expect(findExternalFontUrls(source)).toEqual([
      { context: "head href", url: "//fonts.gstatic.com" },
    ]);
  });

  it("detects a protocol-relative stylesheet imported from CSS", () => {
    const source = '@import url("//fonts.example.gov/site.css");';

    expect(findExternalFontUrls(source)).toEqual([
      { context: "@import", url: "//fonts.example.gov/site.css" },
    ]);
  });

  it("detects a protocol-relative font file in a CSS url", () => {
    const source = "@font-face { src: url(//fonts.example.gov/font.woff2); }";

    expect(findExternalFontUrls(source)).toEqual([
      { context: "url()", url: "//fonts.example.gov/font.woff2" },
    ]);
  });

  it("does not reference an external origin from a font-loading context", () => {
    const violations = sourceFiles(resolve("src")).flatMap((path) =>
      findExternalFontUrls(readFileSync(path, "utf8")).map((match) => ({
        ...match,
        path: relative(process.cwd(), path),
      })),
    );

    expect(violations).toEqual([]);
  });
});
