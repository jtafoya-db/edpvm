// Holds the seam-derived app data (see src/data/legacy-bridge.ts) injected by
// the TS host so the ported screens read catalog/status through the DataStore +
// TanStack Query instead of the window.AppData global. App.jsx sets it at the
// top of each render (from its `data` prop); screens read it via getData().
let current = null;

export function setData(data) {
  current = data;
}

export function getData() {
  if (!current) {
    throw new Error(
      "Legacy app data has not been injected. The host (BrokerApp) must provide " +
        "seam-backed data before any screen renders.",
    );
  }
  return current;
}
