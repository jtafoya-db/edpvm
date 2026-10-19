/**
 * The EIR repository over the server's Delta API (#126). Fetch only: no SQL,
 * no actor, no credentials.
 *
 * - Reads: `eir/mine` (the session's own EIR), `eir/record` and `eir/inbox`
 *   (safeguards validators).
 * - Writes are commands (`eir/start`, `eir/submit`, `eir/save-draft`, `eir/decide`) with
 *   the version the screen read. One idempotency key per intent: a retry of
 *   the same change after a dropped connection resends the same key, so the
 *   server replays it rather than writing it twice.
 * - A signed PDF is uploaded first (`POST /api/eir/uploads`), once per file:
 *   a retry submits the same upload. The server reads the file back to hash
 *   it; the browser never says what the hash is.
 */
import type { DeltaApiTransport } from "../adapters/delta";
import { readApiResponse, requestFailed } from "../api-response";
import { EIR_FORM, EIR_FORM_UNAVAILABLE } from "./config";
import { answerIdsOn, eirFormFor } from "./form";
import { isEirReadRefusal } from "./errors";
import { blockingGuidance } from "./evaluation";
import type { EirFileSubmission, EirRepository, EirResponseInput } from "./repository";
import type { EirDecision, EirFormValues, EirInboxItem, EirRecord } from "./types";
import type { EirEvaluation } from "./types";
import { definitionLabel } from "./definition/identity";

export interface EirUpload {
  volumePath: string;
}

export interface DeltaEirRepositoryOptions {
  transport: DeltaApiTransport;
  /** Store a signed PDF in the caller's own folder of the EIR volume. */
  upload?: (file: File) => Promise<EirUpload>;
  newKey?: () => string;
}

/** The real upload: multipart to the app server, which writes it as the app's service principal. */
export async function uploadEirPdf(file: File, request: typeof fetch = fetch): Promise<EirUpload> {
  const body = new FormData();
  body.set("file", file);
  const kind = { write: true };
  let response: Response;
  try {
    response = await request("/api/eir/uploads", { method: "POST", body });
  } catch {
    throw requestFailed(kind);
  }
  const payload = await readApiResponse<Partial<EirUpload>>(
    response,
    kind,
    `The PDF upload failed (${response.status}).`,
  );
  if (!payload.volumePath) throw new Error(`The PDF upload failed (${response.status}).`);
  return { volumePath: payload.volumePath };
}

