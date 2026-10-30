import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  lstatSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SETUP_SUMMARY, realWorld, setup, type AgentLaunch, type Ran, type RunOptions, type SetupWorld } from '../src/cli/setup.js';
import { checkKey, type KeyCheck, type KeyCheckOptions } from '../src/setup/key-check.js';
import { lingerOf } from '../src/setup/linger.js';
import { SetupModule } from '../src/modules/setup-module.js';
import { readEnvFile } from '../src/setup/secrets.js';
import { writeInstallCommand } from '../src/cli/install-command.js';
import { ENTRY_POINT, EXTRA_STATE_LINE, LIST_A_PLACE, WRITE_RECORD_AGAIN, installPaths } from '../src/update/contract.js';
import { entryPointText } from '../src/update/setup.js';
import { machineOps, takeLock } from '../src/update/launcher.js';
import { HostUpdate } from '../src/update/update.js';

const REPO = resolve(import.meta.dir, '..');
const BIN = join(REPO, 'src', 'cli', 'connectome.ts');
const VERSION = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as { version: string }).version;
const NODE_FLOOR = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as { engines: { node: string } }).engines.node.replace('>=', '');
const SETUP_MODEL = 'claude-opus-5-5';
const made: string[] = [];
const args = (argv: string[]) => argv.slice(argv[1] === '--no-env-file' ? 2 : 1);

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'setup-')));
  made.push(dir);
  return dir;
}

interface Script {
  answers?: string[];
  secrets?: string[];
  keys?: KeyCheck[];
  node?: string | null;
  nodeRan?: Ran;
  boot?: 'real' | Ran;
  host?: string;
  release?: string;
  installSetup?: Ran;
  /** Lines the install's own setup prints after its first, when it finishes. */
  installSetupSays?: string;
  added?: Ran;
  duringBoot?: () => void;
}

interface Seen {
  out: string[];
  err: string[];
  asked: string[];
  ran: string[][];
  options: RunOptions[];
  checked: KeyCheckOptions[];
  launched: AgentLaunch | null;
  outAtLaunch?: number;
  boot?: RunOptions;
}

function world(dir: string, script: Script = {}, over: Partial<SetupWorld> = {}): { world: SetupWorld; seen: Seen } {
  const seen: Seen = { out: [], err: [], asked: [], ran: [], options: [], checked: [], launched: null };
  const answers = [...(script.answers ?? [])];
  const secrets = [...(script.secrets ?? [])];
  const keys = [...(script.keys ?? [])];
  const real = realWorld();
  const run = async (argv: string[], options: RunOptions): Promise<Ran> => {
    seen.ran.push(argv);
    seen.options.push(options);
    if (argv[0] === 'node') {
      if (script.nodeRan) return script.nodeRan;
      const node = script.node === undefined ? '22.20.0' : script.node;
      return node === null ? { status: null, stdout: '', stderr: '', startError: { code: 'ENOENT', message: 'Executable not found in $PATH: "node"' } }
        : { status: 0, stdout: `v${node}\n`, stderr: '' };
    }
    if (args(argv)[0] === 'add') {
      if (script.added) return script.added;
      for (const spec of args(argv).slice(1)) {
        const at = spec.lastIndexOf('@');
        const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, '1.0.0'];
        mkdirSync(join(options.cwd, 'node_modules', name), { recursive: true });
        writeFileSync(join(options.cwd, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts'))) {
      expect(args(argv)[0]).toBe(join(options.cwd, 'node_modules', '@animalabs', 'connectome-host', 'src', 'update', 'setup.ts'));
      if (script.installSetup) return script.installSetup;
      const at = argv.indexOf('--root');
      const root = at > 0 ? argv[at + 1]! : join(options.cwd, 'connectome-host');
      const dataDir = options.env.DATA_DIR ?? '';
      if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
        return { status: 1, stdout: '', stderr: `connectome-host setup: The data directory ${dataDir} isn't there.\n` };
      }
      const record = join(root, 'install.json');
      if (existsSync(record)) {
        const served = (JSON.parse(readFileSync(record, 'utf-8')) as { dataDir: string }).dataDir;
        if (realpathSync(served) !== realpathSync(dataDir)) {
          return { status: 1, stdout: '', stderr: `connectome-host setup: The install at ${root} serves ${served}, not ${dataDir}.\n` };
        }
      }
      const release = script.release ?? VERSION;
      const scope = join(root, 'releases', release, 'node_modules', '@animalabs');
      if (!existsSync(scope)) {
        mkdirSync(scope, { recursive: true });
        if (script.host === 'copy') {
          const host = join(scope, 'connectome-host');
          for (const part of ['src', 'recipes', 'package.json']) cpSync(join(REPO, part), join(host, part), { recursive: true });
          symlinkSync(join(REPO, 'node_modules'), join(host, 'node_modules'));
        } else {
          symlinkSync(script.host ?? REPO, join(scope, 'connectome-host'));
        }
        symlinkSync(join('releases', release), join(root, 'current'));
        writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir, extraState: [] }));
        writeFileSync(join(root, ENTRY_POINT), entryPointText());
      }
      writeInstallCommand(root, options.env.PATH);
      return { status: 0, stdout: `Set up ${root} as the install of ${release} that serves ${dataDir}.\n${script.installSetupSays ?? ''}`, stderr: '' };
    }
    if (argv[1]?.endsWith(join('src', 'index.ts'))) {
      seen.boot = options;
      script.duringBoot?.();
      if (script.boot === 'real') return real.run(argv, options);
      return script.boot ?? { status: 0, stdout: 'Done.\n', stderr: '' };
    }
    throw new Error(`setup ran something this world doesn't know: ${argv.join(' ')}`);
  };
  return {
    seen,
    world: {
      terminal: true,
      platform: 'linux',
      user: 'alice',
      env: { PATH: '/usr/bin:/bin', HOME: dir },
      cwd: dir,
      bun: { path: process.execPath, version: '1.4.4' },
      hasSudo: true,
      lingerOf: () => true,
      ask: async (question) => {
        seen.asked.push(question);
        return answers.shift() ?? null;
      },
      askHidden: async (label) => {
        seen.asked.push(label);
        return secrets.shift() ?? null;
      },
      run,
      checkKey: async (options) => {
        seen.checked.push(options);
        return keys.shift() ?? { ok: true };
      },
      startAgent: async (launch) => {
        seen.launched = launch;
        seen.outAtLaunch = seen.out.length;
        return 0;
      },
      ...over,
    },
  };
}

async function runSetup(dir: string, argv: string[], made: { world: SetupWorld; seen: Seen }): Promise<number> {
  return setup({
    root: join(dir, 'connectome-host'), argv,
    out: (line) => { made.seen.out.push(line); },
    err: (line) => { made.seen.err.push(line); },
  }, made.world);
}

const text = (lines: string[]) => lines.join('\n');
const KEY = 'sk-ant-api03-test-key';

test('setup sets up Discord alone, and names it when asked for anything else', async () => {
  const dir = directory();
  for (const argv of [['telegram'], [], ['discord', 'now']]) {
    const made = world(dir);
    expect(await runSetup(dir, argv, made)).toBe(2);
    expect(text(made.seen.err)).toContain('connectome setup discord');
    expect(text(made.seen.err)).toContain('Discord is the one surface setup sets a resident up on.');
    expect(made.seen.asked).toEqual([]);
  }
  expect(readdirSync(dir)).toEqual([]);
});

test('the package\'s bin, without a terminal, says setup needs a person at one and leaves the directory as it was',
  async () => {
    const dir = directory();
    const child = spawn(process.execPath, [BIN, 'setup', 'discord'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.stdin.end();
    const status = await new Promise<number | null>((done) => child.on('close', done));
    expect(status).toBe(1);
    expect(err).toContain('needs a person at a terminal');
    expect(readdirSync(dir)).toEqual([]);
  });

test('a directory holding other files and no install is refused, naming the line that makes one', async () => {
  const dir = directory();
  writeFileSync(join(dir, '.bashrc'), '# mine\n');
  const made = world(dir);
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain('mkdir ~/<name> && cd ~/<name>');
  expect(text(made.seen.err)).toContain(`bunx @animalabs/connectome-host@${VERSION} setup discord`);
  expect(made.seen.asked).toEqual([]);
  expect(readdirSync(dir)).toEqual(['.bashrc']);
});

test('with a shell, a user of its own is the default: setup shows the root lines and the next ones, and installs nothing',
  async () => {
    const dir = directory();
    const made = world(dir, { answers: ['yes', '', ''] });
    expect(await runSetup(dir, ['discord'], made)).toBe(0);
    const out = text(made.seen.out);
    for (const line of [
      'sudo useradd -m -s /bin/bash connectome',
      'sudo loginctl enable-linger connectome',
      'sudo -iu connectome bash -c \'curl -fsSL https://bun.sh/install | bash\'',
      `Setup needs Node ${NODE_FLOOR} or later there too, and at most Node 24: if this machine's Node is installed for your user alone, as one from nvm is, install Node for connectome as well.`,
      'sudo -iu connectome\n',
      'mkdir ~/<name> && cd ~/<name>',
      `bunx @animalabs/connectome-host@${VERSION} setup discord`,
      '"this user"',
    ]) expect(`${out}\n`).toContain(line);
    expect(made.seen.ran).toEqual([]);
    expect(readdirSync(dir)).toEqual(['.setup']);
    expect(readdirSync(join(dir, '.setup'))).toEqual(['setup.lock']);
  });

test('without a shell, a user of its own chosen is told it needs Node at the floor, with no maximum', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', '1', ''] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.out).toContain(`Setup needs Node ${NODE_FLOOR} or later there too: if this machine's Node is installed for your user alone, as one from nvm is, install Node for connectome as well.`);
  expect(made.seen.ran).toEqual([]);
});

test('where setup can\'t offer a user of its own, it offers this user alone and says what that gives up', async () => {
  for (const over of [{ hasSudo: false }, { platform: 'darwin' as const }]) {
    const dir = directory();
    const made = world(dir, { answers: ['yes', 'no'] }, over);
    const status = await runSetup(dir, ['discord'], made);
    expect(made.seen.asked[1]).toContain('Go on as alice?');
    expect(status).toBe(0);
    expect(text(made.seen.out)).toContain('With a shell, the resident can read and change whatever alice can (your files, your keys and your other programs), and whoever talks to it on Discord can ask it to.');
    expect(text(made.seen.out)).toContain('Nothing was installed.');
    expect(made.seen.ran).toEqual([]);
    expect(readdirSync(dir)).toEqual(['.setup']);
    expect(readdirSync(join(dir, '.setup'))).toEqual(['setup.lock']);
  }
});

test('on Linux with sudo, a resident with a shell run as this user is told what that gives up, and one without a shell isn\'t', async () => {
  const isolation = 'With a shell, the resident can read and change whatever alice can (your files, your keys and your other programs), and whoever talks to it on Discord can ask it to.';
  const dir = directory();
  const withShell = world(dir, { answers: ['yes', '2'], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], withShell)).toBe(0);
  expect(text(withShell.seen.out)).toContain(isolation);
  const other = directory();
  const without = world(other, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(other, ['discord'], without)).toBe(0);
  expect(text(without.seen.out)).not.toContain(isolation);
});

test('before its first question setup says what it does, the choices of who the resident runs as say whom each fits and what 1 takes, and the key\'s question says Enter alone stops', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  let outAtFirstQuestion: number | undefined;
  const { ask } = made.world;
  made.world.ask = async (question) => {
    outAtFirstQuestion ??= made.seen.out.length;
    return ask(question);
  };
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const opening = made.seen.out.indexOf(`Setup asks a few questions first. If the resident is to run as this user, alice, setup then installs connectome-host ${VERSION} in ${dir} (about 0.8 GB of disk with the install's own copy of it, or 1.1 GB with a shell for the resident), unless that version is there already, checks an API key, and starts the host's setup agent, which talks with you in this terminal to set up the resident: an agent of yours on Discord that this install runs.`);
  expect(opening).toBeGreaterThanOrEqual(0);
  expect(opening).toBeLessThan(outAtFirstQuestion!);
  const shellSaid = made.seen.out.indexOf('A shell lets the resident run commands on this machine as the user it runs as, which setup settles next: it can read and change whatever that user can, and whoever talks to it on Discord can ask it to.');
  expect(shellSaid).toBeGreaterThan(opening);
  expect(shellSaid).toBeLessThan(outAtFirstQuestion!);
  expect(made.seen.asked[0]).toBe('Does the resident get a shell? (yes/no) ');
  expect(made.seen.out).toContain('  1. a user of its own: setup shows the lines that make it, to run where you can use sudo, and you run setup again as that user');
  expect(made.seen.out).toContain('  2. this user, alice: for a resident with no shell, or where alice already is the resident\'s own user');
  expect(made.seen.out).toContain(`Making ${join(dir, 'connectome-host')} an install that updates when you ask: its host's /update commands say whether a newer release is out, install it and restart onto it. Its first release is a copy of what's installed here.`);
  expect(made.seen.asked).toContain('An Anthropic API key, from console.anthropic.com\'s API keys, typed hidden (Enter alone stops setup)');
  const again = world(dir);
  expect(await runSetup(dir, ['discord'], again)).toBe(0);
  expect(text(again.seen.out)).not.toContain('Setup asks a few questions');
});

test('setup never runs sudo, whatever is chosen', async () => {
  for (const answers of [['yes', '1', 'resident'], ['no', '2']]) {
    const dir = directory();
    const made = world(dir, { answers, secrets: [KEY] });
    await runSetup(dir, ['discord'], made);
    expect(made.seen.ran.flat().some((word) => word.includes('sudo'))).toBe(false);
    if (answers[1] === '2') expect(made.seen.launched).not.toBeNull();
  }
});

test('run as this user, setup shows the line that turns linger on when it\'s off, and goes on', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { lingerOf: (user) => (user === 'alice' ? false : true) });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(text(made.seen.out)).toContain('sudo loginctl enable-linger alice');
  expect(made.seen.launched).not.toBeNull();
});

test('from an empty directory, setup installs, writes the install\'s command, checks the key, and starts its agent', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['yes', '2'], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const added = made.seen.ran.find((argv) => args(argv)[0] === 'add')!;
  expect(args(added).slice(1).sort()).toEqual(
    [`@animalabs/connectome-host@${VERSION}`, '@animalabs/discord-mcpl', 'term-sessions-mcp'].sort());
  const root = join(dir, 'connectome-host');
  expect(existsSync(join(root, 'install.json'))).toBe(true);
  expect(statSync(join(dir, 'data')).isDirectory()).toBe(true);
  expect(existsSync(join(root, 'connectome'))).toBe(true);
  expect(text(made.seen.out)).toContain(`This install's own command is ${join(root, 'connectome')}.`);
  expect(text(made.seen.out)).toContain('Nothing setup or its agent does needs its directory on your PATH, so you need it there only to type plain `connectome`. For that, put it on your PATH, and in ~/.bashrc (or your shell\'s own file) to keep it there:');
  expect(text(made.seen.out)).toContain(`export PATH=${root}:"$PATH"`);
  expect(readEnvFile(join(dir, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  expect(made.seen.checked).toEqual([{ key: KEY, model: SETUP_MODEL }]);
  expect(statSync(join(dir, 'data')).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, '.setup', 'setup-state.json')).mode & 0o777).toBe(0o600);
  expect(made.seen.launched).not.toBeNull();
});

const keptOutsideBlock = (dir: string) => [
  `${EXTRA_STATE_LINE}: an update copies the data directory, ${join(dir, 'data')}, and outside it only the places listed here:`,
  '  /srv/mcpl-state',
  `${LIST_A_PLACE}, run setup again with every place: \`setup --extra-state /srv/mcpl-state --extra-state PATH\`.`,
];

test('of the install\'s own setup\'s lines, setup shows its first at once, its list of the state an update copies from outside the data directory as its last words once its agent has ended, not its service\'s, and its own command once', async () => {
  const dir = directory();
  const root = join(dir, 'connectome-host');
  const block = keptOutsideBlock(dir);
  const service = `The service starts the host with \`bun ${join(root, ENTRY_POINT)}\`, followed by the arguments it gives the host now; set that, and restart it.`;
  const command = `This install's own command is ${join(root, 'connectome')}.`;
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], installSetupSays: [...block, service, command, ''].join('\n') });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const first = made.seen.out.findIndex((line) => line.startsWith(`Set up ${root} as the install of`));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(first).toBeLessThan(made.seen.outAtLaunch!);
  expect(made.seen.out.slice(made.seen.outAtLaunch!)).toEqual(block);
  expect(text(made.seen.out)).not.toContain(service);
  expect(made.seen.out.filter((line) => line === command)).toHaveLength(1);
});

