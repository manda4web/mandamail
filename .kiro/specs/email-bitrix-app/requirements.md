# Requirements Document

## Introduction

Multi-tenant application that receives emails via IMAP and automatically creates deals (cards) in Bitrix24. The system follows a model where 1 tenant = 1 Bitrix24 URL, with N IMAP accounts per tenant. The application replaces a previous n8n workflow by solving critical problems: lack of visibility on received emails, silent failures, unpredictable retries, single-tenant limitations, and absence of alerting.

## Glossary

- **Tenant**: An organization entity mapped to a single Bitrix24 URL, owning N IMAP accounts
- **IMAP_Worker**: A per-account background process that monitors an IMAP mailbox for new emails using IDLE or polling mode
- **Email_Event**: A database record representing a received email and its processing lifecycle through statuses: RECEBIDO, PROCESSANDO, SUCESSO, DUPLICADO, IGNORADO, ERRO, FALHA_DEFINITIVA
- **Email_Pipeline**: The orchestration module that processes emails through parse, dedup, filter, save, and Bitrix24 integration stages
- **Dedup_Engine**: The module responsible for detecting duplicate emails by message_id within 24 hours or by subject+from within 2 minutes
- **Filter_Engine**: The module that applies global and per-tenant ignore rules based on sender address and subject patterns
- **Contact_Resolver**: The module that finds or creates a contact in Bitrix24 using the sender's email address
- **Deal_Builder**: The module that creates a deal in Bitrix24 via crm.deal.add
- **Activity_Writer**: The module that creates an email activity and timeline comment in Bitrix24 with reply-to information
- **Attachment_Uploader**: The module that uploads email attachments as base64-encoded timeline comments in Bitrix24
- **Retry_Worker**: A background process that processes pending retry jobs every 30 seconds with exponential backoff
- **Alert_Service**: The module that monitors stuck emails against configurable SLA thresholds and sends notifications
- **Tenant_Scheduler**: The in-memory manager that controls all IMAP workers, supporting add/remove at runtime
- **Bitrix_Client**: HTTP wrapper for Bitrix24 REST API calls with internal retry (3 attempts, 30s timeout)
- **REST_API**: Fastify-based HTTP API for tenant management, IMAP account CRUD, event logs, and dashboard
- **Crypto_Module**: Encryption module using AES-256-GCM for IMAP passwords at rest
- **BullMQ**: Redis-based queue library used for retry job scheduling

## Requirements

### Requirement 1: Multi-Tenant Isolation

**User Story:** As a system administrator, I want each tenant to be isolated by Bitrix24 URL, so that multiple organizations can use the system without interfering with each other.

#### Acceptance Criteria

1. THE REST_API SHALL enforce that each Tenant has a unique bitrix_url by validating that no other active Tenant record shares the same bitrix_url before persisting
2. IF a Tenant creation or update request contains a bitrix_url that is already assigned to another active Tenant, THEN THE REST_API SHALL reject the request with an error response indicating the URL is already in use
3. WHEN a Tenant is created, THE REST_API SHALL store the tenant configuration including bitrix_url, bitrix_webhook_token, bitrix_responsible_id, bitrix_category_id, bitrix_stage_id, and ignore rules
4. THE Email_Pipeline SHALL process emails using only the configuration of the Tenant that owns the IMAP account, without reading or writing data belonging to any other Tenant
5. WHEN a Tenant is deactivated, THE Tenant_Scheduler SHALL stop all IMAP_Workers belonging to that Tenant within 30 seconds
6. WHEN a Tenant is deactivated, THE Email_Pipeline SHALL complete processing for any Email_Events already in PROCESSANDO status before the deactivation takes effect, and SHALL not initiate processing of new emails for that Tenant

### Requirement 2: IMAP Account Management

**User Story:** As a tenant administrator, I want to manage multiple IMAP accounts per tenant at runtime, so that I can monitor several mailboxes without restarting the system.

#### Acceptance Criteria

