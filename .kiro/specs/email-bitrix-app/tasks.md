# Implementation Plan: Email-Bitrix App

## Overview

Build a multi-tenant Node.js application that bridges IMAP email accounts with Bitrix24 CRM. The implementation follows a bottom-up approach: scaffolding → database → crypto → repositories → pipeline modules → Bitrix integration → orchestration → background workers → REST API → entry point.

## Tasks

- [x] 1. Project scaffolding and infrastructure
  - [x] 1.1 Create package.json with ES modules, dependencies, and scripts
    - Initialize with `"type": "module"` for ES modules
    - Add dependencies: fastify, imapflow, mailparser, bullmq, pg, ioredis, pino, bcrypt, jsonwebtoken, dotenv
    - Add devDependencies: vitest, fast-check, @testcontainers/postgresql
    - Add scripts: start, dev, test, test:props, migrate
    - _Requirements: 20.1, 21.1_

  - [x] 1.2 Create Docker Compose configuration
    - Define services: app (Node.js 20), postgres (16-alpine), redis (7-alpine)
    - Add healthchecks for postgres and redis
    - Configure named volume for postgres data persistence
    - Set depends_on with condition: service_healthy
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6_

  - [x] 1.3 Create Dockerfile and .env.example
    - Multi-stage Dockerfile: build stage + production stage
    - .env.example with all environment variables documented
    - Include PORT, DATABASE_URL, REDIS_URL, ENCRYPTION_KEY, JWT_SECRET, JWT_EXPIRES_IN, ALERT_CHECK_INTERVAL_SEC, LOG_LEVEL
    - _Requirements: 21.1, 21.4_

  - [x] 1.4 Create project directory structure and configuration files
    - Create src/ directory tree: crypto/, imap/, pipeline/, bitrix/, jobs/, alerts/, api/, db/
    - Create vitest.config.js with test paths and coverage settings
    - Create .gitignore, eslint config
    - _Requirements: 20.1_

- [x] 2. Database layer
  - [x] 2.1 Create SQL migration files
    - Create src/db/migrations/ with numbered SQL files: 001_tenants.sql through 007_users.sql
    - Include all tables, indexes, constraints, and CHECK constraints from design
    - Include partial indexes for dedup and SLA checks
    - _Requirements: 1.1, 1.3, 2.1, 5.1, 5.2, 7.1, 13.1, 15.1, 18.3_

  - [x] 2.2 Create database client and migration runner
    - Create src/db/client.js using pg Pool with DATABASE_URL
    - Create src/db/migrate.js to run migrations in order
    - Support idempotent migrations with a migrations tracking table
    - _Requirements: 20.6_

  - [x] 2.3 Create repository modules for tenants and IMAP accounts
    - Create src/db/repos/TenantRepo.js: findAll, findById, create, update, deactivate
    - Create src/db/repos/ImapAccountRepo.js: findByTenant, findAllActive, create, update, toggle, deactivate, countByTenant
    - ImapAccountRepo uses CryptoModule for password encrypt/decrypt
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4_

  - [x] 2.4 Create repository modules for email events and Bitrix results
    - Create src/db/repos/EmailEventRepo.js: create, updateStatus, findByTenant (paginated with filters), getDailyStats
    - Create src/db/repos/BitrixResultRepo.js: create, update
    - Create src/db/repos/RetryJobRepo.js: create, findPending (SELECT FOR UPDATE SKIP LOCKED), markComplete, markFailed
    - _Requirements: 7.1, 7.2, 12.1, 12.2, 12.3, 13.1, 13.3, 17.1, 17.2_

  - [x] 2.5 Create repository modules for users and alert configs
    - Create src/db/repos/UserRepo.js: findByEmail, create, findTenantsByUser
    - Create src/db/repos/AlertConfigRepo.js: findByTenant, create, update
    - _Requirements: 15.1, 18.1, 18.3, 18.5_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. CryptoModule
  - [x] 4.1 Implement AES-256-GCM encryption and decryption
    - Create src/crypto/passwords.js with encrypt(), decrypt(), loadEncryptionKey()
    - Use Node.js crypto module: randomBytes for IV, createCipheriv/createDecipheriv
    - Output format: Base64(IV + authTag + ciphertext)
    - Validate ENCRYPTION_KEY is 32 bytes (64 hex chars)
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 2.5, 2.6_

  - [ ]* 4.2 Write property tests for CryptoModule
    - **Property 1: Encryption round-trip** — For any plaintext 1-512 chars, encrypt then decrypt produces original
    - **Property 2: Unique IV per encryption** — Same plaintext encrypted twice produces different ciphertext
    - **Validates: Requirements 19.1, 19.3**

  - [ ]* 4.3 Write unit tests for CryptoModule
    - Test invalid key (missing, wrong length)
    - Test corrupted ciphertext decryption failure
    - Test empty string and max-length string
    - _Requirements: 19.4, 19.5_