test('the list of the state kept outside the data directory comes whatever status the agent\'s run ends with, 1 or 130', async () => {
  for (const status of [1, 130]) {
    const dir = directory();
    const block = keptOutsideBlock(dir);
    const made = world(dir, { answers: ['no', ''], secrets: [KEY], installSetupSays: [...block, ''].join('\n') }, {
      startAgent: async (launch) => {
        made.seen.launched = launch;
        made.seen.outAtLaunch = made.seen.out.length;
        return status;
      },
    });
    expect(await runSetup(dir, ['discord'], made)).toBe(status);
    expect(made.seen.out.slice(made.seen.outAtLaunch!), String(status)).toEqual(block);
  }
});

test('a run that stops before its agent starts shows no list of the state kept outside the data directory: it didn\'t finish', async () => {
  const dir = directory();
  const block = keptOutsideBlock(dir);
  const made = world(dir, { answers: ['no', ''], secrets: [], installSetupSays: [...block, ''].join('\n') });
  await runSetup(dir, ['discord'], made);
  expect(made.seen.launched).toBeNull();
  expect(text(made.seen.out)).not.toContain(EXTRA_STATE_LINE);
});

test('without a shell, the resident\'s shell isn\'t installed', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const added = made.seen.ran.find((argv) => args(argv)[0] === 'add')!;
  expect(added).not.toContain('term-sessions-mcp');
  expect(added).toContain('@animalabs/discord-mcpl');
});

test('a no-shell answer is kept as no shell for a run again, and the agent is told it gets no shell; a yes, that it gets one', async () => {
  const dir = directory();
  const first = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], first)).toBe(0);
  expect(first.seen.launched!.env.CONNECTOME_SETUP_SHELL).toBe('gets no shell');
  const again = world(dir);
  expect(await runSetup(dir, ['discord'], again)).toBe(0);
  expect(again.seen.asked).toEqual([]);
  expect(again.seen.launched!.env.CONNECTOME_SETUP_SHELL).toBe('gets no shell');
  expect(again.seen.ran.flat().some((word) => word.includes('term-sessions-mcp'))).toBe(false);
  const other = directory();
  const shell = world(other, { answers: ['yes', '2'], secrets: [KEY] });
  expect(await runSetup(other, ['discord'], shell)).toBe(0);
  expect(shell.seen.launched!.env.CONNECTOME_SETUP_SHELL).toBe('gets a shell');
});

test('run again, setup asks nothing it was answered, installs nothing that\'s there, and goes on to its agent', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['yes', '2'], secrets: [KEY] }))).toBe(0);
  const again = world(dir);
  const status = await runSetup(dir, ['discord'], again);
  expect(again.seen.asked).toEqual([]);
  expect(status).toBe(0);
  expect(again.seen.ran.some((argv) => args(argv)[0] === 'add')).toBe(false);
  expect(again.seen.checked.map((each) => each.key)).toEqual([KEY]);
  expect(again.seen.launched).not.toBeNull();
});

test('kept answers setup can\'t read are asked again', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup-state.json'), '{"v": 1, "sh');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.asked[0]).toContain('Does the resident get a shell');
  expect(text(made.seen.err)).toContain(`Setup's kept answers in ${join(dir, '.setup', 'setup-state.json')} can't be read`);
});

async function script(body: string): Promise<{ status: number | null; out: string; err: string }> {
  const load = `const { realWorld } = await import(${JSON.stringify(join(REPO, 'src', 'cli', 'setup.ts'))});`;
  const child = spawn(process.execPath, ['-e', `${load}\n${body}`], { cwd: directory(), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.stdin.end();
  const status = await new Promise<number | null>((done) => child.on('close', done));
  return { status, out, err };
}

test('a terminal that closes at a question gives the question no answer', async () => {
  const ran = await script('console.log(JSON.stringify(await realWorld().ask("Does the resident get a shell? ")));');
  expect(ran.status).toBe(0);
  expect(ran.out.trim()).toBe('Does the resident get a shell? null');
});

test('a Ctrl-C to setup while its agent runs leaves setup waiting for the agent, with the agent\'s exit status', async () => {
  const ran = await script(`
    const { existsSync, writeFileSync } = await import('node:fs');
    const sent = setInterval(() => {
      if (!existsSync('running')) return;
      clearInterval(sent);
      process.kill(process.pid, 'SIGINT');
      writeFileSync('signalled', '');
    }, 10);
    const agent = "const fs = require('fs'); fs.writeFileSync('running', ''); setTimeout(() => process.exit(3), 10000); " +
      "setInterval(() => { if (fs.existsSync('signalled')) process.exit(7); }, 10);";
    const status = await realWorld().startAgent({ argv: [process.execPath, '-e', agent], cwd: process.cwd(), env: process.env });
    console.log('the agent ended', status);
  `);
  expect(ran.out).toContain('the agent ended 7');
  expect(ran.status).toBe(0);
}, 30_000);

test('a signal that ends the agent\'s host is named, and setup answers its status', async () => {
  const ran = await script(`
    const status = await realWorld().startAgent({ argv: [process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'], cwd: process.cwd(), env: process.env });
    console.log('the agent ended', status);
  `);
  expect(ran.out).toContain('the agent ended 143');
  expect(ran.err).toContain('connectome setup: the agent\'s host was ended by SIGTERM. Setup\'s answers and key are kept, so running setup again in this directory goes on.');
}, 30_000);

test('the preflight stops setup before anything is installed, saying what\'s wrong and how to put it right', async () => {
  const cases: Array<{ script: Script; over?: Partial<SetupWorld>; shell: 'yes' | 'no'; says: string[] }> = [
    { script: {}, over: { bun: { path: process.execPath, version: '1.4.2' } }, shell: 'no', says: ['Bun 1.4.2', 'bun upgrade'] },
    {
      script: {}, over: { bun: { path: process.execPath, version: '1.4.3' } }, shell: 'no',
      says: ['Setup needs Bun 1.4.4 or later', 'this is Bun 1.4.3', 'bun upgrade'],
    },
    { script: { node: null }, shell: 'no', says: ['didn\'t answer here (there\'s no node on this PATH)', 'nodejs.org'] },
    {
      script: { nodeRan: { status: null, stdout: '', stderr: '', startError: { code: 'EACCES', message: 'EACCES: permission denied, posix_spawn \'node\'' } } },
      shell: 'no', says: ['didn\'t answer here (it couldn\'t be started (EACCES: permission denied, posix_spawn \'node\'))'],
    },
    { script: { nodeRan: { status: null, stdout: '', stderr: '', signal: 'SIGKILL' } }, shell: 'no', says: ['didn\'t answer here (it was ended by SIGKILL)'] },
    { script: { node: '22.11.0' }, shell: 'no', says: ['Node 22.11.0', 'Node 22.12.0 or later'] },
    { script: { node: '25.1.0' }, shell: 'yes', says: ['Node 24 at most', 'Node 25.1.0'] },
  ];
  for (const { script, over, shell, says } of cases) {
    const dir = directory();
    const made = world(dir, { ...script, answers: [shell, '2'] }, over);
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
    for (const words of says) expect(text(made.seen.err)).toContain(words);
    expect(made.seen.ran.some((argv) => args(argv)[0] === 'add')).toBe(false);
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
  }
  const dir = directory();
  const later = world(dir, { node: '25.1.0', answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], later)).toBe(0);
});

test('the boot check starts the installed host for real, and a host that doesn\'t start stops setup before the key',
  async () => {
    const dir = directory();
    const made = world(dir, { answers: ['no', ''], secrets: [KEY], boot: 'real' });
    expect(await runSetup(dir, ['discord'], made)).toBe(0);
    expect(text(made.seen.out)).toContain(`The installed host (${VERSION}) starts.`);

    const broken = directory();
    const stub = join(directory(), 'connectome-host');
    mkdirSync(join(stub, 'src'), { recursive: true });
    writeFileSync(join(stub, 'src', 'index.ts'), 'console.error("Cannot find module \'@opentui/core-linux-x64\'");\nprocess.exit(1);\n');
    cpSync(join(REPO, 'recipes'), join(stub, 'recipes'), { recursive: true });
    const failing = world(broken, { answers: ['no', ''], secrets: [KEY], boot: 'real', host: stub });
    expect(await runSetup(broken, ['discord'], failing)).toBe(1);
    expect(text(failing.seen.err)).toContain('doesn\'t start');
    expect(text(failing.seen.err)).toContain('@opentui/core-linux-x64');
    expect(text(failing.seen.err)).toContain('Where the host\'s own lines above name something of this machine\'s, such as a file it can\'t read, put that right. Where they name the host\'s code or a package it brings, such as a module it can\'t find, that\'s for its makers: report them, with this output, at https://github.com/anima-research/connectome-host/issues.');
    expect(text(failing.seen.err)).toContain(`rm -rf ${join(broken, 'connectome-host')} ${join(broken, 'node_modules')}`);
    expect(failing.seen.asked).toEqual(['Does the resident get a shell? (yes/no) ',
      'Choose 1 or 2 [2]: ']);
    expect(failing.seen.checked).toEqual([]);
  }, 60_000);

test('an install whose record is missing while its root holds anything a first run doesn\'t make before its record is named, with no way to a fresh start; a first run cut off before its record is given one', async () => {
  const dir = directory();
  const root = join(dir, 'connectome-host');
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  rmSync(join(root, 'install.json'));
  writeFileSync(join(dir, 'data', 'session.json'), '{}');
  const gone = { status: 1, stdout: '', stderr: 'connectome-host setup: its record is gone.\n' };
  const says = (name: string) => `${join(root, 'install.json')} is missing, and ${root} holds ${name}, which a first run doesn't make before its record, so taking ${root} away isn't known to lose nothing. Setup takes none of it away.`;
  const steps: Array<[string, () => void]> = [
    ['connectome', () => {}],
    ['start.js', () => rmSync(join(root, 'connectome'))],
    ['journal.jsonl', () => {
      rmSync(join(root, 'start.js'));
      writeFileSync(join(root, 'journal.jsonl'), '');
    }],
    ['journal.jsonl', () => {
      rmSync(join(root, 'current'));
      rmSync(join(root, 'releases'), { recursive: true });
    }],
    ['connectome.tmp', () => {
      rmSync(join(root, 'journal.jsonl'));
      writeFileSync(join(root, 'connectome.tmp'), '');
    }],
    ['start.js', () => {
      rmSync(join(root, 'connectome.tmp'));
      symlinkSync(join(root, 'nowhere'), join(root, 'start.js'));
    }],
  ];
  for (const [name, change] of steps) {
    change();
    const again = world(dir, { installSetup: gone });
    expect(await runSetup(dir, ['discord'], again)).toBe(1);
    expect(text(again.seen.err), name).toContain(says(name));
    expect(text(again.seen.err), name).not.toContain('rm -rf');
  }
  rmSync(join(root, 'start.js'));
  symlinkSync(join(root, 'nowhere'), join(root, 'install.json'));
  const linked = world(dir, { installSetup: gone });
  expect(await runSetup(dir, ['discord'], linked)).toBe(1);
  expect(text(linked.seen.err)).toContain(`${join(root, 'install.json')} is a link that leads nowhere, so taking ${root} away isn't known to lose nothing. Setup takes none of it away`);
  expect(text(linked.seen.err)).not.toContain('rm -rf');

  const cut = directory();
  const cutRoot = join(cut, 'connectome-host');
  const failing = { status: 1, stdout: '', stderr: 'error: disk full\n' };
  expect(await runSetup(cut, ['discord'], world(cut, { answers: ['no', ''], installSetup: failing }))).toBe(1);
  mkdirSync(join(cutRoot, 'releases', `${VERSION}.tmp`), { recursive: true });
  symlinkSync(join('releases', VERSION), join(cutRoot, 'current.tmp'));
  writeFileSync(join(cutRoot, 'install.json.tmp'), '');
  const copying = world(cut, { installSetup: failing });
  expect(await runSetup(cut, ['discord'], copying)).toBe(1);
  expect(text(copying.seen.err)).not.toContain('is missing');
  expect(text(copying.seen.err)).toContain(`Nothing of the resident's is in ${join(cut, 'data')} yet, the install records nothing kept outside it, and ${cutRoot} holds only the names a first run makes there. Once what the lines above say is put right, this takes it and the packages away, and setup run again installs afresh:`);
  expect(text(copying.seen.err)).toContain(`rm -rf ${cutRoot} ${join(cut, 'node_modules')}`);
  rmSync(join(cutRoot, 'releases'), { recursive: true });
  rmSync(join(cutRoot, 'current.tmp'));
  rmSync(join(cutRoot, 'install.json.tmp'));
  mkdirSync(join(cutRoot, 'releases', VERSION), { recursive: true });
  symlinkSync(join('releases', VERSION), join(cutRoot, 'current'));
  const one = world(cut, { installSetup: failing });
  expect(await runSetup(cut, ['discord'], one)).toBe(1);
  expect(text(one.seen.err)).not.toContain('is missing');
  expect(text(one.seen.err)).toContain(`rm -rf ${cutRoot} ${join(cut, 'node_modules')}`);
  mkdirSync(join(cutRoot, 'releases', '0.0.1-older'));
  const two = world(cut, { installSetup: failing });
  expect(await runSetup(cut, ['discord'], two)).toBe(1);
  expect(text(two.seen.err)).toContain(`${cutRoot} holds more than a first run makes. Setup takes none of it away`);
  expect(text(two.seen.err)).not.toContain('rm -rf');
  rmSync(join(cutRoot, 'current'));
  rmSync(join(cutRoot, 'releases'), { recursive: true });
  writeFileSync(join(cutRoot, 'releases'), '');
  const releasesFile = world(cut, { installSetup: failing });
  expect(await runSetup(cut, ['discord'], releasesFile)).toBe(1);
  expect(text(releasesFile.seen.err)).toContain(`${join(cutRoot, 'releases')} can't be read (ENOTDIR). Setup takes none of it away`);
  expect(text(releasesFile.seen.err)).not.toContain('rm -rf');
  rmSync(join(cutRoot, 'releases'));
  mkdirSync(join(cutRoot, 'releases'), { mode: 0o000 });
  try {
    const unreadable = world(cut, { installSetup: failing });
    expect(await runSetup(cut, ['discord'], unreadable)).toBe(1);
    expect(text(unreadable.seen.err)).toContain(`${join(cutRoot, 'releases')} can't be read (EACCES). Setup takes none of it away`);
    expect(text(unreadable.seen.err)).not.toContain('rm -rf');
  } finally {
    chmodSync(join(cutRoot, 'releases'), 0o700);
  }
});

test('in a directory whose name needs quoting, the line that picks setup up again quotes the install\'s command', async () => {
  const dir = join(directory(), 'my resident');
  mkdirSync(dir);
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const line = made.seen.out[made.seen.outAtLaunch! - 1]!;
  expect(line).toContain(`\`'${join(dir, 'connectome-host', 'connectome')}' setup discord\` picks it up where it stopped`);
});

test('setup says where the install\'s own command is, and gives no PATH line where its directory is on PATH', async () => {
  const dir = directory();
  const root = join(dir, 'connectome-host');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { env: { PATH: `/usr/bin:${root}:/bin`, HOME: dir } });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(text(made.seen.out)).toContain(`This install's own command is ${join(root, 'connectome')}.`);
  expect(text(made.seen.out)).not.toContain('export PATH=');
});

