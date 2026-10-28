import { describe, expect, it } from "vitest";

import {
  EIR_FORM,
  EIR_FORMS,
  EIR_FORM_1_2,
  LEGACY_EIR_FORMS,
  type EirFormConfig,
  type EirLayoutBlock,
} from "../eir/config";
import {
  EIR_FIELD_IDS,
  EIR_FIELDS,
  answerSections,
  eirFlags,
  oneYearBefore,
  prefilledAnswersOn,
  prefilledEirAnswers,
  validateEirAnswers,
} from "../eir/form";
import { generateEirPdf } from "../eir/pdf";
import type { NameSource } from "../types";
import { EIR_STUB_VALUES, EIR_VALUES } from "./eir-fixtures";

const field = (id: string) => EIR_FIELDS.find((f) => f.id === id)!;

const COMPLIANCE_IDS = [
  "unauthorizedAccessTrainingDate",
  "privacyTrainingDate",
  "cyberAwarenessTrainingDate",
  "irmAcknowledged",
  "ndaSigned",
  "mbiInitialDate",
  "mbiExpirationDate",
  "mbiPreliminary",
];

describe("EIR form 1.3 configuration (the bootstrap definition's form)", () => {
  it("is the bootstrap definition, with the human's sections, sentence-case labels and required answers", () => {
    // Its reserved identity since #224; its answers stored before then say 1.3.
    expect(EIR_FORMS["bootstrap"]?.version).toBe("bootstrap");
    // The current form is the fallback built-in, bootstrap-2 (#217): the same
    // questions and labels, with every rule blocking.
    expect(EIR_FORM.version).toBe("bootstrap-2");
    expect(EIR_FORM.title).toBe("Enterprise Data Platform - Employee Identity Record (EIR)");
    expect(EIR_FORM.intro).not.toMatch(/beta/i);
    expect(
      EIR_FORM.sections.map((s) => [s.title, s.fields.map((f) => [f.label, f.required])]),
    ).toEqual([
      [
        "User details",
        [
          ["User ID", true],
          ["First name", true],
          ["Last name", true],
          ["Work email", true],
          ["Team or project", true],
          ["Sub-team or sub-project", false],
          ["Contracting company", false],
        ],
      ],
      [
        "Your manager",
        [
          ["Manager's first name", true],
          ["Manager's last name", true],
          ["Manager's user ID", true],
          ["Manager's work email", true],
        ],
      ],
      [
        "Compliance",
        [
          ["Unauthorized Access training date", true],
          ["Privacy training date", true],
          ["Cyber Awareness training date", true],
          ["Have you read, acknowledged and signed the IRM 10.5.8 manual transmittal?", true],
          ["Have you agreed to and signed the IRS non-disclosure agreement (NDA)?", true],
          ["MBI or staff-like access start date", true],
          ["MBI or staff-like access expiration date", true],
          [
            "Does your MBI or staff-like access show a preliminary or incomplete background investigation?",
            true,
          ],
        ],
      ],
    ]);
  });

  it("makes Contracting company optional: not everyone is a contractor", () => {
    expect(field("contractingCompany").required).toBe(false);
    expect(validateEirAnswers({ ...EIR_VALUES, contractingCompany: "" })).toEqual([]);
  });

  it("requires every compliance item, meaning answered: each one refused when blank", () => {
    const compliance = EIR_FORM.sections.find((s) => s.id === "compliance")!;
    expect(compliance.fields.map((f) => f.id)).toEqual(COMPLIANCE_IDS);
    for (const id of COMPLIANCE_IDS) {
      expect(field(id).required, id).toBe(true);
      expect(
        validateEirAnswers({ ...EIR_VALUES, [id]: "" }).map((e) => e.field),
        id,
      ).toEqual([id]);
    }
  });

  it("needs an explicit Yes or No: unanswered isn't No, and neither is anything else", () => {
    for (const id of ["irmAcknowledged", "ndaSigned", "mbiPreliminary"]) {
      expect(field(id).kind).toBe("yes-no");
      const [unanswered] = validateEirAnswers({ ...EIR_VALUES, [id]: "" });
      expect(unanswered).toEqual({ field: id, message: `Choose Yes or No: ${field(id).label}` });
      expect(validateEirAnswers({ ...EIR_VALUES, [id]: "unchecked" })).toEqual([
        { field: id, message: `${field(id).label}: choose yes or no.` },
      ]);
      expect(validateEirAnswers({ ...EIR_VALUES, [id]: "no" })).toEqual([]);
      expect(validateEirAnswers({ ...EIR_VALUES, [id]: "yes" })).toEqual([]);
    }
  });

  it("drops 'not always listed' now that the MBI expiration date is required", () => {
    expect(field("mbiExpirationDate").label).not.toMatch(/not always listed/i);
    expect(JSON.stringify(EIR_FORM)).not.toMatch(/[A-Z]{5,}ION/);
  });

  it("follows the 2026-10-06 decisions: no alternative manager, no waiver question, typed manager", () => {
    const labels = EIR_FIELDS.map((f) => f.label).join(" ");
    expect(labels).not.toMatch(/alternative manager|live-data waiver/i);
    expect(EIR_FIELD_IDS).not.toContain("liveDataWaiver");
    expect(EIR_FORM.sections.find((s) => s.id === "manager")?.help).toBe(
      "Your current manager: an IRS full-time employee who can confirm your identity.",
    );
    expect(EIR_FIELDS.filter((f) => f.id.startsWith("manager") && f.prefill)).toEqual([]);
    expect(JSON.stringify(EIR_FORM)).not.toMatch(/Sent by|Triggering event|HRConnect/);
  });

  it("lays out every field exactly once", () => {
    for (const section of EIR_FORM.sections) {
      const placed = (section.layout ?? []).flatMap((block) => block.rows.flat());
      expect(placed.sort(), section.id).toEqual(section.fields.map((f) => f.id).sort());
    }
  });

  it("keeps form 1.2 as it was, for the answers given under it", () => {
    expect(EIR_FORMS["1.2"]).toBe(EIR_FORM_1_2);
    expect(EIR_FORMS["bootstrap-2"]).toBe(EIR_FORM);
    expect(EIR_FORMS["1.3"]).toEqual({ ...EIR_FORMS["bootstrap"]!, version: "1.3" });
    const fields12 = (EIR_FORM_1_2 as EirFormConfig).sections.flatMap((s) => s.fields);
    expect(fields12.find((f) => f.id === "contractingCompany")?.required).toBe(true);
    expect(fields12.filter((f) => COMPLIANCE_IDS.includes(f.id)).map((f) => f.required)).toEqual(
      COMPLIANCE_IDS.map(() => false),
    );
    expect(fields12.find((f) => f.id === "mbiExpirationDate")?.label).toBe(
      "Your contractor MBI / staff-like access expiration date (not always listed)",
    );
    // The same answers under each version: no field added or dropped.
    expect(fields12.map((f) => f.id).sort()).toEqual(EIR_FIELDS.map((f) => f.id).sort());
  });

  it("carries the declaration verbatim with a required attestation", () => {
    expect(EIR_FORM.declaration.text).toBe(
      "I hereby declare that the information submitted is accurate and complete to the best of my knowledge. I understand that any false statement, omission, or misrepresentation may result in disciplinary action and could lead to the suspension or revocation of any access, entitlements, or permissions granted based on this submission.",
    );
    expect(EIR_FORM.declaration.attestation.label).toBe("I agree");
    expect(validateEirAnswers({ ...EIR_VALUES, declarationAgreed: "" })).toEqual([
      { field: "declarationAgreed", message: "Agree to the declaration before you submit." },
    ]);
  });

  it("states the training rule once, as the training dates' group hint", () => {
    const compliance = EIR_FORM.sections.find((s) => s.id === "compliance")!;
    const training = (compliance.layout as readonly EirLayoutBlock[]).find(
      (block) => block.legend === "Training certificates",
    )!;
    expect(training.hint).toBe(EIR_FORM.trainingRule);
    expect(training.rows.flat()).toEqual([
      "unauthorizedAccessTrainingDate",
      "privacyTrainingDate",
      "cyberAwarenessTrainingDate",
    ]);
    for (const id of training.rows.flat()) {
      expect(field(id)).toMatchObject({
        kind: "date",
        rule: "within-timeline:evaluated:years:0:1",
      });
      expect(field(id).help).toBeUndefined();
    }
  });

  it("keeps #98's interim checklist as legacy form 0.1", () => {
    expect(LEGACY_EIR_FORMS["0.1"]?.fields.map((f) => f.id)).toEqual(Object.keys(EIR_STUB_VALUES));
  });
});

