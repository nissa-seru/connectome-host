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
  - **The first use of a store that 0.7 wrote:** chronicle 0.8.0 reads each
    list in the store whole once, at the list's first use, to check its count.
    A store's first sync also syncs its directories, including those of its
    blobs. An open now fsyncs the log before it returns. The store audit
    before an update opens and closes each store, so it meets these costs too.
    On macOS, chronicle's changelog says that the cost of the directory syncs
    on a Mac's own disk isn't measured.
  - **What a resident meets, from agent-framework 0.35.4 and 0.36.0:** an
    over-long tool result keeps its tail as well as its head, and a reply cut
    at the output limit gets an `[output-limit]` note. When the provider
    refuses a turn's last call as `reasoning_extraction` and no rewind takes
    it, the turn leaves an `[inference-failed]` note. A held draft that the
    resident leaves alone through a whole turn is set aside when that turn
    ends. When a send fails in the same round as `skip_reply`, the resident
    sees the failure before its turn ends. An MCPL server with no grant leaves
    a `[no-grant]` notice. `history--extract` leaves out private thinking that
    it can recognize. The new tool descriptions of `drafts` and
    `history--extract` can cost each resident one prompt-cache miss after the
    update.
  - **Piped mode** can print two lines for one event: agent-framework 0.36.0
    writes its own stderr line when a deadline cuts a call that it will retry,
    and when a stop ends a turn in that wait or cancels its stream.
  - **Recipes:** the built-in autobiographical and frontdesk strategies don't
    pass context-manager 0.29.0's `compressionInstructions` on from a recipe.
    A custom strategy's factory still gets the recipe's strategy keys whole.
