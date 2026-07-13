const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CONFIG = {
    LENDINGPAD_API_URL: process.env.LENDINGPAD_API_URL || 'https://api.lendingpad.com',
    LENDINGPAD_CONTACT: process.env.LENDINGPAD_CONTACT,
    LENDINGPAD_COMPANY: process.env.LENDINGPAD_COMPANY,
    /** Optional default when `userId` is omitted (e.g. API-only scripts) */
    LENDINGPAD_USER: process.env.LENDINGPAD_USER,

    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CHATGPT_ASSISTANT_ID: process.env.CHATGPT_ASSISTANT_ID || ''
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lendingPadBasicAuth() {
    const single = process.env.LENDINGPAD_BASIC_AUTH?.trim();
    const user = process.env.LENDINGPAD_USERNAME?.trim();
    const pass = process.env.LENDINGPAD_PASSWORD ?? '';
    let raw;
    if (single) {
        raw = single;
    } else if (user) {
        raw = `${user}:${pass}`;
    } else {
        throw new Error('LendingPad credentials missing – set LENDINGPAD_USERNAME / LENDINGPAD_PASSWORD');
    }
    return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

async function lpFetch(path) {
    const url = `${CONFIG.LENDINGPAD_API_URL}${path}`;
    const retryable = new Set([502, 503, 504, 512, 520, 521, 522]);
    const maxAttempts = 3;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const res = await fetch(url, {
            headers: {
                Authorization: lendingPadBasicAuth(),
                'Content-Type': 'application/json'
            }
        });
        if (res.ok) return res;

        const raw = (await res.text()).trim().slice(0, 900);
        let detail = raw || 'empty response body';
        try {
            const j = JSON.parse(raw);
            if (j && typeof j === 'object') {
                const m = j.message ?? j.error ?? j.Message ?? j.title;
                if (typeof m === 'string' && m.trim()) detail = m.trim().slice(0, 500);
            }
        } catch (_) {
            /* keep raw */
        }

        const hint = retryable.has(res.status)
            ? ' This status is often temporary on LendingPad — wait a minute, retry, or search by loan number. If it keeps happening, contact LendingPad support with the time of the request.'
            : '';

        lastErr = new Error(`LendingPad HTTP ${res.status}.${hint} Body: ${detail}`);

        if (!retryable.has(res.status) || attempt === maxAttempts - 1) throw lastErr;
        await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
    }
    throw lastErr;
}

function setCORS(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function ok(res, data) { return res.status(200).json({ success: true, ...data }); }
function fail(res, code, msg) { return res.status(code).json({ success: false, error: msg }); }

// ---------------------------------------------------------------------------
// LendingPad: LO user list — config/lendingpad-users.json or LENDINGPAD_USERS_JSON
// ---------------------------------------------------------------------------

function loadLendingPadUsers() {
    const envJson = process.env.LENDINGPAD_USERS_JSON?.trim();
    if (envJson) {
        try {
            const parsed = JSON.parse(envJson);
            if (Array.isArray(parsed)) return normalizeUserList(parsed);
        } catch (e) {
            console.error('LENDINGPAD_USERS_JSON parse error:', e.message);
        }
    }
    // Bundled with the function (works on Vercel where __dirname has no loose JSON file)
    try {
        const fromRequire = require('./config/lendingpad-users.json');
        if (Array.isArray(fromRequire)) {
            const list = normalizeUserList(fromRequire);
            if (list.length) return list;
        }
    } catch (e) {
        /* optional file */
    }
    const filePath = path.join(__dirname, 'config', 'lendingpad-users.json');
    if (fs.existsSync(filePath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (Array.isArray(parsed)) return normalizeUserList(parsed);
        } catch (e) {
            console.error('config/lendingpad-users.json read error:', e.message);
        }
    }
    return [];
}

function normalizeUserList(rows) {
    return rows
        .map((row) => {
            if (!row || typeof row !== 'object') return null;
            const id = (row.id || row.guid || '').trim();
            const name = (row.name || row.label || '').trim();
            if (!id) return null;
            return { id, name: name || id };
        })
        .filter(Boolean);
}

async function handleListLendingPadUsers(res) {
    const users = loadLendingPadUsers().sort((a, b) => a.name.localeCompare(b.name, 'en'));
    return ok(res, { users });
}

/** Supabase public config for the browser — read process.env here (not from a module-level snapshot) so Vercel injects values at runtime. */
function getSupabaseClientEnv() {
    const supabaseUrl = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
    const supabaseAnonKey = String(
        process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
    ).trim();
    return { supabaseUrl, supabaseAnonKey };
}

/** Public keys for browser Supabase client (auth + RLS writes). */
async function handleGetClientConfig(res) {
    const { supabaseUrl, supabaseAnonKey } = getSupabaseClientEnv();
    return ok(res, {
        supabaseUrl: supabaseUrl || null,
        supabaseAnonKey: supabaseAnonKey || null,
        supabaseConfigured: Boolean(supabaseUrl && supabaseAnonKey)
    });
}

// ---------------------------------------------------------------------------
// LendingPad: Search loans
// ---------------------------------------------------------------------------

async function handleSearchLoans(res, query, userId) {
    const user = (userId && String(userId).trim()) || CONFIG.LENDINGPAD_USER?.trim();
    if (!user) {
        return fail(
            res,
            400,
            'Select a loan officer (LendingPad user) or set LENDINGPAD_USER / config/lendingpad-users.json'
        );
    }

    const qs = new URLSearchParams({
        contact: CONFIG.LENDINGPAD_CONTACT,
        company: CONFIG.LENDINGPAD_COMPANY,
        user,
        take: '25'
    });
    const borrowerQ = query != null ? String(query).trim() : '';
    if (borrowerQ) qs.set('borrower', borrowerQ);

    const response = await lpFetch(`/integrations/list/loans?${qs}`);
    const body = await response.json();
    const loans = (body.data || []).map((loan) => {
        const { primary, coBorrower } = getPrimaryAndCoBorrowerFromLoan(loan);
        const borrowerName = formatBorrowerName(primary);
        const coBorrowerName = formatBorrowerName(coBorrower);
        return {
            id: loan.id,
            loanNumber: loan.loanNumber,
            borrowerName,
            coBorrowerName: coBorrowerName || null,
            borrowerCount: (loan.borrowers || []).length || (coBorrowerName ? 2 : borrowerName ? 1 : 0),
            primaryBorrowerId: primary?.id || null,
            coBorrowerId: coBorrower?.id || null,
            applicationType: coBorrowerName ? 'Joint' : 'Single',
            purpose: loan.purpose?.name || '',
            loanType: loan.loanType?.name || '',
            creditScore: loan.creditScore || null,
            loanAmount: loan.totalLoanAmount || null,
            loanStatus: loan.loanStatus?.name || '',
            estimatedClosingDate: loan.estimatedClosingDate || null,
            propertyAddress: formatAddress(loan.subjectPropertyAddress),
            income: loan.borrowersTotalIncomeAmount || null,
            loanTerm: loan.loanTerm || null
        };
    });
    return ok(res, { loans });
}

function formatAddress(addr) {
    if (!addr) return '';
    return [addr.street, addr.city, addr.state, addr.zipCode].filter(Boolean).join(', ');
}

/**
 * LendingPad: primary borrower carries `coBorrower` as a GUID string pointing at the co-borrower row
 * (see API examples). Older payloads may use a nested object instead.
 */
function getPrimaryAndCoBorrowerFromLoan(loan) {
    const list = Array.isArray(loan.borrowers) ? loan.borrowers : [];
    if (!list.length) return { primary: null, coBorrower: null };
    const primary = list.find((b) => {
        if (b == null || b.coBorrower == null || b.coBorrower === '') return false;
        if (typeof b.coBorrower === 'string') return b.coBorrower.length > 0;
        if (typeof b.coBorrower === 'object') return Boolean(b.coBorrower.id);
        return false;
    }) || list[0];
    let coBorrower = null;
    const ref = primary?.coBorrower;
    if (typeof ref === 'string' && ref) {
        coBorrower = list.find((b) => b && b.id === ref) || null;
    } else if (ref && typeof ref === 'object' && ref.id) {
        coBorrower = list.find((b) => b && b.id === ref.id) || ref;
    }
    return { primary, coBorrower };
}

function formatBorrowerName(b) {
    if (!b) return '';
    return `${b.firstName || ''} ${b.lastName || ''}`.trim();
}

// ---------------------------------------------------------------------------
// LendingPad: Load loan + auto-fetch credit report
// ---------------------------------------------------------------------------

async function handleLoadLoan(res, data) {
    const loanId = data?.loanId != null ? String(data.loanId).trim() : '';
    if (!loanId) return fail(res, 400, 'loanId is required');

    const targetBorrowerFullName =
        typeof data?.targetBorrowerFullName === 'string' ? data.targetBorrowerFullName.trim() : '';
    const documentIdPreferred = data?.documentId != null ? String(data.documentId).trim() : '';

    const qs = new URLSearchParams({
        contact: CONFIG.LENDINGPAD_CONTACT,
        company: CONFIG.LENDINGPAD_COMPANY,
        loan: loanId
    });

    let creditReport = null;
    const creditDocuments = [];
    try {
        const docsRes = await lpFetch(`/integrations/loans/documents?${qs}`);
        const docs = await docsRes.json();
        const list = Array.isArray(docs) ? docs : [];

        for (const d of list) {
            const tid = d.type?.id;
            const n = (d.name || '').toLowerCase();
            if (tid === 2 || n.includes('credit')) {
                creditDocuments.push({
                    id: d.id,
                    name: d.name || 'Credit document',
                    typeId: tid ?? null,
                    typeName: d.type?.name || null
                });
            }
        }

        let creditDoc = null;
        if (documentIdPreferred) {
            creditDoc = list.find((d) => String(d.id) === documentIdPreferred) || null;
        }
        if (!creditDoc) {
            creditDoc = list.find((d) => d.type?.id === 2 || (d.name || '').toLowerCase().includes('credit'));
        }

        if (creditDoc) {
            const fileQs = new URLSearchParams({
                contact: CONFIG.LENDINGPAD_CONTACT,
                company: CONFIG.LENDINGPAD_COMPANY,
                loan: loanId,
                document: creditDoc.id
            });
            const fileRes = await lpFetch(`/integrations/loans/documents/file?${fileQs}`);
            const arrayBuf = await fileRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuf);

            if (buffer.length > 0) {
                creditReport = await extractCreditReport(buffer, targetBorrowerFullName);
            }
        }
    } catch (err) {
        console.error('Credit report auto-fetch failed (non-fatal):', err.message);
    }

    return ok(res, { creditReport, creditDocuments });
}

// ---------------------------------------------------------------------------
// Credit report parsing (manual upload)
// ---------------------------------------------------------------------------

async function handleParseCreditReport(res, data) {
    const pdfBase64 =
        typeof data === 'string'
            ? data
            : data && typeof data.pdfBase64 === 'string'
              ? data.pdfBase64
              : '';
    if (!pdfBase64) return fail(res, 400, 'No PDF data provided');

    const targetBorrowerFullName =
        data && typeof data === 'object' && typeof data.targetBorrowerFullName === 'string'
            ? data.targetBorrowerFullName.trim()
            : '';

    const buffer = Buffer.from(pdfBase64, 'base64');
    const creditReport = await extractCreditReport(buffer, targetBorrowerFullName);
    return ok(res, { creditReport });
}

async function extractCreditReport(buffer, targetBorrowerFullName = '') {
    const parsed = await pdfParse(buffer);
    const text = (parsed.text || '').trim();
    if (text.length < 200) {
        throw new Error('PDF appears to be scanned/image-only. Please upload a text-searchable credit report PDF.');
    }

    const truncated = text.slice(0, 120_000);
    const scope =
        typeof targetBorrowerFullName === 'string' ? targetBorrowerFullName.trim() : '';
    return parseCreditReportWithAI(truncated, scope);
}

const CREDIT_EXTRACT_PROMPT = `You are a credit report data extraction engine.
Given the raw text of a consumer credit report, extract ONLY the structured JSON below.
Return ONLY valid JSON, no markdown fences, no commentary.

{
  "extractedForBorrowerName": "<string: name as printed on the report for the consumer you extracted; null only if truly unknown>",
  "scores": {
    "equifax": <int or null>,
    "experian": <int or null>,
    "transunion": <int or null>
  },
  "collections": {
    "count": <int>,
    "totalBalance": <number>,
    "accounts": [{ "creditor": "<string>", "balance": <number>, "dateOpened": "<string>" }]
  },
  "chargeOffs": {
    "count": <int>,
    "totalBalance": <number>,
    "accounts": [{ "creditor": "<string>", "balance": <number> }]
  },
  "latePayments": "<summary string, e.g. 2x 30-day on auto loan>",
  "utilization": {
    "overall": <number 0-100>,
    "revolving": [{ "creditor": "<string>", "limit": <number>, "balance": <number>, "utilization": <number 0-100> }]
  },
  "authorizedUserTradelines": [
    { "creditor": "<string>", "ageYears": <number>, "limit": <number>, "utilization": <number 0-100>, "lateHistory": "<string>" }
  ],
  "publicRecords": "<summary or None>",
  "totalOpenAccounts": <int>,
  "totalDebt": <number>,
  "inquiries": { "count": <int>, "last12Months": <int> },
  "housingStatus": "<Owns | Renting | Unknown>",
  "suggestedRepairGoals": ["<Approval>", "<Better Pricing>", "<Max Loan Proceeds>"]
}

Rules:
- "housingStatus": if any mortgage tradeline exists → "Owns", otherwise → "Renting" (default assumption) or "Unknown" if not determinable.
- "suggestedRepairGoals": infer from derogatory severity and score gap.
- If a field cannot be determined, use null for numbers and "Unknown" for strings.
- Multiple consumers: The text may be a merged PDF or contain more than one named consumer (co-borrowers, joint file). NEVER mix two people's tradelines, scores, balances, inquiries, collections, or public records into one JSON object.
- If a TARGET CONSUMER name is given in a separate instruction, extract ONLY that person's data (match using full name, reversed order, middle initials, common nicknames). All counts and totals must refer only to that consumer.
- If NO target name is given but multiple distinct consumer sections exist, extract ONLY the first complete consumer block and set extractedForBorrowerName from that section's header; do not merge co-borrowers.
- Return ONLY the JSON object.`;

async function parseCreditReportWithAI(text, targetBorrowerFullName = '') {
    const scope =
        typeof targetBorrowerFullName === 'string' && targetBorrowerFullName.trim()
            ? `\n\nTARGET CONSUMER (mandatory — do not blend with anyone else on this file):\n"${targetBorrowerFullName.trim()}"\nExtract only this consumer's credit data. Set extractedForBorrowerName to the spelling shown on the report header for that consumer when identifiable.`
            : '\n\nNo named target was supplied. If multiple consumers appear, isolate one complete consumer only — never merge joint borrowers.';

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            response_format: { type: 'json_object' },
            temperature: 0.1,
            messages: [
                { role: 'system', content: CREDIT_EXTRACT_PROMPT + scope },
                { role: 'user', content: text }
            ]
        })
    });

    if (!response.ok) throw new Error(`OpenAI credit parse error: ${response.status}`);
    const result = await response.json();
    return JSON.parse(result.choices[0].message.content);
}

