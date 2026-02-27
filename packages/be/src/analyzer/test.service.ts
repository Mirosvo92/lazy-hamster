import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';
import { S3Service } from '../upload/s3.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  LANDING_STREAM_SYSTEM_PROMPT,
  LANDING_SYSTEM_PROMPT,
  UX_ARCHITECT_SYSTEM_PROMPT,
} from './prompts';

@Injectable()
export class TestService {
  private readonly client: OpenAI;

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

  private buildOrderScript(landingId: string): string {
    const apiBase = this.configService.getOrThrow<string>('API_BASE_URL');
    const endpoint = `${apiBase}/api/analyze/orders/${landingId}`;
    return `<script>
(function () {
  var ENDPOINT = '${endpoint}';
  var form = document.querySelector('form');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var nameInput = form.querySelector('input[name="name"], input[type="text"]');
    var emailInput = form.querySelector('input[name="email"], input[type="email"]');
    var phoneInput = form.querySelector('input[name="phone"], input[type="tel"]');
    var name = nameInput ? nameInput.value.trim() : '';
    var email = emailInput ? emailInput.value.trim() : '';
    var phone = phoneInput ? phoneInput.value.trim() : '';
    var lang = ((document.documentElement.lang || navigator.language || 'en').slice(0, 2)).toLowerCase();
    var i18n = {
      success: { ru: '✅ Заявка отправлена! Мы свяжемся с вами.', uk: '✅ Заявку надіслано! Ми зв\u0027яжемося з вами.', en: '✅ Your request has been sent! We will contact you.', de: '✅ Ihre Anfrage wurde gesendet! Wir melden uns.', fr: '✅ Votre demande a \u00e9t\u00e9 envoy\u00e9e\u00a0! Nous vous contacterons.', es: '✅ \u00a1Solicitud enviada! Nos pondremos en contacto.', pl: '✅ Zg\u0142oszenie wys\u0142ane! Skontaktujemy si\u0119 z Tob\u0105.', tr: '✅ Talebiniz g\u00f6nderildi! Sizinle ileti\u015fime ge\u00e7ece\u011fiz.' },
      error:   { ru: '\u041e\u0448\u0438\u0431\u043a\u0430 \u043f\u0440\u0438 \u043e\u0442\u043f\u0440\u0430\u0432\u043a\u0435. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u0435\u0449\u0451 \u0440\u0430\u0437.', uk: '\u041f\u043e\u043c\u0438\u043b\u043a\u0430. \u0421\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u0449\u0435 \u0440\u0430\u0437.', en: 'Submission error. Please try again.', de: 'Fehler beim Senden. Bitte versuchen Sie es erneut.', fr: 'Erreur d\u0027envoi. Veuillez r\u00e9essayer.', es: 'Error al enviar. Por favor, int\u00e9ntelo de nuevo.', pl: 'B\u0142\u0105d wysy\u0142ania. Spr\u00f3buj ponownie.', tr: 'G\u00f6nderme hatas\u0131. L\u00fctfen tekrar deneyin.' },
    };
    var successMsg = i18n.success[lang] || i18n.success['en'];
    var errorMsg   = i18n.error[lang]   || i18n.error['en'];
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
  });
})();
</script>`;
  }

  private injectOrderScript(html: string, landingId: string): string {
    const script = this.buildOrderScript(landingId);
    const idx = html.lastIndexOf('</body>');
    if (idx !== -1) return html.slice(0, idx) + script + html.slice(idx);
    return html + script;
  }

  async submitOrder(
    landingId: string,
    name: string,
    email: string,
    phone: string,
  ): Promise<{ ok: boolean }> {
    const landing = await this.prisma.landing.findUnique({
      where: { id: landingId },
    });
    if (!landing) throw new NotFoundException('Landing not found');

    await this.prisma.order.create({
      data: { landingId, userId: landing.userId, name, email, phone },
    });

    return { ok: true };
  }

