// Top-level app — lays out the 7 variations on a design canvas.

const root = ReactDOM.createRoot(document.getElementById('root'));

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  return (
    <TweakContext.Provider value={t}>
      <DesignCanvas>
        <DCSection
          id="walkthrough"
          title="Walkthrough generation"
          subtitle="7 ways to fill the wait — informative, terminal-leaning, restrained."
        >
          <DCArtboard id="v1" label="01 · Refined current" width={FRAME_W} height={FRAME_H}>
            <V1Current />
          </DCArtboard>
          <DCArtboard id="v2" label="02 · Live log" width={FRAME_W} height={FRAME_H}>
            <V2LiveLog />
          </DCArtboard>
          <DCArtboard id="v3" label="03 · Outline + activity" width={FRAME_W} height={FRAME_H}>
            <V3TwoColumn />
          </DCArtboard>
          <DCArtboard id="v4" label="04 · Streaming doc" width={FRAME_W} height={FRAME_H}>
            <V4Stream />
          </DCArtboard>
          <DCArtboard id="v4_5" label="04.5 · Streaming doc · tuned to real layout" width={FRAME_W} height={FRAME_H}>
            <V4_5RealStream />
          </DCArtboard>
          <DCArtboard id="v5" label="05 · Repo tree" width={FRAME_W} height={FRAME_H}>
            <V5Tree />
          </DCArtboard>
          <DCArtboard id="v6" label="06 · Cinema" width={FRAME_W} height={FRAME_H}>
            <V6Cinema />
          </DCArtboard>
          <DCArtboard id="v7" label="07 · Cockpit" width={FRAME_W} height={FRAME_H}>
            <V7Cockpit />
          </DCArtboard>
        </DCSection>
        <DCSection
          id="steppers"
          title="Stepper variations"
          subtitle="Story / numbered chapters / big type. 4 user-facing sections."
        >
          <DCArtboard id="s1" label="S1 · Chapters" width={1024} height={220}>
            <StepperChapters />
          </DCArtboard>
          <DCArtboard id="s2" label="S2 · Ticker" width={1024} height={220}>
            <StepperTicker />
          </DCArtboard>
          <DCArtboard id="s3" label="S3 · Stack" width={1024} height={280}>
            <StepperStack />
          </DCArtboard>
          <DCArtboard id="s4" label="S4 · Script" width={1024} height={220}>
            <StepperScript />
          </DCArtboard>
          <DCArtboard id="s5" label="S5 · Masthead" width={1024} height={220}>
            <StepperMasthead />
          </DCArtboard>
        </DCSection>
        <DCSection
          id="chapters-deepdive"
          title="Chapters · pushing the winner"
          subtitle="Each variant changes ONE dimension of S1: active state, top rule, done state, density."
        >
          <DCArtboard id="c1" label="C1 · Active = live file path" width={1024} height={220}>
            <ChapC1ActiveFile />
          </DCArtboard>
          <DCArtboard id="c2" label="C2 · Active = live first sentence" width={1024} height={220}>
            <ChapC2LivePreview />
          </DCArtboard>
          <DCArtboard id="c3" label="C3 · Top rule = progress fill" width={1024} height={220}>
            <ChapC3RuleProgress />
          </DCArtboard>
          <DCArtboard id="c4" label="C4 · Mid-flight (Ch.1 done, Ch.2 active)" width={1024} height={220}>
            <ChapC4DoneState />
          </DCArtboard>
          <DCArtboard id="c5" label="C5 · Oversized numerals" width={1024} height={240}>
            <ChapC5BigNumerals />
          </DCArtboard>
        </DCSection>
      </DesignCanvas>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Voice" />
        <TweakRadio
          label="Persona" value={t.voice}
          options={['Editorial', 'Operator', 'Engineer']}
          onChange={(v) => setTweak('voice', v)}
        />
        <TweakSection label="Tempo" />
        <TweakRadio
          label="Pace" value={t.tempo}
          options={['Calm', 'Steady', 'Urgent']}
          onChange={(v) => setTweak('tempo', v)}
        />
        <TweakSection label="Surface" />
        <TweakRadio
          label="Material" value={t.surface}
          options={['Paper', 'Screen', 'Terminal']}
          onChange={(v) => setTweak('surface', v)}
        />
      </TweaksPanel>
    </TweakContext.Provider>
  );
}

root.render(<App />);
