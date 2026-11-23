import {
  OperatorActionError, type AgentFramework, type AgentOldSummaries, type AgentSweepPass, type AgentWriteDrops,
  type FrameworkSweepReceipt,
  type FrameworkSweepShow, type FrameworkSweepWrite, type OperatorRequester,
} from '@animalabs/agent-framework';
import type { SummaryDropCost, SummaryLevelCount, StoredContentBlock } from '@animalabs/context-manager';
import type { CommandResult } from './commands.js';
import { SWEEP_WORDS, sweepAsk } from './sweep-words.js';

/**
 * What /sweep is asked with: the framework whose sweep verbs it calls, who
 * asks, and the command as its reader types it (`/sweep`, or the install's
 * `connectome sweep`), so that each command the answer gives can be typed as
 * it reads. `outside` gives the stores that the open session's run doesn't
 * reach, which a show names.
 */
export interface SweepAsked {
  framework: AgentFramework;
  requester: OperatorRequester;
  command: string;
  outside(): { otherSessions: number; fleetChildren: string[] };
}

/**
 * The sweep's door, the operator's command for the framework's sweeps. With
 * no name it lists the framework's sweeps and where each stands on the open
 * branch. With a name it shows what the sweep would change, and for a taken
 * sweep its receipt; `--write` takes and applies it, and `--summaries AGENT`
 * gives the cost of the second act for that agent, which `--write` makes. An
 * answer that didn't do what was asked is marked refused, and a take that the
 * store applies later is marked held.
 */
export function handleSweep(words: readonly string[], asked: SweepAsked): CommandResult {
  const ask = sweepAsk(words);
  if (ask === null) return refused([`Usage: ${asked.command} ${SWEEP_WORDS}`]);
  const { framework } = asked;
  const entries = framework.listSweeps();
  if (ask.kind === 'list') return said(listLines(framework, entries));
  if (ask.kind === 'show' || ask.kind === 'write') {
    const entry = entries.find((each) => each.name === ask.name);
    if (entry === undefined) return refused([`No sweep is named ${ask.name}. ${namesOf(entries)}`]);
    if (ask.kind === 'show') return said(showLines(framework, entry, asked));
    return {
      ...said([`Writing sweep ${ask.name}…`]),
      asyncWork: framework.takeSweep(ask.name, { requester: asked.requester })
        .then((write) => writeAnswer(write, asked.command), refusedFor),
    };
  }
  // The second act needs no entry: a taken sweep whose entry this host no longer has still has old summaries. The
  // framework refuses a name that the store never took.
  if (ask.kind === 'cost') {
    try {
      return said(costLines(framework.oldSummaryCost(ask.name, ask.agent), ask.name, ask.agent, asked.command));
    } catch (error) {
      return refusedFor(error);
    }
  }
  return {
    ...said([`Making the second act of sweep ${ask.name} for ${ask.agent}…`]),
    asyncWork: framework.dropOldSummaries(ask.name, ask.agent, { requester: asked.requester })
      .then((dropped) => said(droppedLines(dropped, ask.name, ask.agent)),
        (error) => refusedFor(error, 'The second act wasn\'t made, and nothing was dropped: ',
          ' Run it again when every agent is between turns.')),
  };
}

function listLines(framework: AgentFramework, entries: ReadonlyArray<{ name: string; line: string }>): string[] {
  if (entries.length === 0) return ['This host has no sweep.'];
  const lines = ['The sweeps of this host, and where each stands on the open branch of the open session\'s store:'];
  for (const entry of entries) {
    const show = framework.showSweep(entry.name);
    lines.push(`- ${entry.name}: ${entry.line}`);
    lines.push(`  State: ${stateOf(framework.sweepReceipt(entry.name))}. Bodies it would change now: ${show.changes.length}. ` +
      `Bodies the store would refuse: ${show.failures.length}.`);
  }
  return lines;
}

function stateOf(receipt: FrameworkSweepReceipt): string {
  if (receipt.take === null) return 'not taken';
  return receipt.finished ? 'finished here' : 'taken, not finished here';
}

