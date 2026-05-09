// V3 — TWO-COLUMN: walkthrough outline (LEFT) + live activity (RIGHT)
// Medium. The published walkthrough's spine is shown immediately so the
// reader knows the shape. Each section turns from gray → filled as the
// agent finishes it. Right column is a quiet activity stream.

function V3TwoColumn() {
  return (
    <Frame title="fix: leaderboard" subtitle="#185 · fix/leaderboard">
      <div style={{
        position: 'absolute', inset: '0 0 40px 0',
        display: 'grid', gridTemplateColumns: '1.05fr 0.95fr',
      }}>
        {/* LEFT — outline of the walkthrough being assembled */}
        <div style={{
          padding: '20px 28px 20px 40px',
          borderRight: '1px solid var(--revv-border-subtle)',
          overflow: 'auto',
        }} className="scroll-clean">
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.7, textTransform: 'uppercase', color: 'var(--revv-text-muted)', marginBottom: 14 }}>
            Walkthrough
          </div>

          <OutlineRow
            n="01" label="Overview" status="active" hint="Drafting…"
            placeholder={[
              { w: '92%' }, { w: '78%' }, { w: '85%' }, { w: '40%' },
            ]}
          />
          <OutlineRow
            n="02" label="Diff Analysis" status="queued" hint="3 files"
            preview={[
              'leafLeaderboard.controller.ts',
              'leafLeaderboard.service.ts',
              'leafLeaderboard.repository.ts',
            ]}
          />
          <OutlineRow n="03" label="Sentiment" status="queued" hint="" />
          <OutlineRow n="04" label="Rated" status="queued" hint="" />
        </div>

        {/* RIGHT — activity feed */}
        <div style={{
          padding: '20px 40px 20px 28px',
          background: '#fbfbfc',
          overflow: 'auto',
          fontFamily: 'var(--mono)',
          fontSize: 11.5,
        }} className="scroll-clean">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontFamily: 'Inter' }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.7, textTransform: 'uppercase', color: 'var(--revv-text-muted)' }}>Activity</div>
            <span style={{ color: '#cfcfd6' }}>·</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--revv-text-muted)' }}>step 2 / 6 · Explore</span>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontFamily: 'Inter', fontSize: 12, marginBottom: 16,
            padding: '8px 12px', background: '#fff',
            border: '1px solid var(--revv-border-subtle)', borderRadius: 6,
          }}>
            <span className="braille-spinner" style={{ color: 'var(--revv-accent)' }} />
            <span style={{ color: 'var(--revv-text-secondary)' }}>Reading files and understanding changes</span>
          </div>

          {SAMPLE_OPS.slice(0, 9).map((op, i) => (
            <div key={i} className="fade-up" style={{
              padding: '5px 0',
              display: 'flex', alignItems: 'baseline', gap: 8,
              color: 'var(--revv-text-secondary)',
              borderTop: i === 0 ? 'none' : '1px solid #f1f1f3',
              animationDelay: `${i * 50}ms`,
            }}>
              <ToolTag tool={op.t} style={{ minWidth: 36, textAlign: 'center' }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {op.p.split('/').pop()}
              </span>
              <span style={{ color: 'var(--revv-text-muted)', fontSize: 10.5 }}>{op.n}</span>
            </div>
          ))}
        </div>
      </div>
      <ActionBar />
    </Frame>
  );
}

function OutlineRow({ n, label, status, hint, placeholder, preview }) {
  const isActive = status === 'active';
  const isDone = status === 'done';
  const numColor = isActive ? 'var(--revv-accent)' : isDone ? 'var(--revv-success)' : '#cfcfd6';
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: numColor, fontWeight: 600 }}>{n}</span>
        <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.005em' }}>{label}</span>
        {hint && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--revv-text-muted)', fontFamily: 'var(--mono)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {isActive && <span className="braille-spinner" style={{ color: 'var(--revv-accent)' }} />}
            {hint}
          </span>
        )}
      </div>
      {placeholder && (
        <div style={{ paddingLeft: 26 }}>
          {placeholder.map((row, i) => (
            <div key={i} className="shimmer" style={{
              height: 9, borderRadius: 4,
              width: row.w,
              background: '#eef0f3',
              marginBottom: 7,
            }} />
          ))}
        </div>
      )}
      {preview && (
        <div style={{ paddingLeft: 26 }}>
          {preview.map((p, i) => (
            <div key={i} style={{
              fontSize: 11.5, color: 'var(--revv-text-muted)',
              fontFamily: 'var(--mono)', padding: '2px 0',
            }}>· {p}</div>
          ))}
        </div>
      )}
    </div>
  );
}

window.V3TwoColumn = V3TwoColumn;
