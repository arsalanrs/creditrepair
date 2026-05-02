#!/usr/bin/env node
'use strict';

/**
 * Verifies `public.jobs` and `public.intake_submissions` + RLS for a real user.
 * Set in .env:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_TEST_EMAIL, SUPABASE_TEST_PASSWORD
 */
const path = require('path');
try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {}

const {
    signInWithPassword,
    saveJobsAndIntakeSubmission
} = require('./supabase-intake-save.cjs');

const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const anon = (process.env.SUPABASE_ANON_KEY || '').trim();
const email = (process.env.SUPABASE_TEST_EMAIL || '').trim();
const password = process.env.SUPABASE_TEST_PASSWORD || '';

function fail(msg, code = 1) {
    console.error(msg);
    process.exit(code);
}

async function main() {
    if (!url || !anon) {
        fail('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env — fill them from Supabase → Project Settings → API.');
    }
    if (!email || !password) {
        fail(
            'Missing SUPABASE_TEST_EMAIL or SUPABASE_TEST_PASSWORD in .env.\n' +
                'Add a real Supabase Auth user (Authentication → Users) and put email/password here for this check only.'
        );
    }

    let accessToken;
    let userId;
    try {
        const auth = await signInWithPassword(url, anon, email, password);
        accessToken = auth.accessToken;
        userId = auth.userId;
    } catch (e) {
        fail(`Auth failed: ${e.message}`);
    }

    const payload = {
        fullName: 'verify-supabase-jobs script',
        creditReport: null,
        source: 'verify-supabase-jobs.cjs'
    };
    const analysis = 'Smoke test row — safe to delete in Table Editor.';

    const { jobs, submissions } = await saveJobsAndIntakeSubmission(
        url,
        anon,
        accessToken,
        userId,
        'preview',
        payload,
        analysis
    );

    if (!jobs.ok) {
        fail(
            `Insert into jobs failed (${jobs.status}): ${jobs.body}\n` +
                'If the table is missing, run supabase/schema.sql in the SQL editor.'
        );
    }
    if (!submissions.ok) {
        fail(
            `Insert into intake_submissions failed (${submissions.status}): ${submissions.body}\n` +
                'If the table is missing, run the intake_submissions section of supabase/schema.sql.'
        );
    }

    const sel = await fetch(
        `${url}/rest/v1/jobs?user_id=eq.${userId}&select=id,borrower_name,kind&order=created_at.desc&limit=3`,
        {
            headers: { apikey: anon, Authorization: `Bearer ${accessToken}` }
        }
    );
    if (!sel.ok) {
        fail(`Select jobs failed (${sel.status}): ${await sel.text()}`);
    }

    console.log('Supabase jobs + intake_submissions: OK');
    console.log('- Signed in as:', email);
    console.log('- Recent jobs (up to 3):', await sel.text());
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
