import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieSession, SESSION_COOKIE } from '../src/cookie-session.js';

const token = 'a'.repeat(43);
const field = (attributes = 'Max-Age=60', value = token) =>
  `${SESSION_COOKIE}=${value}; Path=/browser/; HttpOnly; Secure; SameSite=Strict; ${attributes}`;
test('narrow session policy preserves Expires commas and respects Max-Age precedence/deletion', () => {
  let now = Date.parse('2026-10-24T12:00:00Z');
  const session = new CookieSession(() => now);
  session.accept([
    ['set-cookie', field('Expires=Wed, 21 Oct 2037 07:28:00 GMT; Max-Age=2')],
    ['set-cookie', 'preference=one; Expires=Wed, 21 Oct 2037 07:28:00 GMT'],
  ]);
  assert.equal(session.header('/browser/api/me'), `${SESSION_COOKIE}=${token}`);
  assert.throws(() => session.header('/api/me'));
  now += 2000;
  assert.equal(session.header('/browser/api/me'), undefined);
  session.accept([['set-cookie', field()]]);
  session.accept([['set-cookie', field('Max-Age=0; Expires=Wed, 21 Oct 2037 07:28:00 GMT', '')]]);
  assert.equal(session.header('/browser/api/me'), undefined);
  session.accept([['set-cookie', field('Expires=Thu, 01 Jan 1970 00:00:00 GMT', '')]]);
  assert.equal(session.header('/browser/api/me'), undefined);
});

test('malformed, duplicate or out-of-scope session updates fail closed', () => {
  const session = new CookieSession();
  for (const invalid of [
    field().replace('/browser/', '/'),
    `${field()}; Domain=other.test`,
    field('Max-Age=NaN'),
    field('Max-Age=60; Max-Age=120'),
    field().replace('; Secure', ''),
    field('Expires=invalid'),
    field('', 'bad'),
    field().replace('Strict', 'None'),
    field('Priority=high'),
  ]) {
    session.accept([['set-cookie', field()]]);
    assert.throws(() => session.accept([['set-cookie', invalid]]));
    assert.equal(session.header('/browser/api/me'), undefined);
  }
  assert.throws(() =>
    session.accept([
      ['set-cookie', field()],
      ['set-cookie', field()],
    ]),
  );
});
