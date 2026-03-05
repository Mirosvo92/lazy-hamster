// Re-export existing prompts so the chat service uses the same ones as analyzer
export {
    getProductAnalysisPrompt,
    getQuestionsGenerationPrompt,
    LANDING_SYSTEM_PROMPT,
} from '../analyzer/prompts';

export const DYNAMIC_QUESTIONS_SYSTEM_PROMPT = `You are a conversion copywriter and product specialist.
Based on the product info, generate 4–6 specific follow-up questions to gather details needed for a high-converting landing page.
Focus on: unique features, target audience, key benefits, problem it solves, differentiators vs competitors.
Return ONLY a JSON array of question strings. No markdown, no extra text.`;

export const MANDATORY_QUESTIONS: { key: string; text: string }[] = [
    { key: 'price', text: 'Какая цена товара? Укажи сумму и валюту.' },
    { key: 'discount', text: 'Есть ли скидка или акция? Если да, укажи размер.' },
    { key: 'delivery', text: 'Есть ли доставка? Какие условия и сроки?' },
    { key: 'payment', text: 'Какие способы оплаты принимаете?' },
    { key: 'warranty', text: 'Есть ли гарантия на товар? Если да — срок и условия.' },
    { key: 'contacts', text: 'Как с вами связаться? (телефон, email, мессенджеры)' },
    { key: 'socials', text: 'Есть ли страницы в соцсетях? (Instagram, TikTok, Facebook и др.) Дай ссылки.' },
    { key: 'language', text: 'На каком языке делаем лендинг? (например: русский, english, українська)' },
];

export const SECTIONS_TO_GENERATE = [
    'hero',
    'problem',
    'solution',
    'features',
    'benefits',
    'testimonials',
    'pricing',
    'faq',
    'cta',
    'footer',
];
