import { z } from "zod";

import type { LoadedAccessMatrix } from "../../access-matrix.ts";
import { requireEdpStaff, type Registry } from "../registry.ts";

export function registerConfigurationArea(
  registry: Registry,
  load: () => LoadedAccessMatrix,
): void {
  let loggedDigest: string | undefined;
  registry.read({
    area: "configuration",
    name: "access-matrix-status",
    app: "staff",
    query: z.object({}).strict(),
    authorize: requireEdpStaff,
    async run() {
      const { source, approvalStatus, digest } = load();
      if (loggedDigest !== digest) {
        console.info(
          `[access-matrix] loaded source=${source} approvalStatus=${approvalStatus} digest=${digest}`,
        );
        loggedDigest = digest;
      }
      return { source, approvalStatus, digest };
    },
  });
}
