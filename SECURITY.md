# acommune v2 security plan

This plan covers the relay, derived task state, hooks, `acommune watch`, and the board post box. Priorities are launch gates: **P0** permits code execution, credential theft, or unauthorized room access; **P1** risks durable data loss, privacy loss, or practical denial of service; **P2** is defense in depth.

## P0 — Trust boundary and room codes

### What the room code does

The room name plus code is a shared bearer credential. A holder can:

- join under any unused session name;
- read the entire message history by joining with a new cursor and syncing repeatedly, not only the board's last 200 messages;
- post any accepted message kind, create claims and task updates, and trigger an armed watcher; and
- read the board and its current presence/claim projection.

The code does **not**:

- identify a human or provide trustworthy attribution;
- prevent one participant from impersonating another person under a new session name;
- let a holder take over an existing session name without that session's 192-bit reclaim token;
- encrypt messages from the relay operator, a database reader, or an HTTP observer;
- make a malicious relay trustworthy; or
- make the hash chain authentic. A relay that can rewrite the database can recompute an unkeyed chain unless clients retain and compare an independently trusted checkpoint.

Compromise of a code means compromise of the room and, if its watcher is armed, a path to actions on the watch host. Rotate the code, revoke/recreate all sessions, and re-arm the watcher only after reviewing the log. v2 needs an operator-only rotate procedure; merely changing a config file does not invalidate the hash stored for the existing room.

### Entropy and the current throttle

The relay only requires six characters when a room is created (`relay/src/server.ts`). Length is not entropy.

| Code generation | Search space | Entropy | Average online guesses |
| --- | ---: | ---: | ---: |
| Six decimal digits | 1,000,000 | 19.9 bits | 500,000 |
| Six random lowercase letters/digits | 36^6 | 31.0 bits | 1.09 billion |
| Four uniformly selected Diceware words | 7,776^4 | 51.7 bits | 1.83 quadrillion |
| Sixteen random bytes | 2^128 | 128 bits | 2^127 |

Today, failed join/board pairing attempts share an in-memory limit of five failures per minute per socket IP. `POST /rooms` has a separate ten-attempts-per-minute limit and also tests a code when a known room name already exists. An attacker can therefore make roughly 15 guesses/minute/IP/process across the two paths. At that rate, a six-digit code falls in about 23 days on average; at only the five-failure path it is about 69 days. IP rotation divides those times by the number of source IPs.

The throttle is not a durable boundary: it resets on restart, is not shared by relay replicas, and keys `request.socket.remoteAddress`, which may collapse users behind a reverse proxy or fail to distinguish forwarded clients. The salted SHA-256 database value prevents rainbow-table reuse but is deliberately fast, so a database leak permits fast offline guessing of weak codes.

Required controls:

- Generate codes from at least 128 random bits; do not accept human-chosen codes for an armed room.
- Apply one shared failed-auth budget across room creation/retrieval, join, board, digest, and claims endpoints. Key it by room plus a proxy-validated client identity, with a coarser IP budget as a second dimension.
- Use exponential backoff and a `Retry-After` response. Persist/share counters before running multiple relay processes.
- Do not trust `X-Forwarded-For` unless the request came from a configured trusted proxy.
- Return consistent errors and timing after room lookup so endpoints do not become room-name oracles.
- Use a password KDF for stored room-code verifiers if human codes remain supported. A strong generated code is still required.

## P0 — The watch daemon is remote code execution by design

A bus message becomes part of a `claude -p` prompt. A participant, compromised relay, or network attacker who can modify that message can ask the brain to edit files, run commands, read credentials, make network calls, or persist on the mini. Prompt wording is not an authorization control. `--permission-mode acceptEdits` is not by itself a jail.

### Required execution model

