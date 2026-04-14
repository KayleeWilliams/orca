/* eslint-disable max-lines -- Why: cookie import is a single pipeline (detect → decrypt → stage → swap)
   that must stay together so the encryption, schema, and staging steps remain in sync. */
import { app, type BrowserWindow, dialog, session } from 'electron'
import { execFileSync } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'

const IS_MACOS = process.platform === 'darwin'
const IS_WINDOWS = process.platform === 'win32'

// Why: writing to userData instead of tmpdir() so the diag log is only
// readable by the current user, not world-readable in /tmp.
let _diagLog: string | null = null
function getDiagLogPath(): string {
  if (!_diagLog) {
    try {
      _diagLog = join(app.getPath('userData'), 'cookie-import-diag.log')
    } catch {
      _diagLog = join(tmpdir(), 'orca-cookie-import-diag.log')
    }
  }
  return _diagLog
}
function diag(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    appendFileSync(getDiagLogPath(), line)
  } catch {
    /* best-effort */
  }
  console.log('[cookie-import]', msg)
}
import type {
  BrowserCookieImportResult,
  BrowserCookieImportSummary,
  BrowserSessionProfileSource
} from '../../shared/types'
import { browserSessionRegistry } from './browser-session-registry'

// ---------------------------------------------------------------------------
// Browser detection
// ---------------------------------------------------------------------------

export type DetectedBrowser = {
  family: BrowserSessionProfileSource['browserFamily']
  label: string
  cookiesPath: string
  keychainService: string
  keychainAccount: string
}

const CHROMIUM_BROWSERS: Omit<DetectedBrowser, 'cookiesPath'>[] = [
  {
    family: 'chrome',
    label: 'Google Chrome',
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome'
  },
  {
    family: 'edge',
    label: 'Microsoft Edge',
    keychainService: 'Microsoft Edge Safe Storage',
    keychainAccount: 'Microsoft Edge'
  },
  {
    family: 'arc',
    label: 'Arc',
    keychainService: 'Arc Safe Storage',
    keychainAccount: 'Arc'
  },
  {
    family: 'chromium',
    label: 'Brave',
    keychainService: 'Brave Safe Storage',
    keychainAccount: 'Brave'
  }
]

function cookiesPathForBrowser(family: BrowserSessionProfileSource['browserFamily']): string {
  if (IS_MACOS) {
    const home = process.env.HOME ?? ''
    switch (family) {
      case 'chrome':
        return join(home, 'Library/Application Support/Google/Chrome/Default/Cookies')
      case 'edge':
        return join(home, 'Library/Application Support/Microsoft Edge/Default/Cookies')
      case 'arc':
        return join(home, 'Library/Application Support/Arc/User Data/Default/Cookies')
      case 'chromium':
        return join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies')
      default:
        return ''
    }
  }

  if (IS_WINDOWS) {
    const localAppData = process.env.LOCALAPPDATA ?? ''
    // Why: Chrome 96+ moved the Cookies file into a Network subdirectory.
    // Check the new path first, then fall back to the legacy location so
    // both current and older installations are detected.
    const candidates = (paths: string[]): string => paths.find((p) => existsSync(p)) ?? paths[0]

    switch (family) {
      case 'chrome':
        return candidates([
          join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Network', 'Cookies'),
          join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Cookies')
        ])
      case 'edge':
        return candidates([
          join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Network', 'Cookies'),
          join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cookies')
        ])
      case 'arc':
        return candidates([
          join(localAppData, 'Arc', 'User Data', 'Default', 'Network', 'Cookies'),
          join(localAppData, 'Arc', 'User Data', 'Default', 'Cookies')
        ])
      case 'chromium':
        return candidates([
          join(
            localAppData,
            'BraveSoftware',
            'Brave-Browser',
            'User Data',
            'Default',
            'Network',
            'Cookies'
          ),
          join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Cookies')
        ])
      default:
        return ''
    }
  }

  return ''
}

export function detectInstalledBrowsers(): DetectedBrowser[] {
  return CHROMIUM_BROWSERS.map((browser) => ({
    ...browser,
    cookiesPath: cookiesPathForBrowser(browser.family)
  })).filter((browser) => existsSync(browser.cookiesPath))
}

// ---------------------------------------------------------------------------
// Cookie validation (shared between file import and direct import)
// ---------------------------------------------------------------------------

