// 发布时从标签同步版本号到 package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml。
// 只定点替换版本字段，不改动文件其它格式（幂等，重复运行零 diff）。
// 用法：node scripts/sync-version.mjs <version>（如 0.2.0）
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (version === undefined || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`用法: node scripts/sync-version.mjs <semver>`)
  process.exit(1)
}

const pkg = readFileSync('package.json', 'utf8').replace(
  /"version"\s*:\s*"[^"]*"/,
  `"version": "${version}"`,
)
writeFileSync('package.json', pkg)

const conf = readFileSync('src-tauri/tauri.conf.json', 'utf8').replace(
  /"version"\s*:\s*"[^"]*"/,
  `"version": "${version}"`,
)
writeFileSync('src-tauri/tauri.conf.json', conf)

const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').replace(
  /^version = ".*"$/m,
  `version = "${version}"`,
)
writeFileSync('src-tauri/Cargo.toml', cargo)

console.log(`版本号已同步为 ${version}`)
