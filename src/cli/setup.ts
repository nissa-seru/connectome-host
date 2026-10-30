import { spawn } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { constants, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { parseEnv } from 'node:util';
import { Database } from 'bun:sqlite';
import { bunBelowFloor } from '../bun-floor.js';
import { priceAnthropicCall } from '../call-pricing.js';
import { ANTHROPIC_API, checkKey, originOf, type KeyCheck, type KeyCheckOptions } from '../setup/key-check.js';
import { EnvFormError, envForm, readEnvFile, unwritableValue, writeEnvValue } from '../setup/secrets.js';
import { lingerOf } from '../setup/linger.js';
import { askHidden as askHiddenOn } from '../setup/terminal-secret.js';
import {
  ContractError, ENTRY_POINT, WRITE_RECORD_AGAIN, keptOutsideLines, readCurrent, readRecord, releaseDir,
  writeJsonAtomic, type InstallRecord,
} from '../update/contract.js';
import { HOST_ENTRY, RELEASE_HOST, shellWord } from '../update/launcher.js';
import type { CliContext } from './connectome.js';
import { INSTALL_COMMAND, installCommandOf } from './install-command.js';

export const SETUP_USAGE = 'connectome setup discord';

/** The setup agent's recipe, in a release. */
export const SETUP_RECIPE = join(RELEASE_HOST, 'recipes', 'setup.json');
export const SETUP_SUMMARY = 'Sets a resident up on Discord with the host\'s own setup agent, in the directory that ' +
  'holds the install (from bunx, the directory it runs in). ' +
  'Run again, it goes on where it stopped. Unlike the other commands, it runs this package\'s own setup unless ' +
  'the install has its own command and its release a setup agent.';

const PACKAGE = '@animalabs/connectome-host';
const SURFACE = 'discord';
const SERVERS = { discord: '@animalabs/discord-mcpl', shell: 'term-sessions-mcp' } as const;
// term-sessions-mcp 1.7.3's engines: node ">=18.0.0 <25.0.0".
const SHELL_NODE_TOP = 24;
const BOOT_TIMEOUT_MS = 60_000;
// Bun 1.4.3's `bun add --no-env-file` still gives a package's install script the working directory's .env, where
// 1.4.4's gives none (probed), and setup's bun add runs where the resident's secrets are.
const SETUP_BUN_FLOOR = '>=1.4.4';
const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const NOT_FOR_THE_AGENT = [
  'CONNECTOME_INSTALL_ROOT', 'MODEL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'ANTHROPIC_BASE_URL',
  'MCPL_AGENT_OVERLAY_FILE',
];

interface PackageJson {
  version: string;
  engines: { bun: string; node: string };
  bugs: { url: string };
}

function packageJson(): PackageJson {
  return JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf-8')) as PackageJson;
}

/** The line that sets a resident up with this version of the host. */
export function firstLine(): string {
  return `bunx ${PACKAGE}@${packageJson().version} setup ${SURFACE}`;
}

export interface Ran {
  /** null when the program couldn't be started, was stopped at its limit, or was ended by a signal. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** What the system said when the program couldn't be started. */
  startError?: { code?: string; message: string };
  timedOut?: boolean;
  /** The signal that ended it, other than setup's own at its limit. */
  signal?: NodeJS.Signals;
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  /** Let the person see its output as it comes, rather than keep it. */
  show?: boolean;
}

export interface AgentLaunch {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Everything setup reaches outside its directory: the terminal, the programs it runs, the system it asks
 *  about and the network. */
export interface SetupWorld {
  /** Whether a person is at a terminal on stdin and stdout. */
  terminal: boolean;
  platform: NodeJS.Platform;
  user: string;
  env: Record<string, string | undefined>;
  /** The directory setup was started in, whose dotenv files Bun read into `env`. */
  cwd: string;
  bun: { path: string; version: string };
  hasSudo: boolean;
  /** Whether `user`'s linger is on, or null where there's no systemd. */
  lingerOf(user: string): boolean | null;
  /** The line typed, or null once the terminal is gone (Ctrl-C, Ctrl-D). */
  ask(question: string): Promise<string | null>;
  /** Asks with nothing echoed: the line typed, or null once the terminal is gone. */
  askHidden(label: string): Promise<string | null>;
  run(argv: string[], options: RunOptions): Promise<Ran>;
  checkKey(options: KeyCheckOptions): Promise<KeyCheck>;
  /** Runs the setup agent's host in this terminal, to its end, and gives its exit status. */
  startAgent(launch: AgentLaunch): Promise<number>;
}

interface SetupState {
  v: 1;
  shell: boolean;
}

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** `connectome setup discord`, for the install at `root` (its working directory is root's parent). */
export async function setup(ctx: CliContext & { root: string }, world: SetupWorld = realWorld()): Promise<number> {
  const { err } = ctx;
  try {
    return await setupIn(ctx, world);
  } catch (error) {
    err(`connectome setup: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function setupIn(ctx: CliContext & { root: string }, world: SetupWorld): Promise<number> {
  const { out, err } = ctx;
  const root = ctx.root;
  const dir = dirname(root);
  const pkg = packageJson();
  const version = pkg.version;

  if (ctx.argv.length !== 1 || ctx.argv[0] !== SURFACE) {
    err(`Usage: ${SETUP_USAGE}`);
    err('Discord is the one surface setup sets a resident up on.');
    return 2;
  }
  if (!world.terminal) {
    err('connectome setup needs a person at a terminal: it asks questions, and its agent talks with you in this ' +
      'terminal. Run it in one.');
    return 1;
  }
  const setupDir = join(dir, '.setup');
  const statePath = join(setupDir, 'setup-state.json');
  const entries = readdirSync(dir);
  const ours = entries.includes('.setup') || existsSync(join(root, 'install.json'));
  if (!ours && entries.length > 0) {
    err(`connectome setup: ${dir} holds other files and no connectome-host install, so setup won't put its own ` +
      'among them. Make a directory for the resident, named for it, and run setup there:');
    err('  mkdir ~/<name> && cd ~/<name>');
    err(`  ${firstLine()}`);
    return 1;
  }
  let kept = false;
  const stopped = () => {
    out(kept ? 'Setup stopped. Run it again in this directory to go on.'
      : 'Setup stopped before keeping its answers. Run it again in this directory to answer its questions again.');
    return 1;
  };
  const env = withoutDotEnv(world.env, world.cwd);

  mkdirSync(setupDir, { recursive: true, mode: 0o700 });
  const lock = takeSetupLock(join(setupDir, 'setup.lock'));
  if (lock === null) {
    err(`Another setup is running in ${dir}, so this one does nothing. Wait for it to end, or end it, and run ` +
      'setup again.');
    return 1;
  }
  try {
    rmSync(join(dir, '.env.tmp'), { force: true });
    const envFile = join(dir, '.env');
    const envStat = lstatSync(envFile, { throwIfNoEntry: false });
    if (envStat?.isSymbolicLink()) {
      err(`${envFile} is a link to ${readlinkSync(envFile)}. Setup keeps its key and its agent's secrets in .env as a ` +
        `file of its own, readable by ${world.user} alone, so it won't write through the link or over it. Replace the ` +
        'link with the file it leads to, if that\'s there, or take it away, and run setup again.');
      return 1;
    }
    if (envStat?.isFile() && (envStat.mode & 0o077) !== 0) {
      chmodSync(envFile, 0o600);
      out(`${envFile} was open to others than ${world.user}, so setup made it readable by ${world.user} alone.`);
    }
    let outside: EnvFormError | null;
    try {
      outside = envForm(envFile);
    } catch (error) {
      err(`${(error as Error).message}. Setup keeps its key and its agent's secrets there, so it must be a file ` +
        `${world.user} can read: put that right, and run setup again.`);
      return 1;
    }
    if (outside) {
      err(`${outside.message}. Then run setup again.`);
      return 1;
    }
    const read = readState(statePath);
    if ('unreadable' in read) {
      err(`Setup's kept answers in ${statePath} can't be read (${read.unreadable}), so it asks them again.`);
    }
    let state = 'state' in read ? read.state : null;
    if (state === null) {
      out(`Setup asks a few questions first. If the resident is to run as this user, ${world.user}, setup then ` +
        `installs connectome-host ${version} in ${dir} (about 0.8 GB of disk with the install's own copy of it, or ` +
        '1.1 GB with a shell for the resident), unless that version is there already, checks an API key, and starts ' +
        'the host\'s setup agent, which talks with you in this terminal to set up the resident: an agent of yours on ' +
        'Discord that this install runs.');
      const answered = await askWhoAndShell(world, { out, err });
      if (typeof answered === 'number') return answered === -1 ? stopped() : answered;
      state = answered;
    }
    writeJsonAtomic(statePath, state, 0o600);
    kept = true;
    return await installAndStart(ctx, world, { dir, root, pkg, version, state, env, stopped });
  } finally {
    lock.release();
  }
}

async function askWhoAndShell(world: SetupWorld, { out }: Io): Promise<SetupState | number> {
  out('A shell lets the resident run commands on this machine as the user it runs as, which setup settles next: it ' +
    'can read and change whatever that user can, and whoever talks to it on Discord can ask it to.');
  const shell = await yesNo(world, 'Does the resident get a shell? (yes/no) ');
  if (shell === null) return -1;
  const ownUserPossible = world.platform === 'linux' && world.hasSudo;
  const isolation = `With a shell, the resident can read and change whatever ${world.user} can (your files, your ` +
    'keys and your other programs), and whoever talks to it on Discord can ask it to.';
  if (!ownUserPossible) {
    const why = world.platform === 'darwin' ? 'On macOS, setup has no root lines for a user of its own'
      : 'There\'s no sudo on this machine';
    out(`${why}, so the resident runs as this user, ${world.user}.${shell ? ` ${isolation}` : ''}`);
    const go = await yesNo(world, `Go on as ${world.user}? (yes/no) `);
    if (go === null) return -1;
    if (!go) {
      out('Nothing was installed.');
      return 0;
    }
    return { v: 1, shell };
  }
  out('Who does the resident run as?');
  out(`  1. a user of its own${shell ? ', as setup recommends with a shell' : ''}: setup shows the lines that make it, ` +
    'to run where you can use sudo, and you run setup again as that user');
  out(`  2. this user, ${world.user}: for a resident with no shell, or where ${world.user} already is the resident's ` +
    'own user');
  const choice = await pick(world, `Choose 1 or 2 [${shell ? 1 : 2}]: `, shell ? '1' : '2');
  if (choice === null) return -1;
  if (choice === '1') {
    const name = await userName(world, out);
    if (name === null) return -1;
    out('Run these where you can use sudo: they make its user, keep its services running while it\'s logged ' +
      'out, and give it Bun.');
    out(`  sudo useradd -m -s /bin/bash ${name}`);
    out(`  sudo loginctl enable-linger ${name}`);
    out(`  sudo -iu ${name} bash -c 'curl -fsSL https://bun.sh/install | bash'`);
    out(`Setup needs Node ${packageJson().engines.node.replace('>=', '')} or later there too` +
      `${shell ? `, and at most Node ${SHELL_NODE_TOP}` : ''}: if this machine's Node is installed for your user ` +
      `alone, as one from nvm is, install Node for ${name} as well.`);
    out(`Then open a shell as ${name}, and run setup there, in a new directory named for the resident:`);
    out(`  sudo -iu ${name}`);
    out('  mkdir ~/<name> && cd ~/<name>');
    out(`  ${firstLine()}`);
    out(`There, choose "this user" when setup asks who the resident runs as. Nothing was installed here.`);
    return 0;
  }
  if (shell) out(isolation);
  return { v: 1, shell };
}

async function installAndStart(
  ctx: CliContext & { root: string },
  world: SetupWorld,
  { dir, root, pkg, version, state, env, stopped }: {
    dir: string; root: string; pkg: PackageJson; version: string; state: SetupState;
    env: Record<string, string | undefined>; stopped: () => number;
  },
): Promise<number> {
  const { out, err } = ctx;
  const envFile = join(dir, '.env');
  const linger = world.lingerOf(world.user);
  if (linger === false) {
    out(`Linger is off for ${world.user}, so a service of ${world.user}'s stops when ${world.user} logs out. This ` +
      `line${world.hasSudo ? '' : ', run as root,'} turns it on:`);
    out(`  ${world.hasSudo ? 'sudo ' : ''}loginctl enable-linger ${world.user}`);
    out('Run it before the resident\'s service is set up. Setup goes on meanwhile.');
  } else if (world.platform === 'darwin') {
    out(`On macOS, a service of ${world.user}'s stops when ${world.user} logs out.`);
  }

  if (bunBelowFloor(pkg.engines.bun, world.bun.version) === true) {
    err(`connectome-host ${version} needs Bun ${pkg.engines.bun.replace('>=', '')} or later, and this is Bun ` +
      `${world.bun.version}. \`bun upgrade\` upgrades it; then run setup again.`);
    return 1;
  }
  if (bunBelowFloor(SETUP_BUN_FLOOR, world.bun.version) === true) {
    err(`Setup needs Bun ${SETUP_BUN_FLOOR.replace('>=', '')} or later, whose \`bun add --no-env-file\` keeps .env's ` +
      `values from the packages' install scripts, and this is Bun ${world.bun.version}. \`bun upgrade\` upgrades it; ` +
      'then run setup again.');
    return 1;
  }
  const programEnv = withoutKeys(env, []);
  const node = await world.run(['node', '--version'], { cwd: dir, env: programEnv });
  const nodeVersion = node.status === 0 ? node.stdout.trim().replace(/^v/, '') : null;
  const nodeFloor = pkg.engines.node.replace('>=', '');
  const getNode = `Install Node ${nodeFloor} or later${state.shell ? `, and at most Node ${SHELL_NODE_TOP}` : ''}, ` +
    'from nodejs.org or your system\'s package manager, and run setup again.';
  if (nodeVersion === null) {
    err(`connectome-host needs Node as well as Bun, and \`node --version\` didn't answer here ` +
      `(${node.startError?.code === 'ENOENT' ? 'there\'s no node on this PATH' : ended(node)}). ${getNode}`);
    return 1;
  }
  if (bunBelowFloor(pkg.engines.node, nodeVersion) !== false) {
    err(`connectome-host needs Node ${nodeFloor} or later, and this is Node ${nodeVersion}. ${getNode}`);
    return 1;
  }
  if (state.shell && Number(nodeVersion.split('.')[0]) > SHELL_NODE_TOP) {
    err(`The resident's shell, ${SERVERS.shell}, runs on Node ${SHELL_NODE_TOP} at most, and this is Node ` +
      `${nodeVersion}. ${getNode}`);
    return 1;
  }

  const wanted: string[] = [];
  if (installedVersion(dir, PACKAGE) !== version) wanted.push(`${PACKAGE}@${version}`);
  if (installedVersion(dir, SERVERS.discord) === null) wanted.push(SERVERS.discord);
  if (state.shell && installedVersion(dir, SERVERS.shell) === null) wanted.push(SERVERS.shell);
  if (wanted.length > 0) {
    out(`Installing ${wanted.join(', ')} in ${dir}, with Bun:`);
    const added = await world.run([world.bun.path, '--no-env-file', 'add', ...wanted], { cwd: dir, env: programEnv, show: true });
    if (added.status !== 0) {
      err(`\`bun --no-env-file add ${wanted.join(' ')}\` didn't finish (${ended(added)}), so setup stops here.` +
        (added.status === null ? ' Run setup again to try once more.'
          : ' Its own lines above say why. Run setup again once that\'s put right.'));
      return 1;
    }
  }

  let record: InstallRecord | null;
  try {
    record = readRecord<InstallRecord>(join(root, 'install.json'), 'install record');
  } catch (error) {
    const why = (error as Error).message.replace(/\.+$/, '');
    const said = `${error instanceof ContractError ? why : `${join(root, 'install.json')} can't be read (${why})`}, so ` +
      'setup can\'t tell which data the install serves';
    let version: unknown;
    try {
      version = (JSON.parse(readFileSync(join(root, 'install.json'), 'utf-8')) as { v?: unknown } | null)?.v;
    } catch {
    }
    if (error instanceof ContractError && (version === undefined || version === 1)) {
      err(`${said}. ${WRITE_RECORD_AGAIN}`);
    } else {
      err(`${said}, and goes no further.`);
    }
    return 1;
  }
  const settingUp = record === null;
  let dataDir: string;
  if (record === null) {
    dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } else if (typeof record.dataDir !== 'string' || record.dataDir === '') {
    err(`The install record at ${join(root, 'install.json')} names no data directory, so setup can't tell which ` +
      `data the install serves. ${WRITE_RECORD_AGAIN}`);
    return 1;
  } else {
    dataDir = record.dataDir;
  }
  const copySetup = join(dir, RELEASE_HOST, 'src', 'update', 'setup.ts');
  out(settingUp
    ? `Making ${root} an install that updates when you ask: its host's /update commands say whether a newer ` +
      `release is out, install it and restart onto it. Its first release is a copy of what's installed here.`
    : `Checking the install at ${root}.`);
  const made = await world.run([world.bun.path, '--no-env-file', copySetup, '--root', root], {
    cwd: dir, env: { ...withoutKeys(env, ['CONNECTOME_INSTALL_ROOT']), DATA_DIR: dataDir },
  });
  if (made.status !== 0) {
    err(`The install's own setup (${copySetup}) didn't finish (${ended(made)}):`);
    for (const line of lastLines(made, 20)) err(`  ${line}`);
    const kept = freshStart(err, { dir, root, dataDir });
    if (kept !== null) err(`${kept}. Setup takes none of it away.`);
    return 1;
  }
  out(made.stdout.split('\n')[0] ?? '');
  const keptOutside = keptOutsideLines(made.stdout);

  const running = readCurrent(root);
  if (running === null) {
    err(`The install at ${root} has no current release after its own setup, so there's nothing to start. Run setup ` +
      'again: the install\'s own setup then says what to do.');
    return 1;
  }
  const release = releaseDir(root, running);
  const host = join(release, RELEASE_HOST);
  const entry = join(release, HOST_ENTRY);
  const setupRecipe = join(release, SETUP_RECIPE);
  const read = setupModel(setupRecipe);
  if (!('model' in read)) {
    if (read.damage === null && running !== version) {
      err(`The release this install runs, ${running}, has no setup agent: there's no ${setupRecipe}. Once the ` +
        `resident's host runs, its /update, in the TUI or the Web UI, updates it to a release that has one, such as ` +
        `${version}; then run setup again.`);
      return 1;
    }
    err(read.damage === null
      ? `The release this install runs, ${running}, is setup's own version, and its copy has no ${setupRecipe}: the ` +
        'copy is damaged.'
      : `${setupRecipe}, the setup agent's recipe in the release this install runs (${running}), ${read.damage}: the ` +
        'copy is damaged.');
    const kept = freshStart(err, { dir, root, dataDir });
    if (kept !== null) {
      err(`${kept}. Setup takes none of it away, and running setup again stops here again until ${setupRecipe} ` +
        'is put right: setup doesn\'t mend a release it already made.');
    }
    return 1;
  }
  const { model } = read;

  const command = installCommandOf(root, env.PATH);
  out(`This install's own command is ${command.path}.`);
  if (command.pathLine !== null) {
    out('Nothing setup or its agent does needs its directory on your PATH, so you need it there only to type plain ' +
      '`connectome`. For that, put it on your PATH, and in ~/.bashrc (or your shell\'s own file) to keep it there:');
    out(`  ${command.pathLine}`);
  }

  out('Starting the installed host once, on a mock recipe, to see that it starts.');
  const scratch = mkdtempSync(join(tmpdir(), 'connectome-setup-boot-'));
  try {
    const recipe = join(scratch, 'boot.json');
    writeFileSync(recipe, JSON.stringify({
      name: 'setup boot check',
      agent: { name: 'boot', provider: 'mock', systemPrompt: 'Setup\'s boot check.' },
      modules: { wake: false, workspace: false, subscriptionGc: false },
    }));
    const boot = await world.run([world.bun.path, entry, recipe, '--no-tui'], {
      cwd: scratch, env: { ...withoutKeys(env, NOT_FOR_THE_AGENT), DATA_DIR: join(scratch, 'data') },
      timeoutMs: BOOT_TIMEOUT_MS,
    });
    if (boot.status !== 0) {
      err(boot.timedOut
        ? `The installed host (${running}, ${entry}) didn't finish booting on a mock recipe in batch mode within ` +
          `${BOOT_TIMEOUT_MS / 1000} s, so setup stopped it.`
        : `The installed host (${running}, ${entry}) doesn't start on a mock recipe in batch mode: ${ended(boot)}.`);
      for (const line of lastLines(boot, 20)) err(`  ${line}`);
      err('Where the host\'s own lines above name something of this machine\'s, such as a file it can\'t read, put ' +
        'that right. Where they name the host\'s code or a package it brings, such as a module it can\'t find, ' +
        `that's for its makers: report them, with this output, at ${pkg.bugs.url}.`);
      const kept = freshStart(err, { dir, root, dataDir });
      if (kept !== null) {
        err(`${kept}. Setup takes none of it away; running setup again starts this release again, and stops here ` +
          'while what made its boot fail stands.');
      }
      return 1;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  out(`The installed host (${running}) starts.`);

  const stored = readEnvFile(envFile);
  const baseIn = (): string | undefined | null => {
    const url = readEnvFile(envFile).get('ANTHROPIC_BASE_URL') || undefined;
    if (url === undefined || originOf(url) !== null) return url;
    err(`ANTHROPIC_BASE_URL, in ${envFile}, isn't an http:// or https:// URL. Set it to one there, or take it out ` +
      'for Anthropic\'s own API, and run setup again.');
    return null;
  };
  let baseUrl = baseIn();
  if (baseUrl === null) return 1;
  const exportedWins = 'A host started from a shell that exports another takes the exported one, since Bun gives an ' +
    'exported variable precedence over .env.';
  if (env.ANTHROPIC_BASE_URL !== undefined && (env.ANTHROPIC_BASE_URL || undefined) !== baseUrl) {
    out(`Setup checks the key at, and gives its agent, ${baseUrl === undefined
      ? `Anthropic's own API, since ${envFile} sets no ANTHROPIC_BASE_URL`
      : `the ANTHROPIC_BASE_URL in ${envFile}, which leads to ${originOf(baseUrl)}`}, not the one exported in this ` +
      `shell. ${exportedWins} To use the exported one, put it in ${envFile}.`);
  }
  const storedKey = stored.get('ANTHROPIC_API_KEY') || undefined;
  let key: string | null = storedKey ?? null;
  let fromDotEnv = key !== null;
  if (key === null && env.ANTHROPIC_API_KEY) {
    const use = await yesNo(world, `An ANTHROPIC_API_KEY is exported in this shell. Use it for setup's agent? Setup ` +
      `writes it to ${envFile}, readable by you alone. (yes/no) `);
    if (use === null) return stopped();
    if (use) key = env.ANTHROPIC_API_KEY;
  }
  for (;;) {
    if (key === null) {
      key = await world.askHidden(`${baseUrl === undefined ? 'An Anthropic API key, from console.anthropic.com\'s API keys'
        : `An API key that ${originOf(baseUrl)} accepts`}, typed hidden (Enter alone stops setup)`);
      fromDotEnv = false;
      if (!key) return stopped();
    }
    const unwritable = unwritableValue(key);
    if (unwritable !== null) {
      err(fromDotEnv ? `The ANTHROPIC_API_KEY in ${envFile} can't be used: ${unwritable}.`
        : `That key can't be used: ${unwritable}. Check what was copied.`);
      key = null;
      fromDotEnv = false;
      continue;
    }
    baseUrl = baseIn();
    if (baseUrl === null) return 1;
    out(`Checking ${fromDotEnv ? `the ANTHROPIC_API_KEY in ${envFile}` : 'the key'}: one call at ` +
      `${baseUrl === undefined ? ANTHROPIC_API : originOf(baseUrl)} to ${model}, the model setup's agent runs on, which ` +
      'the key\'s account has to be able to use.');
    const checked = await world.checkKey({ key, model, ...(baseUrl === undefined ? {} : { baseUrl }) });
    if (checked.ok) break;
    err(checked.cause);
    if (checked.anotherKeyMayHelp) {
      out('Type a key, this one again or another, or Enter alone to stop.');
      key = null;
      continue;
    }
    const again = await yesNo(world, 'Try this key again? (yes/no) ');
    if (!again) return stopped();
  }
  let held: Map<string, string>;
  try {
    const onDisk = lstatSync(envFile, { throwIfNoEntry: false });
    held = readEnvFile(envFile);
    if (held.get('ANTHROPIC_API_KEY') !== key || !onDisk?.isFile() || (onDisk.mode & 0o077) !== 0) {
      writeEnvValue(envFile, 'ANTHROPIC_API_KEY', key);
    }
  } catch (error) {
    err(`The key works, but setup couldn't make sure ${envFile} holds it: ${(error as Error).message}. So it starts no ` +
      'agent: put that right, and run setup again.');
    return 1;
  }
  out(`The key works, and it's in ${envFile}.`);
  if (env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY !== key) {
    out(`The ANTHROPIC_API_KEY exported in this shell isn't the one setup checked and keeps in ${envFile}. ${exportedWins} ` +
      'Unset it in this shell, and in any other you start a host from, so that such a host doesn\'t take it.');
  }
  const oauth = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE'];
  const throughOAuth = 'signs in through OAuth, not with an ANTHROPIC_API_KEY, though setup\'s agent uses the key.';
  const exported = oauth.filter((name) => env[name]);
  if (exported.length > 0) {
    out(`${exported.join(' and ')} ${exported.length === 1 ? 'is' : 'are'} exported in this shell, so a host started ` +
      `from it ${throughOAuth} Unset ${exported.length === 1 ? 'it' : 'them'} in any shell you start a host from, for ` +
      'such a host to use a key.');
  }
  const inEnv = oauth.filter((name) => held.get(name));
  if (inEnv.length > 0) {
    out(`${envFile} holds ${inEnv.join(' and ')}, so a host started in ${dir} ${throughOAuth} Take ` +
      `${inEnv.length === 1 ? 'it' : 'them'} out of ${envFile}, for such a host to use the key.`);
  }
  out(costLine(model, baseUrl !== undefined));

  const launch: AgentLaunch = {
    argv: [world.bun.path, '--no-env-file', entry, setupRecipe, '--no-tui'],
    cwd: join(dir, '.setup'),
    env: {
      ...withoutKeys(env, NOT_FOR_THE_AGENT),
      ANTHROPIC_API_KEY: key,
      ...(baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: baseUrl }),
      DATA_DIR: join(dir, '.setup'),
      CONNECTOME_SETUP_VERSION: running,
      CONNECTOME_SETUP_INSTALL: root,
      CONNECTOME_SETUP_DIR: dir,
      CONNECTOME_SETUP_SURFACE: 'Discord',
      CONNECTOME_SETUP_GUIDE: join(host, 'docs', 'AGENT-ONBOARDING.md'),
      CONNECTOME_SETUP_SHELL: state.shell ? 'gets a shell' : 'gets no shell',
      CONNECTOME_SETUP_USER: world.user,
      CONNECTOME_UPDATE_CHECK: '0',
    },
  };
  out(`Starting setup's agent. It waits for you to speak first: say hello to begin. /quit leaves the conversation, ` +
    `and \`${shellWord(join(root, 'connectome'))} setup ${SURFACE}\` picks it up where it stopped.`);
  const agentStatus = await world.startAgent(launch);
  for (const line of keptOutside) out(line);
  return agentStatus;
}

type Kept = { state: SetupState } | { unreadable: string } | { absent: true };

function readState(path: string): Kept {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { absent: true };
    return { unreadable: (error as Error).message };
  }
  let state: Partial<SetupState> | null;
  try {
    state = JSON.parse(text) as Partial<SetupState> | null;
  } catch {
    return { unreadable: 'it isn\'t JSON' };
  }
  if (state?.v !== 1 || typeof state.shell !== 'boolean') return { unreadable: 'it isn\'t the answers this setup keeps' };
  return { state: state as SetupState };
}

/** One setup at a time in a directory: an exclusive SQLite lock on `file`, which the system lets go when the
 *  process holding it ends, however it ends. null when another process holds it. */
function takeSetupLock(file: string): { release(): void } | null {
  let db: Database | undefined;
  try {
    db = new Database(file, { create: true });
    db.exec('PRAGMA busy_timeout = 1000');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db?.close();
    const { code, message } = error as { code?: string; message?: string };
    if (code === 'SQLITE_BUSY') return null;
    if (code === 'SQLITE_CANTOPEN') {
      throw new Error(`Setup can't make its lock, ${file} (SQLITE_CANTOPEN: ${message}). Check that this user can ` +
        `write to ${dirname(file)}, and can read and write ${file} if it's there, and that it isn't a directory, then ` +
        'run setup again.');
    }
    throw new Error(`${file} isn't a lock setup can take (${code ?? 'no code'}: ${message}). If no setup is running ` +
      'in this directory, take it away and run setup again.');
  }
  const held = db;
  return { release: () => held.close() };
}

// Every file Bun 1.4.4 can read by default from the directory it starts in, whichever mode: .env.<mode>.local,
// .env.local (not under test), .env.<mode> and .env, where mode is production or test as NODE_ENV says, and
// development otherwise. All of them, since the NODE_ENV setup sees can itself be one a file gave, which doesn't
// change the set Bun read. Each is read in whatever form it's in, not setup's alone, with node:util's parseEnv, which
// Bun 1.4.4 implements as its loader reads a file but for `$`: it keeps `\$`, which the loader reads as `$`, and
// doesn't expand `$NAME` (probed).
const DOTENV_FILES = ['.env', '.env.local', ...['development', 'production', 'test'].flatMap((mode) => [`.env.${mode}`, `.env.${mode}.local`])];

function withoutDotEnv(env: Record<string, string | undefined>, cwd: string): Record<string, string | undefined> {
  const files = DOTENV_FILES.map((name) => {
    try {
      return parseEnv(readFileSync(join(cwd, name), 'utf-8'));
    } catch {
      return {};
    }
  });
  const read = (file: NodeJS.Dict<string>, name: string) =>
    (Object.hasOwn(file, name) ? file[name] : undefined)?.replace(/\\\$/g, '$');
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => !files.some((file) => read(file, name) === value)));
}

