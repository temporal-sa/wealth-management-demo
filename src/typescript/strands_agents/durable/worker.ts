/**
 * The worker: the chat and open-account workflows and every activity on TEMPORAL_TASK_QUEUE, and the
 * model calls on their own task queue (<TEMPORAL_TASK_QUEUE>-llm, or TEMPORAL_TASK_QUEUE_LLM), where
 * LLM_MAX_CALLS_PER_SECOND has the Temporal service cap their rate across all workers.
 *
 * Usage: startlocalworker.sh [java | open-account task queue]. With java, the open-account workflow
 * runs on this framework's <task queue>-open-account (the Java worker in interop/open_account/java) and
 * this worker doesn't register it.
 */
import { DefaultLogger, LogEntry, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { StrandsPlugin } from '@temporalio/strands-agents';
import { ClientHelper, getSharedClient } from '../../common/client-helper';
import { claimCheckStatus, DEFAULT_TASK_QUEUE, llmMaxCallsPerSecond, loadWorkerConfig } from '../strands_lib/config';
import { MODEL_NAME } from '../strands_lib/model-name';
import { buildDataConverter } from '../../common/data-converter';
import { DataStore } from '../strands_lib/data-store';
import { createActivities } from './activities';
import { geminiModel, withChaos } from './chaos-model';
import { RedisEventStream } from './redis/event-stream-manager';
import { workflowsModule } from './worker-workflows';

// One line per log entry, without the SDK's internal metadata
const SKIP_KEYS = new Set([
  'sdkComponent',
  'taskQueue',
  'taskToken',
  'runId',
  'namespace',
  'workflowType',
  'workflowExists',
]);
Runtime.install({
  logger: new DefaultLogger('INFO', ({ level, message, meta }: LogEntry) => {
    const extras = Object.entries(meta ?? {})
      .filter(([k]) => !SKIP_KEYS.has(k))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`${ts} [${level.padEnd(5)}] ${message}${extras ? '  ' + extras : ''}`);
  }),
});

async function run(): Promise<void> {
  console.error(claimCheckStatus());
  const helper = new ClientHelper(DEFAULT_TASK_QUEUE);
  const config = loadWorkerConfig();
  const ownOpenAccount = config.open_account_task_queue === config.task_queue;
  console.error(
    ownOpenAccount
      ? `Open-account workflow runs on this worker (task queue ${config.task_queue})`
      : `Open-account workflow runs on task queue ${config.open_account_task_queue}: start the Java worker on it`,
  );
  const maxCallsPerSecond = llmMaxCallsPerSecond();
  console.error(
    `Model ${config.model}; model calls run on task queue ${config.llm_task_queue}` +
      (maxCallsPerSecond ? `, limited to ${maxCallsPerSecond} per second` : ''),
  );
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    console.error(
      'Warning: no GEMINI_API_KEY is set (see scripts/setgeminikey.example); model calls will fail and retry.',
    );
  }

  const activities = createActivities({
    store: new DataStore(),
    events: new RedisEventStream(),
    client: getSharedClient,
    config,
  });
  // StrandsPlugin bundles the Strands SDK into the workflow sandbox and registers the model activities, which
  // build the Gemini model on the worker (with the chaos panel's model flags). One instance, shared by both
  // workers, so they register the same model activities.
  const plugin = new StrandsPlugin({ models: { [MODEL_NAME]: () => withChaos(geminiModel(config.model)) } });

  const connection = await NativeConnection.connect(helper.nativeConnectionOptions);
  try {
    const worker = await Worker.create({
      connection,
      namespace: helper.namespace,
      taskQueue: config.task_queue,
      workflowsPath: require.resolve(workflowsModule(ownOpenAccount)),
      activities,
      dataConverter: buildDataConverter(),
      plugins: [plugin],
    });
    const llmWorker = await Worker.create({
      connection,
      namespace: helper.namespace,
      taskQueue: config.llm_task_queue,
      dataConverter: buildDataConverter(),
      plugins: [plugin],
      maxTaskQueueActivitiesPerSecond: maxCallsPerSecond,
    });
    await Promise.all([worker.run(), llmWorker.run()]);
  } finally {
    await connection.close();
  }
}

run()
  // Exit once the workers have shut down (on SIGINT or SIGTERM): the Redis clients would keep the
  // process alive
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
