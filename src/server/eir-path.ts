import type { EirVolumeConfig } from "./eir-storage";

const PRINCIPAL_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
const SUBMISSION_FILE =
  /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i;

export function isSafePrincipalId(value: string): boolean {
  return PRINCIPAL_ID.test(value);
}

export function parseEirPdfPath(path: string, config: EirVolumeConfig): { owner: string } | null {
  const segments = path.split("/");
  if (
    segments.length !== 7 ||
    segments[0] !== "" ||
    segments[1] !== "Volumes" ||
    segments[2] !== config.catalog ||
    segments[3] !== config.schema ||
    segments[4] !== config.volume
  ) {
    return null;
  }
  const owner = segments[5] ?? "";
  const filename = segments[6] ?? "";
  if (!isSafePrincipalId(owner) || !SUBMISSION_FILE.test(filename)) return null;
  return { owner };
}
