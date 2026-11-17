// No imports: safe to use in workflow code.

/**
 * A dollar amount such as $1,234.50. Locale-independent and safe in workflow code, so a replay
 * formats amounts exactly as the original run did.
 */
export function formatUsd(amount: number): string {
  const [whole, cents] = Math.abs(amount).toFixed(2).split('.');
  return `${amount < 0 ? '-' : ''}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}
