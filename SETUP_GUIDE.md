# QuestRock Credit Intake — Setup Guide

## Prerequisites

- Node.js 18+
- Vercel CLI (optional until you deploy — `npm i -g vercel` or use project `npx vercel`)
- LendingPad API credentials (contact, company, login) and LO user GUIDs in `config/lendingpad-users.json`
- OpenAI API key
- Zapier account with a Webhooks-enabled plan

---

## Step 1: Install Dependencies

```bash
cd questrock-credit-intake
npm install
```

This installs `pdf-parse` (credit report text extraction).

---

## Step 2: Configure Environment

```bash
cp .env.example .env
```

Fill in every value in `.env`:

```env
LENDINGPAD_API_URL=https://api.lendingpad.com
LENDINGPAD_CONTACT=<your contact guid>
LENDINGPAD_COMPANY=<your company guid>
LENDINGPAD_USERNAME=<login from LendingPad support>
LENDINGPAD_PASSWORD=<password from LendingPad support>

OPENAI_API_KEY=sk-...
CHATGPT_ASSISTANT_ID=            # leave blank to use built-in prompt

ZAPIER_WEBHOOK_URL=https://hooks.zapier.com/hooks/catch/...
```

### Loan officer list (`config/lendingpad-users.json`)

Each LO has a **user GUID** used as the `user` parameter on `GET /integrations/list/loans`. Edit [`config/lendingpad-users.json`](config/lendingpad-users.json) with `{ "name": "Display Name", "id": "guid" }` rows. Run **`npm run lo:list`** from the repo root to print `Name = guid` for quick reference. See also `config/README.txt`. The intake form loads this list into a dropdown so the searching LO picks themselves.

Optional: set `LENDINGPAD_USERS_JSON` to a JSON array string to override the file (e.g. on Vercel without redeploying). Optional: `LENDINGPAD_USER` for a single default GUID if you only ever use one user via API.

### Getting LendingPad Credentials

1. Contact LendingPad support and request Web API access.
2. They will provide: contact GUID, company GUID, and a login (username + password). Obtain each LO’s **user GUID** from LendingPad (or support) for `config/lendingpad-users.json`.
3. Give them your server IP or domain to whitelist.
4. Test environment: `https://testapi.lendingpad.com` (swap `LENDINGPAD_API_URL` to test first).

### Getting a Zapier Webhook URL

1. Create a new Zap in Zapier.
2. Set trigger to **Webhooks by Zapier > Catch Hook**.
3. Copy the webhook URL into `ZAPIER_WEBHOOK_URL`.
4. Add actions: **Formatter** (build email body from payload fields) > **Email by Zapier** or **Gmail**.
5. Turn on the Zap.

---

## Step 3: Local Development

```bash
npm run dev
```

This runs `local-dev.cjs` (HTML at `/`, API at `/api`, LO list at `/config/lendingpad-users.json`). If port 3000 is busy, the script picks the next free port and prints the URL—use that URL in the browser.

Optional: `npm run dev:vercel` matches Vercel’s routing locally but requires `vercel login`.

---

## Step 4: Deploy to Vercel (when you are ready)

Do this from the Vercel dashboard, connected Git, or your own machine when you choose—not required for local work.

```bash
npm run deploy:vercel
# or: npx vercel --prod
```

Then add secrets in the Vercel dashboard (Project > Settings > Environment Variables):

| Variable | Vercel Secret Name |
|----------|-------------------|
| `LENDINGPAD_API_URL` | `@lendingpad_api_url` |
| `LENDINGPAD_CONTACT` | `@lendingpad_contact` |
| `LENDINGPAD_COMPANY` | `@lendingpad_company` |
| `LENDINGPAD_USERNAME` | `@lendingpad_username` |
| `LENDINGPAD_PASSWORD` | `@lendingpad_password` |
| `OPENAI_API_KEY` | `@openai_api_key` |
| `CHATGPT_ASSISTANT_ID` | `@chatgpt_assistant_id` |
| `ZAPIER_WEBHOOK_URL` | `@zapier_webhook_url` |

---

## Step 5: Test End-to-End

1. Open the deployed URL.
2. Choose **Loan officer** in the dropdown (LendingPad user).
3. Search for a borrower by last name.
4. Select the loan from search results — fields auto-fill (green badges).
5. If a credit report exists in LendingPad, it will be parsed automatically (blue badges).
6. If not, upload a PDF manually — it will be parsed the same way.
7. Fill in the remaining subjective fields (budget, timeline, willingness, notes, urgency).
8. Click **Submit to QuestRock Engine**.
9. Verify: Zapier received the payload and sent the email.

---

## LendingPad Field Mapping

| Intake Field | LendingPad Source | Auto? |
|-------------|-------------------|-------|
| Full Name | `borrowers[].firstName + lastName` | Yes |
| Joint/Single | `coBorrower` presence | Yes |
| Loan Purpose | `purpose.name` | Yes |
| Loan Type | `loanType.name` | Yes |
| Credit Score | `creditScore` | Yes |
| Loan Amount | `totalLoanAmount` | Yes |
| Property Address | `subjectPropertyAddress` | Yes |
| Closing Date | `estimatedClosingDate` | Yes |
| Housing Status | Inferred from credit report | Yes (AI) |
| Budget | N/A | Manual |
| Timeline | N/A | Manual |
| Execution Profile | N/A | Manual |
| Derogatory Willingness | N/A | Manual |
| LO Notes | N/A | Manual |
| Urgency | N/A | Manual |

---

## Troubleshooting

**LendingPad 401:** Verify username/password. Ensure your server IP is whitelisted (for Vercel, you may need a fixed egress IP via a proxy or Vercel's Enterprise plan).

**No search results:** The `user` GUID must match the LO who owns the loans in LendingPad.

**Credit report parse fails with "scanned/image-only":** The PDF has no selectable text. Ask the LO to upload a text-searchable PDF from the credit pull tool.

**Zapier not receiving:** Check that the Zap is turned on and the URL is correct. Use `https://hooks.zapier.com/hooks/catch/...` (not the test URL).

**OpenAI 429 (rate limit):** You may be hitting the tokens-per-minute limit. Upgrade to a higher OpenAI tier or add retry logic.

---

## Cost Estimate

| Component | Monthly Cost |
|-----------|-------------|
| Vercel hosting | Free tier |
| OpenAI (GPT-4o) | ~$0.02-0.05 per intake |
| Zapier | $20-50 (depends on plan) |
| **Total (100 intakes/mo)** | **~$25-55** |

---

## Security Notes

- All LendingPad and OpenAI calls go through the backend — no secrets in the browser.
- Credit report PDF bytes are processed in-memory and not stored.
- Use HTTPS only (Vercel provides this by default).
- Rotate LendingPad and OpenAI credentials periodically.

---

Version: 4.0
