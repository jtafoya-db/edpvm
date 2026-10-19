import { useCallback } from "react";

import { usePrefetchDatasetsScreen } from "@/data/datasets/queries";

interface RouteLike {
  name: string;
  params?: Record<string, unknown>;
}

type PrefetchRoute = (name: string, params?: Record<string, unknown>) => void;

function sameRoute(route: RouteLike, name: string, params: Record<string, unknown>): boolean {
  if (route.name !== name) return false;
  const current = route.params ?? {};
  return (
    (current["id"] ?? null) === (params["id"] ?? null) &&
    (current["q"] ?? null) === (params["q"] ?? null)
  );
}

export function usePrefetchRoute(route: RouteLike): PrefetchRoute {
  const prefetchDatasets = usePrefetchDatasetsScreen();

  return useCallback(
    (name, params = {}) => {
      if (sameRoute(route, name, params)) return;
      if (name === "datasets") prefetchDatasets();
    },
    [prefetchDatasets, route],
  );
}
