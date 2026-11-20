- **`connectome sweep`**, and `/sweep` in the host, are the door to Agent
  Framework's sweeps: named repairs of bodies that the store already holds.
  - With no name, it lists each sweep with where it stands on the open
    branch: not taken; taken, not finished here; or finished here. It also
    gives the number of bodies that the sweep would change now, and the
    number that the store would refuse.
  - With a name, it shows each body that the sweep would change, with the
    agents whose window holds it and its new text. It never shows the old
    text, and it writes nothing. For a taken sweep it also gives each pass
    and the bodies that the pass listed. Beside the list, it says what a
    write does and does not do, and what a sweep does not reach.
  - `--write` takes the sweep for the whole store and applies it.
    `connectome sweep` exits 0 when the open branch has finished the sweep,
    and 1 when a body was not rewritten. It exits 3 when a turn was alive,
    so that the host applies the sweep later.
  - A write keeps each summary that was made from a body while the body held
    its old text, and such a summary can still hold words of that text.
    `--summaries <agent>` gives what dropping that agent's old summaries would
    cost. With `--write`, it drops them, and the agent then summarizes those
    rows again from their new text.
  - When no host answers, `connectome sweep` lists nothing and exits 1.
  - The host's `ready` event carries `sweep: true`. A write that the store
    applies later ends with a `command-done` that carries `held: true`.
