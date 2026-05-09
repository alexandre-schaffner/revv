// V4.5 — STREAMING DOC, TUNED TO REAL LAYOUT
// Reads voice / tempo / surface from TweakContext and reshapes the feel.

function V4_5RealStream() {
  const { voice, tempo, surface } = useTweak();
  const V = getVoice(voice), T = getTempo(tempo), S = getSurface(surface);

  // Scoped CSS vars + animation duration overrides + grain
  const wrapStyle = {
    ...surfaceCssVars(surface),
    background: S.artboardBg,
    width: '100%', height: '100%',
    position: 'relative',
    color: S.textPrimary,
  };
  // Wedge animation durations into the wrapper via CSS custom props
  const animVars = {
    '--spinner-dur': T.spinnerDur,
    '--cursor-dur': T.cursorDur,
    '--fadeup-dur': T.fadeUpDur,
    '--pulse-dur': T.pulseDotDur,
  };
  Object.assign(wrapStyle, animVars);

  const bodyFontStyle = { fontFamily: V.bodyFont, fontWeight: V.bodyWeight, lineHeight: V.bodyLineHeight };

  // Eyebrow renderer
  const renderChapterLabel = (i) => {
    if (V.eyebrowCase === 'upper') return `${V.chapterPrefix}${String(i+1).padStart(2,'0')}`;
    return `${V.chapterPrefix} ${String(i+1).padStart(2,'0')}`;
  };

  return (
    <Frame title={null} subtitle={null}>
      <div style={wrapStyle} className={`v45-tweaked ${S.grain ? 'grain-on' : ''}`}>
        {/* Inline style block — animation duration overrides scoped to .v45-tweaked */}
        <style>{`
          .v45-tweaked .blink-cursor { animation-duration: var(--cursor-dur, 1.1s) !important; }
          .v45-tweaked .braille-spinner::before { animation-duration: var(--spinner-dur, .8s) !important; }
          .v45-tweaked .fade-up { animation-duration: var(--fadeup-dur, .5s) !important; }
          .v45-tweaked .pulse-dot { animation-duration: var(--pulse-dur, 1.4s) !important; }
          .v45-tweaked.grain-on::before {
            content: ''; position: absolute; inset: 0; pointer-events: none;
            background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .12 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
            mix-blend-mode: multiply; opacity: .55;
          }
          .v45-tweaked .ticker-num { display: inline-block; min-width: 4ch; }
        `}</style>

        <div style={{
          position: 'absolute', inset: '0 0 78px 0',
          overflow: 'auto',
        }} className="scroll-clean">
          <div style={{
            maxWidth: 640, margin: '0 auto', padding: '36px 24px 60px',
            position: 'relative', zIndex: 1,
          }}>

            {/* PR title */}
            <div style={{ textAlign: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.012em', fontFamily: V.bodyFont, color: S.textPrimary }}>fix: leaderboard</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: S.textMuted, marginTop: 4 }}>
                #185 · fix/leaderboard ← main
              </div>
            </div>

            {/* Risk pill */}
            <div className="fade-up" style={{ textAlign: 'center', marginTop: 14, marginBottom: 28, animationDelay: '0ms' }}>
              <span style={{
                display: 'inline-block',
                padding: '4px 10px', borderRadius: 4,
                background: S.riskBg, color: S.riskFg,
                fontSize: 10.5, fontWeight: 700, letterSpacing: 0.8,
                fontFamily: 'var(--mono)',
                whiteSpace: 'nowrap',
              }}>MEDIUM RISK</span>
            </div>

            {/* Chapters stepper */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
              columnGap: 16, marginBottom: 36, padding: '0 4px',
            }}>
              {[
                { id: 'overview',  label: 'Overview',     blurb: 'What changed and why' },
                { id: 'diff',      label: 'Diff Analysis', blurb: 'Hunk-by-hunk reasoning' },
                { id: 'sentiment', label: 'Sentiment',    blurb: 'Overall read on the PR' },
                { id: 'rated',     label: 'Rating',       blurb: 'Across 9 axis' },
              ].map((s, i) => {
                const active = i === 0;
                return (
                  <div key={s.id} style={{
                    borderTop: `2px solid ${active ? S.accent : S.borderSubtle}`,
                    paddingTop: 10,
                    opacity: i > 1 ? 0.6 : 1,
                    minWidth: 0,
                  }}>
                    <div style={{
                      fontFamily: V.eyebrowFont,
                      fontSize: 11.5, fontWeight: 500,
                      fontStyle: V.eyebrowItalic ? 'italic' : 'normal',
                      textTransform: V.eyebrowCase === 'upper' ? 'uppercase' : 'none',
                      color: active ? S.accent : S.textMuted,
                      letterSpacing: V.eyebrowCase === 'upper' ? 0.6 : 0.3,
                      marginBottom: 2,
                      whiteSpace: 'nowrap',
                    }}>
                      {renderChapterLabel(i)}
                    </div>
                    <div style={{
                      fontFamily: V.eyebrowFont === V.bodyFont ? V.bodyFont : "'Newsreader', Georgia, serif",
                      fontSize: 18, fontWeight: 500, letterSpacing: '-0.012em',
                      lineHeight: 1.05,
                      marginBottom: 5,
                      color: S.textPrimary,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>{s.label}</div>
                    {active ? (
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: S.accent, marginBottom: 2 }}>
                          <span className="braille-spinner" />
                          <span style={{ fontWeight: 500, letterSpacing: 0.3, textTransform: 'lowercase' }}>{V.statusVerb.toLowerCase()}</span>
                        </div>
                        <div style={{
                          fontFamily: 'var(--mono)', fontSize: 10,
                          color: S.textSecondary,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          …/leafLeaderboard.repo.ts
                        </div>
                      </div>
                    ) : (
                      <div style={{
                        fontSize: 10.5, color: S.textMuted,
                        lineHeight: 1.35, whiteSpace: 'nowrap',
                        overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>{s.blurb}</div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* OVERVIEW */}
            <div style={{
              fontSize: V.overviewHeading === 'OVERVIEW' ? 13 : 18,
              fontWeight: 600,
              letterSpacing: V.overviewHeading === 'OVERVIEW' ? 1.5 : '-0.005em',
              marginBottom: 12,
              fontFamily: V.eyebrowFont === V.bodyFont ? V.bodyFont : "'Inter', sans-serif",
              color: S.textPrimary,
            }}>
              {V.overviewHeading}
            </div>
            <div className="fade-up" style={{
              fontSize: 13.5, marginBottom: 12, color: S.textPrimary,
              ...bodyFontStyle,
            }}>
              Fixes a leaderboard bug where{' '}
              <code style={inlineCodeS(S)}>row.amount &gt; total</code>{' '}
              caused UI shares to exceed 100%. The root cause:{' '}
              <code style={inlineCodeS(S)}>totalForCampaign</code> computed{' '}
              <code style={inlineCodeS(S)}>max(committed, temp)</code> while{' '}
              <code style={inlineCodeS(S)}>breakdownForCampaign</code> produced rows of{' '}
              <code style={inlineCodeS(S)}>sum(committed, temp.) + liveDiff.</code>{' '}
              per (recipient, reason); since{' '}
              <code style={inlineCodeS(S)}>max(Σa, Σb) ≤ Σ max(a., b.)</code>, the total was a lower bound on the row sum.<span className="blink-cursor" style={{ color: S.accent }}>▎</span>
            </div>

            {T.showFooterMetrics !== false && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 11.5, color: S.accent,
                marginBottom: 28,
              }}>
                <span className="braille-spinner" />
                <span>{V.statusVerb} walkthrough — reading <span style={{ fontFamily: 'var(--mono)' }}>leafLeaderboard.repository.ts</span></span>
              </div>
            )}

            <div style={{ height: 1, background: S.borderSubtle, margin: '0 0 24px' }} />

            {/* ISSUES */}
            <div className="fade-up" style={{ animationDelay: '120ms', marginBottom: 22 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 11, color: S.warning,
                fontWeight: 600, letterSpacing: 0.5, textTransform: V.eyebrowCase === 'upper' ? 'lowercase' : 'uppercase',
                marginBottom: 10,
                whiteSpace: 'nowrap',
                fontFamily: V.eyebrowCase === 'upper' ? 'var(--mono)' : 'inherit',
              }}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <path d="M8 1 L15 14 L1 14 Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  <path d="M8 6 V9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  <circle cx="8" cy="11.5" r="0.7" fill="currentColor" />
                </svg>
                <span>{V.issueLabel}</span>
              </div>

              <div style={{
                borderLeft: `3px solid ${S.issueBorder}`,
                borderRadius: '0 6px 6px 0',
                background: S.issueBg,
                padding: '12px 14px',
                display: 'flex', alignItems: 'flex-start', gap: 10,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                      background: S.issueBadgeBg, color: S.issueBadgeFg,
                      padding: '1px 6px', borderRadius: 3, letterSpacing: 0.6,
                      whiteSpace: 'nowrap', flexShrink: 0,
                      marginTop: 2,
                    }}>WARNING</span>
                    <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.4, flex: 1, minWidth: 0, color: S.textPrimary, fontFamily: V.bodyFont }}>
                      Case-sensitive (recipient, reason) keys
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: S.textSecondary, lineHeight: 1.5, fontFamily: V.bodyFont }}>
                    Campaign reconciliation keys are case-sensitive while token-side reconciliation lowercases both sides.
                  </div>
                </div>
                <a href="#" style={{
                  fontSize: 11, fontFamily: 'var(--mono)',
                  color: S.accent, textDecoration: 'none',
                  fontWeight: 500, whiteSpace: 'nowrap',
                  paddingTop: 2,
                }}>→ STEP 4</a>
              </div>
            </div>

            {/* QUEUED — Diff Analysis */}
            <SectionGhost
              n="02" label="Diff Analysis" surface={S}
              files={[
                'leafLeaderboard.controller.ts',
                'leafLeaderboard.service.ts',
                'leafLeaderboard.repository.ts',
                '__tests__/leaf.spec.ts',
              ]}
              shimmer={T.shimmerOnQueued && (T.shimmerScope === 'diff' || T.shimmerScope === 'all')}
            />

            {/* QUEUED — Sentiment */}
            <SectionGhost
              n="03" label="Sentiment" surface={S} rows={[64, 80, 42]}
              shimmer={T.shimmerOnQueued && T.shimmerScope === 'all'}
            />

            {/* QUEUED — Rated */}
            <div style={{ marginBottom: 20, opacity: 0.55 }}>
              <SectionHead n="04" label="Rated" surface={S} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                {['Clarity', 'Correctness', 'Test cov.', 'Fit'].map(k => (
                  <div key={k} style={{
                    flex: 1,
                    padding: '10px 12px',
                    background: S.queuedCardBg, borderRadius: 6,
                    border: `1px solid ${S.borderSubtle}`,
                  }}>
                    <div style={{ fontSize: 9.5, color: S.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{k}</div>
                    <div className={T.shimmerOnQueued && T.shimmerScope === 'all' ? 'shimmer' : ''} style={{ height: 14, marginTop: 5, background: S.queuedBarBg, borderRadius: 3 }} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* live status footer */}
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 40, height: 38,
          background: surface === 'Terminal' ? 'rgba(13,13,17,0.94)' : (surface === 'Paper' ? 'rgba(251,247,236,0.94)' : 'rgba(255,255,255,0.94)'),
          backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
          borderTop: `1px solid ${S.borderSubtle}`,
          padding: '0 40px',
          display: 'flex', alignItems: 'center', gap: 12,
          fontSize: 11.5, color: S.textSecondary,
          whiteSpace: 'nowrap',
          zIndex: 2,
        }}>
          <span className="braille-spinner" style={{ color: S.accent }} />
          <span><b style={{ color: S.textPrimary }}>{V.footerVerb}</b> · <span style={{ fontFamily: 'var(--mono)', color: S.textMuted }}>step 4 / 6 · Write</span></span>
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', color: S.textMuted, fontSize: 11 }}>
            {T.showTicker ? <FooterTicker /> : T.footerEta}
          </span>
        </div>
        <ActionBar />
      </div>
    </Frame>
  );
}

// Live ticker — only used in Urgent tempo
function FooterTicker() {
  const [n, setN] = React.useState({ tk: 43210, cost: 0.18, sec: 64 });
  React.useEffect(() => {
    const id = setInterval(() => {
      setN(p => ({
        tk: p.tk + Math.floor(80 + Math.random() * 240),
        cost: +(p.cost + 0.001 + Math.random() * 0.002).toFixed(3),
        sec: p.sec + 1,
      }));
    }, 600);
    return () => clearInterval(id);
  }, []);
  const m = Math.floor(n.sec / 60), s = n.sec % 60;
  return (
    <span>
      <span className="ticker-num">{n.tk.toLocaleString()}</span> tk · ${n.cost.toFixed(2)} · {m}m {String(s).padStart(2,'0')}s
    </span>
  );
}

const inlineCodeS = (S) => ({
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
  background: S.bgSecondary,
  padding: '0 4px', borderRadius: 3,
  color: S.textPrimary,
});

function SectionHead({ n, label, surface }) {
  const S = surface || getSurface('Screen');
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: S.textMuted, fontWeight: 600 }}>{n}</span>
      <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.005em', color: S.textPrimary }}>{label}</span>
      <span style={{ marginLeft: 'auto', fontSize: 9.5, color: S.textMuted, fontWeight: 500, letterSpacing: 0.5, textTransform: 'uppercase', fontFamily: 'var(--mono)' }}>queued</span>
    </div>
  );
}

function SectionGhost({ n, label, files, rows, shimmer, surface }) {
  const S = surface || getSurface('Screen');
  return (
    <div style={{ marginBottom: 22, opacity: 0.55 }}>
      <SectionHead n={n} label={label} surface={S} />
      {files && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
          {files.map(f => (
            <span key={f} style={{
              fontFamily: 'var(--mono)', fontSize: 10.5,
              padding: '2px 7px', borderRadius: 3,
              background: S.bgSecondary, color: S.textMuted,
              border: `1px solid ${S.borderSubtle}`,
            }}>{f}</span>
          ))}
        </div>
      )}
      {(rows || [88, 72, 60, 80]).map((w, i) => (
        <div key={i} className={shimmer ? 'shimmer' : ''} style={{
          height: 9, width: `${w}%`,
          background: S.queuedBarBg, borderRadius: 3, marginBottom: 6,
        }} />
      ))}
    </div>
  );
}

window.V4_5RealStream = V4_5RealStream;
