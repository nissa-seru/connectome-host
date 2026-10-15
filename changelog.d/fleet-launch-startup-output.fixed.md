- A fleet child that fails to start now says why. When a launch fails after
  the child was spawned, unless the host is shutting down and leaves the
  child running, the error from `fleet--launch` and `fleet--restart`, and
  the host's log line for a failed autoStart or autoRestart, quote the end
  of what the child wrote to its `startup.log` during that launch: its last
  20 lines, at most 2,000 characters, under a line naming the file, without
  escape sequences or control characters other than tabs and newlines.
  Before, the agent read only the stage that failed, such as that the child
  exited before its socket appeared, while the cause, such as a recipe
  naming an unset environment variable, a missing API key or an extension
  that failed to import, went only to that file. If the child wrote nothing,
  the error says so, and if the spawn reports that no process started, as
  when the child's runtime can't be found, it says that instead, and the
  name's record no longer blocks another launch. A `startup.log` shorter
  than where the launch began is quoted from its end and said to be
  truncated, another file there is said to have replaced it and isn't read,
  and one the host couldn't open or read is named, with why. The record's
  `exitReason`, which `fleet--status`, `/fleet status` and the TUI show,
  stays one line, and the TUI's fleet view shows a notice of several lines
  by its first line, cut as the alerts beside it are.
- A fleet launch refused because `FleetModule` has no `childIndexPath` no
  longer drops the record of the child it would have replaced, such as a
  crashed child or one restored from the persisted state at the host's
  start.
- A FIFO at a fleet child's `startup.log`, such as one a child left in its
  own data directory, no longer stops the host's event loop at that child's
  next launch. The host opens the file without waiting for a FIFO's reader,
  and gives it to the child only if it's a regular file that took the
  launch's header; otherwise the child's console output isn't kept, and the
  host's log says why at the launch, as does the error of a failed launch
  that would otherwise quote it.
