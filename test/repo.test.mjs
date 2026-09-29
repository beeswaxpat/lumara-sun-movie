// Repository hygiene and the workflow's promises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from '../src/config.mjs';

// En and em dashes, built from char codes so this file holds neither.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

function repoFiles(dir = ROOT) {
  const skip = new Set(['.git', '.cache', 'out', 'site', 'prev', 'node_modules']);
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...repoFiles(p));
    else out.push(p);
  }
  return out;
}

test('no personal paths, private names or dashes in the repository', () => {
  // Built from pieces so this file does not match itself.
  const banned = [['C', ':\\'].join(''), ['Us', 'ers'].join(''), ['psc', 'ol'].join(''), ['lumara', '-landing'].join('')];
  const textFiles = repoFiles().filter((p) => !/\.(ttf|jpg|png|mp4)$/i.test(p));
  assert.ok(textFiles.length > 10);
  for (const p of textFiles) {
    const text = readFileSync(p, 'utf8');
    for (const b of banned) assert.ok(!text.includes(b), `${relative(ROOT, p)} contains a banned string`);
    if (!p.endsWith('LICENSE-Roboto.txt')) assert.doesNotMatch(text, DASHES, `${relative(ROOT, p)} has an en or em dash`);
  }
});

test('the workflow: schedule, overlap guard, permissions, fail closed', () => {
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'sun-movie.yml'), 'utf8');
  assert.match(wf, /cron: "23 \*\/3 \* \* \*"/);
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /concurrency:\n\s+group: sun-movie\n\s+cancel-in-progress: false/);
  const perms = wf.match(/\npermissions:\n((?:\s+\S.*\n)+)/)[1].split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  assert.deepEqual(perms, ['contents: write', 'actions: write', 'pages: write']);
  assert.match(wf, /--self-test/);
  assert.ok(wf.includes('push --force --quiet "https://github.com/$GITHUB_REPOSITORY.git" gh-pages'), 'force-pushes gh-pages');
  assert.match(wf, /git init --quiet -b gh-pages/, 'an orphan branch: one commit, no history');
  assert.doesNotMatch(wf, /secrets\./, 'only the built-in token');
  for (const m of wf.matchAll(/uses: (\S+)/g)) assert.match(m[1], /^actions\/[a-z-/]+@[0-9a-f]{40}$/, `${m[1]} pinned to a commit`);
});
