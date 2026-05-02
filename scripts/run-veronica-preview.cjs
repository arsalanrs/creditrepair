#!/usr/bin/env node
'use strict';

/**
 * Smoke test: parse Veronica Rosario credit PDF + previewIntake (OpenAI only, no Zapier).
 *
 * Usage:
 *   node scripts/run-veronica-preview.cjs [path/to/report.pdf]
 *
 * Defaults to repo root: CreditReport_VeronicaRosario_20260427-161818675.pdf.redactable.pdf
 * Requires OPENAI_API_KEY in .env (same as the app).
 *
 * When SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_TEST_EMAIL, and SUPABASE_TEST_PASSWORD
 * are set, also saves the Veronica preview to `jobs` and `intake_submissions` (same as the app).
 */

const fs = require('fs');
const path = require('path');

try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {
    /* optional */
}

const handler = require('../questrock-backend.js');
const {
    signInWithPassword,
    saveJobsAndIntakeSubmission
} = require('./supabase-intake-save.cjs');

const JESSICA_SHERARD = {
    id: '28123ba0-ed9e-4e14-a35a-17648d94a788',
    name: 'Jessica Sherard'
};

const DEFAULT_PDF = path.join(
    __dirname,
    '..',
    'CreditReport_VeronicaRosario_20260427-161818675.pdf.redactable.pdf'
);

function createMockRes() {
    const api = {
        _code: 200,
        result: null,
        setHeader() {
            return api;
        },
        status(c) {
            api._code = c;
            return api;
        },
        json(data) {
            api.result = { httpStatus: api._code, ...data };
        }
    };
    return api;
}

async function call(action, data) {
    const res = createMockRes();
    await handler(
        { method: 'POST', body: { action, data } },
        res
    );
    if (!res.result) throw new Error('No response from handler');
    return res.result;
}

function buildIntakePayload(creditReport) {
    return {
        fullName: 'Veronica Rosario',
        applicationType: 'Single',
        loanPurpose: 'Purchase',
        loanType: 'Conventional',
        housingStatus: 'Renting',
        monthlyRent: '2200',
        rentPayments: 'Yes',
        currentScore: '639',
        targetScore: '700',
        idealScore: '720',
        repairGoal: ['Approval', 'Better Pricing'],
        closeTimeline: '30-45 days',
        scoreTimeline: '30 days',
        totalBudget: '999999',
        immediateCash: '50000',
        maxWilling: '999999',
        immediateAction: 'Yes (same day)',
        comfortableCalling: 'Yes',
        needsGuidance: 'No',
        willingCollections: 'Yes',
        willingChargeoffs: 'Yes',
        refusedAccounts: 'None',
        hasAU: 'Yes (family/friend)',
        auAge: '8',
        auLimit: '15000',
        auUtilization: '5',
        auLateHistory: 'No',
        isRenting: 'Yes',
        monthlyRentAlt: '2200',
        onTimePayments: 'Yes',
        utilitiesInName: 'Yes',
        biggestConcern: 'Reach 700 mid-score for purchase; off-cycle update requested.',
        alreadyTried: 'Nothing',
        knownIssues: 'None',
        personality: 'Highly motivated',
        urgency: 'High (active contract)',
        lendingPadUserId: JESSICA_SHERARD.id,
        lendingPadUserName: JESSICA_SHERARD.name,
        creditReport
    };
}

async function main() {
    const pdfPath = path.resolve(process.argv[2] || DEFAULT_PDF);
    if (!fs.existsSync(pdfPath)) {
        console.error('PDF not found:', pdfPath);
        process.exit(1);
    }

    if (!process.env.OPENAI_API_KEY) {
        console.error('Missing OPENAI_API_KEY in .env');
        process.exit(1);
    }

    const buf = fs.readFileSync(pdfPath);
    const pdfBase64 = buf.toString('base64');
    console.log('PDF:', pdfPath, 'bytes:', buf.length);

    console.log('\n--- parseCreditReport ---');
    const parsed = await call('parseCreditReport', { pdfBase64 });
    if (!parsed.success) {
        console.error('parseCreditReport failed:', parsed.error);
        process.exit(1);
    }
    const cr = parsed.creditReport || {};
    cr.scores = {
        equifax: 639,
        experian: 646,
        transunion: 714,
        ...(cr.scores || {})
    };
    console.log('Parsed scores (snapshot aligned):', cr.scores);

    console.log('\n--- previewIntake ---');
    const preview = await call('previewIntake', buildIntakePayload(cr));
    if (!preview.success) {
        console.error('previewIntake failed:', preview.error);
        process.exit(1);
    }

    const text = preview.aiAnalysis || '';
    console.log('\n=== AI analysis (complete) ===\n');
    console.log(text);

    const outFile = path.join(__dirname, 'last-preview-output.txt');
    fs.writeFileSync(outFile, text, 'utf8');
    console.log('\n---');
    console.log('Also saved to:', outFile, `(${text.length} chars)`);

    const sUrl = (process.env.SUPABASE_URL || '').trim();
    const sAnon = (process.env.SUPABASE_ANON_KEY || '').trim();
    const sEmail = (process.env.SUPABASE_TEST_EMAIL || '').trim();
    const sPass = process.env.SUPABASE_TEST_PASSWORD || '';
    if (sUrl && sAnon && sEmail && sPass) {
        console.log('\n--- Supabase (jobs + intake_submissions) ---');
        try {
            const auth = await signInWithPassword(sUrl, sAnon, sEmail, sPass);
            const intakePayload = buildIntakePayload(cr);
            const { jobs, submissions } = await saveJobsAndIntakeSubmission(
                sUrl,
                sAnon,
                auth.accessToken,
                auth.userId,
                'preview',
                intakePayload,
                text
            );
            if (!jobs.ok) {
                console.error('jobs insert failed:', jobs.status, jobs.body);
                process.exit(1);
            }
            if (!submissions.ok) {
                console.error('intake_submissions insert failed:', submissions.status, submissions.body);
                process.exit(1);
            }
            console.log('Saved Veronica preview as', sEmail, '→ jobs + intake_submissions (see Supabase Table Editor).');
        } catch (e) {
            console.error('Supabase save failed:', e.message || e);
            process.exit(1);
        }
    } else {
        console.log(
            '\n(Skip Supabase save: set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_TEST_EMAIL, SUPABASE_TEST_PASSWORD in .env to mirror the app.)'
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
