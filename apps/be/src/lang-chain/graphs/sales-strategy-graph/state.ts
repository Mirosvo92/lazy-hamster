import { BaseMessage } from '@langchain/core/messages';
import { Annotation } from '@langchain/langgraph';

export type SalesStrategyResult = unknown; //TODO create zod schema for structured ai output;

// Keep messages in state for graph, to allow conversation, but only final result will be propagated.
export const SalesStrategyGraphState = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
        reducer: (x, y) => x.concat(y),
        default: () => [],
    }),
    result: Annotation<SalesStrategyResult>(),
});
