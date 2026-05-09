// V4 — STREAMING DOC
// Medium-bold. The walkthrough is *being written in front of you*. First
// section streams in word-by-word; subsequent sections show as ghosted
// placeholders with file pills. The activity log is collapsed into a
// single status pill at the bottom, expandable on hover. Reading the
// real artifact while it generates is the action.

function V4Stream() {
  return (
    <Frame title="fix: leaderboard" subtitle="#185 · fix/leaderboard">
      <div style={{
        position: 'absolute', inset: '0 0 78px 0',
        overflow: 'auto', padding: '24px 64px 24px',
      }} className="scroll-clean">

        {/* OVERVIEW (streaming) */}
        <SectionHeading n="01" label="Overview" status="streaming" />
        <div style={{
          fontSize: 14.5, lineHeight: 1.65, color: 'var(--revv-text-primary)',
          marginBottom: 28, maxWidth: 760,
        }}>
          This PR fixes a leaderboard scoring bug where users with deleted leaf
          submissions still appeared in the top‑10. The root cause is in{' '}
          <code style={inlineCode}>leafLeaderboard.service.ts</code> — the
          <code style={inlineCode}>scoreFor()</code> aggregation joined against
          <code style={inlineCode}>leaf_submissions</code> without filtering
          <code style={inlineCode}>deleted_at IS NULL</code>, so soft‑deleted
          rows leaked into the sum. The patch adds a <em>prefiltered date
          window</em> on the join and<span className="blink-cursor" style={{ color: 'var(--revv-accent)' }}>▎</span>
        </div>

        {/* DIFF ANALYSIS (queued, ghosted) */}
        <SectionHeading n="02" label="Diff Analysis" status="queued" />
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxWidth: 760, marginBottom: 10 }}>
            {[
              'leafLeaderboard.controller.ts',
              'leafLeaderboard.service.ts',
              'leafLeaderboard.repository.ts',
              '__tests__/leaf.spec.ts',
            ].map(f => (
              <span key={f} style={{
                fontFamily: 'var(--mono)', fontSize: 11,
                padding: '3px 8px', borderRadius: 4,
                background: 'var(--revv-bg-secondary)',
                color: 'var(--revv-text-muted)',
                border: '1px solid var(--revv-border-subtle)',
              }}>{f}</span>
            ))}
          </div>
          {[92, 78, 85, 56, 70].map((w, i) => (
            <div key={i} className="shimmer" style={{
              height: 10, width: `${w}%`,
              background: '#eef0f3', borderRadius: 4,
              marginBottom: 8, maxWidth: 760,
            }} />
          ))}
        </div>

        {/* SENTIMENT (queued) */}
        <SectionHeading n="03" label="Sentiment" status="queued" />
        <div style={{ marginBottom: 28 }}>
          {[64, 80, 42].map((w, i) => (
            <div key={i} style={{
              height: 10, width: `${w}%`,
              background: '#f1f1f3', borderRadius: 4,
              marginBottom: 8, maxWidth: 760,
            }} />
          ))}
        </div>

        {/* RATED (queued) */}
        <SectionHeading n="04" label="Rated" status="queued" />
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {['Clarity', 'Correctness', 'Test cov.', 'Fit'].map(k => (
            <div key={k} style={{
              flex: 1, maxWidth: 170,
              padding: '12px 14px',
              background: '#fafafb', borderRadius: 8,
              border: '1px solid var(--revv-border-subtle)',
            }}>
              <div style={{ fontSize: 10.5, color: 'var(--revv-text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{k}</div>
              <div style={{ height: 18, marginTop: 6, background: '#eef0f3', borderRadius: 4 }} />
            </div>
          ))}
        </div>
      </div>

      {/* status footer integrated inside frame, above ActionBar */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 40,
        height: 38,
        background: 'rgba(255,255,255,0.92)',
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        borderTop: '1px solid var(--revv-border-subtle)',
        padding: '0 40px',
        display: 'flex', alignItems: 'center', gap: 12,
        fontSize: 11.5, color: 'var(--revv-text-secondary)',
        whiteSpace: 'nowrap',
      }}>
        <span className="braille-spinner" style={{ color: 'var(--revv-accent)' }} />
        <span><b>Drafting Overview</b> · reading <span style={{ fontFamily: 'var(--mono)' }}>leafLeaderboard.repository.ts</span></span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', color: 'var(--revv-text-muted)', fontSize: 11 }}>step 2 / 6 · 43,210 tk · 1m 04s</span>
      </div>
      <ActionBar />
    </Frame>
  );
}

const inlineCode = {
  fontFamily: 'var(--mono)',
  fontSize: 12.5,
  background: 'var(--revv-bg-secondary)',
  padding: '1px 6px',
  borderRadius: 4,
  color: 'var(--revv-text-primary)',
  margin: '0 2px',
};

function SectionHeading({ n, label, status }) {
  const dim = status === 'queued';
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12,
      paddingTop: 6,
      opacity: dim ? 0.55 : 1,
    }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--revv-text-muted)', fontWeight: 600 }}>{n}</span>
      <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.012em', color: 'var(--revv-text-primary)' }}>{label}</span>
      {status === 'streaming' && (
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--revv-accent)', fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', fontFamily: 'var(--mono)' }}>writing</span>
      )}
      {status === 'queued' && (
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--revv-text-muted)', fontWeight: 500, letterSpacing: 0.5, textTransform: 'uppercase', fontFamily: 'var(--mono)' }}>queued</span>
      )}
    </div>
  );
}

window.V4Stream = V4Stream;
