// V7 — COCKPIT (wild)
// A live "operations console". Three live panes: thinking stream, tool
// calls scrolling, and a token/cost meter with a tiny histogram. Feels
// like a build pipeline / observability dashboard. Maximum information
// density without feeling chaotic.

function V7Cockpit() {
  return (
    <Frame title="fix: leaderboard" subtitle="#185 · fix/leaderboard">
      <div style={{
        position: 'absolute', inset: '0 0 78px 0',
        display: 'grid',
        gridTemplateColumns: '1.1fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: 1,
        background: '#e5e5ea',
      }}>
        {/* THINKING (top-left, spans 2 rows) */}
        <Pane label="Reasoning" sub="streaming" tall>
          <div style={{
            fontFamily: 'var(--serif)', fontSize: 14, lineHeight: 1.55,
            color: 'var(--revv-text-primary)',
          }}>
            <p style={{ margin: '0 0 12px' }}>
              The leaderboard endpoint depends on <code style={{ fontFamily: 'var(--mono)', fontSize: 12, background: 'var(--revv-bg-secondary)', padding: '0 4px', borderRadius: 3 }}>scoreFor()</code>,
              which sums leaf submissions in a 7-day window.
            </p>
            <p style={{ margin: '0 0 12px', fontStyle: 'italic', color: '#52473a' }}>
              The bug surfaces when a user soft-deletes a submission — the row stays in
              the table with <code style={{ fontFamily: 'var(--mono)', fontSize: 12, background: '#f7f4ee', padding: '0 4px', borderRadius: 3, fontStyle: 'normal' }}>deleted_at NOT NULL</code>,
              but the join doesn't filter it.
            </p>
            <p style={{ margin: 0 }}>
              Checking now whether the patch's date-window predicate also handles<span className="blink-cursor" style={{ color: 'var(--revv-accent)' }}>▎</span>
            </p>
          </div>
        </Pane>

        {/* TOOL STREAM (top-right) */}
        <Pane label="Tool calls" sub="9 / ~14" right>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.7 }}>
            {SAMPLE_OPS.slice(0, 8).map((op, i) => (
              <div key={i} className="fade-up" style={{
                display: 'flex', alignItems: 'baseline', gap: 8,
                color: 'var(--revv-text-secondary)',
                animationDelay: `${i * 50}ms`,
                whiteSpace: 'nowrap',
              }}>
                <span style={{ color: '#cfcfd6', width: 18, textAlign: 'right', fontSize: 10, flexShrink: 0 }}>{String(i + 1).padStart(2, '0')}</span>
                <ToolTag tool={op.t} style={{ minWidth: 32, textAlign: 'center', fontSize: 9.5, flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{op.p.split('/').pop()}</span>
                <span style={{ color: 'var(--revv-text-muted)', fontSize: 10, flexShrink: 0, minWidth: 56, textAlign: 'right' }}>{op.n}</span>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, color: 'var(--revv-accent)' }}>
              <span style={{ color: '#cfcfd6', width: 18, textAlign: 'right', fontSize: 10 }}>09</span>
              <span className="braille-spinner" />
              <span>reading repository.ts<span className="blink-cursor">▎</span></span>
            </div>
          </div>
        </Pane>

        {/* PIPELINE (bottom-right) */}
        <Pane label="Plan" sub="step 2 / 6" right bottom gridArea="2 / 2 / 3 / 3">
          {PIPELINE.map((p, i) => {
            const done = i < 1, active = i === 1;
            return (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                fontSize: 12, padding: '5px 0',
                borderBottom: i < PIPELINE.length - 1 ? '1px solid #f1f1f3' : 'none',
                color: active ? 'var(--revv-text-primary)' : 'var(--revv-text-muted)',
              }}>
                <span style={{
                  width: 16, height: 16, borderRadius: '50%',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 9, fontFamily: 'var(--mono)', fontWeight: 600,
                  background: done ? 'var(--revv-success)' : active ? '#fff' : '#f7f7f8',
                  border: `1.5px solid ${done ? 'var(--revv-success)' : active ? 'var(--revv-accent)' : '#e0e0e5'}`,
                  color: done ? '#fff' : active ? 'var(--revv-accent)' : '#b0b0ba',
                }}>{done ? '✓' : i + 1}</span>
                <span style={{ flex: 1, fontWeight: active ? 600 : 400 }}>{p.label}</span>
                {active && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--revv-accent)' }}>active</span>}
              </div>
            );
          })}
        </Pane>
      </div>

      {/* metric strip */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 40,
        height: 38,
        padding: '0 24px',
        background: '#fafafb',
        borderTop: '1px solid var(--revv-border-subtle)',
        display: 'flex', alignItems: 'center', gap: 22,
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--revv-text-muted)',
        whiteSpace: 'nowrap',
      }}>
        <Metric label="elapsed" value="1m 04s" />
        <Metric label="files read" value="9" />
        <Metric label="tokens" value="43.2k">
          <Histogram />
        </Metric>
        <Metric label="cost" value="$0.18" />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>est. <b style={{ color: 'var(--revv-text-secondary)' }}>~30s</b></span>
        </div>
      </div>
      <ActionBar />
    </Frame>
  );
}

function Pane({ label, sub, children, right, bottom, tall, gridArea }) {
  return (
    <div style={{
      gridArea: gridArea || (tall ? '1 / 1 / 3 / 2' : undefined),
      background: '#fff',
      padding: '14px 18px',
      overflow: 'auto',
    }} className="scroll-clean">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10, whiteSpace: 'nowrap' }}>
        <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.7, textTransform: 'uppercase', color: 'var(--revv-text-muted)' }}>{label}</span>
        {sub && <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--revv-text-muted)', whiteSpace: 'nowrap' }}>· {sub}</span>}
      </div>
      {children}
    </div>
  );
}

function Metric({ label, value, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <b style={{ color: 'var(--revv-text-primary)', fontWeight: 600 }}>{value}</b>
      {children}
    </div>
  );
}

function Histogram() {
  const bars = [3, 5, 4, 7, 6, 9, 5, 8, 11, 6, 9, 12, 8];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 1.5, height: 14, marginLeft: 2 }}>
      {bars.map((b, i) => (
        <span key={i} style={{
          width: 3, height: b, background: i === bars.length - 1 ? 'var(--revv-accent)' : '#cfcfd6',
          borderRadius: 1,
        }} />
      ))}
    </span>
  );
}

window.V7Cockpit = V7Cockpit;