- [x] 5. Email parsing and pipeline modules
  - [x] 5.1 Implement EmailParser
    - Create src/imap/EmailParser.js with parseRaw() function
    - Use mailparser's simpleParser to extract all fields
    - Truncate body_html to 200KB, body_text to 10KB
    - Reject emails missing message_id or from_email with descriptive error
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ]* 5.2 Write property tests for EmailParser
    - **Property 4: Valid email parsing completeness** — Any raw email with message_id and from_email produces complete EmailEventData
    - **Property 5: Invalid email rejection** — Any raw email missing message_id or from_email is rejected
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

  - [x] 5.3 Implement DedupEngine
    - Create src/pipeline/DedupEngine.js with checkDuplicate() function
    - Query email_events for message_id match within 24h window
    - Query email_events for subject+from match within 2min window (case-insensitive, trimmed)
    - Skip message_id check if message_id is null/empty
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ]* 5.4 Write property tests for DedupEngine
    - **Property 6: Message-ID dedup within 24h** — Same message_id + same account + within 24h = duplicate
    - **Property 7: Subject+from dedup within 2min** — Same from+subject (case-insensitive) + same account + within 2min = duplicate
    - **Validates: Requirements 5.1, 5.2**

  - [x] 5.5 Implement FilterEngine
    - Create src/pipeline/FilterEngine.js with checkFilter() function
    - Case-insensitive exact match for ignore_from
    - Case-insensitive substring match for ignore_subject
    - Return pass-through when both lists are empty
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ]* 5.6 Write property tests for FilterEngine
    - **Property 8: Filter by sender address** — from_email in ignore_from (case-insensitive) = ignored
    - **Property 9: Filter by subject pattern** — subject contains ignore_subject entry (case-insensitive) = ignored
    - **Validates: Requirements 6.1, 6.2**

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Bitrix24 integration modules
  - [x] 7.1 Implement BitrixClient
    - Create src/bitrix/BitrixClient.js class
    - Implement call() with 30s timeout per attempt
    - Internal retry: 3 attempts, 2s fixed delay for transient errors (429, 5xx, timeout)
    - Immediate propagation for non-transient errors (400, 401, 403, 404)
    - Include error type and attempt count in propagated errors
    - _Requirements: 14.1, 14.2, 14.3, 14.4_

  - [ ]* 7.2 Write property tests for BitrixClient error classification
    - **Property 14: HTTP error transient classification** — 429 and 5xx are transient; 400, 401, 403, 404 are non-transient
    - **Validates: Requirements 14.1, 14.4**

  - [x] 7.3 Implement ContactResolver
    - Create src/bitrix/ContactResolver.js with resolveContact() function
    - Search via crm.duplicate.findbycomm, use first result if multiple
    - Create via crm.contact.add if not found
    - Fallback: use email local part as name when from_name is empty/null
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ]* 7.4 Write property tests for ContactResolver name fallback
    - **Property 10: Contact name fallback to email local part** — When from_name is null/empty, use part before '@'
    - **Validates: Requirements 8.4**

  - [x] 7.5 Implement DealBuilder
    - Create src/bitrix/DealBuilder.js with createDeal() function
    - Use tenant's category_id, stage_id, responsible_id
    - Truncate subject to 300 chars for deal title
    - Fallback to from_email when subject is empty/null
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [ ]* 7.6 Write property tests for DealBuilder title truncation
    - **Property 11: Deal title truncation** — Title is at most 300 chars and is a prefix of original subject
    - **Validates: Requirements 9.3, 9.4**

  - [x] 7.7 Implement ActivityWriter
    - Create src/bitrix/ActivityWriter.js with createActivity() function
    - Create email activity via crm.activity.add linked to deal
    - Add timeline comment with reply-to (fallback to from_email)
    - Store bitrix_activity_id in results
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 7.8 Implement AttachmentUploader
    - Create src/bitrix/AttachmentUploader.js with uploadAttachments() function
    - Upload each attachment as base64 timeline comment
    - Skip attachments > 20MB with warning log
    - Continue on individual failure, track uploaded/skipped/failed counts
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [ ]* 7.9 Write property tests for AttachmentUploader size threshold
    - **Property 12: Attachment size threshold** — Attachments > 20MB are skipped; ≤ 20MB are attempted
    - **Validates: Requirements 11.4**

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Email pipeline orchestration
  - [x] 9.1 Implement EmailPipeline
    - Create src/pipeline/EmailPipeline.js with processEmail() function
    - Orchestrate: parse → dedup → filter → save (RECEBIDO) → update (PROCESSANDO) → Bitrix integration → update (SUCESSO)
    - On dedup match: save as DUPLICADO, stop
    - On filter match: save as IGNORADO, stop
    - On Bitrix failure: mark ERRO, schedule retry_job with backoff delay
    - Record processed_at timestamp on success
    - Store API log in bitrix_results.api_log
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 12.1, 12.2, 12.3, 12.4, 13.1, 13.2_

  - [ ]* 9.2 Write unit tests for EmailPipeline
    - Test full success flow (mocked Bitrix)
    - Test dedup short-circuit
    - Test filter short-circuit
    - Test Bitrix failure → ERRO + retry_job creation
    - _Requirements: 7.1, 12.1, 13.1_

