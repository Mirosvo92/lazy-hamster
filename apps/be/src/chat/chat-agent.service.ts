import {
    Annotation,
    END,
    MemorySaver,
    START,
    StateGraph,
} from '@langchain/langgraph';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import { Observable, Subject } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../upload/s3.service';
import {
    getProductAnalysisPrompt,
    getQuestionsGenerationPrompt,
    LANDING_SYSTEM_PROMPT,
    MANDATORY_QUESTIONS,
    SECTIONS_TO_GENERATE,
} from './chat-agent.prompts';

// ─── Credits ──────────────────────────────────────────────────────────────────
const MIN_CREDITS: Record<string, number> = {
    chat_analyze: 10,
    chat_questions: 10,
    chat_section: 30,
};

const DEFAULT_USER_ID = 'default-user-001';

// ─── Image specs per section ──────────────────────────────────────────────────
interface SectionImageSpec {
    role: string;
    question: string;
    required: boolean;
}

const SECTION_IMAGE_SPECS: Record<string, SectionImageSpec[]> = {
    hero: [
        {
            role: 'product',
            question:
                'Для Hero секции нужно фото товара. Есть у тебя? Отправь фото или напиши "нет".',
            required: true,
        },
        {
            role: 'background',
            question:
                'Теперь фото для фона Hero. Есть? Отправь или напиши "пропустить".',
            required: false,
        },
    ],
    features: [
        {
            role: 'detail',
            question:
                'Для Features — есть крупный план товара? Отправь или напиши "пропустить".',
            required: false,
        },
    ],
};

// ─── LangGraph State ──────────────────────────────────────────────────────────
const AgentState = Annotation.Root({
    // Session
    userId: Annotation<string>({ reducer: (_, v) => v }),
    locale: Annotation<string>({ reducer: (_, v) => v }),

    // Product
    product: Annotation<{
        brand: string;
        model: string;
        description: string;
    } | null>({
        reducer: (_, v) => v,
    }),
    productImageUrl: Annotation<string | null>({ reducer: (_, v) => v }),

    // Interview
    pendingQuestions: Annotation<{ key: string; text: string }[]>({
        reducer: (_, v) => v,
    }),
    questionIndex: Annotation<number>({ reducer: (_, v) => v }),
    answers: Annotation<{ key: string; question: string; answer: string }[]>({
        reducer: (_, v) => v,
    }),

    // Generation
    currentSectionIndex: Annotation<number>({ reducer: (_, v) => v }),
    pendingImageSpecs: Annotation<SectionImageSpec[]>({ reducer: (_, v) => v }),
    pendingImageIndex: Annotation<number>({ reducer: (_, v) => v }),
    currentSectionImages: Annotation<Record<string, string>>({
        reducer: (_, v) => v,
    }),
    generatedSections: Annotation<{ name: string; html: string }[]>({
        reducer: (_, v) => v,
    }),
    lastGeneratedHtml: Annotation<string>({ reducer: (_, v) => v }),
    landingUrl: Annotation<string | null>({ reducer: (_, v) => v }),

    // Routing
    nextNode: Annotation<string>({ reducer: (_, v) => v }),

    // User input (set before each resume)
    userText: Annotation<string>({ reducer: (_, v) => v }),
    userImageUrl: Annotation<string | null>({ reducer: (_, v) => v }),
});

type AgentStateType = typeof AgentState.State;

// ─── Chat event types ─────────────────────────────────────────────────────────
export type ChatPhase =
    | 'waiting_image'
    | 'analyzing'
    | 'interviewing'
    | 'generating'
    | 'done';

export interface ChatEvent {
    type:
        | 'delta'
        | 'message_end'
        | 'phase'
        | 'section_preview'
        | 'section_done'
        | 'landing_done'
        | 'error'
        | 'input_required'
        | 'quick_replies';
    text?: string;
    phase?: ChatPhase;
    sectionName?: string;
    sectionHtml?: string;
    url?: string;
    message?: string;
    options?: string[];
}

// ─── Language chips (static — no AI needed) ───────────────────────────────────
const LANGUAGE_CHIPS = ['Русский', 'English', 'Українська', 'Polski', 'Türkçe'];

const PLACEHOLDER_RE = /придумай|make.?up|заглушк|placeholder|сгенерир|выдум/i;
const GO_BACK_RE =
    /назад|неправильно|ошиб[сл]|прошл|предыдущ|go.?back|wrong|mistake/i;

