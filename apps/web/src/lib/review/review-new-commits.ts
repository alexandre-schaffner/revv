interface ReviewNewCommitsActions {
  pull: () => Promise<boolean>;
  regenerate: () => Promise<void>;
}

/** Refresh the visible diff before reviewing the new head. */
export async function reviewNewCommits(actions: ReviewNewCommitsActions): Promise<void> {
  const pulled = await actions.pull();
  if (pulled) await actions.regenerate();
}