  async testImageGeneration(
    model: string,
    imageUrl: string,
    prompt: string,
    aspectRatio?: string,
  ): Promise<string> {
    // Add aspect ratio to prompt if provided (format: 【3:2】)
    const fullPrompt = aspectRatio ? `${prompt}\n【${aspectRatio}】` : prompt;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await this.client.chat.completions.create({
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: fullPrompt,
            },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
              },
            },
          ],
        },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const content: string = response.choices?.[0]?.message?.content ?? '';

    // base64 inline
    const base64Match = content.match(
      /data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/,
    );
    if (base64Match) return base64Match[0];

    // markdown format: ![image](URL)
    const markdownMatch = content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
    if (markdownMatch) return markdownMatch[1];

    // plain URL
    const urlMatch = content.match(/https?:\/\/[^\s)]+/);
    if (urlMatch) return urlMatch[0];

    return content;
  }

  async generateImages(
    imagePrompts: string[],
    sourceImageUrl: string,
    userId: string,
  ): Promise<{ url: string; prompt: string }[]> {
    // Download source image from S3
    const imageResponse = await fetch(sourceImageUrl);
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    const file = await toFile(imageBuffer, 'source.png', { type: 'image/png' });
    void file; // retained for potential future use with images.edit

    const results: { url: string; prompt: string }[] = [];

    for (const prompt of imagePrompts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response: any = await this.client.chat.completions.create({
        model: 'gemini-3-pro-image-preview',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Important! Use only those elements that are present in the image, as these images are for selling the product and must not contain fake information.\n' +
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

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const content: string = response?.choices?.[0]?.message?.content ?? '';

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
        const markdownMatch = content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
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
            projectId: 'default-project-001',
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

  private buildUserContent(
    landingPrompt: string,
    imageUrls: [string, string, string, string],
    landingId: string,
    productDescription?: string,
    sellerData?: string,
  ): string {
    const apiBase = this.configService.getOrThrow<string>('API_BASE_URL');
    const formEndpoint = `${apiBase}/api/analyze/orders/${landingId}`;
    return [
      landingPrompt,
      `\n\n--- IMAGES ---\nProduct photo (main): ${imageUrls[0]}\nLifestyle photo: ${imageUrls[1]}\nDetail/close-up photo: ${imageUrls[2]}\nHero background photo: ${imageUrls[3]}`,
      productDescription
        ? `\n\n--- PRODUCT DESCRIPTION ---\n${productDescription}`
        : '',
      sellerData ? `\n\n--- SELLER DATA ---\n${sellerData}` : '',
      `\n\n--- FORM SUBMISSION ---\nThe form must send a POST request to: ${formEndpoint}\nRequest body (JSON): { "name": <string>, "email": <string>, "phone": <string> }\nUse these exact input name attributes: name="name", name="email", name="phone"\nDo NOT write the fetch/submit JS — it will be injected separately.`,
    ]
      .filter(Boolean)
      .join('');
  }

  async generateLandingStream(
    landingPrompt: string,
    imageUrls: [string, string, string, string],
    userId: string,
    onDelta: (delta: string) => void,
    productDescription?: string,
    sellerData?: string,
  ): Promise<{ url: string }> {
    const landing = await this.prisma.landing.create({
      data: { userId, projectId: 'default-project-001' },
    });

    const userContent = this.buildUserContent(
      landingPrompt,
      imageUrls,
      landing.id,
      productDescription,
      sellerData,
    );

    const stream = await this.client.chat.completions.create({
      model: 'claude-opus-4-6',
      messages: [
        {
          role: 'system',
          content: LANDING_STREAM_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: userContent,
        },
      ],
      max_tokens: 16000,
      stream: true,
    });

    let html = '';
    for await (const chunk of stream) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const deltaObj = chunk.choices?.[0]?.delta as Record<string, unknown>;
      const delta: string =
        (deltaObj?.content as string) ??
        (deltaObj?.reasoning_content as string) ??
        '';
      console.log('delta', delta);
      if (delta) {
        html += delta;
        onDelta(delta);
      }
    }

    html = html
      .replace(/^```html\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    html = this.injectOrderScript(html, landing.id);

    const buffer = Buffer.from(html, 'utf-8');
    const s3Result = await this.s3Service.uploadBuffer(
      buffer,
      userId,
      'text/html',
      'html',
    );

    await this.prisma.landing.update({
      where: { id: landing.id },
      data: { url: s3Result.url, s3Key: s3Result.key },
    });

    return { url: s3Result.url };
  }

  async generateLanding(
    landingPrompt: string,
    imageUrls: [string, string, string, string],
    userId: string,
    productDescription?: string,
    sellerData?: string,
  ): Promise<{ url: string }> {
    const landing = await this.prisma.landing.create({
      data: { userId, projectId: 'default-project-001' },
    });

    const userContent = this.buildUserContent(
      landingPrompt,
      imageUrls,
      landing.id,
      productDescription,
      sellerData,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await this.client.chat.completions.create({
      model: 'gemini-3.1-pro-preview',
      messages: [
        {
          role: 'system',
          content: LANDING_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: userContent,
        },
      ],
      max_tokens: 26000,
      stream: false,
    });

    console.log('response', response);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    console.log('finish_reason:', response.choices?.[0]?.finish_reason);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    let html: string = response.choices?.[0]?.message?.content ?? '';

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (response.choices?.[0]?.finish_reason === 'length') {
      console.warn('⚠️ Response was truncated due to max_tokens limit!');
    }

    html = html
      .replace(/^```html\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    html = this.injectOrderScript(html, landing.id);

    const buffer = Buffer.from(html, 'utf-8');
    const s3Result = await this.s3Service.uploadBuffer(
      buffer,
      userId,
      'text/html',
      'html',
    );

    await this.prisma.landing.update({
      where: { id: landing.id },
      data: { url: s3Result.url, s3Key: s3Result.key },
    });

    return { url: s3Result.url };
  }

  async generateUxArchitect(
    briefText: string,
  ): Promise<{ architecture: string }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await this.client.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'system',
          content: UX_ARCHITECT_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: briefText,
        },
      ],
      stream: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    let architecture: string = response.choices?.[0]?.message?.content ?? '';

    // Strip markdown code fences if model wrapped the response
    architecture = architecture
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    return { architecture };
  }

  async resizeImage(
    imageUrl: string,
    size: '1080x1080' | '1080x1920' | '1920x1080',
  ): Promise<{ dataUrl: string }> {
    const aspectRatioMap: Record<string, string> = {
      '1080x1080': '1:1',
      '1080x1920': '9:16',
      '1920x1080': '16:9',
    };
    const aspectRatio = aspectRatioMap[size];

    const aiResponse: any = await this.client.chat.completions.create({
      model: 'sora_image',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Crop and resize this image to ${aspectRatio} aspect ratio. Keep the main subject centered and fully visible. Do not add any borders, padding, or background fill. Output only the image.\n【${aspectRatio}】`,
            },
            {
              type: 'image_url',
              image_url: { url: imageUrl },
            },
          ],
        },
      ],
    } as Parameters<typeof this.client.chat.completions.create>[0]);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const content = String(aiResponse.choices?.[0]?.message?.content ?? '');

    // base64 inline
    const base64Match = content.match(
      /data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/,
    );
    if (base64Match) return { dataUrl: base64Match[0] };

    // markdown format: ![image](URL)
    const markdownMatch = content.match(/!\[.*?]\((https?:\/\/[^)]+)\)/);
    if (markdownMatch) {
      const fetched = await fetch(markdownMatch[1]);
      const buffer = Buffer.from(await fetched.arrayBuffer());
      return { dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}` };
    }

    // plain URL
    const urlMatch = content.match(/https?:\/\/[^\s)]+/);
    if (urlMatch) {
      const fetched = await fetch(urlMatch[0]);
      const buffer = Buffer.from(await fetched.arrayBuffer());
      return { dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}` };
    }

    throw new Error('No image returned from model');
  }
}
