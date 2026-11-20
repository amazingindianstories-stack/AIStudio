import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Runs the named axe rules against the page (or one selector) and returns the failing rule ids with their nodes.
export async function axeViolations(page, rules, include) {
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  return page.evaluate(async ({ rules, include }) => {
    const result = await window.axe.run(include ? { include: [[include]] } : document, { runOnly: { type: 'rule', values: rules } });
    return result.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.slice(0, 5).map((node) => node.target.join(' ')) }));
  }, { rules, include });
}