const readFailure = (error: unknown) => (error as NodeJS.ErrnoException).code ?? (error as Error).message;

const BEFORE_RECORD = new Set(['releases', 'current', 'current.tmp', 'install.json.tmp']);

const SETUPS_OWN = new Set([
  'releases', 'current', 'current.tmp', 'install.json', 'install.json.tmp', ENTRY_POINT, `${ENTRY_POINT}.tmp`,
  INSTALL_COMMAND, `${INSTALL_COMMAND}.tmp`,
]);

function samePath(a: string, b: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(a) === real(b);
}

function setupModel(path: string): { model: string } | { damage: string | null } {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    return { damage: code === 'ENOENT' ? null : `can't be read (${code ?? (error as Error).message})` };
  }
  let recipe: { agent?: { model?: unknown } } | null;
  try {
    recipe = JSON.parse(text) as typeof recipe;
  } catch {
    return { damage: 'isn\'t JSON' };
  }
  const model = recipe?.agent?.model;
  return typeof model === 'string' && model !== '' ? { model } : { damage: 'names no agent.model' };
}

function othersInstalled(dir: string): { names: string[] } | { unreadable: string } {
  const path = join(dir, 'package.json');
  let manifest: Record<string, unknown> | null;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf-8')) as typeof manifest;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT') return { names: [] };
    return { unreadable: `${path} can't be read (${code ?? 'it isn\'t JSON'})` };
  }
  const setups = new Set<string>([PACKAGE, ...Object.values(SERVERS)]);
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const listed = manifest?.[field];
    if (listed && typeof listed === 'object') for (const name of Object.keys(listed)) if (!setups.has(name)) names.add(name);
  }
  return { names: [...names].sort() };
}

