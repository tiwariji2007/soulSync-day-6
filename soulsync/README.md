# SoulSync (Next.js app)

Setup, environment variables, migrations, API reference and testing: see the [root README](../README.md#2-and-3-soulsync-weekly-insights-and-faq-rag-soulsync).

```bash
npm install
cp .env.example .env.local
npm run db:migrate && npm run faq:seed
npm run dev
npm test
```
