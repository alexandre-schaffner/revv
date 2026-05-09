// V1 — REFINED CURRENT
// Same general layout as today's screen, but tightened: stepper actually
// reads as progress, the operation log breathes, copy is human, typography
// has hierarchy. Conservative refresh.

function V1Current() {
  return (
    <Frame title="fix: leaderboard" subtitle="#185 · fix/leaderboard · main">
      <div style={{
        position: 'absolute', inset: 0, padding: '24px 40px 56px',
        overflow: 'auto',
      }} className="scroll-clean">
        {/* stepper */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 0,
          marginBottom: 22,
        }}>
          {SECTIONS.map((s, i) => {
            const done = i === 0 ? false : false;
            const active = i === 0;
            const upcoming = i > 0;
            return (
              <div key={s.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                paddingRight: 14,
                borderTop: `2px solid ${active ? 'var(--revv-accent)' : (done ? 'var(--revv-success)' : '#e5e5ea')}`,
                paddingTop: 10,
              }}>
                <div style={{
                  width: 14, height: 14, borderRadius: '50%',
                  border: `2px solid ${active ? 'var(--revv-accent)' : '#cfcfd6'}`,
                  background: active ? '#fff' : '#fff',
                  position: 'relative',
                }}>
                  {active && <div style={{ position: 'absolute', inset: 2, borderRadius: '50%', background: 'var(--revv-accent)' }} className="pulse-dot" />}
                </div>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: upcoming ? 'var(--revv-text-muted)' : 'var(--revv-text-primary)' }}>{s.label}</div>
              </div>
            );
          })}
        </div>

        {/* phase status card */}
        <div style={{
          background: 'var(--revv-bg-secondary)',
          border: '1px solid var(--revv-border-subtle)',
          borderRadius: 8,
          padding: '14px 16px',
          display: 'flex', alignItems: 'center', gap: 12,
          marginBottom: 16,
        }}>
          <div style={{ width: 16, height: 16, borderRadius: '50%', border: '2px solid var(--revv-accent)', borderRightColor: 'transparent', animation: 'brailleSpin 0.9s linear infinite' }} />
          <div style={{ fontSize: 13.5, fontWeight: 500 }}>Reading files and understanding changes</div>
          <div style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--revv-text-muted)', fontFamily: 'var(--mono)' }}>1m 04s</div>
        </div>

        {/* operations */}
        <div style={{
          fontSize: 11.5, color: 'var(--revv-text-muted)',
          fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase',
          marginBottom: 8,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span>10 operations</span>
          <span style={{ color: '#cfcfd6' }}>·</span>
          <span style={{ fontFamily: 'var(--mono)', textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>43,210 tokens</span>
        </div>
        <div style={{
          background: '#fafafb',
          border: '1px solid var(--revv-border-subtle)',
          borderRadius: 8,
          padding: '6px 0',
          fontFamily: 'var(--mono)',
          fontSize: 11.5,
        }}>
          {SAMPLE_OPS.slice(0, 7).map((op, i) => (
            <div key={i} style={{
              padding: '4px 14px',
              display: 'flex', alignItems: 'center', gap: 10,
              color: 'var(--revv-text-secondary)',
            }}>
              <ToolTag tool={op.t} style={{ minWidth: 36, textAlign: 'center' }} />
              <span style={{
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{op.p}</span>
              <span style={{ color: 'var(--revv-text-muted)', fontSize: 10.5 }}>{op.n}</span>
            </div>
          ))}
        </div>
      </div>
      <ActionBar />
    </Frame>
  );
}

window.V1Current = V1Current;
