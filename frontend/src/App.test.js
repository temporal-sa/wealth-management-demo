import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from './App';

afterEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
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
    if (url.endsWith('/chaos')) {
      return { ok: true, json: async () => ({ flags: [], events: [] }) };
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
const framework = (name, label, available = true, language = 'Python') => ({
  framework: name, label, language, short_label: label, task_queue: `${name}-queue`,
  workflow_id_prefix: `${name}-temporal-agent-`, available,
});

// The title of the chat that's shown
const shownTitle = () => document.querySelector('.chat-pane:not([hidden]) .framework')?.textContent;
const config = (...frameworks) => ({ frameworks });
const PYAI = config(framework('pyai', 'Pydantic AI'));

// The workflow_id parameter of the first call to this path
const workflowIdSentTo = (urls, path) => {
  const url = urls.find((u) => u.includes(path));
  return url && new URL(url, 'http://localhost').searchParams.get('workflow_id');
};

test('renders the chat with a Start chat button', () => {
  render(<App />);
  expect(screen.getByRole('button', { name: 'Start chat' })).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Type a message...')).toBeDisabled();
});

test('starts a chat with the workflow ID the API picks, calling the API on its own origin', async () => {
  const urls = mockApi(PYAI);
  render(<App />);
  await screen.findByRole('tab', { name: /Pydantic AI/ });
  expect(shownTitle()).toBe('Pydantic AI');

  fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));

  await waitFor(() => expect(urls.some((u) => u.includes('/get-chat-history'))).toBe(true));
  expect(urls.find((u) => u.includes('/start-workflow'))).toBe('/api/start-workflow?framework=pyai');
  expect(workflowIdSentTo(urls, '/get-chat-history')).toBe(chatIdOf('pyai'));
  expect(urls.every((u) => u.startsWith('/api/'))).toBe(true);
});

test('with one framework, lists it and shows its chat with its language and task queue', async () => {
  mockApi(config(framework('google_adk_go', 'Google ADK (Go)', true, 'Go')));
  render(<App />);

  expect(await screen.findByRole('tab', { name: /Google ADK \(Go\)/ })).toHaveAttribute('aria-selected', 'true');
  expect(shownTitle()).toBe('Google ADK (Go)');
  expect(screen.getByText('Go · google_adk_go-queue')).toBeInTheDocument();
});

test('still starts a chat when /config fails, without a framework', async () => {
  const urls = mockApi(null);
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));

  await waitFor(() => expect(urls.some((u) => u.includes('/get-chat-history'))).toBe(true));
  expect(workflowIdSentTo(urls, '/get-chat-history')).toBe(CHAT_ID);
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
  expect(shownTitle()).toBe('Wealth Management Chatbot');
});

const status = (text) => ({ type: 'status_update', content: { status: text } });

test('approves compliance review from a button while an account opening waits for it', async () => {
  const urls = mockApi(PYAI, [
    status('New Vacation account status changed: Waiting Compliance Review'),
  ]);
  render(<App />);
  await screen.findByRole('tab', { name: /Pydantic AI/ });
  fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));

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
  await screen.findByRole('tab', { name: /Pydantic AI/ });
  fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));

  expect(await screen.findByText(/Waiting KYC/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Approve compliance review' })).toBeNull();
});

const reply = (prompt, text) => ({ type: 'chat_interaction', content: { user_prompt: prompt, text_response: text } });
const TWO = config(framework('strands', 'Strands'), framework('vai', 'Vercel AI', true, 'TypeScript'));

test('with several frameworks, lists them grouped by language and shows the selected one', async () => {
  mockApi(TWO);
  render(<App />);

  expect(await screen.findByRole('tab', { name: 'Strands' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: 'Vercel AI' })).toHaveAttribute('aria-selected', 'false');
  expect([...document.querySelectorAll('.framework-group-label')].map((g) => g.textContent)).toEqual(['Python', 'TypeScript']);
  expect(shownTitle()).toBe('Strands');

  fireEvent.click(screen.getByRole('tab', { name: 'Vercel AI' }));
  expect(shownTitle()).toBe('Vercel AI');
});

test('offers a filter once there are many frameworks', async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  mockApi(config(...names.map((n) => framework(n, `Framework ${n.toUpperCase()}`))));
  render(<App />);
  await screen.findByRole('tab', { name: 'Framework A' });

  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter frameworks' }), { target: { value: 'framework g' } });
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Framework G']);
});

test('with few frameworks, there is no filter', async () => {
  mockApi(TWO);
  render(<App />);
  await screen.findByRole('tab', { name: 'Strands' });
  expect(screen.queryByRole('searchbox')).toBeNull();
});