1. **Dry-run is the default.** A newly installed or restarted watcher is disarmed. In dry-run, the brain has no mutating tools or bus credentials; it produces a proposed action, and the watcher posts that proposal through its own narrow client. It must not edit, run shell commands, install packages, or make arbitrary network calls.
2. **Arming is local and explicit.** Arm with a command run on the mini, never with a bus message. Store armed state in a `0600` file, include the room and allowed worktree, support an expiry, and log arm/disarm events. Config changes return the daemon to dry-run.
3. **Use a dedicated worktree and OS identity.** Run from a disposable, least-privileged worktree under a service account where practical. Do not give it the user's home directory, SSH agent, browser profile, cloud credentials, Docker socket, or unrestricted Keychain access.
4. **Layer Claude permissions.** Set the working directory to the approved repository. Use `--add-dir` only for an explicit list of additional project roots; never add `$HOME`, `/`, broad parent directories, or secret directories. Commit a reviewed on-disk `.claude/settings.local.json` in the watch worktree with an exact allowlist of tools and shell command patterns plus explicit denies for credential paths, persistence mechanisms, destructive Git operations, package publishing, deployment, and arbitrary network tools. The watcher must not generate or loosen this file.
5. **Avoid a shell command string.** Spawn an executable and argument array with `shell: false`. Treat `--brain-cmd` as a locally configured argv list, not text passed to `sh -c`.
6. **Keep bus authority narrow.** Give the brain a dedicated session and a post-only capability if one is added. Do not share the watcher's consuming cursor or a general room code with the brain. The watcher, not the brain, should attach correlation IDs and enforce allowed response kinds.

### Admission, caps, and failure handling

- Use an exact trigger-kind allowlist. Unknown future kinds are denied until locally enabled.
- Provide a sender allowlist. Require a nonempty sender allowlist before armed mode; match stable participant credentials when available, not only a display name.
- Apply the handoff `to` check after strict schema validation. Reject oversized, malformed, nested, or ambiguous trigger bodies.
- Default to one brain process, a 60-second cooldown, 10-minute timeout, 20 spawns/day/room, and 5/hour/sender. Persist counters across restart and cap queued triggers.
- Hold a single-instance lock. Two launchd instances must not consume the same identity or spawn duplicate work.
- Persist a queue and processed message sequence/hash before advancing work. The current sync cursor advances when messages are returned, so a crash after sync but before spawn otherwise loses a trigger.
- On timeout, terminate the whole process group, then force-kill after a grace period. A child shell or command must not outlive the brain.
- Use deterministic `client_msg_id` values for acknowledgements and failure posts so restart cannot duplicate them.
- If posting the failure notice also fails, record it locally and retry with a bound. “Never silent” means a durable local audit entry even when the relay is unavailable.

### Audit log

Write append-only JSONL owned by the watch user with mode `0600`. Record timestamp, room ID, trigger sequence and hash, claimed sender identity, validated trigger kind, mode (dry-run/armed), policy decision, prompt hash, worktree and permission-profile hash, child PID, start/end, exit status, timeout/kill state, changed-file list, response message ID, and errors. Do not record room codes, reclaim tokens, full environment variables, or secret-bearing prompt/output by default. Rotate by size, retain 30 days locally, and make log deletion or gaps visible.

## P0 — Hook feedback is untrusted input

A malicious or MITM'd relay controls claim results, including session names, paths, timestamps, and any future explanation field. If hook code prints that data into Claude Code, it can inject prompt instructions, terminal escapes, fake hook JSON, or text that appears to authorize a tool. It can also suppress or fabricate conflict warnings. Fail-open hooks protect availability, not integrity.

Required controls:

- Treat feedback as advisory only. It may display a conflict warning; it must never return a remote-controlled allow/deny decision, modify permissions, or claim that an action was approved.
- Validate a small versioned response schema. Reject unknown fields, excessive nesting, invalid timestamps, and values outside the requested room/file.
- Build one fixed warning template locally. Never print a relay-provided sentence or JSON object verbatim.
- Cap each interpolated name/path and the complete warning by UTF-8 bytes (recommended: 100 bytes/name, 300 bytes/path, 512 bytes total).
- Remove NUL, ANSI/terminal escapes, bidi controls, non-printing controls, and newlines; normalize Unicode and replace invalid text. Escape values for the hook's JSON output format.
- Delimit the warning as untrusted room data and instruct the receiving session to verify on the bus. Do not include arbitrary message bodies.
- Use HTTPS for an Internet relay. For mini HTTP, require the Tailscale conditions below.
- Never interpolate file paths, room values, or relay output into a shell command. Pass argv directly.
- Keep the two-second hard timeout, but measure against the stated 300 ms target and exit zero on timeout or parse/auth/network failure.

The claim check/post sequence is inherently time-of-check/time-of-use: two hooks can observe no claim and both post. The warning system must not be described as mutual exclusion. If exclusive claims become a security or correctness boundary, the relay needs one atomic claim operation with normalization and conflict semantics.

