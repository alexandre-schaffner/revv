// V5 — REPO TREE
// Medium. The screen is a live filemap of the repo with the agent's
// reading head crawling through it. Files glow as they're read; greps
// connect with a hairline; thoughts surface as inline annotations.
// Trust-building: you can SEE which files were touched.

function V5Tree() {
  const tree = [
    { d: 0, name: 'apps/', kind: 'dir' },
    { d: 1, name: 'api/', kind: 'dir' },
    { d: 2, name: 'src/', kind: 'dir' },
    { d: 3, name: 'modules/v4/leaf/', kind: 'dir' },
    { d: 4, name: 'leafLeaderboard.controller.ts', state: 'read', meta: '+163' },
    { d: 4, name: 'leafLeaderboard.service.ts', state: 'reading', meta: '−124 +362' },
    { d: 4, name: 'leafLeaderboard.repository.ts', state: 'queued', meta: '+51' },
    { d: 4, name: '__tests__/leaf.spec.ts', state: 'read', meta: '+44' },
    { d: 3, name: 'lib/scoring/', kind: 'dir' },
    { d: 4, name: 'decay.ts', state: 'read', meta: 'context' },
    { d: 4, name: 'window.ts', state: 'idle' },
    { d: 1, name: 'web/', kind: 'dir', dim: true },
    { d: 2, name: 'src/lib/...', kind: 'dir', dim: true },
  ];

  return (
    <Frame title="fix: leaderboard" subtitle="#185 · fix/leaderboard">
      <div style={{ position: 'absolute', inset: '0 0 40px 0', display: 'grid', gridTemplateColumns: '1fr 0.85fr' }}>
        {/* tree */}
        <div style={{ padding: '20px 24px 20px 40px', overflow: 'auto', borderRight: '1px solid var(--revv-border-subtle)' }} className="scroll-clean">
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.7, textTransform: 'uppercase', color: 'var(--revv-text-muted)', marginBottom: 14 }}>
            Repository · 12 files touched
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.85 }}>
            {tree.map((row, i) => {
              const indent = row.d * 14;
              const reading = row.state === 'reading';
              const read = row.state === 'read';
              const dim = row.dim || row.state === 'idle';
              return (
                <div key={i} style={{
                  paddingLeft: indent,
                  display: 'flex', alignItems: 'center', gap: 8,
                  color: dim ? '#b0b0ba' : reading ? 'var(--revv-text-primary)' : read ? 'var(--revv-text-secondary)' : 'var(--revv-text-secondary)',
                  background: reading ? 'rgba(59,130,246,0.08)' : 'transparent',
                  borderLeft: reading ? '2px solid var(--revv-accent)' : '2px solid transparent',
                  marginLeft: -2, paddingTop: 1, paddingBottom: 1,
                  fontWeight: reading ? 600 : 400,
                }}>
                  <span style={{ color: row.kind === 'dir' ? '#b0b0ba' : '#cfcfd6' }}>{row.kind === 'dir' ? '▸' : '·'}</span>
                  <span style={{ flex: 1 }}>{row.name}</span>
                  {reading && <span className="braille-spinner" style={{ color: 'var(--revv-accent)' }} />}
                  {read && <span style={{ color: 'var(--revv-success)', fontSize: 10 }}>✓</span>}
                  {row.meta && <span style={{ color: 'var(--revv-text-muted)', fontSize: 10.5 }}>{row.meta}</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* annotations */}
        <div style={{ padding: '20px 40px 20px 24px', overflow: 'auto', background: '#fbfbfc' }} className="scroll-clean">
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.7, textTransform: 'uppercase', color: 'var(--revv-text-muted)', marginBottom: 14 }}>
            Now reading
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            leafLeaderboard.service.ts
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--revv-text-muted)', marginBottom: 16 }}>
            line 84 of 362 · scanning <code style={{ fontFamily: 'var(--mono)' }}>scoreFor()</code>
          </div>

          <div style={{
            padding: '10px 14px', background: '#f7f4ee',
            borderLeft: '2px solid #c8a96a', borderRadius: '0 6px 6px 0',
            fontFamily: 'var(--serif)', fontStyle: 'italic',
            fontSize: 13.5, color: '#52473a', lineHeight: 1.5, marginBottom: 12,
          }}>
            <span style={{ fontStyle: 'normal', fontFamily: 'var(--mono)', fontSize: 10, color: '#9c8866', marginRight: 8, letterSpacing: 0.5 }}>thought</span>
            The aggregation joins <code style={{ fontFamily: 'var(--mono)', fontStyle: 'normal' }}>leaf_submissions</code> without filtering soft-deleted rows.
          </div>

          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.7, textTransform: 'uppercase', color: 'var(--revv-text-muted)', marginBottom: 8, marginTop: 18 }}>
            Plan · step 2 of 6
          </div>
          {PIPELINE.map((p, i) => {
            const done = i < 1, active = i === 1;
            return (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 12, padding: '4px 0',
                color: active ? 'var(--revv-text-primary)' : done ? 'var(--revv-text-secondary)' : 'var(--revv-text-muted)',
                fontWeight: active ? 600 : 400,
              }}>
                <span style={{
                  width: 14, height: 14, borderRadius: '50%',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 9,
                  background: done ? 'var(--revv-success)' : active ? '#fff' : '#f1f1f3',
                  border: `1.5px solid ${done ? 'var(--revv-success)' : active ? 'var(--revv-accent)' : '#cfcfd6'}`,
                  color: done ? '#fff' : active ? 'var(--revv-accent)' : '#b0b0ba',
                }}>{done ? '✓' : i + 1}</span>
                {p.label}
              </div>
            );
          })}
        </div>
      </div>
      <ActionBar />
    </Frame>
  );
}

window.V5Tree = V5Tree;
