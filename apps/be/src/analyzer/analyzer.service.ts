import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../upload/s3.service';
import {
    getImagePromptsGenerationPrompt,
    getLandingPromptGenerationSystem,
    getProductAnalysisPrompt,
    getQuestionsGenerationPrompt,
    LANDING_SYSTEM_PROMPT,
} from './prompts';

// Balances are stored in credits (1 credit = 100 OpenAI tokens)
const MIN_CREDITS_PER_ACTION: Record<string, number> = {
    analyze: 10,
    generate_questions: 20,
    generate_image_prompts: 20,
    generate_image: 50,
    generate_landing_prompt: 100,
    generate_landing: 300,
};

export interface Question {
    id: string;
    label: string;
    type:
        | 'chips'
        | 'chips_with_input'
        | 'select'
        | 'textarea'
        | 'number'
        | 'text';
    required: boolean;
    placeholder?: string;
    suggestions?: string[];
    options?: string[];
    defaultValue?: string | number;
    singleSelect?: boolean; // For chips type: if true, only one option can be selected
}

@Injectable()
export class AnalyzerService {
    private readonly client: OpenAI;

    constructor(
        private readonly configService: ConfigService,
        private readonly s3Service: S3Service,
        private readonly prisma: PrismaService,
    ) {
        console.log(
            '1',
            this.configService.getOrThrow<string>('OPENAI_API_KEY_LAO'),
        );
        console.log('2', this.configService.getOrThrow<string>('LAO_URL'));
        this.client = new OpenAI({
            apiKey: this.configService.getOrThrow<string>('OPENAI_API_KEY_LAO'),
            baseURL: this.configService.getOrThrow<string>('LAO_URL'),
        });
    }

