import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `emulator:android:run:windows` launches the app with `adb shell am start -n
 * <id>/.MainActivity`, and that id is `appId` in `capacitor.config.ts` — the
 * owner — restated as a literal in `package.json`. A changed `appId` would
 * leave the script starting nothing until someone ran it on Windows, so this
 * reads both as text and holds them equal (#222). Text rather than an import:
 * the config file pulls in the Capacitor CLI's types, which a unit test has no
 * reason to load.
 */
function read(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf8');
}

function configAppId(source: string): string | undefined {
  return /\bappId:\s*'([^']+)'/.exec(source)?.[1];
}

function launcherAppId(source: string): string | undefined {
  const script = (JSON.parse(source) as { scripts: Record<string, string> }).scripts[
    'emulator:android:run:windows'
  ];
  return /\bam start -n ([\w.]+)\//.exec(script ?? '')?.[1];
}

describe('the Windows emulator launcher', () => {
  it('starts the application id capacitor.config.ts declares', () => {
    const owner = configAppId(read('capacitor.config.ts'));
    expect(owner).toBeTruthy();
    expect(launcherAppId(read('package.json'))).toBe(owner);
  });

  it('is read by patterns that fail on a changed id rather than matching nothing', () => {
    expect(configAppId("const c = { appId: 'a.b.c' };")).toBe('a.b.c');
    expect(configAppId('const c = {};')).toBeUndefined();
    const pkg = (script: string): string =>
      JSON.stringify({ scripts: { 'emulator:android:run:windows': script } });
    expect(launcherAppId(pkg('adb shell am start -n x.y.z/.MainActivity'))).toBe('x.y.z');
    expect(launcherAppId(pkg('adb shell am start x.y.z'))).toBeUndefined();
  });
});
