export const FILE_SIZES = {
  MO_1: 1024 * 1024,
  MO_5: 1024 * 1024 * 5,
  MO_10: 1024 * 1024 * 10,
  MO_25: 1024 * 1024 * 25,
  MO_50: 1024 * 1024 * 50,
};

export const FILE_CONFIG = {
  IMAGE: {
    MAX_SIZE: FILE_SIZES.MO_5,
    MIME_TYPE: /(jpg|jpeg|png|webp|gif|bmp)$/i,
    ERROR_MSG: 'Only image files (jpg, png, webp...) are allowed!',
  },
  DOCS: {
    MAX_SIZE: FILE_SIZES.MO_10,
    MIME_TYPE: /(pdf|doc|docx|txt|rtf)$/i,
    ERROR_MSG: 'Only document files (pdf, doc, docx...) are allowed!',
  },
  EXCEL: {
    MAX_SIZE: FILE_SIZES.MO_10,
    MIME_TYPE: /(xls|xlsx|csv)$/i,
    ERROR_MSG: 'Only Excel/CSV files are allowed!',
  },
  AUDIO: {
    MAX_SIZE: FILE_SIZES.MO_25,
    MIME_TYPE: /(mp3|wav|ogg|m4a)$/i,
    ERROR_MSG: 'Only audio files are allowed!',
  },
  VIDEO: {
    MAX_SIZE: FILE_SIZES.MO_50,
    MIME_TYPE: /(mp4|avi|mov|mkv)$/i,
    ERROR_MSG: 'Only video files are allowed!',
  },
  MESSAGE_ATTACHMENT: {
    MAX_SIZE: FILE_SIZES.MO_50,
    MIME_TYPE:
      /(jpg|jpeg|png|webp|gif|bmp|svg|mp4|avi|mov|mkv|webm|mp3|wav|ogg|m4a|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|rtf|zip|rar|7z|tar)$/i,
    ERROR_MSG: 'File type is not supported for chat attachment!',
  },
};
