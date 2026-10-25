export const DEFAULT_PORT = 3000;

export const HOST_DEFAULT = 'localhost';

export const PORT_REDIS_DEFAULT = 6379;

export const TTL_OTP_SECONDS = 180; // 3 minutes

export const TTL_RESET_PASSWORD_TOKEN_SECONDS = 300; // 5 minutes after OTP verified

export const MAX_OTP_VERIFY_ATTEMPTS = 5;

export const MAX_LOGIN_FAILED_ATTEMPTS = 5;

export const ACCOUNT_LOCK_DURATION_SECONDS = 900; // 15 minutes

export const SYMBOLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';

export const LENGTH_PASSWORD_DEFAULT = 16;

// Dummy bcrypt hash used to mitigate timing-based user enumeration attacks when user does not exist
export const DUMMY_BCRYPT_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8D0R6V5O2i3E3K1uW9p0yG2L5X3Z2a';
