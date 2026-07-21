import { execFileSync } from 'node:child_process';

// harn:assume cli-setup-wizard-installs-platform-user-service ref=restart-targets-installed-service
/** The names `codor setup` registers the user service under, per platform. A
 *  rename in setup.ts that misses these leaves `codor restart` addressing a
 *  service that no longer exists. */
export const SYSTEMD_UNIT = 'codor.service';
export const LAUNCH_AGENT_LABEL = 'app.codor.switchboard';
export const WIN32_TASK_NAME = 'Codor Switchboard';
// harn:end cli-setup-wizard-installs-platform-user-service

export interface ServiceOverrides {
  exec?(command: string, args: string[]): string;
  platform?: NodeJS.Platform;
  probe?(url: string): Promise<boolean>;
  uid?: number;
  waitMs?: number;
}

export interface ServiceOptions {
  dryRun: boolean;
  out(line: string): void;
  /** Where the switchboard should answer once it is back. */
  url: string;
  overrides?: ServiceOverrides;
}

const defaultExec = (command: string, args: string[]): string => execFileSync(command, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

/** Any HTTP answer means the process is listening; the routes themselves are authorized. */
const defaultProbe = async (url: string): Promise<boolean> => {
  try {
    await fetch(url, { redirect: 'manual' });
    return true;
  } catch {
    return false;
  }
};

const SETUP_HINT =
  'If the switchboard was never installed as a user service, run `codor setup`. '
  + 'A foreground `codor up` is not managed here — stop it with Ctrl+C and start it again.';

/**
 * Restart the user service `codor setup` installed. This exists because the
 * daemon serves the static client it loaded at boot, so a rebuilt web client
 * stays invisible until the process is replaced — and because every platform
 * spells that differently.
 */
export async function runServiceRestart(options: ServiceOptions): Promise<void> {
  const overrides = options.overrides ?? {};
  const platform = overrides.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`codor restart supports Linux, macOS, and Windows; received ${platform}`);
  }
  const exec = overrides.exec ?? defaultExec;

  // A command that may legitimately fail (nothing to stop) is separated from one
  // whose failure means the service is not installed — those must not look alike.
  const steps: { command: string; args: string[]; tolerate?: string }[] = [];
  if (platform === 'linux') {
    steps.push({ command: 'systemctl', args: ['--user', 'restart', SYSTEMD_UNIT] });
  } else if (platform === 'darwin') {
    const uid = overrides.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
    if (!Number.isInteger(uid) || uid! < 0) {
      throw new Error('codor restart could not determine the macOS user id');
    }
    // kickstart -k stops a running agent and starts it again in one step; it is
    // what `codor setup` already uses to (re)start the LaunchAgent.
    steps.push({
      command: 'launchctl',
      args: ['kickstart', '-k', `gui/${String(uid)}/${LAUNCH_AGENT_LABEL}`],
    });
  } else {
    // schtasks has no restart verb, and /End on a task that is not running is an
    // error rather than a no-op — so the stop is deliberately tolerated.
    steps.push({
      command: 'schtasks',
      args: ['/End', '/TN', WIN32_TASK_NAME],
      tolerate: 'the switchboard was not running',
    });
    steps.push({ command: 'schtasks', args: ['/Run', '/TN', WIN32_TASK_NAME] });
  }

  if (options.dryRun) {
    for (const step of steps) {
      options.out(`[dry-run] ${step.command} ${step.args.join(' ')}`);
    }
    options.out(`[dry-run] wait for ${options.url} to answer`);
    return;
  }

  for (const step of steps) {
    try {
      exec(step.command, step.args);
    } catch (error) {
      if (step.tolerate !== undefined) {
        options.out(`${step.command} ${step.args.join(' ')} failed — ${step.tolerate}.`);
        continue;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${step.command} ${step.args.join(' ')} failed: ${detail}\n${SETUP_HINT}`);
    }
  }

  const probe = overrides.probe ?? defaultProbe;
  const waitMs = overrides.waitMs ?? 15_000;
  const deadline = Date.now() + waitMs;
  // Reporting a restart the daemon never completed is worse than reporting a
  // slow one: the operator would go looking at a client that is still stale.
  for (;;) {
    if (await probe(options.url)) {
      options.out(`switchboard restarted and answering on ${options.url}`);
      return;
    }
    if (Date.now() >= deadline) {
      options.out(
        `restart issued, but ${options.url} did not answer within ${String(Math.round(waitMs / 1000))}s. `
        + 'Check the service logs in ~/.codor/logs.',
      );
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}
