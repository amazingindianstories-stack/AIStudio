/** Display a persisted cost in cents. Billing is computed by Django. */
export function formatCost(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
