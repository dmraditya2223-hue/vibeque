// proxy.js — CommonJS (no "type":"module" needed)
// Last.fm  → similar tracks
// iTunes   → album art (600x600) + 30s preview MP3
// No extra API keys beyond LASTFM_API_KEY

const express   = require('express');
const fetch     = require('node-fetch');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

if (!process.env.LASTFM_API_KEY) {
  console.error('[server] LASTFM_API_KEY not set. Add it in Render → Environment.');
  process.exit(1);
}

app.use(express.json({ limit: '20kb' }));
app.use(express.static(__dirname));

// ── Rate limiter ──────────────────────────────────────────────
const ipHits = new Map();
function rateLimit(req, res, next) {
  const ip  = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter(t => now - t < 60000);
  if (hits.length >= 20) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }
  hits.push(now);
  ipHits.set(ip, hits);
  next();
}

// ── Helpers ───────────────────────────────────────────────────
function msToMinSec(ms) {
  if (!ms || ms === '0') return '3:30';
  const total = Math.floor(Number(ms) / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return m + ':' + s;
}

function vibeTitle(track, artist) {
  const s = (track + ' ' + artist).toLowerCase();
  if (s.includes('night') || s.includes('dark'))   return 'After Midnight, Lights Low';
  if (s.includes('love')  || s.includes('heart'))  return 'Warm Like a Second Glass of Wine';
  if (s.includes('road')  || s.includes('drive'))  return 'Windows Down, Road Wide Open';
  if (s.includes('rain')  || s.includes('cold'))   return 'Grey Skies and Quiet Rooms';
  if (s.includes('sun')   || s.includes('summer')) return 'Golden Hour, Nowhere to Be';
  if (s.includes('fire')  || s.includes('burn'))   return 'Heat Rising, Pulse Quickening';
  if (s.includes('dance') || s.includes('party'))  return 'Floor Packed, Volume Up';
  if (s.includes('sad')   || s.includes('cry'))    return 'Feelings at 3am';
  if (s.includes('dream') || s.includes('sleep'))  return 'Drift Into Something Softer';
  return 'Sounds That Feel Like This One';
}

// ── iTunes: fetch art + preview for one track ─────────────────
async function getItunesData(title, artist) {
  try {
    const q   = encodeURIComponent(title + ' ' + artist);
    const url = 'https://itunes.apple.com/search?term=' + q + '&entity=song&limit=3&media=music';
    const res  = await fetch(url, { timeout: 5000 });
    const data = await res.json();
    const results = data && data.results ? data.results : [];
    if (results.length === 0) return { image: '', preview: '' };

    // Try to find the best match (exact artist name match preferred)
    let item = results.find(r =>
      r.artistName && r.artistName.toLowerCase().includes(artist.toLowerCase())
    ) || results[0];

    const image   = item.artworkUrl100
      ? item.artworkUrl100.replace('100x100bb', '600x600bb')
      : '';
    const preview = item.previewUrl || '';
    const album   = item.collectionName || '';
    const year    = item.releaseDate ? item.releaseDate.substring(0, 4) : '';

    return { image, preview, album, year };
  } catch (e) {
    return { image: '', preview: '', album: '', year: '' };
  }
}

// ── /api/generate ─────────────────────────────────────────────
app.post('/api/generate', rateLimit, function(req, res) {
  const { song } = req.body;
  if (!song || typeof song !== 'string' || song.length > 200) {
    return res.status(400).json({ error: 'Invalid input.' });
  }

  const KEY = process.env.LASTFM_API_KEY;

  // Parse "Song by Artist" or "Song - Artist" or just "Song"
  let trackName = song.trim();
  let artistName = '';
  const byMatch   = song.match(/^(.+?)\s+by\s+(.+)$/i);
  const dashMatch = song.match(/^(.+?)\s*[-–]\s*(.+)$/);
  if (byMatch)        { trackName = byMatch[1].trim();   artistName = byMatch[2].trim(); }
  else if (dashMatch) { trackName = dashMatch[1].trim(); artistName = dashMatch[2].trim(); }

  // Step 1: Search Last.fm for canonical track
  const searchUrl =
    'https://ws.audioscrobbler.com/2.0/?method=track.search' +
    '&track=' + encodeURIComponent(trackName) +
    (artistName ? '&artist=' + encodeURIComponent(artistName) : '') +
    '&api_key=' + KEY + '&format=json&limit=1';

  fetch(searchUrl)
    .then(function(r) { return r.json(); })
    .then(function(searchData) {
      const matches = searchData &&
        searchData.results &&
        searchData.results.trackmatches &&
        searchData.results.trackmatches.track;

      if (!matches || (Array.isArray(matches) && matches.length === 0)) {
        return res.status(404).json({
          error: 'Could not find "' + song + '" on Last.fm. Try adding the artist name, e.g. "Blinding Lights by The Weeknd"'
        });
      }

      const seed       = Array.isArray(matches) ? matches[0] : matches;
      const seedName   = seed.name;
      const seedArtist = seed.artist;

      // Step 2: Get similar tracks from Last.fm
      const simUrl =
        'https://ws.audioscrobbler.com/2.0/?method=track.getSimilar' +
        '&track=' + encodeURIComponent(seedName) +
        '&artist=' + encodeURIComponent(seedArtist) +
        '&api_key=' + KEY + '&format=json&limit=30&autocorrect=1';

      return fetch(simUrl)
        .then(function(r) { return r.json(); })
        .then(function(simData) {
          const raw = (simData && simData.similartracks && simData.similartracks.track) || [];

          if (raw.length === 0) {
            return res.status(404).json({
              error: 'No similar tracks found for "' + seedName + '". Try a more popular song.'
            });
          }

          // Step 3: Deduplicate artists, pick up to 12
          const seen   = new Set();
          const picked = [];
          for (var i = 0; i < raw.length; i++) {
            if (picked.length >= 12) break;
            var t    = raw[i];
            var aKey = t.artist && t.artist.name ? t.artist.name.toLowerCase() : '';
            if (seen.has(aKey) && picked.length < 9) continue;
            seen.add(aKey);
            picked.push(t);
          }
          for (var j = 0; j < raw.length; j++) {
            if (picked.length >= 12) break;
            var rt = raw[j];
            if (!picked.some(function(x) { return x.name === rt.name; })) {
              picked.push(rt);
            }
          }

          // Step 4: Fetch iTunes data (art + preview) for all tracks in parallel
          var itunesPromises = picked.map(function(t) {
            return getItunesData(t.name, t.artist ? t.artist.name : '');
          });

          return Promise.all(itunesPromises).then(function(itunesResults) {
            // Step 5: Build final track list
            var tracks = picked.map(function(t, idx) {
              var it = itunesResults[idx];
              return {
                id:       idx + 1,
                title:    t.name,
                artist:   t.artist ? t.artist.name : 'Unknown',
                album:    it.album  || (t.album && t.album.title) || '—',
                year:     it.year   || (t.wiki && t.wiki.published ? new Date(t.wiki.published).getFullYear() : '—'),
                duration: msToMinSec(t.duration),
                image:    it.image   || '',
                preview:  it.preview || '',
                url:      t.url      || ''
              };
            });

            return res.json({
              seed_song:        seedName + ' by ' + seedArtist,
              vibe_title:       vibeTitle(seedName, seedArtist),
              vibe_description: 'A playlist that picks up right where "' + seedName + '" leaves off — same energy, same feeling, new songs to discover.',
              mood_tags:        ['similar vibes', 'curated', 'discover', 'mood match', 'playlist'],
              energy_level:     'Medium Energy',
              bpm_range:        'Similar tempo',
              tracks:           tracks
            });
          });
        });
    })
    .catch(function(e) {
      console.error('[server]', e.message);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    });
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', function(_req, res) {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── SPA fallback ──────────────────────────────────────────────
app.get('*', function(_req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('[vibe-playlist] Running on port ' + PORT);
});
