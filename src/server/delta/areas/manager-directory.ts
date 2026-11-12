import { z } from "zod";

import type { ManagerDirectory } from "../../../data/manager-directory";
import type { Registry } from "../registry";

export function registerManagerDirectoryArea(
  registry: Registry,
  directory: ManagerDirectory,
): void {
  registry.read({
    area: "eir",
    name: "manager-directory",
    app: "tenant",
    query: z.object({}).strict(),
    // Identity is resolved by the server. There is deliberately no principal query parameter.
    run: ({ user }) => directory.managerOf(user.principalId),
  });
}