describe("EIR form validation (what refuses a submission)", () => {
  it("accepts a complete form, and leaves the optional answers optional", () => {
    expect(validateEirAnswers(EIR_VALUES)).toEqual([]);
    const minimal = Object.fromEntries(
      EIR_FIELDS.map((f) => [f.id, f.required ? EIR_VALUES[f.id]! : ""]),
    );
    expect(validateEirAnswers({ ...minimal, declarationAgreed: "yes" })).toEqual([]);
  });

  it("refuses every missing required answer, in form order", () => {
    const errors = validateEirAnswers({});
    expect(errors.map((e) => e.field)).toEqual([
      ...EIR_FIELDS.filter((f) => f.required).map((f) => f.id),
      "declarationAgreed",
    ]);
  });

  it("refuses malformed emails, IDs, dates and yes/no answers, and unknown answers", () => {
    expect(
      validateEirAnswers({
        ...EIR_VALUES,
        workEmail: "person@",
        managerId: "A-1",
        mbiInitialDate: "15/01/2025",
        ndaSigned: "maybe",
        altManagerId: "X1Y2Z",
      }).map((e) => e.field),
    ).toEqual(["altManagerId", "workEmail", "managerId", "ndaSigned", "mbiInitialDate"]);
  });

  it("never refuses what a compliance answer says (decision 7): a No, an old or future date", () => {
    expect(
      validateEirAnswers({
        ...EIR_VALUES,
        irmAcknowledged: "no",
        ndaSigned: "no",
        mbiPreliminary: "yes",
        unauthorizedAccessTrainingDate: "2001-01-01",
        privacyTrainingDate: "2099-01-01",
        mbiInitialDate: "2099-01-01",
        mbiExpirationDate: "2000-01-01",
      }),
    ).toEqual([]);
  });
});

