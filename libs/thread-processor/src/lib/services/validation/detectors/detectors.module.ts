import { Module } from "@nestjs/common";
import { ResolutionModule } from "@ebike-backend/resolution";
import { ISSUE_DETECTORS } from "../../../interfaces/issue-detector.interface";
import { IdentificationQualityDetector } from "./identification-quality.detector";
import { QuoteDuplicateDetector } from "./quote-duplicate.detector";
import { QuoteVerbatimDetector } from "./quote-verbatim.detector";
import { ResolutionQualityDetector } from "./resolution-quality.detector";
import { IssueResolver } from "../issue-resolver";

const DETECTOR_PROVIDERS = [
  IdentificationQualityDetector,
  QuoteDuplicateDetector,
  QuoteVerbatimDetector,
  ResolutionQualityDetector,
];

@Module({
  imports: [ResolutionModule],
  providers: [
    ...DETECTOR_PROVIDERS,
    IssueResolver,
    {
      provide: ISSUE_DETECTORS,
      useFactory: (
        identificationQuality: IdentificationQualityDetector,
        quoteDuplicate: QuoteDuplicateDetector,
        quoteVerbatim: QuoteVerbatimDetector,
        resolutionQuality: ResolutionQualityDetector,
      ) => [
        identificationQuality,
        quoteDuplicate,
        quoteVerbatim,
        resolutionQuality,
      ],
      inject: [
        IdentificationQualityDetector,
        QuoteDuplicateDetector,
        QuoteVerbatimDetector,
        ResolutionQualityDetector,
      ],
    },
  ],
  exports: [...DETECTOR_PROVIDERS, IssueResolver, ISSUE_DETECTORS],
})
export class IssueDetectorsModule {}
