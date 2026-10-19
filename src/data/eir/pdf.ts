import { EIR_FORM, type EirFormConfig } from "./config";
import { definitionLabel } from "./definition/identity";
import { answerSections } from "./form";
import type { EirFormValues } from "./types";

/** The record details the PDF carries (decision 1: the Record ID and the definition's version). */
export interface EirPdfRecord {
  /** `EIR-7K3QFD` (`EIR-1042` on records started before display codes). */
  recordId: string;
  /**
   * The form of the definition the draft was pinned to and evaluated on
   * (#201); the bootstrap's when unset. Its `version` is that definition's
   * identity (#224), which the PDF prints.
   */
  form?: EirFormConfig;
}

function pdfText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/([\\()])/g, "\\$1");
}

const PAGE = { width: 612, height: 792, margin: 54 };
const WIDTH = PAGE.width - PAGE.margin * 2;
/** Helvetica's average glyph is about half its size; wrapping errs short. */
const charsPerLine = (size: number, indent = 0) => Math.floor((WIDTH - indent) / (size * 0.53));

function wrap(text: string, size: number, indent = 0): string[] {
  const max = charsPerLine(size, indent);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      for (let piece = word; piece;) {
        const chunk = piece.slice(0, max);
        piece = piece.slice(max);
        const next = line ? `${line} ${chunk}` : chunk;
        if (next.length > max && line) {
          lines.push(line);
          line = chunk;
        } else line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Lays text out top to bottom, starting a new page when one fills. */
class Layout {
  readonly pages: string[][] = [[]];
  private y = PAGE.height - PAGE.margin;

  private get page() {
    return this.pages.at(-1)!;
  }

  /** Make room for `height` points, on a new page if this one can't hold them. */
  reserve(height: number) {
    if (this.y - height < PAGE.margin) {
      this.pages.push([]);
      this.y = PAGE.height - PAGE.margin;
    }
  }

  text(
    text: string,
    options: { size?: number; bold?: boolean; indent?: number; after?: number } = {},
  ) {
    const size = options.size ?? 10;
    const indent = options.indent ?? 0;
    const leading = size * 1.35;
    for (const line of wrap(text, size, indent)) {
      this.reserve(leading);
      this.y -= leading;
      this.page.push(
        `BT /${options.bold ? "F2" : "F1"} ${size} Tf ${PAGE.margin + indent} ${this.y.toFixed(1)} Td (${pdfText(line)}) Tj ET`,
      );
    }
    this.y -= options.after ?? 0;
  }

  gap(points: number) {
    this.y -= points;
  }

  /** A rectangle `height` tall across `[x, x + width]`, returned in page coordinates. */
  box(
    x: number,
    width: number,
    height: number,
  ): { page: number; rect: [number, number, number, number] } {
    this.reserve(height);
    this.y -= height;
    this.page.push(`${x} ${this.y.toFixed(1)} ${width} ${height} re S`);
    return { page: this.pages.length - 1, rect: [x, this.y, x + width, this.y + height] };
  }
}

/**
 * The EIR as a PDF for the person to sign: the form's title and intro, its
 * Record ID and version, every section's answers, the declaration with the
 * attestation, and a real AcroForm signature field on the last page.
 * Dependency-free; text is uncompressed so tests and validators can read it.
 */
export async function generateEirPdf(
  values: EirFormValues,
  record: EirPdfRecord,
): Promise<Uint8Array> {
  const form = record.form ?? EIR_FORM;
  const layout = new Layout();
  layout.text(form.title, { size: 16, bold: true, after: 6 });
  layout.text(form.intro, { size: 10, after: 8 });
  layout.text(`Record ID: ${record.recordId}`, { size: 10, bold: true });
  layout.text(`EIR definition: ${definitionLabel(form.version)}`, {
    size: 10,
    bold: true,
    after: 10,
  });

  const answers = answerSections(values, form.version, { form });
  for (const section of answers.sections) {
    if (section.id === "declaration") continue;
    layout.reserve(40);
    layout.text(section.title, { size: 12, bold: true, after: 2 });
    const config = form.sections.find((s) => s.id === section.id);
    const help = config && "help" in config ? config.help : undefined;
    if (help) layout.text(help, { size: 9, after: 4 });
    for (const row of section.rows) {
      layout.reserve(28);
      layout.text(row.label, { size: 9, bold: true });
      layout.text(row.value, { size: 10, indent: 12, after: 4 });
    }
    layout.gap(6);
  }

  layout.reserve(80);
  layout.text("Declaration", { size: 12, bold: true, after: 2 });
  layout.text(form.declaration.text, { size: 10, after: 4 });
  const agreed = answers.sections.find((s) => s.id === "declaration")!.rows[0]!;
  layout.text(`${agreed.label}: ${agreed.value}`, { size: 10, bold: true, after: 14 });

  layout.reserve(90);
  layout.text("Digital signature:", { size: 11, bold: true, after: 4 });
  const signature = layout.box(PAGE.margin + 106, 360, 34);
  layout.gap(10);
  layout.text("Sign this PDF digitally, then upload the signed PDF in the EDP Vending Machine.", {
    size: 9,
  });

  // 1 catalog, 2 pages, 3–4 fonts, 5 AcroForm, 6 signature widget, then a page and its content per page.
  const firstPage = 7;
  const pageRef = (index: number) => firstPage + index * 2;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>",
    `<< /Type /Pages /Kids [${layout.pages.map((_, i) => `${pageRef(i)} 0 R`).join(" ")}] /Count ${layout.pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Fields [6 0 R] /SigFlags 3 /NeedAppearances true >>",
    `<< /Type /Annot /Subtype /Widget /FT /Sig /T (digital_signature) /Rect [${signature.rect.map((n) => n.toFixed(1)).join(" ")}] /P ${pageRef(signature.page)} 0 R /F 4 /BS << /W 1 /S /S >> >>`,
  ];
  for (const [index, lines] of layout.pages.entries()) {
    const content = lines.join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageRef(index) + 1} 0 R${index === signature.page ? " /Annots [6 0 R]" : ""} >>`,
      `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`,
    );
  }
  let document = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(document).length);
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(document).length;
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(document);
}
