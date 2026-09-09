/**
 * CSV serialization for the Predictive Intelligence exports.
 *
 * Pure and framework-free, so the client components can import it and the tests
 * can exercise it without a DOM.
 */

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * Tab and carriage return are included because Excel strips leading whitespace
 * before deciding, so `"\t=cmd"` is still a formula.
 */
const FORMULA_PREFIXES: readonly string[] = Object.freeze(['=', '+', '-', '@', '\t', '\r']);

/**
 * Escapes one CSV cell.
 *
 * Two separate jobs. **Formula injection:** a cell starting with `=`, `+`, `-`,
 * `@`, tab, or CR is prefixed with a single quote, because without it exported
 * alert data executes on open in Excel and Sheets. **Quoting:** every cell is
 * quote-wrapped and embedded quotes are doubled, so a comma or newline in the
 * value cannot shift the column layout.
 *
 * @param value - Raw cell value.
 * @returns The quoted, injection-safe cell.
 */
export function escapeCsvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  const guarded = FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix)) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * Serializes rows to CSV with a header line.
 *
 * @param columns - Column headings, in order.
 * @param rows - Row values, aligned to `columns`.
 * @returns The CSV document.
 */
export function toCsv(
  columns: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>
): string {
  const header = columns.map(escapeCsvCell).join(',');
  const body = rows.map((row) => row.map(escapeCsvCell).join(','));
  return [header, ...body].join('\n');
}
