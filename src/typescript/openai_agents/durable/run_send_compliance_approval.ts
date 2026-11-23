/**
 * Sends compliance_approved to an open-account workflow: what a compliance officer does from outside
 * the chat. Usage: localsendcomplianceapproval.sh <workflow ID>
 */
import { ClientHelper } from '../../common/client-helper';
import { claimCheckStatus, DEFAULT_TASK_QUEUE } from '../oai_lib/config';
import { COMPLIANCE_APPROVED_SIGNAL } from './shared';

async function approve(workflowId: string): Promise<void> {
  console.log(claimCheckStatus());
  const { connection, client } = await new ClientHelper(DEFAULT_TASK_QUEUE).connectClient();
  try {
    await client.workflow.getHandle(workflowId).signal(COMPLIANCE_APPROVED_SIGNAL);
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
