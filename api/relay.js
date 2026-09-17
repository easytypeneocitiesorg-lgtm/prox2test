export default async function handler(req, res) {
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
      redirect: 'follow',
    });

    // Use response.url so relative paths resolve correctly even if the site redirected
    const finalUrl = response.url; 
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const proxyBase = `https://${req.headers.host}/api/relay?url=`;

    // Safely convert relative paths to absolute proxy paths
    const rewriteUrl = (urlStr) => {
      if (!urlStr || urlStr.startsWith('data:') || urlStr.startsWith('javascript:') || urlStr.startsWith('#')) {
        return urlStr;
      }
      try {
        const absolute = new URL(urlStr, finalUrl).href;
        return proxyBase + encodeURIComponent(absolute);
      } catch (e) {
        return urlStr;
      }
    };

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', response.headers.get('content-type') || 'text/html');
    res.setHeader('Cache-Control', 'public, max-age=60');

    // 1. Process HTML
    if (contentType.includes('text/html')) {
      let html = await response.text();

      // Rewrite src, href, and action tags using a precise capture group
      html = html.replace(/\b(src|href|action)\s*=\s*(["'])(.*?)\2/gi, (match, attr, quote, val) => {
        return `${attr}=${quote}${rewriteUrl(val)}${quote}`;
      });

      // Inject JS to intercept dynamic API calls, game asset fetches, and manual link clicks
      const interceptorScript = `
      <script>
        (function() {
          const proxyBase = '${proxyBase}';
          const targetBase = '${finalUrl}';
          
          function toProxy(url) {
            if (!url || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#') || url.startsWith(proxyBase)) return url;
            try { return proxyBase + encodeURIComponent(new URL(url, targetBase).href); }
            catch(e) { return url; }
          }
          
          // Intercept fetch() - Critical for web games and React/Vue apps
          const originalFetch = window.fetch;
          window.fetch = function(res, init) {
            if (typeof res === 'string') res = toProxy(res);
            else if (res instanceof Request) res = new Request(toProxy(res.url), init);
            return originalFetch.call(this, res, init);
          };
          
          // Intercept XMLHttpRequest
          const originalOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url, ...args) {
            return originalOpen.call(this, method, toProxy(url), ...args);
          };
          
          // Intercept raw link clicks
          document.addEventListener('click', function(e) {
            const a = e.target.closest('a');
            if (a && a.hasAttribute('href')) {
              const href = a.getAttribute('href');
              if (!href.startsWith('javascript:') && !href.startsWith('#')) {
                e.preventDefault();
                window.location.href = toProxy(href);
              }
            }
          }, true);
        })();
      </script>`;

      html = html.includes('<head>') 
        ? html.replace('<head>', `<head>${interceptorScript}`) 
        : interceptorScript + html;

      return res.status(response.status).send(html);
    }

    // 2. Process CSS
    if (contentType.includes('text/css')) {
      let css = await response.text();
      // Intercept background-image and font url() paths
      css = css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (match, quote, val) => {
        if (val.startsWith('data:')) return match;
        return `url(${quote}${rewriteUrl(val)}${quote})`;
      });
      return res.status(response.status).send(css);
    }

    // 3. Process Binary Assets (Images, Game WebAssembly, Fonts, JS files)
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return res.status(response.status).send(buffer);

  } catch (error) {
    console.error('Fetch error:', error);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(500).json({ error: 'Failed to fetch the target URL' });
  }
}
