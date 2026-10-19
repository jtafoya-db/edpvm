export interface EirFileStorageClient {
  write(path: string, bytes: Uint8Array, options?: { overwrite?: boolean }): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  list(path: string): Promise<string[]>;
}

function encodeVolumePath(path: string): string {
  if (!path.startsWith("/")) throw new Error("Unsafe Unity Catalog volume path.");
  const segments = path.slice(1).split("/");
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || /[%?#\\]/.test(segment),
    )
  ) {
    throw new Error("Unsafe Unity Catalog volume path.");
  }
  return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

export interface EirVolumeConfig {
  catalog: string;
  schema: string;
  volume: string;
}

export function eirVolumePath(
  config: EirVolumeConfig,
  principalId: string,
  submissionId: string,
): string {
  const safePrincipal = principalId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `/Volumes/${config.catalog}/${config.schema}/${config.volume}/${safePrincipal}/${submissionId}.pdf`;
}

export function createDatabricksEirFileStorage(input: {
  host: string;
  token: string;
  fetch?: typeof fetch;
}): EirFileStorageClient {
  const request = input.fetch ?? fetch;
  const url = (path: string) =>
    `${input.host.replace(/\/$/, "")}/api/2.0/fs/files${encodeVolumePath(path)}`;
  return {
    async write(path, bytes, options) {
      const parent = path.slice(0, path.lastIndexOf("/"));
      const directoryResponse = await request(
        `${input.host.replace(/\/$/, "")}/api/2.0/fs/directories${encodeVolumePath(parent)}`,
        { method: "PUT", headers: { Authorization: `Bearer ${input.token}` } },
      );
      if (!directoryResponse.ok)
        throw new Error(
          `Unity Catalog volume directory create failed (${directoryResponse.status}).`,
        );
      const response = await request(`${url(path)}?overwrite=${options?.overwrite ?? true}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/octet-stream",
        },
        body: bytes as BodyInit,
      });
      if (!response.ok) throw new Error(`Unity Catalog volume write failed (${response.status}).`);
    },
    async read(path) {
      const response = await request(url(path), {
        headers: { Authorization: `Bearer ${input.token}` },
      });
      if (!response.ok) throw new Error(`Unity Catalog volume read failed (${response.status}).`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async list(path) {
      const paths: string[] = [];
      let pageToken: string | undefined;
      do {
        const suffix = pageToken ? `?page_token=${encodeURIComponent(pageToken)}` : "";
        const response = await request(
          `${input.host.replace(/\/$/, "")}/api/2.0/fs/directories${encodeVolumePath(path)}${suffix}`,
          { headers: { Authorization: `Bearer ${input.token}` } },
        );
        if (response.status === 404) return [];
        if (!response.ok) throw new Error(`Unity Catalog volume list failed (${response.status}).`);
        const payload = (await response.json()) as {
          contents?: Array<{ path: string }>;
          next_page_token?: string;
        };
        paths.push(...(payload.contents ?? []).map((entry) => entry.path));
        pageToken = payload.next_page_token;
      } while (pageToken);
      return paths;
    },
  };
}
