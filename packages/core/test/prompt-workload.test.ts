import { describe, expect, it } from 'vitest';

import { analyzePrompt } from '../src/index.js';

const cases: Array<{
  prompt: string;
  external: boolean;
  deploy: boolean;
  actions?: number;
  scope?: string;
}> = [
  {
    "prompt": "Review public release docs",
    "external": false,
    "deploy": false,
    "actions": 1,
    "scope": "micro"
  },
  {
    "prompt": "Write release notes in CHANGELOG.md",
    "external": false,
    "deploy": false,
    "actions": 1
  },
  {
    "prompt": "Review deployment documentation",
    "external": false,
    "deploy": false
  },
  {
    "prompt": "Review documentation for Vercel",
    "external": false,
    "deploy": false
  },
  {
    "prompt": "Review local documentation",
    "external": false,
    "deploy": false
  },
  {
    "prompt": "Review local API documentation",
    "external": false,
    "deploy": false
  },
  {
    "prompt": "Review Stripe API documentation",
    "external": false,
    "deploy": false
  },
  {
    "prompt": "Read the production release checklist",
    "external": false,
    "deploy": false
  },
  {
    "prompt": "Deploy the web app to production",
    "external": false,
    "deploy": true
  },
  {
    "prompt": "Publish release notes to the website",
    "external": false,
    "deploy": true
  },
  {
    "prompt": "Review release docs and deploy the app",
    "external": false,
    "deploy": true,
    "actions": 2
  },
  {
    "prompt": "Write release notes, then publish them to production",
    "external": false,
    "deploy": true
  },
  {
    "prompt": "Fetch deployment documentation from https://vercel.com/docs",
    "external": true,
    "deploy": false
  },
  {
    "prompt": "Browse release documentation at https://example.com/release/guide",
    "external": true,
    "deploy": false
  },
  {
    "prompt": "Fetch release docs from Vercel",
    "external": true,
    "deploy": false
  },
  {
    "prompt": "Read online documentation",
    "external": true,
    "deploy": false
  },
  {
    "prompt": "Review local documentation, then call the Stripe API",
    "external": true,
    "deploy": false
  },
  {
    "prompt": "Implement Google sign-in, test it, verify it in the browser, and deploy it",
    "external": true,
    "deploy": true
  },
  {
    "prompt": "Look up current API documentation",
    "external": true,
    "deploy": false
  },
  {
    "prompt": "Review release docs. Do not deploy to production.",
    "external": false,
    "deploy": false
  },
  {
    "prompt": "Do not deploy or publish. Review local docs.",
    "external": false,
    "deploy": false
  },
  {
    "prompt": "Do not fetch remote documentation, but deploy the app.",
    "external": false,
    "deploy": true
  },
  {
    "prompt": "Deploy the app, but do not publish release notes.",
    "external": false,
    "deploy": true
  },
  {
    "prompt": "Review local documentation without external API calls.",
    "external": false,
    "deploy": false
  },
  {
    "prompt": "Do not deploy; then call the Stripe API.",
    "external": true,
    "deploy": false
  },
  {
    "prompt": "Push the app to Vercel",
    "external": false,
    "deploy": true
  },
  {
    "prompt": "Upload the app to the App Store",
    "external": false,
    "deploy": true
  },
  {
    "prompt": "Promote the tested build to production",
    "external": false,
    "deploy": true
  },
  {
    "prompt": "Run vercel --prod",
    "external": false,
    "deploy": true
  },
  {
    "prompt": "Review the source, then make the app live on Cloudflare",
    "external": false,
    "deploy": true
  },
  { "prompt": "No external requests, deploy the app", "external": false, "deploy": true },
  { "prompt": "No deployment, call the Stripe API", "external": true, "deploy": false },
  { "prompt": "Review docs without external API calls, then deploy to production", "external": false, "deploy": true },
  { "prompt": "Do not deploy to production, fetch current API documentation", "external": true, "deploy": false }
];

describe('requested workload rather than documentation subjects', () => {
  it.each(cases)('$prompt', ({ prompt, external, deploy, actions, scope }) => {
    const result = analyzePrompt(prompt);
    expect(result.signals).toMatchObject({ external, deploy });
    if (actions !== undefined) expect(result.actionCount).toBe(actions);
    if (scope !== undefined) expect(result.scope).toBe(scope);
    expect(JSON.stringify(result)).not.toContain(prompt);
  });
});