1. WHEN an IMAP account is created via POST /tenants/:id/imap-accounts with valid host, port, username, password, and poll_mode fields, THE Tenant_Scheduler SHALL start an IMAP_Worker for that account within 5 seconds of successful creation
2. IF the tenant already has 50 IMAP accounts, THEN THE System SHALL reject the creation request with an error indicating the maximum account limit has been reached
3. WHEN an IMAP account is toggled via PATCH /tenants/:id/imap-accounts/:accountId/toggle, THE Tenant_Scheduler SHALL pause or resume the corresponding IMAP_Worker
4. WHEN an IMAP account is deleted via DELETE /tenants/:id/imap-accounts/:accountId, THE Tenant_Scheduler SHALL stop the IMAP_Worker and set the account record status to inactive
5. THE Crypto_Module SHALL encrypt IMAP account passwords using AES-256-GCM before storing them in the database
6. THE Crypto_Module SHALL decrypt IMAP account passwords only when establishing an IMAP connection
7. WHEN an IMAP account has poll_mode set to "idle", THE IMAP_Worker SHALL use IMAP IDLE to receive new email notifications
8. WHEN an IMAP account has poll_mode set to "poll", THE IMAP_Worker SHALL poll the mailbox at the interval specified by poll_interval_sec, which must be between 30 and 3600 seconds
9. IF the IMAP_Worker fails to establish a connection to the mail server after 3 consecutive attempts, THEN THE System SHALL mark the account status as "error" and notify the tenant administrator with an error indicating the connection failure reason

### Requirement 3: IMAP Connection Resilience

**User Story:** As a system operator, I want IMAP workers to automatically reconnect after failures, so that email monitoring continues without manual intervention.

#### Acceptance Criteria

1. WHEN an IMAP connection drops, THE IMAP_Worker SHALL attempt to reconnect using exponential backoff starting at 5 seconds, doubling after each failed attempt, up to a maximum of 5 consecutive retry attempts
2. IF an IMAP connection fails 5 consecutive times, THEN THE IMAP_Worker SHALL record the error in the imap_accounts.last_error field and stop retrying until the next scheduled poll cycle
3. WHEN a mailbox check completes successfully, THE IMAP_Worker SHALL update the last_poll_at timestamp to the current time
4. IF the IMAP_Worker has exhausted all retry attempts and stopped retrying, THEN THE IMAP_Worker SHALL set the account status to indicate a connection failure requiring attention

### Requirement 4: Email Parsing

**User Story:** As the system, I want to extract structured data from raw emails, so that downstream modules can process email content reliably.

#### Acceptance Criteria

1. WHEN a new email is received, THE Email_Pipeline SHALL parse the email using mailparser to extract: message_id, from_email, from_name, reply_to, subject, body_html, body_text, to_emails, cc_emails, and attachment_count
2. WHEN parsing completes successfully, THE Email_Pipeline SHALL produce an Email_Event object containing all extracted fields, representing missing optional fields (reply_to, body_html, body_text, cc_emails) as null or empty arrays as applicable
3. IF parsing fails due to a malformed email or a missing message_id field, THEN THE Email_Pipeline SHALL mark the Email_Event as ERRO with an error_message indicating the parse failure reason and SHALL not proceed to subsequent pipeline stages
4. THE Email_Pipeline SHALL consider an email valid for parsing when it contains at minimum a message_id and a from_email field
5. FOR ALL valid email inputs, THE Email_Pipeline SHALL guarantee that parsing then serializing then parsing produces a field-by-field equivalent Email_Event object (round-trip property)

### Requirement 5: Deduplication

**User Story:** As a tenant administrator, I want duplicate emails to be detected and skipped, so that the same email does not create multiple deals in Bitrix24.

#### Acceptance Criteria

1. WHEN an email is received with a non-empty message_id that exactly matches the message_id of another Email_Event for the same imap_account_id created within the last 24 hours, THE Dedup_Engine SHALL mark the Email_Event as DUPLICADO and persist the record without forwarding it to subsequent pipeline stages
2. WHEN an email is received with the same from_email (case-insensitive) and the same subject (case-insensitive, after trimming leading/trailing whitespace) as another Email_Event for the same imap_account_id created within the last 2 minutes, THE Dedup_Engine SHALL mark the Email_Event as DUPLICADO and persist the record without forwarding it to subsequent pipeline stages
3. IF an email has a null or empty message_id, THEN THE Dedup_Engine SHALL skip the message_id deduplication check and apply only the subject+from_email deduplication check
4. WHEN an email passes all deduplication checks without matching any existing Email_Event, THE Dedup_Engine SHALL allow the email to proceed to the Filter_Engine stage