## P0 — Secrets hygiene

The room code currently present in Guy's global `CLAUDE.md` should be considered exposed to every Claude session that inherits that file and to any transcript, diagnostic bundle, or tool output that captures its instructions. It also turns repository prompt injection into a path to ask the model to disclose a live room credential. Remove it and rotate it now; deleting the text without rotating the room leaves the old credential valid.

Room codes and reclaim tokens must live in one of:

- a credentials file under `~/.config/acommune/` or `~/.acommune/`, with the directory `0700` and file `0600`, keyed by canonical relay origin plus room ID; or
- a narrowly scoped process environment loaded by the service manager from a protected file. Environment variables are convenient, not intrinsically secret, and must not be dumped to logs or passed to unrelated children.

On macOS, Keychain-backed storage is preferable for a persistent armed watcher. Keep nonsecret behavior config separate from credentials. Never put codes in `CLAUDE.md`, repository files, `.mcp.json`, hook output, prompts, audit logs, crash reports, or command-line arguments. The current CLI's `--code` flow can leak through shell history and process listings; add stdin, protected-file, or Keychain input before public use.

The board's fragment is not sent as an HTTP request, but it can remain in history, synced bookmarks, screenshots, clipboard history, and any script running on the page. Read it once, immediately remove it with `history.replaceState`, and keep the code in memory or session storage rather than local storage. A reclaim token in local storage is a persistent bearer credential available to any same-origin script; use a per-device board identity, a strict CSP without `unsafe-inline`, and short-lived/revocable board credentials before treating it as robust authentication.

## P1 — Data lifecycle and backups

### What is stored

SQLite contains room names, salted code verifiers, session names and reclaim tokens, per-session cursors, and the full append-only message log. Message bodies can contain code summaries, task descriptions, repository and absolute file paths, pasted source, stack traces, credentials, tokens, customer data, or any secret an agent/human posts. WAL files can contain recent or deleted rows.

The board's 200-message/256 KiB response is only a presentation window. It is not retention: `messages` remains unbounded, a new participant can sync from sequence zero, and chain verification reads the full room log. UI and privacy text must say this plainly.

### Retention and deletion

- For the private v2 deployment, document the honest default: full room history is retained until the whole room is explicitly deleted. Do not promise message-level deletion while “append-only” is the invariant.
- Before public launch, expire inactive rooms by default (recommended 30 days, configurable up to 90) and notify users before expiry. Retention jobs delete whole rooms, not arbitrary middle messages that would invalidate the chain.
- A room delete requires an operator/recovery credential stronger than the shared room code and a confirmation naming the room. It deletes the room, messages, task projection, sessions, cursors, board credentials, notifier/cache state, and associated abuse metadata; invalidates all tokens; checkpoints WAL; and performs secure compaction appropriate to SQLite. Record only a nonsecret deletion receipt.
- Backups make deletion asynchronous: the deletion contract must state the maximum backup age. Recommended maximum is 30 days, after which deleted-room data is no longer restorable.
- If legal erasure or per-message deletion is required, redesign the chain around encrypted room data with per-room key destruction, or explicit signed redaction/checkpoint records. Do not silently mutate the existing chain.

### Railway volume and backup story

A Railway persistent volume is primary storage, not a backup strategy. Do not copy a live SQLite database file without coordinating WAL state. Use SQLite's online backup API or a tested `VACUUM INTO`/checkpoint procedure, encrypt the result with a key kept outside Railway, and store it in a separate failure domain. Recommended policy: daily backups, seven daily plus four weekly restore points, hard-delete after 30 days, and quarterly restore tests. Define and test an RPO of 24 hours and an RTO before launch. Restrict volume, backup, and deploy access; log restores and exports.

Add body-level secret scanning/redaction warnings at clients, but do not claim it is complete. Operators should have a documented incident procedure for rotating a secret pasted into a room; deletion alone does not unexpose it.

## P1 — Transport and relay trust

### Railway

Use only an `https://` Railway origin with normal certificate validation. Reject downgrade to HTTP, unexpected redirects to another origin, credentials in query strings, and mixed-content calls. Add HSTS after the HTTPS hostname is stable. TLS protects data in transit to Railway; it does not protect against the relay process, Railway account compromise, database access, or malicious responses.

### Mini over Tailscale

