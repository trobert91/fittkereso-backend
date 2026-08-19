// Thrown by guard ops (assertContains, filterByNonEmpty) when their condition
// fails and onFail is 'returnEmpty', to short-circuit the *entire* remaining
// pipeline — not just that op's own output — mirroring the early `return`
// statements in the original hand-written extractors (e.g. "if not on page 1,
// return no pagination links" bails out of the whole function, not just one
// step of it).
export class PipelineHalt {
  constructor(public readonly value: unknown) {}
}
