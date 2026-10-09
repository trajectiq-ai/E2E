/**
 * The browser child script behind every page-facing tool (inspect-page,
 * validate-selector, compare-visual-state, generate-e2e-test, suggest-fix).
 *
 * It runs inside a child `node` process with cwd = project root so that
 * `createRequire(projectRoot/package.json)` resolves the *user's* Playwright
 * install (browsers included). It writes one JSON document to stdout and
 * always exits, so it can never wedge the server.
 *
 * Modes:
 * - inspect     element inventory (or a compact locator map with view: 'locators')
 * - validate    resolve a selector or locator chain, count and describe matches
 * - screenshot  capture the page or one element
 * - heal        rank elements that look like a broken locator's target, either
 *               on the live page or on a DOM snapshot taken from a trace
 *
 * Every element the script reports carries Playwright locators that were
 * proven, in this same page, to resolve to exactly that one element.
 */

export const PROBE_SCRIPT = String.raw`
'use strict';
const cfg = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));

function send(payload) {
  try { process.stdout.write(JSON.stringify(payload)); } catch (err) { /* ignore */ }
}

function classifyError(message) {
  const m = String(message);
  if (/Executable doesn't exist|Please run the following command to install/i.test(m)) {
    return { kind: 'NO_PLAYWRIGHT', hint: 'Playwright browsers are not installed for this project. Run: npx playwright install chromium' };
  }
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_EMPTY_RESPONSE|getaddrinfo|net::ERR_/i.test(m)) {
    return { kind: 'SERVER_NOT_RUNNING', hint: 'The URL is not reachable. Start your dev server (e.g. npm run dev / npm start) and retry.' };
  }
  if (/Timeout \d+ms exceeded|timed out/i.test(m)) {
    return { kind: 'TIMEOUT', hint: 'Raise timeoutMs, or make the page load faster.' };
  }
  if (/Target closed|browser has been closed|browser has crashed|Page crashed/i.test(m)) {
    return { kind: 'BROWSER_CRASH', hint: 'The browser crashed during inspection. Retry; if it persists run: npx playwright install --force' };
  }
  if (/Unknown selector|error evaluating selector|Unexpected token|is not a valid selector|Unknown engine/i.test(m)) {
    return { kind: 'INVALID_PATH', hint: 'The selector could not be evaluated.' };
  }
  return { kind: 'UNKNOWN', hint: undefined };
}

async function startGuardProxy(ranges) {
  const http = require('node:http');
  const net = require('node:net');
  const dns = require('node:dns').promises;
  const blocked = new net.BlockList();
  for (const r of ranges) blocked.addSubnet(r.address, r.prefix, r.family);
  const isBlocked = (a) => {
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
    if (m) return blocked.check(m[1], 'ipv4');
    const f = net.isIP(a);
    return f === 4 ? blocked.check(a, 'ipv4') : f === 6 ? blocked.check(a, 'ipv6') : true;
  };
  // Resolve once and connect to that exact address, so DNS cannot change
  // between the check and the connection.
  const allowedAddress = async (host) => {
    const bare = host.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(bare) ? [bare] : (await dns.lookup(bare, { all: true, verbatim: true })).map((x) => x.address);
    if (addrs.length === 0 || addrs.some(isBlocked)) return null;
    return addrs[0];
  };
  const server = http.createServer(async (req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch (err) {
      res.writeHead(400);
      res.end();
      return;
    }
    const ip = await allowedAddress(target.hostname).catch(() => null);
    if (!ip) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Blocked by playwright-e2e-mcp: private or reserved address');
      return;
    }
    const upstream = http.request(
      { host: ip, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers: { ...req.headers, host: target.host } },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on('connect', async (req, socket, head) => {
    socket.on('error', () => undefined);
    let target;
    try {
      target = new URL('http://' + req.url);
    } catch (err) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const ip = await allowedAddress(target.hostname).catch(() => null);
    if (!ip) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(Number(target.port) || 443, ip, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  return server.address().port;
}

/* ---------------- locator chains (JSON, never evaluated as code) ---------------- */

function reviveArg(arg) {
  if (arg && typeof arg === 'object') {
    if (typeof arg.$regex === 'string') return new RegExp(arg.$regex, arg.flags || '');
    const out = {};
    for (const key of Object.keys(arg)) out[key] = reviveArg(arg[key]);
    return out;
  }
  return arg;
}

const CHAIN_METHODS = new Set(['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId', 'locator', 'first', 'last', 'nth', 'filter']);

function resolveChain(page, chain) {
  let target = page;
  for (const call of chain) {
    if (!CHAIN_METHODS.has(call.method)) throw new Error('Unsupported locator method ' + call.method);
    target = target[call.method](...(call.args || []).map(reviveArg));
  }
  return target;
}

/* ---------------- in-page helpers, installed once per page ---------------- */

function installHelpers() {
  if (window.__pwmcp) return;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function uniqueSelector(el) {
    if (el.id) {
      const css = '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
      try { if (document.querySelectorAll(css).length === 1) return css; } catch (err) { /* fall through */ }
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node === document.documentElement) { parts.unshift('html'); break; }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.prototype.filter.call(parent.children, (child) => child.tagName === node.tagName);
        if (siblings.length > 1) part = part + ':nth-of-type(' + (Array.prototype.indexOf.call(siblings, node) + 1) + ')';
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch (err) { /* keep walking */ }
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function implicitRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    switch (tag) {
      case 'button': return 'button';
      case 'a': case 'area': return el.hasAttribute('href') ? 'link' : null;
      case 'input':
        if (type === 'hidden') return null;
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
        if (['', 'text', 'email', 'tel', 'url'].includes(type)) return el.hasAttribute('list') ? 'combobox' : 'textbox';
        return null;
      case 'textarea': return 'textbox';
      case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'img': return el.getAttribute('alt') === '' ? null : 'img';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'aside': return 'complementary';
      case 'ul': case 'ol': return 'list';
      case 'li': return 'listitem';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'td': return 'cell';
      case 'th': return 'columnheader';
      case 'option': return 'option';
      case 'dialog': return 'dialog';
      case 'progress': return 'progressbar';
      case 'article': return 'article';
      case 'form': return el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ? 'form' : null;
      default: return null;
    }
  }

  function labelText(el) {
    if (el.id) {
      try {
        const lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
        if (lab) return norm(lab.textContent);
      } catch (err) { /* ignore */ }
    }
    const wrap = el.closest('label');
    if (wrap) return norm(wrap.textContent);
    return '';
  }

  function accessibleName(el, role) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => norm(n.textContent)).join(' ');
      if (text) return text;
    }
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return norm(el.value || el.getAttribute('value'));
      if (type === 'image') return norm(el.getAttribute('alt'));
      const label = labelText(el);
      if (label) return label;
      return norm(el.getAttribute('title') || el.getAttribute('placeholder'));
    }
    if (tag === 'img') return norm(el.getAttribute('alt') || el.getAttribute('title'));
    const fromContent = ['button', 'link', 'heading', 'cell', 'columnheader', 'option', 'tab', 'menuitem', 'listitem', 'checkbox', 'radio', 'switch', 'treeitem'];
    if (fromContent.includes(role)) return norm(el.innerText !== undefined && el.innerText !== '' ? el.innerText : el.textContent);
    return norm(el.getAttribute('title'));
  }

  function isVisible(el) {
    let visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    try {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') visible = false;
    } catch (err) { /* ignore */ }
    return visible;
  }

  // Ordered candidate locators, best first. The Node side keeps only those
  // that resolve to exactly this element.
  function candidates(el) {
    const out = [];
    const role = implicitRole(el);
    const name = role ? accessibleName(el, role) : '';
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
    const testAttr = el.hasAttribute('data-testid') ? 'data-testid' : null;
    if (role && name && name.length <= 80) {
      out.push([{ method: 'getByRole', args: [role, { name: name }] }]);
      out.push([{ method: 'getByRole', args: [role, { name: name, exact: true }] }]);
    }
    if (testId && testAttr) out.push([{ method: 'getByTestId', args: [testId] }]);
    else if (testId) out.push([{ method: 'locator', args: ['[' + (el.hasAttribute('data-test-id') ? 'data-test-id' : 'data-test') + '="' + testId + '"]'] }]);
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const label = labelText(el);
      if (label && label.length <= 80) out.push([{ method: 'getByLabel', args: [label] }]);
      const placeholder = norm(el.getAttribute('placeholder'));
      if (placeholder) out.push([{ method: 'getByPlaceholder', args: [placeholder] }]);
    }
    const alt = norm(el.getAttribute('alt'));
    if (alt) out.push([{ method: 'getByAltText', args: [alt] }]);
    const text = norm(el.textContent);
    if (text && text.length <= 50 && el.children.length === 0 && !['html', 'head', 'body', 'script', 'style', 'title'].includes(tag)) {
      out.push([{ method: 'getByText', args: [text] }]);
      out.push([{ method: 'getByText', args: [text, { exact: true }] }]);
    }
    if (role && !name) out.push([{ method: 'getByRole', args: [role] }]);
    const title = norm(el.getAttribute('title'));
    if (title) out.push([{ method: 'getByTitle', args: [title] }]);
    out.push([{ method: 'locator', args: [uniqueSelector(el)] }]);
    return { chains: out, role: role || undefined, name: name || undefined };
  }

  function describe(el) {
    const rect = el.getBoundingClientRect();
    const attributes = {};
    const attrCount = Math.min(el.attributes.length, 30);
    for (let i = 0; i < attrCount; i += 1) {
      const attr = el.attributes[i];
      attributes[attr.name] = String(attr.value).slice(0, 200);
    }
    const info = candidates(el);
    const text = norm(el.textContent).slice(0, 160);
    return {
      selector: uniqueSelector(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: Array.prototype.slice.call(el.classList).slice(0, 10),
      role: info.role,
      name: info.name ? info.name.slice(0, 120) : undefined,
      text: text || undefined,
      attributes: attributes,
      visible: isVisible(el),
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      candidates: info.chains,
    };
  }

  const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'option', 'heading', 'img', 'dialog', 'navigation', 'main', 'form']);

  function isMeaningful(el) {
    if (!isVisible(el)) return false;
    const role = implicitRole(el);
    if (role && INTERACTIVE.has(role)) return true;
    return el.hasAttribute('data-testid') || el.hasAttribute('data-test-id') || el.hasAttribute('data-test');
  }

  // Token overlap between a broken locator's words and an element.
  function healScore(el, tokens) {
    if (tokens.length === 0) return 0;
    const info = candidates(el);
    const hay = [
      el.id, el.getAttribute('data-testid'), el.getAttribute('data-test-id'), el.getAttribute('data-test'),
      el.getAttribute('name'), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'),
      el.getAttribute('alt'), info.name, el.children.length === 0 ? el.textContent : '', el.className && typeof el.className === 'string' ? el.className : '',
    ].filter(Boolean).join(' ').toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2');
    const words = new Set(hay.split(/[^a-z0-9]+/).filter((w) => w.length > 1));
    let score = 0;
    for (const token of tokens) {
      if (words.has(token)) score += 3;
      else if (Array.from(words).some((w) => w.startsWith(token) || token.startsWith(w))) score += 2;
      else if (hay.includes(token)) score += 1;
    }
    if (cfgRole() && info.role === cfgRole()) score += 2;
    if (info.role && INTERACTIVE.has(info.role)) score += 1;
    return score;
  }
  let roleHint = null;
  const cfgRole = () => roleHint;

  window.__pwmcp = {
    describe: describe,
    uniqueSelector: uniqueSelector,
    isMeaningful: isMeaningful,
    healScore: healScore,
    setRoleHint: (r) => { roleHint = r || null; },
    els: [],
  };
}

/* ---------------- locator verification ---------------- */

async function verifyCandidates(page, index, candidates, keep) {
  const verified = [];
  for (const chain of candidates || []) {
    if (verified.length >= keep) break;
    try {
      const loc = resolveChain(page, chain);
      if ((await loc.count()) !== 1) continue;
      const same = await loc.evaluate((el, i) => el === window.__pwmcp.els[i], index);
      if (!same) continue;
      // Skip the exact:true twin when the plain form already passed.
      const key = JSON.stringify(chain.map((c) => [c.method, (c.args || []).map((a) => {
        if (!a || typeof a !== 'object' || a.$regex) return a;
        const copy = Object.assign({}, a);
        delete copy.exact;
        return copy;
      })]));
      if (verified.some((v) => v.key === key)) continue;
      verified.push({ key: key, chain: chain });
    } catch (err) { /* candidate does not resolve; skip */ }
  }
  return verified.map((v) => v.chain);
}

async function attachLocators(page, elements, budget, keep) {
  for (let i = 0; i < elements.length; i += 1) {
    const el = elements[i];
    if (i < budget) el.locators = await verifyCandidates(page, i, el.candidates, keep);
    delete el.candidates;
  }
}

/* ---------------- page actions (reach a state before inspecting) ---------------- */

async function runActions(page, actions, timeout) {
  const done = [];
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i];
    const label = 'step ' + (i + 1) + ' (' + (a.label || a.type) + ')';
    try {
      const loc = a.locator ? resolveChain(page, a.locator) : null;
      switch (a.type) {
        case 'goto': await page.goto(a.url, { waitUntil: cfg.waitUntil || 'domcontentloaded', timeout: timeout }); break;
        case 'click': await loc.click({ timeout: timeout }); break;
        case 'dblclick': await loc.dblclick({ timeout: timeout }); break;
        case 'hover': await loc.hover({ timeout: timeout }); break;
        case 'fill': await loc.fill(a.value || '', { timeout: timeout }); break;
        case 'press': if (loc) await loc.press(a.value, { timeout: timeout }); else await page.keyboard.press(a.value); break;
        case 'check': await loc.check({ timeout: timeout }); break;
        case 'uncheck': await loc.uncheck({ timeout: timeout }); break;
        case 'select': await loc.selectOption(a.value, { timeout: timeout }); break;
        case 'wait':
          if (loc) await loc.first().waitFor({ state: 'visible', timeout: timeout });
          else await page.waitForTimeout(Math.min(a.ms || 500, 10000));
          break;
        default: throw new Error('Unknown action type ' + a.type);
      }
      done.push(label);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const wrapped = new Error('Action ' + label + ' failed: ' + message.split('\n')[0]);
      wrapped.actionsDone = done;
      throw wrapped;
    }
  }
  return done;
}

(async () => {
  const { createRequire } = require('node:module');
  const req = createRequire(cfg.projectRoot + '/package.json');
  let pw = null;
  try {
    pw = req('playwright');
  } catch (errA) {
    try {
      pw = req('@playwright/test');
    } catch (errB) {
      send({
        ok: false,
        kind: 'NO_PLAYWRIGHT',
        error: 'Playwright is not installed in ' + cfg.projectRoot,
        hint: 'Run: npm install -D @playwright/test && npx playwright install',
      });
      process.exit(1);
    }
  }

  let browser = null;
  let actionsDone = [];
  try {
    const launchOptions = { headless: true };
    if (cfg.blockPrivate) {
      // SSRF guard: every browser connection (each redirect hop and
      // subresource too) goes through this local proxy, which resolves
      // the host itself and refuses blocked ranges before connecting.
      const proxyPort = await startGuardProxy(cfg.blockedRanges || []);
      launchOptions.proxy = { server: 'http://127.0.0.1:' + proxyPort };
      // WebRTC STUN/TURN over UDP does not go through the proxy; keep it off
      // so a page cannot send UDP to (or scan) the private network.
      launchOptions.args = ['--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
    }
    browser = await pw.chromium.launch(launchOptions);
    const contextOptions = { viewport: cfg.viewport || { width: 1280, height: 720 } };
    if (cfg.storageState) contextOptions.storageState = cfg.storageState;
    if (cfg.headers) contextOptions.extraHTTPHeaders = cfg.headers;
    if (cfg.testIdAttribute) pw.selectors.setTestIdAttribute(cfg.testIdAttribute);
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    const consoleMessages = [];
    page.on('console', (msg) => {
      if (consoleMessages.length < 50) consoleMessages.push({ type: msg.type(), text: String(msg.text()).slice(0, 300) });
    });
    page.on('pageerror', (err) => {
      if (consoleMessages.length < 50) consoleMessages.push({ type: 'pageerror', text: String(err).slice(0, 300) });
    });

    if (cfg.snapshotHtmlPath) {
      // A DOM snapshot from a trace: render it with every request blocked,
      // so nothing it references is fetched and no script can run.
      await context.route('**/*', (route) => route.abort());
      await page.setContent(require('node:fs').readFileSync(cfg.snapshotHtmlPath, 'utf8'), { waitUntil: 'domcontentloaded', timeout: cfg.gotoTimeout || 15000 });
    } else {
      await page.goto(cfg.url, { waitUntil: cfg.waitUntil || 'domcontentloaded', timeout: cfg.gotoTimeout || 15000 });
      if (cfg.waitFor) await page.locator(cfg.waitFor).first().waitFor({ state: 'visible', timeout: cfg.waitTimeout || 5000 });
      if (cfg.actions && cfg.actions.length) actionsDone = await runActions(page, cfg.actions, cfg.actionTimeout || 10000);
    }

    if (cfg.mode === 'screenshot') {
      if (cfg.selectorChain) {
        await resolveChain(page, cfg.selectorChain).first().screenshot({ path: cfg.screenshotPath });
      } else {
        await page.screenshot({ path: cfg.screenshotPath, fullPage: !!cfg.fullPage });
      }
      send({
        ok: true,
        data: {
          screenshotPath: cfg.screenshotPath,
          title: await page.title(),
          finalUrl: page.url(),
          viewport: page.viewportSize() || { width: 1280, height: 720 },
          elementCount: 0,
          matchCount: 0,
          elements: [],
          actionsDone: actionsDone,
          durationMs: Date.now() - cfg.startedAt,
        },
      });
      await browser.close();
      process.exit(0);
    }

    await page.evaluate(installHelpers);
    let data;

    if (cfg.mode === 'validate') {
      data = { matchCount: 0, elementCount: 0, elements: [] };
      try {
        const loc = resolveChain(page, cfg.selectorChain);
        data.matchCount = await loc.count();
        data.elementCount = data.matchCount;
        data.elements = await loc.evaluateAll((els) => {
          window.__pwmcp.els = els.slice(0, 5);
          return window.__pwmcp.els.map((el) => window.__pwmcp.describe(el));
        });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (classifyError(message).kind === 'INVALID_PATH' || /Unsupported locator/.test(message)) {
          data.parseError = message.split('\n')[0];
        } else {
          throw err;
        }
      }
      if (!data.parseError) await attachLocators(page, data.elements, 5, 3);
    } else if (cfg.mode === 'heal') {
      data = await page.evaluate((input) => {
        const h = window.__pwmcp;
        h.setRoleHint(input.role);
        const scored = [];
        for (const el of Array.prototype.slice.call(document.querySelectorAll('body *'))) {
          if (['script', 'style', 'noscript', 'template', 'svg', 'path'].includes(el.tagName.toLowerCase())) continue;
          const score = h.healScore(el, input.tokens);
          if (score > 0) scored.push({ el: el, score: score });
        }
        scored.sort((a, b) => b.score - a.score);
        // Prefer the innermost element when a parent scores the same.
        const picked = [];
        for (const item of scored) {
          if (picked.length >= 5) break;
          if (picked.some((p) => p.score === item.score && p.el.contains(item.el))) {
            const idx = picked.findIndex((p) => p.score === item.score && p.el.contains(item.el));
            picked[idx] = item;
            continue;
          }
          if (picked.some((p) => item.el.contains(p.el) && p.score >= item.score)) continue;
          picked.push(item);
        }
        h.els = picked.map((p) => p.el);
        const elements = picked.map((p) => Object.assign(h.describe(p.el), { score: p.score }));
        return { matchCount: elements.length, elementCount: document.querySelectorAll('*').length, elements: elements, title: document.title };
      }, { tokens: cfg.healTokens || [], role: cfg.healRole });
      await attachLocators(page, data.elements, 5, 3);
    } else {
      data = await page.evaluate((input) => {
        const h = window.__pwmcp;
        const result = { matchCount: 0, elementCount: 0, elements: [], parseError: undefined };
        let source = [];
        if (input.selector) {
          try {
            source = Array.prototype.slice.call(document.querySelectorAll(input.selector));
          } catch (err) {
            result.parseError = err && err.message ? err.message : String(err);
          }
        } else {
          source = Array.prototype.slice.call(document.querySelectorAll('*'));
          if (input.view === 'locators') source = source.filter((el) => h.isMeaningful(el));
        }
        if (result.parseError) return result;

        result.matchCount = source.length;
        result.elementCount = input.selector || input.view === 'locators' ? source.length : document.querySelectorAll('*').length;
        h.els = source.slice(0, input.limit);
        result.elements = h.els.map((el) => h.describe(el));
        result.title = document.title;
        result.finalUrl = location.href;
        result.viewport = { width: window.innerWidth, height: window.innerHeight };
        if (input.includeHtml) {
          const html = document.documentElement.outerHTML;
          result.html = html.slice(0, input.maxHtml);
          result.htmlTruncated = html.length > input.maxHtml;
        }
        return result;
      }, {
        selector: cfg.selector,
        view: cfg.view,
        limit: cfg.view === 'locators' ? 80 : 100,
        includeHtml: !!cfg.includeHtml,
        maxHtml: cfg.maxHtmlChars || 20000,
      });
      if (!data.parseError) {
        // Verify locators for the elements an agent is likely to act on;
        // the full inventory would cost a browser round trip per candidate.
        if (cfg.view === 'locators' || cfg.selector) {
          await attachLocators(page, data.elements, 60, 2);
        } else {
          const meaningful = await page.evaluate(() => window.__pwmcp.els.map((el) => window.__pwmcp.isMeaningful(el)));
          let budget = 30;
          for (let i = 0; i < data.elements.length; i += 1) {
            const el = data.elements[i];
            if (meaningful[i] && budget > 0) {
              budget -= 1;
              el.locators = await verifyCandidates(page, i, el.candidates, 2);
            }
            delete el.candidates;
          }
        }
      }
    }

    data.consoleMessages = consoleMessages;
    data.actionsDone = actionsDone;
    data.finalUrl = data.finalUrl || page.url();
    data.durationMs = Date.now() - cfg.startedAt;
    send({ ok: true, data: data });
    await browser.close();
    process.exit(0);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const classified = classifyError(message);
    send({ ok: false, kind: classified.kind, error: message, hint: classified.hint, actionsDone: err && err.actionsDone });
    try { if (browser) await browser.close(); } catch (closeErr) { /* ignore */ }
    process.exit(1);
  }
})().catch((err) => {
  send({ ok: false, kind: 'UNKNOWN', error: err && err.message ? err.message : String(err) });
  process.exit(1);
});
`;