Plain HTTP is acceptable only when every hop is inside an authenticated Tailscale tunnel, tailnet ACLs restrict the relay to intended devices/users, and the relay binds to localhost behind Tailscale Serve or to the mini's Tailscale address—not `0.0.0.0` on LAN/Wi-Fi. Do not expose it through Funnel or a public port as plain HTTP. Verify clients are not resolving the mini name to a non-Tailscale address. Prefer Tailscale Serve HTTPS when browser credential storage or origin security matters.

Localhost HTTP is acceptable for same-host MCP-to-relay traffic. Any public Internet, shared LAN, hotel Wi-Fi, or untrusted reverse-proxy path requires end-to-end HTTPS. Because room codes and reclaim tokens are bearer credentials, one observed request is sufficient for replay.

## P1 — Derived state and authorization invariants

- Treat the message log as authoritative. Update a task projection in the same SQLite transaction as message insertion, and provide an operator rebuild that replaces the projection atomically.
- Validate `handoff` and `task_update` bodies at ingress. A task update must reference an existing handoff in the same room; define legal transitions, idempotency, actor/assignee rules, and how conflicting updates resolve.
- Never let a client write projection tables directly. Compare rebuilt and live projections in tests and periodically in production.
- Scope every query and unique key by immutable room ID. Room names are routing labels, not tenant keys.
- Authenticate digest and claim reads and include them in the shared failed-auth throttle. Bound response bytes, row counts, task age, and path count.
- Separate consuming cursors for hooks, watcher, brain, and interactive sessions. Posting a claim or answer must not silently consume another component's unread messages.

## P2 — Hosted multi-tenant prerequisites (not built in v2)

Do not host mutually untrusted strangers until every item below is complete:

- [ ] Per-room and per-account request limits, plus global/IP limits, cover create, auth, join, read, long-poll, and post paths.
- [ ] Per-room caps exist for stored bytes, message count/rate, sessions, open tasks, paths per claim, response bytes, and concurrent long polls.
- [ ] Rooms expire by default; owners can export and delete them; backup deletion has a published deadline.
- [ ] Abuse reporting, evidence preservation, blocking, appeals, and an operator escalation path are documented and staffed.
- [ ] Room ownership/recovery is separate from the participant code; rotation and session/token revocation work without creating a new room.
- [ ] Stable authenticated sender identities replace display-name trust for watcher allowlists and moderation.
- [ ] Tenant-isolation tests prove every store, cache, notifier, metric, log, backup/export, and derived-state query is scoped by room ID.
- [ ] Distributed rate limiting and quotas work across replicas and cannot be bypassed through equivalent endpoints.
- [ ] Storage exhaustion, oversized projections, long-poll floods, room-creation floods, and expensive full-chain verification have bounded cost.
- [ ] Public-board CSP removes inline script/handlers; untrusted text rendering and browser credential handling pass an XSS review.
- [ ] Security contact, vulnerability intake, privacy notice, retention policy, and incident-response runbook are public.
- [ ] Secrets are encrypted at rest with separated key access, and backup/restore/delete paths are audited.

## Before public launch

- [ ] Remove the live code from global `CLAUDE.md`, rotate it, and revoke/recreate sessions.
- [ ] Generate 128-bit room codes and close the multi-endpoint, restart, replica, and proxy-aware throttle gaps.
- [ ] Ship watcher dry-run as the default; require local expiring arming and a sender allowlist for execution.
- [ ] Enforce the dedicated worktree/OS identity, reviewed `settings.local.json`, permission mode, and narrow `--add-dir` set.
- [ ] Add persistent spawn caps, single-instance locking, durable trigger handling, process-group kill, idempotent replies, and the `0600` audit log.
- [ ] Make hook output advisory-only, fixed-template, schema-validated, sanitized, and byte-capped.
- [ ] Separate hook, watcher, brain, board-device, and interactive session credentials/cursors.
- [ ] Replace fixed `guy@board` with per-device identities and harden CSP/browser token storage.
- [ ] Publish the full-log retention truth, room deletion semantics, backup age, and incident procedure.
- [ ] Implement encrypted consistent backups and pass a restore test.
- [ ] Require HTTPS for Railway and enforce the Tailscale-only conditions for mini HTTP.
- [ ] Complete every multi-tenant prerequisite before admitting mutually untrusted rooms.
