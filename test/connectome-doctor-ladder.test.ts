import { describe, test, expect, afterAll, afterEach } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

const LADDER = resolve(import.meta.dir, '..', 'scripts', 'connectome-doctor');
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map((c) => c.exitCode !== null || c.signalCode !== null ? null
    : new Promise((done) => { c.once('exit', done); c.kill('SIGKILL'); })));
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function bin(dir: string, name: string, script: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

const lines = (path: string): number => existsSync(path) ? readFileSync(path, 'utf-8').split('\n').filter(Boolean).length : 0;

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface Host {
  process: ChildProcess;
  signals: string;
  ticks: string;
}

async function standInHost(dir: string, listens: boolean, dumpsTo?: string): Promise<Host> {
  const signals = join(dir, 'signals');
  const ticks = join(dir, 'ticks');
  const dump = join(dir, 'dump-line');
  writeFileSync(dump, '[diagnostics] {"activeStreams":[],"gate":{"inferring":false}}\n');
  const writesDump = dumpsTo ? `cat ${dump} >> ${dumpsTo}; ` : '';
  const trap = listens ? `trap '${writesDump}echo usr2 >> ${signals}' USR2; ` : '';
  const process = spawn('sh', ['-c', `${trap}while :; do echo t >> ${ticks}; sleep 0.05; done`], { stdio: 'ignore' });
  children.push(process);
  await waitFor(() => lines(ticks) > 0, 'the stand-in host to start');
  return { process, signals, ticks };
}

interface Install {
  work: string;
  bins: string;
  host: Host;
  started: number;
  now: number;
}

interface Unit {
  active?: string;
  output?: string;
  error?: string;
  text?: string;
  mainPidNow?: string;
}

function systemctl(at: Install, unit: Unit = {}): void {
  const startStamp = new Date(at.started * 1000).toUTCString().replace('GMT', 'UTC');
  writeFileSync(join(at.work, 'unit.txt'), unit.text ?? '');
  bin(at.bins, 'systemctl', [
    'case "$*" in',
    `  *--value*) echo ${unit.mainPidNow ?? at.host.process.pid} ;;`,
    `  *" cat "*) cat ${join(at.work, 'unit.txt')} ;;`,
    `  *) printf "ActiveState=${unit.active ?? 'active'}\\nSubState=running\\nNRestarts=0\\nExecMainStartTimestamp=${startStamp}\\nMainPID=${at.host.process.pid}\\nStandardOutput=${unit.output ?? 'journal'}\\nStandardError=${unit.error ?? 'inherit'}\\n" ;;`,
    'esac',
  ].join('\n'));
}

async function install(opts: { listens: boolean; journalFails?: string; dumpReadFails?: boolean; dumpsTo?: string }): Promise<Install> {
  const work = mkdtempSync(join(tmpdir(), 'chost-ladder-'));
  dirs.push(work);
  mkdirSync(join(work, 'data'));
  mkdirSync(join(work, 'logs'));
  const bins = join(work, 'bin');
  mkdirSync(bins);
  const host = await standInHost(work, opts.listens, opts.dumpsTo && join(work, opts.dumpsTo));
  const now = Math.floor(Date.now() / 1000);
  const at = { work, bins, host, started: now - 60, now };
  systemctl(at);
  const signalHandled = `i=0; until grep -q usr2 ${host.signals} 2>/dev/null || [ $i -ge 100 ]; do sleep 0.05; i=$((i+1)); done`;
  bin(bins, 'journalctl', opts.journalFails !== undefined
    ? `echo "${opts.journalFails}" >&2; exit 1`
    : [
      'case "$*" in',
      opts.dumpReadFails
        ? '  *--since*) echo "Failed to open the journal: Permission denied" >&2; exit 1 ;;'
        : `  *--since*) ${signalHandled}; grep -q usr2 ${host.signals} 2>/dev/null && echo '[diagnostics] {"activeStreams":[],"gate":{"inferring":false}}' ;;`,
      `  *) cat ${join(work, 'journal.txt')} ;;`,
      'esac',
    ].join('\n'));
  writeFileSync(join(work, 'journal.txt'), [
    `${now - 30}.000000 host bun[1]: started`,
    `${now - 20}.000000 host bun[1]: [inference-failed] the model call failed: 400 prompt is too long`,
    `${now - 10}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)`,
    `${now - 5}.000000 host bun[1]: an ordinary line`,
    '',
  ].join('\n'));
  return at;
}

function ladder(at: Install, extra: string[] = [], env: Record<string, string> = {}): { out: string; status: number | null } {
  const ran = spawnSync('python3', [LADDER, ...extra, at.work, 'connectome-test.service'], {
    encoding: 'utf-8',
    env: { ...process.env, ...env, PATH: `${at.bins}:${process.env.PATH}` },
    timeout: 30_000,
  });
  return { out: `${ran.stdout}${ran.stderr}`, status: ran.status };
}

const signalled = (host: Host): boolean => lines(host.signals) > 0;
const alive = (host: Host): boolean => host.process.exitCode === null && host.process.signalCode === null;
const stamp = (ts: number): string => new Date(ts * 1000).toISOString().slice(5, 19).replace('T', ' ');

async function settled(host: Host): Promise<void> {
  const from = lines(host.ticks);
  await waitFor(() => !alive(host) || lines(host.ticks) >= from + 2, 'two more turns of the stand-in host');
}

describe('the ladder, for a unit that logs to the journal', () => {
  test('its failures, its delivery and its gate dump come from the journal, and logs/failures.log is read too', async () => {
    const at = await install({ listens: true });
    writeFileSync(join(at.work, 'logs', 'failures.log'),
      `${JSON.stringify({ at: new Date().toISOString(), agent: 'resident', consecutive: 1, reason: 'Error: 529 overloaded' })}\n`);
    const { out } = ladder(at);
    await settled(at.host);
    expect(out).toContain('[inference-failed] the model call failed: 400 prompt is too long');
    expect(out).toContain('Error: 529 overloaded');
    expect(out).toMatch(/routeSpeech delivery .*routed 12ch -> discord:1\/2/);
    expect(out).toContain('live gate dump (SIGUSR2): {"activeStreams":[]');
    expect(signalled(at.host)).toBe(true);
    expect(alive(at.host)).toBe(true);
  });

  test('the delivery stage is the time of the journal\'s last delivery, not of its last entry', async () => {
    const at = await install({ listens: true });
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toMatch(new RegExp(`o routeSpeech delivery +${stamp(at.now - 10)}`));
  });

  test('a reply that wasn\'t delivered after the last one that was is shown as not delivered, and is a finding with the whole line', async () => {
    const at = await install({ listens: true });
    writeFileSync(join(at.work, 'journal.txt'), [
      `${at.now - 10}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)`,
      `${at.now - 3}.000000 host bun[1]: [routeSpeech] discord:1/2: the channel refused it: ${'r'.repeat(160)} — speech NOT routed (12 chars stay in chronicle)`,
      '',
    ].join('\n'));
    const { out, status } = ladder(at, ['--no-signal']);
    expect(out).toMatch(new RegExp(`x routeSpeech delivery +${stamp(at.now - 10)}.*NOT delivered`));
    expect(out).toMatch(/=== findings ===[\s\S]*the last reply wasn't delivered: discord:1\/2: the channel refused it: r+ — speech NOT routed \(12 chars stay in chronicle\)/);
    expect(status).toBe(1);
  });

  test('a reply whose delivery wasn\'t confirmed is shown as that, beside the last delivery\'s time, and is a finding that it may have reached its channel', async () => {
    const at = await install({ listens: true });
    writeFileSync(join(at.work, 'journal.txt'), [
      `${at.now - 10}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)`,
      `${at.now - 3}.000000 host bun[1]: [routeSpeech] discord:1/2: the connector timed out — speech delivery NOT confirmed (12 chars stay in chronicle)`,
      '',
    ].join('\n'));
    const { out, status } = ladder(at, ['--no-signal']);
    expect(out).toMatch(new RegExp(`\\? routeSpeech delivery +${stamp(at.now - 10)} +\\( *\\d+s ago\\) +delivery NOT confirmed`));
    expect(out).not.toContain('NOT delivered');
    expect(out).toMatch(/=== findings ===[\s\S]*the last reply's delivery wasn't confirmed, so it may or may not be in its channel: discord:1\/2: the connector timed out/);
    expect(status).toBe(1);
  });

  test('a reply that had no locus is shown as that', async () => {
    const at = await install({ listens: true });
    writeFileSync(join(at.work, 'journal.txt'), [
      `${at.now - 10}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)`,
      `${at.now - 3}.000000 host bun[1]: [routeSpeech] discord:1/2: turn has no locus (no home/trigger channel; nothing to deliver into) — speech NOT routed (12 chars stay in chronicle)`,
      '',
    ].join('\n'));
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toMatch(/x routeSpeech delivery .*NO LOCUS/);
    expect(out).toMatch(/=== findings ===[\s\S]*the last reply had no locus, so it wasn't delivered and stays in the chronicle: discord:1\/2: turn has no locus \(no home\/trigger channel; nothing to deliver into\) — speech NOT routed/);
  });

  test('a line about a locus that was closed, after a delivery, leaves the delivery stage at that delivery', async () => {
    const at = await install({ listens: true });
    writeFileSync(join(at.work, 'journal.txt'), [
      `${at.now - 10}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)`,
      `${at.now - 3}.000000 host bun[1]: [routeSpeech] discord:1/2: locus discord:1/2 was closed — opened by delivery (speech implies engagement)`,
      '',
    ].join('\n'));
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toMatch(new RegExp(`o routeSpeech delivery +${stamp(at.now - 10)} .*routed 12ch -> discord:1/2`));
  });

  test('a reply line cut short after its arrow isn\'t taken for a delivery, and doesn\'t stop the ladder', async () => {
    const at = await install({ listens: true });
    writeFileSync(join(at.work, 'journal.txt'), [
      `${at.now - 10}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)`,
      `${at.now - 3}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> `,
      '',
    ].join('\n'));
    const { out } = ladder(at, ['--no-signal']);
    expect(out).not.toContain('Traceback');
    expect(out).toMatch(new RegExp(`o routeSpeech delivery +${stamp(at.now - 10)} .*routed 12ch -> discord:1/2`));
  });

  test('a window with no reply line in it leaves the last delivery\'s time not known, naming the window', async () => {
    const at = await install({ listens: true });
    writeFileSync(join(at.work, 'journal.txt'), `${at.now - 3}.000000 host bun[1]: an ordinary line\n`);
    expect(ladder(at, ['--no-signal']).out).toMatch(/\? routeSpeech delivery +--:--:-- +\(not known\) +none in the journal's last 2000 lines/);
    writeFileSync(join(at.work, 'logs', 'agent.log'), 'an ordinary line\n');
    expect(ladder(at, ['--no-signal']).out).toMatch(/\? routeSpeech delivery +--:--:-- +\(not known\) +none in its last 2 MB/);
  });

  test('replies with no delivery among them leave the last delivery\'s time not known, not never', async () => {
    const at = await install({ listens: true });
    writeFileSync(join(at.work, 'journal.txt'),
      `${at.now - 3}.000000 host bun[1]: [routeSpeech] discord:1/2: the channel refused it — speech NOT routed (12 chars stay in chronicle)\n`);
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toMatch(/x routeSpeech delivery +--:--:-- +\(not known\) +NOT delivered/);
    expect(out).not.toMatch(/routeSpeech delivery .*never/);
  });

  test('a logs/agent.log left from before the unit started doesn\'t take the journal\'s place', async () => {
    const at = await install({ listens: true });
    const log = join(at.work, 'logs', 'agent.log');
    writeFileSync(log, '[inference-failed] an old failure from the file\n');
    utimesSync(log, at.started - 3600, at.started - 3600);
    const { out } = ladder(at);
    expect(out).toContain('[inference-failed] the model call failed: 400 prompt is too long');
    expect(out).not.toContain('an old failure from the file');
  });

  test('a journal that can\'t be read is named as that, not as a journal with no failures or a unit that logs to a file, and its delivery isn\'t known', async () => {
    const at = await install({ listens: true, journalFails: 'Failed to open the journal: Permission denied' });
    const { out } = ladder(at);
    expect(out).toContain('Permission denied');
    expect(out).not.toContain('none found');
    expect(out).not.toContain('to a file');
    expect(out).toMatch(/\? routeSpeech delivery .*not known/);
    expect(out).not.toMatch(/routeSpeech delivery .*never/);
  });
});

describe('where the ladder reads a unit\'s output', () => {
  const failing = (what: string): string => `[inference-failed] ${what}\n`;

  test('a unit that sends its stderr to a file and its stdout to the journal is read from that file', async () => {
    const at = await install({ listens: true });
    const file = join(at.work, 'host.err');
    writeFileSync(file, failing('from the stderr file'));
    systemctl(at, { output: 'journal', error: 'append', text: `[Service]\nStandardError=append:${file}\n` });
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toContain('from the stderr file');
    expect(out).not.toContain('400 prompt is too long');
    expect(out).toContain(`(stderr -> ${file})`);
  });

  test('a unit that splits its streams is read from its stderr\'s file', async () => {
    const at = await install({ listens: true });
    const [a, b] = [join(at.work, 'host.out'), join(at.work, 'host.err')];
    writeFileSync(a, failing('from the stdout file'));
    writeFileSync(b, failing('from the stderr file'));
    systemctl(at, { output: 'file', error: 'file', text: `[Service]\nStandardOutput=file:${a}\nStandardError=file:${b}\n` });
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toContain('from the stderr file');
    expect(out).not.toContain('from the stdout file');
  });

  test('a unit whose stderr inherits stdout\'s file is read from that file', async () => {
    const at = await install({ listens: true });
    const file = join(at.work, 'host.log');
    writeFileSync(file, failing('from the shared file'));
    systemctl(at, { output: 'append', error: 'inherit', text: `[Service]\nStandardOutput=append:${file}\n` });
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toContain('from the shared file');
    expect(out).not.toContain('400 prompt is too long');
  });

  test('the last assignment in the unit and its drop-ins is the one read, and a commented one isn\'t', async () => {
    const at = await install({ listens: true });
    const file = (name: string): string => {
      const path = join(at.work, `${name}.err`);
      writeFileSync(path, failing(`from the ${name} file`));
      return path;
    };
    systemctl(at, {
      error: 'append',
      text: [
        '# /home/u/.config/systemd/user/connectome-test.service',
        '[Service]',
        `StandardError=append:${file('fragment')}`,
        '',
        '# /home/u/.config/systemd/user/connectome-test.service.d/override.conf',
        '[Service]',
        `StandardError=append:${file('drop-in')}`,
        `#StandardError=append:${file('commented')}`,
        `; StandardError=append:${file('semicolon')}`,
        '',
      ].join('\n'),
    });
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toContain('from the drop-in file');
    for (const not of ['fragment', 'commented', 'semicolon']) expect(out).not.toContain(`from the ${not} file`);
  });

  test('a file named with %h, %t, %u, %U or %% is read with them expanded', async () => {
    const at = await install({ listens: true });
    const { username } = userInfo();
    const uid = process.getuid!();
    const home = join(at.work, `${username}-${uid}-100%.err`);
    writeFileSync(home, failing('from the %h file'));
    systemctl(at, { error: 'append', text: '[Service]\nStandardError=append:%h/%u-%U-100%%.err\n' });
    const first = ladder(at, ['--no-signal'], { HOME: at.work }).out;
    expect(first).toContain('from the %h file');
    expect(first).toContain(`(stderr -> ${home})`);
    const runtime = mkdtempSync(join(tmpdir(), 'chost-ladder-runtime-'));
    dirs.push(runtime);
    writeFileSync(join(runtime, 'host.err'), failing('from the %t file'));
    systemctl(at, { error: 'append', text: '[Service]\nStandardError=append:%t/host.err\n' });
    expect(ladder(at, ['--no-signal'], { XDG_RUNTIME_DIR: runtime }).out).toContain('from the %t file');
  });

  test('a file named with a specifier the ladder doesn\'t expand is a finding that names it', async () => {
    const at = await install({ listens: true });
    systemctl(at, { error: 'append', text: '[Service]\nStandardError=append:%S/host.err\n' });
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toMatch(/=== findings ===[\s\S]*sends its stderr to %S\/host\.err, whose %S this script doesn't expand/);
  });

  test('a file whose path holds a value to withhold is still read', async () => {
    const at = await install({ listens: true });
    const file = join(at.work, 'Zq9-PATH-SECRET.err');
    writeFileSync(file, failing('from the stderr file'));
    systemctl(at, { error: 'append', text: `[Service]\nStandardError=append:${file}\n` });
    const { out } = ladder(at, ['--no-signal'], { CONNECTOME_DOCTOR_WITHHOLD: JSON.stringify([['DISCORD_TOKEN', 'Zq9-PATH-SECRET']]) });
    expect(out).toContain('from the stderr file');
  });

  test('the gate dump of a unit whose stderr goes to a file comes from that file', async () => {
    const at = await install({ listens: true, dumpsTo: 'host.err' });
    const file = join(at.work, 'host.err');
    writeFileSync(file, failing('from the stderr file'));
    systemctl(at, { error: 'append', text: `[Service]\nStandardError=append:${file}\n` });
    const { out } = ladder(at);
    await settled(at.host);
    expect(signalled(at.host)).toBe(true);
    expect(out).toContain('live gate dump (SIGUSR2): {"activeStreams":[]');
  });

  test('a reply line in logs/agent.log is read whole, even where it holds a Unicode line separator', async () => {
    const at = await install({ listens: true });
    writeFileSync(join(at.work, 'logs', 'agent.log'), [
      '[routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)',
      '[routeSpeech] discord:1/2: the channel refused it\u2028twice — speech NOT routed (12 chars stay in chronicle)',
      '',
    ].join('\n'));
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toMatch(/x routeSpeech delivery .*NOT delivered/);
  });

  test('a unit whose stderr goes to a file the unit\'s text doesn\'t name is a finding', async () => {
    const at = await install({ listens: true });
    systemctl(at, { error: 'append', text: '[Service]\nExecStart=/bin/true\n' });
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toMatch(/=== findings ===[\s\S]*sends its stderr to a file, which `systemctl --user cat connectome-test.service` doesn't name/);
  });

  test('a logs/agent.log written since the unit started is read', async () => {
    const at = await install({ listens: true });
    writeFileSync(join(at.work, 'logs', 'agent.log'), failing('from agent.log'));
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toContain('from agent.log');
    expect(out).not.toContain('400 prompt is too long');
  });

  test('a file the unit\'s stderr goes to that can\'t be read is said, for its failures and for the gate dump', async () => {
    const at = await install({ listens: true });
    const file = join(at.work, 'gone.err');
    systemctl(at, { error: 'append', text: `[Service]\nStandardError=append:${file}\n` });
    const { out } = ladder(at);
    await settled(at.host);
    expect(out).toMatch(new RegExp(`recent failures in ${file}: not known: it can't be read`));
    expect(out).toMatch(new RegExp(`live gate dump: SIGUSR2 sent, but ${file} can't be read`));
    expect(out).not.toContain('no [diagnostics] line came');
  });
});

describe('the ladder\'s recent failures', () => {
  test('every logs/failures.log record is a failure, whatever its reason says', async () => {
    const at = await install({ listens: true });
    writeFileSync(join(at.work, 'logs', 'failures.log'), `${JSON.stringify({ reason: '529 overloaded' })}\n`);
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toContain('529 overloaded');
  });

  test('the journal\'s failures and failures.log\'s are each shown, under where they came from', async () => {
    const at = await install({ listens: true });
    const records = Array.from({ length: 6 }, (_, i) => JSON.stringify({ reason: `record ${i}` }));
    writeFileSync(join(at.work, 'logs', 'failures.log'), `${records.join('\n')}\n`);
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toMatch(/recent failures in connectome-test\.service's journal:\n.*400 prompt is too long/);
    expect(out).toMatch(/recent failures in .*failures\.log:\n(.*record [1-5].*\n){5}/);
    expect(out).not.toContain('record 0');
  });

  test('a failures.log that can\'t be read is said, not taken as one with no failures', async () => {
    const at = await install({ listens: true });
    mkdirSync(join(at.work, 'logs', 'failures.log'));
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toMatch(/failures\.log: not known: it can't be read/);
    expect(out).not.toMatch(/failures\.log: none found/);
  });
});

describe('the ladder\'s gate dump', () => {
  test('a host that hasn\'t installed its SIGUSR2 listener yet isn\'t signalled, and says why and what to do', async () => {
    const at = await install({ listens: false });
    const { out } = ladder(at);
    await settled(at.host);
    expect(alive(at.host)).toBe(true);
    expect(out).not.toContain('live gate dump (SIGUSR2): {');
    expect(out).toMatch(/gate dump: not asked: .*has no SIGUSR2 listener.*run this check again in a minute; one whose agent-framework predates the dump never does/);
  });

  test('a host that listens, in a unit that isn\'t active, isn\'t signalled', async () => {
    const at = await install({ listens: true });
    systemctl(at, { active: 'deactivating' });
    const { out } = ladder(at);
    await settled(at.host);
    expect(signalled(at.host)).toBe(false);
    expect(out).not.toContain('live gate dump (SIGUSR2)');
    expect(out).toMatch(/=== findings ===[\s\S]*service is deactivating/);
  });

  test('the main process is read again before the signal, and a new one without a listener isn\'t signalled', async () => {
    const at = await install({ listens: true });
    const laterDir = mkdtempSync(join(tmpdir(), 'chost-ladder-later-'));
    dirs.push(laterDir);
    const later = await standInHost(laterDir, false);
    systemctl(at, { mainPidNow: String(later.process.pid) });
    const { out } = ladder(at);
    await settled(later);
    expect(alive(later)).toBe(true);
    expect(signalled(at.host)).toBe(false);
    expect(out).toContain(`the host (pid ${later.process.pid}) has no SIGUSR2 listener`);
  });

  test('a main process whose status can\'t be read, or no main process, isn\'t signalled, and says why', async () => {
    const at = await install({ listens: true });
    systemctl(at, { mainPidNow: '999999999' });
    expect(ladder(at).out).toMatch(/gate dump: not asked: \/proc\/999999999\/status can't be read/);
    systemctl(at, { mainPidNow: '0' });
    expect(ladder(at).out).toMatch(/gate dump: not asked: the unit has no main process now/);
    expect(signalled(at.host)).toBe(false);
  });

  test('--no-signal sends no SIGUSR2, even to a host that listens, and says the dump was left out', async () => {
    const at = await install({ listens: true });
    const { out } = ladder(at, ['--no-signal']);
    await settled(at.host);
    expect(signalled(at.host)).toBe(false);
    expect(out).not.toContain('live gate dump (SIGUSR2): {');
    expect(out).toMatch(/gate dump.*left out/i);
  });

  test('a gate dump whose journal read fails says so, not that the host didn\'t answer, and is a finding', async () => {
    const at = await install({ listens: true, dumpReadFails: true });
    const { out, status } = ladder(at);
    await settled(at.host);
    expect(out).toMatch(/live gate dump: SIGUSR2 sent, but connectome-test\.service's journal can't be read \(Failed to open the journal: Permission denied\)/);
    expect(out).not.toContain('no [diagnostics] line came');
    expect(out).toMatch(/=== findings ===[\s\S]*the gate dump isn't known/);
    expect(status).toBe(1);
  });
});

describe('the ladder\'s data directory', () => {
  test('--data-dir reads the data directory it names, not INSTALL_DIR/data', async () => {
    const at = await install({ listens: true });
    const data = mkdtempSync(join(tmpdir(), 'chost-ladder-data-'));
    dirs.push(data);
    rmSync(join(at.work, 'data'), { recursive: true });
    const row = { timestamp: new Date().toISOString(), kind: 'stream', rawResponse: { stop_reason: 'end_turn' } };
    writeFileSync(join(data, 'llm-calls.2026-10-27T00-00-00.jsonl'), `${JSON.stringify(row)}\n`);
    const { out } = ladder(at, ['--no-signal', '--data-dir', data]);
    expect(out).toContain('stop=end_turn');
  });

  test('a data directory that isn\'t there is a finding, not a crash', async () => {
    const at = await install({ listens: true });
    rmSync(join(at.work, 'data'), { recursive: true });
    const { out, status } = ladder(at, ['--no-signal']);
    expect(out).not.toContain('Traceback');
    expect(out).toMatch(/=== findings ===[\s\S]*there's no data directory at .*--data-dir/);
    expect(status).toBe(1);
  });

  test('the ingest stage reads the active session\'s records, as sessions.json names it, not another session\'s', async () => {
    const at = await install({ listens: true });
    const record = (room: string, at_s: number) => {
      const payload = [...Buffer.from(JSON.stringify({ triggered: true, channelName: room, participant: 'ann' }))].join(',');
      return `{"record_id":1,"global_sequence":1,"state_id":"messages","data":[${payload}],"timestamp":${at_s * 1_000_000}}\n`;
    };
    const sessions = join(at.work, 'data', 'sessions');
    for (const id of ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f', 's-g', 's-h', 's-active']) {
      mkdirSync(join(sessions, id), { recursive: true });
      const file = join(sessions, id, 'records.log');
      writeFileSync(file, record(id === 's-active' ? 'active-room' : 'other-room', at.now - 40));
      const when = id === 's-active' ? at.now - 3_600 : at.now - 30;
      utimesSync(file, when, when);
    }
    writeFileSync(join(at.work, 'data', 'sessions.json'), JSON.stringify({ activeSessionId: 's-active', sessions: {} }));
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toMatch(/chronicle ingest \(\+gate\) .*#active-room/);
    expect(out).not.toContain('#other-room');
  });

  test('an index naming no session or a session with no records.log, or session data that can\'t be read, takes no other session\'s records', async () => {
    const at = await install({ listens: true });
    const payload = [...Buffer.from(JSON.stringify({ triggered: true, channelName: 'other-room', participant: 'ann' }))].join(',');
    mkdirSync(join(at.work, 'data', 'sessions', 's-other'), { recursive: true });
    writeFileSync(join(at.work, 'data', 'sessions', 's-other', 'records.log'),
      `{"record_id":1,"global_sequence":1,"state_id":"messages","data":[${payload}],"timestamp":${(at.now - 40) * 1_000_000}}\n`);
    const index = join(at.work, 'data', 'sessions.json');
    writeFileSync(index, JSON.stringify({ activeSessionId: 's-gone-Zq9-SID-SECRET', sessions: {} }));
    const named = ladder(at, ['--no-signal'], { CONNECTOME_DOCTOR_WITHHOLD: JSON.stringify([['DISCORD_TOKEN', 'Zq9-SID-SECRET']]) }).out;
    expect(named).toMatch(/chronicle ingest \(\+gate\) .*\(\s*never\).*the active session, s-gone-<DISCORD_TOKEN>, has no records\.log/);
    expect(named).not.toContain('Zq9-SID-SECRET');
    expect(named).not.toContain('#other-room');
    writeFileSync(index, JSON.stringify({ activeSessionId: null, sessions: {} }));
    const none = ladder(at, ['--no-signal']).out;
    expect(none).toMatch(/chronicle ingest \(\+gate\) .*\(\s*never\).*sessions\.json names no active session/);
    expect(none).not.toContain('#other-room');
    writeFileSync(index, '{ not json');
    const unread = ladder(at, ['--no-signal']).out;
    expect(unread).toMatch(/chronicle ingest \(\+gate\) .*\(not known\).*sessions\.json can't be read as the host's session index \(Expecting property name/);
    expect(unread).not.toContain('#other-room');
    writeFileSync(index, '[]');
    const listed = ladder(at, ['--no-signal']).out;
    expect(listed).toMatch(/chronicle ingest \(\+gate\) .*\(not known\).*sessions\.json can't be read as the host's session index \(it isn't a JSON object\)/);
    expect(listed).not.toContain('#other-room');
    const withhold = { CONNECTOME_DOCTOR_WITHHOLD: JSON.stringify([['DISCORD_TOKEN', 'Zq9-SID-SECRET']]) };
    mkdirSync(join(at.work, 'data', 'sessions', 's-dir-Zq9-SID-SECRET', 'records.log'), { recursive: true });
    writeFileSync(index, JSON.stringify({ activeSessionId: 's-dir-Zq9-SID-SECRET', sessions: {} }));
    const records = ladder(at, ['--no-signal'], withhold).out;
    expect(records).toMatch(/chronicle ingest \(\+gate\) .*\(not known\).*s-dir-<DISCORD_TOKEN>\/records\.log can't be read \(Is a directory\)/);
    expect(records).not.toContain('Zq9-SID-SECRET');
    expect(records).not.toContain('#other-room');
    mkdirSync(join(at.work, 'data', 'sessions', 's-loop-Zq9-SID-SECRET'));
    symlinkSync('records.log', join(at.work, 'data', 'sessions', 's-loop-Zq9-SID-SECRET', 'records.log'));
    writeFileSync(index, JSON.stringify({ activeSessionId: 's-loop-Zq9-SID-SECRET', sessions: {} }));
    const loop = ladder(at, ['--no-signal'], withhold).out;
    expect(loop).toMatch(/chronicle ingest \(\+gate\) .*\(not known\).*s-loop-<DISCORD_TOKEN>\/records\.log can't be read \(Too many levels of symbolic links\)/);
    expect(loop).not.toContain('Zq9-SID-SECRET');
    expect(loop).not.toContain('#other-room');
  });

  test('with no index, a sessions directory that can\'t be listed is said, not taken as one with no records', async () => {
    const at = await install({ listens: true });
    const fresh = ladder(at, ['--no-signal']).out;
    expect(fresh).toMatch(/chronicle ingest \(\+gate\) .*\(\s*never\)/);
    expect(fresh).not.toMatch(/chronicle ingest \(\+gate\) .*not known/);
    mkdirSync(join(at.work, 'data', 'sessions'));
    const empty = ladder(at, ['--no-signal']).out;
    expect(empty).toMatch(/chronicle ingest \(\+gate\) .*\(\s*never\)/);
    expect(empty).not.toMatch(/chronicle ingest \(\+gate\) .*not known/);
    rmSync(join(at.work, 'data', 'sessions'), { recursive: true });
    writeFileSync(join(at.work, 'data', 'sessions'), 'not a directory');
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toMatch(/chronicle ingest \(\+gate\) .*\(not known\).*sessions can't be listed \(Not a directory\)/);
  });

  test('with no session index, sessions on disk leave the active one not known, and no session\'s records are read', async () => {
    const at = await install({ listens: true });
    const payload = [...Buffer.from(JSON.stringify({ triggered: true, channelName: 'some-room', participant: 'ann' }))].join(',');
    mkdirSync(join(at.work, 'data', 'sessions', 's-a'), { recursive: true });
    writeFileSync(join(at.work, 'data', 'sessions', 's-a', 'records.log'),
      `{"record_id":1,"global_sequence":1,"state_id":"messages","data":[${payload}],"timestamp":${(at.now - 40) * 1_000_000}}\n`);
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toMatch(/chronicle ingest \(\+gate\) .*\(not known\).*no sessions\.json names the active session/);
    expect(out).not.toContain('#some-room');
  });

  test('the last Discord drop discord-mcpl logged in the last hour is shown with its reason, on the forward stage', async () => {
    const at = await install({ listens: true });
    const iso = (s: number) => new Date(s * 1000).toISOString();
    const log = join(at.work, 'data', 'discord-mcpl-debug.log');
    writeFileSync(log, [
      `${iso(at.now - 50)} handleDiscordMessage:enter {"channelName":"general","contentPreview":"hello"}`,
      `${iso(at.now - 48)} handleDiscordMessage:drop {"reason":"bot message"}`,
      `${iso(at.now - 45)} handleDiscordMessage:drop {"reason":"channel not in scope"}`,
      '',
    ].join('\n'));
    const { out } = ladder(at, ['--no-signal']);
    expect(out).toMatch(/mcpl forward to host .*last drop .*: channel not in scope/);
    expect(out).not.toContain('bot message');
    writeFileSync(log, [
      `${iso(at.now - 50)} handleDiscordMessage:enter {"channelName":"general","contentPreview":"hello"}`,
      `${iso(at.now - 3_700)} handleDiscordMessage:drop {"reason":"channel not in scope"}`,
      '',
    ].join('\n'));
    expect(ladder(at, ['--no-signal']).out).not.toContain('last drop');
  });
});

describe('what the ladder withholds', () => {
  test('a value it\'s given to withhold is replaced where it reads it, before any line is cut short', async () => {
    const at = await install({ listens: true });
    const secret = 'Zq9-SECRET-77';
    const long = `[inference-failed] ${'x'.repeat(125)}${secret} and the rest`;
    writeFileSync(join(at.work, 'journal.txt'), `${at.now}.000000 host bun[1]: ${long}\n`);
    writeFileSync(join(at.work, 'logs', 'failures.log'), `${JSON.stringify({ reason: `Error: ${'y'.repeat(120)}${secret}` })}\n`);
    const { out } = ladder(at, ['--no-signal'], { CONNECTOME_DOCTOR_WITHHOLD: JSON.stringify([['DISCORD_TOKEN', secret]]) });
    expect(out).toContain('<DISC');
    expect(out).not.toContain('Zq9');
  });

  test('two values that overlap where they\'re read leave no part of either', async () => {
    const at = await install({ listens: true });
    writeFileSync(join(at.work, 'journal.txt'), `${at.now}.000000 host bun[1]: [inference-failed] key aaQ1-bbQ2-ccQ3 refused\n`);
    const withhold = JSON.stringify([['FIRST', 'aaQ1-bbQ2'], ['SECOND', 'bbQ2-ccQ3']]);
    const { out } = ladder(at, ['--no-signal'], { CONNECTOME_DOCTOR_WITHHOLD: withhold });
    expect(out).toContain('key <FIRST> refused');
    for (const part of ['aaQ1', 'bbQ2', 'ccQ3']) expect(out).not.toContain(part);
  });

  test('a value at the start of a file\'s tail, cut through, leaves no part of it', async () => {
    const at = await install({ listens: true });
    const secret = 'Zq9-STRADDLE-SECRET-41';
    const first = `${'x'.repeat(100)}${secret} tail\n`;
    const cut = Buffer.byteLength(first) - (100 + 10);
    writeFileSync(join(at.work, 'logs', 'failures.log'), `${first}${'y'.repeat(400_000 - cut - 1)}\n`);
    const { out } = ladder(at, ['--no-signal'], { CONNECTOME_DOCTOR_WITHHOLD: JSON.stringify([['DISCORD_TOKEN', secret]]) });
    expect(out).toContain('yyyy');
    expect(out).not.toContain(secret.slice(10));
  });

  test('a failed command\'s error is withheld too', async () => {
    const at = await install({ listens: true, journalFails: 'Failed: the token Zq9-SECRET-77 was refused' });
    const { out } = ladder(at, ['--no-signal'], { CONNECTOME_DOCTOR_WITHHOLD: JSON.stringify([['DISCORD_TOKEN', 'Zq9-SECRET-77']]) });
    expect(out).toContain('the token <DISCORD_TOKEN> was refused');
    expect(out).not.toContain('Zq9');
  });

  test('a CONNECTOME_DOCTOR_WITHHOLD it can\'t read stops the ladder before it reads anything', async () => {
    const at = await install({ listens: true });
    const { out, status } = ladder(at, ['--no-signal'], { CONNECTOME_DOCTOR_WITHHOLD: '{"DISCORD_TOKEN":"x"}' });
    expect(status).toBe(2);
    expect(out).toContain("CONNECTOME_DOCTOR_WITHHOLD can't be read");
    expect(out).not.toContain('400 prompt is too long');
  });
});
