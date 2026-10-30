import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressionModelOf } from '../framework-strategy.js';
import { composeMcplChildEnv, openedBy, serversForRecipe } from '../mcpl-config.js';
import { ENV_REFERENCE, loadRecipeDetailed, recipeModel, runningFit, unknownRecipeKeys, type Recipe } from '../recipe.js';
import {
  PROVIDER_SECRETS, StoredSecrets, readEnvFile, redactWindow, secretValues, storedSecrets, type Secret,
} from '../setup/secrets.js';
import { agentOverlayPath } from '../update/agent-overlay-path.js';
import { INSTALL_ROOT_ENV } from '../update/contract.js';
import type { CliContext } from './connectome.js';
import { checkDiscord, mappingRemedy } from './discord-check.js';
import { dataDirOf, openHost, type HostClient, type NoHost } from './host-socket.js';
import { SUPERVISED_ENV, checkService, readServiceRecord, serviceLines, type ServiceRecord } from './service.js';

const LADDER = fileURLToPath(new URL('../../scripts/connectome-doctor', import.meta.url));
const LADDER_LIMIT_MS = 60_000;
const HOST_ANSWER_LIMIT_MS = 60_000;
const SYSTEM_VARIABLES = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'TMPDIR', 'XDG_RUNTIME_DIR'];
/** agent-framework 0.30.0's CHILD_ENV_ALLOWLIST (dist/src/mcpl/transport.js), which the package doesn't export: the
 *  host variables a stdio server gets without inheritEnv, besides LC_*. */
const CHILD_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'DISPLAY', 'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy',
  'https_proxy', 'no_proxy', '__CF_USER_TEXT_ENCODING', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA',
  'LOCALAPPDATA', 'USERPROFILE', 'USERNAME',
];
const CHECKS = { 'count-check': 'the token counts', 'shell-check': 'the shell\'s call' } as const;
const EMPTY_COMPRESSION = 'The recipe\'s agent.strategy.compressionModel is empty, so context-manager halts memory ' +
  'formation: it refuses an empty model. Leave it out to compress with the agent\'s model, or name one, and restart the ' +
  'service.';

export interface DoctorParts {
  fetch: typeof fetch;
  checkService: typeof checkService;
  python: string | null;
  hostLimitMs: number;
  ladderLimitMs: number;
}

type Server = {
  id: string; command?: unknown; args?: unknown; env?: unknown; inheritEnv?: unknown;
  transport?: unknown; url?: unknown; token?: unknown; access?: unknown;
};

class Report {
  problems = 0;

  constructor(
    private readonly print: (line: string) => void,
    readonly redact: (text: string) => string,
  ) {}

  section(title: string): void {
    this.print('');
    this.print(this.redact(title));
  }

  line(text: string): void {
    this.print(this.redact(`  ${text}`));
  }

  ok(text: string): void {
    this.line(`✓ ${text}`);
  }

  problem(text: string): void {
    this.problems += 1;
    this.line(`✗ ${text}`);
  }
}

