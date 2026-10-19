/**
 * The Delta command and read API (issue #76).
 *
 * - `POST /api/commands/<area>/<command>` with
 *   `{ idempotencyKey, expectedVersion, payload }`. Nothing else is accepted
 *   in the body: the actor and their roles come from the server session.
 * - `POST /api/legacy-writes/<area>/<write>` with `{ payload }` only, for
 *   #72's cart-request tables (see `areas/requests.ts`). They have nowhere to
 *   keep an idempotency key or a version, so this envelope refuses both
 *   rather than accept guarantees it can't keep. #96 retires it.
 * - `GET /api/reads/<area>/<read>?…` for an allow-listed read.
 *
 * There is no endpoint that takes SQL. Every statement is built by a
 * registered handler on the server.
 */
import { z } from "zod";

import { IdentityResolutionError } from "../identity";
import { BusyError, DomainError, OutcomeUnknownError } from "./errors.ts";
import { newId as defaultNewId } from "./ids.ts";
import type {
  AppSurface,
  CommandDefinition,
  LegacyWriteDefinition,
  Registry,
  SessionUser,
} from "./registry.ts";
import type { StoreNames } from "./sql-builder.ts";
import { actionWatermark, type SnapshotCache } from "./snapshot-cache.ts";
import type { TransactionRunner } from "./transaction.ts";

export interface DeltaApiDeps {
  registry: Registry;
  runner: TransactionRunner;
  names: StoreNames;
  /** Who's signed in, from the forwarded identity. Throws when nobody is. */
  resolveUser: (request: Request) => Promise<SessionUser>;
  /** The surfaces this app serves (ADR-0008): both today; one each after a split. */
  serves: AppSurface[];
  /** Fail closed unless the authenticated person acknowledged the active notice. */
  requirePrivacyAcknowledgment: (user: SessionUser) => Promise<void>;
  newId?: () => string;
  /** Per-instance full read snapshot. Missing in tests/config means every read uses Delta. */
  snapshotCache?: SnapshotCache;
}

/** The command envelope. `.strict()`: a body naming the actor, or anything else, is refused. */
export const commandBody = z
  .object({
    idempotencyKey: z.string().uuid(),
    expectedVersion: z.number().int().min(0),
    payload: z.unknown(),
  })
  .strict();

/**
 * The legacy write envelope: the payload and nothing else. `.strict()`, so an
 * `idempotencyKey` or `expectedVersion` is refused, not silently ignored.
 */
export const legacyWriteBody = z.object({ payload: z.unknown() }).strict();

const COMMAND_PATH = /^\/api\/commands\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/;
const LEGACY_WRITE_PATH = /^\/api\/legacy-writes\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/;
const READ_PATH = /^\/api\/reads\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/;
const SEEN_HEADER = "x-edp-seen";
const MAX_SEEN_HEADER_BYTES = 4096;
const MAX_SEEN_AREAS = 20;
const MAX_SEEN_VALUE_BYTES = 512;
const AREA_NAME = /^[a-z][a-z0-9-]*$/;

/** True for the paths this API owns. */
export function isDeltaApiPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/commands/") ||
    pathname.startsWith("/api/legacy-writes/") ||
    pathname.startsWith("/api/reads/")
  );
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

