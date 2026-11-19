import { render, screen } from '@testing-library/react';
import Markdown from './Markdown';

const html = (text) => render(<Markdown text={text} />).container.innerHTML;

test('renders bold, italic and code', () => {
  render(<Markdown text={'**Checking**: $1,000.00, *pending* and `ACC-1`'} />);
  expect(screen.getByText('Checking').tagName).toBe('STRONG');
  expect(screen.getByText('pending').tagName).toBe('EM');
  expect(screen.getByText('ACC-1').tagName).toBe('CODE');
});

test('renders bulleted and numbered lists', () => {
  const out = html('Your accounts:\n- **Checking**: $1,000\n- Savings: $2,000\n\n1. First\n2. Second');
  expect(out).toContain('<ul><li><strong>Checking</strong>: $1,000</li><li>Savings: $2,000</li></ul>');
  expect(out).toContain('<ol start="1"><li>First</li><li>Second</li></ol>');
});

test('keeps line breaks inside a paragraph and drops blank-line runs', () => {
  const out = html('Line one\nLine two\n\n\n\nNext paragraph');
  expect(out).toBe('<div class="markdown"><p>Line one<br>Line two</p><p>Next paragraph</p></div>');
});

test('renders headings as bold lines', () => {
  render(<Markdown text={'## Summary\nAll good'} />);
  expect(screen.getByText('Summary').tagName).toBe('STRONG');
});

test('renders only http(s) links, opening in a new tab', () => {
  render(<Markdown text={'See [docs](https://temporal.io) or [bad](javascript:alert(1))'} />);
  const link = screen.getByRole('link', { name: 'docs' });
  expect(link).toHaveAttribute('href', 'https://temporal.io');
  expect(link).toHaveAttribute('target', '_blank');
  expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
});

test('shows HTML as text, not markup', () => {
  const out = html('<img src=x onerror=alert(1)> **hi**');
  expect(out).not.toContain('<img');
  expect(out).toContain('&lt;img');
});

test('leaves lone asterisks and snake_case alone', () => {
  const out = html('5 * 3 = 15 and account_id_value');
  expect(out).toBe('<div class="markdown"><p>5 * 3 = 15 and account_id_value</p></div>');
});