    async analyze(
        imageUrl: string,
        locale: string,
        userId = 'default-user-001',
    ): Promise<{ brand: string; model: string; description: string }> {
        await this.ensureTokens(userId, 'analyze');
        const response = await this.client.responses.create({
            model: 'gpt-4.1-mini',
            input: [
                {
                    role: 'system',
                    content: getProductAnalysisPrompt(locale),
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'input_image',
                            image_url: imageUrl,
                            detail: 'auto',
                        },
                        {
                            type: 'input_text',
                            text: 'Identify this product. Give full info about this product',
                        },
                    ],
                },
            ],
        });

        await this.deductTokens(userId, response.usage?.total_tokens ?? 0, 'analyze', 'gpt-4.1-mini');

        const text = response.output_text;

        try {
            const parsed = JSON.parse(text);
            return {
                brand: parsed.brand ?? 'Unknown',
                model: parsed.model ?? 'Unknown',
                description: parsed.description ?? '',
            };
        } catch {
            return { brand: 'Unknown', model: 'Unknown', description: text };
        }
    }

    async generateQuestions(
        brand: string,
        model: string,
        description: string,
        locale: string,
        userId = 'default-user-001',
    ): Promise<Question[]> {
        await this.ensureTokens(userId, 'generate_questions');
        const response = await this.client.responses.create({
            model: 'gpt-4.1-mini',
            input: [
                {
                    role: 'system',
                    content: getQuestionsGenerationPrompt(locale),
                },
                {
                    role: 'user',
                    content: `Product: ${brand} ${model}\nDescription: ${description}`,
                },
            ],
        });

        await this.deductTokens(userId, response.usage?.total_tokens ?? 0, 'generate_questions', 'gpt-4.1-mini');

        const text = response.output_text;

        let aiQuestions: Question[] = [];
        try {
            const parsed: unknown = JSON.parse(text);
            aiQuestions = Array.isArray(parsed) ? (parsed as Question[]) : [];
        } catch {
            // keep empty
        }

        return [...aiQuestions, ...this.getFixedQuestions(locale)];
    }

    async generateImagePrompts(
        brand: string,
        model: string,
        description: string,
        userId = 'default-user-001',
    ): Promise<string[]> {
        await this.ensureTokens(userId, 'generate_image_prompts');
        const response = await this.client.responses.create({
            model: 'gpt-4.1-mini',
            input: [
                {
                    role: 'system',
                    content: getImagePromptsGenerationPrompt(),
                },
                {
                    role: 'user',
                    content: `Product: ${brand} ${model}\nDescription: ${description}`,
                },
            ],
        });

        await this.deductTokens(userId, response.usage?.total_tokens ?? 0, 'generate_image_prompts', 'gpt-4.1-mini');

        try {
            const parsed: unknown = JSON.parse(response.output_text);
            return Array.isArray(parsed)
                ? (parsed as string[]).slice(0, 4)
                : [];
        } catch {
            return [];
        }
    }

    async saveImageGenerationState(
        projectId: string,
        imagePrompts: string[],
        sourceImageUrl: string,
        analysisData: string,
        formAnswers: string,
    ): Promise<void> {
        await this.prisma.project.update({
            where: { id: projectId },
            data: {
                imagePrompts: JSON.stringify(imagePrompts),
                sourceImageUrl,
                analysisData,
                formAnswers,
            },
        });
    }

    async startImageGeneration(projectId: string, userId: string): Promise<void> {
        await this.prisma.project.update({
            where: { id: projectId },
            data: { imageGenerationStatus: 'generating' },
        });
        void this.runImageGeneration(projectId, userId);
    }

    private async runImageGeneration(projectId: string, userId: string): Promise<void> {
        try {
            const project = await this.prisma.project.findUniqueOrThrow({
                where: { id: projectId },
                include: { images: { orderBy: { createdAt: 'asc' } } },
            });

            const imagePrompts: string[] = project.imagePrompts
                ? (JSON.parse(project.imagePrompts) as string[])
                : [];
            const sourceImageUrl = project.sourceImageUrl;

            if (!imagePrompts.length || !sourceImageUrl) {
                await this.prisma.project.update({
                    where: { id: projectId },
                    data: { imageGenerationStatus: 'failed' },
                });
                return;
            }

            const startIndex = project.images.length;

            for (let i = startIndex; i < imagePrompts.length; i++) {
                await this.generateSingleProductImage(imagePrompts[i], sourceImageUrl, userId, projectId);
            }

            await this.prisma.project.update({
                where: { id: projectId },
                data: { imageGenerationStatus: 'completed' },
            });
        } catch (err) {
            console.error('Image generation failed', err);
            await this.prisma.project
                .update({
                    where: { id: projectId },
                    data: { imageGenerationStatus: 'failed' },
                })
                .catch(() => null);
        }
    }

    async getImageGenerationStatus(
        projectId: string,
    ): Promise<{ status: string; images: { url: string; prompt: string }[] }> {
        const project = await this.prisma.project.findUnique({
            where: { id: projectId },
            select: {
                imageGenerationStatus: true,
                images: { orderBy: { createdAt: 'asc' }, select: { url: true, prompt: true } },
            },
        });
        if (!project) return { status: 'not_found', images: [] };
        return {
            status: project.imageGenerationStatus,
            images: project.images.map((img) => ({ url: img.url, prompt: img.prompt ?? '' })),
        };
    }

    async generateSingleProductImage(
        prompt: string,
        sourceImageUrl: string,
        userId: string,
        projectId: string,
    ): Promise<{ url: string; prompt: string } | null> {
        await this.ensureTokens(userId, 'generate_image');

        const response: any = await this.client.chat.completions.create({
            model: this.configService.getOrThrow<string>('IMAGE_MODEL'),
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text:
                                'Important! Use only those elements that are present in the image, as these images are for selling the product and must not contain fake information.\n' +
                                'The image must comply with OpenAI usage policies: no violence, no nudity, no hate symbols, no harmful or illegal content, no misleading information.\n' +
                                'Do not include any brand names, product names, logos, or trademarks in the image.\n' +
                                prompt +
                                '\n【1:1】',
                        },
                        {
                            type: 'image_url',
                            image_url: { url: sourceImageUrl },
                        },
                    ],
                },
            ],
        });

        await this.deductTokens(
            userId,
            response?.usage?.total_tokens ?? 0,
            'generate_image',
            this.configService.get<string>('IMAGE_MODEL', ''),
        );

        const content: string = response?.choices?.[0]?.message?.content ?? '';

        let cdnUrl: string | null = null;

        const base64Match = content.match(
            /data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/,
        );
        if (base64Match) cdnUrl = base64Match[0];

        if (!cdnUrl) {
            const markdownMatch = content.match(
                /!\[.*?\]\((https?:\/\/[^)]+)\)/,
            );
            if (markdownMatch) cdnUrl = markdownMatch[1];
        }

        if (!cdnUrl) {
            const urlMatch = content.match(/https?:\/\/[^\s)]+/);
            if (urlMatch) cdnUrl = urlMatch[0];
        }

        if (!cdnUrl) return null;

        const imgResponse = await fetch(cdnUrl);
        const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());
        const webpBuffer = await sharp(imgBuffer)
            .webp({ quality: 85 })
            .toBuffer();

        let imageSlug: string | undefined;
        try {
            const project = await this.prisma.project.findUnique({
                where: { id: projectId },
                select: {
                    analysisData: true,
                    images: { select: { s3Key: true } },
                },
            });
            const analysis = JSON.parse(project?.analysisData ?? '{}') as {
                brand?: string;
                model?: string;
                description?: string;
            };
            const nameSource = [analysis.brand?.trim(), analysis.model?.trim()]
                .filter(Boolean)
                .join(' ') || analysis.description?.trim().split(/\s+/).slice(0, 3).join(' ') || '';
            const base = nameSource
                .toLowerCase()
                .replace(/[^a-z0-9а-яёіїє]+/gi, '-')
                .replace(/^-+|-+$/g, '');
            if (base) {
                const taken = new Set(project!.images.map((i) => i.s3Key));
                let index = project!.images.length + 1;
                let candidate = `lp/${userId}/${base}-${index}.webp`;
                while (taken.has(candidate)) {
                    index++;
                    candidate = `lp/${userId}/${base}-${index}.webp`;
                }
                imageSlug = `${base}-${index}`;
            }
        } catch {
            // fallback to uuid
        }

        const s3Result = await this.s3Service.uploadBuffer(
            webpBuffer,
            userId,
            'image/webp',
            'webp',
            imageSlug,
        );

        await this.prisma.generatedImage.create({
            data: {
                userId,
                projectId,
                url: s3Result.url,
                s3Key: s3Result.key,
                prompt,
            },
        });

        return { url: s3Result.url, prompt };
    }

    async generateLandingPrompt(
        analysis: { brand: string; model: string; description: string },
        formAnswers: Record<string, unknown>,
        generatedImageUrls: [string, string, string, string],
        userId = 'default-user-001',
        projectId?: string,
    ): Promise<{ landingPrompt: string }> {
        await this.ensureTokens(userId, 'generate_landing_prompt');
        let sellerData = '';
        if (Object.keys(formAnswers).length > 0) {
            sellerData = '\n\n--- ДАННЫЕ ОТ ПРОДАВЦА ---\n';
            for (const [key, value] of Object.entries(formAnswers)) {
                if (
                    value &&
                    (typeof value !== 'object' ||
                        (Array.isArray(value) && value.length > 0) ||
                        Object.keys(value).length > 0)
                ) {
                    const displayValue = Array.isArray(value)
                        ? value.join(', ')
                        : typeof value === 'object'
                          ? Object.entries(value as Record<string, string>)
                                .map(([k, v]) => `${k}: ${v}`)
                                .join(', ')
                          : String(value);
                    sellerData += `${key}: ${displayValue}\n`;
                }
            }
        }

        const productText = `Brand: ${analysis.brand}\nModel: ${analysis.model}\nDescription: ${analysis.description}`;

        const promptResponse = await this.client.responses.create({
            model: 'gpt-4.1-mini',
            input: [
                {
                    role: 'system',
                    content:
                        getLandingPromptGenerationSystem(generatedImageUrls),
                },
                {
                    role: 'user',
                    content: `Product: ${productText}\n\nSeller data: ${sellerData}`,
                },
            ],
        });

        await this.deductTokens(
            userId,
            promptResponse.usage?.total_tokens ?? 0,
            'generate_landing_prompt',
            'gpt-4.1-mini',
        );

        if (projectId) {
            await this.prisma.project.update({
                where: { id: projectId },
                data: { landingPrompt: promptResponse.output_text },
            });
        }

        return { landingPrompt: promptResponse.output_text };
    }

    async generateProductImages(
        imagePrompts: string[],
        sourceImageUrl: string,
        userId: string,
        projectId: string,
    ): Promise<{ url: string; prompt: string }[]> {
        await this.ensureTokens(userId, 'generate_image');

        // Download source image from S3
        const imageResponse = await fetch(sourceImageUrl);
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        const file = await toFile(imageBuffer, 'source.png', {
            type: 'image/png',
        });
        void file; // retained for potential future use with images.edit

        const results: { url: string; prompt: string }[] = [];

        for (const prompt of imagePrompts) {
            const response: any = await this.client.chat.completions.create({
                // model: 'gemini-3-pro-image-preview',
                model: this.configService.getOrThrow<string>('IMAGE_MODEL'),
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text:
                                    'Important! Use only those elements that are present in the image, as these images are for selling the product and must not contain fake information.\n' +
                                    'The image must comply with OpenAI usage policies: no violence, no nudity, no hate symbols, no harmful or illegal content, no misleading information.\n' +
                                    prompt +
                                    '\n【1:1】',
                            },
                            {
                                type: 'image_url',
                                image_url: { url: sourceImageUrl },
                            },
                        ],
                    },
                ],
            });

            await this.deductTokens(
                userId,
                response?.usage?.total_tokens ?? 0,
                'generate_image',
                this.configService.get<string>('IMAGE_MODEL', ''),
            );

            const content: string =
                response?.choices?.[0]?.message?.content ?? '';

            // Try to extract image URL from response (base64, markdown, or plain URL)
            let cdnUrl: string | null = null;

            // base64 inline
            const base64Match = content.match(
                /data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/,
            );
            if (base64Match) {
                cdnUrl = base64Match[0];
            }

            // markdown format: ![image](URL)
            if (!cdnUrl) {
                const markdownMatch = content.match(
                    /!\[.*?\]\((https?:\/\/[^)]+)\)/,
                );
                if (markdownMatch) cdnUrl = markdownMatch[1];
            }

            // plain URL
            if (!cdnUrl) {
                const urlMatch = content.match(/https?:\/\/[^\s)]+/);
                if (urlMatch) cdnUrl = urlMatch[0];
            }

            if (cdnUrl) {
                const imgResponse = await fetch(cdnUrl);
                const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());

                // Convert to WebP for better compression
                const webpBuffer = await sharp(imgBuffer)
                    .webp({ quality: 85 })
                    .toBuffer();

                const s3Result = await this.s3Service.uploadBuffer(
                    webpBuffer,
                    userId,
                    'image/webp',
                    'webp',
                );

                await this.prisma.generatedImage.create({
                    data: {
                        userId,
                        projectId,
                        url: s3Result.url,
                        s3Key: s3Result.key,
                        prompt,
                    },
                });

                results.push({ url: s3Result.url, prompt });
            }
        }

        return results;
    }

    private languageToLocale(language: string): string {
        const languageMap: Record<string, string> = {
            Русский: 'ru',
            Українська: 'uk',
            English: 'en',
            Polski: 'pl',
            Türkçe: 'tr',
            Español: 'es',
            Deutsch: 'de',
            Français: 'fr',
            Italiano: 'it',
            Português: 'pt',
            العربية: 'ar',
            中文: 'zh',
            日本語: 'ja',
            한국어: 'ko',
        };
        return languageMap[language] || language;
    }

    private getFixedQuestions(locale: string): Question[] {
        const t = this.getFixedLabels(locale);
        const lang = locale.toLowerCase().split('-')[0];

        // Map locale to language display name
        const defaultLanguage =
            lang === 'ru'
                ? 'Русский'
                : lang === 'uk'
                  ? 'Українська'
                  : lang === 'pl'
                    ? 'Polski'
                    : lang === 'tr'
                      ? 'Türkçe'
                      : lang === 'es'
                        ? 'Español'
                        : lang === 'de'
                          ? 'Deutsch'
                          : lang === 'fr'
                            ? 'Français'
                            : lang === 'it'
                              ? 'Italiano'
                              : lang === 'pt'
                                ? 'Português'
                                : lang === 'ar'
                                  ? 'العربية'
                                  : lang === 'zh'
                                    ? '中文'
                                    : lang === 'ja'
                                      ? '日本語'
                                      : lang === 'ko'
                                        ? '한국어'
                                        : 'English';

        // Map locale to default currency
        const defaultCurrency =
            lang === 'ru'
                ? 'RUB'
                : lang === 'uk'
                  ? 'UAH'
                  : lang === 'pl'
                    ? 'PLN'
                    : lang === 'tr'
                      ? 'TRY'
                      : lang === 'es'
                        ? 'EUR'
                        : lang === 'de'
                          ? 'EUR'
                          : lang === 'fr'
                            ? 'EUR'
                            : lang === 'it'
                              ? 'EUR'
                              : lang === 'pt'
                                ? 'EUR'
                                : lang === 'ar'
                                  ? 'USD'
                                  : lang === 'zh'
                                    ? 'CNY'
                                    : lang === 'ja'
                                      ? 'JPY'
                                      : lang === 'ko'
                                        ? 'KRW'
                                        : 'USD';

        return [
            {
                id: 'lp_language',
                label: t.lpLanguageLabel,
                type: 'chips',
                required: true,
                singleSelect: true,
                suggestions: [
                    'Русский',
                    'Українська',
                    'English',
                    'Polski',
                    'Türkçe',
                    'Español',
                    'Deutsch',
                    'Français',
                    'Italiano',
                    'Português',
                    'العربية',
                    '中文',
                    '日本語',
                    '한국어',
                ],
                defaultValue: defaultLanguage,
            },
            {
                id: 'price',
                label: t.priceLabel,
                type: 'number',
                required: true,
                placeholder: t.pricePlaceholder,
            },
            {
                id: 'currency',
                label: t.currencyLabel,
                type: 'chips',
                required: true,
                singleSelect: true,
                suggestions: [
                    'USD',
                    'EUR',
                    'GBP',
                    'UAH',
                    'RUB',
                    'PLN',
                    'TRY',
                    'JPY',
                    'CNY',
                    'KRW',
                ],
                defaultValue: defaultCurrency,
            },
            {
                id: 'delivery',
                label: t.deliveryLabel,
                type: 'chips',
                required: true,
                suggestions: t.deliverySuggestions,
            },
            {
                id: 'extra_info',
                label: t.extraInfoLabel,
                type: 'text',
                required: false,
                placeholder: t.extraInfoPlaceholder,
            },
            {
                id: 'warranty',
                label: t.warrantyLabel,
                type: 'text',
                required: true,
                placeholder: t.warrantyPlaceholder,
            },
            {
                id: 'returns',
                label: t.returnsLabel,
                type: 'text',
                required: true,
                placeholder: t.returnsPlaceholder,
            },
            {
                id: 'sales_hooks',
                label: t.salesHooksLabel,
                type: 'chips_with_input',
                required: false,
                suggestions: t.salesHooksSuggestions,
            },
            {
                id: 'social_links',
                label: t.socialLinksLabel,
                type: 'chips_with_input',
                required: true,
                suggestions: [
                    'Instagram',
                    'Telegram',
                    'Facebook',
                    'TikTok',
                    'WhatsApp',
                    'Viber',
                ],
            },
        ];
    }

    private getFixedLabels(locale: string) {
        const lang = locale.toLowerCase().split('-')[0];

        if (lang === 'ru') {
            return {
                lpLanguageLabel: 'Язык лендинга',
                priceLabel: 'Цена с скидкой',
                pricePlaceholder: 'Введите цену со скидкой',
                currencyLabel: 'Валюта',
                deliveryLabel: 'Способы доставки',
                deliverySuggestions: [
                    'Почта',
                    'Курьер',
                    'Самовывоз',
                    'Новая Почта',
                ],
                extraInfoLabel: 'Доп. информация о товаре',
                extraInfoPlaceholder: 'Введите дополнительную информацию',
                warrantyLabel: 'Гарантия',
                warrantyPlaceholder: 'Например: 12 месяцев',
                returnsLabel: 'Возврат',
                returnsPlaceholder: 'Например: 14 дней',
                salesHooksLabel: 'Хуки продаж',
                salesHooksSuggestions: [
                    'Скидка',
                    'Счётчик',
                    'Товар заканчивается',
                    'Бесплатная доставка',
                    'Подарок к заказу',
                ],
                socialLinksLabel: 'Ссылки на соцсети',
            };
        }

        if (lang === 'uk') {
            return {
                lpLanguageLabel: 'Мова лендінгу',
                priceLabel: 'Ціна зі знижкою',
                pricePlaceholder: 'Введіть ціну зі знижкою',
                currencyLabel: 'Валюта',
                deliveryLabel: 'Способи доставки',
                deliverySuggestions: [
                    'Пошта',
                    "Кур'єр",
                    'Самовивіз',
                    'Нова Пошта',
                ],
                extraInfoLabel: 'Додаткова інформація про товар',
                extraInfoPlaceholder: 'Введіть додаткову інформацію',
                warrantyLabel: 'Гарантія',
                warrantyPlaceholder: 'Наприклад: 12 місяців',
                returnsLabel: 'Повернення',
                returnsPlaceholder: 'Наприклад: 14 днів',
                salesHooksLabel: 'Хуки продажів',
                salesHooksSuggestions: [
                    'Знижка',
                    'Лічильник',
                    'Товар закінчується',
                    'Безкоштовна доставка',
                    'Подарунок до замовлення',
                ],
                socialLinksLabel: 'Посилання на соцмережі',
            };
        }

        return {
            lpLanguageLabel: 'Landing page language',
            priceLabel: 'Discounted price',
            pricePlaceholder: 'Enter discounted price',
            currencyLabel: 'Currency',
            deliveryLabel: 'Delivery methods',
            deliverySuggestions: ['Mail', 'Courier', 'Pickup', 'Express'],
            extraInfoLabel: 'Additional product info',
            extraInfoPlaceholder: 'Enter additional information',
            warrantyLabel: 'Warranty',
            warrantyPlaceholder: 'e.g. 12 months',
            returnsLabel: 'Returns',
            returnsPlaceholder: 'e.g. 14 days',
            salesHooksLabel: 'Sales hooks',
            salesHooksSuggestions: [
                'Discount',
                'Countdown',
                'Low stock',
                'Free shipping',
                'Gift with order',
            ],
            socialLinksLabel: 'Social media links',
        };
    }

    private buildLandingUserContent(
        landingPrompt: string,
        imageUrls: [string, string, string, string],
        landingId: string,
        productDescription?: string,
        sellerData?: string,
        addCookies?: boolean,
    ): string {
        const apiBase = this.configService.getOrThrow<string>('API_BASE_URL');
        const formEndpoint = `${apiBase}/api/analyze/orders/${landingId}`;

        // Try to extract assets from the JSON strategy for explicit placement instructions
        let assetUsageSection = '';
        try {
            const strategy = JSON.parse(landingPrompt) as Record<
                string,
                unknown
            >;
            const assets = strategy.assets as
                | Record<
                      string,
                      {
                          url: string;
                          role: string;
                          purpose: string;
                          'text-image'?: string;
                      }
                  >
                | undefined;
            if (assets) {
                assetUsageSection = '\n\n--- ASSET USAGE INSTRUCTIONS ---\n';
                for (const [key, asset] of Object.entries(assets)) {
                    assetUsageSection += `\n[${key}]\n  url: ${asset.url}\n  role: ${asset.role}\n  purpose: ${asset.purpose}`;
                    if (asset['text-image']) {
                        assetUsageSection += `\n  text-image overlay: ${asset['text-image']} — render as a styled HTML/CSS promo badge overlaid on this image`;
                    }
                }
            }
        } catch {
            // fallback: use plain image URLs
            assetUsageSection = `\n\n--- IMAGES ---\nProduct photo (main): ${imageUrls[0]}\nLifestyle photo: ${imageUrls[1]}\nDetail/close-up photo: ${imageUrls[2]}\nHero background photo: ${imageUrls[3]}`;
        }

        // Parse sellerData into a key-value map for explicit per-field instructions
        const sellerFields: Record<string, string> = {};
        if (sellerData) {
            for (const line of sellerData.split('\n')) {
                const colonIdx = line.indexOf(':');
                if (colonIdx > 0) {
                    const key = line.slice(0, colonIdx).trim();
                    const val = line.slice(colonIdx + 1).trim();
                    if (key && val) sellerFields[key] = val;
                }
            }
        }

        // Language section — must appear first so AI sees it immediately
        let languageSection = '';
        const lang = sellerFields['lp_language'];
        if (lang) {
            languageSection = `\n\n--- LANGUAGE (MANDATORY) ---\nALL text on the landing page MUST be written ONLY in: ${lang}\nThis is non-negotiable — every word, label, button, placeholder, testimonial, and tooltip must be in ${lang}.\nDo NOT use any other language anywhere on the page.`;
        }

        const currencyCode = sellerFields['currency'] ?? '';
        const priceDisplay =
            `${sellerFields['price'] ?? ''} ${currencyCode}`.trim();

        // Config: how each seller field should be used in the landing page.
        const FIELD_USAGE: Record<string, string> = {
            price: `Display as "${priceDisplay}" prominently in the hero section and on every CTA button. Write the currency name in the landing page language (e.g. Ukrainian → "гривень", Russian → "рублей", English → "dollars"). If a sales hook includes a discount, show a strikethrough "original" price alongside it.`,
            currency: `Use together with the price. Write the currency name in the landing page language, not as a code.`,
            delivery: `Create a dedicated delivery section with an SVG icon for each option listed.`,
            warranty: `Display in the trust badges / guarantees section with a shield SVG icon.`,
            returns: `Display in the trust badges / guarantees section alongside warranty.`,
            sales_hooks: `Implement EVERY hook listed. Interpret each one: countdown/timer/счётчик/лічильник → live JS countdown timer near CTA; low stock/заканчивается/закінчується → "Only X left" badge + progress bar; discount/скидк/знижк → discount badge + strikethrough original price; free shipping/бесплатная доставка/безкоштовна → free shipping banner; gift/подарок/подарунок → gift badge near CTA. For any other hook, add it prominently on the page.`,
            social_links: `Add to the footer as clickable links with inline SVG icons for each platform. Use the value as href if it looks like a URL, otherwise use "#" as placeholder.`,
            extra_info: `Incorporate into the benefits / features section.`,
            legal_information: `Add to the footer as a collapsible section or small text block labeled "Legal Information". Use the exact text provided.`,
            privacy_policy: `Add to the footer as a link or collapsible "Privacy Policy" section. Use the exact text provided.`,
            contact_us: `Add a "Contact Us" section in the footer with the provided details (phone, email, address, hours). Use appropriate SVG icons for each contact type.`,
        };

        const skipFields = new Set(['lp_language']);
        const sellerInstructions: string[] = [];

        for (const [key, value] of Object.entries(sellerFields)) {
            if (skipFields.has(key)) continue;
            const usage =
                FIELD_USAGE[key] ??
                `Include this information visibly on the landing page.`;
            sellerInstructions.push(`${key}: "${value}"\n  → ${usage}`);
        }

        const sellerUsageSection =
            sellerInstructions.length > 0
                ? `\n\n--- SELLER DATA — USE ALL OF THE FOLLOWING (MANDATORY) ---\nEvery item below MUST appear in the landing page. Do not skip any.\n\n${sellerInstructions.join('\n\n')}`
                : '';

        const cookieSection = addCookies
            ? `\n\n--- COOKIE CONSENT (MANDATORY) ---\nAdd a cookie consent banner as a small popup fixed at the bottom of the page.\nRequirements:\n- Position: fixed bottom-left or bottom-center, small (max 360px wide), non-intrusive\n- Contains: short GDPR-compliant text (1–2 lines), "Accept" and "Decline" buttons\n- On Accept: hide the banner, set a cookie "cookie_consent=accepted" (365 days)\n- On Decline: hide the banner, set a cookie "cookie_consent=declined" (365 days)\n- On page load: if cookie is already set, do NOT show the banner\n- Style: matches page theme, subtle shadow, rounded corners, backdrop or solid background\n- Text language must match the landing page language`
            : '';

        return [
            landingPrompt,
            languageSection,
            assetUsageSection,
            productDescription
                ? `\n\n--- PRODUCT DESCRIPTION ---\n${productDescription}`
                : '',
            sellerUsageSection,
            cookieSection,
            `\n\n--- FORM SUBMISSION ---\nThe form must send a POST request to: ${formEndpoint}\nRequest body (JSON): { "name": <string>, "email": <string>, "phone": <string> }\nUse these exact input name attributes: name="name", name="email", name="phone"\nDo NOT write the fetch/submit JS — it will be injected separately.`,
        ]
            .filter(Boolean)
            .join('');
    }

    private injectOrderScript(html: string, landingId: string): string {
        const apiBase = this.configService.getOrThrow<string>('API_BASE_URL');
        const endpoint = `${apiBase}/api/analyze/orders/${landingId}`;
        const script = `<script>
(function () {
  var ENDPOINT = '${endpoint}';
  var lang = ((document.documentElement.lang || navigator.language || 'en').slice(0, 2)).toLowerCase();
  var i18n = {
    success: { ru: '✅ Заявка отправлена! Мы свяжемся с вами.', uk: '✅ Заявку надіслано! Ми зв\u2019яжемося з вами.', en: '✅ Your request has been sent! We will contact you.', de: '✅ Ihre Anfrage wurde gesendet! Wir melden uns.', fr: '✅ Votre demande a \u00e9t\u00e9 envoy\u00e9e\u00a0! Nous vous contacterons.', es: '✅ \u00a1Solicitud enviada! Nos pondremos en contacto.', pl: '✅ Zg\u0142oszenie wys\u0142ane! Skontaktujemy si\u0119 z Tob\u0105.', tr: '✅ Talebiniz g\u00f6nderildi! Sizinle ileti\u015fime ge\u00e7ece\u011fiz.' },
    error:   { ru: '\u041e\u0448\u0438\u0431\u043a\u0430 \u043f\u0440\u0438 \u043e\u0442\u043f\u0440\u0430\u0432\u043a\u0435. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u0435\u0449\u0451 \u0440\u0430\u0437.', uk: '\u041f\u043e\u043c\u0438\u043b\u043a\u0430. \u0421\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u0449\u0435 \u0440\u0430\u0437.', en: 'Submission error. Please try again.', de: 'Fehler beim Senden. Bitte versuchen Sie es erneut.', fr: 'Erreur d\u2019envoi. Veuillez r\u00e9essayer.', es: 'Error al enviar. Por favor, int\u00e9ntelo de nuevo.', pl: 'B\u0142\u0105d wysy\u0142ania. Spr\u00f3buj ponownie.', tr: 'G\u00f6nderme hatas\u0131. L\u00fctfen tekrar deneyin.' },
  };
  var successMsg = i18n.success[lang] || i18n.success['en'];
  var errorMsg   = i18n.error[lang]   || i18n.error['en'];

  function handleSubmit(form, e) {
    e.preventDefault();
    e.stopPropagation();
    var nameInput  = form.querySelector('input[name="name"], input[type="text"]');
    var emailInput = form.querySelector('input[name="email"], input[type="email"]');
    var phoneInput = form.querySelector('input[name="phone"], input[type="tel"]');
    var name  = nameInput  ? nameInput.value.trim()  : '';
    var email = emailInput ? emailInput.value.trim() : '';
    var phone = phoneInput ? phoneInput.value.trim() : '';
    var btn = form.querySelector('button[type="submit"], button');
    if (btn) btn.disabled = true;
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, phone: phone }),
    })
      .then(function () {
        form.innerHTML = '<p style="text-align:center;padding:2rem;font-size:1.2rem;color:inherit">' + successMsg + '</p>';
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        alert(errorMsg);
      });
    return false;
  }

  function setupForms() {
    var forms = document.querySelectorAll('form');
    forms.forEach(function (form) {
      form.removeAttribute('action');
      form.setAttribute('action', 'javascript:void(0)');
      form.submit = function () {};
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        e.stopImmediatePropagation();
        handleSubmit(form, e);
      }, true);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupForms);
  } else {
    setupForms();
  }
})();
</script>`;
        const idx = html.lastIndexOf('</body>');
        if (idx !== -1) return html.slice(0, idx) + script + html.slice(idx);
        return html + script;
    }

    async startLandingGeneration(
        landingPrompt: string,
        imageUrls: [string, string, string, string],
        userId: string,
        projectId: string,
        productDescription?: string,
        sellerData?: string,
        customScripts?: string,
        addCookies?: boolean,
    ): Promise<{ landingId: string }> {
        await this.ensureTokens(userId, 'generate_landing');

        const landing = await this.prisma.landing.create({
            data: {
                userId,
                projectId,
                prompt: landingPrompt,
                status: 'generating',
            },
        });

        void this.runLandingGeneration(
            landing.id,
            landingPrompt,
            imageUrls,
            userId,
            productDescription,
            sellerData,
            customScripts,
            addCookies,
        );

        return { landingId: landing.id };
    }

    private async runLandingGeneration(
        landingId: string,
        landingPrompt: string,
        imageUrls: [string, string, string, string],
        userId: string,
        productDescription?: string,
        sellerData?: string,
        customScripts?: string,
        addCookies?: boolean,
    ): Promise<void> {
        try {
            // Check if cancelled before starting
            const current = await this.prisma.landing.findUnique({
                where: { id: landingId },
                include: { project: { select: { analysisData: true } } },
            });
            if (current?.status === 'cancelled') return;

            let landingSlug: string | undefined;
            try {
                const analysis = JSON.parse(
                    current?.project?.analysisData ?? '{}',
                ) as {
                    brand?: string;
                    model?: string;
                    description?: string;
                };
                const nameSource = [analysis.brand?.trim(), analysis.model?.trim()]
                    .filter(Boolean)
                    .join(' ') || analysis.description?.trim().split(/\s+/).slice(0, 3).join(' ') || '';
                const base = nameSource
                    .toLowerCase()
                    .replace(/[^a-z0-9а-яёіїє]+/gi, '-')
                    .replace(/^-+|-+$/g, '');
                if (base) {
                    // Find unique slug by checking existing s3Keys for this user
                    const existingKeys = await this.prisma.landing.findMany({
                        where: {
                            userId,
                            s3Key: { contains: `lp/${userId}/${base}` },
                        },
                        select: { s3Key: true },
                    });
                    const taken = new Set(existingKeys.map((l) => l.s3Key));
                    let candidate = `lp/${userId}/${base}.html`;
                    let counter = 2;
                    while (taken.has(candidate)) {
                        candidate = `lp/${userId}/${base}-${counter}.html`;
                        counter++;
                    }
                    landingSlug = candidate
                        .replace(`lp/${userId}/`, '')
                        .replace('.html', '');
                }
            } catch {
                // fallback to uuid
            }

            const userContent = this.buildLandingUserContent(
                landingPrompt,
                imageUrls,
                landingSlug ?? landingId,
                productDescription,
                sellerData,
                addCookies,
            );

            const response: any = await this.client.chat.completions.create({
                model: this.configService.getOrThrow<string>('CODER_MODEL'),
                messages: [
                    { role: 'system', content: LANDING_SYSTEM_PROMPT },
                    { role: 'user', content: userContent },
                ],
                max_tokens: 26000,
                stream: false,
            });
            console.log('response', response);
            console.log('response', response?.usage);
            console.log('response', response);

            await this.deductTokens(
                userId,
                (response?.usage?.total_tokens as number) ?? 0,
                'generate_landing',
                this.configService.getOrThrow<string>('CODER_MODEL'),
            );

            if (response.choices?.[0]?.finish_reason === 'length') {
                console.warn(
                    '⚠️ Response was truncated due to max_tokens limit!',
                );
            }

            // Check if cancelled while AI was generating
            const afterAi = await this.prisma.landing.findUnique({
                where: { id: landingId },
            });
            if (afterAi?.status === 'cancelled') return;

            let html: string = response.choices?.[0]?.message?.content ?? '';
            html = html
                .replace(/^```html\s*/i, '')
                .replace(/^```\s*/i, '')
                .replace(/```\s*$/i, '')
                .trim();

            html = this.injectOrderScript(html, landingSlug ?? landingId);

            if (customScripts?.trim()) {
                html = html.replace(
                    '</head>',
                    `${customScripts.trim()}\n</head>`,
                );
            }

            const buffer = Buffer.from(html, 'utf-8');
            const s3Result = await this.s3Service.uploadBuffer(
                buffer,
                userId,
                'text/html',
                'html',
                landingSlug,
            );

            await this.prisma.landing.update({
                where: { id: landingId },
                data: {
                    url: s3Result.url,
                    s3Key: s3Result.key,
                    status: 'completed',
                },
            });
        } catch (err) {
            console.error('Landing generation failed', err);
            await this.prisma.landing
                .update({
                    where: { id: landingId },
                    data: { status: 'failed' },
                })
                .catch(() => null);
        }
    }

    async getLandingStatus(
        landingId: string,
    ): Promise<{ status: string; url?: string }> {
        const landing = await this.prisma.landing.findUnique({
            where: { id: landingId },
            select: { status: true, url: true },
        });
        if (!landing) return { status: 'not_found' };
        return { status: landing.status, url: landing.url || undefined };
    }

    async cancelLanding(landingId: string): Promise<void> {
        await this.prisma.landing.update({
            where: { id: landingId },
            data: { status: 'cancelled' },
        });
    }

    private async ensureTokens(userId: string, action: string): Promise<void> {
        const required = MIN_CREDITS_PER_ACTION[action] ?? 10;
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
        const minCredits = MIN_CREDITS_PER_ACTION[action] ?? 10;
        // If API didn't return usage — fall back to minimum for this action
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
}