describe("EIR validator flags", () => {
  const at = { formStartedAt: "2026-10-01T15:00:00.000Z", submittedAt: "2026-10-05T15:00:00.000Z" };
  const flagsOf = (values: Record<string, string>) =>
    eirFlags({ ...EIR_VALUES, ...values }, "1.2", at).map((f) => [f.field, f.text]);

  it("flags nothing in a complete, compliant form", () => {
    expect(flagsOf({})).toEqual([]);
  });

  it("flags each no, and a preliminary background investigation", () => {
    expect(flagsOf({ irmAcknowledged: "no", ndaSigned: "no", mbiPreliminary: "yes" })).toEqual([
      ["irmAcknowledged", "IRM 10.5.8 not acknowledged"],
      ["mbiPreliminary", "Preliminary or incomplete background investigation"],
      ["ndaSigned", "IRS NDA not signed"],
    ]);
    // "No" to a preliminary investigation is the good answer.
    expect(flagsOf({ mbiPreliminary: "no" })).toEqual([]);
  });

  it("applies the training rule from the form's start: a year back, up to the submission", () => {
    const earliest = oneYearBefore("2026-10-01");
    expect(earliest).toBe("2025-10-01");
    expect(flagsOf({ privacyTrainingDate: "2025-10-01" })).toEqual([]);
    expect(flagsOf({ privacyTrainingDate: "2026-10-05" })).toEqual([]);
    expect(flagsOf({ privacyTrainingDate: "2025-09-30" })).toEqual([
      [
        "privacyTrainingDate",
        "More than a year before the form was started: training is yearly, so it should be dated 10/1/2025 or later",
      ],
    ]);
    expect(flagsOf({ privacyTrainingDate: "2026-10-06" })).toEqual([
      ["privacyTrainingDate", "Dated after the form was submitted (10/5/2026)"],
    ]);
    expect(flagsOf({ cyberAwarenessTrainingDate: "" })).toEqual([
      ["cyberAwarenessTrainingDate", "No training date given"],
    ]);
  });

  it("handles a form started on 29 February", () => {
    expect(oneYearBefore("2028-02-29")).toBe("2027-02-28");
  });

  it("flags MBI dates in the future or out of order", () => {
    expect(flagsOf({ mbiInitialDate: "2026-12-01" })).toEqual([
      ["mbiInitialDate", "Dated after the form was submitted (10/5/2026)"],
    ]);
    expect(flagsOf({ mbiInitialDate: "2025-01-15", mbiExpirationDate: "2024-12-31" })).toEqual([
      ["mbiExpirationDate", "Before the contractor MBI / staff-like access initial date"],
    ]);
    expect(flagsOf({ mbiExpirationDate: "" })).toEqual([]);
  });

  it("flags form 1.3 answers by its own labels: a No still submits, and is flagged", () => {
    const flags13 = (values: Record<string, string>) =>
      eirFlags({ ...EIR_VALUES, ...values }, "1.3", at).map((f) => [f.field, f.label, f.text]);
    const values = {
      ndaSigned: "no",
      mbiInitialDate: "2025-01-15",
      mbiExpirationDate: "2024-12-31",
    };
    expect(validateEirAnswers({ ...EIR_VALUES, ...values })).toEqual([]);
    expect(flags13(values)).toEqual([
      [
        "ndaSigned",
        "Have you agreed to and signed the IRS non-disclosure agreement (NDA)?",
        "IRS NDA not signed",
      ],
      [
        "mbiExpirationDate",
        "MBI or staff-like access expiration date",
        "Before the MBI or staff-like access start date",
      ],
    ]);
  });

  it("flags nothing in legacy answers", () => {
    expect(eirFlags(EIR_STUB_VALUES, "0.1", at)).toEqual([]);
  });
});

