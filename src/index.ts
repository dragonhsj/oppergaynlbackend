export interface Env {
  LASTFM_API_KEY: string;
  LASTFM_USER: string;
  ALLOWED_ORIGIN?: string;
}

const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';
const USER_AGENT = 'oppergaynl-lastfm-proxy/1.0';
const INFO_TTL_SECONDS = 3600;

interface LastFmImage {
  '#text': string;
  size: string;
}

interface LastFmRefField {
  '#text': string;
  mbid?: string;
}

interface LastFmTrack {
  artist: LastFmRefField;
  name: string;
  mbid?: string;
  album: LastFmRefField;
  url: string;
  image: LastFmImage[];
  date?: { uts: string; '#text': string };
  '@attr'?: { nowplaying?: string };
}

interface LastFmRecentResponse {
  recenttracks?: { track: LastFmTrack[] | LastFmTrack };
  error?: number;
  message?: string;
}

interface NormalizedTrack {
  artist: string;
  artistMbid: string;
  name: string;
  trackMbid: string;
  album: string;
  albumMbid: string;
  url: string;
  image: string | null;
  nowPlaying: boolean;
  playedAt: number | null;
}

interface TrackInfo {
  durationMs: number | null;
  listeners: number | null;
  playcount: number | null;
  tags: string[];
  summary: string | null;
}

interface AlbumInfo {
  name: string;
  url: string;
  image: string | null;
  releaseYear: number | null;
  releaseDate: string | null;
  listeners: number | null;
  playcount: number | null;
  tags: string[];
  summary: string | null;
}

interface ArtistInfo {
  name: string;
  url: string;
  listeners: number | null;
  playcount: number | null;
  tags: string[];
  similar: { name: string; url: string }[];
  summary: string | null;
}

interface EnrichedTrack extends NormalizedTrack {
  info: TrackInfo | null;
  artistInfo: ArtistInfo | null;
  albumInfo: AlbumInfo | null;
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
    const url = images[i]?.['#text'];
    if (url && url.length > 0) return url;
  }
  return null;
}

function normalizeTrack(track: LastFmTrack): NormalizedTrack {
  return {
    artist: track.artist?.['#text'] ?? '',
    artistMbid: track.artist?.mbid ?? '',
    name: track.name ?? '',
    trackMbid: track.mbid ?? '',
    album: track.album?.['#text'] ?? '',
    albumMbid: track.album?.mbid ?? '',
    url: track.url ?? '',
    image: pickImage(track.image),
    nowPlaying: track['@attr']?.nowplaying === 'true',
    playedAt: track.date ? Number(track.date.uts) * 1000 : null,
  };
}

