import { Annotation } from '@langchain/langgraph';
import { AudiencePersonalizationResult } from '../audience-personalization-graph';
import { ProductUnderstandingResult } from '../product-understanding-graph';
import { SalesStrategyResult } from '../sales-strategy-graph';

export type LandingPageBuilderGraphStateType =
    typeof LandingPageBuilderGraphState;

export const LandingPageBuilderGraphState = Annotation.Root({
    productUnderstandingResult: Annotation<ProductUnderstandingResult>(),
    audiencePersonalizationResult: Annotation<AudiencePersonalizationResult>(),
    salesStrategyResult: Annotation<SalesStrategyResult>(),
});