describe("EIR pre-fill from the session (SCIM /Me)", () => {
  it("fills the work email and the first and last name, and nothing about the manager", () => {
    const answers = prefilledEirAnswers({
      name: "Display Name Only",
      givenName: "Test",
      familyName: "Person",
      email: "test.person@example.gov",
    });
    expect(answers).toMatchObject({
      workEmail: "test.person@example.gov",
      firstName: "Test",
      lastName: "Person",
      managerId: "",
      managerEmail: "",
      userId: "",
      declarationAgreed: "",
    });
  });

  it("splits the display name when /Me has no name parts", () => {
    expect(prefilledEirAnswers({ name: "Test Middle Person" })).toMatchObject({
      firstName: "Test",
      lastName: "Middle Person",
    });
  });

  it("splits a real SCIM display name the session reports as one", () => {
    expect(prefilledEirAnswers({ name: "Casey Rivera", nameSource: "scim-display" })).toMatchObject(
      { firstName: "Casey", lastName: "Rivera" },
    );
  });

  it("leaves first and last name blank when the only name is the email (GovCloud)", () => {
    const answers = prefilledEirAnswers({
      name: "casey.rivera@example.gov",
      nameSource: "email",
      email: "casey.rivera@example.gov",
    });
    expect(answers).toMatchObject({
      workEmail: "casey.rivera@example.gov",
      firstName: "",
      lastName: "",
    });
  });

  it("never puts the numeric <userId>@<workspaceId> in the first-name field", () => {
    expect(
      prefilledEirAnswers({ name: "1234567890123456@7890123456789012", nameSource: "header" }),
    ).toMatchObject({ firstName: "", lastName: "" });
    expect(prefilledEirAnswers({ name: "1234567890123456@7890123456789012" })).toMatchObject({
      firstName: "",
      lastName: "",
    });
  });

  it("leaves the names blank for a username or no name at all", () => {
    for (const nameSource of ["username", "none"] as const) {
      expect(prefilledEirAnswers({ name: "crivera", nameSource })).toMatchObject({
        firstName: "",
        lastName: "",
      });
    }
  });

  it("never splits an email-shaped name, whatever the session says", () => {
    expect(prefilledEirAnswers({ name: "casey.rivera@example.gov" })).toMatchObject({
      firstName: "",
      lastName: "",
    });
  });

  it("never splits a scim-display name that is an identifier", () => {
    for (const name of ["casey.rivera@example.gov", "casey.rivera", "1234567890"]) {
      expect(
        prefilledEirAnswers({ name, nameSource: "scim-display", email: "casey.rivera@example.gov" }),
      ).toMatchObject({ firstName: "", lastName: "" });
    }
  });

  it("drops a malformed name part, each field on its own", () => {
    expect(
      prefilledEirAnswers({
        name: "casey.rivera@example.gov",
        nameSource: "email",
        givenName: "casey.rivera@example.gov",
        familyName: "Rivera",
        email: "casey.rivera@example.gov",
      }),
    ).toMatchObject({ firstName: "", lastName: "Rivera" });
    expect(
      prefilledEirAnswers({
        name: "Casey",
        nameSource: "scim-parts",
        givenName: "Casey",
        familyName: "12345",
      }),
    ).toMatchObject({ firstName: "Casey", lastName: "" });
  });

  it("does not copy a parts-only name into both fields", () => {
    expect(
      prefilledEirAnswers({ name: "Rivera", nameSource: "scim-parts", familyName: "Rivera" }),
    ).toMatchObject({ firstName: "", lastName: "Rivera" });
  });

  it("prefills a real single-word display name as the first name", () => {
    expect(
      prefilledEirAnswers({
        name: "Cher",
        nameSource: "scim-display",
        email: "c.sarkisian@example.gov",
      }),
    ).toMatchObject({ firstName: "Cher", lastName: "" });
  });

  it("still takes SCIM name parts when the display name is only the email", () => {
    expect(
      prefilledEirAnswers({
        name: "casey.rivera@example.gov",
        nameSource: "email",
        givenName: "Casey",
        familyName: "Rivera",
      }),
    ).toMatchObject({ firstName: "Casey", lastName: "Rivera" });
  });
});

