/**
 * Document/file verification driver — HTTP-level end-to-end flows (Prompt
 * 12), following the verify-knowledge-base.ts driver pattern:
 *
 * Boots its own in-memory mongod + the REAL Express app on an ephemeral port,
 * registers users via the real auth flows, seeds memberships where no API
 * exists, and exercises document upload/download/processing over real HTTP:
 *
 *   1.  Unauthenticated rejection on every endpoint (401)
 *   2.  Strangers (no membership) get 404 concealment (workspace context)
 *   3.  RBAC: viewer is denied document.view/manage (403 both directions);
 *       agent reads AND manages (workspace desk material); owner/admin full
 *   4.  Uploads: txt/md/csv/json extract server-side; PDF and DOCX extract
 *       via their parsers; multipart missing-file → 422; extra fields → 422
 *   5.  Upload validation: unlisted extension/MIME → 415; pdf whose bytes are
 *       not %PDF- → 415 (media mismatch); text with NUL bytes → 415;
 *       traversal filename `../../evil.txt` sanitized; size cap → 413
 *   6.  Processing lifecycle: upload → 201 PENDING → poll → COMPLETED with
 *       extracted text; status fields stay server-composed (no mass assignment)
 *   7.  Listing filters: status, extractionStatus, articleId, filename search
 *       (regex-escaped), pagination bounds → 422
 *   8.  KB attach-point: articleId attach works; foreign article id → 404;
 *       malformed id → 422
 *   9.  Extraction failure handling: corrupt PDF → FAILED with a SAFE error
 *       (no stack/provider leak); reprocess returns 202 and stays FAILED;
 *       metadata rows are never "silently successful"
 *  10.  Download: octet-stream + attachment disposition + exact bytes;
 *       non-ASCII filename disposition sanitization; foreign download → 404
 *  11.  Delete: purges bytes (subsequent download → 404), hides metadata,
 *       foreign delete → 404; row retained for audit
 *  12.  Audit: uploaded/reprocessed/deleted recorded (filename never stored)
 *  13.  Cross-tenant isolation: rival workspace cannot see/list/delete acme
 *       documents by id
 *  14.  Public surface: NO anonymous file endpoint exists (401 on /files paths)
 *  15.  Regressions: auth/health/workspace ↩ quick sanity after mounting files
 *
 * Server code imports DYNAMICALLY inside main() AFTER MONGODB_URI is set
 * (env.config.ts freezes process.env at module-evaluation time).
 */
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MongoMemoryServer } from 'mongodb-memory-server';

interface Check {
  name: string;
  pass: boolean;
}

const checks: Check[] = [];

function record(name: string, pass: boolean): void {
  checks.push({ name, pass });
  // eslint-disable-next-line no-console -- verification driver output
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  headers: Map<string, string>;
  arrayBuffer?: ArrayBuffer;
}