function showLines(framework: AgentFramework, entry: { name: string; line: string }, asked: SweepAsked): string[] {
  const { name } = entry;
  const show = framework.showSweep(name);
  const receipt = framework.sweepReceipt(name);
  const lines = [
    `Sweep ${name}: ${entry.line}`,
    `State: ${receipt.take === null ? 'not taken' : `taken at ${receipt.take.at}, ${receipt.finished ? 'finished here' : 'not finished here'}`}.`,
  ];
  if (show.changes.length === 0) lines.push('On the open branch it would change no body.');
  else {
    lines.push(`On the open branch it would change ${counted(show.changes.length, 'body', 'bodies')}. Nothing is written without --write.`);
    for (const change of show.changes) {
      lines.push(`- Body ${change.id} of ${change.timestamp.toISOString()}, ${windowOf(change.agents)}: ${change.oldLength} characters ` +
        `now, ${change.newLength} after. Its new text: ${textOf(change.content)}`);
    }
  }
  if (show.failures.length > 0) {
    lines.push(`The store would refuse ${counted(show.failures.length, 'body', 'bodies')}:`);
    for (const failure of show.failures) lines.push(`- Body ${failure.id}: ${failure.error}`);
  }
  if (show.changes.length > 0) {
    lines.push(`Old summaries that a pass would leave, by agent: ${summariesOf(show.oldSummaries)}.`);
    lines.push(`What the write itself would drop, by agent: ${dropsOf(show.writeDrops)}.`);
  }
  if (receipt.take !== null) lines.push(...receiptLines(receipt));
  if (!receipt.finished || show.changes.length > 0 || show.failures.length > 0) lines.push(...beforeAWrite(show, name, asked.command));
  else if (receipt.oldSummaries.some((each) => total(each.summaries) > 0)) lines.push(...oldSummariesSaid(name, asked.command));
  lines.push(...notReached(asked));
  return lines;
}

function receiptLines(receipt: FrameworkSweepReceipt): string[] {
  const lines = receipt.passes.length === 0 ? ['No pass on the open branch has listed a body yet.'] : ['Passes on the open branch:'];
  for (const pass of receipt.passes) {
    const bodies = pass.bodies.map((body) => `${body.id} by ${body.participant} of ${new Date(body.timestamp).toISOString()}` +
      (body.laterShards.length > 0 ? ` (and ${counted(body.laterShards.length, 'later shard', 'later shards')})` : ''));
    lines.push(`- ${pass.at}: it listed ${counted(pass.bodies.length, 'body', 'bodies')}${bodies.length > 0 ? `: ${bodies.join(', ')}` : ''}.`);
  }
  lines.push(`Old summaries now, by agent: ${summariesOf(receipt.oldSummaries)}.`);
  return lines;
}

function beforeAWrite(show: FrameworkSweepShow, name: string, command: string): string[] {
  const earliest = new Map<string, Date>();
  for (const change of show.changes) {
    for (const agent of change.agents) {
      const before = earliest.get(agent);
      if (before === undefined || change.timestamp < before) earliest.set(agent, change.timestamp);
    }
  }
  const caches = earliest.size === 0
    ? 'no agent\'s window holds a listed body'
    : [...earliest].map(([agent, at]) => `${agent} from ${at.toISOString()}`).join(', ');
  const joined = show.writeDrops.reduce((sum, each) => sum + total(each.drops.summaries), 0);
  return [
    'Before a write:',
    '- The list is of the open branch, and a take is for the whole store: each other branch is mended when the host moves to it.',
    '- An ended agent\'s own rows are not in the list. When that agent runs again, a pass mends them.',
    '- No command takes a take back.',
    `- Each listed agent's prompt cache is rewritten once, from its earliest listed body: ${caches}.`,
    ...(joined === 0
      ? []
      : [
          `- The write joins a long note: it drops ${counted(joined, 'summary', 'summaries')} of that note at once, and each ` +
            'summary made from them.',
          '- A resident\'s turn can wait until its compression has folded those rows again.',
          '- The same happens on each other branch when the host moves to it, and nobody is shown a count there.',
        ]),
    '- The write does not change an old summary: a summary that an agent\'s memory made from a listed body while the body ' +
      'held its old text. Such a summary can still hold words of that text.',
    `- ${SECOND_ACT} After the write, \`${command} ${name} --summaries AGENT\` shows what it would drop for that agent, and ` +
      `\`${command} ${name} --summaries AGENT --write\` makes it.`,
  ];
}

