/**
 * Which AI framework the API serves: its task queue and the prefix of its chat workflow IDs.
 *
 * Each framework is one TypeScript version of the demo (src/typescript/<framework>). AI_FRAMEWORK
 * picks it. It has no default: the start scripts require the framework as their argument (e.g.
 * ./startlocalapi.sh vercel_ai) and, without a valid one, stop and list every framework.
 * TEMPORAL_TASK_QUEUE and CHAT_WORKFLOW_ID_PREFIX override that framework's values. The web
 * application reads the prefix from GET /config, so each chat's workflow ID names the SDK that runs it.
 *
 * Mirrors src/python/api/frameworks.py. The chat workflows share one Temporal contract, so the
 * Python API can serve these frameworks too.
 */

export interface Framework {
  name: string;
  label: string;
  // The framework's default chat task queue (its worker's default)
  taskQueue: string;
  workflowIdPrefix: string;
}

export const FRAMEWORKS: Record<string, Framework> = Object.fromEntries(
  [
    {
      name: 'vercel_ai',
      label: 'Vercel AI SDK (TypeScript)',
      taskQueue: 'VAI-Supervisor',
      workflowIdPrefix: 'vai-temporal-agent-',
    },
  ].map((framework) => [framework.name, framework]),
);

/** Every framework, one per line: its name, label and task queue. */
export function validFrameworks(): string {
  const width = Math.max(...Object.keys(FRAMEWORKS).map((name) => name.length));
  return Object.values(FRAMEWORKS)
    .map((f) => `  ${f.name.padEnd(width)}  ${f.label} (task queue ${f.taskQueue})`)
    .join('\n');
}

/** Why `name` isn't a framework, or null if it is. */
export function problem(name: string): string | null {
  if (!name) return 'No AI framework given.';
  if (!Object.prototype.hasOwnProperty.call(FRAMEWORKS, name)) return `Unknown AI framework '${name}'.`;
  return null;
}

/** The framework named by AI_FRAMEWORK, with CHAT_WORKFLOW_ID_PREFIX applied. */
export function selectedFramework(env: NodeJS.ProcessEnv = process.env): Framework {
  const name = env.AI_FRAMEWORK ?? '';
  const error = problem(name);
  if (error) throw new Error(`${error} Set AI_FRAMEWORK to one of:\n${validFrameworks()}`);
  const prefix = env.CHAT_WORKFLOW_ID_PREFIX;
  return prefix ? { ...FRAMEWORKS[name], workflowIdPrefix: prefix } : FRAMEWORKS[name];
}

if (require.main === module) {
  // ts-node frameworks.ts <script> <framework>: the start scripts check their argument here, before
  // starting the API, and stop with the list of frameworks if it isn't one.
  const [script, name = ''] = process.argv.slice(2);
  const error = problem(name);
  if (error) {
    console.error(`${error} Usage: ${script} <ai-framework>, where <ai-framework> is one of:\n${validFrameworks()}`);
    process.exit(2);
  }
}