test('each tab keeps its own live chat on its own framework', async () => {
  const urls = mockApi(TWO, (workflowId) => (workflowId.startsWith('strands')
    ? [reply('Hi', 'Hello from Strands')] : [reply('Hi', 'Hello from Vercel')]));
  render(<App />);
  await screen.findByRole('tab', { name: 'Strands' });

  // Start a chat in the first tab, then in the second
  // Only the selected tab's chat is visible, so only its buttons are found
  fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
  expect(await screen.findByText('Hello from Strands')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Vercel AI' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
  expect(await screen.findByText('Hello from Vercel')).toBeInTheDocument();

  expect(urls.filter((u) => u.includes('/start-workflow'))).toEqual([
    '/api/start-workflow?framework=strands', '/api/start-workflow?framework=vai']);
  // Both chats keep running, each in its own tab
  expect(screen.getByText('Hello from Strands').closest('[hidden]')).not.toBeNull();
  expect(screen.getByText('Hello from Vercel').closest('[hidden]')).toBeNull();
  expect(screen.getAllByRole('button', { name: 'End chat', hidden: true })).toHaveLength(2);
  expect(screen.getByRole('tab', { name: /Strands/ }).querySelector('.dot.live')).not.toBeNull();
});

test('counts the news a hidden chat gets until it is shown', async () => {
  let strandsHistory = [];
  mockApi(TWO, (workflowId) => (workflowId.startsWith('strands') ? strandsHistory : []));
  render(<App />);
  await screen.findByRole('tab', { name: 'Strands' });
  fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
  await screen.findByRole('button', { name: 'End chat' });

  fireEvent.click(screen.getByRole('tab', { name: 'Vercel AI' }));
  strandsHistory = [reply('Hi', 'A late reply')];
  const strandsTab = screen.getByRole('tab', { name: /Strands/ });
  await waitFor(() => expect(strandsTab.querySelector('.unseen')?.textContent).toBe('1'), { timeout: 7000 });

  fireEvent.click(strandsTab);
  expect(strandsTab.querySelector('.unseen')).toBeNull();
  expect(screen.getByText('A late reply')).toBeInTheDocument();
}, 10000);

test("a framework without a worker can't start a chat, and says why", async () => {
  mockApi(config(framework('strands', 'Strands'), { ...framework('vai', 'Vercel AI', false), label: 'Vercel AI SDK' }));
  render(<App />);
  const tab = await screen.findByRole('tab', { name: /Vercel AI/ });
  expect(tab).toHaveTextContent('no worker');
  fireEvent.click(tab);

  expect(screen.getByText('No worker is running Vercel AI SDK chats')).toBeInTheDocument();
  expect(screen.getByText(/task queue vai-queue/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start chat' })).toBeDisabled();
});

test('colors the status line by the opening\'s state', () => {
  const { statusTone } = require('./ChatPane');
  expect(statusTone('New Vacation account status changed: Waiting KYC')).toBe('warning');
  expect(statusTone('New Vacation account status changed: Complete')).toBe('success');
  expect(statusTone('New Vacation account status changed: Rolled back')).toBe('danger');
  expect(statusTone('New Vacation account status changed: Initializing')).toBe('neutral');
});

test('shows how many chaos flags are on in the sidebar', async () => {
  const original = mockApi(TWO);
  const fetchBefore = global.fetch;
  global.fetch = jest.fn(async (url) => (url.endsWith('/chaos')
    ? { ok: true, json: async () => ({ flags: [{ enabled: true }, { enabled: true }, { enabled: false }], events: [] }) }
    : fetchBefore(url)));
  render(<App />);
  expect(await screen.findByText('2 on')).toBeInTheDocument();
  expect(original).toBeDefined();
});

test('the chaos button says what clicking it does', async () => {
  mockApi(TWO);
  render(<App />);
  await screen.findByRole('tab', { name: 'Strands' });

  fireEvent.click(screen.getByRole('button', { name: 'Show chaos panel' }));
  expect(await screen.findByText('Chaos panel')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Hide chaos panel' }));
  expect(screen.queryByText('Chaos panel')).toBeNull();
  expect(screen.getByRole('button', { name: 'Show chaos panel' })).toBeInTheDocument();
});

test('with no chaos flags on, the chaos button shows no count', async () => {
  mockApi(TWO);
  render(<App />);
  await screen.findByRole('tab', { name: 'Strands' });
  expect(screen.getByRole('button', { name: 'Show chaos panel' })).toHaveTextContent(/^Show chaos panel$/);
});

test("shows each running framework's model, and the build at the bottom of the sidebar", async () => {
  mockApi({
    build: 'v-1234abcd',
    frameworks: [
      { ...framework('pure', 'Pure Python'), model: 'anthropic/claude-haiku-5-5' },
      { ...framework('strands', 'Strands', false), model: null },
    ],
  });
  render(<App />);
  expect(await screen.findByText('anthropic/claude-haiku-5-5')).toBeInTheDocument();
  expect(screen.getByText('Build v-1234abcd')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /Pure Python/ })).toHaveAttribute(
    'title', expect.stringContaining('model anthropic/claude-haiku-5-5'));
  expect(document.querySelectorAll('.framework-model')).toHaveLength(1);
});

test('shows no model or build when the API reports none', async () => {
  mockApi(PYAI);
  render(<App />);
  await screen.findByRole('tab', { name: /Pydantic AI/ });
  expect(document.querySelector('.framework-model')).toBeNull();
  expect(document.querySelector('.build-info')).toBeNull();
});
