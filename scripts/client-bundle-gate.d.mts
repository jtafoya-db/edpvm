export interface ClientBundleScan {
  files: string[];
  longestLine: { file: string; line: number; length: number };
  violations: string[];
  allowlistUses: Array<{ file: string; line: number; length: number; reason: string }>;
}

export const CLIENT_BUNDLE_ALLOWLIST: ReadonlyArray<{
  file: RegExp;
  reason: string;
  line: RegExp;
}>;

export function scanClientBundle(
  clientRoot: string,
  options?: {
    enforceLineLength?: boolean;
    path?: { relative(from: string, to: string): string; sep: string };
  },
): ClientBundleScan;
