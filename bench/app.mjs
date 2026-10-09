/**
 * A small but realistic storefront page for the token benchmark: header
 * navigation, a search form, 24 product cards and a footer. The checkout
 * button's test id is `checkout-btn`; the benchmark spec still looks for the
 * old `checkout-button`, which is the locator drift being diagnosed.
 */
import { createServer } from 'node:http';

const products = Array.from({ length: 24 }, (_, i) => ({
  id: i + 1,
  name: ['Trail Runner', 'City Sneaker', 'Rain Shell', 'Wool Beanie', 'Canvas Tote', 'Steel Bottle'][i % 6] + ` ${Math.floor(i / 6) + 1}`,
  price: (19 + ((i * 7) % 60)).toFixed(2),
}));

export function pageHtml() {
  const cards = products
    .map(
      (p) => `<article class="card" data-testid="product-${p.id}">
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="${p.name}">
  <h3>${p.name}</h3>
  <p class="price">$${p.price}</p>
  <label>Qty <input type="number" name="qty-${p.id}" value="1" min="1"></label>
  <button data-testid="add-to-cart-${p.id}">Add to cart</button>
</article>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Northwind Outfitters</title></head>
<body>
<header>
  <a href="/">Northwind Outfitters</a>
  <nav><a href="/new">New</a><a href="/men">Men</a><a href="/women">Women</a><a href="/sale">Sale</a><a href="/help">Help</a></nav>
  <form role="search"><label for="q">Search</label><input id="q" type="search" placeholder="Search products"><button>Search</button></form>
  <a href="/account">Account</a>
</header>
<main>
  <h1>All products</h1>
  <section aria-label="Filters"><label><input type="checkbox"> In stock</label><label><input type="checkbox"> On sale</label>
    <select aria-label="Sort"><option>Featured</option><option>Price: low to high</option><option>Price: high to low</option></select></section>
  <section class="grid">
${cards}
  </section>
  <aside aria-label="Cart"><h2>Your cart</h2><p>3 items · $142.00</p><button data-testid="checkout-btn">Proceed to checkout</button></aside>
</main>
<footer><p>© 2026 Northwind Outfitters</p><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/contact">Contact</a></footer>
</body></html>`;
}

export function startApp() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pageHtml());
    });
    server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}
