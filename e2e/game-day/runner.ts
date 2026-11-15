/**
 * The runner: a quiet start, prepare, cause, check, restore, settle and
 * recover, in that order. README.md beside this file owns the argument; the
 * CLI around it is `game-day.mts`.
 */
import {
  GATEWAY,
  GameDayError,
  Timeout,
  message,
  realWaits,
  waitUntil,
  type Scenario,
  type Waits,
  type World,
} from './harness.ts';
import { SCENARIOS } from './scenarios.ts';

/**
 * Why the cause must not start, or null. A stack already broken would make
 * "the app showed it" a fact about whatever broke it first.
 */
export async function quietStart(scenario: Scenario, world: World): Promise<string | null> {
  for (const service of scenario.services) {
    let state: string;
    try {
      state = await world.compose.state(service);
    } catch (error) {
      return `${service}: its state could not be read: ${message(error)}`;
    }
    if (state !== 'running') {
      return `${service}: ${state} before the cause; restore the stack and rerun`;
    }
  }
  const [ready, observed] = await world.probe(`${GATEWAY}/health/ready`);
  return ready ? null : `the stack is not ready before the cause: ${observed}`;
}

/**
 * One scenario, start to recovery. Returns the findings; an empty list is a
 * pass. The restore runs whatever happened before it, including a cause that
 * threw half-way, because a scenario that left a service stopped would turn
 * every one after it into a finding about the wrong thing.
 */
export async function run(
  scenario: Scenario,
  world: World,
  waits: Waits = realWaits,
): Promise<string[]> {
  const refused = await quietStart(scenario, world);
  if (refused !== null) return [refused];

  const findings: string[] = [];
  try {
    await scenario.prepare(world);
    world.say(`${scenario.name}: causing; the app has ${scenario.deadlineSeconds}s to answer`);
    await scenario.cause(world);
    try {
      const took = await waitUntil(
        () => scenario.check(world),
        scenario.deadlineSeconds,
        scenario.name,
        waits,
      );
      world.say(`${scenario.name}: the app answered as promised after ${took}s`);
    } catch (error) {
      if (!(error instanceof Timeout)) throw error;
      findings.push(`the app did not do what ${scenario.source} promises: ${error.message}`);
    }
  } catch (error) {
    findings.push(`the cause or the check failed: ${message(error)}`);
  } finally {
    findings.push(...(await restore(scenario, world, waits)));
  }
  return findings;
}

async function restore(scenario: Scenario, world: World, waits: Waits): Promise<string[]> {
  try {
    await scenario.restore(world);
    await waitUntil(
      () => scenario.settled(world),
      scenario.settleSeconds,
      `${scenario.name}: the stack settling`,
      waits,
    );
  } catch (error) {
    return [`the restore did not settle, so the next scenario starts poisoned: ${message(error)}`];
  }
  world.say(`${scenario.name}: the stack is back`);
  try {
    await waitUntil(
      () => scenario.recovered(world),
      scenario.settleSeconds,
      `${scenario.name}: the app recovering`,
      waits,
    );
  } catch (error) {
    return [`the stack is back but the app did not recover: ${message(error)}`];
  }
  world.say(`${scenario.name}: the app recovered`);
  return [];
}

export function find(name: string, scenarios: readonly Scenario[] = SCENARIOS): Scenario {
  const found = scenarios.find((scenario) => scenario.name === name);
  if (found === undefined) {
    const known = scenarios.map((scenario) => scenario.name).join(', ');
    throw new GameDayError(`${name}: no such scenario; there are ${known}`);
  }
  return found;
}

/**
 * The scenarios a CI dispatch runs, one job each, as the line
 * `GITHUB_OUTPUT` takes. A name with no scenario fails here, before any stack
 * is started for it.
 */
export function matrix(names: string, scenarios: readonly Scenario[] = SCENARIOS): string {
  const wanted = names.trim() === '' || names.trim() === 'all'
    ? scenarios.map((scenario) => scenario.name)
    : names.trim().split(/\s+/).map((name) => find(name, scenarios).name);
  return `scenarios=${JSON.stringify(wanted)}`;
}

/** The one line a run ends on. */
export function verdict(name: string, findings: readonly string[], seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = String(Math.round(seconds % 60)).padStart(2, '0');
  return `game day: ${name} ${findings.length === 0 ? 'OK' : 'FAILED'} in ${minutes}m${rest}s`;
}
