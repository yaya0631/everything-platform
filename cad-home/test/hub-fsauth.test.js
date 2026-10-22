/** Tests for every Windows path hazard the drive paths face. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assertSafeSegment, virtualSegments, resolvePath, grantCovers, BadPathError } from '../lib/hub-fsauth.js';

const roots = {
  sandbox: 'D:\\server\\data\\hub-users\\alice\\notes',
  drive: 'D:\\server\\data\\files\\alice',
};

const bad = (input, code) => assert.throws(() => virtualSegments(input), (e) => e instanceof BadPathError && e.code === code, `${JSON.stringify(input)} should fail with ${code}`);

test('rejections: every Windows path hazard', () => {
  bad('a/../b.cad', 'parent_ref');
  bad('..','parent_ref');
  bad('C:/secret.txt', 'windows_drive');
  bad('C:\\x', 'windows_drive');
  bad('\\\\server\\share\\x', 'windows_drive');
  bad('\\\\?\\D:\\x', 'windows_drive');
  bad('a\\b.txt', 'backslash_path');
  bad('..\\b.txt', 'backslash_path');
  bad('a%2e%2e/b.txt', 'trailing_dot_space'); // decodes to 'a..', caught as a dot-ending name
  bad('%2e%2e/b.txt', 'parent_ref'); // decodes to a bare '..' segment
  bad('a/../', 'parent_ref');
  bad('a:b.txt', 'windows_drive'); // leading letter+colon: drive syntax or ADS — both forbidden
  bad('x/a:b.txt', 'invalid_char'); // mid-path colon (ADS)
  bad('a<b', 'invalid_char');
  bad('a>b', 'invalid_char');
  bad('a*b', 'invalid_char');
  bad('a?b', 'invalid_char');
  bad('a|b', 'invalid_char');
  bad('con.txt', 'reserved_name');
  bad('CON', 'reserved_name');
  bad('nul.txt', 'reserved_name');
  bad('com1', 'reserved_name');
  bad('lpt9.TXT', 'reserved_name');
  bad('a.', 'trailing_dot_space');
  bad('a ', 'trailing_dot_space');
  bad('a. .', 'trailing_dot_space');
  bad('a\\x00b', 'backslash_path');
  bad('a\x00b', 'invalid_path');
  bad(42, 'invalid_path');
});

test('accepts the shapes real apps send', () => {
  assert.deepEqual(virtualSegments('Presentations/a.pptx'), ['Presentations', 'a.pptx']);
  assert.throws(() => virtualSegments('./a./b/../c'), BadPathError); // '..' still rejected even with '.' noise
  assert.deepEqual(virtualSegments(''), []);
  assert.deepEqual(virtualSegments('/Documents/Vector Studio/plans.svg'), ['Documents', 'Vector Studio', 'plans.svg']);
  // '~' is kept as a literal segment here; resolvePath consumes it as the root marker
  assert.deepEqual(virtualSegments('~/Documents/manual.pdf'), ['~', 'Documents', 'manual.pdf']);
  // unicode names decode fine
  const unicode = encodeURIComponent('Rückruf.pdf');
  assert.deepEqual(virtualSegments('Presentations/R%C3%BCckruf.pdf').length, 2);
});

test('resolvePath: relative goes to the sandbox, absolute to the Drive', () => {
  const rel = resolvePath({ user: 'alice', app: 'notes', input: 'Presentations/a.pptx', roots });
  assert.equal(rel.kind, 'sandbox');
  assert.equal(rel.target, path.join(roots.sandbox, 'Presentations', 'a.pptx'));

  const abs = resolvePath({ user: 'alice', app: 'notes', input: '/Documents/manual.pdf', roots });
  assert.equal(abs.kind, 'drive');
  assert.equal(abs.target, path.join(roots.drive, 'Documents', 'manual.pdf'));
  assert.equal(abs.virtualPath, '/Documents/manual.pdf');

  // own-username prefix is an alias of the Drive root
  const alias = resolvePath({ user: 'alice', app: 'video-studio', input: '/alice/Videos/r1.mp4', roots });
  assert.equal(alias.kind, 'drive');
  assert.equal(alias.target, path.join(roots.drive, 'Videos', 'r1.mp4'));

  // other usernames are NOT the alias: they are just a folder starting the Drive listing
  const other = resolvePath({ user: 'alice', app: 'x', input: '/notalice/file', roots });
  assert.equal(other.target, path.join(roots.drive, 'notalice', 'file'));

  // tilde is the root
  assert.equal(resolvePath({ user: 'alice', app: 'x', input: '~/', roots }).grantPrefix, '/');

  // case-insensitive alias resolution
  const upper = resolvePath({ user: 'alice', app: 'vs', input: '/ALICE/documents/f.pdf', roots });
  assert.equal(upper.target, path.join(roots.drive, 'documents', 'f.pdf'));

  // no traversing out via the alias route either
  assert.throws(() => resolvePath({ user: 'alice', app: 'x', input: '/alice/../b/vault.zip', roots }), BadPathError);
});

test('grantCovers: exact file on open/save, subtree on directory picks', () => {
  assert.equal(grantCovers('/Documents/manual.pdf', '/Documents/manual.pdf'), true);
  assert.equal(grantCovers('/Documents', '/Documents/manual.pdf'), true);
  assert.equal(grantCovers('/Documents', '/Documents/sub/a'), true);
  assert.equal(grantCovers('/Documents/manual.pdf', '/Documents/manual.pdf.bak'), false); // a different file
  assert.equal(grantCovers('/Documents/manual', '/Documents/manual2.pdf'), false);
  assert.equal(grantCovers('/', '/anything/deep'), true);
  assert.equal(grantCovers('/Doc', '/Documents/a'), false); // no partial-segment match
});

test('grantCovers: Windows filesystems are case-insensitive, others are not', () => {
  const win = process.platform === 'win32';
  // The grant the person picked vs the path the app asks for can differ in
  // case on every platform (the picker normalizes; apps do not).
  assert.equal(grantCovers('/Documents/A.txt', '/Documents/a.txt'), win, 'same case-fold on win32 only');
  assert.equal(grantCovers('/documents/a.txt', '/Documents/A.txt'), win, 'folded both directions on win32');
  assert.equal(grantCovers('/DOCUMENTS', '/documents/sub/x'), win, 'subtree folding on win32');
  assert.equal(grantCovers('/Documents/A.txt', '/Documents/A.txt'), true, 'exact always covers');
  assert.equal(grantCovers('/Documents/A.txt', '/Documents/A.txt.bak'), false, 'different file regardless of case rules');
});
