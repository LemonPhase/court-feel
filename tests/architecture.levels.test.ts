import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { FACETS } from '../src/config';
import { filesUnder, read } from './architecture.scan';

// A level is a tuning each team carries (docs/adr/0013): every AI player reads its team's copy,
// `athlete.ai`, never the `AI` table itself. A brain that reads `AI.tipChance` straight plays Pro at
// every level and nothing fails: the level just stops working for that number. These are the two
// doors that would let that happen, shut.

/** every key a level may tune, from any facet */
const TUNED = new Set<string>(Object.values(FACETS).flat());

/** `AI.<key>` reads of a tuned key in a file (comments and strings are not code, so they are not read) */
function tunedReads(file: string, text = read(file)): string[] {
  const found: string[] = [];
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'AI' &&
      TUNED.has(node.name.text)
    )
      found.push(`${file}:${src.getLineAndCharacterOfPosition(node.getStart()).line + 1} AI.${node.name.text}`);
    ts.forEachChild(node, visit);
  };
  visit(src);
  return found;
}

/** whether a file imports the `AI` value (not just its type) from the config */
function importsAiValue(file: string, text = read(file)): boolean {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return src.statements.some((s) => {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !/\/config$/.test(s.moduleSpecifier.text)) return false;
    const clause = s.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
    return clause.namedBindings.elements.some((e) => !e.isTypeOnly && (e.propertyName ?? e.name).text === 'AI');
  });
}

describe('a level reaches every AI number it tunes', () => {
  it('no file reads a number a level tunes from `AI` itself: it reads the team’s tuning (`athlete.ai`, `team.ai`)', () => {
    const reads = filesUnder('src')
      .filter((f) => f !== 'src/config.ts')
      .flatMap((f) => tunedReads(f));
    expect(reads).toEqual([]);
  });

  it('no brain imports the `AI` table: a brain plays with the tuning its athlete carries', () => {
    expect(filesUnder('src/ai').filter((f) => importsAiValue(f))).toEqual([]);
  });

  it('the guards catch what they are there for, and let a comment or a type through', () => {
    const brain = "import { AI, type AiTuning } from '../config';\n// AI.tipChance in a comment\nconst t = AI.tipChance;\n";
    expect(tunedReads('src/ai/x.ts', brain)).toEqual(['src/ai/x.ts:3 AI.tipChance']);
    expect(importsAiValue('src/ai/x.ts', brain)).toBe(true);
    expect(importsAiValue('src/ai/x.ts', "import type { AiTuning } from '../config';\n")).toBe(false);
    expect(importsAiValue('src/ai/x.ts', "import { type AiTuning, SIM } from '../config';\n")).toBe(false);
    expect(tunedReads('src/ai/x.ts', 'const s = AI.sit; const t = a.ai.tipChance;')).toEqual([]);
  });
});