### Requirement 6: Email Filtering

**User Story:** As a tenant administrator, I want to configure ignore rules for sender addresses and subjects, so that unwanted emails do not create deals.

#### Acceptance Criteria

1. WHEN an email's from_email matches any entry in the Tenant's ignore_from list using case-insensitive exact comparison, THE Filter_Engine SHALL mark the Email_Event as IGNORADO
2. WHEN an email's subject contains any entry in the Tenant's ignore_subject list using case-insensitive substring comparison, THE Filter_Engine SHALL mark the Email_Event as IGNORADO
3. WHEN an email passes all filter rules, THE Filter_Engine SHALL allow the email to proceed to the next pipeline stage
4. IF the Tenant's ignore_from and ignore_subject lists are both empty, THEN THE Filter_Engine SHALL allow all emails to proceed without filtering

### Requirement 7: Email Event Persistence Before Bitrix Integration

**User Story:** As a system operator, I want every received email to be saved in the database before any Bitrix24 API call, so that no email is lost even if the integration fails.

#### Acceptance Criteria

1. WHEN an email passes deduplication and filtering, THE Email_Pipeline SHALL save the Email_Event with status RECEBIDO in the database before initiating any Bitrix24 API call
2. WHEN the Email_Event is persisted, THE Email_Pipeline SHALL record the received_at timestamp in the same database operation as the Email_Event creation
3. WHEN the Email_Pipeline begins Bitrix24 integration, THE Email_Pipeline SHALL update the Email_Event status to PROCESSANDO before making the first API call
4. IF the database save of the Email_Event fails, THEN THE Email_Pipeline SHALL not proceed with Bitrix24 integration and SHALL log the error with the imap_account_id and message_id for recovery

### Requirement 8: Bitrix24 Contact Resolution

**User Story:** As a tenant administrator, I want the system to find or create contacts in Bitrix24 from email senders, so that deals are properly linked to contacts.

#### Acceptance Criteria

1. WHEN processing an Email_Event, THE Contact_Resolver SHALL search for an existing Bitrix24 contact by the sender's email address using crm.duplicate.findbycomm
2. IF multiple contacts are found matching the sender's email, THEN THE Contact_Resolver SHALL use the first contact returned by the Bitrix24 API
3. IF no existing contact is found, THEN THE Contact_Resolver SHALL create a new contact in Bitrix24 using the sender's email and name via crm.contact.add
4. IF the sender's from_name is empty or null, THEN THE Contact_Resolver SHALL use the local part of the from_email address as the contact name
5. THE Contact_Resolver SHALL record in bitrix_results whether the contact was found or created (contact_was_created field) and store the resolved contact_id for downstream use

### Requirement 9: Bitrix24 Deal Creation

**User Story:** As a tenant administrator, I want a deal to be created in Bitrix24 for each valid email, so that my sales pipeline is automatically populated.

#### Acceptance Criteria

1. WHEN a contact is resolved, THE Deal_Builder SHALL create a deal in Bitrix24 using crm.deal.add with the Tenant's configured category_id, stage_id, and responsible_id, linked to the resolved contact_id
2. WHEN the deal is successfully created, THE Deal_Builder SHALL store the returned bitrix_deal_id in the bitrix_results record
3. THE Deal_Builder SHALL set the deal title to the email subject, truncated to a maximum of 300 characters
4. IF the email subject is empty or absent, THEN THE Deal_Builder SHALL use the sender's email address as the deal title
5. IF the crm.deal.add call fails, THEN THE Deal_Builder SHALL propagate the error to the Email_Pipeline for retry handling

### Requirement 10: Bitrix24 Activity and Timeline

**User Story:** As a tenant administrator, I want email content to appear as an activity in the Bitrix24 deal, so that the sales team can see the original email.

#### Acceptance Criteria

1. WHEN a deal is created, THE Activity_Writer SHALL create an email activity in Bitrix24 via crm.activity.add linked to the deal, including the email subject as the activity subject and the email body_html as the activity description
2. WHEN the email activity is created successfully, THE Activity_Writer SHALL add a timeline comment to the deal containing the reply-to address
3. IF the email has no reply-to address, THEN THE Activity_Writer SHALL use the from_email address in the timeline comment instead
4. WHEN the email activity is created successfully, THE Activity_Writer SHALL store the returned bitrix_activity_id in the bitrix_results record

