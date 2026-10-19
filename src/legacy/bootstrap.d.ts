import type { ComponentType } from "react";
import type { LegacyAppData } from "@/data/legacy-bridge";

/**
 * Props the ported App receives from its TS host (src/components/BrokerApp.tsx).
 * `data` is the seam-derived, window.AppData-shaped state (catalog + requests +
 * status timelines), and `submitRequest` routes a new request through the seam
 * mutation. The host only renders App once `data` is ready, so the App never
 * reads window.AppData or falls back to seed state.
 */
export interface LegacyAppProps {
  data?: LegacyAppData;
  submitRequest?: (request: LegacyAppData["requests"][number]) => void;
}

export declare function loadApp(): Promise<ComponentType<LegacyAppProps>>;
