import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { S3Service } from '../upload/s3.service';

export interface SectionResult {
    section: string;
    html: string;
}

interface NodeDefinition {
    name: string;
    systemPrompt: string;
}

const SHARED_RULES = `
CRITICAL OUTPUT RULES:
- Return ONLY the section HTML — no markdown, no code blocks, no explanations
- No <html>, <head>, <body> tags
- Use inline CSS only (inside a <style> tag scoped to this section, or style attributes)
- NEVER use emoji as icons (✅ ❌ 🚀 ⭐ etc.) — forbidden
- ALL icons must be inline SVG only: clean minimal strokes, 24×24 viewBox, stroke="currentColor"

DESIGN STANDARD (2026 modern UI):
- Awwwards-level quality: premium, clean, dynamic, high-converting, emotionally persuasive
- Use light animated gradient backgrounds, glassmorphism cards, subtle floating blurred shapes
- Card hover: lift with transform + box-shadow
- Scroll-triggered reveal: fade + slide using IntersectionObserver
- Only animate transform and opacity (never width/height/margin)
- @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }

MOBILE-FIRST (CRITICAL):
- Use clamp() for all heading font-sizes: e.g. font-size: clamp(22px, 5vw, 48px)
- NEVER use font-size above 28px for h1, 22px for h2, 18px for h3 on mobile (≤ 480px)
- Every flex child MUST have min-width: 0
- Every container: box-sizing: border-box; word-break: break-word; overflow-wrap: break-word
- No horizontal overflow — test mentally at 320px
- touch-action: manipulation on all buttons
`;

const NODES: NodeDefinition[] = [
    {
        name: 'hero',
        systemPrompt: `You are a world-class conversion-focused landing page developer with exceptional design taste.
Generate ONLY the <section id="hero"> HTML block.
${SHARED_RULES}
CONTENT:
- Bold headline using clamp() font-size, emotional subheadline
- Primary CTA button (animated pulse effect, glow on hover) + secondary CTA
- Product image placeholder: width:100%; min-height:300px on mobile, min-height:420px on desktop; object-fit:contain
- Animated gradient or layered background for depth
- Floating decorative blurred shapes for atmosphere
- Sticky-ready padding (account for header height)`,
    },
    {
        name: 'problem',
        systemPrompt: `You are a world-class conversion-focused landing page developer with exceptional design taste.
Generate ONLY the <section id="problem"> HTML block.
${SHARED_RULES}
CONTENT:
- <h2> section heading using clamp()
- 2–3 pain point cards, each with: inline SVG icon (24×24), bold title, 2-sentence emotional copy
- Dark or high-contrast background to signal tension
- Scroll-reveal animation on cards (IntersectionObserver, staggered)
- Glassmorphism card style`,
    },
    {
        name: 'solution',
        systemPrompt: `You are a world-class conversion-focused landing page developer with exceptional design taste.
Generate ONLY the <section id="solution"> HTML block.
${SHARED_RULES}
CONTENT:
- <h2> section heading using clamp()
- How the product solves the stated problems + key differentiator
- 2–3 solution points with inline SVG icons
- Light, positive background contrast (relief after problem section)
- Card hover lift effect
- Scroll-reveal animation`,
    },
    {
        name: 'features',
        systemPrompt: `You are a world-class conversion-focused landing page developer with exceptional design taste.
Generate ONLY the <section id="features"> HTML block.
${SHARED_RULES}
CONTENT:
- <h2> section heading using clamp()
- 3–6 feature cards in a responsive grid, each with: animated inline SVG icon (stroke-dasharray reveal), feature name (<h3>), short description
- Glassmorphism card style with hover lift
- Subtle 3D tilt on cards (JS mousemove)
- Staggered scroll-reveal`,
    },
    {
        name: 'benefits',
        systemPrompt: `You are a world-class conversion-focused landing page developer with exceptional design taste.
Generate ONLY the <section id="benefits"> HTML block.
${SHARED_RULES}
CONTENT:
- <h2> section heading using clamp()
- 3–4 benefit items focusing on outcomes not features
- Each item: inline SVG icon, bold outcome headline, 2-sentence emotional copy
- Alternating or grid layout
- Micro-interactions on hover
- Scroll-reveal with stagger`,
    },
    {
        name: 'social_proof',
        systemPrompt: `You are a world-class conversion-focused landing page developer with exceptional design taste.
Generate ONLY the <section id="social-proof"> HTML block.
${SHARED_RULES}
CONTENT:
- <h2> section heading using clamp()
- 3–4 large stat cards: bold number (e.g. "10,000+"), label, inline SVG icon
- Credibility indicators (trust badges as inline SVG)
- Counter animation (JS: count up on IntersectionObserver)
- Glassmorphism cards with hover lift`,
    },
    {
        name: 'testimonials',
        systemPrompt: `You are a world-class conversion-focused landing page developer with exceptional design taste.
Generate ONLY the <section id="testimonials"> HTML block.
${SHARED_RULES}
TESTIMONIALS (MANDATORY):
- You MUST include minimum 5 realistic customer reviews. Missing testimonials = FAILURE.
- Each review MUST have:
  • Full name (realistic, locale-appropriate)
  • Avatar: colored circle with CSS initials (no images)
  • Star rating: 5 filled inline SVG stars colored gold #FFB800
  • Review text: 2–4 sentences, specific to the product, emotionally persuasive — NO generic phrases
  • Optional: verified buyer badge
- Layout: auto-scrolling slider on desktop (CSS animation or JS), swipeable on mobile
- Testimonials must reference specific product features or results`,
    },
    {
        name: 'logos',
        systemPrompt: `You are a world-class conversion-focused landing page developer with exceptional design taste.
Generate ONLY the <section id="logos"> HTML block.
${SHARED_RULES}
CONTENT:
- <h2> heading "As Seen In" or "Our Partners" using clamp()
- 4–6 brand name boxes styled as grayscale text logos (CSS filter: grayscale; opacity: 0.6, hover full opacity)
- Infinite horizontal marquee/scroll animation on mobile
- Clean minimal background`,
    },
    {
        name: 'pricing',
        systemPrompt: `You are a world-class conversion-focused landing page developer with exceptional design taste.
Generate ONLY the <section id="pricing"> HTML block.
${SHARED_RULES}
CONTENT:
- <h2> section heading using clamp()
- 1–3 pricing cards: price (large clamp font), feature list with inline SVG checkmarks, CTA button
- Highlight recommended plan (scale transform, accent border, "Most Popular" badge)
- Animated CTA pulse on recommended plan
- Card hover lift
- Guarantee badge below cards`,
    },
    {
        name: 'faq',
        systemPrompt: `You are a world-class conversion-focused landing page developer with exceptional design taste.
Generate ONLY the <section id="faq"> HTML block.
${SHARED_RULES}
CONTENT:
- <h2> section heading using clamp()
- 4–6 accordion items: question + answer
- Smooth height animation (JS: max-height transition, not display:none toggle)
- Inline SVG chevron icon that rotates 180° on open
- Only animate max-height and transform (not height — causes layout thrash)
- touch-action: manipulation on accordion triggers`,
    },
    {
        name: 'cta',
        systemPrompt: `You are a world-class conversion-focused landing page developer with exceptional design taste.
Generate ONLY the <section id="cta"> HTML block.
${SHARED_RULES}
CONTENT:
- Bold emotional headline using clamp(), urgency subtext
- Large primary CTA button (min-width:200px, padding≥14px 28px, animated pulse + glow)
- Guarantee badge with inline SVG shield icon
- High-contrast background (gradient or dark) for maximum impact
- Floating decorative blurred shapes for depth`,
    },
    {
        name: 'footer',
        systemPrompt: `You are a world-class conversion-focused landing page developer with exceptional design taste.
Generate ONLY the <footer id="footer"> HTML block.
${SHARED_RULES}
CONTENT:
- Logo text + tagline
- Navigation links (responsive flex/grid)
- Social icons as inline SVG (24×24, hover color transition)
- Copyright notice
- Clean dark or light background contrasting with the page
- Links: touch-action: manipulation`,
    },
];