- [x] 10. IMAP listener and tenant scheduler
  - [x] 10.1 Implement ImapListener
    - Create src/imap/ImapListener.js class using imapflow
    - Support IDLE mode and poll mode based on config
    - Implement start(), stop(), pause(), resume()
    - Exponential backoff reconnection: 5s base, 5 attempts
    - Update last_poll_at on successful check
    - Record last_error on failure
    - _Requirements: 2.7, 2.8, 3.1, 3.2, 3.3, 3.4_

  - [x] 10.2 Implement TenantScheduler
    - Create src/imap/TenantScheduler.js class
    - Manage Map<accountId, ImapListener>
    - Implement startAll(), addWorker(), removeWorker(), pauseWorker(), resumeWorker(), stopTenant(), getStatus()
    - Load all active accounts on startAll()
    - _Requirements: 1.5, 2.1, 2.3, 2.4, 20.2_

- [ ] 11. Background workers
  - [x] 11.1 Implement RetryWorker
    - Create src/jobs/RetryWorker.js class
    - Poll every 30s for pending retry_jobs where scheduled_at <= now
    - Use SELECT FOR UPDATE SKIP LOCKED to prevent duplicate processing
    - Execute job: re-run Bitrix integration for the email_event
    - On success: update email_event to SUCESSO
    - On failure with attempts < 5: schedule next retry with backoff [2, 5, 15, 30, 60] minutes
    - On 5th failure: mark FALHA_DEFINITIVA
    - _Requirements: 13.2, 13.3, 13.4, 13.5, 13.6_

  - [ ]* 11.2 Write property tests for RetryWorker backoff delays
    - **Property 13: Retry backoff delay sequence** — Attempt N maps to [2, 5, 15, 30, 60][N-1] minutes
    - **Validates: Requirements 13.2**

  - [x] 11.3 Implement AlertService
    - Create src/alerts/AlertService.js class
    - Poll at configurable interval (default 60s)
    - Check for email_events in ERRO/PROCESSANDO exceeding sla_minutes
    - Send alerts via EMAIL, WEBHOOK, or SLACK based on alert_config
    - Trigger alert on FALHA_DEFINITIVA within 60s
    - Prevent duplicate alerts (track last alert time)
    - Retry delivery 3x with 30s interval on failure
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8_