/** Where the install's own setup, its recipe or its boot failed: prints the way to a fresh start and answers null
 *  where nothing of the resident's is in the data directory or recorded outside it, and the root holds only the
 *  names a first run makes there, one release among them at most; otherwise answers why taking the install away
 *  isn't known to lose nothing, for the caller to follow with the step it failed at, whose lines above say what to
 *  put right. The root holds an update's copies of the resident's data and its records beside setup's names
 *  (installPaths in src/update/contract.ts), and a second release once an update has run, so the names and the
 *  count are what keep the offer from them; what kind of thing each name is, and what's inside it, isn't read. */
function freshStart(err: (line: string) => void, { dir, root, dataDir }: { dir: string; root: string; dataDir: string }): string | null {
  const recordPath = join(root, 'install.json');
  let record: InstallRecord | null;
  try {
    record = readRecord<InstallRecord>(recordPath, 'install record');
  } catch (error) {
    return error instanceof ContractError ? error.message.replace(/\.+$/, '')
      : `${recordPath} can't be read (${(error as Error).message})`;
  }
  if (record === null) {
    let names: string[] = [];
    try {
      names = readdirSync(root).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return `${root} can't be read (${readFailure(error)})`;
    }
    if (names.includes('install.json')) {
      return `${recordPath} is a link that leads nowhere, so taking ${root} away isn't known to lose nothing`;
    }
    const after = names.find((name) => !BEFORE_RECORD.has(name));
    if (after !== undefined) {
      return `${recordPath} is missing, and ${root} holds ${after}, which a first run doesn't make before its ` +
        `record, so taking ${root} away isn't known to lose nothing`;
    }
  }
  if (!existsSync(dataDir)) return `${dataDir}, the data directory the install serves, isn't there`;
  let inData: string[];
  try {
    inData = readdirSync(dataDir);
  } catch (error) {
    return `${dataDir}, the data directory the install serves, can't be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`;
  }
  if (inData.length > 0) return `The install serves the resident's data in ${dataDir}`;
  if (record !== null && !Array.isArray(record.extraState)) {
    return `${recordPath} doesn't say what state the resident keeps outside its data directory`;
  }
  if (record !== null && !samePath(record.dataDir, join(dir, 'data'))) {
    return `${recordPath} names ${record.dataDir} as the data directory the install serves, not ${join(dir, 'data')}`;
  }
  if (record !== null && record.extraState.length > 0) {
    return `${recordPath} records state the resident keeps outside ${join(dir, 'data')}`;
  }
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return `${root} can't be read (${readFailure(error)})`;
  }
  if (!names.every((name) => SETUPS_OWN.has(name))) return `${root} holds more than a first run makes`;
  if (names.includes('releases')) {
    const releasesDir = join(root, 'releases');
    let copies: string[];
    try {
      copies = readdirSync(releasesDir);
    } catch (error) {
      return `${releasesDir} can't be read (${readFailure(error)})`;
    }
    if (copies.filter((copy) => !copy.endsWith('.tmp')).length > 1) return `${root} holds more than a first run makes`;
  }
  const others = othersInstalled(dir);
  if ('unreadable' in others) return others.unreadable;
  const packages = join(dir, 'node_modules');
  const checked = `Nothing of the resident's is in ${dataDir} yet, the install records nothing kept outside it, and ` +
    `${root} holds only the names a first run makes there.`;
  err(others.names.length === 0
    ? `${checked} Once what the lines above say is put right, this takes it and the packages away, and setup run ` +
      'again installs afresh:'
    : `${checked} ${join(dir, 'package.json')} also names ${others.names.join(', ')}, which aren't setup's, ` +
      `and taking ${packages} away takes any of them it holds. Once what the lines above say is put right, this ` +
      'takes both away, and setup run again installs its own afresh:');
  err(`  rm -rf ${shellWord(root)} ${shellWord(packages)}`);
  return null;
}