// ─── Per-session runtime ──────────────────────────────────────────────────────
interface SessionRuntime {
    threadId: string;
    subject: Subject<MessageEvent>;
    waitingForInput: boolean;
    resolveInput: ((input: { text: string; imageUrl?: string }) => void) | null;
}

// ─── Service ──────────────────────────────────────────────────────────────────
@Injectable()
export class ChatAgentService {
    private readonly client: OpenAI;
    private readonly checkpointer = new MemorySaver();
    private readonly sessions = new Map<string, SessionRuntime>();

    constructor(
        private readonly configService: ConfigService,
        private readonly s3Service: S3Service,
        private readonly prisma: PrismaService,
    ) {
        this.client = new OpenAI({
            apiKey: this.configService.getOrThrow<string>('OPENAI_API_KEY_LAO'),
            baseURL: this.configService.getOrThrow<string>('LAO_URL'),
        });
    }

    // ── Session ───────────────────────────────────────────────────────────────

    createSession(): { sessionId: string } {
        const threadId = randomUUID();
        this.sessions.set(threadId, {
            threadId,
            subject: new Subject<MessageEvent>(),
            waitingForInput: false,
            resolveInput: null,
        });
        return { sessionId: threadId };
    }

    getSessionEvents(sessionId: string): Observable<MessageEvent> {
        return this.getRuntime(sessionId).subject.asObservable();
    }

    // ── Handle incoming message ───────────────────────────────────────────────

    async handleMessage(
        sessionId: string,
        text: string,
        imageFile?: Express.Multer.File,
    ): Promise<void> {
        const runtime = this.getRuntime(sessionId);

        let imageUrl: string | undefined;
        if (imageFile) {
            const s3 = await this.s3Service.uploadBuffer(
                imageFile.buffer,
                'chat',
                imageFile.mimetype,
                'jpg',
            );
            imageUrl = s3.url;
        }

        if (runtime.waitingForInput && runtime.resolveInput) {
            // Resume graph with user input
            runtime.resolveInput({ text, imageUrl });
        } else {
            // First message — start the graph
            void this.runGraph(sessionId, text, imageUrl);
        }
    }

    // ── Graph execution ───────────────────────────────────────────────────────

