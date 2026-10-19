/**
 * What the Delta API's `initiatives`, `teams` and `change-list` reads and
 * commands send back (#123): the domain types of src/data/datasets and
 * src/data/change-list, plus each record's `ref` (its row ID and version),
 * which the adapter keeps so a write can send the version the screen read.
 * The adapter strips `ref` before anything reaches a screen.
 *
 * Types only: the server (src/server/delta/areas/teams.ts) builds these and
 * the browser adapter (delta-teams.ts) reads them.
 */
import type { ChangeListEntry } from "../change-list/types";
import type {
  Dataset,
  DatasetMember,
  DatasetOwner,
  DatasetWithMemberSummary,
} from "../datasets/types";

export interface RecordRef {
  id: string;
  version: number;
}

export type WireOwner = DatasetOwner & { ref: RecordRef };
export type WireDataset = Omit<Dataset, "owners"> & { owners: WireOwner[]; ref: RecordRef };
export type WireDatasetWithMemberSummary = Omit<DatasetWithMemberSummary, "owners"> & {
  owners: WireOwner[];
  ref: RecordRef;
};
export type WireMember = DatasetMember & { ref: RecordRef };
export type WireEntry = ChangeListEntry & { ref: RecordRef };

/**
 * How the signed-in session stands with one dataset's owners (ADR-0006):
 * `bind` means it's an owner whose email still needs binding before it acts;
 * `mismatch` means its email is bound to another account.
 */
export type OwnershipStatus = "owner" | "bind" | "mismatch" | "none";

export interface MemberChangeWire {
  member: WireMember;
  entries: WireEntry[];
}

export interface MemberRemovedWire {
  removed: WireMember;
  entries: WireEntry[];
}

export interface OwnerChangeWire {
  dataset: WireDataset;
  entries: WireEntry[];
}
