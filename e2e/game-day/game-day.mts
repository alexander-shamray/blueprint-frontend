/**
 * Causes a failure the app documents a response to, on the backend's Compose
 * stack, and checks the web build answers it as promised. README.md beside
 * this file owns the rest.
 *
 *   node e2e/game-day/game-day.mts gateway-down      # one scenario
 *   node e2e/game-day/game-day.mts --list            # the scenarios, and what none causes
 *   node e2e/game-day/game-day.mts --matrix all      # CI's plan, as a GITHUB_OUTPUT line
 *
 * Exit 0 is a pass, 1 a finding, 2 a refusal: no such scenario, or arguments
 * that do not parse.
 */
import { chromium } from '@playwright/test';
import { Compose, GameDayError, probe, type World } from './harness.ts';
import { find, matrix, run, verdict } from './runner.ts';
import { NOT_CAUSED, SCENARIOS } from './scenarios.ts';

function list(): void {
  for (const scenario of SCENARIOS) {
    console.log(`${scenario.name} (${scenario.impact}): ${scenario.promise} [${scenario.source}]`);
  }
  for (const [name, reason] of Object.entries(NOT_CAUSED)) {
    console.log(`${name}: not caused, because ${reason}`);
  }
}

async function one(name: string): Promise<number> {
  const scenario = find(name);
  const started = Date.now();
  const browser = await chromium.launch();
  let findings: string[];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const world: World = {
      compose: new Compose(),
      page,
      context,
      probe: (url) => probe(url),
      say: (line) => console.log(line),
    };
    findings = await run(scenario, world);
  } finally {
    await browser.close();
  }
  for (const finding of findings) console.error(`FINDING: ${finding}`);
  console.log(verdict(scenario.name, findings, (Date.now() - started) / 1000));
  return findings.length === 0 ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    if (argv.length === 1 && argv[0] === '--list') {
      list();
      return 0;
    }
    if (argv.length === 2 && argv[0] === '--matrix') {
      console.log(matrix(argv[1] ?? ''));
      return 0;
    }
    if (argv.length === 1 && !(argv[0] ?? '').startsWith('-')) return await one(argv[0] ?? '');
    console.error('usage: game-day.mts <scenario> | --list | --matrix <names|all>');
    return 2;
  } catch (error) {
    if (!(error instanceof GameDayError)) throw error;
    console.error(error.message);
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
