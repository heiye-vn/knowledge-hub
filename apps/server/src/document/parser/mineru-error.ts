import { BadRequestException } from '@nestjs/common';

/** The import worker must treat retryable=false as terminal, especially uncertain submissions. */
export class MineruError extends BadRequestException {
  constructor(
    message: string,
    public readonly code = 'MINERU_INVALID_RESULT',
    public readonly retryable = false,
  ) {
    super(message);
  }
}