describe("prefilledAnswersOn — a custom form", () => {
  /** A form whose prefilled fields have their own ids, split across sections. */
  const FORM: EirFormConfig = {
    version: "test",
    title: "Test form",
    intro: "",
    trainingRule: "",
    sections: [
      {
        id: "who",
        title: "Who",
        fields: [
          { id: "given", label: "Given", kind: "text", required: true, prefill: "first-name" },
          { id: "note", label: "Note", kind: "text", required: false },
        ],
      },
      {
        id: "contact",
        title: "Contact",
        fields: [
          { id: "surname", label: "Surname", kind: "text", required: true, prefill: "last-name" },
          { id: "mail", label: "Mail", kind: "text", required: true, prefill: "email" },
        ],
      },
    ],
    declaration: { text: "", attestation: { id: "agreed", label: "Agreed" } },
  };
  const EMAIL = "casey.rivera@example.gov";
  const fill = (session: Parameters<typeof prefilledAnswersOn>[1]) =>
    prefilledAnswersOn(FORM, session);

  it("fills only the custom form's prefill fields", () => {
    expect(fill({ givenName: "Casey", familyName: "Rivera", email: EMAIL })).toEqual({
      given: "Casey",
      note: "",
      surname: "Rivera",
      mail: EMAIL,
      agreed: "",
    });
  });

  it.each([
    ["valid given, invalid family", "Casey", "１２３４", "Casey", ""],
    ["invalid given, valid family", "casey.rivera@example.gov", "Rivera", "", "Rivera"],
    ["given is the email's local part", "Casey.Rivera", "Rivera", "", "Rivera"],
    ["both invalid", "١٢٣٤", "1234@5678", "", ""],
    ["both valid, padded", "  Casey ", " Rivera  ", "Casey", "Rivera"],
  ])("checks each name part on its own: %s", (_label, givenName, familyName, given, surname) => {
    expect(fill({ givenName, familyName, email: EMAIL })).toMatchObject({ given, surname });
  });

  const SPLIT: Record<NameSource, boolean> = {
    "scim-display": true,
    "scim-parts": false,
    header: false,
    email: false,
    username: false,
    none: false,
  };
  it.each(Object.entries(SPLIT) as [NameSource, boolean][])(
    "splits the display name only for a scim-display source: %s",
    (nameSource, splits) => {
      expect(fill({ name: "Casey Rivera", nameSource, email: EMAIL })).toMatchObject(
        splits ? { given: "Casey", surname: "Rivera" } : { given: "", surname: "" },
      );
    },
  );

  it.each(Object.keys(SPLIT) as NameSource[])(
    "takes valid SCIM name parts whatever the source: %s",
    (nameSource) => {
      expect(
        fill({ name: EMAIL, nameSource, givenName: "Casey", familyName: "Rivera", email: EMAIL }),
      ).toMatchObject({ given: "Casey", surname: "Rivera", mail: EMAIL });
    },
  );

  it("never splits a Unicode-digit scim-display name", () => {
    for (const name of ["１２３４", "١٢٣٤ ٥٦٧٨"]) {
      expect(fill({ name, nameSource: "scim-display" })).toMatchObject({ given: "", surname: "" });
    }
  });
});