test('an install whose release has no setup agent says so, and asks for no key', async () => {
  const dir = directory();
  const stub = join(directory(), 'connectome-host');
  mkdirSync(join(stub, 'src'), { recursive: true });
  writeFileSync(join(stub, 'src', 'index.ts'), 'console.log("Done.");\n');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], boot: 'real', host: stub, release: '0.0.1-older' });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain('The release this install runs, 0.0.1-older, has no setup agent');
  expect(text(made.seen.err)).toContain('/update');
  expect(made.seen.asked).toHaveLength(2);
  expect(made.seen.checked).toEqual([]);
});

test('a setup agent\'s recipe that can\'t be read, isn\'t JSON, or names no model, is named as a damaged copy before the boot check and the key', async () => {
  const cases = [[null, 'can\'t be read (EISDIR)'], ['{"agent": {', 'isn\'t JSON'], ['{"agent": {"name": "setup"}}', 'names no agent.model']] as const;
  for (const [recipe, says] of cases) {
    const dir = directory();
    const stub = join(directory(), 'connectome-host');
    mkdirSync(join(stub, 'src'), { recursive: true });
    mkdirSync(join(stub, 'recipes'));
    writeFileSync(join(stub, 'src', 'index.ts'), 'console.log("Done.");\n');
    if (recipe === null) mkdirSync(join(stub, 'recipes', 'setup.json'));
    else writeFileSync(join(stub, 'recipes', 'setup.json'), recipe);
    const made = world(dir, { answers: ['no', ''], secrets: [KEY], host: stub });
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
    const shown = join(dir, 'connectome-host', 'releases', VERSION, 'node_modules', '@animalabs', 'connectome-host', 'recipes', 'setup.json');
    expect(text(made.seen.err)).toContain(`${shown}, the setup agent's recipe in the release this install runs (${VERSION}), ${says}: the copy is damaged.`);
    expect(text(made.seen.err)).toContain(`rm -rf ${join(dir, 'connectome-host')} ${join(dir, 'node_modules')}`);
    expect(made.seen.boot).toBeUndefined();
    expect(made.seen.checked).toEqual([]);
  }
});

test('an exported key is used with the person\'s yes, and only then', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', '', 'yes'] }, { env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: KEY } });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.asked.some((question) => question.includes('exported'))).toBe(true);
  expect(readEnvFile(join(dir, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
  expect(text(made.seen.out)).not.toContain('exported in this shell isn\'t');

  const other = directory();
  const declined = world(other, { answers: ['no', '', 'no'], secrets: ['sk-ant-typed'] },
    { env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: KEY } });
  expect(await runSetup(other, ['discord'], declined)).toBe(0);
  expect(readEnvFile(join(other, '.env')).get('ANTHROPIC_API_KEY')).toBe('sk-ant-typed');
  expect(declined.seen.checked.map((each) => each.key)).toEqual(['sk-ant-typed']);
});

test('a key that fails names the cause and asks again, and Enter alone stops with nothing stored', async () => {
  const dir = directory();
  const refused = { ok: false as const, cause: 'api.anthropic.com refused the key (401).', anotherKeyMayHelp: true };
  const made = world(dir, { answers: ['no', ''], secrets: ['sk-ant-wrong', KEY], keys: [refused, { ok: true }] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(text(made.seen.err)).toContain('refused the key (401)');
  expect(readEnvFile(join(dir, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);

  const other = directory();
  const stopping = world(other, { answers: ['no', ''], secrets: ['sk-ant-wrong', ''], keys: [refused] });
  expect(await runSetup(other, ['discord'], stopping)).toBe(1);
  expect(existsSync(join(other, '.env'))).toBe(false);
  expect(stopping.seen.launched).toBeNull();
});

test('before its agent starts, setup names its model and prices, and says a setup\'s length isn\'t measured', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const at = made.seen.out.findIndex((each) => each.includes(`Setup's agent runs on ${SETUP_MODEL}`));
  expect(at).toBeGreaterThanOrEqual(0);
  const line = made.seen.out[at]!;
  expect(line).toContain('$4 input, $20 output');
  // agent-framework caches for an hour unless told otherwise, so the cache's price is its 1-hour write.
  expect(line).toContain('$8 written to the prompt cache');
  expect(line).toContain('$0.20 read from it');
  expect(line).toContain('isn\'t measured yet');
  expect(at).toBeLessThan(made.seen.outAtLaunch!);
});

test('the agent runs from the release current names, on setup\'s recipe and data, with the key setup checked, and starts in .setup, where no mcpl-servers.json or agent overlay is, so the resident\'s servers and overlay don\'t reach it',
  async () => {
    const dir = directory();
    const root = join(dir, 'connectome-host');
    const moveCurrent = () => {
      const scope = join(root, 'releases', '0.0.3-moved', 'node_modules', '@animalabs');
      mkdirSync(scope, { recursive: true });
      symlinkSync(REPO, join(scope, 'connectome-host'));
      unlinkSync(join(root, 'current'));
      symlinkSync(join('releases', '0.0.3-moved'), join(root, 'current'));
    };
    const made = world(dir, { answers: ['yes', '2'], secrets: [KEY], release: '0.0.2-current', duringBoot: moveCurrent }, {
      env: {
        PATH: '/usr/bin', MODEL: 'claude-haiku-4-5', ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat-mine', CONNECTOME_INSTALL_ROOT: '/x',
        ANTHROPIC_OAUTH_CREDENTIALS_FILE: '/home/alice/oauth-copy.json', MCPL_AGENT_OVERLAY_FILE: '/srv/resident-overlay.json',
      },
    });
    expect(await runSetup(dir, ['discord'], made)).toBe(0);
    const launch = made.seen.launched!;
    const host = join(dir, 'connectome-host', 'releases', '0.0.2-current', 'node_modules', '@animalabs', 'connectome-host');
    expect(launch.argv.slice(1)).toEqual(['--no-env-file', join(host, 'src', 'index.ts'), join(host, 'recipes', 'setup.json'), '--no-tui']);
    expect(launch.cwd).toBe(join(dir, '.setup'));
    expect(existsSync(join(dir, '.setup', 'mcpl-servers.json'))).toBe(false);
    expect(existsSync(join(dir, '.setup', 'mcpl-servers.agent.json'))).toBe(false);
    expect(launch.env.CONNECTOME_SETUP_DIR).toBe(dir);
    expect(launch.env.DATA_DIR).toBe(join(dir, '.setup'));
    expect(launch.env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(launch.env.CONNECTOME_SETUP_VERSION).toBe('0.0.2-current');
    for (const name of ['MODEL', 'ANTHROPIC_AUTH_TOKEN', 'CONNECTOME_INSTALL_ROOT', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'MCPL_AGENT_OVERLAY_FILE']) {
      expect(launch.env[name], name).toBeUndefined();
    }
    expect(made.seen.boot!.env.MCPL_AGENT_OVERLAY_FILE).toBeUndefined();
    const line = made.seen.out[made.seen.outAtLaunch! - 1]!;
    expect(line).toContain('say hello to begin');
    expect(line).toContain(`/quit leaves the conversation, and \`${join(dir, 'connectome-host', 'connectome')} setup discord\``);
  });

test('setup\'s help names where it works: the directory that holds the install, or from bunx the one it runs in', () => {
  expect(SETUP_SUMMARY).toContain('in the directory that holds the install (from bunx, the directory it runs in)');
});

test('setup\'s agent\'s host checks for no update on its own, whatever the person\'s shell exports: it can\'t take the update a notice would offer', async () => {
  for (const exported of [{}, { CONNECTOME_UPDATE_CHECK: '1' }]) {
    const dir = directory();
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { env: { PATH: '/usr/bin:/bin', HOME: dir, ...exported } });
    expect(await runSetup(dir, ['discord'], made)).toBe(0);
    const update = new HostUpdate();
    update.configure({
      here: null, running: '0.0.0', env: made.seen.launched!.env,
      host: { framework: () => { throw new Error('not reached'); }, fleet: () => null },
    });
    expect(update.checksOn(), JSON.stringify(exported)).toBe(false);
  }
});

test('nothing Bun gave setup from .env reaches the programs it runs or its agent, once .env has changed too, and Bun loads no .env into them',
  async () => {
    const dir = directory();
    mkdirSync(join(dir, '.setup'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'DISCORD_TOKEN="from-dot-env"\n');
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, {
      env: { PATH: '/usr/bin:/bin', HOME: dir, DISCORD_TOKEN: 'from-dot-env', KEEP_ME: 'kept' },
      checkKey: async () => {
        writeFileSync(envFile, readFileSync(envFile, 'utf-8').replace('from-dot-env', 'replaced-meanwhile'));
        return { ok: true };
      },
    });
    expect(await runSetup(dir, ['discord'], made)).toBe(0);
    expect(made.seen.ran.some((argv) => args(argv)[0] === 'add')).toBe(true);
    for (const [at, options] of made.seen.options.entries()) {
      const argv = made.seen.ran[at]!;
      expect(options.env.DISCORD_TOKEN, argv.join(' ')).toBeUndefined();
      expect(options.env.KEEP_ME, argv.join(' ')).toBe('kept');
      if (argv[0] === process.execPath && !argv[1]!.endsWith(join('src', 'index.ts'))) {
        expect(argv[1], argv.join(' ')).toBe('--no-env-file');
      }
    }
    const launch = made.seen.launched!;
    expect(launch.env.DISCORD_TOKEN).toBeUndefined();
    expect(launch.env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(launch.env.KEEP_ME).toBe('kept');
    expect(launch.env.PATH).toBe('/usr/bin:/bin');
  });

test('nothing Bun gave setup from any dotenv file of the directory it was started in reaches its programs or its agent, whatever NODE_ENV is', async () => {
  const started = directory();
  const files = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local',
    '.env.test', '.env.test.local'];
  const names = files.map((file) => `FROM${file.toUpperCase().replace(/\./g, '_')}`);
  for (const [at, file] of files.entries()) writeFileSync(join(started, file), `${names[at]}=value-of-${file}\n`);
  for (const mode of [undefined, 'production', 'test']) {
    const ran = Bun.spawnSync([process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      cwd: started, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(mode === undefined ? {} : { NODE_ENV: mode }) },
    });
    const given = JSON.parse(ran.stdout.toString()) as Record<string, string>;
    const loaded = names.filter((name) => given[name] !== undefined);
    expect(loaded.length, String(mode)).toBeGreaterThanOrEqual(3);
    const dir = directory();
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { cwd: started, env: { ...given, KEEP_ME: 'kept' } });
    expect(await runSetup(dir, ['discord'], made)).toBe(0);
    for (const env of [...made.seen.options.map((options) => options.env), made.seen.launched!.env]) {
      for (const name of loaded) expect(env[name], `${mode} ${name}`).toBeUndefined();
      expect(env.KEEP_ME).toBe('kept');
    }
  }
});

test('a name the shell exports that a plain object inherits, such as toString, reaches setup\'s agent like any other', async () => {
  const dir = directory();
  const env = { PATH: '/usr/bin:/bin', HOME: dir, toString: 'exported-to-string', constructor: 'exported-constructor' };
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { env });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(Object.hasOwn(made.seen.launched!.env, 'toString') && made.seen.launched!.env.toString).toBe('exported-to-string');
  expect(Object.hasOwn(made.seen.launched!.env, 'constructor') && made.seen.launched!.env.constructor).toBe('exported-constructor');
});

test('a .env.tmp a write cut off left beside .env is taken away before setup does anything else', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  const tmp = join(dir, '.env.tmp');
  writeFileSync(tmp, 'ANTHROPIC_API_KEY="cut-off-value"\n', { mode: 0o600 });
  const answers = ['no', ''];
  const there: boolean[] = [];
  const asking = world(dir, { secrets: [KEY] }, {
    ask: async () => {
      there.push(existsSync(tmp));
      return answers.shift() ?? null;
    },
  });
  expect(await runSetup(dir, ['discord'], asking)).toBe(0);
  expect(there).toEqual([false, false]);

  writeFileSync(tmp, 'ANTHROPIC_API_KEY="cut-off-value"\n', { mode: 0o600 });
  const atFirstStep: boolean[] = [];
  const again = world(dir, {}, {
    lingerOf: () => {
      atFirstStep.push(existsSync(tmp));
      return true;
    },
  });
  expect(await runSetup(dir, ['discord'], again)).toBe(0);
  expect(atFirstStep).toEqual([false]);
});

