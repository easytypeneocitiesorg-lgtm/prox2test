export default async function handler(req, res) {
  // Handle preflight[cite: 1]
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', //[cite: 1]
        'Accept': '*/*', // Broadened to accept all asset types
      },
      redirect: 'follow', //[cite: 1]
    });

    const contentType = response.headers.get('content-type') || 'text/html';
    const proxyBase = `https://${req.headers.host}/api/relay?url=`;

    // CORS so the browser can actually read the response[cite: 1]
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=60'); //[cite: 1]

    // If it's an HTML page, rewrite the links so navigation stays inside the proxy
    if (contentType.includes('text/html')) {
      let html = await response.text();

      const rewriteUrl = (urlStr) => {
        try {
          const absolute = new URL(urlStr, targetUrl).href;
          return proxyBase + encodeURIComponent(absolute);
        } catch (e) {
          return urlStr;
        }
      };

      // Rewrite src and href attributes
      html = html.replace(/(href|src)=["']([^"']+)["']/g, (match, attr, val) => {
        if (val.startsWith('#') || val.startsWith('data:') || val.startsWith('javascript:')) {
          return match;
        }
        return `${attr}="${rewriteUrl(val)}"`;
      });

      // Inject a script to force manual clicks to route through the proxy
      const interceptorScript = `
        <script>
          document.addEventListener('click', (e) => {
            const a = e.target.closest('a');
            if (a && a.href && !a.href.startsWith('javascript:')) {
              e.preventDefault();
              const proxyPrefix = '${proxyBase}';
              const target = a.href.startsWith(proxyPrefix) ? a.href : proxyPrefix + encodeURIComponent(a.href);
              window.location.href = target;
            }
          });
        </script>
      `;

      html = html.includes('<head>') 
        ? html.replace('<head>', `<head>${interceptorScript}`) 
        : interceptorScript + html;

      return res.status(response.status).send(html);
    }

    // Process non-HTML assets (images, CSS, JS) as binary buffers
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return res.status(response.status).send(buffer);

  } catch (error) {
    console.error('Fetch error:', error); //[cite: 1]
    res.setHeader('Access-Control-Allow-Origin', '*'); //[cite: 1]
    return res.status(500).json({ error: 'Failed to fetch the target URL' }); //[cite: 1]
  }
}
