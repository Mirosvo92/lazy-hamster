import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnalyzerModule } from './analyzer/analyzer.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LangChainModule } from './lang-chain/lang-chain.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { UploadModule } from './upload/upload.module';
import { UsersModule } from './users/users.module';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath: `.env.${process.env.NODE_ENV ?? 'development'}`,
        }),
        PrismaModule,
        UploadModule,
        AnalyzerModule,
        ProjectsModule,
        UsersModule,
        LangChainModule,
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
