export function eirErrorStatus(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** A refusal the server decided (4xx): the same request would be refused again. */
export const isEirReadRefusal = (error: unknown) => {
  const status = eirErrorStatus(error);
  return typeof status === "number" && status >= 400 && status < 500;
};