type RawCookieEntry = {
  domain?: unknown
  name?: unknown
  value?: unknown
  path?: unknown
  secure?: unknown
  httpOnly?: unknown
  sameSite?: unknown
  expirationDate?: unknown
}

type ValidatedCookie = {
  url: string
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  expirationDate: number | undefined
}

function normalizeSameSite(raw: unknown): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  if (typeof raw === 'number') {
    switch (raw) {
      case 0:
        return 'no_restriction'
      case 1:
        return 'lax'
      case 2:
        return 'strict'
      default:
        return 'unspecified'
    }
  }
  if (typeof raw !== 'string') {
    return 'unspecified'
  }
  const lower = raw.toLowerCase()
  if (lower === 'lax') {
    return 'lax'
  }
  if (lower === 'strict') {
    return 'strict'
  }
  if (lower === 'none' || lower === 'no_restriction') {
    return 'no_restriction'
  }
  return 'unspecified'
}

// Why: Electron's cookies.set() requires a url field to determine the cookie's
// scope. Derive it from the domain + secure flag so the caller doesn't need
// to supply it.
function deriveUrl(domain: string, secure: boolean): string | null {
  const cleanDomain = domain.startsWith('.') ? domain.slice(1) : domain
  if (!cleanDomain || cleanDomain.includes(' ')) {
    return null
  }
  const protocol = secure ? 'https' : 'http'
  try {
    const url = new URL(`${protocol}://${cleanDomain}/`)
    return url.toString()
  } catch {
    return null
  }
}

function validateCookieEntry(raw: RawCookieEntry): ValidatedCookie | null {
  if (typeof raw.domain !== 'string' || raw.domain.trim().length === 0) {
    return null
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    return null
  }
  if (typeof raw.value !== 'string') {
    return null
  }

  const domain = raw.domain.trim()
  const secure = raw.secure === true || raw.secure === 1
  const url = deriveUrl(domain, secure)
  if (!url) {
    return null
  }

  const expirationDate =
    typeof raw.expirationDate === 'number' && raw.expirationDate > 0
      ? raw.expirationDate
      : undefined

  return {
    url,
    name: raw.name.trim(),
    value: raw.value,
    domain,
    path: typeof raw.path === 'string' ? raw.path : '/',
    secure,
    httpOnly: raw.httpOnly === true || raw.httpOnly === 1,
    sameSite: normalizeSameSite(raw.sameSite),
    expirationDate
  }
}

async function importValidatedCookies(
  cookies: ValidatedCookie[],
  totalInput: number,
  targetPartition: string
): Promise<BrowserCookieImportResult> {
  diag(
    `importValidatedCookies: ${cookies.length} validated of ${totalInput} total, partition="${targetPartition}"`
  )
  const targetSession = session.fromPartition(targetPartition)
  let importedCount = 0
  let skipped = totalInput - cookies.length
  const domainSet = new Set<string>()

  // Why: Electron's cookies.set() rejects any non-printable-ASCII byte.
  // Strip from all string fields as a safety net.
  const stripNonPrintable = (s: string): string => s.replace(/[^\x20-\x7E]/g, '')

  for (const cookie of cookies) {
    try {
      await targetSession.cookies.set({
        url: cookie.url,
        name: cookie.name,
        value: stripNonPrintable(cookie.value),
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expirationDate
      })
      importedCount++
      // Why: surface only the domain — never name, value, or path — so the
      // renderer can show a useful summary without leaking secret cookie data.
      const cleanDomain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
      domainSet.add(cleanDomain)
    } catch (err) {
      skipped++
      if (skipped <= 5) {
        // Find the exact offending character position and code
        const val = cookie.value
        let badInfo = 'none found'
        for (let i = 0; i < val.length; i++) {
          const code = val.charCodeAt(i)
          if (code < 0x20 || code > 0x7e) {
            badInfo = `pos=${i} char=U+${code.toString(16).padStart(4, '0')} context="${val.substring(Math.max(0, i - 5), i + 5)}"`
            break
          }
        }
        diag(
          `  cookie.set FAILED: domain=${cookie.domain} name=${cookie.name} valLen=${val.length} badChar=${badInfo} err=${err}`
        )
      }
    }
  }

  diag(
    `importValidatedCookies result: imported=${importedCount} skipped=${skipped} domains=${domainSet.size}`
  )

  const summary: BrowserCookieImportSummary = {
    totalCookies: totalInput,
    importedCookies: importedCount,
    skippedCookies: skipped,
    domains: [...domainSet].sort()
  }

  return { ok: true, profileId: '', summary }
}

