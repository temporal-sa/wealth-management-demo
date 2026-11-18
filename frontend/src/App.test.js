import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
