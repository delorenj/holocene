import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PROXY_PORT || 11820;
const PLANE_API_KEY = process.env.PLANE_33GOD_API_KEY || '';
const PLANE_BASE_URL = 'https://plane.delo.sh';

if (!PLANE_API_KEY) {
  console.error('PLANE_33GOD_API_KEY is required');
  process.exit(1);
}

app.use(cors());
app.use(express.json());

// Proxy all /api/plane/* requests to Plane API
app.all('/api/plane/*', async (req, res) => {
  const planePath = req.path.replace('/api/plane', '');
  const url = new URL(planePath, PLANE_BASE_URL);
  url.search = new URLSearchParams(req.query as Record<string, string>).toString();

  try {
    const response = await fetch(url.toString(), {
      method: req.method,
      headers: {
        'x-api-key': PLANE_API_KEY,
        'Content-Type': 'application/json',
      },
      body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body) : undefined,
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Plane API proxy error:', error);
    res.status(500).json({ error: 'Proxy error' });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Plane API proxy listening on http://0.0.0.0:${PORT}`);
});