async function yesNo(world: SetupWorld, question: string): Promise<boolean | null> {
  for (;;) {
    const answer = await world.ask(question);
    if (answer === null) return null;
    const word = answer.trim().toLowerCase();
    if (word === 'yes' || word === 'y') return true;
    if (word === 'no' || word === 'n') return false;
  }
}

async function pick(world: SetupWorld, question: string, fallback: '1' | '2'): Promise<'1' | '2' | null> {
  for (;;) {
    const answer = await world.ask(question);
    if (answer === null) return null;
    const word = answer.trim() || fallback;
    if (word === '1' || word === '2') return word;
  }
}

async function userName(world: SetupWorld, out: (line: string) => void): Promise<string | null> {
  for (;;) {
    const answer = await world.ask('Its user\'s name [connectome]: ');
    if (answer === null) return null;
    const name = answer.trim() || 'connectome';
    if (USER_NAME.test(name)) return name;
    out('A user\'s name here is lowercase letters, digits, - and _, starting with a letter or _, at most 32.');
  }
}

function installedVersion(dir: string, name: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf-8')) as { version?: string })
      .version ?? null;
  } catch {
    return null;
  }
}

function withoutKeys(env: Record<string, string | undefined>, keys: string[]): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined && !keys.includes(name)) kept[name] = value;
  return kept;
}

