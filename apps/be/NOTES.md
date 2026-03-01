# Backend Notes

## Архитектура

### Точка входа — `main.ts`
- `NestFactory.create(AppModule)` — создаёт приложение из корневого модуля
- `app.setGlobalPrefix('api')` — все роуты начинаются с `/api`
- Слушает на `process.env.PORT` или `3001`

### Модульная система
NestJS работает по принципу модулей. Каждый `@Module()` объявляет:
- `imports` — зависимые модули
- `controllers` — классы, обрабатывающие HTTP-запросы
- `providers` — сервисы (бизнес-логика), инжектятся через конструктор

### AppModule (корневой)
- `ConfigModule.forRoot({ isGlobal: true })` — загружает `.env`, делает `ConfigService` доступным везде
- `UploadModule` — фича-модуль загрузки файлов
- `AppController` + `AppService` — корневой контроллер

### UploadModule (фича-модуль)
- `UploadController` — обрабатывает загрузку
- `S3Service` — заливает файлы в AWS S3
- `ConfigService` доступен благодаря `isGlobal: true`

### Роуты
Формируются: глобальный префикс + путь контроллера + путь метода

| Метод | Путь | Контроллер | Описание |
|-------|------|-----------|----------|
| GET | `/api` | `AppController.getHello()` | Возвращает `"Hello World!"` |
| POST | `/api/upload` | `UploadController.uploadFile()` | Загружает картинку в S3 (max 10MB, только image/*) |

### Dependency Injection
- `AppController` <- `AppService`
- `UploadController` <- `S3Service`
- `S3Service` <- `ConfigService`

NestJS видит типы в конструкторе и автоматически подставляет нужные экземпляры.

## Тестирование

### Стек
Jest 30 + ts-jest + Supertest 7 + @nestjs/testing

### Unit-тесты (`src/**/*.spec.ts`)
- `npm test` — запуск
- Создают мини-модуль с `Test.createTestingModule()` только с нужными зависимостями
- Вызывают методы напрямую, без HTTP
- Пример: `app.controller.spec.ts`

### E2E-тесты (`test/*.e2e-spec.ts`)
- `npm run test:e2e` — запуск (отдельный конфиг `test/jest-e2e.json`)
- Поднимают всё приложение через `createNestApplication()`
- Шлют реальные HTTP-запросы через Supertest
- Важно: в E2E тесте нет `setGlobalPrefix('api')`, поэтому роуты без `/api`

## AI Agents (миграция из MVP)

### Источник: `/Users/vlad/Desktop/gpt-prompt/server/`
MVP проект — Express-based пайплайн из 5 стадий. Мигрируем поэтапно в NestJS.

### Agent 1: Analyzer (первый в очереди)
**Что делает:** принимает URL картинки → отправляет в OpenAI Vision → возвращает JSON с brand, model, description

**Из MVP (`analyzer.js` + `ai-clients.js`):**
- OpenAI client: `gpt-4.1-mini` модель
- Использует `client.responses.create()` с `input_image` + `input_text`
- Промпт просит вернуть JSON: `{ brand, model, description }`
- Парсит ответ, если не JSON — фоллбек с raw text в description

**Что нужно изменить при миграции:**
- Промпт должен быть на **английском** (не русском как в MVP)
- Результат должен возвращаться на **языке пользователя** (передаётся через locale)
- Интеграция с текущим upload flow: пользователь загружает фото → S3 → получает URL → analyzer анализирует

**Планируемый flow:**
```
POST /api/upload (фото)
  → S3Service.upload() → получаем imageUrl
  → AnalyzerService.analyze(imageUrl, locale) → OpenAI Vision
  → возвращаем { url, key, analysis: { brand, model, description } }
```

**Нужные env-переменные:**
- `OPENAI_API_KEY` — ключ OpenAI API

### Будущие агенты (из MVP, пока не мигрируем)
- **Questions agent** — генерация динамической формы по результату анализа
- **Prompt agent** — генерация спецификации лендинга
- **Images agent** — подготовка изображений (OpenAI + Unsplash)
- **Landing agent** — генерация HTML через Claude