export async function doctor(
  ctx: CliContext,
  parts: DoctorParts = {
    fetch,
    checkService,
    python: Bun.which('python3'),
    hostLimitMs: HOST_ANSWER_LIMIT_MS,
    ladderLimitMs: LADDER_LIMIT_MS,
  },
): Promise<number> {
  if (ctx.argv.length > 0) {
    ctx.err('connectome: usage: connectome doctor');
    return 2;
  }
  const root = ctx.root!;

  let service: ServiceRecord | null = null;
  let serviceError: string | null = null;
  try {
    service = readServiceRecord(root);
  } catch (error) {
    serviceError = errorText(error);
  }
  const work = service?.workingDirectory ?? join(root, '..');
  const banner = `connectome doctor: the install at ${root}`;
  let secrets: Secret[] = [...PROVIDER_SECRETS, 'DISCORD_TOKEN']
    .flatMap((name) => process.env[name] ? [{ name, value: process.env[name]! }] : []);
  const redact = (text: string): string => {
    const bytes = Buffer.from(text, 'utf-8');
    return redactWindow(bytes, 0, bytes.length, secrets, new Set()).text;
  };
  let env: Record<string, string | undefined>;
  try {
    const known = (from: Record<string, string | undefined>): Secret[] =>
      [...storedSecrets(work, from), ...secretValues(['DISCORD_TOKEN'], join(work, '.env'), from)];
    secrets = [...secrets, ...known(process.env)];
    env = serviceEnv(work, root);
    secrets = [...secrets, ...known(env)]
      .filter((s, i, all) => all.findIndex((t) => t.name === s.name && t.value === s.value) === i);
  } catch (error) {
    ctx.out(redact(banner));
    ctx.out(redact(`  ✗ ${errorText(error)}`));
    ctx.out('Doctor stops here: it can\'t tell which values are secret, so it prints no check\'s output.');
    return 1;
  }
  const report = new Report(ctx.out, redact);
  ctx.out(report.redact(banner));

  let host: HostClient | NoHost = { reason: 'it wasn\'t asked', down: false };
  try {
    report.section('Service');
    if (serviceError !== null) {
      report.problem(`${serviceError} \`connectome service install <recipe>\` writes it again, and checks it.`);
    } else if (service === null) {
      report.problem(`No service is recorded for this install (${join(root, 'service.json')}): ` +
        '`connectome service install <recipe>` writes one and checks it.');
    } else {
      await checked(report, 'The service check', async () => {
        const result = await parts.checkService(root);
        for (const line of result.lines) report.line(line);
        if (!result.passed) report.problem('The service check above didn\'t pass.');
      });
    }

    report.section('Host');
    try {
      host = await openHost(root);
    } catch (error) {
      host = { reason: errorText(error), down: false };
    }
    if ('reason' in host) {
      report.problem(`No host answers: ${host.reason}.`);
      if (host.down && service !== null) {
        await checked(report, 'Reading the service record again', () => {
          for (const line of serviceLines(root) ?? []) report.line(line);
        });
      }
    } else {
      report.ok(`The host answers: pid ${host.ready.pid}, recipe ${host.ready.recipe}.`);
      host.subscribe([]);
    }
    const running = host;
    const ask = async <T>(op: keyof typeof CHECKS): Promise<{ data: T } | null> => {
      if ('reason' in running) return null;
      const answer = await running.request({ type: 'panel-request', op }, parts.hostLimitMs);
      if (answer === null) {
        report.problem(`The host didn't answer ${CHECKS[op]} within ${parts.hostLimitMs / 1000} s, or its connection ` +
          'closed first.');
        return null;
      }
      if (answer.ok !== true) {
        const error = String(answer.error ?? 'no reason given');
        report.problem(`The host refused ${CHECKS[op]}: ${error}.` + (!error.startsWith('unknown panel op') ? ''
          : ' The running host is an older release than this command, so it doesn\'t know this check: restarting the ' +
            'service starts it on this release.'));
        return null;
      }
      return { data: answer.data as T };
    };

    report.section('Recipe');
    let recipe: Recipe | null = null;
    let uses: Map<string, string[]> | null = null;
    if (service === null) {
      report.line('Which recipe the service runs is in its record, so it isn\'t checked without one.');
    } else {
      const path = service.hostArgs[0]!;
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
      try {
        const detailed = await loadRecipeDetailed(path, { env });
        recipe = detailed.recipe;
        uses = namedOutsideServers(detailed.persistable);
        report.ok(`${path} loads.`);
      } catch (error) {
        report.problem(`${path} doesn't load: ${errorText(error)}`);
      } finally {
        console.warn = warn;
      }
      for (const line of warned) report.line(line);
    }
    const loaded = recipe;
    let emptyCompressionSaid = false;
    if (loaded !== null) {
      await checked(report, 'The fit check', () => {
        const model = recipeModel(loaded, env.MODEL);
        const fit = runningFit(loaded, env.MODEL);
        if (!fit.checked) report.line(fit.line);
        else if (fit.fits) report.ok(`It fits ${model}'s window.`);
        else report.problem(fit.refusal);
      });
      if (compressionModelOf(loaded, recipeModel(loaded, env.MODEL)) === '') {
        report.problem(EMPTY_COMPRESSION);
        emptyCompressionSaid = true;
      }
    }

    report.section('Token counts');
    if ('reason' in host) report.line('count_tokens wasn\'t asked: that needs the host running.');
    else {
      await checked(report, 'The token counts', async () => {
        const answer = await ask<CountCheck>('count-check');
        if (answer !== null) countLines(report, answer.data, work, emptyCompressionSaid);
      });
    }

    report.section('Servers');
    if ('reason' in host) report.line('The shell\'s real call wasn\'t made: that needs the host running.');
    else {
      await checked(report, 'The shell\'s call', async () => {
        const answer = await ask<ShellCheck>('shell-check');
        if (answer !== null) shellLines(report, answer.data);
      });
    }
    let servers: Server[] | null = null;
    let unknown = serviceError !== null
      ? 'which servers run is in the recipe the service record names, and the service\'s record can\'t be read'
      : service === null ? 'which servers run is in the recipe the service record names, and there\'s no record'
        : 'which servers run is in the recipe, which didn\'t load';
    if (recipe !== null) {
      try {
        servers = serversForRecipe(recipe.mcpServers, join(work, 'mcpl-servers.json'), agentOverlayPath(work, env))
          .loaded as Server[];
      } catch (error) {
        report.problem(`The recipe's server list doesn't resolve: ${errorText(error)}`);
        unknown = 'the recipe\'s server list doesn\'t resolve';
      }
    }
    await checked(report, 'The stored secrets\' check', () => storedSecretLines(report, work, env, servers, uses, unknown));

    report.section('Discord');
    if (servers === null) report.line(`Discord isn't checked: ${unknown}.`);
    else {
      const discord = servers.filter((s) => [s.command, ...(Array.isArray(s.args) ? s.args : [])]
        .some((part) => typeof part === 'string' && part.includes('discord-mcpl')));
      if (discord.length === 0) report.line('No server the recipe runs is Discord\'s.');
      for (const server of discord) {
        try {
          const checked = await checkDiscord(childEnv(server, env), { fetch: parts.fetch, workingDir: work });
          for (const line of checked.lines) report.line(line);
          report.problems += checked.problems.length;
        } catch (error) {
          report.problem(`The Discord check of ${server.id} failed: ${errorText(error)}`);
        }
      }
    }
  } finally {
    if (!('reason' in host)) host.close();
  }

  let ladderFindings = false;
  if (serviceError !== null) {
    report.section('The ladder reads the service\'s unit, which its record names, so it doesn\'t run while the record ' +
      'can\'t be read.');
  } else if (service === null) {
    report.section('The ladder reads the service\'s unit and log, so it runs once a service is recorded.');
  } else if (service.manager !== 'systemd-user') {
    report.section('The ladder reads systemd\'s units and journal, so it doesn\'t run for this install, whose service ' +
      'runs under launchd.');
  } else if (parts.python === null) {
    report.section('The pipeline ladder needs python3, which isn\'t on PATH. The checks above don\'t.');
  } else {
    report.section('Where an incoming message got to (scripts/connectome-doctor):');
    let dataDir: string[] = [];
    try {
      dataDir = ['--data-dir', dataDirOf(root)];
    } catch (error) {
      report.problem(`The ladder reads ${join(work, 'data')}, since where the data directory is can't be told: ` +
        errorText(error));
    }
    const ran = spawnSync(parts.python, [LADDER, ...dataDir, work, service.units.host.name], {
      encoding: 'utf-8',
      timeout: parts.ladderLimitMs,
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`,
        CONNECTOME_DOCTOR_WITHHOLD: JSON.stringify(secrets.map((s) => [s.name, s.value])),
      },
    });
    for (const line of [ran.stdout ?? '', ran.stderr ?? ''].join('\n').split('\n')) if (line !== '') report.line(line);
    ladderFindings = ran.status === 1 && (ran.stdout ?? '').includes('=== findings ===');
    if (ran.error !== undefined) {
      const timedOut = (ran.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      report.problem(`The ladder didn't finish${timedOut ? ` within ${parts.ladderLimitMs / 1000} s` : `: ${ran.error.message}`}, ` +
        'so what it would have shown after the lines above isn\'t known.');
    } else if (ran.signal !== null) {
      report.problem(`The ladder was ended by ${ran.signal}, so what it would have shown after the lines above isn't known.`);
    } else if (ran.status !== 0 && !ladderFindings) {
      report.problem(`The ladder stopped (exit ${ran.status}) before it finished, so what it would have shown after ` +
        'the lines above isn\'t known.');
    }
  }

  ctx.out('');
  ctx.out(report.problems > 0
    ? `Doctor found ${report.problems} problem${report.problems === 1 ? '' : 's'}, marked ✗.`
    : ladderFindings
      ? 'Doctor\'s own checks found no problem; the findings above are the ladder\'s, which doctor doesn\'t count.'
      : 'Doctor found no problem.');
  return report.problems === 0 ? 0 : 1;
}