function ended(ran: Ran): string {
  if (ran.startError) return `it couldn't be started (${ran.startError.message})`;
  if (ran.signal) return `it was ended by ${ran.signal}`;
  return `exit ${ran.status}`;
}

function lastLines(ran: Ran, count: number): string[] {
  return `${ran.stdout}\n${ran.stderr}`.split('\n').filter((line) => line.trim() !== '').slice(-count);
}

function dollars(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

function costLine(model: string, gateway: boolean): string {
  const zero = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
    unclassifiedCacheWriteTokens: 0,
  };
  const priced = priceAnthropicCall(model, new Date().toISOString(), zero);
  const length = 'How many turns a setup takes isn\'t measured yet, so neither is what one costs.';
  if (priced === undefined) return `Setup's agent runs on ${model}, which this host has no prices for. ${length}`;
  const { rates } = priced;
  // agent-framework's Agent caches for an hour when its config sets no cacheTtl, as setup.json's doesn't.
  return `Setup's agent runs on ${model}, at Anthropic's list prices per million tokens: ` +
    `${dollars(rates.inputPerMillion)} input, ${dollars(rates.outputPerMillion)} output, ` +
    `${dollars(rates.cacheWrite1hPerMillion)} written to the prompt cache, which keeps it an hour, and ` +
    `${dollars(rates.cacheReadPerMillion)} read from it (${priced.pricingVersion}).` +
    `${gateway ? ' A gateway at ANTHROPIC_BASE_URL may charge otherwise.' : ''} ${length}`;
}

