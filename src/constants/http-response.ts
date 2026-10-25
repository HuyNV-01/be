export const HTTP_RESPONSE = {
  COMMON: {
    SUCCESS: {
      message: 'Success',
      code: 200,
    },
    CREATED: {
      message: 'Create Success',
      code: 201,
    },
    BAD_REQUEST: {
      message: 'Bad Request',
      code: 400,
    },
    UNAUTHORIZED: {
      message: 'Unauthorized',
      code: 401,
    },
    FORBIDDEN: {
      message: 'Forbidden',
      code: 403,
    },
    NOT_FOUND: {
      message: 'Not Found',
      code: 404,
    },
    TOO_MANY_REQUESTS: {
      message: 'Too many requests. Please try again later.',
      code: 429,
    },
    INTERNAL_SERVER_ERROR: {
      message: 'Internal Server Error',
      code: 500,
    },
    CREATE_SUCCESS: {
      message: 'Created Successfully',
      code: 1000,
    },
    UPDATE_SUCCESS: {
      message: 'Updated Successfully',
      code: 1001,
    },
    DELETE_SUCCESS: {
      message: 'Deleted Successfully',
      code: 1002,
    },
    GET_SUCCESS: {
      message: 'Get Successfully',
      code: 1003,
    },
  },
  USER: {
    NOT_FOUND: {
      message: 'User not found',
      code: 2000,
    },
    EMAIL_EXITED: {
      message: 'Email already exists',
      code: 2001,
    },
  },
  AUTH: {
    INVALID_CREDENTIALS: {
      message: 'Invalid email or password',
      code: 3000,
    },
    ACCESS_DENIED: {
      message: 'Access Denied. User not found or session has expired.',
      code: 3001,
    },
    NOT_MATCH_TOKEN: {
      message: 'Access Denied. Refresh token is invalid or has been revoked.',
      code: 3002,
    },
    STATUS_ERROR: {
      message: 'Account has not been activated yet. Please verify your email.',
      code: 3003,
    },
    CONFLICT: {
      message: 'User account has been deactivated or deleted.',
      code: 3004,
    },
    CREATE_SUCCESS: {
      message: 'User registered successfully. Please check your email to activate your account.',
      code: 3005,
    },
    LOGIN_SUCCESS: {
      message: 'User logged in successfully',
      code: 3006,
    },
    LOGOUT_SUCCESS: {
      message: 'User logged out successfully',
      code: 3007,
    },
    REFRESH_TOKEN_SUCCESS: {
      message: 'Token refreshed successfully',
      code: 3008,
    },
    ALREADY_ACTIVE: {
      message: 'Account is already activated',
      code: 3009,
    },
    ACTIVATE_SUCCESS: {
      message: 'Account activated successfully',
      code: 3010,
    },
    ACTIVATE_FAILED: {
      message: 'Account activation failed or token expired',
      code: 3011,
    },
    INVALID_OTP: {
      message: 'Invalid or expired OTP code',
      code: 3012,
    },
    OTP_VERIFIED: {
      message: 'OTP verified successfully',
      code: 3013,
    },
    PASSWORD_RESET_SUCCESS: {
      message: 'Password reset successfully',
      code: 3014,
    },
    FORGOT_PASSWORD_SUCCESS: {
      message: 'If the email exists in our system, a password reset OTP has been sent.',
      code: 3015,
    },
    UNAUTHORIZED: {
      message: 'Unauthorized access',
      code: 3016,
    },
    GOOGLE_ERROR: {
      message: 'Google authentication failed',
      code: 3017,
    },
    ACCOUNT_LOCKED: {
      message: 'Account is temporarily locked due to multiple failed login attempts.',
      code: 3018,
    },
    OTP_MAX_ATTEMPTS_EXCEEDED: {
      message: 'Maximum OTP verification attempts exceeded. Please request a new OTP.',
      code: 3019,
    },
    RESET_SESSION_EXPIRED: {
      message: 'Password reset session is invalid or has expired. Please verify OTP again.',
      code: 3020,
    },
    RATE_LIMIT_EXCEEDED: {
      message: 'Too many authentication attempts. Please wait before trying again.',
      code: 3021,
    },
    RESEND_ACTIVATION_SUCCESS: {
      message: 'If your account is pending activation, a new activation link has been sent.',
      code: 3022,
    },
  },
  EMAIL: {
    ERROR: {
      message: 'Error sending email',
      code: 4000,
    },
  },
  CONTACT: {
    NOT_FOUND: {
      message: 'Contact not found',
      code: 5000,
    },
    FRIEND_NOT_FOUND: {
      message: 'Friend request not found',
      code: 5001,
    },
    CONFLICT_FRIEND: {
      message: 'Already friend',
      code: 5002,
    },
    CONFLICT_PENDING_SENT: {
      message: 'Request already sent',
      code: 5003,
    },
    CONFLICT_BLOCK: {
      message: 'You blocked this user',
      code: 5004,
    },
    CONFLICT_YOURSELF: {
      message: 'Cannot add yourself',
      code: 5005,
    },
  },

  FILE: {
    NOT_FOUND: {
      message: 'File not found',
      code: 6000,
    },
    UPLOAD_FAILED: {
      message: 'File upload failed',
      code: 6001,
    },
    INVALID_SIGNATURE: {
      message: 'File signature does not match its declared extension or MIME type',
      code: 6002,
    },
    EXPIRED_OR_INVALID_TOKEN: {
      message: 'Signed file URL is invalid or has expired',
      code: 6003,
    },
    OBJECT_NOT_UPLOADED: {
      message: 'Target object has not been uploaded to storage yet',
      code: 6004,
    },
  },
};