const SECOND_ACT = 'The second act drops one agent\'s old summaries, and each summary made from them. That agent\'s memory then ' +
  'summarizes those rows again from their new text. Until it has, the rows take their full room in its context, and its ' +
  'turn can wait for that room.';

/** What an old summary is, and what the second act does, where an answer counts old summaries. */
function oldSummariesSaid(name: string, command: string): string[] {
  return [
    'An old summary was made from a rewritten body while the body held its old text, and it can still hold words of the ' +
      'old text.',
    `${SECOND_ACT} \`${command} ${name} --summaries AGENT\` shows what it would drop for that agent.`,
  ];
}

function notReached(asked: SweepAsked): string[] {
  const { otherSessions, fleetChildren } = asked.outside();
  const sessions = otherSessions === 0 ? '' : ` This host has ${counted(otherSessions, 'other session', 'other sessions')}: ` +
    'a session switch opens one, and a run there sweeps its store.';
  const children = fleetChildren.length === 0 ? '' : ` This host has ${counted(fleetChildren.length, 'fleet child', 'fleet children')} ` +
    `(${fleetChildren.join(', ')}): an agent here asks a child with fleet--command, and reads its answer with fleet--peek.`;
  return [
    'What a sweep does not reach:',
    '- A copy that one agent holds of another agent\'s context, such as a conversation fork\'s seed or a copy-mode ' +
      'subagent\'s inheritance: the framework stores it without the metadata that an entry needs, so no entry changes it.',
    '- The framework\'s log of requests already sent, a state of each branch of the store.',
    '- Anything outside the store, but the search index.',
    '- A summary of other rows that repeats words of the old text: a summary\'s request carries more than its own rows, and ' +
      'no count finds such a summary.',
    `- Another session's store, and a fleet child's: each needs a run of its own.${sessions}${children}`,
  ];
}

function writeAnswer(write: FrameworkSweepWrite, command: string): CommandResult {
  const { name } = write;
  if (write.outcome === 'held') {
    return {
      ...said([
        `${write.took === null ? `Sweep ${name} was taken already` : `Sweep ${name} took at ${write.took.at}`}, and nothing is ` +
          `applied yet: ${write.refusal}.`,
        `The host applies it at its next start and at a branch move, and \`${command} ${name} --write\` applies it when every ` +
          'agent is between turns.',
      ]),
      held: true,
    };
  }
  const took = write.took === null ? `Sweep ${name} took nothing new` : `Sweep ${name} took at ${write.took.at}`;
  const passes = passLines(write.passes, name);
  const nothing = write.took === null
    ? ['Nothing was left to rewrite, so nothing was written.']
    : ['Nothing on the open branch needed a rewrite. Each other branch is mended when the host moves to it.'];
  const threw = write.threw.map((each) => `- The pass of ${each.agent}'s context threw before it reported: ${each.error}. What ` +
    'it owes stays owed.');
  const summaries = [
    `Old summaries now, by agent: ${summariesOf(write.oldSummaries)}.`,
    ...(write.oldSummaries.some((each) => total(each.summaries) > 0) ? oldSummariesSaid(name, command) : []),
  ];
  if (write.outcome === 'finished') {
    return said([`${took}, and the open branch has finished it.`, ...(passes.length > 0 ? passes : nothing), ...threw, ...summaries]);
  }
  return refused([
    `${took}, and the open branch has not finished it.`,
    ...passes,
    `${counted(write.failed.length, 'body was', 'bodies were')} not rewritten:`,
    ...write.failed.map((failure) => `- Body ${failure.id}: ${failure.error}`),
    ...threw,
    `The sweep stays owed here: the host asks again at its next start and at a branch move, and so does \`${command} ${name} ` +
      '--write`.',
    ...summaries,
  ]);
}

function passLines(passes: readonly AgentSweepPass[], name: string): string[] {
  const lines: string[] = [];
  for (const { agent, report } of passes) {
    for (const outcome of report.sweeps.filter((each) => each.name === name)) {
      if (outcome.rewritten.length === 0 && outcome.removed.length === 0) continue;
      lines.push(`- ${agent}'s pass rewrote ${counted(outcome.rewritten.length, 'body', 'bodies')}` +
        (outcome.removed.length > 0 ? ` and removed ${counted(outcome.removed.length, 'later shard', 'later shards')}` : '') + '.');
    }
  }
  return lines;
}