/** Map any failure to a response. Unknown errors are logged and hidden. */
export function errorResponse(error: unknown, context: string): Response {
  if (error instanceof DomainError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof BusyError) {
    return json(
      { error: { code: error.code, message: error.message, attempts: error.attempts } },
      error.status,
    );
  }
  if (error instanceof OutcomeUnknownError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof IdentityResolutionError) {
    return json({ error: { code: "unauthenticated", message: error.message } }, error.status);
  }
  if (error instanceof z.ZodError) {
    return json(
      {
        error: {
          code: "invalid-request",
          message: "The request doesn't match what this endpoint accepts.",
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
      400,
    );
  }
  console.error(`[delta-api] ${context} failed:`, error);
  return json(
    { error: { code: "internal", message: "Something went wrong saving or loading this." } },
    500,
  );
}

function notFound(): Response {
  return json({ error: { code: "not-found", message: "No such endpoint." } }, 404);
}

function logDeltaTiming(
  kind: "read" | "command" | "legacy",
  area: string,
  name: string,
  fields: Record<string, unknown>,
): void {
  console.info(
    `[delta-api] ${kind} ${area}/${name} ${Object.entries(fields)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ")}`,
  );
}

function parseSeenWatermarks(raw: string | null): Record<string, string> {
  if (!raw || raw.length > MAX_SEEN_HEADER_BYTES) return {};
  const seen: Record<string, string> = {};
  for (const part of raw.split(",")) {
    if (Object.keys(seen).length >= MAX_SEEN_AREAS) break;
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const area = part.slice(0, index).trim();
    if (!AREA_NAME.test(area)) continue;
    const encoded = part.slice(index + 1).trim();
    if (!encoded || encoded.length > MAX_SEEN_VALUE_BYTES) continue;
    try {
      const marker = decodeURIComponent(encoded);
      if (marker && marker.length <= MAX_SEEN_VALUE_BYTES) seen[area] = marker;
    } catch {
      // Malformed client freshness hints are ignored; authorization never uses them.
    }
  }
  return seen;
}

function commandResponse(
  outcome: Record<string, unknown>,
  watermarks: Record<string, string> = {},
  watermarkPrincipal?: string,
): Record<string, unknown> {
  const { affectedAreas: _affectedAreas, actionWatermarks: _actionWatermarks, ...body } = outcome;
  return Object.keys(watermarks).length ? { ...body, watermarks, watermarkPrincipal } : body;
}

function refreshSnapshotBestEffort(deps: DeltaApiDeps, areas: Iterable<string>): void {
  if (!deps.snapshotCache) return;
  const affected = [...new Set(areas)].sort();
  deps.snapshotCache.invalidateAreas(affected);
}

function writeWatermarksFromOutcome(
  actionWatermarks: Record<string, string[]> | undefined,
): Record<string, string> {
  if (!actionWatermarks) return {};
  const issuedAt = Date.now();
  return Object.fromEntries(
    Object.entries(actionWatermarks)
      .filter(([, actionIds]) => actionIds.length > 0)
      .map(([area, actionIds]) => [area, actionWatermark(area, actionIds[0]!, issuedAt)]),
  );
}

async function bodyOf(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new DomainError("invalid-request", "The request body must be JSON.", 400);
  }
}

async function runCommand(
  definition: CommandDefinition<any, any>,
  request: Request,
  deps: DeltaApiDeps,
  user: SessionUser,
) {
  const started = Date.now();
  const body = commandBody.parse(await bodyOf(request));
  definition.authorize?.(user);
  const payload = definition.payload.parse(body.payload);
  const outcome = await deps.runner.runCommand(definition, {
    user,
    actor: { principalId: user.principalId, display: user.displayName, app: definition.app },
    idempotencyKey: body.idempotencyKey,
    expectedVersion: body.expectedVersion,
    payload,
  });
  const areas = outcome.affectedAreas.length ? outcome.affectedAreas : [definition.area];
  const watermarks = writeWatermarksFromOutcome(outcome.actionWatermarks);
  if (!outcome.replayed && deps.snapshotCache) {
    refreshSnapshotBestEffort(deps, areas);
  }
  logDeltaTiming("command", definition.area, definition.name, {
    elapsedMs: Date.now() - started,
    replayed: outcome.replayed,
    watermarks: Object.keys(watermarks).length,
  });
  return json(
    commandResponse(outcome as unknown as Record<string, unknown>, watermarks, user.principalId),
  );
}

async function runLegacyWrite(
  definition: LegacyWriteDefinition<any, any>,
  request: Request,
  deps: DeltaApiDeps,
  user: SessionUser,
) {
  const started = Date.now();
  const body = legacyWriteBody.parse(await bodyOf(request));
  definition.authorize?.(user);
  const payload = definition.payload.parse(body.payload);
  const actionId = (deps.newId ?? defaultNewId)();
  const result = await definition.run({
    payload,
    user,
    names: deps.names,
    actionId,
    read: deps.runner.reader({ actionId }),
    write: (statement) => deps.runner.standalone(actionId, statement),
  });
  if (deps.snapshotCache) {
    refreshSnapshotBestEffort(deps, [definition.area]);
  }
  logDeltaTiming("legacy", definition.area, definition.name, {
    elapsedMs: Date.now() - started,
    watermarks: 0,
  });
  return json(commandResponse({ actionId, result }));
}

export async function handleDeltaApiRequest(
  request: Request,
  deps: DeltaApiDeps,
): Promise<Response> {
  const { pathname, searchParams } = new URL(request.url);
  const command = COMMAND_PATH.exec(pathname);
  const legacyWrite = LEGACY_WRITE_PATH.exec(pathname);
  const readMatch = READ_PATH.exec(pathname);
  const context = `${request.method} ${pathname}`;

  try {
    const requireEirPrivacyAcknowledgment = async (user: SessionUser) => {
      if (typeof deps.requirePrivacyAcknowledgment !== "function") {
        throw new DomainError(
          "privacy-guard-unavailable",
          "The EIR privacy guard is unavailable.",
          503,
        );
      }
      await deps.requirePrivacyAcknowledgment(user);
    };
    // Each write kind answers only on its own path, with its own envelope.
    const write = command ?? legacyWrite;
    if (write) {
      const definition = deps.registry.findWrite(write[1]!, write[2]!);
      const kind = command ? "command" : "legacy";
      if (!definition || definition.kind !== kind || !deps.serves.includes(definition.app))
        return notFound();
      if (request.method !== "POST")
        return json({ error: { code: "method-not-allowed" } }, 405, { allow: "POST" });
      const user = await deps.resolveUser(request);
      if (definition.area === "eir" && definition.app === "tenant") {
        await requireEirPrivacyAcknowledgment(user);
      }
      return definition.kind === "command"
        ? await runCommand(definition, request, deps, user)
        : await runLegacyWrite(definition, request, deps, user);
    }
    if (readMatch) {
      const definition = deps.registry.findRead(readMatch[1]!, readMatch[2]!);
      if (!definition || !deps.serves.includes(definition.app)) return notFound();
      if (request.method !== "GET")
        return json({ error: { code: "method-not-allowed" } }, 405, { allow: "GET" });
      const user = await deps.resolveUser(request);
      if (definition.area === "eir" && definition.app === "tenant") {
        await requireEirPrivacyAcknowledgment(user);
      }
      definition.authorize?.(user);
      const query = definition.query.parse(Object.fromEntries(searchParams));
      const readId = (deps.newId ?? defaultNewId)();
      const read = deps.runner.reader({ readId });
      const snapshotRun = definition.snapshot;
      const started = Date.now();
      const snapshot = snapshotRun
        ? await deps.snapshotCache?.snapshotForRead(
            definition,
            read,
            deps.names,
            parseSeenWatermarks(request.headers.get(SEEN_HEADER)),
          )
        : undefined;
      if (snapshot) {
        const result = await snapshotRun!({
          query,
          user,
          names: deps.names,
          snapshot,
        });
        logDeltaTiming("read", definition.area, definition.name, {
          source: "snapshot",
          elapsedMs: Date.now() - started,
        });
        return json(result);
      }
      const result = await definition.run({
        query,
        user,
        names: deps.names,
        read,
      });
      logDeltaTiming("read", definition.area, definition.name, {
        source: "delta",
        elapsedMs: Date.now() - started,
      });
      return json(result);
    }
    return notFound();
  } catch (error) {
    return errorResponse(error, context);
  }
}