@Injectable()
export class LangChainService {
    private readonly client: OpenAI;

    constructor(
        private readonly configService: ConfigService,
        private readonly s3Service: S3Service,
    ) {
        this.client = new OpenAI({
            apiKey: this.configService.getOrThrow<string>('OPENAI_API_KEY_LAO'),
            baseURL: this.configService.getOrThrow<string>('LAO_URL'),
        });
    }

    async generateLanding(prompt: string): Promise<{ url: string }> {
        const sectionResults = await Promise.all(
            NODES.map(async (node): Promise<SectionResult> => {
                const response = await this.client.chat.completions.create({
                    model: 'gemini-3.1-pro-preview',
                    messages: [
                        { role: 'system', content: node.systemPrompt },
                        {
                            role: 'user',
                            content: `Product info:\n${prompt}\n\nGenerate the ${node.name} section HTML now.`,
                        },
                    ],
                });

                const html = response.choices[0]?.message?.content ?? '';
                return { section: node.name, html: this.cleanHtml(html) };
            }),
        );

        const html = this.assemblePage(sectionResults, prompt);
        const buffer = Buffer.from(html, 'utf-8');
        const s3Result = await this.s3Service.uploadBuffer(
            buffer,
            'langchain',
            'text/html',
            'html',
        );
        return { url: s3Result.url };
    }

    private cleanHtml(html: string): string {
        return html
            .replace(/```html\n?/gi, '')
            .replace(/```\n?/g, '')
            .trim();
    }

    private assemblePage(sections: SectionResult[], prompt: string): string {
        const title = prompt.split('\n')[0].slice(0, 60) || 'Landing Page';
        const body = sections.map((s) => s.html).join('\n\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, sans-serif; overflow-x: hidden; }
    p, h1, h2, h3, h4, h5, h6 { word-break: break-word; overflow-wrap: break-word; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
    }
}
