- **Operators: with chronicle 0.8.0, a session's store that has lost its
  `records.log` no longer opens.** chronicle refuses to open it, so the host
  can't start that session, and the store audit before an update refuses it
  too. The error names the missing file and says what to restore. A store
  that still has its `records.log` opens as before. Before,
  chronicle 0.7 wrote an empty `records.log` and the store opened without its
  records, or refused with words about a torn tail. A store that an earlier
  release opened that way holds an empty `records.log`. Where its `state.bin`
  holds a state head, it is refused as well, with words that call the log
  empty. **Who needs to act:** an operator whose session store lost its log.
  `connectome doctor` reports a missing `records.log` for the active session's
  store. It doesn't flag an empty one. **Migration:** restore `records.log`
  from a copy. Where no copy exists, the error says which files to move out of
  the store so that it starts over without its records and keeps its blobs.
- **Operators of the Web UI, and residents with a reply judge, forked
  subagents or conversation forks: with context-manager 0.29.0, a dry compile
  under adaptive resolution can be refused where it used to pass.** The
  autobiographical and frontdesk strategies take adaptive resolution unless a
  recipe turns it off. The refusal happens when the strategy's fold plan
  doesn't fit the budget while the context that it emits would. A turn's own
  compile can still recover where a dry compile is refused. **Who needs to
  act:** nobody has to change a setting. A resident that set `onError` to
  `skip` stays unwoken by its judge rules while its previews are refused.
  With `wake`, the default, such a batch wakes the resident.
  These meet the refusal:
  - the Web UI's views of the agent's context (its debug context, its context
    makeup and its context curve), which then fail with it;
  - the Web UI's settings preview, which then shows the plan's figures with no
    entries;
  - a surgery's rollback or suppression in the Web UI, which still succeeds
    but shows no last visible message;
  - a resident's reply judge, which reads a preview of the context. The gate
    counts the refusal as a failure of the judge and does what
    `modules.wake.judge.onError` says: with `skip`, that batch wakes nobody;
  - a subagent forked with its parent's context, which then doesn't start. The
    host compiles the parent's context for the fork at context-manager's
    default budget of 100,000 tokens;
  - a new conversation fork, which then isn't made. agent-framework compiles
    its template's context at that default budget too.
