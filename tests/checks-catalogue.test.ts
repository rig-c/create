import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import ts from 'typescript';

const root = join(import.meta.dir, '..');
const codePattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const codePrefix = /^(?:\s*(?:FAIL|PASS)\s+)?([A-Z][A-Z0-9_]+):/;
const namedDiagnostic = /\b(?:WARN|REFUSED)\s+([A-Z][A-Z0-9_]+):/g;

// These literals are metadata or upstream identifiers at the listed use sites.
const nonDiagnosticLiterals: Readonly<Record<string, readonly string[]>> = {
  'src/next.ts': ['AMENDED_STEP'], // next.move.lapse metadata
  'src/parts-sections.ts': ['CONFIG_SECTIONS'], // Parts export name
  'src/job-publication.ts': ['JOB_PREVIOUS_DRAFT_SCHEMA'], // Review export name
  'src/job-close.ts': [ // mapped to JOB_BINDING_INVALID
    'JOB_AUTHORITY_REFUSED', 'JOB_PARTS_ENUMERATOR_UNSUPPORTED',
    'JOB_REQUEST_INVALID', 'JOB_SOURCE_UNRETAINABLE',
  ],
  'src/parts-check.ts': ['PARTS_DRAW_ORDER_INVERTED', 'PARTS_INVENTED_MATERIAL'], // producer report row labels
  'src/rig-check-report.ts': ['SOURCE_EXPOSURE'], // source check ID
};

function files(dir: string, suffix: RegExp): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return files(file, suffix);
    return entry.isFile() && suffix.test(file) ? [file] : [];
  });
}

function literalChoices(node: ts.Node): string[] {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    return [...literalChoices(node.whenTrue), ...literalChoices(node.whenFalse)];
  }
  return [];
}

function isErrorNameAssignment(node: ts.Node): boolean {
  const assignment = node.parent;
  return ts.isBinaryExpression(assignment) && assignment.right === node
    && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(assignment.left) && assignment.left.name.text === 'name'
    && ts.isIdentifier(assignment.left.expression) && assignment.left.expression.text === 'error';
}

function scanTypeScript(file: string, record: (code: string, location: string) => void) {
  const tree = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const sourceFile = file.startsWith('src/');
  const ignored = nonDiagnosticLiterals[file] ?? [];
  function visit(node: ts.Node) {
    function inspect(value: string) {
      const location = `${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      if ((sourceFile || isErrorNameAssignment(node)) && !ignored.includes(value)) record(value, location);
      // Also find diagnostics embedded in text, including warnings returned to another writer.
      const prefix = codePrefix.exec(value)?.[1];
      if (prefix) record(prefix, location);
      for (const [, code] of value.matchAll(namedDiagnostic)) record(code, location);
    }
    if (ts.isStringLiteralLike(node)) inspect(node.text);
    if (ts.isTemplateExpression(node)) {
      inspect(node.head.text);
      let values = [node.head.text];
      for (const span of node.templateSpans) {
        values = values.flatMap(prefix => literalChoices(span.expression)
          .map(value => prefix + value + span.literal.text));
      }
      for (const value of values) inspect(value);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}

test('CHECKS.md lists every raised code and every live row has a source', () => {
  const codes = new Map<string, Set<string>>();
  function record(code: string, location: string) {
    if (!codePattern.test(code)) return;
    let locations = codes.get(code);
    if (!locations) codes.set(code, locations = new Set());
    locations.add(location);
  }

  const src = files('src', /\.ts$/).sort();
  const scripts = files('scripts', /\.ts$/).sort();
  const workflows = files('.github/workflows', /\.ya?ml$/).sort();
  for (const file of [...src, ...scripts]) scanTypeScript(file, record);
  for (const file of workflows) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(/::(?:error|warning)::([A-Z][A-Z0-9_]+):/g)) {
        record(match[1], `${file}:${index + 1}`);
      }
    });
  }

  const catalogue = 'docs/CHECKS.md';
  const rows = new Set<string>();
  const retired = new Set<string>();
  const orphan: string[] = [];
  readFileSync(join(root, catalogue), 'utf8').split('\n').forEach((line, index) => {
    if (!/^\s*\|/.test(line)) return;
    const [, cell, finding] = line.split('|', 4);
    // A row may name several codes or annotate them with a status such as (WARN).
    for (const [, code] of cell.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
      rows.add(code);
      if (/^\s*Retired\b/.test(finding ?? '')) retired.add(code);
      else if (!codes.has(code)) orphan.push(`Orphan row ${code} at ${catalogue}:${index + 1}`);
    }
  });

  const missing = [...codes].filter(([code]) => !rows.has(code)).sort(([a], [b]) => a.localeCompare(b));
  console.log(`src_files=${src.length} script_files=${scripts.length} workflow_files=${workflows.length} live_codes=${codes.size} catalogue_codes=${rows.size} retired=${retired.size} missing=${missing.length} orphan=${orphan.length}`);
  expect([
    ...missing.map(([code, locations]) => `Missing row for ${code} at ${[...locations].join(', ')}`),
    ...orphan,
  ]).toEqual([]);
});
