// Links to workflows in the Temporal UI the API names (GET /api/config's temporal_ui: {url, namespace}), in the form
// <url>/namespaces/<namespace>/workflows/<workflow ID>. On Temporal Cloud, opening one needs a Cloud sign-in with
// access to the namespace.
import React from 'react';

// The workflow's page in the Temporal UI, or null when there's no UI or no workflow
export function workflowUrl(temporalUi, workflowId) {
  if (!temporalUi || !temporalUi.url || !temporalUi.namespace || !workflowId) return null;
  return `${temporalUi.url}/namespaces/${encodeURIComponent(temporalUi.namespace)}/workflows/${encodeURIComponent(workflowId)}`;
}

// A link that opens the workflow in the Temporal UI in a new tab, or nothing
export function TemporalLink({ temporalUi, workflowId, children, title }) {
  const href = workflowUrl(temporalUi, workflowId);
  if (!href) return null;
  return (
    <a className="temporal-link" href={href} target="_blank" rel="noopener noreferrer" title={title || workflowId}>
      {children}
    </a>
  );
}
