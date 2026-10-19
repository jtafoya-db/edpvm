/**
 * IDs and hashes for the Delta write path (ADR-0007 decisions 2 and 6).
 *
 * - Every row gets a server-generated UUID v4.
 * - Follow-on rows get a UUID v5 derived from the lead action's ID and the
 *   effect's position, so a retry names the same rows.
 * - `command_hash` is the SHA-256 of the command's canonical JSON.
 *
 * Web Crypto only, so this runs on both the node-server and the default build.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True for a lower-case RFC 4122 UUID (any version 1–8). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** A new random UUID v4. */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uuidBytes(uuid: string): Uint8Array {
  const digits = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * RFC 4122 UUID v5: SHA-1 of the namespace UUID's bytes and the name. The
 * write path uses the lead action ID as the namespace and the effect's
 * position as the name.
 */
export async function uuidV5(namespace: string, name: string): Promise<string> {
  if (!isUuid(namespace)) throw new Error(`uuidV5 namespace is not a UUID: ${namespace}`);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  input.set(uuidBytes(namespace), 0);
  input.set(nameBytes, 16);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const h = hex(digest);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The follow-on row ID for one effect of a lead action. */
export function followOnId(leadActionId: string, position: number): Promise<string> {
  return uuidV5(leadActionId, `effect:${position}`);
}

/** Hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(new Uint8Array(digest));
}

/**
 * JSON with object keys sorted at every level, so the same command always
 * hashes the same. `undefined` object members are dropped, as JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, member]) => [key, sortKeys(member)]));
  }
  return value;
}
