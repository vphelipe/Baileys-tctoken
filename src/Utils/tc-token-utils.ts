import { createHmac } from 'crypto'
import type { SignalKeyStoreWithTransaction } from '../Types'
import type { BinaryNode } from '../WABinary'
import { jidNormalizedUser, getBinaryNodeChild, getBinaryNodeChildren } from '../WABinary'

// Rolling bucket size: 7 days in seconds
const TC_TOKEN_BUCKET_SIZE = 604800

type TcTokenParams = {
	jid: string
	baseContent?: BinaryNode[]
	authState: {
		keys: SignalKeyStoreWithTransaction
	}
}

type TcTokenData = {
	token: Buffer
	timestamp?: string | number
}

type WaitForTcTokenParams = {
	authState: {
		keys: SignalKeyStoreWithTransaction
	}
	jid: string
	maxWaitMs?: number
	pollIntervalMs?: number
}

type StoreTcTokensParams = {
	node: BinaryNode
	keys: SignalKeyStoreWithTransaction
	onNewJidStored?: (jid: string) => void
}

/**
 * Check if a TC token is expired using rolling bucket algorithm.
 * Tokens are valid for 28 days (4 x 7-day buckets).
 */
export function isTcTokenExpired(timestamp: number | string | undefined): boolean {
	if (!timestamp) return true

	const ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp
	if (!ts || ts <= 0) return true

	const now = Math.floor(Date.now() / 1000)
	const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_SIZE)
	const cutoff = (currentBucket - 3) * TC_TOKEN_BUCKET_SIZE
	return ts < cutoff
}

/**
 * Determine if a new TC token should be re-issued.
 * Returns true when we cross a 7-day bucket boundary, so we don't
 * spam the server with token re-issuance on every single message.
 */
export function shouldSendNewTcToken(senderTimestamp: number | string | null | undefined): boolean {
	if (!senderTimestamp) return true

	const ts = typeof senderTimestamp === 'string' ? parseInt(senderTimestamp, 10) : senderTimestamp
	if (!ts || ts <= 0) return true

	const now = Math.floor(Date.now() / 1000)
	const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_SIZE)
	const tokenBucket = Math.floor(ts / TC_TOKEN_BUCKET_SIZE)
	return currentBucket > tokenBucket
}

/**
 * Build a tctoken BinaryNode from authState for a given JID.
 * Returns the tctoken node and sender timestamp for re-issuance logic.
 */
export async function buildTcTokenFromJid({
	authState,
	jid,
	baseContent = []
}: TcTokenParams): Promise<{
	tokenNode: BinaryNode | null
	senderTimestamp: number | string | null
	content: BinaryNode[]
}> {
	const normalizedJid = jidNormalizedUser(jid)
	let tokenNode: BinaryNode | null = null
	let senderTimestamp: number | string | null = null

	try {
		const tcTokenData = await authState.keys.get('tctoken', [normalizedJid])
		const data: TcTokenData | undefined = tcTokenData?.[normalizedJid]

		if (data?.token) {
			senderTimestamp = data.timestamp ?? null

			if (!isTcTokenExpired(data.timestamp)) {
				tokenNode = {
					tag: 'tctoken',
					attrs: {},
					content: data.token
				}
				baseContent.push(tokenNode)
			} else {
				// Opportunistically delete expired token
				await authState.keys.set({
					tctoken: { [normalizedJid]: null }
				})
			}
		}
	} catch {
		// tctoken failure should not break the caller
	}

	return { tokenNode, senderTimestamp, content: baseContent }
}

/**
 * Poll authState waiting for a TC token to arrive via privacy_token notification.
 * Used in error 463 recovery flow.
 */
export async function waitForTcToken({
	authState,
	jid,
	maxWaitMs = 2000,
	pollIntervalMs = 150
}: WaitForTcTokenParams): Promise<TcTokenData | null> {
	const normalizedJid = jidNormalizedUser(jid)
	const deadline = Date.now() + maxWaitMs

	while (Date.now() < deadline) {
		try {
			const data = await authState.keys.get('tctoken', [normalizedJid])
			const tokenData = data?.[normalizedJid]

			if (tokenData?.token && !isTcTokenExpired(tokenData.timestamp)) {
				return tokenData
			}
		} catch {
			// ignore polling errors
		}

		await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
	}

	return null
}

/**
 * Parse and store TC tokens from a privacy_token notification node.
 * Includes monotonicity guard: rejects tokens with older timestamps.
 */
export async function storeTcTokensFromNotification({
	node,
	keys,
	onNewJidStored
}: StoreTcTokensParams): Promise<number> {
	const tokensNode = getBinaryNodeChild(node, 'tokens')
	const from = jidNormalizedUser(node.attrs.from)

	if (!tokensNode) return 0

	const tokenNodes = getBinaryNodeChildren(tokensNode, 'token')
	let storedCount = 0

	for (const tokenNode of tokenNodes) {
		const { attrs, content } = tokenNode
		const type = attrs.type
		const timestamp = attrs.t

		if (type !== 'trusted_contact' || !(Buffer.isBuffer(content) || content instanceof Uint8Array)) {
			continue
		}

		// Ensure we store as Buffer for consistency
		const tokenBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content)

		// Monotonicity guard: reject older tokens
		const incomingTs = timestamp ? parseInt(String(timestamp), 10) : 0
		try {
			const existing = await keys.get('tctoken', [from])
			const existingData = existing?.[from]
			if (existingData?.timestamp) {
				const existingTs = typeof existingData.timestamp === 'string'
					? parseInt(existingData.timestamp, 10)
					: existingData.timestamp
				if (incomingTs > 0 && existingTs > 0 && incomingTs < existingTs) {
					continue // Reject older token
				}
			}
		} catch {
			// If we can't check existing, proceed with storing
		}

		await keys.set({
			tctoken: { [from]: { token: tokenBuffer, timestamp: timestamp || String(incomingTs) } }
		})

		storedCount++
		onNewJidStored?.(from)
	}

	return storedCount
}

/**
 * Compute CS Token (client-side token) as fallback when no TC token is available.
 * CS Token = HMAC-SHA256(nctSalt, UTF8(recipientLid))
 *
 * Used for first-contact messaging when the server hasn't provided a TC token yet.
 * Requires nctSalt from credentials (received via NctSaltSyncAction or history sync).
 */
export function computeCsToken(nctSalt: Uint8Array | Buffer, recipientLid: string): Uint8Array {
	const hmac = createHmac('sha256', Buffer.from(nctSalt))
	hmac.update(recipientLid, 'utf8')
	return new Uint8Array(hmac.digest())
}

/**
 * Prune expired TC tokens from the key store.
 * Iterates over a set of known JIDs and removes any tokens that are expired.
 * Should be called periodically to prevent memory leaks from accumulated tokens.
 */
export async function pruneExpiredTcTokens(
	keys: SignalKeyStoreWithTransaction,
	knownJids: Set<string>
): Promise<number> {
	let pruned = 0

	for (const jid of knownJids) {
		try {
			const data = await keys.get('tctoken', [jid])
			const tokenData = data?.[jid]

			if (tokenData?.timestamp && isTcTokenExpired(tokenData.timestamp)) {
				await keys.set({ tctoken: { [jid]: null } })
				knownJids.delete(jid)
				pruned++
			}
		} catch {
			// ignore errors during pruning
		}
	}

	return pruned
}
