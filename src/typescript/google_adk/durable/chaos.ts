/**
 * Failure injection for the chaos panel. The flags live in Redis (chaos:flags) and are read on every
 * activity attempt, so a failure is switched on and off at runtime with no restart. These helpers do
 * I/O, so they run only in activities (the model activity included), never in workflow code.
 */
import { Context } from '@temporalio/activity';
import { ChaosEvent, ChaosFlag, ChaosManager } from '../../common/chaos-manager';

const SLOW_STEP_MS = 4000;
const FLAG_READ_TIMEOUT_MS = 1000;

/** Where the flags come from: Redis in the worker, an in-memory map in the tests. */
export interface ChaosSource {
  isEnabled(flag: ChaosFlag): Promise<boolean>;
  recordEvent(event: Omit<ChaosEvent, 'timestamp'>): Promise<void>;
}

let source: ChaosSource | undefined;

function chaosSource(): ChaosSource {
  source ??= new ChaosManager();
  return source;
}

/** Replaces the flag source (the tests use an in-memory one, so they need no Redis). */
export function setChaosSource(s: ChaosSource): void {
  source = s;
}

/** An in-memory flag source. */
export class InMemoryChaos implements ChaosSource {
  readonly enabled = new Set<ChaosFlag>();
  readonly events: Array<Omit<ChaosEvent, 'timestamp'>> = [];
  async isEnabled(flag: ChaosFlag): Promise<boolean> {
    return this.enabled.has(flag);
  }
  async recordEvent(event: Omit<ChaosEvent, 'timestamp'>): Promise<void> {
    this.events.push(event);
  }
  set(flag: ChaosFlag, on: boolean): void {
    if (on) this.enabled.add(flag);
    else this.enabled.delete(flag);
  }
}

/** Whether a flag is on. If Redis can't be reached the flag reads as off, rather than breaking the demo. */
export async function isEnabled(flag: ChaosFlag): Promise<boolean> {
  try {
    return await Promise.race([
      chaosSource().isEnabled(flag),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), FLAG_READ_TIMEOUT_MS).unref()),
    ]);
  } catch {
    return false;
  }
}

/** Throws `error` if `flag` is on, logging it for the chaos panel. The error decides whether Temporal retries. */
export async function injectFailure(flag: ChaosFlag, error: Error): Promise<void> {
  if (!(await isEnabled(flag))) return;
  const { activityType, attempt, workflowExecution } = Context.current().info;
  try {
    await chaosSource().recordEvent({
      flag,
      source: activityType,
      attempt,
      workflow_id: workflowExecution?.workflowId,
    });
  } catch {
    // The failure log is best effort
  }
  throw error;
}

/** Call at the top of each activity that stands for the core banking system. */
export async function coreBankingApi(): Promise<void> {
  await injectFailure(ChaosFlag.TOOL_DOWN, new Error('ConnectionError: Core banking API unavailable'));
}

/** Makes an account-opening step slow enough to watch, when the slow-steps flag is on. */
export async function maybeSlowDown(): Promise<void> {
  if (await isEnabled(ChaosFlag.SLOW_SAGA)) {
    await Context.current().sleep(SLOW_STEP_MS);
  }
}
