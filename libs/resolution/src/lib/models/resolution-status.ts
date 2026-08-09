/**
 * Terminal status of a search. Stage 6's orchestrator sets this on the final
 * persisted context. Intermediate states (CANDIDATES_FOUND, MATCH_REJECTED,
 * etc.) are not enumerated here — they're internal to the matcher / decision
 * stage and don't need to round-trip through the persisted artifact.
 */
export enum ResolutionStatus {
  INPUT_RECEIVED = 'INPUT_RECEIVED',
  RESOLVED = 'RESOLVED',
  UNRESOLVED = 'UNRESOLVED',
}