// ---------------------------------------------------------------------------
// Import from JSON file
// ---------------------------------------------------------------------------

// Why: source selection must be main-owned via a native open dialog so a
// compromised renderer cannot turn cookie import into arbitrary file reads.
export async function pickCookieFile(parentWindow: BrowserWindow | null): Promise<string | null> {
  const opts = {
    title: 'Import Cookies',
    filters: [
      { name: 'Cookie Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile' as const]
  }
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, opts)
    : await dialog.showOpenDialog(opts)

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
}

export async function importCookiesFromFile(
  filePath: string,
  targetPartition: string
): Promise<BrowserCookieImportResult> {
  let rawContent: string
  try {
    rawContent = await readFile(filePath, 'utf-8')
  } catch {
    return { ok: false, reason: 'Could not read the selected file.' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    return { ok: false, reason: 'File is not valid JSON.' }
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'Expected a JSON array of cookie objects.' }
  }

  if (parsed.length === 0) {
    return { ok: false, reason: 'Cookie file is empty.' }
  }

  const validated: ValidatedCookie[] = []
  let skipped = 0
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      skipped++
      continue
    }
    const cookie = validateCookieEntry(entry as RawCookieEntry)
    if (cookie) {
      validated.push(cookie)
    } else {
      skipped++
    }
  }

  if (validated.length === 0) {
    return {
      ok: false,
      reason: `No valid cookies found. ${skipped} entries were skipped due to missing or invalid fields.`
    }
  }

  return importValidatedCookies(validated, parsed.length, targetPartition)
}

// ---------------------------------------------------------------------------
// Direct import from installed Chromium browser
// ---------------------------------------------------------------------------