    private async runGraph(
        sessionId: string,
        firstText: string,
        firstImageUrl?: string,
    ): Promise<void> {
        const runtime = this.getRuntime(sessionId);
        const graph = this.buildGraph(sessionId);

        const initialState: Partial<AgentStateType> = {
            userId: DEFAULT_USER_ID,
            locale: 'ru',
            product: null,
            productImageUrl: firstImageUrl ?? null,
            pendingQuestions: [],
            questionIndex: 0,
            answers: [],
            currentSectionIndex: 0,
            pendingImageSpecs: [],
            pendingImageIndex: 0,
            currentSectionImages: {},
            generatedSections: [],
            lastGeneratedHtml: '',
            landingUrl: null,
            nextNode: firstImageUrl ? 'analyze' : 'wait_for_image',
            userText: firstText,
            userImageUrl: firstImageUrl ?? null,
        };

        try {
            await graph.invoke(initialState, {
                configurable: { thread_id: sessionId },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Ошибка';
            this.emit(runtime, { type: 'error', message });
        }
    }

    // ── Build LangGraph ───────────────────────────────────────────────────────

    private buildGraph(sessionId: string) {
        const runtime = this.getRuntime(sessionId);

        const graph = new StateGraph(AgentState)
            .addNode('wait_for_image', async () => {
                this.emitMessage(
                    runtime,
                    'Привет! Загрузи фото товара чтобы начать.',
                );
                const input = await this.waitForInput(runtime);
                return {
                    userImageUrl: input.imageUrl ?? null,
                    userText: input.text,
                    nextNode: input.imageUrl ? 'analyze' : 'wait_for_image',
                };
            })
            .addNode('analyze', async (state) => {
                return this.nodeAnalyze(state, runtime);
            })
            .addNode('confirm_product', async (state) => {
                return this.nodeConfirmProduct(state, runtime);
            })
            .addNode('interview', async (state) => {
                return this.nodeInterview(state, runtime);
            })
            .addNode('start_section', (state) => {
                return this.nodeStartSection(state, runtime);
            })
            .addNode('request_image', async (state) => {
                return this.nodeRequestImage(state, runtime);
            })
            .addNode('generate_section', async (state) => {
                return this.nodeGenerateSection(state, runtime);
            })
            .addNode('await_approval', async (state) => {
                return this.nodeAwaitApproval(state, runtime);
            })
            .addNode('assemble', async (state) => {
                return this.nodeAssemble(state, runtime);
            })
            .addEdge(START, 'wait_for_image')
            .addConditionalEdges('wait_for_image', (s) => s.nextNode)
            .addEdge('analyze', 'confirm_product')
            .addEdge('confirm_product', 'interview')
            .addConditionalEdges('interview', (s) => s.nextNode)
            .addConditionalEdges('start_section', (s) => s.nextNode)
            .addConditionalEdges('request_image', (s) => s.nextNode)
            .addEdge('generate_section', 'await_approval')
            .addConditionalEdges('await_approval', (s) => s.nextNode)
            .addEdge('assemble', END);

        return graph.compile({ checkpointer: this.checkpointer });
    }

    // ── Nodes ─────────────────────────────────────────────────────────────────

    private async nodeAnalyze(
        state: AgentStateType,
        runtime: SessionRuntime,
    ): Promise<Partial<AgentStateType>> {
        this.emitPhase(runtime, 'analyzing');
        this.emitMessage(runtime, 'Анализирую фото товара...');

        await this.ensureTokens(state.userId, 'chat_analyze');

        const res = await this.client.responses.create({
            model: 'gpt-4.1-mini',
            input: [
                {
                    role: 'system',
                    content: getProductAnalysisPrompt(state.locale),
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'input_image',
                            image_url: state.userImageUrl!,
                            detail: 'auto',
                        },
                        {
                            type: 'input_text',
                            text: 'Identify this product. Give full info.',
                        },
                    ],
                },
            ],
        });

        await this.deductTokens(
            state.userId,
            res.usage?.total_tokens ?? 0,
            'chat_analyze',
            'gpt-4.1-mini',
        );

        let product = { brand: 'Unknown', model: 'Unknown', description: '' };
        try {
            const p = JSON.parse(res.output_text) as {
                brand?: string;
                model?: string;
                description?: string;
            };
            product = {
                brand: p.brand ?? 'Unknown',
                model: p.model ?? 'Unknown',
                description: p.description ?? '',
            };
        } catch {
            product.description = res.output_text;
        }

        // Generate dynamic questions
        await this.ensureTokens(state.userId, 'chat_questions');

        const qRes = await this.client.responses.create({
            model: 'gpt-4.1-mini',
            input: [
                {
                    role: 'system',
                    content: getQuestionsGenerationPrompt(state.locale),
                },
                {
                    role: 'user',
                    content: `Product: ${product.brand} ${product.model}\nDescription: ${product.description}`,
                },
            ],
        });

        await this.deductTokens(
            state.userId,
            qRes.usage?.total_tokens ?? 0,
            'chat_questions',
            'gpt-4.1-mini',
        );

        let dynamicQs: { key: string; text: string }[] = [];
        try {
            const parsed = JSON.parse(qRes.output_text) as Array<{
                id?: string;
                label?: string;
            }>;
            dynamicQs = (Array.isArray(parsed) ? parsed : [])
                .map((q, i) => ({
                    key: q.id ?? `dynamic_${i}`,
                    text: q.label ?? '',
                }))
                .filter((q) => q.text);
        } catch {
            dynamicQs = [];
        }

        this.emitPhase(runtime, 'interviewing');
        this.emitMessage(
            runtime,
            `Вижу это **${product.brand} ${product.model}**.\n${product.description}\n\nЗадам несколько вопросов для лендинга.`,
        );

        return {
            product,
            productImageUrl: state.userImageUrl,
            pendingQuestions: [...dynamicQs, ...MANDATORY_QUESTIONS],
            questionIndex: 0,
        };
    }

    private async nodeConfirmProduct(
        state: AgentStateType,
        runtime: SessionRuntime,
    ): Promise<Partial<AgentStateType>> {
        let product = state.product!;

        while (true) {
            this.emitMessage(
                runtime,
                `Вижу это **${product.brand} ${product.model}**.\n${product.description}\n\nВсё верно?`,
            );
            this.emitOptions(runtime, ['✅ Да, верно', '✏️ Нет, изменить']);

            const input = await this.waitForInput(runtime);
            const text = input.text.trim().toLowerCase();

            if (
                /^(да|yes|верно|ок|ok|✅|correct|right|точно|все верно|всё верно)/i.test(
                    text,
                )
            ) {
                break;
            }

            this.emitMessage(
                runtime,
                'Уточни: что именно не так? Напиши правильное название, бренд или описание.',
            );
            const correction = await this.waitForInput(runtime);
            product = await this.parseProductCorrection(
                correction.text,
                product,
                state.userId,
            );
            this.emitMessage(
                runtime,
                `Обновил: **${product.brand} ${product.model}**.`,
            );
        }

        return { product };
    }

