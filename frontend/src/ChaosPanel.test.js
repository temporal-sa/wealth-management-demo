import { render, screen, waitFor } from '@testing-library/react';
import ChaosPanel from './ChaosPanel';

afterEach(() => {
  jest.restoreAllMocks();
});

const flag = (name, label) => ({ flag: name, label, description: '', enabled: false });
const LOCAL_FLAGS = [
  flag('tool_down', 'Core banking API down'),
  flag('llm_down', 'LLM API down'),
  flag('llm_rate_limited', 'LLM rate limited (429)'),
  flag('custodian_rejects', 'Custodian rejects new accounts'),
  flag('slow_saga', 'Slow account-opening steps'),
  flag('workflow_bug', 'Bug in workflow code'),
];

function mockChaos(flags) {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ flags, events: [] }) }));
}

// The scenario titles under "Demo scenarios"
const scenarioTitles = () =>
  Array.from(document.querySelectorAll('.chaos-scenario strong')).map((el) => el.textContent);

test('shows every scenario when the API offers every switch', async () => {
  mockChaos(LOCAL_FLAGS);
  render(<ChaosPanel />);
  await screen.findByText('Core banking API down');
  expect(scenarioTitles()).toEqual([
    'Tool / API down',
    'LLM down or rate limited',
    'Business rule (non-retryable)',
    'Saga rollback',
    'Bug in workflow code',
  ]);
});

test('leaves out a scenario whose switch the API does not offer (the hosted demo has no bug switch)', async () => {
  mockChaos(LOCAL_FLAGS.filter((f) => f.flag !== 'workflow_bug'));
  render(<ChaosPanel />);
  await screen.findByText('Core banking API down');
  expect(scenarioTitles()).not.toContain('Bug in workflow code');
  expect(scenarioTitles()).toHaveLength(4);
});

test('keeps a scenario while any one of its switches is offered', async () => {
  mockChaos([flag('llm_rate_limited', 'LLM rate limited (429)')]);
  render(<ChaosPanel />);
  await screen.findByText('LLM rate limited (429)');
  await waitFor(() =>
    expect(scenarioTitles()).toEqual(['LLM down or rate limited', 'Business rule (non-retryable)', 'Saga rollback']));
});
