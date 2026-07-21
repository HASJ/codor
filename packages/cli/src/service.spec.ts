import { describe, expect, it } from 'vitest';

import { runServiceRestart } from './service.js';

interface Ran { command: string; args: string[] }

const recorder = (fail?: (command: string, args: string[]) => boolean) => {
  const ran: Ran[] = [];
  const exec = (command: string, args: string[]): string => {
    ran.push({ command, args });
    if (fail?.(command, args) === true) throw new Error(`${command} exited 1`);
    return '';
  };
  return { ran, exec };
};

const line = (ran: Ran[]): string[] => ran.map((entry) => `${entry.command} ${entry.args.join(' ')}`);

describe('codor restart', () => {
  it('restarts the systemd user unit on Linux', async () => {
    const { ran, exec } = recorder();
    const out: string[] = [];
    await runServiceRestart({
      dryRun: false,
      out: (text) => out.push(text),
      url: 'http://127.0.0.1:8137/',
      overrides: { platform: 'linux', exec, probe: async () => true },
    });
    expect(line(ran)).toEqual(['systemctl --user restart codor.service']);
    expect(out).toEqual(['switchboard restarted and answering on http://127.0.0.1:8137/']);
  });

  it('kickstarts the LaunchAgent in the caller own gui domain on macOS', async () => {
    const { ran, exec } = recorder();
    await runServiceRestart({
      dryRun: false,
      out: () => {},
      url: 'http://127.0.0.1:8137/',
      overrides: { platform: 'darwin', uid: 501, exec, probe: async () => true },
    });
    expect(line(ran)).toEqual(['launchctl kickstart -k gui/501/app.codor.switchboard']);
  });

  it('ends then runs the scheduled task on Windows, tolerating a task that was idle', async () => {
    // schtasks has no restart verb, and /End on a task that is not running exits
    // non-zero — treating that as failure would refuse to start a stopped daemon.
    const { ran, exec } = recorder((_, args) => args[0] === '/End');
    const out: string[] = [];
    await runServiceRestart({
      dryRun: false,
      out: (text) => out.push(text),
      url: 'http://127.0.0.1:8137/',
      overrides: { platform: 'win32', exec, probe: async () => true },
    });
    expect(line(ran)).toEqual([
      'schtasks /End /TN Codor Switchboard',
      'schtasks /Run /TN Codor Switchboard',
    ]);
    expect(out[0]).toContain('was not running');
    expect(out.at(-1)).toContain('answering');
  });

  it('fails with the setup hint when the service is not installed', async () => {
    const { exec } = recorder((_, args) => args[0] === '/Run');
    await expect(runServiceRestart({
      dryRun: false,
      out: () => {},
      url: 'http://127.0.0.1:8137/',
      overrides: { platform: 'win32', exec, probe: async () => true },
    })).rejects.toThrow(/codor setup/);
  });

  it('reports a restart the daemon never came back from instead of claiming success', async () => {
    const { exec } = recorder();
    const out: string[] = [];
    await runServiceRestart({
      dryRun: false,
      out: (text) => out.push(text),
      url: 'http://127.0.0.1:8137/',
      overrides: { platform: 'linux', exec, probe: async () => false, waitMs: 0 },
    });
    expect(out.join('\n')).toContain('did not answer');
    expect(out.join('\n')).not.toContain('answering on');
  });

  it('touches nothing on a dry run', async () => {
    const { ran, exec } = recorder();
    const out: string[] = [];
    await runServiceRestart({
      dryRun: true,
      out: (text) => out.push(text),
      url: 'http://127.0.0.1:8137/',
      overrides: { platform: 'linux', exec, probe: async () => true },
    });
    expect(ran).toEqual([]);
    expect(out).toEqual([
      '[dry-run] systemctl --user restart codor.service',
      '[dry-run] wait for http://127.0.0.1:8137/ to answer',
    ]);
  });
});
