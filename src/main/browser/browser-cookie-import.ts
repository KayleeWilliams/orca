/* eslint-disable max-lines -- Why: cookie import is a single pipeline (detect → decrypt → stage → swap)
   that must stay together so the encryption, schema, and staging steps remain in sync. */
import { app, type BrowserWindow, dialog, session } from 'electron'
import { execSync } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIAG_LOG = join(tmpdir(), 'orca-cookie-import-diag.log')
function diag(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    appendFileSync(DIAG_LOG, line)
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
// and construct a matching UA string so imported sessions aren't invalidated.
function getUserAgentForBrowser(
  family: BrowserSessionProfileSource['browserFamily']
): string | null {
  const platform = 'Macintosh; Intel Mac OS X 10_15_7'
  const chromeBase = 'AppleWebKit/537.36 (KHTML, like Gecko)'

  function readBrowserVersion(
    appPath: string,
    plistKey = 'CFBundleShortVersionString'
  ): string | null {
    try {
      return (
        execSync(`defaults read "${appPath}/Contents/Info" ${plistKey}`, {
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
      const v = readBrowserVersion('/Applications/Google Chrome.app')
      return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36` : null
    }
    case 'edge': {
      const v = readBrowserVersion('/Applications/Microsoft Edge.app')
      return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36 Edg/${v}` : null
    }
    case 'arc': {
      const v = readBrowserVersion('/Applications/Arc.app')
      return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36` : null
    }
    case 'chromium': {
      const v = readBrowserVersion('/Applications/Brave Browser.app')
      return v ? `Mozilla/5.0 (${platform}) ${chromeBase} Chrome/${v} Safari/537.36` : null
    }
    default:
      return null
  }
}

const PBKDF2_ITERATIONS = 1003
const PBKDF2_KEY_LENGTH = 16
const PBKDF2_SALT = 'saltysalt'

const CHROMIUM_EPOCH_OFFSET = 11644473600n

function chromiumTimestampToUnix(chromiumTs: string): number {
  if (!chromiumTs || chromiumTs === '0') {
    return 0
  }
  const ts = BigInt(chromiumTs)
  if (ts === 0n) {
    return 0
  }
  return Math.max(Number(ts / 1000000n - CHROMIUM_EPOCH_OFFSET), 0)
}

function getEncryptionKey(keychainService: string, keychainAccount: string): Buffer | null {
  try {
    const raw = execSync(
      `security find-generic-password -s "${keychainService}" -a "${keychainAccount}" -w`,
      { encoding: 'utf-8', timeout: 30_000 }
    ).trim()
    return pbkdf2Sync(raw, PBKDF2_SALT, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha1')
  } catch {
    return null
  }
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

function decryptCookieValueRaw(encryptedBuffer: Buffer, key: Buffer): Buffer | null {
  if (!encryptedBuffer || encryptedBuffer.length === 0) {
    return null
  }
  const version = encryptedBuffer.subarray(0, 3).toString('utf-8')
  if (version !== 'v10' && version !== 'v11') {
    // Why: unknown encryption version — skip rather than importing raw
    // encrypted bytes as the cookie value.
    return null
  }
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
  const tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-import-'))
  const tmpCookiesPath = join(tmpDir, 'Cookies')

  try {
    copyFileSync(browser.cookiesPath, tmpCookiesPath)
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

  const sourceKey = getEncryptionKey(browser.keychainService, browser.keychainAccount)
  if (!sourceKey) {
    rmSync(tmpDir, { recursive: true, force: true })
    return {
      ok: false,
      reason: `Could not access ${browser.label} encryption key. macOS may have denied Keychain access.`
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
  } catch {
    rmSync(tmpDir, { recursive: true, force: true })
    return { ok: false, reason: 'Could not create staging cookie database.' }
  }

  try {
    // Get target schema columns
    const targetColsRaw = execSync(
      `sqlite3 "${stagingCookiesPath}" "PRAGMA table_info(cookies);"`,
      { encoding: 'utf-8', timeout: 5_000 }
    ).trim()
    const targetCols = targetColsRaw
      .split('\n')
      .map((line) => line.split('|')[1])
      .filter(Boolean)
    const colList = targetCols.join(', ')

    execSync(`sqlite3 "${stagingCookiesPath}" "DELETE FROM cookies;"`, {
      encoding: 'utf-8',
      timeout: 10_000
    })

    // Why: sqlite3's text output corrupts rows containing tab/newline in
    // values. Instead, build a SQL script entirely within sqlite3 that
    // decrypts nothing — we export rows as hex blobs, decrypt in Node,
    // and generate parameterized INSERT statements.

    // Read each cookie as a single hex-encoded blob of all fields to avoid
    // any delimiter/parsing issues. We read one cookie per rowid.
    const rowIdOutput = execSync(
      `sqlite3 "${tmpCookiesPath}" "SELECT rowid FROM cookies ORDER BY rowid;"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 30_000 }
    ).trim()
    const rowIds = rowIdOutput.split('\n').filter(Boolean)
    diag(`  source has ${rowIds.length} cookies`)

    if (rowIds.length === 0) {
      rmSync(tmpDir, { recursive: true, force: true })
      return { ok: false, reason: `No cookies found in ${browser.label}.` }
    }

    // Read all non-blob columns + hex(value) + hex(encrypted_value) in one query
    // Use a unique separator that can't appear in hex output
    const SEP = '|||'
    const selectCols = targetCols
      .map((col) => {
        if (col === 'value') {
          return `hex(value)`
        }
        if (col === 'encrypted_value') {
          return `hex(encrypted_value)`
        }
        return `quote(${col})`
      })
      .join(` || '${SEP}' || `)

    const allRowsOutput = execSync(
      `sqlite3 "${tmpCookiesPath}" "SELECT ${selectCols} FROM cookies ORDER BY rowid;"`,
      { encoding: 'utf-8', maxBuffer: 500 * 1024 * 1024, timeout: 60_000 }
    ).trim()

    const allRows = allRowsOutput.split('\n').filter(Boolean)
    diag(`  read ${allRows.length} rows with quote() encoding`)

    const colIdx = Object.fromEntries(targetCols.map((col, i) => [col, i]))

    function unquote(quoted: string): string {
      return quoted.replace(/^'|'$/g, '').replace(/''/g, "'")
    }

    function unquoteInt(quoted: string): number {
      return parseInt(quoted, 10) || 0
    }

    let imported = 0
    let skipped = 0
    let memoryLoaded = 0
    let memoryFailed = 0
    const domainSet = new Set<string>()
    const sqlStatements: string[] = ['BEGIN TRANSACTION;']

    type DecryptedCookie = {
      plaintextHex: string
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

    for (const row of allRows) {
      const cols = row.split(SEP)
      if (cols.length !== targetCols.length) {
        skipped++
        continue
      }

      const hexEncValue = cols[colIdx.encrypted_value]
      const encBuf = Buffer.from(hexEncValue, 'hex')
      const hexPlainValue = cols[colIdx.value]

      let plaintextHex: string
      if (encBuf.length > 0) {
        const rawDecrypted = decryptCookieValueRaw(encBuf, sourceKey)
        if (rawDecrypted === null) {
          skipped++
          continue
        }
        plaintextHex = rawDecrypted.toString('hex')
      } else {
        plaintextHex = hexPlainValue
      }

      const domain = unquote(cols[colIdx.host_key])
      const cleanDomain = domain.startsWith('.') ? domain.slice(1) : domain
      domainSet.add(cleanDomain)

      const name = unquote(cols[colIdx.name])
      const path = unquote(cols[colIdx.path])
      const secure = unquoteInt(cols[colIdx.is_secure]) === 1
      const httpOnly = unquoteInt(cols[colIdx.is_httponly]) === 1
      const sameSite = normalizeSameSite(unquoteInt(cols[colIdx.samesite]))
      const expiresUtc = chromiumTimestampToUnix(unquote(cols[colIdx.expires_utc]))
      const value = Buffer.from(plaintextHex, 'hex').toString('utf-8')

      decryptedCookies.push({
        plaintextHex,
        value,
        domain,
        name,
        path,
        secure,
        httpOnly,
        sameSite,
        expirationDate: expiresUtc > 0 ? expiresUtc : undefined
      })

      const values = targetCols
        .map((col, i) => {
          if (col === 'encrypted_value') {
            return "X''"
          }
          if (col === 'value') {
            return `X'${plaintextHex}'`
          }
          return cols[i]
        })
        .join(', ')
      sqlStatements.push(`INSERT OR REPLACE INTO cookies (${colList}) VALUES (${values});`)
      imported++
    }

    sqlStatements.push('COMMIT;')
    diag(`  prepared ${imported} INSERT statements, ${skipped} skipped`)

    const sqlFilePath = join(tmpDir, 'import.sql')
    writeFileSync(sqlFilePath, sqlStatements.join('\n'))

    execSync(`sqlite3 "${stagingCookiesPath}" < "${sqlFilePath}"`, {
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 500 * 1024 * 1024
    })

    rmSync(tmpDir, { recursive: true, force: true })
    diag(`  SQLite staging complete: ${imported} cookies, ${domainSet.size} domains`)

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
      try {
        unlinkSync(stagingCookiesPath)
      } catch {
        /* best-effort */
      }
      diag(`  all cookies loaded in-memory — no restart needed`)
    }

    const ua = getUserAgentForBrowser(browser.family)
    if (ua) {
      targetSession.setUserAgent(ua)
      browserSessionRegistry.persistUserAgent(ua)
      diag(`  set UA for partition: ${ua.substring(0, 80)}...`)
    }

    const summary: BrowserCookieImportSummary = {
      totalCookies: allRows.length,
      importedCookies: imported,
      skippedCookies: skipped,
      domains: [...domainSet].sort()
    }

    return { ok: true, profileId: '', summary }
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true })
    diag(`  SQLite import failed: ${err}`)
    return {
      ok: false,
      reason: `Could not import cookies from ${browser.label}. ${err}`
    }
  }
}