export function realWorld(): SetupWorld {
  // One interface a question: readline holds the terminal raw while it's open, so Ctrl-C between questions, as
  // during an install, reaches setup as a signal.
  const question = async (asking: (rl: Interface) => Promise<string>): Promise<string | null> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const gone = new Promise<null>((done) => rl.once('close', () => done(null)));
    try {
      return await Promise.race([asking(rl), gone]);
    } finally {
      rl.close();
    }
  };
  return {
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    platform: process.platform,
    user: userInfo().username,
    env: process.env,
    cwd: process.cwd(),
    bun: { path: process.execPath, version: Bun.version },
    hasSudo: Bun.which('sudo') !== null,
    lingerOf: (user) => lingerOf(user),
    ask: (text) => question((rl) => new Promise((done) => rl.question(text, done))),
    askHidden: (label) => question((rl) => askHiddenOn(rl, process.stdout, label)),
    run: runProgram,
    checkKey,
    startAgent,
  };
}

function runProgram(argv: string[], options: RunOptions): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd, env: options.env, stdio: ['ignore', options.show ? 'inherit' : 'pipe', options.show ? 'inherit' : 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    let timedOut = false;
    const limit = options.timeoutMs === undefined ? null : setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, options.timeoutMs);
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (limit) clearTimeout(limit);
      done({ status: null, stdout, stderr, startError: { code: error.code, message: error.message } });
    });
    child.on('close', (code, signal) => {
      if (limit) clearTimeout(limit);
      done({
        status: timedOut ? null : code, stdout, stderr,
        ...(timedOut ? { timedOut } : signal === null ? {} : { signal }),
      });
    });
  });
}

function startAgent(launch: AgentLaunch): Promise<number> {
  return new Promise((done) => {
    // The terminal's Ctrl-C reaches every process in its foreground group, this one too.
    const keep = () => {};
    process.on('SIGINT', keep);
    const child = spawn(launch.argv[0]!, launch.argv.slice(1), { cwd: launch.cwd, env: launch.env, stdio: 'inherit' });
    child.on('error', (error) => {
      process.off('SIGINT', keep);
      process.stderr.write(`connectome setup: the agent's host couldn't be started: ${error.message}\n`);
      done(1);
    });
    child.on('close', (code, signal) => {
      process.off('SIGINT', keep);
      if (signal !== null) {
        process.stderr.write(`connectome setup: the agent's host was ended by ${signal}. Setup's answers and key are kept, ` +
          'so running setup again in this directory goes on.\n');
      }
      done(code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0)));
    });
  });
}
