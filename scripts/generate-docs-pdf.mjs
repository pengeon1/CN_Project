/**
 * @fileoverview Generates docs/technical_documentation.pdf using Chromium/Edge or local Electron print-to-pdf.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const mdPath = path.join(rootDir, 'docs', 'technical_documentation.md');
const htmlPath = path.join(rootDir, 'docs', 'technical_documentation.html');
const pdfPath = path.join(rootDir, 'docs', 'technical_documentation.pdf');

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markdownToHtml(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let inCode = false;
  let codeLang = '';
  let inTable = false;
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      if (inCode) {
        out.push('</code></pre>');
        inCode = false;
      } else {
        if (inList) {
          out.push('</ul>');
          inList = false;
        }
        if (inTable) {
          out.push('</tbody></table>');
          inTable = false;
        }
        codeLang = line.slice(3).trim();
        out.push(`<pre><code class="lang-${codeLang}">`);
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      if (inTable) {
        out.push('</tbody></table>');
        inTable = false;
      }
      out.push('<hr/>');
      continue;
    }

    // Table rows
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const cells = line
        .trim()
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());

      // Check if separator
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        continue;
      }

      if (!inTable) {
        if (inList) {
          out.push('</ul>');
          inList = false;
        }
        out.push('<table><thead><tr>');
        cells.forEach((c) => out.push(`<th>${formatInline(c)}</th>`));
        out.push('</tr></thead><tbody>');
        inTable = true;
      } else {
        out.push('<tr>');
        cells.forEach((c) => out.push(`<td>${formatInline(c)}</td>`));
        out.push('</tr>');
      }
      continue;
    } else if (inTable) {
      out.push('</tbody></table>');
      inTable = false;
    }

    // Headings
    const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      const level = hMatch[1].length;
      out.push(`<h${level}>${formatInline(hMatch[2])}</h${level}>`);
      continue;
    }

    // Bullet list
    const listMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (listMatch) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${formatInline(listMatch[2])}</li>`);
      continue;
    } else if (inList && line.trim() === '') {
      out.push('</ul>');
      inList = false;
    }

    // Blank line
    if (line.trim() === '') {
      continue;
    }

    // Paragraph
    out.push(`<p>${formatInline(line)}</p>`);
  }

  if (inCode) out.push('</code></pre>');
  if (inTable) out.push('</tbody></table>');
  if (inList) out.push('</ul>');

  return out.join('\n');
}

function formatInline(str) {
  let s = escapeHtml(str);
  s = s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.*?)\*/g, '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

const htmlTemplate = (body) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>LAN Whiteboard Technical Documentation</title>
  <style>
    @page {
      size: A4;
      margin: 18mm 15mm 18mm 15mm;
    }
    body {
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif;
      color: #1e293b;
      line-height: 1.6;
      font-size: 10.5pt;
      margin: 0;
      padding: 0;
    }
    h1 {
      font-size: 20pt;
      border-bottom: 2px solid #2563eb;
      padding-bottom: 6px;
      margin-top: 0;
      color: #0f172a;
    }
    h2 {
      font-size: 15pt;
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 4px;
      margin-top: 22pt;
      color: #1e3a8a;
      page-break-after: avoid;
    }
    h3 {
      font-size: 12pt;
      margin-top: 14pt;
      color: #1e293b;
      page-break-after: avoid;
    }
    p, li {
      color: #334155;
    }
    code {
      background-color: #f1f5f9;
      color: #0f172a;
      padding: 1px 4px;
      border-radius: 4px;
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 9pt;
      border: 1px solid #e2e8f0;
    }
    pre {
      background-color: #0f172a;
      color: #f8fafc;
      padding: 10px 14px;
      border-radius: 6px;
      overflow-x: auto;
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 8.5pt;
      line-height: 1.4;
      page-break-inside: avoid;
    }
    pre code {
      background: transparent;
      color: inherit;
      padding: 0;
      border: none;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 12pt 0;
      font-size: 9.5pt;
      page-break-inside: avoid;
    }
    th, td {
      border: 1px solid #cbd5e1;
      padding: 5pt 8pt;
      text-align: left;
    }
    th {
      background-color: #f1f5f9;
      font-weight: 600;
      color: #0f172a;
    }
    tr:nth-child(even) td {
      background-color: #f8fafc;
    }
    hr {
      border: none;
      border-top: 1px solid #e2e8f0;
      margin: 18pt 0;
    }
    ul {
      padding-left: 18px;
    }
    li {
      margin-bottom: 3pt;
    }
    strong {
      color: #0f172a;
    }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findBrowserBinary() {
  const candidatePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ];

  for (const p of candidatePaths) {
    if (await fileExists(p)) {
      return p;
    }
  }

  for (const cmd of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    try {
      const locator = process.platform === 'win32' ? 'where' : 'which';
      const { stdout } = await execFileAsync(locator, [cmd]);
      const resolved = stdout.trim().split(/\r?\n/)[0];
      if (resolved && (await fileExists(resolved))) {
        return resolved;
      }
    } catch {
      // try next command
    }
  }
  return null;
}

