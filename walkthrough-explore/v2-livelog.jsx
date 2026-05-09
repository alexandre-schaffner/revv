// V2 — LIVE LOG (Linear-spare terminal feed)
// Conservative-medium. The screen IS the log. Mono throughout. Each line
// fades in. Phase is a slim chip at top. No empty state.

function V2LiveLog() {
  // duplicate ops so the log feels lived-in
  const log = [
    ...SAMPLE_OPS,
    { t: 'thinking', p: 'The leaderboard query was scanning all rows; the patch adds a prefiltered date window before the join.', n: '' },
    { t: 'Read',  p: 'apps/api/src/modules/v4/leaf/leafLeaderboard.service.ts', n: 'lines 84–162' },
    { t: 'Grep',  p: 'apps/api/src/modules/v4/leaf — "leaderboardCacheTtl"', n: '4 hits' },
  ];

  return (
    <Frame title="fix: leaderboard" subtitle="#185 · fix/leaderboard">
      {/* phase strip */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        padding: '14px 40px 12px',
        borderBottom: '1px solid var(--revv-border-subtle)',
        display: 'flex', alignItems: 'center', gap: 14,
        fontSize: 12,
        background: '#fcfcfd',
      }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--revv-text-muted)' }}>
          phase 2 of 6
        </span>
        <span style={{ color: '#cfcfd6' }}>·</span>
        <span style={{ fontWeight: 600 }}>Explore</span>
        <span style={{ color: 'var(--revv-text-muted)' }}>Reading changed files & related context</span>
        <div style={{
          marginLeft: 'auto',
          display: 'flex', gap: 3,
        }}>
          {PIPELINE.map((p, i) => (
            <div key={p.id} style={{
              width: 22, height: 4, borderRadius: 2,
              background: i < 1 ? 'var(--revv-success)' : i === 1 ? 'var(--revv-accent)' : '#e5e5ea',
            }} />
          ))}
        </div>
      </div>

      <div style={{
        position: 'absolute', top: 50, left: 0, right: 0, bottom: 40,
        padding: '14px 40px 18px',
        overflow: 'auto', fontFamily: 'var(--mono)', fontSize: 12.5,
        lineHeight: 1.7,
        color: 'var(--revv-text-secondary)',
      }} className="scroll-clean">
        {log.map((op, i) => {
          if (op.t === 'thinking') {
            return (
              <div key={i} className="fade-up" style={{
                padding: '10px 14px', margin: '6px 0',
                background: '#f7f4ee',
                borderLeft: '2px solid #c8a96a',
                borderRadius: '0 6px 6px 0',
                fontFamily: 'var(--serif)', fontSize: 13.5,
                fontStyle: 'italic',
                color: '#52473a',
                lineHeight: 1.5,
              }}>
                <span style={{ fontStyle: 'normal', fontFamily: 'var(--mono)', fontSize: 10, color: '#9c8866', marginRight: 8, letterSpacing: 0.5 }}>thought</span>
                {op.p}
              </div>
            );
          }
          return (
            <div key={i} className="fade-up" style={{
              display: 'flex', alignItems: 'baseline', gap: 10,
              animationDelay: `${i * 60}ms`,
            }}>
              <span style={{ color: '#b0b0ba', width: 28, textAlign: 'right', fontSize: 10.5 }}>{String(i + 1).padStart(2, '0')}</span>
              <ToolTag tool={op.t} style={{ minWidth: 36, textAlign: 'center', position: 'relative', top: -1 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{op.p}</span>
              {op.n && <span style={{ color: 'var(--revv-text-muted)', fontSize: 11 }}>{op.n}</span>}
            </div>
          );
        })}
        <div className="fade-up" style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 4 }}>
          <span style={{ color: '#b0b0ba', width: 28, textAlign: 'right', fontSize: 10.5 }}>14</span>
          <span className="braille-spinner" style={{ color: 'var(--revv-accent)' }} />
          <span style={{ color: 'var(--revv-text-muted)' }}>Reading <b style={{ color: 'var(--revv-text-secondary)' }}>leafLeaderboard.repository.ts</b><span className="blink-cursor">▎</span></span>
        </div>
      </div>

      <ActionBar />
    </Frame>
  );
}

window.V2LiveLog = V2LiveLog;