    private async nodeInterview(
        state: AgentStateType,
        runtime: SessionRuntime,
    ): Promise<Partial<AgentStateType>> {
        const answers = [...state.answers];
        let locale = state.locale;
        const MAX_QUESTIONS = 15;

        while (answers.length < MAX_QUESTIONS) {
            // Agent decides what to ask next based on conversation so far
            const decision = await this.decideNextQuestion(
                state.product,
                answers,
                locale,
                state.userId,
            );

            if (decision.action === 'done') break;

            const question = decision.question;
            this.emitMessage(runtime, question);

            const chips = /язык|language/i.test(question)
                ? LANGUAGE_CHIPS
                : await this.generateQuickReplies(
                      question,
                      state.product,
                      locale,
                      state.userId,
                  );
            this.emitOptions(runtime, chips);

            const input = await this.waitForInput(runtime);
            const raw = input.text.trim();

            if (GO_BACK_RE.test(raw) && answers.length > 0) {
                answers.pop();
                this.emitMessage(
                    runtime,
                    'Хорошо, вернёмся к предыдущему вопросу.',
                );
                continue;
            }

            let answer = raw;
            if (PLACEHOLDER_RE.test(raw)) {
                answer = await this.generatePlaceholderAnswer(
                    question,
                    state.product,
                    locale,
                    state.userId,
                );
                this.emitMessage(runtime, `Придумал: _${answer}_`);
            } else {
                const interpreted = await this.interpretInterviewAnswer(
                    question,
                    raw,
                    state.product,
                    locale,
                    state.userId,
                );
                if (interpreted.type === 'clarify') {
                    this.emitMessage(runtime, interpreted.explanation);
                    continue;
                }
                if (interpreted.acknowledgment) {
                    this.emitMessage(runtime, interpreted.acknowledgment);
                }
                answer = interpreted.answer;
            }

            if (/язык|language/i.test(question)) {
                locale = this.detectLocale(answer);
            }

            answers.push({ key: `q_${answers.length}`, question, answer });
        }

        this.emitPhase(runtime, 'generating');
        this.emitMessage(
            runtime,
            'Отлично! Все данные собраны. Начинаем строить лендинг секция за секцией.',
        );

        return {
            answers,
            questionIndex: answers.length,
            locale,
            currentSectionIndex: 0,
            nextNode: 'start_section',
        };
    }

    private nodeStartSection(
        state: AgentStateType,
        runtime: SessionRuntime,
    ): Partial<AgentStateType> {
        if (state.currentSectionIndex >= SECTIONS_TO_GENERATE.length) {
            return { nextNode: 'assemble' };
        }

        const sectionName = SECTIONS_TO_GENERATE[state.currentSectionIndex];
        const imageSpecs = SECTION_IMAGE_SPECS[sectionName] ?? [];

        this.emitMessage(
            runtime,
            `Начинаем секцию **${sectionName}** (${state.currentSectionIndex + 1}/${SECTIONS_TO_GENERATE.length}).`,
        );

        return {
            currentSectionImages: {},
            pendingImageSpecs: imageSpecs,
            pendingImageIndex: 0,
            nextNode:
                imageSpecs.length > 0 ? 'request_image' : 'generate_section',
        };
    }

    private async nodeRequestImage(
        state: AgentStateType,
        runtime: SessionRuntime,
    ): Promise<Partial<AgentStateType>> {
        let { pendingImageIndex, currentSectionImages } = state;
        const { pendingImageSpecs, productImageUrl } = state;

        // Loop through all image requests for this section
        while (pendingImageIndex < pendingImageSpecs.length) {
            const spec = pendingImageSpecs[pendingImageIndex];
            this.emitMessage(runtime, spec.question);

            const input = await this.waitForInput(runtime);
            const skip = /нет|no|пропустить|skip/i.test(input.text ?? '');

            if (input.imageUrl) {
                currentSectionImages = {
                    ...currentSectionImages,
                    [spec.role]: input.imageUrl,
                };
                this.emitMessage(runtime, 'Фото получено!');
            } else if (skip && spec.required && productImageUrl) {
                currentSectionImages = {
                    ...currentSectionImages,
                    [spec.role]: productImageUrl,
                };
                this.emitMessage(runtime, 'Использую фото из анализа товара.');
            } else if (skip) {
                this.emitMessage(runtime, 'Пропускаем.');
            } else {
                // User wrote something unexpected — reply conversationally
                const reply = await this.conversationalReply(
                    input.text,
                    spec.question,
                    state.locale,
                    state.userId,
                );
                this.emitMessage(runtime, reply);
                continue;
            }

            pendingImageIndex++;
        }

        return {
            currentSectionImages,
            pendingImageIndex,
            nextNode: 'generate_section',
        };
    }

