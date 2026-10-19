import { createContext, useContext } from "react";

import type { FeatureMockData } from "@/mock";

export const FeatureMockContext = createContext<FeatureMockData | undefined>(undefined);

export function useFeatureMockData(): FeatureMockData | undefined {
  return useContext(FeatureMockContext);
}