describe("EIR answers for display", () => {
  it("lays form 1.2 out by section, ending with the declaration, with flags on their rows", () => {
    const values = { ...EIR_VALUES, ndaSigned: "no" };
    const flags = eirFlags(values, "1.2", { submittedAt: "2026-10-05T00:00:00Z" });
    const answers = answerSections(values, "1.2", { flags });
    expect(answers).toMatchObject({ legacy: false, name: "EIR form 1.2" });
    expect(answers.sections.map((s) => s.title)).toEqual([
      "User details",
      "Listed manager",
      "Compliance",
      "Declaration",
    ]);
    const rows = answers.sections.flatMap((s) => s.rows);
    expect(rows.find((r) => r.field === "ndaSigned")).toMatchObject({
      value: "No",
      flags: ["IRS NDA not signed"],
    });
    expect(rows.find((r) => r.field === "subTeam")).toMatchObject({ value: "Not answered" });
    expect(rows.find((r) => r.field === "privacyTrainingDate")?.value).toBe("6/2/2026");
    expect(rows.find((r) => r.field === "declarationAgreed")).toMatchObject({
      label: "I agree",
      value: "Yes",
    });
  });

  it("lays form 1.3 out by its own sections and labels", () => {
    const answers = answerSections({ ...EIR_VALUES, contractingCompany: "" }, "1.3");
    expect(answers).toMatchObject({ legacy: false, name: "EIR form 1.3" });
    expect(answers.sections.map((s) => s.title)).toEqual([
      "User details",
      "Your manager",
      "Compliance",
      "Declaration",
    ]);
    const rows = answers.sections.flatMap((s) => s.rows);
    expect(rows.find((r) => r.field === "contractingCompany")).toMatchObject({
      label: "Contracting company",
      value: "Not answered",
    });
  });

  it("keeps a 1.2 record's own labels, and invents nothing for a field it left blank", () => {
    const stored = { ...EIR_VALUES, mbiExpirationDate: "", cyberAwarenessTrainingDate: "" };
    const rows = answerSections(stored, "1.2").sections.flatMap((s) => s.rows);
    expect(rows.find((r) => r.field === "mbiExpirationDate")).toMatchObject({
      label: "Your contractor MBI / staff-like access expiration date (not always listed)",
      value: "Not answered",
    });
    expect(rows.find((r) => r.field === "contractingCompany")?.label).toBe("Contracting Company");
    expect(eirFlags(stored, "1.2", {}).map((f) => f.text)).toContain("No training date given");
  });

  it("shows legacy answers under their own version's labels, inventing nothing for 1.2", () => {
    const answers = answerSections(EIR_STUB_VALUES, "0.1");
    expect(answers).toMatchObject({
      legacy: true,
      name: "Interim checklist (before EIR form 1.2), form 0.1",
    });
    expect(answers.sections).toEqual([
      {
        id: "legacy",
        title: "Legacy answers",
        rows: [
          { field: "fullName", label: "Full legal name", value: "Test Person", flags: [] },
          { field: "organization", label: "Organization", value: "Example Org", flags: [] },
          { field: "jobTitle", label: "Job title", value: "Analyst", flags: [] },
          {
            field: "businessNeed",
            label: "Business need for Federal Tax Information (FTI)",
            value: "Synthetic test record",
            flags: [],
          },
        ],
      },
    ]);
  });
});

