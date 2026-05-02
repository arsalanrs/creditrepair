# QuestRock Credit Intake — Architecture Overview

## System Architecture (v4)

This system uses a single deployment path: Vercel serverless + Zapier webhook.

```
                     ┌──────────────────┐
                     │   Loan Officer    │
                     │   (Browser)       │
                     └────────┬─────────┘
                              │
                     ┌────────▼─────────┐
                     │  questrock-       │
                     │  intake.html      │
                     │  (Static page)    │
                     └────────┬─────────┘
                              │  POST /api
                     ┌────────▼─────────┐
                     │  questrock-       │
                     │  backend.js       │
                     │  (Vercel fn)      │
                     └──┬───┬───┬───┬───┘
                        │   │   │   │
           ┌────────────┘   │   │   └────────────┐
           ▼                ▼   ▼                ▼
    ┌──────────┐    ┌──────────┐  ┌──────────┐  ┌──────────┐
    │LendingPad│    │  OpenAI  │  │  OpenAI  │  │  Zapier  │
    │ list/    │    │ GPT-4o   │  │ GPT-4o   │  │ Webhook  │
    │ loans +  │    │ (credit  │  │ (intake  │  │ → Email  │
    │ docs API │    │  parse)  │  │ analysis)│  │          │
    └──────────┘    └──────────┘  └──────────┘  └──────────┘
```

## API Actions

| Action | What it does |
|--------|-------------|
| `searchLoans` | Queries LendingPad `GET /integrations/list/loans` by borrower name |
| `loadLoan` | Fetches credit report PDF from LendingPad documents API, parses with GPT-4o |
| `parseCreditReport` | Accepts base64 PDF (manual upload), parses with GPT-4o |
| `submitIntake` | Formats intake → ChatGPT analysis → POSTs everything to Zapier webhook |

## Data Flow

1. **Search:** LO types name → backend searches LendingPad → returns matching loans
2. **Select:** LO picks loan → frontend fills fields from search data → backend fetches credit report → GPT-4o extracts structured JSON → frontend fills credit fields
3. **Fill:** LO enters ~6 subjective fields (budget, timeline, willingness, notes, urgency)
4. **Submit:** Backend formats prompt → ChatGPT generates execution plan → payload POSTed to Zapier → Zapier sends email

## Previous Versions

- v1-v3: Used SendGrid for email, direct LendingPad calls from browser, no credit report parsing
- v4 (current): All API calls through backend, AI credit report parsing, Zapier-only output
