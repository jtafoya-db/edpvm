/**
 * React context that carries the active {@link DataStore} to the Query hooks.
 *
 * Kept separate from the provider component so hooks can import the context
 * without pulling in a component (and so fast-refresh stays happy). The
 * provider lives in store-provider.tsx.
 */
import { createContext, useContext } from "react";
import type { DataStore } from "./store";

export const StoreContext = createContext<DataStore | null>(null);

/** Read the current store from context. Throws outside a StoreProvider. */
export function useStore(): DataStore {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error("useStore must be used within a <StoreProvider>.");
  }
  return store;
}
