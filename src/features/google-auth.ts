import { shell } from 'electron';
import http from 'http';
import crypto from 'crypto';
import url from 'url';
function createCodeVerifier() {
    return crypto.randomBytes(32).toString('hex');
}

function createCodeChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function loginWithGoogle(clientId, clientSecret, scope = 'email profile') {
    return new Promise((resolve, reject) => {
        const codeVerifier = createCodeVerifier();
        const codeChallenge = createCodeChallenge(codeVerifier);

        const server = http.createServer();

        // Track connections so we can forcefully close them on cleanup
        const connections = {};
        server.on('connection', (conn) => {
            const key = conn.remoteAddress + ':' + conn.remotePort;
            connections[key] = conn;
            conn.on('close', () => { delete connections[key]; });
        });
        (server as any).destroyAllConnections = () => {
            for (const key in connections) connections[key].destroy();
        };

        server.on('request', async (req, res) => {
            const reqUrl = url.parse(req.url, true);
            if (reqUrl.pathname !== '/') {
                res.writeHead(404);
                res.end();
                return;
            }

            const authCode = reqUrl.query.code;
            const error = reqUrl.query.error;

            if (authCode) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`<html>
                    <head><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#141414;color:#fff;}</style></head>
                    <body><div style="text-align:center;"><h1>Authentication Successful!</h1><p>You can now close this tab and return to Northstar.</p></div></body>
                </html>`);

                const port = (server.address() as any).port;
                const redirectUri = `http://127.0.0.1:${port}`;
                server.close();
                (server as any).destroyAllConnections();

                try {
                    const tokenResponse = await exchangeCodeForToken(authCode, redirectUri, clientId, clientSecret, codeVerifier);
                    resolve(tokenResponse);
                } catch (err) {
                    reject(err);
                }
            } else if (error) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(`<html>
                    <head><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#141414;color:#fff;}</style></head>
                    <body><div style="text-align:center;"><h1 style="color:#e74c3c;">Authentication Failed</h1><p>Error: ${error}</p><p>You can close this tab and try again.</p></div></body>
                </html>`);
                server.close();
                (server as any).destroyAllConnections();
                reject(new Error(`OAuth Error: ${error}`));
            }
        });

        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as any).port;
            const redirectUri = `http://127.0.0.1:${port}`;

            const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            authUrl.searchParams.append('client_id',             clientId);
            authUrl.searchParams.append('redirect_uri',          redirectUri);
            authUrl.searchParams.append('response_type',         'code');
            authUrl.searchParams.append('scope',                 scope);
            authUrl.searchParams.append('code_challenge',        codeChallenge);
            authUrl.searchParams.append('code_challenge_method', 'S256');
            authUrl.searchParams.append('access_type',           'offline');
            authUrl.searchParams.append('prompt',                'consent');

            shell.openExternal(authUrl.href);
        });

        setTimeout(() => {
            if (server.listening) {
                server.close();
                (server as any).destroyAllConnections();
                reject(new Error('OAuth flow timed out'));
            }
        }, 5 * 60 * 1000);
    });
}

async function exchangeCodeForToken(authCode, redirectUri, clientId, clientSecret, codeVerifier) {
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type:    'authorization_code',
            code:          authCode,
            redirect_uri:  redirectUri,
            client_id:     clientId,
            client_secret: clientSecret,
            code_verifier: codeVerifier,
        }).toString(),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Token exchange failed — ${response.status}: ${body}`);
    }

    return response.json();
}

export { loginWithGoogle };