function costLines(cost: SummaryDropCost, name: string, agent: string, command: string): string[] {
  const dropping = total(cost.summaries);
  if (dropping === 0) return [`${agent} has no old summary of sweep ${name}: the second act would drop nothing.`];
  return [
    `The second act of sweep ${name} for ${agent} would drop ${counted(dropping, 'old summary', 'old summaries')}, made ` +
      `while a rewritten body held its old text: ${levelsOf(cost.summaries)}.`,
    `${agent}'s memory would then summarize those rows again from their new text, in ` +
      `${counted(cost.records, 'chunk record', 'chunk records')}. Until it has, about ` +
      `${cost.rawTokens.toLocaleString('en-US')} tokens of rows take their full room in ${agent}'s context, and where they ` +
      `don't fit ${agent}'s budget, ${agent}'s turn waits for that room.`,
    `Nothing is written. \`${command} ${name} --summaries ${agent} --write\` makes it, while every agent is between turns.`,
  ];
}

function droppedLines(dropped: SummaryDropCost, name: string, agent: string): string[] {
  const count = total(dropped.summaries);
  if (count === 0) return [`${agent} had no old summary of sweep ${name}, so the second act dropped nothing.`];
  return [
    `The second act of sweep ${name} for ${agent} dropped ${counted(count, 'old summary', 'old summaries')}: ` +
      `${levelsOf(dropped.summaries)}.`,
    `${agent}'s memory now summarizes those rows again from their new text, in ` +
      `${counted(dropped.records, 'chunk record', 'chunk records')}. Until it has, about ` +
      `${dropped.rawTokens.toLocaleString('en-US')} tokens of rows take their full room in ${agent}'s context, and ${agent}'s ` +
      'turn can wait for that room.',
  ];
}

function summariesOf(agents: readonly AgentOldSummaries[]): string {
  if (agents.length === 0) return 'no agent is live';
  return agents.map(({ agent, summaries }) => {
    const count = total(summaries);
    return count === 0 ? `${agent}: none` : `${agent}: ${count} (${levelsOf(summaries)})`;
  }).join('; ');
}

function dropsOf(agents: readonly AgentWriteDrops[]): string {
  if (agents.length === 0) return 'no agent is live';
  return agents.map(({ agent, drops }) => {
    const count = total(drops.summaries);
    return count === 0
      ? `${agent}: none`
      : `${agent}: ${count} (${levelsOf(drops.summaries)}), and its compression folds ` +
        `${counted(drops.records, 'chunk record', 'chunk records')} again, with about ${drops.rawTokens.toLocaleString('en-US')} ` +
        'tokens of rows taking their full room until it has';
  }).join('; ');
}

function levelsOf(levels: readonly SummaryLevelCount[]): string {
  return levels.filter((each) => each.count > 0).map((each) => `${each.count} at level ${each.level}`).join(', ');
}

function total(levels: readonly SummaryLevelCount[]): number {
  return levels.reduce((sum, each) => sum + each.count, 0);
}

function windowOf(agents: readonly string[]): string {
  return agents.length === 0 ? 'in no agent\'s window' : `in the window of ${listed(agents)}`;
}

function textOf(content: readonly StoredContentBlock[]): string {
  return content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n');
}

function namesOf(entries: ReadonlyArray<{ name: string }>): string {
  return entries.length === 0 ? 'This host has no sweep.' : `This host's sweeps: ${entries.map((each) => each.name).join(', ')}.`;
}

function listed(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function said(lines: string[]): CommandResult {
  return { lines: lines.map((text) => ({ text, style: 'system' as const })) };
}

function refused(lines: string[]): CommandResult {
  return { ...said(lines), refused: true };
}

/** An OperatorActionError is the framework's refusal, said as it reads; anything else is a failure the command doesn't answer. */
function refusedFor(error: unknown, before = '', after = ''): CommandResult {
  if (error instanceof OperatorActionError) return refused([`${before}${error.message}.${after}`]);
  throw error;
}
