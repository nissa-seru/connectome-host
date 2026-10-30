import { describe, test, expect, afterAll } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli/connectome.js';
import { doctor, type DoctorParts } from '../src/cli/doctor.js';

const SECRETS = {
  DISCORD_TOKEN: 'tok-secret-value',
  SESSION_SERVER_TOKEN: 'shell-secret-value',
  ANTHROPIC_API_KEY: 'sk-secret-key',
  LONELY_SECRET: 'lonely-secret-value',
};
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

interface Install { work: string; root: string; data: string }

const RECIPE = (work: string) => ({
  name: 'Ember',
  agent: { name: 'ember', model: 'claude-test-model', systemPrompt: 'hello' },
  mcpServers: {
    discord: { command: join(work, 'node_modules/.bin/discord-mcpl'), env: { DISCORD_TOKEN: '${DISCORD_TOKEN}', DISCORD_GUILD_ID: '100' } },
    shell: { command: join(work, 'node_modules/.bin/terminal-sessions-mcp'), env: { SESSION_SERVER_TOKEN: '${SESSION_SERVER_TOKEN}' } },
  },
});

function install(opts: {
  stored?: string[];
  env?: Record<string, string>;
  drop?: string[];
  recipe?: Record<string, unknown>;
  overlay?: Record<string, unknown>;
  manager?: 'systemd-user' | 'launchd';
  prefix?: string;
} = {}): Install {
  const work = mkdtempSync(join(tmpdir(), opts.prefix ?? 'chost-doctor-'));
  dirs.push(work);
  const root = join(work, 'connectome-host');
  const data = join(work, 'data');
  mkdirSync(root);
  mkdirSync(data);
  mkdirSync(join(work, '.setup'));
  writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: data, extraState: [] }));
  writeFileSync(join(root, 'service.json'), JSON.stringify({
    v: 1,
    manager: opts.manager ?? 'systemd-user',
    units: { host: { name: 'connectome-test.service', file: '/nowhere/connectome-test.service' } },
    hostArgs: [join(work, 'recipe.json')],
    workingDirectory: work,
    logs: { kind: 'journal' },
  }));
  const env: Record<string, string> = { ...SECRETS, ...opts.env };
  for (const name of opts.drop ?? []) delete env[name];
  writeFileSync(join(work, '.env'), Object.entries(env).map(([k, v]) => `${k}="${v}"`).join('\n') + '\n');
  writeFileSync(join(work, '.setup', 'stored-secrets.json'), JSON.stringify(opts.stored ?? ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN']));
  writeFileSync(join(work, 'recipe.json'), JSON.stringify(opts.recipe ?? RECIPE(work)));
  if (opts.overlay) writeFileSync(join(work, 'mcpl-servers.agent.json'), JSON.stringify({ mcplServers: opts.overlay }));
  return { work, root, data };
}

interface FakeHost { stop: () => void; received: string[] }

function fakeHost(at: Install, answers: Record<string, unknown>, opts: { closeOnRequest?: boolean } = {}): FakeHost {
  const received: string[] = [];
  const server = Bun.listen({
    unix: join(at.data, 'ipc.sock'),
    socket: {
      open(socket) {
        socket.write(JSON.stringify({ type: 'lifecycle', phase: 'ready', pid: 4242, dataDir: at.data, recipe: 'Ember' }) + '\n');
      },
      data(socket, chunk) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as { type: string; op?: string; corrId?: string };
          if (msg.type !== 'panel-request') continue;
          received.push(msg.op!);
          if (opts.closeOnRequest) {
            socket.end();
            return;
          }
          if (answers === SILENT) continue;
          const data = answers[msg.op!];
          socket.write(JSON.stringify(data === undefined
            ? { type: 'panel-response', corrId: msg.corrId, op: msg.op, ok: false, error: `unknown panel op: ${msg.op}` }
            : { type: 'panel-response', corrId: msg.corrId, op: msg.op, ok: true, data }) + '\n');
        }
      },
    },
  });
  return { stop: () => server.stop(true), received };
}

const SILENT: Record<string, unknown> = {};

const COUNTED = {
  agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens' },
  compression: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens' },
};
const HEALTHY_HOST = {
  'shell-check': { shells: [{ server: 'shell', answered: true, sessions: 2 }], notConnected: [], closedTabs: [] },
  'count-check': COUNTED,
};

const OTHER_TOKEN = 'other-token-value';
const BOTS: Record<string, { id: string; username: string }> = {
  [`Bot ${SECRETS.DISCORD_TOKEN}`]: { id: '900', username: 'ember' },
  [`Bot ${OTHER_TOKEN}`]: { id: '901', username: 'second' },
};

const discordFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const bot = BOTS[new Headers(init?.headers).get('authorization') ?? ''];
  if (bot === undefined) return Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 });
  const path = new URL(String(input)).pathname.replace(/^\/api\/v10/, '');
  if (path === '/users/@me') return Response.json(bot);
  if (path === '/applications/@me') return Response.json({ flags: 1 << 19 });
  if (path === '/users/@me/guilds') return Response.json([{ id: '100', name: 'Home' }]);
  if (path === '/guilds/100/roles') return Response.json([{ id: '100', permissions: String(1 << 10) }]);
  if (path === `/guilds/100/members/${bot.id}`) return Response.json({ roles: [] });
  if (path === '/guilds/100/channels') return Response.json([{ id: '101', name: 'general', type: 0, permission_overwrites: [] }]);
  return new Response('not found', { status: 404 });
}) as typeof fetch;

function fakePython(dir: string, opts: { sleep?: number; end?: 'findings' | 'traceback' | 'clean' | 'signal' } = {}): string {
  const path = join(dir, opts.sleep ? 'python3-slow' : opts.end && opts.end !== 'findings' ? `python3-${opts.end}` : 'python3');
  writeFileSync(path, [
    '#!/bin/sh',
    'shift',
    'echo "ladder args: $*"',
    `case "$CONNECTOME_DOCTOR_WITHHOLD" in *${SECRETS.DISCORD_TOKEN}*) echo "ladder withholds DISCORD_TOKEN's value" ;; esac`,
    'echo "ladder XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"',
    `echo "recent failure: Error token=${SECRETS.DISCORD_TOKEN}"`,
    ...(opts.sleep ? [`sleep ${opts.sleep}`] : []),
    ...(opts.end === 'traceback'
      ? ['printf "partial line"', 'echo "Traceback (most recent call last):" >&2', 'exit 1']
      : opts.end === 'clean'
        ? ['echo "=== no obvious problems — pipeline looks alive ==="', 'exit 0']
        : opts.end === 'signal'
          ? ['kill -TERM $$']
          : ['echo "=== findings ==="', 'echo "  * the ladder\'s own finding"', 'exit 1']),
  ].join('\n') + '\n');
  chmodSync(path, 0o755);
  return path;
}

