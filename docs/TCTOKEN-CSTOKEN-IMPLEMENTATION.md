# TC Token & CS Token Implementation

## Overview

This PR implements complete TC Token (Trusted Contact Token) and CS Token (Client-Side Token) handling for WhatsApp Web protocol compliance. Without these tokens, the server returns **error 463 (MissingTcToken)** on 1:1 message sends, causing message delivery failures.

## What Was Already in Baileys

- Basic `buildTcTokenFromJid()` in `tc-token-utils.ts` (no expiration logic)
- Token attachment in `relayMessage()` for 1:1 messages
- `getPrivacyTokens()` IQ function (request tokens from server)
- `handlePrivacyTokenNotification()` storing tokens from server notifications
- `presenceSubscribe()` and `profilePictureUrl()` using tctoken

## What This PR Adds

### 1. Token Expiration & Bucket Logic (`tc-token-utils.ts`)

- **`isTcTokenExpired(timestamp)`**: Rolling 28-day expiration window using 7-day buckets
- **`shouldSendNewTcToken(senderTimestamp)`**: Checks if we crossed a 7-day bucket boundary to avoid spamming the server with re-issuance on every message
- **Opportunistic cleanup**: Expired tokens are deleted when detected during `buildTcTokenFromJid()`

### 2. CS Token Fallback (`tc-token-utils.ts` + `messages-send.ts`)

- **`computeCsToken(nctSalt, recipientLid)`**: HMAC-SHA256 fallback for first-contact messaging
- When no TC token exists and the recipient is a LID user with `nctSalt` available, a CS token is computed and attached as `<cstoken>` node
- Matches WA Web's `genCsTokenBody` behavior

### 3. Error 463 Recovery (`messages-recv.ts`)

Complete 3-step recovery flow in `handleBadAck()`:

1. **Request tokens**: Send `getPrivacyTokens()` IQ to server
2. **Wait for delivery**: Poll `waitForTcToken()` up to 3 seconds (200ms intervals) for async notification
3. **Retry message**: Retrieve from `messageRetryManager` cache or `getMessage()` callback, then `relayMessage()` with same ID

Guard: Each message ID gets at most ONE retry (prevents infinite loops).

### 4. Error 421 Recovery (`messages-recv.ts`)

For groups: Invalidates device cache and retries the message once when server reports stale group addressing.

### 5. Error 429 Handling (`messages-recv.ts`)

Rate limit from server: Emits `messages.update` with ERROR status. Does NOT retry (retrying would make it worse).

### 6. Fire-and-Forget Token Re-issuance (`messages-send.ts`)

After every successful 1:1 send, if `shouldSendNewTcToken()` returns true (bucket boundary crossed), issues a privacy token IQ to the server. This tells the server "I trust this contact", ensuring future messages always have valid tokens. Non-blocking — errors are silently swallowed.

### 7. NCT Salt Support (`history.ts`, `process-message.ts`, `auth-utils.ts`)

- `nctSalt` field added to `AuthenticationCreds`
- Extracted from history sync notifications
- Persisted via `creds.update` event
- Used by `computeCsToken()` for CS token fallback

### 8. Improved `storeTcTokensFromNotification()` (`tc-token-utils.ts`)

- **Monotonicity guard**: Rejects tokens with older timestamps than existing ones
- **Callback**: `onNewJidStored` for tracking new token arrivals
- Returns count of stored tokens for logging

## Token Lifecycle

```
1. INITIALIZATION
   Contact sends message → Server sends privacy_token notification
   → handlePrivacyTokenNotification() → storeTcTokensFromNotification()
   → Token stored in authState.keys (type: 'tctoken', id: JID)

2. OUTBOUND MESSAGE
   relayMessage() → buildTcTokenFromJid()
   → Token found & not expired? Attach <tctoken> node
   → No token? Check nctSalt → computeCsToken() → Attach <cstoken> node
   → No fallback? Send without token (may trigger 463)
   → After send: shouldSendNewTcToken()? → Issue privacy token IQ (fire-and-forget)

3. ERROR 463 RECOVERY
   Server returns error 463 → handleBadAck()
   → getPrivacyTokens([jid]) → waitForTcToken(3s) → Retrieve cached message → relayMessage() retry

4. MAINTENANCE
   buildTcTokenFromJid() → isTcTokenExpired()? → Delete expired token
```

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `TC_TOKEN_BUCKET_SIZE` | 604800 (7 days) | Rolling bucket size for expiration |
| Expiration window | 28 days | 4 buckets before token expires |
| Error 463 wait timeout | 3000ms | Max wait for async token delivery |
| Error 463 poll interval | 200ms | Polling frequency during wait |
| Max retried msg IDs | 1000 | Memory cap, prunes 500 when exceeded |

## Files Modified

| File | Changes |
|------|---------|
| `src/Utils/tc-token-utils.ts` | Complete rewrite: expiration, cstoken, wait, store |
| `src/Socket/messages-send.ts` | cstoken fallback, fire-and-forget re-issuance |
| `src/Socket/messages-recv.ts` | Error 463/421/429 handling in handleBadAck |
| `src/Socket/chats.ts` | Updated buildTcTokenFromJid call sites |
| `src/Types/Auth.ts` | Added nctSalt to AuthenticationCreds |
| `src/Utils/auth-utils.ts` | Added nctSalt to initAuthCreds |
| `src/Utils/history.ts` | Extract nctSalt from history sync |
| `src/Utils/process-message.ts` | Emit nctSalt via creds.update |
| `src/Utils/index.ts` | Export tc-token-utils |