- [x] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. REST API
  - [x] 13.1 Implement auth middleware and login route
    - Create src/api/middleware/auth.js with JWT verification
    - Create src/api/routes/auth.js with POST /auth/login
    - Use bcrypt (cost factor ≥ 10) for password verification
    - Issue JWT with configurable expiration (JWT_EXPIRES_IN)
    - Role-based access: admin (all), tenant_user (own tenants only)
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8_

  - [x] 13.2 Implement tenant management routes
    - Create src/api/routes/tenants.js
    - GET /tenants — list active tenants (admin only)
    - POST /tenants — create tenant with unique bitrix_url validation
    - PATCH /tenants/:id — update tenant fields
    - POST /tenants/test-bitrix — test webhook (10s timeout)
    - POST /tenants/test-imap — test IMAP connection (15s timeout)
    - _Requirements: 1.1, 1.2, 1.3, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7_

  - [x] 13.3 Implement IMAP account routes
    - Create src/api/routes/imapAccounts.js
    - GET /tenants/:id/imap-accounts — list accounts
    - POST /tenants/:id/imap-accounts — create (enforce 50 limit, start worker)
    - PATCH /tenants/:id/imap-accounts/:accountId/toggle — pause/resume worker
    - DELETE /tenants/:id/imap-accounts/:accountId — deactivate, stop worker
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 13.4 Implement event log and dashboard routes
    - Create src/api/routes/events.js
    - GET /tenants/:id/events — paginated (default 20, max 100), filterable by status, date range, text search
    - GET /tenants/:id/dashboard — daily stats for last 30 days grouped by status
    - GET /admin/workers — all IMAP worker statuses
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

  - [x] 13.5 Create Fastify app setup and plugin registration
    - Create src/api/app.js with Fastify instance
    - Register all route plugins
    - Add request validation schemas
    - Add pino logger integration
    - Add error handler with structured error responses
    - _Requirements: 20.1_

- [x] 14. Application entry point
  - [x] 14.1 Implement main entry point
    - Create src/index.js
    - Initialize: validate env vars → connect DB → run migrations → connect Redis → start Fastify → start TenantScheduler → start RetryWorker → start AlertService
    - Graceful shutdown on SIGTERM/SIGINT: stop listeners, drain connections, close server
    - Exit with non-zero code on DB or Redis connection failure
    - Log startup-complete message when ready
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8_

- [x] 15. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The implementation uses Node.js 20+ ES modules, PostgreSQL 16, Redis 7, Fastify, imapflow, mailparser, BullMQ, pino, fast-check, and vitest
- All code examples should use JavaScript ES module syntax (import/export)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4"] },
    { "id": 1, "tasks": ["2.1", "2.2"] },
    { "id": 2, "tasks": ["2.3", "2.4", "2.5", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "5.1", "5.3", "5.5"] },
    { "id": 4, "tasks": ["5.2", "5.4", "5.6", "7.1"] },
    { "id": 5, "tasks": ["7.2", "7.3", "7.5", "7.7", "7.8"] },
    { "id": 6, "tasks": ["7.4", "7.6", "7.9", "9.1"] },
    { "id": 7, "tasks": ["9.2", "10.1"] },
    { "id": 8, "tasks": ["10.2", "11.1"] },
    { "id": 9, "tasks": ["11.2", "11.3"] },
    { "id": 10, "tasks": ["13.1", "13.2", "13.3", "13.4", "13.5"] },
    { "id": 11, "tasks": ["14.1"] }
  ]
}
```
