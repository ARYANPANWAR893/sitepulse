export const googleConfigured = () =>
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export const appUrl = () => process.env.APP_URL ?? "http://localhost:3000";

export const callbackUrl = () => `${appUrl()}/api/auth/google/callback`;
