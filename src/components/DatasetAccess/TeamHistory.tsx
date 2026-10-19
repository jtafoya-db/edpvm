// The team page's record of who did what, when (#87).
import type { RoleDescriptions } from "@/data/datasets/role-descriptions";
import type { TeamEvent } from "@/data/datasets/team-store";
import type { Dataset } from "@/data/datasets/types";
import { Timestamp } from "./chrome";
import { actorName } from "./entryText";
import type { DatasetAccessChrome } from "./resolveChrome";
import { TableScroll } from "./teamShared";
import * as s from "./styles";

function describeEvent(event: TeamEvent, roles: RoleDescriptions): string {
  const who = `${event.person.name}${event.person.email ? ` (${event.person.email})` : ""}`;
  switch (event.kind) {
    case "role-changed":
      return `Changed ${who} from ${roles.roles[event.from].label} to ${roles.roles[event.to].label}`;
    case "member-removed":
      return `Removed ${who}'s ${roles.roles[event.role].label} role`;
    case "owner-added":
      return `Made ${who} an owner`;
    case "owner-removed":
      return `Removed ${who} as an owner`;
  }
}

/** Every team-management action on the dataset, with who took it and when. */
export function TeamHistory({
  dataset,
  roles,
  events,
  chrome,
}: {
  dataset: Dataset;
  roles: RoleDescriptions;
  events: TeamEvent[];
  chrome: DatasetAccessChrome;
}) {
  const { Panel, SectionHead } = chrome;
  if (events.length === 0) return null;
  return (
    <div>
      <SectionHead eyebrow="Who did what, when" title="Team history" />
      <Panel pad={0} style={{ overflow: "hidden" }}>
        <TableScroll label="Team history table" minWidth={640}>
          <table style={s.table} aria-label="Team history">
            <thead>
              <tr style={s.headRow}>
                {["When", "Who", "What", "Change list"].map((h) => (
                  <th key={h} style={s.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...events].reverse().map((event, i) => (
                <tr key={`${event.at}:${i}`} style={s.row}>
                  <td style={{ ...s.td, ...s.muted }}>
                    <Timestamp iso={event.at} />
                  </td>
                  <td style={s.td}>{actorName(dataset, event.by)}</td>
                  <td style={s.td}>{describeEvent(event, roles)}</td>
                  <td style={s.td}>
                    {event.entryIds.length > 0 ? event.entryIds.join(", ") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Panel>
    </div>
  );
}
