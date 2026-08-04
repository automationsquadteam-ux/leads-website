import 'server-only';

export { createServiceClient as createAdminClient, type ServiceClient } from './service-client';

/**
 * Service-role client for application code. BYPASSES ROW LEVEL SECURITY.
 *
 * The `server-only` import above makes the build fail if this module is ever
 * pulled into a client bundle. Only use it for trusted server-side work the
 * sending worker, inbound webhooks, admin-triggered imports and always do
 * your own authorization check (assertAdmin) first, because RLS will not.
 */