/** The text a PDF's content streams draw, in order, joined with spaces. */
function pdfStrings(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes);
  return [...text.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
    .map((match) => match[1]!.replace(/\\(.)/g, "$1"))
    .join(" ")
    .replace(/\s+/g, " ");
}

/** The structure the signature workflow needs: a valid xref, an AcroForm, a signature widget on a page. */
function inspectPdf(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  const startXref = Number(text.match(/startxref\s+(\d+)\s+%%EOF/)?.[1]);
  expect(text.startsWith("xref", startXref)).toBe(true);
  const lines = text.slice(startXref).split("\n");
  const count = Number(lines[1]!.split(" ")[1]);
  const offsets = lines.slice(3, 2 + count).map((line) => Number(line.slice(0, 10)));
  const object = (n: number) => {
    expect(text.startsWith(`${n} 0 obj`, offsets[n - 1]!)).toBe(true);
    return text.slice(offsets[n - 1]!, text.indexOf("endobj", offsets[n - 1]!));
  };
  const all = Array.from({ length: count - 1 }, (_, i) => object(i + 1));
  const acroFormRef = Number(all[0]!.match(/\/AcroForm (\d+) 0 R/)?.[1]);
  const signatureRef = Number(object(acroFormRef).match(/\/Fields \[(\d+) 0 R\]/)?.[1]);
  const pages = all.filter((o) => o.includes("/Type /Page "));
  return { signature: object(signatureRef), signatureRef, pages };
}

