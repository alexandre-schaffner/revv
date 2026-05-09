// V6 — CINEMA (wild)
// Dark mode, full-bleed terminal. Single column, big mono type, the agent's
// thinking surfaces as soft serif overlays that fade in and out. Feels like
// watching a render farm. Quiet, focused, hypnotic.

function V6Cinema() {
  const log = [
    { kind: 'tool', t: 'Read',  p: 'modules/v4/leaf/leafLeaderboard.controller.ts', n: '+163' },
    { kind: 'tool', t: 'Read',  p: 'modules/v4/leaf/leafLeaderboard.service.ts',    n: '−124 +362' },
    { kind: 'thought', text: 'Soft-deleted submissions are leaking into the aggregation.' },
    { kind: 'tool', t: 'Grep',  p: '"scoreFor"', n: '12 hits' },
    { kind: 'tool', t: 'Read',  p: 'lib/scoring/decay.ts', n: 'context' },
    { kind: 'tool', t: 'Bash',  p: 'pnpm test leaderboard', n: '12 ✓' },
    { kind: 'thought', text: 'The patch adds a prefiltered date window before the join.' },
    { kind: 'tool', t: 'Read',  p: 'modules/v4/leaf/leafLeaderboard.repository.ts', n: 'reading…' },
  ];

  return (
    <Frame title="fix: leaderboard" subtitle="#185 · fix/leaderboard" dark>
      {/* faint sweeping line evokes a scan */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden',
      }}>
        <div className="sweep-line" style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          height: 60,
          background: 'linear-gradient(180deg, transparent 0%, rgba(59,130,246,0.07) 50%, transparent 100%)',
        }} />
      </div>

      <div style={{
        position: 'absolute', inset: '0 0 78px 0',
        padding: '36px 64px 24px',
        overflow: 'auto',
        fontFamily: 'var(--mono)',
        fontSize: 14, lineHeight: 1.9,
        color: '#9aa0a8',
      }} className="scroll-clean">

        {/* phase headline — big */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1, color: '#5a6068', textTransform: 'uppercase', marginBottom: 6 }}>
            Phase 2 of 6 · Explore
          </div>
          <div style={{
            fontFamily: 'var(--serif)', fontSize: 30, fontWeight: 400,
            letterSpacing: '-0.015em', color: '#e7e8eb',
            lineHeight: 1.15,
          }}>
            Reading files,<br />
            understanding changes<span className="blink-cursor" style={{ color: '#3b82f6' }}>▎</span>
          </div>
        </div>

        {log.map((row, i) => {
          if (row.kind === 'thought') {
            return (
              <div key={i} className="fade-up" style={{
                fontFamily: 'var(--serif)', fontStyle: 'italic',
                fontSize: 17, lineHeight: 1.5,
                color: '#cdd0d6',
                margin: '14px 0 14px',
                maxWidth: 720,
                animationDelay: `${i * 80}ms`,
              }}>
                <span style={{
                  fontFamily: 'var(--mono)', fontStyle: 'normal',
                  fontSize: 9, letterSpacing: 1, color: '#5a6068',
                  marginRight: 10, textTransform: 'uppercase', verticalAlign: 'middle',
                }}>thought</span>
                {row.text}
              </div>
            );
          }
          return (
            <div key={i} className="fade-up" style={{
              display: 'flex', alignItems: 'baseline', gap: 12,
              animationDelay: `${i * 80}ms`,
              whiteSpace: 'nowrap',
            }}>
              <span style={{ color: '#3a3e46', width: 28, textAlign: 'right', fontSize: 11, flexShrink: 0 }}>{String(i + 1).padStart(2, '0')}</span>
              <span style={{
                color: row.t === 'Read' ? '#7aa7ff' : row.t === 'Grep' ? '#bd9bff' : row.t === 'Bash' ? '#7be0a3' : '#9aa0a8',
                width: 56,
                fontWeight: 600, fontSize: 12,
                flexShrink: 0,
              }}>{row.t.toLowerCase()}</span>
              <span style={{ flex: 1, color: '#cdd0d6', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{row.p}</span>
              <span style={{ color: '#5a6068', fontSize: 11, flexShrink: 0, minWidth: 80, textAlign: 'right' }}>{row.n}</span>
            </div>
          );
        })}

        <div style={{ marginTop: 18, color: '#5a6068', fontSize: 11.5 }}>
          <span className="braille-spinner" style={{ color: '#3b82f6' }} />
          {' '}awaiting next operation
        </div>
      </div>

      {/* slim metric strip */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 40,
        height: 38,
        padding: '0 64px',
        background: 'rgba(12,13,16,0.92)',
        borderTop: '1px solid #1c1e23',
        display: 'flex', alignItems: 'center', gap: 24,
        fontFamily: 'var(--mono)', fontSize: 11, color: '#7d7e83',
        whiteSpace: 'nowrap',
      }}>
        <span>elapsed <b style={{ color: '#cdd0d6' }}>1m 04s</b></span>
        <span>tokens <b style={{ color: '#cdd0d6' }}>43,210</b></span>
        <span>files <b style={{ color: '#cdd0d6' }}>9</b></span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
          {PIPELINE.map((p, i) => (
            <div key={p.id} style={{
              width: 22, height: 4, borderRadius: 2,
              background: i < 1 ? '#3b82f6' : i === 1 ? 'rgba(59,130,246,0.5)' : '#22252b',
            }} />
          ))}
        </div>
      </div>
      <ActionBar dark />
    </Frame>
  );
}

window.V6Cinema = V6Cinema;
