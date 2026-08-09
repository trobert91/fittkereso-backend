import { Logger } from '@nestjs/common';
import { isEmpty } from 'lodash';

export class CustomLogger extends Logger {
  constructor(context: string) {
    super(context);
  }

  public override log(message: unknown, ...rest: unknown[]): void {
    if (!isEmpty(rest)) {
      super.log(message, this.context, ...rest);
    } else {
      super.log(message);
    }
  }

  public override error(
    message: unknown,
    error?: any,
    ...rest: unknown[]
  ): void {
    if (error || !isEmpty(rest)) {
      super.error(message, {
        context: this.context,
        errorMessage: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
        ...rest,
      });
    } else {
      super.error(message);
    }
  }

  public override warn(message: unknown, ...rest: unknown[]): void {
    if (!isEmpty(rest)) {
      super.warn(message, this.context, ...rest);
    } else {
      super.warn(message);
    }
  }

  public override debug(message: unknown, ...rest: unknown[]): void {
    if (!isEmpty(rest)) {
      super.debug(message, this.context, ...rest);
    } else {
      super.debug(message);
    }
  }

  public override verbose(message: unknown, ...rest: unknown[]): void {
    if (!isEmpty(rest)) {
      super.verbose(message, this.context, ...rest);
    } else {
      super.verbose(message);
    }
  }
}
