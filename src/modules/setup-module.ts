import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '@animalabs/agent-framework';
import {
  PROVIDER_SECRETS, StoredSecrets, isSecretName, readEnvFile, redactWindow, secretValues, unwritableValue,
  withoutSecrets, writeEnvValue, EnvFormError, EnvLinkError, envForm, envLink, type Secret,
} from '../setup/secrets.js';
import { checkDiscordToken, type TokenCheck } from '../setup/discord-token.js';
import { unknownToolResult } from './unknown-tool.js';

export interface SecretAsker {
  /** The value the person typed, or null when they declined or the terminal closed. */
  ask(name: string, purpose: string): Promise<string | null>;
}

export interface SetupModuleConfig {
  /** The install's working directory: where commands run, where .env is, and where setup keeps .setup/. */
  dir: string;
  /** The environment commands start from, before the secrets are taken out. */
  env: Record<string, string | undefined>;
  /** The terminal to ask on, once readline mode has one. */
  asker: () => SecretAsker | null;
  /** Shows the person a line on the terminal the host runs in. */
  show: (line: string) => void;
  /** How a DISCORD_TOKEN is checked with Discord: the global fetch unless given. */
  fetch?: typeof fetch;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;
// Each stream's head and tail, so both streams' together, with what the answer adds, stay under agent-framework
// 0.27.0's 24,000-character cap for a tool result's inline text (DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS), past which it
// cuts the answer, and stderr's tail with it, for ordinary output: one dense in what JSON escapes, or in short
// secrets under long names, can still pass it.
const KEPT_BYTES = 4 * 1024;
const KILL_GRACE_MS = 5_000;
const DRAIN_MS = 1_000;

interface Stream {
  bytes: number;
  text: string;
  cut: boolean;
}

function isContinuation(bytes: Buffer, at: number): boolean {
  return at < bytes.length && (bytes[at]! & 0xc0) === 0x80;
}

class Capture {
  private total = 0;
  private full: Buffer[] | null = [];
  private fullBytes = 0;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private readonly window: number;

  constructor(overlap: number) {
    this.window = KEPT_BYTES + overlap;
  }

  add(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.full) {
      this.full.push(chunk);
      this.fullBytes += chunk.length;
      if (this.fullBytes > 2 * this.window) this.full = null;
    }
    if (this.head.length < this.window) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, this.window - this.head.length)]);
    }
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > this.window) this.tail = this.tail.subarray(this.tail.length - this.window);
  }

  /** The stream whole while it's 8 KiB or less, else its first and last 4 KiB, each secret replaced by its name. A
   *  secret the cut runs through is shown whole on its side, and where that takes the two to meet, the stream comes
   *  back whole. */
  result(secrets: Secret[], replaced: Set<string>): Stream {
    const all = this.full ? Buffer.concat(this.full) : null;
    const whole = (): Stream =>
      ({ bytes: this.total, text: redactWindow(all!, 0, all!.length, secrets, replaced).text, cut: false });
    if (all && all.length <= 2 * KEPT_BYTES) return whole();
    const head = all ?? this.head;
    const tail = all ?? this.tail;
    const longest = all ? 0 : Math.max(0, ...secrets.map(({ value }) => Buffer.byteLength(value)));
    let headTo = Math.max(0, Math.min(KEPT_BYTES, head.length - longest));
    while (headTo > 0 && isContinuation(head, headTo)) headTo--;
    let tailFrom = Math.min(tail.length, Math.max(longest, tail.length - KEPT_BYTES));
    while (isContinuation(tail, tailFrom)) tailFrom++;
    const named = new Set<string>();
    const shownHead = redactWindow(head, 0, headTo, secrets, named);
    const shownTail = redactWindow(tail, tailFrom, tail.length, secrets, named);
    const hidden = this.total - shownHead.end - (tail.length - shownTail.start);
    if (hidden <= 0 && all) return whole();
    for (const name of named) replaced.add(name);
    return {
      bytes: this.total,
      text: `${shownHead.text}\n[${hidden.toLocaleString('en-US')} bytes not shown]\n${shownTail.text}`,
      cut: true,
    };
  }
}

interface Group {
  signal(signal: NodeJS.Signals): void;
  alive(): boolean;
}

// Bun runs 'exit' listeners after an uncaught error, and none after a SIGKILL or a crash of Bun itself. A listener
// for SIGHUP, SIGINT or SIGTERM takes the place of the signal's default action, which comes back once it's removed.
const running = new Set<Group>();
const ENDING_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
let watching = false;