// Why: Google and other services bind auth cookies to the User-Agent that
// created them. We read the source browser's real version from its plist
// (macOS) or registry (Windows) and construct a matching UA string so
// imported sessions aren't invalidated.
function getUserAgentForBrowser(
  family: BrowserSessionProfileSource['browserFamily']
): string | null {
  const chromeBase = 'AppleWebKit/537.36 (KHTML, like Gecko)'

  if (IS_MACOS) {
    const platform = 'Macintosh; Intel Mac OS X 10_15_7'

    function readBrowserVersionMac(
      appPath: string,
      plistKey = 'CFBundleShortVersionString'
    ): string | null {
      try {
        return (
          execFileSync('defaults', ['read', `${appPath}/Contents/Info`, plistKey], {
            encoding: 'utf-8',
            timeout: 5_000
          }).trim() || null
        )
      } catch {
        return null
      }
    }

    switch (family) {
      case 'chrome': {
        const v = readBrowserVersionMac('/Applications/Google Chrome.app')
        return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36` : null
      }
      case 'edge': {
        const v = readBrowserVersionMac('/Applications/Microsoft Edge.app')
        return v
          ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36 Edg/${v}`
          : null
      }
      case 'arc': {
        const v = readBrowserVersionMac('/Applications/Arc.app')
        return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36` : null
      }
      case 'chromium': {
        const v = readBrowserVersionMac('/Applications/Brave Browser.app')
        return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36` : null
      }
      default:
        return null
    }
  }

  if (IS_WINDOWS) {
    const platform = 'Windows NT 10.0; Win64; x64'

    // Why: Chromium browsers on Windows store their version in the BLBeacon
    // registry key under HKCU. Reading from the registry is faster and more
    // reliable than parsing executable metadata or Local State JSON.
    function readBrowserVersionWin(registryPath: string): string | null {
      try {
        const output = execFileSync('reg', ['query', registryPath, '/v', 'version'], {
          encoding: 'utf-8',
          timeout: 5_000
        })
        const match = output.match(/version\s+REG_SZ\s+(.+)/i)
        return match?.[1]?.trim() || null
      } catch {
        return null
      }
    }

    switch (family) {
      case 'chrome': {
        const v = readBrowserVersionWin('HKCU\\Software\\Google\\Chrome\\BLBeacon')
        return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36` : null
      }
      case 'edge': {
        const v = readBrowserVersionWin('HKCU\\Software\\Microsoft\\Edge\\BLBeacon')
        return v
          ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36 Edg/${v}`
          : null
      }
      case 'chromium': {
        const v = readBrowserVersionWin('HKCU\\Software\\BraveSoftware\\Brave-Browser\\BLBeacon')
        return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36` : null
      }
      // Why: Arc on Windows does not use a well-known BLBeacon registry key.
      // Returning null is safe — the import still works, Google just may
      // regenerate some session tokens on first request.
      default:
        return null
    }
  }

  return null
}

const PBKDF2_ITERATIONS = 1003
const PBKDF2_KEY_LENGTH = 16
const PBKDF2_SALT = 'saltysalt'

const CHROMIUM_EPOCH_OFFSET = 11644473600n

function chromiumTimestampToUnix(chromiumTs: string): number {
  if (!chromiumTs || chromiumTs === '0') {
    return 0
  }
  try {
    const ts = BigInt(chromiumTs)
    if (ts === 0n) {
      return 0
    }
    return Math.max(Number(ts / 1000000n - CHROMIUM_EPOCH_OFFSET), 0)
  } catch {
    return 0
  }
}

function getEncryptionKeyMacOS(keychainService: string, keychainAccount: string): Buffer | null {
  try {
    // Why: execFileSync bypasses shell interpretation, preventing command
    // injection if keychainService/keychainAccount ever come from user input.
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', keychainService, '-a', keychainAccount, '-w'],
      { encoding: 'utf-8', timeout: 30_000 }
    ).trim()
    return pbkdf2Sync(raw, PBKDF2_SALT, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha1')
  } catch {
    return null
  }
}

// Why: On Windows, Chromium stores the encryption key in the "Local State"
// JSON file under os_crypt.encrypted_key. The key is base64-encoded and
// prefixed with "DPAPI", then encrypted with the Windows Data Protection
// API (DPAPI). We decrypt it via PowerShell's ProtectedData class which
// calls CryptUnprotectData under the hood — this only succeeds for the
// Windows user account that originally encrypted the key.
function getEncryptionKeyWindows(cookiesPath: string): Buffer | null {
  try {
    // Navigate up from the Cookies file to find "Local State" in the
    // browser's User Data directory. Limit to 5 levels to avoid traversing
    // all the way to the filesystem root on bogus paths.
    let dir = dirname(cookiesPath)
    let localStatePath = ''
    for (let depth = 0; depth < 5 && dir !== dirname(dir); depth++) {
      const candidate = join(dir, 'Local State')
      if (existsSync(candidate)) {
        localStatePath = candidate
        break
      }
      dir = dirname(dir)
    }
    if (!localStatePath) {
      return null
    }

    const localState = JSON.parse(readFileSync(localStatePath, 'utf-8'))
    const encryptedKeyB64: unknown = localState?.os_crypt?.encrypted_key
    if (typeof encryptedKeyB64 !== 'string') {
      return null
    }

    const encryptedKeyBuf = Buffer.from(encryptedKeyB64, 'base64')
    // The first 5 bytes are the ASCII string "DPAPI" — a marker that
    // confirms the remaining bytes are DPAPI-encrypted.
    if (encryptedKeyBuf.subarray(0, 5).toString('utf-8') !== 'DPAPI') {
      return null
    }

    const dpapiEncrypted = encryptedKeyBuf.subarray(5)
    const b64Input = dpapiEncrypted.toString('base64')

    // Why: execFileSync with an argument array avoids shell interpretation,
    // preventing injection even if b64Input were somehow malicious. The
    // base64 alphabet doesn't contain shell metacharacters, but defense
    // in depth is cheap here.
    const decryptedB64 = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${b64Input}'), $null, 'CurrentUser'))`
      ],
      { encoding: 'utf-8', timeout: 30_000 }
    ).trim()

    return Buffer.from(decryptedB64, 'base64')
  } catch {
    return null
  }
}

function getEncryptionKeyForBrowser(browser: DetectedBrowser): Buffer | null {
  if (IS_MACOS) {
    return getEncryptionKeyMacOS(browser.keychainService, browser.keychainAccount)
  }
  if (IS_WINDOWS) {
    return getEncryptionKeyWindows(browser.cookiesPath)
  }
  return null
}

