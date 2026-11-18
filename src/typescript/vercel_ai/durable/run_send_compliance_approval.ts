import { clientHelper } from './task-queues';

async function approve(workflowId: string): Promise<void> {
  const helper = clientHelper();
  const { connection, client } = await helper.connectClient();

  try {
    const handle = client.workflow.getHandle(workflowId);
    await handle.signal('compliance_approved');
    console.log(`Compliance approval sent to workflow: ${workflowId}`);
  } finally {
    await connection.close();
  }
}

function parseArgs(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--workflow-id');
  if (idx === -1 || !args[idx + 1]) {
    console.error('Usage: ts-node run_send_compliance_approval.ts --workflow-id <workflow-id>');
    process.exit(1);
  }
  return args[idx + 1];
}

approve(parseArgs())
  // Exit explicitly: with the claim check on, the data converter keeps a Redis connection open
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });