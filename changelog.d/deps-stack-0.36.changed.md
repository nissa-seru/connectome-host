- The host takes agent-framework `^0.36.0` (was `^0.35.3`), context-manager
  `^0.29.0` (was `^0.28.0`) and chronicle `^0.8.0` (was `^0.7.0`), with both
  lockfiles at those releases and one copy of each. Each package's changelog
  lists its changes: agent-framework's for 0.35.4 and 0.36.0,
  context-manager's for 0.29.0, and chronicle's for 0.7.1 and 0.8.0.
  - **Stores:** after a failed fsync of a store's log, the next write of a
    record or a state retries it on the same open store, so a session can go
    on without a restart. A call that changes a store's branches or
    registrations undoes its change on the open store when its checkpoint
    fails. chronicle 0.8.0 opens a store that 0.7 wrote. The checks that 0.8.0
    saves in `state.bin` don't keep 0.7 from opening a store, so a host can go
    back to the release before this one. chronicle 0.7.1's
    `tools/compact-set-states.py` refuses a `state.bin` that holds those
    checks.
  - **What chronicle 0.8.0's checks cost:** in a store that an earlier release
    wrote, chronicle 0.8.0 reads each list whole once, at the list's first
    use, to check its count. Each open now fsyncs the log before it returns.
    On Unix, the first `sync()` or close of each open store also syncs the
    store's directory, `blobs/` and each shard directory, and the directories
    that hold the store. The store audit before an update opens and closes
    each store, so it meets these costs too. A fleet child's audit stops after
    5 minutes, unless `CONNECTOME_FLEET_CHILD_AUDIT_MINUTES` gives more. On
    macOS, chronicle's changelog says that the cost of the directory syncs on
    a Mac's own disk isn't measured.
  - **What a resident meets** is in agent-framework's changelog for 0.35.4 and
    0.36.0. It covers an over-long tool result, which keeps its tail as well
    as its head, the new `[output-limit]`, `[inference-failed]` and
    `[no-grant]` notes, held drafts that are set aside, and a failed send in
    the same round as `skip_reply`. `history--extract` leaves out private
    thinking that it can recognize.
  - **Prompt cache:** the new tool descriptions of `drafts` and
    `history--extract` can cost each resident that has those tools one
    prompt-cache miss after the update.
  - **Piped mode** can print two lines for one event: agent-framework 0.36.0
    writes its own stderr line when a deadline cuts a call that it will retry,
    and when a stop ends a turn in that wait or cancels its stream.
  - **Recipes:** the built-in autobiographical and frontdesk strategies don't
    pass context-manager 0.29.0's `compressionInstructions` on from a recipe.
    A custom strategy's factory still gets the recipe's strategy keys whole.
  - **The Web UI's quarantine alert:** when the compression quarantine
    empties, it now says "compression quarantine EMPTY; alarm stands down." It
    no longer says that all debt is paid, since context-manager 0.29.0 says
    that an empty quarantine is not evidence of paid debt.
