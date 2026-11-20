import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import { AutobiographicalStrategy } from '@animalabs/context-manager';
import type { ContextManager, ContextStrategy, MessageId, StoredContentBlock, SweepEntry } from '@animalabs/context-manager';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { createBranchState, handleCommand, type CommandResult } from '../src/commands.js';

// The sweep's door in the host: /sweep asks the framework's sweep verbs and
// says what they give.
// Each test boots a real framework on a store of its own, with two entries
// that the host's configuration adds.

const OLD = 'OLDWORDS';
const NEW = 'NEWWORDS';
const NAME = 'rewords-test';
const LINE = 'mends the old words in the faulty test writer\'s notes';
const QUIET = 'quiet-test';

const rewords: SweepEntry = {
  name: NAME,
  line: LINE,
  mend: (body) => {
    if (body.metadata?.writer !== 'faulty') return null;
    if (!body.content.some((b) => b.type === 'text' && b.text.includes(OLD))) return null;
    if (body.content.some((b) => b.type === 'text' && b.text.includes('BOOM'))) throw new Error('boom');
    return body.content.map((b): StoredContentBlock => (b.type === 'text' ? { type: 'text', text: b.text.replaceAll(OLD, NEW) } : b));
  },
};
const quiet: SweepEntry = { name: QUIET, line: 'mends nothing', mend: () => null };

const text = (t: string) => [{ type: 'text' as const, text: t }];
const textOf = (blocks: readonly { type: string; text?: string }[]): string => blocks.map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('');

function reply(t: string): NormalizedResponse {
  return {
    content: text(t), stopReason: 'end_turn', rawAssistantText: t, toolCalls: [], toolResults: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    details: { raw: {}, stop: { reason: 'end_turn', wasTruncated: false }, model: { requested: 'test-model', actual: 'test-model' } },
  } as unknown as NormalizedResponse;
}

// Turns stream an answer, and one can be held mid-stream so that its turn
// stays alive. Compression's calls (complete) give a summary that says
// whether the rows it folds hold the old words.
function provider() {
  let held: { system: string; released: Promise<void>; started: () => void } | undefined;
  let summaries = 0;
  const stream = (response: NormalizedResponse, wait?: Promise<void>): YieldingStream => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
      if (wait) await wait;
      const t = response.rawAssistantText;
      yield { type: 'block', event: { event: 'block_start', index: 0, block: { type: 'text' } } } as StreamEvent;
      yield { type: 'tokens', content: t, meta: { type: 'text', visible: true, blockIndex: 0 } } as StreamEvent;
      yield { type: 'block', event: { event: 'block_complete', index: 0, block: { type: 'text', content: t } } } as StreamEvent;
      yield { type: 'usage', usage: response.usage } as StreamEvent;
      yield { type: 'complete', response } as StreamEvent;
    },
    provideToolResults() { throw new Error('Not waiting for tools'); },
    cancel() {},
    isWaitingForTools: false,
    pendingToolCallIds: [],
  } as unknown as YieldingStream);
  const membrane = {
    async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
      summaries += 1;
      const texts = request.messages.map((m) => textOf(m.content as { type: string; text?: string }[]));
      let marker = -1;
      for (let i = 0; i < texts.length; i++) if (texts[i]!.startsWith('System: You will soon form a new memory')) marker = i;
      const folded = (marker === -1 ? texts : texts.slice(marker + 1, -1)).join('\n');
      return reply(`[summary ${summaries} ${folded.includes(OLD) ? OLD : ''}] ${'mem '.repeat(20)}`);
    },
    async stream(): Promise<NormalizedResponse> { return reply('done'); },
    streamYielding(request: NormalizedRequest): YieldingStream {
      if (held && JSON.stringify(request.system ?? '').includes(held.system)) {
        const { released, started } = held;
        held = undefined;
        started();
        return stream(reply('answers late'), released);
      }
      return stream(reply('answers'));
    },
  };
  const holdFor = (system: string) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const streaming = new Promise<void>((resolve) => { started = resolve; });
    held = { system, released, started };
    return { streaming, release };
  };
  return { membrane, holdFor };
}

const FOLD = {
  compressionModel: 'mock',
  targetChunkTokens: 50,
  headWindowTokens: 0,
  recentWindowTokens: 0,
  autoTickOnNewMessage: false,
  minChunkCharsForLLM: 0,
  l1HoldbackChunks: 0,
  hierarchical: false,
} as const;
const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };

setDefaultTimeout(60_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const each of cleanups.splice(0).reverse()) await each(); });

interface Said { text: string; refused: boolean; held: boolean }

async function answered(result: CommandResult): Promise<Said> {
  const lines = [...result.lines];
  let last: CommandResult = result;
  if (result.asyncWork) {
    last = await result.asyncWork;
    lines.push(...last.lines);
  }
  return { text: lines.map((line) => line.text).join('\n'), refused: last.refused === true, held: 'held' in last && last.held === true };
}

