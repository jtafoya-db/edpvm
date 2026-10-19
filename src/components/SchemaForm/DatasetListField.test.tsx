/**
 * Each dataset and owner row keeps its own identity when the field's value
 * changes from outside (#103): an owner's picker keeps what was typed for
 * Someone else, so that memory must follow its own row, never a position.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { IntakeDatasetInput } from "../../schema";
import { DatasetListField } from "./DatasetListField";

afterEach(cleanup);

const ME = { name: "Pat Provider", email: "pat.provider@example.test" };
const dataset = (name: string): IntakeDatasetInput => ({
  name,
  domain: "individual-filing",
  datasetTag: name.toLowerCase(),
  owners: [{ name: "", email: "" }],
});

/** The field over its own state, with outside changes to that state as buttons. */
function Harness() {
  const [value, setValue] = React.useState([dataset("First"), dataset("Second")]);
  return (
    <>
      <button type="button" onClick={() => setValue((rows) => [...rows].reverse())}>
        Reorder
      </button>
      <button
        type="button"
        onClick={() =>
          setValue((rows) =>
            rows.map((row) => ({ ...row, owners: row.owners.map((owner) => ({ ...owner })) })),
          )
        }
      >
        Copy
      </button>
      <DatasetListField
        label="Datasets"
        value={value}
        domains={[{ value: "individual-filing", label: "Individual Filing" }]}
        onChange={setValue}
        Icon={() => null}
        signedIn={ME}
      />
    </>
  );
}

const owner = (d: number) => screen.getByRole("group", { name: `Dataset ${d} owner 1` });
const datasetName = (d: number) =>
  (screen.getByLabelText(`Dataset ${d} name`) as HTMLInputElement).value;

/** Dataset `d`'s owner typed as Someone else, then switched to Myself: the details are hidden. */
function hideTypedOwner(d: number) {
  fireEvent.click(within(owner(d)).getByRole("radio", { name: /someone else/i }));
  fireEvent.change(within(owner(d)).getByLabelText("Owner's name"), {
    target: { value: "Hidden Person" },
  });
  fireEvent.change(within(owner(d)).getByLabelText("Owner's email"), {
    target: { value: "hidden@example.test" },
  });
  fireEvent.click(within(owner(d)).getByRole("radio", { name: /myself/i }));
}

/** What dataset `d`'s owner shows when switched to Someone else. */
function someoneElse(d: number) {
  fireEvent.click(within(owner(d)).getByRole("radio", { name: /someone else/i }));
  return {
    name: (within(owner(d)).getByLabelText("Owner's name") as HTMLInputElement).value,
    email: (within(owner(d)).getByLabelText("Owner's email") as HTMLInputElement).value,
  };
}

describe("dataset and owner rows keep their own identity", () => {
  it("keeps typed owner details with their own row when the rows are reordered", () => {
    render(<Harness />);
    hideTypedOwner(1);

    fireEvent.click(screen.getByRole("button", { name: "Reorder" }));
    expect([datasetName(1), datasetName(2)]).toEqual(["Second", "First"]);

    expect(someoneElse(1)).toEqual({ name: "", email: "" });
    expect(someoneElse(2)).toEqual({ name: "Hidden Person", email: "hidden@example.test" });
  });

  it("gives fresh copies of the rows fresh owner memory, inheriting nothing", () => {
    render(<Harness />);
    hideTypedOwner(1);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(datasetName(1)).toBe("First");

    expect(someoneElse(1)).toEqual({ name: "", email: "" });
    expect(someoneElse(2)).toEqual({ name: "", email: "" });
  });
});
