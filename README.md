# QuestRock Credit Optimization Intake System

Automated credit-repair intake: LendingPad loan search, AI credit-report parsing, ChatGPT analysis, Zapier webhook output.

---

## How It Works

```
LO searches borrower name
    -> Backend queries LendingPad (list/loans)
    -> LO selects loan (auto-fills name, score, type, purpose, amount, address)
    -> Backend fetches credit report PDF from LendingPad documents API
    -> Backend parses PDF with GPT-4o (extracts scores, collections, charge-offs, utilization, AU tradelines)
    -> LO fills ~6 subjective fields (budget, timeline, willingness, notes)
    -> Submit
    -> Backend sends intake to ChatGPT for execution plan
    -> Backend POSTs intake + AI analysis JSON to Zapier webhook
    -> Zapier sends formatted email
```

---

## Project Files

```
questrock-credit-intake/
  questrock-intake.html      Frontend (single-page app)
  questrock-backend.js       Vercel serverless function
  package.json               Dependencies (pdf-parse)
  vercel.json                Vercel build + route config
  .env.example               Template for env vars
  .env                       Local secrets (git-ignored)
  .gitignore
  README.md                  This file
  SETUP_GUIDE.md             Deployment walkthrough
  IMPLEMENTATION_GUIDE.md    Architecture comparison (historical)
  lendingpadtxt              LendingPad API reference
  config/
    lendingpad-users.json    LO names + LendingPad user GUIDs (dropdown source)
    README.txt               Where to edit the LO list
```

---

## Quick Start

```bash
npm install
cp .env.example .env        # fill in credentials
npm run dev                 # local app + API (no Vercel login)
```

Production deploy is manual (Vercel dashboard, Git integration, or when you choose: `npm run deploy:vercel`). Optional parity with Vercel’s dev proxy: `npm run dev:vercel` (requires `vercel login`).

---

## Environment Variables

Set in `.env` locally or in the Vercel dashboard for production.

```env
# LendingPad Web API — HTTP Basic Auth (from LendingPad support) + IP whitelist
LENDINGPAD_API_URL=https://api.lendingpad.com
LENDINGPAD_CONTACT=<guid>
LENDINGPAD_COMPANY=<guid>
LENDINGPAD_USERNAME=<login>
LENDINGPAD_PASSWORD=<password>
# Optional: LENDINGPAD_USER=<single LO guid> if you never use the UI picker
# Optional: LENDINGPAD_USERS_JSON='[{"name":"...","id":"..."}]' to override the file list

# OpenAI
OPENAI_API_KEY=sk-...
CHATGPT_ASSISTANT_ID=            # optional; blank = use built-in prompt

# Zapier webhook (required — this is where intake + AI analysis are sent)
ZAPIER_WEBHOOK_URL=https://hooks.zapier.com/hooks/catch/...
```

---

## LendingPad Integration

### Credentials Needed (from LendingPad support)
1. **Contact GUID** — `contact` query parameter
2. **Company GUID** — `company` query parameter
3. **Per-LO user GUIDs** — `user` query parameter on list loans. The app loads names/GUIDs from [`config/lendingpad-users.json`](config/lendingpad-users.json) (`npm run lo:list` prints `Name = guid`). The LO picks themselves in the dropdown before searching.
4. **Login username + password** — HTTP Basic Auth (not a separate API key)
5. **IP whitelist** — your Vercel deployment IPs must be whitelisted

### Endpoints Used
| Endpoint | Purpose |
|----------|---------|
| `GET /integrations/list/loans` | Search loans by borrower name |
| `GET /integrations/loans/documents` | List documents for a loan |
| `GET /integrations/loans/documents/file` | Download credit report PDF |

### Auto-Filled from LendingPad
- Borrower name, Joint/Single, Loan purpose, Loan type
- Credit score, Loan amount, Property address
- Estimated closing date, Loan status

### Auto-Filled from Credit Report (AI-parsed)
- Per-bureau scores (Equifax / Experian / TransUnion)
- Collections count + balances
- Charge-offs count + balances
- Late payment summary
- Revolving utilization per account
- Authorized user tradelines (age, limit, utilization, late history)
- Public records, total debt, inquiries
- Housing status (inferred from mortgage tradeline)
- Suggested repair goals

### LO Fills Manually (~6 fields)
- Budget (total / immediate / max)
- Timeline (close date, score improvement)
- Execution profile (action-taker? comfortable calling?)
- Derogatory willingness (settle collections? charge-offs?)
- LO notes (concerns, personality, known issues)
- Deal priority / urgency

---

## Zapier Webhook Payload

The backend POSTs this JSON to your `ZAPIER_WEBHOOK_URL`:

```json
{
  "borrower": {
    "fullName": "John Smith",
    "applicationType": "Joint",
    "loanPurpose": "Purchase",
    "loanType": "FHA",
    "creditScore": 620,
    "loanAmount": 350000,
    "propertyAddress": "124 Main St, Hackettstown, NJ 07840",
    "estimatedClosingDate": "2026-06-15"
  },
  "creditReport": {
    "scores": { "equifax": 618, "experian": 622, "transunion": 620 },
    "collections": { "count": 3, "totalBalance": 4500, "accounts": [...] },
    "chargeOffs": { "count": 1, "totalBalance": 2200, "accounts": [...] },
    "latePayments": "2x 30-day on auto loan",
    "utilization": { "overall": 78, "revolving": [...] },
    "authorizedUserTradelines": [...],
    "publicRecords": "None",
    "totalOpenAccounts": 8,
    "totalDebt": 24500,
    "inquiries": { "count": 5, "last12Months": 3 }
  },
  "loInput": {
    "budget": { "total": 1500, "immediate": 500, "max": 2000 },
    "timeline": { "closeDate": "60 days", "scoreImprovement": "45 days" },
    "executionProfile": { ... },
    "derogatoryWillingness": { ... },
    "loNotes": { ... },
    "urgency": "High (active contract)"
  },
  "aiAnalysis": "... full ChatGPT credit optimization plan ...",
  "submittedAt": "2026-04-13T14:30:00Z"
}
```

In Zapier, map these fields into your email template.

---

## Testing Checklist

- [ ] LendingPad loan search returns results
- [ ] Selecting a loan auto-fills form fields (green badges)
- [ ] Credit report auto-fetched and parsed (blue badges)
- [ ] Manual PDF upload + parse works as fallback
- [ ] All required fields validate on submit
- [ ] Submit sends to Zapier webhook
- [ ] Zapier receives full payload and sends email
- [ ] Mobile responsive

---

## Troubleshooting

**LendingPad returns 401:** Check Basic Auth username/password and that your server IP is whitelisted.

**No credit report found:** The loan may not have a document with type `CreditReport` (type id 2). Upload manually.

**PDF parse fails:** The PDF may be scanned/image-only. Upload a text-searchable PDF.

**Zapier webhook fails:** Verify `ZAPIER_WEBHOOK_URL` is set and the Zap is turned on.

---

## Security

- Credentials are never in the frontend; all API calls go through the backend
- `.env` is git-ignored
- Vercel secrets are encrypted at rest
- LendingPad enforces IP whitelist
- Credit report data is processed in-memory, not stored

---

Version: 4.0 | Last Updated: 2026-04
