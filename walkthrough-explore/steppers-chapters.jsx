// Stepper · Chapters — 5 explorations of the S1 winner.
// Each variant varies ONE dimension while holding the others.
// Base recipe: 4 chapters, top rule, italic "Chapter 0X" eyebrow,
// big serif title, blurb beneath. Active = first.

const CHAPTERS = [
  { id: 'overview',  label: 'Overview',     blurb: 'What changed and why',
    summary: '5 files · −124 +362', count: '163 lines' },
  { id: 'diff',      label: 'Diff Analysis', blurb: 'Hunk-by-hunk reasoning',
    summary: 'queued', count: '4 files' },
  { id: 'sentiment', label: 'Sentiment',    blurb: 'Overall read on the PR',
    summary: 'queued', count: '' },
  { id: 'rated',     label: 'Rating',       blurb: 'Across 9 axis',
    summary: 'queued', count: '' },
];

function ChapFrame({ children, height = 220 }) {
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
    }}>{children}</div>
  );
}

// ─────────────────────────────────────────────────────────────
// C1 — ACTIVE STATE: live file path
// Show the actual file the agent is reading right now under the title.
// Mono path, ellipsis-truncated. Most informative variant.
// ─────────────────────────────────────────────────────────────
function ChapC1ActiveFile() {
  return (
    <ChapFrame>
      <div style={{
        flex: 1, padding: '32px 56px',
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        columnGap: 28, alignItems: 'baseline',
      }}>
        {CHAPTERS.map((c, i) => {
          const active = i === 0;
          return (
            <div key={c.id} style={{
              borderTop: `2px solid ${active ? 'var(--revv-accent)' : '#e5e5ea'}`,
              paddingTop: 14, opacity: i > 1 ? 0.55 : 1,
            }}>
              <Eyebrow n={i + 1} active={active} />
              <Title>{c.label}</Title>
              {active ? (
                <div style={{ marginTop: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--revv-accent)', marginBottom: 4 }}>
                    <span className="braille-spinner" />
                    <span style={{ fontWeight: 500, letterSpacing: 0.3 }}>reading</span>
                  </div>
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 11,
                    color: 'var(--revv-text-secondary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    apps/api/src/…/leafLeaderboard.repository.ts
                  </div>
                </div>
              ) : (
                <Blurb>{c.blurb}</Blurb>
              )}
            </div>
          );
        })}
      </div>
    </ChapFrame>
  );
}

// ─────────────────────────────────────────────────────────────
// C2 — ACTIVE STATE: live first-sentence preview
// The active chapter shows the *actual* opening of the section being
// drafted, in serif italic with a blinking caret. The artifact is
// born inside the stepper.
// ─────────────────────────────────────────────────────────────
function ChapC2LivePreview() {
  return (
    <ChapFrame>
      <div style={{
        flex: 1, padding: '32px 56px',
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        columnGap: 28, alignItems: 'baseline',
      }}>
        {CHAPTERS.map((c, i) => {
          const active = i === 0;
          return (
            <div key={c.id} style={{
              borderTop: `2px solid ${active ? 'var(--revv-accent)' : '#e5e5ea'}`,
              paddingTop: 14, opacity: i > 1 ? 0.55 : 1,
            }}>
              <Eyebrow n={i + 1} active={active} />
              <Title>{c.label}</Title>
              {active ? (
                <div style={{
                  marginTop: 6,
                  fontFamily: "'Newsreader', Georgia, serif",
                  fontSize: 12.5, fontStyle: 'italic',
                  color: 'var(--revv-text-secondary)',
                  lineHeight: 1.5,
                }}>
                  Fixes a leaderboard bug where row sums could exceed the campaign total<span className="blink-cursor" style={{ color: 'var(--revv-accent)', fontStyle: 'normal' }}>▎</span>
                </div>
              ) : (
                <Blurb>{c.blurb}</Blurb>
              )}
            </div>
          );
        })}
      </div>
    </ChapFrame>
  );
}

// ─────────────────────────────────────────────────────────────
// C3 — TOP RULE: animated progress fill
// The top rule above the active chapter fills left-to-right as the
// chapter progresses. Other rules sit at solid done/idle. The rule IS
// the progress bar — most ambient variant.
// ─────────────────────────────────────────────────────────────
function ChapC3RuleProgress() {
  const pct = 42;
  return (
    <ChapFrame>
      <div style={{
        flex: 1, padding: '32px 56px',
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        columnGap: 28, alignItems: 'baseline',
      }}>
        {CHAPTERS.map((c, i) => {
          const active = i === 0;
          const done = i < 0;
          return (
            <div key={c.id} style={{
              paddingTop: 14, opacity: i > 1 ? 0.55 : 1, position: 'relative',
            }}>
              <div style={{
                position: 'absolute', left: 0, right: 0, top: 0,
                height: 2, background: '#eef0f3', borderRadius: 1, overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%',
                  width: done ? '100%' : active ? `${pct}%` : '0%',
                  background: done ? 'var(--revv-success)' : 'var(--revv-accent)',
                  transition: 'width .6s',
                }} />
                {active && (
                  <div className="shimmer" style={{
                    position: 'absolute', inset: 0,
                    background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.55), transparent)',
                    backgroundSize: '200% 100%',
                  }} />
                )}
              </div>
              <Eyebrow n={i + 1} active={active} />
              <Title>{c.label}</Title>
              <Blurb>{c.blurb}</Blurb>
              {active && (
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 10.5,
                  color: 'var(--revv-accent)', marginTop: 4,
                  letterSpacing: 0.4,
                }}>{pct}% · 1m 04s</div>
              )}
            </div>
          );
        })}
      </div>
    </ChapFrame>
  );
}

