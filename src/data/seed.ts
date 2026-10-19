/**
 * Reads the prototype seed the P1 in-memory adapter is built from.
 *
 * The legacy module src/legacy/appData.js publishes the prototype data on
 * `window.AppData` as an import side effect (loaded by the app bootstrap
 * before any screen renders). This helper snapshots that global into a typed
 * {@link AppDataSnapshot}. Keeping the read behind one function means the seam
 * never reaches into `window` directly, and tests can supply their own
 * snapshot instead.
 */
import type { AppDataSnapshot } from "./types";

declare global {
  interface Window {
    AppData?: AppDataSnapshot;
  }
}

/** Read the seed published on `window.AppData`. Throws if it is not loaded. */
export function readAppDataSeed(): AppDataSnapshot {
  const data = typeof window !== "undefined" ? window.AppData : undefined;
  if (!data) {
    throw new Error(
      "window.AppData is not loaded — the legacy prototype data " +
        "(src/legacy/appData.js) must be imported before the store is created.",
    );
  }
  return data;
}
