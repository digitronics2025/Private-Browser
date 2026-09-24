import { describe, expect, it } from 'vitest';
import { commandInvocation, spawnCommand } from './spawn-command.js';

describe('starting approved project commands', () => {
  it('runs ordinary executables directly, with no shell', () => {
    expect(commandInvocation('node', ['--version'], 'win32')).toEqual({ file: 'node', args: ['--version'], verbatim: false });
    expect(commandInvocation('npm', ['run', 'dev'], 'linux')).toEqual({ file: 'npm', args: ['run', 'dev'], verbatim: false });
  });

  // F-43: Node refuses to spawn .cmd/.bat without a shell, so these never started.
  it('runs Windows command scripts through cmd.exe with every part quoted', () => {
    const invocation = commandInvocation('C:\\Project Files\\app\\gradlew.bat', ['test'], 'win32');
    expect(invocation.file).toMatch(/System32[\\/]cmd\.exe$/i);
    expect(invocation.args).toEqual(['/d', '/s', '/c', '""C:\\Project Files\\app\\gradlew.bat" "test""']);
    expect(invocation.verbatim).toBe(true);
  });

  it.each(['run&calc', 'dev|x', '%PATH%', 'a^b', 'x"y', 'a<b', 'a>b', 'a!b'])('refuses a part cmd would interpret: %s', (argument) => {
    expect(() => commandInvocation('npm.cmd', ['run', argument], 'win32')).toThrow('cannot run safely');
  });

  it.runIf(process.platform === 'win32')('actually starts npm.cmd on this Windows machine', async () => {
    const child = spawnCommand('npm.cmd', ['--version'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    expect(code).toBe(0);
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
