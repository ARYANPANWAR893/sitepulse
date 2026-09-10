/**
 * Phone verification is optional while SMS delivery isn't paid for.
 *
 * To turn it on for a demo: set REQUIRE_PHONE_VERIFICATION=true in .env.local
 * (plus a working FAST2SMS_API_KEY or TWILIO_* if you want real texts — without
 * one the code still appears on the verify page in dev). Nothing else changes.
 */
export const phoneRequired = () => process.env.REQUIRE_PHONE_VERIFICATION === "true";

/** True once any SMS provider is configured — used only for UI copy. */
export const smsConfigured = () =>
  Boolean(process.env.FAST2SMS_API_KEY || process.env.TWILIO_ACCOUNT_SID);