### Requirement 11: Attachment Upload

**User Story:** As a tenant administrator, I want email attachments to be uploaded to the Bitrix24 deal timeline, so that the sales team has access to all attached files.

#### Acceptance Criteria

1. WHEN an email has attachments, THE Attachment_Uploader SHALL upload each attachment as a base64-encoded file in a timeline comment via crm.timeline.comment.add
2. WHEN an email has no attachments, THE Attachment_Uploader SHALL skip the upload step without error
3. IF an individual attachment upload fails, THEN THE Attachment_Uploader SHALL log the error and continue uploading the remaining attachments without interrupting the pipeline
4. THE Attachment_Uploader SHALL skip attachments larger than 20MB and log a warning indicating the file was too large

### Requirement 12: Successful Processing Completion

**User Story:** As a system operator, I want successful email processing to be clearly recorded, so that I can verify the system is working correctly.

#### Acceptance Criteria

1. WHEN all Bitrix24 integration steps (contact lookup or creation, deal creation, activity creation, and timeline comment posting) complete successfully, THE Email_Pipeline SHALL update the Email_Event status to SUCESSO
2. WHEN processing completes successfully, THE Email_Pipeline SHALL record the processed_at timestamp in UTC with second precision
3. THE Email_Pipeline SHALL store the Bitrix24 API response log in the bitrix_results.api_log field as JSONB, including for each API call: the operation name, the response payload, and the success/failure indicator
4. IF the Email_Pipeline fails to persist the SUCESSO status or the processed_at timestamp after successful Bitrix24 integration, THEN THE Email_Pipeline SHALL retry the persistence operation up to 3 times before marking the Email_Event status as ERRO with an error message indicating a persistence failure

### Requirement 13: Error Handling and Retry with Exponential Backoff

**User Story:** As a system operator, I want failed Bitrix24 integrations to be retried automatically with increasing delays, so that transient errors are resolved without manual intervention.

#### Acceptance Criteria

1. WHEN a Bitrix24 API call fails during email processing, THE Email_Pipeline SHALL update the Email_Event status to ERRO and record the error_message, error_stack, and failure timestamp in the associated retry_jobs entry
2. WHEN an Email_Event enters ERRO status, THE Email_Pipeline SHALL schedule a retry job with exponential backoff delays of 2, 5, 15, 30, and 60 minutes for attempts 1 through 5 respectively
3. THE Retry_Worker SHALL poll for pending retry jobs every 30 seconds and execute only those jobs whose scheduled retry time is equal to or earlier than the current time
4. WHEN a retry attempt succeeds, THE Retry_Worker SHALL update the Email_Event status to SUCESSO and record the successful response data and completion timestamp in the retry_jobs table
5. WHEN a retry attempt fails and fewer than 5 attempts have been made, THE Retry_Worker SHALL record the error_message and error_stack in the retry_jobs table, increment the attempt counter, and schedule the next retry according to the backoff delay sequence
6. WHEN all 5 retry attempts are exhausted, THE Retry_Worker SHALL update the Email_Event status to FALHA_DEFINITIVA and record the final failure timestamp

### Requirement 14: Bitrix24 HTTP Client Resilience

**User Story:** As a system operator, I want the Bitrix24 HTTP client to handle transient network errors internally, so that brief connectivity issues do not immediately trigger the retry pipeline.

#### Acceptance Criteria

1. WHEN a Bitrix24 API call fails due to a transient error (connection timeout, socket timeout, HTTP 429, or HTTP 5xx response), THE Bitrix_Client SHALL retry the call up to 3 times with a fixed delay of 2 seconds between each attempt before reporting failure
2. THE Bitrix_Client SHALL enforce a 30-second timeout per individual API call attempt, and a timeout SHALL be treated as a transient error eligible for retry
3. IF all 3 internal retries fail, THEN THE Bitrix_Client SHALL propagate an error to the Email_Pipeline that includes the type of failure encountered and the number of attempts made
4. IF a Bitrix24 API call fails due to a non-transient error (HTTP 400, HTTP 401, HTTP 403, or HTTP 404), THEN THE Bitrix_Client SHALL immediately propagate the error to the Email_Pipeline without retrying

### Requirement 15: Alert Service

**User Story:** As a tenant administrator, I want to be alerted when emails are stuck in processing beyond my configured SLA, so that I can take corrective action.

