import { expect, it } from 'vitest';
import { verifiedWordPressRedirect, WordPressLoginAttempt, wordPressLoginFlow, wordPressSaveOrigins } from '../electron/myvault/wordpress-save';

const origin = 'https://wordpress-fixture.example.test';
const url = origin + '/store/wp-login.php';
const loggedIn = 'wordpress_logged_in_' + '0'.repeat(32) + '=fixture; Path=/; Secure; HttpOnly';
const secureAuth = 'wordpress_sec_' + '0'.repeat(32) + '=fixture; Path=/store/wp-admin; Secure; HttpOnly';
const success = { url, method: 'POST', statusCode: 302, responseHeaders: { Location: ['/store/wp-admin/'], 'Set-Cookie': [loggedIn, secureAuth] } };

it('requires both cookies and a successful same-origin WordPress navigation', () => {
  const flow = wordPressLoginFlow(url)!;
  expect(verifiedWordPressRedirect(flow, success)).toBe(origin + '/store/wp-admin/');
  expect(verifiedWordPressRedirect(flow, { ...success, method: 'GET' })).toBeUndefined();
  expect(verifiedWordPressRedirect(flow, { ...success, statusCode: 200 })).toBeUndefined();
  expect(verifiedWordPressRedirect(flow, { ...success, responseHeaders: { ...success.responseHeaders, Location: ['https://unrelated.example.test/wp-admin/'] } })).toBeUndefined();
  for (const cookie of [secureAuth.replace('; HttpOnly', ''), secureAuth + '; Max-Age=0', secureAuth + '; Domain=example.test']) {
    expect(verifiedWordPressRedirect(flow, { ...success, responseHeaders: { ...success.responseHeaders, 'Set-Cookie': [loggedIn, cookie] } })).toBeUndefined();
  }
  expect(wordPressLoginFlow('http://wordpress-fixture.example.test/wp-login.php')).toBeUndefined();
  expect(wordPressLoginFlow(url + '?action=logout')).toBeUndefined();
});

it('accepts a profile change only after the same profile confirms the update', () => {
  const profile = origin + '/store/wp-admin/profile.php';
  const flow = wordPressLoginFlow(profile)!;
  const attempt = new WordPressLoginAttempt();
  const nonce = attempt.arm(flow);
  expect(attempt.submit('unrelated-nonce', 'fixture', 'changed-site-fixture')).toBe(false);
  expect(attempt.submit(nonce, 'fixture', 'changed-site-fixture')).toBe(true);
  const redirect = '/store/wp-admin/profile.php?updated=true';
  attempt.response({ ...success, url: profile, responseHeaders: { ...success.responseHeaders, Location: [redirect] } });
  const committed = attempt.commit(origin + redirect, 200);
  expect(committed?.username).toBe('fixture');
  expect(committed?.password.equals(Buffer.from('changed-site-fixture'))).toBe(true);
  committed?.password.fill(0);
  expect(attempt.commit(origin + redirect, 200)).toBeUndefined();
  expect(wordPressSaveOrigins([origin, origin, url, 'http://wordpress-fixture.example.test'])).toEqual([origin]);
});
