// Reads the source tree for tests/architecture.test.ts: which layer a file is in, what it imports,
// and whether it touches the DOM or builds scene objects. See docs/adr/0010.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The layers, lowest first. The folder names are today's: when a file moves, only `layerOf` changes.
 *   sim     athletes, ball, contacts, judge, plays, the user's seat (src/game, without the drills)
 *   ai      the brains (src/ai)
 *   drills  the rules of each drill (src/game/modes)
 *   display everything a player sees or hears (src/ui, fx, audio, camera, world, character)
 *   app     the one place that builds every part, and what only it needs: the quick-start link, the stored settings (src/main.ts, src/app)
 */
export type Layer = 'config' | 'core' | 'physics' | 'sim' | 'ai' | 'drills' | 'display' | 'app';

/** what each layer may import, besides itself */
export const MAY_IMPORT: Record<Layer, readonly Layer[]> = {
  config: [],
  core: ['config'],
  physics: ['config'],
  sim: ['physics', 'core', 'config'],
  ai: ['sim', 'physics', 'core', 'config'],
  drills: ['ai', 'sim', 'physics', 'core', 'config'],
  display: ['drills', 'ai', 'sim', 'physics', 'core', 'config'],
  app: ['display', 'drills', 'ai', 'sim', 'physics', 'core', 'config'],
};

/** the simulation: the layers that must run with no DOM and no renderer */
export const SIMULATION: readonly Layer[] = ['sim', 'ai', 'drills'];

const DISPLAY_DIRS = new Set(['ui', 'fx', 'audio', 'camera', 'world', 'character']);

/** the layer of a file under src/ (a path from the repo root), or null for a folder no layer has claimed yet */
export function layerOf(file: string): Layer | null {
  const parts = file.split('/');
  if (parts[0] !== 'src') return null;
  if (parts.length === 2) return parts[1] === 'config.ts' ? 'config' : parts[1] === 'main.ts' ? 'app' : null;
  const dir = parts[1];
  if (dir === 'core' || dir === 'physics' || dir === 'ai' || dir === 'app') return dir;
  if (dir === 'game') return parts[2] === 'modes' ? 'drills' : 'sim';
  return DISPLAY_DIRS.has(dir) ? 'display' : null;
}

function walk(dir: string, out: string[]): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** every .ts file under a folder, as paths from the repo root, sorted */
export const filesUnder = (dir: string): string[] => walk(dir, []).sort();

export const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');

export interface Imports {
  /** files in this repo, as paths from the repo root */
  files: string[];
  /** npm packages and node built-ins */
  packages: string[];
}

/** everything a file imports: `import`, `import type`, `export ... from` and `import('...')` alike */
export function importsOf(file: string): Imports {
  const files: string[] = [];
  const packages: string[] = [];
  for (const { fileName } of ts.preProcessFile(read(file), true, true).importedFiles) {
    if (!fileName.startsWith('.')) {
      packages.push(fileName);
      continue;
    }
    if (/\.(css|svg|png|jpg|json)(\?.*)?$/.test(fileName)) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), fileName)).replace(/\.js$/, '');
    const hit = [`${base}.ts`, `${base}/index.ts`, base].find(
      (p) => fs.existsSync(path.join(ROOT, p)) && fs.statSync(path.join(ROOT, p)).isFile(),
    );
    files.push(hit ?? `${base}.ts`);
  }
  return { files: [...new Set(files)].sort(), packages: [...new Set(packages)].sort() };
}

/** every identifier a file uses as a name of its own (not as a property of something else), and every `THREE.X` */
function namesIn(file: string): { free: Set<string>; three: Set<string> } {
  const free = new Set<string>();
  const three = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'THREE')
      three.add(node.name.text);
    else if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && node.left.text === 'THREE') three.add(node.right.text);
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const isMember =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isQualifiedName(p) && p.right === node) ||
        ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) &&
          p.name === node);
      if (!isMember) free.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true));
  return { free, three };
}

/** browser globals that only exist with a page */
const DOM = [
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'navigator',
  'requestAnimationFrame',
  'matchMedia',
  'HTMLElement',
  'HTMLCanvasElement',
];

/** does the file use a browser global (comments and strings do not count) */
export function touchesDom(file: string): boolean {
  const { free } = namesIn(file);
  return DOM.some((name) => free.has(name));
}

/** three.js classes that are only values: maths with no scene, no GPU and no DOM behind them */
const THREE_MATHS = new Set([
  'Vector2',
  'Vector3',
  'Vector4',
  'Quaternion',
  'Euler',
  'Matrix3',
  'Matrix4',
  'MathUtils',
  'Plane',
  'Ray',
  'Box3',
  'Sphere',
  'Color',
]);

/** the three.js names a file uses that are not maths (meshes, materials, textures, the renderer), sorted */
export function sceneClassesIn(file: string): string[] {
  const found = new Set([...namesIn(file).three].filter((name) => !THREE_MATHS.has(name)));
  // named imports: import { Mesh, type Texture } from 'three', and anything from three's add-ons
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, false);
  for (const st of source.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const from = st.moduleSpecifier.text;
    if (from !== 'three' && !from.startsWith('three/')) continue;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        const name = (el.propertyName ?? el.name).text;
        if (from !== 'three' || !THREE_MATHS.has(name)) found.add(name);
      }
    } else if (from !== 'three') found.add(from);
  }
  return [...found].sort();
}
