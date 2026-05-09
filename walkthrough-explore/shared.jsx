// Shared scaffolding for all 7 walkthrough-generation variations.
// Every variation renders inside an identical <Frame> shell so we're
// comparing the *content area* design, not the chrome.

const FRAME_W = 1024;
const FRAME_H = 640;

// Realistic event log we replay in every variation. Tool, file, blurb.
const SAMPLE_OPS = [
  { t: 'Read',  p: 'apps/api/src/modules/v4/leaf/leafLeaderboard.controller.ts',     n: '+163' },
  { t: 'Read',  p: 'apps/api/src/modules/v4/leaf/leafLeaderboard.service.ts',        n: '−124 +362' },
  { t: 'Read',  p: 'apps/api/src/modules/v4/leaf/leafLeaderboard.repository.ts',     n: '+51'  },
  { t: 'Grep',  p: 'apps/api/src/modules/v4/leaf — "leaderboard"',                   n: '38 hits' },
  { t: 'Read',  p: 'apps/api/src/modules/v4/leaf/__tests__/leaf.spec.ts',            n: '+44'  },
  { t: 'Grep',  p: 'apps/api/src/modules/v4 — "scoreFor"',                           n: '12 hits' },
  { t: 'Read',  p: 'apps/api/src/lib/scoring/decay.ts',                              n: 'ctx'  },
  { t: 'Bash',  p: 'pnpm --filter api test leaderboard',                             n: '12 ✓' },
  { t: 'Read',  p: 'apps/api/src/modules/v4/leaf/leafLeaderboard.controller.ts',     n: 're-read' },
  { t: 'Edit',  p: 'apps/api/src/modules/v4/leaf/leafLeaderboard.service.ts',        n: '+8'  },
];

// 6-step plan (Connect → Explore → Analyze → Write → Score → Finish)
const PIPELINE = [
  { id: 'connect', label: 'Connect',  blurb: 'Authorize · clone repo · checkout branch' },
  { id: 'explore', label: 'Explore',  blurb: 'Read changed files & related context' },
  { id: 'analyze', label: 'Analyze',  blurb: 'Reason about diffs · spot risk' },
  { id: 'write',   label: 'Write',    blurb: 'Draft overview & per-hunk findings' },
  { id: 'score',   label: 'Score',    blurb: 'Rate clarity, correctness, fit' },
  { id: 'finish',  label: 'Finalize', blurb: 'Stitch sections · render diff' },
];

// Outline of the published 4-section walkthrough.
const SECTIONS = [
  { id: 'overview',  label: 'Overview' },
  { id: 'diff',      label: 'Diff Analysis' },
  { id: 'sentiment', label: 'Sentiment' },
  { id: 'rated',     label: 'Rated' },
];

// Tone color for each tool tag — Linear-quiet palette.
function toolStyle(tool) {
  switch (tool) {
    case 'Read': return { fg: '#1d4ed8', bg: '#eff5ff' };
    case 'Grep': return { fg: '#7c3aed', bg: '#f5f0ff' };
    case 'Bash': return { fg: '#15803d', bg: '#ecfaf0' };
    case 'Edit': return { fg: '#b45309', bg: '#fdf3e2' };
    default:     return { fg: '#475569', bg: '#eef1f5' };
  }
}

