export interface Env {
  LASTFM_API_KEY: string;
  LASTFM_USER: string;
  ALLOWED_ORIGIN?: string;
}

interface LastFmImage {
  '#text': string;
  size: string;
}

interface LastFmTrack {
  artist: { '#text': string };
  name: string;
  album: { '#text': string };
  url: string;
  image: LastFmImage[];
  date?: { uts: string; '#text': string };
  '@attr'?: { nowplaying?: string };
}

interface LastFmResponse {
  recenttracks?: {
    track: LastFmTrack[] | LastFmTrack;
  };
  error?: number;
  message?: string;
}

interface NormalizedTrack {
  artist: string;
  name: string;
  album: string;
  url: string;
  image: string | null;
  nowPlaying: boolean;
  playedAt: number | null;
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function jsonResponse(env: Env, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=15',
      ...corsHeaders(env),
    },
  });
}

function pickImage(images: LastFmImage[] | undefined): string | null {
  if (!images?.length) return null;
  for (let i = images.length - 1; i >= 0; i--) {
    const url = images[i]['#text'];
    if (url && url.length > 0) return url;
  }
  return null;
}

function normalizeTrack(track: LastFmTrack): NormalizedTrack {
  return {
    artist: track.artist?.['#text'] ?? '',
    name: track.name ?? '',
    album: track.album?.['#text'] ?? '',
    url: track.url ?? '',
    image: pickImage(track.image),
    nowPlaying: track['@attr']?.nowplaying === 'true',
    playedAt: track.date ? Number(track.date.uts) * 1000 : null,
  };
}

async function getRecentTracks(env: Env): Promise<Response> {
  const url = new URL('https://ws.audioscrobbler.com/2.0/');
  url.searchParams.set('method', 'user.getrecenttracks');
  url.searchParams.set('user', env.LASTFM_USER);
  url.searchParams.set('api_key', env.LASTFM_API_KEY);
  url.searchParams.set('format', 'json');
  // Request 11 so we still get 10 historical tracks when a now-playing entry is included.
  url.searchParams.set('limit', '11');

  let upstream: Response;
  try {
    upstream = await fetch(url.toString(), {
      headers: { 'User-Agent': 'oppergaynl-lastfm-proxy/1.0' },
    });
  } catch {
    return jsonResponse(env, { error: 'Failed to reach Last.fm' }, 502);
  }

  if (!upstream.ok) {
    return jsonResponse(env, { error: `Last.fm responded with ${upstream.status}` }, 502);
  }

  const data = (await upstream.json()) as LastFmResponse;
  if (data.error || !data.recenttracks) {
    return jsonResponse(env, { error: data.message || 'Last.fm error' }, 502);
  }

  const raw = data.recenttracks.track;
  const tracks = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const normalized = tracks.map(normalizeTrack);

  const nowPlaying = normalized.find((t) => t.nowPlaying) ?? null;
  const recent = normalized.filter((t) => !t.nowPlaying).slice(0, 10);

  return jsonResponse(env, {
    user: env.LASTFM_USER,
    nowPlaying,
    recent,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== 'GET') {
      return jsonResponse(env, { error: 'Method not allowed' }, 405);
    }

    if (!env.LASTFM_API_KEY || !env.LASTFM_USER) {
      return jsonResponse(env, { error: 'Server is not configured' }, 500);
    }

    const { pathname } = new URL(request.url);
    if (pathname === '/' || pathname === '/recent-tracks') {
      return getRecentTracks(env);
    }

    return jsonResponse(env, { error: 'Not found' }, 404);
  },
};