// Why: Chromium 127+ prepends a 32-byte per-host HMAC to the cookie value
// before encrypting. After AES-CBC decryption, the raw output is:
//   [32-byte HMAC] [actual cookie value]
// Detection: the HMAC is a hash, so roughly half its bytes are non-printable
// ASCII. Real cookie values are overwhelmingly printable. If ≥8 of the first
// 32 bytes are non-printable, it's an HMAC prefix.
const CHROMIUM_COOKIE_HMAC_LEN = 32

function hasHmacPrefix(buf: Buffer): boolean {
  if (buf.length <= CHROMIUM_COOKIE_HMAC_LEN) {
    return false
  }
  let nonPrintable = 0
  for (let i = 0; i < CHROMIUM_COOKIE_HMAC_LEN; i++) {
    if (buf[i] < 0x20 || buf[i] > 0x7e) {
      nonPrintable++
    }
  }
  return nonPrintable >= 8
}

function decryptCookieValueMacOS(encryptedBuffer: Buffer, key: Buffer): Buffer | null {
  const iv = Buffer.alloc(16, ' ')
  const ciphertext = encryptedBuffer.subarray(3)
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    decipher.setAutoPadding(true)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return hasHmacPrefix(decrypted) ? decrypted.subarray(CHROMIUM_COOKIE_HMAC_LEN) : decrypted
  } catch {
    return null
  }
}

// Why: On Windows, Chromium 80+ encrypts cookies with AES-256-GCM using
// the key from Local State (after DPAPI decryption). The encrypted format
// is: 3-byte version tag ("v10"/"v20") + 12-byte nonce + ciphertext +
// 16-byte GCM authentication tag.
function decryptCookieValueWindows(encryptedBuffer: Buffer, key: Buffer): Buffer | null {
  // 3 (version) + 12 (nonce) + 16 (auth tag) = 31 byte minimum
  const nonce = encryptedBuffer.subarray(3, 3 + 12)
  const ciphertextWithTag = encryptedBuffer.subarray(3 + 12)
  const authTag = ciphertextWithTag.subarray(-16)
  const ciphertext = ciphertextWithTag.subarray(0, -16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(authTag)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    // Why: Chromium 127+ prepends a 32-byte per-host HMAC to the plaintext
    // before encrypting, regardless of platform. Strip it here just as the
    // macOS path does.
    return hasHmacPrefix(decrypted) ? decrypted.subarray(CHROMIUM_COOKIE_HMAC_LEN) : decrypted
  } catch {
    return null
  }
}

function decryptCookieValueRaw(encryptedBuffer: Buffer, key: Buffer): Buffer | null {
  if (!encryptedBuffer || encryptedBuffer.length === 0) {
    return null
  }
  const version = encryptedBuffer.subarray(0, 3).toString('utf-8')
  // Why: macOS uses v10/v11 (AES-128-CBC), Windows uses v10/v20 (AES-256-GCM).
  // Reject versions that don't belong to the current platform to avoid silently
  // producing garbage by feeding data to the wrong decryption algorithm.
  if (IS_WINDOWS) {
    if (version !== 'v10' && version !== 'v20') {
      return null
    }
    if (encryptedBuffer.length < 3 + 12 + 16) {
      return null
    }
    return decryptCookieValueWindows(encryptedBuffer, key)
  }
  if (version !== 'v10' && version !== 'v11') {
    return null
  }
  return decryptCookieValueMacOS(encryptedBuffer, key)
}

// Why: better-sqlite3 may create WAL/SHM journal files alongside the
// database. Clean up all three when removing a staging or temp DB.
function unlinkDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(dbPath + suffix)
    } catch {
      /* best-effort — file may not exist */
    }
  }
}

