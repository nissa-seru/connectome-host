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
const FILLER = 'filler words for the long note ';
const MORE_FILLER = 'more filler for the note ';

const rewords: SweepEntry = {
  name: NAME,
  line: LINE,
  mend: (body) => {
    if (body.metadata?.writer !== 'faulty') return null;
    if (!body.content.some((b) => b.type === 'text' && b.text.includes(OLD))) return null;
    if (body.content.some((b) => b.type === 'text' && b.text.includes('BOOM'))) throw new Error('boom');
    return body.content.map((b): StoredContentBlock =>
      b.type === 'text' ? { type: 'text', text: b.text.replaceAll(OLD, NEW).replaceAll(FILLER, '').replaceAll(MORE_FILLER, '') } : b,
    );
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
  let sweeps = [rewords, quiet];
  const boot = () => AgentFramework.create({
    storePath,
    membrane: membrane as never,
    agents: ['a', 'b'].map((name) => ({
      name, model: 'test-model', systemPrompt: `You are ${name}.`, ...(options.strategy ? { strategy: options.strategy() } : {}),
    })),
    modules: [],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
    sweeps,
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
  const restart = async (entries?: SweepEntry[]) => {
    if (entries) sweeps = entries;
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
      'The write does not change an old summary',
      'can still hold words of that text',
      'The second act drops',
      `connectome sweep ${NAME} --summaries AGENT --write`,
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
    const lines = said.text.split('\n');
    const under: string[] = [];
    for (let i = lines.findIndex((each) => each.endsWith('not rewritten:')) + 1; i > 0 && lines[i]?.startsWith('- '); i++) under.push(lines[i]!);
    expect(under).toEqual([line]);
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
    const written = await h.sweep(NAME, '--write');
    expect(written.text).toContain('can still hold words of the old text');
    expect(written.text).toContain('Until it has, its context holds those rows in full, and its turn can wait until then.');
    expect(written.text).not.toContain('full room');
    expect((await h.sweep(NAME)).text).toContain('can still hold words of the old text');
    const cost = h.framework().oldSummaryCost(NAME, 'a');
    const before = h.sequence();
    const costSaid = await h.sweep(NAME, '--summaries', 'a');
    expect(h.sequence()).toBe(before);
    expect(costSaid.refused).toBe(false);
    expect(costSaid.text).toContain(`would drop ${total(cost.summaries)} old`);
    expect(costSaid.text).toContain(`${cost.records} chunk record`);
    expect(costSaid.text).toContain(`Until it has, a's context holds about ${cost.rawTokens.toLocaleString('en-US')} tokens of rows in full, and ` +
      "a's turn can wait until then.");
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
    expect(dropped.text).toContain(`Until it has, a's context holds about ${cost.rawTokens.toLocaleString('en-US')} tokens of rows in full, and ` +
      "a's turn can wait until then.");
    expect(dropped.text).not.toContain('full room');
    expect(total(h.framework().oldSummaryCost(NAME, 'a').summaries)).toBe(0);
    expect(total(h.framework().oldSummaryCost(NAME, 'b').summaries)).toBe(otherBefore);
  });

  test('a taken sweep whose entry this host no longer has still has its second act, though the list does not name it', async () => {
    const h = await foldedPair();
    await h.sweep(NAME, '--write');
    await h.restart([quiet]);
    const left = total(h.framework().oldSummaryCost(NAME, 'a').summaries);
    expect(left).toBeGreaterThan(0);
    const cost = await h.sweep(NAME, '--summaries', 'a');
    expect(cost.refused).toBe(false);
    expect(cost.text).toContain(`would drop ${left} old`);
    expect(entryOf((await h.sweep()).text, NAME)).toBe('');
    const dropped = await h.sweep(NAME, '--summaries', 'a', '--write');
    expect(dropped.refused).toBe(false);
    expect(total(h.framework().oldSummaryCost(NAME, 'a').summaries)).toBe(0);
  });
});

describe('/sweep, a write that joins a long note', () => {
  async function foldedLongNote(residents: readonly string[] = ['a']) {
    const h = await host({ strategy: () => new AutobiographicalStrategy({ ...FOLD, adaptiveResolution: true }) });
    for (let i = 0; i < 3; i++) h.cm('a').addMessage('User', text(`before ${i}`));
    h.note(`LONG ${FILLER.repeat(120)}${OLD} in the middle ${MORE_FILLER.repeat(120)}end of LONG`);
    for (let i = 0; i < 4; i++) h.cm('a').addMessage('User', text(`chat ${i} ${'words '.repeat(60)}`));
    const all = h.cm('a').getAllMessages().map((m) => m.id);
    for (const agent of residents) {
      const cm = h.cm(agent);
      h.present(agent, all.filter((id) => !cm.getPresentedMessages().some((m) => m.id === id)));
      await cm.compile(BIG);
      for (let i = 0; i < 300 && !cm.isReady(); i++) await cm.tick();
    }
    return h;
  }
  const total = (levels: readonly { count: number }[]) => levels.reduce((sum, each) => sum + each.count, 0);

  test('the show gives, for each agent, what the write itself would drop, and before a write it says in plain words what a join does, with the count', async () => {
    const h = await foldedLongNote();
    const drops = h.framework().showSweep(NAME).writeDrops;
    const a = drops.find((each) => each.agent === 'a')!.drops;
    expect(total(a.summaries)).toBeGreaterThan(0);
    const shown = (await h.sweep(NAME)).text;
    expect(shown).toContain('What the write itself would drop, by agent: ');
    const line = shown.split('\n').find((each) => each.startsWith('What the write itself would drop, by agent: ')) ?? '';
    expect(line).toContain(`a: ${total(a.summaries)} (`);
    expect(line).toContain(`${a.records} chunk record`);
    expect(line).toContain(`again; until it has, a's context holds about ${a.rawTokens.toLocaleString('en-US')} tokens of rows in full`);
    for (const { agent, drops: each } of drops) if (total(each.summaries) === 0) expect(line).toContain(`${agent}: none`);
    const sum = drops.reduce((n, each) => n + total(each.drops.summaries), 0);
    expect(shown).toContain(`- The write joins a long note: it drops ${sum} ${sum === 1 ? 'summary' : 'summaries'} of that note at once, and each summary made from them.`);
    expect(shown).toContain("- a's turn can wait until its compression has folded those rows again.");
    expect(shown).not.toContain("b's turn can wait");
    expect(shown).not.toContain('full room');
    expect(shown).toContain('- The same happens on each other branch when the host moves to it, and nobody is shown a count there.');

    const written = (await h.sweep(NAME, '--write')).text;
    const told = written.split('\n').find((each) => each.startsWith('- a dropped ')) ?? '';
    expect(told).toStartWith(`- a dropped ${total(a.summaries)} ${total(a.summaries) === 1 ? 'summary' : 'summaries'} at its own pass (`);
    expect(told).not.toContain('The show before the write counted');
    expect(told).toContain(`its compression folds ${a.records} chunk record`);
    expect(told).toContain(`and until it has, a's context holds about ${a.rawTokens.toLocaleString('en-US')} tokens of rows in full.`);
    expect(written).not.toContain('full room');
    expect(written).not.toContain('- b dropped ');
    expect(written).not.toContain('is not known');
  });

  test('where two residents drop, the wait line names both', async () => {
    const h = await foldedLongNote(['a', 'b']);
    const drops = h.framework().showSweep(NAME).writeDrops;
    if (drops.some(({ drops: each }) => total(each.summaries) === 0)) throw new Error(`premise: a and b both drop, ${JSON.stringify(drops)}`);
    const shown = (await h.sweep(NAME)).text;
    expect(shown).toContain('- The turns of a and b can wait until their compression has folded those rows again.');
  });

  test('after a write, an agent whose own pass dropped less than the show counted for it gets both numbers, and the reason as what can happen', async () => {
    const h = await foldedLongNote(['a', 'b']);
    const counted = new Map(h.framework().showSweep(NAME).writeDrops.map(({ agent, drops }) => [agent, total(drops.summaries)]));
    const written = (await h.sweep(NAME, '--write')).text;
    const lines = new Map(['a', 'b'].map((agent) => [agent, written.split('\n').find((each) => each.startsWith(`- ${agent} dropped `)) ?? '']));
    const own = (agent: string) => {
      const said = /^- \w+ dropped (no|\d+) summar/.exec(lines.get(agent)!)?.[1];
      return said === undefined ? -1 : said === 'no' ? 0 : Number(said);
    };
    for (const agent of ['a', 'b']) expect(lines.get(agent)).toContain(' at its own pass');
    if (own('b') >= counted.get('b')! || own('a') !== counted.get('a')) {
      throw new Error(`premise: b's own pass drops less than its show, a's as many, ${JSON.stringify([...counted])} ${written}`);
    }
    expect(lines.get('b')).toEndWith(`The show before the write counted ${counted.get('b')} for b: a pass of another agent on the same slot can ` +
      'drop an agent\'s summaries before its own pass runs.');
    expect(lines.get('a')).not.toContain('The show before the write counted');
  });

  test('where the write joins no long note, the show says none for each agent, and nothing of a join', async () => {
    const h = await host();
    h.note(`one ${OLD}`);
    for (const agent of ['a', 'b']) h.present(agent, h.cm('a').getAllMessages().map((m) => m.id));
    const shown = (await h.sweep(NAME)).text;
    expect(shown).toContain('What the write itself would drop, by agent: a: none; b: none.');
    expect(shown).not.toContain('joins a long note');
    expect(shown).not.toContain('nobody is shown a count there');
    const written = (await h.sweep(NAME, '--write')).text;
    expect(written).toContain('the open branch has finished it');
    expect(written).not.toContain(' at its own pass');
    expect(written).not.toContain('is not known');
  });

  test('after a write, a pass whose report does not say what it dropped is said to have a drop that is not known', async () => {
    class Untold extends AutobiographicalStrategy {
      override beforeSweepPass(): () => never {
        return () => {
          throw new Error('untold');
        };
      }
    }
    const h = await host({ strategy: () => new Untold({ ...FOLD }) });
    h.note(`one ${OLD}`);
    const written = await h.sweep(NAME, '--write');
    expect(written.text).toContain('the open branch has finished it');
    for (const agent of ['a', 'b']) expect(written.text).toContain(`- What ${agent}'s pass dropped is not known: its report doesn't say.`);
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
