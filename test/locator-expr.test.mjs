import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocator, isLocatorExpression, parseLocator } from '../dist/utils/locator-expr.js';

test('parseLocator: role + name object', () => {
  const chain = parseLocator("page.getByRole('button', { name: 'Save', exact: true })");
  assert.deepEqual(chain, [{ method: 'getByRole', args: ['button', { name: 'Save', exact: true }] }]);
  assert.equal(formatLocator(chain), "getByRole('button', { name: 'Save', exact: true })");
});

test('parseLocator: chains, regex, nth, filter and double quotes', () => {
  const chain = parseLocator('getByTestId("row").filter({ hasText: /total/i }).nth(2)');
  assert.equal(chain.length, 3);
  assert.deepEqual(chain[1].args[0], { hasText: { $regex: 'total', flags: 'i' } });
  assert.equal(formatLocator(chain), "getByTestId('row').filter({ hasText: /total/i }).nth(2)");
});

test('parseLocator: a plain selector becomes locator(selector)', () => {
  assert.deepEqual(parseLocator('#cta'), [{ method: 'locator', args: ['#cta'] }]);
  assert.deepEqual(parseLocator('text=Buy now'), [{ method: 'locator', args: ['text=Buy now'] }]);
  assert.equal(isLocatorExpression('#cta'), false);
  assert.equal(isLocatorExpression("await page.getByLabel('Email')"), true);
});

test('parseLocator: refuses anything that is not a plain literal call chain', () => {
  const bad = [
    "getByRole('button').click()",
    "getByText(`${evil}`)",
    "getByText(foo)",
    "locator('#a').evaluate(() => 1)",
    "getByRole('button', { name: process.env.X })",
    "getByRole('button', { __proto__: 'x' })",
    "getByTestId('a'); require('fs')",
  ];
  for (const input of bad) {
    assert.throws(() => parseLocator(input), /Cannot parse locator/, input);
  }
});

test('parseLocator: argument shapes are checked per method', () => {
  assert.throws(() => parseLocator("getByRole('a').nth('x')"), /nth\(\) takes a number/);
  assert.throws(() => parseLocator("getByRole('a').filter({ has: 'x' })"), /not supported/);
  assert.throws(() => parseLocator('locator(1)'), /selector string/);
});
