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
      message: 'Email exited',
      code: 2001,
    },
  },
  AUTH: {
    INVALID_CREDENTIALS: {
      message: 'Invalid email or password',
      code: 3000,
    },
    ACCESS_DENIED: {
      message: 'Access Denied. User not found or not logged in.',
      code: 3001,
    },
    NOT_MATCH_TOKEN: {
      message: 'Access Denied. Invalid credentials.',
      code: 3002,
    },
    STATUS_ERROR: {
      message: 'User status is not active.',
      code: 3003,
    },
    CONFLICT: {
      message: 'User account is deleted.',
      code: 3004,
    },
    CREATE_SUCCESS: {
      message: 'User registered successfully',
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
      message: 'Account activation failed',
      code: 3011,
    },
    INVALID_OTP: {
      message: 'Invalid OTP code',
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
      message: 'Password reset OTP sent successfully',
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
};
