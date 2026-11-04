export const AHREFS_CONSENT_KEY = 'agent-eta.ahrefs-consent.v1';
export const AHREFS_GRANT_MESSAGE = 'agent-eta:public-ahrefs-grant:v1';
const maxAge = 180 * 86_400_000;
type Privacy = { doNotTrack?: string | null; globalPrivacyControl?: boolean; webdriver?: boolean };

export function ahrefsConsent(value: string | null, now = Date.now()): 'granted' | 'denied' | null {
  try {
    const record = JSON.parse(value ?? 'null');
    if (!record || !['granted', 'denied'].includes(record.choice)
      || !Number.isFinite(record.expires) || record.expires <= now || record.expires > now + maxAge) return null;
    return record.choice;
  } catch { return null; }
}

export function publicAhrefsLocation(href: string, choice: string, privacy: Privacy = {}, publicAllowed = true): string | null {
  if (choice !== 'granted' || !publicAllowed || privacy.doNotTrack === '1' || privacy.doNotTrack === 'yes'
    || privacy.globalPrivacyControl === true || privacy.webdriver === true) return null;
  try {
    const url = new URL(href);
    if (url.origin !== 'https://agentestimate.vercel.app' || url.username || url.password || url.pathname !== '/'
      || ['qa', '__qa', 'owner_preview', 'test_mode', 'code', 'access_token', 'refresh_token'].some((key) => url.searchParams.has(key))
      || /(?:access_token|refresh_token|error_description)=/u.test(url.hash)) return null;
    return 'https://agentestimate.vercel.app/';
  } catch { return null; }
}
