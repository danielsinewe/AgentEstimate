import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

async function read(relativePath: string) {
  return readFile(resolve(repositoryRoot, relativePath), 'utf8');
}

describe('crawler-facing web shell', () => {
  it('exposes canonical metadata and useful links before JavaScript runs', async () => {
    const html = await read('apps/web/index.html');

    expect(html).toContain('<link rel="canonical" href="https://agentestimate.vercel.app/" />');
    expect(html).toContain('<meta property="og:url" content="https://agentestimate.vercel.app/" />');
    expect(html).toContain('content="https://agentestimate.vercel.app/og-card.svg"');
    expect(html.match(/<a\s/gu)).toHaveLength(2);
    expect(html).toContain('href="/overview"');
    expect(html).toContain('href="https://github.com/danielsinewe/AgentEstimate"');
  });

  it('publishes real crawler files and keeps private history out of the sitemap', async () => {
    const [robots, sitemap] = await Promise.all([
      read('apps/web/public/robots.txt'),
      read('apps/web/public/sitemap.xml'),
    ]);

    expect(robots).toContain('Disallow: /overview');
    expect(robots).toContain('Sitemap: https://agentestimate.vercel.app/sitemap.xml');
    expect(sitemap).toContain('<loc>https://agentestimate.vercel.app/</loc>');
    expect(sitemap).not.toContain('/overview');
  });

  it('routes only the private SPA page and gives unknown URLs linked recovery', async () => {
    const [vercel, notFound] = await Promise.all([
      read('vercel.json'),
      read('apps/web/public/404.html'),
    ]);
    const config = JSON.parse(vercel) as {
      rewrites?: Array<{ source: string; destination: string }>;
      headers?: Array<{ headers?: Array<{ key: string; value: string }> }>;
    };

    expect(config.rewrites).toEqual([{ source: '/overview', destination: '/' }]);
    expect(config.headers?.[0]?.headers?.find((header) => header.key === 'Content-Security-Policy')?.value)
      .toContain('wss://qrdgyonmrznmrauyiesn.supabase.co');
    expect(notFound).toContain('<meta name="robots" content="noindex" />');
    expect(notFound.match(/<a\s/gu)).toHaveLength(2);
  });
});
