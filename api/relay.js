export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing "url" query parameter' });

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
      },
      redirect: 'follow',
    });

    const finalUrl = response.url;
    let contentType = response.headers.get('content-type') || 'text/html';
    const proxyBase = `https://${req.headers.host}/api/relay?url=`;

    const rewriteUrl = (urlStr) => {
      if (!urlStr || urlStr.startsWith('data:') || urlStr.startsWith('javascript:') || urlStr.startsWith('#')) return urlStr;
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
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=60');

    // 1. Process HTML
    if (contentType.includes('text/html')) {
      let html = await response.text();

      // Strip security attributes that break intercepted scripts
      html = html.replace(/\s+(integrity|crossorigin)\s*=\s*(["']).*?\2/gi, '');

      // Rewrite static HTML tags
      html = html.replace(/\b(src|href|action)\s*=\s*(["'])(.*?)\2/gi, (match, attr, quote, val) => {
        return `${attr}=${quote}${rewriteUrl(val)}${quote}`;
      });

      // The Interceptor Script
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
          
          // Intercept Fetch & XHR
          const originalFetch = window.fetch;
          window.fetch = function(res, init) {
            if (typeof res === 'string') res = toProxy(res);
            else if (res instanceof Request) res = new Request(toProxy(res.url), init);
            return originalFetch.call(this, res, init);
          };
          
          const originalOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url, ...args) {
            return originalOpen.call(this, method, toProxy(url), ...args);
          };

          // NEW: Intercept setAttribute (Crucial for game engines loading assets)
          const originalSetAttribute = Element.prototype.setAttribute;
          Element.prototype.setAttribute = function(name, value) {
            if (['src', 'href', 'action'].includes(name.toLowerCase()) && typeof value === 'string') {
              value = toProxy(value);
            }
            return originalSetAttribute.call(this, name, value);
          };

          // Intercept property assignments dynamically
          ['src', 'href'].forEach(attr => {
            const prototypes = [HTMLImageElement, HTMLScriptElement, HTMLAudioElement, HTMLLinkElement, HTMLIFrameElement];
            prototypes.forEach(proto => {
              if (!proto) return;
              const desc = Object.getOwnPropertyDescriptor(proto.prototype, attr);
              if (desc && desc.set) {
                const originalSet = desc.set;
                Object.defineProperty(proto.prototype, attr, {
                  set: function(val) {
                    originalSet.call(this, toProxy(val));
                  },
                  get: desc.get
                });
              }
            });
          });

          // NEW: Intercept Web Workers (Used for background processing)
          if (window.Worker) {
            const originalWorker = window.Worker;
            window.Worker = function(url, options) {
              return new originalWorker(toProxy(url), options);
            };
          }
          
          // Keep navigation inside the iframe
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
      css = css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (match, quote, val) => {
        if (val.startsWith('data:')) return match;
        return `url(${quote}${rewriteUrl(val)}${quote})`;
      });
      return res.status(response.status).send(css);
    }

    // 3. Process Binary Assets & Scripts
    const arrayBuffer = await response.arrayBuffer();
    return res.status(response.status).send(Buffer.from(arrayBuffer));

  } catch (error) {
    console.error('Fetch error:', error);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(500).json({ error: 'Failed to fetch the target URL' });
  }
}
