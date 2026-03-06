import { StateGraph } from '@langchain/langgraph';
import { audienceUnderstandingNode } from './nodes/audience-understanding';
import { productUnderstandingNode } from './nodes/product-understanding';
import { salesStrategyNode } from './nodes/sales-strategy';
import { LandingPageBuilderGraphState } from './state';

export const landingPageBuilderGraph = new StateGraph(
    LandingPageBuilderGraphState,
)
    .addNode('productUnderstanding', productUnderstandingNode)
    .addNode('audienceUnderstanding', audienceUnderstandingNode)
    .addNode('salesStrategyNode', salesStrategyNode);
