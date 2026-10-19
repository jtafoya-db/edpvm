// Type shim for the legacy data-access seam (appDataBridge.js; matches the
// bootstrap.d.ts / appData.d.ts pattern). The host (App.jsx) injects the
// window.AppData-shaped app data via setData before screens render, and the
// ported .jsx screens read it via getData() instead of the window.AppData
// global. Runtime is plain JS; this lets .ts/.tsx (the parity test) resolve
// the import. Kept intentionally loose to mirror the untyped seam.
export function setData(data: unknown): void;
export function getData(): unknown;
