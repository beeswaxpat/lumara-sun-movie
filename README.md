# Sun movie: the last 24 hours of the Sun

The last 24 hours of the Sun as NASA's Solar Dynamics Observatory (SDO) saw them, one picture every 5 minutes, played as a 12 second loop. It is rebuilt every 3 hours with plain ffmpeg and published on GitHub Pages. The Lumara app and [lumara-space.app](https://lumara-space.app) show it.

There are two movies:

- **AIA 171**, the gold one: the Sun's outer atmosphere (the corona) at about 600,000 degrees. It is the channel NASA's own rolling movie used.
- **AIA 304**, the red one: the layer just above the surface (the chromosphere).

The time printed on each frame is when that picture was taken, in UTC, rounded to the nearest minute.

## Credit

Images: **NASA/SDO and the AIA science team, via Helioviewer.org.** Helioviewer is a project of ESA and NASA. This project is not made or endorsed by NASA, ESA or Helioviewer.

## How to watch it

- In a browser: https://beeswaxpat.github.io/lumara-sun-movie/
- The movies: `sun-24h-171.mp4` and `sun-24h-304.mp4` at that address.
- Next to each movie is a small JSON file (`sun-24h-171.json`, `sun-24h-304.json`) that says what is in it.

An app or site that shows the movie should:

