import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import App from './App';

afterEach(() => {
  jest.restoreAllMocks();
});

// A fetch that answers /config with the given body (or fails it) and records every URL.
function mockApi(config) {
  const urls = [];
  global.fetch = jest.fn(async (url) => {
    urls.push(url);
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

test("names the chat workflow after the API's port", async () => {
  const urls = mockApi({ port: 'pyai', workflow_id_prefix: 'pyai-temporal-agent-' });
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));

  await waitFor(() => expect(urls.some((u) => u.includes('/start-workflow'))).toBe(true));
  expect(startedWorkflowId(urls)).toMatch(/^pyai-temporal-agent-[a-z0-9]+$/);
});

test('falls back to the default prefix when the API has no /config', async () => {
  const urls = mockApi(null);
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));

  await waitFor(() => expect(urls.some((u) => u.includes('/start-workflow'))).toBe(true));
  expect(startedWorkflowId(urls)).toMatch(/^oai-temporal-agent-[a-z0-9]+$/);
});

// A fake API whose pending approval and chat history the test changes as it goes.
function fakeChatApi(config) {
  const api = { calls: [], pending: null, history: [] };
  global.fetch = jest.fn(async (url) => {
    api.calls.push(url);
    const ok = (body) => ({ ok: true, json: async () => body });
    if (url.endsWith('/config')) return ok(config);
    if (url.includes('/start-workflow')) return ok({ message: 'Workflow started.' });
    if (url.includes('/pending-approval')) return ok({ pending: api.pending });
    if (url.includes('/get-chat-history')) {
      const from = Number(new URL(url).searchParams.get('from_index'));
      return ok(api.history.slice(from));
    }
    return ok({});
  });
  return api;
}

async function sendMessage(text) {
  fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

const called = (api, path) => api.calls.filter((u) => u.includes(path));

test('answers a pending approval inline, and shows each message once', async () => {
  jest.useFakeTimers();
  try {
    const api = fakeChatApi({ workflow_id_prefix: 'strands-temporal-agent-', approvals: true });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Type a message...')).not.toBeDisabled());

    await act(async () => { await sendMessage('Delete Joan'); });
    expect(called(api, '/send-prompt')).toHaveLength(1);

    // The workflow pauses for approval; the next poll shows the question in the chat.
    api.pending = 'Delete beneficiary Joan Doe?';
    await act(async () => { jest.advanceTimersByTime(2000); });
    await waitFor(() => expect(screen.getByText('Delete beneficiary Joan Doe?')).toBeInTheDocument());

    // The reply goes to /approve, not to the chat.
    await act(async () => { await sendMessage('yes please'); });
    expect(called(api, '/approve')).toHaveLength(1);
    expect(new URL(called(api, '/approve')[0]).searchParams.get('response')).toBe('approve');
    expect(called(api, '/send-prompt')).toHaveLength(1);

    // The turn completes: its reply is added, the user's message isn't repeated.
    api.pending = null;
    api.history = [{ type: 'chat_interaction', content: { user_prompt: 'Delete Joan', text_response: 'Joan Doe was removed.' } }];
    await act(async () => { jest.advanceTimersByTime(2000); });
    await waitFor(() => expect(screen.getByText('Joan Doe was removed.')).toBeInTheDocument());
    expect(screen.getAllByText('Delete Joan')).toHaveLength(1);
    expect(screen.getAllByText('Delete beneficiary Joan Doe?')).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});

test('a reply that is not affirmative denies the approval', async () => {
  jest.useFakeTimers();
  try {
    const api = fakeChatApi({ workflow_id_prefix: 'strands-temporal-agent-', approvals: true });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Type a message...')).not.toBeDisabled());
    api.pending = 'Close the Vacation account?';
    await act(async () => { jest.advanceTimersByTime(5000); });
    await waitFor(() => expect(screen.getByText('Close the Vacation account?')).toBeInTheDocument());

    await act(async () => { await sendMessage('no, keep it'); });

    expect(new URL(called(api, '/approve')[0]).searchParams.get('response')).toBe('deny');
  } finally {
    jest.useRealTimers();
  }
});

test('ports without approvals never ask for one', async () => {
  jest.useFakeTimers();
  try {
    const api = fakeChatApi({ workflow_id_prefix: 'oai-temporal-agent-', approvals: false });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Type a message...')).not.toBeDisabled());
    await act(async () => { jest.advanceTimersByTime(12000); });

    expect(called(api, '/get-chat-history').length).toBeGreaterThan(1);
    expect(called(api, '/pending-approval')).toHaveLength(0);
  } finally {
    jest.useRealTimers();
  }
});
