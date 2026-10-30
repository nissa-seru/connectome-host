import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ContractError, INSTALL_ROOT_ENV, RESTART_EXIT_CODE, installPaths, pendingGoBack, readCurrent, readJournal, readMark,
  readRecord, realOrResolved, unfinishedTrial, writeJsonAtomic, writeTextAtomic, type JournalLine, type Mark,
} from '../update/contract.js';
import { RESTART_PROPERTIES, restartPolicy, systemdUnits } from '../update/setup.js';
import { shellWord } from '../update/launcher.js';
import { lingerOf } from '../setup/linger.js';
import { StoredSecrets, envForm, readEnvFile, storedSecretRedactor, writeEnvValue } from '../setup/secrets.js';
import {
  READY_WAIT_MS as HOST_READY_WAIT_MS, dataDirOf, openHost, type HostClient, type HostReady, type NoHost,
} from './host-socket.js';
import { armedName, type ArmedSwitch, type UpdateStatus } from '../web/update-text.js';
import type { CliCommand, CliContext } from './connectome.js';

/** Set to 1 in the host's service by `connectome service install`: in a systemd unit once systemd shows that it
 *  restarts the host when it exits with 75 and with 1, and in a launch agent, whose KeepAlive restarts the host
 *  whenever it exits other than with 0. */
export const SUPERVISED_ENV = 'CONNECTOME_SUPERVISED';

const SHELL_PACKAGE = 'term-sessions-mcp';
const SHELL_BIN = 'session-server';
const SHELL_PORTS = { first: 3100, last: 3199 };
const READY_WAIT_MS = 60_000;
const RECIPE_CHECK_MS = 60_000;
const FIRST_MINUTE_S = 60;
const LOG_LINES = 40;
const ENDED_ENTRIES = 200;
const INVOCATION_FIELDS = ['_SYSTEMD_INVOCATION_ID', 'USER_INVOCATION_ID', 'INVOCATION_ID'];
const LOOKS_LIKE_ERROR = /\b(error|fatal|failed|refused|refuses)\b/i;
const SERVICE_USAGE = 'connectome service install [<recipe>] | stop | start';
const RUNNING = new Set(['active', 'activating', 'reloading']);
const STOPPING = new Set([...RUNNING, 'deactivating']);
const RECORD_AGAIN = 'Name the recipe to write the service and its record again: connectome service install <recipe>';

export interface ServiceUnit {
  name: string;
  file: string;
}

export interface ServiceRecord {
  v: 1;
  manager: 'systemd-user' | 'launchd';
  units: { host: ServiceUnit; shell?: ServiceUnit };
  hostArgs: string[];
  workingDirectory: string;
  logs: { kind: 'journal' } | { kind: 'file'; path: string };
}

export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** What the host's own recipe loader made of the recipe: it loads, it refuses it in `words`, or it couldn't be run
 *  to the end, for the reason `why` gives. */
export type RecipeLoad = { loads: true } | { loads: false; words: string } | { loads: null; why: string };

export interface ServiceSystem {
  platform: NodeJS.Platform;
  user: string;
  uid: number;
  home: string;
  cwd: string;
  env: Record<string, string | undefined>;
  bun: string;
  /** This process's /proc/self/cgroup, or null where there's none to read. */
  cgroup(): string | null;
  which(name: string): string | null;
  run(command: string, args: string[], env: Record<string, string>): Ran;
  loadRecipe(recipe: string, work: string, env: Record<string, string>): RecipeLoad;
  linger(user: string): boolean | null;
  portFree(port: number): Promise<boolean>;
  openHost(root: string): Promise<HostClient | NoHost>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Calls `fire` after `ms` unless the returned cancel runs first. */
  after(ms: number, fire: () => void): () => void;
}

