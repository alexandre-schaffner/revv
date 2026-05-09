// Stepper variations — 5 takes on the 4-section walkthrough progress.
// "Story / numbered chapters / big type" direction.
// All five render in a fixed 1024×220 frame so they're directly comparable.

const STEPS = [
  { id: 'overview',  label: 'Overview',     blurb: 'What changed and why' },
  { id: 'diff',      label: 'Diff Analysis', blurb: 'Hunk-by-hunk reasoning' },
  { id: 'sentiment', label: 'Sentiment',    blurb: 'Overall read on the PR' },
  { id: 'rated',     label: 'Rating',       blurb: 'Across 9 axis' },
];

// Shared chrome: simple white card, no titlebar, just the stepper.
function StepperFrame({ children, height = 220 }) {
  return (
    <div style={{
      width: 1024, height,
      background: '#fff',
      borderRadius: 10,
      overflow: 'hidden',
      boxShadow: '0 1px 0 rgba(0,0,0,0.04), 0 12px 32px -8px rgba(0,0,0,0.10)',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      display: 'flex', flexDirection: 'column',
      color: 'var(--revv-text-primary)',
    }}>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// S1 — CHAPTERS
// Big numbered chapters with serif, like a book TOC. Active chapter
// expands; queued ones are quiet. The number IS the visual hierarchy.
// ─────────────────────────────────────────────────────────────
function StepperChapters() {
  return (
    <StepperFrame>
      <div style={{
        flex: 1, padding: '32px 56px',
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        columnGap: 24,
        alignItems: 'baseline',
      }}>
        {STEPS.map((s, i) => {
          const done = i < 0;
          const active = i === 0;
          return (
            <div key={s.id} style={{
              borderTop: `2px solid ${active ? 'var(--revv-accent)' : '#e5e5ea'}`,
              paddingTop: 14,
              opacity: i > 1 ? 0.6 : 1,
            }}>
              <div style={{
                fontFamily: "'Newsreader', Georgia, serif",
                fontSize: 13, fontWeight: 500, fontStyle: 'italic',
                color: active ? 'var(--revv-accent)' : 'var(--revv-text-muted)',
                letterSpacing: 0.3,
                marginBottom: 4,
              }}>
                Chapter {String(i + 1).padStart(2, '0')}
              </div>
              <div style={{
                fontFamily: "'Newsreader', Georgia, serif",
                fontSize: 26, fontWeight: 500, letterSpacing: '-0.015em',
                lineHeight: 1.05, marginBottom: 6,
              }}>
                {s.label}
              </div>
              <div style={{
                fontSize: 11.5, color: 'var(--revv-text-muted)', lineHeight: 1.4,
              }}>
                {active ? (
                  <span style={{ color: 'var(--revv-accent)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span className="braille-spinner" />
                    drafting…
                  </span>
                ) : s.blurb}
              </div>
            </div>
          );
        })}
      </div>
    </StepperFrame>
  );
}

// ─────────────────────────────────────────────────────────────
// S2 — TICKER
// Single bold line. Big mono "01 / 04" counter on the left, current
// chapter title in large serif, animated underline progress beneath.
// Other chapters are tiny breadcrumbs to the right.
// ─────────────────────────────────────────────────────────────
function StepperTicker() {
  const idx = 0;
  const pct = 38; // % through current step
  return (
    <StepperFrame>
      <div style={{ flex: 1, padding: '36px 56px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 24 }}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--revv-text-muted)',
            fontWeight: 500, letterSpacing: 0.5,
          }}>
            <span style={{ color: 'var(--revv-accent)', fontWeight: 600 }}>{String(idx + 1).padStart(2, '0')}</span>
            <span style={{ margin: '0 6px', color: '#cfcfd6' }}>/</span>
            <span>{String(STEPS.length).padStart(2, '0')}</span>
          </div>
          <div style={{
            fontFamily: "'Newsreader', Georgia, serif",
            fontSize: 44, fontWeight: 500, letterSpacing: '-0.02em',
            lineHeight: 1,
          }}>
            {STEPS[idx].label}
          </div>
          <div style={{
            marginLeft: 'auto',
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--revv-text-muted)',
          }}>
            up next →
            {' '}<span style={{ color: 'var(--revv-text-secondary)', fontWeight: 500 }}>{STEPS[idx + 1].label}</span>
            {' · '}{STEPS[idx + 2].label}
            {' · '}{STEPS[idx + 3].label}
          </div>
        </div>
        <div style={{
          fontSize: 13, color: 'var(--revv-text-secondary)', marginTop: 10,
          marginLeft: 78,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span className="braille-spinner" style={{ color: 'var(--revv-accent)' }} />
          <span>{STEPS[idx].blurb}</span>
        </div>

        {/* progress rail */}
        <div style={{
          marginTop: 28, height: 2,
          background: '#f1f1f3', borderRadius: 1,
          position: 'relative', overflow: 'hidden',
        }}>
          {/* completed */}
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${(idx / STEPS.length) * 100}%`,
            background: 'var(--revv-success)',
          }} />
          {/* current */}
          <div style={{
            position: 'absolute',
            left: `${(idx / STEPS.length) * 100}%`,
            width: `${(pct / 100) * (100 / STEPS.length)}%`,
            top: 0, bottom: 0,
            background: 'var(--revv-accent)',
          }} />
          {/* tick marks */}
          {STEPS.map((_, i) => (
            <div key={i} style={{
              position: 'absolute',
              left: `${((i + 1) / STEPS.length) * 100}%`,
              top: -3, bottom: -3, width: 1,
              background: '#e5e5ea',
              transform: 'translateX(-50%)',
            }} />
          ))}
        </div>
      </div>
    </StepperFrame>
  );
}

// ─────────────────────────────────────────────────────────────
// S3 — STACK (vertical, novel orientation)
// Like a printed table of contents. Roman numerals, generous leading,
// active row gets a subtle highlight bar. Feels editorial.
// ─────────────────────────────────────────────────────────────
function StepperStack() {
  const ROMAN = ['I', 'II', 'III', 'IV'];
  return (
    <StepperFrame height={280}>
      <div style={{ flex: 1, padding: '24px 56px', display: 'flex', alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          {STEPS.map((s, i) => {
            const active = i === 0;
            const done = i < 0;
            return (
              <div key={s.id} style={{
                display: 'flex', alignItems: 'baseline', gap: 18,
                padding: '6px 0',
                borderBottom: i < STEPS.length - 1 ? '1px solid #f1f1f3' : 'none',
                opacity: !active && !done && i > 1 ? 0.55 : 1,
                position: 'relative',
              }}>
                {active && (
                  <div style={{
                    position: 'absolute', left: -56, top: 0, bottom: 0, width: 3,
                    background: 'var(--revv-accent)',
                  }} />
                )}
                <span style={{
                  fontFamily: "'Newsreader', Georgia, serif",
                  fontSize: 14, fontWeight: 500, fontStyle: 'italic',
                  color: active ? 'var(--revv-accent)' : 'var(--revv-text-muted)',
                  width: 32, textAlign: 'right', flexShrink: 0,
                }}>{ROMAN[i]}</span>
                <span style={{
                  fontFamily: "'Newsreader', Georgia, serif",
                  fontSize: 22, fontWeight: 500, letterSpacing: '-0.012em',
                  flex: 1,
                  color: active ? 'var(--revv-text-primary)' : (done ? 'var(--revv-text-secondary)' : 'var(--revv-text-secondary)'),
                }}>{s.label}</span>
                <span style={{
                  fontSize: 12, color: 'var(--revv-text-muted)',
                  fontFamily: "'Newsreader', Georgia, serif", fontStyle: 'italic',
                }}>
                  {active ? 'in progress' : done ? 'done' : '—'}
                </span>
                {active && (
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--revv-accent)',
                    minWidth: 60, textAlign: 'right',
                  }}>1m 04s</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </StepperFrame>
  );
}

// ─────────────────────────────────────────────────────────────
// S4 — SCRIPT
// Numbered chapters laid out like a film script slate: each step gets
// a "scene heading" with its number in a bold mono block, bridged by
// a thin horizontal line. The active scene's heading rotates left
// like a director's slate clapper.
// ─────────────────────────────────────────────────────────────
function StepperScript() {
  return (
    <StepperFrame>
      <div style={{
        flex: 1, padding: '36px 40px',
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        alignItems: 'center',
        gap: 0,
      }}>
        {STEPS.map((s, i) => {
          const active = i === 0;
          return (
            <div key={s.id} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              position: 'relative',
            }}>
              {/* connector */}
              {i > 0 && (
                <div style={{
                  position: 'absolute', left: '-50%', right: '50%', top: 30,
                  height: 1, background: i <= 1 ? 'var(--revv-accent)' : '#e5e5ea',
                  zIndex: 0,
                }} />
              )}
              <div style={{
                width: 60, height: 60,
                background: active ? '#0c0d10' : '#f7f7f8',
                color: active ? '#fff' : 'var(--revv-text-muted)',
                borderRadius: 6,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 600,
                letterSpacing: 0.5,
                position: 'relative', zIndex: 1,
                transform: active ? 'rotate(-3deg)' : 'none',
                transition: 'transform .3s',
                boxShadow: active ? '0 6px 16px -4px rgba(0,0,0,0.25)' : 'none',
              }}>
                {String(i + 1).padStart(2, '0')}
              </div>
              <div style={{
                marginTop: 14,
                fontFamily: "'Newsreader', Georgia, serif",
                fontSize: 19, fontWeight: 500, letterSpacing: '-0.012em',
                color: active ? 'var(--revv-text-primary)' : 'var(--revv-text-secondary)',
                opacity: i > 1 ? 0.6 : 1,
              }}>
                {s.label}
              </div>
              <div style={{
                marginTop: 4,
                fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: active ? 'var(--revv-accent)' : '#b0b0ba',
                fontWeight: 600,
              }}>
                {active ? '· now playing ·' : i < 0 ? 'done' : 'queued'}
              </div>
            </div>
          );
        })}
      </div>
    </StepperFrame>
  );
}

// ─────────────────────────────────────────────────────────────
// S5 — MASTHEAD
// Newspaper masthead. Tiny top eyebrow ("WALKTHROUGH · NO. 185"),
// the four sections rendered as a single typographic line with bullet
// separators, current one bolded and underlined with an animated rule.
// Below: the active section's blurb in italic serif, like a lede.
// ─────────────────────────────────────────────────────────────
function StepperMasthead() {
  const idx = 0;
  return (
    <StepperFrame>
      <div style={{ flex: 1, padding: '28px 56px 32px', display: 'flex', flexDirection: 'column' }}>
        {/* eyebrow */}
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
          letterSpacing: 1.2, textTransform: 'uppercase',
          color: 'var(--revv-text-muted)',
          paddingBottom: 8,
          borderBottom: '1px solid var(--revv-border-subtle)',
          display: 'flex', alignItems: 'baseline', gap: 12,
        }}>
          <span>The Walkthrough</span>
          <span style={{ color: '#cfcfd6' }}>·</span>
          <span>No. 185</span>
          <span style={{ color: '#cfcfd6' }}>·</span>
          <span>fix/leaderboard</span>
          <span style={{ marginLeft: 'auto', color: 'var(--revv-accent)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="braille-spinner" />
            <span>generating</span>
          </span>
        </div>

        {/* big sections line */}
        <div style={{
          marginTop: 22, marginBottom: 14,
          fontFamily: "'Newsreader', Georgia, serif",
          fontSize: 38, fontWeight: 500, letterSpacing: '-0.018em',
          lineHeight: 1.1,
          display: 'flex', alignItems: 'baseline', flexWrap: 'wrap',
          columnGap: 18, rowGap: 4,
        }}>
          {STEPS.map((s, i) => {
            const active = i === idx;
            const done = i < idx;
            return (
              <React.Fragment key={s.id}>
                <span style={{
                  position: 'relative',
                  color: active ? 'var(--revv-text-primary)' : (done ? 'var(--revv-text-secondary)' : '#b0b0ba'),
                  fontWeight: active ? 600 : 500,
                  fontStyle: done ? 'italic' : 'normal',
                  whiteSpace: 'nowrap',
                }}>
                  {s.label}
                  {active && (
                    <span style={{
                      position: 'absolute', left: 0, right: 0, bottom: -6,
                      height: 3, background: 'var(--revv-accent)',
                      borderRadius: 1.5,
                    }} />
                  )}
                </span>
                {i < STEPS.length - 1 && (
                  <span style={{ color: '#cfcfd6', fontSize: 26, fontWeight: 400 }}>·</span>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* lede */}
        <div style={{
          fontFamily: "'Newsreader', Georgia, serif",
          fontSize: 14.5, fontStyle: 'italic',
          color: 'var(--revv-text-secondary)',
          lineHeight: 1.5, marginTop: 14,
          maxWidth: 720,
        }}>
          {STEPS[idx].blurb}
          <span style={{ fontFamily: 'var(--mono)', fontStyle: 'normal', fontSize: 11, color: 'var(--revv-text-muted)', marginLeft: 12 }}>
            · 1m 04s elapsed
          </span>
        </div>
      </div>
    </StepperFrame>
  );
}

Object.assign(window, {
  StepperChapters, StepperTicker, StepperStack, StepperScript, StepperMasthead,
});
