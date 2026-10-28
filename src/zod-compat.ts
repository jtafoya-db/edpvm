import { z } from "zod";

/** Zod 4 omits rejected inputs from issues unless a parse explicitly asks for them. */
export const ZOD3_PARSE_OPTIONS = { reportInput: true } as const;

type Issue = z.core.$ZodIssue;

function receivedType(input: unknown, expected: string): string {
  if (input === null) return "null";
  if (typeof input === "number") {
    if (Number.isNaN(input)) return "nan";
    if (expected === "int" && !Number.isInteger(input)) return "float";
    return "number";
  }
  if (Array.isArray(input)) return "array";
  if (input instanceof Date) return "date";
  return typeof input;
}

const quoted = (value: unknown): string => `'${String(value)}'`;

/**
 * Render the Zod 3 default wording for every issue shape produced by this app.
 * Schema-supplied messages do not match Zod 4's default prefixes, so they pass
 * through unchanged.
 */
export function zod3IssueMessage(issue: Issue): string {
  switch (issue.code) {
    case "invalid_type": {
      if (!("input" in issue) || issue.input === undefined) return "Required";
      const expected =
        issue.expected === "int"
          ? "integer"
          : issue.expected === "record"
            ? "object"
            : issue.expected;
      return `Expected ${expected}, received ${receivedType(issue.input, issue.expected)}`;
    }
    case "too_small": {
      if (!issue.message.startsWith("Too small: expected")) return issue.message;
      const minimum = String(issue.minimum);
      if (issue.origin === "number") {
        return issue.inclusive
          ? `Number must be greater than or equal to ${minimum}`
          : `Number must be greater than ${minimum}`;
      }
      if (issue.origin === "string") {
        return issue.exact
          ? `String must contain exactly ${minimum} character(s)`
          : `String must contain at least ${minimum} character(s)`;
      }
      if (issue.origin === "array") {
        return issue.exact
          ? `Array must contain exactly ${minimum} element(s)`
          : `Array must contain at least ${minimum} element(s)`;
      }
      return issue.message;
    }
    case "too_big": {
      if (!issue.message.startsWith("Too big: expected")) return issue.message;
      const maximum = String(issue.maximum);
      if (issue.origin === "number") {
        return issue.inclusive
          ? `Number must be less than or equal to ${maximum}`
          : `Number must be less than ${maximum}`;
      }
      if (issue.origin === "string") {
        return issue.exact
          ? `String must contain exactly ${maximum} character(s)`
          : `String must contain at most ${maximum} character(s)`;
      }
      if (issue.origin === "array") {
        return issue.exact
          ? `Array must contain exactly ${maximum} element(s)`
          : `Array must contain at most ${maximum} element(s)`;
      }
      return issue.message;
    }
    case "invalid_value": {
      if (
        !issue.message.startsWith("Invalid option:") &&
        !issue.message.startsWith("Invalid input:")
      ) {
        return issue.message;
      }
      // Zod 4 combines literal and enum failures. The repository's surfaced
      // invalid_value issues are enums; this is also the closest faithful copy
      // when Zod no longer exposes which schema kind produced the issue.
      const expected = issue.values.map(quoted).join(" | ");
      if (typeof issue.input !== "string") {
        return `Expected ${expected}, received ${receivedType(issue.input, "")}`;
      }
      return `Invalid enum value. Expected ${expected}, received ${quoted(issue.input)}`;
    }
    case "unrecognized_keys":
      return `Unrecognized key(s) in object: ${issue.keys.map(quoted).join(", ")}`;
    case "invalid_format": {
      if (issue.format === "uuid" || issue.format === "guid") return "Invalid uuid";
      if (issue.format === "date") return "Invalid date";
      if (issue.format === "email") return "Invalid email";
      if (issue.format === "regex" && issue.message.startsWith("Invalid string:")) return "Invalid";
      return issue.message;
    }
    default:
      return issue.message;
  }
}
