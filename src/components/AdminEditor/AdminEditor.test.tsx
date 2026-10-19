import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdminEditor } from "./index";
import { loadSchema, type IntakeSchema, type SchemaSaveResult } from "../../schema";

afterEach(cleanup);

const base = loadSchema();
// vitest runs from the project root; resolve the repo config from there.
const CONFIG_PATH = join(process.cwd(), "src/schema/intake.config.json");

/** Render the editor, capturing the most recent Save result via onSaved. */
function renderEditor() {
  const captured: { result: SchemaSaveResult | null } = { result: null };
  render(
    <AdminEditor
      onSaved={(r) => {
        captured.result = r;
      }}
    />,
  );
  return captured;
}

const tab = (name: RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const save = () => fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const FIELD_TYPES = new Set([
  "text",
  "textarea",
  "select",
  "number",
  "card-select",
  "multi-card",
  "dataset-list",
  "initiative-owner",
]);

/** Real structural + enum validation of an emitted config (beyond a TS cast). */
function assertValidSchema(parsed: IntakeSchema) {
  expect(typeof parsed.version).toBe("number");
  expect(Array.isArray(parsed.steps)).toBe(true);
  for (const s of parsed.steps) {
    expect(typeof s.id).toBe("string");
    expect(typeof s.label).toBe("string");
    expect(typeof s.title).toBe("string");
  }
  expect(Array.isArray(parsed.fields)).toBe(true);
  const stepIds = new Set(parsed.steps.map((s) => s.id));
  for (const f of parsed.fields) {
    expect(typeof f.id).toBe("string");
    expect(FIELD_TYPES.has(f.type)).toBe(true);
    expect(typeof f.required).toBe("boolean");
    expect(stepIds.has(f.step)).toBe(true); // every field belongs to a real step
  }
  for (const key of ["engModels", "ingestPatterns", "accessPatterns", "source"] as const) {
    expect(Array.isArray(parsed.optionLists[key])).toBe(true);
    for (const o of parsed.optionLists[key]) {
      expect(typeof o.id).toBe("string");
      expect(typeof o.name).toBe("string");
      expect(typeof o.approved).toBe("boolean");
    }
  }
  expect(Array.isArray(parsed.optionLists.roiLevers)).toBe(true);
  for (const g of ["freqFactor", "cplxFactor"] as const) {
    for (const v of Object.values(parsed.sizing[g])) expect(typeof v).toBe("number");
  }
  expect(typeof parsed.request.idPrefix).toBe("string");
}

describe("AdminEditor — option-list edits", () => {
  it("introduces option-list sections at level two below the Admin page heading", () => {
    renderEditor();
    expect(screen.getByRole("heading", { name: "Source systems", level: 2 })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "ROI levers (mission value)", level: 2 }),
    ).toBeTruthy();
  });

  it("edits an ingest-pattern name in-app and the emitted diff reflects it", () => {
    const cap = renderEditor();
    fireEvent.change(screen.getByLabelText(/name for ingestPatterns option eftu/i), {
      target: { value: "EFTU (renamed)" },
    });
    save();

    const res = cap.result;
    expect(res).not.toBeNull();
    expect(res!.changed).toBe(true);
    expect(res!.diff).toContain('+        "name": "EFTU (renamed)"');
    const parsed = JSON.parse(res!.config) as IntakeSchema;
    expect(parsed.optionLists.ingestPatterns.find((o) => o.id === "eftu")?.name).toBe(
      "EFTU (renamed)",
    );
  });

  it("adds an ingest pattern — a JSON addition that round-trips to a valid schema", () => {
    const cap = renderEditor();
    // Blocks render in order: source, ingest, access, ENG — so the ingest
    // "Add option" button is index 1.
    fireEvent.click(screen.getAllByRole("button", { name: /add option/i })[1]!);
    save();

    const res = cap.result!;
    expect(res.diff).toContain("new-ingestPatterns-1");
    // round-trips: the emitted full config parses back to a valid schema that
    // contains the new option and keeps every other section intact.
    const parsed = JSON.parse(res.config) as IntakeSchema;
    expect(parsed.optionLists.ingestPatterns).toHaveLength(
      base.optionLists.ingestPatterns.length + 1,
    );
    expect(parsed.optionLists.ingestPatterns.some((o) => o.id === "new-ingestPatterns-1")).toBe(
      true,
    );
    // real structural/enum validation, not just a TS cast
    assertValidSchema(parsed);
    expect(parsed.version).toBe(base.version);
  });

  it("edits a source-system option end-to-end (edit -> in-app state -> diff)", () => {
    const cap = renderEditor();
    // Source systems is the first option-list block; rename the IMF entry.
    fireEvent.change(screen.getByLabelText(/name for source option imf/i), {
      target: { value: "IMF (curated master file)" },
    });
    save();

    const res = cap.result!;
    expect(res.changed).toBe(true);
    expect(res.diff).toContain('+        "name": "IMF (curated master file)"');
    const parsed = JSON.parse(res.config) as IntakeSchema;
    expect(parsed.optionLists.source.find((o) => o.id === "imf")?.name).toBe(
      "IMF (curated master file)",
    );
    assertValidSchema(parsed);
  });

  it("adds a source system that round-trips to a valid schema", () => {
    const cap = renderEditor();
    // Source systems block is first, so its "Add option" button is index 0.
    fireEvent.click(screen.getAllByRole("button", { name: /add option/i })[0]!);
    save();

    const parsed = JSON.parse(cap.result!.config) as IntakeSchema;
    expect(parsed.optionLists.source.some((o) => o.id === "new-source-1")).toBe(true);
    assertValidSchema(parsed);
  });

  it("edits access, ENG and ROI lists through the UI (diff reflects each)", () => {
    const cap = renderEditor();
    fireEvent.change(screen.getByLabelText(/name for accessPatterns option dbx/i), {
      target: { value: "Databricks-native" },
    });
    fireEvent.change(screen.getByLabelText(/name for engModels option self/i), {
      target: { value: "Self-service build" },
    });
    fireEvent.click(screen.getByLabelText(/platform engineering: self/i)); // toggle platform on
    fireEvent.change(screen.getByLabelText(/name for ROI lever fraud/i), {
      target: { value: "Cut improper payments" },
    });
    save();

    const parsed = JSON.parse(cap.result!.config) as IntakeSchema;
    expect(parsed.optionLists.accessPatterns.find((o) => o.id === "dbx")?.name).toBe(
      "Databricks-native",
    );
    expect(parsed.optionLists.engModels.find((o) => o.id === "self")?.name).toBe(
      "Self-service build",
    );
    expect(parsed.optionLists.engModels.find((o) => o.id === "self")?.platform).toBe(true);
    expect(parsed.optionLists.roiLevers.find((o) => o.id === "fraud")?.name).toBe(
      "Cut improper payments",
    );
    assertValidSchema(parsed);
  });
});

