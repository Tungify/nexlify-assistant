// Minimal multi-sheet .xlsx writer — no dependencies.
//
// Why hand-rolled: the only real option (SheetJS 0.18.5, the last npm release)
// ships two high-severity advisories. Both are in its *parsing* paths, which we
// would never use — we only write — but a workbook is just a ZIP of XML, and
// Chrome gives us `CompressionStream('deflate-raw')`, so writing one directly is
// a few dozen lines and pulls in nothing.
//
// Deliberately minimal: inline strings (no sharedStrings table), no styles, no
// merged cells. Enough for tabular exports Excel/Sheets/Numbers all open.

export interface Sheet {
  name: string;
  headers: string[];
  rows: string[][];
  /** Column indexes to write as real numbers so Excel can sum them. */
  numericColumns?: Set<number>;
}

// ---- XML -------------------------------------------------------------------

// Escape XML text and drop control characters, which make Excel declare the
// file corrupt rather than skipping them.
function xmlText(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 0 → A, 25 → Z, 26 → AA …
function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; ) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Only treat a value as numeric when it round-trips exactly: long ids (order,
// product, variant) would otherwise be mangled into scientific notation or lose
// their last digits to float precision.
function asNumber(v: string): string | null {
  if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) return null;
  return String(n) === v || Number(String(n)) === n ? String(n) : null;
}

function sheetXml(sheet: Sheet): string {
  const numeric = sheet.numericColumns ?? new Set<number>();
  const lines: string[] = [];
  const emit = (cells: string[], rowIndex: number) => {
    const r = rowIndex + 1;
    const parts = cells.map((raw, c) => {
      const ref = `${colName(c)}${r}`;
      const v = raw ?? "";
      if (v === "") return "";
      if (numeric.has(c)) {
        const n = asNumber(v);
        if (n !== null) return `<c r="${ref}"><v>${n}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
    });
    lines.push(`<row r="${r}">${parts.join("")}</row>`);
  };
  emit(sheet.headers, 0);
  sheet.rows.forEach((row, i) => emit(row, i + 1));
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${lines.join("")}</sheetData></worksheet>`
  );
}

// Excel rejects >31 chars, the characters : \ / ? * [ ], and duplicate names.
export function safeSheetName(raw: string, taken: Set<string>): string {
  let base = (raw || "Sheet").replace(/[:\\/?*[\]]/g, "-").trim().slice(0, 31) || "Sheet";
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  taken.add(name.toLowerCase());
  return name;
}

// ---- ZIP -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface Entry {
  name: string;
  data: Uint8Array;
  deflated: Uint8Array;
  crc: number;
}

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

// Build a ZIP (deflate) from the given parts. Timestamps are fixed rather than
// taken from the clock so the same data always produces a byte-identical file.
async function zip(files: { name: string; text: string }[]): Promise<Blob> {
  const enc = new TextEncoder();
  const entries: Entry[] = [];
  for (const f of files) {
    const data = enc.encode(f.text);
    entries.push({ name: f.name, data, deflated: await deflateRaw(data), crc: crc32(data) });
  }

  const chunks: Uint8Array[] = [];
  const central: number[] = [];
  let offset = 0;
  const TIME = 0;
  const DATE = 33; // 1980-01-01

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0x800), ...u16(8),
      ...u16(TIME), ...u16(DATE),
      ...u32(e.crc), ...u32(e.deflated.length), ...u32(e.data.length),
      ...u16(nameBytes.length), ...u16(0),
    ];
    chunks.push(new Uint8Array(local), nameBytes, e.deflated);

    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x800), ...u16(8),
      ...u16(TIME), ...u16(DATE),
      ...u32(e.crc), ...u32(e.deflated.length), ...u32(e.data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
      ...Array.from(nameBytes),
    );
    offset += local.length + nameBytes.length + e.deflated.length;
  }

  const centralBytes = new Uint8Array(central);
  chunks.push(centralBytes);
  chunks.push(
    new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0),
      ...u16(entries.length), ...u16(entries.length),
      ...u32(centralBytes.length), ...u32(offset), ...u16(0),
    ]),
  );

  return new Blob(chunks as unknown as BlobPart[], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// ---- workbook --------------------------------------------------------------

export async function buildXlsx(sheets: Sheet[]): Promise<Blob> {
  const list = sheets.length ? sheets : [{ name: "Sheet1", headers: [], rows: [] }];

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    list
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
    list
      .map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("") +
    `</sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    list
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `</Relationships>`;

  return zip([
    { name: "[Content_Types].xml", text: contentTypes },
    { name: "_rels/.rels", text: rootRels },
    { name: "xl/workbook.xml", text: workbook },
    { name: "xl/_rels/workbook.xml.rels", text: workbookRels },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s) })),
  ]);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