async function host(options: { strategy?: () => ContextStrategy; sessions?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-command-'));
  const storePath = join(dir, 'store');
  const { membrane, holdFor } = provider();
  const boot = () => AgentFramework.create({
    storePath,
    membrane: membrane as never,
    agents: ['a', 'b'].map((name) => ({
      name, model: 'test-model', systemPrompt: `You are ${name}.`, ...(options.strategy ? { strategy: options.strategy() } : {}),
    })),
    modules: [],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
    sweeps: [rewords, quiet],
  });
  let framework = await boot();
  cleanups.push(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  const sessions = Array.from({ length: options.sessions ?? 1 }, (_, i) => ({ id: `s${i}`, name: `session ${i}` }));
  const app = {
    framework, branchState: createBranchState(), agentName: 'a', switching: false,
    sessionManager: { listSessions: () => sessions, getActiveSession: () => sessions[0], findSession: () => sessions[0] },
  };
  const cm = (agent: string): ContextManager => framework.getAgent(agent)!.getContextManager();
  const note = (words: string, metadata: Record<string, unknown> = {}): MessageId =>
    cm('a').addMessage('system', text(words), { writer: 'faulty', ...metadata });
  const present = (agent: string, ids: MessageId[]) => { cm(agent).presentRows(ids); };
  const sequence = () => cm('a').getStore().currentSequence();
  const timeOf = (id: MessageId) => new Date(cm('a').getMessage(id)!.timestamp).toISOString();
  const sweep = (...words: string[]) => answered(handleCommand(['/sweep', ...words].join(' '), app as never, {
    requester: { via: 'test' }, typed: 'connectome',
  }));
  const restart = async () => {
    await framework.stop();
    framework = await boot();
    app.framework = framework;
  };
  return { app, framework: () => framework, cm, note, present, sequence, timeOf, sweep, restart, holdFor };
}

/** The lines of one entry in the bare list: its own line and the lines under it. */
function entryOf(said: string, name: string): string {
  const lines = said.split('\n');
  const at = lines.findIndex((line) => line.startsWith(`- ${name}:`));
  if (at === -1) return '';
  const end = lines.findIndex((line, i) => i > at && line.startsWith('- '));
  return lines.slice(at, end === -1 ? undefined : end).join('\n');
}

function folded(entry: string, state: string, change: number, refuse: number): void {
  expect(entry).toContain(`State: ${state}.`);
  expect(entry).toContain(`Bodies it would change now: ${change}.`);
  expect(entry).toContain(`Bodies the store would refuse: ${refuse}.`);
}

describe('/sweep, the list of entries', () => {
  test('it names each entry with its line, and tells not taken from taken and not finished here, with the counts, also on a later run', async () => {
    const h = await host();
    h.note(`first ${OLD}`);
    const boom = h.note(`BOOM ${OLD}`);
    let said = await h.sweep();
    expect(said.refused).toBe(false);
    expect(entryOf(said.text, NAME)).toStartWith(`- ${NAME}: ${LINE}`);
    folded(entryOf(said.text, NAME), 'not taken', 1, 1);
    folded(entryOf(said.text, QUIET), 'not taken', 0, 0);

    const write = await h.sweep(NAME, '--write');
    expect(write.refused).toBe(true);
    expect(write.text).toContain(`- Body ${boom}: `);

    said = await h.sweep();
    folded(entryOf(said.text, NAME), 'taken, not finished here', 0, 1);
    folded(entryOf(said.text, QUIET), 'not taken', 0, 0);
    await h.restart();
    said = await h.sweep();
    folded(entryOf(said.text, NAME), 'taken, not finished here', 0, 1);
  });

  test('a finished branch says finished here, also on a later run, and a new body that the entry changes is counted and mended by --write', async () => {
    const h = await host();
    h.note(`first ${OLD}`);
    const write = await h.sweep(NAME, '--write');
    expect({ refused: write.refused, held: write.held }).toEqual({ refused: false, held: false });
    folded(entryOf((await h.sweep()).text, NAME), 'finished here', 0, 0);
    await h.restart();
    folded(entryOf((await h.sweep()).text, NAME), 'finished here', 0, 0);

    const later = h.note(`later ${OLD}`);
    folded(entryOf((await h.sweep()).text, NAME), 'finished here', 1, 0);
    const again = await h.sweep(NAME, '--write');
    expect({ refused: again.refused, held: again.held }).toEqual({ refused: false, held: false });
    expect(textOf(h.cm('a').getMessage(later)!.content)).toBe(`later ${NEW}`);
    folded(entryOf((await h.sweep()).text, NAME), 'finished here', 0, 0);
  });
});

describe('/sweep NAME, the show', () => {
  test('it gives each body by id, time, the agents whose window holds it, its lengths and its new text, never the old text, and writes nothing', async () => {
    const h = await host();
    const first = h.note(`first ${OLD} one`);
    await Bun.sleep(5);
    const second = h.note(`second ${OLD} two`);
    h.note(`other ${OLD}`, { writer: 'someone' });
    expect(h.timeOf(first) < h.timeOf(second)).toBe(true);
    h.present('a', [first, second]);
    h.present('b', [second]);
    const before = h.sequence();
    const said = await h.sweep(NAME);
    expect(h.sequence()).toBe(before);
    expect(said.refused).toBe(false);
    expect(said.text).not.toContain(OLD);
    const lineOf = (id: MessageId) => said.text.split('\n').find((line) => line.startsWith(`- Body ${id} `)) ?? '';
    expect(lineOf(first)).toContain(h.timeOf(first));
    expect(lineOf(first)).toContain('in the window of a:');
    expect(lineOf(first)).toContain(`${`first ${OLD} one`.length} characters now, ${`first ${NEW} one`.length} after`);
    expect(lineOf(first)).toContain(`Its new text: first ${NEW} one`);
    expect(lineOf(second)).toContain('in the window of a and b:');
    expect(said.text).toContain('State: not taken.');
    expect(said.text).toContain(`a from ${h.timeOf(first)}`);
    expect(said.text).toContain(`b from ${h.timeOf(second)}`);
  });

  test('beside the list it says what a write does and does not do, how to start the second act, and what a sweep does not reach', async () => {
    const h = await host({ sessions: 2 });
    h.note(`first ${OLD}`);
    const said = await h.sweep(NAME);
    for (const words of [
      'The list is of the open branch, and a take is for the whole store',
      'An ended agent\'s own rows are not in the list',
      'No command takes a take back.',
      'prompt cache is rewritten once',
      'The write does not change an old summary.',
      `connectome sweep ${NAME} --summaries AGENT`,
      'What a sweep does not reach:',
      'conversation fork\'s seed',
      'The framework\'s log of requests already sent',
      'Anything outside the store, but the search index',
      'A summary of other rows',
      'This host has 1 other session',
    ]) expect(said.text).toContain(words);
  });

  test('a taken sweep\'s show gives the receipt: each pass on the open branch with its time, and each body it listed by id, writer and time', async () => {
    const h = await host();
    const first = h.note(`first ${OLD}`);
    const second = h.note(`second ${OLD}`);
    await h.sweep(NAME, '--write');
    const receipt = h.framework().sweepReceipt(NAME);
    expect(receipt.passes.length).toBeGreaterThan(0);
    const said = await h.sweep(NAME);
    expect(said.text).toContain(`State: taken at ${receipt.take!.at}, finished here.`);
    for (const pass of receipt.passes) expect(said.text).toContain(pass.at);
    for (const id of [first, second]) expect(said.text).toContain(`${id} by system of ${h.timeOf(id)}`);
    expect(said.text).not.toContain(OLD);
  });
});

describe('/sweep NAME --write', () => {
  test('a take while a turn is alive ends held, neither finished nor failed, applies nothing, and the same command between turns applies it', async () => {
    const h = await host();
    const id = h.note(`first ${OLD}`);
    const turn = h.holdFor('You are b.');
    cleanups.push(async () => { turn.release(); });
    h.framework().nudgeAgent('b', 'test');
    const running = h.framework().runUntilIdle();
    await turn.streaming;
    const held = await h.sweep(NAME, '--write');
    expect({ refused: held.refused, held: held.held }).toEqual({ refused: false, held: true });
    expect(held.text).toContain('nothing is applied yet');
    expect(textOf(h.cm('a').getMessage(id)!.content)).toBe(`first ${OLD}`);
    folded(entryOf((await h.sweep()).text, NAME), 'taken, not finished here', 1, 0);
    turn.release();
    await running;
    const applied = await h.sweep(NAME, '--write');
    expect({ refused: applied.refused, held: applied.held }).toEqual({ refused: false, held: false });
    expect(textOf(h.cm('a').getMessage(id)!.content)).toBe(`first ${NEW}`);
  });

  test('a write that leaves a body ends refused, names each body not rewritten with why, and mends the rest', async () => {
    const h = await host();
    const fine = h.note(`fine ${OLD}`);
    const boom = h.note(`BOOM ${OLD}`);
    const said = await h.sweep(NAME, '--write');
    expect({ refused: said.refused, held: said.held }).toEqual({ refused: true, held: false });
    const line = said.text.split('\n').find((each) => each.startsWith(`- Body ${boom}: `)) ?? '';
    expect(line).toContain('Error');
    expect(textOf(h.cm('a').getMessage(fine)!.content)).toBe(`fine ${NEW}`);
  });

  test('a write is refused while a session switch is under way, and takes nothing', async () => {
    const h = await host();
    h.note(`first ${OLD}`);
    h.app.switching = true;
    const said = await h.sweep(NAME, '--write');
    expect(said.text).toContain('a session switch is under way');
    expect(h.framework().sweepReceipt(NAME).take).toBeNull();
  });
});

describe('/sweep, the old summaries and the second act', () => {
  async function foldedPair() {
    const h = await host({ strategy: () => new AutobiographicalStrategy({ ...FOLD }) });
    h.note(`first ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) h.cm('a').addMessage('User', text(`chat ${i} ${'words '.repeat(60)}`));
    const all = h.cm('a').getAllMessages().map((m) => m.id);
    for (const agent of ['a', 'b']) {
      h.present(agent, all.filter((id) => !h.cm(agent).getPresentedMessages().some((m) => m.id === id)));
      const cm = h.cm(agent);
      await cm.compile(BIG);
      for (let i = 0; i < 300 && !cm.isReady(); i++) await cm.tick();
      const compiled = (await cm.compile(BIG)).messages.map((m) => textOf(m.content as { type: string; text?: string }[])).join('\n');
      expect(compiled).toMatch(new RegExp(`\\[summary \\d+ ${OLD}`));
    }
    return h;
  }
  const total = (levels: readonly { count: number }[]) => levels.reduce((sum, each) => sum + each.count, 0);

  test('the show counts each agent\'s old summaries; --summaries gives the second act\'s cost and writes nothing; its --write is refused while a turn is alive, then drops that agent\'s alone', async () => {
    const h = await foldedPair();
    const shown = await h.sweep(NAME);
    for (const each of h.framework().showSweep(NAME).oldSummaries) {
      expect(total(each.summaries)).toBeGreaterThan(0);
      expect(shown.text).toContain(`${each.agent}: ${total(each.summaries)} (`);
    }
    await h.sweep(NAME, '--write');
    const cost = h.framework().oldSummaryCost(NAME, 'a');
    const before = h.sequence();
    const costSaid = await h.sweep(NAME, '--summaries', 'a');
    expect(h.sequence()).toBe(before);
    expect(costSaid.refused).toBe(false);
    expect(costSaid.text).toContain(`would drop ${total(cost.summaries)} old`);
    expect(costSaid.text).toContain(`${cost.records} chunk record`);
    expect(costSaid.text).toContain(`${cost.rawTokens.toLocaleString('en-US')} tokens`);
    expect(costSaid.text).toContain(`connectome sweep ${NAME} --summaries a --write`);

    const turn = h.holdFor('You are b.');
    cleanups.push(async () => { turn.release(); });
    h.framework().nudgeAgent('b', 'test');
    const running = h.framework().runUntilIdle();
    await turn.streaming;
    const refused = await h.sweep(NAME, '--summaries', 'a', '--write');
    expect({ refused: refused.refused, held: refused.held }).toEqual({ refused: true, held: false });
    expect(h.framework().oldSummaryCost(NAME, 'a')).toEqual(cost);
    turn.release();
    await running;

    const otherBefore = total(h.framework().oldSummaryCost(NAME, 'b').summaries);
    const dropped = await h.sweep(NAME, '--summaries', 'a', '--write');
    expect(dropped.refused).toBe(false);
    expect(dropped.text).toContain(`dropped ${total(cost.summaries)} old`);
    expect(total(h.framework().oldSummaryCost(NAME, 'a').summaries)).toBe(0);
    expect(total(h.framework().oldSummaryCost(NAME, 'b').summaries)).toBe(otherBefore);
  });
});

describe('/sweep, refusals', () => {
  test('a name this host has no entry of is refused, and the answer names the sweeps it has', async () => {
    const h = await host();
    const said = await h.sweep('no-such-sweep');
    expect(said.refused).toBe(true);
    expect(said.text).toContain('no-such-sweep');
    expect(said.text).toContain(NAME);
    expect(said.text).toContain(QUIET);
    for (const words of [['no-such-sweep', '--write'], ['no-such-sweep', '--summaries', 'a']]) {
      const write = await h.sweep(...words);
      expect(write.refused).toBe(true);
    }
    expect(h.framework().sweepReceipt('no-such-sweep').take).toBeNull();
  });

  test('an agent that is not live, and words /sweep does not take, are refused', async () => {
    const h = await host();
    expect((await h.sweep(NAME, '--summaries', 'nobody')).refused).toBe(true);
    for (const words of [[NAME, '--bogus'], [NAME, '--summaries'], [NAME, '--write', 'extra'], [NAME, '--summaries', 'a', '--bogus'],
      [NAME, '--summaries', 'a', '--write', 'extra']]) {
      const said = await h.sweep(...words);
      expect(said.refused).toBe(true);
      expect(said.text).toContain('Usage: connectome sweep');
    }
  });
});
