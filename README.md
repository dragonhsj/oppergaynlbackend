# oppergaynlbackend

Backend that safely proxies Last.fm requests so your API key stays server-side.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and set your real Last.fm key:
   ```bash
   cp .env.example .env
   ```
3. Start the server:
   ```bash
   npm start
   ```

## API

- `GET /api/lastfm/recent-tracks?user=<lastfm_username>&limit=5`
  - Calls Last.fm from the backend using `LASTFM_API_KEY` from environment variables.
  - Your API key is never exposed in browser JavaScript.

## HTML integration

The included `public/index.html` fetches this backend endpoint:

```js
fetch('/api/lastfm/recent-tracks?user=USERNAME&limit=5');
```
