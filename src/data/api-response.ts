/**
 * The browser's one reading of an app-server answer (#189).
 *
 * Our server always answers JSON. Anything else came from the Databricks Apps
 * proxy in front of it, and usually means the request never reached us: an
 * expired sign-in (its login page, an HTML 200 after a redirect, or a 401) or
 * a gateway failure (an HTML 502/504 page). Parsing that as JSON showed people
 * `Unexpected token '<'` under "That owner was refused" when nothing had been
 * refused. So every answer is classified here before it's parsed:
 *
 * - **Session expired** (`session-expired`): any 401, a non-JSON 403, or an
 *   HTML page where JSON was expected. Nothing was saved; reloading signs in.
 * - **Outcome unknown** (`outcome-unknown`, writes): no answer at all, or one
 *   we can't read (an HTML 5xx, an empty or unparseable body). The write may
 *   have committed, so the retry must resend the same idempotency key.
 * - **Unavailable** (`unavailable`, reads): the same, for a read.
 * - **The server's own answer**: a JSON error keeps its code and message.
 *
 * The messages are the ones people see; raw parse errors and HTML never are.
 */

/** A refusal or failure from the app server, with a code and a message to show. */
export class DeltaApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DeltaApiError";
    this.status = status;
    this.code = code;
  }
}

export const SESSION_EXPIRED_MESSAGE =
  "Your sign-in has expired. Reload the page to sign in again — nothing was saved.";
export const READ_SESSION_EXPIRED_MESSAGE =
  "Your sign-in has expired. Reload the page to sign in again.";
export const OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm this save. Check the list before trying again.";
export const UNAVAILABLE_MESSAGE = "We couldn't reach the app. Try again in a moment.";

/** Whether the request could change something: decides which "no answer" applies. */
export interface ApiRequestKind {
  write: boolean;
}

function sessionExpired({ write }: ApiRequestKind) {
  return new DeltaApiError(
    401,
    "session-expired",
    write ? SESSION_EXPIRED_MESSAGE : READ_SESSION_EXPIRED_MESSAGE,
  );
}

function noAnswer(status: number, { write }: ApiRequestKind) {
  return write
    ? new DeltaApiError(status, "outcome-unknown", OUTCOME_UNKNOWN_MESSAGE)
    : new DeltaApiError(status, "unavailable", UNAVAILABLE_MESSAGE);
}

/** `fetch` itself failed (offline, connection dropped, aborted): no answer at all. */
export function requestFailed(kind: ApiRequestKind): DeltaApiError {
  return noAnswer(0, kind);
}

/**
 * Read a response: its JSON body when it's ours and OK, else a
 * {@link DeltaApiError} saying what happened. `fallback` names the request for
 * a JSON error that carries no message of its own.
 */
export async function readApiResponse<T>(
  response: Response,
  kind: ApiRequestKind,
  fallback: string,
): Promise<T> {
  if (response.status === 401) throw sessionExpired(kind);
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw noAnswer(response.status, kind);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const html = /html/i.test(contentType) || /^\s*</.test(text);
  if (html) {
    // A 5xx page is the gateway's; any other page is the proxy's sign-in.
    if (response.status >= 500) throw noAnswer(response.status, kind);
    throw sessionExpired(kind);
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    if (response.status === 403) throw sessionExpired(kind);
    throw noAnswer(response.status, kind);
  }
  if (body === undefined) {
    if (response.status === 403) throw sessionExpired(kind);
    throw noAnswer(response.status, kind);
  }
  if (!response.ok) {
    const error = (body as { error?: unknown } | null)?.error;
    const detail =
      typeof error === "object" && error ? (error as { code?: unknown; message?: unknown }) : {};
    const message =
      typeof error === "string"
        ? error
        : typeof detail.message === "string"
          ? detail.message
          : undefined;
    const code = typeof detail.code === "string" ? detail.code : undefined;
    // A gateway's own JSON error page tells us no more than its HTML one.
    if (!code && response.status >= 500) throw noAnswer(response.status, kind);
    throw new DeltaApiError(response.status, code ?? "http-error", message ?? fallback);
  }
  return body as T;
}

export type ApiFailureKind =
  "session-expired" | "outcome-unknown" | "unavailable" | "failed" | "refused";

/**
 * What a failed action means for the person, so a screen says "refused" only
 * when the server refused. A server 5xx it named is `failed`; other errors
 * (the memory store's rules, a server 4xx) are refusals.
 */
export function apiFailureKind(error: unknown): ApiFailureKind {
  if (error instanceof TypeError) return "outcome-unknown";
  const maybe = error as { code?: unknown; status?: unknown } | null;
  if (maybe?.code === "session-expired") return "session-expired";
  if (maybe?.code === "unavailable") return "unavailable";
  if (maybe?.code === "outcome-unknown" || [502, 503, 504].includes(Number(maybe?.status))) {
    return "outcome-unknown";
  }
  if (Number(maybe?.status) >= 500) return "failed";
  return "refused";
}
