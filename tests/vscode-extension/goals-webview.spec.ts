// goals-webview (P12.23 + goal-clarification-gate) — static checks on the pure Goals panel HTML.
// Requirements 1.6, 8.8. The inline script is only PARSED (new Function), never executed.
import { describe, it, expect } from 'vitest';
import { goalsPanelHtml } from '../../packages/vscode-extension/src/goals-webview.js';

const NONCE = 'TestNonce123abc';
const html = goalsPanelHtml(NONCE);

function scriptBody(doc: string): string {
  const m = /<script nonce="([^"]*)">([\s\S]*?)<\/script>/.exec(doc);
  if (m === null) throw new Error('no inline <script nonce> found');
  return m[2] ?? '';
}

describe('goalsPanelHtml', () => {
  it('includes an accessible live region and the needs-input chip', () => {
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toContain('<span class="chip needs-input">needs input</span>');
  });

  it('handles clarifyResult and posts clarify messages', () => {
    expect(html).toContain("m.type === 'clarifyResult'");
    expect(html).toContain('onClarifyResult(m)');
    expect(html).toContain("type: 'clarify'");
  });

  it('renders both action buttons', () => {
    expect(html).toContain('Send answers');
    expect(html).toContain('Use defaults for all');
  });

  it('has a fieldset/legend path for suggested options', () => {
    expect(html).toContain('<fieldset');
    expect(html).toContain('<legend>');
    expect(html).toContain('</legend>');
  });

  it('escapes question text with esc()', () => {
    expect(html).toContain('esc(q.text)');
  });

  it('uses the same nonce in the CSP and the script tag', () => {
    const csp = /script-src 'nonce-([^']+)'/.exec(html);
    const tag = /<script nonce="([^"]+)">/.exec(html);
    expect(csp?.[1]).toBe(NONCE);
    expect(tag?.[1]).toBe(NONCE);
  });

  it('inline script body is syntactically valid JavaScript (parse only)', () => {
    const body = scriptBody(html);
    expect(body.length).toBeGreaterThan(0);
    // Constructing the Function parses the body; we never call it.
    expect(() => new Function(body)).not.toThrow();
  });
});
