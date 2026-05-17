require('dotenv').config();

const cors = require('cors');
const express = require('express');

const app = express();
const port = Number.parseInt(process.env.PORT || '3000', 10);
const frontEndOrigin = process.env.FRONTEND_ORIGIN;

app.use(
  cors(
    frontEndOrigin
      ? {
          origin: frontEndOrigin,
        }
      : undefined
  )
);
app.use(express.static('public'));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/lastfm/recent-tracks', async (req, res) => {
  const apiKey = process.env.LASTFM_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error:
        'Server is missing LASTFM_API_KEY. Set it in environment variables, not in client-side code.',
    });
  }

  const user = typeof req.query.user === 'string' ? req.query.user.trim() : '';
  const limitInput = typeof req.query.limit === 'string' ? req.query.limit : '5';
  const limit = Number.parseInt(limitInput, 10);

  if (!user) {
    return res.status(400).json({ error: 'Query parameter "user" is required.' });
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return res
      .status(400)
      .json({ error: 'Query parameter "limit" must be an integer between 1 and 50.' });
  }

  const params = new URLSearchParams({
    method: 'user.getrecenttracks',
    user,
    api_key: apiKey,
    format: 'json',
    limit: String(limit),
  });

  try {
    const response = await fetch(`https://ws.audioscrobbler.com/2.0/?${params.toString()}`);

    if (!response.ok) {
      return res
        .status(502)
        .json({ error: `Last.fm request failed with status ${response.status}.` });
    }

    const data = await response.json();

    if (data && typeof data === 'object' && 'error' in data) {
      return res.status(502).json({ error: data.message || 'Last.fm API returned an error.' });
    }

    return res.json(data);
  } catch (error) {
    console.error('Last.fm proxy error:', error);
    return res.status(502).json({ error: 'Failed to reach Last.fm.' });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
