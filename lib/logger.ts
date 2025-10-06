interface LogContext {
  [key: string]: any;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private context: LogContext = {};

  constructor(private service: string = 'reddit-stock-watcher') {}

  withContext(context: LogContext): Logger {
    const newLogger = new Logger(this.service);
    newLogger.context = { ...this.context, ...context };
    return newLogger;
  }

  private log(level: LogLevel, message: string, data?: LogContext) {
    const timestamp = new Date().toISOString();
    const logData = {
      timestamp,
      level,
      service: this.service,
      message,
      ...this.context,
      ...data,
    };

    console.log(JSON.stringify(logData));
  }

  debug(message: string, data?: LogContext) {
    this.log('debug', message, data);
  }

  info(message: string, data?: LogContext) {
    this.log('info', message, data);
  }

  warn(message: string, data?: LogContext) {
    this.log('warn', message, data);
  }

  error(message: string, data?: LogContext) {
    this.log('error', message, data);
  }
}

export const logger = new Logger();
export type { LogContext };
