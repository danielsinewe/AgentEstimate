import { useEffect, useState, useSyncExternalStore } from 'react';
import { subscribeToAuth } from './lib/supabase';
import { AHREFS_CONSENT_KEY, AHREFS_GRANT_MESSAGE, ahrefsConsent, publicAhrefsLocation } from './publicAhrefs';

const consentEvent = 'agent-eta:ahrefs-consent';
function readChoice() {
  try { return ahrefsConsent(localStorage.getItem(AHREFS_CONSENT_KEY)) ?? 'unselected'; }
  catch { return 'unselected'; }
}
function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(consentEvent, onChange);
  return () => { window.removeEventListener('storage', onChange); window.removeEventListener(consentEvent, onChange); };
}
export default function PublicAhrefs() {
  const stored = useSyncExternalStore(subscribe, readChoice, () => 'unready');
  const [anonymous, setAnonymous] = useState(false);
  const [callbackAtEntry] = useState(() => /(?:access_token|refresh_token|error_description)=/u.test(window.location.hash));
  const [sessionChoice, setSessionChoice] = useState<'granted' | 'denied' | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const subscription = subscribeToAuth((_event, session) => setAnonymous(session === null));
    if (!subscription) setAnonymous(true);
    return () => subscription?.unsubscribe();
  }, []);
  const choice = sessionChoice ?? stored;
  const ready = stored !== 'unready' && anonymous && !callbackAtEntry;
  const href = ready ? window.location.href : '';
  const eligible = ready && publicAhrefsLocation(href, 'granted') !== null;
  const page = ready ? publicAhrefsLocation(href, choice,
    navigator as Navigator & { globalPrivacyControl?: boolean },
    Reflect.get(window, '__agentEtaAnalyticsAllowed') !== false
      && !['owner', 'qa'].includes(String(Reflect.get(window, '__agentEtaAnalyticsContext') ?? '')),
  ) : null;
  function choose(next: 'granted' | 'denied') {
    try {
      localStorage.setItem(AHREFS_CONSENT_KEY, JSON.stringify({ choice: next, expires: Date.now() + 180 * 86_400_000 }));
      setSessionChoice(null);
      window.dispatchEvent(new Event(consentEvent));
    } catch { setSessionChoice(next); }
    setOpen(false);
  }
  if (!eligible) return null;
  const tracker = page ? <iframe data-ahrefs-public="" hidden title="Optional public website analytics"
    sandbox="allow-scripts" referrerPolicy="no-referrer" src="/ahrefs-public"
    onLoad={(event) => event.currentTarget.contentWindow?.postMessage({ type: AHREFS_GRANT_MESSAGE }, '*')} /> : null;
  return <>
    {tracker}
    {['granted', 'denied'].includes(choice) && !open
      ? <button className="public-ahrefs-preferences" type="button" onClick={() => setOpen(true)}>Ahrefs visit preferences</button>
      : <section className="public-ahrefs-panel" aria-labelledby="public-ahrefs-title">
        <h2 id="public-ahrefs-title">Optional Ahrefs visit analytics</h2>
        <p>Allow Ahrefs to measure visits to this public landing page? It receives a fixed public path, a generic title and browser/device information in an isolated document. Private runs, accounts, form entries, queries, fragments and referring URLs are excluded. This choice lasts 180 days; you can decline or withdraw at any time. Browser privacy signals prevent collection.</p>
        <p><a href="https://ahrefs.com/privacy-policy" target="_blank" rel="noreferrer noopener">Ahrefs privacy policy</a></p>
        <div><button type="button" onClick={() => choose('denied')}>Decline Ahrefs</button><button type="button" onClick={() => choose('granted')}>Allow Ahrefs visits</button></div>
      </section>}
  </>;
}
