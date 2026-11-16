/**
 * The game day's own suite, which needs no stack and no browser:
 *
 *   node --test e2e/game-day/harness-suite.mts
 *
 * Named so Playwright's default `testMatch` never collects it into the smoke.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { BrowserContext, Page } from '@playwright/test';
import {
  Compose,
  GameDayError,
  Timeout,
  waitUntil,
  type Observation,
  type Ran,
  type Scenario,
  type Waits,
  type World,
} from './harness.ts';
import { find, matrix, quietStart, run, verdict } from './runner.ts';
import { NOT_CAUSED, SCENARIOS } from './scenarios.ts';

/** A clock that only moves when the code under test sleeps. */
function fakeWaits(): Waits {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

interface Stage {
  readonly calls: string[];
  states: Record<string, string>;
  ready: boolean;
}

function world(stage: Stage): World {
  return {
    compose: {
      stop: async (service) => void stage.calls.push(`stop ${service}`),
      start: async (service) => void stage.calls.push(`start ${service}`),
      pause: async (service) => void stage.calls.push(`pause ${service}`),
      unpause: async (service) => void stage.calls.push(`unpause ${service}`),
      state: async (service) => stage.states[service] ?? 'absent',
    },
    page: {} as unknown as Page,
    context: {} as unknown as BrowserContext,
    probe: async (url): Promise<Observation> => [stage.ready, `${url} probed`],
    say: () => undefined,
  };
}

function stage(): Stage {
  return { calls: [], states: { web: 'running' }, ready: true };
}

const never = async (): Promise<Observation> => [false, 'still waiting'];

function scenario(log: string[], overrides: Partial<Scenario> = {}): Scenario {
  const step = (name: string) => async () => void log.push(name);
  return {
    name: 'fake',
    impact: 'outage',
    promise: 'answers',
    source: 'src/fake.ts:1',
    services: ['web'],
    deadlineSeconds: 5,
    settleSeconds: 5,
    prepare: step('prepare'),
    cause: step('cause'),
    check: async () => (log.push('check'), [true, 'answered'] as const),
    restore: step('restore'),
    settled: async () => (log.push('settled'), [true, 'back'] as const),
    recovered: async () => (log.push('recovered'), [true, 'recovered'] as const),
    ...overrides,
  };
}

describe('waitUntil', () => {
  it('returns the seconds it took once the predicate holds', async () => {
    let asks = 0;
    const took = await waitUntil(
      async () => [++asks === 3, `ask ${asks}`],
      10,
      'third ask',
      fakeWaits(),
    );
    assert.equal(took, 2);
  });

  it('names the last observation when the deadline passes', async () => {
    await assert.rejects(waitUntil(never, 3, 'never', fakeWaits()), (error: unknown) => {
      assert.ok(error instanceof Timeout);
      assert.match(error.message, /never: not within 3s; last saw still waiting/);
      return true;
    });
  });
});

describe('Compose', () => {
  function recording(result: Ran) {
    const argv: string[][] = [];
    const compose = new Compose('stack.yml', async (file, args) => {
      argv.push([file, ...args]);
      return result;
    });
    return { argv, compose };
  }

  it('drives docker compose against the given file', async () => {
    const { argv, compose } = recording({ code: 0, stdout: 'paused\n', stderr: '' });
    await compose.stop('gateway');
    await compose.unpause('catalog-api');
    assert.equal(await compose.state('catalog-api'), 'paused');
    assert.deepEqual(argv, [
      ['docker', 'compose', '-f', 'stack.yml', 'stop', 'gateway'],
      ['docker', 'compose', '-f', 'stack.yml', 'unpause', 'catalog-api'],
      ['docker', 'compose', '-f', 'stack.yml', 'ps', '--all', '--format', '{{.State}}', 'catalog-api'],
    ]);
  });

  it('reads a service with no container as absent', async () => {
    const { compose } = recording({ code: 0, stdout: '', stderr: '' });
    assert.equal(await compose.state('gateway'), 'absent');
  });

  it('throws what docker said on a non-zero exit', async () => {
    const { compose } = recording({ code: 1, stdout: '', stderr: 'no such service: gatway' });
    await assert.rejects(compose.stop('gatway'), (error: unknown) => {
      assert.ok(error instanceof GameDayError);
      assert.match(error.message, /docker compose stop gatway exited 1: no such service/);
      return true;
    });
  });
});

describe('run', () => {
  it('passes in order: prepare, cause, check, restore, settled, recovered', async () => {
    const log: string[] = [];
    const findings = await run(scenario(log), world(stage()), fakeWaits());
    assert.deepEqual(findings, []);
    assert.deepEqual(log, ['prepare', 'cause', 'check', 'restore', 'settled', 'recovered']);
  });

  it('restores after a cause that threw half-way', async () => {
    const log: string[] = [];
    const broken = scenario(log, {
      cause: async () => {
        throw new GameDayError('stop refused');
      },
    });
    const findings = await run(broken, world(stage()), fakeWaits());
    assert.deepEqual(findings, ['the cause or the check failed: stop refused']);
    assert.ok(log.includes('restore'));
  });

  it('reports an app that never answered as a finding naming the promise, and restores', async () => {
    const log: string[] = [];
    const findings = await run(scenario(log, { check: never }), world(stage()), fakeWaits());
    assert.equal(findings.length, 1);
    assert.match(findings[0] ?? '', /did not do what src\/fake\.ts:1 promises: .*still waiting/);
    assert.ok(log.includes('restore'));
  });

  it('reports a restore that does not settle, and asks nothing of the app after it', async () => {
    const log: string[] = [];
    const findings = await run(scenario(log, { settled: never }), world(stage()), fakeWaits());
    assert.equal(findings.length, 1);
    assert.match(findings[0] ?? '', /restore did not settle/);
    assert.ok(!log.includes('recovered'));
  });

  it('reports an app that does not come back with the stack', async () => {
    const log: string[] = [];
    const findings = await run(scenario(log, { recovered: never }), world(stage()), fakeWaits());
    assert.equal(findings.length, 1);
    assert.match(findings[0] ?? '', /stack is back but the app did not recover/);
  });

  it('causes nothing on a stack where a service it touches is not running', async () => {
    const log: string[] = [];
    const broken = stage();
    broken.states = { web: 'exited' };
    const findings = await run(scenario(log), world(broken), fakeWaits());
    assert.deepEqual(findings, ['web: exited before the cause; restore the stack and rerun']);
    assert.deepEqual(log, []);
  });

  it('causes nothing on a stack whose gateway is not ready', async () => {
    const notReady = stage();
    notReady.ready = false;
    const refused = await quietStart(scenario([]), world(notReady));
    assert.match(refused ?? '', /the stack is not ready before the cause/);
    assert.equal(await quietStart(scenario([]), world(stage())), null);
  });
});

describe('the CLI pieces', () => {
  it('plans every scenario for all, and the named ones otherwise', () => {
    const names = SCENARIOS.map((each) => each.name);
    assert.equal(matrix('all'), `scenarios=${JSON.stringify(names)}`);
    assert.equal(matrix(' offline  gateway-down '), 'scenarios=["offline","gateway-down"]');
  });

  it('refuses a name with no scenario', () => {
    assert.throws(() => matrix('offline nonesuch'), GameDayError);
    assert.throws(() => find('nonesuch'), /nonesuch: no such scenario/);
  });

  it('ends on one line', () => {
    assert.equal(verdict('offline', [], 65), 'game day: offline OK in 1m05s');
    assert.equal(verdict('offline', ['x'], 5), 'game day: offline FAILED in 0m05s');
    assert.equal(verdict('offline', [], 59.6), 'game day: offline OK in 1m00s');
  });
});

describe('the scenarios', () => {
  it('are named once each, and apart from every failure none causes', () => {
    const names = SCENARIOS.map((each) => each.name);
    assert.equal(new Set(names).size, names.length);
    for (const name of Object.keys(NOT_CAUSED)) assert.ok(!names.includes(name), name);
  });

  it('touch the stack exactly when their impact says they do', () => {
    for (const each of SCENARIOS) {
      assert.equal(each.services.length > 0, each.impact === 'outage', each.name);
    }
  });

  it('cite a line that exists for the promise they check', () => {
    const root = new URL('../../', import.meta.url);
    for (const each of SCENARIOS) {
      const cited = /^(?<file>[^:]+):(?<line>\d+)$/.exec(each.source)?.groups;
      assert.ok(cited, `${each.name}: ${each.source} is not file:line`);
      const lines = readFileSync(new URL(cited['file'] ?? '', root), 'utf8').split('\n');
      const line = lines[Number(cited['line']) - 1] ?? '';
      assert.ok(line.trim() !== '', `${each.name}: ${each.source} is blank or past the end`);
    }
  });
});
