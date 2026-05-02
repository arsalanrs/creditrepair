#!/usr/bin/env node
'use strict';

const path = require('path');

try {
    require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (_) {
    /* optional */
}

const http = require('http');
const fs = require('fs');

/** Fresh backend on every /api call so edits to questrock-backend.js apply without restarting. */
function loadBackendHandler() {
    const abs = path.join(__dirname, 'questrock-backend.js');
    const resolved = require.resolve('./questrock-backend.js');
    delete require.cache[abs];
    delete require.cache[resolved];
    return require(abs);
}

const START_PORT = Number(process.env.PORT) || 3000;
const PORT_TRY_LIMIT = 30;

function mockRes(nodeRes) {
    const api = {
        _code: 200,
        setHeader(name, value) {
            nodeRes.setHeader(name, value);
            return api;
        },
        status(code) {
            api._code = code;
            return api;
        },
        json(data) {
            nodeRes.statusCode = api._code;
            if (!nodeRes.getHeader('Content-Type')) {
                nodeRes.setHeader('Content-Type', 'application/json');
            }
            nodeRes.end(JSON.stringify(data));
        },
        end(chunk) {
            nodeRes.statusCode = api._code;
            nodeRes.end(chunk);
        },
    };
    return api;
}

const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(__dirname, 'questrock-intake.html'), 'utf8'));
        return;
    }

    if (url === '/saved-jobs' || url === '/saved-jobs.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(__dirname, 'saved-jobs.html'), 'utf8'));
        return;
    }

    if (url === '/config/lendingpad-users.json') {
        const p = path.join(__dirname, 'config', 'lendingpad-users.json');
        if (fs.existsSync(p)) {
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(fs.readFileSync(p, 'utf8'));
            return;
        }
        res.writeHead(404);
        res.end('{}');
        return;
    }

    if (url.startsWith('/api')) {
        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'POST only' }));
            return;
        }

        let raw = '';
        for await (const chunk of req) {
            raw += chunk;
        }
        let body = {};
        try {
            body = raw ? JSON.parse(raw) : {};
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
            return;
        }

        const mockReq = { method: req.method, body };
        const mock = mockRes(res);
        try {
            await loadBackendHandler()(mockReq, mock);
        } catch (e) {
            console.error(e);
            if (!res.writableEnded) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        }
        return;
    }

    function mimeForExt(ext) {
        const types = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.webp': 'image/webp'
        };
        return types[ext.toLowerCase()] || 'application/octet-stream';
    }

    function resolvePublicAsset(p) {
        if (p.startsWith('/public/')) {
            const rel = decodeURIComponent(p.slice('/public/'.length));
            if (!rel || rel.includes('..')) return null;
            const fp = path.join(__dirname, 'public', rel);
            if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return fp;
            return null;
        }
        const base = path.basename(p);
        if (!base || base.includes('..') || !/\.(png|jpe?g|gif|svg|ico|webp)$/i.test(base)) return null;
        const pub = path.join(__dirname, 'public', base);
        if (fs.existsSync(pub) && fs.statSync(pub).isFile()) return pub;
        const root = path.join(__dirname, base);
        if (fs.existsSync(root) && fs.statSync(root).isFile()) return root;
        return null;
    }

    const assetPath = resolvePublicAsset(url);
    if (assetPath) {
        res.writeHead(200, { 'Content-Type': mimeForExt(path.extname(assetPath)) });
        res.end(fs.readFileSync(assetPath));
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

function listenFrom(port) {
    if (port > START_PORT + PORT_TRY_LIMIT) {
        console.error(
            `No free port from ${START_PORT} to ${START_PORT + PORT_TRY_LIMIT}. ` +
                `Stop whatever is using those ports (e.g. lsof -i :${START_PORT}) and retry.`
        );
        process.exit(1);
    }

    server.removeAllListeners('error');
    server.removeAllListeners('listening');
    server.once('listening', () => {
        const addr = server.address();
        const bound = typeof addr === 'object' && addr && addr.port != null ? addr.port : port;
        const sb =
            String(process.env.SUPABASE_URL || '').trim() &&
            String(process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
        console.log(`Local dev: http://localhost:${bound}/`);
        console.log(`API: POST http://localhost:${bound}/api (backend reloads from disk each request)`);
        console.log(`[local-dev] __dirname=${__dirname}`);
        console.log(
            sb
                ? '[local-dev] Supabase: URL + anon key loaded from .env (browser sign-in enabled).'
                : '[local-dev] Supabase: MISSING — add SUPABASE_URL and SUPABASE_ANON_KEY to .env next to local-dev.cjs (browser sign-in disabled).'
        );
        if (bound !== START_PORT) {
            console.log(
                `\nUse the URL above in your browser. localhost:${START_PORT} is a different process ` +
                    `and causes "Unknown action: listLendingPadUsers" if you stay on that tab.\n`
            );
        }
    });
    server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(
                `Port ${port} is already in use (another app — not this dev server). Trying ${port + 1}…`
            );
            server.close(() => {
                listenFrom(port + 1);
            });
            return;
        }
        throw err;
    });

    server.listen(port);
}

listenFrom(START_PORT);