// ---------------------------------------------------------------------------
// Submit intake: ChatGPT analysis (no external webhook)
// ---------------------------------------------------------------------------

async function handleSubmitIntake(res, data) {
    if (data && data.previewOnly === true) {
        return handlePreviewIntake(res, data);
    }

    const formattedIntake = formatIntakeData(data);
    const aiAnalysis = await sendToChatGPT(formattedIntake);
    return ok(res, {
        message: 'Intake analyzed.',
        aiAnalysis
    });
}

/** OpenAI only — same analysis as submit. */
async function handlePreviewIntake(res, data) {
    const d = { ...(data || {}) };
    delete d.previewOnly;
    const formattedIntake = formatIntakeData(d);
    const aiAnalysis = await sendToChatGPT(formattedIntake);
    return ok(res, { preview: true, aiAnalysis });
}

// ---------------------------------------------------------------------------
// Format intake for ChatGPT analysis prompt
// ---------------------------------------------------------------------------

function formatIntakeData(d) {
    const cr = d.creditReport || {};
    const scores = cr.scores || {};
    const bureauRows = [
        ['Equifax', scores.equifax],
        ['Experian', scores.experian],
        ['TransUnion', scores.transunion]
    ].filter(([, v]) => v != null && v !== '' && Number.isFinite(Number(v)));
    let marginalBureau = 'UNKNOWN (scores incomplete)';
    let recommendBoost = false;
    if (bureauRows.length) {
        bureauRows.sort((a, b) => Number(a[1]) - Number(b[1]));
        marginalBureau = `${bureauRows[0][0]} (${bureauRows[0][1]})`;
        recommendBoost = bureauRows[0][0] === 'Experian';
    }
    const renterPurchase =
        (d.housingStatus === 'Renting' || d.isRenting === 'Yes') && d.loanPurpose === 'Purchase';
    const isRenting = d.isRenting === 'Yes' || d.housingStatus === 'Renting';

    const parseMoney = (v) => {
        if (v == null || v === '' || v === 'UNKNOWN') return 0;
        const n = Number(String(v).replace(/[^0-9.]/g, ''));
        return Number.isFinite(n) ? n : 0;
    };
    const budgetPrimary = parseMoney(d.maxWilling) || parseMoney(d.totalBudget);
    const unlimitedBudget =
        budgetPrimary >= 25000
        || /unlimited|no limit|no max/i.test(String(d.maxWilling || d.totalBudget || ''));
    const planBSpendCap = budgetPrimary ? Math.min(Math.round(budgetPrimary * 1.75), budgetPrimary + 3000) : 0;
    const planCSpendCap = budgetPrimary ? Math.min(Math.round(budgetPrimary * 2.5), budgetPrimary + 5000) : 0;

    const loanMinTarget = {
        FHA: 500, VA: 500, Conventional: 620, 'Non-QM': 620, DSCR: 620, USDA: 620, HELOC: 620,
    }[d.loanType] ?? null;

    const coName = (d.coBorrowerName && String(d.coBorrowerName).trim()) || '';
    const subject =
        (d.creditReportSubjectName && String(d.creditReportSubjectName).trim()) ||
        (d.fullName && String(d.fullName).trim()) ||
        'UNKNOWN';
    const extractedName =
        cr.extractedForBorrowerName != null && String(cr.extractedForBorrowerName).trim()
            ? String(cr.extractedForBorrowerName).trim()
            : '';

    const currentMid = Number(d.currentScore);
    const under500 = Number.isFinite(currentMid) && currentMid > 0 && currentMid < 500;

    return `
QUESTROCK CREDIT OPTIMIZATION INTAKE (v3) — structured fields below. Follow the system prompt's REQUIRED OUTPUT SECTIONS exactly. Do not invent bureau-level tradeline detail not present in this message or in section 11.
${under500 ? '\n⚠️ MID-SCORE UNDER 500 — default recommendation: outsource to professional credit repair partner (see system prompt rule 9). Still provide three plans.\n' : ''}

Loan officer (LendingPad user): ${d.lendingPadUserName || 'UNKNOWN'} | ${d.lendingPadUserId || 'UNKNOWN'}

0. BORROWER SCOPE (CRITICAL — DO NOT BLEND CO-BORROWERS)
This plan is for ONE borrower only: ${subject}
${coName ? `Co-borrower on the loan file (context only — do NOT use their tradelines, scores, or derogs in this plan unless explicitly duplicated in section 12 for the subject above): ${coName}` : 'Co-borrower on file: None / single borrower'}
${extractedName ? `AI credit extract attributed to (from PDF): ${extractedName}` : ''}
If section 12 could possibly mix two consumers, trust ONLY items that clearly belong to ${subject} and state UNKNOWN rather than guessing.

1. BORROWER INFORMATION
Full Name: ${d.fullName || 'UNKNOWN'}
Joint or Single Application: ${d.applicationType || 'UNKNOWN'}
Purchase or Refinance: ${d.loanPurpose || 'UNKNOWN'}

CURRENT HOUSING STATUS
Housing Status: ${d.housingStatus || 'UNKNOWN'}
${d.housingStatus === 'Renting' ? `Monthly Rent: $${d.monthlyRent || 'UNKNOWN'}
On-time & traceable payments: ${d.rentPayments || 'UNKNOWN'}` : ''}

2. LOAN + GOAL
Loan Type: ${d.loanType || 'UNKNOWN'}
Current Credit Score (mid): ${d.currentScore || 'UNKNOWN'}
Equifax: ${scores.equifax ?? 'UNKNOWN'} | Experian: ${scores.experian ?? 'UNKNOWN'} | TransUnion: ${scores.transunion ?? 'UNKNOWN'}
Target Score Needed: ${d.targetScore || 'UNKNOWN'}${loanMinTarget != null ? ` (program minimum: ${loanMinTarget})` : ''}
Ideal Score Goal (pricing): ${d.idealScore || 'UNKNOWN'}
Credit Repair Goal: ${Array.isArray(d.repairGoal) ? d.repairGoal.join(', ') : d.repairGoal || 'UNKNOWN'}

3. TIMELINE (CRITICAL)
Target Close Timeline: ${d.closeTimeline || 'UNKNOWN'}
Desired Timeframe to Improve Score: ${d.scoreTimeline || 'UNKNOWN'}

4. BUDGET (CRITICAL)
Total Available Budget: $${d.totalBudget || 'UNKNOWN'}
Immediate Cash Available: $${d.immediateCash || 'UNKNOWN'}
Max Willing to Spend: $${d.maxWilling || 'UNKNOWN'}
Plan A spend cap (must match budget): $${budgetPrimary || 'UNKNOWN'}
Plan B spend cap (moderate stretch): $${planBSpendCap || 'N/A'}
Plan C spend cap (max stretch — do not exceed): $${planCSpendCap || 'N/A'}
Unlimited / speed mode: ${unlimitedBudget ? 'YES — optimize for fastest timeline, not max spend' : 'NO — budget-first'}

5. BORROWER EXECUTION PROFILE (CRITICAL)
Will take action immediately: ${d.immediateAction || 'UNKNOWN'}
Comfortable calling creditors: ${d.comfortableCalling || 'UNKNOWN'}
Needs step-by-step guidance: ${d.needsGuidance || 'UNKNOWN'}

6. DEROGATORY WILLINGNESS (CRITICAL)
Willing to settle/pay collections: ${d.willingCollections || 'UNKNOWN'}
Willing to resolve charge-offs: ${d.willingChargeoffs || 'UNKNOWN'}
Accounts refused to pay: ${d.refusedAccounts || 'None'}

7. AUTHORIZED USER (CRITICAL)
Has access to strong AU: ${d.hasAU || 'UNKNOWN'}
${d.hasAU === 'Yes (family/friend)' ? `AU Age: ${d.auAge || 'UNKNOWN'} years
AU Limit: $${d.auLimit || 'UNKNOWN'}
AU Utilization: ${d.auUtilization || 'UNKNOWN'}%
AU Late History: ${d.auLateHistory || 'UNKNOWN'}` : ''}

8. RENT / ALT CREDIT (SUPPORTING)
Is renting: ${d.isRenting || 'UNKNOWN'}
${isRenting ? `Monthly rent: $${d.monthlyRentAlt || d.monthlyRent || 'UNKNOWN'}
On-time payment history: ${d.onTimePayments || 'UNKNOWN'}
Utilities in borrower name: ${d.utilitiesInName || 'UNKNOWN'}` : 'Not renting — skip rent reporting section.'}

9. STRATEGY FLAGS (computed — follow system prompt plan / rent / Boost rules)
Marginal bureau (lowest of EQ/EX/TU from scores below): ${marginalBureau}
Experian Boost: ${recommendBoost ? 'RECOMMEND in plan (Experian is lowest bureau)' : 'Do NOT prioritize unless intake says otherwise'}
Renter + purchase (explicitly decide rent reporting yes/skip in plan): ${renterPurchase ? 'YES — renter on purchase path' : 'NO — use judgment if still renting without purchase'}

10. LO NOTES (IMPORTANT)
Biggest concern: ${d.biggestConcern || 'UNKNOWN'}
Already tried: ${d.alreadyTried || 'Nothing'}
Known issues: ${d.knownIssues || 'None'}
Borrower personality: ${d.personality || 'UNKNOWN'}

11. DEAL PRIORITY
Urgency: ${d.urgency || 'UNKNOWN'}

12. CREDIT REPORT SUMMARY (AI-EXTRACTED)${extractedName ? ` — extracted for: ${extractedName}` : ''}
Collections: ${cr.collections?.count ?? 'UNKNOWN'} accounts, $${cr.collections?.totalBalance ?? 'UNKNOWN'} total
${(cr.collections?.accounts || []).map(a => `  - ${a.creditor}: $${a.balance}`).join('\n')}
Charge-offs: ${cr.chargeOffs?.count ?? 'UNKNOWN'} accounts, $${cr.chargeOffs?.totalBalance ?? 'UNKNOWN'} total
${(cr.chargeOffs?.accounts || []).map(a => `  - ${a.creditor}: $${a.balance}`).join('\n')}
Late Payments: ${cr.latePayments || 'UNKNOWN'}
Utilization: ${cr.utilization?.overall ?? 'UNKNOWN'}%
${(cr.utilization?.revolving || []).map(a => `  - ${a.creditor}: $${a.balance}/$${a.limit} (${a.utilization}%)`).join('\n')}
AU Tradelines: ${(cr.authorizedUserTradelines || []).length > 0 ? cr.authorizedUserTradelines.map(a => `${a.creditor} ${a.ageYears}yr $${a.limit} ${a.utilization}% util`).join('; ') : 'None'}
Public Records: ${cr.publicRecords || 'None'}
Open Accounts: ${cr.totalOpenAccounts ?? 'UNKNOWN'}
Total Debt: $${cr.totalDebt ?? 'UNKNOWN'}
Inquiries (last 12mo): ${cr.inquiries?.last12Months ?? 'UNKNOWN'}

---
Submission Date: ${new Date().toISOString()}
Please analyze this intake and provide a comprehensive credit optimization strategy.`.trim();
}

