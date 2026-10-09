/**
 * Safe parsing of Playwright locator expressions.
 *
 * Agents and tests speak in locators — `getByRole('button', { name: 'Save' })`,
 * `getByTestId('cart')`, `locator('#cta').first()` — not just CSS. This module
 * turns such an expression into a plain JSON chain of whitelisted method calls
 * that the browser child script replays against a real page. Nothing is ever
 * evaluated as code: the parser accepts only string, number, boolean, regex
 * and flat object literals, and only the methods listed in LOCATOR_METHODS.
 *
 * A bare string that is not a call chain (`#cta`, `text=Buy`, `role=button`)
 * becomes `locator(<string>)`, so every Playwright selector engine works too.
 */

import { PlaywrightMcpError } from '../types/index.js';

/** A JSON-safe regex literal (RegExp does not survive JSON.stringify). */
export interface RegexValue {
  $regex: string;
  flags: string;
}

export type LocatorArg = string | number | boolean | RegexValue | { [key: string]: LocatorArg };

export interface LocatorCall {
  method: LocatorMethod;
  args: LocatorArg[];
}

export const LOCATOR_METHODS = [
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
  'getByTestId',
  'locator',
  'first',
  'last',
  'nth',
  'filter',
] as const;

export type LocatorMethod = (typeof LOCATOR_METHODS)[number];

const METHOD_SET = new Set<string>(LOCATOR_METHODS);
const MAX_EXPRESSION_CHARS = 2_000;
const MAX_CALLS = 8;

class Cursor {
  pos = 0;
  constructor(readonly src: string) {}

  skipSpace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos += 1;
  }

  peek(): string {
    this.skipSpace();
    return this.src[this.pos] ?? '';
  }

  eat(ch: string): boolean {
    if (this.peek() === ch) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  expect(ch: string): void {
    if (!this.eat(ch)) this.fail(`expected "${ch}"`);
  }

  ident(): string {
    this.skipSpace();
    const match = /^[A-Za-z_$][\w$]*/.exec(this.src.slice(this.pos));
    if (!match) this.fail('expected a name');
    this.pos += match![0].length;
    return match![0];
  }

  done(): boolean {
    this.skipSpace();
    return this.pos >= this.src.length;
  }

  fail(message: string): never {
    throw new PlaywrightMcpError(`Cannot parse locator: ${message} at position ${this.pos + 1}`, 'INVALID_PATH', {
      hint: 'Use a Playwright locator such as getByRole(\'button\', { name: \'Save\' }), getByTestId(\'cart\'), locator(\'#cta\').first(), or a plain selector string.',
    });
  }
}

function parseString(c: Cursor): string {
  const quote = c.peek();
  if (quote !== "'" && quote !== '"' && quote !== '`') c.fail('expected a string');
  c.pos += 1;
  let out = '';
  while (c.pos < c.src.length) {
    const ch = c.src[c.pos];
    if (ch === quote) {
      c.pos += 1;
      return out;
    }
    if (quote === '`' && ch === '$' && c.src[c.pos + 1] === '{') c.fail('template expressions are not allowed');
    if (ch === '\\') {
      const next = c.src[c.pos + 1];
      const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '`': '`' };
      out += escapes[next] ?? next ?? '';
      c.pos += 2;
      continue;
    }
    out += ch;
    c.pos += 1;
  }
  return c.fail('unterminated string');
}

function parseRegex(c: Cursor): RegexValue {
  c.expect('/');
  let source = '';
  let inClass = false;
  while (c.pos < c.src.length) {
    const ch = c.src[c.pos];
    if (ch === '\\') {
      source += ch + (c.src[c.pos + 1] ?? '');
      c.pos += 2;
      continue;
    }
    if (ch === '[') inClass = true;
    if (ch === ']') inClass = false;
    if (ch === '/' && !inClass) {
      c.pos += 1;
      const flags = /^[dgimsuy]*/.exec(c.src.slice(c.pos))![0];
      c.pos += flags.length;
      try {
        new RegExp(source, flags);
      } catch {
        c.fail('invalid regular expression');
      }
      return { $regex: source, flags };
    }
    source += ch;
    c.pos += 1;
  }
  return c.fail('unterminated regular expression');
}