describe("generated EIR PDF", () => {
  it("prints an EIR started before display codes with its old number", async () => {
    const strings = pdfStrings(await generateEirPdf(EIR_VALUES, { recordId: "EIR-1042" }));
    expect(strings).toContain("Record ID: EIR-1042");
  });

  it("contains the Record ID, form version, every answer, the declaration and a signature field", async () => {
    const bytes = await generateEirPdf(EIR_VALUES, { recordId: "EIR-7K3QFD" });
    const strings = pdfStrings(bytes);
    expect(strings).toContain(EIR_FORM.title);
    expect(strings).toContain("Record ID: EIR-7K3QFD");
    expect(strings).toContain("EIR definition: bootstrap-2 (version 0)");
    expect(strings).not.toMatch(/Form version|Definition version/);
    expect(strings).not.toMatch(/Sent by|Triggering event/);
    for (const section of answerSections(EIR_VALUES, EIR_FORM.version).sections.filter(
      (s) => s.id !== "declaration",
    )) {
      expect(strings).toContain(section.title);
      for (const row of section.rows) expect(strings).toContain(`${row.label} ${row.value}`);
    }
    expect(strings).toContain(EIR_FORM.declaration.text);
    expect(strings).toContain("I agree: Yes");
    for (const value of [
      "A1B2C",
      "test.person@example.gov",
      "M9N8P",
      "test.manager@example.gov",
      "6/2/2026",
    ]) {
      expect(strings).toContain(value);
    }

    const pdf = inspectPdf(bytes);
    expect(pdf.signature).toMatch(/\/Subtype \/Widget \/FT \/Sig/);
    expect(pdf.signature).toContain("/T (digital_signature)");
    expect(pdf.pages.filter((p) => p.includes(`/Annots [${pdf.signatureRef} 0 R]`))).toHaveLength(
      1,
    );
    // The widget points at the page that lists it.
    const owner = Number(pdf.signature.match(/\/P (\d+) 0 R/)?.[1]);
    expect(new TextDecoder().decode(bytes)).toMatch(
      new RegExp(`${owner} 0 obj\\n<< /Type /Page [^\\n]*/Annots \\[${pdf.signatureRef} 0 R\\]`),
    );
  });

  it("generated PDF contains the same labels and values as before the migration", async () => {
    // Form 1.3's PDF before #200 moved the form into the bootstrap definition,
    // written out by hand: title, intro, version, each section and "label value" row.
    // Its version line is the one #224 changed: the definition's identity. It's
    // rendered on the bootstrap definition's form, whose help text form 1.3 had.
    const strings = pdfStrings(
      await generateEirPdf(EIR_VALUES, { recordId: "EIR-1042", form: EIR_FORMS["bootstrap"]! }),
    );
    const expected = [
      "Enterprise Data Platform - Employee Identity Record (EIR)",
      "EIR definition: bootstrap (version 0)",
      "User details",
      "User ID A1B2C",
      "First name Test",
      "Last name Person",
      "Work email test.person@example.gov",
      "Team or project Test Team",
      "Sub-team or sub-project Not answered",
      "Contracting company Example Contracting LLC",
      "Your manager",
      "Manager's first name Test",
      "Manager's last name Manager",
      "Manager's user ID M9N8P",
      "Manager's work email test.manager@example.gov",
      "Compliance",
      "Unauthorized Access training date 6/1/2026",
      "Privacy training date 6/2/2026",
      "Cyber Awareness training date 6/3/2026",
      "Have you read, acknowledged and signed the IRM 10.5.8 manual transmittal? Yes",
      "Have you agreed to and signed the IRS non-disclosure agreement (NDA)? Yes",
      "MBI or staff-like access start date 1/15/2025",
      "MBI or staff-like access expiration date 1/15/2030",
      "Does your MBI or staff-like access show a preliminary or incomplete background investigation? No",
      "I agree: Yes",
    ];
    let from = 0;
    for (const text of expected) {
      const at = strings.indexOf(text, from);
      expect(at, text).toBeGreaterThanOrEqual(0);
      from = at + text.length;
    }
  });

  it("wraps long answers onto more pages and still keeps every word", async () => {
    const long = { ...EIR_VALUES, subTeam: "Long sub-team name ".repeat(40).trim() };
    const bytes = await generateEirPdf(long, { recordId: "EIR-1043" });
    expect(pdfStrings(bytes)).toContain(long["subTeam"]!);
    expect(new TextDecoder().decode(bytes)).toMatch(/\/Count [2-9]/);
  });

  it("says when the declaration wasn't agreed", async () => {
    const strings = pdfStrings(
      await generateEirPdf({ ...EIR_VALUES, declarationAgreed: "" }, { recordId: "EIR-1" }),
    );
    expect(strings).toContain("I agree: Not agreed");
  });
});