describe("AdminEditor — field label / required edits + live preview", () => {
  it("edits a field label and the SchemaForm preview renders the new label", () => {
    renderEditor();
    tab(/^fields$/i);
    fireEvent.change(screen.getByLabelText(/label for field sourceSystem/i), {
      target: { value: "Accountable owner" },
    });
    // switch to the live preview (step 0 = source, where `sourceSystem` lives)
    tab(/live preview/i);
    // SchemaForm renders the field with its (edited) label as the input aria-label
    expect(screen.getByLabelText(/accountable owner/i)).toBeTruthy();
  });

  it("toggles a required flag and the emitted diff reflects it", () => {
    const cap = renderEditor();
    tab(/^fields$/i);
    fireEvent.click(screen.getByLabelText(/required: field dataName/i));
    save();
    expect(cap.result!.diff).toContain('+      "required": false');
  });
});

describe("AdminEditor — sizing coefficient edits", () => {
  it("edits a sizing coefficient in-app and the diff + config reflect it", () => {
    const cap = renderEditor();
    tab(/sizing coefficients/i);
    fireEvent.change(screen.getByLabelText(/coefficient freqFactor Daily/i), {
      target: { value: "2" },
    });
    save();

    const res = cap.result!;
    expect(res.diff).toContain('+      "Daily": 2');
    const parsed = JSON.parse(res.config) as IntakeSchema;
    expect(parsed.sizing.freqFactor["Daily"]).toBe(2);
  });
});

describe("AdminEditor — no runtime write", () => {
  it("does not write the repo config file on Save (repo-backed, PR-only)", () => {
    const beforeFile = readFileSync(CONFIG_PATH, "utf8");
    const cap = renderEditor();
    fireEvent.change(screen.getByLabelText(/name for ingestPatterns option eftu/i), {
      target: { value: "Changed at runtime" },
    });
    save();
    const afterFile = readFileSync(CONFIG_PATH, "utf8");

    // Save emitted a diff (the change is real) but the on-disk config is byte
    // identical — the editor never writes to the repo/prod at runtime.
    expect(cap.result!.changed).toBe(true);
    expect(afterFile).toBe(beforeFile);
  });
});

describe("AdminEditor — save handler seam", () => {
  it("routes Save through the injected handler, not a hardcoded file path", () => {
    const handler = vi.fn((_original: IntakeSchema, _edited: IntakeSchema): SchemaSaveResult => ({
      schema: base,
      config: "{}",
      diff: "custom",
      changed: true,
      path: "delta://intake",
    }));
    render(<AdminEditor saveHandler={handler} />);
    save();
    expect(handler).toHaveBeenCalledTimes(1);
    // called with (original, edited) — both full schemas
    const [original, edited] = handler.mock.calls[0]!;
    expect(original.version).toBe(base.version);
    expect(edited.version).toBe(base.version);
  });

  it("disables Save changes while an async save handler is pending", async () => {
    const gate = deferred<SchemaSaveResult>();
    const handler = vi.fn(() => gate.promise);
    render(<AdminEditor saveHandler={handler} />);

    fireEvent.click(screen.getByRole("button", { name: /Save changes/ }));

    expect(
      ((await screen.findByRole("button", { name: "Saving…" })) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    expect(handler).toHaveBeenCalledTimes(1);

    gate.resolve({
      schema: base,
      config: "{}",
      diff: "custom",
      changed: true,
      path: "delta://intake",
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /Save changes/ }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.getByLabelText("Config diff").textContent).toContain("custom");
  });
});
