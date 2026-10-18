- A fleet launch whose spawn starts no process now fails at once with the
  spawn's own error and its code, and leaves the child's record `crashed`, as
  a launch that fails later does. A runtime that isn't there, or that the host
  may not run, made the launch wait out its socket timeout, 15 s by default,
  and say only that no process started, while the spawn's error went unhandled
  to the host's stderr; a NUL byte in an argument or an env value, or a
  runtime the system can't execute, made the spawn throw, and left the record
  `starting`. The error now says whose the cause is to fix, as the record's
  `autoRestartStopped` does: a runtime that can't be started is for whoever
  runs the host, and calling `fleet--launch` again fails the same way until
  then. `fleet--launch` refuses a `name`, `recipe` or `dataDir` holding a NUL
  byte before anything starts, naming the field, so a value the spawn refuses
  comes from the host's own configuration, such as an env value in its recipe,
  and the error says only whoever runs the host can change it and restart the
  host. The spawn's message is cut before a value it refused, which for an env
  value could be a secret, since the record's `exitReason` is saved and the
  host logs a failed autoStart's error. An error reported for a child that did
  start, such as a kill that failed, is logged.