export function machine(): ServiceSystem {
  const me = userInfo();
  return {
    platform: process.platform,
    user: me.username,
    uid: me.uid,
    home: homedir(),
    cwd: process.cwd(),
    env: process.env,
    bun: process.execPath,
    cgroup: () => {
      try {
        return readFileSync('/proc/self/cgroup', 'utf-8');
      } catch {
        return null;
      }
    },
    which: (name) => Bun.which(name),
    run: (command, args, env) => {
      try {
        const ran = Bun.spawnSync([command, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
        return { status: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
      } catch (error) {
        return { status: null, stdout: '', stderr: errorText(error) };
      }
    },
    loadRecipe: (recipe, work, env) => loadRecipeAsHost(process.execPath, recipe, work, env),
    linger: (user) => lingerOf(user),
    portFree,
    openHost,
    sleep: (ms) => Bun.sleep(ms),
    now: () => performance.now(),
    after: (ms, fire) => {
      const timer = setTimeout(fire, ms);
      return () => clearTimeout(timer);
    },
  };
}

export async function portFree(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1']) {
    const free = await new Promise<boolean>((done) => {
      const server = createServer();
      // A system without IPv6 has no ::1 for anything to hold the port on.
      server.once('error', (error: NodeJS.ErrnoException) =>
        done(host === '::1' && (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')));
      server.listen(port, host, () => server.close(() => done(true)));
    });
    if (!free) return false;
  }
  return true;
}

const RECIPE_LOADER = fileURLToPath(new URL('../recipe.js', import.meta.url));

/** Loads `recipe` with the host's own loader, as the host loads it at its start: in a child Bun in `work`, with `env`
 *  as its whole environment, so that Bun loads `work`'s .env first. */
export function loadRecipeAsHost(bun: string, recipe: string, work: string, env: Record<string, string>): RecipeLoad {
  const script = `const { loadRecipeDetailed } = await import(${JSON.stringify(RECIPE_LOADER)});\n` +
    `try { await loadRecipeDetailed(${JSON.stringify(recipe)}); } catch (error) {\n` +
    '  console.log(`\\n${JSON.stringify({ refused: error instanceof Error ? error.message : String(error) })}`);\n' +
    '  process.exit(1);\n}\nprocess.exit(0);\n';
  let ran: Bun.SyncSubprocess<'pipe', 'pipe'>;
  try {
    ran = Bun.spawnSync([bun, '-e', script], { cwd: work, env, stdout: 'pipe', stderr: 'pipe', timeout: RECIPE_CHECK_MS });
  } catch (error) {
    return { loads: null, why: errorText(error) };
  }
  if (ran.exitCode === 0) return { loads: true };
  if (ran.exitedDueToTimeout) return { loads: null, why: `it hadn't loaded after ${RECIPE_CHECK_MS / 1000} s` };
  const refused = ran.exitCode === 1 ? refusalOf(ran.stdout.toString()) : null;
  if (refused !== null) return { loads: false, words: refused };
  const said = ran.stderr.toString().trim().split('\n').at(-1)?.trim();
  return { loads: null, why: said || `the loader exited with ${ran.exitCode ?? ran.signalCode}` };
}

function refusalOf(stdout: string): string | null {
  try {
    const refused = (JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { refused?: unknown } | null)?.refused;
    return typeof refused === 'string' ? refused : null;
  } catch {
    return null;
  }
}

export const serviceCommand: CliCommand = {
  name: 'service',
  usage: SERVICE_USAGE,
  summary: 'Sets up, stops and starts this install\'s service.',
  words: [
    'install: writes and starts this install\'s service, then checks it. The first install names the recipe; run ' +
      'again, it keeps the recorded one.',
    'stop: stops the service install set up, and says what its next start does about an update under way or ' +
      'marked. It stays installed.',
    'start: starts what of that service isn\'t running, then waits for its host and checks it, as install does.',
  ],
  run: (ctx) => runService(ctx),
};

class Refusal extends Error {}

export async function runService(ctx: CliContext, sys: ServiceSystem = machine()): Promise<number> {
  const [verb, ...rest] = ctx.argv;
  if (verb === 'install' && rest.length <= 1) return installService(ctx, sys);
  if ((verb === 'stop' || verb === 'start') && rest.length === 0) {
    try {
      return await (verb === 'stop' ? stopService : startService)(ctx, sys);
    } catch (error) {
      if (!(error instanceof Refusal) && !(error instanceof ContractError)) throw error;
      ctx.err(`connectome: ${error.message}`);
      return 1;
    }
  }
  ctx.err(`Usage: ${SERVICE_USAGE}`);
  return 2;
}

export async function installService(ctx: CliContext, sys: ServiceSystem = machine()): Promise<number> {
  const given = ctx.argv[1];
  const root = ctx.root!;
  let old: ServiceRecord | null = null;
  try {
    old = readServiceRecord(root);
  } catch (error) {
    if (given === undefined) {
      ctx.err(`connectome: ${errorText(error)} ${RECORD_AGAIN}`);
      return 1;
    }
    ctx.out(`${errorText(error)} This run replaces it with a new record once it has written a unit file.`);
  }
  if (given === undefined && old === null) {
    ctx.err('connectome: the first install needs the recipe: connectome service install <recipe>');
    return 2;
  }
  try {
    const recipe = given === undefined ? old!.hostArgs[0]! : /^https?:\/\//.test(given) ? given : resolve(sys.cwd, given);
    return await install(ctx, sys, root, recipe, old);
  } catch (error) {
    if (!(error instanceof Refusal) && !(error instanceof ContractError)) throw error;
    ctx.err(`connectome: ${error.message}`);
    return 1;
  }
}

interface ShellPlan {
  bin: string;
  port: string;
  token: string;
  newPort: boolean;
  newToken: boolean;
}

async function install(ctx: CliContext, sys: ServiceSystem, root: string, recipe: string,
  old: ServiceRecord | null): Promise<number> {
  plain(recipe, 'the recipe');
  const work = dirname(root);
  if (!/^https?:\/\//.test(recipe) && !isFile(recipe)) {
    throw new Refusal(`there's no recipe at ${recipe}.`);
  }
  const manager = managerOf(sys);
  const slug = slugOf(basename(work));
  if (slug === '') {
    throw new Refusal(`a service's name comes from its working directory's name, and ${basename(work)} has no letter ` +
      `or digit to make one from, so nothing was written. Set this resident up again in a directory whose name has one.`);
  }
  const dataDir = dataDirOf(root);
  const envFile = join(work, '.env');
  if (lstatSync(envFile, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Refusal(`${envFile} is a link to ${readlinkSync(envFile)}. The install's .env is a file of its own, as ` +
      'setup keeps it, so service install won\'t write through the link or over it. Replace the link with the file it ' +
      'leads to, if that\'s there, or take it away, then run connectome service install again. Nothing was written.');
  }
  let outside: Error | null;
  try {
    outside = envForm(envFile);
  } catch (error) {
    throw new Refusal(`${errorText(error)}. Nothing was written.`);
  }
  if (outside !== null) {
    throw new Refusal(`${outside.message}. Then run connectome service install again. Nothing was written.`);
  }
  const env = childEnv(sys);
  const names = unitNames(manager, slug, sys);
  const shellBin = shellOf(work, sys);
  const units = shellBin === null ? [names.host] : [names.shell, names.host];
  insideNeither(sys, manager, names, units);
  for (const unit of units) ownedOrFree(unit, manager, work, sys, env);
  if (manager === 'systemd-user') noOtherHost(ctx, work, names, sys, env);
  const node = sys.which('node');
  const path = [...new Set([dirname(sys.bun), ...(node ? [dirname(node)] : []), '/usr/local/bin', '/usr/bin', '/bin'])]
    .join(':');
  const hostArgs = [recipe, '--headless'];
  const logPath = join(work, 'logs', 'agent.log');
  const shell = shellBin === null ? null : await shellPlan(sys, work, shellBin);

  const shellArgv = shell === null ? [] : [node!, shell.bin, '--host', 'localhost', '--headless'];
  const shellSettings: Array<[string, string]> = shell === null ? []
    : [['SESSION_SERVER_PORT', shell.port], ['SESSION_SERVER_TOKEN', shell.token]];
  const shellVars: Array<[string, string]> = shell === null ? [] : [['PATH', path], ...shellSettings];
  const hostArgv = [sys.bun, join(root, 'start.js'), ...hostArgs];
  const hostVars: Array<[string, string]> = [['PATH', path], ['DATA_DIR', dataDir]];
  const texts = manager === 'systemd-user'
    ? {
      shell: shell === null ? null : systemdUnit(`connectome-host resident's shell daemon in ${work}`, work, shellArgv,
        shellVars, null),
      host: systemdUnit(`connectome-host resident in ${work}`, work, hostArgv, [...hostVars, [SUPERVISED_ENV, '1']],
        shell === null ? null : names.shell.name),
      unchecked: systemdUnit(`connectome-host resident in ${work}`, work, hostArgv, hostVars,
        shell === null ? null : names.shell.name),
    }
    : {
      shell: shell === null ? null : plist(names.shell.name, work, shellArgv, shellVars, join(work, 'logs', 'shell.log')),
      host: plist(names.host.name, work, hostArgv, [...hostVars, [SUPERVISED_ENV, '1']], logPath),
      unchecked: null,
    };
  recipeLoads(sys, recipe, work,
    [...hostVars, [SUPERVISED_ENV, '1'], [INSTALL_ROOT_ENV, realOrResolved(root)], ...shellSettings], shell?.token);
  const dropped = shell === null ? [names.shell] : [];

  const record: ServiceRecord = {
    v: 1,
    manager,
    units: { host: names.host, ...(shell === null ? {} : { shell: names.shell }) },
    hostArgs,
    workingDirectory: work,
    logs: manager === 'systemd-user' ? { kind: 'journal' } : { kind: 'file', path: logPath },
  };
  let touched = false;
  const writeUnit = (unit: ServiceUnit, text: string) => {
    try {
      writeText(unit.file, text);
    } catch (error) {
      throw new Refusal(`${unit.file} can't be written: ${errorText(error)}. Nothing was started or restarted.`);
    }
    touched = true;
  };
  try {
    for (const unit of dropped) removeUnit(ctx, sys, env, manager, unit, work);
    if (shell !== null) keepShellSettings(ctx, sys, work, shell);
    if (manager === 'systemd-user') {
      if (texts.shell !== null) {
        writeUnit(names.shell, texts.shell);
        ctx.out(`Wrote ${names.shell.file}, the resident's shell daemon's unit.`);
      }
      writeUnit(names.host, texts.unchecked!);
      systemctl(sys, env, ['daemon-reload']);
      const loaded = showUnit(sys, env, names.host.name, ['LoadState', 'WorkingDirectory', RESTART_PROPERTIES]);
      if (typeof loaded === 'string') throw new Refusal(`${loaded}. Nothing was started.`);
      if (loaded.get('LoadState') !== 'loaded' ||
        runsFrom(loaded.get('WorkingDirectory') ?? '', sys.home) !== realOrResolved(work)) {
        throw new Refusal(`systemd didn't load ${names.host.name} from ${names.host.file} with ${work} as its working ` +
          `directory (it shows ${loaded.get('LoadState') || 'no load state'}, in ` +
          `${loaded.get('WorkingDirectory') || 'no set directory'}), so whether it restarts the host can't be checked. ` +
          'Nothing was started.');
      }
      const policy = restartPolicy(loaded);
      if (!policy.restarts) {
        throw new Refusal(`systemd shows ${names.host.name} with ${policy.settings}, so it doesn't restart the host both ` +
          `when it exits with ${RESTART_EXIT_CODE}, as an update's restart does, and with 1, as a failed update does. A ` +
          `drop-in may override the unit: ${systemctlLine(sys, `cat ${names.host.name}`)} shows every file it's read ` +
          `from. Its unit is left without ${SUPERVISED_ENV}=1, and nothing was started or restarted. A host it runs ` +
          `now keeps what it started with, ${SUPERVISED_ENV}=1 included if it started with it, until it starts again: ` +
          `${systemctlLine(sys, `restart ${names.host.name}`)} restarts it on the unit as it is now: the file this run ` +
          `wrote, with the recipe it was given, and any drop-in over it. Once the unit ` +
          `restarts the host on ${RESTART_EXIT_CODE} and 1, run connectome service install again, which sets the line.`);
      }
      writeUnit(names.host, texts.host);
      systemctl(sys, env, ['daemon-reload']);
      ctx.out(`Wrote ${names.host.file}. systemd restarts it when the host exits with ${RESTART_EXIT_CODE} and with 1 ` +
        `(${policy.settings}), so its unit sets ${SUPERVISED_ENV}=1.`);
      systemctl(sys, env, ['enable', ...units.map((unit) => unit.name)]);
      ctx.out(`Enabled ${units.map((unit) => unit.name).join(' and ')}, so systemd starts ` +
        `${units.length === 1 ? 'it' : 'them'} at boot.`);
      systemctl(sys, env, ['reset-failed', ...units.map((unit) => unit.name)]);
      for (const unit of units) {
        const shown = showUnit(sys, env, unit.name, ['ActiveState']);
        if (typeof shown === 'string') {
          throw new Refusal(`${shown}. The units' files are written and enabled, and recorded: run connectome service ` +
            'install again to start what isn\'t running.');
        }
        const running = RUNNING.has(shown.get('ActiveState') ?? '');
        systemctl(sys, env, ['restart', unit.name]);
        ctx.out(running ? `Restarted ${unit.name}, so it runs its unit as it is now.` : `Started ${unit.name}.`);
      }
    } else {
      mkdirSync(dirname(logPath), { recursive: true });
      chmodSync(dirname(logPath), 0o700);
      for (const unit of units) writeUnit(unit, unit === names.host ? texts.host : texts.shell!);
      ctx.out(`KeepAlive restarts the host whenever it exits other than with 0, so its launch agent sets ${SUPERVISED_ENV}=1.`);
      for (const unit of units) {
        const loaded = sys.run('launchctl', ['list', unit.name], env).status === 0;
        if (loaded) bootout(sys, env, unit);
        const ran = loadAgent(sys, env, unit, unit === names.host ? logPath : join(work, 'logs', 'shell.log'));
        if (ran.status !== 0) {
          throw new Refusal(`launchctl bootstrap gui/${sys.uid} ${unit.file} failed: ${stderrOf(ran)}. ` +
            `${loaded ? `${unit.name} was booted out first, so it's stopped` : `${unit.name} isn't loaded`}: run ` +
            'connectome service install again to load it.');
        }
        ctx.out(`${loaded ? 'Reloaded' : 'Loaded'} ${unit.name} from ${unit.file}.`);
      }
      ctx.out(`launchd loads ${units.length === 1 ? 'this agent' : 'these agents'}, and so starts ` +
        `${units.length === 1 ? 'it' : 'them'}, each time ${sys.user} logs in.`);
    }
  } finally {
    if (touched) {
      writeJsonAtomic(join(root, 'service.json'), record, 0o600);
      ctx.out(`Recorded it in ${join(root, 'service.json')}.`);
    }
  }

  const passed = await readyAndChecked(ctx, root, record, sys, env);
  if (!passed) {
    const before = old?.hostArgs[0];
    if (before !== undefined && before !== recipe) {
      let shown: string | null;
      try {
        shown = installRedactor(work, sys)(before);
      } catch {
        shown = null;
      }
      ctx.out(shown === null
        ? 'Before this run, service.json recorded another recipe, which isn\'t shown, since the install\'s secrets can\'t ' +
          'all be kept out of it.'
        : shown === before
          ? `Before this run, service.json recorded the recipe ${before}: connectome service install ${shellWord(before)} ` +
            'puts it back, if the host\'s recipe loader still takes it.'
          : `Before this run, service.json recorded the recipe ${shown}, which holds one of the install's secrets: ` +
            'connectome service install with that recipe, the secret in its place, puts it back, if the host\'s recipe ' +
            'loader still takes it.');
    }
    ctx.out(`Put right what the lines above show, then run connectome service install again. Until then ${manager === 'systemd-user'
      ? 'systemd restarts the host each time it fails, while it has its unit loaded and its start limit allows; the ' +
        'run clears that limit'
      : 'launchd starts the host again each time it exits other than with 0, while it has its agent loaded'}.`);
  }
  for (const line of serviceLines(root) ?? []) ctx.out(line);
  return passed ? 0 : 1;
}

async function readyAndChecked(ctx: CliContext, root: string, record: ServiceRecord, sys: ServiceSystem,
  env: Record<string, string>): Promise<boolean> {
  const ready = await awaitReady(root, record, sys, env);
  if (typeof ready === 'string') ctx.err(`connectome: ${ready}`);
  else ctx.out(`Its host answers: pid ${ready.pid}, recipe ${ready.recipe}.`);
  const checked = await checkService(root, sys);
  for (const line of checked.lines) ctx.out(line);
  return checked.passed && typeof ready !== 'string';
}

function recordOf(root: string): ServiceRecord {
  let record: ServiceRecord | null;
  try {
    record = readServiceRecord(root);
  } catch (error) {
    throw new Refusal(`${errorText(error)} ${RECORD_AGAIN}`);
  }
  if (record === null) {
    throw new Refusal('connectome service install hasn\'t set up a service for this install: connectome service install ' +
      '<recipe> sets one up.');
  }
  return record;
}

function unitsOf(record: ServiceRecord): ServiceUnit[] {
  return [record.units.host, ...(record.units.shell === undefined ? [] : [record.units.shell])];
}

function fileOf(manager: ServiceRecord['manager']): string {
  return manager === 'launchd' ? 'launch agent\'s file' : 'unit file';
}

function thisInstalls(record: ServiceRecord, sys: ServiceSystem, env: Record<string, string>,
  verb: 'stop' | 'start'): void {
  const done = verb === 'stop' ? 'stopped' : 'started';
  for (const unit of unitsOf(record)) {
    const owner = ownerOf(unit, record.manager, record.workingDirectory, sys, env);
    if (owner.kind === 'unshown') throw new Refusal(`${owner.shown}. Nothing was ${done}.`);
    if (owner.kind === 'untold') {
      const stopIt = stopLine(sys, record.manager, unit.name);
      const remedy = verb === 'stop'
        ? `stop it with ${stopIt}, then run connectome service stop again, which stops the rest of the service; ` +
          'connectome service install sets its service up again when it\'s wanted back.'
        : `stop it (${stopIt}), then run connectome service install again.`;
      throw new Refusal(`${untold(sys, record.manager, unit)}. connectome service ${verb} leaves it alone, and nothing ` +
        `was ${done}. If it's this install's, ${remedy}`);
    }
    if (owner.kind === 'other') {
      throw new Refusal(`${unit.name} (${owner.from}) runs ${runsWhat(owner.runsIn)}, not this one in ` +
        `${record.workingDirectory}, so connectome service ${verb} leaves it alone. Nothing was ${done}: connectome ` +
        'service install says how to set this install\'s service up again.');
    }
  }
}

async function stopService(ctx: CliContext, sys: ServiceSystem): Promise<number> {
  const root = ctx.root!;
  const record = recordOf(root);
  const units = unitsOf(record);
  const inside = insideOf(sys, record.manager, units);
  if (inside !== undefined) {
    throw new Refusal(`connectome service stop stops ${inside.name}, and this command runs inside it, so that would end ` +
      'this command partway, before it says what the service\'s next start does. Nothing was stopped. Ask whoever runs ' +
      'this machine to run it from a terminal outside the resident\'s service, such as over ssh.');
  }
  const env = childEnv(sys);
  thisInstalls(record, sys, env, 'stop');
  const waiting = sys.after(ASK_NOTICE_MS, () => ctx.out(`Asking the host whether it has a switch armed before ` +
    `stopping: no answer yet after ${ASK_NOTICE_MS / 1000} s, and it waits up to ${ASK_LIMIT_MS / 1000} s.`));
  let armed: Awaited<ReturnType<typeof armedBeforeStop>>;
  try {
    armed = await armedBeforeStop(root, sys);
  } finally {
    waiting();
  }
  thisInstalls(record, sys, env, 'stop');
  let hostRan = false;
  if (record.manager === 'systemd-user') {
    const stopped = stopUnits(ctx, sys, env, units);
    if (!stopped.all) return 1;
    hostRan = stopped.hostRan;
  } else {
    for (const unit of units) {
      const listed = sys.run('launchctl', ['list', unit.name], env);
      if (listed.status !== 0) {
        ctx.out(`${unit.name} wasn't running.`);
        continue;
      }
      bootout(sys, env, unit);
      const pid = pidOf(listed.stdout);
      if (unit === record.units.host) hostRan = pid !== undefined;
      ctx.out(pid === undefined ? `${unit.name} wasn't running, and launchd no longer has it loaded.`
        : `Stopped ${unit.name}.`);
    }
  }
  for (const line of startsAgain(record, sys, env)) ctx.out(line);
  const state = updateState(root, 'the next start');
  for (const line of state) ctx.out(line);
  if (hostRan && state.length === 0 && armed !== null) {
    ctx.out('armed' in armed
      ? `${armedName(armed.armed)} armed at ${armed.armed.since} was dropped by this stop, since an armed switch lasts ` +
        'only while its host runs. Once the host is back, its agent can arm it again.'
      : `Whether its host had a switch armed couldn't be told before the stop (${armed.unknown}), so if one was, this ` +
        'stop dropped it too, and its agent can arm it again once the host is back.');
  }
  return 0;
}

const ARMED_WAIT_MS = 10_000;
const ASK_NOTICE_MS = 1_000;
const ASK_LIMIT_MS = HOST_READY_WAIT_MS + ARMED_WAIT_MS;

async function armedBeforeStop(root: string, sys: ServiceSystem): Promise<{ armed: ArmedSwitch } | { unknown: string } | null> {
  let host: HostClient | NoHost;
  try {
    host = await sys.openHost(root);
  } catch (error) {
    return { unknown: `its host couldn't be asked: ${errorText(error)}` };
  }
  if ('reason' in host) return host.down ? null : { unknown: host.reason };
  host.subscribe([]);
  const health = await host.request({ type: 'panel-request', op: 'health' }, ARMED_WAIT_MS);
  host.close();
  if (health?.ok !== true) {
    return { unknown: health === null ? `no answer came within ${ARMED_WAIT_MS / 1000} s, or the connection closed first`
      : String(health.error ?? 'the host gave no reason') };
  }
  const update = (health.data as { update?: UpdateStatus } | undefined)?.update;
  if (update === undefined) return { unknown: 'its answer carried no update state' };
  return update.armed ? { armed: update.armed } : null;
}

function stopUnits(ctx: CliContext, sys: ServiceSystem, env: Record<string, string>,
  units: ServiceUnit[]): { all: boolean; hostRan: boolean } {
  const before = units.map((unit) => {
    const shown = showUnit(sys, env, unit.name, ['ActiveState']);
    if (typeof shown === 'string') throw new Refusal(`${shown}. Nothing was stopped.`);
    return STOPPING.has(shown.get('ActiveState') ?? '');
  });
  const running = units.filter((_, at) => before[at]);
  let stopped = true;
  if (running.length > 0) {
    const ran = sys.run('systemctl', ['--user', 'stop', ...running.map((unit) => unit.name)], env);
    if (ran.status !== 0) {
      ctx.err(`connectome: systemctl --user stop ${running.map((unit) => unit.name).join(' ')} failed: ${stderrOf(ran)}.`);
      stopped = false;
    }
  }
  units.forEach((unit, at) => {
    const shown = showUnit(sys, env, unit.name, ['ActiveState', 'SubState']);
    if (typeof shown === 'string') {
      ctx.err(`connectome: ${shown}, so whether ${unit.name} stopped can't be told.`);
      stopped = false;
    } else if (STOPPING.has(shown.get('ActiveState') ?? '')) {
      ctx.out(`${unit.name} is ${before[at] ? 'still ' : ''}${stateOf(shown)}.`);
      stopped = false;
    } else {
      ctx.out(before[at] ? `Stopped ${unit.name}.` : `${unit.name} wasn't running.`);
    }
  });
  return { all: stopped, hostRan: before[0] === true };
}

function startsAgain(record: ServiceRecord, sys: ServiceSystem, env: Record<string, string>): string[] {
  const gone = unitsOf(record).find((unit) => !existsSync(unit.file));
  if (gone === undefined) return [startsByItself(record, sys, env, true)];
  const refuses = `${gone.file}, ${gone.name}'s ${fileOf(record.manager)}, is gone, so connectome service start ` +
    'refuses until connectome service install writes it again.';
  return gone === record.units.host ? [refuses] : [startsByItself(record, sys, env, false), refuses];
}

function startsByItself(record: ServiceRecord, sys: ServiceSystem, env: Record<string, string>,
  startsToo: boolean): string {
  const host = record.units.host;
  const orStart = startsToo ? ', or with connectome service start' : '';
  if (record.manager === 'launchd') {
    return `${startsToo ? 'Its' : `${host.name}'s`} launch agent stays in ${dirname(host.file)}, so launchd starts it ` +
      `again when ${sys.user} next logs in${orStart}.`;
  }
  const shown = showUnit(sys, env, host.name, ['UnitFileState']);
  if (typeof shown === 'string') {
    return `Whether ${startsToo ? 'it' : host.name} starts at boot can't be told: ${shown}.` +
      `${startsToo ? ' connectome service start starts it again.' : ''}`;
  }
  const state = shown.get('UnitFileState') ?? '';
  if (state !== 'enabled') {
    return `${startsToo ? 'Its unit' : host.name} isn't enabled (systemd shows it as ${state || 'having no unit file ' +
      'state'}), so it doesn't start at boot: ${startsToo ? 'connectome service start starts it again, and ' : ''}` +
      'connectome service install enables it.';
  }
  const enabled = startsToo ? 'It\'s still enabled' : `${host.name} is still enabled`;
  return sys.linger(sys.user) === true
    ? `${enabled}, so it starts again when the machine next boots${orStart}.`
    : `${enabled}, but linger isn't on for ${sys.user}, so it doesn't start at boot` +
      `${startsToo ? ': connectome service start starts it again' : ''}.`;
}

function updateState(root: string, which: 'the next start' | 'this start'): string[] {
  const Which = `${which[0]!.toUpperCase()}${which.slice(1)}`;
  let lines: JournalLine[];
  let current: string | null;
  try {
    lines = readJournal(root);
    current = readCurrent(root);
  } catch (error) {
    return [`Whether an update is under way can't be told: ${errorText(error).replace(/\.?$/, '.')} ${Which}'s ` +
      'launcher reads the same files first, and starts nothing while it can\'t read them.'];
  }
  if (current === null) return [];
  const outcome = 'The host\'s log says what came of it.';
  const trial = unfinishedTrial(lines, current);
  if (trial !== null) {
    return [`${trial.to} was on trial and hadn't committed, so ${which} falls back to ${current}: it puts ` +
      `${current}'s data back, keeping aside what ${trial.to} left, and starts ${current} once that's done. ${outcome}`];
  }
  const pending = pendingGoBack(lines);
  if (pending !== null) {
    return [`A Go back to ${pending.to} was cut off partway, so ${which} goes on with it. ${outcome}`];
  }
  let mark: Mark | null;
  try {
    mark = readMark(root);
  } catch (error) {
    const why = error instanceof ContractError ? error.message
      : `The mark at ${installPaths(root).mark} couldn't be read: ${errorText(error)}.`;
    return [`${why} ${Which} says so too, and starts ${current} as it was.`];
  }
  if (mark === null) return [];
  if (mark.why === 'update') {
    return [`A switch to ${mark.to} is marked, so ${which} takes it up: it starts ${mark.to} on trial, unless it refuses ` +
      `the switch. ${outcome}`];
  }
  if (mark.why === 'go-back') {
    return [`A Go back to ${mark.to} is marked, so ${which} takes it up: ${mark.keepData
      ? `${mark.to} starts on the data as it is now`
      : `the copy of ${mark.to}'s data is restored, with what came since set aside, and ${mark.to} starts`}, unless it ` +
      `refuses the Go back. ${outcome}`];
  }
  return [`The mark at ${installPaths(root).mark} asks for a request this release doesn't know, so ${which} says so and ` +
    `starts ${current} as it was.`];
}

async function startService(ctx: CliContext, sys: ServiceSystem): Promise<number> {
  const root = ctx.root!;
  const record = recordOf(root);
  const units = unitsOf(record);
  const inside = insideOf(sys, record.manager, units);
  if (inside !== undefined) {
    throw new Refusal(`this command runs inside ${inside.name}, so that unit is running, and connectome service start is ` +
      'refused there, as install and stop are. Nothing was started. If the resident\'s service needs starting, ask ' +
      'whoever runs this machine to run it from a terminal outside it, such as over ssh.');
  }
  for (const unit of units) {
    if (!existsSync(unit.file)) {
      throw new Refusal(`${unit.file}, ${unit.name}'s ${fileOf(record.manager)}, is gone. connectome service install ` +
        'writes it again. Nothing was started.');
    }
  }
  const env = childEnv(sys);
  thisInstalls(record, sys, env, 'start');
  const started = record.manager === 'systemd-user'
    ? startUnits(ctx, sys, env, root, units)
    : startAgents(ctx, sys, env, root, record);
  if (!started) {
    for (const line of (await checkService(root, sys)).lines) ctx.out(line);
    return 1;
  }
  const passed = await readyAndChecked(ctx, root, record, sys, env);
  for (const line of serviceLines(root) ?? []) ctx.out(line);
  return passed ? 0 : 1;
}

function startUnits(ctx: CliContext, sys: ServiceSystem, env: Record<string, string>, root: string,
  units: ServiceUnit[]): boolean {
  const states = () => units.map((unit) => {
    const each = showUnit(sys, env, unit.name, ['ActiveState', 'SubState']);
    if (typeof each === 'string') throw new Refusal(`${each}. Nothing was started.`);
    return each;
  });
  let shown = states();
  const down = units.filter((_, at) => shown[at]!.get('ActiveState') === 'deactivating');
  if (down.length > 0) {
    const ran = sys.run('systemctl', ['--user', 'stop', ...down.map((unit) => unit.name)], env);
    if (ran.status !== 0) {
      ctx.err(`connectome: systemctl --user stop ${down.map((unit) => unit.name).join(' ')} failed: ${stderrOf(ran)}. ` +
        'connectome service start runs it to wait for a unit on its way down, and started nothing.');
      return false;
    }
    shown = states();
  }
  const idle = units.filter((_, at) => !RUNNING.has(shown[at]!.get('ActiveState') ?? '') ||
    shown[at]!.get('SubState') === 'auto-restart');
  if (idle.includes(units[0]!)) for (const line of updateState(root, 'this start')) ctx.out(line);
  if (idle.length > 0) {
    for (const verb of ['reset-failed', 'start']) {
      const args = [verb, ...idle.map((unit) => unit.name)];
      const ran = sys.run('systemctl', ['--user', ...args], env);
      if (ran.status !== 0) {
        ctx.err(`connectome: systemctl --user ${args.join(' ')} failed: ${stderrOf(ran)}.`);
        return false;
      }
    }
  }
  units.forEach((unit, at) => ctx.out(idle.includes(unit) ? `Started ${unit.name}.`
    : `${unit.name} was already ${stateOf(shown[at]!)}, so it wasn't started again.`));
  return true;
}

function startAgents(ctx: CliContext, sys: ServiceSystem, env: Record<string, string>, root: string,
  record: ServiceRecord): boolean {
  const order = [...(record.units.shell === undefined ? [] : [record.units.shell]), record.units.host];
  const states = order.map((unit) => {
    const listed = sys.run('launchctl', ['list', unit.name], env);
    return listed.status !== 0 ? 'unloaded' : pidOf(listed.stdout) === undefined ? 'loaded' : 'running';
  });
  if (states.at(-1) !== 'running') for (const line of updateState(root, 'this start')) ctx.out(line);
  for (const [at, unit] of order.entries()) {
    if (states[at] === 'running') {
      ctx.out(`${unit.name} was already running, so it wasn't started again.`);
      continue;
    }
    const ran = states[at] === 'loaded'
      ? sys.run('launchctl', ['kickstart', `gui/${sys.uid}/${unit.name}`], env)
      : loadAgent(sys, env, unit, unit === record.units.host && record.logs.kind === 'file' ? record.logs.path
        : join(record.workingDirectory, 'logs', unit === record.units.host ? 'agent.log' : 'shell.log'));
    if (ran.status !== 0) {
      ctx.err(`connectome: ${states[at] === 'loaded' ? `launchctl kickstart gui/${sys.uid}/${unit.name}`
        : `launchctl bootstrap gui/${sys.uid} ${unit.file}`} failed: ${stderrOf(ran)}.`);
      return false;
    }
    ctx.out(`Started ${unit.name}.`);
  }
  return true;
}

function loadAgent(sys: ServiceSystem, env: Record<string, string>, unit: ServiceUnit, log: string): Ran {
  if (existsSync(log)) renameSync(log, `${log}.previous`);
  return sys.run('launchctl', ['bootstrap', `gui/${sys.uid}`, unit.file], env);
}

function insideOf(sys: ServiceSystem, manager: ServiceRecord['manager'], units: ServiceUnit[]): ServiceUnit | undefined {
  const cgroups = (sys.cgroup() ?? '').split('\n').map((line) => line.split('/'))
    .filter((path) => path.includes(`user@${sys.uid}.service`));
  return units.find((unit) => manager === 'systemd-user'
    ? cgroups.some((path) => path.includes(unit.name))
    : sys.env.XPC_SERVICE_NAME === unit.name);
}

function insideNeither(sys: ServiceSystem, manager: ServiceRecord['manager'],
  names: { host: ServiceUnit; shell: ServiceUnit }, units: ServiceUnit[]): void {
  const inside = insideOf(sys, manager, [names.host, names.shell]);
  if (inside === undefined) return;
  throw new Refusal(`connectome service install ${units.includes(inside) ? 'restarts' : 'stops'} ${inside.name}, and ` +
    'this command runs inside it, so that would end this command partway, before its record and its check. Nothing ' +
    'was written. Ask whoever runs this machine to run it from a terminal outside the resident\'s service, such as ' +
    'over ssh.');
}

function installRedactor(work: string, sys: ServiceSystem, token?: string): (text: string) => string {
  const stored = storedSecretRedactor(work, sys.env);
  return (text) => stored(token === undefined ? text : text.replaceAll(token, '<SESSION_SERVER_TOKEN>')).text;
}

function recipeLoads(sys: ServiceSystem, recipe: string, work: string, vars: Array<[string, string]>,
  token: string | undefined): void {
  const loaded = sys.loadRecipe(recipe, work, { HOME: sys.home, USER: sys.user, LOGNAME: sys.user,
    ...Object.fromEntries(vars) });
  if (loaded.loads === true) return;
  let redact: (text: string) => string;
  try {
    redact = installRedactor(work, sys, token);
  } catch (error) {
    throw new Refusal(`${loaded.loads === false
      ? 'the host\'s own recipe loader, run in the working directory with .env, refuses the recipe, and its words'
      : 'whether the host can load the recipe couldn\'t be checked, and why'} aren't ` +
      `shown, since the install's secrets can't all be kept out of them: ${errorText(error).replace(/\.+$/, '')}. ` +
      'Nothing was written or restarted. Put that right, then run connectome service install again.');
  }
  throw new Refusal(loaded.loads === false
    ? 'the host\'s own recipe loader, run in the working directory with .env, refuses the recipe: ' +
      `${redact(loaded.words).replace(/\.+$/, '')}. Nothing was written or restarted.`
    : `whether the host can load the recipe couldn't be checked: ${redact(loaded.why).replace(/\.+$/, '')}. Nothing ` +
      'was written or restarted. Run connectome service install again once that\'s put right.');
}

function managerOf(sys: ServiceSystem): ServiceRecord['manager'] {
  if (sys.platform === 'darwin') return 'launchd';
  if (sys.platform !== 'linux') {
    throw new Refusal('service install writes systemd user units on Linux and launch agents on macOS, and this is ' +
      `${sys.platform}. Nothing was written.`);
  }
  const linger = sys.linger(sys.user);
  if (linger === null) {
    throw new Refusal('this system isn\'t running systemd, and service install writes systemd user units on Linux. ' +
      'Run the host under the service manager this system has, with its working directory and restarts on exit 75 ' +
      'and 1, as docs/DEPLOYMENTS.md says. Nothing was written.');
  }
  if (!linger) {
    throw new Refusal(`linger is off for ${sys.user}, so systemd would stop a user unit when ${sys.user} logs out. ` +
      'Nothing was written. Turn it on as root (or ask whoever administers this machine to), then run connectome ' +
      `service install again:\n  sudo loginctl enable-linger ${sys.user}`);
  }
  return 'systemd-user';
}

export function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function unitNames(manager: ServiceRecord['manager'], slug: string, sys: ServiceSystem):
  { host: ServiceUnit; shell: ServiceUnit } {
  if (manager === 'systemd-user') {
    const dir = join(sys.home, '.config', 'systemd', 'user');
    return {
      host: { name: `connectome-${slug}.service`, file: join(dir, `connectome-${slug}.service`) },
      shell: { name: `connectome-${slug}-shell.service`, file: join(dir, `connectome-${slug}-shell.service`) },
    };
  }
  const dir = join(sys.home, 'Library', 'LaunchAgents');
  const label = `com.animalabs.connectome.${slug}`;
  return {
    host: { name: label, file: join(dir, `${label}.plist`) },
    shell: { name: `${label}.shell`, file: join(dir, `${label}.shell.plist`) },
  };
}

function fileDirectory(text: string, manager: ServiceRecord['manager'], home: string): string | null {
  const set = manager === 'systemd-user'
    ? [...text.matchAll(/^WorkingDirectory=(.*)$/gm)].at(-1)?.[1]?.replace(/^-/, '').replace(/%%/g, '%')
    : /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]?.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');
  return set === undefined || set === '' ? null : realOrResolved(set === '~' ? home : set);
}

/** systemctl show (systemd 257) gives WorkingDirectory=-/x as !/x, ~ as ~, and an unset one under the user manager as
 *  ! and the home, its default. */
function runsFrom(shown: string, home: string): string | null {
  const set = shown.replace(/^[-!+@:]+/, '');
  if (set === '' || (shown.startsWith('!') && realOrResolved(set) === realOrResolved(home))) return null;
  return realOrResolved(set === '~' ? home : set);
}

type Owner = { kind: 'ok' } | { kind: 'other'; runsIn: string | null; from: string } | { kind: 'untold' }
  | { kind: 'unshown'; shown: string };

function ownerOf(unit: ServiceUnit, manager: ServiceRecord['manager'], work: string, sys: ServiceSystem,
  env: Record<string, string>): Owner {
  const here = realOrResolved(work);
  const text = readOr(unit.file);
  if (text !== null) {
    const runsIn = fileDirectory(text, manager, sys.home);
    if (runsIn !== here) return { kind: 'other', runsIn, from: unit.file };
  }
  if (manager !== 'systemd-user') {
    const loaded = text === null && sys.run('launchctl', ['list', unit.name], env).status === 0;
    return loaded ? { kind: 'untold' } : { kind: 'ok' };
  }
  const shown = showUnit(sys, env, unit.name, ['LoadState', 'ActiveState', 'WorkingDirectory', 'FragmentPath']);
  if (typeof shown === 'string') return { kind: 'unshown', shown };
  if (shown.get('LoadState') === 'not-found') {
    return STOPPING.has(shown.get('ActiveState') ?? '') ? { kind: 'untold' } : { kind: 'ok' };
  }
  const runsIn = runsFrom(shown.get('WorkingDirectory') ?? '', sys.home);
  return runsIn === here ? { kind: 'ok' } : { kind: 'other', runsIn, from: shown.get('FragmentPath') || unit.file };
}

function ownedOrFree(unit: ServiceUnit, manager: ServiceRecord['manager'], work: string, sys: ServiceSystem,
  env: Record<string, string>): void {
  const owner = ownerOf(unit, manager, work, sys, env);
  if (owner.kind === 'other') throw notOurs(unit.name, owner.from, owner.runsIn, work);
  if (owner.kind === 'unshown') {
    throw new Refusal(`${owner.shown}, so whether it runs another install can't be told. Nothing was written.`);
  }
  if (owner.kind === 'untold') {
    throw new Refusal(`${untold(sys, manager, unit)}, and nothing was written. If it's this install's, stop it ` +
      `(${stopLine(sys, manager, unit.name)}), then run connectome service install again.`);
  }
}

function untold(sys: ServiceSystem, manager: ServiceRecord['manager'], unit: ServiceUnit): string {
  return `${unit.name} is still ${manager === 'systemd-user' ? 'running' : 'loaded'}, but its file, ${unit.file}, is ` +
    'gone, so which install it runs can\'t be told';
}

function stopLine(sys: ServiceSystem, manager: ServiceRecord['manager'], name: string): string {
  return manager === 'systemd-user' ? systemctlLine(sys, `stop ${name}`) : `launchctl bootout gui/${sys.uid}/${name}`;
}

function runsWhat(runsIn: string | null): string {
  return runsIn === null ? 'something with no working directory set' : `the install in ${runsIn}`;
}

function notOurs(name: string, file: string, runsIn: string | null, work: string): Refusal {
  return new Refusal(`${name} already exists (${file}) and runs ${runsWhat(runsIn)}, not the one in ${work}. Its name ` +
    'comes from this directory\'s name, so nothing was written: remove that unit if nothing uses it, or set this ' +
    'resident up again in a directory with another name.');
}

function noOtherHost(ctx: CliContext, work: string, names: { host: ServiceUnit; shell: ServiceUnit }, sys: ServiceSystem,
  env: Record<string, string>): void {
  const run = (args: string[]) => {
    const ran = sys.run('systemctl', args, env);
    return { exitCode: ran.status, stdout: Buffer.from(ran.stdout) };
  };
  const listed = systemdUnits(work, run as never, sys.home);
  for (const scope of listed.unasked) {
    ctx.out(`systemd's ${scope} manager couldn't be asked which of its units run from ${work}, so one that runs a ` +
      'host there isn\'t ruled out.');
  }
  for (const { id, scope } of listed.unresolved) {
    const line = (args: string) => (scope === 'user' ? systemctlLine(sys, args) : `systemctl ${args}`);
    ctx.out(`The working directory of ${id}, a ${scope} unit, couldn't be resolved, so whether it runs a host from ` +
      `${work} isn't known, and it isn't taken as this install's. If it does run one there, two hosts on one install ` +
      `would both serve its data: ${scope === 'system' ? 'as root, ' : ''}stop it with ` +
      `${line(`stop ${shellWord(id)}`)}, and, if it has a unit file, disable it with ${line(`disable ${shellWord(id)}`)}.`);
  }
  const others = listed.found.filter((unit) => unit.scope === 'system' ||
    (unit.id !== names.host.name && unit.id !== names.shell.name));
  if (others.length > 0) {
    const steps = (['user', 'system'] as const).flatMap((scope) => {
      const these = others.filter((unit) => unit.scope === scope);
      if (these.length === 0) return [];
      const ids = (units: typeof these) => units.map((unit) => shellWord(unit.id)).join(' ');
      const line = (args: string) => (scope === 'user' ? systemctlLine(sys, args) : `systemctl ${args}`);
      const filed = these.filter((unit) => unit.file !== '');
      return [`${scope === 'system' ? 'as root, ' : ''}${line(`stop ${ids(these)}`)}, ` +
        `${filed.length > 0 ? `${line(`disable ${ids(filed)}`)}, remove ${filed.map((unit) => shellWord(unit.file))
          .join(' and ')}, ` : ''}then ${line('daemon-reload')}`];
    });
    const statuses = (['user', 'system'] as const).flatMap((scope) => {
      const ids = others.filter((unit) => unit.scope === scope).map((unit) => shellWord(unit.id)).join(' ');
      return ids === '' ? [] : [scope === 'user' ? systemctlLine(sys, `status ${ids}`) : `systemctl status ${ids}`];
    });
    const them = others.length === 1 ? 'it' : 'them';
    throw new Refusal(`${others.map((unit) => `${unit.id} (a ${unit.scope} unit, ${unit.file === '' ? 'with no unit file'
      : `at ${unit.file}`})`).join(' and ')} ${others.length === 1 ? 'is' : 'are'} already set up to run from ${work}, ` +
      `and two hosts on one install would both serve its data. ${statuses.join(' and ')} shows ` +
      `${others.length === 1 ? 'its state, and its process if it\'s running' : 'their states, and their processes if ' +
        'they\'re running'}. If that shows nothing uses ${them}, take ${them} away: ` +
      `${steps.join('; and ')}. Then run connectome service install again. Nothing was written.`);
  }
}

function removeUnit(ctx: CliContext, sys: ServiceSystem, env: Record<string, string>, manager: ServiceRecord['manager'],
  unit: ServiceUnit, work: string): void {
  const here = realOrResolved(work);
  const text = readOr(unit.file);
  let runsIn = text === null ? undefined : fileDirectory(text, manager, sys.home);
  let live: boolean;
  if (manager === 'systemd-user') {
    const shown = showUnit(sys, env, unit.name, ['LoadState', 'ActiveState', 'WorkingDirectory']);
    if (typeof shown === 'string') throw new Refusal(`${shown}, so whether it runs another install can't be told.`);
    if ((runsIn === undefined || runsIn === here) && shown.get('LoadState') === 'loaded') {
      runsIn = runsFrom(shown.get('WorkingDirectory') ?? '', sys.home);
    }
    live = RUNNING.has(shown.get('ActiveState') ?? '');
  } else {
    live = sys.run('launchctl', ['list', unit.name], env).status === 0;
  }
  if (runsIn === undefined) {
    if (live) {
      ctx.out(`${untold(sys, manager, unit)}, so it was left as it is. If it's this install's: ` +
        `${stopLine(sys, manager, unit.name)}.`);
    }
    return;
  }
  if (runsIn !== here || (text === null && !live)) return;
  if (manager === 'systemd-user') {
    systemctl(sys, env, text === null ? ['stop', unit.name] : ['disable', '--now', unit.name]);
  } else if (live) {
    bootout(sys, env, unit);
  }
  if (text !== null) rmSync(unit.file);
  ctx.out(text === null
    ? `Stopped ${unit.name}, which this install's service no longer has. Its unit file was already gone.`
    : `Stopped and removed ${unit.name}, which this install's service no longer has.`);
}

function bootout(sys: ServiceSystem, env: Record<string, string>, unit: ServiceUnit): void {
  const ran = sys.run('launchctl', ['bootout', `gui/${sys.uid}/${unit.name}`], env);
  if (ran.status !== 0) {
    throw new Refusal(`launchctl bootout gui/${sys.uid}/${unit.name} failed: ${stderrOf(ran)}. ` +
      `${unit.name} is still loaded as it was.`);
  }
}

function shellOf(work: string, sys: ServiceSystem): string | null {
  const pkg = join(work, 'node_modules', SHELL_PACKAGE);
  const file = join(pkg, 'package.json');
  try {
    lstatSync(pkg);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Refusal(`whether ${SHELL_PACKAGE} is installed in ${work}, for the resident's shell, can't be told: ` +
      `${errorText(error)}. Nothing was written.`);
  }
  let bin: unknown;
  try {
    bin = (JSON.parse(readFileSync(file, 'utf-8')) as { bin?: Record<string, unknown> } | null)?.bin?.[SHELL_BIN];
  } catch (error) {
    throw new Refusal(`${SHELL_PACKAGE} is installed in ${work}, for the resident's shell, but ${file} can't be read: ` +
      `${errorText(error)}. Nothing was written.`);
  }
  if (typeof bin !== 'string') {
    throw new Refusal(`${SHELL_PACKAGE} is installed in ${work}, for the resident's shell, but its package.json names no ` +
      `${SHELL_BIN} for its daemon. Nothing was written.`);
  }
  if (sys.which('node') === null) {
    throw new Refusal(`${SHELL_PACKAGE} is installed in ${work}, for the resident's shell, and its daemon runs on Node, ` +
      'but no node is on this PATH. Nothing was written.');
  }
  return resolve(pkg, bin);
}

async function shellPlan(sys: ServiceSystem, work: string, bin: string): Promise<ShellPlan> {
  const file = join(work, '.env');
  const known = readEnvFile(file);
  let port = known.get('SESSION_SERVER_PORT');
  const newPort = !port;
  for (let candidate = SHELL_PORTS.first; candidate <= SHELL_PORTS.last && !port; candidate++) {
    if (await sys.portFree(candidate)) port = String(candidate);
  }
  if (!port) {
    throw new Refusal(`no port from ${SHELL_PORTS.first} to ${SHELL_PORTS.last} is free for the resident's shell ` +
      `daemon: set SESSION_SERVER_PORT in ${file} and run this again. Nothing was written.`);
  }
  const token = known.get('SESSION_SERVER_TOKEN');
  return token
    ? { bin, port, token, newPort, newToken: false }
    : { bin, port, token: randomBytes(32).toString('hex'), newPort, newToken: true };
}

function keepShellSettings(ctx: CliContext, sys: ServiceSystem, work: string, shell: ShellPlan): void {
  const file = join(work, '.env');
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  try {
    new StoredSecrets(join(work, '.setup')).record('SESSION_SERVER_TOKEN');
  } catch (error) {
    throw new Refusal('the shell daemon\'s token can\'t be kept out of setup\'s answers, since the names of the stored ' +
      `secrets can't be recorded: ${errorText(error).replace(/\.+$/, '')}. No unit was written.`);
  }
  if ((mode & 0o077) !== 0) {
    try {
      chmodSync(file, 0o600);
    } catch (error) {
      throw new Refusal(`${file} ${shell.newToken ? 'is to hold' : 'holds'} the shell daemon's token and is open to ` +
        `others than ${sys.user} (mode ${mode.toString(8)}), and it can't be made readable by ${sys.user} alone: ` +
        `${errorText(error)}. No unit was written.`);
    }
    ctx.out(`${file} ${shell.newToken ? 'is to hold' : 'holds'} the shell daemon's token and was open to others than ` +
      `${sys.user} (mode ${mode.toString(8)}), so it's now readable by ${sys.user} alone.`);
  }
  const keep = (name: string, value: string) => {
    try {
      writeEnvValue(file, name, value);
    } catch (error) {
      throw new Refusal(`${name} can't be written to ${file}: ${errorText(error)}. No unit was written.`);
    }
  };
  if (shell.newPort) {
    keep('SESSION_SERVER_PORT', shell.port);
    ctx.out(`Port ${shell.port} was free when picked, so it's the resident's shell daemon's port, on localhost only: ` +
      `written to ${file} as SESSION_SERVER_PORT.`);
  }
  if (shell.newToken) {
    keep('SESSION_SERVER_TOKEN', shell.token);
    ctx.out(`Made a token for the resident's shell daemon: written to ${file} as SESSION_SERVER_TOKEN, not shown.`);
  }
}

function childEnv(sys: ServiceSystem): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sys.env)) if (value !== undefined) env[key] = value;
  if (sys.platform === 'linux' && !env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${sys.uid}`;
  return env;
}

function stderrOf(ran: Ran): string {
  return (ran.stderr.trim() || `exit ${ran.status}`).replace(/\.$/, '');
}

function systemctlLine(sys: ServiceSystem, args: string): string {
  return `${sys.env.XDG_RUNTIME_DIR ? '' : `XDG_RUNTIME_DIR=/run/user/${sys.uid} `}systemctl --user ${args}`;
}

function systemctl(sys: ServiceSystem, env: Record<string, string>, args: string[]): void {
  const ran = sys.run('systemctl', ['--user', ...args], env);
  if (ran.status !== 0) {
    throw new Refusal(`systemctl --user ${args.join(' ')} failed: ${stderrOf(ran)}. Run ` +
      'connectome service install again once that\'s put right.');
  }
}

function plain(value: string, what: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Refusal(`${what} holds a line break or another control character, so it can't go in a unit. Nothing was ` +
      'written.');
  }
  return value;
}

function word(value: string): string {
  return `"${plain(value, `The command's word ${JSON.stringify(value)}`).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

function assignment(name: string, value: string): string {
  return `Environment="${`${name}=${plain(value, name)}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function systemdUnit(description: string, work: string, argv: string[], env: Array<[string, string]>,
  wants: string | null): string {
  const named = `The working directory ${JSON.stringify(work)}`;
  const unit = [`Description=${plain(description, named).replace(/%/g, '%%')}`,
    ...(wants === null ? [] : [`Wants=${wants}`, `After=${wants}`])];
  const service = [`WorkingDirectory=${plain(work, named).replace(/%/g, '%%')}`, `ExecStart=${argv.map(word).join(' ')}`,
    ...env.map(([name, value]) => assignment(name, value)), 'Restart=on-failure'];
  return `[Unit]\n${unit.join('\n')}\n\n[Service]\n${service.join('\n')}\n\n[Install]\nWantedBy=default.target\n`;
}

function xml(value: string, what: string): string {
  return plain(value, what).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function plist(label: string, work: string, args: string[], env: Array<[string, string]>, logPath: string): string {
  const as = (value: string) => xml(value, JSON.stringify(value));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${as(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((arg) => `    <string>${as(arg)}</string>`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${as(work)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env.flatMap(([name, value]) => [`    <key>${as(name)}</key>`, `    <string>${xml(value, name)}</string>`]),
    '  </dict>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${as(logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${as(logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function pidOf(listed: string): string | undefined {
  return /"PID"\s*=\s*(\d+);/.exec(listed)?.[1];
}

async function awaitReady(root: string, record: ServiceRecord, sys: ServiceSystem,
  env: Record<string, string>): Promise<HostReady | string> {
  const until = sys.now() + READY_WAIT_MS;
  const name = record.units.host.name;
  let first: string | undefined;
  let last = 'nothing answered';
  for (;;) {
    let host: HostClient | NoHost;
    try {
      host = await sys.openHost(root);
    } catch (error) {
      return `its host can't be reached: ${errorText(error)}`;
    }
    if (!('reason' in host)) {
      const ready = host.ready;
      host.close();
      return ready;
    }
    last = host.reason;
    if (record.manager === 'systemd-user') {
      const shown = showUnit(sys, env, name, ['ActiveState', 'SubState', 'InvocationID']);
      if (typeof shown === 'string') return `${shown}, and no host answers: ${last}.`;
      const state = shown.get('ActiveState') ?? '';
      const invocation = shown.get('InvocationID') ?? '';
      first ??= invocation;
      if (!RUNNING.has(state)) {
        return `${name} is ${state === '' ? `not running (${shown.get('SubState') || '?'})` : stateOf(shown)}, and no host ` +
          `answers: ${last}.`;
      }
      if (invocation !== first) return `systemd restarted ${name} before its host answered: ${last}.`;
    }
    if (sys.now() >= until) return `no host said it was ready within ${READY_WAIT_MS / 1000} s: ${last}.`;
    await sys.sleep(1_000);
  }
}

export function readServiceRecord(root: string): ServiceRecord | null {
  const path = join(root, 'service.json');
  const record = readRecord<ServiceRecord>(path, 'service record');
  if (record === null) return null;
  const unit = (value: unknown) => typeof value === 'object' && value !== null &&
    typeof (value as ServiceUnit).name === 'string' && typeof (value as ServiceUnit).file === 'string';
  const logs = record.logs as { kind?: unknown; path?: unknown } | undefined;
  const fits = (record.manager === 'systemd-user' || record.manager === 'launchd') &&
    unit(record.units?.host) && (record.units.shell === undefined || unit(record.units.shell)) &&
    Array.isArray(record.hostArgs) && record.hostArgs.length > 0 && record.hostArgs.every((arg) => typeof arg === 'string') &&
    typeof record.workingDirectory === 'string' &&
    (logs?.kind === 'journal' || (logs?.kind === 'file' && typeof logs.path === 'string'));
  if (!fits) throw new ContractError(`The service record at ${path} doesn't hold a service record's fields.`);
  return record;
}

export function serviceLines(root: string): string[] | null {
  const record = readServiceRecord(root);
  if (record === null) return null;
  const host = record.units.host;
  const log = record.logs.kind === 'file' ? record.logs.path : join(record.workingDirectory, 'logs', 'agent.log');
  const systemd = record.manager === 'systemd-user';
  return [
    systemd ? `Its service is ${host.name}:` : `Its service is the launch agent ${host.name}:`,
    `  follow its log: ${systemd ? `journalctl --user -u ${host.name} -f` : `tail -f ${shellWord(log)}`}`,
    `  stop it${record.units.shell === undefined ? '' : ' and its shell daemon'}: connectome service stop`,
    '  start it: connectome service start',
  ];
}

export async function checkService(root: string, sys: ServiceSystem = machine()):
  Promise<{ passed: boolean; lines: string[] }> {
  const lines: string[] = [];
  let passed = true;
  const fail = (line: string) => {
    passed = false;
    lines.push(line);
  };
  let record: ServiceRecord | null;
  try {
    record = readServiceRecord(root);
  } catch (error) {
    return { passed: false, lines: [errorText(error)] };
  }
  if (record === null) {
    return { passed: false, lines: [`No service is recorded for this install (${join(root, 'service.json')}).`] };
  }
  const env = childEnv(sys);
  const workingDirectory = record.workingDirectory;
  let marked = false;
  const log = (text: string, what: string, ended = false) => {
    let redact: (text: string) => { text: string };
    try {
      redact = storedSecretRedactor(workingDirectory, sys.env);
    } catch (error) {
      fail(`${what} isn't shown, since the install's secrets can't all be kept out of it: ${errorText(error)}`);
      return;
    }
    if (logLines(text, what, redact, lines, ended) > 0) marked = true;
  };
  if (record.manager === 'systemd-user') {
    for (const unit of [record.units.host, ...(record.units.shell ? [record.units.shell] : [])]) {
      const shown = showUnit(sys, env, unit.name, ['LoadState', 'ActiveState', 'SubState', 'NRestarts',
        'ExecMainStartTimestamp', 'ExecMainStatus', 'Environment', 'WorkingDirectory', 'InvocationID', RESTART_PROPERTIES]);
      if (typeof shown === 'string') {
        fail(`${shown}.`);
        continue;
      }
      if (shown.get('LoadState') !== 'loaded') {
        fail(RUNNING.has(shown.get('ActiveState') ?? '')
          ? `${unit.name} is running, but systemd can't load its unit (${shown.get('LoadState') ?? 'no load state'}), so ` +
            `which install it runs can't be told. If it's this install's, stop it ` +
            `(${stopLine(sys, record.manager, unit.name)}), then run connectome service install again.`
          : `systemd has no ${unit.name} loaded (${shown.get('LoadState') ?? 'no load state'}): its unit file may be ` +
            'gone. Run connectome service install again.');
        continue;
      }
      const state = stateOf(shown);
      const active = shown.get('ActiveState') === 'active';
      const restarts = Number(shown.get('NRestarts') ?? '0');
      const restarted = `systemd has restarted it ${restarts} time${restarts === 1 ? '' : 's'} since it was last started`;
      if (active && restarts > 0) {
        lines.push(`${unit.name} is ${state} again: ${restarted}.`);
      } else {
        if (active) lines.push(`${unit.name} is ${state}.`);
        else if (unit === record.units.host) fail(`${unit.name} is ${state}, not active.`);
        else fail(`${unit.name} is ${state}, not active: journalctl --user -u ${unit.name} shows its log.`);
        const exited = active || (shown.get('ExecMainStartTimestamp') ?? '') === '' ? ''
          : `, and its process last exited with ${shown.get('ExecMainStatus') ?? '?'}`;
        lines.push(restarts > 0 ? `${restarted}${exited}.` : `systemd hasn't restarted it since it was last started${exited}.`);
      }
      if (unit !== record.units.host) continue;
      const policy = restartPolicy(shown);
      if (runsFrom(shown.get('WorkingDirectory') ?? '', sys.home) !== realOrResolved(record.workingDirectory)) {
        fail(`systemd runs ${unit.name} in ${shown.get('WorkingDirectory') || 'no set directory'}, not ${record.workingDirectory}.`);
      } else if (policy.restarts) {
        lines.push(`It restarts the host when it exits with ${RESTART_EXIT_CODE} and with 1 (${policy.settings}).`);
      } else {
        fail(`It doesn't restart the host both when it exits with ${RESTART_EXIT_CODE} and with 1 (${policy.settings}).`);
      }
      if (new RegExp(`(^|\\s)${SUPERVISED_ENV}=1(\\s|$)`).test(shown.get('Environment') ?? '')) {
        lines.push(`Its unit sets ${SUPERVISED_ENV}=1.`);
      } else {
        fail(`Its unit doesn't set ${SUPERVISED_ENV}=1, which connectome service install sets once systemd shows it ` +
          `restarts the host on ${RESTART_EXIT_CODE} and 1: run connectome service install again.`);
      }
      const invocation = shown.get('InvocationID') ?? '';
      const started = /^@(\d+)$/.exec(shown.get('ExecMainStartTimestamp') ?? '')?.[1];
      if (invocation === '' || started === undefined) {
        lines.push('Its latest start isn\'t known, so its log isn\'t shown.');
        continue;
      }
      const logged = sys.run('journalctl', ['--user', `_SYSTEMD_INVOCATION_ID=${invocation}`, '--since', `@${started}`,
        ...(active ? ['--until', `@${Number(started) + FIRST_MINUTE_S}`] : []), '-o', 'cat', '--no-pager'], env);
      if (logged.status !== 0) {
        fail(`Its log couldn't be read: journalctl --user failed: ${stderrOf(logged)}.`);
        continue;
      }
      if (active) log(logged.stdout, 'The journal\'s lines from the host in the first minute of its latest start');
      else log(logged.stdout, 'The journal\'s last lines from the host\'s latest start, which ended', true);
      if (restarts > 0 && active) {
        endedStart(sys, env, unit.name, invocation, started, lines, log);
      }
    }
  } else {
    for (const unit of [record.units.host, ...(record.units.shell ? [record.units.shell] : [])]) {
      const listed = sys.run('launchctl', ['list', unit.name], env);
      if (listed.status !== 0) {
        fail(`launchd has no ${unit.name} loaded.`);
        continue;
      }
      const pid = pidOf(listed.stdout);
      const exit = /"LastExitStatus"\s*=\s*(-?\d+);/.exec(listed.stdout)?.[1];
      if (pid !== undefined) lines.push(`${unit.name} is running, pid ${pid}.`);
      else {
        fail(`${unit.name} is loaded but not running${exit === undefined ? '' : `; it last exited with ${exit}`}` +
          `${unit === record.units.host ? '' : `. Its log is ${join(record.workingDirectory, 'logs', 'shell.log')}`}.`);
      }
    }
    if (record.logs.kind === 'file') {
      const text = readOr(record.logs.path);
      if (text === null) lines.push(`Its log ${record.logs.path} isn't there yet.`);
      else log(text, 'The last lines of its log since it was loaded, which can hold more than one start of the host', true);
    }
  }
  if (passed && marked) {
    lines.push('If a marked line is a problem, put it right, then run connectome service install again, which restarts ' +
      'the host.');
  }
  return { passed, lines };
}

function stateOf(shown: Map<string, string>): string {
  const [active, sub] = [shown.get('ActiveState') || '?', shown.get('SubState') || '?'];
  return sub === active ? active : `${active} (${sub})`;
}

function showUnit(sys: ServiceSystem, env: Record<string, string>, name: string,
  properties: string[]): Map<string, string> | string {
  const ran = sys.run('systemctl', ['--user', 'show', '--timestamp=unix', `--property=${properties.join(',')}`, '--', name],
    env);
  if (ran.status !== 0) {
    return `systemd couldn't be asked about ${name}: ${stderrOf(ran)} ` +
      `(${systemctlLine(sys, `show ${name}`)})`;
  }
  return new Map(ran.stdout.split('\n').filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

function endedStart(sys: ServiceSystem, env: Record<string, string>, name: string, invocation: string, started: string,
  lines: string[], log: (text: string, what: string, ended: boolean) => void): void {
  const ran = sys.run('journalctl', ['--user', '-u', name, '--until', `@${Number(started) + 1}`, '-n', String(ENDED_ENTRIES),
    '-o', 'json', `--output-fields=MESSAGE,${INVOCATION_FIELDS.join(',')}`, '--no-pager'], env);
  if (ran.status !== 0) {
    lines.push(`Its start before the latest isn't shown: journalctl --user failed: ${stderrOf(ran)}.`);
    return;
  }
  const entries = ran.stdout.split('\n').flatMap((line) => {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    const id = INVOCATION_FIELDS.map((field) => entry[field]).find((value) => typeof value === 'string');
    return typeof id === 'string' && typeof entry.MESSAGE === 'string' ? [{ id, message: entry.MESSAGE }] : [];
  });
  const latest = entries.findIndex((entry) => entry.id === invocation);
  const read = `Its last ${ENDED_ENTRIES} journal entries, up to a second past its latest start,`;
  if (latest === -1) {
    lines.push(`${read} hold none of that start's, so which start ended before it can't be told.`);
    return;
  }
  const earlier = entries.slice(0, latest);
  const ended = earlier.at(-1)?.id;
  if (ended === undefined) {
    lines.push(`${read} hold no earlier start of it.`);
    return;
  }
  log(earlier.filter((entry) => entry.id === ended).map((entry) => entry.message).join('\n'),
    'The journal\'s last lines about the newest earlier start it holds, which ended', true);
}

function logLines(text: string, what: string, redact: (text: string) => { text: string }, lines: string[],
  ended = false): number {
  const logged = redact(text).text.split('\n').filter((line) => line.trim() !== '');
  if (logged.length === 0) {
    lines.push(`${what}: nothing.`);
    return 0;
  }
  if (ended) {
    const hidden = Math.max(0, logged.length - LOG_LINES);
    lines.push(`${what}:`);
    if (hidden > 0) lines.push(`  ${hidden} earlier line${hidden === 1 ? '' : 's'} not shown.`);
    for (const line of logged.slice(hidden)) lines.push(`  | ${line}`);
    return 0;
  }
  const errors = logged.filter((line) => LOOKS_LIKE_ERROR.test(line)).length;
  lines.push(errors > 0
    ? `${what}, with ${errors} line${errors === 1 ? ' that reads' : 's that read'} as an error (marked !):` : `${what}:`);
  const shown = logged.map((line, at) => at < LOG_LINES || LOOKS_LIKE_ERROR.test(line));
  logged.forEach((line, at) => {
    if (shown[at]) lines.push(`  ${LOOKS_LIKE_ERROR.test(line) ? '!' : '|'} ${line}`);
  });
  const hidden = shown.filter((each) => !each).length;
  if (hidden > 0) lines.push(`  ${hidden} more line${hidden === 1 ? '' : 's'} not shown.`);
  return errors;
}

function readOr(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeTextAtomic(path, text, 0o600);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
