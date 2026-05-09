// Tweak context — three orthogonal expressive controls that reshape V4.5.
//
// voice    — Editorial | Operator | Engineer    (voice/typography/copy)
// tempo    — Calm      | Steady   | Urgent       (motion + signal density)
// surface  — Paper     | Screen   | Terminal     (material + palette)
//
// Each combines into 27 distinct feels. Defaults are the as-shipped look.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "voice": "Operator",
  "tempo": "Steady",
  "surface": "Screen"
}/*EDITMODE-END*/;

const TweakContext = React.createContext(TWEAK_DEFAULTS);

// Voice presets — body font, eyebrow style, copy
const VOICE_PRESETS = {
  Editorial: {
    bodyFont: "'Newsreader', Georgia, serif",
    bodyWeight: 400,
    bodyLineHeight: 1.7,
    eyebrowFont: "'Newsreader', Georgia, serif",
    eyebrowItalic: true,
    eyebrowCase: 'asis',           // "Chapter 01"
    statusVerb: 'Drafting',
    footerVerb: 'Drafting Overview',
    issueLabel: '1 issue flagged',
    showLiveStatus: true,
    overviewHeading: 'Overview',
    chapterPrefix: 'Chapter',
  },
  Operator: {
    bodyFont: "'Inter', -apple-system, sans-serif",
    bodyWeight: 400,
    bodyLineHeight: 1.65,
    eyebrowFont: "'Newsreader', Georgia, serif",
    eyebrowItalic: true,
    eyebrowCase: 'asis',
    statusVerb: 'Building',
    footerVerb: 'Drafting Overview',
    issueLabel: '1 issue flagged',
    showLiveStatus: true,
    overviewHeading: 'Overview',
    chapterPrefix: 'Chapter',
  },
  Engineer: {
    bodyFont: "'JetBrains Mono', ui-monospace, monospace",
    bodyWeight: 400,
    bodyLineHeight: 1.55,
    eyebrowFont: "'JetBrains Mono', ui-monospace, monospace",
    eyebrowItalic: false,
    eyebrowCase: 'upper',           // "CH.01"
    statusVerb: 'compiling',
    footerVerb: 'overview.write()',
    issueLabel: 'warn[1]',
    showLiveStatus: true,
    overviewHeading: 'OVERVIEW',
    chapterPrefix: 'CH.',
  },
};

// Tempo presets — animation durations + signal density
const TEMPO_PRESETS = {
  Calm: {
    spinnerDur: '1.6s',
    cursorDur: '1.8s',
    fadeUpDur: '.9s',
    shimmerOnQueued: false,
    showFooterMetrics: false,
    footerEta: 'Working…',
    pulseDotDur: '2.4s',
  },
  Steady: {
    spinnerDur: '0.8s',
    cursorDur: '1.1s',
    fadeUpDur: '.5s',
    shimmerOnQueued: true,         // current default — only Diff Analysis shimmers
    shimmerScope: 'diff',          // 'diff' | 'all' | 'none'
    showFooterMetrics: true,
    footerEta: '43,210 tk · $0.18 · 1m 04s',
    pulseDotDur: '1.4s',
  },
  Urgent: {
    spinnerDur: '0.4s',
    cursorDur: '.6s',
    fadeUpDur: '.25s',
    shimmerOnQueued: true,
    shimmerScope: 'all',
    showFooterMetrics: true,
    footerEta: 'live · pumping',    // ticker swaps in
    showTicker: true,
    pulseDotDur: '0.7s',
  },
};

// Surface presets — palette + material
const SURFACE_PRESETS = {
  Paper: {
    artboardBg: '#f5f1e8',
    bgPrimary: '#fbf7ec',
    bgSecondary: '#f0eadc',
    bgTertiary: '#e6dfca',
    textPrimary: '#2a2418',
    textSecondary: '#544a35',
    textMuted: '#8a7d5e',
    border: '#cdc1a2',
    borderSubtle: '#e3dabc',
    accent: '#a25c1f',              // burnt sienna
    accentHover: '#8b4914',
    warning: '#a86a06',
    issueBorder: '#a86a06',
    issueBg: '#f4e8c8',
    issueBadgeBg: '#dfc685',
    issueBadgeFg: '#5d3f0b',
    riskBg: '#e9dab0',
    riskFg: '#7a4a0a',
    queuedBarBg: '#dccfa6',
    queuedCardBg: '#f0e9d3',
    grain: true,
  },
  Screen: {
    artboardBg: '#f0eee9',
    bgPrimary: '#ffffff',
    bgSecondary: '#f7f7f8',
    bgTertiary: '#eeeff1',
    textPrimary: '#111118',
    textSecondary: '#44444f',
    textMuted: '#72727e',
    border: '#d0d0d6',
    borderSubtle: '#e5e5ea',
    accent: '#3b82f6',
    accentHover: '#2563eb',
    warning: '#b45309',
    issueBorder: '#d97706',
    issueBg: '#fdf6e8',
    issueBadgeBg: '#f5d99c',
    issueBadgeFg: '#7c4d09',
    riskBg: '#fdf3e2',
    riskFg: '#b45309',
    queuedBarBg: '#eef0f3',
    queuedCardBg: '#fafafb',
    grain: false,
  },
  Terminal: {
    artboardBg: '#0a0a0e',
    bgPrimary: '#0d0d11',
    bgSecondary: '#16161c',
    bgTertiary: '#1d1d25',
    textPrimary: '#d4d4d8',
    textSecondary: '#a1a1aa',
    textMuted: '#71717a',
    border: '#27272f',
    borderSubtle: '#1d1d25',
    accent: '#7fb069',              // green
    accentHover: '#a3d18a',
    warning: '#d97706',
    issueBorder: '#d97706',
    issueBg: '#211a0a',
    issueBadgeBg: '#3a2a08',
    issueBadgeFg: '#f5b955',
    riskBg: '#2a1f0a',
    riskFg: '#f5b955',
    queuedBarBg: '#1d1d25',
    queuedCardBg: '#13131a',
    grain: false,
  },
};

function useTweak() {
  return React.useContext(TweakContext);
}
function getVoice(v)   { return VOICE_PRESETS[v]   || VOICE_PRESETS.Operator; }
function getTempo(t)   { return TEMPO_PRESETS[t]   || TEMPO_PRESETS.Steady; }
function getSurface(s) { return SURFACE_PRESETS[s] || SURFACE_PRESETS.Screen; }

// Build a CSS variable map for the chosen surface — scoped to a wrapper element.
function surfaceCssVars(s) {
  const sp = getSurface(s);
  return {
    '--revv-bg-primary':     sp.bgPrimary,
    '--revv-bg-secondary':   sp.bgSecondary,
    '--revv-bg-tertiary':    sp.bgTertiary,
    '--revv-border':         sp.border,
    '--revv-border-subtle':  sp.borderSubtle,
    '--revv-text-primary':   sp.textPrimary,
    '--revv-text-secondary': sp.textSecondary,
    '--revv-text-muted':     sp.textMuted,
    '--revv-accent':         sp.accent,
    '--revv-accent-hover':   sp.accentHover,
    '--revv-warning':        sp.warning,
  };
}

Object.assign(window, {
  TWEAK_DEFAULTS, TweakContext, useTweak,
  VOICE_PRESETS, TEMPO_PRESETS, SURFACE_PRESETS,
  getVoice, getTempo, getSurface, surfaceCssVars,
});
