import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AHREFS_CONSENT_KEY, AHREFS_GRANT_MESSAGE, ahrefsConsent, publicAhrefsLocation } from './publicAhrefs';

describe('public Ahrefs consent boundary', () => {
  it('requires separate explicit consent and resolved anonymous eligibility', () => {
    expect(AHREFS_CONSENT_KEY).toBe('agent-eta.ahrefs-consent.v1');
    for (const choice of ['unready', 'unselected', 'denied', 'true'])
      expect(publicAhrefsLocation('https://agentestimate.vercel.app/', choice)).toBeNull();
    expect(publicAhrefsLocation('https://agentestimate.vercel.app/', 'granted', {}, false)).toBeNull();
    expect(publicAhrefsLocation('https://agentestimate.vercel.app/', 'granted')).toBe('https://agentestimate.vercel.app/');
  });
  it('excludes private, callback, tenant, preview and credential URLs', () => {
    for (const url of [
      'https://agentestimate.vercel.app/overview', 'https://agentestimate.vercel.app/ahrefs-public',
      'https://agentestimate.vercel.app/?code=fixture', 'https://agentestimate.vercel.app/#access_token=fixture',
      'https://agentestimate.vercel.app/#refresh_token=fixture', 'https://preview.vercel.app/',
      'https://owner:fixture@agentestimate.vercel.app/', 'https://agentestimate.vercel.app:8443/',
      'http://agentestimate.vercel.app/', 'invalid',
    ]) expect(publicAhrefsLocation(url, 'granted')).toBeNull();
  });
  it('removes all ordinary query and fragment content', () => {
    expect(publicAhrefsLocation('https://agentestimate.vercel.app/?email=fixture@example.invalid#private', 'granted'))
      .toBe('https://agentestimate.vercel.app/');
  });
  it('honors privacy signals, automation and QA markers', () => {
    for (const privacy of [{ doNotTrack: '1' }, { doNotTrack: 'yes' }, { webdriver: true }, { globalPrivacyControl: true }])
      expect(publicAhrefsLocation('https://agentestimate.vercel.app/', 'granted', privacy)).toBeNull();
    for (const key of ['qa', '__qa', 'owner_preview', 'test_mode'])
      expect(publicAhrefsLocation(`https://agentestimate.vercel.app/?${key}=1`, 'granted')).toBeNull();
  });
  it('rejects missing, invalid, expired and unbounded native choices', () => {
    const now = 100_000_000;
    for (const value of [null, 'granted', '{}', JSON.stringify({ choice: 'granted', expires: now }),
      JSON.stringify({ choice: 'granted', expires: now + 181 * 86_400_000 })])
      expect(ahrefsConsent(value, now)).toBeNull();
    expect(ahrefsConsent(JSON.stringify({ choice: 'denied', expires: now + 1000 }), now)).toBe('denied');
  });
});

const html = readFileSync(new URL('../public/ahrefs-public.html', import.meta.url), 'utf8');
const childScript = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
function isolatedDocument(direct = false) {
  const parent = {};
  const scripts: Array<{ src?: string; async?: boolean; dataset: Record<string, string> }> = [];
  let listener: ((event: { source: object; origin: string; data: { type: string } }) => void) | undefined;
  const window = { parent, addEventListener: (_type: string, handler: typeof listener) => { listener = handler; } };
  if (direct) window.parent = window;
  const document = { createElement: () => ({ dataset: {} }), head: { appendChild: (script: typeof scripts[number]) => scripts.push(script) } };
  if (!childScript) throw new Error('Missing isolated document handler');
  runInNewContext(childScript, { window, document });
  return { parent, scripts, send: (source: object, origin: string, type: string) => listener?.({ source, origin, data: { type } }) };
}
describe('empty analytics document parent handshake', () => {
  it('loads no SDK on direct navigation or before a grant', () => {
    expect(isolatedDocument(true).scripts).toHaveLength(0);
    expect(isolatedDocument().scripts).toHaveLength(0);
    expect(html).toContain('<title>Agent ETA public website</title>');
    expect(html).not.toMatch(/<form|<a\s|document\.referrer|location\./u);
  });
  it('rejects another origin, another window and unrelated messages', () => {
    const frame = isolatedDocument();
    frame.send(frame.parent, 'https://example.invalid', AHREFS_GRANT_MESSAGE);
    frame.send({}, 'https://agentestimate.vercel.app', AHREFS_GRANT_MESSAGE);
    frame.send(frame.parent, 'https://agentestimate.vercel.app', 'unrelated');
    expect(frame.scripts).toHaveLength(0);
  });
  it('loads exactly once with a fixed public location after the parent grant', () => {
    const frame = isolatedDocument();
    frame.send(frame.parent, 'https://agentestimate.vercel.app', AHREFS_GRANT_MESSAGE);
    frame.send(frame.parent, 'https://agentestimate.vercel.app', AHREFS_GRANT_MESSAGE);
    expect(frame.scripts).toHaveLength(1);
    expect(frame.scripts[0]?.src).toBe('https://analytics.ahrefs.com/analytics.js');
    expect(frame.scripts[0]?.dataset).toEqual({ key: 'v/M/pXBKB03JRG2FO5f56w', pageLocation: 'https://agentestimate.vercel.app/' });
  });
  it('keeps normal and private routes on the original CSP', () => {
    const config = JSON.parse(readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8'));
    const normal = config.headers[0];
    const child = config.headers[1];
    const matcher = new RegExp(`^${normal.source}$`, 'u');
    for (const path of ['/', '/overview', '/assets/app.js', '/community', '/ahrefs-public-extra']) expect(matcher.test(path)).toBe(true);
    expect(matcher.test('/ahrefs-public')).toBe(false);
    expect(child.source).toBe('/ahrefs-public');
    expect(normal.headers.find((header: { key: string }) => header.key === 'Content-Security-Policy').value)
      .toBe("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://qrdgyonmrznmrauyiesn.supabase.co wss://qrdgyonmrznmrauyiesn.supabase.co; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    expect(child.headers.find((header: { key: string }) => header.key === 'Content-Security-Policy').value)
      .toContain("default-src 'none'; script-src 'unsafe-inline' https://analytics.ahrefs.com");
  });
});