// Window chrome — the stuff outside the content frame, kept identical
// across all 7 variations so the eye drops straight to the body.
function Frame({ title, subtitle, children, accent = false, dark = false, hideTabs = false, narrow = false }) {
  const bg = dark ? '#0c0d10' : '#ffffff';
  const fg = dark ? '#e7e8eb' : 'var(--revv-text-primary)';
  const subtle = dark ? '#1c1e23' : 'var(--revv-border-subtle)';
  return (
    <div style={{
      width: FRAME_W, height: FRAME_H,
      background: bg,
      borderRadius: 10,
      overflow: 'hidden',
      boxShadow: '0 1px 0 rgba(0,0,0,0.04), 0 12px 32px -8px rgba(0,0,0,0.10)',
      display: 'flex', flexDirection: 'column',
      color: fg,
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    }}>
      {/* titlebar */}
      <div style={{
        height: 36, flexShrink: 0,
        display: 'flex', alignItems: 'center',
        padding: '0 14px',
        background: dark ? '#0c0d10' : '#ffffff',
        borderBottom: `1px solid ${subtle}`,
        gap: 12,
      }}>
        <div style={{ display: 'flex', gap: 7 }}>
          <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#ff5f57' }} />
          <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#febc2e' }} />
          <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#28c840' }} />
        </div>
        {!hideTabs && (
          <div style={{
            margin: '0 auto',
            display: 'flex', gap: 2,
            background: dark ? '#15171c' : '#f1f1f3',
            padding: 3, borderRadius: 7,
            fontSize: 11.5, fontWeight: 500,
          }}>
            <div style={{ padding: '4px 12px', borderRadius: 5,
              background: dark ? '#22252b' : '#fff',
              color: fg,
              whiteSpace: 'nowrap',
              boxShadow: dark ? 'none' : '0 1px 2px rgba(0,0,0,0.06)' }}>Walkthrough</div>
            <div style={{ padding: '4px 12px', borderRadius: 5, color: dark ? '#86878d' : '#72727e', whiteSpace: 'nowrap' }}>Diff</div>
            <div style={{ padding: '4px 12px', borderRadius: 5, color: dark ? '#86878d' : '#72727e', whiteSpace: 'nowrap' }}>Request Changes</div>
          </div>
        )}
        <div style={{ marginLeft: 'auto', fontSize: 11, color: dark ? '#86878d' : '#72727e', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ display: 'inline-flex', width: 6, height: 6, borderRadius: '50%', background: '#3b82f6' }} className="pulse-dot" />
          generating
        </div>
      </div>

      {/* PR title row */}
      {title && (
        <div style={{
          padding: narrow ? '14px 32px 10px' : '18px 40px 12px',
          borderBottom: `1px solid ${subtle}`,
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</div>
          {subtitle && (
            <div style={{ fontSize: 12, color: dark ? '#86878d' : 'var(--revv-text-muted)', marginTop: 4, fontFamily: 'var(--mono)' }}>{subtitle}</div>
          )}
        </div>
      )}

      {/* content */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {children}
      </div>
    </div>
  );
}

// Tiny tool tag pill — used by several variations.
function ToolTag({ tool, style }) {
  const s = toolStyle(tool);
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 7px',
      borderRadius: 4,
      fontSize: 10.5, fontWeight: 600,
      fontFamily: 'var(--mono)',
      color: s.fg, background: s.bg,
      letterSpacing: 0.2,
      ...style,
    }}>{tool}</span>
  );
}

// Footer toolbar — Cancel · Read diff while waiting · Pre-write comments
function ActionBar({ dark = false }) {
  const fg = dark ? '#cfd0d4' : '#44444f';
  const sub = dark ? '#7d7e83' : '#72727e';
  const border = dark ? '#1c1e23' : 'var(--revv-border-subtle)';
  const bg = dark ? '#0c0d10' : '#fff';
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, bottom: 0,
      borderTop: `1px solid ${border}`,
      background: bg,
      padding: '8px 16px',
      display: 'flex', alignItems: 'center', gap: 8,
      fontSize: 11.5, color: fg,
      whiteSpace: 'nowrap',
    }}>
      <button style={{ ...btn(dark, false), whiteSpace: 'nowrap' }}>Cancel</button>
      <button style={{ ...btn(dark, false), whiteSpace: 'nowrap' }}>Read diff →</button>
      <button style={{ ...btn(dark, false), whiteSpace: 'nowrap' }}>Pre-write comments</button>
      <div style={{ marginLeft: 'auto', color: sub, fontFamily: 'var(--mono)', fontSize: 11, whiteSpace: 'nowrap' }}>
        elapsed <b style={{ color: fg }}>1m 04s</b> · <span style={{ color: sub }}>~30s remaining</span>
      </div>
    </div>
  );
}

function btn(dark, primary) {
  return {
    background: primary ? '#3b82f6' : (dark ? '#15171c' : '#fff'),
    color: primary ? '#fff' : (dark ? '#cfd0d4' : '#1f2024'),
    border: `1px solid ${dark ? '#22252b' : '#e0e0e5'}`,
    padding: '4px 10px',
    borderRadius: 6,
    fontSize: 11.5, fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

Object.assign(window, { Frame, ToolTag, ActionBar, SAMPLE_OPS, PIPELINE, SECTIONS, toolStyle, FRAME_W, FRAME_H });
