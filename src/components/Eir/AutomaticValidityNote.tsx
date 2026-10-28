import { definitionLabel } from "@/data/eir/definition/identity";
import type { EirRecord } from "@/data/eir/types";

/**
 * On a valid EIR the app recorded as valid in automatic approval mode
 * (#204): who recorded it, when, what it rested on, and that automatic
 * validity isn't production-authorized. Nothing for any other EIR.
 */
export function AutomaticValidityNote({
  item,
}: {
  item: Pick<EirRecord, "stage" | "actions" | "personName">;
}) {
  if (item.stage !== "valid" && item.stage !== "expired") return null;
  const decided = [...item.actions].reverse().find((action) => action.kind === "valid");
  const automatic = decided?.automaticValidity;
  if (!decided || !automatic) return null;
  return (
    <div
      role="note"
      aria-label={`Automatic validity for ${item.personName}`}
      style={{
        marginTop: 14,
        padding: "12px 16px",
        borderLeft: "4px solid var(--theme-primary)",
        background: "var(--color-blue-5v)",
        fontSize: "var(--font-size-2xs)",
        display: "grid",
        gap: 6,
      }}
    >
      <div>
        <strong>Recorded valid automatically</strong> by{" "}
        {decided.actorName ?? "EDP Vending Machine"} on {new Date(decided.at).toLocaleDateString()}:
        the pre-check at upload{" "}
        {automatic.outcome === "warning" ? "passed with warnings" : "passed"} on EIR definition{" "}
        {definitionLabel(automatic.definitionVersion)}.
      </div>
      <div style={{ color: "var(--text-muted)" }}>
        Automatic validity isn&apos;t authorized for production use until Safeguards signs off. You
        can still revoke this EIR.
      </div>
    </div>
  );
}