1. Read the JSON file first.
2. Show its newest frame time (`newestLabel`, or `newestFrameUtc` in the viewer's own words).
3. Treat the movie as out of date when `newestFrameUtc` is more than 6 hours ago, and say so.
4. Load the movie as `sun-24h-171.mp4?v=<version>`. `version` changes whenever the movie does, so a cached old movie is never shown as new.

The movies are 1024 by 1024 pixels, H.264, 24 frames a second, 288 frames (12 seconds), 5 to 10 MB each, with the index at the front so they start playing before they finish loading.

### The JSON file

From the local test run of 2026-09-29:

```json
{
  "schema": 1,
  "channel": "171",
  "name": "AIA 171",
  "movie": "sun-24h-171.mp4",
  "version": "329b7c1dc720",
  "newestFrameUtc": "2026-09-29T07:30:09Z",
  "oldestFrameUtc": "2026-09-28T07:34:45Z",
  "newestLabel": "Newest frame 07:30 UTC",
  "frameCount": 288,
  "slots": 288,
  "missingFrames": 0,
  "fps": 24,
  "durationSeconds": 12,
  "width": 1024,
  "height": 1024,
  "bytes": 9218449,
  "sha256": "329b7c1dc720305610bbab6df425ba5e04f93d9cbbfba4f3915481c4d4f82938",
  "crf": 18,
  "brightness": "nasa",
  "builtUtc": "2026-09-29T07:58:51Z",
  "credit": "NASA/SDO and the AIA science team, via Helioviewer.org"
}
```

`newestFrameUtc` and `oldestFrameUtc` are exact, to the second. Only `newestLabel` and the time printed on the frames are rounded to the nearest minute. `missingFrames` counts 5 minute slots where no real picture exists (the spacecraft sometimes pauses); a missing slot is simply skipped, never filled in.

## How it is made

A GitHub Actions workflow (`.github/workflows/sun-movie.yml`) runs every 3 hours at 23 minutes past the hour, and can also be started by hand. Each run:

1. Runs the tests, then a self-test that proves the runner's ffmpeg prints the time on a frame and applies the brightness curve.
2. For each channel, asks Helioviewer for its newest picture, lays out 288 slots 5 minutes apart back from it, and fills each slot with the real picture closest to it (within 150 seconds).
3. Keeps the pictures between runs in the Actions cache, so a run downloads only the ones that are new since the last run (about 36 per channel). Pictures older than 27 hours are deleted, and each channel's cache has a hard ceiling of 120 MB. Only the newest two cache entries are kept.
4. Stops the channel if its newest picture is more than 3 hours old, or if fewer than 144 of the 288 slots have a real picture.
5. Makes the movie with one plain ffmpeg command: the brightness curve, 1024 px, the UTC time printed bottom left, H.264. It tries a few quality settings until the file is 5 to 10 MB.
6. Checks the movie with ffprobe (codec, size, pixel format, frame count, frame rate, length, bytes), checks the index is at the front, and checks that the printed time can be seen on the first and last frames.
7. Publishes. See below.

Helioviewer's pictures of AIA run about 30 to 60 minutes behind real time, so that is the normal age of the newest frame.

### Where the pictures come from

The [Helioviewer API](https://api.helioviewer.org/docs/v2/), version 2:

- `getClosestImage?date=<time>&sourceId=<n>` gives the picture closest to a time, with its id and the time it was taken ([docs](https://api.helioviewer.org/docs/v2/api/api_groups/official_clients.html)).
- `downloadImage?id=<id>&width=1024&type=jpg` gives that picture in NASA's standard AIA colours, about 95 KB ([docs](https://api.helioviewer.org/docs/v2/api/api_groups/jpeg2000.html)).
- Source ids: 10 is AIA 171, 13 is AIA 304 ([list](https://api.helioviewer.org/docs/v2/appendix/data_sources.html)).

The script asks politely: one request at a time, at least 300 ms apart, a User-Agent that names the project, up to 4 tries with a growing wait (or the wait the server asks for) on timeouts and busy answers. If the main server fails 5 times in a row it is left alone for the rest of the run and Helioviewer's mirror in France (`helioviewer-api.ias.u-psud.fr`, the same pictures) is used instead.

### Publishing

The movies are published on GitHub Pages from the `gh-pages` branch. Each run replaces that branch with a single new commit (force-pushed) holding only:

- `sun-24h-171.mp4` and `sun-24h-171.json`
- `sun-24h-304.mp4` and `sun-24h-304.json`
- `index.html`, a small page that plays them
- `.nojekyll`, an empty file that tells Pages to serve the files as they are

So the branch never builds up history. The workflow uses only the built-in `GITHUB_TOKEN`: `contents: write` to push the branch, `actions: write` to delete old frame caches, and `pages: write` to ask Pages to deploy, because GitHub does not start a Pages build for a push made with `GITHUB_TOKEN` ([GitHub docs](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)). Two runs never overlap.

It fails closed:

- A movie is published only if it passed every check in step 6, and its JSON file matches it (name, size and sha256).
- If one channel fails, the copy already published is kept only while its newest frame is less than 6 hours old. After that the channel is left out, so an old movie is never put up again.
- If no channel has a fresh movie, nothing is pushed and the run is marked failed (GitHub emails the owner). What is already published stays, and its JSON files still carry the true frame times, so apps can see how old it is.

## Brightness

Helioviewer's pictures are darker than NASA's own SDO pictures of the same moment (for AIA 171, about 40 percent darker on average). They use the same colour table; they scale the brightness differently. So each frame goes through a fixed curve per colour channel (red, green, blue) that makes it as bright as NASA's own picture of the same instant. The curves are in `brightness/aia-171.cube` and `brightness/aia-304.cube` (a plain text format ffmpeg's `lut1d` filter reads), and how they were made is in `brightness/fit.json`.

This is on by default (`nasa`). To publish the pictures exactly as Helioviewer gives them, set the repository variable `SUN_MOVIE_BRIGHTNESS` to `off` (Settings, Secrets and variables, Actions, Variables), or run the script with `--brightness off`. The JSON file says which was used.

How the curves were made (`tools/fit-brightness.mjs`):

1. Take 8 of NASA's own SDO browse pictures per channel, spread over two days, from `https://sdo.gsfc.nasa.gov/assets/img/browse/`. Their file names carry the time they were taken.
2. For each, fetch Helioviewer's picture of the same moment (at most 13 seconds apart; AIA takes a picture every 12 seconds).
3. Pool the pixels (leaving out NASA's printed label along the bottom) and, for each brightness level, find the level at the same place in NASA's pictures. This is called histogram matching.
4. At the dark end, fade the matched colour smoothly to black, by the same amount in all three colour channels. Helioviewer cuts the faintest glow around the Sun to black where NASA's pictures still show it. Without the fade the edge of that glow would show as a hard line, and fading each channel on its own would turn it brown. The glow still ends a little sooner than in NASA's pictures, because those faintest levels are not in Helioviewer's frames at all.

Result on the 8 pairs (0 to 255 scale, average brightness of the whole picture):

| | NASA | Helioviewer, off | Helioviewer, nasa |
|---|---|---|---|
| AIA 171 | 63.3 | 37.0 | 62.2 |
| AIA 304 | 22.5 | 20.1 | 22.5 |

The average difference per pixel from NASA's picture drops from 21.4 to 2.7 for 171, and from 6.9 to 2.8 for 304. For 304 the curve also softens the brightest spots, as NASA's pictures do. `tools/compare-brightness.mjs --out compare.png` makes a before and after picture on a moment the curve was not fitted on. The movie itself never contacts NASA.

## ffmpeg versions

The workflow runs on Ubuntu 24.04, whose ffmpeg is version 6.1 (with libx264, and drawtext built with FreeType and HarfBuzz). It was built and tested locally with ffmpeg 8.0.1. Every option used was checked against the ffmpeg 6.1 sources and documentation, and none differ: the concat demuxer's `file_packet_meta`, the decoder passing that text on to the frame, `drawtext` with `%{metadata:...}` and `lh`, `lut1d` reading `.cube` files, `setparams`, `-fps_mode`, `+faststart`. The self-test in step 1 proves it on the runner before anything is downloaded, and the check in step 6 would stop a movie without a visible time.

## Run it yourself

Needs Node 22 or later and ffmpeg with libx264, drawtext and lut1d, plus ffprobe. No npm packages.

```
node src/sun-movie.mjs                     # both channels, into out/
node src/sun-movie.mjs --channels 171      # one channel
node src/sun-movie.mjs --brightness off    # Helioviewer's pictures as they come
node src/sun-movie.mjs --self-test         # check ffmpeg only
node src/site.mjs                          # put the Pages files together in site/
node --test "test/*.test.mjs"              # tests (no network)
```

Other options: `--cache-dir DIR` (default `.cache`), `--out-dir DIR` (default `out`), `--max-age-hours N` (default 3). `SUN_MOVIE_CHANNELS`, `SUN_MOVIE_BRIGHTNESS`, `SUN_MOVIE_CACHE_DIR` and `SUN_MOVIE_OUT_DIR` in the environment do the same. The first run makes about 577 requests per channel (288 pictures, about 30 MB) and takes a few minutes; later runs download only what is new.

Settings (channels, sizes, limits, the look of the printed time) are in `src/config.mjs`. The look of the printed time (Roboto, 20 px, white, bottom left) is a placeholder waiting for approval.

## License

The code is under the MIT license (`LICENSE`). The Roboto font in `fonts/` is by Google under the Apache License 2.0 (`fonts/LICENSE-Roboto.txt`). The Sun pictures are NASA's: NASA/SDO and the AIA science team, via Helioviewer.org.