async function run(at: Install, parts: Partial<DoctorParts> = {}, argv: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const status = await doctor({ root: at.root, argv, out: (l) => out.push(l), err: (l) => err.push(l) }, {
    fetch: discordFetch,
    checkService: async () => ({ passed: true, lines: ['The unit connectome-test.service is active, with no restarts.'] }),
    python: fakePython(at.work),
    hostLimitMs: 60_000,
    ladderLimitMs: 60_000,
    ...parts,
  });
  return { status, out: out.join('\n'), err: err.join('\n') };
}

async function withHost<T>(at: Install, answers: Record<string, unknown>, body: (host: FakeHost) => Promise<T>, opts = {}): Promise<T> {
  const host = fakeHost(at, answers, opts);
  try {
    return await body(host);
  } finally {
    host.stop();
  }
}

function expectNoSecret(text: string): void {
  for (const value of Object.values(SECRETS)) expect(text).not.toContain(value);
}

describe('connectome doctor', () => {
  test('a healthy install: every whole check passes, the ladder runs with the data directory, the working directory and the unit, withholding the stored values, and the exit is 0', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('connectome-test.service is active');
    expect(r.out).toContain('pid 4242');
    expect(r.out).toContain('shell reached its daemon: 2 sessions.');
    expect(r.out).toContain('ember (900)');
    expect(r.out).toContain(`ladder args: --data-dir ${at.data} ${at.work} connectome-test.service`);
    expect(r.out).toContain('ladder withholds DISCORD_TOKEN\'s value');
    expect(r.out).toContain('<DISCORD_TOKEN>');
    expect(r.out).toContain('[fit] Not checked: whether agent.contextBudgetTokens and agent.maxTokens fit claude-test-model\'s window.');
    expectNoSecret(r.out + r.err);
    expect(r.status).toBe(0);
  });

  test('a server kept as a closed tab is said in a plain line, not as a problem, and the exit stays 0', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'shell-check': { ...HEALTHY_HOST['shell-check'], closedTabs: ['games'] },
    }, () => run(at));
    expect(r.out).toContain('The server games is a closed tab: the host connects it when an agent opens it, so its connection isn\'t checked.');
    expect(r.out).not.toMatch(/✗.*games/);
    expect(r.status).toBe(0);
  });

  test('with no connected server offering listSessions, a closed tab is named as one that may be the shell, beside a server that isn\'t connected when there is one', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'shell-check': { shells: [], notConnected: [], closedTabs: ['shell'] },
    }, () => run(at));
    expect(r.out).toContain('No connected server offers listSessions, so there\'s no shell to call; a closed tab may be the shell.');
    expect(r.status).toBe(0);
    const other = install();
    const both = await withHost(other, {
      ...HEALTHY_HOST,
      'shell-check': { shells: [], notConnected: [{ id: 'down', retrying: false, refused: null }], closedTabs: ['shell'] },
    }, () => run(other));
    expect(both.out).toContain('No connected server offers listSessions, so there\'s no shell to call; a server that isn\'t ' +
      'connected or a closed tab may be the shell.');
    expect(both.status).toBe(1);
  });

  test('a compression count refused for its credential names each the host may send and says to replace it', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'count-check': {
        agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens_failed_401' },
        compression: { model: 'claude-old', countModel: 'claude-old', source: 'count_tokens_failed_401' },
      },
    }, () => run(at));
    expect(r.out).toContain('✗ count_tokens couldn\'t count with the compression model, claude-old: count_tokens refused ' +
      'the credential the host sent (401): its subscription login when it has one, else ANTHROPIC_AUTH_TOKEN, else ' +
      'ANTHROPIC_API_KEY. Replace that credential where the service gets it, and restart the service.');
    expect(r.status).toBe(1);
  });

  test('a ladder that finishes with findings is shown whole, its findings don\'t count toward the exit, and the summary says whose they are', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('the ladder\'s own finding');
    expect(r.out).not.toContain('✗');
    expect(r.out).toMatch(/Doctor's own checks found no problem; the findings above are the ladder's, which doctor doesn't count\./);
    expect(r.status).toBe(0);
  });

  test('a ladder that stops before it finishes is a problem, and its partial line and its traceback are each a line', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { python: fakePython(at.work, { end: 'traceback' }) }));
    expect(r.out).toMatch(/^  partial line$/m);
    expect(r.out).toMatch(/^  Traceback \(most recent call last\):$/m);
    expect(r.out.indexOf('partial line')).toBeLessThan(r.out.indexOf('Traceback'));
    expect(r.out).toMatch(/✗ The ladder stopped \(exit 1\) before it finished/);
    expect(r.status).toBe(1);
  });

  test('a ladder that finishes clean leaves the exit 0, and one a signal ends is a problem', async () => {
    const at = install();
    const clean = await withHost(at, HEALTHY_HOST, () => run(at, { python: fakePython(at.work, { end: 'clean' }) }));
    expect(clean.out).toContain('pipeline looks alive');
    expect(clean.out).not.toContain('✗');
    expect(clean.out).toMatch(/Doctor found no problem\.$/);
    expect(clean.status).toBe(0);
    const ended = await withHost(at, HEALTHY_HOST, () => run(at, { python: fakePython(at.work, { end: 'signal' }) }));
    expect(ended.out).toMatch(/✗ The ladder was ended by SIGTERM/);
    expect(ended.status).toBe(1);
  });

  test('when Bun\'s answer in the working directory isn\'t an environment, doctor stops saying so, and quotes none of it', async () => {
    const at = install();
    writeFileSync(join(at.work, 'bunfig.toml'), 'preload = ["./pre.ts"]\n');
    writeFileSync(join(at.work, 'pre.ts'), 'process.stdout.write("quoted-marker ");\n');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗ Bun's answer in .* wasn't an environment doctor could read: something else wrote to its output, as a bunfig\.toml preload can\./);
    expect(r.out).not.toContain('quoted');
    expect(r.out).toContain('Doctor stops here');
    expect(r.status).toBe(1);
  });

  test('when Bun fails in the working directory, doctor stops quoting none of its error, says how to see it, and withholds the install\'s path', async () => {
    const at = install({ prefix: `chost-${SECRETS.LONELY_SECRET}-`, stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'] });
    writeFileSync(join(at.work, 'bunfig.toml'), 'preload = ["./pre.ts"]\n');
    writeFileSync(join(at.work, 'pre.ts'), 'throw new Error(`refused ${process.env.DISCORD_TOKEN}`);\n');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/^connectome doctor: the install at .*<LONELY_SECRET>/);
    expect(r.out).toMatch(/✗ Bun exited 1 in .*<LONELY_SECRET>.* as it read the service's environment, and its error isn't shown, since it can hold \.env's values: run `bun -e 0` there to see it\./);
    expect(r.out + r.err).not.toContain('refused');
    expect(r.out).toContain('Doctor stops here');
    expect(r.out.slice(r.out.indexOf('Doctor stops here')).split('\n').length).toBe(1);
    expectNoSecret(r.out + r.err);
    expect(r.status).toBe(1);
  });

  test('when a signal ends Bun in the working directory, doctor stops saying so', async () => {
    const at = install();
    writeFileSync(join(at.work, 'bunfig.toml'), 'preload = ["./pre.ts"]\n');
    writeFileSync(join(at.work, 'pre.ts'), 'process.kill(process.pid, "SIGTERM");\n');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗ Bun was ended by SIGTERM in .* as it read the service's environment, and its error isn't shown/);
    expect(r.out).toContain('Doctor stops here');
    expectNoSecret(r.out + r.err);
    expect(r.status).toBe(1);
  });

  test('a provider credential only doctor\'s own environment holds is withheld too', async () => {
    const at = install({ drop: ['ANTHROPIC_API_KEY'] });
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-shell-only-key';
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at, {
        checkService: async () => ({ passed: true, lines: ['The unit said: key sk-shell-only-key refused.'] }),
      }));
      expect(r.out).toContain('key <ANTHROPIC_API_KEY> refused');
      expect(r.out).not.toContain('sk-shell-only-key');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test('the install\'s own path is printed through the redactor too', async () => {
    const at = install({ prefix: `chost-${SECRETS.LONELY_SECRET}-`, stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'], recipe: { ...RECIPE(''), mcpServers: {} } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/^connectome doctor: the install at .*<LONELY_SECRET>/);
    expectNoSecret(r.out + r.err);
  });

  test('a loader warning is a line of the report, redacted, and nothing reaches the console', async () => {
    const at = install({ recipe: { ...RECIPE(''), [SECRETS.DISCORD_TOKEN]: 1 } });
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toMatch(/keys the host does not read.*<DISCORD_TOKEN>/);
      expect(warned.join('\n')).not.toContain(SECRETS.DISCORD_TOKEN);
      expectNoSecret(r.out + r.err);
    } finally {
      console.warn = warn;
    }
  });

  test('a stored DISCORD_TOKEN that no server gets is told to be named in a server\'s env, the one place discord-mcpl reads it', async () => {
    const at = install({ stored: ['DISCORD_TOKEN'], recipe: { ...RECIPE(''), mcpServers: { shell: RECIPE('').mcpServers.shell } } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗ DISCORD_TOKEN is stored in .*, and no server gets it: .* Name it as "\$\{DISCORD_TOKEN\}" in the recipe entry of the server that needs it: in its env, as "DISCORD_TOKEN": "\$\{DISCORD_TOKEN\}"\. mcpl-servers\.json /);
    expect(r.out).not.toMatch(/DISCORD_TOKEN is stored in [^\n]*or in its args/);
  });

  test('a secret setup stored that no server\'s env maps is a problem, the overlay\'s replacement included', async () => {
    const lonely = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'] });
    const r = await withHost(lonely, HEALTHY_HOST, () => run(lonely));
    expect(r.out).toMatch(/✗.*LONELY_SECRET/);
    expect(r.out).toMatch(/LONELY_SECRET is stored in .*, and no server gets it: no server the host starts is given it in its env or args, no server it dials names it in its token or url, and the recipe names it nowhere outside its servers\. Name it as "\$\{LONELY_SECRET\}" in the recipe entry of the server that needs it: in its env, as "LONELY_SECRET": "\$\{LONELY_SECRET\}", or in its args, or, for a server the host dials, in its token or url\. mcpl-servers\.json and the agent overlay take their values as written, with no \$\{…\} substituted\. For a server mcpl-servers\.json starts, a recipe entry can't set its env or args: move the server's definition out of mcpl-servers\.json into the recipe, or set "inheritEnv": true in its recipe entry, which hands it the host's whole environment, with LONELY_SECRET left out of the file's env, whose value would replace the host's\. An agent overlay entry replaces the recipe's and the file's, so the recipe can't reach a server the overlay defines while that entry is there: take the entry out of the overlay, put the server's definition, with its command or url, in the recipe, or in mcpl-servers\.json with a recipe entry that names it, and follow the steps above for whichever then defines it\. Then restart the service\./);
    expect(r.out).not.toMatch(/✗.*SESSION_SERVER_TOKEN/);
    expectNoSecret(r.out + r.err);
    expect(r.status).toBe(1);

    const shadowed = install({ overlay: { shell: { command: '/elsewhere/terminal-sessions-mcp', env: {} } } });
    const r2 = await withHost(shadowed, HEALTHY_HOST, () => run(shadowed));
    expect(r2.out).toMatch(/✗.*SESSION_SERVER_TOKEN/);
    expect(r2.status).toBe(1);
  });

  test('a DISCORD_TOKEN in .env that setup didn\'t store is withheld too, from doctor\'s lines and the ladder\'s reads', async () => {
    const at = install({ stored: ['SESSION_SERVER_TOKEN'] });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('ladder withholds DISCORD_TOKEN\'s value');
    expect(r.out).toContain('<DISCORD_TOKEN>');
    expectNoSecret(r.out + r.err);
  });

  test('a server given the host\'s whole environment (inheritEnv) sees every stored secret without a mapping', async () => {
    const at = install({
      recipe: {
        name: 'Ember',
        agent: { name: 'ember', model: 'claude-test-model', systemPrompt: 'hello' },
        mcpServers: {
          discord: { command: join('/x', 'node_modules/.bin/discord-mcpl'), inheritEnv: true, env: { DISCORD_GUILD_ID: '100' } },
          shell: { command: '/x/terminal-sessions-mcp', inheritEnv: true },
        },
      },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).not.toContain('✗');
    expect(r.out).toContain('ember (900)');
    expect(r.status).toBe(0);
  });

  test('a stored secret reaches a server as the framework builds its environment: an entry\'s own value replaces what it inherits, and every server gets the variables it passes by default', async () => {
    const overridden = install({
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'],
      recipe: {
        ...RECIPE(''),
        mcpServers: {
          discord: { command: '/x/node_modules/.bin/discord-mcpl', env: { DISCORD_TOKEN: '${DISCORD_TOKEN}', DISCORD_GUILD_ID: '100' } },
          shell: { command: '/x/terminal-sessions-mcp', inheritEnv: true, env: { LONELY_SECRET: 'something else' } },
        },
      },
    });
    const r = await withHost(overridden, HEALTHY_HOST, () => run(overridden));
    expect(r.out).toMatch(/✗.*LONELY_SECRET/);
    expect(r.out).toMatch(/✓.*SESSION_SERVER_TOKEN reaches shell/);

    const proxy = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'HTTPS_PROXY'], env: { HTTPS_PROXY: 'http://user:proxy-pass@proxy:8080' } });
    const r2 = await withHost(proxy, HEALTHY_HOST, () => run(proxy));
    expect(r2.out).toMatch(/✓.*HTTPS_PROXY reaches discord, shell/);
    expect(r2.out).not.toContain('proxy-pass');
  });

  test('a stored secret mapped only as AGENT_TIMEZONE doesn\'t reach the server, since the host sets that variable over every server\'s', async () => {
    const at = install({
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'],
      recipe: { ...RECIPE(''), mcpServers: { ...RECIPE('').mcpServers, extra: { command: '/x/extra', env: { AGENT_TIMEZONE: '${LONELY_SECRET}' } } } },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗ LONELY_SECRET is stored/);
    expect(r.out).not.toMatch(/LONELY_SECRET reaches/);
  });

  test('a stored secret the recipe names outside its servers, as modules.webui\'s basic auth does, is in use, and doctor says where: as a reference with a default, inside a longer value and in a list too, but not under a key the host doesn\'t read', async () => {
    const at = install({
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'WEBUI_USER', 'WEBUI_PASS', 'WEBUI_ORIGIN', 'WEBUI_TYPO'],
      env: { WEBUI_USER: 'web-user-value', WEBUI_PASS: 'web-pass-value', WEBUI_ORIGIN: 'web-origin-value', WEBUI_TYPO: 'web-typo-value' },
      recipe: {
        ...RECIPE(''),
        modules: {
          webui: {
            host: '127.0.0.1',
            basicAuth: { username: '${WEBUI_USER}', password: 'p-${WEBUI_PASS:-unset}' },
            allowedOrigins: ['https://admin.example', 'https://${WEBUI_ORIGIN}.example'],
          },
          webiu: { basicAuth: { username: '${WEBUI_TYPO}' } },
        },
      },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('✓ WEBUI_USER is named in the recipe, at modules.webui.basicAuth.username.');
    expect(r.out).toContain('✓ WEBUI_PASS is named in the recipe, at modules.webui.basicAuth.password.');
    expect(r.out).toContain('✓ WEBUI_ORIGIN is named in the recipe, at modules.webui.allowedOrigins[1].');
    expect(r.out).not.toMatch(/✗ WEBUI_(USER|PASS|ORIGIN)/);
    expect(r.out).toMatch(/keys the host does not read \(ignored\): modules\.webiu/);
    expect(r.out).toMatch(/✗ WEBUI_TYPO is stored in .*, and no server gets it: .*, and the recipe names it nowhere outside its servers\./);
    for (const value of ['web-user-value', 'web-pass-value', 'web-origin-value', 'web-typo-value']) expect(r.out + r.err).not.toContain(value);
  });

  test('a stored value reaches a server the host starts when its env or args hold it, inside a longer value too, and one it dials when its configured token or url holds it', async () => {
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ['inside a longer env value', { command: '/x/extra', env: { AUTH: 'Bearer ${LONELY_SECRET}' } }, true],
      ['in its args', { command: '/x/extra', args: ['--token', '${LONELY_SECRET}'] }, true],
      ['in the url of a dialled server with no token', { url: 'wss://mcpl.example.test/ws?key=${LONELY_SECRET}' }, true],
      ['in the url\'s path beside a token', { url: 'wss://mcpl.example.test/s/${LONELY_SECRET}/ws', token: 'other' }, true],
      ['in the url\'s token parameter, beside a token of its own', { url: 'wss://mcpl.example.test/ws?token=${LONELY_SECRET}', token: 'other' }, true],
      ['as its access, an audience', { url: 'wss://mcpl.example.test/ws', access: '${LONELY_SECRET}' }, false],
    ];
    const got: Array<[string, boolean]> = [];
    for (const [what, extra] of cases) {
      const at = install({
        stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'],
        recipe: { ...RECIPE(''), mcpServers: { ...RECIPE('').mcpServers, extra } },
      });
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toMatch(/(✓ LONELY_SECRET reaches extra\.|✗ LONELY_SECRET is stored)/);
      got.push([what, /✓ LONELY_SECRET reaches extra\./.test(r.out)]);
    }
    expect(got).toEqual(cases.map(([what, , reaches]) => [what, reaches]));
  });

  test('a stored secret reaches a server the host dials when its token carries it, and no variable of the host\'s reaches it', async () => {
    const at = install({
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET', 'HTTPS_PROXY'],
      env: { HTTPS_PROXY: 'http://user:proxy-pass@proxy:8080' },
      recipe: { ...RECIPE(''), mcpServers: { ...RECIPE('').mcpServers, remote: { url: 'wss://mcpl.example.test/ws', token: '${LONELY_SECRET}' } } },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✓ LONELY_SECRET reaches remote\./);
    expect(r.out).toMatch(/✓ HTTPS_PROXY reaches discord, shell\./);
  });

  test('a stored secret .env writes empty is a problem, and reaches no server, a provider\'s credential included when the recipe doesn\'t load', async () => {
    const at = install({
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'],
      env: { LONELY_SECRET: '' },
      recipe: { ...RECIPE(''), mcpServers: { ...RECIPE('').mcpServers, extra: { command: '/x/extra', env: { BLANK: '' } } } },
    });
    const r0 = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r0.out).toMatch(/✗ LONELY_SECRET was stored by setup and is empty in the service's environment: give it its value in .*\.env and restart the service\./);
    expect(r0.out).not.toMatch(/LONELY_SECRET reaches/);
    expect(r0.status).toBe(1);
    const provider = install({ stored: ['ANTHROPIC_API_KEY'], env: { ANTHROPIC_API_KEY: '' } });
    writeFileSync(join(provider.work, 'recipe.json'), '{ not json');
    const r = await withHost(provider, HEALTHY_HOST, () => run(provider));
    expect(r.out).toMatch(/✗ .*recipe\.json doesn't load/);
    expect(r.out).toMatch(/✗ ANTHROPIC_API_KEY was stored by setup and is empty in the service's environment/);
  });

  test('each Discord server the recipe runs is checked with its own token, one named only in its args included', async () => {
    const at = install({
      env: { OTHER_TOKEN },
      recipe: {
        ...RECIPE(''),
        mcpServers: {
          ...RECIPE('').mcpServers,
          second: { command: 'node', args: ['/x/node_modules/discord-mcpl/dist/index.js'], env: { DISCORD_TOKEN: '${OTHER_TOKEN}', DISCORD_GUILD_ID: '100' } },
        },
      },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toContain('ember (900)');
    expect(r.out).toContain('second (901)');
  });

  test('a recipe that names the install root, which the install\'s entry point gives the host, loads', async () => {
    const at = install({ recipe: { name: 'Ember', agent: { name: 'ember', model: 'claude-test-model', systemPrompt: 'installed at ${CONNECTOME_INSTALL_ROOT}' } } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✓ .*recipe\.json loads\./);
  });

  test('an empty compressionModel in the recipe is a problem with no host to ask, and counted once with one', async () => {
    const recipe = { name: 'Ember', agent: { name: 'ember', model: 'claude-test-model', systemPrompt: 'hi', strategy: { compressionModel: '' } } };
    const alone = install({ recipe });
    const r = await run(alone);
    expect(r.out).toMatch(/✗ The recipe's agent\.strategy\.compressionModel is empty.*, and restart the service\./);

    const asked = install({ recipe });
    const r2 = await withHost(asked, { ...HEALTHY_HOST, 'count-check': { ...COUNTED, compression: { model: '', countModel: null, source: 'count_tokens_unsupported_model' } } }, () => run(asked));
    expect(r2.out.match(/compressionModel is empty/g)).toHaveLength(1);
  });

  test('a server env value that isn\'t a string counts as its string form', async () => {
    const at = install({
      stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'PORT_SECRET'],
      env: { PORT_SECRET: '48211' },
      recipe: { ...RECIPE(''), mcpServers: { ...RECIPE('').mcpServers, extra: { command: '/x/extra', env: { PORT_SECRET: 48211 } } } },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✓.*PORT_SECRET reaches extra/);
  });

  test('a stored secret .env no longer holds is a problem whether or not the recipe loads, a provider\'s credential included', async () => {
    const at = install({
      stored: ['ANTHROPIC_API_KEY', 'LONELY_SECRET'],
      drop: ['ANTHROPIC_API_KEY', 'LONELY_SECRET'],
      recipe: { name: 'Ember', agent: { name: 'ember', systemPrompt: '${NOT_IN_ENV}' } },
    });
    const r = await run(at);
    expect(r.out).toMatch(/✗ ANTHROPIC_API_KEY was stored by setup and isn't in .*\.env/);
    expect(r.out).toMatch(/✗ LONELY_SECRET was stored by setup and isn't in .*\.env any more: put it back there and restart the service\./);
    expect(r.status).toBe(1);

    const loads = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'], drop: ['LONELY_SECRET'] });
    const r2 = await withHost(loads, HEALTHY_HOST, () => run(loads));
    expect(r2.out).toMatch(/✓ .*recipe\.json loads\./);
    expect(r2.out).toMatch(/✗ LONELY_SECRET was stored by setup and isn't in .*\.env/);
  });

  test('a server list that doesn\'t resolve is a problem, and the checks that need it say they weren\'t made', async () => {
    const at = install({ stored: ['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN', 'LONELY_SECRET'] });
    writeFileSync(join(at.work, 'mcpl-servers.json'), '{ not json');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗ The recipe's server list doesn't resolve/);
    expect(r.out).toContain('Which servers see DISCORD_TOKEN, SESSION_SERVER_TOKEN, LONELY_SECRET isn\'t checked: the recipe\'s server list doesn\'t resolve.');
    expect(r.out).not.toMatch(/✗.*LONELY_SECRET/);
    expect(r.out).not.toContain('The recipe has no Discord server');
    expect(r.out).toMatch(/Discord isn't checked/);
  });

  test('with no service recorded it says so, and the checks that need its recipe or its unit say why they didn\'t run', async () => {
    const at = install();
    rmSync(join(at.root, 'service.json'));
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗ No service is recorded/);
    expect(r.out).toContain('connectome service install');
    expect(r.out).toContain('Which recipe the service runs is in its record, so it isn\'t checked without one.');
    expect(r.out).toContain('The ladder reads the service\'s unit and log, so it runs once a service is recorded.');
    expect(r.out).not.toContain('ladder args');
    expect(r.out).not.toContain('ember (900)');
    expect(r.status).toBe(1);
  });

  test('a service record that can\'t be read is a problem naming how to write it again, and the ladder says why it didn\'t run', async () => {
    const at = install();
    writeFileSync(join(at.root, 'service.json'), '{ "v": 1 }');
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗.*service record.*connectome service install <recipe>/);
    expect(r.out).not.toContain('ladder args');
    expect(r.out).toMatch(/ladder .*record can't be read/);
    expect(r.out).toMatch(/Discord isn't checked: .*the service's record can't be read/);
    expect(r.status).toBe(1);
  });

  test('a service record that goes bad after the service check is a problem in words, and the checks after it are made', async () => {
    const at = install();
    const r = await run(at, {
      checkService: async () => {
        writeFileSync(join(at.root, 'service.json'), '{ "v": 1 }');
        return { passed: true, lines: [] };
      },
    });
    expect(r.out).toMatch(/✗ Reading the service record again failed: /);
    expect(r.out).toContain('ember (900)');
    expect(r.out).toContain('ladder args');
    expect(r.status).toBe(1);
  });

  test('a service check that doesn\'t pass is a problem, and one that throws is a problem too, with the checks after it made', async () => {
    const at = install();
    const failing = await withHost(at, HEALTHY_HOST, () => run(at, { checkService: async () => ({ passed: false, lines: ['The unit is failed.'] }) }));
    expect(failing.out).toMatch(/✗ The service check above didn't pass/);
    expect(failing.status).toBe(1);
    const throwing = await withHost(at, HEALTHY_HOST, () => run(at, { checkService: async () => { throw new Error('systemctl vanished'); } }));
    expect(throwing.out).toMatch(/✗.*systemctl vanished/);
    expect(throwing.out).toContain('ember (900)');
    expect(throwing.out).toContain('ladder args');
    expect(throwing.status).toBe(1);
  });

  test('with no host answering it says why and how to start it, says what needs the host, still checks the rest, and lets the ladder judge the signal', async () => {
    const at = install();
    const r = await run(at);
    expect(r.out).toMatch(/✗.*host/i);
    expect(r.out).toContain('start it: ');
    expect(r.out).toContain('follow its log: journalctl --user -u connectome-test.service -f');
    expect(r.out).toContain('ember (900)');
    expect(r.out).toMatch(/needs? the host/);
    expect(r.out).toContain(`ladder args: --data-dir ${at.data} ${at.work} connectome-test.service`);
    expectNoSecret(r.out + r.err);
    expect(r.status).toBe(1);
  });

  test('the shell\'s and the counts\' failures, and a server not connected, are each a problem in words', async () => {
    const at = install();
    const r = await withHost(at, {
      'shell-check': {
        shells: [
          { server: 'shell', answered: false, error: 'Connection lost' },
          { server: 'shell2', answered: false, error: 'Tool call denied by the allowlist' },
          { server: 'shell3', answered: false, error: 'Connection timeout' },
        ],
        notConnected: [
          { id: 'discord', retrying: true, refused: null },
          { id: 'old', retrying: false, refused: 'its command is empty' },
          { id: 'dying', retrying: false, refused: null },
        ],
        closedTabs: [],
      },
      'count-check': {
        agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens_failed_404' },
        compression: { model: 'claude-old', countModel: 'claude-old', source: 'count_tokens_failed_404' },
      },
    }, () => run(at));
    expect(r.out).toMatch(/✗.*shell.*Connection lost.*SESSION_SERVER_TOKEN/);
    expect(r.out).toMatch(/✗.*shell2.*Tool call denied by the allowlist\.$/m);
    expect(r.out).toMatch(/✗ shell3 didn't reach its daemon: Connection timeout\..*"Connection timeout" a daemon that isn't running/);
    expect(r.out).toMatch(/✗.*discord isn't connected.*still retrying/);
    expect(r.out).toMatch(/✗.*old isn't connected.*its command is empty/);
    expect(r.out).toMatch(/✗ The server dying isn't connected, and the host isn't retrying it\. Its stderr is in the data directory/);
    expect(r.out).toMatch(/✗ count_tokens couldn't count with claude-small-window: .*\. So the context's makeup shows no exact total\. A retired model answers 404, and the endpoint count_tokens asks \(Anthropic's API, or the one ANTHROPIC_BASE_URL names\) may answer it for a model it doesn't serve: set COUNT_TOKENS_MODEL in .*\.env to a current Claude model, and restart the service, since the host reads it when it starts\./);
    expect(r.out).toMatch(/✗.*claude-old.*folding stalls.*: change the recipe's agent\.strategy\.compressionModel to a current model and restart the service\. The endpoint count_tokens asks \(Anthropic's API, or the one ANTHROPIC_BASE_URL names\) may answer 404 for a model it doesn't serve too, and then the 404 doesn't mean it's retired\./);
    expect(r.out).not.toContain('only a gateway serves');
    expect(r.status).toBe(1);
  });

  test('a 404 for the compression model offers leaving it out only when the agent\'s own model counts and isn\'t the compression model', async () => {
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ['the agent\'s model counts', { model: 'claude-live', countModel: 'claude-live', source: 'count_tokens' }, true],
      ['the agent\'s model answers 404 too', { model: 'claude-other-old', countModel: 'claude-other-old', source: 'count_tokens_failed_404' }, false],
      ['it is the agent\'s model', { model: 'claude-old', countModel: 'claude-old', source: 'count_tokens_failed_404' }, false],
      ['COUNT_TOKENS_MODEL\'s model counts, not the agent\'s', { model: 'claude-live', countModel: 'claude-override', source: 'count_tokens' }, false],
    ];
    const got: Array<[string, boolean]> = [];
    for (const [what, agent] of cases) {
      const at = install();
      const r = await withHost(at, {
        ...HEALTHY_HOST,
        'count-check': { agent, compression: { model: 'claude-old', countModel: 'claude-old', source: 'count_tokens_failed_404' } },
      }, () => run(at));
      expect(r.out).toMatch(/✗ count_tokens couldn't count with the compression model, claude-old: .*: change the recipe's agent\.strategy\.compressionModel to a current model.* and restart the service\./);
      got.push([what, r.out.includes('or leave it out to compress with the agent\'s model,')]);
    }
    expect(got).toEqual(cases.map(([what, , offered]) => [what, offered]));
  });

  test('a count refused for its credential names each the host may send, and an empty compression model is a problem', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'count-check': {
        agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens_failed_401' },
        compression: { model: '', countModel: null, source: 'count_tokens_unsupported_model' },
      },
    }, () => run(at));
    expect(r.out).toMatch(/✗.*401.*its subscription login when it has one, else ANTHROPIC_AUTH_TOKEN, else ANTHROPIC_API_KEY\. So the context's makeup shows no exact total\. Replace that credential where the service gets it, and restart the service\./);
    expect(r.out).toMatch(/✗.*compressionModel.*empty/);
    expect(r.status).toBe(1);
  });

  test('a count that fails, or an agent with no model, is said in words', async () => {
    const at = install();
    const r = await withHost(at, {
      ...HEALTHY_HOST,
      'count-check': { agent: { model: 'claude-small-window', countModel: 'claude-small-window', source: 'count_tokens_error' }, compression: null },
    }, () => run(at));
    expect(r.out).toMatch(/✗ count_tokens couldn't count with claude-small-window: the count_tokens request failed, didn't answer within 30 s, or answered with what couldn't be read\./);

    const none = install();
    const r2 = await withHost(none, {
      ...HEALTHY_HOST,
      'count-check': { agent: { model: null, countModel: null, source: 'count_tokens_unsupported_model' }, compression: null },
    }, () => run(none));
    expect(r2.out).toContain('count_tokens isn\'t asked: the agent names no model.');
    expect(r2.out).not.toContain('null');
  });

  test('a host answer doctor can\'t read is a problem, and the checks after it are still made', async () => {
    const at = install();
    const r = await withHost(at, { 'count-check': null, 'shell-check': {} }, () => run(at));
    expect(r.out).toMatch(/✗ The token counts failed: /);
    expect(r.out).toMatch(/✗ The shell's call failed: /);
    expect(r.out).toContain('ember (900)');
    expect(r.out).toContain('ladder args');
    expect(r.status).toBe(1);
  });

  test('a host that refuses a check is a problem in its words', async () => {
    const at = install();
    const r = await withHost(at, { 'shell-check': HEALTHY_HOST['shell-check'] }, () => run(at));
    expect(r.out).toMatch(/✗.*token counts.*unknown panel op: count-check/);
    expect(r.out).toMatch(/older release/);
    expect(r.status).toBe(1);
  });

  test('the fit is checked for the model the service runs, MODEL in .env included', async () => {
    const at = install({
      env: { MODEL: 'claude-haiku-4-5' },
      recipe: { name: 'Ember', agent: { name: 'ember', model: 'claude-other', contextBudgetTokens: 250_000, systemPrompt: 'hi' } },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).toMatch(/✗.*claude-haiku-4-5/);
    expect(r.status).toBe(1);
  });

  test('the service\'s environment is Bun\'s: a value Bun reads from .env.local counts, and what the unit sets wins over .env', async () => {
    const local = install({
      recipe: { name: 'Ember', agent: { name: 'ember', model: 'claude-other', contextBudgetTokens: 250_000, systemPrompt: 'hi' } },
    });
    writeFileSync(join(local.work, '.env.local'), 'MODEL=claude-haiku-4-5\n');
    const r = await withHost(local, HEALTHY_HOST, () => run(local));
    expect(r.out).toMatch(/✗.*claude-haiku-4-5/);

    const supervised = install({
      env: { CONNECTOME_SUPERVISED: '0' },
      recipe: { name: 'Ember', agent: { name: 'ember', model: 'claude-test-${CONNECTOME_SUPERVISED}', systemPrompt: 'hi' } },
    });
    const r2 = await withHost(supervised, HEALTHY_HOST, () => run(supervised));
    expect(r2.out).toContain('claude-test-1');
    expect(r2.out).not.toContain('claude-test-0');
  });

  test('the service\'s DATA_DIR is the install\'s data directory, as service install\'s unit sets it, over .env\'s', async () => {
    const at = install({
      env: { DATA_DIR: '/elsewhere' },
      recipe: { name: 'Ember', agent: { name: 'ember', model: 'claude-test-${DATA_DIR}', systemPrompt: 'hi' } },
    });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).not.toContain('which is not set');
    expect(r.out).toContain(`claude-test-${at.data}`);
    expect(r.out).not.toContain('claude-test-/elsewhere');
  });

  test('a system prompt the recipe gives by URL is fetched, as the host fetches it, and counts in the fit', async () => {
    const prompt = Bun.serve({ port: 0, fetch: () => new Response('word '.repeat(240_000)) });
    const at = install({
      recipe: { name: 'Ember', agent: { name: 'ember', model: 'claude-haiku-4-5', systemPrompt: `http://127.0.0.1:${prompt.port}/prompt.txt` } },
    });
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toMatch(/✗.*systemPrompt is about [\d,]+ tokens/);
      expect(r.status).toBe(1);
    } finally {
      prompt.stop(true);
    }
  });

  test('the fit is judged in the service\'s environment: a MODEL only the shell running doctor has doesn\'t count', async () => {
    const at = install({
      recipe: { name: 'Ember', agent: { name: 'ember', model: 'claude-opus-4-8', contextBudgetTokens: 250_000, systemPrompt: 'hi' } },
    });
    const shellModel = process.env.MODEL;
    process.env.MODEL = 'claude-haiku-4-5';
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toMatch(/✓.*fits claude-opus-4-8/);
      expect(r.out).not.toContain('claude-haiku-4-5');
    } finally {
      if (shellModel === undefined) delete process.env.MODEL;
      else process.env.MODEL = shellModel;
    }
  });

  test('a .env outside setup\'s form stops doctor at its start, naming the line and printing none of it, nor any check\'s output, and exits 1', async () => {
    const at = install({ env: { ODD: 'claude-${SIZE}' } });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    const lines = r.out.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`connectome doctor: the install at ${at.root}`);
    expect(lines[1]).toStartWith(`  ✗ ${join(at.work, '.env')}, line ${Object.keys(SECRETS).length + 1}, `);
    expect(lines[2]).toStartWith('Doctor stops here');
    expect(r.out).not.toContain('claude-${SIZE}');
    expectNoSecret(r.out + r.err);
    expect(r.status).toBe(1);
  });

  test('when it stops at its start, the values doctor\'s own environment holds are withheld from what it prints', async () => {
    const at = install({ prefix: 'chost-doctor-own-dtok-own-akey-', env: { ODD: 'claude-${SIZE}' } });
    const before = { DISCORD_TOKEN: process.env.DISCORD_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    process.env.DISCORD_TOKEN = 'own-dtok';
    process.env.ANTHROPIC_API_KEY = 'own-akey';
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toContain('Doctor stops here');
      expect(r.out).toContain('chost-doctor-<DISCORD_TOKEN>-<ANTHROPIC_API_KEY>-');
      expect(r.out).not.toContain('own-dtok');
      expect(r.out).not.toContain('own-akey');
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('when the stored secrets\' list or .env can\'t be read, it names the file and stops, printing no check\'s output, and exits 1', async () => {
    const list = install();
    writeFileSync(join(list.work, '.setup', 'stored-secrets.json'), '{"DISCORD_TOKEN": true}');
    const dotEnv = install();
    rmSync(join(dotEnv.work, '.env'));
    mkdirSync(join(dotEnv.work, '.env'));
    for (const [at, file] of [[dotEnv, /\.env/], [list, /stored-secrets\.json/]] as const) {
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toMatch(new RegExp(`✗.*${file.source}`));
      expect(r.out).toContain('Doctor stops here');
      const after = r.out.slice(r.out.indexOf('Doctor stops here'));
      expect(after.split('\n').length).toBe(1);
      expect(r.out).not.toMatch(/^(Service|Host|Recipe)$/m);
      expect(r.out).not.toContain('ladder args');
      expectNoSecret(r.out + r.err);
      expect(r.status).toBe(1);
    }
  });

  test('a host that never answers a check is a problem, and doctor still finishes', async () => {
    const at = install();
    const r = await withHost(at, SILENT, async (host) => ({ ...(await run(at, { hostLimitMs: 300 })), received: host.received }));
    expect(r.received).toEqual(['count-check', 'shell-check']);
    expect(r.out).toMatch(/✗.*didn't answer the token counts within 0\.3 s/);
    expect(r.out).toMatch(/✗.*didn't answer the shell's call/);
    expect(r.out).toContain('ember (900)');
    expect(r.status).toBe(1);
  });

  test('a host whose connection closes under a check is a problem, and doctor still finishes', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at), { closeOnRequest: true });
    expect(r.out).toMatch(/✗.*connection closed first/);
    expect(r.out).toContain('ladder args');
    expect(r.status).toBe(1);
  });

  test('a Discord refusal is a ✗ line of the report and counts toward the exit', async () => {
    const at = install();
    const refusing = (async () => Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 })) as unknown as typeof fetch;
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { fetch: refusing }));
    expect(r.out).toMatch(/✗ Discord refused the bot token/);
    expect(r.status).toBe(1);
  });

  test('a 401 for a server mcpl-servers.json gives "${DISCORD_TOKEN}" as written says so in its own words', async () => {
    const at = install({ recipe: { ...RECIPE(''), mcpServers: { discord: {}, shell: RECIPE('').mcpServers.shell } } });
    writeFileSync(join(at.work, 'mcpl-servers.json'), JSON.stringify({ mcplServers: { discord: {
      command: 'node', args: ['/x/node_modules/discord-mcpl/dist/index.js'], env: { DISCORD_TOKEN: '${DISCORD_TOKEN}', DISCORD_GUILD_ID: '100' },
    } } }));
    const refusing = (async () => Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 })) as unknown as typeof fetch;
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { fetch: refusing }));
    expect(r.out).toContain('✗ Discord refused the bot token');
    expect(r.out).not.toContain('"<DISCORD_TOKEN>"');
    expect(r.out).toContain('mcpl-servers.json and the agent overlay take it as written, a "${DISCORD_TOKEN}" included');
  });

  test('a recipe that doesn\'t load is a problem in the loader\'s words', async () => {
    const at = install({ recipe: { name: 'Ember', agent: { name: 'ember', systemPrompt: '${NOT_IN_ENV}' } } });
    const r = await run(at);
    expect(r.out).toMatch(/✗.*doesn't load.*NOT_IN_ENV/);
    expect(r.status).toBe(1);
  });

  test('without python3 it says the ladder needs it, which isn\'t a problem by itself', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { python: null }));
    expect(r.out).toMatch(/ladder needs python3/);
    expect(r.status).toBe(0);
  });

  test('a ladder that doesn\'t finish within its limit is a problem, and doctor finishes', async () => {
    const at = install();
    const r = await withHost(at, HEALTHY_HOST, () => run(at, { python: fakePython(at.work, { sleep: 5 }), ladderLimitMs: 300 }));
    expect(r.out).toMatch(/✗ The ladder didn't finish within 0\.3 s, so what it would have shown after the lines above isn't known\./);
    expect(r.status).toBe(1);
  });

  test('the ladder runs with XDG_RUNTIME_DIR, the user manager\'s default when doctor\'s shell has none', async () => {
    const at = install();
    const saved = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      const r = await withHost(at, HEALTHY_HOST, () => run(at));
      expect(r.out).toContain(`ladder XDG_RUNTIME_DIR=/run/user/${process.getuid!()}`);
    } finally {
      if (saved !== undefined) process.env.XDG_RUNTIME_DIR = saved;
    }
  });

  test('a data directory the install record doesn\'t name whole is a problem, with the directory the ladder reads instead', async () => {
    const at = install();
    writeFileSync(join(at.root, 'install.json'), JSON.stringify({ v: 1, dataDir: 'data', extraState: [] }));
    const r = await run(at);
    expect(r.out).toMatch(/✗ The ladder reads .*data, since where the data directory is can't be told: /);
    expect(r.out).toContain('ladder args');
  });

  test('an install that runs under launchd gets no ladder, which reads systemd\'s units and journal, and says so', async () => {
    const at = install({ manager: 'launchd' });
    const r = await withHost(at, HEALTHY_HOST, () => run(at));
    expect(r.out).not.toContain('ladder args');
    expect(r.out).toMatch(/launchd/);
    expect(r.status).toBe(0);
  });

  test('words after doctor are a usage error', async () => {
    const r = await run(install(), {}, ['now']);
    expect(r.status).toBe(2);
    expect(r.err).toContain('connectome: usage: connectome doctor');
  });

  test('the install\'s command dispatches doctor', async () => {
    const at = install();
    const said: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { said.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      expect(await main(at.root, ['doctor', 'now'])).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(said.join('')).toBe('connectome: usage: connectome doctor\n');
  });

  test('the install\'s help says the host takes one client at a time, so doctor\'s connection closes another command\'s', async () => {
    const at = install();
    const said: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { said.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      expect(await main(at.root, ['help'])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(said.join('')).toContain('The host takes one client at a time, so doctor\'s connection to it closes another command\'s.');
  });
});