    private async nodeGenerateSection(
        state: AgentStateType,
        runtime: SessionRuntime,
    ): Promise<Partial<AgentStateType>> {
        const sectionName = SECTIONS_TO_GENERATE[state.currentSectionIndex];
        this.emitMessage(runtime, `Генерирую **${sectionName}**...`);

        await this.ensureTokens(state.userId, 'chat_section');

        const response = await this.client.chat.completions.create({
            model: 'gpt-4.1-mini',
            messages: [
                {
                    role: 'system',
                    content: `${LANDING_SYSTEM_PROMPT}\n\n---\nIMPORTANT: Generate ONLY the HTML block for the "${sectionName}" section (<section id="${sectionName}"> or <footer>). No <html>, <head>, <body> tags.`,
                },
                { role: 'user', content: this.buildUserContent(state) },
            ],
        });

        await this.deductTokens(
            state.userId,
            (response.usage?.total_tokens as number) ?? 0,
            'chat_section',
            'gpt-4.1-mini',
        );

        const html = (response.choices[0]?.message?.content ?? '')
            .replace(/```html\n?/gi, '')
            .replace(/```\n?/g, '')
            .trim();

        this.emit(runtime, {
            type: 'section_preview',
            sectionName,
            sectionHtml: html,
        });
        this.emitMessage(
            runtime,
            `Секция **${sectionName}** готова! Напиши "ок" чтобы продолжить или скажи что изменить.`,
        );

        return { lastGeneratedHtml: html };
    }

    private async nodeAwaitApproval(
        state: AgentStateType,
        runtime: SessionRuntime,
    ): Promise<Partial<AgentStateType>> {
        const sectionName = SECTIONS_TO_GENERATE[state.currentSectionIndex];

        // loop until user approves or jumps to another section
        while (true) {
            const input = await this.waitForInput(runtime);
            const text = input.text.trim();

            // Check if user wants to jump to another section
            const jumpTo = this.detectSectionJump(text);
            if (jumpTo !== null) {
                this.emitMessage(
                    runtime,
                    `Переходим к секции **${SECTIONS_TO_GENERATE[jumpTo]}**.`,
                );
                return {
                    generatedSections: [
                        ...state.generatedSections,
                        { name: sectionName, html: state.lastGeneratedHtml },
                    ],
                    currentSectionIndex: jumpTo,
                    nextNode: 'start_section',
                };
            }

            const approved =
                /^(ок|ok|да|yes|хорошо|отлично|норм|супер|дальше|👍)/i.test(
                    text,
                );

            if (approved) {
                this.emit(runtime, { type: 'section_done', sectionName });
                return {
                    generatedSections: [
                        ...state.generatedSections,
                        { name: sectionName, html: state.lastGeneratedHtml },
                    ],
                    currentSectionIndex: state.currentSectionIndex + 1,
                    nextNode: 'start_section',
                };
            }

            // Regenerate with feedback
            this.emitMessage(runtime, `Переделываю с учётом: "${text}"`);
            await this.ensureTokens(state.userId, 'chat_section');

            const response = await this.client.chat.completions.create({
                model: 'gpt-4.1-mini',
                messages: [
                    {
                        role: 'system',
                        content: `${LANDING_SYSTEM_PROMPT}\n\n---\nIMPORTANT: Generate ONLY the HTML block for the "${sectionName}" section. No <html>, <head>, <body> tags.`,
                    },
                    { role: 'user', content: this.buildUserContent(state) },
                    { role: 'assistant', content: state.lastGeneratedHtml },
                    {
                        role: 'user',
                        content: `Update based on this feedback: ${text}`,
                    },
                ],
            });

            await this.deductTokens(
                state.userId,
                (response.usage?.total_tokens as number) ?? 0,
                'chat_section',
                'gpt-4.1-mini',
            );

            const html = (response.choices[0]?.message?.content ?? '')
                .replace(/```html\n?/gi, '')
                .replace(/```\n?/g, '')
                .trim();

            // Update state inline for next iteration
            state = { ...state, lastGeneratedHtml: html };

            this.emit(runtime, {
                type: 'section_preview',
                sectionName,
                sectionHtml: html,
            });
            this.emitMessage(
                runtime,
                `Обновил! "ок" чтобы продолжить или скажи что ещё изменить.`,
            );
        }
    }