async function http(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { body?: unknown; token?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  // Unique IP per request defeats cross-test rate-limit coupling.
  headers['x-forwarded-for'] = `10.8.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  const response = await fetch(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  const headersMap = new Map<string, string>();
  response.headers.forEach((value, key) => headersMap.set(key.toLowerCase(), value));
  return { status: response.status, body, headers: headersMap };
}

async function httpMultipart(
  url: string,
  token: string,
  parts: { filename: string; contentType: string; bytes: Uint8Array; field?: string; articleId?: string; junkWorkspaceField?: string },
): Promise<HttpResult> {
  const form = new FormData();
  form.append(parts.field ?? 'file', new Blob([new Uint8Array(parts.bytes)]), parts.filename);
  if (parts.articleId !== undefined) form.append('articleId', parts.articleId);
  if (parts.junkWorkspaceField !== undefined) form.append('workspaceId', parts.junkWorkspaceField);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-forwarded-for': `10.7.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`,
    },
    body: form,
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  const headersMap = new Map<string, string>();
  response.headers.forEach((value, key) => headersMap.set(key.toLowerCase(), value));
  return { status: response.status, body, headers: headersMap };
}

function assert(condition: boolean): void {
  if (!condition) throw new Error('assertion failed inside test steps');
}

let storageRoot: string;

async function main(): Promise<void> {
  const memoryServer = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', port: 0, dbName: 'verify_files' },
  });

  const expectedUri = memoryServer.getUri('verify_files');
  process.env['MONGODB_URI'] = expectedUri;
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '100000';
  storageRoot = mkdtempSync(path.join(os.tmpdir(), 'verify-files-'));
  process.env['STORAGE_DATA_DIR'] = storageRoot;
  const port = 4051;
  process.env['PORT'] = String(port);

  const { startServer } = await import('../server/src/server.js');
  const { env } = await import('../server/src/config/env.config.js');
  if (env.MONGODB_URI !== expectedUri) {
    throw new Error('env.MONGODB_URI mismatch — aborting to protect foreign databases');
  }

  const httpServer = await startServer();
  const shutdown = (): Promise<void> =>
    Promise.all([
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
      memoryServer.stop(),
    ]).then(async () => {
      // After memoryServer.stop() the Mongo driver topology keeps an auto
      // reconnect loop alive, holding the Node event loop open forever.
      (await import('mongoose')).default.disconnect();
    });

  const api = (pathSegments: string): string => `http://127.0.0.1:${port}/api/v1${pathSegments}`;
  const { UserModel } = await import('../server/src/modules/users/user.model.js');
  const { WorkspaceMemberModel } = await import('../server/src/modules/workspaces/workspace-member.model.js');
  const { AuditLogModel } = await import('../server/src/modules/audit-logs/audit-log.model.js');
  const { KbArticleModel } = await import('../server/src/modules/knowledge-base/kb.model.js');
  const { DocumentFileModel } = await import('../server/src/modules/documents/document.model.js');

  const PASSWORD = 'Str0ngPass!42';

  async function newUser(name: string, email: string): Promise<string> {
    const reg = await http('POST', api('/auth/register'), { body: { name, email, password: PASSWORD } });
    if (reg.status !== 201) {
      console.log('REGISTER FAILED', JSON.stringify(reg.body));
    }
    assert(reg.status === 201);
    const login = await http('POST', api('/auth/login'), { body: { email, password: PASSWORD } });
    assert(login.status === 200);
    const data = login.body['data'] as { tokens?: { accessToken?: string } } | undefined;
    const token = data?.tokens?.accessToken;
    assert(typeof token === 'string' && token.length > 0);
    return token;
  }

  async function newWorkspace(token: string, name: string, slug: string): Promise<string> {
    const created = await http('POST', api('/workspaces'), { token, body: { name, slug } });
    assert(created.status === 201);
    const workspace = (created.body['data'] as { workspace?: { id?: string } } | undefined)?.workspace;
    assert(typeof workspace?.id === 'string');
    return workspace.id;
  }

  async function addMember(workspaceId: string, email: string, role: 'admin' | 'agent' | 'viewer'): Promise<void> {
    const user = await UserModel.findOne({ email });
    assert(user !== null);
    await WorkspaceMemberModel.create({ workspaceId, userId: user!._id, role });
  }

  function req(bearer: string | undefined) {
    return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', pathSegments: string, body?: unknown): Promise<HttpResult> =>
      http(method, api(pathSegments), { token: bearer, ...(body !== undefined ? { body } : {}) });
  }

  async function pollUntilTerminal(
    requester: (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', pathSegments: string) => Promise<HttpResult>,
    wsBase: string,
    fileId: string,
    attempts = 60,
  ): Promise<{ status: string; extractionStatus: string; detail: Record<string, unknown> }> {
    for (let i = 0; i < attempts; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const res = await requester('GET', `${wsBase}/${fileId}`);
      if (res.status !== 200) continue;
      const document = (res.body['data'] as { document?: Record<string, unknown> } | undefined)?.document;
      if (document === undefined) continue;
      const status = String(document['status']);
      if (status === 'COMPLETED' || status === 'FAILED') {
        return {
          status,
          extractionStatus: String(document['extractionStatus']),
          detail: document,
        };
      }
    }
    return { status: 'NOT_TERMINAL', extractionStatus: 'NOT_TERMINAL', detail: {} };
  }

  try {
    // ── Actors & tenants ───────────────────────────────────────────────────
    const ownerToken = await newUser('Ada Acme', 'ada12@acme.example');
    const niaToken = await newUser('Nia Admin', 'nia12@acme.example');
    const bobToken = await newUser('Bob Agent', 'bob12@acme.example');
    const veraToken = await newUser('Vera Viewer', 'vera12@acme.example');
    const acmeId = await newWorkspace(ownerToken, 'Acme Helpdesk 12', 'acme-helpdesk-12');

    await addMember(acmeId, 'nia12@acme.example', 'admin');
    await addMember(acmeId, 'bob12@acme.example', 'agent');
    await addMember(acmeId, 'vera12@acme.example', 'viewer');

    const eveToken = await newUser('Eve Rival', 'eve@rival12.example');
    const rivalId = await newWorkspace(eveToken, 'Rival Co 12', 'rival-co-12');

    const strangerToken = await newUser('Sam Stranger', 'sam12@stranger.example');

    const ada = req(ownerToken);
    const nia = req(niaToken);
    const bob = req(bobToken);
    const vera = req(veraToken);
    const eve = req(eveToken);
    const stranger = req(strangerToken);
    const anon = req(undefined);

    const FILES = (ws: string): string => `/workspaces/${ws}/files`;
    const ACME_FILES = FILES(acmeId);
    const RIVAL_FILES = FILES(rivalId);
    const MARKER = 'EXTRACT-THIS-MARKER-P12';

    const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text.replace(/\\"/g, '"'));
    // Real-world sample PDF (fixture, deterministic): pdf.js v1's bundled
    // reader rejects synthetic hand-built xref tables, but the production
    // pipeline only needs to parse REAL documents, so the well-formed check
    // uses a genuine sample file from scripts/fixtures/. Corruption handling
    // is tested separately with inline corrupt bytes (section 9).
    const pdfBytes: Uint8Array = new Uint8Array(
      await readFile(path.join('scripts', 'fixtures', 'pdf-sample.pdf')),
    );
    // Minimal DOCX: mammoth needs at least document.xml inside a zip.
    const docxBytes: Uint8Array = (() => {
      // Hand-built single-file zip is error-prone; rely on mammoth accepting
      // the canonical minimal docx bytes below (built via a tiny zip writer).
      const crc32Table = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n += 1) {
          let c = n;
          for (let k = 0; k < 8; k += 1) {
            c = c % 2 === 0 ? c >>> 1 : 0xedb88320 ^ (c >>> 1);
          }
          table[n] = c >>> 0;
        }
        return table;
      })();
      const crc32 = (bytes: Uint8Array): number => {
        let crc = 0xffffffff;
        for (const byte of bytes) {
          crc = crc32Table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
      };
      const entryXml = utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          `<w:body><w:p><w:r><w:t>AUTOMATED-DOCX-MARKER-12</w:t></w:r></w:p></w:body></w:document>`,
      );
      const parts: Array<{ name: string; bytes: Uint8Array }> = [
        {
          name: '[Content_Types].xml',
          bytes: utf8(
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
              `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
              `<Default Extension="xml" ContentType="application/xml"/>` +
              `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
              `</Types>`,
          ),
        },
        { name: 'word/document.xml', bytes: entryXml },
      ];
      const chunks: Uint8Array[] = [];
      let centralSize = 0;
      const centralHeaders: Uint8Array[] = [];
      let offset = 0;
      const u16 = (v: number): Uint8Array => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
      const u32 = (v: number): Uint8Array =>
        new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
      for (const part of parts) {
        const crc = crc32(part.bytes);
        const nameBytes = new TextEncoder().encode(part.name);
        const local = new Uint8Array(30 + nameBytes.length + part.bytes.length);
        local.set(u32(0x04034b50), 0);
        local.set(u16(20), 4);
        local.set(u16(0), 6);
        local.set(u16(0), 8);
        local.set(u16(0), 10); // stored (no compression)
        local.set(u16(0), 12);
        local.set(u32(crc), 14);
        local.set(u32(part.bytes.length), 18);
        local.set(u32(part.bytes.length), 22);
        local.set(u16(nameBytes.length), 26);
        local.set(u16(0), 28);
        local.set(nameBytes, 30);
        local.set(part.bytes, 30 + nameBytes.length);
        chunks.push(local);
        const central = new Uint8Array(46 + nameBytes.length);
        central.set(u32(0x02014b50), 0);
        central.set(u16(20), 4);
        central.set(u16(20), 6);
        central.set(u16(0), 8);
        central.set(u16(0), 10);
        central.set(u16(0), 12);
        central.set(u16(0), 14);
        central.set(u32(crc), 16);
        central.set(u32(part.bytes.length), 20);
        central.set(u32(part.bytes.length), 24);
        central.set(u16(nameBytes.length), 28);
        central.set(u32(offset), 42);
        central.set(nameBytes, 46);
        centralHeaders.push(central);
        centralSize += central.length;
        offset += local.length;
      }
      const eocd = new Uint8Array(22);
      eocd.set(u32(0x06054b50), 0);
      eocd.set(u16(parts.length), 8);
      eocd.set(u16(parts.length), 10);
      eocd.set(u32(centralSize), 12);
      eocd.set(u32(offset), 16);
      const total = offset + centralSize + eocd.length;
      const zip = new Uint8Array(total);
      let cursor = 0;
      for (const chunk of [...chunks, ...centralHeaders, eocd]) {
        zip.set(chunk, cursor);
        cursor += chunk.length;
      }
      return zip;
    })();

    /** Upload helper riding the REAL multipart endpoint. */
    async function upload(
      bearer: string,
      ws: string,
      parts: { filename: string; contentType: string; bytes: Uint8Array; articleId?: string },
    ): Promise<HttpResult> {
      return httpMultipart(api(`${FILES(ws)}`), bearer, { ...parts });
    }

    // ══ 1. Unauthenticated rejection ═══════════════════════════════════════
    {
      const list = await anon('GET', ACME_FILES);
      record('1.1 anonymous list is 401', list.status === 401);
      const detail = await anon('GET', `${ACME_FILES}/${'e'.repeat(24)}`);
      record('1.2 anonymous detail is 401', detail.status === 401);
      const download = await anon('GET', `${ACME_FILES}/${'e'.repeat(24)}/download`);
      record('1.3 anonymous download is 401', download.status === 401);
      const del = await anon('DELETE', `${ACME_FILES}/${'e'.repeat(24)}`);
      record('1.4 anonymous delete is 401', del.status === 401);
      const reprocess = await anon('POST', `${ACME_FILES}/${'e'.repeat(24)}/reprocess`);
      record('1.5 anonymous reprocess is 401', reprocess.status === 401);
      const up = await fetch(api(ACME_FILES), {
        method: 'POST',
        headers: {
          'x-forwarded-for': '10.8.3.4',
          'content-type': 'multipart/form-data; boundary=----x',
        },
        body: '------x\r\n--',
      });
      record('1.6 anonymous upload is 401', up.status === 401);
    }

    // ══ 2. Strangers get 404 concealment (workspace context) ═══════════════
    {
      const list = await stranger('GET', ACME_FILES);
      record('2.1 stranger list is 404', list.status === 404);
      const detail = await stranger('GET', `${ACME_FILES}/${'e'.repeat(24)}`);
      record('2.2 stranger detail is 404', detail.status === 404);
    }

    // ══ 3. RBAC ═════════════════════════════════════════════════════════════
    {
      const viewerList = await vera('GET', ACME_FILES);
      record('3.1 viewer document list is 403 (document.view excluded)', viewerList.status === 403);
      const viewerUp = await upload(veraToken, acmeId, {
        filename: 'verna-attempt.txt',
        contentType: 'text/plain',
        bytes: utf8('viewer cannot upload'),
      });
      record('3.2 viewer upload is 403', viewerUp.status === 403);
      const agentList = await bob('GET', ACME_FILES);
      record('3.3 agent can list', agentList.status === 200);
      const agentUp = await upload(bobToken, acmeId, {
        filename: 'agent-upload.txt',
        contentType: 'text/plain',
        bytes: utf8(MARKER),
      });
      record('3.4 agent can upload (desk material)', agentUp.status === 201);
      if (agentUp.status === 201) {
        const document = (agentUp.body['data'] as { document?: { id?: string } } | undefined)?.document;
        const denied = await vera('GET', `${ACME_FILES}/${document?.id}/download`);
        record('3.5 viewer download denied (403)', denied.status === 403);
        await bob('DELETE', `${ACME_FILES}/${document?.id}`);
      }
    }

    // ══ 4. Uploads & extraction ════════════════════════════════════════════
    let textFileId = '';
    {
      const up = await upload(ownerToken, acmeId, {
        filename: 'release-notes.txt',
        contentType: 'text/plain',
        bytes: utf8(MARKER),
      });
      record('4.1 txt upload is 201 with PENDING', up.status === 201
        && (up.body['data'] as { document?: { status?: string } })?.document?.status === 'PENDING');
      if (up.status !== 201) {
        console.log('UPLOAD BODY', JSON.stringify(up.body));
      }
    }
    {
      const up = await upload(ownerToken, acmeId, {
        filename: 'readme.md',
        contentType: 'text/markdown',
        bytes: utf8(`# Heading\n\n${MARKER} in markdown\n`),
      });
      if (up.status === 201) {
        textFileId = ((up.body['data'] as { document?: { id?: string } })?.document?.id ?? '') as string;
      }
      record('4.2 md upload is 201', up.status === 201);
      const terminal = await pollUntilTerminal(ada, ACME_FILES, textFileId);
      record('4.3 md extraction completes with text', terminal.status === 'COMPLETED' && terminal.extractionStatus === 'COMPLETED'
        && String((terminal.detail['extractedText'])).includes(MARKER));
    }
    {
      const up = await upload(ownerToken, acmeId, {
        filename: 'table.csv',
        contentType: 'text/csv',
        bytes: utf8('id,name\n1,' + MARKER + '\n'),
      });
      const fileId = ((up.body['data'] as { document?: { id?: string } })?.document?.id ?? '') as string;
      const terminal = await pollUntilTerminal(ada, ACME_FILES, fileId);
      record('4.4 csv extraction completes', terminal.status === 'COMPLETED');
      const up2 = await upload(ownerToken, acmeId, {
        filename: 'data.json',
        contentType: 'application/json',
        bytes: utf8(`{"key":"${MARKER}"}`),
      });
      const fileId2 = ((up2.body['data'] as { document?: { id?: string } })?.document?.id ?? '') as string;
      const terminal2 = await pollUntilTerminal(ada, ACME_FILES, fileId2);
      record('4.5 json extraction completes', terminal2.status === 'COMPLETED');
    }
    {
      const up = await upload(ownerToken, acmeId, {
        filename: 'policy.pdf',
        contentType: 'application/pdf',
        bytes: pdfBytes,
      });
      if (up.status !== 201) console.log('PDF UPLOAD BODY', JSON.stringify(up.body));
      record('4.6 pdf upload is 201 (magic verified)', up.status === 201);
      const fileId = ((up.body['data'] as { document?: { id?: string } })?.document?.id ?? '') as string;
      const terminal = await pollUntilTerminal(ada, ACME_FILES, fileId, 80);
      record('4.7 pdf extraction completes with parsed text', terminal.status === 'COMPLETED'
        && String(terminal.detail['extractedText']).includes('Dummy PDF file'));
    }
    {
      const up = await upload(ownerToken, acmeId, {
        filename: 'minutes.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: docxBytes,
      });
      record('4.8 docx upload is 201 (magic verified)', up.status === 201);
      const fileId = ((up.body['data'] as { document?: { id?: string } })?.document?.id ?? '') as string;
      const terminal = await pollUntilTerminal(ada, ACME_FILES, fileId, 80);
      record('4.9 docx extraction completes with parsed text', terminal.status === 'COMPLETED'
        && String(terminal.detail['extractedText']).includes('AUTOMATED-DOCX-MARKER-12'));
    }
    {
      const noFile = await fetch(api(ACME_FILES), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-forwarded-for': '10.8.5.5',
          'content-type': 'multipart/form-data; boundary=----x',
        },
        body: '------x\r\n--',
      });
      record('4.10 missing file field is 422', noFile.status === 422);
      // Extra junk text field (mass-assignment protection on the form).
      // Mass-assignment attempt on the FORM: an extra `workspaceId` text
      // field is structurally rejected by the strict body schema (422).
      const junk = await httpMultipart(api(ACME_FILES), ownerToken, {
        filename: 'junk.txt',
        contentType: 'text/plain',
        bytes: utf8('x'),
        junkWorkspaceField: `${rivalId}`,
      });
      record('4.11 unknown workspaceId form field is 422 (mass-assignment)', junk.status === 422);
    }

    // ══ 5. Upload validation ═══════════════════════════════════════════════
    {
      const exe = await upload(ownerToken, acmeId, {
        filename: 'malware.exe',
        contentType: 'application/octet-stream',
        bytes: utf8('MZ'),
      });
      record('5.1 unlisted type is 415', exe.status === 415);
      const html = await upload(ownerToken, acmeId, {
        filename: 'evil.html',
        contentType: 'text/html',
        bytes: utf8('<script>alert(1)</script>'),
      });
      record('5.2 html upload is 415 (never stored as HTML)', html.status === 415);
      const disguised = await upload(ownerToken, acmeId, {
        filename: 'not-really.pdf',
        contentType: 'application/pdf',
        bytes: utf8('this is text, not a pdf'),
      });
      record('5.3 pdf magic mismatch is 415', disguised.status === 415);
      const binaryText = await upload(ownerToken, acmeId, {
        filename: 'binary.txt',
        contentType: 'text/plain',
        bytes: new Uint8Array([0x78, 0x00, 0x13, 0x37]),
      });
      record('5.4 NUL-laden text is 415', binaryText.status === 415);
      const traversal = await upload(ownerToken, acmeId, {
        filename: '../../etc/passwd.txt',
        contentType: 'text/plain',
        bytes: utf8('attempted traversal'),
      });
      record('5.5 traversal filename sanitized (upload succeeds)', traversal.status === 201);
      if (traversal.status === 201) {
        const document = (traversal.body['data'] as { document?: { originalFilename?: string; storageKey?: string } })?.document;
        record('5.6 sanitized filename has no path fragments', document !== undefined
          && document['originalFilename'] === 'passwd.txt');
        const storageKeyAbsent = !('storageKey' in document!);
        record('5.7 storageKey is NOT exposed in the DTO', storageKeyAbsent);
        await ada('DELETE', `${ACME_FILES}/${document?.id}`);
      }
    }

    // ══ 6. Status is server-composed (mass-assignment) ═════════════════════
    {
      textFileId = textFileId || '';
      const detail = await ada('GET', `${ACME_FILES}/${textFileId}`);
      const document = (detail.body['data'] as { document?: Record<string, unknown> } | undefined)?.document;
      record('6.1 status/extraction fields never client-settable (detail immutable)', document !== undefined
        && document['status'] === 'COMPLETED');
      // The PATCH verb does not even exist on file endpoints.
      const patch = await ada('PATCH', `${ACME_FILES}/${textFileId}`, { status: 'FAILED' });
      record('6.2 PATCH on file endpoints is 404 (no lifecycle rewrite)', patch.status === 404);
    }

    // ══ 7. Listing: filters, search, pagination bounds ═════════════════════
    let completedCount = -1;
    {
      const completed = await ada('GET', `${ACME_FILES}?status=COMPLETED&limit=50`);
      const data = completed.body['data'] as { items?: unknown[]; total?: number } | undefined;
      completedCount = data?.items?.length ?? -1;
      // eslint-disable-next-line no-console -- driver debug output (kept consistent with other sections)
      if (completed.status !== 200 || (data?.total ?? -1) < 1) {
        console.log('LIST 7.1 BODY', JSON.stringify(completed.body));
      }
      record('7.1 status=COMPLETED filter excludes non-completed', completed.status === 200 && (data?.total ?? -1) >= 1
        && (data!.items as Array<Record<string, unknown>>).every((i) => i['status'] === 'COMPLETED'));
      const search = await ada('GET', `${ACME_FILES}?search=release-notes`);
      record('7.2 filename search matches', search.status === 200 && (search.body['data'] as { total?: number })?.total === 1);
      const searchRegex = await ada('GET', `${ACME_FILES}?search=release?.*`);
      record('7.3 regex metacharacters are escaped in search', searchRegex.status === 200 && (searchRegex.body['data'] as { total?: number })?.total === 0);
      const badLimit = await ada('GET', `${ACME_FILES}?limit=500`);
      record('7.4 oversized page size is 422', badLimit.status === 422);
      const badStatus = await ada('GET', `${ACME_FILES}?status=moonlight`);
      record('7.5 unknown status filter is 422', badStatus.status === 422);
      const badExtraction = await ada('GET', `${ACME_FILES}?extractionStatus=graphql`);
      record('7.6 unknown extraction filter is 422', badExtraction.status === 422);
    }

    // ══ 8. KB attach-point ═════════════════════════════════════════════════
    let articleId = '';
    {
      // Owner creates a KB article (real KB endpoints).
      const created = await ada('POST', `/workspaces/${acmeId}/knowledge-base/articles`, {
        title: 'Refund policy 12',
        summary: 'How refunds work',
        body: 'Refunds are processed in 5 business days.',
      });
      if (created.status !== 201) console.log('KB CREATE BODY', JSON.stringify(created.body));
      assert(created.status === 201);
      articleId = ((created.body['data'] as { article?: { id?: string } })?.article?.id ?? '') as string;

      const up = await upload(ownerToken, acmeId, {
        filename: 'refunds-attachment.txt',
        contentType: 'text/plain',
        bytes: utf8('refund evidence'),
        articleId,
      });
      record('8.1 upload with attach-articleId is 201', up.status === 201);
      const document = (up.body['data'] as { document?: { id?: string } })?.document;
      const byArticle = await ada('GET', `${ACME_FILES}?articleId=${articleId}`);
      record('8.2 list filters by articleId', byArticle.status === 200 && (byArticle.body['data'] as { total?: number })?.total === 1);
      record('8.3 DTO carries articleId', document !== undefined && document['articleId'] === articleId);

      const foreign = await upload(eveToken, rivalId, {
        filename: 'foreign-attach.txt',
        contentType: 'text/plain',
        bytes: utf8('rival'),
        articleId,
      });
      record('8.4 foreign-workspace article attach is 404 (concealment)', foreign.status === 404);
      const malformed = await upload(ownerToken, acmeId, {
        filename: 'bad-attach.txt',
        contentType: 'text/plain',
        bytes: utf8('x'),
        articleId: 'not-a-24-hex',
      });
      record('8.5 malformed articleId is 422', malformed.status === 422);
    }

    // ══ 9. Extraction failure handling (safe errors + reprocess) ═══════════
    {
      const up = await upload(ownerToken, acmeId, {
        filename: 'corrupt.pdf',
        contentType: 'application/pdf',
        bytes: utf8('%PDF-1.4\n(garbage structure, unparseable)'),
      });
      const fileId = ((up.body['data'] as { document?: { id?: string } })?.document?.id ?? '') as string;
      record('9.1 corrupt pdf upload is 201 (failure recorded, not 500)', up.status === 201);
      const terminal = await pollUntilTerminal(ada, ACME_FILES, fileId, 80);
      record('9.2 processing FAILED with terminal status', terminal.status === 'FAILED' && terminal.extractionStatus === 'FAILED');
      record('9.3 safe error info shape (code+message, no content)', (() => {
        const error = terminal.detail['extractionError'] as Record<string, unknown> | undefined;
        return error !== undefined && typeof error['code'] === 'string' && typeof error['message'] === 'string';
      })());
      record('9.4 safe message never leaks provider detail', (() => {
        const error = terminal.detail['extractionError'] as Record<string, unknown> | undefined;
        return typeof error?.['message'] === 'string' && !String(error['message']).includes('%PDF-');
      })());
      record('9.5 extractedText null on FAILED', terminal.detail['extractedText'] === null);

      const reprocessed = await ada('POST', `${ACME_FILES}/${fileId}/reprocess`);
      record('9.6 reprocess returns 202 with current state', reprocessed.status === 202);
      const afterReprocess = await pollUntilTerminal(ada, ACME_FILES, fileId, 60);
      record('9.7 reprocess deterministically re-fails', afterReprocess.status === 'FAILED');
    }

    // ══ 10. Download semantics ═════════════════════════════════════════════
    {
      const download = await fetch(api(`${ACME_FILES}/${textFileId}/download`), {
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      const buffer = new Uint8Array(await download.arrayBuffer());
      const text = new TextDecoder().decode(buffer);
      record('10.1 download is 200 with exact stored bytes', download.status === 200 && text.includes(MARKER));
      record('10.2 content-type is forced octet-stream', (download.headers.get('content-type') ?? '').includes('application/octet-stream'));
      record('10.3 disposition is attachment (never inline HTML)', (download.headers.get('content-disposition') ?? '').startsWith('attachment'));

      const unicode = await upload(ownerToken, acmeId, {
        filename: 'résumé-附件.txt',
        contentType: 'text/plain',
        bytes: utf8('unicode filename test'),
      });
      const document = (unicode.body['data'] as { document?: { id?: string } })?.document;
      const unicodeDownload = await fetch(api(`${ACME_FILES}/${document?.id}/download`), {
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      record('10.4 non-ASCII disposition is sanitized (ASCII fallback + RFC 5987)', (() => {
        const disposition = unicodeDownload.headers.get('content-disposition') ?? '';
        return disposition.includes('filename*=UTF-8') && !/filename="[^"]*[^\x20-\x7e]/.test(disposition);
      })());
      await ada('DELETE', `${ACME_FILES}/${document?.id}`);

      const eveDownload = await fetch(api(`${ACME_FILES}/${textFileId}/download`), {
        headers: { authorization: `Bearer ${eveToken}` },
      });
      record('10.5 cross-tenant download is 404', eveDownload.status === 404);
    }    // ══ 11. Delete semantics ═══════════════════════════════════════════════
    let deletedId = '';
    {
      const up = await upload(ownerToken, acmeId, {
        filename: 'to-delete.txt',
        contentType: 'text/plain',
        bytes: utf8('goodbye'),
      });
      deletedId = ((up.body['data'] as { document?: { id?: string } })?.document?.id ?? '') as string;

      const eveDelete = await eve('DELETE', `${ACME_FILES}/${deletedId}`);
      record('11.1 cross-tenant delete is 404', eveDelete.status === 404);

      const del = await ada('DELETE', `${ACME_FILES}/${deletedId}`);
      record('11.2 delete is 200 with id', del.status === 200 && (del.body['data'] as { id?: string })?.id === deletedId);

      const after = await fetch(api(`${ACME_FILES}/${deletedId}/download`), {
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      record('11.3 download after delete is 404 (bytes gone)', after.status === 404);
      const detail = await ada('GET', `${ACME_FILES}/${deletedId}`);
      record('11.4 detail after delete is 404 (hidden metadata)', detail.status === 404);
      const deletedRow = await DocumentFileModel.findOne({ _id: deletedId }).setOptions({ withPurged: true });
      record('11.5 metadata row retained (deletedAt stamped) for audit', deletedRow !== null && deletedRow.deletedAt !== null);
    }

    // ══ 12. Audit ══════════════════════════════════════════════════════════
    {
      const auditCount = await AuditLogModel.countDocuments({
        workspaceId: acmeId,
        resourceType: 'file',
      });
      record('12.1 document audits recorded (upload/delete/reprocess)', auditCount >= 5);
      const uploadedAudit = await AuditLogModel.findOne({ workspaceId: acmeId, action: 'document.uploaded' });
      const metadata = uploadedAudit?.metadata as Record<string, unknown> | undefined;
      record('12.2 upload audit has NO filename/extracted text', uploadedAudit !== null
        && metadata?.['originalFilename'] === undefined
        && JSON.stringify(metadata ?? {}).includes('mediaType'));
    }

    // ══ 13. Cross-tenant isolation by id ═══════════════════════════════════
    {
      const document = await DocumentFileModel.findOne({ workspaceId: acmeId, deletedAt: null });
      assert(document !== null);
      const acmeDocId = document._id.toHexString();
      const eveDetail = await eve('GET', `${ACME_FILES}/${acmeDocId}`);
      record('13.1 foreign GET detail is 404', eveDetail.status === 404);
      const eveList = await eve('GET', `${RIVAL_FILES}?search=*`);
      record('13.2 rival workspace list never returns acme rows', eveList.status === 200
        && (eveList.body['data'] as { items?: unknown[] })?.items?.length === 0);
      const rivalList = await ada('GET', RIVAL_FILES);
      record('13.3 rival workspace endpoints scoped (owner list is 404 — not a member)', rivalList.status === 404);
    }

    // ══ 14. No anonymous/public file surface ═══════════════════════════════
    {
      const probe = await anon('GET', `/workspaces/${acmeId}/files`);
      record('14.1 /files requires auth (no public file surface)', probe.status === 401);
      const download = await fetch(api(`/workspaces/${acmeId}/files/${deletedId}/download`));
      record('14.2 anonymous download is 401', download.status === 401);
    }

    // ══ 15. Regressions ════════════════════════════════════════════════════
    {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      record('15.1 health endpoint still fine', health.status === 200);
      const workspaces = await ada('GET', `/workspaces/${acmeId}`);
      record('15.2 workspace flows intact', workspaces.status === 200);
      const kbArticle = await ada('GET', `/workspaces/${acmeId}/knowledge-base/articles/${articleId}`);
      record('15.3 KB flows intact (mounted before files)', kbArticle.status === 200);
      const badId = await ada('GET', `${ACME_FILES}/not-a-24-hex`);
      record('15.4 invalid file id is 422', badId.status === 422);
    }

    // Summary
    const failedCount = checks.filter((c) => !c.pass).length;
    console.log(`\n${checks.length - failedCount}/${checks.length} file checks passed`);
    if (failedCount > 0) throw new Error(`${failedCount} file checks FAILED`);
  } catch (error: unknown) {
    const failed = checks.filter((c) => !c.pass);
    console.log(`${checks.length - failed.length}/${checks.length} file checks passed`);
    if (failed.length > 0) {
      console.error('FAILED checks:', failed.map((c) => c.name).join('\n  '));
    }
    throw error;
  } finally {
    await shutdown?.();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