#### Acceptance Criteria

1. THE Alert_Service SHALL check for Email_Events that have been in ERRO or PROCESSANDO status longer than the Tenant's configured sla_minutes at a configurable polling interval with a default of 60 seconds
2. WHEN an Email_Event exceeds the SLA threshold, THE Alert_Service SHALL send a notification to the configured destination including the Email_Event identifier, current status, and elapsed time since the status was set
3. WHERE alert_type is "EMAIL", THE Alert_Service SHALL send the alert via SMTP within 30 seconds of detection
4. WHERE alert_type is "WEBHOOK", THE Alert_Service SHALL send the alert via HTTP POST to the configured URL within 30 seconds of detection
5. WHERE alert_type is "SLACK", THE Alert_Service SHALL send the alert via Slack webhook within 30 seconds of detection
6. WHEN the FALHA_DEFINITIVA status is set, THE Alert_Service SHALL trigger an alert within 60 seconds of the status change regardless of SLA timing
7. IF an Email_Event has already triggered an alert for the same status violation, THEN THE Alert_Service SHALL NOT send a duplicate alert unless the event remains unresolved after an additional interval equal to the Tenant's configured sla_minutes
8. IF the configured alert destination is unreachable, THEN THE Alert_Service SHALL retry delivery up to 3 times with a 30-second interval between attempts and log the delivery failure

### Requirement 16: REST API — Tenant Management

**User Story:** As a system administrator, I want to manage tenants via REST API, so that I can onboard and configure organizations programmatically.

#### Acceptance Criteria

1. WHEN a GET /tenants request is received, THE REST_API SHALL return a list of all active tenants
2. WHEN a POST /tenants request is received with valid tenant data (name, bitrix_url, and bitrix_webhook_token are required), THE REST_API SHALL create a new tenant record and return the created tenant with HTTP 201
3. IF a POST /tenants request is missing required fields, THEN THE REST_API SHALL return an error response indicating which fields are missing
4. WHEN a PATCH /tenants/:id request is received, THE REST_API SHALL update only the specified tenant configuration fields
5. IF a PATCH /tenants/:id request references a non-existent tenant, THEN THE REST_API SHALL return an error response indicating the tenant was not found
6. WHEN a POST /tenants/test-bitrix request is received, THE REST_API SHALL test the Bitrix24 webhook connection within a 10-second timeout and return the result
7. WHEN a POST /tenants/test-imap request is received, THE REST_API SHALL test the IMAP connection within a 15-second timeout and return the result including mailbox message count

### Requirement 17: REST API — Event Logs and Dashboard

**User Story:** As a tenant administrator, I want to view email processing events and daily statistics, so that I can monitor system health and troubleshoot issues.

#### Acceptance Criteria

1. WHEN a GET /tenants/:id/events request is received, THE REST_API SHALL return a paginated list of Email_Events with a default page size of 20 and a maximum page size of 100, supporting filters by status (matching Email_Event status values), date range (start_date and end_date), and text search against the from_email and subject fields
2. WHEN a GET /tenants/:id/dashboard request is received, THE REST_API SHALL return statistics for the last 30 days containing the count of Email_Events grouped by status for each day
3. WHEN a GET /admin/workers request is received, THE REST_API SHALL return the list of all IMAP_Workers including for each: the associated tenant_id, imap_account_id, connection state (connected or disconnected), last_poll_at timestamp, and last_error value
4. IF a GET /tenants/:id/events or GET /tenants/:id/dashboard request references a tenant that does not exist or is not accessible to the authenticated user, THEN THE REST_API SHALL return an error response indicating the tenant was not found
5. IF a GET /tenants/:id/events request contains an invalid status filter value or an invalid date range (start_date after end_date), THEN THE REST_API SHALL return an error response indicating the invalid parameter

### Requirement 18: Authentication and Authorization

**User Story:** As a system administrator, I want API access to be secured with JWT authentication and role-based access, so that only authorized users can manage tenants and view data.

#### Acceptance Criteria