    private async nodeAssemble(
        state: AgentStateType,
        runtime: SessionRuntime,
    ): Promise<Partial<AgentStateType>> {
        this.emitMessage(
            runtime,
            'Все секции готовы! Собираю финальный лендинг...',
        );

        const html = this.assemblePage(
            state.generatedSections.map((s) => s.html),
            state.product?.model ?? 'Landing',
            state.locale,
        );

        const buffer = Buffer.from(html, 'utf-8');
        const s3 = await this.s3Service.uploadBuffer(
            buffer,
            'chat',
            'text/html',
            'html',
        );

        this.emitPhase(runtime, 'done');
        this.emit(runtime, { type: 'landing_done', url: s3.url });
        this.emitMessage(runtime, `Лендинг готов! ${s3.url}`);

        return { landingUrl: s3.url };
    }

    // ── AI helpers ────────────────────────────────────────────────────────────

    private async decideNextQuestion(
        product: { brand: string; model: string; description: string },
        answers: { question: string; answer: string }[],
        locale: string,
        userId: string,
    ): Promise<{ action: 'ask'; question: string } | { action: 'done' }> {
        await this.ensureTokens(userId, 'chat_questions');

        const answeredSummary = answers
            .map((a, i) => `${i + 1}. Q: ${a.question}\n   A: ${a.answer}`)
            .join('\n');

        const res = await this.client.responses.create({
            model: 'gpt-4.1-mini',
            input: [
                {
                    role: 'system',
                    content: `You are a landing page specialist interviewing a seller to gather info for their product page.
Product: ${product.brand} ${product.model} — ${product.description}

To generate a great landing page you need:
- Price and any discounts / promotions
- Delivery options and terms
- Payment methods accepted
- Warranty / guarantees
- Contact info (phone, email, messengers)
- Social media links
- Target audience and key benefits (if not obvious from product)
- Preferred language for the landing page

${answers.length > 0 ? `Already gathered (${answers.length} answers):\n${answeredSummary}` : 'No answers yet.'}

Decide what to ask next:
- Ask ONE specific, conversational question tailored to this product and the answers already given
- If an answer revealed something interesting, follow up on it
- Don't re-ask what's already covered
- Return { "action": "done" } ONLY when all key areas above are covered
- Ask the question in: ${locale}

Return ONLY valid JSON: {"action": "ask", "question": "..."} or {"action": "done"}`,
                },
            ],
        });

        await this.deductTokens(
            userId,
            res.usage?.total_tokens ?? 0,
            'chat_questions',
            'gpt-4.1-mini',
        );

        try {
            return JSON.parse(res.output_text) as
                | { action: 'ask'; question: string }
                | { action: 'done' };
        } catch {
            return { action: 'done' };
        }
    }

    private async generateQuickReplies(
        question: string,
        product: { brand: string; model: string; description: string },
        locale: string,
        userId: string,
    ): Promise<string[]> {
        await this.ensureTokens(userId, 'chat_questions');
        const res = await this.client.responses.create({
            model: 'gpt-4.1-mini',
            input: [
                {
                    role: 'system',
                    content: `You are helping create quick reply chips for a landing page questionnaire.
Product: ${product.brand} ${product.model} — ${product.description}
Language: ${locale}

Generate 3-5 short, realistic answer options for the question.
Rules:
- Options must be specific and relevant to THIS product
- Keep each option short (2-5 words)
- Always include "Придумай за меня" as the last option
- Include a "no/skip" option if the question is about optional features
Return ONLY a JSON array of strings, e.g. ["Option 1", "Option 2", "Option 3"]`,
                },
                { role: 'user', content: question },
            ],
        });
        await this.deductTokens(
            userId,
            res.usage?.total_tokens ?? 0,
            'chat_questions',
            'gpt-4.1-mini',
        );
        try {
            const parsed = JSON.parse(res.output_text) as unknown;
            if (Array.isArray(parsed)) return parsed as string[];
        } catch {
            // fallback
        }
        return ['Придумай за меня'];
    }

