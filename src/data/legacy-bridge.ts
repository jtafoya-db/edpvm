/**
 * Assembles the object the ported (legacy) screens consume, entirely from the
 * data seam through TanStack Query.
 *
 * The legacy screens historically read a `window.AppData` global (arrays +
 * `sys`/`dom`/`bun`/`ds` lookup helpers). Here we rebuild that same shape from
 * the seam's Query hooks — catalog through `useCatalog`, requests through
 * `useRequests`, the status timelines through the StatusStore (`useStatuses`),
 * stages/my-access/pipeline/user through their hooks — so NO consumer reads the
 * global. `window.AppData` is now referenced only inside seed.ts (to seed the
 * in-memory adapter). The single loading/error state lets the host surface a
 * failing backend instead of masking it with seed data.
 */
import {
  useCatalog,
  useMyAccess,
  usePipeline,
  useRequests,
  useStages,
  useStatuses,
  useUser,
} from "./queries";
import type {
  AccessBundle,
  AppDataSnapshot,
  BusinessDomain,
  DataAsset,
  RequestStatus,
  SourceSystem,
} from "./types";

/** The `window.AppData`-shaped object, sourced from the seam. */
export interface LegacyAppData extends AppDataSnapshot {
  /** StatusStore projections keyed by request id (the status timelines). */
  statuses: Record<string, RequestStatus>;
  sys: (id: string) => SourceSystem | undefined;
  dom: (id: string) => BusinessDomain | undefined;
  bun: (id: string) => AccessBundle | undefined;
  ds: (id: string) => DataAsset | undefined;
}

export interface LegacyAppState {
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  data: LegacyAppData | undefined;
  /** Re-run every query that failed (the host's Retry). */
  retry: () => void;
}

/** Fetch every family the legacy app needs through the seam and assemble it. */
export function useLegacyAppData(): LegacyAppState {
  const catalog = useCatalog();
  const requests = useRequests();
  const statuses = useStatuses();
  const stages = useStages();
  const myAccess = useMyAccess();
  const pipeline = usePipeline();
  const user = useUser();

  const queries = [catalog, requests, statuses, stages, myAccess, pipeline, user];
  const isError = queries.some((q) => q.isError);
  const error = queries.find((q) => q.isError)?.error ?? null;
  const isLoading = queries.some((q) => q.isPending);

  let data: LegacyAppData | undefined;
  if (
    catalog.data &&
    requests.data &&
    statuses.data &&
    stages.data &&
    myAccess.data &&
    pipeline.data &&
    user.data
  ) {
    const { domains, datasets, bundles, systems, personas, tenants } = catalog.data;
    data = {
      user: user.data,
      systems,
      domains,
      bundles,
      datasets,
      requests: requests.data,
      myAccess: myAccess.data,
      onboardingPersonas: personas,
      STAGES: stages.data,
      pipeline: pipeline.data,
      tenants,
      statuses: statuses.data,
      sys: (id) => systems.find((s) => s.id === id),
      dom: (id) => domains.find((d) => d.id === id),
      bun: (id) => bundles.find((b) => b.id === id),
      ds: (id) => datasets.find((d) => d.id === id),
    };
  }

  const retry = () => {
    for (const query of queries) if (query.isError) void query.refetch();
  };

  return { isLoading, isError, error, data, retry };
}
