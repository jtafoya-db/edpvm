import React from "react";

type FieldErrorIcon = React.ComponentType<{ name: string; size?: number; color?: string }>;

/** Shared inline error treatment for schema and dataset fields. */
export function FieldError({
  id,
  Icon,
  children,
}: {
  id: string;
  Icon: FieldErrorIcon;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      style={{
        color: "var(--theme-error-dark)",
        fontSize: "var(--font-size-3xs)",
        marginTop: 5,
        display: "flex",
        alignItems: "center",
        gap: 5,
      }}
    >
      <Icon name="error" size={14} color="var(--theme-error-dark)" />
      {children}
    </div>
  );
}

/** DOM id of the input a `datasetIssues` key describes. */
export function datasetInputId(key: string): string {
  if (key === "add") return "datasets-add";
  const [index, part, sub] = key.split(":");
  const n = Number(index) + 1;
  if (part === "owners") return `dataset-${n}-add-owner`;
  const owner = /^owner(\d+)$/.exec(part ?? "");
  if (owner) return `dataset-${n}-owner-${Number(owner[1]) + 1}-${sub}`;
  return `dataset-${n}-${part}`;
}
