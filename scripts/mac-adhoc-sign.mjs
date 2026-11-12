/**
 * @fileoverview electron-builder afterPack hook that applies valid ad-hoc code signatures
 * inside-out to macOS .app bundles when no Apple Developer certificate is configured.
 *
 * Without this, electron-builder mutates the upstream Electron bundle (Info.plist, executable
 * name, app.asar) while skipping signing (`identity: null`), leaving an invalidated signature
 * seal that macOS Gatekeeper / Apple Silicon rejects as "damaged and can't be opened".
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const BUNDLE_EXTENSIONS = new Set(['.app', '.framework', '.xpc', '.plugin']);
const MACHO_EXTENSIONS = new Set(['', '.dylib', '.so', '.node']);
const MACHO_MAGICS = new Set([
  0xfeedface, // MH_MAGIC
  0xcefaedfe, // MH_CIGAM
  0xfeedfacf, // MH_MAGIC_64
  0xcffaedfe, // MH_CIGAM_64
  0xcafebabe, // FAT_MAGIC
  0xbebafeca, // FAT_CIGAM
]);

async function isMachO(filePath) {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(8);
    const { bytesRead } = await fh.read(buf, 0, 8, 0);
    if (bytesRead < 4) return false;
    const magic = buf.readUInt32BE(0);
    if (!MACHO_MAGICS.has(magic)) return false;
    // Disambiguate Java .class vs Universal Mach-O fat binary (0xcafebabe): fat nfat_arch is small (< 32).
    if (magic === 0xcafebabe && bytesRead >= 8) {
      return buf.readUInt32BE(4) < 32;
    }
    return true;
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

async function collectSignTargets(dirPath, targets) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await collectSignTargets(fullPath, targets);
      if (BUNDLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        targets.push({ path: fullPath, isBundle: true });
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (MACHO_EXTENSIONS.has(ext) && (await isMachO(fullPath))) {
        targets.push({ path: fullPath, isBundle: false });
      }
    }
  }
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || process.platform !== 'darwin') {
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);
  const contentsPath = path.join(appPath, 'Contents');

  console.log(`[mac-adhoc-sign] Clearing extended attributes on ${appPath}`);
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });

  const targets = [];
  await collectSignTargets(contentsPath, targets);

  // Sign deepest nested binaries first, then nested bundles, then the outer .app bundle last.
  targets.sort((a, b) => {
    const depthDiff = b.path.split(path.sep).length - a.path.split(path.sep).length;
    if (depthDiff !== 0) return depthDiff;
    if (a.isBundle !== b.isBundle) return a.isBundle ? 1 : -1;
    return a.path.localeCompare(b.path);
  });

  console.log(`[mac-adhoc-sign] Ad-hoc signing ${targets.length} nested target(s) + app bundle`);
  for (const target of targets) {
    execFileSync('codesign', ['--force', '--sign', '-', target.path], { stdio: 'inherit' });
  }
  execFileSync('codesign', ['--force', '--sign', '-', appPath], { stdio: 'inherit' });

  console.log(`[mac-adhoc-sign] Verifying signature integrity for ${appPath}`);
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    stdio: 'inherit',
  });
}
