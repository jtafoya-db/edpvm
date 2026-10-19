import { createRouter } from "@tanstack/react-router";
import { createQueryClient } from "./data/query-policy";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  // The freshness policy (#80): see src/data/query-policy.ts.
  const queryClient = createQueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