function parseValue(c: Cursor, depth: number): LocatorArg {
  const ch = c.peek();
  if (ch === "'" || ch === '"' || ch === '`') return parseString(c);
  if (ch === '/') return parseRegex(c);
  if (ch === '{') {
    if (depth > 1) c.fail('objects nest too deeply');
    c.pos += 1;
    const obj: { [key: string]: LocatorArg } = {};
    while (!c.eat('}')) {
      const keyChar = c.peek();
      const key = keyChar === "'" || keyChar === '"' ? parseString(c) : c.ident();
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') c.fail(`key "${key}" is not allowed`);
      c.expect(':');
      obj[key] = parseValue(c, depth + 1);
      if (!c.eat(',')) {
        c.expect('}');
        break;
      }
    }
    return obj;
  }
  const rest = c.src.slice(c.pos);
  const num = /^-?\d+(\.\d+)?/.exec(rest);
  if (num) {
    c.pos += num[0].length;
    return Number(num[0]);
  }
  if (rest.startsWith('true')) {
    c.pos += 4;
    return true;
  }
  if (rest.startsWith('false')) {
    c.pos += 5;
    return false;
  }
  return c.fail('expected a string, number, boolean, regex or { … } object');
}

/** True when the input looks like a call chain rather than a selector string. */
export function isLocatorExpression(input: string): boolean {
  const trimmed = input.trim().replace(/^await\s+/, '');
  return /^(page\s*\.\s*)?(getBy(Role|Text|Label|Placeholder|AltText|Title|TestId)|locator)\s*\(/.test(trimmed);
}

/**
 * Parse a locator expression or selector into a whitelisted call chain.
 * Throws INVALID_PATH with a usable hint on anything else.
 */
export function parseLocator(input: string): LocatorCall[] {
  const raw = input.trim().replace(/;$/, '').trim();
  if (raw === '') {
    throw new PlaywrightMcpError('Locator is empty', 'INVALID_PATH', { hint: 'Pass a selector or a Playwright locator.' });
  }
  if (raw.length > MAX_EXPRESSION_CHARS) {
    throw new PlaywrightMcpError('Locator is too long', 'INVALID_PATH', {
      hint: `Keep locators under ${MAX_EXPRESSION_CHARS} characters.`,
    });
  }
  if (!isLocatorExpression(raw)) return [{ method: 'locator', args: [raw] }];

  const c = new Cursor(raw.replace(/^await\s+/, ''));
  const calls: LocatorCall[] = [];
  const first = c.ident();
  if (first === 'page') c.expect('.');
  else c.pos = 0;

  do {
    const method = c.ident();
    if (!METHOD_SET.has(method)) c.fail(`method "${method}" is not supported`);
    c.expect('(');
    const args: LocatorArg[] = [];
    if (!c.eat(')')) {
      for (;;) {
        args.push(parseValue(c, 0));
        if (c.eat(')')) break;
        c.expect(',');
      }
    }
    calls.push({ method: method as LocatorMethod, args });
    if (calls.length > MAX_CALLS) c.fail(`more than ${MAX_CALLS} chained calls`);
  } while (c.eat('.'));

  if (!c.done()) c.fail('unexpected trailing text');
  validateCalls(calls);
  return calls;
}

function validateCalls(calls: LocatorCall[]): void {
  for (const call of calls) {
    const [a0] = call.args;
    switch (call.method) {
      case 'first':
      case 'last':
        if (call.args.length !== 0) throw bad(`${call.method}() takes no arguments`);
        break;
      case 'nth':
        if (typeof a0 !== 'number') throw bad('nth() takes a number');
        break;
      case 'filter':
        if (typeof a0 !== 'object' || a0 === null || '$regex' in a0) throw bad('filter() takes { hasText } or { hasNotText }');
        for (const key of Object.keys(a0)) {
          if (key !== 'hasText' && key !== 'hasNotText' && key !== 'visible') throw bad(`filter option "${key}" is not supported`);
        }
        break;
      case 'locator':
        if (typeof a0 !== 'string') throw bad('locator() takes a selector string');
        break;
      default:
        if (typeof a0 !== 'string' && !(typeof a0 === 'object' && a0 !== null && '$regex' in a0)) {
          throw bad(`${call.method}() takes a string or regex first argument`);
        }
    }
  }
}

function bad(message: string): PlaywrightMcpError {
  return new PlaywrightMcpError(`Cannot parse locator: ${message}`, 'INVALID_PATH', {
    hint: 'Supported: getByRole/Text/Label/Placeholder/AltText/Title/TestId, locator, first, last, nth, filter({ hasText }).',
  });
}

function formatArg(arg: LocatorArg): string {
  if (typeof arg === 'string') return quote(arg);
  if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
  if ('$regex' in arg && typeof arg.$regex === 'string') return `/${arg.$regex}/${String(arg.flags ?? '')}`;
  const entries = Object.entries(arg).map(([key, value]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key)}: ${formatArg(value)}`);
  return `{ ${entries.join(', ')} }`;
}

/** Single-quoted JS string literal. */
export function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

/** Render a chain back to source, e.g. `getByRole('button', { name: 'Save' })`. */
export function formatLocator(calls: LocatorCall[]): string {
  return calls.map((call) => `${call.method}(${call.args.map(formatArg).join(', ')})`).join('.');
}
