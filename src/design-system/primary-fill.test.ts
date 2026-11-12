import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

type Rgb = readonly [number, number, number];

const tokenSheet = readFileSync(
  "src/design-system/uswds-design-system-3f2f32/design-system/uswds/tokens/colors.css",
  "utf8",
);
const lightTokens = new Map(
  [...tokenSheet.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((match) => [
    match[1]!,
    match[2]!.trim(),
  ]),
);

function lightToken(name: string): Rgb {
  const value = lightTokens.get(name);
  if (!value) throw new Error(`Missing light token --${name}`);
  const reference = value.match(/^var\(--([a-z0-9-]+)\)$/);
  if (reference) return lightToken(reference[1]!);
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (!hex) throw new Error(`Unsupported light token --${name}: ${value}`);
  const expanded = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  return [0, 2, 4].map((offset) =>
    Number.parseInt(expanded.slice(offset, offset + 2), 16),
  ) as unknown as Rgb;
}

function luminance(rgb: Rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(foreground: Rgb, background: Rgb) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe("primary token pairs", () => {
  it.each([
    {
      theme: "light",
      textOnFill: lightToken("text-on-fill"),
      primaryFill: lightToken("theme-primary-fill"),
      primary: lightToken("theme-primary"),
      surface: lightToken("surface-default"),
    },
    {
      theme: "provisional dark",
      textOnFill: [255, 255, 255],
      primaryFill: [0, 94, 162],
      primary: [88, 180, 255],
      surface: [45, 46, 47],
    },
  ] satisfies Array<{
    theme: string;
    textOnFill: Rgb;
    primaryFill: Rgb;
    primary: Rgb;
    surface: Rgb;
  }>)("$theme roles each meet WCAG AA", ({ textOnFill, primaryFill, primary, surface }) => {
    expect(contrast(textOnFill, primaryFill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(primary, surface)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("primary fill inventory", () => {
  it("has no live UI fills backed by the primary text role", () => {
    const output = execFileSync(
      "python3",
      ["-I", "docs/research/dark-mode-spike/inventory-tokens.py", "."],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(output).toContain("'live UI': 0");
  });
});
