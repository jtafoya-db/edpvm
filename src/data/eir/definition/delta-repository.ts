/**
 * The EIR definition repository over the staff app's server (#201). Fetch
 * only: no SQL, no actor, no validation of its own.
 *
 * - Reads: `eir-definitions/history` and `eir-definitions/version`.
 * - Validate and preview: `POST /api/eir-definitions/check`, the server's
 *   definition service.
 * - Publish and activate are commands with the register version the screen
 *   read. One idempotency key per intent: a resend of the same change after a
 *   dropped connection replays it rather than writing it twice.
 */
import type { DeltaApiTransport } from "../../adapters/delta";
import { readApiResponse, requestFailed } from "../../api-response";
import type { EirDefinitionCheck } from "./check";
import type {
  EirDefinitionCommandResult,
  EirDefinitionHistory,
  EirDefinitionRepository,
  EirFormSource,
  EirFormsAnswer,
  PublishedEirDefinition,
} from "./repository";

/** The employee's forms over the tenant app's `eir-definitions/forms` read. */
export function createDeltaEirFormSource(options: { transport: DeltaApiTransport }): EirFormSource {
  return {
    forms: (versions) =>
      options.transport.read<EirFormsAnswer>(
        "eir-definitions",
        "forms",
        versions.length ? { versions: versions.join(",") } : {},
      ),
  };
}

export interface DeltaEirDefinitionRepositoryOptions {
  transport: DeltaApiTransport;
  /** Validate and preview on the server. */
  check?: (sourceYaml: string) => Promise<EirDefinitionCheck>;
  newKey?: () => string;
}

/** The real check: the staff app server's definition service. */
export async function checkEirDefinitionOnServer(
  sourceYaml: string,
  request: typeof fetch = (...args) => fetch(...args),
): Promise<EirDefinitionCheck> {
  const kind = { write: false };
  let response: Response;
  try {
    response = await request("/api/eir-definitions/check", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ sourceYaml }),
    });
  } catch {
    throw requestFailed(kind);
  }
  return readApiResponse<EirDefinitionCheck>(response, kind, "The check didn't run. Try again.");
}

export function createDeltaEirDefinitionRepository(
  options: DeltaEirDefinitionRepositoryOptions,
): EirDefinitionRepository {
  const { transport } = options;
  const check = options.check ?? ((yaml: string) => checkEirDefinitionOnServer(yaml));
  const newKey = options.newKey ?? (() => globalThis.crypto.randomUUID());
  const keys = new Map<string, string>();

  async function command(
    name: "publish" | "activate",
    payload: unknown,
    expectedVersion: number,
    idempotencyKey?: string,
  ): Promise<EirDefinitionCommandResult> {
    const intent = JSON.stringify([name, payload, expectedVersion]);
    const key = idempotencyKey ?? keys.get(intent) ?? newKey();
    keys.set(intent, key);
    try {
      const response = await transport.command<{ result: EirDefinitionCommandResult }>(
        "eir-definitions",
        name,
        { idempotencyKey: key, expectedVersion, payload },
      );
      keys.delete(intent);
      return response.result;
    } catch (error) {
      // A refusal (4xx) is final for this key; anything else may have committed.
      const status = (error as { status?: number }).status;
      if (status !== undefined && status >= 400 && status < 500) keys.delete(intent);
      throw error;
    }
  }

  return {
    history: () => transport.read<EirDefinitionHistory>("eir-definitions", "history"),
    get: (versionNumber) =>
      transport.read<PublishedEirDefinition>("eir-definitions", "version", {
        versionNumber: String(versionNumber),
      }),
    check,
    publish: (input) =>
      command(
        "publish",
        { sourceYaml: input.sourceYaml },
        input.expectedVersion,
        input.idempotencyKey,
      ),
    activate: (input) =>
      command(
        "activate",
        { versionNumber: input.versionNumber },
        input.expectedVersion,
        input.idempotencyKey,
      ),
  };
}
