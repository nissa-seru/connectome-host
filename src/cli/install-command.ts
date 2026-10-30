import { delimiter, join, resolve } from 'node:path';
import { realOrResolved, writeTextAtomic } from '../update/contract.js';
import { shellWord } from '../update/launcher.js';

export const INSTALL_COMMAND = 'connectome';

export const CLI_IN_RELEASE = ['node_modules', '@animalabs', 'connectome-host', 'src', 'cli', 'connectome.ts'];

export function installCommandText(): string {
  return [
    '#!/usr/bin/env bun',
    '// Written by this install\'s setup. Link to it rather than move it: it runs the install it sits in.',
    "import { existsSync, realpathSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    'const root = dirname(realpathSync(fileURLToPath(import.meta.url)));',
    "const word = (path) => /^[\\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\\\''`)}'`;",
    `const cli = join(root, 'current', ${CLI_IN_RELEASE.map((part) => `'${part}'`).join(', ')});`,
    "if (!existsSync(join(root, 'current'))) {",
    "  console.error(`connectome: ${root} has no current release: run setup again in ${dirname(root)}, which says how ` +",
    "    'to put it right.');",
    '  process.exit(1);',
    '}',
    'let main;',
    'try {',
    '  ({ main } = await import(cli));',
    "  if (typeof main !== 'function') throw new Error('it has no main to call');",
    '} catch (error) {',
    "  console.error(`connectome: the release this install runs has no connectome command that loads (${cli}): ` +",
    "    `${error instanceof Error ? error.message : error}. If its host still starts, its /update, in the TUI or ` +",
    "    `the Web UI, updates it. If this release is broken, \\`bun ${word(join(root, 'start.js'))} --go-back\\` asks ` +",
    "    'the next start to go back, when a Go back is offered.');",
    '  process.exit(1);',
    '}',
    'process.exit(await main(root, process.argv.slice(2)));',
    '',
  ].join('\n');
}

/** An install's own command's path, and the line that puts its directory on PATH, or null where it's on PATH,
 *  each directory compared by its real path. */
export function installCommandOf(root: string, path: string | undefined = process.env.PATH):
  { path: string; pathLine: string | null } {
  const real = (dir: string) => {
    try {
      return realOrResolved(dir);
    } catch {
      return resolve(dir);
    }
  };
  const here = real(root);
  const onPath = (path ?? '').split(delimiter).some((dir) => dir !== '' && real(dir) === here);
  return { path: join(root, INSTALL_COMMAND), pathLine: onPath ? null : `export PATH=${shellWord(root)}:"$PATH"` };
}

export function writeInstallCommand(root: string, path: string | undefined = process.env.PATH):
  { path: string; pathLine: string | null } {
  const command = installCommandOf(root, path);
  writeTextAtomic(command.path, installCommandText(), 0o755);
  return command;
}
