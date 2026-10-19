/**
 * A fixture-backed store and query client for tests that mount an onboarding
 * screen: its saves run through the store (src/data/optimistic-save.ts).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { makeSnapshot } from "@/data/__tests__/fixture";
import { createMemoryStore } from "@/data/adapters/memory";
import type { DataStore } from "@/data/store";
import { StoreProvider } from "@/data/store-provider";

export function onboardingStore(submit?: DataStore["onboarding"]["submit"]) {
  const store = createMemoryStore(makeSnapshot());
  if (submit) store.onboarding.submit = submit;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <StoreProvider store={store}>{children}</StoreProvider>
      </QueryClientProvider>
    );
  }
  return { store, client, Wrapper };
}
