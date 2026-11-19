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
      const from = Number(new URL(url, 'http://localhost').searchParams.get('from_index'));
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
      return { ok: true, json: async () => ({ message: 'Workflow started.', workflow_id: CHAT_ID }) };
    }
    return { ok: true, json: async () => [] };
  });
  return urls;
}

// The workflow ID the API picks for a new chat (it carries the browser's session)
const CHAT_ID = `pyai-temporal-agent-session-${'a'.repeat(32)}-chat-${'b'.repeat(16)}`;

// The workflow_id parameter of the first call to this path
const workflowIdSentTo = (urls, path) => {
  const url = urls.find((u) => u.includes(path));
  return url && new URL(url, 'http://localhost').searchParams.get('workflow_id');
};

test('renders the chat with a Start Chat button', () => {
  render(<App />);
  expect(screen.getByRole('button', { name: 'Start Chat' })).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Type a message...')).toBeDisabled();
});

test('starts a chat with the workflow ID the API picks, calling the API on its own origin', async () => {
  const urls = mockApi({ framework: 'pyai', workflow_id_prefix: 'pyai-temporal-agent-' });
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));

  await waitFor(() => expect(urls.some((u) => u.includes('/get-chat-history'))).toBe(true));
  expect(urls.find((u) => u.includes('/start-workflow'))).toBe('/api/start-workflow');
  expect(workflowIdSentTo(urls, '/get-chat-history')).toBe(CHAT_ID);
  expect(urls.every((u) => u.startsWith('/api/'))).toBe(true);
});

test('shows the AI framework the API serves in the header', async () => {
  mockApi({ framework: 'google_adk', label: 'Google ADK', workflow_id_prefix: 'adk-temporal-agent-' });
  render(<App />);

  expect(await screen.findByText('AI framework: Google ADK')).toBeInTheDocument();
});

test('still starts a chat when /config fails, without a framework in the header', async () => {
  const urls = mockApi(null);
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));

  await waitFor(() => expect(urls.some((u) => u.includes('/get-chat-history'))).toBe(true));
  expect(workflowIdSentTo(urls, '/get-chat-history')).toBe(CHAT_ID);
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
  expect(workflowIdSentTo(urls, '/approve-compliance')).toBe(CHAT_ID);
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
