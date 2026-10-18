// Module boundary: other code may import only this file (see docs/adr/0001-foundation.md).
export const MODULE_NAME = 'submissions' as const;
export { CANON_HEADER, CANON_VERSION, CanonError, canonStr, canonicalBytes, canonicalText, hashHex } from './hashcanon.ts';
export type { AssetDoc, AttributionDoc, ContentDoc, MaterialDoc, RequirementDoc, SourceClaimDoc } from './hashcanon.ts';
