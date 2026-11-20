import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from './App';

afterEach(() => {
  jest.restoreAllMocks();
});

// A fetch that answers /config with the given body (or fails it) and records every URL.
// history: the chat history every chat returns, or a function of the chat's workflow ID.
function mockApi(config, history = []) {
  const urls = [];
  global.fetch = jest.fn(async (url) => {
    urls.push(url);
    if (url.includes('/get-chat-history')) {
      // The history from the requested index on
      const params = new URL(url, 'http://localhost').searchParams;
      const events = typeof history === 'function' ? history(params.get('workflow_id')) : history;
      return { ok: true, json: async () => events.slice(Number(params.get('from_index'))) };
    }
    if (url.includes('/approve-compliance')) {
      return { ok: true, json: async () => ({ approved: ['OpenAccount-chat-123-Vacation-1'] }) };
    }
    if (url.endsWith('/config')) {
      if (config === null) throw new Error('no /config');
      return { ok: true, json: async () => config };
    }
    if (url.includes('/start-workflow')) {
      const framework = new URL(url, 'http://localhost').searchParams.get('framework');
      const workflowId = framework ? chatIdOf(framework) : CHAT_ID;
      return { ok: true, json: async () => ({ message: 'Workflow started.', workflow_id: workflowId }) };
    }
    return { ok: true, json: async () => [] };
  });
  return urls;
}

// The workflow ID the API picks for a new chat (it carries the browser's session)
const CHAT_ID = `pyai-temporal-agent-session-${'a'.repeat(32)}-chat-${'b'.repeat(16)}`;
const chatIdOf = (framework) => `${framework}-temporal-agent-session-${'a'.repeat(32)}-chat-${'c'.repeat(16)}`;

// GET /api/config for these frameworks
const framework = (name, label, available = true) => ({
  framework: name, label, tab_label: label, task_queue: `${name}-queue`,
  workflow_id_prefix: `${name}-temporal-agent-`, available,
});
const config = (...frameworks) => ({ frameworks });
const PYAI = config(framework('pyai', 'Pydantic AI'));

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
  const urls = mockApi(PYAI);
  render(<App />);
  expect(await screen.findByText('AI framework: Pydantic AI')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));

  await waitFor(() => expect(urls.some((u) => u.includes('/get-chat-history'))).toBe(true));
  expect(urls.find((u) => u.includes('/start-workflow'))).toBe('/api/start-workflow?framework=pyai');
  expect(workflowIdSentTo(urls, '/get-chat-history')).toBe(chatIdOf('pyai'));
  expect(urls.every((u) => u.startsWith('/api/'))).toBe(true);
});

test('with one framework, shows it in the header and no tabs', async () => {
  mockApi(config(framework('google_adk', 'Google ADK')));
  render(<App />);

  expect(await screen.findByText('AI framework: Google ADK')).toBeInTheDocument();
  expect(screen.queryByRole('tablist')).toBeNull();
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
  const urls = mockApi(PYAI, [
    status('New Vacation account status changed: Waiting Compliance Review'),
  ]);
  render(<App />);
  await screen.findByText('AI framework: Pydantic AI');
  fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));

  fireEvent.click(await screen.findByRole('button', { name: 'Approve compliance review' }));

  await waitFor(() => expect(urls.some((u) => u.includes('/approve-compliance'))).toBe(true));
  expect(workflowIdSentTo(urls, '/approve-compliance')).toBe(chatIdOf('pyai'));
  expect(await screen.findByRole('button', { name: 'Approving…' })).toBeDisabled();
});

test('shows no approve button for other statuses', async () => {
  mockApi(PYAI, [
    status('New Vacation account status changed: Waiting KYC'),
  ]);
  render(<App />);
  await screen.findByText('AI framework: Pydantic AI');
  fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));

  expect(await screen.findByText(/Waiting KYC/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Approve compliance review' })).toBeNull();
});

const reply = (prompt, text) => ({ type: 'chat_interaction', content: { user_prompt: prompt, text_response: text } });
const TWO = config(framework('strands', 'Strands'), framework('vai', 'Vercel AI'));

test('with several frameworks, shows a tab for each and the selected one in the header', async () => {
  mockApi(TWO);
  render(<App />);

  expect(await screen.findByRole('tab', { name: 'Strands' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: 'Vercel AI' })).toHaveAttribute('aria-selected', 'false');
  expect(screen.getByText('AI framework: Strands')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: 'Vercel AI' }));
  expect(screen.getByText('AI framework: Vercel AI')).toBeInTheDocument();
});

test('each tab keeps its own live chat on its own framework', async () => {
  const urls = mockApi(TWO, (workflowId) => (workflowId.startsWith('strands')
    ? [reply('Hi', 'Hello from Strands')] : [reply('Hi', 'Hello from Vercel')]));
  render(<App />);
  await screen.findByRole('tab', { name: 'Strands' });

  // Start a chat in the first tab, then in the second
  // Only the selected tab's chat is visible, so only its buttons are found
  fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));
  expect(await screen.findByText('Hello from Strands')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Vercel AI' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));
  expect(await screen.findByText('Hello from Vercel')).toBeInTheDocument();

  expect(urls.filter((u) => u.includes('/start-workflow'))).toEqual([
    '/api/start-workflow?framework=strands', '/api/start-workflow?framework=vai']);
  // Both chats keep running, each in its own tab
  expect(screen.getByText('Hello from Strands').closest('[hidden]')).not.toBeNull();
  expect(screen.getByText('Hello from Vercel').closest('[hidden]')).toBeNull();
  expect(screen.getAllByRole('button', { name: 'End Chat', hidden: true })).toHaveLength(2);
  expect(screen.getByRole('tab', { name: /Strands/ }).querySelector('.tab-live')).not.toBeNull();
});

test('marks a hidden tab that gets a reply until it is shown', async () => {
  let strandsHistory = [];
  mockApi(TWO, (workflowId) => (workflowId.startsWith('strands') ? strandsHistory : []));
  render(<App />);
  await screen.findByRole('tab', { name: 'Strands' });
  fireEvent.click(screen.getByRole('button', { name: 'Start Chat' }));
  await screen.findByRole('button', { name: 'End Chat' });

  fireEvent.click(screen.getByRole('tab', { name: 'Vercel AI' }));
  strandsHistory = [reply('Hi', 'A late reply')];
  const strandsTab = screen.getByRole('tab', { name: /Strands/ });
  await waitFor(() => expect(strandsTab.querySelector('.tab-unseen')).not.toBeNull(), { timeout: 7000 });

  fireEvent.click(strandsTab);
  expect(strandsTab.querySelector('.tab-unseen')).toBeNull();
  expect(screen.getByText('A late reply')).toBeInTheDocument();
}, 10000);

test("a framework without a worker can't start a chat, and says why", async () => {
  mockApi(config(framework('strands', 'Strands'), { ...framework('vai', 'Vercel AI', false), label: 'Vercel AI SDK' }));
  render(<App />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Vercel AI' }));

  expect(screen.getByText(/No worker is running Vercel AI SDK chats \(task queue vai-queue\)/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start Chat' })).toBeDisabled();
});