function endRunning(): void {
  for (const group of running) group.signal('SIGKILL');
}

function onEndingSignal(signal: NodeJS.Signals): void {
  endRunning();
  for (const each of ENDING_SIGNALS) process.off(each, onEndingSignal);
  process.kill(process.pid, signal);
}

function watchHostEnd(): void {
  if (watching) return;
  watching = true;
  process.on('exit', endRunning);
  for (const signal of ENDING_SIGNALS) process.on(signal, onEndingSignal);
}

function groupOf(pid: number | undefined): Group {
  return {
    signal(signal) {
      try {
        if (pid !== undefined) process.kill(-pid, signal);
      } catch {
        // The group has gone.
      }
    },
    alive() {
      try {
        if (pid === undefined) return false;
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// What a terminal acts on, or draws as nothing or as a space, rather than showing what it is: Unicode's control and
// format characters (tab, CR, ESC, C1, the marks that reorder text, zero-width characters), its line and paragraph
// separators, each space but the ASCII one, since another looks like it while bash reads it as part of a word, the
// characters Unicode means to be drawn as nothing (Default_Ignorable_Code_Point: the variation selectors, the Hangul
// fillers, U+034F), and the blank braille cell, U+2800, which is drawn as a space.
const UNSHOWN = /(?! )[\p{Cc}\p{Cf}\p{Z}\p{Default_Ignorable_Code_Point}\u2800]/gu;

/** A line as the person is shown it: each character UNSHOWN takes as its \u escape, so nothing in it moves, hides or
 *  reorders what's shown. */
function shown(line: string): string {
  return line.replace(UNSHOWN, (character) => {
    const hex = character.codePointAt(0)!.toString(16);
    return hex.length <= 4 ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
  });
}

/** A command's lines as the person is shown them: each secret's value as its name, as in the answer, and each line
 *  as shown() gives it. */
function shownCommand(command: string, secrets: Secret[]): string[] {
  const bytes = Buffer.from(command);
  return redactWindow(bytes, 0, bytes.length, secrets, new Set()).text.split('\n').map(shown);
}

function failed(error: string): ToolResult {
  return { success: false, error, isError: true };
}

function linked(nothing: string, link: EnvLinkError): ToolResult {
  return failed(`${nothing}: ${link.message}. Asking again won't help until the person replaces the link with the file ` +
    'it leads to, if that\'s there, or takes it away; tell them so.');
}

interface Seen {
  names: Set<string>;
  values: Secret[];
}

const seenByDir = new Map<string, Seen>();

function seenIn(dir: string): Seen {
  let seen = seenByDir.get(resolve(dir));
  if (!seen) seenByDir.set(resolve(dir), (seen = { names: new Set(), values: [] }));
  return seen;
}

function addSecret(secrets: Secret[], secret: Secret): void {
  if (!secrets.some((had) => had.name === secret.name && had.value === secret.value)) secrets.push(secret);
}

export class SetupModule implements Module {
  readonly name = 'setup';
  readonly storedSecrets: StoredSecrets;
  private readonly groups = new Set<Group>();
  private stopping = false;
  private asking: Promise<unknown> = Promise.resolve();
  private readonly seen: Seen;

  constructor(private readonly config: SetupModuleConfig) {
    this.storedSecrets = new StoredSecrets(join(config.dir, '.setup'));
    this.seen = seenIn(config.dir);
  }

  async start(_ctx: ModuleContext): Promise<void> {}

  /** Stops each command still running, and each one stopped at its limit less than 5 s before: SIGTERM to its
   *  process group, and SIGKILL to each group with any of it left 5 s on. Commands asked for afterwards are refused. */
  async stop(): Promise<void> {
    this.stopping = true;
    const groups = [...this.groups];
    for (const group of groups) group.signal('SIGTERM');
    for (const until = Date.now() + KILL_GRACE_MS; groups.some((group) => group.alive()) && Date.now() < until;) {
      await new Promise((done) => setTimeout(done, 50));
    }
    for (const group of groups) if (group.alive()) group.signal('SIGKILL');
    for (const group of groups) running.delete(group);
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'run',
        description:
          `Run one command with bash -c in the install's directory, and get its exit status and output back: of an ` +
          `output longer than 8 KiB, its first and last 4 KiB, each widened to take in whole a secret a cut falls ` +
          `in, or the whole output where the two then meet. Its environment is the host's, less the stored secrets, the provider credentials and the ` +
          `providers' base URLs, and no shell startup file is read. Nothing is kept between calls but what the command ` +
          `leaves behind: a process it leaves running when it ends, before the host shuts down, keeps running, after ` +
          `the host ends too, so a ` +
          `resident's host started from a command and one its service starts later would be two hosts on one data ` +
          `directory. A command still running at its time limit, or when the host shuts down (as at /quit), is stopped: its process group gets ` +
          `SIGTERM, and SIGKILL 5 s later if any of it is left. The value of a stored secret, a provider credential or ` +
          `a provider's base URL that appears in the output as it was stored comes back as <NAME>; an encoded or split ` +
          `one isn't recognized.`,
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command line, as bash -c reads it.' },
            timeoutMs: {
              type: 'number',
              description: `Its time limit in ms: ${DEFAULT_TIMEOUT_MS} unless given, at most ${MAX_TIMEOUT_MS}.`,
            },
          },
          required: ['command'],
        },
      },
      {
        name: 'ask_secret',
        description:
          'Ask the person for a secret in this terminal, with nothing shown as they type, and store it in the ' +
          "install's .env. You get back only where it was stored, never the value. A DISCORD_TOKEN is checked with " +
          'Discord first, and one Discord refuses is not stored.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The environment variable it is stored as, such as DISCORD_TOKEN.' },
            purpose: { type: 'string', description: 'What it is and where the person finds it, shown to them as they type it.' },
          },
          required: ['name', 'purpose'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name === 'run') return this.run(call.input as { command?: unknown; timeoutMs?: unknown });
    if (call.name === 'ask_secret') {
      const turn = this.asking.then(() => this.askSecret(call.input as { name?: unknown; purpose?: unknown }));
      this.asking = turn.catch(() => {});
      return turn;
    }
    return unknownToolResult(this, call.name);
  }

  private secrets(): { names: string[]; values: Secret[] } {
    for (const name of this.storedSecrets.names()) this.seen.names.add(name);
    const names = [...PROVIDER_SECRETS, ...this.seen.names];
    for (const read of secretValues(names, join(this.config.dir, '.env'), this.config.env)) addSecret(this.seen.values, read);
    return { names, values: [...this.seen.values] };
  }

  private damaged(error: unknown, what: string): ToolResult {
    if (error instanceof EnvFormError) {
      return failed(`${what}: ${error.message}. While .env holds such a line, what Bun reads from it, and so what a ` +
        'command prints of a secret, isn\'t known, so ask the person to put that right; you can\'t, since setup--run ' +
        'runs nothing meanwhile.');
    }
    return failed(`${what}: ${(error as Error).message}. Which values are secret isn't known until it's put right, ` +
      'so ask the person to put it right; you can\'t, since setup--run runs nothing meanwhile.');
  }

  private async run(input: { command?: unknown; timeoutMs?: unknown }): Promise<ToolResult> {
    if (typeof input.command !== 'string' || input.command.trim() === '') {
      return failed('setup--run needs a command: the line to run, as bash -c reads it.');
    }
    const limit = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0 || limit > MAX_TIMEOUT_MS) {
      return failed(`setup--run's timeoutMs is a number of ms above 0 and at most ${MAX_TIMEOUT_MS}.`);
    }
    await this.asking;
    if (this.stopping) return failed('The host is stopping, so setup--run runs nothing, and calling it again won\'t change that.');
    let atLaunch: { names: string[]; values: Secret[] };
    try {
      atLaunch = this.secrets();
    } catch (error) {
      return this.damaged(error, 'setup--run ran nothing');
    }
    this.config.show(`Setup's agent runs this in ${shown(this.config.dir)}, as you. It's the whole command, each of ` +
      'its lines indented on a line of its own, and each other character a terminal would act on or hide shown as ' +
      'its \\u escape:');
    for (const line of shownCommand(input.command, atLaunch.values)) this.config.show(`  ${line}`);
    // 4 bytes more: the longest UTF-8 character, so a cut can be moved back to fall between characters.
    const overlap = Math.max(0, ...atLaunch.values.map((s) => Buffer.byteLength(s.value))) + 4;
    const out = new Capture(overlap);
    const err = new Capture(overlap);
    const env = withoutSecrets(this.config.env, [...atLaunch.names, 'BASH_ENV']);
    const child = spawn('bash', ['--norc', '-c', input.command], {
      cwd: this.config.dir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk: Buffer) => out.add(chunk));
    child.stderr!.on('data', (chunk: Buffer) => err.add(chunk));
    const group = groupOf(child.pid);
    this.groups.add(group);
    running.add(group);
    watchHostEnd();
    let stoppedAtLimit = false;
    const limitTimer = setTimeout(() => {
      stoppedAtLimit = true;
      group.signal('SIGTERM');
      setTimeout(() => {
        if (group.alive()) group.signal('SIGKILL');
        this.groups.delete(group);
        running.delete(group);
      }, KILL_GRACE_MS).unref();
    }, limit);
    let heldOpen = false;
    const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | { error: Error }>((done) => {
      child.once('error', (error) => {
        clearTimeout(limitTimer);
        this.groups.delete(group);
        running.delete(group);
        done({ error });
      });
      child.once('exit', (code, signal) => {
        clearTimeout(limitTimer);
        if (!stoppedAtLimit) {
          this.groups.delete(group);
          if (!this.stopping) running.delete(group);
        }
        const drained = setTimeout(() => {
          heldOpen = true;
          done({ code, signal });
        }, DRAIN_MS);
        child.once('close', () => {
          clearTimeout(drained);
          done({ code, signal });
        });
      });
    });
    child.stdout!.destroy();
    child.stderr!.destroy();
    if ('error' in ended) return failed(`setup--run couldn't start bash: ${ended.error.message}`);
    let secrets: Secret[];
    try {
      secrets = this.secrets().values;
    } catch (error) {
      return this.damaged(error, `setup--run's command ended (exit ${ended.code ?? ended.signal}), and its output isn't shown`);
    }
    const notes: string[] = [];
    if (stoppedAtLimit) {
      notes.push(`It was still running at its ${limit} ms limit, so its process group was sent SIGTERM, and is sent ` +
        'SIGKILL 5 s later if any of it is left. A process it started in a group of its own isn\'t stopped.');
    }
    if (heldOpen) {
      notes.push(`Its output was cut ${DRAIN_MS / 1000} s after it ended, since a process it started still holds the ` +
        'output open, and is still running.');
    }
    const replaced = new Set<string>();
    const data = {
      exitCode: ended.code,
      ...(ended.signal ? { signal: ended.signal } : {}),
      stoppedAtLimit,
      ...(heldOpen ? { outputHeldOpen: true } : {}),
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
      stdout: out.result(secrets, replaced),
      stderr: err.result(secrets, replaced),
      replaced: [] as string[],
    };
    data.replaced = [...replaced].sort();
    return { success: true, data };
  }

  private async askSecret(input: { name?: unknown; purpose?: unknown }): Promise<ToolResult> {
    const { name, purpose } = input;
    if (typeof name !== 'string' || !isSecretName(name)) {
      return failed('setup--ask_secret needs a name an environment variable can have: letters, digits and _, not starting with a digit.');
    }
    if (typeof purpose !== 'string' || purpose.trim() === '') {
      return failed('setup--ask_secret needs a purpose: what the secret is and where the person finds it.');
    }
    if (this.stopping) return failed('The host is stopping, so setup--ask_secret asks nothing, and calling it again won\'t change that.');
    const asker = this.config.asker();
    if (!asker) {
      return failed('There is no terminal here to ask the person on: setup--ask_secret asks only in the conversation ' +
        '`connectome setup discord` starts in a terminal, so calling it again here won\'t help. The person can run ' +
        'that command in a terminal.');
    }
    const envFile = join(this.config.dir, '.env');
    try {
      const link = envLink(envFile);
      if (link) return linked(`Nothing was asked, so nothing was stored as ${name}`, link);
      const outside = envForm(envFile);
      if (outside) {
        return failed(`Nothing was asked, so nothing was stored as ${name}: ${outside.message}. Ask the person to put ` +
          'that right, then call again.');
      }
      this.secrets();
    } catch (error) {
      return this.damaged(error, `Nothing was asked, so nothing was stored as ${name}`);
    }
    let value: string | null;
    try {
      value = await asker.ask(name, shown(purpose));
    } catch (error) {
      return failed(`Nothing was asked, so nothing was stored as ${name}: ${(error as Error).message}. Calling again ` +
        'won\'t change that, so tell the person why.');
    }
    if (value !== null && name === DISCORD_TOKEN) value = value.trim();
    if (value === null || value === '') {
      const spaces = name === DISCORD_TOKEN ? ', or only whitespace' : '';
      return failed(`Nothing came back from the terminal (Enter alone${spaces}, or the terminal closed), so nothing was stored as ${name}. ` +
        'If they declined, ask them in the conversation whether to try again.');
    }
    const why = unwritableValue(value);
    if (why) {
      return failed(`What the person typed for ${name} can't be stored, since ${why}, and ask_secret can't store such a ` +
        'value however it is asked. Nothing was stored. Tell them why, and ask them to check what they copied; if it\'s ' +
        'right as typed, tell them setup can\'t store it.');
    }
    let token: TokenCheck | null = null;
    if (name === DISCORD_TOKEN) {
      token = await this.checkToken(value);
      if (token.kind === 'refused') {
        return failed(`Discord refused this token (401), so nothing was stored as ${name}, and what was stored as it ` +
          'before stays as it was. Tell the person, and ask them to copy it again from their application\'s Bot page in ' +
          'the Discord Developer Portal (Reset Token there makes a new one), then call again.');
      }
      if (token.kind === 'unsendable') {
        return failed(`What the person typed for ${name} holds a character a request header can't carry, so it can't ` +
          'be a bot token, and nothing was stored. Ask them to check what they copied, then call again.');
      }
    }
    const told = token === null ? '' : tokenNote(token);
    try {
      this.storedSecrets.record(name);
    } catch (error) {
      return failed(`Nothing was stored as ${name}: ${(error as Error).message}.`);
    }
    this.seen.names.add(name);
    addSecret(this.seen.values, { name, value });
    try {
      const link = envLink(envFile);
      if (link) throw link;
      for (const replaced of secretValues([name], envFile, {})) addSecret(this.seen.values, replaced);
      writeEnvValue(envFile, name, value);
    } catch (error) {
      if (error instanceof EnvLinkError) return linked(`Nothing was stored as ${name}`, error);
      if (error instanceof EnvFormError) {
        return failed(`Nothing was stored as ${name}: ${error.message}. Ask the person to put that right, then call ` +
          'again.');
      }
      let held: boolean | null = false;
      let open = false;
      let unread = '';
      try {
        const onDisk = lstatSync(envFile, { throwIfNoEntry: false });
        open = onDisk?.isFile() === true && (onDisk.mode & 0o077) !== 0;
        held = onDisk?.isFile() === true && readEnvFile(envFile).get(name) === value;
      } catch (readError) {
        held = null;
        unread = (readError as Error).message;
      }
      const why = (error as Error).message;
      const exposed = open
        ? `. ${envFile} is open to others than this user, so ask the person to make it readable by them alone`
        : '';
      if (held === null) {
        return failed(`It isn't known whether ${name} was stored: ${why}, and ${envFile} couldn't be read after it ` +
          `to tell: ${unread}. Ask the person to make ${envFile} a file this user can read, then call again, which ` +
          'asks for the value again.');
      }
      if (!held) return failed(`Nothing was stored as ${name}: ${why}${exposed}.`);
      return { success: true, data: `stored as ${name} in ${envFile}, which holds it, though its write ended in an error: ${why}${exposed}${told}` };
    }
    return { success: true, data: `stored as ${name} in ${envFile}${told}` };
  }

  private async checkToken(value: string): Promise<TokenCheck> {
    const token = await checkDiscordToken(value, {
      fetch: this.config.fetch, asking: () => this.config.show('Checking it with Discord.'),
    });
    this.config.show(tokenLine(token));
    return token;
  }
}

const DISCORD_TOKEN = 'DISCORD_TOKEN';

function tokenLine(token: TokenCheck): string {
  switch (token.kind) {
    case 'accepted': return `Discord accepted it: the bot is ${shown(token.name)}.`;
    case 'refused': return 'Discord refused it (401): nothing was stored.';
    case 'unsendable': return 'It holds a character a request header can\'t carry, so it can\'t be a token: nothing was stored.';
    case 'answered':
      return `Discord didn't say whether it works: it answered ${token.status}` +
        `${token.said === null ? '' : ` (${shown(token.said)})`}.`;
    case 'unanswered': return `Discord couldn't be asked whether it works (${shown(token.why)}).`;
  }
}

function tokenNote(token: TokenCheck): string {
  switch (token.kind) {
    case 'accepted': return `. Discord accepted it: the bot is ${token.name} (${token.id}).`;
    case 'answered':
      return `, but it isn't known to work: Discord answered ${token.status}${token.said === null ? '' : `: ${token.said}`}.`;
    case 'unanswered': return `, but it isn't known to work: Discord couldn't be asked (${token.why}).`;
    default: return '';
  }
}