    private async interpretInterviewAnswer(
        question: string,
        userMessage: string,
        product: { brand: string; model: string; description: string },
        locale: string,
        userId: string,
    ): Promise<
        | { type: 'answer'; answer: string; acknowledgment: string | null }
        | { type: 'clarify'; explanation: string }
    > {
        await this.ensureTokens(userId, 'chat_questions');
        const res = await this.client.responses.create({
            model: 'gpt-4.1-mini',
            input: [
                {
                    role: 'system',
                    content: `You are a landing page assistant filling a questionnaire. Language: ${locale}.
Question asked: "${question}"
Product: ${product.brand} ${product.model} — ${product.description}

Classify the user's reply and return JSON:

If the user is asking for clarification or doesn't understand the question:
{ "type": "clarify", "explanation": "<clear, friendly explanation of what the question means and what kind of answer is expected, 1-2 sentences>" }

If the user gave an answer (even partial or with extra info):
{
  "type": "answer",
  "answer": "<clean answer to the question>",
  "acknowledgment": "<one short warm sentence acknowledging specific details they mentioned, or null if plain yes/no>"
}

Return ONLY valid JSON, no markdown.`,
                },
                { role: 'user', content: userMessage },
            ],
        });
        await this.deductTokens(
            userId,
            res.usage?.total_tokens ?? 0,
            'chat_questions',
            'gpt-4.1-mini',
        );
        try {
            return JSON.parse(res.output_text) as
                | {
                      type: 'answer';
                      answer: string;
                      acknowledgment: string | null;
                  }
                | { type: 'clarify'; explanation: string };
        } catch {
            return {
                type: 'answer',
                answer: userMessage,
                acknowledgment: null,
            };
        }
    }

    private async conversationalReply(
        userMessage: string,
        currentQuestion: string,
        locale: string,
        userId: string,
    ): Promise<string> {
        await this.ensureTokens(userId, 'chat_questions');
        const res = await this.client.responses.create({
            model: 'gpt-4.1-mini',
            input: [
                {
                    role: 'system',
                    content: `You are a friendly landing page creation assistant speaking in ${locale}.
The user is being asked: "${currentQuestion}"
They replied with something unexpected.
- Answer their question/comment naturally and helpfully.
- Then gently guide them back to what is needed (photo or skip).
- Keep it short (2-3 sentences max).
- Do NOT generate images, just explain options.`,
                },
                { role: 'user', content: userMessage },
            ],
        });
        await this.deductTokens(
            userId,
            res.usage?.total_tokens ?? 0,
            'chat_questions',
            'gpt-4.1-mini',
        );
        return res.output_text.trim();
    }

    private async generatePlaceholderAnswer(
        question: string,
        product: { brand: string; model: string; description: string },
        locale: string,
        userId: string,
    ): Promise<string> {
        await this.ensureTokens(userId, 'chat_questions');
        const res = await this.client.responses.create({
            model: 'gpt-4.1-mini',
            input: [
                {
                    role: 'system',
                    content: `Generate a short, realistic answer to the question for this product. 1-2 sentences max. Language: ${locale}. Return only the answer, no explanations.`,
                },
                {
                    role: 'user',
                    content: `Product: ${product.brand} ${product.model}\nDescription: ${product.description}\nQuestion: ${question}`,
                },
            ],
        });
        await this.deductTokens(
            userId,
            res.usage?.total_tokens ?? 0,
            'chat_questions',
            'gpt-4.1-mini',
        );
        return res.output_text.trim();
    }

    private async parseProductCorrection(
        correctionText: string,
        current: { brand: string; model: string; description: string },
        userId: string,
    ): Promise<{ brand: string; model: string; description: string }> {
        await this.ensureTokens(userId, 'chat_questions');
        const res = await this.client.responses.create({
            model: 'gpt-4.1-mini',
            input: [
                {
                    role: 'system',
                    content: `Extract product info from the user correction. Return JSON: {"brand":"...","model":"...","description":"..."}. If a field is not mentioned, keep the current value.`,
                },
                {
                    role: 'user',
                    content: `Current: ${JSON.stringify(current)}\nUser correction: ${correctionText}`,
                },
            ],
        });
        await this.deductTokens(
            userId,
            res.usage?.total_tokens ?? 0,
            'chat_questions',
            'gpt-4.1-mini',
        );
        try {
            return JSON.parse(res.output_text) as typeof current;
        } catch {
            return { ...current, description: correctionText };
        }
    }

    // ── Wait for user input ───────────────────────────────────────────────────

    private waitForInput(
        runtime: SessionRuntime,
    ): Promise<{ text: string; imageUrl?: string }> {
        this.emit(runtime, { type: 'input_required' });
        return new Promise((resolve) => {
            runtime.waitingForInput = true;
            runtime.resolveInput = (input) => {
                runtime.waitingForInput = false;
                runtime.resolveInput = null;
                resolve(input);
            };
        });
    }

