type Level = 'debug' | 'info' | 'warn' | 'error';

const write = (level: Level, msg: string, meta?: Record<string, unknown>) => {
  if (process.env.NODE_ENV === 'test' && level !== 'error') return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta });
  (level === 'error' ? console.error : console.log)(line);
};

export const logger = {
  debug: (m: string, x?: Record<string, unknown>) => write('debug', m, x),
  info: (m: string, x?: Record<string, unknown>) => write('info', m, x),
  warn: (m: string, x?: Record<string, unknown>) => write('warn', m, x),
  error: (m: string, x?: Record<string, unknown>) => write('error', m, x),
};
