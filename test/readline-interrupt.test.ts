import { afterEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readEnvFile } from '../src/setup/secrets.js';

const INDEX = resolve(import.meta.dir, '..', 'src', 'index.ts');

const dirs: string[] = [];
const hosts: ChildProcess[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    if (host.exitCode !== null || host.signalCode !== null) continue;
    const exited = new Promise<void>((done) => host.once('exit', () => done()));
    host.kill('SIGKILL');
    await exited;
  }
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(25);
  }
}

test.skipIf(process.platform !== 'linux')(
  'in readline mode, a Ctrl-C while a turn waits on its model ends the host by its own shutdown, with exit 0 and no error (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-interrupt-'));
    dirs.push(dir);
    let turns = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === '/v1/messages/count_tokens') return Response.json({ input_tokens: 10 });
        if (pathname !== '/v1/messages') return new Response('not found', { status: 404 });
        turns += 1;
        return new Promise<Response>((done) => {
          request.signal.addEventListener('abort', () => done(new Response('aborted', { status: 499 })));
        });
      },
    });
    servers.push(server);
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({
      name: 'Readline interrupt',
      agent: { name: 'readline', model: 'claude-opus-5-5', systemPrompt: 'Answer briefly.' },
      modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    }));
    const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => name !== 'MODEL' && !/^(ANTHROPIC|OPENAI|OPENROUTER|BEDROCK|AWS|CODEX|CONNECTOME)_/.test(name)));
    Object.assign(env, {
      ANTHROPIC_API_KEY: 'sk-ant-readline-interrupt',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      DATA_DIR: join(dir, 'data'),
      TERM: 'xterm-256color',
    });
    const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
    const command = `stty cols 120 rows 40; exec ${[process.execPath, INDEX, recipe, '--no-tui'].map(quote).join(' ')}`;
    const host = spawn('script', ['-qfec', command, '/dev/null'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    hosts.push(host);
    let output = '';
    host.stdout!.on('data', (chunk) => { output += String(chunk); });
    host.stderr!.on('data', (chunk) => { output += String(chunk); });
    const exit = new Promise<number | null>((done) => host.once('close', (code) => done(code)));

    await until(() => output.includes('(readline mode)'), 60_000, `the host's readline prompt (output: ${output.slice(-1500)})`);
    host.stdin!.write('hello\r');
    await until(() => turns > 0, 30_000, `the turn's request (output: ${output.slice(-1500)})`);
    host.stdin!.write('\x03');

    expect(await exit).toBe(0);
    expect(output).toContain('Shutting down...');
    expect(output).not.toContain('ERR_USE_AFTER_CLOSE');
  },
  120_000,
);

const sse = (events: Array<Record<string, unknown> & { type: string }>): Response =>
  new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });

const reply = (id: string, stop: string, block: Record<string, unknown>, delta: Record<string, unknown>): Response => sse([
  { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: block },
  { type: 'content_block_delta', index: 0, delta },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
]);

test.skipIf(process.platform !== 'linux')(
  'in readline mode, setup--ask_secret asks on the host\'s own terminal without echoing what is typed, and stores it (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-secret-'));
    dirs.push(dir);
    const bodies: Array<{ tools?: Array<{ name: string }>; messages: unknown[] }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === '/v1/messages/count_tokens') return Response.json({ input_tokens: 10 });
        if (pathname !== '/v1/messages') return new Response('not found', { status: 404 });
        const body = await request.json() as (typeof bodies)[number];
        bodies.push(body);
        const tool = body.tools?.find((each) => each.name.endsWith('ask_secret'))?.name;
        if (bodies.length === 1 && tool) {
          return reply('msg_ask', 'tool_use', { type: 'tool_use', id: 'toolu_ask', name: tool, input: {} },
            { type: 'input_json_delta', partial_json: JSON.stringify({ name: 'TEST_SECRET', purpose: 'a test secret' }) });
        }
        return reply(`msg_${bodies.length}`, 'end_turn', { type: 'text', text: '' }, { type: 'text_delta', text: 'Stored.' });
      },
    });
    servers.push(server);
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({
      name: 'Readline secret',
      agent: { name: 'readline', model: 'claude-opus-5-5', systemPrompt: 'Answer briefly.', allowedTools: ['setup--ask_secret'] },
      modules: { setup: true, subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    }));
    const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => name !== 'MODEL' && !/^(ANTHROPIC|OPENAI|OPENROUTER|BEDROCK|AWS|CODEX|CONNECTOME)_/.test(name)));
    Object.assign(env, {
      ANTHROPIC_API_KEY: 'sk-ant-readline-secret',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      DATA_DIR: join(dir, 'data'),
      CONNECTOME_SETUP_DIR: dir,
      TERM: 'xterm-256color',
    });
    const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
    const command = `stty cols 120 rows 40; exec ${[process.execPath, INDEX, recipe, '--no-tui'].map(quote).join(' ')}`;
    const host = spawn('script', ['-qfec', command, '/dev/null'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    hosts.push(host);
    let output = '';
    host.stdout!.on('data', (chunk) => { output += String(chunk); });
    host.stderr!.on('data', (chunk) => { output += String(chunk); });
    const exit = new Promise<number | null>((done) => host.once('close', (code) => done(code)));

    await until(() => output.includes('(readline mode)'), 60_000, `the host's readline prompt (output: ${output.slice(-1500)})`);
    host.stdin!.write('store a secret\r');
    await until(() => output.includes('TEST_SECRET (a test secret), typed hidden'), 30_000,
      `the hidden question (requests: ${bodies.length}; output: ${output.slice(-1500)})`);
    host.stdin!.write('the-typed-value\r');
    await until(() => bodies.length >= 2, 30_000, `the turn's next request (output: ${output.slice(-1500)})`);

    expect(JSON.stringify(bodies[1]!.messages)).toContain(`stored as TEST_SECRET in ${join(dir, '.env')}`);
    expect(readEnvFile(join(dir, '.env')).get('TEST_SECRET')).toBe('the-typed-value');
    expect(output).not.toContain('the-typed-value');
    host.stdin!.write('/quit\r');
    expect(await exit).toBe(0);
  },
  120_000,
);