test('a release of setup\'s own version whose copy has no setup agent is named as damaged, with the way to a fresh start',
  async () => {
    const dir = directory();
    const stub = join(directory(), 'connectome-host');
    mkdirSync(join(stub, 'src'), { recursive: true });
    writeFileSync(join(stub, 'src', 'index.ts'), 'console.log("Done.");\n');
    const made = world(dir, { answers: ['no', ''], secrets: [KEY], host: stub });
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
    expect(text(made.seen.err)).toContain('its copy has no');
    expect(text(made.seen.err)).not.toContain('/update');
    expect(text(made.seen.err)).toContain(`rm -rf ${join(dir, 'connectome-host')} ${join(dir, 'node_modules')}`);

    writeFileSync(join(dir, 'data', 'session.json'), '{}');
    const again = world(dir, { host: stub });
    expect(await runSetup(dir, ['discord'], again)).toBe(1);
    expect(text(again.seen.err)).not.toContain('rm -rf');
    expect(text(again.seen.err)).toContain('running setup again stops here again until');
    expect(text(again.seen.err)).toContain('setup doesn\'t mend a release it already made');
  });

test('the agent\'s host takes nothing from the working directory\'s .env that setup didn\'t give it', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  writeFileSync(join(dir, '.env'), `${readFileSync(join(dir, '.env'), 'utf-8')}MODEL=claude-haiku-4-5\nCONNECTOME_INSTALL_ROOT=/x\n`);
  const launch = made.seen.launched!;
  const probe = join(directory(), 'probe.ts');
  writeFileSync(probe, 'console.log(JSON.stringify([process.env.MODEL ?? null, process.env.CONNECTOME_INSTALL_ROOT ?? null, process.env.ANTHROPIC_API_KEY ?? null]));\n');
  const argv = launch.argv.map((word) => (word.endsWith(join('src', 'index.ts')) ? probe : word));
  const ran = Bun.spawnSync(argv, { cwd: launch.cwd, env: launch.env });
  expect(JSON.parse(ran.stdout.toString())).toEqual([null, null, KEY]);
});

test('setup\'s recipe tells its agent who it is, the version, the install, the surface, its guide and SETUP.md', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['yes', '2'], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const { env, argv } = made.seen.launched!;
  const recipePath = argv.find((word) => word.endsWith('setup.json'))!;
  const other = directory();
  const noShell = world(other, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(other, ['discord'], noShell)).toBe(0);
  const child = spawn(process.execPath, ['-e', `
    const { loadRecipeDetailed } = await import(${JSON.stringify(join(REPO, 'src', 'recipe.ts'))});
    const rendered = [];
    let before = {};
    for (const { path, env } of ${JSON.stringify([{ path: recipePath, env }, { path: noShell.seen.launched!.argv.find((word) => word.endsWith('setup.json'))!, env: noShell.seen.launched!.env }])}) {
      for (const name of Object.keys(before)) delete process.env[name];
      Object.assign(process.env, env);
      before = env;
      const { recipe } = await loadRecipeDetailed(path);
      rendered.push({ prompt: recipe.agent.systemPrompt, setup: recipe.modules.setup });
    }
    console.log(JSON.stringify(rendered));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  expect(await new Promise((done) => child.on('close', done))).toBe(0);
  type Rendered = { prompt: string; setup: boolean };
  const [{ prompt, setup: enabled }, without] = JSON.parse(out) as [Rendered, Rendered];
  expect(without.prompt).toContain('the resident gets no shell and runs as alice');
  expect(prompt).toContain('setup--run gives back only the first and last 4 KiB of an output longer than 8 KiB, so read the guide in pieces under 8 KiB, by line range. Follow it, and where it differs from this prompt, this prompt holds.');
  expect(enabled).toBe(true);
  expect(prompt).toContain('setup agent');
  expect(prompt).toContain('aren\'t the resident');
  expect(prompt).toContain(VERSION);
  expect(prompt).toContain(join(dir, 'connectome-host'));
  expect(prompt).toContain('Discord');
  expect(prompt).toContain(join(dirname(recipePath), '..', 'docs', 'AGENT-ONBOARDING.md'));
  expect(prompt).toContain(`SETUP.md in ${dir}`);
  expect(prompt).toContain('the resident gets a shell and runs as alice');
});

test('setup\'s recipe lets its agent use the setup module\'s tools and the clock, and none of a resident\'s', () => {
  const recipe = JSON.parse(readFileSync(join(REPO, 'recipes', 'setup.json'), 'utf-8')) as { agent: { allowedTools: string[] } };
  const setups = new SetupModule({ dir: directory(), env: {}, asker: () => null, show: () => {} }).getTools().map((tool) => `setup--${tool.name}`);
  expect([...recipe.agent.allowedTools].sort()).toEqual([...setups, 'time--now'].sort());
});

test('setup\'s recipe runs its agent on claude-opus-5-5', () => {
  const recipe = JSON.parse(readFileSync(join(REPO, 'recipes', 'setup.json'), 'utf-8')) as { agent: { model: string } };
  expect(recipe.agent.model).toBe('claude-opus-5-5');
});

test('linger reads as systemd keeps it: on for a user with its file, off without, unknown with no systemd', () => {
  const root = directory();
  expect(lingerOf('alice', root)).toBeNull();
  mkdirSync(join(root, 'run', 'systemd', 'system'), { recursive: true });
  expect(lingerOf('alice', root)).toBe(false);
  mkdirSync(join(root, 'var', 'lib', 'systemd', 'linger'), { recursive: true });
  writeFileSync(join(root, 'var', 'lib', 'systemd', 'linger', 'alice'), '');
  expect(lingerOf('alice', root)).toBe(true);
  expect(lingerOf('bob', root)).toBe(false);
});

test('setup\'s agent starts, and leaves the install\'s lock free for its service to start', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], host: 'copy' });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const launch = made.seen.launched!;
  const mock = join(dir, 'mock.json');
  writeFileSync(mock, JSON.stringify({
    name: 'mock', agent: { name: 'mock', provider: 'mock', systemPrompt: 'mock' },
    modules: { wake: false, workspace: false, subscriptionGc: false },
  }));
  const child = spawn(launch.argv[0]!, launch.argv.slice(1).map((word) => (word.endsWith('setup.json') ? mock : word)), {
    cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  const closed = new Promise((done) => child.on('close', done));
  for (const started = Date.now(); !out.includes('[batch]') && Date.now() - started < 30_000;) await Bun.sleep(50);
  expect(out).toContain('[batch]');
  const root = join(dir, 'connectome-host');
  expect(() => takeLock(root, machineOps())).not.toThrow();
  unlinkSync(installPaths(root).lock);
  child.stdin.end();
  expect(await closed).toBe(0);
}, 60_000);

test('a directory holding only setup\'s own .setup/ is setup\'s, so setup goes on there', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.launched).not.toBeNull();
});

async function holdLock(dir: string) {
  mkdirSync(join(dir, '.setup'), { recursive: true });
  const holder = spawn(process.execPath, ['-e', `
    const { Database } = await import('bun:sqlite');
    const db = new Database(${JSON.stringify(join(dir, '.setup', 'setup.lock'))}, { create: true });
    db.exec('PRAGMA busy_timeout = 1000');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    console.log('held');
    // Bun closes a Database once nothing refers to it, which lets its lock go.
    setInterval(() => db, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((done) => holder.stdout!.on('data', (chunk) => { if (String(chunk).includes('held')) done(); }));
  return { kill: () => new Promise<void>((done) => { holder.on('close', () => done()); holder.kill('SIGKILL'); }) };
}

test('one setup at a time in a directory: another running refuses this one before it asks anything, and one killed doesn\'t',
  async () => {
    const dir = directory();
    const holder = await holdLock(dir);
    writeFileSync(join(dir, '.env.tmp'), 'DISCORD_TOKEN="being-written"\n', { mode: 0o600 });
    const refused = world(dir, { answers: ['no', ''], secrets: [KEY] });
    expect(await runSetup(dir, ['discord'], refused)).toBe(1);
    expect(readFileSync(join(dir, '.env.tmp'), 'utf-8')).toBe('DISCORD_TOKEN="being-written"\n');
    expect(text(refused.seen.err)).toContain(`Another setup is running in ${dir}`);
    expect(text(refused.seen.err)).toContain('Wait for it to end, or end it, and run setup again.');
    expect(refused.seen.asked).toEqual([]);
    expect(refused.seen.ran).toEqual([]);
    await holder.kill();
    const after = world(dir, { answers: ['no', ''], secrets: [KEY] });
    expect(await runSetup(dir, ['discord'], after)).toBe(0);
    expect(after.seen.launched).not.toBeNull();
  }, 30_000);

function tryLock(file: string): string {
  const tried = Bun.spawnSync([process.execPath, '-e', `
    const { Database } = await import('bun:sqlite');
    try {
      const db = new Database(${JSON.stringify(file)});
      db.exec('PRAGMA busy_timeout = 1000');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('BEGIN EXCLUSIVE');
      console.log('taken');
    } catch (error) {
      console.log(error.code ?? error.message);
    }
  `]);
  return tried.stdout.toString().trim();
}

test('setup holds its lock while it asks its questions and while its agent runs', async () => {
  const dir = directory();
  const lock = join(dir, '.setup', 'setup.lock');
  const tried: string[] = [];
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  const { ask, askHidden, startAgent } = made.world;
  made.world.ask = async (question) => { tried.push(`ask: ${tryLock(lock)}`); return ask(question); };
  made.world.askHidden = async (label) => { tried.push(`askHidden: ${tryLock(lock)}`); return askHidden(label); };
  made.world.startAgent = async (launch) => { tried.push(`agent: ${tryLock(lock)}`); return startAgent(launch); };
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(tried).toEqual(['ask: SQLITE_BUSY', 'ask: SQLITE_BUSY', 'askHidden: SQLITE_BUSY', 'agent: SQLITE_BUSY']);
  expect(tryLock(lock)).toBe('taken');
}, 30_000);

test('a setup that ends early, or stops at a question, leaves the lock free and its lock file in place', async () => {
  const dir = directory();
  const failed = world(dir, { node: null, answers: ['no', ''] });
  expect(await runSetup(dir, ['discord'], failed)).toBe(1);
  expect(readdirSync(join(dir, '.setup')).sort()).toEqual(['setup-state.json', 'setup.lock']);
  const after = world(dir, { secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], after)).toBe(0);
  expect(after.seen.asked.filter((question) => !question.includes('Anthropic API key'))).toEqual([]);
  expect(after.seen.launched).not.toBeNull();

  const fresh = directory();
  const gone = world(fresh, { answers: [] });
  expect(await runSetup(fresh, ['discord'], gone)).toBe(1);
  expect(text(gone.seen.out)).toContain('Setup stopped before keeping its answers. Run it again in this directory to answer its questions again.');
  expect(readdirSync(fresh)).toEqual(['.setup']);
  expect(readdirSync(join(fresh, '.setup'))).toEqual(['setup.lock']);
  const again = world(fresh, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(fresh, ['discord'], again)).toBe(0);
  expect(again.seen.asked[0]).toContain('Does the resident get a shell');
});

test('a setup stopped once its answers are kept says running it again goes on', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [''] });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.out)).toContain('Setup stopped. Run it again in this directory to go on.');
});