async function checked(report: Report, what: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body();
  } catch (error) {
    report.problem(`${what} failed: ${errorText(error)}`);
  }
}

interface CountCheck {
  agent: { model: string | null; countModel: string | null; source: string };
  compression: { model: string; countModel: string | null; source: string } | null;
}

interface ShellCheck {
  shells: Array<{ server: string; answered: true; sessions: number | null } | { server: string; answered: false; error: string }>;
  notConnected: Array<{ id: string; retrying: boolean; refused: string | null }>;
  closedTabs: string[];
}

const REPLACE_CREDENTIAL = ' Replace that credential where the service gets it, and restart the service.';

function countFailure(source: string): string {
  if (source === 'count_tokens_failed_401') {
    return 'count_tokens refused the credential the host sent (401): its subscription login when it has one, else ' +
      'ANTHROPIC_AUTH_TOKEN, else ANTHROPIC_API_KEY';
  }
  const status = /^count_tokens_failed_(\d+)$/.exec(source)?.[1];
  if (status !== undefined) return `count_tokens answered ${status}`;
  if (source === 'count_tokens_error') {
    return 'the count_tokens request failed, didn\'t answer within 30 s, or answered with what couldn\'t be read';
  }
  return source;
}

function countLines(report: Report, check: CountCheck, work: string, emptyCompressionSaid: boolean): void {
  const { agent, compression } = check;
  if (agent.source === 'count_tokens') report.ok(`count_tokens counts with ${agent.countModel}.`);
  else if (agent.source === 'count_tokens_unsupported_model') {
    report.line(`count_tokens isn't asked: ${agent.model === null ? 'the agent names no model'
      : `${agent.model} isn't a Claude model it counts`}.`);
  } else {
    report.problem(`count_tokens couldn't count with ${agent.countModel}: ${countFailure(agent.source)}. So the ` +
      'context\'s makeup shows no exact total.' + (agent.source === 'count_tokens_failed_401' ? REPLACE_CREDENTIAL : '') +
      (agent.source !== 'count_tokens_failed_404' ? '' : ' A retired ' +
      'model answers 404, and the endpoint count_tokens asks (Anthropic\'s API, or the one ANTHROPIC_BASE_URL names) ' +
      'may answer it for a model it doesn\'t serve: set COUNT_TOKENS_MODEL in ' +
      `${join(work, '.env')} to a current Claude model, and restart the service, since the host reads it when it starts.`));
  }
  if (compression === null) {
    report.line('No compression model is checked: the agent\'s strategy is passthrough, or an extension\'s that chooses its own.');
  } else if (compression.model === '') {
    if (!emptyCompressionSaid) report.problem(EMPTY_COMPRESSION);
  } else if (compression.source === 'count_tokens') report.ok(`count_tokens knows the compression model, ${compression.model}.`);
  else if (compression.source === 'count_tokens_unsupported_model') {
    report.line(`The compression model, ${compression.model}, isn't a Claude model count_tokens counts, so it isn't checked.`);
  } else {
    report.problem(`count_tokens couldn't count with the compression model, ${compression.model}: ` +
      `${countFailure(compression.source)}.` + (compression.source === 'count_tokens_failed_401' ? REPLACE_CREDENTIAL : '') +
      (compression.source !== 'count_tokens_failed_404' ? '' : ' A retired ' +
      'model answers 404, and with a retired compression model folding stalls and the context can\'t compress under ' +
      'the window: change the recipe\'s agent.strategy.compressionModel to a current model' +
      (agent.source !== 'count_tokens' || agent.countModel !== agent.model || compression.model === agent.model ? ''
        : ', or leave it out to compress with the agent\'s model,') +
      ' and restart the service. The endpoint count_tokens asks (Anthropic\'s API, or the one ANTHROPIC_BASE_URL names) ' +
      'may answer 404 for a model it doesn\'t serve too, and then the 404 doesn\'t mean it\'s retired.'));
  }
}

function shellLines(report: Report, shell: ShellCheck): void {
  for (const server of shell.notConnected) {
    report.problem(`The server ${server.id} isn't connected` + (server.refused !== null
      ? `: the host refuses its configuration: ${server.refused}.`
      : server.retrying
        ? '; the host is still retrying it.'
        : `, and the host isn't retrying it. Its stderr is in the data directory, in sessions/<session>/mcpl-stderr/${server.id}.log.`));
  }
  for (const id of shell.closedTabs) {
    report.line(`The server ${id} is a closed tab: the host connects it when an agent opens it, so its connection isn't checked.`);
  }
  if (shell.shells.length === 0) {
    const unchecked = [
      ...(shell.notConnected.length > 0 ? ['a server that isn\'t connected'] : []),
      ...(shell.closedTabs.length > 0 ? ['a closed tab'] : []),
    ];
    report.line(unchecked.length === 0
      ? 'No server offers listSessions, so there\'s no shell to call.'
      : `No connected server offers listSessions, so there's no shell to call; ${unchecked.join(' or ')} may be the shell.`);
  }
  for (const row of shell.shells) {
    if (row.answered) {
      report.ok(`${row.server} reached its daemon` + (row.sessions === null ? '.' : `: ${row.sessions} session${row.sessions === 1 ? '' : 's'}.`));
    } else if (row.error.includes('Connection lost') || row.error.includes('Connection timeout')) {
      report.problem(`${row.server} didn't reach its daemon: ${row.error}. On terminal-sessions 1.7.3, "Connection lost" ` +
        'is what a missing or wrong SESSION_SERVER_TOKEN in the server\'s env gives, and "Connection timeout" a daemon ' +
        'that isn\'t running.');
    } else {
      report.problem(`${row.server}'s listSessions call failed: ${row.error}.`);
    }
  }
}

function storedSecretLines(
  report: Report,
  work: string,
  env: Record<string, string | undefined>,
  servers: Server[] | null,
  uses: Map<string, string[]> | null,
  unknown: string,
): void {
  const inEnvFile = readEnvFile(join(work, '.env'));
  const provider: readonly string[] = PROVIDER_SECRETS;
  const mapped: string[] = [];
  for (const name of new StoredSecrets(join(work, '.setup')).names()) {
    if (!inEnvFile.has(name)) {
      report.problem(`${name} was stored by setup and isn't in ${join(work, '.env')} any more: put it back there and ` +
        'restart the service.');
    } else if (!env[name]) {
      report.problem(`${name} was stored by setup and is empty in the service's environment: give it its value in ` +
        `${join(work, '.env')} and restart the service.`);
    } else if (!provider.includes(name)) {
      mapped.push(name);
    }
  }
  const unchecked: string[] = [];
  for (const name of mapped) {
    const at = uses?.get(name) ?? [];
    if (at.length > 0) report.ok(`${name} is named in the recipe, at ${at.join(', ')}.`);
    if (servers === null) {
      if (at.length === 0) unchecked.push(name);
      continue;
    }
    const value = env[name];
    const reached = !value ? [] : servers.filter((s) => reaches(s, value, env));
    if (reached.length > 0) {
      report.ok(`${name} reaches ${reached.map((s) => s.id).join(', ')}.`);
    } else if (at.length === 0) {
      report.problem(`${name} is stored in ${join(work, '.env')}, and no server gets it: no server the host starts is ` +
        `given it in its env or args, no server it dials names it in its token or url, and the recipe names it nowhere ` +
        `outside its servers. ` + mappingRemedy(name, name === 'DISCORD_TOKEN'));
    }
  }
  if (unchecked.length > 0) report.line(`Which servers see ${unchecked.join(', ')} isn't checked: ${unknown}.`);
}

function namedOutsideServers(raw: Record<string, unknown>): Map<string, string[]> {
  const uses = new Map<string, string[]>();
  const ignored = new Set(unknownRecipeKeys(raw).map((key) => key.split(' (')[0]));
  const walk = (value: unknown, at: string): void => {
    if (ignored.has(at)) return;
    if (typeof value === 'string') {
      for (const [, name] of value.matchAll(new RegExp(ENV_REFERENCE, 'g'))) {
        const list = uses.get(name!) ?? [];
        if (!list.includes(at)) list.push(at);
        uses.set(name!, list);
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${at}[${i}]`));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, `${at}.${key}`);
    }
  };
  for (const [key, value] of Object.entries(raw)) if (key !== 'mcpServers') walk(value, key);
  return uses;
}

function reaches(server: Server, value: string, env: Record<string, string | undefined>): boolean {
  const opened = openedBy(server);
  if (opened === 'spawn') {
    return [...Object.values(childEnv(server, env)), ...(Array.isArray(server.args) ? server.args : [])]
      .some((s) => typeof s === 'string' && s.includes(value));
  }
  if (opened !== 'dial') return false;
  return [server.token, server.url].some((s) => typeof s === 'string' && s.includes(value));
}

/** The environment a stdio server is given, as agent-framework 0.30.0's buildChildEnv builds it on POSIX, with the
 *  host's composeMcplChildEnv over the entry's env. */
function childEnv(server: Server, env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (server.inheritEnv === true || CHILD_ENV_ALLOWLIST.includes(name) || name.startsWith('LC_')) out[name] = value;
  }
  return { ...out, ...composeMcplChildEnv(stringValues(server.env), '') };
}

/** Bun loads .env, .env.local and the like in the working directory itself, filling only what the process doesn't
 *  have (Bun 1.4.4), so the host's environment is asked of Bun. */
function serviceEnv(work: string, root: string): Record<string, string | undefined> {
  const base: Record<string, string> = { [SUPERVISED_ENV]: '1', [INSTALL_ROOT_ENV]: root };
  try {
    base.DATA_DIR = dataDirOf(root);
  } catch {}
  for (const name of SYSTEM_VARIABLES) if (process.env[name] !== undefined) base[name] = process.env[name]!;
  const ran = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
    cwd: work,
    env: base,
    encoding: 'utf-8',
  });
  if (ran.error !== undefined) {
    throw new Error(`Bun couldn't be run in ${work} to read the service's environment: ${ran.error.message}`);
  }
  if (ran.status !== 0) {
    throw new Error(`Bun ${ran.status === null ? `was ended by ${ran.signal}` : `exited ${ran.status}`} in ${work} as it read ` +
      'the service\'s environment, and its error isn\'t shown, since it can hold .env\'s values: run `bun -e 0` there to ' +
      'see it.');
  }
  try {
    return JSON.parse(ran.stdout) as Record<string, string>;
  } catch {
    throw new Error(`Bun's answer in ${work} wasn't an environment doctor could read: something else wrote to its ` +
      'output, as a bunfig.toml preload can.');
  }
}

function stringValues(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === null || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
