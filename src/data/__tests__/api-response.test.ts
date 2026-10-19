// The browser API client's reading of non-JSON answers (#189): what the
// Databricks Apps proxy sends when a request never reached the app server.
import { describe, expect, it, vi } from "vitest";

import { httpTransport } from "../adapters/delta";
import {
  OUTCOME_UNKNOWN_MESSAGE,
  READ_SESSION_EXPIRED_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
  UNAVAILABLE_MESSAGE,
  apiFailureKind,
} from "../api-response";

const SIGN_IN_PAGE = "<!DOCTYPE html><html><body>Sign in to Databricks</body></html>";
const GATEWAY_PAGE = "<!DOCTYPE html><html><body>502 Bad Gateway</body></html>";
const html = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function client(answer: () => Response | Promise<Response>) {
  return httpTransport(vi.fn(async () => answer()) as unknown as typeof fetch);
}
const command = (answer: () => Response | Promise<Response>) =>
  client(answer).command("teams", "add-owner", {
    idempotencyKey: "k1",
    expectedVersion: 0,
    payload: {},
  });
const read = (answer: () => Response | Promise<Response>) =>
  client(answer).read("teams", "ownership");

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code: string; status: number };
  }
  throw new Error("expected the request to fail");
}

/** Whatever happened, people never see a parse error or the page itself. */
function expectNoRawText(error: Error) {
  expect(error.message).not.toMatch(/Unexpected token|JSON|<!DOCTYPE|<html|\[delta\]/);
}

describe("the API client reads only the app server's JSON (#189)", () => {
  it("treats a sign-in page served as 200 as an expired session: nothing was saved", async () => {
    const error = await failure(command(() => html(SIGN_IN_PAGE, 200)));
    expect(error).toMatchObject({ code: "session-expired", message: SESSION_EXPIRED_MESSAGE });
    expect(apiFailureKind(error)).toBe("session-expired");
    expectNoRawText(error);
  });

  it("recognises a sign-in page even when the proxy doesn't label it as HTML", async () => {
    const error = await failure(command(() => new Response(SIGN_IN_PAGE, { status: 200 })));
    expect(error).toMatchObject({ code: "session-expired" });
  });

  it("treats a 401, HTML or JSON, as an expired session", async () => {
    expect(await failure(command(() => html(SIGN_IN_PAGE, 401)))).toMatchObject({
      code: "session-expired",
      message: SESSION_EXPIRED_MESSAGE,
    });
    expect(
      await failure(
        command(() => json({ error: { code: "unauthenticated", message: "No token." } }, 401)),
      ),
    ).toMatchObject({ code: "session-expired" });
  });

  it("says a read's sign-in expired without claiming anything about saving", async () => {
    const error = await failure(read(() => html(SIGN_IN_PAGE, 200)));
    expect(error).toMatchObject({ code: "session-expired", message: READ_SESSION_EXPIRED_MESSAGE });
  });

  it("treats a gateway's HTML 502 as an unknown outcome for a write", async () => {
    const error = await failure(command(() => html(GATEWAY_PAGE, 502)));
    expect(error).toMatchObject({
      status: 502,
      code: "outcome-unknown",
      message: OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(apiFailureKind(error)).toBe("outcome-unknown");
    expectNoRawText(error);
  });

  it("treats an empty body as an unknown outcome, OK or not", async () => {
    for (const status of [200, 504]) {
      const error = await failure(command(() => new Response("", { status })));
      expect(error).toMatchObject({ code: "outcome-unknown", message: OUTCOME_UNKNOWN_MESSAGE });
    }
  });

  it("treats malformed JSON as an unknown outcome, never a parse error", async () => {
    const error = await failure(
      command(
        () =>
          new Response('{"result": {"owner"', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    expect(error).toMatchObject({ code: "outcome-unknown", message: OUTCOME_UNKNOWN_MESSAGE });
    expectNoRawText(error);
  });

  it("treats a network error as an unknown outcome, never 'Failed to fetch'", async () => {
    const error = await failure(command(() => Promise.reject(new TypeError("Failed to fetch"))));
    expect(error).toMatchObject({ status: 0, code: "outcome-unknown" });
    expect(error.message).not.toMatch(/Failed to fetch/);
  });

  it("says a read that got no answer couldn't reach the app", async () => {
    const error = await failure(read(() => Promise.reject(new TypeError("Failed to fetch"))));
    expect(error).toMatchObject({ code: "unavailable", message: UNAVAILABLE_MESSAGE });
    expect(apiFailureKind(error)).toBe("unavailable");
    expect(await failure(read(() => html(GATEWAY_PAGE, 504)))).toMatchObject({
      code: "unavailable",
    });
  });

  it("keeps the server's own refusal: its code and message for a JSON 409 and 400", async () => {
    const conflict = await failure(
      command(() =>
        json(
          {
            error: {
              code: "version-conflict",
              message: "This changed since you opened it. Reload to see the latest.",
            },
          },
          409,
        ),
      ),
    );
    expect(conflict).toMatchObject({
      status: 409,
      code: "version-conflict",
      message: "This changed since you opened it. Reload to see the latest.",
    });
    expect(apiFailureKind(conflict)).toBe("refused");
    const invalid = await failure(
      command(() =>
        json(
          { error: { code: "duplicate", message: "Drew is already an owner of this dataset." } },
          400,
        ),
      ),
    );
    expect(invalid).toMatchObject({
      status: 400,
      code: "duplicate",
      message: "Drew is already an owner of this dataset.",
    });
    expect(apiFailureKind(invalid)).toBe("refused");
  });

  it("keeps the server's 403 refusal, but a non-JSON 403 is the proxy's sign-in", async () => {
    expect(
      await failure(command(() => json({ error: { code: "not-owner", message: "No." } }, 403))),
    ).toMatchObject({ status: 403, code: "not-owner" });
    expect(await failure(command(() => html(SIGN_IN_PAGE, 403)))).toMatchObject({
      code: "session-expired",
    });
  });

  it("returns the body of an OK JSON answer", async () => {
    expect(await command(() => json({ result: { ok: true } }, 200))).toEqual({
      result: { ok: true },
    });
  });
});
