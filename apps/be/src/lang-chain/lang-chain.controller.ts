import { Body, Controller, Post } from '@nestjs/common';
import { LangChainService } from './lang-chain.service';

@Controller('langChain-testing')
export class LangChainController {
    constructor(private readonly langChainService: LangChainService) {}

    @Post('generate')
    async generate(@Body('prompt') prompt: string): Promise<{ url: string }> {
        return this.langChainService.generateLanding(prompt);
    }
}