// ---------------------------------------------------------------------------
// ChatGPT analysis (Assistant API or Completions fallback)
// ---------------------------------------------------------------------------

async function sendToChatGPT(intakeData) {
    const assistantId = CONFIG.CHATGPT_ASSISTANT_ID;
    if (assistantId && !assistantId.startsWith('asst_00')) {
        return sendViaAssistant(intakeData, assistantId);
    }
    return sendViaChatCompletions(intakeData);
}

async function sendViaAssistant(intakeData, assistantId) {
    const headers = {
        'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
    };
    try {
        const threadRes = await fetch('https://api.openai.com/v1/threads', {
            method: 'POST', headers, body: JSON.stringify({})
        });
        if (!threadRes.ok) throw new Error(`Thread creation failed: ${threadRes.status}`);
        const thread = await threadRes.json();

        const msgRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
            method: 'POST', headers,
            body: JSON.stringify({ role: 'user', content: intakeData })
        });
        if (!msgRes.ok) throw new Error(`Message creation failed: ${msgRes.status}`);

        const runRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
            method: 'POST', headers,
            body: JSON.stringify({ assistant_id: assistantId })
        });
        if (!runRes.ok) throw new Error(`Run creation failed: ${runRes.status}`);
        let run = await runRes.json();

        const deadline = Date.now() + 120_000;
        while (run.status === 'queued' || run.status === 'in_progress') {
            if (Date.now() > deadline) throw new Error('Assistant run timed out');
            await new Promise(r => setTimeout(r, 1500));
            const pollRes = await fetch(
                `https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`,
                { method: 'GET', headers }
            );
            if (!pollRes.ok) throw new Error(`Run poll failed: ${pollRes.status}`);
            run = await pollRes.json();
        }

        if (run.status !== 'completed') throw new Error(`Run ended: ${run.status}`);

        const msgsRes = await fetch(
            `https://api.openai.com/v1/threads/${thread.id}/messages?order=desc&limit=1`,
            { method: 'GET', headers }
        );
        if (!msgsRes.ok) throw new Error(`Messages retrieval failed: ${msgsRes.status}`);
        const msgs = await msgsRes.json();
        const assistantMsg = msgs.data.find(m => m.role === 'assistant');
        if (!assistantMsg) throw new Error('No assistant reply found');

        return assistantMsg.content.filter(c => c.type === 'text').map(c => c.text.value).join('\n');
    } catch (error) {
        console.error('Assistant API error:', error);
        return 'Error: Unable to generate analysis at this time.';
    }
}

