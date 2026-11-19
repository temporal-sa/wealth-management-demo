import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from './App';

afterEach(() => {
  jest.restoreAllMocks();
});

// A fetch that answers /config with the given body (or fails it) and records every URL.
function mockApi(config, history = []) {
  const urls = [];
  global.fetch = jest.fn(async (url) => {
    urls.push(url);
    if (url.includes('/get-chat-history')) {
      // The history from the requested index on
      const from = Number(new URL(url).searchParams.get('from_index'));
      return { ok: true, json: async () => history.slice(from) };
    }
    if (url.includes('/approve-compliance')) {
      return { ok: true, json: async () => ({ approved: ['OpenAccount-chat-123-Vacation-1'] }) };
    }
    if (url.endsWith('/config')) {
      if (config === null) throw new Error('no /config');
      return { ok: true, json: async () => config };
    }
    if (url.includes('/start-workflow')) {
      return { ok: true, json: async () => ({ message: 'Workflow started.' }) };
    }
    return { ok: true, json: async () => [] };
  });
  return urls;
}

const startedWorkflowId = (urls) => {
  const url = urls.find((u) => u.includes('/start-workflow'));
  return new URL(url).searchParams.get('workflow_id');
};

test('renders the chat with a Start Chat button', () => {
  render(<App />);
  expect(screen.getByRole('button', { name: 'Start Chat' })).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Type a message...')).toBeDisabled();
});

test("names the chat workflow after the API's AI framework", async () => {
  const urls = mockApi({ framework: 'pyai', workflow_id_prefix: 'pyai-temporal-agent-' });
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));

  await waitFor(() => expect(urls.some((u) => u.includes('/start-workflow'))).toBe(true));
  expect(startedWorkflowId(urls)).toMatch(/^pyai-temporal-agent-[a-z0-9]+$/);
});

test('shows the AI framework the API serves in the header', async () => {
  mockApi({ framework: 'google_adk', label: 'Google ADK', workflow_id_prefix: 'adk-temporal-agent-' });
  render(<App />);

  expect(await screen.findByText('AI framework: Google ADK')).toBeInTheDocument();
});

test('falls back to the default prefix when the API has no /config', async () => {
  const urls = mockApi(null);
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));

  await waitFor(() => expect(urls.some((u) => u.includes('/start-workflow'))).toBe(true));
  expect(startedWorkflowId(urls)).toMatch(/^oai-temporal-agent-[a-z0-9]+$/);
  expect(screen.queryByText(/AI framework:/)).toBeNull();
});

const status = (text) => ({ type: 'status_update', content: { status: text } });

test('approves compliance review from a button while an account opening waits for it', async () => {
  const urls = mockApi({ framework: 'pyai', workflow_id_prefix: 'pyai-temporal-agent-' }, [
    status('New Vacation account status changed: Waiting Compliance Review'),
  ]);
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));

  fireEvent.click(await screen.findByRole('button', { name: 'Approve compliance review' }));

  await waitFor(() => expect(urls.some((u) => u.includes('/approve-compliance'))).toBe(true));
  const approval = new URL(urls.find((u) => u.includes('/approve-compliance')));
  expect(approval.searchParams.get('workflow_id')).toBe(startedWorkflowId(urls));
  expect(await screen.findByRole('button', { name: 'Approving…' })).toBeDisabled();
});

test('shows no approve button for other statuses', async () => {
  mockApi({ framework: 'pyai', workflow_id_prefix: 'pyai-temporal-agent-' }, [
    status('New Vacation account status changed: Waiting KYC'),
  ]);
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));

  expect(await screen.findByText(/Waiting KYC/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Approve compliance review' })).toBeNull();
});