test('setup ends with its agent\'s exit status', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { startAgent: async () => 7 });
  expect(await runSetup(dir, ['discord'], made)).toBe(7);
});

test('a .env that can\'t be read stops setup before it asks or runs anything, naming it and what to do, and changes it not', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  mkdirSync(join(dir, '.env'), { mode: 0o755 });
  const mode = statSync(join(dir, '.env')).mode & 0o777;
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain(`${join(dir, '.env')} can't be read (EISDIR). Setup keeps its key and its agent's secrets there, so it must be a file alice can read: put that right, and run setup again.`);
  expect(made.seen.asked).toEqual([]);
  expect(made.seen.ran).toEqual([]);
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(mode);
});

test('the key setup checks, keeps and gives its agent is the one .env holds when setup gets to the key, though .env changed during the boot check, and .env is readable by its owner alone after', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY="sk-ant-before-the-install"\n', { mode: 0o600 });
  const made = world(dir, {
    answers: ['no', ''],
    duringBoot: () => {
      writeFileSync(join(dir, '.env'), `ANTHROPIC_API_KEY="${KEY}"\n`);
      chmodSync(join(dir, '.env'), 0o644);
    },
  });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.checked.map((each) => each.key)).toEqual([KEY]);
  expect(made.seen.launched!.env.ANTHROPIC_API_KEY).toBe(KEY);
  expect(readEnvFile(join(dir, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
});

test('a .env that is a link, to a file or to nothing, stops setup before it asks or runs anything, the link and its target as they were', async () => {
  const target = join(directory(), 'shared.env');
  writeFileSync(target, `ANTHROPIC_API_KEY="${KEY}"\n`);
  chmodSync(target, 0o644);
  for (const to of [target, join(directory(), 'not-there.env')]) {
    const dir = directory();
    mkdirSync(join(dir, '.setup'));
    symlinkSync(to, join(dir, '.env'));
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
    expect(await runSetup(dir, ['discord'], made), to).toBe(1);
    expect(text(made.seen.err), to).toContain(`${join(dir, '.env')} is a link to ${to}. Setup keeps its key and its agent's secrets in .env as a file of its own`);
    expect(text(made.seen.err), to).toContain('Replace the link with the file it leads to, if that\'s there, or take it away, and run setup again.');
    expect(made.seen.asked, to).toEqual([]);
    expect(made.seen.ran, to).toEqual([]);
    expect(lstatSync(join(dir, '.env')).isSymbolicLink(), to).toBe(true);
  }
  expect(statSync(target).mode & 0o777).toBe(0o644);
  expect(readFileSync(target, 'utf-8')).toBe(`ANTHROPIC_API_KEY="${KEY}"\n`);
});

test('setup writes the key it checked to .env, though .env changed while the key was checked', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.env'), `ANTHROPIC_API_KEY="${KEY}"\n`, { mode: 0o600 });
  let checks = 0;
  const made = world(dir, { answers: ['no', ''] }, {
    checkKey: async () => {
      checks += 1;
      writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY="sk-ant-written-during-the-check"\n');
      return { ok: true };
    },
  });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(checks).toBe(1);
  expect(readEnvFile(join(dir, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
  expect(made.seen.launched!.env.ANTHROPIC_API_KEY).toBe(KEY);
});

test('an ANTHROPIC_AUTH_TOKEN or ANTHROPIC_OAUTH_CREDENTIALS_FILE exported in this shell is named, one or both in one line, since a host started from it signs in through OAuth', async () => {
  const through = 'signs in through OAuth, not with an ANTHROPIC_API_KEY, though setup\'s agent uses the key.';
  for (const names of [['ANTHROPIC_AUTH_TOKEN'], ['ANTHROPIC_OAUTH_CREDENTIALS_FILE'], ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE']]) {
    const dir = directory();
    const exported = Object.fromEntries(names.map((name) => [name, `exported-credential-${name}`]));
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { env: { PATH: '/usr/bin:/bin', HOME: dir, ...exported } });
    expect(await runSetup(dir, ['discord'], made), names.join()).toBe(0);
    const lines = made.seen.out.filter((line) => line.includes('exported in this shell, so a host started from it'));
    expect(lines, names.join()).toEqual([names.length === 1
      ? `${names[0]} is exported in this shell, so a host started from it ${through} Unset it in any shell you start a host from, for such a host to use a key.`
      : `ANTHROPIC_AUTH_TOKEN and ANTHROPIC_OAUTH_CREDENTIALS_FILE are exported in this shell, so a host started from it ${through} Unset them in any shell you start a host from, for such a host to use a key.`]);
    for (const name of names) expect(made.seen.launched!.env[name], name).toBeUndefined();
    expect(text([...made.seen.out, ...made.seen.err]), names.join()).not.toContain('exported-credential');
  }
});

test('an ANTHROPIC_AUTH_TOKEN or ANTHROPIC_OAUTH_CREDENTIALS_FILE that .env holds is named, since a host started in the directory signs in through OAuth; setup\'s agent gets neither', async () => {
  for (const names of [['ANTHROPIC_AUTH_TOKEN'], ['ANTHROPIC_OAUTH_CREDENTIALS_FILE'], ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE']]) {
    const dir = directory();
    const envFile = join(dir, '.env');
    mkdirSync(join(dir, '.setup'));
    writeFileSync(envFile, `${names.map((name) => `${name}=held-credential-${name}\n`).join('')}ANTHROPIC_API_KEY="${KEY}"\n`, { mode: 0o600 });
    const fromEnv = Object.fromEntries([...names.map((name) => [name, `held-credential-${name}`]), ['ANTHROPIC_API_KEY', KEY]]);
    const made = world(dir, { answers: ['no', ''] }, { env: { PATH: '/usr/bin:/bin', HOME: dir, ...fromEnv } });
    expect(await runSetup(dir, ['discord'], made), names.join()).toBe(0);
    const lines = made.seen.out.filter((line) => line.startsWith(`${envFile} holds`));
    expect(lines, names.join()).toEqual([`${envFile} holds ${names.join(' and ')}, so a host started in ${dir} signs in through OAuth, not with an ANTHROPIC_API_KEY, though setup's agent uses the key. Take ${names.length === 1 ? 'it' : 'them'} out of ${envFile}, for such a host to use the key.`]);
    expect(made.seen.out.some((line) => line.includes('exported in this shell, so a host started from it')), names.join()).toBe(false);
    for (const name of names) expect(made.seen.launched!.env[name], name).toBeUndefined();
    expect(made.seen.launched!.argv).toContain('--no-env-file');
    expect(text([...made.seen.out, ...made.seen.err]), names.join()).not.toContain('held-credential');
  }
});

test('a key that works but can\'t be kept in .env stops setup with no agent, saying so', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'), { mode: 0o700 });
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, {
    checkKey: async () => { chmodSync(dir, 0o500); return { ok: true }; },
  });
  try {
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
  } finally {
    chmodSync(dir, 0o700);
  }
  expect(text(made.seen.err)).toContain(`The key works, but setup couldn't make sure ${join(dir, '.env')} holds it: EACCES`);
  expect(text(made.seen.err)).toContain('So it starts no agent: put that right, and run setup again.');
  expect(made.seen.launched).toBeNull();
});

test('a .env made a directory, or a link, while the key is checked stops setup with no agent, saying the key works, and leaves it as it is', async () => {
  const target = join(directory(), 'shared.env');
  writeFileSync(target, 'SHARED=1\n');
  chmodSync(target, 0o644);
  const cases: Array<[string, (envFile: string) => void, string]> = [
    ['a directory', (envFile) => { rmSync(envFile, { force: true }); mkdirSync(envFile); }, "can't be read (EISDIR)"],
    ['a link to a file', (envFile) => { rmSync(envFile, { force: true }); symlinkSync(target, envFile); }, `is a link to ${target}, and it's written only as a file of its own, not through a link or over one`],
  ];
  for (const [what, make, why] of cases) {
    const dir = directory();
    const envFile = join(dir, '.env');
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, {
      checkKey: async () => { make(envFile); return { ok: true }; },
    });
    expect(await runSetup(dir, ['discord'], made), what).toBe(1);
    expect(text(made.seen.err), what).toContain(`The key works, but setup couldn't make sure ${envFile} holds it: ${envFile} ${why}. So it starts no agent: put that right, and run setup again.`);
    expect(made.seen.launched, what).toBeNull();
    if (what === 'a directory') expect(lstatSync(envFile).isDirectory(), what).toBe(true);
    else expect(lstatSync(envFile).isSymbolicLink(), what).toBe(true);
  }
  expect(readFileSync(target, 'utf-8')).toBe('SHARED=1\n');
  expect(statSync(target).mode & 0o777).toBe(0o644);
});

test('run again with the key already in .env, readable by its owner alone, setup writes nothing there, so a directory it can\'t write in is no bar', async () => {
  for (const mode of [0o600, 0o400]) {
    const dir = directory();
    expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] })), mode.toString(8)).toBe(0);
    chmodSync(join(dir, '.env'), mode);
    const before = statSync(join(dir, '.env')).mtimeMs;
    chmodSync(dir, 0o500);
    const again = world(dir);
    try {
      expect(await runSetup(dir, ['discord'], again), mode.toString(8)).toBe(0);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(again.seen.launched, mode.toString(8)).not.toBeNull();
    expect(statSync(join(dir, '.env')).mtimeMs, mode.toString(8)).toBe(before);
    expect(statSync(join(dir, '.env')).mode & 0o777, mode.toString(8)).toBe(mode);
  }
});

test('an empty ANTHROPIC_AUTH_TOKEN or ANTHROPIC_OAUTH_CREDENTIALS_FILE, in .env or exported, names nothing, as the host takes neither', async () => {
  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE']) {
    for (const where of ['.env', 'exported']) {
      const dir = directory();
      mkdirSync(join(dir, '.setup'));
      writeFileSync(join(dir, '.env'), `${where === '.env' ? `${name}=\n` : ''}ANTHROPIC_API_KEY="${KEY}"\n`, { mode: 0o600 });
      const made = world(dir, { answers: ['no', ''] }, { env: { PATH: '/usr/bin:/bin', HOME: dir, ...(where === 'exported' ? { [name]: '' } : {}) } });
      expect(await runSetup(dir, ['discord'], made), `${name} ${where}`).toBe(0);
      expect(made.seen.out.filter((line) => line.includes('OAuth')), `${name} ${where}`).toEqual([]);
      expect(made.seen.launched, `${name} ${where}`).not.toBeNull();
    }
  }
});

test('a .env with a line outside setup\'s form stops setup before it asks or runs anything, naming the line and nothing of it, and changes it not', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  const before = 'PEM_KEY="-----BEGIN-----\nbody-of-the-key\n-----END-----"\nPORT=8080\n';
  writeFileSync(join(dir, '.env'), before, { mode: 0o600 });
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toBe(`${join(dir, '.env')}, line 1, spells its value in none of the form's three ways, and 2 other lines aren't in setup's form either. Setup reads and writes .env in one form, which Bun reads as it's written: empty lines, comments starting with #, and NAME=value, NAME="value" or NAME='value', each on one line, where NAME is ASCII letters, digits and _, not starting with a digit, a quoted value holds no quote of its own kind, $ or backslash, an unquoted one no quote, $, backslash, space or #, and no line holds a tab or another ASCII control character. Rewrite such a line in that form, or take it out of this .env, which is setup's: a value the host needs from it then has to reach the host's environment another way. Then run setup again.`);
  expect(text([...made.seen.out, ...made.seen.err])).not.toContain('body-of-the-key');
  expect(made.seen.asked).toEqual([]);
  expect(made.seen.ran).toEqual([]);
  expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe(before);
});

test('a .env no one can read stops setup before it asks or runs anything, naming it, and changes it not', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.env'), `ANTHROPIC_API_KEY="${KEY}"\n`);
  chmodSync(join(dir, '.env'), 0o000);
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain(`${join(dir, '.env')} can't be read (EACCES).`);
  expect(made.seen.asked).toEqual([]);
  expect(made.seen.ran).toEqual([]);
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o000);
});

test('a .env its owner can\'t read but others can is made readable by its owner alone, and setup goes on', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.env'), `ANTHROPIC_API_KEY="${KEY}"\n`);
  chmodSync(join(dir, '.env'), 0o040);
  const made = world(dir, { answers: ['no', ''] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  expect(text(made.seen.out)).toContain(`${join(dir, '.env')} was open to others than alice`);
  expect(made.seen.checked.map((each) => each.key)).toEqual([KEY]);
});

test('a .env others can read is made readable by its owner alone, and setup says so', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  chmodSync(join(dir, '.env'), 0o644);
  const again = world(dir);
  expect(await runSetup(dir, ['discord'], again)).toBe(0);
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  expect(text(again.seen.out)).toContain(`${join(dir, '.env')} was open to others than alice`);
});

test('run again on an install, setup uses the data directory the install records, names the root, and makes no other', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  const root = join(dir, 'connectome-host');
  const elsewhere = directory();
  writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: elsewhere, extraState: [] }));
  rmSync(join(dir, 'data'), { recursive: true });
  const again = world(dir);
  expect(await runSetup(dir, ['discord'], again)).toBe(0);
  const made = again.seen.ran.find((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))!;
  expect(args(made).slice(1)).toEqual(['--root', root]);
  expect(existsSync(join(dir, 'data'))).toBe(false);
  expect(text(again.seen.out)).not.toContain('first release');
  expect(text(again.seen.out)).toContain(`Checking the install at ${root}.`);
});