async function sendViaChatCompletions(intakeData) {
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: QUESTROCK_SYSTEM_PROMPT },
                    { role: 'user', content: intakeData }
                ],
                temperature: 0.7,
                max_tokens: 4000
            })
        });
        if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);
        const result = await response.json();
        return result.choices[0].message.content;
    } catch (error) {
        console.error('Chat Completions error:', error);
        return 'Error: Unable to generate analysis at this time.';
    }
}

// ---------------------------------------------------------------------------
// Request body (Vercel legacy handler often omits req.body or uses Buffer/string)
// ---------------------------------------------------------------------------

async function readRequestJson(req) {
    if (req.body != null) {
        if (Buffer.isBuffer(req.body)) {
            const s = req.body.toString('utf8');
            return s ? JSON.parse(s) : {};
        }
        if (typeof req.body === 'string') {
            return req.body ? JSON.parse(req.body) : {};
        }
        if (typeof req.body === 'object') {
            return req.body;
        }
    }
    if (typeof req.on !== 'function') {
        return {};
    }
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// Main Vercel handler
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
    setCORS(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return fail(res, 405, 'POST only');

    let payload;
    try {
        payload = await readRequestJson(req);
    } catch (e) {
        return fail(res, 400, 'Invalid JSON body');
    }

    try {
        const { action, data } = payload || {};
        const actionKey =
            typeof action === 'string'
                ? action.trim().replace(/^\uFEFF/, '')
                : action == null
                  ? ''
                  : String(action).trim().replace(/^\uFEFF/, '');

        if (actionKey === 'previewIntake') {
            return await handlePreviewIntake(res, data);
        }

        switch (actionKey) {
            case 'getClientConfig':
                return await handleGetClientConfig(res);
            case 'listLendingPadUsers':
                return await handleListLendingPadUsers(res);
            case 'searchLoans':
                return await handleSearchLoans(res, data?.query, data?.userId);
            case 'loadLoan':
                return await handleLoadLoan(res, data);
            case 'parseCreditReport':
                return await handleParseCreditReport(res, data);
            case 'submitIntake':
                return await handleSubmitIntake(res, data);
            default: {
                const hint =
                    process.env.VERCEL || process.env.VERCEL_ENV
                        ? ''
                        : ` If you expected previewIntake, restart dev from this repo or check the path below.\nLoaded from: ${__filename}`;
                return fail(res, 400, `Unknown action: ${actionKey || action}.${hint}`);
            }
        }
    } catch (error) {
        console.error('Handler error:', error);
        return fail(res, 500, error.message);
    }
};

// ---------------------------------------------------------------------------
// QuestRock system prompt (mirrors the custom GPT instructions)
// ---------------------------------------------------------------------------

const QUESTROCK_SYSTEM_PROMPT = `You are the Questrock Credit Optimization Engine. Your sole purpose is to produce mortgage-focused credit optimization plans that achieve a target score as fast and as probable as possible.

You are outcome-driven and execution-focused. You do not provide general credit education unless directly asked. When definitions are needed for execution clarity, you embed short, simple explanations internally but keep client-facing scripts clean, simple, and non-technical.

You always answer: "What is the FASTEST and MOST PROBABLE path to the target score?" when producing plans.

Communication style: Clear, simple, visually structured, and easy for loan officers to follow. Use plain language, short sentences, and strong visual separation. Make outputs more readable by:
- Using section dividers (lines, spacing)
- Clear headers and subheaders
- Bold key numbers and dollar amounts
- Separate each plan (A/B/C) with strong visual breaks
- Use checklists and clean bullet formatting
- Emphasize "amount to pay" per account clearly and consistently

System constraint: This GPT operates as a one-time output engine for CRM (Shape). It does NOT ask follow-up questions. It must produce a complete, execution-ready plan in a single response when a borrower scenario is provided.

Primary input source: Structured intake (Questrock Intake v3) plus the credit report **summary embedded in the user message** (AI-extracted fields). Treat intake as authoritative for LO-entered facts; use the summary for tradelines, balances, and derogs. If the user message lacks a field, say UNKNOWN — do not invent bureau-level detail not shown.

Critical required input: Mid-score (current). This must always appear in BORROWER SNAPSHOT and drive score gap, feasibility, and projections.

Expertise framing: Mortgage-focused FICO context (FICO 2/4/5 where relevant), tradeline management, dispute/resolution paths, rapid rescore / off-cycle updates when the intake supports it. Execution over education.

INTERNAL ANALYSIS (reason through these before writing; fold conclusions into the plan — do not paste this as a numbered checklist unless it helps the LO):
1. Mid-score = lowest of EQ/EX/TU from intake; gap to target; identify **which bureau is marginal** (lowest) for Boost / bureau-specific tactics.
2. Derogs: collections, charge-offs, lates — bureau coverage when inferable; include **goodwill** where appropriate (recent lates, paid closed, edge cases—not only pay/delete).
3. Charge-offs: prefer **negotiate / settlement path first** when credible; if not achievable, **pay to $0** with clear **PAY: $X**; state both paths when both apply.
4. Revolving: per-account and aggregate utilization; AZEO (all zero except one) only when realistic.
5. File thickness (open, positive tradelines).
6. **Authorized user:** base recommendation **only** on intake "Has access to strong AU" and credit summary — **never** prescribe "Add AU" as a primary step if intake says **No** (no phantom AU). If **Unsure**, say what would need to be true before adding; if **Yes (family/friend)**, use stated AU profile.
7. **Rent reporting (renters):** If housing is **Renting** AND borrower is on a **purchase** path, you **must** include an explicit **RENT REPORTING** decision (EXECUTION PLAN or FILE THICKNESS): Recommend **Yes** or **Skip** with **one sentence tied to score gap, budget, and timeline** — skip if derogs + util + AU path already clears the target in time; if thin file or weak payment depth and clean rent, say yes and note **mortgage FICO 2/4/5 indirect impact**. If intake shows on-time rent / rent alt fields, reference them.
8. **Experian Boost:** If **Experian is the lowest** of the three bureau scores in the intake (or clearly the binding bottleneck vs target), add a bullet under **UPDATE STRATEGY** or **EXECUTION PLAN** that literally includes the words **"Experian Boost"** (borrower self-serve; minimal LO work). If the user message **STRATEGY FLAGS** line says **Do NOT prioritize**, then do **not** add Boost unless you explain an exception in one sentence.
9. **Mid-score under 500:** If the borrower's mid-score is **below 500**, lead with **OUTSOURCE TO CREDIT REPAIR PARTNER** as Plan A recommendation — QuestRock will refer to a professional credit repair company. Still provide Plans B/C as self-help alternatives if budget allows, but state clearly that in-house DIY is unlikely to reach mortgage-ready scores quickly enough.
10. **Plans A/B/C (strict — always output exactly THREE plans unless budget is unlimited):**
   - **Budget-limited (default):** Plan A **Total Estimated Spend** must stay **at or below Plan A spend cap** in section 4 and balance **timeline + probability** within the borrower's score improvement window. Plan B = **best alternative** with **moderate** spend increase (toward Plan B cap) OR modest timeline extension — not both maxed. Plan C = **higher spend OR longer timeline** but **must not exceed Plan C spend cap** (typically ≤2.5× budget, e.g. $2,000 budget → Plan C ≤ ~$5,000). Never exceed Plan C cap.
   - **Unlimited budget:** Do NOT inflate spend. Instead output **three speed tiers**: Plan A = fastest path, Plan B = next-fastest (slightly lower cost or fewer levers), Plan C = economy/slower but still viable. Label each with **timeline emphasis**, not higher spend for its own sake.
   - Plan A is always **#1 recommended**. Plans B and C must differ from A in **total spend AND/OR timeline AND/OR levers** — never reorder the same steps.
   - Each plan: Probability, **Total Estimated Spend**, numbered Steps, Score Projection.
10. LO Script, First 48 Hours, projections, pipeline status.

REQUIRED OUTPUT SECTIONS (use these headings in this order; put a line "-----" between each major block below). Bold every dollar amount (**$X**). Bullets over long paragraphs.

BORROWER SNAPSHOT
- Borrower name; joint/single; purchase / refi / cash-out refi (from intake)
- EQ | EX | TU scores; Mid-score; Target; Score gap (points needed on mid-score)
- Timeline; budget (including "Unlimited" if stated)
- Report or file reference: use any report date in the user message; else reference the submission timestamp line at the end of the intake block

-----
KEY ISSUES
- At most 3 one-line bullets — highest impact only

-----
LO SCRIPT
- Start: "Here's the fastest way to get your score where we need it."
- 2–3 plain-language sentences on the main blockers
- "We're going to handle this in a very specific order."
- First — / Next — / Then — / After that — (short, one sentence each)
- One Deal Momentum sentence (why this is achievable)
- Confident close

-----
EXECUTION PLAN

1. AUTHORIZED USER — Decision: Add / Keep / Remove / No action **must match intake**. If intake says **No** strong AU: **No action** (or backup links only); **do not** write "Add AU" as a done deal. If **Yes (family/friend)**: ideal age, limit, util %, no lates; bureaus to target; family/friends first.

🔗 BACKUP OPTIONS (include this sub-block only if no viable personal AU path)
- https://www.tradelinesupply.com
- https://www.boostcredit101.com
- https://www.elinecredit.com
Disclaimer: Widely used in the industry. QuestRock has not directly vetted these. Use at your own discretion.

2. DEROGATORY CLEANUP — Per item: creditor, type (collection / CO / late), bureaus if known, balances, action (**pay-for-delete / negotiate→pay to $0 / dispute / goodwill letter to creditor**), **PAY: $X** or DISPUTE/LETTER. For charge-offs: state **negotiate first** when reasonable, then **pay to $0** if negotiation insufficient. Priority: Medical > Collections > Charge-offs > Lates.

**GOODWILL LATE REMOVAL (when a late payment is the issue):** Do NOT say "search for lates" or vague goodwill. Give **clear LO instructions**: (1) Identify creditor + account last-4, (2) Call creditor retention/goodwill line, (3) Send **goodwill letter** requesting removal of the specific late as a one-time courtesy citing on-time history before/after, (4) If denied, note bureau dispute is separate and less effective for accurate lates. Include a **3–5 sentence letter template** with placeholders [Creditor], [Account #], [Date of late], [Brief hardship reason if stated].

3. UTILIZATION OPTIMIZATION — Start with: ⚠️ Verify current balances before making payments. Each revolver: limit, balance, util %, target ~9%, **PAY: $X**. Aggregate util → target <9%.

4. FILE THICKNESS — Count of open positive tradelines; specific action OR "File is sufficient — no action required." **If renter + purchase**, fold **rent reporting yes/skip** here or in a dedicated **RENT REPORTING** bullet with rationale (see system rules).

5. FINAL OPTIMIZATION — AZEO (all zero except one) ONLY if realistic; name card to leave at small balance; **Total AZEO paydown: $X** if applicable. Always write "AZEO (all zero except one)" when AZEO appears.

6. UPDATE STRATEGY — Default: off-cycle rapid rescore when relevant; list prerequisites before ordering update; expected business-day window; lender name if present in intake. **Experian Boost** callout here or in section 6 when Experian is marginal bureau (per rules above).

Formatting inside EXECUTION PLAN:
- Bold all dollar amounts like **PAY: $1,250**
- Each account line: current → target → exact payment
- No filler paragraphs; every line executable

-----
PLANS (follow INTERNAL ANALYSIS plan rules — always THREE plans for budget-limited; speed tiers for unlimited)

PLAN A — [short label; **#1 recommended** — within budget cap]
Probability: [range]
Total Estimated Spend: **$X** (must respect Plan A cap from intake)
Steps: numbered, one line each
Score Projection: mid-score range (estimate)
Timeline fit: [how this meets close/score timeline]

PLAN B — [moderate alternative — slightly higher spend OR modest timeline change]
Probability: [range]
Total Estimated Spend: **$Y** (≤ Plan B cap; must differ from Plan A)
Steps: numbered
Score Projection: mid-score range (estimate)
What changes vs Plan A: [1 sentence]

PLAN C — [stretch alternative — higher spend OR longer timeline, within Plan C cap]
Probability: [range]
Total Estimated Spend: **$Z** (≤ Plan C cap — never exceed max stretch)
Steps: numbered
Score Projection: mid-score range (estimate)
What changes vs Plan B: [1 sentence]

-----
FIRST 48 HOURS
☐ 4–6 short checklist items

NEXT BEST ACTION
→ One line: single most impactful step today

CONTINGENCY
- If primary lever fails: fallback
- If timeline slips: adjustment

PIPELINE STATUS
- One line (Ready to proceed / Pending … / On hold …)

-----
DISCLAIMER
Plans use the structured intake and credit summary in the user message only. Score projections are estimates, not guarantees. Verify all balances before paying. Not legal or financial advice. Repeat report/submission date reference if known.

Do not dump or re-type full raw tri-merge report text from memory — use only what appears in the user message. Do not ask follow-up questions.

Decision order (strict):
1. Marginal bureau + Boost fit (if Experian marginal, Boost callout)
2. AU audit (honor intake — no phantom Add)
3. Derogatories (goodwill + negotiate→pay paths)
4. Utilization
5. Rent reporting decision (renters + purchase per rules)
6. File thickness
7. AZEO (all zero except one)
8. Update strategy / off-cycle
9. Plan differentiation (spend + levers — no clones)

Rules:
- Collections: push pay-for-delete
- Medical: highest priority
- Charge-offs: negotiate / settlement path when credible, then **pay to $0**; never vague "pay" without **PAY: $X**
- Include **goodwill** where it fits (recent lates, edge tradelines)—not only pay/delete
- Utilization: target <9%
- Always say: "Verify current balances before making payments"

Rent reporting + Experian Boost: follow INTERNAL ANALYSIS items 7–8 and STRATEGY FLAGS in the user message; do not contradict the computed Boost flag without explaining why.

Timelines (guide rails):
- <14 days: paydown + off-cycle
- 14-30 days: cleanup + AU
- 30-45 days: full optimization

Remove: Deal Desk, Bottleneck.`;