// ─────────────────────────────────────────────────────────────
// C4 — DONE STATE: result summary
// Imagines the stepper a few minutes later. Chapter 1 done with a
// summary line; chapter 2 active; chapters 3–4 queued. Tests the
// "evolution" of the design across phase transitions.
// ─────────────────────────────────────────────────────────────
function ChapC4DoneState() {
  const ch = [
    { ...CHAPTERS[0], state: 'done', summary: '5 files · 1 issue flagged', dur: '47s' },
    { ...CHAPTERS[1], state: 'active' },
    { ...CHAPTERS[2], state: 'queued' },
    { ...CHAPTERS[3], state: 'queued' },
  ];
  return (
    <ChapFrame>
      <div style={{
        flex: 1, padding: '32px 56px',
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        columnGap: 28, alignItems: 'baseline',
      }}>
        {ch.map((c, i) => {
          const active = c.state === 'active';
          const done = c.state === 'done';
          return (
            <div key={c.id} style={{
              borderTop: `2px solid ${done ? 'var(--revv-success)' : active ? 'var(--revv-accent)' : '#e5e5ea'}`,
              paddingTop: 14, opacity: c.state === 'queued' && i > 1 ? 0.55 : 1,
            }}>
              <Eyebrow n={i + 1} active={active} done={done} />
              <Title style={{ color: done ? 'var(--revv-text-secondary)' : 'var(--revv-text-primary)' }}>{c.label}</Title>
              {done ? (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontSize: 12, color: 'var(--revv-text-secondary)', lineHeight: 1.4 }}>
                    {c.summary}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--revv-text-muted)', marginTop: 4, letterSpacing: 0.3 }}>
                    ✓ {c.dur}
                  </div>
                </div>
              ) : active ? (
                <div style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--revv-accent)' }}>
                  <span className="braille-spinner" />
                  <span style={{ fontWeight: 500 }}>analyzing…</span>
                </div>
              ) : (
                <Blurb>{c.blurb}</Blurb>
              )}
            </div>
          );
        })}
      </div>
    </ChapFrame>
  );
}

// ─────────────────────────────────────────────────────────────
// C5 — DENSITY: oversized chapter numerals
// Pushes the editorial dimension. The chapter NUMBERS become huge
// outline serif glyphs; titles drop slightly in size. Feels like a
// Faber & Faber hardback. The active number fills.
// ─────────────────────────────────────────────────────────────
function ChapC5BigNumerals() {
  return (
    <ChapFrame height={240}>
      <div style={{
        flex: 1, padding: '28px 56px 32px',
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        columnGap: 28, alignItems: 'baseline',
      }}>
        {CHAPTERS.map((c, i) => {
          const active = i === 0;
          return (
            <div key={c.id} style={{
              borderTop: `2px solid ${active ? 'var(--revv-accent)' : '#e5e5ea'}`,
              paddingTop: 16, opacity: i > 1 ? 0.55 : 1,
            }}>
              <div style={{
                fontFamily: "'Newsreader', Georgia, serif",
                fontSize: 64, fontWeight: 500,
                lineHeight: 0.9, letterSpacing: '-0.04em',
                color: active ? 'var(--revv-accent)' : 'transparent',
                WebkitTextStroke: active ? 'none' : '1px #cfcfd6',
                marginBottom: 6,
              }}>
                {String(i + 1).padStart(2, '0')}
              </div>
              <div style={{
                fontFamily: "'Newsreader', Georgia, serif",
                fontSize: 21, fontWeight: 500, letterSpacing: '-0.012em',
                lineHeight: 1.1, marginBottom: 5,
              }}>
                {c.label}
              </div>
              {active ? (
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: 11.5, color: 'var(--revv-accent)',
                }}>
                  <span className="braille-spinner" />
                  <span style={{ fontWeight: 500 }}>drafting…</span>
                </div>
              ) : (
                <Blurb>{c.blurb}</Blurb>
              )}
            </div>
          );
        })}
      </div>
    </ChapFrame>
  );
}

// shared atoms ────────────────────────────────────────────────
function Eyebrow({ n, active, done }) {
  return (
    <div style={{
      fontFamily: "'Newsreader', Georgia, serif",
      fontSize: 13, fontWeight: 500, fontStyle: 'italic',
      color: done ? 'var(--revv-success)' : active ? 'var(--revv-accent)' : 'var(--revv-text-muted)',
      letterSpacing: 0.3, marginBottom: 4,
    }}>
      Chapter {String(n).padStart(2, '0')}
    </div>
  );
}
function Title({ children, style }) {
  return (
    <div style={{
      fontFamily: "'Newsreader', Georgia, serif",
      fontSize: 26, fontWeight: 500, letterSpacing: '-0.015em',
      lineHeight: 1.05, marginBottom: 6,
      ...style,
    }}>{children}</div>
  );
}
function Blurb({ children }) {
  return (
    <div style={{ fontSize: 11.5, color: 'var(--revv-text-muted)', lineHeight: 1.4 }}>
      {children}
    </div>
  );
}

Object.assign(window, {
  ChapC1ActiveFile, ChapC2LivePreview, ChapC3RuleProgress, ChapC4DoneState, ChapC5BigNumerals,
});
