#!/usr/bin/env node
/**
 * 生成 winget manifest 三件套（version / defaultLocale / installer）。
 *
 * 发版后跑（sha256 用 GitHub Release 上那份 zip 的）：
 *   node scripts/winget-manifest.mjs 0.3.0 https://github.com/DDNdles/parallel/releases/download/v0.3.0/parallel-v0.3.0.zip <sha256>
 * 产物在 winget/DDNdles/parallel/<version>/。提交到官方源 = fork microsoft/winget-pkgs，
 * 把 winget/ 下的树挪到 manifests/d/DDNdles/parallel/<version>/ 发 PR（PR 需要过他们的验证流水线）。
 *
 * 注：NestedInstallerType: portable 挂的是 parallel.cmd 脚本入口；若官方验证流水线
 * 拒绝非 exe 的 nested installer，再补一个真 exe 垫片或改 InstallerType。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [version, zipUrl, sha256] = process.argv.slice(2);
if (!version || !zipUrl || !sha256) {
  console.error('用法: node scripts/winget-manifest.mjs <version> <zipUrl> <sha256>');
  process.exit(1);
}
const id = 'DDNdles.parallel';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'winget', 'DDNdles', 'parallel', version);
mkdirSync(outDir, { recursive: true });

const files = {
  [`${id}.yaml`]: `PackageIdentifier: ${id}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`,
  [`${id}.locale.yaml`]: `PackageIdentifier: ${id}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: DDNdles
PublisherUrl: https://github.com/DDNdles
PackageName: parallel
PackageUrl: https://github.com/DDNdles/parallel
License: AGPL-3.0-only
LicenseUrl: https://github.com/DDNdles/parallel/blob/main/LICENSE
ShortDescription: Harness-style QQ bot with a pi agent runtime, plugin kernel and a humanlike chat layer
Description: >-
  parallel is a self-hosted QQ bot harness: an agent-loop kernel (pi) with
  everything-as-plugins, a frequency-based humanlike chat layer, work sub-agents
  in Docker sandboxes, and a local desktop console for full control.
  The Windows release embeds its own Node runtime; it hosts the LuckyLilliaBot
  OneBot 11 protocol end against a local QQNT client.
Moniker: parallel
Tags:
  - qq-bot
  - onebot
  - chatbot
  - agent
  - llm
ReleaseNotesUrl: https://github.com/DDNdles/parallel/releases/tag/v${version}
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`,
  [`${id}.installer.yaml`]: `PackageIdentifier: ${id}
PackageVersion: ${version}
Installers:
  - Architecture: x64
    InstallerType: zip
    InstallerUrl: ${zipUrl}
    InstallerSha256: ${sha256}
    NestedInstallerType: portable
    NestedInstallerFiles:
      - RelativeFilePath: parallel.cmd
        PortableCommandAlias: parallel
ManifestType: installer
ManifestVersion: 1.6.0
`,
};
for (const [name, body] of Object.entries(files)) {
  writeFileSync(join(outDir, name), body);
  console.log(`[winget] ${join(outDir, name)}`);
}