test('an install whose recorded data directory has gone is refused by its own setup, not given a new one', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  rmSync(join(dir, 'data'), { recursive: true });
  const again = world(dir);
  expect(await runSetup(dir, ['discord'], again)).toBe(1);
  expect(text(again.seen.err)).toContain(`The data directory ${join(dir, 'data')} isn't there`);
  expect(existsSync(join(dir, 'data'))).toBe(false);
  expect(again.seen.launched).toBeNull();
});

test('run again after an install that stopped partway, setup adds only the packages missing', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  mkdirSync(join(dir, 'node_modules', '@animalabs', 'connectome-host'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@animalabs', 'connectome-host', 'package.json'),
    JSON.stringify({ name: '@animalabs/connectome-host', version: VERSION }));
  const made = world(dir, { answers: ['yes', '2'], secrets: [KEY] });
  const status = await runSetup(dir, ['discord'], made);
  expect(status, text(made.seen.err)).toBe(0);
  const added = made.seen.ran.find((argv) => args(argv)[0] === 'add')!;
  expect(args(added).slice(1).sort()).toEqual(['@animalabs/discord-mcpl', 'term-sessions-mcp']);
});

test('run again beside another version of the host, setup adds its own version', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  mkdirSync(join(dir, 'node_modules', '@animalabs', 'connectome-host'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@animalabs', 'connectome-host', 'package.json'),
    JSON.stringify({ name: '@animalabs/connectome-host', version: '0.0.1-older' }));
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const added = made.seen.ran.find((argv) => args(argv)[0] === 'add')!;
  expect(args(added)).toContain(`@animalabs/connectome-host@${VERSION}`);
});

test('without sudo, the line that turns linger on is one for root to run', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', 'yes'], secrets: [KEY] }, { hasSudo: false, lingerOf: () => false });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const out = text(made.seen.out);
  expect(out).toContain('run as root');
  expect(out).toContain('  loginctl enable-linger alice');
  expect(out).not.toContain('sudo loginctl');
});

test('a check failing for a reason another key can\'t mend offers the same key again, and checks it again on a yes', async () => {
  const dir = directory();
  const down = { ok: false as const, cause: 'api.anthropic.com is overloaded (529).', anotherKeyMayHelp: false };
  const made = world(dir, { answers: ['no', '', 'yes'], secrets: [KEY], keys: [down, { ok: true }] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.asked).toContain('Try this key again? (yes/no) ');
  expect(made.seen.checked.map((each) => each.key)).toEqual([KEY, KEY]);
  expect(made.seen.asked.filter((question) => question.includes('Anthropic API key'))).toHaveLength(1);

  const other = directory();
  const stopping = world(other, { answers: ['no', '', 'no'], secrets: [KEY], keys: [down] });
  expect(await runSetup(other, ['discord'], stopping)).toBe(1);
  expect(stopping.seen.launched).toBeNull();
});

test('the key is checked where the resident will call: at the ANTHROPIC_BASE_URL .env has, read again at each try', async () => {
  const dir = directory();
  const envFile = join(dir, '.env');
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  writeFileSync(envFile, `${readFileSync(envFile, 'utf-8')}ANTHROPIC_BASE_URL=https://gateway.example/anthropic\n`);
  const fromFile = world(dir);
  expect(await runSetup(dir, ['discord'], fromFile)).toBe(0);
  expect(fromFile.seen.checked).toEqual([{ key: KEY, model: SETUP_MODEL, baseUrl: 'https://gateway.example/anthropic' }]);
  expect(fromFile.seen.launched!.env.ANTHROPIC_BASE_URL).toBe('https://gateway.example/anthropic');
  expect(text(fromFile.seen.out)).toContain('A gateway at ANTHROPIC_BASE_URL may charge otherwise.');

  const down = { ok: false as const, cause: 'gateway.example answered 200, but not with a message.', anotherKeyMayHelp: false };
  const checked: Array<string | undefined> = [];
  const retried = world(dir, { answers: ['yes'] }, {
    checkKey: async (options) => {
      checked.push(options.baseUrl);
      if (checked.length > 1) return { ok: true };
      writeFileSync(envFile, readFileSync(envFile, 'utf-8').replace('https://gateway.example/anthropic', 'https://fixed.example'));
      return down;
    },
  });
  expect(await runSetup(dir, ['discord'], retried)).toBe(0);
  expect(checked).toEqual(['https://gateway.example/anthropic', 'https://fixed.example']);
  expect(retried.seen.launched!.env.ANTHROPIC_BASE_URL).toBe('https://fixed.example');
});

test('a key .env can\'t hold as typed is refused before it is checked or kept, typed, exported or read from .env, and another is asked for', async () => {
  const why = 'it holds a double quote, a $ or a backslash, which Bun can read in a .env line otherwise than typed, so setup doesn\'t write them there';
  const typed = 'sk-ant-"typed';
  const dir1 = directory();
  const declined = world(dir1, { answers: ['no', ''], secrets: [typed, ''] });
  expect(await runSetup(dir1, ['discord'], declined)).toBe(1);
  expect(text(declined.seen.err)).toContain(`That key can't be used: ${why}. Check what was copied.`);
  expect(declined.seen.checked).toEqual([]);
  expect(declined.seen.asked.filter((question) => question.startsWith('An Anthropic API key'))).toHaveLength(2);
  expect(readEnvFile(join(dir1, '.env')).get('ANTHROPIC_API_KEY')).toBeUndefined();
  expect(declined.seen.launched).toBeNull();
  expect(text([...declined.seen.out, ...declined.seen.err])).not.toContain(typed);

  const dir2 = directory();
  const replaced = world(dir2, { answers: ['no', ''], secrets: [typed, KEY] });
  expect(await runSetup(dir2, ['discord'], replaced)).toBe(0);
  expect(replaced.seen.checked.map((each) => each.key)).toEqual([KEY]);
  expect(readEnvFile(join(dir2, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
  expect(replaced.seen.launched!.env.ANTHROPIC_API_KEY).toBe(KEY);

  const dir3 = directory();
  const exported = 'sk-ant-"exported';
  const fromShell = world(dir3, { answers: ['no', '', 'yes'], secrets: [''] }, { env: { PATH: '/usr/bin:/bin', HOME: dir3, ANTHROPIC_API_KEY: exported } });
  expect(await runSetup(dir3, ['discord'], fromShell)).toBe(1);
  expect(text(fromShell.seen.err)).toContain(`That key can't be used: ${why}. Check what was copied.`);
  expect(fromShell.seen.checked).toEqual([]);
  expect(fromShell.seen.asked.filter((question) => question.startsWith('An Anthropic API key'))).toHaveLength(1);
  expect(readEnvFile(join(dir3, '.env')).get('ANTHROPIC_API_KEY')).toBeUndefined();
  expect(text([...fromShell.seen.out, ...fromShell.seen.err])).not.toContain(exported);

  const dir4 = directory();
  mkdirSync(join(dir4, '.setup'));
  const stored = 'sk-ant-"stored';
  writeFileSync(join(dir4, '.env'), `ANTHROPIC_API_KEY='${stored}'\n`, { mode: 0o600 });
  const fromEnv = world(dir4, { answers: ['no', ''], secrets: [''] });
  expect(await runSetup(dir4, ['discord'], fromEnv)).toBe(1);
  expect(text(fromEnv.seen.err)).toContain(`The ANTHROPIC_API_KEY in ${join(dir4, '.env')} can't be used: ${why}.`);
  expect(fromEnv.seen.checked).toEqual([]);
  expect(fromEnv.seen.asked.filter((question) => question.startsWith('An Anthropic API key'))).toHaveLength(1);
  expect(fromEnv.seen.launched).toBeNull();
  expect(readFileSync(join(dir4, '.env'), 'utf-8')).toBe(`ANTHROPIC_API_KEY='${stored}'\n`);
  expect(text([...fromEnv.seen.out, ...fromEnv.seen.err])).not.toContain(stored);
});

test('a key a request header can\'t carry, typed or read from .env, is refused by the check with no call, the .env one named as .env\'s, and another is asked for', async () => {
  const sent: Array<string | null> = [];
  const answered = (async (_url: string, init: RequestInit) => {
    sent.push(new Headers(init.headers).get('x-api-key'));
    const start = { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 5 } } };
    const end = { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } };
    return new Response(`event: message_start\ndata: ${JSON.stringify(start)}\n\nevent: message_delta\ndata: ${JSON.stringify(end)}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  const real = (options: KeyCheckOptions) => checkKey({ ...options, fetch: answered });
  const bad = 'sk-ant-line\u2028separated';
  const cause = "The key holds a character a request header can't carry, so it can't be sent, and no call was made. Check what was copied.";

  const dir1 = directory();
  const typed = world(dir1, { answers: ['no', ''], secrets: [bad, KEY] }, { checkKey: real });
  expect(await runSetup(dir1, ['discord'], typed)).toBe(0);
  expect(text(typed.seen.out)).toContain(`Checking the key: one call at https://api.anthropic.com to ${SETUP_MODEL}, the model setup's agent runs on, which the key's account has to be able to use.`);
  expect(text(typed.seen.err)).toContain(cause);
  expect(text(typed.seen.out)).toContain('Type a key, this one again or another, or Enter alone to stop.');
  expect(readEnvFile(join(dir1, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
  expect(typed.seen.launched!.env.ANTHROPIC_API_KEY).toBe(KEY);
  expect(text([...typed.seen.out, ...typed.seen.err])).not.toContain(bad);
  expect(sent).toEqual([KEY]);

  const dir2 = directory();
  mkdirSync(join(dir2, '.setup'));
  writeFileSync(join(dir2, '.env'), `ANTHROPIC_API_KEY=${bad}\n`, { mode: 0o600 });
  const stored = world(dir2, { answers: ['no', ''], secrets: [''] }, { checkKey: real });
  expect(await runSetup(dir2, ['discord'], stored)).toBe(1);
  expect(text(stored.seen.out)).toContain(`Checking the ANTHROPIC_API_KEY in ${join(dir2, '.env')}: one call at https://api.anthropic.com to ${SETUP_MODEL},`);
  expect(text(stored.seen.err)).toContain(cause);
  expect(stored.seen.asked.filter((question) => question.startsWith('An Anthropic API key'))).toHaveLength(1);
  expect(stored.seen.launched).toBeNull();
  expect(readFileSync(join(dir2, '.env'), 'utf-8')).toBe(`ANTHROPIC_API_KEY=${bad}\n`);
  expect(text([...stored.seen.out, ...stored.seen.err])).not.toContain(bad);
  expect(sent).toEqual([KEY]);
});

test('an empty ANTHROPIC_BASE_URL in .env means Anthropic\'s own API, as it does for the host: setup checks the key there and gives its agent none', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.env'), `ANTHROPIC_BASE_URL=\nANTHROPIC_API_KEY="${KEY}"\n`, { mode: 0o600 });
  const made = world(dir, { answers: ['no', ''] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.checked).toEqual([{ key: KEY, model: SETUP_MODEL }]);
  expect(text(made.seen.out)).toContain(`Checking the ANTHROPIC_API_KEY in ${join(dir, '.env')}: one call at https://api.anthropic.com to ${SETUP_MODEL},`);
  expect(made.seen.launched!.env.ANTHROPIC_BASE_URL).toBeUndefined();
});

test('an ANTHROPIC_BASE_URL exported in this shell is named, setup checking the key at and giving its agent the one .env sets, or none, and saying a host started from such a shell takes the exported one; setup writes none', async () => {
  const dir = directory();
  const envFile = join(dir, '.env');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] },
    { env: { PATH: '/usr/bin:/bin', HOME: dir, ANTHROPIC_BASE_URL: 'https://someone:pass-in-url@gateway.example/path?token=in-query' } });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.checked).toEqual([{ key: KEY, model: SETUP_MODEL }]);
  expect(made.seen.launched!.env.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(readEnvFile(envFile).has('ANTHROPIC_BASE_URL')).toBe(false);
  expect(text(made.seen.out)).toContain(`Setup checks the key at, and gives its agent, Anthropic's own API, since ${envFile} sets no ANTHROPIC_BASE_URL, not the one exported in this shell.`);
  expect(text(made.seen.out)).toContain('A host started from a shell that exports another takes the exported one');
  const shown = text([...made.seen.out, ...made.seen.err]);
  for (const hidden of ['pass-in-url', 'someone', 'gateway.example', 'in-query']) expect(shown).not.toContain(hidden);

  writeFileSync(envFile, `${readFileSync(envFile, 'utf-8')}ANTHROPIC_BASE_URL=https://gateway.example\n`);
  for (const exported of ['https://other.example', '']) {
    const again = world(dir, {}, { env: { PATH: '/usr/bin:/bin', HOME: dir, ANTHROPIC_BASE_URL: exported } });
    expect(await runSetup(dir, ['discord'], again)).toBe(0);
    expect(again.seen.checked).toEqual([{ key: KEY, model: SETUP_MODEL, baseUrl: 'https://gateway.example' }]);
    expect(again.seen.launched!.env.ANTHROPIC_BASE_URL).toBe('https://gateway.example');
    expect(text(again.seen.out)).toContain(`Setup checks the key at, and gives its agent, the ANTHROPIC_BASE_URL in ${envFile}, which leads to https://gateway.example, not the one exported in this shell.`);
    expect(readEnvFile(envFile).get('ANTHROPIC_BASE_URL')).toBe('https://gateway.example');
  }
});

test('an ANTHROPIC_API_KEY exported in this shell, empty too, that differs from the key setup checked and keeps is named, the one in .env checked', async () => {
  const dir = directory();
  const envFile = join(dir, '.env');
  mkdirSync(join(dir, '.setup'));
  writeFileSync(envFile, `ANTHROPIC_API_KEY="${KEY}"\n`);
  const made = world(dir, { answers: ['no', ''] }, { env: { PATH: '/usr/bin:/bin', HOME: dir, ANTHROPIC_API_KEY: 'sk-ant-exported-other' } });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.checked.map((each) => each.key)).toEqual([KEY]);
  expect(made.seen.out.filter((line) => line.includes('exported in this shell'))).toEqual([
    `The ANTHROPIC_API_KEY exported in this shell isn't the one setup checked and keeps in ${envFile}. A host started from a ` +
    'shell that exports another takes the exported one, since Bun gives an exported variable precedence over .env. Unset it ' +
    'in this shell, and in any other you start a host from, so that such a host doesn\'t take it.',
  ]);
  expect(text([...made.seen.out, ...made.seen.err])).not.toContain('sk-ant-exported-other');

  const empty = world(dir, {}, { env: { PATH: '/usr/bin:/bin', HOME: dir, ANTHROPIC_API_KEY: '' } });
  expect(await runSetup(dir, ['discord'], empty)).toBe(0);
  expect(empty.seen.checked.map((each) => each.key)).toEqual([KEY]);
  expect(text(empty.seen.out)).toContain(`The ANTHROPIC_API_KEY exported in this shell isn't the one setup checked and keeps in ${envFile}.`);

  for (const exported of ['sk-ant-declined', '']) {
    const fresh = directory();
    const freshEnv = join(fresh, '.env');
    const first = world(fresh, { answers: exported === '' ? ['no', ''] : ['no', '', 'no'], secrets: [KEY] },
      { env: { PATH: '/usr/bin:/bin', HOME: fresh, ANTHROPIC_API_KEY: exported } });
    expect(await runSetup(fresh, ['discord'], first)).toBe(0);
    expect(readEnvFile(freshEnv).get('ANTHROPIC_API_KEY'), exported).toBe(KEY);
    expect(text(first.seen.out), exported).toContain(`The ANTHROPIC_API_KEY exported in this shell isn't the one setup checked and keeps in ${freshEnv}.`);
  }

  const replacedDir = directory();
  const replacedEnv = join(replacedDir, '.env');
  const refused = { ok: false as const, cause: 'refused the key (401)', anotherKeyMayHelp: true };
  const replaced = world(replacedDir, { answers: ['no', '', 'yes'], secrets: [KEY], keys: [refused, { ok: true }] },
    { env: { PATH: '/usr/bin:/bin', HOME: replacedDir, ANTHROPIC_API_KEY: 'sk-ant-exported-refused' } });
  expect(await runSetup(replacedDir, ['discord'], replaced)).toBe(0);
  expect(replaced.seen.checked.map((each) => each.key)).toEqual(['sk-ant-exported-refused', KEY]);
  expect(readEnvFile(replacedEnv).get('ANTHROPIC_API_KEY')).toBe(KEY);
  expect(text(replaced.seen.out)).toContain(`The ANTHROPIC_API_KEY exported in this shell isn't the one setup checked and keeps in ${replacedEnv}.`);

  const same = world(dir, {}, { env: { PATH: '/usr/bin:/bin', HOME: dir, ANTHROPIC_API_KEY: KEY } });
  expect(await runSetup(dir, ['discord'], same)).toBe(0);
  expect(text(same.seen.out)).not.toContain('exported in this shell');
});

test('an ANTHROPIC_BASE_URL put in .env during a question is checked as a URL before the key is, and names its origin when asking for a key', async () => {
  const dir = directory();
  const envFile = join(dir, '.env');
  mkdirSync(join(dir, '.setup'));
  writeFileSync(envFile, 'ANTHROPIC_BASE_URL=https://gateway.example/anthropic\n');
  const labels: string[] = [];
  const made = world(dir, { answers: ['no', ''] }, {
    askHidden: async (label) => {
      labels.push(label);
      writeFileSync(envFile, 'ANTHROPIC_BASE_URL=localhost:8080\n');
      return KEY;
    },
  });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(labels).toEqual(['An API key that https://gateway.example accepts, typed hidden (Enter alone stops setup)']);
  expect(text(made.seen.err)).toContain(`ANTHROPIC_BASE_URL, in ${envFile}, isn't an http:// or https:// URL`);
  expect(made.seen.checked).toEqual([]);
  expect(made.seen.launched).toBeNull();
});

test('setup shows where ANTHROPIC_BASE_URL leads, never a user, password, path or query it carries', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.env'), 'ANTHROPIC_BASE_URL=https://someone:pass-in-url@gateway.example/path?token=in-query\n');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const shown = text([...made.seen.out, ...made.seen.err]);
  expect(shown).toContain('one call at https://gateway.example to ');
  for (const hidden of ['pass-in-url', 'someone', '/path', 'in-query']) expect(shown).not.toContain(hidden);
});

test('a host started again on setup\'s data goes on with the conversation it had', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], host: 'copy' });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const launch = made.seen.launched!;
  const mock = join(dir, 'mock.json');
  writeFileSync(mock, JSON.stringify({
    name: 'mock', agent: { name: 'mock', provider: 'mock', systemPrompt: 'mock' },
    modules: { wake: false, workspace: false, subscriptionGc: false },
  }));
  const argv = launch.argv.map((word) => (word.endsWith('setup.json') ? mock : word));
  const session = (input: string) => {
    const ran = Bun.spawnSync(argv, { cwd: launch.cwd, env: launch.env, stdin: Buffer.from(input) });
    expect(ran.exitCode, ran.stderr.toString()).toBe(0);
    const out = ran.stdout.toString();
    return { id: /ID: (\S+)/.exec(out)?.[1], out };
  };
  const first = session('hello-from-the-first-run\n/session\n');
  expect(first.id).toBeDefined();
  const second = session('/session\n/history\n');
  expect(second.id).toBe(first.id);
  expect(second.out).toContain('hello-from-the-first-run');
}, 60_000);

