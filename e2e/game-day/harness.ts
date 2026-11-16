/**
 * The game day's control of the backend's Compose stack, its waits and its
 * world: README.md beside this file owns what a run proves. Node runs this as
 * it is, so it holds no enum, no parameter property and no namespace, and it
 * imports its types with `import type`.
 */
import { execFile } from 'node:child_process';
import type { BrowserContext, Page } from '@playwright/test';
import { GATEWAY, KEYCLOAK } from '../helpers.ts';

export { GATEWAY, KEYCLOAK };

/** The dev server the web build is served from, as `playwright.config.ts` names it. */
export const APP = process.env['GAME_DAY_APP'] ?? 'http://localhost:5173';

/**
 * The backend's Compose file. Its own checkout, never a copy: the services this
 * stops are the backend's to name. CI checks the backend out inside the app's
 * workspace and points the variable at it; a developer's sibling checkout is
 * the default.
 */
export const COMPOSE_FILE =
  process.env['GAME_DAY_COMPOSE'] ?? '../blueprint-backend/deploy/compose/docker-compose.yml';

export const POLL_MS = 1_000;

/** A step that did not do what its scenario said it would. */
export class GameDayError extends Error {}

/** A predicate that did not hold by its deadline, carrying the last thing it saw. */
export class Timeout extends GameDayError {}

/** Whether a condition holds, and what was seen, so a timeout can name it. */
export type Observation = readonly [ok: boolean, observed: string];

/** The clock and the sleep, injected so the suite runs a deadline in no time. */
export interface Waits {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export const realWaits: Waits = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Polls until the predicate holds and returns the seconds it took; never a bare
 * sleep. The predicate is asked once more at the deadline, so a condition that
 * became true during the last sleep is seen, and the timeout names the last
 * observation, because "did not happen" is the least useful finding.
 */
export async function waitUntil(
  predicate: () => Promise<Observation>,
  deadlineSeconds: number,
  what: string,
  waits: Waits = realWaits,
  pollMs: number = POLL_MS,
): Promise<number> {
  const started = waits.now();
  for (;;) {
    const [ok, observed] = await predicate();
    const elapsed = waits.now() - started;
    if (ok) return Math.round(elapsed / 1000);
    if (elapsed >= deadlineSeconds * 1000) {
      throw new Timeout(`${what}: not within ${deadlineSeconds}s; last saw ${observed}`);
    }
    await waits.sleep(Math.min(pollMs, deadlineSeconds * 1000 - elapsed));
  }
}

/** One process's exit and output; a spawn failure is a non-zero code, not a throw. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Run = (file: string, args: readonly string[]) => Promise<Ran>;

export const runProcess: Run = (file, args) =>
  new Promise((done) => {
    execFile(file, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      done({ code, stdout, stderr: stderr || (error?.message ?? '') });
    });
  });

/** `docker compose` against the backend's file, with the runner injected so the suite sees the argv. */
export class Compose {
  private readonly base: readonly string[];
  private readonly run: Run;

  constructor(composeFile: string = COMPOSE_FILE, run: Run = runProcess) {
    this.base = ['compose', '-f', composeFile];
    this.run = run;
  }

  private async call(...args: string[]): Promise<string> {
    const result = await this.run('docker', [...this.base, ...args]);
    if (result.code !== 0) {
      const said = `${result.stderr.trim()} ${result.stdout.trim()}`.trim().slice(0, 600);
      throw new GameDayError(`docker compose ${args.join(' ')} exited ${result.code}: ${said}`);
    }
    return result.stdout;
  }

  async stop(service: string): Promise<void> {
    await this.call('stop', service);
  }

  /** Safe on a running service: `start` leaves it as it is. */
  async start(service: string): Promise<void> {
    await this.call('start', service);
  }

  async pause(service: string): Promise<void> {
    await this.call('pause', service);
  }

  async unpause(service: string): Promise<void> {
    await this.call('unpause', service);
  }

  /** `running`, `paused`, `exited` and the rest as Docker says them; `absent` for no container. */
  async state(service: string): Promise<string> {
    const out = await this.call('ps', '--all', '--format', '{{.State}}', service);
    return out.trim().split(/\r?\n/)[0] || 'absent';
  }
}

/** The part of `Compose` a scenario uses, so the suite can stand a fake in. */
export type ComposeControl = Pick<Compose, 'stop' | 'start' | 'pause' | 'unpause' | 'state'>;

/** A GET that answered 2xx, as an observation; a refused connection is one too, not a throw. */
export async function probe(url: string, timeoutMs = 10_000): Promise<Observation> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return [response.ok, `${url} answered ${response.status}`];
  } catch (error) {
    return [false, `${url} did not answer: ${message(error)}`];
  }
}

/** Everything a scenario acts on: the stack, one browser page and its context, and the log. */
export interface World {
  readonly compose: ComposeControl;
  readonly page: Page;
  readonly context: BrowserContext;
  readonly probe: (url: string) => Promise<Observation>;
  readonly say: (line: string) => void;
}

/**
 * What a cause costs: `outage` stops or pauses a container the rest of the
 * stack uses, `browser` changes only this run's own browser context.
 */
export type Impact = 'outage' | 'browser';

/**
 * One failure the app documents a response to. `check` and `settled` are
 * polled until they hold or their deadline passes. `restore` runs whatever the
 * cause did, including when the cause threw half-way, finds what to undo in
 * the stack rather than in the process, and is safe to run twice.
 */
export interface Scenario {
  readonly name: string;
  readonly impact: Impact;
  /** What the app is documented or coded to do, in a sentence. */
  readonly promise: string;
  /** Where that is promised, as `file:line`. */
  readonly source: string;
  /** The Compose services the cause touches; each must be running before it. */
  readonly services: readonly string[];
  readonly deadlineSeconds: number;
  readonly settleSeconds: number;
  prepare(world: World): Promise<void>;
  cause(world: World): Promise<void>;
  check(world: World): Promise<Observation>;
  restore(world: World): Promise<void>;
  /** The stack is back: polled after `restore`. */
  settled(world: World): Promise<Observation>;
  /** The app came back with it, by the way back it offers: polled after `settled`. */
  recovered(world: World): Promise<Observation>;
}