export function createDeltaEirRepository(options: DeltaEirRepositoryOptions): EirRepository {
  const { transport } = options;
  const upload = options.upload ?? ((file: File) => uploadEirPdf(file));
  const newKey = options.newKey ?? (() => globalThis.crypto.randomUUID());
  const keys = new Map<string, string>();
  // Per file: its upload and the version its first attempt was based on, so
  // a retry is the same intent (same payload, same key), never a new one.
  const attempts = new WeakMap<File, EirUpload & { version?: number }>();

  async function command(
    name: string,
    payload: unknown,
    expectedVersion: number,
  ): Promise<EirRecord> {
    const intent = JSON.stringify([name, payload, expectedVersion]);
    const idempotencyKey = keys.get(intent) ?? newKey();
    keys.set(intent, idempotencyKey);
    try {
      const response = await transport.command<{ result: EirRecord }>("eir", name, {
        idempotencyKey,
        expectedVersion,
        payload,
      });
      keys.delete(intent);
      return response.result;
    } catch (error) {
      // A refusal is final for this key; anything else (offline, 503) may
      // have committed, so the retry must send the same key.
      if (isEirReadRefusal(error)) keys.delete(intent);
      throw error;
    }
  }

  const mine = () => transport.read<EirRecord>("eir", "mine");
  const recordOf = (principalId: string) =>
    transport.read<EirRecord>("eir", "record", { principalId });

  return {
    async get(principalId) {
      const own = await mine();
      return own.principalId === principalId || !principalId ? own : recordOf(principalId);
    },
    listValidatorInbox: () => transport.read<EirInboxItem[]>("eir", "inbox"),
    async start() {
      return command("start", {}, 0);
    },
    async saveDraft(_principalId, values: EirFormValues, expectedDraftVersion, formVersion) {
      const version = expectedDraftVersion ?? (await mine()).draftVersion ?? 0;
      return command(
        "save-draft",
        { formVersion: formVersion ?? EIR_FORM.version, values },
        version,
      );
    },
    async evaluateDraft() {
      const current = await mine();
      const version = current.draftVersion ?? 0;
      const intent = JSON.stringify(["evaluate", {}, version]);
      const idempotencyKey = keys.get(intent) ?? newKey();
      keys.set(intent, idempotencyKey);
      try {
        const response = await transport.command<{ result: EirEvaluation }>("eir", "evaluate", {
          idempotencyKey,
          expectedVersion: version,
          payload: {},
        });
        keys.delete(intent);
        return response.result;
      } catch (error) {
        if (isEirReadRefusal(error)) {
          keys.delete(intent);
          throw error;
        }
        const detail = error as { status?: unknown; code?: unknown } | null;
        throw Object.assign(
          new Error(
            "Your draft was saved, but the pre-check couldn't be confirmed. Try again; retrying is safe.",
            { cause: error },
          ),
          {
            draftWasSaved: true,
            ...(typeof detail?.status === "number" ? { status: detail.status } : {}),
            ...(typeof detail?.code === "string" ? { code: detail.code } : {}),
          },
        );
      }
    },
    async generatePdf() {
      const response = await transport.read<{ bytes: string }>("eir", "generated-pdf");
      const binary = atob(response.bytes);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    },
    async submitWithFile(input: EirFileSubmission) {
      const prior = attempts.get(input.file);
      let current: EirRecord | undefined;
      if (!prior) {
        if (EIR_FORM_UNAVAILABLE) {
          throw new Error("The EIR form is temporarily unavailable. Nothing has been saved.");
        }
        // The form the screen showed, when this app knows it (a published one once read, #201).
        const shown = eirFormFor(input.formVersion ?? EIR_FORM.version);
        const fields = shown ? answerIdsOn(shown) : undefined;
        const unknownField = fields && Object.keys(input.values).find((f) => !fields.includes(f));
        if (unknownField) {
          throw new Error(
            `${unknownField} isn't on the EIR form for ${definitionLabel(shown?.version ?? "")}.`,
          );
        }
        current = await mine();
        if (
          !current.draftVersion ||
          !current.evaluation ||
          current.evaluation.evaluatedDraftVersion !== current.draftVersion
        ) {
          throw Object.assign(
            new Error("Evaluate the current saved draft before uploading its PDF."),
            { status: 409, code: "evaluation-required" },
          );
        }
        if (current.evaluation.outcome === "blocking") {
          throw Object.assign(
            new Error(
              `Correct the blocking EIR fields before uploading its PDF. ${blockingGuidance(current.evaluation.outcomes)}`,
            ),
            { status: 409, code: "evaluation-blocking" },
          );
        }
        const evaluated = current.draftValues;
        if (
          !evaluated ||
          (fields ?? [...new Set([...Object.keys(evaluated), ...Object.keys(input.values)])]).some(
            (field) => (evaluated[field] ?? "") !== (input.values[field] ?? ""),
          )
        ) {
          throw Object.assign(new Error("The uploaded PDF must use the evaluated draft answers."), {
            status: 409,
            code: "evaluation-mismatch",
          });
        }
      }
      const uploaded = prior ?? (await upload(input.file));
      const version = prior?.version ?? input.expectedVersion ?? current?.version ?? 0;
      const attempt = { volumePath: uploaded.volumePath, version };
      attempts.set(input.file, attempt);
      try {
        const saved = await command(
          "submit",
          {
            volumePath: attempt.volumePath,
            formVersion: input.formVersion ?? EIR_FORM.version,
            values: input.values,
            ...(input.response ? { response: input.response } : {}),
          },
          attempt.version,
        );
        attempts.delete(input.file);
        return saved;
      } catch (error) {
        // Refused: the next try is a new intent on the latest version, with the same upload.
        if (isEirReadRefusal(error)) attempts.set(input.file, { volumePath: attempt.volumePath });
        throw error;
      }
    },
    async respond(input: EirResponseInput) {
      const version = input.expectedVersion ?? (await mine()).version ?? 0;
      // The server checks the answers against the signed submission; no form version is sent.
      return command("respond", { values: input.values, response: input.response }, version);
    },
    async decide(principalId, decision: EirDecision, _actor, note, _actorName, expectedVersion) {
      const version = expectedVersion ?? (await recordOf(principalId)).version ?? 0;
      return command(
        "decide",
        { principalId, decision, ...(note?.trim() ? { note } : {}) },
        version,
      );
    },
  };
}
