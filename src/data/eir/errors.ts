import { EIR_CHANGED_REFUSAL as CHANGED_REFUSAL } from "./repository";

export function eirErrorStatus(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** A refusal the server decided (4xx): the same request would be refused again. */
export const isEirReadRefusal = (error: unknown) => {
  const status = eirErrorStatus(error);
  return typeof status === "number" && status >= 400 && status < 500;
};

/** What the EIR screen says instead: a reload replaces the answers on screen. */
export const EIR_CHANGED_RELOAD = `${CHANGED_REFUSAL} Reloading discards any changes on this screen that aren't saved.`;

/** Refused because the EIR moved on since the screen read it (409): only a reload helps. */
export const isEirChangedRefusal = (error: unknown) =>
  eirErrorStatus(error) === 409 &&
  ((error as { code?: unknown }).code === "version-conflict" ||
    (error as { message?: unknown }).message === CHANGED_REFUSAL ||
    (error as { message?: unknown }).message === EIR_CHANGED_RELOAD);

/** An EIR save's refusal as the screen shows it: an out-of-date one says what a reload costs. */
export function withReloadWarning(error: unknown): unknown {
  if (!isEirChangedRefusal(error)) return error;
  return Object.assign(new Error(EIR_CHANGED_RELOAD), {
    name: (error as Error).name,
    status: 409,
    code: "version-conflict",
  });
}