1. THE REST_API SHALL require a valid JWT token (bearing a verified signature, a non-expired expiration claim, and a recognized user identity) for all endpoints except authentication endpoints
2. WHEN a user authenticates with valid credentials, THE REST_API SHALL issue a JWT token with an expiration time between 15 minutes and 24 hours as defined in server configuration
3. THE REST_API SHALL store user passwords hashed with bcrypt using a cost factor of at least 10
4. WHEN a user with role "admin" makes a request, THE REST_API SHALL grant access to all endpoints
5. WHEN a user with role "tenant_user" makes a request, THE REST_API SHALL grant access only to tenants associated with that user via user_tenants
6. IF a request is made without a JWT token or with an invalid or expired token, THEN THE REST_API SHALL reject the request with an authentication error response and SHALL NOT process the requested operation
7. IF a user with role "tenant_user" requests access to a tenant not associated with that user via user_tenants, THEN THE REST_API SHALL reject the request with an authorization error response and SHALL NOT expose any data from the requested tenant
8. IF a user provides invalid credentials during authentication, THEN THE REST_API SHALL reject the authentication attempt with an error response indicating invalid credentials and SHALL NOT issue a token

### Requirement 19: Encryption at Rest

**User Story:** As a security officer, I want IMAP passwords to be encrypted at rest using AES-256-GCM, so that credentials are protected even if the database is compromised.

#### Acceptance Criteria

1. THE Crypto_Module SHALL encrypt each IMAP password using AES-256-GCM with the ENCRYPTION_KEY environment variable, generating a unique 12-byte initialization vector (IV) per encryption operation
2. THE Crypto_Module SHALL store the IV and the GCM authentication tag together with the ciphertext in a single output, such that all three components are retrievable for decryption and integrity verification
3. THE Crypto_Module SHALL decrypt any previously encrypted password back to the original plaintext when provided the same ENCRYPTION_KEY (round-trip property for passwords between 1 and 512 characters)
4. IF the ENCRYPTION_KEY environment variable is missing or is not a valid 256-bit key (32 bytes when decoded), THEN THE Crypto_Module SHALL refuse to start and log an error indicating the key configuration problem
5. IF decryption fails due to an invalid key, corrupted ciphertext, or authentication tag verification failure, THEN THE Crypto_Module SHALL return an error indicating decryption failure without exposing the ciphertext or key material

### Requirement 20: Application Startup and Lifecycle

**User Story:** As a system operator, I want the application to start all necessary services on boot, so that email monitoring begins automatically after deployment.

#### Acceptance Criteria

1. WHEN the application starts, THE Entry_Point SHALL initialize the REST_API server on the configured PORT environment variable within the valid TCP range of 1 to 65535
2. WHEN the application starts, THE Entry_Point SHALL load all active IMAP accounts and start their IMAP_Workers via the Tenant_Scheduler
3. IF an individual IMAP_Worker fails to start during application startup, THEN THE Entry_Point SHALL log the error for that account and continue starting the remaining IMAP_Workers without interrupting the overall startup process
4. WHEN the application starts, THE Entry_Point SHALL start the Retry_Worker background process
5. WHEN the application starts, THE Entry_Point SHALL start the Alert_Service periodic check at a configurable interval defined by the ALERT_CHECK_INTERVAL_SEC environment variable
6. IF the database connection fails at startup, THEN THE Entry_Point SHALL exit with a non-zero code and an error message indicating the database connection failure reason
7. IF the Redis connection fails at startup, THEN THE Entry_Point SHALL exit with a non-zero code and an error message indicating the Redis connection failure reason
8. WHEN all services have been initialized successfully, THE Entry_Point SHALL log a startup-complete message indicating the application is ready to accept requests

### Requirement 21: Docker Deployment

**User Story:** As a DevOps engineer, I want the application to be deployable via Docker Compose, so that the entire stack can be started with a single command.

#### Acceptance Criteria

1. THE Docker_Compose configuration SHALL define services for the application, PostgreSQL 16, and Redis 7
2. THE Docker_Compose configuration SHALL expose the application on the host port specified by the PORT environment variable
3. THE Docker_Compose configuration SHALL persist PostgreSQL data using a named volume
4. THE Docker_Compose configuration SHALL pass all environment variables defined in a `.env.example` file to the application container
5. THE Docker_Compose configuration SHALL define service dependencies so that the application service starts only after PostgreSQL and Redis services are running and healthy
6. WHEN `docker compose up` is executed, THE Docker_Compose configuration SHALL start all services and the application SHALL respond to HTTP requests within 60 seconds