test('the host refuses modules.setup headless, in the TUI, or with stdin or stdout off a terminal, so its agent runs only in readline mode on one', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], host: 'copy' });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const launch = made.seen.launched!;
  const refusal = 'modules.setup runs only in readline mode with stdin and stdout on a terminal';
  const ran = Bun.spawnSync(launch.argv, { cwd: launch.cwd, env: launch.env, stdin: Buffer.from('') });
  expect(ran.exitCode).not.toBe(0);
  expect(ran.stdout.toString() + ran.stderr.toString()).toContain(refusal);

  // script(1) gives the host a terminal on stdin; the redirect inside takes stdout off it.
  const out = join(directory(), 'out.txt');
  const word = (each: string) => `'${each.replace(/'/g, `'\\''`)}'`;
  const line = `${launch.argv.map(word).join(' ')} > ${word(out)} 2>&1`;
  const redirected = Bun.spawnSync([Bun.which('script') ?? 'script', '-qec', line, '/dev/null'], {
    cwd: launch.cwd, env: launch.env, stdin: Buffer.from(''), timeout: 20_000,
  });
  expect(redirected.exitCode).not.toBe(0);
  expect(readFileSync(out, 'utf-8')).toContain(refusal);

  const onTerminal = (argv: string[], redirect: string) => Bun.spawnSync(
    [Bun.which('script') ?? 'script', '-qec', `${argv.map(word).join(' ')}${redirect}`, '/dev/null'],
    { cwd: launch.cwd, env: launch.env, stdin: Buffer.from(''), timeout: 20_000 },
  );
  const cases = [
    ['headless', [...launch.argv, '--headless'], ''],
    ['in the TUI', launch.argv.filter((each) => each !== '--no-tui'), ''],
    ['with stdin off the terminal', launch.argv, ' < /dev/null'],
  ] as const;
  for (const [how, argv, redirect] of cases) {
    const ran = onTerminal([...argv], redirect);
    expect(ran.exitCode, how).not.toBe(0);
    expect(ran.stdout.toString(), how).toContain(refusal);
  }
}, 120_000);

test('an install\'s own command takes setup to this release\'s setup, and the package\'s bin names the versioned line', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  const command = join(dir, 'connectome-host', 'connectome');
  const routed = Bun.spawnSync([process.execPath, command, 'setup', 'discord'], { cwd: directory(), stdin: Buffer.from('') });
  expect(routed.exitCode).toBe(1);
  expect(routed.stderr.toString()).toContain('needs a person at a terminal');

  const empty = directory();
  const none = Bun.spawnSync([process.execPath, BIN], { cwd: empty, stdin: Buffer.from('') });
  expect(none.exitCode).toBe(1);
  expect(none.stderr.toString()).toContain(`In a new directory, \`bunx @animalabs/connectome-host@${VERSION} setup discord\` sets one up.`);
});

test('the package\'s bin runs its own setup for an install with no current release, which its own command can\'t run', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  unlinkSync(join(dir, 'connectome-host', 'current'));
  const routed = Bun.spawnSync([process.execPath, BIN, 'setup', 'discord'], { cwd: dir, stdin: Buffer.from('') });
  expect(routed.exitCode).toBe(1);
  expect(routed.stderr.toString()).toContain('connectome setup needs a person at a terminal');
  expect(routed.stderr.toString()).not.toContain('has no current release');
});

test('the package\'s bin runs its own setup for an install whose current release has no setup agent, whose own command has no setup', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  const root = join(dir, 'connectome-host');
  const release = join(root, 'releases', '0.0.1-before-setup', 'node_modules', '@animalabs', 'connectome-host');
  mkdirSync(join(release, 'src', 'cli'), { recursive: true });
  writeFileSync(join(release, 'src', 'cli', 'connectome.ts'),
    'export async function main() { console.error("connectome: there\'s no command setup."); return 2; }\n');
  unlinkSync(join(root, 'current'));
  symlinkSync(join('releases', '0.0.1-before-setup'), join(root, 'current'));
  const routed = Bun.spawnSync([process.execPath, BIN, 'setup', 'discord'], { cwd: dir, stdin: Buffer.from('') });
  expect(routed.stderr.toString()).not.toContain('there\'s no command setup');
  expect(routed.exitCode).toBe(1);
  expect(routed.stderr.toString()).toContain('connectome setup needs a person at a terminal');
});

test('a boot that fails where taking the install away would lose something names no removal, says what, and says running setup again won\'t help',
  async () => {
    const cases: Array<{ change: (dir: string, root: string) => void; says: (dir: string, root: string) => string }> = [
      ...(['copy', 'copyTmp', 'copyPrev', 'setAside'] as const).map((place) => ({
        change: (_dir: string, root: string) => mkdirSync(installPaths(root)[place]),
        says: (_dir: string, root: string) => `${root} holds more than a first run makes`,
      })),
      ...(['journal', 'mark', 'trialLog', 'lock'] as const).map((place) => ({
        change: (_dir: string, root: string) => writeFileSync(installPaths(root)[place], '{}'),
        says: (_dir: string, root: string) => `${root} holds more than a first run makes`,
      })),
      {
        change: (_dir, root) => mkdirSync(join(root, 'releases', '0.0.1-older')),
        says: (_dir, root) => `${root} holds more than a first run makes`,
      },
      {
        change: (dir) => writeFileSync(join(dir, 'data', 'session.json'), '{}'),
        says: (dir) => `The install serves the resident's data in ${join(dir, 'data')}`,
      },
      {
        change: (dir, root) => writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: join(dir, 'data'), extraState: ['/srv/state'] })),
        says: (dir, root) => `${join(root, 'install.json')} records state the resident keeps outside ${join(dir, 'data')}`,
      },
      {
        change: (dir, root) => {
          mkdirSync(join(dir, 'elsewhere'));
          writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: join(dir, 'elsewhere'), extraState: [] }));
        },
        says: (dir, root) => `${join(root, 'install.json')} names ${join(dir, 'elsewhere')} as the data directory the install serves, not ${join(dir, 'data')}`,
      },
      ...[{ v: 1, dataDir: '' }, { v: 1, dataDir: '', extraState: {} }].map((record) => ({
        change: (dir: string, root: string) => writeFileSync(join(root, 'install.json'), JSON.stringify({ ...record, dataDir: join(dir, 'data') })),
        says: (_dir: string, root: string) => `${join(root, 'install.json')} doesn't say what state the resident keeps outside its data directory`,
      })),
    ];
    for (const { change, says } of cases) {
      const dir = directory();
      const root = join(dir, 'connectome-host');
      expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
      change(dir, root);
      const again = world(dir, { boot: { status: 1, stdout: '', stderr: 'it broke' } });
      expect(await runSetup(dir, ['discord'], again)).toBe(1);
      expect(text(again.seen.err)).not.toContain('rm -rf');
      expect(text(again.seen.err)).toContain(`${says(dir, root)}. Setup takes none of it away; running setup again starts this release again, and stops here while what made its boot fail stands.`);
    }
  });

test('a boot that fails where the install record can no longer be read says why, and names no removal', async () => {
  const dir = directory();
  const root = join(dir, 'connectome-host');
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  const again = world(dir, {
    boot: { status: 1, stdout: '', stderr: 'it broke' },
    duringBoot: () => writeFileSync(join(root, 'install.json'), '{"v": 1, "dataD'),
  });
  expect(await runSetup(dir, ['discord'], again)).toBe(1);
  expect(text(again.seen.err)).not.toContain('rm -rf');
  expect(text(again.seen.err)).toContain(`The install record at ${join(root, 'install.json')} isn't JSON, so this release can't read it. Setup takes none of it away`);
});

