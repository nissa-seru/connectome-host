/** The words that `/sweep`, and `connectome sweep`, take after the command. */
export const SWEEP_WORDS = '[<name> [--write] | <name> --summaries <agent> [--write]]';

const ONE_WORD = /^\S+$/;

/**
 * What the words ask: the list of the sweeps, the show of one, its write
 * (a take that is applied), the cost of its second act for one agent, or
 * that second act. Null for words that aren't one of these. Kept apart from
 * the command so that `connectome sweep` refuses its usage errors before it
 * looks for a host, without loading the framework.
 */
export type SweepAsk =
  | { kind: 'list' }
  | { kind: 'show'; name: string }
  | { kind: 'write'; name: string }
  | { kind: 'cost'; name: string; agent: string }
  | { kind: 'drop'; name: string; agent: string };

export function sweepAsk(words: readonly string[]): SweepAsk | null {
  const [name, flag, agent, write, ...more] = words;
  if (name === undefined) return { kind: 'list' };
  // The CLI joins its words with spaces for the host, which splits them on whitespace, so a word holding whitespace or
  // empty would read otherwise there.
  if (!ONE_WORD.test(name) || (agent !== undefined && !ONE_WORD.test(agent))) return null;
  if (name.startsWith('-') || more.length > 0) return null;
  if (flag === undefined) return { kind: 'show', name };
  if (flag === '--write') return agent === undefined ? { kind: 'write', name } : null;
  if (flag !== '--summaries' || agent === undefined || agent.startsWith('-')) return null;
  if (write === undefined) return { kind: 'cost', name, agent };
  return write === '--write' ? { kind: 'drop', name, agent } : null;
}
