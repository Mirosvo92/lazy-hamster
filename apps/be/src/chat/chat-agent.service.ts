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
        | 'input_required';
    text?: string;
    phase?: ChatPhase;
    sectionName?: string;
    sectionHtml?: string;
    url?: string;
    message?: string;
}

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
            .addEdge('analyze', 'interview')
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

    private async nodeInterview(
        state: AgentStateType,
        runtime: SessionRuntime,
    ): Promise<Partial<AgentStateType>> {
        const answers = [...state.answers];
        let { questionIndex, locale } = state;
        const { pendingQuestions } = state;

        // Loop through all questions
        while (questionIndex < pendingQuestions.length) {
            const q = pendingQuestions[questionIndex];
            const progress = `(${questionIndex + 1}/${pendingQuestions.length})`;
            this.emitMessage(runtime, `${progress} ${q.text}`);

            const input = await this.waitForInput(runtime);
            const answer = input.text.trim();

            answers.push({ key: q.key, question: q.text, answer });

            if (q.key === 'language') {
                locale = this.detectLocale(answer);
            }

            questionIndex++;
        }

        this.emitPhase(runtime, 'generating');
        this.emitMessage(
            runtime,
            'Все данные собраны! Начинаем строить лендинг секция за секцией.',
        );

        return {
            answers,
            questionIndex,
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
                // Re-ask
                this.emitMessage(
                    runtime,
                    `Отправь фото или напиши "пропустить".`,
                );
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

    async handleMessageByUrl(
        sessionId: string,
        text: string,
        imageUrl?: string,
    ): Promise<void> {
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
            ...answers.map((a) => `${a.key}: ${a.answer}`),
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