function buildLastfmUrl(params: Record<string, string>, apiKey: string): URL {
  const url = new URL(LASTFM_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('format', 'json');
  return url;
}

async function fetchLastfm<T>(url: URL): Promise<T | null> {
  let resp: Response;
  try {
    resp = await fetch(url.toString(), { headers: { 'User-Agent': USER_AGENT } });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  try {
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

async function fetchLastfmCached<T>(
  params: Record<string, string>,
  env: Env,
  ctx: ExecutionContext,
): Promise<T | null> {
  const keyUrl = new URL(LASTFM_BASE);
  for (const [k, v] of Object.entries(params)) keyUrl.searchParams.set(k, v);
  keyUrl.searchParams.set('format', 'json');
  const cacheKey = new Request(keyUrl.toString(), { method: 'GET' });

  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    try {
      return (await cached.json()) as T;
    } catch {
      // fall through and refetch
    }
  }

  const fetchUrl = buildLastfmUrl(params, env.LASTFM_API_KEY);
  let resp: Response;
  try {
    resp = await fetch(fetchUrl.toString(), { headers: { 'User-Agent': USER_AGENT } });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const body = await resp.text();

  const toCache = new Response(body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${INFO_TTL_SECONDS}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, toCache));

  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function stripReadMore(html: string): string {
  return html
    .replace(/<a [^>]*>Read more on Last\.fm<\/a>\.?/i, '')
    .trim();
}

function parseYear(value: string | undefined | null): number | null {
  if (!value) return null;
  const match = value.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function tagsFrom(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const tag = (node as { tag?: unknown }).tag;
  const list = Array.isArray(tag) ? tag : tag ? [tag] : [];
  return list
    .map((t) => (typeof t === 'object' && t && 'name' in t ? String((t as { name: unknown }).name) : ''))
    .filter((s) => s.length > 0);
}

async function getTrackInfo(
  track: NormalizedTrack,
  env: Env,
  ctx: ExecutionContext,
): Promise<TrackInfo | null> {
  const params: Record<string, string> = {
    method: 'track.getinfo',
    autocorrect: '1',
  };
  if (track.trackMbid) {
    params.mbid = track.trackMbid;
  } else {
    if (!track.artist || !track.name) return null;
    params.artist = track.artist;
    params.track = track.name;
  }
  const data = await fetchLastfmCached<{ track?: Record<string, unknown> }>(params, env, ctx);
  const t = data?.track;
  if (!t) return null;
  const wiki = t.wiki as { summary?: string } | undefined;
  return {
    durationMs: toNumber(t.duration),
    listeners: toNumber(t.listeners),
    playcount: toNumber(t.playcount),
    tags: tagsFrom(t.toptags),
    summary: wiki?.summary ? stripReadMore(wiki.summary) : null,
  };
}

async function getAlbumInfo(
  artist: string,
  album: string,
  mbid: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<AlbumInfo | null> {
  const params: Record<string, string> = {
    method: 'album.getinfo',
    autocorrect: '1',
  };
  if (mbid) {
    params.mbid = mbid;
  } else {
    if (!artist || !album) return null;
    params.artist = artist;
    params.album = album;
  }
  const data = await fetchLastfmCached<{ album?: Record<string, unknown> }>(params, env, ctx);
  const a = data?.album;
  if (!a) return null;
  const wiki = a.wiki as { summary?: string; published?: string } | undefined;
  const releaseDate = typeof a.releasedate === 'string' ? a.releasedate.trim() : '';
  return {
    name: String(a.name ?? album),
    url: String(a.url ?? ''),
    image: pickImage(a.image as LastFmImage[] | undefined),
    releaseYear: parseYear(releaseDate) ?? parseYear(wiki?.published),
    releaseDate: releaseDate || null,
    listeners: toNumber(a.listeners),
    playcount: toNumber(a.playcount),
    tags: tagsFrom(a.tags),
    summary: wiki?.summary ? stripReadMore(wiki.summary) : null,
  };
}

async function getArtistInfo(
  artist: string,
  mbid: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<ArtistInfo | null> {
  const params: Record<string, string> = {
    method: 'artist.getinfo',
    autocorrect: '1',
  };
  if (mbid) {
    params.mbid = mbid;
  } else {
    if (!artist) return null;
    params.artist = artist;
  }
  const data = await fetchLastfmCached<{ artist?: Record<string, unknown> }>(params, env, ctx);
  const a = data?.artist;
  if (!a) return null;
  const stats = a.stats as { listeners?: unknown; playcount?: unknown } | undefined;
  const bio = a.bio as { summary?: string } | undefined;
  const similarNode = a.similar as { artist?: unknown } | undefined;
  const similarList = Array.isArray(similarNode?.artist) ? (similarNode!.artist as unknown[]) : [];
  return {
    name: String(a.name ?? artist),
    url: String(a.url ?? ''),
    listeners: toNumber(stats?.listeners),
    playcount: toNumber(stats?.playcount),
    tags: tagsFrom(a.tags),
    similar: similarList
      .map((s) =>
        typeof s === 'object' && s && 'name' in s
          ? {
              name: String((s as { name: unknown }).name ?? ''),
              url: String((s as { url?: unknown }).url ?? ''),
            }
          : { name: '', url: '' },
      )
      .filter((s) => s.name.length > 0),
    summary: bio?.summary ? stripReadMore(bio.summary) : null,
  };
}

async function getRecentTracks(env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = buildLastfmUrl(
    {
      method: 'user.getrecenttracks',
      user: env.LASTFM_USER,
      limit: '11',
    },
    env.LASTFM_API_KEY,
  );

  const data = await fetchLastfm<LastFmRecentResponse>(url);
  if (!data) return jsonResponse(env, { error: 'Failed to reach Last.fm' }, 502);
  if (data.error || !data.recenttracks) {
    return jsonResponse(env, { error: data.message || 'Last.fm error' }, 502);
  }

  const raw = data.recenttracks.track;
  const tracks = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const normalized = tracks.map(normalizeTrack);

  const nowPlaying = normalized.find((t) => t.nowPlaying) ?? null;
  const recent = normalized.filter((t) => !t.nowPlaying).slice(0, 10);
  const all: NormalizedTrack[] = nowPlaying ? [nowPlaying, ...recent] : recent;

  const artistKey = (t: NormalizedTrack) => t.artistMbid || `name:${t.artist.toLowerCase()}`;
  const albumKey = (t: NormalizedTrack) =>
    t.albumMbid || `name:${t.artist.toLowerCase()}::${t.album.toLowerCase()}`;

  const artistJobs = new Map<string, { name: string; mbid: string }>();
  const albumJobs = new Map<string, { artist: string; album: string; mbid: string }>();
  for (const t of all) {
    if (t.artist) {
      const k = artistKey(t);
      if (!artistJobs.has(k)) artistJobs.set(k, { name: t.artist, mbid: t.artistMbid });
    }
    if (t.album) {
      const k = albumKey(t);
      if (!albumJobs.has(k)) {
        albumJobs.set(k, { artist: t.artist, album: t.album, mbid: t.albumMbid });
      }
    }
  }

  const trackInfoPromise = Promise.all(all.map((t) => getTrackInfo(t, env, ctx)));
  const artistEntries = Array.from(artistJobs.entries());
  const albumEntries = Array.from(albumJobs.entries());
  const artistInfoPromise = Promise.all(
    artistEntries.map(([, a]) => getArtistInfo(a.name, a.mbid, env, ctx)),
  );
  const albumInfoPromise = Promise.all(
    albumEntries.map(([, a]) => getAlbumInfo(a.artist, a.album, a.mbid, env, ctx)),
  );

  const [trackInfos, artistInfos, albumInfos] = await Promise.all([
    trackInfoPromise,
    artistInfoPromise,
    albumInfoPromise,
  ]);

  const artistMap = new Map<string, ArtistInfo | null>();
  artistEntries.forEach(([k], i) => artistMap.set(k, artistInfos[i]));
  const albumMap = new Map<string, AlbumInfo | null>();
  albumEntries.forEach(([k], i) => albumMap.set(k, albumInfos[i]));

  const enrich = (t: NormalizedTrack, info: TrackInfo | null): EnrichedTrack => ({
    ...t,
    info,
    artistInfo: t.artist ? artistMap.get(artistKey(t)) ?? null : null,
    albumInfo: t.album ? albumMap.get(albumKey(t)) ?? null : null,
  });

  const enrichedNowPlaying = nowPlaying ? enrich(nowPlaying, trackInfos[0]) : null;
  const offset = nowPlaying ? 1 : 0;
  const enrichedRecent = recent.map((t, i) => enrich(t, trackInfos[offset + i]));

  return jsonResponse(env, {
    user: env.LASTFM_USER,
    nowPlaying: enrichedNowPlaying,
    recent: enrichedRecent,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      return getRecentTracks(env, ctx);
    }

    return jsonResponse(env, { error: 'Not found' }, 404);
  },
};