test('a boot that fails where the data directory or the directory\'s package.json can\'t be read says so, and names no removal', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  const data = join(dir, 'data');
  chmodSync(data, 0o000);
  try {
    const again = world(dir, { boot: { status: 1, stdout: '', stderr: 'it broke' } });
    expect(await runSetup(dir, ['discord'], again)).toBe(1);
    expect(text(again.seen.err)).toContain(`${data}, the data directory the install serves, can't be read (EACCES). Setup takes none of it away`);
    expect(text(again.seen.err)).not.toContain('rm -rf');
  } finally {
    chmodSync(data, 0o700);
  }
  writeFileSync(join(dir, 'package.json'), '{"dependencies": {');
  const unread = world(dir, { boot: { status: 1, stdout: '', stderr: 'it broke' } });
  expect(await runSetup(dir, ['discord'], unread)).toBe(1);
  expect(text(unread.seen.err)).toContain(`${join(dir, 'package.json')} can't be read (it isn't JSON). Setup takes none of it away`);
  expect(text(unread.seen.err)).not.toContain('rm -rf');
});

test('a boot that fails where package.json names packages setup didn\'t install names them beside the way to a fresh start', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { '@animalabs/connectome-host': VERSION, '@animalabs/discord-mcpl': '1.0.0', 'left-pad': '1.3.0' },
    devDependencies: { 'the-agents-tool': '2.0.0' },
  }));
  const again = world(dir, { boot: { status: 1, stdout: '', stderr: 'it broke' } });
  expect(await runSetup(dir, ['discord'], again)).toBe(1);
  expect(text(again.seen.err)).toContain(`Nothing of the resident's is in ${join(dir, 'data')} yet, the install records nothing kept outside it, and ${join(dir, 'connectome-host')} holds only the names a first run makes there. ${join(dir, 'package.json')} also names left-pad, the-agents-tool, which aren't setup's, and taking ${join(dir, 'node_modules')} away takes any of them it holds. Once what the lines above say is put right, this takes both away, and setup run again installs its own afresh:`);
  expect(text(again.seen.err)).toContain(`rm -rf ${join(dir, 'connectome-host')} ${join(dir, 'node_modules')}`);
  expect(text(again.seen.err)).not.toContain('this takes it and the packages away');
});

test('a temporary copy of the install\'s command left in the root still counts as setup\'s own', async () => {
  const dir = directory();
  const root = join(dir, 'connectome-host');
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  writeFileSync(join(root, 'connectome.tmp'), '#!/bin/sh\n');
  const again = world(dir, { boot: { status: 1, stdout: '', stderr: 'it broke' } });
  expect(await runSetup(dir, ['discord'], again)).toBe(1);
  expect(text(again.seen.err)).toContain(`rm -rf ${root} ${join(dir, 'node_modules')}`);
});

test('a boot that doesn\'t finish within 60 s is stopped there, and said so', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], boot: { status: null, stdout: '', stderr: '', timedOut: true } });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(made.seen.boot!.timeoutMs).toBe(60_000);
  expect(text(made.seen.err)).toContain('didn\'t finish booting on a mock recipe in batch mode within 60 s');
});

test('where the install\'s own setup fails on a new install, setup names the way to a fresh start, and on one with data says what it keeps', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], installSetup: { status: 1, stdout: '', stderr: 'error: Module not found' } });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain('Module not found');
  expect(text(made.seen.err)).toContain(`rm -rf ${join(dir, 'connectome-host')} ${join(dir, 'node_modules')}`);

  const other = directory();
  expect(await runSetup(other, ['discord'], world(other, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  writeFileSync(join(other, 'data', 'session.json'), '{}');
  const again = world(other, { installSetup: { status: 1, stdout: '', stderr: 'error: disk full' } });
  expect(await runSetup(other, ['discord'], again)).toBe(1);
  expect(text(again.seen.err)).not.toContain('rm -rf');
  expect(text(again.seen.err)).toContain(`The install serves the resident's data in ${join(other, 'data')}. Setup ` +
    'takes none of it away.');
  expect(text(again.seen.err)).not.toContain('running setup again');
});

test('an install record that can\'t be read is named, one that isn\'t JSON or names no version with how to write it again, one naming another version as another release\'s, which setup won\'t write again since that would lose its fields, and nothing more is done', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  writeFileSync(join(dir, 'connectome-host', 'install.json'), '{"v": 1, "dataD');
  const again = world(dir);
  expect(await runSetup(dir, ['discord'], again)).toBe(1);
  expect(text(again.seen.err)).toContain(join(dir, 'connectome-host', 'install.json'));
  expect(text(again.seen.err)).toContain(WRITE_RECORD_AGAIN);
  expect(again.seen.ran.some((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(false);
  expect(again.seen.launched).toBeNull();

  const record = join(dir, 'connectome-host', 'install.json');
  writeFileSync(record, JSON.stringify({ v: 1, extraState: [] }));
  const noData = world(dir);
  expect(await runSetup(dir, ['discord'], noData)).toBe(1);
  expect(text(noData.seen.err)).toContain(`The install record at ${record} names no data directory`);
  expect(text(noData.seen.err)).toContain(`names no data directory, so setup can't tell which data the install serves. ${WRITE_RECORD_AGAIN}`);
  expect(text(noData.seen.err)).not.toContain(`(setup makes it as ${join(dir, 'data')})`);
  expect(noData.seen.launched).toBeNull();
  writeFileSync(record, JSON.stringify({ v: 1, dataDir: '', extraState: [] }));
  const emptyData = world(dir);
  expect(await runSetup(dir, ['discord'], emptyData)).toBe(1);
  expect(text(emptyData.seen.err)).toContain(`The install record at ${record} names no data directory`);
  expect(emptyData.seen.ran.some((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(false);
  expect(readFileSync(record, 'utf-8')).toBe(JSON.stringify({ v: 1, dataDir: '', extraState: [] }));
  writeFileSync(record, JSON.stringify({ dataDir: join(dir, 'data'), extraState: [] }));
  const noVersion = world(dir);
  expect(await runSetup(dir, ['discord'], noVersion)).toBe(1);
  expect(text(noVersion.seen.err)).toContain(`has version undefined, and this release reads only version 1, so setup can't tell which data the install serves. ${WRITE_RECORD_AGAIN}`);
  expect(readFileSync(record, 'utf-8')).toBe(JSON.stringify({ dataDir: join(dir, 'data'), extraState: [] }));
  expect(noVersion.seen.ran.some((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(false);
  for (const notAnObject of ['null', '[]']) {
    writeFileSync(record, notAnObject);
    const plain = world(dir);
    expect(await runSetup(dir, ['discord'], plain)).toBe(1);
    expect(text(plain.seen.err), notAnObject).toContain(`The install record at ${record} isn't an object, so this release can't read it, so setup can't tell which data the install serves. ${WRITE_RECORD_AGAIN}`);
    expect(readFileSync(record, 'utf-8'), notAnObject).toBe(notAnObject);
  }
  for (const v of [null, 0, '1', true]) {
    const kept = JSON.stringify({ v, dataDir: join(dir, 'data'), extraState: [] });
    writeFileSync(record, kept);
    const other = world(dir);
    expect(await runSetup(dir, ['discord'], other)).toBe(1);
    expect(text(other.seen.err)).toContain(`has version ${JSON.stringify(v)}, and this release reads only version 1, so setup can't tell which data the install serves, and goes no further.`);
    expect(text(other.seen.err), JSON.stringify(v)).not.toContain(WRITE_RECORD_AGAIN);
    expect(readFileSync(record, 'utf-8')).toBe(kept);
    expect(other.seen.ran.some((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(false);
  }
  writeFileSync(record, JSON.stringify({ v: 2, dataDir: join(dir, 'data'), extraState: [], kept: 'by a newer release' }));
  const newer = world(dir);
  expect(await runSetup(dir, ['discord'], newer)).toBe(1);
  expect(text(newer.seen.err)).toBe(`The install record at ${record} has version 2, and this release reads only version 1, so setup can't tell which data the install serves, and goes no further.`);
  expect(text(newer.seen.err)).not.toContain(WRITE_RECORD_AGAIN);
  expect(readFileSync(record, 'utf-8')).toBe(JSON.stringify({ v: 2, dataDir: join(dir, 'data'), extraState: [], kept: 'by a newer release' }));
  expect(newer.seen.ran.some((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(false);
  writeFileSync(record, JSON.stringify({ v: 1, dataDir: join(dir, 'data'), extraState: [] }));
  chmodSync(record, 0o000);
  try {
    const closed = world(dir);
    expect(await runSetup(dir, ['discord'], closed)).toBe(1);
    expect(text(closed.seen.err)).toContain('EACCES');
    expect(text(closed.seen.err)).toContain(record);
    expect(text(closed.seen.err)).toContain(', so setup can\'t tell which data the install serves, and goes no further.');
    expect(closed.seen.ran.some((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(false);
  } finally {
    chmodSync(record, 0o600);
  }
  rmSync(record);
  mkdirSync(record);
  const folder = world(dir);
  expect(await runSetup(dir, ['discord'], folder)).toBe(1);
  expect(text(folder.seen.err)).toContain(`${record} can't be read (`);
  expect(text(folder.seen.err)).toContain(', so setup can\'t tell which data the install serves, and goes no further.');
});

test('an ANTHROPIC_BASE_URL in .env that isn\'t a URL is named before any key is asked for', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.env'), 'ANTHROPIC_BASE_URL=localhost:8080\n');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain(`ANTHROPIC_BASE_URL, in ${join(dir, '.env')}, isn't an http:// or https:// URL`);
  expect(made.seen.checked).toEqual([]);
  expect(made.seen.asked.some((question) => question.includes('Anthropic API key'))).toBe(false);
});

test('a .setup this user can\'t write in is named, with what to do, and nothing is asked', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  chmodSync(join(dir, '.setup'), 0o555);
  try {
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
    expect(text(made.seen.err)).toContain(`Setup can't make its lock, ${join(dir, '.setup', 'setup.lock')} (SQLITE_CANTOPEN`);
    expect(text(made.seen.err)).toContain(`Check that this user can write to ${join(dir, '.setup')}, and can read and write ${join(dir, '.setup', 'setup.lock')} if it's there`);
    expect(text(made.seen.err)).not.toContain('take it away');
    expect(made.seen.asked).toEqual([]);
  } finally {
    chmodSync(join(dir, '.setup'), 0o755);
  }
});

test('a setup.lock that isn\'t setup\'s lock is named, with what to do, and nothing is asked', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '12345\n');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain(`${join(dir, '.setup', 'setup.lock')} isn't a lock setup can take`);
  expect(text(made.seen.err)).toContain('take it away and run setup again');
  expect(made.seen.asked).toEqual([]);
});

function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

test('setup\'s runner stops a program still running at its limit, and says so', async () => {
  const dir = directory();
  const started = Date.now();
  const marker = `60.${process.pid}${Date.now() % 1000}`;
  const ran = await realWorld().run(['sh', '-c', `echo started > started; exec sleep ${marker}`], { cwd: dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeoutMs: 3_000 });
  expect(ran.timedOut).toBe(true);
  expect(ran.status).toBeNull();
  expect(Date.now() - started).toBeGreaterThanOrEqual(2_950);
  expect(Date.now() - started).toBeLessThan(60_000);
  expect(readFileSync(join(dir, 'started'), 'utf-8')).toBe('started\n');
  const left = readdirSync('/proc').filter((pid) => /^\d+$/.test(pid) && running(Number(pid)) && (() => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').includes(marker);
    } catch {
      return false;
    }
  })());
  expect(left).toEqual([]);
}, 70_000);

test('a program setup can\'t start is named with what the system said', async () => {
  const dir = directory();
  writeFileSync(join(dir, 'not-a-program'), 'nothing to run\n', { mode: 0o644 });
  const ran = await realWorld().run([join(dir, 'not-a-program')], { cwd: dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  expect(ran.status).toBeNull();
  expect(ran.startError?.code).toBe('EACCES');
  expect(ran.startError?.message).toContain('EACCES');
  expect(ran.startError?.message).toContain(join(dir, 'not-a-program'));

  const fresh = directory();
  const made = world(fresh, { answers: ['no', ''], added: ran });
  expect(await runSetup(fresh, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain(`\`bun --no-env-file add @animalabs/connectome-host@${VERSION} @animalabs/discord-mcpl\` didn't finish (it couldn't be started (${ran.startError!.message})), so setup stops here.`);
});

test('setup\'s runner and its agent\'s launcher give a program exactly the environment they\'re given', async () => {
  const dir = directory();
  process.env.SETUP_TEST_NOT_GIVEN = 'not-given';
  try {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', ONLY_THIS: 'given' };
    const ran = await realWorld().run(['env'], { cwd: dir, env });
    const lines = ran.stdout.trim().split('\n');
    expect(Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))).toEqual(env);
    const agent = 'require("fs").writeFileSync("agent-env.json", JSON.stringify(process.env))';
    expect(await realWorld().startAgent({ argv: [process.execPath, '-e', agent], cwd: dir, env })).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'agent-env.json'), 'utf-8'))).toEqual(env);
  } finally {
    delete process.env.SETUP_TEST_NOT_GIVEN;
  }
});

test('a program setup runs that a signal ends is named by that signal', async () => {
  const ran = await realWorld().run(['sh', '-c', 'kill -TERM $$'], { cwd: directory(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  expect(ran.status).toBeNull();
  expect(ran.signal).toBe('SIGTERM');

  const dir = directory();
  const made = world(dir, { answers: ['no', ''], added: { status: null, stdout: '', stderr: '', signal: 'SIGKILL' } });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain('didn\'t finish (it was ended by SIGKILL), so setup stops here.');
  expect(text(made.seen.err)).not.toContain('lines above');
});

test('an empty ANTHROPIC_API_KEY line in .env counts as no key, so an exported one is offered', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=\n');
  const made = world(dir, { answers: ['no', '', 'yes'] }, { env: { PATH: '/usr/bin:/bin', HOME: dir, ANTHROPIC_API_KEY: KEY } });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.asked.some((question) => question.includes('exported'))).toBe(true);
  expect(readEnvFile(join(dir, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
});