export async function importCookiesFromBrowser(
  browser: DetectedBrowser,
  targetPartition: string
): Promise<BrowserCookieImportResult> {
  diag(`importCookiesFromBrowser: browser=${browser.family} partition="${targetPartition}"`)
  if (!existsSync(browser.cookiesPath)) {
    diag(`  cookies DB not found: ${browser.cookiesPath}`)
    return { ok: false, reason: `${browser.label} cookies database not found.` }
  }

  // Why: the browser may hold a lock on the Cookies file. Copying to a temp
  // location avoids lock contention and ensures we read a consistent snapshot.
  // We also copy the WAL and SHM journal files if they exist — Chromium uses
  // WAL mode by default, and recent cookies may reside only in the WAL file.
  const tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-import-'))
  const tmpCookiesPath = join(tmpDir, 'Cookies')

  try {
    copyFileSync(browser.cookiesPath, tmpCookiesPath)
    for (const suffix of ['-wal', '-shm']) {
      const src = browser.cookiesPath + suffix
      if (existsSync(src)) {
        copyFileSync(src, tmpCookiesPath + suffix)
      }
    }
  } catch {
    rmSync(tmpDir, { recursive: true, force: true })
    return {
      ok: false,
      reason: `Could not copy ${browser.label} cookies database. Try closing ${browser.label} first.`
    }
  }

  // Why: Electron's cookies.set() API rejects many valid cookie values (binary
  // bytes > 0x7F etc). Instead, decrypt from the source browser and write
  // plaintext directly to the SQLite `value` column. CookieMonster reads
  // `value` as a raw byte string when `encrypted_value` is empty, bypassing
  // all API-level validation. This works because Electron's CookieMonster in
  // dev mode does not use os_crypt encryption — it stores cookies as plaintext.
  // In packaged builds where os_crypt IS active, CookieMonster will re-encrypt
  // plaintext cookies on its next flush, so this approach is safe in both modes.

  const sourceKey = getEncryptionKeyForBrowser(browser)
  if (!sourceKey) {
    rmSync(tmpDir, { recursive: true, force: true })
    // Why: the error message differs by platform because the key retrieval
    // mechanisms are completely different — macOS Keychain vs Windows DPAPI.
    const keyHint = IS_WINDOWS
      ? 'Could not decrypt the browser encryption key. Try running Orca as the same Windows user that owns the browser profile.'
      : 'macOS may have denied Keychain access.'
    return {
      ok: false,
      reason: `Could not access ${browser.label} encryption key. ${keyHint}`
    }
  }

  // Why: CookieMonster holds the live DB's data in memory and overwrites it
  // on flush/shutdown. Writing directly to the live DB is futile. Instead,
  // copy the live DB to a staging location, populate it there, and let the
  // next cold start swap it in before CookieMonster initializes.
  const targetSession = session.fromPartition(targetPartition)
  await targetSession.cookies.flushStore()

  const partitionName = targetPartition.replace('persist:', '')
  const liveCookiesPath = join(app.getPath('userData'), 'Partitions', partitionName, 'Cookies')

  if (!existsSync(liveCookiesPath)) {
    rmSync(tmpDir, { recursive: true, force: true })
    return { ok: false, reason: 'Target cookie database not found. Open a browser tab first.' }
  }

  const stagingCookiesPath = join(app.getPath('userData'), 'Cookies-staged')
  try {
    copyFileSync(liveCookiesPath, stagingCookiesPath)
    for (const suffix of ['-wal', '-shm']) {
      const src = liveCookiesPath + suffix
      if (existsSync(src)) {
        copyFileSync(src, stagingCookiesPath + suffix)
      }
    }
  } catch {
    rmSync(tmpDir, { recursive: true, force: true })
    unlinkDbFiles(stagingCookiesPath)
    return { ok: false, reason: 'Could not create staging cookie database.' }
  }

  let sourceDb: InstanceType<typeof Database> | null = null
  let stagingDb: InstanceType<typeof Database> | null = null
  try {
    // Why: better-sqlite3 gives direct access to BLOB columns as Buffer
    // objects, eliminating the hex-encoding round-trip and shell-escaping
    // issues of the previous sqlite3 CLI approach. It also works on Windows
    // where sqlite3 is not pre-installed.
    stagingDb = new Database(stagingCookiesPath)
    const targetCols = (stagingDb.pragma('table_info(cookies)') as { name: string }[]).map(
      (c) => c.name
    )
    const colList = targetCols.join(', ')

    stagingDb.exec('DELETE FROM cookies')

    sourceDb = new Database(tmpCookiesPath, { readonly: true })
    const sourceCols = new Set(
      (sourceDb.pragma('table_info(cookies)') as { name: string }[]).map((c) => c.name)
    )
    // Why: the source browser's cookie schema may have columns the target
    // (Electron's Chromium) doesn't, or vice versa. Only read columns
    // present in both to avoid "no such column" errors.
    const commonCols = targetCols.filter((c) => sourceCols.has(c))

    if (commonCols.length === 0) {
      sourceDb.close()
      sourceDb = null
      stagingDb.close()
      stagingDb = null
      rmSync(tmpDir, { recursive: true, force: true })
      unlinkDbFiles(stagingCookiesPath)
      return {
        ok: false,
        reason: `${browser.label} cookies database has an incompatible schema.`
      }
    }

    const allRows = sourceDb
      .prepare(`SELECT ${commonCols.join(', ')} FROM cookies ORDER BY rowid`)
      .all() as Record<string, unknown>[]
    sourceDb.close()
    sourceDb = null

    diag(`  source has ${allRows.length} cookies`)

    if (allRows.length === 0) {
      stagingDb.close()
      stagingDb = null
      rmSync(tmpDir, { recursive: true, force: true })
      unlinkDbFiles(stagingCookiesPath)
      return { ok: false, reason: `No cookies found in ${browser.label}.` }
    }

    // Why: Google's integrity cookies (SIDCC, __Secure-*PSIDCC, __Secure-STRP)
    // are cryptographically bound to the source browser's TLS fingerprint and
    // environment. Importing them into a different browser causes
    // accounts.google.com to reject the session with CookieMismatch. Skipping
    // them lets Google regenerate fresh integrity cookies on the first request.
    const INTEGRITY_COOKIE_NAMES = new Set([
      'SIDCC',
      '__Secure-1PSIDCC',
      '__Secure-3PSIDCC',
      '__Secure-STRP',
      'AEC'
    ])
    function isIntegrityCookie(name: string, domain: string): boolean {
      if (!INTEGRITY_COOKIE_NAMES.has(name)) {
        return false
      }
      const d = domain.startsWith('.') ? domain.slice(1) : domain
      return d === 'google.com' || d.endsWith('.google.com')
    }

    let imported = 0
    let skipped = 0
    let integritySkipped = 0
    let memoryLoaded = 0
    let memoryFailed = 0
    const domainSet = new Set<string>()

    type DecryptedCookie = {
      value: string
      domain: string
      name: string
      path: string
      secure: boolean
      httpOnly: boolean
      sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
      expirationDate: number | undefined
    }

    const decryptedCookies: DecryptedCookie[] = []

    const placeholders = targetCols.map(() => '?').join(', ')
    const insertStmt = stagingDb.prepare(
      `INSERT OR REPLACE INTO cookies (${colList}) VALUES (${placeholders})`
    )
    const insertAll = stagingDb.transaction(() => {
      for (const row of allRows) {
        const encBuf = row.encrypted_value as Buffer | null
        const plainBuf = row.value as Buffer | string | null

        let decryptedValue: Buffer
        if (encBuf && encBuf.length > 0) {
          const rawDecrypted = decryptCookieValueRaw(encBuf, sourceKey)
          if (rawDecrypted === null) {
            skipped++
            continue
          }
          decryptedValue = rawDecrypted
        } else {
          // Why: the value column in Chromium's DB is TEXT, so better-sqlite3
          // may return a string. Convert to a Buffer for consistent handling.
          decryptedValue =
            plainBuf instanceof Buffer ? plainBuf : Buffer.from(String(plainBuf ?? ''), 'latin1')
        }

        const domain = String(row.host_key ?? '')
        const name = String(row.name ?? '')

        if (isIntegrityCookie(name, domain)) {
          integritySkipped++
          continue
        }

        const cleanDomain = domain.startsWith('.') ? domain.slice(1) : domain
        domainSet.add(cleanDomain)

        const path = String(row.path ?? '/')
        const secure = row.is_secure === 1
        const httpOnly = row.is_httponly === 1
        const sameSite = normalizeSameSite(row.samesite)
        const expiresUtc = chromiumTimestampToUnix(String(row.expires_utc ?? '0'))
        // Why: cookie values are raw byte strings, not UTF-8 text. Using latin1
        // (ISO-8859-1) preserves all byte values 0x00–0xFF without replacement
        // characters that UTF-8 decoding would insert for invalid sequences.
        const value = decryptedValue.toString('latin1')

        decryptedCookies.push({
          value,
          domain,
          name,
          path,
          secure,
          httpOnly,
          sameSite,
          expirationDate: expiresUtc > 0 ? expiresUtc : undefined
        })

        // Build the row for INSERT, substituting decrypted value and clearing
        // encrypted_value so CookieMonster reads the plaintext column.
        const insertValues = targetCols.map((col) => {
          if (col === 'encrypted_value') {
            return Buffer.alloc(0)
          }
          if (col === 'value') {
            return decryptedValue
          }
          // Why: columns that exist in the target but not in the source get
          // null, which SQLite resolves to the column's DEFAULT value.
          if (!sourceCols.has(col)) {
            return null
          }
          return row[col] ?? null
        })
        insertStmt.run(...insertValues)
        imported++
      }
    })
    insertAll()
    stagingDb.close()
    stagingDb = null

    diag(`  skipped ${integritySkipped} Google integrity cookies (SIDCC/STRP/AEC)`)
    diag(`  inserted ${imported} cookies, ${skipped} skipped`)

    rmSync(tmpDir, { recursive: true, force: true })
    diag(`  SQLite staging complete: ${imported} cookies, ${domainSet.size} domains`)

    // Why: clearing the session's in-memory cookie store before loading imported
    // cookies prevents stale cookies from a previous Orca browsing session from
    // mixing with the imported set. Mixed state (some old, some imported) causes
    // sites like Google to detect inconsistent session cookies and reject them.
    await targetSession.clearStorageData({ storages: ['cookies'] })
    diag(
      `  cleared existing session cookies before loading ${decryptedCookies.length} imported cookies`
    )

    // Why: loading cookies into memory via cookies.set() makes them available
    // immediately without requiring a restart. The staging DB is kept as a
    // fallback for any cookies that fail the cookies.set() validation.
    for (const cookie of decryptedCookies) {
      const url = deriveUrl(cookie.domain, cookie.secure)
      if (!url) {
        memoryFailed++
        continue
      }
      try {
        // Why: __Host- prefixed cookies must not have a domain attribute and
        // must have path=/. Chromium rejects them otherwise.
        const isHostPrefixed = cookie.name.startsWith('__Host-')
        await targetSession.cookies.set({
          url,
          name: cookie.name,
          value: cookie.value,
          ...(isHostPrefixed ? {} : { domain: cookie.domain }),
          path: isHostPrefixed ? '/' : cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          expirationDate: cookie.expirationDate
        })
        memoryLoaded++
      } catch {
        memoryFailed++
      }
    }

    diag(`  memory load: ${memoryLoaded} OK, ${memoryFailed} failed`)

    if (memoryFailed > 0) {
      // Why: some cookies couldn't be loaded via cookies.set() (non-ASCII values
      // or other validation failures). Keep the staging DB so the next cold start
      // picks them up from SQLite where CookieMonster reads them without validation.
      browserSessionRegistry.setPendingCookieImport(stagingCookiesPath)
      diag(`  staged at ${stagingCookiesPath} for ${memoryFailed} cookies that need restart`)
    } else {
      unlinkDbFiles(stagingCookiesPath)
      diag(`  all cookies loaded in-memory — no restart needed`)
    }

    const ua = getUserAgentForBrowser(browser.family)
    if (ua) {
      targetSession.setUserAgent(ua)
      browserSessionRegistry.setupClientHintsOverride(targetSession, ua)
      browserSessionRegistry.persistUserAgent(ua)
      diag(`  set UA for partition: ${ua.substring(0, 80)}...`)
    }

    const summary: BrowserCookieImportSummary = {
      totalCookies: allRows.length,
      importedCookies: imported,
      skippedCookies: skipped + integritySkipped,
      domains: [...domainSet].sort()
    }

    return { ok: true, profileId: '', summary }
  } catch (err) {
    // Why: close any open database handles before cleaning up temp files,
    // otherwise the file may still be locked on Windows.
    try {
      sourceDb?.close()
    } catch {
      /* best-effort */
    }
    try {
      stagingDb?.close()
    } catch {
      /* best-effort */
    }
    rmSync(tmpDir, { recursive: true, force: true })
    // Why: if the import fails after the staging DB was created, clean it up
    // to avoid a stale staged import being applied on the next cold start.
    unlinkDbFiles(stagingCookiesPath)
    diag(`  SQLite import failed: ${err}`)
    // Why: a "malformed" or "not a database" error typically means the browser
    // held a lock during copy and we got a partial/corrupt file. Surface the
    // actionable hint to close the browser and retry.
    const errStr = String(err)
    const isCorrupt =
      errStr.includes('malformed') || errStr.includes('not a database') || errStr.includes('SQLITE')
    const hint = isCorrupt ? ` Try closing ${browser.label} and retrying.` : ''
    return {
      ok: false,
      reason: `Could not import cookies from ${browser.label}.${hint}`
    }
  }
}
