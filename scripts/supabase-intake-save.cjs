'use strict';

/**
 * Shared REST helpers for CLI scripts: sign in + dual write to `jobs` and `intake_submissions`.
 */

function sanitizeFormForStorage(payload) {
    if (!payload || typeof payload !== 'object') return {};
    const p = JSON.parse(JSON.stringify(payload));
    if (p.creditReport && typeof p.creditReport === 'object') {
        const cr = p.creditReport;
        p.creditReport = {
            scores: cr.scores || null,
            housingStatus: cr.housingStatus || null,
            summaryOnly: true,
            tradelineCount: Array.isArray(cr.tradelines) ? cr.tradelines.length : undefined
        };
    }
    return p;
}

async function signInWithPassword(baseUrl, anonKey, email, password) {
    const url = baseUrl.replace(/\/$/, '');
    const authRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
            apikey: anonKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password })
    });
    const authJson = await authRes.json().catch(() => ({}));
    if (!authRes.ok) {
        const err = new Error(authJson.msg || authJson.message || `Auth failed (${authRes.status})`);
        err.details = authJson;
        throw err;
    }
    const token = authJson.access_token;
    const userId = authJson.user?.id;
    if (!token || !userId) {
        throw new Error('Auth response missing access_token or user.id');
    }
    return { accessToken: token, userId, email: authJson.user?.email || email };
}

async function restInsert(baseUrl, anonKey, accessToken, table, row) {
    const url = baseUrl.replace(/\/$/, '');
    const res = await fetch(`${url}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            apikey: anonKey,
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
        },
        body: JSON.stringify(row)
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
}

/**
 * Inserts the same logical save as the browser: `jobs` (with borrower_name) + `intake_submissions`.
 */
async function saveJobsAndIntakeSubmission(baseUrl, anonKey, accessToken, userId, kind, payload, aiAnalysis) {
    const form_data = sanitizeFormForStorage(payload);
    const borrower_name =
        typeof payload.fullName === 'string' && payload.fullName.trim()
            ? payload.fullName.trim()
            : null;
    const analysis = typeof aiAnalysis === 'string' ? aiAnalysis : null;

    const jobRow = {
        user_id: userId,
        kind,
        borrower_name,
        form_data,
        ai_analysis: analysis
    };
    const submissionRow = {
        user_id: userId,
        kind,
        form_data,
        ai_analysis: analysis
    };

    const jobs = await restInsert(baseUrl, anonKey, accessToken, 'jobs', jobRow);
    const submissions = await restInsert(baseUrl, anonKey, accessToken, 'intake_submissions', submissionRow);
    return { jobs, submissions };
}

module.exports = {
    sanitizeFormForStorage,
    signInWithPassword,
    saveJobsAndIntakeSubmission
};