    handleMessageByUrl(
        sessionId: string,
        text: string,
        imageUrl?: string,
    ): void {
        const runtime = this.getRuntime(sessionId);
        if (runtime.waitingForInput && runtime.resolveInput) {
            runtime.resolveInput({ text, imageUrl });
        } else {
            void this.runGraph(sessionId, text, imageUrl);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private detectSectionJump(text: string): number | null {
        const lower = text.toLowerCase();
        for (let i = 0; i < SECTIONS_TO_GENERATE.length; i++) {
            if (lower.includes(SECTIONS_TO_GENERATE[i])) return i;
        }
        return null;
    }

    private buildUserContent(state: AgentStateType): string {
        const { product, answers, productImageUrl, currentSectionImages } =
            state;

        const imageLines = Object.entries(currentSectionImages).map(
            ([role, url]) => `${role} image URL: ${url}`,
        );
        if (productImageUrl && !currentSectionImages['product']) {
            imageLines.push(`product image URL: ${productImageUrl}`);
        }

        return [
            `Product: ${product?.brand ?? ''} ${product?.model ?? ''}`,
            `Description: ${product?.description ?? ''}`,
            ...imageLines,
            '',
            '--- SELLER DATA — USE ALL OF THE FOLLOWING (MANDATORY) ---',
            ...answers.map((a) => `${a.question ?? a.key}: ${a.answer}`),
            '',
            '--- LANGUAGE (MANDATORY) ---',
            `Write every word on the page in: ${state.locale}`,
        ]
            .filter(Boolean)
            .join('\n');
    }

    private assemblePage(
        sections: string[],
        title: string,
        locale = 'ru',
    ): string {
        const langMap: Record<string, string> = {
            ru: 'ru',
            uk: 'uk',
            en: 'en',
            pl: 'pl',
            tr: 'tr',
            es: 'es',
            de: 'de',
            fr: 'fr',
        };
        const lang = langMap[locale] ?? 'en';
        return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title.slice(0, 60)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, sans-serif; overflow-x: hidden; }
    p, h1, h2, h3, h4, h5, h6 { word-break: break-word; overflow-wrap: break-word; }
  </style>
</head>
<body>
${sections.join('\n\n')}
</body>
</html>`;
    }

    private detectLocale(answer: string): string {
        const a = answer.toLowerCase();
        if (a.includes('русск') || a.includes('russian')) return 'ru';
        if (a.includes('укр') || a.includes('ukrainian')) return 'uk';
        if (a.includes('english') || a.includes('англ')) return 'en';
        if (a.includes('polski') || a.includes('польск')) return 'pl';
        if (a.includes('türkçe') || a.includes('турецк')) return 'tr';
        return 'ru';
    }

    // ── Token management ──────────────────────────────────────────────────────

    private async ensureTokens(userId: string, action: string): Promise<void> {
        const required = MIN_CREDITS[action] ?? 10;
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { tokenBalance: true },
        });
        if (!user || user.tokenBalance < required) {
            throw new HttpException(
                `Insufficient credits. Required: ${required}, available: ${user?.tokenBalance ?? 0}`,
                HttpStatus.PAYMENT_REQUIRED,
            );
        }
    }

    private async deductTokens(
        userId: string,
        tokens: number,
        action: string,
        model = '',
    ): Promise<void> {
        const minCredits = MIN_CREDITS[action] ?? 10;
        const credits = tokens > 0 ? Math.ceil(tokens / 100) : minCredits;
        const actualTokens = tokens > 0 ? tokens : minCredits * 100;
        await this.prisma.$transaction([
            this.prisma.user.update({
                where: { id: userId },
                data: { tokenBalance: { decrement: credits } },
            }),
            this.prisma.tokenUsage.create({
                data: { userId, tokens: actualTokens, action, model },
            }),
        ]);
    }

    // ── Emitters ──────────────────────────────────────────────────────────────

    private emitMessage(runtime: SessionRuntime, text: string): void {
        this.emit(runtime, { type: 'delta', text });
        this.emit(runtime, { type: 'message_end' });
    }

    private emitPhase(runtime: SessionRuntime, phase: ChatPhase): void {
        this.emit(runtime, { type: 'phase', phase });
    }

    private emitOptions(runtime: SessionRuntime, options: string[]): void {
        this.emit(runtime, { type: 'quick_replies', options });
    }

    private emit(runtime: SessionRuntime, event: ChatEvent): void {
        runtime.subject.next({ data: JSON.stringify(event) } as MessageEvent);
    }

    private getRuntime(sessionId: string): SessionRuntime {
        const runtime = this.sessions.get(sessionId);
        if (!runtime)
            throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
        return runtime;
    }
}