async function findElectronBinary() {
  const rel =
    process.platform === 'win32'
      ? path.join('node_modules', 'electron', 'dist', 'electron.exe')
      : process.platform === 'darwin'
        ? path.join(
            'node_modules',
            'electron',
            'dist',
            'Electron.app',
            'Contents',
            'MacOS',
            'Electron',
          )
        : path.join('node_modules', 'electron', 'dist', 'electron');
  const candidate = path.join(rootDir, rel);
  return (await fileExists(candidate)) ? candidate : null;
}

async function renderPdfWithElectron(electronPath) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-docs-pdf-'));
  const runnerPath = path.join(tempDir, 'print-pdf.cjs');
  const runnerSource = [
    "const fs = require('node:fs');",
    "const { app, BrowserWindow } = require('electron');",
    'const [htmlFile, outPdf] = process.argv.slice(-2);',
    'app.disableHardwareAcceleration();',
    'app.whenReady().then(async () => {',
    '  try {',
    '    const win = new BrowserWindow({',
    '      show: false,',
    '      width: 1024,',
    '      height: 1440,',
    '      webPreferences: { javascript: true },',
    '    });',
    '    await win.loadFile(htmlFile);',
    "    await win.webContents.executeJavaScript('document.fonts.ready');",
    '    const pdfBuffer = await win.webContents.printToPDF({',
    '      printBackground: true,',
    '      preferCSSPageSize: true,',
    "      pageSize: 'A4',",
    '      margins: { top: 0.7, bottom: 0.7, left: 0.6, right: 0.6 },',
    '    });',
    '    fs.writeFileSync(outPdf, pdfBuffer);',
    '    app.exit(0);',
    '  } catch (err) {',
    '    console.error(err);',
    '    app.exit(1);',
    '  }',
    '});',
  ].join('\n');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  try {
    await fs.writeFile(runnerPath, runnerSource, 'utf8');
    await execFileAsync(
      electronPath,
      [
        '--no-sandbox',
        '--disable-gpu',
        '--user-data-dir=' + path.join(tempDir, 'profile'),
        runnerPath,
        htmlPath,
        pdfPath,
      ],
      { env },
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  console.log(`[PDF Generator] Reading ${mdPath}...`);
  const mdContent = await fs.readFile(mdPath, 'utf8');
  const htmlBody = markdownToHtml(mdContent);
  const fullHtml = htmlTemplate(htmlBody);

  await fs.writeFile(htmlPath, fullHtml, 'utf8');
  console.log(`[PDF Generator] HTML rendered: ${htmlPath}`);

  const browserPath = await findBrowserBinary();
  if (browserPath) {
    console.log(`[PDF Generator] Using browser: ${browserPath}`);
    const tempUserDataDir = path.join(rootDir, '.temp-browser-data');
    const args = [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-extensions',
      `--user-data-dir=${tempUserDataDir}`,
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file:///${htmlPath.replace(/\\/g, '/')}`,
    ];

    try {
      await execFileAsync(browserPath, args);
    } finally {
      await fs.rm(tempUserDataDir, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    const electronPath = await findElectronBinary();
    if (!electronPath) {
      console.warn(
        '[PDF Generator] No Chromium/Edge/Electron binary found; HTML saved to docs/technical_documentation.html.',
      );
      return;
    }
    console.log(`[PDF Generator] Using Electron fallback: ${electronPath}`);
    await renderPdfWithElectron(electronPath);
  }

  const stats = await fs.stat(pdfPath);
  console.log(
    `[PDF Generator] Generated PDF successfully: ${pdfPath} (${(stats.size / 1024).toFixed(1)} KB)`,
  );
}

main().catch((err) => {
  console.error('[PDF Generator] Error:', err);
  process.exit(1);
});
